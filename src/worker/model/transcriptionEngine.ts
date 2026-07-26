/**
 * The narrow, implementation-agnostic contract every Whisper-era
 * transcription backend must satisfy (KTD1, refactor plan 002 U1). This is
 * the SWAPPABLE-ENGINE SEAM that replaces `ModelEngine.ts`'s streaming
 * contract (`load` -> `warmup` -> repeat{ `startSession` -> `feed`* ->
 * `endSession` } -> `dispose`), which was built for the earlier stateful,
 * growing-KV-cache session model.
 *
 * Why this shape is different from `ModelEngine`: Whisper has no
 * cross-window context to stream into. There is no `feed()` accumulating
 * audio into a live session and no `onText` token callback — a Whisper
 * engine is fundamentally BATCH: hand it a PCM buffer, get back finished
 * text with timestamps, once. transformers.js' ASR pipeline already does
 * long-form chunking internally (fixed ~29 s windows, no inter-window
 * attention), so there is nothing left for this contract to expose beyond
 * one `transcribe(pcm) -> segments` call.
 *
 * KTD-W3: Live and file-import use the EXACT SAME `transcribe()` call.
 * The only difference between them lives in the driver, not the engine:
 * - Live (U4, not built yet): a driver periodically slices the tail of a
 *   rolling PCM ring buffer (~10-15 s window) and calls `transcribe()` on
 *   just that slice, appending the result as a finalized text block.
 * - Import (U3, not built yet): a driver decodes an entire file to PCM
 *   once and calls `transcribe()` on the whole buffer; transformers.js'
 *   built-in long-form chunking handles files far longer than one window.
 * Because both drivers call the identical method, Whisper's constant RTF
 * (no growing context => no quadratic slowdown) applies
 * equally to both — the 4h live milestone and long batch imports are the
 * same code path, not two.
 */

/** One piece of transcribed text with its position in the source audio. */
export interface TranscriptSegment {
  text: string;
  startMs: number;
  endMs: number;
}

export interface TranscribeOptions {
  /**
   * Source language for Whisper: a code like `'de'`/`'en'`/`'it'`, or the
   * sentinel `'auto'` for Whisper's own per-window language detection
   * (mixed-language meetings). Default `'de'` — the pre-selector behavior,
   * kept so a caller that passes nothing keeps the calibrated CH-de path.
   */
  language?: string;
  /** Default `'transcribe'` (same-language text). `'translate'` always outputs English. */
  task?: 'transcribe' | 'translate';
  /**
   * Best-effort progress hook for a single long-form `transcribe()` call.
   * NOT a guarantee of smooth 0..1 ticks — see `whisperEngine.ts` for why
   * transformers.js' long-form path cannot report real per-chunk progress.
   */
  onProgress?: (fraction: number) => void;
  /** Optional cancellation. See `whisperEngine.ts` for exactly what this can and can't interrupt. */
  signal?: AbortSignal;
}

export type LoadProgressCallback = (fraction: number) => void;

/**
 * Lifecycle: `load()` -> `warmup()` -> repeat{ `transcribe()` } -> `dispose()`.
 * No sessions, no handles, no streaming callbacks — a `TranscriptionEngine`
 * is reusable across any number of independent `transcribe()` calls once
 * loaded and warmed up.
 */
export interface TranscriptionEngine {
  /**
   * Downloads/loads model weights. `onProgress` receives a monotonically
   * increasing 0..1 fraction (see `progress.ts`). Resolves once the model is
   * loaded into memory — but not yet warmed up, since GPU shader/kernel
   * compilation doesn't happen until `warmup()` runs.
   */
  load(onProgress: LoadProgressCallback): Promise<void>;

  /**
   * Runs one throwaway inference pass so WebGPU shader/kernel compilation
   * happens now, not on the user's first real recording/import (R20). Must
   * be called after `load()` resolves and before the first `transcribe()`.
   */
  warmup(): Promise<void>;

  /**
   * Transcribes a buffer of 16 kHz mono PCM audio to text segments with
   * timestamps. Serves BOTH drivers (KTD-W3): a live rolling window and a
   * whole imported file are just different-sized inputs to the same call.
   */
  transcribe(pcm: Float32Array, opts?: TranscribeOptions): Promise<TranscriptSegment[]>;

  /**
   * Releases the loaded model. The engine instance cannot be reused after
   * this — construct a new one to load again.
   */
  dispose(): void;
}
