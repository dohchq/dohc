import {
  type ObjectMomentRow,
  type ShareProposalRow,
  type ShareProposalState,
  type ShareProposalOpRow,
  type SyncRelayShareRow,
  type SyncRelayShareGrantRow,
  type SyncRelayLinkCredentialRow,
  type SyncRelayLinkPrincipalRow,
  type SyncRelayShareDiscussionMessageRow,
  type SyncRelayLinkSessionRow,
  type StoredSyncRelayLinkHandoffCodeRow,
  type SyncRelayShareWithGrantRow,
  type SyncRelayLogRow,
} from "./types";

export function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableInt(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function rowToObjectMomentRow(row: Record<string, unknown>): ObjectMomentRow {
  return {
    momentId: String(row.moment_id),
    versionId: String(row.version_id),
    path: nullableText(row.path),
    blobSha256: nullableText(row.blob_sha256),
    contentKind: nullableText(row.content_kind),
    byteLength: nullableInt(row.byte_length),
    recordedAtMs: Number(row.recorded_at_ms),
  };
}

export function rowToProposalRow(row: Record<string, unknown>): ShareProposalRow {
  return {
    proposalId: String(row.proposal_id),
    shareId: String(row.share_id),
    workspaceId: String(row.workspace_id),
    proposedByUserId: String(row.proposed_by_user_id),
    versionId: String(row.version_id),
    state: String(row.state) as ShareProposalState,
    createdAtMs: Number(row.created_at_ms),
    settledAtMs: nullableInt(row.settled_at_ms),
  };
}

export function rowToProposalOpRow(row: Record<string, unknown>): ShareProposalOpRow {
  return {
    opIndex: Number(row.op_index),
    basedOnPath: nullableText(row.based_on_path),
    basedOnObjectId: nullableText(row.based_on_object_id),
    basedOnBlobSha256: nullableText(row.based_on_blob_sha256),
    operation: String(row.operation) === "delete" ? "delete" : "write",
    afterPath: nullableText(row.after_path),
    afterBlobSha256: nullableText(row.after_blob_sha256),
    afterContentKind:
      row.after_content_kind === "binary"
        ? "binary"
        : row.after_content_kind === "text"
          ? "text"
          : null,
    afterByteLength: nullableInt(row.after_byte_length),
    recordedAtMs: Number(row.recorded_at_ms),
  };
}

export function rowToShareRow(row: Record<string, unknown>): SyncRelayShareRow {
  return {
    shareId: String(row.share_id),
    workspaceId: String(row.workspace_id),
    granterUserId: String(row.granter_user_id),
    selectorJson: String(row.selector_json),
    createdAtMs: Number(row.created_at_ms),
  };
}

export function rowToShareGrantRow(row: Record<string, unknown>): SyncRelayShareGrantRow {
  const principalKind = String(row.principal_kind);
  const status = String(row.status);
  if (principalKind !== "user" && principalKind !== "email" && principalKind !== "link") {
    throw new Error("stored share grant has an invalid principal kind");
  }
  if (status !== "active" && status !== "revoked") {
    throw new Error("stored share grant has an invalid status");
  }
  return {
    grantId: String(row.grant_id),
    shareId: String(row.share_id),
    principalKind,
    principalUserId: nullableText(row.principal_user_id),
    principalEmail: nullableText(row.principal_email),
    access: String(row.access),
    generation: Number(row.generation),
    status,
    createdAtMs: Number(row.created_at_ms),
    revokedAtMs: nullableInt(row.revoked_at_ms),
    parentGrantId: nullableText(row.parent_grant_id),
  };
}

export function rowToLinkCredentialRow(
  row: Record<string, unknown>,
): SyncRelayLinkCredentialRow {
  return {
    credentialId: String(row.credential_id),
    grantId: String(row.grant_id),
    secretHash: String(row.secret_hash),
    generation: Number(row.generation),
    mintedAtMs: Number(row.minted_at_ms),
    retiredAtMs: nullableInt(row.retired_at_ms),
  };
}

export function rowToLinkPrincipalRow(
  row: Record<string, unknown>,
): SyncRelayLinkPrincipalRow {
  return {
    principalId: String(row.principal_id),
    grantId: String(row.grant_id),
    mintGeneration: Number(row.mint_generation),
    profileTokenHash: String(row.profile_token_hash),
    displayName: nullableText(row.display_name),
    createdAtMs: Number(row.created_at_ms),
    blockedAtMs: nullableInt(row.blocked_at_ms),
    discussionRevision: Number(row.discussion_revision),
    storageBytes: Number(row.storage_bytes),
  };
}

export function rowToShareDiscussionMessageRow(
  row: Record<string, unknown>,
): SyncRelayShareDiscussionMessageRow {
  const authorKind = String(row.author_kind);
  if (authorKind !== "owner" && authorKind !== "named" && authorKind !== "link") {
    throw new Error("stored discussion message has an invalid author kind");
  }
  return {
    messageId: String(row.message_id),
    shareId: String(row.share_id),
    idempotencyKey: String(row.idempotency_key),
    requestHash: String(row.request_hash),
    authorKind,
    authorUserId: nullableText(row.author_user_id),
    linkGrantId: nullableText(row.link_grant_id),
    linkPrincipalId: nullableText(row.link_principal_id),
    displayNameSnapshot: String(row.display_name_snapshot),
    body: nullableText(row.body),
    createdAtMs: Number(row.created_at_ms),
    deletedAtMs: nullableInt(row.deleted_at_ms),
    deletedByUserId: nullableText(row.deleted_by_user_id),
    discussionRevision: Number(row.discussion_revision),
    storageBytes: Number(row.storage_bytes),
  };
}

export function rowToLinkSessionRow(row: Record<string, unknown>): SyncRelayLinkSessionRow {
  return {
    sessionId: String(row.session_id),
    capabilityHash: String(row.capability_hash),
    grantId: String(row.grant_id),
    generation: Number(row.generation),
    mintedAtMs: Number(row.minted_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    principalId: nullableText(row.principal_id),
  };
}

export function rowToLinkHandoffCodeRow(
  row: Record<string, unknown>,
): StoredSyncRelayLinkHandoffCodeRow {
  return {
    codeId: String(row.code_id),
    codeHash: String(row.code_hash),
    grantId: String(row.grant_id),
    generation: Number(row.generation),
    mintedAtMs: Number(row.minted_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    resultGrantId: nullableText(row.result_grant_id),
  };
}

export function rowToShareWithGrantRow(
  row: Record<string, unknown>,
): SyncRelayShareWithGrantRow {
  return {
    share: rowToShareRow(row),
    grant: rowToShareGrantRow({
      ...row,
      share_id: row.grant_share_id,
      created_at_ms: row.grant_created_at_ms,
    }),
  };
}

export function rowToLogRow(row: Record<string, unknown>): SyncRelayLogRow {
  return {
    workspaceId: String(row.workspace_id),
    originId: String(row.origin_id),
    originSeq: Number(row.origin_seq),
    opKind: String(row.op_kind),
    payloadJson: String(row.payload_json),
    recordedAtMs: Number(row.recorded_at_ms),
    relaySeq: Number(row.relay_seq),
  };
}
