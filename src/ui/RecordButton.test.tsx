// @vitest-environment jsdom
/**
 * U12 §5: the record button's structure and its play↔stop symbol swap.
 * Pure presentational component — no worker/audio, so this is a plain render
 * test. Geometry lives in theme.css and isn't asserted here (jsdom has no
 * layout); what matters is that the right symbol and the right a11y state
 * render for each mode, and that clicks fire while enabled/disabled.
 */
import { cleanup, render, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordButton } from './RecordButton';

afterEach(() => {
  cleanup();
});

describe('RecordButton', () => {
  it('shows the resting symbol (black disc + red play triangle) and start label when not recording', () => {
    const { container, getByRole } = render(<RecordButton recording={false} onClick={() => {}} />);
    expect(container.querySelector('.record-button__play')).not.toBeNull();
    expect(container.querySelector('.record-button__square')).toBeNull();
    const button = getByRole('button');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Aufnahme starten');
  });

  it('shows the red stop square and stop label when recording', () => {
    const { container, getByRole } = render(<RecordButton recording onClick={() => {}} />);
    expect(container.querySelector('.record-button__square')).not.toBeNull();
    expect(container.querySelector('.record-button__play')).toBeNull();
    const button = getByRole('button');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Aufnahme stoppen');
  });

  // Owner feedback (2026-07-26): while an imported file is being processed the
  // device IS busy with audio, so it must not offer a play triangle — but the
  // symbol is all that changes. `processing` must never claim the button is
  // pressed or rename it to "stop": there is no abort for an import, and the
  // parent keeps it disabled throughout.
  it('shows the stop square while processing, without touching the a11y state', () => {
    const { container, getByRole } = render(<RecordButton recording={false} processing onClick={() => {}} />);
    expect(container.querySelector('.record-button__square')).not.toBeNull();
    expect(container.querySelector('.record-button__play')).toBeNull();
    const button = getByRole('button');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Aufnahme starten');
  });

  it('fires onClick when enabled and never when disabled', () => {
    const onClick = vi.fn();
    const { getByRole, rerender } = render(<RecordButton recording={false} onClick={onClick} />);
    fireEvent.click(getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<RecordButton recording={false} disabled onClick={onClick} />);
    expect((getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1); // still 1 — disabled swallows the click
  });
});
