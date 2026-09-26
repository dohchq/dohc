import {
  DEFAULT_SIDEBAR_SETTINGS,
  MAX_PINNED_APPS,
  type DesktopUserSettings,
} from "./userSettings";

/** The apps this person pinned to the sidebar in one workspace, by folder. */
export function pinnedAppsFor(
  settings: DesktopUserSettings | null | undefined,
  workspaceId: string,
): readonly string[] {
  return (settings?.sidebar ?? DEFAULT_SIDEBAR_SETTINGS).pinnedApps[workspaceId] ?? [];
}

/**
 * The settings with one app pinned or unpinned in one workspace. Pins for
 * workspaces dohc no longer knows leave the file, and so does a workspace
 * whose last app is unpinned.
 */
export function withAppPinned(
  settings: DesktopUserSettings,
  change: { workspaceId: string; appRoot: string; pinned: boolean },
  knownWorkspaceIds: readonly string[],
): DesktopUserSettings {
  const current = pinnedAppsFor(settings, change.workspaceId);
  if (change.pinned && !current.includes(change.appRoot) && current.length >= MAX_PINNED_APPS) {
    throw new Error(`The sidebar holds ${MAX_PINNED_APPS} pinned apps. Unpin one first.`);
  }
  const next = change.pinned
    ? current.includes(change.appRoot) ? [...current] : [...current, change.appRoot]
    : current.filter((root) => root !== change.appRoot);
  const pinnedApps = Object.fromEntries(
    Object.entries({ ...settings.sidebar.pinnedApps, [change.workspaceId]: next })
      .filter(([workspaceId, roots]) =>
        roots.length > 0 && knownWorkspaceIds.includes(workspaceId)),
  );
  return { ...settings, sidebar: { ...settings.sidebar, pinnedApps } };
}
