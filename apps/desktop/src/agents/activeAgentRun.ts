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
 * The agent a write names when an agent outside a run dohc dispatched gives
 * no name. A dispatched run's writes name its agent's id instead.
 */
export const UNNAMED_AGENT_ID = "dohc-mcp";
