// Realitätsgrenze: neither the File System Access API nor OPFS exist in
// Node/Vitest (see `fileSink.ts`'s header). Every fake below implements
// exactly the narrow structural interface the production code depends on,
// so the router/append/permission-fallback logic in `fileSink.ts` runs for
// real against these fakes — nothing about *that* logic is mocked away.
// Real picker/live-write/OPFS behavior stays the plan's documented manual
// milestone.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  createFileSink,
  deleteFallbackArtifacts,
  DEFAULT_HANDLE_DB_NAME,
  FallbackSink,
  FileSystemAccessSink,
  hasFileSystemAccess,
  IndexedDbDirectoryHandleRepository,
  restoreFileSink,
  type DirectoryHandleLike,
  type DirectoryHandleRepository,
  type FallbackFileHandle,
  type FallbackFileOpener,
  type FileHandleLike,
  type FileSystemAccessEnvLike,
  type LiveMirrorCommitOptions,
  type PermissionStateLike,
  type WritableFileStreamLike,
} from './fileSink';

// A never-committing clock default keeps the age threshold out of the way in
// tests that only exercise the append-count path; per-test clocks override it.
const commitByCountOnly = (maxAppendsPerCommit: number): LiveMirrorCommitOptions => ({
  maxAppendsPerCommit,
  maxCommitIntervalMs: Number.MAX_SAFE_INTEGER,
  now: () => 0,
});

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// --- Fakes: File System Access side ---------------------------------------

/**
 * Models the real Chromium FileSystemWritableFileStream commit semantics
 * that the commit-window design hinges on: `createWritable({ keepExisting
 * data: true })` opens a **swap** buffer seeded from the committed file;
 * `write()` mutates only that swap; the committed file (`bytes`,
 * `getFile().size`) updates ONLY on a successful `close()`. Uncommitted
 * writes are therefore invisible in `bytes` until their window is closed —
 * exactly why a mid-window degrade must replay the uncommitted bytes to the
 * fallback (they never reached the real file).
 *
 * Implements `FallbackFileHandle` (not just `FileHandleLike`) so this ONE
 * fake serves both the live-mirror sink's file handle AND the fallback
 * sink's OPFS-root file handle — exactly like production, where a single
 * real `FileSystemFileHandle` (be it FSA-picker- or OPFS-root-sourced)
 * satisfies both structurally (see `fileSink.ts`'s header). `getFile()`
 * returns a real `Blob`, which already has `.size`, so it satisfies
 * `FileHandleLike.getFile()`'s narrower `{size}` contract too.
 */
class FakeFileHandle implements FallbackFileHandle {
  #committed = new Uint8Array(0);
  writesLog: { position: number; length: number }[] = [];
  createWritableCalls = 0;
  failNextWrite = false;
  failNextClose = false;

  async getFile(): Promise<Blob> {
    // `.slice().buffer` cast to plain `ArrayBuffer`: TS 7's generic
    // `Uint8Array<ArrayBufferLike>` (from `#committed`'s `new Uint8Array(0)`
    // literal) isn't structurally assignable to `BlobPart`'s stricter
    // `ArrayBufferView<ArrayBuffer>` — a test-only typing wrinkle, not a
    // runtime concern (a fresh standalone copy either way).
    return new Blob([this.#committed.slice().buffer as ArrayBuffer]);
  }

  async createWritable(options: { keepExistingData: boolean }): Promise<WritableFileStreamLike> {
    if (!options.keepExistingData) {
      throw new Error('test fake only supports keepExistingData: true (that is what the plan requires)');
    }
    this.createWritableCalls++;
    // The swap starts as a copy of the committed file (keepExistingData).
    let swap = this.#committed.slice();
    return {
      write: async (params) => {
        if (this.failNextWrite) {
          this.failNextWrite = false;
          throw new Error('simulated write failure (e.g. permission revoked)');
        }
        const incoming = params.data;
        const end = params.position + incoming.length;
        if (end > swap.length) {
          const grown = new Uint8Array(end);
          grown.set(swap);
          swap = grown;
        }
        swap.set(incoming, params.position);
        this.writesLog.push({ position: params.position, length: incoming.length });
      },
      close: async () => {
        if (this.failNextClose) {
          this.failNextClose = false;
          throw new Error('simulated close failure (e.g. permission revoked before commit)');
        }
        this.#committed = swap; // commit: swap becomes the real file
      },
    };
  }

  /** The committed (durable) file contents — only reflects closed windows, never an open one. */
  get bytes(): Uint8Array {
    return this.#committed;
  }
}

class FakeDirectoryHandle implements DirectoryHandleLike {
  readonly files = new Map<string, FakeFileHandle>();
  queryPermissionCalls = 0;
  requestPermissionCalls = 0;
  queryResult: PermissionStateLike;
  requestResult: PermissionStateLike;

  constructor(options: { queryResult?: PermissionStateLike; requestResult?: PermissionStateLike } = {}) {
    this.queryResult = options.queryResult ?? 'granted';
    this.requestResult = options.requestResult ?? 'granted';
  }

  async getFileHandle(name: string): Promise<FileHandleLike> {
    let handle = this.files.get(name);
    if (!handle) {
      handle = new FakeFileHandle();
      this.files.set(name, handle);
    }
    return handle;
  }

  async queryPermission(): Promise<PermissionStateLike> {
    this.queryPermissionCalls++;
    return this.queryResult;
  }

  async requestPermission(): Promise<PermissionStateLike> {
    this.requestPermissionCalls++;
    return this.requestResult;
  }
}

// --- Fakes: OPFS fallback side --------------------------------------------
//
// Reuses the SAME `FakeFileHandle` as the live-mirror side above (no second
// fake) — proving, at the test level, the exact structural reuse the
// production code relies on: one `FileHandleLike`-shaped fake backs both
// the live-mirror file and the fallback's OPFS-root file.

function fakeFallbackFileOpener(): { opener: FallbackFileOpener; handles: Map<string, FakeFileHandle> } {
  const handles = new Map<string, FakeFileHandle>();
  const opener: FallbackFileOpener = async (name) => {
    let handle = handles.get(name);
    if (!handle) {
      handle = new FakeFileHandle();
      handles.set(name, handle);
    }
    return handle;
  };
  return { opener, handles };
}

// --- Fakes: repository ------------------------------------------------------

class InMemoryDirectoryHandleRepository implements DirectoryHandleRepository {
  #stored: DirectoryHandleLike | undefined;

  async save(handle: DirectoryHandleLike): Promise<void> {
    this.#stored = handle;
  }

  async load(): Promise<DirectoryHandleLike | undefined> {
    return this.#stored;
  }
}

function envWithPicker(dir: DirectoryHandleLike): FileSystemAccessEnvLike {
  return { showDirectoryPicker: async () => dir };
}

const envWithoutPicker: FileSystemAccessEnvLike = {};

// ============================================================================
// Router (test scenario 1, AE1, R5-R7): feature detection alone decides,
// no user configuration.
// ============================================================================

describe('hasFileSystemAccess', () => {
  it('is true when showDirectoryPicker exists on the env', () => {
    expect(hasFileSystemAccess(envWithPicker(new FakeDirectoryHandle()))).toBe(true);
  });

  it('is false when showDirectoryPicker is missing', () => {
    expect(hasFileSystemAccess(envWithoutPicker)).toBe(false);
  });
});

describe('createFileSink (test scenario 1, AE1)', () => {
  it('returns the live-mirror sink when File System Access is available, and persists the chosen handle', async () => {
    const dir = new FakeDirectoryHandle();
    const repository = new InMemoryDirectoryHandleRepository();
    const sink = await createFileSink({ env: envWithPicker(dir), repository });

    expect(sink.kind).toBe('live-mirror');
    expect(sink).toBeInstanceOf(FileSystemAccessSink);
    await expect(repository.load()).resolves.toBe(dir);
  });

  it('returns the fallback sink when File System Access is unavailable — no user configuration involved', async () => {
    const { opener } = fakeFallbackFileOpener();
    const sink = await createFileSink({ env: envWithoutPicker, fallbackFileOpener: opener });

    expect(sink.kind).toBe('fallback');
    expect(sink).toBeInstanceOf(FallbackSink);
  });
});

// ============================================================================
// Handle persistence across a simulated reload (test scenario 2, R6-Fortsetzung).
// Split per the file header's documented Realitätsgrenze:
//  (a) the IndexedDB store itself, exercised for real via fake-indexeddb;
//  (b) the router's permission-recheck behavior, via an injected in-memory
//      repository holding a fully functional fake handle.
// ============================================================================

describe('IndexedDbDirectoryHandleRepository (test scenario 2 — persistence half, fake-indexeddb)', () => {
  it('persists and retrieves a handle record across a simulated reload (same DB, new repository instance)', async () => {
    const dbName = `${DEFAULT_HANDLE_DB_NAME}-test-1`;
    // A plain data-only stand-in — see file header for why a fully
    // functional fake (with methods) cannot round-trip through
    // fake-indexeddb's structuredClone-based cloning.
    const storedValue = { folderName: 'Meetings' } as unknown as DirectoryHandleLike;

    const beforeReload = new IndexedDbDirectoryHandleRepository(dbName);
    await beforeReload.save(storedValue);

    // Simulated reload: a fresh repository instance, same DB name, same
    // underlying fake-indexeddb registry (module-level, like a real profile).
    const afterReload = new IndexedDbDirectoryHandleRepository(dbName);
    const loaded = await afterReload.load();

    expect(loaded).toEqual(storedValue);
  });

  it('load() resolves to undefined when nothing was ever saved', async () => {
    const repository = new IndexedDbDirectoryHandleRepository(`${DEFAULT_HANDLE_DB_NAME}-test-empty`);
    await expect(repository.load()).resolves.toBeUndefined();
  });

  it('save() overwrites the single stored record (only one output folder at a time, R5)', async () => {
    const dbName = `${DEFAULT_HANDLE_DB_NAME}-test-overwrite`;
    const repository = new IndexedDbDirectoryHandleRepository(dbName);
    await repository.save({ folderName: 'First' } as unknown as DirectoryHandleLike);
    await repository.save({ folderName: 'Second' } as unknown as DirectoryHandleLike);

    const loaded = await repository.load();
    expect(loaded).toEqual({ folderName: 'Second' });
  });
});

describe('restoreFileSink (test scenario 2 — router half: reuse + re-request permission)', () => {
  it('reuses a persisted handle and re-checks permission via queryPermission, granted -> live-mirror sink', async () => {
    const dir = new FakeDirectoryHandle({ queryResult: 'granted' });
    const repository = new InMemoryDirectoryHandleRepository();
    await repository.save(dir);

    const sink = await restoreFileSink({ env: envWithPicker(dir), repository });

    expect(sink?.kind).toBe('live-mirror');
    expect(dir.queryPermissionCalls).toBe(1);
    expect(dir.requestPermissionCalls).toBe(0); // granted on the first query — no need to escalate
  });

  it('escalates to requestPermission when queryPermission answers "prompt", and proceeds once granted', async () => {
    const dir = new FakeDirectoryHandle({ queryResult: 'prompt', requestResult: 'granted' });
    const repository = new InMemoryDirectoryHandleRepository();
    await repository.save(dir);

    const sink = await restoreFileSink({ env: envWithPicker(dir), repository });

    expect(sink?.kind).toBe('live-mirror');
    expect(dir.queryPermissionCalls).toBe(1);
    expect(dir.requestPermissionCalls).toBe(1);
  });

  it('returns undefined when the API is unavailable — nothing to restore, caller falls through to createFileSink', async () => {
    const repository = new InMemoryDirectoryHandleRepository();
    await repository.save(new FakeDirectoryHandle());

    const sink = await restoreFileSink({ env: envWithoutPicker, repository });
    expect(sink).toBeUndefined();
  });

  it('returns undefined when no handle was ever persisted', async () => {
    const repository = new InMemoryDirectoryHandleRepository();
    const sink = await restoreFileSink({ env: envWithPicker(new FakeDirectoryHandle()), repository });
    expect(sink).toBeUndefined();
  });
});

// ============================================================================
// Append position/byte bookkeeping (test scenario 3): keepExistingData must
// never lose earlier bytes, and writes must land at the correct offset.
// ============================================================================

describe('FileSystemAccessSink: append position bookkeeping (test scenario 3)', () => {
  it('a fresh (empty) file starts appending at position 0, committed on close()', async () => {
    const dir = new FakeDirectoryHandle();
    const sink = new FileSystemAccessSink(dir, undefined, commitByCountOnly(8));
    const file = await sink.openFile('session.txt');

    await file.append(encode('hello '));
    await file.close(); // commits the still-open window
    const fakeFile = dir.files.get('session.txt')!;
    expect(decode(fakeFile.bytes)).toBe('hello ');
    expect(fakeFile.writesLog).toEqual([{ position: 0, length: 6 }]);
  });

  it('resumes appending at the existing file size for a non-empty file (reopen mid-session)', async () => {
    const dir = new FakeDirectoryHandle();
    const preExisting = new FakeFileHandle();
    // Write AND close so the bytes are committed and getFile().size reflects them.
    const w = await preExisting.createWritable({ keepExistingData: true });
    await w.write({ type: 'write', position: 0, data: encode('already-there|') });
    await w.close();
    dir.files.set('session.txt', preExisting);

    const sink = new FileSystemAccessSink(dir, undefined, commitByCountOnly(8));
    const file = await sink.openFile('session.txt');
    await file.append(encode('new-bytes'));
    await file.close();

    expect(decode(preExisting.bytes)).toBe('already-there|new-bytes');
  });

  it('sequential appends across a window never overwrite earlier bytes; positions stay contiguous, including over a commit', async () => {
    const dir = new FakeDirectoryHandle();
    // maxAppendsPerCommit=2: the 3 appends span TWO windows (commit after #2),
    // proving keepExistingData preserves bytes across an actual reopen.
    const sink = new FileSystemAccessSink(dir, undefined, commitByCountOnly(2));
    const file = await sink.openFile('session.txt');

    await file.append(encode('one '));
    await file.append(encode('two ')); // crosses maxAppendsPerCommit -> commit (close)
    await file.append(encode('three')); // reopens a new window at position 8
    await file.close();

    const fakeFile = dir.files.get('session.txt')!;
    expect(decode(fakeFile.bytes)).toBe('one two three');
    expect(fakeFile.writesLog).toEqual([
      { position: 0, length: 4 },
      { position: 4, length: 4 },
      { position: 8, length: 5 },
    ]);
    expect(fakeFile.createWritableCalls).toBe(2); // two windows for three appends — not one-per-append
  });

  it('holds ONE writable open across a commit window: M appends below the threshold produce far fewer createWritable calls than M (the O(n^2)-copy fix)', async () => {
    const dir = new FakeDirectoryHandle();
    const sink = new FileSystemAccessSink(dir, undefined, commitByCountOnly(8));
    const file = await sink.openFile('session.txt');

    for (let i = 0; i < 7; i++) await file.append(encode('x')); // 7 < 8 -> all in one window
    const fakeFile = dir.files.get('session.txt')!;
    expect(fakeFile.createWritableCalls).toBe(1); // NOT 7 — the whole point of the fix

    await file.close(); // commits the window
    expect(decode(fakeFile.bytes)).toBe('xxxxxxx');
  });

  it('commits and reopens once the append-count threshold is crossed (a new createWritable per window)', async () => {
    const dir = new FakeDirectoryHandle();
    const sink = new FileSystemAccessSink(dir, undefined, commitByCountOnly(3));
    const file = await sink.openFile('session.txt');

    await file.append(encode('a')); // window 1: 1 append
    await file.append(encode('b')); // window 1: 2 appends
    await file.append(encode('c')); // window 1: 3 -> commit (close)
    const fakeFile = dir.files.get('session.txt')!;
    expect(fakeFile.createWritableCalls).toBe(1);
    expect(decode(fakeFile.bytes)).toBe('abc'); // committed after the 3rd append's close

    await file.append(encode('d')); // window 2 opens
    expect(fakeFile.createWritableCalls).toBe(2);
    await file.close();
    expect(decode(fakeFile.bytes)).toBe('abcd');
  });

  it('commits by the age threshold via the injected clock, even below the append count', async () => {
    const dir = new FakeDirectoryHandle();
    let clock = 0;
    const sink = new FileSystemAccessSink(dir, undefined, {
      maxAppendsPerCommit: 1_000, // never hit by count in this test
      maxCommitIntervalMs: 500,
      now: () => clock,
    });
    const file = await sink.openFile('session.txt');

    await file.append(encode('a')); // window opens at t=0, 1 append, not due
    const fakeFile = dir.files.get('session.txt')!;
    expect(decode(fakeFile.bytes)).toBe(''); // still uncommitted (window open)
    expect(fakeFile.createWritableCalls).toBe(1);

    clock = 600; // 600ms since the window opened >= 500ms threshold
    await file.append(encode('b')); // this append's post-write check commits
    expect(decode(fakeFile.bytes)).toBe('ab'); // committed
    expect(fakeFile.createWritableCalls).toBe(1); // still one window — commit closes it

    await file.append(encode('c')); // reopens window 2
    expect(fakeFile.createWritableCalls).toBe(2);
  });
});

// ============================================================================
// R7 Grenzfall (test scenario 4): revoked permission -> clean fallback,
// no data loss, at both the router level and mid-session.
// ============================================================================

describe('R7 Grenzfall: revoked permission -> clean fallback, no data loss', () => {
  it('restoreFileSink falls back cleanly (no throw) when queryPermission answers "denied"', async () => {
    const dir = new FakeDirectoryHandle({ queryResult: 'denied' });
    const repository = new InMemoryDirectoryHandleRepository();
    await repository.save(dir);
    const { opener } = fakeFallbackFileOpener();

    const sink = await restoreFileSink({ env: envWithPicker(dir), repository, fallbackFileOpener: opener });

    expect(sink?.kind).toBe('fallback');
    expect(dir.requestPermissionCalls).toBe(0); // 'denied' from queryPermission never escalates to a prompt
  });

  it('restoreFileSink falls back cleanly when requestPermission is also denied after a "prompt" query', async () => {
    const dir = new FakeDirectoryHandle({ queryResult: 'prompt', requestResult: 'denied' });
    const repository = new InMemoryDirectoryHandleRepository();
    await repository.save(dir);
    const { opener } = fakeFallbackFileOpener();

    const sink = await restoreFileSink({ env: envWithPicker(dir), repository, fallbackFileOpener: opener });

    expect(sink?.kind).toBe('fallback');
  });

  it('a mid-session write failure reroutes to the fallback: committed windows stay put, the uncommitted window + later bytes are not lost', async () => {
    const dir = new FakeDirectoryHandle();
    const { opener, handles } = fakeFallbackFileOpener();
    // maxAppendsPerCommit=1 so the first append commits durably to the real
    // file before the failure — that's the "already committed bytes remain".
    const sink = new FileSystemAccessSink(dir, opener, commitByCountOnly(1));
    const file = await sink.openFile('session.txt');

    await file.append(encode('committed|')); // committed (window of 1 -> immediate close)
    const fakeFile = dir.files.get('session.txt')!;
    expect(decode(fakeFile.bytes)).toBe('committed|');

    fakeFile.failNextWrite = true; // revoked permission on the next window's write
    await expect(file.append(encode('failed-chunk|'))).resolves.toBeUndefined(); // never throws

    // Already-committed bytes at the real location are untouched.
    expect(decode(fakeFile.bytes)).toBe('committed|');
    expect(sink.degraded).toBe(true);

    await file.append(encode('after-degrade'));

    // Nothing dropped: the failing chunk and everything after it landed in
    // the fallback; the earlier committed bytes stayed in the real file.
    const downloads = await sink.collectFallbackDownloads();
    const fallbackText = decode(new Uint8Array(await downloads.get('session.txt')!.arrayBuffer()));
    expect(fallbackText).toBe('failed-chunk|after-degrade');
    expect(handles.get('session.txt')).toBeDefined();
  });

  it('a failing periodic close() also degrades, replaying the whole uncommitted window to the fallback (no data loss)', async () => {
    const dir = new FakeDirectoryHandle();
    const { opener } = fakeFallbackFileOpener();
    // Window of 2: 'p1','p2' commit first (durable), then 'p3','p4' where the
    // commit close() throws — the whole uncommitted window must be recovered.
    const sink = new FileSystemAccessSink(dir, opener, commitByCountOnly(2));
    const file = await sink.openFile('session.txt');

    await file.append(encode('p1')); // window 1
    await file.append(encode('p2')); // window 1 -> commit (durable)
    const fakeFile = dir.files.get('session.txt')!;
    expect(decode(fakeFile.bytes)).toBe('p1p2');

    fakeFile.failNextClose = true; // the next window's commit close() will throw
    await file.append(encode('p3')); // window 2 write (uncommitted)
    await expect(file.append(encode('p4'))).resolves.toBeUndefined(); // triggers commit -> close throws -> degrade, never throws

    expect(sink.degraded).toBe(true);
    expect(decode(fakeFile.bytes)).toBe('p1p2'); // uncommitted window discarded from the real file

    const downloads = await sink.collectFallbackDownloads();
    const fallbackText = decode(new Uint8Array(await downloads.get('session.txt')!.arrayBuffer()));
    expect(fallbackText).toBe('p3p4'); // the uncommitted window survived, in the fallback
  });

  it('close() that fails to commit the final window degrades and preserves the uncommitted bytes via the fallback', async () => {
    const dir = new FakeDirectoryHandle();
    const { opener } = fakeFallbackFileOpener();
    const sink = new FileSystemAccessSink(dir, opener, commitByCountOnly(8));
    const file = await sink.openFile('session.txt');

    await file.append(encode('trailing')); // stays in the open window (1 < 8)
    const fakeFile = dir.files.get('session.txt')!;
    fakeFile.failNextClose = true;
    await expect(file.close()).resolves.toBeUndefined(); // final commit throws -> degrade, never throws

    expect(sink.degraded).toBe(true);
    const downloads = await sink.collectFallbackDownloads();
    expect(decode(new Uint8Array(await downloads.get('session.txt')!.arrayBuffer()))).toBe('trailing');
  });

  it('once degraded, further appends go straight to the fallback without retrying the live path', async () => {
    const dir = new FakeDirectoryHandle();
    const { opener } = fakeFallbackFileOpener();
    const sink = new FileSystemAccessSink(dir, opener, commitByCountOnly(1));
    const file = await sink.openFile('session.txt');
    const fakeFile = dir.files.get('session.txt')!;

    fakeFile.failNextWrite = true;
    await file.append(encode('trigger-degrade'));
    const writesAfterDegrade = fakeFile.writesLog.length;
    const createWritableAfterDegrade = fakeFile.createWritableCalls;

    await file.append(encode('more'));
    await file.append(encode('data'));

    expect(fakeFile.writesLog.length).toBe(writesAfterDegrade); // no further writes against the live file
    expect(fakeFile.createWritableCalls).toBe(createWritableAfterDegrade); // no further reopens either
  });
});

// ============================================================================
// FallbackSink itself: durable per-file storage + end-of-session download.
// Now backed by the SAME commit-window `SelfHealingAppendableFile` writer as
// the live-mirror (see fileSink.ts's header for why — `createSyncAccessHandle`
// is Worker-only, `FallbackSink` runs on the main thread) — so, exactly like
// the live-mirror's `bytes`/`getFile().size`, a file's committed content is
// only visible once its current window is committed (`close()`, or the
// count/age threshold). Production always `close()`s every writer before
// ever reading `collectDownloads()`/`collectFallbackDownloads()`
// (`RecordingCoordinator.stop()` awaits every writer's `close()` first — see
// that file), so these tests `close()` before asserting on collected bytes,
// matching the real call order rather than the old (pre-fix) sync-handle
// behavior where every write was immediately durable.
// ============================================================================

describe('FallbackSink (R7/AE1: internal crash-safe collection + end-of-session download)', () => {
  it('openFile is idempotent by name — repeated opens return the same appendable file', async () => {
    const { opener } = fakeFallbackFileOpener();
    const sink = new FallbackSink(opener);
    const a = await sink.openFile('session.txt');
    const b = await sink.openFile('session.txt');
    expect(a).toBe(b);
  });

  it('collectDownloads() returns every written (and closed) file as a Blob with the correct bytes', async () => {
    const { opener } = fakeFallbackFileOpener();
    const sink = new FallbackSink(opener);

    const txt = await sink.openFile('session.txt');
    await txt.append(encode('hello world'));
    await txt.close(); // commits the still-open window — see describe-block note

    const srt = await sink.openFile('session.srt');
    await srt.append(encode('1\n00:00:00,000 --> 00:00:01,000\nhi\n'));
    await srt.close();

    const downloads = await sink.collectDownloads();
    expect(decode(new Uint8Array(await downloads.get('session.txt')!.arrayBuffer()))).toBe('hello world');
    expect(decode(new Uint8Array(await downloads.get('session.srt')!.arrayBuffer()))).toContain('hi');
  });

  it('collectDownloads() is empty when nothing was ever written', async () => {
    const { opener } = fakeFallbackFileOpener();
    const sink = new FallbackSink(opener);
    expect((await sink.collectDownloads()).size).toBe(0);
  });

  it('append writes durably through the reused commit-window writer (multiple chunks concatenate correctly, once closed)', async () => {
    const { opener, handles } = fakeFallbackFileOpener();
    const sink = new FallbackSink(opener);
    const file = await sink.openFile('audio.webm');

    await file.append(new Uint8Array([1, 2, 3]));
    await file.append(new Uint8Array([4, 5]));
    await file.close(); // commits the window — the OPFS-root fake file now holds both chunks

    const handle = handles.get('audio.webm')!;
    expect(Array.from(handle.bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it('holds ONE writable open across a commit window on the fallback too — the same O(n^2)-copy fix applies here', async () => {
    const { opener, handles } = fakeFallbackFileOpener();
    const sink = new FallbackSink(opener, commitByCountOnly(8));
    const file = await sink.openFile('session.txt');

    for (let i = 0; i < 7; i++) await file.append(encode('x')); // 7 < 8 -> all in one window
    const handle = handles.get('session.txt')!;
    expect(handle.createWritableCalls).toBe(1);

    await file.close();
    expect(decode(handle.bytes)).toBe('xxxxxxx');
  });

  it('a write failure on the fallback propagates to the caller — there is nowhere further to degrade to', async () => {
    const { opener, handles } = fakeFallbackFileOpener();
    const sink = new FallbackSink(opener);
    const file = await sink.openFile('session.txt');
    const handle = handles.get('session.txt')!;

    handle.failNextWrite = true;
    await expect(file.append(encode('boom'))).rejects.toThrow();
  });
});

// ============================================================================
// deleteFallbackArtifacts (S2, privacy hardening [F2]) — the in-app wipe's
// OPFS half. Real OPFS `removeEntry` behavior against the fixed
// `transkript*` names is this file's own documented Realitätsgrenze (no OPFS
// in Node/Vitest, same as `defaultFallbackFileOpener`/`FallbackSink`'s real
// Andockpunkt above) — the one thing every environment (including this test
// run, which has no OPFS) can prove is the quiet-resolve contract the plan
// requires: a wipe must never throw just because there was nothing to wipe.
// ============================================================================

describe('deleteFallbackArtifacts (S2, privacy hardening F2)', () => {
  it('resolves quietly when OPFS is unavailable', async () => {
    await expect(deleteFallbackArtifacts()).resolves.toBeUndefined();
  });
});
