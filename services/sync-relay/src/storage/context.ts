import {
  type SyncRelayStorage,
  type SqliteDb,
  type OpenSyncRelayStorageOptions,
  type WorkspaceSyncIdentity,
  type VerifyWorkspaceIdentityResult,
  type EnforceWorkspaceIdentityResult,
  type SyncRelayShareGrantRow,
  type SyncRelayShareRow,
  type SyncRelayLinkCredentialRow,
  type ShareProposalOpRow,
} from "./types";

export interface StorageContext extends SyncRelayStorage {
  readonly db: SqliteDb;
  readonly options: Required<OpenSyncRelayStorageOptions>;
  readonly newDiscussionId: () => string;
  classifyWorkspaceIdentity(
    workspaceId: string,
    current: WorkspaceSyncIdentity,
    presented: WorkspaceSyncIdentity,
  ): VerifyWorkspaceIdentityResult;
  enforceWorkspaceIdentityInTransaction(
    workspaceId: string,
    presented: WorkspaceSyncIdentity | null,
  ): EnforceWorkspaceIdentityResult;
  workspaceUsageBytes(workspaceId: string): number;
  assertWorkspaceQuota(workspaceId: string, addedBytes: number): void;
  insertShareGrant(grant: SyncRelayShareGrantRow): void;
  nextShareDiscussionRevision(shareId: string): number;
  insertShare(share: SyncRelayShareRow): void;
  insertLinkCredential(credential: SyncRelayLinkCredentialRow): void;
  upsertLinkUsage(grantId: string, lastUsedAtMs: number): void;
  retireCurrentLinkCredential(grantId: string, retiredAtMs: number): boolean;
  pruneRetiredLinkCredentials(grantId: string): void;
  activeDependentGrants(parentGrantId: string): SyncRelayShareGrantRow[];
  incrementActiveDependentGenerations(parentGrantId: string): void;
  tx<T>(run: () => T): T;
  readTx<T>(run: () => T): T;
  proposalOps(proposalId: string): ShareProposalOpRow[];
  threadCreateRows(
    workspaceId: string,
    threadId: string,
  ): Array<Record<string, unknown>>;
}
