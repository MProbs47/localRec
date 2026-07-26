// Realitätsgrenze: `new Worker(new URL(...), {type:'module'})` doesn't run
// under Vitest, so every test constructs `Engine` with injected factories —
// a fake transcription api (`vi.fn` control surface) driving a captured raw
// `message` listener (to exercise `onSegment`/the stop-ordering invariant),
// and a fake diarization api. Mirrors `liveCapture.test.ts`'s fake-structural-
// interface pattern one layer up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, type EngineDeps, type WorkerLike } from './engine';
import type { TranscriptMessage } from '../worker/transcription.worker';

/** A fake `WorkerLike` that captures its `message`/`error` listeners so a test can drive them directly (simulating the worker's raw `postMessage`, resp. a worker crash). */
function fakeWorker(): WorkerLike & {
  dispatch: (message: TranscriptMessage) => void;
  crash: (message?: string) => void;
  terminate: ReturnType<typeof vi.fn<() => void>>;
  removeEventListener: ReturnType<typeof vi.fn<(type: string, listener: (event: MessageEvent) => void) => void>>;
} {
  // Keyed by event type: `Engine` registers both `message` and `error`, and a
  // single-slot listener would let the later one clobber the former.
  const listeners = new Map<string, (event: MessageEvent) => void>();
  return {
    addEventListener: vi.fn((type: string, l: (event: MessageEvent) => void) => {
      listeners.set(type, l);
    }),
    removeEventListener: vi.fn(),
    terminate: vi.fn<() => void>(),
    dispatch(message: TranscriptMessage) {
      listeners.get('message')?.({ data: message } as MessageEvent);
    },
    crash(message?: string) {
      listeners.get('error')?.({ message } as unknown as MessageEvent);
    },
  };
}

interface FakeTranscriptionApi {
  initialize: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  feedAudio: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  transcribeFile: ReturnType<typeof vi.fn>;
}

function fakeTranscriptionApi(): FakeTranscriptionApi {
  return {
    initialize: vi.fn(async () => {}),
    start: vi.fn(),
    feedAudio: vi.fn(),
    stop: vi.fn(async () => {}),
    transcribeFile: vi.fn(async () => []),
  };
}

interface FakeDiarizationApi {
  initialize: ReturnType<typeof vi.fn>;
  diarizeAudio: ReturnType<typeof vi.fn>;
}

function fakeDiarizationApi(): FakeDiarizationApi {
  return {
    initialize: vi.fn(async () => {}),
    diarizeAudio: vi.fn(async () => []),
  };
}

/** Builds a fully-faked `Engine` — a captured transcription worker/api and a factory for a fresh diarization worker/api per call (Engine only ever calls it once, lazily). `hasWebGpu` defaults to `() => true`: Engine's tests run under `environment: 'node'` (no real `navigator`), and the default WebGPU precheck would otherwise fail every existing `load()` test — the happy path here mirrors "WebGPU present", the common case; the precheck's own describe block below overrides it. */
function buildEngine(overrides?: {
  transcriptionApi?: FakeTranscriptionApi;
  diarizationApi?: FakeDiarizationApi;
  hasWebGpu?: () => boolean;
}) {
  const transcriptionWorker = fakeWorker();
  const transcriptionApi = overrides?.transcriptionApi ?? fakeTranscriptionApi();
  const diarizationWorker = fakeWorker();
  const diarizationApi = overrides?.diarizationApi ?? fakeDiarizationApi();

  const deps: EngineDeps = {
    createTranscriptionWorker: () => transcriptionWorker,
    wrapTranscriptionApi: () => transcriptionApi as unknown as ReturnType<NonNullable<EngineDeps['wrapTranscriptionApi']>>,
    createDiarizationWorker: () => diarizationWorker,
    wrapDiarizationApi: () => diarizationApi as unknown as ReturnType<NonNullable<EngineDeps['wrapDiarizationApi']>>,
    hasWebGpu: overrides?.hasWebGpu ?? (() => true),
  };
  const engine = new Engine(deps);
  return { engine, transcriptionWorker, transcriptionApi, diarizationWorker, diarizationApi };
}

describe('Engine readiness FSM', () => {
  it('starts absent', () => {
    const { engine } = buildEngine();
    expect(engine.getSnapshot()).toEqual({ status: 'absent', progress: 0, error: null });
  });

  it('goes absent -> downloading -> ready, ticking progress via the injected initialize callback', async () => {
    const transcriptionApi = fakeTranscriptionApi();
    transcriptionApi.initialize.mockImplementation(async (onProgress: (fraction: number) => void) => {
      onProgress(0.25);
      onProgress(0.75);
    });
    const { engine } = buildEngine({ transcriptionApi });

    engine.load();
    // Synchronous latch: status flips before the `initialize` promise settles.
    expect(engine.getSnapshot().status).toBe('downloading');

    // Let the microtask queue drain the fake `initialize` + its `.then`.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.getSnapshot()).toEqual({ status: 'ready', progress: 0.75, error: null });
  });

  it('goes to failed with an error message when initialize rejects', async () => {
    const transcriptionApi = fakeTranscriptionApi();
    transcriptionApi.initialize.mockRejectedValue(new Error('boom'));
    const { engine } = buildEngine({ transcriptionApi });

    engine.load();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.getSnapshot()).toEqual({ status: 'failed', progress: 0, error: 'boom' });
  });

  // A dead worker never answers the in-flight Comlink call, so `initialize()`
  // can't reject — without the `'error'` listener the FSM stayed at
  // `downloading` 0 % forever with no error at all (the silent failure mode
  // behind the "model load stuck at 0 %" hang).
  it('goes to failed when the transcription worker itself crashes mid-load', () => {
    const transcriptionApi = fakeTranscriptionApi();
    // Never settles — mirrors a message posted into a worker that has died.
    transcriptionApi.initialize.mockImplementation(() => new Promise<void>(() => {}));
    const { engine, transcriptionWorker } = buildEngine({ transcriptionApi });

    engine.load();
    expect(engine.getSnapshot().status).toBe('downloading');

    transcriptionWorker.crash('Worker konnte nicht geladen werden');

    expect(engine.getSnapshot()).toEqual({
      status: 'failed',
      progress: 0,
      error: 'Transkriptions-Worker abgestürzt: Worker konnte nicht geladen werden',
    });
  });

  it('reports a worker crash without a message too', () => {
    const { engine, transcriptionWorker } = buildEngine();

    transcriptionWorker.crash();

    expect(engine.getSnapshot().status).toBe('failed');
    expect(engine.getSnapshot().error).toBe('Transkriptions-Worker abgestürzt.');
  });

  it('retries from failed by re-entering downloading', async () => {
    const transcriptionApi = fakeTranscriptionApi();
    transcriptionApi.initialize.mockRejectedValueOnce(new Error('first failure'));
    const { engine } = buildEngine({ transcriptionApi });

    engine.load();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.getSnapshot().status).toBe('failed');

    transcriptionApi.initialize.mockResolvedValueOnce(undefined);
    engine.load();
    expect(engine.getSnapshot().status).toBe('downloading');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.getSnapshot().status).toBe('ready');
    expect(transcriptionApi.initialize).toHaveBeenCalledTimes(2);
  });

  it('is idempotent: a second load() while downloading/ready does not call initialize again', async () => {
    const transcriptionApi = fakeTranscriptionApi();
    let resolveInit: () => void = () => {};
    transcriptionApi.initialize.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve;
        }),
    );
    const { engine } = buildEngine({ transcriptionApi });

    engine.load();
    engine.load(); // no-op — still downloading
    expect(transcriptionApi.initialize).toHaveBeenCalledTimes(1);

    resolveInit();
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.getSnapshot().status).toBe('ready');

    engine.load(); // no-op — already ready
    expect(transcriptionApi.initialize).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers on every status/progress change', async () => {
    const transcriptionApi = fakeTranscriptionApi();
    transcriptionApi.initialize.mockImplementation(async (onProgress: (fraction: number) => void) => {
      onProgress(0.5);
    });
    const { engine } = buildEngine({ transcriptionApi });
    const listener = vi.fn();
    engine.subscribe(listener);

    engine.load();
    // -> downloading, then the fake's synchronous `onProgress(0.5)` call
    // (a real worker's Comlink round-trip would land this asynchronously,
    // but a plain-function fake body runs synchronously up to its first
    // `await`) — at least the downloading transition has fired by here.
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(1);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // downloading + progress(0.5) + ready
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('unsubscribe stops delivering notifications', () => {
    const { engine } = buildEngine();
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);
    unsubscribe();
    engine.load();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('Engine WebGPU precheck (security audit gap 2)', () => {
  it('goes straight to failed without ever calling initialize when WebGPU is absent', () => {
    const transcriptionApi = fakeTranscriptionApi();
    const { engine } = buildEngine({ transcriptionApi, hasWebGpu: () => false });

    engine.load();

    expect(engine.getSnapshot().status).toBe('failed');
    expect(engine.getSnapshot().error).toMatch(/WebGPU/);
    expect(transcriptionApi.initialize).not.toHaveBeenCalled();
  });

  it('still loads normally when WebGPU is present (default fake)', async () => {
    const transcriptionApi = fakeTranscriptionApi();
    const { engine } = buildEngine({ transcriptionApi, hasWebGpu: () => true });

    engine.load();
    expect(engine.getSnapshot().status).toBe('downloading');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.getSnapshot().status).toBe('ready');
  });

  it('retrying after a WebGPU-absent failure re-checks (still no worker call, since the browser hasn\'t changed)', () => {
    const transcriptionApi = fakeTranscriptionApi();
    const { engine } = buildEngine({ transcriptionApi, hasWebGpu: () => false });

    engine.load();
    expect(engine.getSnapshot().status).toBe('failed');
    engine.load();
    expect(engine.getSnapshot().status).toBe('failed');
    expect(transcriptionApi.initialize).not.toHaveBeenCalled();
  });
});

describe('Engine stall watchdog (security audit gap 1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Belt-and-suspenders: drop anything still scheduled before switching
    // back, then restore real timers so later describe blocks (which use
    // real `await Promise.resolve()` timing) aren't affected.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('fails with a stall message if initialize never ticks and never settles within the stall budget', () => {
    const transcriptionApi = fakeTranscriptionApi();
    // Never settles, never calls onProgress — mirrors a GPU-driver deadlock
    // (as opposed to the crash test, this one has NO worker `error` event
    // either — a true hang, not a death).
    transcriptionApi.initialize.mockImplementation(() => new Promise<void>(() => {}));
    const { engine } = buildEngine({ transcriptionApi });

    engine.load();
    expect(engine.getSnapshot().status).toBe('downloading');

    vi.advanceTimersByTime(179_999);
    expect(engine.getSnapshot().status).toBe('downloading'); // not yet — budget hasn't fully elapsed

    vi.advanceTimersByTime(1);
    expect(engine.getSnapshot().status).toBe('failed');
    expect(engine.getSnapshot().error).toMatch(/reagiert nicht mehr/);
  });

  it('a progress tick resets the stall budget — no failure as long as ticks keep coming', async () => {
    const transcriptionApi = fakeTranscriptionApi();
    let tick: ((fraction: number) => void) | undefined;
    transcriptionApi.initialize.mockImplementation(
      (onProgress: (fraction: number) => void) =>
        new Promise<void>(() => {
          tick = onProgress;
        }),
    );
    const { engine } = buildEngine({ transcriptionApi });

    engine.load();
    await vi.advanceTimersByTimeAsync(170_000);
    expect(engine.getSnapshot().status).toBe('downloading');

    tick?.(0.5); // resets the 180s window
    await vi.advanceTimersByTimeAsync(170_000);
    expect(engine.getSnapshot().status).toBe('downloading');
    expect(engine.getSnapshot().progress).toBe(0.5);

    // Now let the full budget elapse with no further tick.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(engine.getSnapshot().status).toBe('failed');
  });

  it('does not fire the stall timer once initialize resolves first (no leaked timer, no late override)', async () => {
    const transcriptionApi = fakeTranscriptionApi();
    let resolveInit: () => void = () => {};
    transcriptionApi.initialize.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve;
        }),
    );
    const { engine } = buildEngine({ transcriptionApi });

    engine.load();
    resolveInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.getSnapshot().status).toBe('ready');

    // If the watchdog leaked, this would flip status back to 'failed'.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(engine.getSnapshot().status).toBe('ready');
    expect(vi.getTimerCount()).toBe(0); // teardown-safety: nothing left pending
  });

  it('a worker crash mid-load clears the stall timer too (no leak across the crash -> failed transition)', () => {
    const transcriptionApi = fakeTranscriptionApi();
    transcriptionApi.initialize.mockImplementation(() => new Promise<void>(() => {}));
    const { engine, transcriptionWorker } = buildEngine({ transcriptionApi });

    engine.load();
    expect(engine.getSnapshot().status).toBe('downloading');

    transcriptionWorker.crash('boom');
    expect(engine.getSnapshot().status).toBe('failed');
    expect(engine.getSnapshot().error).toContain('boom');

    expect(vi.getTimerCount()).toBe(0); // the crash tore down the stall timer, nothing left pending
  });

  it('a stray progress tick after a stall failure does not resurrect downloading', () => {
    const transcriptionApi = fakeTranscriptionApi();
    let tick: ((fraction: number) => void) | undefined;
    transcriptionApi.initialize.mockImplementation(
      (onProgress: (fraction: number) => void) =>
        new Promise<void>(() => {
          tick = onProgress;
        }),
    );
    const { engine } = buildEngine({ transcriptionApi });

    engine.load();
    vi.advanceTimersByTime(180_000);
    expect(engine.getSnapshot().status).toBe('failed');

    tick?.(0.9); // the now-stale round-trip finally ticks after the watchdog gave up
    expect(engine.getSnapshot().status).toBe('failed');
  });
});

describe('Engine segment stream', () => {
  it('dispatches raw final messages to subscribers', () => {
    const { engine, transcriptionWorker } = buildEngine();
    const received: TranscriptMessage[] = [];
    engine.onSegment((message) => received.push(message));

    const final: TranscriptMessage = { type: 'final', text: 'hallo', startMs: 0, endMs: 500 };
    transcriptionWorker.dispatch(final);

    expect(received).toEqual([final]);
  });

  it('ignores non-final messages', () => {
    const { engine, transcriptionWorker } = buildEngine();
    const received: TranscriptMessage[] = [];
    engine.onSegment((message) => received.push(message));

    transcriptionWorker.dispatch({ type: 'not-final' } as unknown as TranscriptMessage);

    expect(received).toEqual([]);
  });

  it('unsubscribe stops delivery', () => {
    const { engine, transcriptionWorker } = buildEngine();
    const received: TranscriptMessage[] = [];
    const unsubscribe = engine.onSegment((message) => received.push(message));
    unsubscribe();

    transcriptionWorker.dispatch({ type: 'final', text: 'x', startMs: 0, endMs: 1 });

    expect(received).toEqual([]);
  });

  it('delivers to multiple subscribers independently', () => {
    const { engine, transcriptionWorker } = buildEngine();
    const a: TranscriptMessage[] = [];
    const b: TranscriptMessage[] = [];
    engine.onSegment((m) => a.push(m));
    const unsubB = engine.onSegment((m) => b.push(m));

    transcriptionWorker.dispatch({ type: 'final', text: 'one', startMs: 0, endMs: 1 });
    unsubB();
    transcriptionWorker.dispatch({ type: 'final', text: 'two', startMs: 1, endMs: 2 });

    expect(a.map((m) => m.text)).toEqual(['one', 'two']);
    expect(b.map((m) => m.text)).toEqual(['one']);
  });
});

describe('Engine live control + stop-ordering invariant', () => {
  it('startLive forwards to the transcription api', () => {
    const { engine, transcriptionApi } = buildEngine();
    engine.startLive();
    expect(transcriptionApi.start).toHaveBeenCalledTimes(1);
  });

  it('feedAudio forwards the chunk (transfer is a no-op passthrough under fakes)', () => {
    const { engine, transcriptionApi } = buildEngine();
    const chunk = new Float32Array([1, 2, 3]);
    engine.feedAudio(chunk);
    expect(transcriptionApi.feedAudio).toHaveBeenCalledTimes(1);
    expect(transcriptionApi.feedAudio.mock.calls[0][0]).toBe(chunk);
  });

  it('feedAudio is a stable bound field (usable as a bare callback)', () => {
    const { engine, transcriptionApi } = buildEngine();
    const onPcm = engine.feedAudio; // detached, as `liveCapture.start({ onPcm: engine.feedAudio })` would use it
    const chunk = new Float32Array([9]);
    onPcm(chunk);
    expect(transcriptionApi.feedAudio).toHaveBeenCalledTimes(1);
  });

  it('stopLive resolves only AFTER a trailing final posted during the worker stop has been dispatched', async () => {
    const transcriptionApi = fakeTranscriptionApi();
    const order: string[] = [];
    let dispatchTrailing: (() => void) | null = null;

    transcriptionApi.stop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          // Simulate the worker's real ordering: the trailing `final` is
          // posted on the raw channel BEFORE Comlink's own stop() resolves.
          dispatchTrailing = () => {
            order.push('dispatched-final');
            resolve();
          };
        }),
    );

    const { engine, transcriptionWorker } = buildEngine({ transcriptionApi });
    engine.onSegment(() => order.push('onSegment-callback'));

    const stopPromise = engine.stopLive().then(() => order.push('stopLive-resolved'));

    // Fire the trailing final on the raw channel, then let the stop() promise settle.
    transcriptionWorker.dispatch({ type: 'final', text: 'last', startMs: 0, endMs: 1 });
    dispatchTrailing!();

    await stopPromise;

    expect(order).toEqual(['onSegment-callback', 'dispatched-final', 'stopLive-resolved']);
  });

  it('transcribeFile forwards pcm + progress and returns the api result', async () => {
    const transcriptionApi = fakeTranscriptionApi();
    const segments = [{ text: 'a', startMs: 0, endMs: 1 }];
    transcriptionApi.transcribeFile.mockResolvedValue(segments);
    const { engine } = buildEngine({ transcriptionApi });

    const onProgress = vi.fn();
    const pcm = new Float32Array([1, 2]);
    const result = await engine.transcribeFile(pcm, onProgress);

    expect(result).toBe(segments);
    expect(transcriptionApi.transcribeFile).toHaveBeenCalledTimes(1);
    expect(transcriptionApi.transcribeFile.mock.calls[0][0]).toBe(pcm);
    expect(typeof transcriptionApi.transcribeFile.mock.calls[0][1]).toBe('function');
  });

  it('transcribeFile without onProgress passes undefined', async () => {
    const transcriptionApi = fakeTranscriptionApi();
    const { engine } = buildEngine({ transcriptionApi });
    await engine.transcribeFile(new Float32Array([1]));
    expect(transcriptionApi.transcribeFile.mock.calls[0][1]).toBeUndefined();
  });
});

describe('Engine diarizer()', () => {
  it('creates the diarization worker lazily, only on first call', () => {
    const { engine, diarizationWorker } = buildEngine();
    expect(diarizationWorker.terminate).not.toHaveBeenCalled(); // sanity: not disposed yet
    // Nothing created the diarization worker until diarizer() is called —
    // verified indirectly below via dispose()'s termination count.
    engine.diarizer();
    engine.dispose();
    expect(diarizationWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it('returns the same handle on repeated calls', () => {
    const { engine } = buildEngine();
    const a = engine.diarizer();
    const b = engine.diarizer();
    expect(a).toBe(b);
  });

  it('initialize proxies the progress callback through to the remote', async () => {
    const diarizationApi = fakeDiarizationApi();
    const { engine } = buildEngine({ diarizationApi });
    const onProgress = vi.fn();
    await engine.diarizer().initialize(onProgress);
    expect(diarizationApi.initialize).toHaveBeenCalledTimes(1);
    expect(typeof diarizationApi.initialize.mock.calls[0][0]).toBe('function');
  });

  it('diarizeAudio forwards pcm + options and returns the timeline', async () => {
    const diarizationApi = fakeDiarizationApi();
    const timeline = [{ startMs: 0, endMs: 1, speaker: 0 }];
    diarizationApi.diarizeAudio.mockResolvedValue(timeline);
    const { engine } = buildEngine({ diarizationApi });

    const pcm = new Float32Array([1, 2, 3]);
    const options = { clustering: { mode: 'auto' as const, distanceThreshold: 0.7, minClusterSize: 12 } };
    const result = await engine.diarizer().diarizeAudio(pcm, options);

    expect(result).toBe(timeline);
    expect(diarizationApi.diarizeAudio.mock.calls[0][0]).toBe(pcm);
    expect(diarizationApi.diarizeAudio.mock.calls[0][1]).toBe(options);
  });
});

describe('Engine dispose()', () => {
  it('terminates the transcription worker unconditionally', () => {
    const { engine, transcriptionWorker } = buildEngine();
    engine.dispose();
    expect(transcriptionWorker.terminate).toHaveBeenCalledTimes(1);
    // Both listeners Engine attaches (`message` + `error`) come back off.
    expect(transcriptionWorker.removeEventListener.mock.calls.map(([type]) => type)).toEqual(['message', 'error']);
  });

  it('does NOT terminate the diarization worker if diarizer() was never called', () => {
    const { engine, diarizationWorker } = buildEngine();
    engine.dispose();
    expect(diarizationWorker.terminate).not.toHaveBeenCalled();
  });

  it('terminates the diarization worker if diarizer() was called', () => {
    const { engine, diarizationWorker } = buildEngine();
    engine.diarizer();
    engine.dispose();
    expect(diarizationWorker.terminate).toHaveBeenCalledTimes(1);
  });
});
