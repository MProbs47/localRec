// @vitest-environment jsdom
/**
 * U6 (R11, KTD11) — the consent sentence at the record-mode start button.
 * Rendered ONLY in the `ready` state (folder set, red button unlocked) —
 * `App.test.tsx`'s "record mode setup order (hardware test 01, finding 1)"
 * test already proves the start button itself still fires on a single
 * click with no intermediate step, so that regression lock lives there, not
 * here (see this unit's return-report for the exact test name).
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RecordSetupView } from './RecordSetupView';
import { setLocale } from '../i18n/locale';

afterEach(() => {
  cleanup();
  setLocale('de');
});

describe('RecordSetupView — consent note (U6)', () => {
  it('shows the consent sentence once a folder is set (ready state)', () => {
    const { getByText } = render(
      <RecordSetupView hasOutputTarget outputName="Testordner" onChooseFolder={() => {}} />,
    );
    expect(
      getByText('Mit dem Start bestätigst du: Alle Teilnehmenden wissen von der Aufnahme und sind einverstanden.'),
    ).not.toBeNull();
  });

  it('does NOT show the consent sentence while no folder is set (needs-folder state)', () => {
    const { queryByText } = render(
      <RecordSetupView hasOutputTarget={false} outputName={null} onChooseFolder={() => {}} />,
    );
    expect(queryByText(/Alle Teilnehmenden wissen von der Aufnahme/)).toBeNull();
  });

  it('shows the Italian sentence when the locale is Italian', () => {
    setLocale('it');
    const { getByText } = render(
      <RecordSetupView hasOutputTarget outputName="Testordner" onChooseFolder={() => {}} />,
    );
    expect(
      getByText("Con l'avvio confermi: tutti i partecipanti sono al corrente della registrazione e sono d'accordo."),
    ).not.toBeNull();
  });
});

describe('RecordSetupView — Firefox/Safari fallback-honesty fix', () => {
  it('shows the honest fallback note instead of "Speicherort gewählt" when sinkIsFallback is true', () => {
    const { getByText, queryByText } = render(
      <RecordSetupView hasOutputTarget outputName={null} onChooseFolder={() => {}} sinkIsFallback />,
    );
    expect(
      getByText('Kein direkter Ordner-Zugriff in diesem Browser — die Dateien gibt es am Ende als Download. Mikrofon freigegeben.'),
    ).not.toBeNull();
    expect(queryByText('Speicherort gewählt. Mikrofon freigegeben.')).toBeNull();
  });

  it('keeps the pre-existing "Speicherort gewählt" default when sinkIsFallback is false (default)', () => {
    const { getByText } = render(<RecordSetupView hasOutputTarget outputName={null} onChooseFolder={() => {}} />);
    expect(getByText('Speicherort gewählt. Mikrofon freigegeben.')).not.toBeNull();
  });

  it('prefers the fallback note over a folder name if both were somehow set', () => {
    const { getByText, queryByText } = render(
      <RecordSetupView hasOutputTarget outputName="Testordner" onChooseFolder={() => {}} sinkIsFallback />,
    );
    expect(queryByText(/Speicherort: Testordner/)).toBeNull();
    expect(getByText(/direkter Ordner-Zugriff/)).not.toBeNull();
  });
});
