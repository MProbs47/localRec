/**
 * U8: the virtualized, two-tier live transcript display (R2 + R14).
 *
 * Two independent halves, matching the UI spec's "Schreibmaschinen-Ausgabe"
 * (device spec §6):
 *
 *  1. **Finalized log** (`.transcript__final`) — reads `store`
 *     (`transcriptStore.ts`) via `useSyncExternalStore` and renders only the
 *     scrolled-into-view window through `@tanstack/react-virtual`, so tens
 *     of thousands of segments (R14) stay cheap to render. Each row is
 *     `React.memo`-wrapped and keyed by the store's stable `seq`, so a new
 *     segment arriving re-renders only the (small, viewport-sized) set of
 *     rows the virtualizer decides to mount/update — not the whole log.
 *  2. **Interim line** (`.transcript__interim`) — a single separate
 *     element outside the virtualized log, driven by the `interimText`
 *     prop and updated independently of it (§6: "Nur die letzte Zeile ist
 *     veränderlich"). Prop changes are coalesced to at most one DOM write
 *     per animation frame (`useCoalescedText` below) rather than one state
 *     update per delta — on top of, not instead of, `TranscriptChannel`'s
 *     own ~150ms throttle (KTD2/U4).
 *
 * Auto-scroll follows new finalized segments; scrolling up pauses it and
 * surfaces a `↓ LIVE` button that jumps back to the bottom and resumes it
 * (§6). `prefers-reduced-motion` (§9) drops the scroll animation to instant
 * and adds a `transcript--reduced-motion` class so a later stylesheet
 * (theme.css, U12) can gate the cursor-blink animation off — this
 * component owns behavior, not the actual blink/typewriter visuals, which
 * are U12's styling layer per the plan's UI-Design section ("DU vergibst
 * nur semantische CSS-Klassen... kein Hardcoding von Hex-Farben/Fonts").
 *
 * a11y (§9): `.transcript__final` is `aria-live="polite"` so finalized text
 * is announced; `.transcript__interim` is `aria-hidden` so in-progress
 * corrections are not (each token wobble would otherwise be read aloud).
 * Known, accepted limitation: virtualization means off-screen finalized
 * rows are not in the DOM at all, so a screen reader only ever hears
 * segments that scrolled through the live region while attached — an
 * inherent tension between R14 (virtualize tens of thousands of rows) and
 * R2/§9 (announce finalized text), left as-is per YAGNI rather than adding
 * a parallel non-virtualized live-region mirror.
 */
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { t } from '../i18n';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';
import type { TranscriptSegment, TranscriptStore } from './transcriptStore';

export interface LiveTranscriptProps {
  /** Store holding the finalized log (U8/R14) — lives outside this component's render path; see `transcriptStore.ts`. */
  store: TranscriptStore;
  /** Current running (not-yet-finalized) text — R2's "dim" tier, a separate element from the finalized log (§6). */
  interimText?: string;
  /**
   * True while recording, when the running interim IS the live content. It
   * then becomes the growing, bottom-anchored (auto-scroll to newest) area and
   * the finalized log yields the space — otherwise a long single-segment
   * recording (no sub-session cut yet) overflows the screen with no way to
   * follow the newest words. When false (stopped), the finalized log fills the
   * screen as before.
   */
  interimActive?: boolean;
  /** Row height (px) fed to the virtualizer's `estimateSize`. Also the deterministic-window knob for tests, since jsdom has no real layout to measure against. */
  rowHeightPx?: number;
  className?: string;
}

const DEFAULT_ROW_HEIGHT_PX = 28;
/** How far (px) from the bottom the user has to scroll before auto-scroll pauses and `↓ LIVE` appears (§6). */
const AUTO_SCROLL_THRESHOLD_PX = 48;
const OVERSCAN_ROWS = 8;

// Structural only (layout/scroll, not design — colors/fonts/spacing stay
// theme.css's job, U12). `flex`+`minHeight:0` is what lets `.transcript__
// final` actually scroll within whatever height an ancestor gives
// `.transcript` (percentage heights alone wouldn't: a flex child needs
// `min-height: 0` to shrink below its content size instead of the
// scrollable area silently growing to fit everything).
const ROOT_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
};

const SCROLL_CONTAINER_STYLE: CSSProperties = {
  position: 'relative',
  overflowY: 'auto',
  flex: '1 1 auto',
  minHeight: 0,
};

// While recording, the finalized log yields most of the height (capped, still
// scrollable) so the growing interim owns the screen and can scroll to newest.
const FINAL_STYLE_RECORDING: CSSProperties = { ...SCROLL_CONTAINER_STYLE, flex: '0 1 auto', maxHeight: '35%' };
// The interim then becomes the primary, bottom-anchored scroll area.
const INTERIM_STYLE_ACTIVE: CSSProperties = { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' };

export function LiveTranscript({
  store,
  interimText = '',
  interimActive = false,
  rowHeightPx = DEFAULT_ROW_HEIGHT_PX,
  className,
}: LiveTranscriptProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const segments = snapshot.segments;

  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const prefersReducedMotion = usePrefersReducedMotion();

  const getScrollElement = useCallback(() => scrollElementRef.current, []);
  const estimateSize = useCallback(() => rowHeightPx, [rowHeightPx]);

  // Whisper blocks are multi-line (a whole ~12s window of speech), not the
  // one-liner word-segments the old model produced — so rows MUST be measured,
  // not assumed to be `rowHeightPx` tall, or a 3-line block gets placed in a
  // 1-line slot and consecutive blocks overlap. Falls back to `rowHeightPx`
  // when the environment reports 0 height (jsdom has no layout — keeps the
  // tests' deterministic row window intact); a real browser returns the true
  // wrapped height.
  const measureElement = useCallback(
    (element: Element) => {
      const height = element.getBoundingClientRect().height;
      return height > 0 ? height : rowHeightPx;
    },
    [rowHeightPx],
  );

  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement,
    estimateSize,
    measureElement,
    overscan: OVERSCAN_ROWS,
  });

  // Follows new segments as they finalize, unless the user scrolled up
  // (handleScroll below). Reduced motion drops the animation, not the
  // scroll itself — the view must still land at the newest segment.
  useEffect(() => {
    if (!autoScroll || segments.length === 0) return;
    virtualizer.scrollToEnd({ behavior: prefersReducedMotion ? 'auto' : 'smooth' });
  }, [segments.length, autoScroll, virtualizer, prefersReducedMotion]);

  const handleScroll = useCallback(() => {
    const el = scrollElementRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distanceFromBottom <= AUTO_SCROLL_THRESHOLD_PX);
  }, []);

  const jumpToLive = useCallback(() => {
    setAutoScroll(true);
    virtualizer.scrollToEnd({ behavior: prefersReducedMotion ? 'auto' : 'smooth' });
  }, [virtualizer, prefersReducedMotion]);

  const displayedInterimText = useCoalescedText(interimText);

  // Keep the newest interim words in view while recording (teleprompter): the
  // interim area scrolls to its bottom on every update. Only when it is the
  // active, growing area — otherwise it's an empty one-liner and this is a no-op.
  const interimRef = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (!interimActive) return;
    const el = interimRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [displayedInterimText, interimActive]);

  const virtualItems = virtualizer.getVirtualItems();
  const rootClassName = ['transcript', prefersReducedMotion && 'transcript--reduced-motion', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClassName} style={ROOT_STYLE}>
      <div
        className="transcript__final"
        ref={scrollElementRef}
        onScroll={handleScroll}
        aria-live="polite"
        style={interimActive ? FINAL_STYLE_RECORDING : SCROLL_CONTAINER_STYLE}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualItems.map((virtualRow) => {
            const segment = segments[virtualRow.index];
            if (!segment) return null;
            return (
              <TranscriptRow
                key={segment.seq}
                segment={segment}
                index={virtualRow.index}
                offsetPx={virtualRow.start}
                measureRef={virtualizer.measureElement}
              />
            );
          })}
        </div>
      </div>

      {/* R2/§6: separate element, excluded from the aria-live region — see
          the class-level doc comment for why. While recording it's the primary,
          bottom-anchored scroll area (auto-scrolled above). */}
      <p
        className="transcript__interim"
        ref={interimRef}
        aria-hidden="true"
        style={interimActive ? INTERIM_STYLE_ACTIVE : undefined}
      >
        {displayedInterimText}
        <span className="transcript__cursor" aria-hidden="true" />
      </p>

      {!autoScroll && (
        <button type="button" className="transcript__live-jump" onClick={jumpToLive}>
          {t('transcript.jumpToLive')}
        </button>
      )}
    </div>
  );
}

interface TranscriptRowProps {
  segment: TranscriptSegment;
  /** The virtualizer's `virtualRow.index` — needed as `data-index` so the virtualizer's dynamic measurement can map the measured element back to its row. */
  index: number;
  /** The virtualizer's `virtualRow.start` — a plain number, not a `style` object. Deliberate: an inline `style={{...}}` object literal gets a fresh identity on every parent render regardless of whether its *contents* changed, which would defeat `React.memo`'s shallow prop comparison below even for rows whose position didn't move. Primitives compare by value, so memo correctly bails when neither `segment` nor `offsetPx` changed. */
  offsetPx: number;
  /** `virtualizer.measureElement` (stable identity) — attached as the row's `ref` so the virtualizer measures its real (wrapped, multi-line) height instead of assuming `rowHeightPx`. */
  measureRef: (element: Element | null) => void;
}

/**
 * `React.memo`-wrapped so an unrelated new segment (which only changes
 * `segments.length`/the virtualizer's item list, not this row's own
 * `segment`/`offsetPx` props) doesn't re-render every already-mounted row —
 * the store guarantees `segment` keeps its object identity across later
 * appends (`transcriptStore.ts`), so memo's shallow prop comparison
 * actually bails. `data-render-count` is a lightweight, harmless-in-
 * production render counter that makes that bail-out directly assertable
 * in tests without reaching for React internals.
 */
const TranscriptRow = memo(function TranscriptRow({ segment, index, offsetPx, measureRef }: TranscriptRowProps) {
  const renderCount = useRef(0);
  renderCount.current += 1;
  const style: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    transform: `translateY(${offsetPx}px)`,
  };
  return (
    <div
      ref={measureRef}
      data-index={index}
      className="transcript__row"
      style={style}
      data-seq={segment.seq}
      data-render-count={renderCount.current}
    >
      {segment.text}
    </div>
  );
});

/**
 * Buffers rapid `text` changes into at most one state update per animation
 * frame (§6: "Neue Zeichen werden gebündelt pro Bildframe... geschrieben,
 * nicht einzeln über State-Updates").
 */
function useCoalescedText(text: string): string {
  const [displayed, setDisplayed] = useState(text);
  const pendingRef = useRef(text);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    pendingRef.current = text;
    if (frameRef.current !== null) return; // a flush is already scheduled for this frame
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setDisplayed(pendingRef.current);
    });
  }, [text]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        // Reset the ref, not just cancel: StrictMode's dev mount→unmount→remount
        // cancels the pending frame here, but if the id is left non-null the
        // remounted effect's `if (frameRef.current !== null) return` guard
        // blocks EVERY future frame — `displayed` then freezes at its initial
        // value and the live interim text never renders. Nulling it lets the
        // remount schedule a fresh frame.
        frameRef.current = null;
      }
    },
    [],
  );

  return displayed;
}

