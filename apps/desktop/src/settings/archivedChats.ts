import {
  DEFAULT_SIDEBAR_SETTINGS,
  MAX_ARCHIVED_CHATS,
  type DesktopUserSettings,
} from "./userSettings";

/** The chats this person archived in one workspace, by chat id. */
export function archivedChatsFor(
  settings: DesktopUserSettings | null | undefined,
  workspaceId: string,
): readonly string[] {
  return (settings?.sidebar ?? DEFAULT_SIDEBAR_SETTINGS).archivedChats[workspaceId] ?? [];
}

/**
 * The settings with one chat archived or unarchived in one workspace.
 * Archived chats for workspaces dohc no longer knows leave the file, and so
 * does a workspace whose last chat is unarchived.
 */
export function withChatArchived(
  settings: DesktopUserSettings,
  change: { workspaceId: string; channelId: string; archived: boolean },
  knownWorkspaceIds: readonly string[],
): DesktopUserSettings {
  const current = archivedChatsFor(settings, change.workspaceId);
  if (change.archived && !current.includes(change.channelId) && current.length >= MAX_ARCHIVED_CHATS) {
    throw new Error(`Archived holds ${MAX_ARCHIVED_CHATS} chats in a workspace. Unarchive one first.`);
  }
  const next = change.archived
    ? current.includes(change.channelId) ? [...current] : [...current, change.channelId]
    : current.filter((id) => id !== change.channelId);
  const archivedChats = Object.fromEntries(
    Object.entries({ ...settings.sidebar.archivedChats, [change.workspaceId]: next })
      .filter(([workspaceId, ids]) => ids.length > 0 && knownWorkspaceIds.includes(workspaceId)),
  );
  return { ...settings, sidebar: { ...settings.sidebar, archivedChats } };
}
