import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DohcCliError } from "@dohc/cli/errors";
import { createDohcMcpServer, parseArgs } from "./server";
import type { ToolContext } from "./tools";

// The two write tiers a share level decides between. A document write
// changes the granter's files; a chat write posts to a thread.
const DOCUMENT_WRITE_TOOLS = [
  "dohc_dataset",
  "dohc_write_file",
  "dohc_create_directory",
  "dohc_move_path",
  "dohc_delete_path",
  "dohc_create_app",
  "dohc_import_data",
  // Collection writes change the granter's records, so they sit in the
  // document tier: a shared view never sees them.
  "dohc_set_record_fields",
  "dohc_create_record",
  "dohc_edit_document",
  "dohc_create_document",
  // A shared view keeps no automation runs, so it gets no automation tool.
  "dohc_list_automation_runs",
  "dohc_read_automation_run",
  "dohc_retry_automation_run",
  "dohc_press_button",
];

const CHAT_WRITE_TOOLS = ["dohc_start_group_chat", "dohc_start_file_chat", "dohc_reply_to_chat"];

const READ_TOOLS = [
  "dohc_list_files",
  "dohc_read_file",
  "dohc_read_document",
  "dohc_search_files",
  "dohc_workspace_status",
  "dohc_query_collection",
  "dohc_read_record",
];

const roots: string[] = [];
// Document tools resolve their path inside a real workspace folder.
async function workspaceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-mcp-documents-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const connections: Array<{ client: Client; server: ReturnType<typeof createDohcMcpServer> }> = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
});

async function connectedToolNames(
  ctx: ToolContext,
  clientName = "test",
): Promise<{ names: string[]; client: Client }> {
  const server = createDohcMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  connections.push({ client, server });
  const listed = await client.listTools();
  return { names: listed.tools.map((tool) => tool.name), client };
}

describe("share-level tool profiles", () => {
  const base: ToolContext = { root: "/tmp/shared-view", home: "/tmp/home" };

  it("parses the --share-access flag", () => {
    expect(parseArgs(["--workspace", "/w", "--home", "/h", "--share-access", "comment"])).toMatchObject({
      root: "/w",
      home: "/h",
      shareAccess: "comment",
    });
    expect(parseArgs(["--workspace", "/w", "--home", "/h"])).not.toHaveProperty("shareAccess");
  });

  it("refuses an unrecognized --share-access value", () => {
    // The refusal names the flag, the levels, and what it was given — an agent
    // reads the error, not this file.
    expect(() => parseArgs(["--share-access", "read-only"])).toThrow(
      '--share-access must be one of view, comment, edit. Received: "read-only".',
    );
    expect(() => parseArgs(["--share-access"])).toThrow(
      "--share-access must be one of view, comment, edit. Received: no value.",
    );
  });

  it("registers NO write tools for a view profile and keeps read tools", async () => {
    const { names } = await connectedToolNames({ ...base, shareAccess: "view" });
    for (const tool of [...DOCUMENT_WRITE_TOOLS, ...CHAT_WRITE_TOOLS]) {
      expect(names, tool).not.toContain(tool);
    }
    // The read surface is still available so agents can browse a shared view.
    for (const tool of READ_TOOLS) {
      expect(names, tool).toContain(tool);
    }
  });

  // #646 PR2 registers NO write tool at any level, chat included. The two
  // chat tools are GROUP tools, and a shared view refuses every group
  // write before the level is read; `comment` grants per-FILE chat, which no
  // MCP tool writes yet. A tool the workspace always refuses is worse than an
  // absent one — the agent spends a turn discovering the refusal.
  it("registers no write tool at all for a comment profile, chat tools included", async () => {
    const { names } = await connectedToolNames({ ...base, shareAccess: "comment" });
    for (const tool of [...DOCUMENT_WRITE_TOOLS, ...CHAT_WRITE_TOOLS]) {
      expect(
        names,
        `${tool}: offering a write tool a shared view always refuses`,
      ).not.toContain(tool);
    }
    for (const tool of READ_TOOLS) {
      expect(names, tool).toContain(tool);
    }
  });

  it("offers an edit profile exactly the comment profile's tools", async () => {
    const { names: comment } = await connectedToolNames({ ...base, shareAccess: "comment" });
    const { names: edit } = await connectedToolNames({ ...base, shareAccess: "edit" });
    expect([...edit].sort()).toEqual([...comment].sort());
  });

  it("registers both write tiers for a local workspace (no share level)", async () => {
    const { names } = await connectedToolNames(base);
    for (const tool of [...DOCUMENT_WRITE_TOOLS, ...CHAT_WRITE_TOOLS]) {
      expect(names, tool).toContain(tool);
    }
  });

  it("refuses to invoke a document write tool a comment server never registered", async () => {
    const { client } = await connectedToolNames({ ...base, shareAccess: "comment" });
    const result = (await client.callTool({
      name: "dohc_write_file",
      arguments: { path: "docs/a.md", content: "x" },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    // The tool does not exist on this server, so the call is refused (never
    // reaching any filesystem write path).
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text ?? "").toContain("not found");
  });
});

describe("parseArgs", () => {
  it("trims explicit path arguments", () => {
    expect(
      parseArgs([
        "--workspace",
        " /tmp/workspace ",
        "--home",
        " /tmp/home ",
      ]),
    ).toMatchObject({
      root: "/tmp/workspace",
      home: "/tmp/home",
    });
  });

  it("rejects blank explicit path arguments", () => {
    expect(() => parseArgs(["--workspace", " "])).toThrow(/--workspace requires/);
    expect(() => parseArgs(["--home", " "])).toThrow(/--home requires/);
  });
});


describe("MCP tool results", () => {
  it("marks partial form creation as an error and preserves structured facts", async () => {
    const partial = { kind: "partial", created: ["form/frontend.js"], failedStage: "capture", reason: "capture failed",
      retry: { mode: "resume", instruction: "Try again with the same form settings and folder." } };
    const { client } = await connectedToolNames({ root: "/workspace", home: "/home", request: async () => partial });
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const result = await client.callTool({ name: "dohc_dataset", arguments: { request: {
      action: "createForm", workspaceId: "workspace", datasetPath: "equipment/dataset.json", revision: 1, revisionSha256: "a".repeat(64),
      tableId: id(2), createOperationId: id(4), appRoot: "form", fieldIds: [id(3)],
    } } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(partial);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(partial, null, 2) }]);
  });
  it("omits tools that cannot perform the advertised action", async () => {
    const { names } = await connectedToolNames({ root: "/workspace", home: "/home" });
    for (const name of ["build_app", "preview_app", "publish_app", "share", "open_in_dohc", "resolve_conflict"]) {
      expect(names).not.toContain(`dohc_${name}`);
    }
  });

  it("returns structured chat output and preserves run-link warnings", async () => {
    const { client } = await connectedToolNames({
      root: "/workspace", home: "/home",
      request: async (request) => {
        expect(request.verb).toBe("reply");
        expect(request.args).toMatchObject({ actor: "agent", thread: "thread-1", runId: "run-1" });
        return { threadId: "th_1", messageId: "msg_2", warning: "Run provenance pending." };
      },
    });
    const result = await client.callTool({
      name: "dohc_reply_to_chat",
      arguments: { threadId: "thread-1", body: "Done", runId: "run-1" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      ok: true, threadId: "thread-1", messageId: "message-2", warning: "Run provenance pending.",
    });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent, null, 2) }]);
  });

  it("forwards a file path to list one file's history", async () => {
    const requests: unknown[] = [];
    const { client } = await connectedToolNames({
      root: "/workspace", home: "/home",
      request: async (request) => {
        requests.push(request.args);
        return { changes: [], count: 0, totalAvailable: 0, hasMore: false, cursorMs: 0 };
      },
    });
    const result = await client.callTool({ name: "dohc_list_changes", arguments: { path: "notes/plan.md", limit: 5 } });
    expect(result.isError).not.toBe(true);
    expect(requests).toEqual([{ cwd: "/workspace", actor: "agent", path: "notes/plan.md", limit: 5 }]);
  });

  it("reports authorization refusals as tool errors", async () => {
    const { client } = await connectedToolNames({
      root: "/workspace", home: "/home",
      request: async () => { throw new DohcCliError("This group is read-only."); },
    });
    const result = await client.callTool({
      name: "dohc_start_group_chat", arguments: { group: "general", body: "Hello" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ ok: false, reason: "This group is read-only." });
  });

  it("reads a document through the desktop", async () => {
    const root = await workspaceRoot();
    const { client } = await connectedToolNames({
      root, home: "/home",
      request: async (request) => {
        expect(request).toMatchObject({
          verb: "documentRead",
          args: { cwd: root, actor: "agent", path: "notes/plan.md" },
        });
        return { ok: true, path: "notes/plan.md", markdown: "# Plan" };
      },
    });
    const result = await client.callTool({ name: "dohc_read_document", arguments: { path: "notes/plan.md" } });
    expect(result.structuredContent).toEqual({ ok: true, path: "notes/plan.md", markdown: "# Plan" });
  });

  it("names the agent from its handshake on a document edit, and invents no name", async () => {
    const root = await workspaceRoot();
    const edits: unknown[] = [];
    const request: ToolContext["request"] = async (sent) => {
      edits.push(sent.args);
      return { ok: true, path: "notes/plan.md", changed: true };
    };
    const edit = { path: "notes/plan.md", find: "Draft", replacement: "Final", requestId: "plan-1" };
    for (const clientName of ["claude-code", "a/b"]) {
      const { client } = await connectedToolNames({ root, home: "/home", request }, clientName);
      const result = await client.callTool({ name: "dohc_edit_document", arguments: edit });
      expect(result.structuredContent).toEqual({ ok: true, path: "notes/plan.md", changed: true });
    }
    expect(edits).toEqual([
      { cwd: root, actor: "agent", agent: "claude-code", ...edit },
      { cwd: root, actor: "agent", ...edit },
    ]);
  });

  it("creates a document under the agent name from the handshake", async () => {
    const root = await workspaceRoot();
    const sent: unknown[] = [];
    const { client } = await connectedToolNames({
      root, home: "/home",
      request: async (request) => {
        sent.push(request);
        return { ok: true, path: "notes/new.md" };
      },
    }, "claude-code");
    const result = await client.callTool({ name: "dohc_create_document", arguments: { path: "notes/new.md", markdown: "# New" } });
    expect(result.structuredContent).toEqual({ ok: true, path: "notes/new.md" });
    expect(sent).toMatchObject([{
      verb: "documentCreate",
      args: { cwd: root, actor: "agent", agent: "claude-code", path: "notes/new.md", markdown: "# New" },
    }]);
  });

  it("comments on a file by starting its chat", async () => {
    const root = await workspaceRoot();
    const { client } = await connectedToolNames({
      root, home: "/home",
      request: async (request) => {
        expect(request).toMatchObject({
          verb: "fileChatStart",
          args: { cwd: root, actor: "agent", agent: "claude-code", path: "notes/budget.md", title: "Food", body: "Is 400 enough?", requestId: "budget-1" },
        });
        return { ok: true, path: "notes/budget.md", threadId: "thread-1", messageId: "message-1" };
      },
    }, "claude-code");
    const result = await client.callTool({
      name: "dohc_start_file_chat",
      arguments: { path: "notes/budget.md", title: "Food", body: "Is 400 enough?", requestId: "budget-1" },
    });
    expect(result.structuredContent).toEqual({
      ok: true, path: "notes/budget.md", threadId: "thread-1", messageId: "message-1",
    });
  });

  it("turns poll options into a decision even without needsDecision", async () => {
    const { client } = await connectedToolNames({
      root: "/workspace", home: "/home",
      request: async (request) => {
        expect(request.args).toMatchObject({ needsDecision: true, options: ["Yes", "No"] });
        return { group: { id: "ch_1", name: "general", slug: "general", kind: "group" },
          threadId: "th_1", messageId: "msg_1", title: "" };
      },
    });
    const result = await client.callTool({
      name: "dohc_start_group_chat", arguments: { group: "general", body: "Ready?", options: ["Yes", "No"] },
    });
    expect(result.isError).not.toBe(true);
  });
});

it.each([
  { paused: null, failureReason: "runner failed to start", exitCode: 7 },
  { paused: "budget", failureReason: "runner failed to start", exitCode: 7 },
  { paused: null, failureReason: "no-reply", exitCode: 0 },
  { paused: "budget", failureReason: "no-reply", exitCode: 0 },
] as const)("serves dispatch state through dohc_read_chat: $paused / $failureReason", async ({ paused, failureReason, exitCode }) => {
  const response = {
    ok: true, thread: { id: "thread-1", title: "Audit", createdAtMs: 1, updatedAtMs: 1 },
    messages: [], projection: { path: ".dohc/chats/thread-1.md", readOnly: true, text: "" },
    dispatch: { paused, lastRun: { state: "failed", failureReason, exitCode } },
  };
  const { client } = await connectedToolNames({ root: "/workspace", home: "/home", request: async () => response });
  const result = await client.callTool({ name: "dohc_read_chat", arguments: { threadId: "thread-1" } });
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe("text");
  expect(JSON.parse(content[0]!.text)).toEqual(response);
});
