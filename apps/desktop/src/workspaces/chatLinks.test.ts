import { describe, expect, it, vi } from "vitest";
import { createChatLinksReader } from "./chatLinks";
import type { ChatScope } from "../ipc/chatScope";
import type { RegistryEntry } from "./registryStore";
import { deferred } from "../testing/deferred";

const raw = () => ({
 versionId:"main",subject:{channelWireId:"wire"},entries:[{
 file:{objectId:"object",path:"notes/a.md",folder:"notes"},attachmentId:"attachment",
 threadId:"thread",messageId:"message",mentionedAtMs:1,
 author:{authorKind:"human",authorDisplayName:"Ada",authorUserId:"secret-user",authorActorKey:"secret-key"},
 }],unchecked:[],complete:true,indexBuilding:false,mountsCovered:true,sharedChannelRowsUncovered:0,nextCursor:"sealed",
});
function harness(share=false) {
 let workspace={workspaceId:"w",rootPath:"/w",...(share?{shareView:{shareId:"s",recipientUserId:"u",grantedSelector:{paths:["notes"],versionId:null,access:"view"}}}:{})} as RegistryEntry;
 let generation=1, attachment=Symbol();
 const store={
 listChannels:vi.fn(async()=>[{id:"channel"}]),
 getChannelWireId:vi.fn(async(_input: {workspaceId:string;channelId:string})=>"wire"),
 linksPage:vi.fn(async (_input: unknown)=>raw()),
 };
 const withAuthority=vi.fn(async(work:()=>Promise<unknown>)=>work());
 const requireChatScope=vi.fn(async()=>({kind:share?"share":"workspace",workspace,store,access:"view",withAuthority}) as unknown as ChatScope);
 const resolveEngineFiles=vi.fn(async (_workspace:unknown,_targets:unknown)=>[{status:"found" as const,objectId:"object",path:"notes/a.md"}]);
 const present=vi.fn(async()=>({group:"opaque",hue:null,self:false}));
 const sync=vi.fn(async()=>0);
 const read=createChatLinksReader({requireChatScope,readWorkspace:()=>workspace,principalGeneration:()=>generation,
 currentAttachment:()=>attachment,syncWorkspaceSharedChannels:sync,resolveEngineFiles,
 presentationRequest:async()=>present});
 return {read,store,requireChatScope,resolveEngineFiles,present,sync,withAuthority,
 change:(patch:Partial<RegistryEntry>)=>{workspace={...workspace,...patch};},
 principal:()=>{generation++;},reattach:()=>{attachment=Symbol();}};
}
describe("chat Links authority",()=>{
 it("admits the conversation before reading candidates; unknown and unreadable answer null",async()=>{
  const h=harness(); h.store.listChannels.mockResolvedValue([]);
  expect(await h.read("w",{channelWireId:"missing"})).toBeNull();
  expect(await h.read("w",{channelWireId:"wire"})).toBeNull();
  expect(h.store.linksPage).not.toHaveBeenCalled();
 });
 it("reads one page, forwards the cursor, and projects authors without raw keys",async()=>{
  const h=harness(); const result=await h.read("w",{channelWireId:"wire",cursor:"from-mcp"});
  expect(h.store.linksPage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({cursor:"from-mcp",scope:expect.any(String)}));
  expect(h.sync).not.toHaveBeenCalled();
  expect(result).toMatchObject({nextCursor:"sealed",entries:[{author:{displayName:"Ada",presentation:{group:"opaque"}}}]});
  expect(JSON.stringify(result)).not.toMatch(/secret-user|secret-key|authorUserId|authorActorKey/);
 });
 it.each(["absent","invalid"] as const)("a chat grant never grants its %s file; omission has the empty page shape",async status=>{
  const h=harness(); h.resolveEngineFiles.mockResolvedValue([{status}] as never);
  const denied=await h.read("w",{channelWireId:"wire"});
  h.store.linksPage.mockResolvedValue({...raw(),entries:[]});
  const empty=await h.read("w",{channelWireId:"wire"});
  expect(denied).toEqual(empty);
  expect(denied).toEqual({...raw(),entries:[]});
  expect(h.present).not.toHaveBeenCalled();
  expect(JSON.stringify(denied)).not.toMatch(/notes|object|secret|author|omitted|count/);
 });
 it.each([{complete:false,indexBuilding:false},{complete:false,indexBuilding:true}])("preserves Decision A coverage %j without adding omission metadata",async coverage=>{
  const h=harness();h.store.linksPage.mockResolvedValue({...raw(),...coverage});
  h.resolveEngineFiles.mockResolvedValue([{status:"absent"}] as never);
  expect(await h.read("w",{channelWireId:"wire"})).toEqual({...raw(),...coverage,entries:[]});
 });
 it("refuses unknown authority instead of returning a partial success",async()=>{
  const h=harness(); h.requireChatScope.mockRejectedValue(new Error("unknown authority"));
  await expect(h.read("w",{channelWireId:"wire"})).rejects.toThrow("unknown authority");
  expect(h.store.linksPage).not.toHaveBeenCalled();
  const f=harness(); f.resolveEngineFiles.mockRejectedValue(new Error("unknown file authority"));
  await expect(f.read("w",{channelWireId:"wire"})).rejects.toThrow("unknown file authority");
 });
 it("marks a narrower share scope incomplete and never borrows native file authority",async()=>{
  const h=harness(true); const result=await h.read("w",{channelWireId:"wire"});
  expect(result).toMatchObject({entries:[],complete:false});
  expect(h.resolveEngineFiles).not.toHaveBeenCalled();
  expect(h.sync).not.toHaveBeenCalled();
  expect(h.withAuthority).toHaveBeenCalledOnce();
 });
 it.each(["principal","reattach","mount"] as const)("drops a response after %s authority changes",async change=>{
  const h=harness(), pending=deferred<ReturnType<typeof raw>>();
  h.store.linksPage.mockReturnValue(pending.promise);
  const result=h.read("w",{channelWireId:"wire"});
  await vi.waitFor(()=>expect(h.store.linksPage).toHaveBeenCalled());
  if(change==="principal")h.principal();
  if(change==="reattach")h.reattach();
  if(change==="mount")h.change({shareMounts:[{shareId:"new"}] as never});
  pending.resolve(raw());
  await expect(result).rejects.toThrow("chat-mention-access-changed");
 });
 it("guards the request after author hydration",async()=>{
  const h=harness();let active=true;h.present.mockImplementation(async()=>{active=false;return {group:"opaque",hue:null,self:false};});
  await expect(h.read("w",{channelWireId:"wire"},()=>{if(!active)throw Error("stale");})).rejects.toThrow("stale");
 });
});

it("binds continuation scope to authority between pages and preserves engine refusals",async()=>{
  const h=harness();let original="";
  h.store.linksPage.mockImplementation(async input=>{
    const value=input as {scope:string;cursor?:string};
    if(value.cursor&&value.scope!==original)throw Error("chat-mention-access-changed");
    original=value.scope;return raw();
  });
  await h.read("w",{channelWireId:"wire"});
  await h.read("w",{channelWireId:"wire",cursor:"sealed"});
  h.principal();
  await expect(h.read("w",{channelWireId:"wire",cursor:"sealed"})).rejects.toThrow("chat-mention-access-changed");
  h.store.linksPage.mockRejectedValue(Error("chat-conversation-links-changed"));
  await expect(h.read("w",{channelWireId:"wire",cursor:"sealed"})).rejects.toThrow("chat-conversation-links-changed");
});
it.each([".dohc/private.md","../outside.md","/absolute.md"])("omits reserved or escaping resolved paths: %s",async path=>{
  const h=harness();h.resolveEngineFiles.mockResolvedValue([{status:"found",objectId:"object",path}]);
  expect(await h.read("w",{channelWireId:"wire"})).toMatchObject({entries:[]});
  expect(h.present).not.toHaveBeenCalled();
});
it("uses the received source token for a received object and current authorized path",async()=>{
  const h=harness(true),objectId="share-object:v1:"+"a".repeat(64),receivedSource="share-source:v1:"+"b".repeat(64);
  h.change({shareView:{shareId:"s",recipientUserId:"u",grantedSelector:{paths:["notes"],versionId:null,access:"view"},
    receivedIdentity:{receivedSource,grantId:"grant",generation:1}} as RegistryEntry["shareView"]});
  const page=raw();page.entries[0]!.file.objectId=objectId;
  h.store.linksPage.mockResolvedValue(page);
  h.resolveEngineFiles.mockResolvedValue([{status:"found",objectId,path:"notes/renamed.md"}]);
  expect(await h.read("w",{channelWireId:"wire"})).toMatchObject({
    complete:false,entries:[{file:{objectId,receivedSource,path:"notes/renamed.md",folder:"notes"}}],
  });
  expect(h.resolveEngineFiles).toHaveBeenCalledWith(expect.anything(),[
    expect.objectContaining({source:{receivedSource},target:{kind:"file",objectId}}),
  ]);
  h.resolveEngineFiles.mockResolvedValue([{status:"found",objectId,path:"private/secret.md"}]);
  expect(await h.read("w",{channelWireId:"wire"})).toMatchObject({entries:[],complete:false});
});
it("refuses damaged share authority without trying the owned file boundary",async()=>{
  const h=harness(true);h.change({shareView:{shareId:"s",grantedSelector:null} as never});
  await expect(h.read("w",{channelWireId:"wire"})).rejects.toThrow("chat-mention-access-changed");
  expect(h.store.linksPage).not.toHaveBeenCalled();expect(h.resolveEngineFiles).not.toHaveBeenCalled();
});

it("looks up readable wire IDs in parallel and ignores a deleted channel", async () => {
  const h = harness(), first = deferred<string>();
  h.store.listChannels.mockResolvedValue([{ id: "slow" }, { id: "deleted" }, { id: "healthy" }]);
  h.store.getChannelWireId.mockImplementation(({ channelId }: { channelId: string }) =>
    channelId === "slow" ? first.promise : channelId === "deleted" ? Promise.reject(Error("deleted")) : Promise.resolve("wire"));
  const reading = h.read("w", { channelWireId: "wire", cursor: "sealed" });
  await vi.waitFor(() => expect(h.store.getChannelWireId).toHaveBeenCalledTimes(3));
  first.resolve("other");
  expect(await reading).toMatchObject({ subject: { channelWireId: "wire" } });
  expect(await h.read("w", { channelWireId: "missing", cursor: "sealed" })).toBeNull();
});

it.each(["view", "mount"] as const)("keeps paging after %s skip records and warning dismissal", async kind => {
  const h = harness(kind === "view");
  const record = {
    shareId: "s", label: "shared", recipientUserId: "u", relayUrl: "https://relay.test",
    granterEmail: null, genericChatWritable: false,
    grantedSelector: { paths: ["notes"], versionId: null, access: "view" as const },
  };
  const change = (extra: object) => kind === "view"
    ? h.change({ shareView: { ...record, ...extra } })
    : h.change({ shareMounts: [{ ...record, ...extra }] });
  change({});
  await h.read("w", { channelWireId: "wire" });
  const original = (h.store.linksPage.mock.calls.at(-1)![0] as { scope: string }).scope;
  for (const skippedOps of [
    { ops: [], more: 1, generation: 2 },
    { ops: [], more: 1, generation: 2, acknowledgedGeneration: 2 },
  ]) {
    change({ skippedOps });
    await h.read("w", { channelWireId: "wire", cursor: "sealed" });
    expect(h.store.linksPage.mock.calls.at(-1)![0]).toMatchObject({ scope: original });
  }
  change({ grantedSelector: { paths: ["other"], versionId: null, access: "view" } });
  await h.read("w", { channelWireId: "wire", cursor: "sealed" });
  expect((h.store.linksPage.mock.calls.at(-1)![0] as { scope: string }).scope).not.toBe(original);
});

it.each(["mount", "channel"] as const)("binds new %s record fields by default and refuses stale cursors", async kind => {
  const h = harness();
  const record = kind === "mount"
    ? { shareId: "s", label: "shared", granterEmail: null, relayUrl: "https://relay.test",
        grantedSelector: { paths: ["notes"], versionId: null, access: "view" as const } }
    : { shareId: "s", channelWireId: "wire", access: "read-only" as const, granterEmail: null,
        relayUrl: "https://relay.test", recipientUserId: "u" };
  const change = (extra: object) => kind === "mount"
    ? h.change({ shareMounts: [{ ...record, ...extra }] as RegistryEntry["shareMounts"] })
    : h.change({ sharedChannels: [{ ...record, ...extra }] as RegistryEntry["sharedChannels"] });
  change({});
  let original = "";
  h.store.linksPage.mockImplementation(async input => {
    const value = input as { scope: string; cursor?: string };
    if (value.cursor && value.scope !== original) throw Error("chat-mention-access-changed");
    original = value.scope;
    return raw();
  });
  await h.read("w", { channelWireId: "wire" });
  await h.read("w", { channelWireId: "wire", cursor: "sealed" });
  change({ futureAccessField: "restricted" });
  await expect(h.read("w", { channelWireId: "wire", cursor: "sealed" })).rejects.toThrow("chat-mention-access-changed");
});
