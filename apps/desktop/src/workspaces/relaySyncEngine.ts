import {
  RelayApiVersionError,
  type RelayApiUpdate,
  RelayOriginDivergedError,
  RelayUnauthorizedError,
  RelayUnreachableError,
  RelayClaimRefusedError,
  type PullWorkspaceFromRelayResult,
  type MaterializeRelayPullPage,
  type PushWorkspaceToRelayResult,
  type RecoverRelayOriginResult,
  type SharingDeclined,
  type OwnerAdmissionPending,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { pushWithIdentity } from "./pushWithIdentity";

export interface RelaySyncOperations {
  claim(): Promise<void>;
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
  // Waits on the relay until the workspace log holds an op past `since`, and
  // resolves whether it does. After every pull the engine waits past that
  // pull's cursor and pulls when this resolves true, so an idle desktop
  // receives another device's edits, including into a document it has open,
  // without polling. A rejection backs the next wait off.
  waitForChange?: (since: number, signal: AbortSignal) => Promise<boolean>;
  // How long the engine waits after a pass before it pulls again on its own:
  // the fallback for a change `waitForChange` missed. Omitted, the engine
  // pulls only when asked.
  idlePullMs?: number;
  debounceMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  nowMs?: () => number;
}

// Why the last pass failed, as far as dohc knows. "server-unreachable" means
// no connection reached the server; "claim-refused" names a refused setup.
// Other failures are "unknown"; their detail is the only account of them. One failure runs from the first failed
// pass (`sinceMs`) until a pass succeeds, and `attempts` counts its failed
// passes, so a surface can tell a blip from an outage.
export interface CloudSyncFailure {
  cause: "server-unreachable" | "claim-refused" | "unknown";
  detail: string;
  sinceMs: number;
  attempts: number;
}

export interface CloudSyncSnapshot {
  claimingIdentity?: boolean;
  syncing: boolean;
  lastSyncedAtMs: number | null;
  pendingChangeCount: number;
  conflictCount: number;
  authExpired: boolean;
  // Sync stopped because the relay does not serve this build's relay API
  // version. Names the side that must update; sync starts again after dohc
  // restarts on a version the relay serves.
  updateRequired?: RelayApiUpdate;
  sharingDeclined: SharingDeclined[];
  ownerAdmissionPending?: OwnerAdmissionPending[];
  syncFailure: CloudSyncFailure | null;
  // A pass someone asked for with retryNow is running.
  retrying: boolean;
}

export interface CloudSyncEngine {
  start(): Promise<void>;
  queueSync(): void;
  queuePull(): void;
  // Runs a pass now instead of waiting out the backoff, and settles when it
  // ends. The outcome is in the next snapshot, not in the promise. A pass that
  // does not count as an attempt (a retry on reconnecting or waking) updates
  // a failure's detail without adding to its attempts.
  retryNow(options: { countsAsAttempt: boolean }): Promise<void>;
  snapshot(): CloudSyncSnapshot;
  stop(): Promise<void>;
}

export function createRelaySyncEngine(options: CloudSyncEngineOptions): CloudSyncEngine {
  const operations = options.operations;
  const debounceMs = options.debounceMs ?? 1500;
  const initialBackoffMs = options.initialBackoffMs ?? 5000;
  const maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
  const nowMs = options.nowMs ?? (() => Date.now());

  let syncing = false;
  let claimingIdentity = false;
  let claimRefusal: RelayClaimRefusedError | null = null;
  let lastSyncedAtMs: number | null = null;
  let pendingChangeCount = 0;
  let conflictCount = 0;
  // True until the first successful pull of a join-bootstrap engine.
  let bootstrapPullPending = options.joinBootstrap === true;
  let updateRequired: RelayApiUpdate | null = null;
  let authExpired = false;
  let syncFailure: CloudSyncFailure | null = null;
  let retrying = false;
  let sharingDeclined: SharingDeclined[] = [];
  let ownerAdmissionPending: OwnerAdmissionPending[] = [];
  let stopped = false;
  let nextBackoffMs = initialBackoffMs;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let backoffTimer: ReturnType<typeof setTimeout> | undefined;
  // A pull the Chats polls asked for while local writes held the debounce.
  let pullTimer: ReturnType<typeof setTimeout> | undefined;
  // When the pending backoff pass is due, so a failed retry someone asked for
  // can keep that deadline instead of moving it.
  let backoffDueAtMs: number | null = null;
  // The pull a quiet engine makes on its own after `idlePullMs`.
  let idlePullTimer: ReturnType<typeof setTimeout> | undefined;
  // The wait on the relay for a change past `watchSince`, or its restart.
  let watch: AbortController | undefined;
  let watchTimer: ReturnType<typeof setTimeout> | undefined;
  let watchSince: number | undefined;
  let watchDelayMs = initialBackoffMs;
  // The cursor a reported change was past, until a pass starts to pull it.
  let changeReported: number | undefined;
  // What the pass that just pulled reached. The wait restarts from it once
  // that pass ends: a change reported while the pass still runs would
  // otherwise yield to a pass that has already pulled.
  let pulled: { cursor: number; servedChange: number | undefined } | undefined;
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

  function setSyncFailure(value: CloudSyncFailure | null): void {
    if (syncFailure === value) return;
    syncFailure = value;
    emitChange();
  }

  function clearTimers(): void {
    clearPassTimers();
    stopWatch();
  }

  // The timers that would start another pass. A pass leaves the wait on the
  // relay running.
  function clearPassTimers(): void {
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
    if (idlePullTimer !== undefined) {
      clearTimeout(idlePullTimer);
      idlePullTimer = undefined;
    }
  }

  function stopWatch(): void {
    watch?.abort();
    watch = undefined;
    if (watchTimer !== undefined) {
      clearTimeout(watchTimer);
      watchTimer = undefined;
    }
  }

  // Wait past the cursor a successful pull reached. A pull that served a
  // reported change and did not move past it would see the same change at
  // once, so that wait backs off instead of turning into a loop of passes.
  function watchPast(cursor: number, servedChange: number | undefined): void {
    if (options.waitForChange === undefined || stopped || authExpired) return;
    const stuck = servedChange !== undefined && cursor <= servedChange;
    if (!stuck && watchSince === cursor && (watch !== undefined || watchTimer !== undefined)) return;
    stopWatch();
    watchSince = cursor;
    if (stuck) {
      scheduleWatch();
      return;
    }
    watchDelayMs = initialBackoffMs;
    runWatch();
  }

  function scheduleWatch(): void {
    const delay = watchDelayMs;
    watchDelayMs = Math.min(maxBackoffMs, watchDelayMs * 2);
    watchTimer = setTimeout(() => {
      watchTimer = undefined;
      runWatch();
    }, delay);
  }

  function runWatch(): void {
    const wait = options.waitForChange;
    const since = watchSince;
    if (wait === undefined || since === undefined || stopped || authExpired) return;
    const controller = new AbortController();
    watch = controller;
    wait(since, controller.signal).then(
      (changed) => {
        if (watch !== controller) return;
        watch = undefined;
        if (!changed) {
          runWatch();
          return;
        }
        // The pass that pulls this change restarts the wait.
        changeReported = since;
        queuePull();
      },
      (error: unknown) => {
        if (watch !== controller) return;
        watch = undefined;
        // The sign-in expired: the engine stops, and the status says so.
        if (error instanceof RelayUnauthorizedError) {
          handleFailure(error, undefined, true);
          return;
        }
        console.error(`[desktop] relay change wait failed for ${options.rootDir}:`, error);
        scheduleWatch();
      },
    );
  }

  // A pull that records no local change, so it cannot show "Local changes".
  // The Chats polls ask for one, and so does the relay when another device
  // appends. It yields to a queued or running pass and to failure backoff,
  // because those pull too. Each local write restarts the debounce, so the
  // pull keeps its own deadline: steady writes cannot postpone it past one
  // debounce interval.
  function queuePull(): void {
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
  }

  // The last pass to finish arms the next idle pull, so a quiet workspace
  // pulls once per interval and a busy one never waits on this timer. After a
  // failure the backoff owns the retry.
  function scheduleIdlePull(): void {
    const delay = options.idlePullMs;
    if (delay === undefined || stopped || authExpired || claimRefusal) return;
    if (passesPending > 0 || backoffTimer !== undefined || idlePullTimer !== undefined) return;
    idlePullTimer = setTimeout(() => {
      idlePullTimer = undefined;
      void runPass(false, true);
    }, delay);
  }

  // After a pass someone asked for fails, `keepDueAtMs` is the automatic
  // pass it displaced: their retry says nothing new about the outage, so the
  // next automatic pass stays where it was, and the interval does not grow.
  function scheduleBackoff(options?: { manual: true; keepDueAtMs: number | null }): void {
    if (stopped || authExpired || backoffTimer !== undefined) return;
    const keepDueAtMs = options?.keepDueAtMs ?? null;
    const delay =
      keepDueAtMs === null ? nextBackoffMs : Math.max(0, keepDueAtMs - Date.now());
    if (!options?.manual) nextBackoffMs = Math.min(maxBackoffMs, nextBackoffMs * 2);
    backoffDueAtMs = Date.now() + delay;
    retryQueued = true;
    backoffTimer = setTimeout(() => {
      backoffTimer = undefined;
      if (!retryQueued || stopped || authExpired) return;
      retryQueued = false;
      void runPass(false);
    }, delay);
  }

  function handleFailure(
    error: unknown,
    displacedDueAtMs: number | null | undefined,
    countsAsAttempt: boolean,
  ): void {
    if (error instanceof RelayUnauthorizedError) {
      authExpired = true;
      stopped = true;
      // The expired sign-in is the state now; an older failure is not.
      syncFailure = null;
      clearTimers();
      emitChange();
      return;
    }
    // Retrying cannot help until one side updates, so sync stops and says which.
    if (error instanceof RelayApiVersionError) {
      updateRequired = error.update;
      stopped = true;
      syncFailure = null;
      clearTimers();
      emitChange();
      return;
    }
    const claimRefused = error instanceof RelayClaimRefusedError;
    if (claimRefused) {
      claimRefusal = error;
    }
    setSyncFailure({
      cause: claimRefused ? "claim-refused" : error instanceof RelayUnreachableError ? "server-unreachable" : "unknown",
      detail: claimRefused ? error.message
        : error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      sinceMs: syncFailure?.sinceMs ?? nowMs(),
      attempts: syncFailure
        ? syncFailure.attempts + (countsAsAttempt ? 1 : 0)
        : 1,
    });
    console.error(`[desktop] relay sync failed for ${options.rootDir}:`, error);
    if (claimRefused) return;
    scheduleBackoff(
      displacedDueAtMs === undefined
        ? undefined
        : { manual: true, keepDueAtMs: displacedDueAtMs },
    );
  }

  // Resolves true when the workspace pull or the shared-channel pass applied
  // ops. The shared-channel pass tells the renderer itself, and the renderer
  // then reads `syncing`, so a quiet pass must announce that it ended.
  async function doPass(retryClaim: boolean): Promise<boolean> {
    const beforePending = pendingChangeCount;
    const bootstrapPass = bootstrapPullPending;
    // This pass pulls whatever change the relay reported before it started.
    const servedChange = changeReported;
    changeReported = undefined;
    let passOwnerPending = ownerAdmissionPending;
    const claim = async () => {
      claimingIdentity = true;
      emitChange();
      try {
        // The daemon reuses its durable identity if a previous claim lost its response.
        await operations.claim();
      } catch (error) {
        if (error instanceof RelayClaimRefusedError) claimRefusal = error;
        throw error;
      } finally {
        claimingIdentity = false;
        emitChange();
      }
    };
    const push = async () => {
      if (retryClaim) {
        retryClaim = false;
        await claim();
      }
      const result = await pushWithIdentity({ push: () => operations.push(), claim });
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
    pulled = { cursor: pullResult.nextCursor, servedChange };
    if (options.afterSuccessfulPull) {
      try {
        await options.afterSuccessfulPull({ recovered: syncFailure !== null });
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
    nextBackoffMs = initialBackoffMs;
    setSyncFailure(null);
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
  // `retry` marks a pass someone asked for with retryNow.
  function runPass(
    rethrow: boolean,
    quiet = false,
    retry?: { countsAsAttempt: boolean },
  ): Promise<void> {
    passesPending += 1;
    // This pass pulls, so it serves a pull waiting on its own deadline.
    if (pullTimer !== undefined) {
      clearTimeout(pullTimer);
      pullTimer = undefined;
    }
    if (idlePullTimer !== undefined) {
      clearTimeout(idlePullTimer);
      idlePullTimer = undefined;
    }
    const result = chain.then(async () => {
      try {
        if (stopped || (claimRefusal && !retry?.countsAsAttempt)) return;
        const retryClaim = claimRefusal !== null && retry?.countsAsAttempt === true;
        if (retry?.countsAsAttempt) claimRefusal = null;
        // A retry someone asked for keeps the automatic pass it displaces, in
        // case it fails. `undefined` marks an automatic pass.
        const displacedDueAtMs = retry
          ? backoffTimer !== undefined
            ? backoffDueAtMs
            : null
          : undefined;
        // This pass carries everything queued so far, so any timer waiting to
        // start another is now stale. Its own outcome sets the next one. Done
        // here, in the serialized lifecycle, so a pass that ends before this
        // one starts cannot leave its backoff behind.
        clearPassTimers();
        retryQueued = false;
        const eventsBefore = changeEvents;
        const stateBefore = visibleState();
        let applied = false;
        syncing = true;
        retrying = retry !== undefined;
        if (!quiet) emitChange();
        try {
          applied = await doPass(retryClaim);
        } catch (error) {
          handleFailure(error, displacedDueAtMs, retry?.countsAsAttempt ?? true);
          if (rethrow) throw error;
        } finally {
          syncing = false;
          retrying = false;
          if (!quiet || applied || changeEvents !== eventsBefore || visibleState() !== stateBefore) {
            emitChange();
          }
        }
      } finally {
        passesPending -= 1;
        if (pulled !== undefined) {
          const { cursor, servedChange } = pulled;
          pulled = undefined;
          watchPast(cursor, servedChange);
        }
        scheduleIdlePull();
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

    queuePull,

    retryNow(options) {
      if (authExpired || stopped) return Promise.resolve();
      return runPass(false, false, options);
    },

    snapshot() {
      return {
        syncing,
        claimingIdentity,
        lastSyncedAtMs,
        pendingChangeCount,
        conflictCount,
        authExpired,
        ...(updateRequired ? { updateRequired } : {}),
        ownerAdmissionPending: ownerAdmissionPending.map(pending => ({...pending})),
        sharingDeclined: sharingDeclined.map((declined) => ({ ...declined })),
        syncFailure: syncFailure ? { ...syncFailure } : null,
        retrying,
      };
    },

    async stop() {
      stopped = true;
      clearTimers();
      await chain;
    },
  };
}
