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
  createAudioContextDecoder,
  createDecodingContext,
  decodeAudioBlobTo16kMonoPcm,
  describeDecodingContext,
  MAX_DECODE_PEAK_BYTES,
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

/**
 * The length guard. A 2 h 40 interview is what finally explained the support
 * case: 95 MB of file, but ~1.8 GB of decoded PCM even at 16 kHz, which no
 * renderer allocates. Before this guard the browser ground for minutes and then
 * reported the failure as a codec problem — the guard turns that into an
 * immediate, honest answer.
 */
describe('decodeAudioBlobTo16kMonoPcm: the length guard', () => {
  /** A minimal but real mp4: `ftyp` + `moov`/`mvhd` carrying the duration. No trak, so the channel count stays unknown and the guard must assume stereo. */
  function mp4WithDuration(seconds: number): Blob {
    const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
    const box = (type: string, payload: number[]) => [...u32(payload.length + 8), ...ascii(type), ...payload];
    const mvhd = box('mvhd', [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(1000), ...u32(Math.round(seconds * 1000))]);
    return new Blob([new Uint8Array([...box('ftyp', ascii('isom')), ...box('moov', mvhd)])]);
  }

  /** Duration whose estimated stereo peak at 16 kHz equals `bytes` — derived from the constant so retuning the ceiling can't invalidate these tests. */
  function secondsForPeak(bytes: number): number {
    return bytes / (TARGET_SAMPLE_RATE * 4 * 3); // decoded (2 ch) + mono copy (1 ch)
  }

  it('rejects a recording whose decode would not fit, without calling the decoder at all', async () => {
    let decodeCalled = false;
    const deps: AudioDecodeDeps = {
      decode: async () => {
        decodeCalled = true;
        throw new Error('should not be reached');
      },
    };

    const error = await rejectionOf(
      decodeAudioBlobTo16kMonoPcm(mp4WithDuration(secondsForPeak(MAX_DECODE_PEAK_BYTES * 1.2)), deps),
    );

    expect(error.code).toBe('AUDIO_TOO_LONG');
    // Not calling the decoder is the point: that call is the multi-minute wait.
    expect(decodeCalled).toBe(false);
  });

  it('names the duration and the ceiling, so the message is actionable', async () => {
    const deps: AudioDecodeDeps = { decode: async () => { throw new Error('unreached'); } };

    const error = await rejectionOf(decodeAudioBlobTo16kMonoPcm(mp4WithDuration(9611), deps));

    expect(error.message).toContain('2:40:11');
    expect(error.message).toMatch(/GB/);
  });

  it('lets a recording that fits through untouched', async () => {
    const deps = depsFor(fakeDecoded(TARGET_SAMPLE_RATE, [new Float32Array(160)]));

    const pcm = await decodeAudioBlobTo16kMonoPcm(mp4WithDuration(secondsForPeak(MAX_DECODE_PEAK_BYTES * 0.4)), deps);

    expect(pcm.length).toBe(160);
  });

  it('does not guard what it cannot measure — no duration, no rejection', async () => {
    // Our own `.webm` recordings, a WAV, anything without an mvhd: guessing a
    // length would be worse than letting the real decode speak.
    const deps = depsFor(fakeDecoded(TARGET_SAMPLE_RATE, [new Float32Array(160)]));

    const pcm = await decodeAudioBlobTo16kMonoPcm(new Blob([new Uint8Array(64).fill(0x7a)]), deps);

    expect(pcm.length).toBe(160);
  });

  it('hands the already-parsed container to the diagnostics instead of re-reading the file', async () => {
    // The file in the support case was 95 MB. Re-reading it just to build the
    // report is waste the guard already did the work to avoid.
    const diagnose = vi.fn<AudioDecodeDiagnose>(async () => 'report');
    const deps: AudioDecodeDeps = {
      decode: async () => { throw new DOMException('Unable to decode audio data', 'EncodingError'); },
      diagnose,
    };

    await rejectionOf(decodeAudioBlobTo16kMonoPcm(mp4WithDuration(60), deps));

    const failure = diagnose.mock.calls[0][1];
    expect(failure.container?.container).toBe('mp4');
    expect(failure.container?.durationSeconds).toBeCloseTo(60, 3);
    // And the rate the estimate in the report must be computed against.
    expect(failure.decodeSampleRate).toBe(TARGET_SAMPLE_RATE);
  });
});

/**
 * The decoding context used to be `new AudioContext()`, whose sample rate the
 * OS dictates (48 kHz on the machine in the support report). Since
 * `decodeAudioData` resamples its result to the context's rate, decoding
 * through a 16 kHz `OfflineAudioContext` instead cuts the decoded buffer to a
 * third — and an `OfflineAudioContext` touches no audio hardware at all, so it
 * cannot fail on a machine without an output device.
 *
 * Extracted from the `globalThis` Andockpunkt precisely so this routing (which
 * context, in which order, and which code when each one fails) is testable
 * without a browser. Only the final `globalThis` default remains untested.
 */
describe('createDecodingContext: which context, and in which order', () => {
  function fakeContext(label: string) {
    return { label, decodeAudioData: async () => fakeDecoded(TARGET_SAMPLE_RATE, [new Float32Array(1)]) };
  }

  it('prefers an OfflineAudioContext at the 16 kHz target rate', () => {
    const calls: number[][] = [];
    const env = {
      OfflineAudioContext: class {
        decodeAudioData = async () => fakeDecoded(TARGET_SAMPLE_RATE, [new Float32Array(1)]);
        constructor(channels: number, length: number, sampleRate: number) {
          calls.push([channels, length, sampleRate]);
        }
      },
      AudioContext: class {
        decodeAudioData = async () => fakeDecoded(48000, [new Float32Array(1)]);
      },
    };

    createDecodingContext(env as never);

    // The rate is the whole point; channels/length are unused placeholders
    // for a rendering that never happens.
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toBe(TARGET_SAMPLE_RATE);
  });

  it('falls back to a hardware AudioContext when there is no OfflineAudioContext', () => {
    const context = createDecodingContext({ AudioContext: function () { return fakeContext('hardware'); } } as never);

    expect((context as unknown as { label: string }).label).toBe('hardware');
  });

  it('falls back to a hardware AudioContext when the browser refuses the 16 kHz rate', () => {
    // A rate outside a browser's accepted range must degrade to the old
    // behaviour, not fail the import over an optimisation.
    const env = {
      OfflineAudioContext: function () { throw new DOMException('rate out of range', 'NotSupportedError'); },
      AudioContext: function () { return fakeContext('hardware'); },
    };

    const context = createDecodingContext(env as never);

    expect((context as unknown as { label: string }).label).toBe('hardware');
  });

  it('honours the webkit-prefixed constructors', () => {
    const context = createDecodingContext({
      webkitOfflineAudioContext: function () { return fakeContext('webkit-offline'); },
    } as never);

    expect((context as unknown as { label: string }).label).toBe('webkit-offline');
  });

  it('is AUDIO_CONTEXT_UNAVAILABLE when the browser has no Web Audio at all', () => {
    let code: string | undefined;
    try {
      createDecodingContext({} as never);
    } catch (error) {
      code = (error as AudioDecodeError).code;
    }
    expect(code).toBe('AUDIO_CONTEXT_UNAVAILABLE');
  });

  it('is AUDIO_CONTEXT_FAILED when the hardware context itself refuses to open', () => {
    // The no-audio-output-device machine. Distinct from a bad codec, which is
    // the entire reason this code exists.
    let error: AudioDecodeError | undefined;
    try {
      createDecodingContext({
        AudioContext: function () { throw new DOMException('no audio device', 'NotSupportedError'); },
      } as never);
    } catch (thrown) {
      error = thrown as AudioDecodeError;
    }
    expect(error?.code).toBe('AUDIO_CONTEXT_FAILED');
    expect(error?.message).toContain('NotSupportedError');
  });
});

/**
 * The report's `audio context:` line has to describe the context that actually
 * DECODES. It used to open a hardware `AudioContext` of its own, which since
 * the move to a 16 kHz `OfflineAudioContext` reported a rate nothing in the
 * decode ever used — while the cost estimate two lines below it assumed the
 * real one. With no device available to test on, that line is the only channel
 * left for answering "did the 16 kHz take effect?", so it has to be right.
 */
describe('describeDecodingContext: reports the context that decodes', () => {
  it('reports the offline context’s rate, not the hardware one', async () => {
    const env = {
      OfflineAudioContext: function (_c: number, _l: number, rate: number) {
        return { sampleRate: rate, state: 'suspended' };
      },
      AudioContext: function () {
        return { sampleRate: 48000, state: 'running', close: async () => {} };
      },
    };

    const description = await describeDecodingContext(env as never);

    expect(description).toContain(String(TARGET_SAMPLE_RATE));
    expect(description).not.toContain('48000');
  });

  it('reports the hardware rate when the offline context is unavailable', async () => {
    const env = {
      AudioContext: function () {
        return { sampleRate: 44100, state: 'running', close: async () => {} };
      },
    };

    expect(await describeDecodingContext(env as never)).toContain('44100');
  });

  it('reports why no context could be opened, which is itself the diagnosis', async () => {
    const env = {
      AudioContext: function () {
        throw new DOMException('no audio device', 'NotSupportedError');
      },
    };

    const description = await describeDecodingContext(env as never);

    expect(description).toContain('NotSupportedError');
  });

  it('never throws, even with no Web Audio at all', async () => {
    await expect(describeDecodingContext({} as never)).resolves.toContain('unavailable');
  });
});

describe('decodeAudioBlobTo16kMonoPcm: what the diagnostics receive', () => {
  it('hands the decoding context’s description to the collector', async () => {
    const diagnose = vi.fn<AudioDecodeDiagnose>(async () => 'report');
    const deps: AudioDecodeDeps = {
      decode: async () => { throw new DOMException('Unable to decode audio data', 'EncodingError'); },
      diagnose,
    };

    await rejectionOf(decodeAudioBlobTo16kMonoPcm(nonEmptyBlob(), deps));

    // Present and non-empty; its exact content depends on the real environment,
    // which under Vitest has no Web Audio at all.
    expect(diagnose.mock.calls[0][1].audioContext).toBeTruthy();
  });
});

describe('createAudioContextDecoder: lifecycle', () => {
  it('closes a hardware AudioContext after decoding', async () => {
    let closed = false;
    const env = {
      AudioContext: function () {
        return {
          decodeAudioData: async () => fakeDecoded(48000, [new Float32Array(1)]),
          close: async () => { closed = true; },
        };
      },
    };

    await createAudioContextDecoder(env as never)(new ArrayBuffer(8));

    expect(closed).toBe(true);
  });

  it('tolerates an OfflineAudioContext, which has no close() to call', async () => {
    // `close()` lives on `AudioContext`, not on `BaseAudioContext` — an
    // OfflineAudioContext holds no hardware to release and has no such method.
    // Calling it unconditionally would throw AFTER a successful decode.
    const env = {
      OfflineAudioContext: function () {
        return { decodeAudioData: async () => fakeDecoded(TARGET_SAMPLE_RATE, [new Float32Array(4)]) };
      },
    };

    const decoded = await createAudioContextDecoder(env as never)(new ArrayBuffer(8));

    expect(decoded.length).toBe(4);
  });

  it('still closes the context when the decode itself rejects', async () => {
    let closed = false;
    const env = {
      AudioContext: function () {
        return {
          decodeAudioData: async () => { throw new DOMException('Unable to decode audio data', 'EncodingError'); },
          close: async () => { closed = true; },
        };
      },
    };

    await expect(createAudioContextDecoder(env as never)(new ArrayBuffer(8))).rejects.toThrow();
    expect(closed).toBe(true);
  });
});

