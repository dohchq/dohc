import {createHash} from "node:crypto";
import type {OwnerOutboxAdmission} from "./ownerOutboxDelivery";
import {mkdir, mkdtemp, open, readdir, rm, writeFile} from "node:fs/promises";
import {realpathSync, statSync} from "node:fs";
import {basename, isAbsolute, join, posix, resolve} from "node:path";
import type {Event, JsonValue} from "@dohc/workspace-engine-client";
import {tmpdir} from "node:os";
import {setTimeout as delay} from "node:timers/promises";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type {LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";
import type {FirstOpenSourceIdentity} from "@dohc/workspace-contracts/first-open";
import type {SyncRelayStorage} from "./storage";
import type {LiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import type {ServiceHostEnrollment, ServiceHostEnrollmentCursor} from "./storage/serviceHostEnrollment";
import type {ServiceKeptEdits} from "./storage/serviceKeptEdits";
import {deriveServiceHostBearer} from "./serviceHostCredential";
import {observeRelayWrites, type LiveHostChanges} from "./relayWriteChanges";
import {startServiceLiveHost, type ServiceHostedSet} from "./serviceLiveHost";
import {selfHostLiveProfile} from "./selfHostLiveProfile";
import {discoverServiceHostDocuments} from "./serviceHostEnrollmentRoutes";

type WorkspaceIdentity = {workspaceId: string; replicationEpoch: string | null; streamIdentity: string | null};
// A workspace identity's hosted replica. The label keeps a store of any other kind from opening as one.
const hostedStoreName = (namespace: string, row: WorkspaceIdentity) => createHash("sha256")
  .update(JSON.stringify(["hosted-v1", namespace, row.workspaceId, row.replicationEpoch, row.streamIdentity])).digest("hex");
// The marker beside a store whose hosted replica diverged from the relay.
const divergedMarker = (root: string, name: string) => join(root, `${name}.diverged`);

/** Removes each workspace identity's hosted store, with any parked documents in it, and its divergence marker. */
export async function deleteSelfHostedWorkspaceRoots(root: string, namespace: string, workspaces: readonly WorkspaceIdentity[]): Promise<void> {
  for (const row of workspaces) {
    const name = hostedStoreName(namespace, row);
    // The marker goes last, so a store that is only partly removed stays detached.
    await rm(join(root, name), {recursive: true, force: true});
    await rm(divergedMarker(root, name), {force: true});
  }
}

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
  let initialReconciliationComplete = false, selectedDocuments = false;
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
  const atPath = (row: ServiceHostEnrollment) => storage.objectIdAtPathInVersion({workspaceId: row.workspaceId, versionId: "main", path: row.path}) === row.objectId;
  const documentKey = (row: Pick<ServiceHostEnrollment, "workspaceId" | "objectId">) => JSON.stringify([row.workspaceId, row.objectId]);
  const movedKey = (row: ServiceHostEnrollment) => JSON.stringify([row.workspaceId, row.objectId, row.path, row.replicationEpoch, row.streamIdentity]);
  // Moved documents whose replica let them go. Nothing releases one: its
  // enrollment stays, so it is hosted again once it returns to its path.
  const moved = new Set<string>();
  // Where the page of retired enrollments starts. Each page gives way to the next once all of it had its chance.
  let retiredCursor: ServiceHostEnrollmentCursor | undefined;
  // Hosted documents, and those that departed but may remain in their workspace's hosted replica.
  // A document is hosted while an active Edit grant covers it at its enrolled path and its owner has
  // not paused or stopped it. A departed document under an obsolete identity has none to leave: its old store is fenced.
  const select = () => {
    const page = storage.listUndrainedServiceHostEnrollments(retiredCursor);
    const targets: ServiceHostEnrollment[] = [], departing: ServiceHostEnrollment[] = [], obsolete: ServiceHostEnrollment[] = [], away: ServiceHostEnrollment[] = [];
    for (const row of page.documents) {
      if (departs(row, storage.serviceHostEnrollmentHasEditGrant(row))) (matching(row) ? departing : obsolete).push(row);
      else if (matching(row)) (atPath(row) ? targets : away).push(row);
    }
    // A document moved from its enrolled path leaves its replica as a departed one does, until the replica confirms it gone.
    const still = new Set(away.map(movedKey));
    for (const key of moved) if (!still.has(key)) moved.delete(key);
    departing.push(...away.filter(row => !moved.has(movedKey(row))));
    return {targets, departing, obsolete, nextCursor: page.nextCursor};
  };
  const selectionSignature = ({targets, departing}: ReturnType<typeof select>) => JSON.stringify([targets, departing].map(rows =>
    rows.map(({workspaceId, objectId, path, shareId, ownerUserId, replicationEpoch, streamIdentity}) => ({workspaceId, objectId, path, shareId, ownerUserId, replicationEpoch, streamIdentity}))));
  // A store keeps its parked documents' activations, so only account deletion removes one.
  const storeName = (row: WorkspaceIdentity) => hostedStoreName(history.namespace, row);
  // The stores, by name, whose hosted replica diverged from the relay. Each
  // stays detached, untouched, and releases nothing. A marker beside the store
  // keeps it so after a restart, before any pull could find the divergence again.
  const marker = (name: string) => divergedMarker(root, name);
  const recovery = (name: string) => `Recovery is not automatic yet. The store and every edit in it are kept. Keep ${marker(name)}. Without it the next relay start attaches the store again and checks it against the relay before anyone can edit.`;
  const diverged = new Set((await readdir(root)).flatMap(name => /^([0-9a-f]{64})\.diverged$/.exec(name)?.[1] ?? []));
  for (const name of diverged) options.onError?.(new Error(`The live editing copy in store ${join(root, name)} diverged from the relay earlier. It stays detached. ${recovery(name)}`));
  // Diverged stores whose marker is not yet durable, with whether its failure was reported.
  // Each reconciliation tries again; until one succeeds, a restart attaches the store again.
  const unmarked = new Map<string, {workspaceId: string; reported: boolean}>();
  async function writeMarker(name: string, workspaceId: string) {
    const handle = await open(marker(name), "w", 0o600);
    try {await handle.writeFile(JSON.stringify({workspaceId})); await handle.sync();}
    finally {await handle.close();}
    // Windows cannot open directory handles for fsync through Node.
    if (process.platform === "win32") return;
    const directory = await open(root, "r");
    try {await directory.sync();} finally {await directory.close();}
  }
  // The documents this reconciliation released, or tried to.
  const left = new Set<string>();
  // Blocked documents already reported to the operator.
  const refused = new Set<string>();
  function schedule() {
    if (!signal.aborted) Queue.offerUnsafe(changes, undefined);
  }
  async function stopCurrent() {
    const previous = current; current = undefined;
    if (previous) await previous.close();
  }
  // Called once no hosted replica holds the document. A moved document has nothing to release.
  function leave(row: ServiceHostEnrollment) {
    left.add(documentKey(row));
    try {if (!storage.releaseServiceHostEnrollment({workspaceId: row.workspaceId, objectId: row.objectId, nowMs: Date.now()})) moved.add(movedKey(row));}
    catch (error) {options.onError?.(error);}
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
    const document = ({workspaceId, objectId, path, shareId}: ServiceHostEnrollment) => ({workspaceId, objectId, path, shareId});
    return {workspaces, documents: targets.map(document), departing: departing.map(document)};
  }
  async function start(): Promise<Host> {
    // The service host refuses a configuration path that resolves elsewhere,
    // and macOS keeps its temporary folder behind a link.
    const temporary = await mkdtemp(join(realpathSync(tmpdir()), "dohc-self-host-config-"));
    try {
      const configPath = join(temporary, "service.json");
      // The daemon starts empty. Each update attaches and detaches its workspaces and documents.
      // It copies earlier stores for recovery under the store root.
      await writeFile(configPath, JSON.stringify({version: 1, engineExecutable, hostId, instanceId, workspaces: [],
        ...profile.service, activation: {...profile.service.activation, targets: []}, recovery: {...profile.service.recovery, root}}), {flag: "wx", mode: 0o600});
      signal.throwIfAborted();
      const host = await (options.startHost ?? startServiceLiveHost)({trustedAccount: options.trustedAccount,configPath, storage, history, frameChanges: options.frameChanges, signal});
      host.onEvent((event) => { for (const handler of eventHandlers) handler(event); });
      host.invalidated.addEventListener("abort", schedule, {once: true});
      return host;
    } finally {await rm(temporary, {recursive: true, force: true});}
  }
  // The selection, without diverged stores.
  const selection = () => {
    const selected = select(), kept = (row: ServiceHostEnrollment) => !diverged.has(storeName(row));
    return {...selected, targets: selected.targets.filter(kept), departing: selected.departing.filter(kept)};
  };
  async function reconcile() {
    // An owner's Pause or Stop, or the loss of the last Edit grant, takes
    // effect once no hosted replica holds the document.
    let selected: ReturnType<typeof select> | undefined;
    left.clear();
    try {
      signal.throwIfAborted();
      if (discoveryCursor || scannedGeneration !== writeGeneration) {
        if (!discoveryCursor) scanGeneration = writeGeneration;
        discoveryCursor = discoverServiceHostDocuments(storage, options.onError, discoveryCursor) ?? undefined;
        if (!discoveryCursor) scannedGeneration = scanGeneration;
      }
      // A diverged store may hold work nobody published. It stays where it is,
      // and nothing attaches it again, even on a restarted daemon or relay.
      for (const {workspaceId, root: store} of current?.diverged() ?? []) {
        const name = basename(store);
        if (diverged.has(name)) continue;
        diverged.add(name); unmarked.set(name, {workspaceId, reported: false});
        options.onError?.(new Error(`The live editing copy of workspace ${workspaceId} diverged from the relay. It stays detached, and its store is kept at ${store}. ${recovery(name)}`));
      }
      for (const [name, pending] of unmarked) {
        try {await writeMarker(name, pending.workspaceId); unmarked.delete(name);}
        catch (error) {
          if (!pending.reported) options.onError?.(new Error(`Could not write ${marker(name)}. It is retried while the relay runs; a relay restart before it lands attaches the store again.`, {cause: error}));
          pending.reported = true;
        }
      }
      // Only a failed daemon restarts. Membership changes update the running one.
      if (current?.invalidated.aborted) {await stopCurrent(); signature = "";}
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
      // The owner learns only that live editing stopped. Where its work is kept is for the operator.
      for (const row of [...targets, ...departing]) {
        const key = documentKey(row), block = current?.blocked(row);
        if (block === undefined) {refused.delete(key); continue;}
        if (refused.has(key)) continue;
        refused.add(key);
        const store = `Its store is kept at ${join(root, storeName(row))}.`;
        // Until the session host can start a document's Y.Doc itself (#2069), a device must.
        // Until a stopped document can resume from its owner's current file (#2103), one edited while stopped cannot.
        options.onError?.(new Error(block === "without-lineage"
          ? `Live editing of ${row.path} in workspace ${row.workspaceId} cannot start: the document has no live-editing history. It starts once its owner opens it in dohc on a desktop. ${store}`
          : block === "live-edit-unadmitted"
            ? `Live editing of ${row.path} in workspace ${row.workspaceId} cannot resume: the document changed while live editing was off, and the session host's copy is missing that edit. Its owner can keep editing it in dohc. ${store}`
            : `Live editing of ${row.path} in workspace ${row.workspaceId} stopped until its owner tries again. ${store}`));
      }
      // A workspace with no documents detaches once its replica drained, then
      // releases its enrollments. Its store stays, so a document shared again
      // resumes there. A failure between steps leaves them undrained, so the next start drains again.
      for (const workspaceId of new Set(departing.map(row => row.workspaceId))) {
        if (!current || targets.some(row => row.workspaceId === workspaceId) || !(await current.detachDrained(workspaceId, signal))) continue;
        // A release that fails keeps its row selected, so the next update attaches the workspace again.
        signature = "";
        for (const row of departing) if (row.workspaceId === workspaceId) leave(row);
      }
      lastError = undefined; initialReconciliationComplete = true;
    } catch (error) {
      if (!signal.aborted) {lastError = error; options.onError?.(error);}
    } finally {
      // A failed update or one damaged row does not hold back the others.
      if (selected && !signal.aborted) {
        for (const row of selected.obsolete) leave(row);
        // A sibling document keeps its workspace attached, so its replica confirms each departed document gone.
        for (const row of selected.departing) {
          if (selected.targets.some(target => target.workspaceId === row.workspaceId) && current?.retains(row) === false) leave(row);
        }
        // Once every retired document on the page left or stayed through a pull
        // after it departed, the next page gets its turn, so documents that
        // stay cannot keep the ones after them from leaving.
        const page = [...selected.departing, ...selected.obsolete].filter(row => row.retired);
        if ((selected.nextCursor || retiredCursor) && page.every(row =>
          left.has(documentKey(row)) || current?.pulledAfterDeparture(row))) {
          retiredCursor = selected.nextCursor ?? undefined;
          schedule();
        }
      }
    }
  }
  // Reconciliations and account deletions take turns, so no reconciliation
  // writes a store or a marker while a deletion removes it.
  let turn: Promise<void> = Promise.resolve();
  const exclusive = (work: () => Promise<void>) => {
    const run = turn.then(work);
    turn = run.catch(() => {});
    return run;
  };
  const finished = Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.succeed(changes), Queue.shutdown);
    yield* Effect.acquireRelease(
      Effect.sync(() => observeRelayWrites(storage, () => {writeGeneration++; schedule();})),
      stopWatching => Effect.gen(function* () {
        stopWatching();
        // After any start a recovery read began outside reconciliation.
        yield* Effect.promise(() => exclusive(stopCurrent));
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
      yield* Effect.uninterruptible(Effect.promise(() => exclusive(reconcile)));
    }
  })), {signal});
  return {
    current: () => current,
    /**
     * Removes the hosted stores of a deleted account's workspaces, diverged
     * or drained ones included, with their markers. The running daemon first
     * detaches each workspace without settling it. The account fence keeps
     * them out of every later selection, so nothing attaches them again.
     */
    async deleteWorkspaces(workspaces: readonly WorkspaceIdentity[]) {
      await exclusive(async () => {
        // The daemon's membership changes under the last update, so the next reconciliation updates again.
        signature = "";
        try {
          await current?.deleteWorkspaces([...new Set(workspaces.map(row => row.workspaceId))]);
          for (const row of workspaces) {diverged.delete(storeName(row)); unmarked.delete(storeName(row));}
          await deleteSelfHostedWorkspaceRoots(root, history.namespace, workspaces);
        } finally {schedule();}
      });
    },
    ready(document: LiveDocumentKey) {return current?.isDocumentReady(document) ?? false;},
    /** Why the running daemon cannot continue the document until its owner tries again, if it cannot. */
    blocked(document: {workspaceId: string; objectId: string}) {return current?.blocked(document);},
    /** The first-open refusal the owner sees for a document's current source, if the running daemon holds one. */
    firstOpenRefusal(document: {workspaceId: string; objectId: string}, source: () => FirstOpenSourceIdentity | undefined) {
      return current?.firstOpenRefusal(document, source);
    },
    /** Why the running daemon's hosted pass left this document held. */
    holdReason(document: {workspaceId: string; objectId: string}) {return current?.holdReason(document);},
    /** Whether the enrolled document's hosted replica diverged from the relay. Nothing continues it. */
    diverged(row: Pick<ServiceHostEnrollment, "workspaceId" | "replicationEpoch" | "streamIdentity">) {return diverged.has(storeName(row));},
    /** Whether this host cannot continue the document: it is blocked, or its workspace's current hosted replica diverged. */
    stopped(document: {workspaceId: string; objectId: string}) {
      const identity = storage.getWorkspaceIdentity(document.workspaceId);
      return current?.blocked(document) !== undefined || (!!identity && diverged.has(storeName({workspaceId: document.workspaceId, ...identity})));
    },
    /** Lets a blocked document try once more. Returns whether it was blocked. Its next block is reported again. */
    unblock(document: {workspaceId: string; objectId: string}) {
      const unblocked = current?.unblock(document) ?? false;
      if (unblocked) refused.delete(documentKey(document));
      return unblocked;
    },
    /**
     * The running daemon's page reads and Try again of refused queues it keeps
     * for their owners, and its release of an earlier store once the owner
     * has a recovery copy of every refusal kept there. The row's workspace
     * identity names the store that holds its queue, whatever identity the
     * workspace has now.
     */
    keptEdits: {
      // A recovery read starts the daemon if none runs, as after an identity
      // change left only earlier stores. It takes a turn, so no other start
      // runs beside it, and the next reconciliation keeps it.
      async page(kept: ServiceKeptEdits, cursor: JsonValue | undefined, callerSignal?: AbortSignal) {
        let host = current;
        if (!host) await exclusive(async () => {signal.throwIfAborted(); host = current ??= await start();});
        if (!host) throw new Error("This server does not hold the workspace's live documents now.");
        return host.readKeptEditsPage(kept, cursor, join(root, storeName({workspaceId: kept.workspaceId, ...kept.identity})), callerSignal);
      },
      async retry(kept: ServiceKeptEdits, guard: () => void, signal?: AbortSignal) {return current ? current.retryKeptEdits(kept, guard, signal) : "unavailable" as const;},
      async copied(kept: ServiceKeptEdits) {await current?.releaseKeptEditsStore(kept);},
    },
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
