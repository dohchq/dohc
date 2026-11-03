import {createHash} from "node:crypto";
import {HELD_CHANGED, ServiceHostRetirementConflict} from "./storage/serviceHostEnrollment";
import {DRAIN_TIMEOUT_HEADER, readBoundedJson} from "@dohc/service-http";
import type {ResolveActor} from "@dohc/workspace-auth/session";
import {liveDocumentKindForPath} from "@dohc/workspace-contracts/live-documents";
import type {SyncRelayStorage} from "./storage";
import type {LiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import type {ServiceHostEnrollment, ServiceHostHeldActivation, ServiceHostRetirementPreparation} from "./storage/serviceHostEnrollment";
import type {startSelfHostedLiveHost} from "./selfHostedLiveHost";
import {effectiveShareSelector, isLiveEditShareSelector, parseStoredAnyShareSelectorJson} from "./shareFilter";
import {canonicalLiveSelector} from "./storage/liveDocumentAuthority";
import {parseShareId, parseWorkspaceId} from "./requestInputs";
import {badRequest, errorResponse, notFound, RelayError, relayError} from "./errors";
import type {JsonValue} from "@dohc/workspace-engine-client";
import {RecoveryCopyRefusal, sameKeptEditsIdentity, type ServiceKeptEdits} from "./storage/serviceKeptEdits";

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

/**
 * A refused queue the server keeps, as its owner sees it. One in the store of
 * an earlier workspace identity is `earlier`, before and after a copy: its
 * owner can save a recovery copy from that store, but nothing delivers it any
 * more, so Try again cannot reach it. `store` tells queues of different stores
 * apart that share an outbox ID, without naming either identity.
 */
function keptView(row: ServiceKeptEdits, identity: {replicationEpoch: string | null; streamIdentity: string | null} | null) {
  const current = sameKeptEditsIdentity(row.identity, identity);
  return {objectId: row.objectId, path: row.binding.currentPath, outboxId: row.outboxId, reason: row.reason, generation: row.generation,
    store: createHash("sha256").update(JSON.stringify([row.identity.replicationEpoch, row.identity.streamIdentity])).digest("hex").slice(0, 32),
    recovery: current && row.retrying ? "retrying" : row.copied ? "copied" : "paused", ...(current ? {} : {earlier: true})};
}

/** A kept edits action that names a refusal the server no longer has, or a Try again of an earlier store's. Answered as 409 with its code. */
class KeptEditsConflict extends Error {
  constructor(readonly code: "kept-edits-changed" | "kept-edits-earlier") {
    super(code === "kept-edits-changed" ? "This document changed. Open Live documents to check it."
      : "The server kept these edits in an earlier copy of this workspace. Save a recovery copy to get them back.");
  }
}
const isPageCursor = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join() === "offset,part,sequence,snapshot" && typeof (value as Record<string, unknown>).snapshot === "string" &&
  typeof (value as Record<string, unknown>).part === "string" && Number.isSafeInteger((value as Record<string, unknown>).sequence) &&
  Number.isSafeInteger((value as Record<string, unknown>).offset);

const isCheckpointDigest = (value: unknown) => value === null || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));

/**
 * The owner's actions on a refused queue the server keeps. `page` returns one
 * bounded engine page of it for a recovery copy, after the previous page's
 * `cursor`, from whatever store holds it; `retry` is Try again, for a queue
 * of the current store only; and `copied` records that a durable recovery
 * copy of this refusal exists, with the `checkpointDigest` its header named,
 * after which the server may let the document, or the earlier store, go once
 * that is still what a copy reads. Each names the refusal it saw.
 */
async function keptEditsAction(storage: SyncRelayStorage, host: KeptEditsHost, workspaceId: string, input: Record<string, unknown>,
  guard: () => void, signal: AbortSignal) {
  const keys = Object.keys(input).sort().join();
  const shaped = input.action === "page" ? keys === "action,generation,outboxId" || (keys === "action,cursor,generation,outboxId" && isPageCursor(input.cursor))
    : input.action === "copied" ? keys === "action,checkpointDigest,generation,outboxId" && isCheckpointDigest(input.checkpointDigest)
    : input.action === "retry" && keys === "action,generation,outboxId";
  if (!shaped || typeof input.outboxId !== "string" || !Number.isSafeInteger(input.generation)) throw badRequest("A kept edits action, queue and refusal are required.");
  // A generation names one row, whatever store holds its queue.
  const refusal = {workspaceId, outboxId: input.outboxId, generation: Number(input.generation)}, kept = storage.readServiceKeptEditsRefusal(refusal);
  if (!kept) throw new KeptEditsConflict("kept-edits-changed");
  if (input.action === "page") {
    const page = await host.keptEdits.page(kept, input.cursor as JsonValue | undefined, signal);
    if (!storage.readServiceKeptEditsRefusal(refusal)) throw new KeptEditsConflict("kept-edits-changed");
    return {ok: true, page};
  }
  if (input.action === "copied") {
    if (!storage.confirmServiceKeptEditsCopy({workspaceId, outboxId: kept.outboxId, generation: kept.generation,
      checkpointDigest: input.checkpointDigest as string | null})) throw new KeptEditsConflict("kept-edits-changed");
    host.reconcile();
    // A handle that does not close now closes once idle.
    await host.keptEdits.copied(kept).catch(() => {});
    return {ok: true};
  }
  if (!sameKeptEditsIdentity(kept.identity, storage.getWorkspaceIdentity(workspaceId))) throw new KeptEditsConflict("kept-edits-earlier");
  if (kept.retrying) throw new KeptEditsConflict("kept-edits-changed");
  const outcome = await host.keptEdits.retry(kept, guard, signal);
  if (outcome === "unavailable") throw relayError("conflict", "Live editing is off for this document. Save a recovery copy to get your edits back.");
  if (outcome === "changed") throw new KeptEditsConflict("kept-edits-changed");
  return {ok: true};
}

/** The paths the enrollment routes answer: the workspace's live host and the owner's actions on edits the server kept. */
export const isServiceHostEnrollmentPath = (pathname: string) => /^\/sync\/[^/]+\/live-host(?:\/kept-edits)?$/.test(pathname);

type KeptEditsHost = Pick<Awaited<ReturnType<typeof startSelfHostedLiveHost>>, "keptEdits" | "reconcile">;

/** Recovery page reads the relay runs at once. The rest wait their turn, holding no queue bytes. */
export const MAX_KEPT_EDITS_READS = 2;
// Resolves to a release once a read may run. Releasing again changes nothing.
function readTurns(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (signal: AbortSignal): Promise<() => void> => {
    while (active >= max) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const wake = () => {signal.removeEventListener("abort", stop); resolve();};
        const stop = () => {const index = waiting.indexOf(wake); if (index >= 0) waiting.splice(index, 1); reject(signal.reason);};
        waiting.push(wake); signal.addEventListener("abort", stop, {once: true});
      });
    }
    active++;
    let released = false;
    return () => {if (released) return; released = true; active--; waiting.shift()?.();};
  };
}
// A page's body keeps its read slot until the client took all of it, cancels it
// or goes away, or stops taking it for the drain timeout. The slot ends at the
// read after the body's one chunk, which a writer under backpressure makes only
// once that chunk drained.
function heldResponse(body: unknown, release: () => void, signal: AbortSignal): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  let sent = false;
  signal.addEventListener("abort", release, {once: true});
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {sent = true; controller.enqueue(bytes); return;}
      controller.close(); release();
    },
    cancel() {release();},
  }, {highWaterMark: 0}), {headers: {"content-type": "application/json", "cache-control": "private, no-store", [DRAIN_TIMEOUT_HEADER]: "1"}});
}

export function createServiceHostEnrollmentRoutes(options: {
  storage: SyncRelayStorage; history: LiveJournalHistoryAuthority; resolveActor: ResolveActor;
  host: Pick<Awaited<ReturnType<typeof startSelfHostedLiveHost>>, "ready" | "reconcile" | "unavailable" | "blocked" | "holdReason" | "unblock" | "diverged" | "keptEdits" | "stop">;
}) {
  const {storage, history, host} = options;
  const activation = storage.createServiceActivationStore(history), reads = readTurns(MAX_KEPT_EDITS_READS);
  const changed = (row: ServiceHostEnrollment) => !storage.workspaceIsOwnedBy(row.workspaceId, row.ownerUserId) || storage.verifyWorkspaceIdentity(row) !== "matched";
  // Nothing its owner does, not even a Pause or Stop, continues a document
  // whose hosted replica diverged. Its store stays for the operator.
  const diverged = (row: ServiceHostEnrollment) => !changed(row) && host.diverged(row);
  // Each row names its document, so its owner's Stop and Resume act on that document alone.
  function state(row: ServiceHostEnrollment) {
    const base = {path: row.path, objectId: row.objectId};
    if (diverged(row)) return {...base, status: "unavailable", reason: "session-host-diverged"};
    // A Pause still waiting for its document to unload reads as paused.
    if (!row.enabled || row.ownerStop) return {...base, status: "paused"};
    if (changed(row)) return {...base, status: "unavailable", reason: "workspace-changed"};
    if (storage.objectIdAtPathInVersion({workspaceId: row.workspaceId, versionId: "main", path: row.path}) !== row.objectId) return {...base, status: "unavailable", reason: "document-unavailable"};
    // Only the owner's Resume lets the host try a document it could not continue.
    // One with no live-editing history needs its owner to open it first. A Resume of one whose
    // host copy is missing an owner edit retires its held activation.
    const block = host.blocked(row);
    if (block) return {...base, status: "unavailable", reason: block === "without-lineage" ? "live-document-without-lineage" :
      block === "live-edit-unadmitted" ? "live-edit-unadmitted" : "session-host-refused"};
    if (host.holdReason(row) === "hosted-conflict-parent-withheld") return {...base, status: "unavailable", reason: "conflict-parent-withheld"};
    const saved = activation.read(row.workspaceId, row.path, 4 * 1024 * 1024, row.objectId);
    if (!saved?.completed) return {...base, status: host.unavailable ? "unavailable" : "preparing"};
    const document = {workspaceId: row.workspaceId, mainVersionId: "main", objectId: saved.source.objectId, lineageClaimId: saved.source.lineageClaimId};
    const current = storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: row.ownerUserId, shareId: row.shareId}});
    if (current.kind !== "current" || !host.ready(document)) return {...base, status: host.unavailable ? "unavailable" : "preparing"};
    return {...base, path: current.binding.currentPath, status: "ready", document: {binding: current.binding, relayDatabaseNamespace: history.namespace, shareId: row.shareId}};
  }
  // The exact prepared activation, pending or completed, of a document the host
  // holds for an unadmitted live edit. Its Resume retires that activation inside
  // the enrollment transaction, which checks the hold again there.
  function heldActivation(row: ServiceHostEnrollment): ServiceHostHeldActivation | undefined {
    if (host.blocked(row) !== "live-edit-unadmitted") return undefined;
    const saved = activation.read(row.workspaceId, row.path, 4 * 1024 * 1024, row.objectId), identity = storage.getWorkspaceIdentity(row.workspaceId);
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
      const keptPage = request.method === "GET" && url.searchParams.get("kept") === "1" &&
        [...url.searchParams.keys()].every(key => key === "kept" || key === "after") &&
        url.searchParams.getAll("kept").length === 1 && url.searchParams.getAll("after").length === 1;
      if ([retiredPage, refusalPage, keptPage].filter(Boolean).length > 1) throw notFound();
      const keptPath = parts.length === 5 && parts[4] === "kept-edits" && request.method === "POST" && !url.search;
      if ((parts.length !== 4 && !keptPath) || parts[1] !== "sync" || parts[3] !== "live-host" || (url.search && !retiredPage && !refusalPage && !keptPage) || request.headers.has("cookie") ||
        !/^Bearer [^\s]+$/.test(request.headers.get("authorization") ?? "") || !["GET", "POST", "DELETE"].includes(request.method)) throw notFound();
      const workspaceId = parseWorkspaceId(decodeURIComponent(parts[2]!));
      const actor = await options.resolveActor(request, workspaceId);
      // Only the workspace's owner, never a recipient of its shares.
      const guard = () => {request.signal.throwIfAborted(); if (actor.workspaceId !== workspaceId || !storage.workspaceIsOwnedBy(workspaceId, actor.userId)) throw notFound();};
      guard();
      if (refusalPage) return response({ok: true, ...serviceHostEnrollmentRefusals(storage, workspaceId, actor.userId,
        url.searchParams.has("after") ? parseShareId(url.searchParams.get("after") ?? undefined) : undefined)});
      if (retiredPage) {
        const page = storage.listRetiredServiceHostEnrollments(workspaceId, url.searchParams.get("after") ?? undefined);
        return response({ok: true, documents: page.documents.map(row => ({path: row.path, objectId: row.objectId, status: "retired",
          ...(diverged(row) ? {reason: "session-host-diverged"} : !changed(row) && storage.hasServiceHostConflictEffect(row)
            ? {reason: "conflict-parent-withheld"} : {})})), nextCursor: page.nextCursor});
      }
      // Later pages of the edits the server kept, after the first page's `keptEditsCursor`.
      if (keptPage) {
        const after = Number(url.searchParams.get("after"));
        if (!/^[1-9][0-9]*$/.test(url.searchParams.get("after")!) || !Number.isSafeInteger(after)) throw badRequest("A kept edits cursor is required.");
        const page = storage.listServiceKeptEdits(workspaceId, after), identity = storage.getWorkspaceIdentity(workspaceId);
        return response({ok: true, keptEdits: page.keptEdits.map(row => keptView(row, identity)), nextCursor: page.nextCursor});
      }
      // Whether the workspace's hosted replica diverged, even once its owner stopped every document.
      if (request.method === "GET") {
        const identity = storage.getWorkspaceIdentity(workspaceId), kept = storage.listServiceKeptEdits(workspaceId);
        return response({ok: true, diverged: !!identity && host.diverged({workspaceId, ...identity}),
          documents: storage.listServiceHostEnrollments(workspaceId).map(state),
          ...(kept.keptEdits.length ? {keptEdits: kept.keptEdits.map(row => keptView(row, identity))} : {}),
          ...(kept.nextCursor === null ? {} : {keptEditsCursor: kept.nextCursor})});
      }
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw badRequest("Expected a JSON request.");
      const raw = await readBoundedJson(request, 16 * 1024, request.signal); guard();
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("Invalid live host request.");
      const input = raw as Record<string, unknown>;
      if (keptPath) {
        if (input.action !== "page") {
          const result = await keptEditsAction(storage, host, workspaceId, input, guard, request.signal);
          guard();
          return response(result);
        }
        const release = await reads(request.signal);
        try {
          const result = await keptEditsAction(storage, host, workspaceId, input, guard, request.signal);
          guard();
          return heldResponse(result, release, request.signal);
        } catch (error) {release(); throw error;}
      }
      if (request.method === "DELETE") {
        if (Object.keys(input).some(key => !["path","objectId","retire","restoreFenceGeneration"].includes(key)) || typeof input.path !== "string" ||
          (input.objectId !== undefined && (typeof input.objectId !== "string" || input.retire !== true)) ||
          (input.retire !== undefined && input.retire !== true) || (input.restoreFenceGeneration !== undefined && (!Number.isSafeInteger(input.restoreFenceGeneration) || Number(input.restoreFenceGeneration) < 0 || input.retire !== true))) throw badRequest("A document path and optional retirement are required.");
        const fence = (prepared?: ServiceHostRetirementPreparation) => storage.setServiceHostEnrollmentEnabled({workspaceId, path: input.path as string,
          ownerUserId: actor.userId, enabled: false, ...(input.retire === true ? {retire: true, ...(input.objectId === undefined ? {} : {objectId: input.objectId as string}),
            ...(input.restoreFenceGeneration === undefined ? {} : {restoreFenceGeneration: Number(input.restoreFenceGeneration)}),
            ...(prepared ? {prepared} : {})} : {}), nowMs: Date.now(), guard});
        // Stop waits for the host to deliver the document's edits and block new ones.
        const objectId = input.retire !== true || !storage.workspaceIsOwnedBy(workspaceId, actor.userId) ? undefined
          : (input.objectId as string | undefined) ?? storage.readServiceHostEnrollment(workspaceId, input.path)?.objectId;
        const row = objectId === undefined ? fence() : await host.stop({workspaceId, objectId}, fence, request.signal);
        if (row === "waiting") throw relayError("edits-pending");
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
    } catch (error) {
      if (error instanceof KeptEditsConflict) return response({ok: false, code: error.code, error: error.message}, 409);
      if (error instanceof RecoveryCopyRefusal) return response({ok: false, code: "kept-edits-unrecoverable", reason: error.reason, error: error.message}, 409);
      if (error instanceof ServiceHostRetirementConflict) return response({ok:false,code:"restore-fenced",restoreFenceGeneration:error.restoreFenceGeneration},409); return errorResponse(error);}
  };
}
