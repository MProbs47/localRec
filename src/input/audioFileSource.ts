/**
 * U19 (IM-2, KTD16's "Eingang #2"): the file-import entry point. Turns a
 * user's own file-picker gesture into a `Blob` + display name — nothing
 * else. It does not decode, does not touch the network, does not know about
 * `audioDecode.ts` or the worker; it exists purely so `ImportView`/`App.tsx`
 * have something to call that returns "the audio the user picked, or
 * nothing" and can hand the result to U20's post-hoc pipeline seam
 * (`decodeAudioBlobTo16kMonoPcm`, KTD16 — "ab der Dekodierung ist der Pfad
 * identisch"). Staying this narrow is deliberate: the moment this file
 * started reading bytes or resampling anything, it would duplicate
 * `audioDecode.ts`'s job and break KTD16's one-shared-pipeline promise.
 *
 * **Two ways to get a file, feature-detected — same discipline as
 * `fileSink.ts` (KTD7-style: no user-facing switch, the browser decides).**
 * `showOpenFilePicker` (Chromium's File System Access API, same family as
 * `fileSink.ts`'s `showDirectoryPicker`) is preferred where present — it
 * returns a real `File` without ever needing the file to be attached to the
 * DOM. Everywhere else (Firefox/Safari, or a future non-Chromium target),
 * a programmatic `<input type="file" accept="audio/*">` is the universal
 * fallback every browser supports. Both paths resolve to the same
 * `PickedAudioFile | null` shape, so `ImportView` never needs to know which
 * one ran.
 *
 * **Reached through an injected structural env, defaulting to `globalThis`
 * — mirrors `fileSink.ts`'s `FileSystemAccessEnvLike`/`getGlobalEnv()`
 * exactly**, for the same reason: `showOpenFilePicker` doesn't exist in
 * Node/Vitest, so the router logic below (which path runs, how a cancel is
 * turned into `null`) needs a seam a fake can stand in for. The fallback's
 * `<input>` element is injected the same way (`deps.createFileInput`) so
 * *its* event wiring (`change`/`cancel` → resolve) is unit-testable too — a
 * fake input object satisfies `FileInputLike` in Vitest without any real
 * DOM. The real `document.createElement('input')` wiring
 * (`createDefaultFileInput`) is, like `fileSink.ts`'s real OPFS/IndexedDB
 * Andockpunkte, the documented manual-milestone surface: no headless runner
 * can open a real OS file dialog.
 *
 * **Cancel is not an error (the plan's Grenzfall).** `showOpenFilePicker`
 * rejects with an `AbortError` `DOMException` when the user dismisses the
 * dialog; the `<input>` fallback fires a `cancel` event (or, on browsers too
 * old to support it, simply no `change` event ever arrives — that path is a
 * documented limitation of the universal fallback, not testable without a
 * real dialog). Either way `pickAudioFile` resolves to `null`, never
 * throws, so a caller's "nothing picked → stay on the resting screen" is a
 * single falsy check, no try/catch needed. Any *other* picker failure is
 * also swallowed to `null` rather than propagated: U19 has no import error
 * UI yet (that's explicitly out of scope — see this unit's report), so
 * surfacing a raw exception here would either crash the screen or need a
 * try/catch duplicated in every caller for no payoff yet. A future unit
 * that adds import error handling can widen this seam's return type instead
 * of every caller re-deriving cancel-vs-failure from a caught exception.
 */

/** What U19 hands to the U20 seam: the picked file's bytes and its name (for the "ausgewählt: «name»" placeholder — see `ImportView.tsx`). Never processed here. */
export interface PickedAudioFile {
  readonly blob: Blob;
  readonly name: string;
}

// --- File System Access surface (structural, injectable — mirrors fileSink.ts) ---

/**
 * The exact structural slice of a real `File` this module needs —
 * deliberately not the ambient DOM `File` type, same discipline as
 * `audioDecode.ts`'s `DecodedAudioLike` for a real `AudioBuffer`. A real
 * `File` (from either picker path) satisfies this structurally: it already
 * *is* a `Blob` (ambient type, used the same way throughout this codebase —
 * e.g. `fileSink.ts`/`audioDecode.ts` — so it isn't re-shimmed here) plus a
 * `name`.
 */
export interface PickedFileLike extends Blob {
  readonly name: string;
}

export interface FileSystemFileHandleLike {
  getFile(): Promise<PickedFileLike>;
}

export interface OpenFilePickerOptionsLike {
  types?: { description?: string; accept: Record<string, string[]> }[];
  multiple?: boolean;
}

/** The real global surface this file needs from `showOpenFilePicker` — reached through an injectable env, defaulting to `globalThis`, same pattern as `fileSink.ts`'s `FileSystemAccessEnvLike`. */
export interface AudioFileSourceEnvLike {
  showOpenFilePicker?: (options?: OpenFilePickerOptionsLike) => Promise<FileSystemFileHandleLike[]>;
}

function getGlobalEnv(): AudioFileSourceEnvLike {
  return globalThis as unknown as AudioFileSourceEnvLike;
}

/** Pure feature detection — exported so callers can ask without duplicating the check, same as `fileSink.ts`'s `hasFileSystemAccess`. */
export function hasShowOpenFilePicker(env: AudioFileSourceEnvLike = getGlobalEnv()): boolean {
  return typeof env.showOpenFilePicker === 'function';
}

/** Extensions offered to `showOpenFilePicker`'s `audio/*` accept filter — a representative, not exhaustive, list; the browser's own audio-file heuristics (MIME sniffing) do the real gating. */
const AUDIO_FILE_EXTENSIONS = ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.webm', '.flac'];

async function pickViaFileSystemAccess(
  env: AudioFileSourceEnvLike,
): Promise<PickedAudioFile | null> {
  try {
    const handles = await env.showOpenFilePicker!({
      types: [{ description: 'Audiodatei', accept: { 'audio/*': AUDIO_FILE_EXTENSIONS } }],
      multiple: false,
    });
    const handle = handles[0];
    if (!handle) return null; // defensive — a real picker never resolves an empty array on success
    const file = await handle.getFile();
    return { blob: file, name: file.name };
  } catch {
    // AbortError (cancel) and any other picker failure both resolve to
    // `null` here — see file header for why no error is ever propagated.
    return null;
  }
}

// --- <input type=file> fallback surface (structural, injectable) ----------

/**
 * The narrow slice of `HTMLInputElement` the fallback needs. A real
 * `<input type="file">` satisfies this structurally; tests inject a plain
 * fake so the `change`/`cancel` → resolve wiring below runs for real without
 * jsdom or a real dialog.
 */
export interface FileInputLike {
  accept: string;
  click(): void;
  addEventListener(type: 'change' | 'cancel', listener: () => void): void;
  removeEventListener(type: 'change' | 'cancel', listener: () => void): void;
  readonly files: ArrayLike<PickedFileLike> | null;
  /** Detaches the element again once the pick has resolved — optional because a fake test double has nothing to detach. */
  remove?(): void;
}

/**
 * Real `<input type="file">` Andockpunkt (manual milestone, not unit-tested
 * — same Realitätsgrenze as `fileSink.ts`'s real OPFS/IndexedDB adapters).
 * Appended off-screen (not `display: none` — some browsers won't dispatch a
 * click on a display:none element) so `.click()` reliably opens the native
 * dialog; removed again once `pickViaInputFallback` settles.
 */
function createDefaultFileInput(): FileInputLike {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.style.position = 'fixed';
  input.style.top = '-1000px';
  input.style.left = '-1000px';
  input.style.opacity = '0';
  input.style.pointerEvents = 'none';
  document.body.appendChild(input);
  return input as unknown as FileInputLike;
}

function pickViaInputFallback(createFileInput: () => FileInputLike): Promise<PickedAudioFile | null> {
  return new Promise((resolve) => {
    const input = createFileInput();
    let settled = false;

    const settle = (result: PickedAudioFile | null) => {
      if (settled) return;
      settled = true;
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      input.remove?.();
      resolve(result);
    };

    function onChange() {
      const file = input.files?.[0] ?? null;
      settle(file ? { blob: file, name: file.name } : null);
    }
    function onCancel() {
      settle(null);
    }

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    input.click();
  });
}

// --- Router (feature-detection decides, same shape as fileSink.ts) --------

export interface AudioFileSourceDeps {
  /** Feature-detection & picker surface — defaults to `globalThis`. */
  env?: AudioFileSourceEnvLike;
  /** Creates the `<input type=file>` fallback element — defaults to a real, off-screen `document.createElement('input')`. Injected for tests. */
  createFileInput?: () => FileInputLike;
}

/**
 * IM-2's "Datei wählen": picks one audio file and resolves to its `Blob` +
 * name, or `null` if the user cancels (the plan's documented Grenzfall — see
 * file header). Never throws. Feature-detects `showOpenFilePicker` first
 * (KTD7-style — no user-facing switch); falls back to a programmatic
 * `<input type="file">` everywhere else.
 */
export async function pickAudioFile(deps: AudioFileSourceDeps = {}): Promise<PickedAudioFile | null> {
  const env = deps.env ?? getGlobalEnv();
  if (hasShowOpenFilePicker(env)) {
    return pickViaFileSystemAccess(env);
  }
  const createFileInput = deps.createFileInput ?? createDefaultFileInput;
  return pickViaInputFallback(createFileInput);
}
