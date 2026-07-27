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
 * **U20b — the two-gesture constraint (Opus architecture decision A).**
 * `showOpenFilePicker` (this screen's file dialog) and `showDirectoryPicker`
 * (the output-folder dialog, `App.tsx`'s `createFileSink`) each need their
 * OWN user gesture — a single click cannot open both. So this screen always
 * costs two clicks, and the output folder must be settled before
 * `App.tsx`'s `coordinator.start()` runs, or the import would write nowhere
 * durable. No "model ready" check is needed on top: `ImportView` is only
 * ever mounted once `deviceState === 'ready'` (see `App.tsx`'s U19
 * comment), the same threshold `RecordButton` uses.
 *
 * **Reversal (owner decision 2026-07-27): file first, folder second.** The
 * two clicks used to be folder-then-file, because the import started the
 * instant a file was picked and the target had to exist by then. The owner's
 * objection was about sense, not mechanics: you choose WHAT to process
 * before you choose WHERE the result goes. Nothing in the two-gesture
 * constraint prefers one order — it forbids one *click* opening two dialogs,
 * not this sequence. So the file picker is now the screen's first and only
 * affordance; once a file is picked and no folder is set yet, the screen
 * turns into "Speicherort wählen" (the second gesture, `onChooseFolder`),
 * and `App.tsx` starts the parked import as soon as that folder resolves.
 * When a folder is ALREADY set (second import of the same session), the
 * file click alone starts the run — one step shorter than before.
 */
import { useCallback, useState } from 'react';
import { pickAudioFile, type AudioFileSourceDeps, type PickedAudioFile } from '../input/audioFileSource';
import { t } from '../i18n';

export interface ImportViewProps {
  /** Called once a file is actually picked (never on cancel) — hands the Blob to the U20 seam. */
  onFileSelected: (file: PickedAudioFile) => void;
  /** Injected picker, defaults to the real `pickAudioFile`. Overridden in tests. */
  pickFile?: (deps?: AudioFileSourceDeps) => Promise<PickedAudioFile | null>;
  /** Whether an output folder is already set. `false` + a picked file → this screen becomes the "Speicherort wählen" step (see the file header's reversal note). */
  hasOutputTarget: boolean;
  /** Opens the folder picker (`App.tsx`'s `createFileSink()`, within this click's gesture); `App.tsx` starts the parked import once it resolves. */
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

  // Step 2 of 2 (owner decision 2026-07-27, see the file header's reversal
  // note): the file is picked, the folder isn't — the only affordance left
  // is "Speicherort wählen", and choosing it starts the import.
  if (selected && !hasOutputTarget) {
    return (
      <div className="import-view" data-status="needs-folder">
        {/* `import.selectedPending`, not `import.selected`: nothing is being
            processed yet — that only starts when the folder resolves. */}
        <p className="import-view__message">{t('import.selectedPending', { name: selected.name })}</p>
        <p className="import-view__selected">{t('import.needsFolderMessage')}</p>
        <button type="button" className="import-view__action" onClick={onChooseFolder}>
          {t('setup.chooseLocation')}
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
