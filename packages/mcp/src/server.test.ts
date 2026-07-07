import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createDohcMcpServer, parseArgs } from "./server";
import type { ToolContext } from "./tools";

// The mutating tools that a read-only shared-view server must never expose.
const WRITE_TOOLS = [
  "dohc_write_file",
  "dohc_create_directory",
  "dohc_move_path",
  "dohc_delete_path",
  "dohc_sync_cloud",
  "dohc_create_site",
  "dohc_add_sdk",
  "dohc_import_data",
  "dohc_publish_site",
  "dohc_share",
  "dohc_start_channel_chat",
  "dohc_reply_to_chat",
];

async function connectedToolNames(ctx: ToolContext): Promise<{ names: string[]; client: Client }> {
  const server = createDohcMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  return { names: listed.tools.map((tool) => tool.name), client };
}

describe("read-only shared-view profile", () => {
  const base: ToolContext = { root: "/tmp/shared-view", home: "/tmp/home" };

  it("parses the --read-only flag", () => {
    expect(parseArgs(["--workspace", "/w", "--home", "/h", "--read-only"])).toMatchObject({
      root: "/w",
      home: "/h",
      readOnly: true,
    });
    expect(parseArgs(["--workspace", "/w", "--home", "/h"])).not.toHaveProperty("readOnly");
  });

  it("registers NO mutating tools and keeps read tools", async () => {
    const { names } = await connectedToolNames({ ...base, readOnly: true });
    for (const tool of WRITE_TOOLS) {
      expect(names, tool).not.toContain(tool);
    }
    // The read surface is still available so agents can browse a shared view.
    for (const tool of ["dohc_list_files", "dohc_read_file", "dohc_search_files", "dohc_workspace_status"]) {
      expect(names, tool).toContain(tool);
    }
  });

  it("still exposes the mutating tools in the normal (writable) profile", async () => {
    const { names } = await connectedToolNames(base);
    for (const tool of WRITE_TOOLS) {
      expect(names, tool).toContain(tool);
    }
  });

  it("refuses to invoke a write tool that a read-only server never registered", async () => {
    const { client } = await connectedToolNames({ ...base, readOnly: true });
    const result = (await client.callTool({
      name: "dohc_write_file",
      arguments: { path: "docs/a.md", content: "x" },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    // The tool does not exist in a read-only server, so the call is refused
    // (never reaching any filesystem write path).
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text ?? "").toContain("not found");
  });
});

describe("parseArgs", () => {
  it("trims explicit path and package arguments", () => {
    expect(
      parseArgs([
        "--workspace",
        " /tmp/workspace ",
        "--home",
        " /tmp/home ",
        "--sdk-package-json",
        " /tmp/sdk/package.json ",
        "--sdk-dependency-range",
        " ^0.1.0 ",
      ]),
    ).toMatchObject({
      root: "/tmp/workspace",
      home: "/tmp/home",
      sdkPackageJsonPath: "/tmp/sdk/package.json",
      sdkDependencyRange: "^0.1.0",
    });
  });

  it("rejects blank explicit path and package arguments", () => {
    expect(() => parseArgs(["--workspace", " "])).toThrow(/--workspace requires/);
    expect(() => parseArgs(["--home", " "])).toThrow(/--home requires/);
    expect(() => parseArgs(["--sdk-package-json", " "])).toThrow(
      /--sdk-package-json requires/,
    );
    expect(() => parseArgs(["--sdk-dependency-range", " "])).toThrow(
      /--sdk-dependency-range requires/,
    );
  });

  it("rejects present-but-blank SDK environment arguments", () => {
    vi.stubEnv("DOHC_SDK_PACKAGE_JSON", " ");
    try {
      expect(() => parseArgs([])).toThrow(/DOHC_SDK_PACKAGE_JSON requires/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
