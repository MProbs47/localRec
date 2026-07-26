import { describe, expect, it } from 'vitest';
import { alignTranscript, assignSpeaker, type TimedTextSegment } from './align';
import type { SpeakerTimeline } from './types';

const timeline: SpeakerTimeline = [
  { startMs: 0, endMs: 1000, speaker: 0 },
  { startMs: 1000, endMs: 2000, speaker: 1 },
  { startMs: 2000, endMs: 3000, speaker: 0 },
];

describe('assignSpeaker', () => {
  it('assigns the speaker with the most overlap', () => {
    expect(assignSpeaker({ startMs: 100, endMs: 900 }, timeline)).toBe(0);
    expect(assignSpeaker({ startMs: 1100, endMs: 1900 }, timeline)).toBe(1);
  });

  it('a boundary-spanning segment goes to the dominant (most-overlapped) speaker', () => {
    // 800..1300: 200ms with speaker 0, 300ms with speaker 1 → speaker 1.
    expect(assignSpeaker({ startMs: 800, endMs: 1300 }, timeline)).toBe(1);
    // 700..1200: 300ms with speaker 0, 200ms with speaker 1 → speaker 0.
    expect(assignSpeaker({ startMs: 700, endMs: 1200 }, timeline)).toBe(0);
  });

  it('sums overlap across non-contiguous turns of the same speaker', () => {
    // 900..2100: speaker 0 gets 100 (900-1000) + 100 (2000-2100) = 200; speaker 1 gets 1000.
    expect(assignSpeaker({ startMs: 900, endMs: 2100 }, timeline)).toBe(1);
    // 500..2600: speaker 0 gets 500 + 600 = 1100; speaker 1 gets 1000 → speaker 0.
    expect(assignSpeaker({ startMs: 500, endMs: 2600 }, timeline)).toBe(0);
  });

  it('returns null when nothing overlaps or the timeline is empty', () => {
    expect(assignSpeaker({ startMs: 5000, endMs: 6000 }, timeline)).toBeNull();
    expect(assignSpeaker({ startMs: 100, endMs: 900 }, [])).toBeNull();
  });
});

describe('alignTranscript', () => {
  it('labels each segment and preserves text + timestamps exactly', () => {
    const segments: TimedTextSegment[] = [
      { text: 'hallo', startMs: 100, endMs: 900 },
      { text: 'welt', startMs: 1100, endMs: 1900 },
    ];
    const aligned = alignTranscript(segments, timeline);
    expect(aligned).toEqual([
      { text: 'hallo', startMs: 100, endMs: 900, speaker: 0 },
      { text: 'welt', startMs: 1100, endMs: 1900, speaker: 1 },
    ]);
  });

  it('falls back to speaker: null for every segment when no diarization is available (SD-3)', () => {
    const segments: TimedTextSegment[] = [{ text: 'x', startMs: 0, endMs: 500 }];
    expect(alignTranscript(segments, [])).toEqual([{ text: 'x', startMs: 0, endMs: 500, speaker: null }]);
  });
});
