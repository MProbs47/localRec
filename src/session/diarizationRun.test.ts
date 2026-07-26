import { describe, expect, it, vi } from 'vitest';
import { runDiarization, DEFAULT_CLUSTER_THRESHOLD, type DiarizationRunDeps } from './diarizationRun';
import type { TimedTextSegment } from '../diarization/align';
import type { SpeakerTimeline } from '../diarization/types';

const segments: TimedTextSegment[] = [
  { text: 'hallo', startMs: 0, endMs: 1000 },
  { text: 'gut', startMs: 1000, endMs: 2000 },
];

const timeline: SpeakerTimeline = [
  { startMs: 0, endMs: 1000, speaker: 0 },
  { startMs: 1000, endMs: 2000, speaker: 1 },
];

function fakeWorker(overrides: Partial<DiarizationRunDeps['worker']> = {}): DiarizationRunDeps['worker'] {
  return {
    async initialize() {},
    async diarizeAudio() {
      return timeline;
    },
    ...overrides,
  };
}

describe('runDiarization', () => {
  it('decodes (when given audio) → initializes → diarizes → aligns the transcript', async () => {
    const decode = vi.fn(async () => new Float32Array(32000));
    const diarizeAudio = vi.fn(async () => timeline);
    const result = await runDiarization(
      { audio: new Blob(), segments },
      { worker: fakeWorker({ diarizeAudio }), decode },
    );

    expect(decode).toHaveBeenCalledOnce();
    expect(diarizeAudio).toHaveBeenCalledOnce();
    expect(result.diarized).toBe(true);
    expect(result.aligned).toEqual([
      { text: 'hallo', startMs: 0, endMs: 1000, speaker: 0 },
      { text: 'gut', startMs: 1000, endMs: 2000, speaker: 1 },
    ]);
  });

  it('uses the provided pcm without decoding (import path)', async () => {
    const decode = vi.fn();
    const result = await runDiarization({ pcm: new Float32Array(32000), segments }, { worker: fakeWorker(), decode });
    expect(decode).not.toHaveBeenCalled();
    expect(result.diarized).toBe(true);
  });

  // No `min_cluster_size`: it absorbed a real minority speaker (hardware
  // test 01) — see the regression lock in `clustering.test.ts`.
  it('passes the default auto threshold (and no min_cluster_size) when no clustering is specified', async () => {
    const diarizeAudio = vi.fn(async (_pcm: Float32Array, _options: unknown) => timeline);
    await runDiarization({ pcm: new Float32Array(16000), segments }, { worker: fakeWorker({ diarizeAudio }) });
    expect(diarizeAudio.mock.calls[0][1]).toEqual({
      clustering: { mode: 'auto', distanceThreshold: DEFAULT_CLUSTER_THRESHOLD },
      knownSpeakerCount: undefined,
    });
  });

  it('forwards the user-stated speaker count (round 5)', async () => {
    const diarizeAudio = vi.fn(async (_pcm: Float32Array, _options: unknown) => timeline);
    await runDiarization(
      { pcm: new Float32Array(16000), segments, knownSpeakerCount: 2 },
      { worker: fakeWorker({ diarizeAudio }) },
    );
    expect(diarizeAudio.mock.calls[0][1]).toMatchObject({ knownSpeakerCount: 2 });
  });

  it('reports model-download progress', async () => {
    const ticks: number[] = [];
    await runDiarization(
      { pcm: new Float32Array(16000), segments },
      { worker: fakeWorker({ async initialize(onProgress) { onProgress(0.5); onProgress(1); } }) },
      (f) => ticks.push(f),
    );
    expect(ticks).toEqual([0.5, 1]);
  });

  it('SD-3: a worker failure falls back to the plain transcript (speaker null), never throws', async () => {
    const boom = new Error('model missing');
    const result = await runDiarization(
      { pcm: new Float32Array(16000), segments },
      { worker: fakeWorker({ async diarizeAudio() { throw boom; } }) },
    );
    expect(result.diarized).toBe(false);
    expect(result.error).toBe(boom);
    expect(result.timeline).toEqual([]);
    expect(result.aligned.every((s) => s.speaker === null)).toBe(true);
    // The transcript text/timestamps are still intact.
    expect(result.aligned.map((s) => s.text)).toEqual(['hallo', 'gut']);
  });

  it('SD-3: missing both pcm and decode falls back gracefully', async () => {
    const result = await runDiarization({ audio: new Blob(), segments }, { worker: fakeWorker() });
    expect(result.diarized).toBe(false);
    expect(result.aligned.every((s) => s.speaker === null)).toBe(true);
  });
});
