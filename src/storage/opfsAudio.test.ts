// Realitätsgrenze: `FileSystemSyncAccessHandle` is Worker-only and doesn't
// exist in Node/Vitest at all. `FakeSyncAccessHandle` below is an in-memory
// stand-in implementing exactly `SyncAccessHandleLike` — the plan's
// explicitly requested injectable seam — so `OpfsAudioAppender`'s real
// position/flush logic runs unmocked against it. Real OPFS throughput/crash
// behavior stays a manual milestone (see `opfsAudio.ts`'s header).
import { describe, expect, it } from 'vitest';
import { DEFAULT_FLUSH_EVERY_BYTES, OpfsAudioAppender, type SyncAccessHandleLike } from './opfsAudio';

class FakeSyncAccessHandle implements SyncAccessHandleLike {
  #buffer: Uint8Array;
  flushCount = 0;
  closed = false;

  constructor(initialBytes = 0) {
    this.#buffer = new Uint8Array(initialBytes);
  }

  getSize(): number {
    return this.#buffer.length;
  }

  write(buffer: ArrayBuffer, options: { at: number }): number {
    const incoming = new Uint8Array(buffer);
    const end = options.at + incoming.length;
    if (end > this.#buffer.length) {
      const grown = new Uint8Array(end);
      grown.set(this.#buffer);
      this.#buffer = grown;
    }
    this.#buffer.set(incoming, options.at);
    return incoming.length;
  }

  flush(): void {
    this.flushCount++;
  }

  close(): void {
    this.closed = true;
  }

  get bytes(): Uint8Array {
    return this.#buffer;
  }
}

function bytesOf(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

describe('OpfsAudioAppender: position tracking (test scenario 4)', () => {
  it('a fresh (empty) handle starts appending at position 0', () => {
    const handle = new FakeSyncAccessHandle();
    const appender = new OpfsAudioAppender(handle);
    expect(appender.size).toBe(0);
  });

  it('resumes appending at the existing file size for a non-empty handle', () => {
    const handle = new FakeSyncAccessHandle(100);
    const appender = new OpfsAudioAppender(handle);
    expect(appender.size).toBe(100);

    appender.append(bytesOf(1, 2, 3));
    expect(appender.size).toBe(103);
    expect(handle.bytes.slice(100, 103)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('file size equals the sum of chunk byte lengths after several writes', () => {
    const handle = new FakeSyncAccessHandle();
    const appender = new OpfsAudioAppender(handle);

    appender.append(bytesOf(1, 2, 3, 4)); // 4 bytes
    appender.append(bytesOf(5, 6)); // 2 bytes
    appender.append(bytesOf(7, 8, 9, 10, 11)); // 5 bytes

    expect(appender.size).toBe(11);
    expect(handle.getSize()).toBe(11);
    expect(Array.from(handle.bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('writes land at the correct, non-overlapping offsets (never overwrite previously written bytes)', () => {
    const handle = new FakeSyncAccessHandle();
    const appender = new OpfsAudioAppender(handle);

    appender.append(bytesOf(9, 9, 9));
    appender.append(bytesOf(8, 8));

    expect(Array.from(handle.bytes)).toEqual([9, 9, 9, 8, 8]);
  });
});

describe('OpfsAudioAppender: flush cadence', () => {
  it('does not flush before flushEveryBytes accumulates', () => {
    const handle = new FakeSyncAccessHandle();
    const appender = new OpfsAudioAppender(handle, { flushEveryBytes: 10 });

    appender.append(bytesOf(1, 2, 3));
    expect(handle.flushCount).toBe(0);
  });

  it('flushes once accumulated written bytes reach the threshold', () => {
    const handle = new FakeSyncAccessHandle();
    const appender = new OpfsAudioAppender(handle, { flushEveryBytes: 5 });

    appender.append(bytesOf(1, 2, 3)); // 3 bytes, below threshold
    expect(handle.flushCount).toBe(0);
    appender.append(bytesOf(4, 5)); // +2 = 5, crosses threshold
    expect(handle.flushCount).toBe(1);
  });

  it('resets the accumulated-since-flush counter after a flush', () => {
    const handle = new FakeSyncAccessHandle();
    const appender = new OpfsAudioAppender(handle, { flushEveryBytes: 5 });

    appender.append(bytesOf(1, 2, 3, 4, 5)); // triggers flush #1
    expect(handle.flushCount).toBe(1);
    appender.append(bytesOf(1, 2, 3, 4)); // 4 bytes, below threshold again
    expect(handle.flushCount).toBe(1);
    appender.append(bytesOf(1)); // +1 = 5, triggers flush #2
    expect(handle.flushCount).toBe(2);
  });

  it('flush() force-flushes regardless of the threshold', () => {
    const handle = new FakeSyncAccessHandle();
    const appender = new OpfsAudioAppender(handle, { flushEveryBytes: 1_000_000 });
    appender.append(bytesOf(1));
    expect(handle.flushCount).toBe(0);
    appender.flush();
    expect(handle.flushCount).toBe(1);
  });

  it('close() flushes then closes the handle', () => {
    const handle = new FakeSyncAccessHandle();
    const appender = new OpfsAudioAppender(handle, { flushEveryBytes: 1_000_000 });
    appender.append(bytesOf(1, 2));
    appender.close();
    expect(handle.flushCount).toBe(1);
    expect(handle.closed).toBe(true);
  });

  it('the exported default flush threshold is a positive, sane byte count', () => {
    expect(DEFAULT_FLUSH_EVERY_BYTES).toBeGreaterThan(0);
  });
});
