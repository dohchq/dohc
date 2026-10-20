import {createShareReadQueries} from "./shareReadQueries";
import {afterEach, expect, it, vi} from "vitest";
import {writeFileSync} from "node:fs";
import {closeTestStorages,json,LINK_KEY,sha256} from "./testing";

import {fixture} from "./testing/replicaLink";

afterEach(async()=>{vi.useRealTimers();await closeTestStorages();});



it.each(["view","comment","edit"] as const)("R4: %s current inventory and bytes use the live replica, not the saved log",async access=>{
  const f=await fixture(access);
  try {
    f.publish();
    const current=await json(await f.send("/sync/link/current"));
    expect(current.files).toEqual([expect.objectContaining({path:"docs/a.md",blobSha256:sha256("live"),contentKind:"text"})]);
    expect(await (await f.send(`/sync/link/blobs/${sha256("live")}`)).text()).toBe("live");
    expect(f.watches.watched("w")).toBe(true);
    expect(JSON.stringify(current)).not.toMatch(/watched|capacity|owner@|journalCursor/);
  }finally{f.dispose();}
});

it("R4: no replica view gives the same opaque refusal as a missing blob",async()=>{
  const f=await fixture();
  try {
    const first=await f.send("/sync/link/current"),missing=await f.send(`/sync/link/blobs/${sha256("missing")}`);
    expect(first.status).toBe(404);expect(await first.text()).toBe(await missing.text());
    expect(f.watches.watched("w")).toBe(true);
  }finally{f.dispose();}
});

it.each(["view","edit"] as const)("R4: %s collection inventory preserves automation metadata",async access=>{
  const f=await fixture(access);
  try {
    f.publish("automations: []","docs/automations.yaml");
    const current=await json(await f.send("/sync/link/current?collectionPath=docs"));
    expect(current.files).toEqual([expect.objectContaining({path:"docs/automations.yaml",automationSwitchable:false})]);
  }finally{f.dispose();}
});

it("R4: current notifications wake without a saved operation and reauthorize a parked revoke",async()=>{
  vi.useFakeTimers({toFake:["Date","setTimeout","clearTimeout"]});
  const f=await fixture();
  try {
    f.publish("before");const current=await json(await f.send("/sync/link/current"));
    const pending=f.send(`/sync/link/log?current=true&since=${current.nextCursor}&hold=30000`);
    await vi.waitFor(()=>expect(f.activity.stats().waiters).toBe(1));
    f.publish("after");await vi.advanceTimersByTimeAsync(30000);
    const changed=await json(await pending);
    expect(changed.ops).toContainEqual(expect.objectContaining({opKind:"file.current",payload:expect.objectContaining({file:expect.objectContaining({blobSha256:sha256("after")})})}));
    const revoked=f.send(`/sync/link/log?current=true&since=${changed.nextCursor}&hold=30000`);
    await vi.waitFor(()=>expect(f.activity.stats().waiters).toBe(1));
    f.storage.revokeShareGrant({shareId:"s",grantId:"link",revokedAtMs:3000});f.activity.wakeLog("w");
    expect((await revoked).status).toBe(404);
  }finally{f.dispose();}
});

it("R4: a foreign cursor resets without disclosing a past state",async()=>{
  const f=await fixture();
  try {f.publish("old");f.publish("new");const page=await json(await f.send("/sync/link/log?current=true&since=0"));
    expect(page.ops).toEqual([expect.objectContaining({opKind:"files.reset"})]);
    expect(JSON.stringify(page)).not.toContain(sha256("old"));
  }finally{f.dispose();}
});

it("R4: current inventory stays complete and exposes only the numeric feed cursor",async()=>{
  const f=await fixture();
  try {
    f.publish();f.latest.files.push({...f.latest.files[0]!,objectId:"second",path:"docs/b.md"});
    f.storage.storeReplicaCurrentView(f.lease,f.latest);
    const first=await json(await f.send("/sync/link/current?limit=1"));
    expect(first.files).toHaveLength(2);expect(first).not.toHaveProperty("inventoryCursor");expect(first.nextCursor).toBeTypeOf("number");
    const second=await json(await f.send("/sync/link/current?limit=1&cursor=obsolete"));
    expect(second.files).toEqual(first.files);expect(second).not.toHaveProperty("inventoryCursor");
  }finally{f.dispose();}
});

it("R4: development injection absent leaves current reads and watches unchanged",async()=>{
  const f=await fixture("view",false);
  try {f.publish();expect((await json(await f.send("/sync/link/current"))).files).toEqual([]);expect(f.watches.watched("w")).toBe(false);}
  finally{f.dispose();}
});


it.each(["downgrade","rotation"])("R4: a parked current feed rechecks a %s",async kind=>{
  vi.useFakeTimers({toFake:["Date","setTimeout","clearTimeout"]});
  const f=await fixture("edit");
  try {
    f.publish();const current=await json(await f.send("/sync/link/log?current=true&since=0"));
    const pending=f.send(`/sync/link/log?current=true&since=${current.nextCursor}&hold=30000`);
    await vi.waitFor(()=>expect(f.activity.stats().waiters).toBe(1));
    if(kind==="downgrade") {
      expect(f.storage.retuneShareGrant({shareId:"s",grantId:"link",access:"view",changedAtMs:3000,expectedDependentGrantIds:[],guard(){}}).ok).toBe(true);
      f.activity.wakeLog("w");f.publish("downgraded");
      await vi.advanceTimersByTimeAsync(30000);
      expect((await json(await pending)).ops).toContainEqual(expect.objectContaining({opKind:"file.current"}));
      expect((await f.send("/sync/link/log")).status).toBe(404);
    }else {
      f.db.prepare("UPDATE sync_relay_share_grants SET generation=2 WHERE grant_id='link'").run();f.activity.wakeLog("w");
      expect((await pending).status).toBe(404);
    }
  }finally{f.dispose();}
});

it("R4: a move out emits removal, a move back emits only current bytes",async()=>{
  const f=await fixture();
  try {
    f.publish("public");const initial=await json(await f.send("/sync/link/current"));
    f.publish("private","private/a.md");
    const removed=await json(await f.send(`/sync/link/log?current=true&since=${initial.nextCursor}`));
    expect(removed.ops).toEqual([expect.objectContaining({opKind:"file.current",payload:expect.objectContaining({file:null})})]);
    expect(JSON.stringify(removed)).not.toContain("private");
    expect((await f.send(`/sync/link/blobs/${sha256("public")}`)).status).toBe(404);
    f.publish("returned");
    const returned=await json(await f.send(`/sync/link/log?current=true&since=${removed.nextCursor}`));
    expect(returned.ops).toEqual([expect.objectContaining({payload:expect.objectContaining({file:expect.objectContaining({blobSha256:sha256("returned")})})})]);
  }finally{f.dispose();}
});

it("R4: evicted change windows reset and never return intermediate text",async()=>{
  const f=await fixture();
  try {
    f.publish();const initial=await json(await f.send("/sync/link/current"));
    for(let i=0;i<1030;i++)f.publish(String(i));
    const reset=await json(await f.send(`/sync/link/log?current=true&since=${initial.nextCursor}`));
    expect(reset.ops).toEqual([expect.objectContaining({opKind:"files.reset"})]);
    expect(reset.nextCursor).toBeGreaterThan(Number(initial.nextCursor));
  }finally{f.dispose();}
});

it("R4: a current blob stream stops when its object leaves the selector",async()=>{
  const f=await fixture();
  try {
    const text="x".repeat(100_000);f.publish(text);
    const response=await f.send(`/sync/link/blobs/${sha256(text)}`),reader=response.body!.getReader();
    expect((await reader.read()).value!.byteLength).toBe(65536);
    f.publish(text,"private/a.md");
    await expect(reader.read()).rejects.toBeDefined();
  }finally{f.dispose();}
});


it("watch refusal preserves the authorized response",async()=>{
  const f=await fixture();
  try {
    f.publish();const admitted=await f.send("/sync/link/current"),admittedBody=await admitted.text();
    f.watches.dispose();vi.spyOn(f.watches,"holdReader").mockImplementation(()=>{});
    const refused=await f.send("/sync/link/current");
    expect(refused.status).toBe(admitted.status);expect(await refused.text()).toBe(admittedBody);
    expect([...refused.headers]).toEqual([...admitted.headers]);expect(f.watches.watched("w")).toBe(false);
  }finally{vi.restoreAllMocks();f.dispose();}
});

it.skipIf(process.env.DOHC_R4_READ_PERF!=="1")("measures the authorized read service at 50 KB and 1 MB",async()=>{
  const results:unknown[]=[];
  for(const size of [51_200,1_048_576]) {
    const f=await fixture(),text="x".repeat(size),input={grantId:"link",generation:1,principal:{kind:"link" as const}};
    const service=f.storage.createReplicaLinkReadService(f.source,f.watches,f.activity,createShareReadQueries(f.storage,500,LINK_KEY).newestFilteredOpFreshness,LINK_KEY);
    try {
      f.publish(text);const cursor=service.inventory(input,()=>{}).nextCursor,digest=sha256(text);
      for(const includeBytes of [false,true]) {
        const samples:number[]=[];
        for(let i=0;i<110;i++) {
          const start=performance.now();
          if(includeBytes)expect(service.blob(input,()=>{},digest)!.bytes!.byteLength).toBe(size);
          else expect(service.feed(input,()=>{},cursor,100).ops).toEqual([]);
          if(i>=10)samples.push(performance.now()-start);
        }
        samples.sort((a,b)=>a-b);
        results.push({size,operation:includeBytes?"blob":"idle-feed",samples:samples.length,p50:samples[49],p95:samples[94],p99:samples[98]});
      }
    }finally{service.close();f.dispose();}
  }
  if(process.env.DOHC_R4_READ_PERF_OUT)writeFileSync(process.env.DOHC_R4_READ_PERF_OUT,JSON.stringify(results,null,2)+"\n");
});
