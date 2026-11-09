import { afterEach, expect, it } from "vitest";
import { claimWorkspace, closeTestStorages, RELAY_EXCHANGE_KEY, request, testHandler, testStorage } from "./testing";

afterEach(closeTestStorages);

function rename(userId: string | null, workspaceId: string, body: unknown, headers: Record<string, string> = {}): Request {
  return request(userId, `/sync/workspaces/${encodeURIComponent(workspaceId)}/name`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function fixture() {
  const storage = await testStorage();
  const h = testHandler(storage, { relayExchangeKey: RELAY_EXCHANGE_KEY });
  await claimWorkspace(h, "owner", "workspace");
  await claimWorkspace(h, "other", "other-workspace");
  return { storage, h };
}

it("names a workspace only for its owner", async () => {
  const { storage, h } = await fixture();
  expect((await h(rename("owner", "workspace", { name: "  Trip planning " }))).status).toBe(200);
  expect(storage.listPersonalAgents("owner").workspaces).toEqual([{ workspaceId: "workspace", name: "Trip planning" }]);

  // Another account gets the bytes of a workspace that doesn't exist.
  const refused = await h(rename("other", "workspace", { name: "Taken" }));
  const missing = await h(rename("other", "no-such-workspace", { name: "Taken" }));
  expect(refused.status).toBe(404);
  expect(await refused.text()).toBe(await missing.text());
  expect(storage.listPersonalAgents("owner").workspaces).toEqual([{ workspaceId: "workspace", name: "Trip planning" }]);
  expect(storage.listPersonalAgents("other").workspaces).toEqual([{ workspaceId: "other-workspace", name: null }]);
});

it("takes only the account's bearer", async () => {
  const { storage, h } = await fixture();
  const agent = { authorization: `DohcAgent ${"a".repeat(43)}`, "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY };
  expect((await h(rename(null, "workspace", { name: "Agent" }, agent))).status).toBe(404);
  expect((await h(rename("owner", "workspace", { name: "Browser" }, { cookie: "session=owner" }))).status).toBe(404);
  expect((await h(rename(null, "workspace", { name: "Nobody" }))).status).toBe(404);
  expect(storage.listPersonalAgents("owner").workspaces).toEqual([{ workspaceId: "workspace", name: null }]);
  expect((await h(rename("owner", "workspace", { name: "Owner" }))).status).toBe(200);
});

it("refuses names a folder couldn't have", async () => {
  const { storage, h } = await fixture();
  for (const body of [
    { name: "" }, { name: "   " }, { name: "bell\u0007" }, { name: "a".repeat(256) }, { name: "\ud800" },
    { name: 7 }, { name: "Trip", extra: true }, {},
  ]) {
    expect((await h(rename("owner", "workspace", body))).status, JSON.stringify(body)).toBe(400);
  }
  expect((await h(request("owner", "/sync/workspaces/workspace/name"))).status).toBe(405);
  expect(storage.listPersonalAgents("owner").workspaces).toEqual([{ workspaceId: "workspace", name: null }]);

  // The limit counts characters, as the column's check does.
  const emoji = "😀".repeat(255);
  expect((await h(rename("owner", "workspace", { name: emoji }))).status).toBe(200);
  expect(storage.listPersonalAgents("owner").workspaces).toEqual([{ workspaceId: "workspace", name: emoji }]);
});
