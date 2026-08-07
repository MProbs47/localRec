/**
 * The whole point of `audioDiagnostics.ts` is to be believable on a machine
 * nobody can inspect, so the parsing it does has to be provably right HERE,
 * against bytes built by hand — the "real" input that motivated it (a
 * customer's `.m4a`) is exactly what a test can never have.
 *
 * `buildMp4` below assembles real ISO-BMFF box trees (including the awkward
 * cases: `moov` sitting AFTER a huge `mdat`, a 64-bit `mdat` header, a
 * truncated box) so the walk is exercised on structure rather than on a
 * fixture blob. `MediaSource`/`AudioContext` are injected (see that file's
 * header) — no browser globals are touched.
 */
import { describe, expect, it } from 'vitest';
import {
  describeThrown,
  estimateDecodeBytes,
  formatDiagnosticsReport,
  probeCodecSupport,
  sniffContainer,
  type ContainerInfo,
} from './audioDiagnostics';

// --- byte builders --------------------------------------------------------

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** One ISO-BMFF box: 4-byte size (header included) + 4-char type + payload. */
function box(type: string, payload: number[]): number[] {
  return [...u32(payload.length + 8), ...ascii(type), ...payload];
}

/** A box declaring 64-bit largesize — how a >4 GiB `mdat` is written, and a case the walk must not misread. */
function box64(type: string, payload: number[]): number[] {
  const size = payload.length + 16;
  return [...u32(1), ...ascii(type), ...u32(0), ...u32(size), ...payload];
}

/**
 * An `esds` box for the given `objectTypeIndication` and AudioSpecificConfig
 * bytes, descriptor lengths included — the chain `parseEsds` walks:
 * ES_Descriptor(0x03) → DecoderConfigDescriptor(0x04) → DecSpecificInfo(0x05).
 */
function esds(objectTypeIndication: number, audioSpecificConfig: number[]): number[] {
  const decSpecific = [0x05, audioSpecificConfig.length, ...audioSpecificConfig];
  const decoderConfig = [
    0x04,
    13 + decSpecific.length,
    objectTypeIndication,
    0x15, // streamType/upStream/reserved
    0x00, 0x00, 0x00, // bufferSizeDB
    ...u32(128000), // maxBitrate
    ...u32(128000), // avgBitrate
    ...decSpecific,
  ];
  const esDescriptor = [0x03, 3 + decoderConfig.length, 0x00, 0x01, 0x00, ...decoderConfig];
  return box('esds', [0x00, 0x00, 0x00, 0x00, ...esDescriptor]);
}

/** AAC AudioSpecificConfig: 5-bit audioObjectType, then sampling-frequency index / channel config (irrelevant here). */
function audioSpecificConfig(audioObjectType: number): number[] {
  if (audioObjectType < 31) return [(audioObjectType << 3) | 0x01, 0x10];
  const escaped = audioObjectType - 32;
  return [(31 << 3) | (escaped >>> 3), ((escaped & 0x07) << 5) | 0x02, 0x10];
}

/**
 * A minimal AudioSampleEntry of the given format, with optional child boxes
 * (an `esds` for `mp4a`). The 28 fixed bytes are laid out for real, because
 * `channelcount` (payload+16) and `samplerate` (payload+24, 16.16 fixed) are
 * now read: reserved(6) dref(2) reserved(8) channelcount(2) samplesize(2)
 * pre_defined(2) reserved(2) samplerate(4).
 */
function sampleEntry(
  format: string,
  children: number[] = [],
  audio: { channels?: number; sampleRate?: number } = {},
): number[] {
  const channels = audio.channels ?? 0;
  const sampleRate = audio.sampleRate ?? 0;
  const fixedFields = [
    0, 0, 0, 0, 0, 0, // reserved
    0, 1, // data_reference_index
    0, 0, 0, 0, 0, 0, 0, 0, // reserved
    (channels >>> 8) & 0xff, channels & 0xff,
    0, 16, // samplesize
    0, 0, // pre_defined
    0, 0, // reserved
    (sampleRate >>> 8) & 0xff, sampleRate & 0xff, 0, 0, // samplerate as 16.16
  ];
  return box(format, [...fixedFields, ...children]);
}

/**
 * A VisualSampleEntry — needed because its `width`/`height` land at exactly
 * the offsets an AudioSampleEntry keeps `channelcount`/`samplerate` in
 * (payload+24/+26 vs. +16/+24). The sniffer must not mistake 1920×1080 for a
 * 1920-channel track, and only a real video entry proves that.
 */
function visualSampleEntry(format: string, width: number, height: number): number[] {
  return box(format, [
    0, 0, 0, 0, 0, 0, // reserved
    0, 1, // data_reference_index
    0, 0, 0, 0, // pre_defined + reserved
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // pre_defined[3]
    (width >>> 8) & 0xff, width & 0xff,
    (height >>> 8) & 0xff, height & 0xff,
  ]);
}

function stsd(entries: number[][]): number[] {
  return box('stsd', [0x00, 0x00, 0x00, 0x00, ...u32(entries.length), ...entries.flat()]);
}

/** `moov` → `trak` → `mdia` → `minf` → `stbl` → `stsd`, i.e. the real nesting the walk has to descend. */
function trak(entries: number[][]): number[] {
  return box('trak', box('mdia', box('minf', box('stbl', stsd(entries)))));
}

/** `mvhd`, the box that carries the media duration — version 0 (32-bit times) or version 1 (64-bit). */
function mvhd(timescale: number, duration: number, version: 0 | 1 = 0): number[] {
  if (version === 0) {
    return box('mvhd', [0x00, 0x00, 0x00, 0x00, ...u32(0), ...u32(0), ...u32(timescale), ...u32(duration)]);
  }
  const high = Math.floor(duration / 2 ** 32);
  return box('mvhd', [
    0x01, 0x00, 0x00, 0x00,
    ...u32(0), ...u32(0), // creation_time (64-bit)
    ...u32(0), ...u32(0), // modification_time (64-bit)
    ...u32(timescale),
    ...u32(high), ...u32(duration - high * 2 ** 32),
  ]);
}

function buildMp4(
  brand: string,
  traks: number[][],
  options: { moovLast?: boolean; mdat?: number[]; moovExtras?: number[] } = {},
): Uint8Array {
  const ftyp = box('ftyp', [...ascii(brand), ...u32(512), ...ascii('isomiso2')]);
  const mdat = options.mdat ?? box('mdat', new Array(64).fill(0x11));
  const moov = box('moov', [...(options.moovExtras ?? []), ...traks.flat()]);
  return new Uint8Array(options.moovLast ? [...ftyp, ...mdat, ...moov] : [...ftyp, ...moov, ...mdat]);
}

// --- container sniffing ---------------------------------------------------

describe('sniffContainer: mp4 family', () => {
  it('reports the brand and the audio track fourcc for an AAC-LC m4a', () => {
    const bytes = buildMp4('M4A ', [trak([sampleEntry('mp4a', esds(0x40, audioSpecificConfig(2)))])]);

    const info = sniffContainer(bytes);

    expect(info.container).toBe('mp4');
    expect(info.brand).toBe('M4A ');
    expect(info.sampleFormats).toEqual(['mp4a']);
    expect(info.objectTypeIndication).toBe(0x40);
    expect(info.audioObjectType).toBe(2); // AAC-LC
    expect(info.notes).toEqual([]);
  });

  it('names every track format of a video mp4, video and audio alike', () => {
    const bytes = buildMp4('isom', [
      trak([sampleEntry('avc1')]),
      trak([sampleEntry('mp4a', esds(0x40, audioSpecificConfig(2)))]),
    ]);

    expect(sniffContainer(bytes).sampleFormats).toEqual(['avc1', 'mp4a']);
  });

  it('surfaces an AC-3 audio track — the case a filename and MIME type both hide', () => {
    // The remux-keeps-the-codec case: an `.m4a` reported as `audio/mp4` whose
    // actual track Chromium cannot decode.
    const bytes = buildMp4('M4A ', [trak([sampleEntry('ac-3')])]);

    const info = sniffContainer(bytes);

    expect(info.sampleFormats).toEqual(['ac-3']);
    expect(info.audioObjectType).toBeUndefined(); // no esds in an AC3SampleEntry
  });

  it('decodes the escaped audio object type of xHE-AAC (42), not just the 5-bit ones', () => {
    const bytes = buildMp4('M4A ', [trak([sampleEntry('mp4a', esds(0x40, audioSpecificConfig(42)))])]);

    expect(sniffContainer(bytes).audioObjectType).toBe(42);
  });

  it('finds moov when it sits AFTER mdat (ffmpeg default without +faststart)', () => {
    const bytes = buildMp4('isom', [trak([sampleEntry('mp4a', esds(0x40, audioSpecificConfig(5)))])], {
      moovLast: true,
    });

    const info = sniffContainer(bytes);

    expect(info.sampleFormats).toEqual(['mp4a']);
    expect(info.audioObjectType).toBe(5); // HE-AAC
    expect(info.notes).toEqual([]);
  });

  it('steps over a 64-bit mdat header without losing the boxes behind it', () => {
    const bytes = buildMp4('isom', [trak([sampleEntry('mp4a')])], {
      moovLast: true,
      mdat: box64('mdat', new Array(32).fill(0x22)),
    });

    expect(sniffContainer(bytes).sampleFormats).toEqual(['mp4a']);
  });

  it('reports a truncated file as a note instead of parsing past its end', () => {
    const full = buildMp4('isom', [trak([sampleEntry('mp4a')])], { moovLast: true });
    const cut = full.subarray(0, full.byteLength - 20); // an interrupted writer's leftover

    const info = sniffContainer(cut);

    expect(info.container).toBe('mp4');
    expect(info.notes.join(' ')).toMatch(/truncated or misdeclared/);
    expect(info.sampleFormats).toEqual([]);
  });

  it('says so when there is no stsd at all rather than reporting a healthy-looking mp4', () => {
    const bytes = new Uint8Array([...box('ftyp', [...ascii('isom'), ...u32(512)]), ...box('mdat', new Array(32).fill(0))]);

    const info = sniffContainer(bytes);

    expect(info.sampleFormats).toEqual([]);
    expect(info.notes.join(' ')).toMatch(/no stsd sample entry/);
  });
});

/**
 * The support case this whole module exists for turned on ONE number the
 * report didn't carry: the duration. 95.2 MB said nothing — a Teams recording's
 * bitrate varies tenfold, so the same file size is 15 minutes or three hours,
 * and only the duration says whether a whole-file decode can fit in memory at
 * all. It sits in `mvhd`, a box the walk already passes.
 */
describe('sniffContainer: duration from mvhd', () => {
  it('reads a version-0 duration as seconds (duration / timescale)', () => {
    // 2:40:11 at a 1000-tick timescale — the real interview from the report.
    const bytes = buildMp4('isom', [trak([sampleEntry('mp4a')])], { moovExtras: mvhd(1000, 9_611_000) });

    expect(sniffContainer(bytes).durationSeconds).toBeCloseTo(9611, 3);
  });

  it('reads a version-1 (64-bit) duration, where the fields shift by eight bytes', () => {
    const bytes = buildMp4('isom', [trak([sampleEntry('mp4a')])], { moovExtras: mvhd(48000, 48000 * 3600, 1) });

    expect(sniffContainer(bytes).durationSeconds).toBeCloseTo(3600, 3);
  });

  it('ignores the "unknown duration" sentinel instead of reporting 49 days', () => {
    // 0xffffffff is what a fragmented/still-being-written mp4 puts here. Taken
    // literally it would produce a nonsense estimate and a false rejection.
    const bytes = buildMp4('isom', [trak([sampleEntry('mp4a')])], { moovExtras: mvhd(1000, 0xffffffff) });

    expect(sniffContainer(bytes).durationSeconds).toBeUndefined();
  });

  it('leaves the duration absent when there is no mvhd at all', () => {
    expect(sniffContainer(buildMp4('isom', [trak([sampleEntry('mp4a')])])).durationSeconds).toBeUndefined();
  });

  it('never divides by a zero timescale', () => {
    const bytes = buildMp4('isom', [trak([sampleEntry('mp4a')])], { moovExtras: mvhd(0, 1000) });

    expect(sniffContainer(bytes).durationSeconds).toBeUndefined();
  });
});

describe('sniffContainer: audio channel count and sample rate', () => {
  it('reads the channel count and sample rate from the audio sample entry', () => {
    const bytes = buildMp4('M4A ', [
      trak([sampleEntry('mp4a', esds(0x40, audioSpecificConfig(2)), { channels: 2, sampleRate: 44100 })]),
    ]);

    const info = sniffContainer(bytes);

    expect(info.audioChannels).toBe(2);
    expect(info.audioSampleRate).toBe(44100);
  });

  it('does not mistake a video entry’s width for a channel count', () => {
    // avc1 keeps width/height where an audio entry keeps channelcount/samplerate.
    // A 1920-channel track would blow the decode estimate out by three orders.
    const bytes = buildMp4('isom', [
      trak([visualSampleEntry('avc1', 1920, 1080)]),
      trak([sampleEntry('mp4a', esds(0x40, audioSpecificConfig(2)), { channels: 1, sampleRate: 16000 })]),
    ]);

    const info = sniffContainer(bytes);

    expect(info.sampleFormats).toEqual(['avc1', 'mp4a']);
    expect(info.audioChannels).toBe(1);
    expect(info.audioSampleRate).toBe(16000);
  });

  it('leaves both absent when the values are implausible rather than reporting them', () => {
    const bytes = buildMp4('isom', [trak([sampleEntry('mp4a', [], { channels: 0, sampleRate: 0 })])]);

    const info = sniffContainer(bytes);

    expect(info.audioChannels).toBeUndefined();
    expect(info.audioSampleRate).toBeUndefined();
  });
});

describe('estimateDecodeBytes', () => {
  it('sums the decoded buffer and the mono downmix copy — the two live allocations', () => {
    // 1 s stereo at 16 kHz Float32: 16000*4*2 decoded + 16000*4 mono.
    const estimate = estimateDecodeBytes(1, 2, 16000);

    expect(estimate.decodedBytes).toBe(128_000);
    expect(estimate.monoBytes).toBe(64_000);
    expect(estimate.peakBytes).toBe(192_000);
  });

  it('puts the report’s real interview where the numbers said it was', () => {
    // 2:40:11 stereo. At the OLD 48 kHz context: ~5.5 GB. At 16 kHz: ~1.8 GB.
    const at48k = estimateDecodeBytes(9611, 2, 48000);
    const at16k = estimateDecodeBytes(9611, 2, 16000);

    expect(at48k.peakBytes / 1e9).toBeCloseTo(5.54, 1);
    expect(at16k.peakBytes / 1e9).toBeCloseTo(1.85, 1);
  });

  it('scales with channel count, since decodeAudioData keeps the source channels', () => {
    expect(estimateDecodeBytes(100, 1, 16000).peakBytes).toBeLessThan(estimateDecodeBytes(100, 2, 16000).peakBytes);
  });
});

describe('sniffContainer: other containers and non-audio input', () => {
  it.each([
    ['wav', [...ascii('RIFF'), ...u32(36), ...ascii('WAVEfmt ')]],
    ['ogg', [...ascii('OggS'), 0, 2, 0, 0, 0, 0, 0, 0]],
    ['flac', [...ascii('fLaC'), 0, 0, 0, 34, 0, 0, 0, 0]],
    ['matroska', [0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]],
    ['mp3', [...ascii('ID3'), 3, 0, 0, 0, 0, 0, 0, 0, 0]],
  ])('identifies %s from its magic bytes', (expected, header) => {
    expect(sniffContainer(new Uint8Array(header)).container).toBe(expected);
  });

  it('reports unrecognised magic bytes verbatim rather than guessing', () => {
    const info = sniffContainer(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6, 7, 8]));

    expect(info.container).toBe('unknown');
    expect(info.notes.join(' ')).toContain('de ad be ef');
  });

  it('never throws on a file too short to identify', () => {
    const info = sniffContainer(new Uint8Array([1, 2, 3]));

    expect(info.container).toBe('unknown');
    expect(info.notes.join(' ')).toMatch(/too short/);
  });

  it('never throws on a random byte soup that looks like a box header', () => {
    // A `size` field of 0xffffffff inside something claiming to be mp4 — the
    // shape that would run a naive walker off the end of the buffer.
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, ...ascii('ftyp'), ...ascii('isom'), 0xff, 0xff, 0xff, 0xff]);

    expect(() => sniffContainer(bytes)).not.toThrow();
  });
});

// --- codec probe ----------------------------------------------------------

describe('probeCodecSupport', () => {
  it('maps each probed label to what the browser claims', () => {
    // The Windows-N-edition shape: no AAC at all, while WebM/Opus is fine.
    const support = probeCodecSupport({
      MediaSource: { isTypeSupported: (type) => type.includes('webm') },
    });

    expect(support).not.toBeNull();
    expect(support!['aac-lc']).toBe(false);
    expect(support!['opus-webm']).toBe(true);
    expect(support!['ac-3']).toBe(false);
  });

  it('returns null when there is no MediaSource to ask, rather than inventing a "no"', () => {
    expect(probeCodecSupport({})).toBeNull();
  });

  it('counts a throwing isTypeSupported as unsupported and still returns the other codecs', () => {
    const support = probeCodecSupport({
      MediaSource: {
        isTypeSupported: (type) => {
          if (type.includes('mp4a.40.2')) throw new TypeError('bad codec string');
          return true;
        },
      },
    });

    expect(support!['aac-lc']).toBe(false);
    expect(support!['mp3']).toBe(true);
  });
});

// --- report formatting ----------------------------------------------------

describe('describeThrown', () => {
  it('keeps a DOMException name, which is the discriminating half', () => {
    expect(describeThrown(new DOMException('Unable to decode audio data', 'EncodingError'))).toBe(
      'EncodingError: Unable to decode audio data',
    );
  });

  it('survives a non-Error throw and an absent cause', () => {
    expect(describeThrown('plain string')).toBe('plain string');
    expect(describeThrown(undefined)).toBe('(none)');
  });
});

describe('formatDiagnosticsReport', () => {
  const container: ContainerInfo = {
    container: 'mp4',
    brand: 'M4A ',
    sampleFormats: ['mp4a'],
    objectTypeIndication: 0x40,
    audioObjectType: 42,
    durationSeconds: 9611,
    audioChannels: 2,
    audioSampleRate: 44100,
    notes: ['moov appears after mdat'],
  };

  it('renders every collected fact as its own readable line', () => {
    const report = formatDiagnosticsReport({
      code: 'AUDIO_DECODE_REJECTED',
      cause: new DOMException('Unable to decode audio data', 'EncodingError'),
      decodeSampleRate: 16000,
      fileName: 'Besprechung.m4a',
      fileSize: 78 * 1024 * 1024,
      fileType: 'audio/mp4',
      container,
      codecSupport: { 'aac-lc': true, 'ac-3': false },
      audioContext: '16000 Hz, state suspended',
      userAgent: 'Mozilla/5.0 Edg/141.0.0.0',
    });

    expect(report.split('\n')).toEqual([
      'localRec audio decode report',
      'code: AUDIO_DECODE_REJECTED',
      'cause: EncodingError: Unable to decode audio data',
      'file: Besprechung.m4a | 78.0 MB | audio/mp4',
      'container: mp4 | brand M4A | tracks mp4a | 2 ch @ 44100 Hz | oti 0x40 | aot 42 (xHE-AAC/USAC (not decodable by Chromium))',
      'duration: 2:40:11 | decode needs ~1.72 GB peak at 16000 Hz × 2 ch',
      'note: moov appears after mdat',
      'audio context: 16000 Hz, state suspended',
      'codecs: aac-lc=yes ac-3=no',
      'browser: Mozilla/5.0 Edg/141.0.0.0',
    ]);
  });

  it('says the duration is unknown rather than silently dropping the cost estimate', () => {
    const report = formatDiagnosticsReport({
      code: 'AUDIO_DECODE_REJECTED',
      cause: null,
      container: { container: 'mp4', sampleFormats: ['mp4a'], notes: [] },
    });

    expect(report).toContain('duration: unknown — decode cost could not be estimated');
  });

  it('assumes stereo for the estimate when the container hid the channel count', () => {
    // The pessimistic direction on purpose: an under-estimate would wave a file
    // through that cannot fit.
    const report = formatDiagnosticsReport({
      code: 'AUDIO_DECODE_REJECTED',
      cause: null,
      decodeSampleRate: 16000,
      container: { container: 'mp4', sampleFormats: ['mp4a'], durationSeconds: 3600, notes: [] },
    });

    expect(report).toContain('× 2 ch');
  });

  it('still produces a usable report when almost nothing could be collected', () => {
    const report = formatDiagnosticsReport({ code: 'AUDIO_READ_FAILED', cause: undefined, fileSize: 0 });

    expect(report).toContain('code: AUDIO_READ_FAILED');
    expect(report).toContain('cause: (none)');
    expect(report).toContain('file: (no name) | 0 bytes | (no MIME type)');
  });

  it('says the codec probe was impossible instead of omitting the line', () => {
    // "codecs: (nothing)" and "no codecs line at all" read identically to a
    // reader; only one of them is honest about WHY.
    const report = formatDiagnosticsReport({ code: 'AUDIO_CONTEXT_FAILED', cause: null, codecSupport: null });

    expect(report).toContain('codecs: no MediaSource to probe');
  });

  it('reports the audio-context failure line — the fact that separates a bad device from a bad file', () => {
    const report = formatDiagnosticsReport({
      code: 'AUDIO_CONTEXT_FAILED',
      cause: new DOMException('no audio device', 'NotSupportedError'),
      audioContext: 'could not be opened — NotSupportedError: no audio device',
    });

    expect(report).toContain('audio context: could not be opened — NotSupportedError: no audio device');
  });
});
