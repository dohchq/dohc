import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "./import-export.js";
import { createLiveMarkdownRegistrationValidator, createLiveMarkdownJournalValidator } from "./liveDocumentValidation.js";
import { createEngineClient, EngineClient } from "../../workspace-engine-client/src/daemon/engineClient.js";
import { initializeRelayDeployment, openRelayDeployment } from "../../../services/sync-relay/src/relayDeployment.js";
import { createDeviceControl } from "../../../services/sync-relay/src/deviceControl.js";
import { createDeviceControlBridge } from "../../../services/share-web/src/deviceControlBridge.js";
import { prepareDeviceHostCredentialFile } from "../../../services/sync-relay/src/deviceHostCredentialFile.js";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { LiveCommittedDeliveryStore } from "../../../services/sync-relay/src/storage/liveCommittedDelivery.js";
import type { LiveHostConnectionCoordinate } from "../../../services/sync-relay/src/storage.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// Test inputs, not a release policy.
const policy = { maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000,
  maxDecodedPayloadByteVisits: 100_000_000, maxStructClientGroupVisits: 1_000_000,
  maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000 };

it("delivers through the outbound TLS device pipe and replays a lost durable acknowledgement", async () => {
  const executable = process.env.DOHC_DEVICE_HOST_PROOF_BINARY ? resolve(process.env.DOHC_DEVICE_HOST_PROOF_BINARY) : undefined;
  const expectedHash = process.env.DOHC_DEVICE_HOST_PROOF_SHA256;
  const output = process.env.DOHC_DEVICE_HOST_PROOF_OUTPUT;
  if (!executable || !expectedHash || !output) throw new Error("Pinned device host proof inputs are required.");
  expect(hash(readFileSync(executable))).toBe(expectedHash.toLowerCase());
  mkdirSync(output, { recursive: true });
  const root = mkdtempSync(join(resolve(output), "case-")), workspace = join(root, "workspace");
  mkdirSync(workspace);
  const seed = await createEngineClient({ command: executable, authToken: "service-proof-seed", protocolVersion: 2,
    capabilities: ["core"], connectTimeoutMs: 30_000 });
  let mainVersionId: string;
  try {
    const opened = await seed.sendRequest({ id: 1, method: "workspace.open", params: { rootDir: workspace, workspaceId: "workspace", captureMode: "none" }, deadlineMs: 30_000 });
    const handle = (opened.result as { workspace: string }).workspace;
    const main = await seed.sendRequest({ id: 2, method: "versions.ensureMain", workspace: handle, params: {}, deadlineMs: 30_000 });
    mainVersionId = (main.result as { id: string }).id;
  } finally { seed.close(); await seed.waitForExit(); }
  expect(mainVersionId!).toBeTruthy();
  const deploymentConfig = join(root, "deployment.json");
  const relayPath = join(root, "relay", "relay.sqlite");
  initializeRelayDeployment({ configPath: deploymentConfig, relayPath, continuityDirectory: join(root, "continuity") });
  let deployment = openRelayDeployment(deploymentConfig);
  const credentialDirectory = join(root, "credential");
  const credential = await prepareDeviceHostCredentialFile(credentialDirectory, "device", parseHostEpoch(1));
  expect(deployment.storage.provisionDeviceHostCredential({ credential, updatedAtMs: 1 }).ok).toBe(true);
  const deviceConfig = join(root, "device.json"), relayConfig = join(root, "relay-device.json");
  writeFileSync(deviceConfig, JSON.stringify({ version: 1, engineExecutable: executable, hostId: credential.hostId,
    hostEpoch: credential.hostEpoch, instanceId: credential.instanceId, maxQueuedBytes: 4_000_000, shutdownGraceMs: 5000,
    workspaces: [{ root: workspace, workspaceId: "workspace", maxRegistrations: 8 }],
    ingress: { aggregateBytes: 400_000_000, applicationWorkingReserveBytes: 1_000_000, maxUploads: 2, uploadDeadlineMs: 30_000 } }));
  writeFileSync(relayConfig, JSON.stringify({ version: 1, workspaceIds: ["workspace"], maxQueuedBytes: 4_000_000, maxActiveDrains: 2,
    client: { aggregateBytes: 200_000_000, maxUploads: 2, connectTimeoutMs: 30_000, requestDeadlineMs: 30_000, maxFrameBytes: 1_048_576 } }));
  const limits = { maxConnections: 4, maxHeaderBytes: 8192, maxCredentialBytes: 4096, maxPayloadBytes: 4096,
    maxPendingBytes: 4_000_000, maxFragments: 8, maxBufferedChunks: 16, handshakeTimeoutMs: 10_000,
    heartbeatIntervalMs: 500, heartbeatTimeoutMs: 10_000, closeTimeoutMs: 1000 };
  const certificate = fileURLToPath(new URL("../../../services/share-web/src/testing/device-control/localhost-cert.pem", import.meta.url));
  const key = fileURLToPath(new URL("../../../services/share-web/src/testing/device-control/localhost-key.pem", import.meta.url));
  const connectorCommand = fileURLToPath(new URL("../../../services/sync-relay/dist/device-host-connect.js", import.meta.url));
  const guard = join(root, "device-network-guard.mjs");
  writeFileSync(guard, `import net from 'node:net';
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
net.Server.prototype.listen = function () { throw new Error('Device listener forbidden'); };
const original = child.spawn;
child.spawn = function (...args) { const process = original.apply(this, args); console.error('OWNED_NATIVE_PID=' + process.pid); process.once('close', () => console.error('CLOSED_NATIVE_PID=' + process.pid)); return process; };
syncBuiltinESMExports();\n`);
  const processRows: { connectorPid: number; nativePid?: number; logs?: string }[] = [];
  const children = new Set<ChildProcessWithoutNullStreams>();
  const childClosures = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  let control: ReturnType<typeof createDeviceControl> | undefined;
  let relay: ReturnType<typeof createServer> | undefined;
  let bridge: ReturnType<typeof createDeviceControlBridge> | undefined;
  let share: ReturnType<typeof createTlsServer> | undefined;
  async function launch() {
    const exchangeKey = "device-delivery-proof-exchange-key-32";
    relay = createServer(); relay.listen(0, "127.0.0.1"); await once(relay, "listening");
    const relayAddress = relay.address(); if (!relayAddress || typeof relayAddress === "string") throw new Error();
    control = createDeviceControl({ storage: deployment.storage, hosts: new Set([`127.0.0.1:${relayAddress.port}`]), relayExchangeKey: exchangeKey,
      limits, delivery: { configPath: relayConfig, history: deployment.history } });
    relay.on("upgrade", control.handleUpgrade);
    share = createTlsServer({ cert: readFileSync(certificate), key: readFileSync(key) });
    share.listen(0, "127.0.0.1"); await once(share, "listening");
    const shareAddress = share.address(); if (!shareAddress || typeof shareAddress === "string") throw new Error();
    bridge = createDeviceControlBridge({ publicHosts: new Set([`localhost:${shareAddress.port}`]), relayUrl: `http://127.0.0.1:${relayAddress.port}`,
      relayExchangeKey: exchangeKey, limits, admission: { capacity: 8, refillPerSecond: 1, maxKeys: 8 }, trustedProxies: new Set() });
    share.on("upgrade", bridge.handleUpgrade);
    return connectDevice();
  }
  async function connectDevice() {
    const shareAddress = share!.address(); if (!shareAddress || typeof shareAddress === "string") throw new Error();
    const previousConnection = deployment.storage.getLiveHostControl()?.registeredConnectionId;
    const child = spawn(process.execPath, ["--import", pathToFileURL(guard).href, connectorCommand, "--url", `wss://localhost:${shareAddress.port}/api/device-control`,
      "--credential-directory", credentialDirectory, "--limits-json", JSON.stringify(limits), "--delivery-config", deviceConfig], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "", NODE_EXTRA_CA_CERTS: certificate } });
    children.add(child);
    const record: typeof processRows[number] = { connectorPid: child.pid! }; processRows.push(record);
    let logs = "";
    child.stdout.on("data", bytes => { logs += String(bytes); });
    child.stderr.on("data", bytes => { logs += String(bytes); const match = /OWNED_NATIVE_PID=(\d+)/.exec(logs); if (match) record.nativePid = Number(match[1]); });
    child.on("error", error => { logs += error.message; });
    childClosures.set(child, new Promise<void>(resolve => child.once("close", () => { record.logs = logs; children.delete(child); resolve(); })));
    await expect.poll(() => {
      if (child.exitCode !== null) throw new Error(logs);
      const current = deployment.storage.getLiveHostControl();
      return current?.admissionState === "open" && current.registeredConnectionId !== previousConnection;
    }, { timeout: 30_000 }).toBe(true);
    const row = deployment.storage.getLiveHostControl()!;
    const coordinate: LiveHostConnectionCoordinate = { mode: "device", hostId: credential.hostId, hostEpoch: credential.hostEpoch,
      instanceId: credential.instanceId, connectionId: row.registeredConnectionId! };
    return { coordinate, drain: async (document: Parameters<NonNullable<typeof control>["drain"]>[0]) => {
      let result: Awaited<ReturnType<NonNullable<typeof control>["drain"]>> | undefined;
      let failure: unknown;
      await expect.poll(async () => {
        if (child.exitCode !== null) { failure = new Error(logs); return true; }
        try { result = await control!.drain(document); return true; }
        catch (error) { if ((error as Error).message.includes("not ready")) return false; failure = error; return true; }
      }, { timeout: 30_000 }).toBe(true);
      if (failure) throw failure;
      return result!;
    } };
  }
  async function closeTransport() {
    control?.close(); bridge?.close();
    await Promise.all([...childClosures.values()]);
    if (share) await new Promise<void>(resolve => share!.close(() => resolve()));
    if (relay) await new Promise<void>(resolve => relay!.close(() => resolve()));
    control = undefined; bridge = undefined; share = undefined; relay = undefined;
  }
  const doc = markdownToYDoc("Hello");
  let active: Awaited<ReturnType<typeof launch>> | undefined;
  const results: unknown[] = [];
  try {
    const { storage } = deployment;
    expect(storage.claimWorkspace({ workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1 })).toBe("created");
    active = await launch();
    const baseline = Y.encodeStateAsUpdate(doc);
    const document = { workspaceId: "workspace", mainVersionId: mainVersionId!, objectId: "object", lineageClaimId: hash(baseline) };
    const registration = createLiveMarkdownRegistrationValidator(policy)({ document, currentPath: "docs/a.md", checkpoint: baseline });
    if (registration.kind !== "accepted") throw new Error(JSON.stringify(registration));
    const e = registration.evidence;
    const markdown = Buffer.from("Hello");
    expect(hash(markdown)).toBe(e.projectedMarkdownSha256);
    storage.putBlob({ workspaceId: "workspace", sha256: hash(markdown), content: markdown, createdAtMs: 2 });
    storage.appendLogBatch({ workspaceId: "workspace", originId: "owner", ops: [{ originSeq: 0, opKind: "moment.append", recordedAtMs: 2,
      payloadJson: JSON.stringify({ objectId: "object", momentId: "baseline", versionId: mainVersionId!, recordedAtMs: 2, operation: "write",
        path: "docs/a.md", payloadAfterPath: "docs/a.md", payloadAfterBlobSha256: e.projectedMarkdownSha256,
        payloadAfterContentKind: "text", payloadAfterByteLength: e.projectedMarkdownByteLength }) }] });
    expect(storage.registerLiveDocumentBaseline({ host: active.coordinate, evidence: e, baselineBytes: baseline, registeredAtMs: 3 }).kind).toBe("registered");
    storage.createShare({ share: { shareId: "share", workspaceId: "workspace", granterUserId: "owner", selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }), createdAtMs: 3 },
      grant: { grantId: "grant", shareId: "share", principalKind: "user", principalUserId: "reader", principalEmail: null, access: "edit", generation: 1,
        status: "active", createdAtMs: 3, revokedAtMs: null, parentGrantId: null } });
    const actor = { kind: "owner", userId: "owner", shareId: "share" } as const;
    const admit = (deliveryId: string) => {
      const before = Y.encodeStateVector(doc);
      doc.getMap("frontmatter").set("title", deliveryId);
      const paragraph = doc.getXmlFragment("body").get(0) as Y.XmlElement;
      const text = paragraph.get(0) as Y.XmlText;
      text.insert(text.length, ` ${deliveryId}`);
      const update = Y.encodeStateAsUpdate(doc, before), store = deployment.storage;
      const current = store.resolveCurrentLiveDocumentBinding({ document, actor });
      const cut = store.readLiveUpdateJournalCut({ document });
      if (current.kind !== "current" || cut.kind !== "cut") throw new Error("Live authority unavailable.");
      const validation = createLiveMarkdownJournalValidator(policy)({ document, currentPath: "docs/a.md", checkpoint: cut.cut.checkpoint.bytes,
        suffix: cut.cut.suffix.map(row => row.bytes), candidate: update });
      const accepted = store.commitLiveUpdateJournal({ host: current.host, actor, expectedAuthority: current.authority,
        metadata: { deliveryId, updateDigest: hash(update), binding: current.binding }, cutToken: cut.cut,
        validation, updateBytes: update, receivedAtMs: Date.now() });
      expect(accepted.result.kind).toBe("accepted");
      return hash(update);
    };
    const firstDigest = admit("delivery");
    const first = await active.drain(document);
    expect(first).toMatchObject({ kind: "done", terminalReceipt: { deliveryId: "delivery", updateDigest: firstDigest } });
    results.push({ round: 1, coordinate: active.coordinate, result: first });
    await closeTransport(); active = undefined;
    deployment.storage.close();
    deployment = openRelayDeployment(deploymentConfig);
    active = await launch();
    const second = await active.drain(document);
    expect(second).toEqual(first);
    results.push({ round: 2, coordinate: active.coordinate, result: second });
    const secondDigest = admit("after-restart");
    const continued = await active.drain(document);
    expect(continued).toMatchObject({ kind: "done", terminalReceipt: { deliveryId: "after-restart", updateDigest: secondDigest } });
    results.push({ round: 2, continued });
    const lostDigest = admit("lost-ack");
    const acknowledge = LiveCommittedDeliveryStore.prototype.acknowledge;
    let lost = false;
    const loss = vi.spyOn(LiveCommittedDeliveryStore.prototype, "acknowledge").mockImplementation(function (this: LiveCommittedDeliveryStore, ...args) {
      if (!lost) { lost = true; control!.close(); throw new Error("Injected lost durable ACK"); }
      return acknowledge.apply(this, args);
    });
    try { await expect(active.drain(document)).rejects.toThrow("Injected lost durable ACK"); }
    finally { loss.mockRestore(); }
    await closeTransport(); active = undefined;
    deployment.storage.close(); deployment = openRelayDeployment(deploymentConfig);
    active = await launch();
    const replay = await active.drain(document);
    expect(replay).toMatchObject({ kind: "done", terminalReceipt: { deliveryId: "lost-ack", updateDigest: lostDigest } });
    results.push({ lostAckReplayed: replay });
    const staleDigest = admit("replacement");
    const apply = EngineClient.prototype.sendLiveApplication;
    let enter!: () => void, release!: () => void, held = false;
    let configuredClient: EngineClient | undefined;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const heldResult = vi.spyOn(EngineClient.prototype, "sendLiveApplication").mockImplementation(async function (this: EngineClient, ...args) {
      configuredClient = this;
      const response = await apply.apply(this, args);
      if (!held) { held = true; enter(); await released; }
      return response;
    });
    const oldDrain = active.drain(document).then(result => ({ result }), error => ({ error }));
    try {
      await entered;
      const oldCoordinate = active.coordinate;
      active = await connectDevice();
      expect(active.coordinate.connectionId).not.toBe(oldCoordinate.connectionId);
      let replacement;
      try { replacement = await active.drain(document); }
      catch (error) {
        const message = (error as Error).message;
        if (message !== "Device delivery is unavailable." && !message.includes("workspace-owned")) throw error;
        await Promise.all([...childClosures.values()]);
        const attempt = processRows.at(-1)!;
        if (!attempt.logs?.includes("workspace-owned")) throw error;
        results.push({ replacementRefusedWhilePriorWriterClosed: attempt });
        active = await connectDevice();
        replacement = await active.drain(document);
      }
      expect(replacement).toMatchObject({ kind: "done", terminalReceipt: { deliveryId: "replacement", updateDigest: staleDigest } });
      release();
      expect(await oldDrain).toHaveProperty("error");
      expect(await active.drain(document)).toEqual(replacement);
      await expect(configuredClient!.sendRequest({ id: 1_000_000, method: "secrets.read", params: {}, deadlineMs: 1000 }))
        .rejects.toMatchObject({ wireError: { code: "FORBIDDEN" } });
      results.push({ replacement, staleAcknowledgementRefused: true });
    } finally { release(); heldResult.mockRestore(); }
    const finalConnectionId = active.coordinate.connectionId;
    expect(deployment.storage.revokeDeviceHostCredential({ hostId: credential.hostId, instanceId: credential.instanceId, updatedAtMs: Date.now() }).ok).toBe(true);
    await Promise.all([...childClosures.values()]);
    await expect(control!.drain(document)).rejects.toThrow();
    await closeTransport(); active = undefined;
    const engine = new DatabaseSync(join(workspace, ".dohc", "engine", "engine.db"), { readOnly: true });
    try {
      const applications = engine.prepare("SELECT delivery_id, update_digest FROM live_device_update_applications ORDER BY journal_cursor").all();
      expect(applications).toEqual([{ delivery_id: "delivery", update_digest: firstDigest }, { delivery_id: "after-restart", update_digest: secondDigest },
        { delivery_id: "lost-ack", update_digest: lostDigest }, { delivery_id: "replacement", update_digest: staleDigest }]);
      expect(engine.prepare("SELECT COUNT(*) AS count FROM live_device_bootstraps").get()!.count).toBe(1);
      const indexed = engine.prepare("SELECT path, text FROM engine_search_files_fts WHERE object_id = 'object'").all();
      const nativeDoc = new Y.Doc();
      try {
        const checkpoint = engine.prepare("SELECT b.bytes FROM ydoc_snapshots s JOIN binary_blobs b ON b.sha256=s.snapshot_blob_sha256 WHERE s.object_id='object' ORDER BY up_to_seq DESC LIMIT 1").get()!;
        Y.applyUpdate(nativeDoc, checkpoint.bytes as Uint8Array);
        for (const row of engine.prepare("SELECT b.bytes FROM ydoc_updates u JOIN binary_blobs b ON b.sha256=u.update_blob_sha256 WHERE u.object_id='object' ORDER BY seq").all()) {
          Y.applyUpdate(nativeDoc, row.bytes as Uint8Array);
        }
        expect(yDocToMarkdown(nativeDoc)).toBe(yDocToMarkdown(doc));
        results.push({ applications, durableMarkdown: yDocToMarkdown(nativeDoc),
          settlement: { status: "pending-separate-integration", indexed, artifactExists: existsSync(join(workspace, "docs", "a.md")) } });
      } finally { nativeDoc.destroy(); }
    } finally { engine.close(); }
    const relayObserver = new DatabaseSync(relayPath, { readOnly: true });
    try {
      const progress = relayObserver.prepare("SELECT delivery_id, journal_cursor, predecessor_cursor, ack_connection_id FROM sync_relay_live_delivery_edges ORDER BY journal_cursor").all();
      expect(progress.map(row => [row.delivery_id, row.journal_cursor, row.predecessor_cursor])).toEqual([
        ["delivery", 1, 0], ["after-restart", 2, 1], ["lost-ack", 3, 2], ["replacement", 4, 3] ]);
      expect(progress[3]!.ack_connection_id).toBe(finalConnectionId);
      results.push({ durableProgress: progress });
    } finally { relayObserver.close(); }
    expect(hash(readFileSync(executable))).toBe(expectedHash.toLowerCase());
    expect(children.size).toBe(0);
    expect(processRows.every(row => row.nativePid)).toBe(true);
    for (const row of processRows) expect(row.logs).toContain(`CLOSED_NATIVE_PID=${row.nativePid}`);
    writeFileSync(join(root, "result.json"), JSON.stringify({ verdict: "PASS", scope: "durable-outbound-delivery; settlement remains pending", executable, sha256: expectedHash, results, processRows }, null, 2));
  } finally {
    await closeTransport();
    writeFileSync(join(root, "processes.json"), JSON.stringify(processRows, null, 2));
    deployment.storage.close();
    doc.destroy();
  }
}, 90_000);
