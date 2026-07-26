// @vitest-environment jsdom
/**
 * U12 §7: the VU-meter renders two columns of 18 segments, lights the bottom
 * two at rest, and deflects from the mic level (read through `getLevel`, not a
 * prop) while active. The rAF loop is exercised by stubbing
 * requestAnimationFrame to fire its callback exactly once, so the discrete
 * fill can be asserted without a real animation frame or a runaway loop.
 */
import { act } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VuMeter } from './VuMeter';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const litCount = (container: HTMLElement) => container.querySelectorAll('.vu__seg--on').length;

/** Fire the rAF callback exactly once (the loop re-schedules itself, so an
 *  unbounded stub would recurse until the stack blows). One frame is enough to
 *  observe the discrete fill settle. */
function stubSingleFrame() {
  let fired = false;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    if (!fired) {
      fired = true;
      cb(0);
    }
    return 0;
  });
}

describe('VuMeter', () => {
  it('renders two columns of 18 segments', () => {
    const { container } = render(<VuMeter getLevel={() => 0} active={false} />);
    expect(container.querySelectorAll('.vu__col')).toHaveLength(2);
    expect(container.querySelectorAll('.vu__seg')).toHaveLength(36);
  });

  it('lights only the bottom two segments per column at rest (§3)', () => {
    const { container } = render(<VuMeter getLevel={() => 0} active={false} />);
    expect(litCount(container)).toBe(4); // 2 columns × bottom 2
  });

  it('deflects toward full when active and the mic level is high (§7)', () => {
    stubSingleFrame();
    const { container } = render(<VuMeter getLevel={() => 1} active />);
    act(() => {}); // flush the effect's first (and only) frame
    expect(litCount(container)).toBe(36); // full deflection: all 18 per column
  });

  it('returns to the resting fill when it goes inactive', () => {
    let level = 1;
    stubSingleFrame();
    const { container, rerender } = render(<VuMeter getLevel={() => level} active />);
    expect(litCount(container)).toBe(36);
    level = 0;
    rerender(<VuMeter getLevel={() => level} active={false} />);
    expect(litCount(container)).toBe(4);
  });
});
