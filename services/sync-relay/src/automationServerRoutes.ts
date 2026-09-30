import { jsonResponse, readBoundedJson, type TokenBucketLimiter } from "@dohc/service-http";
import type {
  CollectionAutomationHold,
  CollectionAutomationRetry,
  CollectionAutomationRun,
  CollectionAutomationUndo,
} from "@dohc/automation-executor/collection-automations";
import { isNoticeLine } from "@dohc/workspace-contracts/relay";
import type { DatasetUndoConfirmed } from "@dohc/automation-executor/dataset-automation-undo";
import { badRequest, notFound, relayError } from "./errors";
import { relayPathSegments } from "./requestInputs";
import type { SyncRelayStorage } from "./storage";

// The owner's view of the automations this server runs in one workspace:
// its runs, Try again, Undo, Stop and restore, and the steps it holds for
// Allow. The server keeps its runs where they ran (ADR 0008), and nobody can
// open the server's own panel, so the owner's computers show them through
// these routes. Every route acts for the workspace owner only: it checks
// ownership before it reads the body, and the server checks it again against
// its copy before it acts.

// A Stop and restore names the definitions one person wrote.
export const AUTOMATION_SERVER_MAX_BODY_BYTES = 256 * 1024;
const MAX_RESTORE_DEFINITIONS = 2_000;
const AUTOMATION_ID_MAX_CHARS = 4_096;

const ACTIONS = ["runs", "retry", "undo", "restore", "holds", "allow"] as const;

export type AutomationServerRoute = {
  route: "automation-server";
  workspaceId: string;
  action: (typeof ACTIONS)[number];
};

/** Whether a path is one of these routes, read the way the router reads it. */
export function isAutomationServerPath(path: string | readonly string[]): boolean {
  let parts: readonly string[];
  try {
    parts = typeof path === "string" ? relayPathSegments(path) : path;
  } catch {
    return false;
  }
  return parts.length === 4 && parts[0] === "sync" && parts[1] !== "shares" && parts[1] !== "notices" &&
    parts[2] === "automation-server";
}

export function parseAutomationServerAction(value: string | undefined): AutomationServerRoute["action"] | null {
  return ACTIONS.find((action) => action === value) ?? null;
}

/** One workspace, and the owner the relay authenticated. */
export interface OwnerScope {
  workspaceId: string;
  ownerUserId: string;
}

/** What the server answers its owner. Each throws notFound when it has no open copy of the workspace for that owner. */
export interface ServerRuns {
  list(scope: OwnerScope, automationId: string, before?: string): Promise<{ runs: CollectionAutomationRun[]; next: string | null }>;
  get(scope: OwnerScope, automationId: string, claimId: string): Promise<CollectionAutomationRun | null>;
  retry(scope: OwnerScope, input: { automationId: string; claimId: string; startOver: boolean }): Promise<CollectionAutomationRetry>;
  undo(scope: OwnerScope, input: { automationId: string; claimId: string; deletes: DatasetUndoConfirmed | null }): Promise<CollectionAutomationUndo>;
  /** Stop and restore's pass over the runs of these definitions; see CollectionAutomations.undoRunsOf. */
  restore(
    scope: OwnerScope,
    definitions: ReadonlyArray<{ collectionPath: string; id: string; definitionHash: string }>,
    again: boolean,
  ): Promise<{ undone: number; left: number; reverted: number; missing: number; keptFields: string[]; otherKept: number; errorMessage: string | null }>;
  holds(scope: OwnerScope): CollectionAutomationHold[];
  allow(scope: OwnerScope, input: { automationId: string; definitionHash: string; step: string; seq: number; recipient?: string }): Promise<"confirmed" | "changed">;
}

export function createAutomationServerRoutes(
  storage: Pick<SyncRelayStorage, "workspaceIsOwnedBy">,
  /** This server's runs, or undefined while it runs no automations. */
  runs: () => ServerRuns | undefined,
  nowMs: () => number,
  /** The owner's budget for changes to the automations this server runs, shared with the host routes. */
  changeRateLimiter: TokenBucketLimiter,
) {
  return async function respondToAutomationServer(
    request: Request,
    route: AutomationServerRoute,
    ownerUserId: string,
  ): Promise<Response> {
    const server = runs();
    if (!server || !storage.workspaceIsOwnedBy(route.workspaceId, ownerUserId)) throw notFound();
    const scope = { workspaceId: route.workspaceId, ownerUserId };
    if (route.action === "runs" || route.action === "holds") {
      if (request.method !== "GET") throw relayError("method_not_allowed");
      if (route.action === "holds") return jsonResponse({ ok: true, holds: server.holds(scope) }, 200);
      const query = new URL(request.url).searchParams;
      const automationId = collectionAutomationId(query.get("automationId"));
      const claimId = query.get("claimId");
      if (claimId !== null) return jsonResponse({ ok: true, run: await server.get(scope, automationId, line(claimId, 256, "claimId")) }, 200);
      const before = query.get("before");
      return jsonResponse({ ok: true, ...await server.list(scope, automationId, before === null ? undefined : line(before, 512, "before")) }, 200);
    }
    if (request.method !== "POST") throw relayError("method_not_allowed");
    if (!changeRateLimiter.allow(ownerUserId, nowMs())) throw relayError("automation_host_rate_limited");
    const body = await readBody(request);
    switch (route.action) {
      case "retry": {
        if (typeof body.startOver !== "boolean") throw badRequest("startOver must be true or false");
        const retried = await server.retry(scope, { ...claimOf(body), startOver: body.startOver });
        return jsonResponse({ ok: true, ...retried }, 200);
      }
      case "undo": {
        return jsonResponse({ ok: true, ...(await server.undo(scope, { ...claimOf(body), deletes: deletesOf(body.deletes) })) }, 200);
      }
      case "restore":
        if (typeof body.again !== "boolean") throw badRequest("again must be true or false");
        return jsonResponse({ ok: true, ...(await server.restore(scope, definitionsOf(body.definitions), body.again)) }, 200);
      case "allow": {
        const recipient = body.recipient === undefined ? undefined : line(body.recipient, 1_024, "recipient");
        const status = await server.allow(scope, {
          automationId: collectionAutomationId(body.automationId),
          definitionHash: definitionHash(body.definitionHash),
          step: line(body.step, 512, "step"),
          seq: nonNegativeInteger(body.seq, "seq"),
          ...(recipient === undefined ? {} : { recipient }),
        });
        return jsonResponse({ ok: true, status }, 200);
      }
    }
  };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await readBoundedJson(request, AUTOMATION_SERVER_MAX_BODY_BYTES, request.signal);
  } catch (error) {
    if (error instanceof RangeError) throw relayError("payload_too_large");
    throw badRequest("request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("request body must be a JSON object");
  return value as Record<string, unknown>;
}

function claimOf(body: Record<string, unknown>): { automationId: string; claimId: string } {
  return { automationId: collectionAutomationId(body.automationId), claimId: line(body.claimId, 256, "claimId") };
}

function deletesOf(value: unknown): DatasetUndoConfirmed | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("deletes is invalid");
  const { token, chosen } = value as Record<string, unknown>;
  if (!Array.isArray(chosen) || chosen.length > 64) throw badRequest("chosen is invalid");
  return { token: line(token, 128, "token"), chosen: chosen.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw badRequest("chosen is invalid");
    const { key, operationId } = entry as Record<string, unknown>;
    return { key: line(key, 16_384, "key"), operationId: line(operationId, 256, "operationId") };
  }) };
}

function definitionsOf(value: unknown): Array<{ collectionPath: string; id: string; definitionHash: string }> {
  if (!Array.isArray(value) || value.length > MAX_RESTORE_DEFINITIONS) throw badRequest("definitions must be a list");
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw badRequest("definitions must be a list");
    const { collectionPath, id, definitionHash: hash } = entry as Record<string, unknown>;
    return { collectionPath: line(collectionPath, 4_096, "collectionPath"), id: line(id, 256, "id"), definitionHash: definitionHash(hash) };
  });
}

// Only a Collection's automations run on the server.
function collectionAutomationId(value: unknown): string {
  const id = line(value, AUTOMATION_ID_MAX_CHARS, "automationId");
  if (!id.startsWith("collection:")) throw badRequest("automationId is invalid");
  return id;
}

function definitionHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{16}$/.test(value)) throw badRequest("definitionHash is invalid");
  return value;
}

function line(value: unknown, maxChars: number, name: string): string {
  if (!isNoticeLine(value, maxChars)) throw badRequest(`${name} is invalid`);
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw badRequest(`${name} must be a non-negative integer`);
  }
  return value;
}
