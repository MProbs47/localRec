/**
 * U11 (F1/R20): the guided first-run screen — OPFS presence check →
 * (missing) resumable download with visible progress → warm-up → ready.
 * Pure consumer of `modelCache.ts` (KTD1-style discipline: this component
 * owns state/behavior/semantic markup only, never OPFS/fetch/storage
 * details itself — those live in `modelCache.ts` and are injected here).
 *
 * **Functionally-neutral (per this unit's brief).** The project owner
 * supplies the real visual design in a later, dedicated styling unit (U12,
 * the device spec §8's `idle`/`downloading`/`ready`
 * states are the orientation, not a spec to pixel-match here). This
 * component only emits semantic class names (`first-run`,
 * `first-run--downloading`, ...) and the raw progress number/percent as
 * text — no colors, fonts, or layout beyond what's needed to make the
 * state machine legible in a plain DOM dump.
 *
 * **State derivation, not reimplementation.** All of the actual
 * gate-check/download/warm-up logic is exactly one call to
 * `ensureModelSetReady()` (`modelCache.ts`) — this component does not
 * duplicate that orchestration. The one extra call is `isModelSetComplete()`
 * up front, purely so the UI can distinguish "already cached, about to
 * warm up" from "needs a fresh download" before `ensureModelSetReady`'s
 * single promise resolves (that promise doesn't surface a "warm-up
 * started" event on its own — see `modelCache.ts`'s warm-up doc comment).
 * The `warming-up` transition for a *fresh* download is derived from the
 * progress callback reaching `fraction >= 1` (download just finished,
 * `ensureModelSetReady` is about to call `engine.warmup()` next).
 */
import { useEffect, useReducer } from 'react';
import {
  InsufficientStorageError,
  ensureModelSetReady,
  isModelSetComplete,
  type FetchLike,
  type ModelOpfsStore,
  type ModelSetSpec,
  type StorageGate,
} from '../storage/modelCache';

export interface FirstRunProps {
  spec: ModelSetSpec;
  store: ModelOpfsStore;
  fetchImpl: FetchLike;
  storageGate: StorageGate;
  /** Minimum free bytes required before starting a fresh download (see `modelCache.ts` — the real figure is U13's wiring concern, not this component's). */
  requiredBytes: number;
  engine: { warmup(): Promise<void> };
  /** Called exactly once, when the model becomes usable this session (freshly downloaded or already cached) — lets the parent app (U12) move on, e.g. to the flight-mode proof. */
  onReady?: () => void;
  className?: string;
}

type FirstRunState =
  | { status: 'checking' }
  | { status: 'downloading'; fraction: number }
  | { status: 'warming-up' }
  | { status: 'ready' }
  | { status: 'error'; reason: 'insufficient-storage' | 'unknown'; message: string };

type FirstRunAction =
  | { type: 'start-download' }
  | { type: 'already-cached' }
  | { type: 'progress'; fraction: number }
  | { type: 'ready' }
  | { type: 'error'; reason: 'insufficient-storage' | 'unknown'; message: string };

function reduce(_state: FirstRunState, action: FirstRunAction): FirstRunState {
  switch (action.type) {
    case 'start-download':
      return { status: 'downloading', fraction: 0 };
    case 'already-cached':
      return { status: 'warming-up' };
    case 'progress':
      return action.fraction >= 1 ? { status: 'warming-up' } : { status: 'downloading', fraction: action.fraction };
    case 'ready':
      return { status: 'ready' };
    case 'error':
      return { status: 'error', reason: action.reason, message: action.message };
  }
}

export function FirstRun({ spec, store, fetchImpl, storageGate, requiredBytes, engine, onReady, className }: FirstRunProps) {
  const [state, dispatch] = useReducer(reduce, { status: 'checking' });

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const complete = await isModelSetComplete(store, spec);
      if (cancelled) return;
      dispatch(complete ? { type: 'already-cached' } : { type: 'start-download' });

      try {
        await ensureModelSetReady(spec, {
          store,
          fetchImpl,
          storageGate,
          requiredBytes,
          engine,
          onProgress: (fraction) => {
            if (!cancelled) dispatch({ type: 'progress', fraction });
          },
        });
        if (cancelled) return;
        dispatch({ type: 'ready' });
        onReady?.();
      } catch (error) {
        if (cancelled) return;
        if (error instanceof InsufficientStorageError) {
          dispatch({ type: 'error', reason: 'insufficient-storage', message: error.message });
        } else {
          dispatch({ type: 'error', reason: 'unknown', message: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
    // Intentionally re-runs if the identity of any dependency changes (e.g.
    // a caller swapping `spec` to point at a different model set) — the
    // whole readiness flow restarts from a fresh presence check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, store, fetchImpl, storageGate, requiredBytes, engine]);

  const rootClassName = ['first-run', `first-run--${state.status}`, className].filter(Boolean).join(' ');

  return (
    <div className={rootClassName} data-status={state.status}>
      {state.status === 'checking' && <p className="first-run__message">Prüfe, ob das Modell bereits vorliegt…</p>}

      {state.status === 'downloading' && (
        <div className="first-run__download">
          <p className="first-run__message">Modell wird heruntergeladen…</p>
          <progress className="first-run__progress" value={state.fraction} max={1} data-fraction={state.fraction} />
          <p className="first-run__progress-label">{Math.round(state.fraction * 100)}%</p>
        </div>
      )}

      {state.status === 'warming-up' && <p className="first-run__message">Modell wird vorbereitet…</p>}

      {state.status === 'ready' && <p className="first-run__message">Bereit.</p>}

      {state.status === 'error' && (
        <div className="first-run__error" role="alert">
          <p className="first-run__message">
            {state.reason === 'insufficient-storage' ? 'Nicht genug Speicherplatz für das Modell.' : 'Modell-Download fehlgeschlagen.'}
          </p>
          <p className="first-run__error-detail">{state.message}</p>
        </div>
      )}
    </div>
  );
}
