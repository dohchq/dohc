import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { openSyncRelayStorage } from "../storage";
import type { StorageContext } from "./context";
import { initializeAppBackendSchema } from "./appBackendSchema";
import { activateAppBackend, commitAppBackendOperation, findAppBackendReceipt, stageAppBackendFile, readAppBackendFile, listAppBackendCallerFiles, exportAppBackend, restoreAppBackend, readAppBackendSnapshot, collectExpiredAppBackendFiles, setAppBackendHelper, isAppBackendHelper, APP_BACKEND_RECOVERY_BYTES, APP_BACKEND_RECOVERABLE_STORAGE_BYTES, APP_BACKEND_RECOVERY_ROWS, type CommitAppBackendOperationInput } from "./appBackendData";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function fixture(workspaceQuotaBytes?: number) {
  const dir = mkdtempSync(join(tmpdir(), "dohc-app-backend-"));
  cleanups.push(() => rmSync(dir, {recursive:true,force:true}));
  const path = join(dir, "relay.sqlite");
  let storage = openSyncRelayStorage(path,{workspaceQuotaBytes});
  let context = storage as StorageContext;
  cleanups.push(() => storage.close());
  initializeAppBackendSchema(context.db);
  storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});
  const authorize = () => {};
  const base = {workspaceId:"w",dataPath:"apps/fundraiser/data",appRoot:"apps/fundraiser",publicationId:"pub-1",publicationRevision:1,
    schemaSha256:"a".repeat(64),schemaVersion:1,sourceSha256:"b".repeat(64),source:"",capabilityJson:"{}",database:new Uint8Array([1]),expectedRevision:null,nowMs:2,authorize};
  // Empty source has its real digest; use a valid activation input.
  base.sourceSha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const snapshot = activateAppBackend(context,base);
  return {get storage(){return storage;},get context(){return context;},snapshot,authorize,
    restart(){ storage.close(); storage=openSyncRelayStorage(path,{workspaceQuotaBytes}); context=storage as StorageContext; },
    commit(patch:Partial<CommitAppBackendOperationInput>={}) {return commitAppBackendOperation(context,{
      workspaceId:"w",dataPath:base.dataPath,caller:{grantId:"g",principalId:"p"},idempotencyKey:"op",payloadSha256:"c".repeat(64),
      expectedRevision:1,publicationId:base.publicationId,publicationRevision:1,schemaSha256:base.schemaSha256,database:new Uint8Array([9]),
      changeset:new Uint8Array([8]),result:{accepted:true},attachedFileIds:[],nowMs:4,authorize,...patch});}};
}
describe("app backend durable store", () => {
  it("preserves snapshot, commits atomically, and replays an idempotent operation", () => {
    const f = fixture(), caller={grantId:"g",principalId:"p"};
    const uploaded = stageAppBackendFile(f.context,{...f.snapshot,caller,idempotencyKey:"upload-1",name:"receipt.png",contentType:"image/png",content:new Uint8Array([1,2,3]),nowMs:3,expiresAtMs:100,authorize:f.authorize});
    expect(uploaded.replayed).toBe(false);
    const result = commitAppBackendOperation(f.context,{workspaceId:f.snapshot.workspaceId,dataPath:f.snapshot.dataPath,caller,idempotencyKey:"op-1",payloadSha256:"c".repeat(64),expectedRevision:1,publicationId:"pub-1",publicationRevision:1,schemaSha256:f.snapshot.schemaSha256,database:new Uint8Array([9]),changeset:new Uint8Array([8]),result:{ok:true},attachedFileIds:[uploaded.file.fileId],nowMs:4,authorize:f.authorize});
    expect(result).toEqual({kind:"committed",revision:2,result:{ok:true}});
    expect(commitAppBackendOperation(f.context,{workspaceId:f.snapshot.workspaceId,dataPath:f.snapshot.dataPath,caller,idempotencyKey:"op-1",payloadSha256:"c".repeat(64),expectedRevision:1,publicationId:"pub-1",publicationRevision:1,schemaSha256:f.snapshot.schemaSha256,database:new Uint8Array([4]),changeset:new Uint8Array(),result:{ok:true},attachedFileIds:[],nowMs:5,authorize:f.authorize})).toEqual({kind:"replayed",revision:2,result:{ok:true}});
    expect(findAppBackendReceipt(f.context,{workspaceId:f.snapshot.workspaceId,dataPath:f.snapshot.dataPath,caller,idempotencyKey:"op-1",payloadSha256:"c".repeat(64)})).toEqual({revision:2,result:{ok:true}});
    expect(readAppBackendFile(f.context,{workspaceId:f.snapshot.workspaceId,dataPath:f.snapshot.dataPath,fileId:uploaded.file.fileId,authorize:f.authorize})?.content).toEqual(new Uint8Array([1,2,3]));
    expect(listAppBackendCallerFiles(f.context,{workspaceId:f.snapshot.workspaceId,dataPath:f.snapshot.dataPath,caller,nowMs:5})).toHaveLength(0);
    expect(exportAppBackend(f.context,{workspaceId:f.snapshot.workspaceId,dataPath:f.snapshot.dataPath,authorize:f.authorize}).history).toHaveLength(2);
  });
  it("refuses schema changes and stale compare-and-set", () => {
    const f=fixture();
    expect(() => activateAppBackend(f.context,{...f.snapshot,schemaSha256:"d".repeat(64),database:new Uint8Array([2]),expectedRevision:1,nowMs:3,authorize:f.authorize})).toThrow(/migration/);
    expect(commitAppBackendOperation(f.context,{workspaceId:f.snapshot.workspaceId,dataPath:f.snapshot.dataPath,caller:{grantId:"g",principalId:"p"},idempotencyKey:"x",payloadSha256:"c".repeat(64),expectedRevision:99,publicationId:"pub-1",publicationRevision:1,schemaSha256:f.snapshot.schemaSha256,database:new Uint8Array([4]),changeset:new Uint8Array(),result:null,attachedFileIds:[],nowMs:3,authorize:f.authorize})).toEqual({kind:"conflict"});
  });
  it("allows one competing writer and survives restart without exposing shared file or log data", () => {
    const f=fixture();
    expect(f.commit().kind).toBe("committed");
    expect(f.commit({idempotencyKey:"other"})).toEqual({kind:"conflict"});
    f.restart();
    expect(f.commit()).toEqual({kind:"replayed",revision:2,result:{accepted:true}});
    expect(readAppBackendSnapshot(f.context,f.snapshot)?.database).toEqual(new Uint8Array([9]));
    expect(f.context.db.prepare("SELECT COUNT(*) AS n FROM sync_relay_current_files WHERE workspace_id='w'").get()?.n).toBe(0);
    expect(f.storage.fetchLogPage({workspaceId:"w",sinceRelaySeq:0,limit:10}).rows).toEqual([]);
    expect(f.context.db.prepare("SELECT COUNT(*) AS n FROM sync_relay_blobs WHERE workspace_id='w'").get()?.n).toBe(0);
  });
  it("rechecks authority before receipts and binds replay to caller and payload", () => {
    const f=fixture(); f.commit();
    expect(() => f.commit({authorize(){throw new Error("revoked");}})).toThrow("revoked");
    expect(() => f.commit({payloadSha256:"d".repeat(64)})).toThrow(/another payload/);
    expect(f.commit({caller:{grantId:"g",principalId:"other"}})).toEqual({kind:"conflict"});
    expect(f.commit({publicationId:"old-publication"})).toEqual({kind:"conflict"});
  });
  it("rolls back snapshot and history when receipt insertion fails", () => {
    const f=fixture();
    f.context.db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON sync_relay_app_backend_receipts BEGIN SELECT RAISE(ABORT,'injected failure'); END;`);
    expect(() => f.commit()).toThrow("injected failure");
    const exported=exportAppBackend(f.context,{...f.snapshot,authorize:f.authorize});
    expect(exported.snapshot.revision).toBe(1); expect(Buffer.from(exported.snapshot.databaseBase64,"base64")).toEqual(Buffer.from([1]));
    expect(exported.history).toHaveLength(1); expect(exported.receipts).toHaveLength(0);
    f.context.db.exec("DROP TRIGGER fail_receipt");
    expect(f.commit().kind).toBe("committed");
  });
  it("preserves database and receipts on publication updates and fences prior publication", () => {
    const f=fixture(); f.commit();
    const activated=activateAppBackend(f.context,{...f.snapshot,publicationId:"pub-2",expectedRevision:2,database:new Uint8Array([0]),nowMs:5,authorize:f.authorize});
    expect(activated.database).toEqual(new Uint8Array([9])); expect(activated.revision).toBe(3);
    expect(f.commit()).toEqual({kind:"conflict"});
    const exported=exportAppBackend(f.context,{...f.snapshot,authorize:f.authorize});
    expect(exported.history).toHaveLength(3); expect(exported.receipts).toHaveLength(1);
    expect(() => activateAppBackend(f.context,{...activated,appRoot:"other",expectedRevision:3,nowMs:6,authorize:f.authorize})).toThrow(/binding/);
  });
  it("only attaches the caller's live uploads and keeps attached files during collection", () => {
    const f=fixture(), upload={...f.snapshot,caller:{grantId:"g",principalId:"p"},idempotencyKey:"u",name:"receipt.pdf",contentType:"application/pdf",content:new Uint8Array([1]),nowMs:3,expiresAtMs:20,authorize:f.authorize};
    const first=stageAppBackendFile(f.context,upload);
    expect(stageAppBackendFile(f.context,upload)).toEqual({...first,replayed:true});
    expect(readAppBackendFile(f.context,{...f.snapshot,fileId:first.file.fileId,authorize:f.authorize})).toBeNull();
    expect(() => stageAppBackendFile(f.context,{...upload,content:new Uint8Array([2])})).toThrow(/another payload/);
    expect(() => f.commit({caller:{grantId:"g",principalId:"other"},attachedFileIds:[first.file.fileId]})).toThrow();
    expect(f.commit({attachedFileIds:[first.file.fileId]}).kind).toBe("committed");
    stageAppBackendFile(f.context,{...upload,idempotencyKey:"expired"});
    expect(collectExpiredAppBackendFiles(f.context,20)).toBe(1);
    expect(readAppBackendFile(f.context,{...f.snapshot,fileId:first.file.fileId,authorize:f.authorize})).not.toBeNull();
    expect(() => readAppBackendFile(f.context,{...f.snapshot,fileId:first.file.fileId,authorize(){throw new Error("unauthorized");}})).toThrow("unauthorized");
  });
  it("bounds pending uploads per caller and releases capacity when they expire", () => {
    const f = fixture(), upload = {...f.snapshot, caller: {grantId:"g",principalId:"p"}, name:"file.txt",contentType:"text/plain",content:new Uint8Array([1]),nowMs:3,expiresAtMs:20,authorize:f.authorize};
    for (let index=0;index<32;index++) stageAppBackendFile(f.context,{...upload,idempotencyKey:`u-${index}`});
    expect(() => stageAppBackendFile(f.context,{...upload,idempotencyKey:"overflow"})).toThrow(/Submit pending uploads/);
    expect(stageAppBackendFile(f.context,{...upload,idempotencyKey:"u-0"}).replayed).toBe(true);
    expect(stageAppBackendFile(f.context,{...upload,caller:{grantId:"g",principalId:"other"},idempotencyKey:"other"}).replayed).toBe(false);
    expect(stageAppBackendFile(f.context,{...upload,nowMs:20,expiresAtMs:40,idempotencyKey:"after-expiry"}).replayed).toBe(false);
    expect(listAppBackendCallerFiles(f.context,{...f.snapshot,caller:upload.caller,nowMs:20})).toHaveLength(1);
  });
  it("reclaims expired staged bytes during upload admission before checking workspace quota", () => {
    const f=fixture(5000), upload={...f.snapshot,caller:{grantId:"g",principalId:"p"},name:"file.txt",contentType:"text/plain",content:new Uint8Array(2000),nowMs:3,expiresAtMs:20,authorize:f.authorize};
    const expired=stageAppBackendFile(f.context,{...upload,idempotencyKey:"expired"});
    expect(()=>stageAppBackendFile(f.context,{...upload,idempotencyKey:"before-expiry"})).toThrow(/quota/);
    const replacement=stageAppBackendFile(f.context,{...upload,idempotencyKey:"after-expiry",nowMs:20,expiresAtMs:40});
    expect(replacement.replayed).toBe(false);
    expect(f.context.db.prepare("SELECT 1 FROM sync_relay_app_backend_files WHERE file_id=?").get(expired.file.fileId)).toBeUndefined();
    expect(f.context.db.prepare("SELECT file_rows FROM sync_relay_app_backend_usage").get()?.file_rows).toBe(1);
  });
  it("charges all private data against workspace quota and removes it with the workspace", () => {
    const f=fixture(); f.commit();
    setAppBackendHelper(f.context,{...f.snapshot,grantId:"helper",enabled:true,nowMs:4,authorize:f.authorize});
    expect(isAppBackendHelper(f.context,{...f.snapshot,grantId:"helper"})).toBe(true);
    const tables=["sync_relay_app_backends","sync_relay_app_backend_history","sync_relay_app_backend_receipts","sync_relay_app_backend_files","sync_relay_app_backend_helpers"];
    const sum=tables.reduce((n,table)=>n+Number(f.context.db.prepare(`SELECT COALESCE(SUM(storage_bytes),0) AS n FROM ${table}`).get()?.n),0);
    expect(f.context.db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'").get()?.usage_bytes).toBe(sum);
    f.context.db.prepare("DELETE FROM sync_relay_workspaces WHERE workspace_id='w'").run();
    for (const table of tables) expect(f.context.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
  });
  it("refuses uploads and operations that exceed workspace quota without partial writes", () => {
    const f=fixture(10000);
    expect(() => f.commit({database:new Uint8Array(10000)})).toThrow(/quota/);
    expect(readAppBackendSnapshot(f.context,f.snapshot)?.revision).toBe(1);
    expect(() => stageAppBackendFile(f.context,{...f.snapshot,caller:{grantId:"g",principalId:"p"},idempotencyKey:"u",name:"receipt.png",contentType:"image/png",content:new Uint8Array(10000),nowMs:3,expiresAtMs:20,authorize:f.authorize})).toThrow(/quota/);
    expect(listAppBackendCallerFiles(f.context,{...f.snapshot,caller:{grantId:"g",principalId:"p"},nowMs:3})).toEqual([]);
  });
  it("recovers an absent store with receipts and attachments without resurrecting helper grants",async()=>{
    const f=fixture(), caller={grantId:"g",principalId:"p"};
    const {file}=stageAppBackendFile(f.context,{...f.snapshot,caller,idempotencyKey:"upload",name:"receipt.png",contentType:"image/png",content:new Uint8Array([1,2,3]),nowMs:3,expiresAtMs:100,authorize:f.authorize});
    f.commit({attachedFileIds:[file.fileId]});
    stageAppBackendFile(f.context,{...f.snapshot,caller,idempotencyKey:"unused",name:"unused.png",contentType:"image/png",content:new Uint8Array([1]),nowMs:3,expiresAtMs:100,authorize:f.authorize});
    setAppBackendHelper(f.context,{...f.snapshot,grantId:"helper",enabled:true,nowMs:5,authorize:f.authorize});
    const bundle=JSON.parse(JSON.stringify(exportAppBackend(f.context,{...f.snapshot,authorize:f.authorize})));
    expect(bundle.files).toHaveLength(1); expect(bundle).not.toHaveProperty("helpers");
    const target=fixture();
    target.context.db.prepare("DELETE FROM sync_relay_app_backends WHERE workspace_id='w'").run();
    let validations=0;
    const restored=await restoreAppBackend(target.context,{...target.snapshot,expectedRevision:null,bundle,nowMs:6,authorize:target.authorize,
      async validateDatabase(database){validations++; expect(database).toEqual(new Uint8Array([9]));}});
    expect(validations).toBe(1); expect(restored.revision).toBe(2);
    expect(target.commit()).toEqual({kind:"replayed",revision:2,result:{accepted:true}});
    expect(readAppBackendFile(target.context,{...target.snapshot,fileId:file.fileId,authorize:target.authorize})?.content).toEqual(new Uint8Array([1,2,3]));
    expect(isAppBackendHelper(target.context,{...target.snapshot,grantId:"helper"})).toBe(false);
    expect(exportAppBackend(target.context,{...target.snapshot,authorize:target.authorize}).history).toEqual(bundle.history);
    target.restart(); expect(target.commit().kind).toBe("replayed");
  });
  it("refuses rollback, corrupt recovery, schema mismatch, and validation failure without importing rows",async()=>{
    const f=fixture(); f.commit();
    const bundle=exportAppBackend(f.context,{...f.snapshot,authorize:f.authorize});
    const input={...f.snapshot,expectedRevision:null,bundle,nowMs:5,authorize:f.authorize,async validateDatabase(){}};
    await expect(restoreAppBackend(f.context,input)).rejects.toThrow(/existing app data/);
    f.context.db.prepare("DELETE FROM sync_relay_app_backends WHERE workspace_id='w'").run();
    await expect(restoreAppBackend(f.context,{...input,bundle:{...bundle,integritySha256:"0".repeat(64)}})).rejects.toThrow(/integrity/);
    await expect(restoreAppBackend(f.context,{...input,schemaVersion:2})).rejects.toThrow(/schema/);
    await expect(restoreAppBackend(f.context,{...input,async validateDatabase(){throw new Error("invalid SQLite schema");}})).rejects.toThrow(/SQLite/);
    expect(readAppBackendSnapshot(f.context,f.snapshot)).toBeNull();
    expect(f.context.db.prepare("SELECT COUNT(*) AS n FROM sync_relay_app_backend_receipts").get()?.n).toBe(0);
  });
  it("rechecks authority and store absence after asynchronous recovery validation",async()=>{
    const f=fixture(), bundle=exportAppBackend(f.context,{...f.snapshot,authorize:f.authorize});
    f.context.db.prepare("DELETE FROM sync_relay_app_backends WHERE workspace_id='w'").run();
    let authorized=true;
    const input={...f.snapshot,expectedRevision:null,bundle,nowMs:5,authorize(){if(!authorized)throw new Error("revoked");},async validateDatabase(){authorized=false;}};
    await expect(restoreAppBackend(f.context,input)).rejects.toThrow("revoked");
    expect(readAppBackendSnapshot(f.context,f.snapshot)).toBeNull();
    authorized=true;
    await expect(restoreAppBackend(f.context,{...input,async validateDatabase(){activateAppBackend(f.context,{...f.snapshot,expectedRevision:null,nowMs:4,authorize:f.authorize});}})).rejects.toThrow(/initialized during recovery/);
    expect(readAppBackendSnapshot(f.context,f.snapshot)?.revision).toBe(1);
  });
  it("keeps every accepted attachment exportable when the app reaches its recovery budget",async()=>{
    const f=fixture(256*1024*1024), caller={grantId:"g",principalId:"p"}, attachedFileIds:string[]=[];
    const content=new Uint8Array(5*1024*1024);
    for(let index=0;index<12;index++) attachedFileIds.push(stageAppBackendFile(f.context,{...f.snapshot,caller,idempotencyKey:`file-${index}`,name:`receipt-${index}.png`,contentType:"image/png",content,nowMs:3,expiresAtMs:100,authorize:f.authorize}).file.fileId);
    expect(f.commit({attachedFileIds}).kind).toBe("committed");
    const before=f.context.db.prepare("SELECT * FROM sync_relay_app_backend_usage").get();
    expect(Number(before?.storage_bytes)).toBeLessThan(APP_BACKEND_RECOVERABLE_STORAGE_BYTES);
    expect(()=>stageAppBackendFile(f.context,{...f.snapshot,caller,idempotencyKey:"file-overflow",name:"overflow.png",contentType:"image/png",content,nowMs:5,expiresAtMs:100,authorize:f.authorize})).toThrow(/recovery capacity/);
    expect(f.context.db.prepare("SELECT * FROM sync_relay_app_backend_usage").get()).toEqual(before);
    const exported=exportAppBackend(f.context,{...f.snapshot,authorize:f.authorize});
    expect(exported.files).toHaveLength(12);
    expect(Buffer.byteLength(JSON.stringify(exported))).toBeLessThan(APP_BACKEND_RECOVERY_BYTES);
    const target=fixture(256*1024*1024); target.context.db.prepare("DELETE FROM sync_relay_app_backends WHERE workspace_id='w'").run();
    const restored=await restoreAppBackend(target.context,{...target.snapshot,expectedRevision:null,bundle:exported,nowMs:10,authorize:target.authorize,async validateDatabase(){}});
    expect(restored.revision).toBe(2);
    expect(target.context.db.prepare("SELECT COUNT(*) AS n FROM sync_relay_app_backend_files").get()?.n).toBe(12);
  },30000);
  it("uses atomic accounting for byte and row admission and rejects without partial writes",()=>{
    const f=fixture();
    const usage=f.context.db.prepare("SELECT * FROM sync_relay_app_backend_usage").get()!;
    f.context.db.prepare("UPDATE sync_relay_app_backend_usage SET storage_bytes=?").run(APP_BACKEND_RECOVERABLE_STORAGE_BYTES);
    expect(()=>f.commit()).toThrow(/recovery capacity/);
    expect(()=>activateAppBackend(f.context,{...f.snapshot,expectedRevision:1,publicationId:"upgrade",nowMs:5,authorize:f.authorize})).toThrow(/recovery capacity/);
    expect(readAppBackendSnapshot(f.context,f.snapshot)?.revision).toBe(1);
    f.context.db.prepare("UPDATE sync_relay_app_backend_usage SET storage_bytes=?,history_rows=?").run(usage.storage_bytes,APP_BACKEND_RECOVERY_ROWS);
    expect(()=>f.commit()).toThrow(/recovery capacity/);
    f.context.db.prepare("UPDATE sync_relay_app_backend_usage SET history_rows=?,receipt_rows=?").run(usage.history_rows,APP_BACKEND_RECOVERY_ROWS);
    expect(()=>f.commit()).toThrow(/recovery capacity/);
    f.context.db.prepare("UPDATE sync_relay_app_backend_usage SET receipt_rows=?,file_rows=?").run(usage.receipt_rows,APP_BACKEND_RECOVERY_ROWS);
    expect(()=>stageAppBackendFile(f.context,{...f.snapshot,caller:{grantId:"g",principalId:"p"},idempotencyKey:"file",name:"receipt.png",contentType:"image/png",content:new Uint8Array([1]),nowMs:5,expiresAtMs:100,authorize:f.authorize})).toThrow(/recovery capacity/);
    f.context.db.prepare("UPDATE sync_relay_app_backend_usage SET file_rows=?").run(usage.file_rows);
    expect(exportAppBackend(f.context,{...f.snapshot,authorize:f.authorize}).snapshot.revision).toBe(1);
  });
  it("repeated recovery preserves data revision and can bind the same source to current publication authority",async()=>{
    const original=fixture(); original.commit();
    let bundle=exportAppBackend(original.context,{...original.snapshot,authorize:original.authorize});
    for(let index=0;index<3;index++){
      const target=fixture(); target.context.db.prepare("DELETE FROM sync_relay_app_backends WHERE workspace_id='w'").run();
      const snapshot=await restoreAppBackend(target.context,{...target.snapshot,publicationId:`recovered-${index}`,expectedRevision:null,bundle,nowMs:100+index,authorize:target.authorize,async validateDatabase(){}});
      expect(snapshot.revision).toBe(2); expect(snapshot.updatedAtMs).toBe(4);
      bundle=exportAppBackend(target.context,{...snapshot,authorize:target.authorize});
      expect(bundle.history).toHaveLength(2);
    }
  });
});
