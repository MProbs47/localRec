/**
 * The "und wirklich neu" half of `App.tsx`'s «Löschen & neu laden» engraving:
 * drops the PWA's cached app shell and the service worker holding it, so the
 * reload right after fetches the current build from the network.
 *
 * **Why this exists (owner feedback, 2026-07-27).** The app registers its
 * service worker with `registerType: 'autoUpdate'` (`vite.config.ts`), so a
 * new build DOES arrive on its own — but only after the worker has installed
 * it, which typically costs a second reload. Until then the page keeps
 * running the precached old bundle. The escape hatch browsers offer for this
 * is a hard reload (Ctrl+Shift+R), which most people don't know. The
 * engraving under the display is the one button in this app that already
 * promises «löschen und neu laden»; making it also clear the app-shell cache
 * turns that promise into something a non-technical tester can actually use
 * ("klick das, dann hast du die neue Version") instead of a keyboard trick.
 *
 * **What is deliberately kept.** Only the app shell goes — never the
 * expensive downloads:
 * - The **Whisper/speaker models (~1.5 GB)** aren't reachable from here at
 *   all: they live in OPFS (`modelCache.ts`), not in the Cache Storage this
 *   module touches. Nothing to guard, but worth stating — losing them to a
 *   cache-clearing button would be the single most expensive mistake this
 *   file could make.
 * - The **ONNX-Runtime WASM backend** (~23 MB) IS in Cache Storage, under
 *   `KEPT_CACHE_NAMES` below, and is skipped. It is content-hashed and
 *   therefore immutable (a new runtime version means a new URL, i.e. a
 *   natural cache miss), so keeping it can never serve a stale binary — and
 *   dropping it would both cost the tester a needless 23 MB re-download and
 *   break the airplane-mode guarantee until the next online run
 *   (`vite.config.ts`'s `runtimeCaching` rule exists for exactly that).
 *
 * **Unregistering the worker, not just emptying the caches.** An active
 * worker keeps its precache *manifest* (URL → revision) in memory; deleting
 * the caches underneath it leaves it answering for entries that no longer
 * exist. Unregistering first means the reload is served straight from the
 * network, and the fresh build registers its own worker again on load.
 *
 * **Never throws — the reload must not hinge on this.** Every step is
 * best-effort and independently guarded: a browser without Cache Storage or
 * service workers (jsdom in tests, an embedded webview), a locked cache, a
 * refused unregister — each resolves quietly instead of swallowing the
 * refresh the label promises. Same posture as `deleteFallbackArtifacts()`
 * in `output/fileSink.ts`, which the same click calls.
 *
 * Both browser surfaces are reached through injected, structurally narrowed
 * shims (`AppShellCacheDeps`, defaulting to `globalThis`) — the same
 * discipline as `modelCache.ts`'s `fetchImpl`/`storageGate`, so the logic
 * here is testable without a real service worker.
 */

/**
 * Cache Storage entries that survive the wipe, by name. Currently just the
 * ONNX-Runtime WASM cache — it must stay byte-identical to
 * `vite.config.ts`'s `runtimeCaching` `cacheName`, or this module would
 * cheerfully delete the very cache that rule fills. `vite.config.test.ts`
 * asserts the two still match, so the coupling can't drift silently.
 */
export const KEPT_CACHE_NAMES: readonly string[] = ['onnx-runtime-wasm'];

/** The slice of `CacheStorage` this module needs — list the caches, delete some of them. */
export interface CacheStorageLike {
  keys(): Promise<string[]>;
  delete(cacheName: string): Promise<boolean>;
}

/** The slice of `ServiceWorkerContainer` this module needs. */
export interface ServiceWorkerContainerLike {
  getRegistrations(): Promise<{ unregister(): Promise<boolean> }[]>;
}

export interface AppShellCacheDeps {
  /** Defaults to `globalThis.caches` (absent in jsdom/tests → no-op). */
  caches?: CacheStorageLike;
  /** Defaults to `globalThis.navigator.serviceWorker` (absent in jsdom/tests → no-op). */
  serviceWorker?: ServiceWorkerContainerLike;
}

interface GlobalWithCaches {
  caches?: CacheStorageLike;
  navigator?: { serviceWorker?: ServiceWorkerContainerLike };
}

function defaultDeps(): AppShellCacheDeps {
  const scope = globalThis as unknown as GlobalWithCaches;
  return { caches: scope.caches, serviceWorker: scope.navigator?.serviceWorker };
}

/**
 * Deletes every Cache Storage entry except `KEPT_CACHE_NAMES` and unregisters
 * this origin's service workers. Resolves (never rejects) in every case,
 * including browsers that have neither API — see the file header.
 */
export async function clearAppShellCache(deps: AppShellCacheDeps = {}): Promise<void> {
  const defaults = defaultDeps();
  const cacheStorage = deps.caches ?? defaults.caches;
  const serviceWorker = deps.serviceWorker ?? defaults.serviceWorker;

  if (cacheStorage) {
    try {
      const names = await cacheStorage.keys();
      await Promise.all(
        names
          .filter((name) => !KEPT_CACHE_NAMES.includes(name))
          // Per-cache guard: one undeletable cache must not strand the others.
          .map((name) => cacheStorage.delete(name).catch(() => false)),
      );
    } catch {
      // No Cache Storage, or listing refused — nothing to clear.
    }
  }

  if (serviceWorker) {
    try {
      const registrations = await serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
    } catch {
      // No service worker support, or the container refused — the cache wipe
      // above still stands, and the reload happens either way.
    }
  }
}
