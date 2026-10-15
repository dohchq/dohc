/** Authorship while an agent holds a workspace's run slot. */
export interface ActiveAgentRun {
  agentId: string;
  onBehalfOf: string;
  agentRunId: string;
  depth: number;
}

/** The runner self-test holds the slot to check the runner starts; it is not agent work. */
export const RUNNER_SELF_TEST_AGENT_ID = "dohc-chat-runner-self-test";
