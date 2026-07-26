/**
 * U4 (refactor plan 002) — tests for the pseudo-live block driver. Everything
 * here is exercised headlessly against injected fakes (`transcribe`,
 * `emitBlock`, `setIntervalImpl`): the fake `setIntervalImpl` captures the
 * SAME callback `LiveBlockDriver.start()` schedules (mirroring
 * `recordingCoordinator.test.ts`'s heartbeat-capture pattern), so a test
 * "fires a tick" by calling that captured function directly and can `await`
 * it to deterministically observe one full transcribe->commit->emit->prune
 * cycle — no real timers, no GPU, no worker (see `liveBlockDriver.ts`'s
 * header comment for the Realitäts-Grenze).
 */
import { describe, expect, it } from 'vitest';
import {
  LiveBlockDriver,
  offsetSegments,
  commitSegments,
  pruneBuffer,
  type LiveBlockDriverDeps,
} from './liveBlockDriver';
import type { TranscriptSegment } from '../worker/model/transcriptionEngine';
import type { FinalSegment } from './recordingCoordinator';

// --- Shared fakes/helpers ----------------------------------------------------

function makePcm(length: number): Float32Array {
  const pcm = new Float32Array(length);
  for (let i = 0; i < length; i++) pcm[i] = i;
  return pcm;
}

/** A fake "Whisper": splits whatever window it is handed into fixed-size local segments, so driver-level coverage/offset behavior can be verified without any real model. */
function makeSegmentingTranscribe(segmentMs: number) {
  return async (pcm: Float32Array): Promise<TranscriptSegment[]> => {
    const segments: TranscriptSegment[] = [];
    for (let start = 0; start < pcm.length; start += segmentMs) {
      const end = Math.min(start + segmentMs, pcm.length);
      segments.push({ text: `seg${start}-${end}`, startMs: start, endMs: end });
    }
    return segments;
  };
}

/** A fake "Whisper" that returns one scripted response per call (by call order), repeating the last one if called more times than scripted — for hand-crafted overlap scenarios. */
function scriptedTranscribe(responses: TranscriptSegment[][]) {
  let call = 0;
  return async (): Promise<TranscriptSegment[]> => {
    const response = responses[Math.min(call, responses.length - 1)];
    call++;
    return response;
  };
}

/**
 * Builds a `LiveBlockDriver` wired to in-memory fakes: `ticks[0]` is the
 * exact callback the driver registered via `setIntervalImpl` — calling (and
 * `await`ing) it fires one scheduler tick deterministically, matching
 * `recordingCoordinator.test.ts`'s `heartbeats[0]()` pattern. `blocks`
 * collects every `emitBlock` call in order; `transcribeCalls` records every
 * pcm buffer handed to `transcribe`, for tests that need to inspect exactly
 * what window was sent (e.g. the backpressure scenario).
 */
function makeHarness(
  overrides: Partial<Pick<LiveBlockDriverDeps, 'windowMs' | 'overlapMs' | 'sampleRate'>> & {
    transcribe?: (pcm: Float32Array) => Promise<TranscriptSegment[]>;
  } = {},
) {
  const ticks: Array<() => void> = [];
  const blocks: FinalSegment[] = [];
  const transcribeCalls: Float32Array[] = [];
  const transcribeImpl = overrides.transcribe ?? (async () => []);

  const driver = new LiveBlockDriver({
    transcribe: async (pcm) => {
      transcribeCalls.push(pcm);
      return transcribeImpl(pcm);
    },
    emitBlock: (block) => blocks.push(block),
    sampleRate: overrides.sampleRate,
    windowMs: overrides.windowMs,
    overlapMs: overrides.overlapMs,
    setIntervalImpl: (fn) => {
      ticks.push(fn);
      return ticks.length;
    },
    clearIntervalImpl: () => {},
  });

  return { driver, ticks, blocks, transcribeCalls };
}

// --- Pure helpers ------------------------------------------------------------

describe('offsetSegments', () => {
  it('adds windowStartMs to every segment start/end, preserving order and text', () => {
    const local: TranscriptSegment[] = [
      { text: 'a', startMs: 0, endMs: 500 },
      { text: 'b', startMs: 500, endMs: 900 },
    ];

    expect(offsetSegments(local, 3000)).toEqual([
      { text: 'a', startMs: 3000, endMs: 3500 },
      { text: 'b', startMs: 3500, endMs: 3900 },
    ]);
  });

  it('returns [] for an empty input, unchanged', () => {
    expect(offsetSegments([], 1000)).toEqual([]);
  });

  it('is a no-op offset for windowStartMs = 0', () => {
    const local: TranscriptSegment[] = [{ text: 'a', startMs: 10, endMs: 20 }];
    expect(offsetSegments(local, 0)).toEqual(local);
  });
});

describe('commitSegments', () => {
  it('keeps everything and advances to the max endMs when the whole window is new', () => {
    const global: TranscriptSegment[] = [
      { text: 'a', startMs: 1000, endMs: 1500 },
      { text: 'b', startMs: 1500, endMs: 2200 },
    ];

    const result = commitSegments(global, 0);

    expect(result.blocks).toEqual([
      { text: 'a', startMs: 1000, endMs: 1500 },
      { text: 'b', startMs: 1500, endMs: 2200 },
    ]);
    expect(result.committedUntilMs).toBe(2200);
  });

  it('drops every segment whose midpoint falls before committedUntilMs and leaves the boundary unchanged', () => {
    const global: TranscriptSegment[] = [
      { text: 'old1', startMs: 0, endMs: 400 }, // midpoint 200 < 1000
      { text: 'old2', startMs: 400, endMs: 900 }, // midpoint 650 < 1000
    ];

    const result = commitSegments(global, 1000);

    expect(result.blocks).toEqual([]);
    expect(result.committedUntilMs).toBe(1000); // unchanged: nothing kept to advance past
  });

  it('keeps a segment whose midpoint lands exactly on committedUntilMs (boundary is inclusive)', () => {
    const global: TranscriptSegment[] = [{ text: 'edge', startMs: 900, endMs: 1100 }]; // midpoint exactly 1000

    const result = commitSegments(global, 1000);

    expect(result.blocks).toEqual([{ text: 'edge', startMs: 900, endMs: 1100 }]);
    expect(result.committedUntilMs).toBe(1100);
  });

  it('partially dedups: drops the overlap-region segment, keeps the new one, advances only to the kept max', () => {
    const global: TranscriptSegment[] = [
      { text: 'duplicate-of-earlier', startMs: 500, endMs: 1000 }, // midpoint 750 < 1000 -> drop
      { text: 'new', startMs: 1000, endMs: 1500 }, // midpoint 1250 >= 1000 -> keep
    ];

    const result = commitSegments(global, 1000);

    expect(result.blocks).toEqual([{ text: 'new', startMs: 1000, endMs: 1500 }]);
    expect(result.committedUntilMs).toBe(1500);
  });

  it('returns [] and an unchanged boundary for empty input', () => {
    const result = commitSegments([], 4200);
    expect(result.blocks).toEqual([]);
    expect(result.committedUntilMs).toBe(4200);
  });
});

describe('pruneBuffer', () => {
  it('returns the buffer unchanged when keepFromMs is at/before bufferStartMs', () => {
    const pcm = makePcm(1000);
    expect(pruneBuffer(pcm, 1000, 500, 1000)).toEqual({ pcm, bufferStartMs: 1000 });
    expect(pruneBuffer(pcm, 1000, 1000, 1000)).toEqual({ pcm, bufferStartMs: 1000 });
  });

  it('drops exactly the leading samples older than keepFromMs and advances bufferStartMs to keepFromMs', () => {
    const pcm = makePcm(5000); // 5000 samples at rate 1000 == 5000ms
    const result = pruneBuffer(pcm, 0, 2000, 1000);

    expect(result.bufferStartMs).toBe(2000);
    expect(result.pcm.length).toBe(3000);
    expect(result.pcm).toEqual(pcm.slice(2000));
  });

  it('clamps the drop to the whole buffer when keepFromMs is past the end of the buffer', () => {
    const pcm = makePcm(1000); // 1000ms of content starting at bufferStartMs=0
    const result = pruneBuffer(pcm, 0, 5000, 1000); // asked to keep from far beyond what exists

    expect(result.pcm.length).toBe(0);
    expect(result.bufferStartMs).toBe(5000);
  });

  it('respects a non-1000 sample rate in the ms<->sample conversion', () => {
    const pcm = makePcm(16000); // 1s at 16kHz
    const result = pruneBuffer(pcm, 0, 500, 16000); // drop the first 500ms

    expect(result.pcm.length).toBe(8000);
    expect(result.bufferStartMs).toBe(500);
  });
});

// --- LiveBlockDriver integration (pure logic, fake timers/transcribe) --------

describe('LiveBlockDriver window coverage', () => {
  it('covers accumulated audio across ticks with no gap and no overlap in emitted blocks', async () => {
    const { driver, ticks, blocks } = makeHarness({
      windowMs: 2000,
      overlapMs: 500,
      sampleRate: 1000, // 1 sample == 1ms, for easy hand-verified arithmetic
      transcribe: makeSegmentingTranscribe(500),
    });

    driver.start();
    driver.pushAudio(makePcm(2000));
    await ticks[0]();
    driver.pushAudio(makePcm(2000));
    await ticks[0]();

    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0].startMs).toBe(0);
    for (let i = 1; i < blocks.length; i++) {
      // No gap AND no overlap: the next block starts exactly where the last one ended.
      expect(blocks[i].startMs).toBe(blocks[i - 1].endMs);
    }
    expect(blocks[blocks.length - 1].endMs).toBe(4000);
  });
});

describe('LiveBlockDriver overlap dedup', () => {
  it('emits a boundary segment re-transcribed in the next (overlapping) window exactly once', async () => {
    const { driver, ticks, blocks } = makeHarness({
      windowMs: 1000,
      overlapMs: 500,
      sampleRate: 1000,
      transcribe: scriptedTranscribe([
        // Window 1 (local, windowStartMs=0): "B" is cut right at the window edge.
        [
          { text: 'A', startMs: 0, endMs: 400 },
          { text: 'B', startMs: 400, endMs: 1000 },
        ],
        // Window 2 (local, windowStartMs=500 after overlap-pruning): re-transcribes
        // the same audio "B" covered (now local [0,500], global [500,1000]) as "B2",
        // plus genuinely new content "C".
        [
          { text: 'B2', startMs: 0, endMs: 500 },
          { text: 'C', startMs: 500, endMs: 1000 },
        ],
      ]),
    });

    driver.start();
    driver.pushAudio(makePcm(1000));
    await ticks[0]();
    driver.pushAudio(makePcm(500));
    await ticks[0]();

    expect(blocks.map((b) => b.text)).toEqual(['A', 'B', 'C']);
    expect(blocks.some((b) => b.text === 'B2')).toBe(false);
    expect(blocks[2]).toEqual({ text: 'C', startMs: 1000, endMs: 1500 });
  });
});

describe('LiveBlockDriver timestamp offset + monotonicity', () => {
  it('computes block timestamps as windowStartMs + local timestamp and keeps them monotonic across ticks', async () => {
    const { driver, ticks, blocks } = makeHarness({
      windowMs: 1500,
      overlapMs: 500,
      sampleRate: 1000,
      transcribe: makeSegmentingTranscribe(750),
    });

    driver.start();
    driver.pushAudio(makePcm(1500));
    await ticks[0]();
    driver.pushAudio(makePcm(1500));
    await ticks[0]();
    driver.pushAudio(makePcm(1500));
    await ticks[0]();

    expect(blocks.length).toBeGreaterThan(0);
    // First window starts at windowStartMs=0, so local ts == global ts for the very first block.
    expect(blocks[0]).toEqual({ text: 'seg0-750', startMs: 0, endMs: 750 });
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].startMs).toBeGreaterThanOrEqual(blocks[i - 1].startMs);
    }
  });
});

describe('LiveBlockDriver short run / final flush', () => {
  it('does not transcribe on a regular tick before a full window has accumulated', async () => {
    const { driver, ticks, blocks, transcribeCalls } = makeHarness({
      windowMs: 5000,
      overlapMs: 1000,
      sampleRate: 1000,
      transcribe: async (pcm) => [{ text: 'short', startMs: 0, endMs: pcm.length }],
    });

    driver.start();
    driver.pushAudio(makePcm(1200)); // well under windowMs
    await ticks[0]();

    expect(blocks).toEqual([]);
    expect(transcribeCalls).toEqual([]);
  });

  it('flushes trailing audio shorter than one window into exactly one block on stop()', async () => {
    const { driver, ticks, blocks } = makeHarness({
      windowMs: 5000,
      overlapMs: 1000,
      sampleRate: 1000,
      transcribe: async (pcm) => [{ text: 'short', startMs: 0, endMs: pcm.length }],
    });

    driver.start();
    driver.pushAudio(makePcm(1200));
    await ticks[0](); // regular tick: too little audio, no-op (see test above)

    await driver.stop();

    expect(blocks).toEqual([{ text: 'short', startMs: 0, endMs: 1200 }]);
  });

  it('is a no-op to stop() twice', async () => {
    const { driver } = makeHarness({ transcribe: async () => [] });
    driver.start();
    await driver.stop();
    await expect(driver.stop()).resolves.toBeUndefined();
  });
});

describe('LiveBlockDriver backpressure (RTF > 1)', () => {
  it('runs only one transcribe at a time and never drops audio pushed while one is in flight', async () => {
    let resolveCurrent: ((segments: TranscriptSegment[]) => void) | null = null;
    let transcribeCallCount = 0;
    const pcmLengths: number[] = [];
    const slowTranscribe = (pcm: Float32Array): Promise<TranscriptSegment[]> => {
      transcribeCallCount++;
      pcmLengths.push(pcm.length);
      return new Promise((resolve) => {
        resolveCurrent = resolve;
      });
    };

    const { driver, ticks, blocks } = makeHarness({
      windowMs: 1000,
      overlapMs: 0,
      sampleRate: 1000,
      transcribe: slowTranscribe,
    });

    driver.start();
    driver.pushAudio(makePcm(1000)); // exactly one window's worth

    // Fires the tick that starts the (never-resolving-yet) first transcribe.
    const firstTickPromise = ticks[0]();
    expect(transcribeCallCount).toBe(1);

    // Several more scheduler ticks fire while the first transcribe is still in
    // flight — natural backpressure means NONE of them should start a second
    // transcribe; they must all return immediately.
    await ticks[0]();
    await ticks[0]();
    await ticks[0]();
    expect(transcribeCallCount).toBe(1);

    // Audio arriving from the mic while the engine is busy must not be lost.
    driver.pushAudio(makePcm(2000));

    // Let the first transcribe finish.
    resolveCurrent!([{ text: 'first', startMs: 0, endMs: 1000 }]);
    await firstTickPromise;

    expect(blocks).toEqual([{ text: 'first', startMs: 0, endMs: 1000 }]);
    expect(transcribeCallCount).toBe(1);

    // The next tick must pick up exactly the audio pushed mid-flight — none
    // of it was dropped by the in-flight transcribe or the subsequent prune.
    const secondTickPromise = ticks[0]();
    expect(transcribeCallCount).toBe(2);
    expect(pcmLengths[1]).toBe(2000);

    resolveCurrent!([]); // unblock so the test doesn't hang on a dangling promise
    await secondTickPromise;
  });
});

describe('LiveBlockDriver durability & bounds (U4)', () => {
  it('surfaces a transcribe failure via onError and keeps ticking, not an unhandled rejection (#3)', async () => {
    const ticks: Array<() => unknown> = [];
    const emitted: FinalSegment[] = [];
    const errors: unknown[] = [];
    let call = 0;
    const driver = new LiveBlockDriver({
      transcribe: async () => {
        call++;
        if (call === 1) throw new Error('engine exploded');
        return [{ text: 'RECOVERED', startMs: 0, endMs: 50 }];
      },
      emitBlock: (b) => emitted.push(b),
      onError: (e) => errors.push(e),
      sampleRate: 1000,
      windowMs: 100,
      overlapMs: 20,
      setIntervalImpl: (fn) => {
        ticks.push(fn);
        return ticks.length;
      },
      clearIntervalImpl: () => {},
    });

    driver.start();
    driver.pushAudio(makePcm(100));
    await ticks[0](); // must NOT reject — the failure is caught inside #runCycle
    expect(errors).toHaveLength(1);

    driver.pushAudio(makePcm(100));
    await ticks[0]();
    expect(emitted.map((b) => b.text)).toContain('RECOVERED'); // the driver kept working
  });

  it('bounds the pending window under sustained silence — no commit ever prunes (#2)', async () => {
    const ticks: Array<() => unknown> = [];
    const windowLengths: number[] = [];
    const driver = new LiveBlockDriver({
      transcribe: async (pcm) => {
        windowLengths.push(pcm.length);
        return []; // silence: no segments, so the overlap-prune never advances
      },
      emitBlock: () => {},
      sampleRate: 1000,
      windowMs: 100,
      overlapMs: 20,
      maxBufferMs: 200, // hard cap under test
      setIntervalImpl: (fn) => {
        ticks.push(fn);
        return ticks.length;
      },
      clearIntervalImpl: () => {},
    });

    driver.start();
    for (let i = 0; i < 20; i++) {
      driver.pushAudio(makePcm(50)); // 1000ms of audio in total
      await ticks[0]();
    }

    // Without the cap the transcribed window grows unbounded (~1000 samples);
    // the cap holds every window handed to transcribe at or under maxBufferMs.
    expect(Math.max(...windowLengths)).toBeLessThanOrEqual(200);
  });
});
