/**
 * U3 (Whisper refactor plan 002) — the orchestration for one imported-file
 * transcription run: decode the picked `Blob` to PCM, open the SAME
 * recording lifecycle a live recording uses (output files + `SessionStore` +
 * wake lock, via `RecordingCoordinator`), transcribe the WHOLE decoded file
 * in one call, route every returned segment to the coordinator (and,
 * optionally, the on-screen store), then close the lifecycle again.
 * `App.tsx` wires the real decode/worker/coordinator adapters and progress
 * UI around this; everything here is injected (`ImportPipelineDeps`) so the
 * ordering and error-handling logic is unit-testable with plain fakes — no
 * DOM, no worker/Comlink, no real `AudioContext` (see
 * `importPipeline.test.ts`).
 *
 * **Whole-file long-form batch (KTD-W3 / R5), no paced feeder.** The
 * previous design fed PCM through a paced, backpressure-aware feeder (the
 * former `batchTranscription.ts`, removed in U6) because the streaming
 * engine it served had a growing KV-cache — cost rose with session length,
 * so the feeder had to pace chunks and drain `pendingSamples`.
 * Whisper has no cross-window context: transformers.js' ASR pipeline chunks
 * a long file into fixed ~29 s windows internally and returns EVERY segment,
 * with global timestamps, from one `transcribeFile(pcm)` call. There is
 * nothing left for this module to pace, batch, or drain — it decodes, calls
 * `transcribeFile` once, and forwards whatever segments come back.
 *
 * **Why reuse `RecordingCoordinator` instead of a parallel import-specific
 * writer path.** An imported file's transcript needs exactly the same
 * outputs a live recording's does — the `.txt`/`.srt` export files (KTD16's
 * "geteilte Post-hoc-Pipeline" applies to output, not just input) and the
 * `SessionStore` mirror (so an import that gets interrupted mid-way is a
 * crash-recoverable session too, the same AE2 machinery, for free). Passing
 * `() => null` as the coordinator's `startRecorder` is the one deliberate
 * difference: there is no live microphone to capture, so no `.webm` audio
 * writer opens for an import (see `recordingCoordinator.ts`'s U20b addendum
 * — `start()` now only opens the `.webm` file when a recorder actually
 * starts, which this module is the second caller of, alongside the
 * pre-existing no-MediaRecorder recording case).
 *
 * **The single top-level `finally` is deliberate, not just tidy.** Every
 * exit path — a decode failure (before the coordinator ever opens
 * anything), `coordinator.start()` itself failing, or `transcribeFile`
 * throwing — still runs `coordinator.stop()` exactly once. This is safe
 * even when `start()` was never reached: `RecordingCoordinator.stop()` is
 * documented idempotent-safe on an inactive coordinator (`if (!this.#active)
 * return;`), so calling it unconditionally costs nothing on the paths where
 * there is genuinely nothing to close, while guaranteeing the paths where
 * something WAS opened (a session, open writers) always get torn down — no
 * leaked writers, no session stuck `active` forever (which would otherwise
 * surface as a bogus crash-recovery offer on the next app start). A decode
 * failure itself is not swallowed here: it propagates as `runImport`'s own
 * rejection (a plain re-throw via the `finally`, not a `catch`), so the
 * caller (`App.tsx`) sees one clean error to show, exactly as
 * `audioDecode.ts`'s `AudioDecodeError` intends.
 *
 * **Abort.** `options.signal` (if given) is handed straight through to
 * `transcribeFile`. Unlike the old paced feeder — which could stop between
 * chunks — a single long-form `transcribe()` call is atomic: transformers.js
 * 4.2.0 has no mid-call cancellation hook. So `signal` can only be honored
 * BEFORE the call starts (a pre-call check inside the production
 * `transcribeFile` wrapper); once transcription is under way it always runs
 * to completion. This is the accepted consequence of native long-form
 * chunking per R5 — the tradeoff is a bounded wait instead of a torn/partial
 * transcript. Whichever way the call resolves (finishes normally, is
 * rejected because it never started), `stop()` still runs exactly once so
 * partial state is finalized cleanly.
 *
 * `TranscriptSegment` (`transcriptionEngine.ts`) and `FinalSegment`
 * (`recordingCoordinator.ts`) are structurally identical —
 * `{ text, startMs, endMs }` — so segments pass straight through this
 * module with no mapping.
 */
import type { FinalSegment } from './recordingCoordinator';
import type { TranscriptSegment } from '../worker/model/transcriptionEngine';

/** Which step of the import is currently running — drives `App.tsx`'s progress screen copy (see U20b's brief: mirrors the `downloading` screen). */
export type ImportPhase = 'decoding' | 'transcribing';

/**
 * The narrow slice of `RecordingCoordinator` this module drives — deliberately
 * not the concrete class, so a test fake needs neither a real `SessionStore`
 * nor a real `FileSink`. A real `RecordingCoordinator` instance satisfies
 * this structurally. `startRecorder`'s signature is narrowed to exactly what
 * this module ever passes (`() => null` — see file header for why an import
 * never has a `.webm` recorder). `handleFinal` is driven directly by this
 * module now (one call per returned segment) instead of arriving via a
 * worker `final` postMessage.
 */
export interface ImportPipelineCoordinator {
  start(startRecorder: () => null): Promise<void>;
  stop(): Promise<void>;
  handleFinal(segment: FinalSegment): Promise<void>;
}

export interface ImportPipelineDeps {
  /** Decodes the picked file to 16 kHz mono PCM. Production: `blob => decodeAudioBlobTo16kMonoPcm(blob, { decode: createAudioContextDecoder() })` (`audioDecode.ts`). Any rejection here is surfaced as-is (see file header). */
  decode: (blob: Blob) => Promise<Float32Array>;
  /**
   * Whole-file batch transcription — production: a thin wrapper over the
   * worker's `transcribeFile(pcm)` (added in U5), returning segments with
   * GLOBAL timestamps (offset from the start of the file, not per-window).
   * Replaces the old `batchSink`/`runBatchTranscription` pairing entirely:
   * one call in, all segments out.
   */
  transcribeFile: (
    pcm: Float32Array,
    opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal },
  ) => Promise<TranscriptSegment[]>;
  /** The recording lifecycle to open/close around the transcription — production: `App.tsx`'s existing `coordinatorRef.current` (KTD16: same output pipeline as live recording). */
  coordinator: ImportPipelineCoordinator;
  /**
   * Mirrors each finished segment into the on-screen transcript store —
   * production: `transcriptStoreRef.current.append`. Import segments no
   * longer flow through the worker's `final` postMessage path (there is no
   * paced feeder driving that anymore), so the display append happens HERE,
   * right alongside the `coordinator.handleFinal` call for the same
   * segment. Optional — a headless caller (e.g. these tests) may not have a
   * display.
   */
  onSegment?: (segment: FinalSegment) => void;
  /** Reports which step is running, for the progress screen's label. Called once per phase, in order (`'decoding'` then `'transcribing'`) — never called again after that. */
  onPhase?: (phase: ImportPhase) => void;
  /** Forwarded to `transcribeFile` — see that function's own 0..1 semantics. */
  onProgress?: (fraction: number) => void;
  /** Forwarded to `transcribeFile` — can only be honored PRE-CALL (see file header's Abort section). */
  signal?: AbortSignal;
}

/**
 * Runs one import end-to-end: decode → open the recording lifecycle →
 * whole-file transcribe → route every segment to the coordinator (and, if
 * given, the on-screen store) → close the lifecycle. Resolves once every
 * step (including the final `coordinator.stop()`) has completed; rejects
 * with whichever step failed first (decode, `coordinator.start()`, or
 * `transcribeFile`), always having still run `coordinator.stop()` first —
 * see file header.
 */
export async function runImport(blob: Blob, deps: ImportPipelineDeps): Promise<void> {
  try {
    deps.onPhase?.('decoding');
    const pcm = await deps.decode(blob);

    deps.onPhase?.('transcribing');
    await deps.coordinator.start(() => null);
    const segments = await deps.transcribeFile(pcm, {
      onProgress: deps.onProgress,
      signal: deps.signal,
    });
    for (const segment of segments) {
      deps.onSegment?.(segment);
      // Awaited: serializes the writes and lets stop()'s drain (see
      // RecordingCoordinator.stop()) pick up every segment before the
      // writers close.
      await deps.coordinator.handleFinal(segment);
    }
  } finally {
    await deps.coordinator.stop();
  }
}
