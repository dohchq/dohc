import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { answerMcp, type McpAnalyticsEvent } from "./remoteMcp";
import { createShareWebApplication } from "./server";

describe("share-web analytics hooks", () => {
  it("tracks share_link_opened on successful link exchange without carrying link secrets", async () => {
    const events: Array<{ event: string; properties?: Record<string, unknown> }> = [];
    const app = createShareWebApplication({
      relayUrl: "http://relay.invalid",
      publicRelayUrl: "https://relay.example.test",
      publicHosts: new Set(["share.example.test"]),
      analytics: {
        track(event, properties) {
          events.push({ event, properties });
        },
      },
      fetchRelay: vi.fn(async () =>
        Response.json({
          ok: true,
          grantId: "grant-1",
          capabilityToken: "a".repeat(43),
          capabilityExpiresAtMs: Date.now() + 60_000,
        }),
      ),
    });

    const response = await app.handle(
      new Request("https://share.example.test/api/exchange", {
        method: "POST",
        headers: {
          host: "share.example.test",
          "content-type": "application/json",
          "x-dohc-share-web-client-ip": "198.51.100.1",
        },
        body: JSON.stringify({ secret: "s".repeat(43) }),
      }),
    );
    expect(response.status).toBe(200);
    expect(events).toEqual([{ event: "share_link_opened", properties: undefined }]);
  });

  it("reports MCP initialize, write calls, and read failures while skipping successful reads", async () => {
    const events: McpAnalyticsEvent[] = [];
    const build = () => {
      const server = new McpServer(
        { name: "test", version: "0.1.0" },
        { capabilities: { tools: {} } },
      );
      server.registerTool("dohc_list_files", { description: "read" }, async () => ({
        content: [{ type: "text", text: "{}" }],
      }));
      server.registerTool("dohc_read_file", { description: "read fail" }, async () => ({
        isError: true,
        structuredContent: { ok: false, code: "view_only" },
        content: [{ type: "text", text: "refused" }],
      }));
      server.registerTool("dohc_post_discussion", { description: "write" }, async () => ({
        content: [{ type: "text", text: "{}" }],
      }));
      return server;
    };
    const send = (body: Record<string, unknown>) =>
      answerMcp(
        new Request("https://share.example.test/mcp/test", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(body),
        }),
        body,
        build,
        AbortSignal.timeout(5_000),
        (event) => events.push(event),
      );

    await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    await send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "dohc_list_files", arguments: {} },
    });
    await send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "dohc_read_file", arguments: {} },
    });
    await send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "dohc_post_discussion", arguments: {} },
    });

    expect(events).toEqual([
      { kind: "connected" },
      { kind: "tool_invoked", outcome: "refused", write: false },
      { kind: "tool_invoked", outcome: "ok", write: true },
    ]);
  });
});
