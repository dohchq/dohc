// Invoked by the native paired-backup test. Every database belongs to its scratch directory.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {copyFileSync, existsSync, readFileSync, renameSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {backup, DatabaseSync} from "node:sqlite";
import {parseAppPublicationCandidate, type AppCollectionCapability} from "@dohc/security-contract/app-publication";
import {initializeRelayDeployment, openRelayDeployment} from "../relayDeployment";
import type {StorageContext} from "../storage/context";
import type {AcceptAppCollectionInput} from "../storage/appCollections";

const root = resolve(process.argv[2]), phase = process.argv[3];
const configPath = join(root, "deployment.json"), relayPath = join(root, "volume", "relay.sqlite");
const continuityDirectory = join(root, "continuity");
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const limits = {maxFiles: 10, maxMetadataBytes: 16_384, maxBundleBytes: 4096};
const schema = "fields:\n  name:\n    type: text\n  destination:\n    type: select\n    options: [Tokyo, Manila]\n";
const capability: AppCollectionCapability = {kind: "collection-create", collectionPath: "responses",
  schemaSha256: hash(schema), allowedFields: ["destination", "name"], requiredFields: ["destination"], readFields: ["destination", "name"]};

function json(path: string) {return JSON.parse(readFileSync(join(root, path), "utf8"));}
function save(path: string, value: unknown) {writeFileSync(join(root, path), JSON.stringify(value));}
async function snapshot(name: string) {
  const db = new DatabaseSync(relayPath, {readOnly: true});
  try {await backup(db, join(root, name));} finally {db.close();}
}
function continuity() {
  const db = new DatabaseSync(join(continuityDirectory, "continuity.sqlite"), {readOnly: true});
  try {return {...db.prepare("SELECT * FROM continuity").get()!};} finally {db.close();}
}
function relayStamp(path = relayPath) {
  const db = new DatabaseSync(path, {readOnly: true});
  try {return db.prepare("SELECT stamp FROM sync_relay_continuity").get()!.stamp as number;} finally {db.close();}
}
function replaceVolume(snapshotName: string, preserveSuffix: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(relayPath + suffix)) renameSync(relayPath + suffix, relayPath + suffix + preserveSuffix);
  }
  copyFileSync(join(root, snapshotName), relayPath);
}
function inventory(storage: StorageContext) {
  const rows = (table: string) => storage.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({...row}));
  return {
    receipts: rows("sync_relay_app_collection_receipts"), mappings: rows("sync_relay_app_public_principals"),
    principals: rows("sync_relay_link_principals"), usage: rows("sync_relay_workspace_usage"),
    accepted: storage.db.prepare("SELECT * FROM sync_relay_log WHERE origin_id='relay:collection-create:g' ORDER BY origin_seq").all().map(row => ({...row})),
  };
}

if (phase === "prepare") {
  initializeRelayDeployment({configPath, relayPath, continuityDirectory});
  const {storage} = openRelayDeployment(configPath), context = storage as StorageContext;
  try {
    storage.claimWorkspace({workspaceId: "w", ownerUserId: "owner", createdAtMs: 1});
    storage.createShare({share: {shareId: "s", workspaceId: "w", granterUserId: "owner",
      selectorJson: JSON.stringify({paths: ["app", "responses"], versionId: null}), createdAtMs: 1},
    grant: {grantId: "g", shareId: "s", principalKind: "user", principalUserId: "reader", principalEmail: null,
      access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null}});
    context.tx(() => context.db.prepare("UPDATE sync_relay_share_grants SET principal_kind='link',principal_user_id=NULL WHERE grant_id='g'").run());
    storage.putBlob({workspaceId: "w", sha256: hash(schema), content: Buffer.from(schema), createdAtMs: 2});
    storage.appendLogBatch({workspaceId: "w", originId: "owner", ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 2,
      payloadJson: JSON.stringify({momentId: "schema", versionId: "main", objectId: "schema", path: "responses/collection.yaml",
        recordedAtMs: 2, operation: "write", beforePresent: "null", payloadBeforeBlobSha256: null, payloadBeforePath: null,
        payloadAfterBlobSha256: hash(schema), payloadAfterPath: "responses/collection.yaml", payloadAfterContentKind: "text",
        payloadAfterByteLength: Buffer.byteLength(schema), metadata: {origin: "api"}})}]});
    const script = Buffer.from("document.body.textContent='Trip poll'");
    const candidate = parseAppPublicationCandidate({versionId: "main", appRoot: "app", entryPath: "app/index.ts", packageMap: {},
      sourceRevision: "1".repeat(64), sourceDigest: "2".repeat(64), dependencyLockDigest: "3".repeat(64), bundleDigest: "4".repeat(64),
      buildDigest: "5".repeat(64), compilerIdentity: {recipe: "closed-esbuild", version: "0.28.1", binarySha256: "6".repeat(64)},
      inputs: [{path: "app/index.ts", sha256: "7".repeat(64), byteLength: 20}], dependencies: ["app/index.ts"],
      files: [{path: "bundle.js", sha256: hash(script), byteLength: script.byteLength, contentType: "text/javascript; charset=utf-8"}],
      capabilities: [capability]}, limits);
    const digest = (domain: string, value: unknown) => hash(JSON.stringify([domain, value]));
    candidate.sourceDigest = digest("dohc-app-source-v2", {entry: candidate.entryPath, files: candidate.inputs, packages: []});
    candidate.dependencyLockDigest = digest("dohc-app-dependencies-v1", candidate.inputs);
    candidate.bundleDigest = digest("dohc-app-bundle-v1", candidate.files);
    candidate.buildDigest = digest("dohc-app-build-v1", {sourceDigest: candidate.sourceDigest,
      dependencyLockDigest: candidate.dependencyLockDigest, compiler: candidate.compilerIdentity, bundleDigest: candidate.bundleDigest});
    const publication = storage.publishAppPublication({workspaceId: "w", shareId: "s", grantId: "g", generation: 1,
      ownerUserId: "owner", candidate, blobs: [{sha256: hash(script), bytes: script}], limits, nowMs: 10});
    storage.approveAppCollection({workspaceId: "w", publicationId: publication.publicationId, ownerUserId: "owner", limits,
      expectedAuthorityRevision: 1, capability});
    storage.mintLinkSession({session: {sessionId: "session", capabilityHash: "session-hash", grantId: "g", generation: 1,
      mintedAtMs: 2, expiresAtMs: 10_000}});
    const input: AcceptAppCollectionInput = {publicationId: publication.publicationId, capabilityHash: "session-hash",
      profileTokenHash: "profile-hash", nowMs: 20, limits, expectedAuthorityRevision: 2, idempotencyKey: "vote-1",
      fields: {destination: "Tokyo", name: "Ice"}};
    await snapshot("before-acceptance.sqlite");
    const receipt = storage.acceptAppCollection(input, {maxCreatesPerGrant: 1});
    const envelopes = storage.fetchLogPage({workspaceId: "w", sinceRelaySeq: 0, limit: 10}).rows
      .filter(row => row.opKind === "moment.append").map(row => {
        const payload = JSON.parse(row.payloadJson);
        return {workspaceId: "w", originId: row.originId, originSeq: row.originSeq, relaySeq: row.relaySeq,
          opKind: row.opKind, recordedAtMs: row.recordedAtMs, payload,
          text: Buffer.from(storage.getBlob("w", payload.payloadAfterBlobSha256)!).toString("utf8")};
      });
    assert.equal(envelopes.length, 2);
    assert.equal(envelopes[1].payload.momentId, receipt.momentId);
    await snapshot("accepted.sqlite");
    const ownerSelection = storage.readOwnerAppCollectionAcceptances({workspaceId: "w", ownerUserId: "owner", grantId: "g", limit: 100});
    assert.equal(ownerSelection.acceptances.length, 1);
    save("fixture.json", {input, receipt, envelopes, ownerSelection, inventory: inventory(context), continuity: continuity()});
  } finally {storage.close();}
} else if (phase === "verify") {
  const f = json("fixture.json"), native = json("native-restored.json");
  const accepted = f.envelopes[1];
  assert.deepEqual(native, {momentId: f.receipt.momentId, objectId: f.receipt.objectId,
    text: accepted.text, author: accepted.payload.author, importedCount: 1, momentCount: 1});
  replaceVolume("accepted.sqlite", ".original");
  const {storage} = openRelayDeployment(configPath);
  try {
    assert.deepEqual(inventory(storage as StorageContext), f.inventory);
    assert.deepEqual(storage.acceptAppCollection(f.input, {maxCreatesPerGrant: 1}), f.receipt);
    assert.throws(() => storage.acceptAppCollection({...f.input, idempotencyKey: "new"}, {maxCreatesPerGrant: 1}), /quota/);
    assert.deepEqual(inventory(storage as StorageContext), f.inventory);
    assert.equal(storage.readAppCollection({...f.input, limit: 10}).records.length, 1);
    assert.deepEqual(continuity(), f.continuity);
  } finally {storage.close();}
  // The native backup retains acceptance, while this relay snapshot predates it.
  // Reactivation must fail against the unchanged, independently retained clock.
  replaceVolume("before-acceptance.sqlite", ".paired");
  const staleBytes = hash(readFileSync(relayPath));
  assert.ok(relayStamp() < Number(continuity().expected_stamp));
  assert.throws(() => openRelayDeployment(configPath), /continuity/);
  assert.equal(hash(readFileSync(relayPath)), staleBytes);
  assert.deepEqual(continuity(), f.continuity);
  save("verified.json", {pairedRestored: true, divergentRelayRefused: true, continuityUnchanged: true});
} else if (phase === "owner-deleted" || phase === "owner-restored") {
  const f = json("fixture.json"), native = json(`${phase}.json`);
  const {storage} = openRelayDeployment(configPath);
  try {
    // These are the engine's actual journal coordinates and payloads, including Y.Doc updates.
    for (const blob of native.blobs) {
      assert.equal(hash(blob.text), blob.sha256);
      storage.putBlob({workspaceId: "w", sha256: blob.sha256, content: Buffer.from(blob.text), createdAtMs: 30});
    }
    storage.appendLogBatch({workspaceId: "w", originId: "owner-device", ops: native.ops});
    const moments = native.ops.filter((op: {opKind: string}) => op.opKind === "moment.append")
      .map((op: {payloadJson: string}) => JSON.parse(op.payloadJson))
      .filter((moment: {objectId: string}) => moment.objectId === f.receipt.objectId);
    assert.ok(moments.some((moment: {operation: string; metadata: {origin: string}}) =>
      moment.operation === "write" && moment.metadata.origin === "local-file"), "native adoption entered relay");
    const deletion = moments.find((moment: {operation: string}) => moment.operation === "delete");
    assert.equal(deletion.momentId, native.deleteMomentId);
    assert.equal(deletion.metadata.correlationId, native.requestId);
    assert.deepEqual(storage.readOwnerAppCollectionAcceptances({workspaceId: "w", ownerUserId: "owner", grantId: "g", limit: 100}), f.ownerSelection);
    const beforeRetry = inventory(storage as StorageContext);
    assert.deepEqual(storage.acceptAppCollection(f.input, {maxCreatesPerGrant: 1}), f.receipt);
    assert.throws(() => storage.acceptAppCollection({...f.input, idempotencyKey: "new"}, {maxCreatesPerGrant: 1}), /quota/);
    assert.deepEqual(inventory(storage as StorageContext), beforeRetry);
    const records = storage.readAppCollection({...f.input, limit: 10}).records;
    assert.equal(records.length, phase === "owner-deleted" ? 0 : 1);
    save(`${phase}-verified.json`, {nativeJournalApplied: true, retryPreserved: true, visibleRecords: records.length});
  } finally {storage.close();}
} else {
  throw new Error("Expected prepare or verify recovery phase.");
}
