import { afterEach, expect, it, vi } from "vitest";
import { openRemoteDatasetRecoveryExport } from "./remoteDatasetRecoveryExport";

const credentials={serverUrl:"https://account",relayUrl:"https://relay",token:"token",userId:"owner",email:"owner@example.test"};
const sha="a".repeat(64), bytes=Uint8Array.from([1,2,3,4]);
const options=()=>{const controller=new AbortController(),relayResponse=vi.fn(async()=>new Response(new ReadableStream({start(c){c.enqueue(bytes);c.close();}}),{headers:{"content-type":"application/octet-stream","x-dohc-dataset-export-bytes":String(bytes.byteLength),"x-dohc-dataset-manifest-sha256":sha}}));return {controller,relayResponse,options:{workspaceId:"w",datasetId:"00000000-0000-4000-8000-000000000001",origin:"https://relay",credentials,credentialGeneration:1,currentCredentialGeneration:()=>1,signal:controller.signal,assertCurrent(){},maxBytes:1024,relayResponse}};};
afterEach(()=>vi.restoreAllMocks());
it("pins credentials and bounds a valid stream",async()=>{const f=options(),opened=await openRemoteDatasetRecoveryExport(f.options),parts=[];for await(const chunk of opened.stream)parts.push(chunk);expect(Buffer.concat(parts)).toEqual(Buffer.from(bytes));expect(f.relayResponse).toHaveBeenCalledWith(credentials,"/sync/w/datasets/00000000-0000-4000-8000-000000000001/export",expect.objectContaining({credentials:"omit",redirect:"error",cache:"no-store"}));await opened.dispose();});
it.each([
 ["wrong content type",new Response(bytes,{headers:{"content-type":"text/plain","x-dohc-dataset-export-bytes":"4","x-dohc-dataset-manifest-sha256":sha}}),/invalid recovery/],
 ["declared size too large",new Response(bytes,{headers:{"content-type":"application/octet-stream","x-dohc-dataset-export-bytes":"2048","x-dohc-dataset-manifest-sha256":sha}}),/invalid size/],
 ["truncated",new Response(bytes,{headers:{"content-type":"application/octet-stream","x-dohc-dataset-export-bytes":"5","x-dohc-dataset-manifest-sha256":sha}}),/interrupted/],
] as const)("rejects %s",async(_name,response,expected)=>{const f=options();f.relayResponse.mockResolvedValue(response);await expect((async()=>{const opened=await openRemoteDatasetRecoveryExport(f.options);for await(const _chunk of opened.stream){}})()).rejects.toThrow(expected);});
it("cancels when the session changes",async()=>{const f=options();let generation=1;f.options.currentCredentialGeneration=()=>generation;const opened=await openRemoteDatasetRecoveryExport(f.options);generation=2;await expect((async()=>{for await(const _chunk of opened.stream){}})()).rejects.toThrow(/session changed/);await opened.dispose();});
it("rejects a different server before making a request",async()=>{const f=options();await expect(openRemoteDatasetRecoveryExport({...f.options,origin:"https://other"})).rejects.toThrow(/Reconnect/);expect(f.relayResponse).not.toHaveBeenCalled();});
it("cancels rejected status bodies and downloads never consumed",async()=>{
 const rejected=options(),cancel=vi.fn();rejected.relayResponse.mockResolvedValue(new Response(new ReadableStream({cancel}),{status:403}));
 await expect(openRemoteDatasetRecoveryExport(rejected.options)).rejects.toThrow("403");expect(cancel).toHaveBeenCalledOnce();
 const unused=options(),cancelUnused=vi.fn();unused.relayResponse.mockResolvedValue(new Response(new ReadableStream({cancel:cancelUnused}),{headers:{"content-type":"application/octet-stream","x-dohc-dataset-export-bytes":"4","x-dohc-dataset-manifest-sha256":sha}}));
 const opened=await openRemoteDatasetRecoveryExport(unused.options);await opened.dispose();await opened.dispose();expect(cancelUnused).toHaveBeenCalledOnce();
});
it("aborts a blocked stream read and releases its reader",async()=>{
 const f=options(),cancel=vi.fn(),body=new ReadableStream<Uint8Array>({cancel});
 f.relayResponse.mockResolvedValue(new Response(body,{headers:{"content-type":"application/octet-stream","x-dohc-dataset-export-bytes":"4","x-dohc-dataset-manifest-sha256":sha}}));
 const opened=await openRemoteDatasetRecoveryExport(f.options),iterator=opened.stream[Symbol.asyncIterator](),next=iterator.next();f.controller.abort();
 await expect(next).rejects.toThrow();await opened.dispose();expect(cancel).toHaveBeenCalledOnce();expect(body.locked).toBe(false);
});
it("rejects oversized transport chunks and excess total bytes",async()=>{
 for(const [size,declared]of [[1024*1024+6,1024*1024+6],[5,4]]){
  const f=options();f.relayResponse.mockResolvedValue(new Response(new Uint8Array(size!),{headers:{"content-type":"application/octet-stream","x-dohc-dataset-export-bytes":String(declared),"x-dohc-dataset-manifest-sha256":sha}}));
  const opened=await openRemoteDatasetRecoveryExport({...f.options,maxBytes:2*1024*1024});await expect((async()=>{for await(const _chunk of opened.stream){}})()).rejects.toThrow("size limit");
 }
});
