import { describe, expect, it } from 'vitest';
import { PREFERRED_RECORDER_MIME_TYPES, selectRecorderMimeType } from './recorder';

describe('selectRecorderMimeType (container/codec feature detection, R9)', () => {
  it('picks audio/webm;codecs=opus when the browser supports it (Chromium/Firefox desktop)', () => {
    const isTypeSupported = (type: string) => type === 'audio/webm;codecs=opus';
    expect(selectRecorderMimeType(isTypeSupported)).toBe('audio/webm;codecs=opus');
  });

  it('falls back to audio/mp4 when webm/opus is unsupported (Safari/iOS)', () => {
    const isTypeSupported = (type: string) => type === 'audio/mp4';
    expect(selectRecorderMimeType(isTypeSupported)).toBe('audio/mp4');
  });

  it('prefers webm/opus over mp4 when both happen to be supported', () => {
    expect(selectRecorderMimeType(() => true)).toBe('audio/webm;codecs=opus');
  });

  it('returns undefined when nothing in the preferred list is supported, so the caller lets MediaRecorder pick its own default', () => {
    expect(selectRecorderMimeType(() => false)).toBeUndefined();
  });

  it('documents the preference order: webm/opus before mp4', () => {
    expect(PREFERRED_RECORDER_MIME_TYPES[0]).toBe('audio/webm;codecs=opus');
    expect(PREFERRED_RECORDER_MIME_TYPES.at(-1)).toBe('audio/mp4');
  });
});
