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
