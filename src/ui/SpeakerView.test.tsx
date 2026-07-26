// @vitest-environment jsdom
/**
 * U18: `SpeakerView`'s turn grouping + rename UI, proven against
 * `align.ts`'s `AlignedSegment` fixtures (no diarization model involved —
 * this component only ever sees the already-aligned result). Covers: turns
 * group consecutive same-speaker segments under the default "Sprecher N"
 * label; renaming a speaker relabels every one of that speaker's turns and
 * notifies `onRenameSpeaker`; an all-`null` fixture (SD-3 fallback) renders
 * with no speaker labels at all, same as a plain transcript; and an empty
 * fixture renders without crashing.
 */
import { cleanup, render, fireEvent, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeakerView } from './SpeakerView';
import type { AlignedSegment } from '../diarization/align';

afterEach(() => {
  cleanup();
});

const MULTI_SPEAKER_SEGMENTS: AlignedSegment[] = [
  { text: 'Hallo', startMs: 0, endMs: 1000, speaker: 0 },
  { text: 'wie geht es dir', startMs: 1000, endMs: 2000, speaker: 0 },
  { text: 'Mir geht es gut', startMs: 2000, endMs: 3000, speaker: 1 },
  { text: 'Und dir', startMs: 3000, endMs: 3500, speaker: 0 },
];

describe('SpeakerView', () => {
  it('groups consecutive same-speaker segments into turns under default "Sprecher N" labels', () => {
    const { container } = render(<SpeakerView segments={MULTI_SPEAKER_SEGMENTS} />);

    const turns = container.querySelectorAll('.speaker-view__turn');
    expect(turns).toHaveLength(3);

    expect(within(turns[0] as HTMLElement).getByText('Sprecher 1')).not.toBeNull();
    expect(turns[0]?.textContent).toContain('Hallo wie geht es dir');

    expect(within(turns[1] as HTMLElement).getByText('Sprecher 2')).not.toBeNull();
    expect(turns[1]?.textContent).toContain('Mir geht es gut');

    expect(within(turns[2] as HTMLElement).getByText('Sprecher 1')).not.toBeNull();
    expect(turns[2]?.textContent).toContain('Und dir');
  });

  it('renaming speaker 0 to "Anna" updates every one of speaker 0\'s turns immediately, and fires onRenameSpeaker', () => {
    const onRenameSpeaker = vi.fn();
    const { container, getAllByText, queryAllByText, getByLabelText } = render(
      <SpeakerView segments={MULTI_SPEAKER_SEGMENTS} onRenameSpeaker={onRenameSpeaker} />,
    );

    expect(getAllByText('Sprecher 1')).toHaveLength(2);

    const nameInput = getByLabelText('Name für Sprecher 1') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Anna' } });

    expect(queryAllByText('Sprecher 1')).toHaveLength(0);
    expect(getAllByText('Anna')).toHaveLength(2);
    // Speaker 1's turn is untouched.
    expect(container.querySelector('.speaker-view__turn:nth-of-type(2)')?.textContent).toContain('Sprecher 2');

    expect(onRenameSpeaker).toHaveBeenCalledTimes(1);
    expect(onRenameSpeaker).toHaveBeenCalledWith(0, 'Anna');
  });

  it('(SD-3 fallback) an all-null-speaker fixture renders text with no speaker labels and does not crash', () => {
    const segments: AlignedSegment[] = [
      { text: 'Ein Satz.', startMs: 0, endMs: 1000, speaker: null },
      { text: 'Noch einer.', startMs: 1000, endMs: 2000, speaker: null },
    ];

    const { container, queryByText } = render(<SpeakerView segments={segments} />);

    expect(queryByText(/Sprecher/)).toBeNull();
    const turns = container.querySelectorAll('.speaker-view__turn');
    expect(turns).toHaveLength(1);
    expect(turns[0]?.textContent).toContain('Ein Satz. Noch einer.');
  });

  it('renders an empty container without crashing when segments is empty', () => {
    const { container } = render(<SpeakerView segments={[]} />);

    expect(container.querySelector('.speaker-view')).not.toBeNull();
    expect(container.querySelectorAll('.speaker-view__turn')).toHaveLength(0);
  });
});
