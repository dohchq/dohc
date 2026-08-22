import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createDohcMcpServer, parseArgs } from "./server";
import type { ToolContext } from "./tools";

// The two write tiers a share level decides between (#646). A document write
// changes the granter's files; a chat write posts to a thread.
const DOCUMENT_WRITE_TOOLS = [
  "dohc_write_file",
  "dohc_create_directory",
  "dohc_move_path",
  "dohc_delete_path",
  "dohc_create_site",
  "dohc_import_data",
  "dohc_publish_site",
  "dohc_share",
];

const CHAT_WRITE_TOOLS = ["dohc_start_channel_chat", "dohc_reply_to_chat"];

const READ_TOOLS = [
  "dohc_list_files",
  "dohc_read_file",
  "dohc_search_files",
  "dohc_workspace_status",
];

async function connectedToolNames(ctx: ToolContext): Promise<{ names: string[]; client: Client }> {
  const server = createDohcMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  return { names: listed.tools.map((tool) => tool.name), client };
}

async function connectedTools(ctx: ToolContext): Promise<Array<{ name: string; description?: string }>> {
  const server = createDohcMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  return listed.tools.map((tool) => ({ name: tool.name, description: tool.description }));
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
  // chat tools are CHANNEL tools, and a shared view refuses every channel
  // write before the level is read; `comment` grants per-FILE chat, which no
  // MCP tool writes yet. A tool the workspace always refuses is worse than an
  // absent one — the agent spends a turn discovering the refusal.
  it("registers no write tool at all for a comment profile, chat tools included", async () => {
    const { names } = await connectedToolNames({ ...base, shareAccess: "comment" });
    for (const tool of [...DOCUMENT_WRITE_TOOLS, ...CHAT_WRITE_TOOLS]) {
      expect(
        names,
        `${tool}: MUTATION: offering a write tool a shared view always refuses`,
      ).not.toContain(tool);
    }
    for (const tool of READ_TOOLS) {
      expect(names, tool).toContain(tool);
    }
  });

  it("offers an edit profile exactly the comment profile's tools (PR3 opens document writes)", async () => {
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

describe("change-history tool descriptions (engine-only drift guard)", () => {
  const base: ToolContext = { root: "/tmp/shared-view", home: "/tmp/home" };

  // The .dohc/history legacy change-set relic was retired with
  // @dohc/workspace-history; these tools now surface engine moments ONLY. Guard
  // against the descriptions drifting back to promising legacy/merged content.
  const STALE_PHRASES = [
    "legacy",
    "relic",
    "merged with",
    "pre-flip",
    "boundaryCrossings",
    "change set",
    "change sets",
    "provenance",
  ];

  it("dohc_list_changes and dohc_read_change describe engine moments only", async () => {
    const tools = await connectedTools(base);
    for (const name of ["dohc_list_changes", "dohc_read_change"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      const description = (tool?.description ?? "").toLowerCase();
      expect(description, name).toContain("engine");
      for (const phrase of STALE_PHRASES) {
        expect(description, `${name} must not mention "${phrase}"`).not.toContain(phrase.toLowerCase());
      }
    }
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
