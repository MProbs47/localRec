/**
 * U6 (plan 005, "Architektur-Review; ADR-0001-Fortführung") — the live
 * audio-capture graph behind one deep module (CONTEXT.md "Live Capture").
 * Before this unit the graph was **7 mutable refs**
 * (`audioContextRef`/`mediaStreamRef`/`workletNodeRef`/`feedIntervalRef`/
 * `systemStreamRef`/`mixTeardownRef`/`rmsRef`) smeared across `App.tsx`'s
 * `startRecording`, `startMeeting` and `teardownAudioPipeline` — duplicated
 * per Capture Mode and untestable through that interface. `LiveCapture`
 * pulls all of it behind one seam, constructed once per mount (`App`'s
 * `liveCaptureRef`, symmetric with `RecordingCoordinator`'s
 * `coordinatorRef`) and reused across recordings.
 *
 * **Comlink-free.** `App` wraps the worker transfer itself
 * (`onPcm: (chunk) => workerApi.feedAudio(Comlink.transfer(chunk,
 * [chunk.buffer]))`); this module just calls `onPcm(chunk)`.
 *
 * **Unified graph, no mode enum.** Both Capture Modes go through the same
 * `start()` → `connectMixedSources` path (`mixStreams.ts`); `recordStream`
 * is ALWAYS the mix destination's `.stream`, even mic-only (Local Recording
 * passes `system` undefined, which `connectMixedSources` already degrades
 * gracefully to a mic-only wire — audio-equivalent to the pre-U6 raw-mic
 * recording, not a literal no-op). Behavior falls out of which options are
 * present: `onPcm` present (Local Recording) → the ring buffer + 200 ms feed
 * interval run; `onPcm` absent (Online Meeting) → PCM is dropped but the
 * worklet's RMS still drives `getLevel()` for the VU meter.
 *
 * **Ownership handoff at `start()`.** The caller acquires `mic`/`system`
 * (each capture needs its own permission prompt / gesture) and owns them
 * UNTIL `start()` is called; from that call on, `LiveCapture` owns both
 * streams. `stop()` — and a FAILED `start()` — stop BOTH streams' tracks and
 * close the `AudioContext`, mirroring `RecordingCoordinator.start()`'s
 * "rejects, leaving nothing half-open" contract. A failed acquisition
 * BEFORE `start()` is still the caller's own cleanup (`App` keeps that
 * handling for `getUserMedia`/`captureSystemAudio`).
 *
 * Narrow structural interfaces (`AudioContextLike`'s `LiveCapture`
 * superset, `WorkletNodeLike`), not the ambient DOM types — same
 * Node/Vitest-testability reason as `mixStreams.ts`/`recordingCoordinator.ts`
 * (see those files' headers): none of `AudioContext`, `AudioWorkletNode` or
 * `audioWorklet.addModule` exist under Vitest, so the real Web Audio graph
 * stays the plan's documented manual milestone and this module's
 * graph-wiring/feed/teardown ORDERING is exercised against fakes instead.
 */
import { RingBuffer } from './ringBuffer';
import { connectMixedSources, type AudioContextLike, type AudioNodeLike } from './mixStreams';

/** 5s of backpressure margin (R14) — a stalled read loop loses old audio, not memory. */
export const RING_BUFFER_CAPACITY_SAMPLES = 16_000 * 5;
/** How often the feed loop drains the ring buffer into `onPcm` — only runs when a live transcription feed is wired (see the class doc). */
export const AUDIO_FEED_INTERVAL_MS = 200;

/** Shape posted by the AudioWorklet (`worklet-processor.js`): PCM to the ring buffer, RMS to the VU meter. */
export interface WorkletMessage {
  pcm: Float32Array;
  rms: number;
}

/** The narrow slice of `MessagePort` the worklet handler needs. */
export interface WorkletPortLike {
  onmessage: ((event: MessageEvent<WorkletMessage>) => void) | null;
  close(): void;
}

/** The narrow slice of `AudioWorkletNode` this module depends on — an `AudioNodeLike` (connects into `connectMixedSources`) plus its message port and disconnect. */
export interface WorkletNodeLike extends AudioNodeLike {
  readonly port: WorkletPortLike;
  disconnect(): void;
}

/** `mixStreams.ts`'s `AudioContextLike` plus the worklet-module load and context teardown this module additionally needs. */
export interface LiveCaptureAudioContextLike extends AudioContextLike {
  audioWorklet: { addModule(moduleUrl: string): Promise<void> };
  close(): Promise<void>;
}

export interface LiveCaptureDeps {
  /** Creates the 16 kHz capture context. Defaults to `new AudioContext({ sampleRate: 16000 })`. */
  createAudioContext?: () => LiveCaptureAudioContextLike;
  /** Loads `worklet-processor.js` into `ctx`. Defaults to the real `audioWorklet.addModule` against this module's own URL. */
  loadWorkletModule?: (ctx: LiveCaptureAudioContextLike) => Promise<void>;
  /** Creates the `pcm-capture-processor` node on `ctx`. Defaults to `new AudioWorkletNode(ctx, 'pcm-capture-processor')`. */
  createWorkletNode?: (ctx: LiveCaptureAudioContextLike) => WorkletNodeLike;
  /** Injectable timer (tests). Defaults to `window.setInterval`. */
  setIntervalImpl?: (handler: () => void, ms: number) => number;
  /** Injectable timer (tests). Defaults to `window.clearInterval`. */
  clearIntervalImpl?: (id: number) => void;
}

export interface LiveCaptureStartOptions {
  /** The device microphone — always present. Ownership passes to `LiveCapture` once `start()` is called (see class doc). */
  mic: MediaStream;
  /** Online Meeting's system-audio share. Absent/null for Local Recording (mic-only). */
  system?: MediaStream | null;
  /** Present → live transcription feed (Local Recording): the ring buffer + 200ms interval run, calling this with each drained chunk. Absent → Online Meeting: PCM is dropped, only `getLevel()` keeps updating. */
  onPcm?: (chunk: Float32Array) => void;
}

function defaultCreateAudioContext(): LiveCaptureAudioContextLike {
  return new AudioContext({ sampleRate: 16000 }) as unknown as LiveCaptureAudioContextLike;
}

async function defaultLoadWorkletModule(ctx: LiveCaptureAudioContextLike): Promise<void> {
  const workletUrl = new URL('./worklet-processor.js', import.meta.url);
  await ctx.audioWorklet.addModule(workletUrl.href);
}

function defaultCreateWorkletNode(ctx: LiveCaptureAudioContextLike): WorkletNodeLike {
  return new AudioWorkletNode(ctx as unknown as AudioContext, 'pcm-capture-processor') as unknown as WorkletNodeLike;
}

/**
 * The live audio-capture graph a Recording Session owns while active — see
 * the file header for the full design. One instance is constructed per
 * mount and reused across recordings (`start()`/`stop()` many times); it is
 * not itself re-entrancy-guarded (the coordinator/`App`'s
 * `RecordingPhase`/`transitionRef` already serialize start/stop at the
 * call site — see `recordingCoordinator.ts`).
 */
export class LiveCapture {
  readonly #createAudioContext: () => LiveCaptureAudioContextLike;
  readonly #loadWorkletModule: (ctx: LiveCaptureAudioContextLike) => Promise<void>;
  readonly #createWorkletNode: (ctx: LiveCaptureAudioContextLike) => WorkletNodeLike;
  readonly #setInterval: (handler: () => void, ms: number) => number;
  readonly #clearInterval: (id: number) => void;

  #ctx: LiveCaptureAudioContextLike | null = null;
  #worklet: WorkletNodeLike | null = null;
  #mic: MediaStream | null = null;
  #system: MediaStream | null = null;
  #mixTeardown: (() => void) | null = null;
  #recordStream: MediaStream | null = null;
  #feedIntervalId: number | null = null;
  #rms = 0;

  constructor(deps: LiveCaptureDeps = {}) {
    this.#createAudioContext = deps.createAudioContext ?? defaultCreateAudioContext;
    this.#loadWorkletModule = deps.loadWorkletModule ?? defaultLoadWorkletModule;
    this.#createWorkletNode = deps.createWorkletNode ?? defaultCreateWorkletNode;
    this.#setInterval = deps.setIntervalImpl ?? ((handler, ms) => window.setInterval(handler, ms));
    this.#clearInterval = deps.clearIntervalImpl ?? ((id) => window.clearInterval(id));
  }

  /** The stream `startOpusRecorder` should record — the mix destination's `.stream` (see the file header's "unified graph" note). `null` before `start()`/after `stop()`. */
  get recordStream(): MediaStream | null {
    return this.#recordStream;
  }

  /**
   * The latest smoothed mic level (`worklet-processor.js`'s RMS), 0 before
   * `start()`/after `stop()`. Declared as a bound instance field (not a
   * method needing `.bind`) so it stays referentially STABLE across the
   * instance's lifetime — `<VuMeter getLevel={liveCapture.getLevel} />`
   * never needs a fresh callback per render.
   */
  getLevel = (): number => this.#rms;

  /**
   * Builds the capture graph: `AudioContext(16k)` → worklet module load →
   * worklet node → `connectMixedSources(ctx, {mic, system}, worklet)` → (if
   * `onPcm`) the ring buffer + feed interval. From this call on,
   * `LiveCapture` owns `mic`/`system` (see file header) — a failure ANY
   * point in this method tears everything acquired so far back down
   * (`stop()`, idempotent-safe against partial state) before rethrowing, so
   * the caller never has to reason about a half-built graph.
   */
  async start({ mic, system, onPcm }: LiveCaptureStartOptions): Promise<void> {
    this.#mic = mic;
    this.#system = system ?? null;

    try {
      const ctx = this.#createAudioContext();
      this.#ctx = ctx;

      await this.#loadWorkletModule(ctx);

      const worklet = this.#createWorkletNode(ctx);
      this.#worklet = worklet;

      const ringBuffer = onPcm ? new RingBuffer(RING_BUFFER_CAPACITY_SAMPLES) : null;
      worklet.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
        const { pcm, rms } = event.data;
        this.#rms = rms;
        ringBuffer?.write(pcm);
      };

      const { recordStream, teardown } = connectMixedSources(ctx, { mic, system: this.#system }, worklet);
      this.#recordStream = recordStream;
      this.#mixTeardown = teardown;

      if (onPcm && ringBuffer) {
        this.#feedIntervalId = this.#setInterval(() => {
          const chunk = ringBuffer.readAvailable();
          if (chunk.length === 0) return;
          onPcm(chunk);
        }, AUDIO_FEED_INTERVAL_MS);
      }
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  /**
   * Full teardown, idempotent (a second/pre-`start()` call is a safe no-op):
   * clears the feed interval, disconnects the mix source nodes, closes the
   * worklet port + disconnects the node, stops BOTH `mic` and `system`
   * tracks, closes the `AudioContext`, and resets `getLevel()` to 0. Mirrors
   * the pre-U6 `teardownAudioPipeline`'s exact ordering.
   */
  stop(): void {
    if (this.#feedIntervalId !== null) {
      this.#clearInterval(this.#feedIntervalId);
      this.#feedIntervalId = null;
    }
    this.#mixTeardown?.();
    this.#mixTeardown = null;
    this.#worklet?.port.close();
    this.#worklet?.disconnect();
    this.#worklet = null;
    this.#mic?.getTracks().forEach((track) => track.stop());
    this.#mic = null;
    this.#system?.getTracks().forEach((track) => track.stop());
    this.#system = null;
    void this.#ctx?.close();
    this.#ctx = null;
    this.#recordStream = null;
    this.#rms = 0;
  }
}
