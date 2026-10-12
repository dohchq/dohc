import {createHash} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {realpathSync, statSync} from "node:fs";
import {isAbsolute, join, posix, resolve} from "node:path";
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
  // The enrollment whose credential each attached workspace replicates with.
  const credentials = new Map<string, string>();
  const lifetime = new AbortController();
  const eventHandlers = new Set<(event: Event) => void>();
  const signal = AbortSignal.any([lifetime.signal, storage.unavailable]);
  const changes = Effect.runSync(Queue.sliding<void>(1));
  const valid = (row: ServiceHostEnrollment) => row.enabled && storage.workspaceIsOwnedBy(row.workspaceId, row.ownerUserId) &&
    storage.verifyWorkspaceIdentity(row) === "matched" && storage.objectIdAtPathInVersion({workspaceId: row.workspaceId, versionId: "main", path: row.path}) === row.objectId;
  // A document is hosted only while an active Edit grant covers it.
  const selection = () => storage.listServiceHostEnrollments().filter(row => valid(row) && storage.serviceHostEnrollmentHasEditGrant(row));
  const selectionSignature = (rows: readonly ServiceHostEnrollment[]) => JSON.stringify(rows.map(({workspaceId, objectId, path, shareId, ownerUserId, replicationEpoch, streamIdentity, credentialNonce}) =>
    ({workspaceId, objectId, path, shareId, ownerUserId, replicationEpoch, streamIdentity, credentialNonce})));
  function schedule() {
    if (!signal.aborted) Queue.offerUnsafe(changes, undefined);
  }
  async function stopCurrent() {
    const previous = current; current = undefined;
    if (previous) await previous.close();
  }
  async function hostedSet(rows: readonly ServiceHostEnrollment[]): Promise<ServiceHostedSet> {
    const grouped = new Map<string, ServiceHostEnrollment[]>();
    for (const row of rows) grouped.set(row.workspaceId, [...grouped.get(row.workspaceId) ?? [], row]);
    const workspaces = [], chosen = new Map<string, string>();
    for (const [workspaceId, documents] of grouped) {
      // Another credential attaches the workspace again, so keep the current one while its enrollment stays hosted.
      const row = documents.find(document => document.objectId === credentials.get(workspaceId)) ?? documents[0]!;
      chosen.set(workspaceId, row.objectId);
      const directory = join(root, createHash("sha256").update(JSON.stringify([history.namespace, row.workspaceId, row.replicationEpoch, row.streamIdentity])).digest("hex"));
      await mkdir(directory, {recursive: true, mode: 0o700});
      workspaces.push({root: canonicalPath(directory, true), workspaceId, maxRegistrations: 64,
        ordinaryReplication: {relay: {baseUrl: relay.origin, bearerToken: deriveServiceHostBearer(row, {key: options.key, namespace: history.namespace})},
          identity: {kind: "join" as const, replicationEpoch: row.replicationEpoch, streamIdentity: row.streamIdentity}, maxPagesPerPull: 8}});
    }
    credentials.clear();
    for (const [workspaceId, objectId] of chosen) credentials.set(workspaceId, objectId);
    return {workspaces, documents: rows.map(({workspaceId, objectId, path, shareId}) => ({workspaceId, objectId, path, shareId}))};
  }
  async function start(): Promise<Host> {
    const temporary = await mkdtemp(join(tmpdir(), "dohc-self-host-config-"));
    try {
      const configPath = join(temporary, "service.json");
      // The daemon starts empty. Each update attaches and detaches its workspaces and documents.
      await writeFile(configPath, JSON.stringify({version: 1, engineExecutable, hostId, instanceId, workspaces: [],
        ...profile.service, activation: {...profile.service.activation, targets: []}}), {flag: "wx", mode: 0o600});
      signal.throwIfAborted();
      const host = await (options.startHost ?? startServiceLiveHost)({configPath, storage, history, frameChanges: options.frameChanges, signal});
      host.onEvent((event) => { for (const handler of eventHandlers) handler(event); });
      host.invalidated.addEventListener("abort", schedule, {once: true});
      return host;
    } finally {await rm(temporary, {recursive: true, force: true});}
  }
  async function reconcile() {
    try {
      signal.throwIfAborted();
      if (discoveryCursor || scannedGeneration !== writeGeneration) {
        if (!discoveryCursor) scanGeneration = writeGeneration;
        discoveryCursor = discoverServiceHostDocuments(storage, options.onError, discoveryCursor) ?? undefined;
        if (!discoveryCursor) scannedGeneration = scanGeneration;
      }
      const enrolled = storage.listServiceHostEnrollments();
      const covered = enrolled.filter(row => storage.serviceHostEnrollmentHasEditGrant(row));
      const rows = covered.filter(valid), next = selectionSignature(rows);
      selectedDocuments = rows.length > 0;
      // Only a failed daemon restarts. Membership changes update the running one.
      if (current?.invalidated.aborted) {await stopCurrent(); signature = "";}
      let retiring: readonly {workspaceId: string; objectId: string}[] = [];
      if (next !== signature || (rows.length > 0 && !current)) {
        const desired = await hostedSet(rows);
        signal.throwIfAborted();
        if (next !== selectionSignature(selection())) {schedule(); return;}
        if (!current && rows.length > 0) current = await start();
        if (current) retiring = await current.update(desired);
        // A document still settling keeps the selection open, so the next reconciliation retries its unload.
        signature = retiring.length ? "" : next;
      }
      // Revoking the last Edit grant retires the enrollment once the host no longer holds the document.
      for (const row of enrolled) {
        if (!covered.includes(row) && !retiring.some(document => document.workspaceId === row.workspaceId && document.objectId === row.objectId)) {
          storage.retireUncoveredServiceHostEnrollment({workspaceId: row.workspaceId, objectId: row.objectId, nowMs: Date.now()});
        }
      }
      lastError = undefined; initialReconciliationComplete = true;
    } catch (error) {
      if (!signal.aborted) {lastError = error; options.onError?.(error);}
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
      for (const row of selection()) {
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
