import {captureNamedLiveFrameHost,createNamedFrameChanges} from "../../../services/sync-relay/src/namedLiveFrameHost.js";
import {createNamedLiveTickets} from "../../../services/sync-relay/src/liveTickets.js";
import {readRelayDeviceDeliveryConfig} from "../../../services/sync-relay/src/deviceLiveHostConfig.js";
import {createHash} from "node:crypto";
import {spawn,spawnSync,type ChildProcess} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:http";
import {createServer as createTlsServer} from "node:https";
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {expect,it,vi} from "vitest";
import {LiveCommittedDeliveryStore} from "../../../services/sync-relay/src/storage/liveCommittedDelivery.js";
import {beginStopRestore,advanceStopRestoreFence,readStopRestore} from "../../../services/sync-relay/src/storage/liveRestoreOperation.js";
import type {StorageContext} from "../../../services/sync-relay/src/storage/context.js";
import * as Y from "yjs";
import {EngineDaemonLifecycle,EngineWorkspaceSessions,type EngineClient} from "../../workspace-engine-client/src/daemon/index.js";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {createWorkspaceEngineCapture} from "../../../apps/desktop/src/workspaces/workspaceEngineCapture.js";
import {createEngineYDocSessionIpc} from "../../../apps/desktop/src/workspaces/engineYDocSessionIpc.js";
import {bindEngineYDoc} from "../../../apps/desktop/src/renderer/collab/engineYDocProvider.js";
import {CHANNELS} from "../../../apps/desktop/src/ipc/channels.js";
import {createDeviceControl} from "../../../services/sync-relay/src/deviceControl.js";
import {connectDeviceHost} from "../../../services/sync-relay/src/deviceHostConnect.js";
import {createDeviceHostCredential} from "../../../services/sync-relay/src/deviceHostCredential.js";
import {initializeRelayDeployment,openRelayDeployment} from "../../../services/sync-relay/src/relayDeployment.js";
import {createDeviceControlBridge} from "../../../services/share-web/src/deviceControlBridge.js";
import {createLiveMarkdownJournalValidator,createLiveMarkdownRegistrationValidator} from "./liveDocumentValidation.js";
import {yDocToMarkdown} from "./import-export.js";
import {policy} from "./liveCommittedDeliveryTestSupport.js";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function assertIndependentRelayReader(root: string,baseline: Uint8Array,expected: Y.Doc) {
  const relay = new DatabaseSync(join(root,"relay","relay.sqlite"),{readOnly: true}), reader = new Y.Doc();
  try {
    Y.applyUpdate(reader,baseline);
    for (const row of relay.prepare("SELECT update_bytes FROM sync_relay_live_update_journal ORDER BY journal_cursor").all()) Y.applyUpdate(reader,row.update_bytes as Uint8Array);
    expect(reader.getMap("frontmatter").get("beforeConnection")).toBe("Owner edit before first connection");
    expect(reader.getMap("frontmatter").get("duringHandoff")).toBe("Queued owner edit");
    expect(yDocToMarkdown(reader)).toBe(yDocToMarkdown(expected));
  } finally {reader.destroy(); relay.close();}
}
it.skipIf(!process.env.DOHC_OWNER_DESKTOP_PROOF_BINARY).each([false,true])("keeps the ordinary desktop owner through authenticated adoption, durable outbox delivery, remote apply and settlement (standalone=%s)", async standalone => {
  const binary = resolve(process.env.DOHC_OWNER_DESKTOP_PROOF_BINARY!);
  const captures = vi.spyOn(LiveCommittedDeliveryStore.prototype,"captureOwnerCut");
  expect(hash(readFileSync(binary))).toBe(process.env.DOHC_OWNER_DESKTOP_PROOF_SHA256?.toLowerCase());
  const output = resolve(process.env.DOHC_OWNER_DESKTOP_PROOF_OUTPUT!); mkdirSync(output,{recursive: true});
  const root = mkdtempSync(join(output,"case-")), workspaceRoot = join(root,"workspace");
  mkdirSync(join(workspaceRoot,"docs"),{recursive: true});
  const seed = JSON.parse(readFileSync(new URL("../../../crates/dohc-engine-collab/tests/owner-source/owner-source-seed.json",import.meta.url),"utf8"));
  writeFileSync(join(workspaceRoot,"docs/a.md"),seed.markdown);
  const nativeConfig = join(root,"ordinary.json");
  const restoreMaxBytes = 16_000_000;
  writeFileSync(nativeConfig,JSON.stringify({ingress: {aggregateBytes: 600_000_000,applicationWorkingReserveBytes: 1_000_000,maxUploads: 2,uploadDeadlineMs: 30_000},
    maxRegistrations: 8,maxAdoptionBytes: 1_000_000,maxAdoptionEvents: 100,maxApplicationsPerSettlement: 100,
    sync: {policy: {maxClientVectorBytes: 100_000,maxHostVectorBytes: 100_000,maxOutputBytes: 2_000_000,maxReadBytes: 8_000_000},workingReserveBytes: 4_000_000},
    restore: {maxBytes: restoreMaxBytes, maxEvents: 100}, ownerOutbox: {maxPendingBytes: 1_000_000,maxPendingAgeMs: 600_000}}));
  const conflicting = spawnSync(binary,[],{windowsHide: true,timeout: 10_000,encoding: "utf8",env: {...process.env,DOHC_ENGINE_AUTH_TOKEN: "test-auth",
    DOHC_ENGINE_OWNER_HOST_CONFIG: nativeConfig,DOHC_ENGINE_LIVE_HOST_CONFIG: nativeConfig}});
  expect(conflicting.status).not.toBe(0);
  expect(conflicting.stderr).toContain("mutually exclusive");
  const lifecycle = new EngineDaemonLifecycle({command: binary,maxRestarts: 0,privateOwnerHost: {configPath: nativeConfig,client: {aggregateBytes: 200_000_000,maxUploads: 2}}});
  await lifecycle.start();
  const singleton = lifecycle.currentClient() as EngineClient;
  const sessions = new EngineWorkspaceSessions(lifecycle,{workspaceOpenDeadlineMs: 30_000});
  const workspace = {workspaceId: "workspace",rootPath: workspaceRoot,attachmentId: Symbol("actual-owner")};
  let capture = createWorkspaceEngineCapture({...workspace,rustEngineSessions: sessions});
  let closeNetwork: (() => Promise<void>) | undefined;
  let ipc: ReturnType<typeof createEngineYDocSessionIpc> | undefined;
  let renderer: Awaited<ReturnType<typeof bindEngineYDoc>> | undefined;
  let deployment: ReturnType<typeof openRelayDeployment> | undefined;
  let child: ChildProcess | undefined;
  let handoffEditInjected = false;
  let handoffCount = 0;
  let closeNamedPeer: (() => void) | undefined;
  let namedPeerInvalidated: AbortSignal | undefined;
  let releaseTailAdmission: (() => void) | undefined;
  try {
    capture.captureBatch([{path: "docs/a.md",operation: "update"}]); await capture.flush();
    await capture.stop(); await sessions.closeWorkspace(workspace);
    const dbPath = join(workspaceRoot,".dohc/engine/engine.db"), setup = new DatabaseSync(dbPath);
    setup.exec("INSERT INTO sync_identity(workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES('workspace','owner','epoch','stream',1); INSERT INTO sync_relay_push_state(workspace_id,origin_id,pushed_seq) VALUES('workspace','owner',0)");
    setup.close();
    capture = createWorkspaceEngineCapture({...workspace,rustEngineSessions: sessions});
    const listeners = new Map<string,(payload: any) => void>();
    const sender = {id: 7,isDestroyed: () => false,send: (channel: string,payload: unknown) => listeners.get(channel)?.(payload),once() {return this;}};
    ipc = createEngineYDocSessionIpc({sessionFor: () => ({workspaceId: "workspace",generation: 1,isCurrent: () => true}),
      acquireWorkspace: () => ({workspace,assertCurrent() {},release() {}}),captureFor: () => capture,ensureCaptureFor: async () => undefined,
      isSharedView: () => false,resolveDocumentPath: async (_workspace,path) => path,onError: (message,error) => {console.error(message,error);}});
    const openRenderer = async (sessionId: string) => {
      let seq = 0;
      return bindEngineYDoc({
      open: () => ipc!.open(sender,{workspaceId: "workspace",sessionId,path: "docs/a.md"}),stageLocalUpdate: () => ++seq,
      async applyLocalUpdate(update,seq,lineageGeneration) {const result = ipc!.applyUpdate(sender,{sessionId,update,seq,lineageGeneration}); if (!result.accepted) throw new Error(result.reason);},
      onRemoteUpdate(listener) {listeners.set(CHANNELS.engineYDocRemoteUpdate,event => listener(event.update,event.lineageGeneration)); return () => listeners.delete(CHANNELS.engineYDocRemoteUpdate);},
      onLineageReplacement(listener) {listeners.set(CHANNELS.engineYDocLineageReplacement,listener); return () => listeners.delete(CHANNELS.engineYDocLineageReplacement);},
      async acknowledgeLineageReplacement(lineageGeneration) {const result=ipc!.acknowledgeLineageReplacement(sender,{sessionId,lineageGeneration}); if (!result.accepted) throw new Error(result.reason); return result.updates;},
      adoptOwner: lineageGeneration => ipc!.prepareOwnerHandoff(sender,{sessionId,lineageGeneration}),
      onOwnerHandoff(listener) {listeners.set(CHANNELS.engineYDocOwnerHandoff,event => {
        handoffCount++;
        listener(event.lineageGeneration);
        if (!handoffEditInjected) {handoffEditInjected = true; renderer?.doc?.getMap("frontmatter").set("duringHandoff","Queued owner edit");}
      }); return () => listeners.delete(CHANNELS.engineYDocOwnerHandoff);},
      close: () => ipc!.close(sender,{sessionId}),
      });
    };
    renderer = await openRenderer("renderer-existing");
    expect(renderer.available).toBe(true);
    const rendererDoc = renderer.doc!;
    const engineBinding = await sessions.run(workspace,async binding => binding);
    const native = new DatabaseSync(dbPath,{readOnly: true});
    const origin = native.prepare("SELECT s.object_id,s.latest_moment_id,b.bytes,d.lineage_claim_id FROM snapshots s JOIN ydoc_docs d USING(workspace_id,version_id,object_id) JOIN ydoc_snapshots y USING(workspace_id,version_id,object_id) JOIN binary_blobs b ON b.sha256=y.snapshot_blob_sha256 WHERE y.up_to_seq=0").get()!;
    const document = {workspaceId: "workspace",mainVersionId: "main",objectId: String(origin.object_id),lineageClaimId: String(origin.lineage_claim_id)};
    const initialSession = native.prepare("SELECT COUNT(*) AS count FROM moments").get()!.count;
    rendererDoc.getMap("frontmatter").set("beforeConnection","Owner edit before first connection");
    await renderer.flushPendingLocalUpdates();
    await expect.poll(() => native.prepare("SELECT head_update_seq FROM ydoc_docs WHERE object_id=?").get(document.objectId)!.head_update_seq).toBeGreaterThan(0);
    expect(native.prepare("SELECT COUNT(*) AS count FROM owner_ydoc_outbox_entries").get()!.count).toBe(0);
    const configPath = join(root,"deployment.json");
    initializeRelayDeployment({configPath,relayPath: join(root,"relay","relay.sqlite"),continuityDirectory: join(root,"continuity")}); deployment = openRelayDeployment(configPath,{liveTickets: {retainedTicketsPerPrincipalGrant: 8,expiredTicketCleanupBatchSize: 4,now: Date.now}});
    const credential = createDeviceHostCredential("host",parseHostEpoch(1));
    expect(deployment.storage.provisionDeviceHostCredential({credential,updatedAtMs: 1}).ok).toBe(true);
    const limits = {maxConnections: 4,maxHeaderBytes: 8192,maxCredentialBytes: 4096,maxPayloadBytes: 4096,maxPendingBytes: 4_000_000,maxFragments: 8,maxBufferedChunks: 16,
      handshakeTimeoutMs: 10_000,heartbeatIntervalMs: 500,heartbeatTimeoutMs: 10_000,closeTimeoutMs: 1000};
    const relayConfig = join(root,"relay-device.json");
    writeFileSync(relayConfig,JSON.stringify({version: 1,workspaceIds: ["workspace"],maxQueuedBytes: 4_000_000,maxActiveDrains: 2,
      restore: {maxBytes: restoreMaxBytes, maxEvents: 100, aggregateBytes: restoreMaxBytes * 16 + 1_000_000, workingReserveBytes: 1_000_000, maxOperations: 1, validation: policy},
      client: {aggregateBytes: 200_000_000,maxUploads: 2,connectTimeoutMs: 30_000,requestDeadlineMs: 30_000,maxFrameBytes: 1_048_576}}));
    const relay = createServer(); relay.listen(0,"127.0.0.1"); await once(relay,"listening");
    const relayPort = (relay.address() as {port: number}).port, exchangeKey = "owner-desktop-exchange-key-32-bytes";
    const frameChanges = createNamedFrameChanges(16);
    const control = createDeviceControl({storage: deployment.storage,hosts: new Set([`127.0.0.1:${relayPort}`]),relayExchangeKey: exchangeKey,limits,
      delivery: {config: readRelayDeviceDeliveryConfig(relayConfig,limits),history: deployment.history,frameChanges,ownerAdmission: {shares: new Map([["workspace","share"]]),maxEntriesPerDrain: 1,maxBytesPerDrain: 10_000_000,validate: createLiveMarkdownJournalValidator(policy)}}});
    relay.on("upgrade",control.handleUpgrade);
    const certificate = fileURLToPath(new URL("../../../services/share-web/src/testing/device-control/localhost-cert.pem",import.meta.url));
    const key = fileURLToPath(new URL("../../../services/share-web/src/testing/device-control/localhost-key.pem",import.meta.url));
    const share = createTlsServer({cert: readFileSync(certificate),key: readFileSync(key)}); share.listen(0,"127.0.0.1"); await once(share,"listening");
    const sharePort = (share.address() as {port: number}).port;
    const bridge = createDeviceControlBridge({publicHosts: new Set([`localhost:${sharePort}`]),relayUrl: `http://127.0.0.1:${relayPort}`,relayExchangeKey: exchangeKey,limits,
      admission: {capacity: 8,refillPerSecond: 1,maxKeys: 8},trustedProxies: new Set()}); share.on("upgrade",bridge.handleUpgrade);
    let ownerAvailable = true;
    const connect = () => connectDeviceHost({url: `wss://localhost:${sharePort}/api/device-control`,credential,limits,onRegistered() {},existingOwner: {
      client: singleton,workspaces: [{workspaceId: "workspace",workspaceHandle: engineBinding.workspace}],ownerFor: binding => {if (!ownerAvailable) throw new Error("Renderer owner is unavailable."); return ipc!.existingOwner(binding);},
      maxQueuedBytes: 4_000_000,maxFrameBytes: 1_048_576,maxUploads: 2,maxRegistrations: 8,aggregateBytes: 200_000_000,
      sync: {maxClientVectorBytes: 100_000,maxOutputBytes: 2_000_000},
      maxRestoreBytes: restoreMaxBytes,maxAdoptionBytes: 1_000_000,maxAdoptionEvents: 2,requestDeadlineMs: 30_000}});
    let connection = connect();
    closeNetwork = async () => {connection.stop(); control.close(); bridge.close(); await connection.closed;
      await Promise.all([new Promise<void>(resolve => share.close(() => resolve())),new Promise<void>(resolve => relay.close(() => resolve()))]); native.close();};
    await expect.poll(() => deployment!.storage.getLiveHostControl()?.admissionState,{timeout: 30_000}).toBe("open");
    const hostRow = deployment.storage.getLiveHostControl()!, host = {mode: "device" as const,hostId: credential.hostId,hostEpoch: credential.hostEpoch,instanceId: credential.instanceId,connectionId: hostRow.registeredConnectionId!};
    const baseline = new Uint8Array(origin.bytes as Uint8Array), registration = createLiveMarkdownRegistrationValidator(policy)({document,currentPath: "docs/a.md",checkpoint: baseline});
    if (registration.kind !== "accepted") throw new Error(JSON.stringify(registration));
    const baselineDoc = new Y.Doc({gc: false});
    Y.applyUpdate(baselineDoc, baseline);
    const baselineProjection = yDocToMarkdown(baselineDoc);
    baselineDoc.destroy();
    deployment.storage.claimWorkspace({workspaceId: "workspace",ownerUserId: "owner",createdAtMs: 2});
    deployment.storage.putBlob({workspaceId: "workspace",sha256: hash(seed.markdown),content: Buffer.from(seed.markdown),createdAtMs: 2});
    deployment.storage.appendLogBatch({workspaceId: "workspace",originId: "owner",ops: [{originSeq: 0,opKind: "moment.append",recordedAtMs: 2,payloadJson: JSON.stringify({objectId: document.objectId,
      momentId: origin.latest_moment_id,versionId: "main",recordedAtMs: 2,operation: "write",path: "docs/a.md",payloadAfterPath: "docs/a.md",payloadAfterBlobSha256: hash(seed.markdown),payloadAfterContentKind: "text",payloadAfterByteLength: Buffer.byteLength(seed.markdown)})}]});
    expect(deployment.storage.registerLiveDocumentBaseline({host,evidence: registration.evidence,baselineBytes: baseline,registeredAtMs: 3}).kind).toBe("registered");
    deployment.storage.createShare({share: {shareId: "share",workspaceId: "workspace",granterUserId: "owner",selectorJson: JSON.stringify({paths: ["docs"],versionId: null}),createdAtMs: 3},
      grant: {grantId: "grant",shareId: "share",principalKind: "user",principalUserId: "reader",principalEmail: null,access: "edit",generation: 1,status: "active",createdAtMs: 3,revokedAtMs: null,parentGrantId: null}});
    deployment.storage.createShare({share: {shareId: "named-share",workspaceId: "workspace",granterUserId: "owner",selectorJson: JSON.stringify({paths: ["docs/a.md"],versionId: null}),createdAtMs: 3},
      grant: {grantId: "named-grant",shareId: "named-share",principalKind: "user",principalUserId: "reader",principalEmail: null,access: "edit",generation: 1,status: "active",createdAtMs: 3,revokedAtMs: null,parentGrantId: null}});
    if (standalone) {
      const remote = new Y.Doc(); Y.applyUpdate(remote,baseline); const before = Y.encodeStateVector(remote);
      remote.getMap("frontmatter").set("remote","Standalone remote edit"); const update = Y.encodeStateAsUpdate(remote,before);
      const actor = {kind: "named" as const,userId: "reader",grantId: "named-grant"};
      const current = deployment.storage.resolveCurrentLiveDocumentBinding({document,actor}), cut = deployment.storage.readLiveUpdateJournalCut({document});
      if (current.kind !== "current" || cut.kind !== "cut") throw new Error("Remote startup cut unavailable.");
      expect(deployment.storage.commitLiveUpdateJournal({host,actor,expectedAuthority: current.authority,metadata: {deliveryId: "remote-startup",updateDigest: hash(update),binding: current.binding},
        cutToken: cut.cut,validation: createLiveMarkdownJournalValidator(policy)({document,currentPath: "docs/a.md",checkpoint: cut.cut.checkpoint.bytes,suffix: cut.cut.suffix.map(row => row.bytes),candidate: update}),updateBytes: update,receivedAtMs: Date.now()}).result.kind).toBe("accepted");
      connection.stop(); await connection.closed; control.close();
      await new Promise<void>(resolve => relay.close(() => resolve())); deployment.storage.close(); deployment = undefined;
      const admissionPath = join(root,"owner-admission.json");
      writeFileSync(admissionPath,JSON.stringify({version: 1,shares: [{workspaceId: "workspace",shareId: "share"}],validation: policy,
        maxEntriesPerDrain: 10,maxBytesPerDrain: 10_000_000,maxDocumentsPerPass: 10,pollIntervalMs: 100,passDeadlineMs: 30_000}));
      const mainPath = fileURLToPath(new URL("../../../services/sync-relay/dist/main.js",import.meta.url));
      for (const devicePath of ["",relayConfig]) {
        const refused = spawnSync(process.execPath,[mainPath],{windowsHide: true,timeout: 10_000,encoding: "utf8",
          env: {...process.env,NODE_ENV: "test",SYNC_RELAY_TEST_AUTH: "1",SYNC_RELAY_PORT: "0",DOHC_RELAY_DEPLOYMENT_CONFIG: configPath,
            DOHC_RELAY_DEVICE_DELIVERY_CONFIG: devicePath,DOHC_RELAY_OWNER_ADMISSION_CONFIG: join(root,"missing-owner.json"),
            DOHC_DEVICE_CONTROL_LIMITS: JSON.stringify(limits),DOHC_RELAY_DEVICE_CONTROL_HOSTS: `127.0.0.1:${relayPort}`,DOHC_RELAY_EXCHANGE_KEY: exchangeKey}});
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain(devicePath ? "Invalid device control configuration" : "Private owner admission requires configured device delivery");
        expect(refused.stdout).not.toContain("SYNC_RELAY_LISTENING");
      }
      let childOutput = "";
      child = spawn(process.execPath,[mainPath],{windowsHide: true,
        env: {...process.env,NODE_ENV: "test",SYNC_RELAY_TEST_AUTH: "1",SYNC_RELAY_PORT: String(relayPort),
          DOHC_RELAY_DEPLOYMENT_CONFIG: configPath,DOHC_RELAY_DEVICE_DELIVERY_CONFIG: relayConfig,DOHC_RELAY_OWNER_ADMISSION_CONFIG: admissionPath,
          DOHC_DEVICE_CONTROL_LIMITS: JSON.stringify(limits),DOHC_RELAY_DEVICE_CONTROL_HOSTS: `127.0.0.1:${relayPort}`,DOHC_RELAY_EXCHANGE_KEY: exchangeKey},stdio: ["ignore","pipe","pipe"]});
      child.stdout!.on("data",chunk => {childOutput += String(chunk); writeFileSync(join(root,"standalone.log"),childOutput);});
      child.stderr!.on("data",chunk => {childOutput += String(chunk); writeFileSync(join(root,"standalone.log"),childOutput);});
      await expect.poll(() => {if (child!.exitCode !== null) throw new Error(childOutput); return childOutput.includes("SYNC_RELAY_LISTENING");},{timeout: 30_000}).toBe(true);
      connection = connect();
      await expect.poll(() => rendererDoc.getMap("frontmatter").get("remote"),{timeout: 30_000}).toBe("Standalone remote edit");
      const initialHandoffs = handoffCount;
      rendererDoc.getMap("frontmatter").set("title","Standalone owner edit"); await renderer.flushPendingLocalUpdates();
      await expect.poll(() => readFileSync(join(workspaceRoot,"docs/a.md"),"utf8"),{timeout: 30_000}).toContain("Standalone owner edit");
      await expect.poll(() => native.prepare("SELECT COUNT(*) AS count FROM owner_ydoc_outbox_entries WHERE pending=1").get()!.count,{timeout: 30_000}).toBe(0);
      expect(native.prepare("SELECT COUNT(*) AS count FROM owner_ydoc_outbox_entries").get()!.count).toBeGreaterThan(0);
      expect(rendererDoc.getMap("frontmatter").get("duringHandoff")).toBe("Queued owner edit");
      expect(rendererDoc.getMap("frontmatter").get("beforeConnection")).toBe("Owner edit before first connection");
      expect(readFileSync(join(workspaceRoot,"docs/a.md"),"utf8")).toContain("Owner edit before first connection");
      expect(handoffCount).toBe(initialHandoffs);
      connection.stop(); await connection.closed;
      rendererDoc.getMap("frontmatter").set("offline","Reconnect owner edit"); await renderer.flushPendingLocalUpdates();
      await expect.poll(() => native.prepare("SELECT COUNT(*) AS count FROM owner_ydoc_outbox_entries WHERE pending=1").get()!.count,{timeout: 30_000}).toBeGreaterThan(0);
      connection = connect();
      await expect.poll(() => native.prepare("SELECT COUNT(*) AS count FROM owner_ydoc_outbox_entries WHERE pending=1").get()!.count,{timeout: 30_000}).toBe(0);
      await expect.poll(() => readFileSync(join(workspaceRoot,"docs/a.md"),"utf8"),{timeout: 30_000}).toContain("Reconnect owner edit");
      expect(lifecycle.currentClient()).toBe(singleton);
      expect(native.prepare("SELECT COUNT(*) AS count FROM live_device_bootstraps").get()!.count).toBe(0);
      assertIndependentRelayReader(root,baseline,rendererDoc);
      writeFileSync(join(root,"result.json"),JSON.stringify({passed: true,standalone: true,binary,document,markdown: yDocToMarkdown(rendererDoc)},null,2)); remote.destroy();
      return;
    }
    const drain = async () => {let result: unknown,failure: unknown; await expect.poll(async () => {try {result = await control.drain(document); return true;} catch (error) {if ((error as Error).message.includes("not ready")) return false; failure = error; return true;}},{timeout: 30_000}).toBe(true); if (failure) throw failure; return result;};
    const adoptionPass = await drain();
    expect(adoptionPass).toEqual(expect.objectContaining({kind: expect.stringMatching(/^(done|pending)$/)}));
    if ((adoptionPass as {kind: string}).kind === "pending") expect(adoptionPass).toHaveProperty("continueDrain",true);
    await expect.poll(() => native.prepare("SELECT COUNT(*) AS count FROM owner_ydoc_outbox_entries WHERE pending=1").get()!.count,{timeout: 30_000}).toBe(0);
    expect(native.prepare("SELECT COUNT(*) AS count FROM live_device_bootstraps").get()!.count).toBe(0);
    expect(native.prepare("SELECT COUNT(*) AS count FROM moments").get()!.count).toBeGreaterThanOrEqual(Number(initialSession));
    expect(rendererDoc.getMap("frontmatter").get("beforeConnection")).toBe("Owner edit before first connection");
    expect(native.prepare("SELECT covered_outbox_sequence FROM live_owner_adoptions").get()!.covered_outbox_sequence).toBe(0);
    const namedActor = {kind: "named" as const,userId: "reader",grantId: "named-grant"};
    const namedBinding = deployment.storage.resolveCurrentLiveDocumentBinding({document,actor: namedActor});
    if (namedBinding.kind !== "current") throw new Error("Named owner binding unavailable.");
    const nativePeer = await control.captureNative(namedBinding.binding);
    const scope = {workspaceId: "workspace",shareId: "named-share",grantId: "named-grant",userId: "reader"};
    const tickets = createNamedLiveTickets({storage: deployment.storage,audience: `https://localhost:${sharePort}`,key: Buffer.alloc(32,17),
      hostReports: {currentBinding: async () => ({connection: nativePeer.coordinate,binding: namedBinding.binding})}});
    const minted = await tickets.mint({objectId: document.objectId},scope);
    if (!minted) throw new Error("Named owner ticket was not minted.");
    const ticket = await tickets.redeem(minted.token,scope);
    if (!ticket) throw new Error("Named owner ticket was not redeemed.");
    const namedPeer = captureNamedLiveFrameHost({ticket,storage: deployment.storage,native: nativePeer,
      bounds: {maxClientVectorBytes: 100_000,maxSyncOutputBytes: 2_000_000,maxAppliedUpdateBytes: 2_000_000,maxSubmissionBytes: 2_000_000,maxAdmissionBytes: 8_000_000},
      validate: createLiveMarkdownJournalValidator(policy)});
    namedPeerInvalidated = namedPeer.invalidated;
    const peerSignal = new AbortController();
    const peerSync = await namedPeer.openSync(Uint8Array.of(0),peerSignal.signal), browser = new Y.Doc();
    Y.applyUpdate(browser,peerSync.missingStateUpdate);
    closeNamedPeer = () => {peerSignal.abort(); peerSync.close(); namedPeer.close(); browser.destroy();};
    expect(peerSync.binding.selectorPaths).toEqual(["docs/a.md"]);
    expect(nativePeer.binding.selectorPaths).toEqual(["docs"]);
    expect(yDocToMarkdown(browser)).toBe(yDocToMarkdown(rendererDoc));
    const firstApplied = peerSync.nextApplied(peerSignal.signal);
    // The production nextApplied waiter must be armed before the owner changes.
    await expect.poll(() => frameChanges.listenerCount()).toBe(2);
    rendererDoc.getMap("frontmatter").set("title","Owner edit");
    await renderer.flushPendingLocalUpdates();
    const firstLease = await firstApplied;
    try {Y.applyUpdate(browser,firstLease.value.updateBytes);} finally {firstLease.release();}
    expect(browser.getMap("frontmatter").get("title")).toBe("Owner edit");
    let lastCursor = firstLease.value.journalCursor;
    for (let round = 0; round < 2; round++) {
      const pending = peerSync.nextApplied(peerSignal.signal);
      await expect.poll(() => frameChanges.listenerCount()).toBe(2);
      for (let index = 0; index < 4; index++) {
        rendererDoc.getMap("frontmatter").set(`ownerBurst${round}-${index}`,index);
        await renderer.flushPendingLocalUpdates();
      }
      let lease = await pending;
      for (;;) {
        try {
          expect(lease.value.journalCursor).toBeGreaterThan(lastCursor); lastCursor = lease.value.journalCursor;
          Y.applyUpdate(browser,lease.value.updateBytes);
        } finally {lease.release();}
        if (browser.getMap("frontmatter").get(`ownerBurst${round}-3`) === 3) break;
        lease = await peerSync.nextApplied(peerSignal.signal);
      }
      expect(yDocToMarkdown(browser)).toBe(yDocToMarkdown(rendererDoc));
    }
    // Settlement shares the document slot with wake delivery while a peer waits.
    const waitingAfterEdits = peerSync.nextApplied(peerSignal.signal);
    const cancelWaiting = expect(waitingAfterEdits).rejects.toThrow();
    await expect.poll(() => frameChanges.listenerCount()).toBe(2);
    expect((await control.settle(document)).materialized).toBe(true);
    expect(namedPeer.invalidated.aborted).toBe(false);
    peerSignal.abort(); await cancelWaiting; peerSync.close();
    expect(native.prepare("SELECT COUNT(*) AS count FROM owner_ydoc_outbox_entries WHERE pending=1").get()!.count).toBe(0);
    const remote = new Y.Doc(); Y.applyUpdate(remote,Y.encodeStateAsUpdate(rendererDoc)); const before = Y.encodeStateVector(remote);
    remote.getMap("frontmatter").set("remote","Remote edit"); const update = Y.encodeStateAsUpdate(remote,before);
    const actor = {kind: "named" as const,userId: "reader",grantId: "named-grant"};
    const current = deployment.storage.resolveCurrentLiveDocumentBinding({document,actor}), cut = deployment.storage.readLiveUpdateJournalCut({document});
    if (current.kind !== "current" || cut.kind !== "cut") throw new Error(`Remote cut unavailable: ${JSON.stringify({current,cut: {kind: cut.kind}})}`);
    expect(deployment.storage.commitLiveUpdateJournal({host,actor,expectedAuthority: current.authority,metadata: {deliveryId: "remote-edit",updateDigest: hash(update),binding: current.binding},
      cutToken: cut.cut,validation: createLiveMarkdownJournalValidator(policy)({document,currentPath: "docs/a.md",checkpoint: cut.cut.checkpoint.bytes,suffix: cut.cut.suffix.map(row => row.bytes),candidate: update}),updateBytes: update,receivedAtMs: Date.now()}).result.kind).toBe("accepted");
    await control.settle(document);
    for (let index=0;index<4;index++) {
      const before = Y.encodeStateVector(remote); remote.getMap("frontmatter").set(`later${index}`,index);
      const bytes = Y.encodeStateAsUpdate(remote,before), current = deployment.storage.resolveCurrentLiveDocumentBinding({document,actor}), cut = deployment.storage.readLiveUpdateJournalCut({document});
      if (current.kind !== "current" || cut.kind !== "cut") throw new Error("Later remote cut unavailable.");
      expect(deployment.storage.commitLiveUpdateJournal({host,actor,expectedAuthority: current.authority,metadata: {deliveryId: `later-${index}`,updateDigest: hash(bytes),binding: current.binding},
        cutToken: cut.cut,validation: createLiveMarkdownJournalValidator(policy)({document,currentPath: "docs/a.md",checkpoint: cut.cut.checkpoint.bytes,suffix: cut.cut.suffix.map(row => row.bytes),candidate: bytes}),updateBytes: bytes,receivedAtMs: Date.now()}).result.kind).toBe("accepted");
    }
    await control.settle(document); await control.settle(document);
    const beforeGrowth = Y.encodeStateVector(remote);
    remote.getMap("frontmatter").set("growth","x".repeat(1_000_100));
    const growth = Y.encodeStateAsUpdate(remote,beforeGrowth), growthCurrent = deployment.storage.resolveCurrentLiveDocumentBinding({document,actor}), growthCut = deployment.storage.readLiveUpdateJournalCut({document});
    expect(growth.byteLength).toBeGreaterThan(1_000_000);
    if (growthCurrent.kind !== "current" || growthCut.kind !== "cut") throw new Error("Growth cut unavailable.");
    expect(deployment.storage.commitLiveUpdateJournal({host,actor,expectedAuthority: growthCurrent.authority,metadata: {deliveryId: "growth",updateDigest: hash(growth),binding: growthCurrent.binding},
      cutToken: growthCut.cut,validation: createLiveMarkdownJournalValidator(policy)({document,currentPath: "docs/a.md",checkpoint: growthCut.cut.checkpoint.bytes,suffix: growthCut.cut.suffix.map(row => row.bytes),candidate: growth}),updateBytes: growth,receivedAtMs: Date.now()}).result.kind).toBe("accepted");
    await control.settle(document);
    const captured = captures.mock.calls.length, requests = vi.spyOn(singleton,"sendRequest");
    await control.settle(document); await control.settle(document);
    expect(captures.mock.calls.length).toBe(captured);
    expect(requests.mock.calls.map(call => call[0].method)).not.toContain("ydoc.ownerOutbox.readPending");
    expect(requests.mock.calls.map(call => call[0].method)).not.toContain("liveApplication.settle");
    requests.mockRestore();
    expect(yDocToMarkdown(rendererDoc)).toBe(yDocToMarkdown(remote));
    expect(readFileSync(join(workspaceRoot,"docs/a.md"),"utf8")).toBe(yDocToMarkdown(remote));
    expect(lifecycle.currentClient()).toBe(singleton);
    expect(native.prepare("SELECT COUNT(*) AS count FROM live_device_bootstraps").get()!.count).toBe(0);
    assertIndependentRelayReader(root,baseline,rendererDoc);
    const beforeStop = Y.encodeStateVector(remote); remote.getMap("frontmatter").set("restoreCut","Accepted before stopping");
    const stopBytes = Y.encodeStateAsUpdate(remote,beforeStop), stopAuthority = deployment.storage.resolveCurrentLiveDocumentBinding({document,actor}), stopCut = deployment.storage.readLiveUpdateJournalCut({document});
    if (stopAuthority.kind !== "current" || stopCut.kind !== "cut") throw new Error("Stop cut unavailable.");
    expect(deployment.storage.commitLiveUpdateJournal({host,actor,expectedAuthority: stopAuthority.authority,metadata: {deliveryId: "owner-stop-cut",updateDigest: hash(stopBytes),binding: stopAuthority.binding},
      cutToken: stopCut.cut,validation: createLiveMarkdownJournalValidator(policy)({document,currentPath: "docs/a.md",checkpoint: stopCut.cut.checkpoint.bytes,suffix: stopCut.cut.suffix.map(row => row.bytes),candidate: stopBytes}),updateBytes: stopBytes,receivedAtMs: Date.now()}).result.kind).toBe("accepted");
    const lostApplication = vi.spyOn(LiveCommittedDeliveryStore.prototype,"acknowledgeOwnerDeliveryApplication")
      .mockImplementationOnce(()=>{throw new Error("Lost owner application ACK before stop");});
    try {await expect(drain()).rejects.toThrow("Lost owner application ACK before stop");}finally{lostApplication.mockRestore();}
    const appliedSequence=Number(native.prepare("SELECT local_ydoc_sequence FROM live_device_update_applications WHERE delivery_id='owner-stop-cut'").get()!.local_ydoc_sequence);
    const originalAdmission = deployment.storage.commitLiveUpdateJournal.bind(deployment.storage);
    const tailAdmission = vi.spyOn(deployment.storage,"commitLiveUpdateJournal").mockImplementation(input => {
      if (input.actor.kind === "owner") throw new Error("Injected unavailable owner admission before restore");
      return originalAdmission(input);
    });
    releaseTailAdmission = () => tailAdmission.mockRestore();
    rendererDoc.getMap("frontmatter").set("localRestoreTail","Unadmitted owner work");
    await renderer.flushPendingLocalUpdates();
    await expect.poll(() => native.prepare("SELECT COUNT(*) AS n FROM owner_ydoc_outbox_entries WHERE pending=1").get()!.n).toBeGreaterThan(0);
    const pendingTail = native.prepare("SELECT sequence,update_digest,pending FROM owner_ydoc_outbox_entries WHERE pending=1 ORDER BY sequence").all();
    const lookup = {operationId: "owner-stop",workspaceId: "workspace",ownerUserId: "owner"};
    beginStopRestore(deployment.storage as StorageContext,{deliveryKind: "owner",...lookup,document,shareId: "share",grantId: "grant",expectedGrantGeneration: 1,
      expectedDependentGrantIds: [],expectedFence: stopAuthority.binding.restoreFenceGeneration,restorePointCursor: 0,restorePointReceiptDigest: hash(baseline)},Date.now());
    advanceStopRestoreFence(deployment.storage as StorageContext,lookup,Date.now());
    releaseTailAdmission(); releaseTailAdmission = undefined;
    const stop = async () => {let result: Awaited<ReturnType<typeof control.stopRestore>> | undefined, failure: unknown; await expect.poll(async () => {
      try {result = await control.stopRestore(lookup); return true;} catch(error) {if ((error as Error).message.includes("not ready")) return false; failure=error; return true;}
    },{timeout: 30_000}).toBe(true); if(failure) throw failure; return result!;};
    const oldConnection = deployment.storage.getLiveHostControl()!.registeredConnectionId;
    expect(namedPeerInvalidated!.aborted).toBe(false);
    connection.stop(); await connection.closed;
    expect(namedPeerInvalidated!.aborted).toBe(true);
    closeNamedPeer!(); closeNamedPeer = undefined;
    expect(frameChanges.listenerCount()).toBe(0);
    connection = connect();
    await expect.poll(() => {const current=deployment!.storage.getLiveHostControl();return current?.admissionState==="open" && current.registeredConnectionId!==oldConnection;},{timeout: 30_000}).toBe(true);
    const handoffsBeforeStop = handoffCount;
    const stoppedRequests = vi.spyOn(singleton,"sendRequest");
    const lostFence = vi.spyOn(LiveCommittedDeliveryStore.prototype,"acknowledgeStopRestoreFence").mockImplementationOnce(() => {throw new Error("Lost owner fence receipt");});
    try {await expect(stop()).rejects.toThrow("Lost owner fence receipt");} finally {lostFence.mockRestore();}
    expect(readStopRestore(deployment.storage as StorageContext,lookup)?.phase).toBe("old-cut-applied");
    expect(handoffCount).toBe(handoffsBeforeStop);
    expect(stoppedRequests.mock.calls.map(call=>call[0].method)).not.toContain("ydoc.ownerOutbox.readPending");
    expect(native.prepare("SELECT sequence,update_digest,pending FROM owner_ydoc_outbox_entries WHERE pending=1 ORDER BY sequence").all()).toEqual(pendingTail);
    expect(native.prepare("SELECT state,quarantine_reason FROM owner_ydoc_outboxes").get()).toMatchObject({state:"quarantined",quarantine_reason:"restore-fenced"});
    expect(rendererDoc.getMap("frontmatter").get("restoreCut")).toBe("Accepted before stopping");
    expect(rendererDoc.getMap("frontmatter").get("localRestoreTail")).toBe("Unadmitted owner work");
    stoppedRequests.mockRestore();
    await renderer.destroy(); renderer = undefined; ownerAvailable = false;
    const replayRequests = vi.spyOn(singleton,"sendRequest");
    const fenced = await stop();
    expect(fenced).toMatchObject({kind:"done",receipt:{operation:{operationId:"owner-stop",origin:{kind:"owner"},terminal:{deliveryId:"owner-stop-cut"}}}});
    if(fenced.kind!=="done")throw new Error("Native owner fence must complete");
    expect(fenced.receipt.operation.appliedSequence).toBe(appliedSequence);
    expect(fenced.receipt.localHeadSequence).toBeGreaterThan(appliedSequence);
    expect(await stop()).toEqual(fenced);
    expect(readStopRestore(deployment.storage as StorageContext,lookup)?.phase).toBe("native-fenced");
    expect(replayRequests.mock.calls.map(call=>call[0].method)).not.toContain("liveApplication.register");
    expect(replayRequests.mock.calls.map(call=>call[0].method)).not.toContain("liveApplication.ownerState");
    replayRequests.mockRestore();
    const prepared = await control.prepareRestore(lookup);
    if (prepared.kind !== "prepared") throw new Error("Owner restore proposal is pending.");
    const resumed = await control.completeRestore(lookup, prepared.proposalDigest);
    if (resumed.kind !== "resumed") throw new Error("Owner restore is pending.");
    expect(readFileSync(join(workspaceRoot, "docs/a.md"), "utf8")).toBe(seed.markdown);
    expect(native.prepare("SELECT sequence,update_digest,pending FROM owner_ydoc_outbox_entries WHERE pending=1 ORDER BY sequence").all()).toEqual(pendingTail);
    renderer = await openRenderer("renderer-restored"); ownerAvailable = true;
    expect(renderer.available).toBe(true);
    expect(yDocToMarkdown(renderer.doc!)).toBe(baselineProjection);
    const handoffsAfterRestore = handoffCount;
    renderer.doc!.getMap("frontmatter").set("afterRestore", "Fresh owner generation");
    await renderer.flushPendingLocalUpdates();
    expect(await drain()).toHaveProperty("kind", "done");
    expect(handoffCount).toBe(handoffsAfterRestore);
    expect(native.prepare("SELECT sequence,update_digest,pending FROM owner_ydoc_outbox_entries WHERE pending=1 ORDER BY sequence").all()).toEqual(pendingTail);
    expect((await control.settle(document)).materialized).toBe(true);
    expect(readFileSync(join(workspaceRoot, "docs/a.md"), "utf8")).toBe(yDocToMarkdown(renderer.doc!));
    const restoredConnection = deployment.storage.getLiveHostControl()!.registeredConnectionId;
    connection.stop(); await connection.closed; connection = connect();
    await expect.poll(() => deployment!.storage.getLiveHostControl()?.registeredConnectionId !== restoredConnection, {timeout: 30_000}).toBe(true);
    expect(await drain()).toHaveProperty("kind", "done");
    expect(handoffCount).toBe(handoffsAfterRestore);
    expect(await control.completeRestore(lookup, prepared.proposalDigest)).toEqual(resumed);
    writeFileSync(join(root,"result.json"),JSON.stringify({passed: true,binary,sha256: hash(readFileSync(binary)),document,markdown: yDocToMarkdown(remote)},null,2)); remote.destroy();
  } finally {
    releaseTailAdmission?.(); closeNamedPeer?.();
    captures.mockRestore();
    if (child && child.exitCode === null) {child.kill(); await once(child,"exit");}
    await closeNetwork?.();
    try { await renderer?.destroy(); await ipc?.shutdown(); await capture.stop(); await sessions.closeAll(); }
    finally { await lifecycle.stop(); deployment?.storage.close(); }
  }
},120_000);
