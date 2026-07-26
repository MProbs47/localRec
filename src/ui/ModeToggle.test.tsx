// @vitest-environment jsdom
/**
 * U19: `ModeToggle`'s controlled behavior and a11y wiring. Pure
 * presentational component — no worker/audio — so this is a plain render
 * test in the same style as `RecordButton.test.tsx`.
 */
import { cleanup, render, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModeToggle } from './ModeToggle';

afterEach(() => {
  cleanup();
});

describe('ModeToggle', () => {
  it('marks the current value as checked and the other option as not', () => {
    const { getByRole } = render(<ModeToggle value="record" onChange={() => {}} />);
    expect(getByRole('radio', { name: 'Lokale Aufnahme' }).getAttribute('aria-checked')).toBe('true');
    expect(getByRole('radio', { name: 'Datei laden' }).getAttribute('aria-checked')).toBe('false');
  });

  it('fires onChange with the clicked option, never the currently-active one on a re-click', () => {
    const onChange = vi.fn();
    const { getByRole } = render(<ModeToggle value="record" onChange={onChange} />);

    fireEvent.click(getByRole('radio', { name: 'Datei laden' }));
    expect(onChange).toHaveBeenCalledWith('import');

    fireEvent.click(getByRole('radio', { name: 'Lokale Aufnahme' }));
    expect(onChange).toHaveBeenCalledWith('record');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('holds no state of its own — a click does not visually flip without the parent updating `value`', () => {
    const { getByRole } = render(<ModeToggle value="record" onChange={() => {}} />);
    fireEvent.click(getByRole('radio', { name: 'Datei laden' }));
    // No re-render happened (the fixed onChange above ignores the call), so
    // the component must still show the prop it was given, not flip itself.
    expect(getByRole('radio', { name: 'Lokale Aufnahme' }).getAttribute('aria-checked')).toBe('true');
  });

  it('ArrowRight/ArrowLeft move the selection between the offered options (roving radiogroup)', () => {
    const onChange = vi.fn();
    const { getByRole, rerender } = render(<ModeToggle value="record" onChange={onChange} />);

    fireEvent.keyDown(getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('import');

    // The component is controlled — it never updates itself, so the parent's
    // (here: the test's) re-render with the new `value` is what makes the
    // next ArrowLeft roving move relative to the new position.
    rerender(<ModeToggle value="import" onChange={onChange} />);
    fireEvent.keyDown(getByRole('radiogroup'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('record');
  });

  it('the resting-symbol buttons stay reachable via Tab/Enter with no extra wiring (native <button> semantics)', () => {
    const { getByRole } = render(<ModeToggle value="record" onChange={() => {}} />);
    const recordOption = getByRole('radio', { name: 'Lokale Aufnahme' });
    const importOption = getByRole('radio', { name: 'Datei laden' });
    expect(recordOption.tagName).toBe('BUTTON');
    expect(importOption.tagName).toBe('BUTTON');
    expect(recordOption.hasAttribute('disabled')).toBe(false);
    expect(importOption.hasAttribute('disabled')).toBe(false);
  });

  it('hides "Online Meeting" by default / when meetingAvailable is false (KTD-M3 graceful)', () => {
    const { queryByRole } = render(<ModeToggle value="record" onChange={() => {}} />);
    expect(queryByRole('radio', { name: 'Online Meeting' })).toBeNull();
    // The two-way switch is fully intact.
    expect(queryByRole('radio', { name: 'Lokale Aufnahme' })).not.toBeNull();
    expect(queryByRole('radio', { name: 'Datei laden' })).not.toBeNull();
  });

  it('offers "Online Meeting" as a third option when meetingAvailable is true', () => {
    const onChange = vi.fn();
    const { getByRole } = render(<ModeToggle value="record" onChange={onChange} meetingAvailable />);
    const meeting = getByRole('radio', { name: 'Online Meeting' });
    expect(meeting.tagName).toBe('BUTTON');
    fireEvent.click(meeting);
    expect(onChange).toHaveBeenCalledWith('meeting');
  });

  it('roves across all three options when meeting is available', () => {
    const onChange = vi.fn();
    const { getByRole } = render(<ModeToggle value="import" onChange={onChange} meetingAvailable />);
    // record | import | meeting — from import, ArrowRight → meeting.
    fireEvent.keyDown(getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('meeting');
  });
});
