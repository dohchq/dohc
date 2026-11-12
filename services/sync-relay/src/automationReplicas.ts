import { workspaceIsDeleted } from "./storage/accountDeletion";
import {createHash, randomBytes} from "node:crypto";
import {mkdir, readdir, rm, stat, writeFile} from "node:fs/promises";
import {join} from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import type {Event, JsonValue} from "@dohc/workspace-engine-client";
import {createEngineClient, EngineRequestError, type EngineClient} from "@dohc/workspace-engine-client/daemon";
import type {SyncRelayStorage} from "./storage";
import {
  AUTOMATION_WORKSPACE_KEEP_AFTER_LEAVING_MS,
  AUTOMATION_WORKSPACE_LEAVE_AFTER_MS,
  type AutomationWorkspace,
  type CopyReason,
} from "./storage/automationWorkspaces";
import {deriveAutomationReplicaBearer} from "./automationReplicaCredential";
import {
  COULD_NOT_SEND,
  WORKSPACE_CHANGED,
  inspectOperations,
  publishOnce,
  receiptReader,
  settleOperations,
  stallExpired,
  stallOperations,
  type ReceiptReader,
  type RefusalReason,
} from "./operationPublication";
import {observeRelayWrites} from "./relayWriteChanges";
import {ServiceOrdinaryReplication} from "./serviceOrdinaryReplication";
import {selfHostedLiveProfile} from "./selfHostLiveProfile";

/** One workspace this server keeps a replica of, open in its engine. */
export interface AutomationReplica {
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly incarnation: number;
  /** Why the server keeps this copy, as its row said at the last pass. */
  readonly reasons: readonly CopyReason[];
  /** Relay log head covered by the last completed sync. */
  readonly pulledHead: number;
  /** When this incarnation began: its schedules start after it. */
  readonly startedAtMs: number;
  /** The replica's workspace folder. Only the engine writes it. */
  readonly root: string;
  /** Beside the folder, outside it: where the executor keeps its runs. */
  readonly metadataDir: string;
  readonly client: EngineClient;
  /** The engine's handle for the open workspace. */
  readonly workspace: string;
  /** Aborts when the replica closes or its engine exits. */
  readonly signal: AbortSignal;
  nextRequestId(): number;
  /** Pushes the replica's own writes to the relay, then pulls what the relay has. */
  sync(signal?: AbortSignal): Promise<void>;
  /**
   * One bounded sync, queued behind the one running: pushes, then pulls, a
   * pass's rounds at most. Answers whether it caught up. Never call it from
   * inside a sync callback, which holds the lane it waits for.
   */
  step(signal?: AbortSignal): Promise<boolean>;
  /** Serializes record draft preparation and delivery without delaying ordinary sync. */
  withRecordWork<T>(work: () => Promise<T>): Promise<T>;
}

const REQUEST_DEADLINE_MS = 30_000;
// A pass pushes and pulls each copy at most this many rounds, so one busy
// workspace cannot hold the pass; the next pass carries on where it stopped.
const ROUNDS_PER_PASS = 4;
const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 60_000;
// A busy engine asks a copy to try again after a backoff, as when every copy
// catches up at startup, and a retry recovers. Like the executor's own sync,
// a copy reports that answer only once it comes back this many times in a row.
const BUSY_REFUSALS_REPORTED = 3;
// The longest a deadline timer waits before it looks again.
const DEADLINE_MAX_WAIT_MS = 24 * 60 * 60 * 1000;
// A copy with unsent phone writes tries to publish them this soon, then less
// often up to the most, even when nothing new reached the relay.
const PUBLICATION_RETRY_FIRST_MS = 2_000;
const PUBLICATION_RETRY_MAX_MS = 5 * 60_000;
// A stalled write may still publish, so its copy keeps trying, more slowly.
const PUBLICATION_STALLED_RETRY_MS = 30 * 60_000;
// A copy whose receipts can't be read this many times in a row stalls its writes.
const PUBLICATION_QUERY_FAILURES = 5;

/**
 * Keeps one engine replica per workspace whose automations this server runs
 * or whose owner's account reads it, in one engine daemon of its own. The
 * live host's engine serves browsers and restarts when its documents change,
 * so it never runs automations.
 *
 * `wanted` names the workspaces that need a replica now, with why. Each
 * joins through ordinary replication as the workspace owner, with a
 * credential derived for that replica alone. A relay write that reaches a
 * replica's workspace pulls it; nothing polls. A replica no longer wanted
 * leaves after a day. One automations kept stays on disk after that for Undo
 * and run history until its retention ends. One only the account kept closes
 * as soon as nothing wants it, so idle copies hold no engine, and its folder
 * goes when it leaves.
 */
export async function startAutomationReplicas(options: {
  storage: SyncRelayStorage;
  /** A folder of the deployment's own, on persistent storage. */
  root: string;
  engineExecutable: string;
  /** The relay's public HTTPS origin, which the engine reaches it at. */
  relayOrigin: string;
  key: Uint8Array;
  namespace: string;
  wanted(): ReadonlyMap<string, readonly CopyReason[]>;
  nowMs?(): number;
  /** A replica opened or closed, or the reasons its row keeps it for changed. */
  onChanged?(workspaceId: string): void;
  /** The engine announced something, such as an automation claim, for a workspace it names. */
  onEngineEvent?(event: Event): void;
  /** A pull wrote these paths into a replica. */
  onPulled?(workspaceId: string, paths: readonly string[]): void;
  /** Refresh accepted live records before their ordinary artifacts are pulled. */
  onBeforeSync?(workspaceId: string): Promise<void>;
  /** A pass ran to its end. A workspace that failed in it is in failedSyncs. */
  onReconciled?(): void;
  /** A pass failed, or one workspace in it did (`workspaceId` names it). */
  onError?(error: unknown, workspaceId?: string): void;
}) {
  const {storage} = options;
  const nowMs = options.nowMs ?? Date.now;
  const relay = new URL(options.relayOrigin);
  if (relay.protocol !== "https:" || relay.origin !== options.relayOrigin) throw new Error("Automation replicas need the relay's public HTTPS origin.");
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, storage.unavailable]);
  const replicas = new Map<string, AutomationReplica & {
    close(): Promise<void>; pulledHead: number; reasons: readonly CopyReason[];
    busy(): boolean;
  }>();
  // Replicas an engine exit is closing, until their close settles. One that
  // failed stays for close() to report.
  const retiring = new Set<Promise<void>>();
  let client: {engine: EngineClient; exited: AbortController} | undefined;
  let starting: Promise<{engine: EngineClient; exited: AbortController}> | undefined;
  let requestId = 0;
  const nextRequestId = () => ++requestId;
  // A pass asked for, with the delay before it. The first one asked for keeps its delay.
  const wakes = Effect.runSync(Queue.dropping<number>(1));
  // Open while no pass is asked for, waiting, running, or retrying.
  const idle = Latch.makeUnsafe(false);
  let retryMs = RETRY_FIRST_MS;
  let reconciled = false;
  // The workspaces whose part of the last pass failed, with why.
  const failedSyncs = new Map<string, unknown>();
  // How many busy answers in a row each workspace in failedSyncs got.
  const busyRefusals = new Map<string, number>();
  // Sync failures wait on elapsed time, independently of retention's nowMs clock.
  const syncRetries = new Map<string, { at: number; delay: number; incarnation: number }>();
  const canSync = (workspaceId: string) => (syncRetries.get(workspaceId)?.at ?? 0) <= performance.now();
  // When each copy with unsent phone writes tries next, on the same clock,
  // the wait before it, and how many reads of its receipts failed in a row.
  const publicationRetries = new Map<string, { at: number; delay: number; failures: number }>();

  const folderOf = (workspaceId: string) => replicaFolder(options.root, options.namespace, workspaceId);
  // The workspace ids whose folders the last sweep kept.
  let swept: string | null = null;

  function engine(): Promise<{engine: EngineClient; exited: AbortController}> {
    if (client && !client.exited.signal.aborted) return Promise.resolve(client);
    starting ??= (async () => {
      const exited = new AbortController();
      const started = await spawnEngine(options.engineExecutable, configPath, signal, () => {
        exited.abort();
        // Every replica opened in it is gone; the next pass opens them again.
        for (const replica of [...replicas.values()]) {
          if (replica.client !== started) continue;
          const closing = replica.close();
          retiring.add(closing);
          closing.then(() => retiring.delete(closing), () => {});
        }
        schedule(RETRY_FIRST_MS);
      });
      if (options.onEngineEvent) started.onEvent(options.onEngineEvent);
      client = {engine: started, exited};
      return client;
    })().finally(() => { starting = undefined; });
    return starting;
  }

  async function request(engineClient: EngineClient, method: string, params: {[key: string]: JsonValue}, workspace?: string) {
    const response = await engineClient.sendRequest({id: nextRequestId(), method, params, ...(workspace ? {workspace} : {}),
      deadlineMs: REQUEST_DEADLINE_MS});
    return response.result;
  }

  const logHead = (workspaceId: string) => storage.automationWorkspaceLogHead(workspaceId);

  const unfinishedIncarnations = (workspaceId: string) =>
    new Set(storage.listUnfinishedAccountOperations({workspaceId}).map((record) => record.incarnation));

  /**
   * Settles the phone's unfinished writes in one incarnation's folder before
   * the folder goes. The copy is closed first, so nothing pushes after the
   * receipts are read: they are read from the folder, opened for that alone.
   * Throws when they couldn't be read. Retirement and the orphan sweep then
   * keep the folder for the retry; account deletion reports it and removes
   * the folder anyway.
   */
  async function settleCopy(workspaceId: string, incarnation: number, reason: RefusalReason): Promise<void> {
    const records = storage.listUnfinishedAccountOperations({workspaceId, incarnation});
    if (records.length === 0) return;
    if (replicas.get(workspaceId)?.incarnation === incarnation) throw new Error("A copy's phone writes settle only once it is closed.");
    const home = join(folderOf(workspaceId), String(incarnation));
    if (await missing(home)) await settleOperations(storage, records, null, reason, nowMs());
    else await readFolder((await engine()).engine, nextRequestId, join(home, "workspace"), workspaceId,
      (read) => settleOperations(storage, records, read, reason, nowMs()));
    storage.restorePublicationReasons();
  }

  // Every incarnation's writes, each tried, the first failure thrown after.
  // Those of an earlier incarnation, whose identity is gone, answer that the workspace changed.
  async function settleWorkspace(workspaceId: string, reason: RefusalReason): Promise<void> {
    const incarnations = unfinishedIncarnations(workspaceId);
    if (incarnations.size === 0) return;
    const current = storage.listAutomationWorkspaces().find((row) => row.workspaceId === workspaceId)?.incarnation;
    let failed: {error: unknown} | null = null;
    for (const incarnation of incarnations) {
      try {
        await settleCopy(workspaceId, incarnation, current === undefined || incarnation === current ? reason : WORKSPACE_CHANGED);
      } catch (error) {
        if (signal.aborted) throw error;
        failed ??= {error};
      }
    }
    if (failed) throw failed.error;
  }

  /**
   * After a sync of a copy failed, its phone writes are judged by their
   * receipts anyway, as the relay may hold what a step pushed before it
   * failed, and they stall past their active time or on a whole-push
   * rejection. Nothing it finds fails the sync more.
   */
  async function inspectAfterFailure(engineClient: EngineClient, handle: string, workspaceId: string, incarnation: number,
    syncError: unknown): Promise<void> {
    const records = storage.listUnfinishedAccountOperations({workspaceId, incarnation});
    if (records.length === 0 || signal.aborted) return;
    try {
      await inspectOperations(storage, workspaceId, receiptReader({client: engineClient, nextRequestId}, handle), records, nowMs, syncError);
    } catch (error) {
      if (signal.aborted) throw error;
      observe(() => options.onError?.(error, workspaceId));
    }
  }

  // A pass's step of an open copy. A failure keeps its retry, after its phone writes were looked at.
  async function stepOf(replica: AutomationReplica): Promise<void> {
    try {
      if (!(await replica.step())) schedule();
    } catch (error) {
      if (!replica.signal.aborted) await inspectAfterFailure(replica.client, replica.workspace, replica.workspaceId, replica.incarnation, error);
      throw error;
    }
  }

  /**
   * One attempt to publish an open copy's unsent phone writes, when it is
   * due. The next comes sooner while they are active, and slowly once every
   * one is stalled. Receipts that keep failing to read stall the writes.
   */
  async function publish(replica: AutomationReplica): Promise<void> {
    const {workspaceId, incarnation} = replica;
    const records = storage.listUnfinishedAccountOperations({workspaceId, incarnation});
    const previous = publicationRetries.get(workspaceId);
    if (records.length === 0) {
      publicationRetries.delete(workspaceId);
      return;
    }
    let read = false;
    try {
      read = await publishOnce(storage, replica, records, nowMs) !== null;
    } catch (error) {
      if (signal.aborted) throw error;
      observe(() => options.onError?.(error, workspaceId));
    }
    const failures = read ? 0 : (previous?.failures ?? 0) + 1;
    if (failures >= PUBLICATION_QUERY_FAILURES) stallOperations(storage, records, nowMs());
    const left = storage.listUnfinishedAccountOperations({workspaceId, incarnation});
    if (left.length === 0 || !replicas.has(workspaceId)) {
      publicationRetries.delete(workspaceId);
      return;
    }
    const delay = left.every((record) => record.stage === "stalled") ? PUBLICATION_STALLED_RETRY_MS
      : Math.min(previous ? previous.delay * 2 : PUBLICATION_RETRY_FIRST_MS, PUBLICATION_RETRY_MAX_MS);
    publicationRetries.set(workspaceId, {at: performance.now() + delay, delay, failures});
  }

  let runningPass: Promise<boolean> | undefined;
  async function open(row: AutomationWorkspace): Promise<void> {
    if (workspaceIsDeleted(storage, row.workspaceId)) return;
    const folder = folderOf(row.workspaceId);
    const home = join(folder, String(row.incarnation));
    const root = join(home, "workspace"), metadataDir = join(home, "metadata");
    await mkdir(root, {recursive: true, mode: 0o700});
    await mkdir(metadataDir, {recursive: true, mode: 0o700});
    // An earlier incarnation's replica belongs to an identity that is gone.
    // The phone's writes in it settle before its folder goes, and before this
    // one publishes anything.
    for (const incarnation of unfinishedIncarnations(row.workspaceId)) {
      if (incarnation !== row.incarnation) await settleCopy(row.workspaceId, incarnation, WORKSPACE_CHANGED);
    }
    for (const entry of await readdir(folder)) {
      if (entry !== String(row.incarnation)) await rm(join(folder, entry), {recursive: true, force: true});
    }
    const {engine: engineClient, exited} = await engine();
    const bearerToken = deriveAutomationReplicaBearer(row, {key: options.key, namespace: options.namespace});
    // Nothing watches the replica's folder, so the engine keeps its Collections current itself.
    const opened = await request(engineClient, "workspace.open", {rootDir: root, workspaceId: row.workspaceId, captureMode: "none",
      reconcileCollections: true, recoverRunningDispatches: false, relay: {baseUrl: relay.origin, bearerToken}}) as {workspace?: unknown} | null;
    if (typeof opened?.workspace !== "string" || !opened.workspace) throw new Error("The engine did not open the automation replica.");
    const handle = opened.workspace;
    const closed = new AbortController();
    const release = async () => {
      closed.abort();
      if (!exited.signal.aborted) await request(engineClient, "workspace.close", {}, handle).catch(() => undefined);
    };
    const replicaSignal = AbortSignal.any([signal, exited.signal, closed.signal]);
    const current = () => {
      if (storage.currentAutomationWorkspace(row.workspaceId)?.incarnation !== row.incarnation) {
        throw new Error("This server's replica of the workspace was replaced.");
      }
    };
    const replication = new ServiceOrdinaryReplication({client: engineClient, workspace: handle, workspaceId: row.workspaceId,
      nextRequestId, deadlineMs: REQUEST_DEADLINE_MS, signal: replicaSignal, assertCurrent: current},
      {relay: {baseUrl: relay.origin, bearerToken}, identity: {kind: "join", replicationEpoch: row.replicationEpoch,
        streamIdentity: row.streamIdentity}, maxPagesPerPull: 8});
    let recordChain: Promise<unknown> = Promise.resolve();
    let syncChain: Promise<unknown> = Promise.resolve();
    const withRecordWork = <T>(work: () => Promise<T>): Promise<T> => {
      const run = recordChain.then(() => {replicaSignal.throwIfAborted(); current(); return work();});
      recordChain = run.catch(() => undefined);
      return run;
    };
    let closing: Promise<void> | undefined;
    // Pushes, then pulls, each for at most `rounds`, so a copy that always
    // has more to push still pulls. Answers whether it caught up.
    let running = 0;
    const syncRounds = (rounds: number, callerSignal?: AbortSignal): Promise<boolean> => {
      running += 1;
      const run = syncChain.then(async () => {
        replicaSignal.throwIfAborted(); callerSignal?.throwIfAborted(); current();
        // Live record refresh has its own retry lane; failure never skips sync.
        try {await options.onBeforeSync?.(row.workspaceId);}
        catch (error) {observe(() => options.onError?.(error, row.workspaceId));}
        const head = logHead(row.workspaceId);
        let pushMore = true, pullMore = true;
        for (let round = 0; pushMore && round < rounds; round++) pushMore = (await replication.push(callerSignal)).hasMore;
        // Each committed page is heard at once, so a later page that fails loses nothing already applied.
        for (let round = 0; pullMore && round < rounds; round++) {
          // A page with no file paths can still carry Group messages.
          pullMore = (await replication.pull(callerSignal, (page) => options.onPulled?.(row.workspaceId, page.changedPaths))).hasMore;
        }
        syncRetries.delete(row.workspaceId);
        failedSyncs.delete(row.workspaceId);
        busyRefusals.delete(row.workspaceId);
        if (pushMore || pullMore) return false;
        replica.pulledHead = Math.max(replica.pulledHead, head);
        return true;
      });
      // Writes that landed while it ran, and that a pass skipped for it, get
      // their pass once it succeeds. A failure is left to the retry delay.
      void run.then(() => {
        running -= 1;
        if (running === 0 && !closed.signal.aborted && logHead(row.workspaceId) > replica.pulledHead) schedule();
      }, () => { running -= 1; });
      syncChain = run.catch((error: unknown) => {
        // A caller that gave up, as at a request's deadline, leaves the copy's sync as it was.
        if (!replicaSignal.aborted && !callerSignal?.aborted) {
          failedSyncs.set(row.workspaceId, error);
          const previous = syncRetries.get(row.workspaceId);
          const delay = previous ? Math.min(previous.delay * 2, RETRY_MAX_MS) : RETRY_FIRST_MS;
          syncRetries.set(row.workspaceId, { at: performance.now() + delay, delay, incarnation: row.incarnation });
          // Wake promptly to arm this retry without delaying work for other workspaces.
          schedule();
        }
      });
      return callerSignal === undefined ? run : untilAborted(run, callerSignal);
    };
    const replica = {
      workspaceId: row.workspaceId, ownerUserId: row.ownerUserId, incarnation: row.incarnation, reasons: row.reasons, startedAtMs: row.startedAtMs,
      root, metadataDir, client: engineClient, workspace: handle, signal: replicaSignal, nextRequestId, pulledHead: 0,
      withRecordWork,
      sync(callerSignal?: AbortSignal): Promise<void> {
        return syncRounds(Number.POSITIVE_INFINITY, callerSignal).then(() => undefined);
      },
      step(callerSignal?: AbortSignal): Promise<boolean> {
        return syncRounds(ROUNDS_PER_PASS, callerSignal);
      },
      /** A sync is running or queued: it makes progress without the pass. */
      busy(): boolean {
        return running > 0;
      },
      /** Every caller waits for the same close, which waits for the sync running in it. */
      close(): Promise<void> {
        return closing ??= (async () => {
          replicas.delete(row.workspaceId);
          failedSyncs.delete(row.workspaceId);
          busyRefusals.delete(row.workspaceId);
          syncRetries.delete(row.workspaceId);
          publicationRetries.delete(row.workspaceId);
          closed.abort();
          await Promise.all([recordChain, syncChain]);
          await release();
          options.onChanged?.(row.workspaceId);
        })();
      },
    };
    try {
      // A pulled moment lands in the main version, as on a computer that joins.
      await request(engineClient, "versions.ensureMain", {workspaceId: row.workspaceId}, handle);
      // A copy with a long history catches up over several passes, after the others.
      if (!(await replica.step())) schedule();
    } catch (error) {
      // Its phone writes are looked at before the handle goes, as after any failed sync.
      if (!replicaSignal.aborted) await inspectAfterFailure(engineClient, handle, row.workspaceId, row.incarnation, error);
      // A replica that never opened fully leaves nothing open behind.
      await release();
      throw error;
    }
    if (workspaceIsDeleted(storage, row.workspaceId)) {await release(); return;}
    replicas.set(row.workspaceId, replica);
    options.onChanged?.(row.workspaceId);
  }

  /**
   * Runs one workspace's part of a pass. A failure is that workspace's
   * alone: it is kept in failedSyncs and reported, a busy answer only once it
   * repeats, and the pass goes on to the others, so one tenant cannot stop
   * another's copy, or keep a copy past its time. Answers whether it succeeded.
   */
  async function each(workspaceId: string, work: () => Promise<void>): Promise<boolean> {
    signal.throwIfAborted();
    try {
      await work();
      if (syncRetries.has(workspaceId)) return canSync(workspaceId);
      failedSyncs.delete(workspaceId);
      busyRefusals.delete(workspaceId);
      return true;
    } catch (error) {
      if (signal.aborted) throw error;
      const retry = syncRetries.get(workspaceId);
      const now = performance.now();
      if (retry && retry.at <= now) {
        retry.delay = Math.min(retry.delay * 2, RETRY_MAX_MS);
        retry.at = now + retry.delay;
      }
      failedSyncs.set(workspaceId, error);
      const busy = error instanceof EngineRequestError && error.wireError?.retry === "afterBackoff";
      const refusals = busy ? (busyRefusals.get(workspaceId) ?? 0) + 1 : 0;
      busyRefusals.set(workspaceId, refusals);
      if (!busy || refusals >= BUSY_REFUSALS_REPORTED) observe(() => options.onError?.(error, workspaceId));
      return false;
    }
  }

  // onError and onReconciled only observe: one that throws is logged, and the passes go on.
  function observe(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      try { console.error("[automation-replicas] A callback failed.", error); } catch { /* Nothing is left to report it to. */ }
    }
  }

  // Answers whether every workspace's part succeeded, and throws for a
  // failure that is no one workspace's, once every workspace had its turn.
  async function reconcile(): Promise<boolean> {
    let ok = true;
    let passFailure: unknown = null;
    await engine();
    // A copy keeps the phone's unsent writes' reason exactly while they may still publish from it.
    storage.restorePublicationReasons();
    const publishing = new Set(storage.publishingCopies().map((copy) => copy.workspaceId));
    const wanted = new Map([...options.wanted()].filter(([id]) => !workspaceIsDeleted(storage, id)));
    for (const [workspaceId, reasons] of wanted) {
      ok = await each(workspaceId, async () => {
        const row = storage.joinAutomationWorkspace({workspaceId, nowMs: nowMs(), reasons});
        const retry = syncRetries.get(workspaceId);
        if (row === null || (retry && retry.incarnation !== row.incarnation)) syncRetries.delete(workspaceId);
        const open_ = replicas.get(workspaceId);
        if (open_ && (row === null || open_.incarnation !== row.incarnation)) await open_.close();
        else if (open_ && row !== null && row.reasons.join() !== open_.reasons.join()) {
          // A copy the account opened that automations now need, or the reverse.
          open_.reasons = row.reasons;
          options.onChanged?.(workspaceId);
        }
        if (!canSync(workspaceId)) return;
        if (row !== null && !replicas.has(workspaceId)) {
          let opening: AutomationWorkspace | null = row;
          try {
            // The server lost this replica's folder, and its engine with it.
            // The phone's writes in that folder can never publish, and none replays in a new one.
            if (await missing(join(folderOf(workspaceId), String(row.incarnation)))) {
              await settleCopy(workspaceId, row.incarnation, COULD_NOT_SEND);
              opening = storage.replaceLostAutomationReplica({workspaceId, incarnation: row.incarnation, nowMs: nowMs()});
            }
            if (opening !== null) await open(opening);
          }
          catch (error) {
            const incarnation = (opening ?? row).incarnation;
            if (!syncRetries.has(workspaceId)) {
              syncRetries.set(workspaceId, { at: performance.now() + RETRY_FIRST_MS, delay: RETRY_FIRST_MS, incarnation });
            }
            // A copy that can't open still stalls its phone writes past their active time.
            stallExpired(storage, storage.listUnfinishedAccountOperations({workspaceId, incarnation}), nowMs());
            throw error;
          }
        }
        else if (row !== null && failedSyncs.has(workspaceId)) {
          const retry = replicas.get(workspaceId)!;
          if (!retry.busy()) await stepOf(retry);
        }
      }) && ok;
    }
    for (const row of storage.listAutomationWorkspaces()) {
      if (workspaceIsDeleted(storage, row.workspaceId)) continue;
      if (wanted.has(row.workspaceId)) continue;
      syncRetries.delete(row.workspaceId);
      ok = await each(row.workspaceId, async () => {
        // A visit admitted while this pass ran wants the copy again, so each
        // step asks once more just before it acts. The pass the visit asked
        // for joins the copy again.
        const unwanted = () => !options.wanted().has(row.workspaceId);
        if (!unwanted()) return;
        const close = async () => { if (unwanted()) await replicas.get(row.workspaceId)?.close(); };
        // The copy closes first, so nothing pushes from it after its phone
        // writes' receipts are read. They settle from the closed folder before
        // it goes and before the row does, so a copy made again replays none
        // of them. A copy a visit wants again settles nothing and stays. One
        // whose receipts can't be read keeps the folder and the row, and its
        // failure retries the workspace.
        const retire = async () => {
          await close();
          if (!unwanted()) return;
          await settleWorkspace(row.workspaceId, COULD_NOT_SEND);
          await rm(folderOf(row.workspaceId), {recursive: true, force: true});
          storage.forgetAutomationWorkspace({workspaceId: row.workspaceId, incarnation: row.incarnation});
        };
        const kept = row.reasons.includes("automation");
        // Phone writes that may still publish keep the copy's folder and
        // credential, past the places it has now, until they settle.
        if (publishing.has(row.workspaceId)) {
          await close();
        } else if (row.reasons.length === 0) {
          await retire();
        } else if (row.leftAtMs === null) {
          const left = storage.unwantAutomationWorkspace({workspaceId: row.workspaceId, nowMs: nowMs()});
          if (left && !kept) await retire();
          else if (left || !kept) await close();
        } else if (!kept || nowMs() - row.leftAtMs >= AUTOMATION_WORKSPACE_KEEP_AFTER_LEAVING_MS) {
          await retire();
        } else {
          // A copy an owner's action opened again leaves once the action ends.
          await close();
        }
      }) && ok;
    }
    // A replica whose row is gone, as when its workspace was deleted, closes,
    // and its folder goes too.
    const rows = storage.listAutomationWorkspaces();
    const rowIds = new Set(rows.map((row) => row.workspaceId));
    for (const replica of [...replicas.values()]) {
      if (!rowIds.has(replica.workspaceId)) {
        ok = await each(replica.workspaceId, async () => {
          await replica.close();
          await settleWorkspace(replica.workspaceId, COULD_NOT_SEND);
        }) && ok;
      }
    }
    for (const workspaceId of [...failedSyncs.keys()]) if (!rowIds.has(workspaceId) && !wanted.has(workspaceId)) {
      failedSyncs.delete(workspaceId);
      busyRefusals.delete(workspaceId);
      syncRetries.delete(workspaceId);
    }
    // A folder no row names may still hold phone writes to settle.
    const unsettled = new Map(storage.listUnfinishedOperationCopies().filter((copy) => !rowIds.has(copy.workspaceId))
      .map((copy) => [folderOf(copy.workspaceId), copy.workspaceId]));
    const kept = JSON.stringify([rows.map((row) => row.workspaceId), [...unsettled.values()]]);
    if (kept !== swept) {
      const folders = new Set(rows.map((row) => folderOf(row.workspaceId)));
      let swept_ = true;
      for (const entry of await readdir(options.root)) {
        const path = join(options.root, entry);
        // The daemon needs this configuration again after an engine exit.
        if (path === configPath || folders.has(path)) continue;
        const holder = unsettled.get(path);
        try {
          // Its phone writes settle first. A failure keeps the folder and fails the pass, which retries after its delay.
          if (holder !== undefined) await settleWorkspace(holder, COULD_NOT_SEND);
          await rm(path, {recursive: true, force: true});
        } catch (error) {
          // A folder no row names is no one workspace's: the pass fails as a whole, after the others had their turn.
          if (signal.aborted) throw error;
          passFailure ??= error;
          swept_ = false;
        }
      }
      if (swept_) swept = kept;
    }
    // Pull each wanted replica whose workspace changed at the relay since its
    // last pull. One waiting to leave pulls no more.
    for (const replica of [...replicas.values()]) {
      if (!wanted.has(replica.workspaceId) || logHead(replica.workspaceId) <= replica.pulledHead) continue;
      // A copy already syncing gets there on its own; waiting on it would hold the pass.
      // Failed syncs retry in the next pass, even if their delay ended during this one.
      if (replica.busy() || failedSyncs.has(replica.workspaceId)) continue;
      // A copy with more to sync goes on in the next pass, after the others.
      ok = await each(replica.workspaceId, () => stepOf(replica)) && ok;
    }
    // A copy with unsent phone writes pushes them and checks what the relay
    // accepted, even when nothing new reached the relay.
    for (const replica of [...replicas.values()]) {
      const {workspaceId} = replica;
      if (!publishing.has(workspaceId) || !wanted.has(workspaceId)) {
        publicationRetries.delete(workspaceId);
        continue;
      }
      const retry = publicationRetries.get(workspaceId);
      const now = performance.now();
      if (replica.busy() || failedSyncs.has(workspaceId)) {
        // A copy syncing now, or waiting to retry its sync, tries after that.
        if (!retry || retry.at <= now) {
          publicationRetries.set(workspaceId, {at: Math.max(now + PUBLICATION_RETRY_FIRST_MS, syncRetries.get(workspaceId)?.at ?? 0),
            delay: retry?.delay ?? PUBLICATION_RETRY_FIRST_MS, failures: retry?.failures ?? 0});
        }
        continue;
      }
      if ((retry?.at ?? 0) > now) continue;
      await publish(replica);
    }
    if (passFailure !== null) throw passFailure;
    return ok;
  }

  // An unref'd wait, so a pending one never holds the process open.
  const sleep = (ms: number) => Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), ms);
    timer.unref();
    return Effect.sync(() => clearTimeout(timer));
  });

  function schedule(delayMs = 100): void {
    if (signal.aborted) return;
    idle.closeUnsafe();
    Queue.offerUnsafe(wakes, delayMs);
  }

  // The next pass asked for, after its delay. Until one is, the replicas are settled.
  const asked = Effect.suspend(() => {
    if (Queue.sizeUnsafe(wakes) === 0) idle.openUnsafe();
    return Queue.take(wakes);
  }).pipe(Effect.flatMap(sleep));

  // A replica leaves, or goes, at a time and not after a write: the wait for
  // the nearest such deadline.
  function untilDeadline(): number | undefined {
    let next = Number.POSITIVE_INFINITY;
    for (const row of storage.listAutomationWorkspaces()) {
      if (failedSyncs.has(row.workspaceId)) continue;
      if (row.leftAtMs !== null) next = Math.min(next, row.reasons.includes("automation") ? row.leftAtMs + AUTOMATION_WORKSPACE_KEEP_AFTER_LEAVING_MS : nowMs());
      else if (row.unwantedSinceMs !== null) next = Math.min(next, row.unwantedSinceMs + AUTOMATION_WORKSPACE_LEAVE_AFTER_MS);
    }
    let wait = next === Number.POSITIVE_INFINITY ? next : Math.max(next - nowMs(), 0);
    // A copy's next attempt to publish the phone's writes is a deadline of its own.
    const now = performance.now();
    for (const retry of publicationRetries.values()) wait = Math.min(wait, Math.max(retry.at - now, 0));
    return wait === Number.POSITIVE_INFINITY ? undefined : Math.min(wait, DEADLINE_MAX_WAIT_MS);
  }

  // The wait for the nearest deadline, as the last pass found it. None until a
  // pass finds one, and none after a pass that could not look.
  let deadline: number | undefined;

  // A pass, then its look for the nearest deadline. Either failing fails the
  // pass; when both do, the pass's own failure is the one reported.
  async function passOnce(): Promise<boolean> {
    deadline = undefined;
    let ok: boolean;
    try {
      ok = await reconcile();
    } catch (error) {
      try { deadline = untilDeadline(); } catch { /* The pass's failure comes first. */ }
      throw error;
    }
    deadline = untilDeadline();
    return ok;
  }

  const pass = () => runningPass = passOnce();

  // One pass at a time, each after the wait the one before it left. A pass
  // that fails runs again after a delay that doubles up to a minute.
  const passes = Effect.gen(function* () {
    let wait: Effect.Effect<void> = asked;
    for (;;) {
      wait = yield* Effect.scoped(Effect.gen(function* () {
        // The last pass's deadline can ask for a pass while this one runs.
        const armed = deadline;
        if (armed !== undefined) {
          yield* Effect.acquireRelease(Effect.sync(() => {
            const timer = setTimeout(() => schedule(0), armed);
            timer.unref();
            return timer;
          }), (timer) => Effect.sync(() => clearTimeout(timer)));
        }
        yield* wait;
        // This pass does what was asked for until now.
        yield* Queue.clear(wakes);
        // A pass runs to its end, so close() waits for its work.
        const result = yield* Effect.uninterruptible(Effect.result(Effect.tryPromise({try: pass, catch: (error) => error})));
        reconciled = Result.isSuccess(result);
        if (Result.isSuccess(result)) observe(() => options.onReconciled?.());
        else if (!signal.aborted) observe(() => options.onError?.(result.failure));
        let retry = retryMs;
        retryMs = Result.isSuccess(result) && result.success ? RETRY_FIRST_MS : Math.min(retryMs * 2, RETRY_MAX_MS);
        // A failed pass waits out its delay, however many passes are asked for meanwhile.
        if (Result.isFailure(result)) return sleep(retry);
        if (Queue.sizeUnsafe(wakes) > 0) return sleep(100);
        if (result.success) return asked;
        // Passes can wake for other work, but a failed sync keeps its own retry time.
        const now = performance.now();
        for (const workspaceId of failedSyncs.keys()) {
          const syncRetry = syncRetries.get(workspaceId);
          if (syncRetry && !replicas.get(workspaceId)?.busy()) retry = Math.min(retry, Math.max(syncRetry.at - now, 0));
        }
        return Effect.raceFirst(sleep(retry).pipe(Effect.as(Effect.void)), Queue.take(wakes).pipe(Effect.map(sleep))).pipe(Effect.flatten);
      }));
    }
  });

  await mkdir(options.root, {recursive: true, mode: 0o700});
  const configPath = await writeEngineConfig(options.root);
  const stopWatching = observeRelayWrites(storage, () => schedule());
  schedule(0);
  const worker = Effect.runFork(passes.pipe(Effect.tapCause((cause) => Effect.sync(() => {
    reconciled = false;
    if (!Cause.hasInterruptsOnly(cause)) console.error("[automation-replicas] Passes stopped.", Cause.squash(cause));
  }))));
  // The passes end when close() stops them, or on a failure nothing in them expects.
  const stopped = Fiber.await(worker).pipe(Effect.flatMap((exit) =>
    Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? Effect.failCause(exit.cause) : Effect.void));
  let shutdown: Promise<void> | undefined;
  // Each step runs even if one before it failed. The first failure is the one reported.
  const close = (): Promise<void> => {
    if (shutdown) return shutdown;
    shutdown = Promise.resolve().then(() => Effect.runPromise(Fiber.interrupt(worker).pipe(
      Effect.andThen(stopped),
      Effect.ensuring(Effect.promise(async () => {
        const closes = await Promise.allSettled([...retiring, ...[...replicas.values()].map((replica) => replica.close())]);
        const failed = closes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
        if (failed) throw failed.reason;
      })),
      Effect.ensuring(Effect.promise(async () => {
        if (!client) return;
        client.engine.close();
        await client.engine.waitForExit();
      })),
      Effect.ensuring(Effect.promise(() => rm(configPath, {force: true}))),
    )));
    storage.unavailable.removeEventListener("abort", closeUnavailable);
    lifetime.abort();
    stopWatching();
    return shutdown;
  };
  // Storage that stops closes the replicas too, and close() callers wait for that.
  const closeUnavailable = () => { close().catch((error: unknown) => console.error("[automation-replicas] Close failed.", error)); };
  if (storage.unavailable.aborted) closeUnavailable();
  else storage.unavailable.addEventListener("abort", closeUnavailable, {once: true});
  return {
    /**
     * Closes and removes these workspaces' copies, as an account's deletion
     * does. Nothing publishes from a deleted workspace, so each closed copy's
     * phone writes settle first. One whose receipts can't be read is
     * reported, and its folder goes anyway: the deletion's purge removes the
     * account's rows, and deleting the workspace refuses any other account's.
     * Throws, after the others, only when a folder couldn't be removed, so
     * the deletion stays pending until its retry removes it.
     */
    async deleteWorkspaces(workspaceIds: readonly string[]) {
      await runningPass?.catch(() => undefined);
      let failed: {error: unknown} | null = null;
      for (const id of workspaceIds) {
        await replicas.get(id)?.close();
        failedSyncs.delete(id); busyRefusals.delete(id); syncRetries.delete(id); publicationRetries.delete(id);
        try {
          await settleWorkspace(id, COULD_NOT_SEND);
        } catch (error) {
          if (signal.aborted) throw error;
          observe(() => options.onError?.(error, id));
        }
        try {
          await rm(folderOf(id), {recursive: true, force: true});
        } catch (error) {
          failed ??= {error};
        }
      }
      if (failed) throw failed.error;
    },
    /** The daemon is running and a pass completed, even if individual workspaces failed. */
    get unavailable(): boolean {
      return signal.aborted || !reconciled || !client || client.exited.signal.aborted;
    },
    /** The open replica of this workspace, or undefined. */
    replica(workspaceId: string): AutomationReplica | undefined { return replicas.get(workspaceId); },
    /** Ask for a pass; an owner's action can retry its workspace immediately. */
    reconcile(workspaceId?: string): void {
      const retry = workspaceId === undefined ? undefined : syncRetries.get(workspaceId);
      if (retry) retry.at = performance.now();
      const publication = workspaceId === undefined ? undefined : publicationRetries.get(workspaceId);
      if (publication) publication.at = performance.now();
      schedule();
    },
    /** The workspaces whose copy failed to open, sync, leave, or go in the last pass, with why. */
    failedSyncs(): ReadonlyMap<string, unknown> { return failedSyncs; },
    /** Resolves once no pass is asked for, waiting, running, or retrying. Rejects if the passes stopped on a failure. */
    async settled(): Promise<void> {
      await Effect.runPromise(Effect.raceFirst(idle.await, stopped));
    },
    /** Stops the passes, then closes every replica and the engine, waiting for work that ignores the abort. */
    close,
  };
}

// The copies' engine: a plain one, never the live host's.
async function spawnEngine(engineExecutable: string, configPath: string, signal: AbortSignal, onExit?: () => void): Promise<EngineClient> {
  return await createEngineClient({
    command: engineExecutable, authToken: randomBytes(32).toString("base64url"),
    env: {DOHC_ENGINE_OWNER_HOST_CONFIG: configPath, DOHC_ENGINE_READER_CONFIG: process.env.DOHC_ENGINE_READER_CONFIG},
    privateLiveApplication: selfHostedLiveProfile.nativeClient,
    protocolVersion: 2, capabilities: ["blobs"], connectTimeoutMs: REQUEST_DEADLINE_MS, signal,
    ...(onExit ? {onExit} : {}),
    onStderr: text => console.error("[automation-replicas]", text.trimEnd()),
  });
}

// The engine reads this configuration at start.
async function writeEngineConfig(root: string): Promise<string> {
  const configPath = join(root, `owner-ingress-${randomBytes(8).toString("hex")}.json`);
  await writeFile(configPath, JSON.stringify(selfHostedLiveProfile.nativeIngress), {flag: "wx", mode: 0o600});
  return configPath;
}

// The work's answer, or its caller's abort reason as soon as the caller gives up.
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, {once: true});
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function missing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function replicaFolder(root: string, namespace: string, workspaceId: string): string {
  return join(root, createHash("sha256").update(JSON.stringify([namespace, workspaceId])).digest("hex"));
}

/**
 * Opens a copy's workspace folder that no replica holds open, with no relay,
 * only to read the receipts of the phone's writes in it, then closes it.
 */
async function readFolder<T>(engineClient: EngineClient, nextRequestId: () => number, root: string, workspaceId: string,
  read: (reader: ReceiptReader) => Promise<T>): Promise<T> {
  const send = async (method: string, params: {[key: string]: JsonValue}, workspace?: string) =>
    (await engineClient.sendRequest({id: nextRequestId(), method, params, ...(workspace ? {workspace} : {}), deadlineMs: REQUEST_DEADLINE_MS})).result;
  const opened = await send("workspace.open", {rootDir: root, workspaceId, captureMode: "none", recoverRunningDispatches: false}) as {workspace?: unknown} | null;
  if (typeof opened?.workspace !== "string" || !opened.workspace) throw new Error("The engine did not open the copy's folder.");
  const handle = opened.workspace;
  try {
    return await read(receiptReader({client: engineClient, nextRequestId}, handle));
  } finally {
    await send("workspace.close", {}, handle).catch(() => undefined);
  }
}

/**
 * The server keeps no copies: they go at once, with their rows, rather than
 * after the retention a host move keeps them for. Call it at start when the
 * server keeps no copies of workspaces. The phone's unfinished writes in a
 * copy settle first, read with `settle`'s engine, started for that alone.
 * A copy whose writes couldn't be settled keeps its folder and its row, so a
 * later start tries again; without `settle`, every folder stays while one
 * holds such writes, since only the namespace tells the folders apart.
 */
export async function removeAutomationReplicas(storage: SyncRelayStorage, root: string,
  settle?: {namespace: string; engineExecutable: string}): Promise<void> {
  const unsettled = storage.listUnfinishedOperationCopies();
  if (unsettled.length > 0 && settle) await settleRemovedCopies(storage, root, settle, unsettled);
  const kept = [...new Set(storage.listUnfinishedOperationCopies().map((copy) => copy.workspaceId))];
  storage.forgetAutomationWorkspaces(kept);
  if (kept.length === 0) {
    await rm(root, {recursive: true, force: true});
    return;
  }
  console.error(`[sync-relay] Kept ${kept.length} copies of workspaces whose phone writes couldn't be settled yet.`);
  if (!settle) return;
  const folders = new Set(kept.map((workspaceId) => replicaFolder(root, settle.namespace, workspaceId)));
  for (const entry of await readdir(root)) {
    if (!folders.has(join(root, entry))) await rm(join(root, entry), {recursive: true, force: true});
  }
}

// Copies are off, so nothing will push from these folders again: each write ends saved or refused.
async function settleRemovedCopies(storage: SyncRelayStorage, root: string, settle: {namespace: string; engineExecutable: string},
  copies: ReadonlyArray<{workspaceId: string; incarnation: number}>): Promise<void> {
  await mkdir(root, {recursive: true, mode: 0o700});
  const configPath = await writeEngineConfig(root);
  let requestId = 0;
  const nextRequestId = () => ++requestId;
  try {
    const engineClient = await spawnEngine(settle.engineExecutable, configPath, storage.unavailable);
    try {
      for (const {workspaceId, incarnation} of copies) {
        const records = storage.listUnfinishedAccountOperations({workspaceId, incarnation});
        const home = join(replicaFolder(root, settle.namespace, workspaceId), String(incarnation));
        try {
          if (await missing(home)) await settleOperations(storage, records, null, COULD_NOT_SEND, Date.now());
          else await readFolder(engineClient, nextRequestId, join(home, "workspace"), workspaceId,
            (read) => settleOperations(storage, records, read, COULD_NOT_SEND, Date.now()));
        } catch (error) {
          console.error(`[sync-relay] The phone's writes in the copy of workspace "${workspaceId}" couldn't be settled.`, error);
        }
      }
    } finally {
      engineClient.close();
      await engineClient.waitForExit();
    }
  } catch (error) {
    console.error("[sync-relay] The engine that settles the phone's writes in removed copies didn't start.", error);
  } finally {
    await rm(configPath, {force: true});
  }
}
