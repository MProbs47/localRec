/**
 * U15 concrete `DiarizationEngine` (KTD1/KTD14): composes the pyannote
 * segmenter (transformers.js) and the WeSpeaker embedder (onnxruntime-web)
 * behind the swappable interface `diarize.ts` consumes. The two models are
 * supplied by injected loaders (built in `diarization.worker.ts`), so this
 * composition + its combined load-progress are unit-testable without either
 * real model — real inference is the hardware milestone.
 *
 * The two models form the second, separate model set (KTD15): losing it means
 * no speaker labels, transcription untouched (SD-3).
 */
import type { DiarizationEngine, LocalSpeechSegment } from './DiarizationEngine';
import { PyannoteSegmenter, type RunSegmentation } from './segmentation';
import type { EmbedderLike } from './embedding';

export interface DiarizationModelLoaders {
  /** Loads pyannote-segmentation-3.0 and returns the run function; reports its own 0..1 download fraction. */
  loadSegmentation(onFileProgress: (fraction: number) => void): Promise<RunSegmentation>;
  /** Loads the WeSpeaker embedding model and returns the embedder; reports its own 0..1 download fraction. */
  loadEmbedder(onFileProgress: (fraction: number) => void): Promise<EmbedderLike>;
}

export class PyannoteWeSpeakerEngine implements DiarizationEngine {
  readonly #loaders: DiarizationModelLoaders;
  #segmenter: PyannoteSegmenter | null = null;
  #embedder: EmbedderLike | null = null;

  constructor(loaders: DiarizationModelLoaders) {
    this.#loaders = loaders;
  }

  /**
   * Loads both models, reporting a combined, monotonic 0..1 fraction (the two
   * weighted equally — coarse but honest; the exact byte split is cosmetic for
   * a post-hoc, background step). Segmentation loads first (it also gates the
   * embedder in practice), then the embedder.
   */
  async load(onProgress: (fraction: number) => void): Promise<void> {
    let segFraction = 0;
    let embFraction = 0;
    let highWater = 0;
    const report = () => {
      highWater = Math.max(highWater, (segFraction + embFraction) / 2);
      onProgress(Math.min(1, highWater));
    };

    const run = await this.#loaders.loadSegmentation((f) => {
      segFraction = f;
      report();
    });
    this.#segmenter = new PyannoteSegmenter(run);

    this.#embedder = await this.#loaders.loadEmbedder((f) => {
      embFraction = f;
      report();
    });

    onProgress(1);
  }

  async segment(pcm: Float32Array): Promise<LocalSpeechSegment[]> {
    return this.#requireSegmenter().segment(pcm);
  }

  async embed(pcmSegment: Float32Array): Promise<Float32Array> {
    return this.#requireEmbedder().embed(pcmSegment);
  }

  async embedBatch(pcmSegments: readonly Float32Array[]): Promise<Float32Array[]> {
    return this.#requireEmbedder().embedBatch(pcmSegments);
  }

  dispose(): void {
    this.#segmenter = null;
    this.#embedder = null;
  }

  #requireSegmenter(): PyannoteSegmenter {
    if (!this.#segmenter) throw new Error('PyannoteWeSpeakerEngine: load() must complete before segment()');
    return this.#segmenter;
  }

  #requireEmbedder(): EmbedderLike {
    if (!this.#embedder) throw new Error('PyannoteWeSpeakerEngine: load() must complete before embed()');
    return this.#embedder;
  }
}
