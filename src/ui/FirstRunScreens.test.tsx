// @vitest-environment jsdom
/**
 * U8: light smoke tests for the four `first-run`-wrapped screens extracted
 * out of the deleted `App.tsx`'s `ScreenContent`. Each screen only takes its
 * own props now, so these render/prop-gating checks are the "own testable
 * surface" the extraction is meant to buy (the recording-session aggregate
 * refactor's brief).
 */
import { cleanup, render, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdleScreen, DownloadingScreen, ImportingScreen, ErrorScreen } from './FirstRunScreens';

afterEach(() => {
  cleanup();
});

describe('IdleScreen', () => {
  it('shows the model-load message and fires onStartDownload on click', () => {
    const onStartDownload = vi.fn();
    const { getByRole } = render(<IdleScreen onStartDownload={onStartDownload} />);
    fireEvent.click(getByRole('button', { name: 'Modell laden' }));
    expect(onStartDownload).toHaveBeenCalledTimes(1);
  });
});

describe('DownloadingScreen', () => {
  it('renders the progress bar and MB/percent label from loadProgress', () => {
    const { container, getByText } = render(<DownloadingScreen loadProgress={0.5} />);
    const progress = container.querySelector('progress');
    expect(progress?.getAttribute('value')).toBe('0.5');
    expect(getByText('750 MB / ~1500 MB · 50%')).not.toBeNull();
  });
});

describe('ImportingScreen', () => {
  it('shows the decoding label while importPhase is decoding', () => {
    const { container } = render(<ImportingScreen importPhase="decoding" importElapsedMs={5000} />);
    expect(container.textContent).toContain('Datei wird dekodiert');
    expect(container.textContent).toContain('läuft seit 0:05');
  });

  it('shows the transcribing label and the long-running reassurance past 90s', () => {
    const { container } = render(<ImportingScreen importPhase="transcribing" importElapsedMs={95_000} />);
    expect(container.textContent).toContain('Transkription läuft');
    expect(container.querySelector('.first-run__progress-label--note')).not.toBeNull();
  });

  it('omits the reassurance line before 90s', () => {
    const { container } = render(<ImportingScreen importPhase="transcribing" importElapsedMs={1000} />);
    expect(container.querySelector('.first-run__progress-label--note')).toBeNull();
  });
});

describe('ErrorScreen', () => {
  it('shows the retry button only when modelLoadFailed is true', () => {
    const onStartDownload = vi.fn();
    const { queryByRole, rerender } = render(
      <ErrorScreen
        errorHeadline="Modell konnte nicht geladen werden."
        errorMessage="network error"
        modelLoadFailed={false}
        onStartDownload={onStartDownload}
      />,
    );
    expect(queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();

    rerender(
      <ErrorScreen
        errorHeadline="Modell konnte nicht geladen werden."
        errorMessage="network error"
        modelLoadFailed
        onStartDownload={onStartDownload}
      />,
    );
    const retry = queryByRole('button', { name: 'Erneut versuchen' });
    expect(retry).not.toBeNull();
    fireEvent.click(retry!);
    expect(onStartDownload).toHaveBeenCalledTimes(1);
  });
});
