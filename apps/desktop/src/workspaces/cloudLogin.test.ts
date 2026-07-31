import { describe, expect, it } from "vitest";
import type { CloudCredentials } from "./cloudCredentialStore";
import { createCloudLogin, type CloudLoginStore } from "./cloudLogin";

function memoryStore(): CloudLoginStore & { saved: CloudCredentials | null } {
  const box = {
    saved: null as CloudCredentials | null,
    async load() {
      return box.saved;
    },
    async save(credentials: CloudCredentials) {
      box.saved = credentials;
    },
    async clear() {
      box.saved = null;
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
    await expect(login.poll()).rejects.toThrow(/server returned no user identity/i);
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
});
