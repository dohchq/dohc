import { useEffect, useMemo, useRef, type DependencyList } from "react";

export function useRequestSequence(identity: DependencyList = []) {
  const sequence = useRef(0);
  const requests = useMemo(() => ({
    next: () => ++sequence.current,
    current: () => sequence.current,
    isCurrent: (token: number) => token === sequence.current,
  }), []);
  useEffect(() => () => { requests.next(); }, identity);
  return requests;
}
