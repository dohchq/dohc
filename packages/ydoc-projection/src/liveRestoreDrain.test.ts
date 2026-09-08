import { afterEach, expect, it } from "vitest";
import { registered, host, cleanupLiveDeliveryFixtures } from "./liveCommittedDeliveryTestSupport.js";
import { createLiveJournalHistoryAuthority } from "../../../services/sync-relay/src/storage/liveJournalHistory.js";
import { beginStopRestore, advanceStopRestoreFence, readStopRestore, type StopRestoreIntent } from "../../../services/sync-relay/src/storage/liveRestoreOperation.js";
import type { StorageContext } from "../../../services/sync-relay/src/storage/context.js";
import type { StopRestoreCutCapture, CommittedBootstrap } from "../../../services/sync-relay/src/storage/liveCommittedDelivery.js";
import { openSyncRelayStorage } from "../../../services/sync-relay/src/storage.js";

afterEach(cleanupLiveDeliveryFixtures);
function fixture(kind: "bootstrap" | "owner" = "bootstrap",mode: "service" | "device" = "device") {
  const coordinate = {...host,mode}, f = registered({host: coordinate}), context = f.storage as StorageContext;
  const history = createLiveJournalHistoryAuthority({namespace: "restore-test",reconciled: true});
  const store = f.storage.createLiveCommittedDeliveryStore(history), document = f.input.evidence.document;
  const intent: StopRestoreIntent = {deliveryKind: kind,operationId: "restore",ownerUserId: "owner",document,
    shareId: "share",grantId: "grant",expectedGrantGeneration: 4,expectedDependentGrantIds: [],expectedFence: 1,
    restorePointCursor: 0,restorePointReceiptDigest: document.lineageClaimId};
  const lookup = {operationId: "restore",workspaceId: "workspace",ownerUserId: "owner",host: coordinate};
  const add = (id: string) => {const result=f.storage.commitLiveUpdateJournal(f.capture(f.update(id,id),id)).result; if(result.kind!=="accepted")throw Error(result.kind); return result.receipt;};
  const fence = () => {beginStopRestore(context,intent,40); return advanceStopRestoreFence(context,lookup,50);};
  const open = () => {const result=store.openStopRestoreCut(lookup); if(result.kind!=="ready")throw Error(result.kind);return result.capture;};
  const adopt = () => {
    const cut=store.captureOwnerCut({host: coordinate,document,actor: f.actor,adoptionId: "adoption",expectedLocalSequence: 0,maxBytes: 1_000_000,maxEvents: 10});
    store.acknowledgeOwnerAdoption(cut,{adoptionId: "adoption",localYDocSequence: 0,terminalCursor: cut.cut.terminalReceipt?.journalCursor ?? 0,adoptionReplayed: false});
  };
  return {...f,coordinate,context,history,store,document,intent,lookup,add,fence,open,adopt};
}
const bootstrapAck=(b: CommittedBootstrap)=>({bootstrapId:b.bootstrapId,bootstrapMomentId:b.bootstrapMomentId,
  baselineDigest:b.baselineDigest,baselineMomentRelaySequence:b.baselineMomentRelaySequence,localYDocSequence:0,bootstrapReplayed:false});
const applicationAck=(receipt: ReturnType<ReturnType<typeof fixture>["add"]>,sequence=1)=>({...receipt,localYDocSequence:sequence,applicationReplayed:false});

it.each(["service","device"] as const)("drains exact original bytes after fencing %s and retires all apply captures",mode=>{
  const f=fixture("bootstrap",mode);
  try {
    const one=f.add("one"), two=f.add("two"), original=f.journalRows().journal;
    const ordinary=f.store.open({host:f.coordinate,document:f.document});
    f.fence();
    expect(()=>f.store.next(ordinary)).toThrow();
    expect(()=>f.store.open({host:f.coordinate,document:f.document})).toThrow();
    const capture=f.open(), stale=f.open();
    expect(()=>f.store.completeStopRestoreCut(capture)).toThrow();
    const first=f.store.nextStopRestoreCut(capture);expect(first.kind).toBe("bootstrap");
    if(first.kind!=="bootstrap")throw Error();
    f.store.acknowledgeStopRestoreBootstrap(capture,bootstrapAck(first.baseline));
    for(const [index,receipt] of [one,two].entries()) {
      const step=f.store.nextStopRestoreCut(capture);expect(step.kind).toBe("next");if(step.kind!=="next")throw Error();
      expect(step.admitted.metadata.accepted.receipt).toEqual(receipt);
      expect(step.admitted.updateBytes).toEqual(original[index]!.update_bytes);
      expect(()=>f.store.acknowledgeStopRestoreApplication(capture,step.predecessor,{...applicationAck(receipt),updateDigest:"f".repeat(64)})).toThrow();
      f.store.acknowledgeStopRestoreApplication(capture,step.predecessor,applicationAck(receipt,index+1));
      f.store.acknowledgeStopRestoreApplication(capture,step.predecessor,applicationAck(receipt,index+1));
    }
    const usage=f.journalRows().usage, completed=f.store.completeStopRestoreCut(capture);
    expect(completed).toMatchObject({kind:"bootstrap",terminal:two,localYDocSequence:2});
    expect(f.store.completeStopRestoreCut(capture)).toEqual(completed);
    expect(f.store.openStopRestoreCut(f.lookup)).toEqual({kind:"complete",receipt:completed});
    expect(()=>f.store.nextStopRestoreCut(stale)).toThrow();
    expect(()=>f.store.acknowledgeStopRestoreApplication(capture,one,applicationAck(two,2))).toThrow();
    expect(f.journalRows().usage).toBe(usage);
    expect(f.journalRows().journal).toEqual(original);
    expect(readStopRestore(f.context,f.lookup)?.phase).toBe("old-cut-applied");
  }finally{f.close();}
});

it.each(["bootstrap","owner"] as const)("requires durable %s acknowledgement even for an empty cut",kind=>{
  const f=fixture(kind);
  try{
    if(kind==="owner")f.adopt();
    f.fence();const capture=f.open();
    if(kind==="bootstrap") {
      expect(()=>f.store.completeStopRestoreCut(capture)).toThrow();
      const step=f.store.nextStopRestoreCut(capture);if(step.kind!=="bootstrap")throw Error();
      f.store.acknowledgeStopRestoreBootstrap(capture,bootstrapAck(step.baseline));
    }
    expect(f.store.completeStopRestoreCut(capture)).toMatchObject({kind,terminal:null,localYDocSequence:0});
  }finally{f.close();}
});

it("keeps an unadopted owner waiting and refuses a different delivery kind on replay",()=>{
  const f=fixture("owner");
  try{
    f.fence();expect(f.store.openStopRestoreCut(f.lookup)).toEqual({kind:"waiting"});
    expect(()=>beginStopRestore(f.context,{...f.intent,deliveryKind:"bootstrap"},60)).toThrow();
    expect(()=>f.adopt()).toThrow();
    expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_delivery_bootstraps").get()!.n).toBe(0);
  }finally{f.close();}
});

it("uses existing owner progress and never bootstraps over its document",()=>{
  const f=fixture("owner");
  try{
    f.adopt();const one=f.add("one"),two=f.add("two");
    const ordinary=f.store.openOwnerDelivery({host:f.coordinate,document:f.document,actor:f.actor});
    f.store.acknowledgeOwnerDeliveryApplication(ordinary,applicationAck(one,1));
    f.fence();expect(()=>f.store.nextOwnerApplication(ordinary)).toThrow();
    const capture=f.open(),step=f.store.nextStopRestoreCut(capture);expect(step.kind).toBe("next");if(step.kind!=="next")throw Error();
    expect(step.predecessor).toEqual(one);expect(step.admitted.metadata.accepted.receipt).toEqual(two);
    f.store.acknowledgeStopRestoreApplication(capture,one,applicationAck(two,2));
    expect(f.store.completeStopRestoreCut(capture)).toMatchObject({kind:"owner",sourceId:"adoption",terminal:two});
    expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_delivery_bootstraps").get()!.n).toBe(0);
  }finally{f.close();}
});

it("refuses bootstrap initiation when a durable owner origin already exists",()=>{
  const f=fixture();try{f.adopt();expect(()=>f.fence()).toThrow();expect(f.storage.getShareGrant("grant")?.status).toBe("active");}finally{f.close();}
});

it("refuses an existing owner origin with a different share binding before revocation",()=>{
  const f=fixture("owner");try{
    f.adopt();
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('other-share','workspace','owner',?,0)")
      .run(JSON.stringify({paths:["docs/a.md"],versionId:null}));
    f.raw.exec("INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES ('other-grant','other-share','user','other-reader',NULL,'edit',4,'active',0,NULL,NULL)");
    const intent={...f.intent,shareId:"other-share",grantId:"other-grant"};
    const before={usage:f.journalRows().usage,owner:f.raw.prepare("SELECT * FROM sync_relay_live_delivery_owners").all()};
    expect(()=>beginStopRestore(f.context,intent,40)).toThrow();
    expect(f.storage.getShareGrant("other-grant")?.status).toBe("active");
    expect(f.storage.getShareGrant("grant")?.status).toBe("active");
    expect(readStopRestore(f.context,f.lookup)).toBeNull();
    expect(f.raw.prepare("SELECT admission_state,restore_fence_generation FROM sync_relay_live_documents").get()).toEqual({admission_state:"open",restore_fence_generation:1});
    expect({usage:f.journalRows().usage,owner:f.raw.prepare("SELECT * FROM sync_relay_live_delivery_owners").all()}).toEqual(before);
  }finally{f.close();}
});

it.each(["relayDatabaseNamespace","sourceMomentId","sourceDigest","sourceByteLength","baselineMomentRelaySequence","baselineRegisteredAtMs"])("refuses incompatible existing owner %s before revocation",field=>{
  const f=fixture("owner");try{
    f.adopt();const row=f.raw.prepare("SELECT origin_json FROM sync_relay_live_delivery_owners").get()!;
    const origin=JSON.parse(String(row.origin_json));origin[field]=typeof origin[field]==="number"?origin[field]+1:"different";
    f.raw.prepare("UPDATE sync_relay_live_delivery_owners SET origin_json=?").run(JSON.stringify(origin));
    const usage=f.journalRows().usage;
    expect(()=>beginStopRestore(f.context,f.intent,40)).toThrow();
    expect(f.storage.getShareGrant("grant")?.status).toBe("active");
    expect(readStopRestore(f.context,f.lookup)).toBeNull();
    expect(f.journalRows().usage).toBe(usage);
    expect(f.raw.prepare("SELECT admission_state,restore_fence_generation FROM sync_relay_live_documents").get()).toEqual({admission_state:"open",restore_fence_generation:1});
  }finally{f.close();}
});

it.each(["owner","selector","baseline","registration","host","path"])("refuses %s drift before allocating the fence",damage=>{
  const f=fixture();try{
    beginStopRestore(f.context,f.intent,40);
    const sql={owner:"UPDATE sync_relay_workspaces SET owner_user_id='other'",selector:"UPDATE sync_relay_shares SET selector_json='{"+"\"paths\":[\"docs/a.md\"],\"versionId\":null}'",
      baseline:"UPDATE sync_relay_live_documents SET baseline_projected_sha256='"+"f".repeat(64)+"'",registration:"UPDATE sync_relay_live_documents SET registered_at_ms=11",
      host:"UPDATE sync_relay_session_host_control SET configured_host_id='other'",path:"UPDATE sync_relay_live_documents SET current_path='docs/renamed.md'"}[damage]!;
    f.raw.exec(sql);expect(()=>advanceStopRestoreFence(f.context,f.lookup,50)).toThrow();
    expect(f.raw.prepare("SELECT admission_state,restore_fence_generation FROM sync_relay_live_documents").get()).toMatchObject({admission_state:"open",restore_fence_generation:1});
  }finally{f.close();}
});

it.each(["owner","namespace","host","phase"])("rechecks %s for every continuation",damage=>{
  const f=fixture();try{
    f.fence();const capture=f.open();
    if(damage==="owner")f.raw.exec("UPDATE sync_relay_workspaces SET owner_user_id='other'");
    if(damage==="namespace")f.history.markUnreconciled();
    if(damage==="host")f.raw.exec("UPDATE sync_relay_session_host_control SET registered_connection_id='other'");
    if(damage==="phase")f.raw.exec("UPDATE sync_relay_live_documents SET admission_state='open'");
    expect(()=>f.store.nextStopRestoreCut(capture)).toThrow();expect(()=>f.store.completeStopRestoreCut(capture)).toThrow();
  }finally{f.close();}
});

for(const action of ["bootstrap-next","bootstrap-origin-ack","bootstrap-update-ack","bootstrap-complete","owner-next","owner-update-ack","owner-complete"] as const) {
  it.each(["owner","host","baseline","phase"])(`${action} refuses %s drift at its inner authority check`,damage=>{
    const kind=action.startsWith("owner")?"owner":"bootstrap",f=fixture(kind);
    try{
      if(kind==="owner")f.adopt();const terminal=f.add("one");f.fence();const capture=f.open();
      const first=f.store.nextStopRestoreCut(capture);
      if(first.kind==="bootstrap" && action!=="bootstrap-origin-ack")f.store.acknowledgeStopRestoreBootstrap(capture,bootstrapAck(first.baseline));
      if(action.endsWith("complete"))f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(terminal));
      const invoke=()=>{
        if(action.endsWith("next"))return f.store.nextStopRestoreCut(capture);
        if(action==="bootstrap-origin-ack") {if(first.kind!=="bootstrap")throw Error("missing baseline");return f.store.acknowledgeStopRestoreBootstrap(capture,bootstrapAck(first.baseline));}
        if(action.endsWith("update-ack"))return f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(terminal));
        return f.store.completeStopRestoreCut(capture);
      };
      if(damage==="owner")f.raw.exec("UPDATE sync_relay_workspaces SET owner_user_id='other'");
      if(damage==="host")f.raw.exec("UPDATE sync_relay_session_host_control SET registered_connection_id='other'");
      if(damage==="baseline")f.raw.exec("UPDATE sync_relay_live_documents SET baseline_bytes=X'00'");
      if(damage==="phase")f.raw.exec("UPDATE sync_relay_live_documents SET admission_state='open'");
      const usage=f.journalRows().usage;
      expect(invoke).toThrow();
      expect(f.journalRows().usage).toBe(usage);
      expect(f.raw.prepare("SELECT phase FROM sync_relay_live_restore_operations").get()?.phase).toBe("fenced");
    }finally{f.close();}
  });
}

it("rejects forged captures and changed returned bindings",()=>{
  const f=fixture();try{
    f.fence();const capture=f.open(),copy={...capture} as StopRestoreCutCapture;
    expect(()=>f.store.nextStopRestoreCut(copy)).toThrow();
    Object.assign(capture.binding,{currentPath:"other.md"});
    expect(f.store.nextStopRestoreCut(capture)).toMatchObject({kind:"bootstrap",baseline:{binding:{currentPath:"docs/a.md"}}});
  }finally{f.close();}
});

it.each(["bootstrap","owner"] as const)("resumes %s after relay ACK with lost reply and completion reopen",kind=>{
  const f=fixture(kind);let reopened:ReturnType<typeof openSyncRelayStorage>|undefined;let closed=false;
  try{
    if(kind==="owner")f.adopt();
    const terminal=f.add("one");f.fence();const capture=f.open();
    const first=f.store.nextStopRestoreCut(capture);
    if(first.kind==="bootstrap")f.store.acknowledgeStopRestoreBootstrap(capture,bootstrapAck(first.baseline));
    f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(terminal,1));
    f.close();closed=true;
    const connect=()=>{reopened=openSyncRelayStorage(f.path);return reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace:"restore-test",reconciled:true}));};
    let store=connect(),opened=store.openStopRestoreCut(f.lookup);if(opened.kind!=="ready")throw Error(opened.kind);
    expect(store.nextStopRestoreCut(opened.capture)).toMatchObject({kind:"done",terminalReceipt:terminal});
    const completed=store.completeStopRestoreCut(opened.capture);
    reopened!.close();reopened=undefined;
    store=connect();expect(store.openStopRestoreCut(f.lookup)).toEqual({kind:"complete",receipt:completed});
    expect(()=>store.openStopRestoreCut({...f.lookup,ownerUserId:"other"})).toThrow();
  }finally{if(!closed)f.close();reopened?.close();}
});

it("requires the original namespace after a process reopen",()=>{
  const f=fixture();let reopened:ReturnType<typeof openSyncRelayStorage>|undefined;let closed=false;
  try{f.fence();f.close();closed=true;reopened=openSyncRelayStorage(f.path);
    const store=reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace:"foreign",reconciled:true}));
    expect(()=>store.openStopRestoreCut(f.lookup)).toThrow();
  }finally{if(!closed)f.close();reopened?.close();}
});

it.each(["bootstrap","owner"] as const)("finishes precharged %s receipts with exhausted workspace quota",kind=>{
  const f=fixture(kind);try{
    if(kind==="owner")f.adopt();const terminal=f.add("one");f.fence();
    f.raw.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=? WHERE workspace_id='workspace'").run(f.context.options.workspaceQuotaBytes);
    const capture=f.open(),first=f.store.nextStopRestoreCut(capture);
    if(first.kind==="bootstrap")f.store.acknowledgeStopRestoreBootstrap(capture,bootstrapAck(first.baseline));
    f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(terminal,1));
    const before=f.journalRows().usage;f.store.completeStopRestoreCut(capture);expect(f.journalRows().usage).toBe(before);
  }finally{f.close();}
});

it("uses document receipt order across gaps in the global journal cursor",()=>{
  const f=fixture();try{
    const one=f.add("one");f.raw.exec("UPDATE sqlite_sequence SET seq=9 WHERE name='sync_relay_live_update_journal'");const two=f.add("two");
    expect(two.journalCursor).toBe(10);f.fence();const capture=f.open(),first=f.store.nextStopRestoreCut(capture);if(first.kind!=="bootstrap")throw Error();
    f.store.acknowledgeStopRestoreBootstrap(capture,bootstrapAck(first.baseline));
    expect(()=>f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(two,2))).toThrow();
    f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(one,1));
    expect(f.store.nextStopRestoreCut(capture)).toMatchObject({kind:"next",predecessor:one,admitted:{metadata:{accepted:{receipt:two}}}});
    f.store.acknowledgeStopRestoreApplication(capture,one,applicationAck(two,2));expect(f.store.completeStopRestoreCut(capture).terminal).toEqual(two);
  }finally{f.close();}
});

it("rolls back an ignored completion and refuses journal rows beyond the saved cut",()=>{
  const f=fixture();try{
    const terminal=f.add("one");f.fence();const capture=f.open(),first=f.store.nextStopRestoreCut(capture);if(first.kind!=="bootstrap")throw Error();
    f.store.acknowledgeStopRestoreBootstrap(capture,bootstrapAck(first.baseline));f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(terminal));
    f.raw.exec("CREATE TRIGGER ignore_completion BEFORE UPDATE ON sync_relay_live_restore_operations BEGIN SELECT RAISE(IGNORE); END");
    expect(()=>f.store.completeStopRestoreCut(capture)).toThrow();expect(readStopRestore(f.context,f.lookup)?.phase).toBe("fenced");
    f.raw.exec("DROP TRIGGER ignore_completion");
    f.raw.exec("PRAGMA foreign_keys=OFF; UPDATE sync_relay_live_update_journal SET journal_cursor=10; PRAGMA foreign_keys=ON");
    expect(()=>f.store.completeStopRestoreCut(capture)).toThrow();
  }finally{f.close();}
});

it("preserves a descending terminal ACK sequence separately from the owner high water across reopen",()=>{
  const f=fixture("owner");let reopened:ReturnType<typeof openSyncRelayStorage>|undefined;let closed=false;
  try{
    f.adopt();const one=f.add("one"),two=f.add("two");
    const ordinary=f.store.openOwnerDelivery({host:f.coordinate,document:f.document,actor:f.actor});
    f.store.acknowledgeOwnerDeliveryApplication(ordinary,applicationAck(one,9));
    f.store.acknowledgeOwnerDeliveryApplication(ordinary,applicationAck(two,2));
    expect(f.store.ownerDeliveryProgress(ordinary).sequence).toBe(9);
    expect(f.raw.prepare("SELECT tip_sequence,tip_application_sequence FROM sync_relay_live_delivery_owners").get()).toEqual({tip_sequence:9,tip_application_sequence:2});
    f.fence();f.close();closed=true;reopened=openSyncRelayStorage(f.path);
    const store=reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace:"restore-test",reconciled:true}));
    const opened=store.openStopRestoreCut(f.lookup);if(opened.kind!=="ready")throw Error(opened.kind);
    expect(store.nextStopRestoreCut(opened.capture)).toMatchObject({kind:"done",terminalReceipt:two});
    expect(store.completeStopRestoreCut(opened.capture)).toMatchObject({terminal:two,localYDocSequence:2});
    expect((reopened as StorageContext).db.prepare("SELECT tip_sequence,tip_application_sequence FROM sync_relay_live_delivery_owners").get()).toEqual({tip_sequence:9,tip_application_sequence:2});
  }finally{if(!closed)f.close();reopened?.close();}
});

it.each(["service","device"] as const)("replays the latest owner restore ACK on %s without changing durable progress or quota",mode=>{
  const f=fixture("owner",mode);let reopened:ReturnType<typeof openSyncRelayStorage>|undefined;let closed=false;
  try{
    f.adopt();const one=f.add("one");
    f.raw.exec("UPDATE sqlite_sequence SET seq=9 WHERE name='sync_relay_live_update_journal'");
    const two=f.add("two");f.fence();const capture=f.open();
    f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(one,9));
    const state=(context:StorageContext)=>({
      owner:context.db.prepare("SELECT * FROM sync_relay_live_delivery_owners").all(),
      usage:context.db.prepare("SELECT * FROM sync_relay_workspace_usage").all(),
      reservations:context.db.prepare("SELECT * FROM sync_relay_live_delivery_reservations").all(),
    });
    const first=state(f.context);
    f.store.acknowledgeStopRestoreApplication(capture,null,{...applicationAck(one,9),applicationReplayed:true});
    expect(state(f.context)).toEqual(first);
    f.store.acknowledgeStopRestoreApplication(capture,one,applicationAck(two,2));
    const terminal=state(f.context);
    f.store.acknowledgeStopRestoreApplication(capture,one,applicationAck(two,2));
    expect(()=>f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(one,9))).toThrow();
    expect(()=>f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(two,2))).toThrow();
    expect(()=>f.store.acknowledgeStopRestoreApplication(capture,{...one,updateDigest:"f".repeat(64)},applicationAck(two,2))).toThrow();
    expect(()=>f.store.acknowledgeStopRestoreApplication(capture,one,applicationAck(two,9))).toThrow();
    expect(state(f.context)).toEqual(terminal);
    f.close();closed=true;reopened=openSyncRelayStorage(f.path);
    const context=reopened as StorageContext;
    const store=reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace:"restore-test",reconciled:true}));
    const opened=store.openStopRestoreCut(f.lookup);if(opened.kind!=="ready")throw Error(opened.kind);
    store.acknowledgeStopRestoreApplication(opened.capture,one,{...applicationAck(two,2),applicationReplayed:true});
    expect(state(context)).toEqual(terminal);
    expect(store.completeStopRestoreCut(opened.capture)).toMatchObject({terminal:two,localYDocSequence:2});
  }finally{if(!closed)f.close();reopened?.close();}
});

it("rolls back owner ACK reservation and quota changes when its progress UPDATE is ignored",()=>{
  const f=fixture("owner");try{
    f.adopt();const terminal=f.add("one");f.fence();const capture=f.open();
    const owner=f.raw.prepare("SELECT * FROM sync_relay_live_delivery_owners").all();
    const reservations=f.raw.prepare("SELECT * FROM sync_relay_live_delivery_reservations").all();
    const usage=f.journalRows().usage;
    f.raw.exec("CREATE TRIGGER ignore_owner_ack BEFORE UPDATE ON sync_relay_live_delivery_owners BEGIN SELECT RAISE(IGNORE); END");
    expect(()=>f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(terminal))).toThrow();
    expect(f.raw.prepare("SELECT * FROM sync_relay_live_delivery_owners").all()).toEqual(owner);
    expect(f.raw.prepare("SELECT * FROM sync_relay_live_delivery_reservations").all()).toEqual(reservations);
    expect(f.journalRows().usage).toBe(usage);
    f.raw.exec("DROP TRIGGER ignore_owner_ack");
    f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(terminal));
    expect(f.store.completeStopRestoreCut(capture).terminal).toEqual(terminal);
  }finally{f.close();}
});
