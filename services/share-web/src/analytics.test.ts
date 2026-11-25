import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { createAppLaunchHandler } from "./appLaunch";
import { answerMcp, serveRemoteMcp, type McpAnalyticsEvent } from "./remoteMcp";
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

  it("ignores failed initialize and unexecuted notifications, and classifies collection/automation outcomes", async () => {
    const events: McpAnalyticsEvent[] = [];
    const build = () => {
      const server = new McpServer(
        { name: "test", version: "0.1.0" },
        { capabilities: { tools: {} } },
      );
      server.registerTool("dohc_post_discussion", { description: "write" }, async () => ({
        content: [{ type: "text", text: "{}" }],
      }));
      server.registerTool("dohc_write_collection_files", { description: "write" }, async () => ({
        isError: true,
        structuredContent: { ok: false, outcome: "refused", reason: "nope" },
        content: [{ type: "text", text: "{}" }],
      }));
      server.registerTool("dohc_switch_automation", { description: "switch" }, async () => ({
        structuredContent: { ok: true, result: { status: "refused-write", reason: "nope" } },
        content: [{ type: "text", text: "{}" }],
      }));
      return server;
    };
    const send = (body: unknown) =>
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
      params: {},
    });
    const notifyResponse = await send({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "dohc_post_discussion", arguments: {} },
    });
    expect(notifyResponse.status).toBe(202);

    await send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "dohc_write_collection_files", arguments: {} },
    });
    await send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "dohc_switch_automation", arguments: {} },
    });

    expect(events).toEqual([
      { kind: "tool_invoked", outcome: "refused", write: true },
      { kind: "tool_invoked", outcome: "refused", write: true },
    ]);
  });

  it("reports batched write refusals in serveRemoteMcp", async () => {
    const events: McpAnalyticsEvent[] = [];
    const batch = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "dohc_switch_automation", arguments: {} },
      },
    ];
    const response = await serveRemoteMcp(
      new Request("https://share.example.test/mcp/s/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
      }),
      {
        request: vi.fn(async () =>
          Response.json({
            ok: true,
            access: "edit",
            effectiveSelector: { versionId: null, paths: ["col"] },
          }),
        ),
        admitLargeBody: () => () => {},
        signal: AbortSignal.timeout(5_000),
        deadlineAtMs: Date.now() + 30_000,
        agentChat: {
          read: vi.fn(),
          post: vi.fn(),
          wait: vi.fn(),
        } as unknown as Parameters<typeof serveRemoteMcp>[1]["agentChat"],
        onAnalyticsEvent: (event) => events.push(event),
      },
    );

    expect(response.status).toBe(200);
    expect(events).toEqual([{ kind: "tool_invoked", outcome: "refused", write: true }]);
  });

  it("emits published_app_launched only when /bootstrap POST succeeds and not on handoff, failure, or reload", async () => {
    const launched: Array<"link" | "named"> = [];
    const publicationId = "a".repeat(64);
    const bundleBytes = Buffer.from("console.log('ok');");
    const file = {
      path: "bundle.js",
      sha256: createHash("sha256").update(bundleBytes).digest("hex"),
      byteLength: bundleBytes.length,
      contentType: "text/javascript; charset=utf-8",
    };
    let failBundle = true;
    const handler = createAppLaunchHandler({
      config: { viewerOrigin: "https://viewer.example.com", appDomain: "example.net" },
      relayUrl: "https://relay.example.org",
      onLaunched: (kind) => launched.push(kind),
      resolveMaterial: async () => ({
        ok: true,
        capabilityToken: "server-capability",
        profileSecret: "server-profile",
        setCookie: null,
        currentCapability: async () => "server-capability",
      }),
      fetchRelay: async (request) => {
        if (new URL(request.url).pathname.endsWith(`/blobs/${file.sha256}`)) {
          return failBundle
            ? new Response(null, { status: 500 })
            : new Response(bundleBytes, { headers: { "content-type": file.contentType } });
        }
        return Response.json({ publicationId, authorityRevision: 1, files: [file] });
      },
    });
    const post = (url: string, body: string, headers: Record<string, string>) =>
      handler.handle(
        new Request(url, {
          method: "POST",
          body,
          headers: { host: new URL(url).host, ...headers },
        }),
      );

    const firstIssued = await post(
      "https://viewer.example.com/api/apps/launch",
      JSON.stringify({ discriminator: "abcdefghijkl", publicationId }),
      {
        origin: "https://viewer.example.com",
        "content-type": "application/json",
        cookie: "viewer=session",
      },
    );
    expect(firstIssued.status).toBe(200);
    expect(launched).toEqual([]);
    const firstHandoff = (await firstIssued.json()) as { action: string; handoff: string };
    const failedRedeem = await post(
      firstHandoff.action,
      new URLSearchParams({ handoff: firstHandoff.handoff }).toString(),
      {
        origin: "https://viewer.example.com",
        "content-type": "application/x-www-form-urlencoded",
      },
    );
    expect(failedRedeem.status).not.toBe(200);
    expect(launched).toEqual([]);

    failBundle = false;
    const secondIssued = await post(
      "https://viewer.example.com/api/apps/launch",
      JSON.stringify({ discriminator: "abcdefghijkl", publicationId }),
      {
        origin: "https://viewer.example.com",
        "content-type": "application/json",
        cookie: "viewer=session",
      },
    );
    const secondHandoff = (await secondIssued.json()) as { action: string; handoff: string };
    const okRedeem = await post(
      secondHandoff.action,
      new URLSearchParams({ handoff: secondHandoff.handoff }).toString(),
      {
        origin: "https://viewer.example.com",
        "content-type": "application/x-www-form-urlencoded",
      },
    );
    expect(okRedeem.status).toBe(200);
    expect(launched).toEqual(["link"]);

    const cookie = okRedeem.headers.get("set-cookie")!.split(";")[0]!;
    const reload = await handler.handle(
      new Request(secondHandoff.action, {
        method: "GET",
        headers: { host: new URL(secondHandoff.action).host, cookie },
      }),
    );
    expect(reload.status).toBe(200);
    expect(launched).toEqual(["link"]);
  });
});
