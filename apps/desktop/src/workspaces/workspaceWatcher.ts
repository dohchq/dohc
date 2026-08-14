import type { WatcherEvent } from "@dohc/workspace-core";
import {
  collapseSqliteSidecars,
  shouldIgnoreWatchPath,
  watchWorkspaceEvents,
} from "@dohc/workspace-fs";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { desktopMarks } from "../performance/desktopMarks";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";

// Retirement Phase C (WS-H1): the legacy .dohc/history change-set recorder is
// gone. The watcher has exactly one recording sink — the workspace engine
// capture. A workspace that explicitly opted out of the engine has NO history
// recorder at all (the honest consequence of retiring the legacy stack); the
// watcher still settles batches so the UI refreshes and cloud sync queues,
// but nothing records.

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

// Wires the file watcher to the engine capture: each settled batch of changes
// is enqueued onto the capture chain (engine moments). onRecorded lets the
// desktop layer refresh sync status and push the new timeline entry to the
// renderer; it fires for every settled batch, recorded or not, because it
// also drives UI refresh and the cloud-sync queue.
export function startWorkspaceWatch(
  workspace: CreatedWorkspace,
  options: {
    settleMs?: number;
    onRecorded?: () => void;
    // Internal consumers that need path detail (for example, the plugin
    // pipeline) receive the same settled batch before onRecorded triggers the
    // renderer's path-free activity notification. This adds no debounce.
    onSettledBatch?: (events: WatcherEvent[]) => void;
    // Read at the moment a batch settles: a non-null capture records the
    // batch as engine moments. Null (explicit engine opt-out, or a failed
    // capture build) means NOTHING records — retirement Phase C removed the
    // legacy recorder. Enqueue-only: the watcher never waits on the engine.
    engineCapture?: () => Pick<WorkspaceEngineCapture, "captureBatch"> | null;
  } = {},
): WorkspaceWatchHandle {
  async function recordBatch(paths: string[]): Promise<void> {
    // Defense in depth: never record changes to .dohc/** (our own engine
    // writes, manifest, cache) — recording them would feed back into the
    // watcher. The watcher already ignores these; this guards a leak.
    const userPaths = paths.filter((p) => !shouldIgnoreWatchPath(p));
    if (userPaths.length === 0) return;
    // Sync-batch instrumentation: brackets the real settle→record work
    // (existence checks, hashing, sidecar collapse, capture enqueue).
    desktopMarks.mark("sync-batch-start");
    const rawEvents = await pathsToEvents(workspace.rootPath, userPaths);
    // Fold SQLite WAL/journal/shm churn into a single base-db update so the
    // history shows "wallet.sqlite changed", never the transient sidecars.
    const events = collapseSqliteSidecars(rawEvents);
    if (events.length === 0) return;
    // One recorder per workspace: the engine. Engine errors are handled on
    // the capture chain (fail visible via the capture-failure notice, never
    // a watcher crash); engine-originated writes were registered as expected
    // events and are skipped there. A null capture records nothing.
    const engineCapture = options.engineCapture?.() ?? null;
    if (engineCapture) {
      try {
        engineCapture.captureBatch(events);
      } catch (error) {
        console.error(
          `[desktop] failed to enqueue engine capture for ${workspace.rootPath}:`,
          error,
        );
      }
    }
    desktopMarks.measureSince("sync-batch", "sync-batch-start");
    desktopMarks.mark("sync-batch-complete");
    try {
      options.onSettledBatch?.(events.map((event) => ({ ...event })));
    } catch (error) {
      console.error(
        `[desktop] settled workspace batch callback failed for ${workspace.rootPath}:`,
        error,
      );
    }
    options.onRecorded?.();
  }

  // Batches are processed strictly in order on one chain; a failure is logged
  // with workspace context (never an unhandled rejection that could kill the
  // main process) and the chain stays alive for the next batch. stop() awaits
  // this chain so the final pre-quit batch is enqueued before exit.
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
