import { useEffect, useState } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * §9: reflects the `prefers-reduced-motion: reduce` user setting, live (updates
 * on change). Used to drop scroll/cursor animations to instant. Defensive
 * against `matchMedia` being unavailable (jsdom, older engines) rather than
 * throwing. Shared by `App.tsx` and `LiveTranscript.tsx` (previously duplicated
 * verbatim in both — plan 005 U5, #15).
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
