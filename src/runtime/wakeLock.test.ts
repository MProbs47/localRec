import { describe, expect, it, vi } from 'vitest';
import { WakeLockController, type WakeLockProviderLike, type WakeLockSentinelLike } from './wakeLock';

// Manual milestone (per plan U7 verification): a real `navigator.wakeLock`
// held on an actual device is NOT exercised by any automated test in this
// repo — there is no Wake Lock API in Node/Vitest. Everything below tests
// `WakeLockController`'s re-request/no-double-hold/release logic against a
// fake provider, per this file's "kapsle sie hinter einer injizierbaren
// Schnittstelle" instruction.

/** Minimal fake sentinel: `released` flips to `true` only when `release()` is called, or when a test simulates the OS silently dropping it (setting `.released` directly, matching the real spec's live property). */
class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  async release(): Promise<void> {
    this.released = true;
  }
}

/** Fake provider: hands out a fresh `FakeSentinel` per `request()` call, tracked so tests can assert how many times a lock was actually (re-)requested. */
function createFakeProvider() {
  const sentinels: FakeSentinel[] = [];
  const provider: WakeLockProviderLike = {
    request: vi.fn(async () => {
      const sentinel = new FakeSentinel();
      sentinels.push(sentinel);
      return sentinel;
    }),
  };
  return { provider, sentinels };
}

describe('WakeLockController.start (test scenario 3: acquires the lock at session start)', () => {
  it('requests a screen wake lock exactly once', async () => {
    const { provider } = createFakeProvider();
    const controller = new WakeLockController(provider);

    await controller.start();

    expect(provider.request).toHaveBeenCalledTimes(1);
    expect(provider.request).toHaveBeenCalledWith('screen');
    expect(controller.isHeld).toBe(true);
  });
});

describe('WakeLockController re-request on visibilitychange->visible (test scenario 3)', () => {
  it('re-requests when the OS silently released the lock while backgrounded', async () => {
    const { provider, sentinels } = createFakeProvider();
    const controller = new WakeLockController(provider);
    await controller.start();

    // Simulate the OS/browser silently releasing the lock when the tab was
    // backgrounded (spec behavior — no explicit `release()` call from us).
    sentinels[0].released = true;
    expect(controller.isHeld).toBe(false);

    await controller.handleVisibilityChange('visible');

    expect(provider.request).toHaveBeenCalledTimes(2);
    expect(controller.isHeld).toBe(true);
  });

  it('ignores "hidden" transitions — nothing to (re-)request while backgrounded', async () => {
    const { provider } = createFakeProvider();
    const controller = new WakeLockController(provider);
    await controller.start();

    await controller.handleVisibilityChange('hidden');

    expect(provider.request).toHaveBeenCalledTimes(1); // unchanged
  });

  it('does nothing if no session is active (no start() yet, or after stop())', async () => {
    const { provider } = createFakeProvider();
    const controller = new WakeLockController(provider);

    await controller.handleVisibilityChange('visible');
    expect(provider.request).not.toHaveBeenCalled();

    await controller.start();
    await controller.stop();
    await controller.handleVisibilityChange('visible');
    expect(provider.request).toHaveBeenCalledTimes(1); // only the original start(), not a post-stop re-request
  });
});

describe('WakeLockController avoids double-holding (test scenario 3)', () => {
  it('a visibilitychange->visible while still genuinely held does not request a second lock', async () => {
    const { provider } = createFakeProvider();
    const controller = new WakeLockController(provider);
    await controller.start();

    // The lock is still held (browser never released it) — a stray/extra
    // visibilitychange event must not double-acquire.
    await controller.handleVisibilityChange('visible');
    await controller.handleVisibilityChange('visible');

    expect(provider.request).toHaveBeenCalledTimes(1);
  });

  it('concurrent acquire attempts (fast hidden->visible flicker before the first request resolves) coalesce into one request', async () => {
    const sentinels: FakeSentinel[] = [];
    let resolveFirst: (sentinel: FakeSentinel) => void = () => {};
    const provider: WakeLockProviderLike = {
      request: vi.fn(() => {
        return new Promise<FakeSentinel>((resolve) => {
          resolveFirst = (sentinel) => {
            sentinels.push(sentinel);
            resolve(sentinel);
          };
        });
      }),
    };
    const controller = new WakeLockController(provider);

    const first = controller.start();
    const second = controller.handleVisibilityChange('visible'); // fires before the first request() has resolved

    resolveFirst(new FakeSentinel());
    await Promise.all([first, second]);

    expect(provider.request).toHaveBeenCalledTimes(1);
    expect(controller.isHeld).toBe(true);
  });
});

describe('WakeLockController.stop (test scenario 3: clean release)', () => {
  it('releases the held sentinel and clears session intent', async () => {
    const { provider, sentinels } = createFakeProvider();
    const controller = new WakeLockController(provider);
    await controller.start();

    await controller.stop();

    expect(sentinels[0].released).toBe(true);
    expect(controller.isHeld).toBe(false);
  });

  it('releases a lock that only resolves AFTER stop() — no orphaned lock from a start->immediate-stop race', async () => {
    // start() -> request('screen') is still in flight -> stop() is called
    // before it resolves -> then the request finally resolves. The
    // just-granted sentinel must be released immediately, never stored, so
    // no lock is left held with `#sessionActive === false`.
    let resolveRequest: (sentinel: FakeSentinel) => void = () => {};
    const granted = new FakeSentinel();
    const provider: WakeLockProviderLike = {
      request: vi.fn(() => new Promise<FakeSentinel>((resolve) => {
        resolveRequest = resolve;
      })),
    };
    const controller = new WakeLockController(provider);

    const startPromise = controller.start(); // request() now pending
    await controller.stop(); // session ends before the lock is granted

    resolveRequest(granted); // the in-flight request resolves now, post-stop
    await startPromise;

    expect(granted.released).toBe(true); // the orphan was released, not kept
    expect(controller.isHeld).toBe(false);
  });

  it('is a safe no-op when nothing is held (never started, or called twice)', async () => {
    const { provider } = createFakeProvider();
    const controller = new WakeLockController(provider);

    await expect(controller.stop()).resolves.toBeUndefined();

    await controller.start();
    await controller.stop();
    await expect(controller.stop()).resolves.toBeUndefined(); // second stop() is a no-op, not a double-release error
  });
});

describe('getBrowserWakeLockProvider (real-API Andockpunkt)', () => {
  it('returns null when navigator.wakeLock is unavailable, rather than throwing', async () => {
    const { getBrowserWakeLockProvider } = await import('./wakeLock');
    // No `navigator` global exists under `tsconfig.node.json`/Vitest's Node
    // environment (this file's Realitäts-Grenze) — asserts the graceful
    // `null` fallback path, not the real browser path.
    expect(getBrowserWakeLockProvider()).toBeNull();
  });
});
