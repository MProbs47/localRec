import { describe, expect, it } from 'vitest';
import { resampleLinear } from './resample';

describe('resampleLinear (48kHz -> 16kHz worklet resampling, KTD10)', () => {
  it('produces the correct output length for a 48kHz -> 16kHz ratio (480 -> ~160 samples)', () => {
    const input = new Float32Array(480);
    const output = resampleLinear(input, 48000, 16000);
    expect(output.length).toBe(160);
  });

  it('produces the correct output length for a 44.1kHz -> 16kHz ratio', () => {
    const input = new Float32Array(4410);
    const output = resampleLinear(input, 44100, 16000);
    // ratio = 44100/16000 = 2.75625; round(4410 / 2.75625) = 1600
    expect(output.length).toBe(1600);
  });

  it('returns the input unchanged (same reference) when rates already match', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    const output = resampleLinear(input, 16000, 16000);
    expect(output).toBe(input);
  });

  it('preserves a constant signal (value erhalten)', () => {
    const input = new Float32Array(480).fill(0.42);
    const output = resampleLinear(input, 48000, 16000);
    for (const sample of output) {
      expect(sample).toBeCloseTo(0.42, 6);
    }
  });

  it('keeps a linear ramp ~linear, matching the exact interpolated value at each output index', () => {
    // input[j] = j is itself an exact linear function, so linear
    // interpolation at ratio r must reproduce output[i] === i * r exactly
    // (modulo the boundary clamp at the very last input sample).
    const length = 480;
    const input = new Float32Array(length);
    for (let i = 0; i < length; i++) input[i] = i;

    const ratio = 48000 / 16000;
    const output = resampleLinear(input, 48000, 16000);

    for (let i = 0; i < output.length; i++) {
      const expected = Math.min(i * ratio, length - 1);
      expect(output[i]).toBeCloseTo(expected, 6);
    }
  });

  it('rejects non-positive sample rates', () => {
    const input = new Float32Array(10);
    expect(() => resampleLinear(input, 0, 16000)).toThrow(RangeError);
    expect(() => resampleLinear(input, 48000, -1)).toThrow(RangeError);
  });
});
