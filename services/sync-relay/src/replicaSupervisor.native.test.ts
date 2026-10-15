import { afterEach, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Duplex } from "node:stream";
import { requireEngineBinaryOrSkip } from "../../../apps/desktop/src/testing/engineBinary";
import { EngineClient, DuplexEngineClientConnection } from "@dohc/workspace-engine-client/daemon";
import { openEngineYdocProviderSession } from "../../../packages/workspace-engine-client/src/ydoc/ydocProviderSession";
import { closeTestStorages, closeTestStorage, reopenTestStorage, inspectDatabase, storagePath, tempRoot, testHandler, testStorage } from "./testing";
import { createReplicaSupervisor } from "./replicaSupervisor";
import { createReplicaEngineStarter } from "./replicaEngine";
import { REPLICA_READ_PREFIX } from "./replicaReadPrincipal";

const engineBinary = requireEngineBinaryOrSkip();
afterEach(closeTestStorages);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it.skipIf(engineBinary.missing)("supervised passive child converges through the four owner scenarios", async () => {
  const executable = engineBinary.require();
  const root = await tempRoot("supervised-native"), storage = await testStorage();
  const owner = "replica-owner@dohc.test", workspaceId = "supervised", bearer = `user:${owner}`;
  const ownerHandler = testHandler(storage);
  const requests: Array<{ method: string; path: string; replica: boolean }> = [];
  const relayDb = inspectDatabase(storagePath(storage));
  const tables = relayDb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => String(row.name));
  const digest = () => sha(Buffer.from(JSON.stringify(tables.map(name => [name, relayDb.prepare(`SELECT * FROM "${name}"`).all()]))));
  let supervisor!: ReturnType<typeof createReplicaSupervisor>;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const replica = incoming.headers.authorization?.includes(REPLICA_READ_PREFIX) ?? false;
      requests.push({ method: incoming.method!, path: incoming.url!, replica });
      const request = new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method,
        headers: incoming.headers as Record<string, string>, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      const before = replica ? digest() : undefined;
      const response = await (replica ? supervisor.handle(request) : ownerHandler(request));
      if (replica) expect(digest()).toBe(before);
      const bytes = Buffer.from(await response.arrayBuffer());
      outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers), "content-length": bytes.length }); outgoing.end(bytes);
    } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("Missing relay port.");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const stores = new Map<string, { dir: string }>();
  const start = createReplicaEngineStarter({ engineExecutable: executable!, baseUrl,
    allowUnisolatedDevelopment: true, allowInsecureLoopbackForTests: true });
  const failures: unknown[] = [];
  let attempts = 0, roleRefusals = 0;
  supervisor = createReplicaSupervisor({ storage, storeRoot: join(root, "replicas"), idleMs: 120_000,
    onError: (_, error) => failures.push(String(error)), startChild: async input => {
      attempts++;
      if (attempts === 1) {
        const poisoned = await openOwner(input.storeDir, false, true);
        const db = new DatabaseSync(join(input.storeDir, ".dohc/engine/engine.db"), { readOnly: true });
        try { expect(db.prepare("SELECT store_role FROM engine_ownership").get()?.store_role).toBe("owner"); }
        finally { db.close(); }
        poisoned.client.close(); poisoned.child.kill("SIGKILL"); await poisoned.client.waitForExit();
        engines.splice(engines.indexOf(poisoned), 1);
      } else expect(existsSync(join(input.storeDir, ".dohc"))).toBe(false);
      try {
        const child = await start(input); stores.set(input.lease.workspaceId, { dir: input.storeDir });
        return child;
      } catch (error) {
        expect(error).toMatchObject({ name: "EngineRequestError", message: "workspace operation failed" });
        roleRefusals++; throw error;
      }
    } });
  const engines: Array<{ dir: string; workspace: string; client: EngineClient; child: ReturnType<typeof spawn> }> = [];
  let requestId = 1;
  const rpc = async (engine: typeof engines[number], method: string, params: Record<string, unknown> = {}): Promise<any> => {
    const response = await engine.client.sendRequest({ id: requestId++, method, workspace: engine.workspace || undefined,
      deadlineMs: 120_000, params: params as never }); return response.result;
  };
  const openOwner = async (name: string, capture = false, privatePath = false) => {
    const dir = privatePath ? name : join(root, name); mkdirSync(dir, { recursive: true });
    const child = spawn(executable!, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { DOHC_ENGINE_AUTH_TOKEN: "supervisor-test-owner" } });
    const stream = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
    const termination = new Promise<void>(done => child.once("close", () => done()));
    const client = new EngineClient(new DuplexEngineClientConnection(stream), { authToken: "supervisor-test-owner",
      protocolVersion: 2, capabilities: ["blobs"] }, () => child.kill("SIGKILL"), termination);
    child.on("close", (code, signal) => client.notifyProcessExit(code, signal)); child.stderr!.resume();
    const engine = { dir, child, client, workspace: "" }; engines.push(engine); await client.ready();
    engine.workspace = (await rpc(engine, "workspace.open", { rootDir: dir, workspaceId,
      ...(capture ? {} : { captureMode: "none" }), recoverRunningDispatches: false,
      relay: { baseUrl, bearerToken: bearer, allowInsecureLoopbackForTests: true } })).workspace;
    await rpc(engine, "versions.ensureMain", { workspaceId }); return engine;
  };
  const push = async (engine: typeof engines[number]) => { let page; do { page = await rpc(engine, "sync.push", { workspaceId }); } while (page.hasMore); };
  const pull = async (engine: typeof engines[number]) => { let page; do {
    page = await rpc(engine, "sync.pull", { workspaceId });
    await rpc(engine, "sync.materializePendingCursor", { workspaceId, pendingCursor: page.pendingCursor });
    await rpc(engine, "sync.commitCursor", { workspaceId, pendingCursor: page.pendingCursor });
  } while (page.hasMore); };
  const share = (id: string) => storage.createShare({ share: { shareId: id, workspaceId: id, granterUserId: owner, selectorJson: '{"paths":[],"versionId":"main"}', createdAtMs: 1 },
    grant: { grantId: id, shareId: id, principalKind: "user", principalUserId: "reader", principalEmail: null,
      access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null } });
  const inspect = <T>(id: string, read: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(stores.get(id)!.dir, ".dohc/engine/engine.db"), { readOnly: true });
    try { return read(db); } finally { db.close(); }
  };
  const stored = (path: string, id = workspaceId) => inspect(id, db => db.prepare(
    "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.version_id='main' AND s.path=?").get(path)?.text);
  const untouched = () => {
    expect(readdirSync(stores.get(workspaceId)!.dir)).toEqual([".dohc"]);
    inspect(workspaceId, db => {
      for (const table of ["materialization_jobs", "automation_claims"]) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM replication_log WHERE imported=0").get()!.n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM conflicts WHERE status='open'").get()!.n).toBe(0);
    });
    expect(requests.filter(request => request.replica && request.method !== "GET")).toEqual([]); expect(failures).toEqual([]);
  };
  const drain = async () => { await supervisor.settled(workspaceId); untouched(); };
  const scenarioTexts: Record<string, string> = {};
  const providers: Array<Awaited<ReturnType<typeof openEngineYdocProviderSession>>> = [];
  try {
    const a = await openOwner("owner-a", true); await rpc(a, "sync.claim", { workspaceId });
    await rpc(a, "versionedText.write", { versionId: "main", path: "scenario.txt", text: "base", momentId: "scenario-base", origin: "api", publish: true });
    await push(a); share(workspaceId);
    await supervisor.activate(workspaceId);
    expect(attempts).toBe(2); expect(roleRefusals).toBe(1);
    inspect(workspaceId, db => expect(db.prepare("SELECT store_role FROM engine_ownership").get()?.store_role).toBe("passive"));
    expect(stored("scenario.txt")).toBe("base"); untouched();
    const b = await openOwner("owner-b"); await rpc(b, "sync.adoptJoinIdentity", { workspaceId, ...storage.getWorkspaceIdentity(workspaceId)! }); await pull(b);
    const session = async (engine: typeof engines[number]) => {
      const provider = await openEngineYdocProviderSession({ transport: engine.client, workspace: engine.workspace,
        versionId: "main", path: "scenario.txt", contentKind: "plaintext", onRemoteUpdate() {} });
      providers.push(provider); return provider;
    };
    const edit = async (provider: typeof providers[number], text: string) => {
      let delta!: Uint8Array; provider.doc.once("update", update => { delta = update; });
      provider.doc.getText("plainText").insert(0, text); await provider.applyLocalUpdate(delta, { armSettle: false }); await provider.settleNow();
    };
    const equal = async (name: string) => {
      await drain(); expect(Buffer.from(String(stored("scenario.txt")), "utf8")).toEqual(readFileSync(join(a.dir, "scenario.txt")));
      scenarioTexts[name] = String(stored("scenario.txt"));
    };
    const pa = await session(a), pb = await session(b);
    await edit(pa, "A "); await edit(pb, "B "); await push(a); await push(b); await pull(a); await pull(b);
    await pa.settleNow(); await pb.settleNow(); await equal("concurrentTwoOwners");
    await edit(pb, "delayed "); await edit(pa, "online "); await push(a); await drain(); await push(b); await pull(a); await pull(b);
    await pa.settleNow(); await pb.settleNow(); await equal("delayedPush");
    await pa.close();
    await rpc(a, "versionedText.write", { versionId: "main", path: "scenario.txt", text: "changed", momentId: "scenario-changed", origin: "api", publish: true });
    await push(a); await pull(b); await drain();
    await rpc(a, "versionedText.write", { versionId: "main", path: "scenario.txt", text: scenarioTexts.delayedPush,
      restoreBeforeMomentId: "scenario-changed", momentId: "scenario-restore", origin: "restore", publish: true });
    await push(a); await pull(b); await pb.nativeOwner?.resyncIfNeeded(); await pb.settleNow(); await equal("restoreWithOpenEditor"); await pb.close();
    let hold = await rpc(a, "capture.hold"); renameSync(join(a.dir, "scenario.txt"), join(a.dir, "renamed.txt"));
    await rpc(a, "versionedText.rename", { versionId: "main", fromPath: "scenario.txt", toPath: "renamed.txt", origin: "api", captureHoldId: hold.holdId });
    await rpc(a, "capture.release", { holdId: hold.holdId }); await push(a); await pull(b); await drain();
    expect(Buffer.from(String(stored("renamed.txt")), "utf8")).toEqual(readFileSync(join(a.dir, "renamed.txt")));
    const replica = stores.get(workspaceId)!;
    hold = await rpc(a, "capture.hold"); rmSync(join(a.dir, "renamed.txt"));
    const deleted = await rpc(a, "versionedText.delete", { versionId: "main", path: "renamed.txt", origin: "api", captureHoldId: hold.holdId });
    await rpc(a, "capture.release", { holdId: hold.holdId }); await push(a); await pull(b); await drain(); expect(stored("renamed.txt")).toBeUndefined();
    await rpc(a, "versionedText.write", { versionId: "main", path: "renamed.txt", text: scenarioTexts.restoreWithOpenEditor,
      restoreBeforeMomentId: deleted.moment.momentId, origin: "restore", publish: true });
    await push(a); await pull(b); await drain();
    expect(Buffer.from(String(stored("renamed.txt")), "utf8")).toEqual(readFileSync(join(a.dir, "renamed.txt")));
    const pullWithView=await rpc(b,"sync.pull",{workspaceId});expect(pullWithView.applied).toBe(0);
    await rpc(b,"sync.materializePendingCursor",{workspaceId,pendingCursor:pullWithView.pendingCursor});await rpc(b,"sync.commitCursor",{workspaceId,pendingCursor:pullWithView.pendingCursor});
    await supervisor.close();
    expect(Number(relayDb.prepare("SELECT count(*) AS n FROM sync_relay_replica_cut_files WHERE workspace_id=?").get(workspaceId)!.n)).toBeGreaterThan(0);
    const dbPath=storagePath(storage);closeTestStorage(storage);const restartedStorage=reopenTestStorage(dbPath);
    supervisor=createReplicaSupervisor({storage:restartedStorage,storeRoot:join(root,"replicas"),idleMs:20,onError:(_,error)=>failures.push(String(error)),startChild:async input=>{const child=await start(input);stores.set(input.lease.workspaceId,{dir:input.storeDir});return child;}});
    await supervisor.activate(workspaceId);const idleStore=stores.get(workspaceId)!.dir;
    await expect.poll(()=>existsSync(idleStore)).toBe(false);
    expect(Number(relayDb.prepare("SELECT count(*) AS n FROM sync_relay_replica_cut_files WHERE workspace_id=?").get(workspaceId)!.n)).toBeGreaterThan(0);
    await supervisor.close();closeTestStorage(restartedStorage);const afterIdleRestart=reopenTestStorage(dbPath);
    expect(Number(relayDb.prepare("SELECT count(*) AS n FROM sync_relay_replica_cut_files WHERE workspace_id=?").get(workspaceId)!.n)).toBeGreaterThan(0);
    afterIdleRestart.revokeShareGrant({shareId:workspaceId,grantId:workspaceId,revokedAtMs:2});
    expect(relayDb.prepare("SELECT count(*) AS n FROM sync_relay_replica_cuts").get()!.n).toBe(0);
    expect(relayDb.prepare("SELECT count(*) AS n FROM sync_relay_replica_cut_texts").get()!.n).toBe(0);expect(failures).toEqual([]);
  } finally {
    for (const provider of providers) await provider.close().catch(() => {});
    await supervisor.close();
    for (const engine of engines.reverse()) { engine.client.close(); engine.child.kill("SIGKILL"); await engine.client.waitForExit(); }
    server.close(); await once(server, "close"); await closeTestStorages();
  }
}, 600_000);
