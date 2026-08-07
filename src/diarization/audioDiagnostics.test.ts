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

/** A minimal AudioSampleEntry of the given format, with optional child boxes (an `esds` for `mp4a`). */
function sampleEntry(format: string, children: number[] = []): number[] {
  const fixedFields = new Array(28).fill(0); // reserved/channelcount/samplesize/samplerate — never read
  return box(format, [...fixedFields, ...children]);
}

function stsd(entries: number[][]): number[] {
  return box('stsd', [0x00, 0x00, 0x00, 0x00, ...u32(entries.length), ...entries.flat()]);
}

/** `moov` → `trak` → `mdia` → `minf` → `stbl` → `stsd`, i.e. the real nesting the walk has to descend. */
function trak(entries: number[][]): number[] {
  return box('trak', box('mdia', box('minf', box('stbl', stsd(entries)))));
}

function buildMp4(brand: string, traks: number[][], options: { moovLast?: boolean; mdat?: number[] } = {}): Uint8Array {
  const ftyp = box('ftyp', [...ascii(brand), ...u32(512), ...ascii('isomiso2')]);
  const mdat = options.mdat ?? box('mdat', new Array(64).fill(0x11));
  const moov = box('moov', traks.flat());
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
    notes: ['moov appears after mdat'],
  };

  it('renders every collected fact as its own readable line', () => {
    const report = formatDiagnosticsReport({
      code: 'AUDIO_DECODE_REJECTED',
      cause: new DOMException('Unable to decode audio data', 'EncodingError'),
      fileName: 'Besprechung.m4a',
      fileSize: 78 * 1024 * 1024,
      fileType: 'audio/mp4',
      container,
      codecSupport: { 'aac-lc': true, 'ac-3': false },
      audioContext: '48000 Hz, state suspended',
      userAgent: 'Mozilla/5.0 Edg/141.0.0.0',
    });

    expect(report.split('\n')).toEqual([
      'localRec audio decode report',
      'code: AUDIO_DECODE_REJECTED',
      'cause: EncodingError: Unable to decode audio data',
      'file: Besprechung.m4a | 78.0 MB | audio/mp4',
      'container: mp4 | brand M4A | tracks mp4a | oti 0x40 | aot 42 (xHE-AAC/USAC (not decodable by Chromium))',
      'note: moov appears after mdat',
      'audio context: 48000 Hz, state suspended',
      'codecs: aac-lc=yes ac-3=no',
      'browser: Mozilla/5.0 Edg/141.0.0.0',
    ]);
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
