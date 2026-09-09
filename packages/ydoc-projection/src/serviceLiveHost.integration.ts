import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { yDocToMarkdown, markdownToYDoc } from "./import-export.js";
import { createLiveMarkdownRegistrationValidator, createLiveMarkdownJournalValidator } from "./liveDocumentValidation.js";
import { createEngineClient, EngineClient } from "../../workspace-engine-client/src/daemon/engineClient.js";
import { initializeRelayDeployment, openRelayDeployment } from "../../../services/sync-relay/src/relayDeployment.js";
import { startServiceLiveHost } from "../../../services/sync-relay/src/serviceLiveHost.js";
import {createNamedFrameChanges} from "../../../services/sync-relay/src/liveHostChanges.js";
import {beginStopRestore, advanceStopRestoreFence, readStopRestore} from "../../../services/sync-relay/src/storage/liveRestoreOperation.js";
import type {StorageContext} from "../../../services/sync-relay/src/storage/context.js";
import {LiveCommittedDeliveryStore} from "../../../services/sync-relay/src/storage/liveCommittedDelivery.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// Test inputs, not a release policy.
const policy = { maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000,
  maxDecodedPayloadByteVisits: 100_000_000, maxStructClientGroupVisits: 1_000_000,
  maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000 };

it.each(["before-native-fence", "after-native-fence"] as const)("bootstraps and applies through a configured production daemon, then recovers both owners at %s", async boundary => {
  const executable = process.env.DOHC_SERVICE_HOST_PROOF_BINARY ? resolve(process.env.DOHC_SERVICE_HOST_PROOF_BINARY) : undefined;
  const expectedHash = process.env.DOHC_SERVICE_HOST_PROOF_SHA256;
  const output = process.env.DOHC_SERVICE_HOST_PROOF_OUTPUT;
  if (!executable || !expectedHash || !output) throw new Error("Pinned service host proof inputs are required.");
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
  const serviceConfig = join(root, "service.json");
  writeFileSync(serviceConfig, JSON.stringify({ version: 1, engineExecutable: executable, hostId: "service", instanceId: "instance",
    workspaces: [{ root: workspace, workspaceId: "workspace", maxRegistrations: 8 }],
    settlement: { maxApplicationsPerSettlement: 8 },
    sync: {policy: {maxClientVectorBytes: 100_000, maxHostVectorBytes: 100_000,
      maxOutputBytes: 1_000_000, maxReadBytes: 4_000_000}, workingReserveBytes: 4_000_000},
    restore: {maxBytes: 1_000_000, maxEvents: 100, aggregateBytes: 17_000_000,
      workingReserveBytes: 1_000_000, maxOperations: 1, validation: policy},
    ingress: { aggregateBytes: 400_000_000, applicationWorkingReserveBytes: 1_000_000, maxUploads: 2, uploadDeadlineMs: 30_000 },
    client: { aggregateBytes: 200_000_000, maxUploads: 2, connectTimeoutMs: 30_000, requestDeadlineMs: 30_000 } }));
  let doc = markdownToYDoc("Hello");
  const frameChanges = createNamedFrameChanges(32);
  let active: Awaited<ReturnType<typeof startServiceLiveHost>> | undefined;
  const results: unknown[] = [];
  try {
    const { storage } = deployment;
    expect(storage.claimWorkspace({ workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1 })).toBe("created");
    expect(storage.provisionLiveHostControl({ mode: "service", hostId: "service", updatedAtMs: 1, guard: storage.captureStanding() }).ok).toBe(true);
    active = await startServiceLiveHost({ configPath: serviceConfig, ...deployment, frameChanges });
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
    const readAccepted = async () => {
      const current = deployment.storage.resolveCurrentLiveDocumentBinding({document, actor});
      if (current.kind !== "current") throw new Error("Live authority unavailable.");
      const capture = await active!.captureNative(current.binding);
      const request = () => ({id: capture.nextRequestId(), workspace: capture.workspace,
        registrationId: capture.registrationId, deadlineMs: capture.deadlineMs});
      const sync = await capture.client.openLiveAppliedSync(request(), Uint8Array.of(0),
        {maxInputBytes: 100_000, maxOutputBytes: 1_000_000});
      const browser = new Y.Doc();
      try {Y.applyUpdate(browser, sync.missingStateUpdate); expect(yDocToMarkdown(browser)).toBe(yDocToMarkdown(doc));}
      finally {browser.destroy();}
      return {capture, request, sync};
    };
    const firstReader = await readAccepted();
    const firstSettlement = await active.settle(document);
    expect(firstSettlement.materialized).toBe(true);
    expect(firstReader.capture.invalidated.aborted).toBe(false);
    expect((await active.captureNative(firstReader.capture.binding)).registrationId).toBe(firstReader.capture.registrationId);
    expect(readFileSync(join(workspace,"docs/a.md"),"utf8")).toBe(yDocToMarkdown(doc));
    results.push({ round: 1, coordinate: active.coordinate, result: first, settlement: firstSettlement });
    await active.close(); active = undefined;
    expect(firstReader.capture.invalidated.aborted).toBe(true);
    deployment.storage.close();
    deployment = openRelayDeployment(deploymentConfig);
    active = await startServiceLiveHost({ configPath: serviceConfig, ...deployment, frameChanges });
    const second = await active.drain(document);
    expect(second).toEqual(first);
    expect(await active.settle(document)).toEqual(firstSettlement);
    results.push({ round: 2, coordinate: active.coordinate, result: second });
    const secondReader = await readAccepted();
    const secondDigest = admit("after-restart");
    const continued = await active.drain(document);
    expect(continued).toMatchObject({ kind: "done", terminalReceipt: { deliveryId: "after-restart", updateDigest: secondDigest } });
    const nextApplied = await secondReader.capture.client.readNextLiveApplied(secondReader.request(), secondReader.sync.position, 1_000_000);
    expect(nextApplied).toMatchObject({ack: {deliveryId: "after-restart", updateDigest: secondDigest}});
    const browser = new Y.Doc();
    try {
      Y.applyUpdate(browser, secondReader.sync.missingStateUpdate);
      Y.applyUpdate(browser, nextApplied!.updateBytes);
      expect(yDocToMarkdown(browser)).toBe(yDocToMarkdown(doc));
    } finally {browser.destroy();}
    expect(secondReader.capture.invalidated.aborted).toBe(false);
    const continuedSettlement = await active.settle(document);
    expect(continuedSettlement).toMatchObject({ previousCursor: 1, terminalCursor: 2, applicationCount: 1, materialized: true });
    expect(readFileSync(join(workspace,"docs/a.md"),"utf8")).toBe(yDocToMarkdown(doc));
    results.push({ round: 2, continued, settlement: continuedSettlement });
    const finalDigest = admit("stop-cut");
    const authority = deployment.storage.resolveCurrentLiveDocumentBinding({document, actor});
    if (authority.kind !== "current") throw new Error("Restore authority unavailable.");
    const lookup = {operationId: "restore-stop", workspaceId: "workspace", ownerUserId: "owner"};
    beginStopRestore(deployment.storage as StorageContext, {deliveryKind: "bootstrap", ...lookup, document,
      shareId: "share", grantId: "grant", expectedGrantGeneration: 1, expectedDependentGrantIds: [],
      expectedFence: authority.binding.restoreFenceGeneration, restorePointCursor: 0, restorePointReceiptDigest: hash(baseline)}, Date.now());
    advanceStopRestoreFence(deployment.storage as StorageContext, lookup, Date.now());
    const originalRequest = EngineClient.prototype.sendRequest;
    let interrupted = false;
    const lost = boundary === "after-native-fence"
      ? vi.spyOn(LiveCommittedDeliveryStore.prototype, "acknowledgeStopRestoreFence").mockImplementationOnce(() => {throw new Error("lost native-fence boundary");})
      : vi.spyOn(EngineClient.prototype, "sendRequest").mockImplementation(function(this: EngineClient, ...args: Parameters<EngineClient["sendRequest"]>) {
        if (!interrupted && args[0].method === "liveApplication.fenceRestore") {interrupted = true; return Promise.reject(new Error("lost native-fence boundary"));}
        return originalRequest.apply(this, args);
      });
    try {await expect(active.stopRestore(lookup)).rejects.toThrow("lost native-fence boundary");}
    finally {lost.mockRestore();}
    expect(secondReader.capture.invalidated.aborted).toBe(true);
    expect(readStopRestore(deployment.storage as StorageContext, lookup)?.phase).toBe("old-cut-applied");
    await active.close(); active = undefined;
    let nativeReceipt: unknown;
    const stopped = new DatabaseSync(join(workspace, ".dohc", "engine", "engine.db"), {readOnly: true});
    try {
      const saved = stopped.prepare("SELECT receipt_json FROM live_restore_fences").get();
      nativeReceipt = saved ? JSON.parse(String(saved.receipt_json)) : null;
      expect(nativeReceipt === null).toBe(boundary === "before-native-fence");
    }
    finally {stopped.close();}
    deployment.storage.close();
    deployment = openRelayDeployment(deploymentConfig);
    active = await startServiceLiveHost({configPath: serviceConfig, ...deployment, frameChanges});
    const restored = await active.stopRestore(lookup);
    if (nativeReceipt !== null) expect(restored).toEqual({kind: "done", receipt: nativeReceipt});
    expect(restored).toMatchObject({receipt: {operation: {origin: {kind: "bootstrap"}, terminal: {deliveryId: "stop-cut", updateDigest: finalDigest}, newFence: authority.binding.restoreFenceGeneration + 1}}});
    expect(await active.stopRestore(lookup)).toEqual(restored);
    expect(readStopRestore(deployment.storage as StorageContext, lookup)?.phase).toBe("native-fenced");
    await expect(active.drain(document)).rejects.toThrow();
    results.push({stop: restored});
    await active.close(); active = undefined;
    const engine = new DatabaseSync(join(workspace, ".dohc", "engine", "engine.db"), { readOnly: true });
    try {
      const applications = engine.prepare("SELECT delivery_id, update_digest FROM live_device_update_applications ORDER BY journal_cursor").all();
      expect(applications).toEqual([{ delivery_id: "delivery", update_digest: firstDigest }, { delivery_id: "after-restart", update_digest: secondDigest }, {delivery_id: "stop-cut", update_digest: finalDigest}]);
      expect(engine.prepare("SELECT COUNT(*) AS count FROM live_device_bootstraps").get()!.count).toBe(1);
      expect(engine.prepare("SELECT available,restore_fence_generation FROM live_device_application_bindings").get()).toMatchObject({available: 0, restore_fence_generation: authority.binding.restoreFenceGeneration + 1});
      expect(engine.prepare("SELECT COUNT(*) AS count FROM live_device_settlements").get()!.count).toBe(2);
      results.push({ applications });
    } finally { engine.close(); }
    if (boundary === "after-native-fence") {
      const restart = async () => {
        await active?.close(); active = undefined;
        deployment.storage.close(); deployment = openRelayDeployment(deploymentConfig);
        active = await startServiceLiveHost({configPath: serviceConfig, ...deployment, frameChanges});
      };
      await restart();
      const prepared = await active!.prepareRestore(lookup);
      if (prepared.kind !== "prepared") throw new Error("Restore proposal is pending.");
      for (const method of ["acknowledgeStopRestoreReplacement", "acknowledgeStopRestoreSettlement", "acknowledgeStopRestoreResume"] as const) {
        const lostAck = vi.spyOn(LiveCommittedDeliveryStore.prototype, method).mockImplementationOnce(() => {throw new Error(`lost ${method}`);});
        try {await expect(active!.completeRestore(lookup, prepared.proposalDigest)).rejects.toThrow(`lost ${method}`);}
        finally {lostAck.mockRestore();}
        await restart();
      }
      const resumed = await active!.completeRestore(lookup, prepared.proposalDigest);
      if (resumed.kind !== "resumed") throw new Error("Restore did not resume.");
      expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe("Hello");
      expect(await active!.completeRestore(lookup, prepared.proposalDigest)).toEqual(resumed);
      const restoredCut = deployment.storage.readLiveUpdateJournalCut({document});
      if (restoredCut.kind !== "cut") throw new Error("Restored cut is unavailable.");
      doc.destroy(); doc = new Y.Doc();
      Y.applyUpdate(doc, restoredCut.cut.checkpoint.bytes);
      for (const event of restoredCut.cut.suffix) Y.applyUpdate(doc, event.bytes);
      expect(yDocToMarkdown(doc)).toBe("Hello");
      admit("after-first-resume");
      expect(await active!.drain(document)).toMatchObject({kind: "done", terminalReceipt: {deliveryId: "after-first-resume"}});
      expect((await active!.settle(document)).materialized).toBe(true);
      expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe(yDocToMarkdown(doc));
      deployment.storage.createShare({share: {shareId: "second-share", workspaceId: "workspace", granterUserId: "owner",
        selectorJson: JSON.stringify({paths: ["docs"], versionId: null}), createdAtMs: 4},
        grant: {grantId: "second-grant", shareId: "second-share", principalKind: "user", principalUserId: "reader", principalEmail: null,
          access: "edit", generation: 1, status: "active", createdAtMs: 4, revokedAtMs: null, parentGrantId: null}});
      const secondLookup = {...lookup, operationId: "second-restore"};
      beginStopRestore(deployment.storage as StorageContext, {...secondLookup, deliveryKind: "bootstrap", document,
        shareId: "second-share", grantId: "second-grant", expectedGrantGeneration: 1, expectedDependentGrantIds: [],
        expectedFence: resumed.receipt.binding.restoreFenceGeneration, restorePointCursor: resumed.receipt.applicationReceipt.journalCursor,
        restorePointReceiptDigest: resumed.receipt.applicationReceipt.updateDigest}, Date.now());
      advanceStopRestoreFence(deployment.storage as StorageContext, secondLookup, Date.now());
      const secondPrepared = await active!.prepareRestore(secondLookup);
      if (secondPrepared.kind !== "prepared") throw new Error("Second restore proposal is pending.");
      const secondResumed = await active!.completeRestore(secondLookup, secondPrepared.proposalDigest);
      if (secondResumed.kind !== "resumed") throw new Error("Second restore did not resume.");
      expect(secondResumed.receipt.binding.restoreFenceGeneration).toBe(resumed.receipt.binding.restoreFenceGeneration + 1);
      expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe("Hello");
      expect(await active!.completeRestore(lookup, prepared.proposalDigest)).toEqual(resumed);
      await restart();
      expect(await active!.completeRestore(lookup, prepared.proposalDigest)).toEqual(resumed);
      expect(await active!.completeRestore(secondLookup, secondPrepared.proposalDigest)).toEqual(secondResumed);
      expect(await active!.drain(document)).toMatchObject({kind: "done", terminalReceipt: secondResumed.receipt.applicationReceipt});
      results.push({recoveredRestore: resumed, repeatedRestore: secondResumed, nativeThenRelayAckLosses: 3});
    }
    expect(hash(readFileSync(executable))).toBe(expectedHash.toLowerCase());
    writeFileSync(join(root, "result.json"), JSON.stringify({ verdict: "PASS", executable, sha256: expectedHash, results }, null, 2));
  } finally {
    await active?.close();
    deployment.storage.close();
    doc.destroy();
  }
}, 90_000);
