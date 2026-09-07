import { describe, expect, it, vi } from "vitest";
import { deferred } from "../../testing/deferred";
import { resolveCanonicalDm, runCanonicalDmNavigation } from "./canonicalDmNavigation";
import { chatMentionOpenTarget, graphChatOpenTarget } from "./chatOpenTarget";
import { chatsNavigationRequiresRemount } from "./chatsNav";

describe("targeted chat navigation", () => {
  it("routes DM mentions and graph nodes only through a matching canonical DM", () => {
    const dm = {
      channelId: "dm-local",
      channelWireId: "dm-wire",
      name: "alice@example.com",
      peerLabel: "Alice",
      role: "owner" as const,
      shareId: null,
      threadId: "dm-thread",
      unreadCount: 1,
      connected: true,
    };
    const mentionTarget = chatMentionOpenTarget({
      attachment: {
        attachmentId: "attachment-dm",
        messageId: "message-dm",
        threadId: "dm-thread",
        targetKind: "file",
        createdAtMs: 0,
      },
      message: {
        id: "message-dm",
        threadId: "dm-thread",
        authorKind: "human",
        authorDisplayName: "Alice",
        body: "DM attachment",
        createdAtMs: 0,
      },
      thread: {
        id: "dm-thread",
        title: "Direct message",
        createdAtMs: 0,
        updatedAtMs: 0,
      },
      channelId: "dm-local",
      channelWireId: "dm-wire",
      channelName: "alice@example.com",
      channelKind: "dm",
    });
    expect(mentionTarget).toEqual({
      surface: "dm",
      channelId: "dm-local",
      channelWireId: "dm-wire",
      threadId: "dm-thread",
      focusMessageId: "message-dm",
    });
    if (mentionTarget.surface !== "dm") throw new Error("Expected DM target");
    expect(resolveCanonicalDm(mentionTarget, [dm])).toEqual(dm);
    expect(resolveCanonicalDm({ ...mentionTarget, threadId: "other-thread" }, [dm]))
      .toBeNull();
    expect(resolveCanonicalDm({ ...mentionTarget, channelWireId: "other-wire" }, [dm]))
      .toBeNull();

    expect(graphChatOpenTarget({
      path: "chat-thread:dm-thread",
      kind: "chat-thread",
      threadId: "dm-thread",
      channelId: "dm-local",
      channelWireId: "dm-wire",
      channelName: "alice@example.com",
      channelKind: "dm",
      title: "Direct message",
      incoming: 1,
      outgoing: 0,
    })).toEqual({
      surface: "dm",
      channelId: "dm-local",
      channelWireId: "dm-wire",
      threadId: "dm-thread",
    });
  });

  it("preserves a DM mention message target through canonical navigation", async () => {
    const dm = {
      channelId: "dm-local",
      channelWireId: "dm-wire",
      name: "alice@example.com",
      peerLabel: "Alice",
      role: "owner" as const,
      shareId: null,
      threadId: "dm-thread",
      unreadCount: 0,
      connected: true,
    };
    const open = vi.fn();

    await runCanonicalDmNavigation({
      locator: {
        channelId: dm.channelId,
        channelWireId: dm.channelWireId,
        threadId: dm.threadId,
        focusMessageId: "message-dm",
      },
      syncDms: async () => ({ available: true, dms: [dm] }),
      isCurrent: () => true,
      open,
    });

    expect(open).toHaveBeenCalledWith({
      level: "dm",
      dm,
      focusMessageId: "message-dm",
    });
    expect(
      chatsNavigationRequiresRemount(
        { level: "dm", dm, focusMessageId: "message-old" },
        { level: "dm", dm, focusMessageId: "message-dm" },
      ),
    ).toBe(true);
  });

  it("opens an existing local DM when new-DM creation is unavailable", async () => {
    const dm = {
      channelId: "dm-local",
      channelWireId: "dm-wire",
      name: "alice@example.com",
      peerLabel: "Alice",
      role: "owner" as const,
      shareId: null,
      threadId: "dm-thread",
      unreadCount: 0,
      connected: false,
    };
    const open = vi.fn();

    await runCanonicalDmNavigation({
      locator: {
        channelId: dm.channelId,
        channelWireId: dm.channelWireId,
        threadId: dm.threadId,
      },
      syncDms: async () => ({ available: false, dms: [dm] }),
      isCurrent: () => true,
      open,
    });

    expect(open).toHaveBeenCalledWith({ level: "dm", dm });
  });

  it("does not reopen Chats when destination navigation supersedes a delayed DM lookup", async () => {
    const delayed = deferred<{
      available: boolean;
      dms: Array<{
        channelId: string;
        channelWireId: string;
        name: string;
        peerLabel: string;
        role: "owner";
        shareId: null;
        threadId: string;
        unreadCount: number;
        connected: boolean;
      }>;
    }>();
    let current = true;
    const open = vi.fn();
    const pending = runCanonicalDmNavigation({
      locator: {
        channelId: "dm-local",
        channelWireId: "dm-wire",
        threadId: "dm-thread",
      },
      syncDms: () => delayed.promise,
      isCurrent: () => current,
      open,
    });

    // Models the centralized workbench mutation invalidation used by file,
    // graph, history, and arbitrary editor-tab navigation.
    current = false;
    delayed.resolve({
      available: true,
      dms: [{
        channelId: "dm-local",
        channelWireId: "dm-wire",
        name: "alice@example.com",
        peerLabel: "Alice",
        role: "owner",
        shareId: null,
        threadId: "dm-thread",
        unreadCount: 0,
        connected: true,
      }],
    });
    await pending;
    expect(open).not.toHaveBeenCalled();
  });

  it("clears stale chat navigation to channels when DM canonicalization fails", async () => {
    const open = vi.fn();
    const base = {
      locator: { channelId: "dm-local", threadId: "dm-thread" },
      isCurrent: () => true,
      open,
    };
    await runCanonicalDmNavigation({
      ...base,
      syncDms: async () => ({ available: true, dms: [] }),
    });
    expect(open).toHaveBeenLastCalledWith({ level: "channels" });

    open.mockClear();
    await runCanonicalDmNavigation({
      ...base,
      syncDms: async () => {
        throw new Error("offline");
      },
    });
    expect(open).toHaveBeenLastCalledWith({ level: "channels" });
  });
});
