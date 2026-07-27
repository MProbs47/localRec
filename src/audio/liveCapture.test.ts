// Realitätsgrenze: `AudioContext`/`AudioWorkletNode`/`MediaStream` don't exist
// under Vitest's default `node` environment — every fake below implements
// exactly the narrow structural interface `liveCapture.ts` depends on
// (`LiveCaptureAudioContextLike`, `WorkletNodeLike`), mirroring
// `mixStreams.test.ts`'s fake-`AudioContextLike` pattern one layer up (this
// module composes `connectMixedSources` on top of the worklet/feed/teardown
// logic under test here). A real Web-Audio graph stays the plan's documented
// manual milestone.
import { describe, expect, it, vi } from 'vitest';
import {
  LiveCapture,
  RING_BUFFER_CAPACITY_SAMPLES,
  type LiveCaptureAudioContextLike,
  type LiveCaptureDeps,
  type MicMonitorNodeLike,
  type WorkletMessage,
  type WorkletNodeLike,
} from './liveCapture';
import type {
  AudioNodeLike,
  MediaStreamAudioDestinationNodeLike,
  MediaStreamAudioSourceNodeLike,
} from './mixStreams';

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

/** A minimal fake `MediaStream` — one track, stoppable, identifiable in assertions. */
function fakeStream(id: string): { stream: MediaStream; track: FakeTrack } {
  const track = new FakeTrack();
  const stream = { id, getTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

class FakeSourceNode implements MediaStreamAudioSourceNodeLike {
  readonly sourceStream: MediaStream;
  connectedTo: AudioNodeLike[] = [];
  disconnected = false;
  constructor(sourceStream: MediaStream) {
    this.sourceStream = sourceStream;
  }
  connect(node: AudioNodeLike): void {
    this.connectedTo.push(node);
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeDestinationNode implements MediaStreamAudioDestinationNodeLike {
  readonly stream: MediaStream;
  constructor(stream: MediaStream) {
    this.stream = stream;
  }
  connect(): void {
    // never called on the destination node itself in this graph
  }
}

class FakeWorkletNode implements WorkletNodeLike {
  portClosed = false;
  disconnected = false;
  readonly port: WorkletNodeLike['port'];

  constructor() {
    const self = this;
    this.port = {
      onmessage: null,
      close: () => {
        self.portClosed = true;
      },
    };
  }
  connect(): void {
    // never called on the worklet node itself in this graph
  }
  disconnect(): void {
    this.disconnected = true;
  }
  /** Test helper: simulates the worklet posting a `{pcm, rms}` message. */
  post(message: WorkletMessage): void {
    this.port.onmessage?.({ data: message } as MessageEvent<WorkletMessage>);
  }
}

/**
 * The mic-only tap (`mixStreams.ts`'s `MicMonitorNode`). `samples` is what
 * the watch will read — a test sets it to silence or to signal and drives
 * the interval by hand.
 */
class FakeMicMonitor implements MicMonitorNodeLike {
  readonly fftSize = 4;
  samples = new Float32Array(4); // all zeros = a dead microphone
  disconnected = false;
  getFloatTimeDomainData(array: Float32Array): void {
    array.set(this.samples.subarray(0, array.length));
  }
  connect(): void {
    // nothing is routed onward from a monitor — it is a pure tap
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeAudioContext implements LiveCaptureAudioContextLike {
  createdSources: FakeSourceNode[] = [];
  destinationStream = { id: 'dest-stream' } as unknown as MediaStream;
  lastDest: FakeDestinationNode | null = null;
  lastAnalyser: FakeMicMonitor | null = null;
  closed = false;
  addModule = vi.fn(async (_moduleUrl: string) => {});
  audioWorklet = { addModule: (url: string) => this.addModule(url) };

  createAnalyser(): MicMonitorNodeLike {
    this.lastAnalyser = new FakeMicMonitor();
    return this.lastAnalyser;
  }

  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNodeLike {
    const node = new FakeSourceNode(stream);
    this.createdSources.push(node);
    return node;
  }
  createMediaStreamDestination(): MediaStreamAudioDestinationNodeLike {
    this.lastDest = new FakeDestinationNode(this.destinationStream);
    return this.lastDest;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Builds an injectable `LiveCaptureDeps` over fresh fakes, plus handles to drive/inspect them. */
function makeHarness(overrides: Partial<LiveCaptureDeps> = {}) {
  const ctx = new FakeAudioContext();
  const worklet = new FakeWorkletNode();
  const intervalHandlers: Array<() => void> = [];
  const clearedIds: number[] = [];

  const deps: LiveCaptureDeps = {
    createAudioContext: () => ctx,
    loadWorkletModule: (c) => c.audioWorklet.addModule('worklet-processor.js'),
    createWorkletNode: () => worklet,
    setIntervalImpl: (handler) => {
      intervalHandlers.push(handler);
      return intervalHandlers.length; // 1-based fake id
    },
    clearIntervalImpl: (id) => {
      clearedIds.push(id);
    },
    ...overrides,
  };

  return { ctx, worklet, intervalHandlers, clearedIds, deps, capture: new LiveCapture(deps) };
}

describe('LiveCapture (U6: the live audio-capture graph behind one seam)', () => {
  it('feeds onPcm at the feed cadence with the ring buffer contents, draining it', async () => {
    const { worklet, intervalHandlers, capture } = makeHarness();
    const { stream: mic } = fakeStream('mic');
    const onPcm = vi.fn();

    await capture.start({ mic, onPcm });
    expect(intervalHandlers).toHaveLength(1); // the feed interval is armed

    worklet.post({ pcm: new Float32Array([1, 2, 3]), rms: 0.1 });
    worklet.post({ pcm: new Float32Array([4, 5]), rms: 0.2 });

    intervalHandlers[0](); // simulate one feed tick

    expect(onPcm).toHaveBeenCalledTimes(1);
    expect(onPcm.mock.calls[0][0]).toEqual(new Float32Array([1, 2, 3, 4, 5]));

    // A tick with nothing newly written drains to an empty read and must not
    // call onPcm again (mirrors the pre-U6 `if (chunk.length === 0) return`).
    intervalHandlers[0]();
    expect(onPcm).toHaveBeenCalledTimes(1);
  });

  it('getLevel reflects the last posted rms; 0 before start and after stop', async () => {
    const { worklet, capture } = makeHarness();
    const { stream: mic } = fakeStream('mic');

    expect(capture.getLevel()).toBe(0);

    await capture.start({ mic });
    worklet.post({ pcm: new Float32Array(0), rms: 0.42 });
    expect(capture.getLevel()).toBe(0.42);

    capture.stop();
    expect(capture.getLevel()).toBe(0);
  });

  // Owner feedback (2026-07-27, a half-lost meeting): the mic branch alone,
  // because the VU meter shows it summed with the remote side.
  describe('mic-silence watch (onMicSilence)', () => {
    /** A harness with a hand-driven clock, so the 8s grace window costs no real time. */
    function micWatchHarness() {
      let clock = 0;
      const harness = makeHarness({ now: () => clock });
      return { ...harness, advance: (ms: number) => (clock += ms) };
    }

    it('reports once when the mic branch stayed silent past the grace window', async () => {
      const { ctx, intervalHandlers, capture, advance } = micWatchHarness();
      const { stream: mic } = fakeStream('mic');
      const { stream: system } = fakeStream('system');
      const onMicSilence = vi.fn();

      await capture.start({ mic, system, onMicSilence });
      // The monitor hangs off the MIC source only — never the system source.
      expect(ctx.createdSources[0].connectedTo).toContain(ctx.lastAnalyser);
      expect(ctx.createdSources[1].connectedTo).not.toContain(ctx.lastAnalyser);

      intervalHandlers[0](); // inside the grace window: silence is not yet news
      expect(onMicSilence).not.toHaveBeenCalled();

      advance(8_000);
      intervalHandlers[0]();
      expect(onMicSilence).toHaveBeenCalledTimes(1);

      // Terminal: the watch stopped sampling, so a later tick can't repeat it.
      intervalHandlers[0]();
      expect(onMicSilence).toHaveBeenCalledTimes(1);
    });

    it('never reports once the mic delivered signal, however long the meeting runs', async () => {
      const { ctx, intervalHandlers, capture, advance } = micWatchHarness();
      const { stream: mic } = fakeStream('mic');
      const onMicSilence = vi.fn();

      await capture.start({ mic, onMicSilence });
      ctx.lastAnalyser!.samples = new Float32Array([0, 0.2, 0, -0.1]); // someone spoke
      intervalHandlers[0]();

      ctx.lastAnalyser!.samples = new Float32Array(4); // and then went quiet for a while
      advance(60_000);
      intervalHandlers[0]();

      expect(onMicSilence).not.toHaveBeenCalled();
    });

    it('treats a floor below the threshold as silence (a dead device, not a quiet room)', async () => {
      const { ctx, intervalHandlers, capture, advance } = micWatchHarness();
      const { stream: mic } = fakeStream('mic');
      const onMicSilence = vi.fn();

      await capture.start({ mic, onMicSilence });
      ctx.lastAnalyser!.samples = new Float32Array([0.001, -0.002, 0.003, 0]);

      advance(8_000);
      intervalHandlers[0]();
      expect(onMicSilence).toHaveBeenCalledTimes(1);
    });

    it('builds no monitor and arms no watch when nobody asked (Local Recording)', async () => {
      const { ctx, intervalHandlers, capture } = makeHarness();
      const { stream: mic } = fakeStream('mic');

      await capture.start({ mic }); // no onPcm, no onMicSilence

      expect(ctx.lastAnalyser).toBeNull();
      expect(intervalHandlers).toHaveLength(0);
    });

    it('stop() disconnects the monitor and disarms the watch', async () => {
      const { ctx, clearedIds, capture } = micWatchHarness();
      const { stream: mic } = fakeStream('mic');

      await capture.start({ mic, onMicSilence: vi.fn() });
      const monitor = ctx.lastAnalyser!;
      capture.stop();

      expect(monitor.disconnected).toBe(true);
      expect(clearedIds).toContain(1); // the watch interval's fake id
    });
  });

  it('getLevel is a stable reference across the instance lifetime', () => {
    const { capture } = makeHarness();
    const ref1 = capture.getLevel;
    const ref2 = capture.getLevel;
    expect(ref1).toBe(ref2);
  });

  it('stop() disconnects the mix sources, stops BOTH mic+system tracks, clears the interval, closes the context — idempotently', async () => {
    const { ctx, intervalHandlers, clearedIds, capture } = makeHarness();
    const { stream: mic, track: micTrack } = fakeStream('mic');
    const { stream: system, track: systemTrack } = fakeStream('system');
    const onPcm = vi.fn();

    await capture.start({ mic, system, onPcm });
    expect(ctx.createdSources).toHaveLength(2); // mic + system wired

    capture.stop();

    expect(ctx.createdSources.every((s) => s.disconnected)).toBe(true);
    expect(micTrack.stopped).toBe(true);
    expect(systemTrack.stopped).toBe(true);
    expect(clearedIds).toEqual(intervalHandlers.map((_, i) => i + 1));
    expect(ctx.closed).toBe(true);
    expect(capture.recordStream).toBeNull();

    // Idempotent: a second stop() must not throw or double-stop anything oddly.
    expect(() => capture.stop()).not.toThrow();
  });

  it('a failed start() (addModule rejects) leaves nothing half-open', async () => {
    const failingDeps: Partial<LiveCaptureDeps> = {
      loadWorkletModule: () => Promise.reject(new Error('addModule failed')),
    };
    const { ctx, intervalHandlers, capture } = makeHarness(failingDeps);
    const { stream: mic, track: micTrack } = fakeStream('mic');
    const { stream: system, track: systemTrack } = fakeStream('system');

    await expect(capture.start({ mic, system })).rejects.toThrow('addModule failed');

    expect(micTrack.stopped).toBe(true);
    expect(systemTrack.stopped).toBe(true);
    expect(ctx.closed).toBe(true);
    expect(ctx.createdSources).toHaveLength(0); // never reached connectMixedSources
    expect(intervalHandlers).toHaveLength(0); // never armed
    expect(capture.recordStream).toBeNull();
    expect(capture.getLevel()).toBe(0);
  });

  it('meeting-shape (no onPcm): no feed interval runs, RMS still updates getLevel, recordStream is the destination stream', async () => {
    const { ctx, worklet, intervalHandlers, capture } = makeHarness();
    const { stream: mic } = fakeStream('mic');
    const { stream: system } = fakeStream('system');

    await capture.start({ mic, system }); // no onPcm — the meeting shape

    expect(intervalHandlers).toHaveLength(0);
    expect(capture.recordStream).toBe(ctx.destinationStream);

    worklet.post({ pcm: new Float32Array([9, 9]), rms: 0.7 });
    expect(capture.getLevel()).toBe(0.7);
  });

  it("ring buffer capacity matches the exported RING_BUFFER_CAPACITY_SAMPLES constant (5s @ 16kHz)", () => {
    expect(RING_BUFFER_CAPACITY_SAMPLES).toBe(16_000 * 5);
  });
});
