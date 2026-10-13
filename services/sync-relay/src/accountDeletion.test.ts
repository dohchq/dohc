import {createHash} from "node:crypto";
import * as Y from "yjs";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {markdownToYDoc} from "../../../packages/ydoc-projection/src/import-export";
import {createLiveMarkdownRegistrationValidator,createLiveMarkdownJournalValidator} from "../../../packages/ydoc-projection/src/liveDocumentValidation";
import {policy} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import type {AppPublicationCandidate} from "@dohc/security-contract/app-publication";
import {PresenceHub,presenceScopeKey} from "./presence";
import {mkdtemp, rm, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {afterEach, expect, it} from "vitest";
import {describeDatasetRevision} from "@dohc/security-contract/dataset-artifacts";
import type {DatasetDefinition} from "@dohc/security-contract/dataset";
import {accountDeletionKey, accountDeletionFenceKey, ACCOUNT_DELETION_KEY_HEADER} from "@dohc/workspace-auth/accountDeletion";
import {initializeRelayDeployment, openRelayDeployment} from "./relayDeployment";
import {createAccountDeletionRoute} from "./accountDeletionRoute";
import {NOTICE_DISMISSED_RETENTION_MS} from "@dohc/workspace-contracts/relay";
import {noticeIdFrom} from "./storage/notices";
import {deletionScope} from "./storage/accountDeletion";
import type {StorageContext} from "./storage/context";
import {createRelayDatasetHost} from "./datasetHost";
import {deriveServiceHostBearer, authorizeServiceHostReplication} from "./serviceHostCredential";
import {parseAuthenticatedLogOps} from "./relayLogInputs";
import {claimWorkspace, createShare, putBlob, appendLog, moment, testHandler, request, jsonBody, linkSecret, linkRequest} from "./testing";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const schemaSql = "CREATE TABLE people(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL);";
const operationSource = `globalThis.operations={
  submit(ctx,input){ctx.db.execute('INSERT INTO people VALUES(?,?)',[ctx.requestId,input.name]);return {accepted:true};},
  read(ctx){return ctx.db.query('SELECT * FROM people ORDER BY id');},
  edit(ctx,input){ctx.db.execute('UPDATE people SET name=? WHERE id=?',[input.name,input.id]);return true;}
};`;
const definition: DatasetDefinition = {
  formatVersion: 1, datasetId: id(1), name: "Registrations", schemaPath: "registrations/schema.sql", operationsPath: "registrations/operations.js",
  tables: [{tableId: id(2), name: "People", sqlName: "people", primaryKey: "id", fields: [
    {fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true},
    {fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false},
    {fieldId: id(8), name: "Run", type: "button"},
  ]}], operations: [
    {operationId: id(5), name: "submit", label: "Submit", tableId: id(2), kind: "create", access: "helper", readOnly: false, fieldIds: [id(4)]},
    {operationId: id(6), name: "read", label: "Read", tableId: id(2), kind: "read", access: "helper", readOnly: true, fieldIds: [id(3), id(4)]},
    {operationId: id(7), name: "edit", label: "Edit", tableId: id(2), kind: "edit", access: "helper", readOnly: false, fieldIds: [id(4)]},
  ],
};
const revision = describeDatasetRevision({definition, revision: 1, schemaSql, operationSource});

const deleted = "deleted-person-1888", email = deleted + "@dohc.test", workspace = "owned-workspace-1888", otherWorkspace = "surviving-workspace";
const key = accountDeletionKey("account-deletion-test-secret-at-least-thirty-two-bytes");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup();});
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const allowed: Record<string, readonly string[]> = {
  sync_relay_log: ["payload_json", "admitted_author_snapshot_json"],
  sync_relay_live_update_journal: ["principal_id", "author_snapshot_json", "author_context_json"],
  sync_relay_live_update_struct_provenance: ["principal_id", "author_snapshot_json"],
  sync_relay_live_author_clients: ["principal_id", "author_snapshot_json"],
  sync_relay_share_discussion_messages: ["author_user_id", "display_name_snapshot", "body"],
};
function scan(path: string, storage: StorageContext, allowHistory: boolean, ownedIds: {shareIds:string[];grantIds:string[];publicationIds:string[]}) {
  const db = new DatabaseSync(path, {readOnly:true});
  const matches: {table: string; column: string; workspaceId: unknown}[] = [];
  try {
    for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      const table = String(name);
      const columns = db.prepare("PRAGMA table_info(" + quote(table) + ")").all();
      for (const row of db.prepare("SELECT * FROM " + quote(table)).all()) {
        for (const column of columns) {
          const value = row[String(column.name)];
          const bytes = typeof value === "string" ? Buffer.from(value) : value instanceof Uint8Array ? Buffer.from(value) : null;
          const needles = [deleted,email,workspace,...ownedIds.shareIds,...ownedIds.grantIds,...ownedIds.publicationIds].filter(needle => bytes?.includes(Buffer.from(needle)));
          if (!bytes || !needles.length) continue;
          const workspaceId = row.workspace_id ?? (row.share_id ? storage.getShare(String(row.share_id))?.workspaceId : undefined);
          matches.push({table,column:String(column.name),workspaceId});
          expect(allowHistory && ((allowed[table]?.includes(String(column.name)) && workspaceId === otherWorkspace && (table !== "sync_relay_share_discussion_messages" || row.author_user_id === deleted) && needles.every(needle=>needle===deleted||needle===email)) || (table === "sync_relay_ended_shares" && column.name === "share_id" && row.recipient_user_id === "other" && needles.every(needle=>ownedIds.shareIds.includes(needle)))),
            JSON.stringify({path,table,column:column.name,workspaceId,value:bytes.toString()})).toBe(true);
        }
      }
    }
  } finally {db.close();}
  return matches;
}
async function workerFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const path = join(directory,entry.name);
    if (entry.isDirectory()) files.push(...await workerFiles(path));
    else if (/\.(sqlite|db)$/.test(entry.name)) files.push(path);
  }
  return files;
}
function seedPublication(storage:StorageContext,shareId:string,grantId:string,generation:number) {
  const digest=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
  const recordDigest=(domain:string,value:unknown)=>digest(JSON.stringify([domain,value]));
  const bytes=Buffer.from("document.body.textContent='Work';");
  const inputs=[{path:"docs/app/index.ts",sha256:digest(bytes),byteLength:bytes.byteLength}];
  const files=[{path:"bundle.js",sha256:digest(bytes),byteLength:bytes.byteLength,contentType:"text/javascript; charset=utf-8" as const}];
  const compilerIdentity={recipe:"closed-esbuild" as const,version:"0.28.1",binarySha256:"3".repeat(64)};
  const sourceDigest=recordDigest("dohc-app-source-v2",{entry:"docs/app/index.ts",files:inputs,packages:[]});
  const dependencyLockDigest=recordDigest("dohc-app-dependencies-v1",inputs),bundleDigest=recordDigest("dohc-app-bundle-v1",files);
  const candidate:AppPublicationCandidate={versionId:"main",appRoot:"docs/app",entryPath:"docs/app/index.ts",packageMap:{},sourceRevision:"1".repeat(64),sourceDigest,dependencyLockDigest,bundleDigest,buildDigest:recordDigest("dohc-app-build-v1",{sourceDigest,dependencyLockDigest,compiler:compilerIdentity,bundleDigest}),compilerIdentity,inputs,dependencies:inputs.map(file=>file.path),files,capabilities:[]};
  return storage.publishAppPublication({workspaceId:workspace,ownerUserId:deleted,shareId,grantId,generation,candidate,blobs:[{sha256:digest(bytes),bytes}],limits:{maxFiles:10,maxMetadataBytes:16384,maxBundleBytes:4096},nowMs:2000}).publicationId;
}
function seedJournal(storage:StorageContext,shareId:string) {
  const doc=markdownToYDoc("original");
  try {
    const baseline=Y.encodeStateAsUpdate(doc),document={workspaceId:workspace,mainVersionId:"main",objectId:storage.objectIdAtPath(workspace,"docs/file.md")!,lineageClaimId:createHash("sha256").update(baseline).digest("hex")};
    const host={mode:"device" as const,hostId:"journal-host",hostEpoch:parseHostEpoch(1),instanceId:"instance",connectionId:"connection"};
    storage.provisionLiveHostControl({mode:host.mode,hostId:host.hostId,updatedAtMs:1,guard(){}});
    storage.registerLiveHost({...host,updatedAtMs:2,guard(){}});
    const registered=createLiveMarkdownRegistrationValidator(policy)({document,currentPath:"docs/file.md",checkpoint:baseline});
    if(registered.kind!=="accepted")throw Error("registration refused");
    expect(storage.registerLiveDocumentBaseline({host,evidence:registered.evidence,baselineBytes:baseline,registeredAtMs:10}).kind).toBe("registered");
    const actor={kind:"owner" as const,userId:deleted,shareId};
    const current=storage.resolveCurrentLiveDocumentBinding({document,actor});if(current.kind!=="current")throw Error(JSON.stringify(current));
    const cut=storage.readLiveUpdateJournalCut({document});if(cut.kind!=="cut")throw Error("missing cut");
    const before=Y.encodeStateVector(doc);doc.getMap("frontmatter").set("title",email);const bytes=Y.encodeStateAsUpdate(doc,before);
    const validation=createLiveMarkdownJournalValidator(policy)({document,currentPath:"docs/file.md",checkpoint:cut.cut.checkpoint.bytes,suffix:[],candidate:bytes});
    expect(storage.commitLiveUpdateJournal({host,actor,expectedAuthority:current.authority,metadata:{deliveryId:"owned-journal",updateDigest:createHash("sha256").update(bytes).digest("hex"),binding:current.binding,authorContext:{kind:"account",accountId:deleted}},cutToken:cut.cut,validation,updateBytes:bytes,receivedAtMs:30,trustedAccount:{accountId:deleted,name:email}}).result.kind).toBe("accepted");
  } finally {doc.destroy();}
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(),"dohc-account-deletion-"));
  const configPath = join(root,"deployment.json"), relayPath = join(root,"volume","relay.sqlite");
  initializeRelayDeployment({configPath,relayPath,continuityDirectory:join(root,"continuity")});
  let deployment = openRelayDeployment(configPath), storage = deployment.storage as StorageContext;
  let host = await createRelayDatasetHost({storage,directory:deployment.datasetDirectory,limits:{maxFiles:20,maxMetadataBytes:65536,maxBundleBytes:65536},startupExclusive:true,onShutdownError:error=>{throw error;}});
  cleanups.push(async()=>{await host.close();storage.close();await rm(root,{recursive:true,force:true});});
  const presence = new PresenceHub({nowMs:()=>2000});
  cleanups.push(async()=>presence.dispose());
  let h = testHandler(storage,{presence,lookupUserDisplayName:userId=>userId===deleted?"Deleted person":"Other person"});
  await claimWorkspace(h,deleted,workspace); await claimWorkspace(h,"other",otherWorkspace);
  storage.claimWorkspaceIdentity({workspaceId:workspace,replicationEpoch:"epoch",streamIdentity:"stream"});
  for (const [owner, ws] of [[deleted,workspace],["other",otherWorkspace]]) {
    await putBlob(h,owner!,ws!,"original");
    await appendLog(h,owner!,ws!,[moment("docs/file.md","original",{originSeq:0,payload:{payloadAfterContentKind:"text",payloadAfterByteLength:8}})],ws===workspace?{replicationEpoch:"epoch",streamIdentity:"stream"}:{});
  }
  const ownedShare = await createShare(h,deleted,workspace,{paths:["docs"],recipientUserId:"other",access:"edit"});
  const receivedShare = await createShare(h,"other",otherWorkspace,{paths:["docs","registrations"],recipientUserId:deleted,access:"edit"});
  await createShare(h,"other",otherWorkspace,{paths:["docs"],recipientEmail:email,access:"view"});
  storage.setShareLabels(ownedShare,{subjectName:email},2000);
  for (const [user,ws] of [[deleted,workspace],["other",otherWorkspace]]) {
    expect((await h(request(user!,"/sync/"+ws+"/presence?topic=general",jsonBody({clientId:"laptop",state:{}})))).status).toBe(200);
  }
  presence.publish(presenceScopeKey(otherWorkspace,"general"),deleted,"shared-laptop",{},2000,receivedShare);
  const presenceRead=await h(request(deleted,"/sync/"+workspace+"/presence?topic=general&since=0&hold=0"));
  expect(presenceRead.status).toBe(200);
  const proposedBytes=Buffer.from("Proposed work"),proposedHash=createHash("sha256").update(proposedBytes).digest("hex");
  expect((await h(request("other","/sync/shares/"+ownedShare+"/blobs/"+proposedHash,{method:"PUT",body:proposedBytes}))).status).toBe(200);
  const proposed=await h(request("other","/sync/shares/"+ownedShare+"/proposals",jsonBody({submitId:"owned-proposal",ops:[{basedOnPath:"docs/file.md",basedOnBlobSha256:createHash("sha256").update("original").digest("hex"),operation:"write",afterPath:"docs/file.md",afterBlobSha256:proposedHash,afterContentKind:"text",afterByteLength:proposedBytes.byteLength,recordedAtMs:2000}]})));
  expect(proposed.status,await proposed.clone().text()).toBe(200);
  storage.enrollServiceHostDocument({workspaceId:workspace,ownerUserId:deleted,shareId:ownedShare,path:"docs/file.md",nowMs:2000,guard:storage.captureStanding()});
  const serviceKey={key:Buffer.alloc(32,1),namespace:deployment.history.namespace};
  const serviceBearer=deriveServiceHostBearer(storage.currentServiceHostWorkspace(workspace)!,serviceKey);
  const serviceAccess=()=>authorizeServiceHostReplication(storage,{...serviceKey,workspaceId:workspace,bearer:serviceBearer,method:"GET",pathname:"/sync/"+workspace+"/log"});
  expect(serviceAccess()).toBe(deleted);
  const comment = await h(request(deleted,"/sync/shares/"+receivedShare+"/discussion",jsonBody({body:"Keep this contribution",idempotencyKey:"message"})));
  expect(comment.status,await comment.clone().text()).toBe(200);
  const contributions = await parseAuthenticatedLogOps([{originSeq:0,opKind:"ydoc.update",payload:{authorContext:{kind:"account",accountId:deleted}},recordedAtMs:1}],deleted,()=>email);
  storage.appendLogBatch({workspaceId:otherWorkspace,originId:"contributor",ops:contributions});
  storage.postNotice({noticeId:"sent",recipientUserId:"other",reach:{shareId:receivedShare},kind:"automation-notify",title:"A mention",body:"",target:{path:"docs/file.md"},originInstallId:"installation",senderUserId:deleted,senderLabel:email,nowMs:100});
  storage.postNotice({noticeId:"received",recipientUserId:deleted,reach:{shareId:ownedShare},kind:"automation-notify",title:"A mention",body:"",target:{path:"docs/file.md"},originInstallId:"installation",senderUserId:"other",senderLabel:"Other",nowMs:100});
  storage.postNotice({noticeId:"expired-sent",recipientUserId:"other",reach:{shareId:receivedShare},kind:"automation-notify",title:"Expired notice",body:"",target:{path:"docs/file.md"},originInstallId:"installation",senderUserId:deleted,senderLabel:email,nowMs:100});
  storage.markNotices({recipientUserId:"other",marks:[{noticeId:noticeIdFrom(deleted,"expired-sent"),mark:"dismissed"}],nowMs:200});
  storage.readNoticeChanges({recipientUserId:"other",cursor:null,limit:100,nowMs:NOTICE_DISMISSED_RETENTION_MS+201});
  expect(storage.db.prepare("SELECT notice_id FROM sync_relay_notice_dismissals WHERE notice_id=?").get(noticeIdFrom(deleted,"expired-sent"))).toBeTruthy();
  const created = await h(request(deleted,"/sync/"+workspace+"/shares/links",jsonBody({paths:["docs"],access:"view"})));
  expect(created.status).toBe(200);
  const secret = linkSecret((await created.json() as {url:string}).url);
  const exchange = await h(request(null,"/sync/link-exchange",jsonBody({secret})));
  expect(exchange.status).toBe(200);
  const capability = (await exchange.json() as {capabilityToken:string}).capabilityToken;
  const linkGrant=storage.db.prepare("SELECT g.grant_id,g.share_id,g.generation FROM sync_relay_share_grants g WHERE principal_kind='link'").get()!;
  const publicationIds=[seedPublication(storage,String(linkGrant.share_id),String(linkGrant.grant_id),Number(linkGrant.generation))];
  seedJournal(storage,ownedShare);
  const ownedIds={shareIds:storage.db.prepare("SELECT share_id FROM sync_relay_shares WHERE granter_user_id=?").all(deleted).map(row=>String(row.share_id)),grantIds:storage.db.prepare("SELECT g.grant_id FROM sync_relay_share_grants g JOIN sync_relay_shares s USING(share_id) WHERE s.granter_user_id=?").all(deleted).map(row=>String(row.grant_id)),publicationIds};
  for (const [owner, ws] of [[deleted,workspace],["other",otherWorkspace]]) {
    await host.activate({kind:"named",userId:owner!,workspaceId:ws!},{workspaceId:ws!,revision,schemaSql,operationSource,capacityBytes:1024*1024});
    await host.invoke({kind:"named",userId:owner!,workspaceId:ws!},{workspaceId:ws!,datasetId:definition.datasetId,revision:1,revisionSha256:revision.revisionSha256,operationId:id(5),input:{name:ws===workspace?email:"Survivor"},idempotencyKey:"create"});
  }
  host.ownerUpload({kind:"named",userId:deleted,workspaceId:workspace},{workspaceId:workspace,datasetId:definition.datasetId,revision:1,revisionSha256:revision.revisionSha256,idempotencyKey:"upload-proof",name:email,contentType:"text/plain",bytesBase64:Buffer.from(email).toString("base64")});
  expect(storage.db.prepare("SELECT count(*) AS n FROM sync_relay_dataset_files WHERE workspace_id=?").get(workspace)?.n).toBe(1);
  const receivedGrant = storage.db.prepare("SELECT grant_id FROM sync_relay_share_grants WHERE share_id=? AND principal_user_id=?").get(receivedShare,deleted)!;
  const dataScope = {workspaceId:otherWorkspace,datasetId:definition.datasetId};
  host.setDataGrant({kind:"named",workspaceId:otherWorkspace,userId:"other"},{...dataScope,grantId:String(receivedGrant.grant_id),grant:{operationIds:[id(5)],discover:true,revision:1,revisionSha256:revision.revisionSha256}});
  const automation = host.automations.workspace(otherWorkspace,"other",new AbortController().signal);
  automation.subscribe(definition.datasetId,{automationId:"collection:registrations#test",tableId:id(2),kinds:["added"],fieldIds:null,definitionHash:"a".repeat(64)});
  await host.invoke({kind:"named",workspaceId:otherWorkspace,userId:deleted,grantId:String(receivedGrant.grant_id)},{...dataScope,revision:1,revisionSha256:revision.revisionSha256,operationId:id(5),input:{name:"Keep data contribution"},idempotencyKey:"contribution"});
  expect(storage.db.prepare("SELECT actor FROM dohc_dataset_automation_claims WHERE json_extract(actor,'$.userId')=?").get(deleted)).toBeTruthy();
  await host.automations.press({kind:"named",workspaceId:otherWorkspace,userId:deleted,grantId:String(receivedGrant.grant_id)},definition.datasetId,new AbortController().signal,async()=>automation.press(definition.datasetId,{
    pressId:"deleted-button",request:"b".repeat(64),automationId:"collection:registrations#test",definitionHash:"a".repeat(64),tableId:id(2),fieldId:id(8),recordId:"record",pressedBy:deleted,by:{kind:"human"},
  }));
  expect(storage.db.prepare("SELECT claim_id FROM dohc_dataset_automation_presses WHERE press_id='deleted-button'").get()).toBeTruthy();
  const manager = (afterPhase?: (phase:"fenced"|"runtime"|"sql")=>void) => createAccountDeletionRoute({storage,key,fenceKey:accountDeletionFenceKey("account-deletion-test-secret-at-least-thirty-two-bytes"),
    invalidate(userId,manifest){h.deleteAccount(userId,manifest.workspaces.map(w=>w.workspaceId),manifest.shareIds);},
    deleteRuntime:async(_user,manifest)=>host.deleteWorkspaces(manifest.datasets),afterPhase});
  return {root,relayPath,ownedShare,capability,secret,serviceAccess,get storage(){return storage;},get host(){return host;},get h(){return h;},manager,
    async restart(){await host.close();storage.close();deployment=openRelayDeployment(configPath);storage=deployment.storage as StorageContext;
      host=await createRelayDatasetHost({storage,directory:deployment.datasetDirectory,limits:{maxFiles:20,maxMetadataBytes:65536,maxBundleBytes:65536},startupExclusive:true,onShutdownError:error=>{throw error;}});
      h=testHandler(storage);},
    async assertPurged(){
      expect(presence.snapshot(presenceScopeKey(workspace,"general"),2000).peers).toEqual([]);
      expect(presence.snapshot(presenceScopeKey(otherWorkspace,"general"),2000).peers.map(peer=>peer.userId)).toEqual(["other"]);
      const matches=scan(relayPath,storage,true,ownedIds); expect(matches.length).toBeGreaterThan(0);
      expect(storage.db.prepare("SELECT 1 FROM dohc_dataset_automation_presses WHERE press_id='deleted-button'").get()).toBeUndefined();
      expect(storage.workspaceIsOwnedBy(otherWorkspace,"other")).toBe(true);
      expect(storage.db.prepare("SELECT body FROM sync_relay_share_discussion_messages WHERE share_id=?").get(receivedShare)?.body).toBe("Keep this contribution");
      expect(storage.fetchLogCoordinate({workspaceId:otherWorkspace,originId:"contributor",originSeq:0})).toMatchObject({payloadJson:contributions[0]!.payloadJson});
      await host.close();
      const files=await workerFiles(deployment.datasetDirectory);expect(files.length).toBeGreaterThan(0);
      for(const file of files) scan(file,storage,false,ownedIds);
      expect(storage.listRemovedSharesForRecipient("other")).toEqual(expect.arrayContaining([expect.objectContaining({shareId:ownedShare,message:"The owner removed your access."})]));
      expect(storage.listRemovedSharesForRecipient("unrelated")).toEqual([]);
      expect(storage.listRemovedSharesForRecipient(deleted)).toEqual([]);
      const ended=await h(request("other","/sync/shares/"+ownedShare));
      expect(ended.status).toBe(404);expect(await ended.json()).toMatchObject({code:"share_access_removed"});
    },
  };
}
it("purges every store, preserves another owner's history, and ends recipient shares",async()=>{
  const f=await fixture(),deletion=f.manager();
  expect(deletionScope(f.storage,deleted,email)).toMatchObject({workspaceIds:[workspace],workspaceCount:1,ownedShareCount:2});
  expect((await deletion.handle(new Request("http://relay.test/internal/account-deletion",jsonBody({operation:"purge",userId:deleted,email})))).status).toBe(404);
  expect((await deletion.handle(new Request("http://relay.test/internal/account-deletion",{...jsonBody({operation:"purge",userId:deleted,email}),headers:{[ACCOUNT_DELETION_KEY_HEADER]:"wrong"}}))).status).toBe(404);
  await deletion.purge(deleted,email);await f.assertPurged();
  await deletion.purge(deleted,email);await f.assertPurged();
},30_000);
it.each(["fenced","runtime","sql"] as const)("resumes after interruption following %s",async phase=>{
  const f=await fixture();
  await expect(f.manager(done=>{if(done===phase)throw Error("injected crash");}).purge(deleted,email)).rejects.toThrow("injected crash");
  await f.restart();await f.manager().purge(deleted,email);await f.assertPurged();
},30_000);
it("refuses account, link, and service access while runtime purge is pending",async()=>{
  const f=await fixture();const deletion=f.manager();deletion.fence(deleted,email);
  expect(f.storage.workspaceIsOwnedBy(workspace,deleted)).toBe(false);
  expect(f.storage.currentServiceHostWorkspace(workspace)).toBeNull();
  expect(f.serviceAccess()).toBeNull();
  expect((await f.h(request(deleted,"/sync/"+workspace+"/log"))).status).toBe(404);
  expect((await f.h(linkRequest(f.capability,"/sync/link/current"))).status).toBe(404);
  expect((await f.h(request(null,"/sync/link-exchange",jsonBody({secret:f.secret})))).status).toBe(404);
  await expect(f.host.invoke({kind:"named",userId:deleted,workspaceId:workspace},{workspaceId:workspace,datasetId:definition.datasetId,revision:1,revisionSha256:revision.revisionSha256,operationId:id(6),input:{},idempotencyKey:"after-fence"})).rejects.toThrow();
  await deletion.purge(deleted,email);
},30_000);
