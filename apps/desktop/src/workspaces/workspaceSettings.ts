import { z } from "zod";
import {
  SETTINGS_READ_SOURCES,
  settingsDeepEqual,
} from "../settings/userSettings";

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
  // Defaulted, not required: the top-level schema is .strict() and a failed
  // parse silently resets the whole file, so settings written before this
  // group existed must keep parsing as-is (see the old-shape regression test).
  //
  // WS-H1 flag flip: the workspace engine is THE product default. An absent
  // experimental group (old settings files, brand-new workspaces) reads as
  // ON; the setting remains as an explicit opt-OUT escape hatch
  // (workspaceEngineAlpha: false). This schema default and
  // DEFAULT_WORKSPACE_SETTINGS below are the single source for the flip —
  // every reader (engineCaptureGate, MCP, renderer) resolves through them or
  // mirrors their absent-reads-as-on rule.
  experimental: z.object({
    workspaceEngineAlpha: z.boolean(),
  }).strict().default({ workspaceEngineAlpha: true }),
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
  experimental: {
    workspaceEngineAlpha: true,
  },
};

export const WorkspaceSettingsResult = z.object({
  settings: WorkspaceSettings,
  source: z.enum(SETTINGS_READ_SOURCES),
  warning: z.string().min(1).max(500).optional(),
}).strict();
export type WorkspaceSettingsResult = z.infer<typeof WorkspaceSettingsResult>;

export type WorkspaceSettingsPatch =
  Partial<Omit<WorkspaceSettings, "agents" | "sites" | "privacy" | "experimental">> & {
    agents?: Partial<WorkspaceSettings["agents"]>;
    sites?: Partial<WorkspaceSettings["sites"]>;
    privacy?: Partial<WorkspaceSettings["privacy"]>;
    experimental?: Partial<WorkspaceSettings["experimental"]>;
  };

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
  });
}

export function workspaceSettingsModified(settings: WorkspaceSettings): boolean {
  return !settingsDeepEqual(settings, DEFAULT_WORKSPACE_SETTINGS);
}
