// @vitest-environment jsdom
/**
 * U8: light smoke tests for `StoppedScreen`, extracted out of the deleted
 * `App.tsx`'s `ScreenContent` `'stopped'` branch — covers the annotation-
 * action button gating and the aligned/plain transcript swap.
 */
import { cleanup, render, fireEvent } from '@testing-library/react';
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
