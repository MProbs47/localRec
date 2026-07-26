import { describe, expect, it } from 'vitest';
import { PyannoteWeSpeakerEngine, type DiarizationModelLoaders } from './pyannoteWeSpeakerEngine';
import type { EmbedderLike } from './embedding';

const fakeEmbedder: EmbedderLike = {
  async embed() {
    return new Float32Array([1, 0]);
  },
  async embedBatch(segments) {
    return segments.map(() => new Float32Array([1, 0]));
  },
};

function fakeLoaders(overrides: Partial<DiarizationModelLoaders> = {}): DiarizationModelLoaders {
  return {
    async loadSegmentation(onFileProgress) {
      onFileProgress(1);
      return async () => [{ start: 0, end: 1 }];
    },
    async loadEmbedder(onFileProgress) {
      onFileProgress(1);
      return fakeEmbedder;
    },
    ...overrides,
  };
}

describe('PyannoteWeSpeakerEngine', () => {
  it('reports monotonic progress that reaches 1 after both models load', async () => {
    const engine = new PyannoteWeSpeakerEngine(fakeLoaders());
    const ticks: number[] = [];
    await engine.load((f) => ticks.push(f));

    expect(ticks[ticks.length - 1]).toBe(1);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThanOrEqual(ticks[i - 1]);
  });

  it('segment() maps the loaded runner output; embed() delegates to the embedder', async () => {
    const engine = new PyannoteWeSpeakerEngine(fakeLoaders());
    await engine.load(() => {});

    expect(await engine.segment(new Float32Array(16000))).toEqual([{ startMs: 0, endMs: 1000 }]);
    expect(await engine.embed(new Float32Array(16000))).toEqual(new Float32Array([1, 0]));
    expect(await engine.embedBatch([new Float32Array(16000), new Float32Array(16000)])).toEqual([
      new Float32Array([1, 0]),
      new Float32Array([1, 0]),
    ]);
  });

  it('throws if used before load() completes', async () => {
    const engine = new PyannoteWeSpeakerEngine(fakeLoaders());
    await expect(engine.segment(new Float32Array(1))).rejects.toThrow(/load\(\) must complete/);
    await expect(engine.embed(new Float32Array(1))).rejects.toThrow(/load\(\) must complete/);
  });

  it('dispose() releases the models (subsequent use throws)', async () => {
    const engine = new PyannoteWeSpeakerEngine(fakeLoaders());
    await engine.load(() => {});
    engine.dispose();
    await expect(engine.segment(new Float32Array(1))).rejects.toThrow();
  });
});
