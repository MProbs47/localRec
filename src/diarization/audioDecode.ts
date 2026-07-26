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
 * **Blockwise decode (KTD18) is explicitly NOT built here (YAGNI).** A 4h
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
 * U20 (KTD18's actual owner), not attempted now.
 */
import { resampleLinear } from '../audio/resample';

/** 16 kHz mono is the fixed target for every model in this codebase (KTD10) — diarization (U15) and batch-transcription (U20) both consume exactly this shape. */
export const TARGET_SAMPLE_RATE = 16000;

/**
 * Thrown for any failure in this module — an empty/zero-byte blob, a blob
 * whose bytes couldn't even be read, or a blob the decoder rejected as
 * unsupported/corrupt audio. Callers (U15's diarization trigger, U19/U20's
 * import path) get one clean, typed failure to catch and surface as a UX
 * error, never a raw decoder exception or a hang.
 */
export class AudioDecodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AudioDecodeError';
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

export interface AudioDecodeDeps {
  decode: AudioDecoderLike;
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
  if (blob.size === 0) {
    throw new AudioDecodeError('audioDecode: blob is empty (0 bytes) — nothing to decode');
  }

  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await blob.arrayBuffer();
  } catch (cause) {
    throw new AudioDecodeError('audioDecode: failed to read blob bytes', { cause });
  }

  let decoded: DecodedAudioLike;
  try {
    decoded = await deps.decode(arrayBuffer);
  } catch (cause) {
    throw new AudioDecodeError('audioDecode: failed to decode audio (unsupported or corrupt data)', { cause });
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
    throw new AudioDecodeError('audioDecode: no AudioContext available (main-thread browser only)');
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
    const context = new Ctor();
    try {
      return await context.decodeAudioData(arrayBuffer);
    } finally {
      await context.close();
    }
  };
}
