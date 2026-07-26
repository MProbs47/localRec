/**
 * U9 (R5–R7, AE1, KTD7, KTD8): the `FileSink` abstraction that lets the
 * (U10) `.txt`/`.srt`/`.webm` writers append bytes without knowing *where*
 * those bytes end up. Two implementations sit behind it, chosen by
 * **feature detection, never a user toggle** (KTD7):
 *
 * - `FileSystemAccessSink` — Chromium-desktop's File System Access API.
 *   `createFileSink()`/`restoreFileSink()` obtain a `DirectoryHandleLike`
 *   (R5's "Ordner wählen") and every `openFile(name)` grows a real file at
 *   that location as `append()` is called (R6's live-mirror).
 * - `FallbackSink` — everywhere else (Firefox/Safari/iOS, or a live-mirror
 *   file that lost write permission mid-session). Collects bytes durably in
 *   OPFS (via `OpfsAudioAppender`, reused as-is from `../storage/opfsAudio`
 *   — same append-position/flush discipline, second caller, KTD6) and
 *   offers them back as `Blob`s for an end-of-session "Speichern unter"
 *   (R7, AE1).
 *
 * **Interface shape, and why it's this small (must carry U10).** Both sinks
 * implement exactly `openFile(name): Promise<AppendableFile>` where
 * `AppendableFile` is just `append(data)`/`close()`. U10's writers open
 * each output name once at session start, keep the returned
 * `AppendableFile`, and call `append()` per finalized chunk — they never
 * see which concrete sink they're holding, or whether a write silently
 * degraded to the fallback mid-session (see `SelfHealingAppendableFile`
 * below). This mirrors `ModelEngine`'s austauschbarkeit discipline (KTD1):
 * no feature only one implementation has (e.g. OPFS-specific Blob
 * assembly) leaks into the shared interface.
 *
 * **`close()`-rhythm = a commit *window*, not per-append (KTD7 crash-safety
 * vs. 4h-perf, critical path).** A `FileSystemWritableFileStream` buffers to
 * a swap file until `close()` commits it — an object left open across a
 * crash loses everything written to it, so the plan's "regelmässig close()"
 * matters. But `createWritable({ keepExistingData: true })` makes Chromium
 * copy the **entire existing file** into that swap on every open (O(current
 * size)); reopening once per `append()` would be O(n²) copying over a
 * session — fatal for the large growing `.webm` (Opus, ~100–200 MB over 4h,
 * a chunk every ~5 s: sustained double-digit MB/s of pure copy, working
 * directly against U7's RTF/thermal budget). So `SelfHealingAppendableFile`
 * instead holds **one** writable open across a *commit window* and writes
 * each `append()` incrementally at the tracked, ascending `#position`
 * (several `write({ type:'write', position, data })` before a single
 * `close()`), so the expensive `keepExistingData` copy happens once **per
 * window**, not per append. The window commits (`close()`, then the next
 * `append()` reopens with `keepExistingData: true` at the current position)
 * after `maxAppendsPerCommit` appends **or** `maxCommitIntervalMs` since the
 * window opened — checked on each `append()` against an injected clock (no
 * real timer, deterministic tests), the same batch-rhythm shape as U6's
 * `SessionStore`. `#position` is seeded from `getFile().size` on open and
 * advanced by each write's byte length (same discipline as
 * `OpfsAudioAppender`), so a committed window's bytes are never overwritten
 * by the next.
 *
 * **Why the larger window is crash-safe enough, and what to tune.** The
 * FSA live-mirror file is the *user-visible* mirror, not the crash-safety
 * backstop — U6's append-only OPFS audio (`opfsAudio.ts`) is what
 * guarantees no audio is lost across a crash (KTD6), independent of this
 * file. So a commit window that leaves the last few seconds of the mirror
 * uncommitted is an acceptable trade for avoiding the O(n²) copy: a crash
 * loses at most the current window from the *mirror*, never from the
 * durable OPFS copy. The exact window size (defaults below) and the real
 * large-`.webm` copy cost are an explicit hardware-milestone tuning point —
 * the constants are lean starting guesses, not calibrated numbers.
 *
 * **R7 Grenzfall — permission revoked mid-session, no data loss.** If any
 * live-mirror operation throws — a `write()`, or the periodic window
 * `close()` (revoked permission, handle gone, etc.) — `append()`/`close()`
 * does NOT propagate the error to the caller. It transparently reroutes to
 * a lazily created `FallbackSink` shared by the whole `FileSystemAccessSink`
 * instance. Bytes from **already-committed windows** stay in the real target
 * file (a committed window's `close()` already made them durable). The bytes
 * of the **current, uncommitted window** — which are still only in the swap,
 * not yet in the real file — are held in a small in-memory replay buffer
 * (`#uncommitted`, at most one window's worth) and replayed into the
 * fallback on degrade, so nothing written since the last successful commit
 * is lost; every later `append()` for that file also goes to the fallback.
 * `FileSystemAccessSink.degraded`/`.collectFallbackDownloads()` let a future
 * caller (U12) notice this happened and offer the fallback's download, but
 * U9 itself does not wire any UI for it.
 *
 * **Handle persistence (R6-Fortsetzung über Reload).** `DirectoryHandleLike`
 * values are structured-clonable in a real browser (the plan's own note),
 * so `IndexedDbDirectoryHandleRepository` just `put()`/`get()`s the handle
 * itself in a small dedicated IndexedDB store (own DB, not mixed into
 * `sessionStore.ts` — same `IDB*Like` structural-shim approach, per this
 * unit's brief, just a smaller local subset of it). On next start,
 * `restoreFileSink()` loads it, re-checks `queryPermission`, escalates to
 * `requestPermission` if the answer is `'prompt'`, and falls back cleanly
 * (no throw) if the answer is ever `'denied'`.
 *
 * **Realitätsgrenze — why the reload test is split in two.** `fake-indexeddb`
 * clones values with Node's real `structuredClone` (see
 * `cloneValueForInsertion` in the fake-indexeddb source), which silently
 * *drops* prototype methods from a cloned class instance (only own
 * enumerable data properties survive) and throws on own-property functions
 * — neither matches a real browser's native `FileSystemHandle` clone
 * support, which reconstructs a fully working handle. So no in-Node fake can
 * both (a) round-trip through real `fake-indexeddb` and (b) still have
 * working `queryPermission`/`getFileHandle` methods afterward — that
 * specific combination is unrepresentable outside a real browser. This file
 * is tested at the seam that *is* representable: `directoryHandleStore
 * .test.ts`-equivalent coverage lives in this file's own test file as two
 * separate scenarios — (1) `IndexedDbDirectoryHandleRepository` really
 * persists/retrieves via `fake-indexeddb` (proves the storage plumbing,
 * using a plain data-only stand-in as the stored value), and (2)
 * `restoreFileSink()`'s permission-recheck/fallback behavior is proven
 * against an injected in-memory `DirectoryHandleRepository` holding a fully
 * functional fake handle (proves the router logic). Together they cover the
 * real production path; the actual browser round-trip is this unit's
 * documented manual milestone.
 */

import { OpfsAudioAppender, type SyncAccessHandleLike } from '../storage/opfsAudio';

// --- Shared sink/file abstraction -----------------------------------------

export type FileSinkKind = 'live-mirror' | 'fallback';

/** One appendable output file (`.txt`, `.srt`, `.webm`, ...), independent of which sink is behind it. */
export interface AppendableFile {
  /** Appends `data` at the file's current end. Never rejects for a live-mirror permission failure — see file header. */
  append(data: Uint8Array): Promise<void>;
  /** Releases any resources this file holds open. Safe to call once the session is done. */
  close(): Promise<void>;
}

/** The router's output: either implementation satisfies this and nothing else (KTD1-style austauschbarkeit). */
export interface FileSink {
  readonly kind: FileSinkKind;
  /**
   * The chosen output folder's display name, for a "gespeichert in …" message
   * (U12). File System Access exposes only the folder *name*, never a full OS
   * path — that's the most location detail a browser will ever give. Undefined
   * for the fallback sink (no folder was chosen; the R7 download flow applies).
   */
  readonly name?: string;
  /** Open (creating if needed) one named output file. Call once per name per session and keep the result — see file header. */
  openFile(name: string): Promise<AppendableFile>;
}

// --- File System Access structural surface (see file header for why not the ambient DOM types) ---

export type PermissionStateLike = 'granted' | 'denied' | 'prompt';

export interface WritableFileStreamLike {
  write(params: { type: 'write'; position: number; data: Uint8Array }): Promise<void>;
  close(): Promise<void>;
}

export interface FileHandleLike {
  createWritable(options: { keepExistingData: boolean }): Promise<WritableFileStreamLike>;
  /** Only `size` is used (to seed append position on (re)open) — narrowed structurally, same discipline as `sessionStore.ts`/`opfsAudio.ts`. */
  getFile(): Promise<{ size: number }>;
}

export interface DirectoryHandleLike {
  /** The folder's own name (real `FileSystemDirectoryHandle.name`) — the only location detail the browser exposes, surfaced for the "gespeichert in …" message. */
  readonly name?: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  queryPermission(descriptor: { mode: 'readwrite' }): Promise<PermissionStateLike>;
  requestPermission(descriptor: { mode: 'readwrite' }): Promise<PermissionStateLike>;
}

/** The real global surface this file needs from `showDirectoryPicker` — reached through an injectable env, defaulting to `globalThis`, same pattern as `recorder.ts`'s `getMediaRecorderCtor`. */
export interface FileSystemAccessEnvLike {
  showDirectoryPicker?: () => Promise<DirectoryHandleLike>;
}

function getGlobalEnv(): FileSystemAccessEnvLike {
  return globalThis as unknown as FileSystemAccessEnvLike;
}

/** Pure feature detection — the entire router decision (KTD7: no user switch). Exported so callers (e.g. future U12 copy) can ask without duplicating the check. */
export function hasFileSystemAccess(env: FileSystemAccessEnvLike = getGlobalEnv()): boolean {
  return typeof env.showDirectoryPicker === 'function';
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  // Avoid a copy in the common case (a whole, non-offset buffer); slice only when `data` is a view into a larger buffer.
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
    return data.buffer as ArrayBuffer;
  }
  return data.slice().buffer as ArrayBuffer;
}

// --- Fallback (OPFS-backed, download-at-end) sink --------------------------

/** What `FallbackSink` needs to durably persist one named file — a real `SyncAccessHandleLike` (reused from `opfsAudio.ts`) plus a way to read everything written back as a `Blob` for the end-of-session download (R7). */
export interface FallbackFileHandle {
  handle: SyncAccessHandleLike;
  readBlob(): Promise<Blob>;
}

/** Opens (creating if needed) the durable backing store for one named fallback file. Injectable — the real implementation is the OPFS Andockpunkt below; tests supply an in-memory fake. */
export type FallbackFileOpener = (name: string) => Promise<FallbackFileHandle>;

class FallbackAppendableFile implements AppendableFile {
  readonly #appender: OpfsAudioAppender;
  readonly #handle: FallbackFileHandle;

  constructor(handle: FallbackFileHandle) {
    this.#handle = handle;
    this.#appender = new OpfsAudioAppender(handle.handle);
  }

  async append(data: Uint8Array): Promise<void> {
    this.#appender.append(toArrayBuffer(data));
  }

  async close(): Promise<void> {
    this.#appender.close();
  }

  toBlob(): Promise<Blob> {
    return this.#handle.readBlob();
  }
}

/**
 * R7/AE1's "intern crash-sicher aufnehmen → am Ende Speichern unter". Every
 * named file gets its own OPFS-backed `OpfsAudioAppender` (durable,
 * append-only, same discipline as the session's audio file, KTD6) so a
 * crash mid-fallback-session loses no more than U6 already tolerates.
 * `collectDownloads()` is the "am Ende" step: reads every file written so
 * far back as a `Blob`, ready for a save-as prompt (not wired to any UI
 * here — U12's job).
 */
export class FallbackSink implements FileSink {
  readonly kind: FileSinkKind = 'fallback';
  readonly #open: FallbackFileOpener;
  readonly #files = new Map<string, FallbackAppendableFile>();

  constructor(open: FallbackFileOpener = defaultFallbackFileOpener) {
    this.#open = open;
  }

  async openFile(name: string): Promise<AppendableFile> {
    const existing = this.#files.get(name);
    if (existing) return existing;
    const handle = await this.#open(name);
    const file = new FallbackAppendableFile(handle);
    this.#files.set(name, file);
    return file;
  }

  /** Every file opened so far, as `Blob`s — the R7 "Speichern unter" offer. Empty if nothing was ever written. */
  async collectDownloads(): Promise<Map<string, Blob>> {
    const result = new Map<string, Blob>();
    for (const [name, file] of this.#files) {
      result.set(name, await file.toBlob());
    }
    return result;
  }
}

// --- Fallback OPFS Andockpunkt (manual milestone, not unit-tested) --------
//
// Mirrors `opfsAudio.ts`'s own real-OPFS Andockpunkt, extended with
// `getFile()` (a separate, simpler OPFS call than the sync access handle)
// to read the finished file back as a `Blob` for `collectDownloads()`. Not
// reachable from any test — no OPFS in Node/Vitest (same Realitätsgrenze as
// `opfsAudio.ts`).

interface FallbackOpfsFileHandleLike {
  createSyncAccessHandle(): Promise<SyncAccessHandleLike>;
  getFile(): Promise<Blob>;
}

interface FallbackOpfsDirectoryLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FallbackOpfsFileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

function getOpfsStorage(): { getDirectory(): Promise<FallbackOpfsDirectoryLike> } {
  return (globalThis as unknown as { navigator: { storage: { getDirectory(): Promise<FallbackOpfsDirectoryLike> } } })
    .navigator.storage;
}

async function defaultFallbackFileOpener(name: string): Promise<FallbackFileHandle> {
  const root = await getOpfsStorage().getDirectory();
  const fileHandle = await root.getFileHandle(name, { create: true });
  const handle = await fileHandle.createSyncAccessHandle();
  return { handle, readBlob: () => fileHandle.getFile() };
}

/**
 * S2 (privacy hardening, F2) — the in-app "Alle Aufnahmen löschen" wipe's
 * OPFS half. `FallbackSink` writes its files directly at the OPFS root
 * (see `defaultFallbackFileOpener` above — there is no dedicated
 * subdirectory, unlike `modelCache.ts`'s `models/<setId>/`), so this deletes
 * the fixed set of names `RecordingCoordinator`/`writeSpeakerTranscripts`
 * ever open there: the base `DEFAULT_BASE_NAME` (`transkript`, duplicated
 * here rather than imported — same "avoid a cross-module coupling neither
 * module otherwise needs" reasoning `writeSpeakerTranscripts.ts` already
 * documents for the same constant) `.txt`/`.srt`/`.webm`, plus the post-hoc
 * `-sprecher.txt`/`.srt` pair. Mirrors `modelCache.ts`'s `deleteModelSet`
 * posture: unconditional per-name delete, no-op if a name is absent.
 * Resolves quietly whenever OPFS itself isn't available (jsdom/tests, or a
 * live-mirror session that never touched the fallback) — this is cleanup,
 * not a load-bearing step, so no error should ever propagate to a caller.
 */
const FALLBACK_ARTIFACT_BASE_NAME = 'transkript';
const FALLBACK_ARTIFACT_NAMES = [
  `${FALLBACK_ARTIFACT_BASE_NAME}.txt`,
  `${FALLBACK_ARTIFACT_BASE_NAME}.srt`,
  `${FALLBACK_ARTIFACT_BASE_NAME}.webm`,
  `${FALLBACK_ARTIFACT_BASE_NAME}-sprecher.txt`,
  `${FALLBACK_ARTIFACT_BASE_NAME}-sprecher.srt`,
];

export async function deleteFallbackArtifacts(): Promise<void> {
  try {
    const root = await getOpfsStorage().getDirectory();
    for (const name of FALLBACK_ARTIFACT_NAMES) {
      try {
        await root.removeEntry(name);
      } catch {
        // already absent — a no-op, same as modelCache.ts's deleteFile
      }
    }
  } catch {
    // OPFS unavailable in this environment (jsdom/tests, or a browser
    // without it) — nothing to delete.
  }
}

// --- Live-mirror (File System Access) sink ---------------------------------

/**
 * Commit-window thresholds for the live-mirror sink (see file header for the
 * O(n²)-copy rationale). Lean starting guesses — an explicit
 * hardware-milestone tuning point, not calibrated numbers.
 */
export const DEFAULT_MAX_APPENDS_PER_COMMIT = 8;
export const DEFAULT_MAX_COMMIT_INTERVAL_MS = 10_000;

export interface LiveMirrorCommitOptions {
  /** Commit (close + reopen) the current window after this many appends. */
  maxAppendsPerCommit?: number;
  /** Commit the current window once this long has passed since it opened, even below the append count. */
  maxCommitIntervalMs?: number;
  /** Injected clock (ms) — defaults to `Date.now`; overridden in tests for deterministic window timing. */
  now?: () => number;
}

/**
 * Wraps one live-mirror output file. Holds a single writable open across a
 * commit window, writing each `append()` incrementally at the tracked
 * position, and only closes+reopens (the expensive `keepExistingData` copy)
 * once per window — see the file header for the crash-safety-vs-perf
 * trade-off. On any failure (a `write()` or a periodic window `close()`),
 * silently and permanently reroutes this file (and only this file's future
 * writes) to a fallback file opened through `openFallback`, replaying the
 * current uncommitted window's bytes so none are lost — R7's Grenzfall, no
 * thrown error.
 */
class SelfHealingAppendableFile implements AppendableFile {
  readonly #fileHandle: FileHandleLike;
  readonly #openFallback: () => Promise<AppendableFile>;
  readonly #maxAppends: number;
  readonly #maxWindowMs: number;
  readonly #now: () => number;

  #position: number;
  #writable: WritableFileStreamLike | null = null;
  #windowOpenedAt = 0;
  #appendsInWindow = 0;
  /** Chunks written since the last successful commit — replayed to the fallback if this window fails to commit (R7, no data loss). At most one window's worth. */
  #uncommitted: Uint8Array[] = [];
  #degraded: AppendableFile | null = null;

  constructor(
    fileHandle: FileHandleLike,
    initialSize: number,
    openFallback: () => Promise<AppendableFile>,
    options: LiveMirrorCommitOptions = {},
  ) {
    this.#fileHandle = fileHandle;
    this.#position = initialSize;
    this.#openFallback = openFallback;
    this.#maxAppends = options.maxAppendsPerCommit ?? DEFAULT_MAX_APPENDS_PER_COMMIT;
    this.#maxWindowMs = options.maxCommitIntervalMs ?? DEFAULT_MAX_COMMIT_INTERVAL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  async append(data: Uint8Array): Promise<void> {
    if (this.#degraded) {
      await this.#degraded.append(data);
      return;
    }
    // Track for a possible replay-on-degrade BEFORE attempting any FS op, so
    // a failing write's chunk is included in the fallback replay too.
    this.#uncommitted.push(data);
    try {
      if (!this.#writable) {
        this.#writable = await this.#fileHandle.createWritable({ keepExistingData: true });
        this.#windowOpenedAt = this.#now();
        this.#appendsInWindow = 0;
      }
      await this.#writable.write({ type: 'write', position: this.#position, data });
      this.#position += data.byteLength;
      this.#appendsInWindow += 1;

      const dueByCount = this.#appendsInWindow >= this.#maxAppends;
      const dueByAge = this.#now() - this.#windowOpenedAt >= this.#maxWindowMs;
      if (dueByCount || dueByAge) {
        await this.#commit();
      }
    } catch {
      await this.#degrade();
    }
  }

  async close(): Promise<void> {
    if (!this.#degraded) {
      try {
        await this.#commit(); // final commit of any still-open window
      } catch {
        await this.#degrade();
      }
    }
    await this.#degraded?.close();
  }

  /**
   * Closes the open window's writable (committing its writes to the real
   * file durably) and clears the replay buffer. No-op if no window is open.
   * May throw (a failing `close()`) — the caller degrades in that case.
   */
  async #commit(): Promise<void> {
    const writable = this.#writable;
    if (!writable) return;
    this.#writable = null; // dead either way after this; never double-closed on the degrade path
    await writable.close();
    this.#uncommitted = []; // reached only on a *successful* close — the window is now durable
    this.#appendsInWindow = 0;
  }

  /**
   * R7 Grenzfall: reroute this file to the fallback and replay every
   * uncommitted-window chunk into it, so nothing written since the last
   * successful commit is lost. Idempotent-safe to reach only once (guarded
   * by the `#degraded` check in `append`/`close`).
   */
  async #degrade(): Promise<void> {
    this.#writable = null;
    const fallback = await this.#openFallback();
    this.#degraded = fallback;
    for (const chunk of this.#uncommitted) {
      await fallback.append(chunk);
    }
    this.#uncommitted = [];
  }
}

/**
 * R5/R6: the Chromium-desktop live-mirror `FileSink`, backed by one
 * `DirectoryHandleLike` chosen up front. All files that degrade mid-session
 * (R7 Grenzfall) share a single lazily created `FallbackSink` instance, so
 * `collectFallbackDownloads()` returns every degraded file's data together.
 */
export class FileSystemAccessSink implements FileSink {
  readonly kind: FileSinkKind = 'live-mirror';
  /** The chosen folder's name (for the "gespeichert in …" message) — see `FileSink.name`. */
  readonly name?: string;
  readonly #dir: DirectoryHandleLike;
  readonly #fallbackFileOpener: FallbackFileOpener | undefined;
  readonly #commitOptions: LiveMirrorCommitOptions;
  #fallback: FallbackSink | null = null;

  constructor(
    dir: DirectoryHandleLike,
    fallbackFileOpener?: FallbackFileOpener,
    commitOptions: LiveMirrorCommitOptions = {},
  ) {
    this.#dir = dir;
    this.name = dir.name;
    this.#fallbackFileOpener = fallbackFileOpener;
    this.#commitOptions = commitOptions;
  }

  async openFile(name: string): Promise<AppendableFile> {
    const fileHandle = await this.#dir.getFileHandle(name, { create: true });
    const file = await fileHandle.getFile();
    return new SelfHealingAppendableFile(fileHandle, file.size, () => this.#openFallbackFile(name), this.#commitOptions);
  }

  #openFallbackFile(name: string): Promise<AppendableFile> {
    if (!this.#fallback) this.#fallback = new FallbackSink(this.#fallbackFileOpener);
    return this.#fallback.openFile(name);
  }

  /** Whether any file degraded to the internal fallback mid-session — for a future "here's what we saved separately" UX (not wired here). */
  get degraded(): boolean {
    return this.#fallback !== null;
  }

  /** Every degraded file's data as `Blob`s, or an empty map if nothing ever degraded. */
  async collectFallbackDownloads(): Promise<Map<string, Blob>> {
    return this.#fallback ? this.#fallback.collectDownloads() : new Map();
  }
}

// --- Directory-handle persistence (R6-Fortsetzung über Reload) ------------
//
// A small, dedicated IndexedDB store — deliberately not mixed into
// `sessionStore.ts` (this unit's brief). Same narrow `IDB*Like` structural
// shim approach as `sessionStore.ts`, sized to exactly what a single-record
// handle store needs (`put`/`get`, no indexes/cursors).

interface IDBRequestLike<T> {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  readonly result: T;
  readonly error: unknown;
}

interface IDBObjectStoreLike {
  put(value: unknown): IDBRequestLike<unknown>;
  get(key: unknown): IDBRequestLike<unknown>;
}

interface IDBTransactionLike {
  objectStore(name: string): IDBObjectStoreLike;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  readonly error: unknown;
}

interface IDBDatabaseLike {
  transaction(storeNames: string[], mode: 'readonly' | 'readwrite'): IDBTransactionLike;
  createObjectStore(name: string, options: { keyPath: string }): IDBObjectStoreLike;
  readonly objectStoreNames: { contains(name: string): boolean };
}

interface IDBOpenRequestLike extends IDBRequestLike<IDBDatabaseLike> {
  onupgradeneeded: (() => void) | null;
}

interface IDBFactoryLike {
  open(name: string, version: number): IDBOpenRequestLike;
}

function getIndexedDB(): IDBFactoryLike {
  return (globalThis as unknown as { indexedDB: IDBFactoryLike }).indexedDB;
}

function promisifyRequest<T>(request: IDBRequestLike<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('directory handle store request failed'));
  });
}

const HANDLE_DB_VERSION = 1;
const HANDLE_STORE = 'directoryHandle';
/** Fixed single record key — only one output folder is ever chosen at a time (R5). */
const HANDLE_KEY = 'output-directory';

export const DEFAULT_HANDLE_DB_NAME = 'meeting-recorder-output-handle';

/** Persists (and retrieves) the one chosen output-directory handle across a reload. */
export interface DirectoryHandleRepository {
  save(handle: DirectoryHandleLike): Promise<void>;
  load(): Promise<DirectoryHandleLike | undefined>;
}

/**
 * Real production repository. In a real browser, `DirectoryHandleLike`
 * values are structured-clonable, so this just `put()`/`get()`s the handle
 * itself — no serialization step. See file header for why that specific
 * property makes this file's own fake-indexeddb-backed test necessarily
 * narrower than a full "store a working fake handle" round-trip.
 */
export class IndexedDbDirectoryHandleRepository implements DirectoryHandleRepository {
  readonly #dbName: string;
  #dbPromise: Promise<IDBDatabaseLike> | null = null;

  constructor(dbName: string = DEFAULT_HANDLE_DB_NAME) {
    this.#dbName = dbName;
  }

  #open(): Promise<IDBDatabaseLike> {
    if (!this.#dbPromise) {
      this.#dbPromise = new Promise((resolve, reject) => {
        const request = getIndexedDB().open(this.#dbName, HANDLE_DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(HANDLE_STORE)) {
            db.createObjectStore(HANDLE_STORE, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('directory handle store open failed'));
      });
    }
    return this.#dbPromise;
  }

  async save(handle: DirectoryHandleLike): Promise<void> {
    const db = await this.#open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([HANDLE_STORE], 'readwrite');
      tx.objectStore(HANDLE_STORE).put({ id: HANDLE_KEY, handle });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('directory handle store save failed'));
    });
  }

  async load(): Promise<DirectoryHandleLike | undefined> {
    const db = await this.#open();
    const tx = db.transaction([HANDLE_STORE], 'readonly');
    const request = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY) as IDBRequestLike<
      { id: string; handle: DirectoryHandleLike } | undefined
    >;
    const record = await promisifyRequest(request);
    return record?.handle;
  }
}

let defaultRepository: IndexedDbDirectoryHandleRepository | null = null;
function getDefaultRepository(): IndexedDbDirectoryHandleRepository {
  if (!defaultRepository) defaultRepository = new IndexedDbDirectoryHandleRepository();
  return defaultRepository;
}

// --- Router (feature-detection decides, R5/AE1/KTD7) -----------------------

export interface FileSinkDependencies {
  /** Feature-detection & picker surface — defaults to `globalThis`. */
  env?: FileSystemAccessEnvLike;
  /** Directory-handle persistence — defaults to the real IndexedDB-backed repository. */
  repository?: DirectoryHandleRepository;
  /** Where a live-mirror file's writes go once it degrades — defaults to a real OPFS-backed fallback. */
  fallbackFileOpener?: FallbackFileOpener;
  /** Live-mirror commit-window tuning (see `LiveMirrorCommitOptions`) — defaults apply if omitted. */
  commitOptions?: LiveMirrorCommitOptions;
}

async function ensureReadWritePermission(dir: DirectoryHandleLike): Promise<PermissionStateLike> {
  const current = await dir.queryPermission({ mode: 'readwrite' });
  // Only 'prompt' is worth escalating — that's the state that means "ask the
  // user". 'granted' needs no escalation; 'denied' means the browser won't
  // show a prompt anyway, so asking again would be a pointless round-trip
  // (and, per R7, should go straight to the clean fallback).
  if (current !== 'prompt') return current;
  return dir.requestPermission({ mode: 'readwrite' });
}

/**
 * R5's "Ordner wählen": the fresh-choice entry point. Feature-detects
 * (KTD7 — no user switch); where the API is missing, returns a
 * `FallbackSink` straight away (R7, nothing to choose). Where it's present,
 * triggers `showDirectoryPicker()` (a real user-gesture-gated call in
 * production; injected via `deps.env` in tests), persists the resulting
 * handle for the next reload (R6-Fortsetzung), and returns the live-mirror
 * sink (R6, AE1).
 */
export async function createFileSink(deps: FileSinkDependencies = {}): Promise<FileSink> {
  const env = deps.env ?? getGlobalEnv();
  if (!hasFileSystemAccess(env)) {
    return new FallbackSink(deps.fallbackFileOpener);
  }
  const dir = await env.showDirectoryPicker!();
  const repository = deps.repository ?? getDefaultRepository();
  await repository.save(dir);
  return new FileSystemAccessSink(dir, deps.fallbackFileOpener, deps.commitOptions);
}

/**
 * R6-Fortsetzung über Reload: tries to continue a previously chosen output
 * folder without re-prompting the picker. Returns `undefined` when there is
 * nothing to continue (API unavailable, or no folder was ever chosen yet in
 * this browser profile) — the caller's normal `createFileSink()` flow
 * applies in that case. Returns a `FallbackSink` (never throws) if the
 * persisted handle's permission comes back anything other than `'granted'`
 * after `queryPermission`/`requestPermission` — R7's Grenzfall.
 */
export async function restoreFileSink(deps: FileSinkDependencies = {}): Promise<FileSink | undefined> {
  const env = deps.env ?? getGlobalEnv();
  if (!hasFileSystemAccess(env)) return undefined;

  const repository = deps.repository ?? getDefaultRepository();
  const dir = await repository.load();
  if (!dir) return undefined;

  const permission = await ensureReadWritePermission(dir);
  if (permission !== 'granted') {
    return new FallbackSink(deps.fallbackFileOpener);
  }
  return new FileSystemAccessSink(dir, deps.fallbackFileOpener, deps.commitOptions);
}
