import { parseTab, TAB_KINDS } from "./renderer/workbench/workbenchState";

// Shared selector values for renderer producers and desktop e2e readers.
export const desktopPins = {
  aboutRail: "about-rail",
  activityBar: "activity-bar",
  settingsDialog: "settings-dialog",
  settingsEmptySearch: "settings-empty-search",
  settingsSearch: "settings-search",
  settingsWarning: "settings-warning",
  sidePanel: "side-panel",
  titlebar: "titlebar",
  titlebarAboutSidebar: "titlebar-about-sidebar",
} as const;

export const activityPin = (view: string): string => `activity-${view}`;
export const settingsNavPin = (section: string): string => `settings-nav-${section}`;
export const settingsSectionPin = (section: string): string => `settings-section-${section}`;

// The tab model is runtime-neutral; selector spelling is independent of persisted IDs.
function editorTabSelector(path: string, virtual: boolean): string {
  return virtual ? `tab-dohc://${path.slice("tab://".length)}` : `tab-${path}`;
}

export function editorTabTestId(path: string): string {
  return editorTabSelector(path, TAB_KINDS[parseTab(path).kind].virtual);
}

// Prefix readers cannot classify incomplete identities such as a channel without its ID.
export function editorTabPrefixPattern(path: string, virtual = false): RegExp {
  return new RegExp(`^${editorTabSelector(path, virtual).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}
