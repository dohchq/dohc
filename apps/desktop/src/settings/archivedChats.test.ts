import { describe, expect, it } from "vitest";
import { archivedChatsFor, hiddenChatsFor, withChatState } from "./archivedChats";
import { DEFAULT_USER_SETTINGS, DesktopUserSettings, MAX_ARCHIVED_CHATS } from "./userSettings";

const known = ["ws-a", "ws-b"];

describe("archived chats in the settings file", () => {
  it("archives and unarchives per workspace, and drops a workspace with none", () => {
    const one = withChatState(DEFAULT_USER_SETTINGS, { workspaceId: "ws-a", channelId: "c1", state: "archived" }, known);
    expect(archivedChatsFor(one, "ws-a")).toEqual(["c1"]);
    expect(archivedChatsFor(one, "ws-b")).toEqual([]);
    expect(withChatState(one, { workspaceId: "ws-a", channelId: "c1", state: "archived" }, known)).toEqual(one);

    const two = withChatState(one, { workspaceId: "ws-b", channelId: "c2", state: "archived" }, known);
    expect(two.sidebar.archivedChats).toEqual({ "ws-a": ["c1"], "ws-b": ["c2"] });
    expect(withChatState(two, { workspaceId: "ws-b", channelId: "c2", state: "active" }, known).sidebar.archivedChats)
      .toEqual({ "ws-a": ["c1"] });
  });

  it("keeps a chat in at most one list, and active takes it off both", () => {
    const archived = withChatState(DEFAULT_USER_SETTINGS, { workspaceId: "ws-a", channelId: "c1", state: "archived" }, known);
    const hidden = withChatState(archived, { workspaceId: "ws-a", channelId: "c1", state: "hidden" }, known);
    expect(archivedChatsFor(hidden, "ws-a")).toEqual([]);
    expect(hiddenChatsFor(hidden, "ws-a")).toEqual(["c1"]);

    const back = withChatState(hidden, { workspaceId: "ws-a", channelId: "c1", state: "active" }, known);
    expect(back.sidebar).toEqual(DEFAULT_USER_SETTINGS.sidebar);
  });

  it("drops chats for workspaces dohc no longer knows", () => {
    const stale = {
      ...DEFAULT_USER_SETTINGS,
      sidebar: { ...DEFAULT_USER_SETTINGS.sidebar, archivedChats: { "ws-gone": ["old"], "ws-a": ["c1"] }, hiddenChats: { "ws-gone": ["x"] } },
    };
    const next = withChatState(stale, { workspaceId: "ws-b", channelId: "c2", state: "archived" }, known);
    expect(next.sidebar.archivedChats).toEqual({ "ws-a": ["c1"], "ws-b": ["c2"] });
    expect(next.sidebar.hiddenChats).toEqual({});
  });

  it("refuses an archive past the limit with the way out", () => {
    const full = {
      ...DEFAULT_USER_SETTINGS,
      sidebar: {
        ...DEFAULT_USER_SETTINGS.sidebar,
        archivedChats: { "ws-a": Array.from({ length: MAX_ARCHIVED_CHATS }, (_, index) => `c${index}`) },
      },
    };
    expect(() => withChatState(full, { workspaceId: "ws-a", channelId: "one-more", state: "archived" }, known)).toThrow(
      `Archived holds ${MAX_ARCHIVED_CHATS} chats in a workspace. Unarchive one first.`,
    );
  });

  it("reads a settings file written before archiving existed", () => {
    const { archivedChats: _omitted, hiddenChats: _hidden, ...sidebar } = DEFAULT_USER_SETTINGS.sidebar;
    const parsed = DesktopUserSettings.parse({ ...DEFAULT_USER_SETTINGS, sidebar });
    expect(parsed.sidebar.archivedChats).toEqual({});
    expect(parsed.sidebar.hiddenChats).toEqual({});
  });
});
