/**
 * U15 Fbank feature extraction (SD-1, KTD14) — a pure, model-free port of the
 * Kaldi/torchaudio `compliance.kaldi.fbank` the WeSpeaker embedding model
 * (`Wespeaker/wespeaker-voxceleb-resnet34-LM`) expects on its `feats` input.
 * WeSpeaker can't trace `torchaudio.compliance.kaldi.fbank` through ONNX
 * export, so the features are ALWAYS computed outside the graph — here.
 *
 * The parameters below are **this model's** fbank contract, verified against
 * the two reference implementations that drive the exact same ONNX export:
 * transformers.js `WeSpeakerFeatureExtractor`
 * (`node_modules/@huggingface/transformers/src/models/wespeaker/`) and
 * pyannote.audio's `ONNXWeSpeakerPretrainedSpeakerEmbedding.compute_fbank`.
 * Both agree: 16 kHz mono, waveform scaled to int16 range, 80 log-mel bins
 * (natural log, floor FLT_EPSILON), 25 ms frame / 10 ms shift, **Hamming**
 * window, 0.97 pre-emphasis, DC-offset removal, dither 0 (deterministic
 * inference), then per-utterance cepstral mean normalization (CMN, per mel bin
 * over all frames).
 *
 * **Two of those cost a hardware round each** (test 01) and are the reason
 * this header names its sources:
 *  - `waveformScale` (32768). The log-mel floor is ABSOLUTE (FLT_EPSILON), so
 *    feeding [-1, 1] audio instead of int16-range audio does not merely shift
 *    the features by a constant that CMN would cancel — it pushes whole regions
 *    of the spectrum under the floor, where they clamp to one constant value.
 *    Measured on speech-like input: 15 % of all log-mel values clamped at
 *    -26 dBFS, 21 % at -34 dBFS, 32 % at -46 dBFS — versus 0 % scaled. Those
 *    are exactly the quiet/high-frequency cells that carry speaker identity, so
 *    the embeddings go mushy and every voice clusters into one speaker.
 *  - The window. Kaldi's own default is Povey and WeSpeaker's training recipe
 *    leaves it there, but BOTH reference implementations for this export pass
 *    Hamming explicitly — so Hamming is what the deployed weights expect.
 *
 * Everything here is pure and unit-tested for STRUCTURE and internal
 * consistency (frame/bin counts, determinism, CMN zero-mean, energy landing
 * in the right mel band, nothing clamping at the floor). Exact bit-parity with
 * torchaudio's fbank is only confirmable against the real model on hardware —
 * the U15 milestone, like the ASR engine's U8.
 */

export interface FbankConfig {
  sampleRate: number;
  numMelBins: number;
  frameLengthMs: number;
  frameShiftMs: number;
  lowFreqHz: number;
  /** Upper mel edge; `0` means Nyquist (sampleRate / 2). */
  highFreqHz: number;
  preemphasis: number;
  removeDcOffset: boolean;
  /**
   * Factor applied to the [-1, 1] PCM before framing, to reach the int16 range
   * Kaldi assumes. NOT cosmetic: the log-mel floor is absolute, so an unscaled
   * waveform clamps a large share of the spectrum flat (see file header).
   */
  waveformScale: number;
  /** Apply per-utterance mean normalization (per mel bin, over all frames). */
  cmn: boolean;
}

/** The fbank contract of `Wespeaker/wespeaker-voxceleb-resnet34-LM` (see file header for the reference implementations). */
export const WESPEAKER_FBANK: FbankConfig = {
  sampleRate: 16000,
  numMelBins: 80,
  frameLengthMs: 25,
  frameShiftMs: 10,
  lowFreqHz: 20,
  highFreqHz: 0,
  preemphasis: 0.97,
  removeDcOffset: true,
  waveformScale: 32768, // 2^15 — Kaldi compliance: 16-bit signed integer range.
  cmn: true,
};

/** Row-major `[numFrames][numMelBins]` fbank matrix ready to tensor-ize as the model's `feats` input. */
export interface FbankResult {
  data: Float32Array;
  numFrames: number;
  numMelBins: number;
}

const EPSILON = 1.1920929e-7; // FLT_EPSILON — Kaldi's log floor, avoids log(0).

/** Kaldi mel scale: `1127 * ln(1 + f/700)`. */
function hzToMel(hz: number): number {
  return 1127 * Math.log(1 + hz / 700);
}

/**
 * Symmetric (`periodic=false`) Hamming window of length `n`:
 * `0.54 - 0.46·cos(2πi/(n-1))` — what both reference implementations pass for
 * this model, rather than Kaldi's Povey default (see file header).
 */
export function hammingWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  return w;
}

/**
 * Triangular mel filterbank: `numMelBins` filters over the `fftSize/2 + 1`
 * power-spectrum bins, peaks equally spaced in mel between `lowFreq` and
 * `highFreq`. Returned as `numMelBins` arrays of length `fftSize/2 + 1`.
 */
export function melFilterbank(
  numMelBins: number,
  fftSize: number,
  sampleRate: number,
  lowFreqHz: number,
  highFreqHz: number,
): Float64Array[] {
  const nyquist = sampleRate / 2;
  const highHz = highFreqHz > 0 ? highFreqHz : nyquist;
  const numSpectrumBins = fftSize / 2 + 1;
  const melLow = hzToMel(lowFreqHz);
  const melHigh = hzToMel(highHz);
  // numMelBins + 2 equally-spaced mel points → each filter uses a (left, center, right) triple.
  const melPoints = new Float64Array(numMelBins + 2);
  for (let i = 0; i < melPoints.length; i++) {
    melPoints[i] = melLow + ((melHigh - melLow) * i) / (numMelBins + 1);
  }

  // Center frequency (Hz) of each FFT spectrum bin.
  const binHz = (k: number) => (k * sampleRate) / fftSize;

  const filters: Float64Array[] = [];
  for (let m = 1; m <= numMelBins; m++) {
    const left = melPoints[m - 1];
    const center = melPoints[m];
    const right = melPoints[m + 1];
    const filter = new Float64Array(numSpectrumBins);
    for (let k = 0; k < numSpectrumBins; k++) {
      const mel = hzToMel(binHz(k));
      let weight = 0;
      if (mel >= left && mel <= center) weight = (mel - left) / (center - left);
      else if (mel > center && mel <= right) weight = (right - mel) / (right - center);
      filter[k] = weight;
    }
    filters.push(filter);
  }
  return filters;
}

/** Smallest power of two >= n. */
function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** In-place iterative radix-2 Cooley–Tukey FFT (`re`/`im` length must be a power of two). */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * Computes the log-mel fbank matrix for one 16 kHz mono PCM buffer. Returns an
 * empty matrix (0 frames) when the audio is shorter than one frame (Kaldi
 * `snip_edges=true`: no partial trailing frame).
 */
export function computeFbank(pcm: Float32Array, config: FbankConfig = WESPEAKER_FBANK): FbankResult {
  const frameLength = Math.round((config.frameLengthMs / 1000) * config.sampleRate);
  const frameShift = Math.round((config.frameShiftMs / 1000) * config.sampleRate);
  const numMelBins = config.numMelBins;

  if (pcm.length < frameLength) return { data: new Float32Array(0), numFrames: 0, numMelBins };

  const numFrames = 1 + Math.floor((pcm.length - frameLength) / frameShift);
  const fftSize = nextPow2(frameLength);
  const window = hammingWindow(frameLength);
  const filters = melFilterbank(numMelBins, fftSize, config.sampleRate, config.lowFreqHz, config.highFreqHz);

  const out = new Float32Array(numFrames * numMelBins);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameShift;

    // Copy frame, scaled to the int16 range Kaldi assumes (see file header).
    const frame = new Float64Array(frameLength);
    for (let i = 0; i < frameLength; i++) frame[i] = pcm[start + i] * config.waveformScale;

    // 1. Remove DC offset (subtract frame mean).
    if (config.removeDcOffset) {
      let mean = 0;
      for (let i = 0; i < frameLength; i++) mean += frame[i];
      mean /= frameLength;
      for (let i = 0; i < frameLength; i++) frame[i] -= mean;
    }

    // 2. Pre-emphasis (Kaldi order: highest index first, sample 0 uses itself).
    if (config.preemphasis !== 0) {
      for (let i = frameLength - 1; i > 0; i--) frame[i] -= config.preemphasis * frame[i - 1];
      frame[0] -= config.preemphasis * frame[0];
    }

    // 3. Povey window, zero-padded into the FFT buffers.
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < frameLength; i++) re[i] = frame[i] * window[i];

    // 4. FFT → power spectrum → mel → natural log (floored).
    fftInPlace(re, im);
    const numSpectrumBins = fftSize / 2 + 1;
    const power = new Float64Array(numSpectrumBins);
    for (let k = 0; k < numSpectrumBins; k++) power[k] = re[k] * re[k] + im[k] * im[k];

    for (let m = 0; m < numMelBins; m++) {
      const filter = filters[m];
      let energy = 0;
      for (let k = 0; k < numSpectrumBins; k++) energy += power[k] * filter[k];
      out[f * numMelBins + m] = Math.log(Math.max(energy, EPSILON));
    }
  }

  if (config.cmn) applyCmn(out, numFrames, numMelBins);
  return { data: out, numFrames, numMelBins };
}

/** Per-utterance CMN: subtract each mel bin's mean over all frames (in place). */
export function applyCmn(data: Float32Array, numFrames: number, numMelBins: number): void {
  if (numFrames === 0) return;
  for (let m = 0; m < numMelBins; m++) {
    let mean = 0;
    for (let f = 0; f < numFrames; f++) mean += data[f * numMelBins + m];
    mean /= numFrames;
    for (let f = 0; f < numFrames; f++) data[f * numMelBins + m] -= mean;
  }
}
