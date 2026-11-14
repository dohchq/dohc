import { expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { servePersonalMcp } from "./personalMcp";
import personalTools from "./personalMcpTools.main.json";
import linkTools from "./remoteMcpTools.main.json";
import { selfHostLiveProfile } from "../../sync-relay/src/selfHostLiveProfile";

type Tool = { name: string; inputSchema: unknown };

const unexpected = () => {
  throw new Error("Unexpected inventory call.");
};

// Exercises the personal server's registration and HTTP transport. No tool
// runs: the only relay answer is the reach check that starts each request.
// The main inventory is a server that edits documents live.
async function advertisedPersonalTools(live = true): Promise<Tool[]> {
  const client = new Client({ name: "main-inventory", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://share.example.test/mcp/agent/w/trip"), {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const result = await servePersonalMcp(request, {
            signal: request.signal,
            deadlineAtMs: Date.now() + 30_000,
            admitLargeBody: () => () => {},
            ...(live
              ? {
                  live: {
                    client: { document: unexpected, ticket: unexpected, open: unexpected },
                    limits: selfHostLiveProfile().editor,
                  },
                }
              : {}),
            client: {
              call: async (action) => {
                if (action !== "workspaces")
                  throw new Error(`Unexpected inventory call: ${action}`);
                return Response.json({
                  ok: true,
                  agent: { agentId: "agent", name: "Helper", handle: "Helper" },
                  workspaces: [
                    { workspaceId: "trip", name: "Trip", level: "view", dmChannelWireId: "dm" },
                  ],
                });
              },
            },
          });
          if (!result) throw new Error("The reach check refused the inventory's token.");
          return new Response(result.body, { status: result.status, headers: result.headers });
        },
      }),
    );
    return (await client.listTools()).tools
      .map(({ name, inputSchema }) => ({ name, inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await client.close();
  }
}

const properties = (tools: readonly Tool[], name: string) =>
  (tools.find((tool) => tool.name === name)!.inputSchema as { properties: Record<string, unknown> })
    .properties;

it("preserves main personal agent MCP names and input schemas", async () => {
  // Every level sees every tool: reach is per workspace, so the relay refuses a post at View.
  expect(await advertisedPersonalTools()).toEqual(personalTools);
});

it("lists the live document tools only where share-web edits documents live", async () => {
  expect(await advertisedPersonalTools(false)).toEqual(
    personalTools.filter((tool) => !tool.name.endsWith("_document")),
  );
});

it("takes a Comment thread's id in the same shape to read it and to reply in it", () => {
  const shape = (schema: unknown) => ({
    ...(schema as Record<string, unknown>),
    description: undefined,
  });
  expect(shape(properties(personalTools, "dohc_read_discussion").threadId)).toEqual(
    shape(properties(personalTools, "dohc_post_discussion").threadId),
  );
});

it("takes the share link tools' inputs where they mean the same thing", () => {
  const linkFiles = linkTools["comment/current/without-live"],
    linkChannel = linkTools["group-channel"];
  const { workspace, ...write } = properties(personalTools, "dohc_write_collection_files");
  expect(write).toEqual(
    properties(linkTools["edit/current/without-live"], "dohc_write_collection_files"),
  );
  expect(workspace).toEqual(properties(personalTools, "dohc_list_files").workspace);
  for (const name of ["dohc_post_channel", "dohc_post_discussion"]) {
    const post = properties(personalTools, name);
    expect([post.body, post.idempotencyKey], name).toEqual([
      properties(linkChannel, "dohc_post_group").body,
      properties(linkChannel, "dohc_post_group").idempotencyKey,
    ]);
  }
  for (const name of ["dohc_read_document", "dohc_edit_document"]) {
    const { workspace: liveWorkspace, ...input } = properties(personalTools, name);
    expect(input, name).toEqual(properties(linkTools["edit/current/live"], name));
    expect(liveWorkspace, name).toEqual(properties(personalTools, "dohc_list_files").workspace);
  }
  expect(properties(personalTools, "dohc_read_file").blobSha256).toEqual(
    properties(linkFiles, "dohc_read_file").blobSha256,
  );
  const read = properties(personalTools, "dohc_read_channel"),
    linkRead = properties(linkChannel, "dohc_read_group");
  expect([read.before, read.limit]).toEqual([linkRead.before, linkRead.limit]);
  expect(properties(personalTools, "dohc_wait_for_messages").timeoutMs).toEqual(
    properties(linkChannel, "dohc_wait_for_messages").timeoutMs,
  );
});
