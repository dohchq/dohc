import type { PendingConflictResolve } from "./engine";

// PendingConflictResolve is defined in ./engine and re-exported here so the whole
// relay surface can be imported from one subpath. It was never in the legacy
// package — that package only re-exported it.
export type { PendingConflictResolve };

export interface SyncRelayConnection {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export interface RelayMaterializedPath {
  path: string;
  operation: "write" | "delete";
  contentKind: "text" | "binary";
}

export interface PullWorkspaceFromRelayResult {
  fetched: number;
  applied: number;
  skipped: number;
  conflictsOpened: number;
  pendingConflictResolves: number;
  // Identities behind pendingConflictResolves (0P-C gate fix): the sync
  // engine tracks these so its "a choice needs a look" notice clears when
  // the referenced conflict is later resolved, instead of accumulating.
  pendingResolves: PendingConflictResolve[];
  fastForwardedPaths: RelayMaterializedPath[];
  // The relay cursor this pull reached. NOT persisted by the pull itself:
  // the caller must invoke commitFetchCursor() only after fastForwardedPaths
  // has been materialized to disk. A crash or materialization failure before
  // the commit leaves the cursor behind, so the next pass re-fetches and
  // re-reports the owed disk work instead of permanently skipping remote
  // ops (which would let a later disk reconciliation overwrite pulled engine
  // state with stale disk content).
  nextCursor: number;
  commitFetchCursor: () => Promise<void>;
}

export interface PushWorkspaceToRelayResult {
  pushed: number;
  originsPushed: string[];
}

export class RelayUnauthorizedError extends Error {
  constructor(message = "Relay authorization failed.") {
    super(message);
    this.name = "RelayUnauthorizedError";
  }
}

export class RelayWorkspaceUnavailableError extends Error {
  constructor(message = "Relay workspace is unavailable.") {
    super(message);
    this.name = "RelayWorkspaceUnavailableError";
  }
}

export class RelayConflictError extends Error {
  constructor(message = "Relay rejected the operation batch.") {
    super(message);
    this.name = "RelayConflictError";
  }
}

// The relay log for THIS origin disagrees with the local journal (the relay
// is ahead of local reality, or holds the same origin seq with different
// content). That means the local engine.db was restored/cloned from an older
// snapshot — pushing must fail closed rather than silently drop local ops.
// Recovering via an origin reset is 0P-C follow-up work.
export class RelayOriginDivergedError extends Error {
  constructor(message = "Relay log for this origin diverged from the local journal.") {
    super(message);
    this.name = "RelayOriginDivergedError";
  }
}

// The relay served the workspace but is missing a blob the log references —
// distinct from the fixed absent-workspace 404 so sync can degrade honestly
// instead of reporting the whole workspace unavailable.
export class RelayBlobMissingError extends Error {
  constructor(message = "Relay is missing a referenced blob.") {
    super(message);
    this.name = "RelayBlobMissingError";
  }
}

export class RelayKeyEnvelopeMissingError extends Error {
  constructor(message = "Relay is missing the workspace key envelope.") {
    super(message);
    this.name = "RelayKeyEnvelopeMissingError";
  }
}

export interface RecoverRelayOriginResult {
  // The diverged origin id the relay is authoritative for; it is retired
  // locally (never pushed again) but its ops stay as shared history.
  oldOriginId: string;
  // The fresh origin id this machine adopts for all future local writes.
  newOriginId: string;
  // How many leading local ops the relay also holds byte-identically — the
  // shared history prefix, kept as-is.
  sharedPrefixLength: number;
  // Genuinely-unpushed / divergent local ops re-journaled under the fresh
  // origin so they push cleanly and surface as conflicts where they clash —
  // never silently dropped.
  preservedOps: number;
}

export interface ProbeRelayWorkspaceResult {
  hasContent: boolean;
}

export interface RelayWorkspaceIdentity {
  replicationEpoch: string;
  streamIdentity: string;
}

export interface RelayWorkspaceBootstrapResult {
  hasContent: boolean;
  identity: RelayWorkspaceIdentity | null;
}

const MAX_RELAY_IDENTITY_BYTES = 512;
const RELAY_IDENTITY_CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

function relayIdentityValue(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    RELAY_IDENTITY_CONTROL_CHARS.test(value) ||
    new TextEncoder().encode(value).byteLength > MAX_RELAY_IDENTITY_BYTES
  ) {
    return null;
  }
  return value;
}

export function decodeRelayWorkspaceBootstrap(
  value: unknown,
): RelayWorkspaceBootstrapResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Relay bootstrap response is invalid.");
  }
  const result = value as Record<string, unknown>;
  if (result.ok !== true || typeof result.hasContent !== "boolean") {
    throw new Error("Relay bootstrap response is invalid.");
  }
  if (result.replicationEpoch === null && result.streamIdentity === null) {
    return { hasContent: result.hasContent, identity: null };
  }
  const replicationEpoch = relayIdentityValue(result.replicationEpoch);
  const streamIdentity = relayIdentityValue(result.streamIdentity);
  if (replicationEpoch === null || streamIdentity === null) {
    throw new Error("Relay bootstrap response is invalid.");
  }
  return {
    hasContent: result.hasContent,
    identity: { replicationEpoch, streamIdentity },
  };
}

export class SharedChannelReadOnlyError extends Error {
  constructor(message = "This shared channel is read-only for you.") {
    super(message);
    this.name = "SharedChannelReadOnlyError";
  }
}

export class SharedChannelAppendRejectedError extends Error {
  constructor(message = "The relay refused an op for this shared channel.") {
    super(message);
    this.name = "SharedChannelAppendRejectedError";
  }
}

export interface PullSharedChannelResult {
  fetched: number;
  applied: number;
  skipped: number;
  nextCursor: number;
}

export interface PushSharedChannelResult {
  pushed: number;
}

export class ShareUnavailableError extends Error {
  constructor(
    message = "This share was ended, or the code does not match your account.",
  ) {
    super(message);
    this.name = "ShareUnavailableError";
  }
}

export interface ShareViewChangedPath {
  path: string;
  operation: "write" | "delete";
  contentKind: "text" | "binary";
}

export interface PullShareViewResult {
  fetched: number;
  applied: number;
  changedPaths: ShareViewChangedPath[];
  nextCursor: number;
  // Persist the cursor only after the caller has materialized changedPaths
  // to disk — the same contract as pullWorkspaceFromRelay. A crash before
  // the commit re-fetches (and re-replays) the delta; replay is
  // content-compared so an already-applied op is a no-op.
  commitCursor: () => Promise<void>;
}
