import {readBoundedJson} from '@dohc/service-http';
import {parseAppCollectionCreateRequest,parseAppCollectionReadQuery,APP_COLLECTION_REQUEST_BYTES} from '@dohc/security-contract/app-publication';
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const responseHeaders={'cache-control':'private, no-store','cross-origin-resource-policy':'same-origin','x-content-type-options':'nosniff'};
const error=(status:number)=>new Response(null,{status,headers:responseHeaders});

export async function forwardAppCollection(input:{request:Request;relayUrl:string;publicationId:string;authorityRevision:number;capability:string;profileSecret:string;signal:AbortSignal;fetchRelay(request:Request):Promise<Response>}):Promise<Response>{
  if(input.request.headers.get('content-type')!=='application/json')return error(400);
  let body:unknown;
  try{body=await readBoundedJson(input.request,APP_COLLECTION_REQUEST_BYTES,input.signal);}catch(errorValue){return error(errorValue instanceof RangeError?413:400);}
  if(!record(body)||typeof body.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(body.id))return error(400);
  const keys=Object.keys(body).sort().join(),url=new URL(`/sync/link/app-publications/${input.publicationId}/collection`,input.relayUrl);
  let method='GET',payload:string|undefined;
  try{
    if(body.op==='collection.list'){
      if(!['id,limit,op','afterPath,id,limit,op'].includes(keys)||typeof body.limit!=='number'||!Number.isSafeInteger(body.limit)||body.limit<1||body.limit>100||(body.afterPath!==undefined&&typeof body.afterPath!=='string'))return error(400);
      const query=new URLSearchParams({authorityRevision:String(input.authorityRevision),limit:String(body.limit),...(body.afterPath===undefined?{}:{afterPath:body.afterPath})});
      parseAppCollectionReadQuery(query);url.search=query.toString();
    }else if(body.op==='collection.create'){
      if(keys!=='fields,id,idempotencyKey,op')return error(400);
      payload=JSON.stringify(parseAppCollectionCreateRequest({authorityRevision:input.authorityRevision,idempotencyKey:body.idempotencyKey,fields:body.fields}));method='POST';
    }else return error(400);
  }catch{return error(400);}
  let relay:Response;
  try{relay=await input.fetchRelay(new Request(url,{method,body:payload,redirect:'manual',signal:input.signal,headers:{authorization:`LinkCapability ${input.capability}`,'x-dohc-link-profile-secret':input.profileSecret,...(payload?{'content-type':'application/json'}:{})}}));}catch{return error(503);}
  try{
    if(relay.status!==200||relay.redirected||relay.headers.has('location'))return error(relay.status===401||relay.status===403?404:[400,404,409,413,429].includes(relay.status)?relay.status:503);
    const value=await readBoundedJson(relay,1024*1024,input.signal);
    if(!record(value))return error(503);
    if(method==='GET'){
      if(Object.keys(value).sort().join()!=='nextPath,records'||!Array.isArray(value.records)||value.records.length>(body.limit as number)||(value.nextPath!==null&&typeof value.nextPath!=='string'))return error(503);
      for(const row of value.records)if(!record(row)||Object.keys(row).sort().join()!=='fields,path,recordId'||typeof row.path!=='string'||(row.recordId!==null&&typeof row.recordId!=='string')||!record(row.fields))return error(503);
    }else if(Object.keys(value).sort().join()!=='acceptanceId,acceptedAtMs,kind,momentId,objectId,path'||value.kind!=='accepted'||['acceptanceId','momentId','objectId','path'].some(key=>typeof value[key]!=='string')||!Number.isSafeInteger(value.acceptedAtMs))return error(503);
    input.signal.throwIfAborted();return Response.json(value,{headers:responseHeaders});
  }catch{return error(503);}finally{await relay.body?.cancel().catch(()=>{});}
}
