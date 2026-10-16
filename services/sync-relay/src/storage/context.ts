import type {
  SyncRelayStorage,
  SqliteDb,
  OpenSyncRelayStorageOptions,
  LiveTicketStoragePolicy,
} from "./types";

export interface StorageContext extends SyncRelayStorage {
  readonly db: SqliteDb;
  readonly options: Required<Omit<OpenSyncRelayStorageOptions, "liveTickets">>;
  readonly newDiscussionId: () => string;
  replicaViewTx<T>(run: () => T): T;
  tx<T>(run: () => T): T;
  readTx<T>(run: () => T): T;
  ticketTransaction<T>(run: (now: number, policy: LiveTicketStoragePolicy) => T): T | null;
}
