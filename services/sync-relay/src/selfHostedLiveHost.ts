import {createHash} from "node:crypto";
import type {OwnerOutboxAdmission} from "./ownerOutboxDelivery";
import {mkdir, mkdtemp, readdir, rename, rm, writeFile} from "node:fs/promises";
import {realpathSync, statSync} from "node:fs";
import {basename, isAbsolute, join, posix, resolve} from "node:path";
import type {Event} from "@dohc/workspace-engine-client";
import {tmpdir} from "node:os";
import {setTimeout as delay} from "node:timers/promises";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type {LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import type {SyncRelayStorage} from "./storage";
import type {LiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import type {ServiceHostEnrollment} from "./storage/serviceHostEnrollment";
import {deriveServiceHostBearer} from "./serviceHostCredential";
import {observeRelayWrites, type LiveHostChanges} from "./relayWriteChanges";
import {startServiceLiveHost, type ServiceHostedSet} from "./serviceLiveHost";
import {selfHostLiveProfile} from "./selfHostLiveProfile";
import {discoverServiceHostDocuments} from "./serviceHostEnrollmentRoutes";

type Host = Awaited<ReturnType<typeof startServiceLiveHost>>;
// Background reconciliation must not keep an otherwise idle Node process alive.
const pause = (ms: number) => Effect.promise(signal => delay(ms, undefined, {signal, ref: false}));
function canonicalPath(value: string, directory: boolean): string {
  if (!isAbsolute(value) || resolve(value) !== value) throw new Error("Self-host paths must be absolute and canonical.");
  const actual = realpathSync(value);
  const same = process.platform === "win32" ? actual.toLowerCase() === value.toLowerCase() : actual === value;
  if (!same || (directory ? !statSync(value).isDirectory() : !statSync(value).isFile())) throw new Error("Self-host path is unavailable.");
  return actual;
}

/** Owns the sole service daemon; account requests can select documents, never native paths or credentials. */
export async function startSelfHostedLiveHost(options: {
  trustedAccount: OwnerOutboxAdmission["trustedAccount"];
  storage: SyncRelayStorage; history: LiveJournalHistoryAuthority; root: string; engineExecutable: string;
  relayOrigin: string; key: Uint8Array; frameChanges: LiveHostChanges;
  startHost?: typeof startServiceLiveHost;
  onError?(error: unknown): void;
}) {
  const {storage, history} = options, profile = selfHostLiveProfile();
  const root = canonicalPath(options.root, true), engineExecutable = canonicalPath(options.engineExecutable, false);
  const relay = new URL(options.relayOrigin);
  if (relay.protocol !== "https:" || relay.origin !== options.relayOrigin || options.key.byteLength < 32) throw new Error("Self-host live editing requires its public HTTPS origin and a private key.");
  const hostId = `self-host-${history.namespace}`, instanceId = "self-host-service";
  const provision = storage.provisionLiveHostControl({mode: "service", hostId, updatedAtMs: Date.now(), guard: storage.captureStanding()});
  if (!provision.ok || provision.snapshot.transition) throw new Error("Self-host live editing requires its provisioned service host. Existing device hosts must use the host transition procedure.");
  let current: Host | undefined;
  let initialReconciliationComplete = false, selectedDocuments = false, storesChecked = false;
  let signature = "", lastError: unknown;
  let discoveryCursor: {workspaceId: string; shareId: string} | undefined;
  let writeGeneration = 1, scanGeneration = 0, scannedGeneration = 0;
  const lifetime = new AbortController();
  const eventHandlers = new Set<(event: Event) => void>();
  const signal = AbortSignal.any([lifetime.signal, storage.unavailable]);
  const changes = Effect.runSync(Queue.sliding<void>(1));
  // Whether the enrollment names its workspace's current owner and identity.
  const matching = (row: ServiceHostEnrollment) => storage.workspaceIsOwnedBy(row.workspaceId, row.ownerUserId) && storage.verifyWorkspaceIdentity(row) === "matched";
  // A release applies to the document: it was stopped, paused, or no Edit grant covers it.
  const departs = (row: ServiceHostEnrollment, covered: boolean) => row.retired || !covered || row.ownerStop !== null;
  // A document is hosted while an active Edit grant covers it at its enrolled path and its owner has not paused or stopped it.
  const hosts = (row: ServiceHostEnrollment, covered: boolean) => !departs(row, covered) && matching(row) &&
    storage.objectIdAtPathInVersion({workspaceId: row.workspaceId, versionId: "main", path: row.path}) === row.objectId;
  // Hosted documents, and those that departed but may remain in their workspace's hosted replica. A
  // departed document under an obsolete identity has none to leave: its old store is fenced.
  const select = () => {
    const undrained = storage.listUndrainedServiceHostEnrollments();
    const covered = new Set(undrained.filter(row => storage.serviceHostEnrollmentHasEditGrant(row)));
    const leaving = undrained.filter(row => departs(row, covered.has(row)));
    return {targets: undrained.filter(row => hosts(row, covered.has(row))), departing: leaving.filter(matching),
      obsolete: leaving.filter(row => !matching(row))};
  };
  const selectionSignature = ({targets, departing}: ReturnType<typeof select>) => JSON.stringify([targets, departing].map(rows =>
    rows.map(({workspaceId, objectId, path, shareId, ownerUserId, replicationEpoch, streamIdentity}) => ({workspaceId, objectId, path, shareId, ownerUserId, replicationEpoch, streamIdentity}))));
  // A workspace identity's hosted replica. The label keeps a store of any other kind from opening as one.
  const storeName = (row: ServiceHostEnrollment) => createHash("sha256")
    .update(JSON.stringify(["hosted-v1", history.namespace, row.workspaceId, row.replicationEpoch, row.streamIdentity])).digest("hex");
  // Drained stores whose removal failed. Their workspaces stay detached until it succeeds.
  const unremoved = new Map<string, {directory: string; rows: readonly ServiceHostEnrollment[]}>();
  function schedule() {
    if (!signal.aborted) Queue.offerUnsafe(changes, undefined);
  }
  async function stopCurrent() {
    const previous = current; current = undefined;
    if (previous) await previous.close();
  }
  function release(row: ServiceHostEnrollment) {
    try {storage.releaseServiceHostEnrollment({workspaceId: row.workspaceId, objectId: row.objectId, nowMs: Date.now()});}
    catch (error) {options.onError?.(error);}
  }
  // Removes every store no undrained enrollment names, as one released while
  // this host was down or one from before hosted replicas. Set-aside stores
  // and anything that is not a store, such as automation replicas, stay.
  async function removeUnnamedStores() {
    const named = new Set(storage.listUndrainedServiceHostEnrollments().filter(matching).map(storeName));
    for (const name of await readdir(root)) if (/^[0-9a-f]{64}$/.test(name) && !named.has(name)) await rm(join(root, name), {recursive: true, force: true});
  }
  async function removeStore(workspaceId: string) {
    const {directory, rows} = unremoved.get(workspaceId)!;
    await rm(directory, {recursive: true, force: true});
    unremoved.delete(workspaceId);
    for (const row of rows) release(row);
  }
  async function hostedSet({targets, departing}: ReturnType<typeof select>): Promise<ServiceHostedSet> {
    const named = new Map<string, ServiceHostEnrollment>();
    for (const row of [...targets, ...departing]) if (!named.has(row.workspaceId)) named.set(row.workspaceId, row);
    const workspaces = [];
    // Every selected document matches its workspace's current identity, so any of them names it.
    for (const [workspaceId, row] of named) {
      const directory = join(root, storeName(row));
      await mkdir(directory, {recursive: true, mode: 0o700});
      workspaces.push({root: canonicalPath(directory, true), workspaceId, maxRegistrations: 64,
        hostedReplication: {relay: {baseUrl: relay.origin, bearerToken: deriveServiceHostBearer(row, {key: options.key, namespace: history.namespace})},
          identity: {replicationEpoch: row.replicationEpoch, streamIdentity: row.streamIdentity}, maxPagesPerPull: 8}});
    }
    return {workspaces, documents: targets.map(({workspaceId, objectId, path, shareId}) => ({workspaceId, objectId, path, shareId})),
      departing: departing.map(({workspaceId, objectId}) => ({workspaceId, objectId}))};
  }
  async function start(): Promise<Host> {
    const temporary = await mkdtemp(join(tmpdir(), "dohc-self-host-config-"));
    try {
      const configPath = join(temporary, "service.json");
      // The daemon starts empty. Each update attaches and detaches its workspaces and documents.
      await writeFile(configPath, JSON.stringify({version: 1, engineExecutable, hostId, instanceId, workspaces: [],
        ...profile.service, activation: {...profile.service.activation, targets: []}}), {flag: "wx", mode: 0o600});
      signal.throwIfAborted();
      const host = await (options.startHost ?? startServiceLiveHost)({trustedAccount: options.trustedAccount,configPath, storage, history, frameChanges: options.frameChanges, signal});
      host.onEvent((event) => { for (const handler of eventHandlers) handler(event); });
      host.invalidated.addEventListener("abort", schedule, {once: true});
      return host;
    } finally {await rm(temporary, {recursive: true, force: true});}
  }
  // The selection, without workspaces whose drained store is still being removed.
  const selection = () => {
    const selected = select(), kept = (row: ServiceHostEnrollment) => !unremoved.has(row.workspaceId);
    return {...selected, targets: selected.targets.filter(kept), departing: selected.departing.filter(kept)};
  };
  async function reconcile() {
    // An owner's Pause or Stop, or the loss of the last Edit grant, takes
    // effect once no hosted replica holds the document.
    let selected: ReturnType<typeof select> | undefined;
    try {
      signal.throwIfAborted();
      if (discoveryCursor || scannedGeneration !== writeGeneration) {
        if (!discoveryCursor) scanGeneration = writeGeneration;
        discoveryCursor = discoverServiceHostDocuments(storage, options.onError, discoveryCursor) ?? undefined;
        if (!discoveryCursor) scannedGeneration = scanGeneration;
      }
      if (!storesChecked) {await removeUnnamedStores(); storesChecked = true;}
      for (const workspaceId of [...unremoved.keys()]) await removeStore(workspaceId);
      // Only a failed daemon restarts. Membership changes update the running one.
      if (current?.invalidated.aborted) {await stopCurrent(); signature = "";}
      // A diverged store may hold work nobody published, so it is kept aside, never deleted, and the workspace starts over from the relay.
      for (const {workspaceId, root: store} of current?.diverged() ?? []) {
        await mkdir(join(root, "diverged"), {recursive: true, mode: 0o700});
        const kept = join(root, "diverged", `${basename(store)}-${Date.now()}`);
        await rename(store, kept);
        current!.rebuild(workspaceId); signature = "";
        options.onError?.(new Error(`The live editing copy of workspace ${workspaceId} diverged from the relay. It was kept at ${kept} and is rebuilt from the relay.`));
      }
      selected = selection();
      const {targets, departing} = selected, next = selectionSignature(selected);
      selectedDocuments = targets.length > 0;
      if (next !== signature || ((targets.length || departing.length) && !current)) {
        const desired = await hostedSet(selected);
        signal.throwIfAborted();
        if (next !== selectionSignature(selection())) {schedule(); return;}
        if (!current && (targets.length || departing.length)) current = await start();
        // A failed update may already have changed membership, so the next reconciliation updates again.
        signature = "";
        await current?.update(desired);
        signature = next;
      }
      // A workspace with no documents lets go of its store once its replica
      // drained: detach, remove the store, then release its enrollments. A
      // failure between steps leaves them undrained, so the next start drains again.
      for (const workspaceId of new Set(departing.map(row => row.workspaceId))) {
        if (!current || targets.some(row => row.workspaceId === workspaceId) || !(await current.detachDrained(workspaceId, signal))) continue;
        // The workspace stays detached, and out of every update, until its store is gone.
        signature = "";
        const rows = departing.filter(row => row.workspaceId === workspaceId);
        unremoved.set(workspaceId, {directory: join(root, storeName(rows[0]!)), rows});
        await removeStore(workspaceId);
      }
      lastError = undefined; initialReconciliationComplete = true;
    } catch (error) {
      if (!signal.aborted) {lastError = error; options.onError?.(error);}
    } finally {
      // A failed update or one damaged row does not hold back the others.
      if (selected && !signal.aborted) {
        for (const row of selected.obsolete) release(row);
        // A sibling document keeps its workspace attached, so its replica confirms each departed document gone.
        for (const row of selected.departing) {
          if (selected.targets.some(target => target.workspaceId === row.workspaceId) && current?.retains(row) === false) release(row);
        }
      }
    }
  }
  const finished = Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.succeed(changes), Queue.shutdown);
    yield* Effect.acquireRelease(
      Effect.sync(() => observeRelayWrites(storage, () => {writeGeneration++; schedule();})),
      stopWatching => Effect.gen(function* () {
        stopWatching();
        yield* Effect.promise(stopCurrent);
      }),
    );
    yield* Effect.forkScoped(Effect.forever(pause(2_000).pipe(Effect.andThen(Effect.sync(schedule)))));
    schedule();
    while (true) {
      yield* Queue.take(changes);
      yield* pause(100);
      yield* Queue.clear(changes);
      // File operations and daemon starts may ignore cancellation. Drain them
      // before finalization, so a late start cannot escape its owner's close.
      yield* Effect.uninterruptible(Effect.promise(reconcile));
    }
  })), {signal});
  return {
    current: () => current,
    ready(document: LiveDocumentKey) {return current?.isDocumentReady(document) ?? false;},
    get unavailable() {return signal.aborted || !initialReconciliationComplete || lastError !== undefined ||
      (selectedDocuments && (!current || current.invalidated.aborted));},
    reconcile: schedule,
    /** The claim ledger of a workspace whose live-shared documents this host holds, while it runs. */
    automationLedger(workspaceId: string) {return current?.automationLedger(workspaceId) ?? null;},
    /**
     * The workspaces with a live-shared document this host holds in a folder
     * that has an automations.yaml: the server runs those changes' automations.
     */
    automationWorkspaces(): string[] {
      const found = new Set<string>();
      for (const row of selection().targets) {
        const folder = posix.dirname(row.path);
        const file = folder === "." ? "automations.yaml" : `${folder}/automations.yaml`;
        if (storage.objectIdAtPathInVersion({workspaceId: row.workspaceId, versionId: "main", path: file}) !== undefined) found.add(row.workspaceId);
      }
      return [...found];
    },
    /** The live host's engine events, across its restarts. */
    onAutomationEvent(handler: (event: Event) => void): () => void {
      eventHandlers.add(handler);
      return () => { eventHandlers.delete(handler); };
    },
    async close() {
      lifetime.abort();
      const exit = await finished;
      if (exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause)) throw Cause.squash(exit.cause);
    },
  };
}
