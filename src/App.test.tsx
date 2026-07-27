// @vitest-environment jsdom
/**
 * U9 (plan 005 `2026-07-24-005-refactor-recording-session-aggregate.md`,
 * `[#13]`) — RTL suite locking in the re-entrancy/lifecycle interleavings the
 * whole-repo review flagged as untested: #1 (double-start), #4
 * (stop-then-start race), #9 (meeting double-tap), #7 (annotation across a
 * session boundary), plus recovery resolution and permission-denied.
 *
 * App `new`s every collaborator internally (no prop DI — `engineRef`,
 * `liveCaptureRef`, `coordinatorRef`, `sessionStoreRef`), so each heavy
 * module is `vi.mock`ed with a controllable fake class/function. Every fake
 * class pushes the instance it creates onto a static `instances` array;
 * `latestEngine()`/`latestLiveCapture()`/`latestCoordinator()` below grab the
 * one the CURRENT render is actually holding (App constructs its
 * collaborators once, on first render, and reuses them for the component's
 * lifetime — a fresh `render(<App />)` per test gets fresh instances).
 *
 * **Race windows are opened with a genuine deferred promise** (a `resolve`
 * captured out of a `new Promise` executor) on whichever call sits inside the
 * guarded critical section for that scenario — see each test's own comment.
 * A test that only clicked a `disabled` button would prove nothing (the
 * button is disabled *because* the guard already flipped `busy`); these
 * instead drive the SECOND intent through the global Space-bar handler
 * (`toggleRecording`, wired in `App.tsx`'s keydown effect), which is never
 * gated by `disabled` — exactly the path a real double-tap would take.
 *
 * **Important mock-fidelity note:** `RecordingCoordinator.start`'s fake
 * actually INVOKES the `startRecorder` callback App passes it (mimicking the
 * real coordinator's `this.#recorder = startRecorder(...)`) — otherwise
 * `startOpusRecorder` (and so `recordedChunksRef`) would never fire, and
 * `pendingAnnotation`/the meeting's post-hoc blob would never be produced,
 * silently making the #7/#9 scenarios untestable.
 *
 * Per the U9 brief: no production code is modified here. One scenario
 * (permission-denied) exercises an existing, unguarded `getUserMedia`
 * rejection in `App.tsx`'s `startRecording` (only `coordinator.start()` has a
 * local try/catch) — see that test's own comment for the test-only
 * `unhandledRejection`-listener swap this requires, which touches nothing in
 * `src/`.
 */
import { act, StrictMode } from 'react';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// `vitest.setup.ts` already imports this at runtime for every test file, but
// `tsconfig.test.json` isn't aware of that side-loaded setup file (it isn't
// part of the `include` list), so the `Assertion` matcher-type augmentation
// (`toBeDisabled`, ...) needs its own explicit import here for `tsc` to see it.
import '@testing-library/jest-dom/vitest';
import App from './App';
import { Engine } from './engine/engine';
import { LiveCapture } from './audio/liveCapture';
import { RecordingCoordinator } from './session/recordingCoordinator';
import { findCrashCandidates, recoverSession } from './storage/recovery';
import { SessionStore, type SessionRecord } from './storage/sessionStore';
import { runImport } from './session/importPipeline';
import { runDiarization } from './session/diarizationRun';
import type { DiarizationRunResult } from './session/diarizationRun';
import { writeSpeakerTranscripts } from './output/writeSpeakerTranscripts';
import { createFileSink, deleteFallbackArtifacts } from './output/fileSink';
import { TranscriptStore } from './ui/transcriptStore';
import { setLocale } from './i18n/locale';

// ---------------------------------------------------------------------------
// Mocks. App does `new Engine()` / `new LiveCapture()` / `new
// RecordingCoordinator({...})` / `new SessionStore()` internally — each
// module below is replaced wholesale with a controllable fake. `vi.mock`
// factories are hoisted above the imports, so each class is defined ENTIRELY
// inside its factory (no closing over outer consts).
// ---------------------------------------------------------------------------

vi.mock('./engine/engine', () => {
  class Engine {
    static instances: Engine[] = [];
    #listeners = new Set<() => void>();
    #segmentListeners = new Set<(m: { type: 'final'; text: string; startMs: number; endMs: number }) => void>();
    snapshot: { status: string; progress: number; error: string | null } = {
      status: 'absent',
      progress: 0,
      error: null,
    };
    // Mirrors the real Engine's `load()`: flips to `downloading` synchronously
    // — the test then drives `ready` itself (simulating `initialize()` resolving).
    load = vi.fn(() => this.setStatus('downloading', { progress: 0, error: null }));
    subscribe = (l: () => void) => {
      this.#listeners.add(l);
      return () => {
        this.#listeners.delete(l);
      };
    };
    getSnapshot = () => this.snapshot;
    onSegment = vi.fn((cb: (m: { type: 'final'; text: string; startMs: number; endMs: number }) => void) => {
      this.#segmentListeners.add(cb);
      return () => {
        this.#segmentListeners.delete(cb);
      };
    });
    startLive = vi.fn();
    feedAudio = vi.fn();
    stopLive = vi.fn(async () => {});
    transcribeFile = vi.fn(async () => []);
    diarizer = vi.fn(() => ({ initialize: vi.fn(), diarizeAudio: vi.fn() }));
    dispose = vi.fn();

    constructor() {
      Engine.instances.push(this);
    }

    setStatus(status: string, patch: { progress?: number; error?: string | null } = {}) {
      this.snapshot = { status, progress: patch.progress ?? this.snapshot.progress, error: patch.error ?? null };
      this.#listeners.forEach((l) => l());
    }

    emitSegment(message: { text: string; startMs: number; endMs: number }) {
      this.#segmentListeners.forEach((cb) => cb({ type: 'final', ...message }));
    }
  }
  return { Engine };
});

vi.mock('./audio/liveCapture', () => {
  class LiveCapture {
    static instances: LiveCapture[] = [];
    start = vi.fn(async () => {});
    stop = vi.fn();
    getLevel = vi.fn(() => 0);
    recordStream: unknown = { id: 'record-stream' };
    constructor() {
      LiveCapture.instances.push(this);
    }
  }
  return { LiveCapture };
});

vi.mock('./session/recordingCoordinator', () => {
  class RecordingCoordinator {
    static instances: RecordingCoordinator[] = [];
    outputName: string | null = 'Testordner';
    sink: unknown = null;
    // Actually calls `startRecorder` — see file header. Without this,
    // `startOpusRecorder` never fires and `recordedChunksRef` stays empty,
    // silently breaking every scenario that needs a post-stop audio blob.
    start = vi.fn(async (startRecorder: (onChunk: (blob: Blob) => void) => unknown) => {
      startRecorder(() => {});
    });
    stop = vi.fn(async () => {});
    handleFinal = vi.fn(async () => {});
    constructor() {
      RecordingCoordinator.instances.push(this);
    }
  }
  return { RecordingCoordinator };
});

vi.mock('./storage/sessionStore', () => {
  class SessionStore {
    static instances: SessionStore[] = [];
    closeSession = vi.fn(async () => {});
    // S2 (privacy hardening [F2]): the wipe integration test asserts this was
    // called — see that test below.
    deleteAllSessions = vi.fn(async () => {});
    constructor() {
      SessionStore.instances.push(this);
    }
  }
  return { SessionStore };
});

vi.mock('./storage/recovery', () => ({
  findCrashCandidates: vi.fn(async () => []),
  recoverSession: vi.fn(async () => null),
}));

vi.mock('./runtime/wakeLock', () => {
  class WakeLockController {
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    handleVisibilityChange = vi.fn(async () => {});
  }
  // null: App never constructs WakeLockController at all when the provider is
  // absent — one fewer collaborator to fake.
  return { WakeLockController, getBrowserWakeLockProvider: vi.fn(() => null) };
});

function fakeAppendableFile() {
  return { append: vi.fn(async () => {}), close: vi.fn(async () => {}) };
}

vi.mock('./output/fileSink', () => ({
  createFileSink: vi.fn(async () => ({
    kind: 'live-mirror',
    name: 'Testordner',
    openFile: vi.fn(async () => fakeAppendableFile()),
  })),
  restoreFileSink: vi.fn(async () => ({
    kind: 'live-mirror',
    name: 'Testordner',
    openFile: vi.fn(async () => fakeAppendableFile()),
  })),
  // S2 (privacy hardening [F2]): the wipe integration test asserts this was
  // called — see that test below.
  deleteFallbackArtifacts: vi.fn(async () => {}),
}));

// S2: wraps the REAL TranscriptStore (unmocked elsewhere in this suite — many
// scenarios rely on its actual append/reset/snapshot behavior) so the wipe
// integration test can grab the instance App actually holds and assert it was
// reset, without changing anything about how it behaves. Same
// `static instances` pattern as every other fake class above.
vi.mock('./ui/transcriptStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui/transcriptStore')>();
  class TranscriptStore extends actual.TranscriptStore {
    static instances: TranscriptStore[] = [];
    constructor() {
      super();
      TranscriptStore.instances.push(this);
    }
  }
  return { ...actual, TranscriptStore };
});

vi.mock('./audio/systemAudio', async (importOriginal) => {
  // Keep the REAL `SystemAudioError` class — App does `instanceof` checks on
  // it in `startMeeting`'s catch block.
  const actual = await importOriginal<typeof import('./audio/systemAudio')>();
  return {
    ...actual,
    canCaptureSystemAudio: vi.fn(() => true),
    captureSystemAudio: vi.fn(async () => ({ id: 'system-stream' }) as unknown as MediaStream),
  };
});

vi.mock('./audio/recorder', () => ({
  startOpusRecorder: vi.fn((_stream: unknown, options: { onChunk: (b: Blob) => void }) => {
    // Emits one chunk synchronously so `recordedChunksRef` is never empty —
    // real MediaRecorder chunks arrive during the session, not only at stop.
    options.onChunk(new Blob(['chunk'], { type: 'audio/webm' }));
    return { stop: vi.fn() };
  }),
}));

vi.mock('./session/importPipeline', () => ({
  runImport: vi.fn(async () => {}),
}));

vi.mock('./session/diarizationRun', () => ({
  runDiarization: vi.fn(async () => ({ aligned: [], timeline: [], diarized: true })),
}));

vi.mock('./output/writeSpeakerTranscripts', () => ({
  writeSpeakerTranscripts: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Typed accessors for the mocked collaborators.
// ---------------------------------------------------------------------------

interface FakeEngineInstance {
  load: ReturnType<typeof vi.fn>;
  onSegment: ReturnType<typeof vi.fn>;
  startLive: ReturnType<typeof vi.fn>;
  feedAudio: ReturnType<typeof vi.fn>;
  stopLive: ReturnType<typeof vi.fn>;
  transcribeFile: ReturnType<typeof vi.fn>;
  diarizer: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  setStatus: (status: string, patch?: { progress?: number; error?: string | null }) => void;
  emitSegment: (message: { text: string; startMs: number; endMs: number }) => void;
}

interface FakeLiveCaptureInstance {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getLevel: ReturnType<typeof vi.fn>;
}

interface FakeCoordinatorInstance {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  handleFinal: ReturnType<typeof vi.fn>;
  outputName: string | null;
  sink: unknown;
}

function latestEngine(): FakeEngineInstance {
  const instances = (Engine as unknown as { instances: FakeEngineInstance[] }).instances;
  return instances[instances.length - 1];
}
function latestLiveCapture(): FakeLiveCaptureInstance {
  const instances = (LiveCapture as unknown as { instances: FakeLiveCaptureInstance[] }).instances;
  return instances[instances.length - 1];
}
function latestCoordinator(): FakeCoordinatorInstance {
  const instances = (RecordingCoordinator as unknown as { instances: FakeCoordinatorInstance[] }).instances;
  return instances[instances.length - 1];
}

interface FakeSessionStoreInstance {
  deleteAllSessions: ReturnType<typeof vi.fn>;
}

function latestSessionStore(): FakeSessionStoreInstance {
  const instances = (SessionStore as unknown as { instances: FakeSessionStoreInstance[] }).instances;
  return instances[instances.length - 1];
}
function latestTranscriptStore(): TranscriptStore {
  const instances = (TranscriptStore as unknown as { instances: TranscriptStore[] }).instances;
  return instances[instances.length - 1];
}

const findCrashCandidatesMock = vi.mocked(findCrashCandidates);
const recoverSessionMock = vi.mocked(recoverSession);
const runImportMock = vi.mocked(runImport);
const runDiarizationMock = vi.mocked(runDiarization);
const writeSpeakerTranscriptsMock = vi.mocked(writeSpeakerTranscripts);
const deleteFallbackArtifactsMock = vi.mocked(deleteFallbackArtifacts);
const createFileSinkMock = vi.mocked(createFileSink);

// ---------------------------------------------------------------------------
// Test harness helpers.
// ---------------------------------------------------------------------------

function fakeStream(id = 'stream'): MediaStream {
  // `getTracks` is real here because `prepareRecording` releases the
  // permission-only stream again (App.tsx, hardware test 01 finding 1).
  return { id, getTracks: () => [] } as unknown as MediaStream;
}

/** jsdom has no `matchMedia` at all; stubbed "reduced motion on" so `DemoLoop`'s
 * typewriter `setInterval` never starts (it would otherwise tick real timers
 * during `waitFor`s and update state outside any `act()` this suite drives). */
function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }),
  });
}

// U2 (race-flake hardening):
// jsdom's `requestAnimationFrame` is a REAL, uncontrolled timer (fires ~16 ms
// later on the wall clock, confirmed by measurement — nothing this suite
// drives waits for it or mocks it away). `VuMeter` (mounted whenever
// `deviceState === 'recording'`) starts an rAF loop the instant recording
// begins; its very first tick always calls `setFill` (its `lastFill` sentinel
// starts at `-1`, so ANY level — including the constant `0` every fake
// `LiveCapture.getLevel` in this file returns — differs from it), causing a
// real re-render OUTSIDE of any `act()`/`fireEvent()` this suite wraps. Same
// fix shape as `stubMatchMedia` above, same reason: no assertion here reads
// the VU meter's fill, so neutering the callback (never invoking it) removes
// this one source of real-timer-driven renders without changing anything
// under test.
//
// IMPORTANT — this is a PARTIAL mitigation, not a full fix: a newly found,
// pre-existing (independent of every change in this unit — reproduces on
// unmodified `App.tsx`/`App.test.tsx` too) flake in test #4 survives this
// stub. Confirmed via direct A/B measurement: ~1 in 25-40 isolated
// `App.test.tsx`-only runs still fails the same way (`getUserMediaMock`/
// `coordinator.start` called twice, same "not configured to support
// act(...)" console warning) both before and after this stub. The likely
// remaining source is the SAME class of bug: the recording elapsed-clock's
// real `window.setInterval` (App.tsx, 250 ms, runs for as long as
// `recording` is true) can tick — and call `setElapsedMs` outside any
// `act()` — during the exact synchronous tap-then-tap window #4 relies on.
// Unlike `requestAnimationFrame`, this can't be stubbed the same way without
// risk: RTL's own `waitFor` (`@testing-library/dom/dist/wait-for.js`) uses
// `window.setInterval` for ITS OWN 50 ms polling loop when real timers are
// active, so blanket-stubbing `setInterval` would break `waitFor` itself
// suite-wide. A real fix needs either fake timers threaded through this
// whole file (a much bigger, higher-risk change than one unit should take
// on unreviewed) or a more surgical mock of the elapsed-clock effect
// specifically — left open as a known, accepted flake: test #4
// (stop-then-start) can still fail at roughly the ~1-in-25-to-40 rate
// measured above; re-run it once rather than treating a failure there as a
// real regression.
function stubRequestAnimationFrame() {
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: () => 0,
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: () => {},
  });
}

let getUserMediaMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia(true);
  stubRequestAnimationFrame();

  getUserMediaMock = vi.fn(async () => fakeStream('mic'));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: getUserMediaMock },
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

/** `<main className="device" data-state={deviceState}>` — the one reliable,
 * virtualization-independent hook for asserting App's current screen state
 * (`LiveTranscript`/`SpeakerView` are virtualized and don't reliably render
 * row text under jsdom's zero-height layout — see `StoppedScreen.test.tsx`). */
function deviceState(): string | null {
  return screen.getByRole('main').getAttribute('data-state');
}

function blurActive() {
  const el = document.activeElement;
  if (el instanceof HTMLElement) el.blur();
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Renders App, loads the model, and drives Engine's fake FSM
 * idle -> downloading -> ready (mirroring the real `load()` -> `initialize()`
 * flow), then walks the folder-first setup step (hardware test 01, findings 1 +
 * 2: no folder is ever restored silently any more, so every session picks its
 * storage location — and the mic permission — via `RecordSetupView` before the
 * record button unlocks). Ends with the record button enabled. */
async function reachReady() {
  render(<App />);
  await flush();

  fireEvent.click(screen.getByRole('button', { name: 'Modell laden' }));
  const engine = latestEngine();
  expect(engine.load).toHaveBeenCalledTimes(1);

  act(() => engine.setStatus('ready', { progress: 1 }));
  fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Speicherort wählen' })));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Aufnahme starten' })).not.toBeDisabled());
  await flush(); // let the setup's mic-permission request settle before the test drives on
  // The setup step asks for the mic ONCE, purely for the permission (App.tsx's
  // `prepareRecording` releases that stream again). Every test below counts
  // `getUserMedia` calls made by RECORDING, so start them from zero.
  getUserMediaMock.mockClear();
}

function switchToMeetingMode() {
  fireEvent.click(screen.getByRole('radio', { name: 'Online Meeting' }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('App state machine (U9)', () => {
  describe('baseline: record mode start -> stop', () => {
    it('exercises the full collaborator call sequence with no races involved', async () => {
      await reachReady();
      const engine = latestEngine();

      fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
      await waitFor(() => expect(deviceState()).toBe('recording'));

      const liveCapture = latestLiveCapture();
      const coordinator = latestCoordinator();
      expect(getUserMediaMock).toHaveBeenCalledTimes(1);
      expect(liveCapture.start).toHaveBeenCalledTimes(1);
      expect(coordinator.start).toHaveBeenCalledTimes(1);
      expect(engine.startLive).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { name: 'Aufnahme stoppen' }));
      await waitFor(() => expect(deviceState()).toBe('stopped'));

      expect(liveCapture.stop).toHaveBeenCalledTimes(1);
      expect(engine.stopLive).toHaveBeenCalledTimes(1);
      expect(coordinator.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('#1 double-start', () => {
    it('two Space taps inside the deferred getUserMedia window only start one session', async () => {
      await reachReady();

      let resolveGetUserMedia!: (stream: MediaStream) => void;
      getUserMediaMock.mockImplementationOnce(
        () => new Promise<MediaStream>((resolve) => { resolveGetUserMedia = resolve; }),
      );

      blurActive();
      fireEvent.keyDown(window, { key: ' ', code: 'Space' }); // tap 1 -> suspends at the deferred getUserMedia
      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.keyDown(window, { key: ' ', code: 'Space' }); // tap 2 -> lands in the open window

      // The re-entrant tap never even re-entered getUserMedia — the App-level
      // `transitionRef` guard (set synchronously before the first `await`)
      // rejected it before `startRecording`'s body ran a second time.
      expect(getUserMediaMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveGetUserMedia(fakeStream('mic'));
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => expect(deviceState()).toBe('recording'));
      expect(latestCoordinator().start).toHaveBeenCalledTimes(1);
      expect(latestLiveCapture().start).toHaveBeenCalledTimes(1);
    });
  });

  describe('#4 stop-then-start race', () => {
    it('a restart fired while engine.stopLive() drains does not begin a second session', async () => {
      await reachReady();
      fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
      await waitFor(() => expect(deviceState()).toBe('recording'));

      const coordinator = latestCoordinator();
      const engine = latestEngine();
      expect(coordinator.start).toHaveBeenCalledTimes(1);
      expect(getUserMediaMock).toHaveBeenCalledTimes(1);

      let resolveStopLive!: () => void;
      engine.stopLive.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveStopLive = resolve; }));

      blurActive();
      fireEvent.keyDown(window, { key: ' ', code: 'Space' }); // stop -> suspends at the deferred engine.stopLive()
      fireEvent.keyDown(window, { key: ' ', code: 'Space' }); // restart intent lands in the open window

      // Blocked by the same top-level `transitionRef` guard — no second mic
      // acquisition, no second coordinator session, while the stop is still
      // draining.
      expect(getUserMediaMock).toHaveBeenCalledTimes(1);
      expect(coordinator.start).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveStopLive();
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => expect(coordinator.stop).toHaveBeenCalledTimes(1));
      // Still only the original session ever started, even after the stop settled.
      expect(coordinator.start).toHaveBeenCalledTimes(1);
    });
  });

  describe('#9 meeting double-tap', () => {
    it('two rapid Space stops while coordinator.stop() drains close the session only once', async () => {
      await reachReady();
      switchToMeetingMode();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Aufnahme starten' })).not.toBeDisabled());

      fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
      await waitFor(() => expect(deviceState()).toBe('recording'));
      // U2 (defensive; mechanism unconfirmed): unlike the live-mic stop path
      // hardened above, `startMeeting` (App.tsx) sets `deviceState('recording')` as its
      // LAST instruction before returning, so the `runExclusive` guard clears in the
      // same continuation — this specific gap is not the confirmed cause of #9's rare
      // (1/10 under load) failure. Waiting for the button's `busy` gate here anyway
      // costs nothing when the guard is already clear (the common case) and closes off
      // the same *class* of bug if a not-yet-understood variant of it exists.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Aufnahme stoppen' })).not.toBeDisabled());

      const coordinator = latestCoordinator();
      expect(coordinator.start).toHaveBeenCalledTimes(1);

      let resolveStop!: () => void;
      coordinator.stop.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveStop = resolve; }));

      blurActive();
      fireEvent.keyDown(window, { key: ' ', code: 'Space' }); // stop 1 -> suspends at the deferred coordinator.stop()
      fireEvent.keyDown(window, { key: ' ', code: 'Space' }); // stop 2 lands in the open window (deviceState is
      // still 'recording' — the meeting stop path doesn't flip it early)

      expect(coordinator.stop).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveStop();
        await Promise.resolve();
        await Promise.resolve();
      });

      // Only the first stop's processAudioBlob ever ran runImport.
      await waitFor(() => expect(runImportMock).toHaveBeenCalledTimes(1));
      expect(coordinator.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('#7 annotation across a session boundary (recordingGenerationRef)', () => {
    it('discards a stale diarization result once a new recording has begun', async () => {
      await reachReady();

      // First recording: emit a transcript segment (so annotation doesn't
      // skip on "nothing transcribed"), then stop — the mic path parks the
      // recorded audio as `pendingAnnotation`.
      fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
      await waitFor(() => expect(deviceState()).toBe('recording'));
      act(() => latestEngine().emitSegment({ text: 'Hallo Welt', startMs: 0, endMs: 900 }));
      fireEvent.click(screen.getByRole('button', { name: 'Aufnahme stoppen' }));
      await waitFor(() => expect(deviceState()).toBe('stopped'));

      // Hold the diarization pass open mid-flight.
      let resolveDiarization!: (result: DiarizationRunResult) => void;
      runDiarizationMock.mockImplementationOnce(
        () => new Promise<DiarizationRunResult>((resolve) => { resolveDiarization = resolve; }),
      );
      // `deviceState` flips to `stopped` before `pendingAnnotation` is parked
      // (that happens in a later continuation of the same stop), so wait for the
      // BUTTON, not just the screen — a plain `getByRole` here made this test
      // flaky under parallel load.
      const annotateButton = await waitFor(() => screen.getByRole('button', { name: 'Sprecher erkennen' }));
      fireEvent.click(annotateButton);
      await waitFor(() => expect(runDiarizationMock).toHaveBeenCalledTimes(1));

      // Begin a NEW recording while the old pass is still in flight — this
      // bumps `recordingGenerationRef` past the value the in-flight pass
      // captured when it started.
      fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
      await waitFor(() => expect(deviceState()).toBe('recording'));

      // The stale pass now resolves successfully...
      await act(async () => {
        resolveDiarization({
          aligned: [{ text: 'Hallo Welt', startMs: 0, endMs: 900, speaker: 0 }],
          timeline: [],
          diarized: true,
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      // ...but must be discarded: it belongs to a recording that no longer
      // exists on screen, so the new session's export files/display must
      // never see it.
      expect(writeSpeakerTranscriptsMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Aufnahme stoppen' }));
      await waitFor(() => expect(deviceState()).toBe('stopped'));
      expect(document.querySelector('.speaker-view')).toBeNull();
    });
  });

  describe('recovery resolution', () => {
    const candidate: SessionRecord = {
      id: 'sess-crash-1',
      status: 'active',
      heartbeatAt: 5_000,
      lastSegmentSeq: 0,
      createdAt: 1_000,
    };

    it('"Fortsetzen" recovers the session and lands on stopped once the model is ready', async () => {
      findCrashCandidatesMock.mockResolvedValueOnce([candidate]);
      recoverSessionMock.mockResolvedValueOnce({
        recovered: true,
        session: { ...candidate, status: 'closed', heartbeatAt: 6_000 },
        segments: [{ sessionId: candidate.id, seq: 0, text: 'Wiederhergestellt', startMs: 0, endMs: 900 }],
      });

      render(<App />);
      await waitFor(() => expect(deviceState()).toBe('recovery'));

      // A model already cached from an earlier session — ready before the
      // user resolves the recovery offer (the offer surfaces regardless of
      // model readiness, "vor allem anderen").
      act(() => latestEngine().setStatus('ready', { progress: 1 }));

      fireEvent.click(screen.getByRole('button', { name: 'Fortsetzen' }));

      await waitFor(() => expect(recoverSessionMock).toHaveBeenCalledTimes(1));
      expect(recoverSessionMock).toHaveBeenCalledWith(expect.anything(), candidate.id, expect.any(Number));
      await waitFor(() => expect(deviceState()).toBe('stopped'));
    });

    it('"Verwerfen" discards the crash candidate and lands back at the pre-model landing', async () => {
      findCrashCandidatesMock.mockResolvedValueOnce([candidate]);

      render(<App />);
      await waitFor(() => expect(deviceState()).toBe('recovery'));

      fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));

      await waitFor(() => expect(deviceState()).toBe('idle'));
      expect(recoverSessionMock).not.toHaveBeenCalled();
    });
  });

  describe('permission-denied', () => {
    it('a getUserMedia rejection is caught, shows the mic-denied screen, and leaves nothing half-open', async () => {
      await reachReady();
      const liveCapture = latestLiveCapture();
      const coordinator = latestCoordinator();
      getUserMediaMock.mockRejectedValueOnce(
        Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
      );

      // `startRecording` wraps mic acquisition in a try/catch (App.tsx), so a
      // denied mic is handled cleanly — no unhandled rejection escapes
      // `toggleRecording`'s `void startRecording()`. If that catch regressed,
      // this rejection would surface as an unhandled rejection and fail the run.
      fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
      await waitFor(() => expect(getUserMediaMock).toHaveBeenCalledTimes(1));
      await flush();

      // Nothing half-open, still on `ready`, and the denial is now named on
      // screen (not silent).
      expect(liveCapture.start).not.toHaveBeenCalled();
      expect(coordinator.start).not.toHaveBeenCalled();
      expect(deviceState()).toBe('ready');
      expect(screen.getByText('Mikrofon-Zugriff abgelehnt.')).toBeInTheDocument();
    });

    it('the in-place "Erneut versuchen" retry re-requests the mic and records once granted — no reload', async () => {
      await reachReady();
      getUserMediaMock.mockRejectedValueOnce(
        Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
      await waitFor(() => expect(screen.getByText('Mikrofon-Zugriff abgelehnt.')).toBeInTheDocument());

      // The user has since allowed the mic in the browser: the retry's
      // getUserMedia (the default resolving mock) now succeeds → records, with
      // no page reload, and the mic-denied screen clears.
      fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
      await waitFor(() => expect(deviceState()).toBe('recording'));

      expect(latestLiveCapture().start).toHaveBeenCalledTimes(1);
      expect(latestCoordinator().start).toHaveBeenCalledTimes(1);
      expect(getUserMediaMock).toHaveBeenCalledTimes(2); // denied once, then granted
      expect(screen.queryByText('Mikrofon-Zugriff abgelehnt.')).toBeNull();
    });
  });

  describe('regression lock: resetAnnotationState (U6)', () => {
    it('runs two consecutive start->stop cycles without throwing (no self-recursion stack overflow)', async () => {
      await reachReady();

      for (let i = 0; i < 2; i += 1) {
        fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
        await waitFor(() => expect(deviceState()).toBe('recording'));
        fireEvent.click(screen.getByRole('button', { name: 'Aufnahme stoppen' }));
        await waitFor(() => expect(deviceState()).toBe('stopped'));
        // U2 race-flake hardening: the live-mic
        // branch of `stopRecording` (App.tsx) sets `deviceState('stopped')` as its
        // FIRST synchronous instruction — before `await engine.stopLive()` / `await
        // coordinator.stop()` even start — while the `runExclusive` re-entrancy guard
        // (`transitionRef`/`busy`) only clears in the `finally` AFTER those awaits.
        // Waiting on `deviceState` alone confirms the state flip but NOT that the
        // guard has cleared; under CPU contention the next loop iteration's start
        // click can land in that gap and silently no-op (`transitionRef.current` still
        // true), so `deviceState` never reaches `'recording'` again and the following
        // `waitFor` times out. The start button is gated by the SAME `busy` the
        // guard's `finally` resets, so waiting for it to become clickable again is the
        // one signal that actually confirms the whole handler — guard included — has
        // finished, not just its first side effect.
        await waitFor(() => expect(screen.getByRole('button', { name: 'Aufnahme starten' })).not.toBeDisabled());
      }

      // If `resetAnnotationState` still self-recursed (the pre-U6 bug), one of
      // the `fireEvent.click` calls above would have thrown a stack-overflow
      // `RangeError` synchronously — simply completing both cycles IS the lock.
      expect(deviceState()).toBe('stopped');
    });
  });

  describe('S2 wipe (privacy hardening [F2])', () => {
    // Owner feedback (2026-07-26) replaced S2's red in-screen button + its
    // Ja/Abbrechen row with the "clear with refresh" engraving under the
    // display. The PRIVACY guarantee this test locks is unchanged and is the
    // whole reason the action still exists: a browser reload alone does NOT
    // clear `SessionStore`'s IndexedDB rows or the OPFS fallback artifacts,
    // so the engraving must wipe both BEFORE it reloads — otherwise the
    // label lies and a shared computer keeps the recordings.
    let reloadMock: ReturnType<typeof vi.fn>;
    const realLocation = window.location;

    beforeEach(() => {
      reloadMock = vi.fn();
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...realLocation, reload: reloadMock },
      });
    });

    afterEach(() => {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
      Reflect.deleteProperty(globalThis, 'caches');
    });

    it('"Löschen & neu laden" wipes SessionStore + the OPFS fallback artifacts, then reloads the page', async () => {
      render(<App />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'Modell laden' }));
      act(() => latestEngine().setStatus('ready', { progress: 1 }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Speicherort wählen' })).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Löschen & neu laden' }));

      await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
      expect(latestSessionStore().deleteAllSessions).toHaveBeenCalledTimes(1);
      expect(deleteFallbackArtifactsMock).toHaveBeenCalledTimes(1);
    });

    // Owner feedback (2026-07-27): the same click must also make the reload
    // bring the CURRENT build. Without the app-shell wipe, the precached old
    // bundle survives at least one more reload and only a hard reload
    // (Ctrl+Shift+R — not something a tester knows) breaks the tie. Cache
    // Storage doesn't exist in jsdom, so the real API surface is defined here
    // rather than mocking the module away; `onnx-runtime-wasm` is in the list
    // to prove the expensive download is spared end-to-end, not just in
    // `appShellCache.test.ts`.
    it('also drops the cached app shell — but never the ONNX-Runtime WASM cache', async () => {
      const deleted: string[] = [];
      Object.defineProperty(globalThis, 'caches', {
        configurable: true,
        value: {
          keys: async () => ['workbox-precache-v2-https://localrec.pages.dev/', 'onnx-runtime-wasm'],
          delete: async (name: string) => {
            deleted.push(name);
            return true;
          },
        },
      });

      render(<App />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'Modell laden' }));
      act(() => latestEngine().setStatus('ready', { progress: 1 }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Speicherort wählen' })).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Löschen & neu laden' }));

      await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
      expect(deleted).toEqual(['workbox-precache-v2-https://localrec.pages.dev/']);
    });

    it('a failing wipe still reloads — the refresh the label promises is never swallowed by a storage error', async () => {
      render(<App />);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'Modell laden' }));
      act(() => latestEngine().setStatus('ready', { progress: 1 }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Speicherort wählen' })).toBeInTheDocument());

      latestSessionStore().deleteAllSessions.mockRejectedValueOnce(new Error('IndexedDB blocked'));

      fireEvent.click(screen.getByRole('button', { name: 'Löschen & neu laden' }));

      await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
    });

    it('is not offered mid-recording — a reload there would drop the running session', async () => {
      await reachReady();
      expect(screen.getByRole('button', { name: 'Löschen & neu laden' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
      await waitFor(() => expect(deviceState()).toBe('recording'));
      expect(screen.queryByRole('button', { name: 'Löschen & neu laden' })).toBeNull();
    });
  });
});

/**
 * Regression lock for the DEV-only "Modell laden bleibt bei 0 %" hang:
 * `main.tsx` renders App
 * inside `<StrictMode>`, which in development mounts → unmounts → remounts,
 * running the mount effect's cleanup once. That cleanup used to call
 * `engine.dispose()` → `worker.terminate()`, while `engineRef` (a render-time
 * `useRef` singleton) kept handing the SAME, now-dead Engine to the remount —
 * so the click's `initialize()` posted a Comlink message to a terminated
 * worker, never resolved, and the UI sat at `downloading` 0 % forever with no
 * error. Engine's lifetime is the component's, not the effect's.
 */
describe('StrictMode double-mount (DEV) — model load must survive the remount', () => {
  function engineInstances(): FakeEngineInstance[] {
    return (Engine as unknown as { instances: FakeEngineInstance[] }).instances;
  }

  it('keeps the single Engine (and its transcription worker) alive across the remount', async () => {
    const before = engineInstances().length;
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await flush();

    // One Engine for the component's lifetime — the ref singleton is not
    // re-created on the remount, so it must not be torn down by one either.
    expect(engineInstances().length - before).toBe(1);
    expect(latestEngine().dispose).not.toHaveBeenCalled();

    // And the click still drives a LIVE worker through to `ready`.
    fireEvent.click(screen.getByRole('button', { name: 'Modell laden' }));
    expect(latestEngine().load).toHaveBeenCalledTimes(1);
    act(() => latestEngine().setStatus('ready', { progress: 1 }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Aufnahme starten' })).toBeInTheDocument());

    // Segment stream: subscribed on remount, and the first mount's
    // subscription was cleaned up — the block must land exactly once.
    act(() => latestEngine().emitSegment({ text: 'Hallo Welt', startMs: 0, endMs: 900 }));
    expect(latestTranscriptStore().size).toBe(1);
  });
});

/**
 * Regression lock for hardware test 01, finding 1: the first
 * press of the red button asked for the MICROPHONE and then popped the folder
 * picker mid-start — two system dialogs, in the wrong order, with nothing on
 * screen explaining them. Record mode is folder-first now (like meeting mode
 * always was): the screen offers the setup step, that one click does folder →
 * mic, and the red button afterwards only starts.
 */
describe('record mode setup order (hardware test 01, finding 1)', () => {
  it('takes the folder before the mic, instructs on screen, and starts without any dialog', async () => {
    const order: string[] = [];
    createFileSinkMock.mockImplementationOnce(async () => {
      order.push('folder');
      return { kind: 'live-mirror', name: 'Testordner', openFile: vi.fn(async () => fakeAppendableFile()) } as never;
    });
    getUserMediaMock.mockImplementationOnce(async () => {
      order.push('mic');
      return fakeStream('mic');
    });

    render(<App />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Modell laden' }));
    act(() => latestEngine().setStatus('ready', { progress: 1 }));
    await waitFor(() => expect(deviceState()).toBe('ready'));

    // Nothing to press yet: the red button is gated until a folder exists, and
    // the screen says what to do instead.
    expect(screen.getByRole('button', { name: 'Aufnahme starten' })).toBeDisabled();
    const setup = screen.getByRole('button', { name: 'Speicherort wählen' });

    fireEvent.click(setup);
    await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());
    expect(order).toEqual(['folder', 'mic']); // …in THAT order — the whole point

    // Now the screen names the remaining step and the button is live.
    expect(screen.getByText(/roten Knopf in der Mitte die Aufnahme starten/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Aufnahme starten' })).not.toBeDisabled();

    // Starting opens NO picker any more (the sink is already open).
    createFileSinkMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
    await waitFor(() => expect(deviceState()).toBe('recording'));
    expect(createFileSinkMock).not.toHaveBeenCalled();
  });
});

/**
 * Hardware test 01, finding 2 — "ask for the storage location every time".
 * The `DeviceKnob` that used to carry the reset (and the mid-recording abort)
 * is gone (owner feedback, 2026-07-26: one control too many next to "clear
 * with refresh"). What must NOT go with it is finding 2's guarantee, so this
 * locks the replacement path: the "clear with refresh" engraving IS reachable
 * from the finished-recording screen, and a reload is what drops the previous
 * session's folder.
 */
describe('finding 2: a finished recording still has a way back to a fresh storage location', () => {
  const realLocation = window.location;
  let reloadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, reload: reloadMock },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('the engraving is offered on the stopped screen and reloads from there', async () => {
    await reachReady();

    fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
    await waitFor(() => expect(deviceState()).toBe('recording'));
    act(() => latestEngine().emitSegment({ text: 'Hallo Welt', startMs: 0, endMs: 900 }));
    fireEvent.click(screen.getByRole('button', { name: 'Aufnahme stoppen' }));
    await waitFor(() => expect(deviceState()).toBe('stopped'));

    // Without this the finished screen would be a dead end: the red button is
    // still live there and would append a second recording into the FIRST
    // one's `transkript.*` files.
    fireEvent.click(screen.getByRole('button', { name: 'Löschen & neu laden' }));
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
  });
});

/**
 * Firefox/Safari fallback-honesty fix (owner-reported bug): Firefox has no
 * File System Access API, so `createFileSink()` (`fileSink.ts`) always
 * resolves to the OPFS `FallbackSink` — no folder picker ever shown. Before
 * this fix, App still read that exactly like a chosen folder
 * ("Speicherort gewählt" / "Speicherort gesetzt"), and the resulting files
 * had no way back out of the browser. These tests exercise the two halves of
 * the fix through the SAME `App` wiring the other tests here drive: (a) the
 * honest copy on the setup screen + `Steps`, sourced from `sinkIsFallback`;
 * (b) the end-of-session download section on `StoppedScreen`, sourced from
 * `collectDownloads` reading `coordinator.sink`.
 */
describe('Firefox/Safari fallback-honesty fix', () => {
  it('shows honest "kein Ordner-Zugriff" copy instead of "Speicherort gewählt" when createFileSink resolves the fallback sink', async () => {
    createFileSinkMock.mockImplementationOnce(async () => ({
      kind: 'fallback',
      name: undefined,
      openFile: vi.fn(async () => fakeAppendableFile()),
    }) as never);

    render(<App />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Modell laden' }));
    act(() => latestEngine().setStatus('ready', { progress: 1 }));
    await waitFor(() => expect(deviceState()).toBe('ready'));

    fireEvent.click(screen.getByRole('button', { name: 'Speicherort wählen' }));
    await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());

    // The honest fallback note, not the old dishonest default.
    expect(
      screen.getByText('Kein direkter Ordner-Zugriff in diesem Browser — die Dateien gibt es am Ende als Download. Mikrofon freigegeben.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Speicherort gewählt. Mikrofon freigegeben.')).not.toBeInTheDocument();
    // `Steps` (footer) tells the same honest story, not "Speicherort gesetzt".
    expect(screen.getByText('Kein Ordner-Zugriff — im Browser gespeichert')).toBeInTheDocument();
    // The record button still unlocks — a fallback sink is fully functional,
    // only its messaging changed (hasOutputTarget stays true).
    expect(screen.getByRole('button', { name: 'Aufnahme starten' })).not.toBeDisabled();
  });

  it('offers a download link for every trapped file once a fallback session stops', async () => {
    await reachReady();

    const fallbackFiles = new Map<string, Blob>([
      ['transkript.txt', new Blob(['hallo welt'], { type: 'text/plain' })],
    ]);
    // Simulates what the REAL `RecordingCoordinator` retains as `.sink` once
    // `start()` resolves with a fallback sink (or a live-mirror sink that
    // degraded mid-session, R7 Grenzfall — same `kind`/shape either way from
    // `App.tsx`'s `collectDownloads` point of view). Set BEFORE the start
    // click so it's already in place once `coordinator.start()`'s mock
    // resolves — matching the real coordinator's own timing.
    (latestCoordinator() as unknown as { sink: unknown }).sink = {
      kind: 'fallback',
      collectDownloads: vi.fn(async () => fallbackFiles),
    };

    fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
    await waitFor(() => expect(deviceState()).toBe('recording'));
    fireEvent.click(screen.getByRole('button', { name: 'Aufnahme stoppen' }));
    await waitFor(() => expect(deviceState()).toBe('stopped'));

    await waitFor(() => expect(screen.getByRole('link', { name: 'transkript.txt' })).toBeInTheDocument());
    // `Steps`' finalize step matches too: "im Browser gespeichert", not
    // "Gespeichert in …" (no folder name — nothing was ever chosen).
    expect(screen.getByText('Im Browser gespeichert — Download unten')).toBeInTheDocument();
  });
});

/**
 * U5 (KTD8/KTD9/KTD10, plan `2026-07-25-007`) — the "i" info button next to
 * `LocaleSwitch` and the info view it opens. `InfoView.test.tsx` covers the
 * view's own content (prompts, filenames, KTD10 sentence, copy buttons,
 * element counts); these tests cover the App-level wiring the plan calls
 * out specifically: visibility per `deviceState`, that opening it does NOT
 * change `deviceState` (every `deviceState()` assertion above this point
 * stays valid), `Escape`, and — the "heikelster Punkt" — that Space cannot
 * start a recording while the info view is open.
 */
describe('U5: info entry point + info pop-up', () => {
  // The whole suite is pinned to German by default (`vitest.setup.ts`); the
  // one test below that moves the locale (`setLocale('fr')`) restores it
  // here, so it can't leak into whichever test file runs after this one —
  // same discipline `length.test.ts`/`LocaleSwitch.test.tsx` already take.
  afterEach(() => setLocale('de'));

  it('the "How it works" engraving is visible on idle', async () => {
    render(<App />);
    await flush();
    expect(deviceState()).toBe('idle');
    expect(screen.getByRole('button', { name: 'So funktioniert es' })).toBeInTheDocument();
  });

  it('the "How it works" engraving is visible while the device rests (ready, stopped) and gone while recording', async () => {
    await reachReady();
    expect(deviceState()).toBe('ready');
    expect(screen.getByRole('button', { name: 'So funktioniert es' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
    await waitFor(() => expect(deviceState()).toBe('recording'));
    expect(screen.queryByRole('button', { name: 'So funktioniert es' })).toBeNull();

    // Back on `stopped` it returns: both engravings share one visibility rule
    // ("the device is at rest"), and the pop-up is a modal now — reading it
    // over the finished transcript interrupts nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Aufnahme stoppen' }));
    await waitFor(() => expect(deviceState()).toBe('stopped'));
    expect(screen.getByRole('button', { name: 'So funktioniert es' })).toBeInTheDocument();
  });

  it('the "How it works" engraving is absent on the recovery screen', async () => {
    findCrashCandidatesMock.mockResolvedValueOnce([
      { id: 'sess-crash-info', status: 'active', heartbeatAt: 5_000, lastSegmentSeq: 0, createdAt: 1_000 },
    ]);
    render(<App />);
    await waitFor(() => expect(deviceState()).toBe('recovery'));
    expect(screen.queryByRole('button', { name: 'So funktioniert es' })).toBeNull();
  });

  it('clicking "How it works" opens the info pop-up WITHOUT changing deviceState, and "Zurück" closes it again', async () => {
    await reachReady();
    expect(deviceState()).toBe('ready');

    fireEvent.click(screen.getByRole('button', { name: 'So funktioniert es' }));
    expect(deviceState()).toBe('ready'); // KTD8 — unchanged
    expect(screen.getByText('Was hier passiert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    expect(deviceState()).toBe('ready'); // still unchanged
    expect(screen.queryByText('Was hier passiert')).toBeNull();
    // The demo loop's screen is back (the button used to open the info view
    // is again reachable, proving `renderScreen()` fell through past the
    // `infoOpen` branch).
    expect(screen.getByRole('button', { name: 'So funktioniert es' })).toBeInTheDocument();
  });

  it('Escape closes the info view; a second Escape does nothing further', async () => {
    await reachReady();
    fireEvent.click(screen.getByRole('button', { name: 'So funktioniert es' }));
    expect(screen.getByText('Was hier passiert')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(deviceState()).toBe('ready');
    expect(screen.queryByText('Was hier passiert')).toBeNull();

    // Second Escape: already closed, nothing left to do, no error, no state change.
    expect(() => fireEvent.keyDown(window, { key: 'Escape' })).not.toThrow();
    expect(deviceState()).toBe('ready');
    expect(screen.queryByText('Was hier passiert')).toBeNull();
  });

  it('Space starts no recording while the info view is open; after closing it, Space starts normally', async () => {
    await reachReady();
    getUserMediaMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'So funktioniert es' }));
    expect(screen.getByText('Was hier passiert')).toBeInTheDocument();

    blurActive(); // the engraving/close button must not be what's absorbing the keydown
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(getUserMediaMock).not.toHaveBeenCalled();
    expect(deviceState()).toBe('ready'); // never moved to 'recording'

    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    blurActive();
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    await waitFor(() => expect(deviceState()).toBe('recording'));
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
  });

  // Code-review Befund 1 (four independent reviewers): the mouse-click
  // counterpart to the Space test above. The Space path is guarded inside
  // `toggleRecording`'s caller (the keydown effect's own `if (infoOpen)
  // return;`), but the RecordButton itself had no such guard — it stayed
  // enabled and clickable while the info view covered the screen, so a click
  // there started a recording behind the open info view.
  it('a click on the red button while the info view is open does nothing; after closing it, the click starts normally', async () => {
    await reachReady();
    getUserMediaMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'So funktioniert es' }));
    expect(screen.getByText('Was hier passiert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
    expect(getUserMediaMock).not.toHaveBeenCalled();
    expect(deviceState()).toBe('ready'); // never moved to 'recording'

    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
    await waitFor(() => expect(deviceState()).toBe('recording'));
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
  });

  it('setLocale("fr") renders the info view in the foreign-language table (spot check)', async () => {
    await reachReady();
    act(() => setLocale('fr'));
    fireEvent.click(screen.getByRole('button', { name: 'Comment ça marche' }));
    // U5b landed the real French table; the suite itself stays pinned to German
    // by default and `afterEach` above restores 'de'.
    expect(screen.getByText('Ce qui se passe ici')).toBeInTheDocument();
  });
});

// Code-review Befund 2: `renderScreen()` has two record-mode `ready` displays
// — `RecordSetupView` (with the U6 consent sentence) and a fall-through demo
// display for a session whose folder is already set but which never (re-)
// entered `RecordSetupView`'s `ready` branch (its own comment: "a
// restored-folder session never passes through RecordSetupView"). That
// fall-through is reached here the same way `startRecording`'s own catch
// reaches it for real — a `liveCapture.start()` failure lands back on `ready`
// with `hasOutputTarget` still true but `setupHint` already cleared, which is
// exactly the branch condition (`!hasOutputTarget || setupHint` both false)
// that skips `RecordSetupView`.
describe('code-review Befund 2: consent note on the fall-through ready display', () => {
  it('shows the consent sentence on the fall-through demo-loop ready display too, not only in RecordSetupView', async () => {
    await reachReady();

    latestLiveCapture().start.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
    await waitFor(() => expect(deviceState()).toBe('ready'));

    // Confirm this really is the fall-through display, not `RecordSetupView`'s
    // `ready` branch: only the latter prints `setup.readyMessage`.
    expect(screen.queryByText('Bereit. Mit dem roten Knopf in der Mitte die Aufnahme starten.')).toBeNull();

    expect(
      screen.getByText('Mit dem Start bestätigst du: Alle Teilnehmenden wissen von der Aufnahme und sind einverstanden.'),
    ).toBeInTheDocument();
  });
});

/**
 * Owner feedback (2026-07-26): the record button punches through the screen's
 * bottom edge, so whatever renders LAST on a ready display gets cut in half.
 * The consent sentence (R11) is the line that must stay readable, so it and
 * the transcription-language dropdown swapped places on BOTH ready displays.
 * A DOM-order lock, because nothing else in the suite would notice the two
 * silently swapping back.
 */
describe('owner feedback: the consent sentence sits ABOVE the language dropdown on both ready displays', () => {
  function consentPrecedesLanguageSelect() {
    const consent = screen.getByText(
      'Mit dem Start bestätigst du: Alle Teilnehmenden wissen von der Aufnahme und sind einverstanden.',
    );
    const language = screen.getByLabelText('Sprache der Aufnahme');
    // Node.DOCUMENT_POSITION_FOLLOWING (4): `language` comes after `consent`.
    return (consent.compareDocumentPosition(language) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  it('RecordSetupView ready branch', async () => {
    await reachReady();
    expect(screen.getByText('Bereit. Mit dem roten Knopf in der Mitte die Aufnahme starten.')).toBeInTheDocument();
    expect(consentPrecedesLanguageSelect()).toBe(true);
  });

  it('fall-through demo-loop ready display', async () => {
    await reachReady();
    latestLiveCapture().start.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByRole('button', { name: 'Aufnahme starten' }));
    await waitFor(() => expect(deviceState()).toBe('ready'));

    expect(screen.queryByText('Bereit. Mit dem roten Knopf in der Mitte die Aufnahme starten.')).toBeNull();
    expect(consentPrecedesLanguageSelect()).toBe(true);
  });
});
