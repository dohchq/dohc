import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { yDocToMarkdown, markdownToYDoc } from "./import-export.js";
import { createLiveMarkdownRegistrationValidator, createLiveMarkdownJournalValidator } from "./liveDocumentValidation.js";
import { createEngineClient } from "../../workspace-engine-client/src/daemon/engineClient.js";
import { initializeRelayDeployment, openRelayDeployment } from "../../../services/sync-relay/src/relayDeployment.js";
import { startServiceLiveHost } from "../../../services/sync-relay/src/serviceLiveHost.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// Test inputs, not a release policy.
const policy = { maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000,
  maxDecodedPayloadByteVisits: 100_000_000, maxStructClientGroupVisits: 1_000_000,
  maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000 };

it("bootstraps and applies through a configured production daemon, then recovers both owners", async () => {
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
    ingress: { aggregateBytes: 400_000_000, applicationWorkingReserveBytes: 1_000_000, maxUploads: 2, uploadDeadlineMs: 30_000 },
    client: { aggregateBytes: 200_000_000, maxUploads: 2, connectTimeoutMs: 30_000, requestDeadlineMs: 30_000 } }));
  const doc = markdownToYDoc("Hello");
  let active: Awaited<ReturnType<typeof startServiceLiveHost>> | undefined;
  const results: unknown[] = [];
  try {
    const { storage } = deployment;
    expect(storage.claimWorkspace({ workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1 })).toBe("created");
    expect(storage.provisionLiveHostControl({ mode: "service", hostId: "service", updatedAtMs: 1, guard: storage.captureStanding() }).ok).toBe(true);
    active = await startServiceLiveHost({ configPath: serviceConfig, ...deployment });
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
    const firstSettlement = await active.settle(document);
    expect(firstSettlement.materialized).toBe(true);
    expect(readFileSync(join(workspace,"docs/a.md"),"utf8")).toBe(yDocToMarkdown(doc));
    results.push({ round: 1, coordinate: active.coordinate, result: first, settlement: firstSettlement });
    await active.close(); active = undefined;
    deployment.storage.close();
    deployment = openRelayDeployment(deploymentConfig);
    active = await startServiceLiveHost({ configPath: serviceConfig, ...deployment });
    const second = await active.drain(document);
    expect(second).toEqual(first);
    expect(await active.settle(document)).toEqual(firstSettlement);
    results.push({ round: 2, coordinate: active.coordinate, result: second });
    const secondDigest = admit("after-restart");
    const continued = await active.drain(document);
    expect(continued).toMatchObject({ kind: "done", terminalReceipt: { deliveryId: "after-restart", updateDigest: secondDigest } });
    const continuedSettlement = await active.settle(document);
    expect(continuedSettlement).toMatchObject({ previousCursor: 1, terminalCursor: 2, applicationCount: 1, materialized: true });
    expect(readFileSync(join(workspace,"docs/a.md"),"utf8")).toBe(yDocToMarkdown(doc));
    results.push({ round: 2, continued, settlement: continuedSettlement });
    await active.close(); active = undefined;
    const engine = new DatabaseSync(join(workspace, ".dohc", "engine", "engine.db"), { readOnly: true });
    try {
      const applications = engine.prepare("SELECT delivery_id, update_digest FROM live_device_update_applications ORDER BY journal_cursor").all();
      expect(applications).toEqual([{ delivery_id: "delivery", update_digest: firstDigest }, { delivery_id: "after-restart", update_digest: secondDigest }]);
      expect(engine.prepare("SELECT COUNT(*) AS count FROM live_device_bootstraps").get()!.count).toBe(1);
      expect(engine.prepare("SELECT text FROM engine_search_files_fts WHERE object_id='object'").get()!.text).toBe(yDocToMarkdown(doc));
      expect(engine.prepare("SELECT COUNT(*) AS count FROM live_device_settlements").get()!.count).toBe(2);
      results.push({ applications });
    } finally { engine.close(); }
    expect(hash(readFileSync(executable))).toBe(expectedHash.toLowerCase());
    writeFileSync(join(root, "result.json"), JSON.stringify({ verdict: "PASS", executable, sha256: expectedHash, results }, null, 2));
  } finally {
    await active?.close();
    deployment.storage.close();
    doc.destroy();
  }
}, 90_000);
