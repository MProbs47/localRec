/**
 * Cache-Storage-backed byte loader for ONNX models that are handed to
 * onnxruntime-web **directly**, without transformers.js in between.
 *
 * **Why this exists (offline measurement, 2026-07-28).** transformers.js caches
 * every file it downloads in Cache Storage on its own, which is why the Whisper
 * encoder/decoder and the pyannote segmentation model survive a reload and an
 * airplane-mode run. WeSpeaker does not go through transformers.js (it has no
 * embedding pipeline — see `diarization.worker.ts`'s header), so its session was
 * built from a *URL*: `InferenceSession.create(url)` makes ORT fetch the file
 * itself, past that caching layer. The measured consequence was that speaker
 * detection was the one feature that still needed the network after the
 * "one-time" download — the airplane-mode run transcribed fine from cache and
 * then died on `TypeError: Failed to fetch` for this single ~26 MB file.
 *
 * Handing ORT **bytes** instead of a URL is what closes that hole: the fetch
 * becomes ours, and so does the decision to keep the result.
 *
 * **Cache Storage, not OPFS.** The heavier machinery in `modelCache.ts`
 * (resumable Range downloads, `.done` sentinels, completeness checks) earns its
 * keep for a 1.3 GB shard, where an interrupted download costs twenty minutes.
 * For a file this size the recovery path is "fetch it again", which costs
 * seconds — and a second storage mechanism next to the Cache Storage the other
 * models already live in would mean two eviction stories and two places to
 * clear. Same reason the cache name below is kept out of
 * `appShellCache.ts`'s wipe (see `KEPT_CACHE_NAMES` there).
 *
 * **A caching failure must never fail the load.** Every cache interaction is
 * best-effort: no Cache Storage at all (Node/Vitest, a locked-down webview), a
 * refused `open`, a `put` that hits the quota — each falls through to the plain
 * fetch that worked before this module existed. The one thing that DOES
 * propagate is a failed download, because there are no bytes to return then.
 * A refused `put` is logged (`console.warn`), not swallowed: silent
 * non-persistence is exactly the failure mode that cost this project a night.
 *
 * Browser surfaces come in through injected, structurally narrowed shims
 * (`OrtModelCacheDeps`, defaulting to `globalThis`) — the same discipline as
 * `modelCache.ts`'s `fetchImpl`/`storageGate` and `appShellCache.ts`'s deps, so
 * the logic here is testable in Node without Cache Storage or a real model.
 */

/**
 * Cache Storage entry holding raw ONNX model bytes this app fetched itself.
 * Deliberately its own name rather than transformers.js' `transformers-cache`:
 * that cache belongs to a third-party library which is free to rename or prune
 * it, and mixing our entries in would make "who owns this" unanswerable. Must
 * stay listed in `appShellCache.ts`'s `KEPT_CACHE_NAMES` — a wipe here would
 * silently break the airplane-mode guarantee for speaker detection.
 */
export const ORT_MODEL_CACHE_NAME = 'ort-model-cache';

/** The slice of `Response` this module reads. */
export interface ModelResponseLike {
  ok: boolean;
  status: number;
  /** Must be called BEFORE the body is consumed — `put` and `arrayBuffer` each need their own copy. */
  clone(): ModelResponseLike;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The slice of `Cache` this module uses. */
export interface ModelCacheLike {
  match(key: string): Promise<ModelResponseLike | undefined>;
  put(key: string, response: ModelResponseLike): Promise<void>;
}

/** The slice of `CacheStorage` this module uses — opening one named cache. */
export interface ModelCacheStorageLike {
  open(cacheName: string): Promise<ModelCacheLike>;
}

export type ModelFetchLike = (url: string) => Promise<ModelResponseLike>;

export interface OrtModelCacheDeps {
  /** Defaults to `globalThis.caches` (absent in Node/Vitest → plain fetch, no caching). */
  caches?: ModelCacheStorageLike;
  /** Defaults to `globalThis.fetch`. */
  fetchImpl?: ModelFetchLike;
  /** Defaults to `console.warn` — where a refused `put` is reported. */
  warn?: (message: string, error: unknown) => void;
}

interface GlobalWithCaches {
  caches?: ModelCacheStorageLike;
  fetch?: ModelFetchLike;
}

/**
 * Returns the model's bytes, from Cache Storage when present, otherwise from
 * the network — storing them on the way through so the next run needs no
 * network. Rejects only when the download itself fails.
 */
export async function fetchOrtModelCached(url: string, deps: OrtModelCacheDeps = {}): Promise<ArrayBuffer> {
  const scope = globalThis as unknown as GlobalWithCaches;
  const cacheStorage = deps.caches ?? scope.caches;
  const fetchImpl = deps.fetchImpl ?? scope.fetch?.bind(globalThis);
  const warn = deps.warn ?? ((message: string, error: unknown) => console.warn(message, error));

  if (!fetchImpl) throw new Error('ortModelCache: no fetch available');

  // `open` can reject (private mode with storage disabled, a locked profile) —
  // that is a reason to skip caching, never a reason to skip the model.
  let cache: ModelCacheLike | undefined;
  if (cacheStorage) {
    try {
      cache = await cacheStorage.open(ORT_MODEL_CACHE_NAME);
    } catch (error) {
      warn(`[ortModelCache] cache unavailable, falling back to network for ${url}:`, error);
    }
  }

  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) return await hit.arrayBuffer();
    } catch (error) {
      // A corrupt/unreadable entry must not strand the load — re-download below.
      warn(`[ortModelCache] cached entry unreadable, re-downloading ${url}:`, error);
    }
  }

  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`ortModelCache: ${url} → HTTP ${response.status}`);

  // Clone first: `put` and `arrayBuffer()` each consume a body, and the clone
  // must be taken while the original is still unread.
  const forCache = cache ? response.clone() : undefined;
  const bytes = await response.arrayBuffer();

  if (cache && forCache) {
    try {
      await cache.put(url, forCache);
    } catch (error) {
      // The model works this run; only the offline guarantee is lost. Loud on
      // purpose — this is the exact silent failure this module was written for.
      warn(`[ortModelCache] could not store ${url} — it will be downloaded again next time:`, error);
    }
  }

  return bytes;
}
