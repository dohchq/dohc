import { basename } from "node:path";
import type { ChatBookmark } from "@dohc/workspace-contracts/engine";
import type { DesktopLinkedChatStore } from "./liveLinkedChatStore";
import type { WorkspaceAuthorityLease } from "./workspaceAuthorityOwner";
import { runInWorkspaceAuthorityLane } from "./workspaceAuthorityLane";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { formatChatBookmarkProjection } from "./chatBookmarkProjection";
import {
  archiveChatBookmarkProjection,
  writeChatBookmarkProjection,
} from "./chatBookmarkProjectionWrite";

export interface DesktopChatBookmarkProjectionState {
  bookmarkProjectionPending: boolean;
  bookmarkProjectionRunning: boolean;
}

type BookmarkWorkspace = { workspaceId: string; rootPath: string; attachmentId?: symbol };
type BookmarkCapture = Pick<WorkspaceEngineCapture, "writeGeneratedTextFile" | "archiveGeneratedTextFile">;

export function chatBookmarkDestination(title: string, targetId: string): string {
  const stem = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 70) || "Chat";
  const suffix = targetId.replace(/[^a-z0-9_-]/giu, "").slice(-10) || "saved";
  return `Bookmarks/Chats/${stem}--${suffix}.md`;
}

function chatBookmarkArchiveDestination(bookmark: ChatBookmark): string {
  const name = basename(bookmark.destinationPath).replace(/\.md$/iu, "");
  // The archive generation is durable before projection starts, so this path
  // is unique across save/archive cycles and stable across crash retries.
  return `Bookmarks/Chats/Archived/${name}--g${bookmark.generation}.md`;
}

export function createDesktopChatBookmarks<
  Workspace extends BookmarkWorkspace,
  State extends DesktopChatBookmarkProjectionState & { operationLanes: Map<string, Promise<void>> },
>(dependencies: {
  findWorkspace(workspaceId: string): Workspace | null;
  requireWorkspaceAuthority(workspaceId: string): WorkspaceAuthorityLease<Workspace, State>;
  canonicalWorkspaceFor(lease: WorkspaceAuthorityLease<Workspace, State>): Workspace;
  linkedChatStoreFor(workspace: Workspace): Pick<DesktopLinkedChatStore,
    "findBookmark" | "listThreads" | "listMessages" | "listChannels" |
    "markBookmarkReady" | "markBookmarkFailed" | "listPendingBookmarks" | "archiveBookmark">;
  warmCredentialCache(): Promise<void>;
  localUserId(): string;
  sharedViewOf(workspaceId: string): unknown;
  activity: {
    listOpenWorkspaceIds(): string[];
    engineCaptureFor(workspaceId: string, rootPath?: string): BookmarkCapture | null;
  };
}) {
  const { findWorkspace, requireWorkspaceAuthority, canonicalWorkspaceFor,
    linkedChatStoreFor, warmCredentialCache, localUserId, sharedViewOf, activity } = dependencies;
  type Lease = WorkspaceAuthorityLease<Workspace, State>;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function queueChatBookmarkProjection(workspaceId: string): void {
    if (stopped || !findWorkspace(workspaceId)) return;
    const lease = requireWorkspaceAuthority(workspaceId);
    try {
      lease.state.bookmarkProjectionPending = true;
    } finally {
      lease.release();
    }
  }

  function retryProjection(lease: Lease): void {
    if (stopped) return;
    try {
      lease.assertCurrent();
      lease.state.bookmarkProjectionPending = true;
    } catch {
      // The successor owns a separate queue.
    }
  }

  function acquireWorkspace(workspace: Workspace): Lease {
    const lease = requireWorkspaceAuthority(workspace.workspaceId);
    if (workspace.attachmentId !== undefined && workspace.attachmentId !== lease.binding.attachmentId) {
      lease.release();
      throw new Error("This chat store request belongs to a retired workspace.");
    }
    return lease;
  }

  async function materializeForAuthority(
    workspace: Workspace,
    capture: BookmarkCapture,
    bookmark: ChatBookmark,
    lease: Lease,
  ): Promise<ChatBookmark> {
    return runInWorkspaceAuthorityLane(
      lease,
      `bookmark:${bookmark.bookmarkId}`,
      async () => {
        const store = linkedChatStoreFor(workspace);
        const current = await store.findBookmark({
          workspaceId: workspace.workspaceId,
          ownerUserId: bookmark.ownerUserId,
          bookmarkId: bookmark.bookmarkId,
        });
        if (!current) throw new Error("That bookmark no longer exists.");
        // A duplicate worker, a newer live generation, or an archive may have
        // won while this call waited for the bookmark queue.
        if (
          current.projectionState !== "pending" ||
          current.generation !== bookmark.generation
        ) {
          return current;
        }
        bookmark = current;
        try {
          if (bookmark.state === "archived") {
            const archivedPath = chatBookmarkArchiveDestination(bookmark);
            // Recovery validates the bookmark-specific frontmatter when legacy
            // state or a crash left projectionObjectId unclaimed. It can recover
            // from either side of an already-completed engine rename.
            const archived = await archiveChatBookmarkProjection({
              bookmark,
              archivedPath,
              capture,
            });
            const ready = await store.markBookmarkReady({
              workspaceId: workspace.workspaceId,
              ownerUserId: bookmark.ownerUserId,
              bookmarkId: bookmark.bookmarkId,
              generation: bookmark.generation,
              projectionObjectId: archived.objectId,
              // The store owns the logical active projection path. The capture
              // layer has already moved this exact object to archivedPath.
              projectionPath: bookmark.destinationPath,
            });
            return ready.bookmark;
          }
          const threads = await store.listThreads({
            workspaceId: workspace.workspaceId,
          });
          const thread = threads.find(
            (entry) => entry.id === bookmark.threadId,
          );
          if (!thread) throw new Error("The source chat no longer exists.");
          const allMessages = await store.listMessages({
            workspaceId: workspace.workspaceId,
            threadId: bookmark.threadId,
          });
          let selectedMessages = allMessages;
          if (bookmark.messageId) {
            const selected = allMessages.find(
              (message) => message.id === bookmark.messageId,
            );
            if (!selected)
              throw new Error("The bookmarked message no longer exists.");
            const parent = selected.parentMessageId
              ? allMessages.find(
                  (message) => message.id === selected.parentMessageId,
                )
              : undefined;
            selectedMessages = parent ? [parent, selected] : [selected];
          }
          const channel = thread.channelId
            ? (
                await store.listChannels({ workspaceId: workspace.workspaceId })
              ).find((entry) => entry.id === thread.channelId)
            : undefined;
          const text = formatChatBookmarkProjection({
            bookmarkId: bookmark.bookmarkId,
            threadId: bookmark.threadId,
            ...(bookmark.messageId ? { messageId: bookmark.messageId } : {}),
            ...(channel
              ? { channelId: channel.id, channelName: channel.name }
              : {}),
            title: thread.title,
            mode: bookmark.mode,
            updatedAtMs: Date.now(),
            ...(bookmark.mode === "snapshot"
              ? { snapshotAtMs: bookmark.createdAtMs }
              : {}),
            messages: selectedMessages.map((message) => ({
              id: message.id,
              authorKind: message.author.kind,
              authorDisplayName: message.author.displayName,
              body: message.body,
              createdAtMs: message.createdAtMs,
              ...(message.parentMessageId
                ? { parentMessageId: message.parentMessageId }
                : {}),
            })),
          });
          const written = await writeChatBookmarkProjection({
            bookmark,
            text,
            capture,
          });
          const ready = await store.markBookmarkReady({
            workspaceId: workspace.workspaceId,
            ownerUserId: bookmark.ownerUserId,
            bookmarkId: bookmark.bookmarkId,
            generation: bookmark.generation,
            projectionObjectId: written.objectId,
            projectionPath: bookmark.destinationPath,
          });
          return ready.bookmark;
        } catch (error) {
          const failed = await store.markBookmarkFailed({
            workspaceId: workspace.workspaceId,
            ownerUserId: bookmark.ownerUserId,
            bookmarkId: bookmark.bookmarkId,
            generation: bookmark.generation,
            failureReason:
              error instanceof Error ? error.message : "Projection failed",
          });
          throw new Error(
            failed.bookmark.failureReason ?? "Could not save chat bookmark.",
          );
        }
      },
    );
  }

  async function materializePendingForAuthority(
    workspace: Workspace,
    capture: BookmarkCapture,
    lease: Lease,
  ): Promise<void> {
    // Personal chat state must always use the persisted cloud identity when
    // one exists. The renderer can reach this worker before the eager startup
    // warm completes, so wait here instead of briefly projecting under the
    // per-install signed-out fallback id.
    await warmCredentialCache();
    lease.assertCurrent();
    const store = linkedChatStoreFor(workspace);
    const pending = await store.listPendingBookmarks({
      workspaceId: workspace.workspaceId,
      ownerUserId: localUserId(),
      limit: 50,
    });
    for (const bookmark of pending) {
      await materializeForAuthority(workspace, capture, bookmark, lease).catch(
        (error) => {
          console.error("[desktop] chat bookmark projection:", error);
          // Re-flag so the worker's next tick retries. If markBookmarkFailed
          // itself failed, the row is still pending and this is the only retry
          // path; if it succeeded, the row left listPendingBookmarks and the
          // extra pass finds nothing — no permanent-failure loop.
          retryProjection(lease);
        },
      );
    }
  }

  async function materializeChatBookmark(
    workspace: Workspace, capture: BookmarkCapture, bookmark: ChatBookmark,
  ): Promise<ChatBookmark> {
    const lease = acquireWorkspace(workspace);
    try {
      return await materializeForAuthority(canonicalWorkspaceFor(lease), capture, bookmark, lease);
    } finally {
      lease.release();
    }
  }

  async function archiveChatBookmark(
    workspace: Workspace, capture: BookmarkCapture, ownerUserId: string, bookmarkId: string,
  ): Promise<ChatBookmark> {
    const lease = acquireWorkspace(workspace);
    try {
      workspace = canonicalWorkspaceFor(lease);
      const archived = await runInWorkspaceAuthorityLane(
        lease,
        `bookmark:${bookmarkId}`,
        async () => {
          const store = linkedChatStoreFor(workspace);
          const bookmark = await store.findBookmark({
            workspaceId: workspace.workspaceId,
            ownerUserId,
            bookmarkId,
          });
          if (!bookmark) throw new Error("That bookmark no longer exists.");
          return store.archiveBookmark({
            workspaceId: workspace.workspaceId,
            ownerUserId,
            bookmarkId,
          });
        },
      );
      return await materializeForAuthority(
        workspace,
        capture,
        archived,
        lease,
      );
    } finally {
      lease.release();
    }
  }

  // After a relay pull or a chat message. Shared views ingest relay state
  // without writing personal bookmark files.
  async function projectPendingChatBookmarks(workspaceId: string): Promise<void> {
    if (stopped || sharedViewOf(workspaceId) || !findWorkspace(workspaceId)) return;
    let lease: Lease | null = null;
    try {
      lease = requireWorkspaceAuthority(workspaceId);
      const workspace = canonicalWorkspaceFor(lease);
      const capture = activity.engineCaptureFor(workspaceId, workspace.rootPath);
      if (!capture) return;
      await materializePendingForAuthority(workspace, capture, lease);
      lease.assertCurrent();
    } catch (error) {
      console.error(`[desktop] chat bookmark projection (${workspaceId}):`, error);
      if (lease) retryProjection(lease);
    } finally {
      lease?.release();
    }
  }

  // Live bookmark projections also follow replies arriving from the local
  // agent, CLI, or relay. The engine only marks those projections pending;
  // this small workspace-scoped worker performs the filesystem write through
  // the canonical capture layer. A list/open still materializes immediately.
  // Event-gated (see queueChatBookmarkProjection): every reply path flags
  // its workspace, so the worker idles instead of querying every open
  // workspace unconditionally. The slow cadence is the crash backstop — a
  // failed pass re-flags and retries here.
  function start(): void {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => {
      for (const workspaceId of activity.listOpenWorkspaceIds()) {
        if (!findWorkspace(workspaceId)) continue;
        const lease = requireWorkspaceAuthority(workspaceId);
        const state = lease.state;
        if (!state.bookmarkProjectionPending || state.bookmarkProjectionRunning) {
          lease.release();
          continue;
        }
        const workspace = canonicalWorkspaceFor(lease);
        const capture = activity.engineCaptureFor(workspaceId,
          workspace.rootPath,
        );
        if (!capture || sharedViewOf(workspaceId)) {
          lease.release();
          continue;
        }
        state.bookmarkProjectionPending = false;
        state.bookmarkProjectionRunning = true;
        void materializePendingForAuthority(workspace, capture, lease)
          .then(() => lease.assertCurrent())
          .catch((error) => {
            console.error("[desktop] live chat bookmark projection:", error);
            retryProjection(lease);
          })
          .finally(() => {
            state.bookmarkProjectionRunning = false;
            lease.release();
          });
      }
    }, 30_000);

    timer.unref();
  }

  function stop(): void {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { queueChatBookmarkProjection, materializeChatBookmark, archiveChatBookmark,
    projectPendingChatBookmarks, start, stop };
}
