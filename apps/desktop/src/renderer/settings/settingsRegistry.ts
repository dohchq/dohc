import {
  Bot,
  Cloud,
  FolderOpen,
  Keyboard,
  MonitorCog,
  Settings,
  Shield,
  SlidersHorizontal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { shownShortcutNames } from "../../shortcuts/shortcutNames";

// The preload sets the bridge before the renderer loads, so search knows the
// shortcuts the Keyboard page lists here.
const desktop = globalThis.window?.dohcDesktop;

type SettingsScope = "User" | "Workspace" | "Mixed";

// Where a section sits in the nav: yours on every workspace, this workspace's
// under its folder, or Advanced on its own.
type SettingsGroup = "you" | "workspace" | "advanced";

type SettingsSection = {
  id: string;
  label: string;
  scope: SettingsScope;
  group: SettingsGroup;
  keywords: readonly string[];
  Icon: LucideIcon;
};

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "General",
    scope: "User",
    group: "you",
    keywords: ["workspace", "path", "version", "name", "identity"],
    Icon: Settings,
  },
  {
    id: "appearance",
    label: "Appearance",
    scope: "User",
    group: "you",
    keywords: ["theme", "light", "dark", "system", "zoom", "accent", "color", "font", "editor", "text", "size", "sidebar", "views", "order", "hide"],
    Icon: MonitorCog,
  },
  {
    id: "keyboard",
    label: "Keyboard",
    scope: "User",
    group: "you",
    // A search for the name of a shortcut the page lists, such as "bold", finds it.
    keywords: ["keyboard", "shortcut", "shortcuts", "keys", ...shownShortcutNames(desktop?.platform, desktop?.devTools ?? false)],
    Icon: Keyboard,
  },
  {
    id: "agents",
    label: "Agents",
    scope: "Mixed",
    group: "you",
    keywords: ["agent", "identity", "name", "mcp", "claude", "codex", "server", "runner", "dispatch", "timeout"],
    Icon: Bot,
  },
  {
    id: "files",
    label: "Files",
    scope: "Workspace",
    group: "workspace",
    keywords: ["attachment", "attachments", "image", "images", "assets", "paste", "upload", "folder"],
    Icon: FolderOpen,
  },
  {
    id: "workbench",
    label: "Workbench",
    scope: "Workspace",
    group: "workspace",
    keywords: ["layout", "tabs", "history", "sidebar", "recent", "apps", "preview"],
    Icon: SlidersHorizontal,
  },
  {
    id: "privacy",
    label: "Privacy",
    scope: "Mixed",
    group: "workspace",
    keywords: ["permission", "external", "links", "safety", "usage", "error", "reports", "telemetry", "diagnostics", "crash", "trust", "restricted", "mode"],
    Icon: Shield,
  },
  {
    id: "cloud",
    label: "Sync and sharing",
    scope: "Workspace",
    group: "workspace",
    keywords: ["sync", "share", "server", "connect", "cloud", "members"],
    Icon: Cloud,
  },
  {
    id: "advanced",
    label: "Advanced",
    scope: "Mixed",
    group: "advanced",
    keywords: ["reset", "json", "file", "diagnostics", "defaults", "experimental", "engine", "alpha", "schedule", "schedules", "computer"],
    Icon: Wrench,
  },
] as const satisfies readonly SettingsSection[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "general";

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}
