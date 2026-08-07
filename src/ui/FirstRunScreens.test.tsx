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

/**
 * The coded-failure surface (see `ErrorScreen`'s header). What matters here is
 * that a user who cannot open DevTools can still get the report OFF the
 * machine — so the copy path and, crucially, its failure fallback are both
 * pinned down.
 */
describe('ErrorScreen: coded failures', () => {
  const REPORT = 'localRec audio decode report\ncode: AUDIO_DECODE_REJECTED\ncodecs: aac-lc=no';

  function renderCoded(overrides: { errorDetails?: string | null } = {}) {
    return render(
      <ErrorScreen
        errorHeadline="Verarbeitung fehlgeschlagen."
        errorMessage="The browser cannot decode this file’s audio codec."
        errorCode="AUDIO_DECODE_REJECTED"
        errorDetails={'errorDetails' in overrides ? overrides.errorDetails : REPORT}
        modelLoadFailed={false}
        onStartDownload={vi.fn()}
      />,
    );
  }

  it('shows the code, the one-line description and the copy button — and nothing else', () => {
    const { container, getByRole } = renderCoded();

    expect(container.querySelector('.first-run__error-code')?.textContent).toBe('AUDIO_DECODE_REJECTED');
    expect(container.textContent).toContain('The browser cannot decode this file’s audio codec.');
    expect(getByRole('button', { name: 'Copy error details' })).not.toBeNull();
    // The report itself stays behind the button while copying still works —
    // the display has room for about three lines.
    expect(container.querySelector('.first-run__error-report')).toBeNull();
  });

  it('copies the full report verbatim and confirms it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { getByRole, findByRole } = renderCoded();

    fireEvent.click(getByRole('button', { name: 'Copy error details' }));

    expect(writeText).toHaveBeenCalledWith(REPORT);
    expect(await findByRole('button', { name: 'Copied' })).not.toBeNull();
  });

  it('reveals the report for hand-selection when the clipboard is unavailable', async () => {
    // Without this the one thing the screen exists for — getting the report
    // off a locked-down machine — would be impossible on a browser with no
    // Clipboard API.
    // @ts-expect-error deleting an optional navigator member for this test
    delete navigator.clipboard;
    const { container, getByRole, findByRole } = renderCoded();

    fireEvent.click(getByRole('button', { name: 'Copy error details' }));

    expect(await findByRole('button', { name: 'Copy failed — select below' })).not.toBeNull();
    expect(container.querySelector('.first-run__error-report')?.textContent).toBe(REPORT);
  });

  it('reveals the report when the clipboard write is rejected (insecure context, denied permission)', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    const { container, getByRole, findByRole } = renderCoded();

    fireEvent.click(getByRole('button', { name: 'Copy error details' }));

    await findByRole('button', { name: 'Copy failed — select below' });
    expect(container.querySelector('.first-run__error-report')?.textContent).toBe(REPORT);
  });

  it('leaves the uncoded error screen exactly as it was — no code line, no copy button', () => {
    const { container, queryByRole } = render(
      <ErrorScreen
        errorHeadline="Modell konnte nicht geladen werden."
        errorMessage="network error"
        modelLoadFailed={false}
        onStartDownload={vi.fn()}
      />,
    );

    expect(container.querySelector('.first-run__error-code')).toBeNull();
    expect(queryByRole('button', { name: 'Copy error details' })).toBeNull();
  });

  it('omits the copy button when a code arrived without a report', () => {
    const { container, queryByRole } = renderCoded({ errorDetails: null });

    expect(container.querySelector('.first-run__error-code')?.textContent).toBe('AUDIO_DECODE_REJECTED');
    expect(queryByRole('button', { name: 'Copy error details' })).toBeNull();
  });
});
