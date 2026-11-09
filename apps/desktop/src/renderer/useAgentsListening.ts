import { useEffect, useState } from "react";
import { bridge } from "./bridge";

// The agents you run that wait for messages on this computer now, by id. Main
// pushes each change, and a pushed answer is newer than the first read. A row
// whose read fails shows its usual state.
export function useAgentsListening(): ReadonlySet<string> {
  const [listening, setListening] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let live = true;
    let heard = false;
    const stopListening = bridge().onAgentsListening((event) => {
      heard = true;
      if (live) setListening(new Set(event.agentIds));
    });
    void bridge().readAgentsListening({}).then((event) => {
      if (live && !heard) setListening(new Set(event.agentIds));
    }, () => undefined);
    return () => {
      live = false;
      stopListening();
    };
  }, []);
  return listening;
}
