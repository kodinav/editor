import { useCallback, useEffect, useState } from 'react';

export function useMediaQuery(q: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    on();
    return () => m.removeEventListener('change', on);
  }, [q]);
  return match;
}

/** A number persisted in localStorage (layout sizes). */
export function useLocalNumber(key: string, initial: number): [number, (v: number) => void] {
  const [v, setV] = useState(() => {
    try {
      const s = localStorage.getItem(key);
      const n = s === null ? NaN : Number(s);
      return isFinite(n) ? n : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (n: number) => {
      setV(n);
      try {
        localStorage.setItem(key, String(n));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [v, set];
}
