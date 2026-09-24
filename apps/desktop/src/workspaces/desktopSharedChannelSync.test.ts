import { describe, expect, it, vi } from "vitest";
import { createDesktopSharedChannelSync } from "./desktopSharedChannelSync";
import { createWorkspaceAuthorityOwner, type WorkspaceAuthorityOperation } from "./workspaceAuthorityOwner";
import type { CloudCredentials } from "./cloudCredentialStore";
import type { JoinedSharedChannel, RegistryEntry } from "./registryStore";
import { SharedChannelReadOnlyError } from "@dohc/workspace-contracts/relay";
import { SHARED_CHANNEL_SYNC_PASS_ROWS } from "./sharedChannels";
import { deferred } from "../testing/deferred";

const credentials: CloudCredentials = {
  serverUrl: "https://account.test", relayUrl: "https://relay.test",
  token: "token", userId: "member", email: "member@test.example",
};

function joined(id: string, overrides: Partial<JoinedSharedChannel> = {}): JoinedSharedChannel {
  return {
    shareId: id, channelWireId: `wire-${id}`, access: "read-only",
    granterEmail: "owner@test.example", relayUrl: credentials.relayUrl!,
    recipientUserId: credentials.userId, ...overrides,
  };
}

function harness(rows: JoinedSharedChannel[]) {
  const workspace: RegistryEntry = {
    workspaceId: "workspace", rootPath: "/workspace", kind: "personal",
    mode: "local-first", sharedChannels: rows,
  };
  const state = { operationLanes: new Map<string, Promise<void>>(), sharedChannelSyncCursor: null as string | null };
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: () => workspace,
    canonicalizeRoot: (root: string) => root,
    createState: () => state,
  });
  type Operation = WorkspaceAuthorityOperation<RegistryEntry, typeof state>;
  let generation = 1;
  let currentCredentials: CloudCredentials | null = credentials;
  const warm = vi.fn(async () => undefined);
  const pull = vi.fn(async (_input: { shareId: string; channelWireId: string; onApplied?: () => void }) => ({ fetched: 0, applied: 0, skipped: 0, nextCursor: 0 }));
  const push = vi.fn(async (_input: { shareId: string; channelWireId: string }) => ({ pushed: 0 }));
  const relayForRegistered = vi.fn((_input: {
    workspaceId: string; rootPath: string; attachmentId: symbol;
    relay: { baseUrl: string; token: string };
  }) => ({ pullSharedChannel: pull, pushSharedChannel: push }));
  const write = vi.fn((_workspaceId: string, channels: JoinedSharedChannel[]) => { workspace.sharedChannels = channels; });
  const notify = vi.fn();
  const project = vi.fn(async () => undefined);
  const sync = createDesktopSharedChannelSync<typeof state, Operation>({
    workspaceAuthorities: authorities, findWorkspace: () => workspace,
    warmCredentialCache: warm, currentCredentialGeneration: () => generation,
    currentCredentials: () => currentCredentials, normalizeServerUrl: (url) => url,
    receivedShareEngine: { relayForRegistered }, setWorkspaceSharedChannels: write,
    notifyRenderer: notify, projectPendingChatBookmarksAfterPull: project,
    linkedChatStoreFor: () => ({
      findThreadChannelId: async () => "channel", getChannelWireId: async () => rows[0]?.channelWireId ?? null,
    }),
  });
  const rendererPass = () => authorities.withOperation("workspace", (operation) =>
    sync.syncRendererWorkspaceSharedChannels(operation));
  const rendererPassForChannel = () => authorities.withOperation("workspace", (operation) =>
    sync.syncRendererSharedChannelsForChatTarget(operation, { channelId: "channel" }));
  return {
    workspace, state, authorities, sync, rendererPass, rendererPassForChannel,
    warm, pull, push, relayForRegistered, write, notify, project,
    rotateCredentials: () => { generation += 1; },
    signOut: () => { currentCredentials = null; },
  };
}

describe("desktop shared-channel pass composition", () => {
  it("passes only this account's live rows through the bounded rotation and preserves its priority", async () => {
    const live = Array.from({ length: SHARED_CHANNEL_SYNC_PASS_ROWS + 2 }, (_, index) => joined(`share-${index}`));
    const h = harness([
      joined("foreign", { recipientUserId: "other-account" }),
      joined("ended", { ended: true }), ...live,
    ]);
    const priority = live.at(-1)!;
    const uncovered = await h.sync.syncWorkspaceSharedChannels("workspace", priority.channelWireId);
    expect(h.pull.mock.calls[0]?.[0].shareId).toBe(priority.shareId);
    expect(h.pull.mock.calls.map(([input]) => input.shareId)).not.toContain("foreign");
    expect(h.pull.mock.calls.map(([input]) => input.shareId)).not.toContain("ended");
    expect(h.pull).toHaveBeenCalledTimes(SHARED_CHANNEL_SYNC_PASS_ROWS + 1);
    expect(uncovered).toBe(1);
    expect(h.state.sharedChannelSyncCursor).toBe(live[SHARED_CHANNEL_SYNC_PASS_ROWS - 1]!.channelWireId);
    expect(h.relayForRegistered).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace", rootPath: "/workspace", attachmentId: expect.any(Symbol),
      relay: expect.objectContaining({ token: "token", baseUrl: "https://relay.test" }),
    }));
  });

  it("reports signed-out rows without opening a relay", async () => {
    const h = harness([joined("one"), joined("two")]);
    h.signOut();
    await expect(h.sync.syncWorkspaceSharedChannels("workspace")).resolves.toBe(2);
    expect(h.relayForRegistered).not.toHaveBeenCalled();
  });

  it.each(["credentials", "authority"] as const)("drops a renderer pass retired by %s while a pull waits", async (reason) => {
    const h = harness([joined("one")]);
    const started = deferred();
    const held = deferred<{ fetched: number; applied: number; skipped: number; nextCursor: number }>();
    h.pull.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.rendererPass();
    await started.promise;
    let drained: Promise<void> | undefined;
    if (reason === "credentials") h.rotateCredentials();
    else drained = h.authorities.invalidate("workspace");
    held.resolve({ fetched: 1, applied: 1, skipped: 0, nextCursor: 1 });
    await expect(result).rejects.toThrow();
    await drained;
    expect(h.state.sharedChannelSyncCursor).toBeNull();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.project).not.toHaveBeenCalled();
  });

  it("reports an idle pass without waking the renderer", async () => {
    const h = harness([joined("one", { access: "read-write" })]);
    await expect(h.rendererPassForChannel()).resolves.toEqual({ unrefreshed: 0, changed: false, failed: false });
    expect(h.push).toHaveBeenCalledOnce();
    expect(h.pull).toHaveBeenCalledOnce();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.project).not.toHaveBeenCalled();
  });

  it("reports applied ops and wakes the renderer once", async () => {
    const h = harness([joined("one", { access: "read-write" })]);
    h.push.mockResolvedValueOnce({ pushed: 2 });
    h.pull.mockResolvedValueOnce({ fetched: 1, applied: 1, skipped: 0, nextCursor: 1 });
    await expect(h.rendererPassForChannel()).resolves.toEqual({ unrefreshed: 0, changed: true, failed: false });
    expect(h.notify).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace" });
    expect(h.project).toHaveBeenCalledExactlyOnceWith("workspace");
  });

  it("keeps applied pages when a later page or the work after the rows fails", async () => {
    const h = harness([joined("one")]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.pull.mockImplementationOnce(async (input) => {
      input.onApplied?.();
      throw new Error("ECONNRESET");
    });
    await expect(h.rendererPassForChannel()).resolves.toEqual({ unrefreshed: 1, changed: true, failed: true });
    h.pull.mockResolvedValueOnce({ fetched: 1, applied: 1, skipped: 0, nextCursor: 1 });
    h.project.mockRejectedValueOnce(new Error("projection failed"));
    await expect(h.rendererPassForChannel()).resolves.toEqual({ unrefreshed: 1, changed: true, failed: true });
    expect(h.notify).toHaveBeenCalledTimes(2);
    // Nothing new after the failure: the applied pages were reported already.
    await expect(h.rendererPassForChannel()).resolves.toEqual({ unrefreshed: 0, changed: false, failed: false });
    errorSpy.mockRestore();
  });

  it("keeps registry downgrades and bookmark projection after a current pass", async () => {
    const h = harness([joined("one", { access: "read-write" })]);
    h.push.mockRejectedValue(new SharedChannelReadOnlyError());
    h.pull.mockResolvedValue({ fetched: 1, applied: 1, skipped: 0, nextCursor: 1 });
    await expect(h.rendererPass()).resolves.toBe(0);
    expect(h.workspace.sharedChannels?.[0]?.access).toBe("read-only");
    expect(h.write).toHaveBeenCalledWith("workspace", h.workspace.sharedChannels);
    expect(h.notify).toHaveBeenCalledWith({ workspaceId: "workspace" });
    expect(h.project).toHaveBeenCalledWith("workspace");
  });
});
