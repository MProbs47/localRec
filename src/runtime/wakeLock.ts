/**
 * U7 (R14): keeps the screen awake for the duration of a recording session
 * via the Screen Wake Lock API. The browser silently releases a held lock
 * whenever the tab is backgrounded (spec behavior, not a bug) — the app
 * must notice and re-request it once the tab is foregrounded again, or a
 * long session loses the lock the first time the user checks another tab.
 *
 * `navigator.wakeLock` is browser-only and doesn't exist in Node/Vitest
 * (this file's "Realitäts-Grenze" — the plan calls the real lock a manual
 * milestone). Same fix as `recorder.ts`/`opfsAudio.ts`: the real API is
 * reached only through a narrow, structural, **injectable** interface
 * (`WakeLockProviderLike`/`WakeLockSentinelLike`), so `WakeLockController`
 * below — the actual re-request/no-double-hold/release logic — is fully
 * testable against a fake provider without a real browser.
 *
 * **Re-request logic (the part this unit is actually testing).**
 * `WakeLockController` tracks two independent things:
 *  - `#sessionActive`: whether a recording session currently *wants* the
 *    lock held (set by `start()`, cleared by `stop()`).
 *  - `#sentinel`: the currently held sentinel, if any. A real
 *    `WakeLockSentinel` exposes a live `released` boolean per spec (flips
 *    to `true` the moment the OS/browser releases it) — `isHeld` reads
 *    that flag directly rather than this class trying to independently
 *    track "did the browser release it yet".
 *
 * `handleVisibilityChange('visible')` only re-requests when the session
 * still wants the lock AND it isn't currently held — that combination is
 * exactly "avoid double-holding" (a second `request()` while one is
 * already active would leak a sentinel and, per spec, is simply
 * redundant) while still recovering from the OS's silent release.
 * Concurrent calls (e.g. a fast hidden->visible flicker firing
 * `handleVisibilityChange` twice before the first `request()` resolves)
 * are coalesced onto the same in-flight request rather than firing two.
 *
 * **Andockpunkt (not wired in this unit — see this unit's report):**
 * `App.tsx`'s `startRecording`/`stopRecording` would call
 * `controller.start()`/`controller.stop()`, and a
 * `document.addEventListener('visibilitychange', () =>
 * controller.handleVisibilityChange(document.visibilityState))` registered
 * once alongside the worker setup would call
 * `controller.handleVisibilityChange()`. The real sentinel comes from
 * `getBrowserWakeLockProvider()` below.
 */

/**
 * The exact structural slice of the real `WakeLockSentinel` this file
 * depends on — just enough to check "is it still held" and "release it",
 * nothing else (no `type`/`addEventListener`, since nothing here needs
 * them; keeps the fake in `wakeLock.test.ts` minimal too).
 */
export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
}

/** The exact structural slice of the real `navigator.wakeLock` this file depends on. */
export interface WakeLockProviderLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/**
 * Owns one recording session's wake lock lifecycle: acquire at `start()`,
 * re-acquire on `handleVisibilityChange('visible')` if the OS silently
 * dropped it, release cleanly at `stop()`. Holds no browser API reference
 * directly — everything goes through the injected `WakeLockProviderLike`.
 */
export class WakeLockController {
  readonly #provider: WakeLockProviderLike;
  #sentinel: WakeLockSentinelLike | null = null;
  #sessionActive = false;
  /** In-flight `request()` call, if any — lets concurrent acquire attempts (e.g. a visibilitychange flicker) coalesce onto the same request instead of firing a second one. */
  #acquiring: Promise<void> | null = null;

  constructor(provider: WakeLockProviderLike) {
    this.#provider = provider;
  }

  /** True while a sentinel is held and the browser hasn't (yet) released it. */
  get isHeld(): boolean {
    return this.#sentinel !== null && !this.#sentinel.released;
  }

  /** Marks the session as wanting the lock held and requests it once. Safe to call even if already held (e.g. a caller re-invoking `start()`) — `#acquire()` itself avoids duplicate concurrent requests, and a second `start()` while already held just re-marks the intent. */
  async start(): Promise<void> {
    this.#sessionActive = true;
    if (this.isHeld) return;
    await this.#acquire();
  }

  /**
   * Call on `visibilitychange` transitions. Only reacts to `'visible'`
   * (there's nothing to do on `'hidden'` — the OS releases the lock on its
   * own), and only re-requests if the session still wants the lock held
   * AND it isn't currently held — the combination that prevents both a
   * missed re-acquire and a double-hold.
   */
  async handleVisibilityChange(state: 'visible' | 'hidden'): Promise<void> {
    if (state !== 'visible' || !this.#sessionActive) return;
    if (this.isHeld) return;
    await this.#acquire();
  }

  /** Releases the held sentinel (if any) and clears session intent, so a later `handleVisibilityChange('visible')` won't re-acquire. Safe to call when nothing is held. */
  async stop(): Promise<void> {
    this.#sessionActive = false;
    const sentinel = this.#sentinel;
    this.#sentinel = null;
    if (sentinel && !sentinel.released) {
      await sentinel.release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#acquiring) {
      await this.#acquiring;
      return;
    }
    const requestPromise = this.#provider.request('screen').then(async (sentinel) => {
      // Guard the async gap: `stop()` (or a `handleVisibilityChange('hidden')`
      // + `stop()`) may have cleared `#sessionActive` while `request('screen')`
      // was still in flight (start -> immediate stop). If the session no
      // longer wants the lock, release the just-granted sentinel immediately
      // and never store it — otherwise a lock would stay held with no session,
      // and nothing would ever free it (screen stuck on).
      if (!this.#sessionActive) {
        if (!sentinel.released) await sentinel.release();
        return;
      }
      this.#sentinel = sentinel;
    });
    this.#acquiring = requestPromise.finally(() => {
      this.#acquiring = null;
    });
    await this.#acquiring;
  }
}

// --- Real Wake Lock Andockpunkt (manual milestone, not unit-tested) ------
//
// `navigator.wakeLock` only exists in a real browser (and only securely,
// over HTTPS/localhost) — there is no Wake Lock API in Node/Vitest, so this
// is never exercised by an automated test in this repo. Reached through
// `globalThis` rather than the ambient DOM identifier, same reasoning as
// `recorder.ts`'s `getMediaRecorderCtor()`/`opfsAudio.ts`'s
// `getOpfsStorage()` (this file, like those, is imported by
// `tsconfig.node.json`-typechecked tests that don't have the "DOM" lib).

/** Returns the real browser wake lock provider, or `null` if the API isn't available (older Safari/Firefox, or a non-secure context) — callers should treat `null` as "screen may turn off", not as an error (KTD/CLAUDE.md: never a hard failure over an optional durability feature). */
export function getBrowserWakeLockProvider(): WakeLockProviderLike | null {
  const nav = (globalThis as unknown as { navigator?: { wakeLock?: WakeLockProviderLike } }).navigator;
  return nav?.wakeLock ?? null;
}
