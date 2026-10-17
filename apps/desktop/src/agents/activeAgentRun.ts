/** Authorship while an agent holds a workspace's run slot. */
export interface ActiveAgentRun {
  agentId: string;
  onBehalfOf: string;
  agentRunId: string;
  depth: number;
}

/**
 * The agent a run's writes name when its agent gives no name, as a run dohc
 * dispatches does. It is the claim an unnamed `dohc chat --as-agent` reply
 * carries, so the run's files and replies are one actor.
 */
export const UNNAMED_AGENT_ID = "dohc-mcp";
