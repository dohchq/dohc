import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {once} from "node:events";
import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {join} from "node:path";
import {createInterface} from "node:readline";
import {DatabaseSync} from "node:sqlite";
import {Duplex} from "node:stream";
import * as Y from "yjs";
import {EngineClient, DuplexEngineClientConnection} from "@dohc/workspace-engine-client/daemon";
import {YdocLiveAdapter} from "../../../packages/workspace-engine-client/src/ydoc/ydocLiveAdapter";
import {OwnerKnownRefusals} from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import {markdownToYDoc, yDocToMarkdown} from "../../../packages/ydoc-projection/src/import-export";
import {createLiveMarkdownRegistrationValidator, createLiveMarkdownJournalValidator} from "../../../packages/ydoc-projection/src/liveDocumentValidation";
import {initializeRelayDeployment, openRelayDeployment} from "./relayDeployment";
import {OwnerCommittedDelivery} from "./ownerCommittedDelivery";
import {ownerBridge} from "./replicaJournal.owner.fixture";
import {LiveCommittedDelivery} from "./liveCommittedDelivery";
import {LiveRestorePreparation} from "./liveRestorePreparation";
import {beginStopRestore, advanceStopRestoreFence} from "./storage/liveRestoreOperation";
import type {StorageContext} from "./storage/context";
import type {LiveHostConnectionCoordinate} from "./storage";
import {createReplicaSupervisor, type ReplicaChild} from "./replicaSupervisor";
import {createReplicaEngineStarter} from "./replicaEngine";
import {createSyncRelayHandler} from "./server";
import {parseCanonicalAdmittedLiveUpdateMetadata} from "@dohc/live-session-contract";
import {nextVersionedAcceptedHistoryDigest} from "./liveAcceptedHistory";

const [root, executable, mode] = process.argv.slice(2) as [string, string, "device" | "service"];
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const policy = {maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000};
let ownerDir = join(root, "owner");
const configPath = join(root, "deployment.json");
mkdirSync(ownerDir, {recursive: true});
if (!existsSync(configPath)) initializeRelayDeployment({configPath, relayPath: join(root, "relay", "relay.sqlite"), continuityDirectory: join(root, "continuity")});
const deployment = openRelayDeployment(configPath), storage = deployment.storage;
storage.claimWorkspace({workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1});
storage.provisionLiveHostControl({mode, hostId: mode, updatedAtMs: 1, guard: storage.captureStanding()});
const actor = {kind: "owner", userId: "owner", shareId: "share"} as const;
let id = 1, originSeq = 0, seedOrigin = "seed", main = "main";
let client: EngineClient, hostProcess: ReturnType<typeof spawn>, handle: string, coordinate: LiveHostConnectionCoordinate;
let bridge: Awaited<ReturnType<typeof ownerBridge>> | undefined;
let consumer: LiveCommittedDelivery | OwnerCommittedDelivery, replica: ReplicaChild, replicaDir = "", starts = 0;
const errors: string[] = [];
const docs = new Map<string, {doc: Y.Doc; baseline: Uint8Array; path: string; lineageClaimId: string; objectId: string}>();
const gates = new Map<string, {entered: Promise<void>; enter: () => void; released: Promise<void>; release: () => void}>();
function gate(name: string) {
  let enter!: () => void, release!: () => void;
  const value = {entered: new Promise<void>(resolve => {enter = resolve;}), released: new Promise<void>(resolve => {release = resolve;}),
    enter: () => enter(), release: () => release()};
  gates.set(name, value); return value;
}
let holdPage = false, holdBeforeRead = false;
let passiveClient: EngineClient, passiveWorkspace: string, passiveId = 1_000_000;
const applications: {applied: number; skipped: number; journalCursor: number}[] = [];
let applyingPage = false, completedPages = 0;
const applyPage = EngineClient.prototype.applyReplicaJournalPage;
EngineClient.prototype.applyReplicaJournalPage = async function (...args) {
  passiveClient = this; passiveWorkspace = args[0].workspace;
  applyingPage = true;
  try {const result = await applyPage.apply(this, args); applications.push(result); return result;}
  finally {applyingPage = false; completedPages++;}
};
async function ordinaryInFlight() {
  let page: Record<string, any>;
  do {
    page = (await passiveClient.sendRequest({id: passiveId++, workspace: passiveWorkspace, method: "sync.pull", deadlineMs: 120_000,
      params: {workspaceId: "workspace"}})).result as Record<string, any>;
    assert.equal(page.refused, 0, JSON.stringify(page));
    await passiveClient.sendRequest({id: passiveId++, workspace: passiveWorkspace, method: "sync.commitCursor", deadlineMs: 120_000,
      params: {workspaceId: "workspace", pendingCursor: page.pendingCursor}});
  } while (page.hasMore);
}
const ownerRoute = createSyncRelayHandler({storage, resolveActor: (request, workspaceId) => {
  assert.equal(request.headers.get("authorization"), "Bearer owner"); return {userId: "owner", workspaceId};
}, resolveUserIdByEmail: email => email === "owner@dohc.test" ? "owner" : null,
  lookupVerifiedUserEmail: userId => `${userId}@dohc.test`, lookupUserEmail: userId => `${userId}@dohc.test`,
  linkKey: "replica-integration-key-at-least-thirty-two-bytes", shareWebOrigin: "https://share.example.test",
  relayExchangeKey: "replica-integration-exchange-at-least-thirty-two-bytes"});
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const request = new Request(`http://127.0.0.1${incoming.url}`, {method: incoming.method, headers: incoming.headers as Record<string, string>,
      ...(chunks.length ? {body: Buffer.concat(chunks)} : {})});
    const response = await ownerRoute(request);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (process.env.DOHC_REPLICA_RETAIN === "1") appendFileSync(join(root, "requests.log"), JSON.stringify({method: incoming.method, path: incoming.url, status: response.status,
      ...(response.status >= 400 ? {body: bytes.toString()} : {})}) + "\n");
    outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers), "content-length": bytes.length }); outgoing.end(bytes);
  } catch (error) {outgoing.writeHead(500); outgoing.end(String(error));}
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const address = server.address(); assert(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;
const startReplica = createReplicaEngineStarter({engineExecutable: executable, allowDevelopment: true});
const supervisor = createReplicaSupervisor({storage, storeRoot: join(root, "replicas"), idleMs: 600_000,
  onError: (_, error) => errors.push(String(error)), startChild: async input => {
    starts++; replicaDir = input.storeDir; replica = await startReplica({...input, relayHandler: async request => {
      const journal = new URL(request.url).pathname.endsWith("/live-journal");
      if (holdPage && holdBeforeRead && journal) {
        holdPage = false; gates.get("page")!.enter(); await gates.get("page")!.released;
      }
      const response = await input.relayHandler(request);
      if (holdPage && journal && (await response.clone().json()).rows.length > 0) {
        holdPage = false; gates.get("page")!.enter(); await gates.get("page")!.released;
      }
      return response;
    }}); return replica;
  }});
async function rpc(method: string, params: Record<string, unknown> = {}) {
  try {return (await client.sendRequest({id: id++, method, workspace: handle, deadlineMs: 120_000, params: params as never})).result as Record<string, any>;}
  catch (error) {throw new Error(`${method}: ${String(error)}`);}
}
async function openHost(configured = true) {
  handle = undefined!;
  coordinate = {mode, hostId: mode, hostEpoch: storage.getLiveHostControl()!.hostEpoch, instanceId: "instance", connectionId: randomUUID()};
  const nativeConfig = join(root, "native.json");
  const ownerConfig = join(root, "desktop-owner.json");
  const ingress = {aggregateBytes: 512 * 1024 * 1024, applicationWorkingReserveBytes: 8 * 1024 * 1024, maxUploads: 2, uploadDeadlineMs: 120_000};
  const sync = {policy: {maxClientVectorBytes: 128 * 1024, maxHostVectorBytes: 128 * 1024, maxOutputBytes: 4 * 1024 * 1024,
    maxReadBytes: 16 * 1024 * 1024}, workingReserveBytes: 8 * 1024 * 1024};
  writeFileSync(ownerConfig, JSON.stringify({ingress, sync, maxRegistrations: 16, maxAdoptionBytes: 4 * 1024 * 1024, maxAdoptionEvents: 64,
    maxApplicationsPerSettlement: 1024, ownerOutbox: {maxPendingBytes: 64 * 1024 * 1024, maxPendingAgeMs: 604800000}}));
  const {mode: _mode, ...nativeHost} = coordinate;
  writeFileSync(nativeConfig, JSON.stringify({version: 1, relayNamespace: deployment.history.namespace, host: nativeHost,
    workspaces: [{root: ownerDir, workspaceId: "workspace", maxRegistrations: 16,
      relay: {baseUrl, bearerToken: "owner", allowInsecureLoopbackForTests: true}}],
    ingress: {aggregateBytes: 512 * 1024 * 1024, applicationWorkingReserveBytes: 8 * 1024 * 1024, maxUploads: 2, uploadDeadlineMs: 120_000},
    sync: {policy: {maxClientVectorBytes: 128 * 1024, maxHostVectorBytes: 128 * 1024, maxOutputBytes: 4 * 1024 * 1024,
      maxReadBytes: 16 * 1024 * 1024}, workingReserveBytes: 8 * 1024 * 1024},
    settlement: {maxApplicationsPerSettlement: 1024}, restore: {maxBytes: 4 * 1024 * 1024, maxEvents: 64}}));
  hostProcess = spawn(executable, [], {windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: {...process.env, DOHC_ENGINE_AUTH_TOKEN: "integration-owner", ...(configured && mode === "service" ? {DOHC_ENGINE_LIVE_HOST_CONFIG: nativeConfig} : {DOHC_ENGINE_OWNER_HOST_CONFIG: ownerConfig, DOHC_ENGINE_LIVE_HOST_CONFIG: undefined})}});
  const termination = new Promise<void>(resolve => hostProcess.once("close", () => resolve()));
  const stream = Duplex.from({readable: hostProcess.stdout!, writable: hostProcess.stdin!});
  client = new EngineClient(new DuplexEngineClientConnection(stream), {authToken: "integration-owner", protocolVersion: 2, capabilities: ["blobs"],
    privateLiveApplication: {aggregateBytes: 512 * 1024 * 1024, maxUploads: 2}, connectTimeoutMs: 120_000}, () => hostProcess.kill("SIGKILL"), termination);
  hostProcess.on("close", (code, signal) => client.notifyProcessExit(code, signal)); hostProcess.stderr!.pipe(process.stderr);
  await client.ready();
  if (configured && mode === "service") {
    const hosts = await rpc("liveApplication.hosts"); handle = hosts.workspaces[0].workspaceHandle;
  } else {
    handle = (await rpc("workspace.open", {rootDir: ownerDir, workspaceId: "workspace", ...(configured ? {captureMode: "none"} : {}),
      relay: {baseUrl, bearerToken: "owner", allowInsecureLoopbackForTests: true}})).workspace;
    main = (await rpc("versions.ensureMain")).id;
    if (configured) await rpc("liveApplication.provisionOwner", {relayNamespace: deployment.history.namespace, host: nativeHost});
  }
  if (configured) {
    assert(storage.registerLiveHost({...coordinate, updatedAtMs: Date.now(), guard: storage.captureStanding()}).ok);
    consumer = new LiveCommittedDelivery(storage, deployment.history, {client, workspace: handle, host: coordinate, deadlineMs: 120_000,
      nextRequestId: () => id++, restore: new LiveRestorePreparation({maxBytes: 4 * 1024 * 1024, maxEvents: 1024,
        aggregateBytes: 128 * 1024 * 1024, workingReserveBytes: 8 * 1024 * 1024, maxOperations: 1, validation: policy})});
  }
  if (configured) await rpc("sync.adoptJoinIdentity", {workspaceId: "workspace", ...storage.getWorkspaceIdentity("workspace")!});
  else await rpc("sync.claim", {workspaceId: "workspace"});
  if (configured && mode === "device") {
    const sessions = new Map<string, string>();
    bridge = await ownerBridge(client, handle, deployment.history.namespace, nativeHost, async binding => {
      const entry = [...docs.values()].find(doc => doc.objectId === binding.objectId)!;
      assert(entry, "Owner document session exists");
      let sessionId = sessions.get(binding.objectId);
      if (!sessionId) {sessionId = String((await rpc("ydoc.open", {versionId: main, path: entry.path, contentKind: "richdoc"})).sessionId); sessions.set(binding.objectId, sessionId);}
      return {nativeSessionId: sessionId, assertCurrent() {assert.equal(hostProcess.exitCode, null);},
        async prepareHandoff(signal) {signal.throwIfAborted();}, async finishHandoff() {},
        async remoteApplied(update) {Y.applyUpdate(entry.doc, update);}, onDurableLocalChange() {return () => {};},
        onSettlementWanted() {return () => {};}};
    });
    consumer = new OwnerCommittedDelivery(storage, deployment.history, {client: bridge.client, workspace: handle, host: coordinate,
      deadlineMs: 120_000, nextRequestId: () => id++, bounds: {maxBytes: 4 * 1024 * 1024, maxEvents: 64},
      ownerAdmission: {shares: new Map([["workspace", "share"]]), trustedAccount: () => undefined,
        maxEntriesPerDrain: 64, maxBytesPerDrain: 16 * 1024 * 1024, refusals: new OwnerKnownRefusals(), validate: createLiveMarkdownJournalValidator(policy)}});
  }
  return {pid: hostProcess.pid, main};
}
async function closeHost() {
  await bridge?.close(); bridge = undefined;
  if (client) {client.close(); hostProcess.kill("SIGKILL"); await client.waitForExit();
    storage.disconnectLiveHost({...coordinate, updatedAtMs: Date.now(), guard: storage.captureStanding()});}
}
const document = (objectId: string) => ({workspaceId: "workspace", mainVersionId: main, objectId: docs.get(objectId)!.objectId, lineageClaimId: docs.get(objectId)!.lineageClaimId});
function append(opKind: string, payload: unknown) {
  return storage.appendLogBatch({workspaceId: "workspace", originId: seedOrigin, ops: [{originSeq: originSeq++, opKind, recordedAtMs: Date.now(), payloadJson: JSON.stringify(payload)}]});
}
function inspect<T>(dir: string, read: (db: DatabaseSync) => T) {
  const db = new DatabaseSync(join(dir, ".dohc", "engine", "engine.db"), {readOnly: true}); try {return read(db);} finally {db.close();}
}
function state(dir: string) {
  return inspect(dir, db => {
    const documents = db.prepare("SELECT workspace_id,version_id,object_id,lineage_claim_id FROM ydoc_docs ORDER BY object_id").all();
    return documents.map(key => {
      const doc = new Y.Doc();
      const args = [key.workspace_id, key.version_id, key.object_id] as string[];
      try {
        const snapshot = db.prepare("SELECT s.up_to_seq,b.bytes FROM ydoc_snapshots s JOIN binary_blobs b ON b.sha256=s.snapshot_blob_sha256 WHERE s.workspace_id=? AND s.version_id=? AND s.object_id=? ORDER BY s.up_to_seq DESC LIMIT 1").get(...args);
        if (snapshot) Y.applyUpdate(doc, snapshot.bytes as Uint8Array);
        for (const row of db.prepare("SELECT b.bytes FROM ydoc_updates u JOIN binary_blobs b ON b.sha256=u.update_blob_sha256 WHERE u.workspace_id=? AND u.version_id=? AND u.object_id=? AND u.seq>? ORDER BY u.seq").all(...args, Number(snapshot?.up_to_seq ?? 0))) Y.applyUpdate(doc, row.bytes as Uint8Array);
        const accepted = db.prepare("SELECT event_count,evidence_digest FROM live_accepted_updates WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? ORDER BY event_count DESC LIMIT 1").get(...args, String(key.lineage_claim_id));
        return {objectId: key.object_id, lineage: key.lineage_claim_id, eventCount: accepted?.event_count ?? 0, evidence: accepted?.evidence_digest ?? null,
          vector: Buffer.from(Y.encodeStateVector(doc)).toString("hex"), text: yDocToMarkdown(doc)};
      } finally {doc.destroy();}
    });
  });
}
function objects(dir: string) {
  return inspect(dir, db => db.prepare(`SELECT f.object_id AS objectId,
    COALESCE(s.path, (SELECT m.path FROM moments m WHERE m.workspace_id=f.workspace_id AND m.object_id=f.object_id AND m.version_id=? ORDER BY m.moment_order DESC LIMIT 1)) AS path,
    s.object_id IS NOT NULL AS present, COALESCE(s.blob_sha256, s.binary_sha256) AS head, s.content_kind AS contentKind,
    (SELECT COUNT(*) FROM live_audit_events a WHERE a.workspace_id=f.workspace_id AND a.object_id=f.object_id AND a.main_version_id=?) AS auditCount
    FROM file_objects f LEFT JOIN snapshots s ON s.workspace_id=f.workspace_id AND s.object_id=f.object_id AND s.version_id=?
    ORDER BY f.object_id`).all(main, main, main));
}
let running: Promise<void> | undefined;
let closing: Promise<void> | undefined;
async function command(name: string, input: Record<string, any>): Promise<Record<string, any>> {
  switch (name) {
    case "init": {
      if (!input.resume && mode === "service") {ownerDir = join(root, "seed"); mkdirSync(ownerDir, {recursive: true});}
      if (input.resume) {
        await openHost();
        const saved = JSON.parse(readFileSync(join(root, "documents.json"), "utf8")) as {label: string; objectId: string; path: string; baseline: string; lineageClaimId: string}[];
        for (const entry of saved) {
          const baseline = Buffer.from(entry.baseline, "base64"), doc = new Y.Doc(); Y.applyUpdate(doc, baseline);
          const cut = storage.readLiveUpdateJournalCut({document: {workspaceId: "workspace", mainVersionId: main, objectId: entry.objectId, lineageClaimId: entry.lineageClaimId}});
          if (cut.kind === "cut") {Y.applyUpdate(doc, cut.cut.checkpoint.bytes); for (const row of cut.cut.suffix) Y.applyUpdate(doc, row.bytes);}
          docs.set(entry.label, {...entry, baseline, doc});
        }
        await supervisor.activate("workspace");
        return {relayPid: process.pid, hostPid: hostProcess.pid, replicaPid: replica.pid, ownerDir, replicaDir, main};
      }
      await openHost(false);
      for (const [index, size] of (input.sizes as number[]).entries()) {
        const label = `doc-${index}`, path = `docs/${label}.md`;
        const bytes = Buffer.from("a".repeat(mode === "device" ? Math.min(size, 1024) : size));
        const written = await rpc("versionedText.writeBlob", {versionId: main, path, bytesBase64: bytes.toString("base64"), sha256: sha(bytes), origin: "api", publish: true});
        let textPush; do {textPush = await rpc("sync.push", {workspaceId: "workspace"});} while (textPush.hasMore);
        let doc: Y.Doc, baseline: Uint8Array;
        const objectId = written.object.id;
        if (mode === "device") {
          const adapter = new YdocLiveAdapter(client);
          const session = await adapter.openSession({workspace: handle, versionId: main, path, contentKind: "richdoc"});
          baseline = session.initialUpdate; doc = new Y.Doc(); Y.applyUpdate(doc, baseline);
          let pushed; do {pushed = await rpc("sync.push", {workspaceId: "workspace"});} while (pushed.hasMore);
          await session.close(); adapter.dispose();
        } else {
          doc = markdownToYDoc(bytes.toString()); baseline = Y.encodeStateAsUpdate(doc);
          storage.putBlob({workspaceId: "workspace", sha256: sha(baseline), content: baseline, createdAtMs: Date.now()});
          append("ydoc.update", {versionId: main, objectId, path, contentKind: "richdoc", updateBlobSha256: sha(baseline), lineageClaimId: sha(baseline), isBaseState: true});
        }
        docs.set(label, {doc, baseline, path, objectId, lineageClaimId: sha(baseline)});
      }
      if (mode === "device") {
        let page; do {
          page = await rpc("sync.pull", {workspaceId: "workspace"});
          assert.equal(page.refused, 0, JSON.stringify(page));
          await rpc("sync.commitCursor", {workspaceId: "workspace", pendingCursor: page.pendingCursor});
        } while (page.hasMore);
      }
      await closeHost(); ownerDir = join(root, "owner"); mkdirSync(ownerDir, {recursive: true}); await openHost();
      storage.createShare({share: {shareId: "share", workspaceId: "workspace", granterUserId: "owner", selectorJson: JSON.stringify({paths: ["docs/doc-0.md"], versionId: null}), createdAtMs: 3},
        grant: {grantId: "grant", shareId: "share", principalKind: "user", principalUserId: "reader", principalEmail: null, access: "edit", generation: 1, status: "active", createdAtMs: 3, revokedAtMs: null, parentGrantId: null}});
      storage.createShare({share: {shareId: "read-share", workspaceId: "workspace", granterUserId: "owner", selectorJson: "{}", createdAtMs: 3},
        grant: {grantId: "read-grant", shareId: "read-share", principalKind: "user", principalUserId: "reader", principalEmail: null, access: "view", generation: 1, status: "active", createdAtMs: 3, revokedAtMs: null, parentGrantId: null}});
      for (const label of docs.keys()) {
        const entry = docs.get(label)!;
        const result = createLiveMarkdownRegistrationValidator(policy)({document: document(label), currentPath: entry.path, checkpoint: entry.baseline});
        assert.equal(result.kind, "accepted"); if (result.kind !== "accepted") throw Error("baseline");
        const registration = storage.registerLiveDocumentBaseline({host: coordinate, evidence: result.evidence, baselineBytes: entry.baseline, registeredAtMs: Date.now()});
        assert.equal(registration.kind, "registered", JSON.stringify(registration));
        await consumer.drain(document(label));
      }
      writeFileSync(join(root, "documents.json"), JSON.stringify([...docs].map(([objectId, entry]) => ({label: objectId, objectId: entry.objectId, path: entry.path,
        lineageClaimId: entry.lineageClaimId, baseline: Buffer.from(entry.baseline).toString("base64")}))));
      await supervisor.activate("workspace");
      if (mode === "device") for (const [index, size] of (input.sizes as number[]).entries()) {
        if (size <= 1024) continue;
        await command("edit", {objectId: `doc-${index}`, deliveryId: `grow-${index}`, text: "a".repeat(size - 1024)});
        await command("drain", {}); await command("settled", {});
      }
      return {relayPid: process.pid, hostPid: hostProcess.pid, replicaPid: replica.pid, ownerDir, replicaDir, main};
    }
    case "edit": {
      const objectId = input.objectId ?? "doc-0", entry = docs.get(objectId)!, before = Y.encodeStateVector(entry.doc);
      const paragraph = entry.doc.getXmlFragment("body").get(0) as Y.XmlElement, text = paragraph.get(0) as Y.XmlText;
      text.insert(text.length, input.text ?? "x"); const update = Y.encodeStateAsUpdate(entry.doc, before);
      const current = storage.resolveCurrentLiveDocumentBinding({document: document(objectId), actor}), cut = storage.readLiveUpdateJournalCut({document: document(objectId)});
      assert.equal(current.kind, "current", JSON.stringify(current)); assert.equal(cut.kind, "cut", JSON.stringify(cut)); if (current.kind !== "current" || cut.kind !== "cut") throw Error("authority");
      const result = storage.commitLiveUpdateJournal({host: current.host, actor, expectedAuthority: current.authority,
        metadata: {deliveryId: input.deliveryId, updateDigest: sha(update), binding: current.binding}, cutToken: cut.cut,
        validation: createLiveMarkdownJournalValidator(policy)({document: document(objectId), currentPath: entry.path, checkpoint: cut.cut.checkpoint.bytes,
          suffix: cut.cut.suffix.map(row => row.bytes), candidate: update}), updateBytes: update, receivedAtMs: Date.now()});
      assert.equal(result.result.kind, "accepted"); return result.result;
    }
    case "drain": for (const key of docs.keys()) await consumer.drain(document(key)); return {};
    case "settle": for (const key of docs.keys()) await consumer.settle(document(key)); return {};
    case "echo": {let page; let pages = 0; do {page = await rpc("sync.push", {workspaceId: "workspace"});
      assert(++pages < 100 && (!page.hasMore || page.pushed > 0), JSON.stringify(page));
    } while (page.hasMore); if (!input.inFlight) await supervisor.settled("workspace"); return page;}
    case "settled": await supervisor.settled("workspace"); return {errors, starts};
    case "compare": {await supervisor.settled("workspace"); const owner = state(ownerDir), passive = state(replicaDir);
      assert.deepEqual(passive, owner, JSON.stringify(inspect(replicaDir, db => db.prepare("SELECT op_kind,payload_json,apply_disposition FROM replication_log ORDER BY rowid DESC LIMIT 10").all())));
      const ownerObjects = objects(ownerDir), passiveObjects = objects(replicaDir);
      assert.deepEqual(passiveObjects, ownerObjects);
      return {owner, passive, ownerObjects, passiveObjects, errors, starts};}
    case "state": return {owner: state(ownerDir), passive: state(replicaDir), errors, starts,
      ownerObjects: objects(ownerDir), passiveObjects: objects(replicaDir), replicaDir,
      frontier: inspect(replicaDir, db => db.prepare("SELECT * FROM replica_frontiers").all()),
      accepted: inspect(replicaDir, db => db.prepare("SELECT COUNT(*) AS n FROM live_accepted_updates").get()),
      applications};
    case "hold": gate("page"); holdPage = true; holdBeforeRead = input.beforeRead === true; return {};
    case "held": await gates.get("page")!.entered; return {};
    case "release": gates.get("page")!.release(); return {};
    case "activate": running = supervisor.activate("workspace"); void running.catch(() => {}); return {};
    case "activated": await running; return {errors, starts, replicaDir};
    case "killHost": await closeHost(); return {};
    case "restartHost": return await openHost();
    case "ordinaryInFlight": await ordinaryInFlight(); return {};
    case "probeGeneration": {
      const position = inspect(replicaDir, db => db.prepare("SELECT event_count,evidence_digest,journal_cursor FROM replica_documents WHERE object_id=?").get(docs.get("doc-0")!.objectId)!);
      const page = await storage.readReplicaLiveJournal({workspaceId: "workspace", after: Number(position.journal_cursor), limit: 1});
      const row = page.rows[0]!;
      const metadata = parseCanonicalAdmittedLiveUpdateMetadata({...row.admitted.metadata,
        accepted: {...row.admitted.metadata.accepted, binding: {...row.admitted.metadata.accepted.binding, restoreFenceGeneration: input.generation}}});
      try {
        await passiveClient.applyReplicaJournalPage({id: passiveId++, workspace: passiveWorkspace, deadlineMs: 120_000}, Number(position.journal_cursor), 0,
          [{...row, admitted: {metadata, updateBytes: Buffer.from(row.admitted.updateBytes, "base64")}, restore: null,
            authority: {...row.authority!, restoreFenceGeneration: Math.max(input.generation, row.authority!.restoreFenceGeneration)},
            evidenceDigest: nextVersionedAcceptedHistoryDigest(String(position.evidence_digest), Number(position.event_count) + 1, metadata)}]);
        return {refused: false};
      } catch (error) {return {refused: true, error: String(error)};}
    }
    case "delete": {
      await command("echo", {inFlight: true});
      const entry = docs.get("doc-0")!;
      await closeHost(); await openHost(false);
      if (input.rename) {
        await rpc("versionedText.rename", {versionId: main, fromPath: entry.path, toPath: "docs/renamed.md", origin: "api"});
        entry.path = "docs/renamed.md";
      }
      await rpc("versionedText.delete", {versionId: main, path: entry.path, origin: "api"});
      let page; do {page = await rpc("sync.push", {workspaceId: "workspace"});} while (page.hasMore);
      // The publisher cannot prove a removed marker. The HTTP publisher uses the
      // same daemon-authored delete rows, without reconstructing any domain operation.
      for (const pending of page.ownerAdmissionPending) {
        const ops = inspect(ownerDir, db => db.prepare("SELECT origin_seq,op_kind,payload_json,recorded_at_ms FROM replication_log WHERE origin_id=? AND origin_seq>=? ORDER BY origin_seq").all(pending.originId, pending.originSeq));
        assert(ops.every(op => op.op_kind === "moment.append"), JSON.stringify(ops));
        const response = await fetch(`${baseUrl}/sync/workspace/log`, {method: "POST", headers: {authorization: "Bearer owner", "content-type": "application/json"},
          body: JSON.stringify({...storage.getWorkspaceIdentity("workspace"), originId: pending.originId,
            ops: ops.map(op => ({originSeq: op.origin_seq, opKind: op.op_kind, payload: JSON.parse(String(op.payload_json)), recordedAtMs: op.recorded_at_ms}))})});
        const published = await response.json() as {settlementRefusals?: unknown[]};
        assert.equal(response.status, 200); assert.deepEqual(published.settlementRefusals ?? [], []);
      }
      return {};
    }
    case "killApplying": {
      const db = new DatabaseSync(join(replicaDir, ".dohc", "engine", "engine.db"));
      const until = performance.now() + 30_000;
      const completed = completedPages;
      try {
        for (;;) {
          assert.equal(completedPages, completed, "missed page transaction");
          assert(performance.now() < until, "Native page did not acquire its write transaction");
          try {db.exec("BEGIN IMMEDIATE; ROLLBACK;");}
          catch (error) {
            if (!(error instanceof Error) || !("errcode" in error) || error.errcode !== 5) throw error;
            if (!applyingPage) {await new Promise<void>(resolve => setImmediate(resolve)); continue;}
            const frontier = db.prepare("SELECT * FROM replica_frontiers").get();
            const accepted = db.prepare("SELECT COUNT(*) AS n FROM live_accepted_updates").get();
            if (input.relay) {
              // Leave the host's registration open, as a crash would.
              void replica.close(); client.close(); hostProcess.kill("SIGKILL");
              return {frontier, accepted, crashRelay: true};
            }
            await replica.close(); return {frontier, accepted};
          }
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      } finally {db.close();}
    }
    case "evict": await supervisor.evict("workspace"); return {};
    case "epoch": {
      await supervisor.evict("workspace");
      assert.equal(storage.rotateWorkspaceIdentity({workspaceId: "workspace", ownerUserId: "owner", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: Date.now()}), "rotated");
      await supervisor.activate("workspace"); return await command("state", {});
    }
    case "resend": {
      seedOrigin = "resend"; originSeq = 0;
      const entry = docs.get("doc-0")!;
      append("workspace.init", {});
      const seed = (storage as unknown as StorageContext).db.prepare("SELECT payload_json FROM sync_relay_log WHERE op_kind='moment.append' AND json_extract(payload_json,'$.objectId')=? ORDER BY relay_seq LIMIT 1").get(entry.objectId)!;
      append("moment.append", JSON.parse(String(seed.payload_json)));
      append("ydoc.update", {versionId: main, objectId: entry.objectId, path: entry.path, contentKind: "richdoc", updateBlobSha256: sha(entry.baseline), lineageClaimId: entry.lineageClaimId, isBaseState: true});
      await supervisor.settled("workspace");
      const authority = storage.resolveCurrentLiveDocumentBinding({document: document("doc-0"), actor});
      const registration = createLiveMarkdownRegistrationValidator(policy)({document: document("doc-0"), currentPath: entry.path, checkpoint: entry.baseline});
      assert.equal(registration.kind, "accepted"); if (registration.kind !== "accepted") throw Error("registration");
      const registered = storage.registerLiveDocumentBaseline({host: coordinate, evidence: registration.evidence, baselineBytes: entry.baseline, registeredAtMs: Date.now()});
      return {...await command("state", {}), authority, registered};
    }
    case "restore": {
      const doc = document("doc-0"), current = storage.resolveCurrentLiveDocumentBinding({document: doc, actor});
      assert.equal(current.kind, "current"); if (current.kind !== "current") throw Error("authority");
      const lookup = {operationId: "restore", workspaceId: "workspace", ownerUserId: "owner"};
      const restoreAtMs = Date.now();
      beginStopRestore(storage as StorageContext, {...lookup, document: doc, deliveryKind: "bootstrap", shareId: "share", grantId: "grant",
        expectedGrantGeneration: 1, expectedDependentGrantIds: [], expectedFence: current.binding.restoreFenceGeneration,
        restorePointCursor: 0, restorePointReceiptDigest: doc.lineageClaimId}, restoreAtMs);
      advanceStopRestoreFence(storage as StorageContext, lookup, restoreAtMs);
      const prepared = await consumer.prepareRestore(lookup); assert.equal(prepared.kind, "prepared"); if (prepared.kind !== "prepared") throw Error("restore");
      const restored = await consumer.completeRestore(lookup, prepared.proposalDigest);
      const cut = storage.readLiveUpdateJournalCut({document: doc}); assert.equal(cut.kind, "cut"); if (cut.kind !== "cut") throw Error("cut");
      const entry = docs.get("doc-0")!; entry.doc.destroy(); entry.doc = new Y.Doc(); Y.applyUpdate(entry.doc, cut.cut.checkpoint.bytes);
      for (const row of cut.cut.suffix) Y.applyUpdate(entry.doc, row.bytes);
      return restored;
    }
    case "close": {
      closing ??= (async () => {
        for (const value of gates.values()) value.release(); await supervisor.close(); await closeHost();
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        storage.close(); for (const entry of docs.values()) entry.doc.destroy();
      })();
      await closing; return {};
    }
    default: throw Error(`Unknown command ${name}`);
  }
}
createInterface({input: process.stdin}).on("line", line => {
  const {id: requestId, name, input = {}} = JSON.parse(line);
  void command(name, input).then(result => {
    process.stdout.write(JSON.stringify({id: requestId, result}) + "\n", () => {
      if (result.crashRelay) process.kill(process.pid, "SIGKILL");
    });
  },
    error => process.stdout.write(JSON.stringify({id: requestId, error: String(error), stack: `${name}: ${error.stack}`}) + "\n"));
}).on("close", () => void command("close", {}).finally(() => process.exit(1)));
process.stdout.write(JSON.stringify({ready: true, pid: process.pid}) + "\n");
