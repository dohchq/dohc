import { afterEach, describe, expect, it } from "vitest";
import { UnauthorizedError, type AccountSession, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import { createAccountDeletionRoute } from "./accountDeletionRoute";
import { isAccountWorkspacePath } from "./accountWorkspaceRoutes";
import type { StorageContext } from "./storage/context";
import { claimWorkspace, closeTestStorages, denialBytes, json, request, testHandler, testStorage } from "./testing";

afterEach(closeTestStorages);

// `Bearer session:<user>:<session>` is a valid sign-in; anything else is not.
const resolveAccountSession: ResolveAccountSession = async (request) => {
  const match = /^Bearer session:([\w-]+):([\w-]+)$/u.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new UnauthorizedError();
  return { userId: match[1]!, sessionId: match[2]!, expiresAtMs: Number.MAX_SAFE_INTEGER } satisfies AccountSession;
};

const account = (userId: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer session:${userId}:phone`);
  return { ...init, headers };
};
const list = (init: RequestInit) => new Request("http://relay.test/sync/account/workspaces", init);
const patch = (workspaceId: string, init: RequestInit, body: unknown = { showOnPhone: false }) =>
  new Request(`http://relay.test/sync/account/workspaces/${encodeURIComponent(workspaceId)}`, {
    ...init, method: "PATCH", headers: { ...Object.fromEntries(new Headers(init.headers)), "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function relay(options: { resolve?: ResolveAccountSession } = {}) {
  const storage = await testStorage() as StorageContext;
  const h = testHandler(storage, { resolveAccountSession: options.resolve ?? resolveAccountSession });
  await claimWorkspace(h, "ana", "trip");
  await claimWorkspace(h, "ana", "notes");
  await claimWorkspace(h, "ben", "budget");
  storage.claimWorkspaceIdentity({ workspaceId: "trip", replicationEpoch: "epoch", streamIdentity: "stream" });
  return { storage, h };
}

describe("the account's workspace list", () => {
  it("lists only the workspaces the account owns, whether each can open, and whether it shows on the phone", async () => {
    const { h } = await relay();
    const response = await h(list(account("ana")));
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true, workspaces: [
      { workspaceId: "notes", name: null, canOpen: false, showOnPhone: true },
      { workspaceId: "trip", name: null, canOpen: true, showOnPhone: true },
    ] });
  });

  it("names each workspace as its owner's computer last named it", async () => {
    const { h } = await relay();
    const named = await h(request("ana", "/sync/workspaces/trip/name", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Lisbon trip" }) }));
    expect(named.status).toBe(200);
    expect((await json(await h(list(account("ana"))))).workspaces).toEqual([
      { workspaceId: "notes", name: null, canOpen: false, showOnPhone: true },
      { workspaceId: "trip", name: "Lisbon trip", canOpen: true, showOnPhone: true },
    ]);
  });

  it("serves no account routes on a server without account sign-ins", async () => {
    const { storage } = await relay();
    const h = testHandler(storage);
    await denialBytes(await h(list(account("ana"))));
    await denialBytes(await h(request(null, "/sync/account/sessions", account("ana"))));
    await denialBytes(await h(request(null, "/sync/trip/ops/groups", account("ana", { method: "POST", body: "{}" }))));
  });

  it("refuses a request without a Bearer session, one with a cookie, and a fenced account", async () => {
    const { storage, h } = await relay();
    const missing = await denialBytes(await h(list({})));
    expect(await denialBytes(await h(list({ headers: { cookie: "session=ana" } })))).toBe(missing);
    expect(await denialBytes(await h(list(account("ana", { headers: { cookie: "session=ana" } }))))).toBe(missing);
    expect((await h(list({ headers: { authorization: "Bearer user:ana" } }))).status, "a sign-in it cannot validate").toBe(401);
    createAccountDeletionRoute({ storage, key: "bearer-test", fenceKey: "fence-test", invalidate() {}, deleteRuntime: async () => {} })
      .fence("ana", "ana@example.test");
    expect(await denialBytes(await h(list(account("ana"))))).toBe(missing);
  });

  it("answers only GET", async () => {
    const { h } = await relay();
    expect((await h(list({ ...account("ana"), method: "POST" }))).status).toBe(405);
  });

  it("reserves `account` as a workspace ID", async () => {
    const { h } = await relay();
    const response = await h(request("ana", "/sync/workspaces", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "account" }) }));
    expect(response.status).toBe(400);
  });

  it("classifies every spelling of its paths for the body limit", () => {
    expect(isAccountWorkspacePath("/sync/account/workspaces")).toBe(true);
    expect(isAccountWorkspacePath("//sync/%61ccount/workspaces/trip")).toBe(true);
    expect(isAccountWorkspacePath("/sync/accounts/workspaces")).toBe(false);
    expect(isAccountWorkspacePath("/sync/account/%E0")).toBe(false);
  });
});

describe("Show on phone", () => {
  it("turns off and on for a workspace the account owns", async () => {
    const { h } = await relay();
    const off = await h(patch("trip", account("ana")));
    expect(off.status).toBe(200);
    expect(await json(off)).toEqual({ ok: true, workspaceId: "trip", showOnPhone: false });
    expect((await json(await h(list(account("ana"))))).workspaces).toContainEqual({ workspaceId: "trip", name: null, canOpen: true, showOnPhone: false });
    expect((await h(patch("trip", account("ana"), { showOnPhone: true }))).status).toBe(200);
    expect((await json(await h(list(account("ana"))))).workspaces).toContainEqual({ workspaceId: "trip", name: null, canOpen: true, showOnPhone: true });
  });

  it("ends the account's reason for the server's copy when it turns off, and keeps the automations' reason", async () => {
    const { storage, h } = await relay();
    storage.joinAutomationWorkspace({ workspaceId: "trip", nowMs: 1, reasons: ["automation", "account"] });
    expect((await h(patch("trip", account("ana")))).status).toBe(200);
    expect(storage.listAutomationWorkspaces()).toMatchObject([{ workspaceId: "trip", reasons: ["automation"] }]);
  });

  it("answers another account's workspace, a missing one, and an impossible ID with the same bytes, before reading the body", async () => {
    const { storage, h } = await relay();
    const missing = await denialBytes(await h(patch("nowhere", account("ana"))));
    expect(await denialBytes(await h(patch("budget", account("ana"))))).toBe(missing);
    expect(await denialBytes(await h(patch("budget", account("ana"), "not json")))).toBe(missing);
    expect(await denialBytes(await h(patch("link", account("ana"))))).toBe(missing);
    expect(storage.showsOnPhone("ben", "budget")).toBe(true);
  });

  it("takes exactly { showOnPhone: boolean }", async () => {
    const { storage, h } = await relay();
    for (const body of [{}, { showOnPhone: "no" }, { showOnPhone: false, userId: "ben" }, [], "not json"]) {
      expect((await h(patch("trip", account("ana"), body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(storage.showsOnPhone("ana", "trip")).toBe(true);
  });

  it("refuses a cookie, and a sign-in that changed while the body arrived", async () => {
    let reads = 0;
    const { storage, h } = await relay({ resolve: async (request) => {
      const session = await resolveAccountSession(request);
      return ++reads === 2 ? { ...session, userId: "ben" } : session;
    } });
    expect((await h(patch("trip", account("ana", { headers: { cookie: "session=ana" } })))).status).toBe(404);
    expect(reads).toBe(0);
    await denialBytes(await h(patch("trip", account("ana"))));
    expect(storage.showsOnPhone("ana", "trip")).toBe(true);
  });

  it("shows a workspace that changes owner on the new owner's phone", async () => {
    const { storage, h } = await relay();
    expect((await h(patch("trip", account("ana")))).status).toBe(200);
    storage.db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'ben' WHERE workspace_id = 'trip'").run();
    expect(storage.showsOnPhone("ben", "trip")).toBe(true);
    expect((await json(await h(list(account("ben"))))).workspaces).toContainEqual({ workspaceId: "trip", name: null, canOpen: true, showOnPhone: true });
  });
});
