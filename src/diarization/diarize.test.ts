import { describe, expect, it } from 'vitest';
import { diarize, mergeAdjacentSameSpeaker } from './diarize';
import type { DiarizationEngine, LocalSpeechSegment } from './DiarizationEngine';
import type { SpeakerTurn } from './types';

const SAMPLE_RATE = 16000;

/**
 * A fake engine driven entirely by the test: it returns the given local
 * segments, and embeds a slice by recovering its segment's start time from the
 * subarray's byte offset (`diarize` embeds in length-bucketed batch ORDER, not
 * segment order, so the fake can't rely on call position). No model, no
 * pyannote, no onnxruntime — exactly the substitutability the DiarizationEngine
 * seam promises.
 */
function fakeEngine(
  segments: LocalSpeechSegment[],
  embeddingByStartMs: Map<number, Float32Array>,
): DiarizationEngine & { embedCalls: Float32Array[]; embedBatchSizes: number[] } {
  const embedCalls: Float32Array[] = [];
  const embedBatchSizes: number[] = [];
  const embedOne = (slice: Float32Array): Float32Array => {
    embedCalls.push(slice);
    const startMs = Math.round((slice.byteOffset / Float32Array.BYTES_PER_ELEMENT / SAMPLE_RATE) * 1000);
    return embeddingByStartMs.get(startMs)!;
  };
  return {
    embedCalls,
    embedBatchSizes,
    async load() {},
    async segment() {
      return segments;
    },
    async embed(slice) {
      return embedOne(slice);
    },
    async embedBatch(slices) {
      embedBatchSizes.push(slices.length);
      return slices.map(embedOne);
    },
    dispose() {},
  };
}

const v = (...xs: number[]) => new Float32Array(xs);

describe('diarize (pipeline over a fake engine)', () => {
  it('returns an empty timeline when no speech is detected', async () => {
    const engine = fakeEngine([], new Map());
    const timeline = await diarize(new Float32Array(16000), engine, { clustering: { mode: 'auto', distanceThreshold: 0.5 } });
    expect(timeline).toEqual([]);
  });

  it('clusters segments into speakers and merges adjacent same-speaker turns', async () => {
    // Speaker A at 0-1s and 2-3s, speaker B at 1-2s. Embeddings: A ~ (1,0), B ~ (0,1).
    const segments: LocalSpeechSegment[] = [
      { startMs: 0, endMs: 1000 },
      { startMs: 1000, endMs: 2000 },
      { startMs: 2000, endMs: 3000 },
    ];
    const embeddings = new Map<number, Float32Array>([
      [0, v(1, 0.02)],
      [1000, v(0.01, 1)],
      [2000, v(0.98, 0)],
    ]);
    const engine = fakeEngine(segments, embeddings);
    const timeline = await diarize(new Float32Array(16000 * 3), engine, {
      clustering: { mode: 'auto', distanceThreshold: 0.5 },
    });

    // Two speakers; A and A' are separate turns (B interrupts), so NOT merged.
    expect(timeline).toHaveLength(3);
    expect(timeline[0].speaker).toBe(timeline[2].speaker); // both A
    expect(timeline[0].speaker).not.toBe(timeline[1].speaker); // B differs
    expect(timeline.map((t) => [t.startMs, t.endMs])).toEqual([
      [0, 1000],
      [1000, 2000],
      [2000, 3000],
    ]);
  });

  it('slices the PCM per segment by ms → sample index', async () => {
    const segments: LocalSpeechSegment[] = [{ startMs: 500, endMs: 1500 }];
    const engine = fakeEngine(segments, new Map([[500, v(1, 0)]]));
    const pcm = new Float32Array(16000 * 2);
    await diarize(pcm, engine, { clustering: { mode: 'auto', distanceThreshold: 0.5 } });
    // 500ms..1500ms at 16kHz = samples 8000..24000, clamped to 32000 length → length 16000.
    expect(engine.embedCalls[0].length).toBe(16000);
  });

  it('embeds in length-bucketed batches of the configured size (roadmap 1a)', async () => {
    // Five 1 s segments; batchSize 2 → batches of 2, 2, 1. Every segment is still
    // embedded exactly once and labelled, and the timeline is complete.
    const segments: LocalSpeechSegment[] = Array.from({ length: 5 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 1000 }));
    const embeddings = new Map<number, Float32Array>(segments.map((s) => [s.startMs, v(1, 0)]));
    const engine = fakeEngine(segments, embeddings);
    const timeline = await diarize(new Float32Array(16000 * 5), engine, {
      clustering: { mode: 'auto', distanceThreshold: 0.5 },
      embedBatchSize: 2,
    });

    expect(engine.embedBatchSizes).toEqual([2, 2, 1]);
    expect(engine.embedCalls).toHaveLength(5); // each segment embedded exactly once
    // All one speaker → one merged turn spanning the whole recording.
    expect(timeline).toEqual([{ startMs: 0, endMs: 5000, speaker: 0 }]);
  });

  it('length-buckets so a batch groups near-equal-length segments', async () => {
    // Mixed durations, batchSize 2. Sorted by duration: 500,1000,1500,3000 →
    // batches [500,1000] then [1500,3000]. Assert the fake saw them so grouped.
    const segments: LocalSpeechSegment[] = [
      { startMs: 0, endMs: 3000 }, // 3000ms
      { startMs: 3000, endMs: 3500 }, // 500ms
      { startMs: 4000, endMs: 5500 }, // 1500ms
      { startMs: 6000, endMs: 7000 }, // 1000ms
    ];
    const embeddings = new Map<number, Float32Array>(segments.map((s) => [s.startMs, v(1, 0)]));
    const engine = fakeEngine(segments, embeddings);
    await diarize(new Float32Array(16000 * 8), engine, {
      clustering: { mode: 'auto', distanceThreshold: 0.5 },
      embedBatchSize: 2,
    });
    // First batch = the two shortest (500ms@3000, 1000ms@6000); lengths 8000, 16000.
    expect([engine.embedCalls[0].length, engine.embedCalls[1].length].sort((a, b) => a - b)).toEqual([8000, 16000]);
    // Second batch = the two longest (1500ms@4000, 3000ms@0); lengths 24000, 48000.
    expect([engine.embedCalls[2].length, engine.embedCalls[3].length].sort((a, b) => a - b)).toEqual([24000, 48000]);
  });
});

describe('mergeAdjacentSameSpeaker', () => {
  it('merges consecutive same-speaker turns and keeps timestamps monotonic', () => {
    const turns: SpeakerTurn[] = [
      { startMs: 0, endMs: 1000, speaker: 0 },
      { startMs: 1000, endMs: 2000, speaker: 0 },
      { startMs: 2000, endMs: 2500, speaker: 1 },
    ];
    expect(mergeAdjacentSameSpeaker(turns)).toEqual([
      { startMs: 0, endMs: 2000, speaker: 0 },
      { startMs: 2000, endMs: 2500, speaker: 1 },
    ]);
  });

  it('a single speaker throughout collapses to one turn', () => {
    const turns: SpeakerTurn[] = [
      { startMs: 0, endMs: 1000, speaker: 0 },
      { startMs: 1000, endMs: 2000, speaker: 0 },
    ];
    expect(mergeAdjacentSameSpeaker(turns)).toEqual([{ startMs: 0, endMs: 2000, speaker: 0 }]);
  });
});
