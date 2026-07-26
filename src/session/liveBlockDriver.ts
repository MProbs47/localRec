/**
 * U4 (refactor plan 002) — the pseudo-live block driver (KTD-W2/KTD-W3): the
 * headless core that turns a rolling stream of live-mic PCM into finalized
 * text blocks, using the SAME `WhisperEngine.transcribe()` the import driver
 * (U3, `batchTranscription.ts`'s successor) uses on a whole file. The only
 * difference between live and import lives here, in the driver, not in the
 * engine (`transcriptionEngine.ts`'s header comment).
 *
 * Why "pseudo-live" and not real streaming: Whisper has no cross-window
 * attention (no growing KV-cache across windows) — it can only transcribe
 * whatever buffer you hand it, once, as a finished batch. So instead of a
 * token stream with an "interim vs. final" two-tier UI, this driver
 * accumulates incoming audio into a rolling buffer and periodically
 * transcribes the NOT-YET-COMMITTED tail, emitting each new result as one
 * already-finished block. No interim text, no token callback — just blocks
 * appearing every `windowMs` or so (KD2, "einfache Blöcke").
 *
 * The overlap/dedup problem this solves: each tick transcribes a window that
 * OVERLAPS the previous one (by `overlapMs`) so a word or sentence spoken
 * right at the previous window's cut-off boundary — which Whisper may have
 * truncated or mis-heard with too little trailing context — gets a second,
 * better-contexted chance in the next window. But naively emitting every
 * segment from every window would then emit that boundary content TWICE.
 * `commitSegments` fixes this with TIMESTAMP-based dedup rather than fuzzy
 * text-diffing: Whisper's timestamps are real audio-relative positions, so
 * a segment re-transcribed in two consecutive windows lands at ~the same
 * GLOBAL time in both. Tracking a monotonic `committedUntilMs` boundary and
 * only emitting segments whose midpoint falls at or after it means the
 * overlap region's content is emitted from whichever window transcribes it
 * FIRST (i.e., the earlier window's tail) and silently skipped when the next
 * window re-transcribes the identical timespan — no string comparison, no
 * brittle "does this text roughly match" heuristic.
 *
 * Realitäts-Grenze: everything here is pure logic + injected fakes (timers,
 * `transcribe`, `emitBlock`) — there is no GPU/model/worker access in this
 * environment. U5 (later) instantiates this class for real: `transcribe`
 * bound to a loaded `WhisperEngine.transcribe` with `{ language: 'de', task:
 * 'transcribe' }`, `emitBlock` posting a `final` `TranscriptMessage`, and a
 * real `setInterval`. Real live-feel (RTF, latency-to-first-block, WebGPU
 * backlog behavior) is the U8 manual milestone, not this unit.
 */
import type { TranscribeOptions, TranscriptSegment } from '../worker/model/transcriptionEngine';
import type { FinalSegment } from './recordingCoordinator';

/** 16 kHz mono PCM everywhere (CLAUDE.md) — the fixed sample rate assumed by every ms<->sample conversion below. */
export const DEFAULT_SAMPLE_RATE = 16_000;
/** Minimum accumulated audio (ms) before a tick transcribes — "~10-15 s" per plan U4, picked mid-range. */
export const DEFAULT_WINDOW_MS = 12_000;
/** Lead-in context (ms) kept after committing, so the NEXT window still has enough trailing audio to correctly transcribe words right at the previous cut. */
export const DEFAULT_OVERLAP_MS = 2_000;
/** Scheduler cadence (ms) — how often the driver even CHECKS whether a window's worth of audio has accumulated. Deliberately much shorter than `windowMs` so a tick fires close to the moment enough audio is ready, not up to a whole extra `windowMs` late. */
export const DEFAULT_TICK_INTERVAL_MS = 1_000;

/**
 * Adds `windowStartMs` to every segment's `startMs`/`endMs`, turning
 * Whisper's window-LOCAL timestamps (0-based within the transcribed buffer)
 * into GLOBAL (whole-recording) timestamps. Pure — no side effects, no
 * dependency on driver state.
 */
export function offsetSegments(local: TranscriptSegment[], windowStartMs: number): TranscriptSegment[] {
  return local.map((segment) => ({
    text: segment.text,
    startMs: segment.startMs + windowStartMs,
    endMs: segment.endMs + windowStartMs,
  }));
}

/**
 * The overlap-dedup core (see this file's header comment for the full
 * rationale). Given a window's segments already converted to GLOBAL
 * timestamps, keeps only the segments that represent genuinely NEW content —
 * i.e. whose MIDPOINT (`(startMs + endMs) / 2`) falls at or after
 * `committedUntilMs`. A segment whose midpoint is still before that boundary
 * is content the driver already committed from an earlier window's tail (the
 * overlap region re-transcribed); dropping it by timestamp rather than by
 * comparing text is what makes this dedup robust to Whisper re-wording or
 * re-punctuating the same audio slightly differently on a second pass.
 *
 * After collecting the kept segments (in their original order), advances
 * `committedUntilMs` to the maximum `endMs` among them — the new boundary
 * for the NEXT call. If nothing was kept (e.g. the whole window still falls
 * inside the already-committed region), `committedUntilMs` is returned
 * unchanged; there is nothing new to advance past.
 *
 * Pure — no side effects; caller decides what to do with `blocks` (emit
 * them) and `committedUntilMs` (store it for the next tick).
 */
export function commitSegments(
  globalSegments: TranscriptSegment[],
  committedUntilMs: number,
): { blocks: FinalSegment[]; committedUntilMs: number } {
  const blocks: FinalSegment[] = [];
  let maxEndMs = committedUntilMs;

  for (const segment of globalSegments) {
    const midpointMs = (segment.startMs + segment.endMs) / 2;
    if (midpointMs < committedUntilMs) continue; // already-committed overlap region — a duplicate of earlier output
    blocks.push({ text: segment.text, startMs: segment.startMs, endMs: segment.endMs });
    if (segment.endMs > maxEndMs) maxEndMs = segment.endMs;
  }

  return { blocks, committedUntilMs: blocks.length > 0 ? maxEndMs : committedUntilMs };
}

/**
 * Drops leading samples of `pcm` older than `keepFromMs`, returning the
 * retained tail plus its updated (global) start time. `keepFromMs` is
 * converted to a sample count via `sampleRate`, floored, and clamped to
 * `[0, pcm.length]` so an out-of-range `keepFromMs` (before the buffer's own
 * start, or past its end) can never index out of bounds.
 *
 * If `keepFromMs <= bufferStartMs` there is nothing older than the buffer
 * itself to drop — returns `pcm`/`bufferStartMs` UNCHANGED (no allocation).
 * Otherwise returns `pcm.slice(samplesToDrop)` — a genuine copy with its own
 * backing buffer, not a `subarray()` view: this driver keeps accumulating
 * into `#pendingPcm` by allocating fresh arrays (see `LiveBlockDriver`
 * below), and a shared-buffer view would be fragile against that pattern
 * (unlike `batchTranscription.ts`'s one-way `Comlink.transfer` slices, this
 * buffer is read from repeatedly across many ticks).
 *
 * `bufferStartMs` becomes `keepFromMs` — sub-sample floor rounding (at most
 * one sample, well under a millisecond at 16 kHz) is not worth tracking
 * separately from the requested boundary.
 *
 * Pure — no side effects.
 */
export function pruneBuffer(
  pcm: Float32Array,
  bufferStartMs: number,
  keepFromMs: number,
  sampleRate: number,
): { pcm: Float32Array; bufferStartMs: number } {
  if (keepFromMs <= bufferStartMs) {
    return { pcm, bufferStartMs };
  }

  const deltaMs = keepFromMs - bufferStartMs;
  const samplesToDrop = Math.min(pcm.length, Math.max(0, Math.floor((deltaMs / 1000) * sampleRate)));

  return { pcm: pcm.slice(samplesToDrop), bufferStartMs: keepFromMs };
}

export interface LiveBlockDriverDeps {
  /** Production: a loaded `WhisperEngine.transcribe` bound with `{ language: 'de', task: 'transcribe' }` (KTD-W3 — same call the import driver uses, just on a smaller window). */
  transcribe: (pcm: Float32Array, opts?: TranscribeOptions) => Promise<TranscriptSegment[]>;
  /** Production: posts a `final` `TranscriptMessage` from the worker. Called once per newly-committed block, in order. */
  emitBlock: (block: FinalSegment) => void;
  /** 16 kHz mono (CLAUDE.md) unless a test needs otherwise. */
  sampleRate?: number;
  /** See `DEFAULT_WINDOW_MS`. */
  windowMs?: number;
  /** See `DEFAULT_OVERLAP_MS`. */
  overlapMs?: number;
  /** See `DEFAULT_TICK_INTERVAL_MS`. */
  tickIntervalMs?: number;
  /** Injectable timer (tests) — same `setIntervalImpl`/`clearIntervalImpl` pattern as `recordingCoordinator.ts`. Defaults to the real (worker-global, no `window.` — this class runs inside the transcription worker per U5) `setInterval`. */
  setIntervalImpl?: (fn: () => void, ms: number) => number;
  clearIntervalImpl?: (id: number) => void;
  /**
   * Hard cap on retained PCM, in ms (#2). When `#pendingPcm` exceeds it,
   * the oldest samples are dropped (a recorded gap) so the buffer stays bounded
   * under sustained RTF > 1 or long silence — the two cases where NOTHING
   * commits, so the ordinary overlap-prune never advances and the buffer would
   * otherwise grow without bound (runaway latency + memory). Defaults to
   * `windowMs * 3`: generous enough that normal RTF < 1 operation (peak ≈ one
   * window + a transcribe's worth of incoming audio) never drops a sample,
   * small enough to bound the death spiral.
   */
  maxBufferMs?: number;
  /**
   * Error hook (#3): called with the error when a `transcribe()` cycle throws, instead
   * of letting the rejection escape as an unhandled worker error that silently
   * kills the rest of the session. The driver skips that cycle and keeps
   * ticking; the next tick retries with a fresh transcribe.
   */
  onError?: (error: unknown) => void;
}

/**
 * Rolling-window live driver (KTD-W2). Accumulates mic PCM via `pushAudio`,
 * ticks on a timer, and once enough NEW audio has piled up, transcribes the
 * pending buffer, dedups its overlap against the previous commit boundary,
 * emits any newly-committed blocks, and prunes the buffer down to the
 * overlap lead-in. See this file's header comment for the overlap/dedup
 * rationale and `#tick`'s doc comment for the no-audio-loss guarantee under
 * backpressure.
 */
export class LiveBlockDriver {
  readonly #deps: LiveBlockDriverDeps;
  readonly #sampleRate: number;
  readonly #windowMs: number;
  readonly #overlapMs: number;
  readonly #tickIntervalMs: number;
  readonly #maxBufferMs: number;
  readonly #setInterval: (fn: () => void, ms: number) => number;
  readonly #clearInterval: (id: number) => void;

  /** Growing (grow-and-copy — simple and clear, per plan; the buffer is bounded by `overlapMs` + at most one window's worth of audio) accumulator of not-yet-fully-committed PCM. */
  #pendingPcm: Float32Array = new Float32Array(0);
  /** Global ms timestamp of `#pendingPcm[0]`. */
  #pendingStartMs = 0;
  /** Monotonic boundary: content at/after this global ms has already been emitted as a block. */
  #committedUntilMs = 0;
  /** True for the duration of one `transcribe()` call + its bookkeeping — the natural-backpressure gate (`#tick` below). */
  #transcribing = false;
  /** The currently in-flight tick's work, if any — `stop()` awaits this before running its own final flush tick. */
  #inFlightTick: Promise<void> | null = null;
  #intervalId: number | null = null;
  /** True before the first `start()` and after `stop()` resolves — `pushAudio` no-ops while true. */
  #stopped = true;

  constructor(deps: LiveBlockDriverDeps) {
    this.#deps = deps;
    this.#sampleRate = deps.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.#windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
    this.#overlapMs = deps.overlapMs ?? DEFAULT_OVERLAP_MS;
    this.#tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.#maxBufferMs = deps.maxBufferMs ?? this.#windowMs * 3;
    // `self.*`, not `window.*` (unlike `recordingCoordinator.ts`, which runs
    // on the main thread) — this driver runs inside the transcription worker
    // (U5), and `self` resolves to the same DOM-lib `number`-returning
    // `setInterval`/`clearInterval` overload in both a worker and a window
    // (unlike the bare global `setInterval`, whose return type flips to
    // `NodeJS.Timeout` as soon as `@types/node` is on the program — exactly
    // what `tsconfig.test.json`'s `"types": ["node"]` pulls in for this
    // very test file).
    this.#setInterval = deps.setIntervalImpl ?? ((fn, ms) => self.setInterval(fn, ms));
    this.#clearInterval = deps.clearIntervalImpl ?? ((id) => self.clearInterval(id));
  }

  /** Resets all state (a fresh recording) and starts the tick scheduler. */
  start(): void {
    this.#pendingPcm = new Float32Array(0);
    this.#pendingStartMs = 0;
    this.#committedUntilMs = 0;
    this.#transcribing = false;
    this.#inFlightTick = null;
    this.#stopped = false;
    // Not wrapped in `void`: returning `#tick()`'s promise from this callback
    // is harmless for a real `setInterval` (the return value is ignored) and
    // lets a test's fake `setIntervalImpl` capture + `await` the SAME
    // callback deterministically instead of racing its microtasks.
    this.#intervalId = this.#setInterval(() => this.#tick(), this.#tickIntervalMs);
  }

  /** Appends one chunk of incoming mic PCM to the pending buffer. No-op for an empty chunk or once stopped. */
  pushAudio(chunk: Float32Array): void {
    if (this.#stopped || chunk.length === 0) return;
    const merged = new Float32Array(this.#pendingPcm.length + chunk.length);
    merged.set(this.#pendingPcm, 0);
    merged.set(chunk, this.#pendingPcm.length);
    this.#pendingPcm = merged;
    // #2: bound the buffer here, at the growth point — under RTF > 1 pushAudio
    // keeps appending while a tick's transcribe is in flight (pile-skip), and
    // nothing commits to prune. Reassigning `#pendingPcm` never mutates the
    // in-flight tick's `window` snapshot, so this is safe mid-transcribe.
    this.#capPendingBuffer();
  }

  /**
   * #2: drops the oldest pending samples so the buffer never exceeds
   * `#maxBufferMs`. A no-op below the cap (normal RTF < 1 operation). Above it
   * — sustained overload or long silence, where nothing commits and the
   * overlap-prune never advances — it keeps only the most recent
   * `#maxBufferMs` of audio (a recorded gap, the honest tradeoff: under RTF > 1
   * the engine simply cannot keep up, and a bounded gap beats unbounded memory
   * + ever-growing latency). Reuses `pruneBuffer`, and advances the committed
   * boundary past any dropped region so the monotonic dedup invariant holds.
   */
  #capPendingBuffer(): void {
    const pendingMs = (this.#pendingPcm.length / this.#sampleRate) * 1000;
    if (pendingMs <= this.#maxBufferMs) return;
    const keepFromMs = this.#pendingStartMs + pendingMs - this.#maxBufferMs;
    const capped = pruneBuffer(this.#pendingPcm, this.#pendingStartMs, keepFromMs, this.#sampleRate);
    this.#pendingPcm = capped.pcm;
    this.#pendingStartMs = capped.bufferStartMs;
    if (this.#committedUntilMs < this.#pendingStartMs) this.#committedUntilMs = this.#pendingStartMs;
  }

  /**
   * Stops the tick scheduler, waits for any in-flight tick to finish, then
   * runs one FINAL flush tick (ignoring the `windowMs` minimum) so trailing
   * audio shorter than a full window still becomes a block instead of being
   * silently discarded. Idempotent.
   */
  async stop(): Promise<void> {
    if (this.#stopped) return;

    if (this.#intervalId !== null) {
      this.#clearInterval(this.#intervalId);
      this.#intervalId = null;
    }
    if (this.#inFlightTick) {
      await this.#inFlightTick;
    }
    await this.#tick(true);

    this.#stopped = true;
  }

  /**
   * One scheduler tick. `final=true` (only from `stop()`) skips the
   * `windowMs` minimum so a short trailing recording still flushes.
   *
   * Natural backpressure: if a transcribe is already in flight, this tick
   * returns immediately rather than queuing or overlapping — under RTF > 1
   * (the engine is slower than real time), ticks simply pile-skip while
   * `#pendingPcm` keeps growing via `pushAudio`. Audio is never dropped: it
   * just accumulates until the NEXT tick that finds `#transcribing` false.
   *
   * No-audio-loss guarantee across the `await transcribe(...)` gap: this is
   * the one subtle correctness point in the whole driver. `window` below is
   * a SNAPSHOT reference to `#pendingPcm` taken before the `await` — used
   * only to call `transcribe`/`offsetSegments` on a stable buffer. Any
   * `pushAudio` calls that land DURING that `await` reassign `#pendingPcm`
   * to a brand-new, larger array (grow-and-copy) — they never mutate the
   * `window` array `transcribe` is busy processing, and they are never lost
   * because pruning below reads the CURRENT `this.#pendingPcm` (post any
   * appends), not the stale `window` snapshot. Pruning only ever drops
   * samples strictly BEFORE the new commit boundary, so anything appended
   * during the transcribe — which is necessarily newer than that boundary —
   * survives into the next tick's window untouched.
   */
  async #tick(final = false): Promise<void> {
    if (this.#transcribing) return;

    const pendingMs = (this.#pendingPcm.length / this.#sampleRate) * 1000;
    if (!final && pendingMs < this.#windowMs) return;
    if (this.#pendingPcm.length === 0) return;

    this.#transcribing = true;
    const cycle = this.#runCycle();
    this.#inFlightTick = cycle;
    try {
      await cycle;
    } finally {
      this.#transcribing = false;
      this.#inFlightTick = null;
    }
  }

  /** The actual transcribe -> offset -> commit -> emit -> prune sequence for one tick. Split out of `#tick` purely so the backpressure/flag bookkeeping above stays easy to read. */
  async #runCycle(): Promise<void> {
    const window = this.#pendingPcm; // snapshot for transcribe/offset only — see `#tick`'s doc comment
    const windowStartMs = this.#pendingStartMs;

    let local: TranscriptSegment[];
    try {
      local = await this.#deps.transcribe(window);
    } catch (error) {
      // #3: a transcribe failure must not escape as an unhandled worker
      // rejection that silently ends the session. Surface it and skip this
      // cycle — no commit, no prune (the buffer stays bounded via the cap in
      // `pushAudio`); the next tick retries with a fresh transcribe.
      this.#deps.onError?.(error);
      return;
    }
    const global = offsetSegments(local, windowStartMs);
    const { blocks, committedUntilMs } = commitSegments(global, this.#committedUntilMs);
    this.#committedUntilMs = committedUntilMs;
    for (const block of blocks) this.#deps.emitBlock(block);

    // Prune against the CURRENT buffer (post any appends during the await
    // above), never against `window` — see `#tick`'s doc comment.
    const keepFromMs = Math.max(0, this.#committedUntilMs - this.#overlapMs);
    const pruned = pruneBuffer(this.#pendingPcm, this.#pendingStartMs, keepFromMs, this.#sampleRate);
    this.#pendingPcm = pruned.pcm;
    this.#pendingStartMs = pruned.bufferStartMs;
  }
}
