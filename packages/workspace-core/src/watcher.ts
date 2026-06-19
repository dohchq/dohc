// Phase 5 shared contract: the watcher event shape that workspace-fs emits
// and workspace-sync batches. Defined here so the lanes code against one
// interface instead of inventing parallel change models.

export type WatcherOperation = "create" | "update" | "delete" | "rename";

export interface WatcherEvent {
  path: string;
  operation: WatcherOperation;
  sha256?: string;
  previousSha256?: string;
  // For rename, the path the file moved from.
  fromPath?: string;
}

// A settled group of events: workspace-sync accumulates raw events and emits
// one batch once the workspace has been quiet for `windowMs`. One batch maps
// to one change set, so an agent run touching 18 files is a single unit.
export interface WatcherEventBatch {
  settledAtMs: number;
  windowMs: number;
  events: WatcherEvent[];
}
