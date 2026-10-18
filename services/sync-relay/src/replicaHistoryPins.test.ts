import {afterEach, expect, it, vi} from "vitest";
import type {ReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {createReplicaSupervisor} from "./replicaSupervisor";
import {initializeReplicaCurrentViewSchema} from "./storage/replicaCurrentViewSchema";
import type {SqliteDb} from "./storage/types";
import {closeTestStorage, closeTestStorages, inspectDatabase, reopenTestStorage, seedLinkGrant, sha256, storagePath, tempRoot, testStorage} from "./testing";

afterEach(async () => {vi.useRealTimers(); await closeTestStorages();});

it.each(["log","journal"])("current view floor refuses stale stored and live text after a %s replacement",async stream=>{
  const f=await fixture();f.save(f.view("secret"));const stale=f.latest;
  replacementEvidence(f.db,stream);f.grant("late");
  const input={...f.input,grantId:"late"};
  for(const source of [undefined,{currentReadView:()=>({view:stale})}]) {
    expect(f.storage.listReplicaCurrentViewFiles(input,source)).toEqual({status:"updating"});
    expect(f.storage.readReplicaCurrentViewFile({...input,path:"docs/a.md"},source)).toEqual({status:"updating"});
  }
  f.save(f.view("public"));expect(f.storage.readReplicaCurrentViewFile({...input,path:"docs/a.md"})).toMatchObject({text:"public"});
});

it("Undo raises the restored grant floor past private edits made during removal",async()=>{
  const f=await fixture();f.save();
  const removal=f.storage.removeShareAccess({shareId:"g",grantId:"g",actorUserId:"owner",nowMs:100_000});
  if(!removal.ok || !removal.undo)throw Error("removal failed");
  // 6a discards the cut even with the wide share alive; recollect before the private edit.
  f.save(f.view("public"));replacementEvidence(f.db,"log");f.at(101_000);f.save(f.view("private paragraph"));
  f.at(131_000);f.save();const id=String(f.pins().find(p=>p.sha256===sha256("private paragraph"))!.pin_id);
  replacementEvidence(f.db,"log");f.at(132_000);f.save(f.view("public"));
  f.storage.undoShareRemoval({shareId:"g",actorUserId:"owner",undoId:removal.undo.undoId,nowMs:133_000});
  f.save();
  expect(f.read(id,{generation:3})).toEqual({status:"not-found"});
  expect(f.read(id,{grantId:"wide"})).toMatchObject({text:"private paragraph"});
});

function replacementEvidence(db: ReturnType<typeof inspectDatabase>, stream: string, object = "object") {
  if (stream === "log") return Number(db.prepare(`INSERT INTO sync_relay_log
    (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms)
    VALUES ('w','replacement',coalesce((SELECT max(origin_seq)+1 FROM sync_relay_log WHERE origin_id='replacement'),0),
      'moment.append',?,1) RETURNING relay_seq`).get(JSON.stringify({versionId:"main",objectId:object,operation:"write",path:"docs/a.md"}))!.relay_seq);
  return Number(db.prepare(`INSERT INTO sync_relay_live_update_journal
    (delivery_id,update_digest,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,
    restore_fence_generation,principal_kind,principal_id,accepting_host_epoch,received_at_ms,update_bytes,
    relay_database_namespace,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes,canonical_version,first_seen_deletes_json)
    VALUES (?,?, 'w','main',?,?,'docs/a.md','["docs"]',1,'owner','owner',1,1,x'01','ns',1,?,1,2,'[{"clientId":1,"startClock":0,"endClock":1}]')
    RETURNING journal_cursor`).get(`delivery-${object}-${db.prepare("SELECT count(*) AS n FROM sync_relay_live_update_journal").get()!.n}`,sha256("update"),object,sha256("lineage"),sha256("evidence"))!.journal_cursor);
}

it.each(["log","journal"])("position floor hides %s replacements admitted before a grant while collection is idle", async stream => {
  const f=await fixture();f.save(f.view("draft"));f.at(101_000);f.save(f.view("secret"));f.at(131_000);f.save();
  const id=String(f.pins().find(p=>p.sha256===sha256("secret"))!.pin_id);
  const position=replacementEvidence(f.db,stream);
  f.at(140_000);f.grant("late",["docs"],140_000);
  const publicView={...f.view("public"),logCursor:stream==="log"?position:0,journalCursor:stream==="journal"?position:0};
  expect(f.read(id,{grantId:"late"})).toEqual({status:"updating"});
  expect(f.storage.readReplicaHistoryPin({...f.input,grantId:"late",pinId:id},
    {currentReadView:()=>({view:publicView})})).toEqual({status:"updating"});
  f.at(200_000);f.save(publicView);
  expect(f.read(id,{grantId:"late"})).toEqual({status:"not-found"});
  expect(f.read(id)).toMatchObject({status:"ready",text:"secret"});
});

it.each(["log","journal"])("position floor preserves a state current at access before a later %s replacement", async stream => {
  const f=await fixture();f.save(f.view("draft"));f.at(101_000);f.save(f.view("secret"));f.at(131_000);f.save();
  const id=String(f.pins().find(p=>p.sha256===sha256("secret"))!.pin_id);
  f.grant("early",["docs"],999_999);expect(f.read(id,{grantId:"early"})).toMatchObject({text:"secret"});
  const position=replacementEvidence(f.db,stream);
  f.at(200_000);f.save({...f.view("public"),logCursor:stream==="log"?position:0,journalCursor:stream==="journal"?position:0});
  expect(f.read(id,{grantId:"early"})).toMatchObject({status:"ready",text:"secret"});
});

it("position floor hides unresolved replacing evidence", async()=>{
  const f=await fixture();f.save(f.view("draft"));f.at(101_000);f.save(f.view("secret"));f.at(131_000);f.save();
  const id=String(f.pins().find(p=>p.sha256===sha256("secret"))!.pin_id);
  f.save(f.view("public"));expect(f.read(id)).toEqual({status:"not-found"});
});

it.each(["same-stream","both-streams"])("position floor uses the earliest replacement in each %s interval",async kind=>{
  const f=await fixture();f.save();f.at(130_000);f.save();const id=String(f.pins()[0]!.pin_id);
  const first=replacementEvidence(f.db,"log");f.grant("between");
  if(kind==="both-streams")replacementEvidence(f.db,"journal");
  else replacementEvidence(f.db,"log");
  f.save(f.view("public"));expect(f.read(id)).toMatchObject({text:"initial"});
  expect(f.read(id,{grantId:"between"})).toEqual({status:"not-found"});
  expect(f.pins()[0]).toMatchObject({replaced_log_position:first,replaced_journal_position:kind==="both-streams"?1:null});
});

it("captures link and redeemed dependent floors in their grant transactions and rolls them back",async()=>{
  const f=await fixture();f.save();f.at(130_000);f.save();const id=String(f.pins()[0]!.pin_id);
  const log=replacementEvidence(f.db,"log"),journal=replacementEvidence(f.db,"journal","other-object");
  seedLinkGrant(f.storage,{shareId:"g",grantId:"link-floor",secretHash:"hash"});
  expect(f.storage.mintLinkHandoffCode({code:{codeId:"code",codeHash:"code-hash",grantId:"link-floor",generation:1,
    mintedAtMs:10,expiresAtMs:100},guard:()=>true})).toBe(true);
  expect(f.storage.redeemLinkHandoffCode({codeHash:"code-hash",principalUserId:"reader",redeemedAtMs:20,
    mintGrantId:()=>"dependent-floor",guard:()=>true})).toMatchObject({ok:true});
  for(const id of ["link-floor","dependent-floor"])
    expect(f.db.prepare("SELECT * FROM sync_relay_history_grant_floors WHERE grant_id=?").get(id))
      .toMatchObject({workspace_id:"w",replication_epoch:"e",stream_identity:"s",log_floor:log,journal_floor:journal});
  f.save(f.view("public"));
  expect(f.read(id,{grantId:"link-floor",principal:{kind:"link"}})).toEqual({status:"not-found"});
  expect(f.read(id,{grantId:"dependent-floor"})).toEqual({status:"not-found"});
  expect(f.read(id)).toMatchObject({text:"initial"});
  f.db.exec(`CREATE TRIGGER reject_credential BEFORE INSERT ON sync_relay_link_credentials BEGIN SELECT RAISE(ABORT,'refuse'); END`);
  expect(()=>f.storage.createLinkGrant({grant:{...f.storage.getShareGrant("link-floor")!,grantId:"rolled-back"},
    credential:{credentialId:"reject",grantId:"rolled-back",secretHash:"reject",generation:1,mintedAtMs:10,retiredAtMs:null}})).toThrow("refuse");
  expect(f.db.prepare("SELECT * FROM sync_relay_history_grant_floors WHERE grant_id='rolled-back'").get()).toBeUndefined();
});

it("first sight is clean and a 2,000-file workspace retains superseded History after edits", async()=>{
  const f=await fixture(false),text="initial",files=Array.from({length:2000},(_,i)=>f.file(text,{objectId:`object-${i}`,path:`docs/${i}.md`}));
  let view={...f.view(),files};f.save(view);f.at(130_000);f.save();expect(f.pins()).toHaveLength(0);
  for(let edit=1;edit<=3;edit++){
    replacementEvidence(f.db,"log","object-0");
    f.at(140_000+edit*60_000);view={...view,revision:view.revision+1,files:view.files.map((file,i)=>i?file:f.file(`edit-${edit}`,{objectId:"object-0",path:"docs/0.md"})),
      logCursor:f.storage.readReplicaStanding("w")!.logSeq,texts:[{sha256:sha256(`edit-${edit}`),text:`edit-${edit}`} ]};
    f.save(view);f.at(170_000+edit*60_000);f.save();
  }
  expect(f.pins().filter(p=>p.superseded_at_ms!==null).length).toBeGreaterThan(0);
  expect(f.pins().length).toBeLessThanOrEqual(1024);
  for(const pin of f.pins())expect(f.read(String(pin.pin_id))).toMatchObject({status:"ready"});
});

it("keeps superseded History with more than 1,024 edited current states",async()=>{
  const f=await fixture(false),files=Array.from({length:1100},(_,i)=>f.file("baseline",{objectId:`object-${i}`,path:`docs/${i}.md`}));
  f.save({...f.view("baseline"),files});
  f.save({...f.view(),files:files.map(file=>({...file,sha256:sha256("initial"),byteLength:7}))});
  f.at(130_000);f.save();expect(f.pins()).toHaveLength(1100);
  replacementEvidence(f.db,"log","object-0");
  f.at(140_000);f.save({...f.latest,revision:f.latest.revision+1,logCursor:f.storage.readReplicaStanding("w")!.logSeq,
    files:f.latest.files.map((file,i)=>i?file:{...file,sha256:sha256("next"),byteLength:4}),texts:[{sha256:sha256("next"),text:"next"}]});
  f.at(170_000);f.save();
  const old=f.pins().find(p=>p.object_id==="object-0" && p.superseded_at_ms!==null)!;
  expect(old).toBeDefined();expect(f.read(String(old.pin_id))).toMatchObject({text:"initial"});
});

it("pins a created state relative to an established cut",async()=>{
  const f=await fixture();const created=f.file("created",{objectId:"new",path:"docs/new.md"});
  f.save({...f.view(),files:[f.file(),created],texts:[{sha256:sha256("initial"),text:"initial"},{sha256:sha256("created"),text:"created"}]});
  f.at(130_000);f.save();expect(f.pins().find(p=>p.object_id==="new")).toMatchObject({reason:"quiet",sha256:sha256("created")});
});

it.each(["rename","delete","lineage","restore"])("relabels an exact quiet predecessor for %s without another text reference",async reason=>{
  const f=await fixture(),lineage=sha256("lineage");
  const patch=reason==="restore"?{lineageClaimId:lineage,restoreGeneration:1}:{};
  f.save(f.view("initial",patch));f.at(130_000);f.save();
  const predecessor=f.pins().find(p=>p.superseded_at_ms===null)!;
  f.at(140_000);replacementEvidence(f.db,"log");
  if(reason==="restore")f.db.exec(`INSERT INTO sync_relay_live_documents
    (workspace_id,main_version_id,object_id,lineage_claim_id,current_path,lineage_state,admission_state,restore_fence_generation,registered_at_ms,
    baseline_moment_relay_seq,baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes)
    VALUES ('w','main','object','${lineage}','docs/a.md','current','open',2,1,1,'${lineage}',0,'${lineage}',x'01')`);
  f.save(reason==="delete"?{...f.view(),files:[],texts:[]}:f.view("initial",reason==="rename"?{path:"docs/b.md"}:
    {lineageClaimId:lineage,restoreGeneration:reason==="restore"?2:1}));
  expect(f.pins().filter(p=>p.sha256===sha256("initial") && p.path===predecessor.path && p.lineage_claim_id===predecessor.lineage_claim_id))
    .toEqual([expect.objectContaining({pin_id:predecessor.pin_id,reason})]);
  expect(f.db.prepare("SELECT ref_count FROM sync_relay_replica_cut_text_refs WHERE sha256=?").get(sha256("initial")))
    .toMatchObject({ref_count:reason==="delete"?1:2});
});

it("starts new clocks at the baseline cut's author cursors",async()=>{
  const f=await fixture(false);replacementEvidence(f.db,"log");replacementEvidence(f.db,"journal");
  f.db.exec(`UPDATE sync_relay_log SET admitted_author_snapshot_json='[{"kind":"human","humanId":"old","humanName":"Old"}]';
    UPDATE sync_relay_live_update_journal SET author_snapshot_json='[{"kind":"human","humanId":"old","humanName":"Old"}]'`);
  f.save(f.view("baseline"));f.save(f.view());f.at(130_000);f.save();
  expect(JSON.stringify(f.pins()[0]!.authors_json)).not.toContain("Old");
  expect(f.db.prepare("SELECT pin_log_cursor,pin_journal_cursor FROM sync_relay_history_clocks").get()).toEqual({pin_log_cursor:1,pin_journal_cursor:1});
});

it.each(["log","journal"])("spends the author cap only on the pin's file in %s",async stream=>{
  const f=await fixture();
  replacementEvidence(f.db,stream);
  const table=stream==="log"?"sync_relay_log":"sync_relay_live_update_journal";
  const authors=stream==="log"?"admitted_author_snapshot_json":"author_snapshot_json";
  f.db.exec(`UPDATE ${table} SET ${authors}='[{"kind":"human","humanId":"author","humanName":"Author"}]'`);
  // Unrelated rows precede the target in the scan's position order.
  if(stream==="log")f.db.exec(`UPDATE sync_relay_log SET relay_seq=10002;
    INSERT INTO sync_relay_log (relay_seq,workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms)
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001)
    SELECT i,'w','noise',i,'moment.append','{"objectId":"other","versionId":"main"}',1 FROM n`);
  else f.db.exec(`UPDATE sync_relay_live_update_journal SET object_id='other';`);
  if(stream==="journal"){
    // Use the journal fixture repeatedly inside one transaction to exceed the workspace cap.
    f.db.exec("BEGIN");for(let i=0;i<10001;i++)replacementEvidence(f.db,"journal","other");f.db.exec("COMMIT");
    replacementEvidence(f.db,"journal");f.db.exec(`UPDATE sync_relay_live_update_journal SET ${authors}='[{"kind":"human","humanId":"author","humanName":"Author"}]' WHERE object_id='object'`);
  }
  f.save(f.view());f.at(130_000);f.save();
  expect(JSON.parse(String(f.pins()[0]!.authors_json))).toEqual([{kind:"human",humanId:"author",humanName:"Author"}]);
});

async function fixture(seedBaseline = true) {
  vi.useFakeTimers({toFake:["Date", "setTimeout", "clearTimeout"]}); vi.setSystemTime(100_000);
  let storage = await testStorage();
  storage.claimWorkspace({workspaceId:"w",ownerUserId:"owner",createdAtMs:1});
  storage.claimWorkspaceIdentity({workspaceId:"w",replicationEpoch:"e",streamIdentity:"s"});
  const grant = (id: string, paths = ["docs"], createdAtMs = 1) => storage.createShare({
    share:{shareId:id,workspaceId:"w",granterUserId:"owner",selectorJson:JSON.stringify({paths,versionId:null}),createdAtMs},
    grant:{grantId:id,shareId:id,principalKind:"user",principalUserId:"reader",principalEmail:null,access:"edit",generation:1,status:"active",createdAtMs,revokedAtMs:null,parentGrantId:null}});
  grant("wide", ["docs","private"]); grant("g");
  let lease = createReplicaReadPrincipal(storage).issue("w", "test"); storage.bindReplicaCurrentView(lease);
  const db = inspectDatabase(storagePath(storage)); let revision = 0;
  const file = (text = "initial", patch = {}) => ({versionId:"main",objectId:"object",path:"docs/a.md",contentKind:"text" as const,
    sha256:sha256(text),byteLength:Buffer.byteLength(text),lineageClaimId:null,restoreGeneration:null,...patch});
  const view = (text = "initial", patch = {}): ReplicaCurrentView => ({workspaceId:"w",revision:++revision,
    logCursor:storage.readReplicaStanding("w")!.logSeq,journalCursor:storage.readReplicaStanding("w")!.journalCursor,
    files:[file(text,patch)],texts:[{sha256:sha256(text),text}],omitted:[]});
  // Most policy tests start with an edit of an established clean baseline.
  if (seedBaseline) storage.storeReplicaCurrentView(lease,view("baseline"));
  let latest = view();
  const save = (v = latest) => {latest = v; storage.storeReplicaCurrentView(lease,v);};
  const pins = () => db.prepare("SELECT * FROM sync_relay_history_pins ORDER BY pinned_at_ms,pin_id").all();
  const input = {grantId:"g",generation:1,principal:{kind:"user" as const,userId:"reader"}};
  const list = (extra = {}) => storage.listReplicaHistoryPins({...input,...extra});
  const read = (pinId: string, extra = {}) => storage.readReplicaHistoryPin({...input,pinId,...extra});
  const at = (ms: number) => vi.setSystemTime(ms);
  const restart = () => {
    const path = storagePath(storage); closeTestStorage(storage); storage = reopenTestStorage(path);
    lease = createReplicaReadPrincipal(storage).issue("w", "restart"); storage.bindReplicaCurrentView(lease);
  };
  return {get storage(){return storage;},db,grant,file,view,save,pins,list,read,input,at,restart,get latest(){return latest;}};
}

it("pins after 30 seconds quiet, never turns every cut into History", async () => {
  const f = await fixture(); f.save(); expect(f.pins()).toHaveLength(0);
  f.at(129_999); f.save(); expect(f.pins()).toHaveLength(0);
  f.at(130_000); f.save(); expect(f.pins()).toMatchObject([{reason:"quiet",superseded_at_ms:null}]);
  f.at(160_000); f.save(); expect(f.pins()).toHaveLength(1);
});

it("pins at the five minute ceiling during edits and spaces non-structural pins", async () => {
  const f = await fixture(); f.save();
  for (let i = 1; i <= 15; i++) {f.at(100_000+i*20_000); f.save(f.view(String(i)));}
  expect(f.pins()).toMatchObject([{reason:"ceiling",pinned_at_ms:400_000}]);
  f.at(400_001); f.save(f.view("later")); f.at(430_000); f.save(); expect(f.pins()).toHaveLength(1);
  f.at(430_001); f.save(); expect(f.pins()).toHaveLength(2);
  expect(Number(f.pins()[1]!.pinned_at_ms)-Number(f.pins()[0]!.pinned_at_ms)).toBeGreaterThanOrEqual(30_000);
});

it.each(["rename","delete","restore","lineage"])("pins the previous state before %s", async reason => {
  const f = await fixture(); f.save(); f.at(100_001);
  // Null -> claimed lineage is a lineage change. A generation step uses a relay fence.
  if (reason === "restore") {
    const lineage = sha256("lineage");
    f.db.exec(`INSERT INTO sync_relay_live_documents
      (workspace_id,main_version_id,object_id,lineage_claim_id,current_path,lineage_state,admission_state,restore_fence_generation,registered_at_ms,
      baseline_moment_relay_seq,baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes)
      VALUES ('w','main','object','${lineage}','docs/a.md','current','open',1,1,1,'${lineage}',0,'${lineage}',x'01')`);
    f.save(f.view("before",{lineageClaimId:lineage,restoreGeneration:1}));
    f.db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2");
    f.save(f.view("after",{lineageClaimId:lineage,restoreGeneration:2}));
  } else if (reason === "delete") f.save({...f.view(),files:[],texts:[]});
  else f.save(f.view("after",reason === "rename" ? {path:"docs/b.md"} : {lineageClaimId:sha256("lineage"),restoreGeneration:1}));
  const pin = f.pins().find(p => p.reason === reason)!;
  expect(pin).toMatchObject({sha256:sha256(reason === "restore" ? "before" : "initial"),superseded_at_ms:100_001});
});

it("supersedes on the first edit, so a deleted secret predating a grant stays hidden", async () => {
  const f = await fixture(); f.save(); f.at(130_000); f.save(); const id = String(f.pins()[0]!.pin_id);
  f.at(140_000); replacementEvidence(f.db,"log"); f.save({...f.view(),files:[],texts:[]});
  f.grant("new",["docs"],150_000);
  f.at(160_000); f.save(f.view("public"));
  expect(f.read(id,{grantId:"new"})).toEqual({status:"not-found"});
  expect(f.read(id)).toMatchObject({status:"ready",text:"initial"});
  f.grant("equal",["docs"],140_000); expect(f.read(id,{grantId:"equal"})).toEqual({status:"not-found"});
});

it("requires both the historical path and the object's current path to be visible", async () => {
  const f = await fixture(); f.save(); f.at(130_000); f.save(); const id = String(f.pins()[0]!.pin_id);
  f.at(140_000); replacementEvidence(f.db,"log"); f.save(f.view("private",{path:"private/a.md"}));
  expect(f.read(id)).toEqual({status:"not-found"});
  f.at(150_000); f.save(f.view("returned")); expect(f.read(id)).toMatchObject({text:"initial"});
  const privatePin = f.pins().find(p=>p.path === "private/a.md")!;
  expect(f.read(String(privatePin.pin_id))).toEqual({status:"not-found"});
  f.save({...f.view(),files:[],texts:[]}); expect(f.read(id)).toEqual({status:"not-found"});
});

it("rechecks revocation, generation, principal, narrowing and widening", async () => {
  const f = await fixture(); seedLinkGrant(f.storage,{shareId:"g",grantId:"link",secretHash:"hash",access:"edit"});
  f.save(); f.at(130_000); f.save(); const id = String(f.pins()[0]!.pin_id);
  const input = {grantId:"link",principal:{kind:"link" as const}};
  expect(f.storage.retuneShareGrant({shareId:"g",grantId:"link",access:"view",changedAtMs:140_000,expectedDependentGrantIds:[],guard(){}}).ok).toBe(true);
  expect(f.read(id,input)).toMatchObject({status:"ready"});
  expect(f.storage.retuneShareGrant({shareId:"g",grantId:"link",access:"edit",changedAtMs:150_000,expectedDependentGrantIds:[],guard(){},
    mintCredential:()=>({credentialId:"widened",secretHash:"new-hash"})}).ok).toBe(true);
  expect(f.read(id,input)).toEqual({status:"denied"}); expect(f.read(id,{...input,generation:2})).toMatchObject({status:"ready"});
  expect(f.read(id,{principal:{kind:"user",userId:"stranger"}})).toEqual({status:"denied"});
  f.storage.revokeShareGrant({shareId:"g",grantId:"link",revokedAtMs:160_000});
  expect(f.list(input)).toEqual({status:"denied"}); expect(f.read(id,input)).toEqual({status:"denied"});
});

it("keeps pins, text references and the policy clock across a relay restart", async () => {
  const f = await fixture(); f.save(); f.at(120_000); f.restart();
  f.at(129_999); f.save(); expect(f.pins()).toHaveLength(0);
  f.at(130_000); f.save(); const id = String(f.pins()[0]!.pin_id);
  f.at(140_000); replacementEvidence(f.db,"log"); f.save(f.view("next")); f.restart(); expect(f.read(id)).toMatchObject({text:"initial"});
  expect(f.db.prepare("SELECT ref_count FROM sync_relay_replica_cut_text_refs WHERE sha256=?").get(sha256("initial"))).toMatchObject({ref_count:1});
});

it.each(["epoch","stream","last-share","share-delete","share-owner"])("deletes pin data on %s", async change => {
  const f = await fixture(); f.save(); f.at(130_000); f.save(); expect(f.pins()).toHaveLength(1);
  if (change === "last-share") for (const id of ["g","wide"]) f.storage.revokeShareGrant({shareId:id,grantId:id,revokedAtMs:140_000});
  else if (change === "share-delete") f.db.exec("DELETE FROM sync_relay_shares");
  else if (change === "share-owner") f.db.exec("UPDATE sync_relay_shares SET granter_user_id='other'");
  else f.db.exec(`UPDATE sync_relay_workspaces SET ${change === "epoch" ? "replication_epoch" : "stream_identity"}='new'`);
  expect(f.pins()).toHaveLength(0);
  expect(f.db.prepare("SELECT count(*) AS n FROM sync_relay_replica_cut_texts").get()).toMatchObject({n:0});
  expect(f.db.prepare("SELECT * FROM sync_relay_replica_cut_text_refs").all()).toEqual([]);
});

it("accountless History projects paths and omits authors, without internal cursors", async () => {
  const f = await fixture(false); f.grant("project",["private/docs"]);
  seedLinkGrant(f.storage,{shareId:"project",grantId:"link",secretHash:"hash",access:"view"});
  f.save(f.view("baseline",{path:"private/docs/a.md"}));
  f.save(f.view("initial",{path:"private/docs/a.md"})); f.at(130_000); f.save(); const id = String(f.pins()[0]!.pin_id);
  f.db.prepare("UPDATE sync_relay_history_pins SET authors_json=?").run('[{"kind":"human","humanId":"owner","humanName":"Owner"}]');
  const result = f.read(id,{grantId:"link",principal:{kind:"link"}});
  expect(result).toMatchObject({status:"ready",pin:{path:"docs/a.md",authors:[]},text:"initial"});
  const listed = f.list({grantId:"link",principal:{kind:"link"}});
  expect(listed).toMatchObject({status:"ready",pins:[{path:"docs/a.md",authors:[]}]});
  for (const key of ["logCursor","journalCursor","log_cursor","journal_cursor","cut_seq"]) expect(JSON.stringify([result,listed])).not.toContain(key);
});

it("owners import zero pins and pin storage does not consume the owner's quota", async () => {
  const f = await fixture(); const before = f.storage.fetchLogPage({workspaceId:"w",sinceRelaySeq:0,limit:100});
  const usage = f.db.prepare("SELECT * FROM sync_relay_workspace_usage").all();
  f.save(); f.at(130_000); f.save(); expect(f.pins()).toHaveLength(1);
  expect(f.storage.fetchLogPage({workspaceId:"w",sinceRelaySeq:0,limit:100})).toEqual(before);
  expect(f.db.prepare("SELECT * FROM sync_relay_workspace_usage").all()).toEqual(usage);
  expect(f.storage.getBlob("w",sha256("initial"))).toBeNull();
});

it("the supervisor wakes for quiet pins and preserves an unflushed state before a move", async () => {
  const f = await fixture(); let latest = f.view();
  const supervisor = createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("history"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w"); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.pins()).toMatchObject([{reason:"quiet"}]);
    latest = f.view("unflushed"); await supervisor.activate("w");
    await vi.advanceTimersByTimeAsync(1_000); latest = f.view("moved",{path:"docs/b.md"}); await supervisor.activate("w");
    expect(f.pins().find(p=>p.reason === "rename")).toMatchObject({sha256:sha256("unflushed")});
  } finally {await supervisor.close();}
});

it("thins within workspace byte and count budgets, preserving current and structural states first", async () => {
  const f = await fixture();
  for (let i = 0; i < 8; i++) {f.at(100_000+i*60_000); f.save(f.view(String(i))); f.at(130_000+i*60_000); f.save();}
  f.at(560_001); f.save(f.view("renamed",{path:"docs/b.md"})); f.at(590_001); f.save();
  const modulePath = "./storage/replicaHistoryPins";
  const {thinReplicaHistoryPins} = await import(/* @vite-ignore */ modulePath);
  thinReplicaHistoryPins(f.storage as never,"w",{maxBytes:10_000,maxCount:3});
  const pins = f.pins(); expect(pins.filter(p=>p.superseded_at_ms!==null).length).toBeLessThanOrEqual(3);
  expect(pins.some(p=>p.reason === "rename")).toBe(true);
  expect(pins.some(p=>p.pinned_at_ms === 130_000)).toBe(true);
  expect(pins.some(p=>p.sha256 === sha256("renamed") && p.superseded_at_ms === null)).toBe(true);
  thinReplicaHistoryPins(f.storage as never,"w",{maxBytes:0,maxCount:0});
  expect(f.pins()).toMatchObject([{sha256:sha256("renamed")}]);
  expect(f.storage.readReplicaCurrentViewFile({...f.input,path:"docs/b.md"})).toMatchObject({text:"renamed"});
});

it("uses admitted ordinary authors, ignores forged payloads, refused settlements and audit echoes", async () => {
  const f = await fixture(); const human = (name: string) => [{kind:"human",humanId:name,humanName:name}];
  const add = (kind: string, snapshot: unknown, extra = {}, admission: unknown = null) => f.db.prepare(`INSERT INTO sync_relay_log
    (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,admitted_author_snapshot_json,settlement_admission_json)
    VALUES ('w','device',?, ?,?,1,?,?)`).run(++seq,kind,JSON.stringify({objectId:"object",versionId:"main",authors:human("forged"),...extra}),
      snapshot === null ? null : JSON.stringify(snapshot),admission === null ? null : JSON.stringify(admission));
  let seq = 0;
  add("ydoc.update",human("typing")); add("moment.append",human("moment"));
  add("moment.append",human("refused"),{},{status:"refused",settlementId:"x"});
  add("live.audit.update",human("audit")); add("ydoc.update",null);
  add("ydoc.update",human("other"),{objectId:"other"}); add("ydoc.update",human("branch"),{versionId:"branch"});
  f.save({...f.view(),logCursor:seq}); f.at(130_000); f.save();
  const authors = JSON.parse(String(f.pins()[0]!.authors_json));
  expect(authors).toEqual(expect.arrayContaining([...human("typing"),...human("moment"),{kind:"unattributed"}]));
  expect(JSON.stringify(authors)).not.toMatch(/forged|refused|audit|other|branch/);
  f.at(140_000); add("ydoc.update",human("next")); f.save({...f.view("next"),logCursor:seq});
  f.at(170_000); f.save(); expect(JSON.parse(String(f.pins()[1]!.authors_json))).toEqual(human("next"));
});

it.each(["firstSeen","deletes","empty","seed"])("journal authors require credited content: %s", async source => {
  const f = await fixture(); const lineage = sha256("journal");
  f.db.prepare(`INSERT INTO sync_relay_live_update_journal
    (delivery_id,update_digest,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,
    restore_fence_generation,principal_kind,principal_id,accepting_host_epoch,received_at_ms,update_bytes,
    relay_database_namespace,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes,canonical_version,author_snapshot_json,
    first_seen_deletes_json,seed_first_seen_json) VALUES ('d',?,'w','main','object',?,'docs/a.md','["docs"]',1,'owner','owner',1,1,?,
    'ns',1,?,1,2,?,?,?)`).run(sha256("update"),lineage,Buffer.from([1]),sha256("evidence"),
      JSON.stringify([{kind:"human",humanId:"journal",humanName:"Journal"}]),
      source === "deletes" ? '[{"clientId":1,"startClock":0,"endClock":1}]' : '[]',
      source === "seed" ? '[{"clientId":1,"startClock":0,"endClock":1}]' : '[]');
  if (source === "firstSeen" || source === "seed") f.db.prepare(`INSERT INTO sync_relay_live_update_struct_provenance
    VALUES ('w','main','object',?,1,0,1,1)`).run(lineage);
  f.save({...f.view(),journalCursor:1}); f.at(130_000); f.save();
  const authors = JSON.parse(String(f.pins()[0]!.authors_json));
  expect(authors).toEqual(source === "firstSeen" || source === "deletes" ? [{kind:"human",humanId:"journal",humanName:"Journal"}] : [{kind:"unattributed"}]);
});

it("caps the evidence scan at 10,000 raw rows and marks the uncovered suffix unattributed", async () => {
  const f = await fixture(); f.db.exec("BEGIN");
  const insert = f.db.prepare(`INSERT INTO sync_relay_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,admitted_author_snapshot_json)
    VALUES ('w','device',?,'ydoc.update','{"objectId":"object","versionId":"main"}',1,?)`);
  for (let i = 1; i <= 10_001; i++) insert.run(i,JSON.stringify([{kind:"human",humanId:i === 10_001 ? "past-cap" : "within",humanName:"Name"}]));
  f.db.exec("COMMIT"); f.save({...f.view(),logCursor:10_001}); f.at(130_000); f.save();
  expect(JSON.parse(String(f.pins()[0]!.authors_json))).toEqual([{kind:"human",humanId:"within",humanName:"Name"},{kind:"unattributed"}]);
});

it("ending one grant keeps other recipients' pins and text references", async () => {
  const f = await fixture(); f.save(); f.at(130_000); f.save(); const id = String(f.pins()[0]!.pin_id);
  f.storage.revokeShareGrant({shareId:"g",grantId:"g",revokedAtMs:140_000});
  expect(f.pins()).toHaveLength(1); f.save();
  expect(f.read(id,{grantId:"wide"})).toMatchObject({text:"initial"});
});

it("unions admitted identities, keeps maximum depth and uses shared moment normalization", async () => {
  const f = await fixture(); const human = {kind:"human",humanId:"h",humanName:"Human"};
  const agent = {kind:"agent",agentId:"a",agentName:"Agent",onBehalfOf:"h",depth:1};
  const automation = {kind:"automation",automationId:"collection:Tasks#mark",attribution:{actorKind:"automation",depth:2,onBehalfOf:"h"}};
  const snapshots = [[human,agent,automation],[human,{...agent,depth:3}],
    [{kind:"link",publicPrincipalId:"public-reader",label:"Reader"}],
    [{...agent,agentId:"orphan",onBehalfOf:"nobody"}]];
  const insert = f.db.prepare(`INSERT INTO sync_relay_log
    (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,admitted_author_snapshot_json)
    VALUES ('w','source',?,'moment.append','{"objectId":"object","versionId":"main"}',1,?)`);
  snapshots.forEach((snapshot,i)=>insert.run(i,JSON.stringify(snapshot)));
  f.save({...f.view(),logCursor:snapshots.length}); f.at(130_000); f.save();
  expect(JSON.parse(String(f.pins()[0]!.authors_json))).toEqual([human,{...agent,depth:3},
    {kind:"automation",automationId:automation.automationId,depth:2,onBehalfOf:"h"},
    {kind:"link",publicPrincipalId:"public-reader",label:"Reader"},{kind:"unattributed"}]);
});

it("rolls a pin and its clock back with a refused cut flip", async () => {
  const f = await fixture(); f.save(); f.at(130_000);
  f.db.exec("CREATE TRIGGER reject_flip BEFORE UPDATE ON sync_relay_replica_cuts BEGIN SELECT RAISE(ABORT,'test flip refusal'); END");
  expect(()=>f.save()).toThrow("test flip refusal"); expect(f.pins()).toHaveLength(0);
  f.db.exec("DROP TRIGGER reject_flip"); f.save(); expect(f.pins()).toMatchObject([{reason:"quiet",pinned_at_ms:130_000}]);
});

it("never retains transient edits as History or orphaned text", async () => {
  const f = await fixture(); f.save();
  for (let i=1;i<=20;i++) {f.at(100_000+i*1_000); f.save(f.view(`transient-${i}`));}
  expect(f.pins()).toHaveLength(0); f.at(150_000); f.save();
  expect(f.pins()).toMatchObject([{sha256:sha256("transient-20")}]);
  expect(f.db.prepare("SELECT DISTINCT sha256 FROM sync_relay_replica_cut_texts").all()).toEqual([{sha256:sha256("transient-20")}]);
});

it("pins an unflushed pre-restore head even after the relay raises its generation fence", async () => {
  const f = await fixture(), lineage=sha256("restore-live");
  f.db.exec(`INSERT INTO sync_relay_live_documents
    (workspace_id,main_version_id,object_id,lineage_claim_id,current_path,lineage_state,admission_state,restore_fence_generation,registered_at_ms,
    baseline_moment_relay_seq,baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes)
    VALUES ('w','main','object','${lineage}','docs/a.md','current','open',1,1,1,'${lineage}',0,'${lineage}',x'01')`);
  let latest=f.view("initial",{lineageClaimId:lineage,restoreGeneration:1});
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("history-restore"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w"); latest=f.view("unflushed",{lineageClaimId:lineage,restoreGeneration:1}); await supervisor.activate("w");
    f.at(101_000); f.db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2");
    latest=f.view("restored",{lineageClaimId:lineage,restoreGeneration:2}); await supervisor.activate("w");
    expect(f.pins().find(p=>p.reason === "restore")).toMatchObject({sha256:sha256("unflushed")});
  } finally {await supervisor.close();}
});

it("applies the production count budget during the flip and keeps text references exact", async () => {
  const f=await fixture(); f.save(); f.at(130_000); f.save(); const pin=f.pins()[0]!, columns=Object.keys(pin);
  f.db.exec("BEGIN");
  const insert=f.db.prepare(`INSERT INTO sync_relay_history_pins (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
  for (let i=0;i<1024;i++) insert.run(...columns.map(c=>c === 'pin_id' ? `old-${i}` : c === 'superseded_at_ms' ? 120_000 : c === 'pinned_at_ms' ? i : pin[c]));
  f.db.exec("UPDATE sync_relay_replica_cut_text_refs SET ref_count=ref_count+1024");
  f.db.exec("COMMIT"); f.save();
  expect(f.pins()).toHaveLength(1025);
  expect(f.pins().some(p=>p.pin_id === pin.pin_id)).toBe(true);
  expect(f.db.prepare("SELECT ref_count FROM sync_relay_replica_cut_text_refs").all()).toEqual([{ref_count:1026}]);
  expect(f.storage.readReplicaCurrentViewFile({...f.input,path:"docs/a.md"})).toMatchObject({text:"initial"});
});

it("reads the pin, grant and current visibility in one snapshot across an external revoke", async () => {
  const f=await fixture(); f.save(); f.at(130_000); f.save(); const id=String(f.pins()[0]!.pin_id),view=f.latest;
  const source={currentReadView:()=>{
    f.db.exec("UPDATE sync_relay_share_grants SET status='revoked',generation=2,revoked_at_ms=140000 WHERE grant_id='g'");
    return {view};
  }};
  expect(f.storage.readReplicaHistoryPin({...f.input,pinId:id},source)).toMatchObject({status:"ready",text:"initial"});
  expect(f.read(id)).toEqual({status:"denied"});
});

it("does not turn an omitted text frame into a delete or reset an unchanged state's quiet clock", async () => {
  const f=await fixture(); f.save();
  f.at(120_000); f.save({...f.view(),files:[],texts:[],omitted:[{versionId:"main",objectId:"object",path:"docs/a.md",sha256:sha256("initial"),reason:"text-frame-limit"}]});
  expect(f.pins()).toHaveLength(0); expect(f.storage.nextReplicaHistoryPinAt("w")).toBeNull();
  f.at(130_000); f.save(f.view()); expect(f.pins()).toMatchObject([{reason:"quiet",pinned_at_ms:130_000}]);
  f.at(140_000); f.save({...f.view(),files:[],texts:[],omitted:[{versionId:"main",objectId:"object",path:"docs/a.md",sha256:sha256("initial"),reason:"text-frame-limit"}]});
  expect(f.pins()).toMatchObject([{reason:"quiet",superseded_at_ms:null}]);
});

it("does not duplicate the current pin or reset its clock after another grant purges the cut", async () => {
  const f=await fixture(); f.save(); f.at(130_000); f.save();
  f.storage.revokeShareGrant({shareId:"g",grantId:"g",revokedAtMs:140_000});
  f.at(160_000); f.save(); expect(f.storage.nextReplicaHistoryPinAt("w")).toBeNull();
  f.at(190_000); f.save(); expect(f.pins()).toHaveLength(1);
});

it("does not rewrite text bytes when references change", async () => {
  const f=await fixture();f.save();
  for(let i=1;i<=6;i++){
    f.at(100_000+i*300_000);f.save(f.view(`pin-${i}`));
    f.at(130_000+i*300_000);f.save();
  }
  f.db.exec(`CREATE TABLE text_writes(sha TEXT);
    CREATE TRIGGER record_text_write AFTER UPDATE ON sync_relay_replica_cut_texts BEGIN INSERT INTO text_writes VALUES(NEW.sha256); END`);
  f.at(2_200_000);f.save(f.view("last"));
  const writes=f.db.prepare("SELECT sha FROM text_writes ORDER BY sha").all();
  expect(writes).toEqual([]);
  expect(f.db.prepare("SELECT count(*) AS n FROM sync_relay_replica_cut_text_refs WHERE ref_count>0").get()).toMatchObject({n:7});
});

it("migrates a stored 6a cut without multiplying references by its text chunks", async () => {
  const f=await fixture(false),sha=sha256("old");
  for(const row of f.db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'replica_%'").all())
    f.db.exec(`DROP TRIGGER "${String(row.name).replaceAll('"','""')}"`);
  f.db.exec(`DROP TABLE sync_relay_history_pins; DROP TABLE sync_relay_history_clocks; DROP TABLE sync_relay_history_grant_floors;
    DROP INDEX replica_history_journal_position;
    DROP TABLE sync_relay_replica_cut_texts; DROP TABLE IF EXISTS sync_relay_replica_cut_text_refs;
    DELETE FROM sync_relay_migrations WHERE migration_id='replica-history-pins-v1'`);
  initializeReplicaCurrentViewSchema(f.db as unknown as SqliteDb);
  f.db.exec(`INSERT INTO sync_relay_replica_cuts VALUES ('w','e','s','legacy',1,1,0,0,'[]')`);
  const file=f.db.prepare("INSERT INTO sync_relay_replica_cut_files VALUES ('w','main',?,?,'text',?,3,NULL,NULL)");
  file.run("a","docs/a.md",sha);file.run("b","docs/b.md",sha);
  const text=f.db.prepare("INSERT INTO sync_relay_replica_cut_texts VALUES ('w',?,?,?,2)");
  text.run(sha,0,Buffer.from("o"));text.run(sha,1,Buffer.from("ld"));
  for(let restart=0;restart<2;restart++){
    f.restart();
    expect(f.db.prepare("SELECT sha256,ref_count FROM sync_relay_replica_cut_text_refs").all()).toEqual([{sha256:sha,ref_count:2}]);
    expect(f.db.prepare("PRAGMA table_info(sync_relay_replica_cut_texts)").all().map(r=>r.name)).not.toContain("ref_count");
    expect(f.storage.readReplicaCurrentViewText("w",sha)).toBe("old");
  }
});
