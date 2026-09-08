import { getCookies } from "better-auth/cookies";
import { describe, expect, it, vi } from "vitest";
import { createAccountAuthHandler } from "./accountAuth";
import { createShareWebApplication } from "./server";

const origin = "https://share.example.test";
const accountAuth = { publicOrigin: origin, upstreamUrl: "http://workspace-api:1786" };
const cookies = getCookies({ baseURL: origin });
const sessionCookie = `${cookies.sessionToken.name}=signed-token; Path=/; HttpOnly; Secure; SameSite=Lax`;
const user = { id: "actual-user", name: "Reader" };

function request(operation: string, init: RequestInit = {}): Request {
  const headers = new Headers({ host: "share.example.test", origin, "content-type": "application/json" });
  for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  return new Request(`${origin}/api/account/${operation}`, {
    method: operation === "session" ? "GET" : "POST",
    ...(operation !== "session" ? { body: operation === "sign-in" ? JSON.stringify({ email: "reader@example.test", password: "password" }) : "{}" } : {}),
    ...init, headers,
  });
}

function upstreamSignIn(cookie = sessionCookie): Response {
  return Response.json({ user: { ...user, email: "reader@example.test" }, token: "secret-body", redirect: false }, {
    headers: { "set-cookie": cookie, "set-auth-token": "secret-header", "access-control-allow-origin": "*" },
  });
}

function handler(fetchAuth: (request: Request) => Promise<Response>) {
  return createShareWebApplication({
    relayUrl: "http://relay:1788", publicRelayUrl: "https://relay.example.test",
    publicHosts: new Set(["share.example.test"]), accountAuth, fetchAuth,
    fetchRelay: async () => { throw new Error("account route reached link relay"); },
  }).handle;
}

describe("browser account transport", () => {
  it("forwards only the verified single client address despite forged browser forwarding headers", async () => {
    const observed: Array<string | null> = [];
    const serve = handler(async (upstream) => {
      observed.push(upstream.headers.get("x-forwarded-for"));
      for (const name of ["x-dohc-share-web-client-ip", "forwarded", "x-real-ip", "cf-connecting-ip"]) {
        expect(upstream.headers.has(name)).toBe(false);
      }
      return Response.json(null);
    });
    for (const address of ["198.51.100.23", "198.51.100.24", "2001:db8:abcd::1"]) {
      for (const forged of ["203.0.113.9", "203.0.113.10, 203.0.113.11"]) {
        expect((await serve(request("session", { headers: {
          "x-dohc-share-web-client-ip": address, "x-forwarded-for": forged,
          forwarded: "for=203.0.113.9", "x-real-ip": "203.0.113.9", "cf-connecting-ip": "203.0.113.9",
        } }))).status).toBe(200);
      }
    }
    expect(observed).toEqual(["198.51.100.23", "198.51.100.23", "198.51.100.24", "198.51.100.24", "2001:db8:abcd::1", "2001:db8:abcd::1"]);
  });

  it.each([undefined, "unknown", "198.51.100.23, 198.51.100.24", "198.51.100.23:8080", "[2001:db8::1]", "fe80::1%eth0"])(
    "does not substitute claimed browser identity for invalid verified address %j", async (address) => {
      const fetchAuth = vi.fn(async (upstream: Request) => {
        expect(upstream.headers.has("x-forwarded-for")).toBe(false);
        return Response.json(null);
      });
      const input = request("session", { headers: { "x-forwarded-for": "203.0.113.9" } });
      if (address !== undefined) input.headers.set("x-dohc-share-web-client-ip", address);
      expect((await handler(fetchAuth)(input)).status).toBe(200);
      expect(fetchAuth).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["x-retry-after", "10"], ["retry-after", "10"], ["x-retry-after", "0"], ["x-retry-after", "9007199254740991"],
  ])("preserves throttling with a bounded %s delay %s and no upstream data", async (name, delay) => {
    const result = await handler(async () => new Response("secret-limit-body", { status: 429, headers: {
      [name]: delay!, "set-cookie": sessionCookie, "set-auth-token": "secret-token", location: "https://evil.test",
    } }))(request("sign-in"));
    expect(result.status).toBe(429);
    expect(result.headers.get("retry-after")).toBe(delay);
    expect(result.headers.get("x-retry-after")).toBeNull();
    expect(result.headers.get("location")).toBeNull();
    expect(result.headers.get("set-auth-token")).toBeNull();
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(await result.json()).toEqual({ ok: false });
  });

  it.each([null, "-1", "1.5", "1e3", "10, 20", "secret", "9007199254740992", "9".repeat(1000)])(
    "omits invalid or unbounded retry delay %j while preserving throttling", async (delay) => {
      const result = await handler(async () => new Response("secret", {
        status: 429, headers: delay === null ? {} : { "x-retry-after": delay },
      }))(request("sign-in"));
      expect(result.status).toBe(429);
      expect(result.headers.get("retry-after")).toBeNull();
      expect(await result.json()).toEqual({ ok: false });
    },
  );

  it("handles account routes before viewer sessions and forwards only account credentials", async () => {
    const fetchAuth = vi.fn(async (upstream: Request) => {
      expect(upstream.url).toBe("http://workspace-api:1786/api/auth/sign-in/email");
      expect(upstream.redirect).toBe("manual");
      expect(Object.fromEntries(upstream.headers)).toEqual({
        accept: "application/json", "content-type": "application/json",
        cookie: `${cookies.sessionToken.name}=existing`, origin,
        "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors",
      });
      expect(await upstream.json()).toEqual({ email: "reader@example.test", password: "password" });
      return upstreamSignIn();
    });
    const result = await handler(fetchAuth)(request("sign-in", { headers: {
      cookie: `dohc_share_link=link-secret; ${cookies.sessionToken.name}=existing; dohc_profile=profile-secret`,
      authorization: "Bearer claimed-user", "x-user-id": "claimed-user",
      "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors",
    } }));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true, user });
    expect(result.headers.getSetCookie()).toEqual([sessionCookie]);
    expect(result.headers.get("set-auth-token")).toBeNull();
    expect(result.headers.get("access-control-allow-origin")).toBeNull();
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(fetchAuth).toHaveBeenCalledOnce();
  });

  it.each(["https://evil.test", "null", `${origin}, https://evil.test`, "", `${origin}/`])(
    "refuses sign-in Origin %j before forwarding", async (value) => {
      const fetchAuth = vi.fn(async () => upstreamSignIn());
      const input = request("sign-in", { headers: { origin: value } });
      if (!value) input.headers.delete("origin");
      expect((await handler(fetchAuth)(input)).status).toBe(404);
      expect(fetchAuth).not.toHaveBeenCalled();
    },
  );

  it("refuses wrong Host, cross-site metadata, non-JSON, unknown fields and arbitrary routes", async () => {
    const fetchAuth = vi.fn(async () => upstreamSignIn());
    const serve = handler(fetchAuth);
    for (const input of [
      request("sign-in", { headers: { host: "other.example.test" } }),
      request("sign-in", { headers: { "sec-fetch-site": "cross-site" } }),
      request("sign-in", { headers: { "content-type": "application/x-www-form-urlencoded" } }),
      request("sign-in", { body: JSON.stringify({ email: "a", password: "b", callbackURL: "https://evil.test" }) }),
      request("sign-in?target=https://evil.test"), request("sign-up"),
      request("session", { headers: { origin: "https://evil.test" } }),
      request("sign-out", { method: "GET", body: undefined }),
    ]) expect((await serve(input)).status).toBe(404);
    expect(fetchAuth).not.toHaveBeenCalled();
  });

  it("keeps account routes disabled in existing view-only configurations", async () => {
    const { handle: serve } = createShareWebApplication({ relayUrl: "http://relay:1788", publicRelayUrl: "http://relay:1788", publicHosts: new Set(["share.example.test"]) });
    expect((await serve(request("session"))).status).toBe(404);
  });

  it("projects session reads without a token and expires only account cookies at sign-out", async () => {
    const cleared = `${cookies.sessionToken.name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
    const fetchAuth = vi.fn(async (upstream: Request) => {
      if (upstream.url.endsWith("get-session")) return Response.json({ user, session: { userId: user.id, token: "session-secret" } });
      expect(await upstream.json()).toEqual({});
      return Response.json({ success: true }, { headers: { "set-cookie": cleared } });
    });
    expect(await (await handler(fetchAuth)(request("session"))).json()).toEqual({ user });
    const result = await handler(fetchAuth)(request("sign-out"));
    expect(await result.json()).toEqual({ ok: true });
    expect(result.headers.getSetCookie()).toEqual([cleared]);
  });

  it("supports an unauthenticated session read without creating a viewer session", async () => {
    const result = await handler(async () => Response.json(null))(request("session"));
    expect(await result.json()).toEqual({ user: null });
    expect(result.headers.getSetCookie()).toEqual([]);
  });

  it.each([
    sessionCookie.replace("; Secure", ""),
    `${sessionCookie}; Domain=example.test`,
    sessionCookie.replace("Path=/", "Path=/api/auth"),
    sessionCookie.replace("HttpOnly", "SameParty"),
    sessionCookie.replace("SameSite=Lax", "SameSite=None"),
    sessionCookie.replace(cookies.sessionToken.name, "dohc_link_profile"),
    sessionCookie.replace(cookies.sessionToken.name, "better-auth.session_token"),
  ])("rejects an unsafe upstream cookie without exposing it", async (cookie) => {
    const result = await handler(async () => upstreamSignIn(cookie))(request("sign-in"));
    expect(result.status).toBe(503);
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(await result.json()).toEqual({ ok: false });
  });

  it("refuses malformed responses, redirects and upstream failures without disclosing upstream data", async () => {
    for (const upstream of [
      new Response("secret-error", { status: 500 }),
      new Response("bad-password-secret", { status: 401 }),
      new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
      Response.json({ user, token: "secret" }),
      Response.json({ user: { id: "bad" } }, { headers: { "set-cookie": sessionCookie } }),
      new Response("{invalid", { headers: { "content-type": "application/json", "set-cookie": sessionCookie } }),
    ]) {
      const result = await handler(async () => upstream)(request("sign-in"));
      expect([401, 503]).toContain(result.status);
      expect(await result.json()).toEqual({ ok: false });
      expect(result.headers.getSetCookie()).toEqual([]);
    }
    expect((await handler(async () => { throw new Error("upstream secret"); })(request("session"))).status).toBe(503);
  });

  it("refuses invalid UTF-8 without repairing request credentials or upstream identity", async () => {
    const invalid = (prefix: string, suffix: string) => Buffer.concat([Buffer.from(prefix), Buffer.from([255]), Buffer.from(suffix)]);
    const fetchAuth = vi.fn(async () => upstreamSignIn());
    const serve = handler(fetchAuth);
    const response = await serve(request("sign-in", { body: invalid('{"email":"reader@example.test","password":"', '"}') }));
    expect(response.status).toBe(404);
    expect(fetchAuth).not.toHaveBeenCalled();
    const invalidResponse = await handler(async () => new Response(invalid('{"user":{"id":"reader","name":"', '"}}'), {
      headers: { "content-type": "application/json" },
    }))(request("session"));
    expect(invalidResponse.status).toBe(503);
    expect(await invalidResponse.json()).toEqual({ ok: false });
  });

  it("bounds both bodies and cancels an aborted upstream response", async () => {
    const fetchAuth = vi.fn(async () => upstreamSignIn());
    const small = createAccountAuthHandler({ ...accountAuth, fetchAuth, maxRequestBytes: 8, maxResponseBytes: 8, timeoutMs: 10_000 });
    expect((await small(request("sign-in"))).status).toBe(404);
    expect(fetchAuth).not.toHaveBeenCalled();
    expect((await small(request("session"))).status).toBe(503);

    const controller = new AbortController();
    const cancel = vi.fn();
    let observedSignal: AbortSignal | undefined;
    const serve = handler(async (upstream) => {
      observedSignal = upstream.signal;
      return new Response(new ReadableStream({
        start: () => controller.abort(), cancel,
      }), { headers: { "content-type": "application/json" } });
    });
    expect((await serve(request("session", { signal: controller.signal }))).status).toBe(503);
    expect(observedSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
