import {readBoundedJson,type TokenBucketLimiter} from "@dohc/service-http";
import {parseAppCollectionCreateRequest,parseAppCollectionReadQuery,APP_COLLECTION_REQUEST_BYTES,APP_COLLECTION_RESPONSE_BYTES,type AppPublicationLimits} from "@dohc/security-contract/app-publication";
import type {PublicEditRelease} from "@dohc/security-contract";
import {hashLinkProfileSecret,type ValidatedLinkCapability,type LinkEgressRateLimiter} from "./linkSecurity";
import {LINK_SECRET_PATTERN} from "@dohc/security-contract/wire-patterns";
import {badRequest,notFound,relayError} from "./errors";
import type {SyncRelayStorage} from "./storage";
import type {createLinkResponseStreams} from "./linkResponseStreams";
import type {DiscussionActivityHub} from "./discussionActivity";

export type LinkAppCollectionRoute={route:"link-app-collection";publicationId:string};
export interface AppCollectionPolicy {maxCreatesPerGrant:number}
const RESPONSE_BYTES=APP_COLLECTION_RESPONSE_BYTES;
const BODY_DEADLINE_MS=30_000;
export function createLinkAppCollectionRoutes(options:{
  storage:SyncRelayStorage;limits?:AppPublicationLimits;policy?:AppCollectionPolicy;
  linkKey:string|Uint8Array;publicEditRelease?:PublicEditRelease;nowMs():number;
  requireLinkRead(request:Request,capabilityLimiter:TokenBucketLimiter,grantLimiter:TokenBucketLimiter):{capability:ValidatedLinkCapability};
  capabilityLimiter:TokenBucketLimiter;grantLimiter:TokenBucketLimiter;
  egress:Pick<LinkEgressRateLimiter,"reserve">;
  streams:Pick<ReturnType<typeof createLinkResponseStreams>,"admitLinkBlobBytes"|"respondWithLinkBytes">;
  discussionActivity:Pick<DiscussionActivityHub,"wakeLog">;
}) {
  const limits=options.limits&&{...options.limits},policy=options.policy&&{...options.policy};
  if(policy&&(!limits||!Number.isSafeInteger(policy.maxCreatesPerGrant)||policy.maxCreatesPerGrant<1))throw new TypeError("Invalid app collection policy.");
  return async(request:Request,route:LinkAppCollectionRoute):Promise<Response>=>{
    if(!limits||!policy||request.headers.has("cookie"))throw notFound();
    const {capability}=options.requireLinkRead(request,options.capabilityLimiter,options.grantLimiter);
    const secret=request.headers.get("x-dohc-link-profile-secret");
    if(!secret||!LINK_SECRET_PATTERN.test(secret))throw notFound();
    if(request.method!=="GET"&&request.method!=="POST")throw relayError("method_not_allowed");
    const query=new URL(request.url).searchParams;
    if(request.method==="POST"&&(query.size!==0||request.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase()!=="application/json"))throw badRequest("Collection creates require JSON and no query.");
    const base={publicationId:route.publicationId,capabilityHash:capability.session.capabilityHash,profileTokenHash:hashLinkProfileSecret(secret,options.linkKey),limits,publicEditRelease:options.publicEditRelease};
    const signal=AbortSignal.any([request.signal,options.storage.unavailable]);signal.throwIfAborted();
    const admitted=options.storage.authorizeLinkAppCollection({...base,nowMs:options.nowMs()});
    const releaseBytes=options.streams.admitLinkBlobBytes(admitted.grantId,RESPONSE_BYTES+(request.method==="POST"?APP_COLLECTION_REQUEST_BYTES:0));
    if(!releaseBytes)throw relayError("link_read_rate_limited");
    const settleEgress=options.egress.reserve(admitted.grantId,RESPONSE_BYTES,options.nowMs());
    if(!settleEgress){releaseBytes();throw relayError("link_read_rate_limited");}
    let streamOwnsAdmission=false;
    try{
      let result:unknown,expectedAuthorityRevision:number;
      if(request.method==="GET"){
        let input;try{input=parseAppCollectionReadQuery(query);}catch{throw badRequest("Invalid collection query.");}
        expectedAuthorityRevision=input.authorityRevision;
        result=options.storage.readAppCollection({...base,expectedAuthorityRevision,limit:input.limit,afterPath:input.afterPath,nowMs:options.nowMs()});
      }else{
        const bodySignal=AbortSignal.any([signal,AbortSignal.timeout(BODY_DEADLINE_MS)]);
        let raw:unknown;
        try{raw=await readBoundedJson(request,APP_COLLECTION_REQUEST_BYTES,bodySignal);}
        catch(error){signal.throwIfAborted();if(error instanceof RangeError)throw relayError("payload_too_large");throw badRequest("Invalid collection JSON body.");}
        signal.throwIfAborted();
        let input;try{input=parseAppCollectionCreateRequest(raw);}catch{throw badRequest("Invalid collection request.");}
        expectedAuthorityRevision=input.authorityRevision;
        result=options.storage.acceptAppCollection({...base,expectedAuthorityRevision,idempotencyKey:input.idempotencyKey,fields:input.fields,nowMs:options.nowMs()},policy);
        // The submission is a moment in the owner's log: wake the owner's devices.
        const workspaceId=options.storage.getShare(admitted.shareId)?.workspaceId;
        if(workspaceId!==undefined)options.discussionActivity.wakeLog(workspaceId);
      }
      const bytes=new TextEncoder().encode(JSON.stringify(result));
      if(bytes.byteLength>RESPONSE_BYTES)throw new Error("Collection response exceeded its admitted bound.");
      const guard=()=>{signal.throwIfAborted();options.storage.authorizeLinkAppCollection({...base,expectedAuthorityRevision,nowMs:options.nowMs()});};
      guard();
      const response=options.streams.respondWithLinkBytes(bytes,admitted.shareId,admitted.grantId,releaseBytes,settleEgress,{
        "content-type":"application/json","content-length":String(bytes.byteLength),"cache-control":"private, no-store",
        "cross-origin-resource-policy":"same-origin","x-content-type-options":"nosniff",
      },{guard,signal});
      streamOwnsAdmission=true;return response;
    }finally{if(!streamOwnsAdmission){releaseBytes();settleEgress(0,options.nowMs());}}
  };
}
