#!/usr/bin/env node
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
import {
  createWorkspaceDirectory,
  addSiteSdk,
  listChannels,
  listFileChats,
  readChat,
  replyToChat,
  startChannelChat,
  buildSite,
  createSite,
  deleteWorkspacePath,
  detectSites,
  importData,
  listWorkspaceFiles,
  listChanges,
  listWorkspaces,
  moveWorkspacePath,
  openInDohc,
  previewSite,
  publishSite,
  queryDatabase,
  readChange,
  readWorkspaceFile,
  resolveConflict,
  searchWorkspaceFiles,
  share,
  syncCloud,
  syncNow,
  testSite,
  writeWorkspaceFile,
  workspaceStatus,
  type ToolContext,
} from "./tools";

export function parseArgs(argv: string[]): ToolContext {
  let root = nonEmptyArg(process.cwd(), "workspace root");
  let home = nonEmptyArg(process.env.HOME ?? process.cwd(), "home path");
  let sdkPackageJsonPath = optionalNonEmptyArg(
    process.env.DOHC_SDK_PACKAGE_JSON,
    "DOHC_SDK_PACKAGE_JSON",
  );
  let sdkDependencyRange = optionalNonEmptyArg(
    process.env.DOHC_SDK_DEPENDENCY_RANGE,
    "DOHC_SDK_DEPENDENCY_RANGE",
  );
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workspace" && argv[i + 1]) root = nonEmptyArg(argv[++i], "--workspace");
    else if (argv[i] === "--home" && argv[i + 1]) home = nonEmptyArg(argv[++i], "--home");
    else if (argv[i] === "--sdk-package-json" && argv[i + 1]) {
      sdkPackageJsonPath = nonEmptyArg(argv[++i], "--sdk-package-json");
    } else if (argv[i] === "--sdk-dependency-range" && argv[i + 1]) {
      sdkDependencyRange = nonEmptyArg(argv[++i], "--sdk-dependency-range");
    }
  }
  return {
    root,
    home,
    ...(sdkPackageJsonPath ? { sdkPackageJsonPath } : {}),
    ...(sdkDependencyRange ? { sdkDependencyRange } : {}),
  };
}

function nonEmptyArg(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} requires a non-empty value`);
  return trimmed;
}

function optionalNonEmptyArg(value: string | undefined, name: string): string | undefined {
  return value === undefined ? undefined : nonEmptyArg(value, name);
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createDohcMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "dohc", version: "0.1.0" });

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

  server.registerTool(
    "dohc_sync_now",
    {
      description:
        "LEGACY cloud path: report pre-flip legacy change sets pending since a cursor for the retired cloud sync. Engine moments never appear here (use dohc_list_changes); kept until the engine folder sync replaces it. No network push.",
      inputSchema: { sinceMs: z.number().int().nonnegative().optional() },
    },
    async (args) => text(await syncNow(ctx, args)),
  );

  server.registerTool(
    "dohc_sync_cloud",
    {
      description:
        "Run dohc Cloud merge sync for this workspace. Pull merges safely; push sends local file changes already recorded in history.",
      inputSchema: {
        direction: z.enum(["pull", "push", "push-pull"]).optional(),
      },
    },
    async (args) => text(await syncCloud(ctx, args)),
  );

  server.registerTool(
    "dohc_list_changes",
    {
      description:
        "List workspace history: workspace-engine moments (the recorder since the engine became the default) merged with pre-flip legacy change sets (read-only relic). Each entry names its source; engine entries carry path/operation/versionId instead of the legacy kind/boundaryCrossings.",
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
        "Read one history entry by id: a workspace-engine moment (with its full before/after payload) or a pre-flip legacy change set (files, author, provenance, boundary crossings).",
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
    "dohc_write_file",
    {
      description:
        "Write any visible workspace file. History: the desktop watcher captures the write as a workspace-engine moment while the app is open (a standalone MCP write is captured on the next desktop open); engine-opted-out workspaces record nothing (historyRecording: off).",
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

  server.registerTool(
    "dohc_create_directory",
    {
      description:
        "Create a visible workspace directory. Files later written inside it are captured as engine moments by the desktop watcher; opted-out workspaces record nothing.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        summary: z.string().max(500).optional(),
      },
    },
    async (args) => text(await createWorkspaceDirectory(ctx, args)),
  );

  server.registerTool(
    "dohc_move_path",
    {
      description:
        "Move or rename a visible workspace file/folder. The desktop watcher captures the change as engine moments while the app is open; opted-out workspaces record nothing.",
      inputSchema: {
        fromPath: z.string().min(1).max(4096),
        toPath: z.string().min(1).max(4096),
        overwrite: z.boolean().optional(),
        summary: z.string().max(500).optional(),
      },
    },
    async (args) => text(await moveWorkspacePath(ctx, args)),
  );

  server.registerTool(
    "dohc_delete_path",
    {
      description:
        "Delete a visible workspace file/folder by moving it to dohc's recoverable trash. The desktop watcher captures the delete as an engine moment while the app is open; opted-out workspaces record nothing.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        summary: z.string().max(500).optional(),
      },
    },
    async (args) => text(await deleteWorkspacePath(ctx, args)),
  );

  server.registerTool(
    "dohc_detect_sites",
    {
      description:
        "Detect normal browser-viewable website folders in the workspace using index.html, package.json, dohc.json, and common web configs.",
      inputSchema: {
        path: z.string().max(4096).optional(),
        maxDepth: z.number().int().nonnegative().max(12).optional(),
      },
    },
    async (args) => text(await detectSites(ctx, args)),
  );

  server.registerTool(
    "dohc_create_site",
    {
      description:
        "Scaffold a normal website folder with index.html, package.json, pinned serve devDependency, and optional dohc.json. Records history; does not create hidden app folders.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        title: z.string().max(200).optional(),
        withDohcJson: z.boolean().optional(),
      },
    },
    async (args) => text(await createSite(ctx, args)),
  );

  server.registerTool(
    "dohc_test_site",
    {
      description:
        "Run bounded static validation for a normal website folder: detector diagnostics, entry presence, and no legacy app SDK import.",
      inputSchema: {
        siteRoot: z.string().min(1).max(4096),
      },
    },
    async (args) => text(await testSite(ctx, args)),
  );

  server.registerTool(
    "dohc_build_site",
    {
      description:
        "Return the detected build plan for a normal website folder. Command execution is not wired in this MCP stub yet.",
      inputSchema: {
        siteRoot: z.string().min(1).max(4096),
      },
    },
    async (args) => text(await buildSite(ctx, args)),
  );

  server.registerTool(
    "dohc_preview_site",
    {
      description:
        "Return the dohc preview modes available for a normal website folder: static, dev server, and built preview.",
      inputSchema: {
        siteRoot: z.string().min(1).max(4096),
      },
    },
    async (args) => text(await previewSite(ctx, args)),
  );

  server.registerTool(
    "dohc_publish_site",
    {
      description:
        "Prepare a site publish/share review. This refuses to publish until dohc Cloud publish is wired.",
      inputSchema: {
        siteRoot: z.string().min(1).max(4096),
      },
    },
    async (args) => text(await publishSite(ctx, args)),
  );

  server.registerTool(
    "dohc_add_sdk",
    {
      description:
        "Add the optional @dohc/sdk dependency to a normal website package so agents can enhance it with dohc-aware reads later.",
      inputSchema: {
        siteRoot: z.string().min(1).max(4096),
      },
    },
    async (args) => text(await addSiteSdk(ctx, args)),
  );

  server.registerTool(
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
    "dohc_share",
    {
      description: "Request sharing a file. Returns needs-confirmation — sharing crosses a boundary and is never auto-applied.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        scope: z.enum(["public", "workspace"]),
      },
    },
    async (args) => text(await share(ctx, args)),
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
    "dohc_list_channels",
    {
      description:
        "List the workspace's Chats channels (including the default #general) with each channel's chats and their ids. Requires the workspace engine.",
      inputSchema: {},
    },
    async () => text(await listChannels(ctx)),
  );

  server.registerTool(
    "dohc_start_channel_chat",
    {
      description:
        "Start a new chat in a channel as the agent. `channel` accepts a channel name, #slug, or id. No title needed — the chat displays its first message.",
      inputSchema: {
        channel: z.string().min(1).max(200),
        body: z.string().min(1).max(65536),
        title: z.string().min(1).max(200).optional(),
      },
    },
    async (args) => text(await startChannelChat(ctx, args)),
  );

  server.registerTool(
    "dohc_reply_to_chat",
    {
      description:
        "Reply to a dohc Chat thread as the agent. The message is attributed to the user's agent and appears in the desktop file rail.",
      inputSchema: {
        threadId: z.string().min(1).max(200),
        body: z.string().min(1).max(65536),
      },
    },
    async (args) => text(await replyToChat(ctx, args)),
  );

  server.registerTool(
    "dohc_resolve_conflict",
    {
      description: "Attempt a conservative three-way markdown merge. Ambiguous overlaps stay a conflict for a human.",
      inputSchema: {
        base: z.string().max(2 * 1024 * 1024),
        local: z.string().max(2 * 1024 * 1024),
        remote: z.string().max(2 * 1024 * 1024),
      },
    },
    async (args) => text(resolveConflict(args)),
  );

  server.registerTool(
    "dohc_open_in_dohc",
    {
      description: "Return the contained absolute path for the desktop to open/select.",
      inputSchema: { path: z.string().min(1).max(4096) },
    },
    async (args) => text(await openInDohc(ctx, args)),
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
