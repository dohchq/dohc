import {afterEach, expect, it, vi} from "vitest";
import {registered, cleanupLiveDeliveryFixtures, policy, hash} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {createLiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import {createServiceHostEnrollmentRoutes} from "./serviceHostEnrollmentRoutes";
import {createWorkspaceReplicationRoutes} from "./workspaceReplicationRoutes";
import {DiscussionActivityHub} from "./discussionActivity";
import {errorResponse} from "./errors";
import {createShareReadQueries} from "./shareReadQueries";
import {verifyOrdinaryActivationCut} from "./storage/ordinaryActivationSource";
import type {StorageContext} from "./storage/context";
import {createLiveMarkdownJournalValidator, createLiveMarkdownRegistrationValidator} from "../../../packages/ydoc-projection/src/liveDocumentValidation";
import {openSyncRelayStorage} from "./storage";
import {relayApiVersionRefusal} from "./apiVersion";
import {RELAY_API_VERSION, RELAY_API_VERSION_HEADER} from "@dohc/workspace-contracts/relay-values";
import * as Y from "yjs";
import {appendValidatedLiveJournal} from "./storage/liveUpdateJournal";
import {releasePublicationTag} from "./storage/releasePublication";
import {createOwnerRestoreRoutes} from "./ownerRestoreRoutes";

afterEach(cleanupLiveDeliveryFixtures);
const releaseId = "a".repeat(64), otherId = "b".repeat(64);
function fixture(options: Parameters<typeof registered>[0] = {}) {
  const f = registered(options);
  f.storage.claimWorkspaceIdentity({workspaceId: "workspace", replicationEpoch: "epoch", streamIdentity: "stream"});
  const enrollment = {workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: "docs/a.md", nowMs: 10, guard() {}};
  f.storage.enrollServiceHostDocument(enrollment);
  const history = createLiveJournalHistoryAuthority({namespace: "release-test", reconciled: true});
  let userId = "owner", reconciliations = 0;
  const handle = createServiceHostEnrollmentRoutes({storage: f.storage, history, resolveActor: async () => ({workspaceId: "workspace", userId}),
    host: {ready: () => false, reconcile() {reconciliations++;}, unavailable: false}});
  const scope = {document: f.input.evidence.document, relayDatabaseNamespace: history.namespace, restoreFenceGeneration: 1,
    replicationEpoch: "epoch", streamIdentity: "stream"};
  const request = async (action: string, changes = {}, version = "2") => {
    const response = await handle(new Request("https://relay.test/sync/workspace/live-host", {method: "POST",
      headers: {authorization: "Bearer owner-token", "content-type": "application/json", [RELAY_API_VERSION_HEADER]:version},
      body: JSON.stringify({release: {action, ...scope, releaseId, computerName: "Laptop", ...changes}})}));
    return {status: response.status, headers: response.headers, body: await response.json() as any};
  };
  const replication = createWorkspaceReplicationRoutes(f.storage,() => 100,new DiscussionActivityHub());
  const push = async (ops: unknown[], originId = "ordinary") => {
    let response: Response;
    try {response = await replication.respondToWorkspaceReplication(new Request("https://relay.test/sync/workspace/log",{method:"POST",
      headers:{"content-type":"application/json",[RELAY_API_VERSION_HEADER]:"1"},body:JSON.stringify({originId,ops,replicationEpoch:"epoch",streamIdentity:"stream"})}),
      {route:"log",workspaceId:"workspace"},{userId},() => {if (!f.storage.workspaceIsOwnedBy("workspace",userId)) throw Error("unauthorized");});}
    catch (error) {response = errorResponse(error);}
    return {status:response.status,body:await response.json() as any};
  };
  const tagged = (originSeq = 0, generation = 2, opKind = "ydoc.update") => {
    const bytes = f.update("tagged", String(originSeq)), sha = hash(bytes);
    f.storage.putBlob({workspaceId:"workspace",sha256:sha,content:Buffer.from(bytes),createdAtMs:1});
    return {originSeq,opKind,recordedAtMs:originSeq,payload:{versionId:"main",objectId:"object",path:"docs/a.md",
      ...(opKind === "ydoc.update" ? {contentKind:"richdoc",isBaseState:false,lineageClaimId:scope.document.lineageClaimId,updateBlobSha256:sha}
        : {momentId:`tagged-${originSeq}`,operation:"write",payloadAfterPath:"docs/a.md",payloadAfterContentKind:"text",payloadAfterBlobSha256:sha,payloadAfterByteLength:bytes.length}),
      release:{releaseDigest:hash(Buffer.from(releaseId)),restoreFenceGeneration:generation,document:scope.document}}};
  };
  const enrollShare = async () => {
    const response=await handle(new Request("https://relay.test/sync/workspace/live-host",{method:"POST",
      headers:{authorization:"Bearer owner-token","content-type":"application/json"},body:JSON.stringify({shareId:"share"})}));
    return {status:response.status,body:await response.json() as any};
  };
  return {...f, enrollment, scope, request, push, tagged, enrollShare, reconciliations: () => reconciliations, setUser(value: string) {userId = value;}};
}

it.each([[true,"owner"],[false,"owner"],[true,"peer"],[false,"peer"]] as const)("anchors every earlier acceptance and refuses every later acceptance (accept first=%s, %s)", async (first, principal) => {
  const f = fixture();
  try {
    const pending = f.capture(f.update(), "lost-owner-receipt",principal === "owner" ? undefined : {kind:"named",userId:"reader",grantId:"grant"});
    const accepted = first ? f.storage.commitLiveUpdateJournal(pending) : null;
    const acquired = await f.request("acquire");
    expect(acquired.status).toBe(200);
    expect(acquired.body.status).toBe("held");
    expect(acquired.body.claim.anchor.cursor).toBe(first ? accepted!.admitted!.metadata.accepted.receipt.journalCursor : 0);
    if (!first) expect(f.storage.commitLiveUpdateJournal(pending).result).toEqual({kind: "refused", reason: "authority-refused"});
    const repeat = await f.request("acquire", {computerName: "Forged name"});
    expect(repeat.body).toEqual(acquired.body);
    const read = await f.request("catch-up");
    expect(read.status).toBe(200);
    expect(read.body.history.proof.terminal).toEqual(first ? accepted!.admitted!.metadata.accepted.receipt : null);
  } finally {f.close();}
});

it("recovers a lost owner receipt older than the accepted checkpoint without granting live authority", async () => {
  const f = fixture();
  try {
    const first = f.storage.commitLiveUpdateJournal(f.capture(f.update("field","first"),"lost"));
    expect(first.result.kind).toBe("accepted");
    const current=f.storage.resolveCurrentLiveDocumentBinding({document:f.scope.document,actor:f.actor});
    if (current.kind !== "current") throw Error(current.kind);
    let priorMetadata=first.admitted!.metadata;
    // Seed an authenticated prefix; ordinary admission crosses the author checkpoint band.
    f.write(() => {for (let i=0;i<958;i++) {
      f.doc.clientID=i+1; const updateBytes=f.update(`band-${i}`,"edit");
      priorMetadata=appendValidatedLiveJournal(f.storage as StorageContext,{document:f.scope.document,namespace:f.scope.relayDatabaseNamespace,
        host:f.input.host,current,metadata:{deliveryId:`band-${i}`,updateDigest:hash(updateBytes)},updateBytes,receivedAtMs:30,
        firstSeen:[{clientId:i+1,startClock:0,endClock:1}],firstSeenDeletes:[],
        authorSnapshot:[{kind:"automation",automationId:`a${i}`,attribution:{actorKind:"automation",depth:0}}],
        checkpointBytes:null,checkpointDigest:null,priorMetadata}).metadata;
    }});
    f.doc.clientID=959; const pending=f.capture(f.update("band-958","edit"),"checkpoint");
    if (pending.validation.kind !== "accepted") throw Error(pending.validation.kind);
    expect(f.storage.commitLiveUpdateJournal({...pending,validation:{...pending.validation,evidence:{...pending.validation.evidence,stateUpdate:Y.encodeStateAsUpdate(f.doc)}},
      trustedAutomation:{automationId:"a958",attribution:{actorKind:"automation",depth:0}}}).result.kind).toBe("accepted");
    const acquired = await f.request("acquire",{receiptDeliveryIds:["lost"]});
    expect(acquired.status).toBe(200);
    expect(acquired.body.claim.anchor.proof.checkpoint.eventCount).toBeGreaterThan(1);
    expect(acquired.body.claim.anchor.proof.suffix.every((metadata: any) => metadata.accepted.receipt.deliveryId !== "lost")).toBe(true);
    expect(acquired.body.claim.anchor.receipts).toEqual([{deliveryId:"lost",metadata:first.admitted!.metadata}]);
    const catchup = await f.request("catch-up",{receiptDeliveryIds:["lost","unknown"]});
    expect(catchup.body.history.receipts).toEqual([...acquired.body.claim.anchor.receipts,{deliveryId:"unknown",metadata:null}]);
    expect(Buffer.from(catchup.body.history.checkpoint.bytes,"base64").length).toBeGreaterThan(0);
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.scope.document,actor:{kind:"owner",userId:"owner",shareId:"share"}}).kind).toBe("refused");
    expect((await f.request("acquire",{receiptDeliveryIds:[]})).body).toEqual(acquired.body);
    expect((await f.request("catch-up",{receiptDeliveryIds:Array(257).fill("lost")})).status).toBe(400);
  } finally {f.close();}
},120_000);

it("refuses acquisition at a changed generation without retiring the document", async () => {
  const f=fixture();
  try {
    expect((await f.request("acquire",{restoreFenceGeneration:2})).body.code).toBe("restore-fenced");
    expect(f.storage.readServiceHostEnrollment("workspace","docs/a.md")).toMatchObject({enabled:true,retired:false});
    expect((await f.request("status")).body.status).toBe("not-held");
  } finally {f.close();}
});

it("blocks acquisition and catch-up during a real unfinished restore and gives tombstones precedence", async () => {
  const f=fixture();
  try {
    const first=await f.request("acquire");
    expect((await f.request("abandon",{claimDigest:first.body.claim.digest})).status).toBe(200);
    f.storage.enrollServiceHostDocument(f.enrollment);
    const plan=f.storage.readStopRestorePlan({operationId:"restore",ownerUserId:"owner",document:f.scope.document,shareId:"share",grantId:"grant",
      restorePointCursor:0,restorePointReceiptDigest:f.scope.document.lineageClaimId,maxOutputBytes:1_000_000});
    expect(f.storage.beginStopRestore(plan.intent,100).phase).toBe("authority-invalidated");
    expect((await f.request("acquire",{releaseId:otherId})).body.code).toBe("restore-in-progress");
    expect((await f.request("catch-up")).body.code).toBe("restore-in-progress");
    expect((await f.request("status")).body.code).toBe("release-abandoned");
    expect((await f.request("status",{releaseId:otherId})).body).toMatchObject({status:"unresolved",code:"restore-in-progress"});
    expect((await f.push([f.tagged(0,1)])).body.releaseRefusals[0].reason).toBe("release-publication-fenced");
    const other=f.tagged(1,1); other.payload.release.releaseDigest=hash(Buffer.from(otherId));
    expect((await f.push([other])).body.releaseRefusals[0].reason).toBe("release-restore-in-progress");
    expect((await f.request("acquire")).body.code).toBe("release-abandoned");
    expect((await f.request("complete")).body.code).toBe("release-abandoned");
  } finally {f.close();}
});

it("an old API1 relay confirms the API2 capability cannot be held", () => {
  expect(RELAY_API_VERSION).toBe(1);
  expect(relayApiVersionRefusal(new Headers({[RELAY_API_VERSION_HEADER]:"2"}),{min:1,max:1})).toMatchObject({code:"api_version_too_new",statusCode:400});
});

it.each([false,true])("serializes abandonment against acquisition retries (abandon first=%s)", async abandonFirst => {
  const f = fixture();
  try {
    const first = await f.request("acquire"); expect(first.status).toBe(200);
    const actions = [() => f.request("acquire"), () => f.request("abandon",{claimDigest:first.body.claim.digest})];
    const results = await Promise.all((abandonFirst ? actions.reverse() : actions).map(action => action()));
    expect(results.every(result => result.status === 200 || result.body.code === "release-abandoned")).toBe(true);
    expect((await f.request("status")).body.code).toBe("release-abandoned");
    expect((await f.request("acquire")).body.code).toBe("release-abandoned");
  } finally {f.close();}
});

it.each(["ydoc.update","moment.append"])("commits a refused tagged %s, later unrelated work and the original duplicate decision", async kind => {
  const f = fixture();
  try {
    const tagged = f.tagged(0,2,kind), later = {originSeq:1,opKind:"noop",payload:{work:"another document"},recordedAtMs:1};
    const before = f.raw.prepare("SELECT * FROM sync_relay_object_moments").all();
    const result = await f.push([tagged,later]);
    expect(result.status).toBe(200); expect(result.body.currentMaxOriginSeq).toBe(1);
    expect(result.body.releaseRefusals).toEqual([{status:"refused",kind:"release-publication",releaseDigest:hash(Buffer.from(releaseId)),reason:"release-generation-fenced",originId:"ordinary",originSeq:0}]);
    expect(result.body).not.toHaveProperty("settlementRefusals");
    expect(f.raw.prepare("SELECT * FROM sync_relay_object_moments").all()).toEqual(before);
    f.write(db => db.prepare("UPDATE sync_relay_live_documents SET restore_fence_generation=2").run());
    const retry = await f.push([tagged,later]);
    expect(retry.body).toMatchObject({inserted:0,skipped:2,releaseRefusals:result.body.releaseRefusals});
    const changed = {...tagged,recordedAtMs:3}; expect((await f.push([changed])).status).toBe(409);
    const page = f.storage.fetchLogPage({workspaceId:"workspace",sinceRelaySeq:0,limit:10});
    expect(JSON.parse(page.rows[0]!.payloadJson)).toEqual(tagged.payload);
    expect(page.rows[0]!.settlementAdmission).toMatchObject({kind:"release-publication",status:"refused"});
    const served = createShareReadQueries(f.storage,500).filteredLogPage("workspace","share",{paths:["docs"],versionId:null,access:"edit"},0,10,"authenticated");
    expect(served.ops).toEqual([]); expect(served.nextCursor).toBe(2);
    await f.storage.collectUnreferencedBlobs("workspace",{nowMs:1_000_000_000});
    const sha = "updateBlobSha256" in tagged.payload ? tagged.payload.updateBlobSha256 : tagged.payload.payloadAfterBlobSha256;
    expect(f.storage.getBlob("workspace",sha!)).not.toBeNull();
  } finally {f.close();}
});

it("skips refused tagged updates when validating the ordinary activation cut", async () => {
  const f = fixture();
  try {
    const baseline = f.input.baselineBytes, sha = hash(baseline), document = f.scope.document;
    f.storage.putBlob({workspaceId:"workspace",sha256:sha,content:Buffer.from(baseline),createdAtMs:1});
    const base = {originSeq:0,opKind:"ydoc.update",recordedAtMs:0,payload:{versionId:"main",objectId:"object",path:"docs/a.md",contentKind:"richdoc",
      isBaseState:true,lineageClaimId:document.lineageClaimId,updateBlobSha256:sha}};
    expect((await f.push([base,f.tagged(1)])).body.releaseRefusals).toHaveLength(1);
    const source = {version:1 as const,relayDatabaseNamespace:f.scope.relayDatabaseNamespace,...document,mainVersionId:"main" as const,currentPath:"docs/a.md",replicationEpoch:"epoch",streamIdentity:"stream",
      committedCursor:2,baseOriginId:"ordinary",baseOriginSeq:0,baseRelaySeq:1,sourceMomentId:"moment-1",sourceDigest:f.input.evidence.projectedMarkdownSha256,
      sourceByteLength:f.input.evidence.projectedMarkdownByteLength,nativeHeadSequence:0,fullStateDigest:sha,fullStateByteLength:baseline.length};
    expect(verifyOrdinaryActivationCut(f.storage as StorageContext,{source,document,baselineBytes:baseline,fullState:baseline,baseline:f.input.evidence,
      validateJournal:createLiveMarkdownJournalValidator(policy),validateRegistration:createLiveMarkdownRegistrationValidator(policy),
      bounds:{maxCaptureBytes:1_000_000,maxEntriesPerDrain:10,maxBytesPerDrain:1_000_000}})).toEqual({verified:true});
  } finally {f.close();}
});

it("commits a refused coordinate whose blob is absent and preserves opaque unrelated release fields", async () => {
  const f=fixture();
  try {
    const tagged=f.tagged(); if (!("updateBlobSha256" in tagged.payload)) throw Error("Expected update.");
    tagged.payload.updateBlobSha256="f".repeat(64);
    expect(f.storage.getBlob("workspace",tagged.payload.updateBlobSha256)).toBeNull();
    const result=await f.push([tagged,{originSeq:1,opKind:"noop",recordedAtMs:1,payload:{release:"opaque user content"}}]);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({currentMaxOriginSeq:1,releaseRefusals:[{originSeq:0}]});
  } finally {f.close();}
});

it("refuses restore initiation while claimed even for a plan read before acquisition", async () => {
  const f=fixture();
  try {
    const input={operationId:"restore",ownerUserId:"owner",document:f.scope.document,shareId:"share",grantId:"grant",
      restorePointCursor:0,restorePointReceiptDigest:f.scope.document.lineageClaimId,maxOutputBytes:1_000_000};
    const plan=f.storage.readStopRestorePlan(input);
    expect((await f.request("acquire")).status).toBe(200);
    expect(() => f.storage.readStopRestorePlan(input)).toThrow("stopping");
    expect(() => f.storage.beginStopRestore(plan.intent,100)).toThrow("stopping");
    expect(f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_restore_operations").get()!.count).toBe(0);
    const routes=createOwnerRestoreRoutes({storage:f.storage,host:() => ({restoreConfigured:true}) as never,nowMs:() => 100,newId:() => "restore"});
    const {ownerUserId:_owner,...intent}=plan.intent;
    let response:Response;
    try {response=await routes(new Request("https://relay.test/sync/workspace/restore",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({intent})}),{route:"owner-restore",workspaceId:"workspace",action:"begin"},"owner");}
    catch (error) {response=errorResponse(error);}
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({code:"release-claimed",path:"docs/a.md",claim:{computerName:"Laptop"}});
  } finally {f.close();}
});

it.each(["ydoc.update","moment.append"])("rejects malformed tagged %s paths before converting a fence failure to an admission", async kind => {
  const f=fixture();
  try {
    const tagged=f.tagged(0,2,kind); tagged.payload.path="../escape.md";
    if ("payloadAfterPath" in tagged.payload) tagged.payload.payloadAfterPath=tagged.payload.path;
    expect((await f.push([tagged])).status).toBe(400);
    expect(f.storage.maxOriginSeq("workspace","ordinary")).toBe(-1);
  } finally {f.close();}
});

it.each([true,false])("guards and publication-fences new baseline enablement (held=%s)", async held => {
  const f=fixture();
  try {
    const acquired=await f.request("acquire");
    if (!held) expect((await f.request("abandon",{claimDigest:acquired.body.claim.digest})).status).toBe(200);
    f.write(db => db.prepare("DELETE FROM sync_relay_live_documents").run());
    if (held) {
      expect(() => f.storage.registerLiveDocumentBaseline(f.input)).toThrow("stopping");
      expect(f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_documents").get()!.count).toBe(0);
    } else {
      expect(f.storage.registerLiveDocumentBaseline(f.input).kind).toBe("registered");
      expect((await f.push([f.tagged(0,1)])).body.releaseRefusals[0].reason).toBe("release-publication-fenced");
    }
  } finally {f.close();}
});

it.each(["individual","folder","enabled"])("fences abandoned publications in the %s enablement transaction", async enabling => {
  const f = fixture();
  try {
    const acquired = await f.request("acquire"); expect(acquired.status).toBe(200);
    expect((await f.request("abandon",{claimDigest:acquired.body.claim.digest})).status).toBe(200);
    expect((await f.push([f.tagged(0,1)])).body).not.toHaveProperty("releaseRefusals");
    if (enabling === "individual") f.storage.enrollServiceHostDocument(f.enrollment);
    if (enabling === "folder") f.storage.enrollServiceHostDocuments([f.enrollment]);
    if (enabling === "enabled") f.storage.setServiceHostEnrollmentEnabled({...f.enrollment,enabled:true});
    expect((await f.push([f.tagged(1,1)])).body.releaseRefusals[0].reason).toBe("release-publication-fenced");
    expect((await f.push([f.tagged(2,1,"moment.append")])).body.releaseRefusals[0].reason).toBe("release-publication-fenced");
  } finally {f.close();}
});

it("preserves same-generation publication after completion and rejects malformed or unauthorized batches as request errors", async () => {
  const f = fixture();
  try {
    expect((await f.request("acquire")).status).toBe(200);
    expect((await f.request("complete")).status).toBe(200);
    expect((await f.request("complete")).status).toBe(200);
    const valid = f.tagged(0,1);
    expect((await f.push([valid])).body).not.toHaveProperty("releaseRefusals");
    expect((await f.push([{...f.tagged(1),payload:{...valid.payload,release:{...valid.payload.release,restoreFenceGeneration:-1}}}])).status).toBe(400);
    const wrong = f.tagged(1); wrong.payload.release.document = {...wrong.payload.release.document,workspaceId:"foreign"};
    expect((await f.push([wrong])).status).toBe(400);
    expect(() => f.storage.appendLogBatch({workspaceId:"workspace",originId:"foreign",actorUserId:"reader",ops:[{originSeq:0,opKind:"ydoc.update",payloadJson:JSON.stringify(f.tagged().payload),recordedAtMs:0}]})).toThrow();
    expect(f.storage.maxOriginSeq("workspace","foreign")).toBe(-1);
  } finally {f.close();}
});

it.each([true,false])("retains the claim and catch-up through plain retirement, renames and reopening (rename first=%s)", async renameFirst => {
  const f = fixture();
  try {
    const accepted=f.storage.commitLiveUpdateJournal(f.capture(f.update(),"before-rename"));
    expect(accepted.result.kind).toBe("accepted");
    const rename=() => f.write(db => db.prepare(`INSERT INTO sync_relay_object_moments
      SELECT workspace_id,object_id,2,'renamed',version_id,'docs/renamed.md',blob_sha256,content_kind,byte_length,2
      FROM sync_relay_object_moments WHERE relay_seq=1`).run());
    if (renameFirst) rename();
    const acquired = await f.request("acquire"); expect(acquired.status).toBe(200);
    f.storage.setServiceHostEnrollmentEnabled({...f.enrollment,enabled:false,retire:true});
    if (!renameFirst) rename();
    expect((await f.request("status")).body).toMatchObject({status:"held",claim:{digest:acquired.body.claim.digest,computerName:"Laptop",anchor:{cursor:acquired.body.claim.anchor.cursor}}});
    expect((await f.request("catch-up")).body.history.proof.terminal).toEqual(accepted.admitted!.metadata.accepted.receipt);
    expect(() => f.storage.enrollServiceHostDocument({...f.enrollment,path:"docs/renamed.md"})).toThrow("docs/renamed.md");
    const reopened = openSyncRelayStorage(f.path);
    try {expect((reopened as StorageContext).db.prepare("SELECT release_claim_json FROM sync_relay_service_host_enrollments").get()!.release_claim_json).not.toBeNull();}
    finally {reopened.close();}
  } finally {f.close();}
});

it("checks the tombstone before a successor claim and never clears the successor on a repeated abandon or unknown completion", async () => {
  const f = fixture();
  try {
    const first = await f.request("acquire"); expect(first.status).toBe(200);
    const digest = first.body.claim.digest;
    expect((await f.request("abandon", {claimDigest: digest})).status).toBe(200);
    expect((await f.request("acquire", {releaseId: otherId})).status).toBe(200);
    expect((await f.request("acquire")).body.code).toBe("release-abandoned");
    expect((await f.request("complete")).body.code).toBe("release-abandoned");
    expect((await f.request("abandon", {claimDigest: digest})).status).toBe(200);
    expect((await f.request("complete", {releaseId: "c".repeat(64)})).status).toBe(200);
    expect((await f.request("status", {releaseId: otherId})).body.status).toBe("held");
    expect((await f.request("abandon", {claimDigest: "d".repeat(64)})).body.code).toBe("release-changed");
  } finally {f.close();}
});

it("completes an unknown ID without an enrollment and still requires the workspace owner", async () => {
  const f=fixture();
  try {
    f.write(db => db.prepare("DELETE FROM sync_relay_service_host_enrollments").run());
    expect((await f.request("complete")).body).toEqual({ok:true,status:"not-held"});
    expect((await f.request("complete")).status).toBe(200);
    expect(f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_service_host_enrollments").get()!.count).toBe(0);
    f.setUser("reader"); expect((await f.request("complete")).status).toBe(404);
  } finally {f.close();}
});

it("blocks every enrollment while claimed, names the document and rolls back the whole folder", async () => {
  const f = fixture();
  try {
    expect((await f.request("acquire")).status).toBe(200);
    expect(() => f.storage.enrollServiceHostDocument(f.enrollment)).toThrow("docs/a.md");
    expect(() => f.storage.setServiceHostEnrollmentEnabled({...f.enrollment, enabled: true})).toThrow("docs/a.md");
    f.write(db => db.prepare(`INSERT INTO sync_relay_object_moments SELECT workspace_id,'second',2,'second','main','docs/b.md',blob_sha256,content_kind,byte_length,recorded_at_ms FROM sync_relay_object_moments LIMIT 1`).run());
    expect(() => f.storage.enrollServiceHostDocuments([{...f.enrollment, path: "docs/b.md"}, f.enrollment])).toThrow("docs/a.md");
    expect(f.storage.hasServiceHostEnrollment("workspace", "docs/b.md")).toBe(false);
    expect((await f.push([{originSeq:0,opKind:"noop",payload:{},recordedAtMs:1}])).status).toBe(200);
    f.write(db => db.prepare("INSERT INTO sync_relay_current_files VALUES ('workspace','main','docs/a.md',?,'text',1)").run(f.input.evidence.projectedMarkdownSha256));
    expect(await f.enrollShare()).toMatchObject({status:409,body:{code:"release-claimed",path:"docs/a.md",claim:{computerName:"Laptop"}}});
  } finally {f.close();}
});

it("refuses requireRetired without changing live state and makes the secret, not a display name, prove possession", async () => {
  const f = fixture();
  try {
    expect((await f.request("acquire", {requireRetired: true})).body.code).toBe("live-again");
    expect(f.storage.readServiceHostEnrollment("workspace", "docs/a.md")?.enabled).toBe(true);
    expect((await f.request("acquire")).status).toBe(200);
    expect((await f.request("status", {releaseId: otherId})).body.status).toBe("not-held");
    expect((await f.request("acquire", {releaseId: otherId})).body.code).toBe("release-claimed");
    f.setUser("reader"); expect((await f.request("status")).status).toBe(404);
  } finally {f.close();}
});

it("scopes retired catch-up to owner, current object, lineage, namespace, stream and generation", async () => {
  const f = fixture();
  try {
    f.storage.setServiceHostEnrollmentEnabled({...f.enrollment, enabled: false, retire: true});
    expect((await f.request("catch-up")).status).toBe(200);
    for (const changes of [{restoreFenceGeneration: 2}, {relayDatabaseNamespace: "foreign"}, {streamIdentity: "foreign"},
      {document: {...f.scope.document, objectId: "foreign"}}, {document: {...f.scope.document, lineageClaimId: "f".repeat(64)}}]) {
      expect((await f.request("catch-up", changes)).status).toBe(409);
    }
    f.setUser("reader"); expect((await f.request("catch-up")).status).toBe(404);
  } finally {f.close();}
});


it("review round: keeps ordinary API1 usable and requires API2 only for release actions", async () => {
  const f=fixture();
  try {
    expect(RELAY_API_VERSION).toBe(1);
    expect(relayApiVersionRefusal(new Headers({[RELAY_API_VERSION_HEADER]:"1"}),{min:1,max:1})).toBeNull();
    expect((await f.push([{originSeq:0,opKind:"noop",recordedAtMs:0,payload:{}}])).status).toBe(200);
    expect(await f.request("acquire",{},"1")).toMatchObject({status:400,body:{code:"api_version_too_old"}});
    expect(f.storage.readServiceHostEnrollment("workspace","docs/a.md")?.enabled).toBe(true);
    expect((await f.request("acquire")).status).toBe(200);
  } finally {f.close();}
});

it("review round: returns standard errors and small claims with the holding computer and retry first", async () => {
  const f=fixture();
  try {
    const acquired=await f.request("acquire");
    expect(acquired.body.claim.anchor).toHaveProperty("proof");
    const status=await f.request("status");
    expect(status.body.claim.digest).toBe(acquired.body.claim.digest);
    expect(status.body.claim.anchor).not.toHaveProperty("proof");
    expect(status.body.claim.anchor).not.toHaveProperty("receipts");
    const refusal=await f.request("acquire",{releaseId:otherId});
    expect(refusal.body).toMatchObject({ok:false,code:"release-claimed",error:"Laptop is stopping live editing for docs/a.md. Try again when it finishes, or end that stop."});
    expect(refusal.body).not.toHaveProperty("message");
    expect(refusal.body.claim).toEqual(status.body.claim);
  } finally {f.close();}
});

it("review round: status and catch-up use read snapshots without reconciling the live host", async () => {
  const f=fixture();
  try {
    expect((await f.request("acquire")).status).toBe(200);
    const writes=vi.spyOn(f.storage as StorageContext,"tx"), reads=vi.spyOn(f.storage as StorageContext,"readTx");
    const reconciliations=f.reconciliations();
    expect((await f.request("status")).status).toBe(200);
    expect((await f.request("catch-up")).status).toBe(200);
    expect(writes).not.toHaveBeenCalled();
    expect(reads).toHaveBeenCalledTimes(2);
    expect(f.reconciliations()).toBe(reconciliations);
    writes.mockRestore(); reads.mockRestore();
  } finally {f.close();}
});

it("review round: caches absent tags across parse, duplicate validation and admission", () => {
  let scans=0;
  const op={originSeq:0,opKind:"ydoc.update",recordedAtMs:0,get payloadJson() {scans++; return '{"work":"ordinary"}';}};
  for(let i=0;i<3;i++) expect(releasePublicationTag(op)).toBeNull();
  expect(scans).toBe(1);
});

it("review round: rejects client authors on tagged moments before storing a refusal", async () => {
  const f=fixture();
  try {
    const tagged=f.tagged(0,2,"moment.append");
    const payload={...tagged.payload,authors:[{kind:"unattributed"}]};
    expect((await f.push([{...tagged,payload}])).status).toBe(400);
    expect(f.storage.maxOriginSeq("workspace","ordinary")).toBe(-1);
  } finally {f.close();}
});

it("review round: status cannot close an abandoned sent-ID obligation even with a successor", async () => {
  const f=fixture();
  try {
    const acquired=await f.request("acquire");
    expect((await f.request("abandon",{claimDigest:acquired.body.claim.digest})).status).toBe(200);
    expect((await f.request("status")).body.code).toBe("release-abandoned");
    expect((await f.request("status",{releaseId:undefined})).body.status).toBe("not-held");
    expect((await f.request("acquire",{releaseId:otherId})).status).toBe(200);
    expect((await f.request("status")).body.code).toBe("release-abandoned");
  } finally {f.close();}
});

it("review round: publishes only the digest and cannot complete with a disclosed tag", async () => {
  const f=fixture();
  try {
    expect((await f.request("acquire")).status).toBe(200);
    const tagged=f.tagged(0,2);
    expect((await f.push([tagged])).status).toBe(200);
    const row=f.storage.fetchLogPage({workspaceId:"workspace",sinceRelaySeq:0,limit:10}).rows[0]!;
    const published=JSON.stringify({payload:JSON.parse(row.payloadJson),admission:row.settlementAdmission});
    expect(published).not.toContain(releaseId);
    const releaseDigest=JSON.parse(row.payloadJson).release.releaseDigest;
    expect(releaseDigest).toBe(hash(Buffer.from(releaseId)));
    expect(row.settlementAdmission).toMatchObject({releaseDigest});
    expect((await f.request("complete",{releaseId:releaseDigest})).status).toBe(200);
    expect((await f.request("status")).body.status).toBe("held");
    const accepted=f.tagged(1,1,"moment.append");
    expect((await f.push([accepted])).body).not.toHaveProperty("releaseRefusals");
    const shared=createShareReadQueries(f.storage,500).filteredLogPage("workspace","share",{paths:["docs"],versionId:null,access:"edit"},0,10,"authenticated");
    expect(JSON.stringify(shared)).not.toContain(releaseId);
    expect(shared.ops).toHaveLength(1);
  } finally {f.close();}
});

it("review round: abandonment refunds usage and succeeds while the workspace is over quota", async () => {
  const f=fixture({workspaceQuotaBytes:1_000_000});
  try {
    const acquired=await f.request("acquire");
    const before=2_000_000;
    f.write(db=>db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=? WHERE workspace_id='workspace'").run(before));
    expect((await f.request("abandon",{claimDigest:acquired.body.claim.digest})).status).toBe(200);
    expect(Number(f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()!.usage_bytes)).toBeLessThan(before);
    expect((await f.request("status")).body.code).toBe("release-abandoned");
  } finally {f.close();}
});


it("retries a tagged moment's settlement refusal without restoring a client payload", async () => {
  const f=fixture();
  try {
    const tagged=f.tagged(0,1,"moment.append"), op={...tagged,payload:{...tagged.payload,settlementReference:{}}};
    const first=await f.push([op]);
    expect(first.status).toBe(200);
    expect(first.body.settlementRefusals).toHaveLength(1);
    expect(first.body).not.toHaveProperty("releaseRefusals");
    const retry=await f.push([op]);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({inserted:0,skipped:1,settlementRefusals:first.body.settlementRefusals});
    const stored=JSON.parse(f.storage.fetchLogPage({workspaceId:"workspace",sinceRelaySeq:0,limit:10}).rows[0]!.payloadJson);
    expect(stored).not.toHaveProperty("authors");
  } finally {f.close();}
});

it("round 2: never caches operations outside updates and moments", () => {
  const get=vi.spyOn(WeakMap.prototype,"get"), set=vi.spyOn(WeakMap.prototype,"set");
  const op={originSeq:0,opKind:"chat.append",recordedAtMs:0,payloadJson:'{"release":"ordinary content"}'};
  try {
    for(let i=0;i<3;i++) expect(releasePublicationTag(op)).toBeNull();
    expect(get.mock.calls.filter(([key])=>key===op)).toHaveLength(0);
    expect(set.mock.calls.filter(([key])=>key===op)).toHaveLength(0);
  } finally {get.mockRestore();set.mockRestore();}
});

it("round 2: keeps release errors private and uncached", async () => {
  const f=fixture();
  try {
    expect((await f.request("acquire")).status).toBe(200);
    const responses=[await f.request("acquire",{releaseId:otherId}),await f.request("status",{},"1")];
    f.setUser("reader"); responses.push(await f.request("status"));
    expect(responses.map(response=>response.status)).toEqual([409,400,404]);
    for(const response of responses) expect(response.headers.get("cache-control")).toBe("private, no-store");
  } finally {f.close();}
});

it("round 2: checks tagged ownership once per batch including duplicate retries", () => {
  const f=fixture();
  try {
    const ops=[f.tagged(0),f.tagged(1)].map(({payload,...op})=>({...op,payloadJson:JSON.stringify(payload)}));
    const owned=vi.spyOn(f.storage,"workspaceIsOwnedBy");
    try {
      const append=()=>f.storage.appendLogBatch({workspaceId:"workspace",originId:"ordinary",actorUserId:"owner",ops:ops.map(op=>({...op}))});
      expect(append().inserted).toBe(2);
      expect(owned).toHaveBeenCalledTimes(1);
      owned.mockClear();
      expect(append().skipped).toBe(2);
      expect(owned).toHaveBeenCalledTimes(1);
    } finally {owned.mockRestore();}
  } finally {f.close();}
});

it("round 2: hashes the lowercase hex release ID text using the drain's fixed vector", async () => {
  const f=fixture();
  try {
    expect(releaseId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect((await f.request("acquire")).status).toBe(200);
    const row=f.raw.prepare("SELECT release_claim_json FROM sync_relay_service_host_enrollments WHERE workspace_id='workspace' AND object_id='object'").get()!;
    expect(JSON.parse(String(row.release_claim_json)).releaseDigest).toBe("ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb");
  } finally {f.close();}
});
