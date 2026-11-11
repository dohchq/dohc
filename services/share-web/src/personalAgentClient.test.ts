import {expect, it} from "vitest";
import {createPersonalAgentClient} from "./personalAgentClient";

it("names a write's workspace ahead of its body, and no other call's", async () => {
  const sent: Request[] = [];
  const client = createPersonalAgentClient({
    relayUrl: "https://relay.example.test", exchangeKey: "exchange-key", accessToken: "access-token",
    resource: "https://share.example.test/mcp/agent/w/trip",
    fetchRelay: async request => {sent.push(request); return Response.json({ok: true});},
  });
  const signal = new AbortController().signal;
  await client.call("collection-writes", {workspaceId: "Trip to Porto", submitId: "write-1", changes: []}, signal);
  await client.call("files", {workspaceId: "Trip to Porto"}, signal);
  expect(sent.map(request => request.headers.get("x-dohc-agent-workspace"))).toEqual(["Trip%20to%20Porto", null]);
});
