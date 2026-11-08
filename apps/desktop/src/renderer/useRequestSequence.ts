import { useEffect, useMemo, useRef, type DependencyList } from "react";

export function useRequestSequence(identity: DependencyList = []) {
  const sequence = useRef(0);
  // The newest request when the owner last unmounted or changed identity.
  const cutOff = useRef(0);
  const requests = useMemo(() => ({
    next: () => ++sequence.current,
    current: () => sequence.current,
    isCurrent: (token: number) => token === sequence.current,
    // True when the owner went away while this was its newest request, rather
    // than a newer request replacing it.
    isCutOff: (token: number) => token === cutOff.current,
  }), []);
  useEffect(() => () => {
    cutOff.current = sequence.current;
    requests.next();
  }, identity);
  return requests;
}
