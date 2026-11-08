import type {
  SyncRelayStorage,
  SqliteDb,
  OpenSyncRelayStorageOptions,
  LiveTicketStoragePolicy,
} from "./types";

export interface StorageContext extends SyncRelayStorage {
  workReferenceDatasetAccess?: (input: {
    workspaceId: string; userId?: string; grantId?: string; linkAuth?: Extract<import("../appBackendAuthority").AppBackendAuth, {kind: "link"}>;
    target: Extract<import("@dohc/workspace-engine-client/daemon").WorkTarget, {kind: "transactionalCollection" | "transactionalRecord"}>;
  }) => Promise<(() => boolean) | null>;
  readonly db: SqliteDb;
  readonly options: Required<Omit<OpenSyncRelayStorageOptions, "liveTickets">>;
  readonly newDiscussionId: () => string;
  replicaViewTx<T>(run: () => T): T;
  tx<T>(run: () => T): T;
  readTx<T>(run: () => T): T;
  ticketTransaction<T>(run: (now: number, policy: LiveTicketStoragePolicy) => T): T | null;
}
