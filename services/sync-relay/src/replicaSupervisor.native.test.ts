import { afterEach, expect, it } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Duplex } from "node:stream";
import * as Y from "yjs";
import { EngineClient, DuplexEngineClientConnection } from "@dohc/workspace-engine-client/daemon";
import { openEngineYdocProviderSession } from "../../../packages/workspace-engine-client/src/ydoc/ydocProviderSession";
import { closeTestStorages, inspectDatabase, storagePath, tempRoot, testHandler, testStorage } from "./testing";
import { createReplicaSupervisor } from "./replicaSupervisor";
import { createReplicaEngineStarter } from "./replicaEngine";
import { REPLICA_READ_PREFIX } from "./replicaReadPrincipal";

const executable = process.env.REPLICA_SUPERVISOR_ENGINE;
afterEach(closeTestStorages);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it.skipIf(!executable)("supervised passive child converges through the four owner scenarios and measures cost", async () => {
  const evidence = process.env.REPLICA_SUPERVISOR_EVIDENCE ?? resolve("../../.agent-artifacts/replica-supervisor");
  mkdirSync(evidence, { recursive: true });
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
  const stores = new Map<string, { dir: string; pid: number }>();
  const start = createReplicaEngineStarter({ engineExecutable: executable!, baseUrl,
    allowUnisolatedDevelopment: true, allowInsecureLoopbackForTests: true });
  const failures: unknown[] = [];
  supervisor = createReplicaSupervisor({ storage, storeRoot: join(root, "replicas"), idleMs: 120_000,
    onError: (_, error) => failures.push(String(error)), startChild: async input => {
      const child = await start(input); stores.set(input.lease.workspaceId, { dir: input.storeDir, pid: child.pid! });
      recordProcesses();
      return child;
    } });
  const engines: Array<{ dir: string; workspace: string; client: EngineClient; child: ReturnType<typeof spawn> }> = [];
  function recordProcesses() {
    writeFileSync(join(evidence, "processes.json"), JSON.stringify({ executable,
      owners: engines.map(engine => ({ pid: engine.child.pid, dir: engine.dir })),
      replicas: [...stores.entries()].map(([id, value]) => ({ workspaceId: id, ...value })),
    }, null, 2));
  }
  let requestId = 1;
  const rpc = async (engine: typeof engines[number], method: string, params: Record<string, unknown> = {}): Promise<any> => {
    const response = await engine.client.sendRequest({ id: requestId++, method, workspace: engine.workspace || undefined,
      deadlineMs: 120_000, params: params as never }); return response.result;
  };
  const openOwner = async (name: string, capture = false) => {
    const dir = join(root, name); mkdirSync(dir);
    const child = spawn(executable!, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { DOHC_ENGINE_AUTH_TOKEN: "supervisor-test-owner" } });
    const stream = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
    const termination = new Promise<void>(done => child.once("close", () => done()));
    const client = new EngineClient(new DuplexEngineClientConnection(stream), { authToken: "supervisor-test-owner",
      protocolVersion: 2, capabilities: ["blobs"] }, () => child.kill("SIGKILL"), termination);
    child.on("close", (code, signal) => client.notifyProcessExit(code, signal)); child.stderr!.resume();
    const engine = { dir, child, client, workspace: "" }; engines.push(engine); recordProcesses(); await client.ready();
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
  const share = (id: string) => storage.createShare({ share: { shareId: id, workspaceId: id, granterUserId: owner, selectorJson: "{}", createdAtMs: 1 },
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
  const report: Record<string, any> = { startedAt: new Date().toISOString(), executableSha256: sha(readFileSync(executable!)), scenarios: {} };
  const providers: Array<Awaited<ReturnType<typeof openEngineYdocProviderSession>>> = [];
  try {
    const a = await openOwner("owner-a", true); await rpc(a, "sync.claim", { workspaceId });
    await rpc(a, "versionedText.write", { versionId: "main", path: "scenario.txt", text: "base", momentId: "scenario-base", origin: "api", publish: true });
    await push(a); share(workspaceId);
    const began = performance.now(); await supervisor.activate(workspaceId);
    expect(stored("scenario.txt")).toBe("base"); report.smallActivationMs = performance.now() - began; untouched();
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
      report.scenarios[name] = { exactBytes: true, text: stored("scenario.txt") };
    };
    const pa = await session(a), pb = await session(b);
    await edit(pa, "A "); await edit(pb, "B "); await push(a); await push(b); await pull(a); await pull(b);
    await pa.settleNow(); await pb.settleNow(); await equal("concurrentTwoOwners");
    await edit(pb, "delayed "); await edit(pa, "online "); await push(a); await drain(); await push(b); await pull(a); await pull(b);
    await pa.settleNow(); await pb.settleNow(); await equal("delayedPush");
    await pa.close();
    await rpc(a, "versionedText.write", { versionId: "main", path: "scenario.txt", text: "changed", momentId: "scenario-changed", origin: "api", publish: true });
    await push(a); await pull(b); await drain();
    await rpc(a, "versionedText.write", { versionId: "main", path: "scenario.txt", text: report.scenarios.delayedPush.text,
      restoreBeforeMomentId: "scenario-changed", momentId: "scenario-restore", origin: "restore", publish: true });
    await push(a); await pull(b); await pb.nativeOwner?.resyncIfNeeded(); await pb.settleNow(); await equal("restoreWithOpenEditor"); await pb.close();
    let hold = await rpc(a, "capture.hold"); renameSync(join(a.dir, "scenario.txt"), join(a.dir, "renamed.txt"));
    await rpc(a, "versionedText.rename", { versionId: "main", fromPath: "scenario.txt", toPath: "renamed.txt", origin: "api", captureHoldId: hold.holdId });
    await rpc(a, "capture.release", { holdId: hold.holdId }); await push(a); await pull(b); await drain();
    expect(Buffer.from(String(stored("renamed.txt")), "utf8")).toEqual(readFileSync(join(a.dir, "renamed.txt")));
    hold = await rpc(a, "capture.hold"); rmSync(join(a.dir, "renamed.txt"));
    const deleted = await rpc(a, "versionedText.delete", { versionId: "main", path: "renamed.txt", origin: "api", captureHoldId: hold.holdId });
    await rpc(a, "capture.release", { holdId: hold.holdId }); await push(a); await pull(b); await drain(); expect(stored("renamed.txt")).toBeUndefined();
    await rpc(a, "versionedText.write", { versionId: "main", path: "renamed.txt", text: report.scenarios.restoreWithOpenEditor.text,
      restoreBeforeMomentId: deleted.moment.momentId, origin: "restore", publish: true });
    await push(a); await pull(b); await drain();
    expect(Buffer.from(String(stored("renamed.txt")), "utf8")).toEqual(readFileSync(join(a.dir, "renamed.txt")));
    report.scenarios.renameDeleteRestore = { exactBytes: true, text: stored("renamed.txt") };
    const replica = stores.get(workspaceId)!;
    if (process.platform === "win32") report.workingSetBytes = Number(execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${replica.pid}).WorkingSet64`], { encoding: "utf8", windowsHide: true }).trim());
    const retirement = performance.now(); storage.revokeShareGrant({ shareId: workspaceId, grantId: workspaceId, revokedAtMs: 2 });
    await supervisor.settled(workspaceId); expect(existsSync(replica.dir)).toBe(false); report.shareEvictionMs = performance.now() - retirement;
    report.replicaWriteRequests = requests.filter(request => request.replica && request.method !== "GET"); report.tableCount = tables.length;
    report.allReplicaReadsLeftTablesUnchanged = true; report.verdict = "PASS";
  } catch (error) { report.verdict = "FAIL"; report.error = String(error); report.failures = failures; throw error; }
  finally {
    for (const provider of providers) await provider.close().catch(() => {});
    await supervisor.close();
    for (const engine of engines.reverse()) { engine.client.close(); engine.child.kill("SIGKILL"); await engine.client.waitForExit(); }
    server.close(); await once(server, "close"); await closeTestStorages();
    report.finishedAt = new Date().toISOString(); writeFileSync(join(evidence, "scenarios.json"), JSON.stringify(report, null, 2));
  }
}, 600_000);

it.skipIf(!executable || !process.env.REPLICA_SUPERVISOR_COST)("measures the spike's 100-document activation", async () => {
  const evidence = process.env.REPLICA_SUPERVISOR_EVIDENCE ?? resolve("../../.agent-artifacts/replica-supervisor");
  mkdirSync(evidence, { recursive: true });
  const storage = await testStorage(), root = await tempRoot("supervisor-cost");
  const workspaceId = "cold", ownerUserId = "cost-owner@dohc.test";
  storage.claimWorkspace({ workspaceId, ownerUserId, createdAtMs: 1 });
  storage.claimWorkspaceIdentity({ workspaceId, replicationEpoch: "epoch", streamIdentity: "stream" });
  storage.createShare({ share: { shareId: workspaceId, workspaceId, granterUserId: ownerUserId, selectorJson: "{}", createdAtMs: 1 },
    grant: { grantId: workspaceId, shareId: workspaceId, principalKind: "user", principalUserId: "reader", principalEmail: null,
      access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null } });
  const expected = new Map<string, string>();
  const ops: Parameters<typeof storage.appendLogBatch>[0]["ops"] = [{ originSeq: 0, opKind: "workspace.init", payloadJson: "{}", recordedAtMs: 1 }];
  const put = (bytes: Uint8Array) => { const sha256 = sha(bytes); storage.putBlob({ workspaceId, sha256, content: bytes, createdAtMs: 1 }); return sha256; };
  for (let n = 0; n < 100; n++) {
    const doc = new Y.Doc(), text = `doc-${String(n).padStart(3, "0")}\n${"a".repeat(49_992)}`;
    doc.getText("plainText").insert(0, text); const lineageClaimId = put(Y.encodeStateAsUpdate(doc));
    const add = (updateBlobSha256: string, isBaseState: boolean) => ops.push({ originSeq: ops.length, opKind: "ydoc.update", recordedAtMs: 1,
      payloadJson: JSON.stringify({ versionId: "main", objectId: `doc-${n}`, path: `doc-${n}.txt`, contentKind: "plaintext", updateBlobSha256, lineageClaimId, isBaseState }) });
    add(lineageClaimId, true);
    for (let edit = 0; edit < 100; edit++) {
      let delta!: Uint8Array; doc.once("update", update => { delta = update; }); doc.getText("plainText").insert(0, "x"); add(put(delta), false);
    }
    expected.set(`doc-${n}.txt`, `${"x".repeat(100)}${text}`); doc.destroy();
  }
  storage.appendLogBatch({ workspaceId, originId: "owner", ops });
  let supervisor!: ReturnType<typeof createReplicaSupervisor>;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const response = await supervisor.handle(new Request(`http://127.0.0.1${incoming.url}`, { headers: incoming.headers as Record<string, string> }));
      const bytes = Buffer.from(await response.arrayBuffer()); outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers), "content-length": bytes.length }); outgoing.end(bytes);
    } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing port.");
  let storeDir = "";
  const start = createReplicaEngineStarter({ engineExecutable: executable!, baseUrl: `http://127.0.0.1:${address.port}`,
    allowUnisolatedDevelopment: true, allowInsecureLoopbackForTests: true });
  supervisor = createReplicaSupervisor({ storage, storeRoot: root, startChild: async input => {
    storeDir = input.storeDir; const child = await start(input);
    writeFileSync(join(evidence, "cold-process.json"), JSON.stringify({ executable, pid: child.pid, storeDir }, null, 2)); return child;
  } });
  const report: Record<string, unknown> = { documents: 100, baseBytesEach: 50_000, updatesEach: 100, ops: ops.length };
  try {
    const began = performance.now(); await supervisor.activate(workspaceId); report.activationMs = performance.now() - began;
    const db = new DatabaseSync(join(storeDir, ".dohc/engine/engine.db"), { readOnly: true });
    try { for (const [path, text] of expected) expect(db.prepare("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.path=?").get(path)?.text).toBe(text); }
    finally { db.close(); }
    report.verdict = "PASS";
  } catch (error) { report.verdict = "FAIL"; report.error = String(error); throw error; }
  finally { await supervisor.close(); server.close(); await once(server, "close"); await closeTestStorages(); writeFileSync(join(evidence, "cold-cost.json"), JSON.stringify(report, null, 2)); }
}, 900_000);
