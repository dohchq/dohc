import { readBoundedJson } from "@dohc/service-http";
import { parseLiveDocumentKey, parseLiveUpdateDigest, parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import type { LiveRestorePreparation } from "./liveRestorePreparation";
import { badRequest, notFound, relayError } from "./errors";
import { ticketRecord } from "./liveTicketInputs";
import type { SyncRelayStorage } from "./storage";
import type { StopRestoreIntent, StopRestoreLookup } from "./storage/liveRestoreOperation";
import { MAX_PAYLOAD_JSON_BYTES } from "./wireLimits";
import { ownerRestoreReviewResponse } from "./ownerRestoreResponse";
import {parseOwnerRestoreGrantCursor} from "./storage/ownerRestoreOptions";

export type OwnerRestoreHost = {
  readonly restoreConfigured: boolean;
  prepareRestore(lookup: StopRestoreLookup, signal?: AbortSignal): ReturnType<LiveRestorePreparation["prepare"]>;
  reviewRestore(lookup: StopRestoreLookup, signal?: AbortSignal): ReturnType<LiveRestorePreparation["review"]>;
  confirmRestore(lookup: StopRestoreLookup, digest: string, signal?: AbortSignal): ReturnType<LiveRestorePreparation["confirm"]>;
};
export type OwnerRestoreRoute = {route: "owner-restore"; workspaceId: string} & (
  | {action: "options" | "plan" | "begin"}
  | {action: "status" | "prepare" | "review" | "confirm"; operationId: string}
);

function publicIntent({ownerUserId: _owner, ...intent}: StopRestoreIntent) { return intent; }
function response(value: unknown, code = 200) {
  return new Response(JSON.stringify(value), {status: code,
    headers: {"content-type": "application/json", "cache-control": "private, no-store"}});
}

export function createOwnerRestoreRoutes(options: {
  storage: SyncRelayStorage; host(): OwnerRestoreHost | undefined; nowMs(): number; newId(): string;
}) {
  return async (request: Request, route: OwnerRestoreRoute, ownerUserId: string) => {
    const {storage} = options;
    if (!storage.workspaceIsOwnedBy(route.workspaceId, ownerUserId)) throw notFound();
    if (request.method !== (route.action === "status" ? "GET" : "POST")) throw relayError("method_not_allowed");
    const lookup = "operationId" in route ? {workspaceId: route.workspaceId, ownerUserId,
      operationId: parseLiveUpdateIdentifier(route.operationId)} : null;
    const read = () => {
      const saved = lookup && storage.readOwnerRestoreStatus(lookup);
      if (!saved) throw notFound();
      return saved;
    };
    if (route.action === "status") return response(read());
    const host = options.host();
    if (!host?.restoreConfigured) throw notFound();
    const signal = AbortSignal.any([request.signal, storage.unavailable]);
    const raw = await readBoundedJson(request, MAX_PAYLOAD_JSON_BYTES, signal);
    signal.throwIfAborted();
    // Body parsing can yield. Ownership must still hold before reading or mutating the operation.
    if (!storage.workspaceIsOwnedBy(route.workspaceId, ownerUserId)) throw notFound();
    if (route.action === "options") {
      const fields = ["path", ...["beforeCursor", "grantCursor"].filter(key => typeof raw === "object" && raw !== null && Object.hasOwn(raw, key))];
      const input = ticketRecord(raw, fields);
      if (typeof input.path !== "string") throw badRequest("Invalid restore path.");
      if (Object.hasOwn(input, "beforeCursor") && (!Number.isSafeInteger(input.beforeCursor) || Number(input.beforeCursor) < 1)) {
        throw badRequest("Invalid restore cursor.");
      }
      return response(storage.readOwnerRestoreOptions({workspaceId: route.workspaceId, ownerUserId, path: input.path,
        ...(Object.hasOwn(input, "grantCursor") ? {grantCursor: parseOwnerRestoreGrantCursor(input.grantCursor)} : {}),
        ...(Object.hasOwn(input, "beforeCursor") ? {beforeCursor: input.beforeCursor as number} : {})}));
    }
    if (route.action === "plan") {
      const input = ticketRecord(raw, ["document", "shareId", "grantId", "restorePointCursor", "restorePointReceiptDigest"]);
      const document = parseLiveDocumentKey(input.document);
      if (document.workspaceId !== route.workspaceId) throw notFound();
      if (!Number.isSafeInteger(input.restorePointCursor) || Number(input.restorePointCursor) < 0) throw badRequest("Invalid restore point.");
      const plan = storage.readStopRestorePlan({document, ownerUserId, operationId: options.newId(),
        shareId: parseLiveUpdateIdentifier(input.shareId), grantId: parseLiveUpdateIdentifier(input.grantId),
        restorePointCursor: Number(input.restorePointCursor), restorePointReceiptDigest: parseLiveUpdateDigest(input.restorePointReceiptDigest),
        maxOutputBytes: MAX_PAYLOAD_JSON_BYTES});
      return response({...plan, intent: publicIntent(plan.intent)});
    }
    if (route.action === "begin") {
      const body = ticketRecord(raw, ["intent"]);
      const input = ticketRecord(body.intent, ["deliveryKind", "operationId", "document", "shareId", "grantId",
        "expectedGrantGeneration", "expectedDependentGrantIds", "expectedFence", "restorePointCursor", "restorePointReceiptDigest"]);
      const document = parseLiveDocumentKey(input.document);
      if (document.workspaceId !== route.workspaceId) throw notFound();
      // The operation snapshots and checks every intent field inside its write transaction.
      const intent = {...input, document, ownerUserId} as StopRestoreIntent;
      const operation = storage.beginStopRestore(intent, options.nowMs());
      return response(storage.readOwnerRestoreStatus({workspaceId: route.workspaceId, ownerUserId, operationId: operation.intent.operationId}));
    }
    read();
    if (route.action === "confirm") {
      const input = ticketRecord(raw, ["proposalDigest"]), digest = parseLiveUpdateDigest(input.proposalDigest);
      try {
        const result = await host.confirmRestore(lookup!, digest, signal);
        return response({status: read(), result});
      }
      catch {
        signal.throwIfAborted();
        const current = read();
        const admitted = ["relay-admitted", "native-applied", "settled", "resumed"].includes(current.phase);
        return response({status: current, result: {kind: admitted ? "pending" : "review-required"}}, 409);
      }
    }
    ticketRecord(raw, []);
    try {
      if (route.action === "prepare") {
        const result = await host.prepareRestore(lookup!, signal);
        return response({status: read(), result});
      }
      const lease = await host.reviewRestore(lookup!, signal);
      try {return ownerRestoreReviewResponse({status: read(), result: lease.review}, lease);}
      catch (error) {lease.close(); throw error;}
    } catch {
      signal.throwIfAborted();
      return response({status: read(), result: {kind: route.action === "review" ? "review-required" : "pending"}}, 409);
    }
  };
}
