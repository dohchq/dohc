import "../../testing/legendListMock";
// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../../settings/userSettings";
import { settingsWithAgent, testAgent } from "../../testing/agentSettings";
import { bridgeMock, channel, dm, renderView, shareListing, thread } from "./ChatsView.testHarness";

function archived(settings: DesktopUserSettings, ...channelIds: string[]): DesktopUserSettings {
  return { ...settings, sidebar: { ...settings.sidebar, archivedChats: { "workspace-a": channelIds } } };
}

function menuLabels() {
  return within(screen.getByTestId("chat-row-menu")).getAllByRole("menuitem").map((item) => item.textContent);
}

describe("ChatsView archive and row menus", () => {
  it("archives a group from its right-click menu, with Undo in the notice", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    bridgeMock.setChatArchived.mockResolvedValue({ settings: DEFAULT_USER_SETTINGS });
    renderView(vi.fn(), vi.fn(), { userSettings: DEFAULT_USER_SETTINGS, onNotice });

    fireEvent.contextMenu(await screen.findByTestId("chats-channel"), { clientX: 40, clientY: 60 });
    // Nothing unread, so no Mark as read; the group is yours, so Add people.
    expect(menuLabels()).toEqual(["Add people…", "Archive"]);
    await user.click(screen.getByTestId("chat-row-menu-archive"));

    expect(bridgeMock.setChatArchived).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace-a", channelId: "channel-1", archived: true });
    await waitFor(() => expect(onNotice).toHaveBeenCalledOnce());
    const [words, undo] = onNotice.mock.lastCall!;
    expect(words).toBe("Archived general");
    undo();
    await waitFor(() => expect(bridgeMock.setChatArchived).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", channelId: "channel-1", archived: false }));
    expect(screen.queryByTestId("chat-row-menu")).toBeNull();
  });

  it("opens the focused row's menu from the Menu key and Shift+F10, once", async () => {
    renderView(vi.fn(), vi.fn(), { userSettings: DEFAULT_USER_SETTINGS });
    const row = await screen.findByTestId("chats-channel");
    for (const key of [{ key: "ContextMenu" }, { key: "F10", shiftKey: true }]) {
      row.focus();
      fireEvent.keyDown(row, key);
      // The browser's own contextmenu event after the key opens nothing more.
      fireEvent.contextMenu(row);
      expect(screen.getAllByTestId("chat-row-menu")).toHaveLength(1);
      expect(screen.getByTestId("chat-row-menu-archive")).toBeTruthy();
      fireEvent.keyDown(screen.getByTestId("chat-row-menu-archive"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("chat-row-menu")).toBeNull());
    }
  });

  it("keeps an archived chat archived when a message arrives, and marks Archived instead", async () => {
    const user = userEvent.setup();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel(), channel({ id: "channel-trip", name: "trip", slug: "trip", unreadCount: 2 })],
      fileThreads: [],
    });
    bridgeMock.setChatArchived.mockResolvedValue({ settings: DEFAULT_USER_SETTINGS });
    renderView(vi.fn(), vi.fn(), { userSettings: archived(DEFAULT_USER_SETTINGS, "channel-trip") });

    await screen.findByTestId("chats-archived-section");
    expect(screen.getAllByTestId("chats-channel-name").map((name) => name.textContent)).toEqual(["general"]);
    const toggle = screen.getByTestId("chats-archived-toggle");
    expect(within(toggle).getByText("Archived").className).toContain("font-medium");
    expect(within(toggle).getByTestId("chats-archived-unread").textContent).toBe("2");
    expect(within(toggle).queryByTestId("chats-archived-count")).toBeNull();

    await user.click(toggle);
    const trip = within(screen.getByTestId("chats-archived-list")).getByTestId("chats-channel");
    expect(within(trip).getByTestId("chats-channel-name").className).toContain("font-medium");
    expect(within(trip).getByTestId("chats-channel-unread").textContent).toBe("2");

    fireEvent.contextMenu(trip, { clientX: 40, clientY: 200 });
    expect(menuLabels()).toEqual(["Mark as read", "Add people…", "Unarchive"]);
    fireEvent.keyDown(screen.getByTestId("chat-row-menu-unarchive"), { key: "Escape" });

    // Open, it says it is archived and offers the way back.
    await user.click(trip);
    await user.click(await screen.findByTestId("chats-unarchive"));
    expect(bridgeMock.setChatArchived).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace-a", channelId: "channel-trip", archived: false });
  });

  it("counts Archived quietly when nothing in it is unread", async () => {
    renderView(vi.fn(), vi.fn(), { userSettings: archived(DEFAULT_USER_SETTINGS, "channel-1") });
    const toggle = await screen.findByTestId("chats-archived-toggle");
    expect(within(toggle).getByText("Archived").className).toContain("text-muted");
    expect(within(toggle).getByTestId("chats-archived-count").textContent).toBe("1");
    expect(screen.queryByTestId("chats-archived-list")).toBeNull();
  });

  it("marks every unread thread in both of a group's lanes read", async () => {
    const user = userEvent.setup();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel({ type: "both", unreadCount: 3 })],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockImplementation(async (input: { lane?: string }) => ({
      threads: input.lane === "chat"
        ? [thread({ id: "lane", messageCount: 9, unreadCount: 2 })]
        : [thread({ id: "post-read" }), thread({ id: "post-new", messageCount: 4, unreadCount: 1 })],
    }));
    renderView(vi.fn(), vi.fn(), { userSettings: DEFAULT_USER_SETTINGS });

    fireEvent.contextMenu(await screen.findByTestId("chats-channel"), { clientX: 40, clientY: 60 });
    await user.click(screen.getByTestId("chat-row-menu-mark-read"));
    await waitFor(() => expect(bridgeMock.markChatThreadRead).toHaveBeenCalledTimes(2));
    expect(bridgeMock.markChatThreadRead.mock.calls.map(([input]) => input)).toEqual(expect.arrayContaining([
      { workspaceId: "workspace-a", threadId: "post-new", upToSequence: 4 },
      { workspaceId: "workspace-a", threadId: "lane", upToSequence: 9 },
    ]));
  });

  it("offers a person's chat only Mark as read and Archive", async () => {
    const user = userEvent.setup();
    bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [dm({ unreadCount: 1 })], pending: [], declined: [] });
    renderView(vi.fn(), vi.fn(), { userSettings: DEFAULT_USER_SETTINGS });

    fireEvent.contextMenu(await screen.findByTestId("chats-dm-item"), { clientX: 40, clientY: 60 });
    expect(menuLabels()).toEqual(["Mark as read", "Archive"]);
    await user.click(screen.getByTestId("chat-row-menu-mark-read"));
    await waitFor(() => expect(bridgeMock.markChatThreadRead).toHaveBeenCalledWith({
      workspaceId: "workspace-a", threadId: "thread-dm-1", upToSequence: Number.MAX_SAFE_INTEGER,
    }));
  });

  it("lets you leave a group shared with you, and never add people to it", async () => {
    const user = userEvent.setup();
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [channel({ id: "team", name: "team", slug: "team", wireId: "wire-team" })], fileThreads: [] });
    bridgeMock.listChatChannelShares.mockResolvedValue(shareListing({
      joined: [{ shareId: "share-in", channelWireId: "wire-team", access: "read-write", granterEmail: "owner@example.com", ended: false }],
    }));
    bridgeMock.leaveSharedChannel.mockResolvedValue(undefined);
    renderView(vi.fn(), vi.fn(), { userSettings: DEFAULT_USER_SETTINGS });

    await screen.findByTestId("chats-channel-shared");
    fireEvent.contextMenu(screen.getByTestId("chats-channel"), { clientX: 40, clientY: 60 });
    expect(menuLabels()).toEqual(["Archive", "Leave group"]);
    await user.click(screen.getByTestId("chat-row-menu-leave"));
    await waitFor(() => expect(bridgeMock.leaveSharedChannel).toHaveBeenCalledWith({ workspaceId: "workspace-a", shareId: "share-in" }));
  });

  it("adds people to a group from the sidebar", async () => {
    const user = userEvent.setup();
    renderView(vi.fn(), vi.fn(), { userSettings: DEFAULT_USER_SETTINGS });

    fireEvent.contextMenu(await screen.findByTestId("chats-channel"), { clientX: 40, clientY: 60 });
    await user.click(screen.getByTestId("chat-row-menu-add-people"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("general");
  });

  it("turns an agent off and removes it from its menu, with Undo bringing it back", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    const settings: DesktopUserSettings = {
      ...DEFAULT_USER_SETTINGS,
      agents: { default: testAgent({ name: "Nova" }), scout: testAgent({ name: "Ranger" }) },
    };
    const onSaveUserSettings = vi.fn(async () => undefined);
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel(), channel({ id: "chat-scout", name: "Scout", slug: "agent-scout", kind: "agent", agentId: "scout" })],
      fileThreads: [],
    });
    const { scout, ...withoutScout } = settings.agents;
    bridgeMock.getUserSettings.mockResolvedValue({ settings: { ...settings, agents: withoutScout } });
    bridgeMock.setUserSettings.mockResolvedValue({ settings });
    bridgeMock.orderAgents.mockResolvedValue({ settings });
    renderView(vi.fn(), vi.fn(), { userSettings: settings, onSaveUserSettings, onNotice, onSetupAgent: vi.fn() });

    const row = await screen.findByTestId("chats-my-agent");
    fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
    expect(menuLabels()).toEqual(["Agent settings", "Turn off", "Archive", "Remove agent"]);
    await user.click(screen.getByTestId("chat-row-menu-agent-power"));
    await waitFor(() => expect(onSaveUserSettings).toHaveBeenCalledOnce());
    expect(onSaveUserSettings.mock.lastCall).toEqual([
      { ...settings, agents: { ...settings.agents, scout: { ...scout, enabled: false } } }, settings,
    ]);

    fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
    await user.click(screen.getByTestId("chat-row-menu-remove-agent"));
    await waitFor(() => expect(onSaveUserSettings).toHaveBeenCalledTimes(2));
    expect(onSaveUserSettings.mock.lastCall).toEqual([{ ...settings, agents: withoutScout }, settings]);
    const [words, undo] = onNotice.mock.lastCall!;
    expect(words).toBe("Removed Ranger.");
    undo();
    await waitFor(() => expect(bridgeMock.orderAgents).toHaveBeenCalledWith({ order: ["default", "scout"] }));
    expect(bridgeMock.setUserSettings).toHaveBeenCalledWith({
      settings: { ...settings, agents: { ...withoutScout, scout } },
      base: { ...settings, agents: withoutScout },
    });
  });

  it("offers a removed agent's archived chat only Open Agents", async () => {
    const user = userEvent.setup();
    const onSetupAgent = vi.fn();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel(), channel({ id: "chat-codex", name: "Codex", slug: "agent-codex", kind: "agent", agentId: "codex" })],
      fileThreads: [],
    });
    renderView(vi.fn(), vi.fn(), {
      userSettings: settingsWithAgent({ name: "Nova" }),
      agentSetup: {
        workspaceId: "workspace-a", preferredName: "Sam", agentName: "Nova", runnerConfigured: true, runnerEnabled: true,
        agentRunActive: false, agents: [{ id: "default", name: "Nova", enabled: true }],
      },
      onSetupAgent,
      onSaveUserSettings: vi.fn(async () => undefined),
    });

    await user.click(await screen.findByTestId("chats-archived-toggle"));
    const codex = within(screen.getByTestId("chats-archived-list")).getByTestId("chats-my-agent");
    fireEvent.contextMenu(codex, { clientX: 40, clientY: 200 });
    expect(menuLabels()).toEqual(["Open Agents"]);
    await user.click(screen.getByTestId("chat-row-menu-open-agents"));
    expect(onSetupAgent).toHaveBeenCalledOnce();

    // Its open chat says why through the agent line, with no Unarchive it cannot use.
    await user.click(codex);
    expect((await screen.findByTestId("chats-agent-problem")).textContent).toContain("Codex was removed.");
    expect(screen.queryByTestId("chats-archived-line")).toBeNull();
  });
});
