import { expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { createEngineFileResolver, resolveEngineFileTargets, workspaceFileRef } from "./resolveEngineFiles";

it("pins batches to one version and isolates an oversized legacy hint", async () => {
  const engine = new VersionedLoopbackEngine();
  engine.seedTextFile({ workspace: "w", path: "a.md", text: "a", objectId: "a" });
  const adapter = new VersionedLiveAdapter({ close() {}, sendRequest: request => engine.sendRequest(request) }, "w", { workspaceId: "w" });
  const draft = await adapter.createNamedVersion({ workspaceId: "w", name: "Draft", fromVersionId: "main" });
  const resolve = adapter.resolveFiles.bind(adapter);
  const calls = vi.spyOn(adapter, "resolveFiles").mockImplementation(async input => {
    const result = await resolve(input);
    if (input.versionId === undefined) await adapter.setActiveVersion({ workspaceId: "w", versionId: draft.id });
    return result;
  });
  engine.requests.length = 0;
  const targets = [...Array.from({ length: 129 }, () => ({ objectId: "a" })), { path: "x".repeat(49152) }, { path: "../invalid" }, { path: "a.md" }];
  const results = await resolveEngineFileTargets(adapter, "w", targets);
  expect(results).toHaveLength(targets.length);
  expect(results.slice(129, 131)).toEqual([{ status: "invalid" }, { status: "invalid" }]);
  expect(results.at(-1)).toEqual({ status: "found", objectId: "a", path: "a.md" });
  expect(calls.mock.calls[0]![0].versionId).toBeUndefined();
  expect(calls.mock.calls.slice(1).every(([input]) => input.versionId === "main")).toBe(true);
});

it("uses the production chat and graph wrapper without listing the workspace", async () => {
  const engine = new VersionedLoopbackEngine();
  engine.seedTextFile({ workspace: "w", path: "notes/a.md", text: "a", objectId: "a" });
  engine.seedBinaryFile({ workspace: "w", path: "photo.png", bytes: [1], objectId: "photo" });
  const adapter = new VersionedLiveAdapter({ close() {}, sendRequest: request => engine.sendRequest(request) }, "w", { workspaceId: "w" });
  const adapterCalls = vi.fn();
  const withAdapter = async <T>(workspace: { workspaceId: string }, work: (adapter: VersionedLiveAdapter) => Promise<T>) => {
    adapterCalls(workspace, work);
    return work(adapter);
  };
  const resolveEngineFiles = createEngineFileResolver(withAdapter);
  const workspace = { workspaceId: "w" };
  expect(await resolveEngineFiles(workspace, [{ path: "./notes//a.md" }, workspaceFileRef("w", "photo"), workspaceFileRef("w", "gone")])).toEqual([
    { status: "found", objectId: "a", path: "notes/a.md" },
    { status: "found", objectId: "photo", path: "photo.png" },
    { status: "absent" },
  ]);
  expect(adapterCalls).toHaveBeenCalledWith(workspace, expect.any(Function));
  expect(engine.requests.filter(request => request.method === "versionedText.list")).toHaveLength(0);
  expect(engine.requests.map(request => request.method)).toEqual(["files.resolve"]);
});

it("reports an unavailable engine through the production wrapper", async () => {
  const resolveEngineFiles = createEngineFileResolver(async () => null);
  await expect(resolveEngineFiles({ workspaceId: "w" }, [{ path: "a.md" }])).rejects.toThrow("Workspace engine is unavailable.");
});

it("counts UTF-8 bytes, JSON escapes, commas, and the pinned version across request batches", async () => {
  const engine = new VersionedLoopbackEngine();
  const adapter = new VersionedLiveAdapter({ close() {}, sendRequest: request => engine.sendRequest(request) }, "w", { workspaceId: "w" });
  engine.seedTextFile({ workspace: "w", path: "a.md", text: "a", objectId: "a" });
  const targets = Array.from({ length: 8 }, (_, index) => ({ path: ('文"').repeat(3000) + "/" + index + ".md" }));
  const results = await resolveEngineFileTargets(adapter, "w", [...targets, { path: "a.md" }]);
  expect(results).toHaveLength(9);
  expect(results.at(-1)).toEqual({ status: "found", objectId: "a", path: "a.md" });
  const requests = engine.requests.filter(request => request.method === "files.resolve");
  expect(requests.length).toBeGreaterThan(1);
  for (const request of requests) {
    expect(Buffer.byteLength(JSON.stringify(request.params))).toBeLessThanOrEqual(48 * 1024);
  }
  for (const request of requests.slice(1)) expect(request.params).toMatchObject({ versionId: "main" });
});

it("keeps foreign workspace references absent without querying their ids", async () => {
  const resolveFiles = vi.fn(async () => ({ versionId: "main", results: [] }));
  const resolve = createEngineFileResolver(async (_workspace, work) => work({ resolveFiles } as unknown as VersionedLiveAdapter));
  expect(await resolve({ workspaceId: "local" }, [workspaceFileRef("source", "object")])).toEqual([{ status: "absent" }]);
  expect(resolveFiles).not.toHaveBeenCalled();
});

it("rejects a binding changed during a file resolution await", async () => {
  let current = true;
  const assertCurrent = () => { if (!current) throw new Error("Binding changed"); };
  const resolveFiles = vi.fn(async () => {
    current = false;
    return { versionId: "main", results: [{ status: "found", objectId: "a", path: "a.md" }] };
  });
  const resolve = createEngineFileResolver(async (_workspace, work) => work({ resolveFiles } as unknown as VersionedLiveAdapter, assertCurrent));
  await expect(resolve({ workspaceId: "local" }, [workspaceFileRef("local", "a")])).rejects.toThrow("Binding changed");
});

it("resolves a token through a second admitted share and keeps outside/deleted/missing objects equally absent",async()=>{
  const {workspaceFileRefs}=await import("./workspaceFileReferenceScopes");
  const token="share-object:v1:"+"a".repeat(64), source="share-source:v1:"+"b".repeat(64);
  const pin={receivedSource:source,grantId:"grant",generation:2};
  const workspace={workspaceId:"local",shareView:{receivedIdentity:pin,grantedSelector:{paths:["docs"],versionId:null,access:"view"}}};
  const refs=workspaceFileRefs(workspace,token);
  const engine=new VersionedLoopbackEngine();
  engine.seedTextFile({workspace:"second-share",path:"docs/renamed.md",text:"a",objectId:token});
  const adapter=new VersionedLiveAdapter({close(){},sendRequest:request=>engine.sendRequest(request)},"second-share",{workspaceId:"second-share"});
  const resolve=createEngineFileResolver(async (_workspace,work)=>work(adapter),async()=>[{workspace:{workspaceId:"second-share"},pin,selector:{paths:["docs"],versionId:null,access:"view"},assertCurrent(){}}]);
  expect(await resolve(workspace,refs)).toEqual([{status:"found",objectId:token,path:"docs/renamed.md"}]);
  const gone=workspaceFileRefs(workspace,"share-object:v1:"+"c".repeat(64));
  expect(await resolve(workspace,gone)).toEqual([{status:"absent"}]);
  const outside=createEngineFileResolver(async (_workspace,work)=>work(adapter),async()=>[{workspace:{workspaceId:"second-share"},pin,selector:{paths:["other"],versionId:null,access:"view"},assertCurrent(){}}]);
  expect(await outside(workspace,refs)).toEqual([{status:"absent"}]);
});
it.each(["selector","version","generation","session","attachment"])("fences %s changes during received resolution",async()=>{
  const {workspaceFileRefs}=await import("./workspaceFileReferenceScopes");
  const pin={receivedSource:"share-source:v1:"+"b".repeat(64),grantId:"grant",generation:2};
  const workspace={workspaceId:"local",shareView:{receivedIdentity:pin,grantedSelector:{paths:["docs"],versionId:null,access:"view"}}};
  let current=true; const assertCurrent=()=>{if(!current)throw Error("Retired projection");};
  const adapter={resolveFiles:async()=>{current=false;return {versionId:"main",results:[{status:"found",path:"docs/a.md",objectId:"share-object:v1:"+"a".repeat(64)}]};}} as unknown as VersionedLiveAdapter;
  const resolve=createEngineFileResolver(async (_workspace,work)=>work(adapter),async()=>[{workspace:{workspaceId:"second"},pin,selector:{paths:["docs"],versionId:null,access:"view"},assertCurrent}]);
  await expect(resolve(workspace,workspaceFileRefs(workspace,"share-object:v1:"+"a".repeat(64)))).rejects.toThrow("Retired projection");
});
it("old handle refs answer absent after rotation without querying old tokens", async () => {
  const { workspaceFileRefs } = await import("./workspaceFileReferenceScopes");
  const oldPin = { receivedSource: "share-source:v1:" + "a".repeat(64), grantId: "grant", generation: 2 };
  const nextPin = { ...oldPin, receivedSource: "share-source:v1:" + "b".repeat(64) };
  const selector = { paths: ["docs"], versionId: null, access: "view" as const };
  const workspace = { workspaceId: "local", shareView: { receivedIdentity: oldPin, grantedSelector: selector } };
  const refs = workspaceFileRefs(workspace, "share-object:v1:" + "c".repeat(64));
  const resolveFiles = vi.fn(async () => ({ versionId: "main", results: [] }));
  const resolve = createEngineFileResolver(async (_workspace, work) => work({ resolveFiles } as unknown as VersionedLiveAdapter), async () => [{ workspace, pin: nextPin, selector, assertCurrent() {} }]);
  expect(await resolve(workspace, refs)).toEqual([{ status: "absent" }]);
  expect(resolveFiles).not.toHaveBeenCalled();
});
it("rechecks an earlier projection after another projection's resolution await", async () => {
  const { workspaceFileRefs } = await import("./workspaceFileReferenceScopes");
  const pin = { receivedSource: "share-source:v1:" + "a".repeat(64), grantId: "grant", generation: 2 };
  const selector = { paths: ["docs"], versionId: null, access: "view" as const };
  const workspace = { workspaceId: "local", shareView: { receivedIdentity: pin, grantedSelector: selector } };
  let firstCurrent = true;
  const adapter = { resolveFiles: async () => { firstCurrent = false; return { versionId: "main", results: [{ status: "absent" }] }; } } as unknown as VersionedLiveAdapter;
  const resolve = createEngineFileResolver(async (selected, work) => work(selected.workspaceId === "second" ? adapter : { resolveFiles: async () => ({ versionId: "main", results: [{ status: "absent" }] }) } as unknown as VersionedLiveAdapter), async () => [
    { workspace: { workspaceId: "first" }, pin, selector, assertCurrent() { if (!firstCurrent) throw Error("First projection retired"); } },
    { workspace: { workspaceId: "second" }, pin, selector, assertCurrent() {} },
  ]);
  await expect(resolve(workspace, workspaceFileRefs(workspace, "share-object:v1:" + "c".repeat(64)))).rejects.toThrow("First projection retired");
});
it("damaged pins, lowered generations, rotation, and pre-token stores never create a received ref",async()=>{
  const {workspaceFileRefs,refreshReceivedReferencePin}=await import("./workspaceFileReferenceScopes");
  const pin={receivedSource:"share-source:v1:"+"b".repeat(64),grantId:"g",generation:2};
  expect(() => refreshReceivedReferencePin(pin,{receivedIdentity:{...pin,generation:1}})).toThrow("older access details");
  expect(refreshReceivedReferencePin(pin,{receivedIdentity:{...pin,receivedSource:"share-source:v1:"+"c".repeat(64)}})?.receivedSource).not.toBe(pin.receivedSource);
  const view={grantedSelector:{paths:["docs"],versionId:null,access:"view"}};
  for(const receivedIdentity of [undefined,{...pin,receivedSource:"real-workspace"}, {...pin,generation:-1}]) expect(workspaceFileRefs({workspaceId:"local",shareView:{...view,receivedIdentity}},"share-object:v1:"+"a".repeat(64))).toEqual([]);
  expect(workspaceFileRefs({workspaceId:"local",shareView:{...view,receivedIdentity:pin}},"object-share-old")).toEqual([]);
  for (const shareView of [null, false, "damaged"]) {
    expect(workspaceFileRefs({ workspaceId: "local", shareView }, "object-share-old")).toEqual([]);
  }
});
