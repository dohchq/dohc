import {afterEach, expect, it, vi} from "vitest";
import {createHash} from "node:crypto";
import {registered, cleanupLiveDeliveryFixtures} from "../../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {canonicalVersionedAcceptedMetadata} from "../liveAcceptedHistory";
import {RestoreHistoryBudget} from "./liveAcceptedHistory";
import type {StorageContext} from "./context";
import {parseAuthenticatedLogOps} from "../relayLogInputs";

afterEach(cleanupLiveDeliveryFixtures);
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

function application(inBatch = false) {
  const f = registered({deployment: true});
  const captured = f.capture(f.update(), "recipient-edit", {kind: "named", userId: "reader", grantId: "grant"});
  const admitted = f.storage.commitLiveUpdateJournal({...captured, trustedAccount: {accountId: "reader", name: "Reader"},
    metadata: {...captured.metadata, authorContext: {kind: "account", accountId: "reader"}}});
  expect(admitted.result.kind).toBe("accepted");
  const metadata = canonicalVersionedAcceptedMetadata(admitted.admitted!.metadata);
  const row = f.journalRows().journal[0]!;
  const content = {versionId: "main", objectId: "object", path: metadata.accepted.binding.currentPath,
    lineageClaimId: metadata.accepted.binding.lineageClaimId, contentKind: "richdoc", updateBlobSha256: metadata.accepted.receipt.updateDigest};
  f.storage.putBlob({workspaceId: "workspace", sha256: content.updateBlobSha256, content: captured.updateBytes, createdAtMs: 1});
  const contentOps = [
    {originSeq: 0, opKind: "ydoc.update", payloadJson: JSON.stringify(content), recordedAtMs: 1},
    {originSeq: 1, opKind: "ydoc.update", payloadJson: JSON.stringify({...content, path: "other.md"}), recordedAtMs: 1},
  ];
  if (!inBatch) f.storage.appendLogBatch({workspaceId: "workspace", originId: "device", ops: contentOps});
  const record = {kind: "application", relayDatabaseNamespace: String(row.relay_database_namespace), eventCount: Number(row.accepted_event_count),
    evidenceDigest: String(row.accepted_evidence_digest), updateByteLength: captured.updateBytes.byteLength, metadata,
    sourceApplication: null, sourceRestore: null, contentCoordinate: {originId: "device", originSeq: 0}};
  const publish = async (edit: (value: typeof record) => void = () => {}, forgedCarrier = false) => {
    const value = structuredClone(record); edit(value);
    const bytes = Buffer.from(JSON.stringify(value)), digest = hash(bytes);
    f.storage.putBlob({workspaceId: "workspace", sha256: digest, content: bytes, createdAtMs: 1});
    const raw = {originSeq: 2, opKind: "live.audit.application", recordedAtMs: 1,
      ...(forgedCarrier ? {admittedAuthorSnapshot: [{kind: "human", humanId: "forged", humanName: "Forged"}]} : {}),
      payload: {relayDatabaseNamespace: value.relayDatabaseNamespace, mainVersionId: value.metadata.accepted.binding.mainVersionId,
        objectId: value.metadata.accepted.binding.objectId, lineageClaimId: value.metadata.accepted.binding.lineageClaimId,
        eventCount: value.eventCount, manifest: {formatVersion: 1, recordDigest: digest, byteLength: bytes.byteLength,
          chunks: [{sha256: digest, byteLength: bytes.byteLength}]}, updateBlobSha256: value.metadata.accepted.receipt.updateDigest}};
    const ops = await parseAuthenticatedLogOps([raw, {originSeq: 3, opKind: "opaque", payload: {}, recordedAtMs: 1}], "owner");
    f.storage.appendLogBatch({workspaceId: "workspace", originId: "device", ops: inBatch ? [...contentOps, ...ops] : ops});
    expect(f.storage.maxOriginSeq("workspace", "device")).toBe(3);
    return f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "device", originSeq: 2});
  };
  return {...f, storage: f.storage as StorageContext, publish, record};
}

it("confirms an audit application only with the relay journal snapshot", async () => {
  const f = application();
  try {
    expect(await f.publish()).toMatchObject({admittedAuthorSnapshot: [{kind: "human", humanId: "reader", humanName: "Reader"}]});
  } finally {f.close();}
});

it("confirms content earlier in the same batch and retains confirmation on retry", async () => {
  const f = application(true);
  try {
    const first = await f.publish();
    expect(first).toHaveProperty("admittedAuthorSnapshot");
    expect(await f.publish()).toEqual(first);
  } finally {f.close();}
});

it.each(["person", "document", "coordinate", "unknown", "marker", "cursor", "evidence", "namespace", "future-coordinate"] as const)("keeps the log flowing without confirming a %s mismatch", async (mismatch) => {
  const f = application();
  try {
    const op = await f.publish(record => {
      if (mismatch === "person") Object.assign(record.metadata, {authorSnapshot: [{kind: "human", humanId: "forged", humanName: "Forged"}]});
      if (mismatch === "document") Object.assign(record.metadata.accepted.binding, {objectId: "other"});
      if (mismatch === "coordinate") record.contentCoordinate.originSeq = 1;
      if (mismatch === "unknown") Object.assign(record.metadata.accepted.receipt, {deliveryId: "unknown"});
      if (mismatch === "marker") Object.assign(record.metadata.authorSnapshot![0]!, {relayConfirmed: true});
      if (mismatch === "cursor") Object.assign(record.metadata.accepted.receipt, {journalCursor: 999});
      if (mismatch === "evidence") record.evidenceDigest = "0".repeat(64);
      if (mismatch === "namespace") record.relayDatabaseNamespace = "another-relay";
      if (mismatch === "future-coordinate") record.contentCoordinate.originSeq = 3;
    }, true);
    expect(op).not.toHaveProperty("admittedAuthorSnapshot");
  } finally {f.close();}
});

function blobReads(f: ReturnType<typeof application>) {
  let bytes = 0;
  let inWrite = false;
  const prepare = f.storage.db.prepare.bind(f.storage.db);
  const spy = vi.spyOn(f.storage.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (!sql.includes("SELECT content FROM sync_relay_blobs")) return statement;
    const get = statement.get.bind(statement);
    statement.get = (...args) => {
      inWrite ||= (f.storage.db as typeof f.storage.db & {isTransaction: boolean}).isTransaction;
      const row = get(...args);
      if (row?.content instanceof Uint8Array) bytes += row.content.byteLength;
      return row;
    };
    return statement;
  });
  return {spy, read: () => ({bytes, inWrite})};
}

it("does not read blobs for a payload with no matching journal row", async () => {
  const f = application(); const reads = blobReads(f);
  try {
    await f.publish(record => {record.eventCount = 999;});
    expect(reads.read().bytes).toBe(0);
  } finally {reads.spy.mockRestore(); f.close();}
});

it("reads confirmed audit blobs outside the write transaction", async () => {
  const f = application(); const reads = blobReads(f);
  try {
    expect(await f.publish()).toHaveProperty("admittedAuthorSnapshot");
    expect(reads.read().bytes).toBeGreaterThan(0);
    expect(reads.read().inWrite).toBe(false);
  } finally {reads.spy.mockRestore(); f.close();}
});

it("bounds a 500-op push referencing one oversized audit and keeps later operations flowing", async () => {
  const f = application();
  const bytes = Buffer.from(JSON.stringify({...f.record, padding: "x".repeat(128 * 1024)}));
  const digest = hash(bytes);
  f.storage.putBlob({workspaceId: "workspace", sha256: digest, content: bytes, createdAtMs: 1});
  const binding = f.record.metadata.accepted.binding;
  const payload = {relayDatabaseNamespace: f.record.relayDatabaseNamespace, mainVersionId: binding.mainVersionId,
    objectId: binding.objectId, lineageClaimId: binding.lineageClaimId, eventCount: f.record.eventCount,
    updateBlobSha256: f.record.metadata.accepted.receipt.updateDigest,
    manifest: {formatVersion: 1, recordDigest: digest, byteLength: bytes.length, chunks: [{sha256: digest, byteLength: bytes.length}]}};
  const ops = await parseAuthenticatedLogOps(Array.from({length: 500}, (_, i) => ({originSeq: i + 2,
    opKind: "live.audit.application", payload, recordedAtMs: 1})), "owner");
  const reads = blobReads(f);
  try {
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "device", ops}).inserted).toBe(500);
    expect(reads.read()).toEqual({bytes: 0, inWrite: false});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "device", ops: [
      {originSeq: 502, opKind: "opaque", payloadJson: "{}", recordedAtMs: 1}]}).inserted).toBe(1);
    expect(f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "device", originSeq: 501}))
      .not.toHaveProperty("admittedAuthorSnapshot");
  } finally {reads.spy.mockRestore(); f.close();}
});

it("shares one exhausted byte budget while still storing the whole audit push", async () => {
  const f = application();
  const row = (await f.publish())!;
  f.storage.db.prepare("DELETE FROM sync_relay_log WHERE workspace_id='workspace' AND origin_id='device' AND origin_seq>=2").run();
  const ops = Array.from({length: 20}, (_, i) => ({...row, originSeq: i + 2}));
  const input = {workspaceId: "workspace", originId: "device", ops};
  const reads = blobReads(f);
  const limit = JSON.parse(row.payloadJson).manifest.byteLength + 8192;
  const budgets = new Set<RestoreHistoryBudget>();
  const charge = RestoreHistoryBudget.prototype.chargeBytes;
  // Lower the production budget for this push, without changing its append path.
  const chargeSpy = vi.spyOn(RestoreHistoryBudget.prototype, "chargeBytes").mockImplementation(function(this: RestoreHistoryBudget, value: number) {
    budgets.add(this);
    this.bytes = Math.min(this.bytes, limit);
    return charge.call(this, value);
  });
  try {
    expect(f.storage.appendLogBatch(input).inserted).toBe(20);
    expect(budgets.size).toBe(1);
    expect(reads.read().bytes).toBeLessThanOrEqual(limit);
    expect(reads.read().inWrite).toBe(false);
    expect(f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "device", originSeq: 21}))
      .not.toHaveProperty("admittedAuthorSnapshot");
  } finally {chargeSpy.mockRestore(); reads.spy.mockRestore(); f.close();}
});

it("does not confirm alternate record key order or extra record fields", async () => {
  for (const extra of [false, true]) {
    const f = application();
    try {
      const row = await f.publish(record => {
        if (extra) Object.assign(record, {extra: "unknown"});
        else {const kind = record.kind; delete (record as Partial<typeof record>).kind; record.kind = kind;}
      });
      expect(row).not.toHaveProperty("admittedAuthorSnapshot");
    } finally {f.close();}
  }
});
