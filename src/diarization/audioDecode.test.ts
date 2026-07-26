// Realitätsgrenze: `decodeAudioData`/`AudioContext` are main-thread-browser
// only and don't exist in Node/Vitest at all (this repo's default 'node'
// test environment, see vitest.config.ts — Node's global `Blob` is real and
// good enough for the size/arrayBuffer() calls this module makes, but there
// is no real audio decoder to call). `FakeDecoder` below stands in for the
// injected `AudioDecoderLike` seam (see audioDecode.ts's header) so the real
// downmix/resample/error-handling logic runs unmocked against it. Real-codec
// decode correctness (Opus/AAC via a real `AudioContext`) stays a manual
// browser milestone.
import { describe, expect, it } from 'vitest';
import {
  AudioDecodeError,
  decodeAudioBlobTo16kMonoPcm,
  TARGET_SAMPLE_RATE,
  type AudioDecodeDeps,
  type DecodedAudioLike,
} from './audioDecode';

/** A `DecodedAudioLike` built from plain per-channel Float32 arrays — the exact shape a real `AudioBuffer` would structurally satisfy. */
function fakeDecoded(sampleRate: number, channels: Float32Array[]): DecodedAudioLike {
  const length = channels[0]?.length ?? 0;
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length,
    getChannelData: (channel: number) => channels[channel],
  };
}

function depsFor(decoded: DecodedAudioLike): AudioDecodeDeps {
  return { decode: async () => decoded };
}

function nonEmptyBlob(): Blob {
  return new Blob([new Uint8Array([1, 2, 3, 4])]);
}

describe('decodeAudioBlobTo16kMonoPcm: sample count/rate (test scenario 1)', () => {
  it('an already-16kHz mono decode passes through with the same sample count', async () => {
    const samples = new Float32Array(1600).fill(0.1); // 100ms @ 16kHz
    const deps = depsFor(fakeDecoded(TARGET_SAMPLE_RATE, [samples]));

    const pcm = await decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps);

    expect(pcm.length).toBe(1600);
    for (const sample of pcm) expect(sample).toBeCloseTo(0.1, 6);
  });

  it('a known input duration at 48kHz yields the correctly-ratioed 16kHz sample count', async () => {
    // 2 seconds @ 48kHz -> 2 seconds @ 16kHz
    const samples = new Float32Array(48000 * 2).fill(0.2);
    const deps = depsFor(fakeDecoded(48000, [samples]));

    const pcm = await decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps);

    expect(pcm.length).toBe(16000 * 2);
  });
});

describe('decodeAudioBlobTo16kMonoPcm: stereo downmix (test scenario 2)', () => {
  it('mixes stereo channels to mono as their arithmetic mean, not one channel dropped', async () => {
    const left = new Float32Array([1.0, 0.5, -1.0, 0.0]);
    const right = new Float32Array([0.0, 0.5, 1.0, 0.4]);
    const deps = depsFor(fakeDecoded(TARGET_SAMPLE_RATE, [left, right]));

    const pcm = await decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps);

    expect(pcm.length).toBe(4);
    expect(pcm[0]).toBeCloseTo(0.5, 6); // mean(1.0, 0.0)
    expect(pcm[1]).toBeCloseTo(0.5, 6); // mean(0.5, 0.5)
    expect(pcm[2]).toBeCloseTo(0.0, 6); // mean(-1.0, 1.0)
    expect(pcm[3]).toBeCloseTo(0.2, 6); // mean(0.0, 0.4)
    // Neither channel dropped: the result must differ from taking channel 0
    // or channel 1 alone whenever they disagree.
    expect(Array.from(pcm)).not.toEqual(Array.from(left));
    expect(Array.from(pcm)).not.toEqual(Array.from(right));
  });

  it('mixes three or more channels as the mean of all of them', async () => {
    const c0 = new Float32Array([0.9]);
    const c1 = new Float32Array([0.0]);
    const c2 = new Float32Array([0.3]);
    const deps = depsFor(fakeDecoded(TARGET_SAMPLE_RATE, [c0, c1, c2]));

    const pcm = await decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps);

    expect(pcm[0]).toBeCloseTo((0.9 + 0.0 + 0.3) / 3, 6);
  });
});

describe('decodeAudioBlobTo16kMonoPcm: resample to 16kHz (test scenario 3)', () => {
  it('resamples a 48kHz decode via resample.ts (length ratio correct)', async () => {
    const samples = new Float32Array(480); // matches resample.test.ts's known 480->160 ratio
    const deps = depsFor(fakeDecoded(48000, [samples]));

    const pcm = await decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps);

    expect(pcm.length).toBe(160);
  });

  it('resamples a 44.1kHz decode via resample.ts (length ratio correct)', async () => {
    const samples = new Float32Array(4410);
    const deps = depsFor(fakeDecoded(44100, [samples]));

    const pcm = await decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps);

    expect(pcm.length).toBe(1600); // same known ratio as resample.test.ts
  });

  it('a linear ramp keeps its shape through downmix + resample (mono-passthrough case)', async () => {
    const length = 480;
    const ramp = new Float32Array(length);
    for (let i = 0; i < length; i++) ramp[i] = i;
    const deps = depsFor(fakeDecoded(48000, [ramp]));

    const pcm = await decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps);

    const ratio = 48000 / 16000;
    for (let i = 0; i < pcm.length; i++) {
      const expected = Math.min(i * ratio, length - 1);
      expect(pcm[i]).toBeCloseTo(expected, 6);
    }
  });
});

describe('decodeAudioBlobTo16kMonoPcm: error path (test scenario 4)', () => {
  it('throws a typed AudioDecodeError for an empty (0-byte) blob, without calling decode', async () => {
    let decodeCalled = false;
    const deps: AudioDecodeDeps = {
      decode: async () => {
        decodeCalled = true;
        throw new Error('should not be reached');
      },
    };

    await expect(decodeAudioBlobTo16kMonoPcm(new Blob([]), deps)).rejects.toBeInstanceOf(AudioDecodeError);
    expect(decodeCalled).toBe(false);
  });

  it('wraps a decoder rejection (corrupt/unsupported blob) as a clean AudioDecodeError, not a raw throw', async () => {
    const deps: AudioDecodeDeps = {
      decode: async () => {
        throw new DOMException('Unable to decode audio data', 'EncodingError');
      },
    };

    await expect(decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps)).rejects.toBeInstanceOf(AudioDecodeError);
  });

  it('never hangs: a rejecting decode resolves the returned promise (rejected), not indefinitely pending', async () => {
    const deps: AudioDecodeDeps = { decode: async () => { throw new Error('corrupt'); } };
    await expect(decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps)).rejects.toThrow();
  });
});
