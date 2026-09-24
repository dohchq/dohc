import {
  RelayOriginDivergedError,
  RelayUnauthorizedError,
  type PullWorkspaceFromRelayResult,
  type MaterializeRelayPullPage,
  type PushWorkspaceToRelayResult,
  type RecoverRelayOriginResult,
  type SharingDeclined,
  type OwnerAdmissionPending,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";

export interface RelaySyncOperations {
  push(): Promise<PushWorkspaceToRelayResult>;
  pull(
    materializePage: MaterializeRelayPullPage,
  ): Promise<PullWorkspaceFromRelayResult>;
  recoverOrigin(): Promise<RecoverRelayOriginResult>;
}

export interface CloudSyncEngineOptions {
  rootDir: string;
  relay: SyncRelayConnection;
  // Selected once at the factory boundary and required for every rooted
  // engine. One bound daemon object serves the entire lifetime, so an
  // individual pass cannot fall back across relay identity protocols.
  operations: RelaySyncOperations;
  capture: WorkspaceEngineCapture;
  onChange: () => void;
  // The number of conflicts currently open in the engine store. When
  // provided, each successful pass re-reads it so the snapshot reflects
  // reality after resolutions (local or replicated from another machine) —
  // never a monotone accumulator that keeps saying "conflict" after the
  // user resolved everything. Absent (tests/legacy), conflictsOpened
  // accumulates as before.
  countOpenConflicts?: () => Promise<number>;
  // Join bootstrap (0P-C gate fix): this engine belongs to a freshly joined
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
  // revoked share can't wedge file sync into permanent backoff. Resolves true
  // when it applied ops, so a quiet pass announces its end.
  syncSharedChannels?: () => Promise<boolean>;
  // Runs after the workspace pull has fully succeeded through the capture
  // gate (including materialization and cursor commit). Follow-up projection
  // work such as live chat bookmarks must be prompt, but is ancillary: a
  // failure is logged and contained so it cannot put relay sync into backoff.
  // `recovered` is true for the first successful pass after a failed one,
  // which is when the relay answers again.
  afterSuccessfulPull?: (pass: { recovered: boolean }) => Promise<void>;
  // Runs before each pull request is sent, and must finish any durable write
  // it needs before it returns. The function it returns runs when that pull
  // ends, whatever the outcome.
  pullStarting?: () => () => void;
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
  sharingDeclined: SharingDeclined[];
  ownerAdmissionPending?: OwnerAdmissionPending[];
  syncFailing?: boolean;
}

export interface CloudSyncEngine {
  start(): Promise<void>;
  queueSync(): void;
  queuePull(): void;
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
  let sharingDeclined: SharingDeclined[] = [];
  let ownerAdmissionPending: OwnerAdmissionPending[] = [];
  let stopped = false;
  let consecutiveFailures = 0;
  let nextBackoffMs = initialBackoffMs;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let backoffTimer: ReturnType<typeof setTimeout> | undefined;
  // A pull the Chats polls asked for while local writes held the debounce.
  let pullTimer: ReturnType<typeof setTimeout> | undefined;
  let retryQueued = false;
  // Passes queued on the chain or running. Each of them pulls.
  let passesPending = 0;
  // Counts change events, so a quiet pass knows whether anything announced
  // `syncing` while it ran.
  let changeEvents = 0;
  let chain: Promise<void> = Promise.resolve();

  function emitChange(): void {
    changeEvents += 1;
    options.onChange();
  }

  function setSyncFailing(value: boolean): void {
    if (syncFailing === value) return;
    syncFailing = value;
    emitChange();
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
    if (pullTimer !== undefined) {
      clearTimeout(pullTimer);
      pullTimer = undefined;
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
      emitChange();
      return;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= failureNoticeThreshold) setSyncFailing(true);
    console.error(`[desktop] relay sync failed for ${options.rootDir}:`, error);
    scheduleBackoff();
  }

  // Resolves true when the workspace pull or the shared-channel pass applied
  // ops. The shared-channel pass tells the renderer itself, and the renderer
  // then reads `syncing`, so a quiet pass must announce that it ended.
  async function doPass(): Promise<boolean> {
    const beforePending = pendingChangeCount;
    const bootstrapPass = bootstrapPullPending;
    let passOwnerPending = ownerAdmissionPending;
    const push = async () => {
      const result = await operations.push();
      passSharingDeclined.push(...result.sharingDeclined);
      passOwnerPending = result.ownerAdmissionPending;
    };
    const passSharingDeclined: PushWorkspaceToRelayResult["sharingDeclined"] = [];
    const pullResult = await options.capture.runRelaySync(
      async (materializePage) => {
        const pull = async () => {
          const ended = options.pullStarting?.();
          try {
            return await operations.pull(materializePage);
          } finally {
            ended?.();
          }
        };
        // A join-bootstrap engine is pull-only until its first pull succeeds:
        // a fresh join must never append ops before it has the remote state.
        if (!bootstrapPass) {
          try {
            await push();
          } catch (error) {
            if (!(error instanceof RelayOriginDivergedError)) throw error;
            // The local engine.db was restored-from-older or cloned, so its
            // origin diverged from the relay's authoritative record. Re-baseline
            // onto a fresh origin — preserving local-only work as conflicts where
            // it clashes, never dropping it — then push under the fresh origin.
            await operations.recoverOrigin();
            await push();
          }
        }
        try {
          return await pull();
        } catch (error) {
          if (!(error instanceof RelayOriginDivergedError)) throw error;
          // A pull can find that this machine's local origin disagrees with its
          // own relay echo. Re-baseline that origin, preserve its local suffix,
          // and retry the pass instead of backing off against the same page.
          await operations.recoverOrigin();
          if (!bootstrapPass) {
            await push();
          }
          return pull();
        }
      },
    );
    // Only a fully successful pull (materialized + cursor committed inside
    // runRelaySync) completes the bootstrap; a throw above leaves the next
    // retry pull-only.
    bootstrapPullPending = false;
    if (options.afterSuccessfulPull) {
      try {
        await options.afterSuccessfulPull({ recovered: consecutiveFailures > 0 });
      } catch (error) {
        console.error(`[desktop] post-pull work failed for ${options.rootDir}:`, error);
      }
    }
    // Shared channels ride the same cadence but never gate the pass: chat
    // replay touches no workspace files, so it runs outside runRelaySync's
    // capture gate, and its failures are contained here.
    let sharedChannelsApplied = false;
    if (options.syncSharedChannels) {
      try {
        sharedChannelsApplied = await options.syncSharedChannels();
      } catch (error) {
        console.error(`[desktop] shared channel sync failed for ${options.rootDir}:`, error);
      }
    }
    passSharingDeclined.push(...(pullResult.sharingDeclined ?? []));
    const declinedByPath = new Map<string, SharingDeclined>();
    for (const declined of passSharingDeclined) {
      declinedByPath.set(declined.path, declined);
    }
    const nextSharingDeclined = [...declinedByPath.values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    conflictCount = options.countOpenConflicts
      ? await options.countOpenConflicts()
      : conflictCount + pullResult.conflictsOpened;
    sharingDeclined = nextSharingDeclined;
    ownerAdmissionPending = passOwnerPending;
    pendingChangeCount = Math.max(ownerAdmissionPending.length, pendingChangeCount - beforePending);
    lastSyncedAtMs = nowMs();
    consecutiveFailures = 0;
    nextBackoffMs = initialBackoffMs;
    setSyncFailing(false);
    if (ownerAdmissionPending.length > 0) scheduleBackoff();
    // The bootstrap pull done, immediately queue the first normal pass so
    // local identity/journal ops reconcile without waiting for an edit.
    if (bootstrapPass && !stopped && !authExpired && debounceTimer === undefined) {
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        void runPass(false);
      }, 0);
    }
    return pullResult.applied > 0 || sharedChannelsApplied;
  }

  // What the snapshot shows a person. `syncing` and `lastSyncedAtMs` move on
  // every pass, so they do not count.
  function visibleState(): string {
    return JSON.stringify([pendingChangeCount, conflictCount, sharingDeclined, ownerAdmissionPending]);
  }

  // A quiet pass serves queuePull. Each change event refreshes Chats, so a
  // quiet pass announces nothing at its start, and at its end only when it
  // applied ops, changed what the snapshot shows, or something announced
  // `syncing` while it ran. An idle poll then costs one pass and wakes nothing.
  function runPass(rethrow: boolean, quiet = false): Promise<void> {
    passesPending += 1;
    // This pass pulls, so it serves a pull waiting on its own deadline.
    if (pullTimer !== undefined) {
      clearTimeout(pullTimer);
      pullTimer = undefined;
    }
    const result = chain.then(async () => {
      try {
        if (stopped) return;
        const eventsBefore = changeEvents;
        const stateBefore = visibleState();
        let applied = false;
        syncing = true;
        if (!quiet) emitChange();
        try {
          applied = await doPass();
        } catch (error) {
          handleFailure(error);
          if (rethrow) throw error;
        } finally {
          syncing = false;
          if (!quiet || applied || changeEvents !== eventsBefore || visibleState() !== stateBefore) {
            emitChange();
          }
        }
      } finally {
        passesPending -= 1;
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
      emitChange();
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

    // A pull the Chats polls ask for. Members' replies to conversations this
    // workspace owns land in its own relay log, and nothing else fetches them
    // while the desktop is idle. Unlike queueSync this records no local change,
    // so a poll cannot show "Local changes". It yields to a queued or running
    // pass and to failure backoff, because those pull too. Each local write
    // restarts the debounce, so the pull keeps its own deadline: steady writes
    // cannot postpone it past one debounce interval.
    queuePull() {
      if (authExpired || stopped) return;
      if (passesPending > 0 || backoffTimer !== undefined || pullTimer !== undefined) return;
      if (debounceTimer === undefined) {
        void runPass(false, true);
        return;
      }
      pullTimer = setTimeout(() => {
        pullTimer = undefined;
        void runPass(false, true);
      }, debounceMs);
    },

    snapshot() {
      return {
        syncing,
        lastSyncedAtMs,
        pendingChangeCount,
        conflictCount,
        authExpired,
        ownerAdmissionPending: ownerAdmissionPending.map(pending => ({...pending})),
        sharingDeclined: sharingDeclined.map((declined) => ({ ...declined })),
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
