/**
 * U10 (R9): the `.webm` Andockpunkt — pure byte passthrough from
 * `recorder.ts`'s `startOpusRecorder({ onChunk })` blobs to an
 * `AppendableFile` (U9). No re-encoding, no re-muxing: the recorder already
 * produces Opus-in-WebM (or the platform's MP4 fallback) chunks that are
 * valid to just concatenate onto the growing output file.
 *
 * Kept as its own tiny file (rather than inlined at the eventual call site,
 * or left as a bare comment) for the same reason as `txtWriter.ts`/
 * `srtWriter.ts`: a small, named, independently testable unit the future
 * worker/app wiring (not built here — see plan U10/U12) can import
 * directly, e.g. `startOpusRecorder(stream, { onChunk: (blob) =>
 * void audioWriter.writeChunk(blob) })`. There is exactly one real
 * transformation to get right (`Blob` -> `Uint8Array` without copying
 * through anything lossy) — that's what `writeChunk` isolates and what its
 * test asserts byte-for-byte, without needing a real `MediaRecorder`.
 */
import type { AppendableFile } from './fileSink';

/**
 * Thin I/O wrapper over one `.webm` `AppendableFile` (U9): opens once at
 * session start (by the caller), then `writeChunk()` once per recorder
 * chunk, in arrival order.
 */
export class AudioWriter {
  readonly #file: AppendableFile;

  constructor(file: AppendableFile) {
    this.#file = file;
  }

  /** Appends one recorder chunk (a `MediaRecorder`/`recorder.ts` `onChunk` blob) verbatim. */
  async writeChunk(chunk: Blob): Promise<void> {
    const buffer = await chunk.arrayBuffer();
    await this.#file.append(new Uint8Array(buffer));
  }

  /** Releases the underlying file. Safe to call once the session is done. */
  async close(): Promise<void> {
    await this.#file.close();
  }
}
