import { isVirtualTabPath } from "./renderer/workbench/workbenchState";

// Shared selector values for renderer producers and desktop e2e readers.
export const desktopPins = {
  activityBar: "activity-bar",
  activityPinnedApp: "activity-pinned-app",
  chatsPanel: "chats-panel",
  chatsPanelCollapse: "chats-panel-collapse",
  chatsPanelResize: "chats-panel-resize",
  settingsDialog: "settings-dialog",
  settingsEmptySearch: "settings-empty-search",
  settingsLoading: "settings-loading",
  settingsSaveState: "settings-save-state",
  settingsSearch: "settings-search",
  settingsSidebar: "settings-sidebar",
  settingsWarning: "settings-warning",
  sidePanel: "side-panel",
  sidebarResize: "sidebar-resize",
  titlebar: "titlebar",
  titlebarChatsSidebar: "titlebar-chats-sidebar",
  titlebarLayoutControls: "titlebar-layout-controls",
  titlebarLeftGroup: "titlebar-left-group",
  titlebarPrimarySidebar: "titlebar-primary-sidebar",
  titlebarQuickOpen: "titlebar-quick-open",
} as const;

export const activityPin = (view: string): string => `activity-${view}`;
export const activityCountPin = (testId: string): string => `${testId}-count`;
export const chatsPanelTabPin = (tab: string): string => `chats-panel-tab-${tab}`;
export const settingsNavPin = (section: string): string => `settings-nav-${section}`;
export const settingsSectionPin = (section: string): string => `settings-section-${section}`;
export const settingsRowPin = (row: string): string => `settings-row-${row}`;

// The tab model is runtime-neutral; selector spelling is independent of persisted IDs.
function editorTabSelector(path: string, virtual: boolean): string {
  return virtual ? `tab-dohc://${path.slice("tab://".length)}` : `tab-${path}`;
}

export function editorTabTestId(path: string): string {
  return editorTabSelector(path, isVirtualTabPath(path));
}

// Prefix readers cannot classify incomplete identities such as a channel without its ID.
export function editorTabPrefixPattern(path: string, virtual = false): RegExp {
  return new RegExp(`^${editorTabSelector(path, virtual).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}
