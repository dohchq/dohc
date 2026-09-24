import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it } from "vitest";
import { isAppBackendRuntimeError } from "./index.ts";
import type { openPersistentAppBackend } from "./persistent.ts";

it("recognizes a refusal crossing separately bundled public entrypoints",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dohc-bundled-refusal-"));
  const main=await import(new URL("../dist/index.mjs",import.meta.url).href) as {isAppBackendRuntimeError:typeof isAppBackendRuntimeError};
  const persistent=await import(new URL("../dist/persistent.mjs",import.meta.url).href) as {openPersistentAppBackend:typeof openPersistentAppBackend};
  const cursor={revision:0,digest:"0".repeat(64)};
  const worker=await persistent.openPersistentAppBackend({directory:root,cursor,tables:["items"],schemaSql:"CREATE TABLE items(id INTEGER PRIMARY KEY);",
    scope:{workspaceId:"workspace",datasetId:"dataset",hostEpoch:"epoch",approvedRevisionHash:"1".repeat(64)}});
  try {
    const error=await worker.prepare({expected:cursor,source:"globalThis.operations={run(ctx){ctx.refuse('full','No spaces remain.')}}",operation:"run",input:{},caller:{kind:"owner"},requestId:"request",nowMs:1}).catch(error=>error);
    expect(main.isAppBackendRuntimeError(error)).toBe(true);
    expect(isAppBackendRuntimeError(error)).toBe(true);
    expect(error.refusal).toEqual({code:"full",message:"No spaces remain."});
    expect(isAppBackendRuntimeError(Object.assign(new Error("forged"),{name:"AppBackendRuntimeError",code:"operation_refused",refusal:{code:"invalid code",message:"bad"}}))).toBe(false);
  }finally{await worker.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:25});}
});
