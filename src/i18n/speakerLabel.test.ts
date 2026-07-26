import { describe, expect, it } from 'vitest';
import { speakerLabel } from './speakerLabel';

describe('speakerLabel', () => {
  it('is 1-based for humans', () => {
    expect(speakerLabel(0)).toBe('Sprecher 1');
    expect(speakerLabel(2)).toBe('Sprecher 3');
  });
});
