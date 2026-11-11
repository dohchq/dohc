import { isAgentIdTaken } from "../../ipc/errorWords";
import { hiddenChatsFor } from "../../settings/archivedChats";
import {
  automationAgent,
  listAgents,
  type Agent,
  type AgentProblem,
  type DesktopUserSettings,
  type DesktopUserSettingsResult,
} from "../../settings/userSettings";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";

export type AgentListRow =
  | { kind: "agent"; agent: Agent }
  | { kind: "broken"; problem: AgentProblem };

/** Your agents and the entries dohc could not use, in the order the file lists them. */
export function agentListRows(settings: Pick<DesktopUserSettings, "agents">, problems: readonly AgentProblem[] = []): AgentListRow[] {
  const agents = listAgents(settings);
  const rows: AgentListRow[] = [];
  let next = 0;
  for (const problem of [...problems].sort((left, right) => left.position - right.position)) {
    while (rows.length < problem.position && next < agents.length) rows.push({ kind: "agent", agent: agents[next++]! });
    rows.push({ kind: "broken", problem });
  }
  return [...rows, ...agents.slice(next).map((agent) => ({ kind: "agent" as const, agent }))];
}

export const rowId = (row: AgentListRow) => (row.kind === "agent" ? row.agent.id : row.problem.id);

/**
 * `order` with `id` back where it was: after the entry it followed, or in
 * front of the one after it when that entry is gone, or first. It never goes
 * ahead of `keep`, an agent chosen since that should go on waking automations.
 */
export function placeBack(order: readonly string[], id: string, before: string | undefined, after: string | undefined, keep?: string): string[] {
  const rest = order.filter((entry) => entry !== id);
  let at = before !== undefined && rest.includes(before) ? rest.indexOf(before) + 1
    : after !== undefined && rest.includes(after) ? rest.indexOf(after) : 0;
  if (keep !== undefined && rest.includes(keep)) at = Math.max(at, rest.indexOf(keep) + 1);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** The identity of an agent's failed check in Notices. */
export function checkIdentity(workspaceId: string, agentId: string): string {
  return `agent-check:${workspaceId}:${agentId}`;
}

/**
 * Removes an agent from Settings with Undo in the notice, from Settings or
 * from its chat's menu in Chats. Undo puts the agent back under the name and
 * settings it had, where it was (`placeBack`). Every other entry keeps its
 * place in the file as it is then. An agent in the file with its id by then
 * stays. Answers whether the agent was removed.
 */
export async function removeAgentWithUndo(input: {
  workspaceId: string;
  settings: DesktopUserSettings;
  agentProblems?: readonly AgentProblem[] | undefined;
  agent: Pick<Agent, "id" | "name">;
  // The agent's chat here, when known. One taken off Archived after an
  // earlier Remove comes back to Archived now.
  chatId?: string | undefined;
  // Answers with the settings main saved, or null when a failed save said why.
  save: (settings: DesktopUserSettings) => Promise<DesktopUserSettingsResult | null>;
  // Moves these entries to the front of the file; answers whether it saved.
  order: (order: readonly string[], failure?: string) => Promise<boolean>;
  onError?: ((message: string, cause?: unknown) => void) | undefined;
  onClearError?: ((identity: string) => void) | undefined;
  onNotice?: ((message: string, undo?: () => void) => void) | undefined;
}): Promise<boolean> {
  const { workspaceId, settings, agent, save, order, onError, onClearError, onNotice } = input;
  const fileOrder = agentListRows(settings, input.agentProblems).map(rowId);
  const at = fileOrder.indexOf(agent.id);
  const [before, after] = [fileOrder[at - 1], fileOrder[at + 1]];
  const { [agent.id]: entry, ...agents } = settings.agents;
  if (!entry) return false;
  const saved = await save({ ...settings, agents });
  if (!saved) return false;
  // The file can hold the agent again by the time main saves.
  if (Object.hasOwn(saved.settings.agents, agent.id) || saved.agentProblems?.some((problem) => problem.id === agent.id)) {
    onError?.(`dohc didn't remove ${agent.name} because the settings file still lists it.`);
    return false;
  }
  if (input.chatId !== undefined && hiddenChatsFor(saved.settings, workspaceId).includes(input.chatId)) {
    void bridge().setChatArchived({ workspaceId, channelId: input.chatId, state: "active" }).catch((cause: unknown) =>
      onError?.(ipcErrorMessage(cause, `dohc could not put ${agent.name}'s chat back in Archived.`), cause));
  }
  const left = agentListRows(saved.settings, saved.agentProblems).map(rowId);
  // Its failed check goes with it, and Undo doesn't bring that back.
  onClearError?.(checkIdentity(workspaceId, agent.id));
  onNotice?.(`Removed ${agent.name}.`, () => void (async () => {
    let file: DesktopUserSettingsResult;
    try {
      file = await bridge().getUserSettings();
    } catch (cause) {
      onError?.(ipcErrorMessage(cause, `dohc could not bring back ${agent.name}.`), cause);
      return;
    }
    const current = file.settings;
    const problem = file.agentProblems?.find((candidate) => candidate.id === agent.id);
    const holder = current.agents[agent.id]?.name ?? (problem ? problem.name ?? problem.id : null);
    const keep = (name: string) => onError?.(`Undo didn't replace the new ${name}, so the one you removed stays removed.`);
    if (holder !== null) {
      keep(holder);
      return;
    }
    // If the agents are in the order this Remove left them, it goes back
    // exactly where it was. Otherwise it doesn't go ahead of the agent that
    // wakes automations now.
    const now = agentListRows(current, file.agentProblems).map(rowId);
    const unchanged = now.length === left.length && now.every((id, index) => id === left[index]);
    const next = placeBack(now, agent.id, before, after, unchanged ? undefined : automationAgent(current)?.id);
    // Saved from the file just read, so main refuses it if the agent came back since.
    try {
      await bridge().setUserSettings({ settings: { ...current, agents: { ...current.agents, [agent.id]: entry } }, base: current });
    } catch (cause) {
      if (isAgentIdTaken(cause)) keep(agent.name);
      else onError?.(ipcErrorMessage(cause, `dohc could not bring back ${agent.name}.`), cause);
      return;
    }
    await order(next, `dohc brought back ${agent.name} but could not put it back in its place.`);
  })());
  return true;
}
