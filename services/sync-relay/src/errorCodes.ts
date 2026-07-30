export const RELAY_ERROR_STATUSES = Object.freeze({
  ambiguous_selector: 400,
  authorship_mismatch: 403,
  bad_request: 400,
  blob_missing: 422,
  blob_not_found: 404,
  conflict: 409,
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
  method_not_allowed: 405,
  not_found: 404,
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
