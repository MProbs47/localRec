import type { StringKey } from './index';

/**
 * German table — carries the unchanged original UI text extracted verbatim
 * from the code in this part (KTD6: pure, mechanical refactor, zero visible
 * change). `Record<StringKey, string>` (not `Partial`): a missing or
 * overtyped key here is a TypeScript error, which is the completeness
 * proof (KTD2) — no separate sync test needed.
 */
export const de: Record<StringKey, string> = {
  'speaker.label': 'Sprecher {n}',

  'engine.modelStalled':
    'Modell-Laden reagiert nicht mehr — bitte Seite neu laden und erneut versuchen.',
  'engine.webgpuUnsupported':
    'Dieses Gerät oder dieser Browser unterstützt kein WebGPU — die Transkription kann hier nicht laufen. Aktueller Chrome oder Edge wird benötigt.',
  // Code-review Befund 4: wortgleich mit dem bisherigen Literal in
  // `engine.ts` — die auf Deutsch gepinnte Suite bleibt dadurch unverändert
  // grün.
  'engine.workerCrashed': 'Transkriptions-Worker abgestürzt.',
  'engine.workerCrashedDetail': 'Transkriptions-Worker abgestürzt: {detail}',

  'format.hours': 'H',
  'format.minutes': 'MIN',

  // --- Part b of U3 (`src/App.tsx`) ---------------------------------------

  'header.brandLocal': 'local',
  'header.brandRec': 'Rec',
  'header.subtitleTagline': 'Transkription, die dein Gerät nie verlässt',
  'header.subtitleFlightMode': 'Flugmodus einschalten. Es läuft weiter.',

  'device.micCaption': 'Mikrofon',
  'device.recBadge': 'REC',
  'device.status': 'WEBGPU · NET 0',

  'error.modelLoadHeadline': 'Modell konnte nicht geladen werden.',
  'error.importFailedHeadline': 'Verarbeitung fehlgeschlagen.',
  'error.importFailedDetailFallback': 'Audio konnte nicht verarbeitet werden',

  'annotation.unknownErrorFallback': 'unbekannter Fehler',

  'meeting.noSystemAudioHint':
    'Kein Systemaudio erhalten — beim Teilen das Häkchen „Audio freigeben" setzen und erneut starten.',
  'meeting.captureFailedHint': 'Systemaudio konnte nicht erfasst werden.',

  // --- Part c of U3 (`src/ui/*.tsx` extraction) ---------------------------

  'demo.line1': 'KEINE DATEN VERLASSEN DEIN GERÄT.',
  'demo.line2': 'MODELL EINMAL LADEN — ~1.5 GB.',
  'demo.line3': 'DANN FLUGMODUS. ES LÄUFT WEITER.',
  'demo.line4': 'AUFNAHME DRÜCKEN UND SPRECHEN',

  'device.lineInLabel': 'LINE IN',

  'firstRun.idleMessage':
    'Einmalig ~1.5 GB laden. Danach läuft alles offline auf deinem Gerät — nichts wird gesendet.',
  'firstRun.startDownload': 'Modell laden',
  'firstRun.downloadingMessage': 'Modell wird geladen. Kein zweites Mal.',
  'firstRun.downloadProgress': '{mb} MB / ~1500 MB · {pct}%',
  'firstRun.decodingLabel': 'Datei wird dekodiert',
  'firstRun.transcribingLabel': 'Transkription läuft',
  'firstRun.elapsedSince': 'läuft seit {elapsed}',
  'firstRun.longRunningNote':
    'Lange Aufnahmen brauchen ein paar Minuten — es läuft weiter, im Hintergrund.',

  'common.retry': 'Erneut versuchen',

  'import.needsFolderMessage':
    'Zuerst einen Speicherort wählen — dorthin wird die Transkription geschrieben.',
  'import.message':
    'Vorhandene Audiodatei laden — wird vollständig on-device verarbeitet. Nichts verlässt dein Gerät.',
  'import.pickFile': 'Datei wählen',
  'import.selected': 'Ausgewählt: «{name}» — wird verarbeitet …',

  'setup.chooseFolder': 'Ordner wählen',

  'language.label': 'Sprache der Aufnahme',
  'language.de': 'Deutsch',
  'language.en': 'English',
  'language.it': 'Italiano',
  'language.fr': 'Français',
  'language.es': 'Español',

  // --- U4 part b (`src/ui/LocaleSwitch.tsx`) ------------------------------

  'localeSwitch.label': 'Sprache der Oberfläche',

  'transcript.jumpToLive': '↓ LIVE',

  'meeting.recordingLabel': 'Aufnahme läuft',
  'meeting.recordingHint':
    'Mikro + Meeting-Ton werden mitgeschnitten. Transkription & Sprecher folgen nach dem Stopp.',

  'meeting.needsFolderMessage': 'Zuerst einen Speicherort wählen — dann das Meeting starten.',
  'meeting.shareInstruction': '„Aufnahme" drücken, dann im Teilen-Dialog „Ganzer Bildschirm" wählen und „Audio freigeben" ankreuzen.',
  'meeting.aside': 'Kopfhörer empfohlen — sonst nimmt das Mikro den Lautsprecher doppelt auf.',

  'mic.deniedHeadline': 'Mikrofon-Zugriff abgelehnt.',
  'mic.deniedDetail': 'Bitte den Mikrofonzugriff im Browser erlauben, dann erneut versuchen.',

  'mode.ariaLabel': 'Eingangsart',
  'mode.record': 'Lokale Aufnahme',
  'mode.import': 'Datei laden',
  'mode.meeting': 'Online Meeting',

  'record.startLabel': 'Aufnahme starten',
  'record.stopLabel': 'Aufnahme stoppen',

  'setup.micFolderMessage':
    'Zuerst den Speicherort wählen und das Mikrofon freigeben — dann mittels rotem Knopf in der Mitte die Aufnahme starten.',
  'setup.chooseLocation': 'Speicherort wählen',
  'setup.writeNote': 'Transkript und Audio werden fortlaufend in diesen Ordner geschrieben.',
  'setup.readyMessage': 'Bereit. Mit dem roten Knopf in der Mitte die Aufnahme starten.',
  'setup.readyNoteWithFolder': 'Speicherort: {folder} Mikrofon freigegeben.',
  'setup.readyNoteDefault': 'Speicherort gewählt. Mikrofon freigegeben.',

  'recovery.headline': 'UNTERBROCHENE AUFNAHME — {duration}',
  'recovery.resume': 'Fortsetzen',
  'recovery.discard': 'Verwerfen',

  'speaker.nameForLabel': 'Name für {label}',

  'steps.transcriptionDone': 'Transkription fertig',
  'steps.recordingStopped': 'Aufnahme gestoppt',
  'steps.savedIn': 'Gespeichert in {folder}',
  'steps.saved': 'Gespeichert',
  'steps.saving': 'Wird gespeichert …',
  'steps.speakersDetected': 'Sprecher erkannt',
  'steps.finishedSaved': 'Fertig — Transkript gespeichert',
  'steps.modelLoaded': 'Modell geladen',
  'steps.locationSet': 'Speicherort gesetzt',
  'steps.locationChooseFolder': 'Speicherort — Ordner wählen',
  'steps.locationChooseAtStart': 'Speicherort — beim Start wählen',
  'steps.transcribingFile': 'Datei wird transkribiert …',
  'steps.pickAndTranscribe': 'Datei wählen & transkribieren',
  'steps.meetingTranscribing': 'Transkription läuft …',
  'steps.recordMeeting': 'Meeting aufnehmen',
  'steps.recording': 'Aufnahme',

  'annotation.detecting': 'Sprecher werden erkannt',

  'stopped.retryDetection': 'Sprecher-Erkennung erneut versuchen',
  'stopped.reDetect': 'Neu erkennen',
  'stopped.detectSpeakers': 'Sprecher erkennen',
  'stopped.speakerCountAriaLabel': 'Anzahl Sprecher',
  'stopped.correctSpeakerCount': 'Anzahl Sprecher korrigieren:',
  'stopped.speakerCountLabel': 'Anzahl Sprecher:',
  'stopped.autoChip': 'Auto',
  'stopped.detectionUnavailable':
    'Sprecher-Erkennung nicht möglich: {error} — das Transkript ist vollständig gespeichert. Details in der Browser-Konsole.',

  'clear.withRefresh': 'Löschen & neu laden',
  'clear.withRefreshHint':
    'Löscht die lokal zwischengespeicherten Aufnahmen und lädt die Seite neu. Die Dateien im gewählten Ordner bleiben.',

  'vu.label': 'IN',

  // --- U5 (`src/ui/InfoView.tsx`) — Info-Knopf + Info-Ansicht --------------
  // Deutscher Quelltext verbatim aus dem Plan („Textquellen" → „Info-Ansicht
  // (U5)"), nicht selbst formuliert.
  'info.buttonLabel': 'So funktioniert es',
  'info.backLabel': 'Zurück',

  'info.whatHeading': 'Was hier passiert',
  'info.what1': 'localRec schreibt mit, was gesprochen wird — direkt auf deinem Gerät.',
  'info.what2':
    'Beim ersten Start lädst du einmal ein Sprachmodell herunter; danach braucht die App kein Internet mehr.',
  'info.what3':
    'Aufnahme, Transkription und Sprecher-Erkennung rechnen alle hier, auf diesem Gerät — nichts wird hochgeladen, es gibt keine Konten und keine Auswertung.',
  'info.what4': 'Was zählt, sind die Dateien im Ordner, den du gewählt hast: sie sind das Ergebnis.',
  'info.what5':
    'Was der Browser sonst noch zwischenspeichert, ist nur ein Zwischenspeicher — du darfst ihn jederzeit löschen.',

  'info.stepsHeading': 'In drei Schritten',
  'info.step1': 'Ordner wählen — dorthin werden Transkript und Audio geschrieben.',
  'info.step2': 'Roten Knopf drücken, sprechen, wieder drücken. Das war die Aufnahme.',
  'info.step3':
    '„Sprecher erkennen" — teilt das Transkript auf die einzelnen Stimmen auf. Das dauert ein paar Minuten.',

  'info.summaryHeading': 'Am Schluss: zusammenfassen lassen',
  'info.summaryIntro':
    'Für die Zusammenfassung nimmst du am besten ein grosses Sprachmodell deiner Wahl. Hier sind zwei fertige Anweisungen zum Kopieren — Datei anhängen, Text einfügen, fertig.',
  // KTD10, nicht verhandelbar.
  'info.summaryDeviceLimit': 'Dieser letzte Schritt verlässt dein Gerät — du entscheidest, was du wohin kopierst.',

  'info.promptSpeakerLabel': 'Besprechung mit Sprechern (transkript-sprecher.txt)',
  'info.promptSpeakerText':
    'Im Anhang das Transkript einer Besprechung, automatisch erstellt.\n\nDie Sprecherlabels (Sprecher 1, Sprecher 2, …) sind akustisch geschätzt und nicht immer richtig: An Sprecherwechseln kann ein einzelner Satz dem falschen Sprecher zugeordnet sein. Korrigiere solche offensichtlichen Grenzfehler stillschweigend, wenn der Zusammenhang es eindeutig macht, und frag nicht nach.\n\nFasse zusammen: worum es ging · was entschieden wurde · was offen blieb · wer was übernimmt.\n\nHalte dich an das, was im Text steht. Erfinde nichts, und wenn etwas unklar bleibt, schreib das hin.',

  'info.promptSimpleLabel': 'Einfaches Transkript (transkript.txt)',
  'info.promptSimpleText':
    'Im Anhang das Transkript einer Aufnahme, automatisch erstellt — es kann Hörfehler enthalten.\n\nFasse zusammen: worum es ging · was entschieden wurde · was offen blieb · wer was übernimmt, soweit erkennbar.\n\nHalte dich an das, was im Text steht. Erfinde nichts, und wenn etwas unklar bleibt, schreib das hin.',

  'info.copyLabel': 'Kopieren',
  'info.copiedLabel': 'Kopiert.',
  'info.copyFailedLabel': 'Kopieren fehlgeschlagen.',

  'info.disclaimerHeading': 'Ohne Gewähr',
  'info.disclaimerText':
    'localRec ist ein privates Werkzeug und wird so bereitgestellt, wie es ist. Transkript und Sprecher-Erkennung entstehen maschinell und können Fehler enthalten — prüf nach, was dir wichtig ist. Für Schäden oder Verpasstes kann niemand geradestehen.',

  // --- U6 (`RecordSetupView.tsx`/`MeetingView.tsx`) — Einwilligungs-Hinweis -
  // Deutscher Quelltext verbatim aus dem Plan („Textquellen" →
  // „Einwilligungs-Hinweis (U6)"), nicht selbst formuliert.
  'consent.note':
    'Mit dem Start bestätigst du: Alle Teilnehmenden wissen von der Aufnahme und sind einverstanden.',
};
