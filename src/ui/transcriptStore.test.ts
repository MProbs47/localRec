import { describe, expect, it } from 'vitest';
import { TranscriptStore } from './transcriptStore';

describe('TranscriptStore (append-only, useSyncExternalStore-shaped, U8/R14)', () => {
  it('assigns monotonically increasing seq numbers, starting at 0', () => {
    const store = new TranscriptStore();
    const a = store.append({ text: 'first', startMs: 0, endMs: 100 });
    const b = store.append({ text: 'second', startMs: 100, endMs: 200 });
    const c = store.append({ text: 'third', startMs: 200, endMs: 300 });

    expect([a.seq, b.seq, c.seq]).toEqual([0, 1, 2]);
    expect(store.getSnapshot().segments.map((s) => s.text)).toEqual(['first', 'second', 'third']);
  });

  it('getSnapshot() returns the exact same reference across reads until the next append (useSyncExternalStore contract)', () => {
    const store = new TranscriptStore();
    store.append({ text: 'a', startMs: 0, endMs: 10 });

    const snapshotA = store.getSnapshot();
    const snapshotB = store.getSnapshot();
    expect(snapshotA).toBe(snapshotB);

    store.append({ text: 'b', startMs: 10, endMs: 20 });
    const snapshotC = store.getSnapshot();
    expect(snapshotC).not.toBe(snapshotA);
  });

  it('reset() empties the store, restarts seq at 0, and notifies subscribers', () => {
    const store = new TranscriptStore();
    store.append({ text: 'old-a', startMs: 0, endMs: 10 });
    store.append({ text: 'old-b', startMs: 10, endMs: 20 });

    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    store.reset();
    expect(notified).toBe(1);
    expect(store.size).toBe(0);
    expect(store.getSnapshot().segments).toEqual([]);

    // Fresh session: seq restarts at 0, no stale segments linger.
    const fresh = store.append({ text: 'new', startMs: 0, endMs: 100 });
    expect(fresh.seq).toBe(0);
    expect(store.getSnapshot().segments.map((s) => s.text)).toEqual(['new']);
  });

  it('never reallocates or mutates already-appended segment objects (stable identity — what row memoization relies on)', () => {
    const store = new TranscriptStore();
    const first = store.append({ text: 'stable', startMs: 0, endMs: 10 });
    const beforeSecondAppend = store.getSnapshot().segments[0];

    store.append({ text: 'new', startMs: 10, endMs: 20 });
    const afterSecondAppend = store.getSnapshot().segments[0];

    expect(afterSecondAppend).toBe(beforeSecondAppend);
    expect(afterSecondAppend).toBe(first);
  });

  it('notifies subscribers on every append and lets them unsubscribe', () => {
    const store = new TranscriptStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });

    store.append({ text: 'a', startMs: 0, endMs: 10 });
    store.append({ text: 'b', startMs: 10, endMs: 20 });
    expect(calls).toBe(2);

    unsubscribe();
    store.append({ text: 'c', startMs: 20, endMs: 30 });
    expect(calls).toBe(2);
  });

  it('holds tens of thousands of segments (R14) with correct size, order, and O(1)-amortized append performance', () => {
    const store = new TranscriptStore();
    const total = 40_000;

    const start = performance.now();
    for (let i = 0; i < total; i += 1) {
      store.append({ text: `segment ${i}`, startMs: i * 10, endMs: i * 10 + 10 });
    }
    const elapsedMs = performance.now() - start;

    const segments = store.getSnapshot().segments;
    expect(store.size).toBe(total);
    expect(segments).toHaveLength(total);
    expect(segments[0]?.text).toBe('segment 0');
    expect(segments[total - 1]?.text).toBe(`segment ${total - 1}`);
    // Generous ceiling — this asserts "not accidentally O(n^2)", not a
    // tight perf budget (CI hardware varies). An O(n) copy per append
    // would blow well past this on 40k appends.
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('leaves the speaker field unset (reserved for Phase D, not populated by this unit)', () => {
    const store = new TranscriptStore();
    const segment = store.append({ text: 'no speaker yet', startMs: 0, endMs: 10 });
    expect(segment.speaker).toBeUndefined();
  });
});
