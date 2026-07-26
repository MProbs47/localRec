/**
 * U15 speaker-embedding wrapper (SD-1, KTD14): runs the WeSpeaker
 * `Wespeaker/wespeaker-voxceleb-resnet34-LM` ResNet34 model over one speech
 * segment's Fbank features and returns its 256-d embedding.
 *
 * WeSpeaker can't ONNX-trace its `torchaudio.compliance.kaldi.fbank`, so the
 * features are computed in JS by `features.ts` and fed to the graph's single
 * input; the graph emits a single embedding output. This module is pure over
 * an INJECTED `OrtSessionLike` (the narrow subset of onnxruntime-web's
 * `InferenceSession` we actually call) — the real session is created in
 * `diarization.worker.ts`, so these mechanics are unit-testable with a fake
 * session (no ort, no model, no GPU). Real embedding quality is a hardware
 * milestone.
 *
 * **Input/output names are read from the session, never hardcoded.** The
 * onnx-community export of this model names its input `input_features` and its
 * output `embeddings` — NOT the classic WeSpeaker `feats`/`embs` the original
 * research assumed. Hardcoding `feats` produced a runtime
 * `input 'input_features' is missing in 'feeds'` at the first real inference
 * (the whole diarization silently SD-3-skipped). `InferenceSession` exposes
 * `inputNames`/`outputNames`, and WeSpeaker has exactly one of each, so
 * `inputNames[0]`/`outputNames[0]` is the robust, export-agnostic choice.
 */
import { computeFbank, WESPEAKER_FBANK, type FbankConfig } from './features';

/** onnx-community mirror of the WeSpeaker r-vector model (CC-BY-4.0, non-gated). */
export const WESPEAKER_MODEL_ID = 'onnx-community/wespeaker-voxceleb-resnet34-LM';
/** ResNet34-LM embedding dimension. */
export const WESPEAKER_EMBEDDING_DIM = 256;

/** The narrow subset of an onnxruntime-web tensor this module reads/writes. */
export interface OrtTensorLike {
  data: Float32Array;
  dims: readonly number[];
}

/** The narrow subset of `InferenceSession` this module calls (a real ort session satisfies this structurally). */
export interface OrtSessionLike {
  /** The graph's declared input names — used to feed the features under the real name (see file header). */
  readonly inputNames: readonly string[];
  /** The graph's declared output names — used to read the embedding under the real name. */
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
}

/** Builds an ort float32 tensor — injected so the real `new ort.Tensor(...)` stays in the worker. */
export type CreateFloat32Tensor = (data: Float32Array, dims: number[]) => OrtTensorLike;

export interface EmbedderLike {
  /** Embeds one segment. Convenience over `embedBatch([pcmSegment])`. */
  embed(pcmSegment: Float32Array): Promise<Float32Array>;
  /**
   * Embeds several segments in ONE model call (perf, roadmap 1a). Returns one
   * embedding per input, in input order. Empty input → `[]`.
   */
  embedBatch(pcmSegments: readonly Float32Array[]): Promise<Float32Array[]>;
}

/**
 * Composes `features.ts` + an ort session into an embedder. A segment shorter
 * than one Fbank frame yields a zero embedding (its cosine distance to
 * anything is the max-ambiguity 1 — see `clustering.ts` — so it never
 * spuriously joins a speaker).
 *
 * **Batched inference (roadmap 1a).** WeSpeaker is a ResNet34: on the WASM EP
 * each `session.run` carries fixed dispatch overhead, so running one segment at
 * a time over the ~hundreds of speech regions of a real meeting is dominated by
 * that overhead. `embedBatch` stacks N segments' Fbank matrices into a single
 * `[N, maxFrames, mel]` tensor and runs the graph ONCE. Because per-utterance
 * CMN (see `features.ts`) must not mix segments, each segment's Fbank is still
 * computed independently; only the ort call is shared. The batch is zero-padded
 * to its longest member's frame count — WeSpeaker's temporal statistics pooling
 * has no length mask, so padded frames perturb the pooled embedding slightly;
 * the caller (`diarize.ts`) keeps that perturbation tiny by length-bucketing so
 * a batch's members are near-equal length. This adds NO new ONNX ops (same conv/
 * bn graph, larger batch axis), matching the app's WASM-EP posture — but that
 * the export's batch axis is dynamic is a hardware-milestone assumption; a fixed
 * batch=1 export would surface as an ort shape error → SD-3 fallback, never
 * silent corruption.
 */
export class WeSpeakerEmbedder implements EmbedderLike {
  readonly #session: OrtSessionLike;
  readonly #createTensor: CreateFloat32Tensor;
  readonly #fbankConfig: FbankConfig;

  constructor(session: OrtSessionLike, createTensor: CreateFloat32Tensor, fbankConfig: FbankConfig = WESPEAKER_FBANK) {
    this.#session = session;
    this.#createTensor = createTensor;
    this.#fbankConfig = fbankConfig;
  }

  async embed(pcmSegment: Float32Array): Promise<Float32Array> {
    return (await this.embedBatch([pcmSegment]))[0];
  }

  async embedBatch(pcmSegments: readonly Float32Array[]): Promise<Float32Array[]> {
    if (pcmSegments.length === 0) return [];

    const numMelBins = this.#fbankConfig.numMelBins;
    // Per-segment Fbank with INDEPENDENT per-utterance CMN — batching shares
    // only the model call, never a segment's statistics (see class header).
    const fbanks = pcmSegments.map((pcm) => computeFbank(pcm, this.#fbankConfig));
    // Sub-frame segments get a zero embedding without touching the model (their
    // cosine distance to anything is 1 — see `clustering.ts`); the rest embed.
    const out: Float32Array[] = fbanks.map(() => new Float32Array(WESPEAKER_EMBEDDING_DIM));
    const active = fbanks
      .map((fbank, index) => ({ fbank, index }))
      .filter((entry) => entry.fbank.numFrames > 0);
    if (active.length === 0) return out;

    const maxFrames = active.reduce((m, entry) => Math.max(m, entry.fbank.numFrames), 0);
    const batch = new Float32Array(active.length * maxFrames * numMelBins);
    active.forEach((entry, row) => {
      // Left-aligned; the remaining [numFrames, maxFrames) frames stay zero-padded.
      batch.set(entry.fbank.data, row * maxFrames * numMelBins);
    });

    const feats = this.#createTensor(batch, [active.length, maxFrames, numMelBins]);
    // Feed/read under the model's OWN declared names — WeSpeaker has exactly one
    // input and one output (see file header for why this isn't hardcoded).
    const inputName = this.#session.inputNames[0];
    const outputName = this.#session.outputNames[0];
    const output = await this.#session.run({ [inputName]: feats });
    const embs = output[outputName];
    if (!embs) throw new Error(`WeSpeakerEmbedder: model output has no '${outputName}' tensor`);
    // Output is [N, dim] row-major; copy each row out of the session-owned
    // buffer (which may be reused on the next run) into its input slot.
    const dim = embs.data.length / active.length;
    active.forEach((entry, row) => {
      out[entry.index] = new Float32Array(embs.data.subarray(row * dim, (row + 1) * dim));
    });
    return out;
  }
}
