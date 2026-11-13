import { handleForName, normalizeHandle } from "@dohc/workspace-contracts/chat-mentions";
import {
  CHAT_RUNNER_AGENTS,
  CHAT_RUNNER_COMPUTER_LABEL_MAX_CHARS,
  CHAT_RUNNER_DISPLAY_NAME_MAX_CHARS,
  CHAT_RUNNER_INSTALL_ID_MAX_CHARS,
  isChatRunnerAgentId,
  isChatWakeLine,
  type ChatRunnerDeclaration,
} from "@dohc/workspace-contracts/chat-wakes";
import type { Agent } from "../settings/userSettings";

/** Why this computer's agents can't be declared as they are. Nothing is declared then: the relay never gets part of the list. */
export type ChatRunnerRefusal =
  | { reason: "install-id" | "computer-label" | "too-many-agents" }
  | { reason: "agent-id" | "agent-name" | "same-name"; agentId: string };

/**
 * The `PUT /sync/workspaces/:id/runners` body for this computer: each agent
 * dohc can start, on or off. An agent the person runs on their own is left
 * out, and so is every command, environment, and timeout. An empty list
 * withdraws the computer.
 */
export function chatRunnerDeclaration(input: {
  installId: string;
  computerLabel: string;
  agents: readonly Pick<Agent, "id" | "name" | "enabled" | "launch">[];
}): { ok: true; declaration: ChatRunnerDeclaration } | ({ ok: false } & ChatRunnerRefusal) {
  if (!isChatWakeLine(input.installId, CHAT_RUNNER_INSTALL_ID_MAX_CHARS))
    return { ok: false, reason: "install-id" };
  if (!isChatWakeLine(input.computerLabel, CHAT_RUNNER_COMPUTER_LABEL_MAX_CHARS))
    return { ok: false, reason: "computer-label" };
  const runners = input.agents.filter((agent) => agent.launch !== undefined);
  if (runners.length > CHAT_RUNNER_AGENTS) return { ok: false, reason: "too-many-agents" };
  const handles = new Set<string>();
  for (const agent of runners) {
    if (!isChatRunnerAgentId(agent.id)) return { ok: false, reason: "agent-id", agentId: agent.id };
    if (!isChatWakeLine(agent.name, CHAT_RUNNER_DISPLAY_NAME_MAX_CHARS))
      return { ok: false, reason: "agent-name", agentId: agent.id };
    // The relay derives each handle from the name and refuses two agents with one.
    const handle = normalizeHandle(handleForName(agent.name));
    if (handle !== "" && handles.has(handle))
      return { ok: false, reason: "same-name", agentId: agent.id };
    handles.add(handle);
  }
  return {
    ok: true,
    declaration: {
      installId: input.installId,
      computerLabel: input.computerLabel,
      runners: runners.map((agent) => ({
        agentId: agent.id,
        displayName: agent.name,
        enabled: agent.enabled,
      })),
    },
  };
}
