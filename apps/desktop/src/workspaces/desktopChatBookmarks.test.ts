import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatBookmark, ChatChannelSummary, ChatMessage } from "@dohc/workspace-contracts/engine";
import { deferred } from "../testing/deferred";
import { createDesktopChatBookmarks } from "./desktopChatBookmarks";
import { createWorkspaceAuthorityOwner } from "./workspaceAuthorityOwner";
import type { DesktopLinkedChatStore } from "./liveLinkedChatStore";
import type { WorkspaceEngineCapture, WorkspaceGeneratedTextWriteResult } from "./workspaceEngineCapture";

type Workspace = { workspaceId: string; rootPath: string; attachmentId?: symbol };
type ReadyInput = Parameters<DesktopLinkedChatStore["markBookmarkReady"]>[0];
type FailedInput = Parameters<DesktopLinkedChatStore["markBookmarkFailed"]>[0];
type WriteInput = Parameters<WorkspaceEngineCapture["writeGeneratedTextFile"]>[0];
type ArchiveInput = Parameters<WorkspaceEngineCapture["archiveGeneratedTextFile"]>[0];

function fixture() {
  const workspace: Workspace = { workspaceId: "workspace", rootPath: "root" };
  const bookmark: ChatBookmark = {
    bookmarkId: "bookmark", workspaceId: "workspace", ownerUserId: "owner",
    targetKind: "thread", targetId: "thread", threadId: "thread", mode: "live",
    destinationPath: "Bookmarks/Chats/Chat--thread.md", state: "active",
    generation: 1, projectedGeneration: 0, projectionState: "pending",
    createdAtMs: 100, updatedAtMs: 100,
  };
  let row = { ...bookmark };
  const messages: ChatMessage[] = [{
    id: "message", workspaceId: "workspace", threadId: "thread",
    author: { kind: "human", displayName: "Ice" }, body: "Keep this reply",
    createdAtMs: 100, attachments: [],
  }];
  const store = {
    findBookmark: vi.fn(async () => row as ChatBookmark | null),
    listPendingBookmarks: vi.fn(async () => row.projectionState === "pending" ? [row] : []),
    listThreads: vi.fn(async () => [{
      id: "thread", workspaceId: "workspace", title: "Chat", channelId: "channel",
      createdAtMs: 100, updatedAtMs: 100,
    }]),
    listMessages: vi.fn(async () => messages),
    listChannels: vi.fn(async (): Promise<ChatChannelSummary[]> => [{
      id: "channel", workspaceId: "workspace", name: "General",
      slug: "general", kind: "channel",
      createdAtMs: 100, updatedAtMs: 100,
      threadCount: 1, unreadCount: 0,
    }]),
    markBookmarkReady: vi.fn(async (input: ReadyInput) => {
      row = { ...row, projectionState: "ready", projectedGeneration: input.generation,
        projectionObjectId: input.projectionObjectId };
      return { bookmark: row, applied: true };
    }),
    markBookmarkFailed: vi.fn(async (input: FailedInput) => {
      row = { ...row, projectionState: "failed", failureReason: input.failureReason };
      return { bookmark: row, applied: true };
    }),
    archiveBookmark: vi.fn(async () => {
      row = { ...row, state: "archived", generation: row.generation + 1, projectionState: "pending" };
      return row;
    }),
  };
  const capture = {
    writeGeneratedTextFile: vi.fn(async (input: WriteInput) => ({
      path: input.path, objectId: "projection-object", changed: true,
    })),
    archiveGeneratedTextFile: vi.fn(async (input: ArchiveInput) => ({
      fromPath: input.fromPath, path: input.toPath, objectId: "projection-object", changed: true,
    })),
  };
  const disposed = vi.fn();
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: () => workspace,
    canonicalizeRoot: (root: string) => `canonical:${root}`,
    createState: () => ({
      operationLanes: new Map<string, Promise<void>>(),
      bookmarkProjectionPending: false, bookmarkProjectionRunning: false,
    }),
    disposeState: disposed,
  });
  const warmCredentialCache = vi.fn(async (): Promise<void> => undefined);
  const sharedViewOf = vi.fn(() => false);
  const engineCaptureFor = vi.fn(() => capture);
  const linkedChatStoreFor = vi.fn(() => store);
  const owner = createDesktopChatBookmarks({
    findWorkspace: () => workspace,
    requireWorkspaceAuthority: (id) => authorities.acquire(id),
    canonicalWorkspaceFor: (lease) => {
      lease.assertCurrent();
      return { ...workspace, attachmentId: lease.binding.attachmentId, rootPath: lease.binding.canonicalRootPath };
    },
    linkedChatStoreFor, warmCredentialCache, localUserId: () => "owner", sharedViewOf,
    activity: { listOpenWorkspaceIds: () => [workspace.workspaceId], engineCaptureFor },
  });
  return { owner, authorities, disposed, workspace, bookmark, store, capture, messages,
    warmCredentialCache, sharedViewOf, engineCaptureFor, linkedChatStoreFor,
    state() {
      const lease = authorities.acquire(workspace.workspaceId);
      lease.release();
      return lease.state;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("desktop chat bookmarks", () => {
  it("writes the generated projection before recording its durable object identity", async () => {
    const test = fixture();
    const entered = deferred();
    const write = deferred<WorkspaceGeneratedTextWriteResult>();
    test.capture.writeGeneratedTextFile.mockImplementationOnce((input) => {
      expect(input.recoverExistingText?.(input.text)).toBe(true);
      expect(input.recoverExistingText?.("unowned document")).toBe(false);
      entered.resolve();
      return write.promise;
    });
    const projection = test.owner.materializeChatBookmark(test.workspace, test.capture, test.bookmark);
    await entered.promise;
    expect(test.store.markBookmarkReady).not.toHaveBeenCalled();
    const input = test.capture.writeGeneratedTextFile.mock.calls[0]![0];
    expect(input.text).toContain("Keep this reply");
    expect(input.text).toContain('source_channel_id: "channel"');
    write.resolve({ path: input.path, objectId: "durable-id", changed: true });
    await expect(projection).resolves.toMatchObject({ projectionState: "ready", projectionObjectId: "durable-id" });
    expect(test.store.markBookmarkReady).toHaveBeenCalledWith({
      workspaceId: "workspace", ownerUserId: "owner", bookmarkId: "bookmark",
      generation: 1, projectionObjectId: "durable-id", projectionPath: test.bookmark.destinationPath,
    });
  });

  it("serializes duplicate projections and archives on the same bookmark lane", async () => {
    const test = fixture();
    const entered = deferred();
    const write = deferred<WorkspaceGeneratedTextWriteResult>();
    test.capture.writeGeneratedTextFile.mockImplementationOnce(() => {
      entered.resolve();
      return write.promise;
    });
    const first = test.owner.materializeChatBookmark(test.workspace, test.capture, test.bookmark);
    await entered.promise;
    const duplicate = test.owner.materializeChatBookmark(test.workspace, test.capture, test.bookmark);
    const archived = test.owner.archiveChatBookmark(test.workspace, test.capture, "owner", "bookmark");
    expect(test.store.archiveBookmark).not.toHaveBeenCalled();
    expect(test.store.findBookmark).toHaveBeenCalledTimes(1);
    write.resolve({ path: test.bookmark.destinationPath, objectId: "projection-object", changed: true });
    await Promise.all([first, duplicate, archived]);
    expect(test.capture.writeGeneratedTextFile).toHaveBeenCalledTimes(1);
    expect(test.capture.archiveGeneratedTextFile).toHaveBeenCalledWith({
      fromPath: test.bookmark.destinationPath,
      toPath: "Bookmarks/Chats/Archived/Chat--thread--g2.md", expectedObjectId: "projection-object",
    });
    expect(test.store.markBookmarkReady).toHaveBeenLastCalledWith({
      workspaceId: "workspace", ownerUserId: "owner", bookmarkId: "bookmark",
      generation: 2, projectionObjectId: "projection-object", projectionPath: test.bookmark.destinationPath,
    });
    expect(test.state().operationLanes.size).toBe(0);
  });

  it("waits for the persisted identity before querying pending bookmarks after a relay pull", async () => {
    const test = fixture();
    const credentials = deferred();
    test.warmCredentialCache.mockReturnValueOnce(credentials.promise);
    const pull = test.owner.projectPendingChatBookmarksAfterPull("workspace");
    expect(test.store.listPendingBookmarks).not.toHaveBeenCalled();
    credentials.resolve();
    await pull;
    expect(test.store.listPendingBookmarks).toHaveBeenCalledWith({ workspaceId: "workspace", ownerUserId: "owner", limit: 50 });
    expect(test.engineCaptureFor).toHaveBeenCalledWith("workspace", "canonical:root");
    expect(test.capture.writeGeneratedTextFile).toHaveBeenCalledOnce();
  });

  it("retries a current projection when recording its failure also fails", async () => {
    const test = fixture();
    test.capture.writeGeneratedTextFile.mockRejectedValueOnce(new Error("disk unavailable"));
    test.store.markBookmarkFailed.mockRejectedValueOnce(new Error("store unavailable"));
    test.owner.start();
    test.owner.queueChatBookmarkProjection("workspace");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.state().bookmarkProjectionPending).toBe(true);
    expect(test.state().bookmarkProjectionRunning).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.capture.writeGeneratedTextFile).toHaveBeenCalledTimes(2);
    expect(test.store.markBookmarkReady).toHaveBeenCalledOnce();
    expect(test.state().bookmarkProjectionPending).toBe(false);
    test.owner.stop();
  });

  it("does not loop permanently after the store records a failed projection", async () => {
    const test = fixture();
    test.capture.writeGeneratedTextFile.mockRejectedValueOnce(new Error("destination occupied"));
    test.owner.start();
    test.owner.queueChatBookmarkProjection("workspace");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(test.store.listPendingBookmarks).toHaveBeenCalledTimes(2);
    expect(test.capture.writeGeneratedTextFile).toHaveBeenCalledOnce();
    expect(test.store.markBookmarkFailed).toHaveBeenCalledWith(expect.objectContaining({ failureReason: "destination occupied" }));
    expect(test.state().bookmarkProjectionPending).toBe(false);
    test.owner.stop();
  });

  it("idles without events, avoids overlapping passes, and retains a reply queued during a pass", async () => {
    const test = fixture();
    const credentials = deferred();
    test.owner.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.warmCredentialCache).not.toHaveBeenCalled();
    test.warmCredentialCache.mockReturnValueOnce(credentials.promise);
    test.owner.queueChatBookmarkProjection("workspace");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.state().bookmarkProjectionRunning).toBe(true);
    test.owner.queueChatBookmarkProjection("workspace");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.warmCredentialCache).toHaveBeenCalledOnce();
    credentials.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.state().bookmarkProjectionPending).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.store.listPendingBookmarks).toHaveBeenCalledTimes(2);
    expect(test.capture.writeGeneratedTextFile).toHaveBeenCalledOnce();
    test.owner.stop();
  });

  it("retries a failed relay pending-list read on the timer", async () => {
    const test = fixture();
    test.store.listPendingBookmarks.mockRejectedValueOnce(new Error("store unavailable"));
    await test.owner.projectPendingChatBookmarksAfterPull("workspace");
    expect(test.state().bookmarkProjectionPending).toBe(true);
    test.owner.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.capture.writeGeneratedTextFile).toHaveBeenCalledOnce();
    expect(test.state().bookmarkProjectionPending).toBe(false);
    test.owner.stop();
  });

  it("keeps a held projection's retry and queued work out of its successor", async () => {
    const test = fixture();
    const entered = deferred();
    const write = deferred<WorkspaceGeneratedTextWriteResult>();
    test.capture.writeGeneratedTextFile.mockImplementationOnce(() => {
      entered.resolve();
      return write.promise;
    });
    test.store.markBookmarkFailed.mockRejectedValueOnce(new Error("retired store"));
    const oldState = test.state();
    const projection = test.owner.materializePendingChatBookmarks(test.workspace, test.capture);
    await entered.promise;
    const queued = test.owner.materializeChatBookmark(test.workspace, test.capture, test.bookmark);
    const queuedResult = expect(queued).rejects.toThrow("retired workspace authority");
    const retired = test.authorities.invalidate("workspace");
    expect(test.disposed).not.toHaveBeenCalled();
    expect(() => test.authorities.acquire("workspace")).toThrow("retiring or blocked");
    write.reject(new Error("retired capture"));
    await Promise.all([projection, queuedResult, retired]);
    expect(test.disposed).toHaveBeenCalledOnce();
    expect(oldState.bookmarkProjectionPending).toBe(false);
    expect(test.store.findBookmark).toHaveBeenCalledOnce();
    const successorState = test.state();
    expect(successorState).not.toBe(oldState);
    expect(successorState.bookmarkProjectionPending).toBe(false);
    test.owner.queueChatBookmarkProjection("workspace");
    test.owner.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.capture.writeGeneratedTextFile).toHaveBeenCalledTimes(2);
    expect(test.store.markBookmarkReady).toHaveBeenCalledOnce();
    test.owner.stop();
  });

  it("does not select a successor store when credentials settle after retirement", async () => {
    const test = fixture();
    const credentials = deferred();
    test.warmCredentialCache.mockReturnValueOnce(credentials.promise);
    const pull = test.owner.projectPendingChatBookmarksAfterPull("workspace");
    const retired = test.authorities.invalidate("workspace");
    credentials.resolve();
    await Promise.all([pull, retired]);
    expect(test.linkedChatStoreFor).not.toHaveBeenCalled();
    expect(test.state().bookmarkProjectionPending).toBe(false);
  });

  it("excludes shared views from relay, direct pending, and timer projections", async () => {
    const test = fixture();
    test.sharedViewOf.mockReturnValue(true);
    test.owner.start();
    test.owner.queueChatBookmarkProjection("workspace");
    await test.owner.projectPendingChatBookmarksAfterPull("workspace");
    await test.owner.materializePendingChatBookmarks(test.workspace, test.capture);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.store.listPendingBookmarks).not.toHaveBeenCalled();
    expect(test.capture.writeGeneratedTextFile).not.toHaveBeenCalled();
    expect(test.warmCredentialCache).not.toHaveBeenCalled();
    test.owner.stop();
  });

  it("starts one timer and stops producers while a projection drains for shutdown", async () => {
    const test = fixture();
    const entered = deferred();
    const write = deferred<WorkspaceGeneratedTextWriteResult>();
    test.capture.writeGeneratedTextFile.mockImplementationOnce(() => {
      entered.resolve();
      return write.promise;
    });
    test.owner.start();
    test.owner.start();
    expect(vi.getTimerCount()).toBe(1);
    test.owner.queueChatBookmarkProjection("workspace");
    await vi.advanceTimersByTimeAsync(30_000);
    await entered.promise;
    const state = test.state();
    test.owner.stop();
    expect(vi.getTimerCount()).toBe(0);
    const closed = test.authorities.close();
    expect(test.disposed).not.toHaveBeenCalled();
    await test.owner.projectPendingChatBookmarksAfterPull("workspace");
    test.owner.queueChatBookmarkProjection("workspace");
    write.resolve({ path: test.bookmark.destinationPath, objectId: "projection-object", changed: true });
    await closed;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(test.capture.writeGeneratedTextFile).toHaveBeenCalledOnce();
    expect(state.bookmarkProjectionRunning).toBe(false);
    expect(state.bookmarkProjectionPending).toBe(false);
    expect(test.disposed).toHaveBeenCalledOnce();
  });
});
