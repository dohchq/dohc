// The dohc MCP server. The DESKTOP runs this; the user's AI tool (Claude Code,
// Codex) is the client, launching it as a stdio child via its own config:
//   { mcpServers: { dohc: { command, args: ["--workspace", root, "--home", home] } } }
// Stdio is scoped by construction — only the configured tool talks to it — so
// there is no shared-secret auth to manage (a persistent HTTP server would
// need one). Every tool routes through src/tools.ts, which contains all path
// validation; this file is only registration + transport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { DatasetRequest } from "@dohc/cli/dataset";
import { documentAgentNameSchema, documentEditTextSchema, requestIdSchema } from "@dohc/cli/protocol";
import {
  isShareAccessValue,
  SHARE_ACCESS_VALUES,
  type ShareAccess,
} from "@dohc/security-contract/share-selector";
import {
  createDocument,
  createRecord,
  dataset,
  createWorkspaceDirectory,
  listGroups,
  queryCollection,
  readRecord,
  setRecordFields,
  listFileChats,
  readChat,
  replyToChat,
  startGroupChat,
  startFileChat,
  createApp,
  deleteWorkspacePath,
  detectApps,
  editDocument,
  importData,
  listWorkspaceFiles,
  listChanges,
  listWorkspaces,
  moveWorkspacePath,
  queryDatabase,
  readChange,
  readDocument,
  readWorkspaceFile,
  searchWorkspaceFiles,
  testApp,
  writeWorkspaceFile,
  workspaceStatus,
  type ToolContext,
} from "./tools";

export function parseArgs(argv: string[]): ToolContext {
  let root = nonEmptyArg(process.cwd(), "workspace root");
  let home = nonEmptyArg(process.env.HOME ?? process.cwd(), "home path");
  let shareAccess: ShareAccess | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workspace" && argv[i + 1]) root = nonEmptyArg(argv[++i], "--workspace");
    else if (argv[i] === "--home" && argv[i + 1]) home = nonEmptyArg(argv[++i], "--home");
    else if (argv[i] === "--share-access") shareAccess = shareAccessArg(argv[++i]);
  }
  return {
    root,
    home,
    ...(shareAccess ? { shareAccess } : {}),
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

function text(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    ...(structuredContent.ok === false ? { isError: true } : {}),
  };
}

export function createDohcMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "dohc", version: "0.3.0" });

  // A share view's write surface is its access level. The write tools
  // come in two tiers, and a tier the level does not grant is never registered
  // — an agent pointed at a share view is offered only what it may use. Read
  // tools always register below.
  //
  //   no level  a workspace this machine owns: every write tool
  //   any level a shared view: NO write tool of any kind
  //
  // #646 PR2 deliberately registers no chat write tool at any level. The two
  // that exist — `dohc_start_group_chat` and `dohc_reply_to_chat` — are
  // GROUP tools, and a shared view refuses every group write before the
  // level is consulted (`apps/desktop/src/cli/cliServer.ts`). `comment`
  // grants per-FILE chat, and `dohc_start_file_chat` writes it, but a shared
  // view refuses every chat write in the desktop's chat write module. Offering
  // an agent a tool its own workspace always refuses is a promise the surface
  // cannot keep, so the level is carried here for the tiers PR3 adds and
  // grants nothing today.
  const register = server.registerTool.bind(server);
  const skip = (() => undefined) as unknown as McpServer["registerTool"];
  // Every write tool, document and chat alike.
  const registerWrite: McpServer["registerTool"] =
    ctx.shareAccess === undefined ? register : skip;

  registerWrite("dohc_dataset", {
    description: "Create, prepare, approve, inspect, and use transactional Collections in the owning workspace. Apps bind to these same datasets; they have no separate private app store. Invoke approved operations with their described revision and a stable retry key. History shows record edits and schema/rule revisions. historyRevision reads immutable saved source. prepareHistoryRestore prepares a reviewed forward change against current records, preserving current access; approveMigration applies it. Source-file restoration alone never activates rules. Permissions manages explicit data grants. Export streams a private recovery archive to an explicit absolute savePath ending in .dohc-recovery; it includes private records, files, history, and retry credentials. Recovery uses prepareRecovery with explicit sourcePath, then claimRecovery after stopping the old host, or discardRecovery to cancel. The same rules apply in dohc and apps.",
    inputSchema: {request: DatasetRequest},
  }, async ({request}) => text(await dataset(ctx, request)));

  server.registerTool(
    "dohc_list_workspaces",
    { description: "List the local dohc workspaces in the desktop registry.", inputSchema: {} },
    async () => text(await listWorkspaces(ctx)),
  );

  server.registerTool(
    "dohc_workspace_status",
    { description: "Report whether this workspace is local-only or cloud-synced.", inputSchema: {} },
    async () => text(await workspaceStatus(ctx)),
  );

  // Legacy cloud sync (dohc_sync_now / dohc_sync_cloud) was removed with the
  // retired workspace-api file/sync routes. Cloud sync is now automatic per
  // workspace via the sync relay; use dohc_list_changes for workspace history
  // and dohc_workspace_status to see whether a workspace is cloud-synced.
  server.registerTool(
    "dohc_list_changes",
    {
      description:
        "List workspace history: workspace-engine moments (the recorder for this workspace). Each entry carries path/operation/versionId.",
      inputSchema: {
        sinceMs: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(500).optional(),
        includeFiles: z.boolean().optional(),
      },
    },
    async (args) => text(await listChanges(ctx, args)),
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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
  // accepts becomes the author of this agent's edits; no name is invented.
  const agentName = (): string | undefined => {
    const named = documentAgentNameSchema.safeParse(server.server.getClientVersion()?.name);
    return named.success ? named.data : undefined;
  };

  registerWrite(
    "dohc_edit_document",
    {
      description:
        "Edit a Markdown document through dohc. A person editing it at the same time keeps their text and sees yours arrive. While someone may be typing in it, in an open editor or on a device it syncs to, an edit may change text inside blocks and add blocks, but not remove a block or change its kind. `find` is Markdown that occurs exactly once in the text dohc_read_document returns; it becomes `replacement`. Omit `find` to add `replacement` at the end. The edit changes the body, not the frontmatter. It returns when the edit is saved. A `warning` means someone may be changing the document at the same moment, and their change to the same blocks can still remove your text; read the document to check. `requestId` is a random key you choose, such as a UUID. Sent again with the same key, after a timeout for example, the edit returns its first result instead of applying twice, while it runs and until 1,024 later keyed requests to this workspace have finished. dohc then refuses the key until 16,384 more have finished; after that, or after dohc restarts, the key can apply the edit again. Use a new key for each new edit, including one that redoes text a failed edit reported missing. If the call fails without a reason, read the document before you retry.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        find: documentEditTextSchema.min(1).optional(),
        replacement: documentEditTextSchema,
        requestId: requestIdSchema.optional(),
      },
    },
    async (args) => text(await editDocument(ctx, args, agentName())),
  );

  registerWrite(
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

  registerWrite(
    "dohc_write_file",
    {
      description:
        "Write an ordinary workspace file. Markdown documents are created with dohc_create_document and changed with dohc_edit_document, and Excalidraw scenes change in dohc; this tool refuses both. The desktop watcher captures file history while open, or on the next open.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).optional(),
        expectedSha256: z.string().length(64).optional(),
        summary: z.string().max(500).optional(),
      },
    },
    async (args) => text(await writeWorkspaceFile(ctx, args)),
  );

  registerWrite(
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

  registerWrite(
    "dohc_move_path",
    {
      description:
        "Move or rename a visible workspace file/folder. The desktop watcher captures the change as engine moments while the app is open.",
      inputSchema: {
        fromPath: z.string().min(1).max(4096),
        toPath: z.string().min(1).max(4096),
        overwrite: z.boolean().optional(),
        summary: z.string().max(500).optional(),
      },
    },
    async (args) => text(await moveWorkspacePath(ctx, args)),
  );

  registerWrite(
    "dohc_delete_path",
    {
      description:
        "Delete a visible workspace file/folder by moving it to dohc's recoverable trash. The desktop watcher captures the delete as an engine moment while the app is open.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        summary: z.string().max(500).optional(),
      },
    },
    async (args) => text(await deleteWorkspacePath(ctx, args)),
  );

  server.registerTool(
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

  registerWrite(
    "dohc_create_app",
    {
      description:
        "Scaffold an app folder with index.html, package.json, a pinned serve devDependency, and an optional dohc.json. Records history; does not create hidden app folders.",
      inputSchema: {
        appRoot: z.string().min(1).max(4096),
        title: z.string().max(200).optional(),
        withDohcJson: z.boolean().optional(),
      },
    },
    async (args) => text(await createApp(ctx, args)),
  );

  server.registerTool(
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

  registerWrite(
    "dohc_import_data",
    {
      description: "Import a CSV/JSON/JSONL/Markdown source into a new visible .sqlite database.",
      inputSchema: {
        sourcePath: z.string().min(1).max(4096),
        databasePath: z.string().min(1).max(4096),
        tableName: z.string().min(1).max(256),
      },
    },
    async (args) => text(await importData(ctx, args)),
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    "dohc_read_chat",
    {
      description:
        "Read one dohc Chat thread: its messages (with author kind and display name) and a read-only text projection.",
      inputSchema: {
        threadId: z.string().min(1).max(200),
      },
    },
    async (args) => text(await readChat(ctx, args)),
  );

  server.registerTool(
    "dohc_list_groups",
    {
      description:
        "List the workspace's Chats groups (including the default #general) with each group's chats and their ids. It also returns direct messages and the agent lane, told apart by `kind`. Requires the workspace engine.",
      inputSchema: {},
    },
    async () => text(await listGroups(ctx)),
  );

  const chatWriteInput = {
    body: z.string().min(1).max(65536),
    attachments: z.array(z.string().min(1).max(4096)).max(32).optional(),
    needsDecision: z.boolean().optional(),
    options: z.array(z.string().min(1).max(200)).max(12).optional(),
    runId: z.string().min(1).max(200).optional(),
  };

  registerWrite(
    "dohc_start_group_chat",
    {
      description:
        "Start a new chat in a group as the agent. `group` accepts a group name, #slug, or id. No title needed; the chat displays its first message. `attachments` are workspace-relative paths of tracked files; `needsDecision` asks for a decision and `options` turns it into a poll; `runId` links the message to a local agent run. Returns engine ids usable with dohc_read_chat.",
      inputSchema: {
        group: z.string().min(1).max(200),
        title: z.string().min(1).max(200).optional(),
        ...chatWriteInput,
      },
    },
    async (args) => text(await startGroupChat(ctx, args)),
  );

  registerWrite(
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

  registerWrite(
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

  server.registerTool(
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

  server.registerTool(
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

  registerWrite(
    "dohc_set_record_fields",
    {
      description:
        "Set fields on a collection record as the agent, e.g. fields: {\"status\": \"done\"}. The change lands in the record's live frontmatter, open desktop views update, and record history attributes it to the agent.",
      inputSchema: {
        recordPath: z.string().min(1).max(4096),
        fields: z.record(z.string().min(1).max(200), z.unknown()),
      },
    },
    async (args) => text(await setRecordFields(ctx, args)),
  );

  registerWrite(
    "dohc_create_record",
    {
      description:
        "Create a Markdown record in a collection folder as the agent, optionally seeding fields, and return its record id. A name already taken in the folder is refused.",
      inputSchema: {
        collectionPath: z.string().min(1).max(4096),
        name: z.string().min(1).max(200),
        fields: z.record(z.string().min(1).max(200), z.unknown()).optional(),
      },
    },
    async (args) => text(await createRecord(ctx, args)),
  );

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
