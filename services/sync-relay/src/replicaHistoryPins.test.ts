import {afterEach, expect, it, vi} from "vitest";
import type {ReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {createReplicaSupervisor} from "./replicaSupervisor";
import {initializeReplicaCurrentViewSchema} from "./storage/replicaCurrentViewSchema";
import type {SqliteDb} from "./storage/types";
import {closeTestStorage, closeTestStorages, inspectDatabase, reopenTestStorage, seedLinkGrant, sha256, storagePath, tempRoot, testStorage} from "./testing";

afterEach(async () => {vi.useRealTimers(); await closeTestStorages();});

it.each(["journal"])("History-only sampling keeps the carried state's %s entry after restart",async stream=>{
  const f=await fixture(false),lineage=sha256("lineage"),patch={lineageClaimId:lineage,restoreGeneration:1};
  f.db.exec(`INSERT INTO sync_relay_live_documents
    (workspace_id,main_version_id,object_id,lineage_claim_id,current_path,lineage_state,admission_state,restore_fence_generation,registered_at_ms,
    baseline_moment_relay_seq,baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes)
    VALUES ('w','main','object','${lineage}','docs/a.md','current','open',1,1,1,'${lineage}',0,'${lineage}',x'01')`);
  f.save(f.view("public",patch));
  const entered=replacementEvidence(f.db,stream);f.at(101_000);f.save(f.view("private paragraph",patch));
  const deleted=replacementEvidence(f.db,stream);f.db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2");
  f.at(102_000);f.save(f.view("public",patch));f.grant("late");f.restart();
  const header=f.db.prepare("SELECT * FROM sync_relay_replica_cuts").get();
  f.at(131_000);f.storage.sampleReplicaHistory(f.lease);
  expect(f.db.prepare("SELECT * FROM sync_relay_replica_cuts").get()).toEqual(header);
  expect(f.db.prepare("SELECT state_log_cursor,state_journal_cursor FROM sync_relay_history_clocks").get())
    .toEqual({state_log_cursor:stream==="log"?entered:0,state_journal_cursor:stream==="journal"?entered:0});
  const pin=f.pins()[0]!;expect(pin.reason).toBe("quiet");f.restart();
  replacementEvidence(f.db,stream);f.at(132_000);f.save(f.view("public",{...patch,restoreGeneration:2}));
  expect(f.read(String(pin.pin_id),{grantId:"late"})).toMatchObject({status:"ready"});
  expect(f.read(String(pin.pin_id))).toMatchObject({text:"private paragraph"});
  expect(f.pins().find(p=>p.pin_id===pin.pin_id)).toMatchObject(stream==="log"?
    {replaced_log_position:deleted}:{replaced_journal_position:deleted});
});

it("a persist error clears the pending view before reporting a failed restore flip",async()=>{
  const f=await fixture(false),lineage=sha256("lineage"),patch={lineageClaimId:lineage,restoreGeneration:1};
  f.db.exec(`INSERT INTO sync_relay_live_documents
    (workspace_id,main_version_id,object_id,lineage_claim_id,current_path,lineage_state,admission_state,restore_fence_generation,registered_at_ms,
    baseline_moment_relay_seq,baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes)
    VALUES ('w','main','object','${lineage}','docs/a.md','current','open',1,1,1,'${lineage}',0,'${lineage}',x'01')`);
  f.save(f.view("public",patch));replacementEvidence(f.db,"log");f.at(101_000);f.save(f.view("private paragraph",patch));
  f.at(131_000);f.storage.sampleReplicaHistory(f.lease);const pin=String(f.pins()[0]!.pin_id);
  replacementEvidence(f.db,"log");f.db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2");
  f.at(132_000);f.save(f.view("public",patch));f.grant("late");
  replacementEvidence(f.db,"log");const incoming=f.view("public",{...patch,restoreGeneration:2});
  const failure=new Error("injected flip failure"),observed:Array<{error:unknown;read:unknown;view:unknown}>=[];
  vi.spyOn(f.storage,"flipReplicaCurrentView").mockImplementation(()=>{throw failure;});
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("history-persist-failure"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...incoming,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})}),
    onError:(_workspace,error)=>observed.push({error,view:supervisor.currentReadView("w")?.view,
      read:f.storage.readReplicaHistoryPin({...f.input,grantId:"late",pinId:pin},supervisor)})});
  try {
    await expect(supervisor.activate("w")).rejects.toThrow(failure);
    expect(observed[0]?.error).toBe(failure);
    expect(observed[0]?.read).toEqual({status:"not-found"});
    expect(observed[0]?.view).toMatchObject({logCursor:2,files:[{sha256:sha256("private paragraph"),restoreGeneration:1}]});
    expect(f.db.prepare("SELECT superseded_at_ms FROM sync_relay_history_pins WHERE pin_id=?").get(pin))
      .toEqual({superseded_at_ms:null});
  } finally {await supervisor.close();vi.restoreAllMocks();}
});

it("Undo raises the restored grant floor past private edits made during removal",async()=>{
  const f=await fixture();f.save();
  const removal=f.storage.removeShareAccess({shareId:"g",grantId:"g",actorUserId:"owner",nowMs:100_000});
  if(!removal.ok || !removal.undo)throw Error("removal failed");
  f.save(f.view("public"));replacementEvidence(f.db,"log");f.at(101_000);f.save(f.view("private paragraph"));
  f.at(131_000);f.save();const id=String(f.pins().find(p=>p.sha256===sha256("private paragraph"))!.pin_id);
  replacementEvidence(f.db,"log");f.at(132_000);f.save(f.view("public"));
  f.storage.undoShareRemoval({shareId:"g",actorUserId:"owner",undoId:removal.undo.undoId,nowMs:133_000});
  f.save();
  expect(f.read(id,{generation:3})).toMatchObject({status:"ready"});
  expect(f.read(id,{grantId:"wide"})).toMatchObject({text:"private paragraph"});
});

it("upgrade removes orphan current pins but retains omitted and superseded pins",async()=>{
  const f=await fixture();f.save();f.at(130_000);f.save();
  const original=String(f.pins()[0]!.pin_id);
  f.db.exec(`ALTER TABLE sync_relay_replica_cuts ADD COLUMN omitted_json TEXT NOT NULL DEFAULT '[]';
    DROP TABLE sync_relay_replica_cut_omitted; DELETE FROM sync_relay_migrations WHERE migration_id='replica-current-incremental-v1';
    DROP TRIGGER replica_history_usage_insert; DROP TRIGGER replica_history_usage_delete;
    DROP TRIGGER replica_history_usage_update; DROP TRIGGER replica_history_identity_floor;
    DROP TABLE sync_relay_history_pin_usage; DROP INDEX replica_history_due;
    DROP INDEX IF EXISTS replica_history_log_clock; DROP INDEX IF EXISTS replica_history_journal_clock;
    DROP INDEX replica_history_current_pin;
    DELETE FROM sync_relay_migrations WHERE migration_id='replica-history-incremental-v1';
    DROP TRIGGER replica_current_view_grant_update;
    CREATE TRIGGER replica_current_view_grant_update AFTER UPDATE ON sync_relay_share_grants BEGIN
      DELETE FROM sync_relay_replica_cuts WHERE workspace_id=(SELECT workspace_id FROM sync_relay_shares WHERE share_id=NEW.share_id);
    END;
    INSERT INTO sync_relay_history_pins SELECT 'omitted',workspace_id,version_id,'omitted',path,content_kind,sha256,byte_length,
      lineage_claim_id,restore_generation,reason,pinned_at_ms,NULL,log_cursor,journal_cursor,authors_json,NULL,NULL FROM sync_relay_history_pins;
    INSERT INTO sync_relay_history_pins SELECT 'superseded',workspace_id,version_id,'past',path,content_kind,sha256,byte_length,
      lineage_claim_id,restore_generation,reason,pinned_at_ms,130000,log_cursor,journal_cursor,authors_json,NULL,NULL FROM sync_relay_history_pins WHERE pin_id='${original}';
    UPDATE sync_relay_replica_cut_text_refs SET ref_count=ref_count+2;
    UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=130000 WHERE grant_id='g';
    INSERT INTO sync_relay_replica_cuts VALUES ('w','e','s','old',1,1,0,0,
      '[{"versionId":"main","objectId":"omitted","path":"docs/omitted.md","sha256":"${sha256("initial")}","reason":"text-frame-limit"}]')`);
  f.restart();
  expect(f.pins().map(p=>p.pin_id).sort()).toEqual(["omitted","superseded"]);
  expect(f.db.prepare("SELECT ref_count FROM sync_relay_replica_cut_text_refs").get()).toEqual({ref_count:2});
  f.save(f.view());f.at(160_000);f.storage.sampleReplicaHistory(f.lease);
  expect(f.pins().filter(p=>p.object_id==="object" && p.superseded_at_ms===null)).toHaveLength(1);
  replacementEvidence(f.db,"log");f.grant("late");f.save(f.view("final"));
  const pin=f.pins().find(p=>p.object_id==="object")!;
  expect(f.read(String(pin.pin_id),{grantId:"late"})).toMatchObject({status:"ready"});
  f.restart();expect(f.pins().some(p=>p.pin_id===original)).toBe(false);
});

it.each(["g"])("surviving share retains current text and pins after %s ends",async ending=>{
  const f=await fixture();f.save();f.at(130_000);f.save();const pin=String(f.pins()[0]!.pin_id);
  const survivor=ending==="g"?"wide":"g";
  f.storage.revokeShareGrant({shareId:ending,grantId:ending,revokedAtMs:140_000});
  expect(f.storage.readReplicaCurrentViewFile({...f.input,grantId:survivor,path:"docs/a.md"})).toMatchObject({status:"ready",text:"initial"});
  expect(f.read(pin,{grantId:survivor})).toMatchObject({status:"ready",text:"initial"});
  expect(f.db.prepare("SELECT ref_count FROM sync_relay_replica_cut_text_refs WHERE sha256=?").get(sha256("initial"))).toMatchObject({ref_count:2});
  f.restart();expect(f.read(pin,{grantId:survivor})).toMatchObject({text:"initial"});
  f.storage.revokeShareGrant({shareId:survivor,grantId:survivor,revokedAtMs:150_000});
  for(const table of ["replica_cuts","history_pins","history_clocks","replica_cut_texts","replica_cut_text_refs"])
    expect(f.db.prepare(`SELECT count(*) AS n FROM sync_relay_${table}`).get()).toMatchObject({n:0});
});

it("upgrades existing pins, clocks and stale floors once without resetting matching floors",async()=>{
  const f=await fixture(); f.save(); f.at(130_000); f.save();
  const pin=String(f.pins()[0]!.pin_id);
  replacementEvidence(f.db,"log"); f.at(140_000); f.save(f.view("next"));
  // Recreate the previous migration's grant trigger and remove only this migration's schema.
  f.db.exec(`ALTER TABLE sync_relay_replica_cuts ADD COLUMN omitted_json TEXT NOT NULL DEFAULT '[]';
    DROP TABLE sync_relay_replica_cut_omitted; DELETE FROM sync_relay_migrations WHERE migration_id='replica-current-incremental-v1';
    DROP TRIGGER replica_current_view_grant_update;
    CREATE TRIGGER replica_current_view_grant_update AFTER UPDATE ON sync_relay_share_grants BEGIN
      DELETE FROM sync_relay_replica_cuts WHERE workspace_id=(SELECT workspace_id FROM sync_relay_shares WHERE share_id=NEW.share_id);
    END;
    DROP TRIGGER replica_history_usage_insert; DROP TRIGGER replica_history_usage_delete;
    DROP TRIGGER replica_history_usage_update; DROP TRIGGER replica_history_identity_floor;
    DROP TABLE sync_relay_history_pin_usage;
    DROP INDEX replica_history_due;
    DROP INDEX replica_history_current_pin;
    UPDATE sync_relay_history_grant_floors SET replication_epoch='previous' WHERE grant_id='g';
    DELETE FROM sync_relay_migrations WHERE migration_id='replica-history-incremental-v1'`);
  f.restart();
  expect(f.db.prepare("SELECT * FROM sync_relay_history_pin_usage").get()).toMatchObject({pin_count:1});
  expect(f.db.prepare("SELECT log_floor FROM sync_relay_history_grant_floors WHERE grant_id='g'").get()).toEqual({log_floor:1});
  expect(f.db.prepare("SELECT log_floor FROM sync_relay_history_grant_floors WHERE grant_id='wide'").get()).toEqual({log_floor:0});
  expect(f.read(pin)).toMatchObject({status:"ready"});
  expect(f.read(pin,{grantId:"wide"})).toMatchObject({text:"initial"});
  f.storage.revokeShareGrant({shareId:"g",grantId:"g",revokedAtMs:140_000});
  expect(f.read(pin,{grantId:"wide"})).toMatchObject({text:"initial"});
  expect(f.storage.readReplicaCurrentViewFile({...f.input,grantId:"wide",path:"docs/a.md"})).toMatchObject({text:"next"});
  f.restart(); expect(f.storage.nextReplicaHistoryPinAt("w")).toBe(170_000);
  f.at(170_000); f.storage.sampleReplicaHistory(f.lease);
  expect(f.pins().find(p=>p.sha256===sha256("next"))).toMatchObject({reason:"quiet"});
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

it("captures link and redeemed dependent floors in their grant transactions and rolls them back",async()=>{
  const f=await fixture();f.save();f.at(130_000);f.save();const id=String(f.pins()[0]!.pin_id);
  const log=replacementEvidence(f.db,"log"),journal=replacementEvidence(f.db,"journal","other-object");
  seedLinkGrant(f.storage,{shareId:"g",grantId:"link-floor",secretSealed: null, secretHash:"hash"});
  expect(f.storage.mintLinkHandoffCode({code:{codeId:"code",codeHash:"code-hash",grantId:"link-floor",generation:1,
    mintedAtMs:10,expiresAtMs:100},guard:()=>true})).toBe(true);
  expect(f.storage.redeemLinkHandoffCode({codeHash:"code-hash",principalUserId:"reader",redeemedAtMs:20,
    mintGrantId:()=>"dependent-floor",guard:()=>true})).toMatchObject({ok:true});
  for(const id of ["link-floor","dependent-floor"])
    expect(f.db.prepare("SELECT * FROM sync_relay_history_grant_floors WHERE grant_id=?").get(id))
      .toMatchObject({workspace_id:"w",replication_epoch:"e",stream_identity:"s",log_floor:log,journal_floor:journal});
  f.save(f.view("public"));
  expect(f.read(id,{grantId:"link-floor",principal:{kind:"link",requireSession(){return {grantId:"link-floor",generation:1};}}})).toEqual({status:"denied"});
  expect(f.read(id,{grantId:"dependent-floor"})).toEqual({status:"denied"});
  expect(f.read(id)).toMatchObject({text:"initial"});
  f.db.exec(`CREATE TRIGGER reject_credential BEFORE INSERT ON sync_relay_link_credentials BEGIN SELECT RAISE(ABORT,'refuse'); END`);
  expect(()=>f.storage.createLinkGrant({grant:{...f.storage.getShareGrant("link-floor")!,grantId:"rolled-back"},
    credential:{credentialId:"reject",grantId:"rolled-back",secretSealed: null, secretHash:"reject",generation:1,mintedAtMs:10,retiredAtMs:null}})).toThrow("refuse");
  expect(f.db.prepare("SELECT * FROM sync_relay_history_grant_floors WHERE grant_id='rolled-back'").get()).toBeUndefined();
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
  return {get storage(){return storage;},get lease(){return lease;},db,grant,file,view,save,pins,list,read,input,at,restart,get latest(){return latest;}};
}

it("pins after 30 seconds quiet, never turns every cut into History", async () => {
  const f = await fixture(); f.save(); expect(f.pins()).toHaveLength(0);
  f.at(129_999); f.save(); expect(f.pins()).toHaveLength(0);
  f.at(130_000); f.save(); expect(f.pins()).toMatchObject([{reason:"quiet",superseded_at_ms:null}]);
  f.at(160_000); f.save(); expect(f.pins()).toHaveLength(1);
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
  const f = await fixture(); seedLinkGrant(f.storage,{shareId:"g",grantId:"link",secretSealed: null, secretHash:"hash",access:"edit"});
  f.save(); f.at(130_000); f.save(); const id = String(f.pins()[0]!.pin_id);
  const input = {grantId:"link",principal:{kind:"link" as const,requireSession(){return {grantId:"link",generation:1};}}};
  expect(f.storage.retuneShareGrant({shareId:"g",grantId:"link",access:"view",changedAtMs:140_000,expectedDependentGrantIds:[],guard(){}}).ok).toBe(true);
  expect(f.read(id,input)).toEqual({status:"denied"});
  expect(f.storage.retuneShareGrant({shareId:"g",grantId:"link",access:"edit",changedAtMs:150_000,expectedDependentGrantIds:[],guard(){},
    mintCredential:()=>({credentialId:"widened",secretSealed: null, secretHash:"new-hash"})}).ok).toBe(true);
  expect(f.read(id,input)).toEqual({status:"denied"}); expect(f.read(id,{...input,generation:2,principal:{kind:"link",requireSession:()=>({grantId:"link",generation:2})}})).toMatchObject({status:"ready"});
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

it("accountless History projects paths and omits authors, without internal cursors", async () => {
  const f = await fixture(false); f.grant("project",["private/docs"]);
  seedLinkGrant(f.storage,{shareId:"project",grantId:"link",secretSealed: null, secretHash:"hash",access:"edit"});
  f.save(f.view("baseline",{path:"private/docs/a.md"}));
  f.save(f.view("initial",{path:"private/docs/a.md"})); f.at(130_000); f.save(); const id = String(f.pins()[0]!.pin_id);
  f.db.prepare("UPDATE sync_relay_history_pins SET authors_json=?").run('[{"kind":"human","humanId":"owner","humanName":"Owner"}]');
  const result = f.read(id,{grantId:"link",principal:{kind:"link",requireSession(){return {grantId:"link",generation:1};}}});
  expect(result).toMatchObject({status:"ready",pin:{path:"docs/a.md",authors:[]},text:"initial"});
  const listed = f.list({grantId:"link",principal:{kind:"link",requireSession(){return {grantId:"link",generation:1};}}});
  expect(listed).toMatchObject({status:"ready",pins:[{path:"docs/a.md",authors:[]}]});
  for (const key of ["logCursor","journalCursor","log_cursor","journal_cursor","cut_seq"]) expect(JSON.stringify([result,listed])).not.toContain(key);
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

it("rolls a pin and its clock back with a refused cut flip", async () => {
  const f = await fixture(); f.save(); f.at(130_000);
  f.db.exec("CREATE TRIGGER reject_flip BEFORE UPDATE ON sync_relay_replica_cuts BEGIN SELECT RAISE(ABORT,'test flip refusal'); END");
  expect(()=>f.save()).toThrow("test flip refusal"); expect(f.pins()).toHaveLength(0);
  f.db.exec("DROP TRIGGER reject_flip"); f.save(); expect(f.pins()).toMatchObject([{reason:"quiet",pinned_at_ms:130_000}]);
});

it("pins an unflushed pre-restore head even after the relay raises its generation fence", async () => {
  const f = await fixture(), lineage=sha256("restore-live");
  f.db.exec(`INSERT INTO sync_relay_live_documents
    (workspace_id,main_version_id,object_id,lineage_claim_id,current_path,lineage_state,admission_state,restore_fence_generation,registered_at_ms,
    baseline_moment_relay_seq,baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes)
    VALUES ('w','main','object','${lineage}','docs/a.md','current','open',1,1,1,'${lineage}',0,'${lineage}',x'01')`);
  let latest=f.view("initial",{lineageClaimId:lineage,restoreGeneration:1});
  const supervisor=createReplicaSupervisor({storage:f.storage,storeRoot:await tempRoot("history-restore"),
    startChild:async()=>({pull:async()=>{},close:async()=>{},currentView:async()=>({...latest,delta:false,removed:[],moved:false,nextCursor:null,refusedFiles:[]})})});
  try {
    await supervisor.activate("w"); latest=f.view("unflushed",{lineageClaimId:lineage,restoreGeneration:1}); await supervisor.activate("w");
    f.at(101_000); f.db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2");
    latest=f.view("restored",{lineageClaimId:lineage,restoreGeneration:2}); await supervisor.activate("w");
    expect(f.pins().find(p=>p.reason === "restore")).toMatchObject({sha256:sha256("unflushed")});
  } finally {await supervisor.close();}
});

it("migrates a stored 6a cut without multiplying references by its text chunks", async () => {
  const f=await fixture(false),sha=sha256("old");
  for(const row of f.db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'replica_%'").all())
    f.db.exec(`DROP TRIGGER "${String(row.name).replaceAll('"','""')}"`);
  f.db.exec(`ALTER TABLE sync_relay_replica_cuts ADD COLUMN omitted_json TEXT NOT NULL DEFAULT '[]';
    DROP TABLE sync_relay_replica_cut_omitted; DELETE FROM sync_relay_migrations WHERE migration_id='replica-current-incremental-v1';
    DROP TABLE sync_relay_history_pins; DROP TABLE sync_relay_history_clocks; DROP TABLE sync_relay_history_grant_floors;
    DROP TABLE sync_relay_history_pin_usage;
    DROP INDEX replica_history_journal_position;
    DROP TABLE sync_relay_replica_cut_texts; DROP TABLE IF EXISTS sync_relay_replica_cut_text_refs;
    DELETE FROM sync_relay_migrations WHERE migration_id IN ('replica-history-pins-v1','replica-history-incremental-v1')`);
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
