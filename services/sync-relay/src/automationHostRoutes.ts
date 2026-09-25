import { jsonResponse, readBoundedJson, type TokenBucketLimiter } from "@dohc/service-http";
import {
  AUTOMATION_COMPUTER_LABEL_MAX_CHARS,
  AUTOMATION_HOST_MAX_BODY_BYTES,
  AUTOMATION_INSTALL_ID_MAX_CHARS,
  isNoticeLine,
} from "@dohc/workspace-contracts/relay";
import { badRequest, notFound, relayError } from "./errors";
import { relayPathSegments } from "./requestInputs";
import type { SyncRelayStorage } from "./storage";

// Changes to the host, per owner: a burst of 60, then one a second. An
// owner's computers check in when they open, on reconnect, and about once a
// minute before a run.
export const AUTOMATION_HOST_BUCKET_CAPACITY = 60;
export const AUTOMATION_HOST_REFILL_PER_SECOND = 1;
export const AUTOMATION_HOST_MAX_OWNERS = 10_000;

// Whether a path is one of these routes, read the way the router reads it,
// so the relay's small body limit covers every spelling the router accepts.
// The router takes a workspace id here unless the second segment names the
// share or notice namespace.
export function isAutomationHostPath(path: string | readonly string[]): boolean {
  let parts: readonly string[];
  try {
    parts = typeof path === "string" ? relayPathSegments(path) : path;
  } catch {
    return false;
  }
  return parts.length >= 3 && parts.length <= 4 && parts[0] === "sync" &&
    parts[1] !== "shares" && parts[1] !== "notices" && parts[2] === "automation-host";
}

const AUTOMATION_HOST_ACTIONS = ["check-in", "choose", "release", "take-over"] as const;

export type AutomationHostRoute = {
  route: "automation-host";
  workspaceId: string;
  action: "read" | (typeof AUTOMATION_HOST_ACTIONS)[number];
};

export function parseAutomationHostAction(value: string | undefined): AutomationHostRoute["action"] | null {
  if (value === undefined) return "read";
  return AUTOMATION_HOST_ACTIONS.find((action) => action === value) ?? null;
}

// Which of the owner's computers runs the workspace's schedules and
// Group-message automations. Every route acts for the workspace owner only:
// it checks ownership before it reads the body, and storage checks it again
// in each transaction because reading the body can yield.
export function createAutomationHostRoutes(
  storage: Pick<
    SyncRelayStorage,
    | "workspaceIsOwnedBy"
    | "readAutomationHost"
    | "checkInAutomationComputer"
    | "chooseAutomationHost"
    | "releaseAutomationHost"
    | "takeOverAutomationHost"
  >,
  nowMs: () => number,
  changeRateLimiter: TokenBucketLimiter,
) {
  return async function respondToAutomationHost(
    request: Request,
    route: AutomationHostRoute,
    ownerUserId: string,
  ): Promise<Response> {
    const scope = { workspaceId: route.workspaceId, ownerUserId };
    if (!storage.workspaceIsOwnedBy(route.workspaceId, ownerUserId)) throw notFound();
    if (route.action === "read") {
      if (request.method !== "GET") throw relayError("method_not_allowed");
      return jsonResponse({ ok: true, ...storage.readAutomationHost(scope) }, 200);
    }
    if (request.method !== "POST") throw relayError("method_not_allowed");
    if (!changeRateLimiter.allow(ownerUserId, nowMs())) throw relayError("automation_host_rate_limited");
    const body = await readBody(request);
    const state = (() => {
      switch (route.action) {
        case "check-in":
          if (typeof body.claim !== "boolean") throw badRequest("claim must be true or false");
          return storage.checkInAutomationComputer({
            ...scope,
            installId: installId(body.installId),
            label: label(body.label),
            claim: body.claim,
            nowMs: nowMs(),
          });
        case "choose":
          return storage.chooseAutomationHost({
            ...scope,
            installId: installId(body.installId),
            generation: generation(body.generation),
          });
        case "release":
          return storage.releaseAutomationHost({
            ...scope,
            installId: installId(body.installId),
            generation: generation(body.generation),
            releasedThroughMs: nonNegativeInteger(body.releasedThroughMs, "releasedThroughMs"),
          });
        case "take-over":
          return storage.takeOverAutomationHost({ ...scope, generation: generation(body.generation) });
      }
    })();
    return jsonResponse({ ok: true, ...state }, 200);
  };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await readBoundedJson(request, AUTOMATION_HOST_MAX_BODY_BYTES, request.signal);
  } catch (error) {
    if (error instanceof RangeError) throw relayError("payload_too_large");
    throw badRequest("request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function installId(value: unknown): string {
  if (!isNoticeLine(value, AUTOMATION_INSTALL_ID_MAX_CHARS)) throw badRequest("installId is invalid");
  return value;
}

function label(value: unknown): string {
  if (!isNoticeLine(value, AUTOMATION_COMPUTER_LABEL_MAX_CHARS)) throw badRequest("label is invalid");
  return value;
}

function generation(value: unknown): number {
  return nonNegativeInteger(value, "generation");
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw badRequest(`${name} must be a non-negative integer`);
  }
  return value;
}
