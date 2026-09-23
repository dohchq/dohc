import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { createDatasetJournal } from "./journal.ts";
import { prepareDatasetRecoveryExport } from "./recovery-export.ts";
import { recoveryManifestSha256, stageDatasetRecovery } from "./recovery.ts";
import { cancelDatasetAttempt, createDatasetAttempts, reviewDatasetAttempts } from "./dataset-attempts.ts";
const hash=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const schemaSql="CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT NOT NULL);";
const source="globalThis.operations={read(ctx){return ctx.db.query('SELECT * FROM items')}};";
const definition:DatasetDefinition={formatVersion:1,datasetId:id(1),name:"Items",schemaPath:"schema.sql",operationsPath:"operations.js",
  tables:[{tableId:id(2),name:"Items",sqlName:"items",primaryKey:"id",fields:[{fieldId:id(3),name:"ID",sqlColumn:"id",type:"number",required:true,unique:true},{fieldId:id(4),name:"Value",sqlColumn:"value",type:"text",required:true,unique:false}]}],
  operations:[{operationId:id(5),name:"read",label:"Read",tableId:id(2),kind:"read",access:"owner",readOnly:true,fieldIds:[id(3),id(4)]}]};
async function fixture(){const directory=await mkdtemp(join(tmpdir(),"dohc-export-test-")),db=new DatabaseSync(join(directory,"host.sqlite"));
  const data=new DatabaseSync(join(directory,"seed.sqlite"));data.exec(schemaSql);data.close();const checkpoint=await readFile(join(directory,"seed.sqlite"));
  const transaction=<T>(run:()=>T):T=>{db.exec("BEGIN IMMEDIATE");try{const result=run();db.exec("COMMIT");return result;}catch(error){db.exec("ROLLBACK");throw error;}};
  const journal=createDatasetJournal({db,transaction}),scope={workspaceId:"workspace",datasetId:id(1)},revision=describeDatasetRevision({definition,revision:1,schemaSql,operationSource:source});
  db.exec("CREATE TABLE dohc_dataset_lifecycle(workspace_id,dataset_id,archived,generation,reason,archived_at_ms); CREATE TABLE dohc_dataset_catalog(workspace_id,dataset_id,revision_json,artifacts_json); CREATE TABLE dohc_dataset_catalog_history(workspace_id,dataset_id,revision,revision_json,artifacts_json); CREATE TABLE dohc_dataset_bindings(workspace_id,dataset_id,app_id,binding_json,token); CREATE TABLE dohc_dataset_data_grants(workspace_id,dataset_id,principal_key,grant_json,token);");
  db.prepare("INSERT INTO dohc_dataset_catalog VALUES(?,?,?,?)").run(scope.workspaceId,scope.datasetId,JSON.stringify(revision),JSON.stringify({schemaSql,operationSource:source}));
  let allowed=true;
  const authorize=()=>{if(!allowed)throw new Error("revoked");};
  const cursor=journal.initialize({scope,hostEpoch:"host",approvedRevisionHash:revision.revisionSha256,source,schemaSql,definitionJson:JSON.stringify(revision),checkpoint,authorize});
  cleanups.push(async()=>{db.close();await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:25});});
  function commit(expected=cursor,key="request"){return journal.commitOperation({expected,proposalId:key,operation:"read",callerKey:"owner",idempotencyKey:key,payloadSha256:hash(key),resultJson:"{}",changeset:new Uint8Array(),changesetSha256:hash(new Uint8Array()),attachedFileIds:[],authorize});}
  return{db,journal,scope,revision,cursor,directory,checkpoint,authorize,commit,transaction,revoke(){allowed=false;}};
}
it("streams an empty dataset with its approved originals and no fabricated event",async()=>{
  const f=await fixture(),limits={maxTotalBytes:10*1024*1024};
  const prepared=await prepareDatasetRecoveryExport({...f,directory:join(f.directory,"exports"),limits});
  expect(prepared.manifest.cursor).toEqual(f.cursor);expect(prepared.manifest.entries.map(entry=>entry.kind)).toEqual(["checkpoint","artifact","artifact","artifact","history"]);
  const staged=await stageDatasetRecovery({stream:prepared.stream(),authorize:f.authorize,limits,stagingParent:f.directory,expectedManifestSha256:recoveryManifestSha256(prepared.manifest,limits)});
  expect(await readFile(staged.files.find(file=>file.entry.id==="checkpoint")!.path)).toEqual(f.checkpoint);
  await staged.dispose();await prepared.dispose();expect(await readdir(join(f.directory,"exports"))).toEqual([]);
});
it("pins events while later writes continue and refuses revoked stream disclosure",async()=>{
  const f=await fixture();const saved=f.commit();if(saved.kind!=="committed")throw Error();
  const prepared=await prepareDatasetRecoveryExport({...f,directory:join(f.directory,"exports"),limits:{maxTotalBytes:10*1024*1024}});
  f.commit(saved.event.cursor,"later");expect(prepared.manifest.cursor.revision).toBe(1);
  const iterator=prepared.stream();expect((await iterator.next()).done).toBe(false);f.revoke();await expect(iterator.next()).rejects.toThrow("revoked");await prepared.dispose();
});
it("does not label an export complete when a committed attachment is absent",async()=>{
  const f=await fixture();f.journal.commitOperation({expected:f.cursor,proposalId:"attachment",operation:"create",callerKey:"owner",idempotencyKey:"attachment",payloadSha256:hash("attachment"),resultJson:"{}",changeset:new Uint8Array(),changesetSha256:hash(new Uint8Array()),attachedFileIds:["receipt_file_0001"],authorize:f.authorize,accountAndAttach(){}});
  await expect(prepareDatasetRecoveryExport({...f,directory:join(f.directory,"exports"),limits:{maxTotalBytes:10*1024*1024}})).rejects.toThrow("attachment inventory");
  expect(await readdir(join(f.directory,"exports"))).toEqual([]);
});
it("rejects tombstone-only changes during export before fencing the source", async () => {
  const f = await fixture();
  const prepared = await prepareDatasetRecoveryExport({ ...f, directory: join(f.directory, "exports"), limits: { maxTotalBytes: 10 * 1024 * 1024 } });
  const stream = prepared.stream();
  try {
    expect(() => prepared.assertUnchanged()).not.toThrow();
    expect((await stream.next()).done).toBe(false);
    const attempts = createDatasetAttempts({ db: f.db, transaction: f.transaction, account() {} });
    const scope = { ...f.scope, appId: "form", principalKey: "friend", operationId: id(5), revisionSha256: f.revision.revisionSha256 };
    attempts.request(scope, { action: "save", idempotencyKey: "abandoned", input: { value: "private" } }, f.authorize);
    const reference = reviewDatasetAttempts(f.db, f.scope).entries[0]!.reference;
    f.transaction(() => cancelDatasetAttempt(f.db, f.scope, reference));
    for await (const _chunk of stream) { /* Complete the pinned archive before the transfer fence. */ }
    expect(reviewDatasetAttempts(f.db, f.scope).entries).toEqual([]);
    expect(f.journal.head(f.scope, f.authorize).cursor).toEqual(prepared.manifest.cursor);
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM dohc_dataset_cancelled_attempts").get()!.count).toBe(1);
    expect(() => {
      prepared.assertUnchanged();
      f.journal.fence({ expected: prepared.manifest.cursor, authorize: f.authorize });
    }).toThrow("changed while it was being exported");
    expect(f.journal.head(f.scope, f.authorize).active).toBe(true);
  } finally { await stream.return(undefined); await prepared.dispose(); }
});
