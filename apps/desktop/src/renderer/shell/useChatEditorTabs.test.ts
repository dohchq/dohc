// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatEditorTabs } from "./useChatEditorTabs";
import { chatEditorPath } from "./chatsNav";
import { chatTabPath } from "../workbench/workbenchState";
import type { ChatsDrafts, ChatsNav } from "../workbench/ChatsView";
import { deferred } from "../../testing/deferred";
import type { SettingsAgent } from "../workbench/agentChat";

const general: ChatsNav = {
  level: "channel",
  channel: {
    id: "general-id",
    name: "General",
    slug: "general",
    kind: "channel",
    createdAtMs: 0,
    updatedAtMs: 0,
    threadCount: 0,
    unreadCount: 0,
  },
};
const agent: ChatsNav = {
  level: "channel",
  channel: {
    ...general.channel,
    id: "agent-id",
    name: "My agent",
    kind: "agent",
    agentId: "default",
  },
};
const scoutChat = {
  ...general.channel,
  id: "scout-chat",
  name: "Scout",
  kind: "agent" as const,
  agentId: "scout",
};
const NO_AGENTS: SettingsAgent[] = [];
const AGENTS: SettingsAgent[] = [
  { id: "default", name: "Nova", hue: "olive" },
  { id: "scout", name: "Scout", hue: "teal" },
];
const dm: ChatsNav = { level: "direct", conversationId: "conversation-1", title: "Alice" };
const draft: ChatsDrafts = {
  composer: "Unsent reply",
  newThreadBody: "",
  replyTarget: null,
  resolveTargetMessageId: null,
  poll: null,
  newThreadPoll: null,
};
const thread: ChatsNav = {
  level: "thread",
  channel: general.channel,
  thread: {
    id: "thread",
    channelId: general.channel.id,
    title: "Discussion",
    createdAtMs: 0,
    updatedAtMs: 0,
    messageCount: 1,
    lastReadSequence: 0,
    unreadCount: 1,
  },
};

const NO_SAVED_NAMES = { directNames: {}, onDirectName: () => {}, accountKey: undefined };

// Hidden conversations ask for their unread counts, and direct tabs for the people's names; most tests ignore them.
const UNREAD_BRIDGE = {
  listChatUnread: () => Promise.resolve({ chats: [] }),
  onWorkspaceActivity: () => () => {},
  directConversations: () => new Promise(() => {}),
  onDirectChanged: () => () => {},
};

beforeEach(() =>
  vi.stubGlobal("dohcDesktop", { ...UNREAD_BRIDGE, onCloudSessionChanged: () => () => {} }),
);
afterEach(() => vi.unstubAllGlobals());

describe("chat editor tabs", () => {
  // Direct messages live on the account's server, so their tabs restore while
  // the workspace's own chats cannot be read, as where nothing records.
  it.each([true, false])(
    "restores a hidden direct message tab from its path, without a read, when workspace chats are %s",
    (enabled) => {
      const listChatChannels = vi.fn().mockResolvedValue({ channels: [], fileThreads: [] });
      vi.stubGlobal("dohcDesktop", {
        ...UNREAD_BRIDGE,
        onCloudSessionChanged: () => () => {},
        listChatChannels,
      });
      const path = chatEditorPath(dm);
      const home = chatEditorPath({ level: "feed" });
      const channel = chatEditorPath(general);
      const { result } = renderHook(() =>
        useChatEditorTabs({
          readRevision: 0,
          ...NO_SAVED_NAMES,
          workspaceId: "workspace",
          agents: NO_AGENTS,
          onOpen: vi.fn(),
          paths: [path, channel, home],
          activePaths: [home],
          enabled,
        }),
      );
      expect(result.current.get(path).nav).toEqual({
        level: "direct",
        conversationId: "conversation-1",
      });
      expect(result.current.titles.get(path)).toBe("Direct message");
      expect(listChatChannels).toHaveBeenCalledTimes(enabled ? 1 : 0);
    },
  );

  it.each([true, false])(
    "names a hidden direct message tab once the list reads, such as when the server comes back, when workspace chats are %s",
    async (enabled) => {
      const list = deferred<unknown>();
      vi.stubGlobal("dohcDesktop", {
        ...UNREAD_BRIDGE,
        onCloudSessionChanged: () => () => {},
        directConversations: () => list.promise,
      });
      const path = chatEditorPath(dm);
      const home = chatEditorPath({ level: "feed" });
      const { result } = renderHook(() =>
        useChatEditorTabs({
          readRevision: 0,
          ...NO_SAVED_NAMES,
          workspaceId: "workspace",
          agents: NO_AGENTS,
          onOpen: vi.fn(),
          paths: [path, home],
          activePaths: [home],
          enabled,
        }),
      );
      expect(result.current.titles.get(path)).toBe("Direct message");
      await act(async () =>
        list.resolve({
          available: true,
          viewerId: "viewer",
          scope: "a".repeat(64),
          conversations: [
            {
              conversationId: "conversation-1",
              person: { personId: "alice", name: "Alice Moreno", blocked: false },
              last: {
                seq: 1,
                messageId: "m1",
                authorId: "alice",
                authorName: "Alice Moreno",
                body: "Hi",
                createdAtMs: 0,
              },
              unread: 0,
            },
          ],
        }),
      );
      await waitFor(() => expect(result.current.titles.get(path)).toBe("Alice Moreno"));
    },
  );

  it("does not retry failed hidden restores when the active tab changes", async () => {
    const listChatChannels = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("dohcDesktop", {
      ...UNREAD_BRIDGE,
      onCloudSessionChanged: () => () => {},
      listChatChannels,
    });
    const path = chatEditorPath(general);
    const home = chatEditorPath({ level: "feed" });
    const { rerender } = renderHook(
      ({ activePaths }) =>
        useChatEditorTabs({
          readRevision: 0,
          ...NO_SAVED_NAMES,
          workspaceId: "workspace",
          agents: NO_AGENTS,
          onOpen: vi.fn(),
          paths: [path, home],
          activePaths,
          enabled: true,
        }),
      { initialProps: { activePaths: [home] } },
    );
    await act(async () => {});
    rerender({ activePaths: [path] });
    rerender({ activePaths: [home] });
    expect(listChatChannels).toHaveBeenCalledTimes(1);
  });

  it("leaves active destinations to their mounted pages", () => {
    const listChatChannels = vi.fn();
    vi.stubGlobal("dohcDesktop", {
      ...UNREAD_BRIDGE,
      onCloudSessionChanged: () => () => {},
      listChatChannels,
    });
    const paths = [chatEditorPath(dm), chatEditorPath(general)];
    renderHook(() =>
      useChatEditorTabs({
        readRevision: 0,
        ...NO_SAVED_NAMES,
        workspaceId: "workspace",
        agents: NO_AGENTS,
        onOpen: vi.fn(),
        paths,
        activePaths: paths,
        enabled: true,
      }),
    );
    expect(listChatChannels).not.toHaveBeenCalled();
  });

  it("purges account state while disabled and restores titles only after the session is ready", async () => {
    type SessionEvent = { sessionKey: string; phase: "changing" | "ready" };
    // The tabs and the direct store each follow the session.
    const sessionListeners = new Set<(event: SessionEvent) => void>();
    const changeSession = (event: SessionEvent) => {
      for (const listener of sessionListeners) listener(event);
    };
    vi.stubGlobal("dohcDesktop", {
      ...UNREAD_BRIDGE,
      onCloudSessionChanged: (listener: (event: SessionEvent) => void) => {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
    });
    const path = chatEditorPath(dm);
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useChatEditorTabs({
          readRevision: 0,
          ...NO_SAVED_NAMES,
          workspaceId: "workspace",
          agents: NO_AGENTS,
          onOpen: vi.fn(),
          paths: [path],
          enabled,
        }),
      { initialProps: { enabled: false } },
    );
    act(() => result.current.open(dm));
    const stale = result.current.get(path);
    act(() => stale.onDraftsChange(draft));
    act(() => changeSession({ sessionKey: "next", phase: "changing" }));
    rerender({ enabled: true });
    expect(result.current.get(path).drafts).toBeUndefined();
    expect(result.current.get(path).nav).toBeUndefined();
    act(() => changeSession({ sessionKey: "next", phase: "ready" }));
    await waitFor(() => expect(result.current.titles.get(path)).toBe("Direct message"));
    expect(result.current.get(path).drafts).toBeUndefined();
  });

  it("does not repeatedly hydrate missing chats when tabs change", async () => {
    const listChatChannels = vi.fn().mockResolvedValue({ channels: [], fileThreads: [] });
    vi.stubGlobal("dohcDesktop", {
      ...UNREAD_BRIDGE,
      onCloudSessionChanged: () => () => {},
      listChatChannels,
    });
    const paths = [chatEditorPath(general), chatEditorPath(agent)];
    const { result, rerender } = renderHook(
      ({ paths }) =>
        useChatEditorTabs({
          readRevision: 0,
          ...NO_SAVED_NAMES,
          workspaceId: "workspace",
          agents: NO_AGENTS,
          onOpen: vi.fn(),
          paths,
          enabled: true,
        }),
      { initialProps: { paths } },
    );
    await act(async () => {});
    expect(result.current.get(paths[0]!).restoreAttempted).toBe(true);
    rerender({ paths: [...paths] });
    rerender({ paths: [...paths, chatEditorPath({ level: "feed" })] });
    await act(async () => {});
    expect(listChatChannels).toHaveBeenCalledTimes(1);
  });

  it("clears hidden direct message drafts on account changes and ignores callbacks from the old editor", () => {
    let changeSession: (event: {
      sessionKey: string | null;
      phase: "changing" | "ready";
    }) => void = () => {};
    vi.stubGlobal("dohcDesktop", {
      ...UNREAD_BRIDGE,
      onCloudSessionChanged: (listener: typeof changeSession) => {
        changeSession = listener;
        return () => {};
      },
    });
    const { result } = renderHook(() =>
      useChatEditorTabs({
        readRevision: 0,
        ...NO_SAVED_NAMES,
        workspaceId: "workspace",
        agents: NO_AGENTS,
        onOpen: vi.fn(),
        paths: [],
        enabled: true,
      }),
    );
    act(() => result.current.open(dm));
    const old = result.current.get(chatEditorPath(dm));
    act(() => old.onDraftsChange(draft));
    act(() => changeSession({ sessionKey: "new-account", phase: "changing" }));
    act(() => {
      old.onNavChange(dm);
      old.onDraftsChange(draft);
    });
    const current = result.current.get(chatEditorPath(dm));
    expect(current).not.toBe(old);
    expect(current.nav).toBeUndefined();
    expect(current.drafts).toBeUndefined();
    expect(result.current.titles.has(chatEditorPath(dm))).toBe(false);
    vi.unstubAllGlobals();
  });

  it("keeps Home, channels, agents and direct messages independent and reuses a channel's current thread", () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() =>
      useChatEditorTabs({
        readRevision: 0,
        ...NO_SAVED_NAMES,
        workspaceId: "workspace",
        agents: NO_AGENTS,
        onOpen,
        paths: [],
        enabled: false,
      }),
    );
    act(() => result.current.open(general));
    const generalEditor = result.current.get(chatEditorPath(general));
    act(() => {
      generalEditor.onNavChange(thread);
      generalEditor.onDraftsChange(draft);
    });
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
    expect(result.current.titles.get(chatEditorPath(general))).toBe("General");
    expect(result.current.titles.get(chatEditorPath(agent))).toBe("Your agent");
    expect(result.current.titles.get(chatEditorPath(dm))).toBe("Alice");
  });

  it("repeats a message jump without discarding that conversation's draft", () => {
    const { result } = renderHook(() =>
      useChatEditorTabs({
        readRevision: 0,
        ...NO_SAVED_NAMES,
        workspaceId: "workspace",
        agents: NO_AGENTS,
        onOpen: vi.fn(),
        paths: [],
        enabled: false,
      }),
    );
    act(() => result.current.open(thread));
    const editor = result.current.get(chatEditorPath(thread));
    act(() => editor.onDraftsChange(draft));
    const before = editor.revision;
    act(() => result.current.open({ ...thread, focusMessageId: "message" }));
    expect(editor.revision).toBe(before + 1);
    expect(editor.drafts).toBe(draft);
  });

  it("takes a jump to a message in an open agent conversation, keeping its draft", () => {
    const { result } = renderHook(() =>
      useChatEditorTabs({
        readRevision: 0,
        ...NO_SAVED_NAMES,
        workspaceId: "workspace",
        agents: NO_AGENTS,
        onOpen: vi.fn(),
        paths: [],
        enabled: false,
      }),
    );
    act(() => result.current.open(agent));
    const editor = result.current.get(chatEditorPath(agent));
    act(() => editor.onDraftsChange(draft));
    const before = editor.revision;
    const jump = { ...agent, focusMessageId: "reply" } as ChatsNav;
    act(() => result.current.open(jump));
    expect(editor.nav).toEqual(jump);
    expect(editor.revision).toBe(before + 1);
    expect(editor.drafts).toBe(draft);

    const lane = { ...agent, lane: "chat" } as ChatsNav;
    act(() => result.current.open(lane));
    expect(editor.nav).toEqual(lane);
    expect(editor.revision).toBe(before + 2);
    act(() => result.current.open(agent));
    expect(editor.revision).toBe(before + 2);
  });

  it("takes a direct message's newer names without remounting it or losing its draft", () => {
    const { result } = renderHook(() =>
      useChatEditorTabs({
        readRevision: 0,
        ...NO_SAVED_NAMES,
        workspaceId: "workspace",
        agents: NO_AGENTS,
        onOpen: vi.fn(),
        paths: [],
        enabled: false,
      }),
    );
    act(() => result.current.open(dm));
    const editor = result.current.get(chatEditorPath(dm));
    act(() => editor.onDraftsChange(draft));
    const before = editor.revision;
    act(() =>
      result.current.open({
        level: "direct",
        conversationId: "conversation-1",
        title: "Alice, Sam",
      }),
    );
    expect(result.current.get(chatEditorPath(dm))).toBe(editor);
    expect(editor.nav).toEqual({
      level: "direct",
      conversationId: "conversation-1",
      title: "Alice, Sam",
    });
    expect(editor.drafts).toBe(draft);
    expect(editor.revision).toBe(before);
    expect(result.current.titles.get(chatEditorPath(dm))).toBe("Alice, Sam");
  });

  it("drops callbacks and restored titles from a previous workspace", async () => {
    const pending = deferred<{ channels: (typeof general.channel)[]; fileThreads: [] }>();
    vi.stubGlobal("dohcDesktop", {
      ...UNREAD_BRIDGE,
      onCloudSessionChanged: () => () => {},
      listChatChannels: vi.fn(() => pending.promise),
    });
    const path = chatTabPath({ kind: "channel", id: general.channel.id });
    const { result, rerender } = renderHook(
      ({ workspaceId }) =>
        useChatEditorTabs({
          readRevision: 0,
          ...NO_SAVED_NAMES,
          workspaceId,
          agents: NO_AGENTS,
          onOpen: vi.fn(),
          paths: [path],
          enabled: true,
        }),
      { initialProps: { workspaceId: "first" } },
    );
    const stale = result.current.get(path);
    rerender({ workspaceId: "second" });
    act(() => {
      stale.onNavChange(agent);
      stale.onDraftsChange(draft);
    });
    expect(result.current.get(path).nav).toBeUndefined();
    expect(result.current.get(path).drafts).toBeUndefined();
    await act(async () => pending.resolve({ channels: [general.channel], fileThreads: [] }));
    await waitFor(() => expect(result.current.titles.get(path)).toBe("General"));
    expect(stale.nav).toBeUndefined();
    vi.unstubAllGlobals();
  });
  it("names each agent's chat tab and its thread after that agent, and follows a rename", () => {
    const scoutThread: ChatsNav = {
      level: "thread",
      channel: scoutChat,
      thread: { ...thread.thread, id: "scout-thread", channelId: scoutChat.id },
    };
    const { result, rerender } = renderHook(
      ({ agents }) =>
        useChatEditorTabs({
          readRevision: 0,
          ...NO_SAVED_NAMES,
          workspaceId: "workspace",
          agents,
          onOpen: vi.fn(),
          paths: [],
          enabled: false,
        }),
      { initialProps: { agents: AGENTS } },
    );
    act(() => {
      result.current.open(agent);
      result.current.open(scoutThread);
    });
    expect(result.current.titles.get(chatEditorPath(agent))).toBe("Nova");
    expect(result.current.titles.get(chatEditorPath(scoutThread))).toBe("Scout");
    rerender({ agents: [AGENTS[0]!, { ...AGENTS[1]!, name: "Ranger" }] });
    expect(result.current.titles.get(chatEditorPath(scoutThread))).toBe("Ranger");
    rerender({ agents: [] });
    expect(result.current.titles.get(chatEditorPath(scoutThread))).toBe("Scout");
    expect(result.current.titles.get(chatEditorPath(agent))).toBe("Your agent");
  });

  it("counts unread messages on hidden conversation tabs and follows workspace activity", async () => {
    let activity: (event: { workspaceId?: string }) => void = () => {};
    let chats = [
      { channelId: general.channel.id, unreadCount: 2 },
      { channelId: "conversation-1", unreadCount: 1 },
      { channelId: agent.channel.id, unreadCount: 4 },
      { channelId: "no-tab", unreadCount: 9 },
    ];
    const listChatUnread = vi.fn(() => Promise.resolve({ chats }));
    vi.stubGlobal("dohcDesktop", {
      ...UNREAD_BRIDGE,
      onCloudSessionChanged: () => () => {},
      listChatChannels: vi.fn(() => new Promise(() => {})),
      listChatUnread,
      onWorkspaceActivity: (listener: typeof activity) => {
        activity = listener;
        return () => {};
      },
    });
    const paths = [
      chatEditorPath(general),
      chatEditorPath(dm),
      chatEditorPath(agent),
      chatEditorPath({ level: "feed" }),
    ];
    const { result, rerender } = renderHook(
      ({ activePaths, readRevision }) =>
        useChatEditorTabs({
          workspaceId: "workspace",
          agents: NO_AGENTS,
          onOpen: vi.fn(),
          paths,
          activePaths,
          enabled: true,
          readRevision,
          ...NO_SAVED_NAMES,
        }),
      { initialProps: { activePaths: [chatEditorPath(agent)], readRevision: 0 } },
    );
    // The open agent chat reads its own messages, so only the others count.
    // A direct message is not a workspace chat, so its tab counts nothing.
    await waitFor(() =>
      expect(result.current.unread).toEqual(new Map([[chatEditorPath(general), 2]])),
    );

    chats = [{ channelId: general.channel.id, unreadCount: 3 }];
    await act(async () => activity({ workspaceId: "elsewhere" }));
    expect(listChatUnread).toHaveBeenCalledTimes(1);
    await act(async () => activity({ workspaceId: "workspace" }));
    expect(result.current.unread).toEqual(new Map([[chatEditorPath(general), 3]]));

    chats = [];
    rerender({ activePaths: [chatEditorPath(agent)], readRevision: 1 });
    await waitFor(() => expect(result.current.unread.size).toBe(0));
    expect(listChatUnread).toHaveBeenCalledTimes(3);
  });

  it("keeps one unread read in flight and drops an answer for another workspace", async () => {
    const answers: Array<
      ReturnType<typeof deferred<{ chats: { channelId: string; unreadCount: number }[] }>>
    > = [];
    let activity: (event: { workspaceId?: string }) => void = () => {};
    const listChatUnread = vi.fn(() => {
      const answer = deferred<{ chats: { channelId: string; unreadCount: number }[] }>();
      answers.push(answer);
      return answer.promise;
    });
    vi.stubGlobal("dohcDesktop", {
      onCloudSessionChanged: () => () => {},
      listChatChannels: vi.fn(() => new Promise(() => {})),
      listChatUnread,
      onWorkspaceActivity: (listener: typeof activity) => {
        activity = listener;
        return () => {};
      },
    });
    const path = chatEditorPath(general);
    const { result, rerender } = renderHook(
      ({ workspaceId }) =>
        useChatEditorTabs({
          readRevision: 0,
          ...NO_SAVED_NAMES,
          workspaceId,
          agents: NO_AGENTS,
          onOpen: vi.fn(),
          paths: [path],
          enabled: true,
        }),
      { initialProps: { workspaceId: "first" } },
    );
    act(() => {
      activity({ workspaceId: "first" });
      activity({ workspaceId: "first" });
    });
    expect(listChatUnread).toHaveBeenCalledTimes(1);
    await act(async () =>
      answers[0]!.resolve({ chats: [{ channelId: general.channel.id, unreadCount: 1 }] }),
    );
    expect(listChatUnread).toHaveBeenCalledTimes(2);
    await act(async () =>
      answers[1]!.resolve({ chats: [{ channelId: general.channel.id, unreadCount: 2 }] }),
    );
    expect(result.current.unread.get(path)).toBe(2);

    act(() => activity({ workspaceId: "first" }));
    rerender({ workspaceId: "second" });
    expect(answers).toHaveLength(3);
    expect(result.current.unread.size).toBe(0);
    await act(async () =>
      answers[2]!.resolve({ chats: [{ channelId: general.channel.id, unreadCount: 7 }] }),
    );
    expect(result.current.unread.size).toBe(0);
    expect(answers).toHaveLength(4);
    await act(async () =>
      answers[3]!.resolve({ chats: [{ channelId: general.channel.id, unreadCount: 5 }] }),
    );
    expect(result.current.unread.get(path)).toBe(5);
  });

  it("keeps one unread read in flight while tabs and reads change, and answers for the latest tabs", async () => {
    const answers: Array<
      ReturnType<typeof deferred<{ chats: { channelId: string; unreadCount: number }[] }>>
    > = [];
    const listChatUnread = vi.fn(() => {
      const answer = deferred<{ chats: { channelId: string; unreadCount: number }[] }>();
      answers.push(answer);
      return answer.promise;
    });
    vi.stubGlobal("dohcDesktop", {
      ...UNREAD_BRIDGE,
      onCloudSessionChanged: () => () => {},
      listChatChannels: vi.fn(() => new Promise(() => {})),
      listChatUnread,
    });
    const group = chatEditorPath(general),
      person = chatEditorPath(agent);
    const { result, rerender } = renderHook(
      ({ activePaths, readRevision }) =>
        useChatEditorTabs({
          workspaceId: "workspace",
          agents: NO_AGENTS,
          onOpen: vi.fn(),
          paths: [group, person],
          activePaths,
          enabled: true,
          readRevision,
          ...NO_SAVED_NAMES,
        }),
      { initialProps: { activePaths: [person], readRevision: 0 } },
    );
    rerender({ activePaths: [person], readRevision: 1 });
    rerender({ activePaths: [person], readRevision: 2 });
    rerender({ activePaths: [group], readRevision: 2 });
    expect(listChatUnread).toHaveBeenCalledTimes(1);
    const both = {
      chats: [
        { channelId: general.channel.id, unreadCount: 1 },
        { channelId: agent.channel.id, unreadCount: 4 },
      ],
    };
    await act(async () => answers[0]!.resolve(both));
    expect(result.current.unread.size).toBe(0);
    expect(listChatUnread).toHaveBeenCalledTimes(2);
    await act(async () => answers[1]!.resolve(both));
    expect(result.current.unread).toEqual(new Map([[person, 4]]));
  });

  describe("a direct tab's saved name", () => {
    type SessionEvent = { sessionKey: string | null; phase: "changing" | "ready" };
    const ann = "server#relay#ann";
    const path = chatEditorPath({ level: "direct", conversationId: "conversation-1" });
    const home = chatEditorPath({ level: "feed" });
    const listeners = new Set<(event: SessionEvent) => void>();
    const changeSession = (event: SessionEvent) => {
      for (const listener of listeners) listener(event);
    };
    // The server is away: the list never answers.
    const stubOffline = (
      directConversations: () => Promise<unknown> = () => new Promise(() => {}),
    ) =>
      vi.stubGlobal("dohcDesktop", {
        ...UNREAD_BRIDGE,
        directConversations,
        onCloudSessionChanged: (listener: (event: SessionEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      });
    const renderTabs = (
      directNames: Record<string, { account: string; name: string }>,
      onDirectName = vi.fn(),
    ) =>
      renderHook(() =>
        useChatEditorTabs({
          readRevision: 0,
          workspaceId: "workspace",
          agents: NO_AGENTS,
          onOpen: vi.fn(),
          paths: [path, home],
          activePaths: [home],
          enabled: true,
          // Signed in as Ann at start, by the shell's status read.
          directNames,
          onDirectName,
          accountKey: ann,
        }),
      );
    afterEach(() => listeners.clear());

    it("names a restored tab and its header before the list reads", async () => {
      stubOffline();
      const { result } = renderTabs({ "conversation-1": { account: ann, name: "Alice Moreno" } });
      await waitFor(() => expect(result.current.titles.get(path)).toBe("Alice Moreno"));
      expect(result.current.savedDirectName("conversation-1")).toBe("Alice Moreno");
    });

    it("never shows a name saved for another account, including after a change of account", async () => {
      stubOffline();
      const other = renderTabs({
        "conversation-1": { account: "server#relay#bob", name: "Alice Moreno" },
      });
      await act(async () => {});
      expect(other.result.current.titles.get(path)).toBe("Direct message");
      expect(other.result.current.savedDirectName("conversation-1")).toBeUndefined();
      other.unmount();

      const { result } = renderTabs({ "conversation-1": { account: ann, name: "Alice Moreno" } });
      await waitFor(() => expect(result.current.titles.get(path)).toBe("Alice Moreno"));
      act(() => changeSession({ sessionKey: "server#relay#bob", phase: "ready" }));
      await waitFor(() => expect(result.current.titles.get(path)).toBe("Direct message"));
      expect(result.current.savedDirectName("conversation-1")).toBeUndefined();
      act(() => changeSession({ sessionKey: null, phase: "ready" }));
      await act(async () => {});
      expect(result.current.titles.get(path)).toBe("Direct message");
    });

    it("takes the server's name once the list reads, and saves it for the account", async () => {
      const list = deferred<unknown>();
      stubOffline(() => list.promise);
      const onDirectName = vi.fn();
      const { result } = renderTabs(
        { "conversation-1": { account: ann, name: "Alice" } },
        onDirectName,
      );
      await waitFor(() => expect(result.current.titles.get(path)).toBe("Alice"));
      await act(async () =>
        list.resolve({
          available: true,
          viewerId: "ann",
          scope: "a".repeat(64),
          conversations: [
            {
              conversationId: "conversation-1",
              person: { personId: "alice", name: "Alice Moreno", blocked: false },
              last: {
                seq: 1,
                messageId: "m1",
                authorId: "alice",
                authorName: "Alice Moreno",
                body: "Hi",
                createdAtMs: 0,
              },
              unread: 0,
            },
          ],
        }),
      );
      await waitFor(() => expect(result.current.titles.get(path)).toBe("Alice Moreno"));
      expect(result.current.savedDirectName("conversation-1")).toBeUndefined();
      expect(onDirectName).toHaveBeenCalledWith("conversation-1", ann, "Alice Moreno");
    });
  });
});
