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
  },
  sites: {
    defaultPreviewMode: "auto",
  },
  privacy: {
    confirmExternalLinks: true,
  },
  files: {
    attachmentLocation: "per-document",
    attachmentFolderName: "assets",
  },
} as const;
