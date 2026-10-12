import { jsonResponse } from "@dohc/service-http";
import { asRecord } from "@dohc/workspace-core";
import { sha256Hex } from "@dohc/workspace-core/hash";
import { badRequest, notFound, relayError } from "./errors";
import { arrayBufferForBytes, readBytes } from "./relayBytes";
import { assertSha256, parseCursor, parseLimit, readJsonObject } from "./requestInputs";
import { MAX_RAW_ROWS_PER_LINK_PAGE, scanFilteredLog } from "./shareReadQueries";
import type { SyncRelayLogRow, SyncRelayStorage } from "./storage";
import { referencedBlobShas } from "./storage/blobReferences";
import type { ServiceHostFeedScope } from "./storage/serviceHostFeed";
import { MAX_BLOB_BYTES } from "./wireLimits";
import {
  createWorkspaceReplicationRoutes,
  enforceWorkspaceIdentity,
  logCoordinateAnswer,
  parseOptionalWorkspaceIdentityQuery,
  servedLogOp,
} from "./workspaceReplicationRoutes";

// The service host's own feed: one per workspace, holding only the documents
// it hosts. Unlike a share recipient's feed, it serves each admitted row
// unchanged, because activation and settlement need the document's object,
// lineage, moment and journal coordinates. Admission is by the object a row
// names, so a hosted document's history before it entered a share is served,
// and no other object's row or bytes ever are.

const MAX_BLOB_HAVE = 2_000;
const REACH_PAGE_ROWS = 500;

type DocumentClaim = { objectId: unknown; versionId: unknown; path: unknown; workspaceId: unknown };

// The document a row names, read where each kind states it.
function claimedDocument(opKind: string, payload: Record<string, unknown>): DocumentClaim | null {
  if (opKind === "moment.append" || opKind === "ydoc.update") {
    return { objectId: payload.objectId, versionId: payload.versionId, path: payload.path, workspaceId: undefined };
  }
  if (opKind === "live.audit.application") {
    return { objectId: payload.objectId, versionId: payload.mainVersionId, path: undefined, workspaceId: undefined };
  }
  const record = asRecord(payload.record);
  const binding = asRecord(opKind === "live.audit.settlement" ? record?.binding
    : opKind === "live.audit.base" ? asRecord(record?.checkpoint)?.binding : undefined);
  return binding && { objectId: binding.objectId, versionId: binding.mainVersionId, path: binding.currentPath, workspaceId: binding.workspaceId };
}

function hostedObject(scope: ServiceHostFeedScope, claim: DocumentClaim | null, documents: ReadonlyMap<string, string>): string | null {
  if (!claim || claim.versionId !== "main" || typeof claim.objectId !== "string" || !documents.has(claim.objectId)) return null;
  return claim.workspaceId === undefined || claim.workspaceId === scope.workspaceId ? claim.objectId : null;
}

const absent = (value: unknown) => value === undefined || value === null;

export type HostedRowDecision = { allowed: false } | { allowed: true; objectId: string | null; blobSha256s: string[] };

/** Whether the host may read a row, and the blobs that row lets it fetch. */
export function hostedRowDecision(
  scope: ServiceHostFeedScope,
  row: Pick<SyncRelayLogRow, "opKind" | "payloadJson" | "recordedAtMs">,
): HostedRowDecision {
  let payload: unknown;
  try { payload = JSON.parse(row.payloadJson); } catch { return { allowed: false }; }
  const record = asRecord(payload);
  if (!record) return { allowed: false };
  if (row.opKind === "workspace.init") {
    return Object.keys(record).length === 0 ? { allowed: true, objectId: null, blobSha256s: [] } : { allowed: false };
  }
  const objectId = hostedObject(scope, claimedDocument(row.opKind, record), scope.shared);
  if (objectId === null) return { allowed: false };
  // A moment that replaced another object names that object's content as its
  // before state. The row carries the lineage; the other object's bytes stay.
  const foreignBefore = row.opKind === "moment.append" && !absent(record.beforeObjectId) && record.beforeObjectId !== objectId;
  const blobSha256s = foreignBefore
    ? typeof record.payloadAfterBlobSha256 === "string" ? [record.payloadAfterBlobSha256] : []
    : referencedBlobShas(row.opKind, row.payloadJson, { workspaceId: scope.workspaceId, recordedAtMs: row.recordedAtMs });
  return { allowed: true, objectId, blobSha256s };
}

/**
 * Whether the host may append an op. It may write only the content of a
 * document it hosts, where that document is enrolled: never move, delete or
 * replace it, and never touch another file. A revoked share leaves its
 * enrolled documents writable, so edits the relay already accepted can settle.
 */
export function hostedWriteAllowed(scope: ServiceHostFeedScope, opKind: string, payload: unknown): boolean {
  const record = asRecord(payload);
  if (!record) return false;
  const claim = claimedDocument(opKind, record);
  const objectId = hostedObject(scope, claim, scope.hosted);
  if (objectId === null) return false;
  if (opKind === "live.audit.application") return true;
  const path = scope.hosted.get(objectId)!;
  if (claim!.path !== path) return false;
  if (opKind === "ydoc.update") return record.contentKind === "richdoc";
  if (opKind !== "moment.append") return true;
  return record.operation === "write" && record.payloadAfterPath === path &&
    [record.payloadBeforePath, record.beforePath].every(value => absent(value) || value === path) &&
    (absent(record.beforeObjectId) || record.beforeObjectId === objectId);
}

/** The blobs the host's current documents reference, extended as their rows arrive. */
function createBlobReach(storage: Pick<SyncRelayStorage, "listServiceHostDocumentRows">) {
  const reach = new Map<string, { token: string; through: Map<string, number>; blobs: Set<string> }>();
  return (scope: ServiceHostFeedScope): ReadonlySet<string> => {
    let entry = reach.get(scope.workspaceId);
    // A changed scope rebuilds, so a document that left it takes its blobs along.
    if (entry?.token !== scope.token) {
      entry = { token: scope.token, through: new Map(), blobs: new Set() };
      reach.set(scope.workspaceId, entry);
    }
    for (const objectId of scope.shared.keys()) {
      for (;;) {
        const afterRelaySeq = entry.through.get(objectId) ?? 0;
        const rows = storage.listServiceHostDocumentRows({ workspaceId: scope.workspaceId, objectId, afterRelaySeq, limit: REACH_PAGE_ROWS });
        for (const row of rows) {
          const decision = hostedRowDecision(scope, row);
          if (decision.allowed) for (const sha256 of decision.blobSha256s) entry.blobs.add(sha256);
          entry.through.set(objectId, row.relaySeq);
        }
        if (rows.length < REACH_PAGE_ROWS) break;
      }
    }
    return entry.blobs;
  };
}

/**
 * Routes under `/sync/:workspaceId/hosted/`. The caller has authenticated a
 * service host credential for the workspace owner; this decides scope.
 * A row or blob outside the scope answers exactly as an absent one.
 */
export function createServiceHostFeed(storage: SyncRelayStorage) {
  // It passes no session reauthentication, so a held log read answers at once.
  const replication = createWorkspaceReplicationRoutes(storage, Date.now, { wakeLog() {}, wait: async () => {} });
  const blobReach = createBlobReach(storage);
  const currentScope = (workspaceId: string) => {
    const scope = storage.readServiceHostFeedScope(workspaceId);
    if (!scope) throw notFound();
    return scope;
  };

  return async (request: Request, input: { workspaceId: string; route: readonly string[]; actor: { userId: string }; guard(): void }) => {
    const { workspaceId, route, guard } = input;
    guard();
    const url = new URL(request.url);
    const [head, second, third] = route;

    if (head === "bootstrap" && route.length === 1 && request.method === "GET") {
      const scope = currentScope(workspaceId);
      return jsonResponse({ ok: true, hasContent: scope.shared.size > 0,
        replicationEpoch: scope.replicationEpoch, streamIdentity: scope.streamIdentity });
    }

    if (head === "log" && route.length === 1 && request.method === "GET") {
      const identity = parseOptionalWorkspaceIdentityQuery(url.searchParams);
      const epochLogFloor = enforceWorkspaceIdentity(storage, workspaceId, identity);
      const requestedSince = parseCursor(url.searchParams.get("since"));
      const limit = parseLimit(url.searchParams.get("limit"));
      const scope = currentScope(workspaceId);
      const described = { token: scope.token, documents: [...scope.shared].map(([objectId, path]) => ({ objectId, path })) };
      // A reader still on an older scope learns the new one before any row:
      // it must backfill a document that joined, even below its cursor.
      if (url.searchParams.get("scope") !== scope.token) {
        return jsonResponse({ ok: true, scope: described, ops: [], nextCursor: requestedSince, hasMore: false });
      }
      const objects = new Set(url.searchParams.getAll("object"));
      if ([...objects].some(objectId => !scope.shared.has(objectId))) throw badRequest("object is not in this scope");
      const since = Math.max(requestedSince, epochLogFloor);
      const page = scanFilteredLog(storage, { workspaceId, since, limit, maxRawRows: MAX_RAW_ROWS_PER_LINK_PAGE }, row => {
        const decision = hostedRowDecision(scope, row);
        if (!decision.allowed) return null;
        if (objects.size && (decision.objectId === null || !objects.has(decision.objectId))) return null;
        return servedLogOp(row);
      });
      return jsonResponse({ ok: true, scope: described, ops: page.items,
        nextCursor: page.nextCursor === since ? requestedSince : page.nextCursor, hasMore: page.hasMore });
    }

    if (head === "log" && route.length === 1 && request.method === "POST") {
      const body = await readJsonObject(request);
      const ops = Array.isArray(body.ops) ? body.ops : [];
      // Checked again under the append's writer, where the scope cannot move.
      const admitted = () => {
        guard();
        const scope = currentScope(workspaceId);
        for (const op of ops) {
          const row = asRecord(op);
          if (!row || typeof row.opKind !== "string" || !hostedWriteAllowed(scope, row.opKind, row.payload)) {
            throw relayError("share_op_rejected", "an op is outside the hosted documents");
          }
        }
      };
      admitted();
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      const forwarded = new Request(request.url, { method: "POST", headers, body: JSON.stringify(body), signal: request.signal });
      return await replication.respondToWorkspaceReplication(forwarded, { route: "log", workspaceId }, input.actor, admitted);
    }

    if (head === "log" && route.length === 3 && request.method === "GET") {
      const originSeq = Number(third);
      if (!second || !/^\d+$/.test(third ?? "") || !Number.isSafeInteger(originSeq)) throw notFound();
      const epochLogFloor = enforceWorkspaceIdentity(storage, workspaceId, parseOptionalWorkspaceIdentityQuery(url.searchParams));
      const row = storage.fetchLogCoordinate({ workspaceId, originId: second, originSeq });
      const scope = currentScope(workspaceId);
      return jsonResponse(logCoordinateAnswer(row && hostedRowDecision(scope, row).allowed ? row : null, epochLogFloor));
    }

    if (head === "blobs" && second === "have" && route.length === 2 && request.method === "POST") {
      const body = await readJsonObject(request);
      if (!Array.isArray(body.sha256s)) throw badRequest("sha256s must be an array");
      if (body.sha256s.length > MAX_BLOB_HAVE) throw badRequest("too many sha256s");
      const sha256s = body.sha256s.map((value: unknown) => {
        if (typeof value !== "string") throw badRequest("sha256s must be strings");
        assertSha256(value);
        return value;
      });
      guard();
      const reach = blobReach(currentScope(workspaceId));
      const stored = new Set(sha256s.filter(sha256 => reach.has(sha256)));
      for (const sha256 of storage.missingBlobs(workspaceId, [...stored])) stored.delete(sha256);
      return jsonResponse({ ok: true, missing: sha256s.filter(sha256 => !stored.has(sha256)) });
    }

    if (head === "blobs" && second && second !== "have" && route.length === 2 && request.method === "GET") {
      assertSha256(second);
      const blob = blobReach(currentScope(workspaceId)).has(second) ? storage.getBlob(workspaceId, second) : null;
      if (!blob) throw relayError("blob_not_found");
      return new Response(arrayBufferForBytes(blob), { status: 200, headers: { "content-type": "application/octet-stream" } });
    }

    if (head === "blobs" && second && second !== "have" && route.length === 2 && request.method === "PUT") {
      assertSha256(second);
      const bytes = await readBytes(request, MAX_BLOB_BYTES);
      if (sha256Hex(bytes) !== second) throw badRequest("blob content does not match sha256 path");
      guard();
      const known = blobReach(currentScope(workspaceId)).has(second);
      const put = storage.putBlob({ workspaceId, sha256: second, content: bytes, createdAtMs: Date.now() });
      // Whether the owner already held these bytes is theirs to know, unless a hosted row names them.
      return jsonResponse({ ok: true, workspaceId, sha256: second, byteLength: put.byteLength, alreadyHad: put.alreadyHad && known });
    }

    throw notFound();
  };
}
