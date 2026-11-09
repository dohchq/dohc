import { randomBytes } from "node:crypto";
import { jsonResponse, readBoundedJson, TokenBucketLimiter } from "@dohc/service-http";
import { isAgentHue } from "@dohc/workspace-contracts/agent-hues";
import {
  CREDENTIAL_FENCE_RETRY_MS,
  type CredentialFence,
  type CredentialFenceChange,
} from "@dohc/workspace-auth/credentialFence";
import type { DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, relayError } from "./errors";
import type { SyncRelayStorage } from "./storage";
import {
  PERSONAL_AGENT_ID,
  PERSONAL_AGENT_REACH_LIMIT,
  PERSONAL_REACH_LEVELS,
  WORKSPACE_DISPLAY_NAME_LIMIT,
  type PersonalAgentChange,
  type PersonalAgentRow,
  type PersonalReachChoice,
} from "./storage/personalAgents";

// The relay's side of personal agents that isn't a table: the work they have
// running, the Postgres fence listener, and the owner's controls. Every
// revoking commit calls `endAndWake`, which ends the affected running work
// and wakes the affected logs so parked waits re-check at once.

export const PERSONAL_AGENT_ACTIONS = ["name", "hue", "reach", "sign-out", "remove", "restore"] as const;
export type PersonalAgentAction = (typeof PERSONAL_AGENT_ACTIONS)[number];
export type PersonalAgentRoute =
  | { route: "personal-agents" }
  | { route: "personal-agent"; agentId: string; action: PersonalAgentAction };

/** A password check that failed, per account, as sign-in limits them. */
export const PERSONAL_PASSWORD_ATTEMPTS = 10;
export const PERSONAL_PASSWORD_WINDOW_MS = 60_000;
/**
 * How far before the stored position catch-up reads again. A fence's time is
 * when its trigger ran, not when it committed, so a change can commit after
 * a later one has been read.
 */
export const CREDENTIAL_FENCE_CATCH_UP_MARGIN_MS = 60_000;
const MAX_OWNER_BODY_BYTES = 16 * 1024;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export function newPersonalAgentId(): string {
  // 256 is a multiple of 32, so each character is uniform.
  return `p-${[...randomBytes(26)].map(byte => BASE32[byte % 32]).join("")}`;
}

export function parsePersonalAgentRoute(parts: readonly string[]): PersonalAgentRoute {
  if (parts.length === 2) return { route: "personal-agents" };
  const action = parts[3];
  if (parts.length === 4 && PERSONAL_AGENT_ID.test(parts[2] ?? "") &&
      (PERSONAL_AGENT_ACTIONS as readonly string[]).includes(action ?? "")) {
    return { route: "personal-agent", agentId: parts[2]!, action: action as PersonalAgentAction };
  }
  throw notFound();
}

/** Running personal work: a wait, stream, or live session, opened under a connection at a fence epoch. */
export interface PersonalRunningEntry {
  agentId: string;
  ownerUserId: string;
  connectionId: string;
  fenceEpoch: number;
  workspaceIds: readonly string[];
  kind: "wait" | "stream" | "live";
  terminate(): void;
}

export interface PersonalAgents {
  /** The account's fence epoch, read by primary key. 503 while Postgres can't answer. */
  readFence(userId: string): Promise<number>;
  /** Present only when this relay can check passwords and fences, so personal sign-in can start. */
  readonly fence: CredentialFence | undefined;
  readonly passwordLimiter: TokenBucketLimiter;
  /** Adds running work. 503 until the fence listener is up and caught up. Returns its release. */
  register(entry: PersonalRunningEntry): () => void;
  /** After signing in again: ends the agent's running work and wakes these logs. */
  endAgent(agentId: string, wakeWorkspaceIds: Iterable<string>): void;
  respondToOwner(request: Request, route: PersonalAgentRoute, ownerUserId: string): Promise<Response>;
  /** At account deletion's fence, before any row is purged. */
  deleteAccount(userId: string): void;
  dispose(): Promise<void>;
}

function reachChoices(value: unknown): PersonalReachChoice[] {
  if (!Array.isArray(value) || value.length > PERSONAL_AGENT_REACH_LIMIT) throw badRequest("reach is invalid");
  return value.map((entry: unknown) => {
    const record = entry as Record<string, unknown> | null;
    if (!record || typeof record !== "object" || Object.keys(record).sort().join() !== "level,workspaceId" ||
        typeof record.workspaceId !== "string" ||
        !(PERSONAL_REACH_LEVELS as readonly unknown[]).includes(record.level)) {
      throw badRequest("reach is invalid");
    }
    return { workspaceId: record.workspaceId, level: record.level as PersonalReachChoice["level"] };
  });
}

/** Reads a personal sign-in's reach choice; null when it isn't one. */
export function parsePersonalReach(value: unknown): PersonalReachChoice[] | null {
  try {
    return reachChoices(value);
  } catch {
    return null;
  }
}

async function readOwnerBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_OWNER_BODY_BYTES, request.signal);
  } catch {
    throw badRequest("invalid request");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("invalid request");
  return body as Record<string, unknown>;
}

/** `PUT /sync/workspaces/<id>/name` from the owner's computer, so sign-in can name the workspace. */
export async function respondToWorkspaceName(
  storage: Pick<SyncRelayStorage, "setWorkspaceDisplayName">,
  request: Request,
  workspaceId: string,
  ownerUserId: string,
): Promise<Response> {
  if (request.method !== "PUT") throw relayError("method_not_allowed");
  const body = await readOwnerBody(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const characters = [...name].length;
  if (Object.keys(body).join() !== "name" || characters === 0 || characters > WORKSPACE_DISPLAY_NAME_LIMIT ||
      !name.isWellFormed() || CONTROL_CHARS.test(name)) {
    throw badRequest("name is invalid");
  }
  if (!storage.setWorkspaceDisplayName({ workspaceId, ownerUserId, name })) throw notFound();
  return jsonResponse({ ok: true });
}

function toAgent(agent: PersonalAgentRow) {
  return {
    agentId: agent.agentId,
    name: agent.name,
    hue: agent.hue,
    reportedProduct: agent.reportedProduct,
    status: agent.status,
    createdAtMs: agent.createdAtMs,
    lastActionAtMs: agent.lastActionAtMs,
    reach: agent.reach.map(entry => ({ workspaceId: entry.workspaceId, level: entry.level })),
  };
}

export function createPersonalAgents(input: {
  storage: Pick<SyncRelayStorage,
    | "listPersonalAgents" | "changePersonalAgent" | "revokePersonalCredentialsBelowFence"
    | "signOutAccountPersonalAgents" | "readCredentialFencePosition" | "advanceCredentialFencePosition">;
  fence: CredentialFence | undefined;
  activity: Pick<DiscussionActivityHub, "wakeLog">;
  nowMs: () => number;
}): PersonalAgents {
  const { storage, fence, activity } = input;
  const running = new Set<PersonalRunningEntry>();
  const passwordLimiter = new TokenBucketLimiter(
    PERSONAL_PASSWORD_ATTEMPTS, PERSONAL_PASSWORD_ATTEMPTS * 1_000 / PERSONAL_PASSWORD_WINDOW_MS, 100_000);
  // Running work starts only while the listener is up and has caught up, so
  // no fence change can pass unseen while it runs.
  let ready = false;
  let generation = 0;
  let disposed = false;
  let closing: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const endAndWake = (affected: (entry: PersonalRunningEntry) => boolean, wake: Iterable<string>): void => {
    const workspaces = new Set(wake);
    for (const entry of [...running]) {
      if (!affected(entry)) continue;
      running.delete(entry);
      for (const workspaceId of entry.workspaceIds) workspaces.add(workspaceId);
      entry.terminate();
    }
    for (const workspaceId of workspaces) activity.wakeLog(workspaceId);
  };

  // Credentials and running work from before the account's fence end; those at it or after stay.
  const applyFence = (change: CredentialFenceChange): void => {
    const revoked = storage.revokePersonalCredentialsBelowFence(change.userId, change.epoch);
    endAndWake(entry => entry.ownerUserId === change.userId && entry.fenceEpoch < change.epoch, revoked);
  };

  const catchUp = async (atGeneration: number): Promise<void> => {
    retry = undefined;
    try {
      const position = storage.readCredentialFencePosition();
      const changes = await fence!.changedSince(Math.max(0, position - CREDENTIAL_FENCE_CATCH_UP_MARGIN_MS));
      if (disposed || atGeneration !== generation) return;
      let latest = position;
      for (const change of changes) {
        applyFence(change);
        latest = Math.max(latest, change.changedAtMs);
      }
      storage.advanceCredentialFencePosition(latest);
      ready = true;
    } catch {
      if (!disposed && atGeneration === generation) retry = setTimeout(() => void catchUp(atGeneration), CREDENTIAL_FENCE_RETRY_MS);
    }
  };

  const listener = fence?.listen({
    onChange(change) {
      applyFence(change);
      if (ready) storage.advanceCredentialFencePosition(change.changedAtMs);
    },
    onDown() {
      generation++;
      ready = false;
      clearTimeout(retry);
      endAndWake(() => true, []);
    },
    onUp() {
      generation++;
      clearTimeout(retry);
      void catchUp(generation);
    },
  });

  const unavailable = () => relayError("personal_agent_unavailable");

  async function changeFor(request: Request, action: PersonalAgentAction): Promise<PersonalAgentChange> {
    if (action === "sign-out" || action === "remove" || action === "restore") {
      if (request.method !== "POST") throw relayError("method_not_allowed");
      return { kind: action };
    }
    if (request.method !== "PUT") throw relayError("method_not_allowed");
    const body = await readOwnerBody(request);
    if (Object.keys(body).join() !== action) throw badRequest("invalid request");
    if (action === "reach") return { kind: "reach", reach: reachChoices(body.reach) };
    if (action === "hue") {
      if (!isAgentHue(body.hue)) throw badRequest("hue is invalid");
      return { kind: "hue", hue: body.hue };
    }
    if (typeof body.name !== "string") throw badRequest("name is invalid");
    return { kind: "name", name: body.name };
  }

  return {
    fence,
    passwordLimiter,

    async readFence(userId) {
      if (!fence) throw unavailable();
      try {
        return await fence.readEpoch(userId);
      } catch {
        throw unavailable();
      }
    },

    register(entry) {
      if (!ready) throw unavailable();
      running.add(entry);
      return () => {
        running.delete(entry);
      };
    },

    endAgent(agentId, wakeWorkspaceIds) {
      endAndWake(entry => entry.agentId === agentId, wakeWorkspaceIds);
    },

    async respondToOwner(request, route, ownerUserId) {
      if (route.route === "personal-agents") {
        if (request.method !== "GET") throw relayError("method_not_allowed");
        const roster = storage.listPersonalAgents(ownerUserId);
        return jsonResponse({
          ok: true,
          revision: roster.revision,
          agents: roster.agents.map(toAgent),
          workspaces: roster.workspaces,
        });
      }
      const change = await changeFor(request, route.action);
      const result = storage.changePersonalAgent({ ownerUserId, agentId: route.agentId, change });
      if (!result.ok) {
        if (result.reason === "conflict") throw relayError("conflict");
        if (result.reason === "invalid") throw badRequest(`${route.action} is invalid`);
        throw notFound();
      }
      const ended = new Set(result.endedWorkspaceIds);
      const credentialsEnded = change.kind === "sign-out" || change.kind === "remove";
      endAndWake(
        entry => entry.agentId === route.agentId && (credentialsEnded || entry.workspaceIds.some(id => ended.has(id))),
        result.wakeWorkspaceIds,
      );
      return jsonResponse({ ok: true, revision: result.revision, agent: toAgent(result.agent) });
    },

    deleteAccount(userId) {
      const reach = storage.signOutAccountPersonalAgents(userId);
      endAndWake(entry => entry.ownerUserId === userId, reach);
    },

    dispose() {
      disposed = true;
      ready = false;
      clearTimeout(retry);
      closing ??= listener?.close() ?? Promise.resolve();
      return closing;
    },
  };
}
