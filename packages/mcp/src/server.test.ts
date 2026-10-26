import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DohcCliError } from "@dohc/cli/errors";
import { createDohcMcpServer, parseArgs } from "./server";
import { getShareCopyDetails, type ToolContext } from "./tools";

// The two write tiers a share level decides between. A document write
// changes the granter's files; a chat write posts to a thread.
const DOCUMENT_WRITE_TOOLS = [
  "dohc_stop_workspace_sync",
  "dohc_dataset",
  "dohc_save_kept_copy",
  // Refused live edits are kept only in the original workspace.
  "dohc_save_recovery_copy",
  "dohc_retry_kept_edits",
  "dohc_stop_again",
  "dohc_delete_retained_copies",
  "dohc_publish_app",
  "dohc_write_file",
  "dohc_create_directory",
  "dohc_duplicate_file",
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
  // A shared view keeps no automation runs, so run tools stay owner-only.
  "dohc_list_automation_runs",
  "dohc_read_automation_run",
  "dohc_retry_automation_run",
];

const CHAT_WRITE_TOOLS = ["dohc_start_group_chat", "dohc_start_file_chat", "dohc_reply_to_chat"];

const SHARED_TOOLS = [
  "dohc_inspect_buttons",
  "dohc_press_button",
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

  it("stops the owner's workspace with the handshake name as provenance", async () => {
    const requests: unknown[] = [];
    const { client } = await connectedToolNames({ ...base, request: async request => {
      requests.push(request);
      return { ok: true, workspaceId: "workspace", workspaceSynced: false };
    } });
    const result = await client.callTool({ name: "dohc_stop_workspace_sync", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(requests).toMatchObject([{ verb: "stopSync", door: "mcp", args: { cwd: base.root, actor: "agent", agent: "test" } }]);
  });

  it("saves, tries again and stops again an owner's kept edits by path, refusing a path outside the workspace", async () => {
    const root = await workspaceRoot();
    const requests: unknown[] = [];
    const { client } = await connectedToolNames({ root, home: base.home, request: async request => {
      requests.push(request);
      return request.verb === "stopAgain" ? { ok: true, path: "plan.md", keptEdits: "recovered" }
        : "incident" in request.args ? { ok: true, path: "plan.md" }
        : { ok: true, copyPath: null, packagePath: "plan (recovered).dohc-recovery.json", folder: ".", storedOn: "this-computer", keptEdits: "kept" };
    } });
    expect((await client.callTool({ name: "dohc_save_recovery_copy", arguments: { path: "plan.md" } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "dohc_retry_kept_edits", arguments: { path: "plan.md", incident: "outbox:delivery:0" } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "dohc_stop_again", arguments: { path: "plan.md", incident: "release:a:0" } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "dohc_save_recovery_copy", arguments: { path: "../other/plan.md" } })).isError).toBe(true);
    expect((await client.callTool({ name: "dohc_stop_again", arguments: { path: "../other/plan.md", incident: "release:a:0" } })).isError).toBe(true);
    expect(requests).toEqual([
      { protocolVersion: expect.any(Number), door: "mcp", verb: "saveRecoveryCopy", args: { cwd: root, actor: "agent", path: "plan.md" } },
      { protocolVersion: expect.any(Number), door: "mcp", verb: "retryKeptEdits", args: { cwd: root, actor: "agent", path: "plan.md", incident: "outbox:delivery:0" } },
      { protocolVersion: expect.any(Number), door: "mcp", verb: "stopAgain", args: { cwd: root, actor: "agent", path: "plan.md", incident: "release:a:0" } },
    ]);
  });

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

  it("offers only the tools named with --tool", async () => {
    const ctx = parseArgs(["--workspace", "/w", "--home", "/h", "--tool", "dohc_reply_to_chat"]);
    expect(ctx.tools).toEqual(new Set(["dohc_reply_to_chat"]));
    expect((await connectedToolNames(ctx)).names).toEqual(["dohc_reply_to_chat"]);
    // The share level still decides: a view profile can't reply.
    const view = parseArgs(["--share-access", "view", "--tool", "dohc_reply_to_chat", "--tool", "dohc_read_file"]);
    expect((await connectedToolNames(view)).names).toEqual(["dohc_read_file"]);
  });

  it("refuses a --tool that names no dohc tool", () => {
    expect(() => parseArgs(["--tool", "dohc_reply"])).toThrow(
      '--tool must name a dohc tool, such as dohc_reply_to_chat. Received: "dohc_reply".',
    );
    expect(() => parseArgs(["--tool", "toString"])).toThrow(/Received: "toString"/u);
    expect(() => parseArgs(["--tool"])).toThrow(/Received: no value/u);
  });

  it("registers NO write tools for a view profile and keeps read tools", async () => {
    const { names } = await connectedToolNames({ ...base, shareAccess: "view" });
    for (const tool of [...DOCUMENT_WRITE_TOOLS, ...CHAT_WRITE_TOOLS]) {
      expect(names, tool).not.toContain(tool);
    }
    // The read surface is still available so agents can browse a shared view.
    for (const tool of SHARED_TOOLS) {
      expect(names, tool).toContain(tool);
    }
  });

  // Local file, document, and chat writes require an owning workspace.
  // Shared views expose Button presses checked by the owner's host.
  it("registers no write tool at all for a comment profile, chat tools included", async () => {
    const { names } = await connectedToolNames({ ...base, shareAccess: "comment" });
    for (const tool of [...DOCUMENT_WRITE_TOOLS, ...CHAT_WRITE_TOOLS]) {
      expect(
        names,
        `${tool}: offering a write tool a shared view always refuses`,
      ).not.toContain(tool);
    }
    for (const tool of SHARED_TOOLS) {
      expect(names, tool).toContain(tool);
    }
  });

  it("adds automation switches to the Edit profile", async () => {
    const { names: comment } = await connectedToolNames({ ...base, shareAccess: "comment" });
    const { names: edit } = await connectedToolNames({ ...base, shareAccess: "edit" });
    expect([...edit].sort()).toEqual([...comment, "dohc_switch_automation"].sort());
  });

  it("registers both write tiers for a local workspace (no share level)", async () => {
    const { names } = await connectedToolNames(base);
    expect(names).not.toContain("dohc_switch_automation");
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
  it("exposes owner publication and omits unsupported actions", async () => {
    const { names } = await connectedToolNames({ root: "/workspace", home: "/home" });
    expect(names).toContain("dohc_publish_app");
    for (const name of ["build_app", "preview_app", "share", "open_in_dohc", "resolve_conflict"]) {
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

  it("lists old file copies and deletes them only with the late-write risk accepted", async () => {
    const requests: { verb: string; args: unknown }[] = [];
    const { client } = await connectedToolNames({
      root: "/workspace", home: "/home",
      request: async (request) => {
        requests.push({ verb: request.verb, args: request.args });
        return request.verb === "retainedCopies"
          ? { ok: true, copies: [{ id: 3, revision: 10 }], more: false, total: { count: 1, bytes: 9 } }
          : { ok: true, deleted: 1, skipped: 0, failed: 0, remaining: { count: 0, bytes: 0 } };
      },
    });
    const listed = await client.callTool({ name: "dohc_list_retained_copies", arguments: {} });
    expect(listed.structuredContent).toEqual({ ok: true, copies: [{ id: 3, revision: 10 }], more: false, total: { count: 1, bytes: 9 } });
    for (const acceptLateWriteRisk of [undefined, false]) {
      const refused = await client.callTool({
        name: "dohc_delete_retained_copies",
        arguments: { copies: [{ id: 3, revision: 10 }], ...(acceptLateWriteRisk === undefined ? {} : { acceptLateWriteRisk }) },
      });
      expect(refused.isError).toBe(true);
    }
    const deleted = await client.callTool({
      name: "dohc_delete_retained_copies",
      arguments: { copies: [{ id: 3, revision: 10 }], acceptLateWriteRisk: true },
    });
    expect(deleted.isError).not.toBe(true);
    expect(requests).toEqual([
      { verb: "retainedCopies", args: { cwd: "/workspace", actor: "agent" } },
      { verb: "deleteRetainedCopies", args: { cwd: "/workspace", actor: "agent", copies: [{ id: 3, revision: 10 }], acceptLateWriteRisk: true } },
    ]);
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

  it.each(["view", "comment", "edit"] as const)("offers shared definitions and only the %s switch permission", async shareAccess => {
    const root = await workspaceRoot(), requests: unknown[] = [];
    const definitions = { file: { status: "missing" }, canSwitch: shareAccess === "edit", contentHash: null, sync: "accepted" };
    const { client, names } = await connectedToolNames({ root, home: "/home", shareAccess, request: async request => {
      requests.push(request);
      return request.verb === "automationList" ? { ok: true, definitions } : { ok: true, result: { status: "written", contentHash: "b".repeat(64), sync: "pending" } };
    } });
    expect(names).toContain("dohc_list_automations");
    expect(names.includes("dohc_switch_automation")).toBe(shareAccess === "edit");
    const listed = await client.callTool({ name: "dohc_list_automations", arguments: { collectionPath: "notes" } });
    expect(listed.structuredContent).toEqual({ ok: true, definitions });
    if (shareAccess === "edit") {
      const switched = await client.callTool({ name: "dohc_switch_automation", arguments: { collectionPath: "notes", automation: "stamp", enabled: false, expectedContentHash: "a".repeat(64), reformat: true, submitId: "switch-1" } });
      expect(switched.structuredContent).toMatchObject({ result: { status: "written", sync: "pending" } });
      expect(requests).toContainEqual(expect.objectContaining({ verb: "automationSwitch", args: expect.objectContaining({ automation: "stamp", enabled: false, reformat: true, submitId: "switch-1" }) }));
    }
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

  it("passes bodies at the normalized UTF-8 limit to the server for every chat write", async () => {
    // CRLF becomes LF and trailing JS whitespace is removed before the cap.
    const body = "x".repeat(65_534) + "\r\ny\uFEFF ";
    const sent: unknown[] = [];
    const root = await workspaceRoot();
    const { client } = await connectedToolNames({ root, home: "/home",
      request: async request => {
        if (!("body" in request.args)) throw new Error("Expected a chat write");
        sent.push(request.args.body);
        return request.verb === "fileChatStart"
          ? { ok: true, path: "tracked.md", threadId: "thread-1", messageId: "message-1" }
          : request.verb === "post"
            ? { group: { id: "ch_1", name: "general", slug: "general", kind: "group" }, threadId: "th_1", messageId: "msg_1", title: "" }
            : { threadId: "th_1", messageId: "msg_2" };
      },
    });
    for (const [name, args] of [
      ["dohc_start_file_chat", { path: "tracked.md", title: "Limit" }],
      ["dohc_start_group_chat", { group: "general" }],
      ["dohc_reply_to_chat", { threadId: "thread-1" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: { ...args, body } });
      expect(result, JSON.stringify(result)).not.toHaveProperty("isError", true);
    }
    expect(sent).toEqual([body, body, body]);
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


describe("file write handshake attribution", () => {
  it.each(["Codex", "invalid/name"])("forwards %s to both Collection writes", async name => {
    const root = await workspaceRoot();
    const requests: unknown[] = [];
    const { client } = await connectedToolNames({ root, home: "/home", request: async request => {
      requests.push(request);
      return { ok: false, reason: "Test refusal" };
    } }, name);
    await client.callTool({ name: "dohc_set_record_fields", arguments: { recordPath: "tasks/a.md", fields: { status: "done" } } });
    await client.callTool({ name: "dohc_create_record", arguments: { collectionPath: "tasks", name: "b" } });
    expect(requests).toMatchObject([
      { verb: "collectionSetFields", args: { actor: "agent", agent: name === "Codex" ? name : undefined } },
      { verb: "collectionCreateRecord", args: { actor: "agent", agent: name === "Codex" ? name : undefined } },
    ]);
  });

  it.each(["Codex", "invalid/name"])("forwards the validated name from %s", async name => {
    const root = await workspaceRoot();
    const requests: unknown[] = [];
    const { client } = await connectedToolNames({ root, home: root, request: async request => {
      requests.push(request);
      return { ok: true, written: ["note.txt"] };
    } }, name);
    await client.callTool({ name: "dohc_write_file", arguments: { path: "note.txt", content: "new" } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ verb: "fileWrite", args: { actor: "agent", agent: name === "Codex" ? name : undefined } });
  });
});


it("routes owner publication with a bearer warning and a stable link operation id", async () => {
  const operationId="00000000-0000-4000-8000-000000000101";
  const facts={kind:"linkCreated",shareId:"s",grantId:"g",selector:{paths:["app"],versionId:null},access:"view",url:"https://relay.example/s/#secret",bearerWarning:"This URL is a bearer credential at view access, usable by anyone who holds it."};
  const {client}=await connectedToolNames({root:"/workspace",home:"/home",request:async request=>{
    expect(request.verb).toBe("appPublication");
    expect(request.args).toMatchObject({actor:"agent",request:{action:"createLink",workspaceId:"w",appRoot:"app",operationId,access:"view",agentLabel:"Builder"}});
    return facts;
  }});
  const result=await client.callTool({name:"dohc_publish_app",arguments:{request:{action:"createLink",workspaceId:"w",appRoot:"app",operationId,agentLabel:"Builder"}}});
  expect(result.structuredContent).toEqual(facts);
  expect(result.content).toHaveLength(1);
  expect(JSON.parse((result.content as Array<{type:string;text:string}>)[0]!.text)).toEqual(facts);
});


describe("share copy profile admission", () => {
  const input = { shareId: "share", grantId: "grant" };
  const details = { status: "active", shareCode: "dohc-share:share:https://relay.test", browserInvitationUrl: "https://share.test/s/edit/grant" };
  it("advertises and calls the copy tool only for the owner profile", async () => {
    const request = vi.fn(async () => details);
    const { names, client } = await connectedToolNames({ root: "/workspace", home: "/state", request });
    expect(names).toContain("dohc_read_share_copy");
    const result = await client.callTool({ name: "dohc_read_share_copy", arguments: input });
    expect(result.structuredContent).toEqual(details);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ verb: "shareCopy", door: "mcp", args: { ...input, cwd: "/workspace", actor: "agent" } }));
  });
  it.each(["view", "comment", "edit"] as const)("refuses tools/call for a %s profile", async shareAccess => {
    const request = vi.fn(async () => details);
    const { names, client } = await connectedToolNames({ root: "/workspace", home: "/state", shareAccess, request });
    expect(names).not.toContain("dohc_read_share_copy");
    expect(await client.callTool({ name: "dohc_read_share_copy", arguments: input })).toMatchObject({ isError: true });
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["view", "comment", "edit"] as const)("refuses direct copy reads for a %s profile", async shareAccess => {
    const request = vi.fn(async () => details);
    expect(await getShareCopyDetails({ root: "/workspace", home: "/state", shareAccess, request }, input))
      .toMatchObject({ ok: false, reason: expect.stringContaining("owning workspace") });
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["workspaceId", "ownerUserId", "userId", "credentials", "relayUrl"])("refuses caller-supplied %s before transport", async key => {
    const request = vi.fn(async () => details);
    expect(await getShareCopyDetails({ root: "/workspace", home: "/state", request }, { ...input, [key]: "other" })).toMatchObject({ ok: false });
    expect(request).not.toHaveBeenCalled();
  });
});

it("keeps an absent incoming subject as JSON null", async () => {
  const { client } = await connectedToolNames({ root: "/tmp/links", home: "/tmp/home", request: async () => null });
  const result = await client.callTool({ name: "dohc_links_in", arguments: { subject: { path: "missing.md" } } });
  expect(result.content).toEqual([{ type: "text", text: "null" }]);
  expect(result.structuredContent).toBeUndefined();
  expect(result.isError).not.toBe(true);
});
