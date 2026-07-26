import { describe, expect, it } from 'vitest';
import type { AppendableFile } from './fileSink';
import { formatSrt, formatSrtCue, formatSrtTimestamp, SrtWriter, type SrtSegment } from './srtWriter';

const decoder = new TextDecoder();

/** In-memory `AppendableFile` fake — collects every appended chunk so a test can inspect the exact bytes/order written, without any real filesystem/OPFS. */
class FakeAppendableFile implements AppendableFile {
  readonly chunks: Uint8Array[] = [];
  closed = false;

  async append(data: Uint8Array): Promise<void> {
    this.chunks.push(data);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  text(): string {
    return this.chunks.map((chunk) => decoder.decode(chunk)).join('');
  }
}

describe('formatSrtTimestamp (pure)', () => {
  it('formats zero as 00:00:00,000', () => {
    expect(formatSrtTimestamp(0)).toBe('00:00:00,000');
  });

  it('formats a sub-second, sub-minute offset', () => {
    expect(formatSrtTimestamp(1234)).toBe('00:00:01,234');
  });

  it('formats an exact minute boundary correctly', () => {
    expect(formatSrtTimestamp(60_000)).toBe('00:01:00,000');
  });

  it('formats an exact hour boundary correctly (plan grenzfall)', () => {
    expect(formatSrtTimestamp(3_600_000)).toBe('01:00:00,000');
  });

  it('formats an arbitrary large multi-hour offset with correct zero-padding', () => {
    // 2h 5m 9s 7ms
    const ms = 2 * 3_600_000 + 5 * 60_000 + 9 * 1000 + 7;
    expect(formatSrtTimestamp(ms)).toBe('02:05:09,007');
  });

  it('clamps negative input to zero defensively', () => {
    expect(formatSrtTimestamp(-5)).toBe('00:00:00,000');
  });
});

describe('formatSrtCue / formatSrt (pure, whole-sequence reference)', () => {
  it('produces correctly numbered cues (1, 2, 3, ...) with the SRT timestamp arrow and a trailing blank line', () => {
    const segments: SrtSegment[] = [
      { text: 'Hallo zusammen.', startMs: 0, endMs: 1500 },
      { text: 'Wie geht es euch?', startMs: 1500, endMs: 3200 },
      { text: 'Gut, danke.', startMs: 3200, endMs: 4000 },
    ];

    const srt = formatSrt(segments);
    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nHallo zusammen.\n\n' +
        '2\n00:00:01,500 --> 00:00:03,200\nWie geht es euch?\n\n' +
        '3\n00:00:03,200 --> 00:00:04,000\nGut, danke.\n\n',
    );
  });

  it('yields monotonically increasing start timestamps across cues', () => {
    const segments: SrtSegment[] = [
      { text: 'a', startMs: 0, endMs: 1000 },
      { text: 'b', startMs: 1000, endMs: 2500 },
      { text: 'c', startMs: 2500, endMs: 6000 },
    ];
    const cues = segments.map((segment, index) => formatSrtCue(index + 1, segment));
    const starts = cues.map((cue) => cue.split('\n')[1]!.split(' --> ')[0]!);
    const sorted = [...starts].sort();
    expect(starts).toEqual(sorted);
  });

  it('survives a simulated sub-session reset: global timestamps keep climbing continuously even though a reset conceptually happened between segments', () => {
    // U5's GlobalClock never resets even when a sub-session does — a
    // finalized segment right after a reset still carries a startMs that
    // continues from where the previous sub-session's last segment ended.
    const segmentsAcrossReset: SrtSegment[] = [
      { text: 'letzter Satz vor dem Schnitt', startMs: 1_198_500, endMs: 1_200_000 }, // end of sub-session 1, ~20 min in
      { text: 'erster Satz nach dem Schnitt', startMs: 1_200_000, endMs: 1_203_400 }, // sub-session 2 starts fresh internally, but global clock continues
    ];

    const srt = formatSrt(segmentsAcrossReset);
    expect(srt).toContain('1\n00:19:58,500 --> 00:20:00,000\n');
    expect(srt).toContain('2\n00:20:00,000 --> 00:20:03,400\n');
  });

  it('returns an empty string for an empty segment sequence', () => {
    expect(formatSrt([])).toBe('');
  });
});

describe('SrtWriter (incremental append vs. full-write equivalence, plan test scenario 4)', () => {
  it('produces byte-identical output whether written one segment at a time or all at once', async () => {
    const segments: SrtSegment[] = [
      { text: 'Guten Morgen.', startMs: 0, endMs: 1200 },
      { text: 'Wie war das Wochenende?', startMs: 1200, endMs: 3400 },
      { text: 'Ganz gut, danke.', startMs: 3400, endMs: 5000 },
    ];

    const file = new FakeAppendableFile();
    const writer = new SrtWriter(file);
    for (const segment of segments) {
      await writer.writeSegment(segment);
    }
    await writer.close();

    expect(file.text()).toBe(formatSrt(segments));
    expect(file.closed).toBe(true);
  });

  it('assigns cue numbers in call order, starting at 1', async () => {
    const file = new FakeAppendableFile();
    const writer = new SrtWriter(file);
    await writer.writeSegment({ text: 'eins', startMs: 0, endMs: 500 });
    await writer.writeSegment({ text: 'zwei', startMs: 500, endMs: 1000 });

    const text = file.text();
    expect(text.startsWith('1\n')).toBe(true);
    expect(text).toContain('\n2\n');
  });

  it('produces an empty (but valid — zero cues) file for an empty segment sequence', async () => {
    const file = new FakeAppendableFile();
    const writer = new SrtWriter(file);
    await writer.close();

    expect(file.text()).toBe('');
    expect(file.closed).toBe(true);
  });
});
