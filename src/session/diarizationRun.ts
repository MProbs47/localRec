/**
 * The shared post-hoc annotation pipeline (KTD16) that BOTH entry points use:
 * live recording after stop (U18) and file import after batch transcription
 * (U21). Both converge here — the only difference is the source of the audio
 * (a decoded PCM the import path already holds, or the recorded `.webm` the
 * live path must decode first).
 *
 * decode?(→pcm) → worker.initialize(download models) → worker.diarizeAudio
 * (segment→embed→cluster) → align the transcript against the speaker timeline.
 * The diarization worker is INJECTED (a Comlink proxy in the app), so this
 * whole orchestration is unit-testable with a fake worker — no models, no GPU.
 *
 * SD-3 (graceful): any failure — models absent/undownloaded, decode error,
 * inference error — resolves to `diarized: false` with every segment's speaker
 * `null` (i.e. the plain transcript, unchanged), never a throw. The caller
 * inspects `diarized`/`error` to decide UX (offer download vs. retry), but the
 * transcript is always intact.
 */
import type { DiarizationWorkerApi } from '../diarization/diarization.worker';
import { alignTranscript, type AlignedSegment, type TimedTextSegment } from '../diarization/align';
import type { ClusterOptions } from '../diarization/clustering';
import type { SpeakerTimeline } from '../diarization/types';

/**
 * Default auto-clustering cosine-distance threshold — **hardware-calibrated**
 * (hardware test 01, round 5).
 *
 * The previous 0.7045 was pyannote-3.1's frozen value, adopted on the
 * assumption it transfers because the embedding model is the same. It does
 * NOT: pyannote applies it to *centroid* linkage, `clustering.ts` runs
 * *average* linkage, and the distance scale of our JS feature chain differs.
 * On a real 2-speaker interview the measured threshold sweep separated the two
 * voices into balanced clusters at every cut in [0.35, 0.55] and collapsed
 * them into one blob from 0.65 up — 0.7045 sat beyond the merge cliff, which
 * is why the whole recording came out as ONE speaker. 0.5 is the midpoint of
 * the two best-behaved sweep points (0.45/0.55), keeping margin to the merge
 * cliff above and the split regime below. One recording's calibration — the
 * `[diarize]` sweep log exists so the next run can re-judge it.
 */
export const DEFAULT_CLUSTER_THRESHOLD = 0.5;

/**
 * **`min_cluster_size` is deliberately NOT set** (was 12, pyannote-3.1's value)
 * — it made a real 2-speaker interview come out as ONE speaker
 * (hardware test 01).
 *
 * Why it can't transfer: pyannote applies the absorb to ITS whole, dense
 * segmentation population (hundreds of regions). We apply clustering to the
 * RELIABLE subset only (≥ `DEFAULT_MIN_RELIABLE_DURATION_MS`, see
 * `clusterWithDurationGuard`) — a few dozen segments on a short recording. An
 * absolute floor of 12 there means a speaker who holds the floor less (the
 * interviewer, ~8 reliable turns) is silently absorbed into the dominant one,
 * i.e. the absorb deletes real speakers instead of noisy singletons.
 *
 * The duration guard already IS the noise gate the absorb was added for: short,
 * noisily-embedded interjections never define a speaker in the first place, so
 * absorbing on top only removed genuine minority speakers. The knob still
 * exists in `clustering.ts` (tested) should real-hardware calibration ever want
 * it back — then relative to the population, never as an absolute count.
 */

export interface DiarizationRunDeps {
  /** Comlink proxy to the diarization worker (`diarization.worker.ts`). */
  worker: Pick<DiarizationWorkerApi, 'initialize' | 'diarizeAudio'>;
  /** Decodes the recorded blob to 16 kHz mono PCM (U14). Required only when `audio` is given instead of `pcm`. */
  decode?: (audio: Blob) => Promise<Float32Array>;
}

export interface DiarizationRunInput {
  /** Already-decoded 16 kHz mono PCM (import path holds this). */
  pcm?: Float32Array;
  /** Recorded audio blob to decode first (live path). One of `pcm`/`audio` is required. */
  audio?: Blob;
  /** The finalized transcript to annotate. */
  segments: readonly TimedTextSegment[];
  /** Clustering config; defaults to auto with `DEFAULT_CLUSTER_THRESHOLD`. */
  clustering?: ClusterOptions;
  /**
   * The speaker count the user stated (hardware test 01 round 5: they usually
   * KNOW it, and telling the pipeline removes the hardest unsupervised decision
   * — the count — entirely). Omit for automatic detection.
   */
  knownSpeakerCount?: number;
}

export interface DiarizationRunResult {
  /** The transcript with speakers attached (or all `null` on the SD-3 fallback). */
  aligned: AlignedSegment[];
  /** The speaker timeline (empty on fallback). */
  timeline: SpeakerTimeline;
  /** True if diarization ran; false if it was skipped/failed (SD-3 fallback used). */
  diarized: boolean;
  /** The failure, when `diarized` is false and it was due to an error (absent for the plain "no speech" case). */
  error?: unknown;
}

/** SD-3 fallback result: the plain transcript, no speakers. */
function fallback(segments: readonly TimedTextSegment[], error?: unknown): DiarizationRunResult {
  return { aligned: alignTranscript(segments, []), timeline: [], diarized: false, error };
}

/**
 * Runs the pipeline. `onProgress` reports model-download progress (0..1). Never
 * throws — failures become the SD-3 fallback result.
 */
export async function runDiarization(
  input: DiarizationRunInput,
  deps: DiarizationRunDeps,
  onProgress: (fraction: number) => void = () => {},
): Promise<DiarizationRunResult> {
  try {
    let pcm = input.pcm;
    if (!pcm) {
      if (!input.audio || !deps.decode) throw new Error('runDiarization: need `pcm`, or `audio` + a `decode` dep');
      pcm = await deps.decode(input.audio);
    }

    await deps.worker.initialize(onProgress);
    const timeline = await deps.worker.diarizeAudio(pcm, {
      clustering: input.clustering ?? { mode: 'auto', distanceThreshold: DEFAULT_CLUSTER_THRESHOLD },
      knownSpeakerCount: input.knownSpeakerCount,
    });

    return { aligned: alignTranscript(input.segments, timeline), timeline, diarized: true };
  } catch (error) {
    return fallback(input.segments, error);
  }
}
