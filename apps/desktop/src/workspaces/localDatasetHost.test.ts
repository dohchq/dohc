import { createHash } from "node:crypto";
import { fakeLocalStateOpens, openedLocalState } from "../testing/preparedLocalState";
import { DatabaseSync } from "node:sqlite";
import { copyFile, lstat, mkdtemp, mkdir, readdir, readFile, rename, writeFile, rm, symlink } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { adoptLocalDatasetStore, createLocalDatasetHost, localDatasetStoreId, type LocalDatasetHost, type LocalDatasetHostOptions } from "./localDatasetHost";
import { CollectionsRefusalError, keepCollectionsHere, recordNewCollectionsHolder, type KeepSteps } from "./collectionsHolder";
import { compileDatasetOperations as relayCompileDatasetOperations } from "../../../../services/sync-relay/src/datasetCompiler";
import { stageDatasetRecovery } from "@dohc/app-backend-runtime/recovery";
import { writeDatasetRecoveryExport } from "./datasetRecoveryExport";
import { fixture as relayFixture, limits as relayLimits } from "../../../../services/sync-relay/src/datasetTestFixture";
import { createSyncRelayHandler } from "../../../../services/sync-relay/src/server";
import { createDatasetAuthorityRouter, createRemoteDatasetData, createRemoteDatasetTransferTarget } from "./remoteDataset";
import { readDatasetResponse } from "../ipc/readDatasetResponse";
import { createDatasetReplica } from "@dohc/app-backend-runtime/replica";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import { unguardedCollections } from "../testing/collectionsHolder";

const compileFixture = createDatasetFixtureCompiler();
// Stops a store move as a crash would: before the copy is renamed into place,
// with nothing cleaned up after.
const faults = vi.hoisted(() => ({ crashBeforeRename: false, crashed: false }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      if (faults.crashBeforeRename && String(from).endsWith("state.sqlite.moving")) { faults.crashed = true; throw new Error("dohc stopped"); }
      return actual.rename(from, to);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => (faults.crashed && String(args[0]).includes("state.sqlite.moving") ? undefined : actual.rm(...args)),
  };
});

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
  // Workers and exports live in .dohc/local, which an engine open prepares.
  await openedLocalState({ workspaceId: extra.workspaceId ?? "w", rootPath: workspaceRoot });
  const host = await createLocalDatasetHost({workspaceId: "w", workspaceRoot, capacityBytes: 1024 * 1024, localPersonId: () => "person-local", compile: compileFixture, ...extra, holder: extra.holder ?? unguardedCollections});
  hosts.push(host); return {host, workspaceRoot};
}
async function activate(host: LocalDatasetHost, fixture = sources()) {
  const prepared = await host.prepare({descriptorPath: "items/dataset.json", adapter: fixture.adapter});
  const revision = await host.approve({preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256});
  return {prepared, revision, fixture};
}
const call = (approved: Awaited<ReturnType<typeof activate>>, operationId: string, idempotencyKey = "read", input = {}) =>
  ({datasetId: id(1), revision: approved.revision.revision, revisionSha256: approved.revision.revisionSha256, operationId, idempotencyKey, input});

it("pages local Collection permissions live without disclosing stored grant credentials", async () => {
  const { host, workspaceRoot } = await open(), approved = await activate(host);
  const db = new DatabaseSync(join(workspaceRoot, ".dohc", "local", "datasets", "state.sqlite"));
  try {
    const insert = db.prepare("INSERT INTO dohc_dataset_data_grants VALUES(?,?,?,?,?)");
    for (let n = 0; n < 3; n++) insert.run("w", id(1), `recipient-${String(n).padStart(3, "0")}`,
      JSON.stringify({ revision: approved.revision.revision, revisionSha256: approved.revision.revisionSha256, operationIds: [id(5)], discover: true }), "secret-grant-token");
  } finally { db.close(); }
  const first = await host.permissions({ datasetId: id(1), limit: 2 });
  expect(first.permissions).toHaveLength(2); expect(first.nextCursor).toBe("data:recipient-001");
  expect((await host.permissions({ datasetId: id(1), after: first.nextCursor!, limit: 100 })).permissions).toHaveLength(1);
  expect(JSON.stringify(first)).not.toContain("secret-grant-token");
});

it("finishes a restore that dohc quit partway through", async () => {
  const sourceHost = await open(), approved = await activate(sourceHost.host);
  await sourceHost.host.invoke(call(approved, id(6), "saved", { name: "Preserved" }));
  const archive = await sourceHost.host.prepareExport(id(1));
  const sourcePath = join(sourceHost.workspaceRoot, "quit.dohc-recovery");
  await writeDatasetRecoveryExport({ workspaceRoots: [], path: sourcePath, stream: archive.stream(), signal: new AbortController().signal, maxBytes: archive.maxBytes, authorize() {} });
  await archive.dispose(); await sourceHost.host.close();
  let observer: DatabaseSync | undefined;
  // dohc stops once the restore has copied a record, so nothing after that runs, cleanup included.
  const target = await open({ assertCurrent() {
    if (observer?.prepare("SELECT 1 FROM dohc_dataset_import_records").get()) throw Error("dohc quit");
  } });
  observer = new DatabaseSync(join(target.workspaceRoot, ".dohc", "local", "datasets", "state.sqlite"));
  try {
    const first = await target.host.prepareRecovery({ sourcePath });
    await expect(target.host.claimRecovery({ ...first, oldHostStopped: true })).rejects.toThrow("dohc quit");
    expect(observer.prepare("SELECT phase FROM dohc_dataset_imports").all()).toEqual([{ phase: "staging" }]);
    observer.close(); observer = undefined;
    await target.host.close();
    const restarted = await open({ workspaceRoot: target.workspaceRoot });
    const again = await restarted.host.prepareRecovery({ sourcePath });
    expect(again.transferId).not.toBe(first.transferId);
    expect((await restarted.host.claimRecovery({ ...again, oldHostStopped: true })).targetCursor).toBeDefined();
    expect((await restarted.host.invoke(call(approved, id(5)))).result).toEqual([{ id: expect.any(String), name: "Preserved" }]);
  } finally { observer?.close(); }
}, 120_000);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});

describe("local dataset owner adapter", () => {
  it("permanently deletes records, uploads and workers, refunds storage, and preserves source and saved exports", async () => {
    const first = await open(), approved = await activate(first.host);
    const sourcePath = join(first.workspaceRoot,"keep.txt"); await writeFile(sourcePath,"workspace source");
    const uploaded = await first.host.upload({datasetId:id(1),revision:1,revisionSha256:approved.revision.revisionSha256,idempotencyKey:"delete-file",name:"receipt.pdf",contentType:"application/pdf",bytesBase64:Buffer.from("%PDF-delete").toString("base64")});
    await first.host.action(call(approved,id(6),"delete-write",{name:"Saved",fileId:uploaded.file.fileId}));
    const archive = await first.host.prepareExport(id(1)), backupPath = join(first.workspaceRoot,"saved.dohc-recovery");
    await writeDatasetRecoveryExport({ workspaceRoots: [], path:backupPath,stream:archive.stream(),signal:new AbortController().signal,maxBytes:archive.maxBytes,authorize(){}}); await archive.dispose();
    first.host.archive({datasetId:id(1)});
    const preview = first.host.deletePreview({datasetId:id(1)});
    await first.host.deleteDataset({datasetId:id(1),expected:preview.cursor,reviewToken:preview.reviewToken,acknowledge:true});
    expect(first.host.list({includeArchived:true}).datasets).toEqual([]);
    expect(await readFile(sourcePath,"utf8")).toBe("workspace source");
    expect((await readFile(backupPath)).length).toBeGreaterThan(0);
    await expect(first.host.prepareRecovery({sourcePath:backupPath})).rejects.toThrow("deleted");
    await first.host.close();
    const db = new DatabaseSync(join(first.workspaceRoot,".dohc", "local", "datasets", "state.sqlite"));
    try {
      expect(db.prepare("SELECT bytes FROM local_dataset_budget").get()!.bytes).toBe(0);
      for(const table of ["local_dataset_files","local_dataset_usage","dohc_dataset_journals","dohc_dataset_checkpoint_chunks"])
        expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
    } finally { db.close(); }
    const restarted = await open({workspaceRoot:first.workspaceRoot});
    expect(restarted.host.list().datasets).toEqual([]);
    await expect(activate(restarted.host)).rejects.toThrow("deleted");
  });

  it("discards preparation, rejects damaged or foreign backups, and leaves the target absent", async () => {
    const sourceHost = await open(); await activate(sourceHost.host);
    const archive = await sourceHost.host.prepareExport(id(1));
    const sourcePath = join(sourceHost.workspaceRoot,"backup.dohc-recovery");
    await writeDatasetRecoveryExport({ workspaceRoots: [], path:sourcePath,stream:archive.stream(),signal:new AbortController().signal,maxBytes:archive.maxBytes,authorize(){}}); await archive.dispose();
    const target = await open(), prepared = await target.host.prepareRecovery({sourcePath});
    await target.host.discardRecovery(prepared.transferId);
    expect(target.host.list().datasets).toEqual([]);
    expect(await readdir(join(target.workspaceRoot,".dohc","local","datasets","exports"))).toEqual([]);
    await expect(target.host.claimRecovery({...prepared,oldHostStopped:true})).rejects.toThrow(/not installed/);
    const foreign = await open({workspaceId:"other"});
    await expect(foreign.host.prepareRecovery({sourcePath})).rejects.toThrow(/another workspace/);
    const bytes = await readFile(sourcePath); await writeFile(sourcePath,bytes.subarray(0,bytes.length-5));
    await expect(target.host.prepareRecovery({sourcePath})).rejects.toThrow(/truncated/);
    expect(target.host.list().datasets).toEqual([]);
    expect(await readdir(join(target.workspaceRoot,".dohc","local","datasets","exports"))).toEqual([]);
  });
  it.each(["installed"] as const)("restores a backup then resumes a relay transfer after response loss in the %s phase", async phase => {
    const f = relayFixture(), remoteDirectory = await mkdtemp(join(tmpdir(),"dohc-transfer-relay-"));
    const compileOperations = relayCompileDatasetOperations;
    let relayHost = await f.storage.createDatasetHost({publicEditRelease:undefined,directory:remoteDirectory,limits:relayLimits,compileOperations,onShutdownError(error){throw error;}});
    const controller=new AbortController(); let offline=false,posted=0;
    const handler=()=>createSyncRelayHandler({storage:f.storage,datasetHost:relayHost,appPublicationLimits:relayLimits,
      resolveActor(request,workspaceId){if(request.headers.get("authorization")!=="Bearer token")throw Error("credentials");return {workspaceId,userId:"owner"};}});
    const credentials={serverUrl:"https://account",relayUrl:"https://relay",token:"token",userId:"owner",email:"owner@example.test"};
    const transport=async (_credentials:typeof credentials,path:string,init:RequestInit)=>{
      if(offline)throw Error("offline after response loss");
      const request=new Request(`https://relay${path}`,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),authorization:"Bearer token"},...(init.body instanceof ReadableStream?{duplex:"half" as const}:{})});
      if (phase === "installed" && path.includes("/imports/") && init.method === "POST" && posted === 0) {
        const reader = request.body!.getReader();
        const stream = (async function* () { try { while (true) { const next = await reader.read(); if (next.done) return; yield next.value; } } finally { reader.releaseLock(); } })();
        await relayHost.importRecovery({ kind: "named", workspaceId: "w", userId: "owner" }, {
          workspaceId: "w", datasetId: id(1), transferId: path.split("/").at(-1)!,
          sourceCursor: JSON.parse(request.headers.get("x-dohc-dataset-source-cursor")!),
          manifestSha256: request.headers.get("x-dohc-dataset-manifest-sha256")!, stream, activate: false,
        });
        posted++; offline = true; throw Error("lost import response");
      }
      const response=await handler()(request),value=path.includes("/imports/")?await response.json():await readDatasetResponse(response,path.split("/").at(-1)!,controller.signal);
      if(!response.ok)throw Error(`Relay ${response.status}: ${JSON.stringify(value)}`);
      if(path.includes("/imports/")&&init.method==="POST"){posted++;if(posted===1){offline=true;throw Error("lost import response");}}
      return value;
    };
    const target=()=>createRemoteDatasetTransferTarget({workspaceId:"w",datasetId:id(1),origin:"https://relay",credentials,credentialGeneration:1,currentCredentialGeneration:()=>1,signal:controller.signal,assertCurrent(){},relayStream:transport});
    try{
      let local=await open(); const approved=await activate(local.host);
      const bytesBase64=Buffer.from("%PDF-transfer-actual-file").toString("base64"),upload={datasetId:id(1),revision:1,revisionSha256:approved.revision.revisionSha256,idempotencyKey:"receipt",name:"receipt.pdf",contentType:"application/pdf",bytesBase64};
      const file=await local.host.upload(upload),mutation=call(approved,id(6),"before-transfer",{name:"First",fileId:file.file.fileId});
      await local.host.action(mutation);
      await local.host.close();
      const oldStore=new DatabaseSync(join(local.workspaceRoot,".dohc", "local", "datasets", "state.sqlite"));
      oldStore.prepare("INSERT INTO dohc_dataset_data_grants VALUES(?,?,?,?,?)").run("w",id(1),"old-helper",JSON.stringify({revision:1,revisionSha256:approved.revision.revisionSha256,operationIds:[id(5)],discover:true}),"old-grant-token");
      oldStore.close();
      const oldHost=(await open({workspaceRoot:local.workspaceRoot})).host;
      const originalArchive=await oldHost.prepareExport(id(1)),sourcePath=join(local.workspaceRoot,"before-recovery.dohc-recovery");
      await writeDatasetRecoveryExport({ workspaceRoots: [], path:sourcePath,stream:originalArchive.stream(),maxBytes:originalArchive.maxBytes,signal:controller.signal,authorize(){}});await originalArchive.dispose();await oldHost.close();
      local=await open();
      const recovery=await local.host.prepareRecovery({sourcePath});
      expect(local.host.list().datasets).toEqual([]);
      await local.host.claimRecovery({...recovery,oldHostStopped:true});
      expect((await local.host.invoke(mutation)).replayed).toBe(true);
      await expect(local.host.transferToShared({datasetId:id(1),targetOrigin:"https://relay",target:target()})).rejects.toThrow("lost import response");
      expect(local.host.transferStatus(id(1))?.state).toBe("ready");
      await expect(local.host.action(call(approved,id(6),"forbidden",{name:"forbidden"}))).rejects.toThrow("This host stopped accepting changes to this Collection.");
      await local.host.close();await relayHost.close();f.restart();
      relayHost=await f.storage.createDatasetHost({publicEditRelease:undefined,directory:remoteDirectory,limits:relayLimits,compileOperations,onShutdownError(error){throw error;}});
      const restarted=(await open({workspaceRoot:local.workspaceRoot})).host;offline=false;
      const completed=await restarted.transferToShared({datasetId:id(1),targetOrigin:"https://relay",target:target()});
      expect(completed.state).toBe("imported");expect(posted).toBe(phase === "installed" ? 2 : 1);
      const remote=createRemoteDatasetData({workspaceId:"w",credentials,credentialGeneration:1,currentCredentialGeneration:()=>1,signal:controller.signal,assertCurrent(){},relayJson:transport});
      expect((await remote.permissions!({workspaceId:"w",datasetId:id(1),action:"permissions"})).permissions).toEqual([]);
      const routed=createDatasetAuthorityRouter(restarted,{async status(datasetId){return restarted.transferStatus(datasetId);},marker:datasetId=>restarted.transferStatus(datasetId),async remote(origin){expect(origin).toBe("https://relay");return remote;}});
      expect((await routed.invoke(call(approved,id(5)))).result).toMatchObject([{name:"First"}]);
      expect(await routed.file({...upload,workspaceId:"w",action:"file",fileId:file.file.fileId})).toEqual({file:file.file,bytesBase64});
      expect(await routed.invoke(mutation)).toMatchObject({replayed:true});
      await routed.invoke(call(approved,id(6),"remote-write",{name:"Second"}));
      expect((await routed.invoke(call(approved,id(5)))).result).toHaveLength(2);
      await expect(restarted.action(call(approved,id(6),"local-after",{name:"forbidden"}))).rejects.toThrow("This host stopped accepting changes to this Collection.");
      const exported=await handler()(new Request(`https://relay/sync/w/datasets/${id(1)}/export`,{headers:{authorization:"Bearer token"}}));
      expect(exported.status).toBe(200);expect(exported.headers.get("content-type")).toBe("application/octet-stream");
      const archive=await stageDatasetRecovery({stream:exported.body!,stagingParent:remoteDirectory,limits:{maxTotalBytes:64*1024*1024},expectedManifestSha256:exported.headers.get("x-dohc-dataset-manifest-sha256")!,authorize(){}});
      expect(archive.manifest.sourceState).toBe("active");expect(archive.manifest.entries.some(entry=>entry.kind==="attachment")).toBe(true);await archive.dispose();
      expect(await readdir(join(remoteDirectory,"recovery"))).toEqual([]);
      const cancelled=await handler()(new Request(`https://relay/sync/w/datasets/${id(1)}/export`,{headers:{authorization:"Bearer token"}}));
      const cancelledReader=cancelled.body!.getReader();await cancelledReader.read();await cancelledReader.cancel();
      expect(await readdir(join(remoteDirectory,"recovery"))).toEqual([]);
      await mkdir(join(local.workspaceRoot,"replica"));
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
  },120_000);

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
    expect((await readdir(join(workspaceRoot,".dohc","local","datasets","workers"))).sort()).toEqual([
      ".dohc-worker-lock.sqlite", ".dohc-worker-session.json",
    ]);
  });

  it("writes as an automation only through a context the host made, names it, and wakes the executor", async () => {
    const wakes: boolean[] = [];
    const {host} = await open({onAutomationClaims: failed => { wakes.push(failed); }}), approved = await activate(host);
    const [own, other] = ["collection:items#welcome", "collection:items#tally"];
    for (const automationId of [own, other]) host.automations.subscribe(id(1), {automationId, tableId: id(2), kinds: ["added"], fieldIds: null, definitionHash: digest(automationId)});
    expect(host.automations.datasets()).toEqual({definitions: [approved.revision.definition], failures: []});
    const context = host.automations.context({automationId: own, claimId: "claim", depth: 1, person: null});
    const step = call(approved, id(6), "step", {name: "Pens"});
    expect(await host.automations.invoke(context, step)).toMatchObject({replayed: false});
    // The commit's claims are made and its wake has run by the time the step returns.
    expect(wakes).toEqual([false]);
    // Its own automation claims nothing; the other claims at the depth the write declared.
    const claimed = host.automations.next();
    expect(claimed).toMatchObject({automationId: other, depth: 1, actor: {kind: "automation", automationId: own, depth: 1}});
    // A claim is found by its id, but only under its own automation.
    expect(host.automations.claim(other, claimed!.claimId)).toMatchObject({claimId: claimed!.claimId, state: "running"});
    expect(host.automations.claim(own, claimed!.claimId)).toBeNull();
    expect(host.automations.next()).toBeNull();
    // Its retries keep an identity derived from the workspace and automation, apart from the owner's.
    const principal = digest(JSON.stringify(["dohc-dataset-automation-v1", "w", own]));
    expect(host.history({datasetId: id(1)}).entries).toEqual([expect.objectContaining({
      automation: {automationId: own, depth: 1}, callerReference: digest(JSON.stringify([principal, {kind: "data"}])),
    })]);
    expect(await host.automations.invoke(context, step)).toMatchObject({replayed: true});
    expect(await host.action(step)).toMatchObject({replayed: false});
    // An object shaped like a context is not one, and a chain past depth 4 writes nothing.
    await expect(host.automations.invoke({automationId: own, claimId: "claim", depth: 1, person: null}, {...step, idempotencyKey: "forged"})).rejects.toThrow(/not permitted/);
    await expect(host.automations.invoke(host.automations.context({automationId: own, claimId: "claim", depth: 5, person: null}), {...step, idempotencyKey: "deep"})).rejects.toThrow("You do not have access to this Collection.");
    expect(host.history({datasetId: id(1)}).entries).toHaveLength(2);
    // A write at depth 4 commits, and its wake says the claims it made are failed chain stops.
    await host.automations.invoke(host.automations.context({automationId: own, claimId: "claim", depth: 4, person: null}), {...step, idempotencyKey: "stop"});
    expect(wakes).toEqual([false, false, true]);
    expect(host.automations.failures()).toEqual([expect.objectContaining({automationId: other, neverStarted: true, chainStopped: true})]);
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
    await expect(host.invoke({...call(approved,id(6)),revisionSha256:"0".repeat(64)})).rejects.toThrow(/Its owner must approve this access again/);
    await expect(host.invoke({...call(approved,id(6)),revision:2})).rejects.toThrow(/Its owner must approve this access again/);
    await expect(host.invoke({...call(approved,id(6)),operationId:"SELECT * FROM items"})).rejects.toThrow(/access/);
    expect((await host.query(call(approved,id(5)))).result).toEqual([]);
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
    await expect(host.upload({...input,revisionSha256:"0".repeat(64)})).rejects.toThrow(/Its owner must approve this access again/);
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

  it("rejects a linked private directory before opening storage", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(),"dohc-local-dataset-test-")); roots.push(workspaceRoot);
    const target = await mkdtemp(join(tmpdir(),"dohc-local-dataset-test-")); roots.push(target);
    await mkdir(join(workspaceRoot,".dohc","local"),{recursive:true});
    await symlink(target,join(workspaceRoot,".dohc","local","datasets"),process.platform === "win32" ? "junction" : "dir");
    await expect(open({workspaceRoot})).rejects.toThrow("dohc could not open this workspace's Collections. A link is at .dohc/local/datasets, which must be a real folder.");
    expect(await readdir(target)).toEqual([]);
  });
});

it("rejects History heads when the workspace changes during a worker read", async () => {
  let current = true;
  const { host } = await open({ assertCurrent() { if (!current) throw new Error("Workspace changed"); } });
  await activate(host);
  const pending = host.historyHeads();
  current = false;
  try { await expect(pending).rejects.toThrow("Workspace changed"); }
  finally { current = true; }
});

describe("this computer's Collection folders", () => {
  // Node can't see who may change a folder on Windows, so there the store in
  // `.dohc/local` is read, or adopted, only while the engine's open holds it.
  it("on Windows, reads and adopts the store in .dohc/local only while the engine's open holds the folder", async () => {
    const first = await open();
    await first.host.close();
    const root = first.workspaceRoot, storeId = "5b2c6c1e-2f4a-4c1b-9d7e-0a1b2c3d4e5f";
    const workspace = { workspaceId: "w", rootPath: root }, opens = fakeLocalStateOpens();
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const notOpened = "dohc has not finished opening this workspace. Try again when it opens.";
      await expect(localDatasetStoreId(root)).rejects.toThrow(notOpened);
      await expect(adoptLocalDatasetStore(root, "w", storeId)).rejects.toThrow(notOpened);
      await opens.open(workspace);
      await adoptLocalDatasetStore(root, "w", storeId);
      expect(await localDatasetStoreId(root)).toBe(storeId);
      opens.close(workspace);
      await expect(localDatasetStoreId(root)).rejects.toThrow(notOpened);
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
  });
});

describe("the computer that keeps a workspace's Collections", () => {
  const here = { installId: "install-here", label: "Studio" };
  const laptop = { installId: "install-laptop", label: "Laptop" };
  const guarded = { here: () => here, required: () => true };
  const recordFile = (root: string) => join(root, ".dohc", "collections.json");
  const readRecord = async (root: string) => JSON.parse(await readFile(recordFile(root), "utf8")) as { installId: string; storeId: string | null };
  const writeRecord = (root: string, computer: { installId: string; label: string }, storeId: string | null) =>
    writeFile(recordFile(root), JSON.stringify({ version: 1, workspaceId: "w", installId: computer.installId, label: computer.label, storeId }));
  const storeIdIn = (root: string) => {
    const db = new DatabaseSync(join(root, ".dohc", "local", "datasets", "state.sqlite"), { readOnly: true });
    try { return db.prepare("SELECT store_id FROM local_dataset_store").get()?.store_id ?? null; }
    catch { return "no table"; }
    finally { db.close(); }
  };
  const present = (path: string) => lstat(path).then(() => true, () => false);
  // The store's files in .dohc/local, beside the worker and export folders, or null with no folder.
  const datasetFiles = async (root: string) => (await readdir(join(root, ".dohc", "local", "datasets")).catch(() => null))?.filter(name => name.startsWith("state.sqlite")) ?? null;
  // A store made before the holder record, as every workspace from before it has.
  async function storeWithoutRecord() {
    const first = await open();
    const approved = await activate(first.host);
    await first.host.action(call(approved, id(6), "add", { name: "Camera" }));
    await first.host.close();
    hosts.splice(hosts.indexOf(first.host), 1);
    return { root: first.workspaceRoot, approved };
  }
  // Keep's steps as main gives them, with the person's answer.
  const keepSteps = (root: string, confirm = true): KeepSteps => ({ adoptStore: storeId => adoptLocalDatasetStore(root, "w", storeId),
    storeIdHere: () => localDatasetStoreId(root), madeBy: async () => null, confirm: async () => confirm });
  async function refusedOpen(root: string, extra: Partial<LocalDatasetHostOptions> = {}) {
    const error = await open({ workspaceRoot: root, holder: guarded, ...extra }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(CollectionsRefusalError);
    return error as CollectionsRefusalError;
  }

  it("blocks a store no record names until a person keeps it here, and changes nothing before that", async () => {
    const { root, approved } = await storeWithoutRecord();
    expect(await datasetFiles(root)).toEqual(["state.sqlite"]);
    expect((await refusedOpen(root)).refusal).toEqual({ kind: "unclaimed" });
    // Not opened: no -wal or -shm, and no id written into it.
    expect(await datasetFiles(root)).toEqual(["state.sqlite"]);
    expect(storeIdIn(root)).toBe("no table");
    expect(await present(recordFile(root))).toBe(false);
    await keepCollectionsHere(root, "w", here, keepSteps(root));
    expect(storeIdIn(root)).toBe((await readRecord(root)).storeId);
    const kept = await open({ workspaceRoot: root, holder: guarded });
    expect((await kept.host.query(call(approved, id(5)))).result).toEqual([{ id: expect.any(String), name: "Camera" }]);
  });

  it("refuses Collections another computer keeps without opening or creating a store", async () => {
    const empty = await mkdtemp(join(tmpdir(), "dohc-local-dataset-test-")); roots.push(empty);
    await mkdir(join(empty, ".dohc"));
    await writeRecord(empty, laptop, null);
    expect((await refusedOpen(empty)).message).toBe("These Collections are on Laptop. Open this workspace there to use them, or to move them to a server.");
    expect(await datasetFiles(empty), "no .dohc/local/datasets").toBeNull();
    const { root } = await storeWithoutRecord();
    await writeRecord(root, laptop, "5b2c6c1e-2f4a-4c1b-9d7e-0a1b2c3d4e5f");
    expect((await refusedOpen(root)).refusal.kind).toBe("elsewhere");
    expect(await datasetFiles(root)).toEqual(["state.sqlite"]);
    await expect(adoptLocalDatasetStore(empty, "w", "5b2c6c1e-2f4a-4c1b-9d7e-0a1b2c3d4e5f")).rejects.toThrow("dohc could not find .dohc/local/datasets/state.sqlite.");
    expect(await datasetFiles(empty), "adopting creates no store either").toBeNull();
  });

  it.each(["a savepoint inside one"])("rolls back %s whose record changes while its work runs, and stops", async (shape) => {
    const root = await mkdtemp(join(tmpdir(), "dohc-local-dataset-test-")); roots.push(root);
    await mkdir(join(root, ".dohc"));
    await recordNewCollectionsHolder(root, "w", here);
    // The host's own transaction, which file associations write through.
    let storage!: { db: { prepare(sql: string): { run(...values: unknown[]): unknown } }; transaction<T>(run: () => T): T };
    const { host } = await open({ workspaceRoot: root, holder: guarded, resources: (given) => { storage = given; return {}; } });
    const dump = () => {
      const db = new DatabaseSync(join(root, ".dohc", "local", "datasets", "state.sqlite"), { readOnly: true });
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => String(row.name));
        return JSON.stringify(tables.map(table => [table, db.prepare(`SELECT * FROM "${table}"`).all()]));
      } finally { db.close(); }
    };
    const before = dump();
    // An outside sync process replaces the record after the write, before the commit.
    const work = () => {
      storage.db.prepare("INSERT INTO local_dataset_usage VALUES(?,?)").run("probe", 1);
      writeFileSync(recordFile(root), JSON.stringify({ version: 1, workspaceId: "w", installId: laptop.installId, label: laptop.label, storeId: null }));
    };
    const refused = (() => {
      try { storage.transaction(() => (shape === "a transaction" ? work() : storage.transaction(work))); }
      catch (error) { return error; }
      return null;
    })();
    expect((refused as CollectionsRefusalError).refusal).toMatchObject({ kind: "elsewhere" });
    expect(dump(), "nothing committed").toBe(before);
    expect(() => host.list()).toThrow(refused as Error);
  });

  describe("a store still in .dohc/datasets, which iCloud Drive syncs", () => {
    const oldFolder = (root: string) => join(root, ".dohc", "datasets");
    const oldFiles = async (root: string) => (await readdir(oldFolder(root)).catch(() => null))?.filter(name => name.startsWith("state.sqlite")) ?? null;
    const localStore = (root: string) => join(root, ".dohc", "local", "datasets", "state.sqlite");
    // The system trash: the names put there, in order, unless it refuses.
    function systemTrash() {
      const trash = { items: [] as string[], refuses: false,
        trashItem: vi.fn(async (path: string) => {
          if (trash.refuses) throw new Error("The trash is unavailable.");
          const folder = await mkdtemp(join(tmpdir(), "dohc-trash-test-")); roots.push(folder);
          await rename(path, join(folder, basename(path)));
          trash.items.push(basename(path));
        }) };
      return trash;
    }
    // A workspace from before .dohc/local, whose record names this computer's
    // store. Copied while the host was open, as a synced folder holds it, so
    // its -wal holds commits its database file does not.
    async function storeInOldPlace() {
      const root = await mkdtemp(join(tmpdir(), "dohc-local-dataset-test-")); roots.push(root);
      await mkdir(join(root, ".dohc"));
      await recordNewCollectionsHolder(root, "w", here);
      const first = await open({ workspaceRoot: root, holder: guarded });
      const approved = await activate(first.host);
      await first.host.action(call(approved, id(6), "add", { name: "Camera" }));
      await mkdir(oldFolder(root));
      for (const file of ["state.sqlite", "state.sqlite-wal"]) await copyFile(`${localStore(root)}${file.slice("state.sqlite".length)}`, join(oldFolder(root), file));
      await first.host.close(); hosts.splice(hosts.indexOf(first.host), 1);
      await rm(localStore(root));
      // The database file alone has none of the Collection's tables yet.
      const alone = join(await mkdtemp(join(tmpdir(), "dohc-local-dataset-test-")), "state.sqlite"); roots.push(join(alone, ".."));
      await copyFile(join(oldFolder(root), "state.sqlite"), alone);
      const db = new DatabaseSync(alone);
      try { expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_dataset_identity'").get()).toBeUndefined(); } finally { db.close(); }
      return { root, approved, storeId: (await readRecord(root)).storeId };
    }
    const names = async (host: LocalDatasetHost, approved: Awaited<ReturnType<typeof activate>>) =>
      ((await host.query(call(approved, id(5)))).result as Array<{ name: string }>).map(row => row.name).sort();

    it("copies the store the record names into .dohc/local, with its -wal, then puts the old files in the trash", async () => {
      const { root, approved, storeId } = await storeInOldPlace();
      const trash = systemTrash();
      const { host } = await open({ workspaceRoot: root, holder: guarded, trashItem: trash.trashItem });
      expect(await names(host, approved)).toEqual(["Camera"]);
      expect(storeIdIn(root)).toBe(storeId);
      expect(trash.items[0]).toBe("state.sqlite");
      expect(await oldFiles(root)).toEqual([]);
      expect((await datasetFiles(root))!.filter(name => name.includes("moving"))).toEqual([]);
      await host.action(call(approved, id(6), "after-move", { name: "Lens" }));
      expect(await names(host, approved)).toEqual(["Camera", "Lens"]);
    });

    it("keeps the old store in use when dohc stops before the copy is in place, and copies it again next time", async () => {
      const { root, approved, storeId } = await storeInOldPlace();
      const trash = systemTrash();
      faults.crashBeforeRename = true;
      try {
        await expect(open({ workspaceRoot: root, holder: guarded, trashItem: trash.trashItem }))
          .rejects.toThrow("dohc could not copy this workspace's Collections to .dohc/local/datasets/state.sqlite, so they stay in .dohc/datasets/state.sqlite. Try again.");
      } finally { faults.crashBeforeRename = false; faults.crashed = false; }
      // The checked copy never took the store's place, and nothing left .dohc/datasets.
      expect(await datasetFiles(root)).toEqual(["state.sqlite.moving"]);
      expect(await oldFiles(root)).toContain("state.sqlite");
      expect(trash.trashItem).not.toHaveBeenCalled();
      const { host } = await open({ workspaceRoot: root, holder: guarded, trashItem: trash.trashItem });
      expect(await names(host, approved)).toEqual(["Camera"]);
      expect(storeIdIn(root)).toBe(storeId);
      expect((await datasetFiles(root))!.filter(name => name.includes("moving"))).toEqual([]);
      expect(await oldFiles(root)).toEqual([]);
    });

    it("throws away a copy that dohc stopped while making, and copies the store again", async () => {
      const { root, approved } = await storeInOldPlace();
      await writeFile(`${localStore(root)}.moving`, "SQLite format 3\0 cut short");
      await writeFile(`${localStore(root)}.moving-journal`, "");
      const { host } = await open({ workspaceRoot: root, holder: guarded, trashItem: systemTrash().trashItem });
      expect(await names(host, approved)).toEqual(["Camera"]);
      expect((await datasetFiles(root))!.filter(name => name.includes("moving"))).toEqual([]);
    });

    it("opens the moved store when the old one is still there with its id, and trashes the old one, whenever dohc stopped after the rename", async () => {
      const { root, approved } = await storeInOldPlace();
      const saved = await mkdtemp(join(tmpdir(), "dohc-local-dataset-test-")); roots.push(saved);
      for (const file of await oldFiles(root) ?? []) await copyFile(join(oldFolder(root), file), join(saved, file));
      const trash = systemTrash();
      const moved = await open({ workspaceRoot: root, holder: guarded, trashItem: trash.trashItem });
      await moved.host.action(call(approved, id(6), "after-move", { name: "Lens" }));
      await moved.host.close(); hosts.splice(hosts.indexOf(moved.host), 1);
      // The old files as they were before the trash: what a stop after the rename leaves, or iCloud Drive brings back.
      for (const file of await readdir(saved)) await copyFile(join(saved, file), join(oldFolder(root), file));
      const { host } = await open({ workspaceRoot: root, holder: guarded, trashItem: trash.trashItem });
      expect(await names(host, approved)).toEqual(["Camera", "Lens"]);
      expect(await oldFiles(root)).toEqual([]);
      expect(trash.items.filter(name => name === "state.sqlite")).toHaveLength(2);
    });

    it("trashes a -wal or -shm left without its store, as a stop between trashing them leaves", async () => {
      const { root, approved } = await storeInOldPlace();
      const trash = systemTrash();
      const moved = await open({ workspaceRoot: root, holder: guarded, trashItem: trash.trashItem });
      await moved.host.close(); hosts.splice(hosts.indexOf(moved.host), 1);
      for (const file of ["state.sqlite-wal", "state.sqlite-shm"]) await writeFile(join(oldFolder(root), file), "left behind");
      const { host } = await open({ workspaceRoot: root, holder: guarded, trashItem: trash.trashItem });
      expect(await names(host, approved)).toEqual(["Camera"]);
      expect(await oldFiles(root)).toEqual([]);
      expect(trash.items.slice(-2).sort()).toEqual(["state.sqlite-shm", "state.sqlite-wal"]);
    });

    // Another computer keeps the Collections meanwhile, with this store's id, as an "earlier installation" Keep there does.
    const keptElsewhere = (root: string, storeId: string | null, when: () => boolean) => {
      let kept = false;
      return { here: () => here, required: () => {
        if (!kept && when()) { kept = true; writeFileSync(recordFile(root), JSON.stringify({ version: 1, workspaceId: "w", installId: laptop.installId, label: laptop.label, storeId })); }
        return true;
      } };
    };
    const oldBytes = async (root: string) => Promise.all(["state.sqlite", "state.sqlite-wal"].map(file => readFile(join(oldFolder(root), file))));

    it("throws the copy away and refuses when the record changes before the copy takes the store's place", async () => {
      const { root, storeId } = await storeInOldPlace();
      const before = await oldBytes(root), trash = systemTrash();
      // The record changes once the copy is made, before its rename.
      const holder = keptElsewhere(root, storeId, () => existsSync(`${localStore(root)}.moving`));
      expect((await refusedOpen(root, { holder, trashItem: trash.trashItem })).refusal).toMatchObject({ kind: "elsewhere", computer: laptop });
      expect(await datasetFiles(root), "no store and no copy here").toEqual([]);
      expect(await oldBytes(root)).toEqual(before);
      expect(trash.trashItem).not.toHaveBeenCalled();
      expect(await readRecord(root)).toMatchObject({ installId: "install-laptop", storeId });
    });

    it("keeps the moved store but trashes nothing and refuses when the record changes after the rename", async () => {
      const { root, storeId } = await storeInOldPlace();
      const before = await oldBytes(root), trash = systemTrash();
      const holder = keptElsewhere(root, storeId, () => existsSync(localStore(root)) && existsSync(join(oldFolder(root), "state.sqlite")));
      expect((await refusedOpen(root, { holder, trashItem: trash.trashItem })).refusal).toMatchObject({ kind: "elsewhere", computer: laptop });
      expect(storeIdIn(root), "the moved store stays").toBe(storeId);
      expect(await oldBytes(root)).toEqual(before);
      expect(trash.trashItem).not.toHaveBeenCalled();
    });

    it("refuses, touching nothing, when the store in .dohc/local has another id", async () => {
      const { root } = await storeInOldPlace();
      const other = await storeWithoutRecord();
      await copyFile(localStore(other.root), localStore(root));
      const read = async () => Promise.all([readFile(localStore(root)), ...(await oldFiles(root))!.map(file => readFile(join(oldFolder(root), file)))]);
      const before = await read();
      const trash = systemTrash();
      expect((await refusedOpen(root, { trashItem: trash.trashItem })).refusal).toEqual({ kind: "replaced", path: ".dohc/local/datasets/state.sqlite" });
      expect(await read()).toEqual(before);
      expect(await oldFiles(root)).toEqual(["state.sqlite", "state.sqlite-wal"]);
      expect(trash.trashItem).not.toHaveBeenCalled();
    });

    it("leaves the old files where they are when the trash refuses them, and trashes them at the next open", async () => {
      const { root, approved } = await storeInOldPlace();
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      const trash = systemTrash(), before = await oldBytes(root);
      trash.refuses = true;
      const first = await open({ workspaceRoot: root, holder: guarded, trashItem: trash.trashItem });
      expect(await names(first.host, approved)).toEqual(["Camera"]);
      // Read only: nothing was checkpointed into the old store, and its -wal stays.
      expect(await oldBytes(root)).toEqual(before);
      expect(warned).toHaveBeenCalled();
      await first.host.close(); hosts.splice(hosts.indexOf(first.host), 1);
      trash.refuses = false;
      const { host } = await open({ workspaceRoot: root, holder: guarded, trashItem: trash.trashItem });
      expect(await names(host, approved)).toEqual(["Camera"]);
      expect(await oldFiles(root)).toEqual([]);
      expect(trash.items[0]).toBe("state.sqlite");
    });

    it("never copies, trashes or opens an old copy on a computer that does not keep the Collections", async () => {
      const { root, storeId } = await storeInOldPlace();
      const trash = systemTrash();
      const before = await Promise.all((await oldFiles(root))!.map(file => readFile(join(oldFolder(root), file))));
      for (const [computer, named] of [[laptop, storeId], [laptop, null]] as const) {
        await writeRecord(root, computer, named);
        expect((await refusedOpen(root, { trashItem: trash.trashItem })).refusal.kind).toBe("elsewhere");
        // Keep asks nothing and changes nothing while the record names no store and a copy is here.
        if (named === null) await expect(keepCollectionsHere(root, "w", here, keepSteps(root))).rejects.toThrow("These Collections are on Laptop.");
      }
      await rm(recordFile(root));
      expect((await refusedOpen(root, { trashItem: trash.trashItem })).refusal).toEqual({ kind: "unclaimed" });
      expect(await Promise.all((await oldFiles(root))!.map(file => readFile(join(oldFolder(root), file))))).toEqual(before);
      expect(await datasetFiles(root)).toEqual([]);
      expect(trash.trashItem).not.toHaveBeenCalled();
    });

    it("keeps an earlier installation's store that is still there, and moves it at the next open", async () => {
      const { root, approved, storeId } = await storeInOldPlace();
      await writeRecord(root, { installId: "install-before", label: "Studio" }, storeId);
      expect(await localDatasetStoreId(root)).toBe(storeId);
      expect(await keepCollectionsHere(root, "w", here, keepSteps(root))).toBe(true);
      expect(await readRecord(root)).toMatchObject({ installId: "install-here", storeId });
      const { host } = await open({ workspaceRoot: root, holder: guarded, trashItem: systemTrash().trashItem });
      expect(await names(host, approved)).toEqual(["Camera"]);
      expect(await oldFiles(root)).toEqual([]);
    });

    it("moves a store from before the record once a person keeps the Collections here", async () => {
      const { root, approved } = await storeWithoutRecord();
      await mkdir(oldFolder(root));
      await rename(localStore(root), join(oldFolder(root), "state.sqlite"));
      expect((await refusedOpen(root)).refusal).toEqual({ kind: "unclaimed" });
      expect(await oldFiles(root)).toEqual(["state.sqlite"]);
      await keepCollectionsHere(root, "w", here, keepSteps(root));
      const { storeId } = await readRecord(root);
      const trash = systemTrash();
      const { host } = await open({ workspaceRoot: root, holder: guarded, trashItem: trash.trashItem });
      expect(await names(host, approved)).toEqual(["Camera"]);
      expect(storeIdIn(root)).toBe(storeId);
      expect(await oldFiles(root)).toEqual([]);
    });


  });
});
