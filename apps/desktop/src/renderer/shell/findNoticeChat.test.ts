// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findNoticeChannel, findNoticeChat } from "./findNoticeChat";
import { workLinkTarget } from "../../notices/noticeTarget";

const group = { id: "group-1", name: "trip", slug: "trip", kind: "channel" as const, type: "both" as const,
  createdAtMs: 0, updatedAtMs: 0, threadCount: 2, unreadCount: 0 };
const otherGroup = { ...group, id: "group-2", name: "food", slug: "food" };
const dm = { id: "dm-1", name: "sam@example.com", slug: "dm-1", kind: "dm" as const,
  createdAtMs: 0, updatedAtMs: 0, threadCount: 1, unreadCount: 0 };
const fileThread = { id: "file-thread", title: "plan.md", createdAtMs: 1, updatedAtMs: 2, path: "Trip/plan.md" };
const record = (id: string, channelId: string) => ({ id, channelId, title: id, createdAtMs: 0, updatedAtMs: 0,
  messageCount: 1, lastReadSequence: 0, unreadCount: 0 });

const listChatChannels = vi.fn();
const listChannelThreads = vi.fn();
const syncDms = vi.fn();
beforeEach(() => {
  listChatChannels.mockResolvedValue({ channels: [group, otherGroup, dm], fileThreads: [fileThread] });
  listChannelThreads.mockImplementation(async ({ channelId, lane }: { channelId: string; lane: "chat" | "posts" }) =>
    ({ threads: [record(`${channelId}-${lane}`, channelId)] }));
  vi.stubGlobal("dohcDesktop", { listChatChannels, listChannelThreads, syncDms });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// What main's work link resolution hands the shell, for each kind of thread.
const linkTo = (threadId: string, channelId: string | null) => workLinkTarget({ channelId, threadId, messageId: "m-1" });

describe("where a work link's message opens", () => {
  it("opens a Group's chat lane at the message, reading only that Group", async () => {
    await expect(findNoticeChat("notes", linkTo("group-1-chat", "group-1"))).resolves.toEqual({
      open: "chats", nav: { level: "channel", channel: group, lane: "chat", focusMessageId: "m-1" },
    });
    expect(listChannelThreads.mock.calls.map(([payload]) => payload.channelId)).toEqual(["group-1", "group-1"]);
  });

  it("opens a post as its thread at the message", async () => {
    await expect(findNoticeChat("notes", linkTo("group-2-posts", "group-2"))).resolves.toEqual({
      open: "chats", nav: { level: "thread", channel: otherGroup, thread: record("group-2-posts", "group-2"), focusMessageId: "m-1" },
    });
  });

  it("opens a file's conversation beside its file at the message", async () => {
    await expect(findNoticeChat("notes", linkTo("file-thread", null))).resolves.toEqual({
      open: "file", thread: fileThread, focusMessageId: "m-1",
    });
    expect(listChannelThreads).not.toHaveBeenCalled();
  });

  it("opens a DM through its canonical record at the message", async () => {
    await expect(findNoticeChat("notes", linkTo("dm-thread", "dm-1"))).resolves.toEqual({
      open: "dm", locator: { channelId: "dm-1", threadId: "dm-thread", focusMessageId: "m-1" },
    });
    expect(listChannelThreads).not.toHaveBeenCalled();
  });

  it("finds nothing for a chat this workspace does not list, or a thread its Group does not hold", async () => {
    await expect(findNoticeChat("notes", linkTo("group-1-chat", "group-gone"))).resolves.toBeNull();
    await expect(findNoticeChat("notes", linkTo("group-2-chat", "group-1"))).resolves.toBeNull();
  });
});

describe("a notice that names no chat", () => {
  it("searches every Group and the files' conversations, but no DM", async () => {
    const target = { to: "chat" as const, thread: "group-2-chat", message: "m-1" };
    await expect(findNoticeChat("notes", target)).resolves.toEqual({
      open: "chats", nav: { level: "channel", channel: otherGroup, lane: "chat", focusMessageId: "m-1" },
    });
    expect(new Set(listChannelThreads.mock.calls.map(([payload]) => payload.channelId))).toEqual(new Set(["group-1", "group-2"]));
    await expect(findNoticeChat("notes", { to: "chat", thread: "file-thread" })).resolves.toEqual({ open: "file", thread: fileThread });
    await expect(findNoticeChat("notes", { to: "chat", thread: "dm-thread" })).resolves.toBeNull();
  });
});

describe("where a work link's chat opens", () => {
  it("opens a Group as its channel", async () => {
    await expect(findNoticeChannel("notes", "group-1")).resolves.toEqual({ open: "chats", nav: { level: "channel", channel: group } });
    expect(syncDms).not.toHaveBeenCalled();
  });

  it("opens a DM through its record", async () => {
    const record = { channelId: "dm-1", name: "sam@example.com" };
    syncDms.mockResolvedValue({ dms: [{ channelId: "dm-other" }, record] });
    await expect(findNoticeChannel("notes", "dm-1")).resolves.toEqual({ open: "chats", nav: { level: "dm", dm: record } });
  });

  it("finds nothing for a chat this workspace does not list, or a DM without a record", async () => {
    syncDms.mockResolvedValue({ dms: [] });
    await expect(findNoticeChannel("notes", "group-gone")).resolves.toBeNull();
    await expect(findNoticeChannel("notes", "dm-1")).resolves.toBeNull();
  });
});
