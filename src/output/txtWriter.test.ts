import { describe, expect, it } from 'vitest';
import type { AppendableFile } from './fileSink';
import { formatTranscriptText, formatTxtAppend, TxtWriter, type TxtSegment } from './txtWriter';

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

describe('formatTranscriptText (pure, whole-sequence reference)', () => {
  it('joins segment texts with a single space, no indices or markers', () => {
    const segments: TxtSegment[] = [{ text: 'Hallo' }, { text: 'Welt' }, { text: 'wie geht es' }];
    expect(formatTranscriptText(segments)).toBe('Hallo Welt wie geht es');
  });

  it('trims each segment and drops only-whitespace segments so no doubled spaces appear', () => {
    const segments: TxtSegment[] = [{ text: '  Hallo  ' }, { text: '   ' }, { text: 'Welt' }];
    expect(formatTranscriptText(segments)).toBe('Hallo Welt');
  });

  it('returns an empty string for an empty segment sequence', () => {
    expect(formatTranscriptText([])).toBe('');
  });
});

describe('formatTxtAppend (pure, per-call incremental)', () => {
  it('emits the bare trimmed text for the first written segment (no leading space)', () => {
    expect(formatTxtAppend({ text: 'Hallo' }, false)).toBe('Hallo');
  });

  it('emits a leading space before later segments', () => {
    expect(formatTxtAppend({ text: 'Welt' }, true)).toBe(' Welt');
  });

  it('emits nothing for an only-whitespace segment, regardless of hasWrittenAny', () => {
    expect(formatTxtAppend({ text: '   ' }, false)).toBe('');
    expect(formatTxtAppend({ text: '' }, true)).toBe('');
  });
});

describe('TxtWriter (incremental append vs. full-write equivalence, plan test scenario 4)', () => {
  it('produces byte-identical output whether written one segment at a time or all at once', async () => {
    const segments: TxtSegment[] = [
      { text: 'Guten Morgen.' },
      { text: 'Wie war das Wochenende?' },
      { text: 'Ganz gut, danke.' },
    ];

    const file = new FakeAppendableFile();
    const writer = new TxtWriter(file);
    for (const segment of segments) {
      await writer.writeSegment(segment);
    }
    await writer.close();

    expect(file.text()).toBe(formatTranscriptText(segments));
    expect(file.closed).toBe(true);
  });

  it('reads as one continuous paragraph — no segment markers, indices, or artificial line breaks', async () => {
    const file = new FakeAppendableFile();
    const writer = new TxtWriter(file);
    await writer.writeSegment({ text: 'Erster Satz.' });
    await writer.writeSegment({ text: 'Zweiter Satz.' });

    const text = file.text();
    expect(text).toBe('Erster Satz. Zweiter Satz.');
    expect(text).not.toMatch(/\n/);
    expect(text).not.toMatch(/^\d+[.:)]/m);
  });

  it('skips only-whitespace segments without inserting stray spaces', async () => {
    const file = new FakeAppendableFile();
    const writer = new TxtWriter(file);
    await writer.writeSegment({ text: 'Hallo' });
    await writer.writeSegment({ text: '   ' });
    await writer.writeSegment({ text: 'Welt' });

    expect(file.text()).toBe('Hallo Welt');
  });

  it('produces an empty (but valid) file for an empty segment sequence', async () => {
    const file = new FakeAppendableFile();
    const writer = new TxtWriter(file);
    await writer.close();

    expect(file.text()).toBe('');
    expect(file.closed).toBe(true);
  });
});
