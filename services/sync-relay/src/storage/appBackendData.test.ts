import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { openSyncRelayStorage } from "../storage";
import type { StorageContext } from "./context";
import { initializeAppBackendSchema } from "./appBackendSchema";
import { activateAppBackend, commitAppBackendOperation, findAppBackendReceipt, stageAppBackendFile, readAppBackendFile, listAppBackendCallerFiles, exportAppBackend, readAppBackendSnapshot, collectExpiredAppBackendFiles, setAppBackendHelper, isAppBackendHelper, type CommitAppBackendOperationInput } from "./appBackendData";

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
    expect(listAppBackendCallerFiles(f.context,{workspaceId:f.snapshot.workspaceId,dataPath:f.snapshot.dataPath,caller,nowMs:5})).toHaveLength(1);
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
    expect(exported.snapshot.revision).toBe(1); expect(exported.snapshot.database).toEqual(new Uint8Array([1]));
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
});
