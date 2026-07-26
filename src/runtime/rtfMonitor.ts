/**
 * U7 (R14, KTD11): the app's only thermal telemetry. On a sustained
 * transcription session an iGPU laptop can throttle over time (see the
 * plan's "4h-Bruchstellen" risk list) — instead of trying to read real
 * thermal sensors (not available from a browser), this measures the one
 * signal that actually matters: **RTF** (real-time factor) = how long a
 * chunk took to process, divided by how much audio it represents. RTF > 1
 * means processing has fallen behind real time.
 *
 * Three pure, composable pieces (mirrors `segmentation.ts`'s
 * clock/VAD/loop-detector-then-controller shape):
 *
 *  1. **`computeRtf`/`RtfTrendTracker`** — the raw ratio, plus a moving
 *     average over the last `trendWindow` chunks so one slow chunk (a GC
 *     pause, a stalled shader compile) doesn't itself trip escalation —
 *     only a sustained trend does.
 *  2. **`AdaptiveLatencyController`** — a stepwise state machine over a
 *     fixed latency ladder (80 ms .. 2400 ms, doubling). Escalates one
 *     step at a time while the trend is behind real time, de-escalates one
 *     step at a time once the trend recovers — with a hysteresis gap
 *     between the escalate/de-escalate thresholds so a trend hovering
 *     right around 1.0 doesn't flap between two levels every chunk. Never
 *     exceeds `MAX_LATENCY_MS` (2.4 s) — the ladder itself has no step
 *     past it.
 *  3. **`BackpressureTracker`** — KTD11's "nie still verwerfen" guarantee
 *     modeled as a pure indicator: while RTF > 1 (this chunk took longer to
 *     process than the audio it covers), the backlog indicator grows by
 *     the deficit; once processing catches back up (RTF < 1) it shrinks
 *     again, floored at 0. There is deliberately no "drop" method
 *     anywhere in this file — growing the indicator is the only state
 *     transition available under sustained overload, which is the point.
 *
 * `RtfMonitor` composes all three into the one entry point the worker
 * calls per processed chunk.
 *
 * **Andockpunkte (not wired in this unit — see this unit's report):**
 *  - *RTF measurement source:* `transcription.worker.ts`'s `feedAudio()`/
 *    the `ModelEngine.feed()` call is where a real `processingMs` (wall
 *    time around that call) and `audioMs` (chunk sample count / 16000 *
 *    1000, the same math as `segmentation.ts`'s `GlobalClock`) would be
 *    measured and passed into `RtfMonitor.observeChunk()`.
 *  - *Adaptive latency -> feed cadence:* `App.tsx`'s
 *    `AUDIO_FEED_INTERVAL_MS`/the ring-buffer read-window size is where
 *    `RtfMonitor`'s current `latencyMs` would replace the fixed 200 ms
 *    constant once wired — a higher `latencyMs` means larger, less
 *    frequent reads (bigger chunks, lower update rate), trading
 *    responsiveness for headroom.
 *  - *Backlog -> ring buffer/OPFS:* `RingBuffer` (`src/audio/ringBuffer.ts`,
 *    U3) or `OpfsAudioAppender` (`src/storage/opfsAudio.ts`, U6) is where a
 *    growing `backlogMs`/`underLoad` would actually change buffering
 *    behavior (e.g. widen the ring buffer's effective read window, or
 *    prioritize flushing to OPFS) — this file only tracks the indicator,
 *    never touches either.
 *  - *UI surface:* `underLoad` is the "Gerät unter Last" flag U12 would
 *    read to show the user-facing hint; no UI lives here (per plan).
 */

/** Real-time factor for one chunk: how long it took to process divided by how much audio it represents. `audioMs <= 0` returns 0 rather than `Infinity`/`NaN` — a chunk with no audio duration carries no meaningful ratio. */
export function computeRtf(processingMs: number, audioMs: number): number {
  if (audioMs <= 0) return 0;
  return processingMs / audioMs;
}

/** Number of trailing chunks averaged into the trend. Small enough to react within a few chunks (~a couple of seconds at the 200 ms feed cadence), large enough that one anomalous chunk can't trip escalation by itself. */
export const DEFAULT_TREND_WINDOW = 5;

/**
 * Moving average of RTF over the last `windowSize` observed chunks — the
 * "trend" KTD11 escalates/de-escalates on, as opposed to any single
 * chunk's raw RTF.
 */
export class RtfTrendTracker {
  readonly #windowSize: number;
  #samples: number[] = [];

  constructor(windowSize: number = DEFAULT_TREND_WINDOW) {
    if (!Number.isInteger(windowSize) || windowSize <= 0) {
      throw new RangeError('windowSize must be a positive integer');
    }
    this.#windowSize = windowSize;
  }

  /** Records one chunk's RTF and returns the updated trend (moving average). */
  observe(rtf: number): number {
    this.#samples.push(rtf);
    if (this.#samples.length > this.#windowSize) {
      this.#samples.shift();
    }
    return this.trend;
  }

  /** Current moving average; 0 before any chunk has been observed (no data, not "caught up"). */
  get trend(): number {
    if (this.#samples.length === 0) return 0;
    const sum = this.#samples.reduce((total, value) => total + value, 0);
    return sum / this.#samples.length;
  }
}

/** Floor of the adaptive-latency ladder — the plan's "80 ms" baseline update cadence when processing is comfortably ahead of real time. */
export const MIN_LATENCY_MS = 80;
/** Hard ceiling of the adaptive-latency ladder (KTD11: "max 2.4 s" — never exceeded, no step in the ladder goes past this). */
export const MAX_LATENCY_MS = 2400;

/**
 * The latency ladder itself: doubling steps from `MIN_LATENCY_MS`, capped
 * at `MAX_LATENCY_MS` (the last step lands exactly on the cap rather than
 * overshooting it). `AdaptiveLatencyController` only ever moves one index
 * at a time along this array.
 */
export const LATENCY_LADDER_MS: readonly number[] = buildLatencyLadder();

function buildLatencyLadder(): number[] {
  const ladder: number[] = [];
  let value = MIN_LATENCY_MS;
  while (value < MAX_LATENCY_MS) {
    ladder.push(value);
    value = Math.min(value * 2, MAX_LATENCY_MS);
  }
  ladder.push(MAX_LATENCY_MS);
  return ladder;
}

/** Trend above which the controller escalates (one step) — KTD11's "> 1.0" (behind real time). */
export const ESCALATE_TREND_THRESHOLD = 1.0;
/**
 * Trend below which the controller de-escalates (one step). Deliberately
 * below `ESCALATE_TREND_THRESHOLD`, not equal to it — the gap is the
 * hysteresis band: a trend sitting at, say, 0.95 stays put instead of
 * ping-ponging between two adjacent steps every chunk.
 */
export const DEESCALATE_TREND_THRESHOLD = 0.8;

/**
 * Stepwise state machine over `LATENCY_LADDER_MS`. Escalates one step per
 * `update()` call while the trend is behind real time, de-escalates one
 * step per call once the trend has recovered past the (lower) hysteresis
 * threshold. Starts at the minimum (index 0) — a fresh session assumes no
 * load until the trend says otherwise.
 */
export class AdaptiveLatencyController {
  #stepIndex = 0;

  /** Current adaptive latency in ms — always one of `LATENCY_LADDER_MS`'s values, therefore never exceeds `MAX_LATENCY_MS`. */
  get latencyMs(): number {
    return LATENCY_LADDER_MS[this.#stepIndex];
  }

  /** Current index into `LATENCY_LADDER_MS`, mainly for tests/inspection. */
  get stepIndex(): number {
    return this.#stepIndex;
  }

  /**
   * Feeds the current trend, moving at most one step in one direction.
   * Returns `true` if the level changed. Escalation takes priority over
   * de-escalation in a single call (moot in practice since the two
   * thresholds never overlap, but keeps the intent explicit).
   */
  update(trend: number): boolean {
    if (trend > ESCALATE_TREND_THRESHOLD && this.#stepIndex < LATENCY_LADDER_MS.length - 1) {
      this.#stepIndex++;
      return true;
    }
    if (trend < DEESCALATE_TREND_THRESHOLD && this.#stepIndex > 0) {
      this.#stepIndex--;
      return true;
    }
    return false;
  }
}

/**
 * KTD11's "nie still verwerfen" guarantee as a pure indicator. Tracks a
 * cumulative backlog in milliseconds of audio-equivalent processing debt:
 * grows by the per-chunk deficit while a chunk takes longer to process
 * than the audio it represents (RTF > 1), shrinks back down (floored at 0,
 * never negative) once processing is faster than real time again. This
 * class only ever grows or shrinks the number — there is intentionally no
 * "drop"/"discard" method anywhere on it; the actual audio bytes stay
 * exactly where U3's `RingBuffer`/U6's `OpfsAudioAppender` already put
 * them (see this file's header Andockpunkt note).
 */
export class BackpressureTracker {
  #backlogMs = 0;

  /** Cumulative backlog in ms; 0 means fully caught up to real time. */
  get backlogMs(): number {
    return this.#backlogMs;
  }

  /** Convenience flag for "Gerät unter Last" (U12 reads this, not built here) — true whenever any backlog has accumulated. */
  get underLoad(): boolean {
    return this.#backlogMs > 0;
  }

  /** Records one chunk's processing/audio duration, growing or shrinking the backlog by the deficit/surplus. */
  observe(processingMs: number, audioMs: number): void {
    const deficitMs = processingMs - audioMs;
    this.#backlogMs = Math.max(0, this.#backlogMs + deficitMs);
  }
}

export interface RtfMonitorOptions {
  /** Overrides `DEFAULT_TREND_WINDOW`, mainly for tests/tuning. */
  trendWindow?: number;
}

/** One chunk's full evaluation, returned by `RtfMonitor.observeChunk()` — everything a caller needs without reaching into the monitor's internals. */
export interface RtfSnapshot {
  /** This chunk's raw RTF (not the trend). */
  rtf: number;
  /** Moving-average trend after including this chunk. */
  trend: number;
  /** Current adaptive latency (ms) after this chunk's escalation/de-escalation step, if any. */
  latencyMs: number;
  /** Cumulative backpressure backlog (ms) after this chunk. */
  backlogMs: number;
  /** Convenience flag mirroring `backlogMs > 0`. */
  underLoad: boolean;
}

/**
 * Composes `RtfTrendTracker` + `AdaptiveLatencyController` +
 * `BackpressureTracker` into the single entry point a caller (eventually
 * `transcription.worker.ts`, see this file's header) feeds per processed
 * chunk. No GPU/timer access — every input is a plain millisecond value
 * the caller measured, so this is deterministic and fully testable.
 */
export class RtfMonitor {
  readonly #trendTracker: RtfTrendTracker;
  readonly #latencyController = new AdaptiveLatencyController();
  readonly #backpressure = new BackpressureTracker();

  constructor(options: RtfMonitorOptions = {}) {
    this.#trendTracker = new RtfTrendTracker(options.trendWindow);
  }

  /**
   * Records one processed chunk's processing wall-time and the audio
   * duration it represents, updates the trend/latency/backlog state, and
   * returns the resulting snapshot.
   */
  observeChunk(processingMs: number, audioMs: number): RtfSnapshot {
    const rtf = computeRtf(processingMs, audioMs);
    const trend = this.#trendTracker.observe(rtf);
    this.#latencyController.update(trend);
    this.#backpressure.observe(processingMs, audioMs);

    return {
      rtf,
      trend,
      latencyMs: this.#latencyController.latencyMs,
      backlogMs: this.#backpressure.backlogMs,
      underLoad: this.#backpressure.underLoad,
    };
  }
}
