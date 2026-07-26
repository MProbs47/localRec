/**
 * U12a — the recording-session coordinator: the one place that ties the
 * isolated U6–U10 subsystems into the record→stop lifecycle the one-button UI
 * drives (plan §5, "Die große Integration"). `App.tsx` owns the mic/worker
 * graph and the visual state machine; this module owns everything that must
 * happen *around* a recording so `App` stays thin and this orchestration stays
 * unit-testable:
 *
 *  - **Output (U9/U10):** opens a `FileSink` (live-mirror to the chosen folder,
 *    or the OPFS fallback) and writes the `.txt`/`.srt` transcript per
 *    finalized segment plus the `.webm` audio per recorder chunk. The chosen
 *    folder's live-mirrored files (or, without File System Access, the OPFS
 *    fallback) are "die Wahrheit" (CLAUDE.md); the stores below are cache.
 *  - **Persistence (U6):** mirrors every finalized segment into `SessionStore`
 *    (IndexedDB) and manages the session lifecycle — `createSession` on start,
 *    a periodic `heartbeat`, `closeSession` on a clean stop. A session left
 *    `active` (no clean stop) is exactly what `recovery.ts` surfaces as a crash
 *    candidate on the next app start.
 *  - **Endurance (U7):** holds a screen Wake Lock for the duration.
 *
 * Deliberately NOT here: a separate `opfsAudio` channel for the audio. The
 * `.webm` written through the sink already IS the crash-safe backstop (OPFS in
 * fallback mode, the mirrored file on disk otherwise), so routing recorder
 * chunks a second time into `opfsAudio` would duplicate the audio — the U9
 * review's "U6-Audio vs U9-Fallback-Audio dedupen" concern, resolved here by
 * simply not creating the duplicate (CLAUDE.md: "bei Zweifel die kleinere
 * Lösung"). The transcript is mirrored to both the files (export truth) and
 * `SessionStore` (crash recovery) on purpose — those serve different jobs.
 *
 * Realitäts-Grenze: `createSink` (`showDirectoryPicker`), `startRecorder`
 * (`MediaRecorder`) and the real OPFS behind the sink cannot run under
 * Vitest — they are injected, so the ordering/lifecycle logic here is tested
 * with fakes while the hardware edges stay a manual milestone.
 */
import type { FileSink } from '../output/fileSink';
import { TxtWriter } from '../output/txtWriter';
import { SrtWriter } from '../output/srtWriter';
import { AudioWriter } from '../output/audioWriter';
import type { SessionStore } from '../storage/sessionStore';
import type { WakeLockController } from '../runtime/wakeLock';

/** One finalized transcript segment (the worker's `final` message) — matches `SegmentRecord` minus the store-owned `sessionId`/`seq`. */
export interface FinalSegment {
  text: string;
  startMs: number;
  endMs: number;
}

/** A running MediaRecorder capture the coordinator can stop. Wraps `startOpusRecorder`; `null` when no recorder could start (unsupported / no stream). */
export interface RecorderHandle {
  stop(): void;
}

/** Starts the parallel audio capture, routing each chunk to `onChunk`. Returns `null` if recording audio isn't possible (the transcript path still runs). */
export type RecorderStarter = (onChunk: (blob: Blob) => void) => RecorderHandle | null;

export interface RecordingCoordinatorDeps {
  /** Opens the output sink — a fresh `createFileSink()` (folder picker) or a restored one (R6). Called inside `start()` so a picker stays within the user gesture. */
  createSink: () => Promise<FileSink>;
  /** IndexedDB session store (U6) for crash-recoverable segment persistence. */
  sessionStore: SessionStore;
  /** Screen Wake Lock (U7), or `null` where the platform has none. */
  wakeLock?: WakeLockController | null;
  /** Wall clock (ms) for session/segment timestamps — injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Unique session id generator — injectable for tests. Defaults to `crypto.randomUUID()`. */
  newSessionId?: () => string;
  /** Base name for the output files (`<base>.txt` etc.). Defaults to `transkript`. */
  baseName?: string;
  /** Heartbeat cadence (ms). Defaults to `DEFAULT_HEARTBEAT_INTERVAL_MS`. */
  heartbeatIntervalMs?: number;
  /** Injectable timers (tests). Default to `window.setInterval`/`clearInterval`. */
  setIntervalImpl?: (handler: () => void, ms: number) => number;
  clearIntervalImpl?: (id: number) => void;
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_BASE_NAME = 'transkript';

/**
 * The Recording Session's explicit lifecycle (see CONTEXT.md / ADR-0001). The
 * coordinator IS the aggregate; this phase is its single source of truth,
 * replacing the old `#active` boolean whose check-then-set gap in `start()`
 * was the double-start TOCTOU race. `start()` is only legal from `idle`/
 * `stopped`, `stop()` only from `active`, and the guard flips SYNCHRONOUSLY
 * before the first `await` so a re-entrant call can't slip through the gap. A
 * failed start rolls back to `idle` (a reusable coordinator needs no distinct
 * `failed` state — `idle` already means "ready to start").
 */
export type RecordingPhase = 'idle' | 'starting' | 'active' | 'stopping' | 'stopped';

export class RecordingCoordinator {
  readonly #deps: RecordingCoordinatorDeps;
  readonly #now: () => number;
  readonly #newSessionId: () => string;
  readonly #base: string;
  readonly #heartbeatMs: number;
  readonly #setInterval: (handler: () => void, ms: number) => number;
  readonly #clearInterval: (id: number) => void;

  #txt: TxtWriter | null = null;
  #srt: SrtWriter | null = null;
  #audio: AudioWriter | null = null;
  #recorder: RecorderHandle | null = null;
  #sessionId: string | null = null;
  #outputName: string | null = null;
  /**
   * The output sink opened in `start()`, retained past `stop()` so the
   * post-hoc annotate stage (Phase D, U18/U21) can write the speaker-labeled
   * `-sprecher.txt`/`.srt` export files to the SAME chosen folder without
   * re-prompting a picker. Only `close()`d writers are torn down on stop; the
   * sink (a directory handle) stays usable. Overwritten on the next `start()`.
   */
  #sink: FileSink | null = null;
  #seq = 0;
  #heartbeatId: number | null = null;
  #phase: RecordingPhase = 'idle';
  /**
   * Serializes segment writes so a burst of `final`s can't interleave the
   * txt/srt appends, and — critically — gives `stop()` something to await so
   * the LAST segment (the one the worker emits *during* its own `stop()`,
   * often the whole short-recording transcript) is fully written to the files
   * BEFORE the writers are closed. Without this drain the trailing `final`
   * loses a race against `stop()` closing the txt/srt writers and the export
   * files come out empty even though the audio (`.webm`, a separate path) and
   * the on-screen transcript are fine.
   */
  #writeChain: Promise<void> = Promise.resolve();

  constructor(deps: RecordingCoordinatorDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#newSessionId = deps.newSessionId ?? (() => crypto.randomUUID());
    this.#base = deps.baseName ?? DEFAULT_BASE_NAME;
    this.#heartbeatMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#setInterval = deps.setIntervalImpl ?? ((h, ms) => window.setInterval(h, ms));
    this.#clearInterval = deps.clearIntervalImpl ?? ((id) => window.clearInterval(id));
  }

  /** True only while a recording is live (`phase === 'active'`). Retained for callers that just need the boolean; `phase` exposes the full lifecycle. */
  get active(): boolean {
    return this.#phase === 'active';
  }

  /** The Recording Session's current lifecycle phase (ADR-0001). App state projects from this instead of tracking its own booleans. */
  get phase(): RecordingPhase {
    return this.#phase;
  }

  /** The id of the session currently being recorded, or `null` between recordings. */
  get sessionId(): string | null {
    return this.#sessionId;
  }

  /** The chosen output folder's name (File System Access exposes only the name, never a full path), or `null` for the fallback sink / before the first recording. For the "gespeichert in …" message (U12). */
  get outputName(): string | null {
    return this.#outputName;
  }

  /**
   * The output sink from the most recent `start()`, still open after `stop()`
   * — the post-hoc annotate stage (U18/U21) writes the speaker-labeled export
   * files to it (same folder, no re-prompt). `null` before the first recording.
   */
  get sink(): FileSink | null {
    return this.#sink;
  }

  /**
   * Opens output + persistence + wake lock for a new recording and starts the
   * audio recorder. The sink is opened first so a `showDirectoryPicker()`
   * inside `createSink` still sees the caller's user gesture. Rejects (leaving
   * nothing half-open) if the sink can't be opened — e.g. the user cancels the
   * picker; the caller aborts the recording in that case.
   *
   * **U20b addendum: the recorder is started BEFORE the `.webm` file is
   * opened.** Only when `startRecorder` actually returns a handle (audio
   * capture is possible) does a `.webm` `AudioWriter` get created at all — a
   * transcript-only recording (no `MediaRecorder`, or U20's imported-file
   * path via `runImport`'s `() => null`) no longer leaves behind a spurious,
   * permanently-empty `transkript.webm` next to the real `.txt`/`.srt`
   * output. Identical behavior to before whenever a recorder DOES start (the
   * `.webm` file still opens, still receives every chunk) — this is purely
   * additive for the no-recorder case.
   */
  async start(startRecorder: RecorderStarter): Promise<void> {
    // Aggregate guard: a new recording is only legal from a settled phase, and
    // the transition to `starting` is SYNCHRONOUS — before the first `await`
    // below — so a re-entrant `start()` (double-click / Space double-tap) that
    // lands in the createSink/openFile gap is rejected here instead of opening
    // a second session (finding #1, the old `#active` check-then-set TOCTOU).
    if (this.#phase !== 'idle' && this.#phase !== 'stopped') return;
    this.#phase = 'starting';

    try {
      // Output first (may prompt the folder picker — must stay in the gesture).
      const sink = await this.#deps.createSink();
      this.#sink = sink;
      this.#outputName = sink.name ?? null;
      const [txtFile, srtFile] = await Promise.all([
        sink.openFile(`${this.#base}.txt`),
        sink.openFile(`${this.#base}.srt`),
      ]);
      this.#txt = new TxtWriter(txtFile);
      this.#srt = new SrtWriter(srtFile);

      // Audio capture → the .webm writer. Best-effort: a platform without
      // MediaRecorder still records the transcript (startRecorder returns
      // null) — and so does U20's imported-file path, which passes `() =>
      // null` on purpose (there is no live mic to capture). Only open the
      // `.webm` file once there is actually a recorder writing to it.
      this.#recorder = startRecorder((blob) => {
        void this.#audio?.writeChunk(blob);
      });
      if (this.#recorder) {
        const webmFile = await sink.openFile(`${this.#base}.webm`);
        this.#audio = new AudioWriter(webmFile);
      }

      // Persistence: open the crash-recoverable session.
      const sessionId = this.#newSessionId();
      this.#sessionId = sessionId;
      this.#seq = 0;
      await this.#deps.sessionStore.createSession(sessionId, this.#now());

      // The Wake Lock is optional durability, never a hard failure: a rejection
      // (unsupported, permission, transient) must not abort an otherwise-good
      // recording (finding #8). Swallow it and record anyway.
      try {
        await this.#deps.wakeLock?.start();
      } catch {
        // best-effort; the recording proceeds without the screen lock
      }

      this.#heartbeatId = this.#setInterval(() => {
        void this.#deps.sessionStore.heartbeat(sessionId, this.#now());
      }, this.#heartbeatMs);

      this.#phase = 'active';
    } catch (err) {
      // Roll back to a startable phase so the user can retry (e.g. re-pick the
      // folder). Matches the prior "rejects, leaving nothing half-open" contract.
      this.#phase = 'idle';
      throw err;
    }
  }

  /**
   * Records one finalized segment: assigns the monotone `seq`, mirrors it into
   * `SessionStore` (crash recovery) and appends it to the `.txt`/`.srt` files
   * (export truth). No-op before `start()`/after `stop()` — a late `final`
   * message arriving just after stop is dropped, matching the worker's own
   * late-`feedAudio` handling.
   */
  handleFinal(segment: FinalSegment): Promise<void> {
    if (this.#phase !== 'active' || !this.#sessionId) return Promise.resolve();
    // Queue behind any earlier segment write; keep `#writeChain` non-rejecting
    // (so a single failed write can't break the drain) but hand this call its
    // own promise so a direct `await handleFinal(...)` still sees this write's
    // result (the unit tests rely on that).
    const done = this.#writeChain.then(() => this.#writeSegment(segment));
    this.#writeChain = done.catch(() => {});
    return done;
  }

  async #writeSegment(segment: FinalSegment): Promise<void> {
    // Re-check inside the queued turn: `stop()` may have run between enqueue
    // and execution (it drains the chain first, so this stays true only for
    // writes that were enqueued before the stop).
    if (!this.#sessionId) return;
    const seq = ++this.#seq;
    await this.#deps.sessionStore.appendSegment(
      { sessionId: this.#sessionId, seq, text: segment.text, startMs: segment.startMs, endMs: segment.endMs },
      this.#now(),
    );
    await this.#txt?.writeSegment({ text: segment.text });
    await this.#srt?.writeSegment({ text: segment.text, startMs: segment.startMs, endMs: segment.endMs });
  }

  /**
   * Cleanly ends the recording: stops the heartbeat + recorder, flushes and
   * closes the writers/sink, closes the `SessionStore` session (so it is NOT a
   * crash candidate next start) and releases the wake lock. Idempotent —
   * a second call is a no-op.
   *
   * Ordering note (hardware milestone): `recorder.stop()` flushes MediaRecorder's
   * final chunk asynchronously (`dataavailable` after `stop()`), so on a real
   * browser the very last audio chunk can land after the `.webm` writer has
   * closed. The transcript (`.txt`/`.srt`/`SessionStore`) is unaffected; tuning
   * the audio tail is a manual milestone.
   */
  async stop(): Promise<void> {
    // Only an active recording can be stopped; a `stop()` during `starting`/
    // `stopping`/`stopped`/`idle` is a no-op. Flip to `stopping` synchronously
    // so a racing restart is rejected by `start()`'s guard until we settle
    // (finding #4) — and so a second `stop()` stays idempotent.
    if (this.#phase !== 'active') return;
    this.#phase = 'stopping';

    if (this.#heartbeatId !== null) {
      this.#clearInterval(this.#heartbeatId);
      this.#heartbeatId = null;
    }
    this.#recorder?.stop();
    this.#recorder = null;

    // Drain every still-pending segment write BEFORE closing the writers, so
    // the worker's trailing `final` (emitted during its own stop, and enqueued
    // by the caller before this runs) reaches the txt/srt files. `#active` is
    // already false above, so nothing new can enqueue past this point.
    await this.#writeChain;

    await this.#audio?.close();
    await this.#txt?.close();
    await this.#srt?.close();
    this.#audio = this.#txt = this.#srt = null;

    const sessionId = this.#sessionId;
    this.#sessionId = null;
    if (sessionId) {
      // Flush any still-batched trailing segment durably BEFORE closing, so a
      // clean stop never loses the tail (the worker's U6 Andockpunkt pairing:
      // flush() then closeSession()).
      try {
        await this.#deps.sessionStore.flush(this.#now());
        await this.#deps.sessionStore.closeSession(sessionId, this.#now());
      } catch (error) {
        // Durable persistence failed (#5): the store re-queued the unflushed
        // tail, so it is not lost. Deliberately do NOT closeSession — leaving it
        // `active` makes it a crash candidate `recovery.ts` will surface next
        // launch, which is correct when we couldn't persist the tail. Surface
        // it; the wake lock is still released and the phase still settles below.
        // eslint-disable-next-line no-console
        console.error('[recording] durable flush/close failed on stop — session left recoverable:', error);
      }
    }

    await this.#deps.wakeLock?.stop();

    // Settled: `stopped` allows a fresh `start()` (the coordinator is reused
    // across recordings) while remaining distinct from `idle` for UI projection.
    this.#phase = 'stopped';
  }
}
