import { describe, expect, it } from "vitest";
import { withCors } from "./cors";

const okHandler = async () =>
  new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
  });

const WEB = "https://cloud.dohc.test";

describe("withCors (DOHC_WEB_ORIGIN gate)", () => {
  it("emits NO CORS headers when no web origin is configured (desktop Bearer flow unchanged)", async () => {
    const handler = withCors(okHandler, undefined);
    const response = await handler(
      new Request("http://api.test/health", { headers: { origin: WEB } }),
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("adds credentialed CORS headers ONLY for the configured origin", async () => {
    const handler = withCors(okHandler, WEB);

    const allowed = await handler(new Request("http://api.test/x", { headers: { origin: WEB } }));
    expect(allowed.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
    expect(allowed.headers.get("vary")).toBe("Origin");
    await expect(allowed.json()).resolves.toEqual({ ok: true });

    const evil = await handler(
      new Request("http://api.test/x", { headers: { origin: "https://evil.example" } }),
    );
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();

    const sameOrigin = await handler(new Request("http://api.test/x"));
    expect(sameOrigin.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers the preflight for the configured origin", async () => {
    const handler = withCors(okHandler, WEB);
    const preflight = await handler(
      new Request("http://api.test/workspaces", {
        method: "OPTIONS",
        headers: {
          origin: WEB,
          "access-control-request-method": "GET",
          "access-control-request-headers": "content-type",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type");
  });

  it("preserves existing Vary values when adding Origin", async () => {
    const handler = withCors(
      async () => new Response("ok", { headers: { vary: "Accept-Encoding" } }),
      WEB,
    );
    const response = await handler(
      new Request("http://api.test/x", { headers: { origin: WEB } }),
    );
    const vary = response.headers.get("vary")?.split(",").map((value) => value.trim());
    expect(vary).toEqual(expect.arrayContaining(["Accept-Encoding", "Origin"]));
  });
});
