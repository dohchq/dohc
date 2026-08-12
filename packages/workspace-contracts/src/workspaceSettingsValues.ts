export const DEFAULT_DRIVER_ID_MAX_LENGTH = 120;
export const DEFAULT_MODEL_MAX_LENGTH = 200;
export const ATTACHMENT_FOLDER_NAME_MAX_LENGTH = 100;

export const WORKSPACE_PREVIEW_MODES = ["auto", "static", "dev", "build"] as const;
export const ATTACHMENT_LOCATIONS = [
  "per-document",
  "global-folder",
  "same-folder",
] as const;

export const WORKSPACE_SETTINGS_DEFAULTS = {
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
} as const;
