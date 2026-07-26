import { describe, expect, it } from 'vitest';
import { writeSpeakerTranscripts } from './writeSpeakerTranscripts';
import { formatTranscriptTextWithSpeakers, formatSrtWithSpeakers } from './speakerTranscript';
import type { AlignedSegment } from '../diarization/align';
import type { AppendableFile, FileSink } from './fileSink';

// --- Fakes -------------------------------------------------------------
// In-memory FileSink: openFile() records the requested name and returns an
// AppendableFile that accumulates appended bytes; close() is tracked so
// tests can assert every opened file was also closed.

class FakeAppendableFile implements AppendableFile {
  chunks: Uint8Array[] = [];
  closed = false;

  async append(data: Uint8Array): Promise<void> {
    this.chunks.push(data);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  text(): string {
    return new TextDecoder().decode(concat(this.chunks));
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

class FakeFileSink implements FileSink {
  readonly kind = 'fallback' as const;
  readonly files = new Map<string, FakeAppendableFile>();
  readonly openedNames: string[] = [];

  async openFile(name: string): Promise<AppendableFile> {
    this.openedNames.push(name);
    const file = new FakeAppendableFile();
    this.files.set(name, file);
    return file;
  }
}

const seg = (text: string, startMs: number, endMs: number, speaker: number | null): AlignedSegment => ({
  text,
  startMs,
  endMs,
  speaker,
});

describe('writeSpeakerTranscripts (U18/U21, SD-2/SD-3)', () => {
  it('opens <base>-sprecher.txt and <base>-sprecher.srt, writes the full formatted content once, and closes both', async () => {
    const sink = new FakeFileSink();
    const segments = [
      seg('hallo', 0, 1000, 0),
      seg('welt', 1000, 2000, 0),
      seg('gut danke', 2000, 3000, 1),
    ];

    await writeSpeakerTranscripts(sink, segments);

    expect(sink.openedNames).toEqual(['transkript-sprecher.txt', 'transkript-sprecher.srt']);

    const txt = sink.files.get('transkript-sprecher.txt')!;
    const srt = sink.files.get('transkript-sprecher.srt')!;

    expect(txt.chunks).toHaveLength(1); // a single one-shot append
    expect(srt.chunks).toHaveLength(1);

    expect(txt.text()).toBe(formatTranscriptTextWithSpeakers(segments));
    expect(srt.text()).toBe(formatSrtWithSpeakers(segments));

    expect(txt.closed).toBe(true);
    expect(srt.closed).toBe(true);
  });

  it('honors a custom baseName', async () => {
    const sink = new FakeFileSink();
    await writeSpeakerTranscripts(sink, [seg('hi', 0, 1000, 0)], { baseName: 'meeting-2026' });

    expect(sink.openedNames).toEqual(['meeting-2026-sprecher.txt', 'meeting-2026-sprecher.srt']);
  });

  it('honors a custom speakerName resolver in both outputs', async () => {
    const sink = new FakeFileSink();
    const segments = [seg('hi', 0, 1000, 0), seg('yo', 1000, 2000, 1)];
    const speakerName = (s: number) => ['Anna', 'Ben'][s];

    await writeSpeakerTranscripts(sink, segments, { speakerName });

    const txt = sink.files.get('transkript-sprecher.txt')!;
    const srt = sink.files.get('transkript-sprecher.srt')!;

    expect(txt.text()).toBe(formatTranscriptTextWithSpeakers(segments, speakerName));
    expect(txt.text()).toContain('Anna: hi');
    expect(txt.text()).toContain('Ben: yo');

    expect(srt.text()).toBe(formatSrtWithSpeakers(segments, speakerName));
    expect(srt.text()).toContain('Anna: hi');
    expect(srt.text()).toContain('Ben: yo');
  });

  it('SD-3: an all-null-speaker transcript has no speaker prefixes in the txt output', async () => {
    const sink = new FakeFileSink();
    const segments = [seg('hallo', 0, 1000, null), seg('welt', 1000, 2000, null)];

    await writeSpeakerTranscripts(sink, segments);

    const txt = sink.files.get('transkript-sprecher.txt')!;
    expect(txt.text()).not.toMatch(/Sprecher \d+:/);
    expect(txt.text()).toBe(formatTranscriptTextWithSpeakers(segments));

    const srt = sink.files.get('transkript-sprecher.srt')!;
    expect(srt.text()).not.toMatch(/Sprecher \d+:/);
  });
});
