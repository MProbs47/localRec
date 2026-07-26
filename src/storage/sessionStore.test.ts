// Realitätsgrenze: IndexedDB doesn't exist in Node/Vitest — `fake-indexeddb`
// is the standard, spec-compliant shim (compound keys included), so
// everything below exercises this file's real batch/dedup/query logic
// against a real IndexedDB implementation, nothing mocked away.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { SessionStore, type SegmentRecord } from './sessionStore';

// Each test gets its own DB name — fake-indexeddb's registry is shared
// per-process (module-level, like a real browser profile), so reusing one
// name across tests would leak state between them.
let dbCounter = 0;
function freshStore(options: ConstructorParameters<typeof SessionStore>[0] = {}) {
  return new SessionStore({ dbName: `test-db-${dbCounter++}`, ...options });
}

function segment(sessionId: string, seq: number, text = `segment ${seq}`): SegmentRecord {
  return { sessionId, seq, text, startMs: seq * 1000, endMs: seq * 1000 + 500 };
}

describe('SessionStore: sessions', () => {
  it('createSession starts a session as active', async () => {
    const store = freshStore();
    await store.createSession('s1', 1000);
    const session = await store.getSession('s1');
    expect(session).toEqual({ id: 's1', status: 'active', heartbeatAt: 1000, lastSegmentSeq: -1, createdAt: 1000 });
  });

  it('closeSession marks status closed and updates heartbeatAt', async () => {
    const store = freshStore();
    await store.createSession('s1', 1000);
    await store.closeSession('s1', 2000);
    const session = await store.getSession('s1');
    expect(session?.status).toBe('closed');
    expect(session?.heartbeatAt).toBe(2000);
  });

  it('closeSession on a non-existent session is a harmless no-op', async () => {
    const store = freshStore();
    await expect(store.closeSession('missing', 1000)).resolves.toBeUndefined();
  });

  it('heartbeat updates heartbeatAt without touching status', async () => {
    const store = freshStore();
    await store.createSession('s1', 1000);
    await store.heartbeat('s1', 5000);
    const session = await store.getSession('s1');
    expect(session?.status).toBe('active');
    expect(session?.heartbeatAt).toBe(5000);
  });

  it('listActiveSessions returns only active sessions', async () => {
    const store = freshStore();
    await store.createSession('active-1', 1000);
    await store.createSession('active-2', 1000);
    await store.createSession('closed-1', 1000);
    await store.closeSession('closed-1', 2000);

    const active = await store.listActiveSessions();
    expect(active.map((s) => s.id).sort()).toEqual(['active-1', 'active-2']);
  });
});

describe('SessionStore: segments — append + batch flush', () => {
  it('appendSegment does not persist until a batch threshold is hit', async () => {
    const store = freshStore({ maxBatchSegments: 5, maxBatchBytes: 1_000_000, maxBatchIntervalMs: 1_000_000 });
    await store.createSession('s1', 0);
    await store.appendSegment(segment('s1', 0), 0);
    // Below the count threshold — nothing durable yet.
    expect(await store.listSegments('s1')).toEqual([]);
  });

  it('flushes once the segment-count threshold is reached, in one transaction', async () => {
    let transactions = 0;
    const store = freshStore({
      maxBatchSegments: 3,
      maxBatchBytes: 1_000_000,
      maxBatchIntervalMs: 1_000_000,
      onTransaction: () => transactions++,
    });
    await store.createSession('s1', 0);
    transactions = 0; // ignore the createSession transaction — count only the flush below

    await store.appendSegment(segment('s1', 0), 0);
    await store.appendSegment(segment('s1', 1), 1);
    await store.appendSegment(segment('s1', 2), 2); // 3rd segment crosses maxBatchSegments

    expect(transactions).toBe(1);
    const stored = await store.listSegments('s1');
    expect(stored.map((s) => s.seq)).toEqual([0, 1, 2]);

    const session = await store.getSession('s1');
    expect(session?.lastSegmentSeq).toBe(2);
    expect(session?.heartbeatAt).toBe(2); // the `now` passed to the flush-triggering append
  });

  it('flushes once the byte threshold is reached', async () => {
    const store = freshStore({ maxBatchSegments: 1_000, maxBatchBytes: 10, maxBatchIntervalMs: 1_000_000 });
    await store.createSession('s1', 0);
    await store.appendSegment(segment('s1', 0, 'exactly-11c'), 0); // 11 chars >= 10-byte threshold
    expect(await store.listSegments('s1')).toHaveLength(1);
  });

  it('flushes once the age threshold is reached, even below count/byte thresholds', async () => {
    const store = freshStore({ maxBatchSegments: 1_000, maxBatchBytes: 1_000_000, maxBatchIntervalMs: 500 });
    await store.createSession('s1', 0);
    await store.appendSegment(segment('s1', 0), 0); // oldestPendingAt = 0
    expect(await store.listSegments('s1')).toEqual([]); // not due yet
    await store.appendSegment(segment('s1', 1), 600); // 600ms since oldest pending >= 500ms threshold
    expect(await store.listSegments('s1')).toHaveLength(2);
  });

  it('flush() force-flushes pending segments regardless of thresholds, and is a no-op when nothing is pending', async () => {
    const store = freshStore({ maxBatchSegments: 1_000, maxBatchBytes: 1_000_000, maxBatchIntervalMs: 1_000_000 });
    await store.createSession('s1', 0);
    await store.appendSegment(segment('s1', 0), 0);
    expect(await store.listSegments('s1')).toEqual([]);

    await store.flush(100);
    expect(await store.listSegments('s1')).toHaveLength(1);

    await expect(store.flush(200)).resolves.toBeUndefined(); // no-op, nothing pending
  });

  it('100 fast successive segments produce far fewer than 100 transactions (test scenario 5)', async () => {
    let transactions = 0;
    const store = freshStore({
      maxBatchSegments: 20,
      maxBatchBytes: 1_000_000,
      maxBatchIntervalMs: 1_000_000,
      onTransaction: () => transactions++,
    });
    await store.createSession('s1', 0);
    transactions = 0;

    for (let seq = 0; seq < 100; seq++) {
      await store.appendSegment(segment('s1', seq), seq); // "fast successive": all well within the age threshold
    }
    await store.flush(1000); // flush the trailing partial batch (100 is an exact multiple of 20 here, so this is a no-op, but stays robust to threshold changes)

    expect(transactions).toBeLessThan(20); // ≪ 100 — 100/20 = 5 batches
    expect(transactions).toBe(5);
    const stored = await store.listSegments('s1');
    expect(stored).toHaveLength(100);
  });

  it('deterministic composite key: re-appending the same (sessionId, seq) overwrites, never duplicates', async () => {
    const store = freshStore({ maxBatchSegments: 1, maxBatchBytes: 1_000_000, maxBatchIntervalMs: 1_000_000 });
    await store.createSession('s1', 0);
    await store.appendSegment(segment('s1', 0, 'first attempt'), 0);
    await store.appendSegment(segment('s1', 0, 'resent after crash'), 1); // same seq, different text — simulates a resumed worker re-sending

    const stored = await store.listSegments('s1');
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe('resent after crash'); // last write wins, no duplicate row
  });

  it('a seq gap does not create a duplicate or a synthesized filler — segments are exactly what was appended', async () => {
    const store = freshStore({ maxBatchSegments: 1, maxBatchBytes: 1_000_000, maxBatchIntervalMs: 1_000_000 });
    await store.createSession('s1', 0);
    await store.appendSegment(segment('s1', 0), 0);
    await store.appendSegment(segment('s1', 5), 1); // gap: seq 1-4 never appended

    const stored = await store.listSegments('s1');
    expect(stored.map((s) => s.seq)).toEqual([0, 5]);
  });

  it('listSegments only returns segments for the requested session, ascending by seq', async () => {
    const store = freshStore({ maxBatchSegments: 1, maxBatchBytes: 1_000_000, maxBatchIntervalMs: 1_000_000 });
    await store.createSession('s1', 0);
    await store.createSession('s2', 0);
    await store.appendSegment(segment('s1', 2), 0);
    await store.appendSegment(segment('s1', 0), 1);
    await store.appendSegment(segment('s1', 1), 2);
    await store.appendSegment(segment('s2', 0), 3);

    const s1Segments = await store.listSegments('s1');
    expect(s1Segments.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(await store.listSegments('s2')).toHaveLength(1);
  });
});

describe('SessionStore: deleteAllSessions (S2, privacy hardening F2)', () => {
  it('clears both sessions and segments', async () => {
    const store = freshStore({ maxBatchSegments: 1_000, maxBatchBytes: 1_000_000, maxBatchIntervalMs: 1_000_000 });
    await store.createSession('s1', 0);
    await store.appendSegment(segment('s1', 0), 0);
    await store.flush(100);
    expect(await store.listSegments('s1')).toHaveLength(1);
    expect(await store.getSession('s1')).toBeDefined();

    await store.deleteAllSessions();

    expect(await store.getSession('s1')).toBeUndefined();
    expect(await store.listSegments('s1')).toEqual([]);
    expect(await store.listActiveSessions()).toEqual([]);
  });

  it('drops a pending (not-yet-flushed) batch too — a later flush cannot resurrect it', async () => {
    const store = freshStore({ maxBatchSegments: 1_000, maxBatchBytes: 1_000_000, maxBatchIntervalMs: 1_000_000 });
    await store.createSession('s1', 0);
    await store.appendSegment(segment('s1', 0), 0); // below thresholds — stays pending, never durably written
    expect(await store.listSegments('s1')).toEqual([]);

    await store.deleteAllSessions();
    await store.flush(1000); // would have persisted the pending segment if the wipe hadn't dropped it

    expect(await store.listSegments('s1')).toEqual([]);
    expect(await store.getSession('s1')).toBeUndefined();
  });

  it('is a harmless no-op on an already-empty store', async () => {
    const store = freshStore();
    await expect(store.deleteAllSessions()).resolves.toBeUndefined();
    expect(await store.listActiveSessions()).toEqual([]);
  });
});

describe('SessionStore: flush durability (#5)', () => {
  it('re-queues pending segments when the flush fails, instead of losing them', async () => {
    // A mid-flush failure (quota/eviction) is simulated by throwing from the
    // onTransaction hook, which fires inside flush() right before the write —
    // exercising the exact splice-then-fail window that used to drop the batch.
    let armed = false;
    const store = freshStore({
      maxBatchSegments: 20,
      maxBatchBytes: 1_000_000,
      maxBatchIntervalMs: 1_000_000,
      onTransaction: () => {
        if (armed) throw new Error('quota exceeded');
      },
    });
    await store.createSession('s1', 0);
    await store.appendSegment(segment('s1', 0, 'kept'), 0); // below thresholds → stays pending

    armed = true;
    await expect(store.flush(1000)).rejects.toThrow('quota exceeded');
    armed = false;

    // The batch was NOT dropped on failure — a later flush still persists it.
    await store.flush(2000);
    const stored = await store.listSegments('s1');
    expect(stored.map((s) => s.text)).toEqual(['kept']);
  });
});
