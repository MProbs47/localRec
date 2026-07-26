/**
 * Whisper implementation of `TranscriptionEngine` (KTD1, refactor plan 002
 * U1). Uses transformers.js' `automatic-speech-recognition` pipeline —
 * `onnx-community/whisper-large-v3-turbo`, an ONNX conversion of the
 * original OpenAI weights (MIT-licensed) — on WebGPU, with its
 * built-in long-form chunking doing the heavy lifting: fixed-size windows
 * with no cross-window attention, so RTF stays constant no matter how long
 * the input audio is (unlike the growing-KV-cache streaming engine this
 * replaced, whose cost rose quadratically with session length).
 *
 * Pipeline injection (testability, see `whisperEngine.test.ts`): the ASR
 * pipeline factory is constructor-injectable via `{ createPipeline }`,
 * defaulting to a thin wrapper around the real `pipeline()` import. Tests
 * pass a fake factory returning a fake callable + `dispose()` pair, so
 * chunk-mapping/config/lifecycle logic is fully exercised with zero GPU,
 * model, or network dependency.
 *
 * KTD-W4 WebGPU guardrails (confirmed transformers.js bugs — see plan's
 * "Wichtige technische Entscheide" and "Risiken"):
 * (a) A q8 DECODER on WebGPU produces garbage output
 *     (https://github.com/huggingface/transformers.js/issues/1317).
 *     `q4`/`q4f16`/`fp16` are safe; `BANNED_DECODER_DTYPE` + `#assertSafeDecoderDtype`
 *     below are a defensive backstop against this ever regressing silently.
 * (b) `chunk_length_s` must stay <= 29, NOT 30 — at exactly 30 s,
 *     transformers.js' long-form chunking breaks
 *     (https://github.com/huggingface/transformers.js/issues/1358, open).
 *     `MAX_CHUNK_LENGTH_S` + `#safeChunkLengthS()` hard-wire this.
 * (c) q4f16 is the starting dtype for both encoder and decoder; the
 *     Whisper encoder is more quantization-sensitive than the decoder, so
 *     `DTYPE_ENCODER_FP16` is kept as a named, ready-to-swap escalation if
 *     U8's real-hardware CH-de listening test finds q4f16 too lossy. The
 *     default engine always uses `DTYPE_CONFIG`.
 *
 * Reality check for this unit: there is no GPU, model, or network access in
 * this environment. This file must build and structurally match the
 * documented transformers.js ASR pipeline API; it is not executed for real
 * here. Real WebGPU load/warmup/transcription quality is the U8 manual
 * milestone on target hardware (see `whisperEngine.test.ts`'s header note).
 */
import {
  pipeline,
  type DataType,
  type ProgressCallback,
  type AutomaticSpeechRecognitionOutput,
} from '@huggingface/transformers';
import type {
  LoadProgressCallback,
  TranscribeOptions,
  TranscriptionEngine,
  TranscriptSegment,
} from './transcriptionEngine';
import { createProgressAggregator } from './progress';

export const MODEL_ID = 'onnx-community/whisper-large-v3-turbo';

/**
 * KTD-W4(b): long-form chunk window in seconds. MUST stay <= 29 — at
 * exactly 30, transformers.js' long-form chunking breaks (issue #1358,
 * open as of writing this unit). 29 is the safe practical ceiling, not a
 * tuned quality value; `#safeChunkLengthS()` clamps against it defensively.
 */
export const MAX_CHUNK_LENGTH_S = 29;

/** Overlap between consecutive long-form chunks — matches transformers.js' own long-form example. */
export const STRIDE_LENGTH_S = 5;

/**
 * KTD-W4(c): dtype config — **fp16 encoder + q4f16 decoder**. This is the
 * default that U8's real-hardware CH-de A/B settled on: a full-q4f16 encoder
 * was measurably too lossy on Swiss-German (hallucinated "Vielen Dank" on the
 * opening silence, mangled proper nouns like "Slampoet"→"Islam poet",
 * "Hochdeutsch"→"Rufdurch") because Whisper's audio encoder is far more
 * quantization-sensitive than its decoder. fp16 encoder fixed essentially all
 * of it and still held live RTF < 1 on the target hardware, so it ships as the
 * default (cost: ~1 GB larger download — the fp16 encoder graph vs the q4f16
 * one). The decoder stays q4f16 (never q8 — see `BANNED_DECODER_DTYPE`).
 *
 * The KEYS must be the model's per-session file basenames, NOT `encoder`/
 * `decoder`: transformers.js resolves dtype per file via `dtype[fileName]`
 * (`selectDtype` in the lib), where `fileName` is the ONNX session name.
 * Whisper's sessions are `encoder_model` and `decoder_model_merged`
 * (verified against the installed 4.2.0 + the onnx-community/whisper-large-
 * v3-turbo repo). With the wrong keys the lookup misses and transformers.js
 * silently falls back to the device-default dtype (fp32 on WebGPU) —
 * downloading the multi-GB fp32 weights, which then blow the ArrayBuffer
 * allocation. These keys select `encoder_model_fp16.onnx` +
 * `decoder_model_merged_q4f16.onnx` instead.
 */
export const DTYPE_CONFIG = { encoder_model: 'fp16', decoder_model_merged: 'q4f16' } as const;

/**
 * KTD-W4(a): q8 decoder on WebGPU produces garbage output (transformers.js
 * issue #1317). This constant + `#assertSafeDecoderDtype` are a defensive
 * runtime guard so this ban can never silently regress if `DTYPE_CONFIG`
 * is edited later without re-reading this comment.
 */
const BANNED_DECODER_DTYPE = 'q8';

/**
 * Weight-file count for `createProgressAggregator` (`progress.ts`): the two
 * `.onnx` graphs transformers.js actually downloads for the shipped turbo set
 * — `encoder_model_fp16.onnx` + `decoder_model_merged_q4f16.onnx` (verified
 * against the onnx-community/whisper-large-v3-turbo repo file listing). The
 * fp16 encoder graph is a single `.onnx` (well under the 2 GiB protobuf
 * limit), NOT sharded into `.onnx_data`, so `load()` passes a `.onnx` matcher
 * to the aggregator. Progress is cosmetic and never gates load completion.
 */
export const WHISPER_MODEL_FILE_COUNT = 2;

/** 1s of silence at 16kHz mono — just enough to exercise the pipeline's WebGPU kernels during warm-up (R20 analog). */
const WARMUP_PCM = new Float32Array(16000);

/** The subset of `AutomaticSpeechRecognitionConfig` this engine ever passes to the pipeline call. */
interface AsrCallOptions {
  chunk_length_s: number;
  stride_length_s: number;
  return_timestamps: true;
  /** A Whisper language code, or `null` (`TranscribeOptions.language: 'auto'`) — CAUTION: transformers.js has no language detection; `null` hard-defaults to the `<|en|>` token ("TODO: Implement language detection" in its Whisper modeling source), which effectively translates non-English speech. */
  language: string | null;
  task: 'transcribe' | 'translate';
}

/**
 * The narrow shape this engine actually calls on a loaded ASR pipeline —
 * deliberately not the full `AutomaticSpeechRecognitionPipeline` class.
 * Both the real transformers.js pipeline instance and `whisperEngine.test.ts`'s
 * fake satisfy this without either depending on the other.
 */
export interface AsrPipelineLike {
  (pcm: Float32Array, options: AsrCallOptions): Promise<AutomaticSpeechRecognitionOutput>;
  dispose(): Promise<void>;
}

/** dtype config shape accepted by transformers.js' `pipeline()` `dtype` option, narrowed to what this engine ever passes. */
type DtypeConfig = Record<string, DataType>;

interface CreatePipelineOptions {
  device: 'webgpu';
  dtype: DtypeConfig;
  progress_callback: ProgressCallback;
}

/** Injectable pipeline factory — see this file's header comment for why. */
export type CreateAsrPipeline = (modelId: string, options: CreatePipelineOptions) => Promise<AsrPipelineLike>;

/**
 * Type-shim note: transformers.js'
 * `pipeline()` return type is a big union over every task (`AllTasks[T]`).
 * This is the one, documented cast down to the narrow `AsrPipelineLike`
 * shape this engine actually uses (callable + `dispose()`) — not a blanket
 * `any`. Every other call below (the `dtype`/`device`/`progress_callback`
 * options object, the call-site options) type-checks against the library's
 * own types with no cast.
 */
function asAsrPipeline(instance: unknown): AsrPipelineLike {
  return instance as AsrPipelineLike;
}

const defaultCreatePipeline: CreateAsrPipeline = async (modelId, options) =>
  asAsrPipeline(await pipeline('automatic-speech-recognition', modelId, options));

function assertSafeDecoderDtype(dtype: DtypeConfig): void {
  if (dtype.decoder_model_merged === BANNED_DECODER_DTYPE) {
    throw new Error(
      `WhisperEngine: decoder dtype '${BANNED_DECODER_DTYPE}' is banned on WebGPU ` +
        '(produces garbage output, transformers.js issue #1317)',
    );
  }
}

export class WhisperEngine implements TranscriptionEngine {
  #createPipeline: CreateAsrPipeline;
  #dtype: DtypeConfig;
  #asr: AsrPipelineLike | null = null;

  /**
   * `dtype` defaults to `DTYPE_CONFIG` (q4f16, KTD-W4(c) start). The worker
   * (composition root) is the one place that may pass `DTYPE_ENCODER_FP16`
   * for the U8 CH-de quality A/B — the engine itself stays dtype-agnostic
   * so the choice lives in exactly one place and unit tests stay pure.
   */
  constructor(options?: { createPipeline?: CreateAsrPipeline; dtype?: DtypeConfig }) {
    this.#createPipeline = options?.createPipeline ?? defaultCreatePipeline;
    this.#dtype = options?.dtype ?? DTYPE_CONFIG;
  }

  async load(onProgress: LoadProgressCallback): Promise<void> {
    assertSafeDecoderDtype(this.#dtype);

    // The shipped weights are plain `*.onnx` files (`encoder_model_fp16.onnx`
    // + `decoder_model_merged_q4f16.onnx`) — NOT `*.onnx_data` (only the unused
    // fp32 encoder has that). Pass a `.onnx` matcher so the aggregate actually
    // moves; the default matcher would keep the bar at 0 for the whole download.
    const reportProgress = createProgressAggregator(WHISPER_MODEL_FILE_COUNT, onProgress, (file) =>
      file.endsWith('.onnx'),
    );
    const progress_callback: ProgressCallback = (info) => {
      // Narrow transformers.js' `ProgressInfo` union down to the per-file
      // shape `progress.ts` understands; other event kinds (e.g. 'ready',
      // 'initiate') carry no file/byte progress and are ignored here.
      if ('file' in info && 'loaded' in info && 'total' in info) {
        reportProgress({ status: info.status, file: info.file, loaded: info.loaded, total: info.total });
      }
    };

    this.#asr = await this.#createPipeline(MODEL_ID, {
      device: 'webgpu',
      dtype: this.#dtype,
      progress_callback,
    });
  }

  async warmup(): Promise<void> {
    const asr = this.#requirePipeline('warmup');
    // Throwaway call purely to force WebGPU shader/kernel compilation now
    // (R20); the result is discarded.
    await asr(WARMUP_PCM, {
      chunk_length_s: this.#safeChunkLengthS(),
      stride_length_s: STRIDE_LENGTH_S,
      return_timestamps: true,
      language: 'de',
      task: 'transcribe',
    });
  }

  async transcribe(pcm: Float32Array, opts?: TranscribeOptions): Promise<TranscriptSegment[]> {
    // Guard empty input before touching the pipeline at all — there is
    // nothing to transcribe, and this also makes "engine not loaded yet"
    // a non-issue for callers that probe with an empty buffer.
    if (pcm.length === 0) return [];

    // `signal`: honoring pre-call abort is all this engine can do — a
    // single `pipeline()` call is one opaque `await` with no mid-flight
    // cancellation hook in transformers.js 4.2.0. Document this rather
    // than pretending to support real interruption.
    if (opts?.signal?.aborted) return [];

    const asr = this.#requirePipeline('transcribe');

    // Best-effort only (documented on `TranscribeOptions.onProgress`):
    // transformers.js' long-form transcription path is a single opaque
    // `await` with no clean per-chunk fraction hook (checked against the
    // installed 4.2.0 source for this unit). Reporting 0 before and 1
    // after is honest; fabricating a fake mid-progress tick would not be.
    // 'auto' → null. CAUTION: this is NOT per-window detection. transformers.js
    // has never implemented Whisper's language detection ("TODO: Implement
    // language detection" in modeling_whisper.js) — null falls back to the
    // <|en|> token, which on non-English audio effectively translates instead
    // of transcribing. Hence App.tsx defaults to 'de', not 'auto'.
    const language = opts?.language ?? 'de';
    opts?.onProgress?.(0);
    const out = await asr(pcm, {
      chunk_length_s: this.#safeChunkLengthS(),
      stride_length_s: STRIDE_LENGTH_S,
      return_timestamps: true,
      language: language === 'auto' ? null : language,
      task: opts?.task ?? 'transcribe',
    });
    opts?.onProgress?.(1);

    return mapOutputToSegments(out);
  }

  dispose(): void {
    void this.#asr?.dispose();
    this.#asr = null;
  }

  #requirePipeline(caller: string): AsrPipelineLike {
    if (!this.#asr) throw new Error(`WhisperEngine: load() must complete before ${caller}()`);
    return this.#asr;
  }

  /** Defensive clamp so an accidental future edit to `MAX_CHUNK_LENGTH_S` past 29 (issue #1358) can never reach the pipeline call. */
  #safeChunkLengthS(): number {
    return Math.min(MAX_CHUNK_LENGTH_S, 29);
  }
}

/**
 * Maps a raw ASR pipeline output to `TranscriptSegment[]`:
 * - No `chunks` (or empty) but non-blank `text` -> a single fallback
 *   segment spanning `[0, 0]` (no per-chunk timestamps available).
 * - No `chunks` and blank/empty `text` -> `[]`.
 * - Otherwise, each chunk maps to one segment. The known Whisper quirk
 *   that the LAST chunk's end timestamp can be `null` is handled by
 *   falling back to that chunk's own start (never NaN). Timestamps are
 *   forced monotonic non-decreasing across the returned array: each
 *   segment's `startMs` is clamped to be >= the previous segment's
 *   `startMs`, and `endMs` is clamped to be >= its own `startMs`.
 * - Chunks whose text is blank after trimming are dropped (they carry no
 *   content), but still count towards the monotonic timestamp tracking so
 *   a dropped chunk can't let a later chunk's clamp "go backwards".
 */
function mapOutputToSegments(out: AutomaticSpeechRecognitionOutput): TranscriptSegment[] {
  const chunks = out.chunks;
  if (!chunks || chunks.length === 0) {
    const text = out.text.trim();
    if (!text) return [];
    return [{ text, startMs: 0, endMs: 0 }];
  }

  const segments: TranscriptSegment[] = [];
  let previousStartMs = 0;

  for (const chunk of chunks) {
    const [startS, endSRaw] = chunk.timestamp;
    // Known Whisper long-form quirk: the last chunk's end timestamp can be
    // `null`. Fall back to this chunk's own start rather than propagating
    // `null`/NaN downstream.
    const endS = endSRaw ?? startS;

    let startMs = Math.round(startS * 1000);
    let endMs = Math.round(endS * 1000);

    startMs = Math.max(startMs, previousStartMs);
    endMs = Math.max(endMs, startMs);
    previousStartMs = startMs;

    const text = chunk.text.trim();
    if (!text) continue;

    segments.push({ text, startMs, endMs });
  }

  return segments;
}
