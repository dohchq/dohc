import { z } from "zod";
import type { WorkspaceSettings as ContractWorkspaceSettings } from "@dohc/workspace-contracts/workspace-settings";
import {
  ATTACHMENT_FOLDER_NAME_MAX_LENGTH,
  ATTACHMENT_LOCATIONS,
  DEFAULT_DRIVER_ID_MAX_LENGTH,
  DEFAULT_MODEL_MAX_LENGTH,
  WORKSPACE_PREVIEW_MODES,
  WORKSPACE_SETTINGS_DEFAULTS,
} from "@dohc/workspace-contracts/workspace-settings-values";
import {
  SETTINGS_READ_SOURCES,
  settingsDeepEqual,
} from "../settings/userSettings";

// Preload and renderer keep zod at their existing IPC boundary. The main-only
// settings file reader validates the on-disk contract with Effect Schema.
export {
  ATTACHMENT_FOLDER_NAME_MAX_LENGTH,
};

export const DEFAULT_WORKSPACE_SETTINGS: ContractWorkspaceSettings = WORKSPACE_SETTINGS_DEFAULTS;

export const WorkspaceSettings = z
  .object({
    version: z.literal(1),
    agents: z
      .object({
        mcpAutoStart: z.boolean(),
        defaultDriverId: z.string().min(1).max(DEFAULT_DRIVER_ID_MAX_LENGTH).nullable(),
        defaultModel: z.string().min(1).max(DEFAULT_MODEL_MAX_LENGTH).nullable(),
      })
      .strict(),
    sites: z
      .object({
        defaultPreviewMode: z.enum(WORKSPACE_PREVIEW_MODES),
      })
      .strict(),
    privacy: z
      .object({
        confirmExternalLinks: z.boolean(),
      })
      .strict(),
    experimental: z
      .object({
        workspaceEngineAlpha: z.boolean(),
      })
      .strict()
      .default(WORKSPACE_SETTINGS_DEFAULTS.experimental),
    files: z
      .object({
        attachmentLocation: z.enum(ATTACHMENT_LOCATIONS),
        attachmentFolderName: z.string().max(ATTACHMENT_FOLDER_NAME_MAX_LENGTH),
      })
      .strict()
      .default(WORKSPACE_SETTINGS_DEFAULTS.files),
  })
  .strict() satisfies z.ZodType<ContractWorkspaceSettings>;
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

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
