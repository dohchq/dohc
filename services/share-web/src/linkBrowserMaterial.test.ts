import { describe, expect, it, vi } from "vitest";
import { createShareWebApplication, LINK_SESSION_RENEWAL_GRACE_MS, type CreateShareWebApplicationOptions } from "./server";

const host = "share.example.test";
const capability = Buffer.alloc(32, 1).toString("base64url");
const renewed = Buffer.alloc(32, 2).toString("base64url");
const profile = Buffer.alloc(32, 3).toString("base64url");
const secret = Buffer.alloc(32, 4).toString("base64url");

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://${host}${path}`, {
    ...init, headers: { host, ...Object.fromEntries(new Headers(init.headers)) },
  });
}

function fixture(options: Partial<CreateShareWebApplicationOptions> = {}) {
  let now = 1_000;
  const fetchRelay = vi.fn(async (req: Request) => {
    const path = new URL(req.url).pathname;
    return path === "/sync/link-exchange" || path === "/sync/link-refresh"
      ? Response.json({
        ok: true, grantId: "grant-alpha",
        capabilityToken: path === "/sync/link-refresh" ? renewed : capability,
        capabilityExpiresAtMs: now + 900_000,
      })
      : Response.json({ ok: true });
  });
  const application = createShareWebApplication({
    relayUrl: "http://relay.test", publicRelayUrl: "https://relay.test",
    publicHosts: new Set([host]), newProfileSecret: () => profile,
    nowMs: () => now, fetchRelay, ...options,
  });
  return {
    application, fetchRelay, setNow: (value: number) => { now = value; },
    async exchange() {
      const response = await application.handle(request("/api/exchange", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret }),
      }));
      expect(response.status).toBe(200);
      const { session } = await response.json() as { session: string };
      const pairs = response.headers.getSetCookie().map(value => value.split(";", 1)[0]!);
      return { session, cookie: pairs.join("; "), pairs };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

const signal = () => new AbortController().signal;

describe("link browser credential material", () => {
  it("uses the HTTP exchange session and returns owned scalar material", async () => {
    const f = fixture();
    const { session, cookie } = await f.exchange();
    const resolve = () => f.application.resolveLinkBrowserMaterial(session, cookie, signal());
    const material = await resolve();
    expect(material).toEqual({ ok: true, capabilityToken: capability, profileSecret: profile, setCookie: null, currentCapability: expect.any(Function) });
    if (!material.ok) throw new Error("missing material");
    material.capabilityToken = "changed";
    material.profileSecret = "changed";
    expect(await resolve()).toEqual({ ok: true, capabilityToken: capability, profileSecret: profile, setCookie: null, currentCapability: expect.any(Function) });
    expect(f.fetchRelay).toHaveBeenCalledTimes(1);
  });

  it("isolates application instances and discriminators", async () => {
    const f = fixture();
    const other = fixture();
    const { session, cookie } = await f.exchange();
    expect(await other.application.resolveLinkBrowserMaterial(session, cookie, signal())).toEqual({ ok: false, status: 404 });
    expect(await f.application.resolveLinkBrowserMaterial("abcdefghijkl", cookie, signal())).toEqual({ ok: false, status: 404 });
  });

  it.each([null, "", "bad", "abcdefghijkl="])("refuses missing browser credentials: %s", async cookie => {
    const f = fixture();
    const { session } = await f.exchange();
    expect(await f.application.resolveLinkBrowserMaterial(session, cookie, signal())).toEqual({ ok: false, status: 404 });
    expect(f.fetchRelay).toHaveBeenCalledTimes(1);
  });

  it("requires the existing profile and rejects invalid discriminators without refresh", async () => {
    const f = fixture();
    const { session, pairs, cookie } = await f.exchange();
    f.setNow(901_001);
    for (const value of [pairs[0]!, `${pairs[0]}; dohc_share_profile_${session}=invalid`]) {
      expect(await f.application.resolveLinkBrowserMaterial(session, value, signal())).toEqual({ ok: false, status: 404 });
    }
    for (const value of ["", `${session} `, `../${session}`]) {
      expect(await f.application.resolveLinkBrowserMaterial(value, cookie, signal())).toEqual({ ok: false, status: 404 });
    }
    expect(f.fetchRelay).toHaveBeenCalledTimes(1);
  });

  it("shares refresh with HTTP and preserves the renewal cookie", async () => {
    const f = fixture();
    const { session, cookie } = await f.exchange();
    const started = deferred<Request>();
    const response = deferred<Response>();
    const defaultFetch = f.fetchRelay.getMockImplementation()!;
    f.fetchRelay.mockImplementation(async req => {
      if (new URL(req.url).pathname !== "/sync/link-refresh") return defaultFetch(req);
      started.resolve(req);
      return response.promise;
    });
    f.setNow(901_001);
    const material = f.application.resolveLinkBrowserMaterial(session, cookie, signal());
    const refreshRequest = await started.promise;
    const http = f.application.handle(request("/api/view/meta", {
      headers: { cookie, "x-dohc-link-session": session },
    }));
    response.resolve(Response.json({ ok: true, grantId: "grant-alpha", capabilityToken: renewed, capabilityExpiresAtMs: 1_801_001 }));
    const result = await material;
    expect(result).toMatchObject({ ok: true, capabilityToken: renewed, profileSecret: profile });
    if (!result.ok) throw new Error("missing material");
    const httpResponse = await http;
    expect(httpResponse.status).toBe(200);
    expect(result).toEqual({ ok: true, capabilityToken: renewed, profileSecret: profile, setCookie: httpResponse.headers.get("set-cookie"), currentCapability: expect.any(Function) });
    expect(result.setCookie).toContain("Secure; HttpOnly; SameSite=Strict");
    expect(result.setCookie).toContain("Path=/; Max-Age=");
    expect(refreshRequest.headers.get("authorization")).toBe(`LinkCapability ${capability}`);
    expect(f.fetchRelay.mock.calls.filter(([req]) => new URL(req.url).pathname === "/sync/link-refresh")).toHaveLength(1);
  });

  it.each([404, 503])("preserves refresh refusal %i and session retention", async status => {
    const f = fixture();
    const { session, cookie } = await f.exchange();
    f.setNow(901_001);
    f.fetchRelay.mockResolvedValue(new Response(null, { status }));
    expect(await f.application.resolveLinkBrowserMaterial(session, cookie, signal())).toEqual({ ok: false, status: status === 404 ? 404 : 503 });
    f.fetchRelay.mockResolvedValue(Response.json({ ok: true, grantId: "grant-alpha", capabilityToken: renewed, capabilityExpiresAtMs: 1_801_001 }));
    expect(await f.application.resolveLinkBrowserMaterial(session, cookie, signal())).toMatchObject(status === 404 ? { ok: false, status: 404 } : { ok: true, capabilityToken: renewed });
  });

  it("keeps a still-valid capability when refresh is unavailable", async () => {
    const f = fixture();
    const { session, cookie } = await f.exchange();
    f.setNow(601_001);
    f.fetchRelay.mockResolvedValue(new Response(null, { status: 503 }));
    expect(await f.application.resolveLinkBrowserMaterial(session, cookie, signal())).toEqual({ ok: true, capabilityToken: capability, profileSecret: profile, setCookie: null, currentCapability: expect.any(Function) });
  });

  it("refuses after the renewal grace period without contacting the relay", async () => {
    const f = fixture();
    const { session, cookie } = await f.exchange();
    f.setNow(901_001 + LINK_SESSION_RENEWAL_GRACE_MS);
    expect(await f.application.resolveLinkBrowserMaterial(session, cookie, signal())).toEqual({ ok: false, status: 404 });
    expect(f.fetchRelay).toHaveBeenCalledTimes(1);
  });

  it("returns no material when cancellation races a successful refresh", async () => {
    const f = fixture();
    const { session, cookie } = await f.exchange();
    f.setNow(901_001);
    const controller = new AbortController();
    f.fetchRelay.mockImplementation(async () => {
      const response = Response.json({ ok: true, grantId: "grant-alpha", capabilityToken: renewed, capabilityExpiresAtMs: 1_801_001 });
      const json = response.json.bind(response);
      response.json = async () => {
        const body = await json();
        controller.abort();
        return body;
      };
      return response;
    });
    await expect(f.application.resolveLinkBrowserMaterial(session, cookie, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(await f.application.resolveLinkBrowserMaterial(session, cookie, signal())).toMatchObject({ ok: true, capabilityToken: renewed });
  });

  it("cancels one waiter without cancelling another waiter's shared refresh", async () => {
    const f = fixture();
    const { session, cookie } = await f.exchange();
    f.setNow(901_001);
    const started = deferred<Request>();
    const response = deferred<Response>();
    f.fetchRelay.mockImplementation(async req => { started.resolve(req); return response.promise; });
    const controller = new AbortController();
    const aborted = f.application.resolveLinkBrowserMaterial(session, cookie, controller.signal);
    const rejected = expect(aborted).rejects.toThrow("cancelled waiter");
    const refreshRequest = await started.promise;
    const active = f.application.resolveLinkBrowserMaterial(session, cookie, signal());
    controller.abort(new Error("cancelled waiter"));
    await rejected;
    expect(refreshRequest.signal.aborted).toBe(false);
    response.resolve(Response.json({ ok: true, grantId: "grant-alpha", capabilityToken: renewed, capabilityExpiresAtMs: 1_801_001 }));
    expect(await active).toMatchObject({ ok: true, capabilityToken: renewed });
    expect(f.fetchRelay).toHaveBeenCalledTimes(2);
  });

  it("does no work for an already aborted waiter", async () => {
    const f = fixture();
    const { session, cookie } = await f.exchange();
    f.setNow(901_001);
    const controller = new AbortController();
    controller.abort();
    await expect(f.application.resolveLinkBrowserMaterial(session, cookie, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.fetchRelay).toHaveBeenCalledTimes(1);
  });

  it("refuses a session evicted while its refresh is pending", async () => {
    const f = fixture({ maxSessions: 1 });
    const first = await f.exchange();
    f.setNow(601_001);
    const started = deferred<void>();
    const response = deferred<Response>();
    const defaultFetch = f.fetchRelay.getMockImplementation()!;
    f.fetchRelay.mockImplementation(async req => {
      if (new URL(req.url).pathname !== "/sync/link-refresh") return defaultFetch(req);
      started.resolve();
      return response.promise;
    });
    const material = f.application.resolveLinkBrowserMaterial(first.session, first.cookie, signal());
    await started.promise;
    await f.exchange();
    response.resolve(Response.json({ ok: true, grantId: "grant-alpha", capabilityToken: renewed, capabilityExpiresAtMs: 1_801_001 }));
    expect(await material).toEqual({ ok: false, status: 404 });
  });
});

it("retains a server handle through refresh and refuses expired or evicted sessions", async () => {
  const f = fixture({maxSessions: 1}), {session, cookie} = await f.exchange();
  const first = await f.application.resolveLinkBrowserMaterial(session, cookie, signal());
  if (!first.ok) throw Error("missing session");
  expect(await first.currentCapability()).toBe(capability);
  f.setNow(601_000);
  await f.application.resolveLinkBrowserMaterial(session, cookie, signal());
  expect(await first.currentCapability()).toBe(renewed);
  await f.exchange();
  expect(await first.currentCapability()).toBeNull();
});
