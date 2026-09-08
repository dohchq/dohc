import type {
  SyncRelayStorage,
  SqliteDb,
  OpenSyncRelayStorageOptions,
  WorkspaceSyncIdentity,
  VerifyWorkspaceIdentityResult,
  EnforceWorkspaceIdentityResult,
  SyncRelayShareGrantRow,
  SyncRelayShareRow,
  SyncRelayLinkCredentialRow,
  ShareProposalOpRow,
  LiveTicketStoragePolicy,
  TicketHostReport,
  CurrentLiveBindingResult,
  NamedLiveTicketLookup,
  CurrentLiveBindingRequest,
} from "./types";
import type { NamedLiveBrowserContext } from "../namedLiveBrowserAuth";
import type { LiveTicketClaims } from "@dohc/live-session-contract/live-ticket";

export interface StorageContext extends SyncRelayStorage {
  readonly db: SqliteDb;
  readonly options: Required<Omit<OpenSyncRelayStorageOptions, "liveTickets">>;
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
  ticketTransaction<T>(run: (now: number, policy: LiveTicketStoragePolicy) => T): T | null;
  ticketScopeIsCurrent(scope: NamedLiveBrowserContext): boolean;
  currentTicketAuthority(scope: NamedLiveBrowserContext, objectId: string, report: TicketHostReport):
    Extract<CurrentLiveBindingResult, { kind: "current" }>;
  matchingTicket(input: NamedLiveTicketLookup, now: number): LiveTicketClaims;
  currentLiveDocumentBinding({ document, actor }: CurrentLiveBindingRequest): CurrentLiveBindingResult;
}
