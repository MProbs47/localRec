// @vitest-environment jsdom
/**
 * U4 part b (KTD17): the visible locale switcher — a `<select>` dropdown
 * since the owner's 2026-07-26 feedback (it was a cycle button: reaching
 * Spanish took four clicks through three languages you don't read). Pure
 * presentational component plus its `localStorage` bridge — same render-test
 * style as
 * `RecordButton.test.tsx`/`ModeToggle.test.tsx`. `afterEach` resets both the
 * locale store and `localStorage` so neither leaks into other test files —
 * the locale store is a module-level singleton (same caution `length.test.ts`
 * already takes), and a stray `meeting-recorder-locale` entry would make the
 * NEXT test file (or `main.tsx` in a real browser) start from the wrong
 * locale.
 */
import { cleanup, render, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleSwitch } from './LocaleSwitch';
import { t } from '../i18n';
import { setLocale } from '../i18n/locale';
import { readStoredLocale } from '../i18n/localeStorage';

// Kept in sync by hand with the private constant in `localeStorage.ts` — a
// direct `localStorage.getItem` assertion is the only way to prove the
// choice actually lands in storage (KTD17 test scenario), not just that
// `readStoredLocale()` echoes back whatever `writeStoredLocale()` wrote.
const STORAGE_KEY = 'meeting-recorder-locale';

afterEach(() => {
  cleanup();
  setLocale('de');
  localStorage.removeItem(STORAGE_KEY);
});

describe('LocaleSwitch', () => {
  it("shows the active locale's flag and preselects it in the dropdown", () => {
    const { getByRole, container } = render(<LocaleSwitch />);
    expect(getByRole('combobox')).toHaveValue('de');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('offers all five languages as two-letter codes in one open list', () => {
    const { getAllByRole } = render(<LocaleSwitch />);
    expect(getAllByRole('option').map((option) => (option as HTMLOptionElement).value)).toEqual([
      'de',
      'en',
      'it',
      'fr',
      'es',
    ]);
    // Owner feedback (2026-07-26): codes, not spelled-out names — device
    // lettering in the housing's corner.
    expect(getAllByRole('option').map((option) => option.textContent)).toEqual([
      'DE',
      'EN',
      'IT',
      'FR',
      'ES',
    ]);
  });

  it('any language is ONE selection away — no cycling through the ones in between', () => {
    const { getByRole } = render(<LocaleSwitch />);
    // de → es directly: the whole point of the dropdown (owner feedback).
    fireEvent.change(getByRole('combobox'), { target: { value: 'es' } });
    expect(getByRole('combobox')).toHaveValue('es');
    expect(t('record.startLabel')).toBe('Iniciar grabación');
  });

  it('switching the locale changes t() output (spot check)', () => {
    const { getByRole } = render(<LocaleSwitch />);
    expect(t('record.startLabel')).toBe('Aufnahme starten');
    fireEvent.change(getByRole('combobox'), { target: { value: 'en' } });
    expect(t('record.startLabel')).toBe('Start recording');
  });

  it('persists the choice to localStorage; the next start reads it back', () => {
    const { getByRole } = render(<LocaleSwitch />);
    fireEvent.change(getByRole('combobox'), { target: { value: 'en' } });
    expect(localStorage.getItem(STORAGE_KEY)).toBe('en');
    // Simulates "next start": a fresh read must surface exactly this, ahead
    // of whatever `navigator.language` would resolve to (main.tsx tries
    // storage first, see its own comment).
    expect(readStoredLocale()).toBe('en');
  });

  it('a thrown localStorage read never blocks startup — readStoredLocale() falls back to null instead of throwing', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked (private mode)');
    });
    expect(() => readStoredLocale()).not.toThrow();
    expect(readStoredLocale()).toBeNull();
    spy.mockRestore();
  });

  it('a thrown localStorage write never blocks a selection — the locale still switches', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked (private mode)');
    });
    const { getByRole } = render(<LocaleSwitch />);
    expect(() => fireEvent.change(getByRole('combobox'), { target: { value: 'en' } })).not.toThrow();
    expect(getByRole('combobox')).toHaveValue('en'); // the switch itself still happened
    spy.mockRestore();
  });

  it('an unknown/garbage stored value falls back to null (browser default wins) without throwing', () => {
    localStorage.setItem(STORAGE_KEY, 'xx-not-a-supported-locale');
    expect(() => readStoredLocale()).not.toThrow();
    expect(readStoredLocale()).toBeNull();
  });

  it('the dropdown names what it selects — the UI language, not the recording language (KTD14)', () => {
    const { getByRole } = render(<LocaleSwitch />);
    expect(getByRole('combobox').getAttribute('aria-label')).toBe('Sprache der Oberfläche');
  });
});
