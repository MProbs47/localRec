import { afterEach, describe, expect, it } from 'vitest';
import { interpolate, t } from './index';
import { setLocale } from './locale';

describe('interpolate', () => {
  it('replaces every occurrence of a supplied placeholder, not just the first', () => {
    expect(interpolate('{n} then {n} again', { n: 3 })).toBe('3 then 3 again');
  });

  it('leaves a placeholder untouched when no matching param was supplied', () => {
    expect(interpolate('Sprecher {n}')).toBe('Sprecher {n}');
    expect(interpolate('Sprecher {n}', {})).toBe('Sprecher {n}');
    expect(interpolate('{known} and {unknown}', { known: 'x' })).toBe('x and {unknown}');
  });

  it('never throws on an unmatched placeholder', () => {
    expect(() => interpolate('{missing}', { other: 1 })).not.toThrow();
  });
});

describe('t', () => {
  // The suite-wide German-locale pin lives in vitest.setup.ts; any test here
  // that moves the locale restores it, so state doesn't leak into other test
  // files.
  afterEach(() => {
    setLocale('de');
  });

  it('looks up the active locale’s table and interpolates params', () => {
    expect(t('speaker.label', { n: 1 })).toBe('Sprecher 1');
  });

  it('leaves an unknown/unsupplied placeholder untouched instead of throwing', () => {
    expect(() => t('speaker.label')).not.toThrow();
    expect(t('speaker.label')).toBe('Sprecher {n}');
  });

  it('setLocale("en") switches the next t() call; setLocale("de") restores it', () => {
    setLocale('en');
    expect(t('speaker.label', { n: 1 })).toBe('Speaker 1');
    setLocale('de');
    expect(t('speaker.label', { n: 1 })).toBe('Sprecher 1');
  });
});
