// @vitest-environment jsdom
/**
 * The in-call screen's one interruption: the mic-silence warning (owner
 * feedback 2026-07-27 — a meeting recorded with only the other person's
 * voice in it, because a Bluetooth headset's microphone silently delivered
 * nothing and the summed VU meter kept moving).
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MeetingRecordingView } from './MeetingRecordingView';
import { setLocale } from '../i18n/locale';

afterEach(() => {
  cleanup();
  setLocale('de');
});

describe('MeetingRecordingView', () => {
  it('shows the ordinary hint while the mic is delivering signal', () => {
    const { getByText, queryByText } = render(<MeetingRecordingView />);

    expect(getByText(/Mikro \+ Meeting-Ton werden mitgeschnitten/)).not.toBeNull();
    expect(queryByText(/Kein Signal vom Mikrofon/)).toBeNull();
  });

  it('replaces that hint with the warning once the mic watch reported silence', () => {
    const { getByText, queryByText } = render(<MeetingRecordingView micSilent />);

    expect(getByText(/Kein Signal vom Mikrofon/)).not.toBeNull();
    // Replaced, not stacked: "recording is running" is still true but much
    // less important than "your own voice isn't in it" (see the component).
    expect(queryByText(/Mikro \+ Meeting-Ton werden mitgeschnitten/)).toBeNull();
  });

  it('keeps saying the recording is running — the warning never implies it stopped', () => {
    const { container, getByText } = render(<MeetingRecordingView micSilent />);

    // The headline still reads "Aufnahme läuft" …
    expect(container.querySelector('.meeting-recording__label')?.textContent).toContain('Aufnahme läuft');
    // … and the warning itself says so a second time, so nobody reads it as "stopped".
    expect(getByText(/Aufnahme läuft weiter/)).not.toBeNull();
  });
});
