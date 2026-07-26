import { describe, expect, it } from 'vitest';
import { AudioWriter } from './audioWriter';
import type { AppendableFile } from './fileSink';

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
}

describe('AudioWriter (.webm passthrough Andockpunkt, R9)', () => {
  it('appends a recorder chunk verbatim, byte-for-byte, with no re-encoding', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 250, 251]);
    const blob = new Blob([bytes]);

    const file = new FakeAppendableFile();
    const writer = new AudioWriter(file);
    await writer.writeChunk(blob);

    expect(file.chunks).toHaveLength(1);
    expect(Array.from(file.chunks[0]!)).toEqual(Array.from(bytes));
  });

  it('appends multiple chunks in arrival order without merging or reordering them', async () => {
    const first = new Blob([new Uint8Array([10, 20])]);
    const second = new Blob([new Uint8Array([30, 40, 50])]);

    const file = new FakeAppendableFile();
    const writer = new AudioWriter(file);
    await writer.writeChunk(first);
    await writer.writeChunk(second);

    expect(file.chunks).toHaveLength(2);
    expect(Array.from(file.chunks[0]!)).toEqual([10, 20]);
    expect(Array.from(file.chunks[1]!)).toEqual([30, 40, 50]);
  });

  it('closes the underlying file', async () => {
    const file = new FakeAppendableFile();
    const writer = new AudioWriter(file);
    await writer.close();

    expect(file.closed).toBe(true);
  });
});
