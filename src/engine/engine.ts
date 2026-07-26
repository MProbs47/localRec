/**
 * U7 (plan 005, "Architektur-Review; ADR-0001-Fortführung, Engine/View-Split")
 * — the model stack (CONTEXT.md **Engine** = Whisper transcription +
 * pyannote/WeSpeaker diarization) behind one deep module. Before this unit
 * the stack was **two worker refs** (`workerApiRef`,
 * `diarWorkerRef`/`diarWorkerApiRef`) plus **four scattered readiness
 * booleans** (`modelReady`, `modelLoadStartedRef`, `modelLoadFailed`,
 * `loadProgress`) smeared across `App.tsx`, with the *absent→downloading→
 * ready→failed* transitions open-coded in `beginModelLoad`'s
 * `setDeviceState((prev) => …)` guards. `Engine` pulls all of it behind one
 * seam, constructed once per mount (`App`'s `engineRef`, symmetric with
 * `coordinatorRef`/`liveCaptureRef`).
 *
 * Not to be confused with the per-model `WhisperEngine`/`DiarizationEngine`
 * (`src/worker/model/`, `src/diarization/`) — this `Engine` is the
 * main-thread HOST over the two model workers.
 *
 * **Scope.** Engine owns BOTH worker lifecycles (creation + teardown, one
 * place): the transcription worker is created EAGERLY (in the constructor —
 * mirrors the old mount effect's "worker wired, nothing fetched until the
 * click" posture) so `load()` can drive `initialize()` immediately; the
 * diarization worker is created LAZILY, on the first `diarizer()` call (no
 * GPU contention with the live Whisper worker, its ~30 MB model set
 * shouldn't load until actually needed — KTD15). Engine owns the
 * transcription readiness FSM + live control (`startLive`/`feedAudio`/
 * `stopLive`) + `transcribeFile` + the `final` segment stream, and exposes
 * a lazy, Comlink-adapted `diarizer()` handle. The diarization RUN
 * orchestration (decode/align/generation-guard) stays with the caller
 * (`runDiarization`, driven from `App.tsx`'s `runAnnotation`) — Engine only
 * hides the worker plumbing.
 *
 * **Readiness = source of truth (`useSyncExternalStore`).** Same
 * `subscribe`/`getSnapshot` shape as `TranscriptStore` (`src/ui/
 * transcriptStore.ts`) — an established pattern, no new infrastructure.
 * `App` reads via `useSyncExternalStore` and PROJECTS the idle/downloading/
 * error slice of its own `deviceState` from the snapshot (ADR-0001, "App
 * projiziert Zustand") rather than Engine owning any UI state itself.
 * `load()`'s idempotency latch lives INSIDE (a second call while
 * `downloading`/`ready` is a no-op — no second `initialize`); retry from
 * `failed` re-enters `downloading`.
 *
 * **Segment stream.** `onSegment(cb)` hides the raw `postMessage` channel +
 * its Comlink-coexistence subtlety (see `transcription.worker.ts`'s header)
 * behind a plain subscribe/unsubscribe pair. Engine stays PERSISTENCE-
 * IGNORANT — `App` wires the two sinks (`transcriptStore.append` +
 * `coordinator.handleFinal`) itself.
 *
 * **Stop-ordering invariant (unchanged).** `stopLive()` resolves only AFTER
 * the worker's trailing `final` block has been dispatched through
 * `onSegment` — it falls out of `stopLive` awaiting `stop()` on the SAME
 * worker whose raw `message` listener fires synchronously first (see
 * `transcription.worker.ts`'s `stop()` doc comment for exactly why). This is
 * what lets `App`'s `stopRecording` count on the last block having already
 * reached `coordinator.handleFinal` before it then calls `coordinator.stop()`.
 *
 * **Testability.** Engine creates workers via `new Worker(new URL(...),
 * {type:'module'})`, which doesn't run under Vitest — `EngineDeps` injects
 * both the worker factory and the Comlink-wrap step (mirrors
 * `RecordingCoordinator`/`LiveCapture`'s injectable-deps + private `#field`
 * discipline), with real defaults doing the actual `new Worker` +
 * `Comlink.wrap` + `addEventListener('message', …)`. `WorkerLike` is the
 * narrow structural slice of `Worker` Engine itself calls (not the ambient
 * DOM type) — a real `Worker` satisfies it for free; tests supply a fake
 * that can also DRIVE the raw message channel (call the captured listener
 * directly) to exercise `onSegment`/the stop-ordering invariant.
 */
import * as Comlink from 'comlink';
import type { WorkerApi, TranscriptMessage } from '../worker/transcription.worker';
import type { TranscriptSegment } from '../worker/model/transcriptionEngine';
import type { DiarizationWorkerApi } from '../diarization/diarization.worker';
import { t } from '../i18n';

export type EngineStatus = 'absent' | 'downloading' | 'ready' | 'failed';

/**
 * Stall-watchdog budget for `load()` (security audit gap 1): reset on every
 * `initialize` progress tick; only fires if this many ms pass with ZERO
 * ticks and no resolution/rejection at all — a GPU-driver deadlock that
 * hangs without ever crashing the worker (the `'error'` listener in the
 * constructor only catches a worker that dies outright, not one that's
 * merely stuck). Deliberately generous and NOT a download timeout: the
 * one-time 2.5 GB model fetch is allowed to run as long as it keeps ticking,
 * and after it completes, GPU shader/kernel compilation can legitimately run
 * a good while with no ticks at all.
 */
const STALL_WATCHDOG_MS = 180_000;

/** The `useSyncExternalStore` snapshot — same shape/discipline as `TranscriptStoreSnapshot`. A fresh object is handed out on every status/progress/error change. */
export interface EngineSnapshot {
  readonly status: EngineStatus;
  readonly progress: number;
  readonly error: string | null;
}

type Listener = () => void;

/**
 * The lazily-created, Comlink-adapted diarization handle — the exact shape
 * `App.tsx`'s `runAnnotation` used to build inline around the raw
 * `DiarizationWorkerApi` remote (`initialize`/`diarizeAudio`, with the
 * transfer/proxy already applied). Returned by `diarizer()`.
 */
export type Diarizer = Pick<DiarizationWorkerApi, 'initialize' | 'diarizeAudio'>;

/** The narrow slice of `Worker` this module calls directly. A real `Worker` satisfies this structurally; tests inject a fake that can also drive the raw `message` channel. */
export interface WorkerLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void;
  terminate(): void;
}

export interface EngineDeps {
  /** Creates the transcription worker (called once, eagerly, in the constructor). Defaults to `new Worker(new URL('../worker/transcription.worker.ts', import.meta.url), { type: 'module' })`. */
  createTranscriptionWorker?: () => WorkerLike;
  /** Wraps the transcription worker's Comlink control channel. Defaults to `Comlink.wrap<WorkerApi>`. */
  wrapTranscriptionApi?: (worker: WorkerLike) => Comlink.Remote<WorkerApi>;
  /** Creates the diarization worker (called at most once, lazily, on the first `diarizer()`). Defaults to `new Worker(new URL('../diarization/diarization.worker.ts', import.meta.url), { type: 'module' })`. */
  createDiarizationWorker?: () => WorkerLike;
  /** Wraps the diarization worker's Comlink control channel. Defaults to `Comlink.wrap<DiarizationWorkerApi>`. */
  wrapDiarizationApi?: (worker: WorkerLike) => Comlink.Remote<DiarizationWorkerApi>;
  /** Reports whether the browser has WebGPU at all (security audit gap 2) — checked at the very top of `load()`, before the worker is even asked to `initialize()`. Defaults to reading `navigator.gpu`, guarded behind `typeof navigator` since Engine's own test suite runs under `environment: 'node'` (no DOM globals). */
  hasWebGpu?: () => boolean;
}

function defaultCreateTranscriptionWorker(): WorkerLike {
  return new Worker(new URL('../worker/transcription.worker.ts', import.meta.url), { type: 'module' });
}

function defaultWrapTranscriptionApi(worker: WorkerLike): Comlink.Remote<WorkerApi> {
  return Comlink.wrap<WorkerApi>(worker as unknown as Comlink.Endpoint);
}

function defaultCreateDiarizationWorker(): WorkerLike {
  return new Worker(new URL('../diarization/diarization.worker.ts', import.meta.url), { type: 'module' });
}

function defaultWrapDiarizationApi(worker: WorkerLike): Comlink.Remote<DiarizationWorkerApi> {
  return Comlink.wrap<DiarizationWorkerApi>(worker as unknown as Comlink.Endpoint);
}

/** `navigator.gpu` isn't in the ambient DOM lib (no `@webgpu/types` dependency) — narrow cast. The `typeof navigator` guard is load-bearing: Engine's tests run under `environment: 'node'` (vitest.config.ts), where `navigator` isn't declared at all. */
function defaultHasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
}

/**
 * Main-thread host over the two model workers — see the file header for the
 * full design. One instance is constructed on `App`'s first render
 * (`engineRef`) and reused across recordings/imports/annotations for the
 * whole component lifetime; both workers die with the page. `dispose()` is
 * the explicit teardown for owners OUTSIDE a component (tests) — App
 * deliberately does NOT call it from an effect cleanup (see `App.tsx`'s
 * `onSegment` effect and the "model load stuck at 0 %" hang it fixes).
 */
export class Engine {
  readonly #createDiarizationWorker: () => WorkerLike;
  readonly #wrapDiarizationApi: (worker: WorkerLike) => Comlink.Remote<DiarizationWorkerApi>;
  readonly #hasWebGpu: () => boolean;

  readonly #transcriptionWorker: WorkerLike;
  readonly #transcriptionApi: Comlink.Remote<WorkerApi>;
  readonly #onMessage: (event: MessageEvent) => void;
  readonly #onError: (event: MessageEvent) => void;

  #diarizationWorker: WorkerLike | null = null;
  /** Latches `#prefetchDiarizationModels` to one attempt per Engine, so a retried `load()` after a failure doesn't stack downloads. */
  #diarizationPrefetched = false;
  #diarizer: Diarizer | null = null;

  #status: EngineStatus = 'absent';
  #progress = 0;
  #error: string | null = null;
  #snapshot: EngineSnapshot = { status: 'absent', progress: 0, error: null };
  readonly #listeners = new Set<Listener>();
  readonly #segmentListeners = new Set<(message: TranscriptMessage) => void>();

  // Stall-watchdog state for the CURRENT `load()` call (security audit gap
  // 1). Instance-level (not a `load()`-local closure) so `#onError` — a
  // worker crash can land at any time, including mid-load — can reach in and
  // tear both down: a dead worker's `initialize()` promise never settles, so
  // without this a crash mid-load would leave the stall timer armed for
  // `STALL_WATCHDOG_MS` past the crash (a leaked timer) and, if the timer
  // later fired, silently overwrite the crash's `failed` status. `#loadSettled`
  // starts `true` (no load in flight); `load()` flips it `false` for the
  // duration of one `initialize()` round-trip.
  #loadSettled = true;
  #stallTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: EngineDeps = {}) {
    this.#createDiarizationWorker = deps.createDiarizationWorker ?? defaultCreateDiarizationWorker;
    this.#wrapDiarizationApi = deps.wrapDiarizationApi ?? defaultWrapDiarizationApi;
    this.#hasWebGpu = deps.hasWebGpu ?? defaultHasWebGpu;

    const createTranscriptionWorker = deps.createTranscriptionWorker ?? defaultCreateTranscriptionWorker;
    const wrapTranscriptionApi = deps.wrapTranscriptionApi ?? defaultWrapTranscriptionApi;

    this.#transcriptionWorker = createTranscriptionWorker();
    this.#transcriptionApi = wrapTranscriptionApi(this.#transcriptionWorker);

    // The raw `final` block stream (see `transcription.worker.ts`'s header on
    // why this safely coexists with Comlink on the same worker endpoint).
    // Attached once, here, so it's live before the first `load()`/`start()`.
    this.#onMessage = (event) => {
      const message = (event as MessageEvent<TranscriptMessage>).data;
      if (!message || message.type !== 'final') return;
      for (const listener of this.#segmentListeners) listener(message);
    };
    this.#transcriptionWorker.addEventListener('message', this.#onMessage);

    // A worker that DIES (module-load failure, uncaught async throw) never
    // answers the in-flight Comlink call: `load()`'s `initialize()` promise
    // then stays pending forever and the UI sits at `downloading` 0 % with no
    // error at all — the silent failure mode that made the "model load
    // stuck at 0 %" hang so expensive to diagnose. Engine otherwise only listens for `'message'`. Surfacing the
    // crash as `failed` turns it into the ErrorScreen (with retry) instead.
    this.#onError = (event) => {
      const detail = (event as unknown as Partial<ErrorEvent>).message;
      // `#finishLoad` (not a bare `#publish`) so a crash mid-load also tears
      // down the stall watchdog above — see its doc comment.
      this.#finishLoad({
        status: 'failed',
        error: detail ? t('engine.workerCrashedDetail', { detail }) : t('engine.workerCrashed'),
      });
    };
    this.#transcriptionWorker.addEventListener('error', this.#onError);
  }

  // ─────────────────────── Readiness (useSyncExternalStore) ───────────────

  /** `useSyncExternalStore`'s `subscribe` — registers `listener` to be called after every status/progress/error change, returns an unsubscribe function. */
  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** `useSyncExternalStore`'s `getSnapshot` — same object reference until the next change, a new one after. */
  getSnapshot = (): EngineSnapshot => this.#snapshot;

  #publish(patch: Partial<EngineSnapshot>): void {
    this.#status = patch.status ?? this.#status;
    this.#progress = patch.progress ?? this.#progress;
    if ('error' in patch) this.#error = patch.error ?? null;
    this.#snapshot = { status: this.#status, progress: this.#progress, error: this.#error };
    for (const listener of this.#listeners) listener();
  }

  /** (Re)arms the stall watchdog: clears any previous timer and starts a fresh `STALL_WATCHDOG_MS` countdown. Called once when `load()` starts and again on every progress tick. */
  #armStallTimer(): void {
    clearTimeout(this.#stallTimer);
    this.#stallTimer = setTimeout(() => {
      this.#finishLoad({
        status: 'failed',
        error: t('engine.modelStalled'),
      });
    }, STALL_WATCHDOG_MS);
  }

  /** The single settle-path for an in-flight `load()`: latches `#loadSettled` (so a late resolve/reject/timer-fire from a since-superseded round-trip is a no-op) and clears the stall timer (no leak), then publishes. Used by `load()`'s own resolve/reject, the stall timer itself, and `#onError` (a crash mid-load). */
  #finishLoad(patch: Partial<EngineSnapshot>): void {
    this.#loadSettled = true;
    clearTimeout(this.#stallTimer);
    this.#stallTimer = undefined;
    this.#publish(patch);
  }

  /**
   * Drives the transcription readiness FSM: `absent`/`failed` →
   * `downloading` → `ready` (or → `failed` with `error` set, un-latching so a
   * later call can retry). IDEMPOTENT: a no-op while already `downloading`/
   * `ready` — no second `initialize()` fires. Fire-and-forget (mirrors the
   * old `beginModelLoad`); callers observe progress via `subscribe`/
   * `getSnapshot`, not this call's return.
   *
   * Two upfront/ongoing guards (security audit):
   * - **WebGPU precheck** (gap 2): checked before the worker is asked to do
   *   anything — a browser with no WebGPU at all would otherwise fail deep
   *   inside the pipeline build, after wasting the user's time (and possibly
   *   bandwidth) on a download that could never succeed.
   * - **Stall watchdog** (gap 1): see `STALL_WATCHDOG_MS`'s doc comment.
   */
  load(): void {
    if (this.#status === 'downloading' || this.#status === 'ready') return;
    if (!this.#hasWebGpu()) {
      this.#publish({
        status: 'failed',
        error: t('engine.webgpuUnsupported'),
      });
      return;
    }
    this.#loadSettled = false;
    this.#publish({ status: 'downloading', progress: 0, error: null });
    this.#armStallTimer();

    this.#transcriptionApi
      .initialize(
        Comlink.proxy((fraction: number) => {
          if (this.#loadSettled) return; // stray tick after a stall/crash already settled this round-trip
          this.#armStallTimer();
          this.#publish({ progress: fraction });
        }),
      )
      .then(() => {
        if (this.#loadSettled) return;
        this.#finishLoad({ status: 'ready' });
        this.#prefetchDiarizationModels();
      })
      .catch((error: unknown) => {
        if (this.#loadSettled) return;
        this.#finishLoad({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
      });
  }

  // ───────────────────────────── Segment stream ────────────────────────────

  /** Subscribes to finalized `final` transcript blocks (hides the raw `postMessage` channel). Returns an unsubscribe function. */
  onSegment(cb: (message: TranscriptMessage) => void): () => void {
    this.#segmentListeners.add(cb);
    return () => {
      this.#segmentListeners.delete(cb);
    };
  }

  // ───────────────────────────── Live control ──────────────────────────────

  /** Begins a new live pseudo-live block session. No-op if one is already running (mirrors `WorkerApi.start`). `language`: Whisper code or `'auto'` (per-window detection). */
  startLive(language?: string): void {
    void this.#transcriptionApi.start(language);
  }

  /**
   * Feeds one windowed chunk of 16 kHz mono PCM audio into the active live
   * session; hides the `Comlink.transfer`. A bound instance field (stable
   * identity, like `LiveCapture#getLevel`) so `liveCapture.start({ onPcm:
   * engine.feedAudio })` never needs a fresh closure per render.
   */
  feedAudio = (chunk: Float32Array): void => {
    void this.#transcriptionApi.feedAudio(Comlink.transfer(chunk, [chunk.buffer]));
  };

  /**
   * Ends the current live session. Resolves only AFTER the worker's trailing
   * `final` block has been dispatched through `onSegment` — see the file
   * header's "stop-ordering invariant". Falls out of awaiting `stop()` on the
   * SAME worker whose raw `message` listener fires synchronously first.
   */
  async stopLive(): Promise<void> {
    await this.#transcriptionApi.stop();
  }

  /** Whole-file batch transcription for the import path; hides transfer + progress proxy. `language`: Whisper code or `'auto'` (per-window detection). */
  transcribeFile(
    pcm: Float32Array,
    onProgress?: (fraction: number) => void,
    language?: string,
  ): Promise<TranscriptSegment[]> {
    return this.#transcriptionApi.transcribeFile(
      Comlink.transfer(pcm, [pcm.buffer]),
      onProgress ? Comlink.proxy(onProgress) : undefined,
      language,
    );
  }

  // ──────────────────────── Diarization model prefetch ─────────────────────

  /**
   * Pulls the ~40 MB diarization model set down as soon as transcription is
   * ready, so "after the one-time download the app needs no network" holds for
   * the WHOLE app — not just transcription.
   *
   * The hole this closes: the diarization models used to load on the FIRST
   * "detect speakers" press. Someone who did the airplane-mode proof —
   * download, go offline, record, transcribe — and only then asked for
   * speakers got a raw network error, with no way to guess that the fix is
   * "go online once". The promise had an asterisk nobody had written down.
   * 40 MB on top of ~1.5 GB is 2.7 %: cheaper than the asterisk.
   *
   * **Deliberately does not gate readiness.** It fires AFTER `#finishLoad`
   * publishes `ready`, and a failure is swallowed with an info log. An
   * optional feature must never keep the app from starting, and it must never
   * turn an HF hiccup into a dead app (SD-3). The lazy path in
   * `diarizationRun.ts` stays exactly as it was and remains the fallback: if
   * this prefetch failed, the first "detect speakers" run downloads as before.
   *
   * Accepted trade-off: if the user starts recording within the few seconds
   * this takes, the download and the ORT session build share CPU with live
   * transcription. Whisper runs on the GPU and its live driver answers
   * pressure by lowering the block rate rather than dropping audio, so the
   * worst case is a slightly late first block — against a guarantee that
   * holds every time. Building the session here also makes the first real
   * diarization run start faster.
   */
  #prefetchDiarizationModels(): void {
    if (this.#diarizationPrefetched) return;
    this.#diarizationPrefetched = true;

    // No progress reporting: the UI already says `ready`, and a second bar
    // there would suggest the app is not usable yet, which it is.
    this.diarizer()
      .initialize(() => {})
      .catch((error: unknown) => {
        console.info(
          '[engine] diarization model prefetch failed — harmless, the first ' +
            'speaker-detection run will download them again:',
          error,
        );
      });
  }

  // ───────────────────────────── Diarization (lazy) ────────────────────────

  /**
   * The lazily-created, Comlink-adapted diarization handle — replaces
   * `getDiarWorkerApi` + the inline adapter `runAnnotation` used to build
   * around it. Creates the diarization worker on the FIRST call (never
   * during recording — KTD15, no GPU contention with the live Whisper
   * worker); every later call returns the same handle. The diarization RUN
   * orchestration (decode/align/generation-guard) stays with the caller.
   *
   * No stall watchdog here (security audit gap 1 asked us to consider it
   * "if trivial"): unlike transcription's `load()`, Engine doesn't own a
   * readiness FSM for diarization at all — `initialize()` is just handed
   * back to the caller (`diarizationRun.ts`), which awaits it directly. Engine
   * never sees that promise settle, so it has no hook to arm/clear a timer
   * around it without inventing new diarization-status plumbing — not a
   * few-line addition, so left out (YAGNI).
   */
  diarizer(): Diarizer {
    if (!this.#diarizer) {
      const worker = this.#createDiarizationWorker();
      this.#diarizationWorker = worker;
      const remote = this.#wrapDiarizationApi(worker);
      this.#diarizer = {
        initialize: (onProgress) => remote.initialize(Comlink.proxy(onProgress)),
        diarizeAudio: (pcm, options) => remote.diarizeAudio(Comlink.transfer(pcm, [pcm.buffer]), options),
      };
    }
    return this.#diarizer;
  }

  // ───────────────────────────────── Teardown ──────────────────────────────

  /** Terminates both worker lifecycles. The diarization worker is only terminated if `diarizer()` ever created it. NOT wired to a React effect cleanup — see the class comment. */
  dispose(): void {
    clearTimeout(this.#stallTimer); // no leaked watchdog if disposed mid-load
    this.#stallTimer = undefined;
    this.#transcriptionWorker.removeEventListener('message', this.#onMessage);
    this.#transcriptionWorker.removeEventListener('error', this.#onError);
    this.#transcriptionWorker.terminate();
    this.#diarizationWorker?.terminate();
    this.#diarizationWorker = null;
    this.#diarizer = null;
  }
}
