import {
  RelayUnauthorizedError,
  pullWorkspaceFromRelay,
  pushWorkspaceToRelay,
  type SyncRelayConnection,
} from "@dohc/workspace-engine";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";

export interface CloudSyncEngineOptions {
  rootDir: string;
  remoteWorkspaceId: string;
  relay: SyncRelayConnection;
  capture: WorkspaceEngineCapture;
  onChange: () => void;
  debounceMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  failureNoticeThreshold?: number;
  nowMs?: () => number;
}

export interface CloudSyncSnapshot {
  syncing: boolean;
  lastSyncedAtMs: number | null;
  pendingChangeCount: number;
  conflictCount: number;
  authExpired: boolean;
  syncFailing?: boolean;
}

export interface CloudSyncEngine {
  start(): Promise<void>;
  queueSync(): void;
  snapshot(): CloudSyncSnapshot;
  stop(): Promise<void>;
}

export function createRelaySyncEngine(options: CloudSyncEngineOptions): CloudSyncEngine {
  const debounceMs = options.debounceMs ?? 1500;
  const initialBackoffMs = options.initialBackoffMs ?? 5000;
  const maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
  const failureNoticeThreshold = options.failureNoticeThreshold ?? 3;
  const nowMs = options.nowMs ?? (() => Date.now());

  let syncing = false;
  let lastSyncedAtMs: number | null = null;
  let pendingChangeCount = 0;
  let conflictCount = 0;
  let authExpired = false;
  let syncFailing = false;
  let stopped = false;
  let consecutiveFailures = 0;
  let nextBackoffMs = initialBackoffMs;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let backoffTimer: ReturnType<typeof setTimeout> | undefined;
  let retryQueued = false;
  let chain: Promise<void> = Promise.resolve();

  function setSyncFailing(value: boolean): void {
    if (syncFailing === value) return;
    syncFailing = value;
    options.onChange();
  }

  function clearTimers(): void {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    if (backoffTimer !== undefined) {
      clearTimeout(backoffTimer);
      backoffTimer = undefined;
    }
  }

  function scheduleBackoff(): void {
    if (stopped || authExpired || backoffTimer !== undefined) return;
    const delay = nextBackoffMs;
    nextBackoffMs = Math.min(maxBackoffMs, nextBackoffMs * 2);
    retryQueued = true;
    backoffTimer = setTimeout(() => {
      backoffTimer = undefined;
      if (!retryQueued || stopped || authExpired) return;
      retryQueued = false;
      void runPass(false);
    }, delay);
  }

  function handleFailure(error: unknown): void {
    if (error instanceof RelayUnauthorizedError) {
      authExpired = true;
      stopped = true;
      clearTimers();
      options.onChange();
      return;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= failureNoticeThreshold) setSyncFailing(true);
    console.error(`[desktop] relay sync failed for ${options.rootDir}:`, error);
    scheduleBackoff();
  }

  async function doPass(): Promise<void> {
    const beforePending = pendingChangeCount;
    const pullResult = await options.capture.runRelaySync(async () => {
      await pushWorkspaceToRelay({
        rootDir: options.rootDir,
        workspaceId: options.remoteWorkspaceId,
        relay: options.relay,
      });
      return pullWorkspaceFromRelay({
        rootDir: options.rootDir,
        workspaceId: options.remoteWorkspaceId,
        relay: options.relay,
      });
    });
    conflictCount += pullResult.conflictsOpened;
    pendingChangeCount = Math.max(0, pendingChangeCount - beforePending);
    lastSyncedAtMs = nowMs();
    consecutiveFailures = 0;
    nextBackoffMs = initialBackoffMs;
    setSyncFailing(false);
  }

  function runPass(rethrow: boolean): Promise<void> {
    const result = chain.then(async () => {
      if (stopped) return;
      syncing = true;
      options.onChange();
      try {
        await doPass();
      } catch (error) {
        handleFailure(error);
        if (rethrow) throw error;
      } finally {
        syncing = false;
        options.onChange();
      }
    });
    chain = result.catch(() => undefined);
    return result;
  }

  return {
    start() {
      return runPass(true);
    },

    queueSync() {
      if (authExpired || stopped) return;
      pendingChangeCount += 1;
      options.onChange();
      if (backoffTimer !== undefined) {
        retryQueued = true;
        return;
      }
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        void runPass(false);
      }, debounceMs);
    },

    snapshot() {
      return {
        syncing,
        lastSyncedAtMs,
        pendingChangeCount,
        conflictCount,
        authExpired,
        ...(syncFailing ? { syncFailing: true } : {}),
      };
    },

    async stop() {
      stopped = true;
      clearTimers();
      await chain;
    },
  };
}
