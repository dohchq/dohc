import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { fixture, limits } from "../../../../services/sync-relay/src/datasetTestFixture";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import type { DatasetReplicaSource } from "@dohc/app-backend-runtime/replica";
import type { OwnerDatasetData } from "./remoteDataset";
import { createOwnerDatasetCopy } from "./ownerDatasetCopy";
import { DatasetCopyOfflineError } from "./remoteDatasetReplica";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;

it("persists real owner reads across restart, catches up, and refuses offline writes and revoked access", async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(),"desktop-owner-copy-"));
  const host = await f.storage.createDatasetHost({directory:join(directory,"host"),limits,onShutdownError(error){throw error;}});
  const actor = {kind:"named" as const,workspaceId:"w",userId:"owner"}, scope = {workspaceId:"w",datasetId:id(1)};
  const definition: DatasetDefinition = {formatVersion:1,datasetId:id(1),name:"Entries",schemaPath:"schema.sql",operationsPath:"actions.js",
    tables:[{tableId:id(2),name:"Entries",sqlName:"entries",primaryKey:"id",fields:[{fieldId:id(3),name:"ID",sqlColumn:"id",type:"number",required:true,unique:true},{fieldId:id(4),name:"Name",sqlColumn:"name",type:"text",required:true,unique:false}]}],
    operations:[{operationId:id(5),name:"add",label:"Add",kind:"create",tableId:id(2),access:"owner",readOnly:false,fieldIds:[id(4)]},{operationId:id(6),name:"read",label:"Read",kind:"read",tableId:id(2),access:"owner",readOnly:true,fieldIds:[id(3),id(4)]}]};
  const schemaSql="CREATE TABLE entries(id INTEGER PRIMARY KEY,name TEXT NOT NULL);", operationSource="globalThis.operations={add(ctx,input){ctx.db.execute('INSERT INTO entries(name) VALUES(?)',[input.name]);return null;},read(ctx){return ctx.db.query('SELECT * FROM entries ORDER BY id');}};";
  const revision=describeDatasetRevision({definition,revision:1,schemaSql,operationSource});
  const options={directory:join(directory,"copy"),scope,ownerKey:"owner",origin:"https://relay",assertOwner(){}};
  let copy=await createOwnerDatasetCopy(options), offline=false, denied=false, archived=false;
  const blob=vi.fn(async(input:Parameters<DatasetReplicaSource["blob"]>[0])=>host.replicaBlob(actor,{...scope,...input}));
  const source:DatasetReplicaSource={async capture(){if(denied){copy.accessLost();throw Error("revoked");}if(offline)throw new DatasetCopyOfflineError("offline");return host.replicaCapture(actor,scope);},async page(input){return host.replicaPage(actor,{...scope,...input});},blob};
  const pinned={...scope,revision:1,revisionSha256:revision.revisionSha256};
  const invoke=vi.fn(async(input:Parameters<OwnerDatasetData["invoke"]>[0])=>host.invoke(actor,{...input,workspaceId:"w",access:{kind:"data"}}));
  const remote={invoke,async describe(){if(offline)throw new TypeError("fetch failed"); return {...host.describe(actor,scope),archived};}} as unknown as OwnerDatasetData;
  const signal=new AbortController().signal;
  try {
    await host.activate(actor,{workspaceId:"w",revision,schemaSql,operationSource});
    await invoke({...pinned,operationId:id(5),input:{name:"Mom"},idempotencyKey:"first"});
    expect((await copy.data(remote,source,signal).describe(id(1))).name).toBe("Entries"); expect(blob).not.toHaveBeenCalled();
    archived=true; expect(await copy.data(remote,source,signal).inspect!(id(1))).toMatchObject({dataset:{archived:true}}); expect(blob).not.toHaveBeenCalled();
    await copy.close(); copy=await createOwnerDatasetCopy(options); offline=true;
    expect(await copy.data(remote,source,signal).inspect!(id(1))).toMatchObject({dataset:{archived:true},copy:{offline:true}});
    await expect(copy.data(remote,source,signal).invoke({...pinned,operationId:id(6),input:{},idempotencyKey:"archived"})).rejects.toThrow(/archived/);
    offline=false;archived=false;
    const inspect=await copy.data(remote,source,signal).inspect!(id(1)); expect(inspect.copy?.offline).toBe(false);
    expect(inspect.dataset.tables[0]!.fields[0]).not.toHaveProperty("sqlColumn");
    await copy.close(); copy=await createOwnerDatasetCopy(options); offline=true;
    expect((await copy.data(remote,source,signal).describe(id(1))).name).toBe("Entries");
    const read={...pinned,operationId:id(6),input:{},idempotencyKey:"read"};
    expect(await copy.data(remote,source,signal).invoke(read)).toMatchObject({result:[{id:1,name:"Mom"}],copy:{offline:true}});
    await expect(copy.data(remote,source,signal).invoke({...read,operationId:id(5)})).rejects.toThrow(/read-only/);
    expect(invoke).toHaveBeenCalledOnce();
    offline=false; await invoke({...pinned,operationId:id(5),input:{name:"Friend"},idempotencyKey:"second"});
    expect(await copy.data(remote,source,signal).invoke(read)).toMatchObject({result:[{id:1,name:"Mom"},{id:2,name:"Friend"}],copy:{offline:false}});
    denied=true; await expect(copy.data(remote,source,signal).invoke(read)).rejects.toThrow("revoked");
    offline=true; await expect(copy.data(remote,source,signal).invoke(read)).rejects.toThrow(/unavailable/);
  } finally {await copy.close();await host.close();await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:25});}
}, 15_000);

