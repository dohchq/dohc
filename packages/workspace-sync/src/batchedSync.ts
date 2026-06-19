// Phase 5: map a settled batch of file-watcher events to a reviewable
// ChangeSet. An agent run touching 18 files becomes ONE change set, not 18.
// (The settle-window debounce itself lives in workspace-fs watchEvents — the
// shipping implementation; a duplicate batcher here was removed as redundant.)

import {
  addFileChanges,
  createChangeSet,
  type ChangeAuthor,
  type ChangeProvenance,
  type ChangeSet,
  type ChangeSetKind,
  type FileChange,
  type WatcherEvent,
  type WatcherEventBatch,
} from "@dohc/workspace-core";

// Watcher operations map onto the coarser change vocabulary: a create or an
// update both land as a "write" (the file now has new content); delete and
// rename pass through directly.
function toFileChange(event: WatcherEvent): FileChange {
  switch (event.operation) {
    case "delete":
      return { path: event.path, operation: "delete" };
    case "rename":
      return { path: event.path, operation: "rename" };
    case "create":
    case "update":
      return { path: event.path, operation: "write" };
  }
}

// Provenance source and change-set kind share the same vocabulary, so the kind
// is just the source when known, defaulting to a plain user edit.
function kindFromProvenance(provenance?: ChangeProvenance): ChangeSetKind {
  return provenance?.source ?? "user-edit";
}

// A human-friendly default summary derived from the batch. Imports read
// "Imported N files"; everything else reads "Edited N files".
function defaultSummary(
  count: number,
  provenance?: ChangeProvenance,
): string {
  const noun = count === 1 ? "file" : "files";
  const verb =
    provenance?.source === "import"
      ? "Imported"
      : provenance?.source === "history-restore"
        ? provenance.restoreDirection === "undo"
          ? "Undid restore for"
          : "Restored"
        : "Edited";
  return `${verb} ${count} ${noun}`;
}

export interface BatchToChangeSetInput {
  author: ChangeAuthor;
  summary?: string;
  provenance?: ChangeProvenance;
}

export function batchToChangeSet(
  batch: WatcherEventBatch,
  input: BatchToChangeSetInput,
): ChangeSet {
  const files = batch.events.map(toFileChange);
  const set = createChangeSet({
    kind: kindFromProvenance(input.provenance),
    author: input.author,
    summary: input.summary ?? defaultSummary(files.length, input.provenance),
    ...(input.provenance ? { provenance: input.provenance } : {}),
  });
  return addFileChanges(set, files);
}
