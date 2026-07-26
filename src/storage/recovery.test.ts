// TEST-FIRST (plan U6 execution note: "Recovery-Logik TEST-FIRST" — no
// test+impl in the same step for this file). Written against `recovery.ts`
// before that module existed; run once to confirm every test below fails
// red (module-not-found), THEN `recovery.ts` was implemented to turn them
// green. See this unit's report for the actual red-run transcript.
//
// Covers AE2 + the plan's U6 recovery invariants: (1) a crash candidate
// (status still 'active', no clean close) is detected on next start: (2)
// recovery restores up to `lastSegmentSeq` without duplicating, and a
// second resume is idempotent; (3) a clean stop never offers recovery.
// Uses `fake-indexeddb` (Realitätsgrenze, see `sessionStore.ts`'s header)
// so these invariants run against a real IndexedDB implementation, not a
// hand-rolled mock of `SessionStore`.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { SessionStore, type SegmentRecord } from './sessionStore';
import { findCrashCandidates, recoverSession } from './recovery';

let dbCounter = 0;
function freshStore() {
  // Small batch thresholds so appended segments are durably flushed
  // immediately within each test, without needing to force `flush()`
  // everywhere — these tests are about recovery, not batch rhythm (that's
  // `sessionStore.test.ts`'s job).
  return new SessionStore({ dbName: `recovery-test-${dbCounter++}`, maxBatchSegments: 1 });
}

function segment(sessionId: string, seq: number): SegmentRecord {
  return { sessionId, seq, text: `segment ${seq}`, startMs: seq * 1000, endMs: seq * 1000 + 500 };
}

describe('findCrashCandidates (AE2, test scenario 1)', () => {
  it('a session with no clean close (status still active) is found as a crash candidate on the next start', async () => {
    const store = freshStore();
    await store.createSession('crashed-1', 1000);
    await store.appendSegment(segment('crashed-1', 0), 1000);
    // No closeSession() call — simulates an abort/crash mid-recording.

    const candidates = await findCrashCandidates(store);
    expect(candidates.map((s) => s.id)).toEqual(['crashed-1']);
  });

  it('a cleanly stopped session is never a crash candidate (test scenario 3)', async () => {
    const store = freshStore();
    await store.createSession('clean-1', 1000);
    await store.appendSegment(segment('clean-1', 0), 1000);
    await store.closeSession('clean-1', 2000);

    const candidates = await findCrashCandidates(store);
    expect(candidates).toEqual([]);
  });

  it('distinguishes multiple sessions: only the still-active one is a candidate', async () => {
    const store = freshStore();
    await store.createSession('crashed-2', 1000);
    await store.appendSegment(segment('crashed-2', 0), 1000);

    await store.createSession('clean-2', 1000);
    await store.appendSegment(segment('clean-2', 0), 1000);
    await store.closeSession('clean-2', 2000);

    const candidates = await findCrashCandidates(store);
    expect(candidates.map((s) => s.id)).toEqual(['crashed-2']);
  });
});

describe('recoverSession (test scenario 2: restore to lastSegmentSeq, no duplication, idempotent)', () => {
  it('restores every persisted segment up to lastSegmentSeq, in order, with no gaps introduced', async () => {
    const store = freshStore();
    await store.createSession('crashed-3', 1000);
    await store.appendSegment(segment('crashed-3', 0), 1000);
    await store.appendSegment(segment('crashed-3', 1), 1100);
    await store.appendSegment(segment('crashed-3', 2), 1200);
    // Crash: no closeSession().

    const outcome = await recoverSession(store, 'crashed-3', 5000);
    expect(outcome).not.toBeNull();
    expect(outcome!.segments.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(outcome!.session.lastSegmentSeq).toBe(2);
  });

  it('recovering transitions the session from active to closed (state diagram: Wiederherstellung -> Geschlossen)', async () => {
    const store = freshStore();
    await store.createSession('crashed-4', 1000);
    await store.appendSegment(segment('crashed-4', 0), 1000);

    const outcome = await recoverSession(store, 'crashed-4', 5000);
    expect(outcome!.recovered).toBe(true);
    expect(outcome!.session.status).toBe('closed');

    const persisted = await store.getSession('crashed-4');
    expect(persisted?.status).toBe('closed');

    // No longer offered as a crash candidate after being recovered.
    expect((await findCrashCandidates(store)).map((s) => s.id)).not.toContain('crashed-4');
  });

  it('never duplicates a segment even if the store was asked to append the same seq twice before recovery', async () => {
    const store = freshStore();
    await store.createSession('crashed-5', 1000);
    await store.appendSegment(segment('crashed-5', 0), 1000);
    await store.appendSegment(segment('crashed-5', 0), 1100); // e.g. a resumed worker re-sending, unsure it landed before the crash

    const outcome = await recoverSession(store, 'crashed-5', 5000);
    expect(outcome!.segments).toHaveLength(1);
  });

  it('a second resume on an already-recovered (now closed) session is idempotent: identical result, no error, no re-mutation', async () => {
    const store = freshStore();
    await store.createSession('crashed-6', 1000);
    await store.appendSegment(segment('crashed-6', 0), 1000);
    await store.appendSegment(segment('crashed-6', 1), 1100);

    const first = await recoverSession(store, 'crashed-6', 5000);
    const second = await recoverSession(store, 'crashed-6', 9000);

    expect(first!.recovered).toBe(true); // first call actually performed the active -> closed transition
    expect(second!.recovered).toBe(false); // second call is a no-op transition-wise (already closed)
    expect(second!.session.status).toBe('closed');
    expect(second!.segments).toEqual(first!.segments); // identical restored data both times — no duplication, no loss
  });

  it('resuming a session that never existed returns null rather than throwing', async () => {
    const store = freshStore();
    const outcome = await recoverSession(store, 'never-existed', 5000);
    expect(outcome).toBeNull();
  });

  it('resuming an empty (no segments yet) crashed session restores an empty, non-erroring segment list', async () => {
    const store = freshStore();
    await store.createSession('crashed-7', 1000);
    // Crash immediately, before any segment was ever finalized.

    const outcome = await recoverSession(store, 'crashed-7', 5000);
    expect(outcome!.segments).toEqual([]);
    expect(outcome!.session.status).toBe('closed');
  });
});

describe('crash-loss window: only FLUSHED segments survive (#14)', () => {
  // The prior tests all use maxBatchSegments:1, so every append is durable
  // immediately and the in-memory batch is never exercised. Production buffers
  // up to 20 segments / 5 s before flushing (sessionStore header) — so a crash
  // with a partially-filled batch is the REAL torn-write window. This locks
  // that behavior: unflushed segments are lost; flushed ones recover, and the
  // session is still offered as a crash candidate.
  it('segments still batched in memory when the app dies are lost; flushed ones recover', async () => {
    const dbName = `recovery-tornwrite-${dbCounter++}`;
    // A production-like threshold so appends buffer in memory instead of
    // flushing one-per-append. High interval too, so nothing age-flushes.
    const live = new SessionStore({ dbName, maxBatchSegments: 20, maxBatchIntervalMs: 1_000_000 });
    await live.createSession('crashed', 1000);
    await live.appendSegment(segment('crashed', 0), 1000);
    await live.appendSegment(segment('crashed', 1), 1100);
    await live.flush(1200); // seq 0,1 durably persisted (a batch boundary)
    await live.appendSegment(segment('crashed', 2), 1300); // stays in the in-memory batch — never flushed
    // Crash: the app process dies. `live`'s pending seq-2 vanishes with it.

    // Next launch: a fresh store instance over the SAME database.
    const relaunch = new SessionStore({ dbName, maxBatchSegments: 20 });
    const candidates = await findCrashCandidates(relaunch);
    expect(candidates.map((s) => s.id)).toEqual(['crashed']); // still active → offered for recovery

    const outcome = await recoverSession(relaunch, 'crashed', 5000);
    // seq 2 was only ever in memory → gone; the flushed 0,1 recover intact.
    expect(outcome!.segments.map((s) => s.seq)).toEqual([0, 1]);
    expect(outcome!.session.lastSegmentSeq).toBe(1);
  });
});
