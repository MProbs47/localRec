/**
 * U15 diarization worker (KTD13/KTD15) — the composition root that wires the
 * REAL models behind `PyannoteWeSpeakerEngine` and exposes a tiny Comlink
 * surface (`initialize` / `diarizeAudio`). Post-hoc only: the main thread runs
 * this AFTER stop/import (U18/U21), when live inference is done and there is no
 * GPU contention (KTD15) — so a plain Comlink return (not a raw block stream)
 * is all this needs.
 *
 * This file holds the two model integrations the rest of the diarization code
 * is deliberately kept free of, so they live in exactly one place:
 *  - **Segmentation** — transformers.js `AutoModelForAudioFrameClassification`
 *    + `AutoProcessor` on `onnx-community/pyannote-segmentation-3.0`, whose
 *    `post_process_speaker_diarization(logits, num_samples)` returns
 *    `[[ {id,start,end,confidence}, … ]]` (batch → regions, seconds).
 *  - **Embedding** — WeSpeaker via **onnxruntime-web** directly (transformers.js
 *    has no embedding pipeline), features from `features.ts`.
 *
 * HARDWARE-MILESTONE flags (headless-unverifiable, validate on target GPU):
 *  1. transformers.js 4.2.0 pyannote path works end-to-end (feature is young —
 *     see U15 research); the `post_process_speaker_diarization` output shape is
 *     handled defensively but confirm at runtime.
 *  2. onnxruntime-web WASM asset paths: importing the same ENTRY as
 *     transformers.js (`onnxruntime-web/webgpu`, see the import note below)
 *     makes `ort.env.wasm` one shared singleton, so a single pin serves both
 *     models — but confirm the wasm binary resolves offline and same-origin
 *     (no `cdn.jsdelivr.net` in the network panel at diarization start).
 *  3. WeSpeaker runs on the WASM EP (WebGPU op coverage for ResNet34 conv/bn is
 *     weaker — matches the app's WASM-fallback posture).
 *
 * The narrow local interfaces + `as unknown as` casts below mirror
 * `whisperEngine.ts`'s documented type-shim approach: transformers.js' and
 * ort's public types are looser/bigger than the exact shapes this file calls.
 */
import * as Comlink from 'comlink';
// MUST stay `onnxruntime-web/webgpu` — the exact specifier transformers.js'
// `backends/onnx.js` imports. A bare `onnxruntime-web` resolves to a DIFFERENT
// entry (`dist/ort.bundle.min.mjs`) which is a second, complete ORT runtime
// with its own `env` singleton: the pin below would then miss transformers.js'
// env and leave it on its jsdelivr default (CSP-blocked in prod), while the
// bundler additionally emits that entry's hardwired
// `ort-wasm-simd-threaded.jsep.wasm` — 26.1 MB of never-fetched ballast, over
// Cloudflare Pages' 25 MiB per-file limit. Both entries export the identical
// surface (`InferenceSession`, `Tensor`, `env`) and register the identical
// backends (cpu/wasm/webgpu/webnn), so this costs nothing here.
import * as ort from 'onnxruntime-web/webgpu';
import { AutoModelForAudioFrameClassification, AutoProcessor, type ProgressCallback } from '@huggingface/transformers';
import { PyannoteWeSpeakerEngine } from './pyannoteWeSpeakerEngine';
import { PYANNOTE_SEGMENTATION_MODEL_ID, type RawSpeechRegion } from './segmentation';
import { WeSpeakerEmbedder, WESPEAKER_MODEL_ID, type OrtSessionLike, type OrtTensorLike } from './embedding';
import { diarize, type DiarizeOptions } from './diarize';
import type { SpeakerTimeline } from './types';
import { buildHfResolveUrl } from '../storage/modelCache';
import { pinOrtWasmToLocalAssets } from '../worker/model/ortWasmPaths';

// S1 privacy fix (see `ortWasmPaths.ts`'s header). Because the import above
// uses transformers.js' own specifier, `ort.env.wasm` here IS the object its
// `backends/onnx.js` writes its jsdelivr default into — one shared singleton
// for BOTH models in this worker (WeSpeaker below and pyannote segmentation
// via transformers.js). Pinning it once here therefore covers both; the value
// is read lazily on first session creation, so import order doesn't matter.
pinOrtWasmToLocalAssets(ort.env.wasm);

/** WeSpeaker ONNX file on the onnx-community mirror. */
const WESPEAKER_ONNX_PATH = 'onnx/model.onnx';

/** The exact shapes this file calls on the loaded pyannote pieces (transformers.js types are looser — see header). */
type PyannoteModelLike = (inputs: unknown) => Promise<{ logits: unknown }>;
interface PyannoteProcessorLike {
  (audio: Float32Array): Promise<unknown>;
  post_process_speaker_diarization(
    logits: unknown,
    numSamples: number,
  ): Array<Array<{ id: number; start: number; end: number; confidence: number }>>;
}

/** Scales a transformers.js file-download `progress_callback` (0..100 per file) to a 0..1 fraction. */
function toFileFraction(onFileProgress: (fraction: number) => void): ProgressCallback {
  return (info) => {
    if ('progress' in info && typeof info.progress === 'number' && 'file' in info && String(info.file).endsWith('.onnx')) {
      onFileProgress(Math.min(1, info.progress / 100));
    }
  };
}

const engine = new PyannoteWeSpeakerEngine({
  async loadSegmentation(onFileProgress) {
    const model = (await AutoModelForAudioFrameClassification.from_pretrained(PYANNOTE_SEGMENTATION_MODEL_ID, {
      progress_callback: toFileFraction(onFileProgress),
    })) as unknown as PyannoteModelLike;
    const processor = (await AutoProcessor.from_pretrained(PYANNOTE_SEGMENTATION_MODEL_ID)) as unknown as PyannoteProcessorLike;

    // Called once PER 10 s WINDOW by `PyannoteSegmenter` (see segmentation.ts) —
    // so this must NOT feed the whole recording. `pcm` here is one window.
    return async (pcm: Float32Array): Promise<RawSpeechRegion[]> => {
      const inputs = await processor(pcm);
      const { logits } = await model(inputs);
      const result = processor.post_process_speaker_diarization(logits, pcm.length);
      // Single input → first (and only) batch entry; drop pyannote's local ids
      // (global speakers come from clustering, whisperX pattern).
      return (result[0] ?? []).map((region) => ({ start: region.start, end: region.end }));
    };
  },

  async loadEmbedder(onFileProgress) {
    const url = buildHfResolveUrl(WESPEAKER_MODEL_ID, WESPEAKER_ONNX_PATH);
    const session = await ort.InferenceSession.create(url, { executionProviders: ['wasm'] });
    // ort's `InferenceSession.create` exposes no download-progress hook, so this
    // step is coarse: report complete once the session is ready.
    onFileProgress(1);
    const createTensor = (data: Float32Array, dims: number[]): OrtTensorLike =>
      new ort.Tensor('float32', data, dims) as unknown as OrtTensorLike;
    return new WeSpeakerEmbedder(session as unknown as OrtSessionLike, createTensor);
  },
});

export interface DiarizationWorkerApi {
  /** Loads both diarization models (reports combined 0..1 progress). Idempotent-ish: safe to call once before the first diarizeAudio. */
  initialize(onProgress: (fraction: number) => void): Promise<void>;
  /** Runs the full post-hoc pipeline over one decoded 16 kHz mono recording → global speaker timeline. */
  diarizeAudio(pcm: Float32Array, options: DiarizeOptions): Promise<SpeakerTimeline>;
}

/**
 * Enriches a caught error with the stage + the original name/message/stack, so
 * the reason survives Comlink's error serialization to the main thread (a bare
 * re-throw arrives as just a generic message). Load-bearing for diagnosing why
 * the model load or inference failed (e.g. a blocked fetch, a transformers.js
 * API mismatch, an ORT WASM path issue).
 */
function stageError(stage: string, error: unknown): Error {
  const e = error as { name?: string; message?: string; stack?: string } | undefined;
  const head = `diarization.${stage} failed: ${e?.name ?? 'Error'}: ${e?.message ?? String(error)}`;
  const tail = e?.stack ? ` :: ${e.stack.split('\n').slice(0, 4).join(' | ')}` : '';
  return new Error(head + tail);
}

const api: DiarizationWorkerApi = {
  async initialize(onProgress) {
    try {
      await engine.load(onProgress);
    } catch (error) {
      throw stageError('initialize', error);
    }
  },
  async diarizeAudio(pcm, options) {
    try {
      return await diarize(pcm, engine, options);
    } catch (error) {
      throw stageError(`diarizeAudio(pcm=${pcm.length})`, error);
    }
  },
};

// #11: give an escaped throw / unawaited rejection a diagnosable log line
// instead of a silent stall. (diarizeAudio already wraps its own failures into
// a rejected RPC via stageError; these catch anything outside that path.)
self.addEventListener('error', (event) => {
  // eslint-disable-next-line no-console
  console.error('[diarization.worker] uncaught error:', event.message ?? event);
});
self.addEventListener('unhandledrejection', (event) => {
  // eslint-disable-next-line no-console
  console.error('[diarization.worker] unhandled promise rejection:', event.reason);
});

Comlink.expose(api, self as unknown as Comlink.Endpoint);
