import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createDohcMcpServer } from "./server";
import type { ToolContext } from "./tools";

async function withClient<T>(ctx: ToolContext, use: (client: Client) => Promise<T>): Promise<T> {
  const server = createDohcMcpServer(ctx);
  const client = new Client({ name: "workspace-search-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await use(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("dohc_search_workspace MCP tool", () => {
  it("advertises and executes on owner workspaces, and omits the tool on every share level", async () => {
    const result = {
      versionId: "main",
      results: [
        {
          id: "page:obj-1",
          kind: "page",
          title: "Tokyo Guide",
          path: "notes/tokyo.md",
          objectId: "obj-1",
          snippet: "Shinjuku hotel notes.",
          matchedTerms: ["tokyo"],
          related: [],
        },
      ],
      neighbors: [],
      complete: true,
      indexBuilding: false,
      policyDegraded: false,
      mountsCovered: true,
      sharedChannelRowsUncovered: 0,
      truncated: false,
    };
    const request = vi.fn(async () => result);

    await withClient({ root: "/workspace", home: "/state", request }, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === "dohc_search_workspace")).toBe(true);

      const response = await client.callTool({
        name: "dohc_search_workspace",
        arguments: { query: "tokyo", surfaces: ["page"], limit: 5 },
      });
      expect(response.isError).not.toBe(true);
      const text = (response.content as { type: string; text?: string }[])[0]?.text ?? "";
      expect(JSON.parse(text)).toEqual(result);
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          verb: "workspaceSearch",
          args: expect.objectContaining({
            query: "tokyo",
            surfaces: ["page"],
            limit: 5,
          }),
        }),
      );

      const bad = await client.callTool({
        name: "dohc_search_workspace",
        arguments: { query: "tokyo", unexpected: true },
      });
      expect(bad.isError).toBe(true);
    });

    for (const shareAccess of ["view", "comment", "edit"] as const) {
      const shareRequest = vi.fn();
      await withClient(
        { root: "/workspace", home: "/state", shareAccess, request: shareRequest },
        async (client) => {
          const tools = await client.listTools();
          expect(tools.tools.some((tool) => tool.name === "dohc_search_workspace")).toBe(false);
          const denied = await client.callTool({
            name: "dohc_search_workspace",
            arguments: { query: "tokyo" },
          });
          expect(denied.isError).toBe(true);
          expect(shareRequest).not.toHaveBeenCalled();
        },
      );
    }
  });
});
