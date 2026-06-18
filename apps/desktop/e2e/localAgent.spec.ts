import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childProcessEnv, launchApp } from "./launch";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

// Phase 11: local agent + MCP. Two surfaces are proven end to end:
//  1. The DESKTOP settings panel honestly exposes the MCP integration — the
//     workspace path, a copyable config snippet (the exact command + args the
//     user pastes into Claude Code / Codex), and a user-controlled Enable toggle
//     that starts/ends an attributed agent run. Nothing runs until the user opts
//     in here.
//  2. The REAL stdio MCP server (what the configured AI tool launches) boots,
//     advertises its tools, scaffolds + statically tests a local app, reports a
//     clean local-first sync state, and — the #1 security property — refuses any
//     path that escapes the workspace root.

async function seedWorkspace(workspaceId: string): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-agent-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-agent-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId, kind: "personal", mode: "local-first" }),
  );
  await writeFile(join(root, "notes", "budget.md"), "# Budget\n");
  return { home, root };
}

test("desktop settings expose the MCP config and toggle an attributed agent run", async () => {
  const { home, root } = await seedWorkspace("agent-ui-ws");
  const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
  const page = await app.firstWindow();

  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();

  // Open the settings surface from the status-bar gear.
  await page.getByRole("button", { name: /^settings$/i }).click();
  const panel = page.getByTestId("settings-panel");
  await expect(panel).toBeVisible();

  // The config snippet is the literal thing the user pastes into their AI tool:
  // it names THIS workspace root and the desktop state home, scoping the server.
  const snippet = page.getByTestId("mcp-config-snippet");
  await expect(snippet).toContainText("--workspace");
  await expect(snippet).toContainText(root);
  await expect(snippet).toContainText("--home");
  await expect(snippet).toContainText(home);

  // The server is opt-in: stopped until the user enables it.
  await expect(page.getByTestId("mcp-status")).toHaveAttribute("data-state", "stopped");
  await page.getByTestId("mcp-enable-toggle").click();
  await expect(page.getByTestId("mcp-status")).toHaveAttribute("data-state", "running");

  // Enabling records a visible, inspectable agent run in the workspace.
  await expect
    .poll(() => existsSync(join(root, ".dohc", "agent-runs.json")), { timeout: 10_000 })
    .toBe(true);
  const runs = JSON.parse(readFileSync(join(root, ".dohc", "agent-runs.json"), "utf8"));
  expect(runs.at(-1)).toMatchObject({ status: "running" });

  // And it is just as easily turned back off.
  await page.getByTestId("mcp-enable-toggle").click();
  await expect(page.getByTestId("mcp-status")).toHaveAttribute("data-state", "stopped");

  await app.close();
});

test("the dohc MCP server serves workspace tools over stdio and refuses traversal", async () => {
  const { home, root } = await seedWorkspace("agent-mcp-ws");
  // The desktop registry the AI tool's server reads for list_workspaces.
  await writeFile(
    join(home, "dohc-workspaces.json"),
    JSON.stringify({
      version: 1,
      workspaces: [{ workspaceId: "agent-mcp-ws", rootPath: root, kind: "personal", mode: "local-first" }],
    }),
  );

  // Exactly what Claude Code / Codex do: launch the server as a stdio child
  // scoped to the workspace root + state home.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"),
      join(REPO_ROOT, "packages/mcp/src/server.ts"),
      "--workspace",
      root,
      "--home",
      home,
    ],
    env: childProcessEnv(),
  });
  const client = new Client({ name: "dohc-e2e-agent", version: "1.0.0" });
  await client.connect(transport);

  try {
    const parse = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ type: string; text: string }>;
      };
      return JSON.parse(res.content[0].text);
    };

    // The full workspace MCP surface is present: broad file affordances plus
    // dohc history/cloud/app/database/share primitives.
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "dohc_create_app",
        "dohc_create_directory",
        "dohc_delete_path",
        "dohc_import_data",
        "dohc_list_changes",
        "dohc_list_files",
        "dohc_list_workspaces",
        "dohc_move_path",
        "dohc_open_in_dohc",
        "dohc_query_database",
        "dohc_read_change",
        "dohc_read_file",
        "dohc_resolve_conflict",
        "dohc_search_files",
        "dohc_share",
        "dohc_sync_cloud",
        "dohc_sync_now",
        "dohc_test_app",
        "dohc_write_file",
        "dohc_workspace_status",
      ].sort(),
    );

    // The server sees the registered workspace and reports it local-first.
    expect((await parse("dohc_list_workspaces")).workspaces).toContainEqual(
      expect.objectContaining({ workspaceId: "agent-mcp-ws", rootPath: root }),
    );
    expect(await parse("dohc_workspace_status")).toMatchObject({ synced: false, scope: "local" });

    // An agent scaffolds an app, then statically tests it — both contained.
    expect(await parse("dohc_create_app", { area: "finance", name: "ledger", title: "Ledger" })).toMatchObject({
      ok: true,
      trusted: false,
      appRoot: "finance/.apps/ledger",
    });
    expect(existsSync(join(root, "finance", ".apps", "ledger", "src", "App.tsx"))).toBe(true);
    expect(
      await parse("dohc_test_app", {
        appRoot: "finance/.apps/ledger",
        sourcePaths: ["finance/.apps/ledger/src/App.tsx"],
      }),
    ).toMatchObject({ ok: true });

    // Agents can work with arbitrary visible workspace files like a normal
    // local folder, while dohc records the changes for history/sync.
    const write = await parse("dohc_write_file", {
      path: "notes/agent.txt",
      content: "I ate 10 apples\n",
      summary: "Agent wrote note",
    });
    expect(write).toMatchObject({ ok: true, path: "notes/agent.txt" });
    expect(await parse("dohc_read_file", { path: "notes/agent.txt" })).toMatchObject({
      ok: true,
      content: "I ate 10 apples\n",
    });
    expect(await parse("dohc_search_files", { query: "10 apples" })).toMatchObject({
      ok: true,
      matches: [expect.objectContaining({ path: "notes/agent.txt", line: 1 })],
    });
    expect(await parse("dohc_list_files", { path: "notes" })).toMatchObject({
      ok: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ path: "notes/agent.txt", kind: "file" }),
      ]),
    });

    const history = await parse("dohc_list_changes", { includeFiles: true });
    expect(history).toMatchObject({
      count: 2,
      changes: expect.arrayContaining([
        expect.objectContaining({ summary: "Agent wrote note" }),
        expect.objectContaining({ summary: "MCP created app ledger" }),
      ]),
    });
    const noteChange = (history.changes as Array<{ id: string; summary: string }>).find(
      (change) => change.summary === "Agent wrote note",
    );
    expect(noteChange).toBeTruthy();
    expect(await parse("dohc_read_change", { id: noteChange!.id })).toMatchObject({
      ok: true,
      change: expect.objectContaining({
        summary: "Agent wrote note",
        files: [{ path: "notes/agent.txt", operation: "write" }],
      }),
    });

    expect(await parse("dohc_sync_now")).toMatchObject({
      clean: false,
      pendingChangeCount: 2,
    });
    expect(await parse("dohc_sync_cloud", { direction: "push" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("local-only"),
    });

    // #1 security property: a path that escapes the workspace root is refused.
    const escaped = await parse("dohc_open_in_dohc", { path: "../../../etc/passwd" });
    expect(escaped.ok).toBe(false);
    expect(escaped.reason).toMatch(/path rejected/i);
  } finally {
    await client.close();
  }
});
