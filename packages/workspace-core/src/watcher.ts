// Phase 5 shared contract: the watcher event shape that workspace-fs emits
// and workspace-sync batches. Defined here so the lanes code against one
// interface instead of inventing parallel change models.

type WatcherOperation = "create" | "update" | "delete" | "rename";

interface WatcherEventBase {
  path: string;
  sha256?: string;
  previousSha256?: string;
}

interface WatcherRenameEvent extends WatcherEventBase {
  operation: "rename";
  fromPath: string;
}

interface WatcherFileEvent extends WatcherEventBase {
  operation: Exclude<WatcherOperation, "rename">;
  fromPath?: never;
}

export type WatcherEvent = WatcherRenameEvent | WatcherFileEvent;
