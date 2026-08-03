import { describe, expect, it } from "vitest";
import type { CloudCredentials } from "./cloudCredentialStore";
import {
  adoptCompletedCloudLoginSession,
  runCloudLogoutTransition,
  createCloudLogin,
  type CloudLoginStore,
  type InvalidSessionMarker,
} from "./cloudLogin";

function memoryStore(): CloudLoginStore & {
  saved: CloudCredentials | null;
  invalidMarker: InvalidSessionMarker | null;
} {
  const box = {
    saved: null as CloudCredentials | null,
    invalidMarker: null as InvalidSessionMarker | null,
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

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const DEVICE = {
  device_code: "dev-123",
  user_code: "ABCD1234",
  verification_uri: "http://cloud.test/device",
  verification_uri_complete: "http://cloud.test/device?user_code=ABCD1234",
};

describe("cloud device-flow login", () => {
  it("start() returns the user code and the complete verification URI", async () => {
    const { impl } = fakeFetch({ "/api/auth/device/code": () => ({ body: DEVICE }) });
    const login = createCloudLogin({
      store: memoryStore(),
      defaultServerUrl: "http://cloud.test",
      fetch: impl,
    });
    const started = await login.start();
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
      defaultServerUrl: "http://cloud.test",
      fetch: impl,
    });

    await login.start();
    expect(await login.poll()).toEqual({ status: "pending" });

    approved = true;
    const done = await login.poll();
    expect(done).toEqual({ status: "complete", email: "ice@dohc.test" });
    // Persisted for the sync engine, encrypted by the real store in prod.
    expect(store.saved).toEqual({
      serverUrl: "http://cloud.test",
      email: "ice@dohc.test",
      userId: "usr_ice",
      token: "session-token-xyz",
    });
    expect(await login.status()).toEqual({
      connected: true,
      email: "ice@dohc.test",
      serverUrl: "http://cloud.test",
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
      defaultServerUrl: "http://cloud.test",
      fetch: impl,
    });
    await login.start();
    await login.poll();
    expect(store.saved).toMatchObject({
      email: "ice@dohc.test",
      userId: "usr_9f3a-opaque-uuid",
    });
    // The replicated identity is the opaque id — distinct from the email.
    expect(store.saved?.userId).not.toBe(store.saved?.email);
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
      defaultServerUrl: "http://cloud.test",
      fetch: impl,
    });

    await login.start();
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
      defaultServerUrl: "http://cloud.test",
      fetch: impl,
    });

    await login.start();
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
      defaultServerUrl: "http://cloud.test",
      fetch: impl,
    });

    await login.start();
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
      defaultServerUrl: "http://cloud.test",
      fetch: impl,
    });
    await login.start("http://cloud.test/", "http://relay.test/");
    await login.poll();
    expect(store.saved).toMatchObject({
      serverUrl: "http://cloud.test",
      relayUrl: "http://relay.test",
      token: "session-token-xyz",
    });
    await expect(login.status()).resolves.toMatchObject({
      connected: true,
      relayUrl: "http://relay.test",
    });
  });

  it("poll() maps denial and expiry, and a finished device code cannot be re-polled", async () => {
    const denied = createCloudLogin({
      store: memoryStore(),
      defaultServerUrl: "http://cloud.test",
      fetch: fakeFetch({
        "/api/auth/device/code": () => ({ body: DEVICE }),
        "/api/auth/device/token": () => ({ status: 400, body: { error: "access_denied" } }),
      }).impl,
    });
    await denied.start();
    expect(await denied.poll()).toEqual({ status: "denied" });
    await expect(denied.poll()).rejects.toThrow(/no cloud login/i);

    const expired = createCloudLogin({
      store: memoryStore(),
      defaultServerUrl: "http://cloud.test",
      fetch: fakeFetch({
        "/api/auth/device/code": () => ({ body: DEVICE }),
        "/api/auth/device/token": () => ({ status: 400, body: { error: "expired_token" } }),
      }).impl,
    });
    await expired.start();
    expect(await expired.poll()).toEqual({ status: "expired" });
    await expect(expired.poll()).rejects.toThrow(/no cloud login/i);

    // The default branch is fail-dead: an unrecognized error also kills the code
    // (never an infinite pending loop on a server speaking a different dialect).
    const unknown = createCloudLogin({
      store: memoryStore(),
      defaultServerUrl: "http://cloud.test",
      fetch: fakeFetch({
        "/api/auth/device/code": () => ({ body: DEVICE }),
        "/api/auth/device/token": () => ({ status: 400, body: { error: "weird_new_error" } }),
      }).impl,
    });
    await unknown.start();
    expect(await unknown.poll()).toEqual({ status: "expired" });
  });

  it("logout() clears credentials and status reads disconnected", async () => {
    const store = memoryStore();
    store.saved = {
      serverUrl: "http://cloud.test",
      email: "x@y.z",
      userId: "usr_x",
      token: "t",
    };
    const login = createCloudLogin({
      store,
      defaultServerUrl: "http://cloud.test",
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
      defaultServerUrl: "http://cloud.test",
      fetch: impl,
    });

    await login.start();
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
      defaultServerUrl: "http://cloud.test",
      fetch: impl,
    });

    await login.start();
    const firstPoll = login.poll();
    await saveStarted.promise;
    const secondStart = login.start();
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
      defaultServerUrl: "http://cloud.test",
      fetch: fetchImpl,
    });

    const starting = login.start();
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
      defaultServerUrl: "http://cloud.test",
      fetch: fetchImpl,
    });

    await login.start();
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
      serverUrl: "http://cloud.test",
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
      // carries the INCOMING identity the caller computed before the clear.
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

// The 401 path's persistent invalidation: ONE serialized compare-and-clear
// inside the store's mutation queue. A login save can never land between the
// check and the clear — the queue orders them whole.
describe("invalidateSessionIf", () => {
  const SESSION_A: CloudCredentials = {
    serverUrl: "http://cloud.test",
    email: "a@dohc.test",
    userId: "usr_a",
    token: "token-a",
  };

  it("clears the store while it still holds the matching session", async () => {
    const store = memoryStore();
    store.saved = SESSION_A;
    const login = createCloudLogin({
      store,
      defaultServerUrl: "http://cloud.test",
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
      defaultServerUrl: "http://cloud.test",
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
      defaultServerUrl: "http://cloud.test",
      fetch: impl,
    });

    await login.start();
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
  // still on disk, but the session layer KNOWS it is dead. The tombstone
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
      defaultServerUrl: "http://cloud.test",
      fetch: fakeFetch({}).impl,
    });
    const identity = {
      serverUrl: SESSION_A.serverUrl,
      userId: SESSION_A.userId,
      token: SESSION_A.token,
    };

    // The deletion fails loudly — and the dead record stops answering. The
    // marker also PERSISTS, so a restart cannot resurrect the session.
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
      defaultServerUrl: "http://cloud.test",
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
      defaultServerUrl: "http://cloud.test",
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
      defaultServerUrl: "http://cloud.test",
      fetch: fakeFetch({}).impl,
    });
    await expect(
      login.invalidateSessionIf({
        serverUrl: SESSION_A.serverUrl,
        userId: SESSION_A.userId,
        token: SESSION_A.token,
      }),
    ).rejects.toThrow("store unavailable");

    // A NEW session lands (a completed login overwrote the record): the
    // tombstone names the dead token only, and the new session answers.
    store.saved = { ...SESSION_A, userId: "usr_b", token: "token-b" };
    await expect(login.status()).resolves.toMatchObject({ connected: true });
    await expect(login.credentials()).resolves.toMatchObject({
      userId: "usr_b",
    });
  });
});
