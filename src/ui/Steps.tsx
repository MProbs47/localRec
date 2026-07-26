import type { DeviceState } from '../App';
import { t } from '../i18n';
import type { Mode } from './ModeToggle';

interface StepsProps {
  deviceState: DeviceState;
  modelReady: boolean;
  hasOutputTarget: boolean;
  finalizing: boolean;
  outputName: string | null;
  /** U20b: which landing mode the checklist should describe — record vs. import share the same visual language but different step labels. */
  mode: Mode;
  /** Phase D (U18/U21): the annotate-stage status, so step 03 doesn't show "Fertig ✓" while diarization is still running. */
  annotation: 'idle' | 'running' | 'done' | 'skipped';
}

/**
 * The three-line status list by the line-in jack (§3). It carries checklists
 * that share the same visual language but adapt to the active `mode` (U20b):
 *  - **Record setup** (idle → recording): Modell geladen · Speicherort · Aufnahme.
 *    "Speicherort" is only ✓ once a folder is actually chosen (it isn't before
 *    the first record — the picker appears then), so it honestly tells the user
 *    a folder choice is coming (§4) instead of a premature checkmark.
 *  - **Import setup** (idle → importing): Modell geladen · Speicherort ·
 *    Datei transkribieren — the import path chooses the folder BEFORE the file
 *    (the gesture trap, U20b decision A), and step 03 becomes the running
 *    transcription while `deviceState === 'importing'`.
 *  - **Finalize** (stopped): the headline reflects how we got here (recording
 *    stopped vs. import finished), then wird gespeichert / gespeichert in
 *    «Ordner» · fertig (§7). The middle/last lines flip to ✓ when `finalizing`
 *    clears (imports finalize synchronously, so they land already done).
 *
 * U8: moved out of `App.tsx` verbatim, together with `StepRow` — this has real
 * checklist logic (computed from state), it is not a pass-through.
 */
export function Steps({ deviceState, modelReady, hasOutputTarget, finalizing, outputName, mode, annotation }: StepsProps) {
  const isImport = mode === 'import';

  if (deviceState === 'stopped') {
    const savedLabel = outputName ? t('steps.savedIn', { folder: outputName }) : t('steps.saved');
    // Step 03 reflects the annotate stage so it never shows "Fertig ✓" while
    // diarization is still running.
    // The trailing ellipsis is this list's own in-progress typography (see
    // `steps.saving`/`steps.transcribingFile`), not part of the sentence —
    // so it's appended here instead of living in the shared
    // `annotation.detecting` key, which `StoppedScreen` renders with
    // animated `<RecordingDots />` instead. One key, each site's own decoration.
    const step03 =
      annotation === 'running'
        ? { label: `${t('annotation.detecting')} …`, done: false, active: true }
        : annotation === 'done'
          ? { label: t('steps.speakersDetected'), done: true, active: false }
          : { label: t('steps.finishedSaved'), done: !finalizing, active: false };
    return (
      <div className="steps" aria-hidden="true">
        <StepRow num="01" label={isImport ? t('steps.transcriptionDone') : t('steps.recordingStopped')} done />
        <StepRow
          num="02"
          label={finalizing ? t('steps.saving') : savedLabel}
          done={!finalizing}
          active={finalizing}
        />
        <StepRow num="03" label={step03.label} done={step03.done} active={step03.active} />
      </div>
    );
  }

  // Before the model load is even started, show a plain "to do" list — no
  // checks, no active marker. A ✓ on "Speicherort" while the model is still
  // unloaded (a restored folder from R6) reads as inconsistent on the very
  // first screen, so status only appears from `downloading` onward.
  const showStatus = deviceState !== 'idle';
  const ready = deviceState === 'ready';

  if (isImport) {
    // Import setup + progress: folder is chosen BEFORE the file (decision A),
    // and step 03 turns into the running transcription while `importing`.
    const transcribing = deviceState === 'importing';
    return (
      <div className="steps" aria-hidden="true">
        <StepRow num="01" label={t('steps.modelLoaded')} done={showStatus && modelReady} />
        <StepRow
          num="02"
          label={showStatus && hasOutputTarget ? t('steps.locationSet') : t('steps.locationChooseFolder')}
          done={showStatus && hasOutputTarget}
          active={ready && !hasOutputTarget}
        />
        <StepRow
          num="03"
          label={transcribing ? t('steps.transcribingFile') : t('steps.pickAndTranscribe')}
          active={transcribing || (ready && hasOutputTarget)}
        />
      </div>
    );
  }

  if (mode === 'meeting') {
    // Meeting setup: folder-first like import (KTD-M6), then the start-click
    // captures mic + system audio. After stop, the recording runs through the
    // shared post-hoc pipeline (`deviceState === 'importing'`) — step 03 shows
    // that work (hardware test 01, finding: the big screen said "Transkription
    // läuft" while this list still read "Meeting aufnehmen").
    const transcribing = deviceState === 'importing';
    return (
      <div className="steps" aria-hidden="true">
        <StepRow num="01" label={t('steps.modelLoaded')} done={showStatus && modelReady} />
        <StepRow
          num="02"
          label={showStatus && hasOutputTarget ? t('steps.locationSet') : t('steps.locationChooseFolder')}
          done={showStatus && hasOutputTarget}
          active={ready && !hasOutputTarget}
        />
        <StepRow
          num="03"
          label={transcribing ? t('steps.meetingTranscribing') : t('steps.recordMeeting')}
          active={transcribing || (ready && hasOutputTarget)}
        />
      </div>
    );
  }

  return (
    <div className="steps" aria-hidden="true">
      <StepRow num="01" label={t('steps.modelLoaded')} done={showStatus && modelReady} />
      <StepRow
        num="02"
        label={showStatus && hasOutputTarget ? t('steps.locationSet') : t('steps.locationChooseAtStart')}
        done={showStatus && hasOutputTarget}
        active={ready && !hasOutputTarget}
      />
      <StepRow num="03" label={t('steps.recording')} active={ready && hasOutputTarget} />
    </div>
  );
}

/** One line of the status list: a number (or an active square marker) + label + optional ✓. */
function StepRow({
  num,
  label,
  done = false,
  active = false,
}: {
  num: string;
  label: string;
  done?: boolean;
  active?: boolean;
}) {
  return (
    <div className="step">
      {active ? <span className="step__marker" /> : <span className="step__num">{num}</span>}
      <span>{label}</span>
      <span className="step__check">{done ? '✓' : ''}</span>
    </div>
  );
}
