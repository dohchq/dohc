import {expect, it} from "vitest";
import {createAgentChatClient} from "./agentChatClient";

it("sends the access token and the MCP address with each call, over the exchange key", async () => {
  const sent: Request[] = [];
  const client = createAgentChatClient({
    relayUrl: "https://relay.example.test", exchangeKey: "exchange-key", accessToken: "token",
    resource: "https://share.example.test/mcp/s/secret",
    fetchRelay: async (request) => {sent.push(request); return Response.json({ok: true});},
  });
  const signal = new AbortController().signal;
  await client.post({body: "hello", idempotencyKey: "post-1"}, signal);
  await client.wait({cursor: 4, timeoutMs: 1_000}, signal);

  expect(sent.map(request => [request.method, request.url, request.headers.get("x-dohc-relay-exchange-key")])).toEqual([
    ["POST", "https://relay.example.test/sync/link/agent-chat/post", "exchange-key"],
    ["POST", "https://relay.example.test/sync/link/agent-chat/wait", "exchange-key"],
  ]);
  const credential = {accessToken: "token", resource: "https://share.example.test/mcp/s/secret"};
  expect(await Promise.all(sent.map(request => request.json()))).toEqual([
    {...credential, body: "hello", idempotencyKey: "post-1"},
    {...credential, cursor: 4, timeoutMs: 1_000},
  ]);
});
