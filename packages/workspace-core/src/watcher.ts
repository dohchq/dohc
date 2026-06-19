// Phase 5 shared contract: the watcher event shape that workspace-fs emits
// and workspace-sync batches. Defined here so the lanes code against one
// interface instead of inventing parallel change models.

export type WatcherOperation = "create" | "update" | "delete" | "rename";

interface WatcherEventBase {
  path: string;
  sha256?: string;
  previousSha256?: string;
}

export interface WatcherRenameEvent extends WatcherEventBase {
  operation: "rename";
  fromPath: string;
}

export interface WatcherFileEvent extends WatcherEventBase {
  operation: Exclude<WatcherOperation, "rename">;
  fromPath?: never;
}

export type WatcherEvent = WatcherRenameEvent | WatcherFileEvent;

// A settled group of events: workspace-sync accumulates raw events and emits
// one batch once the workspace has been quiet for `windowMs`. One batch maps
// to one change set, so an agent run touching 18 files is a single unit.
export interface WatcherEventBatch {
  settledAtMs: number;
  windowMs: number;
  events: WatcherEvent[];
}
