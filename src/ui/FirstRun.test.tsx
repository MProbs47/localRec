// @vitest-environment jsdom
/**
 * U11: `FirstRun`'s state-transition behavior, driven entirely through
 * `modelCache.ts` fakes (no real OPFS/fetch/storage — same
 * Realitäts-Grenze as `modelCache.test.ts`). Covers the plan's AE3
 * ("fehlendes Modell führt in den Download-Flow, nicht in einen Fehler")
 * and the checking → downloading → warm-up → ready sequence.
 */
import { act } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FirstRun } from './FirstRun';
import type { SyncAccessHandleLike } from '../storage/opfsAudio';
import type { FetchLike, FetchResponseLike, ModelOpfsStore, ModelSetSpec, StorageGate } from '../storage/modelCache';

afterEach(() => {
  cleanup();
});

class FakeFileSystem {
  files = new Map<string, Uint8Array>();
}

function writeAt(existing: Uint8Array, at: number, incoming: Uint8Array): Uint8Array {
  const next = new Uint8Array(Math.max(existing.length, at + incoming.length));
  next.set(existing, 0);
  next.set(incoming, at);
  return next;
}

function createFakeStore(fs: FakeFileSystem): ModelOpfsStore {
  return {
    async exists(fileName) {
      return fs.files.has(fileName);
    },
    async openFile(fileName) {
      if (!fs.files.has(fileName)) fs.files.set(fileName, new Uint8Array(0));
      const handle: SyncAccessHandleLike = {
        getSize: () => fs.files.get(fileName)!.length,
        write: (buffer, options) => {
          const incoming = new Uint8Array(buffer);
          fs.files.set(fileName, writeAt(fs.files.get(fileName)!, options.at, incoming));
          return incoming.length;
        },
        flush: () => {},
        close: () => {},
      };
      return handle;
    },
    async deleteFile(fileName) {
      fs.files.delete(fileName);
    },
  };
}

function markComplete(fs: FakeFileSystem, fileName: string, bytes: number) {
  fs.files.set(fileName, new Uint8Array(bytes));
  fs.files.set(`${fileName}.done`, new Uint8Array(0));
}

/**
 * Each `read()` yields on a real macrotask (`setTimeout`), not just a
 * microtask — otherwise every chunk (and the whole download) resolves
 * within one synchronous flush and `waitFor` below can never observe the
 * intermediate `downloading` state, only the final `ready` one.
 */
function streamingResponse(chunks: Uint8Array[]): FetchResponseLike {
  const contentLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(contentLength) : null) },
    body: {
      getReader: () => ({
        read() {
          return new Promise((resolve) => {
            setTimeout(() => {
              if (index >= chunks.length) {
                resolve({ done: true });
                return;
              }
              const value = chunks[index];
              index += 1;
              resolve({ done: false, value });
            }, 5);
          });
        },
      }),
    },
  };
}

function makeChunks(totalBytes: number, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < totalBytes; start += chunkSize) {
    chunks.push(new Uint8Array(Math.min(chunkSize, totalBytes - start)));
  }
  return chunks;
}

function fetchQueue(responses: FetchResponseLike[]): { fetchImpl: FetchLike; callCount: () => number } {
  let count = 0;
  const fetchImpl: FetchLike = async () => {
    const response = responses[count];
    count += 1;
    if (!response) throw new Error('fetchQueue: exhausted');
    return response;
  };
  return { fetchImpl, callCount: () => count };
}

function generousGate(): StorageGate {
  return {
    estimate: async () => ({ usage: 0, quota: 100_000_000_000 }),
    persist: async () => true,
  };
}

function tightGate(): StorageGate {
  return {
    estimate: async () => ({ usage: 4_999_000_000, quota: 5_000_000_000 }),
    persist: async () => false,
  };
}

const SPEC: ModelSetSpec = {
  id: 'model-test',
  files: [{ url: 'https://example.invalid/shard.onnx_data', fileName: 'shard.onnx_data' }],
};

describe('FirstRun (U11: guided first-run state machine)', () => {
  it('Deckt AE3: a missing model leads to the downloading state, not an error, and reaches ready', async () => {
    const fs = new FakeFileSystem();
    const store = createFakeStore(fs);
    const { fetchImpl } = fetchQueue([streamingResponse(makeChunks(100, 20))]);
    let readyCalls = 0;

    const { container } = render(
      <FirstRun
        spec={SPEC}
        store={store}
        fetchImpl={fetchImpl}
        storageGate={generousGate()}
        requiredBytes={1}
        engine={{ warmup: async () => {} }}
        onReady={() => {
          readyCalls += 1;
        }}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('.first-run')?.getAttribute('data-status')).toBe('downloading');
    });

    await waitFor(() => {
      expect(container.querySelector('.first-run')?.getAttribute('data-status')).toBe('ready');
    });
    expect(readyCalls).toBe(1);
    expect(container.querySelector('.first-run__error')).toBeNull();
  });

  it('an already-cached model skips straight to warm-up/ready without ever showing downloading', async () => {
    const fs = new FakeFileSystem();
    markComplete(fs, 'shard.onnx_data', 100);
    const store = createFakeStore(fs);
    const { fetchImpl, callCount } = fetchQueue([]); // any fetch call would throw — asserts no network happens

    const { container } = render(
      <FirstRun
        spec={SPEC}
        store={store}
        fetchImpl={fetchImpl}
        storageGate={generousGate()}
        requiredBytes={1}
        engine={{ warmup: async () => {} }}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('.first-run')?.getAttribute('data-status')).toBe('ready');
    });
    expect(callCount()).toBe(0);
  });

  it('shows an error state (not a crash) when the storage gate reports insufficient space', async () => {
    const fs = new FakeFileSystem();
    const store = createFakeStore(fs);
    const { fetchImpl, callCount } = fetchQueue([streamingResponse(makeChunks(100, 20))]);

    const { container } = render(
      <FirstRun
        spec={SPEC}
        store={store}
        fetchImpl={fetchImpl}
        storageGate={tightGate()}
        requiredBytes={2_500_000_000}
        engine={{ warmup: async () => {} }}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('.first-run')?.getAttribute('data-status')).toBe('error');
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(callCount()).toBe(0); // never attempted the doomed download
  });

  it('unmounting mid-flow does not throw ("cancelled" guard against a state update after unmount)', async () => {
    const fs = new FakeFileSystem();
    const store = createFakeStore(fs);
    const { fetchImpl } = fetchQueue([streamingResponse(makeChunks(100, 20))]);

    const { unmount } = render(
      <FirstRun
        spec={SPEC}
        store={store}
        fetchImpl={fetchImpl}
        storageGate={generousGate()}
        requiredBytes={1}
        engine={{ warmup: async () => {} }}
      />,
    );

    expect(() => act(() => unmount())).not.toThrow();
  });
});
