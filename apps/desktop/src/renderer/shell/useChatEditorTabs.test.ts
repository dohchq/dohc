// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChatEditorTabs } from "./useChatEditorTabs";
import { chatEditorPath } from "./chatsNav";
import { chatTabPath } from "../workbench/workbenchState";
import type { ChatsDrafts, ChatsNav } from "../workbench/ChatsView";
import { deferred } from "../../testing/deferred";

const general: ChatsNav = { level: "channel", channel: {
  id: "general-id", name: "General", slug: "general", kind: "channel",
  createdAtMs: 0, updatedAtMs: 0, threadCount: 0, unreadCount: 0,
} };
const agent: ChatsNav = { level: "channel", channel: { ...general.channel, id: "agent-id", kind: "agent" } };
const dm: ChatsNav = { level: "dm", dm: {
  channelId: "dm-id", channelWireId: "wire-id", name: "alice", peerLabel: "Alice",
  threadId: "dm-thread", shareId: null, role: "owner", unreadCount: 0, connected: true,
} };
const draft: ChatsDrafts = {
  composer: "Unsent reply", newThreadBody: "", dmRecipients: "", dmDraft: "",
  replyTarget: null, resolveTargetMessageId: null,
};
const thread: ChatsNav = { level: "thread", channel: general.channel, thread: {
  id: "thread", channelId: general.channel.id, title: "Discussion", createdAtMs: 0,
  updatedAtMs: 0, messageCount: 1, lastReadSequence: 0, unreadCount: 1,
} };

describe("chat editor tabs", () => {
  it("clears hidden DM drafts on account changes and ignores callbacks from the old editor", () => {
    let changeSession: (event: { sessionKey: string | null }) => void = () => {};
    vi.stubGlobal("dohcDesktop", {
      onCloudSessionChanged: (listener: typeof changeSession) => { changeSession = listener; return () => {}; },
    });
    const { result } = renderHook(() => useChatEditorTabs({
      workspaceId: "workspace", onOpen: vi.fn(), onNavigate: vi.fn(), paths: [], enabled: true,
    }));
    act(() => result.current.open(dm));
    const old = result.current.get(chatEditorPath(dm));
    act(() => old.onDraftsChange(draft));
    act(() => changeSession({ sessionKey: "new-account" }));
    act(() => { old.onNavChange(dm); old.onDraftsChange(draft); });
    const current = result.current.get(chatEditorPath(dm));
    expect(current).not.toBe(old);
    expect(current.nav).toBeUndefined();
    expect(current.drafts).toBeUndefined();
    expect(result.current.titles.has(chatEditorPath(dm))).toBe(false);
    vi.unstubAllGlobals();
  });

  it("keeps Home, channels, agents and DMs independent and reuses a channel's current thread", () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useChatEditorTabs({
      workspaceId: "workspace", onOpen, onNavigate: vi.fn(), paths: [], enabled: false,
    }));
    act(() => result.current.open(general));
    const generalEditor = result.current.get(chatEditorPath(general));
    act(() => { generalEditor.onNavChange(thread); generalEditor.onDraftsChange(draft); });
    act(() => {
      result.current.open({ level: "feed" });
      result.current.open(agent);
      result.current.open(dm);
    });
    expect(new Set(onOpen.mock.calls.map(([path]) => path)).size).toBe(4);
    act(() => result.current.open(general));
    expect(result.current.get(chatEditorPath(general))).toBe(generalEditor);
    expect(generalEditor.nav).toBe(thread);
    expect(generalEditor.drafts).toBe(draft);
    expect(result.current.get(chatEditorPath(dm)).drafts).toBeUndefined();
    expect(result.current.titles.get(chatEditorPath(general))).toBe("#General");
    expect(result.current.titles.get(chatEditorPath(agent))).toBe("My agent");
    expect(result.current.titles.get(chatEditorPath(dm))).toBe("Alice");
  });

  it("repeats a message jump without discarding that conversation's draft", () => {
    const { result } = renderHook(() => useChatEditorTabs({
      workspaceId: "workspace", onOpen: vi.fn(), onNavigate: vi.fn(), paths: [], enabled: false,
    }));
    act(() => result.current.open(thread));
    const editor = result.current.get(chatEditorPath(thread));
    act(() => editor.onDraftsChange(draft));
    const before = editor.revision;
    act(() => result.current.open({ ...thread, focusMessageId: "message" }));
    expect(editor.revision).toBe(before + 1);
    expect(editor.drafts).toBe(draft);
  });

  it("drops callbacks and restored titles from a previous workspace", async () => {
    const pending = deferred<{ channels: typeof general.channel[]; fileThreads: [] }>();
    vi.stubGlobal("dohcDesktop", { onCloudSessionChanged: () => () => {}, listChatChannels: vi.fn(() => pending.promise) });
    const path = chatTabPath({ kind: "channel", id: general.channel.id });
    const { result, rerender } = renderHook(({ workspaceId }) => useChatEditorTabs({
      workspaceId, onOpen: vi.fn(), onNavigate: vi.fn(), paths: [path], enabled: true,
    }), { initialProps: { workspaceId: "first" } });
    const stale = result.current.get(path);
    rerender({ workspaceId: "second" });
    act(() => { stale.onNavChange(agent); stale.onDraftsChange(draft); });
    expect(result.current.get(path).nav).toBeUndefined();
    expect(result.current.get(path).drafts).toBeUndefined();
    await act(async () => pending.resolve({ channels: [general.channel], fileThreads: [] }));
    await waitFor(() => expect(result.current.titles.get(path)).toBe("#General"));
    expect(stale.nav).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
