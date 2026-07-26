// @vitest-environment jsdom
/**
 * U11: `StorageManager`'s status display + "Modell löschen" action, proven
 * against `modelCache.ts` fakes. Asserts the delete button actually drives
 * `modelCache.ts`'s `deleteModelSet` (not just a local UI flag) and that a
 * missing model set renders as such rather than crashing.
 */
import { act, cleanup, waitFor, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageManager, type ModelSetEntry } from './StorageManager';
import type { SyncAccessHandleLike } from '../storage/opfsAudio';
import type { ModelOpfsStore, ModelSetSpec } from '../storage/modelCache';

afterEach(() => {
  // UNMOUNT, not just wipe — `globals` is off, so testing-library's automatic
  // cleanup never registers; a wiped-but-mounted tree leaks async work past
  // the environment teardown (see LiveTranscript.test.tsx).
  cleanup();
});

class FakeFileSystem {
  files = new Map<string, Uint8Array>();
}

function createFakeStore(fs: FakeFileSystem): ModelOpfsStore {
  return {
    async exists(fileName) {
      return fs.files.has(fileName);
    },
    async openFile(fileName) {
      if (!fs.files.has(fileName)) fs.files.set(fileName, new Uint8Array(0));
      const handle: SyncAccessHandleLike = {
        getSize: () => fs.files.get(fileName)!.length,
        write: (buffer, options) => {
          const incoming = new Uint8Array(buffer);
          const current = fs.files.get(fileName)!;
          const next = new Uint8Array(Math.max(current.length, options.at + incoming.length));
          next.set(current, 0);
          next.set(incoming, options.at);
          fs.files.set(fileName, next);
          return incoming.length;
        },
        flush: () => {},
        close: () => {},
      };
      return handle;
    },
    async deleteFile(fileName) {
      fs.files.delete(fileName);
    },
  };
}

function markComplete(fs: FakeFileSystem, fileName: string, bytes: number) {
  fs.files.set(fileName, new Uint8Array(bytes));
  fs.files.set(`${fileName}.done`, new Uint8Array(0));
}

const SPEC: ModelSetSpec = {
  id: 'model-test',
  files: [{ url: 'https://example.invalid/shard.onnx_data', fileName: 'shard.onnx_data' }],
};

describe('StorageManager (U11: model status + delete)', () => {
  it('shows a missing model as such, without a delete option', async () => {
    const store = createFakeStore(new FakeFileSystem());
    const entries: ModelSetEntry[] = [{ id: SPEC.id, label: 'Whisper (Transkription)', spec: SPEC, store }];

    const { container } = render(<StorageManager entries={entries} />);

    await waitFor(() => {
      expect(container.querySelector('.storage-manager__row')?.getAttribute('data-status')).toBe('missing');
    });
    const deleteButton = container.querySelector('.storage-manager__delete') as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
  });

  it('shows a ready model with its size, and clicking "Modell löschen" calls modelCache\'s delete action and flips the row back to missing', async () => {
    const fs = new FakeFileSystem();
    markComplete(fs, 'shard.onnx_data', 2 * 1024 * 1024);
    const store = createFakeStore(fs);
    const entries: ModelSetEntry[] = [{ id: SPEC.id, label: 'Whisper (Transkription)', spec: SPEC, store }];

    const { container } = render(<StorageManager entries={entries} />);

    await waitFor(() => {
      expect(container.querySelector('.storage-manager__row')?.getAttribute('data-status')).toBe('ready');
    });
    expect(container.querySelector('.storage-manager__size')?.textContent).toBe('2 MB');

    const deleteButton = container.querySelector('.storage-manager__delete') as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(false);

    await act(async () => {
      deleteButton.click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.querySelector('.storage-manager__row')?.getAttribute('data-status')).toBe('missing');
    });
    // The actual OPFS-backing store lost the file/sentinel — proves the
    // click drove `modelCache.ts`'s `deleteModelSet`, not a local flag.
    expect(fs.files.has('shard.onnx_data')).toBe(false);
    expect(fs.files.has('shard.onnx_data.done')).toBe(false);
  });

  it('renders one row per entry (listable for a future second model set, U18) without requiring more than one today', async () => {
    const storeA = createFakeStore(new FakeFileSystem());
    const fsB = new FakeFileSystem();
    markComplete(fsB, 'other.onnx_data', 512);
    const storeB = createFakeStore(fsB);

    const entries: ModelSetEntry[] = [
      { id: 'whisper', label: 'Whisper (Transkription)', spec: SPEC, store: storeA },
      {
        id: 'other',
        label: 'Zweites Set',
        spec: { id: 'other', files: [{ url: 'https://example.invalid/other.onnx_data', fileName: 'other.onnx_data' }] },
        store: storeB,
      },
    ];

    const { container } = render(<StorageManager entries={entries} />);

    await waitFor(() => {
      const rows = container.querySelectorAll('.storage-manager__row');
      expect(rows).toHaveLength(2);
    });
    // Both statuses resolve asynchronously (exists() promises) — each needs its
    // own waitFor; asserting "whisper" synchronously after the rows appeared
    // raced the still-'checking' state and flaked under full-suite load.
    await waitFor(() => {
      expect(container.querySelector('[data-model-id="whisper"]')?.getAttribute('data-status')).toBe('missing');
    });
    await waitFor(() => {
      expect(container.querySelector('[data-model-id="other"]')?.getAttribute('data-status')).toBe('ready');
    });
  });
});
