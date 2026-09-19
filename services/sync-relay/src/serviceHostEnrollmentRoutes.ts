import {readBoundedJson} from "@dohc/service-http";
import type {ResolveActor} from "@dohc/workspace-auth/session";
import {liveDocumentKindForPath} from "@dohc/workspace-contracts/live-documents";
import type {SyncRelayStorage} from "./storage";
import type {LiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import type {ServiceHostEnrollment} from "./storage/serviceHostEnrollment";
import type {startSelfHostedLiveHost} from "./selfHostedLiveHost";
import {effectiveShareSelector, isLiveEditShareSelector, parseStoredAnyShareSelectorJson} from "./shareFilter";
import {canonicalLiveSelector} from "./storage/liveDocumentAuthority";
import {parseShareId, parseWorkspaceId} from "./requestInputs";
import {badRequest, errorResponse, notFound, RelayError} from "./errors";

export function serviceHostSharePaths(storage: SyncRelayStorage, input: {workspaceId: string; ownerUserId: string; shareId: string}): string[] {
  const share = storage.getShare(input.shareId), parsed = share && parseStoredAnyShareSelectorJson(share.selectorJson);
  const selector = parsed && effectiveShareSelector(parsed, "edit");
  if (!share || share.workspaceId !== input.workspaceId || share.granterUserId !== input.ownerUserId ||
    !storage.workspaceIsOwnedBy(input.workspaceId, input.ownerUserId) || !selector || !isLiveEditShareSelector(selector) || !canonicalLiveSelector(share, selector)) throw notFound();
  const files = storage.readCurrentFileState({workspaceId: input.workspaceId, versionId: "main", selectorPaths: selector.paths, limit: 5_000});
  if (files.tooMany) throw badRequest("This share has too many files for live editing.");
  const paths = files.files.filter(file => file.contentKind === "text" && liveDocumentKindForPath(file.path) === "richdoc").map(file => file.path);
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
    try {paths = serviceHostSharePaths(storage, {...share, ownerUserId});}
    catch (error) {if (error instanceof RelayError) {onRefused?.(error); continue;} throw error;}
    for (const path of paths) {
      const key = JSON.stringify([share.workspaceId, path]);
      if (existing.has(key) || storage.hasServiceHostEnrollment(share.workspaceId, path)) continue;
      try {storage.enrollServiceHostDocument({workspaceId: share.workspaceId, ownerUserId, shareId: share.shareId, path, nowMs: Date.now(), guard: storage.captureStanding()});}
      catch (error) {if (error instanceof RelayError) {onRefused?.(error); continue;} throw error;}
      existing.add(key);
    }
  }
  return page.nextCursor;
}

export function createServiceHostEnrollmentRoutes(options: {
  storage: SyncRelayStorage; history: LiveJournalHistoryAuthority; resolveActor: ResolveActor;
  host: Pick<Awaited<ReturnType<typeof startSelfHostedLiveHost>>, "ready" | "reconcile" | "unavailable">;
}) {
  const {storage, history, host} = options;
  const activation = storage.createServiceActivationStore(history);
  function state(row: ServiceHostEnrollment) {
    const base = {path: row.path};
    if (!row.enabled) return {...base, status: "paused"};
    if (!storage.workspaceIsOwnedBy(row.workspaceId, row.ownerUserId) || storage.verifyWorkspaceIdentity(row) !== "matched") return {...base, status: "unavailable", reason: "workspace-changed"};
    if (storage.objectIdAtPathInVersion({workspaceId: row.workspaceId, versionId: "main", path: row.path}) !== row.objectId) return {...base, status: "unavailable", reason: "document-unavailable"};
    const saved = activation.read(row.workspaceId, row.path, 4 * 1024 * 1024);
    if (!saved?.completed) return {...base, status: host.unavailable ? "unavailable" : "preparing"};
    const document = {workspaceId: row.workspaceId, mainVersionId: "main", objectId: saved.source.objectId, lineageClaimId: saved.source.lineageClaimId};
    const current = storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: row.ownerUserId, shareId: row.shareId}});
    if (current.kind !== "current" || !host.ready(document)) return {...base, status: host.unavailable ? "unavailable" : "preparing"};
    return {path: current.binding.currentPath, status: "ready", document: {binding: current.binding, relayDatabaseNamespace: history.namespace, shareId: row.shareId}};
  }
  const response = (body: unknown, status = 200) => Response.json(body, {status, headers: {"cache-control": "private, no-store"}});
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url), parts = url.pathname.split("/");
      const retiredPage = request.method === "GET" && url.searchParams.get("retired") === "1" &&
        [...url.searchParams.keys()].every(key => key === "retired" || key === "after") &&
        url.searchParams.getAll("retired").length === 1 && url.searchParams.getAll("after").length <= 1;
      if (parts.length !== 4 || parts[1] !== "sync" || parts[3] !== "live-host" || (url.search && !retiredPage) || request.headers.has("cookie") ||
        !/^Bearer [^\s]+$/.test(request.headers.get("authorization") ?? "") || !["GET", "POST", "DELETE"].includes(request.method)) throw notFound();
      const workspaceId = parseWorkspaceId(decodeURIComponent(parts[2]!));
      const actor = await options.resolveActor(request, workspaceId);
      const guard = () => {request.signal.throwIfAborted(); if (actor.workspaceId !== workspaceId || !storage.workspaceIsOwnedBy(workspaceId, actor.userId)) throw notFound();};
      guard();
      if (retiredPage) {
        const page = storage.listRetiredServiceHostEnrollments(workspaceId, url.searchParams.get("after") ?? undefined);
        return response({ok: true, documents: page.documents.map(row => ({path: row.path, status: "retired"})), nextCursor: page.nextCursor});
      }
      if (request.method === "GET") return response({ok: true, documents: storage.listServiceHostEnrollments(workspaceId).map(state)});
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw badRequest("Expected a JSON request.");
      const raw = await readBoundedJson(request, 16 * 1024, request.signal); guard();
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("Invalid live host request.");
      const input = raw as Record<string, unknown>;
      if (request.method === "DELETE") {
        if (Object.keys(input).some(key => key !== "path" && key !== "retire") || typeof input.path !== "string" ||
          (input.retire !== undefined && input.retire !== true)) throw badRequest("A document path and optional retirement are required.");
        const row = storage.setServiceHostEnrollmentEnabled({workspaceId, path: input.path, ownerUserId: actor.userId, enabled: false,
          ...(input.retire === true ? {retire: true} : {}), nowMs: Date.now(), guard});
        if (!row) throw notFound();
        host.reconcile(); return response({ok: true, ...(input.retire === true ? {path: row.path, status: "retired"} : state(row))});
      }
      if (Object.keys(input).some(key => !["path", "shareId"].includes(key)) || (input.shareId !== undefined && typeof input.shareId !== "string") ||
        (input.path !== undefined && typeof input.path !== "string") || (input.path === undefined && input.shareId === undefined)) throw badRequest("An owned share or retained document is required.");
      const retained = input.shareId === undefined ? storage.readServiceHostEnrollment(workspaceId, input.path as string) : undefined;
      if (input.shareId === undefined && (!retained || retained.ownerUserId !== actor.userId)) throw notFound();
      const shareId = parseShareId(input.shareId ?? retained!.shareId);
      const paths = input.path === undefined ? serviceHostSharePaths(storage, {workspaceId, shareId, ownerUserId: actor.userId}) : [input.path as string];
      const rows = storage.enrollServiceHostDocuments(paths.map(path => ({workspaceId, path, shareId, ownerUserId: actor.userId, nowMs: Date.now(), guard})));
      host.reconcile();
      const documents = rows.map(state);
      return response({ok: true, ...(input.path === undefined ? {documents} : documents[0])}, documents.every(row => row.status === "ready") ? 200 : 202);
    } catch (error) {return errorResponse(error);}
  };
}
