import { z } from "zod";
import type { PreferredName } from "@dohc/workspace-contracts/chat-identity";
import {
  MAX_PREFERRED_NAME_LENGTH,
  hasPreferredNameControlCharacters,
} from "@dohc/workspace-contracts/chat-identity-values";

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

export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const DENSITY_MODES = ["comfortable", "compact"] as const;
export type DensityMode = (typeof DENSITY_MODES)[number];

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

export const RunnerSettings = z.object({
  command: z.string().max(4096),
  enabled: z.boolean(),
  timeoutMinutes: z.number().int().min(1).max(1440),
}).strict().refine(
  (runner) => !runner.enabled || runner.command.trim().length > 0,
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

export const DesktopUserSettings = z.object({
  version: z.literal(1),
  // Added after the original v1 settings shipped. The default makes old v1
  // files migrate in place instead of failing the strict top-level parse and
  // resetting unrelated preferences.
  profile: z.object({
    preferredName: PreferredNameForIpc.optional(),
  }).strict().default({}),
  appearance: z.object({
    themeMode: z.enum(THEME_MODES),
    density: z.enum(DENSITY_MODES),
    reduceMotion: z.boolean(),
    // Added after appearance shipped. The default migrates stored files in
    // place instead of failing the strict parse and resetting preferences.
    zoomLevel: z.number().int().min(MIN_ZOOM_LEVEL).max(MAX_ZOOM_LEVEL)
      .default(DEFAULT_ZOOM_LEVEL),
  }).strict(),
  general: z.object({
    launchBehavior: z.enum(["last-workspace", "workspace-picker", "new-workspace"]),
    defaultWorkspaceRoot: z.string().min(1).max(4096).optional(),
  }).strict(),
  editor: z.object({
    fontSize: z.number().int().min(11).max(24),
    lineWrap: z.boolean(),
    spellcheck: z.boolean(),
  }).strict(),
  notifications: z.object({
    updates: z.boolean(),
    agentRuns: z.boolean(),
  }).strict(),
  runner: RunnerSettings.default(DEFAULT_RUNNER_SETTINGS),
}).strict();
export type DesktopUserSettings = z.infer<typeof DesktopUserSettings>;

export const DEFAULT_USER_SETTINGS: DesktopUserSettings = {
  version: 1,
  profile: {},
  appearance: {
    themeMode: "system",
    density: "comfortable",
    reduceMotion: false,
    zoomLevel: DEFAULT_ZOOM_LEVEL,
  },
  general: {
    launchBehavior: "last-workspace",
  },
  editor: {
    fontSize: 15,
    lineWrap: true,
    spellcheck: true,
  },
  notifications: {
    updates: true,
    agentRuns: true,
  },
  runner: DEFAULT_RUNNER_SETTINGS,
};

export const SETTINGS_READ_SOURCES = ["stored", "default", "recovered"] as const;
export type SettingsReadSource = (typeof SETTINGS_READ_SOURCES)[number];

export const DesktopUserSettingsResult = z.object({
  settings: DesktopUserSettings,
  source: z.enum(SETTINGS_READ_SOURCES),
  warning: z.string().min(1).max(500).optional(),
}).strict();
export type DesktopUserSettingsResult = z.infer<typeof DesktopUserSettingsResult>;

export type DesktopUserSettingsPatch =
  Partial<Omit<DesktopUserSettings, "profile" | "appearance" | "general" | "editor" | "notifications" | "runner">> & {
    profile?: Partial<DesktopUserSettings["profile"]>;
    appearance?: Partial<DesktopUserSettings["appearance"]>;
    general?: Partial<DesktopUserSettings["general"]>;
    editor?: Partial<DesktopUserSettings["editor"]>;
    notifications?: Partial<DesktopUserSettings["notifications"]>;
    runner?: Partial<DesktopUserSettings["runner"]>;
  };

export function parseDesktopUserSettings(raw: unknown): DesktopUserSettings {
  const parsed = DesktopUserSettings.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_USER_SETTINGS;
}

export function desktopUserSettingsResult(
  raw: unknown,
  source: SettingsReadSource,
  warning?: string,
): DesktopUserSettingsResult {
  return {
    settings: parseDesktopUserSettings(raw),
    source,
    ...(warning ? { warning } : {}),
  };
}

export function mergeDesktopUserSettings(
  current: DesktopUserSettings,
  patch: DesktopUserSettingsPatch,
): DesktopUserSettings {
  return DesktopUserSettings.parse({
    ...current,
    ...patch,
    profile: { ...current.profile, ...patch.profile },
    appearance: { ...current.appearance, ...patch.appearance },
    general: { ...current.general, ...patch.general },
    editor: { ...current.editor, ...patch.editor },
    notifications: { ...current.notifications, ...patch.notifications },
    runner: { ...current.runner, ...patch.runner },
  });
}

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

export function userSettingsModified(settings: DesktopUserSettings): boolean {
  return !settingsDeepEqual(settings, DEFAULT_USER_SETTINGS);
}

export function effectiveThemeMode(
  mode: ThemeMode,
  prefersDark: boolean,
): "light" | "dark" {
  return mode === "system" ? (prefersDark ? "dark" : "light") : mode;
}
