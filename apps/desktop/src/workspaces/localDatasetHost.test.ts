import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { createLocalDatasetHost, type LocalDatasetHost, type LocalDatasetHostOptions } from "./localDatasetHost";
import { compileClosedApp } from "./closedAppCompiler";

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
  it("persists a local fence before sharing and resumes the same archive after a lost remote response", async () => {
    const {host,workspaceRoot} = await open(), approved = await activate(host);
    await host.action(call(approved,id(6),"before-transfer",{name:"Camera"}));
    let saved: import("./localDatasetTransfer").DatasetTransferReceipt | undefined, calls = 0;
    const target: import("./localDatasetTransfer").DatasetTransferTarget = { async importRecovery(input) {
      calls++;
      expect(host.approvedArtifacts(id(1)).active).toBe(false);
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
    expect(await readdir(join(workspaceRoot,".dohc","datasets","workers"))).toEqual([]);
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
