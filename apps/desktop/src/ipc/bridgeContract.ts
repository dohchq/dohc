import {
  WORKSPACE_KINDS,
  WORKSPACE_MODES,
} from "@dohc/workspace-core";
import { z } from "zod";
import {
  MAX_EXPANDED_FOLDERS,
  MAX_OPEN_TABS,
  MAX_PINNED_PATHS,
  MAX_RECENT_FILES,
  CHATS_MAX_WIDTH,
  CHATS_MIN_WIDTH,
  OPEN_EDITORS_MAX_HEIGHT,
  OPEN_EDITORS_MIN_HEIGHT,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  RETIRED_VIEW_IDS,
  VIEW_IDS,
} from "../renderer/workbench/workbenchState";
import {
  EXPLORER_MENU_COMMANDS,
  MENU_COMMANDS,
  ENGINE_YDOC_SESSION_ID_MAX_CHARS,
  ENGINE_YDOC_UPDATE_MAX_BYTES,
  SEARCH_EVENT_MAX_ENTRIES,
  SEARCH_EVENT_MAX_ID_CHARS,
  SEARCH_EVENT_MAX_PREVIEW_CHARS,
  UPDATE_CHANNELS,
  UPDATE_STATUSES,
  WORKBENCH_MENU_COMMANDS,
  ENGINE_YDOC_SAVE_STATES,
  type EngineYDocRemoteUpdateEvent,
  type EngineYDocSaveStateEvent,
  type SearchResultsEvent,
} from "./channels";
import { isLoopbackHostname } from "../security/loopback";
import {
  DesktopUserSettings as DesktopUserSettingsSchema,
  DesktopUserSettingsResult as DesktopUserSettingsResultSchema,
} from "../settings/userSettings";
import type {
  DesktopUserSettings as DesktopUserSettingsType,
  DesktopUserSettingsResult as DesktopUserSettingsResultType,
} from "../settings/userSettings";
import {
  WorkspaceSettings as WorkspaceSettingsSchema,
  WorkspaceSettingsPatch as WorkspaceSettingsPatchSchema,
  WorkspaceSettingsResult as WorkspaceSettingsResultSchema,
} from "../workspaces/workspaceSettings";
import type {
  WorkspaceSettings as WorkspaceSettingsType,
  WorkspaceSettingsResult as WorkspaceSettingsResultType,
} from "../workspaces/workspaceSettings";

// Typed contract for everything the preload bridge exposes. Main-process
// handlers validate payloads on arrival and results before returning them.
// The renderer never sees raw Electron APIs.

// Length caps: IPC payloads are untrusted; bound every renderer-supplied
// string so a hostile/buggy caller cannot cause memory/latency pressure.
// workspaceId doubles as the dohc-file:// URL HOSTNAME, so it must be
// hostname-safe and lowercase (URL hostnames lowercase silently — a
// case-variant id would break asset serving or alias another workspace).
// Our own ids are UUIDs; a foreign manifest with any other shape is rejected
// at attach time with a visible error.
const WORKSPACE_ID = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "workspace id must be lowercase alphanumeric/hyphens");
const PATH_STRING = z.string().min(1).max(4096);

// Stored-body fields are the exception to the caps above. Every RESPONSE field
// on this schema carries text the ENGINE already accepted, not text a renderer
// supplied. The engine accepts a text write up to MAX_TEXT_BYTES — 10 MiB of
// UTF-8 (`crates/dohc-engine-domain/src/store.rs`) — and it never gates a
// settle on the smaller in-band response cap
// (`crates/dohc-engine-runtime/src/actor.rs` settle), so an over-cap document
// lands on disk like any other. The bound below is the engine's own, so the
// bridge is never the gate that rejects a stored body. Zod counts UTF-16 code
// units and UTF-8 never spends less than one byte per code unit, so this
// character bound admits every body the engine could hold.
//
// Matching the STORAGE contract does not promise that every stored body
// arrives. The daemon caps one wire string at 8 MiB (`WireLimits`,
// `crates/dohc-engine-protocol/src/limits.rs`), so a larger body reaches the
// renderer only by blob hydration. `versionedText.read` and the moment
// timeline hydrate, compare rows inherit that through `listTextFiles`, and
// conflict listing hydrates its withheld sides too (#537) — see VERSION_TEXT.
//
// One REQUEST field shares the schema — the combined conflict resolution at
// VERSION_TEXT. There this bound is only a ceiling on what crosses IPC; the
// engine owns the real limit and re-checks it.
export const ENGINE_TEXT_MAX_CHARS = 10 * 1024 * 1024;
function engineStoredText(label: string) {
  return z.string().superRefine((text, ctx) => {
    if (text.length <= ENGINE_TEXT_MAX_CHARS) return;
    ctx.addIssue({
      code: "custom",
      message:
        `${label} is ${text.length} characters; the IPC bridge carries at most ` +
        `${ENGINE_TEXT_MAX_CHARS} characters (the engine's 10 MiB UTF-8 text cap)`,
    });
  });
}

const SITE_ROOT_STRING = PATH_STRING.superRefine((value, ctx) => {
  if (
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value
      .split("/")
      .some((segment) => segment === "" || segment === ".." || (segment === "." && value !== "."))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "site root must be a safe workspace-relative path",
    });
  }
});

// Enums derive from the workspace-core tuples (single source of truth) so a
// new kind/mode cannot make the type and the runtime validator disagree.
const KIND_ENUM = z.enum(WORKSPACE_KINDS);
const MODE_ENUM = z.enum(WORKSPACE_MODES);

export const PickWorkspaceRootResult = PATH_STRING.nullable();
export type PickWorkspaceRootResult = z.infer<typeof PickWorkspaceRootResult>;

// Ops a share pull skipped, and why. Durable state, not a status: the pull
// commits its cursor past a refused op, so that content never arrives again
// unless the granter writes the same path a second time.
export const ShareSkippedOpsSummary = z.object({
  ops: z
    .array(
      z.object({
        originId: z.string().min(1).max(512),
        originSeq: z.number().int().nonnegative(),
        opKind: z.string().min(1).max(128),
        code: z.string().min(1).max(128),
        detail: z.string().min(1).max(2048),
        atMs: z.number().int().nonnegative(),
      }),
    )
    .max(20),
  more: z.number().int().nonnegative(),
  // Bumped whenever a pull adds a skipped op. A dismissal names the
  // generation the user saw, so a refusal recorded between the render and the
  // click survives it.
  generation: z.number().int().nonnegative(),
  // The generation the user has seen. Dismissing raises this and deletes
  // nothing, so the warning is hidden while the evidence stays.
  acknowledgedGeneration: z.number().int().nonnegative().optional(),
  // `more` may over-report past the tracked-origin bound; the copy says "at
  // least" rather than a number it cannot stand behind.
  inexact: z.boolean().optional(),
});
export type ShareSkippedOpsSummary = z.infer<typeof ShareSkippedOpsSummary>;

export const WorkspaceSummary = z.object({
  workspaceId: WORKSPACE_ID,
  rootPath: PATH_STRING,
  kind: KIND_ENUM,
  mode: MODE_ENUM,
  // Present only on a shared VIEW received through a relay share grant
  // (PR 18): the workspace is read-only, refreshed from the share, and
  // carries who shared it for honest copy. `ended` marks a revoked share.
  shareView: z
    .object({
      shareId: z.string().min(1).max(200),
      granterEmail: z.string().min(3).max(320).nullable(),
      ended: z.boolean().optional(),
      skippedOps: ShareSkippedOpsSummary.optional(),
    })
    .optional(),
  // Share mounts: received shares materialized into this workspace's
  // shared-with-me/<label>/ as ordinary read-only files. `ended` marks a
  // revoked share (the mounted copy stays readable, stops refreshing).
  shareMounts: z
    .array(
      z.object({
        shareId: z.string().min(1).max(200),
        label: z.string().min(1).max(64),
        granterEmail: z.string().min(3).max(320).nullable(),
        ended: z.boolean().optional(),
        skippedOps: ShareSkippedOpsSummary.optional(),
      }),
    )
    .max(200)
    .optional(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const WorkspaceRegistryResult = z.object({
  workspaces: z.array(WorkspaceSummary),
});
export type WorkspaceRegistryResult = z.infer<typeof WorkspaceRegistryResult>;

export const DefaultWorkspaceRootResult = PATH_STRING;

export const CreateLocalWorkspacePayload = z.object({
  rootPath: PATH_STRING,
  kind: z.enum(["personal", "shared"]),
});
export type CreateLocalWorkspacePayload = z.infer<
  typeof CreateLocalWorkspacePayload
>;

export const AttachWorkspaceFolderPayload = z.object({
  rootPath: PATH_STRING,
});
export type AttachWorkspaceFolderPayload = z.infer<
  typeof AttachWorkspaceFolderPayload
>;

export const ListWorkspaceFilesPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type ListWorkspaceFilesPayload = z.infer<
  typeof ListWorkspaceFilesPayload
>;

export const WorkspaceFileEntry = z.object({
  path: PATH_STRING,
  kind: z.enum(["file", "database"]),
  // Optional page emoji, read from the file's `icon` frontmatter key. The
  // explorer shows it in place of the generic file glyph. Read-only metadata,
  // bounded on the main side; absent for files without an icon.
  icon: z.string().max(64).optional(),
});
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntry>;

export const ListWorkspaceFilesResult = z.object({
  files: z.array(WorkspaceFileEntry),
  // Additive (Phase E3 explorer): directories ride along so EMPTY folders
  // appear in the tree. Optional so older fixtures/consumers keep parsing;
  // the main-side walk always provides it.
  folders: z.array(PATH_STRING).optional(),
});
export type ListWorkspaceFilesResult = z.infer<typeof ListWorkspaceFilesResult>;

export const CreateWorkspaceFilePayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type CreateWorkspaceFilePayload = z.infer<
  typeof CreateWorkspaceFilePayload
>;

export const CreateWorkspaceFileResult = z.object({
  path: PATH_STRING,
});
export type CreateWorkspaceFileResult = z.infer<
  typeof CreateWorkspaceFileResult
>;

// Phase E3 file-management surfaces. Every op mirrors createWorkspaceFile's
// handler shape (assertTrustedSender → parse → requireWorkspace → op →
// result parse) and the workspaceFiles containment sandwich on every path.

export const CreateWorkspaceFolderPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type CreateWorkspaceFolderPayload = z.infer<
  typeof CreateWorkspaceFolderPayload
>;

// rename === move: ONE engine — F2, inline rename, and drag-drop all call it.
export const MoveWorkspacePathPayload = z.object({
  workspaceId: WORKSPACE_ID,
  fromPath: PATH_STRING,
  toPath: PATH_STRING,
});
export type MoveWorkspacePathPayload = z.infer<typeof MoveWorkspacePathPayload>;

export const DeleteWorkspacePathPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type DeleteWorkspacePathPayload = z.infer<
  typeof DeleteWorkspacePathPayload
>;

// trashed: true = OS trash; false = the .dohc/trash fallback (cross-
// filesystem mounts where g_file_trash rejects). Both are recoverable.
export const DeleteWorkspacePathResult = z.object({
  trashed: z.boolean(),
});
export type DeleteWorkspacePathResult = z.infer<typeof DeleteWorkspacePathResult>;

// relativePath absent = export the whole workspace. The output path comes
// from a MAIN-process save dialog — the renderer never names one. null =
// the user cancelled the dialog.
export const ExportWorkspaceZipPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING.optional(),
});
export type ExportWorkspaceZipPayload = z.infer<typeof ExportWorkspaceZipPayload>;

export const ExportWorkspaceZipResult = z.object({
  path: PATH_STRING.nullable(),
});
export type ExportWorkspaceZipResult = z.infer<typeof ExportWorkspaceZipResult>;

// Document export ("Copy as Markdown" ships purely through the renderer's own
// clipboard call — no IPC needed). Markdown/HTML/PDF export all land through
// this ONE channel. For `kind: "markdown"` the content is the document's raw
// markdown (frontmatter included), written verbatim to a .md file — the
// text-first export. For HTML/PDF the renderer builds the same self-contained
// HTML (title + rendered body + inline styles, no external assets); main
// either writes it verbatim (`kind: "html"`) or renders it in a hidden
// offscreen window and writes the resulting PDF bytes (`kind: "pdf"`). The
// output path — like ExportWorkspaceZipPayload — comes from a MAIN-process
// save dialog outside the workspace, since export is explicitly
// user-directed; null = cancelled.
const EXPORT_DOCUMENT_SUGGESTED_NAME = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[/\\\0]/.test(value), {
    message: "suggested export name must not contain path separators",
  });

export const ExportDocumentFilePayload = z.object({
  workspaceId: WORKSPACE_ID,
  suggestedName: EXPORT_DOCUMENT_SUGGESTED_NAME,
  // kind "markdown": the raw document markdown, written verbatim.
  // kind "html"/"pdf": the rendered, self-contained HTML document — for a PDF
  // export this is the source main prints, not the output bytes. Bounded
  // generously; a document this large has no business round-tripping through
  // IPC as a single string.
  content: z.string().min(1).max(20 * 1024 * 1024),
  kind: z.enum(["markdown", "html", "pdf"]),
});
export type ExportDocumentFilePayload = z.infer<typeof ExportDocumentFilePayload>;

export const ExportDocumentFileResult = z.object({
  path: PATH_STRING.nullable(),
});
export type ExportDocumentFileResult = z.infer<typeof ExportDocumentFileResult>;

// Explorer context menu: the renderer names WHAT was right-clicked, main
// builds the native Menu from main-owned labels over the closed
// EXPLORER_MENU_COMMANDS tuple (channels.ts) and resolves the SAME invoke
// with the chosen id (null = dismissed). No event channel needed.
export const ShowExplorerMenuPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // Absent for the root (container background) menu.
  path: PATH_STRING.optional(),
  kind: z.enum(["file", "folder", "root"]),
  pinned: z.boolean(),
});
export type ShowExplorerMenuPayload = z.infer<typeof ShowExplorerMenuPayload>;

export const ExplorerMenuCommand = z.enum(EXPLORER_MENU_COMMANDS);
export type ExplorerMenuCommand = z.infer<typeof ExplorerMenuCommand>;

export const ShowExplorerMenuResult = ExplorerMenuCommand.nullable();
export type ShowExplorerMenuResult = z.infer<typeof ShowExplorerMenuResult>;

export const ShowWorkbenchMenuPayload = z.object({
  workspaceId: WORKSPACE_ID,
  context: z.enum(["tab", "editor", "status"]),
  path: PATH_STRING.optional(),
});
export type ShowWorkbenchMenuPayload = z.infer<typeof ShowWorkbenchMenuPayload>;

export const WorkbenchMenuCommand = z.enum(WORKBENCH_MENU_COMMANDS);
export type WorkbenchMenuCommand = z.infer<typeof WorkbenchMenuCommand>;

export const ShowWorkbenchMenuResult = WorkbenchMenuCommand.nullable();
export type ShowWorkbenchMenuResult = z.infer<typeof ShowWorkbenchMenuResult>;

export const ImportWorkspaceFilesPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // OS drag-in (Phase E3): absolute source paths resolved by the PRELOAD
  // (webUtils.getPathForFile) from a drop event. TRUST DELTA vs the dialog
  // flow: these are renderer-supplied — main re-validates every one through
  // the picker-grade import path (importDroppedPaths: regular files only,
  // never a registered workspace's .dohc) and the count is capped here.
  droppedPaths: z.array(PATH_STRING).max(100).optional(),
  // Destination folder for the import, workspace-relative ("" / absent =
  // root — the empty string is legal here, unlike PATH_STRING). Files land
  // where the user aimed: the folder that was dropped on, or the folder
  // whose context menu ran "Import Files…". Renderer-supplied, so main
  // re-validates it end to end (resolveImportDestination: lexical
  // validation, every component a real non-symlink directory, realpath
  // containment) before any copy.
  targetDir: z.string().max(4096).optional(),
});
export type ImportWorkspaceFilesPayload = z.infer<
  typeof ImportWorkspaceFilesPayload
>;

export const ImportWorkspaceFilesResult = z.object({
  imported: z.array(PATH_STRING),
  // Sources that did not land (invalid basename, screened-out drop source,
  // collision budget exhausted) — surfaced so the import summary can say
  // "2 skipped" instead of the batch silently shrinking.
  skipped: z.number().int().min(0),
});
export type ImportWorkspaceFilesResult = z.infer<
  typeof ImportWorkspaceFilesResult
>;

export const OpenWorkspacePayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type OpenWorkspacePayload = z.infer<typeof OpenWorkspacePayload>;

export const ReadWorkspaceTextPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type ReadWorkspaceTextPayload = z.infer<typeof ReadWorkspaceTextPayload>;

export const OpenFileExternallyPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type OpenFileExternallyPayload = z.infer<
  typeof OpenFileExternallyPayload
>;

export const WriteWorkspaceTextPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
  // Editor saves are bounded like reads (2MB); the handler re-checks bytes.
  text: z.string().max(2 * 1024 * 1024),
});
export type WriteWorkspaceTextPayload = z.infer<typeof WriteWorkspaceTextPayload>;

// Image bytes pasted/dropped into the editor cross IPC as a raw Uint8Array
// (structured clone). z.custom (not z.instanceof) keeps the inferred type a
// plain `Uint8Array` and enforces the same 20MB bound the main-process writer
// re-checks. Bounded like the text write path so a huge paste can't stream
// unbounded bytes through IPC.
export const WRITE_ASSET_MAX_BYTES = 20 * 1024 * 1024;
const WORKSPACE_ASSET_BYTES = z.custom<Uint8Array>(
  (value) =>
    value instanceof Uint8Array &&
    value.byteLength > 0 &&
    value.byteLength <= WRITE_ASSET_MAX_BYTES,
  "Asset bytes are not a Uint8Array within the 20MB write bound.",
);

export const WriteWorkspaceAssetPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
  bytes: WORKSPACE_ASSET_BYTES,
});
export type WriteWorkspaceAssetPayload = z.infer<
  typeof WriteWorkspaceAssetPayload
>;

// The `/image` slash command's file picker. A renderer <input type="file">
// CANNOT be opened at a chosen starting directory (browser security), so the
// picker is a MAIN-process dialog that opens at the workspace ROOT — where a
// user's images actually live. Main reads the chosen files itself (it already
// has fs access), so the whole pick is ONE round trip: the renderer gets the
// bytes it needs for the existing write+insert path, never learns an absolute
// path, and needs no second read IPC.
export const PickImageFilesPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type PickImageFilesPayload = z.infer<typeof PickImageFilesPayload>;

// One picked image: its ORIGINAL basename (never a path — the renderer only
// slugifies it into an asset filename), the media type main resolved from the
// extension, and the bytes under the SAME 20MB bound the asset write enforces.
// Oversize picks are dropped in main exactly as paste drops them in the
// renderer, so this array only ever carries files that are writable.
const PICKED_IMAGE_NAME = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/[/\\\0]/.test(value), {
    message: "picked image name must be a basename, not a path",
  });

export const PickedImageFile = z.object({
  name: PICKED_IMAGE_NAME,
  mediaType: z.string().min(1).max(120),
  bytes: WORKSPACE_ASSET_BYTES,
});
export type PickedImageFile = z.infer<typeof PickedImageFile>;

// A single `/image` invocation is a handful of images, not a photo library:
// bounded so one pick can't stream hundreds of megabytes through IPC.
export const MAX_PICKED_IMAGES = 20;

export const PickImageFilesResult = z.object({
  // Empty = the user cancelled, or every pick was refused as oversize.
  files: z.array(PickedImageFile).max(MAX_PICKED_IMAGES),
});
export type PickImageFilesResult = z.infer<typeof PickImageFilesResult>;

export const ReadWorkspaceTextResult = z.object({
  // Capped: text views are for human-scale files; very large files fall back
  // to a download affordance rather than streaming megabytes through IPC.
  text: z.string(),
  truncated: z.boolean(),
});
export type ReadWorkspaceTextResult = z.infer<typeof ReadWorkspaceTextResult>;

const WorkspaceGraphNodeBase = z.object({
  path: PATH_STRING,
  title: z.string().max(120),
  outgoing: z.number().int().nonnegative(),
  incoming: z.number().int().nonnegative(),
});
const WorkspaceGraphFileNode = WorkspaceGraphNodeBase.extend({
  // Legacy file graphs predate `kind`; accepting its absence keeps the base
  // graph contract compatible while still rejecting chat/heading metadata.
  kind: z.literal("file").optional(),
  filePath: PATH_STRING.optional(),
  threadId: z.never().optional(),
  channelId: z.never().optional(),
  channelWireId: z.never().optional(),
  channelName: z.never().optional(),
  channelSlug: z.never().optional(),
  channelKind: z.never().optional(),
  headingAnchor: z.never().optional(),
}).strict();
const WorkspaceGraphHeadingNode = WorkspaceGraphNodeBase.extend({
  kind: z.literal("heading"),
  filePath: PATH_STRING,
  headingAnchor: z.string().min(1).max(400),
  threadId: z.never().optional(),
  channelId: z.never().optional(),
  channelWireId: z.never().optional(),
  channelName: z.never().optional(),
  channelSlug: z.never().optional(),
  channelKind: z.never().optional(),
}).strict();
const WorkspaceGraphChatThreadNode = WorkspaceGraphNodeBase.extend({
  kind: z.literal("chat-thread"),
  threadId: z.string().min(1).max(200),
  channelId: z.string().min(1).max(200).optional(),
  channelWireId: z.string().min(1).max(256).optional(),
  channelName: z.string().min(1).max(100).optional(),
  channelSlug: z.string().min(1).max(100).optional(),
  channelKind: z.enum(["channel", "dm", "agent"]).optional(),
  filePath: z.never().optional(),
  headingAnchor: z.never().optional(),
}).strict();
const WorkspaceGraphNode = z.union([
  WorkspaceGraphHeadingNode,
  WorkspaceGraphChatThreadNode,
  WorkspaceGraphFileNode,
]);

const WorkspaceGraphEdge = z.object({
  source: PATH_STRING,
  target: PATH_STRING,
  kind: z.enum([
    "wikilink",
    "markdown",
    "chat-mentions-file",
    "chat-mentions-heading",
    "heading-in-file",
  ]),
});

export const ReadWorkspaceGraphPayload = z.object({
  workspaceId: WORKSPACE_ID,
  includeChatMentions: z.boolean().optional(),
});
export type ReadWorkspaceGraphPayload = z.infer<typeof ReadWorkspaceGraphPayload>;

export const WorkspaceGraphResult = z.object({
  // Partial-freshness marker; see ListChatFileMentionsResult (#718).
  sharedChannelRowsUncovered: z.number().int().positive().optional(),
  nodes: z.array(WorkspaceGraphNode).max(2000),
  edges: z.array(WorkspaceGraphEdge).max(10000),
  unresolvedLinks: z.number().int().nonnegative(),
  scannedFileCount: z.number().int().nonnegative(),
  omittedFileCount: z.number().int().nonnegative(),
  truncatedFileCount: z.number().int().nonnegative(),
});
export type WorkspaceGraphResult = z.infer<typeof WorkspaceGraphResult>;

// Backlinks ("Linked mentions"): the OPEN document's inbound links, derived
// read-only in main from the same source graph. `path` is the open file; the
// result lists every OTHER file that links to it with a highlighted snippet per
// mention. Bounds mirror workspaceGraph's MAX_BACKLINK_* caps (kept as literals
// here so this shared contract never imports the main-only fs module).
export const GetBacklinksPayload = z.object({
  workspaceId: WORKSPACE_ID,
  path: PATH_STRING,
});
export type GetBacklinksPayload = z.infer<typeof GetBacklinksPayload>;

const BacklinkSnippet = z.object({
  // A single source line, trimmed/windowed to ~160 chars (+ ellipses).
  text: z.string().max(400),
  line: z.number().int().positive(),
  // [start, end) of the link within `text`; the UI marks this range.
  highlightStart: z.number().int().nonnegative(),
  highlightEnd: z.number().int().nonnegative(),
});

const BacklinkSource = z.object({
  sourcePath: PATH_STRING,
  sourceTitle: z.string().max(120),
  snippets: z.array(BacklinkSnippet).max(20),
});

export const GetBacklinksResult = z.object({
  sources: z.array(BacklinkSource).max(500),
});
export type GetBacklinksResult = z.infer<typeof GetBacklinksResult>;

export const ListWorkspaceHeadingsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  path: PATH_STRING,
});
export type ListWorkspaceHeadingsPayload = z.infer<
  typeof ListWorkspaceHeadingsPayload
>;

export const WorkspaceHeadingRecord = z.object({
  text: z.string().min(1).max(300),
  level: z.number().int().min(1).max(6),
  anchor: z.string().min(1).max(400),
  occurrence: z.number().int().nonnegative(),
  line: z.number().int().positive(),
});
export type WorkspaceHeadingRecord = z.infer<typeof WorkspaceHeadingRecord>;

export const ListWorkspaceHeadingsResult = z.object({
  headings: z.array(WorkspaceHeadingRecord).max(2000),
});
export type ListWorkspaceHeadingsResult = z.infer<
  typeof ListWorkspaceHeadingsResult
>;

// Visible SQLite: the studio reads a snapshot (tables/columns/bounded rows),
// edits rows in place, and imports a source file into a new database. The
// on-disk .sqlite is canonical; raw bytes never CRDT-sync (edits flow as an
// op log). Identifiers are bounded — IPC payloads are untrusted.
const SQL_IDENT = z.string().min(1).max(256);

const DatabaseColumnView = z.object({
  name: z.string(),
  type: z.string(),
  primaryKey: z.boolean().optional(),
  nullable: z.boolean().optional(),
});

const DatabaseTableView = z.object({
  name: z.string(),
  columns: z.array(DatabaseColumnView),
  rows: z.array(z.record(z.string(), z.unknown())),
});

export const DatabaseSnapshotResult = z.object({
  path: z.string(),
  tables: z.array(DatabaseTableView),
});
export type DatabaseSnapshotResult = z.infer<typeof DatabaseSnapshotResult>;

export const ReadWorkspaceDatabasePayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type ReadWorkspaceDatabasePayload = z.infer<typeof ReadWorkspaceDatabasePayload>;

export const ApplyDatabaseEditPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
  edit: z.object({
    table: SQL_IDENT,
    op: z.enum(["insert", "update", "upsert", "delete"]),
    pkColumn: SQL_IDENT,
    rowId: z.union([z.string().max(4096), z.number()]),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApplyDatabaseEditPayload = z.infer<typeof ApplyDatabaseEditPayload>;

export const ImportToDatabasePayload = z.object({
  workspaceId: WORKSPACE_ID,
  sourceRelativePath: PATH_STRING,
  databaseRelativePath: PATH_STRING,
  tableName: SQL_IDENT,
});
export type ImportToDatabasePayload = z.infer<typeof ImportToDatabasePayload>;

export const ImportToDatabaseResult = z.object({
  path: z.string(),
  tableName: z.string(),
  rowCount: z.number().int().nonnegative(),
});
export type ImportToDatabaseResult = z.infer<typeof ImportToDatabaseResult>;

export const SyncStatusResult = z.object({
  state: z.enum([
    "synced",
    "syncing",
    "local-changes",
    "conflict",
    "cloud-disconnected",
  ]),
  pendingChangeCount: z.number().int().nonnegative(),
  lastSyncedAtMs: z.number().nullable(),
  // Additive (Phase E2 status bar): HOW MANY files conflict, not just that
  // one does. Fed from the sync-engine snapshot in workspaceActivity —
  // optional so older producers/fixtures keep parsing.
  conflictCount: z.number().int().nonnegative().optional(),
  // Additive (PR 0M-7): true while the workspace-engine capture — a flagged
  // workspace's SOLE history recorder — is failing, so the notice center can
  // say history is not being recorded. Optional so older producers/fixtures
  // keep parsing.
  historyCaptureFailed: z.boolean().optional(),
  // Additive (WS-H1 retirement Phase C): true when this workspace records NO
  // history at all — the engine is explicitly opted out and the legacy
  // recorder no longer exists. Drives the persistent "History is off"
  // notice. Optional so older producers/fixtures keep parsing.
  historyRecordingOff: z.boolean().optional(),
  // Additive (#483): why main's open-time settings read could not trust the
  // file, when it could not. The notice states this cause instead of blaming
  // the Settings toggle. Bounded like the settings warning it carries: the
  // sentence names a full path. Optional so older producers/fixtures keep
  // parsing.
  settingsWarning: z.string().min(1).max(4600).optional(),
  // #505: true when the recorder could not be BUILT at workspace open — a
  // failure, not a decision. `historyRecordingOff` is true as well (nothing
  // records either way), so the notice must read this first: the opt-out copy
  // names Settings, which nobody touched here.
  //
  // REQUIRED where its neighbours above are optional, and deliberately so. An
  // omitted boolean reads as false, and false here does not mean "unknown" —
  // it asserts the user chose this, which is the false cause #505 is about. A
  // producer that cannot say which cause it means must not compile.
  historyRecordingUnavailable: z.boolean(),
  // #540: true when this workspace is a shared view — fed by the share's
  // pull, never a recorder of its own. A capability, not an opt-out and not
  // a failure, so the notice must not blame the Settings toggle.
  //
  // REQUIRED for the same reason as its neighbour: an omitted boolean reads
  // as false, and false asserts "not a shared view", which routes the notice
  // to the opt-out's copy — a cause nobody chose.
  historyShareView: z.boolean(),
  // Additive (0P-B relay sync): true after repeated non-auth sync failures.
  // Local changes remain safe and the engine keeps retrying with backoff.
  syncFailing: z.boolean().optional(),
  // Additive (0P-C): conflict resolutions replicated from another machine
  // that matched no conflict here (the file had moved on locally before the
  // resolution arrived). Surfaced as a review notice — never silently
  // swallowed. Optional so older producers/fixtures keep parsing.
  unmatchedRemoteResolves: z.number().int().nonnegative().optional(),
});
export type SyncStatusResult = z.infer<typeof SyncStatusResult>;


// Engine history (PR 0M-5, workspace-engine alpha): flagged workspaces read
// their timeline from ENGINE moments instead of legacy change sets. Every
// handler is gated in main on the workspace's engine capture — unflagged
// workspaces reject.
const MOMENT_ID = z.string().min(1).max(200);

const MOMENT_TEXT = engineStoredText("moment body");

export const EngineMomentRecord = z.object({
  id: MOMENT_ID,
  versionId: z.string().min(1).max(200),
  path: PATH_STRING,
  recordedAtMs: z.number(),
  operation: z.enum(["write", "rename", "delete"]),
  origin: z.enum([
    "api",
    "local-file",
    "restore",
    "sync",
    "sync-independent-origin",
    "unknown",
    "ydoc",
  ]),
  // Present only when a dohc-tracked agent run authored the moment; main
  // derives the display name (cloud email or the run's onBehalfOf label) —
  // the renderer only formats it as "<User Name>'s agent".
  agentAuthorName: z.string().min(1).max(500).optional(),
  summary: z.string().max(500).optional(),
  correlationId: z.string().max(200).optional(),
  // Workspace-global recording order: the pagination cursor and a monotonic
  // refresh key. Real moments always have a nonnegative order.
  momentOrder: z.number().int().nonnegative(),
  // Secret-backed file moment (PR 08): metadata-only by construction — the
  // row renders with a lock and its diff page shows "Contents are protected".
  protected: z.boolean().optional(),
  contentKind: z.enum(["text", "binary"]).optional(),
  byteLength: z.number().int().nonnegative().optional(),
});
export type EngineMomentRecord = z.infer<typeof EngineMomentRecord>;

export const ListEngineMomentsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  limit: z.number().int().min(1).max(500).optional(),
  beforeMomentOrder: z.number().int().nonnegative().optional(),
});
export type ListEngineMomentsPayload = z.infer<typeof ListEngineMomentsPayload>;

export const ListEngineMomentsResult = z.object({
  moments: z.array(EngineMomentRecord),
  nextBeforeMomentOrder: z.number().int().nonnegative().nullable(),
  // -1 is the store's honest "no moments yet" sentinel for an empty
  // timeline; anything below that is malformed.
  latestMomentOrder: z.number().int().min(-1),
  activeVersionId: z.string().min(1).max(200),
});
export type ListEngineMomentsResult = z.infer<typeof ListEngineMomentsResult>;

export const ReadEngineMomentPayload = z.object({
  workspaceId: WORKSPACE_ID,
  momentId: MOMENT_ID,
});
export type ReadEngineMomentPayload = z.infer<typeof ReadEngineMomentPayload>;

// One payload side of a moment whose content is binary: presented as bytes
// (byteLength, plus the content hash when the store recorded one) — a binary
// side never serves text.
const ENGINE_MOMENT_BINARY_SIDE = z.object({
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().min(1).max(128).optional(),
});

export const EngineMomentDetailRecord = EngineMomentRecord.omit({
  momentOrder: true,
}).extend({
  // null before-text = the moment created the file OR the before side is
  // binary (then beforeBinary is set); delete moments carry the removed
  // content as beforeText and null afterText. PROTECTED moments are
  // metadata-only: both sides are always null and the page renders
  // "Contents are protected" / "Binary contents" instead of a diff.
  beforeText: MOMENT_TEXT.nullable(),
  afterText: MOMENT_TEXT.nullable(),
  // Per-side content kinds (WS-G1): a text/binary transition moment has one
  // text side and one binary side; each side presents by its own kind.
  beforeBinary: ENGINE_MOMENT_BINARY_SIDE.optional(),
  afterBinary: ENGINE_MOMENT_BINARY_SIDE.optional(),
});
export type EngineMomentDetailRecord = z.infer<typeof EngineMomentDetailRecord>;

export const ReadEngineMomentResult = z.object({
  moment: EngineMomentDetailRecord.nullable(),
});
export type ReadEngineMomentResult = z.infer<typeof ReadEngineMomentResult>;

export const RestoreEngineMomentFilePayload = ReadEngineMomentPayload;
export type RestoreEngineMomentFilePayload = z.infer<
  typeof RestoreEngineMomentFilePayload
>;

export const RestoreEngineMomentFileResult = z.object({
  restored: z.enum(["text", "deleted"]),
  // The forward moment the restore recorded; undoing = restoring to before
  // THIS moment through the same channel.
  restoredMomentId: MOMENT_ID,
  path: PATH_STRING,
});
export type RestoreEngineMomentFileResult = z.infer<
  typeof RestoreEngineMomentFileResult
>;

// Linked Chats (PR 0M-5, workspace-engine alpha): per-file Chats stored in
// the engine, linked to the file's stable engine object id so the link
// survives renames. The renderer never supplies identity — main derives the
// author for every sent message.
const CHAT_THREAD_ID = z.string().min(1).max(200);
const CHAT_MESSAGE_ID = z.string().min(1).max(200);
const CHAT_BODY = z.string().min(1).max(65_536);
const CHAT_HEADING_TEXT = z.string().trim().min(1).max(300);
const CHAT_HEADING_ANCHOR = z.string().trim().min(1).max(400);

export const ChatThreadRecord = z.object({
  id: CHAT_THREAD_ID,
  title: z.string().min(1).max(200),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});
export type ChatThreadRecord = z.infer<typeof ChatThreadRecord>;

export const ChatAttachmentRecord = z.object({
  attachmentId: z.string().min(1).max(200),
  threadId: CHAT_THREAD_ID,
  messageId: CHAT_MESSAGE_ID,
  targetKind: z.literal("file"),
  objectId: z.string().min(1).max(200).optional(),
  pathHint: PATH_STRING.optional(),
  headingText: CHAT_HEADING_TEXT.optional(),
  headingAnchor: CHAT_HEADING_ANCHOR.optional(),
  headingOccurrence: z.number().int().nonnegative().optional(),
  createdAtMs: z.number(),
}).superRefine((attachment, ctx) => {
  if (attachment.headingOccurrence !== undefined && !attachment.headingAnchor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["headingOccurrence"],
      message: "heading occurrence requires a heading anchor",
    });
  }
});
export type ChatAttachmentRecord = z.infer<typeof ChatAttachmentRecord>;

// Renderer references paths/headings; main resolves them to stable engine
// object ids and validates the heading against the current canonical file.
// Identity and authorization never cross this renderer boundary.
export const ChatFileReferenceInput = z.object({
  path: PATH_STRING,
  headingAnchor: CHAT_HEADING_ANCHOR.optional(),
  headingOccurrence: z.number().int().nonnegative().optional(),
}).superRefine((reference, ctx) => {
  if (reference.headingOccurrence !== undefined && !reference.headingAnchor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["headingOccurrence"],
      message: "heading occurrence requires a heading anchor",
    });
  }
});
export type ChatFileReferenceInput = z.infer<typeof ChatFileReferenceInput>;

export const ChatMessageRecord = z.object({
  id: CHAT_MESSAGE_ID,
  threadId: CHAT_THREAD_ID,
  authorKind: z.enum(["human", "agent"]),
  authorDisplayName: z.string().min(1).max(200),
  parentMessageId: CHAT_MESSAGE_ID.optional(),
  origin: z.literal("cli").optional(),
  body: CHAT_BODY,
  createdAtMs: z.number(),
  // Optional on the wire so pre-phase-4 fixture objects and stored messages
  // remain compatible. Main includes the engine's authoritative array.
  attachments: z.array(ChatAttachmentRecord).optional(),
});
export type ChatMessageRecord = z.infer<typeof ChatMessageRecord>;

export const ListChatFileMentionsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  path: PATH_STRING,
});
export type ListChatFileMentionsPayload = z.infer<
  typeof ListChatFileMentionsPayload
>;

export const ChatFileMentionRecord = z.object({
  attachment: ChatAttachmentRecord,
  message: ChatMessageRecord,
  thread: ChatThreadRecord,
  channelId: z.string().min(1).max(200).optional(),
  channelWireId: z.string().min(1).max(256).optional(),
  channelName: z.string().min(1).max(100).optional(),
  channelSlug: z.string().min(1).max(100).optional(),
  channelKind: z.enum(["channel", "dm", "agent"]).optional(),
});
export type ChatFileMentionRecord = z.infer<typeof ChatFileMentionRecord>;

export const ListChatFileMentionsResult = z.object({
  // #718: these responses are built from the local store after ONE bounded
  // shared-channel sync pass. This is how many joined rows that pass did not
  // leave fresh — the ones its window never reached, plus the ones it reached
  // and could not sync (offline, relay hiccup). A pass that died outright, or
  // never ran because the account is signed out, reports every live row.
  // Absent means the pass that ran left no row behind, which is the only claim
  // of full freshness this field ever makes.
  sharedChannelRowsUncovered: z.number().int().positive().optional(),
  mentions: z.array(ChatFileMentionRecord).max(2000),
});
export type ListChatFileMentionsResult = z.infer<
  typeof ListChatFileMentionsResult
>;

const CHAT_BOOKMARK_RECORD_BASE = z.object({
  bookmarkId: z.string().min(1).max(200),
  mode: z.enum(["live", "snapshot"]),
  destinationPath: PATH_STRING,
  state: z.enum(["active", "archived"]),
  projectionState: z.enum(["pending", "ready", "failed", "stale"]),
  generation: z.number().int().nonnegative(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const ChatBookmarkRecord = z
  .discriminatedUnion("targetKind", [
    CHAT_BOOKMARK_RECORD_BASE.extend({
      targetKind: z.literal("thread"),
      targetId: CHAT_THREAD_ID,
      threadId: CHAT_THREAD_ID,
      messageId: z.undefined().optional(),
    }),
    CHAT_BOOKMARK_RECORD_BASE.extend({
      targetKind: z.literal("message"),
      targetId: CHAT_MESSAGE_ID,
      threadId: CHAT_THREAD_ID,
      messageId: CHAT_MESSAGE_ID,
    }),
  ])
  .superRefine((bookmark, ctx) => {
    const canonicalTargetId =
      bookmark.targetKind === "thread" ? bookmark.threadId : bookmark.messageId;
    if (bookmark.targetId !== canonicalTargetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetId"],
        message: `bookmark targetId must match its ${bookmark.targetKind} id`,
      });
    }
  });
export type ChatBookmarkRecord = z.infer<typeof ChatBookmarkRecord>;

export const ListChatBookmarksPayload = z.object({ workspaceId: WORKSPACE_ID });
export type ListChatBookmarksPayload = z.infer<typeof ListChatBookmarksPayload>;
export const ListChatBookmarksResult = z.object({
  bookmarks: z.array(ChatBookmarkRecord).max(5000),
});
export type ListChatBookmarksResult = z.infer<typeof ListChatBookmarksResult>;

export const SaveChatBookmarkPayload = z.object({
  workspaceId: WORKSPACE_ID,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("thread"), threadId: CHAT_THREAD_ID }),
    z.object({
      kind: z.literal("message"),
      threadId: CHAT_THREAD_ID,
      messageId: CHAT_MESSAGE_ID,
    }),
  ]),
  mode: z.enum(["live", "snapshot"]).default("live"),
});
export type SaveChatBookmarkPayload = z.infer<typeof SaveChatBookmarkPayload>;
export const SaveChatBookmarkResult = z.object({ bookmark: ChatBookmarkRecord });
export type SaveChatBookmarkResult = z.infer<typeof SaveChatBookmarkResult>;

export const ArchiveChatBookmarkPayload = z.object({
  workspaceId: WORKSPACE_ID,
  bookmarkId: z.string().min(1).max(200),
});
export type ArchiveChatBookmarkPayload = z.infer<typeof ArchiveChatBookmarkPayload>;
export const ArchiveChatBookmarkResult = z.object({ bookmark: ChatBookmarkRecord });
export type ArchiveChatBookmarkResult = z.infer<typeof ArchiveChatBookmarkResult>;

export const ListFileChatsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  path: PATH_STRING,
});
export type ListFileChatsPayload = z.infer<typeof ListFileChatsPayload>;

export const ListFileChatsResult = z.object({
  // null when the engine does not own the file (yet) — the rail explains
  // rather than failing.
  fileObjectId: z.string().min(1).max(200).nullable(),
  threads: z.array(ChatThreadRecord),
});
export type ListFileChatsResult = z.infer<typeof ListFileChatsResult>;

export const CreateFileChatPayload = z.object({
  workspaceId: WORKSPACE_ID,
  path: PATH_STRING,
  title: z.string().min(1).max(200),
});
export type CreateFileChatPayload = z.infer<typeof CreateFileChatPayload>;

export const CreateFileChatResult = z.object({
  thread: ChatThreadRecord,
});
export type CreateFileChatResult = z.infer<typeof CreateFileChatResult>;

export const ListChatMessagesPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: CHAT_THREAD_ID,
});
export type ListChatMessagesPayload = z.infer<typeof ListChatMessagesPayload>;

export const ListChatMessagesResult = z.object({
  messages: z.array(ChatMessageRecord),
});
export type ListChatMessagesResult = z.infer<typeof ListChatMessagesResult>;

export const SendChatMessagePayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: CHAT_THREAD_ID,
  parentMessageId: CHAT_MESSAGE_ID.optional(),
  body: CHAT_BODY,
  fileReferences: z.array(ChatFileReferenceInput).max(20).optional(),
});
export type SendChatMessagePayload = z.infer<typeof SendChatMessagePayload>;

export const SendChatMessageResult = z.object({
  message: ChatMessageRecord,
});
export type SendChatMessageResult = z.infer<typeof SendChatMessageResult>;

export const ChatDecisionRecord = z.object({
  threadId: CHAT_THREAD_ID,
  messageId: CHAT_MESSAGE_ID,
  state: z.enum(["open", "resolved"]),
  resolvedByMessageId: CHAT_MESSAGE_ID.optional(),
  atMs: z.number(),
});
export type ChatDecisionRecord = z.infer<typeof ChatDecisionRecord>;

export const ListChatThreadDecisionsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: CHAT_THREAD_ID,
});
export type ListChatThreadDecisionsPayload = z.infer<
  typeof ListChatThreadDecisionsPayload
>;

export const ListChatThreadDecisionsResult = z.object({
  decisions: z.array(ChatDecisionRecord),
});
export type ListChatThreadDecisionsResult = z.infer<
  typeof ListChatThreadDecisionsResult
>;

export const ResolveChatDecisionPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: CHAT_THREAD_ID,
  messageId: CHAT_MESSAGE_ID,
  resolvedByMessageId: CHAT_MESSAGE_ID,
});
export type ResolveChatDecisionPayload = z.infer<
  typeof ResolveChatDecisionPayload
>;

export const ResolveChatDecisionResult = z.object({
  decision: ChatDecisionRecord,
});
export type ResolveChatDecisionResult = z.infer<
  typeof ResolveChatDecisionResult
>;

export const ListChatThreadAttachmentsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: CHAT_THREAD_ID,
});
export type ListChatThreadAttachmentsPayload = z.infer<
  typeof ListChatThreadAttachmentsPayload
>;

export const ListChatThreadAttachmentsResult = z.object({
  attachments: z.array(ChatAttachmentRecord),
});
export type ListChatThreadAttachmentsResult = z.infer<
  typeof ListChatThreadAttachmentsResult
>;

export const ChatRunRecord = z.object({
  runId: z.string().min(1).max(200),
  threadId: CHAT_THREAD_ID,
  triggerMessageId: CHAT_MESSAGE_ID,
  command: z.string().min(1),
  startedAtMs: z.number(),
  endedAtMs: z.number().optional(),
  exitCode: z.number().int().optional(),
  logPath: PATH_STRING.optional(),
});
export type ChatRunRecord = z.infer<typeof ChatRunRecord>;

export const ChatRunRecordsForThreadPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: CHAT_THREAD_ID,
});
export type ChatRunRecordsForThreadPayload = z.infer<
  typeof ChatRunRecordsForThreadPayload
>;

export const ChatRunRecordsForThreadResult = z.object({
  runs: z.record(z.string(), ChatRunRecord).describe(
    "Run records linked to messages from the thread's 200 most recent runs, newest first.",
  ),
});
export type ChatRunRecordsForThreadResult = z.infer<
  typeof ChatRunRecordsForThreadResult
>;

// Reactions (WS-MU-C2). A reaction is durable, commutative chat data — an
// emoji reaction by an author on a message. The renderer never supplies
// identity: main derives the reactor from the local user, exactly like a sent
// message. Emojis are short graphemes, never message bodies.
//
// This schema is the TRUST BOUNDARY for chat.reaction.set payloads — including
// future replicated writes from other peers per the PR's forward-compat design.
// A length bound alone accepts URLs, profanity, and arbitrary ASCII text as an
// "emoji"; a hostile/buggy peer could inject those to render as reaction pills.
// So we validate the actual codepoints: a single emoji grapheme cluster — one
// pictographic (with optional variation selector / skin-tone modifier /
// keycap), a regional-indicator pair (flag), and ZWJ sequences thereof.
//
// Unicode property escapes (\p{…}) with the `u` flag are ES2018 and supported by
// every Node/Electron runtime this repo targets (tsconfig `target`/`lib` are
// ES2022), so `\p{Extended_Pictographic}` is safe here.
const EMOJI_ATOM =
  "(?:\\p{Regional_Indicator}\\p{Regional_Indicator}|\\p{Extended_Pictographic}[\\p{Emoji_Modifier}\\uFE0F\\u20E3]*)";
export const EMOJI_GRAPHEME_PATTERN = new RegExp(
  `^${EMOJI_ATOM}(?:\\u200D${EMOJI_ATOM})*$`,
  "u",
);
const CHAT_EMOJI = z
  .string()
  .min(1)
  .max(32)
  .regex(EMOJI_GRAPHEME_PATTERN, "must be a single emoji grapheme");

// One ACTIVE reaction as the renderer paints it. The UI groups these by
// (messageId, emoji) into pills; `authorId` lets it mark the viewer's own.
export const ChatReactionRecord = z.object({
  reactionId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200),
  threadId: CHAT_THREAD_ID,
  emoji: CHAT_EMOJI,
  authorId: z.string().min(1).max(200),
  authorKind: z.enum(["human", "agent"]),
  authorDisplayName: z.string().min(1).max(200),
});
export type ChatReactionRecord = z.infer<typeof ChatReactionRecord>;

// Chats channels (PR 12/13, WS-E): workspace-wide Chats organized in
// channels, plus per-thread monotonic read cursors. Same gate as the file
// rail — every handler rejects for unflagged workspaces.
const CHAT_CHANNEL_ID = z.string().min(1).max(200);
export const CHAT_CHANNEL_NAME_MAX = 80;

export const ChatChannelRecord = z.object({
  id: CHAT_CHANNEL_ID,
  name: z.string().min(1).max(CHAT_CHANNEL_NAME_MAX),
  slug: z.string().min(1).max(CHAT_CHANNEL_NAME_MAX),
  kind: z.enum(["channel", "dm", "agent"]),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  threadCount: z.number().int().min(0),
  unreadCount: z.number().int().min(0),
  // MU-C4: the channel's cross-machine wire identity — what shared-channel
  // grants key on. Absent/null for channels with no recorded wire mapping.
  wireId: z.string().min(1).max(256).nullable().optional(),
});
export type ChatChannelRecord = z.infer<typeof ChatChannelRecord>;

export const ChannelThreadRecord = ChatThreadRecord.extend({
  channelId: CHAT_CHANNEL_ID,
  messageCount: z.number().int().min(0),
  lastReadSequence: z.number().int().min(0),
  unreadCount: z.number().int().min(0),
  // Main always supplies the engine-derived count. Optionality keeps older
  // renderer fixtures and pre-phase-4 bridge consumers source-compatible.
  openDecisionCount: z.number().int().min(0).optional(),
  // Feed-only opening-message data. Optional + nullable keeps older bridge
  // fixtures compatible while allowing an empty/corrupt legacy thread to be
  // represented without fabricating a message.
  openingMessage: z
    .object({
      id: CHAT_MESSAGE_ID,
      authorKind: z.enum(["human", "agent"]),
      authorDisplayName: z.string().min(1).max(200),
      createdAtMs: z.number(),
      bodySnippet: z.string().min(1).max(500),
      reactions: z.array(ChatReactionRecord),
    })
    .nullable()
    .optional(),
});
export type ChannelThreadRecord = z.infer<typeof ChannelThreadRecord>;

// A file-linked Chat as the Chats view lists it: the CURRENT path when the
// engine can resolve the stable object id, else the captured hint.
export const FileChatThreadRecord = ChatThreadRecord.extend({
  path: PATH_STRING.nullable(),
});
export type FileChatThreadRecord = z.infer<typeof FileChatThreadRecord>;

export const ListChatChannelsPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type ListChatChannelsPayload = z.infer<typeof ListChatChannelsPayload>;

export const ListChatChannelsResult = z.object({
  // Partial-freshness marker; see ListChatFileMentionsResult (#718).
  sharedChannelRowsUncovered: z.number().int().positive().optional(),
  channels: z.array(ChatChannelRecord),
  // The "Files" grouping: file-linked Chats listed read-only beside the
  // channels (they live in the file rail; the Chats view cross-links).
  fileThreads: z.array(FileChatThreadRecord),
});
export type ListChatChannelsResult = z.infer<typeof ListChatChannelsResult>;

const CHAT_FOLLOW_TARGET_KIND = z.enum(["person", "agent", "channel", "thread"]);
const CHAT_FOLLOW_STATE = z.enum(["following", "unfollowed"]);

export const ChatFollowRecord = z.object({
  targetKind: CHAT_FOLLOW_TARGET_KIND,
  targetId: z.string().min(1).max(300),
  state: CHAT_FOLLOW_STATE,
  updatedAtMs: z.number(),
});
export type ChatFollowRecord = z.infer<typeof ChatFollowRecord>;

export const ListChatFollowsPayload = z.object({ workspaceId: WORKSPACE_ID });
export type ListChatFollowsPayload = z.infer<typeof ListChatFollowsPayload>;
export const ListChatFollowsResult = z.object({
  follows: z.array(ChatFollowRecord).max(5000),
});
export type ListChatFollowsResult = z.infer<typeof ListChatFollowsResult>;

export const SetChatFollowPayload = z.object({
  workspaceId: WORKSPACE_ID,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("channel"), channelId: CHAT_CHANNEL_ID }),
    z.object({ kind: z.literal("thread"), threadId: CHAT_THREAD_ID }),
    z.object({
      kind: z.literal("author"),
      threadId: CHAT_THREAD_ID,
      messageId: CHAT_MESSAGE_ID,
    }),
  ]),
  state: CHAT_FOLLOW_STATE,
});
export type SetChatFollowPayload = z.infer<typeof SetChatFollowPayload>;
export const SetChatFollowResult = z.object({ follow: ChatFollowRecord });
export type SetChatFollowResult = z.infer<typeof SetChatFollowResult>;

const ChatFeedChannelRecord = z.object({
  id: CHAT_CHANNEL_ID,
  wireId: z.string().min(1).max(256).optional(),
  name: z.string().min(1).max(CHAT_CHANNEL_NAME_MAX),
  slug: z.string().min(1).max(CHAT_CHANNEL_NAME_MAX),
  kind: z.enum(["channel", "dm", "agent"]),
});

export const ChatFeedItemRecord = z.object({
  message: ChatMessageRecord,
  thread: ChatThreadRecord,
  channel: ChatFeedChannelRecord.optional(),
  // Opaque, relay-verified identity used only to correlate persisted follow
  // state across this author's posts. It is never an email/display name.
  authorFollowTarget: z
    .object({
      targetKind: z.enum(["person", "agent"]),
      targetId: z.string().min(1).max(300),
    })
    .optional(),
  parentMessage: ChatMessageRecord.optional(),
  openingMessage: ChatMessageRecord.optional(),
  reactions: z.array(ChatReactionRecord),
  matchedBy: z.array(CHAT_FOLLOW_TARGET_KIND).max(4),
});
export type ChatFeedItemRecord = z.infer<typeof ChatFeedItemRecord>;

export const ListPersonalChatFeedPayload = z.object({
  workspaceId: WORKSPACE_ID,
  cursor: z.string().min(1).max(1000).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type ListPersonalChatFeedPayload = z.infer<typeof ListPersonalChatFeedPayload>;
export const ListPersonalChatFeedResult = z.object({
  // Partial-freshness marker; see ListChatFileMentionsResult (#718).
  sharedChannelRowsUncovered: z.number().int().positive().optional(),
  items: z.array(ChatFeedItemRecord).max(50),
  nextCursor: z.string().max(1000).optional(),
  headCursor: z.string().max(1000).optional(),
});
export type ListPersonalChatFeedResult = z.infer<
  typeof ListPersonalChatFeedResult
>;

export const MarkPersonalChatFeedSeenPayload = z.object({
  workspaceId: WORKSPACE_ID,
  headCursor: z.string().min(1).max(1000),
});
export type MarkPersonalChatFeedSeenPayload = z.infer<
  typeof MarkPersonalChatFeedSeenPayload
>;

export const CreateChatChannelPayload = z.object({
  workspaceId: WORKSPACE_ID,
  name: z.string().min(1).max(CHAT_CHANNEL_NAME_MAX),
});
export type CreateChatChannelPayload = z.infer<typeof CreateChatChannelPayload>;

export const CreateChatChannelResult = z.object({
  channel: ChatChannelRecord,
});
export type CreateChatChannelResult = z.infer<typeof CreateChatChannelResult>;

export const ListChannelThreadsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  channelId: CHAT_CHANNEL_ID,
});
export type ListChannelThreadsPayload = z.infer<typeof ListChannelThreadsPayload>;

export const ListChannelThreadsResult = z.object({
  threads: z.array(ChannelThreadRecord),
  // Main-derived, shared by every opening-message reaction summary in this
  // response. Optional for older callers/fixtures; main always supplies it.
  viewerAuthorId: z.string().min(1).max(200).optional(),
});
export type ListChannelThreadsResult = z.infer<typeof ListChannelThreadsResult>;

// The fast composer: body only, NO title. Untitled threads display their
// first-message snippet (the anti-forum rule) — main never asks for a title.
export const StartChannelThreadPayload = z.object({
  workspaceId: WORKSPACE_ID,
  channelId: CHAT_CHANNEL_ID,
  body: CHAT_BODY,
  fileReferences: z.array(ChatFileReferenceInput).max(20).optional(),
});
export type StartChannelThreadPayload = z.infer<typeof StartChannelThreadPayload>;

export const StartChannelThreadResult = z.object({
  thread: ChannelThreadRecord,
  message: ChatMessageRecord,
});
export type StartChannelThreadResult = z.infer<typeof StartChannelThreadResult>;

export const MarkChatThreadReadPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: CHAT_THREAD_ID,
  // Monotonic: the store clamps to the thread's message count and never
  // moves the cursor backwards; the revision is server-owned.
  upToSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type MarkChatThreadReadPayload = z.infer<typeof MarkChatThreadReadPayload>;

export const MarkChatThreadReadResult = z.object({
  lastReadSequence: z.number().int().min(0),
  revision: z.number().int().min(0),
});
export type MarkChatThreadReadResult = z.infer<typeof MarkChatThreadReadResult>;

export const ListChatReactionsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: CHAT_THREAD_ID,
});
export type ListChatReactionsPayload = z.infer<typeof ListChatReactionsPayload>;

export const ListChatReactionsResult = z.object({
  reactions: z.array(ChatReactionRecord),
  // The viewer's own reactor id (main-derived), so the renderer can highlight
  // "your" reactions and toggle them without ever learning another identity.
  viewerAuthorId: z.string().min(1).max(200),
});
export type ListChatReactionsResult = z.infer<typeof ListChatReactionsResult>;

export const SetChatReactionPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: CHAT_THREAD_ID,
  messageId: z.string().min(1).max(200),
  emoji: CHAT_EMOJI,
  // add or remove YOUR reaction. The store is a set-membership CRDT: this is
  // the observed cell state, resolved by LWW-per-cell.
  state: z.enum(["added", "removed"]),
});
export type SetChatReactionPayload = z.infer<typeof SetChatReactionPayload>;

export const SetChatReactionResult = z.object({
  reaction: ChatReactionRecord.extend({ state: z.enum(["added", "removed"]) }),
  viewerAuthorId: z.string().min(1).max(200),
});
export type SetChatReactionResult = z.infer<typeof SetChatReactionResult>;

const EMAIL_STRING = z.email().max(320);
const SHARE_ID = z.string().min(1).max(200);

// Direct messages (WS-MU-C3). A DM is a `kind:"dm"` channel plus one MU-C4
// chat-channel grant per participant, riding the shared-channel lane. The
// whole surface is gated on collaboration (signed in + relay): a solo user
// sees none of it. Identity is always main-derived — the renderer never
// supplies who is sending or who a grant belongs to.
export const DmRecord = z.object({
  channelId: CHAT_CHANNEL_ID,
  channelWireId: z.string().min(1).max(256),
  name: z.string().min(1).max(CHAT_CHANNEL_NAME_MAX),
  // What this viewer calls the DM: the owner sees the recipients they
  // addressed; a participant sees the granter (the replicated channel name
  // is the owner's recipient list — often the participant's own address).
  peerLabel: z.string().min(1).max(320),
  role: z.enum(["owner", "participant"]),
  // The chat-channel grant a PARTICIPANT joined this DM through — the presence
  // SHARE scope both sides converge on (the relay maps it to the granter's
  // workspace, where the owner publishes). Null for the OWNER (who publishes
  // into their own workspace scope) and until a participant's grant registers.
  shareId: z.string().min(1).max(200).nullable(),
  // The single running conversation (the anti-forum rule). Null only in the
  // brief window before the creator's first message replicates.
  threadId: CHAT_THREAD_ID.nullable(),
  unreadCount: z.number().int().min(0),
  // False for a participant whose grant ended: already-replayed messages
  // stay readable, sending is closed.
  connected: z.boolean(),
});
export type DmRecord = z.infer<typeof DmRecord>;

export const DmRequestRow = z.object({
  shareId: SHARE_ID,
  granterEmail: EMAIL_STRING.nullable(),
});
export type DmRequestRow = z.infer<typeof DmRequestRow>;

export const SyncDmsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // The DM the caller is reading, when it is reading one. The shared-channel
  // pass is bounded, so a poll that names its open conversation keeps that one
  // fresh instead of waiting for the rotation to reach it (#718).
  openChannelId: CHAT_CHANNEL_ID.optional(),
});
export type SyncDmsPayload = z.infer<typeof SyncDmsPayload>;

export const SyncDmsResult = z.object({
  // False when signed out / no relay: the renderer hides the whole DM
  // surface (solo zero-bloat).
  available: z.boolean(),
  dms: z.array(DmRecord),
  pending: z.array(DmRequestRow),
  declined: z.array(DmRequestRow),
});
export type SyncDmsResult = z.infer<typeof SyncDmsResult>;

export const AcceptDmPayload = z.object({
  workspaceId: WORKSPACE_ID,
  shareId: SHARE_ID,
});
export type AcceptDmPayload = z.infer<typeof AcceptDmPayload>;

export const AcceptDmResult = z.object({ dm: DmRecord });
export type AcceptDmResult = z.infer<typeof AcceptDmResult>;

export const DeclineDmPayload = z.object({ shareId: SHARE_ID });
export type DeclineDmPayload = z.infer<typeof DeclineDmPayload>;

export const RequestDmAgainPayload = z.object({ shareId: SHARE_ID });
export type RequestDmAgainPayload = z.infer<typeof RequestDmAgainPayload>;

// A participant's reverse path for where an accepted DM lives (#742): ends
// the SAME JoinedSharedChannel row leaveSharedChannel ends, keyed by DM
// shareId. The owner side has no shareId (DmRecord.shareId is null for the
// owner) and never calls this.
export const LeaveDmPayload = z.object({
  workspaceId: WORKSPACE_ID,
  shareId: SHARE_ID,
});
export type LeaveDmPayload = z.infer<typeof LeaveDmPayload>;

export const StartDmPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // One or more recipient emails ("a@x.com, b@y.com") — parsed/validated in
  // main; grants are addressed per recipient.
  recipients: z.string().min(3).max(2000),
  body: CHAT_BODY,
  fileReferences: z.array(ChatFileReferenceInput).max(20).optional(),
});
export type StartDmPayload = z.infer<typeof StartDmPayload>;

export const StartDmResult = z.object({
  dm: DmRecord,
  message: ChatMessageRecord,
});
export type StartDmResult = z.infer<typeof StartDmResult>;

// Ephemeral presence (MU-C1 / MU-C5). The renderer's presence transport is
// IPC-PROXIED so the relay bearer token NEVER reaches the renderer: main holds
// cachedCredentials.token and makes the actual relay presence request. These
// payloads carry only the scope, an opaque display state, and the long-poll
// bookkeeping. The scope is authorized in MAIN (the caller's own workspace, or
// a share they hold a grant for) BEFORE the relay — which re-authorizes from
// the bearer independently.
export const PresenceScopeInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), workspaceId: WORKSPACE_ID }),
  z.object({ kind: z.literal("share"), shareId: z.string().min(1).max(200) }),
]);
export type PresenceScopeInput = z.infer<typeof PresenceScopeInput>;

// Bounds mirror the relay's presence parser (MAX_PRESENCE_TOPIC_CHARS /
// MAX_CLIENT_ID_CHARS): reject early rather than round-trip an over-long value.
const PRESENCE_TOPIC = z.string().min(1).max(1024);
const PRESENCE_CLIENT_ID = z.string().min(1).max(128);
const PRESENCE_POLL_ID = z.string().min(1).max(128);

// Cap the opaque presence state at the IPC boundary, mirroring the relay's
// MAX_PRESENCE_STATE_BYTES (services/sync-relay). Presence carries small display
// data ({ displayName, typing }); bounding it HERE stops a renderer from forcing
// main to JSON.stringify an attacker-sized (or cyclic / non-JSON) payload before
// the relay's own cap applies.
export const PRESENCE_STATE_MAX_BYTES = 8 * 1024;
const PRESENCE_STATE_MAX_DEPTH = 32;

// A CHEAP, short-circuiting size guard: it walks the already-deserialized value
// accumulating an UPPER BOUND on the serialized UTF-8 byte size and bails the
// moment it exceeds the cap — so an oversized payload is rejected WITHOUT a full
// JSON.stringify. Returns false for cycles, over-depth nesting, and non-JSON
// values (bigint), which the relay would reject or main would throw on anyway.
export function presenceStateWithinCap(
  value: unknown,
  maxBytes: number = PRESENCE_STATE_MAX_BYTES,
): boolean {
  let budget = maxBytes;
  const seen = new Set<object>();
  const spend = (n: number): boolean => {
    budget -= n;
    return budget >= 0;
  };
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > PRESENCE_STATE_MAX_DEPTH) return false;
    if (v === null) return spend(4); // "null"
    switch (typeof v) {
      case "boolean":
        return spend(5); // up to "false"
      case "number":
        return spend(v && Number.isFinite(v) ? 24 : 4); // non-finite → "null"
      case "string":
        // Upper bound: a JSON string is the UTF-8 bytes plus quotes/escapes; 6
        // bytes per char covers the worst-case "\uXXXX" escape.
        return spend(2 + v.length * 6);
      case "object": {
        const obj = v as object;
        if (seen.has(obj)) return false; // cycle → reject as over-cap
        seen.add(obj);
        try {
          if (Array.isArray(v)) {
            if (!spend(2)) return false; // []
            for (const item of v) {
              if (!spend(1)) return false; // element separator
              if (!walk(item, depth + 1)) return false;
            }
            return true;
          }
          if (!spend(2)) return false; // {}
          for (const [key, item] of Object.entries(v as Record<string, unknown>)) {
            if (item === undefined) continue; // omitted by JSON.stringify
            if (!spend(4 + key.length * 6)) return false; // "key": plus separator
            if (!walk(item, depth + 1)) return false;
          }
          return true;
        } finally {
          seen.delete(obj);
        }
      }
      default:
        // bigint isn't JSON-serializable (JSON.stringify throws); undefined /
        // function / symbol are omitted and cost nothing.
        return typeof v !== "bigint";
    }
  };
  return walk(value, 0);
}

export const PresencePublishPayload = z.object({
  scope: PresenceScopeInput,
  topic: PRESENCE_TOPIC,
  clientId: PRESENCE_CLIENT_ID,
  // Opaque display payload (e.g. { displayName, typing }) — forwarded verbatim
  // to the relay, which caps its serialized size. Absent on a leave; bounded
  // here so main never serializes an attacker-sized payload.
  state: z
    .unknown()
    .optional()
    .refine((v) => v === undefined || presenceStateWithinCap(v), {
      message: "presence state exceeds the size cap",
    }),
  leave: z.boolean().optional(),
});
export type PresencePublishPayload = z.infer<typeof PresencePublishPayload>;

export const PresencePollPayload = z.object({
  scope: PresenceScopeInput,
  topic: PRESENCE_TOPIC,
  since: z.number().int().min(0),
  // Renderer-minted correlation id so an in-flight long-poll can be aborted
  // over IPC (presenceCancel) on unmount / workspace switch.
  pollId: PRESENCE_POLL_ID,
});
export type PresencePollPayload = z.infer<typeof PresencePollPayload>;

export const PresenceCancelPayload = z.object({
  pollId: PRESENCE_POLL_ID,
});
export type PresenceCancelPayload = z.infer<typeof PresenceCancelPayload>;

const PresencePeerRecord = z.object({
  userId: z.string().max(256),
  clientId: z.string().max(128),
  // Opaque peer display payload — the renderer's resolvePeerDisplayName is the
  // sole guard that turns it into a shown name.
  state: z.unknown(),
  updatedAtMs: z.number(),
});
const PresenceSnapshotRecord = z.object({
  version: z.number(),
  peers: z.array(PresencePeerRecord),
});

// Discriminated so a dropped session / no-relay / aborted long-poll is a
// well-defined "unavailable"/"aborted" result the renderer treats as dormant,
// never a thrown IPC error that would churn a retry loop.
export const PresenceResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), snapshot: PresenceSnapshotRecord }),
  z.object({ ok: z.literal(false), reason: z.enum(["unavailable", "aborted"]) }),
]);
export type PresenceResult = z.infer<typeof PresenceResult>;

// Named versions (PR 0M-4, workspace-engine alpha). Product vocabulary only:
// a Version is a live parallel line of work; Main is the default one. All of
// these handlers are gated in main on the workspace's engine capture being
// attached (flag on) — for unflagged workspaces they reject.
const VERSION_ID = z.string().min(1).max(200);
export const WORKSPACE_VERSION_NAME_MAX = 80;
// Conflict and compare sides are the same hydrated stored bodies the timeline
// carries, passed through verbatim (`engineHistoryIpc.ts` versionConflictForIpc,
// `versionCompare.ts`), so they carry the engine's own text contract.
//
// Compare rows use this bound to its full height: `compareVersionFilesPage`
// hydrates each differing path by `readTextFile` -> `readTextBlob`, so a
// compare side at the engine's contract does arrive.
//
// Conflict listing keeps up too (#537): a row past 8 MiB minus envelope
// headroom is degraded to withheld metadata rather than refused
// (`conflicts_list`, crates/dohc-workspace-engine/src/lib.rs), and
// `listTextConflicts` hydrates each withheld side through
// `versionedText.readBlob`. So a conflict side at the engine's storage
// contract arrives on every lane this bound covers.
//
// The bound stays the engine's storage contract rather than any transport
// ceiling: a second hand-copied constant is the drift #517 was filed about.
// The one place the client mirrors the frame cap is `engineTextLimits.ts`,
// where `CONFLICT_ROW_HARD_CAP_BYTES` is DERIVED from the frame constant the
// drift guard already covers.
//
// The combined resolution (`keep-combined` below) is the one REQUEST use, and
// its contract is NOT this one: the engine bounds a combined resolution by the
// control frame that carries the whole request, measured in JSON-ENCODED bytes
// (`crates/dohc-workspace-engine/src/lib.rs`, `resolve_request_encoded_bytes`).
// Encoded, so escaping counts: a newline-heavy body is twice its raw size on
// the wire, and this character bound cannot see that. This bound only keeps an
// unbounded string off the wire; the engine decides what applies.
const VERSION_TEXT = engineStoredText("version text");

export const WorkspaceVersionRecord = z.object({
  id: VERSION_ID,
  name: z.string().min(1).max(200),
  kind: z.enum(["main", "named"]),
  createdAtMs: z.number(),
  // False for versions created from another named version — the alpha merge
  // surface only combines a version with the Main it was created from.
  canMergeIntoMain: z.boolean(),
});
export type WorkspaceVersionRecord = z.infer<typeof WorkspaceVersionRecord>;

export const ListWorkspaceVersionsResult = z.object({
  versions: z.array(WorkspaceVersionRecord),
  activeVersionId: VERSION_ID,
});
export type ListWorkspaceVersionsResult = z.infer<typeof ListWorkspaceVersionsResult>;

export const CreateWorkspaceVersionPayload = z.object({
  workspaceId: WORKSPACE_ID,
  name: z
    .string()
    .min(1)
    .max(WORKSPACE_VERSION_NAME_MAX)
    .refine((value) => value.trim() === value && value.length > 0, {
      message: "version name must not start or end with spaces",
    }),
});
export type CreateWorkspaceVersionPayload = z.infer<typeof CreateWorkspaceVersionPayload>;

export const SwitchWorkspaceVersionPayload = z.object({
  workspaceId: WORKSPACE_ID,
  versionId: VERSION_ID,
});
export type SwitchWorkspaceVersionPayload = z.infer<typeof SwitchWorkspaceVersionPayload>;

export const SwitchWorkspaceVersionResult = z.object({
  activeVersionId: VERSION_ID,
  changedFileCount: z.number().int().min(0),
});
export type SwitchWorkspaceVersionResult = z.infer<typeof SwitchWorkspaceVersionResult>;

export const WorkspaceVersionFileChange = z.object({
  path: PATH_STRING,
  status: z.enum(["added", "modified", "deleted"]),
  // Main's side; absent when the file only exists in the compared version.
  currentText: VERSION_TEXT.optional(),
  // The compared version's side; absent when the file only exists in Main.
  incomingText: VERSION_TEXT.optional(),
  // Secret-backed file (PR 08): the compare view renders "Protected file
  // changed" — both text sides are always absent when this is set.
  protected: z.boolean().optional(),
  // Binary files are byte-versioned but comparison is metadata-only.
  binary: z.boolean().optional(),
});
export type WorkspaceVersionFileChange = z.infer<typeof WorkspaceVersionFileChange>;

export const CompareWorkspaceVersionsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  versionId: VERSION_ID,
  // Continuation from the previous page's nextAfterPath; absent for the
  // first page.
  afterPath: PATH_STRING.optional(),
});
export type CompareWorkspaceVersionsPayload = z.infer<
  typeof CompareWorkspaceVersionsPayload
>;

// Page-shaped (#562): the rows carry full text sides, so the message is
// bounded by main's page budget (`COMPARE_PAGE_TEXT_BYTE_BUDGET`,
// workspace-core versionCompare.ts) and the rest rides the continuation.
export const CompareWorkspaceVersionsResult = z.object({
  files: z.array(WorkspaceVersionFileChange),
  // Non-null: more differing files exist past this page. Pass it back as
  // afterPath to fetch them.
  nextAfterPath: PATH_STRING.nullable(),
});
export type CompareWorkspaceVersionsResult = z.infer<
  typeof CompareWorkspaceVersionsResult
>;

export const WorkspaceVersionConflict = z.object({
  conflictId: z.string().min(1).max(200),
  path: PATH_STRING,
  sourceVersionId: VERSION_ID,
  targetVersionId: VERSION_ID,
  // Additive (0P-C): where the conflict came from — a version merge, or two
  // machines editing the same file while apart ("sync"). The review UI
  // labels the sides accordingly ("On this machine" / "On another machine").
  origin: z.enum(["merge", "sync"]).default("merge"),
  contentKind: z.enum(["text", "binary"]).default("text"),
  // null means "no file on that side" (added on one side, deleted on the
  // other). Raw texts only — the UI renders sides, never conflict markers.
  currentText: VERSION_TEXT.nullable(),
  incomingText: VERSION_TEXT.nullable(),
  baseText: VERSION_TEXT.nullable(),
  currentBinary: z
    .object({ byteLength: z.number().int().nonnegative(), sha256: z.string().min(1).max(128) })
    .nullable()
    .optional(),
  incomingBinary: z
    .object({ byteLength: z.number().int().nonnegative(), sha256: z.string().min(1).max(128) })
    .nullable()
    .optional(),
  baseBinary: z
    .object({ byteLength: z.number().int().nonnegative(), sha256: z.string().min(1).max(128) })
    .nullable()
    .optional(),
});
export type WorkspaceVersionConflict = z.infer<typeof WorkspaceVersionConflict>;

export const MergeWorkspaceVersionPayload = SwitchWorkspaceVersionPayload;
export type MergeWorkspaceVersionPayload = z.infer<typeof MergeWorkspaceVersionPayload>;

const CONFLICT_ID = z.string().min(1).max(200);

// Every conflict-carrying result is page-shaped (#562): the daemon pages
// `conflicts.list` under a byte budget, and these results pass one such page
// through. Non-null nextAfterConflictId: more open conflicts exist past this
// page — pass it back as afterConflictId to fetch them.
export const MergeWorkspaceVersionResult = z.object({
  mergedFileCount: z.number().int().min(0),
  unchangedFileCount: z.number().int().min(0),
  // How many files THIS merge left in conflict. The rows below are the first
  // page of ALL open conflicts (a sync conflict can be among them), so the
  // STAGE decision reads this count — unrelated open conflicts must not turn
  // a clean merge into a conflicted one. The count sentence over the cards
  // reads the loaded rows instead: it describes what the user is looking at.
  conflictCount: z.number().int().min(0),
  conflicts: z.array(WorkspaceVersionConflict),
  nextAfterConflictId: CONFLICT_ID.nullable(),
});
export type MergeWorkspaceVersionResult = z.infer<typeof MergeWorkspaceVersionResult>;

export const ListWorkspaceVersionConflictsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  afterConflictId: CONFLICT_ID.optional(),
});
export type ListWorkspaceVersionConflictsPayload = z.infer<
  typeof ListWorkspaceVersionConflictsPayload
>;

export const ListWorkspaceVersionConflictsResult = z.object({
  conflicts: z.array(WorkspaceVersionConflict),
  nextAfterConflictId: CONFLICT_ID.nullable(),
});
export type ListWorkspaceVersionConflictsResult = z.infer<
  typeof ListWorkspaceVersionConflictsResult
>;

export const ResolveWorkspaceVersionConflictPayload = z.object({
  workspaceId: WORKSPACE_ID,
  conflictId: z.string().min(1).max(200),
  resolution: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("keep-current") }),
    z.object({ kind: z.literal("keep-incoming") }),
    z.object({ kind: z.literal("keep-combined"), text: VERSION_TEXT }),
  ]),
});
export type ResolveWorkspaceVersionConflictPayload = z.infer<
  typeof ResolveWorkspaceVersionConflictPayload
>;

// The first page of the conflicts still open after the resolution.
export const ResolveWorkspaceVersionConflictResult = z.object({
  conflicts: z.array(WorkspaceVersionConflict),
  nextAfterConflictId: CONFLICT_ID.nullable(),
});
export type ResolveWorkspaceVersionConflictResult = z.infer<
  typeof ResolveWorkspaceVersionConflictResult
>;

// "Try it in a version" (PR 0N-2): one gesture — fork a version named after
// the task, switch into it, start a dohc-tracked agent run. Gated in main on
// the workspace-engine alpha capture like every version operation.
export const TRY_IN_VERSION_TASK_MAX = 2000;

export const TryInWorkspaceVersionPayload = z.object({
  workspaceId: WORKSPACE_ID,
  task: z
    .string()
    .min(1)
    .max(TRY_IN_VERSION_TASK_MAX)
    .refine((value) => value.trim().length > 0, {
      message: "task must not be blank",
    }),
  // When present, main hands the task to this installed agent driver (a
  // dohc-managed driver session); absent = a bare dohc-tracked run the
  // user's own agent tool works inside.
  driverId: z.string().min(1).max(100).optional(),
});
export type TryInWorkspaceVersionPayload = z.infer<
  typeof TryInWorkspaceVersionPayload
>;

export const TryInWorkspaceVersionResult = z.object({
  versionId: VERSION_ID,
  versionName: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
});
export type TryInWorkspaceVersionResult = z.infer<
  typeof TryInWorkspaceVersionResult
>;

export const TryInVersionRunState = z.object({
  status: z.enum(["running", "review"]),
  task: z.string().min(1).max(TRY_IN_VERSION_TASK_MAX),
  versionId: VERSION_ID,
  versionName: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  startedAtMs: z.number(),
  endedAtMs: z.number().optional(),
  runOutcome: z.enum(["complete", "failed"]).optional(),
  // Review only. null = the count could not be computed; the card says so
  // rather than guessing.
  changedFileCount: z.number().int().min(0).nullable().optional(),
  mergeAvailable: z.boolean(),
});
export type TryInVersionRunState = z.infer<typeof TryInVersionRunState>;

export const TryInVersionStateResult = z.object({
  state: TryInVersionRunState.nullable(),
});
export type TryInVersionStateResult = z.infer<typeof TryInVersionStateResult>;

const SiteDiagnostic = z.object({
  path: PATH_STRING.optional(),
  severity: z.enum(["warning", "error"]),
  code: z.string().min(1).max(100),
  message: z.string().max(10_000).optional(),
});
export type SiteDiagnostic = z.infer<typeof SiteDiagnostic>;

const SiteScripts = z.object({
  dev: z.string().optional(),
  start: z.string().optional(),
  build: z.string().optional(),
  preview: z.string().optional(),
});
export type SiteScripts = z.infer<typeof SiteScripts>;

const SiteSharePath = SITE_ROOT_STRING.refine((path) => path !== ".", {
  message: "site share paths must name a file",
});

const SiteShareMountRoot = SITE_ROOT_STRING.refine((path) => path !== ".", {
  message: "site share mount roots must name the mounted share",
});

const SiteShareManifest = z
  .object({
    entryPath: SiteSharePath,
    assets: z.array(SiteSharePath).max(99),
  })
  .superRefine((manifest, ctx) => {
    const paths = [manifest.entryPath, ...manifest.assets];
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "site share manifest paths must be unique",
      });
    }
  });

const SitePackageInfo = z
  .object({
    root: PATH_STRING,
    title: z.string().min(1).max(200),
    kind: z.enum(["static", "package", "configured"]),
    confidence: z.enum(["high", "medium", "low"]),
    entryPath: PATH_STRING.nullable(),
    configPath: PATH_STRING.nullable(),
    packagePath: PATH_STRING.nullable(),
    packageManager: z.enum(["pnpm", "npm", "yarn", "bun"]).nullable(),
    scripts: SiteScripts,
    configuredScripts: SiteScripts.optional(),
    buildOutputs: z.array(PATH_STRING).max(100),
    sourceFiles: z.array(PATH_STRING).max(1000),
    shareManifest: SiteShareManifest.nullable(),
    diagnostics: z.array(SiteDiagnostic).max(100),
    authority: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("workspace") }),
      z.object({ kind: z.literal("share"), mountRoot: SiteShareMountRoot }),
    ]),
  })
  .superRefine((site, ctx) => {
    if (
      site.authority.kind === "share" &&
      site.root !== site.authority.mountRoot &&
      !site.root.startsWith(`${site.authority.mountRoot}/`)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "shared site roots must stay inside their authority mount root",
        path: ["root"],
      });
    }
    if (!site.shareManifest) return;
    const paths = [site.shareManifest.entryPath, ...site.shareManifest.assets];
    for (const path of paths) {
      if (!site.sourceFiles.includes(path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "site share manifest paths must exist in sourceFiles",
          path: ["shareManifest"],
        });
        return;
      }
      if (site.root !== "." && !path.startsWith(`${site.root}/`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "site share manifest paths must stay inside the site root",
          path: ["shareManifest"],
        });
        return;
      }
    }
    if (!/\.html?$/i.test(site.shareManifest.entryPath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "site share manifest entryPath must be HTML",
        path: ["shareManifest", "entryPath"],
      });
    }
  });
export type SitePackageInfo = z.infer<typeof SitePackageInfo>;

export const ListSitesPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type ListSitesPayload = z.infer<typeof ListSitesPayload>;

export const ListSitesResult = z.object({
  sites: z.array(SitePackageInfo).max(100),
});
export type ListSitesResult = z.infer<typeof ListSitesResult>;

export const SitePackagePayload = z.object({
  workspaceId: WORKSPACE_ID,
  path: PATH_STRING,
});
export type SitePackagePayload = z.infer<typeof SitePackagePayload>;

export const SitePackageResult = SitePackageInfo.nullable();
export type SitePackageResult = z.infer<typeof SitePackageResult>;

export const SitePreviewMode = z.enum(["static", "dev", "build"]);
export type SitePreviewMode = z.infer<typeof SitePreviewMode>;

export const StartSitePreviewPayload = z.object({
  workspaceId: WORKSPACE_ID,
  siteRoot: SITE_ROOT_STRING,
  mode: SitePreviewMode,
});
export type StartSitePreviewPayload = z.infer<typeof StartSitePreviewPayload>;

const SiteLogEntry = z.object({
  stream: z.enum(["stdout", "stderr", "system"]),
  text: z.string().max(10_000),
  at: z.number(),
});
export type SiteLogEntry = z.infer<typeof SiteLogEntry>;

const LoopbackPreviewUrl = z.string().min(1).max(2048).superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid URL" });
    return;
  }
  const port = Number(url.port);
  const hasExplicitPort = url.port !== "";
  if (
    url.protocol !== "http:" ||
    !isLoopbackHostname(url.hostname) ||
    url.username ||
    url.password ||
    (hasExplicitPort && (!Number.isInteger(port) || port < 1 || port > 65535))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "preview URL must be an unauthenticated loopback HTTP URL",
    });
  }
});

export const StartSitePreviewResult = z.object({
  siteRoot: SITE_ROOT_STRING,
  mode: SitePreviewMode,
  url: LoopbackPreviewUrl,
  logs: z.array(SiteLogEntry).max(500),
  // null means the locally-owned site has the current user's full workspace
  // authority. Shared sites are constrained to their materialized share mount.
  // Main derives this from siteRoot; the renderer is never authoritative.
  sdkScopeRoot: SITE_ROOT_STRING.nullable().default(null),
  build: z
    .object({
      ok: z.boolean(),
      command: z.string(),
      args: z.array(z.string()),
      outputPath: z.string().nullable(),
      exitCode: z.number().nullable(),
    })
    .optional(),
});
export type StartSitePreviewResult = z.infer<typeof StartSitePreviewResult>;

export const StopSitePreviewPayload = z.object({
  workspaceId: WORKSPACE_ID,
  siteRoot: SITE_ROOT_STRING,
});
export type StopSitePreviewPayload = z.infer<typeof StopSitePreviewPayload>;
export const StopSitePreviewResult = z.void();
export type StopSitePreviewResult = z.infer<typeof StopSitePreviewResult>;

// Sites never supply user or workspace identity. The containing renderer
// identifies the open site and main re-derives its owned/share authority.
// The preload applies this contract before ipcRenderer.invoke. The byte cap
// is the exact UTF-8 size of the JSON representation; 4 MiB preserves the
// supported 2 MiB text-write payload while bounding Electron deserialization.
export const SITE_SDK_PARAMS_MAX_BYTES = 4 * 1024 * 1024;
export const SITE_SDK_PARAMS_MAX_DEPTH = 32;
export const SITE_SDK_PARAMS_MAX_VALUES = 20_000;

type SiteSdkParamFrame =
  | { kind: "visit"; value: unknown; depth: number }
  | { kind: "leave"; value: object };

function boundedJsonStringBytes(value: string, remaining: number): number {
  let bytes = 2; // JSON quotes.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += code === 0x08 || code === 0x09 || code === 0x0a ||
        code === 0x0c || code === 0x0d
        ? 2
        : 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        // Well-formed JSON.stringify escapes lone surrogates as \uXXXX.
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
    if (bytes > remaining) return remaining + 1;
  }
  return bytes;
}

function siteSdkParamsIssue(root: unknown): string | null {
  const stack: SiteSdkParamFrame[] = [{ kind: "visit", value: root, depth: 0 }];
  const ancestors = new WeakSet<object>();
  let bytes = 0;
  let values = 0;

  const addBytes = (amount: number): boolean => {
    bytes += amount;
    return bytes <= SITE_SDK_PARAMS_MAX_BYTES;
  };

  try {
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.kind === "leave") {
        ancestors.delete(frame.value);
        continue;
      }
      if (frame.depth > SITE_SDK_PARAMS_MAX_DEPTH) return "nesting is too deep";
      values += 1;
      if (values > SITE_SDK_PARAMS_MAX_VALUES) return "too many values";

      const current = frame.value;
      if (current === null) {
        if (!addBytes(4)) return "serialized value is too large";
        continue;
      }
      if (typeof current === "string") {
        if (!addBytes(boundedJsonStringBytes(
          current,
          SITE_SDK_PARAMS_MAX_BYTES - bytes,
        ))) return "serialized value is too large";
        continue;
      }
      if (typeof current === "boolean") {
        if (!addBytes(current ? 4 : 5)) return "serialized value is too large";
        continue;
      }
      if (typeof current === "number") {
        if (!Number.isFinite(current)) return "numbers must be finite";
        if (!addBytes(JSON.stringify(current).length)) {
          return "serialized value is too large";
        }
        continue;
      }
      if (typeof current !== "object") return "value is not JSON-safe";
      if (ancestors.has(current)) return "cyclic references are not allowed";

      if (Array.isArray(current)) {
        const keys = Object.keys(current);
        if (
          keys.length !== current.length ||
          keys.some((key, index) => key !== String(index))
        ) {
          return "arrays must be dense and contain no extra properties";
        }
        if (!addBytes(2 + Math.max(0, current.length - 1))) {
          return "serialized value is too large";
        }
        ancestors.add(current);
        stack.push({ kind: "leave", value: current });
        for (let index = current.length - 1; index >= 0; index -= 1) {
          stack.push({ kind: "visit", value: current[index], depth: frame.depth + 1 });
        }
        continue;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        return "only plain objects and arrays are allowed";
      }
      const keys = Reflect.ownKeys(current);
      if (!addBytes(2 + Math.max(0, keys.length - 1) + keys.length)) {
        return "serialized value is too large";
      }
      const childValues: unknown[] = [];
      for (const key of keys) {
        if (typeof key !== "string") return "symbol keys are not allowed";
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          return "object properties must be enumerable data values";
        }
        if (!addBytes(boundedJsonStringBytes(
          key,
          SITE_SDK_PARAMS_MAX_BYTES - bytes,
        ))) return "serialized value is too large";
        childValues.push(descriptor.value);
      }
      ancestors.add(current);
      stack.push({ kind: "leave", value: current });
      for (let index = childValues.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: "visit", value: childValues[index], depth: frame.depth + 1 });
      }
    }
  } catch {
    return "value could not be inspected safely";
  }

  return null;
}

export const SiteSdkParams = z.unknown().superRefine((value, ctx) => {
  const issue = siteSdkParamsIssue(value);
  if (!issue) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      `params must be JSON-safe and within ${SITE_SDK_PARAMS_MAX_BYTES} bytes, ` +
      `${SITE_SDK_PARAMS_MAX_DEPTH} levels, and ${SITE_SDK_PARAMS_MAX_VALUES} values: ${issue}`,
  });
});

export const InvokeSiteSdkPayload = z.object({
  workspaceId: WORKSPACE_ID,
  siteRoot: SITE_ROOT_STRING,
  method: z.string().min(1).max(200),
  params: SiteSdkParams.optional(),
});
export type InvokeSiteSdkPayload = z.infer<typeof InvokeSiteSdkPayload>;

export function parseInvokeSiteSdkPayloadForIpc(value: unknown): InvokeSiteSdkPayload {
  return InvokeSiteSdkPayload.parse(value);
}

export const InvokeSiteSdkResult = z.object({ result: z.unknown() });
export type InvokeSiteSdkResult = z.infer<typeof InvokeSiteSdkResult>;

// dohc Cloud login (device-authorization flow): the desktop shows a short
// code, the user approves in the system browser, the desktop polls. The
// session token never reaches the renderer — main stores it via safeStorage
// and the renderer only ever sees connection status + email.
export const OpenExternalUrlPayload = z.object({
  url: z.string().min(1).max(2048),
});
export type OpenExternalUrlPayload = z.infer<typeof OpenExternalUrlPayload>;

export const CloudLoginStartPayload = z.object({
  serverUrl: z.url().max(2048).optional(),
  relayUrl: z.url().max(2048).optional(),
});
export type CloudLoginStartPayload = z.infer<typeof CloudLoginStartPayload>;

export const CloudLoginStartResult = z.object({
  userCode: z.string().min(1),
  verificationUri: z.string().min(1),
});
export type CloudLoginStartResult = z.infer<typeof CloudLoginStartResult>;

export const CloudLoginPollResult = z.object({
  status: z.enum(["pending", "complete", "denied", "expired"]),
  email: z.string().optional(),
});
export type CloudLoginPollResult = z.infer<typeof CloudLoginPollResult>;

export const CloudStatusPayload = z.object({
  workspaceId: WORKSPACE_ID.optional(),
});
export type CloudStatusPayload = z.infer<typeof CloudStatusPayload>;

export const CloudStatusResult = z.object({
  connected: z.boolean(),
  email: z.string().optional(),
  serverUrl: z.string().optional(),
  relayUrl: z.string().optional(),
  // Whether the named workspace has cloud sync enabled (registry remote set).
  workspaceSynced: z.boolean().optional(),
  // Whether that remote is pinned to the current signed-in account.
  workspaceSyncConnected: z.boolean().optional(),
  workspaceSecretState: z
    .enum(["none", "protected-key-present", "protected-key-missing"])
    .optional(),
});
export type CloudStatusResult = z.infer<typeof CloudStatusResult>;

export const CloudEnableSyncPayload = z.object({
  workspaceId: WORKSPACE_ID,
  passphrase: z.string().optional(),
});
export type CloudEnableSyncPayload = z.infer<typeof CloudEnableSyncPayload>;

// Join a synced workspace on this machine (0P-C): a sync code copied from
// the machine that already has the workspace, plus a local folder chosen
// through the picker (main re-validates the approved-root provenance).
export const CloudJoinWorkspacePayload = z.object({
  syncCode: z.string().min(1).max(4096),
  rootPath: z.string().min(1).max(4096),
});
export type CloudJoinWorkspacePayload = z.infer<typeof CloudJoinWorkspacePayload>;

// Explicit dismissal of the "a choice made on another machine needs a look"
// notice (0P-C gate fix): clears the workspace engine's pending remote-
// resolve set. The notice otherwise clears itself when the referenced
// conflict is resolved locally or converged by a later sync pass.
export const DismissSyncReviewNoticePayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type DismissSyncReviewNoticePayload = z.infer<typeof DismissSyncReviewNoticePayload>;

export const CloudJoinWorkspaceResult = z.object({
  workspace: WorkspaceSummary,
  // Set when the workspace was added but its first sync did not finish —
  // the workspace exists locally and sync keeps retrying.
  warning: z.string().min(1).max(500).optional(),
});
export type CloudJoinWorkspaceResult = z.infer<typeof CloudJoinWorkspaceResult>;

// ---- Relay shares (PR 18, the engine-native cloud) ----
// A share grant lives on the SYNC RELAY: an explicit path list and/or a
// version snapshot, addressed to another relay account by email. The grant
// side gets back a copyable share code (dohc-share:<shareId>:<relayUrl>);
// the receive side opens it as a read-only shared view workspace.

export const RelayShareSelector = z.object({
  paths: z.array(PATH_STRING).max(100),
  versionId: z.string().min(1).max(128).nullable(),
});
export type RelayShareSelector = z.infer<typeof RelayShareSelector>;

export const RelayShareGrantedRow = z.object({
  shareId: SHARE_ID,
  // The relay-side workspace id (the remote identity, not necessarily a
  // local registry id).
  workspaceId: z.string().min(1).max(256),
  // null for a PENDING email invite (an addressed email that has no dohc
  // account yet); the recipientEmail carries who it was shared with (PR 18).
  recipientUserId: z.string().min(1).max(256).nullable(),
  recipientEmail: EMAIL_STRING.nullable(),
  selector: RelayShareSelector,
  createdAtMs: z.number().int().nonnegative(),
  revokedAtMs: z.number().int().nonnegative().nullable(),
  shareCode: z.string().min(1).max(4096),
});
export type RelayShareGrantedRow = z.infer<typeof RelayShareGrantedRow>;

// A path/version share granted TO this account (the receive side). The
// relay deliberately omits the granter's workspace id; the selector and
// granter identity are all a recipient ever sees.
export const RelayShareReceivedRow = z.object({
  shareId: SHARE_ID,
  granterEmail: EMAIL_STRING.nullable(),
  selector: RelayShareSelector,
  createdAtMs: z.number().int().nonnegative(),
  shareCode: z.string().min(1).max(4096),
});
export type RelayShareReceivedRow = z.infer<typeof RelayShareReceivedRow>;

export const ListRelaySharesResult = z.object({
  granted: z.array(RelayShareGrantedRow).max(1000),
  // Path/version shares addressed to this account (chat-channel grants are
  // listed through listChatChannelShares).
  received: z.array(RelayShareReceivedRow).max(1000).default([]),
});
export type ListRelaySharesResult = z.infer<typeof ListRelaySharesResult>;

export const CreateRelaySharePayload = z.object({
  workspaceId: WORKSPACE_ID,
  recipientEmail: EMAIL_STRING,
  paths: z.array(PATH_STRING).min(1).max(100).optional(),
  versionId: z.string().min(1).max(128).optional(),
});
export type CreateRelaySharePayload = z.infer<typeof CreateRelaySharePayload>;

export const CreateRelayShareResult = z.object({
  shareId: SHARE_ID,
  shareCode: z.string().min(1).max(4096),
  recipientEmail: EMAIL_STRING,
});
export type CreateRelayShareResult = z.infer<typeof CreateRelayShareResult>;

export const RevokeRelaySharePayload = z.object({
  shareId: SHARE_ID,
});
export type RevokeRelaySharePayload = z.infer<typeof RevokeRelaySharePayload>;

// ---- Shared channels (MU-C4) ----
// A chat-channel grant: a whole channel (threads + messages + reactions)
// shared to another relay account, read-write by default, read-only as the
// broadcast opt-in. Granted rows manage who a channel is shared WITH;
// received rows are invitations addressed to this account; joined rows are
// the ones pulled into a local workspace's chat store.

export const ChatShareAccess = z.enum(["read-write", "read-only"]);
export type ChatShareAccess = z.infer<typeof ChatShareAccess>;

const CHANNEL_WIRE_ID = z.string().min(1).max(256);

export const ShareChatChannelPayload = z.object({
  workspaceId: WORKSPACE_ID,
  channelId: CHAT_CHANNEL_ID,
  recipientEmail: EMAIL_STRING,
  access: ChatShareAccess.optional(),
});
export type ShareChatChannelPayload = z.infer<typeof ShareChatChannelPayload>;

export const ShareChatChannelResult = z.object({
  shareId: SHARE_ID,
});
export type ShareChatChannelResult = z.infer<typeof ShareChatChannelResult>;

// How many rows the RELAY lanes may carry in one listing. It bounds a body
// dohc did not write and must parse in one go, and readRelayChatShareLanes
// applies it before this schema sees them: a relay-controlled body over the
// cap would otherwise fail the parse below, reject the IPC call, and clear
// every cached row on the sharing surface (#608).
//
// It does NOT gate joining. #640 deleted that use: the joined lane is now
// answered per channel the caller names, so its response size no longer
// depends on how many channels the account has ever joined, and nothing about
// the read needs a join to be refused. See scopeJoinedChannels.
export const MAX_CHAT_CHANNEL_SHARE_ROWS = 4096;

export const ChatChannelShareGrantRow = z.object({
  shareId: SHARE_ID,
  channelWireId: CHANNEL_WIRE_ID,
  access: ChatShareAccess,
  recipientEmail: EMAIL_STRING.nullable(),
  revokedAtMs: z.number().int().nonnegative().nullable(),
});
export type ChatChannelShareGrantRow = z.infer<typeof ChatChannelShareGrantRow>;

export const ChatChannelShareReceivedRow = z.object({
  shareId: SHARE_ID,
  channelWireId: CHANNEL_WIRE_ID,
  access: ChatShareAccess,
  granterEmail: EMAIL_STRING.nullable(),
});
export type ChatChannelShareReceivedRow = z.infer<typeof ChatChannelShareReceivedRow>;

export const JoinedSharedChannelRow = z.object({
  shareId: SHARE_ID,
  channelWireId: CHANNEL_WIRE_ID,
  access: ChatShareAccess,
  granterEmail: EMAIL_STRING.nullable(),
  ended: z.boolean(),
});
export type JoinedSharedChannelRow = z.infer<typeof JoinedSharedChannelRow>;

// The joined lane, answered one channel at a time.
//
// A caller names the channels it is SHOWING and gets one answer per name:
// the registry row that gates that channel, or null when this workspace holds
// none. So the response is bounded by the caller's view, not by how many
// channels the account has ever joined — which is what lets tombstones be
// kept for as long as the write gate needs them, with no reaping and no
// compaction (#640).
//
// A wire id the caller did NOT name is absent, and absent means UNKNOWN.
// Unknown locks the channel, exactly as an unresolved listing does: the
// renderer must never read a channel it has no gate row for as one it owns.
export const JoinedChannelAnswer = z.object({
  channelWireId: CHANNEL_WIRE_ID,
  joined: JoinedSharedChannelRow.nullable(),
});
export type JoinedChannelAnswer = z.infer<typeof JoinedChannelAnswer>;

// The wire ids a caller is showing. No cap, and it must not gain one: it is
// the caller's own channel list (ListChatChannelsResult carries no cap
// either), so a cap here could only reject a workspace for having channels.
const SHOWN_CHANNEL_WIRE_IDS = z.array(CHANNEL_WIRE_ID);

export const ListChatChannelSharesPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // The channels the caller is showing. The answer covers these plus the
  // received invitations it returns — the caller cannot name those yet,
  // because this call is what tells it they exist.
  channelWireIds: SHOWN_CHANNEL_WIRE_IDS,
});
export type ListChatChannelSharesPayload = z.infer<typeof ListChatChannelSharesPayload>;

// The granted/received rows live on the relay; the joined rows are local.
// The relay side carries which of three different facts it learned, because
// each one means something different for cached rows:
//  - "answered": the relay's rows, authoritative (empty means no shares).
//  - "unreachable": the relay did not answer. NOT an empty listing — the
//    caller keeps what it already knows.
//  - "signed-out": there is no valid session (signed out, expired, switched
//    account). Account-scoped rows do not exist for this caller, so cached
//    rows must clear — another account's invitations and recipient emails
//    must not survive a logout.
export const ListChatChannelSharesResult = z.object({
  // One answer per channel this listing covers: the caller's own
  // channelWireIds plus the received invitations below, because the sharing
  // surface shows those too and decides for each one whether this workspace
  // has already joined it.
  //
  // NO row cap, and it must not gain one. These are dohc's own registry rows
  // and they are the authority for channelIsLocked: a read that refuses them
  // rejects the whole IPC call, the renderer reads an unknown listing, and
  // every channel goes read-only (#617). Nothing needs a cap here now — the
  // caller's view bounds the size.
  joined: z.array(JoinedChannelAnswer),
  // The account the relay lanes are scoped to (server + stable user id), or
  // null when no session exists. Cached relay rows are preservable only
  // within the SAME session: an unreachable answer under a different account
  // must never preserve another account's rows.
  sessionKey: z.string().nullable(),
  relay: z.discriminatedUnion("state", [
    z.object({
      state: z.literal("answered"),
      granted: z.array(ChatChannelShareGrantRow).max(MAX_CHAT_CHANNEL_SHARE_ROWS),
      received: z.array(ChatChannelShareReceivedRow).max(MAX_CHAT_CHANNEL_SHARE_ROWS),
    }),
    z.object({ state: z.literal("unreachable") }),
    // Over the per-lane cap. NOT "unreachable": that word means dohc could not
    // read the answer, and a retry is the right next step for it. This answer
    // arrived and will arrive again identically, so a surface that shows it as
    // an outage offers a Try again that can never work and never says what is
    // wrong — the #618 defect, reintroduced for the one condition dohc's own
    // cap creates. It carries what it observed and the configured limit so the
    // surface can name the constraint. Like "unreachable" it is NOT
    // authoritative: cached rows stand.
    z.object({
      state: z.literal("over-limit"),
      lanes: z
        .array(
          z.object({
            lane: z.enum(["granted", "received"]),
            rows: z.number().int().nonnegative(),
          }),
        )
        .min(1)
        .max(2),
      limit: z.number().int().positive(),
    }),
    z.object({ state: z.literal("signed-out") }),
  ]),
});
export type ListChatChannelSharesResult = z.infer<typeof ListChatChannelSharesResult>;

// The joined rows alone, read from the local registry. listChatChannelShares
// answers the same rows, but it asks the relay for the grant side first, so a
// caller that only needs to know what THIS machine joined would wait on the
// network for an answer the network does not hold.
export const ListJoinedSharedChannelsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // The channels the caller is showing. This read talks to nothing but the
  // registry, so it answers exactly these and nothing else.
  channelWireIds: SHOWN_CHANNEL_WIRE_IDS,
});
export type ListJoinedSharedChannelsPayload = z.infer<
  typeof ListJoinedSharedChannelsPayload
>;

export const ListJoinedSharedChannelsResult = z.object({
  // One answer per named channel, and no row cap — see
  // ListChatChannelSharesResult.
  joined: z.array(JoinedChannelAnswer),
});
export type ListJoinedSharedChannelsResult = z.infer<
  typeof ListJoinedSharedChannelsResult
>;

export const JoinSharedChannelPayload = z.object({
  workspaceId: WORKSPACE_ID,
  shareId: SHARE_ID,
});
export type JoinSharedChannelPayload = z.infer<typeof JoinSharedChannelPayload>;

export const JoinSharedChannelResult = z.object({
  joined: JoinedSharedChannelRow,
});
export type JoinSharedChannelResult = z.infer<typeof JoinSharedChannelResult>;

export const LeaveSharedChannelPayload = z.object({
  workspaceId: WORKSPACE_ID,
  shareId: SHARE_ID,
});
export type LeaveSharedChannelPayload = z.infer<typeof LeaveSharedChannelPayload>;

export const OpenSharedViewPayload = z.object({
  shareCode: z.string().min(1).max(4096),
  rootPath: PATH_STRING,
});
export type OpenSharedViewPayload = z.infer<typeof OpenSharedViewPayload>;

export const OpenSharedViewResult = z.object({
  workspace: WorkspaceSummary,
});
export type OpenSharedViewResult = z.infer<typeof OpenSharedViewResult>;

export const RefreshSharedViewPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type RefreshSharedViewPayload = z.infer<typeof RefreshSharedViewPayload>;

// Clearing a share's durable skip record. The content those ops carried is
// still missing — this says the user has seen the warning, which is the only
// honest recovery this surface can offer.
export const DismissShareSkipsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // Absent clears the workspace's own shared view; a shareId clears one
  // mounted share's record.
  shareId: SHARE_ID.optional(),
  // The generation the user saw. A refusal recorded after that render has a
  // higher generation, so it stays unacknowledged and speaks up again.
  generation: z.number().int().nonnegative(),
});
export type DismissShareSkipsPayload = z.infer<typeof DismissShareSkipsPayload>;

export const RefreshSharedViewResult = z.object({
  // "ended" means the granter revoked the share: the local view stays
  // readable but stops refreshing, and the UI says so honestly.
  status: z.enum(["updated", "unchanged", "ended"]),
  changedPaths: z.number().int().nonnegative(),
  // Ops the pull refused. It skips them and keeps going, so a view that
  // quietly stopped carrying part of the share is invisible without this.
  refusedOps: z.number().int().nonnegative(),
  // The first refusal's engine message, for the banner's title attribute and
  // the log. Null when nothing was refused.
  refusedDetail: z.string().nullable(),
});
export type RefreshSharedViewResult = z.infer<typeof RefreshSharedViewResult>;

// ---- Share mounts ----
// The receive side of a relay share materialized INSIDE a host workspace as
// shared-with-me/<label>/ — ordinary read-only files (agent-readable through
// normal tools) that live-follow the share. Mounting/refreshing/unmounting
// are host-workspace operations; every path and label is re-validated in
// main before any disk effect.

export const MountSharePayload = z.object({
  workspaceId: WORKSPACE_ID,
  shareCode: z.string().min(1).max(4096),
});
export type MountSharePayload = z.infer<typeof MountSharePayload>;

export const ShareMountStatusRow = z.object({
  shareId: SHARE_ID,
  label: z.string().min(1).max(64),
  status: z.enum(["updated", "unchanged", "ended"]),
  changedPaths: z.number().int().nonnegative(),
});
export type ShareMountStatusRow = z.infer<typeof ShareMountStatusRow>;

export const MountShareResult = z.object({
  workspace: WorkspaceSummary,
  mount: ShareMountStatusRow,
});
export type MountShareResult = z.infer<typeof MountShareResult>;

export const RefreshShareMountsPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type RefreshShareMountsPayload = z.infer<typeof RefreshShareMountsPayload>;

export const RefreshShareMountsResult = z.object({
  results: z.array(ShareMountStatusRow).max(200),
});
export type RefreshShareMountsResult = z.infer<typeof RefreshShareMountsResult>;

export const UnmountSharePayload = z.object({
  workspaceId: WORKSPACE_ID,
  shareId: SHARE_ID,
});
export type UnmountSharePayload = z.infer<typeof UnmountSharePayload>;

export const UnmountShareResult = z.object({
  workspace: WorkspaceSummary,
});
export type UnmountShareResult = z.infer<typeof UnmountShareResult>;

// Local agent integration (Phase 11). An agent run is a LOCAL concept: a small
// record persisted to .dohc/agent-runs.json. Enabling a run (optionally) spawns
// the managed MCP stdio child for the workspace and sets the watcher's
// active-run slot, so the run's writes are attributed to the agent.
export const AgentRunPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type AgentRunPayload = z.infer<typeof AgentRunPayload>;

export const EndAgentRunPayload = z.object({
  workspaceId: WORKSPACE_ID,
  runId: z.string().min(1).max(200),
  status: z.enum(["complete", "failed"]).optional(),
});
export type EndAgentRunPayload = z.infer<typeof EndAgentRunPayload>;

const AgentRunRecordSchema = z.object({
  id: z.string().min(1),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  agentId: z.string(),
  onBehalfOf: z.string(),
  status: z.enum(["running", "complete", "failed"]),
});

export const StartAgentRunResult = AgentRunRecordSchema;
export type StartAgentRunResult = z.infer<typeof StartAgentRunResult>;

export const AgentRunStatusResult = z.object({
  mcpEnabled: z.boolean(),
  activeRun: AgentRunRecordSchema.nullable(),
  lastRun: AgentRunRecordSchema.nullable(),
});
export type AgentRunStatusResult = z.infer<typeof AgentRunStatusResult>;

// The copyable MCP config the user pastes into their AI tool. Main owns the
// real command/args (the renderer never invents a path or argv).
export const McpConfigResult = z.object({
  command: z.string(),
  args: z.array(z.string()),
  workspacePath: z.string(),
  home: z.string(),
});
export type McpConfigResult = z.infer<typeof McpConfigResult>;

const AgentDriverIdSchema = z.string().min(1).max(100);
const AgentPermissionKindSchema = z.enum([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);
const AgentPermissionDecisionSchema = z.union([
  AgentPermissionKindSchema,
  z.literal("cancel"),
]);
export type AgentPermissionDecision = z.infer<typeof AgentPermissionDecisionSchema>;

const AgentModelSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  planIncluded: z.boolean(),
});

const AgentDriverProbeSchema = z.object({
  id: AgentDriverIdSchema,
  displayName: z.string().min(1).max(100),
  installed: z.boolean(),
  version: z.string().max(200).optional(),
  auth: z.object({
    status: z.enum(["authenticated", "unauthenticated", "unknown"]),
    label: z.string().max(200).optional(),
  }),
  models: z.array(AgentModelSchema).max(50),
  errorMessage: z.string().max(500).optional(),
});

const AgentPermissionOptionSchema = z.object({
  optionId: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  kind: AgentPermissionKindSchema,
});

const AgentPermissionRequestSchema = z.object({
  requestId: z.string().min(1).max(200),
  requestType: z.enum(["command", "file-change", "file-read", "tool", "other"]),
  title: z.string().min(1).max(200),
  detail: z.string().max(500).optional(),
  locations: z.array(z.string().min(1).max(1000)).max(20),
  options: z.array(AgentPermissionOptionSchema).max(8),
});

const AgentSessionSnapshotSchema = z.object({
  driverId: AgentDriverIdSchema,
  driverName: z.string().min(1).max(100),
  status: z.enum([
    "idle",
    "starting",
    "ready",
    "running",
    "waiting-permission",
    "completed",
    "failed",
    "stopped",
  ]),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  runId: z.string().min(1).max(200).optional(),
  lastError: z.string().max(500).optional(),
  messages: z.array(
    z.object({
      id: z.string().min(1).max(300),
      role: z.enum(["assistant", "reasoning"]),
      text: z.string().max(10_000),
    }),
  ).max(200),
  items: z.array(
    z.object({
      id: z.string().min(1).max(300),
      type: z.enum(["tool_call", "command", "file_change", "mcp_tool_call", "web_search", "plan", "other"]),
      title: z.string().min(1).max(200),
      detail: z.string().max(500).optional(),
      status: z.enum(["pending", "in_progress", "completed", "failed"]),
      locations: z.array(z.string().min(1).max(1000)).max(20),
    }),
  ).max(200),
  pendingPermissions: z.array(AgentPermissionRequestSchema).max(20),
  usage: z.object({
    used: z.number(),
    max: z.number().optional(),
    input: z.number().optional(),
    output: z.number().optional(),
  }).optional(),
  authNotices: z.array(z.string().min(1).max(300)).max(5),
});

export const AgentPanelSnapshotResult = z.object({
  drivers: z.array(AgentDriverProbeSchema).max(20),
  session: AgentSessionSnapshotSchema.nullable(),
});
export type AgentPanelSnapshotResult = z.infer<typeof AgentPanelSnapshotResult>;

export const AgentPermissionResponsePayload = z.object({
  workspaceId: WORKSPACE_ID,
  requestId: z.string().min(1).max(200),
  decision: AgentPermissionDecisionSchema,
});
export type AgentPermissionResponsePayload = z.infer<typeof AgentPermissionResponsePayload>;

export const RunnerSelfTestPayload = z.object({
  workspaceId: WORKSPACE_ID,
}).strict();
export type RunnerSelfTestPayload = z.infer<typeof RunnerSelfTestPayload>;

export const StopAgentRunPayload = z.object({
  workspaceId: WORKSPACE_ID,
}).strict();
export type StopAgentRunPayload = z.infer<typeof StopAgentRunPayload>;

export const ResumeThreadDispatchPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: CHAT_THREAD_ID,
}).strict();
export type ResumeThreadDispatchPayload = z.infer<
  typeof ResumeThreadDispatchPayload
>;

export const ChatDispatchStateForThreadPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: CHAT_THREAD_ID,
}).strict();
export type ChatDispatchStateForThreadPayload = z.infer<
  typeof ChatDispatchStateForThreadPayload
>;

export const ChatDispatchStateForThreadResult = z.object({
  liveRun: z.boolean(),
  pendingCount: z.number().int().nonnegative(),
  paused: z.boolean(),
  pausedReason: z.string().min(1).max(500).optional(),
}).strict();
export type ChatDispatchStateForThreadResult = z.infer<
  typeof ChatDispatchStateForThreadResult
>;

export const RunnerSelfTestResult = z.object({
  ok: z.boolean(),
  detail: z.string().min(1).max(2_000),
}).strict();
export type RunnerSelfTestResult = z.infer<typeof RunnerSelfTestResult>;

export const DesktopUserSettings = DesktopUserSettingsSchema;
export const DesktopUserSettingsResult = DesktopUserSettingsResultSchema;
export type DesktopUserSettings = DesktopUserSettingsType;
export type DesktopUserSettingsResult = DesktopUserSettingsResultType;

export const SetUserSettingsPayload = z.object({
  settings: DesktopUserSettingsSchema,
}).strict();
export type SetUserSettingsPayload = z.infer<typeof SetUserSettingsPayload>;

export const WorkspaceSettings = WorkspaceSettingsSchema;
export const WorkspaceSettingsResult = WorkspaceSettingsResultSchema;
export type WorkspaceSettings = WorkspaceSettingsType;
export type WorkspaceSettingsResult = WorkspaceSettingsResultType;

export const WorkspaceSettingsPayload = z.object({
  workspaceId: WORKSPACE_ID,
}).strict();
export type WorkspaceSettingsPayload = z.infer<typeof WorkspaceSettingsPayload>;

// A save carries the changed controls, not the whole file: main merges them
// onto the settings on disk, so a stale caller cannot write back fields it
// never touched.
export const SetWorkspaceSettingsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  patch: WorkspaceSettingsPatchSchema,
}).strict();
export type SetWorkspaceSettingsPayload = z.infer<typeof SetWorkspaceSettingsPayload>;

export const WriteClipboardTextPayload = z.object({
  text: z.string().min(1).max(20_000),
}).strict();
export type WriteClipboardTextPayload = z.infer<typeof WriteClipboardTextPayload>;

// Native window chrome (Phase E1). The renderer mirrors its theme flip to
// main so the OS titleBarOverlay (Windows/Linux) re-tints with the app; main
// feature-detects overlay support and no-ops where it doesn't exist.
export const SetTitlebarThemePayload = z.object({
  theme: z.enum(["light", "dark"]),
});
export type SetTitlebarThemePayload = z.infer<typeof SetTitlebarThemePayload>;

// Application-menu commands. One closed set (channels.ts owns the tuple; the
// sandboxed preload validates against it as a plain value): the menu sends
// these names and the shell routes them through the SAME command registry the
// palette uses — menu items never grow their own action definitions.
export const MenuCommand = z.enum(MENU_COMMANDS);
export type MenuCommand = z.infer<typeof MenuCommand>;

// Main→renderer auto-update event (Phase E2 status bar toast). channels.ts
// owns the closed status tuple and the dependency-free preload check
// (parseUpdateStateEvent) — this schema derives from the same tuple so the
// two can never drift. Only public status/action metadata crosses the boundary;
// feed URLs and updater configuration stay main-process-only.
export const UpdateStateEvent = z.object({
  status: z.enum(UPDATE_STATUSES),
  message: z.string().min(1).max(500),
  currentVersion: z.string().min(1).max(200).optional(),
  channel: z.enum(UPDATE_CHANNELS).optional(),
  canCheck: z.boolean().optional(),
  canInstall: z.boolean().optional(),
  version: z.string().min(1).max(200).optional(),
  percent: z.number().finite().min(0).max(100).optional(),
});
export type UpdateStateEvent = z.infer<typeof UpdateStateEvent>;

export const UpdateActionResult = z.object({
  accepted: z.boolean(),
  completed: z.boolean(),
  state: UpdateStateEvent,
});
export type UpdateActionResult = z.infer<typeof UpdateActionResult>;

export const UpdateCheckResult = z.object({
  checked: z.boolean(),
  state: UpdateStateEvent,
});
export type UpdateCheckResult = z.infer<typeof UpdateCheckResult>;

// Per-workspace UI state persisted to .dohc/ui-state.json by MAIN (the
// renderer cannot write .dohc through writeWorkspaceText by design —
// validateUserWritePath refuses reserved paths). The clamp/cap constants are
// the pure workbench model's, so contract and model can never disagree.
export const WorkspaceUiState = z.object({
  version: z.literal(1),
  // Retired views stay accepted: getWorkspaceUiState safeParses the WHOLE
  // file, so one stale activeView (e.g. the removed Agent panel's "agent")
  // must degrade to the default view — never null every tab/pin/fold the
  // user had. parseUiState maps unknown views to the default.
  activeView: z.enum([...VIEW_IDS, ...RETIRED_VIEW_IDS]),
  sidebarVisible: z.boolean(),
  sidebarWidth: z.number().int().min(SIDEBAR_MIN_WIDTH).max(SIDEBAR_MAX_WIDTH),
  tabs: z.array(PATH_STRING).max(MAX_OPEN_TABS),
  activeTab: PATH_STRING.nullable(),
  // The right-hand Chats panel (replaced the history rail's historyVisible/
  // historyWidth). Optional, still version 1: files written before the panel
  // existed keep parsing (their history fields are dropped as unknown keys)
  // instead of nulling every tab/pin/fold the user had.
  chatsVisible: z.boolean().optional(),
  chatsWidth: z.number().int().min(CHATS_MIN_WIDTH).max(CHATS_MAX_WIDTH).optional(),
  // Additive (resizable Open Editors section), still version 1. It must NEVER
  // null the whole saved state: serializeUiState clamps every write, so this
  // catch only handles foreign/hand-edited files.
  openEditorsHeight: z
    .number()
    .int()
    .min(OPEN_EDITORS_MIN_HEIGHT)
    .max(OPEN_EDITORS_MAX_HEIGHT)
    .optional()
    .catch(undefined),
  // Additive (Phase E3 explorer), still version 1: optional fields parse old
  // files, and zod's non-strict parse drops unknown keys for old readers.
  expandedFolders: z.array(PATH_STRING).max(MAX_EXPANDED_FOLDERS).optional(),
  pinned: z.array(PATH_STRING).max(MAX_PINNED_PATHS).optional(),
  // Additive (Phase E5.0 quick-open ranking), still version 1: the last ~20
  // opened files, most recent first — recency boosts quick-open results.
  recentFiles: z.array(PATH_STRING).max(MAX_RECENT_FILES).optional(),
});
export type WorkspaceUiState = z.infer<typeof WorkspaceUiState>;

export const GetWorkspaceUiStateResult = WorkspaceUiState.nullable();
export type GetWorkspaceUiStateResult = z.infer<typeof GetWorkspaceUiStateResult>;

export const SetWorkspaceUiStatePayload = z.object({
  workspaceId: WORKSPACE_ID,
  state: WorkspaceUiState,
});
export type SetWorkspaceUiStatePayload = z.infer<typeof SetWorkspaceUiStatePayload>;

// Workspace content search (Phase E5.0). The renderer mints a bounded
// searchId per search; main spawns ripgrep rooted at the real workspace root
// and STREAMS batches back over the desktop:search-results event channel
// (closed shape, validated in the dependency-free preload via
// parseSearchResultsEvent — these zod schemas are the main-side mirror, with
// the same bounds, used to validate batches BEFORE they are sent).
const SEARCH_ID = z.string().min(1).max(SEARCH_EVENT_MAX_ID_CHARS);

export const WorkspaceSearchPayload = z.object({
  workspaceId: WORKSPACE_ID,
  searchId: SEARCH_ID,
  // Bounded like every IPC string: a pattern is a line of text, never a blob.
  query: z.string().min(1).max(1000),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  regex: z.boolean().optional(),
  includeGlob: z.string().min(1).max(256).optional(),
  excludeGlob: z.string().min(1).max(256).optional(),
});
export type WorkspaceSearchPayload = z.infer<typeof WorkspaceSearchPayload>;

export const CancelWorkspaceSearchPayload = z.object({
  searchId: SEARCH_ID,
});
export type CancelWorkspaceSearchPayload = z.infer<
  typeof CancelWorkspaceSearchPayload
>;

const SearchResultEntrySchema = z.object({
  path: PATH_STRING,
  line: z.number().int().min(1),
  column: z.number().int().min(1),
  preview: z.string().max(SEARCH_EVENT_MAX_PREVIEW_CHARS),
  matchStart: z.number().int().min(0),
  matchEnd: z.number().int().min(0),
  surface: z.enum(["file", "chat"]).optional(),
  threadId: z.string().min(1).max(200).optional(),
  objectId: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(500).optional(),
});

export const SearchResultsEventSchema = z.object({
  searchId: SEARCH_ID,
  entries: z.array(SearchResultEntrySchema).max(SEARCH_EVENT_MAX_ENTRIES),
  done: z.boolean(),
  limitHit: z.boolean(),
  // A short, user-facing explanation when search is paused/degraded (e.g. a
  // policy file failed to parse and file search fails closed). Optional so
  // ordinary result batches omit it entirely.
  notice: z.string().min(1).max(500).optional(),
});
export type SearchResultsEventSchema = z.infer<typeof SearchResultsEventSchema>;

// WS-G2-C-2 engine Y.Doc binding IPC. The renderer mints a bounded sessionId
// per open; main constructs the node-only live session (through the workspace's
// engine capture, reusing its store) and STREAMS remote CRDT deltas back over
// the desktop:engine-ydoc-remote-update event channel. Updates cross IPC as raw
// Uint8Array (structured clone). These zod schemas are the main-side mirror of
// the dependency-free preload parseEngineYDocRemoteUpdateEvent bounds.
const ENGINE_YDOC_SESSION_ID = z.string().min(1).max(ENGINE_YDOC_SESSION_ID_MAX_CHARS);
// z.custom (not z.instanceof) so the inferred type is a plain `Uint8Array`
// (ArrayBufferLike) — matching yjs's update type and the transport — rather than
// the ArrayBuffer-narrowed shape z.instanceof yields.
const ENGINE_YDOC_UPDATE = z.custom<Uint8Array>(
  (value) =>
    value instanceof Uint8Array &&
    value.byteLength > 0 &&
    value.byteLength <= ENGINE_YDOC_UPDATE_MAX_BYTES,
  "Y.Doc update is not a Uint8Array within the IPC byte bound.",
);
const ENGINE_YDOC_INITIAL_UPDATE = z.custom<Uint8Array>(
  (value) => value instanceof Uint8Array && value.byteLength <= ENGINE_YDOC_UPDATE_MAX_BYTES,
  "Y.Doc initial update is not a Uint8Array within the IPC byte bound.",
);

export const OpenEngineYDocSessionPayload = z.object({
  workspaceId: WORKSPACE_ID,
  sessionId: ENGINE_YDOC_SESSION_ID,
  path: PATH_STRING,
});
export type OpenEngineYDocSessionPayload = z.infer<typeof OpenEngineYDocSessionPayload>;

export const OpenEngineYDocSessionResult = z.object({
  available: z.boolean(),
  initialUpdate: ENGINE_YDOC_INITIAL_UPDATE.optional(),
  // The path is not in the version the workspace is on — a version switch
  // removed it while this open was queued behind that switch (#534). Every
  // other available:false reason downgrades the document to the writable plain
  // editor; this one must not, because that editor would autosave the path back
  // into the version as a phantom file.
  notInVersion: z.boolean().optional(),
  // The open did not land, and a session for this document may still be the
  // engine's. It is raised by an open that hit its retry deadline while the
  // engine was unreachable (#564), an open whose refusal could not release its
  // own session, and a session main holds whose close failed (#657). Like
  // notInVersion, it must not downgrade to the writable plain editor: a plain
  // autosave beside a session the engine still binds takes the disk path #533
  // closed. The caller stays read-only, states the reason, and offers a retry —
  // which is also what discharges what the failure left behind.
  engineMayHoldDocument: z.boolean().optional(),
  // A delete or move owns this path for an interval. The renderer must stay
  // read-only and offer a retry, without claiming that the operation finished.
  removalInProgress: z
    .object({
      operation: z.enum(["delete", "move"]),
      message: z.string().min(1),
    })
    .optional(),
});
export type OpenEngineYDocSessionResult = z.infer<typeof OpenEngineYDocSessionResult>;

export const ApplyEngineYDocUpdatePayload = z.object({
  sessionId: ENGINE_YDOC_SESSION_ID,
  update: ENGINE_YDOC_UPDATE,
  // Monotonic per-session local-edit counter. Main echoes the seq a settle
  // STARTED at back on the save-state channel so the renderer never shows
  // "Saved" for a settle that predates the user's latest keystroke.
  //
  // DEFAULTED, never required: this handler is a hardened boundary whose
  // contract is an inert no-op for an unknown/foreign/read-only session — it
  // must never throw. A required field would reject at the schema, BEFORE the
  // session lookup, converting that silent refusal into an exception.
  seq: z.number().int().nonnegative().default(0),
});
export type ApplyEngineYDocUpdatePayload = z.infer<typeof ApplyEngineYDocUpdatePayload>;

export const CloseEngineYDocSessionPayload = z.object({
  sessionId: ENGINE_YDOC_SESSION_ID,
});
export type CloseEngineYDocSessionPayload = z.infer<typeof CloseEngineYDocSessionPayload>;

export const EngineYDocRemoteUpdateEventSchema = z.object({
  sessionId: ENGINE_YDOC_SESSION_ID,
  update: ENGINE_YDOC_UPDATE,
});

export const EngineYDocSaveStateEventSchema = z.object({
  sessionId: ENGINE_YDOC_SESSION_ID,
  state: z.enum(ENGINE_YDOC_SAVE_STATES),
  seq: z.number().int().nonnegative(),
});
export type EngineYDocRemoteUpdateEventSchema = z.infer<
  typeof EngineYDocRemoteUpdateEventSchema
>;

// Test-only snapshot of the main-process mark/measure recorder (Phase 16):
// named marks as wall-clock epochs, measures as durations between marks.
export const DesktopMarksResult = z.object({
  marks: z.record(z.string(), z.number()),
  measures: z.record(z.string(), z.number()),
});
export type DesktopMarksResult = z.infer<typeof DesktopMarksResult>;

export const LaunchMarksResult = z.object({
  appReadyMs: z.number().positive(),
  firstWindowMs: z.number().positive(),
  firstPaintMs: z.number().positive(),
  shellVisibleMs: z.number().positive().optional(),
});
export type LaunchMarksResult = z.infer<typeof LaunchMarksResult>;

export interface DohcDesktopBridge {
  // Constant, not a call: the titlebar lays out around macOS traffic lights
  // on darwin vs the window-controls overlay everywhere else.
  platform: NodeJS.Platform;
  reloadRenderer(): Promise<void>;
  pickWorkspaceRoot(): Promise<PickWorkspaceRootResult>;
  getWorkspaceRegistry(): Promise<WorkspaceRegistryResult>;
  getDefaultWorkspaceRoot(): Promise<string>;
  createLocalWorkspace(
    payload: CreateLocalWorkspacePayload,
  ): Promise<WorkspaceSummary>;
  attachWorkspaceFolder(
    payload: AttachWorkspaceFolderPayload,
  ): Promise<WorkspaceSummary>;
  listWorkspaceFiles(
    payload: ListWorkspaceFilesPayload,
  ): Promise<ListWorkspaceFilesResult>;
  createWorkspaceFile(
    payload: CreateWorkspaceFilePayload,
  ): Promise<CreateWorkspaceFileResult>;
  createWorkspaceFolder(
    payload: CreateWorkspaceFolderPayload,
  ): Promise<CreateWorkspaceFileResult>;
  moveWorkspacePath(
    payload: MoveWorkspacePathPayload,
  ): Promise<CreateWorkspaceFileResult>;
  deleteWorkspacePath(
    payload: DeleteWorkspacePathPayload,
  ): Promise<DeleteWorkspacePathResult>;
  exportWorkspaceZip(
    payload: ExportWorkspaceZipPayload,
  ): Promise<ExportWorkspaceZipResult>;
  // Document export ("Copy as Markdown" / "Export as HTML" / "Export as
  // PDF" menu, ViewHeader). See the payload's comment for the kind split.
  exportDocumentFile(
    payload: ExportDocumentFilePayload,
  ): Promise<ExportDocumentFileResult>;
  // Native explorer context menu; resolves with the chosen closed-tuple
  // command (validated in the preload via isExplorerMenuCommand) or null.
  showExplorerMenu(
    payload: ShowExplorerMenuPayload,
  ): Promise<ShowExplorerMenuResult>;
  showWorkbenchMenu(
    payload: ShowWorkbenchMenuPayload,
  ): Promise<ShowWorkbenchMenuResult>;
  // OS drag-in: maps dropped File objects to absolute paths via
  // webUtils.getPathForFile in the PRELOAD (sandboxed renderers have no
  // File.path since Electron 32). The paths feed importWorkspaceFiles'
  // droppedPaths — see the trust-delta note on that payload.
  getDroppedFilePaths(files: File[]): string[];
  importWorkspaceFiles(
    payload: ImportWorkspaceFilesPayload,
  ): Promise<ImportWorkspaceFilesResult>;
  readWorkspaceText(
    payload: ReadWorkspaceTextPayload,
  ): Promise<ReadWorkspaceTextResult>;
  writeWorkspaceText(payload: WriteWorkspaceTextPayload): Promise<void>;
  writeWorkspaceAsset(payload: WriteWorkspaceAssetPayload): Promise<void>;
  // `/image`: a MAIN-process open dialog rooted at the workspace directory,
  // returning the chosen files' bytes (see PickImageFilesPayload).
  pickImageFiles(payload: PickImageFilesPayload): Promise<PickImageFilesResult>;
  openFileExternally(payload: OpenFileExternallyPayload): Promise<void>;
  readWorkspaceGraph(
    payload: ReadWorkspaceGraphPayload,
  ): Promise<WorkspaceGraphResult>;
  getBacklinks(payload: GetBacklinksPayload): Promise<GetBacklinksResult>;
  listWorkspaceHeadings(
    payload: ListWorkspaceHeadingsPayload,
  ): Promise<ListWorkspaceHeadingsResult>;
  listChatFileMentions(
    payload: ListChatFileMentionsPayload,
  ): Promise<ListChatFileMentionsResult>;
  listChatBookmarks(payload: ListChatBookmarksPayload): Promise<ListChatBookmarksResult>;
  saveChatBookmark(payload: SaveChatBookmarkPayload): Promise<SaveChatBookmarkResult>;
  archiveChatBookmark(
    payload: ArchiveChatBookmarkPayload,
  ): Promise<ArchiveChatBookmarkResult>;
  readWorkspaceDatabase(
    payload: ReadWorkspaceDatabasePayload,
  ): Promise<DatabaseSnapshotResult>;
  applyDatabaseEdit(
    payload: ApplyDatabaseEditPayload,
  ): Promise<DatabaseSnapshotResult>;
  importToDatabase(
    payload: ImportToDatabasePayload,
  ): Promise<ImportToDatabaseResult>;
  listSites(payload: ListSitesPayload): Promise<ListSitesResult>;
  getSitePackage(payload: SitePackagePayload): Promise<SitePackageResult>;
  startSitePreview(payload: StartSitePreviewPayload): Promise<StartSitePreviewResult>;
  stopSitePreview(payload: StopSitePreviewPayload): Promise<StopSitePreviewResult>;
  invokeSiteSdk(payload: InvokeSiteSdkPayload): Promise<InvokeSiteSdkResult>;
  openExternalUrl(payload: OpenExternalUrlPayload): Promise<void>;
  cloudLoginStart(payload: CloudLoginStartPayload): Promise<CloudLoginStartResult>;
  cloudLoginPoll(): Promise<CloudLoginPollResult>;
  cloudStatus(payload?: CloudStatusPayload): Promise<CloudStatusResult>;
  cloudLogout(): Promise<void>;
  cloudEnableSync(payload: CloudEnableSyncPayload): Promise<SyncStatusResult>;
  cloudJoinWorkspace(
    payload: CloudJoinWorkspacePayload,
  ): Promise<CloudJoinWorkspaceResult>;
  dismissSyncReviewNotice(payload: DismissSyncReviewNoticePayload): Promise<void>;
  // Relay shares (PR 18): grant side.
  createRelayShare(payload: CreateRelaySharePayload): Promise<CreateRelayShareResult>;
  listRelayShares(): Promise<ListRelaySharesResult>;
  revokeRelayShare(payload: RevokeRelaySharePayload): Promise<void>;
  shareChatChannel(payload: ShareChatChannelPayload): Promise<ShareChatChannelResult>;
  listChatChannelShares(
    payload: ListChatChannelSharesPayload,
  ): Promise<ListChatChannelSharesResult>;
  listJoinedSharedChannels(
    payload: ListJoinedSharedChannelsPayload,
  ): Promise<ListJoinedSharedChannelsResult>;
  joinSharedChannel(payload: JoinSharedChannelPayload): Promise<JoinSharedChannelResult>;
  leaveSharedChannel(payload: LeaveSharedChannelPayload): Promise<void>;
  // Relay shares (PR 18): receive side — read-only shared views.
  openSharedView(payload: OpenSharedViewPayload): Promise<OpenSharedViewResult>;
  refreshSharedView(payload: RefreshSharedViewPayload): Promise<RefreshSharedViewResult>;
  dismissShareSkips(payload: DismissShareSkipsPayload): Promise<void>;
  // Share mounts: a received share materialized into a host workspace's
  // shared-with-me/<label>/ as ordinary read-only files.
  mountShare(payload: MountSharePayload): Promise<MountShareResult>;
  refreshShareMounts(
    payload: RefreshShareMountsPayload,
  ): Promise<RefreshShareMountsResult>;
  unmountShare(payload: UnmountSharePayload): Promise<UnmountShareResult>;
  openWorkspace(payload: OpenWorkspacePayload): Promise<SyncStatusResult>;
  // Named versions (PR 0M-4). Gated in main on the workspace-engine alpha
  // flag: for unflagged workspaces every call rejects.
  listWorkspaceVersions(
    payload: ListWorkspaceFilesPayload,
  ): Promise<ListWorkspaceVersionsResult>;
  createWorkspaceVersion(
    payload: CreateWorkspaceVersionPayload,
  ): Promise<ListWorkspaceVersionsResult>;
  switchWorkspaceVersion(
    payload: SwitchWorkspaceVersionPayload,
  ): Promise<SwitchWorkspaceVersionResult>;
  compareWorkspaceVersions(
    payload: CompareWorkspaceVersionsPayload,
  ): Promise<CompareWorkspaceVersionsResult>;
  mergeWorkspaceVersion(
    payload: MergeWorkspaceVersionPayload,
  ): Promise<MergeWorkspaceVersionResult>;
  listWorkspaceVersionConflicts(
    payload: ListWorkspaceVersionConflictsPayload,
  ): Promise<ListWorkspaceVersionConflictsResult>;
  resolveWorkspaceVersionConflict(
    payload: ResolveWorkspaceVersionConflictPayload,
  ): Promise<ResolveWorkspaceVersionConflictResult>;
  // "Try it in a version" (PR 0N-2). The gesture is engine-gated like the
  // other version operations; state/dismiss are safe no-ops elsewhere.
  tryInWorkspaceVersion(
    payload: TryInWorkspaceVersionPayload,
  ): Promise<TryInWorkspaceVersionResult>;
  getTryInVersionState(
    payload: ListWorkspaceFilesPayload,
  ): Promise<TryInVersionStateResult>;
  dismissTryInVersionReview(payload: ListWorkspaceFilesPayload): Promise<void>;
  // Engine history + linked Chats (PR 0M-5). Gated in main on the
  // workspace-engine alpha flag: for unflagged workspaces every call rejects.
  listEngineMoments(
    payload: ListEngineMomentsPayload,
  ): Promise<ListEngineMomentsResult>;
  readEngineMoment(
    payload: ReadEngineMomentPayload,
  ): Promise<ReadEngineMomentResult>;
  restoreEngineMomentFile(
    payload: RestoreEngineMomentFilePayload,
  ): Promise<RestoreEngineMomentFileResult>;
  listFileChats(payload: ListFileChatsPayload): Promise<ListFileChatsResult>;
  createFileChat(payload: CreateFileChatPayload): Promise<CreateFileChatResult>;
  listChatMessages(
    payload: ListChatMessagesPayload,
  ): Promise<ListChatMessagesResult>;
  sendChatMessage(payload: SendChatMessagePayload): Promise<SendChatMessageResult>;
  listChatThreadDecisions(
    payload: ListChatThreadDecisionsPayload,
  ): Promise<ListChatThreadDecisionsResult>;
  resolveChatDecision(
    payload: ResolveChatDecisionPayload,
  ): Promise<ResolveChatDecisionResult>;
  listChatThreadAttachments(
    payload: ListChatThreadAttachmentsPayload,
  ): Promise<ListChatThreadAttachmentsResult>;
  chatRunRecordsForThread(
    payload: ChatRunRecordsForThreadPayload,
  ): Promise<ChatRunRecordsForThreadResult>;
  // Chats channels (PR 12/13, WS-E) — same flag gate as the file rail.
  listChatChannels(
    payload: ListChatChannelsPayload,
  ): Promise<ListChatChannelsResult>;
  listChatFollows(payload: ListChatFollowsPayload): Promise<ListChatFollowsResult>;
  setChatFollow(payload: SetChatFollowPayload): Promise<SetChatFollowResult>;
  listPersonalChatFeed(
    payload: ListPersonalChatFeedPayload,
  ): Promise<ListPersonalChatFeedResult>;
  markPersonalChatFeedSeen(payload: MarkPersonalChatFeedSeenPayload): Promise<void>;
  createChatChannel(
    payload: CreateChatChannelPayload,
  ): Promise<CreateChatChannelResult>;
  listChannelThreads(
    payload: ListChannelThreadsPayload,
  ): Promise<ListChannelThreadsResult>;
  startChannelThread(
    payload: StartChannelThreadPayload,
  ): Promise<StartChannelThreadResult>;
  markChatThreadRead(
    payload: MarkChatThreadReadPayload,
  ): Promise<MarkChatThreadReadResult>;
  // Reactions (WS-MU-C2): list active reactions for a thread and add/remove
  // the viewer's own. Same gate as the rest of chat.
  listChatReactions(
    payload: ListChatReactionsPayload,
  ): Promise<ListChatReactionsResult>;
  setChatReaction(
    payload: SetChatReactionPayload,
  ): Promise<SetChatReactionResult>;
  // Direct messages (WS-MU-C3): reconcile DM state with the relay and list the
  // workspace's DMs; start (or continue) a DM with a recipient set.
  syncDms(payload: SyncDmsPayload): Promise<SyncDmsResult>;
  acceptDm(payload: AcceptDmPayload): Promise<AcceptDmResult>;
  declineDm(payload: DeclineDmPayload): Promise<void>;
  requestDmAgain(payload: RequestDmAgainPayload): Promise<void>;
  startDm(payload: StartDmPayload): Promise<StartDmResult>;
  leaveDm(payload: LeaveDmPayload): Promise<void>;
  // Ephemeral presence (MU-C5): IPC-proxied so the relay bearer token stays in
  // main. publish (or leave) a presence state and long-poll for peer changes;
  // presenceCancel aborts an in-flight poll on unmount / workspace switch.
  presencePublish(payload: PresencePublishPayload): Promise<PresenceResult>;
  presencePoll(payload: PresencePollPayload): Promise<PresenceResult>;
  presenceCancel(payload: PresenceCancelPayload): Promise<void>;
  getSyncStatus(payload: ListWorkspaceFilesPayload): Promise<SyncStatusResult>;
  startAgentRun(payload: AgentRunPayload): Promise<StartAgentRunResult>;
  endAgentRun(payload: EndAgentRunPayload): Promise<void>;
  getAgentRunStatus(payload: AgentRunPayload): Promise<AgentRunStatusResult>;
  getMcpConfig(payload: AgentRunPayload): Promise<McpConfigResult>;
  probeAgentDrivers(payload: AgentRunPayload): Promise<AgentPanelSnapshotResult>;
  getAgentSessionState(payload: AgentRunPayload): Promise<AgentPanelSnapshotResult>;
  answerAgentPermission(
    payload: AgentPermissionResponsePayload,
  ): Promise<AgentPanelSnapshotResult>;
  stopAgentRun(payload: StopAgentRunPayload): Promise<void>;
  resumeThreadDispatch(payload: ResumeThreadDispatchPayload): Promise<void>;
  chatDispatchStateForThread(
    payload: ChatDispatchStateForThreadPayload,
  ): Promise<ChatDispatchStateForThreadResult>;
  runnerSelfTest(payload: RunnerSelfTestPayload): Promise<RunnerSelfTestResult>;
  getUserSettings(): Promise<DesktopUserSettingsResult>;
  setUserSettings(payload: SetUserSettingsPayload): Promise<DesktopUserSettingsResult>;
  resetUserSettings(): Promise<DesktopUserSettingsResult>;
  getWorkspaceSettings(
    payload: WorkspaceSettingsPayload,
  ): Promise<WorkspaceSettingsResult>;
  setWorkspaceSettings(
    payload: SetWorkspaceSettingsPayload,
  ): Promise<WorkspaceSettingsResult>;
  resetWorkspaceSettings(
    payload: WorkspaceSettingsPayload,
  ): Promise<WorkspaceSettingsResult>;
  writeClipboardText(payload: WriteClipboardTextPayload): Promise<void>;
  setTitlebarTheme(payload: SetTitlebarThemePayload): Promise<void>;
  // Per-workspace workbench UI state (.dohc/ui-state.json), main-owned.
  getWorkspaceUiState(
    payload: ListWorkspaceFilesPayload,
  ): Promise<GetWorkspaceUiStateResult>;
  setWorkspaceUiState(payload: SetWorkspaceUiStatePayload): Promise<void>;
  // Live push: main signals the renderer when the active workspace's files
  // or history changed (settled filesystem batch recorded). Returns an
  // unsubscribe function.
  onWorkspaceActivity(listener: () => void): () => void;
  // Live push: main signals a cloud session transition (login, logout,
  // account switch, or a relay proving the session dead). Account-scoped
  // renderer caches — the relay-backed share rows — refresh on this signal;
  // the generic activity ping deliberately reaches only cheap local
  // refreshes. The event carries the NEW session's key (null when signed
  // out) so a same-account token rotation invalidates nothing. Returns an
  // unsubscribe function.
  // The phase completes the two-moment transition contract: "changing" is
  // transition start (preserve same-session state, ask for nothing — the
  // credential cache is mid-transition), "ready" is adoption end (run the
  // one revalidation against the settled session).
  onCloudSessionChanged(
    listener: (event: {
      sessionKey: string | null;
      phase: "changing" | "ready";
    }) => void,
  ): () => void;
  // Application-menu clicks, validated against MenuCommand in the preload
  // before they reach renderer code. Returns an unsubscribe function.
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  // Native Open Recent / OS "Open with dohc" activation. Main sends a full
  // workspace summary; the preload strips and validates it before the root
  // swaps workspaces.
  onWorkspaceActivated(listener: (workspace: WorkspaceSummary) => void): () => void;
  // Auto-update state pushes from main, validated against the closed
  // UPDATE_STATUSES tuple in the preload (parseUpdateStateEvent) before they
  // reach renderer code. Returns an unsubscribe function.
  onUpdateState(listener: (state: UpdateStateEvent) => void): () => void;
  // Explicit update actions. The renderer can ask main to check or install;
  // it cannot set feed URLs or mutate update channels.
  getUpdateState(): Promise<UpdateStateEvent>;
  checkForUpdates(): Promise<UpdateCheckResult>;
  installUpdate(): Promise<UpdateActionResult>;
  // Quit interception (#567): main asks before a quit proceeds so set-aside
  // drafts can warn FIRST — electron-updater's quitAndInstall is one-shot,
  // so the decision must come before any destructive call. The renderer
  // either holds the quit (its dialog owns the decision) or resumes it.
  onQuitRequested(listener: () => void): () => void;
  // Main re-checks recovery drafts at the quit boundary (#579 review, r12):
  // the renderer answers whether any unresolved set-aside edit would be lost.
  onRecoveryCheckRequested(listener: (requestId: number) => void): () => void;
  answerRecoveryCheck(payload: {
    requestId: number;
    blocked: boolean;
  }): Promise<void>;
  holdQuit(): Promise<void>;
  resumeQuit(): Promise<void>;
  // Workspace content search (Phase E5.0). Resolves when the search has been
  // ACCEPTED and the rg child spawned; results stream separately through
  // onSearchResults. Issuing a new search cancels the previous one in main.
  searchWorkspace(payload: WorkspaceSearchPayload): Promise<void>;
  cancelWorkspaceSearch(payload: CancelWorkspaceSearchPayload): Promise<void>;
  // Streamed result batches, validated batch-by-batch in the preload via the
  // closed dependency-free parseSearchResultsEvent check. Returns an
  // unsubscribe function. The searchId round-trips so the renderer drops
  // batches that belong to a superseded search.
  onSearchResults(listener: (batch: SearchResultsEvent) => void): () => void;
  // WS-G2-C-2 engine Y.Doc editor binding. The renderer mints a sessionId and
  // opens a live engine Y.Doc session for a rich file; main constructs the
  // node-only session through the workspace's engine capture (reusing its
  // store). available:false => not engine-backed
  // (unflagged workspace, secret path, missing file, or already live) — the
  // caller falls back to the plain local autosave editor. On success
  // initialUpdate seeds the renderer's mirror doc.
  openEngineYDocSession(
    payload: OpenEngineYDocSessionPayload,
  ): Promise<OpenEngineYDocSessionResult>;
  // Ship a local editor CRDT update to main (journaled via recordUpdate +
  // debounced settle). A no-op if the session is unknown/closed.
  applyEngineYDocUpdate(payload: ApplyEngineYDocUpdatePayload): Promise<void>;
  // Settle + close the session in main (releases the single-canonical
  // reservation so the same object can reopen on a version/file switch).
  closeEngineYDocSession(payload: CloseEngineYDocSessionPayload): Promise<void>;
  // Remote CRDT deltas main forwards (a co-editor's edit routed through the
  // engine), validated in the preload via parseEngineYDocRemoteUpdateEvent.
  // The sessionId round-trips so the renderer applies only deltas for the
  // session currently bound. Returns an unsubscribe function.
  onEngineYDocRemoteUpdate(
    listener: (event: EngineYDocRemoteUpdateEvent) => void,
  ): () => void;
  // The document's REAL save state, pushed on every settle outcome. The editor
  // must never claim "Saved" from anything else: a settle can fail (and used to
  // fail silently) while the renderer's own timer said the doc was safe.
  onEngineYDocSaveState(
    listener: (event: EngineYDocSaveStateEvent) => void,
  ): () => void;
}
