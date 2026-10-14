import { describe, expect, it, vi } from "vitest";
import { readLocalChatActor, resolveThreadActorIssuer, type ChatRelayIdentityStore } from "./chatRelayIdentity";
import type { RegistryEntry, JoinedSharedChannel } from "./registryStore";
import { join } from "node:path";
import { createRegistryStore } from "./registryStore";
import { createTestScratch } from "./testTemp";
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
  return { workspace, channels, store, resolve: (threadId: string) => resolveThreadActorIssuer({ readWorkspace: () => workspace, store, threadId }) };
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
    expect(await resolveThreadActorIssuer({ readWorkspace: () => workspace, store: test.store, threadId: "a" })).toBe("https://accounts-a.test/base");
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
    const registry = createRegistryStore(join(await createTestScratch("chat-issuer-"), "registry.json"));
    registry.register({ ...test.workspace, rootPath: "/workspace", kind: "personal", mode: "local-first" });
    const pending = resolveThreadActorIssuer({ store: test.store, threadId: "a",
      readWorkspace: () => registry.find("workspace") });
    await entered.promise;
    // The old entry stays untouched: the registry publishes a replacement.
    registry.setSharedChannels("workspace", []);
    release.resolve();
    expect(await pending).toBeNull();
  });

  it("resolves the immutable thread and wire binding once", async () => {
    const test = fixture();
    expect(await test.resolve("a")).toBe("https://accounts-a.test/base");
    expect(test.store.findThreadChannelId).toHaveBeenCalledTimes(1);
    expect(test.store.getChannelWireId).toHaveBeenCalledTimes(1);
  });

  it("keeps a removed workspace unknown", async () => {
    expect(await resolveThreadActorIssuer({ readWorkspace: () => null, store: fixture().store, threadId: "a" })).toBeNull();
  });

  it("rechecks the caller's attachment after awaits", async () => {
    const test = fixture();
    let current = true;
    test.store.getChannelWireId = async () => { current = false; return "wire-a"; };
    await expect(resolveThreadActorIssuer({ readWorkspace: () => test.workspace, store: test.store, threadId: "a", assertCurrent: () => { if (!current) throw new Error("attachment changed"); } })).rejects.toThrow("attachment changed");
  });
});

describe("local chat actor reading", () => {
  const authorActorKey = '{"kind":"installation","installationId":"device"}';
  const human = { kind: "human" as const, displayName: "Sam" };

  it("reads renderer human admission as local", () => {
    expect(readLocalChatActor({ authorActorKey, author: human })).toEqual({
      key: { kind: "installation", installationId: "device" },
      displayName: "Sam", origin: "renderer", assurance: "local",
    });
  });

  it("keeps CLI human participation owner-asserted", () => {
    expect(readLocalChatActor({ authorActorKey, author: human, origin: "cli" })).toMatchObject({
      key: { kind: "installation", installationId: "device" }, origin: "cli", assurance: "owner-asserted",
    });
  });

  it.each([
    ["agent", '{"kind":"agent","ownerKey":{"kind":"installation","installationId":"device"},"claimedName":"Opus"}'],
    ["automation", '{"kind":"automation","ownerKey":{"kind":"installation","installationId":"device"},"workspaceId":"workspace","automationId":"rule"}'],
  ] as const)("keeps local %s authors owner-asserted", (kind, key) => {
    expect(readLocalChatActor({ authorActorKey: key, author: { kind, displayName: "Claim" } })).toMatchObject({
      assurance: "owner-asserted",
    });
  });

  it("rejects absent or malformed own-store keys", () => {
    expect(readLocalChatActor({ author: human })).toBeNull();
    for (const key of ['{"kind":"account","issuer":"bad","userId":"u"}', "broken"]) {
      expect(readLocalChatActor({ authorActorKey: key, author: human })).toBeNull();
    }
    expect(readLocalChatActor({ authorActorKey: '{"kind":"unknown"}', author: human })).toMatchObject({ assurance: "unknown" });
  });
});
