import { describe, expect, it } from 'vitest';
import type { AutomaticSpeechRecognitionOutput } from '@huggingface/transformers';
import {
  DTYPE_CONFIG,
  MAX_CHUNK_LENGTH_S,
  WhisperEngine,
  type AsrPipelineLike,
  type CreateAsrPipeline,
} from './whisperEngine';

// Manual milestone (per plan U1/U8): real WebGPU model load, warm-up, and
// transcription quality/RTF are NOT exercised by any automated test in this
// repo — there is no GPU, model, or network access in CI/this environment.
// Everything below drives `WhisperEngine` with an INJECTED fake pipeline
// (see `whisperEngine.ts`'s `CreateAsrPipeline` seam); real inference
// quality is checked by hand on target hardware (U8), not here.

type AsrCallOptions = Parameters<AsrPipelineLike>[1];

/**
 * Builds an injectable `createPipeline` fake whose call handler is supplied
 * by the test, plus captured-call spies so tests can assert on exactly what
 * `WhisperEngine` configured the pipeline/call with.
 */
function makeFakePipelineFactory(handler: (pcm: Float32Array, options: AsrCallOptions) => Promise<unknown>) {
  let pipelineOptions: { dtype: Record<string, string> } | undefined;
  let lastCallOptions: AsrCallOptions | undefined;
  let called = false;

  const createPipeline: CreateAsrPipeline = async (_modelId, options) => {
    pipelineOptions = options;
    const asr = async (pcm: Float32Array, callOptions: AsrCallOptions) => {
      called = true;
      lastCallOptions = callOptions;
      return handler(pcm, callOptions) as Promise<AutomaticSpeechRecognitionOutput>;
    };
    return Object.assign(asr, { dispose: async () => {} }) as AsrPipelineLike;
  };

  return {
    createPipeline,
    wasCalled: () => called,
    getPipelineOptions: () => pipelineOptions,
    getLastCallOptions: () => lastCallOptions,
  };
}

describe('WhisperEngine (KTD-W4 guardrails + chunk->segment mapping, fake pipeline)', () => {
  it('maps known chunk output to correctly ordered, monotonic TranscriptSegments', async () => {
    const { createPipeline } = makeFakePipelineFactory(async () => ({
      text: 'a b',
      chunks: [
        { timestamp: [0, 8], text: 'a' },
        { timestamp: [8, 11], text: 'b' },
      ],
    }));
    const engine = new WhisperEngine({ createPipeline });
    await engine.load(() => {});

    const segments = await engine.transcribe(new Float32Array(16000));

    expect(segments).toEqual([
      { text: 'a', startMs: 0, endMs: 8000 },
      { text: 'b', startMs: 8000, endMs: 11000 },
    ]);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].startMs).toBeGreaterThanOrEqual(segments[i - 1].startMs);
    }
  });

  it('falls back sanely (no NaN/null) when the last chunk end timestamp is null', async () => {
    const { createPipeline } = makeFakePipelineFactory(async () => ({
      text: 'a b',
      chunks: [
        { timestamp: [0, 8], text: 'a' },
        // The real transformers.js runtime can return `null` for the last
        // chunk's end timestamp even though the library's own `.d.ts`
        // over-promises `[number, number]` — hence the cast.
        { timestamp: [10, null], text: 'b' },
      ],
    }) as unknown as AutomaticSpeechRecognitionOutput);
    const engine = new WhisperEngine({ createPipeline });
    await engine.load(() => {});

    const segments = await engine.transcribe(new Float32Array(16000));

    expect(segments[1]).toEqual({ text: 'b', startMs: 10000, endMs: 10000 });
    expect(Number.isNaN(segments[1].endMs)).toBe(false);
    expect(Number.isNaN(segments[1].startMs)).toBe(false);
  });

  it('never configures chunk_length_s above 29 or a q8 decoder dtype (KTD-W4)', async () => {
    const { createPipeline, getPipelineOptions, getLastCallOptions } = makeFakePipelineFactory(async () => ({
      text: '',
      chunks: [],
    }));
    const engine = new WhisperEngine({ createPipeline });
    await engine.load(() => {});
    await engine.transcribe(new Float32Array(16000));

    expect(MAX_CHUNK_LENGTH_S).toBeLessThanOrEqual(29);
    expect(DTYPE_CONFIG.decoder_model_merged).not.toBe('q8');
    // Keys MUST be the ONNX session names transformers.js resolves dtype by
    // (`encoder_model`/`decoder_model_merged`) — the wrong keys silently
    // fall back to fp32, which is the multi-GB download that broke first run.
    expect(getPipelineOptions()?.dtype).toHaveProperty('encoder_model');
    expect(getPipelineOptions()?.dtype).toHaveProperty('decoder_model_merged');

    expect(getLastCallOptions()?.chunk_length_s).toBeLessThanOrEqual(29);
    expect(getPipelineOptions()?.dtype.decoder_model_merged).not.toBe('q8');
    expect(getPipelineOptions()?.dtype).toEqual(DTYPE_CONFIG);
  });

  it('ships the U8-decided default dtype: fp16 encoder + q4f16 decoder', async () => {
    // U8's CH-de A/B settled on an fp16 encoder (q4f16 was too lossy on
    // Swiss-German); the decoder stays q4f16 (never q8 — KTD-W4(a)).
    expect(DTYPE_CONFIG.encoder_model).toBe('fp16');
    expect(DTYPE_CONFIG.decoder_model_merged).toBe('q4f16');
  });

  it('passes an explicit constructor dtype through to the pipeline (injection seam)', async () => {
    const { createPipeline, getPipelineOptions } = makeFakePipelineFactory(async () => ({ text: '', chunks: [] }));
    // The dtype is constructor-injectable so the composition root (the worker)
    // owns the choice and tests can pin it. Prove an override actually reaches
    // the pipeline factory rather than the default being silently used.
    const override = { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' } as const;
    const engine = new WhisperEngine({ createPipeline, dtype: override });
    await engine.load(() => {});

    expect(getPipelineOptions()?.dtype).toEqual(override);
    expect(getPipelineOptions()?.dtype.encoder_model).toBe('q4f16');
  });

  it('returns [] for empty input without ever invoking the pipeline', async () => {
    const { createPipeline, wasCalled } = makeFakePipelineFactory(async () => ({ text: 'should not be reached' }));
    const engine = new WhisperEngine({ createPipeline });
    await engine.load(() => {});

    const segments = await engine.transcribe(new Float32Array(0));

    expect(segments).toEqual([]);
    expect(wasCalled()).toBe(false);
  });

  it('returns a single [0,0] fallback segment when chunks are missing but text is present', async () => {
    const { createPipeline } = makeFakePipelineFactory(async () => ({ text: '  hallo welt  ' }));
    const engine = new WhisperEngine({ createPipeline });
    await engine.load(() => {});

    const segments = await engine.transcribe(new Float32Array(16000));

    expect(segments).toEqual([{ text: 'hallo welt', startMs: 0, endMs: 0 }]);
  });

  it('returns [] when chunks are missing and text is blank', async () => {
    const { createPipeline } = makeFakePipelineFactory(async () => ({ text: '   ' }));
    const engine = new WhisperEngine({ createPipeline });
    await engine.load(() => {});

    const segments = await engine.transcribe(new Float32Array(16000));

    expect(segments).toEqual([]);
  });

  it('drops blank-text chunks while keeping later timestamps monotonic', async () => {
    const { createPipeline } = makeFakePipelineFactory(async () => ({
      text: 'a b',
      chunks: [
        { timestamp: [0, 5], text: 'a' },
        { timestamp: [5, 6], text: '   ' },
        { timestamp: [6, 9], text: 'b' },
      ],
    }));
    const engine = new WhisperEngine({ createPipeline });
    await engine.load(() => {});

    const segments = await engine.transcribe(new Float32Array(16000));

    expect(segments).toEqual([
      { text: 'a', startMs: 0, endMs: 5000 },
      { text: 'b', startMs: 6000, endMs: 9000 },
    ]);
  });

  it('honors a pre-aborted signal without invoking the pipeline', async () => {
    const { createPipeline, wasCalled } = makeFakePipelineFactory(async () => ({ text: 'should not be reached' }));
    const engine = new WhisperEngine({ createPipeline });
    await engine.load(() => {});

    const controller = new AbortController();
    controller.abort();

    const segments = await engine.transcribe(new Float32Array(16000), { signal: controller.signal });

    expect(segments).toEqual([]);
    expect(wasCalled()).toBe(false);
  });

  it('rejects transcribe()/warmup() before load()', async () => {
    const { createPipeline } = makeFakePipelineFactory(async () => ({ text: '' }));
    const engine = new WhisperEngine({ createPipeline });

    await expect(engine.warmup()).rejects.toThrow();
    await expect(engine.transcribe(new Float32Array(16000))).rejects.toThrow();
  });

  it('resolves load() -> warmup() -> transcribe() and aggregates progress_callback events to a final 1', async () => {
    // Simulates the real pipeline() call reporting both shipped `.onnx` weight
    // files (WHISPER_MODEL_FILE_COUNT = 2, fp16 encoder + merged q4f16 decoder)
    // fully downloaded — the actual filenames the shipped set ships (NOT
    // `.onnx_data`), which is why `WhisperEngine` passes a `.onnx` matcher to
    // `createProgressAggregator`.
    const createPipeline: CreateAsrPipeline = async (_modelId, options) => {
      options.progress_callback({
        status: 'progress',
        name: 'onnx-community/whisper-large-v3-turbo',
        file: 'onnx/encoder_model_fp16.onnx',
        progress: 100,
        loaded: 100,
        total: 100,
      });
      options.progress_callback({
        status: 'progress',
        name: 'onnx-community/whisper-large-v3-turbo',
        file: 'onnx/decoder_model_merged_q4f16.onnx',
        progress: 100,
        loaded: 100,
        total: 100,
      });
      const asr = async () => ({ text: 'ok' }) satisfies AutomaticSpeechRecognitionOutput;
      return Object.assign(asr, { dispose: async () => {} }) as AsrPipelineLike;
    };
    const engine = new WhisperEngine({ createPipeline });
    const ticks: number[] = [];

    await engine.load((fraction) => ticks.push(fraction));
    await expect(engine.warmup()).resolves.toBeUndefined();
    await expect(engine.transcribe(new Float32Array(16000))).resolves.toEqual([{ text: 'ok', startMs: 0, endMs: 0 }]);

    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[ticks.length - 1]).toBe(1);
  });

  it('disposes the underlying pipeline and becomes unusable afterward', async () => {
    let disposeCalled = false;
    const createPipeline: CreateAsrPipeline = async () => {
      const asr = async () => ({ text: '' }) satisfies AutomaticSpeechRecognitionOutput;
      return Object.assign(asr, {
        dispose: async () => {
          disposeCalled = true;
        },
      }) as AsrPipelineLike;
    };
    const engine = new WhisperEngine({ createPipeline });
    await engine.load(() => {});

    engine.dispose();

    expect(disposeCalled).toBe(true);
    await expect(engine.transcribe(new Float32Array(16000))).rejects.toThrow();
    await expect(engine.warmup()).rejects.toThrow();
  });

  describe('language option (owner decision: dropdown + Auto)', () => {
    const emptyOutput = async () => ({ text: '', chunks: [] });

    it("passes an explicit language through, and defaults to 'de' when the caller says nothing", async () => {
      const fake = makeFakePipelineFactory(emptyOutput);
      const engine = new WhisperEngine({ createPipeline: fake.createPipeline });
      await engine.load(() => {});

      await engine.transcribe(new Float32Array(16000), { language: 'it' });
      expect(fake.getLastCallOptions()?.language).toBe('it');

      await engine.transcribe(new Float32Array(16000));
      expect(fake.getLastCallOptions()?.language).toBe('de');
    });

    it("maps 'auto' to a null language — transformers.js' own per-window detection", async () => {
      const fake = makeFakePipelineFactory(emptyOutput);
      const engine = new WhisperEngine({ createPipeline: fake.createPipeline });
      await engine.load(() => {});

      await engine.transcribe(new Float32Array(16000), { language: 'auto' });
      // Exactly null, not undefined/'auto': null is the value transformers.js'
      // generation config understands as "detect the language".
      expect(fake.getLastCallOptions()?.language).toBeNull();
    });
  });
});
