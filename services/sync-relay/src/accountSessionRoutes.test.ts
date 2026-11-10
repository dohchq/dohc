import { afterEach, describe, expect, it } from "vitest";
import { UnauthorizedError, type AccountSessions, type AccountSessionSummary, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import { createAccountDeletionRoute } from "./accountDeletionRoute";
import { ACCOUNT_SESSION_CLIENT_MAX_CHARS } from "./accountSessionRoutes";
import { DiscussionActivityHub } from "./discussionActivity";
import type { StorageContext } from "./storage/context";
import { claimWorkspace, closeTestStorages, denialBytes, json, testHandler, testStorage, type HandlerOverrides } from "./testing";

afterEach(closeTestStorages);

interface StoredSession extends AccountSessionSummary { userId: string; token: string }

// Better Auth's session table as these routes see it: a Bearer token signs in
// while its row exists, and the rows the store lists still carry their tokens.
function sessionTable(rows: StoredSession[]): HandlerOverrides {
  const resolveAccountSession: ResolveAccountSession = async (request) => {
    const row = rows.find(stored => `Bearer ${stored.token}` === request.headers.get("authorization"));
    if (!row) throw new UnauthorizedError();
    return { userId: row.userId, sessionId: row.sessionId, expiresAtMs: Number.MAX_SAFE_INTEGER };
  };
  const accountSessions: AccountSessions = {
    list: async (userId) => rows.filter(row => row.userId === userId),
    revoke: async ({ userId, callerSessionId, sessionId }) => {
      const index = rows.findIndex(row => row.sessionId === sessionId && row.userId === userId);
      if (index < 0 || !rows.some(row => row.sessionId === callerSessionId && row.userId === userId)) return false;
      rows.splice(index, 1);
      return true;
    },
  };
  return { resolveAccountSession, accountSessions };
}

async function relay(options: { accountApi?: boolean } = {}) {
  const rows: StoredSession[] = [
    { userId: "ana", sessionId: "ana-phone", token: "token-ana-phone", createdAtMs: 2_000, userAgent: "dohc-mobile/1 (iPhone)" },
    { userId: "ana", sessionId: "ana-desktop", token: "token-ana-desktop", createdAtMs: 1_000, userAgent: null },
    { userId: "ben", sessionId: "ben-phone", token: "token-ben-phone", createdAtMs: 1_500, userAgent: "dohc-mobile/1 (Android)" },
  ];
  const storage = await testStorage() as StorageContext;
  const activity = new DiscussionActivityHub();
  const h = testHandler(storage, { accountApi: options.accountApi ?? true, discussionActivity: activity, ...sessionTable(rows) });
  return { rows, storage, activity, h };
}

const as = (token: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
};
const list = (init: RequestInit) => new Request("http://relay.test/sync/account/sessions", init);
const revoke = (sessionId: string, init: RequestInit) =>
  new Request(`http://relay.test/sync/account/sessions/${encodeURIComponent(sessionId)}/revoke`, { ...init, method: "POST" });

describe("the account's sessions", () => {
  it("lists only the account's sessions, marks the calling one, and carries no token", async () => {
    const { h } = await relay();
    const response = await h(list(as("token-ana-phone")));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: true, sessions: [
      { sessionId: "ana-phone", createdAtMs: 2_000, client: "dohc-mobile/1 (iPhone)", current: true },
      { sessionId: "ana-desktop", createdAtMs: 1_000, client: null, current: false },
    ] });
    expect(text).not.toContain("token");
  });

  it("shows at most the first 256 characters of a client's user agent", async () => {
    const { rows, h } = await relay();
    rows[0]!.userAgent = `${"a".repeat(ACCOUNT_SESSION_CLIENT_MAX_CHARS - 1)}😀${"b".repeat(1_000)}`;
    const [phone] = (await json(await h(list(as("token-ana-phone"))))).sessions as Array<{ client: string }>;
    expect(ACCOUNT_SESSION_CLIENT_MAX_CHARS).toBe(256);
    expect(phone!.client).toBe(`${"a".repeat(ACCOUNT_SESSION_CLIENT_MAX_CHARS - 1)}😀`);
  });

  it("is not served while the account API is off", async () => {
    const { h } = await relay({ accountApi: false });
    await denialBytes(await h(list(as("token-ana-phone"))));
    await denialBytes(await h(revoke("ana-desktop", as("token-ana-phone"))));
  });

  it("refuses a request without a Bearer session, one with a cookie, and a fenced account", async () => {
    const { rows, storage, h } = await relay();
    const missing = await denialBytes(await h(list({})));
    expect(await denialBytes(await h(list({ headers: { cookie: "session=ana" } })))).toBe(missing);
    expect(await denialBytes(await h(list(as("token-ana-phone", { headers: { cookie: "session=ana" } }))))).toBe(missing);
    expect(await denialBytes(await h(revoke("ana-desktop", as("token-ana-phone", { headers: { cookie: "session=ana" } }))))).toBe(missing);
    expect((await h(list(as("token-nobody")))).status, "a sign-in it cannot validate").toBe(401);
    createAccountDeletionRoute({ storage, key: "bearer-test", fenceKey: "fence-test", invalidate() {}, deleteRuntime: async () => {} })
      .fence("ana", "ana@example.test");
    expect(await denialBytes(await h(list(as("token-ana-phone"))))).toBe(missing);
    expect(await denialBytes(await h(revoke("ana-desktop", as("token-ana-phone"))))).toBe(missing);
    expect(rows.map(row => row.sessionId)).toContain("ana-desktop");
  });

  it("answers GET for the list and POST for a revoke", async () => {
    const { h } = await relay();
    expect((await h(list({ ...as("token-ana-phone"), method: "POST" }))).status).toBe(405);
    expect((await h(new Request("http://relay.test/sync/account/sessions/ana-desktop/revoke", as("token-ana-phone")))).status).toBe(405);
  });
});

describe("revoking a session", () => {
  it("signs out another of the account's own sessions", async () => {
    const { h } = await relay();
    const response = await h(revoke("ana-desktop", as("token-ana-phone")));
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true, sessionId: "ana-desktop" });
    expect((await h(list(as("token-ana-desktop")))).status).toBe(401);
    expect((await json(await h(list(as("token-ana-phone"))))).sessions).toEqual([
      { sessionId: "ana-phone", createdAtMs: 2_000, client: "dohc-mobile/1 (iPhone)", current: true },
    ]);
  });

  it("signs out the calling session", async () => {
    const { h } = await relay();
    expect((await h(revoke("ana-phone", as("token-ana-phone")))).status).toBe(200);
    expect((await h(list(as("token-ana-phone")))).status).toBe(401);
    expect((await h(list(as("token-ana-desktop")))).status).toBe(200);
  });

  it("ends a change feed held under the revoked session at once", async () => {
    const { activity, h } = await relay();
    await claimWorkspace(h, "ana", "trip");
    const held = h(new Request("http://relay.test/sync/trip/ops/changes?since=0.0.0&hold=30000", as("token-ana-phone")));
    await expect.poll(() => activity.stats().waiters).toBe(1);
    const revokedAtMs = Date.now();
    expect((await h(revoke("ana-phone", as("token-ana-desktop")))).status).toBe(200);
    expect((await held).status).toBe(401);
    expect(Date.now() - revokedAtMs).toBeLessThan(5_000);
    expect(activity.stats().waiters).toBe(0);
  });

  it("answers another account's session, a missing one, and an impossible ID with the same bytes", async () => {
    const { rows, h } = await relay();
    const missing = await denialBytes(await h(revoke("nobody", as("token-ana-phone"))));
    expect(await denialBytes(await h(revoke("ben-phone", as("token-ana-phone"))))).toBe(missing);
    expect(await denialBytes(await h(revoke("ben phone", as("token-ana-phone"))))).toBe(missing);
    expect(await denialBytes(await h(new Request("http://relay.test/sync/account/sessions/ben-phone", { ...as("token-ana-phone"), method: "POST" })))).toBe(missing);
    expect(rows.map(row => row.sessionId)).toContain("ben-phone");
    expect((await h(list(as("token-ben-phone")))).status).toBe(200);
  });
});
