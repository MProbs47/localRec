/**
 * Pure PCM resampling used to guarantee 16 kHz mono audio reaches the model
 * (KTD10), independent of what sample rate the browser/OS actually hands
 * the `AudioContext` — browsers don't always honor
 * `new AudioContext({ sampleRate: 16000 })` exactly; hardware/OS can still
 * dictate the real rate. A silent mismatch here is a silent WER
 * regression (plan risk "Sample-Rate-Mismatch"), so the worklet must check
 * `sampleRate` against the target and resample whenever they differ.
 *
 * Linear interpolation, not a windowed-sinc/polyphase resampler: it's a
 * few dependency-free lines, and it is good enough here because (a) the
 * realistic inputs are 44.1/48 kHz down to 16 kHz — comfortably far from
 * aliasing-sensitive ratios — and (b) the model's own audio encoder does
 * further feature extraction downstream, so this step only needs to get
 * sample count and gross waveform shape right, not audiophile fidelity.
 * YAGNI: a higher-quality resampler is a real option only if a future WER
 * regression is ever traced back to this step specifically.
 *
 * DUPLICATED (not imported) into `worklet-processor.js` — see that file's
 * header comment for why (AudioWorklet module-loading is a separate,
 * fragile import graph from the app bundle). This copy is the one Vitest
 * actually exercises (`resample.test.ts`); keep both in sync if the math
 * changes.
 */
export function resampleLinear(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
): Float32Array {
  if (inputSampleRate <= 0 || outputSampleRate <= 0) {
    throw new RangeError('Sample rates must be positive');
  }
  if (inputSampleRate === outputSampleRate) {
    return input;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const sourcePosition = i * ratio;
    const indexLow = Math.floor(sourcePosition);
    const indexHigh = Math.min(indexLow + 1, input.length - 1);
    const fraction = sourcePosition - indexLow;
    output[i] = input[indexLow] + (input[indexHigh] - input[indexLow]) * fraction;
  }

  return output;
}
