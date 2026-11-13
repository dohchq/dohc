import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {createHash} from "node:crypto";
import {basename, join} from "node:path";
import {tmpdir} from "node:os";
import {afterEach, expect, it, vi} from "vitest";
import {startSelfHostedLiveHost, deleteSelfHostedWorkspaceRoots} from "./selfHostedLiveHost";
import {stopWithoutSessionHost} from "./sessionHostStop";
import {createServiceHostEnrollmentRoutes} from "./serviceHostEnrollmentRoutes";
import {fenceAccount, initializeAccountDeletion} from "./storage/accountDeletion";
import type {ServiceHostedSet} from "./serviceLiveHost";
import type {ServiceKeptEdits} from "./storage/serviceKeptEdits";
import type {ServiceActivationBlock} from "./serviceActivationDriver";
import type {ServiceHostedHold} from "./serviceHostedReplication";
import {fixture as ticketFixture, binding, scope, retainServiceActivation} from "./liveTickets.test-helper";
import {attachLiveJournalHistory, createLiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import {createNamedFrameChanges} from "./liveHostChanges";
import {hasRelayWriteObservers} from "./relayWriteChanges";
import {serviceHostDocumentEnabled} from "./storage/serviceHostEnrollment";
import {RECLAIM_RETENTION_MS, RECLAIM_SWEEP_MS} from "./liveHostingLimits";
import type {StorageContext} from "./storage/context";

// While `error` is set, opening a divergence marker fails, as on a full disk.
// While `hold` is set, opening one waits for its release. `synced` counts the flushes of marker files.
const markerFailure = vi.hoisted(() => ({error: undefined as Error | undefined, synced: 0,
  hold: undefined as {entered(): void; release: Promise<void>} | undefined}));
// While `error` is set, creating a folder fails, so a pass cannot prepare its hosted stores.
const folderFailure = vi.hoisted(() => ({error: undefined as Error | undefined}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {...actual, mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
    if (folderFailure.error) throw folderFailure.error;
    return actual.mkdir(...args);
  }, open: async (...args: Parameters<typeof actual.open>) => {
    if (!String(args[0]).endsWith(".diverged")) return actual.open(...args);
    const hold = markerFailure.hold;
    if (hold) {markerFailure.hold = undefined; hold.entered(); await hold.release;}
    if (markerFailure.error) throw markerFailure.error;
    const handle = await actual.open(...args), sync = handle.sync.bind(handle);
    return Object.assign(handle, {sync: async () => {await sync(); markerFailure.synced++;}});
  }};
});
// The reclaim sweep's waits, in order. Each lasts until a test passes it or its signal aborts. Every other wait keeps the real clock.
const sweepWaits = vi.hoisted(() => [] as Array<{ms: number; signal: AbortSignal | undefined; pass(): void}>);
vi.mock("node:timers/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  const {RECLAIM_RETENTION_MS, RECLAIM_SWEEP_MS} = await import("./liveHostingLimits");
  return {...actual, setTimeout: <T>(ms?: number, value?: T, options?: {signal?: AbortSignal; ref?: boolean}) => ms !== RECLAIM_SWEEP_MS && ms !== RECLAIM_RETENTION_MS
    ? actual.setTimeout(ms, value, options)
    : new Promise<T>((resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) {reject(signal.reason); return;}
      signal?.addEventListener("abort", () => reject(signal.reason), {once: true});
      sweepWaits.push({ms: ms!, signal, pass: () => resolve(value as T)});
    })};
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  Object.assign(markerFailure, {error: undefined, synced: 0, hold: undefined}); folderFailure.error = undefined; vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  sweepWaits.length = 0;
});
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
  // The relay attaches its history as it opens its storage, before anything reads it (`openRelayDeployment`).
  const history = createLiveJournalHistoryAuthority({namespace, reconciled: true});
  attachLiveJournalHistory(f.storage as StorageContext, history);
  if (options.unavailable) vi.spyOn(f.storage, "unavailable", "get").mockReturnValue(options.unavailable);
  // The ticket fixture provisions a device; this supervisor test starts a clean service deployment.
  f.raw.exec("DELETE FROM sync_relay_session_host_control");
  f.storage.claimWorkspaceIdentity({workspaceId: scope.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
  const root = await mkdtemp(join(tmpdir(), "dohc-self-host-supervisor-")); const data = join(root, "data"); await mkdir(data);
  cleanup.push(() => rm(root, {recursive: true, force: true}));
  const input = {workspaceId: scope.workspaceId, ownerUserId: "owner-1", shareId: scope.shareId, path: binding.currentPath, nowMs: 10, guard() {}};
  const enrolled = f.storage.ensureOwnedLiveDocument({intent: "share", ...input});
  if (options.empty) {
    f.storage.setServiceHostEnrollmentEnabled({...input, enabled: false});
    f.storage.releaseServiceHostEnrollment({workspaceId: enrolled.workspaceId, objectId: enrolled.objectId, nowMs: 10});
  }
  await options.seed?.(data, f);
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
    return {invalidated: controller.signal, close, update, deleteWorkspaces, retains, pulledAfterDeparture, drained, detachDrained, isDocumentReady, readKeptEditsPage, onEvent: () => () => undefined, onProgress: () => () => undefined,
      stop: async <T>(document: Document, fence: () => T) => stopWithoutSessionHost(document, {code: "host-not-loaded", sessionHost: "running, document not loaded yet"}, fence),
      blocked: (document: Document) => holds(document) ? blocked.get(document.objectId) : undefined,
      holdReason: (document: Document) => holds(document) ? holdReasons.get(document.objectId) : undefined,
      failing: () => undefined,
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
    return f.storage.ensureOwnedLiveDocument({intent: "share", ...input, path, shareId});
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

it.each([
  {name: "diverged", code: "host-diverged", state: "running without this document (server copy diverged)", error: "Live editing didn't stop. The server's copy of this workspace no longer matches the synced one. Contact the server's operator."},
  {name: "paused", code: "host-paused", state: "running without this document (paused)", error: "Live editing didn't stop. Recent edits haven't reached the server yet. Resume live editing to send them, then stop it."},
  {name: "no Edit grant", code: "host-no-edit-grant", state: "running without this document (no Edit grant)", error: "Live editing didn't stop. The server may hold recent edits, but it only loads documents shared with Edit access. Share this one with Edit access again, then try again."},
  {name: "moved", code: "host-moved", state: `running without this document (moved from ${binding.currentPath})`, error: `Live editing didn't stop. The server may hold recent edits, but it only loads this document from ${binding.currentPath}. Put it back there, then try again.`},
  {name: "start failed", code: "host-start-failed", state: "couldn't start", error: "Live editing didn't stop. The server couldn't load this document and may hold recent edits. Contact the server's operator, then try again."},
  {name: "starting", code: "host-not-loaded", state: "starting"},
  {name: "restarting", code: "host-not-loaded", state: "restarting"},
  {name: "not loaded", code: "host-not-loaded", state: "running, document not loaded yet"},
  {name: "paused after relay restart", code: "host-paused", state: "running without this document (paused)", error: "Live editing didn't stop. Recent edits haven't reached the server yet. Resume live editing to send them, then stop it."},
  {name: "paused without Edit grant", code: "host-paused", state: "running without this document (paused)", error: "Live editing didn't stop. Recent edits haven't reached the server yet. Resume live editing to send them, then stop it."},
  {name: "paused and diverged", code: "host-diverged", state: "running without this document (server copy diverged)", error: "Live editing didn't stop. The server's copy of this workspace no longer matches the synced one. Contact the server's operator."},
])("answers Stop for $name without fencing", async test => {
  const entered = deferred(), finish = deferred();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const failure = new Error("private engine start failure detail");
  const heldStart = test.name === "starting";
  const f = await fixture({beforeStart: async () => {
    entered.resolve();
    if (test.name === "start failed") throw failure;
    if (heldStart) await finish.promise;
  }, seed: async (data, relay) => {
    if (test.name.includes("paused")) {
      relay.storage.setServiceHostEnrollmentEnabled({workspaceId: scope.workspaceId, path: binding.currentPath, ownerUserId: "owner-1", enabled: false, nowMs: 20, guard() {}});
      if (test.name === "paused after relay restart") relay.storage.releaseServiceHostEnrollment({...binding, nowMs: 21});
    }
    if (test.name.includes("diverged")) await writeFile(join(data, `${storeName(scope.workspaceId)}.diverged`), "{}");
    if (test.name.includes("Edit grant")) relay.raw.prepare("UPDATE sync_relay_share_grants SET status='revoked', revoked_at_ms=20").run();
    if (test.name === "moved") relay.raw.prepare("UPDATE sync_relay_object_moments SET path='docs/moved.md' WHERE object_id=?").run(binding.objectId);
  }});
  let restart: ReturnType<typeof f.holdNextUpdate> | undefined;
  try {
    if (test.name === "start failed") await vi.waitFor(() => expect(f.onError).toHaveBeenCalledWith(failure));
    else if (test.name === "restarting") {
      // The failed daemon stays current until a reconciliation replaces it.
      // One held in its update keeps the abort's own reconciliation queued.
      await f.waitUpdate([binding.currentPath]);
      restart = f.holdNextUpdate(); f.add(); await restart.entered.promise;
      f.starts[0]!.controller.abort();
    }
    else if (test.name === "not loaded") {await f.waitStarted(1); await vi.waitFor(() => expect(f.host.current()).toBeDefined());}
    else if (test.name === "starting") await entered.promise;
    else await f.waitPasses();
    if (test.name === "paused after relay restart") expect(f.host.current()).toBeUndefined();
    retainServiceActivation(f.raw, namespace, true);
    const before = f.enrollment(), admission = serviceHostDocumentEnabled(f.storage as StorageContext, binding);
    const routes = createServiceHostEnrollmentRoutes({storage: f.storage, history: f.history, host: f.host,
      resolveActor: async () => ({workspaceId: scope.workspaceId, userId: "owner-1"})});
    const response = await routes(new Request(`https://relay.test/sync/${scope.workspaceId}/live-host`, {method: "DELETE",
      headers: {"content-type": "application/json", authorization: "Bearer account-token"}, body: JSON.stringify({path: binding.currentPath, retire: true})}));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({ok: false, code: test.code, sessionHost: test.state,
      error: test.error ?? "Live editing didn't stop. The server hasn't loaded this document yet and may hold recent edits to it. Try again in a moment.",
      ...(test.name === "moved" ? {path: binding.currentPath} : {})});
    expect(JSON.stringify(body)).not.toContain(failure.message);
    expect(f.enrollment()).toEqual(before);
    expect(f.storage.serviceActivationRetirement(binding)).toBeNull();
    expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(admission);
    expect(log.mock.calls.filter(([line]) => String(line).includes("Session host:"))).toEqual([
      [`Live editing Stop for workspace ${scope.workspaceId}, object ${binding.objectId}. Session host: ${test.state}`],
    ]);
    expect(log.mock.calls.flat().join(" ")).not.toContain(failure.message);
  } finally {finish.resolve(); restart?.release.resolve();}
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
  expect(first.documents).toEqual([{workspaceId: scope.workspaceId, objectId: binding.objectId, path: "docs/a.md"}]);
  expect(first.departing).toEqual([]);
  expect(first.workspaces).toHaveLength(1);
  expect(basename(first.workspaces[0]!.root)).toBe(storeName(scope.workspaceId));
  expect(first.workspaces[0]!.hostedReplication).toMatchObject({identity: {replicationEpoch: "epoch", streamIdentity: "stream"},
    relay: {baseUrl: "https://relay.test"}});
  expect(bearer(first.workspaces[0]!)).toMatch(/^dohc-service-v1\./);
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
// enrollment. The store stays, and resuming the document reopens it.
it("drains a stopped last document, then detaches the workspace and releases it, keeping its store", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  const store = join(f.data, storeName(scope.workspaceId));
  await writeFile(join(store, "replica.sqlite"), "hosted");
  f.pending.add(binding.objectId);
  const stopped = f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration});
  expect(stopped).toMatchObject({enabled: false, retired: true});
  const drainingSet = await f.waitUpdate([]);
  expect(drainingSet.workspaces.map(row => row.workspaceId)).toEqual([scope.workspaceId]);
  expect(drainingSet.departing).toEqual([{workspaceId: scope.workspaceId, objectId: binding.objectId, path: binding.currentPath}]);
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
  // Resumed, the document's workspace attaches to the store it kept.
  f.storage.ensureOwnedLiveDocument({intent: "owner-resume", ...f.input});
  const returned = await f.waitUpdate(["docs/a.md"]);
  expect(returned.workspaces.map(row => basename(row.root))).toEqual([storeName(scope.workspaceId)]);
  expect(f.attachedAfter.at(-1)).toEqual([scope.workspaceId]);
  expect(await readdir(f.data)).toEqual([storeName(scope.workspaceId)]);
  expect(await readFile(join(store, "replica.sqlite"), "utf8")).toBe("hosted");
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
  f.storage.ensureOwnedLiveDocument({intent: "share", ...f.input, workspaceId, ownerUserId, shareId, path});
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

// Proves: the operator learns where a blocked document's store is kept, once
// per block, and the document stays hosted. A new block after its owner's
// retry is reported again, even one before any reconciliation saw it unblocked.

// Proves: a document with no Y.Doc lineage tells the operator, once, that its
// owner must open it on a desktop before it can start.

// Proves: a document whose history is past what the server reads or checks
// tells the operator, once, that it tries again later or on its owner's Resume.
it("tells the operator a document whose history is past its budget tries again later", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  f.block(binding.objectId, "history-over-budget");
  await vi.waitFor(() => {f.host.reconcile(); expect(f.onError).toHaveBeenCalled();}, {timeout: 10_000});
  expect(f.onError.mock.calls).toEqual([[expect.objectContaining({message: `Live editing of docs/a.md in workspace ${scope.workspaceId} cannot start: its edit history is past what this server reads or checks. It tries again later, or when its owner resumes live editing in dohc. Its store is kept at ${join(f.data, storeName(scope.workspaceId))}.`})]]);
  expect(f.host.blocked(binding)).toBe("history-over-budget");
  await f.waitPasses();
  expect(f.onError).toHaveBeenCalledTimes(1);
});

// Proves: a document whose host copy is missing an owner edit tells the
// operator, once, that it is held until its owner resumes it.

// Proves: a divergence whose detach failed as its daemon exited keeps the
// store out of the replacement daemon, and is reported once.

// Proves: a restarted relay keeps a diverged store detached from its start,
// before any pull could find the divergence again, and its owner still reads
// why live editing stopped. The operator hears of it once, and no daemon starts for it.

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

it("adds another owner's workspace with a separate root and scoped credential", async () => {
  const f = await fixture(); await f.waitStarted(1);
  const first = await f.waitUpdate(["docs/a.md"]);
  const workspaceId = "workspace-2", ownerUserId = "owner-2", shareId = "share-2", path = "docs/other.md";
  f.storage.claimWorkspace({workspaceId, ownerUserId, createdAtMs: 1});
  f.storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch-2", streamIdentity: "stream-2"});
  f.share(shareId, ["docs"], {workspaceId, ownerUserId});
  f.moment(path, "second-owner-object", workspaceId);
  f.storage.ensureOwnedLiveDocument({intent: "share", ...f.input, workspaceId, ownerUserId, shareId, path});
  const {workspaces} = await f.waitUpdate(["docs/a.md", path]);
  expect(workspaces).toHaveLength(2);
  expect(workspaces[0]).toEqual(first.workspaces[0]);
  expect(workspaces[1]!.root).not.toBe(workspaces[0]!.root);
  expect(bearer(workspaces[1]!)).not.toBe(bearer(workspaces[0]!));
  expect(f.starts).toHaveLength(1); expect(f.starts[0]!.close).not.toHaveBeenCalled();
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
  f.storage.ensureOwnedLiveDocument({intent: "share", ...f.input, workspaceId: sibling, shareId: "share-3", path});
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
