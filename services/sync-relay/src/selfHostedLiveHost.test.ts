import {mkdtemp, mkdir, readFile, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {afterEach, expect, it, vi} from "vitest";
import {startSelfHostedLiveHost} from "./selfHostedLiveHost";
import {fixture as ticketFixture, binding, scope} from "./liveTickets.test-helper";
import {createLiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import {createNamedFrameChanges} from "./liveHostChanges";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close();});
type Configuration = {workspaces: Array<{workspaceId: string; root: string; ordinaryReplication: {relay: {bearerToken: string}; identity: {replicationEpoch: string}}}>;
  activation: {targets: Array<{workspaceId: string; path: string; shareId: string}>}; hostId: string; instanceId: string};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}

async function fixture() {
  const f = await ticketFixture(); cleanup.push(f.close);
  // The ticket fixture provisions a device; this supervisor test starts a clean service deployment.
  f.raw.exec("DELETE FROM sync_relay_session_host_control");
  f.storage.claimWorkspaceIdentity({workspaceId: scope.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
  const root = await mkdtemp(join(tmpdir(), "dohc-self-host-supervisor-")); const data = join(root, "data"); await mkdir(data);
  cleanup.push(() => rm(root, {recursive: true, force: true}));
  const input = {workspaceId: scope.workspaceId, ownerUserId: "owner-1", shareId: scope.shareId, path: binding.currentPath, nowMs: 10, guard() {}};
  f.storage.enrollServiceHostDocument(input);
  const history = createLiveJournalHistoryAuthority({namespace: "supervisor-history", reconciled: true});
  const starts: Array<{config: Configuration; close: ReturnType<typeof vi.fn<() => Promise<void>>>; ready: ReturnType<typeof vi.fn<() => boolean>>; controller: AbortController}> = [];
  let live = 0, peak = 0;
  const startHost = vi.fn(async ({configPath}: {configPath: string}) => {
    const config = JSON.parse(await readFile(configPath, "utf8")) as Configuration;
    const controller = new AbortController(); let stopped = false;
    const close = vi.fn(async () => {if (!stopped) {stopped = true; live--; controller.abort();}}), ready = vi.fn(() => true);
    live++; peak = Math.max(peak, live); starts.push({config, close, ready, controller});
    return {invalidated: controller.signal, close, isDocumentReady: ready} as never;
  });
  const onError = vi.fn();
  const host = await startSelfHostedLiveHost({storage: f.storage, history, root: data, engineExecutable: process.execPath,
    relayOrigin: "https://relay.test", key: new Uint8Array(32).fill(9), frameChanges: createNamedFrameChanges(8), startHost, onError});
  cleanup.push(() => host.close());
  const waitStarted = async (count: number) => vi.waitFor(() => {expect(onError).not.toHaveBeenCalled(); expect(starts).toHaveLength(count);}, {timeout: 3_000});
  const add = (path = "docs/b.md", objectId = "object-b") => {
    f.raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
      VALUES (?,?,1,?,'main',?,?,'text',1,1)`).run(scope.workspaceId, objectId, `moment-${objectId}`, path, "b".repeat(64));
    return f.storage.enrollServiceHostDocument({...input, path});
  };
  return {...f, host, history, starts, startHost, input, add, waitStarted, onError, peak: () => peak};
}

it("adds documents with stable workspace roots and profile while draining the previous daemon first", async () => {
  const f = await fixture(); await f.waitStarted(1); const first = f.starts[0]!;
  const drained = deferred(), entered = deferred(), close = first.close.getMockImplementation()!;
  first.close.mockImplementation(async () => {entered.resolve(); await drained.promise; await close();});
  f.add(); await entered.promise;
  expect(f.starts).toHaveLength(1); expect(f.host.current()).toBeUndefined();
  drained.resolve(); await f.waitStarted(2);
  const second = f.starts[1]!;
  expect(second.config.workspaces[0]!.root).toBe(first.config.workspaces[0]!.root);
  expect(second.config.workspaces[0]!.root).toMatch(/[0-9a-f]{64}$/);
  expect(second.config.hostId).toBe(first.config.hostId); expect(second.config.instanceId).toBe(first.config.instanceId);
  expect(second.config.activation.targets.map(row => row.path)).toEqual(["docs/a.md", "docs/b.md"]);
  expect(second.config.workspaces[0]!.ordinaryReplication.relay.bearerToken).toBe(first.config.workspaces[0]!.ordinaryReplication.relay.bearerToken);
  expect(f.peak()).toBe(1);
});

it("discards a stale prepared selection when enrollment changes while the old daemon closes", async () => {
  const f = await fixture(); await f.waitStarted(1); const first = f.starts[0]!;
  const drained = deferred(), entered = deferred(), close = first.close.getMockImplementation()!;
  first.close.mockImplementation(async () => {entered.resolve(); await drained.promise; await close();});
  const second = f.add(); await entered.promise;
  f.storage.setServiceHostEnrollmentEnabled({...f.input, path: second.path, enabled: false});
  drained.resolve(); await f.waitStarted(2);
  expect(f.starts[1]!.config.activation.targets.map(row => row.path)).toEqual([binding.currentPath]);
  expect(f.peak()).toBe(1);
});

it("keeps the working daemon when the next configuration fails validation", async () => {
  const f = await fixture(); await f.waitStarted(1); const first = f.starts[0]!;
  const original = f.storage.listServiceHostEnrollments.bind(f.storage);
  vi.spyOn(f.storage, "listServiceHostEnrollments").mockImplementation(() => original().map(row => ({...row, shareId: "x".repeat(513)})));
  f.host.reconcile(); await vi.waitFor(() => expect(f.onError).toHaveBeenCalled(), {timeout: 3_000});
  expect(first.close).not.toHaveBeenCalled(); expect(f.starts).toHaveLength(1); expect(f.host.current()).toBeDefined();
});

it("retries runtime checks without rescanning unchanged shares and rescans after owner writes", async () => {
  const f = await fixture(); await f.waitStarted(1);
  const scans = vi.spyOn(f.storage, "scanServiceHostCandidateShares");
  const identity = vi.spyOn(f.storage, "verifyWorkspaceIdentity");
  f.host.reconcile();
  await vi.waitFor(() => expect(identity).toHaveBeenCalled(), {timeout: 3_000});
  expect(scans).not.toHaveBeenCalled();
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true});
  await vi.waitFor(() => expect(f.starts[0]!.close).toHaveBeenCalled(), {timeout: 3_000});
  expect(scans).toHaveBeenCalled();
  scans.mockClear();
  f.storage.enrollServiceHostDocument(f.input);
  await f.waitStarted(2);
  expect(scans).toHaveBeenCalled();
});

it.each([false, true])("clears a transient reconciliation failure after returning to a healthy selection (empty: %s)", async empty => {
  const f = await fixture(); await f.waitStarted(1);
  if (empty) {
    f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
    await vi.waitFor(() => expect(f.starts[0]!.close).toHaveBeenCalledTimes(1), {timeout: 3_000});
  }
  const current = f.host.current();
  const selection = vi.spyOn(f.storage, "listServiceHostEnrollments");
  selection.mockImplementationOnce(() => {throw new Error("Temporary enrollment read failure");});
  f.host.reconcile();
  await vi.waitFor(() => expect(f.host.unavailable).toBe(true), {timeout: 3_000});
  expect(f.onError).toHaveBeenCalledTimes(1);
  f.host.reconcile();
  await vi.waitFor(() => expect(f.host.unavailable).toBe(false), {timeout: 3_000});
  expect(f.host.current()).toBe(current);
  expect(f.starts).toHaveLength(1);
  expect(f.starts[0]!.close).toHaveBeenCalledTimes(empty ? 1 : 0);
});

it("pauses the final document without restarting it and closes owned daemons", async () => {
  const f = await fixture(); await f.waitStarted(1); const first = f.starts[0]!;
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1), {timeout: 3_000});
  expect(f.host.current()).toBeUndefined();
  expect(f.host.ready({workspaceId: binding.workspaceId, mainVersionId: "main", objectId: binding.objectId, lineageClaimId: binding.lineageClaimId})).toBe(false);
  expect(f.storage.listServiceHostEnrollments()[0]!.enabled).toBe(false);
  await f.host.close(); expect(f.starts).toHaveLength(1);
});

it("adds another owner's workspace with a separate root and scoped credential", async () => {
  const f = await fixture(); await f.waitStarted(1); const first = f.starts[0]!;
  const workspaceId = "workspace-2", ownerUserId = "owner-2", shareId = "share-2", path = "docs/other.md";
  f.storage.claimWorkspace({workspaceId, ownerUserId, createdAtMs: 1});
  f.storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch-2", streamIdentity: "stream-2"});
  f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,?,?,1)").run(shareId, workspaceId, ownerUserId, JSON.stringify({paths: ["docs"], versionId: null}));
  f.raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
    VALUES (?,'second-owner-object',1,'second-moment','main',?,?,'text',1,1)`).run(workspaceId, path, "b".repeat(64));
  f.storage.enrollServiceHostDocument({...f.input, workspaceId, ownerUserId, shareId, path}); await f.waitStarted(2);
  const workspaces = f.starts[1]!.config.workspaces;
  expect(workspaces).toHaveLength(2);
  expect(workspaces[0]!.root).toBe(first.config.workspaces[0]!.root);
  expect(workspaces[1]!.root).not.toBe(workspaces[0]!.root);
  expect(workspaces[1]!.ordinaryReplication.relay.bearerToken).not.toBe(workspaces[0]!.ordinaryReplication.relay.bearerToken);
  expect(first.close).toHaveBeenCalledTimes(1); expect(f.peak()).toBe(1);
});

it("cancels a prepared restart when the supervisor closes during drain", async () => {
  const f = await fixture(); await f.waitStarted(1); const first = f.starts[0]!;
  const drained = deferred(), entered = deferred(), close = first.close.getMockImplementation()!;
  first.close.mockImplementation(async () => {entered.resolve(); await drained.promise; await close();});
  f.add(); await entered.promise;
  const stopped = f.host.close(); drained.resolve(); await stopped;
  expect(f.starts).toHaveLength(1); expect(first.close).toHaveBeenCalledTimes(1);
  expect(f.host.current()).toBeUndefined(); expect(f.host.unavailable).toBe(true);
});

it("omits a renamed document without stopping live hosting for the other document", async () => {
  const f = await fixture(); f.add(); await f.waitStarted(1);
  const first = f.starts[0]!; expect(first.config.activation.targets).toHaveLength(2);
  f.raw.prepare("UPDATE sync_relay_object_moments SET path='docs/renamed.md' WHERE workspace_id=? AND object_id=?").run(scope.workspaceId, binding.objectId);
  f.host.reconcile(); await f.waitStarted(2);
  expect(f.starts[1]!.config.activation.targets.map(row => row.path)).toEqual(["docs/b.md"]);
  expect(first.close).toHaveBeenCalledTimes(1); expect(f.peak()).toBe(1);
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(2);
});
