import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "./channels";
import { registerSharedChannelsIpcHandlers } from "./sharedChannelsIpc";
import { createWorkspaceAuthorityOwner, type PhysicalWorkspace } from "../workspaces/workspaceAuthorityOwner";
import { createRendererWorkspaceOperationRunner, type ExactRendererWorkspaceOperation } from "../window/rendererWorkspaceOperation";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { JoinedSharedChannel, RegistryEntry } from "../workspaces/registryStore";
import { deferred } from "../testing/deferred";

const credentials: CloudCredentials = {
  serverUrl: "https://account.test", relayUrl: "https://relay.test",
  token: "token", userId: "member", email: "member@example.test",
};

function joined(id: string): JoinedSharedChannel {
  return {
    shareId: id, channelWireId: `wire-${id}`, access: "read-only",
    granterEmail: "owner@example.test", relayUrl: credentials.relayUrl!,
    recipientUserId: credentials.userId,
  };
}

async function harness() {
  const workspace: RegistryEntry = {
    workspaceId: "workspace", rootPath: "/workspace", kind: "personal",
    mode: "local-first", sharedChannels: [joined("shown"), joined("history")],
  };
  const other: RegistryEntry = {
    ...workspace, workspaceId: "other", rootPath: "/other", sharedChannels: [joined("elsewhere")],
  };
  const state = { operationLanes: new Map<string, Promise<void>>() };
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: (id: string) => id === workspace.workspaceId ? workspace : id === other.workspaceId ? other : null,
    canonicalizeRoot: (root: string) => root, createState: () => state,
  });
  const attachmentId = await authorities.withOperation("workspace", (operation) => operation.workspace.attachmentId);
  let rendererCurrent = true;
  let generation = 1;
  const session = { workspaceId: "workspace", attachmentId, generation: 1, isCurrent: () => rendererCurrent };
  type Event = { sender: string; trusted: boolean };
  type Workspace = PhysicalWorkspace<RegistryEntry>;
  type Operation = ExactRendererWorkspaceOperation<Workspace, typeof state, typeof session>;
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner<string, Workspace, typeof state, typeof session>({
    currentSession: (_sender: string) => session,
    withPhysicalOperation: (workspaceId, work) => authorities.withOperation(workspaceId, work),
  });
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  const relayListing = vi.fn(async (): Promise<unknown> => ({ granted: [], received: [] }));
  const warm = vi.fn(async () => undefined);
  const peek = vi.fn(async () => "not-dm" as const);
  const cache = new Map<string, "dm" | "not-dm">();
  const write = vi.fn((workspaceId: string, channels: JoinedSharedChannel[]) => {
    expect(workspaceId).toBe("workspace");
    workspace.sharedChannels = channels;
  });
  const notify = vi.fn();
  const acknowledge = vi.fn();
  const helpers = registerSharedChannelsIpcHandlers<string, Event, Workspace, Operation>({
    registerHandler: (channel, handler) => {
      expect(handlers.has(channel)).toBe(false);
      handlers.set(channel, handler);
    },
    assertTrustedSender: (event) => { if (!event.trusted) throw new Error("untrusted"); },
    withRendererWorkspaceOperation,
    requireEngineCapture: async (captured) => ({ workspace: captured }),
    assertWritableWorkspace: () => undefined,
    linkedChatStoreFor: () => ({ listChannels: async () => [], getChannelWireId: async () => null }),
    remoteForWorkspace: async () => ({ credentials, credentialGeneration: generation }),
    currentCredentialGeneration: () => generation, currentCredentials: () => credentials,
    warmCredentialCache: warm,
    relayShareJsonWithCredentials: async <Result>() => await relayListing() as Result,
    listWorkspaces: () => [workspace, other], setWorkspaceSharedChannels: write,
    relayClientForWorkspace: () => ({ pullSharedChannel: async () => ({ fetched: 0, applied: 0, skipped: 0, nextCursor: 0 }) }),
    projectPendingChatBookmarksAfterPull: async () => undefined,
    normalizeServerUrl: (url) => url, peekedReceivedGrantKinds: cache,
    peekReceivedGrantKindForShare: peek, acknowledgeWorkspaceShareSkips: acknowledge,
    notifyRenderer: notify,
  });
  const invoke = async (channel: string, payload: unknown, trusted = true) =>
    handlers.get(channel)!({ sender: "window", trusted }, payload);
  return {
    handlers, invoke, workspace, other, authorities, helpers, relayListing, warm, peek, cache, write, notify, acknowledge,
    rotateCredentials: () => { generation += 1; }, retireRenderer: () => { rendererCurrent = false; },
  };
}

describe("registered shared-channel handlers", () => {
  it("registers the original sequence and rejects untrusted requests before work", async () => {
    const h = await harness();
    expect([...h.handlers.keys()]).toEqual([
      CHANNELS.shareChatChannel, CHANNELS.listJoinedSharedChannels,
      CHANNELS.listChatChannelShares, CHANNELS.joinSharedChannel,
      CHANNELS.leaveSharedChannel, CHANNELS.dismissShareSkips,
    ]);
    for (const channel of h.handlers.keys()) await expect(h.invoke(channel, null, false)).rejects.toThrow("untrusted");
    expect(h.warm).not.toHaveBeenCalled();
    expect(h.relayListing).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it("answers only requested local channels without waiting for credentials or the relay", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.listJoinedSharedChannels, {
      workspaceId: "workspace", channelWireIds: ["wire-shown", "missing", "wire-shown"],
    })).resolves.toEqual({ joined: [
      { channelWireId: "wire-shown", joined: {
        shareId: "shown", channelWireId: "wire-shown", access: "read-only",
        granterEmail: "owner@example.test", ended: false,
      } },
      { channelWireId: "missing", joined: null },
    ] });
    expect(h.warm).not.toHaveBeenCalled();
    expect(h.relayListing).not.toHaveBeenCalled();
    await expect(h.invoke(CHANNELS.listJoinedSharedChannels, { workspaceId: "workspace" })).rejects.toThrow();
  });

  it.each(["credentials", "renderer", "authority"] as const)("rejects a relay listing retired by %s before publishing or caching it", async (reason) => {
    const h = await harness();
    const started = deferred();
    const held = deferred<unknown>();
    h.relayListing.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.listChatChannelShares, { workspaceId: "workspace", channelWireIds: ["wire-shown"] });
    await started.promise;
    let drained: Promise<void> | undefined;
    if (reason === "credentials") h.rotateCredentials();
    else if (reason === "renderer") h.retireRenderer();
    else drained = h.authorities.invalidate("workspace");
    held.resolve({ received: [{ shareId: "late", selector: { kind: "chat-channel", channelWireId: "late-wire" } }] });
    await expect(result).rejects.toThrow();
    await drained;
    expect(h.peek).not.toHaveBeenCalled();
    expect(h.cache.size).toBe(0);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("leaves a local tombstone and rejects a request for another window's workspace", async () => {
    const h = await harness();
    await h.invoke(CHANNELS.leaveSharedChannel, { workspaceId: "workspace", shareId: "shown" });
    expect(h.workspace.sharedChannels).toEqual([{ ...joined("shown"), ended: true }, joined("history")]);
    expect(h.other.sharedChannels).toEqual([joined("elsewhere")]);
    await expect(h.invoke(CHANNELS.leaveSharedChannel, { workspaceId: "other", shareId: "elsewhere" })).rejects.toThrow("changed workspaces");
    expect(h.write).toHaveBeenCalledOnce();
    expect(h.relayListing).not.toHaveBeenCalled();
  });

  it("does not cache an invitation kind returned after the account changes", async () => {
    const h = await harness();
    h.relayListing.mockResolvedValue({ received: [{
      shareId: "late", selector: { kind: "chat-channel", channelWireId: "late-wire" },
    }] });
    const started = deferred();
    const held = deferred<"not-dm">();
    h.peek.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.listChatChannelShares, { workspaceId: "workspace", channelWireIds: [] });
    await started.promise;
    h.rotateCredentials();
    held.resolve("not-dm");
    await expect(result).rejects.toThrow("session changed");
    expect(h.cache.size).toBe(0);
  });

  it("keeps the shared DM helpers bound to the same live registry holders", async () => {
    const h = await harness();
    expect(() => h.helpers.assertShareNotHeldElsewhere("elsewhere", "workspace")).toThrow("already lives in other");
    expect(() => h.helpers.assertShareNotHeldElsewhere("new-grant", "workspace", "wire-elsewhere")).toThrow("already lives in other");
    h.other.sharedChannels = [{ ...joined("elsewhere"), ended: true }];
    expect(() => h.helpers.assertShareNotHeldElsewhere("elsewhere", "workspace", "wire-elsewhere")).not.toThrow();
  });
});
