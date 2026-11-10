import { describe, expect, it } from "vitest";
import { changeAgent, endSession, listAgents, setShowOnPhone } from "./api";
import { createServerClient, ServerError } from "./client";
import { testServer } from "./testServer";

function client(server: ReturnType<typeof testServer>) {
  return createServerClient({ origin: server.origin, token: "tok", fetch: server.fetch, signal: new AbortController().signal });
}

const agent = (name: string) => ({ agentId: "p-1", name, hue: "olive", status: "active", reportedProduct: null, reach: [] });

describe("the account routes", () => {
  it("never send an ID that is empty or steps out of its path", async () => {
    const server = testServer();
    for (const id of ["", ".", ".."]) {
      await expect(endSession(client(server), id)).rejects.toEqual(new ServerError("invalid"));
      await expect(setShowOnPhone(client(server), id, false)).rejects.toEqual(new ServerError("invalid"));
      await expect(changeAgent(client(server), id, "sign-out")).rejects.toEqual(new ServerError("invalid"));
    }
    expect(server.calls).toHaveLength(0);
  });

  it("encode an ID as one segment", async () => {
    const server = testServer();
    server.on("POST", "/sync/account/sessions/a%2F..%2Fb/revoke", { status: 200, body: { ok: true } });
    await endSession(client(server), "a/../b");
    expect(server.paths()).toEqual(["POST /sync/account/sessions/a%2F..%2Fb/revoke"]);
  });

  it("take an agent name of up to 256 characters", async () => {
    const server = testServer();
    server.on("GET", "/sync/personal-agents",
      { status: 200, body: { ok: true, revision: 1, agents: [agent("a".repeat(256))], workspaces: [] } },
      { status: 200, body: { ok: true, revision: 2, agents: [agent("a".repeat(257))], workspaces: [] } });
    expect((await listAgents(client(server))).agents[0]!.name).toHaveLength(256);
    await expect(listAgents(client(server))).rejects.toEqual(new ServerError("invalid", 200));
  });
});
