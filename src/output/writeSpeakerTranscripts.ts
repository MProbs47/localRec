/**
 * U18/U21 (SD-2/SD-3): writes the speaker-labeled `.txt`/`.srt` transcript
 * through a `FileSink` (U9), once diarization + alignment (`align.ts`) have
 * produced the whole recording's `AlignedSegment[]`.
 *
 * **Why a one-shot full write, not the incremental append pattern
 * (`TxtWriter`/`SrtWriter`).** Diarization is post-hoc (KTD13,
 * `speakerTranscript.ts`'s own header) — speaker labels only exist after
 * `stop()`, once the whole recording's segments are aligned. There is no
 * "next segment" to append as it finalizes; the entire formatted content
 * (`formatTranscriptTextWithSpeakers`/`formatSrtWithSpeakers`) is known at
 * once. These are also brand-new output file names
 * (`<base>-sprecher.txt`/`.srt`, never touched by the live `<base>.txt`/`.srt`
 * writers), and `AppendableFile` only ever appends — it has no
 * truncate/overwrite — so a single `append()` of the complete encoded string
 * onto a fresh name is the correct fit, not a mismatch to work around.
 */
import type { AlignedSegment } from '../diarization/align';
import { formatSrtWithSpeakers, formatTranscriptTextWithSpeakers, type SpeakerNameResolver } from './speakerTranscript';
import type { FileSink } from './fileSink';

/** Same default as `RecordingCoordinator`'s `DEFAULT_BASE_NAME` (`session/recordingCoordinator.ts`) — kept independently here since exporting that private constant would introduce a cross-module coupling this module doesn't otherwise need. */
const DEFAULT_BASE_NAME = 'transkript';

export interface WriteSpeakerTranscriptsOptions {
  /** Base file name; outputs are `<baseName>-sprecher.txt`/`.srt`. Defaults to `'transkript'`. */
  baseName?: string;
  /** Resolves a 0-based speaker index to its display name — see `speakerTranscript.ts`. Defaults to `speakerLabel` ("Sprecher N"). */
  speakerName?: SpeakerNameResolver;
}

const encoder = new TextEncoder();

/**
 * Writes the whole speaker-labeled transcript to `<baseName>-sprecher.txt`
 * and `<baseName>-sprecher.srt` through `sink`, each opened once and written
 * once (see file header for why this is a one-shot full write rather than an
 * incremental append), then closed.
 */
export async function writeSpeakerTranscripts(
  sink: FileSink,
  segments: readonly AlignedSegment[],
  options: WriteSpeakerTranscriptsOptions = {},
): Promise<void> {
  const base = options.baseName ?? DEFAULT_BASE_NAME;

  const [txtFile, srtFile] = await Promise.all([
    sink.openFile(`${base}-sprecher.txt`),
    sink.openFile(`${base}-sprecher.srt`),
  ]);

  const txt = formatTranscriptTextWithSpeakers(segments, options.speakerName);
  const srt = formatSrtWithSpeakers(segments, options.speakerName);

  await txtFile.append(encoder.encode(txt));
  await srtFile.append(encoder.encode(srt));

  await Promise.all([txtFile.close(), srtFile.close()]);
}
