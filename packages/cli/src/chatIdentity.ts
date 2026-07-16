import { agentDisplayLabel } from "@dohc/workspace-contracts/chat-identity";

export interface CliChatAuthor {
  kind: "human" | "agent";
  displayName: string;
}

/**
 * Engine rows keep the owner's raw display name. Text renderers add the agent
 * relationship at presentation time so every CLI surface agrees with dohc.
 */
export function renderAuthorDisplayName(author: CliChatAuthor): string {
  return author.kind === "agent"
    ? agentDisplayLabel(author.displayName)
    : author.displayName;
}
