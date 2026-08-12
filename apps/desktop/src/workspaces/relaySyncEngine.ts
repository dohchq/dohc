import {
  RelayOriginDivergedError,
  RelayUnauthorizedError,
  type PullWorkspaceFromRelayResult,
  type PushWorkspaceToRelayResult,
  type RecoverRelayOriginResult,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";

export interface RelaySyncOperations {
  push(): Promise<PushWorkspaceToRelayResult>;
  pull(): Promise<PullWorkspaceFromRelayResult>;
  recoverOrigin(): Promise<RecoverRelayOriginResult>;
}

export interface CloudSyncEngineOptions {
  rootDir: string;
  remoteWorkspaceId: string;
  relay: SyncRelayConnection;
  // Selected once at the factory boundary and required for every rooted
  // engine. One bound daemon object serves the entire lifetime, so an
  // individual pass cannot fall back across relay identity protocols.
  operations: RelaySyncOperations;
  capture: WorkspaceEngineCapture;
  onChange: () => void;
  // The number of conflicts currently OPEN in the engine store. When
  // provided, each successful pass re-reads it so the snapshot reflects
  // reality after resolutions (local or replicated from another machine) —
  // never a monotone accumulator that keeps saying "conflict" after the
  // user resolved everything. Absent (tests/legacy), conflictsOpened
  // accumulates as before.
  countOpenConflicts?: () => Promise<number>;
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
  // Runs after the workspace pull has fully succeeded through the capture
  // gate (including materialization and cursor commit). Follow-up projection
  // work such as live chat bookmarks must be prompt, but is ancillary: a
  // failure is logged and contained so it cannot put relay sync into backoff.
  afterSuccessfulPull?: () => Promise<void>;
  // Dormant R13b shadow hook. No shipping caller supplies it; when the later
  // adapter wiring does, it runs only after the pull is fully durable and can
  // never put relay sync into backoff.
  onRustEngineAdapterPull?: () => Promise<void>;
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
  const operations = options.operations;
  const debounceMs = options.debounceMs ?? 1500;
  const initialBackoffMs = options.initialBackoffMs ?? 5000;
  const maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
  const failureNoticeThreshold = options.failureNoticeThreshold ?? 3;
  const nowMs = options.nowMs ?? (() => Date.now());

  let syncing = false;
  let lastSyncedAtMs: number | null = null;
  let pendingChangeCount = 0;
  let conflictCount = 0;
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
    const sharingDeclined: PushWorkspaceToRelayResult["sharingDeclined"] = [];
    const pullResult = await options.capture.runRelaySync(async () => {
      // A join-bootstrap engine is pull-only until its first pull succeeds:
      // a fresh join must never append ops before it has the remote state.
      if (!bootstrapPass) {
        try {
          sharingDeclined.push(...(await operations.push()).sharingDeclined);
        } catch (error) {
          if (!(error instanceof RelayOriginDivergedError)) throw error;
          // The local engine.db was restored-from-older or cloned, so its
          // origin diverged from the relay's authoritative record. Re-baseline
          // onto a fresh origin — preserving local-only work as conflicts where
          // it clashes, never dropping it — then push under the fresh origin.
          await operations.recoverOrigin();
          sharingDeclined.push(...(await operations.push()).sharingDeclined);
        }
      }
      try {
        return await operations.pull();
      } catch (error) {
        if (!(error instanceof RelayOriginDivergedError)) throw error;
        // A pull can find that this machine's local origin disagrees with its
        // own relay echo. Re-baseline that origin, preserve its local suffix,
        // and retry the pass instead of backing off against the same page.
        await operations.recoverOrigin();
        if (!bootstrapPass) {
          sharingDeclined.push(...(await operations.push()).sharingDeclined);
        }
        return operations.pull();
      }
    });
    // Only a FULLY successful pull (materialized + cursor committed inside
    // runRelaySync) completes the bootstrap; a throw above leaves the next
    // retry pull-only.
    bootstrapPullPending = false;
    if (options.afterSuccessfulPull) {
      try {
        await options.afterSuccessfulPull();
      } catch (error) {
        console.error(`[desktop] post-pull work failed for ${options.rootDir}:`, error);
      }
    }
    if (options.onRustEngineAdapterPull) {
      try {
        await options.onRustEngineAdapterPull();
      } catch (error) {
        console.error(
          `[desktop] Rust engine adapter post-pull failed for ${options.rootDir}:`,
          error,
        );
      }
    }
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
    sharingDeclined.push(...(pullResult.sharingDeclined ?? []));
    for (const declined of sharingDeclined) {
      console.warn(
        `[desktop] ${options.rootDir}: File ${declined.path} is too large to share. ${declined.constraint} allows ${declined.limitBytes} bytes; the encoded base uses ${declined.observedBytes} bytes. The edit is saved. Reduce the file to share it.`,
      );
    }
    conflictCount = options.countOpenConflicts
      ? await options.countOpenConflicts()
      : conflictCount + pullResult.conflictsOpened;
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
