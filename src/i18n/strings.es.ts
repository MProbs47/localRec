import type { StringKey } from './index';

/**
 * Spanish table (U4). `Record<StringKey, string>` — a missing or overtyped
 * key here is a TypeScript error against `en.ts`'s type, which is the
 * completeness proof (KTD2); no separate sync test needed.
 *
 * Register: sachlich, knapp, geräteartig, tú-Form (nie „usted") — wie das
 * deutsche Original in `strings.de.ts`, das für Ton-Fragen die Vorlage
 * bleibt, auch wenn `en.ts` die Typquelle ist.
 *
 * Terminologie (einmal festgelegt, durchgehalten):
 *  - Transkript/Transkription → transcripción
 *  - Sprecher → hablante
 *  - Ordner → carpeta
 *  - Speicherort → ubicación
 *  - Modell → modelo
 *  - Aufnahme (Vorgang) → grabación
 */
export const es: Record<StringKey, string> = {
  'speaker.label': 'Hablante {n}',

  'engine.modelStalled':
    'La carga del modelo ha dejado de responder — recarga la página y vuelve a intentarlo.',
  'engine.webgpuUnsupported':
    'Este dispositivo o navegador no admite WebGPU — la transcripción no puede ejecutarse aquí. Se necesita una versión actual de Chrome o Edge.',
  'engine.workerCrashed': 'El worker de transcripción ha fallado.',
  'engine.workerCrashedDetail': 'El worker de transcripción ha fallado: {detail}',

  // Device-label characters, not language — kept byte-identical (see en.ts).
  'format.hours': 'H',
  'format.minutes': 'MIN',

  // --- Part b of U3 (`src/App.tsx`) ---------------------------------------

  'header.brandLocal': 'local',
  'header.brandRec': 'Rec',
  // TON, NICHT INFORMATION (Muttersprachler-Kurzblick vorgemerkt) — bewusst
  // keine wörtliche Übersetzung, sondern dieselbe knappe Haltung.
  'header.subtitleTagline': 'Transcripción que nunca sale de tu dispositivo',
  // TON, NICHT INFORMATION (Muttersprachler-Kurzblick vorgemerkt).
  'header.subtitleFlightMode': 'Activa el modo avión. Sigue funcionando.',

  'device.micCaption': 'Micrófono',
  'device.recBadge': 'REC',
  'device.status': 'WEBGPU · NET 0',

  'error.modelLoadHeadline': 'No se pudo cargar el modelo.',
  'error.importFailedHeadline': 'Error en el procesamiento.',
  'error.importFailedDetailFallback': 'No se pudo procesar el audio',

  'annotation.unknownErrorFallback': 'error desconocido',

  'meeting.noSystemAudioHint':
    'No se recibió audio del sistema — al compartir, marca la casilla «Compartir audio» y empieza de nuevo.',
  'meeting.captureFailedHint': 'No se pudo capturar el audio del sistema.',

  // --- Part c of U3 (`src/ui/*.tsx` extraction) ---------------------------

  // TON, NICHT INFORMATION (Muttersprachler-Kurzblick vorgemerkt) — VERSAL
  // beibehalten (Typewriter zählt Zeichen, siehe DemoLoop.tsx).
  'demo.line1': 'NINGÚN DATO SALE JAMÁS DE TU DISPOSITIVO.',
  'demo.line2': 'CARGA EL MODELO UNA VEZ — ~1.5 GB.',
  'demo.line3': 'LUEGO MODO AVIÓN. SIGUE FUNCIONANDO.',
  'demo.line4': 'PULSA GRABAR Y HABLA',

  'device.lineInLabel': 'LINE IN',

  'firstRun.idleMessage':
    'Descarga ~1.5 GB una vez. A partir de ahí todo funciona sin conexión en tu dispositivo — nunca se envía nada.',
  'firstRun.startDownload': 'Cargar modelo',
  'firstRun.downloadingMessage': 'Cargando el modelo. Solo una vez.',
  'firstRun.downloadProgress': '{mb} MB / ~1500 MB · {pct}%',
  'firstRun.decodingLabel': 'Decodificando archivo',
  'firstRun.transcribingLabel': 'Transcripción en curso',
  'firstRun.elapsedSince': 'en curso desde {elapsed}',
  'firstRun.longRunningNote':
    'Las grabaciones largas tardan unos minutos — sigue funcionando en segundo plano.',

  'common.retry': 'Reintentar',

  'import.needsFolderMessage':
    'Elige primero una ubicación — ahí se escribirá la transcripción.',
  'import.message':
    'Carga un archivo de audio existente — se procesa totalmente en el dispositivo. Nada sale de tu dispositivo.',
  'import.pickFile': 'Elegir archivo',
  'import.selected': 'Seleccionado: «{name}» — procesando …',

  'setup.chooseFolder': 'Elegir carpeta',

  'language.label': 'Idioma de la grabación',
  'language.auto': 'Automático',
  // Sprachnamen — byte-identisch über alle fünf Tabellen, siehe en.ts.
  'language.de': 'Deutsch',
  'language.en': 'English',
  'language.it': 'Italiano',
  'language.fr': 'Français',
  'language.es': 'Español',

  // --- U4 part b (`src/ui/LocaleSwitch.tsx`) ------------------------------

  'localeSwitch.label': 'Idioma de la interfaz',

  'transcript.jumpToLive': '↓ LIVE',

  'meeting.recordingLabel': 'Grabación en curso',
  'meeting.recordingHint':
    'Se están grabando el micrófono y el audio de la reunión. La transcripción y los hablantes llegan después de detener.',

  'meeting.needsFolderMessage': 'Elige primero una ubicación — luego inicia la reunión.',
  'meeting.shareInstruction': 'Pulsa «Grabar», luego en el diálogo de compartir elige «Toda la pantalla» y marca «Compartir audio».',
  'meeting.aside': 'Auriculares recomendados — si no, el micrófono capta el altavoz dos veces.',

  'mic.deniedHeadline': 'Acceso al micrófono denegado.',
  'mic.deniedDetail': 'Permite el acceso al micrófono en el navegador y vuelve a intentarlo.',

  'mode.ariaLabel': 'Tipo de entrada',
  'mode.record': 'Grabación local',
  'mode.import': 'Cargar archivo',
  'mode.meeting': 'Reunión en línea',

  'record.startLabel': 'Iniciar grabación',
  'record.stopLabel': 'Detener grabación',

  'setup.micFolderMessage':
    'Elige primero la ubicación y permite el micrófono — luego inicia la grabación con el botón rojo del centro.',
  'setup.chooseLocation': 'Elegir ubicación',
  'setup.writeNote': 'La transcripción y el audio se escriben continuamente en esta carpeta.',
  'setup.readyMessage': 'Listo. Inicia la grabación con el botón rojo del centro.',
  'setup.readyNoteWithFolder': 'Ubicación: {folder} Micrófono permitido.',
  'setup.readyNoteDefault': 'Ubicación elegida. Micrófono permitido.',

  // ALL CAPS beibehalten (rule 4, wie im deutschen/englischen Original).
  'recovery.headline': 'GRABACIÓN INTERRUMPIDA — {duration}',
  'recovery.resume': 'Reanudar',
  'recovery.discard': 'Descartar',

  'speaker.nameForLabel': 'Nombre para {label}',

  'steps.transcriptionDone': 'Transcripción terminada',
  'steps.recordingStopped': 'Grabación detenida',
  'steps.savedIn': 'Guardado en {folder}',
  'steps.saved': 'Guardado',
  'steps.saving': 'Guardando …',
  'steps.speakersDetected': 'Hablantes detectados',
  'steps.finishedSaved': 'Listo — transcripción guardada',
  'steps.modelLoaded': 'Modelo cargado',
  'steps.locationSet': 'Ubicación definida',
  'steps.locationChooseFolder': 'Ubicación — elegir carpeta',
  'steps.locationChooseAtStart': 'Ubicación — elegida al iniciar',
  'steps.transcribingFile': 'Transcribiendo archivo …',
  'steps.pickAndTranscribe': 'Elegir archivo y transcribir',
  'steps.meetingTranscribing': 'Transcripción en curso …',
  'steps.recordMeeting': 'Grabar reunión',
  'steps.recording': 'Grabación',

  'annotation.detecting': 'Detectando hablantes',

  'stopped.retryDetection': 'Reintentar detección de hablantes',
  'stopped.reDetect': 'Detectar de nuevo',
  'stopped.detectSpeakers': 'Detectar hablantes',
  'stopped.speakerCountAriaLabel': 'Número de hablantes',
  'stopped.correctSpeakerCount': 'Corregir número de hablantes:',
  'stopped.speakerCountLabel': 'Número de hablantes:',
  // Ausgeschrieben statt „Auto" — sonst wäre der Chip-Text byte-identisch
  // mit dem deutschen Original (Zufallstreffer über die Sprachwurzel), was
  // der Test unten fälschlich als vergessene Übersetzung werten würde.
  'stopped.autoChip': 'Auto',
  'stopped.detectionUnavailable':
    'Detección de hablantes no disponible: {error} — la transcripción está guardada por completo. Detalles en la consola del navegador.',

  'clear.withRefresh': 'Borrar y recargar',
  'clear.withRefreshHint':
    'Elimina las grabaciones guardadas localmente y recarga la página. Los archivos de la carpeta elegida permanecen.',

  'vu.label': 'IN',

  // --- U5 (`src/ui/InfoView.tsx`) — Info-Knopf + Info-Ansicht --------------
  // U5b: echte Übersetzung aus der deutschen Fassung (`strings.de.ts`), die
  // hier — wie überall in dieser Tabelle — die Vorlage für Ton und Nuance ist.
  // Ganze Sätze für absolute Laien: der einzige Ort in der App, an dem erklärt
  // wird, also menschlich, aber nicht geschwätzig.
  //
  // KTD12: die Sprecherlabels im Prompt unten (`Hablante 1, Hablante 2, …`)
  // sind wörtlich das, was `speaker.label` oben in DIESER Tabelle liefert —
  // eine spanische Sitzung schreibt „Hablante 1" in `transkript-sprecher.txt`,
  // und der Prompt muss dem Sprachmodell genau diese Datei beschreiben.
  //
  // Die Dateinamen `transkript-sprecher.txt`/`transkript.txt` sind die echten,
  // sprachunabhängigen Namen aus `src/output/` und bleiben unübersetzt;
  // «Detectar hablantes» in `info.step3` zitiert wörtlich
  // `stopped.detectSpeakers` aus dieser Tabelle.
  'info.buttonLabel': 'Cómo funciona',
  'info.backLabel': 'Atrás',

  'info.whatHeading': 'Qué pasa aquí',
  'info.what1': 'localRec transcribe lo que se dice — directamente en tu dispositivo.',
  'info.what2':
    'Al primer inicio descargas una sola vez un modelo de voz; a partir de ahí la app ya no necesita internet.',
  'info.what3':
    'La grabación, la transcripción y la detección de hablantes se calculan todas aquí, en este dispositivo — no se sube nada, no hay cuentas ni análisis de datos.',
  'info.what4':
    'Lo que cuenta son los archivos de la carpeta que has elegido: ellos son el resultado.',
  'info.what5':
    'Lo que el navegador guarde además de eso es solo una memoria temporal — puedes borrarla cuando quieras.',

  'info.stepsHeading': 'En tres pasos',
  'info.step1': 'Elige una carpeta — ahí se escriben la transcripción y el audio.',
  'info.step2': 'Pulsa el botón rojo, habla, púlsalo otra vez. Esa fue la grabación.',
  'info.step3':
    '«Detectar hablantes» — reparte la transcripción entre las distintas voces. Eso tarda unos minutos.',

  'info.summaryHeading': 'Al final: pedir un resumen',
  'info.summaryIntro':
    'Para el resumen lo mejor es un modelo de lenguaje grande de tu elección. Aquí tienes dos instrucciones listas para copiar — adjunta el archivo, pega el texto, listo.',
  // KTD10, nicht verhandelbar.
  'info.summaryDeviceLimit':
    'Este último paso sale de tu dispositivo — tú decides qué copias y adónde.',

  'info.promptSpeakerLabel': 'Reunión con hablantes (transkript-sprecher.txt)',
  'info.promptSpeakerText':
    'Adjunto va la transcripción de una reunión, creada automáticamente.\n\nLas etiquetas de hablante (Hablante 1, Hablante 2, …) están estimadas acústicamente y no siempre son correctas: en los cambios de hablante, una sola frase puede quedar asignada al hablante equivocado. Corrige esos errores de atribución evidentes sin comentarlo, cuando el contexto lo deje claro, y no preguntes.\n\nResume: de qué se trataba · qué se decidió · qué quedó abierto · quién se encarga de qué.\n\nCíñete a lo que dice el texto. No inventes nada y, si algo queda poco claro, escríbelo.',

  'info.promptSimpleLabel': 'Transcripción simple (transkript.txt)',
  'info.promptSimpleText':
    'Adjunto va la transcripción de una grabación, creada automáticamente — puede contener errores de audición.\n\nResume: de qué se trataba · qué se decidió · qué quedó abierto · quién se encarga de qué, en la medida en que se reconozca.\n\nCíñete a lo que dice el texto. No inventes nada y, si algo queda poco claro, escríbelo.',

  'info.copyLabel': 'Copiar',
  'info.copiedLabel': 'Copiado.',
  'info.copyFailedLabel': 'La copia ha fallado.',

  'info.disclaimerHeading': 'Sin garantía',
  'info.disclaimerText':
    'localRec es una herramienta privada y se ofrece tal como está. La transcripción y la detección de hablantes se generan de forma automática y pueden contener errores — comprueba lo que te importe. Nadie puede responder por daños ni por lo que se haya pasado por alto.',

  // --- U6 (`RecordSetupView.tsx`/`MeetingView.tsx`) — aviso de consentimiento
  // Traducción real del alemán (`strings.de.ts`), misma estructura en dos
  // miembros separados por dos puntos. Ningún artículo de ley, ninguna
  // fórmula jurídica — una sola frase que nombra la condición.
  'consent.note':
    'Al iniciar, confirmas: todos los participantes conocen la grabación y están de acuerdo.',
};
