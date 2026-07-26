/**
 * U15 segmentation wrapper (SD-1, KTD14): finds local speech regions with
 * `onnx-community/pyannote-segmentation-3.0` (MIT, non-gated) via
 * transformers.js. The model+processor invocation
 * (`AutoModelForAudioFrameClassification` + `AutoProcessor` +
 * `post_process_speaker_diarization`) is INJECTED as a `RunSegmentation`
 * function built in `diarization.worker.ts`; this module owns only the pure
 * mapping from the processor's raw `{start, end}` (seconds) regions to the
 * pipeline's `LocalSpeechSegment` (whole-recording ms). That mapping is unit-
 * testable without transformers.js, a model, or a GPU.
 *
 * We deliberately DROP pyannote's own local speaker ids: those are per-10s-
 * window and not globally consistent (whisperX pattern) — each region is just
 * an embedding unit, and `clustering.ts` assigns the global speaker. Real
 * segmentation quality is a hardware milestone.
 *
 * **Windowed inference (10 s chunks).** `pyannote/segmentation-3.0` ingests
 * exactly 10 s of 16 kHz mono audio (model card) — it is NOT a whole-recording
 * model. Feeding it an entire recording in one forward pass (as an earlier
 * version did) is 85× its designed input length: on a real 14-min meeting that
 * produced garbage boundaries (a single "region" spanning 208 s, plus hundreds
 * of sub-300 ms fragments) which then exploded the speaker count downstream.
 * `PyannoteSegmenter` therefore slices the PCM into consecutive 10 s windows
 * (the last zero-padded to a full window so the model always sees its designed
 * length), runs the injected model per window, offsets each window's regions to
 * global time, and concatenates them. Non-overlapping windows keep it simple:
 * a turn spanning a boundary is split into two adjacent regions that embed and
 * cluster to the same speaker anyway (we only use regions as embedding units,
 * not for their local ids), so the 90%-overlap frame-aggregation pyannote does
 * for boundary precision is unnecessary here.
 *
 * **No region merging (roadmap 1b reverted).** A merge step used to fold regions
 * separated by ≤200 ms into ≤20 s "speaking turns" — fewer, longer embedding
 * units, purely for speed. It shipped without a hardware test and cost accuracy
 * twice: pyannote's post-processing emits regions PER LOCAL SPEAKER (this file
 * drops those ids), so in a lively dialogue neighbouring — even overlapping —
 * regions belong to DIFFERENT speakers and blend when merged; and the merge cut
 * the segment population ~2.5×, which starves the downstream clustering of the
 * evidence its thresholds were calibrated on (hardware test 01). Regions
 * stay raw; the
 * per-call cost is amortized by batched embedding (roadmap 1a) instead.
 */
import type { LocalSpeechSegment } from './DiarizationEngine';

/** transformers.js pyannote model+processor ONNX repo (non-gated). */
export const PYANNOTE_SEGMENTATION_MODEL_ID = 'onnx-community/pyannote-segmentation-3.0';

/** pyannote/segmentation-3.0's designed input length — it ingests 10 s of 16 kHz mono (model card). */
export const SEGMENTATION_WINDOW_SEC = 10;
/** The rate `audioDecode.ts` resamples to and the model expects. */
export const SEGMENTATION_SAMPLE_RATE = 16000;

/** One raw region from `post_process_speaker_diarization` — `start`/`end` in SECONDS. */
export interface RawSpeechRegion {
  start: number;
  end: number;
}

/** Runs the pyannote model+processor over 16 kHz mono PCM and returns raw speech regions (seconds). Injected. */
export type RunSegmentation = (pcm: Float32Array) => Promise<RawSpeechRegion[]>;

/**
 * Maps raw processor regions (seconds) to `LocalSpeechSegment[]` (ms): scales
 * to milliseconds, drops non-positive-length regions, and sorts by start.
 * Pure — the testable heart of this unit.
 */
export function mapToLocalSegments(regions: readonly RawSpeechRegion[]): LocalSpeechSegment[] {
  return regions
    .map((r) => ({ startMs: Math.round(r.start * 1000), endMs: Math.round(r.end * 1000) }))
    .filter((s) => s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * Runs the injected model over consecutive 10 s windows (see file header) and
 * maps the concatenated, globally-offset regions to `LocalSpeechSegment[]`.
 */
export class PyannoteSegmenter {
  readonly #run: RunSegmentation;
  readonly #sampleRate: number;
  readonly #windowSamples: number;

  constructor(
    run: RunSegmentation,
    windowSec: number = SEGMENTATION_WINDOW_SEC,
    sampleRate: number = SEGMENTATION_SAMPLE_RATE,
  ) {
    this.#run = run;
    this.#sampleRate = sampleRate;
    this.#windowSamples = Math.round(windowSec * sampleRate);
  }

  async segment(pcm: Float32Array): Promise<LocalSpeechSegment[]> {
    const maxSec = pcm.length / this.#sampleRate;
    const regions: RawSpeechRegion[] = [];
    for (let start = 0; start < pcm.length; start += this.#windowSamples) {
      const offsetSec = start / this.#sampleRate;
      const windowRegions = await this.#run(this.#windowAt(pcm, start));
      for (const r of windowRegions) {
        // Offset window-local seconds to global time, and clamp to the real
        // audio length so a region the model emits into a zero-padded tail
        // (last window) collapses to zero length and is dropped by the mapper.
        regions.push({ start: Math.min(r.start + offsetSec, maxSec), end: Math.min(r.end + offsetSec, maxSec) });
      }
    }
    return mapToLocalSegments(regions);
  }

  /** The `[start, start+window)` slice, zero-padded to a full window so the model always sees its designed 10 s input length. */
  #windowAt(pcm: Float32Array, start: number): Float32Array {
    const slice = pcm.subarray(start, Math.min(pcm.length, start + this.#windowSamples));
    if (slice.length === this.#windowSamples) return slice;
    const padded = new Float32Array(this.#windowSamples);
    padded.set(slice);
    return padded;
  }
}
