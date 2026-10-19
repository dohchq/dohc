import { describe, expect, it, vi } from "vitest";
import type { CloudCredentials, DeletedAccount } from "./cloudCredentialStore";
import {
  adoptCompletedCloudLoginSession,
  runCloudLogoutTransition,
  createCloudLogin,
  type CloudLoginStore,
  type InvalidSessionMarker,
} from "./cloudLogin";
import { deferred } from "../testing/deferred";

function memoryStore(): CloudLoginStore & {
  saved: CloudCredentials | null;
  invalidMarker: InvalidSessionMarker | null;
  deletedAccounts: DeletedAccount[];
} {
  const box = {
    saved: null as CloudCredentials | null,
    invalidMarker: null as InvalidSessionMarker | null,
    deletedAccounts: [] as DeletedAccount[],
    async loadDeletedAccounts() {
      return box.deletedAccounts;
    },
    async saveDeletedAccounts(accounts: DeletedAccount[]) {
      box.deletedAccounts = accounts;
    },
    async load() {
      return box.saved;
    },
    async save(credentials: CloudCredentials) {
      box.saved = credentials;
    },
    async clear() {
      box.saved = null;
    },
    async loadInvalidMarker() {
      return box.invalidMarker;
    },
    async saveInvalidMarker(marker: InvalidSessionMarker) {
      box.invalidMarker = marker;
    },
    async clearInvalidMarker() {
      box.invalidMarker = null;
    },
  };
  return box;
}

type Route = (init?: RequestInit) => { status?: number; body: unknown };

function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/.well-known/dohc-server")) return Response.json({ version: 1, authUrl: "https://cloud.test", relayUrl: "https://cloud.test", shareUrl: "https://cloud.test" });
    const route = Object.entries(routes).find(([suffix]) => url.endsWith(suffix))?.[1];
    if (!route) return new Response("not found", { status: 404 });
    const { status = 200, body } = route(init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const DEVICE = {
  device_code: "dev-123",
  user_code: "ABCD1234",
  verification_uri: "https://cloud.test/device",
  verification_uri_complete: "https://cloud.test/device?user_code=ABCD1234",
};

describe("cloud device-flow login", () => {
  it("does not activate managed login from obsolete endpoint environment settings", async () => {
    vi.stubEnv("DOHC_CLOUD_URL", "https://managed.example.test");
    vi.stubEnv("DOHC_CLOUD_RELAY_URL", "https://managed-relay.example.test");
    try {
      const { impl, calls } = fakeFetch({});
      const login = createCloudLogin({ store: memoryStore(), fetch: impl });
      await expect(login.start("")).rejects.toThrow("Enter the server's https address");
      expect(calls).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the discovered network scope in status, and not the server's name", async () => {
    const { impl } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () => ({ body: { access_token: "secret" } }),
      "/api/auth/get-session": () => ({ body: { user: { id: "user", email: "user@example.test" } } }),
    });
    const login = createCloudLogin({
      store: memoryStore(),
      fetch: async (url, init) => String(url).endsWith("/.well-known/dohc-server")
        ? Response.json({ version: 1, authUrl: "https://cloud.test", relayUrl: "https://cloud.test", shareUrl: "https://cloud.test", name: "Research server", networkAccess: "private" })
        : impl(url, init),
    });
    await login.start("https://cloud.test");
    await login.poll();
    const status = await login.status();
    expect(status).toMatchObject({ connected: true, networkAccess: "private" });
    expect(status).not.toHaveProperty("serverName");
  });

  it.each([
    "https://other.test/device?user_code=ABCD1234",
    "https://user:password@cloud.test/device",
    "http://cloud.test/device",
    "javascript:alert(1)",
  ])("rejects a verification address outside the selected server: %s", async verificationUri => {
    const { impl, calls } = fakeFetch({
      "/api/auth/device/code": () => ({ body: { ...DEVICE, verification_uri_complete: verificationUri } }),
    });
    const store = memoryStore();
    const login = createCloudLogin({ store, fetch: impl });
    await expect(login.start("https://cloud.test")).rejects.toThrow("invalid sign-in address");
    expect(store.saved).toBeNull();
    expect(calls.map(call => new URL(call.url).origin)).toEqual(["https://cloud.test", "https://cloud.test"]);
    await expect(login.poll()).rejects.toThrow("No cloud login in progress");
  });

  it("forbids redirecting device credentials and session tokens", async () => {
    const { impl, calls } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () => ({ body: { access_token: "secret" } }),
      "/api/auth/get-session": () => ({ body: { user: { id: "user", email: "user@example.test" } } }),
    });
    const login = createCloudLogin({ store: memoryStore(), fetch: impl });
    await login.start("https://cloud.test");
    await login.poll();
    for (const { init } of calls) {
      expect(init).toMatchObject({ redirect: "error", credentials: "omit" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls.at(-1)?.init?.headers).toEqual({ authorization: "Bearer secret" });
  });

  it("rejects an empty or invalid server before making a request", async () => {
    const { impl, calls } = fakeFetch({});
    const login = createCloudLogin({ store: memoryStore(), fetch: impl });
    for (const address of ["", "https://cloud.test/api", "http://cloud.test", "http://localhost:1786"]) {
      await expect(login.start(address)).rejects.toThrow("Enter the server's https address");
    }
    expect(calls).toEqual([]);
  });

  it("reads a session saved for a plain http server as signed out, except under the e2e switch", async () => {
    const saved = { serverUrl: "http://localhost:1786", relayUrl: "http://localhost:1786", email: "user@example.test", userId: "user", token: "secret" };
    for (const allowInsecureLoopbackForTests of [false, true]) {
      const store = memoryStore();
      store.saved = saved;
      const login = createCloudLogin({ store, fetch: fakeFetch({}).impl, allowInsecureLoopbackForTests });
      await expect(login.credentials()).resolves.toEqual(allowInsecureLoopbackForTests ? saved : null);
      await expect(login.status()).resolves.toMatchObject({ connected: allowInsecureLoopbackForTests });
    }
    const store = memoryStore();
    store.saved = { ...saved, serverUrl: "https://cloud.test", relayUrl: "http://localhost:1786" };
    await expect(createCloudLogin({ store }).credentials()).resolves.toBeNull();
  });

  it("signs in to a plain http server on this machine only under the e2e switch", async () => {
    const local = "http://127.0.0.1:1786";
    const fetcher = (async (url: string | URL | Request) => String(url).endsWith("/.well-known/dohc-server")
      ? Response.json({ version: 1, authUrl: local, relayUrl: local, shareUrl: local })
      : Response.json({ ...DEVICE, verification_uri: `${local}/device`, verification_uri_complete: `${local}/device?user_code=ABCD1234` })) as typeof fetch;
    await expect(createCloudLogin({ store: memoryStore(), fetch: fetcher }).start(local))
      .rejects.toThrow("Enter the server's https address");
    await expect(createCloudLogin({ store: memoryStore(), fetch: fetcher, allowInsecureLoopbackForTests: true }).start(local))
      .resolves.toMatchObject({ userCode: DEVICE.user_code });
  });

  it("discovers the relay from the server before sign-in", async () => {
    const store = memoryStore();
    const { impl } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () => ({
        body: { access_token: "session-token-xyz" },
      }),
      "/api/auth/get-session": () => ({
        body: { user: { email: "ice@dohc.test", id: "usr_ice" } },
      }),
    });
    const login = createCloudLogin({
      store,


      fetch: impl,
    });

    await login.start("https://cloud.test");
    await expect(login.poll()).resolves.toMatchObject({ status: "complete" });
    expect(store.saved).toMatchObject({
      serverUrl: "https://cloud.test",
      relayUrl: "https://cloud.test",
    });
  });

  it("start() returns the user code and the complete verification URI", async () => {
    const { impl } = fakeFetch({ "/api/auth/device/code": () => ({ body: DEVICE }) });
    const login = createCloudLogin({
      store: memoryStore(),

      fetch: impl,
    });
    const started = await login.start("https://cloud.test");
    expect(started.userCode).toBe("ABCD1234");
    expect(started.verificationUri).toContain("user_code=ABCD1234");
  });

  it("poll() reports pending, then persists credentials on approval — token never returned", async () => {
    let approved = false;
    const store = memoryStore();
    const { impl } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () =>
        approved
          ? { body: { access_token: "session-token-xyz" } }
          : { status: 400, body: { error: "authorization_pending" } },
      "/api/auth/get-session": () => ({
        body: { user: { email: "ice@dohc.test", id: "usr_ice" } },
      }),
    });
    const login = createCloudLogin({
      store,

      fetch: impl,
    });

    await login.start("https://cloud.test");
    expect(await login.poll()).toEqual({ status: "pending" });

    approved = true;
    const done = await login.poll();
    expect(done).toEqual({ status: "complete", email: "ice@dohc.test" });
    // Persisted for the sync engine, encrypted by the real store in prod.
    expect(store.saved).toEqual({
      serverUrl: "https://cloud.test",
      relayUrl: "https://cloud.test",
      email: "ice@dohc.test",
      userId: "usr_ice",
      token: "session-token-xyz",
    });
    expect(await login.status()).toEqual({
      connected: true,
      email: "ice@dohc.test",
      serverUrl: "https://cloud.test",
      relayUrl: "https://cloud.test",
    });
  });

  it("captures the Better Auth user id as the OPAQUE reactor identity (never the email)", async () => {
    // WS-MU-C2 security: the reactor author key is a REPLICATED CRDT cell key, so
    // it must be the opaque Better Auth user id, never the raw email (PII would
    // otherwise replicate to every peer and persist in the immutable history).
    const store = memoryStore();
    const { impl } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () => ({ body: { access_token: "session-token-xyz" } }),
      "/api/auth/get-session": () => ({
        body: { user: { email: "ice@dohc.test", id: "usr_9f3a-opaque-uuid" } },
      }),
    });
    const login = createCloudLogin({
      store,

      fetch: impl,
    });
    await login.start("https://cloud.test");
    await login.poll();
    expect(store.saved).toMatchObject({
      email: "ice@dohc.test",
      userId: "usr_9f3a-opaque-uuid",
    });
    // The replicated identity is the opaque id — distinct from the email.
    expect(store.saved?.userId).not.toBe(store.saved?.email);
  });

  it.each([
    ["a missing", undefined],
    ["an empty", ""],
    ["a 321-character", "e".repeat(321)],
  ])("rejects %s credential email through the identity failure", async (_case, email) => {
    const store = memoryStore();
    const user =
      email === undefined
        ? { id: "usr_email_boundary" }
        : { email, id: "usr_email_boundary" };
    const { impl } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () => ({ body: { access_token: "session-token-xyz" } }),
      "/api/auth/get-session": () => ({ body: { user } }),
    });
    const login = createCloudLogin({
      store,

      fetch: impl,
    });

    await login.start("https://cloud.test");
    await expect(login.poll()).rejects.toThrow(/server could not confirm your identity/i);
    expect(store.saved).toBeNull();
    await expect(login.poll()).rejects.toThrow(/no cloud login in progress/i);
  });

  it("accepts a 320-character credential email", async () => {
    const email = "e".repeat(320);
    const store = memoryStore();
    const { impl } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () => ({ body: { access_token: "session-token-xyz" } }),
      "/api/auth/get-session": () => ({
        body: { user: { email, id: "usr_email_boundary" } },
      }),
    });
    const login = createCloudLogin({
      store,

      fetch: impl,
    });

    await login.start("https://cloud.test");
    await expect(login.poll()).resolves.toEqual({ status: "complete", email });
    expect(store.saved?.email).toBe(email);
  });

  it("does not create a signed-in session without a Better Auth user id", async () => {
    const store = memoryStore();
    const { impl } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () => ({ body: { access_token: "session-token-xyz" } }),
      "/api/auth/get-session": () => ({ body: { user: { email: "ice@dohc.test" } } }),
    });
    const login = createCloudLogin({
      store,

      fetch: impl,
    });

    await login.start("https://cloud.test");
    await expect(login.poll()).rejects.toThrow(/server could not confirm your identity/i);
    expect(store.saved).toBeNull();
    await expect(login.poll()).rejects.toThrow(/no cloud login in progress/i);
  });

  it("does not create a signed-in session when get-session fails", async () => {
    const store = memoryStore();
    const { impl } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () => ({ body: { access_token: "session-token-xyz" } }),
      "/api/auth/get-session": () => ({
        status: 503,
        body: { user: { email: "ice@dohc.test", id: "usr_ice" } },
      }),
    });
    const login = createCloudLogin({
      store,

      fetch: impl,
    });

    await login.start("https://cloud.test");
    await expect(login.poll()).rejects.toThrow(/server could not confirm your identity/i);
    expect(store.saved).toBeNull();
    await expect(login.poll()).rejects.toThrow(/no cloud login in progress/i);
  });

  it("does not create a signed-in session with a non-string Better Auth user id", async () => {
    const store = memoryStore();
    const { impl } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () => ({ body: { access_token: "session-token-xyz" } }),
      "/api/auth/get-session": () => ({
        body: { user: { email: "ice@dohc.test", id: 42 } },
      }),
    });
    const login = createCloudLogin({
      store,

      fetch: impl,
    });

    await login.start("https://cloud.test");
    await expect(login.poll()).rejects.toThrow(/server could not confirm your identity/i);
    expect(store.saved).toBeNull();
    await expect(login.poll()).rejects.toThrow(/no cloud login in progress/i);
  });

  it("persists an explicitly supplied relay URL with the approved session", async () => {
    const store = memoryStore();
    const { impl } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () => ({ body: { access_token: "session-token-xyz" } }),
      "/api/auth/get-session": () => ({
        body: { user: { email: "ice@dohc.test", id: "usr_ice" } },
      }),
    });
    const login = createCloudLogin({
      store,

      fetch: impl,
    });
    await login.start("https://cloud.test/");
    await login.poll();
    expect(store.saved).toMatchObject({
      serverUrl: "https://cloud.test",
      relayUrl: "https://cloud.test",
      token: "session-token-xyz",
    });
    await expect(login.status()).resolves.toMatchObject({
      connected: true,
      relayUrl: "https://cloud.test",
    });
  });

  it("poll() maps denial and expiry, and a finished device code cannot be re-polled", async () => {
    const denied = createCloudLogin({
      store: memoryStore(),

      fetch: fakeFetch({
        "/api/auth/device/code": () => ({ body: DEVICE }),
        "/api/auth/device/token": () => ({ status: 400, body: { error: "access_denied" } }),
      }).impl,
    });
    await denied.start("https://cloud.test");
    expect(await denied.poll()).toEqual({ status: "denied" });
    await expect(denied.poll()).rejects.toThrow(/no cloud login/i);

    const expired = createCloudLogin({
      store: memoryStore(),

      fetch: fakeFetch({
        "/api/auth/device/code": () => ({ body: DEVICE }),
        "/api/auth/device/token": () => ({ status: 400, body: { error: "expired_token" } }),
      }).impl,
    });
    await expired.start("https://cloud.test");
    expect(await expired.poll()).toEqual({ status: "expired" });
    await expect(expired.poll()).rejects.toThrow(/no cloud login/i);

    // The default branch is fail-dead: an unrecognized error also kills the code
    // (never an infinite pending loop on a server speaking a different dialect).
    const unknown = createCloudLogin({
      store: memoryStore(),

      fetch: fakeFetch({
        "/api/auth/device/code": () => ({ body: DEVICE }),
        "/api/auth/device/token": () => ({ status: 400, body: { error: "weird_new_error" } }),
      }).impl,
    });
    await unknown.start("https://cloud.test");
    expect(await unknown.poll()).toEqual({ status: "expired" });
  });

  it("logout() clears credentials and status reads disconnected", async () => {
    const store = memoryStore();
    store.saved = {
      serverUrl: "https://cloud.test",
      relayUrl: "https://cloud.test",
      email: "x@y.z",
      userId: "usr_x",
      token: "t",
    };
    const login = createCloudLogin({
      store,

      fetch: fakeFetch({}).impl,
    });
    await login.logout();
    expect(store.saved).toBeNull();
    expect(await login.status()).toEqual({ connected: false });
  });

  it("orders logout after an in-flight save so poll cannot restore the session", async () => {
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    const store = memoryStore();
    store.save = async (credentials) => {
      saveStarted.resolve(undefined);
      await releaseSave.promise;
      store.saved = credentials;
    };
    const { impl } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () => ({
        body: { access_token: "session-token-after-logout" },
      }),
      "/api/auth/get-session": () => ({
        body: { user: { email: "ice@dohc.test", id: "usr_ice" } },
      }),
    });
    const login = createCloudLogin({
      store,

      fetch: impl,
    });

    await login.start("https://cloud.test");
    const polling = login.poll();
    await saveStarted.promise;
    const loggingOut = login.logout();
    releaseSave.resolve(undefined);

    await expect(polling).resolves.toEqual({
      status: "complete",
      email: "ice@dohc.test",
    });
    await loggingOut;
    expect(store.saved).toBeNull();
    await expect(login.credentials()).resolves.toBeNull();
  });

  it("orders a superseding start after an in-flight credential save", async () => {
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    const store = memoryStore();
    store.save = async (credentials) => {
      saveStarted.resolve(undefined);
      await releaseSave.promise;
      store.saved = credentials;
    };
    let tokenCalls = 0;
    const { impl } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () => {
        tokenCalls += 1;
        return tokenCalls === 1
          ? { body: { access_token: "first-session-token" } }
          : { status: 400, body: { error: "access_denied" } };
      },
      "/api/auth/get-session": () => ({
        body: { user: { email: "first@dohc.test", id: "usr_first" } },
      }),
    });
    const login = createCloudLogin({
      store,

      fetch: impl,
    });

    await login.start("https://cloud.test");
    const firstPoll = login.poll();
    await saveStarted.promise;
    const secondStart = login.start("https://cloud.test");
    releaseSave.resolve(undefined);

    await expect(firstPoll).resolves.toEqual({
      status: "complete",
      email: "first@dohc.test",
    });
    await expect(secondStart).resolves.toMatchObject({ userCode: "ABCD1234" });
    await expect(login.poll()).resolves.toEqual({ status: "denied" });
    expect(store.saved).toMatchObject({
      userId: "usr_first",
      token: "first-session-token",
    });
  });

  it("keeps a same-tick logout newer than a start with a delayed response body", async () => {
    const deviceBody = deferred<typeof DEVICE>();
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/.well-known/dohc-server")) return Response.json({ version: 1, authUrl: "https://cloud.test", relayUrl: "https://cloud.test", shareUrl: "https://cloud.test" });
      if (url.endsWith("/api/auth/device/code")) {
        return {
          ok: true,
          status: 200,
          json: () => deviceBody.promise,
        } as Response;
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const login = createCloudLogin({
      store: memoryStore(),

      fetch: fetchImpl,
    });

    const starting = login.start("https://cloud.test");
    const loggingOut = login.logout();
    await loggingOut;
    deviceBody.resolve(DEVICE);

    await expect(starting).rejects.toThrow(/cancelled/i);
    await expect(login.poll()).rejects.toThrow(/no cloud login in progress/i);
  });

  it("shares one in-flight poll for a device-code attempt", async () => {
    const tokenResponse = deferred<Response>();
    let tokenCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/.well-known/dohc-server")) return Response.json({ version: 1, authUrl: "https://cloud.test", relayUrl: "https://cloud.test", shareUrl: "https://cloud.test" });
      if (url.endsWith("/api/auth/device/code")) {
        return Response.json(DEVICE);
      }
      if (url.endsWith("/api/auth/device/token")) {
        tokenCalls += 1;
        return tokenResponse.promise;
      }
      if (url.endsWith("/api/auth/get-session")) {
        return Response.json({
          user: { email: "ice@dohc.test", id: "usr_ice" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const login = createCloudLogin({
      store: memoryStore(),

      fetch: fetchImpl,
    });

    await login.start("https://cloud.test");
    const first = login.poll();
    const second = login.poll();
    expect(first).toBe(second);
    expect(tokenCalls).toBe(1);

    tokenResponse.resolve(Response.json({ access_token: "session-token-xyz" }));
    await expect(first).resolves.toMatchObject({ status: "complete" });
  });
});

describe("completed cloud login session", () => {
  it("adopts the saved credentials after a relay-close failure", async () => {
    const savedCredentials: CloudCredentials = {
      serverUrl: "https://cloud.test",
      relayUrl: "ws://relay.test",
      email: "new@dohc.test",
      userId: "usr_new",
      token: "new-session-token",
    };
    let cachedCredentials: CloudCredentials | null = {
      ...savedCredentials,
      email: "old@dohc.test",
      userId: "usr_old",
      token: "old-session-token",
    };
    const steps: string[] = [];
    const relayCloseFailure = new Error("relay close failed");

    const transition = adoptCompletedCloudLoginSession({
      clearCachedCredentials() {
        steps.push("clear credentials");
        cachedCredentials = null;
      },
      async stopEngines() {
        steps.push("stop engines");
      },
      async closeRelayTransportWorkspaces() {
        steps.push("close relay workspaces");
        throw relayCloseFailure;
      },
      async refreshCredentialCache() {
        steps.push("refresh credentials");
        cachedCredentials = savedCredentials;
      },
      reconcileCloud() {
        steps.push(`reconcile ${cachedCredentials?.token ?? "signed-out"}`);
      },
      notifySessionChanging() {
        steps.push("notify session changing");
      },
      notifyCloudSessionChanged() {
        steps.push("notify session changed");
      },
    });

    await expect(transition).rejects.toBe(relayCloseFailure);
    expect(cachedCredentials).toEqual(savedCredentials);
    expect(steps).toEqual([
      "clear credentials",
      // Immediately after the clear — engine cleanup can stall behind an
      // in-flight sync pass, and views must not wait on it. This broadcast
      // carries the incoming identity the caller computed before the clear.
      "notify session changing",
      "stop engines",
      "close relay workspaces",
      "refresh credentials",
      "reconcile new-session-token",
      // And the final state once the new session is in place.
      "notify session changed",
    ]);
  });

  // The renderer signal is not gated on the transition succeeding: the
  // credentials changed either way, and mounted views must re-scope their
  // account-tied caches even when cleanup or the refresh rejected.
  it("notifies the session change even when the transition fails", async () => {
    const refreshFailure = new Error("refresh failed");
    let notified = 0;

    await expect(
      adoptCompletedCloudLoginSession({
        clearCachedCredentials() {},
        async stopEngines() {
          throw new Error("cleanup failed");
        },
        async closeRelayTransportWorkspaces() {},
        async refreshCredentialCache() {
          throw refreshFailure;
        },
        reconcileCloud() {},
        notifySessionChanging() {
          notified += 1;
        },
        notifyCloudSessionChanged() {
          notified += 1;
        },
      }),
    ).rejects.toMatchObject({});
    // Once at the clear, once at the transition's end.
    expect(notified).toBe(2);
  });

  it("reports cleanup and refresh failures without reconciling stale state", async () => {
    const cleanupFailure = new Error("cleanup failed");
    const refreshFailure = new Error("refresh failed");
    let reconciled = false;

    const transition = adoptCompletedCloudLoginSession({
      clearCachedCredentials() {},
      async stopEngines() {
        throw cleanupFailure;
      },
      async closeRelayTransportWorkspaces() {},
      async refreshCredentialCache() {
        throw refreshFailure;
      },
      reconcileCloud() {
        reconciled = true;
      },
      notifySessionChanging() {},
      notifyCloudSessionChanged() {},
    });

    await expect(transition).rejects.toMatchObject({
      errors: [cleanupFailure, refreshFailure],
    });
    expect(reconciled).toBe(false);
  });

  it("reports a reconciliation failure after refreshing credentials", async () => {
    const reconcileFailure = new Error("reconcile failed");

    await expect(
      adoptCompletedCloudLoginSession({
        clearCachedCredentials() {},
        async stopEngines() {},
        async closeRelayTransportWorkspaces() {},
        async refreshCredentialCache() {},
        reconcileCloud() {
          throw reconcileFailure;
        },
        notifySessionChanging() {},
        notifyCloudSessionChanged() {},
      }),
    ).rejects.toBe(reconcileFailure);
  });
});

// The logout transition follows the same rule as login adoption: the session
// is invalid the moment the credentials are cleared, so the renderer signals
// fire from a finally and are never gated on the credential store or engine
// cleanup succeeding.
describe("cloud logout transition", () => {
  it("notifies the session change even when engine cleanup rejects", async () => {
    const stopFailure = new Error("engines refused to stop");
    const steps: string[] = [];

    await expect(
      runCloudLogoutTransition({
        clearCachedCredentials() {
          steps.push("clear credentials");
        },
        async logout() {
          steps.push("logout");
        },
        async stopEngines() {
          steps.push("stop engines");
          throw stopFailure;
        },
        async closeRelayTransportWorkspaces() {
          steps.push("close relay workspaces");
        },
        notifyWorkspaceActivity() {
          steps.push("notify activity");
        },
        notifyCloudSessionChanged() {
          steps.push("notify session changed");
        },
      }),
    ).rejects.toBe(stopFailure);
    expect(steps).toEqual([
      "clear credentials",
      "notify session changed",
      "logout",
      "stop engines",
      "notify activity",
    ]);
  });

  // The signal must not wait on cleanup at all: an in-flight sync pass can
  // stall stopEngines indefinitely, and the old account's rows must leave
  // mounted views the moment the credentials are cleared.
  it("broadcasts the session change before cleanup that never finishes", async () => {
    let notified = false;
    const transition = runCloudLogoutTransition({
      clearCachedCredentials() {},
      async logout() {},
      stopEngines: () => new Promise<void>(() => {}),
      async closeRelayTransportWorkspaces() {},
      notifyWorkspaceActivity() {},
      notifyCloudSessionChanged() {
        notified = true;
      },
    });
    await Promise.resolve();
    expect(notified).toBe(true);
    void transition;
  });

  it("still cleans up and notifies when the credential store rejects the logout", async () => {
    const logoutFailure = new Error("credential store unavailable");
    const steps: string[] = [];

    await expect(
      runCloudLogoutTransition({
        clearCachedCredentials() {
          steps.push("clear credentials");
        },
        async logout() {
          steps.push("logout");
          throw logoutFailure;
        },
        async stopEngines() {
          steps.push("stop engines");
        },
        async closeRelayTransportWorkspaces() {
          steps.push("close relay workspaces");
        },
        notifyWorkspaceActivity() {
          steps.push("notify activity");
        },
        notifyCloudSessionChanged() {
          steps.push("notify session changed");
        },
      }),
    ).rejects.toBe(logoutFailure);
    expect(steps).toEqual([
      "clear credentials",
      "notify session changed",
      "logout",
      "stop engines",
      "close relay workspaces",
      "notify activity",
    ]);
  });
});

// The 401 path's persistent invalidation: one serialized compare-and-clear
// inside the store's mutation queue. A login save can never land between the
// check and the clear — the queue orders them whole.
describe("invalidateSessionIf", () => {
  const SESSION_A: CloudCredentials = {
    serverUrl: "https://cloud.test",
    email: "a@dohc.test",
    userId: "usr_a",
    token: "token-a",
  };

  it("clears the store while it still holds the matching session", async () => {
    const store = memoryStore();
    store.saved = SESSION_A;
    const login = createCloudLogin({
      store,

      fetch: fakeFetch({}).impl,
    });
    await login.invalidateSessionIf({
      serverUrl: SESSION_A.serverUrl,
      userId: SESSION_A.userId,
      token: SESSION_A.token,
    });
    expect(store.saved).toBeNull();
  });

  it("leaves a different saved session intact", async () => {
    const store = memoryStore();
    store.saved = { ...SESSION_A, userId: "usr_b", token: "token-b" };
    const login = createCloudLogin({
      store,

      fetch: fakeFetch({}).impl,
    });
    await login.invalidateSessionIf({
      serverUrl: SESSION_A.serverUrl,
      userId: SESSION_A.userId,
      token: SESSION_A.token,
    });
    expect(store.saved).toEqual({ ...SESSION_A, userId: "usr_b", token: "token-b" });
  });

  // The TOCTOU the queue closes: A's 401 lands while a completed login is
  // MID-SAVE. The invalidation queues behind the save, its compare then sees
  // the new session, and the just-completed login survives.
  it("cannot delete a login whose save is in flight when the 401 lands", async () => {
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    const store = memoryStore();
    store.saved = SESSION_A;
    store.save = async (credentials) => {
      saveStarted.resolve(undefined);
      await releaseSave.promise;
      store.saved = credentials;
    };
    const { impl } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () => ({
        body: { access_token: "token-b" },
      }),
      "/api/auth/get-session": () => ({
        body: { user: { email: "b@dohc.test", id: "usr_b" } },
      }),
    });
    const login = createCloudLogin({
      store,

      fetch: impl,
    });

    await login.start("https://cloud.test");
    const polling = login.poll();
    await saveStarted.promise;
    // The outgoing session's 401 arrives while B's save holds the queue.
    const invalidating = login.invalidateSessionIf({
      serverUrl: SESSION_A.serverUrl,
      userId: SESSION_A.userId,
      token: SESSION_A.token,
    });
    releaseSave.resolve(undefined);

    await expect(polling).resolves.toEqual({
      status: "complete",
      email: "b@dohc.test",
    });
    await invalidating;
    // B's just-completed login survives the serialized compare-and-clear.
    expect(store.saved).toMatchObject({ userId: "usr_b", token: "token-b" });
    await expect(login.credentials()).resolves.toMatchObject({
      userId: "usr_b",
    });
  });

  // A failed deletion must not manufacture a live session: the record is
  // still on disk, but the session layer knows it is dead. The tombstone
  // holds until a deletion succeeds — status() reports disconnected and
  // credentials() stops handing the dead token to sync engines.
  it("tombstones a dead session whose deletion failed until a retry succeeds", async () => {
    const store = memoryStore();
    store.saved = SESSION_A;
    let clearFails = true;
    const realClear = store.clear.bind(store);
    store.clear = async () => {
      if (clearFails) throw new Error("store unavailable");
      await realClear();
    };
    const login = createCloudLogin({
      store,

      fetch: fakeFetch({}).impl,
    });
    const identity = {
      serverUrl: SESSION_A.serverUrl,
      userId: SESSION_A.userId,
      token: SESSION_A.token,
    };

    // The deletion fails loudly — and the dead record stops answering. The
    // marker also persists, so a restart cannot resurrect the session.
    await expect(login.invalidateSessionIf(identity)).rejects.toThrow(
      "store unavailable",
    );
    expect(store.saved).toEqual(SESSION_A);
    expect(store.invalidMarker).not.toBeNull();
    await expect(login.status()).resolves.toEqual({ connected: false });
    await expect(login.credentials()).resolves.toBeNull();

    // The retry succeeds: the tombstone lifts with the record gone.
    clearFails = false;
    await login.invalidateSessionIf(identity);
    expect(store.saved).toBeNull();
    expect(store.invalidMarker).toBeNull();
    await expect(login.status()).resolves.toEqual({ connected: false });
  });

  // The restart shape: a fresh instance has no in-memory tombstone — only
  // the persisted marker. The stored record matching it must read as
  // disconnected and be deleted on load, not resurrected as connected.
  it("keeps a dead session dead across restart and deletes it on load", async () => {
    const store = memoryStore();
    store.saved = SESSION_A;
    let clearFails = true;
    const realClear = store.clear.bind(store);
    store.clear = async () => {
      if (clearFails) throw new Error("store unavailable");
      await realClear();
    };
    const identity = {
      serverUrl: SESSION_A.serverUrl,
      userId: SESSION_A.userId,
      token: SESSION_A.token,
    };
    const beforeRestart = createCloudLogin({
      store,

      fetch: fakeFetch({}).impl,
    });
    await expect(beforeRestart.invalidateSessionIf(identity)).rejects.toThrow(
      "store unavailable",
    );
    expect(store.invalidMarker).not.toBeNull();

    // Restart: a new instance over the same store, deletion now possible.
    clearFails = false;
    const afterRestart = createCloudLogin({
      store,

      fetch: fakeFetch({}).impl,
    });
    await expect(afterRestart.status()).resolves.toEqual({ connected: false });
    // Deleted-on-load: the record is gone and the marker lifted.
    expect(store.saved).toBeNull();
    expect(store.invalidMarker).toBeNull();
    await expect(afterRestart.credentials()).resolves.toBeNull();
  });

  it("does not let the tombstone shadow a different, live session", async () => {
    const store = memoryStore();
    store.saved = SESSION_A;
    store.clear = async () => {
      throw new Error("store unavailable");
    };
    const login = createCloudLogin({
      store,

      fetch: fakeFetch({}).impl,
    });
    await expect(
      login.invalidateSessionIf({
        serverUrl: SESSION_A.serverUrl,
        userId: SESSION_A.userId,
        token: SESSION_A.token,
      }),
    ).rejects.toThrow("store unavailable");

    // A new session lands (a completed login overwrote the record): the
    // tombstone names the dead token only, and the new session answers.
    store.saved = { ...SESSION_A, userId: "usr_b", token: "token-b" };
    await expect(login.status()).resolves.toMatchObject({ connected: true });
    await expect(login.credentials()).resolves.toMatchObject({
      userId: "usr_b",
    });
  });
});

// A deleted account: every session of it is dead, whatever its token.
describe("invalidateAccount", () => {
  const SESSION_A: CloudCredentials = {
    serverUrl: "https://cloud.test",
    email: "a@dohc.test",
    userId: "usr_a",
    token: "token-a",
  };
  const ACCOUNT_A = { serverUrl: SESSION_A.serverUrl, userId: SESSION_A.userId };

  it("clears the account's session after another window signed it in again", async () => {
    const store = memoryStore();
    store.saved = { ...SESSION_A, token: "token-a2" };
    const login = createCloudLogin({ store, fetch: fakeFetch({}).impl });
    await login.invalidateAccount(ACCOUNT_A);
    expect(store.saved).toBeNull();
    await expect(login.status()).resolves.toEqual({ connected: false });
  });

  it.each([
    ["another account on the same server", { ...SESSION_A, userId: "usr_b", email: "b@dohc.test", token: "token-b" }],
    ["the same user id on another server", { ...SESSION_A, serverUrl: "https://other.test", token: "token-o" }],
  ])("keeps %s", async (_name, other) => {
    const store = memoryStore();
    store.saved = other;
    const login = createCloudLogin({ store, fetch: fakeFetch({}).impl });
    await login.invalidateAccount(ACCOUNT_A);
    expect(store.saved).toEqual(other);
    await expect(login.status()).resolves.toMatchObject({ connected: true });
  });

  it("clears a same-account sign-in whose save is in flight when deletion finishes", async () => {
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    const store = memoryStore();
    store.saved = SESSION_A;
    store.save = async (credentials) => {
      saveStarted.resolve(undefined);
      await releaseSave.promise;
      store.saved = credentials;
    };
    const { impl } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () => ({ body: { access_token: "token-a2" } }),
      "/api/auth/get-session": () => ({ body: { user: { email: SESSION_A.email, id: SESSION_A.userId } } }),
    });
    const login = createCloudLogin({ store, fetch: impl });

    await login.start("https://cloud.test");
    const polling = login.poll();
    await saveStarted.promise;
    const invalidating = login.invalidateAccount(ACCOUNT_A);
    releaseSave.resolve(undefined);

    await expect(polling).resolves.toMatchObject({ status: "complete" });
    await invalidating;
    expect(store.saved).toBeNull();
    await expect(login.credentials()).resolves.toBeNull();
  });

  // A sign-in whose get-session answer the test holds, so the server reads the
  // session before deletion and the poll saves after it.
  function heldSessionFetch(user: { id: string; email: string }) {
    const asked = deferred<void>();
    const answer = deferred<void>();
    const { impl } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () => ({ body: { access_token: "token-late" } }),
      "/api/auth/get-session": () => ({ body: { user } }),
    });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/api/auth/get-session")) {
        asked.resolve(undefined);
        await answer.promise;
      }
      return impl(input, init);
    }) as typeof fetch;
    return { fetchImpl, asked: asked.promise, answer: () => answer.resolve(undefined) };
  }

  it("refuses a sign-in that read the session before deletion, also after a restart", async () => {
    const store = memoryStore();
    const held = heldSessionFetch({ id: SESSION_A.userId, email: SESSION_A.email });
    const login = createCloudLogin({ store, fetch: held.fetchImpl });
    await login.start("https://cloud.test");
    const polling = login.poll();
    await held.asked;

    await login.invalidateAccount(ACCOUNT_A);
    held.answer();

    await expect(polling).rejects.toThrow("You deleted this account on this server.");
    expect(store.saved).toBeNull();
    expect(store.deletedAccounts).toEqual([ACCOUNT_A]);
    await expect(login.status()).resolves.toEqual({ connected: false });
    await expect(login.poll()).rejects.toThrow("No cloud login in progress");

    // Restart: only the persisted record remains, and it still refuses.
    const restarted = createCloudLogin({
      store,
      fetch: fakeFetch({
        "/api/auth/device/code": () => ({ body: DEVICE }),
        "/api/auth/device/token": () => ({ body: { access_token: "token-again" } }),
        "/api/auth/get-session": () => ({ body: { user: { id: SESSION_A.userId, email: SESSION_A.email } } }),
      }).impl,
    });
    await restarted.start("https://cloud.test");
    await expect(restarted.poll()).rejects.toThrow("You deleted this account on this server.");
    expect(store.saved).toBeNull();
    await expect(restarted.status()).resolves.toEqual({ connected: false });
    await expect(restarted.credentials()).resolves.toBeNull();
  });

  it("reads a stored session of a deleted account as disconnected after a restart", async () => {
    const store = memoryStore();
    store.saved = SESSION_A;
    store.deletedAccounts = [ACCOUNT_A];
    const login = createCloudLogin({ store, fetch: fakeFetch({}).impl });
    await expect(login.status()).resolves.toEqual({ connected: false });
    await expect(login.credentials()).resolves.toBeNull();
    expect(store.saved).toBeNull();
  });

  it.each([
    ["another account on the same server", { id: "usr_b", email: "b@dohc.test" }, "https://cloud.test"],
    ["the same user id on another server", { id: SESSION_A.userId, email: SESSION_A.email }, "https://other.test"],
  ])("still signs in to %s after a deletion", async (_name, user, deletedServer) => {
    const store = memoryStore();
    const held = heldSessionFetch(user);
    const login = createCloudLogin({ store, fetch: held.fetchImpl });
    await login.start("https://cloud.test");
    const polling = login.poll();
    await held.asked;

    await login.invalidateAccount({ serverUrl: deletedServer, userId: SESSION_A.userId });
    held.answer();

    await expect(polling).resolves.toMatchObject({ status: "complete" });
    expect(store.saved).toMatchObject({ serverUrl: "https://cloud.test", userId: user.id, token: "token-late" });
    await expect(login.status()).resolves.toMatchObject({ connected: true });
  });

  it("refuses the account in this process when its record cannot be written", async () => {
    const store = memoryStore();
    store.saved = SESSION_A;
    store.saveDeletedAccounts = async () => {
      throw new Error("disk full");
    };
    const held = heldSessionFetch({ id: SESSION_A.userId, email: SESSION_A.email });
    const login = createCloudLogin({ store, fetch: held.fetchImpl });
    await login.start("https://cloud.test");
    const polling = login.poll();
    await held.asked;

    await expect(login.invalidateAccount(ACCOUNT_A)).rejects.toThrow("disk full");
    expect(store.saved).toBeNull();
    held.answer();
    await expect(polling).rejects.toThrow("You deleted this account on this server.");
    expect(store.saved).toBeNull();
  });

  it("writes the record again on the next deletion of the same account, so a restart refuses it", async () => {
    const store = memoryStore();
    const save = store.saveDeletedAccounts;
    store.saveDeletedAccounts = async () => {
      throw new Error("disk full");
    };
    const login = createCloudLogin({ store, fetch: fakeFetch({}).impl });
    await expect(login.invalidateAccount(ACCOUNT_A)).rejects.toThrow("disk full");
    expect(store.deletedAccounts).toEqual([]);

    store.saveDeletedAccounts = save;
    await login.invalidateAccount(ACCOUNT_A);
    expect(store.deletedAccounts).toEqual([ACCOUNT_A]);

    store.saved = SESSION_A;
    const restarted = createCloudLogin({ store, fetch: fakeFetch({}).impl });
    await expect(restarted.status()).resolves.toEqual({ connected: false });
  });

  it("tombstones the account's current token when the clear fails", async () => {
    const store = memoryStore();
    store.saved = { ...SESSION_A, token: "token-a2" };
    store.clear = async () => {
      throw new Error("store unavailable");
    };
    const login = createCloudLogin({ store, fetch: fakeFetch({}).impl });
    await expect(login.invalidateAccount(ACCOUNT_A)).rejects.toThrow("store unavailable");
    expect(store.invalidMarker).toMatchObject(ACCOUNT_A);
    await expect(login.status()).resolves.toEqual({ connected: false });
    await expect(login.credentials()).resolves.toBeNull();
  });
});
