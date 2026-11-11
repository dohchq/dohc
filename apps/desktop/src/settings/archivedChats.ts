import {
  DEFAULT_SIDEBAR_SETTINGS,
  MAX_ARCHIVED_CHATS,
  type DesktopUserSettings,
} from "./userSettings";

/**
 * Where one chat sits in this person's sidebar: in its list, in Archived, or
 * off both, which only a removed agent's chat can be.
 */
export type ChatListState = "active" | "archived" | "hidden";

/** The chats this person archived in one workspace, by chat id. */
export function archivedChatsFor(
  settings: DesktopUserSettings | null | undefined,
  workspaceId: string,
): readonly string[] {
  return (settings?.sidebar ?? DEFAULT_SIDEBAR_SETTINGS).archivedChats[workspaceId] ?? [];
}

/** The removed agents' chats this person took off Archived in one workspace, by chat id. */
export function hiddenChatsFor(
  settings: DesktopUserSettings | null | undefined,
  workspaceId: string,
): readonly string[] {
  return (settings?.sidebar ?? DEFAULT_SIDEBAR_SETTINGS).hiddenChats[workspaceId] ?? [];
}

/**
 * The settings with one chat moved to `state` in one workspace. A chat is in
 * at most one of the two lists. Entries for workspaces dohc no longer knows
 * leave the file, and so does a workspace whose list is empty.
 */
export function withChatState(
  settings: DesktopUserSettings,
  change: { workspaceId: string; channelId: string; state: ChatListState },
  knownWorkspaceIds: readonly string[],
): DesktopUserSettings {
  const { workspaceId, channelId, state } = change;
  const archived = archivedChatsFor(settings, workspaceId);
  const hidden = hiddenChatsFor(settings, workspaceId);
  const limit = state === "archived" ? archived : state === "hidden" ? hidden : null;
  if (limit !== null && !limit.includes(channelId) && limit.length >= MAX_ARCHIVED_CHATS) {
    throw new Error(state === "archived"
      ? `Archived holds ${MAX_ARCHIVED_CHATS} chats in a workspace. Unarchive one first.`
      : `dohc can take ${MAX_ARCHIVED_CHATS} chats off Archived in a workspace.`);
  }
  const place = (current: readonly string[], keep: boolean) =>
    keep ? current.includes(channelId) ? [...current] : [...current, channelId] : current.filter((id) => id !== channelId);
  const prune = (lists: Record<string, string[]>) => Object.fromEntries(
    Object.entries(lists).filter(([id, ids]) => ids.length > 0 && knownWorkspaceIds.includes(id)),
  );
  return {
    ...settings,
    sidebar: {
      ...settings.sidebar,
      archivedChats: prune({ ...settings.sidebar.archivedChats, [workspaceId]: place(archived, state === "archived") }),
      hiddenChats: prune({ ...settings.sidebar.hiddenChats, [workspaceId]: place(hidden, state === "hidden") }),
    },
  };
}
