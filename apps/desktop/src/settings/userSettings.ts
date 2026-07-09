import { z } from "zod";

export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const DENSITY_MODES = ["comfortable", "compact"] as const;
export type DensityMode = (typeof DENSITY_MODES)[number];

export const RunnerSettings = z.object({
  command: z.string().max(4096),
  enabled: z.boolean(),
  timeoutMinutes: z.number().int().min(1).max(1440),
}).strict();
export type RunnerSettings = z.infer<typeof RunnerSettings>;

export const DEFAULT_RUNNER_SETTINGS: RunnerSettings = {
  command: "",
  enabled: false,
  timeoutMinutes: 30,
};

export const DesktopUserSettings = z.object({
  version: z.literal(1),
  appearance: z.object({
    themeMode: z.enum(THEME_MODES),
    density: z.enum(DENSITY_MODES),
    reduceMotion: z.boolean(),
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
  appearance: {
    themeMode: "system",
    density: "comfortable",
    reduceMotion: false,
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
  Partial<Omit<DesktopUserSettings, "appearance" | "general" | "editor" | "notifications" | "runner">> & {
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
