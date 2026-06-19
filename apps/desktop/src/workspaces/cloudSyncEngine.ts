import { createMergeSync, UnauthorizedSyncError, type MergeSync } from "@dohc/workspace-sync";

// Per-workspace cloud sync loop. Local stays canonical: pushes are debounced
// behind the watcher's settled batches, pulls happen on engine start (app
// open / sync enable), and every operation goes through the MERGE engine —
// never the clone-style materializer, which would destroy .dohc and
// not-yet-pushed files. All work runs on one chain so pushes never interleave.

export interface CloudSyncEngineOptions {
  rootDir: string;
  remoteWorkspaceId: string;
  serverUrl: string;
  token: string;
  // Status changed (sync started/finished) — the desktop pushes a renderer
  // notification so the status bar updates live.
  onChange: () => void;
  debounceMs?: number;
  sync?: MergeSync; // injected in tests
}

export interface CloudSyncSnapshot {
  syncing: boolean;
  lastSyncedAtMs: number | null;
  pendingChangeCount: number;
  conflictCount: number;
  // The session token is expired/revoked (a confirmed 401). The retry loop is
  // stopped and the UI should prompt re-login; local data is safe (local-first)
  // but cloud sync is paused until the user reconnects.
  authExpired: boolean;
}

export interface CloudSyncEngine {
  // First contact: create the baseline if needed, pull the remote state,
  // push anything local. Used both for enable-sync and app open.
  start(): Promise<void>;
  // Called after each recorded local change set; debounced push.
  queueSync(): void;
  snapshot(): CloudSyncSnapshot;
  // Resolves when in-flight work has drained (quit path).
  stop(): Promise<void>;
}

export function createCloudSyncEngine(options: CloudSyncEngineOptions): CloudSyncEngine {
  const sync =
    options.sync ??
    createMergeSync({
      rootDir: options.rootDir,
      remoteWorkspaceId: options.remoteWorkspaceId,
      serverUrl: options.serverUrl,
      token: options.token,
    });
  const debounceMs = options.debounceMs ?? 1500;

  let syncing = false;
  let lastSyncedAtMs: number | null = null;
  let pendingChangeCount = 0;
  let conflictCount = 0;
  let authExpired = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  // A 401 is terminal for this engine: keep retrying a dead token forever would
  // climb pendingChangeCount while claiming "connected". Flip authExpired,
  // stop the loop, and let the UI prompt re-login.
  function handleSyncError(error: unknown): void {
    if (error instanceof UnauthorizedSyncError) {
      authExpired = true;
      stopped = true;
      return;
    }
    // Other failures (transient network, oversize) never crash the app or lose
    // local data — pending stays up and the next settled batch retries.
    console.error(`[desktop] cloud sync failed for ${options.rootDir}:`, error);
  }

  function run(task: () => Promise<void>): Promise<void> {
    const next = chain.then(async () => {
      if (stopped) return;
      syncing = true;
      options.onChange();
      try {
        await task();
      } catch (error) {
        handleSyncError(error);
      } finally {
        syncing = false;
        options.onChange();
      }
    });
    chain = next;
    return next;
  }

  async function firstContact(): Promise<void> {
    await sync.initialize();
    const pulled = await sync.pull();
    conflictCount += pulled.conflicts.length;
    await pushNow();
  }

  async function pushNow(): Promise<void> {
    const before = pendingChangeCount;
    const result = await sync.push();
    conflictCount += result.conflicts.length;
    pendingChangeCount = Math.max(0, pendingChangeCount - before);
    lastSyncedAtMs = Date.now();
  }

  return {
    // Enable-sync MUST see a first-contact failure (e.g. a dead token), so
    // start() rethrows instead of swallowing it the way run() does — otherwise
    // the UI would falsely report success. It still serializes on the chain so
    // it never interleaves with a debounced push.
    async start() {
      const result = chain.then(async () => {
        if (stopped) return;
        syncing = true;
        options.onChange();
        try {
          await firstContact();
        } catch (error) {
          handleSyncError(error);
          throw error;
        } finally {
          syncing = false;
          options.onChange();
        }
      });
      // Keep the chain alive even if this start rejects (caller handles it).
      chain = result.catch(() => undefined);
      await result;
    },

    queueSync() {
      // A known-dead session does not accumulate work or retry.
      if (authExpired || stopped) return;
      pendingChangeCount += 1;
      options.onChange();
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void run(pushNow);
      }, debounceMs);
    },

    snapshot() {
      return { syncing, lastSyncedAtMs, pendingChangeCount, conflictCount, authExpired };
    },

    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await chain;
    },
  };
}
