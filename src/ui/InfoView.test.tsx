// @vitest-environment jsdom
/**
 * U5 (KTD8/KTD9/KTD10) — the info view's own render tests. `InfoView` is a
 * pure presentation component (no `deviceState`, no store beyond the
 * per-prompt copy-feedback state), so these tests just render it directly
 * with a stub `onClose` — `App.test.tsx` covers the surrounding wiring (the
 * "How it works" engraving's visibility, `Escape`, and the
 * Space-vs-`infoOpen` gate).
 *
 * Filenames asserted below (`transkript-sprecher.txt`/`transkript.txt`) were
 * verified against `src/output/writeSpeakerTranscripts.ts`'s
 * `DEFAULT_BASE_NAME` and `src/output/fileSink.ts`'s `DEFAULT_BASE_NAME`,
 * not guessed.
 */
import { cleanup, render, fireEvent, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InfoView } from './InfoView';
import { setLocale } from '../i18n/locale';

// The suite is pinned to German by default (`vitest.setup.ts`); any test here
// that moves the locale must restore it, or state leaks into the NEXT test
// file (same caution `length.test.ts`/`LocaleSwitch.test.tsx` already take).
afterEach(() => {
  cleanup();
  setLocale('de');
});

describe('InfoView', () => {
  it('renders the five architecture sentences as five separate list items (count, not wording)', () => {
    const { container } = render(<InfoView onClose={vi.fn()} />);
    const list = container.querySelector('ul.info-view__list');
    expect(list).not.toBeNull();
    expect(list!.querySelectorAll('li')).toHaveLength(5);
  });

  it('renders the three guide steps as three separate list items (count, not wording)', () => {
    const { container } = render(<InfoView onClose={vi.fn()} />);
    const list = container.querySelector('ol.info-view__list');
    expect(list).not.toBeNull();
    expect(list!.querySelectorAll('li')).toHaveLength(3);
  });

  it('the "Zurück" button calls onClose', () => {
    const onClose = vi.fn();
    const { getByRole } = render(<InfoView onClose={onClose} />);
    fireEvent.click(getByRole('button', { name: 'Zurück' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('both prompts are fully present, name the correct export filenames, and the speaker prompt carries the R9 boundary-error sentence', () => {
    const { container, getByText } = render(<InfoView onClose={vi.fn()} />);

    expect(getByText(/transkript-sprecher\.txt/)).not.toBeNull();
    expect(getByText(/transkript\.txt/)).not.toBeNull();

    const pres = container.querySelectorAll('pre.info-view__prompt-text');
    expect(pres).toHaveLength(2);
    const [speakerPre, simplePre] = Array.from(pres);

    // R9 — a characteristic turn of phrase, not the whole paragraph (survives
    // rewording elsewhere in the same prompt).
    expect(speakerPre.textContent).toContain('Korrigiere solche offensichtlichen Grenzfehler');
    expect(speakerPre.textContent).toContain('Im Anhang das Transkript einer Besprechung');
    expect(simplePre.textContent).toContain('Im Anhang das Transkript einer Aufnahme');
  });

  it('shows the KTD10 device-limit sentence, visibly near the prompts', () => {
    const { getByText } = render(<InfoView onClose={vi.fn()} />);
    expect(
      getByText('Dieser letzte Schritt verlässt dein Gerät — du entscheidest, was du wohin kopierst.'),
    ).not.toBeNull();
  });

  describe('copy buttons', () => {
    afterEach(() => {
      // @ts-expect-error — test-only cleanup of a property this suite defines itself
      delete navigator.clipboard;
    });

    it('calls navigator.clipboard.writeText with the exact prompt text and then shows the confirmation', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      const { container } = render(<InfoView onClose={vi.fn()} />);
      const prompt = container.querySelector<HTMLElement>('.info-view__prompt')!;
      const exactText = prompt.querySelector('pre')!.textContent;

      await fireEvent.click(within(prompt).getByRole('button', { name: /Kopieren/ }));

      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith(exactText);
      expect(await within(prompt).findByText('Kopiert.')).not.toBeNull();
    });

    it('a rejected clipboard promise leaves the prompt text visible and throws nothing, showing a failure instead', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('denied'));
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      const { container } = render(<InfoView onClose={vi.fn()} />);
      const prompt = container.querySelectorAll<HTMLElement>('.info-view__prompt')[1];
      const preText = prompt.querySelector('pre')!.textContent;

      expect(() => fireEvent.click(within(prompt).getByRole('button', { name: /Kopieren/ }))).not.toThrow();
      expect(await within(prompt).findByText('Kopieren fehlgeschlagen.')).not.toBeNull();
      // The text itself is untouched — still fully there for manual selection.
      expect(prompt.querySelector('pre')!.textContent).toBe(preText);
    });

    it('a missing navigator.clipboard shows the failure instead of throwing', async () => {
      // @ts-expect-error — simulating a browser/context with no Clipboard API at all
      delete navigator.clipboard;

      const { container } = render(<InfoView onClose={vi.fn()} />);
      const prompt = container.querySelector<HTMLElement>('.info-view__prompt')!;

      expect(() => fireEvent.click(within(prompt).getByRole('button', { name: /Kopieren/ }))).not.toThrow();
      expect(await within(prompt).findByText('Kopieren fehlgeschlagen.')).not.toBeNull();
    });
  });

  describe('locale', () => {
    afterEach(() => setLocale('de'));

    it('setLocale("fr") renders French text (spot check)', () => {
      setLocale('fr');
      const { getByText } = render(<InfoView onClose={vi.fn()} />);
      expect(getByText('Ce qui se passe ici')).not.toBeNull();
    });
  });
});
