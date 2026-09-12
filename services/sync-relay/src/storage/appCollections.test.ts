import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { parseAppPublicationCandidate, type AppPublicationCandidate, type AppCollectionCapability } from "@dohc/security-contract/app-publication";
import { parseCollectionRecordFields } from "@dohc/workspace-contracts/collection-values";
import { openSyncRelayStorage } from "../storage";
import { createSyncRelayHandler } from "../server";
import type { StorageContext } from "./context";
import type { AcceptAppCollectionInput } from "./appCollections";

const hash = (value:string|Uint8Array) => createHash("sha256").update(value).digest("hex");
const limits = {maxFiles:10,maxMetadataBytes:16_384,maxBundleBytes:4096};
const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanups.splice(0).reverse()) close();});
const schemaText = "fields:\n  name:\n    type: text\n  destination:\n    type: select\n    options: [Tokyo, Manila]\n  secret:\n    type: text\n";
const capability:AppCollectionCapability = {kind:"collection-create",collectionPath:"responses",schemaSha256:hash(schemaText),allowedFields:["destination","name"],requiredFields:["destination"],readFields:["destination","name"]};
const script = Buffer.from("document.body.textContent='Trip poll'");
function candidate():AppPublicationCandidate {
  const value = parseAppPublicationCandidate({versionId:"main",appRoot:"app",entryPath:"app/index.ts",packageMap:{},sourceRevision:"1".repeat(64),sourceDigest:"2".repeat(64),dependencyLockDigest:"3".repeat(64),bundleDigest:"4".repeat(64),buildDigest:"5".repeat(64),compilerIdentity:{recipe:"closed-esbuild",version:"0.28.1",binarySha256:"6".repeat(64)},inputs:[{path:"app/index.ts",sha256:"7".repeat(64),byteLength:20}],dependencies:["app/index.ts"],files:[{path:"bundle.js",sha256:hash(script),byteLength:script.byteLength,contentType:"text/javascript; charset=utf-8"}],capabilities:[capability]},limits);
  const digest = (domain:string,value:unknown) => hash(JSON.stringify([domain,value]));
  value.sourceDigest=digest("dohc-app-source-v2",{entry:value.entryPath,files:value.inputs,packages:[]});
  value.dependencyLockDigest=digest("dohc-app-dependencies-v1",value.inputs);
  value.bundleDigest=digest("dohc-app-bundle-v1",value.files);
  value.buildDigest=digest("dohc-app-build-v1",{sourceDigest:value.sourceDigest,dependencyLockDigest:value.dependencyLockDigest,compiler:value.compilerIdentity,bundleDigest:value.bundleDigest});return value;
}
function fixture() {
  const directory=mkdtempSync(join(tmpdir(),"app-collections-")),path=join(directory,"relay.sqlite");
  cleanups.push(()=>rmSync(directory,{recursive:true,force:true}));
  let storage=openSyncRelayStorage(path);
  cleanups.push(()=>storage.close());
  storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});
  storage.createShare({share:{shareId:"s",workspaceId:"w",granterUserId:"owner",selectorJson:JSON.stringify({paths:["app","responses"],versionId:null}),createdAtMs:1},grant:{grantId:"g",shareId:"s",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"view",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
  (storage as StorageContext).db.prepare("UPDATE sync_relay_share_grants SET principal_kind='link',principal_user_id=NULL WHERE grant_id='g'").run();
  function write(path:string,text:string,objectId=path,operation="write") {
    const before=(storage as StorageContext).db.prepare("SELECT blob_sha256 FROM sync_relay_current_files WHERE workspace_id='w' AND version_id='main' AND path=?").get(path);
    const now=storage.maxOriginSeq("w","owner")+2;
    storage.putBlob({workspaceId:"w",sha256:hash(text),content:Buffer.from(text),createdAtMs:now});
    storage.appendLogBatch({workspaceId:"w",originId:"owner",ops:[{originSeq:now-1,opKind:"moment.append",recordedAtMs:now,payloadJson:JSON.stringify({momentId:`owner-${now}`,versionId:"main",objectId,path,recordedAtMs:now,operation,beforePresent:before?"present":"null",payloadBeforeBlobSha256:before?.blob_sha256??null,payloadBeforePath:before?path:null,payloadAfterBlobSha256:operation==="delete"?null:hash(text),payloadAfterPath:operation==="delete"?null:path,payloadAfterContentKind:"text",payloadAfterByteLength:Buffer.byteLength(text),metadata:{origin:"api"}})}]});
  }
  write("responses/collection.yaml",schemaText);
  const publication=storage.publishAppPublication({workspaceId:"w",shareId:"s",grantId:"g",generation:1,ownerUserId:"owner",candidate:candidate(),blobs:[{sha256:hash(script),bytes:script}],limits,nowMs:10});
  const owner={workspaceId:"w",publicationId:publication.publicationId,ownerUserId:"owner",limits};
  storage.approveAppCollection({...owner,expectedAuthorityRevision:1,capability});
  storage.mintLinkSession({session:{sessionId:"session",capabilityHash:"session-secret-hash",grantId:"g",generation:1,mintedAtMs:2,expiresAtMs:10000}});
  const input:AcceptAppCollectionInput={publicationId:publication.publicationId,capabilityHash:"session-secret-hash",profileTokenHash:"profile-secret-hash",nowMs:20,limits,expectedAuthorityRevision:2,idempotencyKey:"vote-1",fields:{destination:"Tokyo",name:"Ice"}};
  return {directory,path,owner,input,write,get storage(){return storage;},get raw(){return (storage as StorageContext).db;},restart(){storage.close();storage=openSyncRelayStorage(path);},accept(patch:Partial<AcceptAppCollectionInput>={},maxCreatesPerGrant=100){return storage.acceptAppCollection({...input,...patch},{maxCreatesPerGrant});}};
}

it("accepts one durable workspace moment and payload-bound receipt across retries and restart",()=>{
  const f=fixture(), receipt=f.accept();
  expect(receipt.kind).toBe("accepted");expect(receipt.path).toMatch(/^responses\/accepted_/);expect(receipt).not.toHaveProperty("recordId");
  const row=f.storage.fetchLogPage({workspaceId:"w",sinceRelaySeq:1,limit:10}).rows[0];
  expect(row.originId).toBe("relay:collection-create:g");
  const payload=JSON.parse(row.payloadJson),blob=f.storage.getBlob("w",payload.payloadAfterBlobSha256)!;
  const record=parseCollectionRecordFields(Buffer.from(blob).toString("utf8"))!;
  expect(record).toMatchObject({destination:"Tokyo",name:"Ice",created_at:20,grant_id:"g",idempotency_key:"vote-1",acceptance_id:receipt.acceptanceId});
  expect(record).not.toHaveProperty("id");expect(record.created_by).toMatch(/^public_/);
  expect(payload).toMatchObject({metadata:{origin:"sync"},author:{kind:"public",principalId:record.created_by,grantId:"g"}});
  const privatePrincipal=f.raw.prepare("SELECT principal_id FROM sync_relay_link_principals").get()!.principal_id;
  expect(JSON.stringify(payload)+Buffer.from(blob).toString()).not.toContain(privatePrincipal);
  expect(f.accept({fields:{name:"Ice",destination:"Tokyo"}})).toEqual(receipt);
  f.restart();expect(f.accept()).toEqual(receipt);
  expect(()=>f.accept({fields:{destination:"Manila"}})).toThrow(/another payload/);
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_app_collection_receipts").get()!.n).toBe(1);
  expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(0);
});

it.each([{}, {destination:"Mars"},{destination:"Tokyo",created_by:"owner"},{destination:"Tokyo",created_at:0},{destination:"Tokyo",id:"rec_forged"},{destination:"Tokyo",secret:"private"},{destination:"Tokyo",name:"a".repeat(9000)}])("refuses invalid fields atomically, case %#",fields=>{
  const f=fixture();expect(()=>f.accept({fields})).toThrow();
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_link_principals").get()!.n).toBe(0);
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_app_collection_receipts").get()!.n).toBe(0);
  expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(-1);
});

it.each(["withdraw","narrow","revoke","schema","owner","generation","expired","selector","paused","blocked","wrong-profile"])("rechecks %s before committing",kind=>{
  const f=fixture();
  if(kind==="withdraw")f.storage.withdrawAppPublication({...f.owner,expectedAuthorityRevision:2});
  if(kind==="narrow")f.storage.approveAppCollection({...f.owner,expectedAuthorityRevision:2,capability:null});
  if(kind==="revoke")f.storage.revokeShareGrant({shareId:"s",grantId:"g",revokedAtMs:21});
  if(kind==="schema")f.write("responses/collection.yaml",schemaText+"name: changed\n");
  if(kind==="owner")f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='other'").run();
  if(kind==="generation")f.raw.prepare("UPDATE sync_relay_share_grants SET generation=2").run();
  if(kind==="expired")f.input.nowMs=10000;
  if(kind==="selector")f.raw.prepare("UPDATE sync_relay_shares SET selector_json=?").run(JSON.stringify({paths:["app"],versionId:null}));
  if(kind==="paused")f.raw.prepare("UPDATE sync_relay_shares SET link_writes_paused_at_ms=21").run();
  if(kind==="blocked"||kind==="wrong-profile") {f.accept();if(kind==="blocked")f.raw.prepare("UPDATE sync_relay_link_principals SET blocked_at_ms=21").run();else f.input.profileTokenHash="wrong";}
  const before=f.storage.maxOriginSeq("w","relay:collection-create:g");
  expect(()=>f.accept({idempotencyKey:"next"})).toThrow();expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(before);
});

it("charges fresh keys for the grant lifetime while replay and owner deletion never refill quota",()=>{
  const f=fixture(),receipt=f.accept({},1);
  expect(()=>f.accept({idempotencyKey:"another"},1)).toThrow(/quota/);
  f.write(receipt.path,"",receipt.objectId,"delete");
  expect(f.storage.readAppCollection({...f.input,limit:10})).toEqual({records:[],nextPath:null});
  expect(f.accept({},1)).toEqual(receipt);
  expect(()=>f.accept({idempotencyKey:"after-delete"},1)).toThrow(/quota/);
  expect(f.storage.readAppCollection({...f.input,limit:10}).records).toHaveLength(0);
});

it("reads owner-updated projection and only approved fields, including adopted record IDs",()=>{
  const f=fixture(),receipt=f.accept();
  expect(f.storage.readAppCollection({...f.input,limit:1})).toEqual({records:[{path:receipt.path,recordId:null,fields:{destination:"Tokyo",name:"Ice"}}],nextPath:null});
  f.write(receipt.path,"---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nname: Owner changed\ndestination: Manila\nsecret: DO_NOT_SHARE\n---\n",receipt.objectId);
  const page=f.storage.readAppCollection({...f.input,limit:10});
  expect(page.records[0]).toEqual({path:receipt.path,recordId:"rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",fields:{destination:"Manila",name:"Owner changed"}});
  expect(JSON.stringify(page)).not.toContain("DO_NOT_SHARE");
  f.write("responses/collection.yaml",schemaText+"description: drift\n");
  expect(()=>f.storage.readAppCollection({...f.input,limit:10})).toThrow();
});

it("keeps idempotency and mapping through an actual SQLite backup",async()=>{
  const f=fixture(),receipt=f.accept(),backupPath=join(f.directory,"backup.sqlite");
  const db=new DatabaseSync(f.path,{readOnly:true});try{await backup(db,backupPath);}finally{db.close();}
  const restored=openSyncRelayStorage(backupPath);cleanups.push(()=>restored.close());
  expect(restored.acceptAppCollection(f.input,{maxCreatesPerGrant:1})).toEqual(receipt);
  expect(()=>restored.acceptAppCollection({...f.input,idempotencyKey:"new"},{maxCreatesPerGrant:1})).toThrow(/quota/);
  expect(restored.readAppCollection({...f.input,limit:10})).toEqual(f.storage.readAppCollection({...f.input,limit:10}));
});

it("refuses approval widening and unselected collections before updating revision",()=>{
  const f=fixture();
  for(const approval of [{...capability,allowedFields:[...capability.allowedFields,"secret"]},{...capability,requiredFields:[]},{...capability,collectionPath:"private"},{...capability,readFields:[...capability.readFields,"secret"]}])expect(()=>f.storage.approveAppCollection({...f.owner,expectedAuthorityRevision:2,capability:approval})).toThrow();
  expect(f.storage.readAppPublication(f.owner).authorityRevision).toBe(2);
});

it("does not activate a public response route",async()=>{
  const f=fixture(),handler=createSyncRelayHandler({storage:f.storage,appPublicationLimits:limits,resolveActor:()=>({workspaceId:"w",userId:"owner"})});
  const response=await handler(new Request(`http://relay/sync/link/app-publications/${f.input.publicationId}/collection`,{method:"POST",body:JSON.stringify({fields:{destination:"Tokyo"}})}));
  expect(response.status).toBe(404);
});

async function writer(path:string) {
  const child=fork(fileURLToPath(new URL("../testing/appCollectionWriter.ts",import.meta.url)),[path],{execArgv:["--import","tsx/esm"],stdio:["ignore","ignore","pipe","ipc"]});
  let errors="";child.stderr!.on("data",data=>{errors+=data.toString();});
  await new Promise<void>((resolve,reject)=>{child.once("message",()=>resolve());child.once("error",reject);child.once("exit",code=>{if(code)reject(new Error(errors));});});
  return {child,send(input:AcceptAppCollectionInput){return new Promise<any>((resolve,reject)=>{child.once("message",resolve);child.once("error",reject);child.send(input);});}};
}
it("serializes concurrent retry acceptance on independent SQLite connections",async()=>{
  const f=fixture(),a=await writer(f.path),b=await writer(f.path);
  const [first,second]=await Promise.all([a.send(f.input),b.send(f.input)]);
  expect(first.kind).toBe("accepted");expect(second).toEqual(first);
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_app_collection_receipts").get()!.n).toBe(1);
  expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(0);
});
it("refuses a worker request prepared before owner withdrawal",async()=>{
  const f=fixture(),pending=await writer(f.path);
  f.storage.withdrawAppPublication({...f.owner,expectedAuthorityRevision:2});
  const result=await pending.send(f.input);expect(result.kind).toBe("refused");
  expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(-1);
});
