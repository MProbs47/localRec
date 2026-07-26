import { describe, expect, it } from 'vitest';
import { formatTranscriptTextWithSpeakers, formatSrtWithSpeakers } from './speakerTranscript';
import { formatTranscriptText } from './txtWriter';
import { formatSrt } from './srtWriter';
import type { AlignedSegment } from '../diarization/align';

const seg = (text: string, startMs: number, endMs: number, speaker: number | null): AlignedSegment => ({
  text,
  startMs,
  endMs,
  speaker,
});

describe('formatTranscriptTextWithSpeakers', () => {
  it('groups consecutive same-speaker segments into one prefixed line each', () => {
    const segments = [
      seg('hallo', 0, 1000, 0),
      seg('welt', 1000, 2000, 0),
      seg('gut danke', 2000, 3000, 1),
      seg('schön', 3000, 4000, 0),
    ];
    expect(formatTranscriptTextWithSpeakers(segments)).toBe(
      ['Sprecher 1: hallo welt', 'Sprecher 2: gut danke', 'Sprecher 1: schön'].join('\n'),
    );
  });

  it('honors a custom speaker-name resolver (U18 rename)', () => {
    const segments = [seg('hi', 0, 1000, 0), seg('yo', 1000, 2000, 1)];
    const names = (s: number) => ['Anna', 'Ben'][s];
    expect(formatTranscriptTextWithSpeakers(segments, names)).toBe(['Anna: hi', 'Ben: yo'].join('\n'));
  });

  it('SD-3: an all-null transcript reproduces the plain continuous text exactly', () => {
    const segments = [seg('hallo', 0, 1000, null), seg('welt', 1000, 2000, null)];
    expect(formatTranscriptTextWithSpeakers(segments)).toBe(formatTranscriptText(segments));
  });

  it('skips whitespace-only segments', () => {
    const segments = [seg('hallo', 0, 1000, 0), seg('   ', 1000, 1200, 0), seg('welt', 1200, 2000, 0)];
    expect(formatTranscriptTextWithSpeakers(segments)).toBe('Sprecher 1: hallo welt');
  });
});

describe('formatSrtWithSpeakers', () => {
  it('prefixes each cue with the speaker label, keeping numbering and timestamps', () => {
    const segments = [seg('hallo', 0, 1000, 0), seg('gut', 1000, 2000, 1)];
    const out = formatSrtWithSpeakers(segments);
    expect(out).toContain('1\n00:00:00,000 --> 00:00:01,000\nSprecher 1: hallo\n\n');
    expect(out).toContain('2\n00:00:01,000 --> 00:00:02,000\nSprecher 2: gut\n\n');
  });

  it('SD-3: an all-null transcript reproduces the plain .srt exactly', () => {
    const segments = [seg('hallo', 0, 1000, null), seg('welt', 1000, 2000, null)];
    expect(formatSrtWithSpeakers(segments)).toBe(formatSrt(segments));
  });
});
