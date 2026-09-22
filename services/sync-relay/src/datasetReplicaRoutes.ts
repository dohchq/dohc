import { readBoundedJson } from "@dohc/service-http";
import { DatasetHostError } from "@dohc/app-backend-runtime/dataset-host";
import { JournalError } from "@dohc/app-backend-runtime/journal";
import type { DatasetCursor, JournalExportRecord } from "@dohc/app-backend-runtime/journal";
import type { RelayDatasetHost } from "./datasetHost";
import type { AppBackendAuth } from "./appBackendAuthority";
import type { SyncRelayStorage } from "./storage";
import { createAppBackendAdmission, type AppBackendAdmissionLimits } from "./appBackendAdmission";
import { badRequest, notFound, relayError } from "./errors";

export interface DatasetReplicaRoute {route:"dataset-replica";workspaceId:string;datasetId:string;action:"capture"|"page"|"blob"}
const headers={"cache-control":"private, no-store","cross-origin-resource-policy":"same-origin","x-content-type-options":"nosniff"};
export function createDatasetReplicaRoutes(host:RelayDatasetHost,storage:SyncRelayStorage,options:{limits?:Partial<AppBackendAdmissionLimits>;nowMs():number}){
 const admit=createAppBackendAdmission(options.limits);
 return async(request:Request,route:DatasetReplicaRoute,auth:Extract<AppBackendAuth,{kind:"named"}>)=>{
  if(!storage.workspaceIsOwnedBy(route.workspaceId,auth.userId)||auth.grantId)throw notFound();
  if(request.method!==(route.action==="capture"?"GET":"POST"))throw relayError("method_not_allowed");
  if(new URL(request.url).search)throw badRequest("Collection copy requests do not accept a query.");
  const signal=AbortSignal.any([request.signal,storage.unavailable,AbortSignal.timeout(30_000)]),scope={workspaceId:route.workspaceId,datasetId:route.datasetId};
  const release=admit({dataset:JSON.stringify([route.workspaceId,route.datasetId]),participant:auth.userId,organizer:true},"export",options.nowMs());
  try{
   signal.throwIfAborted();
   if(route.action==="capture")return Response.json(host.replicaCapture(auth,scope),{headers});
   if(request.headers.get("content-type")?.split(";")[0]!=="application/json")throw badRequest("Collection copy requests require JSON.");
   let body:unknown;try{body=await readBoundedJson(request,1024*1024,signal);}catch{throw badRequest("Invalid Collection copy request.");}
   if(!body||typeof body!=="object"||Array.isArray(body))throw badRequest("Invalid Collection copy request.");
   const row=body as Record<string,unknown>;
   const expected=route.action==="page"?["through","after","limit"]:["record","offset","length"];
   if(Object.keys(row).length!==expected.length||expected.some(key=>!Object.hasOwn(row,key)))throw badRequest("Invalid Collection copy request.");
   signal.throwIfAborted();
   if(route.action==="page")return Response.json(host.replicaPage(auth,{...scope,through:row.through as DatasetCursor,after:row.after as DatasetCursor,limit:row.limit as number}),{headers});
   const bytes=host.replicaBlob(auth,{...scope,record:row.record as JournalExportRecord,offset:row.offset as number,length:row.length as number});
   return new Response(Buffer.from(bytes),{headers:{...headers,"content-type":"application/octet-stream","content-length":String(bytes.byteLength)}});
  }catch(error){
   if(error instanceof DatasetHostError)throw relayError(error.code==="not_authorized"?"not_found":error.code==="conflict"?"conflict":"bad_request");
   if(error instanceof JournalError)throw relayError(error.code==="invalid"?"bad_request":"conflict");
   if(error instanceof Error)throw relayError("conflict");
   throw error;
  }finally{release();}
 };
}
