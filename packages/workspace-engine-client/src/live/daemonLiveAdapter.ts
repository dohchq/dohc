import type { ErrorCode } from "../ydoc/generated/ErrorCode";
import type { Request } from "../ydoc/generated/Request";
import type { Response } from "../ydoc/generated/Response";
import type { Retryability } from "../ydoc/generated/Retryability";
import type { WireError } from "../ydoc/generated/WireError";
import type { WorkspaceHandle } from "../ydoc/generated/WorkspaceHandle";

export interface MinimalDaemonClient {
  sendRequest(request: Request): Promise<Response>;
  close(): void;
}

export type DaemonRefusalDisposition = "retryable" | "terminal";

export class DaemonProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonProtocolError";
  }
}

export class DaemonRefusalError extends Error {
  readonly wireCode: ErrorCode;
  readonly retry: Retryability;
  readonly disposition: DaemonRefusalDisposition;
  override readonly cause: unknown;

  constructor(wireError: WireError, cause: unknown) {
    super(wireError.message);
    this.name = "DaemonRefusalError";
    this.wireCode = wireError.code;
    this.retry = wireError.retry;
    this.disposition = wireError.retry === "no" ? "terminal" : "retryable";
    this.cause = cause;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ERROR_CODES: readonly ErrorCode[] = [
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
  "INTERNAL",
];

const RETRYABILITIES: readonly Retryability[] = [
  "no",
  "immediate",
  "afterBackoff",
  "afterReconnect",
];

function wireErrorFrom(error: unknown): WireError | null {
  if (!isRecord(error) || !isRecord(error.wireError)) return null;
  const candidate = error.wireError;
  if (
    typeof candidate.code !== "string" ||
    !ERROR_CODES.includes(candidate.code as ErrorCode) ||
    typeof candidate.message !== "string" ||
    typeof candidate.retry !== "string" ||
    !RETRYABILITIES.includes(candidate.retry as Retryability)
  ) {
    return null;
  }
  return {
    code: candidate.code as ErrorCode,
    message: candidate.message,
    retry: candidate.retry as Retryability,
  };
}

export class WorkspaceDaemonRequester {
  private nextRequestId = 1;

  constructor(private readonly client: MinimalDaemonClient) {}

  async request(
    method: string,
    params: Request["params"],
    options?: {
      workspace?: WorkspaceHandle;
      idempotencyKey?: string;
      deadlineMs?: number;
    },
  ): Promise<Response["result"]> {
    const id = this.nextRequestId++;
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

  nextRequestIdFrom(previous: WorkspaceDaemonRequester): void {
    this.nextRequestId = Math.max(this.nextRequestId, previous.nextRequestId);
  }
}
