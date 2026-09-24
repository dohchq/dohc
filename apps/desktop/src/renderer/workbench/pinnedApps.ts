import {
  DEFAULT_SIDEBAR_SETTINGS,
  MAX_PINNED_APPS,
  type DesktopUserSettings,
} from "../../settings/userSettings";

/** The apps this person pinned to the sidebar in one workspace. */
export function pinnedAppsFor(
  settings: DesktopUserSettings | null | undefined,
  workspaceId: string,
): readonly string[] {
  return (settings?.sidebar ?? DEFAULT_SIDEBAR_SETTINGS).pinnedApps[workspaceId] ?? [];
}

/**
 * The settings with one app pinned or unpinned in one workspace. A workspace
 * with no pinned apps leaves the file, so unpinning the last app removes its
 * entry instead of keeping an empty list.
 */
export function withAppPinned(
  settings: DesktopUserSettings,
  workspaceId: string,
  appRoot: string,
  pinned: boolean,
): DesktopUserSettings {
  const { [workspaceId]: current = [], ...others } = settings.sidebar.pinnedApps;
  if (pinned && !current.includes(appRoot) && current.length >= MAX_PINNED_APPS) {
    throw new Error(
      `The sidebar holds ${MAX_PINNED_APPS} pinned apps. Unpin one first.`,
    );
  }
  const next = pinned
    ? current.includes(appRoot) ? current : [...current, appRoot]
    : current.filter((root) => root !== appRoot);
  return {
    ...settings,
    sidebar: {
      ...settings.sidebar,
      pinnedApps: next.length > 0 ? { ...others, [workspaceId]: next } : others,
    },
  };
}

/** The name a pinned app shows in the sidebar: its folder. */
export function pinnedAppLabel(appRoot: string): string {
  return appRoot.split("/").filter(Boolean).at(-1) ?? appRoot;
}
