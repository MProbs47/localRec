import { describe, expect, it } from 'vitest';
import { createProgressAggregator, type ModelFileProgressEvent } from './progress';

function progressTick(file: string, loaded: number, total: number): ModelFileProgressEvent {
  return { status: 'progress', file, loaded, total };
}

describe('createProgressAggregator (GPU-free model download progress aggregation)', () => {
  it('reports a monotonically increasing 0..1 fraction across ticks from multiple files', () => {
    const fractions: number[] = [];
    const report = createProgressAggregator(3, (fraction) => fractions.push(fraction));

    report(progressTick('audio_encoder_q4f16.onnx_data', 10, 100));
    report(progressTick('audio_encoder_q4f16.onnx_data', 50, 100));
    report(progressTick('embed_tokens_q4f16.onnx_data', 100, 100));
    report(progressTick('decoder_model_merged_q4f16.onnx_data', 30, 100));
    report(progressTick('decoder_model_merged_q4f16.onnx_data', 100, 100));
    report(progressTick('audio_encoder_q4f16.onnx_data', 100, 100));

    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    }
    expect(fractions.at(-1)).toBeCloseTo(1, 5);
  });

  it('ignores non-progress statuses and non-.onnx_data files (config/tokenizer downloads do not move the bar)', () => {
    const fractions: number[] = [];
    const report = createProgressAggregator(1, (fraction) => fractions.push(fraction));

    report({ status: 'initiate', file: 'config.json', loaded: 0, total: 0 });
    report({ status: 'progress', file: 'tokenizer.json', loaded: 500, total: 500 });
    report({ status: 'done', file: 'audio_encoder_q4f16.onnx_data', loaded: 100, total: 100 });

    expect(fractions).toEqual([]);
  });

  it('never regresses even when a later event reports a smaller loaded value for the same file (retry/out-of-order)', () => {
    const fractions: number[] = [];
    const report = createProgressAggregator(1, (fraction) => fractions.push(fraction));

    report(progressTick('a.onnx_data', 80, 100));
    report(progressTick('a.onnx_data', 20, 100));

    expect(fractions[1]).toBeGreaterThanOrEqual(fractions[0]);
    expect(fractions[1]).toBeCloseTo(0.8, 5);
  });

  it('clamps overall progress at 1 even with pathological per-file totals', () => {
    const fractions: number[] = [];
    const report = createProgressAggregator(2, (fraction) => fractions.push(fraction));

    report(progressTick('a.onnx_data', 100, 100));
    report(progressTick('b.onnx_data', 100, 100));
    report(progressTick('b.onnx_data', 100, 50)); // pathological (loaded > total); defend anyway

    expect(Math.max(...fractions)).toBeLessThanOrEqual(1);
  });

  it('ignores a file whose reported total is 0 (would otherwise divide by zero)', () => {
    const fractions: number[] = [];
    const report = createProgressAggregator(1, (fraction) => fractions.push(fraction));

    report(progressTick('a.onnx_data', 0, 0));

    expect(fractions).toEqual([]);
  });
});
