import { jsonResponse, readBoundedJson, TokenBucketLimiter } from "@dohc/service-http";
import {
  AUTOMATION_DEFINITION_HASH_PATTERN,
  AUTOMATION_INSTALL_ID_MAX_CHARS,
  AUTOMATION_PRESS_ERROR_MAX_CHARS,
  AUTOMATION_PRESS_ID_MAX_CHARS,
  AUTOMATION_PRESS_MAX_BODY_BYTES,
  isNoticeLine,
  type AutomationPressOutcome,
  type RelayAutomationPressList,
} from "@dohc/workspace-contracts/relay";
import { namedCollectionEditGrant } from "./collectionEditGrant";
import type { DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, relayError } from "./errors";
import { relayPathSegments } from "./requestInputs";
import type { SyncRelayStorage } from "./storage";
import { AUTOMATION_PRESS_LIST_LIMIT, AUTOMATION_PRESS_PRUNE_BATCH } from "./storage/automationPresses";

// Button presses from shared views (ADR 0012). A recipient with a named Edit
// grant on a Collection's folder posts a press; the workspace's automation
// host lists it, accepts it into its engine as the verified user's press,
// and settles it when the run ends.

export type AutomationPressRoute =
  | { route: "share-automation-presses"; shareId: string }
  | { route: "automation-presses"; workspaceId: string; action: "list" | "accept" | "settle" };

// A burst of 20 presses per grant, then one every three seconds: people
// press buttons by hand.
const PRESS_BUCKET_CAPACITY = 20;
const PRESS_REFILL_PER_SECOND = 1 / 3;
const PRESS_MAX_GRANTS = 10_000;
// The host's accepts and settles, per owner: two per press at most.
const HOST_BUCKET_CAPACITY = 120;
const HOST_REFILL_PER_SECOND = 2;
const HOST_MAX_OWNERS = 10_000;
// How long a list with nothing for the host may wait for a press.
export const AUTOMATION_PRESS_MAX_WAIT_MS = 25_000;
const MAX_RECORD_ID_CHARS = 1024;
const MAX_AUTOMATION_ID_CHARS = 4096;
const OUTCOMES: readonly AutomationPressOutcome[] = ["done", "skipped", "failed", "ended", "busy"];

/**
 * Removes every press past retention, one bounded batch at a time, letting
 * other work run between batches. Answers how many went.
 */
export async function pruneAutomationPresses(
  storage: Pick<SyncRelayStorage, "pruneExpiredAutomationPresses">,
  nowMs: number,
  pause: () => Promise<void> = () => new Promise((resolve) => setImmediate(resolve)),
): Promise<number> {
  let removed = 0;
  for (;;) {
    const batch = storage.pruneExpiredAutomationPresses(nowMs);
    removed += batch;
    if (batch < AUTOMATION_PRESS_PRUNE_BATCH) return removed;
    await pause();
  }
}

export function createAutomationPressRateLimiters() {
  return {
    press: new TokenBucketLimiter(PRESS_BUCKET_CAPACITY, PRESS_REFILL_PER_SECOND, PRESS_MAX_GRANTS),
    host: new TokenBucketLimiter(HOST_BUCKET_CAPACITY, HOST_REFILL_PER_SECOND, HOST_MAX_OWNERS),
  };
}

/** Whether a path is one of these routes, read the way the router reads it, so the small body limit covers every spelling. */
export function isAutomationPressPath(path: string): boolean {
  let parts: readonly string[];
  try {
    parts = relayPathSegments(path);
  } catch {
    return false;
  }
  if (parts[0] !== "sync") return false;
  if (parts[1] === "shares") return parts.length === 4 && parts[3] === "automation-presses";
  return parts[1] !== "notices" && parts[2] === "automation-presses" && parts.length >= 3 && parts.length <= 4;
}

export function parseAutomationPressAction(value: string | undefined): "list" | "accept" | "settle" | null {
  if (value === undefined) return "list";
  return value === "accept" || value === "settle" ? value : null;
}

export function createAutomationPressRoutes(input: {
  storage: Pick<
    SyncRelayStorage,
    | "findChannelCreateKind" | "getShare" | "getShareGrant" | "listActiveShareGrantsForRecipient" | "workspaceIsOwnedBy"
    | "recordAutomationPress" | "listAutomationPresses" | "automationPressWait" | "acceptAutomationPresses" | "settleAutomationPress"
  >;
  nowMs: () => number;
  newId: () => string;
  claimPendingShares: (userId: string) => Promise<void>;
  activity: Pick<DiscussionActivityHub, "wake" | "wait">;
  rateLimiters: ReturnType<typeof createAutomationPressRateLimiters>;
}) {
  const { storage, nowMs, activity, rateLimiters } = input;
  const topic = (workspaceId: string) => `automation-presses:${workspaceId}`;

  /** `POST /sync/shares/:shareId/automation-presses`: a recipient presses a shared Collection's button. */
  async function respondToSharePress(request: Request, shareId: string, actorUserId: string): Promise<Response> {
    if (request.method !== "POST") throw relayError("method_not_allowed");
    await input.claimPendingShares(actorUserId);
    const { share, grant } = namedCollectionEditGrant(storage, shareId, actorUserId);
    // Every admitted request spends a token before its body is read.
    if (!rateLimiters.press.allow(grant.grantId, nowMs())) throw relayError("automation_press_rate_limited");
    const body = await readBody(request);
    // Exactly these keys: who pressed comes from the session, never the body.
    if (Object.keys(body).some((key) => !["pressId", "automationId", "definitionHash", "recordId"].includes(key))) {
      throw badRequest("a press names only pressId, automationId, definitionHash, and recordId");
    }
    const definitionHash = body.definitionHash;
    if (typeof definitionHash !== "string" || !AUTOMATION_DEFINITION_HASH_PATTERN.test(definitionHash)) throw badRequest("definitionHash is invalid");
    const pressed = storage.recordAutomationPress({
      shareId: share.shareId,
      grantId: grant.grantId,
      grantGeneration: grant.generation,
      userId: actorUserId,
      pressId: line(body.pressId, "pressId", AUTOMATION_PRESS_ID_MAX_CHARS),
      automationId: line(body.automationId, "automationId", MAX_AUTOMATION_ID_CHARS),
      definitionHash,
      recordId: line(body.recordId, "recordId", MAX_RECORD_ID_CHARS),
      nowMs: nowMs(),
      newId: input.newId,
    });
    if (pressed.state === "pending") activity.wake(topic(share.workspaceId));
    return jsonResponse({ ok: true, ...pressed });
  }

  /** The owner's routes under `/sync/:workspaceId/automation-presses`. Ownership is checked before the body is read, and again in each transaction. */
  async function respondToHost(
    request: Request,
    route: Extract<AutomationPressRoute, { route: "automation-presses" }>,
    ownerUserId: string,
  ): Promise<Response> {
    const { workspaceId } = route;
    if (!storage.workspaceIsOwnedBy(workspaceId, ownerUserId)) throw notFound();
    if (route.action === "list") {
      if (request.method !== "GET") throw relayError("method_not_allowed");
      const url = new URL(request.url);
      const installId = line(url.searchParams.get("installId"), "installId", AUTOMATION_INSTALL_ID_MAX_CHARS);
      const waitMs = Math.min(waitParameter(url.searchParams.get("waitMs")), AUTOMATION_PRESS_MAX_WAIT_MS);
      const scope = { workspaceId, ownerUserId, installId };
      // Only the running host waits; any other computer hears at once that there is nothing for it.
      if (waitMs > 0 && storage.automationPressWait({ ...scope, nowMs: nowMs() }) === "empty") {
        await activity.wait(topic(workspaceId), `user:${ownerUserId}`, {
          holdMs: waitMs,
          signal: request.signal,
          shouldPark: () => storage.automationPressWait({ ...scope, nowMs: nowMs() }) === "empty",
        });
      }
      const answer: RelayAutomationPressList = { presses: storage.listAutomationPresses({ ...scope, nowMs: nowMs() }) };
      return jsonResponse({ ok: true, ...answer });
    }
    if (request.method !== "POST") throw relayError("method_not_allowed");
    if (!rateLimiters.host.allow(ownerUserId, nowMs())) throw relayError("automation_press_rate_limited");
    const body = await readBody(request);
    const installId = line(body.installId, "installId", AUTOMATION_INSTALL_ID_MAX_CHARS);
    if (route.action === "accept") {
      const ids = body.hostPressIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > AUTOMATION_PRESS_LIST_LIMIT) {
        throw badRequest(`hostPressIds must list 1 to ${AUTOMATION_PRESS_LIST_LIMIT} presses`);
      }
      const hostPressIds = ids.map((id) => line(id, "hostPressIds", AUTOMATION_PRESS_ID_MAX_CHARS));
      const generation = body.generation;
      if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) throw badRequest("generation is invalid");
      const accepted = storage.acceptAutomationPresses({ workspaceId, ownerUserId, installId, generation, hostPressIds, nowMs: nowMs() });
      return jsonResponse({ ok: true, accepted });
    }
    const outcome = body.outcome;
    if (typeof outcome !== "string" || !OUTCOMES.includes(outcome as AutomationPressOutcome)) throw badRequest("outcome is invalid");
    const error = body.error === null ? null : errorText(body.error);
    const settled = storage.settleAutomationPress({
      workspaceId, ownerUserId,
      hostPressId: line(body.hostPressId, "hostPressId", AUTOMATION_PRESS_ID_MAX_CHARS),
      outcome: outcome as AutomationPressOutcome,
      error,
      nowMs: nowMs(),
    });
    return jsonResponse({ ok: true, ...settled });
  }

  return { respondToSharePress, respondToHost };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await readBoundedJson(request, AUTOMATION_PRESS_MAX_BODY_BYTES, request.signal);
  } catch (error) {
    if (error instanceof RangeError) throw relayError("payload_too_large");
    throw badRequest("request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("request body must be a JSON object");
  return value as Record<string, unknown>;
}

function line(value: unknown, name: string, max: number): string {
  if (!isNoticeLine(value, max)) throw badRequest(`${name} is invalid`);
  return value;
}

function errorText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > AUTOMATION_PRESS_ERROR_MAX_CHARS) throw badRequest("error is invalid");
  return value;
}

function waitParameter(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  if (!/^(0|[1-9][0-9]{0,5})$/u.test(value) || !Number.isSafeInteger(parsed)) throw badRequest("waitMs must be a whole number of milliseconds");
  return parsed;
}
