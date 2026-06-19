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
  createApp,
  deleteWorkspacePath,
  importData,
  listWorkspaceFiles,
  listChanges,
  listWorkspaces,
  moveWorkspacePath,
  openInDohc,
  queryDatabase,
  readChange,
  readWorkspaceFile,
  resolveConflict,
  searchWorkspaceFiles,
  share,
  syncCloud,
  syncNow,
  testApp,
  writeWorkspaceFile,
  workspaceStatus,
  type ToolContext,
} from "./tools";

export function parseArgs(argv: string[]): ToolContext {
  let root = process.cwd();
  let home = process.env.HOME ?? process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workspace" && argv[i + 1]) root = argv[++i];
    else if (argv[i] === "--home" && argv[i + 1]) home = argv[++i];
  }
  return { root, home };
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
      description: "Report the change sets pending since a cursor (what would sync). Local-first: no network push.",
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
      description: "List dohc change sets for history, provenance, and sync-aware collaboration.",
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
      description: "Read one dohc change set, including touched files, author, provenance, and boundary crossings.",
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
      description: "Write any visible workspace file and record a dohc change set so sync/history can see it.",
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
      description: "Create a visible workspace directory and record it in dohc history.",
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
      description: "Move or rename a visible workspace file/folder and record the change for sync/history.",
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
      description: "Delete a visible workspace file/folder by moving it to dohc's recoverable trash and recording the change.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        summary: z.string().max(500).optional(),
      },
    },
    async (args) => text(await deleteWorkspacePath(ctx, args)),
  );

  server.registerTool(
    "dohc_create_app",
    {
      description: "Scaffold a new app at <area>/.apps/<name>. Never trusts the app — the user grants trust in dohc.",
      inputSchema: {
        area: z.string().max(4096).default(""),
        name: z.string().min(1).max(200),
        title: z.string().max(200).optional(),
      },
    },
    async (args) => text(await createApp(ctx, args)),
  );

  server.registerTool(
    "dohc_test_app",
    {
      description: "Run the static AppTester (compile + SDK import check) over an app's source files.",
      inputSchema: {
        appRoot: z.string().min(1).max(4096),
        sourcePaths: z.array(z.string().min(1).max(4096)).max(200),
      },
    },
    async (args) => text(await testApp(ctx, args)),
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
