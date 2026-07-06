import { createHash } from "node:crypto";
import type { ResolveActor } from "@dohc/workspace-api/auth/session";
import {
  SyncRelayConflictError,
  type SyncRelayLogInput,
  type SyncRelayStorage,
} from "./storage";

export type SyncRelayHandler = (request: Request) => Promise<Response>;

export interface CreateSyncRelayHandlerOptions {
  storage: SyncRelayStorage;
  resolveActor: ResolveActor;
  nowMs?: () => number;
}

type SyncRelayRoute =
  | { route: "workspaces" }
  | { route: "blob"; workspaceId: string; sha256: string }
  | { route: "blob-have"; workspaceId: string }
  | { route: "keys"; workspaceId: string }
  | { route: "log"; workspaceId: string };

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

export function createSyncRelayHandler({
  storage,
  resolveActor,
  nowMs = () => Date.now(),
}: CreateSyncRelayHandlerOptions): SyncRelayHandler {
  return async (request) => {
    try {
      const route = parseRoute(request);
      const actor = await resolveActor(request, route.route === "workspaces" ? "" : route.workspaceId);

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

      if (!storage.workspaceIsOwnedBy(route.workspaceId, actor.userId)) throw notFound();

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
  const workspaceId = parseWorkspaceId(parts[1]);
  if (parts.length === 4 && parts[2] === "blobs" && parts[3] === "have") {
    return { route: "blob-have", workspaceId };
  }
  if (parts.length === 4 && parts[2] === "blobs" && parts[3]) {
    return { route: "blob", workspaceId, sha256: parts[3] };
  }
  if (parts.length === 3 && parts[2] === "log") {
    return { route: "log", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "keys") {
    return { route: "keys", workspaceId };
  }
  throw notFound();
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
  return parseString(value, "workspaceId", MAX_WORKSPACE_ID_CHARS);
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
    (Number.isInteger(duckStatus) && duckStatus! >= 400 && duckStatus! <= 499);
  if (!classified) {
    console.error("[sync-relay] unhandled error", error);
    return jsonResponse({ ok: false, error: "internal error", code: "internal_error" }, 500);
  }
  const status =
    error instanceof HttpError || error instanceof SyncRelayConflictError
      ? error.statusCode
      : duckStatus!;
  const code =
    error instanceof HttpError || error instanceof SyncRelayConflictError
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
