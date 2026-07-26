/**
 * U17 alignment core (SD-2, KTD13): attach a speaker to each finalized
 * transcript segment by maximum time-overlap with the diarization timeline.
 * Pure and model-free — the transcript's own global timestamps (Whisper's
 * native `[startMs, endMs)`, plan 002) never change; a speaker is only
 * *added*. A segment that spans a speaker boundary goes to the speaker it
 * overlaps most (by total overlapped milliseconds).
 *
 * No timeline (diarization skipped / model absent, SD-3) → every segment gets
 * `speaker: null`, and the speaker-aware writers fall straight back to their
 * pre-Phase-D output.
 */
import type { SpeakerTimeline } from './types';

/** The minimal transcript-segment shape alignment needs — a time-bounded piece of text. */
export interface TimedTextSegment {
  text: string;
  startMs: number;
  endMs: number;
}

/** A transcript segment with its assigned speaker (0-based), or `null` when no speaker overlaps it. */
export interface AlignedSegment extends TimedTextSegment {
  speaker: number | null;
}

/** Overlap in ms between two half-open ranges (0 if disjoint). */
function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * The speaker whose turns overlap `[startMs, endMs)` the most, or `null` if
 * the timeline is empty or nothing overlaps. Ties resolve to the lower speaker
 * index (deterministic).
 */
export function assignSpeaker(segment: { startMs: number; endMs: number }, timeline: SpeakerTimeline): number | null {
  const overlapBySpeaker = new Map<number, number>();
  for (const turn of timeline) {
    const o = overlapMs(segment.startMs, segment.endMs, turn.startMs, turn.endMs);
    if (o > 0) overlapBySpeaker.set(turn.speaker, (overlapBySpeaker.get(turn.speaker) ?? 0) + o);
  }

  let best: number | null = null;
  let bestOverlap = 0;
  for (const [speaker, total] of overlapBySpeaker) {
    if (total > bestOverlap || (total === bestOverlap && best !== null && speaker < best)) {
      bestOverlap = total;
      best = speaker;
    }
  }
  return best;
}

/** Assigns a speaker to every transcript segment (see `assignSpeaker`); timestamps and text pass through untouched. */
export function alignTranscript(
  segments: readonly TimedTextSegment[],
  timeline: SpeakerTimeline,
): AlignedSegment[] {
  return segments.map((s) => ({ ...s, speaker: assignSpeaker(s, timeline) }));
}
