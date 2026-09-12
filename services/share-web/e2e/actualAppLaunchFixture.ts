import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openSyncRelayStorage} from '../../sync-relay/src/storage';
import {createSyncRelayHandler} from '../../sync-relay/src/server';
import {hashLinkBearer,hashLinkProfileSecret} from '../../sync-relay/src/linkSecurity';
import type {StorageContext} from '../../sync-relay/src/storage/context';
import {parseAppPublicationCandidate} from '@dohc/security-contract/app-publication';
import {createShareWebApplication} from '../src/server';

export function actualAppLaunchFixture(script:Uint8Array){
  const root=mkdtempSync(join(tmpdir(),'dohc-app-launch-real-')),storage=openSyncRelayStorage(join(root,'relay.sqlite'));
  const key='app-launch-fixture-key-with-more-than-thirty-two-bytes',exchangeKey='app-launch-relay-exchange-key-with-more-than-thirty-two-bytes';
  const profile='P'.repeat(43),secret='S'.repeat(43),wrongSecret='W'.repeat(43),viewerOrigin='https://viewer.example.com';
  const digest=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
  const limits={maxFiles:10,maxMetadataBytes:16384,maxBundleBytes:4096};
  storage.claimWorkspace({workspaceId:'w',ownerUserId:'owner',createdAtMs:1});
  for(const [grantId,link] of [['g',secret],['wrong',wrongSecret]])storage.createFileLinkShare({
    share:{shareId:grantId!,workspaceId:'w',granterUserId:'owner',selectorJson:JSON.stringify({paths:['app'],versionId:null}),createdAtMs:1},
    grant:{grantId:grantId!,shareId:grantId!,principalKind:'link',principalUserId:null,principalEmail:null,access:'view',generation:1,status:'active',createdAtMs:1,revokedAtMs:null,parentGrantId:null},
    credential:{credentialId:grantId!,grantId:grantId!,secretHash:hashLinkBearer(link!,key),generation:1,mintedAtMs:1,retiredAtMs:null},guard:()=>{}});
  const candidate=parseAppPublicationCandidate({versionId:'main',appRoot:'app',entryPath:'app/index.js',packageMap:{},sourceRevision:'1'.repeat(64),sourceDigest:'2'.repeat(64),dependencyLockDigest:'3'.repeat(64),bundleDigest:'4'.repeat(64),buildDigest:'5'.repeat(64),compilerIdentity:{recipe:'closed-esbuild',version:'0.28.1',binarySha256:'6'.repeat(64)},inputs:[{path:'app/index.js',sha256:digest(script),byteLength:script.byteLength}],dependencies:['app/index.js'],files:[{path:'bundle.js',sha256:digest(script),byteLength:script.byteLength,contentType:'text/javascript; charset=utf-8'}],capabilities:[]},limits);
  const record=(domain:string,value:unknown)=>digest(JSON.stringify([domain,value]));
  candidate.sourceDigest=record('dohc-app-source-v2',{entry:candidate.entryPath,files:candidate.inputs,packages:[]});candidate.dependencyLockDigest=record('dohc-app-dependencies-v1',candidate.inputs);candidate.bundleDigest=record('dohc-app-bundle-v1',candidate.files);candidate.buildDigest=record('dohc-app-build-v1',{sourceDigest:candidate.sourceDigest,dependencyLockDigest:candidate.dependencyLockDigest,compiler:candidate.compilerIdentity,bundleDigest:candidate.bundleDigest});
  const published=storage.publishAppPublication({workspaceId:'w',shareId:'g',grantId:'g',generation:1,ownerUserId:'owner',candidate,limits,nowMs:Date.now(),blobs:[{sha256:digest(script),bytes:script}]});
  const relay=createSyncRelayHandler({storage,appPublicationLimits:limits,linkKey:key,relayExchangeKey:exchangeKey,shareWebOrigin:viewerOrigin,resolveActor:()=>{throw Error('App link requests must not resolve an account');}});
  const application=createShareWebApplication({relayUrl:'https://relay.example.org',publicRelayUrl:'https://relay.example.org',relayExchangeKey:exchangeKey,publicHosts:new Set(['viewer.example.com']),newProfileSecret:()=>profile,appLaunch:{viewerOrigin,appDomain:'example.net'},fetchRelay:relay});
  return {application,publicationId:published.publicationId,secret,wrongSecret,
    blockProfile(){(storage as StorageContext).db.prepare("INSERT INTO sync_relay_link_principals(principal_id,grant_id,mint_generation,profile_token_hash,created_at_ms,blocked_at_ms,storage_bytes) VALUES('blocked','g',1,?,1,2,1)").run(hashLinkProfileSecret(profile,key));},
    withdraw(){storage.withdrawAppPublication({workspaceId:'w',publicationId:published.publicationId,ownerUserId:'owner',expectedAuthorityRevision:1});},
    close(){storage.close();rmSync(root,{recursive:true,force:true});}};
}
