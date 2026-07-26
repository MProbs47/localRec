// @vitest-environment jsdom
/**
 * Per the plan's explicitly documented "Realitäts-Grenze" (U8): jsdom has
 * no real layout engine, so `@tanstack/react-virtual`'s size measurement
 * (`offsetWidth`/`offsetHeight`) reads 0 for every element unless mocked.
 * These tests fix a deterministic container size (via a prototype-level
 * `offsetHeight`/`offsetWidth` shim scoped to `.transcript__final`, see
 * `beforeAll` below) so the virtualizer computes a bounded, predictable
 * visible window instead of "everything" or "nothing". They deliberately
 * do NOT assert on pixel-exact scroll positions or real scrolling
 * smoothness — that is the plan's declared manual milestone, not something
 * jsdom can prove.
 */
import { act, StrictMode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LiveTranscript } from './LiveTranscript';
import { TranscriptStore } from './transcriptStore';

const ROW_HEIGHT_PX = 20;
const VIEWPORT_HEIGHT_PX = 200;
const VIEWPORT_WIDTH_PX = 800;

function seedSegments(store: TranscriptStore, count: number, offset = 0) {
  for (let i = offset; i < offset + count; i += 1) {
    store.append({ text: `segment ${i}`, startMs: i * 1000, endMs: i * 1000 + 900 });
  }
}

/** Minimal `matchMedia` stub — jsdom doesn't implement it at all (not even a no-op), and `LiveTranscript` reads it for `prefers-reduced-motion` (§9). Reduced motion is stubbed "on" by default in this file so scroll-related assertions don't depend on animation timing. */
function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }),
  });
}

beforeAll(() => {
  // Scoped by class name (not a blanket override) so rows themselves keep
  // reading 0, matching real virtualized-row behavior (their size comes
  // from `estimateSize`/`rowHeightPx`, not measured layout).
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('transcript__final') ? VIEWPORT_HEIGHT_PX : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('transcript__final') ? VIEWPORT_WIDTH_PX : 0;
    },
  });
});

beforeEach(() => {
  stubMatchMedia(true);
});

afterEach(() => {
  // UNMOUNT, not just wipe: `globals` is off, so testing-library's automatic
  // cleanup never registers. A wiped-but-mounted tree left the virtualizer's
  // pending isScrolling debounce (150 ms) alive past the jsdom teardown —
  // "window is not defined" from Timeout._onTimeout, a rare full-suite flake.
  cleanup();
});

describe('LiveTranscript (U8: virtualized finalized log + independent interim line)', () => {
  it('renders only a bounded window of DOM rows out of 40,000 stored segments (R14)', () => {
    const store = new TranscriptStore();
    seedSegments(store, 40_000);

    const { container } = render(<LiveTranscript store={store} rowHeightPx={ROW_HEIGHT_PX} />);

    const rows = container.querySelectorAll('.transcript__row');
    // VIEWPORT_HEIGHT_PX / ROW_HEIGHT_PX = 10 visible rows, plus overscan
    // on each side — comfortably bounded, nowhere near 40,000.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
  });

  it('does not re-render existing rows when one new segment is appended (memoization, R14)', () => {
    const store = new TranscriptStore();
    seedSegments(store, 5); // small enough that all 5 sit inside the fixed viewport + overscan

    const { container } = render(<LiveTranscript store={store} rowHeightPx={ROW_HEIGHT_PX} />);

    const renderCountsBefore = new Map<string, string>();
    container.querySelectorAll('.transcript__row').forEach((row) => {
      renderCountsBefore.set(row.getAttribute('data-seq')!, row.getAttribute('data-render-count')!);
    });
    expect(renderCountsBefore.size).toBe(5);
    expect([...renderCountsBefore.values()]).toEqual(['1', '1', '1', '1', '1']);

    act(() => {
      store.append({ text: 'segment 5', startMs: 5000, endMs: 5900 });
    });

    const rowsAfter = container.querySelectorAll('.transcript__row');
    expect(rowsAfter.length).toBe(6);
    rowsAfter.forEach((row) => {
      const seq = row.getAttribute('data-seq')!;
      const renderCount = row.getAttribute('data-render-count')!;
      if (renderCountsBefore.has(seq)) {
        // The pre-existing rows must not have re-rendered.
        expect(renderCount).toBe(renderCountsBefore.get(seq));
      } else {
        // The newly appended row mounted fresh.
        expect(seq).toBe('5');
        expect(renderCount).toBe('1');
      }
    });
  });

  it('updates the interim line independently of the finalized log', async () => {
    const store = new TranscriptStore();
    seedSegments(store, 3);

    const { container, rerender } = render(
      <LiveTranscript store={store} rowHeightPx={ROW_HEIGHT_PX} interimText="hallo" />,
    );

    const finalTextsBefore = [...container.querySelectorAll('.transcript__row')].map((row) => row.textContent);
    expect(finalTextsBefore).toEqual(['segment 0', 'segment 1', 'segment 2']);
    expect(container.querySelector('.transcript__interim')?.textContent).toContain('hallo');

    rerender(<LiveTranscript store={store} rowHeightPx={ROW_HEIGHT_PX} interimText="hallo welt" />);

    // Wait one animation frame for the rAF-coalesced interim write.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    const finalTextsAfter = [...container.querySelectorAll('.transcript__row')].map((row) => row.textContent);
    expect(finalTextsAfter).toEqual(finalTextsBefore);
    expect(container.querySelector('.transcript__interim')?.textContent).toContain('hallo welt');
  });

  it('keeps updating the interim line under StrictMode (rAF coalescer survives the dev remount)', async () => {
    // Regression: StrictMode's dev mount→unmount→remount cancelled the pending
    // animation frame but left its id in the ref non-null, so the remounted
    // effect's `if (frameRef.current !== null) return` guard blocked EVERY
    // future frame — the interim text froze at its first value and live
    // transcription never rendered while recording. This test fails on the
    // pre-fix coalescer and passes once the cleanup nulls the ref.
    const store = new TranscriptStore();
    const { container, rerender } = render(
      <StrictMode>
        <LiveTranscript store={store} rowHeightPx={ROW_HEIGHT_PX} interimText="erst" />
      </StrictMode>,
    );
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    rerender(
      <StrictMode>
        <LiveTranscript store={store} rowHeightPx={ROW_HEIGHT_PX} interimText="erst zweit dritt" />
      </StrictMode>,
    );
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(container.querySelector('.transcript__interim')?.textContent).toContain('erst zweit dritt');
  });

  it('shows ↓ LIVE and pauses auto-scroll once the user scrolls away from the bottom, and jumping back re-enables it', () => {
    const store = new TranscriptStore();
    seedSegments(store, 30);

    const { container } = render(<LiveTranscript store={store} rowHeightPx={ROW_HEIGHT_PX} />);
    const scrollElement = container.querySelector('.transcript__final') as HTMLElement;

    expect(container.querySelector('.transcript__live-jump')).toBeNull();

    // Simulate the user scrolling far away from the bottom.
    act(() => {
      Object.defineProperty(scrollElement, 'scrollTop', { configurable: true, value: 0 });
      Object.defineProperty(scrollElement, 'scrollHeight', { configurable: true, value: 5_000 });
      Object.defineProperty(scrollElement, 'clientHeight', { configurable: true, value: VIEWPORT_HEIGHT_PX });
      scrollElement.dispatchEvent(new window.Event('scroll'));
    });

    const jumpButton = container.querySelector('.transcript__live-jump');
    expect(jumpButton).not.toBeNull();
    expect(jumpButton?.textContent).toContain('LIVE');

    act(() => {
      (jumpButton as HTMLButtonElement).click();
    });

    expect(container.querySelector('.transcript__live-jump')).toBeNull();
  });

  it('marks the finalized log aria-live="polite" and excludes the interim line from it (§9)', () => {
    const store = new TranscriptStore();
    seedSegments(store, 2);

    const { container } = render(<LiveTranscript store={store} rowHeightPx={ROW_HEIGHT_PX} interimText="läuft" />);

    const finalRegion = container.querySelector('.transcript__final');
    expect(finalRegion?.getAttribute('aria-live')).toBe('polite');

    const interimLine = container.querySelector('.transcript__interim');
    expect(interimLine?.getAttribute('aria-hidden')).toBe('true');
  });

  it('adds transcript--reduced-motion when prefers-reduced-motion matches, and omits it otherwise (§9)', () => {
    const store = new TranscriptStore();

    stubMatchMedia(true);
    const reduced = render(<LiveTranscript store={store} rowHeightPx={ROW_HEIGHT_PX} />);
    expect(reduced.container.querySelector('.transcript')?.classList.contains('transcript--reduced-motion')).toBe(
      true,
    );
    reduced.unmount();

    stubMatchMedia(false);
    const normal = render(<LiveTranscript store={store} rowHeightPx={ROW_HEIGHT_PX} />);
    expect(normal.container.querySelector('.transcript')?.classList.contains('transcript--reduced-motion')).toBe(
      false,
    );
    normal.unmount();
  });
});

// Pixel-exact virtualized scroll smoothness at tens of thousands of
// segments (real browser layout/compositing) is the plan's declared manual
// milestone (U8 "Realitäts-Grenze") — not reproducible in jsdom and
// intentionally not attempted here.
