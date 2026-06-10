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
      "/api/auth/get-session": () => ({ body: { user: { email: "ice@dohc.test" } } }),
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
      token: "session-token-xyz",
    });
    expect(await login.status()).toEqual({
      connected: true,
      email: "ice@dohc.test",
      serverUrl: "http://cloud.test",
    });
  });

  it("poll() maps denial and expiry, and a dead code cannot be re-polled", async () => {
    const { impl } = fakeFetch({
      "/api/auth/device/code": () => ({ body: DEVICE }),
      "/api/auth/device/token": () => ({ status: 400, body: { error: "access_denied" } }),
    });
    const login = createCloudLogin({
      store: memoryStore(),
      defaultServerUrl: "http://cloud.test",
      fetch: impl,
    });
    await login.start();
    expect(await login.poll()).toEqual({ status: "denied" });
    await expect(login.poll()).rejects.toThrow(/no cloud login/i);
  });

  it("logout() clears credentials and status reads disconnected", async () => {
    const store = memoryStore();
    store.saved = { serverUrl: "http://cloud.test", email: "x@y.z", token: "t" };
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
