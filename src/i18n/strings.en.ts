/**
 * Canonical string table and TYPE SOURCE for the i18n core (KTD2, Owner
 * decision "international first"): `index.ts` derives
 * `export type StringKey = keyof typeof en`, so every other language's
 * table (`de.ts` here; `it`/`fr`/`es` from U4) is checked against this one
 * — a missing or extra key anywhere else is a compile error, not a silent
 * runtime fallback. `npm run typecheck` is the completeness proof; no sync
 * test needed.
 *
 * Flat, grouped-by-origin key names (`speaker.label`, `engine.…`,
 * `format.…`) — no nested objects. Placeholders are `{name}`.
 *
 * The table grew in parts across U3/U4 — Part a (`src/diarization/align.ts`,
 * `src/ui/format.ts`, `src/engine/engine.ts`), Part b (`src/App.tsx`), Part c
 * (`src/ui/*.tsx`) below — and is complete now: every key any component
 * needs, plus the `it`/`fr`/`es` tables (`strings.it.ts`/`strings.fr.ts`/
 * `strings.es.ts`).
 */
export const en = {
  'speaker.label': 'Speaker {n}',

  'engine.modelStalled':
    'Model loading is no longer responding — please reload the page and try again.',
  'engine.webgpuUnsupported':
    "This device or browser doesn't support WebGPU — transcription can't run here. A current Chrome or Edge is required.",
  // Code-review Befund 4: the transcription worker's `error` event handler
  // (`engine.ts`) — a worker that dies (module-load failure, uncaught async
  // throw) surfaces as this `failed`-status message, which lands directly on
  // the user-facing ErrorScreen. Two keys, not one with an optional
  // placeholder: `detail` (the browser's `ErrorEvent.message`) isn't always
  // present.
  'engine.workerCrashed': 'Transcription worker crashed.',
  'engine.workerCrashedDetail': 'Transcription worker crashed: {detail}',

  // Device-label characters, not language (Owner decision, plan open
  // point 4): extracted for key-completeness so every locale is forced to
  // supply them, but deliberately NOT translated — they read the same in
  // all five tables.
  'format.hours': 'H',
  'format.minutes': 'MIN',

  // --- Part b of U3 (`src/App.tsx`) ---------------------------------------

  // The device brand "localRec", split across two JSX text nodes for the
  // accent-styled second half (`.device__title-rec`) — an unübersetzter
  // device label (KTD6 open point 4), not language, so it reads the same in
  // all five tables. Two keys because it's two literal text nodes, not one.
  'header.brandLocal': 'local',
  'header.brandRec': 'Rec',
  'header.subtitleTagline': 'Transcription that never leaves your device',
  'header.subtitleFlightMode': 'Switch on flight mode. It keeps running.',

  // The mic-level column's caption, next to the VU meter.
  'device.micCaption': 'Microphone',
  // Device chrome — status/technical labels, not prose (rule 4): kept as-is
  // in every locale, same reasoning as `format.hours`/`format.minutes` above.
  'device.recBadge': 'REC',
  'device.status': 'WEBGPU · NET 0',

  // Model-load error screen. ONE key for three call sites: the initial
  // `errorHeadline` state, its reset in the engine-status effect, and the
  // detail-line fallback shown when Engine reports no error string of its
  // own. Those were three literals differing only by a trailing period;
  // KTD6 approach step 4 unifies them, and unifying the *text* without
  // unifying the *key* would just move the duplication into five tables.
  'error.modelLoadHeadline': 'The model could not be loaded.',
  'error.importFailedHeadline': 'Processing failed.',
  'error.importFailedDetailFallback': 'The audio could not be processed',

  // Fallback shown next to `annotationError` when a diarization failure has
  // no usable `Error.message`.
  'annotation.unknownErrorFallback': 'unknown error',

  // Plan 003 meeting-mode start failures — short retry hints, not blocking
  // errors (a plain cancel stays silent, no hint at all).
  'meeting.noSystemAudioHint':
    'No system audio received — when sharing, check "Share audio" and start again.',
  'meeting.captureFailedHint': 'System audio could not be captured.',

  // --- Part c of U3 (`src/ui/*.tsx` extraction) ---------------------------

  // `DemoLoop.tsx`'s looping reference-render text. ALL CAPS in every table —
  // `DemoLoop`'s typewriter slices these character-by-character
  // (`line.length`), so a locale's translation is free to run longer/shorter
  // but must NOT be casing-normalized against the source (that's a display
  // transform, not a translation choice; see the component's own comment).
  'demo.line1': 'NO DATA EVER LEAVES YOUR DEVICE.',
  'demo.line2': 'LOAD THE MODEL ONCE — ~1.5 GB.',
  'demo.line3': 'THEN FLIGHT MODE. IT KEEPS RUNNING.',
  'demo.line4': 'PRESS RECORD AND SPEAK',

  // The footer's decorative jack (`LineInJack.tsx`) — device chrome, not
  // prose (rule 4), same reasoning as `device.recBadge`.
  'device.lineInLabel': 'LINE IN',

  // `FirstRunScreens.tsx` — the four `first-run`-wrapped screens.
  'firstRun.idleMessage':
    'Download ~1.5 GB once. After that everything runs offline on your device — nothing is ever sent.',
  'firstRun.startDownload': 'Load model',
  'firstRun.downloadingMessage': 'Loading the model. Only once.',
  'firstRun.downloadProgress': '{mb} MB / ~1500 MB · {pct}%',
  'firstRun.decodingLabel': 'Decoding file',
  'firstRun.transcribingLabel': 'Transcription running',
  'firstRun.elapsedSince': 'running for {elapsed}',
  'firstRun.longRunningNote':
    'Long recordings take a few minutes — it keeps running in the background.',

  // Shared across `FirstRunScreens.tsx`'s `ErrorScreen` and
  // `MicDeniedScreen.tsx` — same button, same action, one key (approach
  // step 4).
  'common.retry': 'Try again',

  // `ImportView.tsx`.
  'import.needsFolderMessage':
    'Choose a storage location first — the transcription is written there.',
  'import.message':
    'Load an existing audio file — processed fully on-device. Nothing leaves your device.',
  'import.pickFile': 'Choose file',
  'import.selected': 'Selected: «{name}» — processing …',

  // Shared "Ordner wählen" key (approach step 4) — `ImportView.tsx`'s and
  // `MeetingView.tsx`'s folder-first gate button. One key, one call site's
  // worth of meaning: "choose the output folder".
  'setup.chooseFolder': 'Choose folder',

  // `LanguageSelect.tsx` — KTD14: this label was `Sprache` before U3; U4
  // introduces a separate UI-language switcher, and "Sprache" said twice on
  // one screen would mean two different things. Owner-confirmed sharper
  // label: it selects the RECORDING's language, not the UI's.
  'language.label': 'Recording language',
  // Only this one is actually translated (the "auto-detect" choice).
  'language.auto': 'Automatic',
  // The remaining five are language names spoken in their own language
  // (Whisper language tokens' human names) — kept BYTE-IDENTICAL across all
  // five locale tables on purpose, never translated.
  'language.de': 'Deutsch',
  'language.en': 'English',
  'language.it': 'Italiano',
  'language.fr': 'Français',
  'language.es': 'Español',

  // --- U4 part b (`src/ui/LocaleSwitch.tsx`) ------------------------------

  // The visible UI-language switcher's accessible name (and tooltip). Names
  // WHAT the control selects, not the individual choices — those are the
  // `language.*` names just above, each in its own language, listed inside
  // the dropdown. Must read as clearly distinct from `language.label` (the
  // RECORDING language, a different control on a different surface, KTD14).
  'localeSwitch.label': 'Interface language',

  // `LiveTranscript.tsx`'s "jump back to newest" button — device chrome
  // (rule 4), kept in all-caps like `device.recBadge`.
  'transcript.jumpToLive': '↓ LIVE',

  // `MeetingRecordingView.tsx`.
  'meeting.recordingLabel': 'Recording',
  'meeting.recordingHint':
    'Mic + meeting audio are being captured. Transcription & speakers follow after stop.',

  // `MeetingView.tsx`.
  'meeting.needsFolderMessage': 'Choose a storage location first — then start the meeting.',
  'meeting.shareInstruction': 'Press "Record", then in the share dialog choose "Entire screen" and check "Share audio".',
  'meeting.aside': 'Headphones recommended — otherwise the mic picks up the speaker twice.',

  // `MicDeniedScreen.tsx`.
  'mic.deniedHeadline': 'Microphone access denied.',
  'mic.deniedDetail': 'Please allow microphone access in the browser, then try again.',

  // `ModeToggle.tsx`.
  'mode.ariaLabel': 'Input source',
  'mode.record': 'Local recording',
  'mode.import': 'Load file',
  'mode.meeting': 'Online meeting',

  // `RecordButton.tsx`.
  'record.startLabel': 'Start recording',
  'record.stopLabel': 'Stop recording',

  // `RecordSetupView.tsx` — note its "Speicherort wählen" is its OWN key
  // (`setup.chooseLocation`), deliberately not merged with the shared
  // `setup.chooseFolder` above: the literal text differs today
  // ("Speicherort" vs. "Ordner"), so merging would change one of the two
  // screens' wording — out of scope for a zero-visible-change extraction.
  'setup.micFolderMessage':
    'First choose the storage location and allow the microphone — then start the recording with the red button in the middle.',
  'setup.chooseLocation': 'Choose location',
  'setup.writeNote': 'Transcript and audio are written continuously into this folder.',
  'setup.readyMessage': 'Ready. Start the recording with the red button in the middle.',
  'setup.readyNoteWithFolder': 'Storage location: {folder} Microphone allowed.',
  'setup.readyNoteDefault': 'Storage location chosen. Microphone allowed.',

  // `RecoveryScreen.tsx` — ALL CAPS headline preserved (rule 4).
  'recovery.headline': 'INTERRUPTED RECORDING — {duration}',
  'recovery.resume': 'Resume',
  'recovery.discard': 'Discard',

  // `SpeakerView.tsx` — `{label}` is `speakerLabel(speaker)`'s own already-
  // translated output ("Sprecher 1"/"Speaker 1"), not a raw number: this key
  // wraps it rather than re-deriving the numbering, so the "Sprecher N"
  // phrasing has exactly one source of truth (`align.ts`'s `speaker.label`).
  'speaker.nameForLabel': 'Name for {label}',

  // `Steps.tsx` — the three-line status list. Several labels are identical
  // literals reused across the record/import/meeting branches within this
  // one file (approach step 4's spirit: one literal, one key); each is
  // listed once here.
  'steps.transcriptionDone': 'Transcription finished',
  'steps.recordingStopped': 'Recording stopped',
  'steps.savedIn': 'Saved in {folder}',
  'steps.saved': 'Saved',
  'steps.saving': 'Saving …',
  'steps.speakersDetected': 'Speakers detected',
  'steps.finishedSaved': 'Done — transcript saved',
  'steps.modelLoaded': 'Model loaded',
  'steps.locationSet': 'Location set',
  'steps.locationChooseFolder': 'Location — choose folder',
  'steps.locationChooseAtStart': 'Location — chosen at start',
  'steps.transcribingFile': 'Transcribing file …',
  'steps.pickAndTranscribe': 'Choose file & transcribe',
  'steps.meetingTranscribing': 'Transcription running …',
  'steps.recordMeeting': 'Record meeting',
  'steps.recording': 'Recording',

  // Shared between `Steps.tsx` (step 03 while diarization runs) and
  // `StoppedScreen.tsx` (the running-status line) — approach step 4's
  // "Sprecher werden erkannt ± Ellipse" unification. `Steps.tsx` used a
  // trailing "…" (no room there for the animated `RecordingDots`);
  // `StoppedScreen.tsx` renders actual animated dots right after this text
  // and had no "…". Unified on the no-ellipsis form: it's the one covered by
  // an existing exact-ish assertion (`StoppedScreen.test.tsx`'s
  // `toContain('Sprecher werden erkannt')`), and appending "…" next to
  // already-animated dots in `StoppedScreen` would read as a redundant
  // double progress-indicator. `Steps.tsx`'s own active-step marker (the
  // square, not this text) still carries the "in progress" cue there, so the
  // dropped "…" loses no information.
  'annotation.detecting': 'Detecting speakers',

  // `StoppedScreen.tsx`.
  'stopped.retryDetection': 'Retry speaker detection',
  'stopped.reDetect': 'Re-detect',
  'stopped.detectSpeakers': 'Detect speakers',
  'stopped.speakerCountAriaLabel': 'Number of speakers',
  'stopped.correctSpeakerCount': 'Correct number of speakers:',
  'stopped.speakerCountLabel': 'Number of speakers:',
  'stopped.autoChip': 'Auto',
  'stopped.detectionUnavailable':
    'Speaker detection not possible: {error} — the transcript is fully saved. Details in the browser console.',

  // The "clear with refresh" engraving under the display's bottom-left
  // corner (`App.tsx`'s `handleClearAndRefresh`) — replaces S2's red
  // "Delete all recordings" button and its confirmation row. One click:
  // wipe the locally cached recordings, then reload. The hint spells out
  // what survives, because the label alone can't: the exported files in the
  // chosen folder are the truth (CLAUDE.md) and are never touched.
  'clear.withRefresh': 'Clear with refresh',
  'clear.withRefreshHint':
    'Deletes the locally cached recordings and reloads the page. The files in your chosen folder stay.',

  // `VuMeter.tsx`'s default column label — device chrome (rule 4).
  'vu.label': 'IN',

  // --- U5 (`src/ui/InfoView.tsx`) — info entry point + info window --------
  // `info.buttonLabel` is the "How it works" engraving under the display's
  // bottom-right corner (idle/ready only, KTD8) — it replaced both U5's "i"
  // button in the header corner and the `MOD.001` badge that used to sit
  // there (owner feedback, 2026-07-26). It doubles as the pop-up's own
  // accessible name. The window it opens: architecture explanation, 3-step
  // guide, two copyable LLM prompts (KTD10), an as-is disclaimer. The 5
  // "what happens" sentences
  // and the 3 guide steps are each their OWN key — `InfoView.tsx` renders
  // every one as its own `<li>`, and its test scenario counts elements, not
  // prose, so this exact count (5/3) must be preserved by every translation.
  'info.buttonLabel': 'How it works',
  'info.backLabel': 'Back',

  'info.whatHeading': 'What happens here',
  'info.what1': "localRec transcribes what's said — directly on your device.",
  'info.what2':
    'The first time you start it you download a speech model once; after that the app needs no internet at all.',
  'info.what3':
    'Recording, transcription, and speaker detection all run right here, on this device — nothing is uploaded, there are no accounts, and no analytics.',
  'info.what4': 'What matters are the files in the folder you chose: they are the result.',
  'info.what5':
    "Whatever else the browser caches besides that is just a cache — you're free to delete it any time.",

  'info.stepsHeading': 'In three steps',
  'info.step1': "Choose a folder — that's where the transcript and audio are written.",
  'info.step2': 'Press the red button, speak, press it again. That was the recording.',
  'info.step3':
    '"Detect speakers" splits the transcript across the individual voices. That takes a few minutes.',

  'info.summaryHeading': 'Finally: have it summarized',
  'info.summaryIntro':
    'For the summary, your best bet is a large language model of your choice. Here are two ready-made prompts to copy — attach the file, paste the text, done.',
  // KTD10, not negotiable: makes the one place data can leave the device
  // explicit, right next to the two copyable prompts below.
  'info.summaryDeviceLimit': 'This last step leaves your device — you decide what you copy where.',

  // Prompt A — meeting with speakers. `{'transkript-sprecher.txt'}` is the
  // real export filename (`writeSpeakerTranscripts.ts`'s `DEFAULT_BASE_NAME`
  // + `-sprecher.txt`) — verified in code, not guessed.
  'info.promptSpeakerLabel': 'Meeting with speakers (transkript-sprecher.txt)',
  'info.promptSpeakerText':
    'Attached is the transcript of a meeting, generated automatically.\n\nThe speaker labels (Speaker 1, Speaker 2, …) are acoustically estimated and not always correct: at a change of speaker, a single sentence can end up attributed to the wrong speaker. Silently correct such obvious boundary errors when the context makes it clear, and don\'t ask about it.\n\nSummarize: what it was about · what was decided · what remained open · who is doing what.\n\nStick to what is in the text. Do not make anything up, and if something stays unclear, say so.',

  // Prompt B — plain transcript. `transkript.txt` is `fileSink.ts`'s
  // `DEFAULT_BASE_NAME` + `.txt` — verified in code, not guessed.
  'info.promptSimpleLabel': 'Simple transcript (transkript.txt)',
  'info.promptSimpleText':
    'Attached is the transcript of a recording, generated automatically — it may contain mishearings.\n\nSummarize: what it was about · what was decided · what remained open · who is doing what, as far as that is clear.\n\nStick to what is in the text. Do not make anything up, and if something stays unclear, say so.',

  'info.copyLabel': 'Copy',
  'info.copiedLabel': 'Copied.',
  'info.copyFailedLabel': 'Copy failed.',

  'info.disclaimerHeading': 'No warranty',
  'info.disclaimerText':
    'localRec is a private tool, provided as-is. The transcript and speaker detection are machine-generated and may contain errors — verify what matters to you. No one is liable for damages or anything missed.',

  // --- U6 (`RecordSetupView.tsx`/`MeetingView.tsx`) — consent note ---------
  // Rendered ONLY in the `ready` state of both recording paths, right next
  // to the start button (KTD11): the sentence IS the measure — no checkbox,
  // no gating, no second click. Source wording is a plan decision (Textquellen
  // → "Einwilligungs-Hinweis (U6)"), not authored here. `ImportView.tsx`
  // deliberately never renders this key (R11) — it has nothing of its own to
  // record, so there's no consent to confirm.
  'consent.note':
    'By starting, you confirm: everyone taking part knows about the recording and agrees to it.',
} satisfies Record<string, string>;
