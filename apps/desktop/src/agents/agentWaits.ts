/**
 * The agents you run that hold a chat wait on this computer, counted per id.
 * `onChange` hears the sorted ids each time an agent starts or stops listening.
 * An agent stays listening for `holdMs` after its last wait ends, so one that
 * waits again at once never drops out between waits.
 */
export function createAgentWaits(onChange: (agentIds: string[]) => void, holdMs = 2_000) {
  const open = new Map<string, number>();
  const holds = new Map<string, ReturnType<typeof setTimeout>>();
  const listening = () => [...new Set([...open.keys(), ...holds.keys()])].sort();
  return {
    listening,
    /** Counts one wait by this agent. The returned function ends it; a second call does nothing. */
    begin(agentId: string): () => void {
      const count = open.get(agentId) ?? 0;
      open.set(agentId, count + 1);
      const held = holds.get(agentId);
      if (held !== undefined) {
        clearTimeout(held);
        holds.delete(agentId);
      } else if (count === 0) onChange(listening());
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const left = (open.get(agentId) ?? 1) - 1;
        if (left > 0) {
          open.set(agentId, left);
          return;
        }
        open.delete(agentId);
        holds.set(agentId, setTimeout(() => {
          holds.delete(agentId);
          onChange(listening());
        }, holdMs));
      };
    },
  };
}
