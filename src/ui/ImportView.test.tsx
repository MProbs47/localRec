// @vitest-environment jsdom
/**
 * U19/U20b: `ImportView`'s picker wiring — driven entirely through an
 * injected `pickFile` fake (no real file dialog, same DI discipline as
 * `modelCache.test.ts`'s fake `fetchImpl`/`storageGate`). Covers a picked
 * file reaching `onFileSelected`; a cancelled/failed pick leaving a clean
 * resting state with no half-open pipeline start; and (U20b) the
 * folder-first gate — `hasOutputTarget=false` withholds the file picker
 * entirely, showing only "Ordner wählen" (see `ImportView.tsx`'s header for
 * why: `showOpenFilePicker`/`showDirectoryPicker` each need their own
 * gesture).
 */
import { act } from 'react';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportView } from './ImportView';
import type { PickedAudioFile } from '../input/audioFileSource';

afterEach(() => {
  cleanup();
});

function file(name: string): PickedAudioFile {
  return { blob: new Blob(['x'], { type: 'audio/wav' }), name };
}

describe('ImportView', () => {
  it('(Deckt IM-2) a picked file reaches onFileSelected and shows a processing placeholder', async () => {
    const onFileSelected = vi.fn();
    const pickFile = vi.fn().mockResolvedValue(file('interview.wav'));

    const { getByRole, findByText } = render(
      <ImportView onFileSelected={onFileSelected} pickFile={pickFile} hasOutputTarget onChooseFolder={() => {}} />,
    );
    fireEvent.click(getByRole('button', { name: 'Datei wählen' }));

    await findByText(/Ausgewählt: «interview\.wav» — wird verarbeitet/);
    expect(onFileSelected).toHaveBeenCalledTimes(1);
    expect(onFileSelected).toHaveBeenCalledWith(file('interview.wav'));
  });

  it('(Grenzfall) a cancelled pick (picker resolves null) shows no selection and never calls onFileSelected', async () => {
    const onFileSelected = vi.fn();
    const pickFile = vi.fn().mockResolvedValue(null);

    const { getByRole, queryByText } = render(
      <ImportView onFileSelected={onFileSelected} pickFile={pickFile} hasOutputTarget onChooseFolder={() => {}} />,
    );
    fireEvent.click(getByRole('button', { name: 'Datei wählen' }));

    await waitFor(() => expect(pickFile).toHaveBeenCalledTimes(1));
    expect(onFileSelected).not.toHaveBeenCalled();
    expect(queryByText(/Ausgewählt/)).toBeNull();
  });

  it('disables the button while a pick is in flight, and re-enables it once settled (no double-open)', async () => {
    let resolvePick: (file: PickedAudioFile | null) => void = () => {};
    const pickFile = vi.fn(
      () => new Promise<PickedAudioFile | null>((resolve) => (resolvePick = resolve)),
    );

    const { getByRole } = render(
      <ImportView onFileSelected={() => {}} pickFile={pickFile} hasOutputTarget onChooseFolder={() => {}} />,
    );
    const button = getByRole('button', { name: 'Datei wählen' }) as HTMLButtonElement;

    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));

    await act(async () => {
      resolvePick(file('a.wav'));
    });
    expect(button.disabled).toBe(false);
  });

  it('re-enables the button (clean resting state) even when the picker itself rejects unexpectedly', async () => {
    const onFileSelected = vi.fn();
    const pickFile = vi.fn().mockRejectedValue(new Error('boom'));
    const { getByRole, queryByText } = render(
      <ImportView onFileSelected={onFileSelected} pickFile={pickFile} hasOutputTarget onChooseFolder={() => {}} />,
    );
    const button = getByRole('button', { name: 'Datei wählen' }) as HTMLButtonElement;

    // `audioFileSource.ts`'s real contract never rejects — this defends
    // against a misbehaving injected fake so a picker failure still lands
    // back at a clean resting state, not an unhandled rejection or a stuck
    // "picking" button.
    await act(async () => {
      fireEvent.click(button);
    });

    expect(button.disabled).toBe(false);
    expect(onFileSelected).not.toHaveBeenCalled();
    expect(queryByText(/Ausgewählt/)).toBeNull();
  });

  it('picking a second file after the first replaces the shown selection', async () => {
    const onFileSelected = vi.fn();
    const pickFile = vi.fn().mockResolvedValueOnce(file('first.wav')).mockResolvedValueOnce(file('second.wav'));

    const { getByRole, findByText } = render(
      <ImportView onFileSelected={onFileSelected} pickFile={pickFile} hasOutputTarget onChooseFolder={() => {}} />,
    );
    fireEvent.click(getByRole('button', { name: 'Datei wählen' }));
    await findByText(/first\.wav/);

    fireEvent.click(getByRole('button', { name: 'Datei wählen' }));
    await findByText(/second\.wav/);
    expect(onFileSelected).toHaveBeenCalledTimes(2);
  });

  // Owner decision 2026-07-27: file first, folder second — first WHAT gets
  // processed, then WHERE the result goes (see the component's header).
  describe('(U20b) file first, folder second', () => {
    it('offers the file picker first, with no folder step in the way', () => {
      const { getByRole, queryByRole } = render(
        <ImportView onFileSelected={() => {}} hasOutputTarget={false} onChooseFolder={() => {}} />,
      );

      expect(getByRole('button', { name: 'Datei wählen' })).not.toBeNull();
      expect(queryByRole('button', { name: 'Speicherort wählen' })).toBeNull();
    });

    it('asks for the folder once a file is picked and none is set, naming the picked file', async () => {
      const onChooseFolder = vi.fn();
      const { getByRole, findByText } = render(
        <ImportView
          onFileSelected={() => {}}
          pickFile={async () => file('sitzung.m4a')}
          hasOutputTarget={false}
          onChooseFolder={onChooseFolder}
        />,
      );

      fireEvent.click(getByRole('button', { name: 'Datei wählen' }));

      await findByText(/sitzung\.m4a/); // the file stays named through step 2
      fireEvent.click(getByRole('button', { name: 'Speicherort wählen' }));
      expect(onChooseFolder).toHaveBeenCalledTimes(1);
    });

    it('never asks for the folder again when one is already set (second import of a session)', async () => {
      const { getByRole, queryByRole, findByText } = render(
        <ImportView
          onFileSelected={() => {}}
          pickFile={async () => file('zweite.wav')}
          hasOutputTarget
          onChooseFolder={() => {}}
        />,
      );

      fireEvent.click(getByRole('button', { name: 'Datei wählen' }));
      await findByText(/zweite\.wav/);

      expect(queryByRole('button', { name: 'Speicherort wählen' })).toBeNull();
    });
  });

  describe('(U6, R11) consent-note regression lock', () => {
    it('never renders the consent sentence, with or without a folder — this path records nothing of its own', () => {
      const { queryByText, rerender } = render(
        <ImportView onFileSelected={() => {}} hasOutputTarget={false} onChooseFolder={() => {}} />,
      );
      expect(queryByText(/Alle Teilnehmenden wissen von der Aufnahme/)).toBeNull();

      rerender(<ImportView onFileSelected={() => {}} hasOutputTarget onChooseFolder={() => {}} />);
      expect(queryByText(/Alle Teilnehmenden wissen von der Aufnahme/)).toBeNull();
    });
  });

  describe('Firefox/Safari fallback-honesty fix', () => {
    it('shows the fallback note when sinkIsFallback is true, once a folder target exists', () => {
      const { getByText } = render(
        <ImportView onFileSelected={() => {}} hasOutputTarget onChooseFolder={() => {}} sinkIsFallback />,
      );
      expect(
        getByText('Kein direkter Ordner-Zugriff in diesem Browser — die Dateien gibt es am Ende als Download.'),
      ).not.toBeNull();
    });

    it('does not show the fallback note when sinkIsFallback is false (default)', () => {
      const { queryByText } = render(
        <ImportView onFileSelected={() => {}} hasOutputTarget onChooseFolder={() => {}} />,
      );
      expect(queryByText(/keinen direkten Ordner-Zugriff/)).toBeNull();
    });
  });
});
