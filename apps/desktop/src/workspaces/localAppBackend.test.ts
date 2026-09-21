import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import * as runtime from "@dohc/app-backend-runtime";
import { compileClosedApp } from "./closedAppCompiler";
import { prepareLocalAppPublication } from "./ownerAppPublication";
import { createLocalAppBackendHost, type LocalAppBackendHost, type LocalAppBackendRuntime } from "./localAppBackend";
import { parseLocalBackendRecovery, signLocalBackendRecovery } from "./localAppBackendRecovery";
import { openSyncRelayStorage } from "../../../../services/sync-relay/src/storage";
import { initializeAppBackendSchema } from "../../../../services/sync-relay/src/storage/appBackendSchema";
import { exportAppBackend, restoreAppBackend } from "../../../../services/sync-relay/src/storage/appBackendData";
import type { StorageContext } from "../../../../services/sync-relay/src/storage/context";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const schema = "CREATE TABLE orders(id TEXT PRIMARY KEY NOT NULL, quantity INTEGER NOT NULL);";
const source = `globalThis.operations = {
  order(ctx,input) { const rows=ctx.db.query('SELECT coalesce(sum(quantity),0) AS used FROM orders');
    if(rows[0].used+input.quantity>3) ctx.refuse('full','No stock remains.');
    ctx.db.execute('INSERT INTO orders VALUES(?,?)',[ctx.requestId,input.quantity]);
    if(input.fileId) ctx.files.attach(input.fileId);
    return {id:ctx.requestId,quantity:input.quantity}; },
  list(ctx) { return {rows:ctx.db.query('SELECT * FROM orders ORDER BY id')}; },
  receipt(ctx,input) { return {fileId:input.fileId}; }
};`;

async function prepared(backendSource = source, frontendSource = "document.body.textContent='Orders';") {
  const backend = {entryPath:"app/backend.ts",schemaPath:"app/schema.sql",dataPath:"data/orders.sqlite",schemaVersion:1,
    operations:[{name:"order",access:"link",readOnly:false},{name:"list",access:"owner",readOnly:true},{name:"receipt",access:"owner",readOnly:true}],
    tables:[{name:"orders",primaryKey:"id",readOperation:"list",writeOperation:"order"}]};
  const declaration={entryPath:"app/main.ts",inputs:["app/main.ts","app/backend.ts","app/schema.sql"],packageMap:{},backend};
  const sources = new Map([
    ["app/app.publish.json",Buffer.from(JSON.stringify(declaration))],
    ["app/main.ts",Buffer.from(frontendSource)],
    ["app/backend.ts",Buffer.from(backendSource)], ["app/schema.sql",Buffer.from(schema)],
  ]);
  const blobs = new Map<string,Uint8Array>();
  const adapter = new VersionedLiveAdapter({close(){},async sendRequest(request){
    const params=request.params as Record<string,unknown>;
    if(request.method==="versionedText.captureSources") {
      const files=[...(params.paths as string[])].sort().map(path=>{
        const bytes=sources.get(path)!,sha256=hash(bytes);blobs.set(sha256,bytes);
        return {path,objectId:path,contentKind:"text",sha256,byteLength:bytes.byteLength,latestMomentId:"m"};
      });
      return {id:request.id,result:{workspaceId:"w",versionId:"main",files,totalBytes:files.reduce((sum,file)=>sum+file.byteLength,0),
        sourceDigest:hash(JSON.stringify(["dohc-source-capture-v1","w","main",files]))}};
    }
    const bytes=blobs.get(String(params.sha256))!;
    return {id:request.id,result:{bytesBase64:Buffer.from(bytes).toString("base64"),byteLength:bytes.byteLength}};
  }},"owner",{workspaceId:"w"});
  return prepareLocalAppPublication({workspaceId:"w",appRoot:"app"},{adapter,compile:compileClosedApp,signal:new AbortController().signal,assertCurrent(){}});
}

const directories: string[]=[];
const hosts:LocalAppBackendHost[]=[];
async function open(root?:string, adapter:LocalAppBackendRuntime=runtime) {
  const workspaceRoot=root??await mkdtemp(join(tmpdir(),"dohc-local-backend-test-"));
  if(!root) directories.push(workspaceRoot);
  const host=await createLocalAppBackendHost({workspaceId:"w",workspaceRoot,runtime:adapter});
  hosts.push(host);return {host,workspaceRoot};
}
afterEach(async()=>{vi.useRealTimers();for(const host of hosts.splice(0))host.close();for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
const invoke=(host:LocalAppBackendHost,pub:{publicationId:string;authorityRevision:number},operation:string,idempotencyKey:string,input:unknown={})=>
  host.request(pub.publicationId,"invoke",{authorityRevision:pub.authorityRevision,operation,idempotencyKey,input}) as Promise<{result:any;revision:number;replayed:boolean}>;

describe("local app backend",()=>{
  it("runs captured source without an account, persists across restart, and replays a lost result",async()=>{
    const {host,workspaceRoot}=await open(),publication=await host.activate(await prepared());
    const first=await invoke(host,publication,"order","order-1",{quantity:2});
    expect(first.result.quantity).toBe(2);host.close();
    const restarted=(await open(workspaceRoot)).host;
    const replay=await invoke(restarted,publication,"order","order-1",{quantity:2});
    expect(replay).toEqual({...first,replayed:true});
    const listed=await invoke(restarted,publication,"list","read-1");
    expect(listed.result.rows).toHaveLength(1);expect(listed.revision).toBe(first.revision);
    await expect(invoke(restarted,publication,"order","order-1",{quantity:1})).rejects.toThrow(/retry key/);
    const exported=await restarted.request(publication.publicationId,"export",{authorityRevision:publication.authorityRevision}) as any;
    expect(Buffer.from(exported.snapshot.databaseBase64,"base64").subarray(0,16).toString()).toBe("SQLite format 3\0");
    expect(exported.receipts).toHaveLength(1);expect(exported.snapshot.source).toContain("operations");
    expect(parseLocalBackendRecovery(exported)).toEqual(exported);
  });
  it("serializes concurrent reservations across separate host instances",async()=>{
    const {host,workspaceRoot}=await open(),publication=await host.activate(await prepared()),other=(await open(workspaceRoot)).host;
    const outcomes=await Promise.allSettled([invoke(host,publication,"order","a",{quantity:2}),invoke(other,publication,"order","b",{quantity:2})]);
    expect(outcomes.filter(outcome=>outcome.status==="fulfilled")).toHaveLength(1);
    expect((await invoke(host,publication,"list","read")).result.rows).toHaveLength(1);
  });
  it("retains data on source updates and refuses stale publications",async()=>{
    const {host}=await open(),publication=await host.activate(await prepared());
    await invoke(host,publication,"order","first",{quantity:1});
    const next=await host.activate(await prepared(source.replace("No stock remains.","All stock is reserved.")));
    expect(next.publicationId).not.toBe(publication.publicationId);
    expect((await invoke(host,next,"list","read")).result.rows).toHaveLength(1);
    await expect(invoke(host,publication,"order","stale",{quantity:1})).rejects.toThrow(/unavailable/);
    await expect(invoke(host,next,"order","first",{quantity:1})).rejects.toThrow(/retry key/);
    const exact=await host.activate(await prepared(source.replace("No stock remains.","All stock is reserved.")));
    const accepted=await invoke(host,exact,"order","second",{quantity:1});
    const frontendUpdate=await host.activate(await prepared(source.replace("No stock remains.","All stock is reserved."),"document.body.textContent='Updated orders';"));
    expect(frontendUpdate.publicationId).not.toBe(exact.publicationId);
    expect(await invoke(host,frontendUpdate,"order","second",{quantity:1})).toEqual({...accepted,replayed:true});
  });
  it("fences an in-flight local operation when the owner chooses shared authority",async()=>{
    let evaluated!:()=>void, release!:()=>void;
    const waiting=new Promise<void>(resolve=>evaluated=resolve),resume=new Promise<void>(resolve=>release=resolve);
    const delayed={...runtime,async evaluateAppOperation(input:Parameters<typeof runtime.evaluateAppOperation>[0]){
      const result=await runtime.evaluateAppOperation(input);evaluated();await resume;return result;
    }};
    const {host}=await open(undefined,delayed),publication=await host.activate(await prepared());
    const operation=invoke(host,publication,"order","first",{quantity:1});
    await waiting;host.setSharedAuthority("data/orders.sqlite","shared-pub");release();
    await expect(operation).rejects.toThrow(/shared host/);
    const staleRead=await invoke(host,{...publication,authorityRevision:publication.authorityRevision+1},"list","stale-read");
    expect(staleRead.result.rows).toHaveLength(0);
    await expect(host.activate(await prepared())).rejects.toThrow(/shared host/);
  });
  it("keeps upload retries private and attaches files in the data commit",async()=>{
    const {host}=await open(),publication=await host.activate(await prepared());
    const body={authorityRevision:publication.authorityRevision,idempotencyKey:"upload-1",name:"receipt.png",contentType:"image/png",bytesBase64:Buffer.from("synthetic image").toString("base64")};
    const first=await host.request(publication.publicationId,"upload",body) as any;
    expect(await host.request(publication.publicationId,"upload",body)).toEqual({...first,replayed:true});
    await invoke(host,publication,"order","first",{quantity:1,fileId:first.file.fileId});
    const exported=await host.request(publication.publicationId,"export",{authorityRevision:publication.authorityRevision}) as any;
    expect(exported.files[0].attached_revision).toBe(2);
  });
  it("restores the portable bundle into an absent store and keeps retry receipts",async()=>{
    const {host}=await open(),approved=await prepared(),publication=await host.activate(approved);
    const first=await invoke(host,publication,"order","first",{quantity:2});
    const bundle=await host.request(publication.publicationId,"export",{authorityRevision:publication.authorityRevision});
    const other=(await open()).host,pending=await other.activate(approved,undefined,{initialize:false});
    expect(pending.active).toBe(false);
    await expect(invoke(other,pending,"list","read")).rejects.toThrow(/Restore/);
    await other.request(pending.publicationId,"restore",{authorityRevision:pending.authorityRevision,bundle});
    expect((await invoke(other,pending,"list","read")).result.rows).toHaveLength(1);
    expect(await invoke(other,pending,"order","first",{quantity:2})).toEqual({...first,replayed:true});
    await expect(other.request(pending.publicationId,"restore",{authorityRevision:pending.authorityRevision,bundle})).rejects.toThrow(/cannot replace/);
    const transfer=host.transfer("data/orders.sqlite","remote-publication");
    expect(parseLocalBackendRecovery(transfer)).toEqual(bundle);
    expect(host.transfer("data/orders.sqlite","remote-publication")).toEqual(transfer);
    await expect(invoke(host,{...publication,authorityRevision:publication.authorityRevision+1},"order","second",{quantity:1})).rejects.toThrow(/shared host/);
  });
  it("refuses corrupt recovery and structurally valid SQLite with a different schema",async()=>{
    const {host}=await open(),approved=await prepared(),publication=await host.activate(approved);
    const bundle=await host.request(publication.publicationId,"export",{authorityRevision:publication.authorityRevision}) as any;
    const other=(await open()).host,pending=await other.activate(approved,undefined,{initialize:false});
    await expect(other.request(pending.publicationId,"restore",{authorityRevision:pending.authorityRevision,bundle:{...bundle,integritySha256:"0".repeat(64)}})).rejects.toThrow(/integrity/);
    const wrong=await runtime.initializeAppDatabase({schemaSql:"CREATE TABLE orders(id TEXT PRIMARY KEY NOT NULL, secret TEXT);",tables:["orders"]});
    const {integritySha256:_,...payload}=bundle;
    payload.snapshot={...payload.snapshot,databaseBase64:Buffer.from(wrong).toString("base64")};
    payload.history=[{...payload.history[0],database_sha256:hash(wrong)}];
    await expect(other.request(pending.publicationId,"restore",{authorityRevision:pending.authorityRevision,bundle:signLocalBackendRecovery(payload)})).rejects.toThrow(/schema/i);
  });
  it("expires staged uploads after a day but preserves attached receipts",async()=>{
    const {host}=await open(),publication=await host.activate(await prepared());
    const input={authorityRevision:publication.authorityRevision,name:"receipt.pdf",contentType:"application/pdf",bytesBase64:Buffer.from("%PDF-synthetic").toString("base64")};
    const attached=await host.request(publication.publicationId,"upload",{...input,idempotencyKey:"attached"}) as any;
    await invoke(host,publication,"order","first",{quantity:1,fileId:attached.file.fileId});
    const staged=await host.request(publication.publicationId,"upload",{...input,idempotencyKey:"staged"}) as any;
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(Date.now()+86400001);
    const retried=await host.request(publication.publicationId,"upload",{...input,idempotencyKey:"staged"}) as any;
    expect(retried.file.fileId).not.toBe(staged.file.fileId);
    expect((await host.request(publication.publicationId,"file",{authorityRevision:publication.authorityRevision,fileId:attached.file.fileId}) as any).file).toEqual(attached.file);
  });
  it("moves the same data through relay recovery and back to a fresh local host",async()=>{
    const {host,workspaceRoot}=await open(),approved=await prepared(),publication=await host.activate(approved);
    const first=await invoke(host,publication,"order","first",{quantity:2});
    const bundle=host.transfer("data/orders.sqlite","shared-publication");
    const storage=openSyncRelayStorage(join(workspaceRoot,"relay.sqlite"));
    try{
      const context=storage as StorageContext;initializeAppBackendSchema(context.db);
      storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});
      const snapshot=bundle.snapshot;
      await restoreAppBackend(context,{...snapshot,publicationId:"shared-publication",publicationRevision:4,
        expectedRevision:null,nowMs:Date.now(),bundle,authorize(){},
        validateDatabase:database=>runtime.validateAppDatabase({database,schemaSql:schema,tables:["orders"]})});
      const shared=exportAppBackend(context,{workspaceId:"w",dataPath:"data/orders.sqlite",authorize(){}});
      const restored=(await open()).host,pending=await restored.activate(approved,undefined,{initialize:false});
      await restored.request(pending.publicationId,"restore",{authorityRevision:pending.authorityRevision,bundle:shared});
      expect((await invoke(restored,pending,"list","read")).result.rows).toHaveLength(1);
      expect(await invoke(restored,pending,"order","first",{quantity:2})).toEqual({...first,replayed:true});
    }finally{storage.close();}
  });
  it("serves only approved frontend bytes and operation-authorized attachments to the local browser",async()=>{
    const {host}=await open(),publication=await host.activate(await prepared());
    const browser=host.browserPublication(publication.publicationId);
    expect(()=>host.assertBrowserPublication(publication.publicationId,publication.authorityRevision)).not.toThrow();
    expect(()=>host.assertBrowserPublication(publication.publicationId,publication.authorityRevision+1)).toThrow(/approval changed/);
    expect(browser.files.map(file=>file.path)).toEqual(["bundle.js"]);
    expect(hash(browser.files[0]!.bytes)).toBe(browser.files[0]!.sha256);
    const upload=await host.request(publication.publicationId,"upload",{authorityRevision:publication.authorityRevision,
      name:"receipt.pdf",contentType:"application/pdf",idempotencyKey:"upload",bytesBase64:Buffer.from("%PDF-synthetic").toString("base64")}) as any;
    const request={authorityRevision:publication.authorityRevision,fileId:upload.file.fileId,operation:"receipt",input:{fileId:upload.file.fileId}};
    await expect(host.readBrowserFile(publication.publicationId,request)).rejects.toThrow(/unavailable/);
    await invoke(host,publication,"order","first",{quantity:1,fileId:upload.file.fileId});
    expect((await host.readBrowserFile(publication.publicationId,request)).file).toEqual(upload.file);
    await expect(host.readBrowserFile(publication.publicationId,{...request,operation:"order"})).rejects.toThrow(/read operation/);
    await expect(host.readBrowserFile(publication.publicationId,{...request,operation:"list"})).rejects.toThrow(/did not allow/);
    host.transfer("data/orders.sqlite","shared-pub");
    expect(()=>host.browserPublication(publication.publicationId)).toThrow(/shared host/);
    expect(()=>host.assertBrowserPublication(publication.publicationId,publication.authorityRevision)).toThrow(/approval changed/);
  });
  it("suppresses a private runtime refusal after shared authority replaces the local approval",async()=>{
    let evaluated!:()=>void,release!:()=>void;
    const waiting=new Promise<void>(resolve=>evaluated=resolve),resume=new Promise<void>(resolve=>release=resolve);
    const delayed={...runtime,async evaluateAppOperation(input:Parameters<typeof runtime.evaluateAppOperation>[0]){
      try{return await runtime.evaluateAppOperation(input);}catch(error){evaluated();await resume;throw error;}
    }};
    const {host}=await open(undefined,delayed),publication=await host.activate(await prepared(source.replace("No stock remains.","Private refusal from the previous approval.")));
    const pending=invoke(host,publication,"order","over-capacity",{quantity:4});
    await waiting;host.setSharedAuthority("data/orders.sqlite","shared-pub");release();
    await expect(pending).rejects.toThrow(/shared host/);
  });
  it("reevaluates a runtime refusal when its data snapshot has changed",async()=>{
    let evaluated!:()=>void,release!:()=>void,attempts=0;
    const waiting=new Promise<void>(resolve=>evaluated=resolve),resume=new Promise<void>(resolve=>release=resolve);
    const delayed={...runtime,async evaluateAppOperation(input:Parameters<typeof runtime.evaluateAppOperation>[0]){
      attempts++;
      if(attempts===1){evaluated();await resume;throw new runtime.AppBackendRuntimeError({code:"stale",message:"Private stale refusal."});}
      return runtime.evaluateAppOperation(input);
    }};
    const {host,workspaceRoot}=await open(undefined,delayed),publication=await host.activate(await prepared());
    const other=(await open(workspaceRoot)).host;
    const pending=invoke(host,publication,"list","read");
    await waiting;await invoke(other,publication,"order","first",{quantity:1});release();
    expect((await pending).result.rows).toHaveLength(1);expect(attempts).toBe(2);
  });
});
