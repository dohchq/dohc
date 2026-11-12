import { DiscussionActivityHub } from "./discussionActivity";
import {createAccountDeletionRoute} from "./accountDeletionRoute";
import {initializeAccountDeletion} from "./storage/accountDeletion";
import type {StorageContext} from "./storage/context";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineRequestError } from "@dohc/workspace-engine-client/daemon";
import { authorizeAutomationReplication, deriveAutomationReplicaBearer } from "./automationReplicaCredential";
import { removeAutomationReplicas, startAutomationReplicas } from "./automationReplicas";
import { startServerCopies } from "./serverCopies";
import { createServiceHostReplication } from "./serviceHostReplication";
import { deriveServiceHostBearer } from "./serviceHostCredential";
import type { SyncRelayStorage } from "./storage";
import { AUTOMATION_WORKSPACE_KEEP_AFTER_LEAVING_MS, AUTOMATION_WORKSPACE_LEAVE_AFTER_MS, type CopyReason } from "./storage/automationWorkspaces";
import { OPERATION_ACTIVE_MS } from "./storage/operationRecords";
import type { PublicationCommand } from "./operationPublication";
import { closeTestStorages, inspectDatabase, storagePath, testStorage, closeTestStorage, reopenTestStorage } from "./testing";
import { notifyRelayWrite } from "./relayWriteChanges";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("@dohc/workspace-engine-client/daemon", async (importOriginal) => ({
  ...await importOriginal<typeof import("@dohc/workspace-engine-client/daemon")>(), createEngineClient: spawn,
}));
// A folder a test names here can't be removed, as when the disk refuses.
const stuck = vi.hoisted(() => ({ path: null as string | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (stuck.path !== null && String(args[0]) === stuck.path) throw Object.assign(new Error("the folder is busy"), { code: "EBUSY" });
    return await actual.rm(...args);
  } };
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
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

type ReplicaOptions = Parameters<typeof startAutomationReplicas>[0];
// Most tests keep copies for automations; they name the workspaces, and this gives each its reason.
type AutomationOptions = Omit<ReplicaOptions, "wanted"> & { wanted: () => readonly string[] };
const automation = (ids: readonly string[]) => new Map(ids.map((id) => [id, ["automation"] as const]));
const startReplicas = (options: AutomationOptions) => startAutomationReplicas({ ...options, wanted: () => automation(options.wanted()) });

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
    const first = storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 10, reasons: ["automation"] })!;
    expect(first).toMatchObject({ ownerUserId: "owner", replicationEpoch: "epoch-1", streamIdentity: "stream-1", incarnation: 1, startedAtMs: 10 });
    expect(storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 20, reasons: ["automation"] })).toEqual(first);

    acceptedPress(raw, "taken-here", "server");
    acceptedPress(raw, "taken-there", "laptop");
    storage.rotateWorkspaceIdentity({ workspaceId: WORKSPACE, ownerUserId: "owner", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 30 });
    expect(storage.currentAutomationWorkspace(WORKSPACE), "the old replica's credential stops").toBeNull();
    const second = storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 40, reasons: ["automation"] })!;
    expect(second).toMatchObject({ replicationEpoch: "epoch-2", incarnation: 2, startedAtMs: 40 });
    expect(second.credentialNonce).not.toBe(first.credentialNonce);
    expect(pressState(raw, "taken-here")).toEqual({ state: "settled", outcome: "ended" });
    expect(pressState(raw, "taken-there")).toEqual({ state: "accepted", outcome: null });
    expect(storage.joinAutomationWorkspace({ workspaceId: "unknown", nowMs: 1, reasons: ["automation"] })).toBeNull();
  });

  it("replaces a lost replica only once the server began running automations in its incarnation", async () => {
    const { storage, raw } = await relay();
    const first = storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 10, reasons: ["automation"] })!;
    acceptedPress(raw, "taken-here", "server");
    expect(storage.replaceLostAutomationReplica({ workspaceId: WORKSPACE, incarnation: 1, nowMs: 20 }), "nothing ran in it").toEqual(first);
    storage.beginAutomationServerCopy({ workspaceId: WORKSPACE, incarnation: 1 });
    const second = storage.replaceLostAutomationReplica({ workspaceId: WORKSPACE, incarnation: 1, nowMs: 30 })!;
    expect(second).toMatchObject({ incarnation: 2, startedAtMs: 30 });
    expect(second.credentialNonce).not.toBe(first.credentialNonce);
    expect(pressState(raw, "taken-here")).toEqual({ state: "settled", outcome: "ended" });
    expect(storage.replaceLostAutomationReplica({ workspaceId: WORKSPACE, incarnation: 1, nowMs: 40 }), "already replaced").toEqual(second);
  });

  it("leaves a day after no condition needs it, and rejoins as it was", async () => {
    const { storage } = await relay();
    const joined = storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] })!;
    expect(storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 100 })).toBeNull();
    expect(storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 100 + AUTOMATION_WORKSPACE_LEAVE_AFTER_MS - 1 })).toBeNull();
    const left = storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 100 + AUTOMATION_WORKSPACE_LEAVE_AFTER_MS });
    expect(left).toMatchObject({ leftAtMs: 100 + AUTOMATION_WORKSPACE_LEAVE_AFTER_MS });
    expect(storage.currentAutomationWorkspace(WORKSPACE)).toBeNull();
    expect(storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 200, reasons: ["automation"] })).toEqual(joined);
    expect(storage.currentAutomationWorkspace(WORKSPACE)).toEqual(joined);
  });

  it("keeps each reason a copy was joined for, and a reason added later is a change", async () => {
    const { storage } = await relay();
    const joined = storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] })!;
    expect(joined.reasons).toEqual(["automation"]);
    expect(storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 1, reasons: [] })).toEqual(joined);
    const both = storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 2, reasons: ["account"] })!;
    expect(both).toEqual({ ...joined, reasons: ["account", "automation"] });
    storage.endCopyReason(WORKSPACE, "automation");
    expect(storage.currentAutomationWorkspace(WORKSPACE)?.reasons).toEqual(["account"]);
    storage.rotateWorkspaceIdentity({ workspaceId: WORKSPACE, ownerUserId: "owner", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 3 });
    expect(storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 4, reasons: [] }), "a new incarnation keeps its reasons")
      .toMatchObject({ incarnation: 2, reasons: ["account"] });
  });

  it("widens a relay's copy reasons once for the phone's writes, keeping every reason it had", async () => {
    const { storage } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation", "account"] });
    const path = storagePath(storage);
    closeTestStorage(storage);
    const older = inspectDatabase(path);
    older.exec(`DROP TABLE sync_relay_automation_workspace_reasons;
      CREATE TABLE sync_relay_automation_workspace_reasons (
        workspace_id TEXT NOT NULL REFERENCES sync_relay_automation_workspaces(workspace_id) ON DELETE CASCADE,
        reason TEXT NOT NULL CHECK (reason IN ('automation', 'account')),
        PRIMARY KEY (workspace_id, reason)
      ) STRICT;
      INSERT INTO sync_relay_automation_workspace_reasons VALUES ('${WORKSPACE}', 'automation'), ('${WORKSPACE}', 'account');
      DELETE FROM sync_relay_migrations WHERE migration_id = 'copy-publication-reason-v1';`);
    older.close();
    const upgraded = reopenTestStorage(path);
    expect(upgraded.listAutomationWorkspaces()[0]?.reasons).toEqual(["account", "automation"]);
    expect(upgraded.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 1, reasons: ["publication"] })?.reasons)
      .toEqual(["account", "automation", "publication"]);
    closeTestStorage(upgraded);
    expect(reopenTestStorage(path).listAutomationWorkspaces()[0]?.reasons, "a second open changes nothing")
      .toEqual(["account", "automation", "publication"]);
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
    const row = storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] })!;
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
    const service = deriveServiceHostBearer(row, { key, namespace });
    expect(authorize({ bearer: service })).toBeNull();

    const handler = createServiceHostReplication({activity: new DiscussionActivityHub(),  storage, prefix: "dohc-automation-v1.",
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
    let failPush: boolean | Error = false;
    let failingWorkspace: string | undefined;
    // What the engine answers for the phone's writes' receipts, by stage key. A key it doesn't hold is absent.
    let receipts: Map<string, unknown> | Error = new Map();
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
          if (request.method === "sync.push" && failPush && (!failingWorkspace || request.workspace === failingWorkspace)) {
            throw failPush instanceof Error ? failPush : new Error("replica cannot push");
          }
          switch (request.method) {
            case "workspace.open": return { result: { workspace: `handle-${++handles}` } };
            case "workspace.close": return { result: {} };
            case "sync.adoptJoinIdentity": return { result: { adopted: true } };
            case "versions.ensureMain": return { result: { id: "main" } };
            case "sync.ordinary.publicationState": {
              if (receipts instanceof Error) throw receipts;
              const held = receipts;
              return { result: { stages: (request.params.stageKeys as string[]).map((stageKey) => held.get(stageKey) ?? { stageKey, state: "absent" }) } };
            }
            case "sync.push": return { result: { status: "complete", pushed: 0, hasMore: false, sharingDeclined: [], ownerAdmissionPending: [] } };
            case "sync.materializePendingCursor": return { result: { materialized: true } };
            case "sync.commitCursor": return { result: { committed: true, sharingDeclined: [] } };
            case "sync.fetchPull": return { result: { pageToken: "fetched" } };
            case "sync.applyPull": return { result: { status: "complete", nextCursor: 1, pendingCursor: { kind: "relay", token: "t" }, hasMore: false,
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
    return { sent, engines, failPush: (value: boolean | Error, workspace?: string) => { failPush = value; failingWorkspace = workspace; },
      receipts: (value: Map<string, unknown> | Error) => { receipts = value; }, methods: () => sent.map((request) => request.method) };
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

  async function start(storage: SyncRelayStorage, options: Partial<AutomationOptions> = {}, closes = true) {
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const running = await startReplicas({ storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example",
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
    const started = await startReplicas({ storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example",
      key, namespace, wanted, nowMs: () => clock.ms, onError, ...(onPulled ? { onPulled } : {}) });
    cleanup.push(async () => { await started.close(); await rm(root, { recursive: true, force: true }); });
    await started.settled();
    return { replicas: started, root };
  }

  it("deletes an account's replica immediately and never reopens it", async () => {
    const {storage} = await relay();
    storage.claimWorkspace({workspaceId: "survivor", ownerUserId: "other", createdAtMs: 1});
    storage.claimWorkspaceIdentity({workspaceId: "survivor", replicationEpoch: "epoch", streamIdentity: "stream"});
    const engine = fakeEngine();
    const {replicas: running} = await replicas(storage, () => [WORKSPACE, "survivor"], {ms: 0});
    const deletedRoot = running.replica(WORKSPACE)!.root;
    const survivorRoot = running.replica("survivor")!.root;
    const deletion=createAccountDeletionRoute({storage:storage as StorageContext,key:"bearer",fenceKey:"fence",invalidate(){},deleteRuntime:async()=>running.deleteWorkspaces([WORKSPACE])});
    deletion.fence("owner","owner@example.test");
    await running.deleteWorkspaces([WORKSPACE]);
    expect(running.replica(WORKSPACE)).toBeUndefined();
    expect(existsSync(deletedRoot)).toBe(false);
    expect(existsSync(survivorRoot)).toBe(true);
    const opens = engine.methods().filter(method => method === "workspace.open").length;
    running.reconcile();
    await running.settled();
    expect(engine.methods().filter(method => method === "workspace.open")).toHaveLength(opens);
    expect(existsSync(deletedRoot)).toBe(false);
    await running.deleteWorkspaces([WORKSPACE]);
    expect(running.replica("survivor")).toBeDefined();
  });

  it("does not recreate a copy after a restart between runtime and SQL deletion",async()=>{
    const {storage}=await relay();fakeEngine();
    const {replicas:running,root}=await replicas(storage,()=>[WORKSPACE],{ms:0});
    const deletedRoot=running.replica(WORKSPACE)!.root;
    const deletion=createAccountDeletionRoute({storage:storage as StorageContext,key:"bearer",fenceKey:"fence",invalidate(){},deleteRuntime:async()=>running.deleteWorkspaces([WORKSPACE]),afterPhase(phase){if(phase==="runtime")throw Error("crash after runtime");}});
    await expect(deletion.purge("owner","owner@example.test")).rejects.toThrow("crash after runtime");
    expect(storage.listAutomationWorkspaces()).toHaveLength(1);
    expect(existsSync(deletedRoot)).toBe(false);
    await running.close();const path=storagePath(storage);closeTestStorage(storage);
    const restartedStorage=reopenTestStorage(path) as StorageContext;
    initializeAccountDeletion(restartedStorage,"fence");
    const restarted=await startReplicas({storage:restartedStorage,root,engineExecutable:process.execPath,relayOrigin:"https://relay.example",key,namespace,wanted:()=>[WORKSPACE],onError:unexpectedErrors()});
    cleanup.push(()=>restarted.close());await restarted.settled();
    expect(restarted.replica(WORKSPACE)).toBeUndefined();expect(existsSync(deletedRoot)).toBe(false);
    const resume=createAccountDeletionRoute({storage:restartedStorage,key:"bearer",fenceKey:"fence",invalidate(){},deleteRuntime:async()=>{throw Error("runtime must not repeat");}});
    await resume.purge("owner","owner@example.test");expect(restartedStorage.listAutomationWorkspaces()).toEqual([]);
  });
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
    vi.stubEnv("DOHC_ENGINE_READER_CONFIG", "operator-reader");
    const {storage, raw} = await relay();
    const engine = fakeEngine();
    let wanted = [WORKSPACE];
    const {replicas: running, root} = await replicas(storage, () => wanted, {ms: 0});
    const configPath = (spawn.mock.calls[0]![0] as {env: Record<string, string>}).env.DOHC_ENGINE_OWNER_HOST_CONFIG!;
    expect(spawn.mock.calls[0]![0].env.DOHC_ENGINE_READER_CONFIG).toBe("operator-reader");
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
    expect(spawn.mock.calls[1]![0].env.DOHC_ENGINE_READER_CONFIG).toBe("operator-reader");
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
    const running = await startReplicas({storage, root, engineExecutable: process.execPath,
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
    const pulls = engine.methods().filter(method => method === "sync.applyPull").length;
    held = false;
    await running.settled();
    expect(engine.methods().filter(method => method === "sync.applyPull").length).toBeGreaterThan(pulls);
    expect(replica.pulledHead).toBe(storage.automationWorkspaceLogHead(WORKSPACE));
    expect(running.failedSyncs().size).toBe(0);
  });

  it("backs off a persistently failing step instead of retrying twice every 100 ms", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage, log } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
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

  it("reports a busy engine's refusals only once they repeat", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage, log } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
    const engine = fakeEngine();
    const passes = passEnds();
    const reported: number[] = [];
    const steps: number[] = [];
    const running = await start(storage, { wanted: () => [WORKSPACE], onReconciled: passes.onReconciled,
      onError: () => reported.push(Date.now()), onBeforeSync: async () => { steps.push(Date.now()); } });
    const opened = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await opened;
    steps.length = 0;
    // The engine's answer while every copy catches up at startup.
    const busy = new EngineRequestError(1, { code: "OVERLOADED", message: "live-settlement-capacity", retry: "afterBackoff" });
    engine.failPush(busy);
    log(1);
    const refused = passes.next();
    running.reconcile();
    await vi.advanceTimersByTimeAsync(100);
    await refused;
    await vi.advanceTimersByTimeAsync(2_000);
    engine.failPush(false);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(steps).toEqual([100, 2_100, 6_100]);
    expect(running.failedSyncs().size).toBe(0);
    expect(reported, "refusals a retry recovers").toEqual([]);

    engine.failPush(busy);
    log(2);
    const again = passes.next();
    running.reconcile();
    await vi.advanceTimersByTimeAsync(100);
    await again;
    await vi.advanceTimersByTimeAsync(14_000);
    expect(steps).toEqual([100, 2_100, 6_100, 6_200, 8_200, 12_200, 20_200]);
    expect(reported, "the third refusal in a row, and each after it").toEqual([12_200, 20_200]);
    expect(running.failedSyncs().get(WORKSPACE)).toBe(busy);
  });

  it("syncs healthy relay writes and retention deadlines without retrying a failing step early", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage, raw, log } = await relay();
    for (const workspaceId of ["healthy", "leaving"]) {
      storage.claimWorkspace({ workspaceId, ownerUserId: "owner", createdAtMs: 1 });
      storage.claimWorkspaceIdentity({ workspaceId, replicationEpoch: "epoch-1", streamIdentity: "stream-1" });
      storage.joinAutomationWorkspace({ workspaceId, nowMs: 0, reasons: ["automation"] });
    }
    storage.unwantAutomationWorkspace({ workspaceId: "leaving", nowMs: 0 });
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
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
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
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
    for (const workspaceId of [WORKSPACE, "healthy"]) storage.joinAutomationWorkspace({ workspaceId, nowMs: 0, reasons: ["automation"] });
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
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
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
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
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
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
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
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
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
    for (const workspaceId of [WORKSPACE, "healthy"]) storage.joinAutomationWorkspace({ workspaceId, nowMs: 0, reasons: ["automation"] });
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
    for (const workspaceId of [WORKSPACE, "other"]) storage.joinAutomationWorkspace({ workspaceId, nowMs: 0, reasons: ["automation"] });
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
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
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
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
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
    expect(engine.sent.slice(before).map(request => request.method).slice(0, 3)).toEqual(["sync.push", "sync.fetchPull", "sync.applyPull"]);
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
    expect(engine.methods()).toEqual(["workspace.open", "versions.ensureMain", "sync.adoptJoinIdentity", "sync.push", "sync.fetchPull", "sync.applyPull", "sync.materializePendingCursor", "sync.commitCursor"]);

    // Nothing changed at the relay: a pass pulls nothing.
    running.reconcile();
    await running.settled();
    expect(engine.methods().filter((method) => method === "sync.applyPull")).toHaveLength(1);
    log(1);
    running.reconcile();
    await running.settled();
    expect(engine.methods().filter((method) => method === "sync.applyPull")).toHaveLength(2);
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
    expect(engine.methods().filter((method) => method === "sync.applyPull")).toHaveLength(1);
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

  // Copies an owner's account reads, beside those automations keep.
  async function copies(storage: SyncRelayStorage, wanted: () => ReadonlyMap<string, readonly CopyReason[]>, clock: { ms: number },
    onChanged?: (workspaceId: string) => void) {
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const started = await startAutomationReplicas({ storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example",
      key, namespace, wanted, nowMs: () => clock.ms, onError: unexpectedErrors(), ...(onChanged ? { onChanged } : {}) });
    cleanup.push(async () => { await started.close(); await rm(root, { recursive: true, force: true }); });
    await started.settled();
    return { replicas: started, root };
  }
  const folders = (root: string) => readdirSync(root).filter(entry => /^[0-9a-f]{64}$/u.test(entry));

  it("closes an account copy as soon as nothing wants it, and removes its folder and row when it leaves", async () => {
    const { storage } = await relay();
    const engine = fakeEngine();
    const clock = { ms: 0 };
    let wanted = new Map<string, readonly CopyReason[]>([[WORKSPACE, ["account"]]]);
    const { replicas: running, root } = await copies(storage, () => wanted, clock);
    expect(running.replica(WORKSPACE)?.reasons).toEqual(["account"]);
    wanted = new Map();
    running.reconcile(); await running.settled();
    expect(running.replica(WORKSPACE), "an idle account copy holds no engine").toBeUndefined();
    expect(engine.methods()).toContain("workspace.close");
    expect(folders(root), "its folder stays a day, so the next visit only catches up").toHaveLength(1);
    wanted = new Map([[WORKSPACE, ["account"]]]);
    running.reconcile(); await running.settled();
    expect(running.replica(WORKSPACE)).toBeDefined();
    wanted = new Map();
    running.reconcile(); await running.settled();
    clock.ms = AUTOMATION_WORKSPACE_LEAVE_AFTER_MS;
    running.reconcile(); await running.settled();
    expect(folders(root), "no hold for run history").toEqual([]);
    expect(storage.listAutomationWorkspaces()).toEqual([]);
  });

  it("removes a copy at once when its last reason ends", async () => {
    const { storage } = await relay();
    fakeEngine();
    let wanted = new Map<string, readonly CopyReason[]>([[WORKSPACE, ["account"]]]);
    const { replicas: running, root } = await copies(storage, () => wanted, { ms: 0 });
    wanted = new Map();
    running.reconcile(); await running.settled();
    expect(folders(root)).toHaveLength(1);
    storage.endCopyReason(WORKSPACE, "account");
    running.reconcile(); await running.settled();
    expect(folders(root)).toEqual([]);
    expect(storage.listAutomationWorkspaces()).toEqual([]);
  });

  it("ends at start the account's reason a crash left on a copy hidden from the phone, and keeps the others'", async () => {
    const { storage } = await relay();
    for (const workspaceId of ["ledger", "notes"]) {
      storage.claimWorkspace({ workspaceId, ownerUserId: "owner", createdAtMs: 1 });
      storage.claimWorkspaceIdentity({ workspaceId, replicationEpoch: "epoch", streamIdentity: "stream" });
    }
    fakeEngine();
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const options = { storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example", key, namespace, nowMs: () => 0,
      onError: unexpectedErrors() };
    const first = await startServerCopies(options);
    // Phone reads of every workspace are in flight. They never end: the server crashes during them.
    const inside = ["trip", "ledger", "notes"].map((name, n) => new Promise<void>((entered) => {
      const workspaceId = n === 0 ? WORKSPACE : name;
      void first.withServerCopy("owner", workspaceId, { reason: "account", caller: `phone-${n}`, signal: new AbortController().signal, phone: true },
        () => { entered(); return new Promise<never>(() => {}); });
    }));
    await Promise.all(inside);
    // The owner hides one workspace, and a pass while its read holds the copy gives the reason back.
    storage.setShowOnPhone({ ownerUserId: "owner", workspaceId: WORKSPACE, showOnPhone: false });
    expect(storage.listAutomationWorkspaces().find(row => row.workspaceId === WORKSPACE)?.reasons).toEqual([]);
    first.reconcile();
    await vi.waitFor(() => expect(storage.listAutomationWorkspaces().find(row => row.workspaceId === WORKSPACE)?.reasons).toEqual(["account"]));
    // Another moves to an account the copy was not made for.
    (storage as StorageContext).db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'ben' WHERE workspace_id = 'notes'").run();
    await first.close();
    const reasons = () => storage.listAutomationWorkspaces().map(row => [row.workspaceId, row.reasons]);
    expect(reasons()).toEqual([["ledger", ["account"]], ["notes", ["account"]], [WORKSPACE, ["account"]]]);

    // What main.ts does at start, before the copies' first pass.
    storage.endAccountReasonsOfHiddenOrDisownedCopies();
    expect(reasons()).toEqual([["ledger", ["account"]], ["notes", []], [WORKSPACE, []]]);
    const after = await startAutomationReplicas({ ...options, wanted: () => new Map() });
    cleanup.push(() => after.close());
    await after.settled();
    // The hidden and moved copies go in the first pass. The shown one closes and waits out its day.
    expect(storage.listAutomationWorkspaces().map(row => [row.workspaceId, row.reasons, row.unwantedSinceMs])).toEqual([["ledger", ["account"], 0]]);
    expect(folders(root)).toHaveLength(1);
    expect(after.replica("ledger")).toBeUndefined();
  });

  it("keeps an account copy when the server stops running automations, and lets the automations' copies go", async () => {
    const { storage } = await relay();
    storage.claimWorkspace({ workspaceId: "ledger", ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({ workspaceId: "ledger", replicationEpoch: "epoch", streamIdentity: "stream" });
    fakeEngine();
    let wanted = new Map<string, readonly CopyReason[]>([[WORKSPACE, ["automation", "account"]], ["ledger", ["automation"]]]);
    const first = await copies(storage, () => wanted, { ms: 0 });
    await first.replicas.close();
    // The server restarts without automations: only the account's reason stays.
    storage.endCopyReasonEverywhere("automation");
    wanted = new Map([[WORKSPACE, ["account"]]]);
    const { replicas: running, root } = await copies(storage, () => wanted, { ms: 0 });
    expect(running.replica(WORKSPACE)?.reasons).toEqual(["account"]);
    expect(running.replica("ledger")).toBeUndefined();
    expect(storage.listAutomationWorkspaces().map(row => [row.workspaceId, row.reasons])).toEqual([[WORKSPACE, ["account"]]]);
    expect(folders(root)).toHaveLength(1);
  });

  it("keeps the 30-day hold of copies a relay made before copies had reasons", async () => {
    const { storage, raw } = await relay();
    storage.claimWorkspace({ workspaceId: "ledger", ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({ workspaceId: "ledger", replicationEpoch: "epoch", streamIdentity: "stream" });
    fakeEngine();
    const clock = { ms: 0 };
    let wanted = [WORKSPACE, "ledger"];
    const { replicas: before, root } = await replicas(storage, () => wanted, clock);
    // The workspace's automations moved to a computer: its copy leaves, and is retained.
    wanted = ["ledger"];
    before.reconcile(); await before.settled();
    clock.ms = AUTOMATION_WORKSPACE_LEAVE_AFTER_MS;
    before.reconcile(); await before.settled();
    await before.close();
    expect(folders(root)).toHaveLength(2);
    const path = storagePath(storage);
    closeTestStorage(storage);
    // The store as the previous schema left it: the rows, and no reasons.
    raw.exec("DROP TABLE sync_relay_automation_workspace_reasons");
    expect(raw.prepare("SELECT workspace_id, left_at_ms FROM sync_relay_automation_workspaces ORDER BY workspace_id").all())
      .toEqual([{ workspace_id: "ledger", left_at_ms: null }, { workspace_id: WORKSPACE, left_at_ms: AUTOMATION_WORKSPACE_LEAVE_AFTER_MS }]);

    const upgraded = reopenTestStorage(path);
    expect(upgraded.listAutomationWorkspaces().map(row => [row.workspaceId, row.reasons]))
      .toEqual([["ledger", ["automation"]], [WORKSPACE, ["automation"]]]);
    clock.ms = AUTOMATION_WORKSPACE_LEAVE_AFTER_MS + AUTOMATION_WORKSPACE_KEEP_AFTER_LEAVING_MS - 1;
    const after = await start(upgraded, { root, wanted: () => ["ledger"], nowMs: () => clock.ms });
    await after.settled();
    expect(folders(root), "the retired copy keeps its hold").toHaveLength(2);
    expect(upgraded.listAutomationWorkspaces()).toHaveLength(2);
    clock.ms += 1;
    after.reconcile(); await after.settled();
    expect(upgraded.listAutomationWorkspaces().map(row => row.workspaceId)).toEqual(["ledger"]);
    expect(folders(root)).toHaveLength(1);
  });

  // Holds the engine's opening of `workspaceId` until the answer is released.
  function holdOpen(engine: ReturnType<typeof fakeEngine>, workspaceId: string) {
    const answer = spawn.getMockImplementation()!;
    const held = gate();
    let reached!: () => void;
    const opening = new Promise<void>((resolve) => { reached = resolve; });
    spawn.mockImplementation(async (spawned: Parameters<typeof answer>[0]) => {
      const client = await answer(spawned);
      const send = client.sendRequest.getMockImplementation()!;
      client.sendRequest.mockImplementation(async (request: Sent) => {
        if (request.method === "workspace.open" && request.params.workspaceId === workspaceId) { reached(); await held.promise; }
        return await send(request);
      });
      return client;
    });
    engine.engines.at(-1)?.exit();
    return { opening, release: held.resolve };
  }

  it("keeps a copy a visit wants again while its pass opened another, and its folder at the leave deadline", async () => {
    const { storage } = await relay();
    storage.claimWorkspace({ workspaceId: "ledger", ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({ workspaceId: "ledger", replicationEpoch: "epoch", streamIdentity: "stream" });
    const engine = fakeEngine();
    const clock = { ms: 0 };
    let wanted = new Map<string, readonly CopyReason[]>([[WORKSPACE, ["account"]]]);
    const { replicas: running, root } = await copies(storage, () => wanted, clock);
    const held = holdOpen(engine, "ledger");
    await running.settled();
    const opened = running.replica(WORKSPACE);
    expect(opened).toBeDefined();
    const [folder] = folders(root);
    // What the copy keeps, which goes only with its folder.
    await writeFile(join(root, folder!, String(opened!.incarnation), "kept"), "");
    // A pass that excludes the open account copy waits on another workspace's open.
    wanted = new Map([["ledger", ["automation"]]]);
    running.reconcile();
    await held.opening;
    // A visit is admitted to the excluded copy meanwhile, and asks for a pass, as admission does.
    wanted = new Map([["ledger", ["automation"]], [WORKSPACE, ["account"]]]);
    running.reconcile(WORKSPACE);
    held.release();
    await running.settled();
    expect(running.replica(WORKSPACE), "the visit's copy stayed open").toBe(opened);

    // The visit ends; the idle account copy closes and waits a day to leave.
    wanted = new Map([["ledger", ["automation"]]]);
    running.reconcile(); await running.settled();
    expect(running.replica(WORKSPACE)).toBeUndefined();
    // Its pass at the leave deadline, after an engine restart, waits on reopening another workspace, and a visit is admitted meanwhile.
    clock.ms = AUTOMATION_WORKSPACE_LEAVE_AFTER_MS;
    const again = holdOpen(engine, "ledger");
    await again.opening;
    wanted = new Map([["ledger", ["automation"]], [WORKSPACE, ["account"]]]);
    running.reconcile(WORKSPACE);
    again.release();
    await running.settled();
    expect(existsSync(join(root, folder!, String(opened!.incarnation), "kept")), "the visit's copy keeps its folder").toBe(true);
    expect(running.replica(WORKSPACE)).toBeDefined();
    // The visit ends, and the copy leaves a day after that.
    wanted = new Map([["ledger", ["automation"]]]);
    running.reconcile(); await running.settled();
    clock.ms += AUTOMATION_WORKSPACE_LEAVE_AFTER_MS;
    running.reconcile(); await running.settled();
    expect(existsSync(join(root, folder!))).toBe(false);
  });

  it("tells its listener when an open account copy comes to be kept for automations", async () => {
    const { storage } = await relay();
    fakeEngine();
    const changed: string[] = [];
    let wanted = new Map<string, readonly CopyReason[]>([[WORKSPACE, ["account"]]]);
    const { replicas: running } = await copies(storage, () => wanted, { ms: 0 }, id => changed.push(id));
    const opened = running.replica(WORKSPACE);
    changed.length = 0;
    wanted = new Map([[WORKSPACE, ["automation", "account"]]]);
    running.reconcile(); await running.settled();
    expect(changed).toEqual([WORKSPACE]);
    expect(running.replica(WORKSPACE), "the same copy").toBe(opened);
    expect(opened?.reasons).toEqual(["account", "automation"]);
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

  it("starts a new incarnation that ends the presses the server took when the copy it began lost its folder", async () => {
    const { storage, raw } = await relay();
    fakeEngine();
    const clock = { ms: 1 };
    const { replicas: first, root } = await replicas(storage, () => [WORKSPACE], clock);
    storage.beginAutomationServerCopy({ workspaceId: WORKSPACE, incarnation: 1 });
    acceptedPress(raw, "taken-here", "server");
    await first.close();

    clock.ms = 2;
    const kept = await start(storage, { root, wanted: () => [WORKSPACE], nowMs: () => clock.ms });
    await kept.settled();
    expect(kept.replica(WORKSPACE), "a restart that kept its host data").toMatchObject({ incarnation: 1, startedAtMs: 1 });
    expect(pressState(raw, "taken-here")).toEqual({ state: "accepted", outcome: null });
    await kept.close();

    // The server restarts with empty host data and the same relay.
    clock.ms = 3;
    const { replicas: emptied } = await replicas(storage, () => [WORKSPACE], clock);
    expect(emptied.replica(WORKSPACE)).toMatchObject({ incarnation: 2, startedAtMs: 3 });
    expect(pressState(raw, "taken-here")).toEqual({ state: "settled", outcome: "ended" });
    await emptied.close();

    // Nothing ran in incarnation 2, so losing its folder too starts no third.
    clock.ms = 4;
    const { replicas: again } = await replicas(storage, () => [WORKSPACE], clock);
    expect(again.replica(WORKSPACE)).toMatchObject({ incarnation: 2, startedAtMs: 3 });
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
    const running = await startReplicas({ storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example",
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
    storage.joinAutomationWorkspace({ workspaceId: "leaving", nowMs: 0, reasons: ["automation"] });
    storage.unwantAutomationWorkspace({ workspaceId: "leaving", nowMs: 0 });
    const clock = { ms: AUTOMATION_WORKSPACE_LEAVE_AFTER_MS };
    const errors: Array<[unknown, string | undefined]> = [];
    let passes = 0;
    const waiting: Array<() => void> = [];
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const running = await startReplicas({ storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example",
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
    const pulls = () => engine.sent.filter((request) => request.method === "sync.applyPull" && request.workspace === running.replica(WORKSPACE)!.workspace).length;
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
        if (request.method === "sync.applyPull" && request.workspace === busyHandle && busyHandle !== undefined && opened) {
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
    const running = await startReplicas({ storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example",
      key, namespace, wanted: () => ["busy", WORKSPACE], nowMs: () => clock.ms, onError: unexpectedErrors() });
    cleanup.push(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
    // The busy one never catches up, and the quiet one still opens.
    await vi.waitFor(() => expect(running.replica(WORKSPACE)).toBeDefined(), { timeout: WAIT_TIMEOUT_MS });
    const pulls = (handle: string) => engine.sent.filter((request) => request.method === "sync.applyPull" && request.workspace === handle).length;
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
    const running = await startReplicas({ storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example",
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
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: start, reasons: ["automation"] });
    storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: start });
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    // Each pass reads and writes real folders, which fake time does not wait
    // for, so the test waits for the pass itself to end.
    const waiting: Array<() => void> = [];
    const nextPass = () => new Promise<void>((resolve) => waiting.push(resolve));
    const opened = nextPass();
    const running = await startReplicas({ storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example",
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
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
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
    storage.joinAutomationWorkspace({ workspaceId: "leaving", nowMs: 0, reasons: ["automation"] });
    storage.unwantAutomationWorkspace({ workspaceId: "leaving", nowMs: 0 });
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
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
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
    storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    const engine = fakeEngine();
    const hold = holdStartups();
    const passes = passEnds();
    const clock = { ms: 0 };
    // Each pass asks what is wanted more than once, so the test counts the passes that ended.
    let ended = 0;
    const running = await start(storage, { onReconciled: () => { ended += 1; passes.onReconciled(); }, nowMs: () => clock.ms, wanted: () => [] });
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
    expect(ended).toBe(2);
    expect(storage.currentAutomationWorkspace(WORKSPACE), "that pass ran before the deadline").not.toBeNull();
    clock.ms = AUTOMATION_WORKSPACE_LEAVE_AFTER_MS;
    next = passes.next();
    await vi.advanceTimersByTimeAsync(100);
    await next;
    expect(ended).toBe(3);
    expect(storage.currentAutomationWorkspace(WORKSPACE)).toBeNull();
    expect(running.unavailable).toBe(false);
  });

  it("does not wake at once for an overdue deadline whose workspace failed to leave", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
    storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    vi.spyOn(storage, "unwantAutomationWorkspace").mockImplementation(() => { throw new Error("The row did not write."); });
    fakeEngine();
    const passes = passEnds();
    // Each pass asks what is wanted more than once, so the test counts the passes that ended.
    let ended = 0;
    const running = await start(storage, { onError: () => {}, onReconciled: () => { ended += 1; passes.onReconciled(); },
      nowMs: () => AUTOMATION_WORKSPACE_LEAVE_AFTER_MS, wanted: () => [] });
    let next = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await next;
    expect(running.failedSyncs().has(WORKSPACE)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(ended, "only its retry wakes the replicas").toBe(1);
    next = passes.next();
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(ended).toBe(2);
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
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
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

  // A phone write the owner's account recorded on the copy, sending one message.
  function phoneWrite(storage: SyncRelayStorage, id: string) {
    const command: PublicationCommand = {
      stages: [{ key: `${id}:send`, role: "post", records: [{ kind: "chat.message.append", fields: { messageId: id } }] }],
    };
    const claim = storage.recordAccountOperation({ accountId: "owner", operationId: id, binding: { workspaceId: WORKSPACE, operation: "send", args: { id } },
      incarnation: 1, replicationEpoch: "epoch-1", streamIdentity: "stream-1", command, writesMessage: true, nowMs: 0 });
    if (claim.kind !== "recorded") throw new Error(`expected a new record, got ${claim.kind}`);
  }
  // The receipt of a write's one stage, whose message the copy journaled at `originSeq`.
  const receipt = (id: string, originSeq: number, state: "pushed" | "pending" = "pushed"): [string, unknown] => [`${id}:send`, {
    stageKey: `${id}:send`, state: "present", outcome: "written", threadId: "thread", coordinates: [{ originId: "copy", originSeq, state }],
  }];
  // The relay accepted the message at the copy's coordinate.
  const accept = (raw: ReturnType<typeof inspectDatabase>, id: string, originSeq: number) => raw.prepare(
    "INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) VALUES (?, 'copy', ?, 'chat.message.append', ?, 1)",
  ).run(WORKSPACE, originSeq, JSON.stringify({ messageId: id, threadId: "thread" }));
  const outcome = (raw: ReturnType<typeof inspectDatabase>, id: string) => {
    const row = raw.prepare("SELECT stage, message_state, result_json FROM sync_relay_account_operations WHERE operation_id = ?").get(id);
    return [row?.stage, row?.message_state, row?.result_json == null ? null : JSON.parse(String(row?.result_json))];
  };
  // What the server's copies want: each copy whose phone writes may still publish, as serverCopies gives them a place.
  const publishing = (storage: SyncRelayStorage) => () =>
    new Map(storage.publishingCopies().map((copy): [string, readonly CopyReason[]] => [copy.workspaceId, ["publication"]]));
  const count = (engine: ReturnType<typeof fakeEngine>, method: string) => engine.methods().filter((sent) => sent === method).length;
  /**
   * Copies whose passes run only as the test moves fake time. `pass` asks
   * for one, as a write or an owner's action does, moves time past the
   * delay a pass waits, and resolves once that pass ended. Nothing else
   * moves time, so no retry or deadline fires unless a test advances to it.
   */
  async function stepped(storage: SyncRelayStorage, wanted: () => ReadonlyMap<string, readonly CopyReason[]>,
    options: { clock?: { ms: number }; root?: string; onError?: (error: unknown, workspaceId?: string) => void } = {}) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanup.push(async () => { vi.useRealTimers(); });
    const root = options.root ?? await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const clock = options.clock ?? { ms: 0 };
    const passes = passEnds();
    const first = passes.next();
    const running = await startAutomationReplicas({ storage, root, engineExecutable: process.execPath, relayOrigin: "https://relay.example",
      key, namespace, wanted, nowMs: () => clock.ms, onError: options.onError ?? unexpectedErrors(), onReconciled: passes.onReconciled });
    cleanup.push(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
    // The first pass is asked for at once.
    await vi.advanceTimersByTimeAsync(0);
    await first;
    const pass = async (workspaceId?: string) => {
      const ended = passes.next();
      running.reconcile(workspaceId);
      await vi.advanceTimersByTimeAsync(100);
      await ended;
    };
    return { running, root, pass };
  }
  // An account visit opens the copy, so its folder exists, as a write needs.
  // Once the visit ends, only the copy's unsent writes keep it.
  async function visitedThenPublishing(storage: SyncRelayStorage, clock: { ms: number }) {
    let wanted = (): ReadonlyMap<string, readonly CopyReason[]> => new Map([[WORKSPACE, ["account"]]]);
    const opened = await stepped(storage, () => wanted(), { clock });
    expect(opened.running.replica(WORKSPACE)).toBeDefined();
    return { ...opened, wantPublishing: () => { wanted = publishing(storage); } };
  }

  it("closes a retiring copy before reading its phone writes' receipts from the folder, and saves one whose push answer was lost", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    let wanted = new Map<string, readonly CopyReason[]>([[WORKSPACE, ["account"]]]);
    const { running, root, pass } = await stepped(storage, () => wanted);
    phoneWrite(storage, "lost");
    phoneWrite(storage, "unwritten");
    // The relay holds the message, but the copy never heard its push answered.
    accept(raw, "lost", 1);
    engine.receipts(new Map([receipt("lost", 1, "pending")]));
    await pass();
    expect(outcome(raw, "lost")[0], "the copy waits to see its push").toBe("recorded");
    // "Show on phone" goes off, so the writes no longer keep the copy, and it retires.
    storage.setShowOnPhone({ ownerUserId: "owner", workspaceId: WORKSPACE, showOnPhone: false });
    wanted = new Map();
    const before = engine.sent.length;
    await pass();
    const after = engine.sent.slice(before).map((request) => request.method);
    expect(after.indexOf("workspace.close"), "closed before its receipts are read").toBeLessThan(after.indexOf("sync.ordinary.publicationState"));
    expect(after.slice(after.indexOf("workspace.close") + 1)).not.toContain("sync.push");
    expect([outcome(raw, "lost"), outcome(raw, "unwritten")]).toEqual([
      ["saved", "published", { threadId: "thread" }],
      // Its stage never committed, so it never published.
      ["refused", "pending", { threadId: null, reason: "Couldn't send" }],
    ]);
    expect(folders(root)).toEqual([]);
    expect(storage.listAutomationWorkspaces()).toEqual([]);

    // Showing the workspace again makes a new copy, which replays nothing.
    storage.setShowOnPhone({ ownerUserId: "owner", workspaceId: WORKSPACE, showOnPhone: true });
    const reads = count(engine, "sync.ordinary.publicationState");
    wanted = new Map([[WORKSPACE, ["account"]]]);
    await pass();
    expect(running.replica(WORKSPACE)).toMatchObject({ incarnation: 1 });
    expect(count(engine, "sync.ordinary.publicationState")).toBe(reads);
  });

  it("keeps a retiring copy's folder while its receipts can't be read, and retries after its delay on its own", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanup.push(async () => { vi.useRealTimers(); });
    const { storage, raw } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["account"] });
    phoneWrite(storage, "sent");
    accept(raw, "sent", 1);
    // A copy with no reason left, as "Show on phone" leaves it, retires at once.
    storage.setShowOnPhone({ ownerUserId: "owner", workspaceId: WORKSPACE, showOnPhone: false });
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const folder = join(root, createHash("sha256").update(JSON.stringify([namespace, WORKSPACE])).digest("hex"));
    await mkdir(join(folder, "1", "workspace"), { recursive: true });
    const engine = fakeEngine();
    engine.receipts(new Error("the engine is busy"));
    const errors: unknown[] = [];
    const passes = passEnds();
    let next = passes.next();
    await start(storage, { root, onError: (error) => errors.push(error), onReconciled: passes.onReconciled, nowMs: () => 0 });
    await vi.advanceTimersByTimeAsync(0);
    await next;
    expect(errors).toEqual([new Error("the engine is busy")]);
    expect(existsSync(folder), "the folder stays until its writes settle").toBe(true);
    expect(storage.listAutomationWorkspaces(), "and so does its row").toHaveLength(1);
    expect(outcome(raw, "sent")[0]).toBe("recorded");
    expect(vi.getTimerCount(), "only its retry, and no deadline that wakes at once").toBe(1);

    engine.receipts(new Map([receipt("sent", 1)]));
    next = passes.next();
    await vi.advanceTimersByTimeAsync(2_000);
    await next;
    expect(outcome(raw, "sent")).toEqual(["saved", "published", { threadId: "thread" }]);
    expect(existsSync(folder)).toBe(false);
    expect(storage.listAutomationWorkspaces()).toEqual([]);
  });

  // An account's deletion, as main.ts runs it, over the copies, and the folder of the copy of WORKSPACE.
  async function deletingAccount(storage: SyncRelayStorage) {
    const errors: Array<[unknown, string | undefined]> = [];
    const { running } = await stepped(storage, () => automation([WORKSPACE]), { onError: (error, workspaceId) => errors.push([error, workspaceId]) });
    const folder = join(running.replica(WORKSPACE)!.root, "..", "..");
    cleanup.push(async () => { stuck.path = null; });
    let runtimeDone = false;
    const deletion = createAccountDeletionRoute({ storage: storage as StorageContext, key: "bearer", fenceKey: "fence", invalidate() {},
      deleteRuntime: async () => running.deleteWorkspaces([WORKSPACE]),
      afterPhase(phase) { if (phase === "runtime") runtimeDone = true; } });
    return { running, folder, errors, deletion, runtimeDone: () => runtimeDone };
  }
  const operationRows = (raw: ReturnType<typeof inspectDatabase>) => raw.prepare("SELECT count(*) AS n FROM sync_relay_account_operations").get();

  it("deletes an account whose copy's phone writes can't be read, and reports the copy, with its folder and rows gone", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    const { running, folder, errors, deletion } = await deletingAccount(storage);
    phoneWrite(storage, "sent");
    accept(raw, "sent", 1);
    engine.receipts(new Error("the engine is busy"));
    await deletion.purge("owner", "owner@example.test");
    expect(errors).toContainEqual([new Error("the engine is busy"), WORKSPACE]);
    expect(running.replica(WORKSPACE)).toBeUndefined();
    expect(existsSync(folder)).toBe(false);
    expect(storage.listAutomationWorkspaces()).toEqual([]);
    expect(operationRows(raw)).toEqual({ n: 0 });
  });

  it("keeps an account's deletion pending while its copy's folder can't be removed, and finishes once it can", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    const { folder, deletion, runtimeDone } = await deletingAccount(storage);
    phoneWrite(storage, "sent");
    accept(raw, "sent", 1);
    engine.receipts(new Map([receipt("sent", 1)]));
    stuck.path = folder;
    await expect(deletion.purge("owner", "owner@example.test")).rejects.toThrow("the folder is busy");
    expect(runtimeDone(), "the deletion stays in its fenced phase").toBe(false);
    expect(existsSync(folder)).toBe(true);
    expect(outcome(raw, "sent"), "its writes settled before the folder was to go").toEqual(["saved", "published", { threadId: "thread" }]);

    stuck.path = null;
    await deletion.purge("owner", "owner@example.test");
    expect(runtimeDone()).toBe(true);
    expect(existsSync(folder)).toBe(false);
    expect(operationRows(raw)).toEqual({ n: 0 });
  });

  it("reads the phone's writes' receipts when a restarted copy's first sync fails, and stalls them on a whole-push rejection", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    const { running: first, root, pass } = await stepped(storage, () => automation([WORKSPACE]));
    phoneWrite(storage, "sent");
    phoneWrite(storage, "held");
    await pass();
    await first.close();
    accept(raw, "sent", 1);
    engine.receipts(new Map([receipt("sent", 1), receipt("held", 2, "pending")]));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    cleanup.push(async () => { logged.mockRestore(); });
    engine.failPush(new EngineRequestError(1, { code: "AUTHORSHIP_MISMATCH", message: "chat op author does not match", retry: "no" }));
    const errors: unknown[] = [];
    // The restart's first pass opens the copy, and its first sync fails; no retry runs.
    const { running: restarted } = await stepped(storage, () => automation([WORKSPACE]), { root, onError: (error) => errors.push(error) });
    expect([outcome(raw, "sent")[0], outcome(raw, "held")[0]]).toEqual(["saved", "stalled"]);
    expect(restarted.replica(WORKSPACE), "the copy never opened").toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  it("stalls the phone's writes past their active time on a copy whose background sync keeps failing", async () => {
    const { storage, raw, log } = await relay();
    const engine = fakeEngine();
    const clock = { ms: 0 };
    const errors: unknown[] = [];
    const { running, pass } = await stepped(storage, () => automation([WORKSPACE]), { clock, onError: (error) => errors.push(error) });
    phoneWrite(storage, "sent");
    engine.receipts(new Map([receipt("sent", 1, "pending")]));
    await pass();
    expect(outcome(raw, "sent")[0]).toBe("recorded");
    // Every sync fails from now on, and the relay has something to pull.
    engine.failPush(true);
    clock.ms = OPERATION_ACTIVE_MS;
    log(1);
    // The pass's pull of the copy fails; its writes are looked at all the same.
    await pass();
    expect(outcome(raw, "sent")[0]).toBe("stalled");
    expect(running.failedSyncs().has(WORKSPACE)).toBe(true);
    expect(running.replica(WORKSPACE), "a stalled write still keeps its copy").toBeDefined();
  });

  it("refuses an earlier incarnation's unpublished phone writes before the new incarnation pushes anything", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    engine.receipts(new Map([receipt("unsent", 1, "pending")]));
    const { running, pass } = await stepped(storage, () => automation([WORKSPACE]), { clock: { ms: 1 } });
    const first = running.replica(WORKSPACE)!;
    phoneWrite(storage, "unsent");
    await pass();
    const before = engine.sent.length;
    storage.rotateWorkspaceIdentity({ workspaceId: WORKSPACE, ownerUserId: "owner", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 2 });
    await pass();
    expect(running.replica(WORKSPACE)).toMatchObject({ incarnation: 2 });
    expect(outcome(raw, "unsent")).toEqual(["refused", "pending", { threadId: "thread", reason: "This workspace changed on your server" }]);
    const after = engine.sent.slice(before).map((request) => request.method);
    expect(after.indexOf("sync.ordinary.publicationState")).toBeGreaterThanOrEqual(0);
    expect(after.indexOf("sync.ordinary.publicationState"), "settled before the new incarnation pushes").toBeLessThan(after.indexOf("sync.push"));
    expect(existsSync(first.root)).toBe(false);
  });

  it("refuses the phone's writes in a copy whose folder was lost, and replays none of them in its new folder", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    const { running: first, root, pass } = await stepped(storage, () => automation([WORKSPACE]), { clock: { ms: 1 } });
    phoneWrite(storage, "lost");
    await pass();
    await first.close();
    await rm(join(root, folders(root)[0]!), { recursive: true, force: true });
    const reads = count(engine, "sync.ordinary.publicationState");
    const { running: restarted } = await stepped(storage, () => automation([WORKSPACE]), { root, clock: { ms: 2 } });
    expect(outcome(raw, "lost")).toEqual(["refused", "pending", { threadId: null, reason: "Couldn't send" }]);
    expect(count(engine, "sync.ordinary.publicationState"), "no folder, so no receipt to read").toBe(reads);
    expect(restarted.replica(WORKSPACE)).toMatchObject({ incarnation: 1 });
  });

  it("settles the phone's writes in a folder no row names before the sweep removes it", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    const { running: first, root, pass } = await stepped(storage, () => automation([WORKSPACE]));
    // Hidden from the phone, the writes no longer keep the copy.
    storage.setShowOnPhone({ ownerUserId: "owner", workspaceId: WORKSPACE, showOnPhone: false });
    phoneWrite(storage, "sent");
    accept(raw, "sent", 1);
    await pass();
    await first.close();
    inspectDatabase(storagePath(storage), { foreignKeys: true }).prepare("DELETE FROM sync_relay_automation_workspaces WHERE workspace_id = ?").run(WORKSPACE);
    engine.receipts(new Map([receipt("sent", 1)]));
    // The later start's first pass sweeps the folder no row names.
    await stepped(storage, () => new Map(), { root });
    expect(outcome(raw, "sent")).toEqual(["saved", "published", { threadId: "thread" }]);
    expect(folders(root)).toEqual([]);
  });

  it("settles the phone's writes before removing every copy when copies are off, and keeps one whose receipts can't be read", async () => {
    const { storage, raw } = await relay();
    storage.claimWorkspace({ workspaceId: "ledger", ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({ workspaceId: "ledger", replicationEpoch: "epoch", streamIdentity: "stream" });
    const engine = fakeEngine();
    const { running, root, pass } = await stepped(storage, () => automation([WORKSPACE, "ledger"]));
    storage.setShowOnPhone({ ownerUserId: "owner", workspaceId: WORKSPACE, showOnPhone: false });
    phoneWrite(storage, "sent");
    accept(raw, "sent", 1);
    await pass();
    await running.close();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    cleanup.push(async () => { logged.mockRestore(); });
    const settle = { namespace, engineExecutable: process.execPath };
    engine.receipts(new Error("the engine is busy"));
    await removeAutomationReplicas(storage, root, settle);
    expect(storage.listAutomationWorkspaces().map((row) => row.workspaceId)).toEqual([WORKSPACE]);
    expect(folders(root)).toHaveLength(1);
    expect(outcome(raw, "sent")[0]).toBe("recorded");
    expect(logged).toHaveBeenCalled();

    engine.receipts(new Map([receipt("sent", 1)]));
    await removeAutomationReplicas(storage, root, settle);
    expect(outcome(raw, "sent")).toEqual(["saved", "published", { threadId: "thread" }]);
    expect(existsSync(root)).toBe(false);
    expect(storage.listAutomationWorkspaces()).toEqual([]);
  });

  it("keeps publishing a copy's phone writes when nothing new reaches the relay, stalls them past their active time, and saves them later", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    const clock = { ms: 0 };
    const { running, pass, wantPublishing } = await visitedThenPublishing(storage, clock);
    // The visit's write stays to publish once the visit ends.
    phoneWrite(storage, "sent");
    engine.receipts(new Map([receipt("sent", 1, "pending")]));
    wantPublishing();
    await pass();
    expect(running.replica(WORKSPACE)?.reasons).toEqual(["account", "publication"]);
    const reads = count(engine, "sync.ordinary.publicationState"), pushes = count(engine, "sync.push");
    expect(reads).toBeGreaterThan(0);
    // The relay's head doesn't move, and the copy still pushes and looks again.
    await pass(WORKSPACE);
    expect(count(engine, "sync.ordinary.publicationState")).toBeGreaterThan(reads);
    expect(count(engine, "sync.push")).toBeGreaterThan(pushes);
    expect(outcome(raw, "sent")[0]).toBe("recorded");

    clock.ms = OPERATION_ACTIVE_MS;
    await pass(WORKSPACE);
    expect(outcome(raw, "sent")[0]).toBe("stalled");
    expect(running.replica(WORKSPACE), "a stalled write still keeps its copy").toBeDefined();

    engine.receipts(new Map([receipt("sent", 1)]));
    accept(raw, "sent", 1);
    await pass(WORKSPACE);
    expect(outcome(raw, "sent")).toEqual(["saved", "published", { threadId: "thread" }]);
    // The next pass gives back the reason the saved write held.
    await pass();
    expect(storage.listAutomationWorkspaces()[0]?.reasons, "saved, it keeps the copy no more").toEqual(["account"]);
  });

  it("stalls a copy's phone writes once their receipts keep failing to read, and keeps the copy", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    const { running, pass, wantPublishing } = await visitedThenPublishing(storage, { ms: 0 });
    phoneWrite(storage, "sent");
    engine.receipts(new Error("the engine is busy"));
    wantPublishing();
    // Each pass for the copy reads its receipts once, and the fifth failure in a row stalls the write.
    for (let attempt = 0; attempt < 4; attempt++) {
      await pass(WORKSPACE);
      expect(outcome(raw, "sent")[0], `after ${attempt + 1} failed reads`).toBe("recorded");
    }
    await pass(WORKSPACE);
    expect(outcome(raw, "sent")[0]).toBe("stalled");
    expect(running.replica(WORKSPACE)).toBeDefined();
    expect(storage.listAutomationWorkspaces()[0]?.reasons).toEqual(["account", "publication"]);
  });
});
