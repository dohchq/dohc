import { describe, expect, it } from "vitest";
import { archivedChatsFor, withChatArchived } from "./archivedChats";
import { DEFAULT_USER_SETTINGS, DesktopUserSettings, MAX_ARCHIVED_CHATS } from "./userSettings";

const known = ["ws-a", "ws-b"];

describe("archived chats in the settings file", () => {
  it("archives and unarchives per workspace, and drops a workspace with none", () => {
    const one = withChatArchived(DEFAULT_USER_SETTINGS, { workspaceId: "ws-a", channelId: "c1", archived: true }, known);
    expect(archivedChatsFor(one, "ws-a")).toEqual(["c1"]);
    expect(archivedChatsFor(one, "ws-b")).toEqual([]);
    expect(withChatArchived(one, { workspaceId: "ws-a", channelId: "c1", archived: true }, known)).toEqual(one);

    const two = withChatArchived(one, { workspaceId: "ws-b", channelId: "c2", archived: true }, known);
    expect(two.sidebar.archivedChats).toEqual({ "ws-a": ["c1"], "ws-b": ["c2"] });
    expect(withChatArchived(two, { workspaceId: "ws-b", channelId: "c2", archived: false }, known).sidebar.archivedChats)
      .toEqual({ "ws-a": ["c1"] });
  });

  it("drops archived chats for workspaces dohc no longer knows", () => {
    const stale = {
      ...DEFAULT_USER_SETTINGS,
      sidebar: { ...DEFAULT_USER_SETTINGS.sidebar, archivedChats: { "ws-gone": ["old"], "ws-a": ["c1"] } },
    };
    expect(withChatArchived(stale, { workspaceId: "ws-b", channelId: "c2", archived: true }, known).sidebar.archivedChats)
      .toEqual({ "ws-a": ["c1"], "ws-b": ["c2"] });
  });

  it("refuses an archive past the limit with the way out", () => {
    const full = {
      ...DEFAULT_USER_SETTINGS,
      sidebar: {
        ...DEFAULT_USER_SETTINGS.sidebar,
        archivedChats: { "ws-a": Array.from({ length: MAX_ARCHIVED_CHATS }, (_, index) => `c${index}`) },
      },
    };
    expect(() => withChatArchived(full, { workspaceId: "ws-a", channelId: "one-more", archived: true }, known)).toThrow(
      `Archived holds ${MAX_ARCHIVED_CHATS} chats in a workspace. Unarchive one first.`,
    );
  });

  it("reads a settings file written before archiving existed", () => {
    const { archivedChats: _omitted, ...sidebar } = DEFAULT_USER_SETTINGS.sidebar;
    const parsed = DesktopUserSettings.parse({ ...DEFAULT_USER_SETTINGS, sidebar });
    expect(parsed.sidebar.archivedChats).toEqual({});
  });
});
