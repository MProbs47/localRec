/**
 * U18: the speaker-labeled transcript display + rename UI (SD-2). Sits on
 * top of `align.ts`'s `AlignedSegment[]` — the same post-hoc alignment
 * result `speakerTranscript.ts` renders to `.txt`/`.srt` — so this is a pure
 * display+rename surface, not a second source of truth: it groups
 * consecutive same-speaker segments into turns using the identical rule as
 * `speakerTranscript.ts`'s `formatTranscriptTextWithSpeakers` (join with
 * spaces, skip empty/whitespace-only text, a speaker change starts a new
 * turn), so what's shown on screen and what ends up in the exported file
 * never disagree.
 *
 * **Names are user-correctable, not absolute truth (KTD13/SD-2).** Speaker
 * indices come from unsupervised clustering — "Sprecher 1"/"Sprecher 2" are
 * `speakerLabel`'s placeholder defaults (`i18n/speakerLabel.ts`), not identities. This
 * component keeps a local `Map<number, string>` of overrides so a rename
 * relabels every turn of that speaker immediately; `onRenameSpeaker` lets
 * `App.tsx` persist the mapping into the export (e.g. re-running
 * `speakerTranscript.ts`'s writers with a custom `SpeakerNameResolver`) —
 * this component itself does no persistence.
 *
 * SD-3 fallback: a `speaker === null` turn (no diarization timeline —
 * skipped or model absent) renders with no name label at all, so an
 * all-`null` transcript reads exactly like a plain, speaker-unaware one.
 *
 * Functionally-neutral (semantic class names only; theme.css, U12, owns the
 * visuals) — same posture as `LiveTranscript.tsx`/`StorageManager.tsx`.
 */
import { useState, type ChangeEvent } from 'react';
import type { AlignedSegment } from '../diarization/align';
import { speakerLabel } from '../i18n/speakerLabel';
import { t } from '../i18n';

export interface SpeakerViewProps {
  /** The aligned diarization result, already ordered by time (see `align.ts`). */
  segments: readonly AlignedSegment[];
  /** Called with (speaker, newName) when the user renames a speaker via the roster below. Optional — the component works fully without it. */
  onRenameSpeaker?: (speaker: number, name: string) => void;
  className?: string;
}

interface Turn {
  speaker: number | null;
  text: string;
}

/**
 * Groups consecutive same-speaker segments into turns — the identical rule
 * `speakerTranscript.ts`'s `formatTranscriptTextWithSpeakers` uses, kept in
 * lockstep on purpose (see file header).
 */
function groupTurns(segments: readonly AlignedSegment[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const segment of segments) {
    const text = segment.text.trim();
    if (text.length === 0) continue;
    if (current && segment.speaker === current.speaker) {
      current.text += ` ${text}`;
    } else {
      current = { speaker: segment.speaker, text };
      turns.push(current);
    }
  }
  return turns;
}

/** Distinct non-null speakers, in order of first appearance — the roster the rename controls are built from. */
function distinctSpeakers(turns: readonly Turn[]): number[] {
  const seen = new Set<number>();
  const order: number[] = [];
  for (const turn of turns) {
    if (turn.speaker === null || seen.has(turn.speaker)) continue;
    seen.add(turn.speaker);
    order.push(turn.speaker);
  }
  return order;
}

export function SpeakerView({ segments, onRenameSpeaker, className }: SpeakerViewProps) {
  const [names, setNames] = useState<Map<number, string>>(new Map());

  const turns = groupTurns(segments);
  const speakers = distinctSpeakers(turns);

  const displayName = (speaker: number) => names.get(speaker) ?? speakerLabel(speaker);

  const handleRename = (speaker: number) => (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setNames((prev) => new Map(prev).set(speaker, value));
    onRenameSpeaker?.(speaker, value);
  };

  const rootClassName = ['speaker-view', className].filter(Boolean).join(' ');

  return (
    <div className={rootClassName}>
      {speakers.length > 0 && (
        <ul className="speaker-view__roster">
          {speakers.map((speaker) => {
            const inputId = `speaker-view__name-${speaker}`;
            return (
              <li key={speaker} className="speaker-view__roster-item">
                <label htmlFor={inputId}>{t('speaker.nameForLabel', { label: speakerLabel(speaker) })}</label>
                <input
                  id={inputId}
                  type="text"
                  className="speaker-view__name-input"
                  value={displayName(speaker)}
                  onChange={handleRename(speaker)}
                />
              </li>
            );
          })}
        </ul>
      )}

      <div className="speaker-view__turns">
        {turns.map((turn, index) => (
          <p key={index} className="speaker-view__turn">
            {turn.speaker !== null && <strong className="speaker-view__turn-name">{displayName(turn.speaker)}</strong>}
            <span className="speaker-view__turn-text">{turn.text}</span>
          </p>
        ))}
      </div>
    </div>
  );
}
