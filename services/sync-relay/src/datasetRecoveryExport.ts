import type { RelayDatasetHost } from "./datasetHost";
import type { AppBackendAuth } from "./appBackendAuthority";
import type { SyncRelayStorage } from "./storage";
import { notFound } from "./errors";
import { encodeRecoveryManifest, recoveryManifestSha256 } from "@dohc/app-backend-runtime/recovery";
import { createAppBackendAdmission, type AppBackendAdmissionLimits } from "./appBackendAdmission";

const headers={"cache-control":"private, no-store","cross-origin-resource-policy":"same-origin","x-content-type-options":"nosniff","content-type":"application/octet-stream"};
export function createDatasetRecoveryExport(host:RelayDatasetHost,storage:SyncRelayStorage,options:{limits?:Partial<AppBackendAdmissionLimits>;nowMs():number}){
 const admit=createAppBackendAdmission(options.limits);
 return async(request:Request,route:{workspaceId:string;datasetId:string;action:"export"},auth:Extract<AppBackendAuth,{kind:"named"}>)=>{
  if(request.method!=="GET"||auth.grantId||!storage.workspaceIsOwnedBy(route.workspaceId,auth.userId))throw notFound();
  const signal=AbortSignal.any([request.signal,storage.unavailable,AbortSignal.timeout(120_000)]);
  const release=admit({dataset:JSON.stringify([route.workspaceId,route.datasetId]),participant:auth.userId,organizer:true},"export",options.nowMs());
  let prepared:Awaited<ReturnType<RelayDatasetHost["exportRecovery"]>>;
  try{prepared=await host.exportRecovery(auth,{workspaceId:route.workspaceId,datasetId:route.datasetId,signal});}catch(error){release();throw error;}
  const iterator=prepared.stream()[Symbol.asyncIterator]();let closed=false,controller:ReadableStreamDefaultController<Uint8Array>|undefined;
  const dispose=async()=>{if(closed)return;closed=true;signal.removeEventListener("abort",aborted);try{await iterator.return?.(undefined);}finally{try{await prepared.dispose();}finally{release();}}};
  const aborted=()=>{controller?.error(signal.reason);void dispose().catch(()=>{});};
  const limits={maxTotalBytes:Math.max(1,prepared.manifest.entries.reduce((sum,entry)=>sum+entry.byteLength,0))};
  const manifestBytes=encodeRecoveryManifest(prepared.manifest,limits).byteLength;
  const maxBytes=8+5+manifestBytes+37+prepared.manifest.entries.reduce((sum,entry)=>sum+entry.byteLength+5*Math.ceil(entry.byteLength/(1024*1024))+5,0);
  const manifestSha256=recoveryManifestSha256(prepared.manifest,limits);
  const stream=new ReadableStream<Uint8Array>({start(value){controller=value;signal.addEventListener("abort",aborted,{once:true});if(signal.aborted)aborted();},async pull(value){try{signal.throwIfAborted();const item=await iterator.next();if(closed)return;if(item.done){await dispose();value.close();return;}value.enqueue(item.value);}catch(error){await dispose();value.error(error);}},async cancel(){await dispose();}});
  return new Response(stream,{headers:{...headers,"x-dohc-dataset-manifest-sha256":manifestSha256,"x-dohc-dataset-export-bytes":String(maxBytes)}});
 };
}
