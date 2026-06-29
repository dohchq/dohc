import { deriveSyncStatus, type FileChange } from "@dohc/workspace-core";
import type { ChangeSetStore, HistoryRecord } from "@dohc/workspace-history";
import type {
  ChangeSetLineStats,
  ReadChangeSetResult,
  ChangeSetRecord,
  SyncStatusResult,
} from "../ipc/bridgeContract";
import type { CloudSyncEngine } from "./cloudSyncEngine";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import {
  DESKTOP_HISTORY_STORE_OPTIONS,
  createChangeSetStore,
  humanSummary,
  activeLocalOperationMatchesBatch,
  startWorkspaceWatch,
  type ActiveAgentRun,
  type ActiveLocalOperation,
  type WorkspaceWatchHandle,
} from "./workspaceWatcher";

interface WatchedWorkspace {
  workspace: CreatedWorkspace;
  handle: WorkspaceWatchHandle;
  inFlight: boolean;
  lastSyncedAtMs: number | null;
  engine: CloudSyncEngine | null;
  // The agent run whose writes this workspace's settled batches attribute to
  // right now; null when the local user is editing. AgentIntegration sets it.
  agentRun: ActiveAgentRun | null;
  pendingLocalOperations: PendingLocalOperation[];
}

interface PendingLocalOperation extends ActiveLocalOperation {
  expiresAtMs: number;
}

const HISTORY_FILE_PREVIEW_LIMIT = 4;
const HISTORY_BOUNDARY_PREVIEW_LIMIT = 3;
const HISTORY_LIST_DIFF_CELL_LIMIT = 60_000;
const desktopHistoryFallbackStores = new Map<string, ChangeSetStore>();

function desktopHistoryFallbackStore(rootPath: string): ChangeSetStore {
  const existing = desktopHistoryFallbackStores.get(rootPath);
  if (existing) return existing;
  const store = createChangeSetStore(rootPath, DESKTOP_HISTORY_STORE_OPTIONS);
  desktopHistoryFallbackStores.set(rootPath, store);
  return store;
}

function splitHistoryLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized.length === 0) return [];
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function countChangedLines(
  beforeText: string | undefined,
  afterText: string | undefined,
): { added: number; removed: number } | null {
  if (beforeText === undefined && afterText === undefined) return null;
  if (beforeText === afterText) return { added: 0, removed: 0 };
  const before = splitHistoryLines(beforeText ?? "");
  const after = splitHistoryLines(afterText ?? "");
  if (before.length === 0) return { added: after.length, removed: 0 };
  if (after.length === 0) return { added: 0, removed: before.length };

  const cellCount = (before.length + 1) * (after.length + 1);
  if (cellCount > HISTORY_LIST_DIFF_CELL_LIMIT) {
    return { added: after.length, removed: before.length };
  }

  const columnCount = after.length + 1;
  const table = new Uint16Array(cellCount);
  const at = (beforeIndex: number, afterIndex: number) =>
    beforeIndex * columnCount + afterIndex;

  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      if (before[beforeIndex] === after[afterIndex]) {
        table[at(beforeIndex, afterIndex)] =
          table[at(beforeIndex + 1, afterIndex + 1)] + 1;
      } else {
        table[at(beforeIndex, afterIndex)] = Math.max(
          table[at(beforeIndex + 1, afterIndex)],
          table[at(beforeIndex, afterIndex + 1)],
        );
      }
    }
  }

  const common = table[at(0, 0)];
  return {
    added: after.length - common,
    removed: before.length - common,
  };
}

function summarizeLineStats(files: FileChange[]): ChangeSetLineStats | undefined {
  const stats = files.reduce<ChangeSetLineStats>(
    (totals, file) => {
      const counts = countChangedLines(file.before?.text, file.after?.text);
      if (!counts) {
        totals.unavailableFileCount += 1;
        return totals;
      }
      totals.added += counts.added;
      totals.removed += counts.removed;
      if (counts.added > 0 || counts.removed > 0) {
        totals.changedFileCount += 1;
      }
      return totals;
    },
    { added: 0, removed: 0, changedFileCount: 0, unavailableFileCount: 0 },
  );

  if (
    stats.added === 0 &&
    stats.removed === 0 &&
    stats.changedFileCount === 0 &&
    stats.unavailableFileCount === 0
  ) {
    return undefined;
  }
  return stats;
}

export interface WorkspaceActivityOptions {
  // Live facts main owns: whether this workspace has cloud sync enabled
  // (registry remote identity) and whether a cloud session exists right now.
  cloudStateFor?: (workspaceId: string) => { enabled: boolean; connected: boolean };
  // Builds a sync engine for a workspace when it is enabled AND connected;
  // null keeps the workspace local-only. Called on open and on enableCloud.
  engineFor?: (workspace: CreatedWorkspace) => CloudSyncEngine | null;
}

function mergeHistoryRecords(
  records: HistoryRecord[],
  order: "newest-first" | "oldest-first",
): HistoryRecord[] {
  const unique = new Map<string, HistoryRecord>();
  for (const record of records) {
    if (!unique.has(record.id)) unique.set(record.id, record);
  }
  return [...unique.values()].sort((a, b) => {
    const time = a.recordedAtMs - b.recordedAtMs;
    const id = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return order === "oldest-first" ? time || id : -(time || id);
  });
}

function historyReadStores(rootPath: string) {
  const durable = createChangeSetStore(rootPath);
  const fallback = desktopHistoryFallbackStore(rootPath);
  const durableRecordsOrEmpty = async (
    read: () => Promise<HistoryRecord[]>,
  ): Promise<HistoryRecord[]> => {
    try {
      return await read();
    } catch {
      return [];
    }
  };
  return {
    async list() {
      return mergeHistoryRecords(
        [...(await fallback.list()), ...(await durableRecordsOrEmpty(() => durable.list()))],
        "newest-first",
      );
    },
    async get(id: string) {
      const fallbackRecord = await fallback.get(id);
      if (fallbackRecord) return fallbackRecord;
      try {
        return await durable.get(id);
      } catch {
        return null;
      }
    },
  };
}

// Owns the live file-watch → history pipeline per workspace, the optional
// cloud sync engine riding on it, and the derived sync status. The desktop
// layer opens a workspace once; subsequent timeline and status reads are
// served from here, and activity pushes notify the UI.
export function createWorkspaceActivity(
  notify: () => void,
  options: WorkspaceActivityOptions = {},
) {
  const watched = new Map<string, WatchedWorkspace>();

  function statusFor(workspaceId: string): SyncStatusResult {
    const w = watched.get(workspaceId);
    const cloud = options.cloudStateFor?.(workspaceId) ?? {
      enabled: false,
      connected: false,
    };
    const snap = w?.engine?.snapshot();
    const conflictCount = snap?.conflictCount ?? 0;
    const status = deriveSyncStatus({
      pendingChangeCount: snap?.pendingChangeCount ?? 0,
      inFlight: (w?.inFlight ?? false) || (snap?.syncing ?? false),
      hasConflict: conflictCount > 0,
      cloudEnabled: cloud.enabled,
      // A confirmed-401 engine reads as disconnected (the existing
      // "cloud-disconnected" surface) so the UI stops saying "connected" and
      // prompts re-login, instead of spinning on a dead token.
      cloudConnected: cloud.connected && !(snap?.authExpired ?? false),
      lastSyncedAtMs: snap?.lastSyncedAtMs ?? w?.lastSyncedAtMs ?? null,
    });
    // Additive surface: the status bar shows HOW MANY files conflict.
    return { ...status, conflictCount };
  }

  async function open(workspace: CreatedWorkspace): Promise<SyncStatusResult> {
    if (!watched.has(workspace.workspaceId)) {
      const entry: WatchedWorkspace = {
        workspace,
        inFlight: false,
        lastSyncedAtMs: null,
        handle: { stop: async () => {}, ready: Promise.resolve() },
        engine: null,
        agentRun: null,
        pendingLocalOperations: [],
      };
      watched.set(workspace.workspaceId, entry);
      entry.handle = startWorkspaceWatch(workspace, {
        // Read live at settle time so a batch is attributed to whatever run is
        // active then — the slot may flip between batches within one open.
        activeAgentRun: () => entry.agentRun,
        activeLocalOperation: ({ paths, events }) => {
          const now = Date.now();
          entry.pendingLocalOperations = entry.pendingLocalOperations.filter(
            (operation) => operation.expiresAtMs > now,
          );
          const index = entry.pendingLocalOperations.findIndex((operation) =>
            activeLocalOperationMatchesBatch(operation, { paths, events }),
          );
          if (index < 0) return null;
          const [operation] = entry.pendingLocalOperations.splice(index, 1);
          return operation ?? null;
        },
        onRecorded: () => {
          entry.inFlight = false;
          entry.lastSyncedAtMs = Date.now();
          // Every settled local change set queues a (debounced) cloud push.
          entry.engine?.queueSync();
          notify();
        },
      });
      // Don't report the workspace open until the watcher's initial scan is
      // done — a write made right after openWorkspace resolves is guaranteed
      // observed. Bounded so a pathological scan can't hang the renderer.
      await Promise.race([
        entry.handle.ready,
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
      const engine = options.engineFor?.(workspace) ?? null;
      if (engine) {
        entry.engine = engine;
        // Initial pull+push runs in the background; status updates stream in
        // through onChange/notify rather than blocking the open.
        void engine.start();
      }
    }
    return statusFor(workspace.workspaceId);
  }

  // Enable-sync path: build the engine now (registry remote was just set) and
  // wait for first contact so the caller can surface immediate failures.
  async function enableCloud(workspace: CreatedWorkspace): Promise<void> {
    const entry = watched.get(workspace.workspaceId);
    if (!entry) throw new Error(`Workspace is not open: ${workspace.workspaceId}`);
    if (entry.engine) return;
    const engine = options.engineFor?.(workspace) ?? null;
    if (!engine) throw new Error("Cloud sync requires a signed-in dohc Cloud session");
    entry.engine = engine;
    try {
      // Propagate first-contact failure: a dead token must surface here, not be
      // swallowed while the UI claims sync is enabled.
      await engine.start();
    } catch (error) {
      // Roll back so a retry can re-attach a fresh engine.
      await engine.stop().catch(() => undefined);
      entry.engine = null;
      throw error;
    }
    notify();
  }

  // After a login completes, attach engines to already-open cloud-enabled
  // workspaces that don't have one yet (they were opened local-only because no
  // session existed). engineFor returns null when the workspace is local-only
  // or signed into a different server.
  function reconcileCloud(
    engineFor: (workspace: CreatedWorkspace) => CloudSyncEngine | null,
  ): void {
    for (const entry of watched.values()) {
      if (entry.engine) continue;
      const engine = engineFor(entry.workspace);
      if (!engine) continue;
      entry.engine = engine;
      void engine.start();
    }
    notify();
  }

  // Logout path: stop and detach every cloud engine so edits after Disconnect
  // never push with the now-cleared session. The watchers keep running (local
  // history is unaffected).
  async function stopEngines(): Promise<void> {
    const stops: Array<Promise<void>> = [];
    for (const entry of watched.values()) {
      if (!entry.engine) continue;
      stops.push(entry.engine.stop().catch(() => undefined));
      entry.engine = null;
    }
    await Promise.all(stops);
    notify();
  }

  async function listChangeSets(
    workspace: CreatedWorkspace,
  ): Promise<ChangeSetRecord[]> {
    const store = historyReadStores(workspace.rootPath);
    const records = await store.list();
    return records.map((record) => ({
      id: record.id,
      recordedAtMs: record.recordedAtMs,
      kind: record.kind,
      author: record.author,
      summary: record.summary,
      humanSummary: humanSummary(record),
      fileCount: record.files.length,
      reviewRequired: record.boundaryCrossings.length > 0,
      boundaryCrossingCount: record.boundaryCrossings.length,
      filePreview: record.files
        .slice(0, HISTORY_FILE_PREVIEW_LIMIT)
        .map((file) => ({ path: file.path, operation: file.operation })),
      lineStats: summarizeLineStats(record.files),
      boundaryCrossingPreview: record.boundaryCrossings.slice(
        0,
        HISTORY_BOUNDARY_PREVIEW_LIMIT,
      ),
    }));
  }

  async function readChangeSet(
    workspace: CreatedWorkspace,
    id: string,
  ): Promise<ReadChangeSetResult> {
    const store = historyReadStores(workspace.rootPath);
    const record = await store.get(id);
    return {
      changeSet: record
        ? {
            id: record.id,
            recordedAtMs: record.recordedAtMs,
            kind: record.kind,
            author: record.author,
            summary: record.summary,
            humanSummary: humanSummary(record),
            fileCount: record.files.length,
            files: record.files,
            boundaryCrossings: record.boundaryCrossings,
            ...(record.provenance ? { provenance: record.provenance } : {}),
          }
        : null,
    };
  }

  function getStatus(workspaceId: string): SyncStatusResult {
    return statusFor(workspaceId);
  }

  // Sets (or clears) the active agent run for an OPEN workspace. The watcher
  // reads this slot when a batch settles, so writes made during the run are
  // attributed to the agent. Throws if the workspace isn't open — a run can
  // only attach to a live watcher.
  function setAgentRun(workspaceId: string, run: ActiveAgentRun | null): void {
    const entry = watched.get(workspaceId);
    if (!entry) throw new Error(`Workspace is not open: ${workspaceId}`);
    entry.agentRun = run;
  }

  function beginLocalOperation(
    workspaceId: string,
    operation: ActiveLocalOperation,
  ): () => void {
    const entry = watched.get(workspaceId);
    if (!entry) throw new Error(`Workspace is not open: ${workspaceId}`);
    const pending: PendingLocalOperation = {
      ...operation,
      expiresAtMs: Date.now() + 10_000,
    };
    entry.pendingLocalOperations.push(pending);
    return () => {
      entry.pendingLocalOperations = entry.pendingLocalOperations.filter(
        (candidate) => candidate !== pending,
      );
    };
  }

  // Resolves once every watcher has flushed AND its in-flight records are
  // written — the quit path awaits this so the last save is never dropped.
  async function stopAll(): Promise<void> {
    const stops = [...watched.values()].flatMap((w) => [
      w.handle.stop(),
      w.engine?.stop() ?? Promise.resolve(),
    ]);
    watched.clear();
    await Promise.all(stops);
  }

  return {
    open,
    enableCloud,
    reconcileCloud,
    stopEngines,
    listChangeSets,
    readChangeSet,
    getStatus,
    setAgentRun,
    beginLocalOperation,
    stopAll,
  };
}
