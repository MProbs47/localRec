/**
 * U12 §7 — the VU-meter: two columns of 18 segments each, filled from the
 * bottom. Filled segments are `--ink`, empty ones a 1px outline (theme.css).
 *
 * The fill comes from the *microphone* RMS level, not transcription progress
 * (§7): it must deflect the instant someone speaks, even before the model
 * emits any text. The level is produced in the AudioWorklet (already smoothed
 * over ~100ms there) and handed to this component through a `getLevel` reader
 * rather than a React prop — a prop would force a re-render on every frame.
 * This component runs its own `requestAnimationFrame` loop, reads the latest
 * level, maps it to a discrete 0–18 fill, and only calls `setState` when that
 * discrete count actually changes (≤18 distinct values → at most a handful of
 * updates per second, not one per frame).
 *
 * At rest (`active === false`, e.g. the `ready` state where no mic is open)
 * the meter shows the spec's resting look: only the bottom two segments lit.
 */
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';

export interface VuMeterProps {
  /** Reads the latest smoothed mic level (~0..1). Called once per frame; must be cheap and allocation-free. */
  getLevel: () => number;
  /** Whether the mic is live. When false the meter shows the resting fill. */
  active: boolean;
  /** Segments per column (§7: 18). */
  segments?: number;
  /** Columns (§7: 2). */
  columns?: number;
  /** Resting fill when inactive (§3: "die untersten zwei"). */
  restingSegments?: number;
  /** Label under the meter (reference render: "IN"). */
  label?: string;
}

const DEFAULT_SEGMENTS = 18;
const DEFAULT_COLUMNS = 2;
const DEFAULT_RESTING = 2;

/**
 * Maps a roughly-0..1 RMS level to a 0..segments fill. Speech RMS rarely
 * approaches 1.0, so a modest gain + clamp keeps the meter lively without
 * pinning it to the ceiling. Purely visual — no downstream consumer.
 */
function levelToFill(level: number, segments: number): number {
  const gained = Math.min(1, Math.max(0, level) * 3.2);
  return Math.round(gained * segments);
}

export function VuMeter({
  getLevel,
  active,
  segments = DEFAULT_SEGMENTS,
  columns = DEFAULT_COLUMNS,
  restingSegments = DEFAULT_RESTING,
  label = t('vu.label'),
}: VuMeterProps) {
  const [fill, setFill] = useState(restingSegments);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      // Return to the resting look and stop the loop entirely.
      setFill(restingSegments);
      return;
    }
    let lastFill = -1;
    const tick = () => {
      const next = Math.max(1, levelToFill(getLevel(), segments));
      if (next !== lastFill) {
        lastFill = next;
        setFill(next);
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [active, getLevel, segments, restingSegments]);

  // Segments render top-to-bottom in the DOM; fill counts from the bottom, so
  // segment index i (0 = top) is lit when it falls within the bottom `fill`.
  const columnIndices = Array.from({ length: columns }, (_, c) => c);
  const segIndices = Array.from({ length: segments }, (_, s) => s);

  return (
    <div className="vu" role="meter" aria-hidden="true">
      {columnIndices.map((c) => (
        <div className="vu__col" key={c}>
          {segIndices.map((s) => {
            const litFromBottom = segments - s <= fill;
            return (
              <span
                key={s}
                className={litFromBottom ? 'vu__seg vu__seg--on' : 'vu__seg'}
              />
            );
          })}
        </div>
      ))}
      {label && <span className="vu__label">{label}</span>}
    </div>
  );
}
