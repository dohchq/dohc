import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createDatasetJournal, type JournalDb, type CheckpointStage } from "./journal.ts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const chunkBytes = 1024 * 1024, scope = { workspaceId: "w", datasetId: "d" };
const authorize = () => {};
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dohc-checkpoint-chunks-"));
  let db = new DatabaseSync(join(root, "journal.sqlite")), largestRead = 0;
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE quota(bytes INTEGER NOT NULL); INSERT INTO quota VALUES(0)");
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const wrapped: JournalDb = { exec: sql => db.exec(sql), prepare(sql) {
    const statement = db.prepare(sql);
    const inspect = (row: Record<string, unknown> | undefined) => {
      for (const value of Object.values(row ?? {})) if (value instanceof Uint8Array) largestRead = Math.max(largestRead, value.byteLength);
      return row;
    };
    return { get: (...parameters) => inspect(statement.get(...parameters as never[])), all: (...parameters) => statement.all(...parameters as never[]).map(row => inspect(row)!),
      run: (...parameters) => statement.run(...parameters as never[]) };
  } };
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE"); try { const value = work(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  let journal = createDatasetJournal({ db: wrapped, transaction });
  const account = ({ bytes }: { bytes: number }) => { db.prepare("UPDATE quota SET bytes=bytes+?").run(bytes); };
  return { get journal() { return journal; }, get db() { return db; }, account, get largestRead() { return largestRead; },
    reopen() { db.close(); db = new DatabaseSync(join(root, "journal.sqlite")); journal = createDatasetJournal({ db: wrapped, transaction }); },
    balance() { return Number(db.prepare("SELECT bytes FROM quota").get()!.bytes); } };
}
function stage(f: ReturnType<typeof fixture>, bytes: Uint8Array, accounted = true): CheckpointStage {
  const staged = f.journal.stageCheckpoint({ scope, expectedBytes: bytes.byteLength, sha256: hash(bytes), authorize, account: accounted ? f.account : undefined });
  for (let offset = 0, index = 0; offset < bytes.byteLength; offset += chunkBytes, index++) f.journal.appendCheckpointChunk({ stage: staged, index, bytes: bytes.subarray(offset, offset + chunkBytes), authorize });
  return f.journal.sealCheckpoint({ stage: staged, authorize });
}
const initialization = { scope, hostEpoch: "host", approvedRevisionHash: hash("rules"), source: "globalThis.operations={};", schemaSql: "CREATE TABLE data(id INTEGER PRIMARY KEY);", definitionJson: "{}", authorize };

it("streams a 100 MiB staged checkpoint and arbitrary chunk boundaries without a checkpoint-sized SQL read", () => {
  const f = fixture(), piece = new Uint8Array(chunkBytes).fill(73), digest = createHash("sha256");
  for (let i = 0; i < 100; i++) digest.update(piece);
  const staged = f.journal.stageCheckpoint({ scope, expectedBytes: 100 * chunkBytes, sha256: digest.digest("hex"), authorize, account: f.account });
  const reserved = f.balance();
  for (let index = 0; index < 100; index++) f.journal.appendCheckpointChunk({ stage: staged, index, bytes: piece, authorize });
  const sealed = f.journal.sealCheckpoint({ stage: staged, authorize });
  f.journal.initialize({ ...initialization, checkpoint: sealed, capacityBytes: 110 * chunkBytes,
    account(allocation) { expect(allocation.stagedCreditBytes).toBe(reserved); f.account({ bytes: allocation.bytes - allocation.stagedCreditBytes }); } });
  expect(f.balance()).toBeGreaterThan(210 * chunkBytes);
  f.reopen();
  const captured = f.journal.captureExport({ scope, authorize, capture() {} });
  const output = createHash("sha256");
  for (let offset = 0; offset < captured.checkpoint.byteLength; offset += chunkBytes) output.update(f.journal.exportBlob({ scope, record: captured.checkpoint, offset, authorize }));
  expect(output.digest("hex")).toBe(staged.sha256);
  expect(f.journal.exportBlob({ scope, record: captured.checkpoint, offset: chunkBytes - 7, length: 20, authorize })).toEqual(new Uint8Array(20).fill(73));
  expect(f.largestRead).toBeLessThanOrEqual(chunkBytes);
  expect(f.journal.checkpointStages({ workspaceId: "w", authorize })).toEqual([]);
  expect(() => f.journal.discardCheckpoint({ stage: sealed, authorize, account: f.account })).toThrow("Active checkpoints");
}, 30_000);

it("retains staged reservations after restart and releases only the selected unactivated stage", () => {
  const f = fixture(), bytes = new Uint8Array(100).fill(9), first = stage(f, bytes), second = stage(f, bytes);
  const before = f.balance(); f.reopen();
  expect(f.journal.checkpointStages({ workspaceId: "w", authorize })).toHaveLength(2);
  expect(f.journal.checkpointStages({ workspaceId: "other", authorize })).toEqual([]);
  expect(() => f.journal.discardCheckpoint({ stage: first, authorize })).toThrow("quota accounting");
  expect(() => f.journal.discardCheckpoint({ stage: first, authorize, account(allocation) { f.account(allocation); throw new Error("failed accounting"); } })).toThrow("failed accounting");
  expect(f.balance()).toBe(before);
  f.journal.discardCheckpoint({ stage: first, authorize, account: f.account });
  expect(f.balance()).toBe(before / 2);
  expect(f.journal.checkpointStages({ workspaceId: "w", authorize })).toEqual([second]);
});

it("refuses incomplete, altered, out-of-order and wrong-scope stages", () => {
  const f = fixture(), bytes = new Uint8Array(chunkBytes + 10).fill(3);
  const staged = f.journal.stageCheckpoint({ scope, expectedBytes: bytes.byteLength, sha256: hash(bytes), authorize });
  expect(() => f.journal.appendCheckpointChunk({ stage: staged, index: 1, bytes: bytes.subarray(chunkBytes), authorize })).toThrow("in order");
  expect(() => f.journal.sealCheckpoint({ stage: staged, authorize })).toThrow("incomplete");
  expect(() => f.journal.initialize({ ...initialization, checkpoint: staged })).toThrow("not sealed");
  f.journal.appendCheckpointChunk({ stage: staged, index: 0, bytes: bytes.subarray(0, chunkBytes), authorize });
  f.journal.appendCheckpointChunk({ stage: staged, index: 1, bytes: bytes.subarray(chunkBytes), authorize });
  const sealed = f.journal.sealCheckpoint({ stage: staged, authorize });
  expect(() => f.journal.appendCheckpointChunk({ stage: sealed, index: 2, bytes: new Uint8Array(1), authorize })).toThrow("in order");
  expect(() => f.journal.initialize({ ...initialization, scope: { ...scope, datasetId: "other" }, checkpoint: sealed })).toThrow("not sealed");
  const altered = f.journal.stageCheckpoint({ scope, expectedBytes: 10, sha256: hash("different"), authorize });
  f.journal.appendCheckpointChunk({ stage: altered, index: 0, bytes: new Uint8Array(10), authorize });
  expect(() => f.journal.sealCheckpoint({ stage: altered, authorize })).toThrow("integrity");
});

it("activates quota, manifest and checkpoint references in one transaction and does not charge retries", () => {
  const f = fixture(), bytes = new Uint8Array(100).fill(5), sealed = stage(f, bytes), reserved = f.balance();
  expect(() => f.journal.initialize({ ...initialization, checkpoint: sealed, account(allocation) { f.account({ bytes: allocation.bytes - allocation.stagedCreditBytes }); throw new Error("refused"); } })).toThrow("refused");
  expect(f.balance()).toBe(reserved);
  expect(f.journal.checkpointStages({ workspaceId: "w", authorize })).toEqual([sealed]);
  const input = { ...initialization, checkpoint: sealed, account(allocation: { bytes: number; stagedCreditBytes: number }) { f.account({ bytes: allocation.bytes - allocation.stagedCreditBytes }); } };
  const cursor = f.journal.initialize(input), balance = f.balance();
  expect(f.journal.initialize(input)).toEqual(cursor); expect(f.balance()).toBe(balance);
  const next = stage(f, new Uint8Array(150).fill(6));
  const transition = { ...initialization, expected: cursor, approvedRevisionHash: hash("next"), checkpoint: next, account: input.account };
  const nextCursor = f.journal.transitionCheckpoint(transition), nextBalance = f.balance();
  expect(f.journal.transitionCheckpoint(transition)).toEqual(nextCursor); expect(f.balance()).toBe(nextBalance);
  expect(f.journal.checkpoint({ scope, revision: 0, authorize }).bytes).toEqual(bytes);
  expect(f.journal.checkpoint({ scope, authorize }).bytes).toEqual(new Uint8Array(150).fill(6));
});

it("rechecks authorization on each chunk and detects persisted chunk corruption", () => {
  const f = fixture(), sealed = stage(f, new Uint8Array(100).fill(5), false);
  f.journal.initialize({ ...initialization, checkpoint: sealed });
  const record = f.journal.captureExport({ scope, authorize, capture() {} }).checkpoint;
  expect(() => f.journal.exportBlob({ scope, record, offset: 0, authorize() { throw new Error("revoked"); } })).toThrow("revoked");
  f.db.exec("UPDATE dohc_dataset_checkpoint_chunks SET bytes=zeroblob(100)");
  expect(() => f.journal.exportBlob({ scope, record, offset: 0, authorize })).toThrow("integrity");
});
