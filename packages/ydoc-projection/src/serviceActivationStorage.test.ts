import { ServiceActivationDriver, type ServiceActivationConfig } from "../../../services/sync-relay/src/serviceActivationDriver.js"
import {OwnerCommittedDelivery} from "../../../services/sync-relay/src/ownerCommittedDelivery.js"
import {LiveDocumentWork} from "../../../services/sync-relay/src/liveDocumentWork.js"
import {parseLiveDocumentKey,type LiveUpdateHostApplicationAck,type LiveUpdateReceipt} from '@dohc/live-session-contract/live-update-admission'
import {createHash} from 'node:crypto'
import {mkdtempSync,rmSync} from 'node:fs'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it,vi} from 'vitest'
import * as Y from 'yjs'
import {parseHostEpoch} from '@dohc/live-session-contract/host-control'
import type {NativeOwnerActivation} from '../../workspace-engine-client/src/daemon/nativeOwnerActivation.js'
import {markdownToYDoc} from './import-export.js'
import { createLiveMarkdownRegistrationValidator, createLiveMarkdownJournalValidator } from './liveDocumentValidation.js'
import {openSyncRelayStorage} from '../../../services/sync-relay/src/storage.js'
import {openEmptyRelayTestStorage} from '../../../services/sync-relay/src/testing/emptyRelayStorage.js'
import {createLiveJournalHistoryAuthority} from '../../../services/sync-relay/src/storage/liveJournalHistory.js'
import { ServiceActivationHistoryOverBudget, ServiceActivationStaleCut, ServiceActivationTooLarge } from '../../../services/sync-relay/src/storage/serviceActivation.js'
import {SyncRelayQuotaExceededError} from '../../../services/sync-relay/src/storage/errors.js'
import {readOrdinaryActivationHistory,verifyOrdinaryActivationCut} from '../../../services/sync-relay/src/storage/ordinaryActivationSource.js'
import {validateOrdinaryActivation,type OrdinaryActivationValidator} from '../../../services/sync-relay/src/storage/ordinaryActivationValidation.js'
import { createLiveValidationExecutor } from '../../../services/sync-relay/src/liveValidation.js'
import {requireStopRestoreOwnerOrigin,type StopRestoreBasis,type StopRestoreIntent} from '../../../services/sync-relay/src/storage/liveRestoreOperation.js'
import type {StorageContext} from '../../../services/sync-relay/src/storage/context.js'
import {openServiceActivationRetirement,readServiceActivationRetirement} from '../../../services/sync-relay/src/storage/serviceActivationRetirement.js'
import {allowsServiceActivation,type ServiceActivationAccess} from '../../../services/sync-relay/src/storage/serviceActivationAccess.js'
import {readServiceActivationOrigin} from '../../../services/sync-relay/src/storage/serviceActivationOrigin.js'
import {authorizeServiceHostReplication,deriveServiceHostBearer} from '../../../services/sync-relay/src/serviceHostCredential.js'
import {createServiceHostReplication} from '../../../services/sync-relay/src/serviceHostReplication.js'
import { SERVICE_HOST_ORIGIN_PREFIX } from '../../../services/sync-relay/src/relayLogInputs.js'
import {canonicalVersionedAcceptedMetadata,initialAcceptedHistoryDigest} from '../../../services/sync-relay/src/liveAcceptedHistory.js'
import {nativeSettlementId,settlementRecordDigest} from '../../../services/sync-relay/src/storage/hostedSettlement.js'
import {nativeBaseRecord} from '../../../services/sync-relay/src/storage/serviceActivationPublication.js'
import type {SqliteDb} from '../../../services/sync-relay/src/storage/types.js'
import type {OwnerRestoreHost} from '../../../services/sync-relay/src/ownerRestoreRoutes.js'
import {testHandler} from '../../../services/sync-relay/src/testing/index.js'
import {preparedStop} from '../../../services/sync-relay/src/liveTickets.test-helper.js'
import {registered,cleanupLiveDeliveryFixtures} from './liveCommittedDeliveryTestSupport.js'
import nativeAuthoredSettlement from '../../../services/sync-relay/src/testing/fixtures/nativeAuthoredSettlement.json'

const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const policy={maxStructVisits:1_000_000,maxValueNodeVisits:5_000_000,maxDecodedPayloadByteVisits:100_000_000,
  maxStructClientGroupVisits:1_000_000,maxDeleteClientGroupVisits:1_000_000,maxDeleteIntervalVisits:1_000_000,maxIndexOperations:10_000_000}
const validateBaseline=createLiveMarkdownRegistrationValidator(policy),validateJournal=createLiveMarkdownJournalValidator(policy)
// The pool's check, run in this process.
const validateActivation:OrdinaryActivationValidator=async work=>validateOrdinaryActivation(work,policy)
const host={mode:'service' as const,hostId:'service',hostEpoch:parseHostEpoch(1),instanceId:'instance',connectionId:'connection'}
const actor={kind:'owner' as const,userId:'owner'}
const bounds={maxCaptureBytes:1_000_000,maxHistoryEntries:10,maxBytesPerDrain:1_000_000}
const stop={operationId:'restore',workspaceId:'workspace',ownerUserId:'owner'}
// A `large` note is not validated here; its projections are placeholders that only a finished validation would refuse.
function fixture(note='Original',large=false,clientID?:number){
  const root=mkdtempSync(join(tmpdir(),'dohc-service-activation-')),path=join(root,'relay.sqlite')
  const storage=openEmptyRelayTestStorage(path),raw=new DatabaseSync(path)
  const history=createLiveJournalHistoryAuthority({namespace:'history',reconciled:true}),store=storage.createServiceActivationStore(history)
  const doc=markdownToYDoc(note,{clientID}),baselineBytes=Buffer.from(Y.encodeStateAsUpdate(doc))
  doc.getMap('frontmatter').set('title','Edited')
  const fullState=Buffer.from(Y.encodeStateAsUpdate(doc));doc.destroy()
  const document={workspaceId:'workspace',mainVersionId:'main' as const,objectId:'object',lineageClaimId:hash(baselineBytes)}
  const placeholder={kind:'accepted' as const,evidence:{projectedMarkdownSha256:'f'.repeat(64),projectedMarkdownByteLength:1}}
  const validated=large?placeholder:validateJournal({document,currentPath:'docs/a.md',checkpoint:baselineBytes,suffix:[],candidate:fullState})
  if(validated.kind!=='accepted')throw new Error(JSON.stringify(validated))
  const base=large?placeholder:validateBaseline({document,currentPath:'docs/a.md',checkpoint:baselineBytes})
  if(base.kind!=='accepted')throw new Error(JSON.stringify(base))
  const capture:NativeOwnerActivation={activationId:`ordinary-activation-${'a'.repeat(64)}`,sessionId:'real-session',baselineBytes,fullState,
    source:{version:1,relayDatabaseNamespace:'history',...document,currentPath:'docs/a.md',replicationEpoch:'epoch',streamIdentity:'stream',
      committedCursor:3,baseOriginId:'origin',baseOriginSeq:1,baseRelaySeq:2,
      sourceMomentId:`moment-ydoc-apply-${hash(Buffer.from(['workspace','main','object','docs/a.md','origin','2'].join('\0')))}`,
      sourceDigest:validated.evidence.projectedMarkdownSha256,sourceByteLength:validated.evidence.projectedMarkdownByteLength,
      nativeHeadSequence:2,fullStateDigest:hash(fullState),fullStateByteLength:fullState.length}}
  // Every test opens this fixture, so its rows share one commit rather than a disk flush each.
  raw.exec('BEGIN')
  raw.exec("INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity) VALUES ('workspace','owner',0,'epoch','stream')")
  raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',0,'moment.append',?,0)")
    .run(JSON.stringify({versionId:'main',objectId:'object',momentId:'original-moment',path:'docs/a.md',operation:'write',
      payloadAfterPath:'docs/a.md',payloadAfterContentKind:'text',payloadAfterBlobSha256:base.evidence.projectedMarkdownSha256,
      payloadAfterByteLength:base.evidence.projectedMarkdownByteLength}))
  raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',1,'ydoc.update',?,1)")
    .run(JSON.stringify({versionId:'main',objectId:'object',path:'docs/a.md',contentKind:'richdoc',isBaseState:true,lineageClaimId:document.lineageClaimId,updateBlobSha256:document.lineageClaimId}))
  raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',2,'ydoc.update',?,2)")
    .run(JSON.stringify({versionId:'main',objectId:'object',path:'docs/a.md',contentKind:'richdoc',isBaseState:false,lineageClaimId:document.lineageClaimId,updateBlobSha256:hash(fullState)}))
  raw.prepare("INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)").run(document.lineageClaimId,baselineBytes.length,baselineBytes)
  raw.prepare("INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)").run(hash(fullState),fullState.length,fullState)
  raw.prepare("INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms) VALUES ('workspace','object',1,'original-moment','main','docs/a.md',?,'text',?,0)")
    .run(base.evidence.projectedMarkdownSha256,base.evidence.projectedMarkdownByteLength)
  raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('share','workspace','owner',?,0)").run(JSON.stringify({paths:['docs'],versionId:null}))
  raw.exec('COMMIT')
  storage.provisionLiveHostControl({...host,updatedAtMs:1,guard(){}})
  const prepare=(readBounds=bounds,validate=validateActivation)=>store.prepare({capture,host,registeredAtMs:3,guard(){},validate,bounds:readBounds})
  return {storage,raw,store,history,capture,document,prepare,path,close(){raw.close();storage.close();rmSync(root,{recursive:true,force:true})}}
}
it('retains the original lineage and edited ordinary cut, closing ordinary authority until activation completes',async()=>{
  const f=fixture();try{
    expect(await f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor}).kind).toBe('refused')
    const access=f.store.pending(f.document,host)
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor},access).kind).toBe('current')
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor},{activationId:access.activationId}).kind).toBe('refused')
    const saved=f.store.read('workspace','docs/a.md',1_000_000)!
    expect(saved.source).toEqual(f.capture.source)
    expect(saved.baselineBytes).toEqual(new Uint8Array(f.capture.baselineBytes))
    expect(saved.fullState).toEqual(new Uint8Array(f.capture.fullState))
    expect(await f.prepare()).toMatchObject({replayed:true,completed:false})
  }finally{f.close()}
})

// A hosted replica's cursor passes every row of the workspace, including rows of
// documents it may not read, so it matches the relay's newest sequence.
it('activates at a hosted cursor that passed rows of documents outside the hosted scope',async()=>{
  const f=fixture();try{
    f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',3,'ydoc.update',?,3)")
      .run(JSON.stringify({versionId:'main',objectId:'private-object',path:'private/b.md',contentKind:'richdoc',isBaseState:true,lineageClaimId:'c'.repeat(64),updateBlobSha256:'c'.repeat(64)}))
    await expect(f.prepare()).rejects.toThrow(ServiceActivationStaleCut)
    f.capture.source.committedCursor=4
    expect(await f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
  }finally{f.close()}
})

it('rejects different CRDT history even when its rendered Markdown matches the ordinary cut',async()=>{
  const f=fixture(),changed=new Y.Doc();try{
    Y.applyUpdate(changed,f.capture.fullState)
    changed.getMap('frontmatter').set('temporary','removed');changed.getMap('frontmatter').delete('temporary')
    const bytes=Y.encodeStateAsUpdate(changed)
    const validated=validateJournal({document:f.document,currentPath:'docs/a.md',checkpoint:f.capture.baselineBytes,suffix:[],candidate:bytes})
    expect(validated.kind).toBe('accepted')
    if(validated.kind!=='accepted')throw new Error('Invalid test update')
    expect(validated.evidence.projectedMarkdownSha256).toBe(f.capture.source.sourceDigest)
    Object.assign(f.capture,{fullState:bytes});Object.assign(f.capture.source,{fullStateDigest:hash(bytes),fullStateByteLength:bytes.length})
    await expect(f.prepare()).rejects.toThrow('complete ordinary CRDT history')
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
  }finally{changed.destroy();f.close()}
})

it('checks configured history entry and byte budgets before loading relay blobs',async()=>{
  const f=fixture();try{
    const read=vi.spyOn(f.storage,'getBlob')
    await expect(f.prepare({...bounds,maxHistoryEntries:1})).rejects.toThrow('entry budget')
    expect(read).not.toHaveBeenCalled()
    // A baseline past the byte budget is refused before the history read, as the same over-budget history.
    await expect(f.prepare({...bounds,maxBytesPerDrain:f.capture.baselineBytes.length-1})).rejects.toBeInstanceOf(ServiceActivationHistoryOverBudget)
    expect(read).not.toHaveBeenCalled()
    await expect(f.prepare({...bounds,maxBytesPerDrain:f.capture.baselineBytes.length})).rejects.toThrow('metadata')
    expect(read).not.toHaveBeenCalled()
    expect(f.raw.prepare('SELECT * FROM sync_relay_service_activations').all()).toEqual([])
  }finally{f.close()}
})
const ydocUpdate=(payload:Record<string,unknown>)=>({versionId:'main',objectId:'object',path:'docs/a.md',contentKind:'richdoc',...payload})
// Appends one relay row, with its bytes when given, and moves the native cut to it.
function append(f:ReturnType<typeof fixture>,origin:string,originSeq:number,opKind:string,payload:Record<string,unknown>,bytes?:Uint8Array){
  const row=f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace',?,?,?,?,3)")
    .run(origin,originSeq,opKind,JSON.stringify(payload))
  if(bytes)f.raw.prepare("INSERT OR IGNORE INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)").run(hash(bytes),bytes.length,bytes)
  f.capture.source.committedCursor=Number(row.lastInsertRowid)
}
// A second device set up the same text before the two synced. Its own Y.Doc
// encodes it in different bytes, so its base names another lineage. The relay
// ordered it after the winner, so native acknowledges it without applying it.
function losingDevice(f:ReturnType<typeof fixture>){
  const doc=markdownToYDoc('Original'),base=Buffer.from(Y.encodeStateAsUpdate(doc)),lineageClaimId=hash(base)
  expect(lineageClaimId).not.toBe(f.document.lineageClaimId)
  append(f,'losing-device',1,'ydoc.update',ydocUpdate({isBaseState:true,lineageClaimId,updateBlobSha256:lineageClaimId}),base)
  return {doc,lineageClaimId}
}
// The ordinary-cut check a fresh capture runs, without retaining an activation.
async function verify(f:ReturnType<typeof fixture>,readBounds=bounds){
  const input={source:f.capture.source,document:f.document,baselineBytes:f.capture.baselineBytes,fullState:f.capture.fullState,bounds:readBounds}
  const history=readOrdinaryActivationHistory(f.storage as StorageContext,input)
  const validation=await validateActivation({document:f.document,currentPath:'docs/a.md',baselineBytes:f.capture.baselineBytes,
    cut:{source:f.capture.source,fullState:f.capture.fullState,history,maxBytesPerDrain:readBounds.maxBytesPerDrain}})
  if(validation.kind!=='accepted')throw new Error(validation.kind==='refused'?validation.message:JSON.stringify(validation))
  return verifyOrdinaryActivationCut(f.storage as StorageContext,{...input,baseline:validation.baseline,history,proof:validation.proof})
}
it('activates past a losing base from a second device and keeps one lineage through Resume and a fresh capture',async()=>{
  const f=fixture(),loser=losingDevice(f);try{
    await completeActivation(f)
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor}).kind).toBe('current')
    expect(f.store.resume({document:f.document,activationId:f.capture.activationId,host:{...host,connectionId:'resumed'},registeredAtMs:6,guard(){}}))
      .toMatchObject({completed:true})
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor}).kind).toBe('current')
    expect(await verify(f)).toEqual({verified:true})
    expect(f.raw.prepare('SELECT lineage_claim_id FROM sync_relay_live_documents').all()).toEqual([{lineage_claim_id:f.document.lineageClaimId}])
  }finally{loser.doc.destroy();f.close()}
})

type LosingDevice=ReturnType<typeof losingDevice>

// A later native-shaped write of the document under a native settlement name,
// whose projection the edit at origin sequence 2 made stale, unless given another.
function staleArtifact(f:ReturnType<typeof fixture>,origin='origin',originSeq=3,
  stale=f.raw.prepare("SELECT blob_sha256,byte_length FROM sync_relay_object_moments WHERE moment_id='original-moment'").get()!){
  const momentId=`moment-ydoc-${hash(Buffer.from(`${origin}:${originSeq}`))}`
  append(f,origin,originSeq,'moment.append',{momentId,versionId:'main',objectId:'object',objectCreatedAtMs:0,path:'docs/a.md',recordedAtMs:3,
    operation:'write',payloadBeforeBlobSha256:null,payloadBeforePath:null,payloadAfterBlobSha256:stale.blob_sha256,payloadAfterPath:'docs/a.md',
    payloadBeforeContentKind:null,payloadBeforeByteLength:null,payloadAfterContentKind:'text',payloadAfterByteLength:stale.byte_length,
    metadata:{origin:'sync',summary:null,correlationId:null},authors:null,beforePresent:'null',beforeObjectId:null,beforeVersionId:null,beforePath:null,
    beforeBlobSha256:null,beforeContentKind:null,beforeByteLength:null,beforeUpdatedAtMs:null,beforeLatestMomentId:null,beforeMetadata:null})
  f.raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
    VALUES ('workspace','object',?,?,'main','docs/a.md',?,'text',?,3)`).run(f.capture.source.committedCursor,momentId,stale.blob_sha256,stale.byte_length)
}
const otherWrite=(changes:Record<string,unknown>)=>({versionId:'main',objectId:'other-object',momentId:'other',path:'docs/c.md',operation:'write',
  payloadAfterPath:'docs/c.md',payloadAfterContentKind:'text',payloadAfterBlobSha256:'c'.repeat(64),payloadAfterByteLength:1,...changes})
// Proves: a later divergent file moment of the same lineage leaves an earlier
// source standing, beside a losing device's base and delta that break nothing.
it('activates past a same-lineage stale settlement artifact and a losing base from another device',async()=>{
  const f=fixture(),loser=losingDevice(f);try{
    append(f,'losing-device',2,'ydoc.update',ydocUpdate({isBaseState:false,lineageClaimId:loser.lineageClaimId,updateBlobSha256:hash(Buffer.from('losing'))}))
    staleArtifact(f)
    expect(await f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
  }finally{loser.doc.destroy();f.close()}
})

const divergent='Ordinary activation found a later ordinary file moment with a divergent projection.'
it.each([
  // The artifact origin's nearest row names another lineage; its favourable row behind that doesn't count.
  ['an unfavourable nearer row',f=>{append(f,'origin',3,'ydoc.update',ydocUpdate({isBaseState:false,lineageClaimId:'b'.repeat(64),updateBlobSha256:'b'.repeat(64)}));staleArtifact(f,'origin',4)},divergent],
  ['the document moving away and back',f=>{staleArtifact(f)
    append(f,'origin',4,'moment.append',otherWrite({objectId:'object',operation:'move',path:'docs/b.md',payloadAfterPath:'docs/b.md'}))
    append(f,'origin',5,'moment.append',otherWrite({objectId:'object',operation:'move',path:'docs/a.md',payloadAfterPath:'docs/a.md'}))},
    'Ordinary activation history replaced the live document.'],
  ['unclaimed lineage evidence',f=>{staleArtifact(f);append(f,'other',0,'ydoc.update',ydocUpdate({isBaseState:false,updateBlobSha256:'d'.repeat(64)}))},
    'Ordinary activation history differs from the captured lineage.'],
  ['a base inconsistent with the captured claim',f=>{staleArtifact(f);const other=Buffer.from('another base')
    append(f,'other',0,'ydoc.update',ydocUpdate({isBaseState:true,lineageClaimId:f.document.lineageClaimId,updateBlobSha256:hash(other)}),other)},
    'Ordinary activation has a different baseline.'],
] as [string,(f:ReturnType<typeof fixture>)=>void,string][])('refuses a stale settlement artifact after %s',async(_case,add,message)=>{
  const f=fixture();try{
    add(f)
    await expect(f.prepare()).rejects.toThrow(message)
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
  }finally{f.close()}
})

it('rolls back host registration and baseline when the ordinary cursor advanced',async()=>{
  const f=fixture();try{
    f.raw.exec("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','other',1,'object.snapshot','{}',3)")
    await expect(f.prepare()).rejects.toThrow(ServiceActivationStaleCut)
    expect(f.storage.getLiveHostControl()!.registeredConnectionId).toBeNull()
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
    expect(f.raw.prepare('SELECT * FROM sync_relay_service_activations').all()).toEqual([])
  }finally{f.close()}
})

it('preflights retained byte reads and rejects damaged bytes',async()=>{
  const f=fixture();try{
    await f.prepare()
    expect(()=>f.store.read('workspace','docs/a.md',2)).toThrow('read budget')
    f.raw.prepare('UPDATE sync_relay_service_activations SET state_bytes=?').run(new Uint8Array([0,0]))
    expect(()=>f.store.read('workspace','docs/a.md',1_000_000)).toThrow('damaged')
  }finally{f.close()}
})

async function ownerCapture(f:ReturnType<typeof fixture>){
  await f.prepare()
  const access=f.store.pending(f.document,host),delivery=f.storage.createLiveCommittedDeliveryStore(f.history,access)
  const capture=delivery.captureOwnerCut({host,document:f.document,actor,adoptionId:f.capture.activationId,
    expectedLocalSequence:f.capture.source.nativeHeadSequence,maxBytes:1_000_000,maxEvents:100,throughCursor:0})
  const acknowledge=()=>delivery.acknowledgeOwnerAdoption(capture,{adoptionId:f.capture.activationId,
    localYDocSequence:f.capture.source.nativeHeadSequence,terminalCursor:0,adoptionReplayed:false})
  return {capture,delivery,acknowledge}
}

it('checks the frozen service origin separately from the original baseline when guarding restore',async()=>{
  const f=fixture();try{
    const owner=await ownerCapture(f);owner.acknowledge()
    const row=f.raw.prepare('SELECT * FROM sync_relay_live_documents').get()!
    const origin=f.raw.prepare('SELECT origin_json FROM sync_relay_live_delivery_owners').get()!
    const basis:StopRestoreBasis={binding:owner.capture.binding,ownerBinding:owner.capture.binding,
      baselineDigest:f.document.lineageClaimId,baselineByteLength:f.capture.baselineBytes.length,
      projectedDigest:String(row.baseline_projected_sha256),projectedLength:Number(row.baseline_projected_byte_length),
      baselineSequence:Number(row.baseline_moment_relay_seq),registeredAtMs:Number(row.registered_at_ms),
      namespace:f.history.namespace,hostMode:'service',hostId:host.hostId,ownerOrigin:String(origin.origin_json)}
    expect(basis.projectedDigest).not.toBe(f.capture.source.sourceDigest)
    expect(()=>requireStopRestoreOwnerOrigin(f.storage as StorageContext,basis)).not.toThrow()
    const tampered=JSON.parse(basis.ownerOrigin!);tampered.sourceMomentId='unrelated-source'
    expect(()=>requireStopRestoreOwnerOrigin(f.storage as StorageContext,{...basis,ownerOrigin:JSON.stringify(tampered)})).toThrow()
    f.raw.exec("UPDATE sync_relay_service_activations SET source_json=json_set(source_json,'$.nativeHeadSequence',99)")
    expect(()=>requireStopRestoreOwnerOrigin(f.storage as StorageContext,basis)).toThrow()
  }finally{f.close()}
})

it('requires exact seed application ACK and supports lost completion responses',async()=>{
  const f=fixture();try{
    await f.prepare()
    const access=f.store.pending(f.document,host), delivery=f.storage.createLiveCommittedDeliveryStore(f.history,access)
    const adoption=delivery.captureOwnerCut({host,document:f.document,actor,adoptionId:f.capture.activationId,
      expectedLocalSequence:2,maxBytes:1_000_000,maxEvents:100,throughCursor:0})
    delivery.acknowledgeOwnerAdoption(adoption,{adoptionId:f.capture.activationId,localYDocSequence:2,terminalCursor:0,adoptionReplayed:false})
    const current=f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor},access)
    if(current.kind!=='current')throw new Error('Missing activation authority')
    const commit=(bytes:Uint8Array,deliveryId:string)=>{
      const cut=f.storage.readLiveUpdateJournalCut({document:f.document})
      if(cut.kind!=='cut')throw new Error('Missing cut')
      const validation=validateJournal({document:f.document,currentPath:current.binding.currentPath,
        checkpoint:cut.cut.checkpoint.bytes,suffix:cut.cut.suffix.map(row=>row.bytes),candidate:bytes})
      return f.storage.commitLiveUpdateJournal({host,actor,expectedAuthority:current.authority,
        metadata:{deliveryId,updateDigest:hash(bytes),binding:current.binding},cutToken:cut.cut,validation,
        updateBytes:bytes,receivedAtMs:4},access)
    }
    const accepted=commit(f.capture.fullState,'seed')
    expect(accepted.result.kind).toBe('accepted')
    const complete=()=>f.store.complete({document:f.document,host,access,nativeState:{adoptionId:f.capture.activationId,pendingBytes:0},guard(){}})
    expect(complete).toThrow('application acknowledgement is missing')
    expect(commit(f.capture.fullState,'seed').result.kind).toBe('accepted')
    expect(commit(f.capture.fullState,'second').result.kind).toBe('refused')
    expect(commit(f.capture.baselineBytes,'different').result.kind).toBe('refused')
    const owner=delivery.openOwnerDelivery({host,document:f.document,actor})
    const event=delivery.nextOwnerApplication(owner)!
    delivery.acknowledgeOwnerDeliveryApplication(owner,{...event.metadata.accepted.receipt,localYDocSequence:2,applicationReplayed:false})
    complete();complete()
    expect(f.store.read('workspace','docs/a.md',1_000_000)!.completed).toBe(true)
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor}).kind).toBe('current')
    // While its activated native session is held, stopping access uses that session's verified owner transport.
    const drain=vi.spyOn(OwnerCommittedDelivery.prototype,'drain').mockResolvedValue({kind:'done'} as never)
    try{
      const active=activationDriver(f,vi.fn(async()=>f.capture))
      expect(await active.driver.activate(active.target,new AbortController().signal)).toMatchObject({kind:'done'})
      expect(active.driver.restoreConsumer(f.document,stop)).toBe(active.driver.consumer(f.document).consumer)
    }finally{drain.mockRestore()}
    f.raw.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2")
    expect(()=>f.store.resume({document:f.document,activationId:f.capture.activationId,host,registeredAtMs:5,guard(){}})).toThrow()
    f.raw.exec("UPDATE sync_relay_live_documents SET admission_state='closed'")
    // Without that session, a restore needs its operation to name the retained adoption, and refuses without one.
    const capture=vi.fn()
    expect(()=>activationDriver(f,capture).driver.restoreConsumer(f.document,stop)).toThrow('Service restore owner adoption is unavailable.')
    expect(capture).not.toHaveBeenCalled()
  }finally{f.close()}
})

it('rolls back the full activation when its retained-state quota charge fails',async()=>{
  const f=fixture();try{
    const before=f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()
    f.raw.exec("CREATE TRIGGER activation_quota_failure BEFORE INSERT ON sync_relay_service_activations BEGIN SELECT RAISE(ABORT,'activation quota fault'); END")
    await expect(f.prepare()).rejects.toThrow('activation quota fault')
    expect(f.storage.getLiveHostControl()!.registeredConnectionId).toBeNull()
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
    expect(f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()).toEqual(before)
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_document_ordinary_bases').all()).toEqual([])
  }finally{f.close()}
})

type RunDocument=ConstructorParameters<typeof ServiceActivationDriver>[0]['runDocument']
function activationDriver(f:ReturnType<typeof fixture>,captureOwnerActivation:ReturnType<typeof vi.fn>,sendRequest:ReturnType<typeof vi.fn>=vi.fn(async()=>({result:{released:true}})),
  runDocument:RunDocument=(_document,_signal,operation)=>operation(),native:object={},config:Partial<ServiceActivationConfig>={}){
  const pull=vi.fn(async()=>({hasMore:false})),wake=vi.fn(),target={workspaceId:'workspace',path:'docs/a.md'}
  const driver=new ServiceActivationDriver({trustedAccount:accountId=>({accountId,name:'Owner'}),storage:f.storage,history:f.history,host,
    client:{...native,captureOwnerActivation,sendRequest} as never,
    workspace:id=>id==='workspace'?{handle:'native-workspace',replica:{pull,publish:vi.fn()},identity:{replicationEpoch:'epoch',streamIdentity:'stream'}}:undefined,
    config:{targets:[target],validateActivation,validateAdmission:validateJournal,maxCaptureBytes:1_000_000,maxActivationHistoryEntries:10,maxEntriesPerDrain:10,maxBytesPerDrain:1_000_000,
      maxDocumentsPerPass:1,pollIntervalMs:1000,passDeadlineMs:10_000,idleUnloadMs:600_000,idleRetryMs:30_000,...config},
    adoption:{maxBytes:1_000_000,maxEvents:10},nextRequestId:()=>1,deadlineMs:1000,assertCurrent(){},registered(){},
    runDocument,lifetime:new AbortController().signal,wake,
  })
  return {driver,target,pull,wake}
}

// A completed service activation: adopted, seed accepted and applied natively.
async function completeActivation(f:ReturnType<typeof fixture>){
  await f.prepare()
  const access=f.store.pending(f.document,host),delivery=f.storage.createLiveCommittedDeliveryStore(f.history,access)
  const adoption=delivery.captureOwnerCut({host,document:f.document,actor,adoptionId:f.capture.activationId,
    expectedLocalSequence:2,maxBytes:1_000_000,maxEvents:100,throughCursor:0})
  delivery.acknowledgeOwnerAdoption(adoption,{adoptionId:f.capture.activationId,localYDocSequence:2,terminalCursor:0,adoptionReplayed:false})
  admitSeed(f,access)
  const owner=delivery.openOwnerDelivery({host,document:f.document,actor})
  const event=delivery.nextOwnerApplication(owner)!
  delivery.acknowledgeOwnerDeliveryApplication(owner,{...event.metadata.accepted.receipt,localYDocSequence:2,applicationReplayed:false})
  f.store.complete({document:f.document,host,access,nativeState:{adoptionId:f.capture.activationId,pendingBytes:0},guard(){}})
}
// Admits the captured full state as the pending activation's seed.
function admitSeed(f:ReturnType<typeof fixture>,access:ServiceActivationAccess,deliveryId='seed'){
  const current=f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor},access)
  const cut=f.storage.readLiveUpdateJournalCut({document:f.document})
  if(current.kind!=='current' || cut.kind!=='cut')throw new Error('Missing activation authority')
  const validation=validateJournal({document:f.document,currentPath:current.binding.currentPath,
    checkpoint:cut.cut.checkpoint.bytes,suffix:cut.cut.suffix.map(row=>row.bytes),candidate:f.capture.fullState})
  return f.storage.commitLiveUpdateJournal({host,actor,expectedAuthority:current.authority,
    metadata:{deliveryId,updateDigest:hash(f.capture.fullState),binding:current.binding},cutToken:cut.cut,validation,
    updateBytes:f.capture.fullState,receivedAtMs:4},access)
}
function deferred(){
  let resolve!:()=>void
  const promise=new Promise<void>(done=>{resolve=done})
  return {promise,resolve}
}
// The relay row change advanceStopRestoreFence commits, and its exact reversal.
function fenceRestore(f:ReturnType<typeof fixture>,fence:number){
  f.raw.prepare("UPDATE sync_relay_live_documents SET admission_state='closed',restore_fence_generation=? WHERE admission_state='open' AND restore_fence_generation=?")
    .run(fence+1,fence)
  expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor}).kind).not.toBe('current')
}
function reopen(f:ReturnType<typeof fixture>,fence:number){
  f.raw.prepare("UPDATE sync_relay_live_documents SET admission_state='open',restore_fence_generation=?").run(fence)
}
const ownerTip=(f:ReturnType<typeof fixture>)=>Number(f.raw.prepare('SELECT tip_cursor FROM sync_relay_live_delivery_owners').get()!.tip_cursor)
// Admits an owner edit after the seed for the next drain to apply natively.
const commitEdit=(f:ReturnType<typeof fixture>)=>admitEdit(f).metadata.accepted.receipt
function admitEdit(f:ReturnType<typeof fixture>){
  const current=f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor}),cut=f.storage.readLiveUpdateJournalCut({document:f.document})
  if(current.kind!=='current' || cut.kind!=='cut')throw new Error('Missing owner authority')
  const doc=new Y.Doc();Y.applyUpdate(doc,f.capture.fullState);const before=Y.encodeStateVector(doc)
  doc.getMap('frontmatter').set('title','Edited again')
  const bytes=Y.encodeStateAsUpdate(doc,before);doc.destroy()
  const validation=validateJournal({document:f.document,currentPath:current.binding.currentPath,
    checkpoint:cut.cut.checkpoint.bytes,suffix:cut.cut.suffix.map(row=>row.bytes),candidate:bytes})
  const committed=f.storage.commitLiveUpdateJournal({host,actor,expectedAuthority:current.authority,
    metadata:{deliveryId:'edit',updateDigest:hash(bytes),binding:current.binding},cutToken:cut.cut,validation,updateBytes:bytes,receivedAtMs:5})
  if(!committed.admitted)throw new Error(JSON.stringify(committed.result))
  return committed.admitted
}
// Native replies for the resumed, adopted service owner. `park` holds the next
// call to one method after it enters, until the test releases it.
function nativeOwner(f:ReturnType<typeof fixture>){
  const durable=new Map<string,LiveUpdateHostApplicationAck>()
  let parked:{method:string;entered:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>;lose:boolean}|undefined
  const hold=async(method:string)=>{
    const held=parked;if(held?.method!==method)return false
    parked=undefined;held.entered.resolve();await held.release.promise
    return held.lose
  }
  const sendRequest=vi.fn(async(request:{id:number;method:string;params:Record<string,unknown>})=>{
    await hold(request.method)
    if(request.method==='liveApplication.register')return {id:request.id,result:{registrationId:7}}
    if(request.method==='liveApplication.ownerState')return {id:request.id,result:{adoptionId:f.capture.activationId,
      expectedLocalSequence:f.capture.source.nativeHeadSequence,throughCursor:0,outboxId:null,pendingBytes:0,outboxState:'active',retryDeliveryId:null}}
    if(request.method==='liveApplication.settle'){
      const terminal=request.params.terminalReceipt as LiveUpdateReceipt|null
      return {id:request.id,result:{status:'settled',settlement:{settlementId:'settlement',previousCursor:0,terminalCursor:terminal?.journalCursor??0,
        applicationCount:0,localYDocSequence:3,momentId:'settled-moment',markdownDigest:'c'.repeat(64),materialized:true,collectionReconcileRequired:false}}}
    }
    throw new Error(`Unexpected native request ${request.method}.`)
  })
  const sendLiveApplication=vi.fn(async(request:{id:number},event:{metadata:{accepted:{receipt:LiveUpdateReceipt}}})=>{
    const ack={...event.metadata.accepted.receipt,localYDocSequence:3,applicationReplayed:false}
    durable.set(ack.deliveryId,ack)
    if(await hold('sendLiveApplication'))throw new Error('Native application response was lost.')
    return {id:request.id,result:{status:'applied',ack}}
  })
  const readLiveApplicationAck=vi.fn(async(_request:unknown,receipt:LiveUpdateReceipt)=>{
    const ack=durable.get(receipt.deliveryId);return ack?{...ack,applicationReplayed:true}:null
  })
  return {client:{sendRequest,sendLiveApplication,readLiveApplicationAck},
    park(method:string,lose=false){parked={method,entered:deferred(),release:deferred(),lose};return parked}}
}

// A completed driver whose document work runs through real serialization, with
// a barrier that reports when an activation has passed its precheck and queued.
async function serializedActivation(f:ReturnType<typeof fixture>,native?:ReturnType<typeof nativeOwner>['client']){
  const work=new LiveDocumentWork(),key=JSON.stringify(parseLiveDocumentKey(f.document))
  let entered=deferred()
  const runDocument:RunDocument=(document,signal,operation)=>{
    entered.resolve()
    return work.run(JSON.stringify(parseLiveDocumentKey(document)),signal,operation)
  }
  const send=native?.sendRequest??vi.fn(async()=>({result:{released:true}})),capture=vi.fn(async()=>f.capture)
  await completeActivation(f)
  const d=activationDriver(f,capture,send,runDocument,native),signal=new AbortController().signal
  const fence=Number(f.raw.prepare('SELECT restore_fence_generation AS fence FROM sync_relay_live_documents').get()!.fence)
  // Queue an activation behind other document work, apply `change` while it
  // waits, then let it run.
  const queueBehind=async(change:()=>void,settle?:Parameters<typeof d.driver.activate>[2])=>{
    const holder=deferred(),holding=work.run(key,signal,()=>holder.promise)
    entered=deferred()
    const queued=d.driver.activate(d.target,signal,settle)
    await entered.promise
    expect(work.busy(key)).toBe(true)
    change()
    holder.resolve();await holding
    return queued
  }
  return {d,work,key,send,capture,signal,fence,queueBehind}
}

// Proves: a fence committed while real owner delivery awaits native application
// is pending, not damaged evidence. Neither the applied reply nor durable ACK
// recovery after a lost reply is acknowledged on the fenced binding, and the
// same owner applies the entry once the exact binding opens.
it.each([['lost',true]] as const)('reports a restore fence during native owner application with an %s reply',async(_reply,lose)=>{
  const f=fixture()
  try{
    const native=nativeOwner(f),{d,capture,signal,fence}=await serializedActivation(f,native.client)
    expect(await d.driver.activate(d.target,signal)).toMatchObject({kind:'done'})
    const edit=commitEdit(f),tip=ownerTip(f)
    const parked=native.park('sendLiveApplication',lose),pass=d.driver.activate(d.target,signal)
    await parked.entered.promise
    fenceRestore(f,fence)
    parked.release.resolve()
    await expect(pass).resolves.toMatchObject({kind:'pending'})
    expect(ownerTip(f)).toBe(tip)
    expect(native.client.readLiveApplicationAck).not.toHaveBeenCalled()
    expect(()=>d.driver.consumer(f.document)).toThrow('incomplete')
    expect(d.driver.workspaceReady('workspace')).toBe(false)
    reopen(f,fence)
    expect(await d.driver.activate(d.target,signal)).toMatchObject({kind:'done'})
    expect(ownerTip(f)).toBe(edit.journalCursor)
    expect(capture).toHaveBeenCalledTimes(1)
  }finally{vi.restoreAllMocks();f.close()}
})

// Cancellation during settlement wins over a fence, and first readiness is not published.
it.each([['a fenced',true]] as const)('keeps cancellation when settlement resolves after an abort with %s binding',async(_binding,fence)=>{
  const f=fixture()
  try{
    const native=nativeOwner(f),{d,fence:generation}=await serializedActivation(f,native.client)
    const abort=new AbortController(),reason=new Error('Pass cancelled.')
    await expect(d.driver.activate(d.target,abort.signal,async()=>{if(fence)fenceRestore(f,generation);abort.abort(reason)})).rejects.toBe(reason)
    expect(()=>d.driver.consumer(f.document)).toThrow('incomplete')
    expect(d.driver.workspaceReady('workspace')).toBe(false)
  }finally{vi.restoreAllMocks();f.close()}
})

// Proves: a restore cannot start while the document's service activation is
// pending, before or after native adoption. Once fenced, that activation could
// never complete, and the service restore consumer requires a completed one.
it.each([['after',true]] as const)('refuses to start a restore while service activation is pending %s native adoption',async(_when,adopted)=>{
  const f=fixture();try{
    if(adopted)(await ownerCapture(f)).acknowledge();else await f.prepare()
    f.raw.exec("INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES ('grant','share','user','reader',NULL,'edit',1,'active',0,NULL,NULL)")
    expect(()=>f.storage.readStopRestorePlan({document:f.document,ownerUserId:'owner',operationId:'restore',shareId:'share',grantId:'grant',
      restorePointCursor:0,restorePointReceiptDigest:f.document.lineageClaimId,maxOutputBytes:1_000_000})).toThrow('Live editing is still starting.')
    const intent:StopRestoreIntent={deliveryKind:adopted?'owner':'bootstrap',operationId:'restore',ownerUserId:'owner',document:f.document,
      shareId:'share',grantId:'grant',expectedGrantGeneration:1,expectedDependentGrantIds:[],expectedFence:1,restorePointCursor:0,
      restorePointReceiptDigest:f.document.lineageClaimId}
    expect(()=>f.storage.beginStopRestore(intent,40)).toThrow('Live editing is still starting.')
    expect(f.storage.getShareGrant('grant')).toMatchObject({status:'active',generation:1})
    expect(f.raw.prepare('SELECT admission_state,restore_fence_generation AS fence FROM sync_relay_live_documents').get()).toEqual({admission_state:'open',fence:1})
  }finally{f.close()}
})

// Validation runs in a child process, so running out of heap ends that child, not the relay.
it('refuses a capture whose validation runs out of heap, blocks it for its owner, and activates the next capture',async()=>{
  const pool=createLiveValidationExecutor(128),large=fixture('a\n\n'.repeat(80_000),true),f=fixture()
  try{
    const send=vi.fn(async()=>({result:{released:true}})),validate=pool.ordinaryActivation(policy)
    const d=activationDriver(large,vi.fn(async()=>large.capture),send,undefined,undefined,
      {validateActivation:validate,maxCaptureBytes:67_108_864,maxBytesPerDrain:67_108_864})
    expect(await d.driver.activate(d.target,new AbortController().signal)).toEqual({kind:'pending',reason:new ServiceActivationTooLarge().message})
    expect(send).toHaveBeenCalledWith(expect.objectContaining({method:'liveApplication.releaseOwnerActivation',
      params:{activationId:large.capture.activationId,sessionId:'real-session'}}),expect.any(AbortSignal))
    expect(large.raw.prepare('SELECT * FROM sync_relay_service_activations').all()).toEqual([])
    expect(large.storage.getLiveHostControl()!.registeredConnectionId).toBeNull()
    // Passes skip it until its owner tries again.
    expect(d.driver.blocked(d.target)).toBe('refused')
    expect(await d.driver.activate(d.target,new AbortController().signal)).toMatchObject({kind:'pending',reason:'Hosted document is blocked until the owner tries again.'})
    expect(await f.prepare(bounds,validate)).toEqual({document:f.document,replayed:false,completed:false})
  }finally{await pool.close();large.close();f.close()}
},60_000)

// A document whose activation keeps failing for a reason nothing classifies waits longer before each try, so it isn't captured on every pass.
it('waits longer before each retry of an activation that keeps failing, and tries at once after its owner resumes',async()=>{
  const f=fixture();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(0)
  try{
    const capture=vi.fn(async():Promise<NativeOwnerActivation>=>{throw new Error('Engine is unavailable.')}),signal=()=>new AbortController().signal
    const d=activationDriver(f,capture),waiting={kind:'pending',reason:'Hosted document waits before it tries again.'}
    // A pass that ended says nothing about the document, so it counts nothing.
    for(let i=0;i<3;i++)await expect(d.driver.activate(d.target,AbortSignal.abort(new Error('Pass ended.')))).rejects.toThrow('Pass ended.')
    await expect(d.driver.activate(d.target,signal())).rejects.toThrow('Engine is unavailable.')
    await expect(d.driver.activate(d.target,signal())).rejects.toThrow('Engine is unavailable.')
    expect(await d.driver.activate(d.target,signal())).toEqual(waiting)
    vi.setSystemTime(1000)
    await expect(d.driver.activate(d.target,signal())).rejects.toThrow('Engine is unavailable.')
    vi.setSystemTime(2999)
    expect(await d.driver.activate(d.target,signal())).toEqual(waiting)
    vi.setSystemTime(3000)
    await expect(d.driver.activate(d.target,signal())).rejects.toThrow('Engine is unavailable.')
    expect(capture).toHaveBeenCalledTimes(4)
    // The wait grows to five minutes and no further.
    for(let i=0;i<10;i++){vi.setSystemTime(Date.now()+300_000);await expect(d.driver.activate(d.target,signal())).rejects.toThrow('Engine is unavailable.')}
    vi.setSystemTime(Date.now()+299_999)
    expect(await d.driver.activate(d.target,signal())).toEqual(waiting)
    d.driver.unblock(d.target)
    capture.mockImplementation(async()=>f.capture)
    vi.spyOn(OwnerCommittedDelivery.prototype,'drain').mockResolvedValue({kind:'pending',reason:'transport interrupted',continueDrain:false})
    expect(await d.driver.activate(d.target,signal())).toMatchObject({kind:'pending',reason:'transport interrupted'})
    expect(capture).toHaveBeenCalledTimes(15)
  }finally{vi.restoreAllMocks();vi.useRealTimers();f.close()}
})

// A write can land between validation and the transaction without moving the relay cursor.
it('refuses a capture as stale when its history changes after validation',async()=>{
  const f=fixture();try{
    const validate:OrdinaryActivationValidator=async work=>{
      const result=await validateActivation(work)
      f.raw.prepare('UPDATE sync_relay_log SET settlement_admission_json=? WHERE relay_seq=3')
        .run(JSON.stringify({status:'refused',settlementId:'late',reason:'authorship-mismatch'}))
      return result
    }
    await expect(f.prepare(bounds,validate)).rejects.toThrow(ServiceActivationStaleCut)
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
    expect(f.raw.prepare('SELECT * FROM sync_relay_service_activations').all()).toEqual([])
    expect(f.storage.getLiveHostControl()!.registeredConnectionId).toBeNull()
  }finally{f.close()}
})

// Proves: a restarted driver catches its replica up before resuming, and the
// resume keeps the retained activation ID and cut even when the relay advanced
// past that cut, where a fresh capture would be stale.
it('restarts a pending activation with its retained ID and cut after catching up, without selecting a new cut',async()=>{
  const f=fixture(),drain=vi.spyOn(OwnerCommittedDelivery.prototype,'drain').mockResolvedValue({kind:'pending',reason:'transport interrupted',continueDrain:false})
  try{
    const initial=activationDriver(f,vi.fn(async()=>f.capture))
    await initial.driver.activate(initial.target,new AbortController().signal)
    expect(()=>initial.driver.consumer(f.document)).toThrow('incomplete')
    const order:string[]=[],send=vi.fn(async()=>({result:{released:true}}))
    const capture=vi.fn(async()=>{order.push('capture');return {...f.capture,sessionId:'reopened-native-session'}})
    const resumed=activationDriver(f,capture,send)
    resumed.pull.mockImplementation(async()=>{
      order.push('pull')
      f.raw.exec("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','other',1,'object.snapshot','{}',3)")
      return {hasMore:false}
    })
    await expect(resumed.driver.activate(resumed.target,new AbortController().signal,undefined,new Map())).resolves.toMatchObject({kind:'pending',reason:'transport interrupted'})
    expect(order).toEqual(['pull','capture'])
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({workspace:'native-workspace'}),'docs/a.md',1_000_000,expect.any(AbortSignal),f.capture.activationId)
    expect(send).not.toHaveBeenCalled()
    expect(f.raw.prepare('SELECT count(*) AS n FROM sync_relay_service_activations').get()).toEqual({n:1})
    expect(f.store.read('workspace','docs/a.md',1_000_000)).toMatchObject({activationId:f.capture.activationId,source:f.capture.source})
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor}).kind).toBe('refused')
  }finally{drain.mockRestore();f.close()}
})

// Enrolls the fixture's document for the service host under an active Edit grant.
const enrollment={workspaceId:'workspace',path:'docs/a.md',shareId:'share',ownerUserId:'owner',guard(){}}
function enroll(f:ReturnType<typeof fixture>){
  f.raw.exec(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES ('grant','share','user','reader',NULL,'edit',1,'active',0,NULL,NULL)`)
  return f.storage.ensureOwnedLiveDocument({intent:'share',...enrollment,nowMs:1})
}
// Stops as a running service host does, with its preparation of the activation its engine blocked.
const stopDocument=(f:ReturnType<typeof fixture>,nowMs:number)=>preparedStop(f.storage,{...enrollment,enabled:false,retire:true,nowMs})
const resumeDocument=(f:ReturnType<typeof fixture>,nowMs:number)=>f.storage.ensureOwnedLiveDocument({intent:'owner-resume',...enrollment,nowMs})
const retirement=(storage:unknown)=>readServiceActivationRetirement(storage as StorageContext,{workspaceId:'workspace',objectId:'object'})
const generation=(f:ReturnType<typeof fixture>)=>Number(f.raw.prepare('SELECT restore_fence_generation AS fence FROM sync_relay_live_documents').get()!.fence)
const refused={kind:'refused',reason:'host-unavailable'}
const credential={key:new Uint8Array(32).fill(7),namespace:'history'}
const keyOf=({objectId,lineageClaimId,activationId,restoreFenceGeneration,acceptedThrough}:NonNullable<ReturnType<typeof retirement>>)=>
  ({objectId,lineageClaimId,activationId,restoreFenceGeneration,acceptedThrough})
// The released boundary at the journal row a receipt names.
function boundaryAt(f:ReturnType<typeof fixture>,receipt:LiveUpdateReceipt){
  const row=f.raw.prepare('SELECT accepted_event_count AS count,accepted_evidence_digest AS digest FROM sync_relay_live_update_journal WHERE journal_cursor=?').get(receipt.journalCursor)!
  return {terminalReceipt:{deliveryId:receipt.deliveryId,updateDigest:receipt.updateDigest,journalCursor:receipt.journalCursor,acceptingHostEpoch:receipt.acceptingHostEpoch},
    eventCount:Number(row.count),historyEvidenceDigest:String(row.digest)}
}
// The boundary a release keeps: the retiring owner's applied tip.
const ownerBoundary=(f:ReturnType<typeof fixture>)=>
  boundaryAt(f,JSON.parse(String(f.raw.prepare('SELECT tip_receipt_json FROM sync_relay_live_delivery_owners').get()!.tip_receipt_json)))

it('records the exact activation and F in Stop, and keeps that fence through a duplicate Stop, a restart and an early Resume',async()=>{
  const f=fixture();let reopened:ReturnType<typeof openSyncRelayStorage>|undefined
  try{
    enroll(f);await completeActivation(f);const edit=commitEdit(f)
    expect(stopDocument(f,10)).toMatchObject({retired:true,acceptedCursor:edit.journalCursor})
    const recorded={relayDatabaseNamespace:'history',activationId:f.capture.activationId,workspaceId:'workspace',mainVersionId:'main',objectId:'object',
      lineageClaimId:f.document.lineageClaimId,path:'docs/a.md',restoreFenceGeneration:generation(f),acceptedThrough:edit.journalCursor,requestedAtMs:10}
    expect(retirement(f.storage)).toEqual(recorded)
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor})).toEqual(refused)
    // A duplicate Stop returns the original fence, and the accepted cursor it names cannot move.
    expect(stopDocument(f,30)).toMatchObject({acceptedCursor:edit.journalCursor})
    expect(retirement(f.storage)).toEqual(recorded)
    reopened=openSyncRelayStorage(f.path)
    expect(retirement(reopened)).toEqual(recorded)
    // Resume enables the enrollment but never reopens the retiring activation.
    expect(resumeDocument(f,40)).toMatchObject({enabled:true,retired:false})
    expect(f.storage.ensureOwnedLiveDocument({intent:'share',...enrollment,nowMs:50})).toMatchObject({enabled:true})
    expect(retirement(f.storage)).toEqual(recorded)
    expect(f.storage.serviceHostDocumentEnabled(f.document)).toBe(false)
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor})).toEqual(refused)
    expect(()=>f.store.resume({document:f.document,activationId:f.capture.activationId,host,registeredAtMs:6,guard(){}})).toThrow()
  }finally{reopened?.close();f.close()}
})

it('completes a retirement once: archives the owner row, refunds the retained state exactly once, and replays without touching a successor',async()=>{
  const f=fixture();try{
    enroll(f);await completeActivation(f);const edit=commitEdit(f)
    const current=f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor})
    if(current.kind!=='current')throw new Error('Missing owner authority')
    stopDocument(f,10);resumeDocument(f,15)
    const owner=f.raw.prepare('SELECT * FROM sync_relay_live_delivery_owners').get()!,tip=JSON.parse(String(owner.tip_receipt_json)) as LiveUpdateReceipt
    const endpoint=(receipt:LiveUpdateReceipt)=>boundaryAt(f,receipt)
    const key={objectId:'object',lineageClaimId:f.document.lineageClaimId,activationId:f.capture.activationId,restoreFenceGeneration:generation(f),acceptedThrough:edit.journalCursor}
    const complete=(boundary=endpoint(tip),changes={})=>f.store.completeRetirement({workspaceId:'workspace',key,boundary,host,registeredAtMs:20,nowMs:20,guard(){},...changes})
    const usage=()=>Number(f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()!.usage_bytes)
    const activation=()=>f.raw.prepare('SELECT state_bytes,accounted_bytes,retired_at_ms,retired_boundary_json FROM sync_relay_service_activations').get()!
    const before={usage:usage(),accounted:Number(activation().accounted_bytes)}
    // Retirement keeps what the owner applied; the accepted edit it never applied refuses.
    expect(()=>complete(endpoint(edit))).toThrow('differs from its release')
    expect(()=>complete({...endpoint(tip),eventCount:99})).toThrow('differs from the live journal')
    expect(()=>complete(endpoint(tip),{key:{...key,acceptedThrough:edit.journalCursor+1}})).toThrow('retirement is unavailable')
    // A generation that moved with no restore running is not the one the key names.
    f.raw.exec('UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1')
    expect(()=>complete()).toThrow('names another generation')
    f.raw.exec('UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation-1')
    expect(usage()).toBe(before.usage)
    const origin=()=>readServiceActivationOrigin(f.storage as StorageContext,'history',f.document,f.capture.activationId)
    expect(origin()).not.toBeNull()
    expect(complete()).toEqual({status:'retired',replayed:false})
    const boundaryJson=JSON.stringify(endpoint(tip)),refund=f.capture.fullState.length-Buffer.byteLength(boundaryJson)
    // Only a successor's prepare reserves the next adoption.
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_delivery_reservations WHERE journal_cursor=0').all()).toEqual([])
    expect(usage()).toBe(before.usage-refund)
    expect(activation()).toEqual({state_bytes:null,accounted_bytes:before.accounted-refund,retired_at_ms:20,retired_boundary_json:boundaryJson})
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_delivery_owners').all()).toEqual([])
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_delivery_owner_history').all()).toEqual([{...owner,activation_id:f.capture.activationId}])
    expect(retirement(f.storage)).toBeNull()
    // Retired with no successor, the document admits no ordinary live update and offers no retained activation.
    expect(f.storage.serviceHostDocumentEnabled(f.document)).toBe(true)
    expect(allowsServiceActivation(f.storage as StorageContext,{document:f.document,actor},host,current.binding)).toBe(false)
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor})).toEqual(refused)
    expect(f.store.read('workspace','docs/a.md',1_000_000)).toBeNull()
    // Its archived owner row's origin starts no delivery.
    expect(origin).toThrow('Retained service activation origin differs.')
    // An exact replay changes nothing, not even a successor's owner row on the same lineage.
    const successor={...owner,origin_json:JSON.stringify({...JSON.parse(String(owner.origin_json)),adoptionId:'successor-activation'})}
    f.raw.prepare(`INSERT INTO sync_relay_live_delivery_owners(${Object.keys(successor).join(',')}) VALUES (${Object.keys(successor).map(()=>'?').join(',')})`)
      .run(...Object.values(successor) as never[])
    expect(complete()).toEqual({status:'retired',replayed:true})
    expect(usage()).toBe(before.usage-refund)
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_delivery_owners').all()).toEqual([successor])
    expect(()=>complete({...endpoint(tip),eventCount:endpoint(tip).eventCount+1})).toThrow('another boundary')
  }finally{f.close()}
})

// Proves: the host's drain of a stopped last document leaves the workspace its
// hosted credential and settling scope while the activation retires, and both
// end once it has.
it('keeps the hosted credential and settling scope through the release of a stopped last document until its activation retires',async()=>{
  const f=fixture();try{
    enroll(f);await completeActivation(f)
    const bearer=deriveServiceHostBearer(f.storage.currentServiceHostWorkspace('workspace')!,credential)
    const hosted=()=>authorizeServiceHostReplication(f.storage,{...credential,workspaceId:'workspace',bearer,method:'GET',pathname:'/sync/workspace/hosted/log'})
    stopDocument(f,10)
    const open=retirement(f.storage)!
    expect(f.storage.releaseServiceHostEnrollment({workspaceId:'workspace',objectId:'object',nowMs:11})).toMatchObject({retired:true,hostDrainedAtMs:11})
    expect(hosted()).toBe('owner')
    expect(f.storage.readServiceHostFeedScope('workspace')?.settling).toEqual(new Map([['object',open]]))
    expect(f.store.completeRetirement({workspaceId:'workspace',key:keyOf(open),boundary:ownerBoundary(f),host,registeredAtMs:20,nowMs:20,guard(){}}))
      .toEqual({status:'retired',replayed:false})
    expect(hosted()).toBeNull()
    expect(f.storage.readServiceHostFeedScope('workspace')).toBeNull()
  }finally{f.close()}
})

// Proves: a restore that advanced the generation after the obligation opened
// carries the obligation to it, so the old key no longer completes it, and
// defers completion at the carried key while it is unfinished. Nothing is
// archived or refunded.
it('defers completing a retirement while a restore that advanced its generation is unfinished',async()=>{
  const f=fixture();try{
    enroll(f);await completeActivation(f)
    const fence=generation(f)
    f.storage.beginStopRestore({deliveryKind:'owner',operationId:'restore',ownerUserId:'owner',document:f.document,shareId:'share',grantId:'grant',
      expectedGrantGeneration:1,expectedDependentGrantIds:[],expectedFence:fence,restorePointCursor:0,restorePointReceiptDigest:f.document.lineageClaimId},20)
    // The shared retirement path can open an obligation while a restore runs.
    const open=(f.storage as StorageContext).tx(()=>openServiceActivationRetirement(f.storage as StorageContext,f.document,30))!
    expect(open.restoreFenceGeneration).toBe(fence)
    f.storage.advanceStopRestoreFence({operationId:'restore',workspaceId:'workspace',ownerUserId:'owner'},40)
    expect(generation(f)).toBe(fence+1)
    const rows=()=>f.raw.prepare(`SELECT (SELECT usage_bytes FROM sync_relay_workspace_usage) AS usage,(SELECT count(*) FROM sync_relay_live_delivery_owners) AS owners,
      (SELECT count(*) FROM sync_relay_live_delivery_owner_history) AS archived,(SELECT retired_at_ms FROM sync_relay_service_activations) AS retired`).get()
    const before=rows(),carried={...open,restoreFenceGeneration:fence+1}
    expect(retirement(f.storage)).toEqual(carried)
    const complete=(key:ReturnType<typeof keyOf>)=>f.store.completeRetirement({workspaceId:'workspace',key,boundary:ownerBoundary(f),host,registeredAtMs:50,nowMs:50,guard(){}})
    expect(()=>complete(keyOf(open))).toThrow('Service activation retirement is unavailable.')
    expect(complete(keyOf(carried))).toEqual({status:'pending',reason:'restore'})
    expect(rows()).toEqual({...before,owners:1,archived:0,retired:null})
    expect(retirement(f.storage)).toEqual(carried)
  }finally{f.close()}
})

const SUCCESSOR=`ordinary-activation-${'b'.repeat(64)}`
// A completed activation retired at the seed its owner applied. The edit accepted after it, at F, waits for a successor.
async function retirePredecessor(f:ReturnType<typeof fixture>){
  enroll(f);await completeActivation(f);const edit=commitEdit(f)
  stopDocument(f,10);resumeDocument(f,15)
  const boundary=ownerBoundary(f)
  expect(f.store.completeRetirement({workspaceId:'workspace',key:keyOf(retirement(f.storage)!),boundary,host,registeredAtMs:20,nowMs:20,guard(){}}))
    .toEqual({status:'retired',replayed:false})
  return {edit,boundary}
}
const successor=(f:ReturnType<typeof fixture>,source={})=>
  ({...f.capture,activationId:SUCCESSOR,source:{...f.capture.source,predecessorActivationId:f.capture.activationId,...source}})
const prepareSuccessor=(f:ReturnType<typeof fixture>,capture:NativeOwnerActivation=successor(f))=>
  f.store.prepare({capture,host,registeredAtMs:21,guard(){},validate:validateActivation,bounds})
const activations=(f:ReturnType<typeof fixture>)=>f.raw.prepare('SELECT activation_id,predecessor_activation_id FROM sync_relay_service_activations ORDER BY rowid').all()

it('refuses a successor while its predecessor retires, or that names another tail or none',async()=>{
  const f=fixture();try{
    enroll(f);await completeActivation(f);commitEdit(f);stopDocument(f,10)
    await expect(prepareSuccessor(f)).rejects.toThrow('Service activation is retiring.')
    resumeDocument(f,15)
    f.store.completeRetirement({workspaceId:'workspace',key:keyOf(retirement(f.storage)!),boundary:ownerBoundary(f),host,registeredAtMs:20,nowMs:20,guard(){}})
    await expect(prepareSuccessor(f,{...f.capture,activationId:SUCCESSOR})).rejects.toThrow('names another predecessor')
    await expect(prepareSuccessor(f,successor(f,{predecessorActivationId:`ordinary-activation-${'c'.repeat(64)}`}))).rejects.toThrow('names another predecessor')
    expect(activations(f)).toHaveLength(1)
  }finally{f.close()}
})

it('refuses a successor under a changed workspace identity, from another baseline, or from an unverified source',async()=>{
  const f=fixture();try{
    await retirePredecessor(f)
    await expect(prepareSuccessor(f,successor(f,{baseRelaySeq:1}))).rejects.toThrow('successor has another baseline')
    await expect(prepareSuccessor(f,successor(f,{sourceDigest:'b'.repeat(64)}))).rejects.toThrow('Native activation differs from the complete ordinary CRDT history.')
    expect(activations(f)).toHaveLength(1)
    expect(f.storage.rotateWorkspaceIdentity({workspaceId:'workspace',ownerUserId:'owner',replicationEpoch:'next-epoch',streamIdentity:'next-stream',rotatedAtMs:30})).toBe('rotated')
    await expect(prepareSuccessor(f,successor(f,{replicationEpoch:'next-epoch',streamIdentity:'next-stream'}))).rejects.toThrow('another owner or workspace identity')
    await expect(prepareSuccessor(f)).rejects.toThrow('another owner or workspace identity')
    expect(activations(f)).toHaveLength(1)
  }finally{f.close()}
})

// The prepared successor's adoption at its predecessor's released boundary, and the owner delivery after it.
async function adoptSuccessor(f:ReturnType<typeof fixture>,boundary:ReturnType<typeof ownerBoundary>){
  await prepareSuccessor(f)
  const access=f.store.pending(f.document,host),delivery=f.storage.createLiveCommittedDeliveryStore(f.history,access)
  const adoption=delivery.captureOwnerCut({host,document:f.document,actor,adoptionId:SUCCESSOR,expectedLocalSequence:2,maxBytes:1_000_000,maxEvents:100,throughCursor:0})
  expect(adoption.cut).toMatchObject({events:[],terminalReceipt:boundary.terminalReceipt,retainedPrefix:{...boundary,predecessorActivationId:f.capture.activationId}})
  delivery.acknowledgeOwnerAdoption(adoption,{adoptionId:SUCCESSOR,localYDocSequence:2,terminalCursor:boundary.terminalReceipt.journalCursor,adoptionReplayed:false})
  let sequence=2
  const apply=()=>{
    const owner=delivery.openOwnerDelivery({host,document:f.document,actor}),event=delivery.nextOwnerApplication(owner)!
    delivery.acknowledgeOwnerDeliveryApplication(owner,{...event.metadata.accepted.receipt,localYDocSequence:++sequence,applicationReplayed:false})
    return event.metadata.accepted.receipt
  }
  const complete=(pendingBytes=0)=>f.store.complete({document:f.document,host,access,nativeState:{adoptionId:SUCCESSOR,pendingBytes},guard(){}})
  return {access,apply,complete}
}
const completed=(f:ReturnType<typeof fixture>)=>f.raw.prepare('SELECT completion_json IS NOT NULL AS done FROM sync_relay_service_activations WHERE activation_id=?').get(SUCCESSOR)!.done

it('refuses to complete a successor without real ACKs through the last row, or with native bytes pending',async()=>{
  const f=fixture();try{
    const {boundary}=await retirePredecessor(f)
    const adopted=await adoptSuccessor(f,boundary)
    expect(()=>adopted.complete()).toThrow('application acknowledgement is missing')
    adopted.apply()
    expect(admitSeed(f,adopted.access,'successor-seed').result.kind).toBe('accepted')
    expect(()=>adopted.complete()).toThrow('application acknowledgement is missing')
    adopted.apply()
    expect(()=>adopted.complete(1)).toThrow('Native activation has not completed.')
    expect(completed(f)).toBe(0)
    adopted.complete()
    expect(completed(f)).toBe(1)
  }finally{f.close()}
})

const NEXT=`ordinary-activation-${'c'.repeat(64)}`

const optionsOf=(f:ReturnType<typeof fixture>)=>(f.storage as StorageContext).options
const usageOf=(f:ReturnType<typeof fixture>)=>Number(f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()!.usage_bytes)
// Workspace usage less what the live delivery and activation rows account for. A step that writes only those rows keeps it.
const unaccounted=(f:ReturnType<typeof fixture>)=>usageOf(f)-Number(f.raw.prepare(`SELECT
  (SELECT COALESCE(SUM(reserved_bytes+accounted_bytes),0) FROM sync_relay_live_delivery_reservations)+(SELECT COALESCE(SUM(accounted_bytes),0) FROM sync_relay_service_activations)+
  ${['owners','owner_history','hosts','documents','bootstraps','edges'].map(table=>`(SELECT COALESCE(SUM(accounted_bytes),0) FROM sync_relay_live_delivery_${table})`).join('+')} AS bytes`).get()!.bytes)
const adoptionReservations=(f:ReturnType<typeof fixture>)=>f.raw.prepare('SELECT host_id FROM sync_relay_live_delivery_reservations WHERE journal_cursor=0 ORDER BY host_id').all()

// Proves: Resume makes the successor's quota decision. Refused, it leaves the
// retired tail and its accounting as they were; once space is freed it
// prepares the successor with its adoption reservation.
it('refuses a successor at quota retryably, then prepares it with its adoption reservation once space is freed',async()=>{
  // One client ID gives both fixtures the same bytes, so `sized` measures f.
  const sized=fixture('Original',false,1),f=fixture('Original',false,1);try{
    await retirePredecessor(sized);const free=usageOf(sized);await prepareSuccessor(sized)
    const needed=usageOf(sized)-free,reservation=Number(sized.raw.prepare('SELECT reserved_bytes+accounted_bytes AS bytes FROM sync_relay_live_delivery_reservations WHERE journal_cursor=0').get()!.bytes)
    await retirePredecessor(f)
    const ledger=unaccounted(f),retired=f.raw.prepare('SELECT * FROM sync_relay_service_activations').all()
    // Room for the successor's activation, not its adoption.
    optionsOf(f).workspaceQuotaBytes=usageOf(f)+needed-reservation
    await expect(prepareSuccessor(f)).rejects.toThrow(SyncRelayQuotaExceededError)
    expect(f.raw.prepare('SELECT * FROM sync_relay_service_activations').all()).toEqual(retired)
    expect(adoptionReservations(f)).toEqual([])
    expect(unaccounted(f)).toBe(ledger)
    optionsOf(f).workspaceQuotaBytes+=reservation
    expect(await prepareSuccessor(f)).toEqual({document:f.document,replayed:false,completed:false})
    expect(usageOf(f)).toBe(optionsOf(f).workspaceQuotaBytes)
    expect(adoptionReservations(f)).toEqual([{host_id:'service'}])
    expect(unaccounted(f)).toBe(ledger)
  }finally{f.close();sized.close()}
})

function transitionHost(f:ReturnType<typeof fixture>,from:typeof host|{mode:'device'|'service';hostId:string;hostEpoch:ReturnType<typeof parseHostEpoch>;instanceId:string;connectionId:string},
  toMode:'device'|'service',toHostId:string){
  const transitionId=`transition-${from.hostEpoch}`
  const begin=f.storage.beginLiveHostTransition({from,toMode,toHostId,transitionId,startedAtMs:40,guard(){}})
  if(!begin.ok||!begin.snapshot.transition)throw new Error('transition refused')
  const transitionGeneration=begin.snapshot.transition.transitionGeneration
  if(!f.storage.commitLiveHostTransitionEpoch({transitionId,transitionGeneration,updatedAtMs:41}).ok)throw new Error('transition commit refused')
  const coordinate={mode:toMode,hostId:toHostId,hostEpoch:parseHostEpoch(from.hostEpoch+1),instanceId:`instance-${toHostId}`,connectionId:`connection-${toHostId}`}
  if(!f.storage.activateLiveHostTransition({...coordinate,transitionId,transitionGeneration,transitionFromEpoch:from.hostEpoch,updatedAtMs:42,guard(){}}).ok)throw new Error('activation refused')
  return coordinate
}

const reservedOn=(f:ReturnType<typeof fixture>,hostId:string)=>
  f.raw.prepare('SELECT journal_cursor AS cursor FROM sync_relay_live_delivery_reservations WHERE host_id=? ORDER BY journal_cursor').all(hostId).map(row=>Number(row.cursor))
const journalCursors=(f:ReturnType<typeof fixture>)=>f.raw.prepare('SELECT journal_cursor AS cursor FROM sync_relay_live_update_journal ORDER BY journal_cursor').all().map(row=>Number(row.cursor))
// The pending successor's adoption on `on` at its predecessor's released boundary.
function adoptSuccessorOn(f:ReturnType<typeof fixture>,on:ReturnType<typeof transitionHost>,boundary:ReturnType<typeof ownerBoundary>){
  const access=f.store.pending(f.document,on),delivery=f.storage.createLiveCommittedDeliveryStore(f.history,access)
  const adoption=delivery.captureOwnerCut({host:on,document:f.document,actor,adoptionId:SUCCESSOR,expectedLocalSequence:2,maxBytes:1_000_000,maxEvents:100,throughCursor:0})
  delivery.acknowledgeOwnerAdoption(adoption,{adoptionId:SUCCESSOR,localYDocSequence:2,terminalCursor:boundary.terminalReceipt.journalCursor,adoptionReplayed:false})
  return {access,delivery}
}

// Proves: a successor adopting on another host than its predecessor's needs
// no delivery through the prefix there, and is funded only there. The hosts it
// does not use keep what the earlier transitions funded until it retires,
// which releases all of it, and the host registers again throughout.
it("adopts a successor on another host than its predecessor's, funded only there until it retires",async()=>{
  const f=fixture();try{
    const {edit,boundary}=await retirePredecessor(f)
    const ledger=unaccounted(f)
    const device=transitionHost(f,host,'device','device'),other=transitionHost(f,device,'service','other') as typeof host
    expect(unaccounted(f)).toBe(ledger)
    await f.store.prepare({capture:successor(f),host:other,registeredAtMs:50,guard(){},validate:validateActivation,bounds})
    expect(adoptionReservations(f)).toEqual([{host_id:'other'}])
    const {access,delivery}=adoptSuccessorOn(f,other,boundary)
    const terminal=boundary.terminalReceipt.journalCursor,cursors=journalCursors(f)
    expect(reservedOn(f,'other')).toEqual([edit.journalCursor])
    expect(reservedOn(f,'device')).toEqual(cursors.filter(cursor=>cursor>terminal))
    expect(reservedOn(f,'service')).toEqual(cursors.filter(cursor=>cursor>terminal))
    expect(unaccounted(f)).toBe(ledger)
    expect(f.storage.registerLiveHost({...other,updatedAtMs:60,guard(){}}).ok).toBe(true)
    expect(unaccounted(f)).toBe(ledger)
    const owner=delivery.openOwnerDelivery({host:other,document:f.document,actor}),event=delivery.nextOwnerApplication(owner)!
    delivery.acknowledgeOwnerDeliveryApplication(owner,{...event.metadata.accepted.receipt,localYDocSequence:3,applicationReplayed:false})
    f.store.complete({document:f.document,host:other,access,nativeState:{adoptionId:SUCCESSOR,pendingBytes:0},guard(){}})
    stopDocument(f,60)
    expect(f.store.completeRetirement({workspaceId:'workspace',key:keyOf(retirement(f.storage)!),boundary:ownerBoundary(f),host:other,registeredAtMs:70,nowMs:70,guard(){}}))
      .toEqual({status:'retired',replayed:false})
    expect(f.raw.prepare('SELECT host_id,journal_cursor FROM sync_relay_live_delivery_reservations').all()).toEqual([])
    expect(unaccounted(f)).toBe(ledger)
    expect(f.storage.registerLiveHost({...other,updatedAtMs:80,guard(){}}).ok).toBe(true)
    expect(unaccounted(f)).toBe(ledger)
  }finally{f.close()}
})

// Proves: a Stop restore of a service activation's lineage on a host with no
// owner adoption there is refused before it revokes anything. Committed
// delivery refuses that lineage's bootstrap, so the operation could not finish.
// The owner reads why in each step, and the choices are refused the same way.
it("refuses a bootstrap Stop restore of a service activation's lineage before it revokes the grant",async()=>{
  const f=fixture();try{
    await completeActivation(f)
    f.raw.exec("INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES ('grant','share','user','reader',NULL,'edit',1,'active',0,NULL,NULL)")
    const restoreHost:OwnerRestoreHost={restoreConfigured:true,prepareRestore:vi.fn(),reviewRestore:vi.fn(),confirmRestore:vi.fn(),declineRestore:vi.fn()}
    const handler=testHandler(f.storage,{ownerRestoreHost:()=>restoreHost,newId:()=>'restore'})
    const post=(suffix:string,body:unknown)=>handler(new Request(`https://relay.test/sync/workspace/live-restores${suffix}`,{method:'POST',
      headers:{authorization:'Bearer user:owner','content-type':'application/json'},body:JSON.stringify(body)}))
    // The service host that adopted the lineage still offers Stop.
    const offered=await post('/options',{path:'docs/a.md'})
    expect(offered.status).toBe(200)
    expect((await offered.json()).grants).toMatchObject([{grantId:'grant'}])
    const b=transitionHost(f,host,'device','other-b')
    expect(f.storage.registerLiveHost({...b,updatedAtMs:50,guard(){}}).ok).toBe(true)
    const message="Stop access isn't available for this file on this session host. Access hasn't changed. Switch back to the session host this file used before, then try again."
    expect(()=>f.storage.readStopRestorePlan({document:f.document,ownerUserId:'owner',operationId:'restore',shareId:'share',grantId:'grant',
      restorePointCursor:0,restorePointReceiptDigest:f.document.lineageClaimId,maxOutputBytes:1_000_000})).toThrow(message)
    const intent:StopRestoreIntent={deliveryKind:'bootstrap',operationId:'restore',ownerUserId:'owner',document:f.document,
      shareId:'share',grantId:'grant',expectedGrantGeneration:1,expectedDependentGrantIds:[],expectedFence:1,restorePointCursor:0,
      restorePointReceiptDigest:f.document.lineageClaimId}
    expect(()=>f.storage.beginStopRestore(intent,60)).toThrow(message)
    const {ownerUserId:_owner,...publicIntent}=intent
    for(const [suffix,body] of [['/options',{path:'docs/a.md'}],
      ['/plan',{document:f.document,shareId:'share',grantId:'grant',restorePointCursor:0,restorePointReceiptDigest:f.document.lineageClaimId}],
      ['',{intent:publicIntent}]] as const){
      const refused=await post(suffix,body)
      expect(refused.status).toBe(409)
      expect(await refused.json()).toEqual({ok:false,code:'conflict',error:message})
    }
    expect(f.storage.getShareGrant('grant')).toMatchObject({status:'active',generation:1})
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_restore_operations').all()).toEqual([])
    expect(f.raw.prepare('SELECT admission_state,restore_fence_generation AS fence FROM sync_relay_live_documents').get()).toEqual({admission_state:'open',fence:1})
    expect(restoreHost.prepareRestore).not.toHaveBeenCalled()
  }finally{f.close()}
})

it.each([false,true])("refuses a never-adopted retirement on another host of an activation that adopted (completed: %s)",async completedHere=>{
  const f=fixture();try{
    enroll(f)
    if(completedHere)await completeActivation(f)
    else{
      await f.prepare()
      const delivery=f.storage.createLiveCommittedDeliveryStore(f.history,f.store.pending(f.document,host))
      const adoption=delivery.captureOwnerCut({host,document:f.document,actor,adoptionId:f.capture.activationId,expectedLocalSequence:2,maxBytes:1_000_000,maxEvents:100,throughCursor:0})
      delivery.acknowledgeOwnerAdoption(adoption,{adoptionId:f.capture.activationId,localYDocSequence:2,terminalCursor:0,adoptionReplayed:false})
    }
    const ledger=unaccounted(f)
    const device=transitionHost(f,host,'device','device'),other=transitionHost(f,device,'service','other') as typeof host
    stopDocument(f,50)
    const open=retirement(f.storage)!,rows=()=>f.raw.prepare(`SELECT (SELECT json_group_array(host_id) FROM sync_relay_live_delivery_owners) AS owners,
      (SELECT count(*) FROM sync_relay_live_delivery_reservations) AS reservations,(SELECT usage_bytes FROM sync_relay_workspace_usage) AS usage,
      (SELECT retired_at_ms FROM sync_relay_service_activations) AS retired`).get()
    const before=rows()
    expect(()=>f.store.completeRetirement({workspaceId:'workspace',key:keyOf(open),boundary:null,host:other,registeredAtMs:60,nowMs:60,guard(){}}))
      .toThrow('Retiring activation adopted on another host.')
    expect(rows()).toEqual(before)
    expect(retirement(f.storage)).toEqual(open)
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor})).toEqual(refused)
    // Back on A, the configured host provisions and registers as before.
    const again=transitionHost(f,transitionHost(f,other,'device','device'),'service','service') as typeof host
    expect(f.storage.registerLiveHost({...again,updatedAtMs:70,guard(){}}).ok).toBe(true)
    expect(unaccounted(f)).toBe(ledger)
    const boundary=completedHere?ownerBoundary(f):{terminalReceipt:null,eventCount:0,historyEvidenceDigest:initialAcceptedHistoryDigest('history',f.document)}
    expect(f.store.completeRetirement({workspaceId:'workspace',key:keyOf(open),boundary,host:again,registeredAtMs:80,nowMs:80,guard(){}}))
      .toEqual({status:'retired',replayed:false})
    expect(retirement(f.storage)).toBeNull()
    expect(f.raw.prepare("SELECT host_id,journal_cursor FROM sync_relay_live_delivery_reservations WHERE host_id<>'service'").all()).toEqual([])
    expect(unaccounted(f)).toBe(ledger)
  }finally{f.close()}
})

// Proves: an activation adopts on one host. Once the configuration moved, its
// adoption on the new host is refused with nothing changed, and A keeps provisioning.
it.each([true])("refuses an activation's adoption on the host its configuration moved to after it adopted on another (completed: %s)",async completedHere=>{
  const f=fixture();try{
    enroll(f)
    const adopt=(on:typeof host,access?:ServiceActivationAccess)=>{
      const delivery=f.storage.createLiveCommittedDeliveryStore(f.history,access)
      const adoption=delivery.captureOwnerCut({host:on,document:f.document,actor,adoptionId:f.capture.activationId,expectedLocalSequence:2,maxBytes:1_000_000,maxEvents:100,throughCursor:0})
      delivery.acknowledgeOwnerAdoption(adoption,{adoptionId:f.capture.activationId,localYDocSequence:2,terminalCursor:0,adoptionReplayed:false})
    }
    if(completedHere)await completeActivation(f)
    else{await f.prepare();adopt(host,f.store.pending(f.document,host))}
    const ledger=unaccounted(f)
    const device=transitionHost(f,host,'device','device'),other=transitionHost(f,device,'service','other') as typeof host
    const rows=()=>f.raw.prepare(`SELECT (SELECT json_group_array(json_array(host_id,origin_json)) FROM sync_relay_live_delivery_owners) AS owners,
      (SELECT json_group_array(json_array(host_id,journal_cursor)) FROM sync_relay_live_delivery_reservations) AS reservations,
      (SELECT usage_bytes FROM sync_relay_workspace_usage) AS usage`).get()
    const before=rows()
    expect(()=>adopt(other,completedHere?undefined:f.store.pending(f.document,other))).toThrow('Service activation adopted on another host.')
    expect(rows()).toEqual(before)
    const again=transitionHost(f,transitionHost(f,other,'device','device'),'service','service') as typeof host
    expect(f.storage.registerLiveHost({...again,updatedAtMs:70,guard(){}}).ok).toBe(true)
    expect(unaccounted(f)).toBe(ledger)
  }finally{f.close()}
})

const HOST_ORIGIN=`${SERVICE_HOST_ORIGIN_PREFIX}native`
type Row=[string,Record<string,unknown>]
// The service host's feed once Stop opened the retirement (or before, with
// `stopped` false): the owner applied the seed, and the edit accepted after
// it, at F, waits for its application.
async function retiringFeed(f:ReturnType<typeof fixture>,stopped=true){
  enroll(f);await completeActivation(f);const edit=admitEdit(f)
  const bearer=deriveServiceHostBearer(f.storage.currentServiceHostWorkspace('workspace')!,credential)
  const handle=createServiceHostReplication({activity: {wakeLog() {}}, storage:f.storage,prefix:'dohc-service-v1.',hostedFeed:true,
    authorize:input=>authorizeServiceHostReplication(f.storage,{...credential,...input})})
  const stop=()=>stopDocument(f,10)
  if(stopped)stop()
  const request=(method:string,suffix:string,body?:BodyInit,type='application/json')=>handle(new Request(`https://relay.test/sync/workspace/hosted/${suffix}`,
    {method,headers:{authorization:`Bearer ${bearer}`,...(body===undefined?{}:{'content-type':type})},...(body===undefined?{}:{body})}))
  const push=async(rows:Row[],firstSeq:number)=>{
    const response=await request('POST','log',JSON.stringify({replicationEpoch:'epoch',streamIdentity:'stream',originId:HOST_ORIGIN,
      ops:rows.map(([opKind,payload],index)=>({originSeq:firstSeq+index,opKind,recordedAtMs:20,payload}))}))
    return {status:response.status,body:await response.json() as Record<string,unknown>}
  }
  const upload=async(bytes:Uint8Array)=>{
    const response=await request('PUT',`blobs/${hash(bytes)}`,new Uint8Array(bytes),'application/octet-stream')
    expect(response.status).toBe(200)
    return await response.json() as Record<string,unknown>
  }
  const coordinate=(originSeq:number)=>f.raw.prepare('SELECT op_kind,relay_admission FROM sync_relay_log WHERE origin_id=? AND origin_seq=?').get(HOST_ORIGIN,originSeq)
  const receipt=edit.metadata.accepted.receipt
  const editBytes=new Uint8Array(f.raw.prepare('SELECT update_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?').get(receipt.journalCursor)!.update_bytes as Uint8Array)
  // Stands in for reconciliation recording that the retiring owner applied the edit.
  const applyEdit=()=>f.raw.prepare('UPDATE sync_relay_live_delivery_owners SET tip_cursor=?,tip_receipt_json=?').run(receipt.journalCursor,JSON.stringify(receipt))
  const ydocRow=(bytes:Uint8Array,changes:Record<string,unknown>={}):Row=>['ydoc.update',{versionId:'main',objectId:'object',path:'docs/a.md',contentKind:'richdoc',
    isBaseState:false,lineageClaimId:f.document.lineageClaimId,updateBlobSha256:hash(bytes),...changes}]
  const refusals=(...rows:Array<[number,string,string]>)=>rows.map(([originSeq,opKind,reason])=>({originId:HOST_ORIGIN,originSeq,opKind,reason}))
  return {edit,receipt,request,push,upload,coordinate,editBytes,applyEdit,ydocRow,refusals,stop}
}
const departed=(opKind:string)=>({op_kind:opKind,relay_admission:'departed'})
const markdownOf=(f:ReturnType<typeof fixture>,state:Uint8Array)=>{
  const projected=validateBaseline({document:f.document,currentPath:'docs/a.md',checkpoint:state})
  if(projected.kind!=='accepted')throw new Error(JSON.stringify(projected))
  return new TextEncoder().encode(projected.evidence.projectedMarkdown)
}

// Proves: a retiring document's host may publish its baseline, its retained
// source state and source moment as native writes it, each as a departed row
// that moves no projection; the moment's author fields prove no authorship.
// Anything else of the same document is refused at its coordinate.
it("admits only a retiring document's verified Y.Doc rows and source moment",async()=>{
  const f=fixture();try{
    const r=await retiringFeed(f)
    const source=markdownOf(f,f.capture.fullState),stray=new TextEncoder().encode('unproved bytes')
    expect(hash(source)).toBe(f.capture.source.sourceDigest)
    for(const bytes of [f.capture.baselineBytes,f.capture.fullState,source,stray])await r.upload(bytes)
    // The payload `outbound.rs` builds for a moment with no stored authors.
    const moment=(changes:Record<string,unknown>={}):Row=>['moment.append',{momentId:f.capture.source.sourceMomentId,versionId:'main',objectId:'object',
      objectCreatedAtMs:1,path:'docs/a.md',recordedAtMs:20,operation:'write',payloadBeforeBlobSha256:null,payloadBeforePath:null,
      payloadAfterBlobSha256:hash(source),payloadAfterPath:'docs/a.md',payloadBeforeContentKind:null,payloadBeforeByteLength:null,
      payloadAfterContentKind:'text',payloadAfterByteLength:source.length,metadata:{origin:'sync',summary:null,correlationId:null},authors:null,
      beforePresent:'null',beforeObjectId:null,beforeVersionId:null,beforePath:null,beforeBlobSha256:null,beforeContentKind:null,beforeByteLength:null,
      beforeUpdatedAtMs:null,beforeLatestMomentId:null,beforeMetadata:null,...changes}]
    const {beforePresent:_,...partial}=moment()[1],{authors:_authors,...unattributed}=moment()[1]
    const rows=[r.ydocRow(f.capture.baselineBytes,{isBaseState:true}),r.ydocRow(f.capture.fullState),moment(),
      r.ydocRow(f.capture.fullState,{lineageClaimId:'b'.repeat(64)}),r.ydocRow(stray),r.ydocRow(f.capture.baselineBytes),moment({momentId:'another-moment'}),
      moment({operation:'rename',path:'docs/b.md',payloadAfterPath:'docs/b.md',beforePath:'docs/a.md'}),moment({operation:'delete'}),moment({beforeObjectId:'other-object'}),
      moment({authors:[]}),['moment.append',partial] as Row,
      ['moment.append',{...unattributed,attributionUnavailable:{settlementId:'settlement',reason:'authorship-mismatch'},
        metadata:{origin:'sync',summary:'Attribution unavailable',correlationId:null}}] as Row,
      moment({authorContext:{kind:'account',accountId:'owner'}})]
    const answer=await r.push(rows,0)
    expect(answer).toMatchObject({status:200,body:{inserted:14}})
    expect(answer.body.refusals).toEqual(r.refusals([3,'ydoc.update','unproved-retirement-output'],[4,'ydoc.update','unproved-retirement-output'],
      [5,'ydoc.update','unproved-retirement-output'],[6,'moment.append','unproved-retirement-output'],[7,'moment.append','outside-hosted-documents'],
      [8,'moment.append','outside-hosted-documents'],[9,'moment.append','outside-hosted-documents'],[10,'moment.append','unproved-retirement-output'],
      [11,'moment.append','unproved-retirement-output']))
    for(const originSeq of [0,1,2,12,13])expect(r.coordinate(originSeq)).toEqual(departed(rows[originSeq]![0]))
    expect(f.raw.prepare('SELECT admitted_author_snapshot_json AS authors FROM sync_relay_log WHERE origin_id=? AND origin_seq IN (2,12,13)').all(HOST_ORIGIN))
      .toEqual([{authors:null},{authors:null},{authors:null}])
    expect(f.raw.prepare('SELECT moment_id FROM sync_relay_object_moments WHERE moment_id=?').get(f.capture.source.sourceMomentId)).toBeUndefined()
  }finally{f.close()}
})

// Proves: an application row and its authorless audit, in separate pushes,
// retry until the retiring owner applied them, keeping their coordinates; then
// publish as departed rows. Past F the same rows are refused.
it('retries a retiring application until its owner applied it, confirms its authorless audit in a later push, and refuses both beyond F',async()=>{
  const f=fixture();try{
    const r=await retiringFeed(f)
    await r.upload(r.editBytes)
    const content=r.ydocRow(r.editBytes)
    expect(await r.push([content],0)).toMatchObject({status:503,body:{code:'settlement_proof_budget'}})
    expect(f.storage.maxOriginSeq('workspace',HOST_ORIGIN)).toBe(-1)
    r.applyEdit()
    expect(await r.push([content],0)).toMatchObject({status:200,body:{inserted:1}})
    expect(r.coordinate(0)).toEqual(departed('ydoc.update'))
    const row=f.raw.prepare('SELECT * FROM sync_relay_live_update_journal WHERE journal_cursor=?').get(r.receipt.journalCursor)!
    const record={kind:'application',relayDatabaseNamespace:'history',eventCount:Number(row.accepted_event_count),evidenceDigest:String(row.accepted_evidence_digest),
      updateByteLength:r.editBytes.length,metadata:canonicalVersionedAcceptedMetadata(r.edit.metadata),sourceApplication:null,sourceRestore:null,cancelledRestores:[],
      contentCoordinate:{originId:HOST_ORIGIN,originSeq:0}}
    expect(record.metadata.authorSnapshot??[]).toEqual([])
    const bytes=new TextEncoder().encode(JSON.stringify(record));await r.upload(bytes)
    const audit:Row=['live.audit.application',{relayDatabaseNamespace:'history',mainVersionId:'main',objectId:'object',lineageClaimId:f.document.lineageClaimId,
      eventCount:record.eventCount,updateBlobSha256:r.receipt.updateDigest,
      manifest:{formatVersion:1,recordDigest:hash(bytes),byteLength:bytes.length,chunks:[{sha256:hash(bytes),byteLength:bytes.length}]}}]
    expect(await r.push([audit],1)).toMatchObject({status:200,body:{inserted:1}})
    expect(r.coordinate(1)).toEqual(departed('live.audit.application'))
    // Before the owner applied it, the audit waits too.
    f.raw.exec('UPDATE sync_relay_live_delivery_owners SET tip_cursor=tip_cursor-1')
    expect(await r.push([audit],2)).toMatchObject({status:503})
    r.applyEdit()
    // The edit is past a lower F.
    f.raw.exec('UPDATE sync_relay_service_activations SET retire_accepted_cursor=retire_accepted_cursor-1')
    expect((await r.push([content,audit],2)).body).toMatchObject({inserted:2,refusals:r.refusals([2,'ydoc.update','unproved-retirement-output'],
      [3,'live.audit.application','unproved-retirement-output'])})
  }finally{f.close()}
})

// A native-complete settlement of the retiring document through the edit at
// F, with its uploaded state and projection, as an audit or as its moment.
async function retiringSettlement(f:ReturnType<typeof fixture>,r:Awaited<ReturnType<typeof retiringFeed>>){
  const doc=new Y.Doc({gc:false});Y.applyUpdate(doc,f.capture.fullState);Y.applyUpdate(doc,r.editBytes)
  const state=Y.encodeStateAsUpdate(doc);doc.destroy()
  const markdown=markdownOf(f,state),before=markdownOf(f,f.capture.baselineBytes)
  for(const bytes of [state,markdown,before])await r.upload(bytes)
  const row=f.raw.prepare('SELECT * FROM sync_relay_live_update_journal WHERE journal_cursor=?').get(r.receipt.journalCursor)!
  const record:Record<string,unknown>={settlementId:'',relayDatabaseNamespace:'history',binding:r.edit.metadata.accepted.binding,
    hostCoordinate:{hostId:host.hostId,hostEpoch:1,instanceId:host.instanceId,connectionId:host.connectionId},previousCursor:0,
    terminalCursor:r.receipt.journalCursor,previousYdocSequence:0,localYdocSequence:2,applicationCount:1,nativeIntervalDigest:hash(Buffer.from('native-interval')),
    acceptedEventCount:Number(row.accepted_event_count),
    acceptedIntervalDigest:hash(Buffer.from(JSON.stringify(['live-settlement-accepted-interval-v1',['history','workspace','main','object',f.document.lineageClaimId],
      [0,0,initialAcceptedHistoryDigest('history',f.document)],[Number(row.accepted_event_count),r.receipt.journalCursor,row.accepted_evidence_digest]]))),
    momentId:'retiring-settlement-moment',markdownDigest:hash(markdown),sourceStateVectorDigest:hash(Buffer.from('state-vector')),
    acceptedStateBlobSha256:hash(state),recordedAtMs:20,restoreOperationId:null}
  record.settlementId=nativeSettlementId(record)
  const reference=(value:Record<string,unknown>)=>({formatVersion:1,recordDigest:settlementRecordDigest(value),record:value})
  const audit=(value=record):Row=>['live.audit.settlement',reference(value)]
  const moment=(value=record):Row=>['moment.append',{momentId:value.momentId,objectId:'object',versionId:'main',path:'docs/a.md',operation:'write',
    payloadBeforePath:'docs/a.md',payloadAfterPath:'docs/a.md',payloadBeforeContentKind:'text',payloadAfterContentKind:'text',
    payloadBeforeBlobSha256:hash(before),payloadAfterBlobSha256:hash(markdown),payloadAfterByteLength:markdown.length,recordedAtMs:20,settlementReference:reference(value)}]
  return {record,audit,moment}
}

// Proves: a settlement audit is proved on its own, before its moment arrives
// in a later push; both wait for the owner's applied tip; a record native
// would refuse proves nothing, as an audit or a moment.
it('proves a retiring settlement audit before its later moment, and refuses a settlement native would refuse',async()=>{
  const f=fixture();try{
    const r=await retiringFeed(f)
    const {record,audit,moment}=await retiringSettlement(f,r)
    expect(await r.push([audit()],0)).toMatchObject({status:503})
    r.applyEdit()
    const {nativeIntervalDigest:_,...abbreviated}=record
    const invalid=[{...record,acceptedEventCount:Number(record.acceptedEventCount)+1},abbreviated,{...record,settlementId:'retiring-settlement'},{...record,extra:true}]
    expect((await r.push([audit(invalid[0]),moment(invalid[0]),...invalid.slice(1).map(value=>audit(value))],0)).body).toMatchObject({inserted:5,
      refusals:r.refusals([0,'live.audit.settlement','unproved-retirement-output'],[1,'moment.append','unproved-retirement-output'],
        ...[2,3,4].map(seq=>[seq,'live.audit.settlement','unproved-retirement-output'] as [number,string,string]))})
    expect(await r.push([audit()],5)).toMatchObject({status:200,body:{inserted:1}})
    expect(r.coordinate(5)).toEqual(departed('live.audit.settlement'))
    expect(await r.push([moment()],6)).toMatchObject({status:200,body:{inserted:1}})
    expect(r.coordinate(6)).toEqual(departed('moment.append'))
    expect(f.raw.prepare('SELECT settlement_id FROM sync_relay_live_settlement_bindings').all()).toEqual([{settlement_id:record.settlementId}])
    expect(f.raw.prepare('SELECT moment_id FROM sync_relay_object_moments WHERE moment_id=?').get(String(record.momentId))).toBeUndefined()
  }finally{f.close()}
})

// A successor's capture whose source is the retiring host's settlement moment:
// the host published the edit it settled as a departed Y.Doc row, then the
// settlement's audit and, unless only the audit, its moment.
async function departedSettlementSource(f:ReturnType<typeof fixture>,published:'moment'|'audit'){
  const r=await retiringFeed(f);r.applyEdit()
  await r.upload(r.editBytes)
  const {record,audit,moment}=await retiringSettlement(f,r)
  const rows:Row[]=[r.ydocRow(r.editBytes),audit(),...(published==='moment'?[moment()]:[])]
  expect(await r.push(rows,0)).toMatchObject({status:200,body:{inserted:rows.length}})
  for(const [originSeq,[opKind]] of rows.entries())expect(r.coordinate(originSeq)).toEqual(departed(opKind))
  const state=Buffer.from(f.raw.prepare('SELECT content FROM sync_relay_blobs WHERE sha256=?').get(String(record.acceptedStateBlobSha256))!.content as Uint8Array)
  const markdown=markdownOf(f,state)
  Object.assign(f.capture,{fullState:state})
  Object.assign(f.capture.source,{committedCursor:Number(f.raw.prepare('SELECT MAX(relay_seq) AS seq FROM sync_relay_log').get()!.seq),
    sourceMomentId:String(record.momentId),sourceDigest:hash(markdown),sourceByteLength:markdown.length,fullStateDigest:hash(state),fullStateByteLength:state.length})
  return record
}
// Proves: a successor's source may be the retiring host's departed settlement
// moment, proved by the binding the relay committed with it. The departed
// Y.Doc row it settled counts as history: without it the states differ.
it('verifies a capture whose source is a departed settlement moment the relay proved',async()=>{
  const f=fixture();try{
    await departedSettlementSource(f,'moment')
    expect(await verify(f)).toEqual({verified:true})
  }finally{f.close()}
})
const unsettled='neither ordinary history nor a proved settlement',unproved='Native activation source settlement is not proved.'
it.each([
  ['its moment without the committed binding','moment',f=>{f.raw.exec('DELETE FROM sync_relay_live_settlement_bindings')},unsettled],
  ['pruned settled state','moment',f=>{f.raw.prepare('DELETE FROM sync_relay_blobs WHERE sha256=?').run(f.capture.source.fullStateDigest)},unproved],
] as [string,'moment'|'audit',(f:ReturnType<typeof fixture>)=>void,string][])('refuses a departed settlement source with %s',async(_case,published,change,message)=>{
  const f=fixture();try{
    await departedSettlementSource(f,published)
    change(f)
    await expect(verify(f)).rejects.toThrow(message)
  }finally{f.close()}
})

// Proves: the relay reads the engine's own event-zero audit bytes, which the
// engine's `update_native_audit_fixture` writes, in native's field order,
// with native's record digest and origin stamp, and refuses one field changed.
it("verifies the engine's own event-zero audit record digest and origin stamp",()=>{
  const db=new DatabaseSync(':memory:');try{
    const {payload}=nativeAuthoredSettlement.find(op=>op.opKind==='live.audit.base') as unknown as {payload:{record:Record<string,unknown>}}
    expect(nativeBaseRecord(db as unknown as SqliteDb,payload).record).toEqual(payload.record)
    expect(()=>nativeBaseRecord(db as unknown as SqliteDb,{...payload,record:{...payload.record,baseByteLength:Number(payload.record.baseByteLength)+1}})).toThrow()
  }finally{db.close()}
})

// Proves: while its document settles, the host may ask after and upload bytes
// its verified output names, without the settling document joining the blob
// reach it may read; that upload proof outlasts the release of the stopped
// last document and ends when the activation retires.
it('lets a settling document upload and ask after its bytes without growing the readable blob reach, until its activation retires',async()=>{
  const f=fixture();try{
    const r=await retiringFeed(f)
    const have=async(sha256:string)=>(await (await r.request('POST','blobs/have',JSON.stringify({sha256s:[sha256]}))).json())
    const digest=f.document.lineageClaimId,uploads=()=>Number(f.raw.prepare('SELECT count(*) AS count FROM sync_relay_service_host_uploads').get()!.count)
    expect(await have(digest)).toEqual({ok:true,missing:[digest]})
    expect((await r.request('GET',`blobs/${digest}`)).status).toBe(404)
    // The relay holds the owner's baseline bytes, but the host could not read them, so it learns nothing.
    expect(await r.upload(f.capture.baselineBytes)).toMatchObject({alreadyHad:false})
    expect(await have(digest)).toEqual({ok:true,missing:[]})
    expect((await r.request('GET',`blobs/${hash(f.capture.fullState)}`)).status).toBe(404)
    expect(f.storage.readServiceHostFeedScope('workspace')!.shared.size).toBe(0)
    f.storage.releaseServiceHostEnrollment({workspaceId:'workspace',objectId:'object',nowMs:11})
    expect(uploads()).toBe(1)
    const open=retirement(f.storage)!
    expect(f.store.completeRetirement({workspaceId:'workspace',key:keyOf(open),boundary:ownerBoundary(f),host,registeredAtMs:20,nowMs:20,guard(){}}))
      .toEqual({status:'retired',replayed:false})
    expect(uploads()).toBe(0)
  }finally{f.close()}
})

const V1_ACTIVATIONS=`CREATE TABLE sync_relay_service_activations (
  relay_database_namespace TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  main_version_id TEXT NOT NULL CHECK (main_version_id='main'),
  object_id TEXT NOT NULL,
  lineage_claim_id TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
  state_digest TEXT NOT NULL CHECK (length(state_digest)=64 AND state_digest NOT GLOB '*[^0-9a-f]*'),
  state_bytes BLOB NOT NULL CHECK (length(state_bytes) BETWEEN 2 AND 20971520),
  owner_user_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  completion_json TEXT CHECK (completion_json IS NULL OR json_valid(completion_json)),
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (relay_database_namespace,activation_id),
  UNIQUE (workspace_id,main_version_id,object_id,lineage_claim_id),
  FOREIGN KEY (workspace_id,main_version_id,object_id,lineage_claim_id)
    REFERENCES sync_relay_live_documents(workspace_id,main_version_id,object_id,lineage_claim_id) ON DELETE CASCADE
) STRICT`
// Rebuilds the fixture's activation storage as the v1 layout, keeping its rows. v1 named a share on each activation.
function downgradeActivations(f:ReturnType<typeof fixture>,sql=V1_ACTIVATIONS){
  const columns='relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,source_json,binding_json,state_digest,state_bytes,owner_user_id,completion_json,accounted_bytes'
  f.raw.exec(`BEGIN;DROP TABLE sync_relay_live_delivery_owner_history;
    ALTER TABLE sync_relay_service_activations RENAME TO current_activations;${sql};
    INSERT INTO sync_relay_service_activations(${columns},share_id) SELECT ${columns},'share' FROM current_activations;DROP TABLE current_activations;
    DELETE FROM sync_relay_migrations WHERE migration_id IN ('service-activation-v2','service-activation-v3');
    INSERT OR IGNORE INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES ('service-activation-v1',0);COMMIT`)
}
const activationMarks=(db:{prepare(sql:string):{all():unknown[]}})=>
  db.prepare("SELECT migration_id FROM sync_relay_migrations WHERE migration_id LIKE 'service-activation-v%' ORDER BY migration_id").all()
it('migrates v1 activations as current ones with no obligation, and refuses damaged v1 storage',async()=>{
  const f=fixture(),damaged=fixture();let reopened:ReturnType<typeof openSyncRelayStorage>|undefined
  try{
    enroll(f);await completeActivation(f)
    const before=f.raw.prepare('SELECT * FROM sync_relay_service_activations').all(),usage=f.raw.prepare('SELECT * FROM sync_relay_workspace_usage').all()
    downgradeActivations(f)
    reopened=openSyncRelayStorage(f.path)
    // The migrating connection reads its own schema; the test's raw one may still hold the old one.
    const db=(reopened as StorageContext).db
    expect(db.prepare('SELECT * FROM sync_relay_service_activations').all()).toEqual(before.map(row=>({...row,predecessor_activation_id:null,
      retire_requested_at_ms:null,retire_restore_generation:null,retire_accepted_cursor:null,retired_at_ms:null,retired_boundary_json:null})))
    expect(activationMarks(db)).toEqual([{migration_id:'service-activation-v1'},{migration_id:'service-activation-v2'},{migration_id:'service-activation-v3'}])
    expect(db.prepare('SELECT * FROM sync_relay_workspace_usage').all()).toEqual(usage)
    expect(retirement(reopened)).toBeNull()
    expect(reopened.resolveCurrentLiveDocumentBinding({document:f.document,actor}).kind).toBe('current')
    reopened.close();reopened=openSyncRelayStorage(f.path)
    await damaged.prepare()
    downgradeActivations(damaged,V1_ACTIVATIONS.replace(' STRICT',''))
    expect(()=>openSyncRelayStorage(damaged.path)).toThrow('Service activation storage is damaged.')
  }finally{reopened?.close();f.close();damaged.close()}
})

// The v2 activation layout, which named the share each owner activated through.
const V2_ACTIVATIONS=`CREATE TABLE sync_relay_service_activations (
  relay_database_namespace TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  main_version_id TEXT NOT NULL CHECK (main_version_id='main'),
  object_id TEXT NOT NULL,
  lineage_claim_id TEXT NOT NULL,
  predecessor_activation_id TEXT,
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
  state_digest TEXT NOT NULL CHECK (length(state_digest)=64 AND state_digest NOT GLOB '*[^0-9a-f]*'),
  state_bytes BLOB CHECK (state_bytes IS NULL OR length(state_bytes) BETWEEN 2 AND 20971520),
  owner_user_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  completion_json TEXT CHECK (completion_json IS NULL OR json_valid(completion_json)),
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND 9007199254740991),
  retire_requested_at_ms INTEGER CHECK (retire_requested_at_ms IS NULL OR retire_requested_at_ms BETWEEN 0 AND 9007199254740991),
  retire_restore_generation INTEGER CHECK (retire_restore_generation IS NULL OR retire_restore_generation BETWEEN 0 AND 9007199254740991),
  retire_accepted_cursor INTEGER CHECK (retire_accepted_cursor IS NULL OR retire_accepted_cursor BETWEEN 0 AND 9007199254740991),
  retired_at_ms INTEGER CHECK (retired_at_ms IS NULL OR retired_at_ms BETWEEN 0 AND 9007199254740991),
  retired_boundary_json TEXT CHECK (retired_boundary_json IS NULL OR json_valid(retired_boundary_json)),
  CHECK ((retire_requested_at_ms IS NULL)=(retire_restore_generation IS NULL) AND (retire_requested_at_ms IS NULL)=(retire_accepted_cursor IS NULL)),
  CHECK ((retired_at_ms IS NULL)=(retired_boundary_json IS NULL) AND (retired_at_ms IS NULL)=(state_bytes IS NOT NULL)),
  CHECK (retired_at_ms IS NULL OR (retire_requested_at_ms IS NOT NULL AND retired_at_ms>=retire_requested_at_ms)),
  CHECK (predecessor_activation_id IS NULL OR predecessor_activation_id<>activation_id),
  PRIMARY KEY (relay_database_namespace,activation_id),
  FOREIGN KEY (relay_database_namespace,predecessor_activation_id) REFERENCES sync_relay_service_activations(relay_database_namespace,activation_id),
  FOREIGN KEY (workspace_id,main_version_id,object_id,lineage_claim_id)
    REFERENCES sync_relay_live_documents(workspace_id,main_version_id,object_id,lineage_claim_id) ON DELETE CASCADE
) STRICT`
// Rebuilds a store's activations and archived history in the v2 layout, naming the fixture's share on every activation.
// The v2 indexes and history table are the current ones.
function downgradeToV2(raw:InstanceType<typeof DatabaseSync>,sql=V2_ACTIVATIONS){
  const columns=raw.prepare("SELECT name FROM pragma_table_info('sync_relay_service_activations') ORDER BY cid").all().map(row=>String(row.name)).join(',')
  const kept=raw.prepare(`SELECT sql FROM sqlite_schema WHERE name='sync_relay_live_delivery_owner_history'
    OR (type='index' AND tbl_name='sync_relay_service_activations' AND sql IS NOT NULL) ORDER BY type='table'`).all().map(row=>`${String(row.sql)};`).join('')
  raw.exec(`BEGIN;PRAGMA defer_foreign_keys=ON;
    CREATE TEMP TABLE activations_v3 AS SELECT * FROM sync_relay_service_activations;
    CREATE TEMP TABLE history_v3 AS SELECT * FROM sync_relay_live_delivery_owner_history;
    DROP TABLE sync_relay_live_delivery_owner_history;DROP TABLE sync_relay_service_activations;${sql};${kept}
    INSERT INTO sync_relay_service_activations(${columns},share_id) SELECT ${columns},'share' FROM temp.activations_v3;
    INSERT INTO sync_relay_live_delivery_owner_history SELECT * FROM temp.history_v3;
    DROP TABLE temp.activations_v3;DROP TABLE temp.history_v3;
    DELETE FROM sync_relay_migrations WHERE migration_id='service-activation-v3';COMMIT`)
}

// Proves: the v3 rebuild drops the share each v2 activation named and keeps
// the rest of the store: retired predecessors with their archived history,
// completed activations, the pending successor, every chain link and every
// charge. Initialization accepts the rebuilt store, again on the next open,
// and the pending successor's access still serves the owner its lineage's
// binding. A v2 table that is not the shipped layout is refused.
it('migrates v2 activations and their archived history without the share each named, and refuses damaged v2 storage',async()=>{
  const f=fixture(),damaged=fixture();let reopened:ReturnType<typeof openSyncRelayStorage>|undefined
  try{
    const {boundary}=await retirePredecessor(f)
    const adopted=await adoptSuccessor(f,boundary);adopted.apply();adopted.complete()
    stopDocument(f,20);resumeDocument(f,20)
    expect(f.store.completeRetirement({workspaceId:'workspace',key:keyOf(retirement(f.storage)!),boundary:ownerBoundary(f),host,registeredAtMs:20,nowMs:20,guard(){}}))
      .toEqual({status:'retired',replayed:false})
    expect(await prepareSuccessor(f,{...f.capture,activationId:NEXT,source:{...f.capture.source,predecessorActivationId:SUCCESSOR}}))
      .toEqual({document:f.document,replayed:false,completed:false})
    const rows=(db:{prepare(sql:string):{all():Record<string,unknown>[]}})=>({
      activations:db.prepare('SELECT * FROM sync_relay_service_activations ORDER BY activation_id').all(),
      history:db.prepare('SELECT * FROM sync_relay_live_delivery_owner_history ORDER BY activation_id').all(),
      usage:db.prepare('SELECT * FROM sync_relay_workspace_usage ORDER BY workspace_id').all()})
    const before=rows(f.raw)
    expect(before.activations.map(row=>[row.activation_id,row.predecessor_activation_id,row.retired_at_ms!==null,row.completion_json!==null]))
      .toEqual([[f.capture.activationId,null,true,true],[SUCCESSOR,f.capture.activationId,true,true],[NEXT,SUCCESSOR,false,false]])
    expect(before.history.map(row=>row.activation_id)).toEqual([f.capture.activationId,SUCCESSOR])
    downgradeToV2(f.raw)
    expect(f.raw.prepare('SELECT DISTINCT share_id FROM sync_relay_service_activations').all()).toEqual([{share_id:'share'}])
    expect(activationMarks(f.raw)).toEqual([{migration_id:'service-activation-v2'}])
    reopened=openSyncRelayStorage(f.path)
    // The migrating connection reads its own schema; the test's raw one may still hold the old one.
    const db=(reopened as StorageContext).db
    expect(rows(db)).toEqual(before)
    expect(activationMarks(db)).toEqual([{migration_id:'service-activation-v2'},{migration_id:'service-activation-v3'}])
    const next=JSON.parse(String(before.activations[2]!.binding_json))
    expect(reopened.resolveCurrentLiveDocumentBinding({document:f.document,actor}).kind).toBe('refused')
    const access=reopened.createServiceActivationStore(f.history).pending(f.document,host)
    expect(reopened.resolveCurrentLiveDocumentBinding({document:f.document,actor},access)).toMatchObject({kind:'current',binding:next})
    reopened.close();reopened=openSyncRelayStorage(f.path)
    expect(rows((reopened as StorageContext).db)).toEqual(before)
    await damaged.prepare()
    downgradeToV2(damaged.raw,V2_ACTIVATIONS.replace(' STRICT',''))
    expect(()=>openSyncRelayStorage(damaged.path)).toThrow('Service activation storage is damaged.')
  }finally{reopened?.close();f.close();damaged.close()}
})

// Proves: a lineage a folder share activated before the upgrade keeps that
// share's selector as its recorded owner scope. After the upgrade no share is
// consulted: the share it named is gone and no other covers the note, and the
// owner is served its `["notes"]` binding and the owner's draft delivers. A
// draft bound to the note's path alone is not that binding, and is refused.
it('serves a folder-share lineage its recorded binding after the upgrade, consulting no share',()=>{
  const f=registered({currentPath:'notes/a.md'});let reopened:ReturnType<typeof openSyncRelayStorage>|undefined
  try{
    const document=f.input.evidence.document,recorded={...document,currentPath:'notes/a.md',selectorPaths:['notes'],restoreFenceGeneration:1}
    downgradeToV2(f.raw)
    f.raw.prepare(`INSERT INTO sync_relay_service_activations(relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,
        source_json,binding_json,state_digest,state_bytes,owner_user_id,share_id,completion_json,accounted_bytes) VALUES ('history',?,?,'main',?,?,'{}',?,?,x'0000','owner','notes-share','{}',1)`)
      .run(`ordinary-activation-${'f'.repeat(64)}`,document.workspaceId,document.objectId,document.lineageClaimId,JSON.stringify(recorded),document.lineageClaimId)
    expect(f.raw.prepare("SELECT 1 FROM sync_relay_shares WHERE share_id='notes-share'").get()).toBeUndefined()
    reopened=openSyncRelayStorage(f.path)
    expect((reopened as StorageContext).db.prepare('SELECT binding_json FROM sync_relay_service_activations').all()).toEqual([{binding_json:JSON.stringify(recorded)}])
    reopened.close();reopened=undefined
    f.storage.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace:'history',reconciled:true}))
    expect(f.storage.resolveCurrentLiveDocumentBinding({document,actor:f.actor})).toMatchObject({kind:'current',binding:recorded})
    expect(f.storage.commitLiveUpdateJournal(f.capture(f.update('title','Draft'),'draft')).result.kind).toBe('accepted')
    const narrowed=f.capture(f.update('title','Narrowed'),'narrowed')
    expect(f.storage.commitLiveUpdateJournal({...narrowed,metadata:{...narrowed.metadata,binding:{...recorded,selectorPaths:['notes/a.md']}}}).result)
      .toEqual({kind:'refused',reason:'stale-binding'})
  }finally{reopened?.close();f.close();cleanupLiveDeliveryFixtures()}
})
