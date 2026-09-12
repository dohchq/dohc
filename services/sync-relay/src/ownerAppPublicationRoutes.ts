import { readBoundedJson } from "@dohc/service-http";
import { parseAppPublicationCandidate, type AppPublicationLimits } from "@dohc/security-contract/app-publication";
import { badRequest, notFound, relayError } from "./errors";
import { ticketRecord } from "./liveTicketInputs";
import { parseShareId } from "./requestInputs";
import type { SyncRelayStorage } from "./storage";
import { MAX_PAYLOAD_JSON_BYTES } from "./wireLimits";
import { validateUserWritePath } from "@dohc/workspace-core";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";

export type OwnerAppPublicationRoute = {route: "owner-app-publication"; workspaceId: string} & (
  | {action: "publish"}
  | {action: "read" | "withdraw"; publicationId: string}
);

function response(value: unknown) {
  return new Response(JSON.stringify(value), {headers: {
    "content-type": "application/json", "cache-control": "private, no-store",
  }});
}
function record(value: unknown, fields: string[]) {
  try {return ticketRecord(value, fields);} catch {throw badRequest("Invalid publication fields.");}
}

export function createOwnerAppPublicationRoutes(options: {
  storage: SyncRelayStorage; limits?: AppPublicationLimits; nowMs(): number;
}) {
  const limits = options.limits && {...options.limits};
  if (limits && [limits.maxFiles, limits.maxMetadataBytes, limits.maxBundleBytes].some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error("Invalid app publication limits.");
  }
  return async (request: Request, route: OwnerAppPublicationRoute, ownerUserId: string) => {
    const {storage} = options;
    if (!limits || !storage.workspaceIsOwnedBy(route.workspaceId, ownerUserId)) throw notFound();
    if (route.action === "publish" && request.method === "GET") {
      const query = new URL(request.url).searchParams;
      if ([...query.keys()].some(key => key !== "appRoot" && key !== "cursor") || query.getAll("appRoot").length > 1 || query.getAll("cursor").length > 1) throw badRequest("Invalid publication list query.");
      const cursor = query.get("cursor") ?? undefined, appRoot = query.get("appRoot") ?? undefined;
      if (cursor !== undefined && !/^[0-9a-f]{64}$/.test(cursor)) throw badRequest("Invalid publication cursor.");
      if (appRoot !== undefined) {
        const path = validateUserWritePath(appRoot);
        if (!path.ok || path.normalized !== appRoot || classifyEngineFilePath(appRoot).kind !== "tracked") throw badRequest("Invalid app root.");
      }
      return response(storage.listAppPublications({workspaceId: route.workspaceId, ownerUserId, limits, cursor, appRoot}));
    }
    if (request.method !== (route.action === "read" ? "GET" : "POST")) throw relayError("method_not_allowed");
    const lookup = "publicationId" in route ? {workspaceId: route.workspaceId, publicationId: route.publicationId, ownerUserId, limits} : null;
    if (route.action === "read") return response(storage.readAppPublication(lookup!));
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw badRequest("Publication requests require application/json.");
    const signal = AbortSignal.any([request.signal, storage.unavailable]);
    let raw: unknown;
    try { raw = await readBoundedJson(request, MAX_PAYLOAD_JSON_BYTES, signal); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof RangeError) throw relayError("payload_too_large");
      throw badRequest("Invalid publication JSON body.");
    }
    signal.throwIfAborted();
    if (!storage.workspaceIsOwnedBy(route.workspaceId, ownerUserId)) throw notFound();
    if (route.action === "withdraw") {
      const input = record(raw, ["expectedAuthorityRevision"]);
      if (!Number.isSafeInteger(input.expectedAuthorityRevision) || Number(input.expectedAuthorityRevision) < 1) throw badRequest("Invalid publication authority revision.");
      return response(storage.withdrawAppPublication({...lookup!, expectedAuthorityRevision: Number(input.expectedAuthorityRevision)}));
    }
    const input = record(raw, ["shareId", "grantId", "expectedGrantGeneration", "candidate"]);
    if (typeof input.shareId !== "string" || typeof input.grantId !== "string") throw badRequest("Invalid publication share or grant.");
    const shareId = parseShareId(input.shareId), grantId = parseShareId(input.grantId);
    const share = storage.getShare(shareId), grant = storage.getShareGrant(grantId);
    if (!share || !grant || share.workspaceId !== route.workspaceId || share.granterUserId !== ownerUserId || grant.shareId !== shareId ||
        grant.status !== "active" || grant.revokedAtMs !== null) throw notFound();
    if (!Number.isSafeInteger(input.expectedGrantGeneration) || Number(input.expectedGrantGeneration) < 1) throw badRequest("Invalid publication grant generation.");
    if (input.expectedGrantGeneration !== grant.generation) throw relayError("conflict", "Publication grant changed.");
    let candidate;
    try {candidate = parseAppPublicationCandidate(input.candidate, limits);}
    catch {throw badRequest("Invalid publication candidate.");}
    return response(storage.publishAppPublication({workspaceId: route.workspaceId, ownerUserId, shareId, grantId,
      generation: grant.generation, candidate, limits, blobs: [], nowMs: options.nowMs()}));
  };
}
