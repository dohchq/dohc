import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
import { notifyRelayWrite } from "./relayWriteChanges";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("@dohc/workspace-engine-client/daemon", async (importOriginal) => ({
  ...await importOriginal<typeof import("@dohc/workspace-engine-client/daemon")>(), createEngineClient: spawn,
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  // Every cleanup runs even after one fails; the first failure is reported once all have run.
  let failure: { error: unknown } | undefined;
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { failure ??= { error }; }
  }
  spawn.mockReset();
  closeTestStorages();
  if (failure) throw failure.error;
});

const WORKSPACE = "workspace-trip";
const key = new Uint8Array(32).fill(7), namespace = "automation-replica-test";
// vi.waitFor has its own 1 s default, independent of the package's expect.poll timeout.
const WAIT_TIMEOUT_MS = 10_000;

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
    // An automation replica retains the client author boundary, including native-shaped moments.
    let originSeq = 1;
    for (const author of [{kind: "human", humanId: "recipient", humanName: "Recipient"},
      {kind: "link", publicPrincipalId: "public-link", label: "Link editor"}, {kind: "unattributed", humanId: "recipient"}]) {
      const refused = await handler(new Request(`https://relay.test/sync/${WORKSPACE}/log`, {
        method: "POST", headers: {authorization: `Bearer ${bearer}`, "content-type": "application/json"},
        body: JSON.stringify({replicationEpoch: "epoch-1", streamIdentity: "stream-1", originId: "server-replica", ops: [
          {originSeq, opKind: "moment.append", recordedAtMs: 10, payload: {momentId: `moment-ydoc-${"a".repeat(64)}`, authors: [author]}}]}),
      }));
      expect(refused.status).toBe(200);
      expect(await refused.json()).toMatchObject({accepted: 1, inserted: 1,
        settlementRefusals: [{originSeq, settlementId: "unavailable", reason: "authorship-mismatch"}]});
      const stored = storage.fetchLogCoordinate({workspaceId: WORKSPACE, originId: "server-replica", originSeq})!;
      expect(stored.settlementAdmission).toMatchObject({status: "refused"});
      expect(stored.admittedAuthorSnapshot).toBeUndefined();
      expect(JSON.parse(stored.payloadJson).authors).toBeUndefined();
      originSeq++;
    }
    const later = await handler(new Request(`https://relay.test/sync/${WORKSPACE}/log`, {
      method: "POST", headers: {authorization: `Bearer ${bearer}`, "content-type": "application/json"},
      body: JSON.stringify({replicationEpoch: "epoch-1", streamIdentity: "stream-1", originId: "server-replica",
        ops: [{originSeq, opKind: "moment.append", recordedAtMs: 11, payload: {operation: "write"}}]}),
    }));
    expect(later.status).toBe(200);
    expect(await later.json()).toMatchObject({accepted: 1, inserted: 1, currentMaxOriginSeq: originSeq});
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
    let failingWorkspace: string | undefined;
    const engines: Array<{ exit(): void; close: ReturnType<typeof vi.fn>; waitForExit: ReturnType<typeof vi.fn> }> = [];
    spawn.mockImplementation(async (spawned: { env?: Record<string, string>; onExit?: () => void }) => {
      expect(spawned.env?.DOHC_ENGINE_LIVE_HOST_CONFIG, "a plain engine, not the live host's").toBeUndefined();
      const configPath = spawned.env?.DOHC_ENGINE_OWNER_HOST_CONFIG;
      expect(configPath).toBeTypeOf("string");
      expect(JSON.parse(readFileSync(configPath!, "utf8"))).toHaveProperty("ingress.aggregateBytes");
      let handles = 0;
      const engine = {
        sendRequest: vi.fn(async (request: Sent) => {
          sent.push(request);
          if (request.method === "sync.push" && failPush && (!failingWorkspace || request.workspace === failingWorkspace)) throw new Error("replica cannot push");
          switch (request.method) {
            case "workspace.open": return { result: { workspace: `handle-${++handles}` } };
            case "workspace.close": return { result: {} };
            case "sync.adoptJoinIdentity": return { result: { adopted: true } };
            case "versions.ensureMain": return { result: { id: "main" } };
            case "sync.push": return { result: { status: "complete", pushed: 0, nextSettledHeadPublishAtMs: null, hasMore: false, sharingDeclined: [], ownerAdmissionPending: [] } };
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
      engines.push({ exit: () => spawned.onExit?.(), close: engine.close, waitForExit: engine.waitForExit });
      return engine;
    });
    return { sent, engines, failPush: (value: boolean, workspace?: string) => { failPush = value; failingWorkspace = workspace; }, methods: () => sent.map((request) => request.method) };
  }

  // The engine refuses to open the workspaces `refused` names.
  function refuseOpens(engine: ReturnType<typeof fakeEngine>, refused: (workspaceId: unknown) => boolean) {
    const answer = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (spawned: Parameters<typeof answer>[0]) => {
      const client = await answer(spawned);
      const send = client.sendRequest.getMockImplementation()!;
      client.sendRequest.mockImplementation(async (request: Sent) => {
        if (request.method === "workspace.open" && refused(request.params.workspaceId)) {
          engine.sent.push(request);
          throw new Error("the engine refused this workspace");
        }
        return await send(request);
      });
      return client;
    });
  }

  function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }

  // Answers a function that holds each engine start from then until it is called.
  function holdStartups() {
    const answer = spawn.getMockImplementation()!;
    let held: Promise<void> = Promise.resolve();
    spawn.mockImplementation(async (spawned: Parameters<typeof answer>[0]) => { await held; return await answer(spawned); });
    return () => {
      const started = gate();
      held = started.promise;
      return started.resolve;
    };
  }

  // Fake time does not wait for a pass's file work, so a test waits for the pass's end.
  function passEnds() {
    const waiting: Array<() => void> = [];
    return { onReconciled: () => { for (const resolve of waiting.splice(0)) resolve(); }, next: () => new Promise<void>((resolve) => waiting.push(resolve)) };
  }

  // One turn of the event loop: whatever only waited on promises has run.
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

  // Errors no test expects: the test fails if one is reported before it ends.
  function unexpectedErrors() {
    const errors: unknown[] = [];
    cleanup.push(async () => { expect(errors).toEqual([]); });
    return (error: unknown) => { errors.push(error); };
  }

  async function start(storage: SyncRelayStorage, options: Partial<Parameters<typeof startAutomationReplicas>[0]> = {}, closes = true) {
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const running = await startAutomationReplicas({ storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example",
      key, namespace, wanted: () => [], onError: unexpectedErrors(), ...options });
    cleanup.push(async () => { if (closes) await running.close(); await rm(root, { recursive: true, force: true }); });
    return running;
  }

  async function replicas(
    storage: SyncRelayStorage,
    wanted: () => string[],
    clock: { ms: number },
    onError: (error: unknown) => void = unexpectedErrors(),
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

  it("keeps the owner ingress configuration through replica cleanup and an engine restart", async () => {
    const {storage, raw} = await relay();
    const engine = fakeEngine();
    let wanted = [WORKSPACE];
    const {replicas: running, root} = await replicas(storage, () => wanted, {ms: 0});
    const configPath = (spawn.mock.calls[0]![0] as {env: Record<string, string>}).env.DOHC_ENGINE_OWNER_HOST_CONFIG!;
    expect(existsSync(configPath)).toBe(true);
    await mkdir(join(root, "unused-replica"));
    raw.prepare("DELETE FROM sync_relay_workspaces WHERE workspace_id = ?").run(WORKSPACE);
    wanted = [];
    running.reconcile();
    await running.settled();
    expect(readdirSync(root)).toEqual([configPath.slice(root.length + 1)]);
    engine.engines[0]!.exit();
    await running.settled();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect((spawn.mock.calls[1]![0] as {env: Record<string, string>}).env.DOHC_ENGINE_OWNER_HOST_CONFIG).toBe(configPath);
    expect(running.unavailable).toBe(false);
    await running.close();
    expect(existsSync(configPath)).toBe(false);
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

  it("backs off a failing first open while healthy writes wake passes, then resets after success", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage, raw, log } = await relay();
    storage.claimWorkspace({ workspaceId: "healthy", ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({ workspaceId: "healthy", replicationEpoch: "epoch-1", streamIdentity: "stream-1" });
    const engine = fakeEngine();
    let refusing = true;
    const opens: number[] = [];
    refuseOpens(engine, workspaceId => {
      if (workspaceId !== WORKSPACE) return false;
      opens.push(performance.now());
      return refusing;
    });
    const passes = passEnds();
    const errors: unknown[] = [];
    const running = await start(storage, { wanted: () => [WORKSPACE, "healthy"],
      onReconciled: passes.onReconciled, onError: error => errors.push(error) });
    const first = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await first;
    const counts: Array<[number, number]> = [[0, opens.length]];
    for (let seq = 1; seq <= 140; seq++) {
      raw.prepare("INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) VALUES ('healthy', 'desk', ?, 'moment.append', '{}', 1)").run(seq);
      notifyRelayWrite(storage);
      const written = passes.next();
      await vi.advanceTimersByTimeAsync(100);
      await written;
      expect(running.replica("healthy")!.pulledHead).toBe(storage.automationWorkspaceLogHead("healthy"));
      if ([1_900, 2_000, 5_900, 6_000, 13_900, 14_000].includes(performance.now())) {
        counts.push([performance.now(), opens.length]);
      }
    }
    expect(counts, "open attempts at the boundaries of doubling backoff windows").toEqual([
      [0, 1], [1_900, 1], [2_000, 2], [5_900, 2], [6_000, 3], [13_900, 3], [14_000, 4],
    ]);
    expect(opens).toEqual([0, 2_000, 6_000, 14_000]);
    expect(errors).toHaveLength(4);
    expect(running.replica(WORKSPACE)).toBeUndefined();
    expect(engine.sent.filter(request => request.method === "workspace.open" && request.params.workspaceId === "healthy")).toHaveLength(1);

    refusing = false;
    await vi.advanceTimersByTimeAsync(15_999);
    expect(opens).toHaveLength(4);
    const recovered = passes.next();
    await vi.advanceTimersByTimeAsync(1);
    await recovered;
    await running.settled();
    expect(opens).toEqual([0, 2_000, 6_000, 14_000, 30_000]);
    expect(running.replica(WORKSPACE)).toBeDefined();
    expect(running.failedSyncs().size).toBe(0);

    engine.failPush(true, running.replica(WORKSPACE)!.workspace);
    log(1);
    const failed = passes.next();
    notifyRelayWrite(storage);
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    expect(errors).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(errors).toHaveLength(5);
    const retried = passes.next();
    await vi.advanceTimersByTimeAsync(1);
    await retried;
    expect(errors).toHaveLength(6);
    expect(opens).toHaveLength(5);
  });

  it("retries a lease-deferred collection reconciliation without advancing pulledHead or another relay write", async () => {
    const {storage, log} = await relay();
    const engine = fakeEngine();
    let held = false;
    const answer = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (options: Parameters<typeof answer>[0]) => {
      const client = await answer(options);
      const send = client.sendRequest.getMockImplementation()!;
      client.sendRequest.mockImplementation(async (request: Sent) => {
        if (request.method === "sync.commitCursor" && held) {
          engine.sent.push(request);
          throw Object.assign(new Error("collection reconciliation waits for a document lease"), {code: "OVERLOADED", retry: "afterBackoff"});
        }
        return send(request);
      });
      return client;
    });
    const {replicas: running} = await replicas(storage, () => [WORKSPACE], {ms: 0});
    const replica = running.replica(WORKSPACE)!;
    const before = replica.pulledHead;
    held = true;
    log(2);
    await expect(replica.sync()).rejects.toMatchObject({code: "OVERLOADED"});
    expect(replica.pulledHead).toBe(before);
    expect(running.failedSyncs().has(WORKSPACE)).toBe(true);
    const pulls = engine.methods().filter(method => method === "sync.pull").length;
    held = false;
    await running.settled();
    expect(engine.methods().filter(method => method === "sync.pull").length).toBeGreaterThan(pulls);
    expect(replica.pulledHead).toBe(storage.automationWorkspaceLogHead(WORKSPACE));
    expect(running.failedSyncs().size).toBe(0);
  });

  it("backs off a persistently failing step instead of retrying twice every 100 ms", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage, log } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    const engine = fakeEngine();
    const passes = passEnds();
    const errors: unknown[] = [];
    const steps: number[] = [];
    const running = await start(storage, { wanted: () => [WORKSPACE], onReconciled: passes.onReconciled,
      onError: error => errors.push(error), onBeforeSync: async () => { steps.push(Date.now()); } });
    const opened = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await opened;
    steps.length = 0;
    engine.failPush(true);
    log(1);
    const failed = passes.next();
    running.reconcile();
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    await vi.advanceTimersByTimeAsync(14_000);
    expect({ steps: steps.length, onError: errors.length }).toEqual({ steps: 4, onError: 4 });
    expect(steps).toEqual([100, 2_100, 6_100, 14_100]);
    expect(running.replica(WORKSPACE)!.pulledHead).toBe(0);
    expect(running.failedSyncs().has(WORKSPACE)).toBe(true);
    for (const delay of [16_000, 32_000, 60_000, 60_000]) {
      const before = steps.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(steps).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(steps).toHaveLength(before + 1);
      expect(errors).toHaveLength(steps.length);
    }
    engine.failPush(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(running.failedSyncs().size).toBe(0);
    expect(running.replica(WORKSPACE)!.pulledHead).toBe(storage.automationWorkspaceLogHead(WORKSPACE));
    engine.failPush(true);
    log(2);
    running.reconcile();
    await vi.advanceTimersByTimeAsync(100);
    const before = steps.length;
    await vi.advanceTimersByTimeAsync(1_999);
    expect(steps).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(steps).toHaveLength(before + 1);
  });

  it("syncs healthy relay writes and retention deadlines without retrying a failing step early", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage, raw, log } = await relay();
    for (const workspaceId of ["healthy", "leaving"]) {
      storage.claimWorkspace({ workspaceId, ownerUserId: "owner", createdAtMs: 1 });
      storage.claimWorkspaceIdentity({ workspaceId, replicationEpoch: "epoch-1", streamIdentity: "stream-1" });
      storage.joinAutomationWorkspace({ workspaceId, nowMs: 0 });
    }
    storage.unwantAutomationWorkspace({ workspaceId: "leaving", nowMs: 0 });
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    const engine = fakeEngine();
    const passes = passEnds();
    const errors: unknown[] = [];
    const steps: Array<[string, number]> = [];
    const running = await start(storage, { wanted: () => [WORKSPACE, "healthy"],
      nowMs: () => AUTOMATION_WORKSPACE_LEAVE_AFTER_MS - 1_000 + Date.now(),
      onReconciled: passes.onReconciled, onError: error => errors.push(error),
      onBeforeSync: async workspaceId => { steps.push([workspaceId, Date.now()]); } });
    const opened = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await opened;
    steps.length = 0;
    engine.failPush(true, running.replica(WORKSPACE)!.workspace);
    log(1);
    notifyRelayWrite(storage);
    const failed = passes.next();
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    // Writes to either workspace wake promptly, but never shorten the failed step's delay.
    for (let seq = 2; seq <= 4; seq++) {
      raw.prepare("INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) VALUES ('healthy', 'desk', ?, 'moment.append', '{}', 1)").run(seq);
      log(seq);
      notifyRelayWrite(storage);
      const written = passes.next();
      await vi.advanceTimersByTimeAsync(100);
      await written;
      expect(steps.filter(([id]) => id === "healthy")).toHaveLength(seq - 1);
      expect(steps.filter(([id]) => id === WORKSPACE)).toEqual([[WORKSPACE, 100]]);
      expect(running.failedSyncs().has(WORKSPACE)).toBe(true);
    }
    expect(steps.filter(([id]) => id === "healthy")).toEqual([["healthy", 200], ["healthy", 300], ["healthy", 400]]);
    const leaving = passes.next();
    await vi.advanceTimersByTimeAsync(600);
    // The deadline queues a pass whose zero-delay timer runs on the next tick.
    await vi.advanceTimersByTimeAsync(1);
    await leaving;
    expect(storage.currentAutomationWorkspace("leaving")).toBeNull();
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_098);
    expect(steps.filter(([id]) => id === WORKSPACE)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(steps.filter(([id]) => id === WORKSPACE)).toEqual([[WORKSPACE, 100], [WORKSPACE, 2_100]]);
    expect(errors).toHaveLength(2);
  });

  it("schedules retries for direct sync failures and resets their delay after a successful sync", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    const engine = fakeEngine();
    const passes = passEnds();
    const errors: unknown[] = [];
    const steps: number[] = [];
    const running = await start(storage, { wanted: () => [WORKSPACE], onReconciled: passes.onReconciled,
      onError: error => errors.push(error), onBeforeSync: async () => { steps.push(Date.now()); } });
    const opened = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await opened;
    steps.length = 0;
    const replica = running.replica(WORKSPACE)!;
    engine.failPush(true);
    await expect(replica.sync()).rejects.toThrow("replica cannot push");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(steps).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(steps).toEqual([0, 2_000]);
    expect(errors).toHaveLength(1);
    engine.failPush(false);
    await replica.sync();
    expect(running.failedSyncs().size).toBe(0);
    engine.failPush(true);
    await expect(replica.sync()).rejects.toThrow("replica cannot push");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(steps).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(steps).toEqual([0, 2_000, 2_000, 2_000, 4_000]);
    expect(errors).toHaveLength(2);
  });

  it("keeps healthy relay writes within 100 ms after a direct failure at the 60 s retry cap", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage, raw } = await relay();
    storage.claimWorkspace({ workspaceId: "healthy", ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({ workspaceId: "healthy", replicationEpoch: "epoch-1", streamIdentity: "stream-1" });
    for (const workspaceId of [WORKSPACE, "healthy"]) storage.joinAutomationWorkspace({ workspaceId, nowMs: 0 });
    const engine = fakeEngine();
    const passes = passEnds();
    const steps: Array<[string, number]> = [];
    const running = await start(storage, { wanted: () => [WORKSPACE, "healthy"], onReconciled: passes.onReconciled,
      onError: () => {}, onBeforeSync: async workspaceId => { steps.push([workspaceId, Date.now()]); } });
    const opened = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await opened;
    const replica = running.replica(WORKSPACE)!;
    engine.failPush(true, replica.workspace);
    await expect(replica.sync()).rejects.toThrow("replica cannot push");
    await vi.advanceTimersByTimeAsync(62_000);
    expect(steps.filter(([id]) => id === WORKSPACE).map(([, at]) => at)).toEqual([0, 0, 2_000, 6_000, 14_000, 30_000, 62_000]);
    await expect(replica.sync()).rejects.toThrow("replica cannot push");
    // Let the worker consume the direct caller's wake before the healthy write.
    await turn();
    raw.prepare("INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) VALUES ('healthy', 'desk', 1, 'moment.append', '{}', 1)").run();
    notifyRelayWrite(storage);
    await vi.advanceTimersByTimeAsync(100);
    expect(steps.filter(([id]) => id === "healthy")).toEqual([["healthy", 0], ["healthy", 62_100]]);
    expect(running.replica("healthy")!.pulledHead).toBe(storage.automationWorkspaceLogHead("healthy"));
  });

  it("does not spin passes when a direct sync is still busy after its retry becomes due", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    const engine = fakeEngine();
    const pushed = gate(), pushing = gate();
    let hold = false;
    const answer = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (spawned: Parameters<typeof answer>[0]) => {
      const client = await answer(spawned);
      const send = client.sendRequest.getMockImplementation()!;
      client.sendRequest.mockImplementation(async (request: Sent) => {
        if (hold && request.method === "sync.push") { pushing.resolve(); await pushed.promise; }
        return await send(request);
      });
      return client;
    });
    const passes = passEnds();
    let count = 0;
    const running = await start(storage, { wanted: () => [WORKSPACE], onError: () => {},
      onReconciled: () => { count += 1; passes.onReconciled(); } });
    const opened = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await opened;
    const replica = running.replica(WORKSPACE)!;
    engine.failPush(true);
    await expect(replica.sync()).rejects.toThrow("replica cannot push");
    engine.failPush(false);
    hold = true;
    const syncing = replica.sync();
    cleanup.push(async () => { pushed.resolve(); await syncing; });
    await pushing.promise;
    const before = count;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(count - before, "only the wake and the due retry run while sync is held").toBe(2);
    expect(running.failedSyncs().has(WORKSPACE)).toBe(true);
    pushed.resolve();
    await syncing;
    await running.settled();
    expect(running.failedSyncs().size).toBe(0);
  });

  it("clears a failed open's retry when its wanted workspace row disappears", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage, raw } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    const engine = fakeEngine();
    engine.failPush(true);
    const passes = passEnds();
    let count = 0;
    const running = await start(storage, { wanted: () => [WORKSPACE], onError: () => {},
      onReconciled: () => { count += 1; passes.onReconciled(); } });
    const failed = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await failed;
    expect(running.replica(WORKSPACE)).toBeUndefined();
    expect(running.failedSyncs().has(WORKSPACE)).toBe(true);
    raw.prepare("DELETE FROM sync_relay_workspaces WHERE workspace_id = ?").run(WORKSPACE);
    const removed = passes.next();
    running.reconcile();
    await vi.advanceTimersByTimeAsync(100);
    await removed;
    const before = count;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(count - before, "no overdue retry keeps requesting passes").toBe(0);
    expect(running.failedSyncs().size).toBe(0);
    await running.settled();
  });

  it("opens a new incarnation promptly after the previous incarnation failed during open", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    const engine = fakeEngine();
    engine.failPush(true);
    const passes = passEnds();
    const running = await start(storage, { wanted: () => [WORKSPACE], onError: () => {}, onReconciled: passes.onReconciled });
    const failed = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await failed;
    storage.rotateWorkspaceIdentity({ workspaceId: WORKSPACE, ownerUserId: "owner", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 1 });
    engine.failPush(false);
    const changed = passes.next();
    running.reconcile();
    await vi.advanceTimersByTimeAsync(100);
    await changed;
    expect(running.replica(WORKSPACE)).toMatchObject({ incarnation: 2 });
    expect(running.failedSyncs().size).toBe(0);
  });

  it("retries by elapsed time even when the wall clock moves backwards", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    const engine = fakeEngine();
    const passes = passEnds();
    const steps: number[] = [];
    const running = await start(storage, { wanted: () => [WORKSPACE], nowMs: () => 0, onError: () => {},
      onReconciled: passes.onReconciled, onBeforeSync: async () => { steps.push(performance.now()); } });
    const opened = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await opened;
    steps.length = 0;
    engine.failPush(true);
    await expect(running.replica(WORKSPACE)!.sync()).rejects.toThrow("replica cannot push");
    vi.setSystemTime(-60_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(steps).toEqual([0, 2_000]);
  });

  it.each([true, false])("retries promptly after a long pass without repeating its failed step (retry due at start: %s)", async (dueAtStart) => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage, raw, log } = await relay();
    storage.claimWorkspace({ workspaceId: "healthy", ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({ workspaceId: "healthy", replicationEpoch: "epoch-1", streamIdentity: "stream-1" });
    for (const workspaceId of [WORKSPACE, "healthy"]) storage.joinAutomationWorkspace({ workspaceId, nowMs: 0 });
    const engine = fakeEngine();
    const pushing = gate(), pushed = gate();
    let healthy: string | undefined;
    const answer = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (spawned: Parameters<typeof answer>[0]) => {
      const client = await answer(spawned);
      const send = client.sendRequest.getMockImplementation()!;
      client.sendRequest.mockImplementation(async (request: Sent) => {
        if (request.method === "sync.push" && request.workspace === healthy) { pushing.resolve(); await pushed.promise; }
        return await send(request);
      });
      return client;
    });
    const passes = passEnds();
    const steps: number[] = [];
    // The healthy replica comes first in the later pull loop, holding it before the failed replica.
    const running = await start(storage, { wanted: () => ["healthy", WORKSPACE], onReconciled: passes.onReconciled,
      onError: () => {}, onBeforeSync: async id => { if (id === WORKSPACE) steps.push(Date.now()); } });
    cleanup.push(async () => { pushed.resolve(); });
    const opened = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await opened;
    const replica = running.replica(WORKSPACE)!;
    steps.length = 0;
    engine.failPush(true, replica.workspace);
    await expect(replica.sync()).rejects.toThrow("replica cannot push");
    // Drain the ordinary failure wake before requesting a pass at the retry time.
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(dueAtStart ? 1_800 : 1_700);
    healthy = running.replica("healthy")!.workspace;
    raw.prepare("INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) VALUES ('healthy', 'desk', 1, 'moment.append', '{}', 1)").run();
    if (dueAtStart) log(1);
    notifyRelayWrite(storage);
    const finished = passes.next();
    await vi.advanceTimersByTimeAsync(100);
    await pushing.promise;
    // Either the step fails at 2 s, or its retry falls due while the healthy copy is held.
    await vi.advanceTimersByTimeAsync(dueAtStart ? 5_000 : 5_100);
    pushed.resolve();
    await finished;
    expect(steps, "the same pass must not retry the failure again at 7 s").toEqual(dueAtStart ? [0, 2_000] : [0]);
    await vi.advanceTimersByTimeAsync(100);
    expect(steps).toHaveLength(dueAtStart ? 3 : 2);
    expect(steps.at(-1)).toBeGreaterThanOrEqual(7_000);
    expect(steps.at(-1)).toBeLessThanOrEqual(7_100);
  });

  it("retries only the workspace an owner's action names", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    storage.claimWorkspace({ workspaceId: "other", ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({ workspaceId: "other", replicationEpoch: "epoch-1", streamIdentity: "stream-1" });
    for (const workspaceId of [WORKSPACE, "other"]) storage.joinAutomationWorkspace({ workspaceId, nowMs: 0 });
    const engine = fakeEngine();
    engine.failPush(true);
    const passes = passEnds();
    const running = await start(storage, { wanted: () => [WORKSPACE, "other"], onError: () => {}, onReconciled: passes.onReconciled });
    const failed = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await failed;
    expect(running.failedSyncs().size).toBe(2);
    engine.failPush(false);
    const requested = passes.next();
    running.reconcile(WORKSPACE);
    await vi.advanceTimersByTimeAsync(100);
    await requested;
    expect(running.replica(WORKSPACE)).toBeDefined();
    expect(running.replica("other")).toBeUndefined();
    expect([...running.failedSyncs().keys()]).toEqual(["other"]);
    expect(engine.methods().filter(method => method === "workspace.open")).toHaveLength(3);
  });

  it.each([false, true])("backs off pre-step open failures after a push failure (owner retry: %s)", async (ownerRetry) => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    const engine = fakeEngine();
    let refuse = false;
    refuseOpens(engine, () => refuse);
    engine.failPush(true);
    const passes = passEnds();
    let started = 0, completed = 0;
    const errors: number[] = [];
    const running = await start(storage, { wanted: () => { started += 1; return [WORKSPACE]; },
      onError: () => errors.push(Date.now()), onReconciled: () => { completed += 1; passes.onReconciled(); } });
    const failed = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await failed;
    expect(running.replica(WORKSPACE)).toBeUndefined();
    expect(errors).toEqual([0]);
    // Drain the push failure's ordinary wake before the retry becomes due.
    const wake = passes.next();
    await vi.advanceTimersByTimeAsync(100);
    await wake;
    engine.failPush(false);
    refuse = true;
    const before = completed, errorsBefore = errors.length;
    const refused = passes.next();
    if (ownerRetry) running.reconcile(WORKSPACE);
    await vi.advanceTimersByTimeAsync(ownerRetry ? 100 : 1_900);
    await refused;
    const refusedAt = Date.now();
    expect(errors.at(-1)).toBe(refusedAt);
    const extra = passes.next();
    await vi.advanceTimersByTimeAsync(3_000);
    // Finish a pass that fake time started but whose real folder work is still running.
    if (started > before + 1) await extra;
    expect({ passes: completed - before, onError: errors.length - errorsBefore }).toEqual({ passes: 1, onError: 1 });
    expect(running.failedSyncs().get(WORKSPACE)).toEqual(new Error("the engine refused this workspace"));
    await vi.advanceTimersByTimeAsync(999);
    expect(errors.slice(errorsBefore)).toEqual([refusedAt]);
    const retry = passes.next();
    await vi.advanceTimersByTimeAsync(1);
    await retry;
    expect(errors.slice(errorsBefore)).toEqual([refusedAt, refusedAt + 4_000]);
    const later = passes.next();
    await vi.advanceTimersByTimeAsync(8_000);
    await later;
    expect(errors.slice(errorsBefore)).toEqual([refusedAt, refusedAt + 4_000, refusedAt + 12_000]);
    expect(engine.methods().filter(method => method === "sync.push")).toHaveLength(1);
  });

  it("backs off join failures for an open replica with a due retry", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    const engine = fakeEngine();
    const passes = passEnds();
    let completed = 0;
    const errors: number[] = [];
    const running = await start(storage, { wanted: () => [WORKSPACE], onError: () => errors.push(Date.now()),
      onReconciled: () => { completed += 1; passes.onReconciled(); } });
    const opened = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await opened;
    const replica = running.replica(WORKSPACE)!;
    engine.failPush(true);
    await expect(replica.sync()).rejects.toThrow("replica cannot push");
    const wake = passes.next();
    await vi.advanceTimersByTimeAsync(100);
    await wake;
    const join = vi.spyOn(storage, "joinAutomationWorkspace").mockImplementation(() => { throw new Error("the join failed"); });
    cleanup.push(async () => { join.mockRestore(); });
    const before = completed;
    const failed = passes.next();
    await vi.advanceTimersByTimeAsync(1_900);
    await failed;
    await vi.advanceTimersByTimeAsync(3_000);
    expect({ passes: completed - before, onError: errors.length }).toEqual({ passes: 1, onError: 1 });
    expect(errors).toEqual([2_000]);
    expect(running.replica(WORKSPACE)).toBe(replica);
    expect(running.failedSyncs().get(WORKSPACE)).toEqual(new Error("the join failed"));
    await vi.advanceTimersByTimeAsync(999);
    expect(errors).toEqual([2_000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toEqual([2_000, 6_000]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(errors).toEqual([2_000, 6_000, 14_000]);
    expect(engine.methods().filter(method => method === "sync.push")).toHaveLength(2);
  });

  it("refreshes live checkpoints before syncing and still syncs when that lane fails", async () => {
    const {storage} = await relay();
    const engine = fakeEngine();
    const calls: string[] = [];
    const failure = new Error("The owner device is offline.");
    const errors: unknown[] = [];
    const running = await start(storage, {wanted: () => [WORKSPACE], onError: error => errors.push(error),
      onBeforeSync: async workspaceId => {
        expect(workspaceId).toBe(WORKSPACE);
        calls.push("refresh");
        throw failure;
      }});
    await running.settled();
    const replica = running.replica(WORKSPACE)!;
    const before = engine.sent.length;
    await replica.sync();
    expect(calls).toEqual(["refresh", "refresh"]);
    expect(errors).toEqual([failure, failure]);
    expect(engine.sent.slice(before).map(request => request.method).slice(0, 2)).toEqual(["sync.push", "sync.pull"]);
    expect(running.failedSyncs().size).toBe(0);
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

  it("runs direct and background sync while record draft delivery is held", async () => {
    const {storage, log} = await relay();
    const engine = fakeEngine();
    const {replicas: running} = await replicas(storage, () => [WORKSPACE], {ms: 0});
    const replica = running.replica(WORKSPACE)!;
    const entered = gate(), held = gate();
    const writing = replica.withRecordWork(async () => {
      entered.resolve();
      await held.promise;
    });
    await entered.promise;
    try {
      log(1);
      running.reconcile();
      await running.settled();
      expect(engine.methods().filter(method => method === "sync.push")).toHaveLength(2);
      await replica.sync();
      expect(engine.methods().filter(method => method === "sync.push")).toHaveLength(3);
    } finally {held.resolve(); await writing;}
  });

  it("prepares record drafts while an ordinary sync is held and waits for both on close", async () => {
    const {storage} = await relay();
    fakeEngine();
    const answer = spawn.getMockImplementation()!;
    const pushing = gate(), pushed = gate(), writing = gate(), written = gate();
    let hold = false;
    spawn.mockImplementation(async (spawned: Parameters<typeof answer>[0]) => {
      const client = await answer(spawned);
      const send = client.sendRequest.getMockImplementation()!;
      client.sendRequest.mockImplementation(async (request: Sent) => {
        if (request.method === "sync.push" && hold) {pushing.resolve(); await pushed.promise;}
        return send(request);
      });
      return client;
    });
    const {replicas: running} = await replicas(storage, () => [WORKSPACE], {ms: 0});
    const replica = running.replica(WORKSPACE)!;
    hold = true;
    const sync = replica.sync().catch(() => undefined);
    await pushing.promise;
    const draft = replica.withRecordWork(async () => {writing.resolve(); await written.promise;});
    try {
      await writing.promise;
      let closed = false;
      const closing = running.close().then(() => {closed = true;});
      pushed.resolve();
      await sync;
      await turn();
      expect(closed, "record preparation is still running").toBe(false);
      written.resolve();
      await draft;
      await closing;
      expect(closed).toBe(true);
    } finally {pushed.resolve(); written.resolve(); await sync; await draft;}
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
    expect(readdirSync(root).filter(entry => !entry.startsWith("owner-ingress-"))).toEqual([]);
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
    const folder = readdirSync(root).find(entry => /^[0-9a-f]{64}$/u.test(entry))!;
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
    await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: WAIT_TIMEOUT_MS });
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
      key, namespace, wanted: () => ["busy", WORKSPACE], nowMs: () => clock.ms, onError: unexpectedErrors() });
    cleanup.push(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
    // The busy one never catches up, and the quiet one still opens.
    await vi.waitFor(() => expect(running.replica(WORKSPACE)).toBeDefined(), { timeout: WAIT_TIMEOUT_MS });
    const pulls = (handle: string) => engine.sent.filter((request) => request.method === "sync.pull" && request.workspace === handle).length;
    const busy = running.replica("busy")!, quiet = running.replica(WORKSPACE)!;
    const [busyBefore, quietBefore] = [pulls(busy.workspace), pulls(quiet.workspace)];
    const raw = inspectDatabase(storagePath(storage));
    for (const workspaceId of ["busy", WORKSPACE]) {
      raw.prepare("INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) VALUES (?, 'desk', 1, 'moment.append', '{}', 1)").run(workspaceId);
    }
    raw.close();
    running.reconcile();
    await vi.waitFor(() => expect(pulls(quiet.workspace), "the quiet workspace is pulled").toBe(quietBefore + 1), { timeout: WAIT_TIMEOUT_MS });
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
      key, namespace, wanted: () => [], onError: unexpectedErrors(),
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

  it("closes only after an engine start and exit that ignore its abort, and every close waits for them", async () => {
    const { storage } = await relay();
    const engine = fakeEngine();
    const exited = gate();
    const answer = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (spawned: Parameters<typeof answer>[0]) => {
      const client = await answer(spawned);
      client.waitForExit.mockImplementation(() => exited.promise);
      return client;
    });
    const started = holdStartups()();
    const running = await start(storage);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled(), { timeout: WAIT_TIMEOUT_MS });
    const first = running.close(), second = running.close();
    expect(second).toBe(first);
    expect((spawn.mock.calls[0]![0] as { signal: AbortSignal }).signal.aborted, "it aborts at once").toBe(true);
    let closed = false;
    void second.then(() => { closed = true; });
    await turn();
    expect(closed, "the engine is still starting").toBe(false);
    started();
    await vi.waitFor(() => expect(engine.engines[0]?.close).toHaveBeenCalled(), { timeout: WAIT_TIMEOUT_MS });
    await turn();
    expect(closed, "the engine has not exited").toBe(false);
    exited.resolve();
    await first;
    expect(closed).toBe(true);
  });

  it("waits on close for a replica that an engine exit is still closing", async () => {
    const { storage } = await relay();
    const engine = fakeEngine();
    const answer = spawn.getMockImplementation()!;
    const pushing = gate(), pushed = gate();
    let hold = false;
    spawn.mockImplementation(async (spawned: Parameters<typeof answer>[0]) => {
      const client = await answer(spawned);
      const send = client.sendRequest.getMockImplementation()!;
      // The held push ignores every abort.
      client.sendRequest.mockImplementation(async (request: Sent) => {
        if (request.method === "sync.push" && hold) { pushing.resolve(); await pushed.promise; }
        return await send(request);
      });
      return client;
    });
    const changed: string[] = [];
    const running = await start(storage, { wanted: () => [WORKSPACE], onChanged: (workspaceId) => changed.push(workspaceId) });
    await running.settled();
    hold = true;
    const syncing = running.replica(WORKSPACE)!.sync().catch(() => undefined);
    await pushing.promise;
    engine.engines[0]!.exit();
    expect(running.replica(WORKSPACE), "the exit retires it at once").toBeUndefined();
    changed.length = 0;
    let closed = false;
    const closing = running.close().then(() => { closed = true; });
    await turn();
    expect(closed, "its push still runs").toBe(false);
    pushed.resolve();
    await closing;
    expect(changed, "it closed before close() ended").toEqual([WORKSPACE]);
    await syncing;
  });

  it("closes the other replicas and the engine when a replica's listener throws as it closes, and reports that", async () => {
    const { storage } = await relay();
    storage.claimWorkspace({ workspaceId: "other", ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({ workspaceId: "other", replicationEpoch: "epoch-1", streamIdentity: "stream-1" });
    const engine = fakeEngine();
    let closing = false;
    const changed: string[] = [];
    const running = await start(storage, { wanted: () => [WORKSPACE, "other"], onChanged: (workspaceId) => {
      if (closing && workspaceId === WORKSPACE) throw new Error("The listener failed.");
      changed.push(workspaceId);
    } }, false);
    await running.settled();
    closing = true;
    changed.length = 0;
    await expect(running.close()).rejects.toThrow("The listener failed.");
    expect(changed).toEqual(["other"]);
    expect(engine.methods().filter((method) => method === "workspace.close")).toHaveLength(2);
    expect(engine.engines[0]!.close).toHaveBeenCalled();
    expect(engine.engines[0]!.waitForExit).toHaveBeenCalled();
  });

  it("waits out a failed pass's whole delay, however many passes are asked for meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    fakeEngine();
    let failing = true, reads = 0;
    const errors: unknown[] = [];
    const running = await start(storage, { onError: (error) => errors.push(error), wanted: () => {
      reads += 1;
      if (failing) throw new Error("The host records did not read.");
      return [];
    } });
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    failing = false;
    running.reconcile();
    running.reconcile();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(2);
    await running.settled();
    expect(reads, "the passes asked for ran in it").toBe(2);
  });

  it("runs a pass asked for after its delay without shortening a failed workspace's open backoff", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    // Joined already, so a pass's join writes nothing that asks for another pass.
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    const engine = fakeEngine();
    refuseOpens(engine, () => true);
    const passes = passEnds();
    let reads = 0;
    const running = await start(storage, { onError: () => {}, onReconciled: passes.onReconciled, wanted: () => { reads += 1; return [WORKSPACE]; } });
    let next = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await next;
    expect(running.failedSyncs().has(WORKSPACE)).toBe(true);
    running.reconcile();
    await vi.advanceTimersByTimeAsync(99);
    expect(reads).toBe(1);
    next = passes.next();
    await vi.advanceTimersByTimeAsync(1);
    expect(reads, "it runs before the retry's 2 s").toBe(2);
    await next;
    expect(engine.methods().filter(method => method === "workspace.open")).toHaveLength(1);
    // The pass left the workspace's original retry time intact.
    await vi.advanceTimersByTimeAsync(1_899);
    expect(reads).toBe(2);
    next = passes.next();
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(3);
    await next;
    expect(engine.methods().filter(method => method === "workspace.open")).toHaveLength(2);
  });

  it("keeps the first delay asked for, and runs the passes asked for during a pass as one, 100 ms after it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    const engine = fakeEngine();
    const hold = holdStartups();
    const passes = passEnds();
    let reads = 0;
    const running = await start(storage, { onReconciled: passes.onReconciled, wanted: () => { reads += 1; return []; } });
    let next = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await next;
    // The exit asks for a pass in 2 s first; one asked for in 100 ms after it waits as long.
    engine.engines[0]!.exit();
    running.reconcile();
    const started = hold();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn, "the pass is running").toHaveBeenCalledTimes(2);
    running.reconcile();
    running.reconcile();
    next = passes.next();
    started();
    await next;
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(99);
    expect(reads).toBe(2);
    next = passes.next();
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(3);
    await next;
    await running.settled();
    expect(reads, "only one pass followed").toBe(3);
  });

  it("settles once a failed workspace's retry has run, without waiting for a later deadline or setting timers", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    storage.claimWorkspace({ workspaceId: "leaving", ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({ workspaceId: "leaving", replicationEpoch: "epoch-1", streamIdentity: "stream-1" });
    storage.joinAutomationWorkspace({ workspaceId: "leaving", nowMs: 0 });
    storage.unwantAutomationWorkspace({ workspaceId: "leaving", nowMs: 0 });
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    let refuse = true;
    refuseOpens(fakeEngine(), () => refuse);
    const passes = passEnds();
    const running = await start(storage, { onError: () => {}, onReconciled: passes.onReconciled, wanted: () => [WORKSPACE], nowMs: () => 0 });
    let next = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await next;
    expect(running.failedSyncs().has(WORKSPACE)).toBe(true);
    const timers = vi.getTimerCount();
    let settled = false;
    const settling = running.settled().then(() => { settled = true; });
    await turn();
    expect(settled, "its retry is still to run").toBe(false);
    expect(vi.getTimerCount(), "settled() sets no timer").toBe(timers);
    refuse = false;
    next = passes.next();
    await vi.advanceTimersByTimeAsync(2_000);
    await next;
    await settling;
    expect(running.replica(WORKSPACE)).toBeDefined();
    expect(vi.getTimerCount(), "the deadline for the one leaving is still to come").toBe(1);
  });

  it("runs a pass after one that a retention deadline passed during", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    const engine = fakeEngine();
    const hold = holdStartups();
    const passes = passEnds();
    const clock = { ms: 0 };
    let reads = 0;
    const running = await start(storage, { onReconciled: passes.onReconciled, nowMs: () => clock.ms, wanted: () => { reads += 1; return []; } });
    let next = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await next;
    // The engine exits, and the pass that starts it again holds past the deadline.
    const started = hold();
    engine.engines[0]!.exit();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(AUTOMATION_WORKSPACE_LEAVE_AFTER_MS);
    next = passes.next();
    started();
    await next;
    expect(reads).toBe(2);
    expect(storage.currentAutomationWorkspace(WORKSPACE), "that pass ran before the deadline").not.toBeNull();
    clock.ms = AUTOMATION_WORKSPACE_LEAVE_AFTER_MS;
    next = passes.next();
    await vi.advanceTimersByTimeAsync(100);
    await next;
    expect(reads).toBe(3);
    expect(storage.currentAutomationWorkspace(WORKSPACE)).toBeNull();
    expect(running.unavailable).toBe(false);
  });

  it("does not wake at once for an overdue deadline whose workspace failed to leave", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    vi.spyOn(storage, "unwantAutomationWorkspace").mockImplementation(() => { throw new Error("The row did not write."); });
    fakeEngine();
    const passes = passEnds();
    let reads = 0;
    const running = await start(storage, { onError: () => {}, onReconciled: passes.onReconciled,
      nowMs: () => AUTOMATION_WORKSPACE_LEAVE_AFTER_MS, wanted: () => { reads += 1; return []; } });
    let next = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await next;
    expect(running.failedSyncs().has(WORKSPACE)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(reads, "only its retry wakes the replicas").toBe(1);
    next = passes.next();
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(2);
    await next;
  });

  it("goes on with its passes when onError or onReconciled throws", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanup.push(async () => { vi.useRealTimers(); });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanup.push(async () => { logged.mockRestore(); });
    const { storage } = await relay();
    fakeEngine();
    const passes = passEnds();
    let failing = true, reads = 0, errors = 0;
    const running = await start(storage, {
      wanted: () => {
        reads += 1;
        if (failing) throw new Error("The host records did not read.");
        return [];
      },
      onError: () => { errors += 1; throw new Error("The error listener failed."); },
      onReconciled: () => { passes.onReconciled(); throw new Error("The pass listener failed."); },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(errors, "the failed pass ran again").toBe(2);
    failing = false;
    let next = passes.next();
    await vi.advanceTimersByTimeAsync(4_000);
    await next;
    expect(running.unavailable).toBe(false);
    running.reconcile();
    next = passes.next();
    await vi.advanceTimersByTimeAsync(100);
    await next;
    expect(reads, "the pass after a throwing onReconciled ran").toBe(4);
    await running.settled();
    expect(logged).toHaveBeenCalledWith("[automation-replicas] A callback failed.", new Error("The error listener failed."));
    expect(logged).toHaveBeenCalledWith("[automation-replicas] A callback failed.", new Error("The pass listener failed."));
  });

  it("retries a pass whose rows did not read, and looks for a deadline only after a pass", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    const list = storage.listAutomationWorkspaces.bind(storage);
    let failing = true;
    vi.spyOn(storage, "listAutomationWorkspaces").mockImplementation(() => {
      if (failing) throw new Error("The rows did not read.");
      return list();
    });
    fakeEngine();
    const errors: unknown[] = [];
    const passes = passEnds();
    const running = await start(storage, { onError: (error) => errors.push(error), onReconciled: passes.onReconciled, nowMs: () => 0 });
    expect(vi.getTimerCount(), "only the first pass's wait").toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(errors, "the pass's own failure, once").toEqual([new Error("The rows did not read.")]);
    expect(vi.getTimerCount(), "its retry, and no deadline it could not read").toBe(1);
    failing = false;
    const next = passes.next();
    await vi.advanceTimersByTimeAsync(2_000);
    await next;
    expect(running.unavailable).toBe(false);
    expect(vi.getTimerCount(), "the deadline the pass read").toBe(1);
  });
});
