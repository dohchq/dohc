import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createDatasetJournal, type JournalDb, type CheckpointStage } from "./journal.ts";
import { createRecoveryInstaller } from "./recovery-install.ts";

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
  return { get journal() { return journal; }, get db() { return db; }, account, transaction, get largestRead() { return largestRead; },
    reopen() { db.close(); db = new DatabaseSync(join(root, "journal.sqlite")); journal = createDatasetJournal({ db: wrapped, transaction }); },
    balance() { return Number(db.prepare("SELECT bytes FROM quota").get()!.bytes); } };
}
function stage(f: ReturnType<typeof fixture>, bytes: Uint8Array, accounted = true): CheckpointStage {
  const staged = f.journal.stageCheckpoint({ scope, expectedBytes: bytes.byteLength, sha256: hash(bytes), authorize, account: accounted ? f.account : undefined });
  for (let offset = 0, index = 0; offset < bytes.byteLength; offset += chunkBytes, index++) f.journal.appendCheckpointChunk({ stage: staged, index, bytes: bytes.subarray(offset, offset + chunkBytes), authorize });
  return f.journal.sealCheckpoint({ stage: staged, authorize });
}
function pendingStage(f:ReturnType<typeof fixture>,bytes:Uint8Array,sha256=hash(bytes)) {
  const staged=f.journal.stageCheckpoint({scope,expectedBytes:bytes.byteLength,sha256,authorize,account:f.account});
  for(let offset=0,index=0;offset<bytes.byteLength;offset+=chunkBytes,index++)
    f.journal.appendCheckpointChunk({stage:staged,index,bytes:bytes.subarray(offset,offset+chunkBytes),authorize});
  return staged;
}
const initialization = { scope, hostEpoch: "host", approvedRevisionHash: hash("rules"), source: "globalThis.operations={};", schemaSql: "CREATE TABLE data(id INTEGER PRIMARY KEY);", definitionJson: "{}", authorize };

it("seals materialization chunks across I/O turns with no open transaction",async()=>{
  const f=fixture(),bytes=new Uint8Array(3*chunkBytes+7).fill(17),staged=pendingStage(f,bytes);
  let settled=false;
  const sealing=f.journal.sealMaterializationCheckpoint({stage:staged,authorize}).then(value=>{settled=true;return value;});
  await yieldToIo();
  expect(settled).toBe(false);
  f.transaction(()=>f.db.exec("UPDATE quota SET bytes=bytes"));
  // Caller-owned input cannot retarget the remaining chunk reads after yielding.
  staged.scope.datasetId="another";staged.stageId="another-stage";staged.sha256=hash("wrong");
  const sealed=await sealing;
  expect(sealed.scope).toEqual(scope);expect(sealed.sha256).toBe(hash(bytes));expect(sealed.sealed).toBe(true);
  expect(f.largestRead).toBeLessThanOrEqual(chunkBytes);
  expect(f.journal.checkpointStages({workspaceId:scope.workspaceId,authorize})).toEqual([sealed]);
});
it.each(["revoke","discard","delete","sync seal"])("rejects async cache sealing after concurrent %s",async change=>{
  const f=fixture(),staged=pendingStage(f,new Uint8Array(3*chunkBytes).fill(9));
  const expected=f.journal.initialize({...initialization,checkpoint:new Uint8Array()});
  let allowed=true;
  const sealing=f.journal.sealMaterializationCheckpoint({stage:staged,authorize(){if(!allowed)throw Error("revoked");}});
  const rejected=expect(sealing).rejects.toThrow();
  await yieldToIo();
  if(change==="revoke")allowed=false;
  if(change==="discard")f.journal.discardCheckpoint({stage:staged,authorize,account:f.account});
  if(change==="delete")f.journal.destroy({expected,authorize});
  if(change==="sync seal")f.journal.sealCheckpoint({stage:staged,authorize});
  await rejected;
  if(change==="revoke")expect(f.journal.checkpointStages({workspaceId:scope.workspaceId,authorize})[0].sealed).toBe(false);
  if(change==="discard"||change==="delete")expect(f.journal.checkpointStages({workspaceId:scope.workspaceId,authorize})).toEqual([]);
});
it.each(["chunk","digest"])("rejects materialization seal with damaged %s",async damage=>{
  const f=fixture(),bytes=new Uint8Array(chunkBytes+3).fill(7),staged=pendingStage(f,bytes,damage==="digest"?hash("wrong"):hash(bytes));
  if(damage==="chunk")f.db.prepare("UPDATE dohc_dataset_checkpoint_chunks SET bytes=zeroblob(3) WHERE stage_id=? AND chunk_index=1").run(staged.stageId);
  await expect(f.journal.sealMaterializationCheckpoint({stage:staged,authorize})).rejects.toThrow("integrity");
  expect(f.journal.checkpointStages({workspaceId:scope.workspaceId,authorize})[0].sealed).toBe(false);
});
it("requires synchronous authorization and rolls back thenable authorization side effects",async()=>{
  const f=fixture(),staged=pendingStage(f,new Uint8Array(0));let ran=false;
  await expect(f.journal.sealMaterializationCheckpoint({stage:staged,authorize:async()=>{ran=true;}})).rejects.toThrow("synchronous");
  expect(ran).toBe(false);
  const before=f.balance();
  await expect(f.journal.sealMaterializationCheckpoint({stage:staged,authorize:()=>{f.account({bytes:7});return {then(){}};}})).rejects.toThrow("synchronous");
  expect(f.balance()).toBe(before);
  expect((await f.journal.sealMaterializationCheckpoint({stage:staged,authorize})).sealed).toBe(true);
});

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

it.each(["digest", "oversized"])("refuses a checkpoint chunk with %s corruption before returning bytes", damage => {
  const f = fixture(), sealed = stage(f, new Uint8Array(100).fill(5), false);
  f.journal.initialize({ ...initialization, checkpoint: sealed });
  const record = f.journal.captureExport({ scope, authorize, capture() {} }).checkpoint;
  if (damage === "digest") f.db.exec("UPDATE dohc_dataset_checkpoint_chunks SET sha256=lower(hex(zeroblob(32)))");
  else {
    f.db.exec("PRAGMA ignore_check_constraints=ON");
    f.db.prepare("UPDATE dohc_dataset_checkpoint_chunks SET bytes=zeroblob(?)").run(chunkBytes + 1);
  }
  const largestRead = f.largestRead;
  expect(() => f.journal.exportBlob({ scope, record, offset: 0, authorize })).toThrow("integrity");
  expect(f.largestRead).toBe(largestRead);
});

it("does not run asynchronous staging accounting or retain thenable side effects", () => {
  const f = fixture(); let ran = false;
  const input = { scope, expectedBytes: 100, sha256: hash(new Uint8Array(100)), authorize };
  expect(() => f.journal.stageCheckpoint({ ...input, account: async () => { ran = true; } })).toThrow("synchronous");
  expect(ran).toBe(false);
  expect(() => f.journal.stageCheckpoint({ ...input, account: allocation => { f.account(allocation); return { then() {} }; } })).toThrow("synchronous");
  expect(f.balance()).toBe(0);
  expect(f.journal.checkpointStages({ workspaceId: "w", authorize })).toEqual([]);
});

it("reclaims interrupted stages after restart in bounded pages while retaining recovery imports and active history", () => {
  const f = fixture(), bytes = new Uint8Array(80).fill(7);
  createRecoveryInstaller({ db: f.db, transaction: f.transaction, journal: f.journal });
  const active = stage(f, bytes, false);
  f.journal.initialize({ ...initialization, checkpoint: active });
  const retained = [stage(f, bytes), stage(f, bytes)];
  retained.forEach((entry, i) => f.db.prepare("INSERT INTO dohc_dataset_import_checkpoints VALUES(?,?,?,?)")
    .run(`import-${i}`, entry.stageId, JSON.stringify(entry), i ? "head" : "history"));
  stage(f, bytes);
  f.journal.stageCheckpoint({ scope: { workspaceId: "another", datasetId: "d" }, expectedBytes: 80, sha256: hash(bytes), authorize, account: f.account });
  const incomplete = f.journal.stageCheckpoint({ scope, expectedBytes: chunkBytes + 80, sha256: hash(new Uint8Array(chunkBytes + 80)), authorize, account: f.account });
  f.journal.appendCheckpointChunk({ stage: incomplete, index: 0, bytes: new Uint8Array(chunkBytes), authorize });
  f.reopen();
  const retain = (entry: Readonly<CheckpointStage>) => Boolean(f.db.prepare("SELECT 1 FROM dohc_dataset_import_checkpoints WHERE stage_id=?").get(entry.stageId));
  let after: string | undefined, reclaimed = 0, pages = 0;
  do {
    const result = f.journal.reclaimCheckpointStages({ after, limit: 2, authorize, account: f.account, retain });
    after = result.after; reclaimed += result.reclaimed; pages++;
  } while (after);
  expect(reclaimed).toBe(3); expect(pages).toBe(3);
  expect(f.journal.checkpointStages({workspaceId: "w", authorize}).map(s => s.stageId).sort()).toEqual(retained.map(s => s.stageId).sort());
  expect(f.db.prepare("SELECT count(*) n FROM dohc_dataset_checkpoint_chunks").get()!.n).toBe(3);
  expect(f.journal.checkpoint({ scope, authorize }).bytes).toEqual(bytes);
  expect(f.balance()).toBe(2 * (80 + 128 + 512));
  expect(f.journal.reclaimCheckpointStages({ authorize, account: f.account, retain }).reclaimed).toBe(0);
  expect(f.balance()).toBe(2 * (80 + 128 + 512));
});

it("rolls back stage deletion and quota release together when startup accounting or standing fails", () => {
  const f = fixture(), entry = stage(f, new Uint8Array(20)), before = f.balance();
  expect(() => f.journal.reclaimCheckpointStages({ authorize, retain: () => false,
    account(allocation) { f.account(allocation); throw new Error("quota failed"); },
  })).toThrow("quota failed");
  expect(f.balance()).toBe(before);
  let calls = 0;
  expect(() => f.journal.reclaimCheckpointStages({ authorize() { if (++calls === 3) throw new Error("closed"); }, retain: () => false, account: f.account })).toThrow("closed");
  expect(f.balance()).toBe(before);
  expect(f.journal.checkpointStages({workspaceId: "w", authorize})).toEqual([entry]);
  expect(f.journal.reclaimCheckpointStages({authorize, retain: () => false, account: f.account}).reclaimed).toBe(1);
  expect(f.balance()).toBe(0);
});
