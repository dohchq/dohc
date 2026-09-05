import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { NonEmptyString } from "./baseSchemas";
import {
  ATTACHMENT_FOLDER_NAME_MAX_LENGTH,
  ATTACHMENT_LOCATIONS,
  DEFAULT_DRIVER_ID_MAX_LENGTH,
  DEFAULT_MODEL_MAX_LENGTH,
  WORKSPACE_PREVIEW_MODES,
  WORKSPACE_SETTINGS_DEFAULTS,
} from "./workspaceSettingsValues";

export { ATTACHMENT_FOLDER_NAME_MAX_LENGTH } from "./workspaceSettingsValues";

// The on-disk contract for `<workspace>/.dohc/settings.local.json`.
//
// It lives here, not in the desktop app, so every reader parses the file
// through one schema.

// The schema bound on `files.attachmentFolderName`. Exported because the
// settings UI must enforce the same bound on its input: mergeWorkspaceSettings
// re-parses and throws on an over-long value, and it is called straight from a
// React change handler — so an unbounded input would turn a long paste into an
// unhandled exception instead of a rejected edit.
const WorkspaceAgentsSettings = Schema.Struct({
  mcpAutoStart: Schema.Boolean,
  defaultDriverId: Schema.NullOr(
    NonEmptyString.check(
      Schema.isMaxLength(DEFAULT_DRIVER_ID_MAX_LENGTH, {
        message: `Default driver IDs must contain ${DEFAULT_DRIVER_ID_MAX_LENGTH} characters or fewer.`,
      }),
    ),
  ),
  defaultModel: Schema.NullOr(
    NonEmptyString.check(
      Schema.isMaxLength(DEFAULT_MODEL_MAX_LENGTH, {
        message: `Default models must contain ${DEFAULT_MODEL_MAX_LENGTH} characters or fewer.`,
      }),
    ),
  ),
}).mapFields(Struct.map(Schema.mutableKey));

const WorkspaceSitesSettings = Schema.Struct({
  defaultPreviewMode: Schema.Literals(WORKSPACE_PREVIEW_MODES),
}).mapFields(Struct.map(Schema.mutableKey));

const WorkspacePrivacySettings = Schema.Struct({
  confirmExternalLinks: Schema.Boolean,
}).mapFields(Struct.map(Schema.mutableKey));

const WorkspaceFilesSettings = Schema.Struct({
  attachmentLocation: Schema.Literals(ATTACHMENT_LOCATIONS),
  attachmentFolderName: Schema.String.check(
    Schema.isMaxLength(ATTACHMENT_FOLDER_NAME_MAX_LENGTH, {
      message: `Attachment folder names must contain ${ATTACHMENT_FOLDER_NAME_MAX_LENGTH} characters or fewer.`,
    }),
  ),
}).mapFields(Struct.map(Schema.mutableKey));

export const WorkspaceSettings = Schema.Struct({
  version: Schema.Literal(1),
  agents: WorkspaceAgentsSettings,
  sites: WorkspaceSitesSettings,
  privacy: WorkspacePrivacySettings,
  // Defaulted, not required: the top-level schema is .strict() and a failed
  // parse silently resets the whole file, so settings written before this
  // group existed must keep parsing as-is. Controls where pasted/uploaded
  // attachments (images/files) are saved,
  // modeled on Obsidian's "Default location for new attachments":
  //   per-document  — a subfolder next to the document (`<folder>/x.png`)
  //   global-folder — one folder at the workspace root (`../<folder>/x.png`)
  //   same-folder   — directly beside the document (`x.png`)
  // `attachmentFolderName` is the subfolder name (per-document) or root folder
  // name (global-folder); it is ignored for same-folder. Stored loosely (any
  // string) and sanitized to a single safe path segment at use time — an
  // invalid value falls back to "assets" rather than resetting the file.
  files: WorkspaceFilesSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(WORKSPACE_SETTINGS_DEFAULTS.files)),
  ),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkspaceSettings = typeof WorkspaceSettings.Type;

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = WORKSPACE_SETTINGS_DEFAULTS;
