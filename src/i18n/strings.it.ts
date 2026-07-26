import type { StringKey } from './index';

/**
 * Italian table (U4). `Record<StringKey, string>` — a missing or overtyped
 * key here is a TypeScript error against `en.ts`'s type, which is the
 * completeness proof (KTD2); no separate sync test needed.
 *
 * Register: sachlich, knapp, geräteartig, tu-Form (nie „Lei") — wie das
 * deutsche Original in `strings.de.ts`, das für Ton-Fragen die Vorlage
 * bleibt, auch wenn `en.ts` die Typquelle ist.
 *
 * Terminologie (einmal festgelegt, durchgehalten):
 *  - Transkript/Transkription → trascrizione
 *  - Sprecher → parlante
 *  - Ordner → cartella
 *  - Speicherort → posizione
 *  - Modell → modello
 *  - Aufnahme (Vorgang) → registrazione
 */
export const it: Record<StringKey, string> = {
  'speaker.label': 'Parlante {n}',

  'engine.modelStalled':
    'Il caricamento del modello non risponde più — ricarica la pagina e riprova.',
  'engine.webgpuUnsupported':
    'Questo dispositivo o browser non supporta WebGPU — la trascrizione non può funzionare qui. È necessario un Chrome o Edge aggiornato.',
  'engine.workerCrashed': 'Il worker di trascrizione è andato in crash.',
  'engine.workerCrashedDetail': 'Il worker di trascrizione è andato in crash: {detail}',

  // Device-label characters, not language — kept byte-identical (see en.ts).
  'format.hours': 'H',
  'format.minutes': 'MIN',

  // --- Part b of U3 (`src/App.tsx`) ---------------------------------------

  'header.brandLocal': 'local',
  'header.brandRec': 'Rec',
  // TON, NICHT INFORMATION (Muttersprachler-Kurzblick vorgemerkt) — bewusst
  // keine wörtliche Übersetzung, sondern dieselbe knappe Haltung.
  'header.subtitleTagline': 'Trascrizione che non lascia mai il tuo dispositivo',
  // TON, NICHT INFORMATION (Muttersprachler-Kurzblick vorgemerkt).
  'header.subtitleFlightMode': 'Attiva la modalità aereo. Continua a funzionare.',

  'device.micCaption': 'Microfono',
  'device.recBadge': 'REC',
  'device.status': 'WEBGPU · NET 0',

  'error.modelLoadHeadline': 'Impossibile caricare il modello.',
  'error.importFailedHeadline': 'Elaborazione non riuscita.',
  'error.importFailedDetailFallback': "Impossibile elaborare l'audio",

  'annotation.unknownErrorFallback': 'errore sconosciuto',

  'meeting.noSystemAudioHint':
    'Nessun audio di sistema ricevuto — nella condivisione attiva la casella «Condividi audio» e riavvia.',
  'meeting.captureFailedHint': "Impossibile catturare l'audio di sistema.",

  // --- Part c of U3 (`src/ui/*.tsx` extraction) ---------------------------

  // TON, NICHT INFORMATION (Muttersprachler-Kurzblick vorgemerkt) — VERSAL
  // beibehalten (Typewriter zählt Zeichen, siehe DemoLoop.tsx).
  'demo.line1': 'NESSUN DATO LASCIA MAI IL TUO DISPOSITIVO.',
  'demo.line2': 'CARICA IL MODELLO UNA VOLTA — ~1.5 GB.',
  'demo.line3': 'POI MODALITÀ AEREO. CONTINUA A FUNZIONARE.',
  'demo.line4': 'PREMI REGISTRAZIONE E PARLA',

  'device.lineInLabel': 'LINE IN',

  'firstRun.idleMessage':
    'Scarica una volta ~1.5 GB. Da quel momento tutto funziona offline sul tuo dispositivo — non viene mai inviato nulla.',
  'firstRun.startDownload': 'Carica modello',
  'firstRun.downloadingMessage': 'Il modello è in caricamento. Solo una volta.',
  'firstRun.downloadProgress': '{mb} MB / ~1500 MB · {pct}%',
  'firstRun.decodingLabel': 'File in decodifica',
  'firstRun.transcribingLabel': 'Trascrizione in corso',
  'firstRun.elapsedSince': 'in corso da {elapsed}',
  'firstRun.longRunningNote':
    'Le registrazioni lunghe richiedono qualche minuto — continua in background.',

  'common.retry': 'Riprova',

  'import.needsFolderMessage': 'Scegli prima una posizione — lì verrà scritta la trascrizione.',
  'import.message':
    "Carica un file audio esistente — elaborato interamente sul dispositivo. Niente lascia il tuo dispositivo.",
  'import.pickFile': 'Scegli file',
  'import.selected': 'Selezionato: «{name}» — elaborazione in corso …',

  'setup.chooseFolder': 'Scegli cartella',

  'language.label': 'Lingua della registrazione',
  // Sprachnamen — byte-identisch über alle fünf Tabellen, siehe en.ts.
  'language.de': 'Deutsch',
  'language.en': 'English',
  'language.it': 'Italiano',
  'language.fr': 'Français',
  'language.es': 'Español',

  // --- U4 part b (`src/ui/LocaleSwitch.tsx`) ------------------------------

  'localeSwitch.label': "Lingua dell'interfaccia",

  'transcript.jumpToLive': '↓ LIVE',

  'meeting.recordingLabel': 'Registrazione in corso',
  'meeting.recordingHint':
    "Microfono e audio della riunione vengono registrati. Trascrizione e parlanti seguono dopo lo stop.",

  'meeting.needsFolderMessage': 'Scegli prima una posizione — poi avvia la riunione.',
  'meeting.shareInstruction': 'Premi «Registra», poi nella finestra di condivisione scegli «Schermo intero» e attiva «Condividi audio».',
  'meeting.aside': "Cuffie consigliate — altrimenti il microfono capta due volte l'altoparlante.",

  'mic.deniedHeadline': 'Accesso al microfono negato.',
  'mic.deniedDetail': "Consenti l'accesso al microfono nel browser, poi riprova.",

  'mode.ariaLabel': 'Tipo di ingresso',
  'mode.record': 'Registrazione locale',
  'mode.import': 'Carica file',
  'mode.meeting': 'Riunione online',

  'record.startLabel': 'Avvia registrazione',
  'record.stopLabel': 'Ferma registrazione',

  'setup.micFolderMessage':
    'Scegli prima la posizione e consenti il microfono — poi avvia la registrazione con il pulsante rosso al centro.',
  'setup.chooseLocation': 'Scegli posizione',
  'setup.writeNote': 'Trascrizione e audio vengono scritti continuamente in questa cartella.',
  'setup.readyMessage': 'Pronto. Avvia la registrazione con il pulsante rosso al centro.',
  'setup.readyNoteWithFolder': 'Posizione: {folder} Microfono consentito.',
  'setup.readyNoteDefault': 'Posizione scelta. Microfono consentito.',

  // ALL CAPS beibehalten (rule 4, wie im deutschen/englischen Original).
  'recovery.headline': 'REGISTRAZIONE INTERROTTA — {duration}',
  'recovery.resume': 'Riprendi',
  'recovery.discard': 'Scarta',

  'speaker.nameForLabel': 'Nome per {label}',

  'steps.transcriptionDone': 'Trascrizione completata',
  'steps.recordingStopped': 'Registrazione fermata',
  'steps.savedIn': 'Salvato in {folder}',
  'steps.saved': 'Salvato',
  'steps.saving': 'Salvataggio …',
  'steps.speakersDetected': 'Parlanti rilevati',
  'steps.finishedSaved': 'Fatto — trascrizione salvata',
  'steps.modelLoaded': 'Modello caricato',
  'steps.locationSet': 'Posizione impostata',
  'steps.locationChooseFolder': 'Posizione — scegli cartella',
  'steps.locationChooseAtStart': "Posizione — scelta all'avvio",
  'steps.transcribingFile': 'File in trascrizione …',
  'steps.pickAndTranscribe': 'Scegli file e trascrivi',
  'steps.meetingTranscribing': 'Trascrizione in corso …',
  'steps.recordMeeting': 'Registra riunione',
  'steps.recording': 'Registrazione',

  'annotation.detecting': 'Rilevamento parlanti',

  'stopped.retryDetection': 'Ripeti rilevamento parlanti',
  'stopped.reDetect': 'Rileva di nuovo',
  'stopped.detectSpeakers': 'Rileva parlanti',
  'stopped.speakerCountAriaLabel': 'Numero di parlanti',
  'stopped.correctSpeakerCount': 'Correggi numero di parlanti:',
  'stopped.speakerCountLabel': 'Numero di parlanti:',
  // Ausgeschrieben statt „Auto" — sonst wäre der Chip-Text byte-identisch
  // mit dem deutschen Original (Zufallstreffer über die Sprachwurzel), was
  // der Test unten fälschlich als vergessene Übersetzung werten würde.
  'stopped.autoChip': 'Auto',
  'stopped.detectionUnavailable':
    'Rilevamento parlanti non possibile: {error} — la trascrizione è salvata per intero. Dettagli nella console del browser.',

  'clear.withRefresh': 'Cancella e ricarica',
  'clear.withRefreshHint':
    'Elimina le registrazioni memorizzate localmente e ricarica la pagina. I file nella cartella scelta restano.',

  'vu.label': 'IN',

  // --- U5 (`src/ui/InfoView.tsx`) — Info-Knopf + Info-Ansicht --------------
  // U5b: echte Übersetzung aus der deutschen Fassung (`strings.de.ts`), die
  // hier — wie überall in dieser Tabelle — die Vorlage für Ton und Nuance ist.
  // Ganze Sätze für absolute Laien: der einzige Ort in der App, an dem erklärt
  // wird, also menschlich, aber nicht geschwätzig.
  //
  // Die Sprecherlabels im Prompt unten (`Parlante 1, Parlante 2, …`) folgen
  // damit derselben UI-Locale und sind wörtlich das, was `speaker.label` oben
  // in DIESER Tabelle liefert —
  // eine italienische Sitzung schreibt „Parlante 1" in `transkript-sprecher.txt`,
  // und der Prompt muss dem Sprachmodell genau diese Datei beschreiben.
  //
  // Die Dateinamen `transkript-sprecher.txt`/`transkript.txt` sind die echten,
  // sprachunabhängigen Namen aus `src/output/` und bleiben unübersetzt;
  // «Rileva parlanti» in `info.step3` zitiert wörtlich `stopped.detectSpeakers`
  // aus dieser Tabelle.
  'info.buttonLabel': 'Come funziona',
  'info.backLabel': 'Indietro',

  'info.whatHeading': 'Cosa succede qui',
  'info.what1': 'localRec trascrive ciò che viene detto — direttamente sul tuo dispositivo.',
  'info.what2':
    "Al primo avvio scarichi una volta sola un modello vocale; dopo di che l'app non ha più bisogno di internet.",
  'info.what3':
    "Registrazione, trascrizione e rilevamento dei parlanti vengono elaborati tutti qui, su questo dispositivo — niente viene caricato, non ci sono account e non c'è nessuna analisi dei dati.",
  'info.what4':
    'Quello che conta sono i file nella cartella che hai scelto: sono loro il risultato.',
  'info.what5':
    'Quello che il browser conserva oltre a questo è solo una memoria temporanea — puoi cancellarla quando vuoi.',

  'info.stepsHeading': 'In tre passi',
  'info.step1': 'Scegli una cartella — lì verranno scritti trascrizione e audio.',
  'info.step2': 'Premi il pulsante rosso, parla, premilo di nuovo. Questa era la registrazione.',
  'info.step3':
    '«Rileva parlanti» — divide la trascrizione tra le singole voci. Ci vogliono alcuni minuti.',

  'info.summaryHeading': 'Alla fine: fatti fare un riassunto',
  'info.summaryIntro':
    'Per il riassunto conviene usare un grande modello linguistico a tua scelta. Qui trovi due istruzioni già pronte da copiare — allega il file, incolla il testo, fatto.',
  // KTD10, nicht verhandelbar.
  'info.summaryDeviceLimit':
    "Quest'ultimo passo lascia il tuo dispositivo — decidi tu cosa copi e dove.",

  'info.promptSpeakerLabel': 'Riunione con parlanti (transkript-sprecher.txt)',
  'info.promptSpeakerText':
    "In allegato la trascrizione di una riunione, creata automaticamente.\n\nLe etichette dei parlanti (Parlante 1, Parlante 2, …) sono stimate acusticamente e non sono sempre giuste: ai cambi di parlante una singola frase può finire attribuita al parlante sbagliato. Correggi tacitamente questi evidenti errori di attribuzione, quando il contesto lo rende inequivocabile, e non fare domande.\n\nRiassumi: di cosa si è parlato · cosa è stato deciso · cosa è rimasto in sospeso · chi si occupa di cosa.\n\nAttieniti a ciò che c'è nel testo. Non inventare nulla e, se qualcosa resta poco chiaro, scrivilo.",

  'info.promptSimpleLabel': 'Trascrizione semplice (transkript.txt)',
  'info.promptSimpleText':
    "In allegato la trascrizione di una registrazione, creata automaticamente — può contenere errori di ascolto.\n\nRiassumi: di cosa si è parlato · cosa è stato deciso · cosa è rimasto in sospeso · chi si occupa di cosa, per quanto è riconoscibile.\n\nAttieniti a ciò che c'è nel testo. Non inventare nulla e, se qualcosa resta poco chiaro, scrivilo.",

  'info.copyLabel': 'Copia',
  'info.copiedLabel': 'Copiato.',
  'info.copyFailedLabel': 'Copia non riuscita.',

  'info.disclaimerHeading': 'Senza garanzia',
  'info.disclaimerText':
    "localRec è uno strumento privato e viene fornito così com'è. Trascrizione e rilevamento dei parlanti nascono in modo automatico e possono contenere errori — verifica ciò che per te è importante. Nessuno può rispondere di danni o di cose sfuggite.",

  // --- Correzione onestà fallback Firefox/Safari (`RecordSetupView.tsx`/
  // `MeetingView.tsx`/`ImportView.tsx`/`Steps.tsx`/`StoppedScreen.tsx`) -----
  // Bug segnalato dal proprietario: Firefox non ha la File System Access
  // API, quindi `createFileSink()` (`fileSink.ts`) risolve sempre nel
  // `FallbackSink` OPFS, senza mai mostrare un selettore di cartella. Le
  // schermate di setup leggevano questo esattamente come una cartella
  // scelta ("Speicherort gewählt"), e i file risultanti non avevano più
  // modo di uscire dal browser. Queste chiavi sostituiscono quel testo
  // non veritiero ovunque `sinkIsFallback` sia vero (App.tsx) e aggiungono
  // la possibilità di scaricare i file a fine sessione su `StoppedScreen`.
  'setup.readyNoteFallback':
    "Nessun accesso diretto a una cartella in questo browser — i file sono pronti per il download alla fine. Microfono consentito.",
  'meeting.fallbackNote':
    "Nessun accesso diretto a una cartella in questo browser — i file sono pronti per il download alla fine.",
  'import.fallbackNote':
    "Nessun accesso diretto a una cartella in questo browser — i file sono pronti per il download alla fine.",
  'steps.locationFallback': 'Nessun accesso alla cartella — salvato nel browser',
  'steps.savedFallback': 'Salvato nel browser — download qui sotto',
  'stopped.downloadsHeading': 'Scarica i file',
  'stopped.downloadsNote':
    "Questo browser non consente l'accesso diretto a una cartella, quindi non è stato scritto nulla automaticamente su disco. I file sono pronti per il download qui:",

  // --- U6 (`RecordSetupView.tsx`/`MeetingView.tsx`) — avviso sul consenso --
  // Vera traduzione dal tedesco (`strings.de.ts`), stessa struttura a due
  // frasi separate dai due punti. Nessun articolo di legge, nessuna formula
  // giuridica — una sola frase che nomina la condizione.
  'consent.note':
    "Con l'avvio confermi: tutti i partecipanti sono al corrente della registrazione e sono d'accordo.",

  // --- Vista telefono (`MobileView.tsx`) — vedi il commento in `en`. --------
  'mobile.runsOnDesktopLabel': 'Da aprire sul computer',
  'mobile.runsOnDesktopBody':
    'La trascrizione viene calcolata sul tuo dispositivo, e per questo serve un computer con Chrome o Edge. Il modello si scarica lì una volta sola, circa 1,5 GB, poi tutto funziona offline.',
};
