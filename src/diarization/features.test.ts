import { describe, expect, it } from 'vitest';
import { computeFbank, hammingWindow, melFilterbank, applyCmn, WESPEAKER_FBANK } from './features';

describe('hammingWindow', () => {
  it('matches the symmetric (periodic=false) Hamming both reference implementations use', () => {
    const w = hammingWindow(400);
    expect(w[0]).toBeCloseTo(0.08, 6); // 0.54 - 0.46, not 0 — this is what distinguishes it from Povey/Hann
    expect(w[399]).toBeCloseTo(0.08, 6);
    expect(w[199]).toBeGreaterThan(0.99);
    expect(w[100]).toBeCloseTo(w[299], 6); // symmetric
  });
});

describe('melFilterbank', () => {
  it('produces numMelBins triangular filters over fftSize/2+1 spectrum bins', () => {
    const filters = melFilterbank(80, 512, 16000, 20, 0);
    expect(filters).toHaveLength(80);
    expect(filters[0]).toHaveLength(257);
    // All weights non-negative and <= 1.
    for (const filter of filters) for (const w of filter) expect(w).toBeGreaterThanOrEqual(0);
  });

  it('places higher filters at higher frequency bins than lower filters', () => {
    const filters = melFilterbank(80, 512, 16000, 20, 0);
    const peakBin = (f: Float64Array) => f.indexOf(Math.max(...f));
    expect(peakBin(filters[70])).toBeGreaterThan(peakBin(filters[10]));
  });
});

describe('computeFbank', () => {
  it('returns [numFrames][80] with Kaldi snip-edges framing', () => {
    // 1s @ 16kHz, 25ms/10ms → 1 + floor((16000-400)/160) = 98 frames.
    const pcm = new Float32Array(16000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((2 * Math.PI * 440 * i) / 16000);
    const { data, numFrames, numMelBins } = computeFbank(pcm);
    expect(numMelBins).toBe(80);
    expect(numFrames).toBe(98);
    expect(data.length).toBe(98 * 80);
  });

  it('returns 0 frames when the audio is shorter than one frame', () => {
    expect(computeFbank(new Float32Array(100)).numFrames).toBe(0);
  });

  it('is deterministic (dither 0): identical input → identical output', () => {
    const pcm = new Float32Array(8000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 7) * 0.3;
    const a = computeFbank(pcm).data;
    const b = computeFbank(pcm).data;
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('after CMN each mel bin has ~zero mean over frames', () => {
    const pcm = new Float32Array(16000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((2 * Math.PI * 300 * i) / 16000) * 0.5;
    const { data, numFrames, numMelBins } = computeFbank(pcm);
    for (let m = 0; m < numMelBins; m++) {
      let mean = 0;
      for (let f = 0; f < numFrames; f++) mean += data[f * numMelBins + m];
      mean /= numFrames;
      expect(Math.abs(mean)).toBeLessThan(1e-4);
    }
  });

  it('does not clamp log-mel values at the floor for normal-level speech (the int16 scaling)', () => {
    // Harmonics + formants + a syllable envelope at -30 dBFS: ordinary mic level.
    const pcm = new Float32Array(16000);
    for (let i = 0; i < pcm.length; i++) {
      let s = 0;
      for (let h = 1; h < 40; h++) s += (Math.sin((2 * Math.PI * h * 120 * i) / 16000) / (h * h)) * (h === 6 || h === 10 ? 8 : 1);
      const env = 0.5 + 0.5 * Math.sin((2 * Math.PI * 4 * i) / 16000);
      pcm[i] = s * env * env * 0.03;
    }
    const floor = Math.log(1.1920929e-7);
    const clampedShare = (scale: number) => {
      const { data } = computeFbank(pcm, { ...WESPEAKER_FBANK, waveformScale: scale, cmn: false });
      let n = 0;
      for (const v of data) if (v <= floor + 1e-6) n++;
      return n / data.length;
    };
    // Production config: the model must never see a flat-clamped band.
    expect(clampedShare(WESPEAKER_FBANK.waveformScale)).toBe(0);
    // The contrast that makes the assertion above worth having: unscaled [-1,1]
    // audio clamps a fifth of the spectrum flat — the bug this pins down.
    expect(clampedShare(1)).toBeGreaterThan(0.1);
  });

  it('a pure tone concentrates energy in a stable mel band (pre-CMN energy peak is consistent across frames)', () => {
    const pcm = new Float32Array(16000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((2 * Math.PI * 1000 * i) / 16000);
    // Disable CMN to inspect raw log-mel energy peaks.
    const { data, numMelBins } = computeFbank(pcm, { ...WESPEAKER_FBANK, cmn: false });
    const peakBinOfFrame = (f: number) => {
      let best = 0;
      let bestVal = -Infinity;
      for (let m = 0; m < numMelBins; m++) {
        const v = data[f * numMelBins + m];
        if (v > bestVal) {
          bestVal = v;
          best = m;
        }
      }
      return best;
    };
    // The dominant mel bin should be the same in the middle frames (steady tone).
    expect(peakBinOfFrame(40)).toBe(peakBinOfFrame(60));
  });
});

describe('applyCmn', () => {
  it('subtracts the per-bin mean over frames', () => {
    // 2 frames, 2 bins: bin0 = [1,3] (mean 2), bin1 = [10,20] (mean 15).
    const data = new Float32Array([1, 10, 3, 20]);
    applyCmn(data, 2, 2);
    expect(Array.from(data)).toEqual([-1, -5, 1, 5]);
  });

  it('no-ops on zero frames', () => {
    const data = new Float32Array(0);
    expect(() => applyCmn(data, 0, 80)).not.toThrow();
  });
});
