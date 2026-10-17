import type { ListJoinedSharedChannelsResult } from "./bridgeContract";
import { describe, expect, it, vi } from "vitest";
import { sharedChannelOperations } from "./shareOperations";
import { registerOperations } from "./operationTable";
import { createSharedChannelsIpc } from "./sharedChannelsIpc";
import { fetchSharedChannelInfo } from "../workspaces/sharedChannelInfo";
import type { ChatChannelSummary } from "@dohc/workspace-contracts/engine";

vi.mock("../workspaces/sharedChannelInfo", () => ({ fetchSharedChannelInfo: vi.fn() }));

function channel(overrides: Partial<ChatChannelSummary>): ChatChannelSummary {
  return {
    id: "chan", workspaceId: "workspace", name: "Team", slug: "team", kind: "channel",
    type: "both", purpose: "", createdAtMs: 1, updatedAtMs: 1, threadCount: 0, unreadCount: 0,
    ...overrides,
  };
}
import { createWorkspaceAuthorityOwner, type PhysicalWorkspace } from "../workspaces/workspaceAuthorityOwner";
import { createRendererWorkspaceOperationRunner, type ExactRendererWorkspaceOperation } from "../window/rendererWorkspaceOperation";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { JoinedSharedChannel, RegistryEntry } from "../workspaces/registryStore";
import { deferred } from "../testing/deferred";
import { RelayClaimRefusedError, RelayIdentityMissingError } from "@dohc/workspace-contracts/relay";

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

async function harness(workspaceId = "workspace") {
  const workspace: RegistryEntry = {
    workspaceId, rootPath: "/workspace", kind: "personal",
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
  const attachmentId = await authorities.withOperation(workspaceId, (operation) => operation.workspace.attachmentId);
  const otherAttachmentId = await authorities.withOperation("other", operation => operation.workspace.attachmentId);
  let rendererCurrent = true;
  let generation = 1;
  const session = { workspaceId, attachmentId, generation: 1, isCurrent: () => rendererCurrent };
  const otherSession = { workspaceId: "other", attachmentId: otherAttachmentId, generation: 1, isCurrent: () => true };
  type Event = { sender: string; trusted: boolean };
  type Workspace = PhysicalWorkspace<RegistryEntry>;
  type Operation = ExactRendererWorkspaceOperation<Workspace, typeof state, typeof session>;
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner<string, Workspace, typeof state, typeof session>({
    currentSession: sender => sender === "other-window" ? otherSession : session,
    withPhysicalOperation: (workspaceId, work) => authorities.withOperation(workspaceId, work),
  });
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  const relayListing = vi.fn(async (): Promise<unknown> => ({ granted: [], received: [] }));
  const warm = vi.fn(async () => undefined);
  const peek = vi.fn(async () => "not-dm" as const);
  const cache = new Map<string, "dm" | "not-dm">();
  const write = vi.fn(async (
    workspaceId: string,
    update: (channels: readonly JoinedSharedChannel[]) => readonly JoinedSharedChannel[],
  ) => {
    expect(workspaceId).toBe("workspace");
    workspace.sharedChannels = [...update(workspace.sharedChannels ?? [])];
  });
  const pull = vi.fn(async () => ({ fetched: 0, applied: 0, skipped: 0, nextCursor: 0 }));
  const notify = vi.fn();
  const acknowledge = vi.fn();
  const unmount = vi.fn<() => Promise<{ folderLeft?: true }>>(async () => ({}));
  const push = vi.fn(async () => undefined);
  const claim = vi.fn(async () => undefined);
  const rotateAfterLookup = { value: false };
  const mount = vi.fn(async () => undefined);
  const sharesChanged = vi.fn<(workspaceId: string) => void>();
  const reconcileReceivedShares = vi.fn<(listing: unknown) => Promise<void>>(async () => undefined);
  const store = {
    listChannels: vi.fn(async (): Promise<ChatChannelSummary[]> => []),
    getChannelWireId: vi.fn(async (_input: { workspaceId: string; channelId: string }): Promise<string | null> => null),
  };
  const relayCalls: Array<{ path: string; init?: RequestInit }> = [];
  const helpers = createSharedChannelsIpc<Workspace, Operation>({
    requireEngineCapture: async (captured) => ({ workspace: captured }),
    assertWritableWorkspace: () => undefined,
    linkedChatStoreFor: () => store,
    remoteForWorkspace: async () => {
      // A rotation that lands after the lookup resolves and before the
      // handler resumes: the captured generation is already stale.
      const captured = generation;
      if (rotateAfterLookup.value) generation += 1;
      return { credentials, credentialGeneration: captured };
    },
    currentCredentialGeneration: () => generation, currentCredentials: () => credentials,
    warmCredentialCache: warm,
    relayShareJsonWithCredentials: async <Result>(_credentials: CloudCredentials, path: string, init?: RequestInit) => {
      relayCalls.push({ path, init });
      return await relayListing() as Result;
    },
    listWorkspaces: () => [workspace, other], updateWorkspaceSharedChannels: write,
    relayClientForWorkspace: () => ({ pullSharedChannel: pull, push, claim }),
    projectPendingChatBookmarksAfterPull: async () => undefined,
    normalizeServerUrl: (url) => url, peekedReceivedGrantKinds: cache,
    peekReceivedGrantKindForShare: peek, acknowledgeWorkspaceShareSkips: acknowledge,
    notifyRenderer: notify, mountShareFolder: mount, unmountShareFolder: unmount,
    sharesChanged, reconcileReceivedShares,
  });
  registerOperations<typeof sharedChannelOperations, Event, Operation>({
    handle: (channel, handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); },
    assertTrustedSender: (event: Event) => { if (!event.trusted) throw new Error("untrusted"); },
    withActiveWorkspace: (event, id, message, work) => withRendererWorkspaceOperation(event.sender, id, message, work),
  }, sharedChannelOperations, helpers.handlers);
  const invoke = async (channel: string, payload: unknown, trusted = true) =>
    handlers.get(channel)!({ sender: "window", trusted }, payload);
  return {
    handlers, invoke, workspace, other, authorities, helpers, relayListing, warm, peek, cache, write, pull, notify, acknowledge,
    mount, unmount, push, claim, rotateAfterLookup, store, relayCalls, sharesChanged, reconcileReceivedShares,
    rotateCredentials: () => { generation += 1; }, retireRenderer: () => { rendererCurrent = false; },
  };
}

describe("registered shared-channel handlers", () => {
  it.each(Object.values(sharedChannelOperations))("rejects an untrusted sender on $channel before parsing or work", async row => {
    const h = await harness();
    await expect(h.invoke(row.channel, null, false)).rejects.toThrow("untrusted");
    expect(h.warm).not.toHaveBeenCalled();
    expect(h.relayListing).not.toHaveBeenCalled();
    expect(h.peek).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.pull).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.acknowledge).not.toHaveBeenCalled();
    expect(h.mount).not.toHaveBeenCalled();
    expect(h.unmount).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.sharesChanged).not.toHaveBeenCalled();
    expect(h.reconcileReceivedShares).not.toHaveBeenCalled();
  });

  it.each(Object.values(sharedChannelOperations))("rejects another open workspace on $channel before work", async row => {
    const h = await harness();
    const payload = row.payload.parse({
      workspaceId: "other", proposalId: "proposal", opIndex: 0, decision: "accept",
      channelId: "chan", recipientEmail: "peer@example.test", channelWireIds: [],
      shareId: "share", generation: 1,
    });
    await expect(h.invoke(row.channel, payload)).rejects.toThrow(row.inactiveMessage);
    expect(h.warm).not.toHaveBeenCalled();
    expect(h.relayListing).not.toHaveBeenCalled();
    expect(h.peek).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.pull).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.acknowledge).not.toHaveBeenCalled();
    expect(h.mount).not.toHaveBeenCalled();
    expect(h.unmount).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.sharesChanged).not.toHaveBeenCalled();
    expect(h.reconcileReceivedShares).not.toHaveBeenCalled();
  });

  it("registers the original sequence and rejects untrusted requests before work", async () => {
    const h = await harness();
    expect([...h.handlers.keys()]).toEqual([
      sharedChannelOperations.shareChatChannel.channel, sharedChannelOperations.listJoinedSharedChannels.channel,
      sharedChannelOperations.listChatChannelShares.channel, sharedChannelOperations.joinSharedChannel.channel,
      sharedChannelOperations.leaveSharedChannel.channel, sharedChannelOperations.dismissShareSkips.channel,
    ]);
    for (const channel of h.handlers.keys()) await expect(h.invoke(channel, null, false)).rejects.toThrow("untrusted");
    expect(h.warm).not.toHaveBeenCalled();
    expect(h.relayListing).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it("answers only requested local channels without waiting for credentials or the relay", async () => {
    const h = await harness();
    await expect(h.invoke(sharedChannelOperations.listJoinedSharedChannels.channel, {
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
    await expect(h.invoke(sharedChannelOperations.listJoinedSharedChannels.channel, { workspaceId: "workspace" })).rejects.toThrow();
  });

  it.each(["credentials", "renderer", "authority"] as const)("rejects a relay listing retired by %s before publishing or caching it", async (reason) => {
    const h = await harness();
    const started = deferred();
    const held = deferred<unknown>();
    h.relayListing.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(sharedChannelOperations.listChatChannelShares.channel, { workspaceId: "workspace", channelWireIds: ["wire-shown"] });
    await started.promise;
    let drained: Promise<void> | undefined;
    if (reason === "credentials") h.rotateCredentials();
    else if (reason === "renderer") h.retireRenderer();
    else drained = h.authorities.invalidate("workspace");
    held.resolve({ received: [{ shareId: "late", selector: { kind: "chat", channelWireId: "late-wire" } }] });
    await expect(result).rejects.toThrow();
    await drained;
    expect(h.peek).not.toHaveBeenCalled();
    expect(h.cache.size).toBe(0);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("leaves a local tombstone and rejects a request for another window's workspace", async () => {
    const h = await harness();
    await h.invoke(sharedChannelOperations.leaveSharedChannel.channel, { workspaceId: "workspace", shareId: "shown" });
    expect(h.workspace.sharedChannels).toEqual([{ ...joined("shown"), ended: true, left: true }, joined("history")]);
    expect(h.other.sharedChannels).toEqual([joined("elsewhere")]);
    await expect(h.invoke(sharedChannelOperations.leaveSharedChannel.channel, { workspaceId: "other", shareId: "elsewhere" })).rejects.toThrow("changed workspaces");
    expect(h.write).toHaveBeenCalledOnce();
    expect(h.relayListing).not.toHaveBeenCalled();
  });

  it("unmounts a group on leave, leaves plain channels alone, and preserves leave on failure", async () => {
    const h = await harness();
    h.workspace.shareMounts = [{
      shareId: "shown", label: "team", granterEmail: "owner@example.test", relayUrl: credentials.relayUrl!,
      grantedSelector: { paths: ["team"], versionId: null, access: "view" },
    }];
    await h.invoke(sharedChannelOperations.leaveSharedChannel.channel, { workspaceId: "workspace", shareId: "shown" });
    expect(h.unmount).toHaveBeenCalledWith({
      workspace: expect.objectContaining({ workspaceId: "workspace" }), shareId: "shown", assertCurrent: expect.any(Function),
    });
    await h.invoke(sharedChannelOperations.leaveSharedChannel.channel, { workspaceId: "workspace", shareId: "history" });
    expect(h.unmount).toHaveBeenCalledOnce();
    h.unmount.mockRejectedValueOnce(new Error("disk busy"));
    await expect(h.invoke(sharedChannelOperations.leaveSharedChannel.channel, { workspaceId: "workspace", shareId: "shown" }))
      .rejects.toThrow("Left the group, but its folder could not be removed. disk busy");
    expect(h.workspace.sharedChannels?.find(row => row.shareId === "shown")?.ended).toBe(true);
    // The unmount can resolve with the folder still on disk; that is reported
    // the same way, and the leave still stands.
    h.unmount.mockResolvedValueOnce({ folderLeft: true });
    await expect(h.invoke(sharedChannelOperations.leaveSharedChannel.channel, { workspaceId: "workspace", shareId: "shown" }))
      .rejects.toThrow("Left the group. Its folder is still in shared-with-me/");
  });

  it("does not cache an invitation kind returned after the account changes", async () => {
    const h = await harness();
    h.relayListing.mockResolvedValue({ received: [{
      shareId: "late", selector: { kind: "chat", channelWireId: "late-wire" },
    }] });
    const started = deferred();
    const held = deferred<"not-dm">();
    h.peek.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(sharedChannelOperations.listChatChannelShares.channel, { workspaceId: "workspace", channelWireIds: [] });
    await started.promise;
    h.rotateCredentials();
    held.resolve("not-dm");
    await expect(result).rejects.toThrow("session changed");
    expect(h.cache.size).toBe(0);
  });

  // The listing is applied to this machine's records before the joined lane
  // is answered, so a row the owner restored answers as live in the same
  // read. Its removed lane rides with the relay answer.
  it("applies the listing to the registry before answering the joined lane, and carries the removed lane", async () => {
    const h = await harness();
    h.workspace.sharedChannels = [joined("shown"), { ...joined("gone"), ended: true }];
    const listing = {
      granted: [], received: [],
      removed: [{ shareId: "gone", grantId: "grant", message: "The owner removed your access.", removedAtMs: 5 }],
    };
    h.relayListing.mockResolvedValue(listing);
    h.reconcileReceivedShares.mockImplementation(async () => {
      // What main's reconcile does when the listing says the share is back.
      h.workspace.sharedChannels = h.workspace.sharedChannels!.map((row) =>
        row.shareId === "gone" ? { ...row, ended: false } : row,
      );
    });
    const result = await h.invoke(sharedChannelOperations.listChatChannelShares.channel, {
      workspaceId: "workspace", channelWireIds: ["wire-gone"],
    }) as { joined: Array<{ joined: { ended: boolean } | null }>; relay: { state: string; removed?: string[] } };
    expect(h.reconcileReceivedShares).toHaveBeenCalledWith(listing);
    expect(result.relay).toMatchObject({ state: "answered", removed: ["gone"] });
    expect(result.joined).toEqual([{ channelWireId: "wire-gone", joined: expect.objectContaining({ ended: false }) }]);
  });

  it("waits for exact-share reconciliation before reading joined answers", async () => {
    const h = await harness(), started = deferred(), reconciled = deferred();
    h.workspace.sharedChannels = [{ ...joined("gone"), ended: true }];
    h.reconcileReceivedShares.mockImplementation(async () => {
      started.resolve();
      await reconciled.promise;
      h.workspace.sharedChannels = [joined("gone")];
    });
    let answered = false;
    const pending = h.invoke(sharedChannelOperations.listChatChannelShares.channel, {
      workspaceId: "workspace", channelWireIds: ["wire-gone"],
    }).then(result => { answered = true; return result; });
    await started.promise;
    expect(answered).toBe(false);
    reconciled.resolve();
    expect(await pending).toMatchObject({ joined: [{ joined: { ended: false } }] });
  });

  it("refuses joined answers when credentials change during reconciliation", async () => {
    const h = await harness(), started = deferred(), reconciled = deferred();
    h.reconcileReceivedShares.mockImplementation(() => { started.resolve(); return reconciled.promise; });
    const pending = h.invoke(sharedChannelOperations.listChatChannelShares.channel, {
      workspaceId: "workspace", channelWireIds: ["wire-shown"],
    });
    await started.promise;
    h.rotateCredentials();
    reconciled.resolve();
    await expect(pending).rejects.toThrow("session changed");
  });

  it("shares a channel's folder with it, as one group grant", async () => {
    const h = await harness();
    h.store.listChannels.mockResolvedValue([channel({ folderPath: "team" }), channel({ id: "bare", name: "Bare", slug: "bare" })]);
    h.store.getChannelWireId.mockImplementation(async ({ channelId }) => channelId === "chan" ? "wire-team" : "wire-bare");
    h.relayListing.mockResolvedValue({ shareId: "share-team" });
    await expect(h.invoke(sharedChannelOperations.shareChatChannel.channel, {
      workspaceId: "workspace", channelId: "chan", recipientEmail: "ana@example.test", access: "read-only",
    })).resolves.toEqual({ shareId: "share-team" });
    await h.invoke(sharedChannelOperations.shareChatChannel.channel, {
      workspaceId: "workspace", channelId: "bare", recipientEmail: "ana@example.test",
    });
    expect(h.relayCalls.map((call) => JSON.parse(String(call.init?.body)))).toEqual([
      { recipientEmail: "ana@example.test", channelWireId: "wire-team", paths: ["team"], access: "read-only" },
      { recipientEmail: "ana@example.test", channelWireId: "wire-bare" },
    ]);
    // The group's channel must already be on the relay, so the share pushes
    // first; a chat-only share leaves that to the next sync pass.
    expect(h.push).toHaveBeenCalledOnce();
    // Each new grant refreshes the workspace's share roster.
    expect(h.sharesChanged.mock.calls).toEqual([["workspace"], ["workspace"]]);
  });

  it("claims a missing identity and pushes again before sharing a group", async () => {
    const h = await harness();
    h.store.listChannels.mockResolvedValue([channel({ folderPath: "team" })]);
    h.store.getChannelWireId.mockResolvedValue("wire-team");
    h.push.mockRejectedValueOnce(new RelayIdentityMissingError());
    h.claim.mockImplementationOnce(async () => {
      expect(h.push).toHaveBeenCalledOnce();
      expect(h.relayCalls).toHaveLength(0);
    });
    h.push.mockImplementationOnce(async () => {
      expect(h.claim).toHaveBeenCalledOnce();
      expect(h.relayCalls).toHaveLength(0);
    });
    h.relayListing.mockResolvedValue({ shareId: "share-team" });

    await expect(h.invoke(sharedChannelOperations.shareChatChannel.channel, {
      workspaceId: "workspace", channelId: "chan", recipientEmail: "ana@example.test",
    })).resolves.toEqual({ shareId: "share-team" });
    expect(h.push).toHaveBeenCalledTimes(2);
    expect(h.claim).toHaveBeenCalledOnce();
    expect(h.relayCalls).toHaveLength(1);
    expect(h.sharesChanged).toHaveBeenCalledWith("workspace");
  });

  it("surfaces the sync claim refusal without sharing the group", async () => {
    const h = await harness();
    h.store.listChannels.mockResolvedValue([channel({ folderPath: "team" })]);
    h.store.getChannelWireId.mockResolvedValue("wire-team");
    h.push.mockRejectedValueOnce(new RelayIdentityMissingError());
    const refusal = new RelayClaimRefusedError(
      "Sync stopped. Another account already claimed this workspace. Sign in with that account and try again.",
    );
    h.claim.mockRejectedValueOnce(refusal);

    await expect(h.invoke(sharedChannelOperations.shareChatChannel.channel, {
      workspaceId: "workspace", channelId: "chan", recipientEmail: "ana@example.test",
    })).rejects.toThrow(refusal);
    expect(h.push).toHaveBeenCalledOnce();
    expect(h.claim).toHaveBeenCalledOnce();
    expect(h.relayCalls).toHaveLength(0);
    expect(h.sharesChanged).not.toHaveBeenCalled();
  });

  it("a session change before the share runs stops a plain channel share too", async () => {
    const h = await harness();
    h.store.listChannels.mockResolvedValue([channel({ id: "bare", name: "Bare", slug: "bare" })]);
    h.store.getChannelWireId.mockResolvedValue("wire-bare");
    h.rotateAfterLookup.value = true;
    await expect(h.invoke(sharedChannelOperations.shareChatChannel.channel, {
      workspaceId: "workspace", channelId: "bare", recipientEmail: "ana@example.test",
    })).rejects.toThrow("session changed");
    expect(h.relayCalls).toHaveLength(0);
    expect(h.sharesChanged).not.toHaveBeenCalled();
  });

  it("a session change during the pre-share push stops the share before the relay hears of it", async () => {
    const h = await harness();
    h.store.listChannels.mockResolvedValue([channel({ folderPath: "team" })]);
    h.store.getChannelWireId.mockResolvedValue("wire-team");
    h.push.mockImplementationOnce(async () => { h.rotateCredentials(); });
    await expect(h.invoke(sharedChannelOperations.shareChatChannel.channel, {
      workspaceId: "workspace", channelId: "chan", recipientEmail: "ana@example.test",
    })).rejects.toThrow("session changed");
    expect(h.relayCalls).toHaveLength(0);
  });

  it("joining a group joins its channel and then mounts its folder", async () => {
    const h = await harness();
    const info = {
      shareId: "share-g", granterUserId: "owner", granterEmail: "owner@example.test",
      channelWireId: "wire-g", access: "read-write" as const, createdAtMs: 1,
    };
    vi.mocked(fetchSharedChannelInfo).mockResolvedValueOnce({ ...info, kind: "group" });
    h.store.listChannels.mockResolvedValue([channel({ id: "wire-g", name: "Launch team" })]);
    await expect(h.invoke(sharedChannelOperations.joinSharedChannel.channel, { workspaceId: "workspace", shareId: "share-g" }))
      .resolves.toEqual({ joined: {
        shareId: "share-g", channelWireId: "wire-g", access: "read-write",
        granterEmail: "owner@example.test", ended: false,
      } });
    expect(h.write).toHaveBeenCalledOnce();
    expect(h.mount).toHaveBeenCalledWith({
      workspace: expect.objectContaining({ workspaceId: "workspace" }),
      shareId: "share-g", relayUrl: "https://relay.test", labelHint: "Launch team", assertCurrent: expect.any(Function),
    });
    // A plain channel has no folder to mount.
    vi.mocked(fetchSharedChannelInfo).mockResolvedValueOnce({ ...info, shareId: "share-c", channelWireId: "wire-c", kind: "chat" });
    await h.invoke(sharedChannelOperations.joinSharedChannel.channel, { workspaceId: "workspace", shareId: "share-c" });
    expect(h.mount).toHaveBeenCalledOnce();
    // The folder failing leaves the channel joined and names the failure.
    vi.mocked(fetchSharedChannelInfo).mockResolvedValueOnce({ ...info, shareId: "share-h", channelWireId: "wire-h", kind: "group" });
    h.mount.mockRejectedValueOnce(new Error("disk full"));
    await expect(h.invoke(sharedChannelOperations.joinSharedChannel.channel, { workspaceId: "workspace", shareId: "share-h" }))
      .rejects.toThrow("Joined the group's chat, but its folder could not be added. disk full");
    expect(h.workspace.sharedChannels?.some((row) => row.shareId === "share-h")).toBe(true);
  });

  it("keeps a leave that lands while a join's row waits on the folder record", async () => {
    const h = await harness();
    vi.mocked(fetchSharedChannelInfo).mockResolvedValueOnce({
      shareId: "share-c", granterUserId: "owner", granterEmail: "owner@example.test",
      channelWireId: "wire-c", access: "read-write", createdAtMs: 1, kind: "chat",
    });
    const waiting = deferred();
    const recorded = deferred();
    h.write.mockImplementationOnce(async (_workspaceId, update) => {
      waiting.resolve();
      await recorded.promise;
      h.workspace.sharedChannels = [...update(h.workspace.sharedChannels ?? [])];
    });
    const joining = h.invoke(sharedChannelOperations.joinSharedChannel.channel, { workspaceId: "workspace", shareId: "share-c" });
    await waiting.promise;
    await h.invoke(sharedChannelOperations.leaveSharedChannel.channel, { workspaceId: "workspace", shareId: "shown" });
    expect(h.pull).not.toHaveBeenCalled();
    recorded.resolve();
    await joining;
    expect(h.workspace.sharedChannels).toEqual([
      { ...joined("shown"), ended: true, left: true },
      joined("history"),
      expect.objectContaining({ shareId: "share-c", channelWireId: "wire-c" }),
    ]);
    expect(h.pull).toHaveBeenCalledOnce();
  });

  it("neither joins nor pulls when the folder cannot record the received chat", async () => {
    const h = await harness();
    vi.mocked(fetchSharedChannelInfo).mockResolvedValueOnce({
      shareId: "share-c", granterUserId: "owner", granterEmail: "owner@example.test",
      channelWireId: "wire-c", access: "read-write", createdAtMs: 1, kind: "group",
    });
    const before = h.workspace.sharedChannels;
    h.write.mockRejectedValueOnce(new Error("EPERM: operation not permitted, rename"));
    await expect(h.invoke(sharedChannelOperations.joinSharedChannel.channel, { workspaceId: "workspace", shareId: "share-c" }))
      .rejects.toThrow("EPERM");
    expect(h.workspace.sharedChannels).toBe(before);
    expect(h.pull).not.toHaveBeenCalled();
    expect(h.mount).not.toHaveBeenCalled();
  });

  it("keeps the shared DM helpers bound to the same live registry holders", async () => {
    const h = await harness();
    expect(() => h.helpers.assertShareNotHeldElsewhere("elsewhere", "workspace")).toThrow("already lives in other");
    expect(() => h.helpers.assertShareNotHeldElsewhere("new-grant", "workspace", "wire-elsewhere")).toThrow("already lives in other");
    h.other.sharedChannels = [{ ...joined("elsewhere"), ended: true }];
    expect(() => h.helpers.assertShareNotHeldElsewhere("elsewhere", "workspace", "wire-elsewhere")).not.toThrow();
  });
});

// Acceptance: the joined-lane response size must be independent of how
// many channels the account has ever joined. A source-text pin cannot observe
// a response size, so this drives the real handler — parse, scope, and the
// contract parse the answer actually crosses IPC through.
describe("joined Group operation", () => {
  // The registry as main holds it: one row per channel ever joined, most of
  // them tombstones from channels the workspace has left.
  function registry(size: number) {
    return Array.from({ length: size }, (_, index) => ({
      shareId: `share-${index}`,
      channelWireId: `wire-${index}`,
      access: "read-write" as const,
      granterEmail: null,
      ended: index % 2 === 0,
    }));
  }

  async function handlerOver(rows: ReturnType<typeof registry>) {
    const h = await harness("ws-1");
    h.workspace.sharedChannels = rows.map(row => ({
      ...row, relayUrl: "http://relay.test", recipientUserId: "member-1",
    }));
    return async (event: { trusted: boolean; activeWorkspaceId?: string }, payload: unknown) => {
      if (event.activeWorkspaceId !== undefined && event.activeWorkspaceId !== "ws-1") h.retireRenderer();
      return await h.invoke(sharedChannelOperations.listJoinedSharedChannels.channel, payload, event.trusted) as ListJoinedSharedChannelsResult;
    };
  }

  // The mutation test at the layer that crosses IPC. Make the handler answer
  // from the full registry and this fails on the response size.
  it("answers a small named scope out of a huge registry, at the size of the scope", async () => {
    const shown = ["wire-3", "wire-7", "wire-9"];
    const answered = [];
    for (const size of [10, 1_000, 20_000]) {
      const result = await (await handlerOver(registry(size)))(
        { trusted: true },
        { workspaceId: "ws-1", channelWireIds: shown },
      );
      expect(result.joined).toHaveLength(shown.length);
      expect(result.joined.map((answer) => answer.channelWireId)).toEqual(shown);
      answered.push(result.joined);
      // The serialized payload is what actually crosses IPC, and it does not
      // grow with the registry either.
      expect(JSON.stringify(result).length).toBeLessThan(1_000);
    }
    expect(answered[1]).toEqual(answered[0]);
    expect(answered[2]).toEqual(answered[0]);
  });

  it("names a channel it holds no row for, rather than omitting it", async () => {
    const result = await (await handlerOver(registry(4)))(
      { trusted: true },
      { workspaceId: "ws-1", channelWireIds: ["wire-1", "wire-local"] },
    );
    expect(result.joined).toEqual([
      {
        channelWireId: "wire-1",
        joined: {
          shareId: "share-1",
          channelWireId: "wire-1",
          access: "read-write",
          granterEmail: null,
          ended: false,
        },
      },
      { channelWireId: "wire-local", joined: null },
    ]);
  });

  it("refuses a payload workspace that is not active in the renderer", async () => {
    const handler = await handlerOver(registry(4));

    await expect(
      handler(
        { trusted: true, activeWorkspaceId: "ws-2" },
        { workspaceId: "ws-1", channelWireIds: ["wire-1"] },
      ),
    ).rejects.toThrow("changed workspaces");
  });

  it("refuses an untrusted sender before it reads anything", async () => {
    const h = await harness("ws-1");
    Object.defineProperty(h.workspace, "sharedChannels", { get() { throw new Error("must not read"); } });
    const handler = (event: { trusted: boolean }, payload: unknown) =>
      h.invoke(sharedChannelOperations.listJoinedSharedChannels.channel, payload, event.trusted);
    await expect(
      handler({ trusted: false }, { workspaceId: "ws-1", channelWireIds: [] }),
    ).rejects.toThrow("untrusted");
  });
});
