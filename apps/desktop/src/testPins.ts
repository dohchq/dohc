import { isVirtualTabPath } from "./renderer/workbench/workbenchState";

// Shared selector values for renderer producers and desktop e2e readers.
export const desktopPins = {
  activityBar: "activity-bar",
  chatsPanel: "chats-panel",
  chatsPanelCollapse: "chats-panel-collapse",
  settingsDialog: "settings-dialog",
  settingsEmptySearch: "settings-empty-search",
  settingsSearch: "settings-search",
  settingsWarning: "settings-warning",
  titlebar: "titlebar",
  titlebarChatsSidebar: "titlebar-chats-sidebar",
} as const;

export const activityPin = (view: string): string => `activity-${view}`;
export const chatsPanelTabPin = (tab: string): string => `chats-panel-tab-${tab}`;
export const settingsNavPin = (section: string): string => `settings-nav-${section}`;
export const settingsSectionPin = (section: string): string => `settings-section-${section}`;

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
