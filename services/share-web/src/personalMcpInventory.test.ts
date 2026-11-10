import { expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { servePersonalMcp } from "./personalMcp";
import personalTools from "./personalMcpTools.main.json";
import linkTools from "./remoteMcpTools.main.json";

type Tool = { name: string; inputSchema: unknown };

// Exercises the personal server's registration and HTTP transport. No tool
// runs: the only relay answer is the reach check that starts each request.
async function advertisedPersonalTools(): Promise<Tool[]> {
  const client = new Client({ name: "main-inventory", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("https://share.example.test/mcp/agent/w/trip"), {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const result = await servePersonalMcp(request, {
          signal: request.signal, deadlineAtMs: Date.now() + 30_000,
          client: {
            call: async (action) => {
              if (action !== "workspaces") throw new Error(`Unexpected inventory call: ${action}`);
              return Response.json({
                ok: true, agent: { agentId: "agent", name: "Helper", handle: "Helper" },
                workspaces: [{ workspaceId: "trip", name: "Trip", level: "view", dmChannelWireId: "dm" }],
              });
            },
          },
        });
        if (!result) throw new Error("The reach check refused the inventory's token.");
        return new Response(result.body, { status: result.status, headers: result.headers });
      },
    }));
    return (await client.listTools()).tools.map(({ name, inputSchema }) => ({ name, inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally { await client.close(); }
}

const properties = (tools: readonly Tool[], name: string) =>
  (tools.find((tool) => tool.name === name)!.inputSchema as { properties: Record<string, unknown> }).properties;

it("preserves main personal agent MCP names and input schemas", async () => {
  // Every level sees every tool: reach is per workspace, so the relay refuses a post at View.
  expect(await advertisedPersonalTools()).toEqual(personalTools);
});

it("takes a Comment thread's id in the same shape to read it and to reply in it", () => {
  const shape = (schema: unknown) => ({ ...(schema as Record<string, unknown>), description: undefined });
  expect(shape(properties(personalTools, "dohc_read_discussion").threadId))
    .toEqual(shape(properties(personalTools, "dohc_post_discussion").threadId));
});

it("takes the share link tools' inputs where they mean the same thing", () => {
  const linkFiles = linkTools["comment/current/without-live"], linkChannel = linkTools["group-channel"];
  for (const name of ["dohc_post_channel", "dohc_post_discussion"]) {
    const post = properties(personalTools, name);
    expect([post.body, post.idempotencyKey], name).toEqual([properties(linkChannel, "dohc_post_channel").body, properties(linkChannel, "dohc_post_channel").idempotencyKey]);
  }
  expect(properties(personalTools, "dohc_read_file").blobSha256).toEqual(properties(linkFiles, "dohc_read_file").blobSha256);
  const read = properties(personalTools, "dohc_read_channel"), linkRead = properties(linkChannel, "dohc_read_channel");
  expect([read.before, read.limit]).toEqual([linkRead.before, linkRead.limit]);
  expect(properties(personalTools, "dohc_wait_for_messages").timeoutMs).toEqual(properties(linkChannel, "dohc_wait_for_messages").timeoutMs);
});
