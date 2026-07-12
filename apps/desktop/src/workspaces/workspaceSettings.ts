import { z } from "zod";
import {
  SETTINGS_READ_SOURCES,
  settingsDeepEqual,
} from "../settings/userSettings";

// The schema bound on `files.attachmentFolderName`. Exported because the
// settings UI must enforce the SAME bound on its input: mergeWorkspaceSettings
// re-parses and THROWS on an over-long value, and it is called straight from a
// React change handler — so an unbounded input would turn a long paste into an
// unhandled exception instead of a rejected edit.
export const ATTACHMENT_FOLDER_NAME_MAX_LENGTH = 100;

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
  // Defaulted like `experimental` above so settings files written before this
  // group existed keep parsing as-is (a failed parse silently resets the whole
  // file). Controls where pasted/uploaded attachments (images/files) are saved,
  // modeled on Obsidian's "Default location for new attachments":
  //   per-document  — a subfolder next to the document (`<folder>/x.png`)
  //   global-folder — one folder at the workspace root (`../<folder>/x.png`)
  //   same-folder   — directly beside the document (`x.png`)
  // `attachmentFolderName` is the subfolder name (per-document) or root folder
  // name (global-folder); it is ignored for same-folder. Stored loosely (any
  // string) and sanitized to a single safe path segment at use time — an
  // invalid value falls back to "assets" rather than resetting the file.
  files: z.object({
    attachmentLocation: z.enum(["per-document", "global-folder", "same-folder"]),
    attachmentFolderName: z.string().max(ATTACHMENT_FOLDER_NAME_MAX_LENGTH),
  }).strict().default({ attachmentLocation: "per-document", attachmentFolderName: "assets" }),
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
  files: {
    attachmentLocation: "per-document",
    attachmentFolderName: "assets",
  },
};

export const WorkspaceSettingsResult = z.object({
  settings: WorkspaceSettings,
  source: z.enum(SETTINGS_READ_SOURCES),
  warning: z.string().min(1).max(500).optional(),
}).strict();
export type WorkspaceSettingsResult = z.infer<typeof WorkspaceSettingsResult>;

export type WorkspaceSettingsPatch =
  Partial<Omit<WorkspaceSettings, "agents" | "sites" | "privacy" | "experimental" | "files">> & {
    agents?: Partial<WorkspaceSettings["agents"]>;
    sites?: Partial<WorkspaceSettings["sites"]>;
    privacy?: Partial<WorkspaceSettings["privacy"]>;
    experimental?: Partial<WorkspaceSettings["experimental"]>;
    files?: Partial<WorkspaceSettings["files"]>;
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
    files: { ...current.files, ...patch.files },
  });
}

export function workspaceSettingsModified(settings: WorkspaceSettings): boolean {
  return !settingsDeepEqual(settings, DEFAULT_WORKSPACE_SETTINGS);
}
