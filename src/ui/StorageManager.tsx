/**
 * Bauplatz für die geplante Modellverwaltung (R19/U11): zeigt Status/Grösse
 * jedes verwalteten Modell-Sets und eine "Modell löschen"-Aktion, delegiert
 * an `modelCache.ts` (KTD1-Disziplin — diese Komponente hat kein eigenes
 * OPFS-/Fetch-Wissen). Bewusst noch nicht in `App.tsx` verdrahtet — reine
 * Komponente ohne Aufrufer, bis die Modellverwaltung als Feature drankommt.
 * Funktional-neutral (semantische Klassennamen, kein Styling — U12's Job).
 *
 * **Listable, not list-built.** `entries` is an array so a later, second
 * model set (U18's diarization models, KTD15 — "getrennt verwaltet") can be
 * appended by whoever wires this component up, without changing anything
 * in this file. Only one entry (transcription) is actually passed today —
 * this
 * unit deliberately does not add a second entry/set (YAGNI); the array
 * shape is just what keeps that future addition a call-site change, not a
 * rewrite here.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  deleteModelSet,
  getModelSetSizeBytes,
  isModelSetComplete,
  type ModelOpfsStore,
  type ModelSetSpec,
} from '../storage/modelCache';

export interface ModelSetEntry {
  /** Stable React key and `data-model-id` — should match `spec.id`. */
  id: string;
  /** Human-readable name for this entry, e.g. "Whisper (Transkription)". */
  label: string;
  spec: ModelSetSpec;
  store: ModelOpfsStore;
}

export interface StorageManagerProps {
  entries: ModelSetEntry[];
  className?: string;
}

export function StorageManager({ entries, className }: StorageManagerProps) {
  const rootClassName = ['storage-manager', className].filter(Boolean).join(' ');
  return (
    <ul className={rootClassName}>
      {entries.map((entry) => (
        <ModelSetRow key={entry.id} entry={entry} />
      ))}
    </ul>
  );
}

type RowStatus = 'checking' | 'missing' | 'ready';

function ModelSetRow({ entry }: { entry: ModelSetEntry }) {
  const [status, setStatus] = useState<RowStatus>('checking');
  const [sizeBytes, setSizeBytes] = useState(0);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    setStatus('checking');
    const [complete, size] = await Promise.all([
      isModelSetComplete(entry.store, entry.spec),
      getModelSetSizeBytes(entry.store, entry.spec),
    ]);
    setStatus(complete ? 'ready' : 'missing');
    setSizeBytes(size);
  }, [entry.store, entry.spec]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await deleteModelSet(entry.store, entry.spec);
      await refresh();
    } finally {
      setDeleting(false);
    }
  }, [entry.store, entry.spec, refresh]);

  return (
    <li className="storage-manager__row" data-model-id={entry.id} data-status={status}>
      <span className="storage-manager__label">{entry.label}</span>
      <span className="storage-manager__status">{status}</span>
      <span className="storage-manager__size">{formatBytes(sizeBytes)}</span>
      <button
        type="button"
        className="storage-manager__delete"
        disabled={status !== 'ready' || deleting}
        onClick={() => void handleDelete()}
      >
        Modell löschen
      </button>
    </li>
  );
}

/** Plain, unstyled human-readable byte count — no design decisions here (U12's job), just enough for the status text to be meaningful. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
