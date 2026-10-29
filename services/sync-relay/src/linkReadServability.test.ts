import {writeFileSync} from "node:fs";
import {afterEach, expect, it, vi} from "vitest";
import {createLinkLiveBrowserResolver} from "./linkLiveBrowserAuth";
import {validateLinkCapability} from "./linkSecurity";
import {fixture} from "./testing/replicaLink";
import {closeTestStorages, json, jsonBody, LINK_KEY, request, sha256, testHandler} from "./testing";

afterEach(async()=>{vi.restoreAllMocks();await closeTestStorages();});

it.skipIf(process.env.DOHC_LINK_READ_PERF !== "1")("measures the per-read capability check",async()=>{
  const f=await fixture();
  try {
    const input={storage:f.storage,capabilityToken:f.capabilityToken,linkKey:LINK_KEY,nowMs:2000,publicEditRelease:undefined};
    const methods=["findLinkSessionByCapabilityHash","getShare","getShareGrant","workspaceIsOwnedBy","findChannelCreateKind"] as const;
    const spies=methods.map(method=>vi.spyOn(f.storage,method));
    expect(validateLinkCapability(input)).not.toBeNull();
    const calls=Object.fromEntries(methods.map((method,i)=>[method,spies[i]!.mock.calls.length]));
    vi.restoreAllMocks();
    for(let i=0;i<1000;i++)validateLinkCapability(input);
    const samples=[];
    for(let batch=0;batch<9;batch++) {
      const start=performance.now();
      for(let i=0;i<2000;i++)validateLinkCapability(input);
      samples.push((performance.now()-start)*1000/2000);
    }
    if(process.env.DOHC_LINK_PERF_OUTPUT) writeFileSync(process.env.DOHC_LINK_PERF_OUTPUT,JSON.stringify({calls,medianUs:[...samples].sort((a,b)=>a-b)[4],samplesUs:samples},null,2)+"\n");
  } finally {f.dispose();}
});

it.each(["view","comment","edit","read-only","read-write"] as const)("rechecks %s sessions on the next read after release removal",async access=>{
  vi.spyOn(Date,"now").mockReturnValue(2000);
  const f=await fixture(access);
  const closed=testHandler(f.storage,{...f.options,publicEditRelease:undefined});
  const status=access === "edit" || access === "read-write" ? 404 : 200;
  try {
    f.publish();
    const headers={authorization:`LinkCapability ${f.capabilityToken}`};
    expect((await f.send("/sync/link/current")).status).toBe(200);
    expect.soft((await closed(request(null,"/sync/link/current",{headers}))).status).toBe(status);
    expect.soft((await closed(request(null,"/sync/link/log?current=true&since=0",{headers}))).status).toBe(status);
    expect.soft((await closed(request(null,`/sync/link/blobs/${sha256("live")}`,{headers}))).status).toBe(status);
    const saved=testHandler(f.storage,{...f.options,publicEditRelease:undefined,developmentReplicaReads:undefined});
    try {expect.soft((await saved(request(null,"/sync/link/current",{headers}))).status).toBe(status);}
    finally {saved.dispose();}
    if(status === 404) {
      expect.soft((await closed(request(null,"/sync/link/log",{headers}))).status).toBe(404);
      expect.soft((await closed(request(null,"/sync/link-exchange",{...jsonBody({secret:f.secret}),headers:{"content-type":"application/json","x-dohc-relay-exchange-key":"e".repeat(64)}}))).status).toBe(404);
    }
    const input={storage:f.storage,capabilityToken:f.capabilityToken,linkKey:LINK_KEY,nowMs:2000,publicEditRelease:undefined};
    expect(validateLinkCapability(Object.assign({},input,{publicEditRelease:{version:1 as const}}))).not.toBeNull();
    expect.soft(validateLinkCapability(input) === null).toBe(status === 404);
    const liveRequest=new Request("https://relay.test",{headers:{authorization:`Bearer ${f.capabilityToken}`,"x-dohc-link-profile-secret":"p".repeat(43)}});
    expect.soft(await createLinkLiveBrowserResolver({storage:f.storage,linkKey:LINK_KEY,publicEditRelease:undefined}).resolve(liveRequest,"abcdefghijkl","read") === null).toBe(status === 404);
    expect(await createLinkLiveBrowserResolver({storage:f.storage,linkKey:LINK_KEY,publicEditRelease:{version:1}}).resolve(liveRequest,"abcdefghijkl","read")).not.toBeNull();
  } finally {closed.dispose();f.dispose();}
});

it.each([
  ["edit","/sync/link/discussion"],
  ["read-write","/sync/link/chat/channels"],
] as const)("refuses release-off %s sessions through %s",async(access,path)=>{
  const f=await fixture(access);
  const closed=testHandler(f.storage,{...f.options,publicEditRelease:undefined});
  try {
    expect((await f.send(path)).status).toBe(200);
    expect((await closed(request(null,path,{headers:{authorization:`LinkCapability ${f.capabilityToken}`}}))).status).toBe(404);
  } finally {closed.dispose();f.dispose();}
});

it.each(["read-only","read-write"] as const)("projects %s Group files through replica inventory, feed and blobs",async access=>{
  const f=await fixture(access);
  try {
    f.publish();
    const current=await json(await f.send("/sync/link/current"));
    expect(current.files).toEqual([expect.objectContaining({path:"docs/a.md",blobSha256:sha256("live")})]);
    const cursor=await json(await f.send("/sync/link/log?current=true&since=0"));
    f.publish("changed");
    const feed=await json(await f.send(`/sync/link/log?current=true&since=${cursor.nextCursor}`));
    expect(feed.ops).toContainEqual(expect.objectContaining({payload:expect.objectContaining({file:expect.objectContaining({path:"docs/a.md",blobSha256:sha256("changed")})})}));
    expect(await (await f.send(`/sync/link/blobs/${sha256("changed")}`)).text()).toBe("changed");
    expect(JSON.stringify([current,feed])).not.toContain("private/");
    f.publish("outside","private/outside.md");
    expect((await f.send(`/sync/link/blobs/${sha256("outside")}`)).status).toBe(404);
    expect((await json(await f.send("/sync/link/current"))).files).toEqual([]);
    f.publish();
    f.db.prepare("UPDATE sync_relay_log SET payload_json=json_set(payload_json,'$.kind','dm') WHERE op_kind='chat.channel.create'").run();
    for(const path of ["/sync/link/current","/sync/link/log?current=true&since=0",`/sync/link/blobs/${sha256("live")}`])
      expect((await f.send(path)).status).toBe(404);
  } finally {f.dispose();}
});
