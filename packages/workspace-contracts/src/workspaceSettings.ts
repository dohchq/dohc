import { z } from "zod";

// The on-disk contract for `<workspace>/.dohc/settings.local.json`.
//
// It lives here, not in the desktop app, because TWO processes decide from it:
// the desktop resolves the engine capture at workspace open, and the MCP server
// decides whether a mutating tool may name a recorder. Both must answer "is
// this workspace opted out?" the same way, and a file that fails this schema
// reads as opted out in both. A hand-copied second schema is how those answers
// drift apart.

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

// The one verdict every reader asks of the file's parsed JSON.
//
// Three states, not two. A body the schema rejects may hold an opt-out we
// cannot read, so it is UNTRUSTED — never the engine-on default, and never the
// opt-out either: "the user turned the engine off" and "dohc could not tell"
// are different facts, and a reader that reports the first on the evidence for
// the second states something it did not establish (#641). Both states fail
// closed, so neither names a recorder.
export type WorkspaceEngineSetting =
  | { state: "on" }
  | { state: "off" }
  | { state: "untrusted"; cause: string };

export function workspaceEngineSetting(raw: unknown): WorkspaceEngineSetting {
  const parsed = WorkspaceSettings.safeParse(raw);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    if (!issue) return { state: "untrusted", cause: "the body does not match the schema" };
    const at = issue.path.join(".");
    return { state: "untrusted", cause: at ? `${at}: ${issue.message}` : issue.message };
  }
  return { state: parsed.data.experimental.workspaceEngineAlpha ? "on" : "off" };
}
