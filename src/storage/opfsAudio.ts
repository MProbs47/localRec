/**
 * Append-only OPFS audio persistence for U6 (R8, KTD6). Opus (or platform-
 * fallback) chunks arrive from `recorder.ts`'s `onChunk` callback as `Blob`s
 * every `RECORDER_TIMESLICE_MS`; this file owns turning that stream into a
 * single growing on-disk file via an OPFS `createSyncAccessHandle` —
 * append-only, same discipline as `sessionStore.ts`'s segment batches (KTD6:
 * "nichts verlässt append-only" applies to audio too, not just text).
 *
 * **Why the append-position/flush logic is separated from the real OPFS
 * handle (`SyncAccessHandleLike`).** `createSyncAccessHandle()` only exists
 * in a Worker, and only in a real browser — there is no OPFS in Node/Vitest
 * (plan's explicit "Realitätsgrenze": real OPFS access is a manual
 * milestone, not automatable here). The plan's own execution note asks for
 * exactly this: "kapsle den Handle-Zugriff hinter einer schmalen,
 * injizierbaren Schnittstelle ... sodass die Positions-/Append-Logik von
 * opfsAudio.ts mit einem Fake-Handle testbar ist". `OpfsAudioAppender`
 * below only ever calls the four `SyncAccessHandleLike` methods — never
 * reaches for the real global — so `opfsAudio.test.ts` can drive the exact
 * same position-tracking/flush-cadence code path a real worker would, using
 * an in-memory fake in place of the real handle.
 *
 * **Position bookkeeping.** A `SyncAccessHandle` has no implicit "append"
 * mode — every `write()` takes an explicit byte offset. `OpfsAudioAppender`
 * seeds its position from `handle.getSize()` at construction (so it resumes
 * correctly at the existing file's end, whether that's 0 for a brand new
 * session file or a nonzero size for a re-opened one after e.g. a mid-
 * session worker restart) and then advances that position by exactly the
 * `written` byte count `write()` reports after every call — never assumes
 * the whole buffer was written in one call, matching the actual
 * `SyncAccessHandle.write()` contract.
 *
 * **Why `append()` takes an `ArrayBuffer`, not a `Blob`.** `Blob.arrayBuffer()`
 * is async; `SyncAccessHandle.write()` is deliberately *synchronous*
 * (that's the entire point of the "Sync" in the name — it's what makes
 * OPFS writes safe/fast from a Worker without ceding the microtask queue
 * mid-write). Keeping `append()` itself synchronous keeps the position math
 * here race-free and directly testable without `await` noise; the future
 * worker wiring (`transcription.worker.ts`, not built in this unit — see
 * `openOpfsAudioAppender()` below for the documented real-handle
 * Andockpunkt) does the one-time `await blob.arrayBuffer()` conversion
 * right before calling `append()`.
 */

/**
 * The exact structural slice of the real `FileSystemSyncAccessHandle` this
 * file depends on. Deliberately not the ambient DOM type (unavailable under
 * `tsconfig.node.json`, see `sessionStore.ts`'s header for the same
 * constraint) — a fake implementing just these four methods is a fully
 * valid `SyncAccessHandleLike` for testing, and the real browser handle
 * satisfies it structurally at runtime without being named here.
 */
export interface SyncAccessHandleLike {
  getSize(): number;
  write(buffer: ArrayBuffer, options: { at: number }): number;
  flush(): void;
  close(): void;
}

/** Flush the handle to disk after this many newly written bytes accumulate since the last flush — bounds how much audio a crash between flushes could lose without flushing on every single small write. */
export const DEFAULT_FLUSH_EVERY_BYTES = 256 * 1024; // 256 KiB — a handful of 5s Opus chunks' worth (opus is low-bitrate), so a crash loses at most a few seconds of audio without forcing a flush syscall per chunk.

export interface OpfsAudioAppenderOptions {
  flushEveryBytes?: number;
}

/**
 * Tracks the append position for one OPFS audio file and drives writes
 * through an injected `SyncAccessHandleLike`. One instance per recording
 * session's audio file — construct it once the handle is open, `append()`
 * once per completed recorder chunk, `close()` on clean session stop.
 */
export class OpfsAudioAppender {
  readonly #handle: SyncAccessHandleLike;
  readonly #flushEveryBytes: number;

  #position: number;
  #bytesSinceFlush = 0;

  constructor(handle: SyncAccessHandleLike, options: OpfsAudioAppenderOptions = {}) {
    this.#handle = handle;
    this.#flushEveryBytes = options.flushEveryBytes ?? DEFAULT_FLUSH_EVERY_BYTES;
    this.#position = handle.getSize(); // resume at the existing file's end (0 for a fresh file)
  }

  /** Current file size — always equal to the append position, since this class only ever appends. */
  get size(): number {
    return this.#position;
  }

  /**
   * Writes `chunk` at the current end-of-file position and advances the
   * position by however many bytes `write()` actually reported (never
   * assumed to be the whole buffer). Periodically flushes once
   * `flushEveryBytes` have accumulated since the last flush. Returns the new
   * file size after the write.
   */
  append(chunk: ArrayBuffer): number {
    const written = this.#handle.write(chunk, { at: this.#position });
    this.#position += written;
    this.#bytesSinceFlush += written;
    if (this.#bytesSinceFlush >= this.#flushEveryBytes) {
      this.flush();
    }
    return this.#position;
  }

  /** Force-flushes the handle to disk now, regardless of `flushEveryBytes`. Safe to call speculatively (e.g. a periodic timer, or right before a clean `close()`). */
  flush(): void {
    this.#handle.flush();
    this.#bytesSinceFlush = 0;
  }

  /** Flushes then closes the underlying handle. The appender must not be used after this. */
  close(): void {
    this.flush();
    this.#handle.close();
  }
}

// --- Real-OPFS Andockpunkt (manual milestone, not unit-tested) -----------
//
// The pieces below are the documented wiring point a future
// `transcription.worker.ts` change would use to get a real
// `SyncAccessHandleLike` — kept narrow/structural for the same reason as
// `SyncAccessHandleLike` above, and, like `recorder.ts`'s
// `getMediaRecorderCtor()`, reached through `globalThis` rather than the
// ambient DOM identifiers (`FileSystemDirectoryHandle` etc.) that don't
// exist under `tsconfig.node.json`. `createSyncAccessHandle()` only works in
// a real Worker, so this is never exercised by an automated test in this
// repo — real OPFS append-throughput/crash behavior is the plan's stated
// manual milestone.

interface OpfsFileHandleLike {
  createSyncAccessHandle(): Promise<SyncAccessHandleLike>;
}

interface OpfsDirectoryLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandleLike>;
}

interface StorageManagerLike {
  getDirectory(): Promise<OpfsDirectoryLike>;
}

function getOpfsStorage(): StorageManagerLike {
  return (globalThis as unknown as { navigator: { storage: StorageManagerLike } }).navigator.storage;
}

/**
 * Opens (creating if needed) `fileName` in the OPFS root and returns an
 * `OpfsAudioAppender` wrapping its real sync access handle. Worker-only at
 * runtime (per the OPFS spec) — not called anywhere yet (U6 deliberately
 * doesn't wire persistence into `transcription.worker.ts`, see that file's
 * header and this unit's report), and not unit-tested (no OPFS in Node).
 */
export async function openOpfsAudioAppender(
  fileName: string,
  options: OpfsAudioAppenderOptions = {},
): Promise<OpfsAudioAppender> {
  const root = await getOpfsStorage().getDirectory();
  const fileHandle = await root.getFileHandle(fileName, { create: true });
  const handle = await fileHandle.createSyncAccessHandle();
  return new OpfsAudioAppender(handle, options);
}
