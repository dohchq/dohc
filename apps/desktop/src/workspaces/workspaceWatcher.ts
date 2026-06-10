import type {
  ChangeAuthor,
  WatcherEvent,
  WatcherEventBatch,
} from "@dohc/workspace-core";
import { shouldIgnoreWatchPath, watchWorkspaceEvents } from "@dohc/workspace-fs";
import { createChangeSetStore, humanSummary } from "@dohc/workspace-history";
import { batchToChangeSet } from "@dohc/workspace-sync";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CreatedWorkspace } from "./createWorkspaceFolder";

// Local user is the implicit author of filesystem edits (an external agent's
// writes also land here; provenance/attribution sharpens in later phases).
const LOCAL_USER: ChangeAuthor = { kind: "user", userId: "local" };

async function sha256OrUndefined(absolute: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(absolute)).digest("hex");
  } catch {
    return undefined;
  }
}

// Turn the watcher's settled changed paths into WatcherEvents. Operation is
// inferred from current existence (present => write/create, absent => delete);
// this is the pure, testable core of the live pipeline.
export async function pathsToEvents(
  rootPath: string,
  paths: string[],
): Promise<WatcherEvent[]> {
  const events: WatcherEvent[] = [];
  for (const path of paths) {
    const absolute = join(rootPath, path);
    let exists = false;
    try {
      exists = (await stat(absolute)).isFile();
    } catch {
      exists = false;
    }
    events.push(
      exists
        ? { path, operation: "update", sha256: await sha256OrUndefined(absolute) }
        : { path, operation: "delete" },
    );
  }
  return events;
}

export interface WorkspaceWatchHandle {
  stop: () => void;
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
  } = {},
): WorkspaceWatchHandle {
  const store = createChangeSetStore(workspace.rootPath);
  const now = options.now ?? (() => Date.now());

  const stop = watchWorkspaceEvents(
    { rootDir: workspace.rootPath, settleMs: options.settleMs },
    (paths) => {
      void (async () => {
        // Defense in depth: never record changes to .dohc/** (our own history
        // writes, manifest, cache) — recording them would feed back into the
        // watcher. The watcher already ignores these; this guards a leak.
        const userPaths = paths.filter((p) => !shouldIgnoreWatchPath(p));
        if (userPaths.length === 0) return;
        const events = await pathsToEvents(workspace.rootPath, userPaths);
        if (events.length === 0) return;
        const batch: WatcherEventBatch = {
          settledAtMs: now(),
          windowMs: options.settleMs ?? 500,
          events,
        };
        const changeSet = batchToChangeSet(batch, { author: LOCAL_USER });
        await store.record(changeSet, { id: randomUUID(), recordedAtMs: now() });
        options.onRecorded?.();
      })();
    },
  );

  return { stop };
}

export { createChangeSetStore, humanSummary };
