/**
 * Worker entry point (Whisper refactor plan 002, U5). Holds the loaded
 * `WhisperEngine`, exposes a lean control surface (`initialize`/`start`/
 * `feedAudio`/`stop`/`transcribeFile`) over Comlink, and posts finalized
 * transcript blocks straight out via raw `postMessage` — no interim tier,
 * no sub-session/segmentation machinery (KTD-W2, KTD-W3).
 *
 * Two separate transport mechanisms, deliberately (same reasoning as the
 * pre-Whisper worker):
 *  - **Control channel (Comlink):** `initialize()`/`start()`/`feedAudio()`/
 *    `stop()`/`transcribeFile()` are exposed as an RPC object (`WorkerApi`).
 *    These are low-frequency (model load once, start/stop per session,
 *    `feedAudio` at most a few times a second from the ring buffer, one
 *    `transcribeFile` call per import) — Comlink's per-call proxy overhead
 *    is a non-issue at that rate, and it buys a plain async/await call
 *    surface on the main-thread side instead of hand-rolled message
 *    correlation.
 *  - **Block stream (raw `postMessage`):** `final` `TranscriptMessage`s
 *    (defined below) never go through Comlink. Comlink and this raw
 *    channel safely coexist on the same worker endpoint: Comlink's own
 *    message listener only reacts to messages carrying its own `id`/`type`
 *    envelope (verified against the installed `comlink` 4.4.2 source,
 *    `expose()`/`wrap()`) and silently ignores anything else, so a
 *    `TranscriptMessage` posted directly via `self.postMessage` never gets
 *    intercepted or misparsed by Comlink, and vice versa.
 *
 * No `interim` tier (KTD-W2): Whisper has no cross-window attention, so
 * there is no growing "currently being generated" text to stream token by
 * token the way a streaming model would — `LiveBlockDriver` (`../session/
 * liveBlockDriver.ts`) periodically transcribes a rolling window and emits
 * each dedup'd result as one already-finished `final` block. Hence
 * `TranscriptMessage` has a single `final` shape (the earlier interim
 * tier and its `transcriptChannel.ts` throttling bridge were removed in U6).
 *
 * Type note (unchanged from the pre-Whisper worker): this file needs
 * `postMessage`/`self` typed for a `DedicatedWorkerGlobalScope`, but the
 * rest of `src/**` type-checks against the "DOM" lib (for React/UI code),
 * and TypeScript's "DOM" and "WebWorker" libs declare conflicting globals
 * (e.g. `self`) — they cannot both be in one `lib` array. `WorkerScope`
 * below is a narrow local view covering exactly the raw-postMessage API
 * this file uses on `self`, cast once where needed. `Comlink.expose()` gets
 * its own separate, equally narrow cast to `Comlink.Endpoint` for the same
 * reason — keeping the two casts apart (rather than one interface trying to
 * satisfy both) avoids `WorkerScope`'s `postMessage` (correctly narrowed to
 * `TranscriptMessage`) fighting with `Endpoint`'s `postMessage` (`any`,
 * since Comlink's own wire-protocol messages aren't `TranscriptMessage`-shaped).
 */
import * as Comlink from 'comlink';
import { env } from '@huggingface/transformers';
import { WhisperEngine } from './model/whisperEngine';
import type { LoadProgressCallback, TranscriptionEngine, TranscriptSegment } from './model/transcriptionEngine';
import { LiveBlockDriver } from '../session/liveBlockDriver';
import { pinOrtWasmToLocalAssets } from './model/ortWasmPaths';

// S1 privacy fix: transformers.js' onnx.js backend defaults `wasmPaths` to a
// cdn.jsdelivr.net URL at import time (see `ortWasmPaths.ts`'s header). Pin it
// to the local Vite-bundled asset before the engine below ever creates an ORT
// session — `wasmPaths` is read lazily, so this wins regardless of import
// ordering relative to transformers.js' own module-level default assignment.
// `env.backends.onnx` is typed as `Partial<Env>` (so `.wasm` types as possibly
// `undefined`), but the real singleton always populates it — the `!` reflects
// that typing artifact, not a runtime possibility.
pinOrtWasmToLocalAssets(env.backends.onnx.wasm!);

/**
 * The one message shape this worker posts to the main thread: a finalized
 * transcript block with its global `[startMs, endMs)` range. There is no
 * `interim` variant (KTD-W2 — see the header note); every block the live
 * driver or file import produces is already final.
 */
export type TranscriptMessage = { type: 'final'; text: string; startMs: number; endMs: number };

interface WorkerScope {
  postMessage(message: TranscriptMessage): void;
}

const workerScope = self as unknown as WorkerScope;

export interface WorkerApi {
  /** Loads the model and runs warm-up. Rejects if either step fails. */
  initialize(onProgress: LoadProgressCallback): Promise<void>;
  /** Begins a new live pseudo-live block session (`LiveBlockDriver`). No-op if one is already running. `language` is a Whisper code (see `TranscribeOptions.language` for the legacy `'auto'` caveat); omitted → the engine's default. */
  start(language?: string): void;
  /**
   * Pushes one windowed chunk of 16 kHz mono PCM audio (from the main
   * thread's ring-buffer read loop, see `App.tsx`) into the active live
   * driver. Silently dropped if no session is running (e.g. a late chunk
   * arriving just after `stop()`).
   */
  feedAudio(chunk: Float32Array): void;
  /**
   * Ends the current live session: stops the driver's tick scheduler and
   * runs its final flush (see the ordering note on `stop` in the `api`
   * object below). No-op if none is running.
   */
  stop(): Promise<void>;
  /**
   * Whole-file batch transcription for the import path (KTD-W3) — runs the
   * engine directly on the ENTIRE decoded file in one call (NOT through the
   * live driver's rolling window), relying on transformers.js' own built-in
   * long-form chunking. Returns every segment (global timestamps) to the
   * main thread, where `importPipeline.ts` routes each one to the
   * `RecordingCoordinator`/on-screen store (KTD16, shared output pipeline).
   */
  transcribeFile(
    pcm: Float32Array,
    onProgress?: (fraction: number) => void,
    language?: string,
  ): Promise<TranscriptSegment[]>;
}

// dtype is the engine's default (fp16 encoder + q4f16 decoder — the config
// U8's CH-de A/B settled on; see `DTYPE_CONFIG` in whisperEngine.ts). The
// temporary VITE_WHISPER_ENCODER A/B lever is gone now that the choice is made.
const engine: TranscriptionEngine = new WhisperEngine();
let liveDriver: LiveBlockDriver | null = null;

const api: WorkerApi = {
  async initialize(onProgress) {
    await engine.load(onProgress);
    await engine.warmup();
  },

  start(language) {
    if (liveDriver) return; // idempotent, like the old worker's start()
    liveDriver = new LiveBlockDriver({
      transcribe: (pcm) => engine.transcribe(pcm, { language: language ?? 'de', task: 'transcribe' }),
      emitBlock: (block) =>
        workerScope.postMessage({ type: 'final', text: block.text, startMs: block.startMs, endMs: block.endMs }),
      // #3: a live transcribe failure is surfaced here instead of vanishing as
      // an unhandled rejection. The driver keeps ticking (next window retries);
      // this leaves a diagnosable trace rather than a silently dead session.
      onError: (error) => {
        // eslint-disable-next-line no-console
        console.error('[transcription.worker] live transcribe cycle failed — skipping this window:', error);
      },
    });
    liveDriver.start();
  },

  feedAudio(chunk) {
    liveDriver?.pushAudio(chunk);
  },

  /**
   * Ordering guarantee that makes the trailing live block reach the main
   * thread before this resolves: `driver.stop()` awaits any in-flight tick
   * and then runs one final flush tick BEFORE its own promise resolves;
   * that flush's `emitBlock` calls run synchronously inside `#runCycle`,
   * posting the trailing `final` message(s) via raw `postMessage` on the
   * worker's single message channel strictly before Comlink posts THIS
   * `stop()` call's own resolution message. So `App.tsx`'s `final` handler
   * (which appends to the store and calls `coordinator.handleFinal`) always
   * runs before `await workerApi.stop()` resolves there, and in turn before
   * `App` then calls `coordinator.stop()` — the same reasoning the
   * pre-Whisper worker's header gave for its trailing final.
   */
  async stop() {
    const driver = liveDriver;
    if (!driver) return;
    liveDriver = null;
    await driver.stop();
  },

  /**
   * Runs the engine directly (whole-file long-form transcription) — not
   * through the live driver. `onProgress` is forwarded as-is; see
   * `WhisperEngine.transcribe`'s own doc comment for why it can only ever
   * report a best-effort 0-then-1, not real mid-call fractions.
   */
  async transcribeFile(pcm, onProgress, language) {
    return engine.transcribe(pcm, { language: language ?? 'de', task: 'transcribe', onProgress });
  },
};

// #11: a crash anywhere in the worker (an escaped throw, a rejected promise
// nobody awaited) otherwise vanishes with no trace and stalls the pipeline.
// These give it a diagnosable log line instead of silence. (A Comlink RPC
// timeout is deliberately NOT added: the load-bearing calls — `initialize`
// (multi-minute model download) and `transcribeFile` (whole-file) — are
// legitimately long, so a blanket timeout would abort valid work; a correct
// per-call timeout with cancellation is tracked as follow-up.)
self.addEventListener('error', (event) => {
  // eslint-disable-next-line no-console
  console.error('[transcription.worker] uncaught error:', event.message ?? event);
});
self.addEventListener('unhandledrejection', (event) => {
  // eslint-disable-next-line no-console
  console.error('[transcription.worker] unhandled promise rejection:', event.reason);
});

Comlink.expose(api, self as unknown as Comlink.Endpoint);
