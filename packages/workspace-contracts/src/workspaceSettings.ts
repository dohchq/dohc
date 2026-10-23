import { z } from "zod";
import {
  ATTACHMENT_FOLDER_NAME_MAX_LENGTH,
  ATTACHMENT_LOCATIONS,
  WORKSPACE_PREVIEW_MODES,
  WORKSPACE_SETTINGS_DEFAULTS,
} from "./workspaceSettingsValues";

export { ATTACHMENT_FOLDER_NAME_MAX_LENGTH } from "./workspaceSettingsValues";

// The on-disk contract for `<workspace>/.dohc/local/settings.local.json`, the
// settings one computer keeps for a workspace.
//
// It lives here, not in the desktop app, so every reader parses the file
// through one schema.
export const WorkspaceSettings = z
  .object({
    version: z.literal(1),
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
    // Defaulted, not required, so settings written before this group existed
    // keep parsing as-is. The desktop reader turns off only a key it does not
    // know or cannot decode, never the whole file. Controls where
    // pasted/uploaded attachments (images/files) are saved,
    // modeled on Obsidian's "Default location for new attachments":
    //   per-document  — a subfolder next to the document (`<folder>/x.png`)
    //   global-folder — one folder at the workspace root (`../<folder>/x.png`)
    //   same-folder   — directly beside the document (`x.png`)
    // `attachmentFolderName` is the subfolder name (per-document) or root folder
    // name (global-folder); it is ignored for same-folder. Stored loosely (any
    // string) and sanitized to a single safe path segment at use time — an
    // invalid value falls back to "assets" rather than resetting the file.
    files: z
      .object({
        attachmentLocation: z.enum(ATTACHMENT_LOCATIONS),
        // The settings UI enforces the same bound on its input:
        // mergeWorkspaceSettings re-parses and throws on an over-long value,
        // and it is called straight from a React change handler.
        attachmentFolderName: z
          .string()
          .max(
            ATTACHMENT_FOLDER_NAME_MAX_LENGTH,
            `Attachment folder names must contain ${ATTACHMENT_FOLDER_NAME_MAX_LENGTH} characters or fewer.`,
          ),
      })
      .strict()
      .default(WORKSPACE_SETTINGS_DEFAULTS.files),
  })
  .strict();
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

export function decodeWorkspaceSettings(input: unknown): WorkspaceSettings {
  return WorkspaceSettings.parse(input);
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = WORKSPACE_SETTINGS_DEFAULTS;
