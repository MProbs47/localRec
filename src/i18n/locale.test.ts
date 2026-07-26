import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, resolveLocale, setLocale, subscribeLocale } from './locale';

describe('resolveLocale', () => {
  it('takes the primary subtag of the first supported entry', () => {
    expect(resolveLocale(['de-CH', 'en'])).toBe('de');
    expect(resolveLocale(['fr-FR'])).toBe('fr');
    expect(resolveLocale(['it'])).toBe('it');
    expect(resolveLocale(['es-419'])).toBe('es');
    expect(resolveLocale(['en-GB'])).toBe('en');
  });

  it('falls back to "en" when nothing in the list is supported', () => {
    expect(resolveLocale(['pt-BR'])).toBe('en');
  });

  it('skips unsupported entries to find the first supported one, not just the first entry overall', () => {
    expect(resolveLocale(['pt-BR', 'it-IT'])).toBe('it');
  });

  it('never throws on empty/absent input — falls back to "en"', () => {
    expect(resolveLocale([])).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
  });
});

describe('locale store (getLocale/setLocale/subscribeLocale)', () => {
  // Every test in this file that moves the locale restores the KTD4 pin —
  // otherwise state leaks into whichever test file runs next.
  afterEach(() => {
    setLocale('de');
  });

  it('setLocale/getLocale round-trip', () => {
    setLocale('en');
    expect(getLocale()).toBe('en');
    setLocale('de');
    expect(getLocale()).toBe('de');
  });

  it('subscribeLocale fires only on an actual change, and its unsubscribe cleanly stops delivery', () => {
    setLocale('de');
    let calls = 0;
    const unsubscribe = subscribeLocale(() => {
      calls += 1;
    });

    setLocale('de'); // same value — no notification
    expect(calls).toBe(0);

    setLocale('en'); // real change — notifies once
    expect(calls).toBe(1);

    unsubscribe();
    setLocale('de'); // real change again, but after unsubscribe — no notification
    expect(calls).toBe(1);
  });
});
