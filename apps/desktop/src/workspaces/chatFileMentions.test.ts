import { describe, expect, it, vi } from "vitest";
import type { ChatFileMentionsPage } from "@dohc/workspace-contracts/chat-file-mentions";
import type { ChatScope } from "../ipc/chatScope";
import type { RegistryEntry } from "./registryStore";
import { createChatFileMentionsReader } from "./chatFileMentions";
import { deferred } from "../testing/deferred";

const page = (paths: string[] = []): NonNullable<ChatFileMentionsPage> => ({
  versionId: "main", subject: null, entries: paths.map((path, i) => ({
    attachment: { attachmentId: String(i), threadId: "t", messageId: "m", targetKind: "file",
      objectId: String(i), pathHint: path, createdAtMs: 1 },
    message: { id: "m", authorDisplayName: "Ada", preview: "Hi", createdAtMs: 1 },
    thread: { id: "t", title: "Thread", createdAtMs: 1, updatedAtMs: 1 },
  })), unchecked: paths, complete: true, indexBuilding: false, mountsCovered: true,
  sharedChannelRowsUncovered: 0, nextCursor: "opaque",
});
function harness(kind: "workspace" | "share" = "workspace") {
  let workspace = { workspaceId: "w", rootPath: "/w", ...(kind === "share" ? { shareView: {
    shareId: "s", recipientUserId: "u", grantedSelector: {paths:["notes"],versionId:null,access:"view"},
  }} : {}) } as RegistryEntry;
  let generation = 1;
  const fileMentionsPage = vi.fn(async () => page());
  const withAuthority = vi.fn(async (work: () => Promise<unknown>) => work());
  const scope = { kind, workspace, store: { fileMentionsPage }, withAuthority, access: "view" } as unknown as ChatScope;
  const requireChatScope = vi.fn(async (): Promise<ChatScope> => ({ ...scope, workspace }) as ChatScope);
  const sync = vi.fn(async () => 0);
  const read = createChatFileMentionsReader({ requireChatScope, syncWorkspaceSharedChannels: sync,
    readWorkspace: () => workspace, principalGeneration: () => generation });
  return {read, fileMentionsPage, requireChatScope, sync, withAuthority,
    change: (patch: Partial<RegistryEntry>) => { workspace = {...workspace,...patch}; },
    changePrincipal: () => { generation++; },
  };
}
describe("chat mention page authority", () => {
  it("requires chat authority and reads one page, preserving continuation and uncovered coverage", async () => {
    const h = harness();
    h.sync.mockResolvedValue(7);
    const result = await h.read("w", {});
    await h.read("w", {cursor:"previous"});
    expect(h.requireChatScope).toHaveBeenCalledWith("w");
    expect(h.sync).toHaveBeenCalledOnce();
    expect(h.fileMentionsPage).toHaveBeenCalledTimes(2);
    expect(h.fileMentionsPage).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId:"w",sharedChannelRowsUncovered:7,scope:expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(h.fileMentionsPage).toHaveBeenLastCalledWith(expect.objectContaining({cursor:"previous",sharedChannelRowsUncovered:0}));
    expect(result?.nextCursor).toBe("opaque");
  });
  it("never reads the store without the Chats capability", async () => {
    const h = harness();
    h.requireChatScope.mockRejectedValue(new Error("Chats unavailable"));
    await expect(h.read("w",{})).rejects.toThrow("Chats unavailable");
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.fileMentionsPage).not.toHaveBeenCalled();
  });
  it("uses only the projected share store and hides out-of-selector and reserved identities", async () => {
    const h = harness("share");
    const projected = page(["notes/a.md","private/b.md",".dohc/secret"]);
    projected.entries[0] = {...projected.entries[0]!,channelId:"local",channelKind:"channel",channelName:"Private name",channelSlug:"private",channelWireId:"secret-wire"};
    h.fileMentionsPage.mockResolvedValue(projected);
    const result = await h.read("w",{});
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.withAuthority).toHaveBeenCalledOnce();
    expect(result?.entries.map(row=>row.attachment.pathHint)).toEqual(["notes/a.md"]);
    expect(result?.entries[0]).toMatchObject({channelId:"local",channelKind:"channel"});
    for (const field of ["channelName","channelSlug","channelWireId"]) expect(result?.entries[0]).not.toHaveProperty(field);
  });
  it("reacquires authority once when synchronization ends a channel", async () => {
    const h = harness();
    const pending = deferred<number>();
    h.sync.mockReturnValue(pending.promise);
    const result = h.read("w",{});
    await vi.waitFor(()=>expect(h.sync).toHaveBeenCalled());
    h.change({sharedChannels:[{shareId:"ended",ended:true} as NonNullable<RegistryEntry["sharedChannels"]>[number]]});
    pending.resolve(3);
    await expect(result).resolves.toMatchObject({nextCursor:"opaque"});
    expect(h.requireChatScope).toHaveBeenCalledTimes(2);
    expect(h.sync).toHaveBeenCalledOnce();
    expect(h.fileMentionsPage).toHaveBeenCalledOnce();
    expect(h.fileMentionsPage).toHaveBeenCalledWith(expect.objectContaining({sharedChannelRowsUncovered:3}));
  });
  it.each(["root","principal","membership"] as const)("discards rows when %s changes during the page read", async change => {
    const h = harness();
    const pending = deferred<NonNullable<ChatFileMentionsPage>>();
    h.fileMentionsPage.mockReturnValue(pending.promise);
    const result = h.read("w",{});
    await vi.waitFor(()=>expect(h.fileMentionsPage).toHaveBeenCalled());
    if(change==="root")h.change({rootPath:"/replacement"});
    if(change==="principal")h.changePrincipal();
    if(change==="membership")h.change({sharedChannels:[{shareId:"new"} as NonNullable<RegistryEntry["sharedChannels"]>[number]]});
    pending.resolve(page());
    await expect(result).rejects.toThrow("chat-mention-access-changed");
  });
  it("checks the renderer request after awaits", async () => {
    const h = harness();
    let active = true;
    h.fileMentionsPage.mockImplementation(async()=>{active=false;return page();});
    await expect(h.read("w",{},()=>{if(!active)throw Error("stale request");})).rejects.toThrow("stale request");
  });
});
