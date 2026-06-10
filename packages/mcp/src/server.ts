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
import { z } from "zod";
import {
  createApp,
  importData,
  listWorkspaces,
  openInDohc,
  queryDatabase,
  resolveConflict,
  share,
  syncNow,
  testApp,
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
    async (args) => text(openInDohc(ctx, args)),
  );

  return server;
}

async function main() {
  const ctx = parseArgs(process.argv.slice(2));
  const server = createDohcMcpServer(ctx);
  await server.connect(new StdioServerTransport());
}

// Run only when invoked as the entry binary, not when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
