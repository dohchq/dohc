import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { createDatasetJournal } from "@dohc/app-backend-runtime/journal";
import { prepareDatasetRecoveryExport } from "@dohc/app-backend-runtime/recovery-export";
import { createLocalDatasetTransfers } from "./localDatasetTransfer";
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
  let depth = 0; const transaction=<T>(run:()=>T):T=>{if(depth)return run(); db.exec("BEGIN IMMEDIATE");depth++;try{const result=run();db.exec("COMMIT");return result;}catch(error){db.exec("ROLLBACK");throw error;}finally{depth--;}};
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

it.each(["bound", "file IO"])("keeps authority active after %s export failure", async kind => {
  const f = await fixture(), limits = { maxTotalBytes: kind === "bound" ? 1 : 10 * 1024 * 1024 };
  const transfers = createLocalDatasetTransfers({ ...f, workspaceId: f.scope.workspaceId, exportDirectory: join(f.directory, "exports"), assertCurrent: f.authorize, limits,
    exportRecovery: async () => { if (kind === "file IO") throw new Error("disk refused"); return prepareDatasetRecoveryExport({ ...f, directory: join(f.directory, "exports"), limits }); } });
  const target = { async importRecovery(): Promise<never> { throw new Error("Target must not be called"); } };
  await expect(transfers.transfer({ datasetId: id(1), targetOrigin: "https://relay.example", target })).rejects.toThrow(kind === "bound" ? "storage reservation" : "disk refused");
  expect(transfers.status(id(1))).toBeNull();
  expect(f.journal.head(f.scope, f.authorize).active).toBe(true);
  expect(f.commit().kind).toBe("committed");
});
it.each(["record", "permission", "lifecycle", "attempt"])("refuses changed %s metadata before fencing a prepared archive", async kind => {
  const f = await fixture(), limits = { maxTotalBytes: 10 * 1024 * 1024 };
  const directory = join(f.directory, "exports");
  const transfers = createLocalDatasetTransfers({ ...f, workspaceId: f.scope.workspaceId, exportDirectory: directory, assertCurrent: f.authorize, limits,
    exportRecovery: async () => {
      const prepared = await prepareDatasetRecoveryExport({ ...f, directory, limits });
      if (kind === "record") f.commit();
      if (kind === "permission") f.db.prepare("INSERT INTO dohc_dataset_data_grants VALUES(?,?,?,?,?)").run(f.scope.workspaceId, id(1), "person", "{}", "new");
      if (kind === "lifecycle") f.db.prepare("INSERT INTO dohc_dataset_lifecycle VALUES(?,?,?,?,?,?)").run(f.scope.workspaceId, id(1), 0, 2, "", null);
      if (kind === "attempt") f.db.prepare("INSERT INTO dohc_dataset_attempts VALUES(?,?,?,?,?,?,?,?)").run(f.scope.workspaceId, id(1), "app", "owner", id(5), f.revision.revisionSha256, "{}", 2);
      return prepared;
    } });
  await expect(transfers.transfer({ datasetId: id(1), targetOrigin: "https://relay.example", target: { async importRecovery(): Promise<never> { throw Error("not reached"); } } })).rejects.toThrow("changed while it was being exported");
  expect(transfers.status(id(1))).toBeNull();
  expect(f.journal.head(f.scope, f.authorize).active).toBe(true);
  expect(await readdir(directory)).toEqual([]);
});
