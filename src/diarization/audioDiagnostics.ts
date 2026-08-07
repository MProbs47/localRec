/**
 * The copy-paste diagnostic report that a failed decode attaches to its
 * `AudioDecodeError` (see `audioDecode.ts`). Exists because of one concrete
 * support case: a customer's Edge refused both an `.mp4` and the `.m4a`
 * extracted from it with the same generic "unsupported or corrupt data", the
 * file played fine in the machine's own audio player, and the organisation's
 * policy locked DevTools — so there was no way to learn *which* of four very
 * different failures had happened (missing codec in that browser build, a
 * container the demuxer rejects, an `AudioContext` that never opened, or an
 * over-long file). Every fact this module collects is one that discriminates
 * between those, and all of it is available offline, on the device, without
 * MediaInfo/ffprobe and without a console.
 *
 * **Everything here is best-effort and must never throw.** It runs inside an
 * error path; a diagnostics bug that masked the real decode failure would be
 * strictly worse than no diagnostics. Every collector below is individually
 * wrapped, records its own miss as a note in the report, and the report is
 * built from whatever succeeded.
 *
 * **Why the container is sniffed from the bytes rather than trusted from
 * `File.type`.** The OS-supplied MIME type is derived from the extension and
 * is exactly what lies in this class of case — a remuxed track keeps its
 * original codec, so an `.m4a` whose `stsd` says `ac-3` still reports
 * `audio/mp4`. Walking the real box tree (skipping `mdat` by its size field,
 * never reading its bytes — that is what makes a full-file walk cheap even
 * for a 78 MB input) yields the actual sample-entry fourccs, plus the MPEG-4
 * audio object type out of `esds` where present, which is the only way to
 * tell plain AAC-LC from HE-AAC or xHE-AAC/USAC.
 *
 * **`moov` may sit at the END of the file** (ffmpeg's default without
 * `+faststart`), so the walk cannot stop after the first few kilobytes —
 * hence a whole-`ArrayBuffer` walk rather than a header peek.
 *
 * **`MediaSource.isTypeSupported` is the codec probe, not WebCodecs.**
 * `AudioDecoder.isConfigSupported()` would need a full, correct config
 * (sample rate, channel count) that a failed decode by definition never
 * produced, so it can't be asked honestly here. `isTypeSupported` needs only
 * a codec string, is synchronous, and answers the load-bearing question
 * ("does THIS browser installation have AAC/AC-3 at all") outright — which is
 * exactly what a Windows N/KN edition or a policy-restricted build gets
 * wrong.
 *
 * Reached through injected structural envs, same discipline as
 * `audioDecode.ts`'s `AudioDecoderLike` and `opfsAudio.ts`'s
 * `getOpfsStorage()`: `MediaSource` and `AudioContext` don't exist in
 * Node/Vitest, so the report builder takes them as parameters and the real
 * `globalThis` lookup happens only in `collectAudioDecodeDiagnostics()` at
 * the bottom.
 */

/** What `sniffContainer` could work out from the bytes. Every field except `container`/`notes` is absent when the format doesn't carry it (or the parse gave up). */
export interface ContainerInfo {
  /** Best guess from the magic bytes: `'mp4'`, `'wav'`, `'ogg'`, `'matroska'`, `'flac'`, `'mp3'`, `'adts-aac'`, or `'unknown'`. */
  container: string;
  /** The mp4 `ftyp` brand (e.g. `isom`, `M4A `) — mp4 family only. */
  brand?: string;
  /** Every sample-entry fourcc found in the file's `stsd` boxes, in file order (e.g. `['avc1', 'mp4a']`) — mp4 family only. This is the codec truth the extension and MIME type can't tell us. */
  sampleFormats?: string[];
  /** `objectTypeIndication` from an `mp4a` entry's `esds` (0x40 = MPEG-4 audio, 0xA5 = AC-3, 0xA6 = E-AC-3). */
  objectTypeIndication?: number;
  /** MPEG-4 audio object type from the same `esds` — 2 = AAC-LC, 5 = HE-AAC, 29 = HE-AACv2, 42 = xHE-AAC/USAC. Chromium decodes 2/5/29 and not 42. */
  audioObjectType?: number;
  /**
   * Media duration in seconds from `mvhd` (`duration / timescale`) — mp4 family
   * only. **The single most load-bearing number in this report.** A whole-file
   * `decodeAudioData` costs memory proportional to the DURATION, and a
   * recording's file size says nothing about it: a screen-share-heavy meeting
   * varies tenfold in bitrate, so 95 MB is fifteen minutes or three hours. A
   * report without this number cannot tell "codec unsupported" from "far too
   * long to fit in memory", which is exactly the confusion that cost one
   * support case several rounds.
   */
  durationSeconds?: number;
  /** Channel count from the audio sample entry — a multiplier on the decode cost, since `decodeAudioData` keeps the source channels. */
  audioChannels?: number;
  /** Sample rate from the audio sample entry. Informational: the decoded buffer comes back at the decoding context's rate, not this one. */
  audioSampleRate?: number;
  /** Anything that went wrong or looked odd while parsing — a truncated/misdeclared box is itself a finding, so it is reported rather than swallowed. */
  notes: string[];
}

function fourcc(view: DataView, offset: number): string {
  let out = '';
  for (let i = 0; i < 4; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/** mp4 boxes whose payload is more boxes — the only ones the walk descends into. Anything else (notably `mdat`) is skipped by its declared size. */
const MP4_CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'moof', 'traf']);

/**
 * Skips an MPEG-4 descriptor's variable-length size field (7 payload bits per
 * byte, high bit = "another byte follows", at most 4 bytes) and returns the
 * offset of the descriptor's payload. The declared length itself is never
 * needed here — every field this module reads is at a fixed offset from the
 * payload start, and the enclosing box already bounds the walk.
 */
function afterDescriptorLength(view: DataView, offset: number, end: number): number {
  let next = offset;
  for (let i = 0; i < 4 && next < end; i++) {
    const byte = view.getUint8(next);
    next++;
    if ((byte & 0x80) === 0) break;
  }
  return next;
}

/**
 * Pulls `objectTypeIndication` and the AAC audio object type out of an
 * `esds` box's ES_Descriptor → DecoderConfigDescriptor → DecoderSpecificInfo
 * chain. This is the difference between "the track says `mp4a`, looks fine,
 * why did it fail" and "it is xHE-AAC, which Chromium does not decode".
 */
function parseEsds(view: DataView, start: number, end: number, info: ContainerInfo): void {
  let offset = start + 4; // FullBox version + flags
  if (offset >= end || view.getUint8(offset) !== 0x03) return; // ES_DescrTag
  offset = afterDescriptorLength(view, offset + 1, end);
  if (offset + 3 > end) return;
  const esFlags = view.getUint8(offset + 2);
  offset += 3; // ES_ID (2) + flags/streamPriority (1)
  if (esFlags & 0x80) offset += 2; // dependsOn_ES_ID
  if (esFlags & 0x40) offset += 1 + view.getUint8(offset); // URL_Flag: length-prefixed URL
  if (esFlags & 0x20) offset += 2; // OCR_ES_Id

  if (offset >= end || view.getUint8(offset) !== 0x04) return; // DecoderConfigDescrTag
  offset = afterDescriptorLength(view, offset + 1, end);
  if (offset >= end) return;
  info.objectTypeIndication = view.getUint8(offset);
  offset += 13; // OTI (1) + streamType/bufferSizeDB (4) + maxBitrate (4) + avgBitrate (4)

  if (offset >= end || view.getUint8(offset) !== 0x05) return; // DecSpecificInfoTag
  offset = afterDescriptorLength(view, offset + 1, end);
  if (offset >= end) return;
  const first = view.getUint8(offset);
  let audioObjectType = first >>> 3; // 5 bits
  if (audioObjectType === 31 && offset + 1 < end) {
    // Escape value: 32 + the next 6 bits (AOT 42 = xHE-AAC/USAC arrives this way).
    audioObjectType = 32 + (((first & 0x07) << 3) | (view.getUint8(offset + 1) >>> 5));
  }
  info.audioObjectType = audioObjectType;
}

/** Scans an `mp4a` sample entry's child boxes for `esds`. The fixed AudioSampleEntry fields before them vary by version, so the fourcc is searched for rather than computed. */
function findEsds(view: DataView, start: number, end: number, info: ContainerInfo): void {
  for (let offset = start; offset + 4 <= end; offset++) {
    if (fourcc(view, offset) === 'esds') {
      parseEsds(view, offset + 4, end, info);
      return;
    }
  }
}

/**
 * `mvhd`: version/flags (4), then creation/modification times, `timescale` and
 * `duration`. Version 1 widens both times AND the duration to 64 bits, shifting
 * every following field — get that wrong and the duration is garbage rather
 * than absent, which is worse than not reading it at all.
 */
function parseMvhd(view: DataView, start: number, end: number, info: ContainerInfo): void {
  if (start + 4 > end) return;
  const version = view.getUint8(start);
  const timescaleOffset = version === 1 ? start + 20 : start + 12;
  const durationOffset = version === 1 ? start + 24 : start + 16;
  if ((version === 1 ? durationOffset + 8 : durationOffset + 4) > end) return;

  const timescale = view.getUint32(timescaleOffset);
  const duration =
    version === 1
      ? view.getUint32(durationOffset) * 2 ** 32 + view.getUint32(durationOffset + 4)
      : view.getUint32(durationOffset);

  // All-ones is the "duration unknown" sentinel a fragmented or
  // still-being-written mp4 leaves here. Taken literally it reads as ~49 days
  // and would trip any length guard downstream — an absent duration is honest,
  // a fabricated one is not.
  const unknown = version === 1 ? duration >= 2 ** 64 - 1 : duration === 0xffffffff;
  if (timescale > 0 && duration > 0 && !unknown) info.durationSeconds = duration / timescale;
}

/**
 * Channel count and sample rate out of an AudioSampleEntry's fixed fields:
 * reserved(6) dref(2) reserved(8) **channelcount(2)** samplesize(2)
 * pre_defined(2) reserved(2) **samplerate(4, 16.16 fixed)**.
 *
 * A VisualSampleEntry keeps `width`/`height` in overlapping territory, so a
 * plausibility window does the discriminating rather than a fourcc allow-list:
 * a video entry reads back 0 channels (its `pre_defined` zeros land on the
 * channelcount field) and is rejected, while 1920 would never pass anyway. That
 * keeps this working for audio codecs nobody thought to list.
 */
function parseAudioSampleEntry(view: DataView, payloadStart: number, end: number, info: ContainerInfo): void {
  if (payloadStart + 28 > end) return;
  const channels = view.getUint16(payloadStart + 16);
  const sampleRate = view.getUint16(payloadStart + 24); // integer part of the 16.16 fixed-point value
  if (channels < 1 || channels > 32) return;
  if (sampleRate < 3000 || sampleRate > 384000) return;
  // First plausible audio track wins — a second one would not change the
  // decode cost estimate, since `decodeAudioData` only ever decodes the first.
  if (info.audioChannels === undefined) {
    info.audioChannels = channels;
    info.audioSampleRate = sampleRate;
  }
}

/** `stsd` payload: version/flags (4) + entry_count (4), then one length-prefixed sample entry per track format. */
function parseStsd(view: DataView, start: number, end: number, info: ContainerInfo): void {
  if (start + 8 > end) return;
  const entryCount = view.getUint32(start + 4);
  let offset = start + 8;
  for (let i = 0; i < entryCount && offset + 8 <= end; i++) {
    const entrySize = view.getUint32(offset);
    const format = fourcc(view, offset + 4);
    info.sampleFormats!.push(format);
    if (entrySize < 8) {
      info.notes.push(`stsd entry ${i} declares ${entrySize} bytes (invalid)`);
      return;
    }
    const entryEnd = Math.min(offset + entrySize, end);
    parseAudioSampleEntry(view, offset + 8, entryEnd, info);
    if (format === 'mp4a') findEsds(view, offset + 8, entryEnd, info);
    offset += entrySize;
  }
}

function walkMp4Boxes(view: DataView, start: number, end: number, depth: number, info: ContainerInfo): void {
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = fourcc(view, offset + 4);
    let headerSize = 8;
    if (size === 1) {
      // 64-bit largesize — a >4 GiB `mdat` uses this, so it must be handled
      // or the walk would misread every following box.
      if (offset + 16 > end) {
        info.notes.push(`64-bit header of box '${type}' is truncated`);
        return;
      }
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset; // "extends to end of file"
    }
    if (size < headerSize || offset + size > end) {
      // The load-bearing note for an interrupted recording: a box claiming
      // more bytes than the file holds is exactly what an aborted mp4 writer
      // leaves behind, and exactly what a browser demuxer rejects.
      info.notes.push(`box '${type}' claims ${size} bytes, ${end - offset} left (truncated or misdeclared)`);
      return;
    }
    if (type === 'stsd') parseStsd(view, offset + headerSize, offset + size, info);
    else if (type === 'mvhd') parseMvhd(view, offset + headerSize, offset + size, info);
    else if (MP4_CONTAINER_BOXES.has(type) && depth < 8) {
      walkMp4Boxes(view, offset + headerSize, offset + size, depth + 1, info);
    }
    offset += size;
  }
}

/**
 * Identifies the container from its magic bytes and, for the mp4 family,
 * walks the box tree for the real per-track codec fourccs. Pure and
 * total — never throws, reports every giving-up point as a note instead.
 */
export function sniffContainer(bytes: Uint8Array): ContainerInfo {
  const info: ContainerInfo = { container: 'unknown', notes: [] };
  try {
    if (bytes.byteLength < 12) {
      info.notes.push(`only ${bytes.byteLength} bytes — too short to identify`);
      return info;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const head = fourcc(view, 0);
    if (fourcc(view, 4) === 'ftyp') {
      info.container = 'mp4';
      info.brand = fourcc(view, 8);
      info.sampleFormats = [];
      walkMp4Boxes(view, 0, bytes.byteLength, 0, info);
      if (info.sampleFormats.length === 0) {
        info.notes.push('no stsd sample entry found — moov missing or unreadable');
      }
      return info;
    }
    if (head === 'RIFF' && fourcc(view, 8) === 'WAVE') info.container = 'wav';
    else if (head === 'OggS') info.container = 'ogg';
    else if (head === 'fLaC') info.container = 'flac';
    else if (view.getUint32(0) === 0x1a45dfa3) info.container = 'matroska'; // webm/mkv EBML
    else if (head.startsWith('ID3')) info.container = 'mp3';
    else if (view.getUint8(0) === 0xff && (view.getUint8(1) & 0xe0) === 0xe0) info.container = 'mp3-or-adts';
    else info.notes.push(`unrecognised magic bytes ${[...bytes.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  } catch (error) {
    info.notes.push(`container sniff failed: ${describeThrown(error)}`);
  }
  return info;
}

// --- Codec support probe ---------------------------------------------------

/** The codec strings probed, shortest-label-first so the report line stays one line. Chosen to cover every codec that plausibly ends up in a meeting recording plus the two (`ac-3`/`ec-3`) Chromium does not decode. */
const PROBED_CODECS: readonly (readonly [label: string, mimeType: string])[] = [
  ['aac-lc', 'audio/mp4; codecs="mp4a.40.2"'],
  ['he-aac', 'audio/mp4; codecs="mp4a.40.5"'],
  ['xhe-aac', 'audio/mp4; codecs="mp4a.40.42"'],
  ['ac-3', 'audio/mp4; codecs="ac-3"'],
  ['ec-3', 'audio/mp4; codecs="ec-3"'],
  ['alac', 'audio/mp4; codecs="alac"'],
  ['opus-webm', 'audio/webm; codecs="opus"'],
  ['mp3', 'audio/mpeg'],
  ['flac', 'audio/flac'],
];

/** The narrow slice of `MediaSource` the probe needs — absent in Node, so injected (see file header). */
export interface CodecProbeEnvLike {
  MediaSource?: { isTypeSupported(type: string): boolean };
}

/** Which codecs this browser installation admits to supporting. `null` when there is no `MediaSource` to ask — itself worth reporting rather than guessing. */
export function probeCodecSupport(env: CodecProbeEnvLike): Record<string, boolean> | null {
  const mediaSource = env.MediaSource;
  if (!mediaSource || typeof mediaSource.isTypeSupported !== 'function') return null;
  const support: Record<string, boolean> = {};
  for (const [label, mimeType] of PROBED_CODECS) {
    try {
      support[label] = mediaSource.isTypeSupported(mimeType);
    } catch {
      support[label] = false; // a throwing probe counts as "no" — never abort the whole report over one codec string
    }
  }
  return support;
}

// --- Report assembly ------------------------------------------------------

/** Turns anything a `catch` can hand over into one readable line. A `DOMException`'s `name` is the discriminating part (`EncodingError` vs. `NotSupportedError`), so it is kept. */
export function describeThrown(error: unknown): string {
  if (error instanceof Error) return error.name ? `${error.name}: ${error.message}` : error.message;
  if (error === undefined) return '(none)';
  return String(error);
}

function formatBytes(size: number): string {
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`;
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${size} bytes`;
}

/** `h:mm:ss` — the shape a player shows, so the number in the report can be compared against what the user sees without arithmetic. */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Every live allocation of a whole-file decode, in bytes. See `estimateDecodeBytes`. */
export interface DecodeSizeEstimate {
  /** The `AudioBuffer` `decodeAudioData` returns: one Float32 per sample per channel, at the DECODING CONTEXT's rate — not the file's. */
  decodedBytes: number;
  /** `downmixToMono`'s output, a second full-length Float32 array. */
  monoBytes: number;
  /** Both of the above, alive at the same moment. This is the number that has to fit. */
  peakBytes: number;
}

/**
 * What a whole-file `decodeAudioData` will cost in memory.
 *
 * Exactly two allocations are alive together and both are counted: the decoded
 * `AudioBuffer` (channels × rate × duration × 4) and the mono downmix copy
 * (rate × duration × 4). The resample step adds nothing when the decoding
 * context already runs at the target rate — `resampleLinear` returns its input
 * unchanged for equal rates.
 *
 * `targetSampleRate` is the DECODING CONTEXT's rate, because that is what
 * `decodeAudioData` resamples to. This is why decoding through a 16 kHz
 * `OfflineAudioContext` rather than a 48 kHz hardware `AudioContext` cuts the
 * cost threefold: the same file, a third of the peak.
 */
export function estimateDecodeBytes(
  durationSeconds: number,
  channels: number,
  targetSampleRate: number,
): DecodeSizeEstimate {
  const frames = durationSeconds * targetSampleRate;
  const decodedBytes = frames * channels * 4;
  const monoBytes = frames * 4;
  return { decodedBytes, monoBytes, peakBytes: decodedBytes + monoBytes };
}

/** Human names for the `esds` object types worth calling out by name — the ones that explain a rejected decode. */
const AUDIO_OBJECT_TYPE_NAMES: Record<number, string> = {
  2: 'AAC-LC',
  5: 'HE-AAC',
  29: 'HE-AACv2',
  42: 'xHE-AAC/USAC (not decodable by Chromium)',
};

/** Assumed channel count when the container didn't reveal one — the pessimistic guess, because stereo costs twice mono and an under-estimate is the harmful direction. */
const ASSUMED_CHANNELS = 2;

/**
 * Decode rate used for the cost estimate when the caller doesn't state one.
 * Mirrors `audioDecode.ts`'s `TARGET_SAMPLE_RATE` by value rather than by
 * import: that module imports THIS one, and a cycle for one constant is a
 * worse trade than a documented duplicate.
 */
const FALLBACK_DECODE_RATE = 16000;

export interface DiagnosticsInput {
  /** The `AudioDecodeErrorCode` of the failure being explained. */
  code: string;
  /** Whatever the failing step threw. */
  cause: unknown;
  /** The rate the decoding context actually runs at — what `decodeAudioData` resamples to, and therefore what the cost estimate must use. */
  decodeSampleRate?: number;
  fileName?: string;
  fileSize?: number;
  /** `File.type` as the OS reported it — kept alongside the sniffed container precisely so a disagreement between them is visible. */
  fileType?: string;
  container?: ContainerInfo;
  codecSupport?: Record<string, boolean> | null;
  /** One line about the audio context: its rate/state, or why one could not be opened. */
  audioContext?: string;
  userAgent?: string;
}

/**
 * Assembles the report the user copies. Deliberately plain lines rather than
 * JSON: it is pasted into an e-mail or a chat by someone who cannot open a
 * console, and it has to survive that trip readable. Pure — every fact is
 * passed in, so the whole format is unit-testable.
 */
export function formatDiagnosticsReport(input: DiagnosticsInput): string {
  const lines: string[] = ['localRec audio decode report', `code: ${input.code}`, `cause: ${describeThrown(input.cause)}`];

  const fileParts = [input.fileName ?? '(no name)'];
  if (input.fileSize !== undefined) fileParts.push(formatBytes(input.fileSize));
  fileParts.push(input.fileType ? input.fileType : '(no MIME type)');
  lines.push(`file: ${fileParts.join(' | ')}`);

  const container = input.container;
  if (container) {
    const parts = [container.container];
    if (container.brand) parts.push(`brand ${container.brand.trim()}`);
    if (container.sampleFormats?.length) parts.push(`tracks ${container.sampleFormats.join(',')}`);
    if (container.audioChannels !== undefined) {
      parts.push(`${container.audioChannels} ch @ ${container.audioSampleRate} Hz`);
    }
    if (container.objectTypeIndication !== undefined) {
      parts.push(`oti 0x${container.objectTypeIndication.toString(16)}`);
    }
    if (container.audioObjectType !== undefined) {
      const name = AUDIO_OBJECT_TYPE_NAMES[container.audioObjectType];
      parts.push(`aot ${container.audioObjectType}${name ? ` (${name})` : ''}`);
    }
    lines.push(`container: ${parts.join(' | ')}`);

    // The duration line, and immediately beside it what that duration costs.
    // Separated from `container:` because it is the line a reader should look
    // at first, and because the cost is derived rather than read from the file.
    if (container.durationSeconds !== undefined) {
      const rate = input.decodeSampleRate ?? FALLBACK_DECODE_RATE;
      const channels = container.audioChannels ?? ASSUMED_CHANNELS;
      const estimate = estimateDecodeBytes(container.durationSeconds, channels, rate);
      lines.push(
        `duration: ${formatDuration(container.durationSeconds)} | decode needs ~${formatBytes(estimate.peakBytes)}` +
          ` peak at ${rate} Hz × ${channels} ch`,
      );
    } else {
      lines.push('duration: unknown — decode cost could not be estimated');
    }

    for (const note of container.notes) lines.push(`note: ${note}`);
  }

  if (input.audioContext) lines.push(`audio context: ${input.audioContext}`);

  if (input.codecSupport === null) lines.push('codecs: no MediaSource to probe');
  else if (input.codecSupport) {
    const flags = Object.entries(input.codecSupport).map(([label, ok]) => `${label}=${ok ? 'yes' : 'no'}`);
    lines.push(`codecs: ${flags.join(' ')}`);
  }

  if (input.userAgent) lines.push(`browser: ${input.userAgent}`);
  return lines.join('\n');
}

// --- Real-globals Andockpunkt (manual milestone, not unit-tested) ---------
//
// Same shape and same reason as `audioDecode.ts`'s `createAudioContextDecoder`:
// `MediaSource`, `AudioContext` and `navigator` are browser-only, so the
// `globalThis` lookups live in exactly this one place and everything above is
// reachable from Vitest through plain parameters.

interface DiagnosticsEnvLike extends CodecProbeEnvLike {
  AudioContext?: new () => { sampleRate: number; state: string; close(): Promise<void> };
  webkitAudioContext?: new () => { sampleRate: number; state: string; close(): Promise<void> };
  navigator?: { userAgent?: string };
}

/**
 * Opens a throwaway `AudioContext` purely to report its rate and state — or,
 * if that throws, reports the throw. That second outcome is the whole point:
 * a machine with no audio output device or a blocking policy fails here, and
 * without this line that failure is indistinguishable from a bad codec.
 */
async function describeAudioContext(env: DiagnosticsEnvLike): Promise<string> {
  const Ctor = env.AudioContext ?? env.webkitAudioContext;
  if (!Ctor) return 'unavailable (no AudioContext constructor)';
  let context: { sampleRate: number; state: string; close(): Promise<void> } | undefined;
  try {
    context = new Ctor();
    return `${context.sampleRate} Hz, state ${context.state}`;
  } catch (error) {
    return `could not be opened — ${describeThrown(error)}`;
  } finally {
    try {
      await context?.close();
    } catch {
      /* closing a context we only opened to inspect is not worth reporting */
    }
  }
}

/**
 * The production diagnostics collector wired into `App.tsx`'s decode seam.
 *
 * **Prefers the container the caller already sniffed.** `audioDecode.ts` now
 * walks the boxes before decoding (it needs the duration for its length
 * guard), so passing that result in avoids re-reading the whole file — 95 MB
 * in the case that motivated this. When no container is supplied the blob is
 * re-read instead: reusing the `ArrayBuffer` the decode attempt held is not an
 * option, because Chromium's `decodeAudioData` takes ownership of and detaches
 * that buffer, leaving it empty by the time this runs.
 */
export async function collectAudioDecodeDiagnostics(
  blob: Blob,
  failure: { code: string; cause: unknown; container?: ContainerInfo; decodeSampleRate?: number },
): Promise<string> {
  const env = globalThis as unknown as DiagnosticsEnvLike;
  let container = failure.container;
  if (!container) {
    try {
      container = sniffContainer(new Uint8Array(await blob.arrayBuffer()));
    } catch (error) {
      container = { container: 'unreadable', notes: [`re-reading the file failed: ${describeThrown(error)}`] };
    }
  }
  return formatDiagnosticsReport({
    code: failure.code,
    cause: failure.cause,
    decodeSampleRate: failure.decodeSampleRate,
    fileName: (blob as Blob & { name?: string }).name,
    fileSize: blob.size,
    fileType: blob.type,
    container,
    codecSupport: probeCodecSupport(env),
    audioContext: await describeAudioContext(env),
    userAgent: env.navigator?.userAgent,
  });
}
