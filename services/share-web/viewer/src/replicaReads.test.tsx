vi.mock("./markdown",()=>({renderMarkdown:()=>""}));
import {afterEach,expect,it,vi} from "vitest";
import {fixture,blockReplica,transientReplicaStates} from "../../../sync-relay/src/testing/replicaLink";
import {closeTestStorages,json,moment,putBlob,sha256} from "../../../sync-relay/src/testing";
afterEach(async()=>{vi.useRealTimers();vi.unstubAllGlobals();await closeTestStorages();});

it.each(transientReplicaStates)("R4 review: viewer keeps retrying %s within its retry budget and recovers",async kind=>{
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});vi.stubGlobal("window",globalThis);
  const {loadCurrentState,loadLog}=await import("./App"),f=await fixture(kind==="epoch floor"?"edit":"view");
  let attempts=0;
  const fetcher=vi.spyOn(globalThis,"fetch").mockImplementation(async input=>{attempts++;const url=new URL(String(input),"https://viewer.dohc.test");return f.send(url.pathname.replace("/api/view/","/sync/link/")+url.search);});
  try {f.publish();const current=await loadCurrentState("abcdefghijkl");const recover=blockReplica(f,kind);
    for(const follow of [false,true]) {
      const controller=new AbortController();let refused=false;
      const pending=(follow&&kind!=="epoch floor" ? loadLog("abcdefghijkl",current.nextCursor,current.fileAccumulator,1,controller.signal,current.epochLogFloor,undefined,true):loadCurrentState("abcdefghijkl",controller.signal));
      const checked=pending.catch(error=>{refused=String(error).includes("refused");return null;});
      const before=attempts;await vi.advanceTimersByTimeAsync(100_000);expect(attempts).toBeGreaterThan(before+5);expect(refused).toBe(false);
      controller.abort();await checked;expect(refused).toBe(false);
    }
    recover();expect((await loadCurrentState("abcdefghijkl")).fileAccumulator.size).toBe(1);
  }finally{fetcher.mockRestore();f.dispose();}
});
it.each(["view","comment","edit"] as const)("R4: %s responses preserve the viewer contract and saved settlement facts",async access=>{
  const {loadCurrentState,loadLog}=await import("./App");
  const f=await fixture(access);
  const fetcher=vi.spyOn(globalThis,"fetch").mockImplementation(async input=>{
    const url=new URL(String(input),"https://viewer.dohc.test");
    return f.send(url.pathname.replace("/api/view/","/sync/link/")+url.search);
  });
  try {
    await putBlob(f.h,"owner@dohc.test","w","saved");
    const {payload,...op}=moment("docs/a.md","saved",{originSeq:0,recordedAtMs:1234,objectId:"object"});
    f.storage.appendLogBatch({workspaceId:"w",originId:"origin-a",ops:[{...op,payloadJson:JSON.stringify(payload)}]});
    f.publish("live"); // The settlement facts are independent of this view.
    if(access==="edit")f.latest.logCursor=Number((await json(await f.savedSend("/sync/link/current"))).nextCursor);
    const baseline=await f.savedSend("/sync/link/current"),candidate=await f.send("/sync/link/current");
    expect([...candidate.headers]).toEqual([...baseline.headers]);
    const saved=await json(baseline),current=await json(candidate);
    expect(Object.keys(current).sort()).toEqual(Object.keys(saved).sort());
    expect(current).toMatchObject({lastSettledKnown:true,lastSettledAtMs:1234});
    const feedCursor=Number(access==="edit" ? (await json(await f.send("/sync/link/log?current=true&since=0"))).nextCursor : current.nextCursor);
    const loaded=await loadCurrentState("abcdefghijkl");
    expect(loaded.meta).toMatchObject({access,lastSettledKnown:true,lastSettledAtMs:1234});
    expect(loaded.fileAccumulator.get("docs/a.md")?.blobSha256).toBe(sha256("live"));
    f.publish("journal-only");
    const next=await loadLog("abcdefghijkl",feedCursor,loaded.fileAccumulator,1,undefined,Number(current.epochLogFloor),undefined,true);
    expect(next.fileAccumulator.get("docs/a.md")?.blobSha256).toBe(sha256("journal-only"));
    expect(await json(await f.send("/sync/link/current"))).toMatchObject({lastSettledKnown:true,lastSettledAtMs:1234});
    const savedFeed=await json(await f.savedSend("/sync/link/log?current=true&since=0"));
    const liveFeed=await json(await f.send(`/sync/link/log?current=true&since=${feedCursor}`));
    expect(Object.keys(liveFeed).sort()).toEqual(Object.keys(savedFeed).sort());
    const oldBlob=await f.savedSend(`/sync/link/blobs/${sha256("saved")}`);
    const liveBlob=await f.send(`/sync/link/blobs/${sha256("journal-only")}`);
    expect(liveBlob.status).toBe(oldBlob.status);
    expect([...liveBlob.headers].filter(([name])=>name!=="content-length")).toEqual([...oldBlob.headers].filter(([name])=>name!=="content-length"));
    expect(liveBlob.headers.get("content-length")).toBe(String(Buffer.byteLength("journal-only")));
    expect(liveBlob.headers.get("etag")).toBeNull();
    const conditional=await f.send(`/sync/link/blobs/${sha256("journal-only")}`,undefined,{"if-none-match":"*"});
    const savedConditional=await f.savedSend(`/sync/link/blobs/${sha256("saved")}`,{"if-none-match":"*"});
    expect(conditional.status).toBe(savedConditional.status);
    expect(await conditional.text()).toBe("journal-only");
    expect(await liveBlob.text()).toBe("journal-only");
  } finally {fetcher.mockRestore();f.dispose();}
});

it("R4: edit inventory uses the applied saved-log cursor for the viewer's raw-log continuation",async()=>{
  const {loadCurrentState,loadLog}=await import("./App");
  const f=await fixture("edit");
  const fetcher=vi.spyOn(globalThis,"fetch").mockImplementation(async input=>{
    const url=new URL(String(input),"https://viewer.dohc.test");
    return f.send(url.pathname.replace("/api/view/","/sync/link/")+url.search);
  });
  try {
    f.publish("live");
    const current=await json(await f.send("/sync/link/current"));
    expect(current.nextCursor).toBe(f.latest.logCursor);
    const loaded=await loadCurrentState("abcdefghijkl");
    await putBlob(f.h,"owner@dohc.test","w","live");
    await putBlob(f.h,"owner@dohc.test","w","later saved");
    const {payload,...op}=moment("docs/a.md","later saved",{originSeq:0,recordedAtMs:2345,objectId:"object",beforePath:"docs/a.md",beforeContent:"live"});
    f.storage.appendLogBatch({workspaceId:"w",originId:"origin-a",ops:[{...op,payloadJson:JSON.stringify(payload)}]});
    const next=await loadLog("abcdefghijkl",loaded.nextCursor,loaded.fileAccumulator,1,undefined,loaded.epochLogFloor);
    expect(next.fileAccumulator.get("docs/a.md")?.blobSha256).toBe(sha256("later saved"));
  } finally {fetcher.mockRestore();f.dispose();}
});
