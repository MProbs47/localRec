/**
 * U3 (Whisper refactor plan 002) — tests for `runImport`'s orchestration,
 * rewritten test-first per the plan's execution note. Every I/O boundary is
 * a plain in-memory fake (decode, the `RecordingCoordinator` slice, the
 * whole-file `transcribeFile`) — no DOM, no worker/Comlink, no GPU. The old
 * paced feeder (the former `batchTranscription.ts`, removed in U6) is gone:
 * the new design has nothing left for it to do (see `importPipeline.ts`'s
 * header).
 */
import { describe, expect, it, vi } from 'vitest';
import { runImport, type ImportPipelineCoordinator, type ImportPhase } from './importPipeline';
import type { FinalSegment } from './recordingCoordinator';
import type { TranscriptSegment } from '../worker/model/transcriptionEngine';

type Event =
  | 'decode'
  | 'coordinator:start'
  | 'transcribeFile'
  | `handleFinal:${string}`
  | 'coordinator:stop';

function fakeCoordinator(events: Event[], opts: { failStart?: Error } = {}): ImportPipelineCoordinator {
  return {
    start: vi.fn(async () => {
      events.push('coordinator:start');
      if (opts.failStart) throw opts.failStart;
    }),
    handleFinal: vi.fn(async (segment: FinalSegment) => {
      events.push(`handleFinal:${segment.text}`);
    }),
    stop: vi.fn(async () => {
      events.push('coordinator:stop');
    }),
  };
}

const NOOP_BLOB = new Blob(['x']);

const SEGMENTS: TranscriptSegment[] = [
  { text: 'hello', startMs: 0, endMs: 1200 },
  { text: 'world', startMs: 1200, endMs: 2400 },
  { text: 'again', startMs: 2400, endMs: 3600 },
];

describe('runImport ordering', () => {
  it('decodes, opens the coordinator, transcribes the whole file, then hands each segment to handleFinal in order, then stops', async () => {
    const events: Event[] = [];
    const phases: ImportPhase[] = [];
    const coordinator = fakeCoordinator(events);
    const pcm = new Float32Array([0.1, 0.2, 0.3]);
    const decode = vi.fn(async (blob: Blob) => {
      events.push('decode');
      expect(blob).toBe(NOOP_BLOB);
      return pcm;
    });
    const transcribeFile = vi.fn(async (receivedPcm: Float32Array) => {
      events.push('transcribeFile');
      expect(receivedPcm).toBe(pcm);
      return SEGMENTS;
    });

    await runImport(NOOP_BLOB, {
      decode,
      transcribeFile,
      coordinator,
      onPhase: (phase) => phases.push(phase),
    });

    expect(phases).toEqual(['decoding', 'transcribing']);
    expect(events).toEqual([
      'decode',
      'coordinator:start',
      'transcribeFile',
      'handleFinal:hello',
      'handleFinal:world',
      'handleFinal:again',
      'coordinator:stop',
    ]);
    expect(coordinator.start).toHaveBeenCalledTimes(1);
    expect(coordinator.stop).toHaveBeenCalledTimes(1);
    expect(coordinator.handleFinal).toHaveBeenCalledTimes(3);
  });

  it('passes every returned segment to handleFinal AND onSegment with its timestamps intact', async () => {
    const events: Event[] = [];
    const coordinator = fakeCoordinator(events);
    const decode = vi.fn(async () => new Float32Array([1]));
    const transcribeFile = vi.fn(async () => SEGMENTS);
    const onSegmentCalls: FinalSegment[] = [];

    await runImport(NOOP_BLOB, {
      decode,
      transcribeFile,
      coordinator,
      onSegment: (segment) => onSegmentCalls.push(segment),
    });

    expect(onSegmentCalls).toEqual(SEGMENTS);
    const handleFinalMock = coordinator.handleFinal as ReturnType<typeof vi.fn>;
    expect(handleFinalMock.mock.calls.map((call) => call[0])).toEqual(SEGMENTS);
  });

  it('forwards transcribeFile progress and reports the final value as 1', async () => {
    const events: Event[] = [];
    const coordinator = fakeCoordinator(events);
    const decode = vi.fn(async () => new Float32Array([1]));
    const transcribeFile = vi.fn(async (_pcm: Float32Array, opts?: { onProgress?: (fraction: number) => void }) => {
      opts?.onProgress?.(0);
      opts?.onProgress?.(1);
      return SEGMENTS;
    });
    const progress: number[] = [];

    await runImport(NOOP_BLOB, {
      decode,
      transcribeFile,
      coordinator,
      onProgress: (fraction) => progress.push(fraction),
    });

    expect(progress).toEqual([0, 1]);
    expect(progress[progress.length - 1]).toBe(1);
  });
});

describe('runImport short/empty file', () => {
  it('resolves cleanly with no handleFinal/onSegment calls when transcribeFile returns no segments', async () => {
    const events: Event[] = [];
    const coordinator = fakeCoordinator(events);
    const decode = vi.fn(async () => new Float32Array([1]));
    const transcribeFile = vi.fn(async () => [] as TranscriptSegment[]);
    const onSegmentCalls: FinalSegment[] = [];

    await runImport(NOOP_BLOB, {
      decode,
      transcribeFile,
      coordinator,
      onSegment: (segment) => onSegmentCalls.push(segment),
    });

    expect(onSegmentCalls).toEqual([]);
    expect(coordinator.handleFinal).not.toHaveBeenCalled();
    expect(coordinator.start).toHaveBeenCalledTimes(1);
    expect(coordinator.stop).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['coordinator:start', 'coordinator:stop']);
  });
});

describe('runImport error handling — coordinator.stop() always runs exactly once', () => {
  it('rejects with the decode error, never calls coordinator.start()/transcribeFile/handleFinal, but still stops', async () => {
    const events: Event[] = [];
    const coordinator = fakeCoordinator(events);
    const decodeError = new Error('corrupt audio');
    const decode = vi.fn(async () => {
      events.push('decode');
      throw decodeError;
    });
    const transcribeFile = vi.fn(async () => SEGMENTS);

    await expect(runImport(NOOP_BLOB, { decode, transcribeFile, coordinator })).rejects.toBe(decodeError);

    expect(coordinator.start).not.toHaveBeenCalled();
    expect(transcribeFile).not.toHaveBeenCalled();
    expect(coordinator.handleFinal).not.toHaveBeenCalled();
    expect(coordinator.stop).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['decode', 'coordinator:stop']);
  });

  it('rejects with the coordinator.start() error, never calls transcribeFile, but still stops exactly once', async () => {
    const events: Event[] = [];
    const startError = new Error('folder picker cancelled');
    const coordinator = fakeCoordinator(events, { failStart: startError });
    const decode = vi.fn(async () => {
      events.push('decode');
      return new Float32Array([1]);
    });
    const transcribeFile = vi.fn(async () => SEGMENTS);

    await expect(runImport(NOOP_BLOB, { decode, transcribeFile, coordinator })).rejects.toBe(startError);

    expect(transcribeFile).not.toHaveBeenCalled();
    expect(coordinator.stop).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['decode', 'coordinator:start', 'coordinator:stop']);
  });

  it('rejects with the transcribeFile error and still stops exactly once', async () => {
    const events: Event[] = [];
    const coordinator = fakeCoordinator(events);
    const transcribeError = new Error('transcription exploded');
    const decode = vi.fn(async () => {
      events.push('decode');
      return new Float32Array([1, 2, 3]);
    });
    const transcribeFile = vi.fn(async () => {
      events.push('transcribeFile');
      throw transcribeError;
    });

    await expect(runImport(NOOP_BLOB, { decode, transcribeFile, coordinator })).rejects.toBe(transcribeError);

    expect(coordinator.start).toHaveBeenCalledTimes(1);
    expect(coordinator.handleFinal).not.toHaveBeenCalled();
    expect(coordinator.stop).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['decode', 'coordinator:start', 'transcribeFile', 'coordinator:stop']);
  });
});
