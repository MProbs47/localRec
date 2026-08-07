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
import { describeThrown, sniffContainer, type ContainerInfo } from './audioDiagnostics';

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
  failure: {
    code: AudioDecodeErrorCode;
    cause: unknown;
    /** The container this module already sniffed before decoding — passed on so the collector need not re-read the whole file. */
    container?: ContainerInfo;
    /** The rate the decoding context runs at, so the report's cost estimate matches what actually happened. */
    decodeSampleRate?: number;
    /** One line describing the context that decodes — see `describeDecodingContext`. Supplied here because this module owns the context routing. */
    audioContext?: string;
  },
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
  /** Filled in once the bytes are readable, then handed to the diagnostics so a failure report needs no second read of the file. */
  let container: ContainerInfo | undefined;

  /** Builds the diagnostics (best-effort) and throws the coded error. Every failure below goes through here so none can forget the report. */
  const fail = async (code: AudioDecodeErrorCode, message: string, cause?: unknown): Promise<never> => {
    let details: string | undefined;
    if (deps.diagnose) {
      try {
        details = await deps.diagnose(blob, {
          code,
          cause,
          container,
          decodeSampleRate: TARGET_SAMPLE_RATE,
          audioContext: await describeDecodingContext(),
        });
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

  // Walk the container BEFORE decoding, and while the bytes are still ours:
  // `decodeAudioData` takes ownership of the `ArrayBuffer` and detaches it, so
  // nothing can be read from it afterwards. Cheap regardless of file size —
  // `mdat` is skipped by its declared size, never read. The result travels into
  // the failure path so a report needs no second read of the file.
  container = sniffContainer(new Uint8Array(arrayBuffer));

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

  // What the decode actually cost, once, on the successful path. This is the
  // only way to confirm from a real browser that the 16 kHz decoding context
  // took effect (`decodeAudioData` is specified to resample to the context's
  // rate, but "specified" is not "observed on this machine") — and if a browser
  // ever falls back to its hardware rate, the resample below silently absorbs
  // it and nothing else would ever say so.
  // eslint-disable-next-line no-console
  console.info(
    `[audioDecode] decoded ${decoded.length} frames @ ${decoded.sampleRate} Hz × ${decoded.numberOfChannels} ch` +
      `${decoded.sampleRate === TARGET_SAMPLE_RATE ? ' (target rate, no resample)' : ` → resampling to ${TARGET_SAMPLE_RATE} Hz`}`,
  );

  const mono = downmixToMono(decoded);
  return resampleLinear(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
}

// --- Real-Web-Audio Andockpunkt --------------------------------------------
//
// Mirrors `opfsAudio.ts`'s bottom section: narrow structural interfaces
// reached through `globalThis`, not the ambient DOM `AudioContext` identifier
// (unavailable under `tsconfig.node.json`). Only the final `globalThis`
// default below is untestable in Node; the CHOICE of context is injected and
// covered in `audioDecode.test.ts`, because getting that choice wrong is the
// difference between a 0.6 GB decode and a 1.8 GB one.

interface DecodingContextLike {
  decodeAudioData(arrayBuffer: ArrayBuffer): Promise<DecodedAudioLike>;
  /** Reported in the diagnostics line, so a reader can see which rate the decode actually ran at. */
  readonly sampleRate?: number;
  /** Same — `'suspended'` for an `OfflineAudioContext`, `'running'` for a hardware one that got started. */
  readonly state?: string;
  /**
   * Optional on purpose: `close()` is defined on `AudioContext`, not on
   * `BaseAudioContext`. An `OfflineAudioContext` holds no hardware to release
   * and has no such method, so calling it unconditionally would throw *after*
   * an otherwise successful decode.
   */
  close?(): Promise<void>;
}

/** The Web Audio surface this module reaches for, in preference order. Injected so the routing below is testable without a browser. */
export interface DecodingContextEnvLike {
  OfflineAudioContext?: new (numberOfChannels: number, length: number, sampleRate: number) => DecodingContextLike;
  webkitOfflineAudioContext?: new (numberOfChannels: number, length: number, sampleRate: number) => DecodingContextLike;
  AudioContext?: new () => DecodingContextLike;
  webkitAudioContext?: new () => DecodingContextLike;
}

/**
 * Opens the context `decodeAudioData` will be called on, preferring an
 * **`OfflineAudioContext` at `TARGET_SAMPLE_RATE`**.
 *
 * `decodeAudioData` resamples its result to the sample rate of the context it
 * is called on. A hardware `AudioContext` takes that rate from the OS (48 kHz
 * on the machine in the support report), so the decoded buffer arrives three
 * times larger than anything downstream wants — and then `downmixToMono`
 * allocates a second copy at the same inflated length. Choosing the rate
 * instead makes the decode land directly at 16 kHz: a third of the peak, and
 * `resampleLinear` becomes a passthrough (it returns its input unchanged for
 * equal rates) rather than a third allocation and a lossy interpolation.
 *
 * The second reason is independent of memory: an `OfflineAudioContext` touches
 * no audio hardware at all. A machine with no output device, or a policy that
 * blocks the sound device, can no longer fail here — which removes the entire
 * `AUDIO_CONTEXT_FAILED` class for browsers that have `OfflineAudioContext`.
 *
 * Falls back to a hardware `AudioContext` if `OfflineAudioContext` is absent or
 * refuses the rate (browsers accept a bounded range). The fallback is the old
 * behaviour exactly — a rate optimisation must never be the reason an import
 * fails.
 */
export function createDecodingContext(env: DecodingContextEnvLike): DecodingContextLike {
  const OfflineCtor = env.OfflineAudioContext ?? env.webkitOfflineAudioContext;
  if (OfflineCtor) {
    try {
      // numberOfChannels/length are placeholders for a rendering that never
      // happens — nothing is ever played or rendered through this context.
      return new OfflineCtor(1, 1, TARGET_SAMPLE_RATE);
    } catch {
      // A browser that rejects 16 kHz: fall through rather than fail.
    }
  }

  const Ctor = env.AudioContext ?? env.webkitAudioContext;
  if (!Ctor) {
    throw new AudioDecodeError('AUDIO_CONTEXT_UNAVAILABLE', 'no Web Audio context available (main-thread browser only)');
  }
  try {
    return new Ctor();
  } catch (cause) {
    // Not a formality: a machine with no audio output device, or one under a
    // policy that blocks Web Audio, fails HERE — and used to surface as
    // "unsupported or corrupt data", sending everyone off to inspect a
    // perfectly fine file.
    throw new AudioDecodeError('AUDIO_CONTEXT_FAILED', describeThrown(cause), { cause });
  }
}

/**
 * One line for the diagnostics report describing **the context that decodes** —
 * opened through `createDecodingContext` above, not through a second lookup of
 * its own.
 *
 * That distinction is the whole reason this lives here rather than in
 * `audioDiagnostics.ts`. The collector used to open a hardware `AudioContext`
 * itself, which was right while the decode used one too; since the move to a
 * 16 kHz `OfflineAudioContext` it reported a rate the decode never touched,
 * while the cost estimate two lines below it assumed the real one. Two lines of
 * the same report describing different contexts, and the one a reader would
 * check first was the wrong one.
 *
 * Never throws: a report is worthless if building it can fail.
 */
export async function describeDecodingContext(
  env: DecodingContextEnvLike = globalThis as unknown as DecodingContextEnvLike,
): Promise<string> {
  let context: DecodingContextLike | undefined;
  try {
    context = createDecodingContext(env);
    return `${context.sampleRate ?? 'unknown'} Hz, state ${context.state ?? 'unknown'}`;
  } catch (error) {
    // Both coded context failures land here, and either is itself the
    // diagnosis: no Web Audio at all, or a machine that refused to open one.
    const message = describeThrown(error);
    return error instanceof AudioDecodeError && error.code === 'AUDIO_CONTEXT_UNAVAILABLE'
      ? `unavailable — ${message}`
      : `could not be opened — ${message}`;
  } finally {
    try {
      await context?.close?.();
    } catch {
      /* closing a context opened only to inspect is not worth reporting */
    }
  }
}

/**
 * Real `AudioDecoderLike`: one throwaway decoding context per `decode()` call,
 * released again immediately after (this module never plays anything back —
 * decoding is the only thing a context is used for here).
 */
export function createAudioContextDecoder(
  env: DecodingContextEnvLike = globalThis as unknown as DecodingContextEnvLike,
): AudioDecoderLike {
  return async (arrayBuffer: ArrayBuffer): Promise<DecodedAudioLike> => {
    const context = createDecodingContext(env);
    try {
      return await context.decodeAudioData(arrayBuffer);
    } finally {
      await context.close?.();
    }
  };
}
