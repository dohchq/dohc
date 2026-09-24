import { jsonResponse } from "@dohc/service-http";
import { UnauthorizedError } from "@dohc/workspace-auth/session";

export const RELAY_ERROR_STATUSES = Object.freeze({
  ambiguous_selector: 400,
  authorship_mismatch: 403,
  bad_request: 400,
  blob_missing: 422,
  blob_not_found: 404,
  conflict: 409,
  dependents_changed: 409,
  discussion_limit_reached: 413,
  discussion_rate_limited: 429,
  empty_selector: 400,
  epoch_superseded: 409,
  identity_not_recognized: 409,
  identity_required: 409,
  internal_error: 500,
  invalid_access: 400,
  invalid_channel: 400,
  invalid_path: 400,
  invalid_version: 400,
  key_envelope_not_found: 404,
  link_discussion_blocked: 403,
  link_discussion_paused: 403,
  link_read_rate_limited: 429,
  method_not_allowed: 405,
  not_found: 404,
  notice_rate_limited: 429,
  notice_refused: 403,
  payload_too_large: 413,
  presence_capacity: 429,
  quota_exceeded: 413,
  secret_path: 400,
  self_share: 400,
  share_op_rejected: 403,
  share_read_only: 403,
  stream_identity_mismatch: 409,
  too_many_paths: 400,
  unknown_chat_op: 403,
} as const);

export type RelayErrorCode = keyof typeof RELAY_ERROR_STATUSES;

export type RelayErrorDefinition<Code extends RelayErrorCode = RelayErrorCode> = Readonly<{
  code: Code;
  status: (typeof RELAY_ERROR_STATUSES)[Code];
}>;

export const RELAY_ERRORS = Object.freeze(
  Object.fromEntries(
    Object.entries(RELAY_ERROR_STATUSES).map(([code, status]) => [
      code,
      Object.freeze({ code, status }),
    ]),
  ),
) as Readonly<{ [Code in RelayErrorCode]: RelayErrorDefinition<Code> }>;

// The message a code carries unless the throw site says otherwise. A refusal
// deliberately says no more than its code: which op failed, which selector
// kind, or which bound tripped would let a probing caller map the share.
export const RELAY_ERROR_MESSAGES: Readonly<Record<RelayErrorCode, string>> = Object.freeze({
  ambiguous_selector: "a chat-channel share must not also carry paths or versionId",
  authorship_mismatch: "chat op author does not match the authenticated actor",
  bad_request: "bad request",
  blob_missing: "log append references a blob not stored on the relay",
  blob_not_found: "blob not found",
  conflict: "conflict",
  dependents_changed: "active dependent grants changed",
  discussion_limit_reached: "discussion message limit reached",
  discussion_rate_limited: "discussion message rate limit reached",
  empty_selector: "selector is empty",
  epoch_superseded: "replication epoch has been superseded",
  // The coordinate is unknown or newer, not proven stale: clients keep local
  // state and must not discard or reseed it.
  identity_not_recognized: "replication coordinate is not recognized",
  identity_required: "this workspace requires replication identity",
  internal_error: "internal error",
  invalid_access: "access is invalid",
  invalid_channel: "channel is not shareable",
  invalid_path: "path is invalid",
  invalid_version: "versionId is invalid",
  key_envelope_not_found: "key envelope not found",
  link_discussion_blocked: "link discussion writes are blocked",
  link_discussion_paused: "link discussion writes are paused",
  link_read_rate_limited: "too many link reads",
  method_not_allowed: "method not allowed",
  not_found: "not found",
  notice_rate_limited: "too many notices",
  notice_refused: "notice refused",
  payload_too_large: "payload too large",
  presence_capacity: "presence is at capacity",
  quota_exceeded: "workspace quota exceeded",
  secret_path: "path is a secret",
  self_share: "a share needs a recipient other than yourself",
  share_op_rejected: "an op is outside this share",
  share_read_only: "this share does not accept appends",
  stream_identity_mismatch: "stream identity does not match",
  too_many_paths: "too many paths",
  unknown_chat_op: "unrecognized chat op cannot be authorship-verified",
});

/** An error the relay answers with its own status, code, and message. */
export class RelayError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: RelayErrorCode,
    message: string = RELAY_ERROR_MESSAGES[code],
    statusCode: number = RELAY_ERROR_STATUSES[code],
  ) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function relayError(code: RelayErrorCode, message?: string): RelayError {
  return new RelayError(code, message);
}

export function badRequest(message: string): RelayError {
  return new RelayError("bad_request", message);
}

export function notFound(): RelayError {
  return new RelayError("not_found");
}

export function errorBody(code: RelayErrorCode): Response {
  return jsonResponse(
    { ok: false, error: RELAY_ERROR_MESSAGES[code], code },
    RELAY_ERROR_STATUSES[code],
  );
}

/**
 * The response for a thrown value. Relay errors and the auth layer's
 * `UnauthorizedError` answer with their own status and code. Anything else
 * is unexpected (SQLite, the auth database): it is logged server-side and
 * answered with a generic 500, never with its message.
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof RelayError) {
    return jsonResponse({ ok: false, error: error.message, code: error.code }, error.statusCode);
  }
  if (error instanceof UnauthorizedError) {
    return jsonResponse({ ok: false, error: error.message, code: error.code }, error.statusCode);
  }
  console.error("[sync-relay] unhandled error", error);
  return errorBody("internal_error");
}

// A link credential that does not resolve answers 401 with the not-found body:
// the status tells the viewer to re-exchange, and the body says nothing more.
export function invalidLinkCapability(): RelayError {
  return new RelayError("not_found", undefined, 401);
}
