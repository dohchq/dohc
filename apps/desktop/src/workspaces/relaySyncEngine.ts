import {
  RelayOriginDivergedError,
  RelayUnauthorizedError,
  pullWorkspaceFromRelay,
  pushWorkspaceToRelay,
  recoverRelayOrigin,
  type PendingConflictResolve,
  type SyncRelayConnection,
} from "@dohc/workspace-engine";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";

export interface CloudSyncEngineOptions {
  rootDir: string;
  remoteWorkspaceId: string;
  relay: SyncRelayConnection;
  capture: WorkspaceEngineCapture;
  onChange: () => void;
  // The number of conflicts currently OPEN in the engine store. When
  // provided, each successful pass re-reads it so the snapshot reflects
  // reality after resolutions (local or replicated from another machine) —
  // never a monotone accumulator that keeps saying "conflict" after the
  // user resolved everything. Absent (tests/legacy), conflictsOpened
  // accumulates as before.
  countOpenConflicts?: () => Promise<number>;
  // The ids of the conflicts currently OPEN in the engine store, re-read
  // after each successful pass. Preferred over countOpenConflicts when both
  // are provided: beyond the count, the ids drive the pending remote-resolve
  // lifecycle — a peer resolution that matched a local conflict but could
  // not be applied clears from the "needs a look" set the moment that
  // conflict is no longer open (resolved locally or converged by a later
  // pull).
  listOpenConflictIds?: () => Promise<string[]>;
  // Join bootstrap (0P-C gate fix): this engine belongs to a freshly JOINED
  // workspace, so it must never append ops to the relay before its first
  // successful pull — pushing first could seed local boilerplate into the
  // remote workspace or mint conflicts against it. The first pass (and
  // every retry until one succeeds) is pull-only; after the first
  // successful pull+materialize+cursor-commit a follow-up pass resumes the
  // normal push-then-pull contract.
  joinBootstrap?: boolean;
  // MU-C4 shared channels: refresh the workspace's joined shared channels on
  // every sync pass (push member ops, pull peers'). Best-effort — the
  // callback owns its own error handling (revocation marking, logging); a
  // throw here is logged and never fails the workspace's own pass, so a
  // revoked share can't wedge file sync into permanent backoff.
  syncSharedChannels?: () => Promise<void>;
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
  // Conflict resolutions replicated from another machine that matched no
  // local conflict (neither by id nor by mirrored heads — the file moved on
  // here before the resolution arrived). Honest minimum for 0P-C: counted
  // and surfaced so the user knows to review, never silently swallowed.
  unmatchedRemoteResolves: number;
  authExpired: boolean;
  syncFailing?: boolean;
}

export interface CloudSyncEngine {
  start(): Promise<void>;
  queueSync(): void;
  snapshot(): CloudSyncSnapshot;
  // Explicit user dismissal of the "a choice made on another machine needs
  // a look" notice: clears the pending remote-resolve set (the only release
  // valve for resolves that matched no local conflict at all).
  dismissUnmatchedResolves(): void;
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
  // Pending peer resolutions keyed by the PEER's conflict id: a live set,
  // not a monotone counter. Entries dedupe re-reported ops across passes and
  // clear on (a) local resolution of the matched conflict, (b) explicit
  // notice dismissal, (c) a later pass converging the matched conflict.
  const pendingRemoteResolves = new Map<string, PendingConflictResolve>();
  // True until the first successful pull of a join-bootstrap engine.
  let bootstrapPullPending = options.joinBootstrap === true;
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
    const bootstrapPass = bootstrapPullPending;
    const pullResult = await options.capture.runRelaySync(async () => {
      // A join-bootstrap engine is pull-only until its first pull succeeds:
      // a fresh join must never append ops before it has the remote state.
      if (!bootstrapPass) {
        try {
          await pushWorkspaceToRelay({
            rootDir: options.rootDir,
            workspaceId: options.remoteWorkspaceId,
            relay: options.relay,
          });
        } catch (error) {
          if (!(error instanceof RelayOriginDivergedError)) throw error;
          // The local engine.db was restored-from-older or cloned, so its
          // origin diverged from the relay's authoritative record. Re-baseline
          // onto a fresh origin — preserving local-only work as conflicts where
          // it clashes, never dropping it — then push under the fresh origin.
          await recoverRelayOrigin({
            rootDir: options.rootDir,
            workspaceId: options.remoteWorkspaceId,
            relay: options.relay,
          });
          await pushWorkspaceToRelay({
            rootDir: options.rootDir,
            workspaceId: options.remoteWorkspaceId,
            relay: options.relay,
          });
        }
      }
      return pullWorkspaceFromRelay({
        rootDir: options.rootDir,
        workspaceId: options.remoteWorkspaceId,
        relay: options.relay,
      });
    });
    // Only a FULLY successful pull (materialized + cursor committed inside
    // runRelaySync) completes the bootstrap; a throw above leaves the next
    // retry pull-only.
    bootstrapPullPending = false;
    // Shared channels ride the same cadence but never gate the pass: chat
    // replay touches no workspace files, so it runs OUTSIDE runRelaySync's
    // capture gate, and its failures are contained here.
    if (options.syncSharedChannels) {
      try {
        await options.syncSharedChannels();
      } catch (error) {
        console.error(`[desktop] shared channel sync failed for ${options.rootDir}:`, error);
      }
    }
    for (const pending of pullResult.pendingResolves ?? []) {
      pendingRemoteResolves.set(pending.remoteConflictId, pending);
    }
    // Prefer the engine's open-conflict truth over accumulation: a pass that
    // pulled a peer's resolution (or ran after a local one) must DROP the
    // count, not only ever raise it. The same truth lifecycles the pending
    // remote-resolve set: once a matched conflict is no longer open, the
    // peer's resolution no longer "needs a look".
    if (options.listOpenConflictIds) {
      const openIds = new Set(await options.listOpenConflictIds());
      for (const [key, pending] of pendingRemoteResolves) {
        if (pending.localConflictId !== null && !openIds.has(pending.localConflictId)) {
          pendingRemoteResolves.delete(key);
        }
      }
      conflictCount = openIds.size;
    } else {
      conflictCount = options.countOpenConflicts
        ? await options.countOpenConflicts()
        : conflictCount + pullResult.conflictsOpened;
    }
    pendingChangeCount = Math.max(0, pendingChangeCount - beforePending);
    lastSyncedAtMs = nowMs();
    consecutiveFailures = 0;
    nextBackoffMs = initialBackoffMs;
    setSyncFailing(false);
    // The bootstrap pull done, immediately queue the first NORMAL pass so
    // local identity/journal ops reconcile without waiting for an edit.
    if (bootstrapPass && !stopped && !authExpired && debounceTimer === undefined) {
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        void runPass(false);
      }, 0);
    }
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
        unmatchedRemoteResolves: pendingRemoteResolves.size,
        authExpired,
        ...(syncFailing ? { syncFailing: true } : {}),
      };
    },

    dismissUnmatchedResolves() {
      if (pendingRemoteResolves.size === 0) return;
      pendingRemoteResolves.clear();
      options.onChange();
    },

    async stop() {
      stopped = true;
      clearTimers();
      await chain;
    },
  };
}
