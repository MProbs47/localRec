/**
 * U14 (SD-1 Fundament, KTD13): post-hoc audio reacquisition — decodes a
 * whatever-codec `Blob` back into **16 kHz mono Float32 PCM**, the one input
 * shape every downstream Phase D/E consumer needs (U15's diarization
 * `segment()`/`embed()`, U20's batch-transcription feed). Diarization is
 * deliberately post-hoc, not streaming (KTD13: segmentation → embedding →
 * clustering only make sense over the whole buffered/persisted recording),
 * so this is the seam where "a finished recording" becomes "an in-memory PCM
 * buffer" for everything that runs after the fact.
 *
 * **SOURCE-AGNOSTIC — this is KTD16's load-bearing seam.** The public
 * function below takes *any* `Blob` and has no opinion on where it came
 * from. It does not know about OPFS (`opfsAudio.ts`, U6's persisted session
 * audio) and does not know about a user-picked file (U19's import path,
 * Phase E). KTD16 ("zwei Eingänge, eine geteilte Post-hoc-Pipeline") is only
 * true if the path starting *here* is identical for both — so fetching the
 * blob (U6 for live sessions, U19 for imports) and posting the resulting PCM
 * onward to the diarization worker as a Transferable (not this module's
 * job — see U15/U16) both stay firmly outside this file.
 *
 * **Why `decodeAudioData` needs an injected seam (mirrors `opfsAudio.ts` /
 * `modelCache.ts`'s discipline for the same reason).** Decoding compressed
 * audio into PCM is only available via `AudioContext`/`OfflineAudioContext`
 * — a *main-thread-only*, DOM-only API. There is no `AudioContext` in a
 * Worker and none in Node/Vitest (this repo's stated "Realitätsgrenze", same
 * as OPFS). Rather than reach for the ambient `AudioContext` global directly
 * — which would make the downmix/resample/error-handling logic below
 * untestable — `decodeAudioBlobTo16kMonoPcm` takes an injected `decode`
 * function shaped as the narrow `AudioDecoderLike` structural interface
 * below. A fake implementing just that one method exercises the *real*
 * downmix/resample/error-path code in Vitest; `createAudioContextDecoder()`
 * at the bottom of this file is the real adapter, reached through
 * `globalThis` exactly like `opfsAudio.ts`'s `getOpfsStorage()` and
 * `modelCache.ts`'s `getNavigatorStorage()` — a documented manual milestone,
 * not unit-tested (no `AudioContext` in Node).
 *
 * **Mono downmix = arithmetic mean of all channels**, not "keep channel 0"
 * — kept consistent with `worklet-processor.js` (U3)'s live-capture downmix,
 * so a stereo recording that happens to be hot on only one channel isn't
 * silently half-dropped in the post-hoc path either.
 *
 * **Resample via `src/audio/resample.ts` (DRY) — no second resampler.**
 * `resampleLinear()` is already the tested source of truth for going from
 * whatever rate the decoding context handed back (typically 44.1/48 kHz) to
 * the 16 kHz every model in this codebase expects (KTD10). This module
 * imports it directly rather than re-deriving the math (unlike
 * `worklet-processor.js`, which duplicates it for the unrelated reason that
 * an AudioWorklet module can't reliably cross-import — that constraint
 * doesn't apply here, this file runs as an ordinary ES module).
 *
 * **Blockwise decode is explicitly NOT built here (YAGNI).** A 4h
 * recording decoded whole is ~0.9 GB of 16 kHz mono Float32 — the plan flags
 * this as a real concern for very long imports, but only *directionally*
 * ("ggf. blockweise dekodieren, Execution-Zeit-Kalibrierung"). This module
 * decodes the whole blob in one `decode()` call, matching the actual U14
 * scope. The seam for a future blockwise version is narrow and already
 * implied by the public signature: it takes a whole `Blob` and returns a
 * whole `Float32Array`, so a later chunked variant would slice the input
 * `Blob` (e.g. via `Blob.slice()`) into ranges *before* calling this
 * function's decode step per range — no rewrite of the downmix/resample
 * logic here, just a new caller. Left as a documented future concern for
 * U20 (the unit that owns chunked/paced import decoding), not attempted now.
 */
import { resampleLinear } from '../audio/resample';
import { describeThrown } from './audioDiagnostics';

/** 16 kHz mono is the fixed target for every model in this codebase (KTD10) — diarization (U15) and batch-transcription (U20) both consume exactly this shape. */
export const TARGET_SAMPLE_RATE = 16000;

/**
 * Which step failed. One code per *distinct cause*, because these four used
 * to collapse into one "unsupported or corrupt data" message and that message
 * cost a real support case its diagnosis: a customer's Edge produced it for a
 * file their own audio player played, and nothing in the app could say
 * whether the codec was missing, the container broken, or the `AudioContext`
 * never opened at all. A code the user can read out loud is the cheapest
 * possible fix for that, and `audioDiagnostics.ts` supplies the rest.
 */
export type AudioDecodeErrorCode =
  | 'AUDIO_EMPTY_FILE'
  | 'AUDIO_READ_FAILED'
  | 'AUDIO_CONTEXT_UNAVAILABLE'
  | 'AUDIO_CONTEXT_FAILED'
  | 'AUDIO_DECODE_REJECTED'
  | 'AUDIO_DECODE_EMPTY';

/**
 * One short English line per code, shown under the localised headline on the
 * error screen. **Deliberately not translated** (owner's call): these are
 * support text, and a report that reads the same in every locale is one that
 * can be compared across users and pasted into an issue as-is. The localised
 * part of that screen stays the headline above it.
 */
export const AUDIO_DECODE_CODE_DESCRIPTIONS: Record<AudioDecodeErrorCode, string> = {
  AUDIO_EMPTY_FILE: 'The selected file contains no data.',
  AUDIO_READ_FAILED: 'The file could not be read from disk.',
  AUDIO_CONTEXT_UNAVAILABLE: 'This browser has no Web Audio support.',
  AUDIO_CONTEXT_FAILED: 'The browser could not open an audio context on this device.',
  AUDIO_DECODE_REJECTED: 'The browser cannot decode this file’s audio codec.',
  AUDIO_DECODE_EMPTY: 'The audio track decoded to zero samples.',
};

/**
 * Thrown for any failure in this module — an empty/zero-byte blob, a blob
 * whose bytes couldn't even be read, a browser that wouldn't open an audio
 * context, or a blob the decoder rejected as unsupported/corrupt audio.
 * Callers (U15's diarization trigger, U19/U20's import path) get one clean,
 * typed failure to catch and surface as a UX error, never a raw decoder
 * exception or a hang — but now with a `code` saying *which* of those it was.
 */
export class AudioDecodeError extends Error {
  /** Which step failed — the discriminating fact, kept as data rather than only as prose in `message`. */
  readonly code: AudioDecodeErrorCode;
  /**
   * The copy-paste support report (`audioDiagnostics.ts`), attached only when
   * a `diagnose` collector was supplied — absent in tests and in any caller
   * that doesn't want the extra file re-read.
   */
  readonly details?: string;

  constructor(code: AudioDecodeErrorCode, message: string, options?: { cause?: unknown; details?: string }) {
    super(`${code}: ${message}`, { cause: options?.cause });
    this.name = 'AudioDecodeError';
    this.code = code;
    this.details = options?.details;
  }
}

/**
 * The exact structural slice of a real `AudioBuffer` this module depends
 * on — deliberately not the ambient DOM `AudioBuffer` type (unavailable
 * under `tsconfig.node.json`, same constraint as `SyncAccessHandleLike` in
 * `opfsAudio.ts`). A plain object satisfying these four members is a fully
 * valid `DecodedAudioLike` for testing; a real `AudioBuffer` satisfies it
 * structurally at runtime without being named here.
 */
export interface DecodedAudioLike {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  /** Frame count (samples per channel) — matches `AudioBuffer.length`. */
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

/** Takes the raw encoded bytes, returns decoded PCM. A real `AudioContext.decodeAudioData` (bound) satisfies this signature structurally. */
export type AudioDecoderLike = (arrayBuffer: ArrayBuffer) => Promise<DecodedAudioLike>;

/**
 * Builds the copy-paste report for a failure. Takes the original `Blob` (not
 * the `ArrayBuffer` the decode attempt used — Chromium's `decodeAudioData`
 * detaches that buffer, so it is empty by the time this runs) and must never
 * throw; a rejection here is swallowed so diagnostics can't mask the real
 * failure. Production: `collectAudioDecodeDiagnostics` from
 * `audioDiagnostics.ts`.
 */
export type AudioDecodeDiagnose = (
  blob: Blob,
  failure: { code: AudioDecodeErrorCode; cause: unknown },
) => Promise<string>;

export interface AudioDecodeDeps {
  decode: AudioDecoderLike;
  /** Optional — omitted, the thrown `AudioDecodeError` still carries its `code`, just no report. */
  diagnose?: AudioDecodeDiagnose;
}

/** Sum of all channels divided by channel count, per sample — see file header for why this beats "channel 0 only". Works unchanged for the already-mono case (division by 1). */
function downmixToMono(decoded: DecodedAudioLike): Float32Array {
  const { numberOfChannels, length } = decoded;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const channelData = decoded.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      mono[i] += channelData[i] / numberOfChannels;
    }
  }
  return mono;
}

/**
 * Decodes `blob` (whatever codec the browser's decoder supports — `.webm`/
 * Opus and `.mp4`/AAC per the plan, but this function itself has no codec
 * opinion) into 16 kHz mono Float32 PCM. Source-agnostic (see file header —
 * this is KTD16's shared entry point for both the live-recording and
 * file-import paths). Main-thread only at runtime, because `deps.decode`
 * ultimately needs a real `AudioContext` somewhere up the call chain (see
 * `createAudioContextDecoder()` below) — this function itself doesn't touch
 * any global, so it's just as easily unit-tested as it is main-thread-safe.
 *
 * Throws `AudioDecodeError` for an empty blob, an unreadable blob, or a
 * blob the decoder rejects as unsupported/corrupt — never lets a raw
 * decoder exception or a hang reach the caller.
 */
export async function decodeAudioBlobTo16kMonoPcm(blob: Blob, deps: AudioDecodeDeps): Promise<Float32Array> {
  /** Builds the diagnostics (best-effort) and throws the coded error. Every failure below goes through here so none can forget the report. */
  const fail = async (code: AudioDecodeErrorCode, message: string, cause?: unknown): Promise<never> => {
    let details: string | undefined;
    if (deps.diagnose) {
      try {
        details = await deps.diagnose(blob, { code, cause });
      } catch {
        // Diagnostics are a nice-to-have; the real failure below is not.
        // Swallowing here is what guarantees this module can only ever throw
        // the error it set out to throw.
      }
    }
    throw new AudioDecodeError(code, message, { cause, details });
  };

  if (blob.size === 0) {
    return fail('AUDIO_EMPTY_FILE', 'blob is empty (0 bytes) — nothing to decode');
  }

  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await blob.arrayBuffer();
  } catch (cause) {
    return fail('AUDIO_READ_FAILED', 'failed to read blob bytes', cause);
  }

  let decoded: DecodedAudioLike;
  try {
    decoded = await deps.decode(arrayBuffer);
  } catch (cause) {
    // `createAudioContextDecoder` throws its OWN coded errors for "no
    // AudioContext constructor" and "the constructor refused" — both used to
    // arrive here indistinguishable from a rejected decode (the `new Ctor()`
    // call sits inside the async decoder, so its throw lands in this catch).
    // Keeping their code is the whole point: a machine with no audio output
    // device must not be reported as a corrupt file.
    const code = cause instanceof AudioDecodeError ? cause.code : 'AUDIO_DECODE_REJECTED';
    return fail(code, describeThrown(cause), cause);
  }

  // A decoder that resolves with nothing is not a success: `sampleRate === 0`
  // would divide by zero in `resampleLinear`, and zero frames would hand
  // Whisper an empty buffer that "transcribes" to nothing at all.
  if (!(decoded.length > 0) || !(decoded.sampleRate > 0)) {
    return fail(
      'AUDIO_DECODE_EMPTY',
      `decoder returned ${decoded.length} frames at ${decoded.sampleRate} Hz`,
    );
  }

  const mono = downmixToMono(decoded);
  return resampleLinear(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
}

// --- Real-AudioContext Andockpunkt (manual milestone, not unit-tested) ----
//
// Mirrors `opfsAudio.ts`'s bottom section: a narrow structural interface
// reached through `globalThis`, not the ambient DOM `AudioContext`
// identifier (unavailable under `tsconfig.node.json`). `decodeAudioData`
// only works in a real browser main thread, so this is never exercised by
// an automated test in this repo — real-codec decode correctness (Opus/AAC)
// is the plan's stated manual milestone for this unit.

interface AudioContextLike {
  decodeAudioData(arrayBuffer: ArrayBuffer): Promise<DecodedAudioLike>;
  close(): Promise<void>;
}

interface AudioContextCtorLike {
  new (): AudioContextLike;
}

function getAudioContextCtor(): AudioContextCtorLike {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtorLike;
    webkitAudioContext?: AudioContextCtorLike;
  };
  const ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!ctor) {
    throw new AudioDecodeError('AUDIO_CONTEXT_UNAVAILABLE', 'no AudioContext available (main-thread browser only)');
  }
  return ctor;
}

/**
 * Real `AudioDecoderLike` backed by a throwaway `AudioContext`: one context
 * per `decode()` call, closed again immediately after (this module never
 * needs to play the audio back or keep the context alive — decoding is the
 * only thing it's used for). Not wired into any caller yet — U15/U19 supply
 * this (or an equivalent) as `AudioDecodeDeps.decode` once they exist; see
 * this unit's report for what's left.
 */
export function createAudioContextDecoder(): AudioDecoderLike {
  return async (arrayBuffer: ArrayBuffer): Promise<DecodedAudioLike> => {
    const Ctor = getAudioContextCtor();
    let context: AudioContextLike;
    try {
      context = new Ctor();
    } catch (cause) {
      // Constructing an AudioContext is not a formality: a machine with no
      // audio output device, or one under a policy that blocks Web Audio,
      // fails HERE — and used to surface as "unsupported or corrupt data",
      // sending everyone off to inspect a perfectly fine file.
      throw new AudioDecodeError('AUDIO_CONTEXT_FAILED', describeThrown(cause), { cause });
    }
    try {
      return await context.decodeAudioData(arrayBuffer);
    } finally {
      await context.close();
    }
  };
}
