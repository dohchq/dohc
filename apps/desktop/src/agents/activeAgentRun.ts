/** Authorship while an agent holds a workspace's run slot. */
export interface ActiveAgentRun {
  agentId: string;
  onBehalfOf: string;
  agentRunId: string;
  depth: number;
}
