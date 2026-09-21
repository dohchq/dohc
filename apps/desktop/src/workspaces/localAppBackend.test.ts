import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import * as runtime from "@dohc/app-backend-runtime";
import { compileClosedApp } from "./closedAppCompiler";
import { prepareLocalAppPublication } from "./ownerAppPublication";
import { createLocalAppBackendHost, type LocalAppBackendHost, type LocalAppBackendRuntime } from "./localAppBackend";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const schema = "CREATE TABLE orders(id TEXT PRIMARY KEY NOT NULL, quantity INTEGER NOT NULL);";
const source = `globalThis.operations = {
  order(ctx,input) { const rows=ctx.db.query('SELECT coalesce(sum(quantity),0) AS used FROM orders');
    if(rows[0].used+input.quantity>3) ctx.refuse('full','No stock remains.');
    ctx.db.execute('INSERT INTO orders VALUES(?,?)',[ctx.requestId,input.quantity]);
    if(input.fileId) ctx.files.attach(input.fileId);
    return {id:ctx.requestId,quantity:input.quantity}; },
  list(ctx) { return {rows:ctx.db.query('SELECT * FROM orders ORDER BY id')}; }
};`;

async function prepared(backendSource = source) {
  const backend = {entryPath:"app/backend.ts",schemaPath:"app/schema.sql",dataPath:"data/orders.sqlite",schemaVersion:1,
    operations:[{name:"order",access:"link",readOnly:false},{name:"list",access:"owner",readOnly:true}],
    tables:[{name:"orders",primaryKey:"id",readOperation:"list",writeOperation:"order"}]};
  const declaration={entryPath:"app/main.ts",inputs:["app/main.ts","app/backend.ts","app/schema.sql"],packageMap:{},backend};
  const sources = new Map([
    ["app/app.publish.json",Buffer.from(JSON.stringify(declaration))],
    ["app/main.ts",Buffer.from("document.body.textContent='Orders';")],
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
afterEach(async()=>{for(const host of hosts.splice(0))host.close();for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
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
    expect(Buffer.from(exported.databaseBase64,"base64").subarray(0,16).toString()).toBe("SQLite format 3\0");
    expect(exported.receipts).toHaveLength(1);expect(exported.artifacts.map((file:any)=>file.path)).toContain("backend.js");
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
});
