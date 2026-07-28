// Realitätsgrenze: neither Cache Storage nor a service worker exists in
// Node/Vitest (see `appShellCache.ts`'s header). Both surfaces are injected
// as narrow structural fakes, so the module's actual keep/delete decision
// and its never-throws contract run for real against them.
import { describe, expect, it } from 'vitest';
import {
  clearAppShellCache,
  KEPT_CACHE_NAMES,
  type CacheStorageLike,
  type ServiceWorkerContainerLike,
} from './appShellCache';

function fakeCaches(names: string[]): CacheStorageLike & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async keys() {
      return names;
    },
    async delete(name: string) {
      deleted.push(name);
      return true;
    },
  };
}

function fakeServiceWorker(count: number): ServiceWorkerContainerLike & { unregistered: number } {
  const container = {
    unregistered: 0,
    async getRegistrations() {
      return Array.from({ length: count }, () => ({
        async unregister() {
          container.unregistered++;
          return true;
        },
      }));
    },
  };
  return container;
}

describe('clearAppShellCache', () => {
  it('deletes the app-shell caches and unregisters the service worker', async () => {
    const caches = fakeCaches(['workbox-precache-v2-https://localrec.pages.dev/', 'irgendwas-altes']);
    const serviceWorker = fakeServiceWorker(1);

    await clearAppShellCache({ caches, serviceWorker });

    expect(caches.deleted).toEqual([
      'workbox-precache-v2-https://localrec.pages.dev/',
      'irgendwas-altes',
    ]);
    expect(serviceWorker.unregistered).toBe(1);
  });

  // The expensive-download guarantee: a 23 MB re-download (and a broken
  // airplane-mode run until the next online session) is exactly what this
  // button must not cost.
  it('keeps every cache on the keep list', async () => {
    const caches = fakeCaches([...KEPT_CACHE_NAMES, 'workbox-precache-v2-x']);

    await clearAppShellCache({ caches, serviceWorker: fakeServiceWorker(0) });

    expect(caches.deleted).toEqual(['workbox-precache-v2-x']);
  });

  /**
   * Names the model caches LITERALLY, on purpose — the test above is written
   * against `KEPT_CACHE_NAMES` itself and therefore passes no matter what that
   * list contains. Until the offline measurement of 2026-07-28 the list held
   * only the WASM backend, so this button silently deleted ~1.5 GB of models
   * while its own header explained why that must never happen. A tautological
   * assertion cannot catch that; a literal one can.
   */
  it('keeps the model caches — the ~1.5 GB download must survive the button', async () => {
    const caches = fakeCaches(['transformers-cache', 'ort-model-cache', 'workbox-precache-v2-x']);

    await clearAppShellCache({ caches, serviceWorker: fakeServiceWorker(0) });

    expect(caches.deleted).toEqual(['workbox-precache-v2-x']);
  });

  it('resolves quietly when the browser has neither Cache Storage nor a service worker', async () => {
    await expect(clearAppShellCache({ caches: undefined, serviceWorker: undefined })).resolves.toBeUndefined();
  });

  it('still unregisters the worker when a cache refuses to be deleted', async () => {
    const serviceWorker = fakeServiceWorker(2);
    const caches: CacheStorageLike = {
      async keys() {
        return ['workbox-precache-v2-x'];
      },
      async delete() {
        throw new Error('cache locked');
      },
    };

    await expect(clearAppShellCache({ caches, serviceWorker })).resolves.toBeUndefined();
    expect(serviceWorker.unregistered).toBe(2);
  });

  it('never rejects when listing the caches or the registrations throws', async () => {
    const caches: CacheStorageLike = {
      async keys() {
        throw new Error('Cache Storage unavailable');
      },
      async delete() {
        return false;
      },
    };
    const serviceWorker: ServiceWorkerContainerLike = {
      async getRegistrations() {
        throw new Error('service workers disabled');
      },
    };

    await expect(clearAppShellCache({ caches, serviceWorker })).resolves.toBeUndefined();
  });
});
