import {badRequest,notFound,relayError} from "./errors";
import type {SyncRelayStorage} from "./storage";

export type OwnerAppResponseRoute={route:"owner-app-responses";workspaceId:string;grantId:string};
export function readOwnerAppResponses(request:Request,route:OwnerAppResponseRoute,ownerUserId:string,storage:SyncRelayStorage):Response {
  if(request.method!=="GET")throw relayError("method_not_allowed");
  if(!storage.workspaceIsOwnedBy(route.workspaceId,ownerUserId))throw notFound();
  const query=new URL(request.url).searchParams;
  for(const key of query.keys())if(!["publicPrincipalId","afterAcceptanceId","limit"].includes(key) || query.getAll(key).length!==1)throw badRequest("Invalid response selection.");
  const limit=Number(query.get("limit")??100);
  const page=storage.readOwnerAppCollectionAcceptances({workspaceId:route.workspaceId,ownerUserId,grantId:route.grantId,
    publicPrincipalId:query.get("publicPrincipalId")??undefined,afterAcceptanceId:query.get("afterAcceptanceId")??undefined,limit});
  return new Response(JSON.stringify(page),{headers:{"content-type":"application/json","cache-control":"private, no-store"}});
}
