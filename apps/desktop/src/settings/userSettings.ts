import { z } from "zod";
import { AgentLaunchProfile, configuredRunnerCommand } from "../agents/agentToolCatalog";
import type { PreferredName } from "@dohc/workspace-contracts/chat-identity";
import {
  MAX_PREFERRED_NAME_LENGTH,
  hasPreferredNameControlCharacters,
} from "@dohc/workspace-contracts/chat-identity-values";
import { IDENTITY_HUES } from "../renderer/tokens";
import { VIEW_IDS } from "../renderer/workbench/workbenchState";
import { IgnoredSettings } from "./settingsFile";

const PreferredNameForIpc = z
  .string()
  .trim()
  .min(1, "Enter the name your agent should use.")
  .max(
    MAX_PREFERRED_NAME_LENGTH,
    `Names must contain ${MAX_PREFERRED_NAME_LENGTH} characters or fewer.`,
  )
  .refine((value) => !hasPreferredNameControlCharacters(value), {
    message: "Names cannot contain control characters.",
  }) satisfies z.ZodType<PreferredName>;

const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

// A color a person types into the file, such as "#3a7ee9". dohc adjusts it
// per theme so text on it stays readable (renderer/accentColor.ts).
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

// The editor's type: one of dohc's three bundled stacks, or the name of a
// font installed on this computer. The name becomes a quoted CSS family, so
// it holds only letters, digits, spaces, dots, dashes, and underscores.
export const EDITOR_FONTS = ["sans", "serif", "mono"] as const;
const InstalledFontName = z.string().max(100)
  .regex(/^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}])?$/u);

// Window zoom, stored as a Chromium zoom level like VS Code's
// window.zoomLevel: each step scales the window by 20% (factor 1.2^level).
export const MIN_ZOOM_LEVEL = -5;
export const MAX_ZOOM_LEVEL = 5;
export const DEFAULT_ZOOM_LEVEL = 0;

export function clampZoomLevel(level: number): number {
  if (!Number.isFinite(level)) return DEFAULT_ZOOM_LEVEL;
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, Math.round(level)));
}

export function zoomPercent(level: number): number {
  return Math.round(100 * Math.pow(1.2, level));
}

export const MIN_EDITOR_FONT_SIZE = 11;
export const MAX_EDITOR_FONT_SIZE = 24;

export const ZOOM_STEPS = ["in", "out", "reset"] as const;
export type ZoomStep = (typeof ZOOM_STEPS)[number];

export const RunnerSettings = z.object({
  command: z.string().max(4096),
  profile: AgentLaunchProfile.optional(),
  enabled: z.boolean(),
  timeoutMinutes: z.number().int().min(1).max(1440),
}).strict().refine(
  (runner) => !runner.enabled || configuredRunnerCommand(runner).length > 0,
  {
    message: "Runner command is required when dispatch is enabled.",
    path: ["command"],
  },
);
export type RunnerSettings = z.infer<typeof RunnerSettings>;

export const DEFAULT_RUNNER_SETTINGS: RunnerSettings = {
  command: "",
  enabled: false,
  timeoutMinutes: 30,
};

// Pins are kept per workspace, by workspace id, because an app is a folder in
// one workspace. They live in this file, not the workspace, because a pin is
// one person's choice on one computer: a collaborator never sees it.
export const MAX_PINNED_APPS = 20;
const MAX_PINNED_WORKSPACES = 200;
const PinnedAppsWorkspaceId = z.string().max(200).regex(/^[a-z0-9][a-z0-9-]*$/);

export const SidebarSettings = z.object({
  // dohc's own views in the order the sidebar shows them. A view the list
  // leaves out follows in dohc's order, so a new view still appears.
  order: z.array(z.enum(VIEW_IDS)).max(VIEW_IDS.length),
  hidden: z.array(z.enum(VIEW_IDS)).max(VIEW_IDS.length),
  // Each workspace's pinned apps, by the app's folder in that workspace.
  pinnedApps: z
    .record(PinnedAppsWorkspaceId, z.array(z.string().min(1).max(4096)).max(MAX_PINNED_APPS))
    .refine((pins) => Object.keys(pins).length <= MAX_PINNED_WORKSPACES, {
      message: `Pin apps in ${MAX_PINNED_WORKSPACES} workspaces or fewer.`,
    }),
}).strict();
export type SidebarSettings = z.infer<typeof SidebarSettings>;

export const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = {
  order: [],
  hidden: [],
  pinnedApps: {},
};

export const DesktopUserSettings = z.object({
  version: z.literal(1),
  // Added after the original v1 settings shipped. The default makes old v1
  // files migrate in place instead of failing the strict top-level parse and
  // resetting unrelated preferences.
  profile: z.object({
    preferredName: PreferredNameForIpc.optional(),
    agentName: PreferredNameForIpc.optional(),
  }).strict().default({}),
  appearance: z.object({
    themeMode: z.enum(THEME_MODES),
    // Added after appearance shipped. The default migrates stored files in
    // place instead of failing the strict parse and resetting preferences.
    zoomLevel: z.number().int().min(MIN_ZOOM_LEVEL).max(MAX_ZOOM_LEVEL)
      .default(DEFAULT_ZOOM_LEVEL),
    // null is dohc's own accent.
    accentColor: HexColor.nullable().default(null),
    // How this computer shows you and your agent in chat. They are not part
    // of your identity: every viewer picks each person's color itself, so a
    // collaborator still sees the color their computer picks for you. null is
    // the hue dohc picks from your name, and the agent color for your agent.
    yourColor: z.enum(IDENTITY_HUES).nullable().default(null),
    yourAgentColor: z.enum(IDENTITY_HUES).nullable().default(null),
  }).strict(),
  editor: z.object({
    fontFamily: z.union([z.enum(EDITOR_FONTS), InstalledFontName]).default("sans"),
    fontSize: z.number().int().min(MIN_EDITOR_FONT_SIZE).max(MAX_EDITOR_FONT_SIZE),
    lineWrap: z.boolean(),
    spellcheck: z.boolean(),
  }).strict(),
  runner: RunnerSettings.default(DEFAULT_RUNNER_SETTINGS),
  sidebar: SidebarSettings.default(DEFAULT_SIDEBAR_SETTINGS),
}).strict().refine((settings) => !settings.runner.enabled || Boolean(settings.profile.agentName), {
  message: "Enter an agent name before enabling dispatch.",
  path: ["profile", "agentName"],
});
export type DesktopUserSettings = z.infer<typeof DesktopUserSettings>;

export const DEFAULT_USER_SETTINGS: DesktopUserSettings = {
  version: 1,
  profile: {},
  appearance: {
    themeMode: "system",
    zoomLevel: DEFAULT_ZOOM_LEVEL,
    accentColor: null,
    yourColor: null,
    yourAgentColor: null,
  },
  editor: {
    fontFamily: "sans",
    fontSize: 15,
    lineWrap: true,
    spellcheck: true,
  },
  runner: DEFAULT_RUNNER_SETTINGS,
  sidebar: DEFAULT_SIDEBAR_SETTINGS,
};

export const SETTINGS_READ_SOURCES = ["stored", "default", "recovered"] as const;

export const DesktopUserSettingsResult = z.object({
  settings: DesktopUserSettings,
  source: z.enum(SETTINGS_READ_SOURCES),
  // Names the file, so it is bounded above a full path.
  warning: z.string().min(1).max(4600).optional(),
  ignored: IgnoredSettings.optional(),
}).strict();
export type DesktopUserSettingsResult = z.infer<typeof DesktopUserSettingsResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function settingsDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => settingsDeepEqual(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      settingsDeepEqual(left[key], right[key]),
    );
  }
  return false;
}

export function effectiveThemeMode(
  mode: ThemeMode,
  prefersDark: boolean,
): "light" | "dark" {
  return mode === "system" ? (prefersDark ? "dark" : "light") : mode;
}
