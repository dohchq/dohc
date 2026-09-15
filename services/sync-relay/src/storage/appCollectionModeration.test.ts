import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseAppPublicationCandidate, type AppPublicationCandidate, type AppCollectionCapability } from "@dohc/security-contract/app-publication";
import { openSyncRelayStorage } from "../storage";
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

const ownerPage = {workspaceId:"w",ownerUserId:"owner",grantId:"g",limit:100};

it("selects immutable public acceptances and keeps private identities out of the result",()=>{
  const f=fixture(), first=f.accept(), second=f.accept({idempotencyKey:"second"});
  f.storage.mintLinkSession({session:{sessionId:"session-other",capabilityHash:"other-session-hash",grantId:"g",generation:1,mintedAtMs:2,expiresAtMs:10000}});
  const other=f.accept({idempotencyKey:"other",capabilityHash:"other-session-hash",profileTokenHash:"another-profile"});
  const page=f.storage.readOwnerAppCollectionAcceptances(ownerPage);
  expect(page.acceptances.map(x=>x.acceptanceId).sort()).toEqual([first,second,other].map(x=>x.acceptanceId).sort());
  const publicId=page.acceptances.find(x=>x.acceptanceId===first.acceptanceId)!.publicPrincipalId;
  expect(f.storage.readOwnerAppCollectionAcceptances({...ownerPage,publicPrincipalId:publicId}).acceptances).toHaveLength(2);
  expect(page.acceptances[0]).toMatchObject({versionId:"main",collectionPath:"responses"});
  const privateIds=f.raw.prepare("SELECT principal_id FROM sync_relay_link_principals").all().map(x=>String(x.principal_id));
  for(const privateId of privateIds) expect(JSON.stringify(page)).not.toContain(privateId);
  expect(JSON.stringify(page)).not.toContain("profile-secret-hash");
  expect(JSON.stringify(page)).not.toContain("idempotencyKey");
  // Current contents cannot change attribution or nominate an unrelated file.
  f.write(first.path,"---\ncreated_by: forged\nacceptance_id: forged\n---\n",first.objectId);
  expect(f.storage.readOwnerAppCollectionAcceptances(ownerPage)).toEqual(page);
  f.write(first.path,"",first.objectId,"delete");
  f.storage.revokeShareGrant({shareId:"s",grantId:"g",revokedAtMs:21});
  expect(f.storage.readOwnerAppCollectionAcceptances(ownerPage)).toEqual(page);
});

it("pages without repeats and refuses another owner or workspace",()=>{
  const f=fixture();
  for(let i=0;i<3;i++)f.accept({idempotencyKey:`vote-${i}`});
  const ids:string[]=[];let cursor:string|undefined;
  do {const page=f.storage.readOwnerAppCollectionAcceptances({...ownerPage,limit:1,afterAcceptanceId:cursor});
    ids.push(...page.acceptances.map(x=>x.acceptanceId));cursor=page.nextAcceptanceId??undefined;} while(cursor);
  expect(ids).toHaveLength(3);expect(new Set(ids).size).toBe(3);
  expect(()=>f.storage.readOwnerAppCollectionAcceptances({...ownerPage,ownerUserId:"other"})).toThrow();
  expect(()=>f.storage.readOwnerAppCollectionAcceptances({...ownerPage,workspaceId:"other"})).toThrow();
  expect(f.storage.readOwnerAppCollectionAcceptances({...ownerPage,publicPrincipalId:"foreign-public"}).acceptances).toEqual([]);
  for(const limit of [0,101,1.5])expect(()=>f.storage.readOwnerAppCollectionAcceptances({...ownerPage,limit})).toThrow();
});

it("refuses a receipt that no longer matches its original server moment",()=>{
  const f=fixture(),receipt=f.accept();
  f.raw.prepare("UPDATE sync_relay_app_collection_receipts SET receipt_json=?").run(JSON.stringify({...receipt,objectId:"another-object"}));
  expect(()=>f.storage.readOwnerAppCollectionAcceptances(ownerPage)).toThrow(/damaged/);
});

it("refuses a missing public mapping instead of silently hiding its receipt",()=>{
  const f=fixture();f.accept();
  f.raw.prepare("DELETE FROM sync_relay_app_public_principals").run();
  expect(()=>f.storage.readOwnerAppCollectionAcceptances(ownerPage)).toThrow(/damaged/);
});

it.each(["not json","null","x".repeat(8193)])("refuses damaged or oversized receipt metadata",receipt=>{
  const f=fixture();f.accept();
  f.raw.prepare("UPDATE sync_relay_app_collection_receipts SET receipt_json=?").run(receipt);
  expect(()=>f.storage.readOwnerAppCollectionAcceptances(ownerPage)).toThrow(/damaged/);
});

it("keeps owner selection stable through restart",()=>{
  const f=fixture();f.accept();const page=f.storage.readOwnerAppCollectionAcceptances(ownerPage);
  f.restart();expect(f.storage.readOwnerAppCollectionAcceptances(ownerPage)).toEqual(page);
});
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
