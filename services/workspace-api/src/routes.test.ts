import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_CSS_PATH, ACCOUNT_JS_PATH } from "./assets";
import type { ServerDescriptor } from "./config";
import type { ReadinessReport } from "./readiness";
import { createRouter, type AuthGateway, type RouterOptions } from "./routes";

const ORIGIN = "https://auth.example.com";
const SHARE = "https://share.example.com";

const READY: ReadinessReport = { ok: true, database: "ok", schema: "ok", missingTables: [] };
const DESCRIPTOR: ServerDescriptor = {
  authUrl: ORIGIN,
  relayUrl: ORIGIN,
  shareUrl: ORIGIN,
};

const SIGNED_IN = { user: { name: "Ada", email: "ada@example.com", emailVerified: true } };

/** A Better Auth stand-in: the routes only read sessions and claim device codes. */
function gateway(overrides: Partial<AuthGateway["api"]> = {}, handler?: AuthGateway["handler"]): AuthGateway {
  return {
    handler: handler ?? (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    api: {
      getSession: async () => null,
      deviceVerify: async () => ({ status: "pending" }),
      ...overrides,
    },
  };
}

function router(overrides: Partial<RouterOptions> = {}) {
  return createRouter({
    auth: gateway(),
    readiness: async () => READY,
    descriptor: DESCRIPTOR,
    emailTransport: "smtp",
    allowedOrigins: [ORIGIN, SHARE],
    ...overrides,
  });
}

function get(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

/** A Better Auth APIError carries its payload on `body`. */
class ApiError extends Error {
  constructor(readonly body: { error: string; error_description: string }) {
    super(body.error_description);
  }
}

describe("health and readiness", () => {
  it("answers liveness without touching Postgres", async () => {
    const response = await router()(get("/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "workspace-api" });
  });

  it("answers 200 when the database carries the auth schema", async () => {
    const response = await router()(get("/ready"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("answers 503 with the missing tables when the schema is incomplete", async () => {
    const response = await router({
      readiness: async () => ({
        ok: false,
        database: "ok",
        schema: "incomplete",
        missingTables: ["deviceCode"],
      }),
    })(get("/ready"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ missingTables: ["deviceCode"] });
  });
});

describe("server descriptor", () => {
  it("publishes the three public origins", async () => {
    const response = await router()(get("/.well-known/dohc-server"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      authUrl: ORIGIN,
      relayUrl: ORIGIN,
      shareUrl: ORIGIN,
    });
  });

  it("refuses to publish a half-configured descriptor", async () => {
    const response = await router({
      descriptor: { authUrl: ORIGIN, relayUrl: null, shareUrl: null },
    })(get("/.well-known/dohc-server"));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("SERVER_DESCRIPTOR_INCOMPLETE");
    expect(body.message).toContain("DOHC_SERVER_RELAY_URL");
    expect(body.message).toContain("DOHC_WEB_ORIGIN");
  });
});

describe("email delivery gate", () => {
  const routes = [
    "/api/auth/sign-up/email",
    "/api/auth/request-password-reset",
    "/api/auth/forget-password",
    "/api/auth/send-verification-email",
  ];

  it("refuses the routes that would send mail when no transport is configured", async () => {
    const handle = router({ emailTransport: "none" });
    for (const path of routes) {
      const response = await handle(get(path, { method: "POST", body: "{}" }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "EMAIL_DELIVERY_UNCONFIGURED" });
    }
  });

  it("leaves the rest of the auth surface working without a transport", async () => {
    const response = await router({ emailTransport: "none" })(
      get("/api/auth/sign-in/email", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(200);
  });

  it("passes the same routes through once a transport exists", async () => {
    const response = await router()(get(routes[0] as string, { method: "POST", body: "{}" }));
    expect(response.status).toBe(200);
  });
});

describe("cross-origin access", () => {
  it("answers a configured origin with credentialed CORS headers", async () => {
    const response = await router()(get("/api/auth/get-session", { headers: { origin: SHARE } }));
    expect(response.headers.get("access-control-allow-origin")).toBe(SHARE);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("gives an unconfigured origin no access", async () => {
    const response = await router()(
      get("/api/auth/get-session", { headers: { origin: "https://evil.example" } }),
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers a preflight from a configured origin", async () => {
    const response = await router()(
      get("/api/auth/sign-in/email", { method: "OPTIONS", headers: { origin: ORIGIN } }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
});

describe("account pages", () => {
  it("serves sign-in with a strict policy and no third-party asset", async () => {
    const response = await router()(get("/account/sign-in"));
    const body = await response.text();
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain(ACCOUNT_CSS_PATH);
    expect(body).toContain(ACCOUNT_JS_PATH);
    expect(body).not.toMatch(/https?:\/\/(?!localhost)/);
  });

  it("keeps a hostile next destination off the page", async () => {
    for (const next of ["https://evil.example", "//evil.example/path", "/\\evil.example/path"]) {
      const body = await (
        await router()(get(`/account/sign-in?next=${encodeURIComponent(next)}`))
      ).text();
      expect(body).not.toContain("evil.example");
      expect(body).not.toContain("data-next");
    }
  });

  it("carries a same-origin next destination through sign-in", async () => {
    const body = await (
      await router()(get("/account/sign-in?next=%2Fdevice%3Fuser_code%3DABCD-EFGH"))
    ).text();
    expect(body).toContain('data-next="/device?user_code=ABCD-EFGH"');
  });

  it("sends a signed-out visitor from the account page to sign-in", async () => {
    const response = await router()(get("/account"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/account/sign-in?next=%2Faccount");
  });

  it("shows the signed-in account", async () => {
    const response = await router({
      auth: gateway({ getSession: async () => SIGNED_IN }),
    })(get("/account"));
    expect(await response.text()).toContain("ada@example.com");
  });

  it("serves the reset page only as a token-carrying page", async () => {
    const withToken = await (await router()(get("/account/reset-password?token=abc"))).text();
    expect(withToken).toContain('data-token="abc"');
    const without = await (await router()(get("/account/reset-password"))).text();
    expect(without).toContain("This reset link is incomplete");
  });

  it("serves the hashed assets with a long-lived cache", async () => {
    const css = await router()(get(ACCOUNT_CSS_PATH));
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("cache-control")).toContain("immutable");
    const js = await router()(get(ACCOUNT_JS_PATH));
    expect(js.headers.get("content-type")).toContain("javascript");
  });
});

describe("device verification page", () => {
  it("asks for a code when the link carries none", async () => {
    const body = await (await router()(get("/device"))).text();
    expect(body).toContain("Enter the code from your device");
  });

  it("requires a signed-in account before claiming a code", async () => {
    const response = await router()(get("/device?user_code=ABCD-EFGH"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/account/sign-in?next=%2Fdevice%3Fuser_code%3DABCD-EFGH",
    );
  });

  it("claims the code for the signed-in account and offers the decision", async () => {
    const claimed: string[] = [];
    const response = await router({
      auth: gateway({
        getSession: async () => SIGNED_IN,
        deviceVerify: async ({ query }) => {
          claimed.push(query.user_code);
          return { status: "pending" };
        },
      }),
    })(get("/device?user_code=ABCD-EFGH"));
    const body = await response.text();
    expect(claimed).toEqual(["ABCD-EFGH"]);
    expect(body).toContain("ABCD-EFGH");
    expect(body).toContain("Approve");
    expect(body).toContain("Deny");
    expect(body).toContain("ada@example.com");
  });

  it("explains an expired code and offers no decision", async () => {
    const response = await router({
      auth: gateway({
        getSession: async () => SIGNED_IN,
        deviceVerify: async () => {
          throw new ApiError({ error: "expired_token", error_description: "User code has expired" });
        },
      }),
    })(get("/device?user_code=ABCD-EFGH"));
    const body = await response.text();
    expect(response.status).toBe(400);
    expect(body).toContain("expired");
    expect(body).not.toContain('id="approve"');
  });

  it("explains a code the server does not know", async () => {
    const body = await (
      await router({
        auth: gateway({
          getSession: async () => SIGNED_IN,
          deviceVerify: async () => {
            throw new ApiError({ error: "invalid_request", error_description: "Invalid user code" });
          },
        }),
      })(get("/device?user_code=NOPE"))
    ).text();
    expect(body).toContain("does not know that code");
  });

  it("does not offer a second decision on a handled code", async () => {
    const body = await (
      await router({
        auth: gateway({
          getSession: async () => SIGNED_IN,
          deviceVerify: async () => ({ status: "approved" }),
        }),
      })(get("/device?user_code=ABCD-EFGH"))
    ).text();
    expect(body).toContain("already used");
    expect(body).not.toContain('id="approve"');
  });
});

describe("test seams", () => {
  it("has no device approval seam and no captured mail by default", async () => {
    const handle = router();
    expect((await handle(get("/test/device/approve", { method: "POST", body: "{}" }))).status).toBe(404);
    expect((await handle(get("/test/email/messages"))).status).toBe(404);
  });

  it("exposes captured mail only when the caller supplied a capture seam", async () => {
    const response = await router({
      seams: { sentEmails: () => [{ to: "ada@example.com", subject: "Verify", text: "link" }] },
    })(get("/test/email/messages"));
    expect(await response.json()).toMatchObject({ messages: [{ to: "ada@example.com" }] });
  });
});

describe("unexpected failures", () => {
  it("answers with a generic error and keeps the link out of the log", async () => {
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    const response = await router({
      auth: gateway({
        getSession: async () => {
          throw new Error("the database went away");
        },
      }),
    })(get("/account?token=a-live-credential"));
    spy.mockRestore();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "internal error" });
    expect(JSON.stringify(logged)).not.toContain("a-live-credential");
    expect(JSON.stringify(logged)).toContain("request failed");
  });
});

describe("unknown routes", () => {
  it("answers an unknown API path with JSON", async () => {
    const response = await router()(get("/api/nope"));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("answers an unknown page with HTML", async () => {
    const response = await router()(get("/nope"));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});
