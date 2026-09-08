import {createHash} from "node:crypto";
import {spawn,spawnSync,type ChildProcess} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:http";
import {createServer as createTlsServer} from "node:https";
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {expect,it} from "vitest";
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
it.skipIf(!process.env.DOHC_OWNER_DESKTOP_PROOF_BINARY).each([false,true])("keeps the ordinary desktop owner through authenticated adoption, durable outbox delivery, remote apply and settlement (standalone=%s)", async standalone => {
  const binary = resolve(process.env.DOHC_OWNER_DESKTOP_PROOF_BINARY!);
  expect(hash(readFileSync(binary))).toBe(process.env.DOHC_OWNER_DESKTOP_PROOF_SHA256?.toLowerCase());
  const output = resolve(process.env.DOHC_OWNER_DESKTOP_PROOF_OUTPUT!); mkdirSync(output,{recursive: true});
  const root = mkdtempSync(join(output,"case-")), workspaceRoot = join(root,"workspace");
  mkdirSync(join(workspaceRoot,"docs"),{recursive: true});
  const seed = JSON.parse(readFileSync(new URL("../../../crates/dohc-engine-collab/tests/owner-source/owner-source-seed.json",import.meta.url),"utf8"));
  writeFileSync(join(workspaceRoot,"docs/a.md"),seed.markdown);
  const nativeConfig = join(root,"ordinary.json");
  writeFileSync(nativeConfig,JSON.stringify({ingress: {aggregateBytes: 400_000_000,applicationWorkingReserveBytes: 1_000_000,maxUploads: 2,uploadDeadlineMs: 30_000},
    maxRegistrations: 8,maxAdoptionBytes: 1_000_000,maxAdoptionEvents: 100,maxApplicationsPerSettlement: 100,ownerOutbox: {maxPendingBytes: 1_000_000,maxPendingAgeMs: 600_000}}));
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
    const sessionId = "renderer-existing"; let seq = 0;
    renderer = await bindEngineYDoc({
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
    expect(renderer.available).toBe(true);
    const rendererDoc = renderer.doc!;
    const engineBinding = await sessions.run(workspace,async binding => binding);
    const native = new DatabaseSync(dbPath,{readOnly: true});
    const origin = native.prepare("SELECT s.object_id,s.latest_moment_id,b.bytes,d.lineage_claim_id FROM snapshots s JOIN ydoc_docs d USING(workspace_id,version_id,object_id) JOIN ydoc_snapshots y USING(workspace_id,version_id,object_id) JOIN binary_blobs b ON b.sha256=y.snapshot_blob_sha256 WHERE y.up_to_seq=0").get()!;
    const document = {workspaceId: "workspace",mainVersionId: "main",objectId: String(origin.object_id),lineageClaimId: String(origin.lineage_claim_id)};
    const initialSession = native.prepare("SELECT COUNT(*) AS count FROM moments").get()!.count;
    const configPath = join(root,"deployment.json");
    initializeRelayDeployment({configPath,relayPath: join(root,"relay","relay.sqlite"),continuityDirectory: join(root,"continuity")}); deployment = openRelayDeployment(configPath);
    const credential = createDeviceHostCredential("host",parseHostEpoch(1));
    expect(deployment.storage.provisionDeviceHostCredential({credential,updatedAtMs: 1}).ok).toBe(true);
    const limits = {maxConnections: 4,maxHeaderBytes: 8192,maxCredentialBytes: 4096,maxPayloadBytes: 4096,maxPendingBytes: 4_000_000,maxFragments: 8,maxBufferedChunks: 16,
      handshakeTimeoutMs: 10_000,heartbeatIntervalMs: 500,heartbeatTimeoutMs: 10_000,closeTimeoutMs: 1000};
    const relayConfig = join(root,"relay-device.json");
    writeFileSync(relayConfig,JSON.stringify({version: 1,workspaceIds: ["workspace"],maxQueuedBytes: 4_000_000,maxActiveDrains: 2,client: {aggregateBytes: 200_000_000,maxUploads: 2,connectTimeoutMs: 30_000,requestDeadlineMs: 30_000,maxFrameBytes: 1_048_576}}));
    const relay = createServer(); relay.listen(0,"127.0.0.1"); await once(relay,"listening");
    const relayPort = (relay.address() as {port: number}).port, exchangeKey = "owner-desktop-exchange-key-32-bytes";
    const control = createDeviceControl({storage: deployment.storage,hosts: new Set([`127.0.0.1:${relayPort}`]),relayExchangeKey: exchangeKey,limits,
      delivery: {configPath: relayConfig,history: deployment.history,ownerAdmission: {shares: new Map([["workspace","share"]]),maxEntriesPerDrain: 10,maxBytesPerDrain: 10_000_000,validate: createLiveMarkdownJournalValidator(policy)}}});
    relay.on("upgrade",control.handleUpgrade);
    const certificate = fileURLToPath(new URL("../../../services/share-web/src/testing/device-control/localhost-cert.pem",import.meta.url));
    const key = fileURLToPath(new URL("../../../services/share-web/src/testing/device-control/localhost-key.pem",import.meta.url));
    const share = createTlsServer({cert: readFileSync(certificate),key: readFileSync(key)}); share.listen(0,"127.0.0.1"); await once(share,"listening");
    const sharePort = (share.address() as {port: number}).port;
    const bridge = createDeviceControlBridge({publicHosts: new Set([`localhost:${sharePort}`]),relayUrl: `http://127.0.0.1:${relayPort}`,relayExchangeKey: exchangeKey,limits,
      admission: {capacity: 8,refillPerSecond: 1,maxKeys: 8},trustedProxies: new Set()}); share.on("upgrade",bridge.handleUpgrade);
    const connect = () => connectDeviceHost({url: `wss://localhost:${sharePort}/api/device-control`,credential,limits,onRegistered() {},existingOwner: {
      client: singleton,workspaces: [{workspaceId: "workspace",workspaceHandle: engineBinding.workspace}],ownerFor: binding => ipc!.existingOwner(binding),
      maxQueuedBytes: 4_000_000,maxFrameBytes: 1_048_576,maxUploads: 2,maxRegistrations: 8,aggregateBytes: 200_000_000,maxAdoptionBytes: 1_000_000,maxAdoptionEvents: 100,requestDeadlineMs: 30_000}});
    let connection = connect();
    closeNetwork = async () => {connection.stop(); control.close(); bridge.close(); await connection.closed;
      await Promise.all([new Promise<void>(resolve => share.close(() => resolve())),new Promise<void>(resolve => relay.close(() => resolve()))]); native.close();};
    await expect.poll(() => deployment!.storage.getLiveHostControl()?.admissionState,{timeout: 30_000}).toBe("open");
    const hostRow = deployment.storage.getLiveHostControl()!, host = {mode: "device" as const,hostId: credential.hostId,hostEpoch: credential.hostEpoch,instanceId: credential.instanceId,connectionId: hostRow.registeredConnectionId!};
    const baseline = new Uint8Array(origin.bytes as Uint8Array), registration = createLiveMarkdownRegistrationValidator(policy)({document,currentPath: "docs/a.md",checkpoint: baseline});
    if (registration.kind !== "accepted") throw new Error(JSON.stringify(registration));
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
      expect(handoffCount).toBe(initialHandoffs);
      connection.stop(); await connection.closed;
      rendererDoc.getMap("frontmatter").set("offline","Reconnect owner edit"); await renderer.flushPendingLocalUpdates();
      await expect.poll(() => native.prepare("SELECT COUNT(*) AS count FROM owner_ydoc_outbox_entries WHERE pending=1").get()!.count,{timeout: 30_000}).toBeGreaterThan(0);
      connection = connect();
      await expect.poll(() => native.prepare("SELECT COUNT(*) AS count FROM owner_ydoc_outbox_entries WHERE pending=1").get()!.count,{timeout: 30_000}).toBe(0);
      await expect.poll(() => readFileSync(join(workspaceRoot,"docs/a.md"),"utf8"),{timeout: 30_000}).toContain("Reconnect owner edit");
      expect(lifecycle.currentClient()).toBe(singleton);
      expect(native.prepare("SELECT COUNT(*) AS count FROM live_device_bootstraps").get()!.count).toBe(0);
      writeFileSync(join(root,"result.json"),JSON.stringify({passed: true,standalone: true,binary,document,markdown: yDocToMarkdown(rendererDoc)},null,2)); remote.destroy();
      return;
    }
    const drain = async () => {let result: unknown,failure: unknown; await expect.poll(async () => {try {result = await control.drain(document); return true;} catch (error) {if ((error as Error).message.includes("not ready")) return false; failure = error; return true;}},{timeout: 30_000}).toBe(true); if (failure) throw failure; return result;};
    expect(await drain()).toMatchObject({kind: "done"});
    expect(native.prepare("SELECT COUNT(*) AS count FROM live_device_bootstraps").get()!.count).toBe(0);
    expect(native.prepare("SELECT COUNT(*) AS count FROM moments").get()!.count).toBe(initialSession);
    rendererDoc.getMap("frontmatter").set("title","Owner edit"); await renderer.flushPendingLocalUpdates();
    const binding = deployment.storage.resolveCurrentLiveDocumentBinding({document,actor: {kind: "owner",userId: "owner",shareId: "share"}});
    if (binding.kind !== "current") throw new Error("Owner binding unavailable.");
    await ipc.existingOwner(binding.binding).prepareHandoff(new AbortController().signal).then(() => ipc!.existingOwner(binding.binding).finishHandoff(true));
    expect(native.prepare("SELECT COUNT(*) AS count FROM owner_ydoc_outbox_entries WHERE pending=1").get()!.count).toBeGreaterThan(0);
    await drain();
    const remote = new Y.Doc(); Y.applyUpdate(remote,Y.encodeStateAsUpdate(rendererDoc)); const before = Y.encodeStateVector(remote);
    remote.getMap("frontmatter").set("remote","Remote edit"); const update = Y.encodeStateAsUpdate(remote,before);
    const actor = {kind: "named" as const,userId: "reader",grantId: "named-grant"};
    const current = deployment.storage.resolveCurrentLiveDocumentBinding({document,actor}), cut = deployment.storage.readLiveUpdateJournalCut({document});
    if (current.kind !== "current" || cut.kind !== "cut") throw new Error("Remote cut unavailable.");
    expect(deployment.storage.commitLiveUpdateJournal({host,actor,expectedAuthority: current.authority,metadata: {deliveryId: "remote-edit",updateDigest: hash(update),binding: current.binding},
      cutToken: cut.cut,validation: createLiveMarkdownJournalValidator(policy)({document,currentPath: "docs/a.md",checkpoint: cut.cut.checkpoint.bytes,suffix: cut.cut.suffix.map(row => row.bytes),candidate: update}),updateBytes: update,receivedAtMs: Date.now()}).result.kind).toBe("accepted");
    await control.settle(document);
    expect(yDocToMarkdown(rendererDoc)).toBe(yDocToMarkdown(remote));
    expect(readFileSync(join(workspaceRoot,"docs/a.md"),"utf8")).toBe(yDocToMarkdown(remote));
    expect(lifecycle.currentClient()).toBe(singleton);
    expect(native.prepare("SELECT COUNT(*) AS count FROM live_device_bootstraps").get()!.count).toBe(0);
    writeFileSync(join(root,"result.json"),JSON.stringify({passed: true,binary,sha256: hash(readFileSync(binary)),document,markdown: yDocToMarkdown(remote)},null,2)); remote.destroy();
  } finally {
    if (child && child.exitCode === null) {child.kill(); await once(child,"exit");}
    await closeNetwork?.();
    try { await renderer?.destroy(); await ipc?.shutdown(); await capture.stop(); await sessions.closeAll(); }
    finally { await lifecycle.stop(); deployment?.storage.close(); }
  }
},120_000);
