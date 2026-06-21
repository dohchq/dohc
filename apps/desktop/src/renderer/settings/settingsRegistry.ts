import {
  Bot,
  Cloud,
  Keyboard,
  MonitorCog,
  Settings,
  Shield,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "General",
    scope: "User",
    keywords: ["workspace", "launch", "path", "version"],
    Icon: Settings,
  },
  {
    id: "appearance",
    label: "Appearance",
    scope: "User",
    keywords: ["theme", "density", "motion", "light", "dark", "system"],
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
    id: "agents",
    label: "Agents & MCP",
    scope: "Workspace",
    keywords: ["agent", "mcp", "claude", "codex", "server"],
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
    keywords: ["reset", "json", "diagnostics", "defaults"],
    Icon: Wrench,
  },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "general";

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}
