import { isAgentHue, type AgentHue } from "@dohc/workspace-contracts/agent-hues";
import { ServerError, type ServerClient } from "./client";

// The account routes the phone calls, each answer checked before the app uses it. An answer missing a field the
// phone reads fails as a whole, so no screen shows half of one.

export type Fields = Readonly<Record<string, unknown>>;

export const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const okAnswer = (value: unknown): Fields | null =>
  isFields(value) && value.ok === true ? value : null;
export const text = (value: unknown, max = 4096): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
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

/** One workspace's account operations, each result checked by its `read`. A request ends when its signal aborts. */
export function accountOperations(client: ServerClient, workspaceId: string, signal: AbortSignal) {
  const run = <T>(name: string, args: object, read: (result: unknown) => T | null, own = signal) =>
    client.send(
      "POST",
      `/sync/${segment(workspaceId)}/ops/${name}`,
      (body) => {
        const answer = okAnswer(body);
        return answer ? read(answer.result) : null;
      },
      args,
      { signal: own },
    );
  return {
    run,
    // Every item of a list read a page at a time, each page listing them under the operation's name. A cursor seen
    // before, or more than `pages` pages, fails the read.
    async all<T>(
      name: string,
      pages: number,
      item: (value: unknown) => T | null,
      isCursor: (value: unknown) => value is string,
    ): Promise<T[]> {
      const items: T[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < pages; page++) {
        const answer: { items: T[]; next: string | null } = await run(
          name,
          cursor === null ? {} : { cursor },
          (result) => {
            const listed = isFields(result) ? each(result[name], item) : null;
            const next = isFields(result) ? result.nextCursor : undefined;
            return listed && (next === null || isCursor(next)) ? { items: listed, next } : null;
          },
        );
        items.push(...answer.items);
        if (answer.next === null) return items;
        if (seen.has(answer.next)) break;
        seen.add(answer.next);
        cursor = answer.next;
      }
      throw new ServerError("invalid");
    },
  };
}

export interface SignedInAccount {
  readonly userId: string;
  readonly email: string;
  /** The account's name, or null when the server sends none. */
  readonly name: string | null;
}

/** Better Auth's session read, which answers null when the token is no longer a session. */
export function readAccount(client: ServerClient): Promise<SignedInAccount> {
  return client.send("GET", "/api/auth/get-session", (body) => {
    const user = isFields(body) ? body.user : null;
    if (!isFields(user) || !text(user.id, 256) || !text(user.email, 320)) return null;
    return {
      userId: user.id,
      email: user.email,
      name: typeof user.name === "string" ? user.name : null,
    };
  });
}

export interface AccountWorkspace {
  readonly workspaceId: string;
  /** The name its owner's computer last sent, or null before one did. */
  readonly name: string | null;
  /** It has a sync identity, so the server can make a copy for the phone to read. */
  readonly canOpen: boolean;
  readonly showOnPhone: boolean;
  /** The account's role: it owns the workspace, or joined it as an Admin or a Member, which the phone only reads. */
  readonly role: WorkspaceRole;
}

export type WorkspaceRole = "owner" | "admin" | "member";
const isRole = (value: unknown): value is WorkspaceRole =>
  value === "owner" || value === "admin" || value === "member";

export function selectOpenWorkspace(
  workspaces: readonly AccountWorkspace[],
  chosen: string | null,
): AccountWorkspace | null {
  const openable = workspaces.filter((entry) => entry.showOnPhone && entry.canOpen);
  return openable.find((entry) => entry.workspaceId === chosen) ?? openable[0] ?? null;
}

/** One entry of the account's workspace list, as the server sends it and the phone saves it, or null. */
export const accountWorkspace = (item: unknown): AccountWorkspace | null =>
  isFields(item) &&
  text(item.workspaceId, 256) &&
  textOrNull(item.name) &&
  typeof item.canOpen === "boolean" &&
  typeof item.showOnPhone === "boolean" &&
  isRole(item.role)
    ? {
        workspaceId: item.workspaceId,
        name: item.name,
        canOpen: item.canOpen,
        showOnPhone: item.showOnPhone,
        role: item.role,
      }
    : null;

export function listWorkspaces(client: ServerClient): Promise<AccountWorkspace[]> {
  return client.send("GET", "/sync/account/workspaces", (body) =>
    each(okAnswer(body)?.workspaces, accountWorkspace),
  );
}

/** Resolves the setting as the server stored it. */
export async function setShowOnPhone(
  client: ServerClient,
  workspaceId: string,
  showOnPhone: boolean,
): Promise<boolean> {
  return client.send(
    "PATCH",
    `/sync/account/workspaces/${segment(workspaceId)}`,
    (body) => {
      const answer = okAnswer(body);
      return answer && typeof answer.showOnPhone === "boolean" ? answer.showOnPhone : null;
    },
    { showOnPhone },
  );
}

export interface AccountSession {
  readonly sessionId: string;
  readonly createdAtMs: number;
  /** What the device reported when it signed in, or null when it reported nothing. */
  readonly client: string | null;
  /** The session this request was made with. */
  readonly current: boolean;
}

export function listSessions(client: ServerClient): Promise<AccountSession[]> {
  return client.send("GET", "/sync/account/sessions", (body) =>
    each(okAnswer(body)?.sessions, (item) =>
      isFields(item) &&
      text(item.sessionId, 128) &&
      typeof item.createdAtMs === "number" &&
      Number.isFinite(item.createdAtMs) &&
      textOrNull(item.client) &&
      typeof item.current === "boolean"
        ? {
            sessionId: item.sessionId,
            createdAtMs: item.createdAtMs,
            client: item.client,
            current: item.current,
          }
        : null,
    ),
  );
}

export async function endSession(client: ServerClient, sessionId: string): Promise<true> {
  return client.send("POST", `/sync/account/sessions/${segment(sessionId)}/revoke`, (body) =>
    okAnswer(body) ? true : null,
  );
}

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

const isStatus = (value: unknown): value is PersonalAgentStatus =>
  value === "active" || value === "signed_out" || value === "removed";

function readAgent(item: unknown): PersonalAgent | null {
  if (
    !isFields(item) ||
    !text(item.agentId, 128) ||
    typeof item.name !== "string" ||
    item.name.length > 256 ||
    !isAgentHue(item.hue) ||
    !isStatus(item.status)
  )
    return null;
  const reach = each(item.reach, (entry) =>
    isFields(entry) && text(entry.workspaceId, 256) ? entry.workspaceId : null,
  );
  return (
    reach && { agentId: item.agentId, name: item.name, hue: item.hue, status: item.status, reach }
  );
}

export function listAgents(client: ServerClient): Promise<PersonalRoster> {
  return client.send("GET", "/sync/personal-agents", (body) => {
    const answer = okAnswer(body);
    const agents = each(answer?.agents, readAgent);
    const workspaces = each(answer?.workspaces, (item) =>
      isFields(item) && text(item.workspaceId, 256) && textOrNull(item.name)
        ? ([item.workspaceId, item.name] as const)
        : null,
    );
    return agents && workspaces && { agents, workspaceNames: new Map(workspaces) };
  });
}

/** Signs an agent out, removes a signed-out one, or restores a removed one. Resolves its status after. */
export async function changeAgent(
  client: ServerClient,
  agentId: string,
  change: "sign-out" | "remove" | "restore",
): Promise<PersonalAgentStatus> {
  return client.send("POST", `/sync/personal-agents/${segment(agentId)}/${change}`, (body) => {
    const agent = okAnswer(body)?.agent;
    return isFields(agent) && isStatus(agent.status) ? agent.status : null;
  });
}
