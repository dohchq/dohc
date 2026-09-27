import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAppPublicationCandidate, APP_COLLECTION_RESPONSE_BYTES, type AppPublicationCandidate, type AppCollectionCapability } from "@dohc/security-contract/app-publication";
import { parseCollectionRecordFields } from "@dohc/workspace-contracts/collection-values";
import { openSyncRelayStorage } from "../storage";
import { createSyncRelayHandler,type CreateSyncRelayHandlerOptions } from "../server";
import {hashLinkBearer,hashLinkProfileSecret,LinkEgressRateLimiter} from "../linkSecurity";
import {TokenBucketLimiter} from "@dohc/service-http";
import type { StorageContext } from "./context";
import type { AcceptAppCollectionInput } from "./appCollections";
import { DiscussionActivityHub } from "../discussionActivity";

const hash = (value:string|Uint8Array) => createHash("sha256").update(value).digest("hex");
const limits = {maxFiles:10,maxMetadataBytes:16_384,maxBundleBytes:4096};
const cleanups:(()=>void)[]=[];
const children=new Map<ChildProcess,Promise<void>>();
afterEach(async()=>{
  vi.restoreAllMocks();
  for(const [child,exited] of children){if(child.exitCode===null && child.signalCode===null) child.kill();await exited;children.delete(child);}
  for(const close of cleanups.splice(0).reverse()) close();
});
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
  const input:AcceptAppCollectionInput={publicationId:publication.publicationId,capabilityHash:"session-secret-hash",profileTokenHash:"profile-secret-hash",nowMs:20,limits,expectedAuthorityRevision:2,idempotencyKey:"vote-1",fields:{destination:"Tokyo",name:"Sam"}};
  return {directory,path,owner,input,write,get storage(){return storage;},get raw(){return (storage as StorageContext).db;},restart(){storage.close();storage=openSyncRelayStorage(path);},accept(patch:Partial<AcceptAppCollectionInput>={},maxCreatesPerGrant=100){return storage.acceptAppCollection({...input,...patch},{maxCreatesPerGrant});}};
}

it("accepts one durable workspace moment and payload-bound receipt across retries and restart",()=>{
  const f=fixture(), receipt=f.accept();
  expect(receipt.kind).toBe("accepted");expect(receipt.path).toMatch(/^responses\/accepted_/);expect(receipt).not.toHaveProperty("recordId");
  const row=f.storage.fetchLogPage({workspaceId:"w",sinceRelaySeq:1,limit:10}).rows[0];
  expect(row.originId).toBe("relay:collection-create:g");
  const payload=JSON.parse(row.payloadJson),blob=f.storage.getBlob("w",payload.payloadAfterBlobSha256)!;
  const record=parseCollectionRecordFields(Buffer.from(blob).toString("utf8"))!;
  expect(record).toMatchObject({destination:"Tokyo",name:"Sam",created_at:20,grant_id:"g",acceptance_id:receipt.acceptanceId});
  expect(record).not.toHaveProperty("idempotency_key");
  expect(record).not.toHaveProperty("id");expect(record.created_by).toMatch(/^public_/);
  expect(payload).toMatchObject({metadata:{origin:"sync"},author:{kind:"public",principalId:record.created_by,grantId:"g"}});
  const privatePrincipal=f.raw.prepare("SELECT principal_id FROM sync_relay_link_principals").get()!.principal_id;
  expect(JSON.stringify(payload)+Buffer.from(blob).toString()).not.toContain(privatePrincipal);
  expect(f.accept({fields:{name:"Sam",destination:"Tokyo"}})).toEqual(receipt);
  f.restart();expect(f.accept()).toEqual(receipt);
  expect(()=>f.accept({fields:{destination:"Manila"}})).toThrow(/another payload/);
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_app_collection_receipts").get()!.n).toBe(1);
  expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(0);
});

it.each([{}, {destination:null},{destination:undefined}, {destination:"Mars"},{destination:"Tokyo",created_by:"owner"},{destination:"Tokyo",created_at:0},{destination:"Tokyo",id:"rec_forged"},{destination:"Tokyo",secret:"private"},{destination:"Tokyo",name:"a".repeat(9000)}])("refuses invalid fields atomically, case %#",fields=>{
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
  expect(f.storage.readAppCollection({...f.input,limit:1})).toEqual({records:[{path:receipt.path,recordId:null,fields:{destination:"Tokyo",name:"Sam"}}],nextPath:null});
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
  const loader=pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const child=fork(fileURLToPath(new URL("../testing/appCollectionWriter.ts",import.meta.url)),[path],{execArgv:["--import",loader],stdio:["ignore","ignore","pipe","ipc"]});
  children.set(child,new Promise(resolve=>child.once("close",()=>resolve())));
  let errors="";child.stderr!.on("data",data=>{errors+=data.toString();});
  await new Promise<void>((resolve,reject)=>{
    const deadline=setTimeout(()=>reject(new Error("Collection writer did not become ready within 40 seconds.")),40_000);
    child.once("message",()=>{clearTimeout(deadline);resolve();});
    child.once("error",error=>{clearTimeout(deadline);reject(error);});
    child.once("exit",()=>{clearTimeout(deadline);reject(new Error(errors||"Collection writer exited before readiness."));});
  });
  return {child,send(input:AcceptAppCollectionInput){return new Promise<any>((resolve,reject)=>{child.once("message",resolve);child.once("error",reject);child.send(input);});}};
}
describe("independent SQLite writers",()=>{
let f:ReturnType<typeof fixture>,a:Awaited<ReturnType<typeof writer>>,b:Awaited<ReturnType<typeof writer>>;
beforeEach(async()=>{f=fixture();[a,b]=await Promise.all([writer(f.path),writer(f.path)]);},45_000);
it("serializes concurrent retry acceptance on independent SQLite connections",async()=>{
  const [first,second]=await Promise.all([a.send(f.input),b.send(f.input)]);
  expect(first.kind).toBe("accepted");expect(second).toEqual(first);
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_app_collection_receipts").get()!.n).toBe(1);
  expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(0);
});
it("refuses a worker request prepared before owner withdrawal",async()=>{
  f.storage.withdrawAppPublication({...f.owner,expectedAuthorityRevision:2});
  const result=await a.send(f.input);expect(result.kind).toBe("refused");
  expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(-1);
});
it("makes conflicting concurrent payloads produce one receipt and one refusal",async()=>{
  const outcomes=await Promise.all([a.send(f.input),b.send({...f.input,fields:{destination:"Manila"}})]);
  expect(outcomes.map(result=>result.kind).sort()).toEqual(["accepted","refused"]);
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_app_collection_receipts").get()!.n).toBe(1);
});
});

it("rolls back the blob, enrollment, public mapping and receipt when log append fails",()=>{
  const f=fixture(),usage=Number(f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'").get()!.usage_bytes);
  f.raw.exec("CREATE TRIGGER reject_collection_log BEFORE INSERT ON sync_relay_log WHEN NEW.origin_id LIKE 'relay:collection-create:%' BEGIN SELECT RAISE(ABORT,'injected log failure'); END;");
  expect(()=>f.accept()).toThrow(/injected/);
  for(const table of ["sync_relay_app_collection_receipts","sync_relay_app_public_principals","sync_relay_link_principals"])expect(f.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0);
  expect(Number(f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'").get()!.usage_bytes)).toBe(usage);
  expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(-1);
  f.raw.exec("DROP TRIGGER reject_collection_log");expect(f.accept().kind).toBe("accepted");
});

it("maps the same profile to unrelated public identities across grants",()=>{
  const f=fixture();f.accept();
  f.raw.prepare("INSERT INTO sync_relay_share_grants SELECT 'g2',share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id FROM sync_relay_share_grants WHERE grant_id='g'").run();
  const publication=f.storage.publishAppPublication({workspaceId:"w",shareId:"s",grantId:"g2",generation:1,ownerUserId:"owner",candidate:candidate(),blobs:[],limits,nowMs:25});
  f.storage.approveAppCollection({...f.owner,publicationId:publication.publicationId,expectedAuthorityRevision:1,capability});
  f.storage.mintLinkSession({session:{sessionId:"session2",capabilityHash:"second-session",grantId:"g2",generation:1,mintedAtMs:2,expiresAtMs:10000}});
  f.accept({publicationId:publication.publicationId,capabilityHash:"second-session"});
  const mappings=f.raw.prepare("SELECT public_principal_id,principal_id FROM sync_relay_app_public_principals ORDER BY grant_id").all();
  expect(mappings).toHaveLength(2);expect(mappings[0].public_principal_id).not.toBe(mappings[1].public_principal_id);
  expect(mappings[0].principal_id).not.toBe(mappings[1].principal_id);
});

it("keeps accepted principals and receipts when principal cleanup is attempted",()=>{
  const f=fixture(),receipt=f.accept({},1);
  expect(()=>f.raw.prepare("DELETE FROM sync_relay_link_principals").run()).toThrow(/FOREIGN KEY/);
  expect(f.accept({},1)).toEqual(receipt);
  expect(()=>f.accept({idempotencyKey:"second"},1)).toThrow(/quota/);
});

it("charges approval bytes and refunds narrowing without refilling create quota",()=>{
  const f=fixture();
  const usage=()=>Number(f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'").get()!.usage_bytes);
  const before=usage(),size=Number(f.raw.prepare("SELECT storage_bytes FROM sync_relay_app_collection_approvals").get()!.storage_bytes);
  f.storage.approveAppCollection({...f.owner,expectedAuthorityRevision:2,capability:null});
  const reduced=Number(f.raw.prepare("SELECT storage_bytes FROM sync_relay_app_collection_approvals").get()!.storage_bytes);
  expect(usage()).toBe(before-size+reduced);
  const other=openSyncRelayStorage(f.path,{workspaceQuotaBytes:usage()});cleanups.push(()=>other.close());
  expect(()=>other.approveAppCollection({...f.owner,expectedAuthorityRevision:3,capability})).toThrow(/quota/);
  expect(f.storage.readAppPublication(f.owner).authorityRevision).toBe(3);
});

it("skips an oversized projected response before loading its content",()=>{
  const f=fixture(),receipt=f.accept();f.write(receipt.path,"---\nname: "+"a".repeat(20_000)+"\ndestination: Tokyo\n---\n",receipt.objectId);
  expect(f.storage.readAppCollection({...f.input,limit:10})).toEqual({records:[],nextPath:null});
});

it("paginates past notes and invalid records while retaining valid responses",()=>{
  const f=fixture();f.write("responses/000-note.md","# Notes");f.write("responses/001-invalid.md","---\ndestination: Mars\n---\n");const receipt=f.accept();
  const first=f.storage.readAppCollection({...f.input,limit:1});expect(first).toEqual({records:[],nextPath:"responses/000-note.md"});
  const second=f.storage.readAppCollection({...f.input,limit:1,afterPath:first.nextPath!});expect(second).toEqual({records:[],nextPath:"responses/001-invalid.md"});
  const third=f.storage.readAppCollection({...f.input,limit:1,afterPath:second.nextPath!});expect(third.records[0].path).toBe(receipt.path);expect(third.nextPath).toBeNull();
});

it("reads Unicode collection roots without scanning outside their index range",()=>{
  const f=fixture(),unicode={...capability,collectionPath:"responses📊"};
  f.raw.prepare("UPDATE sync_relay_shares SET selector_json=?").run(JSON.stringify({paths:["app","responses","responses📊"],versionId:null}));
  f.write("responses📊/collection.yaml",schemaText);
  const source=candidate();source.capabilities=[unicode];
  const publication=f.storage.publishAppPublication({workspaceId:"w",shareId:"s",grantId:"g",generation:1,ownerUserId:"owner",candidate:source,blobs:[],limits,nowMs:20});
  f.storage.approveAppCollection({...f.owner,publicationId:publication.publicationId,expectedAuthorityRevision:1,capability:unicode});
  const input={...f.input,publicationId:publication.publicationId};const receipt=f.storage.acceptAppCollection(input,{maxCreatesPerGrant:5});
  expect(f.storage.readAppCollection({...input,limit:10}).records[0].path).toBe(receipt.path);
  const prepare=vi.spyOn(f.raw,"prepare");f.storage.readAppCollection({...input,limit:10});
  const sql=prepare.mock.calls.map(call=>String(call[0])).find(sql=>sql.includes("FROM sync_relay_current_files file LEFT JOIN"))!;
  prepare.mockRestore();
  const plan=f.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("w","main","","responses📊/","responses📊0","responses📊/",11);
  expect(plan.map(row=>row.detail).join("\n")).toMatch(/path>\? AND path<\?/);
});

it("refuses corrupt in-bound record blobs instead of treating corruption as a skipped note",()=>{
  const f=fixture(),receipt=f.accept();
  const row=f.raw.prepare("SELECT blob_sha256 FROM sync_relay_current_files WHERE path=?").get(receipt.path)!;
  f.raw.prepare("UPDATE sync_relay_blobs SET content=zeroblob(byte_length) WHERE sha256=?").run(row.blob_sha256);
  expect(()=>f.storage.readAppCollection({...f.input,limit:10})).toThrow(/not found/i);
});

it.each(["binary","non-utf8"])("skips validly stored %s folder content and reaches the response",kind=>{
  const f=fixture();f.write("responses/000-note.md","# Note");const receipt=f.accept();
  if(kind==="binary")f.raw.prepare("UPDATE sync_relay_current_files SET content_kind='binary' WHERE path='responses/000-note.md'").run();
  else {
    const content=Buffer.from([0xff,0xfe]),digest=hash(content);
    f.storage.putBlob({workspaceId:"w",sha256:digest,content,createdAtMs:30});
    f.raw.prepare("UPDATE sync_relay_current_files SET blob_sha256=? WHERE path='responses/000-note.md'").run(digest);
  }
  const first=f.storage.readAppCollection({...f.input,limit:1});expect(first).toEqual({records:[],nextPath:"responses/000-note.md"});
  expect(f.storage.readAppCollection({...f.input,limit:1,afterPath:first.nextPath!}).records[0].path).toBe(receipt.path);
});

function httpFixture(options:Partial<CreateSyncRelayHandlerOptions>={}) {
  const f=fixture(),token="A".repeat(43),profile="P".repeat(43),key="collection-test-key";
  f.input.capabilityHash=hashLinkBearer(token,key);f.input.profileTokenHash=hashLinkProfileSecret(profile,key);
  f.raw.prepare("UPDATE sync_relay_link_sessions SET capability_hash=?").run(f.input.capabilityHash);
  let now=20;
  const handler=createSyncRelayHandler({storage:f.storage,appPublicationLimits:limits,appCollectionPolicy:{maxCreatesPerGrant:100},linkKey:key,nowMs:()=>now,resolveActor:()=>{throw new Error("Collection routes must not resolve an account.");},...options});
  const path=`/sync/link/app-publications/${f.input.publicationId}/collection`;
  const headers={authorization:`LinkCapability ${token}`,"x-dohc-link-profile-secret":profile};
  const request=(method="GET",body?:unknown,query=method==="GET"?"?authorityRevision=2":"",extra:RequestInit={})=>handler(new Request(`https://relay${path}${query}`,{method,...extra,headers:{...headers,...(method==="POST"?{"content-type":"application/json"}:{}),...Object.fromEntries(new Headers(extra.headers))},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const body={authorityRevision:2,idempotencyKey:"vote-1",fields:{destination:"Tokyo",name:"Sam"}};
  return {...f,handler,path,headers,body,request,setTime(value:number){now=value;}};
}

it("wakes the owner's held log read when a link submission lands",async()=>{
  const activity=new DiscussionActivityHub();
  const f=httpFixture({discussionActivity:activity,resolveActor:(_request,workspaceId)=>({workspaceId,userId:"owner"})});
  const since=f.storage.fetchLogPage({workspaceId:"w",sinceRelaySeq:0,limit:500}).nextCursor;
  const held=f.handler(new Request(`https://relay/sync/w/log?since=${since}&hold=30000`,{headers:{authorization:"Bearer owner"}}));
  await vi.waitFor(()=>expect(activity.stats().waiters).toBe(1));
  expect((await f.request("POST",f.body)).status).toBe(200);
  // The submission's own request woke the read; the hold did not run out.
  expect(activity.stats().waiters).toBe(0);
  expect(await (await held).json()).toMatchObject({ok:true,ops:[],hasMore:true});
});

it.each([
  {access:"view",released:false,status:200},
  {access:"comment",released:false,status:200},
  {access:"edit",released:false,status:404},
  {access:"view",released:true,status:200},
  {access:"comment",released:true,status:200},
  {access:"edit",released:true,status:200},
])("keeps collection acceptance at $access independent of document Edit permission (release=$released)",({access,released,status})=>{
  const f=fixture();f.input.publicEditRelease=released?{version:1}:undefined;
  f.raw.prepare("UPDATE sync_relay_share_grants SET access=? WHERE grant_id='g'").run(access);
  let actual: number; try { f.accept(); actual=200; } catch { actual=404; } expect(actual).toBe(status);
  if(status===200){
    const receipt=f.accept();expect(receipt.kind).toBe("accepted");
    expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(0);
    f.storage.revokeShareGrant({shareId:"s",grantId:"g",revokedAtMs:21});
    expect(()=>f.accept({idempotencyKey:"after-revoke"})).toThrow();
    expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(0);
  }else expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(-1);
});

it("accepts concurrent independent principals through one link with separate retry receipts",async()=>{
  const f=httpFixture(),token="B".repeat(43),other={headers:{authorization:`LinkCapability ${token}`,"x-dohc-link-profile-secret":"Q".repeat(43)}};
  f.storage.mintLinkSession({session:{sessionId:"second-reader",capabilityHash:hashLinkBearer(token,"collection-test-key"),grantId:"g",generation:1,mintedAtMs:2,expiresAtMs:10000}});
  const bodies=[f.body,{...f.body,fields:{destination:"Manila",name:"Friend"}}];
  const replies=await Promise.all([f.request("POST",bodies[0]),f.request("POST",bodies[1],"",other)]);
  expect(replies.map(reply=>reply.status)).toEqual([200,200]);
  const receipts=await Promise.all(replies.map(reply=>reply.json()));expect(receipts[0].acceptanceId).not.toBe(receipts[1].acceptanceId);
  expect(f.raw.prepare("SELECT COUNT(DISTINCT principal_id) AS n FROM sync_relay_app_collection_receipts WHERE grant_id='g'").get()!.n).toBe(2);
  expect(f.raw.prepare("SELECT COUNT(DISTINCT public_principal_id) AS n FROM sync_relay_app_public_principals WHERE grant_id='g'").get()!.n).toBe(2);
  const retries=await Promise.all([f.request("POST",bodies[0]),f.request("POST",bodies[1],"",other)]);
  expect(await Promise.all(retries.map(reply=>reply.json()))).toEqual(receipts);
  const page=await f.request();expect((await page.json()).records.map((record:{fields:{destination:string}})=>record.fields.destination).sort()).toEqual(["Manila","Tokyo"]);
  expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(1);
});
it("uses the same authenticated HTTP read and create contract for an agent and browser broker",async()=>{
  const f=httpFixture();
  const created=await f.request("POST",f.body);expect(created.status).toBe(200);const receipt=await created.json();expect(receipt.kind).toBe("accepted");
  const replay=await f.request("POST",f.body,"",{headers:{origin:"https://trusted-app.example"}});expect(await replay.json()).toEqual(receipt);
  const page=await f.request();expect(page.status).toBe(200);expect(page.headers.get("cache-control")).toBe("private, no-store");expect(page.headers.get("access-control-allow-origin")).toBeNull();
  expect(await page.json()).toEqual({records:[{path:receipt.path,recordId:null,fields:{destination:"Tokyo",name:"Sam"}}],nextPath:null});
  expect((await f.request("POST",{...f.body,fields:{destination:"Manila"}})).status).toBe(404);
});

it.each([{ readFields: ["destination"] }, { readFields: [] }])("refuses collection approvals that imply private submitted fields with readFields $readFields", async ({ readFields }) => {
  const f = httpFixture();
  expect(() => f.storage.approveAppCollection({
    ...f.owner, expectedAuthorityRevision: 2, capability: { ...capability, readFields },
  })).toThrow(/Collection responses are shared files/);
  expect(f.storage.readAppPublication(f.owner).authorityRevision).toBe(2);

  // A previously stored approval must also fail closed without writing a response.
  f.raw.prepare("UPDATE sync_relay_app_collection_approvals SET capability_json=? WHERE publication_id=?")
    .run(JSON.stringify({ ...capability, readFields }), f.input.publicationId);
  expect((await f.request("POST", f.body)).status).toBe(404);
  expect((await f.request()).status).toBe(404);
  expect(f.storage.maxOriginSeq("w", "relay:collection-create:g")).toBe(-1);
});

it("keeps intentionally shared response files readable without private retry metadata", async () => {
  const f = httpFixture();
  const fields = { destination: "Tokyo", name: "Synthetic shared participant" };
  const submitted = await f.request("POST", { ...f.body, fields });
  expect(submitted.status).toBe(200);
  const receipt = await submitted.json();

  const readerToken = "B".repeat(43);
  f.storage.mintLinkSession({ session: {
    sessionId: "unrelated-reader", capabilityHash: hashLinkBearer(readerToken, "collection-test-key"),
    grantId: "g", generation: 1, mintedAtMs: 2, expiresAtMs: 10000,
  } });
  const headers = { authorization: `LinkCapability ${readerToken}`, "x-dohc-link-profile-secret": "Q".repeat(43) };
  const read = (path: string) => f.handler(new Request(`https://relay${path}`, { headers }));
  const page = await read(`${f.path}?authorityRevision=2`);
  expect(page.status).toBe(200);
  expect(await page.json()).toEqual({ records: [{ path: receipt.path, recordId: null, fields }], nextPath: null });

  // The collection API does not replace the link's ordinary shared-file selector.
  const current = await read("/sync/link/current");
  expect(current.status).toBe(200);
  const snapshot = await current.json();
  const responseFile = snapshot.files.find((file: { path: string }) => file.path === receipt.path);
  expect(responseFile).toBeDefined();
  const raw = await read(`/sync/link/blobs/${responseFile.blobSha256}`);
  expect(raw.status).toBe(200);
  const document = parseCollectionRecordFields(await raw.text());
  expect(document).toMatchObject({ ...fields, acceptance_id: receipt.acceptanceId });
  expect(document).not.toHaveProperty("idempotency_key");

  f.storage.revokeShareGrant({ shareId: "s", grantId: "g", revokedAtMs: 21 });
  for (const path of ["/sync/link/current", `/sync/link/blobs/${responseFile.blobSha256}`]) {
    const revoked = await read(path);
    expect(revoked.status).toBe(404);
    await revoked.body?.cancel();
  }
});

it("keeps collection HTTP off by default and rejects ambient or forged authority",async()=>{
  const off=httpFixture({appCollectionPolicy:undefined});expect((await off.request()).status).toBe(404);
  const f=httpFixture();
  for(const headers of [{cookie:"owner"},{authorization:"Bearer owner"},{"x-dohc-link-profile-secret":"bad"}] as Record<string,string>[])expect((await f.request("POST",f.body,"",{headers})).status).toBe(404);
  expect((await f.request("PUT",f.body)).status).toBe(404);
  for(const body of [{...f.body,principalId:"owner"},{...f.body,workspaceId:"w"},{...f.body,authorityRevision:1},{...f.body,fields:{destination:null}}])expect((await f.request("POST",body)).status).toBe(404);
  expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(-1);
});
it.each(["?authorityRevision=2&limit=1&limit=2","?authorityRevision=2&afterPath=a&afterPath=b","?authorityRevision=2&ownerUserId=owner","?authorityRevision=02","?authorityRevision=2&limit=101","?authorityRevision=2&afterPath=%00"])("rejects malformed collection query %s",async query=>{
  const f=httpFixture();expect((await f.request("GET",undefined,query)).status).toBe(404);
});

it.each(["responses/100%20.md","responses/100 café.md"])("round trips the projected cursor %s",async path=>{
  const f=httpFixture();f.write(path,"# Note");const receipt=f.accept();
  const first=await f.request("GET",undefined,"?authorityRevision=2&limit=1");expect(first.status).toBe(200);
  expect(await first.json()).toEqual({records:[],nextPath:path});
  const query=new URLSearchParams({authorityRevision:"2",limit:"1",afterPath:path});
  const second=await f.request("GET",undefined,`?${query}`);expect(second.status).toBe(200);
  expect((await second.json()).records[0].path).toBe(receipt.path);
});

it("skips oversized synced filenames and returns a usable continuation",async()=>{
  const f=httpFixture();f.write(`responses/000-${"a".repeat(8200)}.md`,"# Oversized name");f.write("responses/001-note.md","# Note");const receipt=f.accept();
  const first=await f.request("GET",undefined,"?authorityRevision=2&limit=1");expect(first.status).toBe(200);
  expect(await first.json()).toEqual({records:[],nextPath:"responses/001-note.md"});
  const second=await f.request("GET",undefined,"?authorityRevision=2&limit=1&afterPath=responses%2F001-note.md");expect(second.status).toBe(200);
  expect((await second.json()).records[0].path).toBe(receipt.path);
});

it("streams a full page within its declared byte budget and resumes the remainder",async()=>{
  const f=httpFixture();
  for(let index=0;index<12;index++)f.accept({idempotencyKey:`large-${index}`,fields:{destination:"Tokyo",name:"a".repeat(7000)}});
  const first=await f.request("GET",undefined,"?authorityRevision=2&limit=100");expect(first.status).toBe(200);
  const bytes=new Uint8Array(await first.arrayBuffer());expect(bytes.byteLength).toBe(Number(first.headers.get("content-length")));expect(bytes.byteLength).toBeLessThanOrEqual(APP_COLLECTION_RESPONSE_BYTES);
  const page=JSON.parse(Buffer.from(bytes).toString());expect(page.records.length).toBeGreaterThan(1);expect(page.records.length).toBeLessThan(12);expect(page.nextPath).not.toBeNull();
  const next=await f.request("GET",undefined,`?${new URLSearchParams({authorityRevision:"2",limit:"100",afterPath:page.nextPath})}`);expect(next.status).toBe(200);
  const rest=await next.json();expect(page.records.length+rest.records.length).toBe(12);expect(rest.nextPath).toBeNull();
});
it("cancels an oversized upload before accepting or enrolling",async()=>{
  const f=httpFixture();let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(16_385));},cancel(){cancelled=true;}});
  const response=await f.handler(new Request(`https://relay${f.path}`,{method:"POST",headers:{...f.headers,"content-type":"application/json"},body:stream,duplex:"half"} as RequestInit));
  expect(response.status).toBe(404);expect(cancelled).toBe(true);expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(-1);
});
function deferredBody() {
  let controller!:ReadableStreamDefaultController<Uint8Array>,reading!:()=>void;
  const ready=new Promise<void>(resolve=>{reading=resolve;}),stream=new ReadableStream<Uint8Array>({start(value){controller=value;}}),getReader=stream.getReader.bind(stream);
  stream.getReader=(()=>{const reader=getReader();reading();return reader;}) as typeof stream.getReader;
  return {stream,ready,send(body:unknown){controller.enqueue(Buffer.from(JSON.stringify(body)));controller.close();}};
}
it.each(["withdraw","approval","generation","selector","schema","expired","blocked"])("rechecks %s after a response upload yields",async kind=>{
  const f=httpFixture();if(kind==="blocked")f.accept({idempotencyKey:"first"});
  const body=deferredBody(),before=f.storage.maxOriginSeq("w","relay:collection-create:g");
  const pending=f.handler(new Request(`https://relay${f.path}`,{method:"POST",headers:{...f.headers,"content-type":"application/json"},body:body.stream,duplex:"half"} as RequestInit));
  await body.ready;
  if(kind==="withdraw")f.storage.withdrawAppPublication({...f.owner,expectedAuthorityRevision:2});
  if(kind==="approval")f.storage.approveAppCollection({...f.owner,expectedAuthorityRevision:2,capability:null});
  if(kind==="generation")f.raw.prepare("UPDATE sync_relay_share_grants SET generation=2").run();
  if(kind==="selector")f.raw.prepare("UPDATE sync_relay_shares SET selector_json=?").run(JSON.stringify({paths:["app"],versionId:null}));
  if(kind==="schema")f.write("responses/collection.yaml",schemaText+"name: changed\n");
  if(kind==="expired")f.setTime(10000);
  if(kind==="blocked")f.raw.prepare("UPDATE sync_relay_link_principals SET blocked_at_ms=21").run();
  body.send(f.body);expect((await pending).status).toBe(404);expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(before);
});
it("admits request rate and response capacity before the write and releases cancelled capacity",async()=>{
  const rate=httpFixture({linkReadRateLimiter:new TokenBucketLimiter(1,0.001,100)});const first=await rate.request();await first.body!.cancel();expect((await rate.request("POST",rate.body)).status).toBe(429);expect(rate.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(-1);
  const f=httpFixture({linkGrantEgressRateLimiter:new LinkEgressRateLimiter(APP_COLLECTION_RESPONSE_BYTES,0.001,100)});
  const held=await f.request();expect(held.status).toBe(200);expect((await f.request("POST",f.body)).status).toBe(429);
  await held.body!.cancel();const accepted=await f.request("POST",f.body);expect(accepted.status).toBe(200);await accepted.body!.cancel();
});
it("withdrawal after HTTP acceptance invalidates the retained response stream",async()=>{
  const f=httpFixture(),response=await f.request("POST",f.body);expect(response.status).toBe(200);
  f.storage.withdrawAppPublication({...f.owner,expectedAuthorityRevision:2});await expect(response.text()).rejects.toThrow();
  expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(0);
});

it("serializes concurrent HTTP retries into one accepted workspace moment",async()=>{
  const f=httpFixture();
  const replies=await Promise.all([f.request("POST",f.body),f.request("POST",f.body)]);
  expect(replies.map(reply=>reply.status)).toEqual([200,200]);
  const receipts=await Promise.all(replies.map(reply=>reply.json()));expect(receipts[0]).toEqual(receipts[1]);
  expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(0);
});

it("cancels an interrupted body without accepting and refunds its egress reservation",async()=>{
  const f=httpFixture({linkGrantEgressRateLimiter:new LinkEgressRateLimiter(APP_COLLECTION_RESPONSE_BYTES,0.001,100)}),body=deferredBody(),abort=new AbortController();
  const pending=f.handler(new Request(`https://relay${f.path}`,{method:"POST",headers:{...f.headers,"content-type":"application/json"},body:body.stream,signal:abort.signal,duplex:"half"} as RequestInit));
  await body.ready;abort.abort();await pending;
  expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(-1);
  const next=await f.request("POST",f.body);expect(next.status).toBe(200);await next.body!.cancel();
});

it("requires both credentials and exact JSON transport before accepting",async()=>{
  const f=httpFixture();
  for(const name of ["authorization","x-dohc-link-profile-secret"]){
    const headers=new Headers({...f.headers,"content-type":"application/json"});headers.delete(name);
    expect((await f.handler(new Request(`https://relay${f.path}`,{method:"POST",headers,body:JSON.stringify(f.body)}))).status).toBe(404);
  }
  expect((await f.request("POST",f.body,"",{headers:{"content-type":"text/plain"}})).status).toBe(404);
  expect((await f.request("POST",f.body,"?authorityRevision=2")).status).toBe(404);
  expect(f.storage.maxOriginSeq("w","relay:collection-create:g")).toBe(-1);
});

function ownerHttpFixture(options:Partial<CreateSyncRelayHandlerOptions>={}) {
  const f=httpFixture({resolveActor:()=>({workspaceId:"w",userId:"owner"}),...options});
  const url=`https://relay/sync/w/app-publications/${f.input.publicationId}/collection-approval`;
  const approve=(body:unknown,extra:RequestInit={})=>f.handler(new Request(url,{method:"POST",...extra,headers:{authorization:"Bearer owner","content-type":"application/json",...Object.fromEntries(new Headers(extra.headers))},body:JSON.stringify(body)}));
  return {...f,url,approve};
}

it("lets the authenticated owner narrow and revoke the published capability with revision CAS",async()=>{
  const f=ownerHttpFixture(),narrowed={...capability,allowedFields:["destination"],readFields:["destination"]};
  const list = () => f.storage.listAppPublications({workspaceId:"w",ownerUserId:"owner",limits}).publications[0];
  expect(list()?.collectionCapability).toEqual(capability);
  const approval=await f.approve({expectedAuthorityRevision:2,capability:narrowed});expect(approval.status).toBe(200);
  expect(await approval.json()).toEqual({publicationId:f.input.publicationId,authorityRevision:3,capability:narrowed});
  expect(list()).toMatchObject({authorityRevision:3,collectionCapability:narrowed});
  expect((await f.request("POST",f.body)).status).toBe(404);
  const vote=await f.request("POST",{...f.body,authorityRevision:3,fields:{destination:"Tokyo"}});expect(vote.status).toBe(200);await vote.body!.cancel();
  expect((await f.approve({expectedAuthorityRevision:2,capability:null})).status).toBe(409);
  const revoked=await f.approve({expectedAuthorityRevision:3,capability:null});expect(revoked.status).toBe(200);
  expect(await revoked.json()).toEqual({publicationId:f.input.publicationId,authorityRevision:4,capability:null});
  expect(list()).toMatchObject({authorityRevision:4,collectionCapability:null});
  expect((await f.request("GET",undefined,"?authorityRevision=4")).status).toBe(404);
});

it("refuses owner approval without explicit owner authority or the disabled feature policy",async()=>{
  const input={expectedAuthorityRevision:2,capability};
  const off=ownerHttpFixture({appCollectionPolicy:undefined});expect((await off.approve(input)).status).toBe(404);
  const revoked=await off.approve({expectedAuthorityRevision:2,capability:null});expect(revoked.status).toBe(200);
  expect(await revoked.json()).toEqual({publicationId:off.input.publicationId,authorityRevision:3,capability:null});
  const other=ownerHttpFixture({resolveActor:()=>({workspaceId:"w",userId:"other"})});expect((await other.approve(input)).status).toBe(404);
  const scope=ownerHttpFixture({resolveActor:()=>({workspaceId:"other",userId:"owner"})});expect((await scope.approve(input)).status).toBe(404);
  const f=ownerHttpFixture();
  for(const headers of [{cookie:"session=owner"},{authorization:"LinkCapability forged"},{authorization:""}] as Record<string,string>[])expect((await f.approve(input,{headers})).status).toBe(404);
  expect(f.storage.readAppPublication(f.owner).authorityRevision).toBe(2);
});
it("keeps a damaged active approval revocable",async()=>{
  const f=ownerHttpFixture({appCollectionPolicy:undefined});
  f.raw.prepare("UPDATE sync_relay_app_collection_approvals SET capability_json='broken' WHERE publication_id=?").run(f.input.publicationId);
  const list=()=>f.storage.listAppPublications({workspaceId:"w",ownerUserId:"owner",limits}).publications[0];
  expect(list()).toMatchObject({publicationId:f.input.publicationId,authorityRevision:2,collectionCapability:"unavailable",linkCurrent: true, manifestUnavailable: false});
  expect((await f.approve({expectedAuthorityRevision:2,capability:null})).status).toBe(200);
  expect(list()).toMatchObject({authorityRevision:3,collectionCapability:null});
});

it("refuses forged fields, widening and stale schema in owner approval",async()=>{
  const f=ownerHttpFixture();
  for(const body of [{expectedAuthorityRevision:2,capability,ownerUserId:"owner"},{expectedAuthorityRevision:2,capability:{...capability,readFields:["secret"]}},{expectedAuthorityRevision:0,capability},{expectedAuthorityRevision:2}])expect((await f.approve(body)).status).toBe(400);
  f.write("responses/collection.yaml",schemaText+"description: changed\n");
  expect((await f.approve({expectedAuthorityRevision:2,capability})).status).toBe(404);
  expect(f.storage.readAppPublication(f.owner).authorityRevision).toBe(2);
});

it("rechecks owner authority after an approval upload yields",async()=>{
  const f=ownerHttpFixture(),body=deferredBody();
  const pending=f.handler(new Request(f.url,{method:"POST",headers:{authorization:"Bearer owner","content-type":"application/json"},body:body.stream,duplex:"half"} as RequestInit));
  await body.ready;f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='other' WHERE workspace_id='w'").run();
  body.send({expectedAuthorityRevision:2,capability:null});expect((await pending).status).toBe(404);
  expect(f.raw.prepare("SELECT authority_revision FROM sync_relay_app_publications").get()!.authority_revision).toBe(2);
});
