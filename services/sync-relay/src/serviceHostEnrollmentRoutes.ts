import {HELD_CHANGED, ServiceHostRetirementConflict} from "./storage/serviceHostEnrollment";
import {readBoundedJson} from "@dohc/service-http";
import type {ResolveActor} from "@dohc/workspace-auth/session";
import {liveDocumentKindForPath} from "@dohc/workspace-contracts/live-documents";
import type {SyncRelayStorage} from "./storage";
import type {LiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import type {ServiceHostEnrollment, ServiceHostHeldActivation} from "./storage/serviceHostEnrollment";
import type {startSelfHostedLiveHost} from "./selfHostedLiveHost";
import {effectiveShareSelector, isLiveEditShareSelector, parseStoredAnyShareSelectorJson} from "./shareFilter";
import {canonicalLiveSelector} from "./storage/liveDocumentAuthority";
import {parseShareId, parseWorkspaceId} from "./requestInputs";
import {badRequest, errorResponse, notFound, RelayError, relayError} from "./errors";

export function serviceHostSharePaths(storage: SyncRelayStorage, input: {workspaceId: string; ownerUserId: string; shareId: string; missingOnly?: boolean}): string[] {
  const share = storage.getShare(input.shareId), parsed = share && parseStoredAnyShareSelectorJson(share.selectorJson);
  const selector = parsed && effectiveShareSelector(parsed, "edit");
  if (!share || share.workspaceId !== input.workspaceId || share.granterUserId !== input.ownerUserId ||
    !storage.workspaceIsOwnedBy(input.workspaceId, input.ownerUserId) || !selector || !isLiveEditShareSelector(selector) || !canonicalLiveSelector(share, selector)) throw notFound();
  const files = storage.readCurrentFileState({workspaceId: input.workspaceId, versionId: "main", selectorPaths: selector.paths, limit: 5_000});
  if (files.tooMany) throw badRequest("This share has too many files for live editing.");
  const paths = files.files.filter(file => file.contentKind === "text" && liveDocumentKindForPath(file.path) === "richdoc" &&
    (!input.missingOnly || !storage.hasKeptServiceHostEnrollment(input.workspaceId, file.path))).map(file => file.path);
  if (paths.length > 64) throw badRequest("This server supports up to 64 live documents.");
  return paths;
}

export function discoverServiceHostDocuments(storage: SyncRelayStorage, onRefused?: (error: RelayError) => void,
  after?: {workspaceId: string; shareId: string}): {workspaceId: string; shareId: string} | null {
  const existing = new Set(storage.listServiceHostEnrollments().map(row => JSON.stringify([row.workspaceId, row.path])));
  const page = storage.scanServiceHostCandidateShares(after);
  for (const share of page.shares) {
    const ownerUserId = share.granterUserId;
    let paths: string[];
    try {paths = serviceHostSharePaths(storage, {...share, ownerUserId, missingOnly: true});}
    catch (error) {if (error instanceof RelayError) {onRefused?.(error); continue;} throw error;}
    for (const path of paths) {
      const key = JSON.stringify([share.workspaceId, path]);
      if (existing.has(key) || storage.hasKeptServiceHostEnrollment(share.workspaceId, path)) continue;
      try {storage.enrollServiceHostDocument({workspaceId: share.workspaceId, ownerUserId, shareId: share.shareId, path, nowMs: Date.now(), guard: storage.captureStanding()});}
      catch (error) {if (error instanceof RelayError) {onRefused?.(error); continue;} throw error;}
      existing.add(key);
    }
  }
  return page.nextCursor;
}

export function serviceHostEnrollmentRefusals(storage: SyncRelayStorage, workspaceId: string, ownerUserId: string, after?: string) {
  const page = storage.scanServiceHostCandidateShares(after === undefined ? undefined : {workspaceId, shareId: after}, workspaceId);
  const refusals: Array<{shareId: string; paths: string[]; code: string; message: string}> = [];
  // 100 paths × 1024 UTF-16 units × 6 JSON bytes fits; reserve 24 KiB for the envelope and cursor.
  const byteBudget = 1000 * 1024;
  let bytes = 0, cursor = after;
  for (const share of page.shares) {
    const previous = cursor; cursor = share.shareId;
    if (share.granterUserId !== ownerUserId) continue;
    const parsed = parseStoredAnyShareSelectorJson(share.selectorJson);
    const selector = parsed && effectiveShareSelector(parsed, "edit");
    if (!selector || !isLiveEditShareSelector(selector)) continue;
    try {
      const paths = serviceHostSharePaths(storage, {workspaceId, ownerUserId, shareId: share.shareId, missingOnly: true});
      storage.checkServiceHostDocuments({workspaceId, ownerUserId, shareId: share.shareId, paths});
    } catch (error) {
      if (!(error instanceof RelayError)) throw error;
      const refusal = {shareId: share.shareId, paths: [...selector.paths], code: error.code, message: error.message};
      const size = Buffer.byteLength(JSON.stringify(refusal)) + 1;
      if (size > byteBudget) throw new Error("A live enrollment refusal exceeds its response budget.");
      if (bytes + size > byteBudget) {
        if (previous === undefined) throw new Error("A refusal page cannot advance its cursor.");
        return {refusals, nextCursor: previous};
      }
      bytes += size; refusals.push(refusal);
    }
  }
  return {refusals, nextCursor: page.nextCursor?.shareId ?? null};
}

export function createServiceHostEnrollmentRoutes(options: {
  storage: SyncRelayStorage; history: LiveJournalHistoryAuthority; resolveActor: ResolveActor;
  host: Pick<Awaited<ReturnType<typeof startSelfHostedLiveHost>>, "ready" | "reconcile" | "unavailable" | "blocked" | "unblock" | "diverged">;
}) {
  const {storage, history, host} = options;
  const activation = storage.createServiceActivationStore(history);
  const changed = (row: ServiceHostEnrollment) => !storage.workspaceIsOwnedBy(row.workspaceId, row.ownerUserId) || storage.verifyWorkspaceIdentity(row) !== "matched";
  // Nothing its owner does, not even a Pause or Stop, continues a document
  // whose hosted replica diverged. Its store stays for the operator.
  const diverged = (row: ServiceHostEnrollment) => !changed(row) && host.diverged(row);
  function state(row: ServiceHostEnrollment) {
    const base = {path: row.path};
    if (diverged(row)) return {...base, status: "unavailable", reason: "session-host-diverged"};
    // A Pause still waiting for its document to unload reads as paused.
    if (!row.enabled || row.ownerStop) return {...base, status: "paused"};
    if (changed(row)) return {...base, status: "unavailable", reason: "workspace-changed"};
    if (storage.objectIdAtPathInVersion({workspaceId: row.workspaceId, versionId: "main", path: row.path}) !== row.objectId) return {...base, status: "unavailable", reason: "document-unavailable"};
    // Only the owner's Resume lets the host try a document it could not continue.
    // One with no live-editing history needs its owner to open it first, and a Resume
    // cannot continue one whose host copy misses an edit made while live editing was off.
    const block = host.blocked(row);
    if (block) return {...base, status: "unavailable", reason: block === "without-lineage" ? "live-document-without-lineage" :
      block === "live-edit-unadmitted" ? "live-edit-unadmitted" : "session-host-refused"};
    const saved = activation.read(row.workspaceId, row.path, 4 * 1024 * 1024);
    if (!saved?.completed) return {...base, status: host.unavailable ? "unavailable" : "preparing"};
    const document = {workspaceId: row.workspaceId, mainVersionId: "main", objectId: saved.source.objectId, lineageClaimId: saved.source.lineageClaimId};
    const current = storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: row.ownerUserId, shareId: row.shareId}});
    if (current.kind !== "current" || !host.ready(document)) return {...base, status: host.unavailable ? "unavailable" : "preparing"};
    return {path: current.binding.currentPath, status: "ready", document: {binding: current.binding, relayDatabaseNamespace: history.namespace, shareId: row.shareId}};
  }
  // The exact prepared activation, pending or completed, of a document the host
  // holds for an unadmitted live edit. Its Resume retires that activation inside
  // the enrollment transaction, which checks the hold again there.
  function heldActivation(row: ServiceHostEnrollment): ServiceHostHeldActivation | undefined {
    if (host.blocked(row) !== "live-edit-unadmitted") return undefined;
    const saved = activation.read(row.workspaceId, row.path, 4 * 1024 * 1024), identity = storage.getWorkspaceIdentity(row.workspaceId);
    if (!saved || !identity) return undefined;
    return {activationId: saved.activationId, replicationEpoch: identity.replicationEpoch, streamIdentity: identity.streamIdentity,
      assertHeld() {if (host.blocked(row) !== "live-edit-unadmitted") throw relayError("conflict", HELD_CHANGED);}};
  }
  const response = (body: unknown, status = 200) => Response.json(body, {status, headers: {"cache-control": "private, no-store"}});
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url), parts = url.pathname.split("/");
      const retiredPage = request.method === "GET" && url.searchParams.get("retired") === "1" &&
        [...url.searchParams.keys()].every(key => key === "retired" || key === "after") &&
        url.searchParams.getAll("retired").length === 1 && url.searchParams.getAll("after").length <= 1;
      const refusalPage = request.method === "GET" && url.searchParams.get("refusals") === "1" &&
        [...url.searchParams.keys()].every(key => key === "refusals" || key === "after") &&
        url.searchParams.getAll("refusals").length === 1 && url.searchParams.getAll("after").length <= 1;
      if (retiredPage && refusalPage) throw notFound();
      if (parts.length !== 4 || parts[1] !== "sync" || parts[3] !== "live-host" || (url.search && !retiredPage && !refusalPage) || request.headers.has("cookie") ||
        !/^Bearer [^\s]+$/.test(request.headers.get("authorization") ?? "") || !["GET", "POST", "DELETE"].includes(request.method)) throw notFound();
      const workspaceId = parseWorkspaceId(decodeURIComponent(parts[2]!));
      const actor = await options.resolveActor(request, workspaceId);
      const guard = () => {request.signal.throwIfAborted(); if (actor.workspaceId !== workspaceId || !storage.workspaceIsOwnedBy(workspaceId, actor.userId)) throw notFound();};
      guard();
      if (refusalPage) return response({ok: true, ...serviceHostEnrollmentRefusals(storage, workspaceId, actor.userId,
        url.searchParams.has("after") ? parseShareId(url.searchParams.get("after") ?? undefined) : undefined)});
      if (retiredPage) {
        const page = storage.listRetiredServiceHostEnrollments(workspaceId, url.searchParams.get("after") ?? undefined);
        return response({ok: true, documents: page.documents.map(row => ({path: row.path, status: "retired",
          ...(diverged(row) ? {reason: "session-host-diverged"} : {})})), nextCursor: page.nextCursor});
      }
      // Whether the workspace's hosted replica diverged, even once its owner stopped every document.
      if (request.method === "GET") {
        const identity = storage.getWorkspaceIdentity(workspaceId);
        return response({ok: true, diverged: !!identity && host.diverged({workspaceId, ...identity}),
          documents: storage.listServiceHostEnrollments(workspaceId).map(state)});
      }
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw badRequest("Expected a JSON request.");
      const raw = await readBoundedJson(request, 16 * 1024, request.signal); guard();
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("Invalid live host request.");
      const input = raw as Record<string, unknown>;
      if (request.method === "DELETE") {
        if (Object.keys(input).some(key => !["path","objectId","retire","restoreFenceGeneration"].includes(key)) || typeof input.path !== "string" ||
          (input.objectId !== undefined && (typeof input.objectId !== "string" || input.retire !== true)) ||
          (input.retire !== undefined && input.retire !== true) || (input.restoreFenceGeneration !== undefined && (!Number.isSafeInteger(input.restoreFenceGeneration) || Number(input.restoreFenceGeneration) < 0 || input.retire !== true))) throw badRequest("A document path and optional retirement are required.");
        const row = storage.setServiceHostEnrollmentEnabled({workspaceId, path: input.path, ownerUserId: actor.userId, enabled: false,
          ...(input.retire === true ? {retire: true, ...(input.objectId === undefined ? {} : {objectId: input.objectId as string}),
            ...(input.restoreFenceGeneration === undefined ? {} : {restoreFenceGeneration: Number(input.restoreFenceGeneration)})} : {}), nowMs: Date.now(), guard});
        if (!row) throw notFound();
        host.reconcile(); return response({ok: true, ...(input.retire === true ? {path: row.path, objectId: row.objectId, status: "retired", acceptedCursor: row.acceptedCursor} : state(row))});
      }
      if (Object.keys(input).some(key => !["path", "shareId", "retry"].includes(key)) || (input.shareId !== undefined && typeof input.shareId !== "string") ||
        (input.path !== undefined && typeof input.path !== "string") || (input.retry !== undefined && typeof input.retry !== "boolean") ||
        (input.retry === true && (input.path !== undefined || input.shareId === undefined)) || (input.path === undefined && input.shareId === undefined)) throw badRequest("An owned share or retained document is required.");
      const retained = input.path === undefined ? undefined : storage.readServiceHostEnrollment(workspaceId, input.path as string);
      if (input.shareId === undefined && (!retained || retained.ownerUserId !== actor.userId)) throw notFound();
      const shareId = parseShareId(input.shareId ?? retained!.shareId);
      const paths = input.path === undefined ? serviceHostSharePaths(storage, {workspaceId, shareId, ownerUserId: actor.userId, missingOnly: input.retry === true}) : [input.path as string];
      const held = retained?.ownerUserId === actor.userId ? heldActivation(retained) : undefined;
      const rows = storage.enrollServiceHostDocuments(paths.map(path => ({workspaceId, path, shareId, ownerUserId: actor.userId, nowMs: Date.now(), guard, ...(held ? {held} : {})})));
      // A Resume gives a blocked document one more attempt in the store it has.
      if (input.path !== undefined) host.unblock(rows[0]!);
      host.reconcile();
      const documents = rows.map(state);
      return response({ok: true, ...(input.path === undefined ? {documents} : documents[0])}, documents.every(row => row.status === "ready") ? 200 : 202);
    } catch (error) {if (error instanceof ServiceHostRetirementConflict) return response({ok:false,code:"restore-fenced",restoreFenceGeneration:error.restoreFenceGeneration},409); return errorResponse(error);}
  };
}
