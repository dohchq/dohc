import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { createDatasetJournal, type DatasetCursor } from "./journal";
import { prepareDatasetRecoveryExport } from "./recovery-export";
import { recoveryManifestSha256, stageDatasetRecovery, type StagedDatasetRecovery } from "./recovery";
import { validateDatasetRecovery, readValidatedBlob } from "./recovery-import";
import { parseRecoveryJournalRecord } from "./recovery-record";
import { createRecoveryInstaller } from "./recovery-install";
import { createDatasetAttempts, cancelDatasetAttempt, reviewDatasetAttempts, assertDatasetAttemptNotCancelled } from "./dataset-attempts";

const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const schemaSql = "CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT NOT NULL);";
const source = "globalThis.operations={read(ctx){return ctx.db.query('SELECT * FROM items')}};";
const definition: DatasetDefinition = { formatVersion:1,datasetId:id(1),name:"Items",schemaPath:"schema.sql",operationsPath:"operations.js",
  tables:[{tableId:id(2),name:"Items",sqlName:"items",primaryKey:"id",fields:[{fieldId:id(3),name:"ID",sqlColumn:"id",type:"number",required:true,unique:true},{fieldId:id(4),name:"Value",sqlColumn:"value",type:"text",required:true,unique:false}]}],
  operations:[{operationId:id(5),name:"read",label:"Read",tableId:id(2),kind:"read",access:"owner",readOnly:true,fieldIds:[id(3),id(4)]}] };
const limits = { maxTotalBytes: 16*1024*1024 };
const cleanups: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(large = false, mutable = false){
  const directory=await mkdtemp(join(tmpdir(),"dohc-recovery-import-test-")), db=new DatabaseSync(join(directory,"host.sqlite")), seedPath=join(directory,"seed.sqlite"), seed=new DatabaseSync(seedPath);
  seed.exec(schemaSql);
  if (large) {
    seed.exec("BEGIN");
    const value = "x".repeat(1024 * 1024);
    for (let index = 0; index < 101; index++) seed.prepare("INSERT INTO items(value) VALUES(?)").run(value);
    seed.exec("COMMIT");
  }
  const transaction=<T>(fn:()=>T)=>{db.exec("BEGIN IMMEDIATE");try{const result=fn();db.exec("COMMIT");return result;}catch(error){db.exec("ROLLBACK");throw error;}};
  const journal=createDatasetJournal({db,transaction}), scope={workspaceId:"workspace",datasetId:id(1)}, revision=describeDatasetRevision({definition: mutable ? {...definition, operations: definition.operations.map(operation => ({...operation, readOnly: false, kind: "action" as const}))} : definition,revision:1,schemaSql,operationSource:source});
  db.exec("CREATE TABLE dohc_dataset_lifecycle(workspace_id,dataset_id,archived,generation,reason,archived_at_ms); CREATE TABLE dohc_dataset_catalog(workspace_id,dataset_id,revision_json,artifacts_json); CREATE TABLE dohc_dataset_catalog_history(workspace_id,dataset_id,revision,revision_json,artifacts_json); CREATE TABLE dohc_dataset_bindings(workspace_id,dataset_id,app_id,binding_json,token); CREATE TABLE dohc_dataset_data_grants(workspace_id,dataset_id,principal_key,grant_json,token);");
  db.prepare("INSERT INTO dohc_dataset_catalog VALUES(?,?,?,?)").run(scope.workspaceId,scope.datasetId,JSON.stringify(revision),JSON.stringify({schemaSql,operationSource:source}));
  const authorize=()=>{}, checkpoint=await readFile(seedPath);
  let head=journal.initialize({scope,hostEpoch:"host",approvedRevisionHash:revision.revisionSha256,source,schemaSql,definitionJson:JSON.stringify(revision),checkpoint,authorize, ...(large ? { capacityBytes:128*1024*1024 } : {})});
  cleanups.push(async()=>{seed.close();db.close();if(!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}dohc-recovery-import-test-`))throw Error("unsafe temp path");await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:25});});
  function add(value: string, attached: string[] = [], retry?: {callerKey: string; payloadSha256: string}) {
    const session=seed.createSession({table:"items"}); seed.prepare("INSERT INTO items(value) VALUES(?)").run(value); const changeset=session.changeset(); session.close();
    const result=journal.commitOperation({expected:head,proposalId:value,operation:"read",callerKey:retry?.callerKey ?? "owner",idempotencyKey:value,payloadSha256:retry?.payloadSha256 ?? hash(value),resultJson:JSON.stringify({value}),changeset,changesetSha256:hash(changeset),attachedFileIds:attached,authorize,accountAndAttach(){}});
    if(result.kind!=="committed")throw Error("unexpected replay");head=result.event.cursor;return result.event;
  }
  async function migrate(){
    const operationSource=source+"\n// revision two", next=describeDatasetRevision({definition,revision:2,schemaSql,operationSource});
    head=journal.transitionCheckpoint({expected:head,hostEpoch:"host",approvedRevisionHash:next.revisionSha256,source:operationSource,schemaSql,definitionJson:JSON.stringify(next),checkpoint:await readFile(seedPath),authorize,account(){
      db.prepare("INSERT INTO dohc_dataset_catalog_history VALUES(?,?,?,?,?)").run(scope.workspaceId,scope.datasetId,1,JSON.stringify(revision),JSON.stringify({schemaSql,operationSource:source}));
      db.prepare("UPDATE dohc_dataset_catalog SET revision_json=?,artifacts_json=?").run(JSON.stringify(next),JSON.stringify({schemaSql,operationSource}));
    }}); return head;
  }
  async function stage(attachment?: {fileId:string; bytes:Uint8Array; revision:number}) {
    const exportLimits = large ? { maxTotalBytes: 512 * 1024 * 1024 } : limits;
    const prepared=await prepareDatasetRecoveryExport({db,journal,scope,authorize,directory:join(directory,"exports"),limits:exportLimits,
      ...(attachment?{attachments:{capture:()=>[{fileId:attachment.fileId,name:"receipt.png",contentType:"image/png",byteLength:attachment.bytes.byteLength,sha256:hash(attachment.bytes),revision:attachment.revision}],open:async function*(){yield attachment.bytes;}}}:{})});
    const staged=await stageDatasetRecovery({stream:prepared.stream(),stagingParent:directory,limits:exportLimits,authorize,expectedManifestSha256:recoveryManifestSha256(prepared.manifest,exportLimits)});
    await prepared.dispose(); return staged;
  }
  return {directory,db,seed,journal,scope,revision,authorize,add,migrate,stage,transaction,head:()=>head};
}
async function alter(staged:StagedDatasetRecovery,id:string,change:(bytes:Buffer)=>Buffer){
  const file=staged.files.find(f=>f.entry.id===id)!;const bytes=change(await readFile(file.path));await writeFile(file.path,bytes);file.entry.byteLength=bytes.length;file.entry.sha256=hash(bytes);
}
function target(f: Awaited<ReturnType<typeof fixture>>, options: Partial<Parameters<typeof createRecoveryInstaller>[0]> = {}) {
  const db = new DatabaseSync(join(f.directory, "target.sqlite"));
  const transaction = <T>(run: () => T) => { db.exec("BEGIN IMMEDIATE"); try { const result = run(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const journal = createDatasetJournal({ db, transaction });
  for (const table of ["catalog", "catalog_history", "bindings", "data_grants", "lifecycle"]) db.exec(String(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(`dohc_dataset_${table}`)!.sql));
  db.exec("CREATE TABLE usage(bytes INTEGER); INSERT INTO usage VALUES(0)");
  const installer = createRecoveryInstaller({ db, transaction, journal, account(_context, allocation) { db.prepare("UPDATE usage SET bytes=bytes+?").run(allocation.bytes); }, ...options });
  cleanups.push(async () => { db.close(); });
  return { db, journal, installer, transaction };
}

it("installs validated histories and retry receipts inactive with a durable import receipt", async () => {
  const f = await fixture(); f.add("first"); await f.migrate(); f.add("tail");
  f.db.prepare("INSERT INTO dohc_dataset_lifecycle VALUES(?,?,?,?,?,?)").run(f.scope.workspaceId, f.scope.datasetId, 1, 3, "season complete", 1000);
  const valid = await validateDatasetRecovery({ staged: await f.stage(), authorize: f.authorize }), t = target(f);
  try {
    const input = { transferId: "transfer-1", manifestSha256: recoveryManifestSha256(valid.manifest, limits), recovery: valid, authorize: f.authorize };
    const installed = await t.installer.install({}, input);
    expect(installed.sourceCursor).toEqual(f.head()); expect(installed.targetCursor).toBeUndefined();
    expect(t.journal.head(f.scope, f.authorize)).toMatchObject({ active: false, cursor: f.head() });
    expect(t.db.prepare("SELECT archived,generation,reason,archived_at_ms FROM dohc_dataset_lifecycle").get()).toMatchObject({ archived: 1, generation: 3, reason: "season complete", archived_at_ms: 1000 });
    expect(t.db.prepare("SELECT revision,result_json FROM dohc_dataset_receipts WHERE idempotency_key='first'").get()).toMatchObject({ revision: 1, result_json: JSON.stringify({ value: "first" }) });
    expect(t.journal.exportPage({ scope: f.scope, through: f.head(), afterRevision: -1, authorize: f.authorize }).map(item => [item.kind, item.cursor.revision])).toEqual([["checkpoint", 0], ["event", 1], ["checkpoint", 2], ["event", 3]]);
    const usage = t.db.prepare("SELECT bytes FROM usage").get()!.bytes;
    expect(await t.installer.install({}, input)).toEqual(installed);
    expect(t.db.prepare("SELECT bytes FROM usage").get()!.bytes).toBe(usage);
    expect(t.installer.status({ ...f.scope, transferId: input.transferId, authorize: f.authorize })).toEqual(installed);
  } finally { await valid.dispose(); }
});

it("rolls back installation and releases every staging reservation on final quota refusal", async () => {
  const f = await fixture(); f.add("first");
  const valid = await validateDatasetRecovery({ staged: await f.stage(), authorize: f.authorize });
  const t = target(f, { account(_context, allocation) { if (allocation.capacityDeltaBytes) throw Error("quota refusal"); t.db.prepare("UPDATE usage SET bytes=bytes+?").run(allocation.bytes); } });
  try {
    await expect(t.installer.install({}, { transferId: "transfer-1", manifestSha256: recoveryManifestSha256(valid.manifest, limits), recovery: valid, authorize: f.authorize })).rejects.toThrow("quota refusal");
    expect(t.db.prepare("SELECT count(*) n FROM dohc_dataset_journals").get()!.n).toBe(0);
    expect(t.db.prepare("SELECT count(*) n FROM dohc_dataset_checkpoints").get()!.n).toBe(0);
    expect(t.db.prepare("SELECT count(*) n FROM dohc_dataset_imports").get()!.n).toBe(0);
    expect(t.db.prepare("SELECT bytes FROM usage").get()!.bytes).toBe(0);
  } finally { await valid.dispose(); }
});

it("claims a fenced import once with a fresh epoch and preserves retries across installer restart", async () => {
  const f = await fixture(); f.add("first"); f.journal.fence({ expected: f.head(), authorize: f.authorize });
  const valid = await validateDatasetRecovery({ staged: await f.stage(), authorize: f.authorize }), t = target(f);
  try {
    const input = { transferId: "transfer-claim", manifestSha256: recoveryManifestSha256(valid.manifest, limits), recovery: valid, authorize: f.authorize };
    expect(valid.manifest.sourceState).toBe("fenced"); await t.installer.install({}, input);
    const claim = { ...f.scope, transferId: input.transferId, manifestSha256: input.manifestSha256, sourceCursor: f.head(), authorize: f.authorize };
    const claimed = t.installer.claim({}, claim);
    expect(claimed.targetCursor).toMatchObject({ revision: f.head().revision + 1, approvedRevisionHash: f.head().approvedRevisionHash });
    expect(claimed.targetCursor!.hostEpoch).not.toBe(f.head().hostEpoch);
    expect(t.journal.head(f.scope, f.authorize).active).toBe(true);
    expect(t.journal.receipt({ scope: f.scope, callerKey: "owner", idempotencyKey: "first", payloadSha256: hash("first"), authorize: f.authorize })).toMatchObject({ revision: 1 });
    const restarted = createRecoveryInstaller({ db: t.db, journal: t.journal, transaction: t.transaction });
    expect(restarted.claim({}, claim)).toEqual(claimed);
    expect(t.db.prepare("SELECT count(*) n FROM dohc_dataset_import_checkpoints").get()!.n).toBe(0);
  } finally { await valid.dispose(); }
});

it("restores a 100 MiB checkpoint in bounded durable chunks", async () => {
  const f = await fixture(true); f.journal.fence({ expected: f.head(), authorize: f.authorize });
  const valid = await validateDatasetRecovery({ staged: await f.stage(), authorize: f.authorize }), t = target(f);
  try {
    expect(valid.headCheckpoint.byteLength).toBeGreaterThan(100 * 1024 * 1024);
    const manifestSha256 = recoveryManifestSha256(valid.manifest, { maxTotalBytes: 512 * 1024 * 1024 });
    await t.installer.install({}, { transferId: "large-import", manifestSha256, recovery: valid, authorize: f.authorize });
    t.installer.claim({}, { ...f.scope, transferId: "large-import", manifestSha256, sourceCursor: f.head(), authorize: f.authorize });
    expect(t.db.prepare("SELECT MAX(length(bytes)) n FROM dohc_dataset_checkpoint_chunks").get()!.n).toBe(1024 * 1024);
    expect(t.db.prepare("SELECT count(*) n FROM dohc_dataset_checkpoints WHERE state!=2").get()!.n).toBe(0);
  } finally { await valid.dispose(); }
}, 120_000);
function changeHistory(bytes:Buffer,change:(record:any)=>void){
  const result:Buffer[]=[bytes.subarray(0,8)];let offset=8;
  while(offset<bytes.length){const size=bytes.readUInt32BE(offset);offset+=4;const record=JSON.parse(bytes.subarray(offset,offset+size).toString());offset+=size;
    const blobLength=record.kind==="event"||record.kind==="checkpoint"?record.byteLength:0;change(record);const encoded=Buffer.from(JSON.stringify(record)),prefix=Buffer.alloc(4);prefix.writeUInt32BE(encoded.length);result.push(prefix,encoded,bytes.subarray(offset,offset+blobLength));offset+=blobLength;}
  return Buffer.concat(result);
}

it("validates empty history and an actual checkpoint without inventing events",async()=>{
  const f=await fixture(),staged=await f.stage(),valid=await validateDatasetRecovery({staged,authorize:f.authorize});
  expect([...valid.records()].map(item=>[item.record.kind,item.record.cursor.revision])).toEqual([["checkpoint",0]]);
  expect([...valid.metadata()]).toEqual([]);expect(valid.manifest.cursor).toEqual(f.head());await valid.dispose();
});
it("streams only live validated blob references and refuses forged or disposed references",async()=>{
  const f=await fixture(),staged=await f.stage(),valid=await validateDatasetRecovery({staged,authorize:f.authorize});
  const read=async(blob:Parameters<typeof readValidatedBlob>[0])=>{let bytes=0;for await(const chunk of readValidatedBlob(blob)){expect(chunk.length).toBeLessThanOrEqual(1024*1024);bytes+=chunk.length;}return bytes;};
  expect(await read(valid.checkpoint.blob)).toBe(valid.checkpoint.record.byteLength);
  await expect(read({...valid.checkpoint.blob})).rejects.toThrow("not validated");
  const retained=valid.checkpoint.blob;await valid.dispose();await expect(read(retained)).rejects.toThrow("disposed");
});
it("replays actual changesets across a same-schema revision and preserves old receipts and files",async()=>{
  const f=await fixture(),fileId="receipt_file_0001",first=f.add("first",[fileId]);await f.migrate();f.add("tail");
  const staged=await f.stage({fileId,bytes:Uint8Array.of(137,80,78,71),revision:first.cursor.revision}),valid=await validateDatasetRecovery({staged,authorize:f.authorize});
  expect([...valid.records()].map(item=>[item.record.kind,item.record.cursor.revision])).toEqual([["checkpoint",0],["event",1],["checkpoint",2],["event",3]]);
  expect([...valid.records()].filter(item=>item.record.kind==="event").map(item=>item.record.kind==="event"&&item.record.idempotencyKey)).toEqual(["first","tail"]);
  expect([...valid.metadata()].filter(item=>item.kind==="attachment")).toMatchObject([{file:{fileId,revision:1}}]);
  const attachment=[...valid.attachments()][0]!;const parts=[];for await(const bytes of readValidatedBlob(attachment.blob))parts.push(bytes);
  expect(Buffer.concat(parts)).toEqual(Buffer.from([137,80,78,71]));await valid.dispose();
});
it("retains a marker-free materialized head for a fresh target epoch",async()=>{
  const f=await fixture();f.add("first");f.add("second");const staged=await f.stage(),valid=await validateDatasetRecovery({staged,authorize:f.authorize});
  const materialized=new DatabaseSync(valid.headCheckpoint.blob.path,{readOnly:true});
  try{expect(materialized.prepare("SELECT value FROM items ORDER BY id").all().map(row=>row.value)).toEqual(["first","second"]);
    expect(materialized.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'dohc_%'").all()).toEqual([]);
  }finally{materialized.close();}
  const sha=createHash("sha256");for await(const chunk of readValidatedBlob(valid.headCheckpoint.blob))sha.update(chunk);
  expect(sha.digest("hex")).toBe(valid.headCheckpoint.sha256);expect(valid.headCheckpoint.cursor).toEqual(f.head());await valid.dispose();
});
it("rejects source tampering even after the transport hash is replaced",async()=>{
  const f=await fixture(),staged=await f.stage();await alter(staged,"artifact:source",()=>Buffer.from("globalThis.operations={};"));
  await expect(validateDatasetRecovery({staged,authorize:f.authorize})).rejects.toThrow("source artifact");
  await expect(readdir(staged.directory)).rejects.toThrow();
});
it("rejects malformed original artifacts, truncated history, and a changed chain",async()=>{
  const f=await fixture();f.add("first");await f.migrate();
  for(const mutation of [
    (bytes:Buffer)=>changeHistory(bytes,record=>{if(record.kind==="catalog")record.artifactsJson="{broken";}),
    (bytes:Buffer)=>bytes.subarray(0,bytes.length-3),
    (bytes:Buffer)=>changeHistory(bytes,record=>{if(record.kind==="event")record.previousDigest="0".repeat(64);}),
  ]){
    const staged=await f.stage();await alter(staged,"history",mutation);await expect(validateDatasetRecovery({staged,authorize:f.authorize})).rejects.toThrow();
    await expect(readdir(staged.directory)).rejects.toThrow();
  }
});
it("rejects attached bytes whose metadata differs from the original association",async()=>{
  const f=await fixture(),fileId="receipt_file_0001",event=f.add("first",[fileId]);const staged=await f.stage({fileId,bytes:Uint8Array.of(1,2,3),revision:event.cursor.revision});
  await alter(staged,`attachment:${fileId}`,()=>Uint8Array.of(9,9,9) as Buffer);
  await expect(validateDatasetRecovery({staged,authorize:f.authorize})).rejects.toThrow("attachment metadata");
});
it("checks exported metadata digest formulas against real journal records",async()=>{
  const f=await fixture();f.add("first");await f.migrate();f.add("last");
  for(const r of f.journal.exportPage({scope:f.scope,through:f.head(),afterRevision:-1,authorize:f.authorize}))expect(parseRecoveryJournalRecord(r)).toEqual(r);
});


it("rejects tampered or duplicate retained submission metadata before installation", async () => {
  const f = await fixture(false, true), attemptScope = {...f.scope, appId: "app", principalKey: "friend", operationId: id(5), revisionSha256: f.revision.revisionSha256};
  const attempts = createDatasetAttempts({db: f.db, transaction: f.transaction, account() {}}), input = {name: "First"};
  attempts.request(attemptScope, {action: "save", idempotencyKey: "first", input}, f.authorize);
  f.add("first", [], {callerKey: hash(JSON.stringify([attemptScope.principalKey, {kind: "app", appId: attemptScope.appId}])), payloadSha256: hash(JSON.stringify([attemptScope.revisionSha256, attemptScope.operationId, input]))});
  const tampered = await f.stage();
  await alter(tampered, "history", bytes => changeHistory(bytes, record => {if (record.kind === "attempt") record.attempt.input = {name: "Changed"};}));
  await expect(validateDatasetRecovery({staged: tampered, authorize: f.authorize})).rejects.toThrow("matching committed outcome");
  const duplicate = await f.stage();
  await alter(duplicate, "history", bytes => {
    let offset = 8;
    while (offset < bytes.length) {
      const start = offset, length = bytes.readUInt32BE(offset); offset += 4;
      const record = JSON.parse(bytes.subarray(offset, offset + length).toString()); offset += length;
      if (record.kind === "attempt") return Buffer.concat([bytes.subarray(0, offset), bytes.subarray(start, offset), bytes.subarray(offset)]);
      if (record.kind === "event" || record.kind === "checkpoint") offset += record.byteLength;
    }
    throw Error("Missing attempt metadata");
  });
  await expect(validateDatasetRecovery({staged: duplicate, authorize: f.authorize})).rejects.toThrow(/UNIQUE/);
});
it("requires trusted local recovery and explicit stopped-host acknowledgement for an active backup", async () => {
  const f = await fixture(); f.add("first");
  f.db.prepare("INSERT INTO dohc_dataset_data_grants VALUES(?,?,?,?,?)").run(f.scope.workspaceId,f.scope.datasetId,"helper",JSON.stringify({operationIds:[id(5)],discover:true,revision:1,revisionSha256:f.revision.revisionSha256}),"old-token");
  const valid = await validateDatasetRecovery({staged:await f.stage(),authorize:f.authorize}), t = target(f,{allowOwnerRecoveryClaim:true});
  try {
    const input={transferId:"local-recovery",manifestSha256:recoveryManifestSha256(valid.manifest,limits),recovery:valid,authorize:f.authorize};
    await t.installer.install({},input);
    const claim={...f.scope,transferId:input.transferId,manifestSha256:input.manifestSha256,sourceCursor:f.head(),authorize:f.authorize};
    expect(() => t.installer.claim({},claim)).toThrow(/saved while the Collection still accepted changes/);
    const relayInstaller=createRecoveryInstaller({db:t.db,journal:t.journal,transaction:t.transaction});
    expect(() => relayInstaller.claim({},{...claim,oldHostStopped:true})).toThrow(/saved while the Collection still accepted changes/);
    expect(t.journal.head(f.scope,f.authorize).active).toBe(false);
    expect(t.db.prepare("SELECT count(*) n FROM dohc_dataset_data_grants").get()!.n).toBe(0);
    expect(t.db.prepare("SELECT count(*) n FROM dohc_dataset_recovered_permissions").get()!.n).toBe(1);
    expect(t.installer.claim({},{...claim,oldHostStopped:true}).targetCursor!.hostEpoch).not.toBe(f.head().hostEpoch);
  } finally { await valid.dispose(); }
});

it("preserves cancelled retry tombstones through recovery and rejects their reuse", async () => {
  const f = await fixture(false, true), selected = {...f.scope, appId: "app", principalKey: "friend", operationId: id(5), revisionSha256: f.revision.revisionSha256};
  const attempts = createDatasetAttempts({db: f.db, transaction: f.transaction, account() {}});
  attempts.request(selected, {action: "save", idempotencyKey: "abandoned", input: {value: "private"}}, f.authorize);
  const reference = reviewDatasetAttempts(f.db, f.scope).entries[0]!.reference;
  f.transaction(() => cancelDatasetAttempt(f.db, f.scope, reference));
  const valid = await validateDatasetRecovery({staged: await f.stage(), authorize: f.authorize}), t = target(f, {allowOwnerRecoveryClaim: true});
  try {
    const input = {transferId: "cancelled-transfer", manifestSha256: recoveryManifestSha256(valid.manifest, limits), recovery: valid, authorize: f.authorize};
    await t.installer.install({}, input);
    t.installer.claim({}, {...f.scope, transferId: input.transferId, manifestSha256: input.manifestSha256, sourceCursor: f.head(), oldHostStopped: true, authorize: f.authorize});
    const callerKey = hash(JSON.stringify([selected.principalKey, {kind: "app", appId: selected.appId}]));
    expect(() => assertDatasetAttemptNotCancelled(t.db, f.scope, callerKey, "abandoned")).toThrow("cancelled");
    const restored = createDatasetAttempts({db: t.db, transaction: t.transaction, account() {}});
    expect(() => restored.request(selected, {action: "save", idempotencyKey: "abandoned", input: {}}, f.authorize)).toThrow("cancelled");
    expect(restored.request(selected, {action: "save", idempotencyKey: "new", input: {}}, f.authorize).attempt).not.toBeNull();
    expect(t.transaction(() => cancelDatasetAttempt(t.db, f.scope, reference))).toBe(0);
  } finally { await valid.dispose(); }
});
