/**
 * U19 (IM-2, KTD16): the import screen shown inside the device's `.screen`
 * display when the landing-page `ModeToggle` is set to "Datei laden" (see
 * `App.tsx`'s `renderScreen()`, which swaps this in for the `ready`-state
 * demo loop). One button — "Datei wählen" — invokes `audioFileSource.ts`'s
 * `pickAudioFile()`; once a file is picked, its name is shown and its
 * `Blob` is handed to `onFileSelected`, the U20 handoff seam (see
 * `App.tsx`'s `handleFileSelected`).
 *
 * **U19 scope note (superseded by U20b, kept for history).** U19 itself
 * ended at "the user has a Blob" — the actual on-device processing (decode →
 * batch-transcribe, U20) didn't exist yet, so a picked file showed an honest
 * "processing is a future unit" placeholder instead of a fake progress bar.
 * U20b wired the real pipeline (`App.tsx`'s `handleFileSelected` now calls
 * `session/importPipeline.ts`'s `runImport`), so a pick now genuinely starts
 * processing — this screen unmounts almost immediately as `deviceState`
 * moves to `'importing'` (see `App.tsx`'s `renderScreen()`), the same
 * "never show a checkmark before the thing happened" discipline U12's
 * `Steps` component uses.
 *
 * **Injectable picker (`pickFile` prop), same DI shape as `modelCache.ts`'s
 * `fetchImpl`/`storageGate`.** Defaults to the real `pickAudioFile` so
 * production callers pass nothing; tests inject a fake to drive the
 * picked/cancelled/failed paths without a real file dialog.
 *
 * **Local `selected`/`picking` state, not lifted to `App.tsx`.** This is
 * transient UI feedback for *this* screen (which file did the user just
 * pick, is the dialog currently open) — not business state the rest of the
 * app needs to react to. `App.tsx` only needs the `Blob` itself (via
 * `onFileSelected`), which it parks in a ref for U20; it doesn't need to
 * know or re-render on "picking" transitions. Keeping this state here
 * avoids threading a prop back down for no consumer (YAGNI).
 *
 * **U20b addendum — the folder-first gate (Opus architecture decision A).**
 * `showOpenFilePicker` (this screen's file dialog) and `showDirectoryPicker`
 * (the output-folder dialog, `App.tsx`'s `createFileSink`) each need their
 * OWN user gesture — a single click cannot open both. So the output folder
 * must already be chosen before "Datei wählen" ever runs; otherwise
 * `App.tsx`'s later `coordinator.start()` (which reuses whatever folder is
 * already restored, see `App.tsx`'s header) would have nothing to reuse and
 * the import would silently write nowhere durable. `hasOutputTarget` gates
 * exactly that: while `false`, this screen shows only "Ordner wählen" (its
 * own gesture, wired to `onChooseFolder` — `App.tsx` opens `createFileSink()`
 * inside that click and flips `hasOutputTarget` once it resolves); the file
 * picker only appears once a folder is set. This is the *entire* gate — no
 * separate "model ready" check is needed here, because `ImportView` itself
 * is only ever mounted once `deviceState === 'ready'` (see `App.tsx`'s U19
 * comment), the same threshold `RecordButton` uses.
 */
import { useCallback, useState } from 'react';
import { pickAudioFile, type AudioFileSourceDeps, type PickedAudioFile } from '../input/audioFileSource';
import { t } from '../i18n';

export interface ImportViewProps {
  /** Called once a file is actually picked (never on cancel) — hands the Blob to the U20 seam. */
  onFileSelected: (file: PickedAudioFile) => void;
  /** Injected picker, defaults to the real `pickAudioFile`. Overridden in tests. */
  pickFile?: (deps?: AudioFileSourceDeps) => Promise<PickedAudioFile | null>;
  /** Whether an output folder is already set (see file header's gate rationale). While `false`, only "Ordner wählen" is offered — the file picker is withheld. */
  hasOutputTarget: boolean;
  /** Opens the folder picker (`App.tsx`'s `createFileSink()`, within this click's gesture) and reports the result back into `hasOutputTarget`. */
  onChooseFolder: () => void;
  /** The shared transcription-language dropdown (`LanguageSelect`, owned by App) — rendered once the folder is set. */
  languageControl?: React.ReactNode;
  /** Firefox/Safari fallback-honesty fix — see `RecordSetupView.tsx`'s prop doc, same meaning here. */
  sinkIsFallback?: boolean;
}

export function ImportView({
  onFileSelected,
  pickFile = pickAudioFile,
  hasOutputTarget,
  onChooseFolder,
  languageControl,
  sinkIsFallback = false,
}: ImportViewProps) {
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<PickedAudioFile | null>(null);

  const handlePick = useCallback(async () => {
    setPicking(true);
    try {
      const file = await pickFile();
      if (file) {
        setSelected(file);
        onFileSelected(file);
      }
      // `file === null` is the documented cancel/failure Grenzfall
      // (`audioFileSource.ts`'s header) — resting state, nothing to do.
    } catch {
      // `pickFile`'s real contract (`audioFileSource.ts`) never rejects —
      // this guards against a misbehaving injected fake (or a future
      // variant) so a picker failure still lands back at a clean resting
      // state instead of an unhandled rejection.
    } finally {
      setPicking(false);
    }
  }, [pickFile, onFileSelected]);

  // The folder-first gate (see file header, decision A): withhold the file
  // picker entirely until an output target exists — "Ordner wählen" is the
  // only affordance on this screen until then.
  if (!hasOutputTarget) {
    return (
      <div className="import-view" data-status="needs-folder">
        <p className="import-view__message">{t('import.needsFolderMessage')}</p>
        <button type="button" className="import-view__action" onClick={onChooseFolder}>
          {t('setup.chooseFolder')}
        </button>
      </div>
    );
  }

  return (
    <div className="import-view" data-status={picking ? 'picking' : 'idle'}>
      <p className="import-view__message">{t('import.message')}</p>
      {/* Firefox/Safari fallback-honesty fix: shown instead of trusting a
          silently-resolved OPFS fallback to read like a real chosen folder. */}
      {sinkIsFallback && <p className="import-view__selected">{t('import.fallbackNote')}</p>}
      <button type="button" className="import-view__action" onClick={() => void handlePick()} disabled={picking}>
        {t('import.pickFile')}
      </button>
      {languageControl}
      {selected && (
        <p className="import-view__selected">{t('import.selected', { name: selected.name })}</p>
      )}
    </div>
  );
}
