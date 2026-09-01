import { useCallback, useState } from "react";

// An accepted external value can be byte-identical to the controlled value.
// State guarantees that the authority boundary still commits so an editor can
// discard local history even when every text-bearing state setter bails out.
export function useAuthoritativeValueRevision() {
  const [revision, setRevision] = useState(0);
  const advance = useCallback(() => {
    setRevision((current) => current + 1);
  }, []);
  return [revision, advance] as const;
}
