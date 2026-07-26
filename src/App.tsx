/**
 * U12 — the real "local only" one-button interface. Assembles the visual
 * device from the owner's "local only" device spec (§2–§9) and the two
 * reference renders, over the U4 worker/audio wiring this shell already owned.
 *
 * What this unit adds on top of the U4 wiring:
 *  - the full dictaphone chrome (theme.css) in its two reference states,
 *    `ready` and `recording`, morphing by size/position only (§4);
 *  - the demo typewriter loop in the `ready` display (§3);
 *  - the live transcript (U8 `LiveTranscript`) mounted in the `recording`
 *    display, plus the VU-meter fed by the AudioWorklet's new smoothed-RMS
 *    channel (§7) — the mic level, not transcription progress;
 *  - the state machine (§8), spacebar start/stop and the focus ring (§9).
 *
 * Deliberately still headless-unverifiable at the edges: the deep §5
 * integration (fileSink/writers, OPFS persistence + heartbeat, Wake Lock,
 * the FirstRun model-download engine and crash-recovery detection) is the
 * remaining hardware milestone (U12a) — those subsystems exist (U6/U7/U9/
 * U10/U11) but wiring them needs a real mic, WebGPU and File System Access,
 * so they are not fabricated blind here. The `downloading`/`recovery`/
 * `stopped` display states are built and styleable; `downloading` is driven
 * by the worker's real load-progress fraction.
 *
 * **U19 addendum (IM-2, KTD16): the landing-page mode switch.** A new
 * top-level `mode` ('record' | 'import') decides what the `ready`-state
 * screen shows — the existing demo loop, or `ImportView`'s "Datei wählen"
 * flow. This is wiring only, surgical by design: the device state machine,
 * the recording start/stop handlers, and every existing `deviceState`
 * transition are untouched (U20b's `'importing'` state, added below, is its
 * own purely-additive branch — entered only from `handleFileSelected`,
 * exiting only to `'stopped'`/`'error'`). `ModeToggle` only ever renders while
 * `deviceState` is `idle`/`ready` — never mid-download, mid-recording or
 * mid-recovery, so switching modes can't interrupt anything in flight. The
 * "same gate as recording" for import (a light guard, per this unit's
 * brief) falls out of that placement for free: `ImportView` only ever
 * becomes reachable once `deviceState === 'ready'`, exactly the threshold
 * at which `RecordButton` also becomes enabled — no separate model-ready
 * check needed here. A picked file hands off its `Blob` straight to U20b's
 * `handleFileSelected` below (see that unit's addendum); U19 itself does not
 * decode or process it (see `audioFileSource.ts`/`ImportView.tsx` headers).
 *
 * **U20b addendum: the real import pipeline.** `handleFileSelected` now
 * actually runs the file through `session/importPipeline.ts`'s `runImport`
 * (decode -> `RecordingCoordinator.start()` -> U20a's paced batch-feed ->
 * `coordinator.stop()`) instead of just parking the `Blob`. Three pieces
 * make this work without touching the recording path:
 *  - **The gesture trap (Opus decision A).** `showOpenFilePicker` (the file
 *    dialog) and `showDirectoryPicker` (the folder dialog) each need their
 *    own user gesture, so both can't come from one click. `ImportView` now
 *    gates its file picker behind `hasOutputTarget` -- while unset, it only
 *    offers "Ordner wählen" (`handleChooseImportFolder` below, its own
 *    click -> `createFileSink()` -> `restoredSinkRef`/`hasOutputTarget`/
 *    `outputName`). By the time a file IS picked, the folder is already set,
 *    so `coordinator.start()`'s `createSink` (`restoredSinkRef.current ??
 *    createFileSink()`) resolves the already-open sink with no second
 *    picker.
 *  - **A new `'importing'` device state** (progress bar, mirrors
 *    `downloading`'s screen) covers decode+transcribe; on success the
 *    existing `'stopped'` finalize screen is reused as-is (the transcript
 *    was already streamed into `transcriptStoreRef`/the `.txt`/`.srt` files
 *    via the SAME worker-message handler the live path uses -- nothing
 *    special needed there); on failure, `'error'` is reused with an
 *    import-specific headline (`errorHeadline`, so it doesn't misreport
 *    "Modell konnte nicht geladen werden" for an import failure).
 *  - **The batch-transcription adapter** (built inline in
 *    `handleFileSelected` below) mirrors the live feed loop's
 *    `Comlink.transfer` call exactly, just driven by U20a's paced feeder
 *    instead of the live wall-clock interval.
 *
 * Deliberately NOT built here (see this unit's report): a download-the-
 * fallback-files affordance for the non-Chromium `FallbackSink` path --
 * that gap already exists for the recording flow (U9/U12a), import shares
 * it rather than fixing it in isolation.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { startOpusRecorder } from './audio/recorder';
import { LiveTranscript } from './ui/LiveTranscript';
import { TranscriptStore } from './ui/transcriptStore';
import { RecordButton } from './ui/RecordButton';
import { VuMeter } from './ui/VuMeter';
import { RecordingCoordinator, type RecorderStarter } from './session/recordingCoordinator';
import { SessionStore, type SessionRecord } from './storage/sessionStore';
import { findCrashCandidates, recoverSession } from './storage/recovery';
import { WakeLockController, getBrowserWakeLockProvider } from './runtime/wakeLock';
import { createFileSink, deleteFallbackArtifacts, type FileSink } from './output/fileSink';
import { ModeToggle, type Mode } from './ui/ModeToggle';
import { ImportView } from './ui/ImportView';
import { LanguageSelect, type TranscriptionLanguage } from './ui/LanguageSelect';
import { RecordSetupView } from './ui/RecordSetupView';
import { canCaptureSystemAudio, captureSystemAudio, SystemAudioError } from './audio/systemAudio';
import { LiveCapture } from './audio/liveCapture';
import type { PickedAudioFile } from './input/audioFileSource';
import { runImport, type ImportPhase } from './session/importPipeline';
import { decodeAudioBlobTo16kMonoPcm, createAudioContextDecoder } from './diarization/audioDecode';
import { runDiarization } from './session/diarizationRun';
import type { AlignedSegment } from './diarization/align';
import { Engine } from './engine/engine';
import { writeSpeakerTranscripts } from './output/writeSpeakerTranscripts';
import { IdleScreen, DownloadingScreen, ImportingScreen, ErrorScreen } from './ui/FirstRunScreens';
import { MicDeniedScreen } from './ui/MicDeniedScreen';
import { RecoveryScreen } from './ui/RecoveryScreen';
import { StoppedScreen } from './ui/StoppedScreen';
import { MeetingView } from './ui/MeetingView';
import { MeetingRecordingView } from './ui/MeetingRecordingView';
import { DemoLoop } from './ui/DemoLoop';
import { InfoView } from './ui/InfoView';
import { LineInJack } from './ui/LineInJack';
import { Steps } from './ui/Steps';
import { formatTimer } from './ui/format';
import { t } from './i18n';
import { useLocale } from './i18n/useLocale';
import { LocaleSwitch } from './ui/LocaleSwitch';
import './ui/theme.css';

/**
 * The visual states of §8. `idle` is the pre-download landing (the model load
 * is now user-initiated, not automatic — a ~1.5 GB fetch shouldn't start behind
 * the user's back); `downloading` is the in-progress load; `error` is a display
 * variant of `downloading`. `stopped` doubles as the post-recording finalize
 * screen (see `finalizing`) AND (U20b) as the post-import finalize screen —
 * both land on the same transcript-filled display, since both really are "a
 * finished transcription, ready to show". `importing` (U20b) is the decode +
 * batch-transcribe progress screen for the file-import path, styled like
 * `downloading` (see `renderScreen()`'s `'importing'` branch below).
 */
export type DeviceState = 'idle' | 'downloading' | 'ready' | 'recording' | 'stopped' | 'recovery' | 'error' | 'importing';

export default function App() {
  // U4/KTD3: subscribes App to the locale store so the WHOLE tree re-renders
  // on every `setLocale()` call (from `LocaleSwitch`, top-right) — `t()` is a
  // plain module-level read and does NOT by itself trigger React to
  // re-render anything. One call here is enough because every screen is
  // rendered from this single component and no `React.memo` in the tree
  // wraps `t()`-produced text (checked: the only `memo` in the app is
  // `TranscriptRow` in `LiveTranscript.tsx`, which renders transcript
  // content, not UI copy). The return value is intentionally unused — this
  // is NOT a dead hook call, don't remove it as one.
  useLocale();

  const [deviceState, setDeviceState] = useState<DeviceState>('idle');
  // U5 (KTD8): whether the info pop-up is showing over the device.
  // Deliberately NOT a `deviceState` — opening the info window is not a
  // device state change: every existing `deviceState()` assertion in
  // `App.test.tsx` stays valid no matter whether this is open. Closed via
  // the "Zurück" button, the backdrop, and `Escape` (the keydown effect
  // below); the "How it works" engraving that opens it only renders while
  // `deviceState` is `idle`/`ready` (see the `.panel-wrap` JSX).
  const [infoOpen, setInfoOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // U20b: the `error` screen's headline is context-dependent (model load vs.
  // import) — `errorMessage` alone stays a detail line under whichever
  // headline is current. Defaults to the pre-existing model-load copy so
  // the engine-load failure path (see the engine-status projection effect
  // below) reads exactly as before.
  const [errorHeadline, setErrorHeadline] = useState(t('error.modelLoadHeadline'));
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recoveryCandidate, setRecoveryCandidate] = useState<SessionRecord | null>(null);
  // True while `stop()` is still draining/closing the writers (§7 comms): the
  // post-stop step list shows "wird gespeichert …" until this clears.
  const [finalizing, setFinalizing] = useState(false);
  // Whether an output folder is set (restored on mount, or chosen on first
  // record) — drives the honest "Speicherort" step state, so it isn't ✓ before
  // the user has actually been asked (the picker only appears at record start).
  const [hasOutputTarget, setHasOutputTarget] = useState(false);
  // The chosen folder's name for the "gespeichert in …" message (§7). Only the
  // name is ever available — the browser never exposes a full path.
  const [outputName, setOutputName] = useState<string | null>(null);
  // U19: landing-page mode switch (IM-2). Default 'record' — the existing
  // live path is unaffected by this state existing at all. Plan 003 adds the
  // third value 'meeting' (mic + system audio).
  const [mode, setMode] = useState<Mode>('record');
  // Plan 003 U3/U4: whether the "Online Meeting" mode is offered at all
  // (Chromium-desktop feature-detect, KTD-M3). Computed once — the capability
  // doesn't change within a session.
  const meetingAvailable = useMemo(() => canCaptureSystemAudio(), []);
  // Plan 003 U4: a short retry hint on the meeting screen — set when a meeting
  // start fails recoverably (forgot the system-audio checkbox, or capture
  // failed). A user cancel is silent (null). Cleared on mode switch/retry.
  const [meetingHint, setMeetingHint] = useState<string | null>(null);
  // Record mode: true after a denied/failed `getUserMedia` — surfaces the
  // `MicDeniedScreen` on the `ready` display (device stays `ready`, so the
  // RecordButton and the screen's "Erneut versuchen" both re-attempt in place).
  // Cleared on a fresh record attempt and on a mode switch.
  const [micDenied, setMicDenied] = useState(false);
  // Record mode: true from the moment `prepareRecording` (folder + mic) has run
  // until the recording actually starts — the window in which the screen tells
  // the user the remaining step is the red button (hardware test 01, finding
  // 1). A folder RESTORED from an earlier session deliberately does not set it:
  // returning users keep the demo display, they know the device by then.
  const [setupHint, setSetupHint] = useState(false);
  // U20b: which import step is running — drives the `'importing'` screen's
  // label. The progress FRACTION is intentionally not shown as a bar: Whisper's
  // long-form transcription reports only 0→1 (no mid-inference tick, see
  // `whisperEngine.transcribe`), so a percentage bar sits at 0 % for the whole
  // multi-minute run and reads as "hung". The setter stays wired (the pipeline
  // still calls it), but the screen shows an honest elapsed timer + activity
  // instead — see `importElapsedMs` below and the `'importing'` branch.
  const [, setImportProgress] = useState(0);
  const [importPhase, setImportPhase] = useState<ImportPhase>('decoding');
  // Elapsed time in the `'importing'` state — the honest "it's working" signal
  // that replaces the stuck 0 % bar (see the note above).
  const [importElapsedMs, setImportElapsedMs] = useState(0);

  // Phase D (U18/U21): the post-hoc speaker-annotation stage, auto-triggered
  // after a recording stops or an import finishes. `aligned` is the
  // speaker-labeled result (swaps `LiveTranscript` for `SpeakerView` in the
  // `stopped` display once ready); `annotation` drives the visible stage
  // status. `'skipped'` is the SD-3 graceful outcome — model absent or
  // diarization failed — where the plain transcript stands unchanged.
  const [aligned, setAligned] = useState<AlignedSegment[] | null>(null);
  const [annotation, setAnnotation] = useState<'idle' | 'running' | 'done' | 'skipped'>('idle');
  // Hybrid annotation timing: for the live/meeting paths the (slow) diarization
  // is NOT auto-run after stop — the transcript + .webm are already saved, and
  // the meeting audience has left, so we don't block them. Instead the recorded
  // audio is parked here and a "Sprecher erkennen" button on the stopped screen
  // runs it on demand. The import path still auto-annotates (the user is present).
  const [pendingAnnotation, setPendingAnnotation] = useState<Blob | null>(null);
  // Transcription language (owner decision after hardware test 01): 'auto' =
  // Whisper's per-window detection (mixed-language meetings), or a pinned
  // code (better for Schweizerdeutsch, where detection can misfire). One
  // session-wide value, deliberately NOT reset per recording — see
  // `LanguageSelect.tsx`.
  const [language, setLanguage] = useState<TranscriptionLanguage>('auto');
  // Hardware test 01 round 5: the user usually KNOWS how many people spoke, and
  // saying so removes the hardest unsupervised decision (the count) from the
  // pipeline entirely (`knownSpeakerCount`). null = automatic. Per-session —
  // reset with the rest of the annotation state.
  const [speakerCount, setSpeakerCount] = useState<number | null>(null);
  // Model-download fraction during annotation. The setter is wired (runDiarization
  // reports it), but it's no longer shown as a % — diarization inference itself
  // has no mid-progress, so the screen shows activity dots, not a stuck 100%.
  const [, setAnnotationProgress] = useState(0);
  // When diarization is SKIPPED because it errored (not the empty-transcript
  // case), this carries the reason — shown as a non-blocking line so the skip
  // is diagnosable instead of silently invisible (the transcript is intact
  // either way). null on the clean/empty skip.
  const [annotationError, setAnnotationError] = useState<string | null>(null);

  const recording = deviceState === 'recording';

  // The live recording's Opus chunks, tapped from the recorder (U18 audio
  // reacquisition): reassembled into a Blob after stop and decoded for
  // diarization. Reset at each recording start. The import path uses the
  // picked file's Blob directly instead of this.
  const recordedChunksRef = useRef<Blob[]>([]);

  const transcriptStoreRef = useRef<TranscriptStore | null>(null);
  if (transcriptStoreRef.current === null) {
    transcriptStoreRef.current = new TranscriptStore();
  }

  // U6/U7 persistence + endurance, constructed once per mount.
  const sessionStoreRef = useRef<SessionStore | null>(null);
  if (sessionStoreRef.current === null) sessionStoreRef.current = new SessionStore();
  const wakeLockRef = useRef<WakeLockController | null>(null);
  if (wakeLockRef.current === null) {
    const provider = getBrowserWakeLockProvider();
    wakeLockRef.current = provider ? new WakeLockController(provider) : null;
  }
  // A previously chosen output folder restored on mount (R6) — reused so a
  // recording start doesn't re-prompt the picker when a grant already exists.
  const restoredSinkRef = useRef<FileSink | null>(null);

  // The U12a recording lifecycle (output/persistence/wake-lock), driven by the
  // start/stop handlers below. Built once; `createSink` prefers the restored
  // folder, else opens the picker (kept inside the click's user gesture).
  // U20b: `runImport` (below) drives the SAME coordinator instance for an
  // import — the identical output/persistence pipeline a live recording
  // uses, just with `startRecorder = () => null` (no mic to capture).
  const coordinatorRef = useRef<RecordingCoordinator | null>(null);
  if (coordinatorRef.current === null) {
    coordinatorRef.current = new RecordingCoordinator({
      createSink: async () => restoredSinkRef.current ?? createFileSink(),
      sessionStore: sessionStoreRef.current,
      wakeLock: wakeLockRef.current,
    });
  }

  // U6: the live audio-capture graph (CONTEXT.md "Live Capture"), constructed
  // once and reused across recordings — symmetric with `coordinatorRef`
  // above. Replaces the former 7 mutable refs
  // (audioContext/mediaStream/workletNode/feedInterval/systemStream/
  // mixTeardown/rms) + `teardownAudioPipeline`. `getLevel` is a stable bound
  // field on the instance, so `<VuMeter getLevel={...} />` below never needs
  // a fresh callback per render.
  const liveCaptureRef = useRef<LiveCapture | null>(null);
  if (liveCaptureRef.current === null) {
    liveCaptureRef.current = new LiveCapture();
  }

  // U7: the model stack (CONTEXT.md "Engine" — Whisper transcription +
  // pyannote/WeSpeaker diarization) behind one seam, constructed once and
  // reused — symmetric with `coordinatorRef`/`liveCaptureRef` above. Owns
  // both worker lifecycles (transcription eager, diarization lazy on first
  // `diarizer()`), the transcription readiness FSM, live control, whole-file
  // transcription, and the raw `final` segment stream. Replaces
  // `workerApiRef`/`diarWorkerRef`/`diarWorkerApiRef`/`getDiarWorkerApi`.
  const engineRef = useRef<Engine | null>(null);
  if (engineRef.current === null) {
    engineRef.current = new Engine();
  }
  const engine = engineRef.current;
  // Readiness = source of truth (ADR-0001 "App projiziert Zustand"): App
  // reads Engine's snapshot via `useSyncExternalStore` (same shape/discipline
  // as `TranscriptStore`) and projects the idle/downloading/ready/error slice
  // of `deviceState` from it below, instead of tracking its own
  // `modelReady`/`modelLoadFailed`/`loadProgress` booleans.
  const engineSnapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);

  // Phase D (U18/U21): the shared post-hoc annotate stage — identical for both
  // entry points (KTD16, the "geteilte Post-hoc-Pipeline"): after a live stop
  // OR an import, decode the audio, run the diarization worker, and align the
  // speaker timeline onto the CURRENT transcript. `runDiarization` NEVER throws
  // — SD-3: any failure (model absent, decode/inference error) resolves to
  // `diarized:false`, leaving the plain transcript untouched. On success the
  // display swaps to `SpeakerView` and the speaker-labeled `-sprecher.txt`/
  // `.srt` are written to the same chosen folder. Runs in the background: the
  // device is already in `stopped`, so the plain transcript shows immediately
  // and the speaker labels arrive when the (post-hoc, no-GPU-contention) run
  // finishes.
  // U3 (#7): Annotation belongs to ONE Recording Session. `annotationInFlightRef`
  // rejects a second "Sprecher erkennen" pass (two diarizations on one ORT
  // session), and `recordingGenerationRef` — bumped whenever a new transcript
  // begins (each `transcriptStore.reset()`) — is captured at the start and
  // re-checked before applying, so a slow pass whose session was replaced by a
  // newer recording is DISCARDED instead of overwriting the new session's
  // speaker view / `-sprecher.*` export files.
  const annotationInFlightRef = useRef(false);
  const recordingGenerationRef = useRef(0);

  // #15: the fresh-session annotation reset, previously copy-pasted verbatim in
  // processAudioBlob / startRecording / startMeeting. Stable (setters are), so
  // callers can depend on it without churning their own identity.
  const resetAnnotationState = useCallback(() => {
    setAligned(null);
    setAnnotation('idle');
    setPendingAnnotation(null);
    setAnnotationError(null);
    setSpeakerCount(null);
  }, []);

  // S2 (privacy hardening [F2]) — the "clear with refresh" engraving under
  // the display's bottom-left corner, mounted below only on the idle/ready
  // display (never mid-recording/download/import).
  //
  // **Owner feedback (2026-07-26).** This was a red "Alle Aufnahmen löschen"
  // button with a Ja/Abbrechen confirmation row inside the screen — far too
  // loud for something used approximately never, and it competed with the
  // one red control this device is allowed to have. The owner's instinct was
  // "a browser refresh already starts you over"; it does NOT — a reload
  // resets the SCREEN, while `SessionStore`'s IndexedDB rows and the OPFS
  // fallback artifacts survive it. So the two are fused into the one action
  // the label promises (owner decision, asked and answered): wipe both
  // persistence layers this app owns for recordings, then reload.
  //
  // Deliberately NOT touched (owner decision, unchanged from S2): the model
  // cache and the exported files in the user's chosen folder — those are the
  // truth, not the app's cache. No React state reset either, and no
  // `recordingGenerationRef` bump: the reload replaces the whole document,
  // so there is no surviving in-flight annotation to invalidate. The wipe is
  // best-effort — a failing IndexedDB/OPFS delete must not swallow the
  // refresh the label promises.
  const handleClearAndRefresh = useCallback(() => {
    void (async () => {
      try {
        await sessionStoreRef.current?.deleteAllSessions();
        await deleteFallbackArtifacts();
      } catch {
        // best effort — fall through to the reload either way
      }
      window.location.reload();
    })();
  }, []);

  const runAnnotation = useCallback(
    async (audio: Blob, knownSpeakerCount: number | null = null) => {
      if (annotationInFlightRef.current) return; // no concurrent passes on one ORT session
      const generation = recordingGenerationRef.current; // bind this pass to its session
      annotationInFlightRef.current = true;
      try {
      const snapshot = transcriptStoreRef.current?.getSnapshot();
      const segments = (snapshot?.segments ?? []).map((s) => ({ text: s.text, startMs: s.startMs, endMs: s.endMs }));
      if (segments.length === 0) {
        setAnnotation('skipped'); // nothing transcribed → nothing to annotate
        return;
      }

      setAnnotation('running');
      setAnnotationProgress(0);
      setAnnotationError(null);
      // U7: `engine.diarizer()` hides the Comlink adapter (proxy'd progress
      // callback, transferred PCM) `runAnnotation` used to build inline here —
      // same lazy-create-on-first-use posture as the old `getDiarWorkerApi`.
      const result = await runDiarization(
        { audio, segments, knownSpeakerCount: knownSpeakerCount ?? undefined },
        {
          worker: engine.diarizer(),
          decode: (blob) => decodeAudioBlobTo16kMonoPcm(blob, { decode: createAudioContextDecoder() }),
        },
        (fraction) => setAnnotationProgress(fraction),
      );

      // A newer recording/import began during the slow pass (generation bumped
      // on its transcript reset): this result belongs to a session that no
      // longer exists on screen. Drop it — do not touch the new session's
      // `aligned` state or write `-sprecher.*` into its folder (#7).
      if (recordingGenerationRef.current !== generation) return;

      if (!result.diarized) {
        // SD-3: keep the plain transcript exactly as-is — no speaker artifact,
        // no blocking error. `aligned` stays null, so the display keeps showing
        // the speaker-less `LiveTranscript`. But if it was an actual FAILURE
        // (not the empty-transcript case), surface the reason so a skip is
        // diagnosable instead of silently invisible.
        if (result.error) {
          // eslint-disable-next-line no-console
          console.error('[diarization] übersprungen — Fehler in runDiarization:', result.error);
          const message = result.error instanceof Error ? result.error.message : String(result.error);
          setAnnotationError(message || t('annotation.unknownErrorFallback'));
        }
        setAnnotation('skipped');
        return;
      }

      setAligned(result.aligned);
      // Write the speaker-labeled export to the same chosen folder. Best-effort
      // (fire-and-forget posture, like the live `handleFinal`): a failed
      // enrichment write must not disturb the already-complete plain .txt/.srt.
      const sink = coordinatorRef.current?.sink;
      if (sink) {
        try {
          await writeSpeakerTranscripts(sink, result.aligned);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error('[diarization] writeSpeakerTranscripts fehlgeschlagen:', error);
        }
      }
      setAnnotation('done');
      } finally {
        annotationInFlightRef.current = false;
      }
    },
    [engine],
  );

  // The shared post-hoc pipeline for a recorded/imported audio Blob (KTD16):
  // decode → whole-file transcribe (writing .txt/.srt through the coordinator)
  // → speaker-annotate. Used by BOTH the file-import path AND the record-only
  // meeting path — a meeting's mix is streamed durably to `.webm` during the
  // call but never live-transcribed (no GPU contention with the meeting app),
  // so it is transcribed here afterwards, exactly like an imported file. Resets
  // the transcript store first so the run never inherits a prior session's
  // segments. Drives the `importing` progress screen, then `stopped` + annotate.
  const processAudioBlob = useCallback(
    (blob: Blob, autoAnnotate: boolean) => {
      transcriptStoreRef.current?.reset();
      recordingGenerationRef.current += 1; // U3: a new transcript invalidates any in-flight annotation of the prior session
      setImportPhase('decoding');
      setImportProgress(0);
      resetAnnotationState();
      setDeviceState('importing');

      runImport(blob, {
        decode: (b) => decodeAudioBlobTo16kMonoPcm(b, { decode: createAudioContextDecoder() }),
        // U7: `engine.transcribeFile` hides the transfer + progress-proxy.
        transcribeFile: (pcm, opts) => engine.transcribeFile(pcm, opts?.onProgress, language),
        coordinator: coordinatorRef.current!,
        onSegment: (segment) => transcriptStoreRef.current?.append(segment),
        onPhase: setImportPhase,
        onProgress: setImportProgress,
      })
        .then(() => {
          setHasOutputTarget(true);
          setOutputName(coordinatorRef.current!.outputName);
          setDeviceState('stopped');
          // Phase D (hybrid timing): the import path annotates right away (the
          // user is present); the meeting path parks the audio for the on-demand
          // "Sprecher erkennen" button instead of blocking after everyone left.
          // The audio is parked in BOTH cases: after any pass the user can
          // re-run with a stated speaker count ("Neu erkennen", round 5).
          setPendingAnnotation(blob);
          if (autoAnnotate) void runAnnotation(blob);
        })
        .catch((error: unknown) => {
          setErrorHeadline(t('error.importFailedHeadline'));
          setErrorMessage(error instanceof Error ? error.message : t('error.importFailedDetailFallback'));
          setDeviceState('error');
        });
    },
    [engine, language, runAnnotation],
  );

  // Phase D (hybrid timing): the on-demand "Sprecher erkennen" trigger. Runs the
  // diarization on the audio parked at stop (live/meeting). Kept available for a
  // retry if a run was skipped (error). Cleared implicitly by starting a new
  // session (the reset block above).
  const handleAnnotate = useCallback(() => {
    if (pendingAnnotation) void runAnnotation(pendingAnnotation, speakerCount);
  }, [pendingAnnotation, runAnnotation, speakerCount]);

  // U20b (Opus decision A, the gesture trap): opens the output folder from
  // ImportView's own "Ordner wählen" click — its OWN user gesture, separate
  // from the later file-picker click, because `showDirectoryPicker` and
  // `showOpenFilePicker` each need one. Mirrors `startRecording`'s existing
  // "restoredSinkRef wins, else open a fresh picker" shape, just triggered
  // explicitly instead of implicitly inside `coordinator.start()`.
  const handleChooseImportFolder = useCallback(() => {
    void createFileSink()
      .then((sink) => {
        restoredSinkRef.current = sink;
        setHasOutputTarget(true);
        setOutputName(sink.name ?? null);
      })
      .catch(() => {
        // Picker cancelled or failed — ImportView simply stays on "Ordner
        // wählen"; no error UI for a cancel (same posture as `startRecording`'s
        // own picker-cancel handling).
      });
  }, []);

  // Hardware test 01, finding 1: record mode is folder-first now, like meeting
  // mode always was (KTD-M6). The old first press asked for the MICROPHONE and
  // then popped the folder picker mid-start — two system dialogs, wrong order,
  // no explanation on screen. This one click (from `RecordSetupView`) does the
  // whole setup in the order a user expects: folder picker first, then the mic
  // permission right after it closes (`getUserMedia` needs no gesture of its
  // own), so the red button afterwards only STARTS, with no dialog in the way.
  // The mic stream is released again immediately — it was only for the
  // permission; `LiveCapture` opens its own at record start (U6 owns that).
  const prepareRecording = useCallback(async () => {
    let sink: FileSink;
    try {
      sink = await createFileSink();
    } catch {
      return; // picker cancelled → screen stays on "Speicherort wählen"
    }
    restoredSinkRef.current = sink;
    setHasOutputTarget(true);
    setOutputName(sink.name ?? null);
    setSetupHint(true);

    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of mic.getTracks()) track.stop();
      setMicDenied(false);
    } catch {
      // Denied/unavailable → the existing `MicDeniedScreen` explains it and
      // retries in place; the folder stays chosen either way.
      setMicDenied(true);
    }
  }, []);

  // U20b: runs a picked file through the shared post-hoc pipeline
  // (`processAudioBlob` above — decode → transcribe → annotate). `ImportView`
  // only ever calls this once `hasOutputTarget` is true (its own gate, decision
  // A), so `coordinator.start()`'s `createSink` always resolves the already-open
  // sink, no second picker mid-import.
  const handleFileSelected = useCallback(
    (file: PickedAudioFile) => processAudioBlob(file.blob, true), // import → annotate right away (user present)
    [processAudioBlob],
  );

  // U7: wires Engine's raw `final` segment stream to the two sinks the old
  // inline `handleTranscriptMessage` drove — the live display (U8) and
  // persistence/export (U12a). Engine itself stays persistence-ignorant
  // (`onSegment` just hands out raw messages); this is where App composes
  // them, same posture as before.
  //
  // No automatic model load — it starts on the user's "Modell laden" click
  // (`beginModelLoad` → `engine.load()`). The transcription worker is already
  // wired (created eagerly in `Engine`'s constructor) so the click can drive
  // `initialize()` immediately, but nothing is fetched yet.
  //
  // **Deliberately NO `engine.dispose()` in the cleanup** (fixes the DEV
  // "model load stuck at 0 %" hang): `engineRef` is a
  // render-time singleton that lives as long as the component, so its
  // lifetime is NOT this effect's. `<StrictMode>` (main.tsx) runs mount →
  // unmount → remount in dev; disposing here terminated the transcription
  // worker on that cleanup while the remount kept the same, now-dead Engine —
  // the click's `initialize()` then posted to a terminated worker and hung at
  // 0 % forever. App is the SPA root and never regularly unmounts; both
  // workers die with the page. `dispose()` stays Engine's teardown API for
  // callers that own an Engine outside a component (tests).
  useEffect(() => {
    const unsubscribe = engine.onSegment((message) => {
      const segment = { text: message.text, startMs: message.startMs, endMs: message.endMs };
      transcriptStoreRef.current?.append(segment); // live display (U8)
      // U12a: mirror the finalized segment into persistence + the .txt/.srt
      // export files. Fire-and-forget; a failed durable write must not stall
      // the live stream (the sink self-heals on degrade, U9).
      void coordinatorRef.current?.handleFinal(segment).catch(() => {});
    });

    return () => {
      liveCaptureRef.current?.stop();
      unsubscribe();
    };
  }, [engine]);

  // Readiness projection (ADR-0001 "App projiziert Zustand"): mirrors the old
  // inline `.then()`/`.catch()` in `beginModelLoad` but is now driven by
  // Engine's own status transitions instead of one call's promise, since
  // `load()` is fire-and-forget and idempotent. `downloading`/`error` only
  // fire from the states the old guards allowed (`idle`/`error` →
  // `downloading`; `downloading` → `ready`), so a stray status change (e.g.
  // while `recovery` is showing) can't clobber an unrelated screen.
  useEffect(() => {
    if (engineSnapshot.status === 'ready') {
      setDeviceState((prev) => (prev === 'downloading' ? 'ready' : prev));
    } else if (engineSnapshot.status === 'downloading') {
      setDeviceState((prev) => (prev === 'idle' || prev === 'error' ? 'downloading' : prev));
    } else if (engineSnapshot.status === 'failed') {
      // Explicit (not just the state default) so a headline set by an
      // earlier import failure never leaks into a later model-load error.
      setErrorHeadline(t('error.modelLoadHeadline'));
      setErrorMessage(engineSnapshot.error ?? t('error.modelLoadHeadline'));
      setDeviceState('error');
    }
  }, [engineSnapshot.status, engineSnapshot.error]);

  // On mount: scan for a crash candidate (AE2) — it surfaces the recovery offer
  // "vor allem anderen" (§8), even while the model is still loading.
  //
  // NO folder restore here any more (hardware test 01, finding 2). A silently
  // restored folder from an earlier session meant the next recording wrote into
  // it without asking — a second recording appended into the first one's
  // `transkript.txt`/`.srt`. Every recording now asks for its storage location
  // (`RecordSetupView` → `prepareRecording`), which is also the moment the user
  // can pick a different target. `restoreFileSink` stays available in
  // `output/fileSink.ts`, just no longer wired to the record path.
  useEffect(() => {
    const store = sessionStoreRef.current;
    if (!store) return;
    let cancelled = false;

    void findCrashCandidates(store)
      .then((candidates) => {
        if (cancelled || candidates.length === 0) return;
        setRecoveryCandidate(candidates[0]);
        // Never override an already-started recording.
        setDeviceState((prev) => (prev === 'recording' ? prev : 'recovery'));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  // Wake Lock re-acquisition across tab visibility changes (U7): the OS drops a
  // screen lock when the tab hides; the controller re-requests it on return.
  useEffect(() => {
    const wakeLock = wakeLockRef.current;
    if (!wakeLock) return;
    const onVisibility = () => void wakeLock.handleVisibilityChange(document.visibilityState).catch(() => {});
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Timer: counts up while recording (§4/§8). Cleared on stop.
  useEffect(() => {
    if (!recording) return;
    const startedAt = performance.now() - elapsedMs;
    const id = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 250);
    return () => window.clearInterval(id);
    // elapsedMs intentionally excluded: it is the running value we set here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  // Elapsed timer for the `'importing'` state — the honest activity signal that
  // replaces the (meaningless, always-0 %) transcription progress bar. Runs only
  // while importing; resets each time that state is (re)entered.
  useEffect(() => {
    if (deviceState !== 'importing') return;
    const startedAt = performance.now();
    setImportElapsedMs(0);
    const id = window.setInterval(() => setImportElapsedMs(performance.now() - startedAt), 500);
    return () => window.clearInterval(id);
  }, [deviceState]);

  // User-initiated one-time model load (§1: the ~1.5 GB fetch never starts on
  // its own). `engine.load()` carries its own idempotency latch (a no-op
  // while already downloading/ready, and un-latches on failure so a retry
  // click re-enters `downloading`) — the `deviceState` projection lives in
  // the engine-status effect above.
  const beginModelLoad = useCallback(() => {
    engine.load();
  }, [engine]);

  // U2 (ADR-0001): one synchronous re-entrancy guard for the record/stop
  // intents. `toggleRecording` is driven by both the RecordButton and the
  // global Space handler, and `deviceState` doesn't flip to
  // 'recording'/'stopped' until AFTER the async start/stop work — so a
  // double-tap in that gap used to fire two concurrent starts (two mic streams
  // + two sessions, #1) or two meeting stops (two `processAudioBlob` runs, #9),
  // and let a restart race an in-flight stop (#4). The ref is checked+set
  // synchronously before any `await`; `busy` mirrors it to disable the button.
  const transitionRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const runExclusive = useCallback(async (fn: () => Promise<void>) => {
    if (transitionRef.current) return;
    transitionRef.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      transitionRef.current = false;
      setBusy(false);
    }
  }, []);

  const startRecording = useCallback(() => runExclusive(async () => {
    if (deviceState === 'recording' || (deviceState !== 'ready' && deviceState !== 'stopped')) return;

    // Phase D (U18): clear a previous session's speaker view and start a fresh
    // recorded-audio buffer for this recording's post-hoc diarization.
    transcriptStoreRef.current?.reset(); // fresh transcript for this session
    recordingGenerationRef.current += 1; // U3: a new transcript invalidates any in-flight annotation of the prior session
    resetAnnotationState();
    recordedChunksRef.current = [];
    setMicDenied(false); // clear a prior denial; the catch below re-sets it if this attempt is denied too
    setSetupHint(false); // the "now press the button" instruction has served its purpose

    // U6: LiveCapture owns `mic` (and the whole capture graph) once `start()`
    // is called — a failed `start()` tears it back down itself, nothing
    // half-open. U7: `engine.feedAudio` hides the `Comlink.transfer` the old
    // inline `onPcm` callback did itself.
    const liveCapture = liveCaptureRef.current!;
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Mic permission denied / unavailable → surface the `MicDeniedScreen` and
      // stay on `ready`, so the RecordButton and that screen's "Erneut
      // versuchen" both re-attempt in place (`getUserMedia` re-checks live
      // permission each call — no reload needed once the user allows the mic).
      // Nothing was acquired, so nothing is half-open.
      setMicDenied(true);
      setDeviceState((prev) => (prev === 'recording' ? prev : 'ready'));
      return;
    }
    try {
      await liveCapture.start({ mic, onPcm: engine.feedAudio });
    } catch {
      // The capture graph failed to build — `liveCapture.start` already tore
      // the mic + graph down itself (U6), so nothing is half-open. Silent back
      // to ready (a rare, non-permission failure), mirroring the
      // folder-picker-cancel catch below. `stop()` is idempotent.
      liveCapture.stop();
      setDeviceState((prev) => (prev === 'recording' ? prev : 'ready'));
      return;
    }

    // U12a: open output/persistence/wake-lock + the parallel audio recorder.
    // Runs before `engine.startLive()` so a cancelled folder picker aborts the
    // whole start cleanly (mic torn down, back to ready) without ever opening a
    // worker session or a crash-candidate row.
    const startRecorder: RecorderStarter = (onChunk) => {
      try {
        return startOpusRecorder(liveCapture.recordStream!, {
          onChunk: (blob) => {
            // U18: tap each Opus chunk for post-hoc diarization (reassembled
            // into a Blob after stop), then forward it to the coordinator's
            // .webm writer unchanged.
            recordedChunksRef.current.push(blob);
            onChunk(blob);
          },
        });
      } catch {
        return null; // no MediaRecorder → transcript-only recording, still valid
      }
    };
    try {
      await coordinatorRef.current!.start(startRecorder);
    } catch {
      // Sink couldn't open (folder picker cancelled) → back to ready, mic torn
      // down, nothing half-open (LiveCapture owns that teardown now).
      liveCapture.stop();
      setDeviceState('ready');
      return;
    }

    // Folder is now chosen (or was already restored) — record the target for
    // the "Speicherort" step and the post-stop "gespeichert in …" message.
    setHasOutputTarget(true);
    setOutputName(coordinatorRef.current!.outputName);

    engine.startLive(language);
    setElapsedMs(0);
    setDeviceState('recording');
  }), [deviceState, engine, language, runExclusive]);

  // The recorded audio (mic-only, or the meeting mix), assembled from the Opus
  // chunks tapped during recording — the input for the post-hoc pass. #10:
  // ALWAYS call this AFTER coordinator.stop() has resolved, never before: the
  // recorder's trailing `dataavailable` lands during stop()'s drain, so a
  // pre-stop snapshot drops the final chunk (up to ~5 s of a meeting).
  const assembleRecordedAudio = (): Blob | null => {
    const chunks = recordedChunksRef.current;
    return chunks.length > 0 ? new Blob(chunks, { type: chunks[0].type || 'audio/webm' }) : null;
  };

  const stopRecording = useCallback(() => runExclusive(async () => {
    const wasMeeting = mode === 'meeting';
    liveCaptureRef.current?.stop();

    if (wasMeeting) {
      // Record-only meeting: nothing was transcribed live. Close the `.webm`
      // recording session FIRST, then assemble the blob (#10) and transcribe it
      // — but do NOT auto-run the slow diarization (hybrid timing: the audience
      // has left; a "Sprecher erkennen" button on the stopped screen runs it on
      // demand).
      await (coordinatorRef.current?.stop() ?? Promise.resolve());
      const audio = assembleRecordedAudio();
      if (audio) {
        processAudioBlob(audio, false);
      } else {
        setDeviceState('stopped'); // no MediaRecorder was available — nothing to process
      }
      return;
    }

    // Live mic path (unchanged): the transcript already streamed in.
    setDeviceState('stopped');
    setFinalizing(true); // §7: "wird gespeichert …" until the writers are closed
    // Order matters, do NOT parallelize: `engine.stopLive()` resolves only
    // AFTER the live driver's trailing block has been dispatched through
    // `onSegment` (see `Engine`'s stop-ordering invariant, and
    // `transcription.worker.ts`'s `stop` doc comment underneath it) — so
    // `coordinator.handleFinal` for that trailing segment runs before this
    // await resolves. Only then may the coordinator stop and close the
    // txt/srt writers; it drains its write queue first, so that trailing
    // segment lands in the export files. Running these in parallel is
    // exactly what left .txt/.srt empty.
    try {
      await engine.stopLive();
      await (coordinatorRef.current?.stop() ?? Promise.resolve());
    } finally {
      setFinalizing(false); // files flushed + closed → "fertig, Fenster kann geschlossen werden"
    }

    // Phase D (hybrid timing): the live transcript is already shown + saved.
    // Park the recorded audio for the on-demand "Sprecher erkennen" button
    // rather than auto-running the slow diarization now. Assembled AFTER the
    // stop() drain above (#10) so the parked audio isn't missing its tail.
    const audio = assembleRecordedAudio();
    if (audio) {
      setPendingAnnotation(audio);
    }
  }), [engine, mode, processAudioBlob, runExclusive]);

  // Plan 003 U3 — the "Online Meeting" path (KTD-M2/KTD-M6), deliberately
  // RECORD-ONLY. The capture source is a MIX of the mic and the system/meeting
  // audio (Teams/Zoom desktop) — so the recording carries BOTH sides — but,
  // unlike `startRecording`, NO live transcription runs during the call: the
  // Whisper worker is never fed or started, so it doesn't contend with the
  // meeting app for the GPU (which made the call video lag). The mix streams
  // durably to `.webm` throughout (crash-safe), and the worklet is kept ONLY to
  // drive the VU meter (RMS) — its PCM is dropped, no ring buffer, no feed loop.
  // After stop, `stopRecording` hands the recording to `processAudioBlob`, which
  // transcribes AND diarizes it post-hoc, exactly like an imported file.
  //
  // The output folder MUST already be chosen (the meeting screen's folder-first
  // gate): `getDisplayMedia` opens a picker inside this click's gesture, so
  // `coordinator.start()` can't also open the folder picker (one gesture, one
  // picker — KTD-M6). It reuses the already-open sink instead.
  const startMeeting = useCallback(() => runExclusive(async () => {
    if (deviceState === 'recording' || (deviceState !== 'ready' && deviceState !== 'stopped')) return;

    setMeetingHint(null);
    transcriptStoreRef.current?.reset(); // fresh transcript for this session
    recordingGenerationRef.current += 1; // U3: a new transcript invalidates any in-flight annotation of the prior session
    resetAnnotationState();
    recordedChunksRef.current = [];

    // System audio first — its picker needs THIS click's gesture; a cancel or a
    // missing system-audio checkbox aborts cleanly (no error screen) before we
    // touch the mic or open any session.
    let system: MediaStream;
    try {
      system = await captureSystemAudio();
    } catch (error) {
      if (error instanceof SystemAudioError && error.reason === 'no-audio-track') {
        setMeetingHint(t('meeting.noSystemAudioHint'));
      } else if (error instanceof SystemAudioError && error.reason === 'aborted') {
        setMeetingHint(null); // user changed their mind — silent, back to ready
      } else {
        setMeetingHint(t('meeting.captureFailedHint'));
      }
      return; // stay in ready/stopped, nothing opened
    }

    // Mic next — App still owns BOTH streams until `liveCapture.start()`
    // below (U6 ownership handoff). If the mic is denied, `system` was never
    // handed off, so App tears IT down itself here (LiveCapture never saw it).
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      system.getTracks().forEach((track) => track.stop());
      setDeviceState((prev) => (prev === 'recording' ? prev : 'ready'));
      return;
    }

    // U6: LiveCapture owns both streams from here on — a failed `start()` (or
    // a failed `coordinator.start()` below, via the explicit `stop()` in the
    // catch) tears both back down, nothing half-open. No `onPcm`: record-only,
    // the meeting isn't transcribed live (keeps the GPU free for the meeting
    // app during the call) — RMS still drives the VU meter internally.
    const liveCapture = liveCaptureRef.current!;
    try {
      await liveCapture.start({ mic, system });

      // Record the MIX, tapping chunks for the post-hoc transcribe+diarize pass.
      const startRecorder: RecorderStarter = (onChunk) => {
        try {
          return startOpusRecorder(liveCapture.recordStream!, {
            onChunk: (blob) => {
              recordedChunksRef.current.push(blob);
              onChunk(blob);
            },
          });
        } catch {
          return null;
        }
      };

      // No `workerApi.start()` and no feed loop — the meeting is not transcribed
      // live. The coordinator streams the `.webm` (crash-safe) and, harmlessly,
      // opens the (unused, empty) `.txt`/`.srt`; the post-hoc pass fills them.
      await coordinatorRef.current!.start(startRecorder);
      setHasOutputTarget(true);
      setOutputName(coordinatorRef.current!.outputName);
      setElapsedMs(0);
      setDeviceState('recording');
    } catch {
      // `liveCapture.start()` failed, or the sink couldn't open — LiveCapture
      // owns mic/system teardown now; tear everything (incl. the system
      // share) down and return to ready. Nothing half-open.
      liveCapture.stop();
      setDeviceState((prev) => (prev === 'recording' ? prev : 'ready'));
    }
  }), [deviceState, runExclusive]);

  // §8 recovery offer resolution. Recover reconstructs the crashed session's
  // persisted transcript into the display (→ stopped, export visible); discard
  // just closes it so it stops being a crash candidate (→ ready).
  const resolveRecovery = useCallback(
    async (action: 'recover' | 'discard') => {
      const store = sessionStoreRef.current;
      const candidate = recoveryCandidate;
      setRecoveryCandidate(null);
      if (store && candidate) {
        if (action === 'recover') {
          const outcome = await recoverSession(store, candidate.id, Date.now());
          outcome?.segments.forEach((s) =>
            transcriptStoreRef.current?.append({ text: s.text, startMs: s.startMs, endMs: s.endMs }),
          );
        } else {
          await store.closeSession(candidate.id, Date.now());
        }
      }
      const landing = action === 'recover' ? 'stopped' : 'ready';
      // If the model isn't ready yet, fall back to whatever load phase we're
      // actually in — `downloading` only if a load is in flight, else the
      // `idle` pre-download landing (never show the download screen with no
      // download running).
      const preModel = engineSnapshot.status === 'downloading' ? 'downloading' : 'idle';
      setDeviceState(engineSnapshot.status === 'ready' ? landing : preModel);
    },
    [recoveryCandidate, engineSnapshot.status],
  );

  const toggleRecording = useCallback(() => {
    if (recording) {
      void stopRecording();
      return;
    }
    // Folder-first gate (finding 2): the RecordButton is disabled without a
    // storage target, but this callback is also the Space-bar path, which is
    // never gated by `disabled` — so it has to check for itself.
    if (!hasOutputTarget) return;
    // Plan 003: in meeting mode the start button drives the mic+system path.
    void (mode === 'meeting' ? startMeeting() : startRecording());
  }, [recording, hasOutputTarget, mode, startMeeting, startRecording, stopRecording]);

  // Spacebar starts/stops (§9). When a button/input already has focus, let the
  // browser's native activation handle it (avoids a double toggle); otherwise
  // this global handler drives it and suppresses the page-scroll default.
  //
  // U5: `Escape` closes the info view (added here, the same global handler —
  // see `InfoView`'s doc comment) — a second `Escape` while already closed is
  // a no-op (`setInfoOpen(false)` on an already-`false` state doesn't even
  // trigger a re-render). And the single, deliberate touch to the EXISTING
  // Space path (KTD8's "heikelster Punkt"): one added `if (infoOpen) return;`
  // right before `toggleRecording()`, nothing else in this branch reordered
  // or gated. This is safe for the U1/U2 race tests because `infoOpen` is
  // `false` in every one of them (none ever opens the info view) — the new
  // check is simply never reached in those scenarios, so the guarded
  // start/stop critical section below it is untouched.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setInfoOpen(false);
        return;
      }
      if (event.code !== 'Space' && event.key !== ' ') return;
      const active = document.activeElement;
      const tag = active?.tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      event.preventDefault();
      if (infoOpen) return; // U5 (KTD8): info view open — Space must not start/stop a recording
      toggleRecording();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleRecording, infoOpen]);

  // Folder-first gate (Plan 003 KTD-M6, extended to record mode by hardware
  // test 01 finding 1): the start button stays disabled until an output folder
  // exists, so the start click opens NO picker at all — in meeting mode
  // `getDisplayMedia` is then the only dialog, in record mode none. The screen
  // (`RecordSetupView`/`MeetingView`) is what offers the folder step.
  const canRecord =
    (deviceState === 'ready' || deviceState === 'stopped' || deviceState === 'recording') &&
    (recording || hasOutputTarget);

  // U8: dispatches directly on `deviceState`/`mode` (App owns both) — each
  // screen below gets only its own props, no pass-through wrapper.
  function renderScreen() {
    // U5's `infoOpen` branch used to live here — the info text replaced the
    // screen's content. It is a pop-up OVER the device now (owner feedback,
    // see `InfoView`), rendered next to `<main>`'s other children below, so
    // this function is back to dispatching on `deviceState` alone.

    // §1: the model load is user-initiated — nothing is fetched until this.
    if (deviceState === 'idle') return <IdleScreen onStartDownload={beginModelLoad} />;

    if (deviceState === 'downloading') return <DownloadingScreen loadProgress={engineSnapshot.progress} />;

    if (deviceState === 'importing') return <ImportingScreen importPhase={importPhase} importElapsedMs={importElapsedMs} />;

    if (deviceState === 'error') {
      return (
        <ErrorScreen
          errorHeadline={errorHeadline}
          errorMessage={errorMessage}
          modelLoadFailed={engineSnapshot.status === 'failed'}
          onStartDownload={beginModelLoad}
        />
      );
    }

    if (deviceState === 'recovery') {
      return (
        <RecoveryScreen
          recoveryCandidate={recoveryCandidate}
          onRecover={() => void resolveRecovery('recover')}
          onDiscard={() => void resolveRecovery('discard')}
        />
      );
    }

    if (deviceState === 'recording') {
      // Plan 003 record-only meeting: no live transcript (see MeetingRecordingView.tsx).
      if (mode === 'meeting') return <MeetingRecordingView />;
      // §6: the live transcript. `interimActive` stays false — Whisper has no
      // interim tier (KTD-W2), no interim is ever fed.
      return <LiveTranscript store={transcriptStoreRef.current!} interimActive={false} />;
    }

    if (deviceState === 'stopped') {
      return (
        <StoppedScreen
          store={transcriptStoreRef.current!}
          aligned={aligned}
          annotation={annotation}
          annotationError={annotationError}
          canAnnotate={pendingAnnotation !== null}
          onAnnotate={handleAnnotate}
          speakerCount={speakerCount}
          onSpeakerCountChange={setSpeakerCount}
        />
      );
    }

    // ready — U19: import screen, meeting screen, or the looping demo (§3),
    // per the active `mode` (see ImportView.tsx/MeetingView.tsx for why).
    // The one shared language dropdown all three landings mount once the
    // folder is set (owner decision: "nach Ordner wählen").
    const languageControl = <LanguageSelect value={language} onChange={setLanguage} />;
    if (mode === 'import') {
      return (
        <ImportView
          onFileSelected={handleFileSelected}
          hasOutputTarget={hasOutputTarget}
          onChooseFolder={handleChooseImportFolder}
          languageControl={languageControl}
        />
      );
    }
    if (mode === 'meeting')
      return (
        <MeetingView
          hasOutputTarget={hasOutputTarget}
          onChooseFolder={handleChooseImportFolder}
          hint={meetingHint}
          languageControl={languageControl}
        />
      );
    // Record mode: after a denied mic, name why the last attempt didn't start
    // and offer a one-click in-place retry; otherwise the looping demo (§3).
    if (micDenied) return <MicDeniedScreen onRetry={() => void startRecording()} />;
    // Folder-first setup, and the "now press" instruction right after it
    // (hardware test 01, finding 1 — see `RecordSetupView`/`prepareRecording`).
    if (!hasOutputTarget || setupHint) {
      return (
        <RecordSetupView
          hasOutputTarget={hasOutputTarget}
          outputName={outputName}
          onChooseFolder={() => void prepareRecording()}
          languageControl={languageControl}
        />
      );
    }
    // The language dropdown lives here too: a restored-folder session never
    // passes through `RecordSetupView`, so without it record mode would have
    // no way to set the transcription language at all.
    return (
      <>
        <DemoLoop />
        {/* Code-review Befund 2 (R11): R11 requires the consent sentence
            BEFORE the first possible press of the record button — and this
            fall-through display is the SECOND place (besides
            `RecordSetupView`'s `ready` branch above) where the button is
            live. Same key, same wording, no new string.
            Owner feedback (2026-07-26): it sits ABOVE the language dropdown,
            not below it — the record button punches through the screen's
            bottom edge and was cutting the last line in half, and of the two
            the consent sentence is the one that must stay readable. Same
            swap as in `RecordSetupView`'s ready branch. */}
        <p className="consent-note">{t('consent.note')}</p>
        {languageControl}
      </>
    );
  }

  return (
    <main className="device" data-state={deviceState}>
      {/* ── Kopf: Titel + Untertitel links, Mikrofon + LED rechts ─────────── */}
      <header className="device__head">
        <div className="device__title-block">
          <h1 className="device__title">
            {t('header.brandLocal')}
            <span className="device__title-rec">{t('header.brandRec')}</span>
          </h1>
          <div className="device__hairline" role="presentation" />
          <p className="device__subtitle">{t('header.subtitleTagline')}</p>
          <p className="device__subtitle">{t('header.subtitleFlightMode')}</p>
        </div>
        {/* Top-right corner, stacked above the mic column. Wrapping the
            language switcher together with `.device__mic` in
            `.device__head-right` keeps `.device__head`'s own flex row at
            exactly two children (title block, this wrapper) — unchanged
            `justify-content: space-between` behaviour, no bump to the title
            block or the mic column. Always rendered, in every
            `deviceState`.
            Owner feedback (2026-07-26): U5's "i" info button used to sit in
            this row next to the switcher. It is gone — the info window is
            opened by the "How it works" engraving under the display instead
            (see `.panel-wrap` below), which frees this corner for the one
            control that belongs in it and lets `.device__head-actions` pull
            further out into the corner (theme.css). */}
        <div className="device__head-right">
          <div className="device__head-actions">
            <LocaleSwitch />
          </div>
          <div className="device__mic">
            <span className="mic-grille" aria-hidden="true" />
            <span className="led" aria-hidden="true" />
          </div>
        </div>
      </header>

      {/* ── Bühne: Displayrahmen (seiten-zentriert), VU als Overlay am Panel ─ */}
      <section className="stage">
        {/* U19 (IM-2): switchable only while idle/ready — never mid-download,
            mid-recording or mid-recovery, so a mode switch can't interrupt
            anything already in flight (see App.tsx's U19 addendum above).
            While a download/import/recovery runs it stays MOUNTED but hidden
            (`visibility`), so it keeps its row in the stage grid: unmounting it
            on the "Modell laden" click pulled the whole display upwards, and
            the page jumped although only the screen's content had changed. It
            is dropped entirely for recording/stopped — there the chrome really
            does leave and the display grows into its place (§4 morph). */}
        {deviceState !== 'recording' && deviceState !== 'stopped' && (
          <div className="stage__toggle" data-visible={deviceState === 'idle' || deviceState === 'ready'}>
            <ModeToggle
              value={mode}
              onChange={(next) => {
                setMeetingHint(null); // a fresh mode starts without a stale meeting hint
                setMicDenied(false); // …and without a stale mic-denied screen
                setMode(next);
              }}
              meetingAvailable={meetingAvailable}
            />
          </div>
        )}

        <div className="panel-wrap">
          {/* The mic level (§7: raw mic RMS, not transcription progress). Two
              alignments at once: vertically centred on the DISPLAY (hence a
              child of the panel — only the panel knows where its middle is),
              horizontally on the same axis as the grille above it, so the two
              read as one column. Absolute, so it can never shift
              the panel's centring (and with it the record button's centre). */}
          <div className="mic-level">
            <VuMeter getLevel={liveCaptureRef.current!.getLevel} active={recording} />
            <span className="mic-caption">{t('device.micCaption')}</span>
          </div>

          <div className="panel">
            <div className="screen">{renderScreen()}</div>
            {/* Code-review Befund 1 (four independent reviewers): the
                RecordButton renders OUTSIDE `renderScreen()`'s `infoOpen`
                branch, so it stayed visible and clickable while the info
                view covered the screen — a click there started a recording
                behind the open info view, the opposite of what a consent
                notice is for. Fixed render-side, deliberately NOT inside
                `toggleRecording`: that callback also drives the Space path
                the U1/U2 race tests depend on, and `infoOpen` is `false` in
                every one of those scenarios, so touching it there would risk
                that guarded critical section for no reason. Gating the
                button's `disabled` prop instead leaves `toggleRecording` and
                its dependencies completely untouched. */}
            {/* `processing` is symbol-only (owner feedback, 2026-07-26): during
                an import the device is busy with audio, so it shows the stop
                square rather than a play triangle that invites a press. It
                stays disabled either way — `canRecord` is false in
                `'importing'`, and this changes no behaviour, only the mark. */}
            <RecordButton
              recording={recording}
              processing={deviceState === 'importing'}
              disabled={!canRecord || busy || infoOpen}
              onClick={toggleRecording}
            />
          </div>

          {/* The two engravings under the display's bottom edge, both in the
              old `MOD.001` lettering (owner feedback, 2026-07-26 — that badge
              was decoration; these are the two things a user actually needs
              down here, in the same quiet voice):
                left  — "clear with refresh": wipe the locally cached
                        recordings and reload (see `handleClearAndRefresh`),
                        replacing S2's red button inside the screen;
                right — "How it works": opens the info pop-up, replacing the
                        "i" button that used to sit in the header corner.
              Shown whenever the device is at REST — `idle`, `ready`,
              `stopped` — and never during a download, recording, import or
              recovery, none of which may be interrupted by a reload or a
              side-trip into the info text.
              `stopped` is deliberately included, and it is not cosmetic: with
              the knob gone (owner feedback, same round) "clear with refresh"
              is now the ONLY way back from a finished recording to the start
              screen. Without it the red button would still be live on the
              stopped screen and would start a second recording into the FIRST
              one's already-open folder, appending into its `transkript.*` —
              exactly the failure hardware test 01 finding 2 fixed. A reload
              drops `restoredSinkRef`, so the next recording asks for its own
              storage location again, which is what that finding requires. */}
          {(deviceState === 'idle' || deviceState === 'ready' || deviceState === 'stopped') && (
            <>
              <button
                type="button"
                className="panel__engraving panel__clear"
                onClick={handleClearAndRefresh}
                title={t('clear.withRefreshHint')}
              >
                {t('clear.withRefresh')}
              </button>
              <button
                type="button"
                className="panel__engraving panel__mod"
                onClick={() => setInfoOpen(true)}
              >
                {t('info.buttonLabel')}
              </button>
            </>
          )}
        </div>
      </section>

      {/* ── Fuss: Schritte + Klinke links, Timer + Status rechts ─────────── */}
      <footer className="device__foot">
        <div className="foot__left">
          <LineInJack />
          <Steps
            deviceState={deviceState}
            modelReady={engineSnapshot.status === 'ready'}
            hasOutputTarget={hasOutputTarget}
            finalizing={finalizing}
            outputName={outputName}
            mode={mode}
            annotation={annotation}
          />
        </div>
        <div className="foot__right">
          {recording && <span className="device__rec">{t('device.recBadge')}</span>}
          <span className="device__timer">{formatTimer(recording || deviceState === 'stopped' ? elapsedMs : 0)}</span>
          <span className="device__status">{t('device.status')}</span>
        </div>
      </footer>

      {/* The info pop-up (owner feedback, 2026-07-26): a window over the whole
          device, styled like the display itself and scrolling internally —
          NOT the display-area swap U5 built. Rendered last so it paints above
          everything without needing a portal; `.device` creates no
          transform/filter containing block, so the modal's `position: fixed`
          escapes its `overflow: hidden` cleanly. Nothing behind it is
          reachable while it is open: `RecordButton` is disabled on `infoOpen`
          above, and the Space handler returns early. */}
      {infoOpen && <InfoView onClose={() => setInfoOpen(false)} />}
    </main>
  );
}
