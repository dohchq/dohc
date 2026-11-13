import type { ChatWakeAgent } from "./chatWakeConsumer";

/**
 * The candidate's agent as this computer has it now. Trust waits on the
 * folder's identity, so it is read first. Settings and the pause are read
 * after it, and nothing waits after them, so a rename, a pause, or a switch
 * made during the trust lookup is what this answers.
 */
export async function currentChatWakeAgent(input: {
  agentId: string;
  trusted(): Promise<boolean>;
  agents(): Promise<readonly { id: string; name: string; enabled: boolean; launch?: unknown }[]>;
  repliesPaused(): boolean;
}): Promise<ChatWakeAgent | null> {
  const trusted = await input.trusted();
  const agent = (await input.agents()).find((each) => each.id === input.agentId);
  if (agent === undefined) return null;
  return {
    name: agent.name,
    enabled: agent.enabled,
    launch: agent.launch !== undefined,
    admitted: trusted && !input.repliesPaused(),
  };
}
