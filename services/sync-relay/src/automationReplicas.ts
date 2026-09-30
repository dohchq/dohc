import {createHash, randomBytes} from "node:crypto";
import {mkdir, readdir, rm} from "node:fs/promises";
import {join} from "node:path";
import type {Event, JsonValue} from "@dohc/workspace-engine-client";
import {createEngineClient, type EngineClient} from "@dohc/workspace-engine-client/daemon";
import type {SyncRelayStorage} from "./storage";
import {
  AUTOMATION_WORKSPACE_KEEP_AFTER_LEAVING_MS,
  AUTOMATION_WORKSPACE_LEAVE_AFTER_MS,
  type AutomationWorkspace,
} from "./storage/automationWorkspaces";
import {deriveAutomationReplicaBearer} from "./automationReplicaCredential";
import {observeRelayWrites} from "./relayWriteChanges";
import {ServiceOrdinaryReplication} from "./serviceOrdinaryReplication";

/** One workspace this server keeps a replica of, open in its engine. */
export interface AutomationReplica {
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly incarnation: number;
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
}

const REQUEST_DEADLINE_MS = 30_000;
// A pass pushes and pulls each copy at most this many rounds, so one busy
// workspace cannot hold the pass; the next pass carries on where it stopped.
const ROUNDS_PER_PASS = 4;
const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 60_000;
// The longest a deadline timer waits before it looks again.
const DEADLINE_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * Keeps one engine replica per workspace whose automations this server runs,
 * in one engine daemon of its own. The live host's engine serves browsers
 * and restarts when its documents change, so it never runs automations.
 *
 * `wanted` names the workspaces that need a replica now. Each joins through
 * ordinary replication as the workspace owner, with a credential derived for
 * that replica alone. A relay write that reaches a replica's workspace pulls
 * it; nothing polls. A replica no longer wanted leaves after a day and stays
 * on disk for Undo and run history until its retention ends.
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
  wanted(): readonly string[];
  nowMs?(): number;
  /** A replica opened or closed. */
  onChanged?(workspaceId: string): void;
  /** The engine announced something, such as an automation claim, for a workspace it names. */
  onEngineEvent?(event: Event): void;
  /** A pull wrote these paths into a replica. */
  onPulled?(workspaceId: string, paths: readonly string[]): void;
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
    close(): Promise<void>; pulledHead: number;
    /** A bounded sync for a pass: answers whether it caught up. */
    step(): Promise<boolean>;
    busy(): boolean;
  }>();
  let client: {engine: EngineClient; exited: AbortController} | undefined;
  let starting: Promise<{engine: EngineClient; exited: AbortController}> | undefined;
  let requestId = 0;
  const nextRequestId = () => ++requestId;
  let active: Promise<void> | undefined, requested = false, timer: ReturnType<typeof setTimeout> | undefined;
  // The armed timer only retries workspaces that failed, so a pass asked
  // for meanwhile need not wait for it.
  let retryingWorkspaces = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let retryMs = RETRY_FIRST_MS;
  // The workspaces whose part of the last pass failed, with why.
  const failedSyncs = new Map<string, unknown>();

  const folderOf = (workspaceId: string) => replicaFolder(options.root, options.namespace, workspaceId);
  // The workspace ids whose folders the last sweep kept.
  let swept: string | null = null;

  function engine(): Promise<{engine: EngineClient; exited: AbortController}> {
    if (client && !client.exited.signal.aborted) return Promise.resolve(client);
    starting ??= (async () => {
      const exited = new AbortController();
      const started = await createEngineClient({
        command: options.engineExecutable, authToken: randomBytes(32).toString("base64url"),
        protocolVersion: 2, capabilities: ["blobs"], connectTimeoutMs: REQUEST_DEADLINE_MS, signal,
        onExit: () => {
          exited.abort();
          // Every replica opened in it is gone; the next pass opens them again.
          for (const replica of [...replicas.values()]) if (replica.client === started) void replica.close();
          schedule(RETRY_FIRST_MS);
        },
        onStderr: text => console.error("[automation-replicas]", text.trimEnd()),
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

  async function open(row: AutomationWorkspace): Promise<void> {
    const folder = folderOf(row.workspaceId);
    const home = join(folder, String(row.incarnation));
    const root = join(home, "workspace"), metadataDir = join(home, "metadata");
    await mkdir(root, {recursive: true, mode: 0o700});
    await mkdir(metadataDir, {recursive: true, mode: 0o700});
    // An earlier incarnation's replica belongs to an identity that is gone.
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
    let chain: Promise<unknown> = Promise.resolve();
    // Pushes, then pulls, each for at most `rounds`. Answers whether it caught up.
    // Pushes, then pulls, each for at most `rounds`, so a copy that always
    // has more to push still pulls. Answers whether it caught up.
    let running = 0;
    const syncRounds = (rounds: number, callerSignal?: AbortSignal): Promise<boolean> => {
      running += 1;
      const run = chain.then(async () => {
        const head = logHead(row.workspaceId);
        let pushMore = true, pullMore = true;
        for (let round = 0; pushMore && round < rounds; round++) pushMore = (await replication.push(callerSignal)).hasMore;
        // Each committed page is heard at once, so a later page that fails loses nothing already applied.
        for (let round = 0; pullMore && round < rounds; round++) {
          // A page with no file paths can still carry Group messages.
          pullMore = (await replication.pull(callerSignal, (page) => options.onPulled?.(row.workspaceId, page.changedPaths))).hasMore;
        }
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
      chain = run.catch(() => undefined);
      return run;
    };
    const replica = {
      workspaceId: row.workspaceId, ownerUserId: row.ownerUserId, incarnation: row.incarnation, startedAtMs: row.startedAtMs,
      root, metadataDir, client: engineClient, workspace: handle, signal: replicaSignal, nextRequestId, pulledHead: 0,
      sync(callerSignal?: AbortSignal): Promise<void> {
        return syncRounds(Number.POSITIVE_INFINITY, callerSignal).then(() => undefined);
      },
      step(): Promise<boolean> {
        return syncRounds(ROUNDS_PER_PASS);
      },
      /** A sync is running or queued: it makes progress without the pass. */
      busy(): boolean {
        return running > 0;
      },
      async close(): Promise<void> {
        if (replicas.get(row.workspaceId) !== replica) return;
        replicas.delete(row.workspaceId);
        closed.abort();
        await chain;
        await release();
        options.onChanged?.(row.workspaceId);
      },
    };
    try {
      // A pulled moment lands in the main version, as on a computer that joins.
      await request(engineClient, "versions.ensureMain", {workspaceId: row.workspaceId}, handle);
      // A copy with a long history catches up over several passes, after the others.
      if (!(await replica.step())) requested = true;
    } catch (error) {
      // A replica that never opened fully leaves nothing open behind.
      await release();
      throw error;
    }
    replicas.set(row.workspaceId, replica);
    options.onChanged?.(row.workspaceId);
  }

  /**
   * Runs one workspace's part of a pass. A failure is that workspace's
   * alone: it is kept in failedSyncs and reported, and the pass goes on to
   * the others, so one tenant cannot stop another's copy, or keep a copy
   * past its time. Answers whether it succeeded.
   */
  async function each(workspaceId: string, work: () => Promise<void>): Promise<boolean> {
    signal.throwIfAborted();
    try {
      await work();
      failedSyncs.delete(workspaceId);
      return true;
    } catch (error) {
      if (signal.aborted) throw error;
      failedSyncs.set(workspaceId, error);
      options.onError?.(error, workspaceId);
      return false;
    }
  }

  // Answers whether every workspace's part succeeded.
  // Answers whether every workspace's part succeeded, and throws for a
  // failure that is no one workspace's, once every workspace had its turn.
  async function reconcile(): Promise<boolean> {
    requested = false;
    let ok = true;
    let passFailure: unknown = null;
    const wanted = new Set(options.wanted());
    for (const workspaceId of wanted) {
      ok = await each(workspaceId, async () => {
        const row = storage.joinAutomationWorkspace({workspaceId, nowMs: nowMs()});
        const open_ = replicas.get(workspaceId);
        if (open_ && (row === null || open_.incarnation !== row.incarnation)) await open_.close();
        if (row !== null && !replicas.has(workspaceId)) await open(row);
      }) && ok;
    }
    for (const row of storage.listAutomationWorkspaces()) {
      if (wanted.has(row.workspaceId)) continue;
      ok = await each(row.workspaceId, async () => {
        if (row.leftAtMs === null) {
          const left = storage.unwantAutomationWorkspace({workspaceId: row.workspaceId, nowMs: nowMs()});
          if (left) await replicas.get(row.workspaceId)?.close();
        } else if (nowMs() - row.leftAtMs >= AUTOMATION_WORKSPACE_KEEP_AFTER_LEAVING_MS) {
          await replicas.get(row.workspaceId)?.close();
          await rm(folderOf(row.workspaceId), {recursive: true, force: true});
          storage.forgetAutomationWorkspace({workspaceId: row.workspaceId, incarnation: row.incarnation});
        }
      }) && ok;
    }
    // A replica whose row is gone, as when its workspace was deleted, closes,
    // and its folder goes too.
    const rows = storage.listAutomationWorkspaces();
    const rowIds = new Set(rows.map((row) => row.workspaceId));
    for (const replica of [...replicas.values()]) {
      if (!rowIds.has(replica.workspaceId)) ok = await each(replica.workspaceId, () => replica.close()) && ok;
    }
    for (const workspaceId of [...failedSyncs.keys()]) if (!rowIds.has(workspaceId) && !wanted.has(workspaceId)) failedSyncs.delete(workspaceId);
    const kept = JSON.stringify(rows.map((row) => row.workspaceId));
    if (kept !== swept) {
      const folders = new Set(rows.map((row) => folderOf(row.workspaceId)));
      let swept_ = true;
      for (const entry of await readdir(options.root)) {
        if (folders.has(join(options.root, entry))) continue;
        try {
          await rm(join(options.root, entry), {recursive: true, force: true});
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
      if (replica.busy()) continue;
      ok = await each(replica.workspaceId, async () => {
        // A copy with more to sync goes on in the next pass, after the others.
        if (!(await replica.step())) requested = true;
      }) && ok;
    }
    if (passFailure !== null) throw passFailure;
    return ok;
  }

  function schedule(delayMs = 100): void {
    if (signal.aborted) return;
    requested = true;
    if (active) return;
    if (timer && retryingWorkspaces) { clearTimeout(timer); timer = undefined; }
    if (!timer) arm(delayMs);
  }

  // One pass after `delayMs`. A pass that fails runs again after a delay
  // that doubles up to a minute; a pass asked for meanwhile runs soon after.
  function arm(delayMs: number): void {
    retryingWorkspaces = false;
    timer = setTimeout(() => {
      timer = undefined;
      let retry: number | null = null, workspacesFailed = false;
      active = reconcile().then((ok) => {
        options.onReconciled?.();
        if (ok) { retryMs = RETRY_FIRST_MS; return; }
        // A workspace that failed tries again, as a failed pass does.
        workspacesFailed = true;
        retry = retryMs;
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }, error => {
        if (signal.aborted) return;
        options.onError?.(error);
        retry = retryMs;
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }).finally(() => {
        active = undefined;
        if (signal.aborted) return;
        // A failed pass waits out its delay; a failed workspace does not hold up a pass asked for.
        if (retry !== null && !workspacesFailed) { requested = true; arm(retry); }
        else if (requested) arm(100);
        else if (retry !== null) { requested = true; arm(retry); retryingWorkspaces = true; }
        armDeadline();
      });
    }, delayMs);
    timer.unref();
  }

  // A replica leaves, or goes, at a time and not after a write: wake for the
  // nearest such deadline.
  function armDeadline(): void {
    clearTimeout(deadline);
    let next = Number.POSITIVE_INFINITY;
    for (const row of storage.listAutomationWorkspaces()) {
      if (failedSyncs.has(row.workspaceId)) continue;
      if (row.leftAtMs !== null) next = Math.min(next, row.leftAtMs + AUTOMATION_WORKSPACE_KEEP_AFTER_LEAVING_MS);
      else if (row.unwantedSinceMs !== null) next = Math.min(next, row.unwantedSinceMs + AUTOMATION_WORKSPACE_LEAVE_AFTER_MS);
    }
    if (next === Number.POSITIVE_INFINITY) return;
    deadline = setTimeout(() => schedule(0), Math.min(Math.max(next - nowMs(), 0), DEADLINE_MAX_WAIT_MS));
    deadline.unref();
  }

  await mkdir(options.root, {recursive: true, mode: 0o700});
  const stopWatching = observeRelayWrites(storage, () => schedule());
  schedule(0);
  return {
    /** The open replica of this workspace, or undefined. */
    replica(workspaceId: string): AutomationReplica | undefined { return replicas.get(workspaceId); },
    /** Ask for a pass now, as after a change the relay's write observer does not see. */
    reconcile(): void { schedule(); },
    /** The workspaces whose copy failed to open, sync, leave, or go in the last pass, with why. */
    failedSyncs(): ReadonlyMap<string, unknown> { return failedSyncs; },
    /** Resolves once no pass is waiting or running. */
    async settled(): Promise<void> {
      while (timer || active) {
        if (timer) await new Promise(resolve => setTimeout(resolve, 0));
        else await active;
      }
    },
    async close(): Promise<void> {
      lifetime.abort(); stopWatching(); clearTimeout(timer); clearTimeout(deadline); timer = undefined;
      await active;
      for (const replica of [...replicas.values()]) await replica.close();
      const current = client ?? (starting ? await starting.catch(() => undefined) : undefined);
      if (current) { current.engine.close(); await current.engine.waitForExit(); }
    },
  };
}

function replicaFolder(root: string, namespace: string, workspaceId: string): string {
  return join(root, createHash("sha256").update(JSON.stringify([namespace, workspaceId])).digest("hex"));
}

/**
 * The server no longer runs automations: its copies go at once, with their
 * rows, rather than after the retention a host move keeps them for. Call it
 * at start when the deployment turns automations off.
 */
export async function removeAutomationReplicas(storage: SyncRelayStorage, root: string): Promise<void> {
  storage.forgetAutomationWorkspaces();
  await rm(root, {recursive: true, force: true});
}
