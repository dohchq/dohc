import { z } from "zod";

export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const DENSITY_MODES = ["comfortable", "compact"] as const;
export type DensityMode = (typeof DENSITY_MODES)[number];

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
};

export type SettingsReadSource = "stored" | "default" | "recovered";

export const DesktopUserSettingsResult = z.object({
  settings: DesktopUserSettings,
  source: z.enum(["stored", "default", "recovered"]),
  warning: z.string().min(1).max(500).optional(),
}).strict();
export type DesktopUserSettingsResult = z.infer<typeof DesktopUserSettingsResult>;

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
  patch: Partial<DesktopUserSettings>,
): DesktopUserSettings {
  return DesktopUserSettings.parse({
    ...current,
    ...patch,
    appearance: { ...current.appearance, ...patch.appearance },
    general: { ...current.general, ...patch.general },
    editor: { ...current.editor, ...patch.editor },
    notifications: { ...current.notifications, ...patch.notifications },
  });
}

export function userSettingsModified(settings: DesktopUserSettings): boolean {
  return JSON.stringify(settings) !== JSON.stringify(DEFAULT_USER_SETTINGS);
}

export function effectiveThemeMode(
  mode: ThemeMode,
  prefersDark: boolean,
): "light" | "dark" {
  return mode === "system" ? (prefersDark ? "dark" : "light") : mode;
}
