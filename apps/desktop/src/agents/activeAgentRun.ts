/** Authorship while an agent holds a workspace's run slot. */
export interface ActiveAgentRun {
  agentId: string;
  onBehalfOf: string;
  agentRunId: string;
  depth: number;
  // Set when dohc dispatched the run. The runner self-test holds the slot to
  // check the runner starts; it is not agent work.
  dispatch?: AgentRunDispatch;
}

export type AgentRunDispatch = "run" | "self-test";

/**
 * The agent a run's writes name when its agent gives no name, as a run dohc
 * dispatches does. It is the claim an unnamed `dohc chat --as-agent` reply
 * carries, so the run's files and replies are one actor.
 */
export const UNNAMED_AGENT_ID = "dohc-mcp";
