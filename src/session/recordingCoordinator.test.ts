/**
 * U12a: the recording lifecycle wiring. Exercises `RecordingCoordinator`'s
 * ordering/persistence/output logic against a real `SessionStore`
 * (fake-indexeddb) plus in-memory fakes for the hardware edges (sink files,
 * recorder, wake lock) — the same Realitätsgrenze the subsystems document.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingCoordinator, type RecorderHandle } from './recordingCoordinator';
import { SessionStore } from '../storage/sessionStore';
import { findCrashCandidates } from '../storage/recovery';
import { WakeLockController, type WakeLockProviderLike, type WakeLockSentinelLike } from '../runtime/wakeLock';
import type { AppendableFile, FileSink } from '../output/fileSink';

// --- Fakes -----------------------------------------------------------------

class FakeFile implements AppendableFile {
  readonly chunks: Uint8Array[] = [];
  closed = false;
  async append(data: Uint8Array): Promise<void> {
    // A real FileSystemWritableFileStream throws once closed — model that so a
    // write racing past close() is a hard failure here, not a silent success.
    if (this.closed) throw new Error('append after close');
    this.chunks.push(data);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  text(): string {
    return this.chunks.map((c) => new TextDecoder().decode(c)).join('');
  }
  bytes(): number {
    return this.chunks.reduce((n, c) => n + c.byteLength, 0);
  }
}

class FakeSink implements FileSink {
  readonly kind = 'fallback' as const;
  readonly files = new Map<string, FakeFile>();
  async openFile(name: string): Promise<AppendableFile> {
    const existing = this.files.get(name);
    if (existing) return existing;
    const file = new FakeFile();
    this.files.set(name, file);
    return file;
  }
}

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  async release(): Promise<void> {
    this.released = true;
  }
}

function fakeWakeLock() {
  const sentinels: FakeSentinel[] = [];
  const provider: WakeLockProviderLike = {
    request: vi.fn(async () => {
      const s = new FakeSentinel();
      sentinels.push(s);
      return s;
    }),
  };
  return { controller: new WakeLockController(provider), sentinels, provider };
}

/** A fake recorder that exposes its `onChunk` so tests can push audio blobs. */
function fakeRecorder() {
  const handle: RecorderHandle & { stopped: boolean } = { stopped: false, stop() { this.stopped = true; } };
  let onChunk: ((b: Blob) => void) | null = null;
  const start = (cb: (b: Blob) => void): RecorderHandle => {
    onChunk = cb;
    return handle;
  };
  return { start, handle, emit: (b: Blob) => onChunk?.(b) };
}

// --- Harness ---------------------------------------------------------------

let dbCounter = 0;
let clock = 1000;
const now = () => (clock += 1000);

interface Harness {
  coordinator: RecordingCoordinator;
  sink: FakeSink;
  store: SessionStore;
  wake: ReturnType<typeof fakeWakeLock>;
  recorder: ReturnType<typeof fakeRecorder>;
  heartbeats: Array<() => void>;
  createSink: ReturnType<typeof vi.fn>;
}

function makeHarness(overrides: { createSink?: () => Promise<FileSink> } = {}): Harness {
  const sink = new FakeSink();
  const store = new SessionStore({ dbName: `coord-db-${dbCounter++}` });
  const wake = fakeWakeLock();
  const recorder = fakeRecorder();
  const heartbeats: Array<() => void> = [];
  let idSeq = 0;
  const createSink = vi.fn(overrides.createSink ?? (async () => sink));

  const coordinator = new RecordingCoordinator({
    createSink,
    sessionStore: store,
    wakeLock: wake.controller,
    now,
    newSessionId: () => `sess-${idSeq++}`,
    heartbeatIntervalMs: 15_000,
    setIntervalImpl: (handler) => {
      heartbeats.push(handler);
      return heartbeats.length; // 1-based fake id
    },
    clearIntervalImpl: () => {},
  });

  return { coordinator, sink, store, wake, recorder, heartbeats, createSink };
}

beforeEach(() => {
  clock = 1000;
});
afterEach(() => {
  vi.restoreAllMocks();
});

// --- Tests -----------------------------------------------------------------

describe('RecordingCoordinator.start', () => {
  it('opens txt/srt/webm output, creates an active session, starts the recorder and holds the wake lock', async () => {
    const h = makeHarness();
    await h.coordinator.start(h.recorder.start);

    expect([...h.sink.files.keys()].sort()).toEqual(['transkript.srt', 'transkript.txt', 'transkript.webm']);
    expect(h.coordinator.active).toBe(true);

    const candidates = await findCrashCandidates(h.store);
    expect(candidates.map((c) => c.id)).toEqual(['sess-0']); // active until a clean stop

    expect(h.wake.provider.request).toHaveBeenCalledTimes(1);
    expect(h.recorder.handle.stopped).toBe(false);
    expect(h.heartbeats).toHaveLength(1);
  });

  it('(U20b) does not open a .webm file when startRecorder returns null — no MediaRecorder, or the import path\'s intentional "() => null"', async () => {
    const h = makeHarness();
    await h.coordinator.start(() => null);

    expect([...h.sink.files.keys()].sort()).toEqual(['transkript.srt', 'transkript.txt']);
    expect(h.coordinator.active).toBe(true);

    await h.coordinator.stop();
    expect(h.sink.files.has('transkript.webm')).toBe(false);
  });

  it('exposes the opened sink (null before start, retained past stop for the post-hoc speaker export, U18/U21)', async () => {
    const h = makeHarness();
    expect(h.coordinator.sink).toBeNull();
    await h.coordinator.start(h.recorder.start);
    expect(h.coordinator.sink).toBe(h.sink);
    await h.coordinator.stop();
    // Sink stays usable after stop — the annotate stage writes -sprecher.* to it.
    expect(h.coordinator.sink).toBe(h.sink);
  });

  it('rejects and stays inactive when the sink cannot be opened (picker cancelled)', async () => {
    const h = makeHarness({ createSink: async () => { throw new Error('picker cancelled'); } });
    await expect(h.coordinator.start(h.recorder.start)).rejects.toThrow('picker cancelled');
    expect(h.coordinator.active).toBe(false);
    // Nothing half-open: no session created, wake lock not held.
    expect(await findCrashCandidates(h.store)).toEqual([]);
    expect(h.wake.provider.request).not.toHaveBeenCalled();
  });
});

describe('RecordingCoordinator.handleFinal', () => {
  it('mirrors each finalized segment into the store (monotone seq) and the txt/srt files', async () => {
    const h = makeHarness();
    await h.coordinator.start(h.recorder.start);

    await h.coordinator.handleFinal({ text: 'HALLO WELT', startMs: 0, endMs: 1500 });
    await h.coordinator.handleFinal({ text: 'ZWEITE ZEILE', startMs: 1500, endMs: 3000 });

    await h.store.flush(now()); // segments batch in memory until a threshold/flush
    const segments = await h.store.listSegments('sess-0');
    expect(segments.map((s) => [s.seq, s.text])).toEqual([
      [1, 'HALLO WELT'],
      [2, 'ZWEITE ZEILE'],
    ]);

    const txt = h.sink.files.get('transkript.txt')!;
    expect(txt.text()).toContain('HALLO WELT');
    expect(txt.text()).toContain('ZWEITE ZEILE');

    const srt = h.sink.files.get('transkript.srt')!;
    expect(srt.text()).toContain('00:00:00,000 --> 00:00:01,500');
    expect(srt.text()).toContain('HALLO WELT');
  });

  it('stop() waits for a still-in-flight final write before closing the files', async () => {
    // Regression: the App wires handleFinal fire-and-forget (a worker message)
    // and then stops. The worker's trailing `final` (often the whole short
    // recording) is exactly this in-flight write. If stop() closes the writers
    // before draining it, the export files come out empty even though the .webm
    // and the on-screen transcript are fine. A deliberately slow txt append
    // (a real macrotask) makes this deterministic: the text can only be present
    // if stop() genuinely awaited the pending write rather than racing it.
    const h = makeHarness();
    await h.coordinator.start(h.recorder.start);

    const txt = h.sink.files.get('transkript.txt')!;
    const realAppend = txt.append.bind(txt);
    txt.append = async (data: Uint8Array) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return realAppend(data);
    };

    void h.coordinator.handleFinal({ text: 'LETZTES SEGMENT', startMs: 0, endMs: 2000 }); // NOT awaited
    await h.coordinator.stop(); // must drain the pending (slow) write before closing

    expect(txt.text()).toContain('LETZTES SEGMENT');
    expect(h.sink.files.get('transkript.srt')!.text()).toContain('LETZTES SEGMENT');

    await h.store.flush(now());
    const segments = await h.store.listSegments('sess-0');
    expect(segments.map((s) => s.text)).toEqual(['LETZTES SEGMENT']);
  });

  it('drops finals that arrive before start or after stop', async () => {
    const h = makeHarness();
    await h.coordinator.handleFinal({ text: 'TOO EARLY', startMs: 0, endMs: 1000 });
    await h.coordinator.start(h.recorder.start);
    await h.coordinator.handleFinal({ text: 'KEPT', startMs: 0, endMs: 1000 });
    await h.coordinator.stop();
    await h.coordinator.handleFinal({ text: 'TOO LATE', startMs: 0, endMs: 1000 });

    const segments = await h.store.listSegments('sess-0');
    expect(segments.map((s) => s.text)).toEqual(['KEPT']);
  });
});

describe('RecordingCoordinator audio + heartbeat', () => {
  it('appends recorder chunks to the webm file', async () => {
    const h = makeHarness();
    await h.coordinator.start(h.recorder.start);
    h.recorder.emit(new Blob([new Uint8Array([1, 2, 3, 4])]));
    h.recorder.emit(new Blob([new Uint8Array([5, 6])]));
    // writeChunk is async (blob.arrayBuffer) — let microtasks drain.
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sink.files.get('transkript.webm')!.bytes()).toBe(6);
  });

  it('heartbeats the recording session on the scheduled tick', async () => {
    const h = makeHarness();
    const spy = vi.spyOn(h.store, 'heartbeat');
    await h.coordinator.start(h.recorder.start);
    expect(h.heartbeats).toHaveLength(1);
    h.heartbeats[0](); // fire the scheduled heartbeat tick
    expect(spy).toHaveBeenCalledWith('sess-0', expect.any(Number));
  });
});

describe('RecordingCoordinator.stop', () => {
  it('closes writers, closes the session (no longer a crash candidate), stops the recorder and releases the wake lock', async () => {
    const h = makeHarness();
    await h.coordinator.start(h.recorder.start);
    await h.coordinator.handleFinal({ text: 'X', startMs: 0, endMs: 1 });
    await h.coordinator.stop();

    expect(h.coordinator.active).toBe(false);
    for (const file of h.sink.files.values()) expect(file.closed).toBe(true);
    expect(await findCrashCandidates(h.store)).toEqual([]); // clean stop → closed
    expect(h.recorder.handle.stopped).toBe(true);
    expect(h.wake.sentinels[0].released).toBe(true);
  });

  it('is idempotent', async () => {
    const h = makeHarness();
    await h.coordinator.start(h.recorder.start);
    await h.coordinator.stop();
    await expect(h.coordinator.stop()).resolves.toBeUndefined();
  });
});

// --- U1: explicit lifecycle aggregate (plan 005) ---------------------------

describe('RecordingCoordinator lifecycle (U1)', () => {
  it('exposes an explicit phase across the lifecycle', async () => {
    const h = makeHarness();
    expect(h.coordinator.phase).toBe('idle');
    await h.coordinator.start(h.recorder.start);
    expect(h.coordinator.phase).toBe('active');
    await h.coordinator.stop();
    expect(h.coordinator.phase).toBe('stopped');
  });

  it('rejects a re-entrant start fired during the createSink gap — one session, one recorder (#1)', async () => {
    // Hold createSink open so a second start() lands in the async gap that the
    // old `#active` boolean left unguarded (it was only set true AFTER awaits).
    let openSink!: (s: FileSink) => void;
    const gate = new Promise<FileSink>((resolve) => { openSink = resolve; });
    const sink = new FakeSink();
    const h = makeHarness({ createSink: () => gate });

    const first = h.coordinator.start(h.recorder.start);
    const second = h.coordinator.start(h.recorder.start); // TOCTOU window
    expect(h.coordinator.phase).toBe('starting');
    openSink(sink);
    await Promise.all([first, second]);

    expect(h.createSink).toHaveBeenCalledTimes(1);
    expect(h.coordinator.phase).toBe('active');
    const candidates = await findCrashCandidates(h.store);
    expect(candidates).toHaveLength(1); // exactly one session, not two
  });

  it('starts recording even when the wake lock rejects — optional durability is never a hard failure (#8)', async () => {
    const h = makeHarness();
    vi.mocked(h.wake.provider.request).mockRejectedValueOnce(new Error('wake lock denied'));

    await expect(h.coordinator.start(h.recorder.start)).resolves.toBeUndefined();
    expect(h.coordinator.phase).toBe('active');
    // The session is live and crash-recoverable despite the wake lock failure.
    expect(await findCrashCandidates(h.store)).toHaveLength(1);
  });

  it('rolls back to idle when start fails, so a retry can start cleanly', async () => {
    const failing = makeHarness({ createSink: async () => { throw new Error('picker cancelled'); } });
    await expect(failing.coordinator.start(failing.recorder.start)).rejects.toThrow('picker cancelled');
    expect(failing.coordinator.phase).toBe('idle');
    expect(failing.coordinator.active).toBe(false);
  });
});
