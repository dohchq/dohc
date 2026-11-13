import "../../testing/legendListMock";
// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../../settings/userSettings";
import { settingsWithAgent } from "../../testing/agentSettings";
import { bridgeMock, channel, ChatsView, dm, renderView } from "./ChatsView.testHarness";
import { resetChosenColorsForTests, setPersonalAgents } from "./chosenColors";

function archived(settings: DesktopUserSettings, ...channelIds: string[]): DesktopUserSettings {
  return {
    ...settings,
    sidebar: { ...settings.sidebar, archivedChats: { "workspace-a": channelIds } },
  };
}

function menuLabels() {
  return within(screen.getByTestId("chat-row-menu"))
    .getAllByRole("menuitem")
    .map((item) => item.textContent);
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

    expect(bridgeMock.setChatArchived).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace-a",
      channelId: "channel-1",
      state: "archived",
    });
    await waitFor(() => expect(onNotice).toHaveBeenCalledOnce());
    const [words, undo] = onNotice.mock.lastCall!;
    expect(words).toBe("Archived general");
    undo();
    await waitFor(() =>
      expect(bridgeMock.setChatArchived).toHaveBeenLastCalledWith({
        workspaceId: "workspace-a",
        channelId: "channel-1",
        state: "active",
      }),
    );
    expect(screen.queryByTestId("chat-row-menu")).toBeNull();
  });

  it("keeps an archived chat archived when a message arrives, and marks Archived instead", async () => {
    const user = userEvent.setup();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [
        channel(),
        channel({ id: "channel-trip", name: "trip", slug: "trip", unreadCount: 2 }),
      ],
      fileThreads: [],
    });
    bridgeMock.setChatArchived.mockResolvedValue({ settings: DEFAULT_USER_SETTINGS });
    renderView(vi.fn(), vi.fn(), { userSettings: archived(DEFAULT_USER_SETTINGS, "channel-trip") });

    await screen.findByTestId("chats-archived-section");
    expect(screen.getAllByTestId("chats-channel-name").map((name) => name.textContent)).toEqual([
      "general",
    ]);
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
    expect(bridgeMock.setChatArchived).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace-a",
      channelId: "channel-trip",
      state: "active",
    });
  });

  it("drops a Mark as read that finishes after the window changed workspaces", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    bridgeMock.markChatThreadRead.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    bridgeMock.syncDms.mockResolvedValue({
      available: true,
      dms: [dm({ unreadCount: 1 })],
      pending: [],
      declined: [],
    });
    const onDmRead = vi.fn();
    const props = {
      workspaces: [
        { workspaceId: "workspace-a", label: "Work" },
        { workspaceId: "workspace-b", label: "Personal" },
      ],
      onOpenFileChat: vi.fn(),
      onError: vi.fn(),
      userSettings: DEFAULT_USER_SETTINGS,
      onDmRead,
    };
    const view = render(<ChatsView workspaceId="workspace-a" {...props} />);

    fireEvent.contextMenu(await screen.findByTestId("chats-dm-item"), { clientX: 40, clientY: 60 });
    await user.click(screen.getByTestId("chat-row-menu-mark-read"));
    await waitFor(() => expect(bridgeMock.markChatThreadRead).toHaveBeenCalledOnce());
    view.rerender(<ChatsView workspaceId="workspace-b" {...props} />);
    await waitFor(() =>
      expect(bridgeMock.listChatChannels).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspaceId: "workspace-b" }),
      ),
    );
    const workspaceACalls = () =>
      bridgeMock.listChatChannels.mock.calls.filter(
        ([input]) => input.workspaceId === "workspace-a",
      ).length;
    const before = workspaceACalls();

    await act(async () => finish());
    expect(onDmRead).not.toHaveBeenCalled();
    expect(workspaceACalls()).toBe(before);
  });

  it("takes a removed agent's chat off Archived after asking, with Undo", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    bridgeMock.setChatArchived.mockResolvedValue({ settings: DEFAULT_USER_SETTINGS });
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [
        channel(),
        channel({
          id: "chat-codex",
          name: "Codex",
          slug: "agent-codex",
          kind: "agent",
          agentId: "codex",
        }),
      ],
      fileThreads: [],
    });
    const settings = settingsWithAgent({ name: "Nova" });
    const { unmount } = renderView(vi.fn(), vi.fn(), {
      userSettings: settings,
      onNotice,
      onSetupAgent: vi.fn(),
    });

    await user.click(await screen.findByTestId("chats-archived-toggle"));
    fireEvent.contextMenu(
      within(screen.getByTestId("chats-archived-list")).getByTestId("chats-my-agent"),
      { clientX: 40, clientY: 200 },
    );
    await user.click(screen.getByTestId("chat-row-menu-hide-chat"));
    const dialog = within(screen.getByTestId("hide-agent-chat-dialog"));
    expect(dialog.getByText("Remove Codex's chat from the list?")).toBeTruthy();
    expect(bridgeMock.setChatArchived).not.toHaveBeenCalled();
    await user.click(dialog.getByRole("button", { name: "Remove from list" }));
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(
        "Removed Codex's chat from the list.",
        expect.any(Function),
      ),
    );
    expect(bridgeMock.setChatArchived).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace-a",
      channelId: "chat-codex",
      state: "hidden",
    });

    onNotice.mock.lastCall![1]();
    await waitFor(() =>
      expect(bridgeMock.setChatArchived).toHaveBeenLastCalledWith({
        workspaceId: "workspace-a",
        channelId: "chat-codex",
        state: "active",
      }),
    );

    // With the settings saying so, Archived has nothing left to show.
    unmount();
    renderView(vi.fn(), vi.fn(), {
      userSettings: {
        ...settings,
        sidebar: { ...settings.sidebar, hiddenChats: { "workspace-a": ["chat-codex"] } },
      },
      onSetupAgent: vi.fn(),
    });
    await screen.findByTestId("chats-channel");
    expect(screen.queryByTestId("chats-archived-toggle")).toBeNull();
  });

  it("keeps a personal agent's chat in the sidebar while your roster holds it, and archives it once removed", async () => {
    const grok = `p-${"g".repeat(26)}`;
    onTestFinished(resetChosenColorsForTests);
    setPersonalAgents([{ agentId: grok, name: "Grok", hue: "teal" }]);
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [
        channel(),
        channel({
          id: "chat-grok",
          name: "Grok",
          slug: "agent-grok",
          kind: "agent",
          agentId: grok,
        }),
      ],
      fileThreads: [],
    });
    renderView(vi.fn(), vi.fn(), {
      userSettings: settingsWithAgent({ name: "Nova" }),
      agentSetup: {
        workspaceId: "workspace-a",
        preferredName: "Sam",
        agentName: "Nova",
        runnerConfigured: true,
        runnerEnabled: true,
        agentRunActive: false,
        agents: [{ id: "default", name: "Nova", enabled: true }],
      },
      onSetupAgent: vi.fn(),
    });
    await waitFor(() =>
      expect(
        screen.getAllByTestId("chats-my-agent").some((row) => row.textContent?.includes("Grok")),
      ).toBe(true),
    );
    expect(screen.queryByTestId("chats-archived-toggle")).toBeNull();
    // Open, it names no problem: Settings doesn't list a personal agent.
    fireEvent.click(
      screen.getAllByTestId("chats-my-agent").find((row) => row.textContent?.includes("Grok"))!,
    );
    await screen.findByRole("button", { name: "Grok settings" });
    expect(screen.queryByTestId("chats-agent-problem")).toBeNull();

    act(() => setPersonalAgents([]));
    expect((await screen.findByTestId("chats-agent-problem")).textContent).toContain(
      "Grok was removed.",
    );
  });
});
