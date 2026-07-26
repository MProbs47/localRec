import { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

/**
 * Three dots that fill up cumulatively and loop — one, then two, then all three,
 * then back to one (the owner's chosen rest indicator). Static (all three shown)
 * under prefers-reduced-motion (§9).
 *
 * U8: moved out of `App.tsx` verbatim — a shared leaf used by `ImportingScreen`
 * (`FirstRunScreens.tsx`), `MeetingRecordingView.tsx` and `StoppedScreen.tsx`.
 */
export function RecordingDots() {
  const reduced = usePrefersReducedMotion();
  const [count, setCount] = useState(reduced ? 3 : 1);

  useEffect(() => {
    if (reduced) {
      setCount(3);
      return;
    }
    const id = window.setInterval(() => setCount((c) => (c % 3) + 1), 450);
    return () => window.clearInterval(id);
  }, [reduced]);

  return (
    <span className="dots" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className={i < count ? 'dots__dot dots__dot--on' : 'dots__dot'} />
      ))}
    </span>
  );
}
