import {ServiceActivationDriver,type ServiceActivationConfig} from "../../../services/sync-relay/src/serviceActivationDriver.js"
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
import {createLiveMarkdownRegistrationValidator,createLiveMarkdownJournalValidator} from './liveDocumentValidation.js'
import {openSyncRelayStorage} from '../../../services/sync-relay/src/storage.js'
import {createLiveJournalHistoryAuthority} from '../../../services/sync-relay/src/storage/liveJournalHistory.js'
import {ServiceActivationStaleCut,ServiceActivationTooLarge} from '../../../services/sync-relay/src/storage/serviceActivation.js'
import {readOrdinaryActivationHistory,validateOrdinaryActivation,verifyOrdinaryActivationCut,type OrdinaryActivationValidator}
  from '../../../services/sync-relay/src/storage/ordinaryActivationSource.js'
import {createLiveValidationExecutor} from '../../../services/sync-relay/src/liveValidation.js'
import {selfHostLiveProfile} from '../../../services/sync-relay/src/selfHostLiveProfile.js'
import {requireStopRestoreOwnerOrigin,type StopRestoreBasis,type StopRestoreIntent} from '../../../services/sync-relay/src/storage/liveRestoreOperation.js'
import type {StorageContext} from '../../../services/sync-relay/src/storage/context.js'

const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const policy={maxStructVisits:1_000_000,maxValueNodeVisits:5_000_000,maxDecodedPayloadByteVisits:100_000_000,
  maxStructClientGroupVisits:1_000_000,maxDeleteClientGroupVisits:1_000_000,maxDeleteIntervalVisits:1_000_000,maxIndexOperations:10_000_000}
const validateBaseline=createLiveMarkdownRegistrationValidator(policy),validateJournal=createLiveMarkdownJournalValidator(policy)
// The pool's check, run in this process.
const validateActivation:OrdinaryActivationValidator=async work=>validateOrdinaryActivation(work,policy)
const host={mode:'service' as const,hostId:'service',hostEpoch:parseHostEpoch(1),instanceId:'instance',connectionId:'connection'}
const actor={kind:'owner' as const,userId:'owner',shareId:'share'}
const bounds={maxCaptureBytes:1_000_000,maxEntriesPerDrain:10,maxBytesPerDrain:1_000_000}
const stop={operationId:'restore',workspaceId:'workspace',ownerUserId:'owner'}
// A `large` note is not validated here; its projections are placeholders that only a finished validation would refuse.
function fixture(note='Original',large=false){
  const root=mkdtempSync(join(tmpdir(),'dohc-service-activation-')),path=join(root,'relay.sqlite')
  const storage=openSyncRelayStorage(path),raw=new DatabaseSync(path)
  const history=createLiveJournalHistoryAuthority({namespace:'history',reconciled:true}),store=storage.createServiceActivationStore(history)
  const doc=markdownToYDoc(note),baselineBytes=Buffer.from(Y.encodeStateAsUpdate(doc))
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
  const prepare=(readBounds=bounds,validate=validateActivation)=>store.prepare({capture,host,shareId:'share',registeredAtMs:3,guard(){},validate,bounds:readBounds})
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
it('activates a receiver projection derived from the ordinary Ydoc base and suffix without a matching file moment',async()=>{
  const f=fixture();try{
    expect(await f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
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
it('activates an ordinary text write folded into a Ydoc update before its file moment',async()=>{
  const f=fixture();try{
    appendFoldedMoment(f)
    expect(await f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
    expect(f.store.read('workspace','docs/a.md',1_000_000)!.source).toEqual(f.capture.source)
  }finally{f.close()}
})
it('activates a folded main moment when a later branch moment exists for the same object',async()=>{
  const f=fixture();try{
    appendFoldedMoment(f)
    const source=f.capture.source
    f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',4,'moment.append',?,4)")
      .run(JSON.stringify({versionId:'branch',objectId:'object',momentId:'branch-moment',path:'docs/a.md',operation:'write',
        payloadAfterPath:'docs/a.md',payloadAfterContentKind:'text',payloadAfterBlobSha256:source.sourceDigest,payloadAfterByteLength:source.sourceByteLength}))
    f.raw.prepare("INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms) VALUES ('workspace','object',5,'branch-moment','branch','docs/a.md',?,'text',?,4)")
      .run(source.sourceDigest,source.sourceByteLength)
    Object.assign(source,{committedCursor:5})
    expect(await f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
    expect(f.store.read('workspace','docs/a.md',1_000_000)!.source.sourceMomentId).toBe('folded-write-moment')
  }finally{f.close()}
})
it.each(['digest','length'] as const)('refuses an older Ydoc source when a later main file moment has a divergent %s',async field=>{
  const f=fixture();try{
    const oldMoment=f.capture.source.sourceMomentId
    appendFoldedMoment(f)
    f.capture.source.sourceMomentId=oldMoment
    const digest=field==='digest'?'b'.repeat(64):f.capture.source.sourceDigest
    const length=f.capture.source.sourceByteLength+(field==='length'?1:0)
    f.raw.prepare("UPDATE sync_relay_log SET payload_json=json_set(payload_json,'$.payloadAfterBlobSha256',?,'$.payloadAfterByteLength',?) WHERE relay_seq=4").run(digest,length)
    f.raw.prepare('UPDATE sync_relay_object_moments SET blob_sha256=?,byte_length=? WHERE relay_seq=4').run(digest,length)
    await expect(f.prepare()).rejects.toThrow('later ordinary file moment')
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
  }finally{f.close()}
})
it('permits a later folded file echo of the same Ydoc projection',async()=>{
  const f=fixture();try{
    const oldMoment=f.capture.source.sourceMomentId
    appendFoldedMoment(f)
    f.capture.source.sourceMomentId=oldMoment
    expect(await f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
  }finally{f.close()}
})
it('permits a newer Ydoc projection after an older folded file moment',async()=>{
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
    expect(await f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
  }finally{doc.destroy();f.close()}
})
it.each([['operation','delete'],['path','other.md'],['payloadAfterPath','other.md'],['payloadAfterContentKind','binary']] as const)
('refuses a folded moment with replaced %s', async(field,value)=>{
  const f=fixture();try{
    appendFoldedMoment(f)
    f.raw.prepare('UPDATE sync_relay_log SET payload_json=json_set(payload_json,?,?) WHERE relay_seq=4').run('$.'.concat(field),value)
    await expect(f.prepare()).rejects.toThrow('Ordinary activation history replaced the live document.')
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
  }finally{f.close()}
})
it('ignores refused moments while verifying an ordinary activation cut',async()=>{
  const f=fixture();try{
    f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,settlement_admission_json) VALUES ('workspace','origin',3,'moment.append',?,3,?)")
      .run(JSON.stringify({versionId:'main',objectId:'object',momentId:'refused',path:'other.md',operation:'delete'}),
        JSON.stringify({status:'refused',settlementId:'refused',reason:'authorship-mismatch'}))
    f.capture.source.committedCursor=4
    expect(await f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
    expect(f.store.read('workspace','docs/a.md',1_000_000)!.source).toEqual(f.capture.source)
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
// A host publication the relay kept after the document left its enrolled path
// writes the old path. It projects nowhere, but activation still refuses it.
it('refuses activation over a departed host publication',async()=>{
  const f=fixture();try{
    f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_admission) VALUES ('workspace','service-host:native',0,'moment.append',?,3,'departed')")
      .run(JSON.stringify({versionId:'main',objectId:'object',momentId:'departed',path:'docs/old.md',operation:'write',payloadAfterPath:'docs/old.md',
        payloadAfterContentKind:'text',payloadAfterBlobSha256:f.capture.source.sourceDigest,payloadAfterByteLength:f.capture.source.sourceByteLength}))
    f.capture.source.committedCursor=4
    await expect(f.prepare()).rejects.toThrow('Ordinary activation history replaced the live document.')
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
  }finally{f.close()}
})
it('refuses an ordinary baseline as stale after a real workspace identity rotation',async()=>{
  const f=fixture();try{
    await f.prepare();const access=f.store.pending(f.document,host)
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor},access).kind).toBe('current')
    expect(f.storage.rotateWorkspaceIdentity({workspaceId:'workspace',ownerUserId:'owner',replicationEpoch:'next-epoch',streamIdentity:'next-stream',rotatedAtMs:10})).toBe('rotated')
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor},access)).toEqual({kind:'refused',reason:'stale-document'})
  }finally{f.close()}
})
it('activates an unedited ordinary Ydoc base without a suffix',async()=>{
  const f=fixture();try{
    f.raw.exec('DELETE FROM sync_relay_log WHERE relay_seq=3')
    const base=validateBaseline({document:f.document,currentPath:'docs/a.md',checkpoint:f.capture.baselineBytes})
    if(base.kind!=='accepted')throw new Error('Invalid base fixture')
    f.capture.fullState=f.capture.baselineBytes
    Object.assign(f.capture.source,{committedCursor:2,nativeHeadSequence:1,sourceMomentId:'original-moment',
      sourceDigest:base.evidence.projectedMarkdownSha256,sourceByteLength:base.evidence.projectedMarkdownByteLength,
      fullStateDigest:hash(f.capture.fullState),fullStateByteLength:f.capture.fullState.length})
    expect(await f.prepare()).toEqual({document:f.document,replayed:false,completed:false})
  }finally{f.close()}
})
it.each(['projection','coordinate','epoch','blob','removed'] as const)('rejects a damaged retained ordinary baseline %s',async field=>{
  const f=fixture();try{
    await f.prepare();const access=f.store.pending(f.document,host)
    expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor},access).kind).toBe('current')
    if(field==='projection')f.raw.prepare('UPDATE sync_relay_live_documents SET baseline_projected_sha256=?').run('b'.repeat(64))
    else if(field==='coordinate')f.raw.exec('UPDATE sync_relay_live_document_ordinary_bases SET base_origin_seq=99')
    else if(field==='epoch')f.raw.exec("UPDATE sync_relay_live_document_ordinary_bases SET replication_epoch='tampered'")
    else if(field==='blob')f.raw.prepare('UPDATE sync_relay_blobs SET content=? WHERE sha256=?').run(new Uint8Array(f.capture.baselineBytes.length),f.document.lineageClaimId)
    else f.raw.exec('DELETE FROM sync_relay_live_document_ordinary_bases')
    expect(()=>f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor},access)).toThrow('damaged')
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
it('rejects a claimed full state that borrows missing baseline structs from the ordinary checkpoint',async()=>{
  const f=fixture(),base=new Y.Doc(),full=new Y.Doc();try{
    Y.applyUpdate(base,f.capture.baselineBytes);Y.applyUpdate(full,f.capture.fullState)
    const suffix=Y.encodeStateAsUpdate(full,Y.encodeStateVector(base))
    expect(suffix.length).toBeLessThan(f.capture.fullState.length)
    Object.assign(f.capture,{fullState:suffix});Object.assign(f.capture.source,{fullStateDigest:hash(suffix),fullStateByteLength:suffix.length})
    await expect(f.prepare()).rejects.toThrow()
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
  }finally{base.destroy();full.destroy();f.close()}
})
it('keeps an earlier projecting moment when a later ordinary suffix only adds deleted CRDT history',async()=>{
  const f=fixture(),changed=new Y.Doc();try{
    Y.applyUpdate(changed,f.capture.fullState);const before=Y.encodeStateVector(changed)
    changed.getMap('frontmatter').set('temporary','removed');changed.getMap('frontmatter').delete('temporary')
    const suffix=Y.encodeStateAsUpdate(changed,before),fullState=Y.encodeStateAsUpdate(changed)
    f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',3,'ydoc.update',?,3)")
      .run(JSON.stringify({versionId:'main',objectId:'object',path:'docs/a.md',contentKind:'richdoc',isBaseState:false,lineageClaimId:f.document.lineageClaimId,updateBlobSha256:hash(suffix)}))
    f.raw.prepare("INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)").run(hash(suffix),suffix.length,suffix)
    Object.assign(f.capture,{fullState});Object.assign(f.capture.source,{committedCursor:4,fullStateDigest:hash(fullState),fullStateByteLength:fullState.length})
    expect(await f.prepare()).toMatchObject({completed:false})
  }finally{changed.destroy();f.close()}
})
it('checks configured history entry and byte budgets before loading relay blobs',async()=>{
  const f=fixture();try{
    const read=vi.spyOn(f.storage,'getBlob')
    await expect(f.prepare({...bounds,maxEntriesPerDrain:1})).rejects.toThrow('entry budget')
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
  if(validation.kind!=='accepted')throw new Error(JSON.stringify(validation))
  return verifyOrdinaryActivationCut(f.storage as StorageContext,{...input,baseline:validation.baseline,history})
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
it('verifies a fresh capture after a losing base arrives behind the adopted one',async()=>{
  const f=fixture();try{
    await completeActivation(f)
    losingDevice(f).doc.destroy()
    expect(await verify(f)).toEqual({verified:true})
  }finally{f.close()}
})
it('neither applies nor charges a losing device\'s offline edit',async()=>{
  const f=fixture(),loser=losingDevice(f);try{
    const before=Y.encodeStateVector(loser.doc)
    loser.doc.getMap('frontmatter').set('offline','x'.repeat(bounds.maxBytesPerDrain))
    const delta=Y.encodeStateAsUpdate(loser.doc,before)
    append(f,'losing-device',2,'ydoc.update',ydocUpdate({isBaseState:false,lineageClaimId:loser.lineageClaimId,updateBlobSha256:hash(delta)}),delta)
    const read=vi.spyOn(f.storage,'getBlob')
    expect(await f.prepare({...bounds,maxEntriesPerDrain:2})).toEqual({document:f.document,replayed:false,completed:false})
    const digests=read.mock.calls.map(call=>call[1])
    expect(digests).not.toContain(loser.lineageClaimId)
    expect(digests).not.toContain(hash(delta))
    expect(f.store.read('workspace','docs/a.md',1_000_000)!.fullState).toEqual(new Uint8Array(f.capture.fullState))
  }finally{loser.doc.destroy();f.close()}
})
it('keeps losing rows out of the self-host entry budget and still charges the winner\'s own',async()=>{
  const f=fixture(),loser=losingDevice(f);try{
    const {maxCaptureBytes,maxEntriesPerDrain,maxBytesPerDrain}=selfHostLiveProfile().service.activation,readBounds={maxCaptureBytes,maxEntriesPerDrain,maxBytesPerDrain}
    for(let seq=2;seq<=maxEntriesPerDrain;seq++){
      append(f,'losing-device',seq,'ydoc.update',ydocUpdate({isBaseState:false,lineageClaimId:loser.lineageClaimId,updateBlobSha256:hash(Buffer.from(`losing-${seq}`))}))
    }
    expect(f.capture.source.committedCursor-f.capture.source.baseRelaySeq+1).toBeGreaterThan(maxEntriesPerDrain)
    expect(await verify(f,readBounds)).toEqual({verified:true})
    for(let seq=3;seq<=maxEntriesPerDrain+1;seq++){
      append(f,'origin',seq,'ydoc.update',ydocUpdate({isBaseState:false,lineageClaimId:f.document.lineageClaimId,updateBlobSha256:hash(Buffer.from(`winning-${seq}`))}))
    }
    await expect(verify(f,readBounds)).rejects.toThrow('Ordinary activation history exceeds its configured entry budget.')
  }finally{loser.doc.destroy();f.close()}
})
// Native ignores another lineage's rows, so a captured state that includes one is damaged evidence.
it('refuses a captured state that includes a row naming another lineage',async()=>{
  const f=fixture(),loser=losingDevice(f),doc=new Y.Doc();try{
    Y.applyUpdate(doc,f.capture.fullState);const before=Y.encodeStateVector(doc)
    doc.getMap('frontmatter').set('foreign','applied')
    const delta=Y.encodeStateAsUpdate(doc,before),fullState=Buffer.from(Y.encodeStateAsUpdate(doc))
    append(f,'losing-device',2,'ydoc.update',ydocUpdate({isBaseState:false,lineageClaimId:loser.lineageClaimId,updateBlobSha256:hash(delta)}),delta)
    Object.assign(f.capture,{fullState});Object.assign(f.capture.source,{fullStateDigest:hash(fullState),fullStateByteLength:fullState.length})
    await expect(f.prepare()).rejects.toThrow('Native activation differs from the complete ordinary CRDT history.')
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
  }finally{doc.destroy();loser.doc.destroy();f.close()}
})
type LosingDevice=ReturnType<typeof losingDevice>
it.each([
  ['an unknown lineage claim',(f,_loser)=>append(f,'losing-device',2,'ydoc.update',ydocUpdate({isBaseState:false,updateBlobSha256:hash(Buffer.from('unknown'))})),
    'Ordinary activation history differs from the captured lineage.'],
  ['a malformed lineage claim',(f,_loser)=>append(f,'losing-device',2,'ydoc.update',ydocUpdate({isBaseState:false,lineageClaimId:'unknown',updateBlobSha256:hash(Buffer.from('unknown'))})),
    'Ordinary activation history differs from the captured lineage.'],
  ['a lineage claim with an embedded NUL',(f,_loser)=>append(f,'losing-device',2,'ydoc.update',ydocUpdate({isBaseState:false,lineageClaimId:'b'.repeat(64)+'\u0000damaged',updateBlobSha256:hash(Buffer.from('unknown'))})),
    'Ordinary activation history differs from the captured lineage.'],
  ['a second base naming the captured lineage',(f,loser)=>append(f,'losing-device',2,'ydoc.update',ydocUpdate({isBaseState:true,lineageClaimId:f.document.lineageClaimId,updateBlobSha256:loser.lineageClaimId})),
    'Ordinary activation has a different baseline.'],
  ['a replaced file',(f,_loser)=>append(f,'losing-device',2,'moment.append',{versionId:'main',objectId:'object',momentId:'losing-delete',path:'docs/a.md',operation:'delete'}),
    'Ordinary activation history replaced the live document.'],
] as [string,(f:ReturnType<typeof fixture>,loser:LosingDevice)=>void,string][])('refuses %s beside a losing base',async(_evidence,add,message)=>{
  const f=fixture(),loser=losingDevice(f);try{
    add(f,loser)
    await expect(f.prepare()).rejects.toThrow(message)
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
  }finally{loser.doc.destroy();f.close()}
})
it('rejects a different replication epoch even at the same relay cursor',async()=>{
  const f=fixture();try{
    f.capture.source.replicationEpoch='foreign-epoch'
    await expect(f.prepare()).rejects.toThrow(ServiceActivationStaleCut)
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
it.each(['baseOriginId','sourceMomentId','sourceDigest','fullStateDigest'] as const)('rejects mismatched %s without publishing a live baseline',async field=>{
  const f=fixture();try{
    f.capture.source[field]='b'.repeat(64)
    await expect(f.prepare()).rejects.toThrow()
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual([])
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
it('does not accept an empty native outbox as an adoption acknowledgement',async()=>{
  const f=fixture();try{
    await f.prepare()
    expect(()=>f.store.complete({document:f.document,host,access:f.store.pending(f.document,host),
      nativeState:{adoptionId:f.capture.activationId,pendingBytes:0},guard(){}})).toThrow('acknowledgement is missing')
    expect(f.store.read('workspace','docs/a.md',1_000_000)!.completed).toBe(false)
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
it.each(['selector','host'] as const)('revalidates a private pending activation binding after its %s changes',async change=>{
  const f=fixture();try{
    await f.prepare()
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
it('revalidates the frozen activation source before acknowledging a captured owner cut',async()=>{
  const f=fixture();try{
    const owner=await ownerCapture(f)
    expect(owner.capture.cut.sourceMomentId).toBe(f.capture.source.sourceMomentId)
    expect(owner.capture.cut.sourceDigest).toBe(f.capture.source.sourceDigest)
    f.raw.exec("UPDATE sync_relay_service_activations SET source_json=json_set(source_json,'$.sourceMomentId','changed-source')")
    expect(owner.capture.assertCurrent).toThrow()
    expect(owner.acknowledge).toThrow()
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_delivery_owners').all()).toEqual([])
  }finally{f.close()}
})
it('rejects changed retained activation provenance when opening or revalidating owner delivery',async()=>{
  const f=fixture();try{
    const owner=await ownerCapture(f);owner.acknowledge()
    const opened=owner.delivery.openOwnerDelivery({host,document:f.document,actor})
    expect(()=>opened.assertCurrent()).not.toThrow()
    f.raw.exec("UPDATE sync_relay_service_activations SET source_json=json_set(source_json,'$.nativeHeadSequence',99)")
    expect(opened.assertCurrent).toThrow()
    expect(()=>owner.delivery.openOwnerDelivery({host,document:f.document,actor})).toThrow()
  }finally{f.close()}
})
// Native adoption of an ordinary activation saves sha256 of ["ordinary-replication", cut evidence, retained source],
// and a restore proposal returns that digest. The relay must record the same one, whatever order the source arrived in.
it('records the native ordinary-replication evidence for an activated service owner',async()=>{
  const f=fixture();try{
    f.capture.source=Object.fromEntries(Object.entries(f.capture.source).reverse()) as typeof f.capture.source
    const owner=await ownerCapture(f);owner.acknowledge()
    const origin=JSON.parse(String(f.raw.prepare('SELECT origin_json FROM sync_relay_live_delivery_owners').get()!.origin_json))
    const cut=owner.capture.cut,s=f.capture.source
    const cutEvidence=hash(Buffer.from(JSON.stringify([owner.capture.binding,cut.relayDatabaseNamespace,cut.sourceMomentId,cut.sourceDigest,
      cut.sourceByteLength,cut.baselineMomentRelaySequence,cut.baselineRegisteredAtMs,cut.expectedLocalSequence,[]])))
    const nativeSource=`{"version":1,"relayDatabaseNamespace":"history","workspaceId":"workspace","mainVersionId":"main","objectId":"object",`+
      `"lineageClaimId":"${f.document.lineageClaimId}","currentPath":"docs/a.md","replicationEpoch":"epoch","streamIdentity":"stream",`+
      `"committedCursor":3,"baseOriginId":"origin","baseOriginSeq":1,"baseRelaySeq":2,"sourceMomentId":"${s.sourceMomentId}",`+
      `"sourceDigest":"${s.sourceDigest}","sourceByteLength":${s.sourceByteLength},"nativeHeadSequence":2,`+
      `"fullStateDigest":"${s.fullStateDigest}","fullStateByteLength":${s.fullStateByteLength}}`
    expect(origin.originEvidenceDigest).toBe(hash(Buffer.from(`["ordinary-replication","${cutEvidence}",${nativeSource}]`)))
    expect(origin.originEvidenceDigest).not.toBe(cutEvidence)
    expect(owner.delivery.openOwnerDelivery({host,document:f.document,actor}).assertCurrent).not.toThrow()
  }finally{f.close()}
})

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

it('reopens the same pending source under a new connection without a new ordinary cut',async()=>{
  const f=fixture();let reopened:ReturnType<typeof openSyncRelayStorage>|undefined
  try{
    await f.prepare()
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
  const pull=vi.fn(async()=>({hasMore:false})),target={workspaceId:'workspace',path:'docs/a.md',shareId:'share'}
  const driver=new ServiceActivationDriver({trustedAccount:accountId=>({accountId,name:'Owner'}),storage:f.storage,history:f.history,host,
    client:{...native,captureOwnerActivation,sendRequest} as never,
    workspace:id=>id==='workspace'?{handle:'native-workspace',replica:{pull,publish:vi.fn()}}:undefined,
    config:{targets:[target],validateActivation,validateAdmission:validateJournal,maxCaptureBytes:1_000_000,maxEntriesPerDrain:10,maxBytesPerDrain:1_000_000,
      maxDocumentsPerPass:1,pollIntervalMs:1000,passDeadlineMs:10_000,idleUnloadMs:600_000,idleRetryMs:30_000,...config},
    adoption:{maxBytes:1_000_000,maxEvents:10},nextRequestId:()=>1,deadlineMs:1000,assertCurrent(){},registered(){},
    runDocument,
  })
  return {driver,target,pull}
}

// A completed service activation: adopted, seed accepted and applied natively.
async function completeActivation(f:ReturnType<typeof fixture>){
  await f.prepare()
  const access=f.store.pending(f.document,host),delivery=f.storage.createLiveCommittedDeliveryStore(f.history,access)
  const adoption=delivery.captureOwnerCut({host,document:f.document,actor,adoptionId:f.capture.activationId,
    expectedLocalSequence:2,maxBytes:1_000_000,maxEvents:100,throughCursor:0})
  delivery.acknowledgeOwnerAdoption(adoption,{adoptionId:f.capture.activationId,localYDocSequence:2,terminalCursor:0,adoptionReplayed:false})
  const current=f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor},access)
  const cut=f.storage.readLiveUpdateJournalCut({document:f.document})
  if(current.kind!=='current' || cut.kind!=='cut')throw new Error('Missing activation authority')
  const validation=validateJournal({document:f.document,currentPath:current.binding.currentPath,
    checkpoint:cut.cut.checkpoint.bytes,suffix:cut.cut.suffix.map(row=>row.bytes),candidate:f.capture.fullState})
  f.storage.commitLiveUpdateJournal({host,actor,expectedAuthority:current.authority,
    metadata:{deliveryId:'seed',updateDigest:hash(f.capture.fullState),binding:current.binding},cutToken:cut.cut,validation,
    updateBytes:f.capture.fullState,receivedAtMs:4},access)
  const owner=delivery.openOwnerDelivery({host,document:f.document,actor})
  const event=delivery.nextOwnerApplication(owner)!
  delivery.acknowledgeOwnerDeliveryApplication(owner,{...event.metadata.accepted.receipt,localYDocSequence:2,applicationReplayed:false})
  f.store.complete({document:f.document,host,access,nativeState:{adoptionId:f.capture.activationId,pendingBytes:0},guard(){}})
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
function commitEdit(f:ReturnType<typeof fixture>){
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
  return committed.admitted.metadata.accepted.receipt
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
      expectedLocalSequence:f.capture.source.nativeHeadSequence,throughCursor:0,outboxId:null,pendingBytes:0,outboxState:'active'}}
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

// Proves: an activation that passed its precheck and then waited for document
// work rechecks the exact binding under that work. A restore fence there is
// pending, not damaged evidence: no engine request, readiness cleared, and the
// same cut and owner continue once the exact binding opens. Periodic settlement
// runs inside that same work. It does not drive the restore lifecycle or the
// native fence; it applies the relay row change advanceStopRestoreFence commits.
it('reports a restore fence that lands while a completed activation waits for document work',async()=>{
  const f=fixture()
  try{
    const {d,work,key,send,capture,signal,fence,queueBehind}=await serializedActivation(f)
    const settle=vi.fn(async()=>{expect(work.busy(key)).toBe(true)})
    let drain=vi.spyOn(OwnerCommittedDelivery.prototype,'drain').mockResolvedValue({kind:'done'} as never)
    expect(await d.driver.activate(d.target,signal,settle)).toMatchObject({kind:'done'})
    expect(settle).toHaveBeenCalledTimes(1)
    // Only this first pass, which has no owner yet, catches up first.
    expect(d.pull).toHaveBeenCalledTimes(1)
    drain.mockRestore()

    const queued=queueBehind(()=>{
      f.raw.prepare("UPDATE sync_relay_live_documents SET admission_state='closed',restore_fence_generation=? WHERE admission_state='open' AND restore_fence_generation=?")
        .run(fence+1,fence)
      expect(f.storage.resolveCurrentLiveDocumentBinding({document:f.document,actor}).kind).not.toBe('current')
    },settle)
    await expect(queued).resolves.toMatchObject({kind:'pending'})
    expect(send).not.toHaveBeenCalled()
    expect(settle).toHaveBeenCalledTimes(1)
    expect(()=>d.driver.consumer(f.document)).toThrow('incomplete')
    expect(d.driver.workspaceReady('workspace')).toBe(false)

    // The exact binding opens again: activation proceeds on the same cut and owner.
    f.raw.prepare("UPDATE sync_relay_live_documents SET admission_state='open',restore_fence_generation=?").run(fence)
    drain=vi.spyOn(OwnerCommittedDelivery.prototype,'drain').mockResolvedValue({kind:'done'} as never)
    expect(await d.driver.activate(d.target,signal,settle)).toMatchObject({kind:'done'})
    drain.mockRestore()
    expect(settle).toHaveBeenCalledTimes(2)
    expect(d.driver.workspaceReady('workspace')).toBe(true)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(d.pull).toHaveBeenCalledTimes(1)
    expect(f.raw.prepare('SELECT count(*) AS n FROM sync_relay_service_activations').get()).toEqual({n:1})
    expect(f.raw.prepare('SELECT count(*) AS n FROM sync_relay_live_delivery_owners').get()).toEqual({n:1})
    expect(f.store.read('workspace','docs/a.md',1_000_000)!.source).toEqual(f.capture.source)

    // Damaged owner evidence on an open binding is still an integrity failure.
    f.raw.exec("UPDATE sync_relay_live_delivery_owners SET origin_json=json_set(origin_json,'$.sourceMomentId','unrelated-source')")
    await expect(d.driver.activate(d.target,signal,settle)).rejects.toThrow('Committed delivery evidence is damaged or conflicts.')
    expect(send).not.toHaveBeenCalled()
    expect(settle).toHaveBeenCalledTimes(2)
  }finally{vi.restoreAllMocks();f.close()}
})

// A binding that opens at another generation while an activation waits is not
// drained with the old owner. The next pass recaptures the retained source and
// revalidates it against the new binding.
it('revalidates a binding that changed while an activation waited for document work',async()=>{
  const f=fixture()
  try{
    const {d,capture,signal,fence,queueBehind}=await serializedActivation(f)
    const drain=vi.spyOn(OwnerCommittedDelivery.prototype,'drain').mockResolvedValue({kind:'done'} as never)
    expect(await d.driver.activate(d.target,signal)).toMatchObject({kind:'done'})
    const queued=queueBehind(()=>{
      f.raw.prepare('UPDATE sync_relay_live_documents SET restore_fence_generation=?').run(fence+1)
    })
    await expect(queued).resolves.toMatchObject({kind:'pending'})
    expect(drain).toHaveBeenCalledTimes(1)
    expect(()=>d.driver.consumer(f.document)).toThrow('incomplete')
    // The resumed source does not match the new generation, so it is refused.
    await expect(d.driver.activate(d.target,signal)).rejects.toThrow()
    expect(capture).toHaveBeenCalledTimes(2)
    expect(capture).toHaveBeenLastCalledWith(expect.objectContaining({workspace:'native-workspace'}),'docs/a.md',1_000_000,expect.any(AbortSignal),f.capture.activationId)
    expect(drain).toHaveBeenCalledTimes(1)
  }finally{vi.restoreAllMocks();f.close()}
})

// Proves: a fence already visible when the next pass starts clears readiness
// before any engine work, keeps the active consumer for the restore, and the
// same owner continues once the exact binding opens.
it('clears readiness when a restore fence is visible before the next activation',async()=>{
  const f=fixture()
  try{
    const native=nativeOwner(f),{d,capture,signal,fence}=await serializedActivation(f,native.client)
    expect(await d.driver.activate(d.target,signal)).toMatchObject({kind:'done'})
    const active=d.driver.consumer(f.document).consumer,calls=native.client.sendRequest.mock.calls.length
    fenceRestore(f,fence)
    expect(()=>d.driver.consumer(f.document)).toThrow('incomplete')
    await expect(d.driver.activate(d.target,signal)).resolves.toMatchObject({kind:'pending'})
    expect(native.client.sendRequest).toHaveBeenCalledTimes(calls)
    expect(()=>d.driver.consumer(f.document)).toThrow('incomplete')
    expect(d.driver.workspaceReady('workspace')).toBe(false)
    expect(d.driver.restoreConsumer(f.document,stop)).toBe(active)
    reopen(f,fence)
    expect(await d.driver.activate(d.target,signal)).toMatchObject({kind:'done'})
    expect(d.driver.consumer(f.document).consumer).toBe(active)
    expect(d.driver.workspaceReady('workspace')).toBe(true)
    expect(capture).toHaveBeenCalledTimes(1)
  }finally{vi.restoreAllMocks();f.close()}
})

// Proves: a fence committed while real owner delivery awaits native application
// is pending, not damaged evidence. Neither the applied reply nor durable ACK
// recovery after a lost reply is acknowledged on the fenced binding, and the
// same owner applies the entry once the exact binding opens.
it.each([['applied',false],['lost',true]] as const)('reports a restore fence during native owner application with an %s reply',async(_reply,lose)=>{
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

// Proves: a fence committed while settlement awaits native output does not
// leave the pass done or ready, and the materialized result is not cached as
// this binding's settlement.
it('reports a restore fence during native settlement without publishing readiness',async()=>{
  const f=fixture()
  try{
    const native=nativeOwner(f),{d,signal,fence}=await serializedActivation(f,native.client)
    const settle=(consumer:OwnerCommittedDelivery,document:Parameters<OwnerCommittedDelivery['settle']>[0],joined:AbortSignal)=>consumer.settle(document,joined)
    const parked=native.park('liveApplication.settle'),pass=d.driver.activate(d.target,signal,settle)
    await parked.entered.promise
    fenceRestore(f,fence)
    parked.release.resolve()
    await expect(pass).resolves.toMatchObject({kind:'pending'})
    expect(()=>d.driver.consumer(f.document)).toThrow('incomplete')
    expect(d.driver.workspaceReady('workspace')).toBe(false)
    reopen(f,fence)
    const settled=native.client.sendRequest.mock.calls.filter(([request])=>request.method==='liveApplication.settle').length
    expect(await d.driver.activate(d.target,signal,settle)).toMatchObject({kind:'done'})
    expect(native.client.sendRequest.mock.calls.filter(([request])=>request.method==='liveApplication.settle')).toHaveLength(settled+1)
    expect(d.driver.workspaceReady('workspace')).toBe(true)
  }finally{vi.restoreAllMocks();f.close()}
})

// Proves: readiness is published only after a final exact-binding check, even
// when the settlement callback itself cannot detect the fence.
it('does not publish readiness when the binding is fenced while settlement runs',async()=>{
  const f=fixture()
  try{
    const native=nativeOwner(f),{d,signal,fence}=await serializedActivation(f,native.client)
    await expect(d.driver.activate(d.target,signal,async()=>{fenceRestore(f,fence)})).resolves.toMatchObject({kind:'pending'})
    expect(()=>d.driver.consumer(f.document)).toThrow('incomplete')
    expect(d.driver.workspaceReady('workspace')).toBe(false)
  }finally{vi.restoreAllMocks();f.close()}
})

// Proves: cancellation during settlement wins over a fence and over an
// unchanged binding, and first readiness is not published.
it.each([['a fenced',true],['an unchanged',false]] as const)('keeps cancellation when settlement resolves after an abort with %s binding',async(_binding,fence)=>{
  const f=fixture()
  try{
    const native=nativeOwner(f),{d,fence:generation}=await serializedActivation(f,native.client)
    const abort=new AbortController(),reason=new Error('Pass cancelled.')
    await expect(d.driver.activate(d.target,abort.signal,async()=>{if(fence)fenceRestore(f,generation);abort.abort(reason)})).rejects.toBe(reason)
    expect(()=>d.driver.consumer(f.document)).toThrow('incomplete')
    expect(d.driver.workspaceReady('workspace')).toBe(false)
  }finally{vi.restoreAllMocks();f.close()}
})

// Proves: damaged owner evidence on an unchanged open binding during a native
// await stays an integrity failure rather than an expected fence.
it('keeps damaged owner evidence on an open binding as an integrity failure during native application',async()=>{
  const f=fixture()
  try{
    const native=nativeOwner(f),{d,signal}=await serializedActivation(f,native.client)
    expect(await d.driver.activate(d.target,signal)).toMatchObject({kind:'done'})
    commitEdit(f);const tip=ownerTip(f)
    const parked=native.park('sendLiveApplication'),pass=d.driver.activate(d.target,signal)
    await parked.entered.promise
    f.raw.exec("UPDATE sync_relay_live_delivery_owners SET origin_json=json_set(origin_json,'$.sourceMomentId','unrelated-source')")
    parked.release.resolve()
    await expect(pass).rejects.toThrow('Committed delivery evidence is damaged or conflicts.')
    expect(ownerTip(f)).toBe(tip)
  }finally{vi.restoreAllMocks();f.close()}
})
// Proves: a restore cannot start while the document's service activation is
// pending, before or after native adoption. Once fenced, that activation could
// never complete, and the service restore consumer requires a completed one.
it.each([['before',false],['after',true]] as const)('refuses to start a restore while service activation is pending %s native adoption',async(_when,adopted)=>{
  const f=fixture();try{
    if(adopted)(await ownerCapture(f)).acknowledge();else await f.prepare()
    f.raw.exec("INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES ('grant','share','user','reader',NULL,'edit',1,'active',0,NULL,NULL)")
    expect(()=>f.storage.readStopRestorePlan({document:f.document,ownerUserId:'owner',operationId:'restore',shareId:'share',grantId:'grant',
      restorePointCursor:0,restorePointReceiptDigest:f.document.lineageClaimId,maxOutputBytes:1_000_000})).toThrow('conflicts with current authority')
    const intent:StopRestoreIntent={deliveryKind:adopted?'owner':'bootstrap',operationId:'restore',ownerUserId:'owner',document:f.document,
      shareId:'share',grantId:'grant',expectedGrantGeneration:1,expectedDependentGrantIds:[],expectedFence:1,restorePointCursor:0,
      restorePointReceiptDigest:f.document.lineageClaimId}
    expect(()=>f.storage.beginStopRestore(intent,40)).toThrow('conflicts with current authority')
    expect(f.storage.getShareGrant('grant')).toMatchObject({status:'active',generation:1})
    expect(f.raw.prepare('SELECT admission_state,restore_fence_generation AS fence FROM sync_relay_live_documents').get()).toEqual({admission_state:'open',fence:1})
  }finally{f.close()}
})
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
it('releases a capture and tries again on a later pass while live validation is busy',async()=>{
  const f=fixture();try{
    const send=vi.fn(async()=>({result:{released:true}}))
    const d=activationDriver(f,vi.fn(async()=>f.capture),send,undefined,undefined,{validateActivation:async()=>({kind:'retry',reason:'admission-unavailable'})})
    expect(await d.driver.activate(d.target,new AbortController().signal)).toEqual({kind:'pending',reason:'Live validation is busy.'})
    expect(send).toHaveBeenCalledWith(expect.objectContaining({method:'liveApplication.releaseOwnerActivation'}),expect.any(AbortSignal))
    expect(d.driver.blocked(d.target)).toBeUndefined()
    expect(f.raw.prepare('SELECT * FROM sync_relay_service_activations').all()).toEqual([])
  }finally{f.close()}
})
it('releases a heap-refused capture\'s lease on the next pass after its first release fails, while the target stays blocked',async()=>{
  const f=fixture();try{
    const send=vi.fn(async()=>({result:{released:true}}))
    send.mockImplementationOnce(async()=>{throw new Error('release lost')})
    const capture=vi.fn(async()=>f.capture)
    const d=activationDriver(f,capture,send,undefined,undefined,{validateActivation:async()=>({kind:'capacity-refused'})})
    await expect(d.driver.activate(d.target,new AbortController().signal)).rejects.toThrow('release lost')
    expect(d.driver.blocked(d.target)).toBe('refused')
    expect(await d.driver.activate(d.target,new AbortController().signal)).toEqual({kind:'pending',reason:'Hosted document is blocked until the owner tries again.'})
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({method:'liveApplication.releaseOwnerActivation',
      params:{activationId:f.capture.activationId,sessionId:'real-session'}}),expect.any(AbortSignal))
    await d.driver.activate(d.target,new AbortController().signal)
    expect(send).toHaveBeenCalledTimes(2)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(d.driver.blocked(d.target)).toBe('refused')
  }finally{f.close()}
})
it('releases the lease of a capture the pass deadline aborted during validation before the next pass pulls',async()=>{
  const f=fixture();try{
    const order:string[]=[],send=vi.fn(async()=>{order.push('release');return {result:{released:true}}})
    const deadline=new AbortController(),reason=new Error('Pass deadline reached.')
    let validations=0
    const validate:OrdinaryActivationValidator=async(_work,signal)=>{
      if(validations++===0){deadline.abort(reason);signal?.throwIfAborted()}
      return {kind:'retry',reason:'admission-unavailable'}
    }
    const capture=vi.fn(async()=>{order.push('capture');return f.capture})
    const d=activationDriver(f,capture,send,undefined,undefined,{validateActivation:validate})
    d.pull.mockImplementation(async()=>{order.push('pull');return {hasMore:false}})
    await expect(d.driver.activate(d.target,deadline.signal)).rejects.toBe(reason)
    expect(order).toEqual(['pull','capture'])
    expect(await d.driver.activate(d.target,new AbortController().signal)).toEqual({kind:'pending',reason:'Live validation is busy.'})
    expect(order).toEqual(['pull','capture','release','pull','capture','release'])
    expect(send).toHaveBeenCalledWith(expect.objectContaining({method:'liveApplication.releaseOwnerActivation',
      params:{activationId:f.capture.activationId,sessionId:'real-session'}}),expect.any(AbortSignal))
    expect(f.raw.prepare('SELECT * FROM sync_relay_service_activations').all()).toEqual([])
  }finally{f.close()}
})
it('releases the lease of a capture whose validation worker exited before the next pass pulls',async()=>{
  const f=fixture();try{
    const order:string[]=[],send=vi.fn(async()=>{order.push('release');return {result:{released:true}}})
    let validations=0
    const validate:OrdinaryActivationValidator=async()=>{
      if(validations++===0)throw new Error('Live validation worker exited.')
      return {kind:'retry',reason:'admission-unavailable'}
    }
    const capture=vi.fn(async()=>{order.push('capture');return f.capture})
    const d=activationDriver(f,capture,send,undefined,undefined,{validateActivation:validate})
    d.pull.mockImplementation(async()=>{order.push('pull');return {hasMore:false}})
    const signal=new AbortController().signal
    await expect(d.driver.activate(d.target,signal)).rejects.toThrow('Live validation worker exited.')
    expect(signal.aborted).toBe(false)
    expect(order).toEqual(['pull','capture'])
    expect(await d.driver.activate(d.target,new AbortController().signal)).toEqual({kind:'pending',reason:'Live validation is busy.'})
    expect(order).toEqual(['pull','capture','release','pull','capture','release'])
    expect(send).toHaveBeenCalledWith(expect.objectContaining({method:'liveApplication.releaseOwnerActivation',
      params:{activationId:f.capture.activationId,sessionId:'real-session'}}),expect.any(AbortSignal))
    expect(f.raw.prepare('SELECT * FROM sync_relay_service_activations').all()).toEqual([])
  }finally{f.close()}
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
// A retained activation the read found can go before the transaction; its capture's history was never read or validated.
it('refuses a capture as stale when the retained activation it read is gone by the transaction',async()=>{
  const f=fixture();try{
    const read=vi.spyOn(f.storage,'getBlob')
    await f.prepare()
    expect(read).toHaveBeenCalled()
    read.mockClear()
    const documents=f.raw.prepare('SELECT * FROM sync_relay_live_documents').all(),control=f.storage.getLiveHostControl()
    const validate:OrdinaryActivationValidator=async work=>{
      expect(work.cut).toBeUndefined()
      f.raw.exec('DELETE FROM sync_relay_service_activations')
      return validateActivation(work)
    }
    await expect(f.prepare(bounds,validate)).rejects.toThrow(ServiceActivationStaleCut)
    // It refuses before reading the history it never validated.
    expect(read).not.toHaveBeenCalled()
    expect(f.raw.prepare('SELECT * FROM sync_relay_service_activations').all()).toEqual([])
    expect(f.raw.prepare('SELECT * FROM sync_relay_live_documents').all()).toEqual(documents)
    expect(f.storage.getLiveHostControl()).toEqual(control)
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
    await expect(resumed.driver.activate(resumed.target,new AbortController().signal)).resolves.toMatchObject({kind:'pending',reason:'transport interrupted'})
    expect(order).toEqual(['pull','capture'])
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({workspace:'native-workspace'}),'docs/a.md',1_000_000,expect.any(AbortSignal),f.capture.activationId)
    expect(send).not.toHaveBeenCalled()
    expect(f.raw.prepare('SELECT count(*) AS n FROM sync_relay_service_activations').get()).toEqual({n:1})
    expect(f.store.read('workspace','docs/a.md',1_000_000)).toMatchObject({activationId:f.capture.activationId,source:f.capture.source})
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
