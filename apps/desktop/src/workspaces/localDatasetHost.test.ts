import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { createLocalDatasetHost, type LocalDatasetHost, type LocalDatasetHostOptions } from "./localDatasetHost";
import { compileClosedApp } from "./closedAppCompiler";
import { stageDatasetRecovery, recoveryManifestSha256 } from "@dohc/app-backend-runtime/recovery";
import { writeDatasetRecoveryExport } from "./datasetRecoveryExport";
import { fixture as relayFixture, limits as relayLimits } from "../../../../services/sync-relay/src/appBackendTestFixture";
import { createSyncRelayHandler } from "../../../../services/sync-relay/src/server";
import { createDatasetAuthorityRouter, createRemoteDatasetData, createRemoteDatasetTransferTarget } from "./remoteDataset";
import { readDatasetResponse } from "../ipc/readDatasetResponse";
import { createDatasetReplica } from "@dohc/app-backend-runtime/replica";
import { stageDatasetRecovery } from "@dohc/app-backend-runtime/recovery";

vi.setConfig({ testTimeout: 20_000 });
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = {formatVersion: 1, datasetId: id(1), name: "Items", schemaPath: "items/schema.sql", operationsPath: "items/operations.ts",
  tables: [{tableId: id(2), name: "Items", sqlName: "items", primaryKey: "id", fields: [
    {fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true},
    {fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false},
  ]}], operations: [
    {operationId: id(5), name: "list", label: "List items", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3), id(4)]},
    {operationId: id(6), name: "add", label: "Add item", tableId: id(2), kind: "create", access: "owner", readOnly: false, fieldIds: [id(4)]},
  ]};
const schemaSql = "CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL);";
// Type annotations prove activation executes the compiled capture, not raw TypeScript.
const source = `globalThis.operations={
  list(ctx: any) {return ctx.db.query('SELECT id,name FROM items ORDER BY id');},
  add(ctx: any,input: any) {if(input.fileId)ctx.files.attach(input.fileId);ctx.db.execute('INSERT INTO items VALUES(?,?)',[ctx.requestId,input.name]);return {name:input.name};}
};`;
function sources() {
  const files = new Map([["items/dataset.json", JSON.stringify(definition)], [definition.schemaPath, schemaSql], [definition.operationsPath, source]]);
  const blobs = new Map<string, Uint8Array>();
  const adapter = new VersionedLiveAdapter({close() {}, async sendRequest(request) {
    const params = request.params as Record<string, unknown>;
    if (request.method === "versionedText.captureSources") {
      const selected = [...params.paths as string[]].sort().map(path => {
        const bytes = Buffer.from(files.get(path)!), sha256 = digest(bytes); blobs.set(sha256, bytes);
        return {path,objectId:path,contentKind:"text",sha256,byteLength:bytes.byteLength,latestMomentId:"m"};
      });
      return {id:request.id,result:{workspaceId:"w",versionId:"main",files:selected,totalBytes:selected.reduce((sum,file)=>sum+file.byteLength,0),
        sourceDigest:digest(JSON.stringify(["dohc-source-capture-v1","w","main",selected]))}};
    }
    const bytes = blobs.get(String(params.sha256))!;
    return {id:request.id,result:{bytesBase64:Buffer.from(bytes).toString("base64"),byteLength:bytes.byteLength}};
  }},"owner",{workspaceId:"w"});
  return {adapter, files};
}
const roots: string[] = [], hosts: LocalDatasetHost[] = [];
async function open(extra: Partial<LocalDatasetHostOptions> = {}) {
  const workspaceRoot = extra.workspaceRoot ?? await mkdtemp(join(tmpdir(), "dohc-local-dataset-test-"));
  if (!extra.workspaceRoot) roots.push(workspaceRoot);
  const host = await createLocalDatasetHost({workspaceId: "w", workspaceRoot, capacityBytes: 1024 * 1024, ...extra});
  hosts.push(host); return {host, workspaceRoot};
}
async function activate(host: LocalDatasetHost, fixture = sources()) {
  const prepared = await host.prepare({descriptorPath: "items/dataset.json", adapter: fixture.adapter});
  const revision = await host.approve({preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256});
  return {prepared, revision, fixture};
}
const call = (approved: Awaited<ReturnType<typeof activate>>, operationId: string, idempotencyKey = "read", input = {}) =>
  ({datasetId: id(1), revision: approved.revision.revision, revisionSha256: approved.revision.revisionSha256, operationId, idempotencyKey, input});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});

describe("local dataset owner adapter", () => {
  it("restores a chosen active backup only after owner claim and preserves files and retry history", async () => {
    const sourceHost = await open(), approved = await activate(sourceHost.host);
    const bytesBase64 = Buffer.from("%PDF-recovery-receipt").toString("base64");
    const upload = {datasetId:id(1),revision:1,revisionSha256:approved.revision.revisionSha256,idempotencyKey:"recovery-file",name:"receipt.pdf",contentType:"application/pdf",bytesBase64};
    const uploaded = await sourceHost.host.upload(upload);
    const invocation = call(approved,id(6),"recovery-write",{name:"Saved",fileId:uploaded.file.fileId});
    const committed = await sourceHost.host.invoke(invocation);
    const archive = await sourceHost.host.prepareExport(id(1));
    const sourcePath = join(sourceHost.workspaceRoot,"backup.dohc-recovery");
    await writeDatasetRecoveryExport({path:sourcePath,stream:archive.stream(),signal:new AbortController().signal,maxBytes:archive.maxBytes,authorize(){}});
    await archive.dispose();
    const target = await open();
    const prepared = await target.host.prepareRecovery({sourcePath});
    expect(target.host.list().datasets).toEqual([]);
    await expect(target.host.claimRecovery(prepared)).rejects.toThrow(/old host stopped/);
    expect(target.host.list().datasets).toEqual([]);
    await sourceHost.host.close();
    const claim = {...prepared,oldHostStopped:true as const};
    const restored = await target.host.claimRecovery(claim);
    expect(restored.targetCursor?.hostEpoch).not.toBe(prepared.sourceCursor.hostEpoch);
    expect(restored.targetCursor?.revision).toBe(prepared.sourceCursor.revision+1);
    expect((await target.host.query(call(approved,id(5)))).result).toEqual([expect.objectContaining({name:"Saved"})]);
    expect((await target.host.file({...upload,fileId:uploaded.file.fileId})).bytesBase64).toBe(bytesBase64);
    expect(await target.host.invoke(invocation)).toEqual({...committed,replayed:true});
    expect(await target.host.claimRecovery(claim)).toEqual(restored);
    await expect(target.host.prepareRecovery({sourcePath})).rejects.toThrow(/already exists/);
    expect((await target.host.query(call(approved,id(5)))).result).toHaveLength(1);
    await target.host.close();
    const restarted = await open({workspaceRoot:target.workspaceRoot});
    expect(await restarted.host.claimRecovery(claim)).toEqual(restored);
  });

  it("discards preparation, rejects damaged or foreign backups, and leaves the target absent", async () => {
    const sourceHost = await open(); await activate(sourceHost.host);
    const archive = await sourceHost.host.prepareExport(id(1));
    const sourcePath = join(sourceHost.workspaceRoot,"backup.dohc-recovery");
    await writeDatasetRecoveryExport({path:sourcePath,stream:archive.stream(),signal:new AbortController().signal,maxBytes:archive.maxBytes,authorize(){}}); await archive.dispose();
    const target = await open(), prepared = await target.host.prepareRecovery({sourcePath});
    await target.host.discardRecovery(prepared.transferId);
    expect(target.host.list().datasets).toEqual([]);
    expect(await readdir(join(target.workspaceRoot,".dohc","datasets","exports"))).toEqual([]);
    await expect(target.host.claimRecovery({...prepared,oldHostStopped:true})).rejects.toThrow(/not installed/);
    const foreign = await open({workspaceId:"other"});
    await expect(foreign.host.prepareRecovery({sourcePath})).rejects.toThrow(/another workspace/);
    const bytes = await readFile(sourcePath); await writeFile(sourcePath,bytes.subarray(0,bytes.length-5));
    await expect(target.host.prepareRecovery({sourcePath})).rejects.toThrow(/truncated/);
    expect(target.host.list().datasets).toEqual([]);
    expect(await readdir(join(target.workspaceRoot,".dohc","datasets","exports"))).toEqual([]);
  });

  it("exports an actual committed dataset and receipt to a streamed recovery file", async () => {
    const {host} = await open(), approved = await activate(host);
    const attachment = Buffer.from("%PDF-synthetic-recovery-receipt");
    const uploaded = await host.upload({datasetId:id(1),revision:approved.revision.revision,revisionSha256:approved.revision.revisionSha256,
      idempotencyKey:"export-attachment",name:"receipt.pdf",contentType:"application/pdf",bytesBase64:attachment.toString("base64")});
    await host.action(call(approved,id(6),"export-write",{name:"Camera",fileId:uploaded.file.fileId}));
    const directory = await mkdtemp(join(tmpdir(),"dohc-recovery-destination-")); roots.push(directory);
    const archive = await host.prepareExport(id(1));
    try {
      const path = join(directory,"items.dohc-recovery");
      const saved = await writeDatasetRecoveryExport({path,stream:archive.stream(),maxBytes:archive.maxBytes,
        signal:new AbortController().signal,authorize(){}});
      expect(saved.byteLength).toBeGreaterThan(4096);
      const limits = {maxTotalBytes:archive.maxBytes};
      const staged = await stageDatasetRecovery({stream:createReadStream(path),stagingParent:directory,limits,authorize(){},
        expectedManifestSha256:recoveryManifestSha256(archive.manifest,limits)});
      try {
        expect(staged.manifest.cursor.datasetId).toBe(id(1));
        const receipt = staged.files.find(file=>file.entry.kind==="attachment")!;
        expect(await readFile(receipt.path)).toEqual(attachment);
        const artifact = staged.files.find(file=>file.entry.role==="source")!;
        expect(await readFile(artifact.path,"utf8")).toBe(source);
      } finally { await staged.dispose(); }
    } finally { await archive.dispose(); }
  });
  it("moves actual local records and attachments to the relay and recovers a lost response after both hosts restart", async () => {
    const f = relayFixture(), remoteDirectory = await mkdtemp(join(tmpdir(),"dohc-transfer-relay-"));
    const compileOperations = async (source:string,path:string) => {
      const bytes=Buffer.from(source),built=await compileClosedApp({entryPath:path,inputs:[{path,bytes,sha256:digest(bytes)}],packageMap:{},bounds:{maxInputFiles:1,maxInputBytes:256*1024,maxOutputBytes:256*1024}});
      return Buffer.from(built.files[0]!.bytes).toString("utf8");
    };
    let relayHost = await f.storage.createDatasetHost({directory:remoteDirectory,limits:relayLimits,compileOperations,onShutdownError(error){throw error;}});
    const controller=new AbortController(); let offline=false,posted=0;
    const handler=()=>createSyncRelayHandler({storage:f.storage,datasetHost:relayHost,appBackendsEnabled:true,appPublicationLimits:relayLimits,
      resolveActor(request,workspaceId){if(request.headers.get("authorization")!=="Bearer token")throw Error("credentials");return {workspaceId,userId:"owner"};}});
    const credentials={serverUrl:"https://account",relayUrl:"https://relay",token:"token",userId:"owner",email:"owner@example.test"};
    const transport=async (_credentials:typeof credentials,path:string,init:RequestInit)=>{
      if(offline)throw Error("offline after response loss");
      const request=new Request(`https://relay${path}`,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),authorization:"Bearer token"},...(init.body instanceof ReadableStream?{duplex:"half" as const}:{})});
      const response=await handler()(request),value=path.includes("/imports/")?await response.json():await readDatasetResponse(response,path.split("/").at(-1)!,controller.signal);
      if(!response.ok)throw Error(`Relay ${response.status}: ${JSON.stringify(value)}`);
      if(path.includes("/imports/")&&init.method==="POST"){posted++;offline=true;throw Error("lost import response");}
      return value;
    };
    const target=()=>createRemoteDatasetTransferTarget({workspaceId:"w",datasetId:id(1),origin:"https://relay",credentials,credentialGeneration:1,currentCredentialGeneration:()=>1,signal:controller.signal,assertCurrent(){},relayStream:transport});
    try{
      const local=await open(),approved=await activate(local.host);
      const bytesBase64=Buffer.from("%PDF-transfer-actual-file").toString("base64"),upload={datasetId:id(1),revision:1,revisionSha256:approved.revision.revisionSha256,idempotencyKey:"receipt",name:"receipt.pdf",contentType:"application/pdf",bytesBase64};
      const file=await local.host.upload(upload),mutation=call(approved,id(6),"before-transfer",{name:"First",fileId:file.file.fileId});
      await local.host.action(mutation);
      await expect(local.host.transferToShared({datasetId:id(1),targetOrigin:"https://relay",target:target()})).rejects.toThrow("lost import response");
      expect(local.host.transferStatus(id(1))?.state).toBe("ready");
      await expect(local.host.action(call(approved,id(6),"forbidden",{name:"forbidden"}))).rejects.toThrow(/fenced|authority|active/i);
      await local.host.close();await relayHost.close();f.restart();
      relayHost=await f.storage.createDatasetHost({directory:remoteDirectory,limits:relayLimits,compileOperations,onShutdownError(error){throw error;}});
      const restarted=(await open({workspaceRoot:local.workspaceRoot})).host;offline=false;
      const completed=await restarted.transferToShared({datasetId:id(1),targetOrigin:"https://relay",target:target()});
      expect(completed.state).toBe("imported");expect(posted).toBe(1);
      const remote=createRemoteDatasetData({workspaceId:"w",credentials,credentialGeneration:1,currentCredentialGeneration:()=>1,signal:controller.signal,assertCurrent(){},relayJson:transport});
      const routed=createDatasetAuthorityRouter(restarted,{async status(datasetId){return restarted.transferStatus(datasetId);},async remote(origin){expect(origin).toBe("https://relay");return remote;}});
      expect((await routed.invoke(call(approved,id(5)))).result).toMatchObject([{name:"First"}]);
      expect(await routed.file({...upload,workspaceId:"w",action:"file",fileId:file.file.fileId})).toEqual({file:file.file,bytesBase64});
      expect(await routed.invoke(mutation)).toMatchObject({replayed:true});
      await routed.invoke(call(approved,id(6),"remote-write",{name:"Second"}));
      expect((await routed.invoke(call(approved,id(5)))).result).toHaveLength(2);
      await expect(restarted.action(call(approved,id(6),"local-after",{name:"forbidden"}))).rejects.toThrow(/fenced|authority|active/i);
      const exported=await handler()(new Request(`https://relay/sync/w/datasets/${id(1)}/export`,{headers:{authorization:"Bearer token"}}));
      expect(exported.status).toBe(200);expect(exported.headers.get("content-type")).toBe("application/octet-stream");
      const archive=await stageDatasetRecovery({stream:exported.body!,stagingParent:remoteDirectory,limits:{maxTotalBytes:64*1024*1024},expectedManifestSha256:exported.headers.get("x-dohc-dataset-manifest-sha256")!,authorize(){}});
      expect(archive.manifest.sourceState).toBe("active");expect(archive.manifest.entries.some(entry=>entry.kind==="attachment")).toBe(true);await archive.dispose();
      expect(await readdir(join(remoteDirectory,"recovery"))).toEqual([]);
      const cancelled=await handler()(new Request(`https://relay/sync/w/datasets/${id(1)}/export`,{headers:{authorization:"Bearer token"}}));
      const cancelledReader=cancelled.body!.getReader();await cancelledReader.read();await cancelledReader.cancel();
      expect(await readdir(join(remoteDirectory,"recovery"))).toEqual([]);
      const replica=await createDatasetReplica({directory:join(local.workspaceRoot,"replica"),scope:{workspaceId:"w",datasetId:id(1)},ownerKey:"owner",origin:"https://relay",assertOwner(){}});
      const replicaRequest=async(action:string,body?:unknown)=>{
        if(offline)throw Error("offline");
        const response=await handler()(new Request(`https://relay/sync/w/datasets/${id(1)}/replica/${action}`,{method:body?"POST":"GET",headers:{authorization:"Bearer token",...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})}));
        if(!response.ok)throw Error(`Replica ${response.status}: ${await response.text()}`);
        return response;
      };
      try{
        const source={async capture(){return (await replicaRequest("capture")).json();},async page(input:unknown){return (await replicaRequest("page",input)).json();},async blob(input:unknown){return new Uint8Array(await (await replicaRequest("blob",input)).arrayBuffer());}};
        await replica.catchUp(source);offline=true;
        expect((await replica.read({...call(approved,id(5)),operationId:id(5)})).result).toHaveLength(2);
        await expect(replica.read({...call(approved,id(6)),operationId:id(6)})).rejects.toThrow("read-only");
        offline=false;await routed.invoke(call(approved,id(6),"remote-third",{name:"Third"}));await replica.catchUp(source);
        expect((await replica.read({...call(approved,id(5)),operationId:id(5)})).result).toHaveLength(3);
      }finally{await replica.close();}
    }finally{controller.abort();await relayHost.close();await rm(remoteDirectory,{recursive:true,force:true,maxRetries:8,retryDelay:25});}
  },30_000);
  it("persists a local fence before sharing and resumes the same archive after a lost remote response", async () => {
    const {host,workspaceRoot} = await open(), approved = await activate(host);
    const attachment = Buffer.from("%PDF-synthetic-transfer-receipt");
    const uploaded = await host.upload({datasetId:id(1),revision:approved.revision.revision,revisionSha256:approved.revision.revisionSha256,
      idempotencyKey:"transfer-attachment",name:"receipt.pdf",contentType:"application/pdf",bytesBase64:attachment.toString("base64")});
    await host.action(call(approved,id(6),"before-transfer",{name:"Camera",fileId:uploaded.file.fileId}));
    let saved: import("./localDatasetTransfer").DatasetTransferReceipt | undefined, calls = 0;
    const target: import("./localDatasetTransfer").DatasetTransferTarget = { async importRecovery(input) {
      calls++;
      expect(host.approvedArtifacts(id(1)).active).toBe(false);
      expect(input.manifest.entries.filter(entry => entry.kind === "attachment")).toEqual([
        expect.objectContaining({byteLength:attachment.byteLength,sha256:digest(attachment)}),
      ]);
      let chunks = 0; for await (const chunk of input.stream) chunks += chunk.byteLength;
      expect(chunks).toBeGreaterThan(4096);
      const receipt = {transferId:input.transferId,manifestSha256:input.manifestSha256,sourceCursor:input.sourceCursor,
        targetCursor:{...input.sourceCursor,hostEpoch:"new-server-epoch",revision:input.sourceCursor.revision+1,digest:"f".repeat(64)}};
      if (saved) expect(receipt).toEqual(saved);
      saved = receipt;
      if (calls === 1) throw new Error("Lost remote response");
      return receipt;
    } };
    await expect(host.transferToShared({datasetId:id(1),targetOrigin:"https://relay.example",target})).rejects.toThrow("Lost remote response");
    const pending = host.transferStatus(id(1)); expect(pending?.state).toBe("ready");
    await expect(host.action(call(approved,id(6),"after-fence",{name:"Forbidden"}))).rejects.toThrow(/fenced|authority|active/i);
    await host.close();
    const restarted = (await open({workspaceRoot})).host;
    const resumedTarget: import("./localDatasetTransfer").DatasetTransferTarget = { async importRecovery(input) {
      expect(input.transferId).toBe(saved!.transferId);expect(input.manifestSha256).toBe(saved!.manifestSha256);
      for await (const _chunk of input.stream) { /* Verify retained archive hashes during streaming. */ }
      return saved!;
    } };
    const completed = await restarted.transferToShared({datasetId:id(1),targetOrigin:"https://relay.example/",target:resumedTarget});
    expect(completed.state).toBe("imported");expect(completed.receipt).toEqual(saved);
    expect(restarted.approvedArtifacts(id(1)).active).toBe(false);
    await expect(restarted.action(call(approved,id(6),"after-import",{name:"Forbidden"}))).rejects.toThrow(/fenced|authority|active/i);
    expect(await readdir(join(workspaceRoot,".dohc","datasets","exports"))).toEqual([]);
    await expect(restarted.transferToShared({datasetId:id(1),targetOrigin:"https://other.example",target:resumedTarget})).rejects.toThrow("another server");
  },30_000);

  it("keeps local writes fenced when the remote transfer receipt names another dataset", async () => {
    const {host} = await open(), approved = await activate(host);
    await expect(host.transferToShared({datasetId:id(1),targetOrigin:"https://relay.example",target:{async importRecovery(input){
      for await (const _chunk of input.stream) { /* Finish bounded transport before the response. */ }
      return {transferId:input.transferId,manifestSha256:input.manifestSha256,sourceCursor:input.sourceCursor,
        targetCursor:{...input.sourceCursor,datasetId:id(99),hostEpoch:"remote",revision:input.sourceCursor.revision+1,digest:"f".repeat(64)}};
    }}})).rejects.toThrow("did not confirm");
    expect(host.transferStatus(id(1))?.state).toBe("ready");
    await expect(host.action(call(approved,id(6),"after-bad-receipt",{name:"Forbidden"}))).rejects.toThrow(/fenced|authority|active/i);
  });

  it("creates without an app or account, executes reviewed bytes, and preserves records and retries across restart", async () => {
    const {host,workspaceRoot} = await open(), fixture = sources();
    const prepared = await host.prepare({descriptorPath:"items/dataset.json",adapter:fixture.adapter});
    expect(host.list().datasets).toEqual([]);
    fixture.files.set(definition.operationsPath, "throw new Error('unapproved edit');");
    const revision = await host.approve({preparationId:prepared.preparationId,revisionSha256:prepared.revision.revisionSha256});
    const approved = {prepared,revision,fixture};
    expect(host.describe(id(1))).toMatchObject({name:"Items",revision:1});
    expect(host.approvedArtifacts(id(1)).operationSource).toBe(source);
    const input = call(approved,id(6),"add-one",{name:"Camera"});
    const added = await host.action(input);
    expect(added.result).toEqual({name:"Camera"});
    await host.close();
    const restarted = (await open({workspaceRoot})).host;
    expect(await restarted.action(input)).toEqual({...added,replayed:true});
    expect((await restarted.query(call(approved,id(5)))).result).toEqual([{id:expect.any(String),name:"Camera"}]);
    await expect(restarted.action({...input,input:{name:"Other"}})).rejects.toThrow(/retry|payload/i);
    expect(await readdir(workspaceRoot)).toEqual([".dohc"]);
    await restarted.close();
    // Persistent coordination files keep later supervisor sessions on the same lock inode.
    expect((await readdir(join(workspaceRoot,".dohc","datasets","workers"))).sort()).toEqual([
      ".dohc-worker-lock.sqlite", ".dohc-worker-session.json",
    ]);
  });

  it("requires exact approval and revision, and separates queries from actions", async () => {
    const {host} = await open(), fixture = sources();
    const prepared = await host.prepare({descriptorPath:"items/dataset.json",adapter:fixture.adapter});
    await expect(host.approve({preparationId:prepared.preparationId,revisionSha256:"0".repeat(64)})).rejects.toThrow(/expired or changed/);
    // A caller modifying its review response cannot change the retained source or approved metadata.
    prepared.revision.definition.name = "Tampered";
    const revision = await host.approve({preparationId:prepared.preparationId,revisionSha256:prepared.revision.revisionSha256});
    expect(revision.definition.name).toBe("Items");
    const approved = {prepared,revision,fixture};
    await expect(host.query(call(approved,id(6)))).rejects.toThrow(/approved Collection action/);
    await expect(host.action(call(approved,id(5)))).rejects.toThrow(/approved Collection action/);
    await expect(host.invoke({...call(approved,id(6)),revisionSha256:"0".repeat(64)})).rejects.toThrow(/rules changed/);
    await expect(host.invoke({...call(approved,id(6)),revision:2})).rejects.toThrow(/rules changed/);
    await expect(host.invoke({...call(approved,id(6)),operationId:"SELECT * FROM items"})).rejects.toThrow(/access/);
    expect((await host.query(call(approved,id(5)))).result).toEqual([]);
  });

  it("stores private uploads, replays the same upload key, and attaches bytes in the data journal", async () => {
    const {host,workspaceRoot} = await open(), approved = await activate(host);
    const bytes = Buffer.from("%PDF-synthetic").toString("base64");
    const upload = {datasetId:id(1),revision:approved.revision.revision,revisionSha256:approved.revision.revisionSha256,idempotencyKey:"upload-1",name:"receipt.pdf",contentType:"application/pdf",bytesBase64:bytes};
    const first = await host.upload(upload);
    expect(first.file.byteLength).toBe(Buffer.from(bytes,"base64").byteLength);
    expect(await host.upload(upload)).toEqual({...first,replayed:true});
    await expect(host.upload({...upload,bytesBase64:Buffer.from("%PDF-other").toString("base64")})).rejects.toThrow(/retry key/);
    const read = await host.file({...upload,fileId:first.file.fileId});
    expect(read.bytesBase64).toBe(bytes);
    const added = await host.action(call(approved,id(6),"add-file",{name:"With receipt",fileId:first.file.fileId}));
    expect(added.result).toEqual({name:"With receipt"});
    const staged = await host.upload({...upload,idempotencyKey:"unattached"});
    await host.close();
    const restarted = (await open({workspaceRoot})).host;
    vi.spyOn(Date,"now").mockReturnValue(Date.now() + 86_400_001);
    expect(await restarted.upload(upload)).toEqual({...first,replayed:true});
    expect((await restarted.file({...upload,fileId:first.file.fileId})).bytesBase64).toBe(bytes);
    await expect(restarted.file({...upload,fileId:staged.file.fileId})).rejects.toThrow(/unavailable/);
    const fresh = await restarted.upload({...upload,idempotencyKey:"unattached"});
    expect(fresh.file.fileId).not.toBe(staged.file.fileId);
    expect(await restarted.action(call(approved,id(6),"add-file",{name:"With receipt",fileId:first.file.fileId}))).toEqual({...added,replayed:true});
  });

  it("does not attach a file when the authoritative data commit rolls back", async () => {
    let fail = true;
    const {host} = await open({resources:() => ({operationResources:() => ({accountAndAttach:() => {if(fail)throw new Error("quota refused");}})})});
    const approved = await activate(host);
    const upload = {datasetId:id(1),revision:1,revisionSha256:approved.revision.revisionSha256,idempotencyKey:"upload",name:"receipt.pdf",contentType:"application/pdf",bytesBase64:Buffer.from("%PDF-synthetic").toString("base64")};
    const staged = await host.upload(upload);
    await expect(host.action(call(approved,id(6),"add-file",{name:"No commit",fileId:staged.file.fileId}))).rejects.toThrow("quota refused");
    expect((await host.query(call(approved,id(5)))).result).toEqual([]);
    vi.spyOn(Date,"now").mockReturnValue(Date.now() + 86_400_001);
    await expect(host.file({...upload,fileId:staged.file.fileId})).rejects.toThrow(/unavailable/);
    fail = false;
    const fresh = await host.upload(upload);
    expect(fresh.file.fileId).not.toBe(staged.file.fileId);
    expect((await host.action(call(approved,id(6),"add-file",{name:"Accepted",fileId:fresh.file.fileId}))).result).toEqual({name:"Accepted"});
  });

  it("validates upload bytes, scope, abort and quota before retaining an upload key", async () => {
    const {host} = await open({maxStoredBytes: 2 * 1024 * 1024}), approved = await activate(host);
    const input = {datasetId:id(1),revision:1,revisionSha256:approved.revision.revisionSha256,idempotencyKey:"upload",name:"receipt.pdf",contentType:"application/pdf",bytesBase64:Buffer.from("%PDF-synthetic").toString("base64")};
    for (const bytesBase64 of ["broken",Buffer.from("wrong signature").toString("base64"),Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64")]) {
      await expect(host.upload({...input,bytesBase64})).rejects.toThrow();
    }
    const huge = Buffer.alloc(1024 * 1024,32);huge.write("%PDF-");
    await expect(host.upload({...input,bytesBase64:huge.toString("base64")})).rejects.toThrow(/storage is full/);
    await expect(host.upload({...input,datasetId:id(10)})).rejects.toThrow(/access/);
    await expect(host.upload({...input,revisionSha256:"0".repeat(64)})).rejects.toThrow(/rules changed/);
    const abort = new AbortController(); abort.abort();
    await expect(host.upload({...input,signal:abort.signal})).rejects.toThrow();
    expect((await host.upload(input)).replayed).toBe(false);
  });

  it("rejects source paths before capture and refuses a different workspace identity", async () => {
    const {host,workspaceRoot} = await open(), fixture = sources();
    const capture = vi.spyOn(fixture.adapter,"captureSourceMetadata");
    for (const descriptorPath of ["../items/dataset.json",".dohc/dataset.json",".DOHC/dataset.json"]) {
      await expect(host.prepare({descriptorPath,adapter:fixture.adapter})).rejects.toThrow();
    }
    expect(capture).not.toHaveBeenCalled();
    fixture.files.set("items/dataset.json",JSON.stringify({...definition,operationsPath:".dohc/operations.ts"}));
    await expect(host.prepare({descriptorPath:"items/dataset.json",adapter:fixture.adapter})).rejects.toThrow();
    expect(capture).toHaveBeenCalledTimes(1);
    await host.close();
    await expect(open({workspaceRoot,workspaceId:"other"})).rejects.toThrow(/another workspace/);
  });

  it("rolls back creation when quota refuses, and ends all work when the session closes", async () => {
    const {host} = await open({maxStoredBytes:4096});
    await expect(activate(host)).rejects.toThrow(/storage is full/);
    expect(host.list().datasets).toEqual([]);
    await host.close();
    expect(() => host.list()).toThrow(/session ended/);
    await expect(host.prepare({descriptorPath:"items/dataset.json",adapter:sources().adapter})).rejects.toThrow(/session ended/);
  });

  it("routes the captured operations through the host compiler without filesystem rereads", async () => {
    const compile = vi.fn<NonNullable<LocalDatasetHostOptions["compile"]>>((request) => compileClosedApp(request));
    const {host} = await open({compile});
    await activate(host);
    expect(compile).toHaveBeenCalledTimes(1);
    const [request,abort] = compile.mock.calls[0]!;
    expect(request.entryPath).toBe(definition.operationsPath);
    expect(request.inputs).toHaveLength(1);
    expect(Buffer.from(request.inputs[0]!.bytes).toString()).toBe(source);
    expect(abort).toBeInstanceOf(AbortSignal);
    await host.close(); expect(abort.aborted).toBe(true);
  });

  it("rejects a linked private directory before opening storage", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(),"dohc-local-dataset-test-")); roots.push(workspaceRoot);
    const target = await mkdtemp(join(tmpdir(),"dohc-local-dataset-test-")); roots.push(target);
    await mkdir(join(workspaceRoot,".dohc"));
    await symlink(target,join(workspaceRoot,".dohc","datasets"),process.platform === "win32" ? "junction" : "dir");
    await expect(open({workspaceRoot})).rejects.toThrow(/inside this workspace/);
    expect(await readdir(target)).toEqual([]);
  });
});
