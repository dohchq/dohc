import type {
  ChangeAuthor,
  ChangeProvenance,
  ChangeSet,
  FileChangeSnapshot,
  WatcherEvent,
  WatcherEventBatch,
} from "@dohc/workspace-core";
import {
  collapseSqliteSidecars,
  isTextMediaType,
  mediaTypeForPath,
  shouldIgnoreWatchPath,
  watchWorkspaceEvents,
} from "@dohc/workspace-fs";
import { createChangeSetStore, humanSummary } from "@dohc/workspace-history";
import { batchToChangeSet } from "@dohc/workspace-sync";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { desktopMarks } from "../performance/desktopMarks";
import type { CreatedWorkspace } from "./createWorkspaceFolder";

// Local user is the implicit author of filesystem edits. When an agent run is
// active (an MCP-driven turn the user started), its writes are attributed to
// the agent instead — see ActiveAgentRun below.
const LOCAL_USER: ChangeAuthor = { kind: "user", userId: "local" };
const MAX_HISTORY_TEXT_SNAPSHOT_BYTES = 128 * 1024;

// The active-run fact a batch attributes to: who the agent is and which run it
// belongs to. workspaceActivity owns the slot; the watcher only reads it.
export interface ActiveAgentRun {
  agentId: string;
  onBehalfOf: string;
  agentRunId: string;
}

export interface ActiveLocalOperation {
  paths: readonly string[];
  summary: string;
  provenance: ChangeProvenance;
  expectedEvents?: readonly ActiveLocalOperationExpectedEvent[];
}

export interface ActiveLocalOperationExpectedEvent {
  path: string;
  operation?: WatcherEvent["operation"];
  sha256?: string;
}

export interface ActiveLocalOperationBatch {
  paths: readonly string[];
  events: readonly WatcherEvent[];
}

function expectedEventMatches(
  expected: NonNullable<ActiveLocalOperation["expectedEvents"]>[number],
  event: WatcherEvent,
): boolean {
  return (
    expected.path === event.path &&
    (!expected.operation || expected.operation === event.operation) &&
    (!expected.sha256 || expected.sha256 === event.sha256)
  );
}

export function activeLocalOperationMatchesBatch(
  operation: ActiveLocalOperation,
  batch: ActiveLocalOperationBatch,
): boolean {
  const operationPaths = new Set(operation.paths);
  if (
    batch.paths.length === 0 ||
    !batch.paths.every((path) => operationPaths.has(path))
  ) {
    return false;
  }
  if (!operation.expectedEvents) return true;
  if (batch.events.length !== operation.expectedEvents.length) return false;
  return (
    operation.expectedEvents.every((expected) =>
      batch.events.some((event) => expectedEventMatches(expected, event)),
    ) &&
    batch.events.every((event) =>
      operation.expectedEvents?.some((expected) =>
        expectedEventMatches(expected, event),
      ),
    )
  );
}

async function sha256OrUndefined(absolute: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(absolute)).digest("hex");
  } catch {
    return undefined;
  }
}

type HistorySnapshotEntry = {
  mediaType: string;
  snapshot: FileChangeSnapshot;
};

function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readHistorySnapshotEntry(
  rootPath: string,
  path: string,
): Promise<HistorySnapshotEntry | null> {
  const mediaType = mediaTypeForPath(path);
  const absolute = join(rootPath, path);
  try {
    const info = await stat(absolute);
    if (!info.isFile()) {
      return {
        mediaType,
        snapshot: {
          sizeBytes: info.size,
          unavailableReason: "unreadable",
        },
      };
    }
    if (!isTextMediaType(mediaType, path)) {
      return {
        mediaType,
        snapshot: {
          sizeBytes: info.size,
          unavailableReason: "binary",
        },
      };
    }
    if (info.size > MAX_HISTORY_TEXT_SNAPSHOT_BYTES) {
      return {
        mediaType,
        snapshot: {
          sizeBytes: info.size,
          unavailableReason: "too-large",
          truncated: true,
        },
      };
    }
    const bytes = await readFile(absolute);
    return {
      mediaType,
      snapshot: {
        sizeBytes: bytes.length,
        sha256: sha256Bytes(bytes),
        text: bytes.toString("utf8"),
        truncated: false,
      },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return {
      mediaType,
      snapshot: { unavailableReason: "unreadable" },
    };
  }
}

async function seedHistorySnapshotCache(
  rootPath: string,
): Promise<Map<string, HistorySnapshotEntry>> {
  const cache = new Map<string, HistorySnapshotEntry>();

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const path = relative(rootPath, absolute).replace(/\\/g, "/");
      if (!path || shouldIgnoreWatchPath(path)) continue;
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const snapshot = await readHistorySnapshotEntry(rootPath, path);
      if (snapshot) cache.set(path, snapshot);
    }
  }

  await walk(rootPath);
  return cache;
}

async function attachHistorySnapshots(
  rootPath: string,
  cache: Map<string, HistorySnapshotEntry>,
  set: ChangeSet,
): Promise<ChangeSet> {
  const files = await Promise.all(
    set.files.map(async (file) => {
      const before = cache.get(file.path) ?? null;
      const after =
        file.operation === "delete"
          ? null
          : await readHistorySnapshotEntry(rootPath, file.path);

      if (after) cache.set(file.path, after);
      else cache.delete(file.path);

      return {
        ...file,
        mediaType: after?.mediaType ?? before?.mediaType ?? mediaTypeForPath(file.path),
        before: before?.snapshot ?? null,
        after: after?.snapshot ?? null,
      };
    }),
  );

  return { ...set, files };
}

// Turn the watcher's settled changed paths into WatcherEvents. Operation is
// inferred from current existence; only a confirmed-absent file (ENOENT/
// ENOTDIR) is a delete — a transiently unreadable file (EACCES, EBUSY) is
// still present and must not be recorded into history as "deleted".
async function pathsToEvents(
  rootPath: string,
  paths: string[],
): Promise<WatcherEvent[]> {
  const events: WatcherEvent[] = [];
  for (const path of paths) {
    const absolute = join(rootPath, path);
    let kind: "file" | "absent" | "other" = "other";
    try {
      kind = (await stat(absolute)).isFile() ? "file" : "other";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      kind = code === "ENOENT" || code === "ENOTDIR" ? "absent" : "other";
    }
    if (kind === "absent") {
      events.push({ path, operation: "delete" });
    } else if (kind === "file") {
      events.push({ path, operation: "update", sha256: await sha256OrUndefined(absolute) });
    } else {
      // Directories and unreadable-but-present entries: record the change
      // without a hash rather than fabricating a delete.
      events.push({ path, operation: "update" });
    }
  }
  return events;
}

export interface WorkspaceWatchHandle {
  // Stops watching, flushes the final settle window, and resolves once every
  // in-flight record has been written — so quit cannot drop the last batch.
  stop: () => Promise<void>;
  // Resolves when the underlying watcher's initial scan completes; writes made
  // after this are guaranteed observed.
  ready: Promise<void>;
}

// Wires the file watcher to the history store: each settled batch of changes
// becomes one recorded change set. onRecorded lets the desktop layer refresh
// sync status and push the new timeline entry to the renderer.
export function startWorkspaceWatch(
  workspace: CreatedWorkspace,
  options: {
    settleMs?: number;
    now?: () => number;
    onRecorded?: () => void;
    // Read at the moment a batch settles: a non-null run attributes the batch
    // to that agent (kind:"agent") with agent-run provenance, else local user.
    activeAgentRun?: () => ActiveAgentRun | null;
    // Short-lived user operations that need provenance beyond "edited" (for
    // example restoring a history snapshot). The watcher only consumes one
    // when every settled user path belongs to the operation and, when supplied,
    // the concrete filesystem events match its expected result.
    activeLocalOperation?: (
      batch: ActiveLocalOperationBatch,
    ) => ActiveLocalOperation | null;
  } = {},
): WorkspaceWatchHandle {
  const store = createChangeSetStore(workspace.rootPath);
  const now = options.now ?? (() => Date.now());
  let snapshotCache = new Map<string, HistorySnapshotEntry>();

  async function recordBatch(paths: string[]): Promise<void> {
    // Defense in depth: never record changes to .dohc/** (our own history
    // writes, manifest, cache) — recording them would feed back into the
    // watcher. The watcher already ignores these; this guards a leak.
    const userPaths = paths.filter((p) => !shouldIgnoreWatchPath(p));
    if (userPaths.length === 0) return;
    // Sync-batch instrumentation: brackets the real settle→record work
    // (existence checks, hashing, sidecar collapse, durable history write).
    desktopMarks.mark("sync-batch-start");
    const rawEvents = await pathsToEvents(workspace.rootPath, userPaths);
    // Fold SQLite WAL/journal/shm churn into a single base-db update so the
    // history shows "wallet.sqlite changed", never the transient sidecars.
    const events = collapseSqliteSidecars(rawEvents);
    if (events.length === 0) return;
    const batch: WatcherEventBatch = {
      settledAtMs: now(),
      windowMs: options.settleMs ?? 500,
      events,
    };
    // Attribute to the active agent run if one is in flight when the batch
    // settles, else to the local user. The agent-run provenance both sets
    // kind:"agent-run" (via batchToChangeSet) and keeps agentRunId locally
    // meaningful (the .dohc/agent-runs.json record AgentIntegration persists).
    const localOperationBatch = { paths: userPaths, events };
    const localOperationCandidate =
      options.activeLocalOperation?.(localOperationBatch) ?? null;
    const localOperation =
      localOperationCandidate &&
      activeLocalOperationMatchesBatch(localOperationCandidate, localOperationBatch)
        ? localOperationCandidate
        : null;
    const run = localOperation ? null : (options.activeAgentRun?.() ?? null);
    const author: ChangeAuthor = run
      ? { kind: "agent", agentId: run.agentId, onBehalfOf: run.onBehalfOf }
      : LOCAL_USER;
    const provenance: ChangeProvenance | undefined =
      localOperation?.provenance ??
      (run ? { source: "agent-run", agentRunId: run.agentRunId } : undefined);
    const changeSet = await attachHistorySnapshots(
      workspace.rootPath,
      snapshotCache,
      batchToChangeSet(batch, {
        author,
        ...(localOperation?.summary ? { summary: localOperation.summary } : {}),
        ...(provenance ? { provenance } : {}),
      }),
    );
    await store.record(changeSet, { id: randomUUID(), recordedAtMs: now() });
    desktopMarks.measureSince("sync-batch", "sync-batch-start");
    desktopMarks.mark("sync-batch-complete");
    options.onRecorded?.();
  }

  // Batches are processed strictly in order on one chain; a failure is logged
  // with workspace context (never an unhandled rejection that could kill the
  // main process) and the chain stays alive for the next batch. stop() awaits
  // this chain so the final pre-quit batch is durably recorded before exit.
  let recording: Promise<void> = Promise.resolve();

  const watcher = watchWorkspaceEvents(
    { rootDir: workspace.rootPath, settleMs: options.settleMs },
    (paths) => {
      recording = recording.then(() =>
        recordBatch(paths).catch((error) => {
          console.error(
            `[desktop] failed to record history for ${workspace.rootPath}:`,
            error,
          );
        }),
      );
    },
  );

  const ready = watcher.ready.then(async () => {
    snapshotCache = await seedHistorySnapshotCache(workspace.rootPath);
  });

  return {
    ready,
    stop: async () => {
      watcher.stop();
      await recording;
    },
  };
}

export { createChangeSetStore, humanSummary };
