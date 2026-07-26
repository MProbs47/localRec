// @vitest-environment jsdom
/**
 * U8: light smoke tests for `StoppedScreen`, extracted out of the deleted
 * `App.tsx`'s `ScreenContent` `'stopped'` branch — covers the annotation-
 * action button gating and the aligned/plain transcript swap.
 *
 * Firefox/Safari fallback-honesty fix: the `DownloadSection` tests below
 * cover the end-of-session download affordance — no section when
 * `collectDownloads` is absent/empty, a link per collected file when it
 * isn't, a re-collect when `annotation` changes (the `-sprecher.*` files
 * `writeSpeakerTranscripts` adds land in the SAME sink only after that), and
 * that every created object URL is revoked (`URL.revokeObjectURL`, spied)
 * once superseded or on unmount — nothing leaked.
 */
import { act, cleanup, render, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoppedScreen } from './StoppedScreen';
import { TranscriptStore } from './transcriptStore';
import type { AlignedSegment } from '../diarization/align';

afterEach(() => {
  cleanup();
});

function storeWithOneSegment(): TranscriptStore {
  const store = new TranscriptStore();
  store.append({ text: 'Hallo Welt', startMs: 0, endMs: 1000 });
  return store;
}

const ALIGNED: AlignedSegment[] = [{ text: 'Hallo Welt', startMs: 0, endMs: 1000, speaker: 0 }];

describe('StoppedScreen', () => {
  it('shows SpeakerView when aligned is set', () => {
    const { container } = render(
      <StoppedScreen
        store={storeWithOneSegment()}
        aligned={ALIGNED}
        annotation="done"
        annotationError={null}
        canAnnotate={false}
        onAnnotate={() => {}}
        speakerCount={null}
        onSpeakerCountChange={() => {}}
      />,
    );
    expect(container.querySelector('.speaker-view')).not.toBeNull();
  });

  it('shows the plain LiveTranscript (not SpeakerView) when aligned is null', () => {
    // LiveTranscript is virtualized (@tanstack/react-virtual) and jsdom has no
    // real layout engine, so its rows don't measure/render without the size
    // shims `LiveTranscript.test.tsx` sets up — asserting the container swap
    // (not row text) is the behavior this screen actually owns.
    const { container } = render(
      <StoppedScreen
        store={storeWithOneSegment()}
        aligned={null}
        annotation="idle"
        annotationError={null}
        canAnnotate={false}
        onAnnotate={() => {}}
        speakerCount={null}
        onSpeakerCountChange={() => {}}
      />,
    );
    expect(container.querySelector('.speaker-view')).toBeNull();
    expect(container.querySelector('.transcript__final')).not.toBeNull();
  });

  it('shows the "Sprecher erkennen" button only when canAnnotate is true and idle/skipped', () => {
    const { queryByRole, rerender } = render(
      <StoppedScreen
        store={storeWithOneSegment()}
        aligned={null}
        annotation="idle"
        annotationError={null}
        canAnnotate={false}
        onAnnotate={() => {}}
        speakerCount={null}
        onSpeakerCountChange={() => {}}
      />,
    );
    expect(queryByRole('button', { name: 'Sprecher erkennen' })).toBeNull();

    const onAnnotate = vi.fn();
    rerender(
      <StoppedScreen
        store={storeWithOneSegment()}
        aligned={null}
        annotation="idle"
        annotationError={null}
        canAnnotate
        onAnnotate={onAnnotate}
        speakerCount={null}
        onSpeakerCountChange={() => {}}
      />,
    );
    const button = queryByRole('button', { name: 'Sprecher erkennen' });
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(onAnnotate).toHaveBeenCalledTimes(1);
  });

  it('shows the retry label when annotation was skipped, and the running status while running', () => {
    const { getByRole, rerender, container } = render(
      <StoppedScreen
        store={storeWithOneSegment()}
        aligned={null}
        annotation="skipped"
        annotationError={null}
        canAnnotate
        onAnnotate={() => {}}
        speakerCount={null}
        onSpeakerCountChange={() => {}}
      />,
    );
    expect(getByRole('button', { name: 'Sprecher-Erkennung erneut versuchen' })).not.toBeNull();

    rerender(
      <StoppedScreen
        store={storeWithOneSegment()}
        aligned={null}
        annotation="running"
        annotationError={null}
        canAnnotate
        onAnnotate={() => {}}
        speakerCount={null}
        onSpeakerCountChange={() => {}}
      />,
    );
    expect(container.querySelector('.annotation-status')).not.toBeNull();
    expect(container.textContent).toContain('Sprecher werden erkannt');
  });

  it('shows the annotation error line only when skipped with a non-null error', () => {
    const { container } = render(
      <StoppedScreen
        store={storeWithOneSegment()}
        aligned={null}
        annotation="skipped"
        annotationError="Modell nicht gefunden"
        canAnnotate={false}
        onAnnotate={() => {}}
        speakerCount={null}
        onSpeakerCountChange={() => {}}
      />,
    );
    expect(container.textContent).toContain('Modell nicht gefunden');
  });
});

// ---------------------------------------------------------------------------
// Firefox/Safari fallback-honesty fix — `DownloadSection`.
// ---------------------------------------------------------------------------

type StoppedScreenBaseProps = Parameters<typeof StoppedScreen>[0];

function baseProps(overrides: Partial<StoppedScreenBaseProps> = {}): StoppedScreenBaseProps {
  return {
    store: storeWithOneSegment(),
    aligned: null,
    annotation: 'idle',
    annotationError: null,
    canAnnotate: false,
    onAnnotate: () => {},
    speakerCount: null,
    onSpeakerCountChange: () => {},
    ...overrides,
  };
}

describe('StoppedScreen — Firefox/Safari fallback-honesty fix (download section)', () => {
  it('renders no download section when collectDownloads is not provided (ordinary chosen-folder case)', () => {
    const { container } = render(<StoppedScreen {...baseProps()} />);
    expect(container.querySelector('.download-section')).toBeNull();
  });

  it('renders no download section when collectDownloads resolves an empty map', async () => {
    const collectDownloads = vi.fn(async () => new Map<string, Blob>());
    const { container } = render(<StoppedScreen {...baseProps({ collectDownloads })} />);
    await waitFor(() => expect(collectDownloads).toHaveBeenCalledTimes(1));
    expect(container.querySelector('.download-section')).toBeNull();
  });

  it('renders one download link per collected file, each with a real object URL and a download attribute', async () => {
    const files = new Map<string, Blob>([
      ['transkript.txt', new Blob(['hallo welt'], { type: 'text/plain' })],
      ['transkript.srt', new Blob(['1\n00:00:00,000 --> 00:00:01,000\nhallo welt\n'], { type: 'text/plain' })],
    ]);
    const collectDownloads = vi.fn(async () => files);
    const { getByRole, container } = render(<StoppedScreen {...baseProps({ collectDownloads })} />);

    await waitFor(() => expect(container.querySelector('.download-section')).not.toBeNull());
    expect(container.textContent).toContain(
      'Dieser Browser erlaubt keinen direkten Ordner-Zugriff, darum wurde nichts automatisch auf die Festplatte geschrieben',
    );

    const txtLink = getByRole('link', { name: 'transkript.txt' }) as HTMLAnchorElement;
    const srtLink = getByRole('link', { name: 'transkript.srt' }) as HTMLAnchorElement;
    expect(txtLink.getAttribute('download')).toBe('transkript.txt');
    expect(srtLink.getAttribute('download')).toBe('transkript.srt');
    // A real `blob:` object URL, not a placeholder — proves the Blobs were
    // actually turned into downloadable links, not just named.
    expect(txtLink.href).toMatch(/^blob:/);
    expect(srtLink.href).toMatch(/^blob:/);
  });

  it('re-collects when `annotation` changes — picks up the post-hoc `-sprecher.*` files written after the first render', async () => {
    // Mirrors `runAnnotation`'s real timing (App.tsx): `writeSpeakerTranscripts`
    // adds `-sprecher.txt`/`.srt` to the SAME sink only once diarization is
    // 'done' — a one-shot collect at mount would miss them.
    const collectDownloads = vi
      .fn<() => Promise<Map<string, Blob>>>()
      .mockResolvedValueOnce(new Map([['transkript.txt', new Blob(['a'])]]))
      .mockResolvedValueOnce(
        new Map([
          ['transkript.txt', new Blob(['a'])],
          ['transkript-sprecher.txt', new Blob(['b'])],
        ]),
      );

    const { getByRole, queryByRole, rerender } = render(
      <StoppedScreen {...baseProps({ annotation: 'running', collectDownloads })} />,
    );
    await waitFor(() => expect(getByRole('link', { name: 'transkript.txt' })).not.toBeNull());
    expect(queryByRole('link', { name: 'transkript-sprecher.txt' })).toBeNull();
    expect(collectDownloads).toHaveBeenCalledTimes(1);

    rerender(<StoppedScreen {...baseProps({ annotation: 'done', collectDownloads })} />);
    await waitFor(() => expect(getByRole('link', { name: 'transkript-sprecher.txt' })).not.toBeNull());
    expect(collectDownloads).toHaveBeenCalledTimes(2);
  });

  it('revokes every created object URL once superseded by a re-collect, and again on unmount', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const collectDownloads = vi
      .fn<() => Promise<Map<string, Blob>>>()
      .mockResolvedValueOnce(new Map([['transkript.txt', new Blob(['a'])]]))
      .mockResolvedValueOnce(new Map([['transkript.txt', new Blob(['a'])]]));

    const { getByRole, unmount, rerender } = render(
      <StoppedScreen {...baseProps({ annotation: 'running', collectDownloads })} />,
    );
    await waitFor(() => expect(getByRole('link', { name: 'transkript.txt' })).not.toBeNull());
    expect(revokeSpy).not.toHaveBeenCalled();

    await act(async () => {
      rerender(<StoppedScreen {...baseProps({ annotation: 'done', collectDownloads })} />);
    });
    await waitFor(() => expect(revokeSpy).toHaveBeenCalledTimes(1)); // the FIRST collect's URL, superseded

    unmount();
    expect(revokeSpy).toHaveBeenCalledTimes(2); // the SECOND (current) collect's URL, on unmount

    revokeSpy.mockRestore();
  });
});
