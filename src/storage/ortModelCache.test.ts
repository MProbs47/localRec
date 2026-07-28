import { describe, expect, it } from 'vitest';
import {
  fetchOrtModelCached,
  ORT_MODEL_CACHE_NAME,
  type ModelCacheLike,
  type ModelCacheStorageLike,
  type ModelFetchLike,
  type ModelResponseLike,
} from './ortModelCache';

// --- Fakes -----------------------------------------------------------------
// No real Cache Storage or network in Node/Vitest (this repo's stated
// Realitäts-Grenze) — these drive the exact clone/consume ordering a real
// `Response` enforces, mirroring modelCache.test.ts's fake-fetch pattern.

/** A body that may be read exactly once, like a real `Response`. */
function fakeResponse(body: string, init: { ok?: boolean; status?: number } = {}): ModelResponseLike {
  let consumed = false;
  const self: ModelResponseLike = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    clone: () => fakeResponse(body, init),
    arrayBuffer: async () => {
      if (consumed) throw new Error('body already consumed');
      consumed = true;
      return new TextEncoder().encode(body).buffer as ArrayBuffer;
    },
  };
  return self;
}

function decode(bytes: ArrayBuffer): string {
  return new TextDecoder().decode(new Uint8Array(bytes));
}

interface FakeCache extends ModelCacheLike {
  entries: Map<string, string>;
  putCalls: string[];
}

function fakeCache(overrides: Partial<ModelCacheLike> = {}): FakeCache {
  const entries = new Map<string, string>();
  const putCalls: string[] = [];
  return {
    entries,
    putCalls,
    match: overrides.match ?? (async (key) => (entries.has(key) ? fakeResponse(entries.get(key)!) : undefined)),
    put:
      overrides.put ??
      (async (key, response) => {
        putCalls.push(key);
        entries.set(key, decode(await response.arrayBuffer()));
      }),
  };
}

function fakeCaches(cache: ModelCacheLike): ModelCacheStorageLike & { openedNames: string[] } {
  const openedNames: string[] = [];
  return {
    openedNames,
    open: async (name) => {
      openedNames.push(name);
      return cache;
    },
  };
}

/** Counts network hits, so "did this need the network?" is directly assertable. */
function countingFetch(body = 'MODEL-BYTES', init?: { ok?: boolean; status?: number }): ModelFetchLike & { calls: number } {
  const impl: ModelFetchLike & { calls: number } = Object.assign(
    async () => {
      impl.calls += 1;
      return fakeResponse(body, init);
    },
    { calls: 0 },
  );
  return impl;
}

const URL = 'https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM/resolve/main/onnx/model.onnx';

// --- Tests -----------------------------------------------------------------

describe('fetchOrtModelCached', () => {
  it('downloads and stores the model on a cold cache', async () => {
    const cache = fakeCache();
    const caches = fakeCaches(cache);
    const fetchImpl = countingFetch();

    const bytes = await fetchOrtModelCached(URL, { caches, fetchImpl });

    expect(decode(bytes)).toBe('MODEL-BYTES');
    expect(fetchImpl.calls).toBe(1);
    expect(caches.openedNames).toEqual([ORT_MODEL_CACHE_NAME]);
    expect(cache.putCalls).toEqual([URL]);
    // The stored copy must be the FULL body — a clone taken after the original
    // was read would silently store nothing.
    expect(cache.entries.get(URL)).toBe('MODEL-BYTES');
  });

  /**
   * The whole point of this module (offline measurement 2026-07-28): the second
   * run must not touch the network, or airplane mode kills speaker detection.
   */
  it('serves a warm cache without any network call', async () => {
    const cache = fakeCache();
    cache.entries.set(URL, 'MODEL-BYTES');
    const fetchImpl = countingFetch();

    const bytes = await fetchOrtModelCached(URL, { caches: fakeCaches(cache), fetchImpl });

    expect(decode(bytes)).toBe('MODEL-BYTES');
    expect(fetchImpl.calls).toBe(0);
  });

  it('still returns the model when Cache Storage is missing entirely', async () => {
    const fetchImpl = countingFetch();

    const bytes = await fetchOrtModelCached(URL, { caches: undefined, fetchImpl });

    expect(decode(bytes)).toBe('MODEL-BYTES');
    expect(fetchImpl.calls).toBe(1);
  });

  it('falls back to the network when opening the cache is refused', async () => {
    const caches: ModelCacheStorageLike = {
      open: async () => {
        throw new Error('storage disabled');
      },
    };
    const fetchImpl = countingFetch();
    const warnings: string[] = [];

    const bytes = await fetchOrtModelCached(URL, { caches, fetchImpl, warn: (message) => warnings.push(message) });

    expect(decode(bytes)).toBe('MODEL-BYTES');
    expect(fetchImpl.calls).toBe(1);
    expect(warnings).toHaveLength(1);
  });

  it('re-downloads when a cached entry turns out to be unreadable', async () => {
    const cache = fakeCache({
      match: async () => {
        throw new Error('corrupt entry');
      },
    });
    const fetchImpl = countingFetch();
    const warnings: string[] = [];

    const bytes = await fetchOrtModelCached(URL, {
      caches: fakeCaches(cache),
      fetchImpl,
      warn: (message) => warnings.push(message),
    });

    expect(decode(bytes)).toBe('MODEL-BYTES');
    expect(fetchImpl.calls).toBe(1);
    expect(warnings).toHaveLength(1);
  });

  /**
   * The failure that cost this project a night: a `put` that dies with Chrome's
   * opaque `UnknownError`. The model must still load — but it must NOT do so
   * silently, or "nothing was logged" reads as "everything was stored".
   */
  it('returns the model but warns loudly when storing is refused', async () => {
    const cache = fakeCache({
      put: async () => {
        throw new Error("Failed to execute 'put' on 'Cache': Unexpected internal error.");
      },
    });
    const fetchImpl = countingFetch();
    const warnings: string[] = [];

    const bytes = await fetchOrtModelCached(URL, {
      caches: fakeCaches(cache),
      fetchImpl,
      warn: (message) => warnings.push(message),
    });

    expect(decode(bytes)).toBe('MODEL-BYTES');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('could not store');
  });

  it('rejects on a failed download instead of returning an empty model', async () => {
    const cache = fakeCache();
    const fetchImpl = countingFetch('', { ok: false, status: 503 });

    await expect(fetchOrtModelCached(URL, { caches: fakeCaches(cache), fetchImpl })).rejects.toThrow('503');
    expect(cache.putCalls).toEqual([]);
  });

  it('propagates a network failure — offline with a cold cache has no answer', async () => {
    const cache = fakeCache();
    const fetchImpl: ModelFetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };

    await expect(fetchOrtModelCached(URL, { caches: fakeCaches(cache), fetchImpl })).rejects.toThrow('Failed to fetch');
  });
});
