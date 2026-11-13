import { randomBytes } from "node:crypto";
import { jsonResponse, readBoundedJson } from "@dohc/service-http";
import { isAgentHue } from "@dohc/workspace-contracts/agent-hues";
import {
  CREDENTIAL_FENCE_READ_TIMEOUT_MS,
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
  /** Work that needs Edit also ends when its workspace drops a level. */
  needs?: "edit";
  terminate(): void;
}

export interface PersonalAgents {
  /**
   * The account's fence epoch, from a read by primary key that began after
   * this call. Reads for one account are single-flight. 503 while Postgres
   * can't answer.
   */
  readFence(userId: string): Promise<number>;
  /** Present only when this relay can read fences and sessions, so personal sign-in can start. */
  readonly fence: CredentialFence | undefined;
  /** Adds running work. 503 until the fence listener is up and caught up. Returns its release. */
  register(entry: PersonalRunningEntry): () => void;
  /** After signing in again: ends the agent's running work and wakes these logs. */
  endAgent(agentId: string, wakeWorkspaceIds: Iterable<string>): void;
  endConnection(connectionId: string): void;
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

/**
 * Reads one account's fence one at a time. A read answers only callers that
 * asked before it began, so every answer was read after its call: a caller
 * that asks while a read runs waits for the next, which begins once that one
 * settles and answers everyone who asked meanwhile. A read still running
 * after `CREDENTIAL_FENCE_READ_TIMEOUT_MS`, waiting for a connection included,
 * fails with `timedOut()`.
 */
export function singleFlightFenceReads(read: (userId: string) => Promise<number>, timedOut: () => Error): (userId: string) => Promise<number> {
  const running = new Map<string, { settled: Promise<void>; next?: Promise<number> }>();
  const begin = (userId: string): Promise<number> => {
    // A read Postgres doesn't answer in time fails, so callers waiting for the next read aren't held behind it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const epoch = Promise.race([read(userId), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timedOut()), CREDENTIAL_FENCE_READ_TIMEOUT_MS); })])
      .finally(() => clearTimeout(timer));
    const flight: { settled: Promise<void>; next?: Promise<number> } = { settled: epoch.then(() => undefined, () => undefined) };
    running.set(userId, flight);
    void flight.settled.then(() => {
      if (running.get(userId) === flight && flight.next === undefined) running.delete(userId);
    });
    return epoch;
  };
  return userId => {
    const flight = running.get(userId);
    if (!flight) return begin(userId);
    return flight.next ??= flight.settled.then(() => begin(userId));
  };
}

function toAgent(agent: PersonalAgentRow) {
  return {
    agentId: agent.agentId,
    name: agent.name,
    hue: agent.hue,
    reportedProduct: agent.reportedProduct,
    reportedVersion: agent.reportedVersion,
    status: agent.status,
    createdAtMs: agent.createdAtMs,
    signedInAtMs: agent.signedInAtMs,
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
  /** An account's fence changed, which ends its sign-ins from before it. */
  onFence(userId: string): void;
}): PersonalAgents {
  const { storage, fence, activity } = input;
  const running = new Set<PersonalRunningEntry>();
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
    input.onFence(change.userId);
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
  const readFence = singleFlightFenceReads(async userId => {
    if (!fence) throw unavailable();
    try {
      return await fence.readEpoch(userId);
    } catch {
      throw unavailable();
    }
  }, unavailable);

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

    readFence,

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

    endConnection(connectionId) {
      endAndWake(entry => entry.connectionId === connectionId, []);
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
      const result = storage.changePersonalAgent({ ownerUserId, agentId: route.agentId, change, nowMs: input.nowMs() });
      if (!result.ok) {
        if (result.reason === "conflict") throw relayError("conflict");
        if (result.reason === "invalid") throw badRequest(`${route.action} is invalid`);
        throw notFound();
      }
      const ended = new Set(result.endedWorkspaceIds), lowered = new Set(result.loweredWorkspaceIds);
      const credentialsEnded = change.kind === "sign-out" || change.kind === "remove";
      endAndWake(
        entry => entry.agentId === route.agentId && (credentialsEnded ||
          entry.workspaceIds.some(id => ended.has(id) || (entry.needs === "edit" && lowered.has(id)))),
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
