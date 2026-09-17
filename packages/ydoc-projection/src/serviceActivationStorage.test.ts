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
import {requireStopRestoreOwnerOrigin,type StopRestoreBasis} from '../../../services/sync-relay/src/storage/liveRestoreOperation.js'
import type {StorageContext} from '../../../services/sync-relay/src/storage/context.js'

const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const policy={maxStructVisits:1_000_000,maxValueNodeVisits:5_000_000,maxDecodedPayloadByteVisits:100_000_000,
  maxStructClientGroupVisits:1_000_000,maxDeleteClientGroupVisits:1_000_000,maxDeleteIntervalVisits:1_000_000,maxIndexOperations:10_000_000}
const validateBaseline=createLiveMarkdownRegistrationValidator(policy),validateJournal=createLiveMarkdownJournalValidator(policy)
const host={mode:'service' as const,hostId:'service',hostEpoch:parseHostEpoch(1),instanceId:'instance',connectionId:'connection'}
const actor={kind:'owner' as const,userId:'owner',shareId:'share'}
const bounds={maxCaptureBytes:1_000_000,maxEntriesPerDrain:10,maxBytesPerDrain:1_000_000}
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
  const base=validateBaseline({document,currentPath:'docs/a.md',checkpoint:baselineBytes})
  if(base.kind!=='accepted')throw new Error(JSON.stringify(base))
  const capture:NativeOwnerActivation={activationId:`ordinary-activation-${'a'.repeat(64)}`,sessionId:'real-session',baselineBytes,fullState,
    source:{version:1,relayDatabaseNamespace:'history',...document,currentPath:'docs/a.md',replicationEpoch:'epoch',streamIdentity:'stream',
      committedCursor:3,baseOriginId:'origin',baseOriginSeq:1,baseRelaySeq:2,
      sourceMomentId:`moment-ydoc-apply-${hash(Buffer.from(['workspace','main','object','docs/a.md','origin','2'].join('\0')))}`,
      sourceDigest:validated.evidence.projectedMarkdownSha256,sourceByteLength:validated.evidence.projectedMarkdownByteLength,
      nativeHeadSequence:2,fullStateDigest:hash(fullState),fullStateByteLength:fullState.length}}
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
  storage.provisionLiveHostControl({...host,updatedAtMs:1,guard(){}})
  const prepare=(readBounds=bounds)=>store.prepare({capture,host,shareId:'share',registeredAtMs:3,guard(){},validateBaseline,validateJournal,bounds:readBounds})
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
it('activates a receiver projection derived from the ordinary Ydoc base and suffix without a matching file moment',()=>{
  const f=fixture();try{
    expect(f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
    expect(f.store.read('workspace','docs/a.md',1_000_000)!.source).toEqual(f.capture.source)
    expect(f.raw.prepare('SELECT moment_id FROM sync_relay_object_moments').all()).toEqual([{moment_id:'original-moment'}])
  }finally{f.close()}
})
function appendFoldedMoment(f:ReturnType<typeof fixture>){
    const source=f.capture.source
    f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',3,'moment.append',?,3)")
      .run(JSON.stringify({versionId:'main',objectId:'object',momentId:'folded-write-moment',path:'docs/a.md',operation:'write',
        payloadAfterPath:'docs/a.md',payloadAfterContentKind:'text',payloadAfterBlobSha256:source.sourceDigest,payloadAfterByteLength:source.sourceByteLength}))
    f.raw.prepare("INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms) VALUES ('workspace','object',4,'folded-write-moment','main','docs/a.md',?,'text',?,3)")
      .run(source.sourceDigest,source.sourceByteLength)
    Object.assign(source,{sourceMomentId:'folded-write-moment',committedCursor:4})
}
it('activates an ordinary text write folded into a Ydoc update before its file moment',()=>{
  const f=fixture();try{
    appendFoldedMoment(f)
    expect(f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
    expect(f.store.read('workspace','docs/a.md',1_000_000)!.source).toEqual(f.capture.source)
  }finally{f.close()}
})
it('activates a folded main moment when a later branch moment exists for the same object',()=>{
  const f=fixture();try{
    appendFoldedMoment(f)
    const source=f.capture.source
    f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',4,'moment.append',?,4)")
      .run(JSON.stringify({versionId:'branch',objectId:'object',momentId:'branch-moment',path:'docs/a.md',operation:'write',
        payloadAfterPath:'docs/a.md',payloadAfterContentKind:'text',payloadAfterBlobSha256:source.sourceDigest,payloadAfterByteLength:source.sourceByteLength}))
    f.raw.prepare("INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms) VALUES ('workspace','object',5,'branch-moment','branch','docs/a.md',?,'text',?,4)")
      .run(source.sourceDigest,source.sourceByteLength)
    Object.assign(source,{committedCursor:5})
    expect(f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
    expect(f.store.read('workspace','docs/a.md',1_000_000)!.source.sourceMomentId).toBe('folded-write-moment')
  }finally{f.close()}
})
it.each(['digest','length'] as const)('refuses an older Ydoc source when a later main file moment has a divergent %s',field=>{
  const f=fixture();try{
    const oldMoment=f.capture.source.sourceMomentId
    appendFoldedMoment(f)
    f.capture.source.sourceMomentId=oldMoment
    const digest=field==='digest'?'b'.repeat(64):f.capture.source.sourceDigest
    const length=f.capture.source.sourceByteLength+(field==='length'?1:0)
    f.raw.prepare("UPDATE sync_relay_log SET payload_json=json_set(payload_json,'$.payloadAfterBlobSha256',?,'$.payloadAfterByteLength',?) WHERE relay_seq=4").run(digest,length)
    f.raw.prepare('UPDATE sync_relay_object_moments SET blob_sha256=?,byte_length=? WHERE relay_seq=4').run(digest,length)
    expect(()=>f.prepare()).toThrow('later ordinary file moment')
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
  }finally{f.close()}
})
it('permits a later folded file echo of the same Ydoc projection',()=>{
  const f=fixture();try{
    const oldMoment=f.capture.source.sourceMomentId
    appendFoldedMoment(f)
    f.capture.source.sourceMomentId=oldMoment
    expect(f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
  }finally{f.close()}
})
it('permits a newer Ydoc projection after an older folded file moment',()=>{
  const f=fixture(),doc=new Y.Doc();try{
    appendFoldedMoment(f)
    Y.applyUpdate(doc,f.capture.fullState);const before=Y.encodeStateVector(doc)
    doc.getMap('frontmatter').set('newer','projection')
    const suffix=Y.encodeStateAsUpdate(doc,before),fullState=Y.encodeStateAsUpdate(doc)
    f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',4,'ydoc.update',?,4)")
      .run(JSON.stringify({versionId:'main',objectId:'object',path:'docs/a.md',contentKind:'richdoc',isBaseState:false,lineageClaimId:f.document.lineageClaimId,updateBlobSha256:hash(suffix)}))
    f.raw.prepare("INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)").run(hash(suffix),suffix.length,suffix)
    const validation=validateBaseline({document:f.document,currentPath:'docs/a.md',checkpoint:fullState})
    if(validation.kind!=='accepted')throw new Error('Invalid updated fixture')
    Object.assign(f.capture,{fullState});Object.assign(f.capture.source,{committedCursor:5,nativeHeadSequence:3,
      sourceMomentId:`moment-ydoc-apply-${hash(Buffer.from(['workspace','main','object','docs/a.md','origin','4'].join('\0')))}`,
      sourceDigest:validation.evidence.projectedMarkdownSha256,sourceByteLength:validation.evidence.projectedMarkdownByteLength,
      fullStateDigest:hash(fullState),fullStateByteLength:fullState.length})
    expect(f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
  }finally{doc.destroy();f.close()}
})
it.each([['operation','delete'],['path','other.md'],['payloadAfterPath','other.md'],['payloadAfterContentKind','binary']] as const)
('refuses a folded moment with replaced %s', (field,value)=>{
  const f=fixture();try{
    appendFoldedMoment(f)
    f.raw.prepare('UPDATE sync_relay_log SET payload_json=json_set(payload_json,?,?) WHERE relay_seq=4').run('$.'.concat(field),value)
    expect(f.prepare).toThrow('Ordinary activation history replaced the live document.')
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
  }finally{f.close()}
})
it('refuses an ordinary baseline as stale after a real workspace identity rotation',()=>{
  const f=fixture();try{
    f.prepare();const access=f.store.pending(f.document,host)
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor},access).kind).toBe('current')
    expect(f.storage.rotateWorkspaceIdentity({workspaceId:'workspace',ownerUserId:'owner',replicationEpoch:'next-epoch',streamIdentity:'next-stream',rotatedAtMs:10})).toBe('rotated')
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor},access)).toEqual({kind:'refused',reason:'stale-document'})
  }finally{f.close()}
})
it('activates an unedited ordinary Ydoc base without a suffix',()=>{
  const f=fixture();try{
    f.raw.exec('DELETE FROM sync_relay_log WHERE relay_seq=3')
    const base=validateBaseline({document:f.document,currentPath:'docs/a.md',checkpoint:f.capture.baselineBytes})
    if(base.kind!=='accepted')throw new Error('Invalid base fixture')
    f.capture.fullState=f.capture.baselineBytes
    Object.assign(f.capture.source,{committedCursor:2,nativeHeadSequence:1,sourceMomentId:'original-moment',
      sourceDigest:base.evidence.projectedMarkdownSha256,sourceByteLength:base.evidence.projectedMarkdownByteLength,
      fullStateDigest:hash(f.capture.fullState),fullStateByteLength:f.capture.fullState.length})
    expect(f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
  }finally{f.close()}
})
it.each(['projection','coordinate','epoch','blob','removed'] as const)('rejects a damaged retained ordinary baseline %s',field=>{
  const f=fixture();try{
    f.prepare();const access=f.store.pending(f.document,host)
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor},access).kind).toBe('current')
    if(field==='projection')f.raw.prepare('UPDATE sync_relay_live_documents SET baseline_projected_sha256=?').run('b'.repeat(64))
    else if(field==='coordinate')f.raw.exec('UPDATE sync_relay_live_document_ordinary_bases SET base_origin_seq=99')
    else if(field==='epoch')f.raw.exec("UPDATE sync_relay_live_document_ordinary_bases SET replication_epoch='tampered'")
    else if(field==='blob')f.raw.prepare('UPDATE sync_relay_blobs SET content=? WHERE sha256=?').run(new Uint8Array(f.capture.baselineBytes.length),f.document.lineageClaimId)
    else f.raw.exec('DELETE FROM sync_relay_live_document_ordinary_bases')
    expect(()=>f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor},access)).toThrow('damaged')
  }finally{f.close()}
})
it('rejects different CRDT history even when its rendered Markdown matches the ordinary cut',()=>{
  const f=fixture(),changed=new Y.Doc();try{
    Y.applyUpdate(changed,f.capture.fullState)
    changed.getMap('frontmatter').set('temporary','removed');changed.getMap('frontmatter').delete('temporary')
    const bytes=Y.encodeStateAsUpdate(changed)
    const validated=validateJournal({document:f.document,currentPath:'docs/a.md',checkpoint:f.capture.baselineBytes,suffix:[],candidate:bytes})
    expect(validated.kind).toBe('accepted')
    if(validated.kind!=='accepted')throw new Error('Invalid test update')
    expect(validated.evidence.projectedMarkdownSha256).toBe(f.capture.source.sourceDigest)
    Object.assign(f.capture,{fullState:bytes});Object.assign(f.capture.source,{fullStateDigest:hash(bytes),fullStateByteLength:bytes.length})
    expect(f.prepare).toThrow('complete ordinary CRDT history')
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
  }finally{changed.destroy();f.close()}
})
it('rejects a claimed full state that borrows missing baseline structs from the ordinary checkpoint',()=>{
  const f=fixture(),base=new Y.Doc(),full=new Y.Doc();try{
    Y.applyUpdate(base,f.capture.baselineBytes);Y.applyUpdate(full,f.capture.fullState)
    const suffix=Y.encodeStateAsUpdate(full,Y.encodeStateVector(base))
    expect(suffix.length).toBeLessThan(f.capture.fullState.length)
    Object.assign(f.capture,{fullState:suffix});Object.assign(f.capture.source,{fullStateDigest:hash(suffix),fullStateByteLength:suffix.length})
    expect(f.prepare).toThrow()
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
  }finally{base.destroy();full.destroy();f.close()}
})
it('keeps an earlier projecting moment when a later ordinary suffix only adds deleted CRDT history',()=>{
  const f=fixture(),changed=new Y.Doc();try{
    Y.applyUpdate(changed,f.capture.fullState);const before=Y.encodeStateVector(changed)
    changed.getMap('frontmatter').set('temporary','removed');changed.getMap('frontmatter').delete('temporary')
    const suffix=Y.encodeStateAsUpdate(changed,before),fullState=Y.encodeStateAsUpdate(changed)
    f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',3,'ydoc.update',?,3)")
      .run(JSON.stringify({versionId:'main',objectId:'object',path:'docs/a.md',contentKind:'richdoc',isBaseState:false,lineageClaimId:f.document.lineageClaimId,updateBlobSha256:hash(suffix)}))
    f.raw.prepare("INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)").run(hash(suffix),suffix.length,suffix)
    Object.assign(f.capture,{fullState});Object.assign(f.capture.source,{committedCursor:4,fullStateDigest:hash(fullState),fullStateByteLength:fullState.length})
    expect(f.prepare()).toMatchObject({completed:false})
  }finally{changed.destroy();f.close()}
})
it('checks configured history entry and byte budgets before loading relay blobs',()=>{
  const f=fixture();try{
    const read=vi.spyOn(f.storage,'getBlob')
    expect(()=>f.prepare({...bounds,maxEntriesPerDrain:1})).toThrow('entry budget')
    expect(read).not.toHaveBeenCalled()
    expect(()=>f.prepare({...bounds,maxBytesPerDrain:f.capture.baselineBytes.length})).toThrow('metadata')
    expect(read).not.toHaveBeenCalled()
    expect(f.raw.prepare('SELECT * FROM sync_relay_service_activations').all()).toEqual([])
  }finally{f.close()}
})
it('rejects a different replication epoch even at the same relay cursor',()=>{
  const f=fixture();try{
    f.capture.source.replicationEpoch='foreign-epoch'
    expect(f.prepare).toThrow(ServiceActivationStaleCut)
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
function ownerCapture(f:ReturnType<typeof fixture>){
  f.prepare()
  const access=f.store.pending(f.document,host),delivery=f.storage.createLiveCommittedDeliveryStore(f.history,access)
  const capture=delivery.captureOwnerCut({host,document:f.document,actor,adoptionId:f.capture.activationId,
    expectedLocalSequence:f.capture.source.nativeHeadSequence,maxBytes:1_000_000,maxEvents:100,throughCursor:0})
  const acknowledge=()=>delivery.acknowledgeOwnerAdoption(capture,{adoptionId:f.capture.activationId,
    localYDocSequence:f.capture.source.nativeHeadSequence,terminalCursor:0,adoptionReplayed:false})
  return {capture,delivery,acknowledge}
}
it.each(['selector','host'] as const)('revalidates a private pending activation binding after its %s changes',change=>{
  const f=fixture();try{
    f.prepare()
    const access=f.store.pending(f.document,host),delivery=f.storage.createLiveCommittedDeliveryStore(f.history,access)
    const captured=delivery.captureOwnerBinding({host,document:f.document,actor})
    expect(captured.binding).toMatchObject(f.document)
    expect(captured.assertCurrent).not.toThrow()
    const wrong=f.storage.createLiveCommittedDeliveryStore(f.history,{activationId:'wrong-activation'})
    expect(()=>wrong.captureOwnerBinding({host,document:f.document,actor})).toThrow()
    if(change==='selector')f.raw.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id='share'")
      .run(JSON.stringify({paths:['other'],versionId:null}))
    else f.raw.exec("UPDATE sync_relay_session_host_control SET registered_connection_id='different-connection'")
    expect(captured.assertCurrent).toThrow()
  }finally{f.close()}
})
it('revalidates the frozen activation source before acknowledging a captured owner cut',()=>{
  const f=fixture();try{
    const owner=ownerCapture(f)
    expect(owner.capture.cut.sourceMomentId).toBe(f.capture.source.sourceMomentId)
    expect(owner.capture.cut.sourceDigest).toBe(f.capture.source.sourceDigest)
    f.raw.exec("UPDATE sync_relay_service_activations SET source_json=json_set(source_json,'$.sourceMomentId','changed-source')")
    expect(owner.capture.assertCurrent).toThrow()
    expect(owner.acknowledge).toThrow()
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_delivery_owners').all()).toEqual([])
  }finally{f.close()}
})
it('rejects changed retained activation provenance when opening or revalidating owner delivery',()=>{
  const f=fixture();try{
    const owner=ownerCapture(f);owner.acknowledge()
    const opened=owner.delivery.openOwnerDelivery({host,document:f.document,actor})
    expect(()=>opened.assertCurrent()).not.toThrow()
    f.raw.exec("UPDATE sync_relay_service_activations SET source_json=json_set(source_json,'$.nativeHeadSequence',99)")
    expect(opened.assertCurrent).toThrow()
    expect(()=>owner.delivery.openOwnerDelivery({host,document:f.document,actor})).toThrow()
  }finally{f.close()}
})
it('checks the frozen service origin separately from the original baseline when guarding restore',()=>{
  const f=fixture();try{
    const owner=ownerCapture(f);owner.acknowledge()
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
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_document_ordinary_bases').all()).toEqual([])
  }finally{f.close()}
})

function activationDriver(f:ReturnType<typeof fixture>,captureOwnerActivation:ReturnType<typeof vi.fn>,sendRequest=vi.fn(async()=>({result:{released:true}}))){
  const pull=vi.fn(async()=>({hasMore:false})),target={workspaceId:'workspace',path:'docs/a.md',shareId:'share'}
  const driver=new ServiceActivationDriver({storage:f.storage,history:f.history,host,
    client:{captureOwnerActivation,sendRequest} as never,
    workspaces:new Map([['workspace',{handle:'native-workspace',ordinary:{pull} as never}]]),
    config:{targets:[target],validateBaseline,validateJournal,validateAdmission:validateJournal,maxCaptureBytes:1_000_000,maxEntriesPerDrain:10,maxBytesPerDrain:1_000_000,
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
