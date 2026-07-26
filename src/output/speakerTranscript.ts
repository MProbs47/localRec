/**
 * U17 speaker-labeled output (SD-2). Diarization is post-hoc (KTD13): speaker
 * labels only exist *after* stop, once `diarize.ts` + `align.ts` have run over
 * the whole recording. So this is a **full-write** enrichment — it re-renders
 * the complete `.txt`/`.srt` from aligned segments — not the live incremental
 * `TxtWriter`/`SrtWriter` path (which stays speaker-unaware).
 *
 * Kept as its own module (the plan's "oder Sprecher-Varianten" option) so the
 * base writers in `txtWriter.ts`/`srtWriter.ts` know nothing about speakers;
 * this module composes their pure cores with the diarization label.
 *
 * SD-3 fallback: segments whose `speaker` is `null` (diarization skipped /
 * model absent) render with no label — an all-`null` transcript reproduces the
 * exact speaker-less output, so a missing diarization model changes nothing.
 */
import type { AlignedSegment } from '../diarization/align';
import { speakerLabel } from '../i18n/speakerLabel';
import { formatSrtCue } from './srtWriter';

/** Resolves a 0-based speaker index to its display name. Defaults to "Sprecher N" (U18 rename passes a custom map). */
export type SpeakerNameResolver = (speaker: number) => string;

function prefixFor(speaker: number | null, speakerName: SpeakerNameResolver): string {
  return speaker === null ? '' : `${speakerName(speaker)}: `;
}

/**
 * The whole `.txt` as continuous reading text, grouped into one line per
 * speaker turn: consecutive same-speaker segments join with spaces under a
 * single "Name: …" prefix; a speaker change starts a new line. `null`-speaker
 * runs get a line with no prefix (SD-3), so an all-`null` transcript is exactly
 * the plain continuous text `formatTranscriptText` would produce.
 */
export function formatTranscriptTextWithSpeakers(
  segments: readonly AlignedSegment[],
  speakerName: SpeakerNameResolver = speakerLabel,
): string {
  const lines: string[] = [];
  let currentSpeaker: number | null | undefined;
  let currentText = '';

  const flush = () => {
    if (currentText.length > 0) lines.push(prefixFor(currentSpeaker as number | null, speakerName) + currentText);
  };

  for (const segment of segments) {
    const text = segment.text.trim();
    if (text.length === 0) continue;
    if (segment.speaker !== currentSpeaker) {
      flush();
      currentSpeaker = segment.speaker;
      currentText = text;
    } else {
      currentText += ` ${text}`;
    }
  }
  flush();
  return lines.join('\n');
}

/**
 * The whole `.srt`, one numbered cue per segment, each cue's text prefixed
 * with "Name: " (a `null` speaker → no prefix, identical to the plain cue).
 * Reuses `srtWriter.ts`'s pure `formatSrtCue` so timestamp/numbering rules
 * stay in one place.
 */
export function formatSrtWithSpeakers(
  segments: readonly AlignedSegment[],
  speakerName: SpeakerNameResolver = speakerLabel,
): string {
  return segments
    .map((segment, index) =>
      formatSrtCue(index + 1, {
        text: prefixFor(segment.speaker, speakerName) + segment.text.trim(),
        startMs: segment.startMs,
        endMs: segment.endMs,
      }),
    )
    .join('');
}
