import { describe, expect, it, vi } from "vitest";
import { createAccount, type Account, type StoredSignIn } from "./account";
import { listWorkspaces } from "./api";
import { ServerError } from "./client";
import { deferred, memoryStore, testServer, type Answer } from "./testServer";

const SAVED: StoredSignIn = {
  origin: "https://dohc.example.com",
  token: "tok-1",
  userId: "u-1",
  email: "ice@example.com",
};
const WORKSPACES = { status: 200, body: { ok: true, workspaces: [] } };
const SESSIONS = {
  status: 200,
  body: {
    ok: true,
    sessions: [
      { sessionId: "s-other", createdAtMs: 1, client: "Mac", current: false },
      { sessionId: "s-phone", createdAtMs: 2, client: "iPhone", current: true },
    ],
  },
};

function setup(saved: StoredSignIn | null = SAVED) {
  const server = testServer();
  const tokens = memoryStore(saved);
  const account = createAccount({
    store: tokens.store,
    fetch: server.fetch,
    sleep: async () => {},
  });
  return { server, tokens, account };
}

function signedIn(account: Account) {
  const state = account.state();
  if (state.status !== "signed-in") throw new Error(`expected signed-in, got ${state.status}`);
  return state.signIn;
}

function serveSignIn(
  server: ReturnType<typeof testServer>,
  account: Answer = {
    status: 200,
    body: { session: {}, user: { id: "u-2", email: "sam@example.com" } },
  },
) {
  server.on("POST", "/api/auth/device/code", {
    status: 200,
    body: { device_code: "d", user_code: "CODE1234", expires_in: 600, interval: 3 },
  });
  server.on("POST", "/api/auth/device/token", { status: 200, body: { access_token: "tok-2" } });
  server.on("GET", "/api/auth/get-session", account);
}

describe("restoring", () => {
  it("signs in with the saved token, or shows signed out without one", async () => {
    const { account } = setup();
    await account.restore();
    expect(signedIn(account)).toMatchObject({ origin: SAVED.origin, email: SAVED.email });
    const empty = setup(null);
    await empty.account.restore();
    expect(empty.account.state()).toEqual({
      status: "signed-out",
      origin: null,
      ended: false,
      forgetFailed: false,
    });
  });
});

describe("signing in", () => {
  it("saves the token with its server and account, then signs in", async () => {
    const { server, tokens, account } = setup(null);
    await account.restore();
    serveSignIn(server);
    const onCode = vi.fn();
    expect(await account.signIn(server.origin, onCode)).toBe("signed-in");
    expect(onCode).toHaveBeenCalledWith({
      userCode: "CODE1234",
      approvalUrl: "https://dohc.example.com/device?user_code=CODE1234",
    });
    expect(tokens.current()).toEqual({
      origin: server.origin,
      token: "tok-2",
      userId: "u-2",
      email: "sam@example.com",
    });
    expect(signedIn(account).email).toBe("sam@example.com");
  });

  it("supersedes an earlier sign-in: its requests abort, and it saves nothing", async () => {
    const { server, tokens, account } = setup(null);
    await account.restore();
    const held = deferred<Answer>();
    serveSignIn(server);
    server.on("GET", "/api/auth/get-session", () => held.promise);
    const first = account.signIn(server.origin, () => {});
    await vi.waitFor(() => expect(server.paths()).toContain("GET /api/auth/get-session"));
    const session = server.calls.find((call) => call.path === "/api/auth/get-session")!;
    account.cancelSignIn();
    expect(session.signal.aborted).toBe(true);
    held.resolve({ status: 200, body: { user: { id: "u-2", email: "sam@example.com" } } });
    expect(await first).toBe("cancelled");
    expect(tokens.log).not.toContain("save");
    expect(account.state()).toMatchObject({ status: "signed-out" });
  });

  it("deletes a token whose save raced a cancel, and ends its session", async () => {
    const { server, tokens, account } = setup(null);
    await account.restore();
    serveSignIn(server);
    server.on("GET", "/sync/account/sessions", SESSIONS);
    server.on("POST", "/sync/account/sessions/s-phone/revoke", {
      status: 200,
      body: { ok: true, sessionId: "s-phone" },
    });
    const release = tokens.holdSaves();
    const signing = account.signIn(server.origin, () => {});
    await vi.waitFor(() => expect(tokens.log).toEqual(["save"]));
    account.cancelSignIn();
    release();
    expect(await signing).toBe("cancelled");
    await vi.waitFor(() => expect(tokens.log).toEqual(["save", "clear"]));
    expect(tokens.current()).toBeNull();
    expect(server.paths()).toContain("POST /sync/account/sessions/s-phone/revoke");
    expect(account.state()).toMatchObject({ status: "signed-out" });
  });

  it("ends the session of a token that arrives after a cancel", async () => {
    const { server, tokens, account } = setup(null);
    await account.restore();
    serveSignIn(server);
    const held = deferred<Answer>();
    server.on("POST", "/api/auth/device/token", () => held.promise);
    server.on("GET", "/sync/account/sessions", SESSIONS);
    server.on("POST", "/sync/account/sessions/s-phone/revoke", {
      status: 200,
      body: { ok: true, sessionId: "s-phone" },
    });
    const signing = account.signIn(server.origin, () => {});
    await vi.waitFor(() => expect(server.paths()).toContain("POST /api/auth/device/token"));
    account.cancelSignIn();
    held.resolve({ status: 200, body: { access_token: "tok-late" } });
    expect(await signing).toBe("cancelled");
    await vi.waitFor(() =>
      expect(server.paths()).toContain("POST /sync/account/sessions/s-phone/revoke"),
    );
    expect(server.calls.at(-1)!.headers.authorization).toBe("Bearer tok-late");
    expect(tokens.log).not.toContain("save");
  });
});

describe("the sign-in generation", () => {
  it("aborts requests in flight at sign-out, and a late answer changes nothing", async () => {
    const { server, tokens, account } = setup();
    await account.restore();
    const signIn = signedIn(account);
    const held = deferred<Answer>();
    server.on("GET", "/sync/account/workspaces", () => held.promise);
    server.on("GET", "/sync/account/sessions", "offline");
    const listing = listWorkspaces(signIn.client);
    await vi.waitFor(() => expect(server.calls).toHaveLength(1));
    const signingOut = account.signOut();
    expect(signIn.isCurrent()).toBe(false);
    expect(server.calls[0]!.signal.aborted).toBe(true);
    expect(account.state()).toEqual({
      status: "signed-out",
      origin: SAVED.origin,
      ended: false,
      forgetFailed: false,
    });
    held.resolve(WORKSPACES);
    await expect(listing).rejects.toEqual(new ServerError("cancelled"));
    await signingOut;
    expect(tokens.current()).toBeNull();
    expect(account.state()).toMatchObject({ status: "signed-out" });
  });

  it("signs out on a 401, without revoking, and deletes the token", async () => {
    const { server, tokens, account } = setup();
    await account.restore();
    server.on("GET", "/sync/account/workspaces", {
      status: 401,
      body: { ok: false, code: "unauthorized" },
    });
    await expect(listWorkspaces(signedIn(account).client)).rejects.toEqual(
      new ServerError("signed-out", 401, "unauthorized"),
    );
    expect(account.state()).toEqual({
      status: "signed-out",
      origin: SAVED.origin,
      ended: true,
      forgetFailed: false,
    });
    await vi.waitFor(() => expect(tokens.current()).toBeNull());
    expect(server.paths()).toEqual(["GET /sync/account/workspaces"]);
  });

  it("ignores a late 401 from an earlier sign-in", async () => {
    const { server, tokens, account } = setup();
    await account.restore();
    const earlier = signedIn(account);
    server.on("GET", "/sync/account/sessions", "offline");
    await account.signOut();
    serveSignIn(server);
    await account.signIn(server.origin, () => {});
    server.on("GET", "/sync/account/workspaces", { status: 401 });
    await expect(listWorkspaces(earlier.client)).rejects.toEqual(new ServerError("cancelled"));
    expect(signedIn(account).email).toBe("sam@example.com");
    expect(tokens.current()?.token).toBe("tok-2");
  });
});

describe("signing out", () => {
  it("runs the outbox's delete before the token goes, also from a session the server ended, and never at a 401 or launch", async () => {
    const server = testServer();
    const tokens = memoryStore(SAVED);
    const order: string[] = [];
    const account = createAccount({
      store: tokens.store,
      fetch: server.fetch,
      onSignOut: async () => {
        order.push(tokens.current() ? "outbox, token kept" : "outbox, token gone");
      },
    });
    await account.restore();
    server.on("GET", "/sync/account/sessions", "offline");
    await account.signOut();
    expect(order).toEqual(["outbox, token kept"]);
    expect(tokens.current()).toBeNull();

    // A 401 ends the session without Sign out; Sign out after it still deletes the outbox.
    const ended = setup();
    const cleaned = vi.fn(async () => {});
    const endedAccount = createAccount({
      store: ended.tokens.store,
      fetch: ended.server.fetch,
      onSignOut: cleaned,
    });
    await endedAccount.restore();
    ended.server.on("GET", "/sync/account/workspaces", { status: 401 });
    await expect(listWorkspaces(signedIn(endedAccount).client)).rejects.toEqual(
      new ServerError("signed-out", 401),
    );
    expect(cleaned).not.toHaveBeenCalled();
    await endedAccount.signOut();
    expect(cleaned).toHaveBeenCalledTimes(1);

    // A launch with nothing saved shows signed out without running it.
    const empty = vi.fn(async () => {});
    const launched = createAccount({
      store: memoryStore(null).store,
      fetch: server.fetch,
      onSignOut: empty,
    });
    await launched.restore();
    expect(empty).not.toHaveBeenCalled();
  });

  it("ends the sign-in only when the hook calls leave, and keeps it, with its token, when the hook rejects first", async () => {
    const server = testServer();
    server.on("GET", "/sync/account/sessions", "offline");
    const tokens = memoryStore(SAVED);
    const failing = createAccount({
      store: tokens.store,
      fetch: server.fetch,
      onSignOut: async () => {
        throw new Error("couldn't delete");
      },
    });
    await failing.restore();
    const earlier = signedIn(failing);
    await expect(failing.signOut()).rejects.toThrow("couldn't delete");
    expect(signedIn(failing)).toBe(earlier);
    expect(earlier.isCurrent()).toBe(true);
    expect(tokens.current()).toEqual(SAVED);
    expect(server.calls).toHaveLength(0);

    const seen: string[] = [];
    const leaving = createAccount({
      store: tokens.store,
      fetch: server.fetch,
      onSignOut: async (leave) => {
        seen.push(leaving.state().status);
        await leave();
        seen.push(`${leaving.state().status}, token ${tokens.current() ? "kept" : "gone"}`);
        // A failure after leave is the hook's own to finish: Sign out still completes.
        throw new Error("delete continues at wake");
      },
    });
    await leaving.restore();
    await expect(leaving.signOut()).resolves.toBeUndefined();
    expect(seen).toEqual(["signed-in", "signed-out, token gone"]);
  });

  it("shares one cleanup between overlapping sign-outs of the same sign-in", async () => {
    const { server, tokens } = setup();
    server.on("GET", "/sync/account/sessions", "offline");
    const cleanup = deferred<void>();
    const cleaned = vi.fn(async (leave: () => Promise<void>) => {
      await cleanup.promise;
      await leave();
    });
    const account = createAccount({ store: tokens.store, fetch: server.fetch, onSignOut: cleaned });
    await account.restore();
    const first = account.signOut();
    const second = account.signOut();
    cleanup.resolve();
    await Promise.all([first, second]);
    expect(cleaned).toHaveBeenCalledTimes(1);
    expect(tokens.current()).toBeNull();
    expect(account.state()).toMatchObject({ status: "signed-out" });
  });

  it("ends a newer sign-in even while an earlier sign-out still waits on its revoke", async () => {
    const { server, tokens } = setup();
    const revoking = deferred<Answer>();
    // Only the first sign-out's revoke is held; a later one finds the server offline.
    let sessionsAsked = 0;
    server.on("GET", "/sync/account/sessions", () =>
      sessionsAsked++ === 0 ? revoking.promise : "offline",
    );
    const cleaned = vi.fn(async (leave: () => Promise<void>) => {
      await leave();
    });
    const account = createAccount({
      store: tokens.store,
      fetch: server.fetch,
      sleep: async () => {},
      onSignOut: cleaned,
    });
    await account.restore();
    const earlier = account.signOut();
    // The first sign-out has left, and now waits on the server to revoke tok-1.
    await vi.waitFor(() => expect(server.paths()).toContain("GET /sync/account/sessions"));
    expect(account.state()).toMatchObject({ status: "signed-out" });
    serveSignIn(server);
    expect(await account.signIn(server.origin, () => {})).toBe("signed-in");
    expect(tokens.current()?.token).toBe("tok-2");
    // Signing out again ends tok-2's sign-in with its own cleanup, not the old attempt's.
    await account.signOut();
    expect(cleaned).toHaveBeenCalledTimes(2);
    expect(tokens.current()).toBeNull();
    expect(account.state()).toMatchObject({ status: "signed-out" });
    revoking.resolve({ status: 200, body: { ok: true, sessions: [] } });
    await earlier;
    expect(account.state()).toMatchObject({ status: "signed-out" });
  });

  it("refuses to sign in again while signed in, keeping the sign-in and the outbox", async () => {
    const { server, tokens } = setup();
    const cleaned = vi.fn(async () => {});
    const guarded = createAccount({ store: tokens.store, fetch: server.fetch, onSignOut: cleaned });
    await guarded.restore();
    await expect(guarded.signIn(server.origin, () => {})).rejects.toThrow(
      "This phone is already signed in.",
    );
    expect(signedIn(guarded).email).toBe(SAVED.email);
    expect(tokens.current()).toEqual(SAVED);
    expect(cleaned).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(0);
  });

  it("deletes the token first, then revokes this phone's session with the copy in memory", async () => {
    const { server, tokens, account } = setup();
    await account.restore();
    server.on("GET", "/sync/account/sessions", () => {
      // If the phone closed here, no token would be left in its store.
      expect(tokens.current()).toBeNull();
      return SESSIONS;
    });
    server.on("POST", "/sync/account/sessions/s-phone/revoke", {
      status: 200,
      body: { ok: true, sessionId: "s-phone" },
    });
    await account.signOut();
    expect(tokens.log).toEqual(["clear"]);
    expect(server.paths()).toEqual([
      "GET /sync/account/sessions",
      "POST /sync/account/sessions/s-phone/revoke",
    ]);
    expect(server.calls[1]!.headers.authorization).toBe("Bearer tok-1");
    expect(account.state()).toEqual({
      status: "signed-out",
      origin: SAVED.origin,
      ended: false,
      forgetFailed: false,
    });
  });

  it("deletes the token when the server can't be reached, or the revoke fails", async () => {
    const offline = setup();
    await offline.account.restore();
    offline.server.on("GET", "/sync/account/sessions", "offline");
    await offline.account.signOut();
    expect(offline.tokens.current()).toBeNull();

    const refused = setup();
    await refused.account.restore();
    refused.server.on("GET", "/sync/account/sessions", SESSIONS);
    refused.server.on("POST", "/sync/account/sessions/s-phone/revoke", "offline");
    await refused.account.signOut();
    expect(refused.tokens.current()).toBeNull();
  });

  it("shows a failed delete, still revokes, and never signs in with that token again", async () => {
    const { server, tokens, account } = setup();
    await account.restore();
    server.on("GET", "/sync/account/sessions", SESSIONS);
    server.on("POST", "/sync/account/sessions/s-phone/revoke", {
      status: 200,
      body: { ok: true, sessionId: "s-phone" },
    });
    tokens.failClears(1);
    await expect(account.signOut()).resolves.toBeUndefined();
    expect(account.state()).toEqual({
      status: "signed-out",
      origin: SAVED.origin,
      ended: false,
      forgetFailed: true,
    });
    expect(tokens.current()).toEqual(SAVED);
    expect(server.paths()).toContain("POST /sync/account/sessions/s-phone/revoke");
    await account.restore();
    expect(account.state()).toMatchObject({ status: "signed-out", forgetFailed: true });

    await account.retryForget();
    expect(account.state()).toMatchObject({ status: "signed-out", forgetFailed: false });
    expect(tokens.current()).toBeNull();
    const relaunched = createAccount({ store: tokens.store, fetch: server.fetch });
    await relaunched.restore();
    expect(relaunched.state()).toMatchObject({ status: "signed-out" });
  });

  it("signs out at once during a held restore, and deletes the token the restore found", async () => {
    const { server, tokens, account } = setup();
    server.on("GET", "/sync/account/sessions", "offline");
    const release = tokens.holdLoads();
    const restoring = account.restore();
    const signingOut = account.signOut();
    expect(account.state()).toMatchObject({ status: "signed-out" });
    release();
    await restoring;
    await signingOut;
    expect(account.state()).toMatchObject({ status: "signed-out" });
    await vi.waitFor(() => expect(tokens.current()).toBeNull());
  });

  it("signs out at once during a held token save, and deletes what the save wrote", async () => {
    const { server, tokens, account } = setup(null);
    await account.restore();
    serveSignIn(server);
    server.on("GET", "/sync/account/sessions", "offline");
    const release = tokens.holdSaves();
    const signing = account.signIn(server.origin, () => {});
    await vi.waitFor(() => expect(tokens.log).toEqual(["save"]));
    void account.signOut();
    expect(account.state()).toMatchObject({ status: "signed-out" });
    release();
    expect(await signing).toBe("cancelled");
    await vi.waitFor(() => expect(tokens.current()).toBeNull());
    expect(account.state()).toMatchObject({ status: "signed-out" });
  });
});
