/**
 * MediaRecorder-based Opus (or platform-fallback) capture, running
 * parallel to the AudioWorklet/ring-buffer pipeline (`worklet-processor.js`,
 * `ringBuffer.ts`) that feeds the model. This recorder exists purely to
 * produce the `.webm`/`.mp4` audio artifact the user keeps (R9) — it is
 * intentionally independent from the ring buffer: losing a resampled
 * model-input sample is a transcription-quality problem, losing a recorder
 * chunk is a saved-file problem, and KTD6 (append-only, crash-safe) wants
 * each timeslice's blob handed off to the caller as soon as it completes,
 * not batched until the end of the session.
 *
 * No React/DOM-UI here (per plan) — a thin, framework-free wrapper so U6
 * (persistence) and U9/U10 (file mirroring/writers) can consume it
 * directly.
 *
 * Type note: this file is imported by `recorder.test.ts`, which — like the
 * rest of `src/**` test files — is type-checked under `tsconfig.node.json`
 * (Node-only libs, no "DOM") so Vitest can run in a plain Node
 * environment. `MediaStream`/`MediaRecorder` only exist in the "DOM" lib
 * that `tsconfig.json` uses, so this file can't reference those ambient
 * names directly without breaking the Node-side typecheck — same problem
 * and same fix as `transcription.worker.ts`'s `WorkerScope`: narrow local
 * structural interfaces covering exactly what's used, satisfied
 * structurally by the real DOM types at runtime. `Blob` is unaffected —
 * Node's own global types declare it too, so it's used directly.
 */
interface MediaStreamLike {
  readonly id: string;
}

interface MediaRecorderDataEvent {
  data: Blob;
}

interface MediaRecorderLike {
  ondataavailable: ((event: MediaRecorderDataEvent) => void) | null;
  start(timesliceMs?: number): void;
  stop(): void;
}

interface MediaRecorderCtorLike {
  new (stream: MediaStreamLike, options?: { mimeType: string }): MediaRecorderLike;
  isTypeSupported(mimeType: string): boolean;
}

/**
 * Preferred container/codec, most-preferred first. `audio/webm;codecs=opus`
 * is what Chromium/Firefox desktop support (small files, good quality);
 * Safari/iOS support neither WebM nor Opus in `MediaRecorder` and need
 * `audio/mp4` (AAC) instead (plan's U3 approach note). No user-facing
 * toggle — this is pure feature detection, the browser decides.
 */
export const PREFERRED_RECORDER_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/mp4'] as const;

/**
 * Picks the first supported MIME type from `PREFERRED_RECORDER_MIME_TYPES`.
 * `isTypeSupported` is injected rather than calling
 * `MediaRecorder.isTypeSupported` directly so this selection logic is
 * testable without a real `MediaRecorder` (which doesn't exist in
 * Node/Vitest). Returns `undefined` if neither is supported, in which case
 * the caller should let `MediaRecorder` fall back to its own default
 * rather than force an unsupported type.
 */
export function selectRecorderMimeType(
  isTypeSupported: (mimeType: string) => boolean,
): string | undefined {
  return PREFERRED_RECORDER_MIME_TYPES.find((mimeType) => isTypeSupported(mimeType));
}

/**
 * `timeslice` for `MediaRecorder.start(timeslice)`, in milliseconds — how
 * often a completed chunk is handed to `onChunk`. Chosen at the low/durable
 * end of the plan's 5-10s window: over a 4h session that's ~2880 chunks
 * (cheap for U6's append-only IndexedDB/OPFS writes), and it bounds how
 * much recorded audio a mid-session crash can lose to 5s — durability
 * matters more here than shaving the chunk count further.
 */
export const RECORDER_TIMESLICE_MS = 5000;

export interface OpusRecorderOptions {
  /** Called with each completed chunk as soon as MediaRecorder emits it. */
  onChunk: (blob: Blob) => void;
  /** Overrides `RECORDER_TIMESLICE_MS`, mainly for tests/tuning. */
  timesliceMs?: number;
}

/**
 * Reaches the real browser `MediaRecorder` global through `globalThis`
 * rather than spelling the ambient DOM identifier `MediaRecorder` at the
 * top level — see the file header for why that matters for the Node-side
 * typecheck. Not itself unit-tested (there is no real `MediaRecorder` to
 * fetch under Vitest); only ever called from `startOpusRecorder`, which is
 * the documented "Realitätsgrenze" manual-milestone surface.
 */
function getMediaRecorderCtor(): MediaRecorderCtorLike {
  return (globalThis as unknown as { MediaRecorder: MediaRecorderCtorLike }).MediaRecorder;
}

/**
 * Starts a parallel MediaRecorder capture on `stream` and returns the
 * recorder so the caller can `stop()` it later. Not unit-testable
 * end-to-end (`MediaRecorder`/`MediaStream` don't exist outside a real
 * browser — plan's "Realitäts-Grenze"); `selectRecorderMimeType` above
 * carries the tested logic this function delegates to.
 */
export function startOpusRecorder(
  stream: MediaStreamLike,
  options: OpusRecorderOptions,
): MediaRecorderLike {
  const MediaRecorderCtor = getMediaRecorderCtor();
  const mimeType = selectRecorderMimeType((candidate) => MediaRecorderCtor.isTypeSupported(candidate));
  const recorder = mimeType
    ? new MediaRecorderCtor(stream, { mimeType })
    : new MediaRecorderCtor(stream);

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      options.onChunk(event.data);
    }
  };

  recorder.start(options.timesliceMs ?? RECORDER_TIMESLICE_MS);
  return recorder;
}
