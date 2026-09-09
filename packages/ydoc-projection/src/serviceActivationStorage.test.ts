import {ServiceActivationDriver} from "../../../services/sync-relay/src/serviceActivationDriver.js"
import {OwnerCommittedDelivery} from "../../../services/sync-relay/src/ownerCommittedDelivery.js"
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
import {createLiveMarkdownRegistrationValidator,createLiveMarkdownJournalValidator} from './liveDocumentValidation.js'
import {openSyncRelayStorage} from '../../../services/sync-relay/src/storage.js'
import {createLiveJournalHistoryAuthority} from '../../../services/sync-relay/src/storage/liveJournalHistory.js'
import {ServiceActivationStaleCut} from '../../../services/sync-relay/src/storage/serviceActivation.js'

const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const policy={maxStructVisits:1_000_000,maxValueNodeVisits:5_000_000,maxDecodedPayloadByteVisits:100_000_000,
  maxStructClientGroupVisits:1_000_000,maxDeleteClientGroupVisits:1_000_000,maxDeleteIntervalVisits:1_000_000,maxIndexOperations:10_000_000}
const validateBaseline=createLiveMarkdownRegistrationValidator(policy),validateJournal=createLiveMarkdownJournalValidator(policy)
const host={mode:'service' as const,hostId:'service',hostEpoch:parseHostEpoch(1),instanceId:'instance',connectionId:'connection'}
const actor={kind:'owner' as const,userId:'owner',shareId:'share'}
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'dohc-service-activation-')),path=join(root,'relay.sqlite')
  const storage=openSyncRelayStorage(path),raw=new DatabaseSync(path)
  const history=createLiveJournalHistoryAuthority({namespace:'history',reconciled:true}),store=storage.createServiceActivationStore(history)
  const doc=markdownToYDoc('Original'),baselineBytes=Buffer.from(Y.encodeStateAsUpdate(doc))
  doc.getMap('frontmatter').set('title','Edited')
  const fullState=Buffer.from(Y.encodeStateAsUpdate(doc));doc.destroy()
  const document={workspaceId:'workspace',mainVersionId:'main' as const,objectId:'object',lineageClaimId:hash(baselineBytes)}
  const validated=validateJournal({document,currentPath:'docs/a.md',checkpoint:baselineBytes,suffix:[],candidate:fullState})
  if(validated.kind!=='accepted')throw new Error(JSON.stringify(validated))
  const capture:NativeOwnerActivation={activationId:`ordinary-activation-${'a'.repeat(64)}`,sessionId:'real-session',baselineBytes,fullState,
    source:{version:1,relayDatabaseNamespace:'history',...document,currentPath:'docs/a.md',replicationEpoch:'epoch',streamIdentity:'stream',
      committedCursor:2,baseOriginId:'origin',baseOriginSeq:1,baseRelaySeq:1,sourceMomentId:'moment',
      sourceDigest:validated.evidence.projectedMarkdownSha256,sourceByteLength:validated.evidence.projectedMarkdownByteLength,
      nativeHeadSequence:2,fullStateDigest:hash(fullState),fullStateByteLength:fullState.length}}
  raw.exec("INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity) VALUES ('workspace','owner',0,'epoch','stream')")
  raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',1,'ydoc.update',?,1)")
    .run(JSON.stringify({versionId:'main',objectId:'object',contentKind:'richdoc',isBaseState:true,lineageClaimId:document.lineageClaimId,updateBlobSha256:document.lineageClaimId}))
  raw.exec("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',2,'object.snapshot','{}',2)")
  raw.prepare("INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)").run(document.lineageClaimId,baselineBytes.length,baselineBytes)
  raw.prepare("INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms) VALUES ('workspace','object',2,'moment','main','docs/a.md',?,'text',?,2)")
    .run(capture.source.sourceDigest,capture.source.sourceByteLength)
  raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('share','workspace','owner',?,0)").run(JSON.stringify({paths:['docs'],versionId:null}))
  storage.provisionLiveHostControl({...host,updatedAtMs:1,guard(){}})
  const prepare=()=>store.prepare({capture,host,shareId:'share',registeredAtMs:3,guard(){},validateBaseline,validateJournal})
  return {storage,raw,store,history,capture,document,prepare,path,close(){raw.close();storage.close();rmSync(root,{recursive:true,force:true})}}
}
it('retains the original lineage and edited ordinary cut, closing ordinary authority until activation completes',()=>{
  const f=fixture();try{
    expect(f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor}).kind).toBe('refused')
    const access=f.store.pending(f.document,host)
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor},access).kind).toBe('current')
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor},{activationId:access.activationId}).kind).toBe('refused')
    const saved=f.store.read('workspace','docs/a.md',1_000_000)!
    expect(saved.source).toEqual(f.capture.source)
    expect(saved.baselineBytes).toEqual(new Uint8Array(f.capture.baselineBytes))
    expect(saved.fullState).toEqual(new Uint8Array(f.capture.fullState))
    expect(f.prepare()).toMatchObject({replayed:true,completed:false})
  }finally{f.close()}
})
it('rolls back host registration and baseline when the ordinary cursor advanced',()=>{
  const f=fixture();try{
    f.raw.exec("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','other',1,'object.snapshot','{}',3)")
    expect(f.prepare).toThrow(ServiceActivationStaleCut)
    expect(f.storage.getLiveHostControl()!.registeredConnectionId).toBeNull()
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
    expect(f.raw.prepare('SELECT * FROM sync_relay_service_activations').all()).toEqual([])
  }finally{f.close()}
})
it.each(['baseOriginId','sourceMomentId','sourceDigest','fullStateDigest'] as const)('rejects mismatched %s without publishing a live baseline',field=>{
  const f=fixture();try{
    f.capture.source[field]='b'.repeat(64)
    expect(f.prepare).toThrow()
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
  }finally{f.close()}
})
it('preflights retained byte reads and rejects damaged bytes',()=>{
  const f=fixture();try{
    f.prepare()
    expect(()=>f.store.read('workspace','docs/a.md',2)).toThrow('read budget')
    f.raw.prepare('UPDATE sync_relay_service_activations SET state_bytes=?').run(new Uint8Array([0,0]))
    expect(()=>f.store.read('workspace','docs/a.md',1_000_000)).toThrow('damaged')
  }finally{f.close()}
})
it('does not accept an empty native outbox as an adoption acknowledgement',()=>{
  const f=fixture();try{
    f.prepare()
    expect(()=>f.store.complete({document:f.document,host,access:f.store.pending(f.document,host),
      nativeState:{adoptionId:f.capture.activationId,pendingBytes:0},guard(){}})).toThrow('acknowledgement is missing')
    expect(f.store.read('workspace','docs/a.md',1_000_000)!.completed).toBe(false)
  }finally{f.close()}
})

it('requires exact seed application ACK and supports lost completion responses',()=>{
  const f=fixture();try{
    f.prepare()
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
    f.raw.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=2")
    expect(()=>f.store.resume({document:f.document,activationId:f.capture.activationId,host,registeredAtMs:5,guard(){}})).toThrow()
    f.raw.exec("UPDATE sync_relay_live_documents SET admission_state='closed'")
    expect(activationDriver(f,vi.fn()).driver.restoreConsumer(f.document)).toBeInstanceOf(OwnerCommittedDelivery)
  }finally{f.close()}
})

it('reopens the same pending source under a new connection without a new ordinary cut',()=>{
  const f=fixture();let reopened:ReturnType<typeof openSyncRelayStorage>|undefined
  try{
    f.prepare()
    reopened=openSyncRelayStorage(f.path)
    const store=reopened.createServiceActivationStore(createLiveJournalHistoryAuthority({namespace:'history',reconciled:true}))
    const saved=store.read('workspace','docs/a.md',1_000_000)!
    const next={...host,connectionId:'restarted-connection'}
    const resumed=store.resume({document:f.document,activationId:saved.activationId,host:next,registeredAtMs:5,guard(){}})
    expect(resumed.completed).toBe(false)
    expect(reopened.resolveCurrentLiveDocumentBinding({document:f.document,actor},resumed.access).kind).toBe('current')
    expect(store.read('workspace','docs/a.md',1_000_000)!.source).toEqual(f.capture.source)
    expect(reopened.resolveCurrentLiveDocumentBinding({document:f.document,actor}).kind).toBe('refused')
  }finally{reopened?.close();f.close()}
})
it('rolls back the full activation when its retained-state quota charge fails',()=>{
  const f=fixture();try{
    const before=f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()
    f.raw.exec("CREATE TRIGGER activation_quota_failure BEFORE INSERT ON sync_relay_service_activations BEGIN SELECT RAISE(ABORT,'activation quota fault'); END")
    expect(f.prepare).toThrow('activation quota fault')
    expect(f.storage.getLiveHostControl()!.registeredConnectionId).toBeNull()
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
    expect(f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()).toEqual(before)
  }finally{f.close()}
})

function activationDriver(f:ReturnType<typeof fixture>,captureOwnerActivation:ReturnType<typeof vi.fn>,sendRequest=vi.fn(async()=>({result:{released:true}}))){
  const pull=vi.fn(async()=>({hasMore:false})),target={workspaceId:'workspace',path:'docs/a.md',shareId:'share'}
  const driver=new ServiceActivationDriver({storage:f.storage,history:f.history,host,
    client:{captureOwnerActivation,sendRequest} as never,
    workspaces:new Map([['workspace',{handle:'native-workspace',ordinary:{pull} as never}]]),
    config:{targets:[target],validateBaseline,validateJournal,maxCaptureBytes:1_000_000,maxEntriesPerDrain:10,maxBytesPerDrain:1_000_000,
      maxDocumentsPerPass:1,pollIntervalMs:1000,passDeadlineMs:10_000},
    adoption:{maxBytes:1_000_000,maxEvents:10},nextRequestId:()=>1,deadlineMs:1000,assertCurrent(){},registered(){},
    runDocument:(_document,_signal,operation)=>operation(),
  })
  return {driver,target,pull}
}
it('releases a real captured session after a stale cut without retaining another source',async()=>{
  const f=fixture();try{
    f.raw.exec("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','other',1,'object.snapshot','{}',3)")
    const send=vi.fn(async()=>({result:{released:true}}))
    const d=activationDriver(f,vi.fn(async()=>f.capture),send)
    expect(await d.driver.activate(d.target,new AbortController().signal)).toMatchObject({kind:'pending'})
    expect(send).toHaveBeenCalledWith(expect.objectContaining({workspace:'native-workspace',method:'liveApplication.releaseOwnerActivation',
      params:{activationId:f.capture.activationId,sessionId:'real-session'}}),expect.any(AbortSignal))
    expect(f.raw.prepare('SELECT * FROM sync_relay_service_activations').all()).toEqual([])
    expect(f.storage.getLiveHostControl()!.registeredConnectionId).toBeNull()
  }finally{f.close()}
})
it('restarts a pending activation with its retained ID instead of pulling and selecting a new cut',async()=>{
  const f=fixture(),drain=vi.spyOn(OwnerCommittedDelivery.prototype,'drain').mockResolvedValue({kind:'pending',reason:'transport interrupted',continueDrain:false})
  try{
    const initial=activationDriver(f,vi.fn(async()=>f.capture))
    await initial.driver.activate(initial.target,new AbortController().signal)
    expect(()=>initial.driver.consumer(f.document)).toThrow('incomplete')
    const capture=vi.fn(async()=>({...f.capture,sessionId:'reopened-native-session'}))
    const resumed=activationDriver(f,capture)
    await resumed.driver.activate(resumed.target,new AbortController().signal)
    expect(resumed.pull).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({workspace:'native-workspace'}),'docs/a.md',1_000_000,expect.any(AbortSignal),f.capture.activationId)
    expect(f.store.read('workspace','docs/a.md',1_000_000)!.source).toEqual(f.capture.source)
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor}).kind).toBe('refused')
  }finally{drain.mockRestore();f.close()}
})

it('retries the exact stale lease release before another ordinary pull after response loss',async()=>{
  const f=fixture();try{
    f.raw.exec("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','other',1,'object.snapshot','{}',3)")
    const order:string[]=[],send=vi.fn(async()=>{order.push('release');return {result:{released:true}}})
    send.mockImplementationOnce(async()=>{order.push('release-lost');throw new Error('response lost')})
    const capture=vi.fn(async()=>{order.push('capture');return f.capture}),d=activationDriver(f,capture,send)
    d.pull.mockImplementation(async()=>{order.push('pull');return {hasMore:false}})
    await expect(d.driver.activate(d.target,new AbortController().signal)).rejects.toThrow('response lost')
    expect(order).toEqual(['pull','capture','release-lost'])
    await d.driver.activate(d.target,new AbortController().signal)
    expect(order).toEqual(['pull','capture','release-lost','release','pull','capture','release'])
    expect(f.raw.prepare('SELECT * FROM sync_relay_service_activations').all()).toEqual([])
  }finally{f.close()}
})
