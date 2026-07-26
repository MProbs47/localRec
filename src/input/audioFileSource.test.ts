// Realitätsgrenze: neither `showOpenFilePicker` nor a real `<input
// type=file>` dialog exist in Node/Vitest (see `audioFileSource.ts`'s file
// header). Every fake below implements exactly the narrow structural
// interface the production router depends on, so the feature-detection /
// cancel-handling / fallback-wiring logic in `audioFileSource.ts` runs for
// real against these fakes — nothing about *that* logic is mocked away.
import { describe, expect, it } from 'vitest';
import {
  hasShowOpenFilePicker,
  pickAudioFile,
  type AudioFileSourceEnvLike,
  type FileInputLike,
  type FileSystemFileHandleLike,
  type PickedFileLike,
} from './audioFileSource';

function makeFile(name: string, contents = 'audio-bytes', type = 'audio/wav'): PickedFileLike {
  // A real Blob plus a `name` — structurally identical to what a real `File`
  // (from either picker path) provides, without depending on Node's global
  // `File` being registered (see file header: `PickedFileLike extends Blob`).
  return Object.assign(new Blob([contents], { type }), { name }) as PickedFileLike;
}

class FakeFileHandle implements FileSystemFileHandleLike {
  constructor(private readonly file: PickedFileLike) {}
  async getFile(): Promise<PickedFileLike> {
    return this.file;
  }
}

class FakeFileInput implements FileInputLike {
  accept = '';
  clicked = false;
  removed = false;
  files: ArrayLike<PickedFileLike> | null = null;
  #listeners = new Map<string, () => void>();

  click(): void {
    this.clicked = true;
  }
  addEventListener(type: 'change' | 'cancel', listener: () => void): void {
    this.#listeners.set(type, listener);
  }
  removeEventListener(type: 'change' | 'cancel', listener: () => void): void {
    if (this.#listeners.get(type) === listener) this.#listeners.delete(type);
  }
  remove(): void {
    this.removed = true;
  }

  // Test-only helpers simulating what a real `<input>` would dispatch.
  simulateChange(files: PickedFileLike[]): void {
    this.files = files;
    this.#listeners.get('change')?.();
  }
  simulateCancel(): void {
    this.#listeners.get('cancel')?.();
  }
}

describe('hasShowOpenFilePicker (feature detection)', () => {
  it('is true when the env exposes a showOpenFilePicker function', () => {
    expect(hasShowOpenFilePicker({ showOpenFilePicker: async () => [] })).toBe(true);
  });

  it('is false when the env has no showOpenFilePicker', () => {
    expect(hasShowOpenFilePicker({})).toBe(false);
  });
});

describe('pickAudioFile — File System Access path', () => {
  it('resolves to the picked file’s Blob + name when showOpenFilePicker is available', async () => {
    const file = makeFile('meeting.wav');
    const env: AudioFileSourceEnvLike = {
      showOpenFilePicker: async () => [new FakeFileHandle(file)],
    };

    const result = await pickAudioFile({ env });

    expect(result).not.toBeNull();
    expect(result?.name).toBe('meeting.wav');
    expect(result?.blob).toBe(file); // the real Blob is handed through untouched — no re-wrapping/decoding
  });

  it('(Deckt IM-2) passes an audio/* accept filter to the picker, never opening it to arbitrary files', async () => {
    let seenOptions: unknown;
    const env: AudioFileSourceEnvLike = {
      showOpenFilePicker: async (options) => {
        seenOptions = options;
        return [new FakeFileHandle(makeFile('x.wav'))];
      },
    };

    await pickAudioFile({ env });

    expect(seenOptions).toMatchObject({
      types: [{ accept: { 'audio/*': expect.any(Array) } }],
    });
  });

  it('resolves to null (not a throw) when the user cancels via AbortError', async () => {
    const env: AudioFileSourceEnvLike = {
      showOpenFilePicker: async () => {
        throw Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
      },
    };

    await expect(pickAudioFile({ env })).resolves.toBeNull();
  });

  it('resolves to null for any other picker failure too — no import error UI exists yet (see file header)', async () => {
    const env: AudioFileSourceEnvLike = {
      showOpenFilePicker: async () => {
        throw new Error('something unexpected');
      },
    };

    await expect(pickAudioFile({ env })).resolves.toBeNull();
  });

  it('resolves to null if the picker resolves an empty handle array (defensive)', async () => {
    const env: AudioFileSourceEnvLike = { showOpenFilePicker: async () => [] };
    await expect(pickAudioFile({ env })).resolves.toBeNull();
  });
});

describe('pickAudioFile — <input type=file> fallback', () => {
  it('is used when showOpenFilePicker is absent from the env', async () => {
    const fakeInput = new FakeFileInput();
    const resultPromise = pickAudioFile({ env: {}, createFileInput: () => fakeInput });

    expect(fakeInput.clicked).toBe(true); // the dialog is opened synchronously, inside the user gesture

    fakeInput.simulateChange([makeFile('import.mp3')]);
    const result = await resultPromise;

    expect(result).toEqual({ blob: expect.any(Blob), name: 'import.mp3' });
    expect(fakeInput.removed).toBe(true); // cleaned up, no leftover detached element
  });

  it('(Grenzfall) resolves cleanly to null on cancel — no half-open pipeline start', async () => {
    const fakeInput = new FakeFileInput();
    const resultPromise = pickAudioFile({ env: {}, createFileInput: () => fakeInput });

    fakeInput.simulateCancel();
    const result = await resultPromise;

    expect(result).toBeNull();
    expect(fakeInput.removed).toBe(true);
  });

  it('resolves to null if change fires with no file selected (defensive, same as a cancel)', async () => {
    const fakeInput = new FakeFileInput();
    const resultPromise = pickAudioFile({ env: {}, createFileInput: () => fakeInput });

    fakeInput.simulateChange([]);
    await expect(resultPromise).resolves.toBeNull();
  });

  it('only settles once even if both change and cancel somehow fire', async () => {
    const fakeInput = new FakeFileInput();
    const resultPromise = pickAudioFile({ env: {}, createFileInput: () => fakeInput });

    fakeInput.simulateChange([makeFile('a.wav')]);
    fakeInput.simulateCancel(); // must be a no-op — the promise already settled
    const result = await resultPromise;

    expect(result?.name).toBe('a.wav');
  });
});
