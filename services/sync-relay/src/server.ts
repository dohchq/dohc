import { createHash, randomUUID } from "node:crypto";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import {
  filterOpForShare,
  parseShareSelectorJson,
  validateShareSelector,
  type ShareSelector,
} from "./shareFilter";
import {
  SyncRelayConflictError,
  SyncRelayQuotaExceededError,
  type SyncRelayLogInput,
  type SyncRelayShareRow,
  type SyncRelayStorage,
} from "./storage";

export type SyncRelayHandler = (request: Request) => Promise<Response>;

export interface CreateSyncRelayHandlerOptions {
  storage: SyncRelayStorage;
  resolveActor: ResolveActor;
  nowMs?: () => number;
  // Share-grant recipient lookup: maps an email to the relay account id, or
  // null when no account matches. Absent means email-addressed grants are
  // unavailable (grants by user id still work).
  resolveUserIdByEmail?: (email: string) => Promise<string | null> | string | null;
  // Display-only reverse lookup for share listings; never used for authz.
  lookupUserEmail?: (userId: string) => Promise<string | null> | string | null;
  newShareId?: () => string;
}

type SyncRelayRoute =
  | { route: "workspaces" }
  | { route: "blob"; workspaceId: string; sha256: string }
  | { route: "blob-have"; workspaceId: string }
  | { route: "gc"; workspaceId: string }
  | { route: "keys"; workspaceId: string }
  | { route: "log"; workspaceId: string }
  | { route: "shares-create"; workspaceId: string }
  | { route: "shares-list" }
  | { route: "share"; shareId: string }
  | { route: "share-revoke"; shareId: string }
  | { route: "share-log"; shareId: string }
  | { route: "share-blob"; shareId: string; sha256: string };

// Transport cap, deliberately LARGER than the engine's 5 MiB binary-file
// limit (MAX_VERSIONED_BINARY_FILE_BYTES): text blobs need the headroom and
// the relay never parses content, so it cannot tell text from binary.
// Clients enforce the engine limit by referenced kind on hydrate
// (workspace-engine syncApply) — an oversized BINARY blob a peer smuggles
// under this cap is rejected client-side as a protocol violation.
export const MAX_BLOB_BYTES = 10 * 1024 * 1024;
export const MAX_KEY_ENVELOPE_BYTES = 16 * 1024;
export const MAX_OPS_PER_REQUEST = 500;
export const MAX_PAYLOAD_JSON_BYTES = 256 * 1024;
export const DEFAULT_LOG_PAGE_SIZE = 100;
export const MAX_LOG_PAGE_SIZE = 500;

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const MAX_WORKSPACE_ID_CHARS = 256;
const MAX_ORIGIN_ID_CHARS = 256;
const MAX_OP_KIND_CHARS = 128;
const MAX_EMAIL_CHARS = 320;
const MAX_SHARE_ID_CHARS = 128;

export function createSyncRelayHandler({
  storage,
  resolveActor,
  nowMs = () => Date.now(),
  resolveUserIdByEmail,
  lookupUserEmail,
  newShareId = () => randomUUID(),
}: CreateSyncRelayHandlerOptions): SyncRelayHandler {
  // Loads a share for RECIPIENT access. Every failure mode — no such share,
  // revoked share, caller is not the recipient, granter lost the workspace —
  // is the same generic 404 the relay uses for absent workspaces, so probing
  // recipients cannot distinguish "never existed" from "exists but not
  // yours" from "was revoked".
  const shareForRecipient = (shareId: string, userId: string): SyncRelayShareRow & { selector: ShareSelector } => {
    const share = storage.getShare(shareId);
    if (!share) throw notFound();
    if (share.recipientUserId !== userId) throw notFound();
    if (share.revokedAtMs !== null) throw notFound();
    // Defensive: the grant is only as good as the granter's own standing.
    if (!storage.workspaceIsOwnedBy(share.workspaceId, share.granterUserId)) throw notFound();
    const selector = parseShareSelectorJson(share.selectorJson);
    if (!selector) throw notFound();
    return { ...share, selector };
  };

  // Lazy claim of pending email invites (PR 18 gate fix): the first time an
  // invited account authenticates to the relay, any share addressed to its
  // email becomes a real grant (recipient_user_id filled in). The session
  // email is server-derived (never client-supplied), so this cannot be used
  // to claim someone else's invite.
  const claimPendingShares = async (userId: string): Promise<void> => {
    if (!lookupUserEmail) return;
    const email = await lookupUserEmail(userId);
    if (email) storage.claimPendingSharesForEmail(email, userId);
  };

  const shareSummary = async (
    share: SyncRelayShareRow,
    side: "granted" | "received",
  ): Promise<Record<string, unknown>> => {
    const selector = parseShareSelectorJson(share.selectorJson);
    const base = {
      shareId: share.shareId,
      selector: selector ?? { paths: [], versionId: null },
      createdAtMs: share.createdAtMs,
    };
    if (side === "granted") {
      // A pending invite has no recipient user id yet; surface the addressed
      // email the granter typed. A claimed/real share resolves the email from
      // its recipient id for display.
      const recipientEmail = share.recipientUserId
        ? lookupUserEmail
          ? await lookupUserEmail(share.recipientUserId)
          : null
        : share.recipientEmail;
      return {
        ...base,
        workspaceId: share.workspaceId,
        recipientUserId: share.recipientUserId,
        recipientEmail,
        revokedAtMs: share.revokedAtMs,
      };
    }
    // Received summaries deliberately omit the workspace id: the recipient's
    // access is share-scoped, and the granter's workspace identity is not
    // theirs to see.
    return {
      ...base,
      granterUserId: share.granterUserId,
      granterEmail: lookupUserEmail ? await lookupUserEmail(share.granterUserId) : null,
    };
  };

  return async (request) => {
    try {
      const route = parseRoute(request);
      const actor = await resolveActor(request, "workspaceId" in route ? route.workspaceId : "");

      if (route.route === "workspaces" && request.method === "POST") {
        const input = await readJsonObject(request);
        const workspaceId = parseWorkspaceId(input.workspaceId);
        const result = storage.claimWorkspace({
          workspaceId,
          ownerUserId: actor.userId,
          createdAtMs: nowMs(),
        });
        if (result === "not-owner") throw notFound();
        return jsonResponse({ ok: true, workspaceId, created: result === "created" });
      }

      if (route.route === "workspaces") throw methodNotAllowed();

      if (route.route === "shares-list" && request.method === "GET") {
        await claimPendingShares(actor.userId);
        const granted = await Promise.all(
          storage.listSharesGrantedBy(actor.userId).map((share) => shareSummary(share, "granted")),
        );
        const received = await Promise.all(
          storage
            .listSharesReceivedBy(actor.userId)
            .map((share) => shareSummary(share, "received")),
        );
        return jsonResponse({ ok: true, granted, received });
      }
      if (route.route === "shares-list") throw methodNotAllowed();

      if (route.route === "share" && request.method === "GET") {
        await claimPendingShares(actor.userId);
        const share = shareForRecipient(route.shareId, actor.userId);
        return jsonResponse({ ok: true, ...(await shareSummary(share, "received")) });
      }
      if (route.route === "share") throw methodNotAllowed();

      if (route.route === "share-revoke" && request.method === "POST") {
        const share = storage.getShare(route.shareId);
        // Only the granter may revoke; anyone else (including the recipient)
        // sees the byte-identical generic 404.
        if (!share || share.granterUserId !== actor.userId) throw notFound();
        storage.revokeShare(route.shareId, nowMs());
        return jsonResponse({ ok: true, shareId: route.shareId });
      }
      if (route.route === "share-revoke") throw methodNotAllowed();

      if (route.route === "share-log" && request.method === "GET") {
        await claimPendingShares(actor.userId);
        const share = shareForRecipient(route.shareId, actor.userId);
        const url = new URL(request.url);
        const since = parseCursor(url.searchParams.get("since"));
        const limit = parseLimit(url.searchParams.get("limit"));
        const page = storage.fetchLogPage({
          workspaceId: share.workspaceId,
          sinceRelaySeq: since,
          limit,
        });
        // THE share security boundary: each op passes the fail-closed filter
        // or is dropped from the response. The cursor still advances over
        // dropped rows (the recipient sees a sparser page, never a stalled
        // one), and payloads are the filter's (possibly redacted) copy.
        const ops: Array<Record<string, unknown>> = [];
        for (const row of page.rows) {
          const decision = filterOpForShare(share.selector, row.opKind, row.payloadJson);
          if (!decision.allowed) continue;
          ops.push({
            relaySeq: row.relaySeq,
            originId: row.originId,
            originSeq: row.originSeq,
            opKind: row.opKind,
            payload: decision.payload,
            recordedAtMs: row.recordedAtMs,
          });
        }
        // Re-check revocation immediately before returning the body: a revoke
        // that raced with this in-flight read (after the entry check, while
        // the page was assembled) must abort the response, not leak a final
        // filtered page. Re-loading the share throws the same generic 404.
        shareForRecipient(route.shareId, actor.userId);
        return jsonResponse({
          ok: true,
          ops,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        });
      }
      if (route.route === "share-log") throw methodNotAllowed();

      if (route.route === "share-blob" && request.method === "GET") {
        await claimPendingShares(actor.userId);
        const share = shareForRecipient(route.shareId, actor.userId);
        assertSha256(route.sha256);
        // A blob is served to a recipient ONLY when at least one op that
        // passes the share filter legitimately references it. Everything
        // else — a blob of an unshared file, a secret ciphertext blob, a
        // random hash — is the same generic 404 as a nonexistent share.
        const candidates = storage.listLogRowsReferencing(share.workspaceId, route.sha256);
        const reachable = candidates.some((row) => {
          const decision = filterOpForShare(share.selector, row.opKind, row.payloadJson);
          return decision.allowed && decision.blobSha256s.includes(route.sha256);
        });
        if (!reachable) throw notFound();
        const blob = storage.getBlob(share.workspaceId, route.sha256);
        if (!blob) throw notFound();
        // Re-check revocation immediately before returning the blob body: a
        // revoke that raced with this in-flight read must abort rather than
        // serve a final shared blob. The re-load throws the same generic 404.
        shareForRecipient(route.shareId, actor.userId);
        return new Response(arrayBufferForBytes(blob), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (route.route === "share-blob") throw methodNotAllowed();

      if (!storage.workspaceIsOwnedBy(route.workspaceId, actor.userId)) throw notFound();

      if (route.route === "gc" && request.method === "POST") {
        const result = await storage.collectUnreferencedBlobs(route.workspaceId, {
          nowMs: nowMs(),
        });
        return jsonResponse({ ok: true, ...result });
      }
      if (route.route === "gc") throw methodNotAllowed();

      if (route.route === "shares-create" && request.method === "POST") {
        const input = await readJsonObject(request);
        const validation = validateShareSelector({
          paths: input.paths,
          versionId: input.versionId,
        });
        if (!validation.ok) {
          throw new HttpError(400, validation.code, validation.message);
        }
        const shareId = newShareId();
        const createdAtMs = nowMs();

        // Sharing by explicit user id: the granter already knows the id, so
        // there is no account existence to leak — echo it back.
        if (input.recipientUserId !== undefined) {
          const recipientUserId = parseString(
            input.recipientUserId,
            "recipientUserId",
            MAX_ORIGIN_ID_CHARS,
          );
          if (recipientUserId === actor.userId) throw selfShare();
          storage.createShare({
            shareId,
            workspaceId: route.workspaceId,
            granterUserId: actor.userId,
            recipientUserId,
            recipientEmail: null,
            selectorJson: JSON.stringify(validation.selector),
            createdAtMs,
          });
          return jsonResponse({
            ok: true,
            shareId,
            workspaceId: route.workspaceId,
            recipientUserId,
            selector: validation.selector,
            createdAtMs,
          });
        }

        // Sharing by email. To close the account-enumeration oracle, the
        // response is IDENTICAL whether or not the email has a dohc account:
        // a known account becomes an immediate recipient, an unknown email
        // becomes a PENDING invite (claimed when that account first touches
        // the relay). Either way the response never echoes a recipient user
        // id, so the granter cannot distinguish "has an account" from "does
        // not" by inspecting the reply.
        const email = parseString(input.recipientEmail, "recipientEmail", MAX_EMAIL_CHARS);
        if (!resolveUserIdByEmail) {
          throw badRequest("recipient email lookup is not available on this relay");
        }
        const resolved = await resolveUserIdByEmail(email);
        if (resolved === actor.userId) throw selfShare();
        storage.createShare({
          shareId,
          workspaceId: route.workspaceId,
          granterUserId: actor.userId,
          recipientUserId: resolved ?? null,
          recipientEmail: resolved ? null : email.trim().toLowerCase(),
          selectorJson: JSON.stringify(validation.selector),
          createdAtMs,
        });
        return jsonResponse({
          ok: true,
          shareId,
          workspaceId: route.workspaceId,
          selector: validation.selector,
          createdAtMs,
        });
      }
      if (route.route === "shares-create") throw methodNotAllowed();

      if (route.route === "blob" && request.method === "PUT") {
        assertSha256(route.sha256);
        const bytes = await readBytes(request, MAX_BLOB_BYTES);
        const actual = sha256Hex(bytes);
        if (actual !== route.sha256) {
          throw badRequest("blob content does not match sha256 path");
        }
        const put = storage.putBlob({
          workspaceId: route.workspaceId,
          sha256: route.sha256,
          content: bytes,
          createdAtMs: nowMs(),
        });
        return jsonResponse({
          ok: true,
          workspaceId: route.workspaceId,
          sha256: route.sha256,
          byteLength: put.byteLength,
          alreadyHad: put.alreadyHad,
        });
      }

      if (route.route === "blob" && request.method === "GET") {
        assertSha256(route.sha256);
        const blob = storage.getBlob(route.workspaceId, route.sha256);
        // Distinct from the absent-workspace 404: the caller already proved
        // ownership above, so this leaks nothing about other tenants, and
        // sync clients must be able to tell missing content apart from an
        // unavailable workspace.
        if (!blob) throw blobNotFound();
        return new Response(arrayBufferForBytes(blob), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }

      if (route.route === "blob-have" && request.method === "POST") {
        const input = await readJsonObject(request);
        if (!Array.isArray(input.sha256s)) throw badRequest("sha256s must be an array");
        if (input.sha256s.length > 2_000) throw badRequest("too many sha256s");
        const sha256s = input.sha256s.map((value) => {
          if (typeof value !== "string") throw badRequest("sha256s must be strings");
          assertSha256(value);
          return value;
        });
        return jsonResponse({
          ok: true,
          missing: storage.missingBlobs(route.workspaceId, sha256s),
        });
      }

      if (route.route === "keys" && request.method === "PUT") {
        const bytes = await readBytes(request, MAX_KEY_ENVELOPE_BYTES);
        const envelopeJson = Buffer.from(bytes).toString("utf8");
        try {
          const parsed = JSON.parse(envelopeJson);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("not object");
          }
        } catch {
          throw badRequest("key envelope must be a JSON object");
        }
        // Create-only on first write; CAS via If-Match (sha256 of the envelope
        // being replaced) thereafter. A stale or absent precondition is a 409,
        // never a silent overwrite — the envelope is the only recovery path
        // for the wrapped workspace key. Replaced envelopes are retained in
        // the history table by storage.putKeyEnvelope.
        const result = storage.putKeyEnvelope({
          workspaceId: route.workspaceId,
          envelopeJson,
          updatedAtMs: nowMs(),
          expectedSha256: parseIfMatchSha256(request.headers.get("if-match")),
        });
        return jsonResponse(
          { ok: true, workspaceId: route.workspaceId, sha256: result.sha256 },
          200,
          { etag: `"${result.sha256}"` },
        );
      }

      if (route.route === "keys" && request.method === "GET") {
        const envelope = storage.getKeyEnvelope(route.workspaceId);
        if (!envelope) throw keyEnvelopeNotFound();
        return new Response(envelope.envelopeJson, {
          status: 200,
          headers: {
            "content-type": "application/json",
            // Current fingerprint + write time so clients can detect that the
            // envelope they enrolled with has been replaced.
            etag: `"${envelope.sha256}"`,
            "x-key-envelope-updated-at-ms": String(envelope.updatedAtMs),
          },
        });
      }

      if (route.route === "log" && request.method === "POST") {
        const input = await readJsonObject(request);
        const originId = parseString(input.originId, "originId", MAX_ORIGIN_ID_CHARS);
        if (!Array.isArray(input.ops)) throw badRequest("ops must be an array");
        if (input.ops.length > MAX_OPS_PER_REQUEST) throw badRequest("too many ops");
        const ops = input.ops.map(parseLogOp);
        const result = storage.appendLogBatch({
          workspaceId: route.workspaceId,
          originId,
          ops,
        });
        return jsonResponse({
          ok: true,
          accepted: ops.length,
          inserted: result.inserted,
          skipped: result.skipped,
          currentMaxOriginSeq: result.currentMaxOriginSeq,
        });
      }

      if (route.route === "log" && request.method === "GET") {
        const url = new URL(request.url);
        const since = parseCursor(url.searchParams.get("since"));
        const limit = parseLimit(url.searchParams.get("limit"));
        const page = storage.fetchLogPage({
          workspaceId: route.workspaceId,
          sinceRelaySeq: since,
          limit,
        });
        return jsonResponse({
          ok: true,
          ops: page.rows.map((row) => ({
            relaySeq: row.relaySeq,
            workspaceId: row.workspaceId,
            originId: row.originId,
            originSeq: row.originSeq,
            opKind: row.opKind,
            payload: JSON.parse(row.payloadJson) as unknown,
            recordedAtMs: row.recordedAtMs,
          })),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        });
      }

      throw methodNotAllowed();
    } catch (error) {
      return errorResponse(error);
    }
  };
}

function parseRoute(request: Request): SyncRelayRoute {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 2 && parts[0] === "sync" && parts[1] === "workspaces") {
    return { route: "workspaces" };
  }
  if (parts[0] !== "sync" || !parts[1]) throw notFound();
  // "/sync/shares/..." is the share-scoped namespace; "shares" is reserved as
  // a workspace id (parseWorkspaceId below) so the two can never collide.
  if (parts[1] === "shares") {
    if (parts.length === 2) return { route: "shares-list" };
    const shareId = parseShareId(parts[2]);
    if (parts.length === 3) return { route: "share", shareId };
    if (parts.length === 4 && parts[3] === "revoke") return { route: "share-revoke", shareId };
    if (parts.length === 4 && parts[3] === "log") return { route: "share-log", shareId };
    if (parts.length === 5 && parts[3] === "blobs" && parts[4]) {
      return { route: "share-blob", shareId, sha256: parts[4] };
    }
    throw notFound();
  }
  const workspaceId = parseWorkspaceId(parts[1]);
  if (parts.length === 4 && parts[2] === "blobs" && parts[3] === "have") {
    return { route: "blob-have", workspaceId };
  }
  if (parts.length === 4 && parts[2] === "blobs" && parts[3]) {
    return { route: "blob", workspaceId, sha256: parts[3] };
  }
  if (parts.length === 4 && parts[2] === "maintenance" && parts[3] === "gc") {
    return { route: "gc", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "log") {
    return { route: "log", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "keys") {
    return { route: "keys", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "shares") {
    return { route: "shares-create", workspaceId };
  }
  throw notFound();
}

function parseShareId(value: string | undefined): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SHARE_ID_CHARS ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(value)
  ) {
    throw notFound();
  }
  return value;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw badRequest("request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > maxBytes) throw payloadTooLarge();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw payloadTooLarge();
  return bytes;
}

function parseWorkspaceId(value: unknown): string {
  const workspaceId = parseString(value, "workspaceId", MAX_WORKSPACE_ID_CHARS);
  // Reserved: "/sync/shares/..." is the share-route namespace (PR 18). A
  // workspace with this id could never be addressed, so refuse the claim
  // rather than strand it.
  if (workspaceId === "shares") throw badRequest("workspaceId is reserved");
  return workspaceId;
}

function parseString(value: unknown, name: string, maxChars: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw badRequest(`${name} must be a non-empty trimmed string`);
  }
  if (value.length > maxChars) throw badRequest(`${name} is too long`);
  return value;
}

function parseLogOp(value: unknown): SyncRelayLogInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("each op must be a JSON object");
  }
  const op = value as Record<string, unknown>;
  const originSeq = Number(op.originSeq);
  if (!Number.isInteger(originSeq) || originSeq < 0) {
    throw badRequest("originSeq must be a non-negative integer");
  }
  const opKind = parseString(op.opKind, "opKind", MAX_OP_KIND_CHARS);
  if (!op.payload || typeof op.payload !== "object" || Array.isArray(op.payload)) {
    throw badRequest("payload must be a JSON object");
  }
  const recordedAtMs = Number(op.recordedAtMs);
  if (!Number.isFinite(recordedAtMs)) throw badRequest("recordedAtMs must be finite");
  const payloadJson = stableJsonStringify(op.payload);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_JSON_BYTES) {
    throw badRequest("payload is too large");
  }
  return { originSeq, opKind, payloadJson, recordedAtMs };
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseCursor(value: string | null): number {
  if (value === null || value === "") return 0;
  const cursor = Number(value);
  if (!Number.isInteger(cursor) || cursor < 0) throw badRequest("since must be a non-negative integer");
  return cursor;
}

function parseLimit(value: string | null): number {
  if (value === null || value === "") return DEFAULT_LOG_PAGE_SIZE;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw badRequest("limit must be a positive integer");
  return Math.min(limit, MAX_LOG_PAGE_SIZE);
}

function assertSha256(value: string): void {
  if (!SHA256_HEX.test(value)) throw badRequest("sha256 must be 64 lowercase hex characters");
}

// If-Match for PUT /keys: absent means create-only; otherwise a (optionally
// quoted) sha256 of the envelope the caller intends to replace. Wildcard and
// weak validators are refused — an unconditional overwrite is exactly the
// write this endpoint exists to prevent.
function parseIfMatchSha256(header: string | null): string | null {
  if (header === null) return null;
  const value = header.trim().replace(/^"(.*)"$/u, "$1");
  if (!SHA256_HEX.test(value)) {
    throw badRequest("if-match must be the sha256 of the current key envelope");
  }
  return value;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function arrayBufferForBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorResponse(error: unknown): Response {
  // Classified errors carry an intentional 4xx statusCode: our own typed
  // HttpError/SyncRelayConflictError, plus duck-typed auth errors from
  // workspace-api (UnauthorizedError). Everything else is UNEXPECTED
  // (SQLite failures, auth-DB hiccups): log it server-side and answer with a
  // generic 500 — never echo error.message, which can leak internals.
  const duckStatus =
    typeof error === "object" && error && "statusCode" in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : undefined;
  const classified =
    error instanceof HttpError ||
    error instanceof SyncRelayConflictError ||
    error instanceof SyncRelayQuotaExceededError ||
    (Number.isInteger(duckStatus) && duckStatus! >= 400 && duckStatus! <= 499);
  if (!classified) {
    console.error("[sync-relay] unhandled error", error);
    return jsonResponse({ ok: false, error: "internal error", code: "internal_error" }, 500);
  }
  const status =
    error instanceof HttpError ||
    error instanceof SyncRelayConflictError ||
    error instanceof SyncRelayQuotaExceededError
      ? error.statusCode
      : duckStatus!;
  const code =
    error instanceof HttpError ||
    error instanceof SyncRelayConflictError ||
    error instanceof SyncRelayQuotaExceededError
      ? error.code
      : typeof error === "object" && error && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
  const message = error instanceof Error ? error.message : "request failed";
  return jsonResponse(
    {
      ok: false,
      error: message,
      ...(code ? { code } : {}),
    },
    status,
  );
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function badRequest(message: string): HttpError {
  return new HttpError(400, "bad_request", message);
}

function selfShare(): HttpError {
  return new HttpError(400, "self_share", "a share needs a recipient other than yourself");
}

function notFound(): HttpError {
  return new HttpError(404, "not_found", "not found");
}

function blobNotFound(): HttpError {
  return new HttpError(404, "blob_not_found", "blob not found");
}

function keyEnvelopeNotFound(): HttpError {
  return new HttpError(404, "key_envelope_not_found", "key envelope not found");
}

function methodNotAllowed(): HttpError {
  return new HttpError(405, "method_not_allowed", "method not allowed");
}

function payloadTooLarge(): HttpError {
  return new HttpError(413, "payload_too_large", "payload too large");
}
