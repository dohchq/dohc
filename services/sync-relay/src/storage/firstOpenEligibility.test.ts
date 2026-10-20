import {afterEach, expect, it, vi} from "vitest";
import {sha256Hex} from "@dohc/workspace-core/hash";
import {closeTestStorages, inspectDatabase, storagePath, testStorage} from "../testing";
import type {SyncRelayStorage} from "../storage";
import type {StorageContext} from "./context";
import type {SyncRelayLogInput} from "./types";
import {refuseOp} from "./relayAdmission";

afterEach(closeTestStorages);

const WS = "workspace-1", OTHER_WS = "workspace-2", OBJECT = "object-1", OTHER = "object-2";
const target = {workspaceId: WS, objectId: OBJECT};
const LINEAGE = "a".repeat(64), OTHER_LINEAGE = "c".repeat(64);
const TEXT = new TextEncoder().encode("ordinary text"), SHA = sha256Hex(TEXT);

const write = (objectId: string, path: string, versionId = "main") => ({momentId: `write-${objectId}-${path}`, objectId, versionId,
  operation: "write", path, payloadAfterPath: path, payloadAfterBlobSha256: SHA, payloadAfterByteLength: TEXT.byteLength, payloadAfterContentKind: "text", recordedAtMs: 1});
const remove = (objectId: string, path: string, versionId = "main") => ({momentId: `delete-${objectId}-${path}`, objectId, versionId,
  operation: "delete", path, beforePath: path, payloadBeforePath: path, payloadBeforeBlobSha256: SHA, payloadAfterPath: null, payloadAfterBlobSha256: null, recordedAtMs: 1});
const ydoc = (objectId: string, change: {path?: string; isBaseState?: boolean; versionId?: string; lineageClaimId?: string} = {}) => ({
  versionId: change.versionId ?? "main", objectId, path: change.path ?? "docs/a.md", contentKind: "richdoc", updateBlobSha256: SHA,
  isBaseState: change.isBaseState ?? false, lineageClaimId: change.lineageClaimId ?? LINEAGE});

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Two workspaces. The target object has only ordinary text history; every other object carries every kind of evidence. */
async function fixture() {
  const storage = await testStorage();
  // Each authority table is written alone, so foreign keys stay off on this connection.
  const raw = inspectDatabase(storagePath(storage));
  raw.exec("PRAGMA foreign_keys=OFF");
  const seqs = new Map<string, number>();
  const append = (workspaceId: string, opKind: string, payload: object, options: {originId?: string; admit?: (op: SyncRelayLogInput) => void} = {}) => {
    const originId = options.originId ?? "owner-device", key = `${workspaceId}/${originId}`, originSeq = seqs.get(key) ?? 0;
    seqs.set(key, originSeq + 1);
    const admit = options.admit;
    storage.appendLogBatch({workspaceId, originId, ops: [{originSeq, opKind, payloadJson: JSON.stringify(payload), recordedAtMs: 1}],
      ...(admit ? {admit: (ops: SyncRelayLogInput[]) => ops.forEach(admit)} : {})});
  };
  const liveDocument = (workspaceId: string, objectId: string, row: {lineage?: string; replaces?: string | null; path?: string; retired?: boolean} = {}) =>
    raw.prepare(`INSERT INTO sync_relay_live_documents VALUES (?,'main',?,?,?,?,1,?,1,?,?,?,?,0,0,?)`).run(workspaceId, objectId, row.lineage ?? LINEAGE,
      row.replaces ?? null, row.path ?? "docs/a.md", "b".repeat(64), row.lineage ?? LINEAGE, new Uint8Array([0, 0]),
      row.retired ? "retired" : "current", row.retired ? "closed" : "open", row.retired ? 5 : null);
  const ordinaryBase = (workspaceId: string, objectId: string) => raw.prepare(`INSERT INTO sync_relay_live_document_ordinary_bases
    VALUES (?,'main',?,?,1,'owner-device',0,'old-epoch','old-stream','docs/old.md',?,0,1)`).run(workspaceId, objectId, LINEAGE, "b".repeat(64));
  const activation = (workspaceId: string, objectId: string) => raw.prepare(`INSERT INTO sync_relay_service_activations
    VALUES ('namespace',?,?,'main',?,?,'{}','{}',?,?,'owner-1','share-1',NULL,1)`).run(`activation-${workspaceId}-${objectId}`, workspaceId, objectId, LINEAGE,
    "d".repeat(64), new Uint8Array([0, 0]));
  // Other objects' operations sit in an earlier namespace, so finding the target's must step past it.
  const restore = (workspaceId: string, objectId: string, namespace = "namespace-2") => raw.prepare(`INSERT INTO sync_relay_live_restore_operations(
    operation_id,relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,intent_json,basis_json,terminal_json,applied_json,
    native_receipt_json,phase,old_fence,new_fence,cutover_cursor,revoked_generation,invalidated_at_ms,fenced_at_ms,accounted_bytes)
    VALUES (?,?,?,'main',?,?,'{}','{}','{}','{}','{}','resumed',1,2,0,2,0,0,1)`).run(`restore-${workspaceId}-${objectId}`, namespace, workspaceId, objectId, LINEAGE);
  const reenroll = (workspaceId: string, identity: {replicationEpoch: string; streamIdentity: string}) => {
    expect(storage.rotateWorkspaceIdentity({workspaceId, ownerUserId: "owner-1", ...identity, rotatedAtMs: 2})).toBe("rotated");
    append(workspaceId, "moment.append", write(OBJECT, "docs/a.md"));
    expect(storage.getEpochLogFloor(workspaceId)).toBeGreaterThan(0);
  };

  for (const workspaceId of [WS, OTHER_WS]) {
    expect(storage.claimWorkspace({workspaceId, ownerUserId: "owner-1", createdAtMs: 0})).toBe("created");
    storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch-1", streamIdentity: "stream-1"});
    storage.putBlob({workspaceId, sha256: SHA, content: TEXT, createdAtMs: 0});
  }
  append(WS, "moment.append", write(OBJECT, "docs/a.md"));
  append(WS, "moment.append", write(OBJECT, "docs/a.md"));
  for (const [workspaceId, objectId] of [[WS, OTHER], [OTHER_WS, OBJECT]] as const) {
    append(workspaceId, "moment.append", write(objectId, "docs/a.md"));
    append(workspaceId, "ydoc.update", ydoc(objectId, {isBaseState: true}));
    append(workspaceId, "moment.append", remove(objectId, "docs/a.md"));
    liveDocument(workspaceId, objectId);
    ordinaryBase(workspaceId, objectId);
    activation(workspaceId, objectId);
    restore(workspaceId, objectId, "namespace-1");
  }
  return {storage, raw, append, liveDocument, ordinaryBase, activation, restore, reenroll};
}

const read = (storage: SyncRelayStorage) => storage.readFirstOpenEligibility(target);

it("lets a document with only ordinary text history open live, whatever other objects and workspaces hold", async () => {
  expect(read((await fixture()).storage)).toBe("eligible");
});

const departed = (op: SyncRelayLogInput) => { op.relayAdmission = "departed"; };
const priorAuthority: Array<[string, (f: Fixture) => void]> = [
  ["a historical base", f => f.append(WS, "ydoc.update", ydoc(OBJECT, {isBaseState: true}))],
  ["a delta", f => f.append(WS, "ydoc.update", ydoc(OBJECT))],
  ["a departed publication", f => f.append(WS, "ydoc.update", ydoc(OBJECT), {originId: "service-host:native", admit: departed})],
  ["a base below the epoch floor", f => { f.append(WS, "ydoc.update", ydoc(OBJECT, {isBaseState: true})); f.reenroll(WS, {replicationEpoch: "epoch-2", streamIdentity: "stream-2"}); }],
  ["a delta below the epoch floor", f => { f.append(WS, "ydoc.update", ydoc(OBJECT)); f.reenroll(WS, {replicationEpoch: "epoch-2", streamIdentity: "stream-2"}); }],
  ["a departed row below the epoch floor", f => {
    f.append(WS, "ydoc.update", ydoc(OBJECT), {originId: "service-host:native", admit: departed});
    f.reenroll(WS, {replicationEpoch: "epoch-2", streamIdentity: "stream-2"});
  }],
  ["a base from another stream", f => { f.append(WS, "ydoc.update", ydoc(OBJECT, {isBaseState: true})); f.reenroll(WS, {replicationEpoch: "epoch-1", streamIdentity: "stream-2"}); }],
  ["a delta at another path", f => f.append(WS, "ydoc.update", ydoc(OBJECT, {path: "docs/renamed.md"}))],
  ["a delta outside the shared folder", f => f.append(WS, "ydoc.update", ydoc(OBJECT, {path: "private/a.md"}))],
  ["a delta in another version", f => f.append(WS, "ydoc.update", ydoc(OBJECT, {versionId: "version-2"}))],
  ["a delta of another lineage", f => f.append(WS, "ydoc.update", ydoc(OBJECT, {lineageClaimId: OTHER_LINEAGE}))],
  ["a delta from another replication origin", f => f.append(WS, "ydoc.update", ydoc(OBJECT), {originId: "service-host:native"})],
  ["a retired baseline registration", f => f.liveDocument(WS, OBJECT, {retired: true, path: "docs/old.md"})],
  ["a retired successor baseline", f => f.liveDocument(WS, OBJECT, {lineage: OTHER_LINEAGE, replaces: LINEAGE, retired: true, path: "docs/old.md"})],
  ["a current baseline at another path", f => f.liveDocument(WS, OBJECT, {path: "docs/old.md"})],
  ["an ordinary activation basis from another identity", f => f.ordinaryBase(WS, OBJECT)],
  ["a retained service activation", f => f.activation(WS, OBJECT)],
  ["a completed Stop/restore operation", f => f.restore(WS, OBJECT)],
  ["a live document deleted and restored", f => {
    f.append(WS, "ydoc.update", ydoc(OBJECT, {isBaseState: true}));
    f.append(WS, "moment.append", remove(OBJECT, "docs/a.md"));
    f.append(WS, "moment.append", write(OBJECT, "docs/a.md"));
  }],
];
it.each(priorAuthority)("refuses a first live base after %s", async (_, add) => {
  const f = await fixture();
  add(f);
  expect(read(f.storage)).toBe("prior-authority");
});

const deletion: Array<[string, (f: Fixture) => void]> = [
  ["a deletion", f => f.append(WS, "moment.append", remove(OBJECT, "docs/a.md"))],
  ["a restore of a deleted document never opened live", f => {
    f.append(WS, "moment.append", remove(OBJECT, "docs/a.md"));
    f.append(WS, "moment.append", write(OBJECT, "docs/a.md"));
  }],
  ["a deletion below the epoch floor", f => {
    f.append(WS, "moment.append", remove(OBJECT, "docs/a.md"));
    f.reenroll(WS, {replicationEpoch: "epoch-2", streamIdentity: "stream-2"});
  }],
  ["a departed deletion", f => f.append(WS, "moment.append", remove(OBJECT, "docs/a.md"), {originId: "service-host:native", admit: departed})],
  ["a deletion at another path", f => f.append(WS, "moment.append", remove(OBJECT, "private/old.md"))],
  ["a deletion in another version", f => f.append(WS, "moment.append", remove(OBJECT, "docs/a.md", "version-2"))],
];
it.each(deletion)("refuses a first live base after %s", async (_, add) => {
  const f = await fixture();
  add(f);
  expect(read(f.storage)).toBe("deletion");
});

it("does not count relay refusals or refused settlements as history", async () => {
  const f = await fixture();
  f.append(WS, "ydoc.update", ydoc(OBJECT, {isBaseState: true}), {originId: "service-host:native",
    admit: op => refuseOp(op, {opKind: op.opKind, payloadSha256: sha256Hex(new TextEncoder().encode(op.payloadJson)), reason: "base-state-from-host"})});
  f.raw.prepare(`INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,settlement_admission_json)
    VALUES (?,'service-host:native',1,'moment.append',?,1,?)`).run(WS, JSON.stringify(remove(OBJECT, "docs/a.md")),
    JSON.stringify({status: "refused", settlementId: "settlement-1", reason: "authorship-mismatch"}));
  expect(f.raw.prepare("SELECT op_kind FROM sync_relay_log WHERE workspace_id=? AND origin_id='service-host:native' ORDER BY origin_seq").all(WS)
    .map(row => row.op_kind)).toEqual(["relay.refused", "moment.append"]);
  expect(read(f.storage)).toBe("eligible");
});

it("sees evidence committed after a preflight read when read again inside the relay writer", async () => {
  const f = await fixture();
  expect(read(f.storage)).toBe("eligible");
  f.liveDocument(WS, OBJECT, {retired: true});
  let admitted: string | undefined;
  f.append(WS, "moment.append", write(OBJECT, "docs/a.md"), {admit: () => { admitted = read(f.storage); }});
  expect(admitted).toBe("prior-authority");
});

it("reads every table through an existing index", async () => {
  const f = await fixture(), db = (f.storage as StorageContext).db;
  const prepare = vi.spyOn(db, "prepare");
  read(f.storage);
  const query = prepare.mock.calls[0]![0]; prepare.mockRestore();
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all().map(row => String(row.detail));
  expect(plan.filter(detail => /^SCAN (?!t\b|n\b|CONSTANT ROW)/.test(detail))).toEqual([]);
  for (const table of ["sync_relay_log", "sync_relay_live_documents", "sync_relay_live_document_ordinary_bases", "sync_relay_service_activations",
    "sync_relay_live_restore_operations"]) expect(plan.some(detail => detail.startsWith(`SEARCH ${table} USING`))).toBe(true);
});

it("refuses to answer for a workspace the relay holds no history for", async () => {
  const f = await fixture();
  expect(() => f.storage.readFirstOpenEligibility({workspaceId: "workspace-unknown", objectId: OBJECT})).toThrow("no history");
});
