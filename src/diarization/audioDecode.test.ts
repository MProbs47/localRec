// Realitätsgrenze: `decodeAudioData`/`AudioContext` are main-thread-browser
// only and don't exist in Node/Vitest at all (this repo's default 'node'
// test environment, see vitest.config.ts — Node's global `Blob` is real and
// good enough for the size/arrayBuffer() calls this module makes, but there
// is no real audio decoder to call). `FakeDecoder` below stands in for the
// injected `AudioDecoderLike` seam (see audioDecode.ts's header) so the real
// downmix/resample/error-handling logic runs unmocked against it. Real-codec
// decode correctness (Opus/AAC via a real `AudioContext`) stays a manual
// browser milestone.
import { describe, expect, it, vi } from 'vitest';
import {
  AUDIO_DECODE_CODE_DESCRIPTIONS,
  AudioDecodeError,
  decodeAudioBlobTo16kMonoPcm,
  TARGET_SAMPLE_RATE,
  type AudioDecodeDeps,
  type AudioDecodeDiagnose,
  type AudioDecodeErrorCode,
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

/** Awaits a rejection and narrows it to this module's own error type — every assertion below reads its `code`/`details`/`cause`. */
async function rejectionOf(promise: Promise<unknown>): Promise<AudioDecodeError> {
  const thrown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(AudioDecodeError);
  return thrown as AudioDecodeError;
}

async function codeOf(promise: Promise<unknown>): Promise<AudioDecodeErrorCode> {
  return (await rejectionOf(promise)).code;
}

/**
 * These four used to be ONE message ("unsupported or corrupt data"), and that
 * cost a real support case its diagnosis — a customer's Edge produced it for a
 * file their own audio player played fine, with no way to tell a missing codec
 * from an `AudioContext` that never opened. The codes below are the fix, so
 * each one is pinned to the failure it is supposed to name.
 */
describe('decodeAudioBlobTo16kMonoPcm: error codes are distinct per cause', () => {
  it('a 0-byte file is AUDIO_EMPTY_FILE, not a decode failure', async () => {
    const deps: AudioDecodeDeps = { decode: async () => { throw new Error('should not be reached'); } };
    expect(await codeOf(decodeAudioBlobTo16kMonoPcm(new Blob([]), deps))).toBe('AUDIO_EMPTY_FILE');
  });

  it('an unreadable blob is AUDIO_READ_FAILED, not a decode failure', async () => {
    // A `File` whose backing bytes vanished (moved/deleted after picking) —
    // `arrayBuffer()` rejects before any decoder is involved.
    const blob = { size: 42, type: 'audio/mp4', arrayBuffer: async () => { throw new DOMException('not found', 'NotFoundError'); } } as unknown as Blob;
    const deps: AudioDecodeDeps = { decode: async () => { throw new Error('should not be reached'); } };

    expect(await codeOf(decodeAudioBlobTo16kMonoPcm(blob, deps))).toBe('AUDIO_READ_FAILED');
  });

  it('a rejected decode is AUDIO_DECODE_REJECTED and keeps the DOMException name in its message', async () => {
    const deps: AudioDecodeDeps = {
      decode: async () => { throw new DOMException('Unable to decode audio data', 'EncodingError'); },
    };

    const error = await rejectionOf(decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps));

    expect(error.code).toBe('AUDIO_DECODE_REJECTED');
    // The name is the half that says WHAT went wrong; losing it was the
    // original defect.
    expect(error.message).toContain('EncodingError');
    expect(error.cause).toBeInstanceOf(DOMException);
  });

  it("keeps a nested AudioDecodeError's own code instead of relabelling it as a decode rejection", async () => {
    // `createAudioContextDecoder` constructs its AudioContext INSIDE the
    // decoder, so a machine with no audio output device throws from in there —
    // and used to be reported as a corrupt file.
    const deps: AudioDecodeDeps = {
      decode: async () => {
        throw new AudioDecodeError('AUDIO_CONTEXT_FAILED', 'NotSupportedError: no audio device');
      },
    };

    expect(await codeOf(decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps))).toBe('AUDIO_CONTEXT_FAILED');
  });

  it('a decode that resolves with nothing is AUDIO_DECODE_EMPTY, not a silent empty transcript', async () => {
    const deps = depsFor(fakeDecoded(TARGET_SAMPLE_RATE, [new Float32Array(0)]));
    expect(await codeOf(decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps))).toBe('AUDIO_DECODE_EMPTY');
  });

  it('a zero sample rate is AUDIO_DECODE_EMPTY rather than a divide-by-zero resample', async () => {
    const deps = depsFor(fakeDecoded(0, [new Float32Array(16)]));
    expect(await codeOf(decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps))).toBe('AUDIO_DECODE_EMPTY');
  });

  it('every code has a short English description for the error screen', () => {
    const codes: AudioDecodeErrorCode[] = [
      'AUDIO_EMPTY_FILE',
      'AUDIO_READ_FAILED',
      'AUDIO_CONTEXT_UNAVAILABLE',
      'AUDIO_CONTEXT_FAILED',
      'AUDIO_DECODE_REJECTED',
      'AUDIO_DECODE_EMPTY',
    ];
    for (const code of codes) {
      const description = AUDIO_DECODE_CODE_DESCRIPTIONS[code];
      expect(description, code).toBeTruthy();
      // One line, display-sized: the screen has room for about three.
      expect(description.length, code).toBeLessThanOrEqual(80);
      expect(description, code).not.toContain('\n');
    }
  });
});

describe('decodeAudioBlobTo16kMonoPcm: the diagnostics hook', () => {
  it('attaches the collected report to the thrown error, with the blob and the failing code', async () => {
    const diagnose = vi.fn<AudioDecodeDiagnose>(async () => 'localRec audio decode report\ncode: AUDIO_DECODE_REJECTED');
    const blob = nonEmptyBlob();
    const deps: AudioDecodeDeps = {
      decode: async () => { throw new DOMException('Unable to decode audio data', 'EncodingError'); },
      diagnose,
    };

    const error = await rejectionOf(decodeAudioBlobTo16kMonoPcm(blob, deps));

    expect(error.details).toContain('localRec audio decode report');
    expect(diagnose).toHaveBeenCalledTimes(1);
    // The blob, NOT the ArrayBuffer: `decodeAudioData` detaches the buffer it
    // is handed, so the collector has to re-read from the file itself.
    expect(diagnose.mock.calls[0][0]).toBe(blob);
    expect(diagnose.mock.calls[0][1].code).toBe('AUDIO_DECODE_REJECTED');
  });

  it('never lets a broken collector mask the real failure', async () => {
    const deps: AudioDecodeDeps = {
      decode: async () => { throw new DOMException('Unable to decode audio data', 'EncodingError'); },
      diagnose: async () => { throw new Error('diagnostics itself is buggy'); },
    };

    const error = await rejectionOf(decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps));

    expect(error).toBeInstanceOf(AudioDecodeError);
    expect(error.code).toBe('AUDIO_DECODE_REJECTED');
    expect(error.details).toBeUndefined();
  });

  it('is optional — without it the coded error still arrives, just report-less', async () => {
    const deps: AudioDecodeDeps = { decode: async () => { throw new Error('corrupt'); } };

    const error = await rejectionOf(decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps));

    expect(error.code).toBe('AUDIO_DECODE_REJECTED');
    expect(error.details).toBeUndefined();
  });

  it('is not called on the happy path', async () => {
    const diagnose = vi.fn<AudioDecodeDiagnose>(async () => 'never');
    const deps: AudioDecodeDeps = { ...depsFor(fakeDecoded(TARGET_SAMPLE_RATE, [new Float32Array(160)])), diagnose };

    await decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps);

    expect(diagnose).not.toHaveBeenCalled();
  });
});
