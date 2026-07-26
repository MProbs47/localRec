// @vitest-environment jsdom
/**
 * U6 (R11, KTD11) — the consent sentence at the meeting-mode start button.
 * Rendered ONLY in the `ready` state (folder set), same key and same
 * reasoning as `RecordSetupView.test.tsx`.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MeetingView } from './MeetingView';
import { setLocale } from '../i18n/locale';

afterEach(() => {
  cleanup();
  setLocale('de');
});

describe('MeetingView — consent note (U6)', () => {
  it('shows the consent sentence once a folder is set (ready state)', () => {
    const { getByText } = render(
      <MeetingView hasOutputTarget onChooseFolder={() => {}} hint={null} />,
    );
    expect(
      getByText('Mit dem Start bestätigst du: Alle Teilnehmenden wissen von der Aufnahme und sind einverstanden.'),
    ).not.toBeNull();
  });

  it('does NOT show the consent sentence while no folder is set (needs-folder state)', () => {
    const { queryByText } = render(
      <MeetingView hasOutputTarget={false} onChooseFolder={() => {}} hint={null} />,
    );
    expect(queryByText(/Alle Teilnehmenden wissen von der Aufnahme/)).toBeNull();
  });

  it('shows the Italian sentence when the locale is Italian', () => {
    setLocale('it');
    const { getByText } = render(
      <MeetingView hasOutputTarget onChooseFolder={() => {}} hint={null} />,
    );
    expect(
      getByText("Con l'avvio confermi: tutti i partecipanti sono al corrente della registrazione e sono d'accordo."),
    ).not.toBeNull();
  });
});
