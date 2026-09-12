import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {compileClosedApp} from '../../../apps/desktop/src/workspaces/closedAppCompiler';
import {openSyncRelayStorage} from '../../sync-relay/src/storage';
import {createSyncRelayHandler} from '../../sync-relay/src/server';
import {hashLinkBearer} from '../../sync-relay/src/linkSecurity';
import {createShareWebApplication} from '../src/server';
import {parseAppPublicationCandidate,APP_PUBLICATION_MAX_FILES,APP_PUBLICATION_MAX_METADATA_BYTES,APP_PUBLICATION_MAX_BUNDLE_BYTES} from '@dohc/security-contract/app-publication';

export async function tripPollProductFixture(evidence:string,viewerAssetsDir:string){
  const root=mkdtempSync(join(tmpdir(),'dohc-trip-product-'));
  let storage:ReturnType<typeof openSyncRelayStorage>|undefined;
  try{
  execFileSync(process.execPath,[fileURLToPath(new URL('../../../apps/desktop/scripts/stage-trip-poll.mjs',import.meta.url)),root],{windowsHide:true,stdio:'pipe'});
  const declaration=JSON.parse(readFileSync(join(root,'trip-poll/app.publish.json'),'utf8'));
  const digest=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
  const inputs=declaration.inputs.map((path:string)=>{const bytes=readFileSync(join(root,path));return{path,bytes,sha256:digest(bytes)};});
  const bundle=await compileClosedApp({entryPath:declaration.entryPath,inputs,packageMap:declaration.packageMap,bounds:{maxInputFiles:512,maxInputBytes:128*1024*1024,maxOutputBytes:32*1024*1024}});
  storage=openSyncRelayStorage(join(root,'relay.sqlite'));const secret='S'.repeat(43);
  const key='app-launch-fixture-key-with-more-than-thirty-two-bytes',exchangeKey='app-launch-relay-exchange-key-with-more-than-thirty-two-bytes';
  const viewerOrigin='https://viewer.example.com',limits={maxFiles:APP_PUBLICATION_MAX_FILES,maxMetadataBytes:APP_PUBLICATION_MAX_METADATA_BYTES,maxBundleBytes:APP_PUBLICATION_MAX_BUNDLE_BYTES};
  storage.claimWorkspace({workspaceId:'w',ownerUserId:'owner',createdAtMs:1});
  storage.createFileLinkShare({share:{shareId:'g',workspaceId:'w',granterUserId:'owner',selectorJson:JSON.stringify({paths:['trip-poll'],versionId:null}),createdAtMs:1},grant:{grantId:'g',shareId:'g',principalKind:'link',principalUserId:null,principalEmail:null,access:'view',generation:1,status:'active',createdAtMs:1,revokedAtMs:null,parentGrantId:null},credential:{credentialId:'g',grantId:'g',secretHash:hashLinkBearer(secret,key),generation:1,mintedAtMs:1,retiredAtMs:null},guard:()=>{}});
  const schemaPath='trip-poll/responses/collection.yaml',schema=readFileSync(join(root,schemaPath));
  const capability={...declaration.collection,schemaSha256:digest(schema)};
  const files=[...inputs,{path:schemaPath,bytes:schema,sha256:digest(schema)}];
  for(const file of files)storage.putBlob({workspaceId:'w',sha256:file.sha256,content:file.bytes,createdAtMs:1});
  storage.appendLogBatch({workspaceId:'w',originId:'owner',ops:files.map((file,index)=>({originSeq:index,opKind:'moment.append',recordedAtMs:1,payloadJson:JSON.stringify({momentId:'source-'+index,versionId:'main',objectId:'source-'+index,path:file.path,recordedAtMs:1,operation:'write',beforePresent:'null',payloadBeforeBlobSha256:null,payloadBeforePath:null,payloadAfterBlobSha256:file.sha256,payloadAfterPath:file.path,payloadAfterContentKind:'text',payloadAfterByteLength:file.bytes.byteLength,metadata:{origin:'api'}})}))});
  const candidate=parseAppPublicationCandidate({versionId:'main',appRoot:'trip-poll',entryPath:declaration.entryPath,packageMap:declaration.packageMap,sourceRevision:digest(JSON.stringify(inputs.map(({path,sha256}:{path:string;sha256:string})=>({path,sha256})))),sourceDigest:bundle.sourceDigest,dependencyLockDigest:bundle.dependencyLockDigest,bundleDigest:bundle.bundleDigest,buildDigest:bundle.buildDigest,compilerIdentity:bundle.compiler,inputs:inputs.map(({path,sha256,bytes}:{path:string;sha256:string;bytes:Uint8Array})=>({path,sha256,byteLength:bytes.byteLength})),dependencies:bundle.dependencyLock.map(file=>file.path),files:bundle.files.map(({bytes,...file})=>file),capabilities:[capability]},limits);
  const publication=storage.publishAppPublication({workspaceId:'w',shareId:'g',grantId:'g',generation:1,ownerUserId:'owner',candidate,limits,nowMs:Date.now(),blobs:bundle.files.map(file=>({sha256:file.sha256,bytes:file.bytes}))});
  storage.approveAppCollection({workspaceId:'w',publicationId:publication.publicationId,ownerUserId:'owner',limits,expectedAuthorityRevision:1,capability});
  const relay=createSyncRelayHandler({storage,appPublicationLimits:limits,appCollectionPolicy:{maxCreatesPerGrant:20},linkKey:key,relayExchangeKey:exchangeKey,shareWebOrigin:viewerOrigin,resolveActor:()=>{throw Error('Browser link must not become owner');}});
  const relayEvents:Array<{path:string;status:number}>=[];
  const app=createShareWebApplication({relayUrl:'https://relay.example.org',publicRelayUrl:'https://relay.example.org',relayExchangeKey:exchangeKey,publicHosts:new Set(['viewer.example.com']),viewerAssetsDir,appLaunch:{viewerOrigin,appDomain:'example.net'},fetchRelay:async request=>{const response=await relay(request);relayEvents.push({path:new URL(request.url).pathname,status:response.status});return response;}});
  const artifact={sourceRoot:root,compiler:bundle.compiler,sourceDigest:bundle.sourceDigest,buildDigest:bundle.buildDigest,publicationId:publication.publicationId,files:candidate.files,limits,processId:process.pid,scope:'Production viewer, compiler, share-web, relay and SQLite. Fixture supplies captured bytes and owner publication/approval; native capture and adoption are not exercised.'};
  writeFileSync(join(evidence,'p5-trip-product-artifact.json'),JSON.stringify(artifact,null,2));
  return{app,secret,artifact,withdraw(){storage!.withdrawAppPublication({workspaceId:'w',publicationId:publication.publicationId,ownerUserId:'owner',expectedAuthorityRevision:2});},close(){try{writeFileSync(join(evidence,'p5-trip-product-relay-attempt.json'),JSON.stringify(relayEvents,null,2));}finally{storage!.close();rmSync(root,{recursive:true,force:true});}}};
  }catch(error){storage?.close();rmSync(root,{recursive:true,force:true});throw error;}
}
