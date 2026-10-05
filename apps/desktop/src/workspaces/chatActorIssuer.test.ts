import { describe, expect, it, vi } from "vitest";
import { readLocalChatActorKey, resolveThreadActorIssuer, type ChatRelayIdentityStore } from "./chatRelayIdentity";
import type { RegistryEntry, JoinedSharedChannel } from "./registryStore";
import { deferred } from "../testing/deferred";

function fixture() {
  const channels: JoinedSharedChannel[] = [
    { shareId: "a", channelWireId: "wire-a", access: "read-write", granterEmail: null, relayUrl: "https://relay-a.test", serverUrl: "HTTPS://ACCOUNTS-A.TEST:443/base/", recipientUserId: "same-id" },
    { shareId: "b", channelWireId: "wire-b", access: "read-only", granterEmail: null, relayUrl: "https://relay-b.test", serverUrl: "https://accounts-b.test", recipientUserId: "same-id" },
  ];
  const workspace: Pick<RegistryEntry, "workspaceId" | "remote" | "sharedChannels" | "shareView"> = {
    workspaceId: "workspace", remote: { serverUrl: "https://owner.test", ownerUserId: "owner" }, sharedChannels: channels,
  };
  const store: ChatRelayIdentityStore = {
    findThreadChannelId: vi.fn(async ({ threadId }) => threadId),
    getChannelWireId: vi.fn(async ({ channelId }) => `wire-${channelId}`),
  };
  return { workspace, channels, store, resolve: (threadId: string) => resolveThreadActorIssuer({ workspace, store, threadId }) };
}

describe("thread ActorIssuer", () => {
  it("keeps joined Groups from two account servers separate from their relays and workspace owner", async () => {
    const test = fixture();
    expect(await test.resolve("a")).toBe("https://accounts-a.test/base");
    expect(await test.resolve("b")).toBe("https://accounts-b.test");
    expect(await test.resolve("local")).toBe("https://owner.test");
  });

  it("preserves the joined issuer through registry restart", async () => {
    const test = fixture();
    const workspace = JSON.parse(JSON.stringify(test.workspace)) as typeof test.workspace;
    expect(await resolveThreadActorIssuer({ workspace, store: test.store, threadId: "a" })).toBe("https://accounts-a.test/base");
  });

  it("keeps older joined rows unknown instead of borrowing relay or workspace issuer", async () => {
    const test = fixture();
    delete test.channels[0]!.serverUrl;
    expect(await test.resolve("a")).toBeNull();
  });

  it.each(["not a URL", "file:///accounts", "https://accounts.test?query=1"])("keeps malformed stored issuers unknown (%s)", async (serverUrl) => {
    const test = fixture();
    test.channels[0]!.serverUrl = serverUrl;
    test.workspace.remote!.serverUrl = serverUrl;
    expect(await test.resolve("a")).toBeNull();
    expect(await test.resolve("local")).toBeNull();
  });

  it("does not infer received-share provenance from the mounting workspace", async () => {
    const test = fixture();
    test.workspace.shareView = { shareId: "received", granterEmail: null, genericChatWritable: false, grantedSelector: { paths: ["notes"], versionId: null, access: "view" } };
    expect(await test.resolve("local")).toBeNull();
  });

  it.each(["thread", "wire"])("discards a registry binding changed during the %s await", async (step) => {
    const test = fixture();
    const entered = deferred();
    const release = deferred();
    if (step === "thread") test.store.findThreadChannelId = async () => { entered.resolve(); await release.promise; return "a"; };
    else test.store.getChannelWireId = async () => { entered.resolve(); await release.promise; return "wire-a"; };
    const pending = test.resolve("a");
    await entered.promise;
    test.workspace.sharedChannels = [];
    release.resolve();
    expect(await pending).toBeNull();
  });

  it("discards a thread rebound to another Group during its lookups", async () => {
    const test = fixture();
    test.store.findThreadChannelId = vi.fn().mockResolvedValueOnce("a").mockResolvedValue("b");
    expect(await test.resolve("a")).toBeNull();
  });

  it.each([[null, "local"], ["local", null]])("discards a binding that changes between absent and present (%s to %s)", async (initial, current) => {
    const test = fixture();
    test.store.findThreadChannelId = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(current);
    expect(await test.resolve("local")).toBeNull();
  });

  it("rechecks the caller's attachment after awaits", async () => {
    const test = fixture();
    let current = true;
    test.store.getChannelWireId = async () => { current = false; return "wire-a"; };
    await expect(resolveThreadActorIssuer({ workspace: test.workspace, store: test.store, threadId: "a", assertCurrent: () => { if (!current) throw new Error("attachment changed"); } })).rejects.toThrow("attachment changed");
  });
});

describe("local chat key parsing", () => {
  it("reads only the dedicated own-store column, without restoring assurance", () => {
    const key = readLocalChatActorKey({ authorActorKey: '{"kind":"installation","installationId":"device"}' });
    expect(key).toEqual({ kind: "installation", installationId: "device" });
    expect(key).not.toHaveProperty("assurance");
    expect(readLocalChatActorKey({})).toBeNull();
    expect(readLocalChatActorKey({ authorActorKey: '{"kind":"account","issuer":"bad","userId":"u"}' })).toBeNull();
    expect(readLocalChatActorKey({ authorActorKey: "broken" })).toBeNull();
  });
});
