import { describe, expect, it } from 'vitest';
import {
  AdaptiveLatencyController,
  BackpressureTracker,
  DEESCALATE_TREND_THRESHOLD,
  ESCALATE_TREND_THRESHOLD,
  LATENCY_LADDER_MS,
  MAX_LATENCY_MS,
  MIN_LATENCY_MS,
  RtfMonitor,
  RtfTrendTracker,
  computeRtf,
} from './rtfMonitor';

// Manual milestone (per plan U7 verification): real thermal throttling on
// an actual iGPU laptop over a long session is NOT exercised by any
// automated test in this repo — there is no GPU/thermal access in this
// environment. Everything below tests the pure RTF/latency/backpressure
// decision core in isolation; wiring real wall-clock measurements from
// `transcription.worker.ts` into `RtfMonitor.observeChunk()` is documented
// as an Andockpunkt in `rtfMonitor.ts`'s header and is checked by hand at
// the plan's "auf einem echten Laptop gegen Sitzungsende" milestone.

describe('computeRtf (test scenario 1: known pairs -> correct factor)', () => {
  it('processing exactly as long as the audio is real-time (RTF 1.0)', () => {
    expect(computeRtf(200, 200)).toBe(1);
  });

  it('processing faster than real time yields RTF < 1', () => {
    expect(computeRtf(100, 200)).toBe(0.5);
  });

  it('processing slower than real time (behind real time) yields RTF > 1', () => {
    expect(computeRtf(400, 200)).toBe(2);
  });

  it('a chunk with no audio duration returns 0, not Infinity/NaN', () => {
    expect(computeRtf(100, 0)).toBe(0);
    expect(computeRtf(100, -5)).toBe(0);
  });
});

describe('RtfTrendTracker (moving trend, test scenario 1: a rising trend is "behind real time")', () => {
  it('trend is the moving average of the last `windowSize` RTF samples', () => {
    const tracker = new RtfTrendTracker(3);
    expect(tracker.trend).toBe(0); // no samples yet

    tracker.observe(1.0);
    tracker.observe(1.0);
    expect(tracker.trend).toBeCloseTo(1.0);

    tracker.observe(2.2); // (1.0 + 1.0 + 2.2) / 3
    expect(tracker.trend).toBeCloseTo(1.4, 5);

    // Window is full at 3 — a 4th sample drops the oldest, not just grows.
    tracker.observe(2.2); // (1.0 + 2.2 + 2.2) / 3
    expect(tracker.trend).toBeCloseTo(1.8, 5);
  });

  it('a sustained run of RTF > 1 chunks pushes the trend above 1.0 ("behind real time")', () => {
    const tracker = new RtfTrendTracker(5);
    let trend = 0;
    for (const rtf of [1.1, 1.2, 1.3, 1.4, 1.5]) {
      trend = tracker.observe(rtf);
    }
    expect(trend).toBeGreaterThan(ESCALATE_TREND_THRESHOLD);
  });

  it('a single anomalous slow chunk among fast ones does not alone push the trend past 1.0', () => {
    const tracker = new RtfTrendTracker(5);
    let trend = 0;
    for (const rtf of [0.3, 0.3, 0.3, 0.3, 3.0]) {
      trend = tracker.observe(rtf);
    }
    expect(trend).toBeLessThan(ESCALATE_TREND_THRESHOLD);
  });
});

describe('AdaptiveLatencyController (test scenario 2: stepwise escalation, 2.4s cap, hysteresis de-escalation)', () => {
  it('starts at the ladder floor (80ms)', () => {
    const controller = new AdaptiveLatencyController();
    expect(controller.latencyMs).toBe(MIN_LATENCY_MS);
  });

  it('escalates exactly one ladder step per update() call while behind real time', () => {
    const controller = new AdaptiveLatencyController();
    const before = controller.latencyMs;

    const changed = controller.update(1.5); // well above ESCALATE_TREND_THRESHOLD
    expect(changed).toBe(true);
    expect(controller.latencyMs).toBe(LATENCY_LADDER_MS[1]);
    expect(controller.latencyMs).toBeGreaterThan(before);
  });

  it('never exceeds MAX_LATENCY_MS (2.4s) even under sustained heavy overload', () => {
    const controller = new AdaptiveLatencyController();
    for (let i = 0; i < 100; i++) {
      controller.update(5.0); // way behind real time, every single call
      expect(controller.latencyMs).toBeLessThanOrEqual(MAX_LATENCY_MS);
    }
    expect(controller.latencyMs).toBe(MAX_LATENCY_MS);
  });

  it('de-escalates one step at a time once the trend recovers below the (lower) de-escalate threshold', () => {
    const controller = new AdaptiveLatencyController();
    controller.update(1.5); // escalate to step 1
    controller.update(1.5); // escalate to step 2
    const peak = controller.latencyMs;

    const changed = controller.update(0.3); // well below DEESCALATE_TREND_THRESHOLD
    expect(changed).toBe(true);
    expect(controller.latencyMs).toBeLessThan(peak);
  });

  it('never de-escalates below the ladder floor', () => {
    const controller = new AdaptiveLatencyController();
    for (let i = 0; i < 10; i++) {
      controller.update(0.1);
    }
    expect(controller.latencyMs).toBe(MIN_LATENCY_MS);
  });

  it('hysteresis: a trend between the de-escalate and escalate thresholds changes nothing (no flapping)', () => {
    const controller = new AdaptiveLatencyController();
    controller.update(1.5); // escalate once
    const level = controller.latencyMs;

    // A trend sitting comfortably inside the hysteresis band...
    const midBand = (ESCALATE_TREND_THRESHOLD + DEESCALATE_TREND_THRESHOLD) / 2;
    const changed = controller.update(midBand);

    expect(changed).toBe(false);
    expect(controller.latencyMs).toBe(level);
  });

  it('a trend oscillating just around 1.0 (inside the hysteresis band) does not flap between levels', () => {
    const controller = new AdaptiveLatencyController();
    controller.update(1.5); // escalate to step 1
    const level = controller.latencyMs;

    // Oscillate between values that are each individually inside the band.
    for (const trend of [0.9, 0.95, 0.85, 0.9]) {
      controller.update(trend);
      expect(controller.latencyMs).toBe(level); // never moves
    }
  });
});

describe('BackpressureTracker (test scenario 4: RTF>1 grows the backlog, never a drop path)', () => {
  it('backlog grows while processing falls behind real time (RTF > 1)', () => {
    const tracker = new BackpressureTracker();
    expect(tracker.backlogMs).toBe(0);
    expect(tracker.underLoad).toBe(false);

    tracker.observe(300, 200); // 100ms deficit
    expect(tracker.backlogMs).toBe(100);
    expect(tracker.underLoad).toBe(true);

    tracker.observe(400, 200); // +200ms deficit
    expect(tracker.backlogMs).toBe(300);
  });

  it('backlog shrinks once processing is faster than real time again, floored at 0 (never negative)', () => {
    const tracker = new BackpressureTracker();
    tracker.observe(400, 200); // backlog 200
    tracker.observe(50, 200); // -150ms surplus
    expect(tracker.backlogMs).toBe(50);

    tracker.observe(50, 200); // another -150ms surplus, would go negative
    expect(tracker.backlogMs).toBe(0); // floored, not negative
    expect(tracker.underLoad).toBe(false);
  });

  it('has no drop/discard method — sustained overload only ever grows the indicator, never signals a loss', () => {
    const tracker = new BackpressureTracker();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((tracker as any).drop).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((tracker as any).discard).toBeUndefined();

    let backlog = 0;
    for (let i = 0; i < 50; i++) {
      tracker.observe(500, 200); // sustained 300ms/chunk deficit
      expect(tracker.backlogMs).toBeGreaterThanOrEqual(backlog); // monotonically non-decreasing under sustained overload
      backlog = tracker.backlogMs;
    }
    expect(tracker.backlogMs).toBe(50 * 300);
  });
});

describe('RtfMonitor (composition: one entry point per processed chunk)', () => {
  it('observeChunk returns a consistent snapshot of rtf/trend/latency/backlog', () => {
    const monitor = new RtfMonitor({ trendWindow: 3 });

    const snapshot = monitor.observeChunk(200, 200); // exactly real-time
    expect(snapshot.rtf).toBe(1);
    expect(snapshot.trend).toBe(1);
    expect(snapshot.latencyMs).toBe(MIN_LATENCY_MS); // trend not > 1.0, no escalation
    expect(snapshot.backlogMs).toBe(0);
    expect(snapshot.underLoad).toBe(false);
  });

  it('sustained overload escalates latency and grows backlog together, capped at 2.4s', () => {
    const monitor = new RtfMonitor({ trendWindow: 3 });
    let last = monitor.observeChunk(600, 200); // RTF 3.0, badly behind

    for (let i = 0; i < 20; i++) {
      last = monitor.observeChunk(600, 200);
    }

    expect(last.trend).toBeGreaterThan(ESCALATE_TREND_THRESHOLD);
    expect(last.latencyMs).toBe(MAX_LATENCY_MS);
    expect(last.latencyMs).toBeLessThanOrEqual(MAX_LATENCY_MS);
    expect(last.backlogMs).toBeGreaterThan(0);
    expect(last.underLoad).toBe(true);
  });

  it('recovery: once chunks are fast again, latency de-escalates and backlog drains back toward 0', () => {
    const monitor = new RtfMonitor({ trendWindow: 3 });
    for (let i = 0; i < 10; i++) monitor.observeChunk(600, 200); // build up overload
    const overloaded = monitor.observeChunk(600, 200);
    expect(overloaded.latencyMs).toBeGreaterThan(MIN_LATENCY_MS);

    let recovered = overloaded;
    for (let i = 0; i < 40; i++) {
      recovered = monitor.observeChunk(50, 200); // fast chunks, well under real time
    }

    expect(recovered.latencyMs).toBe(MIN_LATENCY_MS);
    expect(recovered.backlogMs).toBe(0);
    expect(recovered.underLoad).toBe(false);
  });
});
