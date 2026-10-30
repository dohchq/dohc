import {mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile} from "node:fs/promises";
import {existsSync, realpathSync} from "node:fs";
import {createHash} from "node:crypto";
import {basename, dirname, join} from "node:path";
import {tmpdir} from "node:os";
import {afterEach, expect, it, vi} from "vitest";
import {startSelfHostedLiveHost, deleteSelfHostedWorkspaceRoots} from "./selfHostedLiveHost";
import {createServiceHostEnrollmentRoutes} from "./serviceHostEnrollmentRoutes";
import {fenceAccount, initializeAccountDeletion} from "./storage/accountDeletion";
import type {ServiceHostedSet} from "./serviceLiveHost";
import type {ServiceKeptEdits} from "./storage/serviceKeptEdits";
import type {ServiceActivationBlock} from "./serviceActivationDriver";
import type {ServiceHostedHold} from "./serviceHostedReplication";
import {fixture as ticketFixture, binding, scope, retainServiceActivation} from "./liveTickets.test-helper";
import {createLiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import {createNamedFrameChanges} from "./liveHostChanges";
import {hasRelayWriteObservers, notifyRelayWrite} from "./relayWriteChanges";
import {serviceHostDocumentEnabled, SERVICE_HOST_MAX_WORKSPACES} from "./storage/serviceHostEnrollment";
import type {StorageContext} from "./storage/context";

// While `error` is set, opening a divergence marker fails, as on a full disk.
// While `hold` is set, opening one waits for its release. `synced` counts the flushes of marker files.
const markerFailure = vi.hoisted(() => ({error: undefined as Error | undefined, synced: 0,
  hold: undefined as {entered(): void; release: Promise<void>} | undefined}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (!String(args[0]).endsWith(".diverged")) return actual.open(...args);
    const hold = markerFailure.hold;
    if (hold) {markerFailure.hold = undefined; hold.entered(); await hold.release;}
    if (markerFailure.error) throw markerFailure.error;
    const handle = await actual.open(...args), sync = handle.sync.bind(handle);
    return Object.assign(handle, {sync: async () => {await sync(); markerFailure.synced++;}});
  }};
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {Object.assign(markerFailure, {error: undefined, synced: 0, hold: undefined}); vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close();});
type Configuration = {workspaces: unknown[]; activation: {targets: unknown[]}; hostId: string; instanceId: string};
type Hosted = ServiceHostedSet["documents"][number];
type Workspace = ServiceHostedSet["workspaces"][number];
type Document = {workspaceId: string; objectId: string};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
const bearer = (workspace: Workspace) => workspace.hostedReplication!.relay.bearerToken;
const namespace = "supervisor-history";
// The store a workspace identity's hosted replica lives in.
const storeName = (workspaceId: string, replicationEpoch = "epoch", streamIdentity = "stream") =>
  createHash("sha256").update(JSON.stringify(["hosted-v1", namespace, workspaceId, replicationEpoch, streamIdentity])).digest("hex");

async function fixture(options: {beforeStart?(): Promise<void>; empty?: boolean; unavailable?: AbortSignal; pending?: string[];
  seed?(data: string, relay: Awaited<ReturnType<typeof ticketFixture>>): Promise<void>} = {}) {
  const f = await ticketFixture(); cleanup.push(f.close);
  if (options.unavailable) vi.spyOn(f.storage, "unavailable", "get").mockReturnValue(options.unavailable);
  // The ticket fixture provisions a device; this supervisor test starts a clean service deployment.
  f.raw.exec("DELETE FROM sync_relay_session_host_control");
  f.storage.claimWorkspaceIdentity({workspaceId: scope.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
  const root = await mkdtemp(join(tmpdir(), "dohc-self-host-supervisor-")); const data = join(root, "data"); await mkdir(data);
  cleanup.push(() => rm(root, {recursive: true, force: true}));
  const input = {workspaceId: scope.workspaceId, ownerUserId: "owner-1", shareId: scope.shareId, path: binding.currentPath, nowMs: 10, guard() {}};
  const enrolled = f.storage.enrollServiceHostDocument(input);
  if (options.empty) {
    f.storage.setServiceHostEnrollmentEnabled({...input, enabled: false});
    f.storage.releaseServiceHostEnrollment({workspaceId: enrolled.workspaceId, objectId: enrolled.objectId, nowMs: 10});
  }
  await options.seed?.(data, f);
  const history = createLiveJournalHistoryAuthority({namespace, reconciled: true});
  const frameChanges = createNamedFrameChanges(8);
  // A stand-in for the service host: it records each membership update, keeps
  // each wanted workspace attached, and, like a hosted replica, keeps a
  // departed document until its retirement stops being pending. A workspace
  // with no documents drains once nothing of it is pending.
  const pending = new Set<string>(options.pending), updates: ServiceHostedSet[] = [], attachedAfter: string[][] = [], events: string[] = [];
  // Documents the running host cannot continue until their owner tries again, with why.
  const blocked = new Map<string, ServiceActivationBlock>();
  const holdReasons = new Map<string, ServiceHostedHold["reason"]>();
  const refusal = new Error("Workspace attach refused.");
  let failUpdate: Error | undefined, refusedPath: string | undefined, holdUpdate: {entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>} | undefined;
  let running: {holds(document: Document): boolean; diverge(workspaceId: string, detached: boolean): void; attached: Map<string, string>} | undefined;
  const starts: Array<{config: Configuration; configPath: string; close: ReturnType<typeof vi.fn<() => Promise<void>>>; controller: AbortController}> = [];
  // Each page read of a kept queue, with the store it names.
  const keptReads: Array<{outboxId: string; store: string}> = [];
  let live = 0, peak = 0;
  const startHost = vi.fn(async ({configPath}: {configPath: string}) => {
    await options.beforeStart?.();
    const config = JSON.parse(await readFile(configPath, "utf8")) as Configuration;
    const controller = new AbortController(); let stopped = false, held: Hosted[] = [];
    const attached = new Map<string, string>(), diverged = new Map<string, string>();
    const close = vi.fn(async () => {if (!stopped) {stopped = true; live--; controller.abort();}});
    live++; peak = Math.max(peak, live); starts.push({config, configPath, close, controller});
    const update = vi.fn(async (desired: ServiceHostedSet) => {
      const hold = holdUpdate; holdUpdate = undefined;
      if (hold) {hold.entered.resolve(); await hold.release.promise;}
      if (failUpdate) {const failure = failUpdate; failUpdate = undefined; throw failure;}
      // The engine opens one handle for each workspace and refuses the 65th.
      if (desired.workspaces.length > 64) throw new Error("workspace handle limit reached");
      held = [...desired.documents];
      for (const workspaceId of [...attached.keys()]) if (!desired.workspaces.some(row => row.workspaceId === workspaceId)) attached.delete(workspaceId);
      for (const workspace of desired.workspaces) if (!diverged.has(workspace.workspaceId)) attached.set(workspace.workspaceId, workspace.root);
      if (desired.documents.some(row => row.path === refusedPath)) throw refusal;
      updates.push(desired);
      attachedAfter.push([...attached.keys()]);
      frameChanges.notifyHost([...attached.keys()]);
    });
    const isDocumentReady = (document: Document) =>
      updates.at(-1)?.documents.some(row => row.workspaceId === document.workspaceId && row.objectId === document.objectId) ?? false;
    const holds = (document: Document) => held.some(row => row.workspaceId === document.workspaceId && row.objectId === document.objectId);
    const retains = (document: Document) => holds(document) || !attached.has(document.workspaceId) || pending.has(document.objectId);
    const drained = (workspaceId: string) => attached.has(workspaceId) && !held.some(row => row.workspaceId === workspaceId) &&
      !(updates.at(-1)?.departing ?? []).some(row => row.workspaceId === workspaceId && pending.has(row.objectId));
    const detachDrained = vi.fn(async (workspaceId: string) => {
      if (!drained(workspaceId)) return false;
      attached.delete(workspaceId); events.push(`detach ${workspaceId}`);
      return true;
    });
    // Detaches at once, settling nothing. The supervisor removes the stores.
    const deleteWorkspaces = vi.fn(async (workspaceIds: readonly string[]) => {
      for (const workspaceId of workspaceIds) {
        events.push(`delete ${workspaceId} store=${existsSync(join(data, storeName(workspaceId)))}`);
        attached.delete(workspaceId); diverged.delete(workspaceId); held = held.filter(row => row.workspaceId !== workspaceId);
      }
    });
    // A failed detach leaves the diverged workspace attached.
    running = {holds, attached, diverge(workspaceId, detached) {
      diverged.set(workspaceId, attached.get(workspaceId)!);
      if (detached) {attached.delete(workspaceId); held = held.filter(row => row.workspaceId !== workspaceId);}
    }};
    // Its replica had its chance to retire the document once it is attached and no longer hosts it.
    const pulledAfterDeparture = (document: Document) => attached.has(document.workspaceId) && !holds(document);
    const readKeptEditsPage = async (kept: ServiceKeptEdits, _cursor: unknown, store: string) => {keptReads.push({outboxId: kept.outboxId, store}); return {kind: "page"};};
    return {invalidated: controller.signal, close, update, deleteWorkspaces, retains, pulledAfterDeparture, drained, detachDrained, isDocumentReady, readKeptEditsPage, onEvent: () => () => undefined,
      blocked: (document: Document) => holds(document) ? blocked.get(document.objectId) : undefined,
      holdReason: (document: Document) => holds(document) ? holdReasons.get(document.objectId) : undefined,
      unblock: (document: Document) => holds(document) && blocked.delete(document.objectId),
      diverged: () => [...diverged].map(([workspaceId, root]) => ({workspaceId, root}))} as never;
  });
  const onError = vi.fn();
  // Records what the store and attachment looked like at each release.
  const release = f.storage.releaseServiceHostEnrollment.bind(f.storage);
  vi.spyOn(f.storage, "releaseServiceHostEnrollment").mockImplementation(input => {
    events.push(`release ${input.objectId} attached=${running?.attached.has(input.workspaceId) ?? false} store=${existsSync(join(data, storeName(input.workspaceId)))}`);
    return release(input);
  });
  const host = await startSelfHostedLiveHost({trustedAccount: (accountId: string) => ({accountId, name: "Owner name"}), storage: f.storage, history, root: data, engineExecutable: process.execPath,
    relayOrigin: "https://relay.test", key: new Uint8Array(32).fill(9), frameChanges, startHost, onError});
  cleanup.push(() => host.close());
  // The supervisor reconciles on timers and writes configuration files; a loaded
  // gate host can take seconds for either.
  const waitStarted = async (count: number) => vi.waitFor(() => {expect(onError).not.toHaveBeenCalled(); expect(starts).toHaveLength(count);}, {timeout: 10_000});
  const waitUpdate = async (paths: string[]) => vi.waitFor(() => {
    expect(onError).not.toHaveBeenCalled();
    expect(updates.at(-1)?.documents.map(row => row.path)).toEqual(paths);
    return updates.at(-1)!;
  }, {timeout: 10_000});
  // Waits for a few more reconciliations, which find nothing new to do.
  const waitPasses = async () => {
    const passes = vi.spyOn(f.storage, "listUndrainedServiceHostEnrollments");
    await vi.waitFor(() => {host.reconcile(); expect(passes.mock.calls.length).toBeGreaterThanOrEqual(3);}, {timeout: 10_000});
    passes.mockRestore();
  };
  const moment = (path: string, objectId: string, workspaceId = scope.workspaceId) => f.raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
    VALUES (?,?,1,?,'main',?,?,'text',1,1)`).run(workspaceId, objectId, `moment-${objectId}`, path, "b".repeat(64));
  const add = (path = "docs/b.md", objectId = "object-b", shareId = scope.shareId) => {
    moment(path, objectId);
    return f.storage.enrollServiceHostDocument({...input, path, shareId});
  };
  const share = (shareId: string, paths: string[], options: {workspaceId?: string; ownerUserId?: string; grantId?: string} = {}) => {
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,?,?,1)")
      .run(shareId, options.workspaceId ?? scope.workspaceId, options.ownerUserId ?? "owner-1", JSON.stringify({paths, versionId: null}));
    f.raw.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES (?,?,'user','editor',NULL,'edit',1,'active',1,NULL,NULL)`).run(options.grantId ?? `${shareId}-edit`, shareId);
  };
  const enrollment = (path = binding.currentPath) => f.storage.readServiceHostEnrollment(scope.workspaceId, path);
  // Fences the owner's account for deletion, as the deletion route does first, and returns what it deletes.
  const fence = (ownerUserId = "owner-1") => {
    initializeAccountDeletion(f.storage as StorageContext, "fence-key");
    return fenceAccount(f.storage as StorageContext, "fence-key", ownerUserId, `${ownerUserId}@dohc.test`).manifest!;
  };
  return {...f, host, history, data, starts, startHost, input, add, share, moment, waitStarted, waitUpdate, waitPasses, onError, frameChanges, updates, pending, attachedAfter, enrollment, events, fence, keptReads,
    refusal, peak: () => peak, failNextUpdate(error: Error) {failUpdate = error;},
    /** Refuses every update that wants the path. */
    refuseAttach(path: string | undefined) {refusedPath = path;},
    holds: (objectId: string, workspaceId = scope.workspaceId) => running?.holds({workspaceId, objectId}) ?? false,
    diverge: (workspaceId = scope.workspaceId, detached = true) => running!.diverge(workspaceId, detached),
    block(objectId: string, why: ServiceActivationBlock = "refused") {blocked.set(objectId, why);}, unblock(objectId: string) {blocked.delete(objectId);},
    hold(objectId: string, reason: ServiceHostedHold["reason"] | undefined) {if (reason) holdReasons.set(objectId, reason); else holdReasons.delete(objectId);},
    holdNextUpdate() {holdUpdate = {entered: deferred(), release: deferred()}; return holdUpdate;}};
}

it("wakes waiting desktop listeners after publishing the returning service host", async () => {
  const entered = deferred(), finish = deferred();
  const f = await fixture({beforeStart: async () => {entered.resolve(); await finish.promise;}});
  await entered.promise;
  const ready = deferred(), changed = vi.fn(() => {
    const available = f.host.ready(binding);
    ready.resolve();
    return available;
  });
  const remove = f.frameChanges.subscribe(changed, {workspaceId: binding.workspaceId, objectId: binding.objectId});
  try {
    expect(changed).not.toHaveBeenCalled();
    finish.resolve(); await ready.promise;
    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.results[0]!.value).toBe(true);
  } finally {finish.resolve(); remove();}
});

it("names a workspace for automations only while a live-shared document sits in a Collection with automations", async () => {
  const f = await fixture();
  expect(f.host.automationWorkspaces(), "docs has no automations file").toEqual([]);
  f.raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
    VALUES (?,'object-automations',2,'moment-automations','main','docs/automations.yaml',?,'text',1,1)`).run(scope.workspaceId, "c".repeat(64));
  expect(f.host.automationWorkspaces()).toEqual([scope.workspaceId]);
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  expect(f.host.automationWorkspaces(), "a document the host no longer holds").toEqual([]);
});

it("stays unavailable until retained documents have a running native host", async () => {
  const entered = deferred(), finish = deferred();
  const f = await fixture({beforeStart: async () => {entered.resolve(); await finish.promise;}});
  expect(f.host.unavailable).toBe(true);
  try {
    await entered.promise;
    expect(f.host.current()).toBeUndefined();
    expect(f.host.unavailable).toBe(true);
  } finally {finish.resolve();}
  await vi.waitFor(() => expect(f.host.unavailable).toBe(false), {timeout: 10_000});
  expect(f.host.current()).toBeDefined();
  f.starts[0]!.controller.abort();
  expect(f.host.unavailable).toBe(true);
});

it.each(["not running", "stopped"] as const)("answers Stop with the session host state %s without fencing", async state => {
  const entered = deferred(), finish = deferred();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture(state === "not running" ? {beforeStart: async () => {entered.resolve(); await finish.promise;}} : {});
  try {
    if (state === "not running") await entered.promise;
    else {await f.waitStarted(1); f.starts[0]!.controller.abort();}
    retainServiceActivation(f.raw, namespace, true);
    const routes = createServiceHostEnrollmentRoutes({storage: f.storage, history: f.history, host: f.host,
      resolveActor: async () => ({workspaceId: scope.workspaceId, userId: "owner-1"})});
    const response = await routes(new Request(`https://relay.test/sync/${scope.workspaceId}/live-host`, {method: "DELETE",
      headers: {"content-type": "application/json", authorization: "Bearer account-token"}, body: JSON.stringify({path: binding.currentPath, retire: true})}));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ok: false, code: state === "not running" ? "host-offline" : "host-not-loaded", sessionHost: state,
      error: state === "not running"
        ? "Live editing didn't stop. The server's session host is offline and may hold recent edits. Try again once it's back, or contact the server's operator."
        : "Live editing didn't stop. The server's session host hasn't loaded this document yet and may hold recent edits. Try again in a moment."});
    expect(f.enrollment()).toMatchObject({enabled: true, retired: false, ownerStop: null});
    expect(f.storage.serviceActivationRetirement(binding)).toBeNull();
    expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(true);
    expect(log.mock.calls.filter(([line]) => String(line).includes("Session host:"))).toEqual([
      [`Live editing Stop for workspace ${scope.workspaceId}, object ${binding.objectId}. Session host: ${state}`],
    ]);
  } finally {finish.resolve(); if (state === "not running") await f.waitStarted(1);}
});

it("restarts only a daemon that failed and gives the replacement the whole hosted set", async () => {
  const f = await fixture(); f.add(); await f.waitStarted(1);
  await f.waitUpdate(["docs/a.md", "docs/b.md"]);
  f.starts[0]!.controller.abort();
  await f.waitStarted(2);
  await vi.waitFor(() => expect(f.updates).toHaveLength(2), {timeout: 10_000});
  expect(f.updates[1]).toEqual(f.updates[0]);
  expect(f.starts[0]!.close).toHaveBeenCalledTimes(1); expect(f.peak()).toBe(1);
});

it("becomes available after reconciling an empty deployment without starting a daemon", async () => {
  const f = await fixture({empty: true});
  expect(f.host.unavailable).toBe(true);
  await vi.waitFor(() => expect(f.host.unavailable).toBe(false), {timeout: 10_000});
  expect(f.startHost).not.toHaveBeenCalled();
});

// Proves: an owner's recovery read starts the daemon when none runs, as after
// an identity change left only earlier stores. Reads at once start one daemon,
// each reads the store its row's identity names, not the workspace's current
// store, and later reconciliations keep that daemon.
it("starts its daemon for a recovery read while it hosts nothing, and reads the store of the row's identity", async () => {
  const f = await fixture({empty: true});
  await vi.waitFor(() => expect(f.host.unavailable).toBe(false), {timeout: 10_000});
  const identity = {replicationEpoch: "epoch", streamIdentity: "stream"};
  f.storage.recordServiceKeptEdits({identity, outboxId: "outbox", binding, reason: "invalid-update", headDeliveryId: "delivery", refusalKey: "refusal", nowMs: 1});
  expect(f.storage.rotateWorkspaceIdentity({workspaceId: scope.workspaceId, ownerUserId: "owner-1", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 20})).toBe("rotated");
  const kept = f.storage.readServiceKeptEdits({workspaceId: scope.workspaceId, identity, outboxId: "outbox"})!;
  expect(f.startHost).not.toHaveBeenCalled();
  await expect(Promise.all([f.host.keptEdits.page(kept, undefined), f.host.keptEdits.page(kept, undefined)])).resolves.toEqual([{kind: "page"}, {kind: "page"}]);
  expect(f.startHost).toHaveBeenCalledOnce();
  expect(f.keptReads).toEqual([{outboxId: "outbox", store: join(f.data, storeName(scope.workspaceId))}, {outboxId: "outbox", store: join(f.data, storeName(scope.workspaceId))}]);
  expect(f.keptReads[0]!.store).not.toBe(join(f.data, storeName(scope.workspaceId, "epoch-2", "stream-2")));
  await f.waitPasses();
  expect(f.startHost).toHaveBeenCalledOnce();
  expect(f.starts[0]!.close).not.toHaveBeenCalled();
});

it("starts one empty daemon and attaches the first shared document's workspace to a hosted replica", async () => {
  const f = await fixture(); expect(f.host.unavailable).toBe(true); await f.waitStarted(1);
  const first = await f.waitUpdate(["docs/a.md"]), {config} = f.starts[0]!;
  expect(config.workspaces).toEqual([]); expect(config.activation.targets).toEqual([]);
  expect(first.documents).toEqual([{workspaceId: scope.workspaceId, objectId: binding.objectId, path: "docs/a.md", shareId: scope.shareId}]);
  expect(first.departing).toEqual([]);
  expect(first.workspaces).toHaveLength(1);
  expect(basename(first.workspaces[0]!.root)).toBe(storeName(scope.workspaceId));
  expect(first.workspaces[0]!.hostedReplication).toMatchObject({identity: {replicationEpoch: "epoch", streamIdentity: "stream"},
    relay: {baseUrl: "https://relay.test"}});
  expect(bearer(first.workspaces[0]!)).toMatch(/^dohc-service-v1\./);
});

// The service host refuses a configuration path that resolves elsewhere, and
// macOS keeps its temporary folder behind a link.
it.skipIf(process.platform === "win32")("writes the daemon's configuration in the real temporary folder when TMPDIR is a link", async () => {
  const f = await fixture({empty: true});
  await vi.waitFor(() => expect(f.host.unavailable).toBe(false), {timeout: 10_000});
  const real = await mkdtemp(join(tmpdir(), "dohc-self-host-temp-")), linked = `${real}-link`;
  await symlink(real, linked);
  cleanup.push(async () => {vi.unstubAllEnvs(); await rm(linked, {force: true}); await rm(real, {recursive: true, force: true});});
  vi.stubEnv("TMPDIR", linked);
  f.add(); await f.waitStarted(1);
  expect(dirname(dirname(f.starts[0]!.configPath))).toBe(real);
});

// The daemon copies an earlier store for its owner's recovery copy under the
// store root, within the profile's preparation deadline.
it("names the store root for recovery copies in the daemon's configuration", async () => {
  const f = await fixture(); await f.waitStarted(1);
  expect((f.starts[0]!.config as unknown as {recovery: unknown}).recovery).toEqual({root: realpathSync(f.data), preparationDeadlineMs: 300_000});
});

it("adds and removes documents on the running daemon while the sibling stays hosted", async () => {
  const f = await fixture(); await f.waitStarted(1);
  const first = await f.waitUpdate(["docs/a.md"]);
  const second = f.add(); const added = await f.waitUpdate(["docs/a.md", "docs/b.md"]);
  expect(added.workspaces).toEqual(first.workspaces);
  f.storage.setServiceHostEnrollmentEnabled({...f.input, path: second.path, enabled: false});
  const removed = await f.waitUpdate(["docs/a.md"]);
  expect(removed.workspaces).toEqual(first.workspaces);
  await vi.waitFor(() => expect(f.enrollment(second.path)).toMatchObject({enabled: false, ownerStop: "pause"}), {timeout: 10_000});
  // It was released only after an update told the daemon it departed.
  expect(f.updates.map(update => update.departing)).toContainEqual([{workspaceId: scope.workspaceId, objectId: second.objectId, path: second.path, shareId: scope.shareId}]);
  expect(f.starts).toHaveLength(1); expect(f.starts[0]!.close).not.toHaveBeenCalled(); expect(f.peak()).toBe(1);
  expect(f.updates.every(update => update.documents.some(row => row.path === "docs/a.md"))).toBe(true);
});

it("keeps the workspace attachment unchanged when the document that first attached it leaves", async () => {
  const f = await fixture(); await f.waitStarted(1);
  const first = (await f.waitUpdate(["docs/a.md"])).workspaces;
  f.add("docs/0.md", "object-0");
  expect((await f.waitUpdate(["docs/0.md", "docs/a.md"])).workspaces).toEqual(first);
  // The credential belongs to the workspace, so its sibling keeps the same attachment.
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  expect((await f.waitUpdate(["docs/0.md"])).workspaces).toEqual(first);
  await vi.waitFor(() => expect(f.enrollment()).toMatchObject({enabled: false, ownerStop: "pause"}), {timeout: 10_000});
  expect(f.storage.currentServiceHostWorkspace(scope.workspaceId)).not.toBeNull();
  expect(f.starts).toHaveLength(1);
});

// Proves: a departed document is released only once its workspace's replica
// confirms it gone, while a sibling keeps the workspace attached.
it("keeps a paused document's binding until its replica retires it, then pauses it", async () => {
  const f = await fixture(); f.add(); await f.waitStarted(1);
  await f.waitUpdate(["docs/a.md", "docs/b.md"]);
  f.pending.add(binding.objectId);
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  await f.waitUpdate(["docs/b.md"]);
  await f.waitPasses();
  expect(f.enrollment()).toMatchObject({enabled: true, retired: false, ownerStop: "pause", hostDrainedAtMs: null});
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(true);
  f.pending.delete(binding.objectId);
  await vi.waitFor(() => expect(f.enrollment()).toMatchObject({enabled: false, retired: false, ownerStop: "pause"}), {timeout: 10_000});
  expect(f.enrollment()!.hostDrainedAtMs).not.toBeNull();
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(false);
  expect(f.updates.every(update => update.documents.some(row => row.path === "docs/b.md"))).toBe(true);
  expect(f.starts).toHaveLength(1); expect(f.starts[0]!.close).not.toHaveBeenCalled();
});

it("keeps a document hosted while any Edit grant covers it and retires it once its replica lets it go", async () => {
  const f = await fixture(); await f.waitStarted(1);
  f.share("share-overlap", ["docs"]); f.share("share-notes", ["notes"]);
  f.add("notes/c.md", "object-c", "share-notes");
  await f.waitUpdate(["docs/a.md", "notes/c.md"]);
  f.pending.add(binding.objectId);
  expect(f.storage.revokeShareGrant({shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 20}).ok).toBe(true);
  // This update follows the revocation; the overlapping share still covers docs/a.md.
  f.add("notes/d.md", "object-d", "share-notes");
  await f.waitUpdate(["docs/a.md", "notes/c.md", "notes/d.md"]);
  expect(f.storage.revokeShareGrant({shareId: "share-overlap", grantId: "share-overlap-edit", revokedAtMs: 21}).ok).toBe(true);
  await f.waitUpdate(["notes/c.md", "notes/d.md"]);
  // Its replica still holds it, so the enrollment stays.
  await f.waitPasses();
  expect(f.storage.listRetiredServiceHostEnrollments(scope.workspaceId).documents).toEqual([]);
  expect(f.storage.listServiceHostEnrollments(scope.workspaceId).map(row => row.path)).toContain("docs/a.md");
  f.pending.delete(binding.objectId);
  await vi.waitFor(() => expect(f.storage.listRetiredServiceHostEnrollments(scope.workspaceId).documents.map(row => row.path)).toEqual(["docs/a.md"]), {timeout: 10_000});
  expect(f.storage.listServiceHostEnrollments(scope.workspaceId).map(row => row.path)).toEqual(["notes/c.md", "notes/d.md"]);
  expect(f.starts).toHaveLength(1); expect(f.starts[0]!.close).not.toHaveBeenCalled();
  expect(f.updates.slice(1).every(update => update.documents.some(row => row.path === "notes/c.md"))).toBe(true);
});

// Proves: stopping a workspace's last document keeps the workspace attached
// until its replica drains, then detaches it and only then releases the
// enrollment. The store stays, and sharing the document again reopens it.
it("drains a stopped last document, then detaches the workspace and releases it, keeping its store", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  const store = join(f.data, storeName(scope.workspaceId));
  await writeFile(join(store, "replica.sqlite"), "hosted");
  f.pending.add(binding.objectId);
  const stopped = f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration});
  expect(stopped).toMatchObject({enabled: false, retired: true});
  const drainingSet = await f.waitUpdate([]);
  expect(drainingSet.workspaces.map(row => row.workspaceId)).toEqual([scope.workspaceId]);
  expect(drainingSet.departing).toEqual([{workspaceId: scope.workspaceId, objectId: binding.objectId, path: binding.currentPath, shareId: scope.shareId}]);
  await f.waitPasses();
  // Undrained, so the hosted credential and the store stay.
  expect(f.enrollment()!.hostDrainedAtMs).toBeNull();
  expect(f.storage.currentServiceHostWorkspace(scope.workspaceId, true)).not.toBeNull();
  expect(existsSync(store)).toBe(true);
  expect(f.events).toEqual([]);
  f.pending.delete(binding.objectId);
  await vi.waitFor(() => expect(f.enrollment()!.hostDrainedAtMs).not.toBeNull(), {timeout: 10_000});
  expect(f.events).toEqual([`detach ${scope.workspaceId}`, `release ${binding.objectId} attached=false store=true`]);
  expect(f.storage.currentServiceHostWorkspace(scope.workspaceId, true)).toBeNull();
  // The next reconciliation no longer wants the workspace.
  await vi.waitFor(() => expect(f.updates.at(-1)!.workspaces).toEqual([]), {timeout: 10_000});
  expect(await readFile(join(store, "replica.sqlite"), "utf8")).toBe("hosted");
  expect(f.host.current()).toBeDefined(); expect(f.starts[0]!.close).not.toHaveBeenCalled();
  // Shared again, the document's workspace attaches to the store it kept.
  f.storage.enrollServiceHostDocument(f.input);
  const returned = await f.waitUpdate(["docs/a.md"]);
  expect(returned.workspaces.map(row => basename(row.root))).toEqual([storeName(scope.workspaceId)]);
  expect(f.attachedAfter.at(-1)).toEqual([scope.workspaceId]);
  expect(await readdir(f.data)).toEqual([storeName(scope.workspaceId)]);
  expect(await readFile(join(store, "replica.sqlite"), "utf8")).toBe("hosted");
});

// Proves: a document its owner resumes before its stopped activation retired
// stays departing, so the host only retires that activation. Once the
// retirement closes, the document is hosted again, where its successor activates.
it("keeps a document resumed before its activation retired departing until that retirement closes", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  let open = true;
  const read = f.storage.serviceActivationRetirement.bind(f.storage);
  vi.spyOn(f.storage, "serviceActivationRetirement").mockImplementation(document => open && document.objectId === binding.objectId
    ? {relayDatabaseNamespace: namespace, activationId: `ordinary-activation-${"a".repeat(64)}`, workspaceId: scope.workspaceId, mainVersionId: "main",
      objectId: binding.objectId, lineageClaimId: binding.lineageClaimId, path: binding.currentPath, restoreFenceGeneration: 0, acceptedThrough: 0, requestedAtMs: 20}
    : read(document));
  f.pending.add(binding.objectId);
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration});
  await f.waitUpdate([]);
  f.storage.enrollServiceHostDocument({...f.input, nowMs: 40});
  await f.waitPasses();
  expect(f.enrollment()).toMatchObject({enabled: true, retired: false, ownerStop: null});
  expect(f.updates.at(-1)!.documents).toEqual([]);
  expect(f.updates.at(-1)!.departing.map(row => row.objectId)).toEqual([binding.objectId]);
  open = false;
  f.host.reconcile();
  await f.waitUpdate(["docs/a.md"]);
  expect(f.updates.at(-1)!.departing).toEqual([]);
});

it("retires the last document without stopping the daemon", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  expect(f.storage.revokeShareGrant({shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 20}).ok).toBe(true);
  await f.waitUpdate([]);
  await vi.waitFor(() => expect(f.storage.listRetiredServiceHostEnrollments(scope.workspaceId).documents.map(row => row.path)).toEqual(["docs/a.md"]), {timeout: 10_000});
  await vi.waitFor(() => expect(f.updates.at(-1)!.workspaces).toEqual([]), {timeout: 10_000});
  expect(f.host.current()).toBeDefined(); expect(f.starts[0]!.close).not.toHaveBeenCalled();
});

it("hosts a revoked document again for a new Edit share without Resume, but not one its owner paused", async () => {
  const f = await fixture(); f.add(); await f.waitStarted(1);
  await f.waitUpdate(["docs/a.md", "docs/b.md"]);
  f.storage.setServiceHostEnrollmentEnabled({...f.input, path: "docs/b.md", enabled: false});
  expect(f.storage.revokeShareGrant({shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 20}).ok).toBe(true);
  await f.waitUpdate([]);
  await vi.waitFor(() => expect(f.storage.listRetiredServiceHostEnrollments(scope.workspaceId).documents.map(row => row.path)).toEqual(["docs/a.md", "docs/b.md"]), {timeout: 10_000});
  // Discovery lists the share's current files.
  f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES (?,'owner',0,'moment.append','{}',1,1)").run(scope.workspaceId);
  for (const path of ["docs/a.md", "docs/b.md"]) f.raw.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,'text',1)").run(scope.workspaceId, path, "b".repeat(64));
  f.share("share-new", ["docs"]); notifyRelayWrite(f.storage);
  await f.waitUpdate(["docs/a.md"]);
  expect(f.enrollment()).toMatchObject({enabled: true, retired: false, ownerStop: null});
  expect(f.enrollment("docs/b.md")).toMatchObject({enabled: false, retired: true, ownerStop: "pause"});
  expect(f.starts).toHaveLength(1); expect(f.starts[0]!.close).not.toHaveBeenCalled();
});

it("keeps the running daemon when an update fails and retries the update", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  const failure = new Error("Workspace attach refused.");
  f.failNextUpdate(failure); f.add();
  await vi.waitFor(() => expect(f.onError).toHaveBeenCalledWith(failure), {timeout: 10_000});
  f.onError.mockClear();
  await f.waitUpdate(["docs/a.md", "docs/b.md"]);
  expect(f.starts[0]!.close).not.toHaveBeenCalled(); expect(f.starts).toHaveLength(1); expect(f.host.current()).toBeDefined();
});

it("hosts a document again after a failed update dropped it and the selection returned to its last success", async () => {
  const f = await fixture(); f.add(); await f.waitStarted(1);
  await f.waitUpdate(["docs/a.md", "docs/b.md"]);
  // One update drops the paused document, then its attach of docs/c.md is refused.
  f.pending.add(binding.objectId);
  f.refuseAttach("docs/c.md");
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  f.add("docs/c.md", "object-c");
  await vi.waitFor(() => expect(f.onError).toHaveBeenCalledWith(f.refusal), {timeout: 10_000});
  expect(f.holds(binding.objectId)).toBe(false);
  // The owner resumes docs/a.md and stops docs/c.md, so the hosted documents equal the last successful ones.
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: true});
  f.storage.setServiceHostEnrollmentEnabled({...f.input, path: "docs/c.md", enabled: false, retire: true});
  await vi.waitFor(() => expect(f.holds(binding.objectId)).toBe(true), {timeout: 10_000});
  expect(f.updates.at(-1)!.documents.map(row => row.path)).toEqual(["docs/a.md", "docs/b.md"]);
  expect(f.enrollment()).toMatchObject({enabled: true, ownerStop: null});
  expect(f.starts).toHaveLength(1);
});

it("releases a paused document while another workspace's attach stays refused", async () => {
  const f = await fixture(); f.add(); await f.waitStarted(1);
  await f.waitUpdate(["docs/a.md", "docs/b.md"]);
  const workspaceId = "workspace-2", ownerUserId = "owner-2", shareId = "share-2", path = "docs/other.md";
  f.storage.claimWorkspace({workspaceId, ownerUserId, createdAtMs: 1});
  f.storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch-2", streamIdentity: "stream-2"});
  f.share(shareId, ["docs"], {workspaceId, ownerUserId});
  f.moment(path, "second-owner-object", workspaceId);
  f.refuseAttach(path);
  f.storage.enrollServiceHostDocument({...f.input, workspaceId, ownerUserId, shareId, path});
  await vi.waitFor(() => expect(f.onError).toHaveBeenCalledWith(f.refusal), {timeout: 10_000});
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  // Every update still fails on the other workspace, but the paused document has left its replica.
  await vi.waitFor(() => expect(f.enrollment()).toMatchObject({enabled: false, ownerStop: "pause"}), {timeout: 10_000});
  expect(f.holds(binding.objectId)).toBe(false);
  expect(f.onError.mock.calls.every(([error]) => error === f.refusal)).toBe(true);
  expect(f.storage.readServiceHostEnrollment(workspaceId, path)).toMatchObject({enabled: true});
});

// Proves: a replica that cannot remove a departed document's file keeps it,
// a restarted daemon still has it, and the release waits until a retry succeeds.
it("releases nothing through a failed file removal and a restart until the removal succeeds", async () => {
  const f = await fixture(); f.add(); await f.waitStarted(1);
  await f.waitUpdate(["docs/a.md", "docs/b.md"]);
  f.pending.add(binding.objectId);
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  await f.waitUpdate(["docs/b.md"]);
  // The daemon fails while the paused document's file is still there.
  f.starts[0]!.controller.abort();
  await f.waitStarted(2);
  const restarted = await f.waitUpdate(["docs/b.md"]);
  // The document departs again on the replacement; it is not hosted there.
  expect(restarted.departing).toEqual([{workspaceId: scope.workspaceId, objectId: binding.objectId, path: binding.currentPath, shareId: scope.shareId}]);
  await f.waitPasses();
  expect(f.enrollment()).toMatchObject({enabled: true, ownerStop: "pause", hostDrainedAtMs: null});
  f.pending.delete(binding.objectId);
  await vi.waitFor(() => expect(f.enrollment()).toMatchObject({enabled: false, ownerStop: "pause"}), {timeout: 10_000});
  expect(f.updates.every(update => !update.documents.some(row => row.path === "docs/a.md") || update === f.updates[0])).toBe(true);
  expect(f.starts).toHaveLength(2);
});

it.each([false, true])("releases a paused document under an obsolete identity without waiting for its old replica (new documents at once: %s)", async newAtOnce => {
  const f = await fixture(); await f.waitStarted(1);
  const workspaceId = "workspace-2", ownerUserId = "owner-2", shareId = "share-2", path = "docs/other.md";
  f.storage.claimWorkspace({workspaceId, ownerUserId, createdAtMs: 1});
  f.storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch-2", streamIdentity: "stream-2"});
  f.share(shareId, ["docs"], {workspaceId, ownerUserId});
  f.moment(path, "second-owner-object", workspaceId);
  f.storage.enrollServiceHostDocument({...f.input, workspaceId, ownerUserId, shareId, path});
  const first = await f.waitUpdate(["docs/a.md", path]);
  f.pending.add(binding.objectId);
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  await f.waitUpdate([path]);
  expect(f.enrollment()).toMatchObject({enabled: true, ownerStop: "pause"});
  expect(f.storage.rotateWorkspaceIdentity({workspaceId: scope.workspaceId, ownerUserId: "owner-1", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 20})).toBe("rotated");
  if (newAtOnce) f.add();
  f.host.reconcile();
  // The old identity's replica is fenced, so the pause applies without it.
  await vi.waitFor(() => expect(f.enrollment()).toMatchObject({enabled: false, ownerStop: "pause"}), {timeout: 10_000});
  await f.waitUpdate(newAtOnce ? ["docs/b.md", path] : [path]);
  // Later passes find nothing to retry.
  const updates = f.updates.length;
  await f.waitPasses();
  expect(f.updates).toHaveLength(updates);
  if (!newAtOnce) {f.add(); await f.waitUpdate(["docs/b.md", path]);}
  const attached = f.updates.at(-1)!.workspaces;
  expect(attached.find(row => row.workspaceId === scope.workspaceId)!.hostedReplication!.identity)
    .toEqual({replicationEpoch: "epoch-2", streamIdentity: "stream-2"});
  // The sibling workspace keeps its attachment and document throughout.
  expect(attached.find(row => row.workspaceId === workspaceId)).toEqual(first.workspaces.find(row => row.workspaceId === workspaceId));
  expect(f.updates.slice(f.updates.indexOf(first)).every(update => update.documents.some(row => row.path === path))).toBe(true);
  expect(f.storage.readServiceHostEnrollment(workspaceId, path)).toMatchObject({enabled: true, ownerStop: null});
  expect(f.onError).not.toHaveBeenCalled();
  expect(f.starts).toHaveLength(1); expect(f.starts[0]!.close).not.toHaveBeenCalled();
});

// Proves: a diverged store stays where it is, untouched and reported once.
// Its workspace releases nothing and is not attached again on later passes or
// by a restarted daemon, while another workspace's changes still apply.
it("keeps a diverged store in place and its workspace detached across passes and daemon restarts", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  const store = join(f.data, storeName(scope.workspaceId));
  await writeFile(join(store, "replica.sqlite"), "unpublished work");
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  f.pending.add(binding.objectId);
  f.diverge();
  f.host.reconcile();
  const reported = expect.objectContaining({message: expect.stringMatching(/diverged from the relay.*stays detached.*store is kept at .+/)});
  await vi.waitFor(() => expect(f.onError).toHaveBeenCalledWith(reported), {timeout: 10_000});
  f.onError.mockClear();
  await f.waitPasses();
  const workspaceId = "workspace-2", ownerUserId = "owner-2", shareId = "share-2", path = "docs/other.md";
  f.storage.claimWorkspace({workspaceId, ownerUserId, createdAtMs: 1});
  f.storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch-2", streamIdentity: "stream-2"});
  f.share(shareId, ["docs"], {workspaceId, ownerUserId});
  f.moment(path, "second-owner-object", workspaceId);
  f.storage.enrollServiceHostDocument({...f.input, workspaceId, ownerUserId, shareId, path});
  await vi.waitFor(() => expect(f.attachedAfter.at(-1)).toEqual([workspaceId]), {timeout: 10_000});
  // A replacement daemon knows nothing of the divergence, and still gets only the other workspace.
  f.starts[0]!.controller.abort();
  await f.waitStarted(2);
  await vi.waitFor(() => expect(f.updates.at(-1)!.workspaces.map(row => row.workspaceId)).toEqual([workspaceId]), {timeout: 10_000});
  await f.waitPasses();
  expect(f.updates.at(-1)!.departing).toEqual([]);
  expect(f.attachedAfter.at(-1)).toEqual([workspaceId]);
  expect(f.onError).not.toHaveBeenCalled();
  expect(f.enrollment()).toMatchObject({enabled: true, ownerStop: "pause", hostDrainedAtMs: null});
  expect(f.events.filter(event => event.startsWith("release"))).toEqual([]);
  expect((await readdir(f.data)).sort()).toEqual([storeName(scope.workspaceId), `${storeName(scope.workspaceId)}.diverged`, storeName(workspaceId, "epoch-2", "stream-2")].sort());
  expect(await readdir(store)).toEqual(["replica.sqlite"]);
  expect(await readFile(join(store, "replica.sqlite"), "utf8")).toBe("unpublished work");
});

it("reports a held document without treating it as blocked or stopped", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  f.hold(binding.objectId, "hosted-conflict-parent-withheld");
  expect(f.host.holdReason(binding)).toBe("hosted-conflict-parent-withheld");
  expect(f.host.holdReason({...binding, objectId: "other"})).toBeUndefined();
  expect(f.host.blocked(binding)).toBeUndefined();
  expect(f.host.stopped(binding)).toBe(false);
  f.hold(binding.objectId, undefined);
  expect(f.host.holdReason(binding)).toBeUndefined();
});

// Proves: the operator learns where a blocked document's store is kept, once
// per block, and the document stays hosted. A new block after its owner's
// retry is reported again, even one before any reconciliation saw it unblocked.
it("reports a blocked document's store to the operator once per block", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  const reported = expect.objectContaining({message: expect.stringContaining(`docs/a.md in workspace ${scope.workspaceId} stopped until its owner tries again. Its store is kept at ${join(f.data, storeName(scope.workspaceId))}.`)});
  f.block(binding.objectId);
  await vi.waitFor(() => {f.host.reconcile(); expect(f.onError.mock.calls).toEqual([[reported]]);}, {timeout: 10_000});
  expect(f.host.blocked(binding)).toBe("refused");
  expect(f.host.stopped(binding)).toBe(true);
  await f.waitPasses();
  expect(f.onError).toHaveBeenCalledTimes(1);
  expect(f.updates.at(-1)!.documents.map(row => row.path)).toEqual(["docs/a.md"]);
  f.unblock(binding.objectId);
  await f.waitPasses();
  expect(f.host.blocked(binding)).toBeUndefined();
  expect(f.host.stopped(binding)).toBe(false);
  f.block(binding.objectId);
  await vi.waitFor(() => {f.host.reconcile(); expect(f.onError.mock.calls).toEqual([[reported], [reported]]);}, {timeout: 10_000});
  // Resume, and its one more capture blocks again before the next reconciliation.
  expect(f.host.unblock(binding)).toBe(true);
  f.block(binding.objectId);
  await vi.waitFor(() => {f.host.reconcile(); expect(f.onError.mock.calls).toEqual([[reported], [reported], [reported]]);}, {timeout: 10_000});
  expect(f.host.unblock({...binding, objectId: "object-other"})).toBe(false);
});

// Proves: a document with no Y.Doc lineage tells the operator, once, that its
// owner must open it on a desktop before it can start.
it("tells the operator a document without lineage must be opened on a desktop first", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  f.block(binding.objectId, "without-lineage");
  await vi.waitFor(() => {f.host.reconcile(); expect(f.onError).toHaveBeenCalled();}, {timeout: 10_000});
  expect(f.onError.mock.calls).toEqual([[expect.objectContaining({message: `Live editing of docs/a.md in workspace ${scope.workspaceId} cannot start: the document has no live-editing history. It starts once its owner opens it in dohc on a desktop. Its store is kept at ${join(f.data, storeName(scope.workspaceId))}.`})]]);
  expect(f.host.blocked(binding)).toBe("without-lineage");
  await f.waitPasses();
  expect(f.onError).toHaveBeenCalledTimes(1);
});

// Proves: a document whose host copy is missing an owner edit tells the
// operator, once, that it is held until its owner resumes it.
it("tells the operator a document missing an owner edit is held until its owner resumes it", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  f.block(binding.objectId, "live-edit-unadmitted");
  await vi.waitFor(() => {f.host.reconcile(); expect(f.onError).toHaveBeenCalled();}, {timeout: 10_000});
  expect(f.onError.mock.calls).toEqual([[expect.objectContaining({message: `Live editing of docs/a.md in workspace ${scope.workspaceId} is held: the session host hasn't applied an edit to the document. Its owner can resume live editing in dohc to try again. Its store is kept at ${join(f.data, storeName(scope.workspaceId))}.`})]]);
  expect(f.host.blocked(binding)).toBe("live-edit-unadmitted");
  await f.waitPasses();
  expect(f.onError).toHaveBeenCalledTimes(1);
});

// Proves: a divergence whose detach failed as its daemon exited keeps the
// store out of the replacement daemon, and is reported once.
it("keeps a diverged workspace whose detach failed out of the replacement daemon", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  const workspaceId = "workspace-2", ownerUserId = "owner-2", shareId = "share-2", path = "docs/other.md";
  f.storage.claimWorkspace({workspaceId, ownerUserId, createdAtMs: 1});
  f.storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch-2", streamIdentity: "stream-2"});
  f.share(shareId, ["docs"], {workspaceId, ownerUserId});
  f.moment(path, "second-owner-object", workspaceId);
  f.storage.enrollServiceHostDocument({...f.input, workspaceId, ownerUserId, shareId, path});
  await vi.waitFor(() => expect(f.attachedAfter.at(-1)).toEqual([scope.workspaceId, workspaceId]), {timeout: 10_000});
  f.diverge(scope.workspaceId, false);
  f.starts[0]!.controller.abort();
  await vi.waitFor(() => expect(f.starts).toHaveLength(2), {timeout: 10_000});
  await vi.waitFor(() => expect(f.attachedAfter.at(-1)).toEqual([workspaceId]), {timeout: 10_000});
  expect(f.onError.mock.calls).toEqual([[expect.objectContaining({message: expect.stringMatching(/workspace .+ diverged from the relay/)})]]);
  f.onError.mockClear();
  await f.waitPasses();
  expect(f.onError).not.toHaveBeenCalled();
  expect(f.updates.at(-1)!.workspaces.map(row => row.workspaceId)).toEqual([workspaceId]);
  expect(f.attachedAfter.at(-1)).toEqual([workspaceId]);
  expect(f.starts).toHaveLength(2);
});

// Proves: a restarted relay keeps a diverged store detached from its start,
// before any pull could find the divergence again, and its owner still reads
// why live editing stopped. The operator hears of it once, and no daemon starts for it.
it("keeps a diverged store detached and reported after the relay restarts", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  const store = join(f.data, storeName(scope.workspaceId)), marker = `${store}.diverged`;
  f.diverge();
  await vi.waitFor(() => {f.host.reconcile(); expect(existsSync(marker)).toBe(true);}, {timeout: 10_000});
  expect(f.host.diverged(f.enrollment()!)).toBe(true);
  expect(f.host.stopped(binding)).toBe(true);
  await f.host.close();
  const onError = vi.fn();
  const restarted = await startSelfHostedLiveHost({trustedAccount: (accountId: string) => ({accountId, name: "Owner name"}), storage: f.storage, history: f.history,
    root: f.data, engineExecutable: process.execPath, relayOrigin: "https://relay.test", key: new Uint8Array(32).fill(9), frameChanges: f.frameChanges, startHost: f.startHost, onError});
  cleanup.push(() => restarted.close());
  expect(restarted.diverged(f.enrollment()!)).toBe(true);
  expect(onError.mock.calls).toEqual([[expect.objectContaining({message: `The live editing copy in store ${store} diverged from the relay earlier. It stays detached. ` +
    `Recovery is not automatic yet. The store and every edit in it are kept. Keep ${marker}. Without it the next relay start attaches the store again and checks it against the relay before anyone can edit.`})]]);
  const routes = createServiceHostEnrollmentRoutes({storage: f.storage, history: f.history, host: restarted,
    resolveActor: async () => ({workspaceId: scope.workspaceId, userId: "owner-1"})});
  const response = await routes(new Request(`https://relay.test/sync/${scope.workspaceId}/live-host`, {headers: {authorization: "Bearer account-token"}}));
  expect(await response.json()).toEqual({ok: true, diverged: true, documents: [{path: binding.currentPath, objectId: binding.objectId, status: "unavailable", reason: "session-host-diverged"}]});
  const passes = vi.spyOn(f.storage, "listUndrainedServiceHostEnrollments");
  await vi.waitFor(() => {restarted.reconcile(); expect(passes.mock.calls.length).toBeGreaterThanOrEqual(3);}, {timeout: 10_000});
  expect(f.starts).toHaveLength(1);
  expect(onError).toHaveBeenCalledTimes(1);
});

// A relay that starts again on the fixture's storage and stores.
async function restart(f: Awaited<ReturnType<typeof fixture>>, onError = vi.fn()) {
  const restarted = await startSelfHostedLiveHost({trustedAccount: (accountId: string) => ({accountId, name: "Owner name"}), storage: f.storage, history: f.history,
    root: f.data, engineExecutable: process.execPath, relayOrigin: "https://relay.test", key: new Uint8Array(32).fill(9), frameChanges: f.frameChanges, startHost: f.startHost, onError});
  cleanup.push(() => restarted.close());
  return restarted;
}

// Proves: a marker that could not be written is written on a later
// reconciliation, and the store stays fenced meanwhile. Its failure is
// reported once, and the relay that starts after it landed keeps the store detached.
it("retries a divergence marker that could not be written, fencing the store meanwhile", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  const marker = `${join(f.data, storeName(scope.workspaceId))}.diverged`;
  markerFailure.error = Object.assign(new Error("no space left on device"), {code: "ENOSPC"});
  f.diverge();
  const failed = (call: unknown[]) => (call[0] as Error).message.startsWith("Could not write");
  await vi.waitFor(() => {f.host.reconcile(); expect(f.onError.mock.calls.filter(failed)).toHaveLength(1);}, {timeout: 10_000});
  expect(f.onError.mock.calls.find(failed)![0]).toMatchObject({message: `Could not write ${marker}. It is retried while the relay runs; a relay restart before it lands attaches the store again.`,
    cause: markerFailure.error});
  await f.waitPasses();
  expect(f.onError.mock.calls.filter(failed)).toHaveLength(1);
  expect(f.host.diverged(f.enrollment()!)).toBe(true);
  expect(f.attachedAfter.at(-1)).toEqual([]);
  expect(existsSync(marker)).toBe(false);
  markerFailure.error = undefined;
  await vi.waitFor(() => {f.host.reconcile(); expect(markerFailure.synced).toBe(1);}, {timeout: 10_000});
  expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({workspaceId: scope.workspaceId});
  await f.waitPasses();
  expect(markerFailure.synced).toBe(1);
  await f.host.close();
  expect((await restart(f)).diverged(f.enrollment()!)).toBe(true);
});

// Proves: what a restart can know when the marker never landed. Nothing on
// disk records the divergence, so the new relay attaches the store again; its
// daemon pulls before the first capture, which finds a divergence that a pull can see.
// The operator was told this when the write failed.
it("attaches a diverged store again after a restart that came before its marker landed", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  markerFailure.error = new Error("read-only file system");
  f.diverge();
  await vi.waitFor(() => {f.host.reconcile(); expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({cause: markerFailure.error}));}, {timeout: 10_000});
  await f.host.close();
  const restarted = await restart(f);
  expect(restarted.diverged(f.enrollment()!)).toBe(false);
  expect(restarted.stopped(binding)).toBe(false);
  await vi.waitFor(() => expect(f.starts).toHaveLength(2), {timeout: 10_000});
  await vi.waitFor(() => expect(f.attachedAfter.at(-1)).toEqual([scope.workspaceId]), {timeout: 10_000});
});

// Proves: startup deletes nothing: not a store no enrollment names, not what
// an earlier build left partway or set aside, and not other directories.
it("deletes no store at startup, named or not", async () => {
  const stale = "f".repeat(64), named = storeName(scope.workspaceId);
  const directories = [stale, named, `${stale}.removing`, join("diverged", `${stale}-1`), join("automations", "replica")];
  const f = await fixture({seed: async data => {
    for (const directory of directories) {
      await mkdir(join(data, directory), {recursive: true});
      await writeFile(join(data, directory, "marker"), directory);
    }
  }});
  await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  await f.waitPasses();
  expect((await readdir(f.data)).sort()).toEqual(["automations", "diverged", named, stale, `${stale}.removing`].sort());
  for (const directory of directories) expect(await readFile(join(f.data, directory, "marker"), "utf8")).toBe(directory);
});

it("retries runtime checks without rescanning unchanged shares and rescans after owner writes", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  const scans = vi.spyOn(f.storage, "scanServiceHostCandidateShares");
  const identity = vi.spyOn(f.storage, "verifyWorkspaceIdentity");
  f.host.reconcile();
  await vi.waitFor(() => expect(identity).toHaveBeenCalled(), {timeout: 10_000});
  expect(scans).not.toHaveBeenCalled();
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true});
  await f.waitUpdate([]);
  expect(scans).toHaveBeenCalled();
  scans.mockClear();
  f.storage.enrollServiceHostDocument(f.input);
  await f.waitUpdate(["docs/a.md"]);
  expect(scans).toHaveBeenCalled();
  expect(f.starts).toHaveLength(1);
});

it.each([false, true])("clears a transient reconciliation failure after returning to a healthy selection (empty: %s)", async empty => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  if (empty) {
    f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
    await f.waitUpdate([]);
    await vi.waitFor(() => expect(f.updates.at(-1)!.workspaces).toEqual([]), {timeout: 10_000});
  }
  const current = f.host.current(), updates = f.updates.length;
  // The supervisor retries every 2 s, which can clear the failure before a poll
  // sees it, so record availability when the failure is reported.
  const unavailableAtError: boolean[] = [];
  f.onError.mockImplementation(() => {unavailableAtError.push(f.host.unavailable);});
  const selection = vi.spyOn(f.storage, "listUndrainedServiceHostEnrollments");
  selection.mockImplementationOnce(() => {throw new Error("Temporary enrollment read failure");});
  f.host.reconcile();
  await vi.waitFor(() => expect(unavailableAtError).toEqual([true]), {timeout: 10_000});
  expect(f.onError).toHaveBeenCalledTimes(1);
  f.host.reconcile();
  await vi.waitFor(() => expect(f.host.unavailable).toBe(false), {timeout: 10_000});
  expect(f.host.current()).toBe(current);
  expect(f.starts).toHaveLength(1); expect(f.updates).toHaveLength(updates);
  expect(f.starts[0]!.close).not.toHaveBeenCalled();
});

it("pauses the final document on the running daemon and closes the daemon with the supervisor", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]); const first = f.starts[0]!;
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  await f.waitUpdate([]);
  expect(f.host.ready({workspaceId: binding.workspaceId, mainVersionId: "main", objectId: binding.objectId, lineageClaimId: binding.lineageClaimId})).toBe(false);
  await vi.waitFor(() => expect(f.storage.listServiceHostEnrollments()[0]!.enabled).toBe(false), {timeout: 10_000});
  await vi.waitFor(() => expect(f.updates.at(-1)!.workspaces).toEqual([]), {timeout: 10_000});
  expect(first.close).not.toHaveBeenCalled();
  await f.host.close(); expect(first.close).toHaveBeenCalledTimes(1); expect(f.starts).toHaveLength(1);
});

it("adds another owner's workspace with a separate root and scoped credential", async () => {
  const f = await fixture(); await f.waitStarted(1);
  const first = await f.waitUpdate(["docs/a.md"]);
  const workspaceId = "workspace-2", ownerUserId = "owner-2", shareId = "share-2", path = "docs/other.md";
  f.storage.claimWorkspace({workspaceId, ownerUserId, createdAtMs: 1});
  f.storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch-2", streamIdentity: "stream-2"});
  f.share(shareId, ["docs"], {workspaceId, ownerUserId});
  f.moment(path, "second-owner-object", workspaceId);
  f.storage.enrollServiceHostDocument({...f.input, workspaceId, ownerUserId, shareId, path});
  const {workspaces} = await f.waitUpdate(["docs/a.md", path]);
  expect(workspaces).toHaveLength(2);
  expect(workspaces[0]).toEqual(first.workspaces[0]);
  expect(workspaces[1]!.root).not.toBe(workspaces[0]!.root);
  expect(bearer(workspaces[1]!)).not.toBe(bearer(workspaces[0]!));
  expect(f.starts).toHaveLength(1); expect(f.starts[0]!.close).not.toHaveBeenCalled();
});

it("applies the latest selection after an update that was in flight", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  const held = f.holdNextUpdate(), second = f.add(); await held.entered.promise;
  f.storage.setServiceHostEnrollmentEnabled({...f.input, path: second.path, enabled: false});
  held.release.resolve();
  await f.waitUpdate(["docs/a.md"]);
  expect(f.updates.filter(update => update.documents.length === 2).length).toBeLessThanOrEqual(1);
  expect(f.starts).toHaveLength(1);
});

it("waits for an in-flight update before the supervisor closes", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]); const first = f.starts[0]!;
  const held = f.holdNextUpdate(); f.add(); await held.entered.promise;
  const closed = vi.fn(), stopped = f.host.close().then(closed);
  try {
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled(); expect(first.close).not.toHaveBeenCalled();
  } finally {held.release.resolve();}
  await stopped;
  expect(first.close).toHaveBeenCalledTimes(1); expect(f.starts).toHaveLength(1);
  expect(f.host.current()).toBeUndefined(); expect(f.host.unavailable).toBe(true);
});

it("releases its observer and cancels queued work when closed before the initial pass", async () => {
  const f = await fixture();
  expect(hasRelayWriteObservers(f.storage)).toBe(true);
  f.host.reconcile();
  await f.host.close();
  expect(hasRelayWriteObservers(f.storage)).toBe(false);
  expect(f.startHost).not.toHaveBeenCalled();
  expect(f.host.unavailable).toBe(true);
  f.host.reconcile();
  await f.host.close();
  expect(f.startHost).not.toHaveBeenCalled();
});

it("waits for a late daemon start and its close before every concurrent close returns", async () => {
  const entered = deferred(), finish = deferred();
  const f = await fixture({beforeStart: async () => {entered.resolve(); await finish.promise;}});
  await entered.promise;
  const first = vi.fn(), second = vi.fn();
  const closes = [f.host.close().then(first), f.host.close().then(second)];
  try {
    await Promise.resolve();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(hasRelayWriteObservers(f.storage)).toBe(true);
  } finally {finish.resolve();}
  await Promise.all(closes);
  expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
  expect(f.starts).toHaveLength(1);
  expect(f.starts[0]!.close).toHaveBeenCalledTimes(1);
  await expect(readFile(f.starts[0]!.configPath)).rejects.toMatchObject({code: "ENOENT"});
  expect(f.host.current()).toBeUndefined();
  expect(hasRelayWriteObservers(f.storage)).toBe(false);
  expect(f.onError).not.toHaveBeenCalled();
});

it("keeps concurrent closes waiting while the current daemon drains", async () => {
  const f = await fixture(); await f.waitStarted(1);
  const first = f.starts[0]!, entered = deferred(), drained = deferred();
  const close = first.close.getMockImplementation()!;
  first.close.mockImplementation(async () => {entered.resolve(); await drained.promise; await close();});
  const done = vi.fn();
  const closing = f.host.close(); await entered.promise;
  const alsoClosing = f.host.close().then(done);
  try {
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
  } finally {drained.resolve();}
  await Promise.all([closing, alsoClosing]);
  expect(first.close).toHaveBeenCalledTimes(1);
  expect(f.host.current()).toBeUndefined();
});

it("closes the daemon and observer when storage becomes unavailable", async () => {
  const unavailable = new AbortController();
  const f = await fixture({unavailable: unavailable.signal}); await f.waitStarted(1);
  unavailable.abort();
  await vi.waitFor(() => expect(f.starts[0]!.close).toHaveBeenCalledTimes(1));
  await f.host.close();
  expect(f.host.unavailable).toBe(true);
  expect(f.host.current()).toBeUndefined();
  expect(hasRelayWriteObservers(f.storage)).toBe(false);
  expect(f.onError).not.toHaveBeenCalled();
});

it("retries a failed daemon start without another enrollment write", async () => {
  const failure = new Error("Temporary daemon startup failure.");
  let attempted = false;
  const f = await fixture({beforeStart: async () => {
    if (!attempted) {attempted = true; throw failure;}
  }});
  await vi.waitFor(() => expect(f.onError).toHaveBeenCalledWith(failure), {timeout: 10_000});
  await vi.waitFor(() => expect(f.host.unavailable).toBe(false), {timeout: 10_000});
  expect(f.startHost).toHaveBeenCalledTimes(2);
  expect(f.starts).toHaveLength(1);
  expect(f.onError).toHaveBeenCalledTimes(1);
  expect(f.peak()).toBe(1);
});

it("surfaces the same daemon close failure to all callers", async () => {
  const f = await fixture(); await f.waitStarted(1);
  const failure = new Error("Native process did not close.");
  const close = f.starts[0]!.close.getMockImplementation()!;
  f.starts[0]!.close.mockImplementation(async () => {await close(); throw failure;});
  await expect(f.host.close()).rejects.toBe(failure);
  await expect(f.host.close()).rejects.toBe(failure);
  expect(hasRelayWriteObservers(f.storage)).toBe(false);
  // The failure is already checked; fixture teardown still closes its database.
  cleanup.pop();
});

const rename = (f: Awaited<ReturnType<typeof fixture>>, path: string) => {
  f.raw.prepare("UPDATE sync_relay_object_moments SET path=? WHERE workspace_id=? AND object_id=?").run(path, scope.workspaceId, binding.objectId);
  f.host.reconcile();
};
const departingA = {workspaceId: scope.workspaceId, objectId: binding.objectId, path: binding.currentPath, shareId: scope.shareId};

// Proves: a renamed document leaves its replica as a departed one does while
// its sibling stays hosted, keeps its enrollment, and is hosted again at its path.
it("lets a renamed document leave its replica without releasing it, and hosts it again at its path", async () => {
  const f = await fixture(); f.add(); await f.waitStarted(1);
  await f.waitUpdate(["docs/a.md", "docs/b.md"]);
  f.pending.add(binding.objectId);
  rename(f, "docs/renamed.md");
  expect((await f.waitUpdate(["docs/b.md"])).departing).toEqual([departingA]);
  await f.waitPasses();
  expect(f.updates.at(-1)!.departing).toEqual([departingA]);
  f.pending.delete(binding.objectId);
  await vi.waitFor(() => expect(f.updates.at(-1)!.departing).toEqual([]), {timeout: 10_000});
  expect(f.enrollment()).toMatchObject({enabled: true, retired: false, ownerStop: null, hostDrainedAtMs: null});
  rename(f, binding.currentPath);
  await f.waitUpdate(["docs/a.md", "docs/b.md"]);
  expect(f.starts[0]!.close).not.toHaveBeenCalled(); expect(f.starts).toHaveLength(1);
});

// Proves: renaming a workspace's last document keeps the workspace attached
// until its replica drains, then detaches it and keeps its store. The
// enrollment stays, and nothing attaches the workspace again.
it("drains the workspace of a renamed last document and keeps its store and its enrollment", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  const store = join(f.data, storeName(scope.workspaceId));
  await writeFile(join(store, "replica.sqlite"), "hosted");
  f.pending.add(binding.objectId);
  rename(f, "docs/renamed.md");
  const draining = await f.waitUpdate([]);
  expect(draining.workspaces.map(row => row.workspaceId)).toEqual([scope.workspaceId]);
  expect(draining.departing).toEqual([departingA]);
  await f.waitPasses();
  expect(f.events).toEqual([]); expect(existsSync(store)).toBe(true);
  f.pending.delete(binding.objectId);
  await vi.waitFor(() => expect(f.updates.at(-1)!.workspaces).toEqual([]), {timeout: 10_000});
  expect(f.events).toEqual([`detach ${scope.workspaceId}`, `release ${binding.objectId} attached=false store=true`]);
  expect(await readFile(join(store, "replica.sqlite"), "utf8")).toBe("hosted");
  expect(f.enrollment()).toMatchObject({enabled: true, retired: false, ownerStop: null, hostDrainedAtMs: null});
  const updates = f.updates.length;
  await f.waitPasses();
  expect(f.updates).toHaveLength(updates); expect(f.events).toHaveLength(2);
});

// Proves: a page of stopped documents that stay gives way to the next, so
// every one of them reaches its replica and is released. Every store stays,
// and an update names one page of departing workspaces at most, beside the
// hosted one. One page and one more workspace prove it; each workspace costs
// durable writes, and the storage tests cover many pages.
it("reaches stopped documents past a page of ones that stay and keeps every store", async () => {
  const workspaces = Array.from({length: SERVICE_HOST_MAX_WORKSPACES + 1}, (_, index) => `stopped-${String(index).padStart(3, "0")}`);
  const last = storeName(workspaces.at(-1)!), stale = "e".repeat(64);
  const f = await fixture({pending: ["object-stopped"], seed: async (data, relay) => {
    const stopped = relay.raw.prepare(`INSERT INTO sync_relay_service_host_enrollments(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,accounted_bytes)
      VALUES (?,'object-stopped','docs/a.md','owner-1',?,'epoch','stream','retire',0,1,1,1,1)`);
    for (const workspaceId of workspaces) {
      relay.storage.claimWorkspace({workspaceId, ownerUserId: "owner-1", createdAtMs: 1});
      relay.storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
      relay.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner-1',?,1)")
        .run(`share-${workspaceId}`, workspaceId, JSON.stringify({paths: ["docs"], versionId: null}));
      stopped.run(workspaceId, `share-${workspaceId}`);
    }
    for (const name of [last, stale]) {await mkdir(join(data, name)); await writeFile(join(data, name, "marker"), name);}
  }});
  await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  const undrained = () => f.raw.prepare("SELECT DISTINCT workspace_id FROM sync_relay_service_host_enrollments WHERE host_drained_at_ms IS NULL ORDER BY workspace_id")
    .all().map(row => row.workspace_id);
  expect(await readFile(join(f.data, last, "marker"), "utf8")).toBe(last);
  expect(await readFile(join(f.data, stale, "marker"), "utf8")).toBe(stale);
  await vi.waitFor(() => expect(f.updates.some(update => update.departing.some(row => row.workspaceId === workspaces.at(-1)))).toBe(true), {timeout: 10_000});
  expect(undrained()).toHaveLength(workspaces.length + 1);
  f.pending.delete("object-stopped");
  await vi.waitFor(() => expect(undrained()).toEqual([scope.workspaceId]), {timeout: 20_000});
  expect(f.onError).not.toHaveBeenCalled();
  expect(Math.max(...f.updates.map(update => update.workspaces.length))).toBeLessThanOrEqual(SERVICE_HOST_MAX_WORKSPACES + 1);
  expect(await readFile(join(f.data, last, "marker"), "utf8")).toBe(last);
  expect(existsSync(join(f.data, storeName(workspaces[0]!)))).toBe(true);
});

// Proves: with no session host running, deleting an account removes each of
// its workspace identities' hosted stores, with their parked live state, and
// a diverged store's marker, idempotently. Every other store stays.
it("removes a deleted account's hosted stores and markers while no session host runs, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "dohc-deleted-live-root-"));
  cleanup.push(() => rm(root, {recursive: true, force: true}));
  const current = {workspaceId: "deleted-workspace", replicationEpoch: "epoch", streamIdentity: "stream"};
  const earlier = {...current, replicationEpoch: "epoch-0", streamIdentity: "stream-0"};
  for (const row of [current, earlier]) {
    const store = join(root, storeName(row.workspaceId, row.replicationEpoch, row.streamIdentity));
    await mkdir(store); await writeFile(join(store, "replica.sqlite"), "parked live state");
  }
  await writeFile(join(root, `${storeName(current.workspaceId)}.diverged`), JSON.stringify({workspaceId: current.workspaceId}));
  const kept = [storeName("workspace-2"), `${storeName("workspace-2")}.diverged`, "automations"];
  await mkdir(join(root, kept[0]!)); await writeFile(join(root, kept[1]!), "{}"); await mkdir(join(root, kept[2]!));
  await deleteSelfHostedWorkspaceRoots(root, namespace, [current, earlier]);
  await deleteSelfHostedWorkspaceRoots(root, namespace, [current, earlier]);
  expect((await readdir(root)).sort()).toEqual(kept.sort());
});

// Proves: once its owner's account is fenced for deletion, no hosted set names
// the account's documents, hosted or departing, so no pass settles them
// against a feed the fence refuses. Its workspace detaches without draining,
// and another owner's document stays hosted.
it("keeps a deleted account's hosted and departing documents out of the hosted set", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  const workspaceId = "workspace-2", ownerUserId = "owner-2", shareId = "share-2", path = "docs/other.md";
  f.storage.claimWorkspace({workspaceId, ownerUserId, createdAtMs: 1});
  f.storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch-2", streamIdentity: "stream-2"});
  f.share(shareId, ["docs"], {workspaceId, ownerUserId});
  f.moment(path, "second-owner-object", workspaceId);
  f.storage.enrollServiceHostDocument({...f.input, workspaceId, ownerUserId, shareId, path});
  f.add();
  await f.waitUpdate(["docs/a.md", "docs/b.md", path]);
  // A paused sibling its replica has not let go yet.
  f.pending.add("object-b");
  f.storage.setServiceHostEnrollmentEnabled({...f.input, path: "docs/b.md", enabled: false});
  await vi.waitFor(() => expect(f.updates.at(-1)!.departing.map(row => row.path)).toEqual(["docs/b.md"]), {timeout: 10_000});
  const before = f.updates.length;
  f.fence();
  await vi.waitFor(() => expect(f.updates.at(-1)!.workspaces.map(row => row.workspaceId)).toEqual([workspaceId]), {timeout: 10_000});
  await f.waitPasses();
  const named = (update: ServiceHostedSet) => [...update.workspaces, ...update.documents, ...update.departing].filter(row => row.workspaceId === scope.workspaceId);
  expect(f.updates.length).toBeGreaterThan(before);
  expect(f.updates.slice(before).flatMap(named)).toEqual([]);
  expect(f.updates.at(-1)!.documents.map(row => row.path)).toEqual([path]);
  expect(f.attachedAfter.at(-1)).toEqual([workspaceId]);
  expect(f.events.filter(event => event.startsWith("detach"))).toEqual([]);
  expect(f.onError).not.toHaveBeenCalled();
});

// Proves: deleting an account removes, on a running host, every hosted store
// of its workspaces with the live state parked there, an earlier identity's
// drained store, and a diverged store's marker. The daemon detaches each
// workspace while its store is still there. Nothing writes them again, and
// another owner's store stays.
it("removes a deleted account's hosted stores, parked state and markers on a running host", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  const sibling = "workspace-3", path = "docs/other.md";
  f.storage.claimWorkspace({workspaceId: sibling, ownerUserId: "owner-1", createdAtMs: 1});
  f.storage.claimWorkspaceIdentity({workspaceId: sibling, replicationEpoch: "epoch", streamIdentity: "stream"});
  f.share("share-3", ["docs"], {workspaceId: sibling});
  f.moment(path, "sibling-object", sibling);
  f.storage.enrollServiceHostDocument({...f.input, workspaceId: sibling, shareId: "share-3", path});
  await vi.waitFor(() => expect(f.attachedAfter.at(-1)).toEqual([scope.workspaceId, sibling]), {timeout: 10_000});
  const store = join(f.data, storeName(scope.workspaceId)), marker = `${store}.diverged`, siblingStore = join(f.data, storeName(sibling));
  const earlier = join(f.data, storeName(scope.workspaceId, "epoch-0", "stream-0")), other = join(f.data, storeName("workspace-2"));
  await writeFile(join(store, "replica.sqlite"), "parked live state");
  for (const directory of [earlier, other]) {await mkdir(directory); await writeFile(join(directory, "replica.sqlite"), "drained");}
  f.diverge();
  await vi.waitFor(() => {f.host.reconcile(); expect(existsSync(marker)).toBe(true);}, {timeout: 10_000});
  f.onError.mockClear();
  const manifest = f.fence();
  await f.host.deleteWorkspaces([...manifest.workspaces, {workspaceId: scope.workspaceId, replicationEpoch: "epoch-0", streamIdentity: "stream-0"}]);
  expect(f.events.filter(event => event.startsWith("delete")).sort()).toEqual([`delete ${scope.workspaceId} store=true`, `delete ${sibling} store=true`]);
  for (const removed of [store, marker, siblingStore, earlier]) expect(existsSync(removed)).toBe(false);
  expect(f.host.diverged(f.enrollment()!)).toBe(false);
  await f.waitPasses();
  expect((await readdir(f.data))).toEqual([basename(other)]);
  expect(f.updates.at(-1)!.workspaces).toEqual([]);
  expect(f.onError).not.toHaveBeenCalled();
});

// Proves: a divergence marker still waiting to be written is not written once
// its store was deleted with its account.
it("drops a deleted store's divergence marker that could not be written yet", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  const store = join(f.data, storeName(scope.workspaceId));
  markerFailure.error = new Error("no space left on device");
  f.diverge();
  await vi.waitFor(() => {f.host.reconcile(); expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({cause: markerFailure.error}));}, {timeout: 10_000});
  await f.host.deleteWorkspaces(f.fence().workspaces);
  markerFailure.error = undefined;
  await f.waitPasses();
  expect(markerFailure.synced).toBe(0);
  expect(existsSync(store)).toBe(false); expect(existsSync(`${store}.diverged`)).toBe(false);
});

// Proves: a deletion waits for the reconciliation writing a divergence marker,
// so that marker is not written after the deletion removed the store.
it("waits for a divergence marker being written before deleting its store", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  const store = join(f.data, storeName(scope.workspaceId)), entered = deferred(), release = deferred();
  markerFailure.hold = {entered: entered.resolve, release: release.promise};
  f.diverge(); f.host.reconcile();
  await entered.promise;
  const deleting = f.host.deleteWorkspaces(f.fence().workspaces);
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(f.events.filter(event => event.startsWith("delete"))).toEqual([]);
  } finally {release.resolve();}
  await deleting;
  await f.waitPasses();
  expect(markerFailure.synced).toBe(1);
  expect(existsSync(store)).toBe(false); expect(existsSync(`${store}.diverged`)).toBe(false);
});
