import { describe, expect, it } from 'vitest';
import { mapToLocalSegments, PyannoteSegmenter, type RawSpeechRegion, type RunSegmentation } from './segmentation';

const SR = 16000;

describe('mapToLocalSegments', () => {
  it('scales seconds → ms, sorts by start, and drops non-positive-length regions', () => {
    const raw: RawSpeechRegion[] = [
      { start: 2.0, end: 3.5 },
      { start: 0.0, end: 1.0 },
      { start: 4.0, end: 4.0 }, // zero length → dropped
      { start: 5.0, end: 4.9 }, // negative length → dropped
    ];
    expect(mapToLocalSegments(raw)).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 3500 },
    ]);
  });

  it('returns [] for no regions', () => {
    expect(mapToLocalSegments([])).toEqual([]);
  });
});

describe('PyannoteSegmenter', () => {
  it('runs the injected model over a single window and maps its output (recording ≤ one window)', async () => {
    // A 10 s recording is exactly one window — regions within it pass through.
    const segmenter = new PyannoteSegmenter(
      async () => [
        { start: 1.5, end: 2.25 },
        { start: 0.0, end: 0.5 },
      ],
      10,
      SR,
    );
    expect(await segmenter.segment(new Float32Array(10 * SR))).toEqual([
      { startMs: 0, endMs: 500 },
      { startMs: 1500, endMs: 2250 },
    ]);
  });

  it('slices into consecutive 10 s windows and offsets each window’s regions to global time', async () => {
    const windowLengths: number[] = [];
    const run: RunSegmentation = async (pcm) => {
      windowLengths.push(pcm.length);
      return [{ start: 1, end: 2 }]; // one region 1–2 s into every window
    };
    const segmenter = new PyannoteSegmenter(run, 10, SR);
    // 25 s → windows at 0 s, 10 s, 20 s (the last a 5 s remainder, zero-padded to 10 s).
    const segs = await segmenter.segment(new Float32Array(25 * SR));
    expect(windowLengths).toEqual([10 * SR, 10 * SR, 10 * SR]); // last window zero-padded to full length
    expect(segs).toEqual([
      { startMs: 1000, endMs: 2000 },
      { startMs: 11000, endMs: 12000 },
      { startMs: 21000, endMs: 22000 },
    ]);
  });

  it('clamps regions to the real audio length so the zero-padded tail emits nothing beyond the end', async () => {
    const run: RunSegmentation = async () => [{ start: 0, end: 10 }]; // a full-window region every window
    const segmenter = new PyannoteSegmenter(run, 10, SR);
    // 15 s → window 0 (0–10 s) + window 1 (10–20 s, padded); the second region clamps to the 15 s end.
    expect(await segmenter.segment(new Float32Array(15 * SR))).toEqual([
      { startMs: 0, endMs: 10000 },
      { startMs: 10000, endMs: 15000 },
    ]);
  });

});
