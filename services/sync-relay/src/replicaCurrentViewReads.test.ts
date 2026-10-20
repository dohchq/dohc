import {afterEach, expect, it} from "vitest";
import {writeFileSync} from "node:fs";
import type {ReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import {AGENT_CHANNEL_WIRE_ID} from "@dohc/security-contract/chat-wire-ids";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {createReplicaSupervisor} from "./replicaSupervisor";
import {closeTestStorage, closeTestStorages, inspectDatabase, seedDependentGrant, seedLinkGrant, sha256, storagePath, tempRoot, testStorage} from "./testing";
import {registered, cleanupLiveDeliveryFixtures} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import type {StorageContext} from "./storage/context";
import {replicaCurrentViewReadCacheSize, withReplicaCurrentView} from "./replicaCurrentViewReads";
import {replicaCurrentViewStoredCacheSize} from "./storage/replicaCurrentViews";
import {fenceAccount, initializeAccountDeletion} from "./storage/accountDeletion";
import {accountDeletionKey} from "@dohc/workspace-auth/accountDeletion";

afterEach(async () => {cleanupLiveDeliveryFixtures(); await closeTestStorages();});

async function fixture() {
  const storage = await testStorage();
  storage.claimWorkspace({workspaceId:"w", ownerUserId:"owner", createdAtMs:1});
  storage.claimWorkspaceIdentity({workspaceId:"w", replicationEpoch:"epoch", streamIdentity:"stream"});
  const grant = (grantId: string, shareId: string) => ({grantId, shareId, principalKind:"user" as const,
    principalUserId:"reader", principalEmail:null, access:"edit", generation:1, status:"active" as const,
    createdAtMs:1, revokedAtMs:null, parentGrantId:null});
  for (const [shareId, paths, versionId] of [["s", ["docs"], null], ["wide", [], "main"], ["branch", [], "branch"]] as const) {
    storage.createShare({share:{shareId, workspaceId:"w", granterUserId:"owner", selectorJson:JSON.stringify({paths, versionId}), createdAtMs:1}, grant:grant(shareId, shareId)});
  }
  const lease = createReplicaReadPrincipal(storage).issue("w", "incarnation");
  storage.bindReplicaCurrentView(lease);
  const input = {grantId:"s", generation:1, principal:{kind:"user" as const, userId:"reader"}};
  const file = (path: string, text = path, versionId = "main") => ({versionId, objectId:path, path,
    contentKind:"text" as const, sha256:sha256(text), byteLength:Buffer.byteLength(text), lineageClaimId:null, restoreGeneration:null});
  const view = (entries = [{path:"docs/a.md", text:"current"}, {path:"private.md", text:"secret"}]) : ReplicaCurrentView => ({
    workspaceId:"w", revision:1, logCursor:0, journalCursor:0, omitted:[],
    files:entries.map(e => file(e.path, e.text)), texts:entries.map(e => ({sha256:sha256(e.text), text:e.text})),
  });
  const save = (v = view()) => storage.storeReplicaCurrentView(lease, v);
  const list = () => storage.listReplicaCurrentViewFiles(input);
  const read = (path = "docs/a.md") => storage.readReplicaCurrentViewFile({...input, path});
  return {storage, lease, input, file, view, save, list, read, db:inspectDatabase(storagePath(storage))};
}

it.skipIf(!process.env.DOHC_SESSION_CHECK_PERF_OUTPUT)("measures the replica session comparison",async()=>{
  const f=await fixture();seedLinkGrant(f.storage,{grantId:"link",shareId:"s",secretHash:"hash"});f.save();
  const input={grantId:"link",generation:1,principal:{kind:"link" as const,requireSession:()=>({grantId:"link",generation:1})}};
  const read=()=>f.storage.readReplicaCurrentViewFile({...input,path:"docs/a.md"});
  expect(read()).toMatchObject({status:"ready",text:"current"});
  for(let i=0;i<500;i++)read();
  const samplesUs=[];
  for(let batch=0;batch<9;batch++) {
    const start=performance.now();
    for(let i=0;i<1000;i++)read();
    samplesUs.push((performance.now()-start)*1000/1000);
  }
  writeFileSync(process.env.DOHC_SESSION_CHECK_PERF_OUTPUT!,JSON.stringify({samplesUs,medianUs:[...samplesUs].sort((a,b)=>a-b)[4]},null,2)+"\n");
});

it("filters every row of the selector union, including another version", async () => {
  const f = await fixture();
  const v = f.view();
  v.files.push(f.file("docs/branch.md", "branch secret", "branch"));
  v.texts.push({sha256:sha256("branch secret"), text:"branch secret"}); f.save(v);
  expect(f.list()).toMatchObject({status:"ready", files:[{path:"docs/a.md", kind:"text", byteLength:7}]});
  expect(f.read("private.md")).toEqual({status:"not-found"});
  expect(f.read("docs/branch.md")).toEqual({status:"not-found"});
  expect(f.read()).toMatchObject({status:"ready", text:"current"});
});

it("a moved-out file disappears, and returning exposes only its current text", async () => {
  const f = await fixture(); f.save(); expect(f.read()).toMatchObject({text:"current"});
  const moved = f.view([{path:"private.md", text:"while private"}]); moved.files[0]!.objectId = "docs/a.md"; f.save(moved);
  expect(f.read()).toEqual({status:"not-found"});
  f.save(f.view([{path:"docs/a.md", text:"returned"}]));
  expect(f.read()).toMatchObject({text:"returned"});
  expect(f.storage.readReplicaCurrentViewText("w", sha256("while private"))).toBeNull();
});

it.each(["revoke", "generation", "principal", "owner"])("rechecks %s before list and open", async change => {
  const f = await fixture(); f.save(); expect(f.read()).toMatchObject({text:"current"});
  if (change === "revoke") f.storage.revokeShareGrant({shareId:"s", grantId:"s", revokedAtMs:2});
  if (change === "generation") f.db.prepare("UPDATE sync_relay_share_grants SET generation=2 WHERE grant_id='s'").run();
  if (change === "principal") f.input.principal.userId = "stranger";
  if (change === "owner") f.db.prepare("UPDATE sync_relay_workspaces SET owner_user_id='other'").run();
  expect(f.list()).toEqual({status:"denied"}); expect(f.read()).toEqual({status:"denied"});
});

it("access narrowing keeps the bound generation readable", async () => {
  const f = await fixture(); f.save(); expect(f.read()).toMatchObject({text:"current"});
  f.storage.retuneShareGrant({shareId:"s", grantId:"s", access:"view", changedAtMs:2, expectedDependentGrantIds:[], guard() {}});
  expect(f.storage.getShareGrant("s")?.generation).toBe(1);
  expect(f.list()).toMatchObject({status:"ready"}); expect(f.read()).toMatchObject({text:"current"});
});

it("dependent readers remain within their parent's selector and access", async () => {
  const f = await fixture();
  seedLinkGrant(f.storage, {grantId:"link", shareId:"s", secretHash:"hash", access:"edit"});
  seedDependentGrant(f.storage, {shareId:"s", parentGrantId:"link", grantId:"child", principalUserId:"child", createdAtMs:3});
  f.save(); const input = {grantId:"child", generation:1, principal:{kind:"user" as const, userId:"child"}};
  expect(f.storage.readReplicaCurrentViewFile({...input, path:"docs/a.md"})).toMatchObject({text:"current"});
  expect(f.storage.readReplicaCurrentViewFile({...input, path:"private.md"})).toEqual({status:"not-found"});
  f.db.prepare("UPDATE sync_relay_share_grants SET access='view' WHERE grant_id='link'").run();
  expect(f.storage.listReplicaCurrentViewFiles(input)).toEqual({status:"denied"});
});

it.each(["channel", "dm", "agent", null])("a Group channel (%s) serves files only for an ordinary channel", async kind => {
  const f = await fixture();
  const wireId = kind === "agent" ? AGENT_CHANNEL_WIRE_ID : "channel";
  if (kind) f.storage.appendLogBatch({workspaceId:"w",originId:"owner",ops:[{originSeq:0,opKind:"chat.channel.create",recordedAtMs:1,
    payloadJson:JSON.stringify({wireId,channelId:"channel",kind,name:"blocked",slug:"blocked",createdAtMs:1})}]});
  if (kind) expect(f.storage.findChannelCreateKind("w",wireId)).toBe(kind);
  f.db.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id='s'").run(JSON.stringify({kind:"group",channelWireId:wireId,paths:["docs"],versionId:null}));
  f.db.prepare("UPDATE sync_relay_share_grants SET access='read-only' WHERE grant_id='s'").run();
  f.save(); // The separate workspace share still collects these files.
  if(kind === "channel") {
    expect(f.list()).toMatchObject({status:"ready",files:[{path:"docs/a.md"}]});
    expect(f.read()).toMatchObject({status:"ready",text:"current"});
    return;
  }
  expect(f.list()).toEqual({status:"denied"}); expect(f.read()).toEqual({status:"denied"});
});

it("requires the link session check in every replica storage reader",async()=>{
  const f=await fixture();seedLinkGrant(f.storage,{grantId:"link",shareId:"s",secretHash:"hash",access:"edit"});f.save();
  const input={grantId:"link",generation:1,principal:{kind:"link" as const,requireSession:()=>{throw new Error("session refused");}}};
  for(const read of [
    ()=>withReplicaCurrentView(f.storage as unknown as StorageContext,input,undefined,()=>"leaked"),
    ()=>f.storage.listReplicaCurrentViewFiles(input),
    ()=>f.storage.readReplicaCurrentViewFile({...input,path:"docs/a.md"}),
    ()=>f.storage.listReplicaHistoryPins(input),
    ()=>f.storage.readReplicaHistoryPin({...input,pinId:"pin"}),
  ]) expect.soft(read).toThrow("session refused");
  const unchecked={grantId:"link",generation:1,principal:{kind:"link" as const}};
  if(false) {
    // @ts-expect-error Link principals must supply a session check.
    withReplicaCurrentView(f.storage as unknown as StorageContext,unchecked,undefined,()=>"leaked");
    // @ts-expect-error Link principals must supply a session check.
    f.storage.listReplicaCurrentViewFiles(unchecked);
    // @ts-expect-error Link principals must supply a session check.
    f.storage.readReplicaCurrentViewFile({...unchecked,path:"docs/a.md"});
    // @ts-expect-error Link principals must supply a session check.
    f.storage.listReplicaHistoryPins(unchecked);
    // @ts-expect-error Link principals must supply a session check.
    f.storage.readReplicaHistoryPin({...unchecked,pinId:"pin"});
  }
});

it.each([{grantId:"another",generation:1},{grantId:"link",generation:2}])("refuses a session that does not match the replica input: %j",async session=>{
  const f=await fixture();seedLinkGrant(f.storage,{grantId:"link",shareId:"s",secretHash:"hash",access:"edit"});f.save();
  const input={grantId:"link",generation:1,principal:{kind:"link" as const,requireSession:()=>session}};
  for(const read of [
    ()=>withReplicaCurrentView(f.storage as unknown as StorageContext,input,undefined,()=>"leaked"),
    ()=>f.storage.listReplicaCurrentViewFiles(input),
    ()=>f.storage.readReplicaCurrentViewFile({...input,path:"docs/a.md"}),
    ()=>f.storage.listReplicaHistoryPins(input),
    ()=>f.storage.readReplicaHistoryPin({...input,pinId:"pin"}),
  ]) expect.soft(read()).toEqual({status:"denied"});
  if(false) {
    // @ts-expect-error A session check must return a validated session, never null.
    f.storage.listReplicaCurrentViewFiles({...input,principal:{kind:"link",requireSession:()=>null}});
  }
});

it("accountless paths use the existing relative projection in both directions", async () => {
  const f = await fixture(); seedLinkGrant(f.storage, {grantId:"link", shareId:"s", secretHash:"hash"}); f.save();
  const input = {grantId:"link", generation:1, principal:{kind:"link" as const,requireSession(){return {grantId:"link",generation:1};}}};
  expect(f.storage.listReplicaCurrentViewFiles(input)).toMatchObject({files:[{path:"docs/a.md"}]});
  // A deeper root loses its private parents.
  f.db.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id='s'").run('{"paths":["private/docs"],"versionId":null}');
  f.save(f.view([{path:"private/docs/a.md", text:"relative"}]));
  expect(f.storage.listReplicaCurrentViewFiles(input)).toMatchObject({files:[{path:"docs/a.md"}]});
  expect(f.storage.readReplicaCurrentViewFile({...input, path:"docs/a.md"})).toMatchObject({text:"relative", file:{path:"docs/a.md"}});
  expect(f.storage.readReplicaCurrentViewFile({...input, path:"private/docs/a.md"})).toEqual({status:"not-found"});
  expect(f.storage.readReplicaCurrentViewFile({...input, path:"docs/../a.md"})).toEqual({status:"not-found"});
});

it("never treats a stored or superseded sha as a readable path", async () => {
  const f = await fixture(); f.save();
  expect(f.storage.readReplicaCurrentViewText("w",sha256("secret"))).toBe("secret");
  expect(f.storage.readReplicaCurrentViewFile({...f.input,grantId:"wide",path:"private.md"})).toMatchObject({text:"secret"});
  expect(f.read(sha256("secret"))).toEqual({status:"not-found"});
  expect(f.read("private.md")).toEqual({status:"not-found"});
  const forged = {...f.input, path:"docs/a.md", sha256:sha256("secret")};
  expect(f.storage.readReplicaCurrentViewFile(forged)).toMatchObject({text:"current"});
  f.save(f.view([{path:"docs/a.md", text:"new"}]));
  expect(f.storage.readReplicaCurrentViewText("w",sha256("current"))).toBeNull();
  expect(f.read(sha256("current"))).toEqual({status:"not-found"});
  expect(f.read()).toMatchObject({text:"new"});
});

it.each(["sha", "duplicate-path", "duplicate-object", "cursor", "missing-text", "wrong-text", "path", "byte-length"])("an unpersisted %s view cannot return text", async corruption => {
  const f = await fixture(); f.save(); f.read();
  const view = f.view();
  if (corruption === "sha") view.files[0]!.sha256 = "invalid";
  if (corruption === "duplicate-path") view.files.push({...view.files[0]!,objectId:"duplicate"});
  if (corruption === "duplicate-object") view.files.push({...view.files[0]!,path:"docs/duplicate.md"});
  if (corruption === "cursor") view.logCursor = 999;
  if (corruption === "path") view.files[0]!.path="docs/.git/config";
  if (corruption === "byte-length") view.files[0]!.byteLength++;
  if (corruption === "missing-text") {view.texts=[]; view.files[0]!.sha256=sha256("missing");}
  if (corruption === "wrong-text") view.texts[0]!.text="wrong text";
  const source = {currentReadView:() => ({view})};
  expect(f.storage.readReplicaCurrentViewFile({...f.input,path:"docs/a.md"},source)).toEqual({status:"updating"});
});

it("rejects a previous snapshot from another workspace", async () => {
  const f = await fixture();
  const view = f.view(), previous = {...f.view(), workspaceId:"other"};
  expect(f.storage.readReplicaCurrentViewFile({...f.input,path:"docs/a.md"},{currentReadView:()=>({view,previous})})).toEqual({status:"updating"});
});

it("file and inventory ETags change with content and visible path", async () => {
  const f = await fixture(); f.save();
  const first = f.list();
  f.save(f.view([{path:"docs/a.md",text:"changed"}])); expect(f.list()).not.toEqual(first);
  const second = f.list(); f.save(f.view([{path:"docs/renamed.md",text:"changed"}])); expect(f.list()).not.toEqual(second);
});

it("round1: the inventory ETag includes file kind when the bytes and path stay the same", async () => {
  const f = await fixture(); f.save(); const before = f.list();
  const view = f.view(); view.files[0]!.contentKind = "binary"; f.save(view);
  const after = f.list();
  expect(after).toMatchObject({status:"ready",files:[{kind:"binary"}]});
  expect(after.status === "ready" && after.etag).not.toEqual(before.status === "ready" && before.etag);
});

it("round1: inventory metadata reuse does not cache a selector or retain mutable response arrays", async () => {
  const f = await fixture(), view = f.view(); f.save(view);
  const source = {currentReadView:()=>({view})};
  const list = () => f.storage.listReplicaCurrentViewFiles(f.input,source);
  const read = (path: string) => f.storage.readReplicaCurrentViewFile({...f.input,path},source);
  const first = list();
  expect(first).toMatchObject({files:[{path:"docs/a.md"}]});
  if (first.status !== "ready") throw Error("missing view");
  const tag = first.etag; first.files.length=0;
  expect(list()).toMatchObject({files:[{path:"docs/a.md"}],etag:tag});
  f.db.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id='s'").run('{"paths":["private.md"],"versionId":null}');
  const narrowed = list(); expect(narrowed).toMatchObject({files:[{path:"private.md"}]});
  expect(narrowed.status === "ready" && narrowed.etag).not.toEqual(tag);
  expect(read("docs/a.md")).toEqual({status:"not-found"});
  expect(read("private.md")).toMatchObject({text:"secret"});
});

it("distinguishes a missing view from an empty ready view", async () => {
  const f = await fixture(); expect(f.list()).toEqual({status:"not-ready"}); expect(f.read()).toEqual({status:"not-ready"});
  f.db.exec("UPDATE sync_relay_workspaces SET replication_epoch=NULL,stream_identity=NULL");
  expect(f.list()).toEqual({status:"not-ready"}); expect(f.read()).toEqual({status:"not-ready"});
  f.storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"epoch",streamIdentity:"stream"});
  f.save({...f.view(), files:[], texts:[]}); expect(f.list()).toMatchObject({status:"ready", files:[]});
  expect(f.read()).toEqual({status:"not-found"});
});

it("a pending restore without a saved row reads as updating", () => {
  const f = registered({deployment:true});
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace", replicationEpoch:"e", streamIdentity:"s"});
    const lease = createReplicaReadPrincipal(f.storage).issue("workspace", "restore"); f.storage.bindReplicaCurrentView(lease);
    f.write(db => db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2,admission_state='closed'"));
    f.storage.storeReplicaCurrentView(lease, {workspaceId:"workspace", revision:1,logCursor:0,journalCursor:0,omitted:[],texts:[{sha256:sha256("old"),text:"old"}],
      files:[{versionId:"main",objectId:"object",path:f.input.evidence.currentPath,contentKind:"text",sha256:sha256("old"),byteLength:3,lineageClaimId:f.input.evidence.document.lineageClaimId,restoreGeneration:1}]});
    const input = {grantId:"grant", generation:4, principal:{kind:"user" as const,userId:"reader"}};
    expect(f.storage.readReplicaCurrentViewFile({...input,path:f.input.evidence.currentPath})).toEqual({status:"updating"});
    expect(f.storage.listReplicaCurrentViewFiles(input)).toMatchObject({status:"ready",files:[{path:f.input.evidence.currentPath,status:"updating"}]});
    const ready = {workspaceId:"workspace",revision:2,logCursor:0,journalCursor:0,omitted:[],texts:[{sha256:sha256("old"),text:"old"}],
      files:[{versionId:"main",objectId:"object",path:f.input.evidence.currentPath,contentKind:"text" as const,sha256:sha256("old"),byteLength:3,lineageClaimId:f.input.evidence.document.lineageClaimId,restoreGeneration:2}]};
    f.storage.storeReplicaCurrentView(lease,ready);
    const before = f.storage.readReplicaCurrentViewFile({...input,path:f.input.evidence.currentPath});
    expect(before).toMatchObject({status:"ready",text:"old"});
    expect(f.storage.listReplicaCurrentViewFiles(input)).toMatchObject({files:[{status:"ready"}]});
    f.write(db => db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=3"));
    expect(f.storage.listReplicaCurrentViewFiles(input)).toMatchObject({files:[{status:"updating"}]});
    expect(f.storage.readReplicaCurrentViewFile({...input,path:f.input.evidence.currentPath})).toEqual({status:"updating"});
    ready.files[0]!.restoreGeneration=3; f.storage.storeReplicaCurrentView(lease,ready);
    const after = f.storage.readReplicaCurrentViewFile({...input,path:f.input.evidence.currentPath});
    expect(after).toMatchObject({status:"ready",text:"old"}); expect(after).not.toEqual(before);
  } finally {f.close();}
});

it("a fenced restore without a view row stays updating until admission resumes", () => {
  const f = registered({deployment:true});
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"e",streamIdentity:"s"});
    const lease = createReplicaReadPrincipal(f.storage).issue("workspace", "restore-missing"); f.storage.bindReplicaCurrentView(lease);
    f.write(db => db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2,admission_state='closed'"));
    f.storage.appendLogBatch({workspaceId:"workspace",originId:"owner",ops:[{originSeq:0,opKind:"workspace.restore",payloadJson:"{}",recordedAtMs:1}]});
    const input = {grantId:"grant", generation:4, principal:{kind:"user" as const,userId:"reader"}};
    f.write(db => {
      db.prepare(`INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms)
        VALUES ('other-share','workspace','owner',?,0)`).run('{"paths":["other"],"versionId":null}');
      db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
        VALUES ('other-grant','other-share','user','reader',NULL,'edit',4,'active',0,NULL,NULL)`).run();
    });
    const otherInput = {grantId:"other-grant",generation:4,principal:{kind:"user" as const,userId:"reader"}};
    f.storage.storeReplicaCurrentView(lease,{workspaceId:"workspace",revision:1,logCursor:1,journalCursor:0,omitted:[],texts:[],files:[]});
    expect(f.storage.listReplicaCurrentViewFiles(otherInput)).toMatchObject({status:"ready",files:[]});
    expect(f.storage.readReplicaCurrentViewFile({...otherInput,path:f.input.evidence.currentPath})).toEqual({status:"not-found"});
    expect(f.storage.listReplicaCurrentViewFiles(input)).toMatchObject({files:[{path:f.input.evidence.currentPath,status:"updating"}]});
    expect(f.storage.readReplicaCurrentViewFile({...input,path:f.input.evidence.currentPath})).toEqual({status:"updating"});
    f.write(db => db.exec("UPDATE sync_relay_live_documents SET admission_state='open'"));
    expect(f.storage.listReplicaCurrentViewFiles(input)).toMatchObject({status:"ready",files:[]});
    expect(f.storage.readReplicaCurrentViewFile({...input,path:f.input.evidence.currentPath})).toEqual({status:"not-found"});
  } finally {f.close();}
});

it("a live generation-one row stays updating against a closed generation-two fence", () => {
  const f = registered({deployment:true});
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"e",streamIdentity:"s"});
    const lease = createReplicaReadPrincipal(f.storage).issue("workspace", "restore-live-pending"); f.storage.bindReplicaCurrentView(lease);
    f.write(db => db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2,admission_state='closed'"));
    f.storage.appendLogBatch({workspaceId:"workspace",originId:"owner",ops:[{originSeq:0,opKind:"workspace.restore",payloadJson:"{}",recordedAtMs:1}]});
    const input = {grantId:"grant", generation:4, principal:{kind:"user" as const,userId:"reader"}};
    const view = {workspaceId:"workspace",revision:1,logCursor:1,journalCursor:0,omitted:[],texts:[{sha256:sha256("old"),text:"old"}],
      files:[{versionId:"main",objectId:"object",path:f.input.evidence.currentPath,contentKind:"text" as const,sha256:sha256("old"),byteLength:3,lineageClaimId:f.input.evidence.document.lineageClaimId,restoreGeneration:1}]};
    expect(f.storage.readReplicaCurrentViewFile({...input,path:f.input.evidence.currentPath},{currentReadView:()=>({view})})).toEqual({status:"updating"});
  } finally {f.close();}
});

it("a source generation-one row stays updating against a closed generation-two fence without a previous row", () => {
  const f = registered({deployment:true});
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"e",streamIdentity:"s"});
    const lease = createReplicaReadPrincipal(f.storage).issue("workspace", "restore-source-pending"); f.storage.bindReplicaCurrentView(lease);
    f.write(db => db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2,admission_state='closed'"));
    f.storage.appendLogBatch({workspaceId:"workspace",originId:"owner",ops:[{originSeq:0,opKind:"workspace.restore",payloadJson:"{}",recordedAtMs:1}]});
    const input = {grantId:"grant", generation:4, principal:{kind:"user" as const,userId:"reader"}};
    const view = {workspaceId:"workspace",revision:1,logCursor:1,journalCursor:0,omitted:[],texts:[{sha256:sha256("old"),text:"old"}],
      files:[{versionId:"main",objectId:"object",path:f.input.evidence.currentPath,contentKind:"text" as const,sha256:sha256("old"),byteLength:3,lineageClaimId:f.input.evidence.document.lineageClaimId,restoreGeneration:1}]};
    const source = {currentReadView:()=>({view,previous:undefined})};
    expect(f.storage.listReplicaCurrentViewFiles(input,source)).toMatchObject({files:[{path:f.input.evidence.currentPath,status:"updating"}]});
    expect(f.storage.readReplicaCurrentViewFile({...input,path:f.input.evidence.currentPath},source)).toEqual({status:"updating"});
  } finally {f.close();}
});

it("a revoked grant forgets caches without a running replica", async () => {
  const storage = await testStorage(), context = storage as StorageContext;
  try {
    storage.claimWorkspace({workspaceId:"cache-revoke",ownerUserId:"owner",createdAtMs:1});
    storage.claimWorkspaceIdentity({workspaceId:"cache-revoke",replicationEpoch:"epoch",streamIdentity:"stream"});
    storage.createShare({share:{shareId:"cache-revoke-share",workspaceId:"cache-revoke",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:1},
      grant:{grantId:"cache-revoke-grant",shareId:"cache-revoke-share",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"edit",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
    const lease = createReplicaReadPrincipal(storage).issue("cache-revoke","cache-revoke"); storage.bindReplicaCurrentView(lease);
    const text = "cached", file = {versionId:"main",objectId:"object",path:"docs/a.md",contentKind:"text" as const,sha256:sha256(text),byteLength:text.length,lineageClaimId:null,restoreGeneration:null};
    storage.storeReplicaCurrentView(lease,{workspaceId:"cache-revoke",revision:1,logCursor:0,journalCursor:0,files:[file],omitted:[],texts:[{sha256:file.sha256,text}]});
    expect(storage.readReplicaCurrentViewFile({grantId:"cache-revoke-grant",generation:1,principal:{kind:"user",userId:"reader"},path:file.path})).toMatchObject({status:"ready"});
    expect(replicaCurrentViewReadCacheSize(context)).toBe(1); expect(replicaCurrentViewStoredCacheSize(context)).toBe(1);
    expect(storage.revokeShareGrant({shareId:"cache-revoke-share",grantId:"cache-revoke-grant",revokedAtMs:2}).ok).toBe(true);
    expect(replicaCurrentViewReadCacheSize(context)).toBe(0); expect(replicaCurrentViewStoredCacheSize(context)).toBe(0);
  } finally {closeTestStorage(storage);}
});

it("deleting the owner's account forgets their cached views", async () => {
  const storage = await testStorage(), context = storage as StorageContext;
  try {
    storage.claimWorkspace({workspaceId:"cache-delete",ownerUserId:"owner",createdAtMs:1});
    storage.claimWorkspaceIdentity({workspaceId:"cache-delete",replicationEpoch:"epoch",streamIdentity:"stream"});
    storage.createShare({share:{shareId:"cache-delete-share",workspaceId:"cache-delete",granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:1},
      grant:{grantId:"cache-delete-grant",shareId:"cache-delete-share",principalKind:"user",principalUserId:"reader",principalEmail:null,access:"edit",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
    const lease = createReplicaReadPrincipal(storage).issue("cache-delete","cache-delete"); storage.bindReplicaCurrentView(lease);
    const text = "cached", file = {versionId:"main",objectId:"object",path:"docs/a.md",contentKind:"text" as const,sha256:sha256(text),byteLength:text.length,lineageClaimId:null,restoreGeneration:null};
    storage.storeReplicaCurrentView(lease,{workspaceId:"cache-delete",revision:1,logCursor:0,journalCursor:0,files:[file],omitted:[],texts:[{sha256:file.sha256,text}]});
    const read = {grantId:"cache-delete-grant",generation:1,principal:{kind:"user" as const,userId:"reader"},path:file.path};
    expect(storage.readReplicaCurrentViewFile(read)).toMatchObject({status:"ready"});
    expect(replicaCurrentViewReadCacheSize(context)).toBe(1); expect(replicaCurrentViewStoredCacheSize(context)).toBe(1);
    const key = accountDeletionKey("replica-read-cache-test-secret-at-least-thirty-two");
    initializeAccountDeletion(context,key); fenceAccount(context,key,"owner","owner@dohc.test");
    expect(replicaCurrentViewReadCacheSize(context)).toBe(0); expect(replicaCurrentViewStoredCacheSize(context)).toBe(0);
    expect(storage.readReplicaCurrentViewFile(read)).toMatchObject({status:"denied"});
  } finally {closeTestStorage(storage);}
});

it("a landed restore does not leave a deleted path updating", () => {
  const f = registered({deployment:true});
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"e",streamIdentity:"s"});
    const lease = createReplicaReadPrincipal(f.storage).issue("workspace", "restore-landed"); f.storage.bindReplicaCurrentView(lease);
    f.write(db => db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2"));
    f.storage.appendLogBatch({workspaceId:"workspace",originId:"owner",ops:[{originSeq:0,opKind:"workspace.restore",payloadJson:"{}",recordedAtMs:1}]});
    const input = {grantId:"grant", generation:4, principal:{kind:"user" as const,userId:"reader"}};
    const ready = {workspaceId:"workspace",revision:1,logCursor:1,journalCursor:0,omitted:[],texts:[{sha256:sha256("restored"),text:"restored"}],
      files:[{versionId:"main",objectId:"object",path:f.input.evidence.currentPath,contentKind:"text" as const,sha256:sha256("restored"),byteLength:8,lineageClaimId:f.input.evidence.document.lineageClaimId,restoreGeneration:2}]};
    f.storage.storeReplicaCurrentView(lease,ready);
    expect(f.storage.readReplicaCurrentViewFile({...input,path:f.input.evidence.currentPath})).toMatchObject({status:"ready",text:"restored"});
    f.storage.storeReplicaCurrentView(lease,{...ready,revision:2,files:[],texts:[]});
    expect(f.storage.listReplicaCurrentViewFiles(input)).toMatchObject({status:"ready",files:[]});
    expect(f.storage.readReplicaCurrentViewFile({...input,path:f.input.evidence.currentPath})).toEqual({status:"not-found"});
  } finally {f.close();}
});

it("a landed restore that renamed its file does not leave the old path updating", () => {
  const f = registered({deployment:true});
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"e",streamIdentity:"s"});
    const lease = createReplicaReadPrincipal(f.storage).issue("workspace", "restore-rename"); f.storage.bindReplicaCurrentView(lease);
    f.write(db => db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2"));
    f.storage.appendLogBatch({workspaceId:"workspace",originId:"owner",ops:[{originSeq:0,opKind:"workspace.restore",payloadJson:"{}",recordedAtMs:1}]});
    const input = {grantId:"grant", generation:4, principal:{kind:"user" as const,userId:"reader"}};
    const path = f.input.evidence.currentPath, renamed = "docs/renamed.md";
    const ready = {workspaceId:"workspace",revision:1,logCursor:1,journalCursor:0,omitted:[],texts:[{sha256:sha256("restored"),text:"restored"}],
      files:[{versionId:"main",objectId:"object",path,contentKind:"text" as const,sha256:sha256("restored"),byteLength:8,lineageClaimId:f.input.evidence.document.lineageClaimId,restoreGeneration:2}]};
    f.storage.storeReplicaCurrentView(lease,ready);
    f.storage.storeReplicaCurrentView(lease,{...ready,revision:2,files:[{...ready.files[0]!,path:renamed}],texts:ready.texts});
    expect(f.storage.readReplicaCurrentViewFile({...input,path})).toEqual({status:"not-found"});
    expect(f.storage.readReplicaCurrentViewFile({...input,path:renamed})).toMatchObject({status:"ready",text:"restored"});
  } finally {f.close();}
});

it("live and persisted reads agree, and the newer live text wins", async () => {
  const f = await fixture(); let latest = f.view();
  const supervisor = createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("read-view"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w");
    const read = () => f.storage.readReplicaCurrentViewFile({...f.input,path:"docs/a.md"},supervisor);
    expect(read()).toEqual(f.read());
    latest = {...f.view([{path:"docs/a.md",text:"newer"},{path:"private.md",text:"secret"}]),revision:2};
    await supervisor.activate("w"); expect(f.read()).toMatchObject({text:"current"}); expect(read()).toMatchObject({text:"newer"});
    await supervisor.evict("w"); expect(read()).toEqual(f.read()); expect(read()).toMatchObject({text:"newer"});
  } finally {await supervisor.close();}
});

it("an external revoke cannot mix grant, manifest and text snapshots", async () => {
  const f = await fixture(); f.save();
  const source = {currentReadView:() => {
    f.db.exec("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=2,generation=2 WHERE grant_id='s'");
    const view = f.storage.readReplicaCurrentView("w")!;
    return {view,readText:(sha: string) => f.storage.readReplicaCurrentViewText("w",sha)};
  }};
  expect(f.storage.readReplicaCurrentViewFile({...f.input,path:"docs/a.md"},source)).toMatchObject({text:"current"});
  expect(f.read()).toEqual({status:"denied"});
});

it("a stored view ahead of memory wins", async () => {
  const f = await fixture(); let activeLease = f.lease;
  const supervisor = createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("stored-newer"),
    startChild:async input=>{activeLease=input.lease;return {pull:async()=>{},close:async()=>{},currentView:async()=>({...f.view(),delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})};}});
  try {
    await supervisor.activate("w");
    expect(f.storage.readReplicaCurrentViewFile({...f.input,path:"docs/a.md"},supervisor)).toMatchObject({text:"current"});
    f.storage.appendLogBatch({workspaceId:"w",originId:"owner",ops:[{originSeq:0,opKind:"workspace.init",payloadJson:"{}",recordedAtMs:1}]});
    f.storage.storeReplicaCurrentView(activeLease,{...f.view([{path:"docs/a.md",text:"stored newer"}]),revision:2,logCursor:1});
    expect(f.storage.readReplicaCurrentViewFile({...f.input,path:"docs/a.md"},supervisor)).toEqual(f.read());
    expect(f.read()).toMatchObject({text:"stored newer"});
  } finally {await supervisor.close();}
});

it.each(["epoch", "stream"])("rechecks %s on the live read", async identity => {
  const f = await fixture(); const latest = f.view();
  const supervisor = createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("identity-read"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w"); expect(f.storage.listReplicaCurrentViewFiles(f.input,supervisor)).toMatchObject({status:"ready"});
    f.db.prepare(`UPDATE sync_relay_workspaces SET ${identity === "epoch" ? "replication_epoch" : "stream_identity"}='replacement'`).run();
    expect(f.storage.listReplicaCurrentViewFiles(f.input,supervisor)).toEqual({status:"not-ready"});
  } finally {await supervisor.close();}
});

it("binary lists expose only the authorized sha and responses expose no internals", async () => {
  const f = await fixture(); const v = f.view();
  v.files.push({...f.file("docs/image.png"),contentKind:"binary"}); f.save(v);
  const result = f.list(); expect(result).toMatchObject({files:[{path:"docs/a.md"},{path:"docs/image.png",kind:"binary",sha256:sha256("docs/image.png")}]});
  expect(f.read("docs/image.png")).toEqual({status:"not-text"});
  for (const key of ["cut_seq","revision","logCursor","journalCursor","incarnation","lineageClaimId","objectId","restoreGeneration"]) {
    expect(JSON.stringify([result,f.read()])).not.toContain(`"${key}"`);
  }
});

it.each(["stale", "current", "omitted"])("round1: only current and omitted paths displace a carried restore row (%s)", reservation => {
  const f = registered({deployment:true});
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"e",streamIdentity:"s"});
    const lease = createReplicaReadPrincipal(f.storage).issue("workspace","read-carry"); f.storage.bindReplicaCurrentView(lease);
    const a = {versionId:"main",objectId:"object",path:f.input.evidence.currentPath,contentKind:"text" as const,
      sha256:sha256("old"),byteLength:3,lineageClaimId:f.input.evidence.document.lineageClaimId,restoreGeneration:1};
    const second = {...a,objectId:"second",path:"docs/second.md",sha256:sha256("two")};
    f.write(db => {
      const row = db.prepare("SELECT * FROM sync_relay_live_documents").get()!, columns = Object.keys(row);
      db.prepare(`INSERT INTO sync_relay_live_documents (${columns.join(",")}) VALUES (${columns.map(()=>"?").join(",")})`)
        .run(...columns.map(c=>c==="object_id" ? second.objectId : c==="current_path" ? second.path : row[c]));
    });
    const previous = {workspaceId:"workspace",revision:1,logCursor:0,journalCursor:0,files:[a,second],omitted:[],
      texts:[{sha256:a.sha256,text:"old"},{sha256:second.sha256,text:"two"}]};
    f.storage.storeReplicaCurrentView(lease,previous);
    f.write(db=>db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2"));
    const replacement = {...second,path:a.path,...(reservation === "current" ? {lineageClaimId:null,restoreGeneration:null} : {})};
    const view: ReplicaCurrentView = {...previous,revision:2,files:[{...a,path:"docs/moved.md"},...(reservation === "omitted" ? [] : [replacement])],
      omitted:reservation === "omitted" ? [{versionId:"main",objectId:"large",path:a.path,sha256:sha256("large"),reason:"text-frame-limit"}] : []};
    const source = {currentReadView:()=>({view,previous,readText:()=>"two"})};
    const input = {grantId:"grant",generation:4,principal:{kind:"user" as const,userId:"reader"}};
    const list = f.storage.listReplicaCurrentViewFiles(input,source);
    expect(list).toMatchObject({status:"ready",files:expect.arrayContaining([{path:a.path,status:reservation === "current" ? "ready" : "updating",...(reservation === "current" ? {kind:"text",byteLength:3,etag:expect.any(String)} : {})}])});
    expect(list.status === "ready" && list.files.some(file=>file.path === "docs/moved.md")).toBe(false);
    if (reservation === "stale") expect(list).toMatchObject({files:expect.arrayContaining([{path:second.path,status:"updating"}])});
    expect(f.storage.readReplicaCurrentViewFile({...input,path:a.path},source)).toMatchObject(
      reservation === "current" ? {status:"ready",text:"two"} : {status:"updating"});
    expect(f.storage.readReplicaCurrentViewFile({...input,path:"docs/moved.md"},source)).toEqual({status:"not-found"});
  } finally {f.close();}
});

it("round1: immutable stored metadata is reused until a flip, including repeated headers", async () => {
  const f = await fixture(); f.save();
  const first = f.storage.readReplicaCurrentView("w")!;
  expect(f.storage.readReplicaCurrentView("w")).toBe(first);
  // Deletion and recreation can reset cut_seq and repeat every header field.
  f.storage.readReplicaCurrentViewFile({...f.input,path:"docs/a.md"});
  (f.storage as StorageContext).db.exec("DELETE FROM sync_relay_replica_cuts WHERE workspace_id='w'");
  f.save(f.view([{path:"docs/a.md",text:"replacement"}]));
  expect(f.storage.readReplicaCurrentView("w")).not.toBe(first);
  expect(f.read()).toMatchObject({text:"replacement"});
});

it.each(["epoch","stream"])("round1: cached stored metadata does not survive a %s change", async identity => {
  const f = await fixture(); f.save(); const first = f.storage.readReplicaCurrentView("w")!;
  expect(f.read()).toMatchObject({text:"current"});
  f.db.prepare(`UPDATE sync_relay_workspaces SET ${identity === "epoch" ? "replication_epoch" : "stream_identity"}='replacement'`).run();
  expect(f.storage.readReplicaCurrentView("w")).toBeNull(); expect(f.read()).toEqual({status:"not-ready"});
  const lease = createReplicaReadPrincipal(f.storage).issue("w","replacement"); f.storage.bindReplicaCurrentView(lease);
  f.storage.storeReplicaCurrentView(lease,f.view([{path:"docs/a.md",text:"replacement"}]));
  expect(f.storage.readReplicaCurrentView("w")).not.toBe(first); expect(f.read()).toMatchObject({text:"replacement"});
});

it("round1: another connection cannot reuse a cached manifest by repeating its header", async () => {
  const f = await fixture(); f.save();
  const first = f.storage.readReplicaCurrentView("w"); expect(f.read()).toMatchObject({text:"current"});
  f.db.prepare("UPDATE sync_relay_replica_cut_files SET path='docs/new.md' WHERE workspace_id='w' AND path='docs/a.md'").run();
  expect(f.storage.readReplicaCurrentView("w")).not.toBe(first);
  expect(f.read()).toEqual({status:"not-found"}); expect(f.read("docs/new.md")).toMatchObject({text:"current"});
});

it("round1: a cached manifest stays attached to its SQLite read snapshot", async () => {
  const f = await fixture(); f.save(); expect(f.read()).toMatchObject({text:"current"});
  const source = {currentReadView:() => {
    f.db.prepare("UPDATE sync_relay_replica_cut_files SET path='docs/new.md' WHERE workspace_id='w' AND path='docs/a.md'").run();
    return {view:f.storage.readReplicaCurrentView("w")!};
  }};
  expect(f.storage.readReplicaCurrentViewFile({...f.input,path:"docs/a.md"},source)).toMatchObject({text:"current"});
  expect(f.read()).toEqual({status:"not-found"}); expect(f.read("docs/new.md")).toMatchObject({text:"current"});
});

it("bounds per-storage read caches and clears a revoked workspace", async () => {
  const storage = await testStorage();
  const context = storage as StorageContext;
  const leases = [] as Array<import("./replicaReadPrincipal").ReplicaReadLease>;
  try {
    for (let i = 0; i < 5; i++) {
      const workspaceId = `cache-${i}`, shareId = `cache-share-${i}`, grantId = `cache-grant-${i}`;
      storage.claimWorkspace({workspaceId,ownerUserId:"owner",createdAtMs:1});
      storage.claimWorkspaceIdentity({workspaceId,replicationEpoch:"epoch",streamIdentity:"stream"});
      storage.createShare({share:{shareId,workspaceId,granterUserId:"owner",selectorJson:'{"paths":["docs"],"versionId":null}',createdAtMs:1},
        grant:{grantId,shareId,principalKind:"user",principalUserId:"reader",principalEmail:null,access:"edit",generation:1,status:"active",createdAtMs:1,revokedAtMs:null,parentGrantId:null}});
      const lease = createReplicaReadPrincipal(storage).issue(workspaceId,`cache-${i}`); storage.bindReplicaCurrentView(lease); leases.push(lease);
      const text = `cached-${i}`, file = {versionId:"main",objectId:`object-${i}`,path:"docs/a.md",contentKind:"text" as const,
        sha256:sha256(text),byteLength:Buffer.byteLength(text),lineageClaimId:null,restoreGeneration:null};
      storage.storeReplicaCurrentView(lease,{workspaceId,revision:1,logCursor:0,journalCursor:0,files:[file],omitted:[],texts:[{sha256:file.sha256,text}]});
      expect(storage.readReplicaCurrentViewFile({grantId,generation:1,principal:{kind:"user",userId:"reader"},path:file.path})).toMatchObject({status:"ready",text});
    }
    expect(replicaCurrentViewReadCacheSize(context)).toBe(4);
    expect(replicaCurrentViewStoredCacheSize(context)).toBe(4);
    context.db.prepare("UPDATE sync_relay_share_grants SET status='revoked',generation=2,revoked_at_ms=2 WHERE grant_id=?").run("cache-grant-4");
    storage.releaseReplicaCurrentView(leases[4]!);
    expect(replicaCurrentViewReadCacheSize(context)).toBe(3);
    expect(replicaCurrentViewStoredCacheSize(context)).toBe(3);
  } finally { closeTestStorage(storage); }
});

it("round1: retired fences use the same default generation and carried path as 6a", () => {
  const f = registered({deployment:true});
  try {
    f.storage.claimWorkspaceIdentity({workspaceId:"workspace",replicationEpoch:"e",streamIdentity:"s"});
    const lease = createReplicaReadPrincipal(f.storage).issue("workspace","retired-fence"); f.storage.bindReplicaCurrentView(lease);
    f.write(db=>db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2"));
    const file = {versionId:"main",objectId:"object",path:f.input.evidence.currentPath,contentKind:"text" as const,
      sha256:sha256("old"),byteLength:3,lineageClaimId:f.input.evidence.document.lineageClaimId,restoreGeneration:2};
    const previous = {workspaceId:"workspace",revision:1,logCursor:0,journalCursor:0,files:[file],omitted:[],texts:[{sha256:file.sha256,text:"old"}]};
    f.storage.storeReplicaCurrentView(lease,previous);
    f.write(db=>db.exec("UPDATE sync_relay_live_documents SET lineage_state='retired',admission_state='closed',retired_at_ms=10"));
    const view = {...previous,revision:2,files:[{...file,path:"docs/moved.md"}]};
    expect(f.storage.currentViewFilesAtFences("workspace",view.files,previous.files,[])).toEqual(previous.files);
    const input = {grantId:"grant",generation:4,principal:{kind:"user" as const,userId:"reader"}};
    expect(f.storage.listReplicaCurrentViewFiles(input,{currentReadView:()=>({view,previous})})).toMatchObject({files:[{path:file.path,status:"updating"}]});
    expect(f.storage.readReplicaCurrentViewFile({...input,path:file.path},{currentReadView:()=>({view,previous})})).toEqual({status:"updating"});
  } finally {f.close();}
});
