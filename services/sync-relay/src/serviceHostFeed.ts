import { jsonResponse } from "@dohc/service-http";
import { asRecord } from "@dohc/workspace-core";
import { sha256Hex } from "@dohc/workspace-core/hash";
import { badRequest, notFound, relayError } from "./errors";
import { arrayBufferForBytes, readBytes } from "./relayBytes";
import { assertSha256, parseCursor, parseLimit, readJsonObject } from "./requestInputs";
import { MAX_RAW_ROWS_PER_LINK_PAGE, scanFilteredLog } from "./shareReadQueries";
import type { SyncRelayLogInput, SyncRelayLogRow, SyncRelayStorage } from "./storage";
import { referencedBlobShas } from "./storage/blobReferences";
import { logBlobsMissing } from "./storage/errors";
import { readRefusal, refuseOp } from "./storage/relayAdmission";
import type { ServiceHostFeedScope } from "./storage/serviceHostFeed";
import type { ServiceActivationRetirement } from "./storage/serviceActivationRetirement";
import { chargesProofBudget, type RetirementRefusal } from "./storage/serviceActivationPublication";
import { MAX_BLOB_BYTES } from "./wireLimits";
import {
  createWorkspaceReplicationRoutes,
  enforceWorkspaceIdentity,
  type HostedAdmission,
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
const REACH_IDLE_MS = 10 * 60_000;

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
  row: Pick<SyncRelayLogRow, "opKind" | "payloadJson" | "recordedAtMs" | "settlementAdmission">,
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
  // A refused row stays in the history but grants no bytes: append never checked its blobs.
  if (row.settlementAdmission?.status === "refused") return { allowed: true, objectId, blobSha256s: [] };
  // A moment that replaced another object names that object's content as its
  // before state. The row carries the lineage; the other object's bytes stay.
  const foreignBefore = row.opKind === "moment.append" && !absent(record.beforeObjectId) && record.beforeObjectId !== objectId;
  const blobSha256s = foreignBefore
    ? typeof record.payloadAfterBlobSha256 === "string" ? [record.payloadAfterBlobSha256] : []
    : referencedBlobShas(row.opKind, row.payloadJson, { workspaceId: scope.workspaceId, recordedAtMs: row.recordedAtMs });
  return { allowed: true, objectId, blobSha256s };
}

/**
 * The document an op writes, when the host may append it. It may write only
 * the content of a document it hosts or settles, at its enrolled or bound
 * path: never move, delete or replace it, and never touch another file. A
 * revoked share or a move leaves the enabled enrolled document writable, so
 * edits the host accepted can settle.
 */
function hostedWriter(scope: ServiceHostFeedScope, documents: ReadonlyMap<string, string>, opKind: string, payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) return null;
  const claim = claimedDocument(opKind, record);
  const objectId = hostedObject(scope, claim, documents);
  if (objectId === null) return null;
  if (opKind === "live.audit.application") return objectId;
  const path = documents.get(objectId)!;
  if (claim!.path !== path) return null;
  if (opKind === "ydoc.update") return record.contentKind === "richdoc" ? objectId : null;
  if (opKind !== "moment.append") return objectId;
  return record.operation === "write" && record.payloadAfterPath === path &&
    [record.payloadBeforePath, record.beforePath].every(value => absent(value) || value === path) &&
    (absent(record.beforeObjectId) || record.beforeObjectId === objectId) ? objectId : null;
}

export function hostedWriteAllowed(scope: ServiceHostFeedScope, opKind: string, payload: unknown): boolean {
  return hostedWriter(scope, scope.hosted, opKind, payload) !== null;
}

/**
 * Why the relay refused one of the host's ops. A settling document's row the
 * retirement writer could not prove is `unproved-retirement-output`;
 * `retirement-proof-over-budget` is one whose proof no push can finish.
 */
export type HostedRefusalReason = "outside-hosted-documents" | RetirementRefusal;

type HostedPublication = { kind: "accepted" | "departed" } | { kind: "retiring"; retirement: ServiceActivationRetirement } |
  { kind: "refused"; reason: HostedRefusalReason };

/**
 * The decision for one new coordinate. An op may name only blobs the host
 * can fetch now or ones it uploaded, so a write never turns a digest it read
 * into bytes it may fetch. Any other blob fails the request as missing,
 * whether or not the relay holds it: `blobs/have` reports it missing too, so
 * the host uploads it and retries. A document out of the share settles that
 * way. A settling document's row still needs the retirement writer's proof.
 */
function hostedPublication(scope: ServiceHostFeedScope, known: BlobReach, op: SyncRelayLogInput): HostedPublication {
  const payload: unknown = JSON.parse(op.payloadJson);
  const settling = hostedWriter(scope, new Map([...scope.settling].map(([objectId, row]) => [objectId, row.path])), op.opKind, payload);
  const objectId = settling ?? hostedWriter(scope, scope.hosted, op.opKind, payload);
  if (objectId === null) return { kind: "refused", reason: "outside-hosted-documents" };
  const blobs = referencedBlobShas(op.opKind, op.payloadJson, { workspaceId: scope.workspaceId, recordedAtMs: op.recordedAtMs });
  const unknown = blobs.filter(sha256 => !known(sha256));
  if (unknown.length) throw logBlobsMissing(unknown);
  if (settling !== null) return { kind: "retiring", retirement: scope.settling.get(settling)! };
  return { kind: scope.departed.has(objectId) ? "departed" : "accepted" };
}

// Whether the host may upload: a settling document's verified output needs its
// bytes too, though they never join the readable blob reach.
const writable = (scope: ServiceHostFeedScope) => scope.hosted.size > 0 || scope.settling.size > 0;

type DocumentReach = { through: number; blobs: Set<string> };
type WorkspaceReach = { documents: Map<string, DocumentReach>; usedAtMs: number };
/** Whether the host may fetch, or name in a write, a blob. */
type BlobReach = (sha256: string) => boolean;

/**
 * The blobs the host may fetch or name: those the accepted rows of its current
 * documents reference, and those it uploaded itself. Each document's reach
 * extends as its rows arrive and survives other documents joining or leaving.
 * A workspace unused for REACH_IDLE_MS drops its reach, which costs a rescan.
 * Uploads are stored, so a pending write keeps them.
 *
 * Requests await `warm` before they check a blob. It scans each document that
 * has no reach yet a page at a time, yielding between pages, so a rescan of a
 * long history never holds the event loop. `known` stays synchronous for the
 * append's writer and reads only rows above each reach it already has.
 */
function createBlobReach(storage: Pick<SyncRelayStorage, "listServiceHostDocumentRows" | "serviceHostUploaded">) {
  const workspaces = new Map<string, WorkspaceReach>();
  // One warm-up per workspace, which every request that arrives during it awaits.
  const warming = new Map<string, Promise<void>>();
  let sweptAtMs = 0;
  const workspaceReach = (workspaceId: string) => {
    const nowMs = Date.now();
    // A workspace that stopped being hosted never asks again, so others' requests sweep it.
    if (nowMs - sweptAtMs >= REACH_IDLE_MS) {
      sweptAtMs = nowMs;
      for (const [id, entry] of workspaces) if (nowMs - entry.usedAtMs >= REACH_IDLE_MS) workspaces.delete(id);
    }
    let entry = workspaces.get(workspaceId);
    if (!entry) workspaces.set(workspaceId, entry = { documents: new Map(), usedAtMs: nowMs });
    entry.usedAtMs = nowMs;
    return entry;
  };
  // Extends a document's reach by one page, and tells whether it reached the end of the history.
  const extend = (scope: ServiceHostFeedScope, document: DocumentReach, objectId: string) => {
    const rows = storage.listServiceHostDocumentRows({ workspaceId: scope.workspaceId, objectId, afterRelaySeq: document.through, limit: REACH_PAGE_ROWS });
    for (const row of rows) {
      const decision = hostedRowDecision(scope, row);
      if (decision.allowed) for (const sha256 of decision.blobSha256s) document.blobs.add(sha256);
      document.through = row.relaySeq;
    }
    return rows.length < REACH_PAGE_ROWS;
  };
  const currentReach = (scope: ServiceHostFeedScope) => {
    const entry = workspaceReach(scope.workspaceId);
    // A document that left the scope takes its blobs along.
    for (const objectId of entry.documents.keys()) if (!scope.shared.has(objectId)) entry.documents.delete(objectId);
    return entry;
  };
  const known = (scope: ServiceHostFeedScope): BlobReach => {
    const entry = currentReach(scope);
    // A document with no reach yet grants nothing until a warm-up builds it, so
    // a write naming its blobs fails as missing and lands on the host's retry.
    const reaches = [...scope.shared.keys()].flatMap(objectId => {
      const document = entry.documents.get(objectId);
      if (!document) return [];
      while (!extend(scope, document, objectId));
      return [document.blobs];
    });
    return sha256 => reaches.some(blobs => blobs.has(sha256)) || storage.serviceHostUploaded(scope.workspaceId, sha256);
  };
  const warm = (workspaceId: string, readScope: () => ServiceHostFeedScope): Promise<void> => {
    let running = warming.get(workspaceId);
    if (running) return running;
    running = (async () => {
      // A reach is kept only once complete, so no request reads part of one.
      const building = new Map<string, DocumentReach>();
      for (;;) {
        const scope = readScope(), entry = currentReach(scope);
        const objectId = [...scope.shared.keys()].find(id => !entry.documents.has(id));
        if (objectId === undefined) return;
        let document = building.get(objectId);
        if (!document) building.set(objectId, document = { through: 0, blobs: new Set() });
        if (extend(scope, document, objectId)) entry.documents.set(objectId, document);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    })().finally(() => warming.delete(workspaceId));
    warming.set(workspaceId, running);
    return running;
  };
  return { warm, known };
}

/**
 * Routes under `/sync/:workspaceId/hosted/`. The caller has authenticated a
 * service host credential for the workspace owner; this decides scope.
 * A row or blob outside the scope answers exactly as an absent one.
 */
export function createServiceHostFeed(storage: SyncRelayStorage) {
  // It passes no session reauthentication, so a held log read answers at once.
  const replication = createWorkspaceReplicationRoutes(storage, Date.now, { wakeLog() {}, wait: async () => {} }, { watched: () => false });
  const blobReach = createBlobReach(storage);
  const currentScope = (workspaceId: string) => {
    const scope = storage.readServiceHostFeedScope(workspaceId);
    if (!scope) throw notFound();
    return scope;
  };
  const warmReach = (workspaceId: string) => blobReach.warm(workspaceId, () => currentScope(workspaceId));

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
      // Each coordinate gets its own decision. A refused op still takes its
      // coordinate, as a relay-written refusal, so the host's later ops land.
      // What the scope already rules out is refused, and a blob out of reach
      // fails the request, before preparation, which must never probe a blob
      // the host may not name; the rest is decided again under the append's
      // writer, where the scope cannot move.
      const received = new WeakMap<SyncRelayLogInput, string>();
      const refuse = (op: SyncRelayLogInput, reason: HostedRefusalReason) =>
        refuseOp(op, { opKind: op.opKind, payloadSha256: received.get(op)!, reason });
      let pushOrigin = "", batched = false;
      const admission: HostedAdmission = {
        async screen(originId, ops) {
          await warmReach(workspaceId);
          guard();
          pushOrigin = originId;
          const scope = currentScope(workspaceId), known = blobReach.known(scope);
          const held = storage.maxOriginSeq(workspaceId, originId);
          const audits: SyncRelayLogInput[] = [];
          let proofs = 0;
          for (const op of ops) {
            received.set(op, sha256Hex(op.payloadJson));
            if (op.originSeq > held) {
              const decision = hostedPublication(scope, known, op);
              if (decision.kind === "refused") refuse(op, decision.reason);
              else {
                if (chargesProofBudget(op)) proofs++;
                // A settlement audit's proof waits for no companion moment, so it is proved here.
                if (decision.kind === "retiring" && op.opKind === "live.audit.settlement") audits.push(op);
              }
              continue;
            }
            // A retried refusal gets its original decision; anything else at a held coordinate is compared on append.
            const stored = storage.fetchLogCoordinate({ workspaceId, originId, originSeq: op.originSeq });
            const refusal = stored && readRefusal(stored);
            if (refusal && refusal.opKind === op.opKind && refusal.payloadSha256 === received.get(op) && stored.recordedAtMs === op.recordedAtMs) {
              refuseOp(op, refusal);
            }
          }
          // Only a push holding another proof can leave room for an exhausted one by halving.
          batched = proofs > 1;
          if (audits.length) await storage.prepareSettlementAudits({ workspaceId, ops: audits, batched }, request.signal);
        },
        admit(ops) {
          const scope = currentScope(workspaceId), known = blobReach.known(scope);
          const batch = { originId: pushOrigin, ops: new Map(ops.map(op => [op.originSeq, op])), batched };
          for (const op of ops) {
            if (op.relayAdmission === "refused") continue;
            const decision = hostedPublication(scope, known, op);
            if (decision.kind === "refused") refuse(op, decision.reason);
            else if (decision.kind === "retiring") {
              // Verified retirement output keeps its history and moves no projection.
              const refusal = storage.admitRetirementPublication(decision.retirement, op, batch);
              if (refusal === null) op.relayAdmission = "departed";
              else refuse(op, refusal);
            } else if (decision.kind === "departed") op.relayAdmission = "departed";
          }
        },
        confirm(ops) {
          for (const op of ops) if (op.relayAdmission === "departed" && !storage.retirementPublicationConfirmed(op)) refuse(op, "unproved-retirement-output");
        },
      };
      return await replication.respondToWorkspaceReplication(request, { route: "log", workspaceId, serviceHost: admission }, input.actor,
        () => { guard(); currentScope(workspaceId); });
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
      currentScope(workspaceId);
      const body = await readJsonObject(request);
      if (!Array.isArray(body.sha256s)) throw badRequest("sha256s must be an array");
      if (body.sha256s.length > MAX_BLOB_HAVE) throw badRequest("too many sha256s");
      const sha256s = body.sha256s.map((value: unknown) => {
        if (typeof value !== "string") throw badRequest("sha256s must be strings");
        assertSha256(value);
        return value;
      });
      await warmReach(workspaceId);
      guard();
      const scope = currentScope(workspaceId);
      // With no hosted or settling document the log refuses every op before it
      // checks a blob, so the host uploads nothing and its last pushes are refused.
      if (!writable(scope)) return jsonResponse({ ok: true, missing: [] });
      const stored = new Set(sha256s.filter(blobReach.known(scope)));
      for (const sha256 of storage.missingBlobs(workspaceId, [...stored])) stored.delete(sha256);
      return jsonResponse({ ok: true, missing: sha256s.filter(sha256 => !stored.has(sha256)) });
    }

    if (head === "blobs" && second && second !== "have" && route.length === 2 && request.method === "GET") {
      assertSha256(second);
      await warmReach(workspaceId);
      guard();
      const blob = blobReach.known(currentScope(workspaceId))(second) ? storage.getBlob(workspaceId, second) : null;
      if (!blob) throw relayError("blob_not_found");
      return new Response(arrayBufferForBytes(blob), { status: 200, headers: { "content-type": "application/octet-stream" } });
    }

    if (head === "blobs" && second && second !== "have" && route.length === 2 && request.method === "PUT") {
      assertSha256(second);
      guard();
      let scope = currentScope(workspaceId);
      if (!writable(scope)) throw notFound();
      const bytes = await readBytes(request, MAX_BLOB_BYTES);
      if (sha256Hex(bytes) !== second) throw badRequest("blob content does not match sha256 path");
      await warmReach(workspaceId);
      guard();
      scope = currentScope(workspaceId);
      if (!writable(scope)) throw notFound();
      const known = blobReach.known(scope)(second);
      const put = storage.putServiceHostBlob({ workspaceId, sha256: second, content: bytes, createdAtMs: Date.now() });
      // Whether the owner already held these bytes is theirs to know, unless the host could already fetch them.
      return jsonResponse({ ok: true, workspaceId, sha256: second, byteLength: put.byteLength, alreadyHad: put.alreadyHad && known });
    }

    throw notFound();
  };
}
