import {mkdtemp, mkdir, readFile, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {afterEach, expect, it, vi} from "vitest";
import {startSelfHostedLiveHost} from "./selfHostedLiveHost";
import type {ServiceHostedSet} from "./serviceLiveHost";
import {fixture as ticketFixture, binding, scope} from "./liveTickets.test-helper";
import {createLiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import {createNamedFrameChanges} from "./liveHostChanges";
import {hasRelayWriteObservers, notifyRelayWrite} from "./relayWriteChanges";
import {serviceHostDocumentEnabled} from "./storage/serviceHostEnrollment";
import type {StorageContext} from "./storage/context";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close();});
type Configuration = {workspaces: unknown[]; activation: {targets: unknown[]}; hostId: string; instanceId: string};
type Hosted = ServiceHostedSet["documents"][number];
type Workspace = ServiceHostedSet["workspaces"][number];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
const bearer = (workspace: Workspace) => workspace.ordinaryReplication!.relay.bearerToken;

async function fixture(options: {beforeStart?(): Promise<void>; empty?: boolean; unavailable?: AbortSignal} = {}) {
  const f = await ticketFixture(); cleanup.push(f.close);
  if (options.unavailable) vi.spyOn(f.storage, "unavailable", "get").mockReturnValue(options.unavailable);
  // The ticket fixture provisions a device; this supervisor test starts a clean service deployment.
  f.raw.exec("DELETE FROM sync_relay_session_host_control");
  f.storage.claimWorkspaceIdentity({workspaceId: scope.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
  const root = await mkdtemp(join(tmpdir(), "dohc-self-host-supervisor-")); const data = join(root, "data"); await mkdir(data);
  cleanup.push(() => rm(root, {recursive: true, force: true}));
  const input = {workspaceId: scope.workspaceId, ownerUserId: "owner-1", shareId: scope.shareId, path: binding.currentPath, nowMs: 10, guard() {}};
  f.storage.enrollServiceHostDocument(input);
  if (options.empty) f.storage.setServiceHostEnrollmentEnabled({...input, enabled: false});
  const history = createLiveJournalHistoryAuthority({namespace: "supervisor-history", reconciled: true});
  const frameChanges = createNamedFrameChanges(8);
  // A stand-in for the service host: it records each membership update and,
  // like the engine, keeps a document that left while its unload is pending,
  // with its workspace attached.
  const pending = new Set<string>(), updates: ServiceHostedSet[] = [], attachedAfter: string[][] = [];
  let failUpdate: Error | undefined, holdUpdate: {entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>} | undefined;
  const starts: Array<{config: Configuration; configPath: string; close: ReturnType<typeof vi.fn<() => Promise<void>>>; controller: AbortController}> = [];
  let live = 0, peak = 0;
  const startHost = vi.fn(async ({configPath}: {configPath: string}) => {
    await options.beforeStart?.();
    const config = JSON.parse(await readFile(configPath, "utf8")) as Configuration;
    const controller = new AbortController(); let stopped = false, held: Hosted[] = [];
    const close = vi.fn(async () => {if (!stopped) {stopped = true; live--; controller.abort();}});
    live++; peak = Math.max(peak, live); starts.push({config, configPath, close, controller});
    const update = vi.fn(async (desired: ServiceHostedSet) => {
      const hold = holdUpdate; holdUpdate = undefined;
      if (hold) {hold.entered.resolve(); await hold.release.promise;}
      if (failUpdate) {const failure = failUpdate; failUpdate = undefined; throw failure;}
      updates.push(desired);
      const retiring = held.filter(document => !desired.documents.some(row => row.objectId === document.objectId) && pending.has(document.objectId));
      held = [...desired.documents, ...retiring];
      const attached = new Set([...desired.workspaces.map(row => row.workspaceId), ...retiring.map(row => row.workspaceId)]);
      attachedAfter.push([...attached]);
      frameChanges.notifyHost([...attached]);
      return retiring.map(({workspaceId, objectId}) => ({workspaceId, objectId}));
    });
    const isDocumentReady = (document: {workspaceId: string; objectId: string}) =>
      updates.at(-1)?.documents.some(row => row.workspaceId === document.workspaceId && row.objectId === document.objectId) ?? false;
    return {invalidated: controller.signal, close, update, isDocumentReady, onEvent: () => () => undefined} as never;
  });
  const onError = vi.fn();
  const host = await startSelfHostedLiveHost({storage: f.storage, history, root: data, engineExecutable: process.execPath,
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
  return {...f, host, history, starts, startHost, input, add, share, moment, waitStarted, waitUpdate, onError, frameChanges, updates, pending, attachedAfter, enrollment,
    peak: () => peak, failNextUpdate(error: Error) {failUpdate = error;},
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

it("starts one empty daemon and attaches the first shared document's workspace to it", async () => {
  const f = await fixture(); expect(f.host.unavailable).toBe(true); await f.waitStarted(1);
  const first = await f.waitUpdate(["docs/a.md"]), {config} = f.starts[0]!;
  expect(config.workspaces).toEqual([]); expect(config.activation.targets).toEqual([]);
  expect(first.documents).toEqual([{workspaceId: scope.workspaceId, objectId: binding.objectId, path: "docs/a.md", shareId: scope.shareId}]);
  expect(first.workspaces).toHaveLength(1);
  expect(first.workspaces[0]!.root).toMatch(/[0-9a-f]{64}$/);
  expect(first.workspaces[0]!.ordinaryReplication).toMatchObject({identity: {kind: "join", replicationEpoch: "epoch", streamIdentity: "stream"}});
});

it("adds and removes documents on the running daemon while the sibling stays hosted", async () => {
  const f = await fixture(); await f.waitStarted(1);
  const first = await f.waitUpdate(["docs/a.md"]);
  const second = f.add(); const added = await f.waitUpdate(["docs/a.md", "docs/b.md"]);
  expect(added.workspaces).toEqual(first.workspaces);
  f.storage.setServiceHostEnrollmentEnabled({...f.input, path: second.path, enabled: false});
  const removed = await f.waitUpdate(["docs/a.md"]);
  expect(removed.workspaces).toEqual(first.workspaces);
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

it("keeps a paused document's binding until its unsettled work settles, then pauses it", async () => {
  const f = await fixture(); f.add(); await f.waitStarted(1);
  await f.waitUpdate(["docs/a.md", "docs/b.md"]);
  f.pending.add(binding.objectId);
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  await f.waitUpdate(["docs/b.md"]);
  // The engine still holds unsettled work, so the next pass retries the unload and the binding stays.
  const retries = f.updates.length;
  await vi.waitFor(() => expect(f.updates.length).toBeGreaterThan(retries), {timeout: 10_000});
  expect(f.enrollment()).toMatchObject({enabled: true, retired: false, ownerStop: "pause"});
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(true);
  f.pending.delete(binding.objectId);
  await vi.waitFor(() => expect(f.enrollment()).toMatchObject({enabled: false, retired: false, ownerStop: "pause"}), {timeout: 10_000});
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(false);
  expect(f.updates.every(update => update.documents.some(row => row.path === "docs/b.md"))).toBe(true);
  expect(f.starts).toHaveLength(1); expect(f.starts[0]!.close).not.toHaveBeenCalled();
});

it("keeps a document hosted while any Edit grant covers it and retires it once its unload completes", async () => {
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
  // The host still holds unsettled work, so the next pass retries the unload and the enrollment stays.
  const retries = f.updates.length;
  await vi.waitFor(() => expect(f.updates.length).toBeGreaterThan(retries), {timeout: 10_000});
  expect(f.storage.listRetiredServiceHostEnrollments(scope.workspaceId).documents).toEqual([]);
  expect(f.storage.listServiceHostEnrollments(scope.workspaceId).map(row => row.path)).toContain("docs/a.md");
  f.pending.delete(binding.objectId);
  await vi.waitFor(() => expect(f.storage.listRetiredServiceHostEnrollments(scope.workspaceId).documents.map(row => row.path)).toEqual(["docs/a.md"]), {timeout: 10_000});
  expect(f.storage.listServiceHostEnrollments(scope.workspaceId).map(row => row.path)).toEqual(["notes/c.md", "notes/d.md"]);
  expect(f.starts).toHaveLength(1); expect(f.starts[0]!.close).not.toHaveBeenCalled();
  expect(f.updates.slice(1).every(update => update.documents.some(row => row.path === "notes/c.md"))).toBe(true);
});

it("retires the last document without stopping the daemon", async () => {
  const f = await fixture(); await f.waitStarted(1); await f.waitUpdate(["docs/a.md"]);
  expect(f.storage.revokeShareGrant({shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 20}).ok).toBe(true);
  const emptied = await f.waitUpdate([]);
  expect(emptied.workspaces).toEqual([]);
  await vi.waitFor(() => expect(f.storage.listRetiredServiceHostEnrollments(scope.workspaceId).documents.map(row => row.path)).toEqual(["docs/a.md"]), {timeout: 10_000});
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
  }
  const current = f.host.current(), updates = f.updates.length;
  // The supervisor retries every 2 s, which can clear the failure before a poll
  // sees it, so record availability when the failure is reported.
  const unavailableAtError: boolean[] = [];
  f.onError.mockImplementation(() => {unavailableAtError.push(f.host.unavailable);});
  const selection = vi.spyOn(f.storage, "listServiceHostEnrollments");
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
  expect((await f.waitUpdate([])).workspaces).toEqual([]);
  expect(f.host.ready({workspaceId: binding.workspaceId, mainVersionId: "main", objectId: binding.objectId, lineageClaimId: binding.lineageClaimId})).toBe(false);
  await vi.waitFor(() => expect(f.storage.listServiceHostEnrollments()[0]!.enabled).toBe(false), {timeout: 10_000});
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

it("omits a renamed document without stopping live hosting for the other document", async () => {
  const f = await fixture(); f.add(); await f.waitStarted(1);
  await f.waitUpdate(["docs/a.md", "docs/b.md"]);
  f.raw.prepare("UPDATE sync_relay_object_moments SET path='docs/renamed.md' WHERE workspace_id=? AND object_id=?").run(scope.workspaceId, binding.objectId);
  f.host.reconcile(); await f.waitUpdate(["docs/b.md"]);
  expect(f.starts[0]!.close).not.toHaveBeenCalled(); expect(f.starts).toHaveLength(1);
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(2);
});
