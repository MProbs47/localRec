// Realitätsgrenze: `getDisplayMedia`/`MediaStream`/`MediaStreamTrack` don't
// exist in Node/Vitest — every fake below implements exactly the narrow
// structural interface `systemAudio.ts` depends on (`SystemAudioDeps`,
// `MediaStreamLike`, `MediaStreamTrackLike`), so the track-cleanup/error-
// classification logic under test runs for real against these fakes. A real
// screen-picker prompt stays the plan's documented manual milestone (U5).
import { describe, expect, it } from 'vitest';
import {
  canCaptureSystemAudio,
  captureSystemAudio,
  SystemAudioError,
  type MediaStreamLike,
  type MediaStreamTrackLike,
  type SystemAudioDeps,
} from './systemAudio';

class FakeTrack implements MediaStreamTrackLike {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeMediaStream implements MediaStreamLike {
  #videoTracks: FakeTrack[];
  #audioTracks: FakeTrack[];
  removedTracks: MediaStreamTrackLike[] = [];

  constructor(videoTracks: FakeTrack[], audioTracks: FakeTrack[]) {
    this.#videoTracks = videoTracks;
    this.#audioTracks = audioTracks;
  }

  getVideoTracks(): MediaStreamTrackLike[] {
    return this.#videoTracks;
  }

  getAudioTracks(): MediaStreamTrackLike[] {
    return this.#audioTracks;
  }

  removeTrack(track: MediaStreamTrackLike): void {
    this.removedTracks.push(track);
  }
}

function depsWithStream(stream: FakeMediaStream): SystemAudioDeps {
  return {
    mediaDevices: {
      getDisplayMedia: async () => stream,
    },
  };
}

describe('captureSystemAudio (KTD-M1: request video+audio, discard video, keep audio-only stream)', () => {
  it('stops and removes the video track, keeping only the audio track', async () => {
    const videoTrack = new FakeTrack();
    const audioTrack = new FakeTrack();
    const stream = new FakeMediaStream([videoTrack], [audioTrack]);

    const result = await captureSystemAudio(depsWithStream(stream));

    expect(videoTrack.stopped).toBe(true);
    expect(stream.removedTracks).toEqual([videoTrack]);
    expect(result).toBe(stream as unknown as MediaStream);
  });

  it('stops and removes every video track when there is more than one', async () => {
    const videoTracks = [new FakeTrack(), new FakeTrack()];
    const audioTrack = new FakeTrack();
    const stream = new FakeMediaStream(videoTracks, [audioTrack]);

    await captureSystemAudio(depsWithStream(stream));

    expect(videoTracks.every((track) => track.stopped)).toBe(true);
    expect(stream.removedTracks).toEqual(videoTracks);
  });

  it('throws a SystemAudioError with reason "no-audio-track" when no audio track came back (Systemaudio-Häkchen vergessen)', async () => {
    const stream = new FakeMediaStream([new FakeTrack()], []);

    const error = await captureSystemAudio(depsWithStream(stream)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SystemAudioError);
    expect((error as SystemAudioError).reason).toBe('no-audio-track');
  });

  it('signals user-cancel (NotAllowedError) as an aborted SystemAudioError, not a generic throw', async () => {
    const deps: SystemAudioDeps = {
      mediaDevices: {
        getDisplayMedia: async () => {
          const error = new Error('Permission denied');
          error.name = 'NotAllowedError';
          throw error;
        },
      },
    };

    const error = await captureSystemAudio(deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SystemAudioError);
    expect((error as SystemAudioError).reason).toBe('aborted');
  });

  it('signals user-cancel (AbortError) as an aborted SystemAudioError', async () => {
    const deps: SystemAudioDeps = {
      mediaDevices: {
        getDisplayMedia: async () => {
          const error = new Error('The user aborted a request');
          error.name = 'AbortError';
          throw error;
        },
      },
    };

    const error = await captureSystemAudio(deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SystemAudioError);
    expect((error as SystemAudioError).reason).toBe('aborted');
  });

  it('re-throws other errors distinguishably from "aborted"/"no-audio-track"', async () => {
    const deps: SystemAudioDeps = {
      mediaDevices: {
        getDisplayMedia: async () => {
          throw new Error('NotFoundError: no display surfaces');
        },
      },
    };

    const error = await captureSystemAudio(deps).catch((e: unknown) => e);
    if (error instanceof SystemAudioError) {
      expect(error.reason).not.toBe('aborted');
      expect(error.reason).not.toBe('no-audio-track');
    } else {
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe('canCaptureSystemAudio (KTD-M3: feature detection, no UA sniffing)', () => {
  it('returns false when mediaDevices.getDisplayMedia is absent', () => {
    expect(canCaptureSystemAudio({ navigator: { mediaDevices: {} } })).toBe(false);
  });

  it('returns false when navigator.mediaDevices itself is absent', () => {
    expect(canCaptureSystemAudio({ navigator: {} })).toBe(false);
  });

  it('returns true when getDisplayMedia is a function', () => {
    const stream = new FakeMediaStream([], []);
    expect(
      canCaptureSystemAudio({
        navigator: { mediaDevices: { getDisplayMedia: async () => stream } },
      }),
    ).toBe(true);
  });
});
