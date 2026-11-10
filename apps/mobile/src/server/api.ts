import { isAgentHue, type AgentHue } from "@dohc/workspace-contracts/agent-hues";
import { ServerError, type ServerClient } from "./client";

// The account routes the phone calls, each answer checked before the app uses it. An answer missing a field the
// phone reads fails as a whole, so no screen shows half of one.

export type Fields = Readonly<Record<string, unknown>>;

export const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
export const okAnswer = (value: unknown): Fields | null => isFields(value) && value.ok === true ? value : null;
export const text = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const textOrNull = (value: unknown): value is string | null => value === null || text(value);

/** Each item as `read` takes it, or null when any item fails. */
export function each<T>(value: unknown, read: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    const value = read(item);
    if (value === null) return null;
    items.push(value);
  }
  return items;
}

/** One path segment. An ID that would be empty, or would step out of its path, is never sent. */
export function segment(value: string): string {
  if (value === "" || value === "." || value === "..") throw new ServerError("invalid");
  return encodeURIComponent(value);
}

// --- who is signed in ---------------------------------------------------------------------------------------------

export interface SignedInAccount {
  readonly userId: string;
  readonly email: string;
}

/** Better Auth's session read, which answers null when the token is no longer a session. */
export function readAccount(client: ServerClient): Promise<SignedInAccount> {
  return client.send("GET", "/api/auth/get-session", body => {
    const user = isFields(body) ? body.user : null;
    if (!isFields(user) || !text(user.id, 256) || !text(user.email, 320)) return null;
    return { userId: user.id, email: user.email };
  });
}

// --- workspaces ---------------------------------------------------------------------------------------------------

export interface AccountWorkspace {
  readonly workspaceId: string;
  /** The name its owner's computer last sent, or null before one did. */
  readonly name: string | null;
  /** It has a sync identity, so the server can make a copy for the phone to read. */
  readonly canOpen: boolean;
  readonly showOnPhone: boolean;
}

/** One entry of the account's workspace list, as the server sends it and the phone saves it, or null. */
export const accountWorkspace = (item: unknown): AccountWorkspace | null =>
  isFields(item) && text(item.workspaceId, 256) && textOrNull(item.name) && typeof item.canOpen === "boolean" && typeof item.showOnPhone === "boolean"
    ? { workspaceId: item.workspaceId, name: item.name, canOpen: item.canOpen, showOnPhone: item.showOnPhone }
    : null;

export function listWorkspaces(client: ServerClient): Promise<AccountWorkspace[]> {
  return client.send("GET", "/sync/account/workspaces", body => each(okAnswer(body)?.workspaces, accountWorkspace));
}

/** Resolves the setting as the server stored it. */
export async function setShowOnPhone(client: ServerClient, workspaceId: string, showOnPhone: boolean): Promise<boolean> {
  return client.send("PATCH", `/sync/account/workspaces/${segment(workspaceId)}`, body => {
    const answer = okAnswer(body);
    return answer && typeof answer.showOnPhone === "boolean" ? answer.showOnPhone : null;
  }, { showOnPhone });
}

// --- sessions -----------------------------------------------------------------------------------------------------

export interface AccountSession {
  readonly sessionId: string;
  readonly createdAtMs: number;
  /** What the device reported when it signed in, or null when it reported nothing. */
  readonly client: string | null;
  /** The session this request was made with. */
  readonly current: boolean;
}

export function listSessions(client: ServerClient): Promise<AccountSession[]> {
  return client.send("GET", "/sync/account/sessions", body => each(okAnswer(body)?.sessions, item =>
    isFields(item) && text(item.sessionId, 128) && typeof item.createdAtMs === "number" && Number.isFinite(item.createdAtMs) &&
      textOrNull(item.client) && typeof item.current === "boolean"
      ? { sessionId: item.sessionId, createdAtMs: item.createdAtMs, client: item.client, current: item.current }
      : null));
}

export async function endSession(client: ServerClient, sessionId: string): Promise<true> {
  return client.send("POST", `/sync/account/sessions/${segment(sessionId)}/revoke`, body => okAnswer(body) ? true : null);
}

// --- personal agents ----------------------------------------------------------------------------------------------
// Only the fields personalAgents.test.ts pins: the agent's ID, name, hue, status and reach, and the roster's
// workspaces with their names.

export type PersonalAgentStatus = "active" | "signed_out" | "removed";

export interface PersonalAgent {
  readonly agentId: string;
  readonly name: string;
  readonly hue: AgentHue;
  readonly status: PersonalAgentStatus;
  /** The workspaces it can reach. */
  readonly reach: readonly string[];
}

export interface PersonalRoster {
  readonly agents: readonly PersonalAgent[];
  /** Names for the workspaces a reach can name. */
  readonly workspaceNames: ReadonlyMap<string, string | null>;
}

const isStatus = (value: unknown): value is PersonalAgentStatus => value === "active" || value === "signed_out" || value === "removed";

function readAgent(item: unknown): PersonalAgent | null {
  if (!isFields(item) || !text(item.agentId, 128) || typeof item.name !== "string" || item.name.length > 256 || !isAgentHue(item.hue) || !isStatus(item.status)) return null;
  const reach = each(item.reach, entry => isFields(entry) && text(entry.workspaceId, 256) ? entry.workspaceId : null);
  return reach && { agentId: item.agentId, name: item.name, hue: item.hue, status: item.status, reach };
}

export function listAgents(client: ServerClient): Promise<PersonalRoster> {
  return client.send("GET", "/sync/personal-agents", body => {
    const answer = okAnswer(body);
    const agents = each(answer?.agents, readAgent);
    const workspaces = each(answer?.workspaces, item =>
      isFields(item) && text(item.workspaceId, 256) && textOrNull(item.name) ? [item.workspaceId, item.name] as const : null);
    return agents && workspaces && { agents, workspaceNames: new Map(workspaces) };
  });
}

/** Signs an agent out, removes a signed-out one, or restores a removed one. Resolves its status after. */
export async function changeAgent(client: ServerClient, agentId: string, change: "sign-out" | "remove" | "restore"): Promise<PersonalAgentStatus> {
  return client.send("POST", `/sync/personal-agents/${segment(agentId)}/${change}`, body => {
    const agent = okAnswer(body)?.agent;
    return isFields(agent) && isStatus(agent.status) ? agent.status : null;
  });
}
