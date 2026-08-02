import { z } from "zod";
import {
  ATTACHMENT_FOLDER_NAME_MAX_LENGTH,
  DEFAULT_WORKSPACE_SETTINGS,
  WorkspaceSettings,
} from "@dohc/workspace-contracts/workspace-settings";
import {
  SETTINGS_READ_SOURCES,
  settingsDeepEqual,
} from "../settings/userSettings";

// The settings-file schema is a two-process contract (desktop + MCP), so it
// lives in @dohc/workspace-contracts. Re-exported here because every desktop
// reader already imports it from this module.
export {
  ATTACHMENT_FOLDER_NAME_MAX_LENGTH,
  DEFAULT_WORKSPACE_SETTINGS,
  WorkspaceSettings,
};

export const WorkspaceSettingsResult = z.object({
  settings: WorkspaceSettings,
  source: z.enum(SETTINGS_READ_SOURCES),
  // Bounded above a full path, not above a sentence: an unreadable settings
  // file names its own path in the warning, and the IPC contract bounds a path
  // at 4096. A shorter bound would reject the warning and fail the whole read.
  warning: z.string().min(1).max(4600).optional(),
  // Set when a save was REFUSED because the file on disk cannot be read.
  // Same bound as the warning, and for the same reason: it names the path.
  refusal: z.string().min(1).max(4600).optional(),
}).strict();
export type WorkspaceSettingsResult = z.infer<typeof WorkspaceSettingsResult>;

// What a save carries: the controls the user actually changed, never the whole
// file. Main merges a patch onto the settings as they are on disk RIGHT NOW,
// so a caller holding a stale copy of the file (a Settings dialog opened
// before an external edit, or before the user repaired an unreadable file)
// can no longer write its stale copy back over fields it never touched.
export const WorkspaceSettingsPatch = z.object({
  agents: WorkspaceSettings.shape.agents.partial().optional(),
  sites: WorkspaceSettings.shape.sites.partial().optional(),
  privacy: WorkspaceSettings.shape.privacy.partial().optional(),
  experimental: WorkspaceSettings.shape.experimental.removeDefault().partial().optional(),
  files: WorkspaceSettings.shape.files.removeDefault().partial().optional(),
}).strict();
export type WorkspaceSettingsPatch = z.infer<typeof WorkspaceSettingsPatch>;

export function parseWorkspaceSettings(raw: unknown): WorkspaceSettings {
  const parsed = WorkspaceSettings.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_WORKSPACE_SETTINGS;
}

export function mergeWorkspaceSettings(
  current: WorkspaceSettings,
  patch: WorkspaceSettingsPatch,
): WorkspaceSettings {
  return WorkspaceSettings.parse({
    ...current,
    ...patch,
    agents: { ...current.agents, ...patch.agents },
    sites: { ...current.sites, ...patch.sites },
    privacy: { ...current.privacy, ...patch.privacy },
    experimental: { ...current.experimental, ...patch.experimental },
    files: { ...current.files, ...patch.files },
  });
}

export function workspaceSettingsModified(settings: WorkspaceSettings): boolean {
  return !settingsDeepEqual(settings, DEFAULT_WORKSPACE_SETTINGS);
}
