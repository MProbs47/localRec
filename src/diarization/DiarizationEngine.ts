/**
 * The swappable diarization model seam (U15, KTD1/KTD14) — the diarization
 * analogue of `transcriptionEngine.ts`'s `TranscriptionEngine`. Deliberately
 * tiny and free of any pyannote / onnxruntime / transcription specifics, so:
 *  - a plain fake can satisfy it in tests (proves substitutability, and keeps
 *    the documented sherpa-onnx fallback a local swap, not an interface change);
 *  - `diarize.ts` (U16) can drive the whole segment→embed→cluster pipeline
 *    against this contract with no model, no worker, and no GPU.
 *
 * The real implementation (segmentation via transformers.js pyannote,
 * embedding via onnxruntime-web + `features.ts` Fbank) lives behind this
 * interface; real inference is a hardware milestone, like the ASR engine's.
 */

/**
 * A local speech region the segmentation model found, in whole-recording
 * milliseconds. "Local" = a contiguous single-speaker stretch before global
 * clustering decides *which* speaker it is.
 */
export interface LocalSpeechSegment {
  startMs: number;
  endMs: number;
}

export interface DiarizationEngine {
  /** Loads both models (segmentation + embedding); reports monotonic 0→1 download progress. */
  load(onProgress: (fraction: number) => void): Promise<void>;
  /** Finds local single-speaker speech regions over the whole 16 kHz mono PCM. */
  segment(pcm: Float32Array): Promise<LocalSpeechSegment[]>;
  /** Produces a fixed-length speaker embedding for one 16 kHz mono PCM segment. */
  embed(pcmSegment: Float32Array): Promise<Float32Array>;
  /** Embeds several segments in one model call (roadmap 1a); one embedding per input, in order. */
  embedBatch(pcmSegments: readonly Float32Array[]): Promise<Float32Array[]>;
  /** Releases model/session resources. */
  dispose(): void;
}
