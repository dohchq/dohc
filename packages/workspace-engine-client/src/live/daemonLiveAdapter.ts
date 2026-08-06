import type { ErrorCode } from "../ydoc/generated/ErrorCode";
import type { Request } from "../ydoc/generated/Request";
import type { Response } from "../ydoc/generated/Response";
import type { Retryability } from "../ydoc/generated/Retryability";
import type { WireError } from "../ydoc/generated/WireError";
import type { WorkspaceHandle } from "../ydoc/generated/WorkspaceHandle";

export type DaemonErrorCode =
  | ErrorCode
  | "CONFLICT"
  | "ORIGIN_DIVERGED"
  | "SHARE_UNAVAILABLE"
  | "KEY_ENVELOPE_MISSING"
  | "EPOCH_SUPERSEDED"
  | "IDENTITY_NOT_RECOGNIZED"
  | "FORBIDDEN"
  | "SHARE_READ_ONLY"
  | "SHARE_OPERATION_REJECTED"
  | "PAYLOAD_TOO_LARGE"
  | "QUOTA_EXCEEDED"
  | "RELAY_NO_PROGRESS"
  | "BLOB_MISSING"
  | "BLOB_REFERENCE_MISSING"
  | "BLOB_INVALID"
  | "IDENTITY_REQUIRED"
  | "STREAM_IDENTITY_MISMATCH"
  | "AUTHORSHIP_MISMATCH"
  | "UNKNOWN_CHAT_OPERATION"
  | "PRESENCE_CAPACITY"
  | "SELF_SHARE"
  | "AMBIGUOUS_SELECTOR"
  | "INVALID_CHANNEL"
  | "RELAY_METHOD_NOT_ALLOWED"
  | "RELAY_INVALID_RESPONSE";

export interface DaemonWireError extends Omit<WireError, "code"> {
  code: DaemonErrorCode;
}

export interface MinimalDaemonClient {
  sendRequest(request: Request): Promise<Response>;
  readonly helloAck?: {
    readonly capabilities: readonly string[];
  };
  onBlob?(handler: (blob: CompletedDaemonBlob) => void): () => void;
  close(): void;
}

export interface CompletedDaemonBlob {
  readonly requestId: number;
  readonly streamId: number;
  readonly totalBytes?: number | null;
  readonly sha256?: string | null;
  readonly bytes: Uint8Array;
}

export type DaemonRefusalDisposition =
  | "terminal"
  | Exclude<Retryability, "no">;

export class DaemonClientCapabilityError extends Error {
  readonly capability: "blobs";

  constructor() {
    super(
      'The daemon session did not negotiate the "blobs" capability.',
    );
    this.name = "DaemonClientCapabilityError";
    this.capability = "blobs";
  }
}

export class DaemonProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonProtocolError";
  }
}

export class DaemonRefusalError extends Error {
  readonly wireCode: DaemonErrorCode;
  readonly retry: Retryability;
  readonly disposition: DaemonRefusalDisposition;
  override readonly cause: unknown;

  constructor(wireError: DaemonWireError, cause: unknown) {
    super(wireError.message);
    this.name = "DaemonRefusalError";
    this.wireCode = wireError.code;
    this.retry = wireError.retry;
    // afterReconnect is not an ordinary retry: callers must establish a new
    // session, re-open the workspace, and bind a new adapter to its new handle.
    this.disposition =
      wireError.retry === "no" ? "terminal" : wireError.retry;
    this.cause = cause;
  }
}

export function isDaemonReconnectError(error: unknown): boolean {
  return (
    (error instanceof DaemonRefusalError &&
      error.disposition === "afterReconnect") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "transport-error")
  );
}

// The daemon wire enum groups every caller-mistake refusal under
// INVALID_PARAMS, so only the MESSAGE names which refusal this is. Keep each
// discriminator at this protocol boundary so a caller cannot accidentally
// reinterpret every INVALID_PARAMS refusal as the one it handles.
function refusalMessageOf(
  error: unknown,
  code: DaemonErrorCode = "INVALID_PARAMS",
): string | null {
  const wireError =
    error instanceof DaemonRefusalError
      ? { code: error.wireCode, message: error.message }
      : isRecord(error) && isRecord(error.wireError)
        ? error.wireError
        : null;
  if (wireError?.code !== code) return null;
  return typeof wireError.message === "string" ? wireError.message : null;
}

export function isYdocSessionNotFoundRefusal(error: unknown): boolean {
  return refusalMessageOf(error) === "ydoc-session-not-found";
}

// The engine refused because the path's head moved under this caller: another
// writer — the daemon's own capture ingesting an edit made outside dohc —
// committed to the same object first. `DomainError::ConflictStaleTarget`.
export function isConflictStaleTargetRefusal(error: unknown): boolean {
  return refusalMessageOf(error) === "conflict-stale-target";
}

// The settle committed, but the artifact replace exhausted its retries
// against a handle an external program still holds
// (`MaterializeError::FileLocked`). The write job is durably pending, so the
// caller retries the settle with backoff until the handle releases — OVERLOADED
// is the wire's retry-after-backoff contract, and the message names the lock.
export function isFileLockedRefusal(error: unknown): boolean {
  return refusalMessageOf(error, "OVERLOADED") === "file-locked";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ERROR_CODES: readonly DaemonErrorCode[] = [
  "AUTH_FAILED",
  "PROTOCOL_VERSION_UNSUPPORTED",
  "MALFORMED_FRAME",
  "LIMIT_EXCEEDED",
  "INVALID_ENVELOPE",
  "METHOD_NOT_FOUND",
  "INVALID_PARAMS",
  "DEADLINE_EXCEEDED",
  "CANCELLED",
  "OVERLOADED",
  "SESSION_EXPIRED",
  "WORKSPACE_UNAVAILABLE",
  "CONFLICT",
  "ORIGIN_DIVERGED",
  "SHARE_UNAVAILABLE",
  "KEY_ENVELOPE_MISSING",
  "EPOCH_SUPERSEDED",
  "IDENTITY_NOT_RECOGNIZED",
  "FORBIDDEN",
  "SHARE_READ_ONLY",
  "SHARE_OPERATION_REJECTED",
  "PAYLOAD_TOO_LARGE",
  "QUOTA_EXCEEDED",
  "RELAY_NO_PROGRESS",
  "BLOB_MISSING",
  "BLOB_REFERENCE_MISSING",
  "BLOB_INVALID",
  "IDENTITY_REQUIRED",
  "STREAM_IDENTITY_MISMATCH",
  "AUTHORSHIP_MISMATCH",
  "UNKNOWN_CHAT_OPERATION",
  "PRESENCE_CAPACITY",
  "SELF_SHARE",
  "AMBIGUOUS_SELECTOR",
  "INVALID_CHANNEL",
  "RELAY_METHOD_NOT_ALLOWED",
  "RELAY_INVALID_RESPONSE",
  "INTERNAL",
];

const RETRYABILITIES: readonly Retryability[] = [
  "no",
  "immediate",
  "afterBackoff",
  "afterReconnect",
];

// This intentionally duck-types EngineClientError because the package cannot
// import the desktop app. Source of truth:
// packages/workspace-engine-client/src/daemon/engineClient.ts:422-447.
function wireErrorFrom(error: unknown): DaemonWireError | null {
  if (!isRecord(error) || !isRecord(error.wireError)) return null;
  const candidate = error.wireError;
  if (
    typeof candidate.code !== "string" ||
    !ERROR_CODES.includes(candidate.code as DaemonErrorCode) ||
    typeof candidate.message !== "string" ||
    typeof candidate.retry !== "string" ||
    !RETRYABILITIES.includes(candidate.retry as Retryability)
  ) {
    return null;
  }
  return {
    code: candidate.code as DaemonErrorCode,
    message: candidate.message,
    retry: candidate.retry as Retryability,
  };
}

interface SharedRequestIdState {
  nextRequestId: number;
}

const requestIdsByClient = new WeakMap<
  MinimalDaemonClient,
  SharedRequestIdState
>();

function sharedRequestIds(client: MinimalDaemonClient): SharedRequestIdState {
  const existing = requestIdsByClient.get(client);
  if (existing !== undefined) return existing;
  const created = { nextRequestId: 1 };
  requestIdsByClient.set(client, created);
  return created;
}

export class WorkspaceDaemonRequester {
  private readonly requestIds: SharedRequestIdState;

  constructor(private readonly client: MinimalDaemonClient) {
    this.requestIds = sharedRequestIds(client);
  }

  async request(
    method: string,
    params: Request["params"],
    options?: {
      workspace?: WorkspaceHandle;
      idempotencyKey?: string;
      deadlineMs?: number;
    },
  ): Promise<Response["result"]> {
    const id = this.allocateRequestId();
    return this.send(id, method, params, options);
  }

  async requestWithBlob(
    method: string,
    params: Request["params"],
    expectsBlob: (result: Response["result"]) => boolean,
    options?: {
      workspace?: WorkspaceHandle;
      idempotencyKey?: string;
      deadlineMs?: number;
    },
  ): Promise<{
    result: Response["result"];
    blob: CompletedDaemonBlob | null;
  }> {
    const id = this.allocateRequestId();
    const blobCapabilityNegotiated =
      this.client.helloAck?.capabilities.includes("blobs") === true;
    let completedBlob: CompletedDaemonBlob | null = null;
    const unsubscribe = blobCapabilityNegotiated
      ? this.client.onBlob?.((blob) => {
          if (blob.requestId !== id) return;
          completedBlob = blob;
        })
      : undefined;

    try {
      const result = await this.send(id, method, params, options);
      if (!expectsBlob(result)) return { result, blob: null };
      if (!blobCapabilityNegotiated) {
        throw new DaemonClientCapabilityError();
      }
      if (unsubscribe === undefined) {
        throw new DaemonProtocolError(
          'The daemon client negotiated "blobs" without exposing completed blob delivery.',
        );
      }
      if (completedBlob === null) {
        throw new DaemonProtocolError(
          `Request ${id} returned blob metadata without a correlated completed blob.`,
        );
      }
      return { result, blob: completedBlob };
    } finally {
      unsubscribe?.();
    }
  }

  private allocateRequestId(): number {
    return this.requestIds.nextRequestId++;
  }

  private async send(
    id: number,
    method: string,
    params: Request["params"],
    options?: {
      workspace?: WorkspaceHandle;
      idempotencyKey?: string;
      deadlineMs?: number;
    },
  ): Promise<Response["result"]> {
    let response: Response;
    try {
      response = await this.client.sendRequest({
        id,
        method,
        ...(options?.workspace !== undefined
          ? { workspace: options.workspace }
          : {}),
        ...(options?.idempotencyKey !== undefined
          ? { idempotencyKey: options.idempotencyKey }
          : {}),
        ...(options?.deadlineMs !== undefined
          ? { deadlineMs: options.deadlineMs }
          : {}),
        params,
      });
    } catch (error) {
      const refusal = wireErrorFrom(error);
      if (refusal !== null) throw new DaemonRefusalError(refusal, error);
      throw error;
    }
    if (response.id !== id) {
      throw new DaemonProtocolError(
        `Expected response ${id}, received ${response.id}.`,
      );
    }
    return response.result;
  }

  closeTransport(): void {
    this.client.close();
  }
}
