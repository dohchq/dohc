import { jsonResponse } from "@dohc/service-http";
import {
  AUTOMATION_COMPUTER_LABEL_MAX_CHARS,
  AUTOMATION_INSTALL_ID_MAX_CHARS,
  isNoticeLine,
} from "@dohc/workspace-contracts/relay";
import { badRequest, notFound, relayError } from "./errors";
import { readJsonObject } from "./requestInputs";
import type { SyncRelayStorage } from "./storage";

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
    const body = await readJsonObject(request);
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
