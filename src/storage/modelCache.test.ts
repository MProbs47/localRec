import { describe, expect, it } from 'vitest';
import type { SyncAccessHandleLike } from './opfsAudio';
import {
  DEFAULT_INACTIVITY_UNLOAD_MS,
  InsufficientStorageError,
  ModelActivityTracker,
  buildHfResolveUrl,
  checkStorageGate,
  deleteModelSet,
  DIARIZATION_MODEL_SET,
  DIARIZATION_REQUIRED_BYTES,
  downloadModelSet,
  ensureModelSetReady,
  getModelSetSizeBytes,
  isModelSetComplete,
  maybeUnloadForInactivity,
  WHISPER_MODEL_SET,
  WHISPER_REQUIRED_BYTES,
  type FetchLike,
  type FetchResponseLike,
  type ModelOpfsStore,
  type ModelSetSpec,
  type StorageGate,
} from './modelCache';

// --- Fakes -----------------------------------------------------------------
// No real OPFS/fetch/storage.estimate in Node/Vitest (this repo's stated
// Realitäts-Grenze) — these fakes drive the exact same position-tracking,
// Range-header, and sentinel logic a real browser would, mirroring
// opfsAudio.test.ts's in-memory `SyncAccessHandleLike` fake pattern.

/** Shared in-memory "OPFS directory" backing a `ModelOpfsStore` fake. */
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
        getSize() {
          return fs.files.get(fileName)!.length;
        },
        write(buffer, options) {
          const incoming = new Uint8Array(buffer);
          fs.files.set(fileName, writeAt(fs.files.get(fileName)!, options.at, incoming));
          return incoming.length;
        },
        flush() {},
        close() {},
      };
      return handle;
    },
    async deleteFile(fileName) {
      fs.files.delete(fileName);
    },
  };
}

/** A queued fake `fetch` — each call returns the next configured response and records `(url, init)` for assertions (e.g. the `Range` header sent on resume). */
function createFetchQueue(responses: FetchResponseLike[]): {
  fetchImpl: FetchLike;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const response = responses[index];
    index += 1;
    if (!response) throw new Error('createFetchQueue: no more queued responses');
    return response;
  };
  return { fetchImpl, calls };
}

/** Builds a streaming `FetchResponseLike` over `chunks`; if `failAfterChunks` is set, the reader rejects once that many chunks have been successfully read (simulating a mid-download network drop). */
function streamingResponse(
  chunks: Uint8Array[],
  options: { contentLength?: number; failAfterChunks?: number; status?: number } = {},
): FetchResponseLike {
  const totalSent = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const contentLength = options.contentLength ?? totalSent;
  let index = 0;
  return {
    ok: (options.status ?? 200) < 400,
    status: options.status ?? 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(contentLength) : null) },
    body: {
      getReader: () => ({
        async read() {
          if (options.failAfterChunks !== undefined && index >= options.failAfterChunks) {
            throw new Error('simulated network drop');
          }
          if (index >= chunks.length) return { done: true };
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        },
      }),
    },
  };
}

function makeChunks(totalBytes: number, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < totalBytes; start += chunkSize) {
    const size = Math.min(chunkSize, totalBytes - start);
    const chunk = new Uint8Array(size);
    for (let i = 0; i < size; i++) chunk[i] = (start + i) % 256;
    chunks.push(chunk);
  }
  return chunks;
}

function concatFiles(fs: FakeFileSystem, fileName: string): Uint8Array {
  return fs.files.get(fileName) ?? new Uint8Array(0);
}

function createStorageGate(overrides: { usage?: number; quota?: number; persistResult?: boolean } = {}): {
  gate: StorageGate;
  persistCalls: number[];
} {
  const persistCalls: number[] = [];
  const gate: StorageGate = {
    async estimate() {
      return { usage: overrides.usage, quota: overrides.quota };
    },
    async persist() {
      persistCalls.push(1);
      return overrides.persistResult ?? true;
    },
  };
  return { gate, persistCalls };
}

function fakeEngine() {
  const calls: string[] = [];
  return {
    calls,
    warmup: async () => {
      calls.push('warmup');
    },
    dispose: () => {
      calls.push('dispose');
    },
  };
}

const ONE_FILE_SPEC: ModelSetSpec = {
  id: 'model-test',
  files: [{ url: 'https://example.invalid/shard.onnx_data', fileName: 'shard.onnx_data' }],
};

// --- Tests -------------------------------------------------------------

describe('buildHfResolveUrl', () => {
  it('builds the stable HF Hub resolve URL shape', () => {
    expect(buildHfResolveUrl('onnx-community/whisper-large-v3-turbo', 'onnx/encoder_model_fp16.onnx')).toBe(
      'https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main/onnx/encoder_model_fp16.onnx',
    );
  });
});

describe('isModelSetComplete / AE3 (simulated eviction leads to the download flow, not an error)', () => {
  it('reports incomplete when nothing has ever been downloaded', async () => {
    const store = createFakeStore(new FakeFileSystem());
    await expect(isModelSetComplete(store, ONE_FILE_SPEC)).resolves.toBe(false);
  });

  it('reports complete once every file has its sentinel, and incomplete again after a simulated eviction wipes the OPFS area', async () => {
    const fs = new FakeFileSystem();
    const store = createFakeStore(fs);
    const { fetchImpl } = createFetchQueue([streamingResponse(makeChunks(30, 10))]);

    await downloadModelSet(store, ONE_FILE_SPEC, fetchImpl);
    await expect(isModelSetComplete(store, ONE_FILE_SPEC)).resolves.toBe(true);

    // Simulate iOS/Safari-style eviction (KTD8/AE3): the browser wipes the
    // OPFS area out from under the app between sessions.
    fs.files.clear();

    await expect(isModelSetComplete(store, ONE_FILE_SPEC)).resolves.toBe(false);
  });

  it('ensureModelSetReady honestly re-downloads after eviction instead of throwing', async () => {
    const fs = new FakeFileSystem();
    const store = createFakeStore(fs);
    const { gate } = createStorageGate({ usage: 0, quota: 100_000_000_000 });
    const engine = fakeEngine();

    const first = createFetchQueue([streamingResponse(makeChunks(20, 10))]);
    await ensureModelSetReady(ONE_FILE_SPEC, {
      store,
      fetchImpl: first.fetchImpl,
      storageGate: gate,
      requiredBytes: 1,
      engine,
    });
    expect(engine.calls).toEqual(['warmup']);

    fs.files.clear(); // evicted

    const second = createFetchQueue([streamingResponse(makeChunks(20, 10))]);
    const result = await ensureModelSetReady(ONE_FILE_SPEC, {
      store,
      fetchImpl: second.fetchImpl,
      storageGate: gate,
      requiredBytes: 1,
      engine,
    });

    expect(result.status).toBe('downloaded');
    expect(engine.calls).toEqual(['warmup', 'warmup']);
    await expect(isModelSetComplete(store, ONE_FILE_SPEC)).resolves.toBe(true);
  });
});

describe('resumable download (R17): abort mid-file resumes via Range from the OPFS offset, not from 0', () => {
  it('sends no Range header on the first attempt, then Range: bytes=<offset>- on resume, and reassembles the exact original bytes', async () => {
    const fs = new FakeFileSystem();
    const store = createFakeStore(fs);
    const chunks = makeChunks(100, 10); // 10 chunks of 10 bytes = 100 bytes total
    const expectedBytes = chunks.reduce((flat, c) => [...flat, ...c], [] as number[]);

    // First attempt: succeeds through 6 chunks (60 bytes), then the reader
    // rejects — simulating a dropped connection at 60%.
    const firstAttempt = streamingResponse(chunks, { failAfterChunks: 6 });
    const { fetchImpl: firstFetch, calls: firstCalls } = createFetchQueue([firstAttempt]);

    await expect(downloadModelSet(store, ONE_FILE_SPEC, firstFetch)).rejects.toThrow('simulated network drop');

    expect(firstCalls).toHaveLength(1);
    expect(firstCalls[0].headers.Range).toBeUndefined(); // fresh download, no prior bytes
    expect(concatFiles(fs, 'shard.onnx_data')).toHaveLength(60);
    await expect(isModelSetComplete(store, ONE_FILE_SPEC)).resolves.toBe(false);

    // Second attempt: resumes from the remaining 4 chunks (40 bytes).
    const remainingChunks = chunks.slice(6);
    const secondAttempt = streamingResponse(remainingChunks, { contentLength: 40 });
    const { fetchImpl: secondFetch, calls: secondCalls } = createFetchQueue([secondAttempt]);

    await downloadModelSet(store, ONE_FILE_SPEC, secondFetch);

    expect(secondCalls).toHaveLength(1);
    expect(secondCalls[0].headers.Range).toBe('bytes=60-'); // resumes from the OPFS-derived offset, not 0
    await expect(isModelSetComplete(store, ONE_FILE_SPEC)).resolves.toBe(true);
    expect(Array.from(concatFiles(fs, 'shard.onnx_data'))).toEqual(expectedBytes);
  });

  it('skips a file whose sentinel already exists rather than re-requesting it', async () => {
    const fs = new FakeFileSystem();
    const store = createFakeStore(fs);
    const spec: ModelSetSpec = {
      id: 'multi',
      files: [
        { url: 'https://example.invalid/a.onnx_data', fileName: 'a.onnx_data' },
        { url: 'https://example.invalid/b.onnx_data', fileName: 'b.onnx_data' },
      ],
    };

    await downloadModelSet(store, spec, createFetchQueue([streamingResponse(makeChunks(10, 10)), streamingResponse(makeChunks(10, 10))]).fetchImpl);
    expect(await isModelSetComplete(store, spec)).toBe(true);

    // Re-running the download must not touch the network at all — both files already have sentinels.
    const rerun = createFetchQueue([]);
    await downloadModelSet(store, spec, rerun.fetchImpl);
    expect(rerun.calls).toHaveLength(0);
  });
});

describe('"Modell löschen" (R19)', () => {
  it('removes the OPFS file and sentinel so the next presence check reports missing and offers the download again', async () => {
    const fs = new FakeFileSystem();
    const store = createFakeStore(fs);
    await downloadModelSet(store, ONE_FILE_SPEC, createFetchQueue([streamingResponse(makeChunks(10, 10))]).fetchImpl);
    expect(await isModelSetComplete(store, ONE_FILE_SPEC)).toBe(true);

    await deleteModelSet(store, ONE_FILE_SPEC);

    expect(await isModelSetComplete(store, ONE_FILE_SPEC)).toBe(false);
    expect(fs.files.has('shard.onnx_data')).toBe(false);
    expect(fs.files.has('shard.onnx_data.done')).toBe(false);

    // The next ensureModelSetReady call offers (and completes) the download again.
    const engine = fakeEngine();
    const { gate } = createStorageGate({ usage: 0, quota: 100_000_000_000 });
    const { fetchImpl, calls } = createFetchQueue([streamingResponse(makeChunks(10, 10))]);
    const result = await ensureModelSetReady(ONE_FILE_SPEC, {
      store,
      fetchImpl,
      storageGate: gate,
      requiredBytes: 1,
      engine,
    });
    expect(result.status).toBe('downloaded');
    expect(calls).toHaveLength(1);
  });
});

describe('RAM-unload after inactivity (R19): dispose() only, OPFS cache untouched, reload skips the network', () => {
  it('does not unload before the inactivity threshold, and does after it', () => {
    const tracker = new ModelActivityTracker(0, 1000);
    const engine = fakeEngine();

    expect(maybeUnloadForInactivity(tracker, 999, engine)).toBe(false);
    expect(engine.calls).toEqual([]);

    expect(maybeUnloadForInactivity(tracker, 1000, engine)).toBe(true);
    expect(engine.calls).toEqual(['dispose']);
  });

  it('recordActivity resets the idle clock', () => {
    const tracker = new ModelActivityTracker(0, 1000);
    tracker.recordActivity(500);
    expect(tracker.shouldUnload(1000)).toBe(false); // only 500ms since the reset
    expect(tracker.shouldUnload(1500)).toBe(true);
  });

  it('uses a sane, documented default threshold', () => {
    expect(DEFAULT_INACTIVITY_UNLOAD_MS).toBeGreaterThan(0);
    const tracker = new ModelActivityTracker(0);
    expect(tracker.shouldUnload(DEFAULT_INACTIVITY_UNLOAD_MS - 1)).toBe(false);
    expect(tracker.shouldUnload(DEFAULT_INACTIVITY_UNLOAD_MS)).toBe(true);
  });

  it('full cycle: unload -> OPFS cache still complete -> reload calls no fetch and re-warms up', async () => {
    const fs = new FakeFileSystem();
    const store = createFakeStore(fs);
    const engine = fakeEngine();
    const { gate } = createStorageGate({ usage: 0, quota: 100_000_000_000 });

    const initialFetch = createFetchQueue([streamingResponse(makeChunks(10, 10))]);
    await ensureModelSetReady(ONE_FILE_SPEC, {
      store,
      fetchImpl: initialFetch.fetchImpl,
      storageGate: gate,
      requiredBytes: 1,
      engine,
    });
    expect(engine.calls).toEqual(['warmup']);

    const tracker = new ModelActivityTracker(0, 1000);
    expect(maybeUnloadForInactivity(tracker, 1000, engine)).toBe(true);
    expect(engine.calls).toEqual(['warmup', 'dispose']);

    // OPFS cache must still be intact after an in-RAM unload.
    expect(await isModelSetComplete(store, ONE_FILE_SPEC)).toBe(true);

    const reloadFetch = createFetchQueue([]); // no responses queued: any fetch call would throw
    const result = await ensureModelSetReady(ONE_FILE_SPEC, {
      store,
      fetchImpl: reloadFetch.fetchImpl,
      storageGate: gate,
      requiredBytes: 1,
      engine,
    });

    expect(result.status).toBe('ready');
    expect(reloadFetch.calls).toHaveLength(0); // no network re-download
    expect(engine.calls).toEqual(['warmup', 'dispose', 'warmup']);
  });
});

describe('Progress aggregation across a model set (reuses progress.ts, DRY)', () => {
  it('is monotonically increasing and reaches 1 once every file completes', async () => {
    const fs = new FakeFileSystem();
    const store = createFakeStore(fs);
    const spec: ModelSetSpec = {
      id: 'multi',
      files: [
        { url: 'https://example.invalid/a.onnx_data', fileName: 'a.onnx_data' },
        { url: 'https://example.invalid/b.onnx_data', fileName: 'b.onnx_data' },
      ],
    };
    const { fetchImpl } = createFetchQueue([
      streamingResponse(makeChunks(40, 10)),
      streamingResponse(makeChunks(60, 10)),
    ]);

    const fractions: number[] = [];
    await downloadModelSet(store, spec, fetchImpl, { onProgress: (f) => fractions.push(f) });

    expect(fractions.length).toBeGreaterThan(0);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    }
    expect(fractions.at(-1)).toBeCloseTo(1, 5);
  });

  it('gives a pre-completed file full credit instead of dragging the aggregate down', async () => {
    const fs = new FakeFileSystem();
    const store = createFakeStore(fs);
    const spec: ModelSetSpec = {
      id: 'multi',
      files: [
        { url: 'https://example.invalid/a.onnx_data', fileName: 'a.onnx_data' },
        { url: 'https://example.invalid/b.onnx_data', fileName: 'b.onnx_data' },
      ],
    };

    // Pre-complete file "a" out of band (as if a previous run finished it).
    await downloadModelSet(store, { id: 'multi', files: [spec.files[0]] }, createFetchQueue([streamingResponse(makeChunks(10, 10))]).fetchImpl);

    const fractions: number[] = [];
    const { fetchImpl } = createFetchQueue([streamingResponse(makeChunks(10, 10))]);
    await downloadModelSet(store, spec, fetchImpl, { onProgress: (f) => fractions.push(f) });

    expect(fractions.at(-1)).toBeCloseTo(1, 5); // not stuck at 0.5
  });
});

describe('getModelSetSizeBytes (status display)', () => {
  it('is 0 before any download and the true byte total once files exist, including a partially-downloaded file', async () => {
    const fs = new FakeFileSystem();
    const store = createFakeStore(fs);
    const spec: ModelSetSpec = {
      id: 'multi',
      files: [
        { url: 'https://example.invalid/a.onnx_data', fileName: 'a.onnx_data' },
        { url: 'https://example.invalid/b.onnx_data', fileName: 'b.onnx_data' },
      ],
    };

    expect(await getModelSetSizeBytes(store, spec)).toBe(0);

    // Partially download "a" only (simulating an in-progress/aborted download).
    const partial = streamingResponse(makeChunks(100, 10), { failAfterChunks: 3 });
    await expect(downloadModelSet(store, { id: 'multi', files: [spec.files[0]] }, createFetchQueue([partial]).fetchImpl)).rejects.toThrow();

    expect(await getModelSetSizeBytes(store, spec)).toBe(30);
  });
});

describe('WHISPER_MODEL_SET (refactor plan 002 U2: concrete Whisper descriptor for Variante-A status/size display)', () => {
  it('builds every file URL via the one allowed connect-src foreign host', () => {
    expect(WHISPER_MODEL_SET.files.length).toBeGreaterThan(0);
    for (const file of WHISPER_MODEL_SET.files) {
      expect(file.url.startsWith('https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main/')).toBe(
        true,
      );
    }
  });

  it('has a stable, non-empty id', () => {
    expect(WHISPER_MODEL_SET.id).toBe('whisper-large-v3-turbo');
    expect(WHISPER_MODEL_SET.id.length).toBeGreaterThan(0);
  });

  it('WHISPER_REQUIRED_BYTES is in the ~1.5 GB fp16-encoder range, not the old ~2.5 GB figure', () => {
    // U8 settled on an fp16 encoder (~1 GB larger than the q4f16 one), so the
    // set is ~1.5 GB — still well under the 2.5 GB download it replaced.
    expect(WHISPER_REQUIRED_BYTES).toBeGreaterThan(1024 * 1024 * 1024);
    expect(WHISPER_REQUIRED_BYTES).toBeLessThan(2 * 1024 * 1024 * 1024);
  });
});

describe('DIARIZATION_MODEL_SET (U18/U21, KTD15: second model set, Variante-A status/size display)', () => {
  it('has exactly the two diarization files with the expected ids/fileNames/urls', () => {
    expect(DIARIZATION_MODEL_SET.id).toBe('diarization-pyannote-wespeaker');
    expect(DIARIZATION_MODEL_SET.files).toHaveLength(2);

    const [segmentation, embedding] = DIARIZATION_MODEL_SET.files;
    expect(segmentation.fileName).toBe('pyannote-segmentation.onnx');
    expect(segmentation.url).toBe(
      'https://huggingface.co/onnx-community/pyannote-segmentation-3.0/resolve/main/onnx/model.onnx',
    );
    expect(embedding.fileName).toBe('wespeaker-resnet34.onnx');
    expect(embedding.url).toBe(
      'https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM/resolve/main/onnx/model.onnx',
    );
  });

  it('DIARIZATION_REQUIRED_BYTES is a positive, roughly ~40 MB display figure', () => {
    expect(DIARIZATION_REQUIRED_BYTES).toBeGreaterThan(0);
    expect(DIARIZATION_REQUIRED_BYTES).toBeGreaterThan(30 * 1024 * 1024);
    expect(DIARIZATION_REQUIRED_BYTES).toBeLessThan(100 * 1024 * 1024);
  });

  it('is structurally accepted by isModelSetComplete/getModelSetSizeBytes/deleteModelSet like any other ModelSetSpec (smoke test)', async () => {
    const fs = new FakeFileSystem();
    const store = createFakeStore(fs);

    expect(await isModelSetComplete(store, DIARIZATION_MODEL_SET)).toBe(false);
    expect(await getModelSetSizeBytes(store, DIARIZATION_MODEL_SET)).toBe(0);

    await downloadModelSet(
      store,
      DIARIZATION_MODEL_SET,
      createFetchQueue([streamingResponse(makeChunks(10, 10)), streamingResponse(makeChunks(20, 10))]).fetchImpl,
    );
    expect(await isModelSetComplete(store, DIARIZATION_MODEL_SET)).toBe(true);
    expect(await getModelSetSizeBytes(store, DIARIZATION_MODEL_SET)).toBe(30);

    await deleteModelSet(store, DIARIZATION_MODEL_SET);
    expect(await isModelSetComplete(store, DIARIZATION_MODEL_SET)).toBe(false);
  });
});

describe('checkStorageGate (R19/R20: space check + persist() before download)', () => {
  it('requests persist() and reports enough space when quota comfortably exceeds the requirement', async () => {
    const { gate, persistCalls } = createStorageGate({ usage: 0, quota: 5_000_000_000, persistResult: true });
    const result = await checkStorageGate(gate, 2_500_000_000);
    expect(result.hasEnoughSpace).toBe(true);
    expect(result.persisted).toBe(true);
    expect(persistCalls).toHaveLength(1);
  });

  it('reports insufficient space when free space is below the requirement', async () => {
    const { gate } = createStorageGate({ usage: 4_900_000_000, quota: 5_000_000_000, persistResult: false });
    const result = await checkStorageGate(gate, 2_500_000_000);
    expect(result.hasEnoughSpace).toBe(false);
    expect(result.persisted).toBe(false);
  });

  it('treats an unknown estimate (API not fully supported) as non-blocking rather than failing closed', async () => {
    const { gate } = createStorageGate({});
    const result = await checkStorageGate(gate, 2_500_000_000);
    expect(result.hasEnoughSpace).toBe(true);
    expect(result.usageBytes).toBeNull();
    expect(result.quotaBytes).toBeNull();
  });

  it('ensureModelSetReady throws InsufficientStorageError and never touches fetch when the gate fails', async () => {
    const fs = new FakeFileSystem();
    const store = createFakeStore(fs);
    const { gate } = createStorageGate({ usage: 4_900_000_000, quota: 5_000_000_000 });
    const { fetchImpl, calls } = createFetchQueue([streamingResponse(makeChunks(10, 10))]);

    await expect(
      ensureModelSetReady(ONE_FILE_SPEC, {
        store,
        fetchImpl,
        storageGate: gate,
        requiredBytes: 2_500_000_000,
        engine: fakeEngine(),
      }),
    ).rejects.toBeInstanceOf(InsufficientStorageError);
    expect(calls).toHaveLength(0);
  });
});
