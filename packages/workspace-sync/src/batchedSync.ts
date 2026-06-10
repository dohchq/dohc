// Phase 5: turn the raw stream of file-watcher events into reviewable units.
// Two pieces: a settle-window batcher that waits for the workspace to go quiet
// before grouping events, and a mapper from a settled batch to a ChangeSet.
// An agent run touching 18 files becomes ONE batch and ONE change set, not 18.

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

export interface SettleBatcherOptions {
  // Quiet period (ms) the workspace must stay event-free before a batch emits.
  windowMs: number;
  // Injected clock so behavior is deterministic in tests and host-driven in
  // production. Stamps each event's arrival time.
  now: () => number;
  onBatch: (batch: WatcherEventBatch) => void;
}

export interface SettleBatcher {
  push(event: WatcherEvent): void;
  // Probe called by the host (e.g. from a real interval) with the current time.
  // Emits the pending batch when the workspace has been quiet for windowMs.
  tick(currentMs: number): void;
  // Emit any pending batch right now, ignoring the window (e.g. on shutdown).
  flush(): void;
}

export function createSettleBatcher(
  opts: SettleBatcherOptions,
): SettleBatcher {
  // Pending events keyed by path so rapid edits to the same file collapse into
  // a single event carrying the latest sha256. Map preserves insertion order,
  // so the emitted batch keeps first-seen ordering of paths.
  const pending = new Map<string, WatcherEvent>();
  let lastEventMs = 0;

  function emit(settledAtMs: number): void {
    if (pending.size === 0) return;
    const batch: WatcherEventBatch = {
      settledAtMs,
      windowMs: opts.windowMs,
      events: Array.from(pending.values()),
    };
    pending.clear();
    opts.onBatch(batch);
  }

  return {
    push(event: WatcherEvent): void {
      // A later event for the same path supersedes the earlier one: keep the
      // newest operation and sha256 (e.g. create then update -> latest update).
      pending.set(event.path, event);
      lastEventMs = opts.now();
    },
    tick(currentMs: number): void {
      if (pending.size === 0) return;
      if (currentMs - lastEventMs >= opts.windowMs) {
        emit(currentMs);
      }
    },
    flush(): void {
      emit(opts.now());
    },
  };
}

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
  const verb = provenance?.source === "import" ? "Imported" : "Edited";
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
