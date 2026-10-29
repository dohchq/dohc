import { ChatLinksInput } from "@dohc/workspace-contracts/chat-links";
import { ChatFileMentionsInput, ChatFileMentionsPage } from "@dohc/workspace-contracts/chat-file-mentions";
// The dohc MCP server. The user's AI tool (Claude Code, Codex) is the client,
// launching it as a stdio child via its own config:
//   { mcpServers: { dohc: { command, args: ["--workspace", root, "--home", home] } } }
// Stdio is scoped by construction — only the configured tool talks to it — so
// there is no shared-secret auth to manage (a persistent HTTP server would
// need one). Every tool routes through src/tools.ts, which contains all path
// validation; this file is only registration + transport.

import { LinksEdgesInput, LinksInInput, LinksResolveInput } from "@dohc/workspace-contracts/links";
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { HistoryOperationId } from "@dohc/workspace-contracts/history-operation";
import { ShareCopyInput } from "@dohc/workspace-contracts/share-copy";
import { MCP_TOOL_LEVELS } from "./mcpAdvertisement";
import { OwnerAppPublicationRequest } from "@dohc/cli/app-publication";
import { DatasetRequest } from "@dohc/cli/dataset";
import { MAX_VERSION_NAME_LENGTH, documentAgentNameSchema, documentEditTextSchema, requestIdSchema, versionResolutionSchema } from "@dohc/cli/protocol";
import {
  isShareAccessValue,
  SHARE_ACCESS_VALUES,
  type ShareAccess,
} from "@dohc/security-contract/share-selector";
import {
  MCP_TOOL_CAPABILITIES,
  chatLinks, chatFileMentions, linksEdges, linksIn, linksResolve, readOperation, undoOperation, listVersions, compareVersion, listVersionConflicts, createVersion, switchVersion, mergeVersion, resolveVersionConflict,
  getShareCopyDetails,
  createDocument,
  createRecord,
  dataset, publishApp,
  createWorkspaceDirectory,
  listAutomationRuns,
  listAutomations, switchAutomation,
  listGroups,
  pressButton,
  inspectButtons,
  queryCollection,
  readAutomationRun,
  retryAutomationRun,
  readRecord,
  setRecordFields,
  listFileChats,
  readChat,
  replyToChat,
  startGroupChat,
  startFileChat,
  createApp,
  duplicateWorkspaceFile,
  deleteWorkspacePath,
  detectApps,
  editDocument,
  importData,
  listWorkspaceFiles,
  listChanges,
  listKeptCopies,
  listWorkspaces,
  moveWorkspacePath,
  queryDatabase,
  readChange,
  readDocument,
  readWorkspaceFile,
  saveKeptCopy,
  saveRecoveryCopy,
  retryKeptEdits,
  stopAgain,
  listRetainedCopies,
  deleteRetainedCopies,
  searchWorkspaceFiles,
  testApp,
  writeWorkspaceFile,
  workspaceStatus,
  stopWorkspaceSync,
  type ToolContext,
} from "./tools";

export function parseArgs(argv: string[]): ToolContext {
  let root = nonEmptyArg(process.cwd(), "workspace root");
  let home = nonEmptyArg(process.env.HOME ?? process.cwd(), "home path");
  let shareAccess: ShareAccess | undefined;
  const tools = new Set<keyof typeof MCP_TOOL_CAPABILITIES>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workspace" && argv[i + 1]) root = nonEmptyArg(argv[++i], "--workspace");
    else if (argv[i] === "--home" && argv[i + 1]) home = nonEmptyArg(argv[++i], "--home");
    else if (argv[i] === "--share-access") shareAccess = shareAccessArg(argv[++i]);
    else if (argv[i] === "--tool") tools.add(toolArg(argv[++i]));
  }
  return {
    root,
    home,
    ...(shareAccess ? { shareAccess } : {}),
    ...(tools.size > 0 ? { tools } : {}),
  };
}

function nonEmptyArg(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} requires a non-empty value`);
  return trimmed;
}

// An unreadable level is refused, never read as the narrowest one: a guess
// here decides which write tools an agent is offered.
function shareAccessArg(value: string | undefined): ShareAccess {
  if (isShareAccessValue(value)) return value;
  const received = value === undefined ? "no value" : JSON.stringify(value);
  throw new Error(
    `--share-access must be one of ${SHARE_ACCESS_VALUES.join(", ")}. Received: ${received}.`,
  );
}

function isToolName(value: string | undefined): value is keyof typeof MCP_TOOL_CAPABILITIES {
  return value !== undefined && Object.hasOwn(MCP_TOOL_CAPABILITIES, value);
}

// A misspelled tool is refused, never read as offering every tool.
function toolArg(value: string | undefined): keyof typeof MCP_TOOL_CAPABILITIES {
  if (isToolName(value)) return value;
  const received = value === undefined ? "no value" : JSON.stringify(value);
  throw new Error(`--tool must name a dohc tool, such as dohc_reply_to_chat. Received: ${received}.`);
}

function text(structuredContent: Record<string, unknown> | null) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    ...(structuredContent === null ? {} : { structuredContent }),
    ...(structuredContent?.ok === false || structuredContent?.kind === "partial" ? { isError: true } : {}),
  };
}

export function createDohcMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "dohc", version: "0.3.0" });

  const level = ctx.shareAccess ?? "owner";
  function register<InputArgs extends z.ZodRawShape>(
    name: keyof typeof MCP_TOOL_CAPABILITIES,
    config: { description: string; inputSchema: InputArgs },
    handler: ToolCallback<InputArgs>,
  ) {
    if (MCP_TOOL_LEVELS[name].includes(level) && (ctx.tools?.has(name) ?? true)) server.registerTool(name, config, handler);
  }

  register("dohc_read_share_copy", {
    description: "Read one owned grant's share code and named-account invite link. Requires the original workspace and its signed-in owner account. Ended grants return only status; unknown and link grants are refused.",
    inputSchema: ShareCopyInput.shape,
  }, async args => text(await getShareCopyDetails(ctx, args)));

  register("dohc_list_automations", {
    description: "Read automation definitions and on/off file state in a Collection, including shares. Shared run history and host runtime are unavailable.",
    inputSchema: { collectionPath: z.string().min(1).max(4096) },
  }, async args => text(await listAutomations(ctx, args)));
  register("dohc_switch_automation", {
    description: "Change only one automation's enabled value. Read definitions first and provide their contentHash. Reformat confirms losing comments and hand formatting. After an unknown desktop save, read definitions and sync state before retrying; a stale base remains a conflict. A pending save is waiting to sync; acceptance records history, not host execution.",
    inputSchema: { collectionPath: z.string().min(1).max(4096), automation: z.string().min(1).max(64), enabled: z.boolean(),
      expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/u), reformat: z.boolean().optional(), submitId: requestIdSchema },
  }, async args => text(await switchAutomation(ctx, args)));

  register("dohc_publish_app", {
    description: "Create a share link, prepare an immutable app revision, and approve publication as its owner on this computer. createLink requires a stable operationId; retries return the existing grant, never another link. Paths default to the app root at View access. A URL is a bearer credential at its stated access level, usable by anyone holding it. Keep its secret yourself. Append the returned appQuery before the fragment of any link URL, including one returned by createLink. Never send its secret to dohc. Rotation remains in the desktop. Agent labels are agent-declared provenance.",
    inputSchema: {request: OwnerAppPublicationRequest},
  }, async ({request}) => text(await publishApp(ctx,request)));

  register("dohc_dataset", {
    description: "Create, prepare, approve, inspect, and use transactional Collections in the owning workspace. Address a dataset with datasetPath, its dataset.json path relative to the MCP server folder. List and describe return this path; datasetId is internal identity. After a move, update path references. Apps bind to these same datasets; they have no separate private app store. Invoke approved operations with their described revision and a stable retry key. History shows record edits and schema/rule revisions. historyRevision reads immutable saved source. prepareHistoryRestore prepares a reviewed forward change against current records, preserving current access; approveMigration applies it. Source-file restoration alone never activates rules. Permissions manages explicit data grants. Export streams a private recovery archive to an explicit savePath ending in .dohc-recovery; it includes private records, files, history, and retry credentials. savePath must be absolute and outside the workspace. A relative sourcePath is read only and resolves from the MCP server folder; an absolute sourcePath is also supported. Recovery uses prepareRecovery with explicit sourcePath, then claimRecovery after stopping the old host, or discardRecovery to cancel. The same rules apply in dohc and apps.",
    inputSchema: {request: DatasetRequest},
  }, async ({request}) => text(await dataset(ctx, request)));

  register(
    "dohc_list_workspaces",
    { description: "List the local dohc workspaces in the desktop registry.", inputSchema: {} },
    async () => text(await listWorkspaces(ctx)),
  );

  register(
    "dohc_workspace_status",
    { description: "Report whether this workspace is local-only or cloud-synced. In the owning workspace, also list live documents whose edits the server refused, as keptEdits.", inputSchema: {} },
    async () => text(await workspaceStatus(ctx)),
  );

  register(
    "dohc_stop_workspace_sync",
    { description: "Stop this computer's sync for the owning workspace after saving live document edits. Keep local work, shares, history, and protected-file keys. Groups you joined and received-share mounts keep syncing. Record who paused and when. Resume in Settings.", inputSchema: {} },
    async () => text(await stopWorkspaceSync(ctx, agentName())),
  );

  register("dohc_chat_links",{description:"Read one bounded page of accessible files mentioned in a chat. Use channelWireId from dohc_list_groups, and continue nextCursor until null. Coverage can be partial.",inputSchema:ChatLinksInput.shape},async args=>text(await chatLinks(ctx,args)));
  register("dohc_chat_file_mentions", { description: "Read a bounded page of accessible chat mentions of files. Optional subject selects one file. Continue nextCursor until null; complete and sharedChannelRowsUncovered report coverage.", inputSchema: ChatFileMentionsInput.shape }, async args => text(await chatFileMentions(ctx, args)));
  register("dohc_links_edges", { description: "Read a bounded page of file links and isolated Markdown files. Continue nextCursor until null. indexBuilding reports active indexing; unchecked names uncertified sources; mountsCovered reports mount coverage.", inputSchema: LinksEdgesInput.shape }, async args => text(await linksEdges(ctx, args)));
  register("dohc_links_in", { description: "Read a bounded page of documents linking to a file. indexBuilding reports active indexing; unchecked names omitted sources. complete excludes mount coverage, reported by mountsCovered. Cursors carry index state across pages.", inputSchema: LinksInInput.shape }, async args => text(await linksIn(ctx, args)));
  register("dohc_links_resolve", { description: "Resolve wikilink or Markdown literals from one source document using the engine's link rules.", inputSchema: LinksResolveInput.shape }, async args => text(await linksResolve(ctx, args)));
  register("dohc_duplicate_file", {description: "Duplicate one regular file beside its source with a fresh identity. Owner workspace only. Undo removes the copy while it is unchanged.", inputSchema: {path: z.string()}}, async args => text(await duplicateWorkspaceFile(ctx, args, agentName())));
  register("dohc_read_operation", {
    description: "List the paths changed by one operation, up to 50 per page. Returns change references and paths without retained contents, and a file move's link update state. Owner workspace only.",
    inputSchema: { operationId: HistoryOperationId, cursor: z.string().optional() },
  }, async args => text(await readOperation(ctx, args)));
  register("dohc_undo_operation", {
    description: "Undo a delete, move, or rename by its operation id. Requires dohc open and the owning workspace. Returns History restoration state, restored paths, and remaining paths with reasons and retry flags. Undo again to retry each remaining path marked retry. Undo of a move also reverses its link updates.",
    inputSchema: { operationId: HistoryOperationId },
  }, async args => text(await undoOperation(ctx, args, agentName())));
  register("dohc_list_versions", {
    description: "List the workspace's versions and which one is active. canMergeIntoMain is true for a version that started from Main. Owner workspace only.",
    inputSchema: {},
  }, async () => text(await listVersions(ctx)));
  register("dohc_compare_version", {
    description: "Read one page of files that differ between a version and Main. Name the version by its name or id from dohc_list_versions. currentText is Main's text and incomingText the version's; binary files carry no text. Files History does not track and secret files are left out. Continue with afterPath set to nextAfterPath until it is null. Owner workspace only.",
    inputSchema: { version: z.string().min(1).max(200), afterPath: z.string().min(1).max(4096).optional() },
  }, async args => text(await compareVersion(ctx, args)));
  register("dohc_list_version_conflicts", {
    description: "Read one page of open conflicts from merges and from sync, with each side's text. origin sync means two computers changed the file. Files History does not track are left out. Continue with afterConflictId set to nextAfterConflictId until it is null. Owner workspace only.",
    inputSchema: { afterConflictId: z.string().min(1).max(200).optional() },
  }, async args => text(await listVersionConflicts(ctx, args)));
  register("dohc_create_version", {
    description: "Create a version from the active one and switch the workspace folder to it. The new version starts as a copy. Refuses a name another version has. First saves the edits open in dohc, and refuses when it can't. Owner workspace only.",
    inputSchema: { name: z.string().min(1).max(MAX_VERSION_NAME_LENGTH) },
  }, async args => text(await createVersion(ctx, args)));
  register("dohc_switch_version", {
    description: "Switch the workspace folder to a version, named by its name or id from dohc_list_versions. dohc first saves the active version's files and the edits open in dohc, and refuses when it can't. Owner workspace only.",
    inputSchema: { version: z.string().min(1).max(200) },
  }, async args => text(await switchVersion(ctx, args)));
  register("dohc_merge_version", {
    description: "Merge a version into Main, named by its name or id from dohc_list_versions. Only versions made from Main can merge into Main. Returns the merged and conflict counts and the first page of open conflicts, as dohc_list_version_conflicts does. First saves the edits open in dohc, and refuses when it can't. Owner workspace only.",
    inputSchema: { version: z.string().min(1).max(200) },
  }, async args => text(await mergeVersion(ctx, args)));
  register("dohc_resolve_version_conflict", {
    description: "Resolve an open conflict from dohc_list_version_conflicts. keep current or incoming keeps that side; keep combined with text replaces both. In a merge, current is Main and incoming is the version; in sync, current is this computer. A binary conflict takes no combined text. Returns the open conflicts that remain. Owner workspace only.",
    inputSchema: { conflictId: z.string().min(1).max(200), resolution: versionResolutionSchema },
  }, async args => text(await resolveVersionConflict(ctx, args)));

  // Legacy cloud sync (dohc_sync_now / dohc_sync_cloud) was removed with the
  // retired workspace-api file/sync routes. Cloud sync is now automatic per
  // workspace via the sync relay; use dohc_list_changes for workspace history
  // and dohc_workspace_status to see whether a workspace is cloud-synced.
  register(
    "dohc_list_changes",
    {
      description:
        "List workspace history, newest first: workspace-engine moments (the recorder for this workspace). Each entry carries path/operation/versionId. Pass path, relative to the MCP server folder, to list only that file's changes across its renames.",
      inputSchema: {
        sinceMs: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(500).optional(),
        includeFiles: z.boolean().optional(),
        path: z.string().min(1).max(4096).optional(),
      },
    },
    async (args) => text(await listChanges(ctx, args)),
  );

  register(
    "dohc_list_kept_copies",
    {
      description:
        "List retained copies with a known workspace path, including copies adopted from staging during startup. Each entry names the file (`path`) that has a second copy, hidden until dohc_save_kept_copy moves it beside the file. `more` is true when the workspace kept more than this list holds.\n\nKnown copies deleted during replacement do not appear. Adopted staging files without an original path remain in `.dohc/engine/displaced`. Notices offers a recovery-folder action for these files; `watcher.status.keptFiles` also lists them. Copies kept from outside writes are ordinary workspace files listed separately in `outsideWriteCopies` in this tool's response as [original path, copy path, copy id] entries. Open the copy by its workspace path.",
      inputSchema: {},
    },
    async () => text(await listKeptCopies(ctx)),
  );

  register(
    "dohc_save_kept_copy",
    {
      description:
        "Move one kept copy from dohc_list_kept_copies to a visible file beside its file, such as `notes (kept copy).md`. The original file does not change. `status` is `saved` with the copy's `path`: read both, keep what you need, and delete the copy when you are done. `gone` means nothing is kept under that id any more. `no-valid-name` means no name beside the file fits dohc's path limits, so the copy stays kept: rename the file or its folder to something shorter and try again.",
      inputSchema: { id: z.number().int() },
    },
    async (args) => text(await saveKeptCopy(ctx, args)),
  );

  register(
    "dohc_save_recovery_copy",
    {
      description:
        "Save a live document's kept edits next to the document. Kept edits are edits the server refused, which dohc keeps on this computer, or on the server for a document it hosts (`storedOn`); dohc_workspace_status lists them as `keptEdits`. dohc writes a recovery package with every kept edit, and a readable Markdown copy when it can read the edits as a document. `copyPath` is null when it cannot. dohc writes these files itself, not as the agent that asked. For edits the server keeps, dohc then tells the server the copy is saved, and the `recovery` becomes `copied`. `keptEdits` is `kept` when the edits stay where `storedOn` says, `copied` when the server may now release them, and `ended` for edits a Stop could not write: dohc no longer keeps those, and the copy holds them. Accepts every `recovery`. Pass the `incident` from `keptEdits` to save exactly those kept edits; without it, dohc saves edits a Stop could not write first. Owner workspace only.",
      inputSchema: { path: z.string().min(1).max(4096), incident: z.string().min(1).max(1024).optional() },
    },
    async (args) => text(await saveRecoveryCopy(ctx, args)),
  );

  register(
    "dohc_retry_kept_edits",
    {
      description:
        "Send a live document's kept edits to the server once more, as Try again does in dohc. Take `path` and `incident` from `keptEdits` in dohc_workspace_status. Accepts a `recovery` of `paused`, or `copied` for edits the server keeps. When saveOnly is true, save a recovery copy instead. If recovery is unreadable, retry reads the edits again. Then read dohc_workspace_status: `retrying` until the server answers, `paused` with a new `incident` if it refuses again. A `not-written` or `stopping` document needs dohc_stop_again instead. Owner workspace only.",
      inputSchema: { path: z.string().min(1).max(4096), incident: z.string().min(1).max(1024) },
    },
    async (args) => text(await retryKeptEdits(ctx, args)),
  );

  register(
    "dohc_stop_again",
    {
      description:
        "Stop live editing again for a document whose Stop kept its edits, as Try again does on its row in dohc. Take `path` and `incident` from `keptEdits` in dohc_workspace_status. Accepts a `recovery` of `not-written`, where dohc writes the kept edits into the file, or `stopping`, where it asks the server again to stop live editing. `keptEdits` is `recovered` once the file holds the edits, `kept` while dohc still keeps them, and `none` when it kept none. dohc refuses while the document is open in an editor. Owner workspace only.",
      inputSchema: { path: z.string().min(1).max(4096), incident: z.string().min(1).max(1024) },
    },
    async (args) => text(await stopAgain(ctx, args)),
  );

  register(
    "dohc_list_retained_copies",
    {
      description:
        "List old file copies dohc keeps on a drive that cannot tell it whether another program still has one open, such as a macFUSE volume. dohc never deletes these itself. `total` counts them all, with their logical size in `bytes`; deleting them may free less disk space. `copies` lists those dohc_delete_retained_copies can delete now, oldest first, with the `revision` each delete must match. Copies changed in the last 30 seconds, copies whose file waits for review, and copies an unfinished save still needs are not listed. `more` is true when more copies remain past this list.",
      inputSchema: {},
    },
    async () => text(await listRetainedCopies(ctx)),
  );

  register(
    "dohc_delete_retained_copies",
    {
      description:
        "Permanently delete up to 100 copies listed by dohc_list_retained_copies. They do not go to the trash. dohc cannot check whether another program still has one open: such a program may lose what it writes next. Ask the person to close other programs that use this workspace first, and set acceptLateWriteRisk to true. A copy that changed since it was listed, or whose file waits for review, is skipped and stays. Returns how many copies were `deleted`, `skipped` and `failed`, and the `remaining` count and bytes. List again to delete more.",
      inputSchema: {
        copies: z
          .array(z.object({ id: z.number().int(), revision: z.number().int() }))
          .max(100),
        acceptLateWriteRisk: z.literal(true),
      },
    },
    async (args) => text(await deleteRetainedCopies(ctx, args)),
  );

  register(
    "dohc_read_change",
    {
      description:
        "Read one history entry by id: a workspace-engine moment with its full before/after payload.",
      inputSchema: {
        id: z.string().min(1).max(500),
      },
    },
    async (args) => text(await readChange(ctx, args)),
  );

  register(
    "dohc_list_files",
    {
      description: "List visible files and folders in the workspace. Hidden dohc internals are omitted.",
      inputSchema: {
        path: z.string().max(4096).optional(),
        recursive: z.boolean().optional(),
      },
    },
    async (args) => text(await listWorkspaceFiles(ctx, args)),
  );

  register(
    "dohc_read_file",
    {
      description: "Read any visible workspace file as UTF-8 text or base64, returning size and sha256 for safe follow-up writes.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        encoding: z.enum(["utf8", "base64"]).optional(),
        maxBytes: z.number().int().positive().max(10 * 1024 * 1024).optional(),
        offsetBytes: z.number().int().nonnegative().optional(),
      },
    },
    async (args) => text(await readWorkspaceFile(ctx, args)),
  );

  register(
    "dohc_search_files",
    {
      description:
        "Search visible workspace file paths and text contents. Hidden dohc internals, .git, node_modules, symlinks, oversized files, and binary files are skipped.",
      inputSchema: {
        query: z.string().min(1).max(4096),
        path: z.string().max(4096).optional(),
        mode: z.enum(["content", "path", "both"]).optional(),
        caseSensitive: z.boolean().optional(),
        regex: z.boolean().optional(),
        maxResults: z.number().int().positive().max(1000).optional(),
        maxFileBytes: z.number().int().positive().max(10 * 1024 * 1024).optional(),
      },
    },
    async (args) => text(await searchWorkspaceFiles(ctx, args)),
  );

  register(
    "dohc_read_document",
    {
      description:
        "Read a Markdown document as it is now, including edits an open editor has not saved to the file yet. Read it before dohc_edit_document: edits match this text.",
      inputSchema: {
        path: z.string().min(1).max(4096),
      },
    },
    async (args) => text(await readDocument(ctx, args)),
  );

  // The client names itself in the MCP handshake. A name the document door
  // accepts becomes the author of this agent's edits. The desktop labels unnamed agents "Agent".
  const agentName = (): string | undefined => {
    const named = documentAgentNameSchema.safeParse(server.server.getClientVersion()?.name);
    return named.success ? named.data : undefined;
  };

  register(
    "dohc_edit_document",
    {
      description:
        "Edit a Markdown document through dohc. A person editing it at the same time keeps their text and sees yours arrive. While someone may be typing in it, in an open editor or on a device it syncs to, an edit may change text inside blocks and add blocks, but not remove a block or change its kind. `find` is Markdown that occurs exactly once in the text dohc_read_document returns; it becomes `replacement`. Omit `find` to add `replacement` at the end. The edit changes the body, not the frontmatter. It returns when the edit is saved. A pending `warning` means the edit is saved locally and the shared file update is pending; do not repeat the edit. Other warnings mean someone may be changing the same blocks; read the document to check. `requestId` is a random key you choose, such as a UUID. Sent again with the same key, after a timeout for example, the edit returns its first result instead of applying twice, while it runs and until 1,024 later keyed requests to this workspace have finished. dohc then refuses the key until 16,384 more have finished; after that, or after dohc restarts, the key can apply the edit again. Use a new key for each new edit, including one that redoes text a failed edit reported missing. If the call fails without a reason, read the document before you retry.",
      inputSchema: {
        allowLossySourceSha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
        path: z.string().min(1).max(4096),
        find: documentEditTextSchema.min(1).optional(),
        replacement: documentEditTextSchema,
        requestId: requestIdSchema.optional(),
      },
    },
    async (args) => text(await editDocument(ctx, args, agentName())),
  );

  register(
    "dohc_create_document",
    {
      description:
        "Create a Markdown document at a path that does not exist yet. `markdown` is its body text, without frontmatter. dohc writes it the way a person types into a new file, so later changes go through dohc_edit_document.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        markdown: documentEditTextSchema.optional(),
      },
    },
    async (args) => text(await createDocument(ctx, args, agentName())),
  );

  register(
    "dohc_write_file",
    {
      description:
        "Write an ordinary workspace file. Markdown documents are created with dohc_create_document and changed with dohc_edit_document, and Excalidraw scenes change in dohc; this tool refuses both. Requires dohc open. History records the write under your agent name. Refuses secret or excluded paths and content over 10 MiB.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).optional(),
        expectedSha256: z.string().length(64).optional(),
        summary: z.string().max(500).optional(),
      },
    },
    async (args) => text(await writeWorkspaceFile(ctx, args, agentName())),
  );

  register(
    "dohc_create_directory",
    {
      description:
        "Create a visible workspace directory. Files later written inside it are captured as engine moments by the desktop watcher.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        summary: z.string().max(500).optional(),
      },
    },
    async (args) => text(await createWorkspaceDirectory(ctx, args)),
  );

  register(
    "dohc_move_path",
    {
      description:
        "Move or rename a visible workspace file or folder. Returns operationId and undo availability. Use dohc_undo_operation when available. Overwrites, moves that change only letter case, and files without History rows update no links. A folder move updates no links. Other file moves update [[links]] after the result returns. dohc_read_operation lists the documents it could not update. Requires dohc open. History records the move under your agent name. Refuses links, and secret, excluded, or reserved paths, including any inside a folder. Files over 5 MiB binary or 10 MiB text move without a History row. Text with invalid UTF-8 also moves without a row when History cannot keep it as binary. `withoutHistory` lists their destination paths. With overwrite, `replaced` separately reports the old destination's trash location and files without History copies. A failed move puts everything back it can. `deleted` lists files History records as deleted after rollback. They stay in the workspace's .dohc/local/trash, and Restore in History brings them back.",
      inputSchema: {
        fromPath: z.string().min(1).max(4096),
        toPath: z.string().min(1).max(4096),
        overwrite: z.boolean().optional(),
        summary: z.string().max(500).optional(),
      },
    },
    async (args) => text(await moveWorkspacePath(ctx, args, agentName())),
  );

  register(
    "dohc_delete_path",
    {
      description:
        "Delete a visible workspace file or folder. Returns operationId and undo availability. Use dohc_undo_operation when available. Requires dohc open. History records the delete under your agent name, and Restore there brings the file back. Files over 5 MiB binary or 10 MiB text delete without a History row. Text with invalid UTF-8 also deletes without a row when History cannot keep it as binary. `withoutHistory` lists their paths. Restore these files from the trash. The file or folder goes through the workspace's .dohc/local/trash to the system trash, or stays in .dohc/local/trash when the system refuses; `trashed` says which. Refuses links, and secret, excluded, or reserved paths, including any inside a folder. If History refuses a file in a folder, `deleted` lists the files already deleted, and the rest go back to their place.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        summary: z.string().max(500).optional(),
      },
    },
    async (args) => text(await deleteWorkspacePath(ctx, args, agentName())),
  );

  register(
    "dohc_detect_apps",
    {
      description:
        "Detect app folders in the workspace: web content a browser can open, found from index.html, package.json, dohc.json, and common web configs.",
      inputSchema: {
        path: z.string().max(4096).optional(),
        maxDepth: z.number().int().nonnegative().max(12).optional(),
      },
    },
    async (args) => text(await detectApps(ctx, args)),
  );

  register(
    "dohc_create_app",
    {
      description:
        "Scaffold an app folder with index.html, package.json, a pinned serve devDependency, and an optional dohc.json. Requires dohc open. History records each file under your agent name. A partial failure lists the files already written.",
      inputSchema: {
        appRoot: z.string().min(1).max(4096),
        title: z.string().max(200).optional(),
        withDohcJson: z.boolean().optional(),
      },
    },
    async (args) => text(await createApp(ctx, args, agentName())),
  );

  register(
    "dohc_test_app",
    {
      description:
        "Run bounded static validation for an app folder: detector diagnostics and entry presence.",
      inputSchema: {
        appRoot: z.string().min(1).max(4096),
      },
    },
    async (args) => text(await testApp(ctx, args)),
  );

  register(
    "dohc_import_data",
    {
      description: "Import a CSV/JSON/JSONL/Markdown source into a new visible .sqlite database. Requires dohc open and records the write under your agent name.",
      inputSchema: {
        sourcePath: z.string().min(1).max(4096),
        databasePath: z.string().min(1).max(4096),
        tableName: z.string().min(1).max(256),
      },
    },
    async (args) => text(await importData(ctx, args, agentName())),
  );

  register(
    "dohc_query_database",
    {
      description: "Run a single read-only SELECT against a visible workspace database (bounded rows).",
      inputSchema: {
        databasePath: z.string().min(1).max(4096),
        sql: z.string().min(1).max(64 * 1024),
      },
    },
    async (args) => text(await queryDatabase(ctx, args)),
  );

  register(
    "dohc_list_file_chats",
    {
      description:
        "List the dohc Chats linked to a workspace file. Chats follow the file's stable dohc identity across renames. Requires the workspace engine.",
      inputSchema: {
        path: z.string().min(1).max(4096),
      },
    },
    async (args) => text(await listFileChats(ctx, args)),
  );

  register(
    "dohc_read_chat",
    {
      description:
        "Read one dohc Chat thread, or one group's stream. With `threadId`: its messages (with author kind and display name), dispatch pause state and latest run outcome, and a read-only text projection. With `group` (a name, #slug, or id): its posts and conversation messages in one order, oldest first, a page at a time from the newest end. Each post says how many replies it has, who replied, and the latest agent reply. Pass `nextBefore` back as `before` for the older page; `limit` is 50 by default, at most 100. Messages name the agents still asked to answer them in `agentRequests`.",
      inputSchema: {
        threadId: z.string().min(1).max(200).optional(),
        group: z.string().min(1).max(500).optional(),
        before: z.object({
          createdAtMs: z.number().int().nonnegative(),
          lane: z.enum(["posts", "chat"]),
          id: z.string().min(1).max(200),
        }).strict().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => text(await readChat(ctx, args)),
  );

  register(
    "dohc_list_groups",
    {
      description:
        "List the workspace's Chats groups (including the default #general) with each group's chats and their ids. It also returns direct messages and the agent lane, told apart by `kind`. Requires the workspace engine.",
      inputSchema: {},
    },
    async () => text(await listGroups(ctx)),
  );

  const chatWriteInput = {
    // The desktop validates normalized UTF-8 bytes before any chat write.
    body: z.string().min(1),
    attachments: z.array(z.string().min(1).max(4096)).max(32).optional(),
    needsDecision: z.boolean().optional(),
    options: z.array(z.string().min(1).max(200)).max(12).optional(),
    runId: z.string().min(1).max(200).optional(),
  };

  register(
    "dohc_start_group_chat",
    {
      description:
        "Start a new chat in a group as the agent. `group` accepts a group name, #slug, or id. No title needed; the chat displays its first message. `attachments` name tracked files relative to the MCP server folder; `needsDecision` asks for a decision and `options` turns it into a poll; `runId` links the message to a local agent run. Returns engine ids usable with dohc_read_chat.",
      inputSchema: {
        group: z.string().min(1).max(200),
        title: z.string().min(1).max(200).optional(),
        ...chatWriteInput,
      },
    },
    async (args) => text(await startGroupChat(ctx, args)),
  );

  register(
    "dohc_start_file_chat",
    {
      description:
        "Comment on a workspace file as the agent. This starts a chat linked to the file, as a person does from the file's Chats panel: `title` names the chat there and `body` is its first message. dohc_list_file_chats returns it, and dohc_reply_to_chat continues it. `requestId` is a random key you choose, such as a UUID. Sent again with the same key, after a timeout for example, the comment returns its first result instead of starting a second chat, while it runs and until 1,024 later keyed requests to this workspace have finished. dohc then refuses the key until 16,384 more have finished; after that, or after dohc restarts, the key can start another chat. `runId` behaves as in dohc_start_group_chat.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        title: z.string().min(1).max(200),
        body: chatWriteInput.body,
        requestId: requestIdSchema.optional(),
        runId: chatWriteInput.runId,
      },
    },
    async (args) => text(await startFileChat(ctx, args, agentName())),
  );

  register(
    "dohc_reply_to_chat",
    {
      description:
        "Reply in a dohc Chat thread as the agent. `to` replies under one message; `resolve` closes that open decision with this reply and `choose` names the option picked. Message ids come from dohc_read_chat. `attachments`, `needsDecision`, `options`, and `runId` behave as in dohc_start_group_chat.",
      inputSchema: {
        threadId: z.string().min(1).max(200),
        to: z.string().min(1).max(200).optional(),
        resolve: z.string().min(1).max(200).optional(),
        choose: z.string().min(1).max(200).optional(),
        ...chatWriteInput,
      },
    },
    async (args) => text(await replyToChat(ctx, args)),
  );

  register(
    "dohc_query_collection",
    {
      description:
        "Query a collection folder's indexed records: filter, sort, group, and page. Requires the workspace engine and the dohc app.",
      inputSchema: {
        collectionPath: z.string().min(1).max(4096),
        filter: z
          .object({
            field: z.string().min(1).max(200),
            operator: z.enum(["equals", "contains"]),
            value: z.unknown(),
          })
          .optional(),
        sort: z
          .array(
            z.object({
              field: z.string().min(1).max(200),
              direction: z.enum(["asc", "desc"]),
            }),
          )
          .max(8)
          .optional(),
        groupBy: z.string().min(1).max(200).optional(),
        resolveRelations: z.boolean().optional(),
        limit: z.number().int().positive().max(500).optional(),
        cursor: z.unknown().optional(),
      },
    },
    async (args) => text(await queryCollection(ctx, args)),
  );

  register(
    "dohc_read_record",
    {
      description:
        "Read one collection record by id: current field values plus per-field history with author attribution. Requires the workspace engine and the dohc app.",
      inputSchema: {
        collectionPath: z.string().min(1).max(4096),
        recordId: z.string().min(1).max(200),
        historyLimit: z.number().int().positive().max(500).optional(),
        beforeHistoryId: z.number().int().nonnegative().optional(),
      },
    },
    async (args) => text(await readRecord(ctx, args)),
  );

  register(
    "dohc_set_record_fields",
    {
      description:
        "Set fields on a collection record as the agent, e.g. fields: {\"status\": \"done\"}. The change lands in the record's live frontmatter, open desktop views update, and record history attributes it to the agent.",
      inputSchema: {
        recordPath: z.string().min(1).max(4096),
        fields: z.record(z.string().min(1).max(200), z.unknown()),
      },
    },
    async (args) => text(await setRecordFields(ctx, args, agentName())),
  );

  register(
    "dohc_create_record",
    {
      description:
        "Create a Markdown record in a collection folder as the agent, optionally seeding fields, and return its record id. The kept map reports current values of seed fields preserved after someone edited them. On partial creation, retry with partial.retry.recordId and the same inputs to finish the existing record. Other taken names are refused.",
      inputSchema: {
        collectionPath: z.string().min(1).max(4096),
        name: z.string().min(1).max(200),
        recordId: z.string().regex(/^rec_[a-z2-7]{26}$/).optional(),
        fields: z.record(z.string().min(1).max(200), z.unknown()).optional(),
      },
    },
    async (args) => text(await createRecord(ctx, args, agentName())),
  );

  const automationInput = {
    collectionPath: z.string().min(1).max(4096),
    automation: z.string().min(1).max(200),
  };

  register(
    "dohc_list_automation_runs",
    {
      description:
        "List an automation's runs on this computer, 20 at a time, newest first: each run's id, state, what started it, how many changes it made, and why it failed. Name the automation by its Collection's folder and its id in automations.yaml. When older runs remain, `next` is not null; pass it as `page` to list them. Each computer keeps the runs of the automations it ran for 30 days after they end. With server true, list the runs of the workspace's self-hosted server instead. A run marked unsentChangesLost ran in a copy the server lost, and its latest changes may not have been sent.",
      inputSchema: { ...automationInput, page: z.string().min(1).max(512).optional(), server: z.boolean().optional() },
    },
    async (args) => text(await listAutomationRuns(ctx, args)),
  );

  register(
    "dohc_read_automation_run",
    {
      description:
        "Read one automation run: what started it, what each step changed, why it failed, which step failed, and whether Try again resumes there or starts over. Steps count from 1 in the order automations.yaml lists them, including the steps inside if and otherwise. A step that changed nothing is not listed. With server true, read a run of the workspace's self-hosted server: it lists what the run changed, oldest first, as `changes` instead of steps.",
      inputSchema: { ...automationInput, run: z.string().min(1).max(256), server: z.boolean().optional() },
    },
    async (args) => text(await readAutomationRun(ctx, args)),
  );

  register(
    "dohc_retry_automation_run",
    {
      description:
        "Try a failed automation run again, as Try again does in dohc. It resumes after the last step that finished. If the automation changed since the run failed, it refuses unless startOver is true, which runs it from the first step and can repeat changes the run already made. Only the computer that ran it can try a run again; anywhere else the refusal names that computer.",
      inputSchema: { ...automationInput, run: z.string().min(1).max(256), startOver: z.boolean().optional() },
    },
    async (args) => text(await retryAutomationRun(ctx, args)),
  );

  register(
    "dohc_press_button",
    {
      description:
        "Press a Button field on one record, as a person clicks it in dohc, and get the id of the run it started; follow it with dohc_read_automation_run. Name the record by its id, or a dataset record by its primary key as JSON. A press that would run actions dohc cannot undo is refused with each action's name; press again with those names in confirm to run them. Send the same requestId again, after a timeout for example, to get the same press instead of a second one. The press is recorded as the agent's, for the person; from an agent run that an automation started, it counts in that chain of automations, which stops after 4 steps.",
      inputSchema: {
        collectionPath: z.string().min(1).max(4096),
        button: z.string().min(1).max(256),
        recordId: z.string().min(1).max(1024),
        table: z.string().min(1).max(256).optional(),
        confirm: z.array(z.string().min(1).max(256)).max(64).optional(),
        requestId: requestIdSchema.optional(),
      },
    },
    async (args) => text(await pressButton(ctx, args)),
  );

  register("dohc_inspect_buttons", {
    description: "Inspect a Collection's Button fields, their current access, and any actions that need confirmation. Shared Collection buttons are checked on the owner's host.",
    inputSchema: { collectionPath: z.string().min(1).max(4096), table: z.string().min(1).max(256).optional() },
  }, async args => text(await inspectButtons(ctx, args)));

  return server;
}

async function main() {
  const ctx = parseArgs(process.argv.slice(2));
  const server = createDohcMcpServer(ctx);
  await server.connect(new StdioServerTransport());
}

// Run only when invoked as the entry binary, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
