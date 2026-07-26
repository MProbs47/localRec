import type { StringKey } from './index';

/**
 * French table (U4). `Record<StringKey, string>` — a missing or overtyped
 * key here is a TypeScript error against `en.ts`'s type, which is the
 * completeness proof (KTD2); no separate sync test needed.
 *
 * Register: sachlich, knapp, geräteartig, tu-Form (nie „vous") — wie das
 * deutsche Original in `strings.de.ts`, das für Ton-Fragen die Vorlage
 * bleibt, auch wenn `en.ts` die Typquelle ist.
 *
 * Terminologie (einmal festgelegt, durchgehalten):
 *  - Transkript/Transkription → transcription
 *  - Sprecher → locuteur (follows the UI locale: „Locuteur 1" in `speakerLabel()`)
 *  - Ordner → dossier
 *  - Speicherort → emplacement
 *  - Modell → modèle
 *  - Aufnahme (Vorgang) → enregistrement
 */
export const fr: Record<StringKey, string> = {
  'speaker.label': 'Locuteur {n}',

  'engine.modelStalled':
    'Le chargement du modèle ne répond plus — recharge la page et réessaie.',
  'engine.webgpuUnsupported':
    "Cet appareil ou ce navigateur ne prend pas en charge WebGPU — la transcription ne peut pas fonctionner ici. Une version récente de Chrome ou Edge est nécessaire.",
  'engine.workerCrashed': 'Le worker de transcription a planté.',
  'engine.workerCrashedDetail': 'Le worker de transcription a planté : {detail}',

  // Device-label characters, not language — kept byte-identical (see en.ts).
  'format.hours': 'H',
  'format.minutes': 'MIN',

  // --- Part b of U3 (`src/App.tsx`) ---------------------------------------

  'header.brandLocal': 'local',
  'header.brandRec': 'Rec',
  // TON, NICHT INFORMATION (Muttersprachler-Kurzblick vorgemerkt) — bewusst
  // keine wörtliche Übersetzung, sondern dieselbe knappe Haltung.
  'header.subtitleTagline': 'La transcription qui ne quitte jamais ton appareil',
  // TON, NICHT INFORMATION (Muttersprachler-Kurzblick vorgemerkt).
  'header.subtitleFlightMode': 'Active le mode avion. Ça continue de tourner.',

  'device.micCaption': 'Microphone',
  'device.recBadge': 'REC',
  'device.status': 'WEBGPU · NET 0',

  'error.modelLoadHeadline': "Le modèle n'a pas pu être chargé.",
  'error.importFailedHeadline': 'Le traitement a échoué.',
  'error.importFailedDetailFallback': "L'audio n'a pas pu être traité",

  'annotation.unknownErrorFallback': 'erreur inconnue',

  'meeting.noSystemAudioHint':
    "Aucun audio système reçu — lors du partage, coche « Partager l'audio » et recommence.",
  'meeting.captureFailedHint': "L'audio système n'a pas pu être capturé.",

  // --- Part c of U3 (`src/ui/*.tsx` extraction) ---------------------------

  // TON, NICHT INFORMATION (Muttersprachler-Kurzblick vorgemerkt) — VERSAL
  // beibehalten (Typewriter zählt Zeichen, siehe DemoLoop.tsx).
  'demo.line1': 'AUCUNE DONNÉE NE QUITTE JAMAIS TON APPAREIL.',
  'demo.line2': 'CHARGE LE MODÈLE UNE FOIS — ~1.5 GB.',
  'demo.line3': 'PUIS MODE AVION. ÇA CONTINUE DE TOURNER.',
  'demo.line4': 'APPUIE SUR ENREGISTRER ET PARLE',

  'device.lineInLabel': 'LINE IN',

  'firstRun.idleMessage':
    "Télécharge ~1.5 GB une fois. Ensuite, tout fonctionne hors ligne sur ton appareil — rien n'est jamais envoyé.",
  'firstRun.startDownload': 'Charger le modèle',
  'firstRun.downloadingMessage': 'Chargement du modèle en cours. Une seule fois.',
  'firstRun.downloadProgress': '{mb} MB / ~1500 MB · {pct}%',
  'firstRun.decodingLabel': 'Décodage du fichier',
  'firstRun.transcribingLabel': 'Transcription en cours',
  'firstRun.elapsedSince': 'en cours depuis {elapsed}',
  'firstRun.longRunningNote':
    'Les enregistrements longs prennent quelques minutes — ça continue en arrière-plan.',

  'common.retry': 'Réessayer',

  'import.needsFolderMessage': "Choisis d'abord un emplacement — la transcription y sera écrite.",
  'import.message':
    "Charge un fichier audio existant — traité entièrement sur l'appareil. Rien ne quitte ton appareil.",
  'import.pickFile': 'Choisir un fichier',
  'import.selected': 'Sélectionné : « {name} » — traitement en cours …',

  'setup.chooseFolder': 'Choisir un dossier',

  'language.label': "Langue de l'enregistrement",
  // Sprachnamen — byte-identisch über alle fünf Tabellen, siehe en.ts.
  'language.de': 'Deutsch',
  'language.en': 'English',
  'language.it': 'Italiano',
  'language.fr': 'Français',
  'language.es': 'Español',

  // --- U4 part b (`src/ui/LocaleSwitch.tsx`) ------------------------------

  'localeSwitch.label': "Langue de l'interface",

  'transcript.jumpToLive': '↓ LIVE',

  'meeting.recordingLabel': 'Enregistrement en cours',
  'meeting.recordingHint':
    "Le micro et l'audio de la réunion sont enregistrés. La transcription et les locuteurs suivent après l'arrêt.",

  'meeting.needsFolderMessage': "Choisis d'abord un emplacement — puis démarre la réunion.",
  'meeting.shareInstruction': 'Appuie sur « Enregistrer », puis dans la fenêtre de partage choisis « Écran entier » et coche « Partager l\'audio ».',
  'meeting.aside': 'Casque recommandé — sinon le micro capte deux fois le haut-parleur.',

  'mic.deniedHeadline': 'Accès au microphone refusé.',
  'mic.deniedDetail': "Autorise l'accès au microphone dans le navigateur, puis réessaie.",

  'mode.ariaLabel': "Type d'entrée",
  'mode.record': 'Enregistrement local',
  'mode.import': 'Charger un fichier',
  'mode.meeting': 'Réunion en ligne',

  'record.startLabel': "Démarrer l'enregistrement",
  'record.stopLabel': "Arrêter l'enregistrement",

  'setup.micFolderMessage':
    "Choisis d'abord l'emplacement et autorise le microphone — puis démarre l'enregistrement avec le bouton rouge au centre.",
  'setup.chooseLocation': "Choisir l'emplacement",
  'setup.writeNote': "La transcription et l'audio sont écrits en continu dans ce dossier.",
  'setup.readyMessage': "Prêt. Démarre l'enregistrement avec le bouton rouge au centre.",
  'setup.readyNoteWithFolder': 'Emplacement : {folder} Microphone autorisé.',
  'setup.readyNoteDefault': 'Emplacement choisi. Microphone autorisé.',

  // ALL CAPS beibehalten (rule 4, wie im deutschen/englischen Original).
  'recovery.headline': 'ENREGISTREMENT INTERROMPU — {duration}',
  'recovery.resume': 'Reprendre',
  'recovery.discard': 'Abandonner',

  'speaker.nameForLabel': 'Nom pour {label}',

  'steps.transcriptionDone': 'Transcription terminée',
  'steps.recordingStopped': 'Enregistrement arrêté',
  // "sauvegarder", not "enregistrer", for the *saving* steps: French
  // "enregistrement" already carries the *recording* meaning here
  // (`steps.recording`, `meeting.recordingLabel`), and the two would
  // otherwise render as the same word in the same status list.
  'steps.savedIn': 'Sauvegardé dans {folder}',
  'steps.saved': 'Sauvegardé',
  'steps.saving': 'Sauvegarde …',
  'steps.speakersDetected': 'Locuteurs détectés',
  'steps.finishedSaved': 'Terminé — transcription sauvegardée',
  'steps.modelLoaded': 'Modèle chargé',
  'steps.locationSet': 'Emplacement défini',
  'steps.locationChooseFolder': 'Emplacement — choisir un dossier',
  'steps.locationChooseAtStart': 'Emplacement — choisi au démarrage',
  'steps.transcribingFile': 'Transcription du fichier …',
  'steps.pickAndTranscribe': 'Choisir un fichier et transcrire',
  'steps.meetingTranscribing': 'Transcription en cours …',
  'steps.recordMeeting': 'Enregistrer la réunion',
  'steps.recording': 'Enregistrement',

  'annotation.detecting': 'Détection des locuteurs',

  'stopped.retryDetection': 'Relancer la détection des locuteurs',
  'stopped.reDetect': 'Redétecter',
  'stopped.detectSpeakers': 'Détecter les locuteurs',
  'stopped.speakerCountAriaLabel': 'Nombre de locuteurs',
  'stopped.correctSpeakerCount': 'Corriger le nombre de locuteurs :',
  'stopped.speakerCountLabel': 'Nombre de locuteurs :',
  // Ausgeschrieben statt „Auto" — sonst wäre der Chip-Text byte-identisch
  // mit dem deutschen Original (Zufallstreffer über die Sprachwurzel), was
  // der Test unten fälschlich als vergessene Übersetzung werten würde.
  'stopped.autoChip': 'Auto',
  'stopped.detectionUnavailable':
    'Détection des locuteurs impossible : {error} — la transcription est entièrement enregistrée. Détails dans la console du navigateur.',

  'clear.withRefresh': 'Effacer et recharger',
  'clear.withRefreshHint':
    'Supprime les enregistrements mis en cache localement et recharge la page. Les fichiers du dossier choisi restent.',

  'vu.label': 'IN',

  // --- U5 (`src/ui/InfoView.tsx`) — Info-Knopf + Info-Ansicht --------------
  // U5b: echte Übersetzung aus der deutschen Fassung (`strings.de.ts`), die
  // hier — wie überall in dieser Tabelle — die Vorlage für Ton und Nuance ist.
  // Ganze Sätze für absolute Laien: der einzige Ort in der App, an dem erklärt
  // wird, also menschlich, aber nicht geschwätzig.
  //
  // Die Sprecherlabels im Prompt unten (`Locuteur 1, Locuteur 2, …`) folgen
  // damit derselben UI-Locale und sind wörtlich das, was `speaker.label` oben
  // in DIESER Tabelle liefert —
  // eine französische Sitzung schreibt „Locuteur 1" in `transkript-sprecher.txt`,
  // und der Prompt muss dem Sprachmodell genau diese Datei beschreiben.
  //
  // Die Dateinamen `transkript-sprecher.txt`/`transkript.txt` sind die echten,
  // sprachunabhängigen Namen aus `src/output/` und bleiben unübersetzt;
  // « Détecter les locuteurs » in `info.step3` zitiert wörtlich
  // `stopped.detectSpeakers` aus dieser Tabelle.
  'info.buttonLabel': 'Comment ça marche',
  'info.backLabel': 'Retour',

  'info.whatHeading': 'Ce qui se passe ici',
  'info.what1': 'localRec transcrit ce qui se dit — directement sur ton appareil.',
  'info.what2':
    "Au premier démarrage, tu télécharges un modèle vocal une seule fois ; ensuite, l'app n'a plus besoin d'internet.",
  'info.what3':
    "Enregistrement, transcription et détection des locuteurs sont calculés ici, sur cet appareil — rien n'est envoyé sur internet, il n'y a pas de comptes et aucune analyse.",
  'info.what4':
    'Ce qui compte, ce sont les fichiers dans le dossier que tu as choisi : ce sont eux, le résultat.',
  'info.what5':
    "Tout ce que le navigateur garde en plus n'est qu'une mémoire temporaire — tu peux l'effacer quand tu veux.",

  'info.stepsHeading': 'En trois étapes',
  'info.step1': "Choisis un dossier — c'est là que la transcription et l'audio sont écrits.",
  'info.step2': "Appuie sur le bouton rouge, parle, appuie de nouveau. C'était l'enregistrement.",
  'info.step3':
    '« Détecter les locuteurs » — répartit la transcription entre les différentes voix. Ça prend quelques minutes.',

  'info.summaryHeading': 'Pour finir : faire résumer',
  'info.summaryIntro':
    "Pour le résumé, le mieux est un grand modèle de langage de ton choix. Voici deux instructions prêtes à copier — joins le fichier, colle le texte, c'est fait.",
  // KTD10, nicht verhandelbar.
  'info.summaryDeviceLimit':
    "Cette dernière étape quitte ton appareil — c'est toi qui décides ce que tu copies et où.",

  'info.promptSpeakerLabel': 'Réunion avec locuteurs (transkript-sprecher.txt)',
  'info.promptSpeakerText':
    "Ci-joint la transcription d'une réunion, générée automatiquement.\n\nLes étiquettes de locuteurs (Locuteur 1, Locuteur 2, …) sont estimées acoustiquement et ne sont pas toujours justes : aux changements de locuteur, une phrase isolée peut se retrouver attribuée au mauvais locuteur. Corrige ces erreurs d'attribution évidentes sans le signaler, quand le contexte le rend clair, et ne pose pas de question.\n\nRésume : de quoi il s'agissait · ce qui a été décidé · ce qui est resté ouvert · qui se charge de quoi.\n\nTiens-toi à ce qui est dans le texte. N'invente rien, et si quelque chose reste flou, écris-le.",

  'info.promptSimpleLabel': 'Transcription simple (transkript.txt)',
  'info.promptSimpleText':
    "Ci-joint la transcription d'un enregistrement, générée automatiquement — elle peut contenir des erreurs d'écoute.\n\nRésume : de quoi il s'agissait · ce qui a été décidé · ce qui est resté ouvert · qui se charge de quoi, dans la mesure où c'est identifiable.\n\nTiens-toi à ce qui est dans le texte. N'invente rien, et si quelque chose reste flou, écris-le.",

  'info.copyLabel': 'Copier',
  'info.copiedLabel': 'Copié.',
  'info.copyFailedLabel': 'La copie a échoué.',

  'info.disclaimerHeading': 'Sans garantie',
  'info.disclaimerText':
    'localRec est un outil privé, fourni tel quel. La transcription et la détection des locuteurs sont produites par une machine et peuvent contenir des erreurs — vérifie ce qui compte pour toi. Personne ne peut répondre des dommages ni de ce qui aurait été manqué.',

  // --- Correction d'honnêteté du repli Firefox/Safari (`RecordSetupView.tsx`/
  // `MeetingView.tsx`/`ImportView.tsx`/`Steps.tsx`/`StoppedScreen.tsx`) -----
  // Bug signalé par le propriétaire : Firefox n'a pas la File System Access
  // API, donc `createFileSink()` (`fileSink.ts`) y résout toujours vers le
  // `FallbackSink` OPFS, sans jamais afficher de sélecteur de dossier. Les
  // écrans de configuration lisaient cela exactement comme un dossier
  // choisi (« Speicherort gewählt »), et les fichiers produits n'avaient
  // plus aucun moyen de sortir du navigateur. Ces clés remplacent ce texte
  // malhonnête partout où `sinkIsFallback` est vrai (App.tsx) et ajoutent
  // la possibilité de télécharger les fichiers en fin de session sur
  // `StoppedScreen`.
  'setup.readyNoteFallback':
    "Ce navigateur n'autorise pas l'accès direct à un dossier — l'enregistrement est conservé en sécurité dans le navigateur ; les fichiers seront proposés au téléchargement à la fin. Microphone autorisé.",
  'meeting.fallbackNote':
    "Ce navigateur n'autorise pas l'accès direct à un dossier — l'enregistrement est conservé en sécurité dans le navigateur ; les fichiers seront proposés au téléchargement à la fin.",
  'import.fallbackNote':
    "Ce navigateur n'autorise pas l'accès direct à un dossier — la transcription est conservée en sécurité dans le navigateur ; les fichiers seront proposés au téléchargement à la fin.",
  'steps.locationFallback': "Pas d'accès au dossier — conservé dans le navigateur",
  'steps.savedFallback': 'Enregistré dans le navigateur — téléchargement ci-dessous',
  'stopped.downloadsHeading': 'Télécharger les fichiers',
  'stopped.downloadsNote':
    "Ce navigateur n'autorise pas l'accès direct à un dossier, rien n'a donc été écrit automatiquement sur le disque — l'enregistrement est conservé en sécurité dans le navigateur. Télécharge-le ici :",

  // --- U6 (`RecordSetupView.tsx`/`MeetingView.tsx`) — note de consentement -
  // Vraie traduction de l'allemand (`strings.de.ts`), même structure en deux
  // membres séparés par le deux-points. Aucun article de loi, aucune formule
  // juridique — une seule phrase qui nomme la condition.
  'consent.note':
    "En démarrant, tu confirmes : tous les participants sont au courant de l'enregistrement et sont d'accord.",
};
