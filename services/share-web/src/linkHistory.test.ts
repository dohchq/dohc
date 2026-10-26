import { afterEach, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createShareWebApplication } from "./server";
import {
  appendLog,
  closeTestStorages,
  json,
  jsonBody,
  linkSecret,
  moment,
  putBlob,
  request,
  testHandler,
  testStorage,
} from "../../sync-relay/src/testing";

const host = "share.example.test",
  origin = `https://${host}`;
const owner = "history-owner@dohc.test",
  reader = "history-reader@dohc.test",
  workspace = "history-web";
afterEach(closeTestStorages);

it.each(["view", "comment"] as const)(
  "enforces current-only %s through the browser proxy and a real MCP client",
  async (access) => {
    const storage = await testStorage();
    const relay = testHandler(storage);
    expect(
      (
        await relay(
          request(
            owner,
            "/sync/workspaces",
            jsonBody({ workspaceId: workspace }),
          ),
        )
      ).status,
    ).toBe(200);
    const old = await putBlob(relay, owner, workspace, "old body");
    const current = await putBlob(relay, owner, workspace, "current body");
    await appendLog(relay, owner, workspace, [
      {
        originSeq: 0,
        opKind: "version.create",
        recordedAtMs: 1000,
        payload: {
          versionId: "main",
          forkSnapshots: [{ path: "doc.md", objectId: "doc", blobSha256: old }],
        },
      },
      moment("doc.md", "current body", {
        originSeq: 1,
        recordedAtMs: 2000,
        objectId: "doc",
        beforePath: "doc.md",
        beforeContent: "old body",
      }),
    ]);
    const share = await json(
      await relay(
        request(
          owner,
          `/sync/${workspace}/shares`,
          jsonBody({ recipientUserId: reader, paths: ["doc.md"], access }),
        ),
      ),
    );
    const link = await json(
      await relay(
        request(
          owner,
          `/sync/${workspace}/shares/${share.shareId}/links`,
          jsonBody({ access }),
        ),
      ),
    );
    const secret = linkSecret(link.url);
    const app = createShareWebApplication({
      relayUrl: "https://relay.example.test",
      publicRelayUrl: "https://relay.example.test",
      publicHosts: new Set([host]),
      nowMs: () => 2000,
      fetchRelay: relay,
    });
    const send = (path: string, init: RequestInit = {}) =>
      app.handle(
        new Request(origin + path, {
          ...init,
          headers: { host, ...init.headers },
        }),
      );
    const exchange = await send("/api/exchange", jsonBody({ secret }));
    expect(exchange.status).toBe(200);
    const session = String((await json(exchange)).session);
    const cookies = exchange.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const browser = (path: string) =>
      send(path, {
        headers: { cookie: cookies, "x-dohc-link-session": session },
      });
    expect((await browser(`/api/view/blob/${old}`)).status).toBe(404);
    expect((await browser("/api/view/log?since=0")).status).toBe(404);
    expect((await json(await browser("/api/view/current"))).files).toEqual([
      expect.objectContaining({ blobSha256: current }),
    ]);
    expect(await (await browser(`/api/view/blob/${current}`)).text()).toBe(
      "current body",
    );
    const changes = await json(
      await browser("/api/view/log?since=0&current=true"),
    );
    expect(JSON.stringify(changes)).not.toMatch(
      /forkSnapshots|payloadBefore|old body/,
    );
    expect(JSON.stringify(changes)).not.toContain(old);

    const bearer = String(
      (await json(await send("/api/mcp/exchange", jsonBody({ secret }))))
        .bearer,
    );
    const client = new Client({ name: "history-agent", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
          requestInit: { headers: { authorization: `Bearer ${bearer}` } },
          fetch: async (input, init) => {
            const request = new Request(input, init);
            request.headers.set("host", host);
            return app.handle(request);
          },
        }),
      );
      expect(
        (await client.listTools()).tools.map((tool) => tool.name),
      ).not.toContain("dohc_list_changes");
      await expect(
        client.callTool({ name: "dohc_list_changes", arguments: { since: 0 } }),
      ).rejects.toThrow("not found");
      expect(
        await client.callTool({
          name: "dohc_read_file",
          arguments: { blobSha256: old },
        }),
      ).toMatchObject({ isError: true });
      expect(
        await client.callTool({
          name: "dohc_read_file",
          arguments: { blobSha256: current },
        }),
      ).toMatchObject({ structuredContent: { content: "current body" } });
    } finally {
      await client.close();
    }
  },
);
