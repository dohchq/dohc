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

export type SettingsScope = "User" | "Workspace" | "Mixed";

type SettingsSection = {
  id: string;
  label: string;
  scope: SettingsScope;
  keywords: readonly string[];
  Icon: LucideIcon;
};

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "General",
    scope: "User",
    keywords: ["workspace", "launch", "path", "version", "name", "identity"],
    Icon: Settings,
  },
  {
    id: "appearance",
    label: "Appearance",
    scope: "User",
    keywords: ["theme", "density", "motion", "light", "dark", "system", "zoom"],
    Icon: MonitorCog,
  },
  {
    id: "workbench",
    label: "Workbench",
    scope: "Workspace",
    keywords: ["layout", "tabs", "history", "sidebar", "recent"],
    Icon: SlidersHorizontal,
  },
  {
    id: "files",
    label: "Files",
    scope: "Workspace",
    keywords: ["attachment", "attachments", "image", "images", "assets", "paste", "upload", "folder"],
    Icon: FolderOpen,
  },
  {
    id: "agents",
    label: "Agents & MCP",
    scope: "Mixed",
    keywords: ["agent", "identity", "name", "mcp", "claude", "codex", "server", "runner", "dispatch", "timeout"],
    Icon: Bot,
  },
  {
    id: "cloud",
    label: "Cloud & Sync",
    scope: "Workspace",
    keywords: ["cloud", "sync", "members", "share"],
    Icon: Cloud,
  },
  {
    id: "privacy",
    label: "Privacy",
    scope: "Workspace",
    keywords: ["permission", "external", "links", "safety"],
    Icon: Shield,
  },
  {
    id: "keyboard",
    label: "Keyboard",
    scope: "User",
    keywords: ["shortcut", "command", "accelerator", "keys"],
    Icon: Keyboard,
  },
  {
    id: "advanced",
    label: "Advanced",
    scope: "Mixed",
    keywords: ["reset", "json", "diagnostics", "defaults", "experimental", "engine", "alpha"],
    Icon: Wrench,
  },
] as const satisfies readonly SettingsSection[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "general";

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}
