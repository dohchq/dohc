import {afterEach, expect, it, vi} from "vitest";
import {existsSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {sha256Hex} from "@dohc/workspace-core/hash";
import {closeTestStorage, closeTestStorages, inspectDatabase, reopenTestStorage, storagePath, tempRoot, testStorage} from "../testing";
import {accountDeletionIdentity} from "@dohc/workspace-auth/accountDeletion";
import {createLiveValidationExecutor, liveValidation} from "../liveValidation";
import {fenceAccount, initializeAccountDeletion} from "./accountDeletion";
import type {StorageContext} from "./context";
import type {SyncRelayLogInput} from "./types";
import {refuseOp} from "./relayAdmission";
import {appendLogBatchInTransaction} from "./log";
import {putBlobInTransaction} from "./blobs";
import {readFirstOpenHistory, readFirstOpenHistoryFile, type FirstOpenHistory, type FirstOpenHistoryRead, type FirstOpenHistoryReader,
  type FirstOpenSource} from "./firstOpenHistory";
import {firstOpenOrigin, writeFirstOpen, type FirstOpenProof, type FirstOpenPublication} from "./firstOpenEligibility";

const pools: ReturnType<typeof createLiveValidationExecutor>[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  await closeTestStorages();
});

const WS = "workspace-1", OTHER_WS = "workspace-2", OBJECT = "object-1", OTHER = "object-2";
const LINEAGE = "a".repeat(64), OTHER_LINEAGE = "c".repeat(64);
const TEXT = new TextEncoder().encode("ordinary text"), SHA = sha256Hex(TEXT);
const SOURCE = {workspaceId: WS, objectId: OBJECT, path: "docs/a.md", sourceMomentId: `write-${OBJECT}-docs/a.md`, sourceDigest: SHA, sourceByteLength: TEXT.byteLength};
// Storage commits these bytes as given; the route builds real ones.
const BASE = {namespace: "namespace-test", bytes: new Uint8Array([1, 2, 3]), sha256: sha256Hex(new Uint8Array([1, 2, 3])), recordedAtMs: 1};

const write = (objectId: string, path: string, versionId = "main") => ({momentId: `write-${objectId}-${path}`, objectId, versionId,
  operation: "write", path, payloadAfterPath: path, payloadAfterBlobSha256: SHA, payloadAfterByteLength: TEXT.byteLength, payloadAfterContentKind: "text", recordedAtMs: 1});
const remove = (objectId: string, path: string, versionId = "main") => ({momentId: `delete-${objectId}-${path}`, objectId, versionId,
  operation: "delete", path, beforePath: path, payloadBeforePath: path, payloadBeforeBlobSha256: SHA, payloadAfterPath: null, payloadAfterBlobSha256: null, recordedAtMs: 1});
const ydoc = (objectId: string, change: {path?: string; isBaseState?: boolean; versionId?: string; lineageClaimId?: string} = {}) => ({
  versionId: change.versionId ?? "main", objectId, path: change.path ?? "docs/a.md", contentKind: "richdoc", updateBlobSha256: SHA,
  isBaseState: change.isBaseState ?? false, lineageClaimId: change.lineageClaimId ?? LINEAGE});
/** A write of `objectId` at the path `displaced` held, as a conflict resolution records it, without its conflict. */
const replace = (displaced: string, objectId: string, versionId = "main", path = "docs/a.md") => ({...write(objectId, path, versionId),
  momentId: `replace-${displaced}-${objectId}`, beforePresent: "present", beforeObjectId: displaced, beforeVersionId: versionId, beforePath: path,
  payloadBeforePath: path, payloadBeforeBlobSha256: SHA});
const binding = (objectId: string) => ({workspaceId: WS, objectId, mainVersionId: "main", currentPath: "docs/a.md"});
const audits = (objectId: string): Array<[string, object]> => [
  ["live.audit.base", {record: {checkpoint: {binding: binding(objectId)}}}],
  ["live.audit.application", {objectId, mainVersionId: "main", updateBlobSha256: SHA}],
  ["live.audit.settlement", {record: {binding: binding(objectId)}}],
];

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Two workspaces. The target object has only ordinary text history; every other object carries every kind of evidence. */
async function fixture({defaultReader = false} = {}) {
  // Storage reads history through the reader the test last chose, `local` until it chooses another.
  let reader: FirstOpenHistoryReader = local;
  const storage = await testStorage(defaultReader ? {} : {firstOpenHistory: (request, signal) => reader(request, signal)});
  const readWith = (next: FirstOpenHistoryReader) => { reader = next; };
  // Each authority table is written alone, so foreign keys stay off on this connection.
  const raw = inspectDatabase(storagePath(storage));
  raw.exec("PRAGMA foreign_keys=OFF");
  const seqs = new Map<string, number>();
  const append = (workspaceId: string, opKind: string, payload: object,
    options: {originId?: string; recordedAtMs?: number; admit?: (op: SyncRelayLogInput) => void} = {}) => {
    const originId = options.originId ?? "owner-device", key = `${workspaceId}/${originId}`, originSeq = seqs.get(key) ?? 0;
    seqs.set(key, originSeq + 1);
    const admit = options.admit;
    storage.appendLogBatch({workspaceId, originId, ops: [{originSeq, opKind, payloadJson: JSON.stringify(payload), recordedAtMs: options.recordedAtMs ?? 1}],
      ...(admit ? {admit: (ops: SyncRelayLogInput[]) => ops.forEach(admit)} : {})});
  };
  // A row as stored, for shapes append would check further: audits, settlement refusals and departed rows.
  let rawSeq = 0;
  const stored = (workspaceId: string, opKind: string, payload: object, columns: {relayAdmission?: "departed"; settlement?: "refused"} = {}) =>
    raw.prepare(`INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_admission,settlement_admission_json)
      VALUES (?,'service-host:stored',?,?,?,1,?,?)`).run(workspaceId, rawSeq++, opKind, JSON.stringify(payload), columns.relayAdmission ?? null,
      columns.settlement ? JSON.stringify({status: "refused", settlementId: "settlement-1", reason: "authorship-mismatch"}) : null);
  const liveDocument = (workspaceId: string, objectId: string, row: {lineage?: string; replaces?: string | null; path?: string; retired?: boolean} = {}) =>
    raw.prepare(`INSERT INTO sync_relay_live_documents VALUES (?,'main',?,?,?,?,1,?,1,?,?,?,?,0,0,?)`).run(workspaceId, objectId, row.lineage ?? LINEAGE,
      row.replaces ?? null, row.path ?? "docs/a.md", "b".repeat(64), row.lineage ?? LINEAGE, new Uint8Array([0, 0]),
      row.retired ? "retired" : "current", row.retired ? "closed" : "open", row.retired ? 5 : null);
  const ordinaryBase = (workspaceId: string, objectId: string) => raw.prepare(`INSERT INTO sync_relay_live_document_ordinary_bases
    VALUES (?,'main',?,?,1,'owner-device',0,'old-epoch','old-stream','docs/old.md',?,0,1)`).run(workspaceId, objectId, LINEAGE, "b".repeat(64));
  const activation = (workspaceId: string, objectId: string) => raw.prepare(`INSERT INTO sync_relay_service_activations
    VALUES ('namespace',?,?,'main',?,?,'{}','{}',?,?,'owner-1','share-1',NULL,1)`).run(`activation-${workspaceId}-${objectId}`, workspaceId, objectId, LINEAGE,
    "d".repeat(64), new Uint8Array([0, 0]));
  // Other objects' operations sit in namespace-1, so finding the target's must step past it.
  const restore = (workspaceId: string, objectId: string, namespace = "namespace-2") => raw.prepare(`INSERT INTO sync_relay_live_restore_operations(
    operation_id,relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,intent_json,basis_json,terminal_json,applied_json,
    native_receipt_json,phase,old_fence,new_fence,cutover_cursor,revoked_generation,invalidated_at_ms,fenced_at_ms,accounted_bytes)
    VALUES (?,?,?,'main',?,?,'{}','{}','{}','{}','{}','resumed',1,2,0,2,0,0,1)`).run(`restore-${workspaceId}-${objectId}-${namespace}`, namespace, workspaceId, objectId, LINEAGE);
  const reenroll = (workspaceId: string, identity: {replicationEpoch: string; streamIdentity: string}) => {
    expect(storage.rotateWorkspaceIdentity({workspaceId, ownerUserId: "owner-1", ...identity, rotatedAtMs: 2})).toBe("rotated");
    append(workspaceId, "moment.append", write(OBJECT, "docs/a.md"));
    expect(storage.getEpochLogFloor(workspaceId)).toBeGreaterThan(0);
  };
  // A first-open publication, its append's guard, and how many first-open rows the log holds.
  const guard = vi.fn();
  const writeBase = (proof: FirstOpenProof) => storage.writeFirstOpen(proof, BASE, guard);
  const published = () => Number(raw.prepare("SELECT count(*) AS n FROM sync_relay_log WHERE origin_id LIKE 'service-host:first-open:%'").get()!.n);

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
    append(workspaceId, "moment.append", replace(objectId, "object-3"));
    for (const [opKind, payload] of audits(objectId)) stored(workspaceId, opKind, payload);
    liveDocument(workspaceId, objectId);
    ordinaryBase(workspaceId, objectId);
    activation(workspaceId, objectId);
    restore(workspaceId, objectId, "namespace-1");
  }
  return {storage, raw, append, stored, liveDocument, ordinaryBase, activation, restore, reenroll, guard, write: writeBase, published, readWith};
}

/** Reads history on its own read-only connection, as the first-open worker does, but in this thread. */
const local: FirstOpenHistoryReader = async read => readFirstOpenHistoryFile(read);
const history = (f: Fixture, objectId = OBJECT) => readFirstOpenHistoryFile({...SOURCE, objectId, database: storagePath(f.storage), afterRelaySeq: 0});
const read = (f: Fixture) => history(f).eligibility;
const prepareWith = (f: Fixture, source: FirstOpenSource, reader = local, signal?: AbortSignal) => {
  f.readWith(reader);
  return f.storage.prepareFirstOpen(source, signal);
};
const catchUpWith = (f: Fixture, proof: FirstOpenProof, reader = local, signal?: AbortSignal) => {
  f.readWith(reader);
  return f.storage.catchUpFirstOpen(proof, signal);
};

async function prepare(f: Fixture, reader = local): Promise<FirstOpenProof> {
  const result = await prepareWith(f, SOURCE, reader);
  if (result.kind !== "prepared") throw new Error(`Expected a preparation, got ${JSON.stringify(result)}.`);
  return result.proof;
}

it("lets a document with only ordinary text history open live, whatever other objects and workspaces hold", async () => {
  const f = await fixture();
  expect(read(f)).toBe("eligible");
  expect(f.write(await prepare(f))).toMatchObject({kind: "published"});
  expect(f.published()).toBe(1);
});

const departed = (op: SyncRelayLogInput) => { op.relayAdmission = "departed"; };
// Authority-table evidence moves no log head, so only the writer's own reads find it.
const authorityTables: Array<[string, (f: Fixture) => void]> = [
  ["a retired baseline registration", f => f.liveDocument(WS, OBJECT, {retired: true, path: "docs/old.md"})],
  ["a retired successor baseline", f => f.liveDocument(WS, OBJECT, {lineage: OTHER_LINEAGE, replaces: LINEAGE, retired: true, path: "docs/old.md"})],
  ["a current baseline at another path", f => f.liveDocument(WS, OBJECT, {path: "docs/old.md"})],
  ["an ordinary activation basis from another identity", f => f.ordinaryBase(WS, OBJECT)],
  ["a retained service activation", f => f.activation(WS, OBJECT)],
  ["a completed Stop/restore operation", f => f.restore(WS, OBJECT)],
  ["a Stop/restore operation in an earlier namespace", f => f.restore(WS, OBJECT, "namespace-0")],
  ["a Stop/restore operation in a new namespace", f => f.restore(WS, OBJECT, "namespace-3")],
];
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
  ["an owner base from a device with an older clock", f => f.append(WS, "ydoc.update", ydoc(OBJECT, {isBaseState: true}), {originId: "owner-laptop", recordedAtMs: 0})],
  ...authorityTables,
  ["a live document deleted and restored", f => {
    f.append(WS, "ydoc.update", ydoc(OBJECT, {isBaseState: true}));
    f.append(WS, "moment.append", remove(OBJECT, "docs/a.md"));
    f.append(WS, "moment.append", write(OBJECT, "docs/a.md"));
  }],
  ["a live document replaced and returned", f => {
    f.append(WS, "ydoc.update", ydoc(OBJECT, {isBaseState: true}));
    f.append(WS, "moment.append", replace(OBJECT, "object-3"));
    f.append(WS, "moment.append", write(OBJECT, "docs/a.md"));
  }],
  ...audits(OBJECT).map(([opKind, payload]): [string, (f: Fixture) => void] => [`an accepted ${opKind} alone`, f => f.stored(WS, opKind, payload)]),
  ["a departed live audit", f => f.stored(WS, ...audits(OBJECT)[0]!, {relayAdmission: "departed"})],
];
it.each(priorAuthority)("refuses a first live base after %s", async (_, add) => {
  const f = await fixture();
  add(f);
  expect(read(f)).toBe("prior-authority");
  expect(await prepareWith(f, SOURCE)).toEqual({kind: "refused", reason: "prior-authority"});
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
  ["a deletion from a device with an older clock", f => f.append(WS, "moment.append", remove(OBJECT, "docs/a.md"), {originId: "owner-laptop", recordedAtMs: 0})],
  ["a replacement and the replaced document's return", f => {
    f.append(WS, "moment.append", replace(OBJECT, "object-3"));
    f.append(WS, "moment.append", write(OBJECT, "docs/a.md"));
  }],
  ["a departed replacement", f => f.append(WS, "moment.append", replace(OBJECT, "object-3"), {originId: "service-host:native", admit: departed})],
  ["a replacement below the epoch floor", f => {
    f.append(WS, "moment.append", replace(OBJECT, "object-3"));
    f.reenroll(WS, {replicationEpoch: "epoch-2", streamIdentity: "stream-2"});
  }],
  ["a replacement in another version", f => f.append(WS, "moment.append", replace(OBJECT, "object-3", "version-2"))],
  ["a replacement at another path", f => f.append(WS, "moment.append", replace(OBJECT, "object-3", "main", "private/old.md"))],
];
it.each(deletion)("refuses a first live base after %s", async (_, add) => {
  const f = await fixture();
  add(f);
  expect(read(f)).toBe("deletion");
  expect(await prepareWith(f, SOURCE)).toEqual({kind: "refused", reason: "deletion"});
});

const notDeletion: Array<[string, (f: Fixture) => void]> = [
  ["a write naming it before and after", f => f.append(WS, "moment.append", replace(OBJECT, OBJECT))],
  ["a write naming no object after it", f => f.stored(WS, "moment.append", replace(OBJECT, ""))],
  ["a refused replacement", f => f.stored(WS, "moment.append", replace(OBJECT, "object-3"), {settlement: "refused"})],
  ["its replacement of another document", f => f.append(WS, "moment.append", replace(OTHER, OBJECT))],
  ["another document's replacement", f => f.append(WS, "moment.append", replace(OTHER, "object-3"))],
];
it.each(notDeletion)("lets a document open live after %s", async (_, add) => {
  const f = await fixture();
  add(f);
  expect(read(f)).toBe("eligible");
});

it("lets a document with no history open live", async () => {
  expect(history(await fixture(), "object-new").eligibility).toBe("eligible");
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
  expect(read(f)).toBe("eligible");
});

// Evidence committed between preparation and the writer.
it.each(priorAuthority)("never publishes when %s is committed after preparation", async (_, add) => {
  const f = await fixture(), proof = await prepare(f);
  add(f);
  expect(f.write(proof).kind).not.toBe("published");
  expect(f.guard).not.toHaveBeenCalled();
  expect(await catchUpWith(f, proof)).toEqual({kind: "refused", reason: "prior-authority"});
  expect(f.published()).toBe(0);
});
it.each(deletion)("never publishes when %s is committed after preparation", async (_, add) => {
  const f = await fixture(), proof = await prepare(f);
  add(f);
  expect(f.write(proof).kind).not.toBe("published");
  expect(f.guard).not.toHaveBeenCalled();
  expect(await catchUpWith(f, proof)).toEqual({kind: "refused", reason: "deletion"});
  expect(f.published()).toBe(0);
});
it.each(authorityTables)("refuses in the writer itself after %s", async (_, add) => {
  const f = await fixture(), proof = await prepare(f);
  add(f);
  expect(f.write(proof)).toEqual({kind: "refused", reason: "prior-authority"});
  expect(f.published()).toBe(0);
});

it("ignores everything another workspace commits after preparation", async () => {
  const f = await fixture(), proof = await prepare(f);
  f.append(OTHER_WS, "ydoc.update", ydoc(OBJECT, {isBaseState: true}));
  f.append(OTHER_WS, "moment.append", remove(OBJECT, "docs/a.md"));
  f.append(OTHER_WS, "moment.append", replace(OBJECT, "object-4"));
  for (const [opKind, payload] of audits(OBJECT)) f.stored(OTHER_WS, opKind, payload);
  f.restore(OTHER_WS, OBJECT, "namespace-3");
  expect(f.write(proof)).toMatchObject({kind: "published"});
  expect(f.published()).toBe(1);
});

it("catches up from the cutoff after unrelated rows, however often the log moves before the writer", async () => {
  const f = await fixture(), reads: Array<[FirstOpenHistoryRead, FirstOpenHistory]> = [];
  const recording: FirstOpenHistoryReader = async request => {
    const result = readFirstOpenHistoryFile(request);
    reads.push([request, result]);
    return result;
  };
  let proof = await prepare(f, recording);
  for (let round = 0; round < 2; round++) {
    f.append(WS, "moment.append", write(OTHER, `docs/other-${round}.md`));
    expect(f.write(proof)).toEqual({kind: "retry"});
    expect(f.published()).toBe(0);
    const caught = await catchUpWith(f, proof, recording);
    if (caught.kind !== "prepared") throw new Error(`Expected a preparation, got ${JSON.stringify(caught)}.`);
    proof = caught.proof;
  }
  expect(reads.map(([request]) => request.afterRelaySeq)).toEqual([0, reads[0]![1].head, reads[1]![1].head]);
  expect(reads[2]![1].head).toBeGreaterThan(reads[1]![1].head!);
  expect(f.write(proof)).toMatchObject({kind: "published"});
  expect(f.guard).toHaveBeenCalledTimes(1);
  expect(f.published()).toBe(1);
});

it("takes the head from the same snapshot as the history", async () => {
  const f = await fixture();
  // Evidence commits right after the reader's first statement finishes.
  let commit: (() => void) | undefined = () => f.append(WS, "ydoc.update", ydoc(OBJECT, {isBaseState: true}));
  const barrier: FirstOpenHistoryReader = async request => {
    const db = new DatabaseSync(request.database, {readOnly: true});
    try {
      return readFirstOpenHistory({prepare: sql => {
        const statement = db.prepare(sql);
        return {get: (...parameters) => {
          const row = statement.get(...parameters);
          const next = commit;
          commit = undefined;
          next?.();
          return row;
        }};
      }}, request);
    } finally {
      db.close();
    }
  };
  const proof = await prepare(f, barrier);
  expect(commit).toBeUndefined();
  expect(f.write(proof)).toEqual({kind: "retry"});
  expect(await catchUpWith(f, proof)).toEqual({kind: "refused", reason: "prior-authority"});
  expect(f.published()).toBe(0);
});

it("refuses a source that is not the document's current state", async () => {
  const f = await fixture();
  for (const source of [{...SOURCE, sourceMomentId: "moment-other"}, {...SOURCE, sourceDigest: "e".repeat(64)}, {...SOURCE, path: "docs/b.md"},
    {...SOURCE, objectId: "object-3"}]) {
    expect(await prepareWith(f, source)).toEqual({kind: "refused", reason: "stale-source"});
  }
});

const staleAfterPreparation: Array<[string, (f: Fixture) => void]> = [
  ["its content changed", f => f.append(WS, "moment.append", {...write(OBJECT, "docs/a.md"), momentId: "write-again"})],
  ["it moved", f => f.append(WS, "moment.append", write(OBJECT, "docs/b.md"))],
  ["the workspace's identity rotated", f => expect(f.storage.rotateWorkspaceIdentity({workspaceId: WS, ownerUserId: "owner-1",
    replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 2})).toBe("rotated")],
];
it.each(staleAfterPreparation)("discards a preparation once %s", async (_, change) => {
  const f = await fixture(), proof = await prepare(f);
  change(f);
  expect(f.write(proof)).toEqual({kind: "refused", reason: "stale-source"});
  expect(await catchUpWith(f, proof)).toEqual({kind: "refused", reason: "stale-source"});
  expect(f.published()).toBe(0);
});

it("does not carry a preparation past its storage's close or into a reopened database", async () => {
  const f = await fixture(), proof = await prepare(f), path = storagePath(f.storage);
  f.raw.close();
  closeTestStorage(f.storage);
  expect(() => f.write(proof)).toThrow();
  const reopened = reopenTestStorage(path, {firstOpenHistory: local});
  expect(() => reopened.writeFirstOpen(proof, BASE, f.guard)).toThrow("another relay storage");
  await expect(reopened.catchUpFirstOpen(proof)).rejects.toThrow("another relay storage");
  expect(f.guard).not.toHaveBeenCalled();
});

it("does not publish after its storage is invalidated", async () => {
  const f = await fixture(), proof = await prepare(f);
  f.storage.invalidate();
  expect(() => f.write(proof)).toThrow("unavailable");
  expect(f.guard).not.toHaveBeenCalled();
});

it("does not prepare when its storage closes during the read", async () => {
  const f = await fixture();
  let release!: () => void, started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  const waiting: FirstOpenHistoryReader = async (request, signal) => {
    started();
    await released;
    expect(signal.aborted).toBe(true);
    return readFirstOpenHistoryFile(request);
  };
  const preparing = prepareWith(f, SOURCE, waiting);
  await reading;
  f.raw.close();
  closeTestStorage(f.storage);
  release();
  await expect(preparing).rejects.toThrow("unavailable");
});

it("never prepares from a failed read", async () => {
  const f = await fixture(), proof = await prepare(f);
  const failing: FirstOpenHistoryReader = async () => { throw new Error("worker failed"); };
  await expect(prepareWith(f, SOURCE, failing)).rejects.toThrow("worker failed");
  await expect(catchUpWith(f, proof, failing)).rejects.toThrow("worker failed");
  await expect(prepareWith(f, {...SOURCE, workspaceId: "workspace-unknown"})).rejects.toThrow("no history");
  expect(await prepareWith(f, SOURCE, async () => ({kind: "busy"}))).toEqual({kind: "busy"});
});

it("refuses a workspace the relay no longer holds, and a proof storage did not make", async () => {
  const f = await fixture(), proof = await prepare(f);
  expect(() => f.write({} as FirstOpenProof)).toThrow("another relay storage");
  f.raw.prepare("DELETE FROM sync_relay_workspaces WHERE workspace_id=?").run(WS);
  expect(() => f.write(proof)).toThrow("no history");
  expect(f.guard).not.toHaveBeenCalled();
});

const baseBlobs = (f: Fixture) => Number(f.raw.prepare("SELECT count(*) AS n FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?").get(WS, sha256Hex(BASE.bytes))!.n);

it("leaves neither the base's row nor its blob when publication fails in the writer", async () => {
  const f = await fixture(), proof = await prepare(f);
  expect(() => f.storage.writeFirstOpen(proof, BASE, () => { throw new Error("publication failed"); })).toThrow("publication failed");
  expect(f.published()).toBe(0);
  expect(baseBlobs(f)).toBe(0);
  expect(f.write(proof)).toMatchObject({kind: "published"});
  expect(baseBlobs(f)).toBe(1);
});

it("commits the blob and one ordinary unauthored base at the source's reserved coordinate", async () => {
  const f = await fixture(), written = f.write(await prepare(f));
  if (written.kind !== "published") throw new Error(JSON.stringify(written));
  const rows = f.raw.prepare("SELECT * FROM sync_relay_log WHERE origin_id LIKE 'service-host:first-open:%'").all();
  const digest = sha256Hex(BASE.bytes);
  expect(rows).toEqual([expect.objectContaining({workspace_id: WS, origin_id: written.receipt.originId, origin_seq: 0, relay_seq: written.receipt.relaySeq,
    op_kind: "ydoc.update", recorded_at_ms: BASE.recordedAtMs, admitted_author_snapshot_json: null, settlement_admission_json: null, relay_admission: null,
    payload_json: JSON.stringify({contentKind: "richdoc", isBaseState: true, lineageClaimId: digest, objectId: OBJECT, path: "docs/a.md",
      updateBlobSha256: digest, versionId: "main"})})]);
  expect(written.receipt.originId).toMatch(/^service-host:first-open:[0-9a-f]{64}$/);
  // No replacement moment, no live journal event.
  expect(f.raw.prepare("SELECT count(*) AS n FROM sync_relay_object_moments WHERE workspace_id=? AND object_id=?").get(WS, OBJECT)!.n).toBe(2);
  expect(f.raw.prepare("SELECT count(*) AS n FROM sync_relay_live_update_journal").get()!.n).toBe(0);
});

it("derives each source's reserved origin from every part of its identity", () => {
  const identity = {replicationEpoch: "epoch-1", streamIdentity: "stream-1"}, origin = firstOpenOrigin("namespace", SOURCE, identity);
  const changed = [firstOpenOrigin("namespace-2", SOURCE, identity), firstOpenOrigin("namespace", SOURCE, {...identity, replicationEpoch: "epoch-2"}),
    firstOpenOrigin("namespace", SOURCE, {...identity, streamIdentity: "stream-2"}),
    ...(["workspaceId", "objectId", "path", "sourceMomentId", "sourceDigest"] as const).map(field => firstOpenOrigin("namespace", {...SOURCE, [field]: `${SOURCE[field]}x`}, identity)),
    // Moving a boundary between neighbouring fields changes the origin too.
    firstOpenOrigin("namespace", {...SOURCE, workspaceId: `${WS}"`, objectId: OBJECT.slice(1)}, identity)];
  expect(new Set([origin, ...changed]).size).toBe(changed.length + 1);
  expect(firstOpenOrigin("namespace", {...SOURCE, sourceByteLength: 99}, identity)).toBe(origin);
});

/** Runs the module's writer with a publisher of the test's own. */
const writeWith = (f: Fixture, proof: FirstOpenProof, publish: (publication: FirstOpenPublication) => unknown) =>
  writeFirstOpen(f.storage as StorageContext, proof, BASE, publish as (publication: FirstOpenPublication) => void);
const appendBase = (f: Fixture, publication: FirstOpenPublication, change: {originId?: string; op?: Partial<FirstOpenPublication["op"]>} = {}) => {
  const context = f.storage as StorageContext;
  putBlobInTransaction(context, {workspaceId: WS, sha256: publication.blob.sha256, content: publication.blob.content, createdAtMs: 1});
  return appendLogBatchInTransaction(context, {workspaceId: WS, originId: change.originId ?? publication.originId, ops: [{...publication.op, ...change.op}]});
};

const wrongPublishers: Array<[string, (f: Fixture) => (publication: FirstOpenPublication) => unknown]> = [
  ["writes nothing", () => () => undefined],
  ["writes another document's base", f => publication => appendBase(f, publication, {op: {payloadJson: publication.op.payloadJson.replace(OBJECT, OTHER)}})],
  ["writes the base under another origin", f => publication => appendBase(f, publication, {originId: "service-host:first-open:other"})],
  ["writes other bytes", f => publication => appendBase(f, {...publication, blob: {sha256: SHA, content: TEXT}},
    {op: {payloadJson: publication.op.payloadJson.replaceAll(publication.blob.sha256, SHA)}})],
  ["writes another timestamp", f => publication => appendBase(f, publication, {op: {recordedAtMs: 2}})],
  ["writes another row as well", f => publication => {
    appendBase(f, publication);
    appendLogBatchInTransaction(f.storage as StorageContext, {workspaceId: WS, originId: "owner-device", ops: [{originSeq: f.storage.maxOriginSeq(WS, "owner-device") + 1,
      opKind: "moment.append", payloadJson: JSON.stringify(write(OTHER, "docs/other.md")), recordedAtMs: 1}]});
  }],
];
it.each(wrongPublishers)("rolls back a publisher that %s", async (_, publisher) => {
  const f = await fixture(), proof = await prepare(f), head = () => f.raw.prepare("SELECT max(relay_seq) AS head FROM sync_relay_log").get()!.head;
  const before = head();
  expect(() => writeWith(f, proof, publisher(f))).toThrow("did not write its proven base");
  expect(head()).toBe(before);
  expect(baseBlobs(f)).toBe(0);
  // The proof survives a refused publication.
  expect(f.write(proof)).toMatchObject({kind: "published"});
});

it("never commits a blob or append that resumes after the writer's transaction ends", async () => {
  const f = await fixture(), proof = await prepare(f);
  let resumed!: Promise<unknown>;
  expect(() => writeWith(f, proof, publication => {
    resumed = Promise.resolve().then(() => appendBase(f, publication));
    return resumed;
  })).toThrow("synchronous");
  await expect(resumed).rejects.toThrow("requires the relay write transaction");
  expect(f.published()).toBe(0);
  expect(baseBlobs(f)).toBe(0);
  // An append that would otherwise succeed, from a fresh origin.
  const context = f.storage as StorageContext, op = {originSeq: 0, opKind: "moment.append", payloadJson: JSON.stringify(write(OTHER, "docs/late.md")), recordedAtMs: 1};
  expect(() => appendLogBatchInTransaction(context, {workspaceId: WS, originId: "late-device", ops: [op]})).toThrow("requires the relay write transaction");
  expect(f.storage.maxOriginSeq(WS, "late-device")).toBe(-1);
});

it("refuses to publish over rows already at the reserved origin", async () => {
  const f = await fixture(), proof = await prepare(f);
  // A relay refusal names no document, so history still allows publication; the writer still never writes over it.
  const originId = firstOpenOrigin(BASE.namespace, SOURCE, {replicationEpoch: "epoch-1", streamIdentity: "stream-1"});
  f.raw.prepare(`INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_admission) VALUES (?,?,0,'relay.refused','{}',1,'refused')`).run(WS, originId);
  const caught = await catchUpWith(f, proof);
  if (caught.kind !== "prepared") throw new Error(JSON.stringify(caught));
  expect(f.write(caught.proof)).toEqual({kind: "occupied"});
  expect(f.guard).not.toHaveBeenCalled();
});

it("keeps account deletion out of the first-open worker's modules", () => {
  const seen = new Set<string>(), pending = [fileURLToPath(new URL("../liveValidationWorker.ts", import.meta.url))];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(/^import(?!\s+type\b)[^;]*?from\s+"(\.[^"]+)"/gm)) {
      pending.push(resolve(dirname(file), specifier!.replace(/\.js$/, "")) + ".ts");
    }
  }
  const modules = [...seen].map(file => file.replaceAll("\\", "/"));
  expect(modules.some(file => file.endsWith("storage/firstOpenHistory.ts"))).toBe(true);
  expect(modules.filter(file => /storage\/(accountDeletion|firstOpenEligibility)\.ts$/.test(file))).toEqual([]);
});

it("reads history through indexes, and only after the cutoff when catching up", async () => {
  const f = await fixture(), queries: string[] = [];
  const capture: FirstOpenHistoryReader = async request => {
    const db = new DatabaseSync(request.database, {readOnly: true});
    try {
      return readFirstOpenHistory({prepare: sql => { queries.push(sql); return db.prepare(sql); }}, request);
    } finally {
      db.close();
    }
  };
  const proof = await prepare(f, capture);
  const db = (f.storage as StorageContext).db, spy = vi.spyOn(db, "prepare");
  f.write(proof);
  const guard = spy.mock.calls.map(([sql]) => sql).find(sql => sql.startsWith("WITH RECURSIVE"))!;
  spy.mockRestore();
  const plan = (query: string) => db.prepare(`EXPLAIN QUERY PLAN ${query}`).all().map(row => String(row.detail));
  const history = plan(queries[0]!), writer = plan(guard);
  for (const detail of [...history, ...writer]) expect(detail).not.toMatch(/^SCAN (?!t\b|n\b|h\b|m\b|CONSTANT ROW)/);
  for (const table of ["sync_relay_live_documents", "sync_relay_live_document_ordinary_bases", "sync_relay_service_activations",
    "sync_relay_live_restore_operations", "sync_relay_object_moments"]) {
    expect(history.some(detail => detail.startsWith(`SEARCH ${table} USING`))).toBe(true);
    expect(writer.some(detail => detail.startsWith(`SEARCH ${table} USING`))).toBe(true);
  }
  // The object's own rows are read in one pass; both log searches start after the cutoff.
  expect(history.filter(detail => detail.includes("idx_sync_relay_log_hosted_documents"))).toEqual([
    expect.stringMatching(/^SEARCH sync_relay_log USING INDEX idx_sync_relay_log_hosted_documents \(.*relay_seq>\?\)$/)]);
  expect(history).toContain("SEARCH sync_relay_log USING INDEX idx_sync_relay_log_page (workspace_id=? AND relay_seq>?)");
  // The writer reads only the head of the log.
  expect(writer.filter(detail => detail.includes("sync_relay_log"))).toEqual(["SEARCH sync_relay_log USING COVERING INDEX idx_sync_relay_log_page (workspace_id=?)"]);
});

it("reads history on the first-open worker's read-only connection, in its one slot", async () => {
  const f = await fixture(), pool = createLiveValidationExecutor();
  pools.push(pool);
  const worker: FirstOpenHistoryReader = (request, signal) => pool.readFirstOpenHistory(request, signal);
  const request = {...SOURCE, database: storagePath(f.storage), afterRelaySeq: 0};
  expect(await pool.readFirstOpenHistory(request)).toEqual(history(f));
  const reading = pool.readFirstOpenHistory(request);
  expect(await pool.readFirstOpenHistory(request)).toEqual({kind: "busy"});
  expect(await pool.buildFirstOpenBase({} as never, {} as never)).toEqual({kind: "busy"});
  await reading;
  const proof = (await prepareWith(f, SOURCE, worker));
  expect(proof.kind).toBe("prepared");
  f.append(WS, "moment.append", remove(OBJECT, "docs/a.md"));
  expect(await prepareWith(f, SOURCE, worker)).toEqual({kind: "refused", reason: "deletion"});
});

it("never prepares when the worker fails, is cancelled, or finds no database", async () => {
  const f = await fixture(), pool = createLiveValidationExecutor(), abort = new AbortController();
  pools.push(pool);
  const worker: FirstOpenHistoryReader = (request, signal) => pool.readFirstOpenHistory(request, signal);
  const cancelled = prepareWith(f, SOURCE, worker, abort.signal);
  abort.abort(new Error("cancelled"));
  await expect(cancelled).rejects.toThrow("cancelled");
  const settled = async () => expect(await pool.readFirstOpenHistory({...SOURCE, database: storagePath(f.storage), afterRelaySeq: 0})).not.toEqual({kind: "busy"});
  await vi.waitFor(settled, {timeout: 10_000});
  await expect(prepareWith(f, {...SOURCE, workspaceId: "workspace-unknown"}, worker)).rejects.toThrow("no history");
  await vi.waitFor(settled, {timeout: 10_000});
  const missing = join(await tempRoot("first-open"), "missing.sqlite");
  await expect(pool.readFirstOpenHistory({...SOURCE, database: missing, afterRelaySeq: 0})).rejects.toThrow();
  expect(existsSync(missing)).toBe(false);
});

it("reads history on the first-open worker unless the storage was opened with another reader", async () => {
  const spy = vi.spyOn(liveValidation, "readFirstOpenHistory");
  try {
    const f = await fixture({defaultReader: true});
    expect((await f.storage.prepareFirstOpen(SOURCE)).kind).toBe("prepared");
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({...SOURCE, afterRelaySeq: 0}), expect.any(AbortSignal));
  } finally {
    spy.mockRestore();
  }
});

/** A read whose snapshot completes, then is cancelled before its result reaches storage. */
function cancelledOnReturn() {
  const abort = new AbortController();
  const reader: FirstOpenHistoryReader = async request => {
    const result = readFirstOpenHistoryFile(request);
    abort.abort(new Error("cancelled"));
    return result;
  };
  return {reader, signal: abort.signal};
}

it("prepares nothing from a read cancelled after its snapshot", async () => {
  const f = await fixture();
  const preparing = cancelledOnReturn();
  await expect(prepareWith(f, SOURCE, preparing.reader, preparing.signal)).rejects.toThrow("cancelled");
  const proof = await prepare(f);
  f.append(WS, "moment.append", write(OTHER, "docs/other.md"));
  const catching = cancelledOnReturn();
  await expect(catchUpWith(f, proof, catching.reader, catching.signal)).rejects.toThrow("cancelled");
  // The proof still stops at its old cutoff.
  expect(f.write(proof)).toEqual({kind: "retry"});
  expect(f.published()).toBe(0);
});

it("never reads once cancelled", async () => {
  const f = await fixture(), proof = await prepare(f), abort = new AbortController(), reader = vi.fn(local);
  abort.abort(new Error("cancelled"));
  await expect(prepareWith(f, SOURCE, reader, abort.signal)).rejects.toThrow("cancelled");
  await expect(catchUpWith(f, proof, reader, abort.signal)).rejects.toThrow("cancelled");
  expect(reader).not.toHaveBeenCalled();
});

const FENCE_KEY = "first-open-fence-key";
const closings: Array<[string, (f: Fixture) => void]> = [
  ["its owner's account was deleted", f => {
    initializeAccountDeletion(f.storage as StorageContext, FENCE_KEY);
    expect(fenceAccount(f.storage as StorageContext, FENCE_KEY, "owner-1", "owner-1@dohc.test").phase).toBe("fenced");
  }],
  ["it was tombstoned alone", f => {
    initializeAccountDeletion(f.storage as StorageContext, FENCE_KEY);
    f.raw.prepare("INSERT INTO sync_relay_deleted_workspaces VALUES (?)").run(accountDeletionIdentity(FENCE_KEY, `workspace:${WS}`));
  }],
  ["its owner's account was fenced alone", f => {
    initializeAccountDeletion(f.storage as StorageContext, FENCE_KEY);
    f.raw.prepare("INSERT INTO sync_relay_account_deletions VALUES (?,'fenced',NULL)").run(accountDeletionIdentity(FENCE_KEY, "owner-1"));
  }],
];
// Fencing keeps the workspace's rows, log head and identity until purge, so only the writer's own check stops it.
it.each(closings)("never publishes into a workspace once %s before preparation", async (_, close) => {
  const f = await fixture();
  close(f);
  const proof = await prepare(f);
  expect(() => f.write(proof)).toThrow("no history");
  expect(f.guard).not.toHaveBeenCalled();
  expect(f.published()).toBe(0);
});
it.each(closings)("never publishes into a workspace once %s after preparation", async (_, close) => {
  const f = await fixture(), proof = await prepare(f);
  close(f);
  expect(() => f.write(proof)).toThrow("no history");
  expect(f.guard).not.toHaveBeenCalled();
  expect(f.published()).toBe(0);
});

it("refuses an asynchronous publication, and rolls back one that returns a thenable", async () => {
  const f = await fixture(), proof = await prepare(f), publish = vi.fn((publication: FirstOpenPublication) => appendBase(f, publication));
  expect(() => writeWith(f, proof, async publication => publish(publication))).toThrow("synchronous");
  expect(publish).not.toHaveBeenCalled();
  for (const pending of [{then() {}}, Promise.resolve()]) {
    expect(() => writeWith(f, proof, publication => { publish(publication); return pending; })).toThrow("synchronous");
  }
  expect(publish).toHaveBeenCalledTimes(2);
  expect(f.published()).toBe(0);
  // A refused publication leaves the proof unused.
  expect(f.write(proof)).toMatchObject({kind: "published"});
  expect(f.published()).toBe(1);
});

it("publishes only the proven source, and only once", async () => {
  const f = await fixture(), offered = {...SOURCE, note: "not part of the source"};
  const proof = (await prepareWith(f, offered));
  if (proof.kind !== "prepared") throw new Error(`Expected a preparation, got ${JSON.stringify(proof)}.`);
  const publish = vi.fn((publication: FirstOpenPublication) => appendBase(f, publication));
  expect(writeWith(f, proof.proof, publish)).toMatchObject({kind: "published"});
  const [publication] = publish.mock.calls[0]!;
  expect(publication.source).toStrictEqual(SOURCE);
  expect(Object.isFrozen(publication.source) && Object.isFrozen(publication) && Object.isFrozen(publication.op)).toBe(true);
  expect(() => f.write(proof.proof)).toThrow("was used");
  await expect(catchUpWith(f, proof.proof)).rejects.toThrow("was used");
  expect(publish).toHaveBeenCalledTimes(1);
  expect(f.published()).toBe(1);
});
