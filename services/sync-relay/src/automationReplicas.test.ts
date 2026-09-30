import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeAutomationReplication, deriveAutomationReplicaBearer } from "./automationReplicaCredential";
import { removeAutomationReplicas, startAutomationReplicas } from "./automationReplicas";
import { createServiceHostReplication } from "./serviceHostReplication";
import { deriveServiceHostBearer } from "./serviceHostCredential";
import type { SyncRelayStorage } from "./storage";
import { AUTOMATION_WORKSPACE_KEEP_AFTER_LEAVING_MS, AUTOMATION_WORKSPACE_LEAVE_AFTER_MS } from "./storage/automationWorkspaces";
import { closeTestStorages, inspectDatabase, storagePath, testStorage } from "./testing";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("@dohc/workspace-engine-client/daemon", async (importOriginal) => ({
  ...await importOriginal<typeof import("@dohc/workspace-engine-client/daemon")>(), createEngineClient: spawn,
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  spawn.mockReset();
  closeTestStorages();
});

const WORKSPACE = "workspace-trip";
const key = new Uint8Array(32).fill(7), namespace = "automation-replica-test";

async function relay() {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: WORKSPACE, ownerUserId: "owner", createdAtMs: 1 });
  storage.claimWorkspaceIdentity({ workspaceId: WORKSPACE, replicationEpoch: "epoch-1", streamIdentity: "stream-1" });
  const raw = inspectDatabase(storagePath(storage));
  const log = (seq: number) => raw.prepare(
    "INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) VALUES (?, 'desk', ?, 'moment.append', '{}', 1)",
  ).run(WORKSPACE, seq);
  return { storage, raw, log };
}

// An accepted press from a shared view, taken by `acceptedBy`.
function acceptedPress(raw: ReturnType<typeof inspectDatabase>, hostPressId: string, acceptedBy: string) {
  raw.prepare(
    `INSERT INTO sync_relay_automation_presses (host_press_id, workspace_id, share_id, grant_id, grant_generation, press_id, user_id,
       automation_id, collection_path, definition_hash, record_id, state, accepted_by, outcome, error, created_at_ms, updated_at_ms)
     VALUES (?, ?, 'share', 'grant', 1, ?, 'ana', 'collection:Tasks#pay', 'Tasks', '0123456789abcdef', 'r1', 'accepted', ?, NULL, NULL, 1, 1)`,
  ).run(hostPressId, WORKSPACE, hostPressId, acceptedBy);
}
const pressState = (raw: ReturnType<typeof inspectDatabase>, hostPressId: string) =>
  raw.prepare("SELECT state, outcome FROM sync_relay_automation_presses WHERE host_press_id = ?").get(hostPressId);

describe("the workspaces this server keeps a replica of", () => {
  it("joins once per identity, and a changed identity starts a new incarnation that ends the presses the server took", async () => {
    const { storage, raw } = await relay();
    const first = storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 10 })!;
    expect(first).toMatchObject({ ownerUserId: "owner", replicationEpoch: "epoch-1", streamIdentity: "stream-1", incarnation: 1, startedAtMs: 10 });
    expect(storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 20 })).toEqual(first);

    acceptedPress(raw, "taken-here", "server");
    acceptedPress(raw, "taken-there", "laptop");
    storage.rotateWorkspaceIdentity({ workspaceId: WORKSPACE, ownerUserId: "owner", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 30 });
    expect(storage.currentAutomationWorkspace(WORKSPACE), "the old replica's credential stops").toBeNull();
    const second = storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 40 })!;
    expect(second).toMatchObject({ replicationEpoch: "epoch-2", incarnation: 2, startedAtMs: 40 });
    expect(second.credentialNonce).not.toBe(first.credentialNonce);
    expect(pressState(raw, "taken-here")).toEqual({ state: "settled", outcome: "ended" });
    expect(pressState(raw, "taken-there")).toEqual({ state: "accepted", outcome: null });
    expect(storage.joinAutomationWorkspace({ workspaceId: "unknown", nowMs: 1 })).toBeNull();
  });

  it("leaves a day after no condition needs it, and rejoins as it was", async () => {
    const { storage } = await relay();
    const joined = storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 })!;
    expect(storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 100 })).toBeNull();
    expect(storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 100 + AUTOMATION_WORKSPACE_LEAVE_AFTER_MS - 1 })).toBeNull();
    const left = storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 100 + AUTOMATION_WORKSPACE_LEAVE_AFTER_MS });
    expect(left).toMatchObject({ leftAtMs: 100 + AUTOMATION_WORKSPACE_LEAVE_AFTER_MS });
    expect(storage.currentAutomationWorkspace(WORKSPACE)).toBeNull();
    expect(storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 200 })).toEqual(joined);
    expect(storage.currentAutomationWorkspace(WORKSPACE)).toEqual(joined);
  });

  it("lists the workspaces whose automation host is the server, running or handing over", async () => {
    const { storage, raw } = await relay();
    storage.claimWorkspace({ workspaceId: "other", ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspace({ workspaceId: "laptop-only", ownerUserId: "owner", createdAtMs: 1 });
    const host = raw.prepare("INSERT INTO sync_relay_automation_hosts (workspace_id, install_id, generation, handover_from) VALUES (?, ?, 1, ?)");
    host.run(WORKSPACE, "server", null);
    host.run("other", "laptop", "server");
    host.run("laptop-only", "laptop", null);
    expect(storage.serverHostedWorkspaces()).toEqual(["other", WORKSPACE]);
  });
});

describe("the automation replica's credential", () => {
  it("replicates only its own workspace, as its owner, while the replica is current", async () => {
    const { storage } = await relay();
    const row = storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 })!;
    const bearer = deriveAutomationReplicaBearer(row, { key, namespace });
    expect(bearer).toMatch(/^dohc-automation-v1\./u);
    const authorize = (input: { workspaceId?: string; bearer?: string; pathname?: string; method?: string }) => authorizeAutomationReplication(storage, {
      key, namespace, workspaceId: WORKSPACE, bearer, method: "GET", pathname: `/sync/${WORKSPACE}/bootstrap`, ...input,
    });
    expect(authorize({})).toBe("owner");
    expect(authorize({ pathname: `/sync/${WORKSPACE}/log`, method: "POST" }), "a push").toBe("owner");
    expect(authorize({ pathname: `/sync/${WORKSPACE}/live-host` }), "not replication").toBeNull();
    expect(authorize({ pathname: "/sync/workspaces" })).toBeNull();
    expect(authorize({ workspaceId: "other", pathname: "/sync/other/bootstrap" })).toBeNull();
    expect(authorize({ bearer: deriveAutomationReplicaBearer(row, { key: new Uint8Array(32).fill(8), namespace }) })).toBeNull();
    expect(authorize({ bearer: deriveAutomationReplicaBearer({ ...row, incarnation: 2 }, { key, namespace }) })).toBeNull();
    // A service host credential for the same values never verifies here.
    const service = deriveServiceHostBearer({ ...row, objectId: "o", path: "p", shareId: "s", enabled: true, retired: false,
      createdAtMs: 0, updatedAtMs: 0, accountedBytes: 0 } as Parameters<typeof deriveServiceHostBearer>[0], { key, namespace });
    expect(authorize({ bearer: service })).toBeNull();

    const handler = createServiceHostReplication({ storage, prefix: "dohc-automation-v1.",
      authorize: (input) => authorizeAutomationReplication(storage, { key, namespace, ...input }) });
    const get = (path: string, token = bearer) => handler(new Request(`https://relay.test${path}`, { headers: { authorization: `Bearer ${token}` } }));
    expect((await get(`/sync/${WORKSPACE}/bootstrap`)).status).toBe(200);
    expect((await get("/sync/workspaces")).status).toBe(404);
    // A push checks the credential again inside its write.
    const push = await handler(new Request(`https://relay.test/sync/${WORKSPACE}/log`, {
      method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ replicationEpoch: "epoch-1", streamIdentity: "stream-1", originId: "server-replica", ops: [
        { originSeq: 0, opKind: "moment.append", recordedAtMs: 10, payload: { operation: "write" } }] }),
    }));
    expect(push.status, await push.clone().text()).toBe(200);
    expect(await push.json()).toMatchObject({ inserted: 1 });
    // Waiting to leave, it reads but writes nothing.
    storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    expect(authorize({}), "a read").toBe("owner");
    expect(authorize({ pathname: `/sync/${WORKSPACE}/log`, method: "POST" }), "a push").toBeNull();
    expect(authorize({ pathname: `/sync/${WORKSPACE}/blobs/${"a".repeat(64)}`, method: "PUT" }), "a blob").toBeNull();
    storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: AUTOMATION_WORKSPACE_LEAVE_AFTER_MS });
    expect((await get(`/sync/${WORKSPACE}/bootstrap`)).status, "left").toBe(404);
  });
});

describe("the automation replicas", () => {
  type Sent = { method: string; params: Record<string, unknown>; workspace?: string };

  // An engine daemon that opens each workspace and answers ordinary replication.
  function fakeEngine() {
    const sent: Sent[] = [];
    let failPush = false;
    const engines: Array<{ exit(): void }> = [];
    spawn.mockImplementation(async (spawned: { env?: Record<string, string>; onExit?: () => void }) => {
      expect(spawned.env?.DOHC_ENGINE_LIVE_HOST_CONFIG, "a plain engine, not the live host's").toBeUndefined();
      let handles = 0;
      const engine = {
        sendRequest: vi.fn(async (request: Sent) => {
          sent.push(request);
          if (request.method === "sync.push" && failPush) throw new Error("replica cannot push");
          switch (request.method) {
            case "workspace.open": return { result: { workspace: `handle-${++handles}` } };
            case "workspace.close": return { result: {} };
            case "sync.adoptJoinIdentity": return { result: { adopted: true } };
            case "versions.ensureMain": return { result: { id: "main" } };
            case "sync.push": return { result: { status: "complete", pushed: 0, hasMore: false, sharingDeclined: [], ownerAdmissionPending: [] } };
            case "sync.materializePendingCursor": return { result: { materialized: true } };
            case "sync.commitCursor": return { result: { committed: true, sharingDeclined: [] } };
            case "sync.pull": return { result: { status: "complete", nextCursor: 1, pendingCursor: { kind: "relay", token: "t" }, hasMore: false,
              fetched: 0, applied: 0, refused: 0, skipped: 0, conflictsOpened: 0, refusals: [], sharingDeclined: [],
              changedPaths: [{ versionId: "main", path: "Tasks/automations.yaml", operation: "write", contentKind: "text" }] } };
            default: throw new Error(`unexpected ${request.method}`);
          }
        }),
        close: vi.fn(), waitForExit: vi.fn(async () => undefined),
      };
      engines.push({ exit: () => spawned.onExit?.() });
      return engine;
    });
    return { sent, engines, failPush: (value: boolean) => { failPush = value; }, methods: () => sent.map((request) => request.method) };
  }

  async function replicas(
    storage: SyncRelayStorage,
    wanted: () => string[],
    clock: { ms: number },
    onError: (error: unknown) => void = (error) => { throw error; },
    onPulled?: (workspaceId: string, paths: readonly string[]) => void,
  ) {
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const started = await startAutomationReplicas({ storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example",
      key, namespace, wanted, nowMs: () => clock.ms, onError, ...(onPulled ? { onPulled } : {}) });
    cleanup.push(async () => { await started.close(); await rm(root, { recursive: true, force: true }); });
    await started.settled();
    return { replicas: started, root };
  }

  it("checks the daemon even without workspaces, and reports its exit until it restarts", async () => {
    const { storage } = await relay();
    const engine = fakeEngine();
    const { replicas: running } = await replicas(storage, () => [], { ms: 0 });
    expect(engine.engines).toHaveLength(1);
    expect(running.unavailable).toBe(false);
    engine.engines[0]!.exit();
    expect(running.unavailable).toBe(true);
    await running.settled();
    expect(engine.engines).toHaveLength(2);
    expect(running.unavailable).toBe(false);
    await running.close();
    expect(running.unavailable).toBe(true);
  });

  it("reports an engine startup failure and recovers after a successful start", async () => {
    const { storage } = await relay();
    const errors: unknown[] = [];
    fakeEngine();
    spawn.mockRejectedValueOnce(new Error("engine failed to start"));
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const running = await startAutomationReplicas({storage, root, engineExecutable: process.execPath,
      relayOrigin: "https://relay.example", key, namespace, wanted: () => [], onError: error => errors.push(error)});
    cleanup.push(async () => { await running.close(); await rm(root, {recursive: true, force: true}); });
    expect(running.unavailable).toBe(true);
    await vi.waitFor(() => expect(errors).toHaveLength(1), {timeout: 30_000});
    expect(running.unavailable).toBe(true);
    await running.settled();
    expect(running.unavailable).toBe(false);
  });

  it("reports a failed push without taking the server down and retries without a new relay write", async () => {
    const { storage } = await relay();
    const engine = fakeEngine();
    const { replicas: running } = await replicas(storage, () => [WORKSPACE], { ms: 0 });
    expect(running.unavailable).toBe(false);
    engine.failPush(true);
    await expect(running.replica(WORKSPACE)!.sync()).rejects.toThrow("replica cannot push");
    expect(running.failedSyncs().get(WORKSPACE)).toEqual(new Error("replica cannot push"));
    expect(running.unavailable).toBe(false);
    engine.failPush(false);
    await running.settled();
    expect(running.unavailable).toBe(false);
    expect(running.failedSyncs().size).toBe(0);
    expect(engine.methods().filter(method => method === "sync.push")).toHaveLength(3);
  });

  it("opens a replica for each wanted workspace, joins its identity, and pulls when its log moves", async () => {
    const { storage, log } = await relay();
    const engine = fakeEngine();
    const clock = { ms: 5 };
    const pulled: Array<[string, readonly string[]]> = [];
    const { replicas: running } = await replicas(storage, () => [WORKSPACE], clock, undefined, (workspaceId, paths) => pulled.push([workspaceId, paths]));
    const replica = running.replica(WORKSPACE)!;
    expect(replica).toMatchObject({ workspaceId: WORKSPACE, ownerUserId: "owner", incarnation: 1, startedAtMs: 5, workspace: "handle-1" });
    expect(pulled, "the executor hears which files a pull wrote").toEqual([[WORKSPACE, ["Tasks/automations.yaml"]]]);
    const open = engine.sent.find((request) => request.method === "workspace.open")!;
    expect(open.params).toMatchObject({ workspaceId: WORKSPACE, captureMode: "none", reconcileCollections: true, rootDir: replica.root,
      relay: { baseUrl: "https://relay.example", bearerToken: deriveAutomationReplicaBearer(storage.currentAutomationWorkspace(WORKSPACE)!, { key, namespace }) } });
    expect(replica.metadataDir.startsWith(replica.root)).toBe(false);
    expect(engine.methods()).toEqual(["workspace.open", "versions.ensureMain", "sync.adoptJoinIdentity", "sync.push", "sync.pull", "sync.materializePendingCursor", "sync.commitCursor"]);

    // Nothing changed at the relay: a pass pulls nothing.
    running.reconcile();
    await running.settled();
    expect(engine.methods().filter((method) => method === "sync.pull")).toHaveLength(1);
    log(1);
    running.reconcile();
    await running.settled();
    expect(engine.methods().filter((method) => method === "sync.pull")).toHaveLength(2);
  });

  it("stops pulling a replica nothing needs any more", async () => {
    const { storage, log } = await relay();
    const engine = fakeEngine();
    let wanted = [WORKSPACE];
    const { replicas: running } = await replicas(storage, () => wanted, { ms: 0 });
    wanted = [];
    log(1);
    running.reconcile(); await running.settled();
    expect(running.replica(WORKSPACE), "it waits a day to leave").toBeDefined();
    expect(engine.methods().filter((method) => method === "sync.pull")).toHaveLength(1);
  });

  it("closes a replica whose workspace was deleted, and removes every folder no row names", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    let wanted = [WORKSPACE];
    const { replicas: running, root } = await replicas(storage, () => wanted, { ms: 0 });
    const replica = running.replica(WORKSPACE)!;
    await mkdir(join(root, "0".repeat(64)));
    // Deleting the workspace deletes its host record and replica row with it.
    raw.prepare("DELETE FROM sync_relay_workspaces WHERE workspace_id = ?").run(WORKSPACE);
    wanted = [];
    running.reconcile(); await running.settled();
    expect(running.replica(WORKSPACE)).toBeUndefined();
    expect(replica.signal.aborted).toBe(true);
    expect(engine.methods()).toContain("workspace.close");
    expect(readdirSync(root)).toEqual([]);
  });

  it("removes every copy and row when the server no longer runs automations", async () => {
    const { storage } = await relay();
    fakeEngine();
    const { replicas: running, root } = await replicas(storage, () => [WORKSPACE], { ms: 0 });
    await running.close();
    await removeAutomationReplicas(storage, root);
    expect(existsSync(root)).toBe(false);
    expect(storage.listAutomationWorkspaces()).toEqual([]);
  });

  it("closes a replica a day after no condition needs it, and forgets it when its retention ends", async () => {
    const { storage } = await relay();
    const engine = fakeEngine();
    const clock = { ms: 0 };
    let wanted = [WORKSPACE];
    const { replicas: running, root } = await replicas(storage, () => wanted, clock);
    const folder = readdirSync(root)[0]!;
    wanted = [];
    running.reconcile(); await running.settled();
    expect(running.replica(WORKSPACE), "it waits a day").toBeDefined();
    clock.ms = AUTOMATION_WORKSPACE_LEAVE_AFTER_MS;
    running.reconcile(); await running.settled();
    expect(running.replica(WORKSPACE)).toBeUndefined();
    expect(engine.methods()).toContain("workspace.close");
    expect(existsSync(join(root, folder)), "kept for Undo and run history").toBe(true);
    clock.ms += AUTOMATION_WORKSPACE_KEEP_AFTER_LEAVING_MS;
    running.reconcile(); await running.settled();
    expect(existsSync(join(root, folder))).toBe(false);
    expect(storage.listAutomationWorkspaces()).toEqual([]);
  });

  it("replaces a replica whose workspace identity changed, and reopens every replica after its engine exits", async () => {
    const { storage } = await relay();
    const engine = fakeEngine();
    const clock = { ms: 1 };
    const { replicas: running } = await replicas(storage, () => [WORKSPACE], clock);
    const first = running.replica(WORKSPACE)!;
    storage.rotateWorkspaceIdentity({ workspaceId: WORKSPACE, ownerUserId: "owner", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 2 });
    running.reconcile(); await running.settled();
    const second = running.replica(WORKSPACE)!;
    expect(first.signal.aborted).toBe(true);
    expect(second).toMatchObject({ incarnation: 2 });
    expect(existsSync(first.root), "the old incarnation's replica goes").toBe(false);

    engine.engines[0]!.exit();
    expect(second.signal.aborted).toBe(true);
    await running.settled();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(running.replica(WORKSPACE)).toMatchObject({ incarnation: 2, workspace: "handle-1" });
  });

  it("closes a replica that never opened fully, and tries again later", async () => {
    const { storage } = await relay();
    const engine = fakeEngine();
    const errors: unknown[] = [];
    const failing = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (spawned: never) => {
      const client = await failing(spawned);
      const answer = client.sendRequest.getMockImplementation()!;
      client.sendRequest.mockImplementation(async (request: Sent) =>
        request.method === "sync.adoptJoinIdentity" ? (engine.sent.push(request), { result: { adopted: false } }) : answer(request));
      return client;
    });
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const running = await startAutomationReplicas({ storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example",
      key, namespace, wanted: () => [WORKSPACE], onError: (error) => errors.push(error) });
    cleanup.push(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(running.replica(WORKSPACE)).toBeUndefined();
    expect(engine.methods().slice(0, 4)).toEqual(["workspace.open", "versions.ensureMain", "sync.adoptJoinIdentity", "workspace.close"]);
  });

  it("keeps opening, pulling, and letting go of the others while one workspace always fails", async () => {
    // Only the timers are fake: each pass still does real file work, and the test waits for it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage, log } = await relay();
    for (const workspaceId of ["broken", "leaving"]) {
      storage.claimWorkspace({ workspaceId, ownerUserId: "owner", createdAtMs: 1 });
      storage.claimWorkspaceIdentity({ workspaceId, replicationEpoch: "epoch-1", streamIdentity: "stream-1" });
    }
    const engine = fakeEngine();
    // The engine refuses every open of one workspace.
    const answer = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (spawned: Parameters<typeof answer>[0]) => {
      const client = await answer(spawned);
      const send = client.sendRequest.getMockImplementation()!;
      client.sendRequest.mockImplementation(async (request: Sent) => {
        if (request.method === "workspace.open" && request.params.workspaceId === "broken") {
          engine.sent.push(request);
          throw new Error("the engine refused this workspace");
        }
        return await send(request);
      });
      return client;
    });
    // "leaving" has not been wanted for a day.
    storage.joinAutomationWorkspace({ workspaceId: "leaving", nowMs: 0 });
    storage.unwantAutomationWorkspace({ workspaceId: "leaving", nowMs: 0 });
    const clock = { ms: AUTOMATION_WORKSPACE_LEAVE_AFTER_MS };
    const errors: Array<[unknown, string | undefined]> = [];
    let passes = 0;
    const waiting: Array<() => void> = [];
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const running = await startAutomationReplicas({ storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example",
      key, namespace, wanted: () => ["broken", WORKSPACE], nowMs: () => clock.ms,
      onError: (error, workspaceId) => errors.push([error, workspaceId]),
      onReconciled: () => { passes += 1; for (const resolve of waiting.splice(0)) resolve(); } });
    cleanup.push(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
    const nextPass = () => new Promise<void>((resolve) => waiting.push(resolve));
    const first = nextPass();
    await vi.advanceTimersByTimeAsync(0);
    await first;

    expect(running.replica(WORKSPACE), "the workspace after the broken one opens").toBeDefined();
    expect(running.replica("broken")).toBeUndefined();
    expect([...running.failedSyncs().keys()]).toEqual(["broken"]);
    expect(running.unavailable, "a completed pass keeps the server on").toBe(false);
    expect(errors.map(([, workspaceId]) => workspaceId)).toEqual(["broken"]);
    expect(storage.listAutomationWorkspaces().find((row) => row.workspaceId === "leaving")?.leftAtMs, "an unwanted copy still leaves on time")
      .toBe(AUTOMATION_WORKSPACE_LEAVE_AFTER_MS);

    // A write to the good workspace still pulls it, and the broken one keeps being tried.
    const pulls = () => engine.sent.filter((request) => request.method === "sync.pull" && request.workspace === running.replica(WORKSPACE)!.workspace).length;
    // The first pass's joins asked for one more; after it only the broken one's retry is left.
    const second = nextPass();
    await vi.advanceTimersByTimeAsync(100);
    await second;
    // The pass ends, and arms the broken one's retry, a tick after it reports.
    await vi.advanceTimersByTimeAsync(0);
    const before = pulls();
    log(1);
    // Asked for now, the pass runs at once, not after the broken one's retry delay.
    const asked = nextPass();
    running.reconcile();
    await vi.advanceTimersByTimeAsync(100);
    await asked;
    expect(pulls()).toBe(before + 1);
    expect(running.failedSyncs().has("broken")).toBe(true);
    expect(passes).toBeGreaterThanOrEqual(1);
  });

  it("pulls a busy workspace a bounded amount per pass, so the next one is pulled too", async () => {
    const { storage } = await relay();
    storage.claimWorkspace({ workspaceId: "busy", ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({ workspaceId: "busy", replicationEpoch: "epoch-1", streamIdentity: "stream-1" });
    const engine = fakeEngine();
    // The busy workspace's pulls always have more.
    const answer = spawn.getMockImplementation()!;
    let busyHandle: string | undefined;
    spawn.mockImplementation(async (spawned: Parameters<typeof answer>[0]) => {
      const client = await answer(spawned);
      const send = client.sendRequest.getMockImplementation()!;
      client.sendRequest.mockImplementation(async (request: Sent) => {
        const result = await send(request) as { result: Record<string, unknown> };
        if (request.method === "workspace.open" && request.params.workspaceId === "busy") busyHandle = result.result.workspace as string;
        if (request.method === "sync.pull" && request.workspace === busyHandle && busyHandle !== undefined && opened) {
          return { result: { ...result.result, hasMore: true, nextCursor: ++cursor } };
        }
        return result;
      });
      return client;
    });
    // Its pulls have more from the start, even while it first opens.
    let opened = true, cursor = 1;
    const clock = { ms: 5 };
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const running = await startAutomationReplicas({ storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example",
      key, namespace, wanted: () => ["busy", WORKSPACE], nowMs: () => clock.ms, onError: (error) => { throw error; } });
    cleanup.push(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
    // The busy one never catches up, and the quiet one still opens.
    await vi.waitFor(() => expect(running.replica(WORKSPACE)).toBeDefined());
    const pulls = (handle: string) => engine.sent.filter((request) => request.method === "sync.pull" && request.workspace === handle).length;
    const busy = running.replica("busy")!, quiet = running.replica(WORKSPACE)!;
    const [busyBefore, quietBefore] = [pulls(busy.workspace), pulls(quiet.workspace)];
    const raw = inspectDatabase(storagePath(storage));
    for (const workspaceId of ["busy", WORKSPACE]) {
      raw.prepare("INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) VALUES (?, 'desk', 1, 'moment.append', '{}', 1)").run(workspaceId);
    }
    raw.close();
    running.reconcile();
    await vi.waitFor(() => expect(pulls(quiet.workspace), "the quiet workspace is pulled").toBe(quietBefore + 1));
    // At most four rounds of eight pages for the busy one before the quiet one.
    expect(pulls(busy.workspace) - busyBefore).toBeLessThanOrEqual(32);
    expect(pulls(busy.workspace) - busyBefore).toBeGreaterThan(0);
  });

  it("waits longer after each failed pass", async () => {
    fakeEngine();
    vi.useFakeTimers();
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    const errors: number[] = [];
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const running = await startAutomationReplicas({ storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example",
      key, namespace, wanted: () => { throw new Error("The host records did not read."); }, onError: () => errors.push(Date.now()) });
    cleanup.push(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
    const start = Date.now();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(errors.map((at) => at - start)).toEqual([0, 2_000, 6_000, 14_000]);
  });

  it("wakes by itself to let a replica leave a day after it stopped being wanted", async () => {
    fakeEngine();
    vi.useFakeTimers();
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    const start = Date.now();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: start });
    storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: start });
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    // Each pass reads and writes real folders, which fake time does not wait
    // for, so the test waits for the pass itself to end.
    const waiting: Array<() => void> = [];
    const nextPass = () => new Promise<void>((resolve) => waiting.push(resolve));
    const opened = nextPass();
    const running = await startAutomationReplicas({ storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example",
      key, namespace, wanted: () => [], onError: (error) => { throw error; },
      onReconciled: () => { for (const resolve of waiting.splice(0)) resolve(); } });
    cleanup.push(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
    await vi.advanceTimersByTimeAsync(0);
    // Its deadline is armed when the pass ends, before time moves on.
    await opened;
    expect(storage.currentAutomationWorkspace(WORKSPACE), "it waits a day").not.toBeNull();
    // No relay write happens; the deadline alone wakes the replicas.
    const leaving = nextPass();
    await vi.advanceTimersByTimeAsync(AUTOMATION_WORKSPACE_LEAVE_AFTER_MS);
    // The pass the deadline asks for fires right after it.
    await vi.advanceTimersByTimeAsync(1);
    await leaving;
    expect(storage.currentAutomationWorkspace(WORKSPACE)).toBeNull();
    expect(storage.listAutomationWorkspaces()[0]?.leftAtMs).toBeGreaterThanOrEqual(start + AUTOMATION_WORKSPACE_LEAVE_AFTER_MS);
  });
});
