import { z } from "zod";

export const WorkspaceSettings = z.object({
  version: z.literal(1),
  agents: z.object({
    mcpAutoStart: z.boolean(),
    defaultDriverId: z.string().min(1).max(120).nullable(),
    defaultModel: z.string().min(1).max(200).nullable(),
  }).strict(),
  sites: z.object({
    defaultPreviewMode: z.enum(["auto", "static", "dev", "build"]),
  }).strict(),
  privacy: z.object({
    confirmExternalLinks: z.boolean(),
  }).strict(),
}).strict();
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  version: 1,
  agents: {
    mcpAutoStart: false,
    defaultDriverId: null,
    defaultModel: null,
  },
  sites: {
    defaultPreviewMode: "auto",
  },
  privacy: {
    confirmExternalLinks: true,
  },
};

export const WorkspaceSettingsResult = z.object({
  settings: WorkspaceSettings,
  source: z.enum(["stored", "default", "recovered"]),
  warning: z.string().min(1).max(500).optional(),
}).strict();
export type WorkspaceSettingsResult = z.infer<typeof WorkspaceSettingsResult>;

export function parseWorkspaceSettings(raw: unknown): WorkspaceSettings {
  const parsed = WorkspaceSettings.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_WORKSPACE_SETTINGS;
}

export function workspaceSettingsModified(settings: WorkspaceSettings): boolean {
  return JSON.stringify(settings) !== JSON.stringify(DEFAULT_WORKSPACE_SETTINGS);
}
