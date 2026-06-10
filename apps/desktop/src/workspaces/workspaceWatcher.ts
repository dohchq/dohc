import type {
  ChangeAuthor,
  ChangeProvenance,
  WatcherEvent,
  WatcherEventBatch,
} from "@dohc/workspace-core";
import {
  collapseSqliteSidecars,
  shouldIgnoreWatchPath,
  watchWorkspaceEvents,
} from "@dohc/workspace-fs";
import { createChangeSetStore, humanSummary } from "@dohc/workspace-history";
import { batchToChangeSet } from "@dohc/workspace-sync";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { desktopMarks } from "../performance/desktopMarks";
import type { CreatedWorkspace } from "./createWorkspaceFolder";

// Local user is the implicit author of filesystem edits. When an agent run is
// active (an MCP-driven turn the user started), its writes are attributed to
// the agent instead — see ActiveAgentRun below.
const LOCAL_USER: ChangeAuthor = { kind: "user", userId: "local" };

// The active-run fact a batch attributes to: who the agent is and which run it
// belongs to. workspaceActivity owns the slot; the watcher only reads it.
export interface ActiveAgentRun {
  agentId: string;
  onBehalfOf: string;
  agentRunId: string;
}

async function sha256OrUndefined(absolute: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(absolute)).digest("hex");
  } catch {
    return undefined;
  }
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
  } = {},
): WorkspaceWatchHandle {
  const store = createChangeSetStore(workspace.rootPath);
  const now = options.now ?? (() => Date.now());

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
    const run = options.activeAgentRun?.() ?? null;
    const author: ChangeAuthor = run
      ? { kind: "agent", agentId: run.agentId, onBehalfOf: run.onBehalfOf }
      : LOCAL_USER;
    const provenance: ChangeProvenance | undefined = run
      ? { source: "agent-run", agentRunId: run.agentRunId }
      : undefined;
    const changeSet = batchToChangeSet(batch, { author, ...(provenance ? { provenance } : {}) });
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

  return {
    ready: watcher.ready,
    stop: async () => {
      watcher.stop();
      await recording;
    },
  };
}

export { createChangeSetStore, humanSummary };
