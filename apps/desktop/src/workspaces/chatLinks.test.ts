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
 getChannelWireId:vi.fn(async()=>"wire"),
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
