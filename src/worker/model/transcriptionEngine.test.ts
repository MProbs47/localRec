import { describe, expect, it } from 'vitest';
import type { TranscribeOptions, TranscriptionEngine, TranscriptSegment } from './transcriptionEngine';

// Manual milestone (per plan U1 verification, U8 in "Phasen-Sequenz"): real
// WebGPU model load, warm-up, and transcription quality/RTF on
// `WhisperEngine` are NOT exercised by any automated test in this repo —
// there is no GPU, model, or network access in CI/this environment. That is
// checked by hand on target hardware; nothing here is a skipped test
// standing in for it.

/**
 * A completely independent `TranscriptionEngine` implementation with zero
 * Whisper/WebGPU/transformers.js involvement — no import from
 * `whisperEngine.ts` or `@huggingface/transformers` anywhere in this file.
 * That this compiles and satisfies the interface IS the proof of KTD1: a
 * model swap stays local to one engine implementation and never touches
 * `transcriptionEngine.ts` or anything built against it.
 */
class FakeTranscriptionEngine implements TranscriptionEngine {
  loaded = false;
  warmedUp = false;
  disposed = false;

  #cannedSegments: TranscriptSegment[];

  constructor(cannedSegments: TranscriptSegment[] = []) {
    this.#cannedSegments = cannedSegments;
  }

  async load(onProgress: (fraction: number) => void): Promise<void> {
    onProgress(0);
    onProgress(0.5);
    onProgress(1);
    this.loaded = true;
  }

  async warmup(): Promise<void> {
    if (!this.loaded) throw new Error('FakeTranscriptionEngine: warmup() before load()');
    this.warmedUp = true;
  }

  async transcribe(pcm: Float32Array, _opts?: TranscribeOptions): Promise<TranscriptSegment[]> {
    if (!this.warmedUp) throw new Error('FakeTranscriptionEngine: transcribe() before warmup()');
    if (pcm.length === 0) return [];
    // A real engine derives segments from the audio; the fake just returns
    // its canned segments so the test can assert on them directly.
    return this.#cannedSegments;
  }

  dispose(): void {
    this.disposed = true;
  }
}

describe('TranscriptionEngine (KTD1: implementation-agnostic contract, KTD-W3: one call for both drivers)', () => {
  it('drives a Whisper-free fake engine through the full lifecycle with the expected state transitions', async () => {
    const canned: TranscriptSegment[] = [
      { text: 'hallo', startMs: 0, endMs: 1000 },
      { text: 'welt', startMs: 1000, endMs: 2000 },
    ];
    const engine: TranscriptionEngine = new FakeTranscriptionEngine(canned);
    const fake = engine as FakeTranscriptionEngine;

    expect(fake.loaded).toBe(false);
    await engine.load(() => {});
    expect(fake.loaded).toBe(true);

    expect(fake.warmedUp).toBe(false);
    await engine.warmup();
    expect(fake.warmedUp).toBe(true);

    // Same `transcribe()` call serves both a live rolling window and a
    // whole imported file (KTD-W3) — the fake doesn't distinguish, and
    // neither does the interface.
    const segments = await engine.transcribe(new Float32Array(16000));
    expect(segments).toEqual(canned);

    expect(fake.disposed).toBe(false);
    engine.dispose();
    expect(fake.disposed).toBe(true);
  });

  it('rejects out-of-order lifecycle calls instead of silently proceeding in a broken state', async () => {
    const notWarmedUp: TranscriptionEngine = new FakeTranscriptionEngine();
    await notWarmedUp.load(() => {});
    await expect(notWarmedUp.transcribe(new Float32Array(160))).rejects.toThrow();

    const notLoaded: TranscriptionEngine = new FakeTranscriptionEngine();
    await expect(notLoaded.warmup()).rejects.toThrow();
  });

  it("reports progress via load()'s callback for each tick the engine makes", async () => {
    const engine: TranscriptionEngine = new FakeTranscriptionEngine();
    const ticks: number[] = [];

    await engine.load((fraction) => ticks.push(fraction));

    expect(ticks).toEqual([0, 0.5, 1]);
  });

  it("returns the fake's canned segments unchanged from transcribe()", async () => {
    const canned: TranscriptSegment[] = [{ text: 'einzelnes segment', startMs: 500, endMs: 900 }];
    const engine: TranscriptionEngine = new FakeTranscriptionEngine(canned);

    await engine.load(() => {});
    await engine.warmup();

    await expect(engine.transcribe(new Float32Array(8000))).resolves.toEqual(canned);
    // Empty input is a documented no-inference-needed no-op.
    await expect(engine.transcribe(new Float32Array(0))).resolves.toEqual([]);
  });
});
