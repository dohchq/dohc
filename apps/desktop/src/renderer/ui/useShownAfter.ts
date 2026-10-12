import { useEffect, useState } from "react";

// Whether a state has lasted `delayMs` since it became active. A state that
// passes sooner never shows its words, so a quick open or a brief wait for a
// host draws nothing and moves nothing.
export function useShownAfter(active: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && shown;
}
