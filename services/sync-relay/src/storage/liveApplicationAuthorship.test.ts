import {afterEach, expect, it, vi} from "vitest";
import {createHash} from "node:crypto";
import {registered, cleanupLiveDeliveryFixtures} from "../../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {canonicalVersionedAcceptedMetadata} from "../liveAcceptedHistory";
import {RestoreHistoryBudget} from "./liveAcceptedHistory";
import {initializeSyncRelaySchema} from "./schema";
import type {StorageContext} from "./context";
import type {NativeRestoreCancellationReceipt} from "../liveRestoreFence";
import {admitRetirementPublication} from "./serviceActivationPublication";
import {preparedLiveApplication} from "./liveApplicationAuthorship";
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
    sourceApplication: null, sourceRestore: null, cancelledRestores: [] as Array<{originAdoptionId: string | null; cancellation: NativeRestoreCancellationReceipt}>, contentCoordinate: {originId: "device", originSeq: 0}};
  const publish = async (edit: (value: typeof record) => void = () => {}, forgedCarrier = false, retirement = false) => {
    const value = structuredClone(record); edit(value);
    const bytes = Buffer.from(JSON.stringify(value)), digest = hash(bytes);
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 4 * 1024 * 1024) {
      const content = bytes.subarray(offset, offset + 4 * 1024 * 1024), sha256 = hash(content);
      f.storage.putBlob({workspaceId: "workspace", sha256, content, createdAtMs: 1});
      chunks.push({sha256, byteLength: content.length});
    }
    const raw = {originSeq: 2, opKind: "live.audit.application", recordedAtMs: 1,
      ...(forgedCarrier ? {admittedAuthorSnapshot: [{kind: "human", humanId: "forged", humanName: "Forged"}]} : {}),
      payload: {relayDatabaseNamespace: value.relayDatabaseNamespace, mainVersionId: value.metadata.accepted.binding.mainVersionId,
        objectId: value.metadata.accepted.binding.objectId, lineageClaimId: value.metadata.accepted.binding.lineageClaimId,
        eventCount: value.eventCount, manifest: {formatVersion: 1, recordDigest: digest, byteLength: bytes.byteLength, chunks}, updateBlobSha256: value.metadata.accepted.receipt.updateDigest}};
    const ops = await parseAuthenticatedLogOps([raw, {originSeq: 3, opKind: "opaque", payload: {}, recordedAtMs: 1}], "owner");
    const input = {workspaceId: "workspace", originId: "device", ops: inBatch ? [...contentOps, ...ops] : ops};
    await f.storage.prepareLogAppend(input);
    if (retirement) {
      const binding = metadata.accepted.binding, cursor = metadata.accepted.receipt.journalCursor;
      f.write(db => {
        db.prepare(`INSERT INTO sync_relay_service_activations
          (relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,
           source_json,binding_json,state_digest,state_bytes,owner_user_id,share_id,accounted_bytes)
          VALUES (?,'activation','workspace','main','object',?,'{}',?,?,?,'owner','share',1)`)
          .run(record.relayDatabaseNamespace, binding.lineageClaimId, JSON.stringify(binding), hash(new Uint8Array([0,0])), new Uint8Array([0,0]));
        db.prepare(`INSERT INTO sync_relay_live_delivery_hosts
          (host_id,workspace_id,funded_document_sequence,funded_journal_cursor,accounted_bytes) VALUES ('retiring','workspace',0,0,1)`).run();
        db.prepare(`INSERT INTO sync_relay_live_delivery_owners VALUES (?, 'workspace','main','object',?,'retiring',?, ?,?,0,0,1)`)
          .run(record.relayDatabaseNamespace, binding.lineageClaimId, JSON.stringify({adoptionId: "activation"}), JSON.stringify(metadata.accepted.receipt), cursor);
        expect.soft(preparedLiveApplication(ops[0]!)).toBe(cursor);
        expect(admitRetirementPublication(f.storage as StorageContext, {
          relayDatabaseNamespace: record.relayDatabaseNamespace, activationId: "activation", workspaceId: "workspace",
          mainVersionId: "main", objectId: "object", lineageClaimId: binding.lineageClaimId, path: binding.currentPath,
          restoreFenceGeneration: binding.restoreFenceGeneration, acceptedThrough: cursor, requestedAtMs: 2,
        }, ops[0]!, {originId: "device", ops: new Map(input.ops.map(op => [op.originSeq, op])), batched: true})).toBeNull();
      });
    }
    f.storage.appendLogBatch(input);
    expect(f.storage.maxOriginSeq("workspace", "device")).toBe(3);
    return f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "device", originSeq: 2});
  };
  return {...f, storage: f.storage as StorageContext, publish, record, prepare: (input: Parameters<typeof f.storage.prepareLogAppend>[0]) => f.storage.prepareLogAppend(input)};
}

function cancellations(record: ReturnType<typeof application>["record"], count: number, large = false) {
  const binding = {...record.metadata.accepted.binding,
    ...(large ? {selectorPaths: [...Array.from({length: 99}, (_, i) => `${String(i).padStart(2, "0")}${'"'.repeat(1022)}`), record.metadata.accepted.binding.currentPath].sort()} : {})};
  return Array.from({length: count}, (_, i) => ({originAdoptionId: null,
    cancellation: {fence: {operation: {point: {journalCursor: 0, receiptDigest: binding.lineageClaimId},
      operationId: `cancel-${i}`, relayDatabaseNamespace: record.relayDatabaseNamespace,
      oldBinding: {...binding, restoreFenceGeneration: i + 1}, hostId: "host", newFence: i + 2,
      origin: {kind: "bootstrap" as const, id: "bootstrap"}, terminal: null, appliedSequence: 0},
      localHeadSequence: 0, recordedAtMs: 1}, binding: {...binding, restoreFenceGeneration: i + 2},
      endpoint: {terminalReceipt: null, eventCount: 0, historyEvidenceDigest: "b".repeat(64)}, recordedAtMs: 2}}));
}

it.each([0, 1, 2])("prepares native cancellation history and admits retirement output (%s cancellations)", async count => {
  const f = application();
  try {
    const row = await f.publish(record => {
      record.cancelledRestores = cancellations(record, count, count === 2);
      if (count === 2) expect(Buffer.byteLength(JSON.stringify(record.cancelledRestores))).toBeGreaterThan(262_144);
    }, false, true);
    expect(row).toHaveProperty("admittedAuthorSnapshot");
    if (count === 2) {
      f.storage.db.prepare("DELETE FROM sync_relay_log WHERE workspace_id='workspace' AND origin_id='device' AND origin_seq>=2").run();
      expect(await f.publish(record => {record.cancelledRestores = cancellations(record, 4096);})).not.toHaveProperty("admittedAuthorSnapshot");
      const payload = JSON.parse(row!.payloadJson);
      payload.manifest.byteLength = Number(f.journalRows().journal[0]!.accepted_metadata_bytes) +
        4095 * (643_576 + Buffer.byteLength('{"originAdoptionId":"","cancellation":}') + 2 * 1024 + 1) + 32_768 + 1;
      payload.manifest.chunks = Array.from({length: Math.ceil(payload.manifest.byteLength / (4 * 1024 * 1024))}, (_, i) =>
        ({sha256: "0".repeat(64), byteLength: Math.min(4 * 1024 * 1024, payload.manifest.byteLength - i * 4 * 1024 * 1024)}));
      const op = {...row!, payloadJson: JSON.stringify(payload)};
      const reads = blobReads(f);
      try {
        await f.prepare({workspaceId: "workspace", originId: "device", ops: [op]});
        expect(preparedLiveApplication(op)).toBeNull();
        expect(reads.read().bytes).toBe(0);
      } finally {reads.spy.mockRestore();}
    }
  } finally {f.close();}
});

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
  const byteLength = Number(f.journalRows().journal[0]!.accepted_metadata_bytes) +
    4095 * (643_576 + Buffer.byteLength('{"originAdoptionId":"","cancellation":}') + 2 * 1024 + 1) + 32_768 + 1;
  const binding = f.record.metadata.accepted.binding;
  const payload = {relayDatabaseNamespace: f.record.relayDatabaseNamespace, mainVersionId: binding.mainVersionId,
    objectId: binding.objectId, lineageClaimId: binding.lineageClaimId, eventCount: f.record.eventCount,
    updateBlobSha256: f.record.metadata.accepted.receipt.updateDigest,
    manifest: {formatVersion: 1, recordDigest: digest, byteLength,
      chunks: Array.from({length: Math.ceil(byteLength / (4 * 1024 * 1024))}, (_, i) =>
        ({sha256: digest, byteLength: Math.min(4 * 1024 * 1024, byteLength - i * 4 * 1024 * 1024)}))}};
  const ops = await parseAuthenticatedLogOps(Array.from({length: 500}, (_, i) => ({originSeq: i + 2,
    opKind: "live.audit.application", payload, recordedAtMs: 1})), "owner");
  const reads = blobReads(f);
  try {
    const input = {workspaceId: "workspace", originId: "device", ops};
    await f.prepare(input);
    expect(f.storage.appendLogBatch(input).inserted).toBe(500);
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
    await f.prepare(input);
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

function largeJournal(f: ReturnType<typeof application>) {
  const table = "sync_relay_live_update_journal";
  const columns = f.storage.db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)).filter(name => name !== "journal_cursor");
  const values = columns.map(name => name === "delivery_id" || name === "accepted_event_count" ? "?" : name);
  const insert = f.storage.db.prepare(`INSERT INTO ${table} (${columns.join(",")}) SELECT ${values.join(",")} FROM ${table} WHERE journal_cursor=?`);
  const cursor = f.record.metadata.accepted.receipt.journalCursor;
  f.storage.tx(() => {for (let i = 0; i < 50_000; i++) insert.run(`retained-${i}`, i + 2, cursor);});
}

it("indexes a 500-audit push on a document with 50000 journal rows without reading the table", async () => {
  const f = application();
  try {
    largeJournal(f);
    const valid = (await f.publish())!;
    f.storage.db.prepare("DELETE FROM sync_relay_log WHERE workspace_id='workspace' AND origin_id='device' AND origin_seq>=2").run();
    const payload = JSON.parse(valid.payloadJson);
    const ops = Array.from({length: 500}, (_, i) => ({...valid, originSeq: i + 2,
      payloadJson: JSON.stringify({...payload, eventCount: i === 499 ? payload.eventCount : 50_002})}));
    const plans = new Map<boolean, string[]>();
    const prepare = f.storage.db.prepare.bind(f.storage.db);
    const spy = vi.spyOn(f.storage.db, "prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      if (!sql.includes("accepted_event_count=?") || !sql.includes("update_digest=?")) return statement;
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        const writer = (f.storage.db as typeof f.storage.db & {isTransaction: boolean}).isTransaction;
        if (!plans.has(writer)) {
          plans.set(writer, prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => String(row.detail)));
          // A deferred table cursor is harmless; no Column instruction may decode it.
          const bytecode = prepare(`EXPLAIN ${sql}`).all(...args);
          const root = prepare("SELECT rootpage FROM sqlite_schema WHERE name='sync_relay_live_update_journal'").get()!.rootpage;
          const tableCursors = bytecode.filter(row => row.opcode === "OpenRead" && row.p2 === root).map(row => row.p1);
          expect(bytecode.filter(row => row.opcode === "Column" && tableCursors.includes(row.p1))).toEqual([]);
        }
        return get(...args);
      };
      return statement;
    });
    try {
      const input = {workspaceId: "workspace", originId: "device", ops};
      await f.prepare(input);
      expect(f.storage.appendLogBatch(input).inserted).toBe(500);
      expect(plans.size).toBe(2);
      for (const plan of plans.values()) expect(plan.join(" ")).toContain("idx_sync_relay_live_application_authorship");
      expect(f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "device", originSeq: 501})).toHaveProperty("admittedAuthorSnapshot");
      expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "device", ops: [{originSeq: 502, opKind: "opaque", payloadJson: "{}", recordedAtMs: 1}]}).inserted).toBe(1);
      console.log("FIX4_PLANS", JSON.stringify([...plans]));
    } finally {spy.mockRestore();}
  } finally {f.close();}
}, 120_000);

it("yields between audit batches before taking the write lock", async () => {
  const f = application();
  try {
    const valid = (await f.publish())!;
    const ops = Array.from({length: 500}, (_, i) => ({...valid, originSeq: i + 2}));
    let progressed = false;
    const tick = new Promise<void>(resolve => setImmediate(() => {progressed = true; resolve();}));
    await f.prepare({workspaceId: "workspace", originId: "device", ops});
    expect(progressed).toBe(true);
    await tick;
  } finally {f.close();}
});

it("adds the covering index to an existing journal without rewriting rows and detects damage", () => {
  const f = application();
  try {
    const before = f.journalRows();
    f.storage.db.exec("DROP INDEX IF EXISTS idx_sync_relay_live_application_authorship");
    f.storage.db.prepare("DELETE FROM sync_relay_migrations WHERE migration_id='live-application-authorship-index-v1'").run();
    initializeSyncRelaySchema(f.storage.db);
    expect(f.journalRows()).toEqual(before);
    expect(f.storage.db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE name='idx_sync_relay_live_application_authorship'").get()?.present).toBe(1);
    initializeSyncRelaySchema(f.storage.db);
    f.storage.db.exec("DROP INDEX idx_sync_relay_live_application_authorship");
    expect(() => initializeSyncRelaySchema(f.storage.db)).toThrow("live application authorship index is missing or damaged");
  } finally {f.close();}
});

it("lets another request run between hashed 4 MiB chunks without entering the writer", async () => {
  const f = application();
  try {
    const bytes = Buffer.from(JSON.stringify({...f.record, padding: "x".repeat(6 * 1024 * 1024)}));
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 4 * 1024 * 1024) {
      const content = bytes.subarray(offset, offset + 4 * 1024 * 1024), sha256 = hash(content);
      f.storage.putBlob({workspaceId: "workspace", sha256, content, createdAtMs: 1});
      chunks.push({sha256, byteLength: content.length});
    }
    // Raise only the manifest reservation; the noncanonical record remains unconfirmed.
    f.storage.db.prepare("UPDATE sync_relay_live_update_journal SET accepted_metadata_bytes=? WHERE journal_cursor=?").run(bytes.length, f.record.metadata.accepted.receipt.journalCursor);
    const binding = f.record.metadata.accepted.binding;
    const ops = await parseAuthenticatedLogOps([{originSeq: 2, opKind: "live.audit.application", recordedAtMs: 1,
      payload: {relayDatabaseNamespace: f.record.relayDatabaseNamespace, mainVersionId: binding.mainVersionId,
        objectId: binding.objectId, lineageClaimId: binding.lineageClaimId, eventCount: f.record.eventCount,
        updateBlobSha256: f.record.metadata.accepted.receipt.updateDigest,
        manifest: {formatVersion: 1, recordDigest: hash(bytes), byteLength: bytes.length, chunks}}}], "owner");
    const reads = blobReads(f);
    let observed = 0;
    const tick = new Promise<void>(resolve => setImmediate(() => {observed = reads.read().bytes; resolve();}));
    try {
      const input = {workspaceId: "workspace", originId: "device", ops};
      await f.prepare(input);
      await tick;
      expect(observed).toBe(4 * 1024 * 1024);
      expect(reads.read()).toEqual({bytes: bytes.length, inWrite: false});
      expect(f.storage.appendLogBatch(input).inserted).toBe(1);
      expect(f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "device", originSeq: 2})).not.toHaveProperty("admittedAuthorSnapshot");
    } finally {reads.spy.mockRestore();}
  } finally {f.close();}
});

it("binds the prepared proof to the payload parsed before asynchronous work", async () => {
  const f = application();
  const charge = RestoreHistoryBudget.prototype.chargeBytes;
  try {
    const row = (await f.publish())!;
    f.storage.db.prepare("DELETE FROM sync_relay_log WHERE workspace_id='workspace' AND origin_id='device' AND origin_seq>=2").run();
    const op = {...row};
    const altered = JSON.parse(row.payloadJson);
    altered.manifest.recordDigest = "0".repeat(64);
    const input = {workspaceId: "workspace", originId: "device", ops: [op]};
    // This hook models an operation mutation after the payload was parsed.
    const spy = vi.spyOn(RestoreHistoryBudget.prototype, "chargeBytes").mockImplementation(function(this: RestoreHistoryBudget, value: number) {
      op.payloadJson = JSON.stringify(altered);
      return charge.call(this, value);
    });
    try {
      await f.prepare(input);
      expect(f.storage.appendLogBatch(input).inserted).toBe(1);
      expect(f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "device", originSeq: 2})).not.toHaveProperty("admittedAuthorSnapshot");
    } finally {spy.mockRestore();}
  } finally {f.close();}
});
