import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadShareWebConfig } from "./config";
import {
  createShareWebApplication,
  type CreateShareWebApplicationOptions,
  EXCHANGE_BUCKET_CAPACITY,
  LINK_SESSION_RENEWAL_GRACE_MS,
  MAX_SESSIONS_PER_GRANT,
  SHARE_WEB_CSP,
  shareWebRefusalBody,
} from "./server";

const HOST = "share.example.test";
const CAP_ALPHA_1 = Buffer.alloc(32, 1).toString("base64url");
const CAP_ALPHA_2 = Buffer.alloc(32, 2).toString("base64url");
const CAP_BETA = Buffer.alloc(32, 3).toString("base64url");
const SECRET_ALPHA = Buffer.alloc(32, 11).toString("base64url");
const SECRET_ALPHA_ROTATED = Buffer.alloc(32, 12).toString("base64url");
const SECRET_BETA = Buffer.alloc(32, 13).toString("base64url");
const PROFILE_ALPHA = Buffer.alloc(32, 14).toString("base64url");
const PROFILE_BETA = Buffer.alloc(32, 15).toString("base64url");
const HANDOFF_CODE = Buffer.alloc(32, 31).toString("base64url");
const HANDOFF_EXCHANGE_KEY = "share-web-to-relay-handoff-exchange-key";
const PUBLIC_RELAY_URL = "https://relay.public.test";

function createShareWebHandler(
  options: Omit<CreateShareWebApplicationOptions, "publicRelayUrl"> & {
    publicRelayUrl?: string;
  },
): ReturnType<typeof createShareWebApplication>["handle"] {
  return createShareWebApplication({ publicRelayUrl: PUBLIC_RELAY_URL, ...options }).handle;
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", HOST);
  return new Request(`https://${HOST}${path}`, { ...init, headers });
}

function exchange(secret: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret }),
  };
}

function cookiePair(response: Response): string {
  const pair = cookiePairs(response).find(
    (cookie) =>
      cookie.startsWith("dohc_share_") &&
      !cookie.startsWith("dohc_share_profile_"),
  );
  if (!pair) throw new Error("viewer session cookie is missing");
  return pair;
}

function profileCookiePair(response: Response): string {
  const pair = cookiePairs(response).find((cookie) =>
    cookie.startsWith("dohc_share_profile_"),
  );
  if (!pair) throw new Error("protected profile cookie is missing");
  return pair;
}

function cookiePairs(response: Response): string[] {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0]!);
}

function cookieHeader(...pairs: Array<string | undefined>): string {
  return pairs.filter((pair): pair is string => pair !== undefined).join("; ");
}

function capacityTestHandler(maxSessions: number): {
  handler: ReturnType<typeof createShareWebHandler>;
  exchangeFrom: (secret: string, clientId: number) => Promise<Response>;
} {
  let capabilityId = 0;
  let sessionId = 0;
  const token = (id: number): string => {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32BE(id, bytes.length - 4);
    return bytes.toString("base64url");
  };
  const relay = async (relayRequest: Request): Promise<Response> => {
    if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
      const { secret } = (await relayRequest.json()) as { secret: string };
      return Response.json({
        ok: true,
        grantId: secret === SECRET_BETA ? "grant-beta" : "grant-alpha",
        capabilityToken: token(++capabilityId),
        capabilityExpiresAtMs: 901_000,
      });
    }
    return Response.json({ ok: true });
  };
  const handler = createShareWebHandler({
    relayUrl: "http://relay.test",
    publicHosts: new Set([HOST]),
    fetchRelay: relay,
    nowMs: () => 1_000,
    newSessionToken: () => token(++sessionId),
    maxSessions,
  });
  return {
    handler,
    exchangeFrom: async (secret, clientId) => {
      const exchangeRequest = request("/api/exchange", exchange(secret));
      exchangeRequest.headers.set("x-dohc-share-web-client-ip", `client-${clientId}`);
      return await handler(exchangeRequest);
    },
  };
}

function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get("content-security-policy")).toBe(SHARE_WEB_CSP);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("share-web sessions", () => {
  it("keeps valid and garbage viewer entries uniformly unindexable", async () => {
    const viewerAssetsDir = await mkdtemp(join(tmpdir(), "dohc-share-web-unfurl-"));
    try {
      await writeFile(
        join(viewerAssetsDir, "index.html"),
        "<!doctype html><title>dohc shared work</title><main id=\"root\"></main>",
      );
      const handler = createShareWebHandler({
        relayUrl: "http://relay.test",
        publicHosts: new Set([HOST]),
        fetchRelay: vi.fn(),
        viewerAssetsDir,
      });
      const valid = await handler(
        request("/s/abcdefghijkl", { headers: { "user-agent": "ExampleBot/1.0" } }),
      );
      const garbage = await handler(
        request("/s/not-a-session", { headers: { "user-agent": "Mozilla/5.0" } }),
      );

      expect(valid.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
      expect(garbage.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
      expect(await valid.text()).toBe(await garbage.text());
    } finally {
      await rm(viewerAssetsDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      description: "a mixed-case configured host with a lowercase Host header",
      configuredHost: "Share.Example.Test",
      incomingHost: HOST,
    },
    {
      description: "a lowercase configured host with a mixed-case Host header",
      configuredHost: HOST,
      incomingHost: "Share.Example.Test",
    },
  ])("serves $description", async ({ configuredHost, incomingHost }) => {
    const { publicHosts } = loadShareWebConfig({
      NODE_ENV: "test",
      DOHC_SHARE_WEB_RELAY_URL: "http://relay.test",
      DOHC_SHARE_WEB_PUBLIC_RELAY_URL: PUBLIC_RELAY_URL,
      DOHC_SHARE_WEB_PUBLIC_HOSTS: configuredHost,
    });
    const fetchRelay = vi.fn(async () =>
      Response.json({
        ok: true,
        grantId: "grant-host-case",
        capabilityToken: CAP_ALPHA_1,
        capabilityExpiresAtMs: 901_000,
      }),
    );
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      publicHosts,
      fetchRelay,
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 21).toString("base64url"),
    });
    const headers = new Headers(exchange(SECRET_ALPHA).headers);
    headers.set("host", incomingHost);

    const response = await handler(
      new Request(`https://${HOST}/api/exchange`, {
        ...exchange(SECRET_ALPHA),
        headers,
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchRelay).toHaveBeenCalledOnce();
  });

  it("identifies exchange requests to the relay with the configured key", async () => {
    const relayExchangeKey = "share-web-to-relay-test-exchange-key";
    const clientAddress = "198.51.100.23";
    let receivedRelayExchangeKey: string | null = null;
    let receivedClientAddress: string | null = null;
    const relay = async (relayRequest: Request): Promise<Response> => {
      expect(new URL(relayRequest.url).pathname).toBe("/sync/link-exchange");
      receivedRelayExchangeKey = relayRequest.headers.get(
        "x-dohc-relay-exchange-key",
      );
      receivedClientAddress = relayRequest.headers.get("x-dohc-relay-client-ip");
      return Response.json({
        ok: true,
        grantId: "grant-alpha",
        capabilityToken: CAP_ALPHA_1,
        capabilityExpiresAtMs: 901_000,
      });
    };
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey,
      publicHosts: new Set([HOST]),
      fetchRelay: relay,
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 21).toString("base64url"),
    });

    const exchangeRequest = request("/api/exchange", exchange(SECRET_ALPHA));
    exchangeRequest.headers.set("x-dohc-share-web-client-ip", clientAddress);
    const exchanged = await handler(exchangeRequest);

    expect(exchanged.status).toBe(200);
    expect(receivedRelayExchangeKey).toBe(relayExchangeKey);
    expect(receivedClientAddress).toBe(clientAddress);
  });

  it("keeps two link sessions distinct when one link rotates", async () => {
    let alphaGeneration = 1;
    let tokenId = 0;
    const relay = async (relayRequest: Request): Promise<Response> => {
      const url = new URL(relayRequest.url);
      if (url.pathname === "/sync/link-exchange") {
        const { secret } = (await relayRequest.json()) as { secret: string };
        if (secret === SECRET_ALPHA && alphaGeneration === 1) {
          return Response.json({
            ok: true,
            grantId: "grant-alpha",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        if (secret === SECRET_ALPHA_ROTATED && alphaGeneration === 2) {
          return Response.json({
            ok: true,
            grantId: "grant-alpha",
            capabilityToken: CAP_ALPHA_2,
            capabilityExpiresAtMs: 901_000,
          });
        }
        if (secret === SECRET_BETA) {
          return Response.json({
            ok: true,
            grantId: "grant-beta",
            capabilityToken: CAP_BETA,
            capabilityExpiresAtMs: 901_000,
          });
        }
        return Response.json({ ok: false, error: "not found" }, { status: 404 });
      }

      const capability = relayRequest.headers.get("authorization");
      if (capability === `LinkCapability ${CAP_ALPHA_1}` && alphaGeneration === 1) {
        return Response.json({ ok: true, access: "view", granterEmail: "alpha@example.test" });
      }
      if (capability === `LinkCapability ${CAP_ALPHA_2}`) {
        return Response.json({ ok: true, access: "view", granterEmail: "alpha@example.test" });
      }
      if (capability === `LinkCapability ${CAP_BETA}`) {
        return Response.json({ ok: true, access: "comment", granterEmail: "beta@example.test" });
      }
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    };
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      publicHosts: new Set([HOST]),
      fetchRelay: relay,
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, ++tokenId).toString("base64url"),
    });

    const alphaExchange = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const betaExchange = await handler(request("/api/exchange", exchange(SECRET_BETA)));
    const alpha = (await alphaExchange.json()) as { session: string };
    const beta = (await betaExchange.json()) as { session: string };
    const alphaCookie = cookiePair(alphaExchange);
    const betaCookie = cookiePair(betaExchange);

    expect(alphaCookie.split("=", 1)[0]).not.toBe(betaCookie.split("=", 1)[0]);
    const bothCookies = `${alphaCookie}; ${betaCookie}`;
    const alphaMeta = await handler(
      request("/api/view/meta", {
        headers: { cookie: bothCookies, "x-dohc-link-session": alpha.session },
      }),
    );
    const betaMeta = await handler(
      request("/api/view/meta", {
        headers: { cookie: bothCookies, "x-dohc-link-session": beta.session },
      }),
    );
    expect(await alphaMeta.json()).toMatchObject({ granterEmail: "alpha@example.test" });
    expect(await betaMeta.json()).toMatchObject({ granterEmail: "beta@example.test" });

    alphaGeneration = 2;
    const rotatedExchange = await handler(
      request("/api/exchange", exchange(SECRET_ALPHA_ROTATED)),
    );
    const rotated = (await rotatedExchange.json()) as { session: string };
    const rotatedAlphaCookie = cookiePair(rotatedExchange);
    expect(rotatedAlphaCookie.split("=", 1)[0]).toBe(alphaCookie.split("=", 1)[0]);
    const rotatedCookies = `${rotatedAlphaCookie}; ${betaCookie}`;

    const rotatedAlphaMeta = await handler(
      request("/api/view/meta", {
        headers: { cookie: rotatedCookies, "x-dohc-link-session": rotated.session },
      }),
    );
    const betaAfterRotation = await handler(
      request("/api/view/meta", {
        headers: { cookie: rotatedCookies, "x-dohc-link-session": beta.session },
      }),
    );
    expect(rotatedAlphaMeta.status).toBe(200);
    expect(await betaAfterRotation.json()).toMatchObject({ granterEmail: "beta@example.test" });
  });

  it("evicts a full grant's oldest session before another grant's session", async () => {
    const { handler, exchangeFrom } = capacityTestHandler(
      MAX_SESSIONS_PER_GRANT + 1,
    );

    const betaExchange = await exchangeFrom(SECRET_BETA, 0);
    const beta = (await betaExchange.json()) as { session: string };
    const betaCookie = cookiePair(betaExchange);
    let oldestAlpha: { cookie: string; session: string } | null = null;
    for (let index = 0; index < MAX_SESSIONS_PER_GRANT; index += 1) {
      const alphaExchange = await exchangeFrom(SECRET_ALPHA, index + 1);
      if (index === 0) {
        oldestAlpha = {
          cookie: cookiePair(alphaExchange),
          session: ((await alphaExchange.json()) as { session: string }).session,
        };
      }
    }
    expect(oldestAlpha).not.toBeNull();

    await exchangeFrom(SECRET_ALPHA, MAX_SESSIONS_PER_GRANT + 1);

    const betaView = await handler(
      request("/api/view/meta", {
        headers: { cookie: betaCookie, "x-dohc-link-session": beta.session },
      }),
    );
    expect(betaView.status).toBe(200);
    const oldestAlphaView = await handler(
      request("/api/view/meta", {
        headers: {
          cookie: oldestAlpha!.cookie,
          "x-dohc-link-session": oldestAlpha!.session,
        },
      }),
    );
    expect(oldestAlphaView.status).toBe(404);
  });

  it("uses the largest grant for global-cap backstop eviction", async () => {
    const { handler, exchangeFrom } = capacityTestHandler(4);
    const betaExchange = await exchangeFrom(SECRET_BETA, 0);
    const beta = (await betaExchange.json()) as { session: string };
    const betaCookie = cookiePair(betaExchange);
    let oldestAlpha: { cookie: string; session: string } | null = null;
    for (let index = 0; index < 3; index += 1) {
      const alphaExchange = await exchangeFrom(SECRET_ALPHA, index + 1);
      if (index === 0) {
        oldestAlpha = {
          cookie: cookiePair(alphaExchange),
          session: ((await alphaExchange.json()) as { session: string }).session,
        };
      }
    }
    expect(oldestAlpha).not.toBeNull();

    await exchangeFrom(SECRET_BETA, 4);

    expect(
      (
        await handler(
          request("/api/view/meta", {
            headers: { cookie: betaCookie, "x-dohc-link-session": beta.session },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handler(
          request("/api/view/meta", {
            headers: {
              cookie: oldestAlpha!.cookie,
              "x-dohc-link-session": oldestAlpha!.session,
            },
          }),
        )
      ).status,
    ).toBe(404);
  });

  it("mints the required host-only cookie and keeps relay capability data server-side", async () => {
    const relayRequests: Request[] = [];
    const relay = async (relayRequest: Request): Promise<Response> => {
      relayRequests.push(relayRequest.clone());
      if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
        return Response.json({
          ok: true,
          grantId: "grant-alpha",
          capabilityToken: CAP_ALPHA_1,
          capabilityExpiresAtMs: 901_000,
        });
      }
      expect(relayRequest.headers.get("authorization")).toBe(
        `LinkCapability ${CAP_ALPHA_1}`,
      );
      return Response.json({
        ok: true,
        access: "view",
        lastSettledAtMs: 800_000,
        granterEmail: "owner@example.test",
      });
    };
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      publicHosts: new Set([HOST]),
      fetchRelay: relay,
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 20).toString("base64url"),
    });

    const exchanged = await handler(
      request("/api/exchange", exchange(SECRET_ALPHA)),
    );
    expect(exchanged.status).toBe(200);
    expectSecurityHeaders(exchanged);
    const setCookie = exchanged.headers.get("set-cookie")!;
    expect(setCookie).toContain("; Path=/;");
    expect(setCookie).toContain("; Secure;");
    expect(setCookie).toContain("; HttpOnly;");
    expect(setCookie).toContain("; SameSite=Strict");
    expect(setCookie).not.toMatch(/(?:^|;)\s*Domain=/iu);
    const cookieToken = cookiePair(exchanged).split("=", 2)[1]!;
    expect(Buffer.from(cookieToken, "base64url")).toHaveLength(32);
    const body = (await exchanged.json()) as { session: string };
    expect(JSON.stringify(body)).not.toContain(CAP_ALPHA_1);

    const meta = await handler(
      request("/api/view/meta", {
        headers: {
          cookie: cookiePair(exchanged),
          "x-dohc-link-session": body.session,
        },
      }),
    );
    expect(meta.status).toBe(200);
    expect(meta.headers.get("cache-control")).toBe("private, no-store");
    expectSecurityHeaders(meta);
    expect(await meta.json()).toMatchObject({ granterEmail: "owner@example.test" });
    expect(relayRequests).toHaveLength(2);

    const logged = [...info.mock.calls, ...errors.mock.calls].flat().map(String).join("\n");
    expect(logged).not.toContain(SECRET_ALPHA);
    expect(logged).not.toContain(CAP_ALPHA_1);
  });

  it("renews an active session before expiry and keeps it usable past the old expiry", async () => {
    const relayExchangeKey = "share-web-to-relay-refresh-exchange-key";
    let now = 1_000;
    let refreshCalls = 0;
    const readCapabilities: string[] = [];
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey,
      publicHosts: new Set([HOST]),
      nowMs: () => now,
      newSessionToken: () => Buffer.alloc(32, 26).toString("base64url"),
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        if (pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-renewed",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        if (pathname === "/sync/link-refresh") {
          refreshCalls += 1;
          expect(relayRequest.method).toBe("POST");
          expect(relayRequest.headers.get("authorization")).toBe(
            `LinkCapability ${CAP_ALPHA_1}`,
          );
          expect(relayRequest.headers.get("x-dohc-relay-exchange-key")).toBe(
            relayExchangeKey,
          );
          expect(await relayRequest.text()).toBe("");
          return Response.json({
            ok: true,
            grantId: "grant-renewed",
            capabilityToken: CAP_ALPHA_2,
            capabilityExpiresAtMs: now + 900_000,
          });
        }
        const authorization = relayRequest.headers.get("authorization") ?? "";
        readCapabilities.push(authorization);
        if (
          authorization === `LinkCapability ${CAP_ALPHA_1}` ||
          authorization === `LinkCapability ${CAP_ALPHA_2}`
        ) {
          return Response.json({ ok: true, access: "view" });
        }
        return new Response("relay capability refusal", { status: 401 });
      },
    });

    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const body = (await exchanged.json()) as { session: string };
    const sessionHeaders = {
      cookie: cookiePair(exchanged),
      "x-dohc-link-session": body.session,
    };

    now = 601_001;
    const renewed = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );
    expect(renewed.status).toBe(200);

    now = 901_001;
    const afterOldExpiry = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );
    expect(afterOldExpiry.status).toBe(200);
    expect(refreshCalls).toBe(1);
    expect(readCapabilities).toEqual([
      `LinkCapability ${CAP_ALPHA_2}`,
      `LinkCapability ${CAP_ALPHA_2}`,
    ]);
    expect(cookiePair(renewed)).toBe(sessionHeaders.cookie);
    expect(renewed.headers.get("set-cookie")).toContain("Max-Age=605700");
  });

  it("renews an expired session after a suspended tab wakes", async () => {
    expect(LINK_SESSION_RENEWAL_GRACE_MS).toBe(7 * 24 * 60 * 60 * 1_000);
    const relayExchangeKey = "share-web-to-relay-refresh-exchange-key";
    let now = 1_000;
    let exchangeCalls = 0;
    let sessionTokenId = 27;
    const relayOrder: string[] = [];
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey,
      publicHosts: new Set([HOST]),
      nowMs: () => now,
      newSessionToken: () => Buffer.alloc(32, sessionTokenId++).toString("base64url"),
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        if (pathname === "/sync/link-exchange") {
          exchangeCalls += 1;
          return Response.json({
            ok: true,
            grantId: "grant-suspended-tab",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: exchangeCalls === 1 ? 901_000 : now + 900_000,
          });
        }
        if (pathname === "/sync/link-refresh") {
          relayOrder.push("refresh");
          expect(relayRequest.headers.get("authorization")).toBe(
            `LinkCapability ${CAP_ALPHA_1}`,
          );
          return Response.json({
            ok: true,
            grantId: "grant-suspended-tab",
            capabilityToken: CAP_ALPHA_2,
            capabilityExpiresAtMs: now + 900_000,
          });
        }
        relayOrder.push("read");
        expect(relayRequest.headers.get("authorization")).toBe(
          `LinkCapability ${CAP_ALPHA_2}`,
        );
        return Response.json({ ok: true, access: "view" });
      },
    });

    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const body = (await exchanged.json()) as { session: string };
    const sessionHeaders = {
      cookie: cookiePair(exchanged),
      "x-dohc-link-session": body.session,
    };
    now += 20 * 60 * 1_000;
    expect(
      (await handler(request("/api/exchange", exchange(SECRET_BETA)))).status,
    ).toBe(200);

    const renewed = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );
    const stillUsable = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );

    expect([renewed.status, stillUsable.status]).toEqual([200, 200]);
    expect(relayOrder).toEqual(["refresh", "read", "read"]);
    expect(exchanged.headers.get("set-cookie")).toContain("Max-Age=605700");
    expect(cookiePair(renewed)).toBe(sessionHeaders.cookie);
    expect(renewed.headers.get("set-cookie")).toContain("Max-Age=605700");
  });

  it("shares one capability refresh across concurrent near-expiry views", async () => {
    let now = 1_000;
    let refreshCalls = 0;
    let readCalls = 0;
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "share-web-to-relay-refresh-exchange-key",
      publicHosts: new Set([HOST]),
      nowMs: () => now,
      newSessionToken: () => Buffer.alloc(32, 28).toString("base64url"),
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        if (pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-concurrent-refresh",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        if (pathname === "/sync/link-refresh") {
          refreshCalls += 1;
          await refreshGate;
          return Response.json({
            ok: true,
            grantId: "grant-concurrent-refresh",
            capabilityToken: CAP_ALPHA_2,
            capabilityExpiresAtMs: now + 900_000,
          });
        }
        readCalls += 1;
        expect(relayRequest.headers.get("authorization")).toBe(
          `LinkCapability ${CAP_ALPHA_2}`,
        );
        return Response.json({ ok: true, access: "view" });
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const body = (await exchanged.json()) as { session: string };
    const sessionHeaders = {
      cookie: cookiePair(exchanged),
      "x-dohc-link-session": body.session,
    };
    now = 601_001;

    const first = handler(request("/api/view/meta", { headers: sessionHeaders }));
    const second = handler(request("/api/view/meta", { headers: sessionHeaders }));
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    releaseRefresh?.();
    const responses = await Promise.all([first, second]);

    expect(responses.map((view) => view.status)).toEqual([200, 200]);
    expect(readCalls).toBe(2);
  });

  it("returns 409 when a held read completes under a replaced capability", async () => {
    let now = 1_000;
    let resolveHeldRead: ((response: Response) => void) | undefined;
    let markHeldReadStarted: (() => void) | undefined;
    const heldReadStarted = new Promise<void>((resolve) => {
      markHeldReadStarted = resolve;
    });
    let staleBodyCancelled = false;
    const readCapabilities: string[] = [];
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "share-web-to-relay-refresh-exchange-key",
      publicHosts: new Set([HOST]),
      nowMs: () => now,
      newSessionToken: () => Buffer.alloc(32, 29).toString("base64url"),
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        const authorization = relayRequest.headers.get("authorization") ?? "";
        if (pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-held-refresh-race",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        if (pathname === "/sync/link-refresh") {
          expect(authorization).toBe(`LinkCapability ${CAP_ALPHA_1}`);
          return Response.json({
            ok: true,
            grantId: "grant-held-refresh-race",
            capabilityToken: CAP_ALPHA_2,
            capabilityExpiresAtMs: now + 900_000,
          });
        }
        readCapabilities.push(authorization);
        if (pathname === "/sync/link/log") {
          expect(authorization).toBe(`LinkCapability ${CAP_ALPHA_1}`);
          markHeldReadStarted?.();
          return await new Promise<Response>((resolve) => {
            resolveHeldRead = resolve;
          });
        }
        expect(pathname).toBe("/sync/link/share");
        expect(authorization).toBe(`LinkCapability ${CAP_ALPHA_2}`);
        return Response.json({ ok: true, access: "view" });
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const body = (await exchanged.json()) as { session: string };
    const sessionHeaders = {
      cookie: cookiePair(exchanged),
      "x-dohc-link-session": body.session,
    };

    const held = handler(
      request("/api/view/log?since=7&limit=500&hold=30000", {
        headers: sessionHeaders,
      }),
    );
    await heldReadStarted;
    now = 601_001;
    const refreshed = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );
    expect(refreshed.status).toBe(200);

    resolveHeldRead?.(new Response(new ReadableStream({
      cancel: () => {
        staleBodyCancelled = true;
      },
    }), { status: 401 }));
    const stale = await held;
    expect({ status: stale.status, body: await stale.text() }).toEqual({
      status: 409,
      body: shareWebRefusalBody,
    });
    expect(staleBodyCancelled).toBe(true);

    const followUp = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );
    expect(followUp.status).toBe(200);
    expect(readCapabilities).toEqual([
      `LinkCapability ${CAP_ALPHA_1}`,
      `LinkCapability ${CAP_ALPHA_2}`,
      `LinkCapability ${CAP_ALPHA_2}`,
    ]);
  });

  it("keeps a near-expiry session after a network refresh failure and retries renewal on the next request", async () => {
    let now = 1_000;
    let refreshCalls = 0;
    const readCapabilities: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "share-web-to-relay-refresh-exchange-key",
      publicHosts: new Set([HOST]),
      nowMs: () => now,
      newSessionToken: () => Buffer.alloc(32, 29).toString("base64url"),
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        if (pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-network-refresh-failure",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        if (pathname === "/sync/link-refresh") {
          refreshCalls += 1;
          if (refreshCalls === 1) {
            throw new Error("temporary relay outage");
          }
          return Response.json({
            ok: true,
            grantId: "grant-network-refresh-failure",
            capabilityToken: CAP_ALPHA_2,
            capabilityExpiresAtMs: now + 900_000,
          });
        }
        readCapabilities.push(relayRequest.headers.get("authorization") ?? "");
        return Response.json({ ok: true, access: "view" });
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const body = (await exchanged.json()) as { session: string };
    const sessionHeaders = {
      cookie: cookiePair(exchanged),
      "x-dohc-link-session": body.session,
    };
    now = 601_001;

    const duringFailure = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );
    const afterRetry = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );

    expect({
      statuses: [duringFailure.status, afterRetry.status],
      refreshCalls,
      readCapabilities,
    }).toEqual({
      statuses: [200, 200],
      refreshCalls: 2,
      readCapabilities: [
        `LinkCapability ${CAP_ALPHA_1}`,
        `LinkCapability ${CAP_ALPHA_2}`,
      ],
    });
  });

  it("keeps an expired in-grace session after a transient refresh failure", async () => {
    let now = 1_000;
    let refreshCalls = 0;
    const readCapabilities: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "share-web-to-relay-refresh-exchange-key",
      publicHosts: new Set([HOST]),
      nowMs: () => now,
      newSessionToken: () => Buffer.alloc(32, 33).toString("base64url"),
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        if (pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-expired-refresh-failure",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        if (pathname === "/sync/link-refresh") {
          refreshCalls += 1;
          if (refreshCalls === 1) {
            throw new Error("temporary relay outage");
          }
          return Response.json({
            ok: true,
            grantId: "grant-expired-refresh-failure",
            capabilityToken: CAP_ALPHA_2,
            capabilityExpiresAtMs: now + 900_000,
          });
        }
        const authorization = relayRequest.headers.get("authorization") ?? "";
        readCapabilities.push(authorization);
        return authorization === `LinkCapability ${CAP_ALPHA_2}`
          ? Response.json({ ok: true, access: "view" })
          : new Response("expired capability", { status: 401 });
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const body = (await exchanged.json()) as { session: string };
    const sessionHeaders = {
      cookie: cookiePair(exchanged),
      "x-dohc-link-session": body.session,
    };
    now += 20 * 60 * 1_000;

    const duringFailure = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );
    const afterRetry = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );

    expect({
      statuses: [duringFailure.status, afterRetry.status],
      refreshCalls,
      readCapabilities,
    }).toEqual({
      statuses: [503, 200],
      refreshCalls: 2,
      readCapabilities: [`LinkCapability ${CAP_ALPHA_2}`],
    });
    expect(afterRetry.headers.get("set-cookie")).toContain("Max-Age=605700");
  });

  it("keeps a near-expiry session when relay refresh answers 500", async () => {
    let now = 1_000;
    let refreshCalls = 0;
    const readCapabilities: string[] = [];
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "share-web-to-relay-refresh-exchange-key",
      publicHosts: new Set([HOST]),
      nowMs: () => now,
      newSessionToken: () => Buffer.alloc(32, 31).toString("base64url"),
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        if (pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-server-refresh-failure",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        if (pathname === "/sync/link-refresh") {
          refreshCalls += 1;
          return new Response("temporary relay failure", { status: 500 });
        }
        readCapabilities.push(relayRequest.headers.get("authorization") ?? "");
        return Response.json({ ok: true, access: "view" });
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const body = (await exchanged.json()) as { session: string };
    const sessionHeaders = {
      cookie: cookiePair(exchanged),
      "x-dohc-link-session": body.session,
    };
    now = 601_001;

    const duringFailure = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );

    expect(duringFailure.status).toBe(200);
    expect(refreshCalls).toBe(1);
    expect(readCapabilities).toEqual([`LinkCapability ${CAP_ALPHA_1}`]);
  });

  it("deletes a near-expiry session when relay refresh answers 401", async () => {
    let now = 1_000;
    let refreshCalls = 0;
    let readCalls = 0;
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "share-web-to-relay-refresh-exchange-key",
      publicHosts: new Set([HOST]),
      nowMs: () => now,
      newSessionToken: () => Buffer.alloc(32, 27).toString("base64url"),
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        if (pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-refused-refresh",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        if (pathname === "/sync/link-refresh") {
          refreshCalls += 1;
          return new Response("relay refresh refusal", { status: 401 });
        }
        readCalls += 1;
        return Response.json({ ok: true, access: "view" });
      },
    });

    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const body = (await exchanged.json()) as { session: string };
    const sessionHeaders = {
      cookie: cookiePair(exchanged),
      "x-dohc-link-session": body.session,
    };
    now = 601_001;

    const refusedRefresh = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );
    const afterDeletion = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );

    for (const refusal of [refusedRefresh, afterDeletion]) {
      expect(refusal.status).toBe(404);
      expect(await refusal.text()).toBe(shareWebRefusalBody);
    }
    expect(refreshCalls).toBe(1);
    expect(readCalls).toBe(0);
  });

  it("rejects hostile hosts and returns one refusal body for every public failure", async () => {
    let relayCalls = 0;
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      publicHosts: new Set([HOST]),
      fetchRelay: async () => {
        relayCalls += 1;
        return new Response("relay detail", { status: 500 });
      },
    });

    const hostile = await handler(
      new Request("https://evil.example/api/exchange", {
        method: "POST",
        headers: { host: "evil.example" },
        body: JSON.stringify({ secret: SECRET_ALPHA }),
      }),
    );
    const malformed = await handler(request("/api/exchange", exchange("not-a-secret")));
    const relayFailure = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const missingSession = await handler(request("/api/view/meta"));
    const unknownPath = await handler(request("/not-found"));

    for (const refusal of [hostile, malformed, relayFailure, missingSession, unknownPath]) {
      expect(refusal.status).toBe(404);
      expect(await refusal.text()).toBe(shareWebRefusalBody);
      expectSecurityHeaders(refusal);
    }
    expect(relayCalls).toBe(1);
  });

  it("rate-limits exchanges by socket IP before calling the relay", async () => {
    let relayCalls = 0;
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 30).toString("base64url"),
      fetchRelay: async () => {
        relayCalls += 1;
        return Response.json({
          ok: true,
          grantId: "grant-rate-limit",
          capabilityToken: CAP_ALPHA_1,
          capabilityExpiresAtMs: 901_000,
        });
      },
    });
    const sameIpHeaders = {
      "content-type": "application/json",
      "x-dohc-share-web-client-ip": "192.0.2.10",
    };

    for (
      let exchangeNumber = 1;
      exchangeNumber <= EXCHANGE_BUCKET_CAPACITY;
      exchangeNumber += 1
    ) {
      const accepted = await handler(
        request("/api/exchange", {
          method: "POST",
          headers: sameIpHeaders,
          body: JSON.stringify({ secret: SECRET_ALPHA }),
        }),
      );
      expect(accepted.status, `exchange ${exchangeNumber}`).toBe(200);
    }

    const limitedRequest = request("/api/exchange", {
      method: "POST",
      headers: sameIpHeaders,
      body: JSON.stringify({ secret: SECRET_ALPHA }),
    });
    const limited = await handler(limitedRequest);
    const generic = await handler(request("/not-found"));
    const otherIp = await handler(
      request("/api/exchange", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dohc-share-web-client-ip": "192.0.2.11",
        },
        body: JSON.stringify({ secret: SECRET_ALPHA }),
      }),
    );

    expect(limited.status).toBe(404);
    expect(Buffer.from(await limited.arrayBuffer())).toEqual(
      Buffer.from(await generic.arrayBuffer()),
    );
    expect(limitedRequest.bodyUsed).toBe(false);
    expect(otherIp.status).toBe(200);
    expect(relayCalls).toBe(EXCHANGE_BUCKET_CAPACITY + 1);
  });

  it("limits in-flight blob streams independently for each viewer session", async () => {
    const blobSha = "c".repeat(64);
    let tokenId = 0;
    let blobReads = 0;
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, ++tokenId).toString("base64url"),
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-shared-blob-budget",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        blobReads += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(12));
            },
          }),
        );
      },
    });
    const exchangedA = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const exchangedB = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const sessionA = (await exchangedA.json()) as { session: string };
    const sessionB = (await exchangedB.json()) as { session: string };
    const headersA = {
      cookie: cookiePair(exchangedA),
      "x-dohc-link-session": sessionA.session,
    };
    const headersB = {
      cookie: cookiePair(exchangedB),
      "x-dohc-link-session": sessionB.session,
    };

    const heldByA = await Promise.all(
      Array.from({ length: 8 }, () =>
        handler(request(`/api/view/blob/${blobSha}`, { headers: headersA })),
      ),
    );
    const requestedByB = await handler(
      request(`/api/view/blob/${blobSha}`, { headers: headersB }),
    );
    const ninthFromA = await handler(
      request(`/api/view/blob/${blobSha}`, { headers: headersA }),
    );

    try {
      expect(heldByA.map(({ status }) => status)).toEqual(Array(8).fill(200));
      expect(requestedByB.status).toBe(200);
      expect(ninthFromA.status).toBe(429);
      expect(blobReads).toBe(9);
    } finally {
      await Promise.all(
        [...heldByA, requestedByB, ninthFromA].map((response) =>
          response.body?.cancel(),
        ),
      );
    }
  });

  it("limits in-flight blob streams across sessions for one grant", async () => {
    const blobSha = "d".repeat(64);
    let tokenId = 0;
    let blobReads = 0;
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, ++tokenId).toString("base64url"),
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-shared-blob-budget",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        blobReads += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(12));
            },
          }),
        );
      },
    });
    const exchanged = await Promise.all(
      Array.from({ length: 4 }, () =>
        handler(request("/api/exchange", exchange(SECRET_ALPHA))),
      ),
    );
    const sessionHeaders = await Promise.all(
      exchanged.map(async (exchangeResponse) => {
        const body = (await exchangeResponse.json()) as { session: string };
        return {
          cookie: cookiePair(exchangeResponse),
          "x-dohc-link-session": body.session,
        };
      }),
    );
    const held = await Promise.all(
      sessionHeaders.slice(0, 3).flatMap((headers) =>
        Array.from({ length: 8 }, () =>
          handler(request(`/api/view/blob/${blobSha}`, { headers })),
        ),
      ),
    );
    const twentyFifth = await handler(
      request(`/api/view/blob/${blobSha}`, { headers: sessionHeaders[3] }),
    );
    let admittedAfterRelease: Response | null = null;

    try {
      expect(held.map(({ status }) => status)).toEqual(Array(24).fill(200));
      expect(twentyFifth.status).toBe(429);
      expect(await twentyFifth.text()).toBe(shareWebRefusalBody);
      expect(blobReads).toBe(24);

      await held[0]!.body?.cancel();
      admittedAfterRelease = await handler(
        request(`/api/view/blob/${blobSha}`, { headers: sessionHeaders[3] }),
      );

      expect(admittedAfterRelease.status).toBe(200);
      expect(blobReads).toBe(25);
    } finally {
      await Promise.all(
        [
          ...held,
          twentyFifth.status === 200 ? twentyFifth : null,
          admittedAfterRelease,
        ]
          .filter((response): response is Response => response !== null)
          .map((response) => response.body?.cancel()),
      );
    }
  });

  it("serves only raster signatures inline and forces SVG and other bytes to download", async () => {
    const pngSha = "a".repeat(64);
    const svgSha = "b".repeat(64);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const svg = Buffer.from('<svg onload="alert(1)"></svg>');
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 21).toString("base64url"),
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        if (pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-images",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        if (pathname.endsWith(pngSha)) return new Response(png);
        if (pathname.endsWith(svgSha)) return new Response(svg);
        return new Response("missing", { status: 404 });
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const body = (await exchanged.json()) as { session: string };
    const headers = { cookie: cookiePair(exchanged) };

    const pngResponse = await handler(
      request(`/api/view/blob/${pngSha}?session=${body.session}`, { headers }),
    );
    expect(pngResponse.headers.get("content-type")).toBe("image/png");
    expect(pngResponse.headers.get("content-disposition")).toBeNull();
    expectSecurityHeaders(pngResponse);

    const svgResponse = await handler(
      request(`/api/view/blob/${svgSha}?session=${body.session}`, { headers }),
    );
    expect(svgResponse.headers.get("content-type")).toBe("application/octet-stream");
    expect(svgResponse.headers.get("content-disposition")).toBe("attachment");
    expect(svgResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await svgResponse.text()).toContain("<svg");
  });
});

describe("share-web relay call", () => {
  const blobSha = "f".repeat(64);
  const routes: Array<{ name: string; path: string; method?: string; body?: string }> = [
    { name: "handoff", path: "/api/handoff", method: "POST" },
    { name: "discussion", path: "/api/view/discussion" },
    {
      name: "discussion append",
      path: "/api/view/discussion",
      method: "POST",
      body: JSON.stringify({ body: "hello", idempotencyKey: "relay-call" }),
    },
    { name: "discussion activity", path: "/api/view/discussion/activity?since=0&hold=0&limit=100" },
    { name: "meta", path: "/api/view/meta" },
    { name: "current", path: "/api/view/current" },
    { name: "log", path: "/api/view/log?since=0&hold=0" },
    { name: "blob", path: `/api/view/blob/${blobSha}` },
  ];

  // The fake relay answers exchange and refresh itself; `relay` answers the route's call.
  async function linkSession(
    relay: (relayRequest: Request) => Promise<Response>,
    capabilityExpiresAtMs = 901_000,
  ) {
    const calls: Request[] = [];
    let tokenByte = 100;
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "relay-call-key",
      publicHosts: new Set([HOST]),
      maxSessions: 1,
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, ++tokenByte).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        if (pathname === "/sync/link-exchange" || pathname === "/sync/link-refresh") {
          const refresh = pathname === "/sync/link-refresh";
          return Response.json({
            ok: true,
            grantId: "grant-relay-call",
            capabilityToken: refresh ? CAP_ALPHA_2 : CAP_ALPHA_1,
            capabilityExpiresAtMs: refresh ? 901_000 : capabilityExpiresAtMs,
          });
        }
        calls.push(relayRequest);
        return await relay(relayRequest);
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const { session } = (await exchanged.clone().json()) as { session: string };
    const sessionCookie = cookiePair(exchanged);
    const cookie = cookieHeader(sessionCookie, profileCookiePair(exchanged));
    return {
      calls,
      sessionCookie,
      call: (target: (typeof routes)[number], signal?: AbortSignal) =>
        handler(request(target.path, {
          method: target.method ?? "GET",
          headers: { cookie, "x-dohc-link-session": session },
          body: target.body,
          signal,
        })),
      // With one session allowed, a second exchange replaces this one.
      replace: () => handler(request("/api/exchange", exchange(SECRET_ALPHA))),
    };
  }

  const outcomes: Array<{ relay: number | string; status: number }> = [
    { relay: 200, status: 200 },
    { relay: 401, status: 404 },
    { relay: "401, oversized body", status: 404 },
    { relay: "401, body fails", status: 404 },
    { relay: 403, status: 404 },
    { relay: 404, status: 404 },
    { relay: 409, status: 404 },
    { relay: 413, status: 404 },
    { relay: 429, status: 429 },
    { relay: 500, status: 503 },
    { relay: 502, status: 503 },
    { relay: 204, status: 503 },
    { relay: "network error", status: 503 },
  ];

  it.each(routes)("maps every relay answer for $name through one refusal map", async (target) => {
    for (const outcome of outcomes) {
      const state = await linkSession(async () => {
        switch (outcome.relay) {
          case "network error":
            throw new Error(`relay down ${CAP_ALPHA_2}`);
          case 200:
            return Response.json({ ok: true, code: HANDOFF_CODE, expiresAtMs: 301_000 });
          case 204:
            return new Response(null, { status: 204 });
          case "401, oversized body":
            return new Response(new Uint8Array(2 * 1024 * 1024 + 1), { status: 401 });
          case "401, body fails":
            return new Response(new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Uint8Array.of(1));
              },
              pull(controller) {
                controller.error(new Error("relay body broke"));
              },
            }), { status: 401 });
          default:
            return new Response(`relay detail ${CAP_ALPHA_2}`, { status: Number(outcome.relay) });
        }
      }, 200_000);
      const evicted = String(outcome.relay).startsWith("401");

      const answer = await state.call(target);
      const body = await answer.text();
      expect({ relay: outcome.relay, status: answer.status }).toEqual(outcome);
      if (outcome.status !== 200) expect(body).toBe(shareWebRefusalBody);
      expectSecurityHeaders(answer);
      // The call refreshed first. Only the refusal that evicts the session skips its cookie.
      expect(state.calls.map((call) => call.headers.get("authorization"))).toEqual([
        `LinkCapability ${CAP_ALPHA_2}`,
      ]);
      expect(cookiePairs(answer)).toEqual(evicted ? [] : [state.sessionCookie]);

      await (await state.call(target)).body?.cancel();
      expect(state.calls).toHaveLength(evicted ? 1 : 2);
    }
  });

  it.each(routes)("ends $name at the relay deadline or when the browser leaves", async (target) => {
    vi.useFakeTimers();
    try {
      let markStarted!: () => void;
      const nextStart = () => new Promise<void>((resolve) => { markStarted = resolve; });
      const state = await linkSession(async (relayRequest) => {
        markStarted();
        return await new Promise<Response>((_resolve, reject) => {
          relayRequest.signal.addEventListener("abort", () => reject(relayRequest.signal.reason), {
            once: true,
          });
        });
      });

      let started = nextStart();
      const stalled = state.call(target);
      await started;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(state.calls[0]!.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.calls[0]!.signal.aborted).toBe(true);
      const timedOut = await stalled;
      expect({ status: timedOut.status, body: await timedOut.text() }).toEqual({
        status: 503,
        body: shareWebRefusalBody,
      });

      started = nextStart();
      const browser = new AbortController();
      const abandoned = state.call(target, browser.signal);
      await started;
      browser.abort();
      expect(state.calls[1]!.signal.aborted).toBe(true);
      expect((await abandoned).status).toBe(503);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a blob's response head but not its streamed body", async () => {
    vi.useFakeTimers();
    try {
      let send!: (chunk: Uint8Array) => void;
      const state = await linkSession(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(12));
          send = (chunk) => controller.enqueue(chunk);
        },
      })));
      const browser = new AbortController();

      const blob = await state.call(routes.at(-1)!, browser.signal);
      expect(blob.status).toBe(200);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      const reader = blob.body!.getReader();
      expect((await reader.read()).value).toEqual(new Uint8Array(12));
      send(Uint8Array.of(1));
      expect((await reader.read()).value).toEqual(Uint8Array.of(1));
      expect(state.calls[0]!.signal.aborted).toBe(false);

      browser.abort();
      expect(state.calls[0]!.signal.aborted).toBe(true);
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  const supersededStatus: Record<string, number> = {
    log: 409,
    "discussion activity": 409,
    discussion: 404,
    "discussion append": 404,
  };

  it.each(routes.flatMap((target) => [
    { ...target, settle: "answers" },
    { ...target, settle: "fails" },
  ]))("renews no cookie when $name $settle after its session was replaced", async (target) => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let settle!: () => void;
    const state = await linkSession(async () => {
      markStarted();
      await new Promise<void>((resolve) => { settle = resolve; });
      if (target.settle === "fails") throw new Error("relay connection reset");
      return Response.json({ ok: true, code: HANDOFF_CODE, expiresAtMs: 301_000 });
    }, 200_000);

    const pending = state.call(target);
    await started;
    expect((await state.replace()).status).toBe(200);
    settle();

    const answer = await pending;
    expect(answer.status).toBe(
      supersededStatus[target.name] ?? (target.settle === "answers" ? 200 : 503),
    );
    expect(answer.headers.has("set-cookie")).toBe(false);
    await answer.body?.cancel();
  });
});

describe("share-web protected discussion proxy", () => {
  const MAX_RELAY_RESPONSE_BYTES = 2 * 1024 * 1024;
  const activityPath = "/api/view/discussion/activity?since=0&hold=0&limit=100";
  const publicActivity = {
    ok: true,
    access: "comment",
    latestRevision: 0,
    cursorRevision: 0,
    hasMore: false,
    messages: [],
    composerState: "available",
    profileName: null,
  };
  const logPath = "/api/view/log?since=0&hold=30000&limit=100";
  const publicLog = { ops: [], nextCursor: 0, hasMore: false };
  const holdRoutes = [
    { kind: "activity", path: activityPath, publicBody: publicActivity },
    { kind: "log", path: logPath, publicBody: publicLog },
  ];

  function sessionHeaders(discriminator: string, cookies: string): HeadersInit {
    return {
      cookie: cookies,
      "x-dohc-link-session": discriminator,
    };
  }

  function publicMessage(body: string): Record<string, unknown> {
    return {
      ok: true,
      message: {
        messageId: "public-message",
        createdAtMs: 2_000,
        deleted: false,
        body,
        author: {
          kind: "link",
          displayName: "Public profile",
          unverified: true,
        },
      },
    };
  }

  async function discussionSession(
    handler: ReturnType<typeof createShareWebHandler>,
    secret = SECRET_ALPHA,
  ): Promise<{ session: string; cookies: string }> {
    const exchanged = await handler(request("/api/exchange", exchange(secret)));
    const { session } = (await exchanged.clone().json()) as { session: string };
    return {
      session,
      cookies: cookieHeader(cookiePair(exchanged), profileCookiePair(exchanged)),
    };
  }

  function rejectWhenAborted(relayRequest: Request): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
      const rejectAborted = (): void => reject(relayRequest.signal.reason);
      if (relayRequest.signal.aborted) rejectAborted();
      else relayRequest.signal.addEventListener("abort", rejectAborted, { once: true });
    });
  }

  async function expectDiscussionUnavailable(response: Response): Promise<void> {
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(shareWebRefusalBody);
  }

  it("accepts an unknown-length relay response of exactly 2 MiB", async () => {
    let pulls = 0;
    const chunk = new Uint8Array(MAX_RELAY_RESPONSE_BYTES / 2).fill(0x61);
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "discussion-relay-key",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 71).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-response-boundary",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls <= 2) controller.enqueue(chunk);
            else controller.close();
          },
        }, { highWaterMark: 0 }));
      },
    });
    const state = await discussionSession(handler);

    const received = await handler(request("/api/view/discussion", {
      headers: sessionHeaders(state.session, state.cookies),
    }));

    expect(received.status).toBe(200);
    expect((await received.arrayBuffer()).byteLength).toBe(MAX_RELAY_RESPONSE_BYTES);
    expect(pulls).toBe(3);
  });

  it("cancels on the first relay byte beyond 2 MiB without pulling later chunks", async () => {
    let pulls = 0;
    let cancellations = 0;
    const chunks = [
      new Uint8Array(MAX_RELAY_RESPONSE_BYTES),
      Uint8Array.of(1),
      Uint8Array.of(2),
    ];
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "discussion-relay-key",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 72).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-response-overflow",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = chunks[pulls++];
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          },
          cancel() {
            cancellations += 1;
          },
        }, { highWaterMark: 0 }));
      },
    });
    const state = await discussionSession(handler);

    const received = await handler(request("/api/view/discussion", {
      headers: sessionHeaders(state.session, state.cookies),
    }));

    await expectDiscussionUnavailable(received);
    expect(pulls).toBe(2);
    expect(cancellations).toBe(1);
  });

  it("rejects a declared relay response above 2 MiB without pulling a chunk", async () => {
    let pulls = 0;
    let cancellations = 0;
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "discussion-relay-key",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 73).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-declared-response-overflow",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(Uint8Array.of(1));
            controller.close();
          },
          cancel() {
            cancellations += 1;
          },
        }, { highWaterMark: 0 }), {
          headers: { "content-length": String(MAX_RELAY_RESPONSE_BYTES + 1) },
        });
      },
    });
    const state = await discussionSession(handler);

    const received = await handler(request("/api/view/discussion", {
      headers: sessionHeaders(state.session, state.cookies),
    }));

    await expectDiscussionUnavailable(received);
    expect(pulls).toBe(0);
    expect(cancellations).toBe(1);
  });

  it("releases log hold capacity after a stalled relay deadline", async () => {
    vi.useFakeTimers();
    const browserAbort = new AbortController();
    const relayed: Request[] = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const page = { ok: true, ops: [], nextCursor: 0, hasMore: false, epochLogFloor: 0 };
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test", publicHosts: new Set([HOST]),
      relayExchangeKey: "discussion-relay-key", nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 74).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          return Response.json({ ok: true, grantId: "grant-log-deadline",
            capabilityToken: CAP_ALPHA_1, capabilityExpiresAtMs: 901_000 });
        }
        relayed.push(relayRequest);
        if (relayed.length > 8) return Response.json(page);
        if (relayed.length === 8) markStarted();
        return await new Promise<Response>((_resolve, reject) => {
          relayRequest.signal.addEventListener("abort", () => reject(relayRequest.signal.reason), { once: true });
        });
      },
    });
    let pending: Promise<Response>[] = [];
    try {
      const state = await discussionSession(handler);
      const init = { headers: sessionHeaders(state.session, state.cookies), signal: browserAbort.signal };
      const path = "/api/view/log?since=0&hold=30000";
      pending = Array.from({ length: 8 }, () => handler(request(path, init)));
      await started;
      expect((await handler(request(path, init))).status).toBe(429);
      await vi.advanceTimersByTimeAsync(39_999);
      expect(relayed.every((value) => !value.signal.aborted)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(relayed.every((value) => value.signal.aborted)).toBe(true);
      expect((await Promise.all(pending)).map((value) => value.status)).toEqual(Array(8).fill(503));
      const retry = await handler(request(path, init));
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual(page);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      browserAbort.abort();
      await Promise.allSettled(pending);
      vi.useRealTimers();
    }
  });

  it.each(holdRoutes)("admits eight $kind holds per session and rejects the ninth", async ({ path, publicBody }) => {
    let activityCalls = 0;
    let markEightStarted: (() => void) | undefined;
    const eightStarted = new Promise<void>((resolve) => {
      markEightStarted = resolve;
    });
    const heldResolvers: Array<(response: Response) => void> = [];
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "discussion-relay-key",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 74).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-activity-session-bound",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        activityCalls += 1;
        if (activityCalls <= 8) {
          if (activityCalls === 8) markEightStarted?.();
          return await new Promise<Response>((resolve) => heldResolvers.push(resolve));
        }
        return Response.json(publicBody);
      },
    });
    const state = await discussionSession(handler);
    const headers = sessionHeaders(state.session, state.cookies);
    const held = Array.from({ length: 8 }, () =>
      handler(request(path, { headers })),
    );
    await eightStarted;

    const ninth = await handler(request(path, { headers }));

    try {
      expect({ status: ninth.status, body: await ninth.text() }).toEqual({
        status: 429,
        body: shareWebRefusalBody,
      });
      expect(activityCalls).toBe(8);
    } finally {
      for (const resolve of heldResolvers) resolve(Response.json(publicBody));
      await Promise.all(held);
    }

    const afterRelease = await handler(request(path, { headers }));
    expect(afterRelease.status).toBe(200);
  });

  it.each(holdRoutes)("admits twenty-four $kind holds per full grant and keeps another grant independent", async ({ path, publicBody }) => {
    let tokenId = 80;
    let alphaActivityCalls = 0;
    let markTwentyFourStarted: (() => void) | undefined;
    const twentyFourStarted = new Promise<void>((resolve) => {
      markTwentyFourStarted = resolve;
    });
    const heldResolvers: Array<(response: Response) => void> = [];
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "discussion-relay-key",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, tokenId++).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        if (pathname === "/sync/link-exchange") {
          const { secret } = (await relayRequest.json()) as { secret: string };
          const beta = secret === SECRET_BETA;
          return Response.json({
            ok: true,
            grantId: beta ? "grant-activity-beta" : "grant-activity-alpha",
            capabilityToken: beta ? CAP_BETA : CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        const beta = relayRequest.headers.get("authorization") ===
          `LinkCapability ${CAP_BETA}`;
        if (beta) return Response.json(publicBody);
        alphaActivityCalls += 1;
        if (alphaActivityCalls <= 24) {
          if (alphaActivityCalls === 24) markTwentyFourStarted?.();
          return await new Promise<Response>((resolve) => heldResolvers.push(resolve));
        }
        return Response.json(publicBody);
      },
    });
    const alphaSessions = await Promise.all(
      Array.from({ length: 4 }, (_, index) => discussionSession(
        handler, index % 2 === 0 ? SECRET_ALPHA : SECRET_ALPHA_ROTATED,
      )),
    );
    const betaSession = await discussionSession(handler, SECRET_BETA);
    const held = alphaSessions.slice(0, 3).flatMap((state) =>
      Array.from({ length: 8 }, () =>
        handler(request(path, {
          headers: sessionHeaders(state.session, state.cookies),
        })),
      ),
    );
    await twentyFourStarted;

    const independent = await handler(request(path, {
      headers: sessionHeaders(betaSession.session, betaSession.cookies),
    }));
    const twentyFifth = await handler(request(path, {
      headers: sessionHeaders(alphaSessions[3]!.session, alphaSessions[3]!.cookies),
    }));

    try {
      expect(independent.status).toBe(200);
      expect({ status: twentyFifth.status, body: await twentyFifth.text() }).toEqual({
        status: 429,
        body: shareWebRefusalBody,
      });
      expect(alphaActivityCalls).toBe(24);
    } finally {
      for (const resolve of heldResolvers) resolve(Response.json(publicBody));
      await Promise.all(held);
    }
  });

  it.each([
    { scope: "session", sessionCount: 1, holdsPerSession: 8 },
    { scope: "full grant", sessionCount: 4, holdsPerSession: 6 },
  ])("shares the $scope activity budget between log and discussion holds", async ({ sessionCount, holdsPerSession }) => {
    const limit = sessionCount * holdsPerSession;
    let tokenId = 140;
    let relayCalls = 0;
    let markHeldStarted: (() => void) | undefined;
    const heldStarted = new Promise<void>((resolve) => { markHeldStarted = resolve; });
    const releases: Array<() => void> = [];
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "discussion-relay-key",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, tokenId++).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        if (pathname === "/sync/link-exchange") {
          return Response.json({ ok: true, grantId: "grant-shared-holds",
            capabilityToken: CAP_ALPHA_1, capabilityExpiresAtMs: 901_000 });
        }
        const body = pathname === "/sync/link/log" ? publicLog : publicActivity;
        relayCalls += 1;
        if (relayCalls <= limit) {
          if (relayCalls === limit) markHeldStarted?.();
          return await new Promise<Response>((resolve) => {
            releases.push(() => resolve(Response.json(body)));
          });
        }
        return Response.json(body);
      },
    });
    const states = await Promise.all(Array.from({ length: sessionCount }, (_, index) => discussionSession(
      handler, index % 2 === 0 ? SECRET_ALPHA : SECRET_ALPHA_ROTATED,
    )));
    const headers = sessionHeaders(states[0]!.session, states[0]!.cookies);
    const held = states.flatMap(state => Array.from({ length: holdsPerSession }, (_, index) =>
      handler(request(index % 2 === 0 ? logPath : activityPath, {
        headers: sessionHeaders(state.session, state.cookies),
      })),
    ));
    try {
      const admission = await Promise.race([
        heldStarted.then(() => "all-started"),
        Promise.race(held.map(async response => `settled-${(await response).status}`)),
      ]);
      expect(admission).toBe("all-started");
      for (const { path } of holdRoutes) {
        const extra = await handler(request(path, { headers }));
        expect({ status: extra.status, body: await extra.text() }).toEqual({
          status: 429, body: shareWebRefusalBody,
        });
      }
      expect(relayCalls).toBe(limit);
    } finally {
      for (const release of releases) release();
      await Promise.allSettled(held);
    }
    for (const { path } of holdRoutes) expect((await handler(request(path, { headers }))).status).toBe(200);
  });

  it.each([
    { name: "blob holds before activity holds", first: "blob" as const },
    { name: "activity holds before blob holds", first: "activity" as const },
  ])("keeps blob and activity capacity independent with $name", async ({ first }) => {
    const blobSha = "e".repeat(64);
    let activityCalls = 0;
    let markEightActivityStarted: (() => void) | undefined;
    const eightActivityStarted = new Promise<void>((resolve) => {
      markEightActivityStarted = resolve;
    });
    const activityResolvers: Array<(response: Response) => void> = [];
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "discussion-relay-key",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, first === "blob" ? 91 : 92)
        .toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        if (pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: `grant-independent-${first}`,
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        if (pathname.startsWith("/sync/link/blobs/")) {
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(12));
            },
          }));
        }
        activityCalls += 1;
        if (activityCalls <= 8) {
          if (activityCalls === 8) markEightActivityStarted?.();
          return await new Promise<Response>((resolve) => activityResolvers.push(resolve));
        }
        return Response.json(publicActivity);
      },
    });
    const state = await discussionSession(handler);
    const headers = sessionHeaders(state.session, state.cookies);
    const startBlobs = async (): Promise<Response[]> => await Promise.all(
      Array.from({ length: 8 }, () =>
        handler(request(`/api/view/blob/${blobSha}`, { headers })),
      ),
    );
    const startActivities = async (): Promise<Array<Promise<Response>>> => {
      const pending = Array.from({ length: 8 }, () =>
        handler(request(activityPath, { headers })),
      );
      const admission = await Promise.race([
        eightActivityStarted.then(() => "all-started"),
        Promise.race(pending.map(async (response) =>
          `settled-${(await response).status}`)),
      ]);
      expect(admission).toBe("all-started");
      return pending;
    };

    let blobs: Response[] = [];
    let activities: Array<Promise<Response>> = [];
    try {
      if (first === "blob") {
        blobs = await startBlobs();
        activities = await startActivities();
      } else {
        activities = await startActivities();
        blobs = await startBlobs();
      }
      expect(blobs.map((response) => response.status)).toEqual(Array(8).fill(200));

      const ninthBlob = await handler(request(`/api/view/blob/${blobSha}`, { headers }));
      const ninthActivity = await handler(request(activityPath, { headers }));
      expect(ninthBlob.status).toBe(429);
      expect(ninthActivity.status).toBe(429);
    } finally {
      for (const resolve of activityResolvers) resolve(Response.json(publicActivity));
      await Promise.allSettled(activities);
      await Promise.all(blobs.map((response) => response.body?.cancel()));
    }
  });

  it.each([
    ...[
      { name: "success", expectedStatus: 200 },
      { name: "upstream refusal", expectedStatus: 404 },
      { name: "abort", expectedStatus: 503 },
      { name: "timeout", expectedStatus: 503 },
      { name: "malformed response", expectedStatus: 503 },
      { name: "thrown fetch", expectedStatus: 503 },
    ].map(terminal => ({ ...terminal, ...holdRoutes[0]! })),
    ...[
      { name: "success", expectedStatus: 200 },
      { name: "upstream refusal", expectedStatus: 404 },
      { name: "abort", expectedStatus: 503 },
      { name: "thrown fetch", expectedStatus: 503 },
    ].map(terminal => ({ ...terminal, ...holdRoutes[1]! })),
  ])("releases $kind capacity after $name", async ({ name, expectedStatus, path, publicBody }) => {
    let phase: "terminal" | "hold" | "probe" = "terminal";
    let holdCalls = 0;
    let markTerminalStarted: (() => void) | undefined;
    const terminalStarted = new Promise<void>((resolve) => {
      markTerminalStarted = resolve;
    });
    let markEightHoldsStarted: (() => void) | undefined;
    const eightHoldsStarted = new Promise<void>((resolve) => {
      markEightHoldsStarted = resolve;
    });
    const holdResolvers: Array<(response: Response) => void> = [];
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "discussion-relay-key",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 93).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: `grant-release-${name}`,
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        if (phase === "probe") return Response.json(publicBody);
        if (phase === "hold") {
          holdCalls += 1;
          if (holdCalls <= 8) {
            if (holdCalls === 8) markEightHoldsStarted?.();
            return await new Promise<Response>((resolve) => holdResolvers.push(resolve));
          }
          return Response.json(publicBody);
        }
        if (name === "success") return Response.json(publicBody);
        if (name === "upstream refusal") {
          return new Response("private refusal", { status: 403 });
        }
        if (name === "malformed response") {
          return new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("malformed relay body"));
            },
          }, { highWaterMark: 0 }));
        }
        if (name === "thrown fetch") throw new Error("relay fetch failed");
        markTerminalStarted?.();
        return await rejectWhenAborted(relayRequest);
      },
    });
    const state = await discussionSession(handler);
    const headers = sessionHeaders(state.session, state.cookies);
    const browserAbort = new AbortController();
    let terminal: Response;
    try {
      if (name === "timeout") vi.useFakeTimers();
      const terminalPromise = handler(request(path, {
        headers,
        signal: browserAbort.signal,
      }));
      if (name === "abort" || name === "timeout") {
        await terminalStarted;
        if (name === "abort") browserAbort.abort();
        else await vi.advanceTimersByTimeAsync(10_000);
      }
      terminal = await terminalPromise;
    } finally {
      if (name === "timeout") vi.useRealTimers();
    }
    expect(terminal.status).toBe(expectedStatus);

    phase = "hold";
    const held = Array.from({ length: 8 }, () =>
      handler(request(path, { headers })),
    );
    try {
      const admission = await Promise.race([
        eightHoldsStarted.then(() => "all-started"),
        Promise.race(held.map(async (response) =>
          `settled-${(await response).status}`)),
      ]);
      expect(admission).toBe("all-started");
      const ninth = await handler(request(path, { headers }));
      expect(ninth.status).toBe(429);
    } finally {
      for (const resolve of holdResolvers) resolve(Response.json(publicBody));
      await Promise.allSettled(held);
    }

    phase = "probe";
    const probe = await handler(request(path, { headers }));
    expect(probe.status).toBe(200);
  });

  it("keeps the refreshed session cookie on an activity limiter refusal", async () => {
    let now = 1_000;
    let refreshCalls = 0;
    let activityCalls = 0;
    let markRefreshStarted: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const activityResolvers: Array<(response: Response) => void> = [];
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "discussion-relay-key",
      publicHosts: new Set([HOST]),
      nowMs: () => now,
      newSessionToken: () => Buffer.alloc(32, 94).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        if (pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-refreshed-activity-limit",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 301_000,
          });
        }
        if (pathname === "/sync/link-refresh") {
          refreshCalls += 1;
          markRefreshStarted?.();
          await refreshGate;
          return Response.json({
            ok: true,
            grantId: "grant-refreshed-activity-limit",
            capabilityToken: CAP_ALPHA_2,
            capabilityExpiresAtMs: now + 900_000,
          });
        }
        activityCalls += 1;
        if (activityCalls <= 8) {
          return await new Promise<Response>((resolve) => activityResolvers.push(resolve));
        }
        return Response.json(publicActivity);
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const { session } = (await exchanged.clone().json()) as { session: string };
    const originalSessionCookie = cookiePair(exchanged);
    const headers = sessionHeaders(
      session,
      cookieHeader(originalSessionCookie, profileCookiePair(exchanged)),
    );
    now = 1_001;
    const pending = Array.from({ length: 9 }, () =>
      handler(request(activityPath, { headers })),
    );
    await refreshStarted;
    expect(refreshCalls).toBe(1);
    releaseRefresh?.();

    const firstSettled = await Promise.race(pending.map(async (response) =>
      await response));
    try {
      expect(firstSettled.status).toBe(429);
      expect(firstSettled.headers.getSetCookie()).toHaveLength(1);
      expect(firstSettled.headers.getSetCookie()[0]).toContain(
        `${originalSessionCookie};`,
      );
      expect(activityCalls).toBe(8);
    } finally {
      for (const resolve of activityResolvers) resolve(Response.json(publicActivity));
      await Promise.all(pending);
    }
  });

  it("keeps a legal activity hold live and bounds a later stalled poll", async () => {
    vi.useFakeTimers();
    const browserAbort = new AbortController();
    try {
      let activityCalls = 0;
      const activityRequests: Request[] = [];
      let markFirstActivityStarted: (() => void) | undefined;
      const firstActivityStarted = new Promise<void>((resolve) => {
        markFirstActivityStarted = resolve;
      });
      let markSecondActivityStarted: (() => void) | undefined;
      const secondActivityStarted = new Promise<void>((resolve) => {
        markSecondActivityStarted = resolve;
      });
      const activityBody = {
        ok: true,
        access: "comment",
        latestRevision: 7,
        cursorRevision: 7,
        hasMore: false,
        messages: [],
        composerState: "available",
      };
      const handler = createShareWebHandler({
        relayUrl: "http://relay.test",
        relayExchangeKey: "discussion-relay-key",
        publicHosts: new Set([HOST]),
        nowMs: () => 1_000,
        newSessionToken: () => Buffer.alloc(32, 62).toString("base64url"),
        newProfileSecret: () => PROFILE_ALPHA,
        fetchRelay: async (relayRequest) => {
          if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
            return Response.json({
              ok: true,
              grantId: "grant-activity-timeout",
              capabilityToken: CAP_ALPHA_1,
              capabilityExpiresAtMs: 901_000,
            });
          }
          activityCalls += 1;
          activityRequests.push(relayRequest);
          if (activityCalls === 1) {
            markFirstActivityStarted?.();
            return await new Promise<Response>((resolve, reject) => {
              const complete = setTimeout(() => resolve(Response.json(activityBody)), 30_000);
              relayRequest.signal.addEventListener("abort", () => {
                clearTimeout(complete);
                reject(relayRequest.signal.reason);
              }, { once: true });
            });
          }
          if (activityCalls === 2) {
            markSecondActivityStarted?.();
            return await rejectWhenAborted(relayRequest);
          }
          return Response.json(activityBody);
        },
      });
      const state = await discussionSession(handler);
      const path = "/api/view/discussion/activity?since=7&hold=30000&limit=100";
      const init: RequestInit = {
        headers: sessionHeaders(state.session, state.cookies),
        signal: browserAbort.signal,
      };

      const held = handler(request(path, init));
      await firstActivityStarted;
      await vi.advanceTimersByTimeAsync(29_999);
      expect(activityRequests[0]?.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const heldResponse = await held;
      expect({ status: heldResponse.status, body: await heldResponse.json() })
        .toEqual({ status: 200, body: activityBody });

      const stalled = handler(request(path, init));
      await secondActivityStarted;
      await vi.advanceTimersByTimeAsync(39_999);
      expect(activityRequests[1]?.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(activityRequests[1]?.signal.aborted).toBe(true);
      await expectDiscussionUnavailable(await stalled);

      const recovered = await handler(request(path, init));
      expect({ status: recovered.status, body: await recovered.json() }).toEqual({
        status: 200,
        body: activityBody,
      });
      expect(activityCalls).toBe(3);
    } finally {
      browserAbort.abort();
      vi.useRealTimers();
    }
  });

  it("bounds a stalled discussion refresh and clears its single-flight entry", async () => {
    vi.useFakeTimers();
    const browserAbort = new AbortController();
    let rejectStalledRefresh: ((reason: Error) => void) | undefined;
    try {
      let now = 1_000;
      let refreshCalls = 0;
      let stalledRefresh: Request | undefined;
      let markRefreshStarted: (() => void) | undefined;
      const refreshStarted = new Promise<void>((resolve) => {
        markRefreshStarted = resolve;
      });
      const page = {
        ok: true,
        activityRevision: 0,
        messages: [],
        nextCursor: null,
        profileName: null,
      };
      const handler = createShareWebHandler({
        relayUrl: "http://relay.test",
        relayExchangeKey: "discussion-relay-key",
        publicHosts: new Set([HOST]),
        nowMs: () => now,
        newSessionToken: () => Buffer.alloc(32, 63).toString("base64url"),
        newProfileSecret: () => PROFILE_ALPHA,
        fetchRelay: async (relayRequest) => {
          const pathname = new URL(relayRequest.url).pathname;
          if (pathname === "/sync/link-exchange") {
            return Response.json({
              ok: true,
              grantId: "grant-refresh-timeout",
              capabilityToken: CAP_ALPHA_1,
              capabilityExpiresAtMs: 11_000,
            });
          }
          if (pathname === "/sync/link-refresh") {
            refreshCalls += 1;
            if (refreshCalls === 1) {
              stalledRefresh = relayRequest;
              markRefreshStarted?.();
              return await new Promise<Response>((_resolve, reject) => {
                rejectStalledRefresh = reject;
                relayRequest.signal.addEventListener(
                  "abort",
                  () => reject(relayRequest.signal.reason),
                  { once: true },
                );
              });
            }
            return Response.json({
              ok: true,
              grantId: "grant-refresh-timeout",
              capabilityToken: CAP_ALPHA_2,
              capabilityExpiresAtMs: 901_000,
            });
          }
          expect(relayRequest.headers.get("authorization")).toBe(
            `LinkCapability ${CAP_ALPHA_2}`,
          );
          return Response.json(page);
        },
      });
      const state = await discussionSession(handler);
      const init: RequestInit = {
        headers: sessionHeaders(state.session, state.cookies),
        signal: browserAbort.signal,
      };

      const pending = handler(request("/api/view/discussion", init));
      await refreshStarted;
      browserAbort.abort();
      expect(stalledRefresh?.signal.aborted).toBe(false);
      now = 11_001;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stalledRefresh?.signal.aborted).toBe(true);
      await expectDiscussionUnavailable(await pending);

      const retry = await handler(request("/api/view/discussion", {
        headers: sessionHeaders(state.session, state.cookies),
      }));
      expect({ status: retry.status, body: await retry.json() }).toEqual({
        status: 200,
        body: page,
      });
      expect(refreshCalls).toBe(2);
    } finally {
      rejectStalledRefresh?.(new Error("test cleanup"));
      browserAbort.abort();
      vi.useRealTimers();
    }
  });

  it("keeps the discussion deadline through a stalled response body", async () => {
    vi.useFakeTimers();
    const browserAbort = new AbortController();
    let cancelStalledBody: (() => void) | undefined;
    try {
      let discussionCalls = 0;
      let bodyRequest: Request | undefined;
      let markBodyStarted: (() => void) | undefined;
      const bodyStarted = new Promise<void>((resolve) => {
        markBodyStarted = resolve;
      });
      const page = {
        ok: true,
        activityRevision: 0,
        messages: [],
        nextCursor: null,
        profileName: null,
      };
      const handler = createShareWebHandler({
        relayUrl: "http://relay.test",
        relayExchangeKey: "discussion-relay-key",
        publicHosts: new Set([HOST]),
        nowMs: () => 1_000,
        newSessionToken: () => Buffer.alloc(32, 64).toString("base64url"),
        newProfileSecret: () => PROFILE_ALPHA,
        fetchRelay: async (relayRequest) => {
          if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
            return Response.json({
              ok: true,
              grantId: "grant-discussion-body-timeout",
              capabilityToken: CAP_ALPHA_1,
              capabilityExpiresAtMs: 901_000,
            });
          }
          discussionCalls += 1;
          if (discussionCalls > 1) return Response.json(page);
          bodyRequest = relayRequest;
          markBodyStarted?.();
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              cancelStalledBody = () => controller.error(new Error("test cleanup"));
              relayRequest.signal.addEventListener("abort", () => {
                controller.error(relayRequest.signal.reason);
              }, { once: true });
            },
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
      const state = await discussionSession(handler);
      const init: RequestInit = {
        headers: sessionHeaders(state.session, state.cookies),
        signal: browserAbort.signal,
      };

      const pending = handler(request("/api/view/discussion", init));
      await bodyStarted;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(bodyRequest?.signal.aborted).toBe(true);
      await expectDiscussionUnavailable(await pending);

      const retry = await handler(request("/api/view/discussion", init));
      expect({ status: retry.status, body: await retry.json() }).toEqual({
        status: 200,
        body: page,
      });
    } finally {
      cancelStalledBody?.();
      browserAbort.abort();
      vi.useRealTimers();
    }
  });

  it("persists and renews a profile without making it viewer authority", async () => {
    let sessionNumber = 0;
    let discussionCalls = 0;
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "discussion-relay-key",
      publicHosts: new Set([HOST]),
      maxSessions: 1,
      nowMs: () => 1_000,
      newSessionToken: () =>
        Buffer.alloc(32, 30 + ++sessionNumber).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-alpha",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        discussionCalls += 1;
        return Response.json(publicMessage("unexpected"));
      },
    });

    const first = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const firstBody = (await first.clone().json()) as { session: string };
    const firstSession = cookiePair(first);
    const firstProfile = profileCookiePair(first);
    const expectedProfileCookie =
      `${firstProfile}; Path=/; Max-Age=34560000; ` +
      "Secure; HttpOnly; SameSite=Strict";
    expect(
      first.headers.getSetCookie().find((cookie) =>
        cookie.startsWith(`dohc_share_profile_${firstBody.session}=`),
      ),
    ).toBe(expectedProfileCookie);

    const renewed = await handler(
      request("/api/exchange", {
        ...exchange(SECRET_ALPHA),
        headers: {
          ...exchange(SECRET_ALPHA).headers,
          cookie: cookieHeader(firstSession, firstProfile),
        },
      }),
    );
    expect(profileCookiePair(renewed)).toBe(firstProfile);
    expect(
      renewed.headers.getSetCookie().find((cookie) =>
        cookie.startsWith(`dohc_share_profile_${firstBody.session}=`),
      ),
    ).toBe(expectedProfileCookie);

    const staleHeaders = sessionHeaders(
      firstBody.session,
      cookieHeader(firstSession, firstProfile),
    );
    const read = await handler(
      request(`/api/view/discussion?session=${firstBody.session}`, {
        headers: staleHeaders,
      }),
    );
    const write = await handler(
      request("/api/view/discussion", {
        method: "POST",
        headers: {
          ...staleHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: "stale", idempotencyKey: "stale-profile" }),
      }),
    );
    for (const refusal of [read, write]) {
      expect({ status: refusal.status, body: await refusal.text() }).toEqual({
        status: 404,
        body: shareWebRefusalBody,
      });
    }
    expect(discussionCalls).toBe(0);
  });

  it("keeps one protected profile across session replacement and same-grant changes", async () => {
    let sessionNumber = 0;
    const profiles = [
      PROFILE_ALPHA,
      PROFILE_BETA,
      Buffer.alloc(32, 16).toString("base64url"),
    ];
    let profileNumber = 0;
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      publicHosts: new Set([HOST]),
      maxSessions: 1,
      nowMs: () => 1_000,
      newSessionToken: () =>
        Buffer.alloc(32, 40 + ++sessionNumber).toString("base64url"),
      newProfileSecret: () => profiles[profileNumber++]!,
      fetchRelay: async (relayRequest) => {
        expect(new URL(relayRequest.url).pathname).toBe("/sync/link-exchange");
        const { secret } = (await relayRequest.json()) as { secret: string };
        return Response.json({
          ok: true,
          grantId: secret === SECRET_BETA ? "grant-beta" : "grant-alpha",
          capabilityToken: secret === SECRET_BETA ? CAP_BETA : CAP_ALPHA_1,
          capabilityExpiresAtMs: 901_000,
        });
      },
    });

    const first = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    expect(first.status).toBe(200);
    const firstCookies = first.headers.getSetCookie();
    expect(firstCookies).toHaveLength(2);
    for (const setCookie of firstCookies) {
      expect(setCookie).toContain("; Path=/;");
      expect(setCookie).toContain("; Secure;");
      expect(setCookie).toContain("; HttpOnly;");
      expect(setCookie).toContain("; SameSite=Strict");
      expect(setCookie).not.toMatch(/(?:^|;)\s*Domain=/iu);
    }
    const firstSession = cookiePair(first);
    const alphaProfile = profileCookiePair(first);
    expect(alphaProfile.split("=", 2)[1]).toBe(PROFILE_ALPHA);
    expect(Buffer.from(PROFILE_ALPHA, "base64url")).toHaveLength(32);
    const firstBody = (await first.json()) as { ok: true; session: string };
    expect(JSON.stringify(firstBody)).not.toContain(PROFILE_ALPHA);

    const replaced = await handler(
      request("/api/exchange", {
        ...exchange(SECRET_ALPHA),
        headers: {
          ...exchange(SECRET_ALPHA).headers,
          cookie: cookieHeader(firstSession, alphaProfile),
        },
      }),
    );
    expect(replaced.headers.getSetCookie()).toHaveLength(2);
    expect(cookiePair(replaced)).not.toBe(firstSession);
    expect((await replaced.json()) as { session: string }).toMatchObject({
      session: firstBody.session,
    });

    const rotated = await handler(
      request("/api/exchange", {
        ...exchange(SECRET_ALPHA_ROTATED),
        headers: {
          ...exchange(SECRET_ALPHA_ROTATED).headers,
          cookie: cookieHeader(cookiePair(replaced), alphaProfile),
        },
      }),
    );
    expect(rotated.headers.getSetCookie()).toHaveLength(2);
    expect((await rotated.json()) as { session: string }).toMatchObject({
      session: firstBody.session,
    });

    const beta = await handler(
      request("/api/exchange", {
        ...exchange(SECRET_BETA),
        headers: {
          ...exchange(SECRET_BETA).headers,
          cookie: cookieHeader(cookiePair(rotated), alphaProfile),
        },
      }),
    );
    const betaProfile = profileCookiePair(beta);
    expect(betaProfile.split("=", 2)[1]).toBe(PROFILE_BETA);
    expect(betaProfile.split("=", 1)[0]).not.toBe(alphaProfile.split("=", 1)[0]);
    expect((await beta.json()) as { session: string }).not.toMatchObject({
      session: firstBody.session,
    });

    const cleared = await handler(
      request("/api/exchange", {
        ...exchange(SECRET_ALPHA),
        headers: {
          ...exchange(SECRET_ALPHA).headers,
          cookie: cookiePair(beta),
        },
      }),
    );
    expect(profileCookiePair(cleared).split("=", 2)[1]).toBe(profiles[2]);
    expect(profileNumber).toBe(3);
  });

  it("restores only the committed name for the protected profile", async () => {
    const names = new Map<string, string>();
    const forwardedProfiles: string[] = [];
    const profiles = [PROFILE_ALPHA, PROFILE_BETA];
    let profileNumber = 0;
    let sessionNumber = 0;
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "discussion-relay-key",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () =>
        Buffer.alloc(32, 60 + ++sessionNumber).toString("base64url"),
      newProfileSecret: () => profiles[profileNumber++]!,
      fetchRelay: async (relayRequest) => {
        const url = new URL(relayRequest.url);
        if (url.pathname === "/sync/link-exchange") {
          const { secret } = (await relayRequest.json()) as { secret: string };
          return Response.json({
            ok: true,
            grantId: secret === SECRET_BETA ? "grant-beta" : "grant-alpha",
            capabilityToken: secret === SECRET_BETA ? CAP_BETA : CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        const profile = relayRequest.headers.get("x-dohc-link-profile-secret");
        if (!profile) return new Response(null, { status: 404 });
        forwardedProfiles.push(profile);
        if (relayRequest.method === "POST") {
          const input = (await relayRequest.json()) as { body: string; claimedName?: string };
          if (input.claimedName) names.set(profile, input.claimedName);
          return Response.json(publicMessage(input.body));
        }
        return Response.json({
          ok: true,
          activityRevision: 1,
          messages: [],
          nextCursor: null,
          profileName: names.get(profile) ?? null,
        });
      },
    });

    const first = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const firstBody = (await first.clone().json()) as { session: string };
    const firstCookies = cookieHeader(cookiePair(first), profileCookiePair(first));
    const initial = await handler(
      request(`/api/view/discussion?session=${firstBody.session}`, {
        headers: { cookie: firstCookies },
      }),
    );
    expect((await initial.json()) as Record<string, unknown>).toMatchObject({
      profileName: null,
    });

    const profileCookie = profileCookiePair(first);
    const tamperedProfile = `${profileCookie.split("=", 1)[0]}=not-a-profile`;
    const tamperedRead = await handler(
      request(`/api/view/discussion?session=${firstBody.session}`, {
        headers: {
          cookie: cookieHeader(cookiePair(first), tamperedProfile),
        },
      }),
    );
    expect({ status: tamperedRead.status, body: await tamperedRead.text() }).toEqual({
      status: 404,
      body: shareWebRefusalBody,
    });
    expect(forwardedProfiles).toEqual([PROFILE_ALPHA]);

    const append = await handler(
      request("/api/view/discussion", {
        method: "POST",
        headers: {
          ...sessionHeaders(firstBody.session, firstCookies),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          body: "first comment",
          claimedName: "Stable Name",
          idempotencyKey: "profile-name-first",
        }),
      }),
    );
    expect(append.status).toBe(200);

    const renewed = await handler(
      request("/api/exchange", {
        ...exchange(SECRET_ALPHA),
        headers: {
          ...exchange(SECRET_ALPHA).headers,
          cookie: firstCookies,
        },
      }),
    );
    const renewedBody = (await renewed.clone().json()) as { session: string };
    const renewedCookies = cookieHeader(
      cookiePair(renewed),
      profileCookiePair(renewed),
    );
    const restored = await handler(
      request(`/api/view/discussion?session=${renewedBody.session}`, {
        headers: { cookie: renewedCookies },
      }),
    );
    const restoredText = await restored.clone().text();
    expect(JSON.parse(restoredText) as Record<string, unknown>).toMatchObject({
      profileName: "Stable Name",
    });

    const beta = await handler(request("/api/exchange", exchange(SECRET_BETA)));
    const betaBody = (await beta.clone().json()) as { session: string };
    const betaCookies = cookieHeader(cookiePair(beta), profileCookiePair(beta));
    const unnamed = await handler(
      request(`/api/view/discussion?session=${betaBody.session}`, {
        headers: { cookie: betaCookies },
      }),
    );
    expect((await unnamed.json()) as Record<string, unknown>).toMatchObject({
      profileName: null,
    });

    expect(forwardedProfiles).toEqual([
      PROFILE_ALPHA,
      PROFILE_ALPHA,
      PROFILE_ALPHA,
      PROFILE_BETA,
    ]);
    for (const internal of [
      PROFILE_ALPHA,
      PROFILE_BETA,
      CAP_ALPHA_1,
      "grant-alpha",
      "principal-sentinel",
    ]) {
      expect(restoredText).not.toContain(internal);
    }
  });

  it("keeps the profile server-only and sends it only on protected discussion requests", async () => {
    const relayKey = "discussion-relay-key-sentinel";
    const relayRequests: Request[] = [];
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: relayKey,
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 50).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        relayRequests.push(relayRequest.clone());
        const url = new URL(relayRequest.url);
        if (url.pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-profile-sentinel",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        if (relayRequest.method === "GET") {
          return Response.json({ ok: true, messages: [], nextCursor: null });
        }
        return Response.json(publicMessage("accepted public body"));
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const exchangeBody = (await exchanged.clone().json()) as { session: string };
    const cookies = cookieHeader(cookiePair(exchanged), profileCookiePair(exchanged));

    const read = await handler(
      request(
        `/api/view/discussion?session=${exchangeBody.session}&direction=newest-first&limit=17&cursor=abc`,
        { headers: { cookie: cookies } },
      ),
    );
    const appendText = JSON.stringify({
      body: "accepted public body",
      claimedName: "Public profile",
      idempotencyKey: "append-once",
    });
    const append = await handler(
      request("/api/view/discussion", {
        method: "POST",
        headers: {
          ...sessionHeaders(exchangeBody.session, cookies),
          "content-type": "application/json",
        },
        body: appendText,
      }),
    );

    expect(read.status).toBe(200);
    expect(append.status).toBe(200);
    expect(await append.clone().json()).toEqual(publicMessage("accepted public body"));
    const discussionRequests = relayRequests.slice(1);
    expect(discussionRequests).toHaveLength(2);
    expect(discussionRequests[0]!.method).toBe("GET");
    expect(discussionRequests[0]!.url).toBe(
      "http://relay.test/sync/link/discussion?cursor=abc&direction=newest-first&limit=17",
    );
    expect(discussionRequests[0]!.headers.get("authorization")).toBe(
      `LinkCapability ${CAP_ALPHA_1}`,
    );
    expect(discussionRequests[0]!.headers.get("x-dohc-link-profile-secret")).toBe(
      PROFILE_ALPHA,
    );
    expect(discussionRequests[0]!.headers.get("x-dohc-relay-exchange-key")).toBeNull();
    expect(discussionRequests[1]!.method).toBe("POST");
    expect(discussionRequests[1]!.url).toBe(
      "http://relay.test/sync/link/discussion",
    );
    expect(discussionRequests[1]!.headers.get("authorization")).toBe(
      `LinkCapability ${CAP_ALPHA_1}`,
    );
    expect(discussionRequests[1]!.headers.get("x-dohc-link-profile-secret")).toBe(
      PROFILE_ALPHA,
    );
    expect(discussionRequests[1]!.headers.get("x-dohc-relay-exchange-key")).toBe(
      relayKey,
    );
    expect(await discussionRequests[1]!.text()).toBe(appendText);

    const browserText = [
      await exchanged.clone().text(),
      await read.clone().text(),
      await append.clone().text(),
      exchangeBody.session,
      ...[...logs.mock.calls, ...errors.mock.calls].flat().map(String),
    ].join("\n");
    for (const secret of [
      PROFILE_ALPHA,
      relayKey,
      CAP_ALPHA_1,
      SECRET_ALPHA,
      "grant-profile-sentinel",
    ]) {
      expect(browserText).not.toContain(secret);
    }
    for (const relayRequest of discussionRequests) {
      expect(relayRequest.url).not.toContain(PROFILE_ALPHA);
    }
  });

  it("proxies closed discussion activity with protected authority and client abort", async () => {
    const relayKey = "activity-relay-key-sentinel";
    const grant = "grant-activity-sentinel";
    const activityRequests: Request[] = [];
    let activityCalls = 0;
    const publicActivity = {
      ok: true,
      access: "comment",
      latestRevision: 8,
      cursorRevision: 8,
      hasMore: false,
      messages: [],
      composerState: "available",
    };
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: relayKey,
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 57).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        const url = new URL(relayRequest.url);
        if (url.pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: grant,
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        activityRequests.push(relayRequest);
        activityCalls += 1;
        if (activityCalls === 1) return Response.json(publicActivity);
        if (activityCalls === 2) {
          return await new Promise<Response>((_resolve, reject) => {
            relayRequest.signal.addEventListener(
              "abort",
              () => reject(relayRequest.signal.reason),
              { once: true },
            );
          });
        }
        return Response.json(
          { ok: false, code: "internal_refusal", grantId: grant },
          { status: 403 },
        );
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const { session } = (await exchanged.clone().json()) as { session: string };
    const cookies = cookieHeader(cookiePair(exchanged), profileCookiePair(exchanged));
    const headers = sessionHeaders(session, cookies);
    const path = "/api/view/discussion/activity?since=7&hold=30000&limit=100";

    const accepted = await handler(request(path, { headers }));
    expect({ status: accepted.status, body: await accepted.clone().json() }).toEqual({
      status: 200,
      body: publicActivity,
    });
    expect(activityRequests[0]!.url).toBe(
      "http://relay.test/sync/link/discussion/activity?since=7&hold=30000&limit=100",
    );
    expect(activityRequests[0]!.method).toBe("GET");
    expect(activityRequests[0]!.headers.get("authorization")).toBe(
      `LinkCapability ${CAP_ALPHA_1}`,
    );
    expect(activityRequests[0]!.headers.get("x-dohc-link-profile-secret")).toBe(
      PROFILE_ALPHA,
    );
    expect(activityRequests[0]!.headers.get("x-dohc-relay-exchange-key")).toBeNull();
    expect(activityRequests[0]!.headers.get("cookie")).toBeNull();
    expect(activityRequests[0]!.headers.get("x-dohc-link-session")).toBeNull();

    const invalid = await handler(
      request(`${path}&cursor=forged`, { headers }),
    );
    expect({ status: invalid.status, body: await invalid.clone().text() }).toEqual({
      status: 404,
      body: shareWebRefusalBody,
    });
    expect(activityCalls).toBe(1);

    const controller = new AbortController();
    const aborted = handler(request(path, { headers, signal: controller.signal }));
    await vi.waitFor(() => expect(activityCalls).toBe(2));
    controller.abort();
    const abortedResponse = await aborted;
    expect(activityRequests[1]!.signal.aborted).toBe(true);
    expect({
      status: abortedResponse.status,
      body: await abortedResponse.clone().text(),
    }).toEqual({
      status: 503,
      body: shareWebRefusalBody,
    });

    const refused = await handler(request(path, { headers }));
    expect({ status: refused.status, body: await refused.clone().text() }).toEqual({
      status: 404,
      body: shareWebRefusalBody,
    });
    const browserText = [
      await exchanged.clone().text(),
      await accepted.clone().text(),
      await invalid.clone().text(),
      await abortedResponse.clone().text(),
      await refused.clone().text(),
    ].join("\n");
    for (const internal of [relayKey, grant, CAP_ALPHA_1, PROFILE_ALPHA, SECRET_ALPHA]) {
      expect(browserText).not.toContain(internal);
    }
  });

  it("refuses invalid append transports and session bindings before the relay", async () => {
    let now = 1_000;
    let discussionCalls = 0;
    const forwardedAppends: string[] = [];
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "discussion-relay-key",
      publicHosts: new Set([HOST]),
      nowMs: () => now,
      newSessionToken: () => Buffer.alloc(32, 51).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-validation",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        discussionCalls += 1;
        forwardedAppends.push(await relayRequest.clone().text());
        return Response.json(publicMessage("accepted"));
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const { session } = (await exchanged.clone().json()) as { session: string };
    const cookies = cookieHeader(cookiePair(exchanged), profileCookiePair(exchanged));
    const headers = {
      ...sessionHeaders(session, cookies),
      "content-type": "application/json",
    };
    const maximumBody = "🙂".repeat(2_000);
    const maximumText = JSON.stringify({
      body: maximumBody,
      claimedName: "🙂".repeat(40),
      idempotencyKey: '"'.repeat(64),
    });
    expect(Buffer.byteLength(maximumBody)).toBe(8_000);
    expect(Buffer.byteLength(maximumText)).toBeGreaterThan(8_000);
    const maximum = await handler(
      request("/api/view/discussion", {
        method: "POST",
        headers,
        body: maximumText,
      }),
    );
    expect(maximum.status).toBe(200);
    expect(discussionCalls).toBe(1);
    expect(forwardedAppends).toEqual([maximumText]);

    const oversizedText = JSON.stringify({
      body: "x".repeat(16 * 1_024),
      idempotencyKey: "oversized-transport",
    });
    expect(Buffer.byteLength(oversizedText)).toBeGreaterThan(16 * 1_024);
    const oversized = await handler(
      request("/api/view/discussion", {
        method: "POST",
        headers,
        body: oversizedText,
      }),
    );
    expect({ status: oversized.status, body: await oversized.text() }).toEqual({
      status: 404,
      body: shareWebRefusalBody,
    });
    expect(discussionCalls).toBe(1);

    const mismatchedSession = "mismatch1234";
    expect(mismatchedSession).not.toBe(session);
    const mismatched = await handler(
      request(`/api/view/discussion?session=${mismatchedSession}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          body: "mismatched session",
          idempotencyKey: "mismatched-session",
        }),
      }),
    );
    expect({ status: mismatched.status, body: await mismatched.text() }).toEqual({
      status: 404,
      body: shareWebRefusalBody,
    });
    expect(discussionCalls).toBe(1);

    const invalidRequests = [
      request("/api/view/discussion", {
        method: "POST",
        headers,
        body: `${maximumText} trailing-garbage`,
      }),
      request("/api/view/discussion", {
        method: "POST",
        headers,
        body: "{not-json",
      }),
      request("/api/view/discussion", {
        method: "POST",
        headers,
        body: "[]",
      }),
      request("/api/view/discussion", {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "missing key" }),
      }),
      ...[
        "authorId",
        "principalId",
        "linkGrantId",
        "provenance",
        "attachment",
        "reaction",
        "decision",
        "anchor",
        "markupMode",
        "urlMetadata",
      ].map((field) =>
        request("/api/view/discussion", {
          method: "POST",
          headers,
          body: JSON.stringify({
            body: "closed body",
            idempotencyKey: `forged-${field}`,
            [field]: `forged-${field}`,
          }),
        }),
      ),
      request("/api/view/discussion", {
        method: "PUT",
        headers,
        body: JSON.stringify({ body: "wrong method", idempotencyKey: "wrong-method" }),
      }),
      request("/api/view/discussion", {
        method: "POST",
        headers: {
          ...headers,
          "x-dohc-link-session": "wrongsession",
        },
        body: JSON.stringify({ body: "wrong session", idempotencyKey: "wrong-session" }),
      }),
    ];
    for (const invalidRequest of invalidRequests) {
      const refusal = await handler(invalidRequest);
      expect({ status: refusal.status, body: await refusal.text() }).toEqual({
        status: 404,
        body: shareWebRefusalBody,
      });
      expectSecurityHeaders(refusal);
      expect(refusal.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(discussionCalls).toBe(1);

    now = 901_000 + LINK_SESSION_RENEWAL_GRACE_MS + 1;
    const stale = await handler(
      request("/api/view/discussion", {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "stale", idempotencyKey: "stale-session" }),
      }),
    );
    expect({ status: stale.status, body: await stale.text() }).toEqual({
      status: 404,
      body: shareWebRefusalBody,
    });
    expect(discussionCalls).toBe(1);
  });

  it("refuses an old append response after session replacement and retries exactly", async () => {
    let exchangeCalls = 0;
    let discussionCalls = 0;
    let releaseOldAppend: (() => void) | undefined;
    const oldAppendGate = new Promise<void>((resolve) => {
      releaseOldAppend = resolve;
    });
    const appendBodies: string[] = [];
    let sessionNumber = 0;
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "discussion-relay-key",
      publicHosts: new Set([HOST]),
      maxSessions: 1,
      nowMs: () => 1_000,
      newSessionToken: () =>
        Buffer.alloc(32, 53 + sessionNumber++).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          exchangeCalls += 1;
          return Response.json({
            ok: true,
            grantId: "grant-currentness",
            capabilityToken: exchangeCalls === 1 ? CAP_ALPHA_1 : CAP_ALPHA_2,
            capabilityExpiresAtMs: 901_000,
          });
        }
        discussionCalls += 1;
        appendBodies.push(await relayRequest.clone().text());
        if (discussionCalls === 1) await oldAppendGate;
        return Response.json(publicMessage("once"));
      },
    });
    const firstExchange = await handler(
      request("/api/exchange", exchange(SECRET_ALPHA)),
    );
    const firstState = (await firstExchange.clone().json()) as { session: string };
    const profile = profileCookiePair(firstExchange);
    const appendText = JSON.stringify({ body: "once", idempotencyKey: "retry-once" });
    const firstAppend = handler(
      request("/api/view/discussion", {
        method: "POST",
        headers: {
          ...sessionHeaders(
            firstState.session,
            cookieHeader(cookiePair(firstExchange), profile),
          ),
          "content-type": "application/json",
        },
        body: appendText,
      }),
    );
    await vi.waitFor(() => expect(discussionCalls).toBe(1));

    const replacementExchange = await handler(
      request("/api/exchange", {
        ...exchange(SECRET_ALPHA_ROTATED),
        headers: {
          ...exchange(SECRET_ALPHA_ROTATED).headers,
          cookie: cookieHeader(cookiePair(firstExchange), profile),
        },
      }),
    );
    expect(replacementExchange.headers.getSetCookie()).toHaveLength(2);
    const replacementState = (await replacementExchange.clone().json()) as {
      session: string;
    };
    expect(replacementState.session).toBe(firstState.session);
    releaseOldAppend?.();
    const staleResponse = await firstAppend;
    expect({ status: staleResponse.status, body: await staleResponse.text() }).toEqual({
      status: 404,
      body: shareWebRefusalBody,
    });
    expect(staleResponse.headers.has("set-cookie")).toBe(false);

    const retry = await handler(
      request("/api/view/discussion", {
        method: "POST",
        headers: {
          ...sessionHeaders(
            replacementState.session,
            cookieHeader(cookiePair(replacementExchange), profile),
          ),
          "content-type": "application/json",
        },
        body: appendText,
      }),
    );
    expect(retry.status).toBe(200);
    expect(appendBodies).toEqual([appendText, appendText]);
    expect(
      appendBodies.map(
        (body) => (JSON.parse(body) as { idempotencyKey: string }).idempotencyKey,
      ),
    ).toEqual(["retry-once", "retry-once"]);
  });

  it("marks only a superseded activity response as retryable", async () => {
    let exchangeCalls = 0;
    let activityCalls = 0;
    let releaseOldActivity: (() => void) | undefined;
    const oldActivityGate = new Promise<void>((resolve) => {
      releaseOldActivity = resolve;
    });
    let sessionNumber = 0;
    const activityBody = {
      ok: true,
      access: "comment",
      latestRevision: 0,
      cursorRevision: 0,
      hasMore: false,
      messages: [],
      composerState: "available",
    };
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "discussion-relay-key",
      publicHosts: new Set([HOST]),
      maxSessions: 1,
      nowMs: () => 1_000,
      newSessionToken: () =>
        Buffer.alloc(32, 57 + sessionNumber++).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          exchangeCalls += 1;
          return Response.json({
            ok: true,
            grantId: "grant-activity-currentness",
            capabilityToken: exchangeCalls === 1 ? CAP_ALPHA_1 : CAP_ALPHA_2,
            capabilityExpiresAtMs: 901_000,
          });
        }
        activityCalls += 1;
        if (activityCalls === 1) await oldActivityGate;
        return Response.json(activityBody);
      },
    });
    const firstExchange = await handler(
      request("/api/exchange", exchange(SECRET_ALPHA)),
    );
    const firstState = (await firstExchange.clone().json()) as { session: string };
    const profile = profileCookiePair(firstExchange);
    const firstActivity = handler(
      request("/api/view/discussion/activity?since=0&hold=30000&limit=100", {
        headers: sessionHeaders(
          firstState.session,
          cookieHeader(cookiePair(firstExchange), profile),
        ),
      }),
    );
    await vi.waitFor(() => expect(activityCalls).toBe(1));

    const replacementExchange = await handler(
      request("/api/exchange", {
        ...exchange(SECRET_ALPHA_ROTATED),
        headers: {
          ...exchange(SECRET_ALPHA_ROTATED).headers,
          cookie: cookieHeader(cookiePair(firstExchange), profile),
        },
      }),
    );
    const replacementState = (await replacementExchange.clone().json()) as {
      session: string;
    };
    expect(replacementState.session).toBe(firstState.session);
    releaseOldActivity?.();

    const staleResponse = await firstActivity;
    expect({ status: staleResponse.status, body: await staleResponse.text() }).toEqual({
      status: 409,
      body: shareWebRefusalBody,
    });
    expect(staleResponse.headers.has("set-cookie")).toBe(false);

    const retry = await handler(
      request("/api/view/discussion/activity?since=0&hold=30000&limit=100", {
        headers: sessionHeaders(
          replacementState.session,
          cookieHeader(cookiePair(replacementExchange), profile),
        ),
      }),
    );
    expect({ status: retry.status, body: await retry.json() }).toEqual({
      status: 200,
      body: activityBody,
    });
    expect(activityCalls).toBe(2);
  });

  it("translates only recognized discussion states and hides every relay detail", async () => {
    const relayKey = "discussion-error-key-sentinel";
    const grant = "grant-error-sentinel";
    const principal = "principal-error-sentinel";
    const relayResponses = [
      () =>
        Response.json(
          {
            ok: false,
            code: "link_discussion_blocked",
            error: "link discussion writes are blocked",
            activityRevision: 8,
          },
          { status: 403 },
        ),
      () =>
        Response.json(
          {
            ok: false,
            code: "link_discussion_paused",
            error: "link discussion writes are paused",
            activityRevision: 9,
          },
          { status: 403 },
        ),
      () =>
        Response.json(
          {
            ok: false,
            code: "link_discussion_blocked",
            error: "link discussion writes are paused",
            activityRevision: 11,
          },
          { status: 403 },
        ),
      () =>
        Response.json(
          {
            ok: false,
            code: "link_discussion_blocked",
            error: "link discussion writes are blocked",
          },
          { status: 403 },
        ),
      () =>
        Response.json(
          {
            ok: false,
            code: "link_discussion_blocked",
            error: "link discussion writes are blocked",
            activityRevision: -1,
          },
          { status: 403 },
        ),
      () =>
        Response.json(
          {
            ok: false,
            code: "link_discussion_paused",
            error: "link discussion writes are paused",
            activityRevision: 1.5,
          },
          { status: 403 },
        ),
      () =>
        Response.json(
          {
            ok: false,
            code: "link_discussion_paused",
            error: "link discussion writes are paused",
            activityRevision: Number.MAX_SAFE_INTEGER + 1,
          },
          { status: 403 },
        ),
      () =>
        Response.json(
          {
            ok: false,
            code: "link_discussion_blocked",
            error: "link discussion writes are blocked",
            activityRevision: 10,
            principal,
          },
          { status: 403 },
        ),
      () =>
        Response.json(
          {
            ok: false,
            code: "link_discussion_paused",
            error: "link discussion writes are paused",
            activityRevision: 12,
          },
          { status: 413 },
        ),
      () =>
        Response.json(
          { ok: false, code: "other_forbidden", error: PROFILE_ALPHA },
          { status: 403 },
        ),
      () => Response.json({ ok: false, error: relayKey }, { status: 403 }),
      () => new Response(`credential ${SECRET_ALPHA}`, { status: 404 }),
      () => new Response(`rate ${principal}`, { status: 429 }),
      () => new Response(`conflict ${grant}`, { status: 409 }),
      () => new Response(`failure ${CAP_ALPHA_1}`, { status: 500 }),
    ];
    let attempt = 0;
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const relayUrls: string[] = [];
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: relayKey,
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 55).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        relayUrls.push(relayRequest.url);
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: grant,
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        return relayResponses[attempt++]!();
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const { session } = (await exchanged.clone().json()) as { session: string };
    const cookies = cookieHeader(cookiePair(exchanged), profileCookiePair(exchanged));
    const responses: Response[] = [];
    for (let index = 0; index < relayResponses.length; index += 1) {
      responses.push(
        await handler(
          request("/api/view/discussion", {
            method: "POST",
            headers: {
              ...sessionHeaders(session, cookies),
              "content-type": "application/json",
            },
            body: JSON.stringify({ body: "state", idempotencyKey: `state-${index}` }),
          }),
        ),
      );
    }

    expect({ status: responses[0]!.status, body: await responses[0]!.json() }).toEqual({
      status: 403,
      body: { ok: false, state: "blocked", activityRevision: 8 },
    });
    expect({ status: responses[1]!.status, body: await responses[1]!.json() }).toEqual({
      status: 403,
      body: { ok: false, state: "paused", activityRevision: 9 },
    });
    // The code is the contract; the relay message text is not.
    expect({ status: responses[2]!.status, body: await responses[2]!.json() }).toEqual({
      status: 403,
      body: { ok: false, state: "blocked", activityRevision: 11 },
    });
    const genericStatuses = [404, 404, 404, 404, 404, 404, 404, 404, 404, 429, 404, 503];
    for (const [index, status] of genericStatuses.entries()) {
      const response = responses[index + 3]!;
      expect({ status: response.status, body: await response.text() }).toEqual({
        status,
        body: shareWebRefusalBody,
      });
    }
    for (const response of responses) {
      expectSecurityHeaders(response);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    const browserText = [
      ...responses.map((response) => response.statusText),
      ...[...logs.mock.calls, ...errors.mock.calls].flat().map(String),
    ].join("\n");
    for (const sentinel of [
      PROFILE_ALPHA,
      relayKey,
      CAP_ALPHA_1,
      SECRET_ALPHA,
      grant,
      principal,
      "link_discussion_blocked",
      "link_discussion_paused",
    ]) {
      expect(browserText).not.toContain(sentinel);
      expect(relayUrls.every((url) => !url.includes(sentinel))).toBe(true);
    }
  });

  it("publishes only the exact durable discussion limit refusal", async () => {
    const relayKey = "discussion-limit-error-key-sentinel";
    const relayReasons = ["principal-limit", "lifetime-limit", "share-limit"];
    const relayResponses = [
      () => Response.json(
        {
          ok: false,
          code: "discussion_limit_reached",
          error: "discussion message limit reached",
        },
        { status: 413 },
      ),
      ...relayReasons.map((reason) => () =>
        Response.json(
          {
            ok: false,
            code: "discussion_limit_reached",
            error: "discussion message limit reached",
            reason: `${reason}-private-sentinel`,
          },
          { status: 413 },
        )),
      () => Response.json(
        {
          ok: false,
          code: "discussion_limit_reached",
          error: "discussion message limit reached",
          activityRevision: 12,
        },
        { status: 413 },
      ),
      () => Response.json(
        { ok: false, code: "discussion_limit_reached", error: "wrong-403-sentinel" },
        { status: 403 },
      ),
      () => Response.json(
        { ok: false, code: "link_discussion_paused", error: "wrong-paused-sentinel" },
        { status: 413 },
      ),
      () => Response.json(
        { ok: false, code: "unknown_limit", error: "unknown-code-sentinel" },
        { status: 413 },
      ),
      () => new Response("{malformed-limit-sentinel", {
        status: 413,
        headers: { "content-type": "application/json" },
      }),
      () => new Response(null, { status: 413 }),
    ];
    let attempt = 0;
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: relayKey,
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 56).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-limit-sentinel",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        return relayResponses[attempt++]!();
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const { session } = (await exchanged.clone().json()) as { session: string };
    const cookies = cookieHeader(cookiePair(exchanged), profileCookiePair(exchanged));
    const responses: Response[] = [];
    for (let index = 0; index < relayResponses.length; index += 1) {
      responses.push(await handler(request("/api/view/discussion", {
        method: "POST",
        headers: {
          ...sessionHeaders(session, cookies),
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: "limit", idempotencyKey: `limit-${index}` }),
      })));
    }

    const publicLimitBytes: string[] = [];
    for (const response of responses.slice(0, 1)) {
      publicLimitBytes.push(`${response.status}:${await response.text()}`);
    }
    expect(new Set(publicLimitBytes)).toEqual(new Set([
      '413:{"ok":false,"state":"limit-reached"}',
    ]));
    for (const response of responses.slice(1)) {
      expect({ status: response.status, body: await response.text() }).toEqual({
        status: 404,
        body: shareWebRefusalBody,
      });
    }
    for (const response of responses) {
      expectSecurityHeaders(response);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    const exposed = [
      ...publicLimitBytes,
      ...responses.map((response) => response.statusText),
      ...[...logs.mock.calls, ...errors.mock.calls].flat().map(String),
    ].join("\n");
    for (const sentinel of [
      relayKey,
      "discussion_limit_reached",
      "link_discussion_paused",
      ...relayReasons.map((reason) => `${reason}-private-sentinel`),
      "wrong-403-sentinel",
      "wrong-paused-sentinel",
      "unknown-code-sentinel",
      "malformed-limit-sentinel",
    ]) {
      expect(exposed).not.toContain(sentinel);
    }
  });
});

describe("share-web handoff adapter", () => {
  async function exchangedSession(options: {
    fetchRelay: (request: Request) => Promise<Response>;
    nowMs?: () => number;
    publicRelayUrl?: string;
  }): Promise<{
    handler: ReturnType<typeof createShareWebHandler>;
    discriminator: string;
    cookie: string;
  }> {
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: HANDOFF_EXCHANGE_KEY,
      publicHosts: new Set([HOST]),
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-handoff",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        return await options.fetchRelay(relayRequest);
      },
      nowMs: options.nowMs ?? (() => 1_000),
      newSessionToken: () => Buffer.alloc(32, 41).toString("base64url"),
      ...(options.publicRelayUrl
        ? { publicRelayUrl: options.publicRelayUrl }
        : {}),
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    expect(exchanged.status).toBe(200);
    const body = (await exchanged.json()) as { session: string };
    return {
      handler,
      discriminator: body.session,
      cookie: cookiePair(exchanged),
    };
  }

  async function generic(response: Response, status: 404 | 429 | 503): Promise<void> {
    expect({ status: response.status, body: await response.text() }).toEqual({
      status,
      body: shareWebRefusalBody,
    });
  }

  function handoffHeaders(discriminator: string, cookie: string): Record<string, string> {
    return {
      cookie,
      "x-dohc-link-session": discriminator,
    };
  }

  it("requires an allowed Host, viewer cookie, and explicit handoff session header", async () => {
    let now = 1_000;
    let mintCalls = 0;
    const upstreamSecret = Buffer.alloc(32, 51).toString("base64url");
    const state = await exchangedSession({
      nowMs: () => now,
      fetchRelay: async (relayRequest) => {
        expect(new URL(relayRequest.url).pathname).toBe("/sync/link-handoff");
        mintCalls += 1;
        return new Response(
          JSON.stringify({ ok: false, code: HANDOFF_CODE, secret: upstreamSecret }),
          { status: 404 },
        );
      },
    });
    const headers = handoffHeaders(state.discriminator, state.cookie);

    const failures = [
      await state.handler(
        request("/api/handoff", {
          method: "POST",
          headers: { "x-dohc-link-session": state.discriminator },
        }),
      ),
      await state.handler(
        request("/api/handoff", { method: "POST", headers: { cookie: state.cookie } }),
      ),
      await state.handler(
        request(`/api/handoff?session=${state.discriminator}`, {
          method: "POST",
          headers: { cookie: state.cookie },
        }),
      ),
      await state.handler(
        request("/api/handoff", {
          method: "POST",
          headers: { cookie: state.cookie, "x-dohc-link-session": "wrongsession" },
        }),
      ),
      await state.handler(
        new Request("https://evil.example/api/handoff", {
          method: "POST",
          headers: { host: "evil.example", ...headers },
        }),
      ),
      await state.handler(request("/api/handoff", { method: "POST", headers })),
    ];

    now = 901_000 + LINK_SESSION_RENEWAL_GRACE_MS + 1;
    failures.push(
      await state.handler(request("/api/handoff", { method: "POST", headers })),
    );

    for (const failure of failures) {
      const text = await failure.clone().text();
      expect(text).not.toContain(HANDOFF_CODE);
      expect(text).not.toContain(upstreamSecret);
      await generic(failure, 404);
    }
    expect(mintCalls).toBe(1);
  });

  it("forwards only the current capability and exchange key with an empty body", async () => {
    const completeUrl = `https://${HOST}/s#${SECRET_ALPHA}`;
    const upstreamRelayUrl = "https://relay-response.example?secret=upstream";
    const configuredPublicRelayUrl = "https://relay-for-desktop.example";
    const cookieToken = Buffer.alloc(32, 41).toString("base64url");
    const diagnostics: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...values) => {
      diagnostics.push(values.map(String).join(" "));
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...values) => {
      diagnostics.push(values.map(String).join(" "));
    });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let capturedBody = "not-called";
    let capturedHeaders: Record<string, string> = {};
    const state = await exchangedSession({
      publicRelayUrl: configuredPublicRelayUrl,
      fetchRelay: async (relayRequest) => {
        expect(new URL(relayRequest.url).pathname).toBe("/sync/link-handoff");
        expect(relayRequest.method).toBe("POST");
        capturedBody = await relayRequest.text();
        capturedHeaders = Object.fromEntries(relayRequest.headers);
        return Response.json({
          ok: true,
          code: HANDOFF_CODE,
          expiresAtMs: 301_000,
          capabilityToken: CAP_ALPHA_2,
          url: completeUrl,
          grantId: "private-grant",
          shareId: "private-share",
          viewerCookieToken: cookieToken,
          relayUrl: upstreamRelayUrl,
        });
      },
    });

    const handoff = await state.handler(
      request("/api/handoff", {
        method: "POST",
        headers: handoffHeaders(state.discriminator, state.cookie),
      }),
    );
    const responseText = await handoff.text();
    const stdout = stdoutSpy.mock.calls.map((call) => String(call[0]));
    const stderr = stderrSpy.mock.calls.map((call) => String(call[0]));
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();

    expect(handoff.status).toBe(200);
    expect(JSON.parse(responseText)).toEqual({
      ok: true,
      code: HANDOFF_CODE,
      relayUrl: configuredPublicRelayUrl,
      expiresAtMs: 301_000,
    });
    expect(capturedHeaders).toEqual({
      authorization: `LinkCapability ${CAP_ALPHA_1}`,
      "x-dohc-relay-exchange-key": HANDOFF_EXCHANGE_KEY,
    });
    expect(capturedBody).toBe("");
    const secretSurfaces = [
      responseText.replace(HANDOFF_CODE, ""),
      capturedBody,
      ...diagnostics,
      ...stdout,
      ...stderr,
    ].join("\n");
    for (const secret of [
      CAP_ALPHA_1,
      CAP_ALPHA_2,
      SECRET_ALPHA,
      completeUrl,
      cookieToken,
      upstreamRelayUrl,
    ]) {
      expect(secretSurfaces).not.toContain(secret);
    }
  });

  it("refuses malformed handoff mints with 503 and exposes nothing from them", async () => {
    const attempts: Array<() => Response> = [
      () => new Response("not-json", { status: 200 }),
      () => Response.json({ ok: false, code: HANDOFF_CODE, expiresAtMs: 301_000 }),
      () => Response.json({ ok: true, code: "short", expiresAtMs: 301_000 }),
      () => Response.json({ ok: true, code: HANDOFF_CODE, expiresAtMs: 1_000 }),
      () => Response.json({ ok: true, code: HANDOFF_CODE, expiresAtMs: 301_000.5 }),
      () =>
        Response.json({
          ok: true,
          code: HANDOFF_CODE,
          expiresAtMs: Number.MAX_SAFE_INTEGER + 1,
        }),
    ];
    let attempt = 0;
    const state = await exchangedSession({
      fetchRelay: async () => attempts[attempt++]!(),
    });
    const headers = handoffHeaders(state.discriminator, state.cookie);
    for (let index = 0; index < attempts.length; index += 1) {
      await generic(
        await state.handler(request("/api/handoff", { method: "POST", headers })),
        503,
      );
    }
  });
});

describe("public Edit release isolation", () => {
  it("does not create a browser session from an enabled relay when this viewer is closed", async () => {
    const handle = createShareWebHandler({
      relayUrl: "https://relay.example.test", publicHosts: new Set([HOST]),
      fetchRelay: async () => Response.json({grantId: "grant-edit", access: "edit", capabilityToken: CAP_ALPHA_1, capabilityExpiresAtMs: Date.now() + 60_000}),
    });
    const result = await handle(request("/api/exchange", exchange(SECRET_ALPHA)));
    expect(result.status).toBe(404);
    expect(result.headers.get("set-cookie")).toBeNull();
  });
  it("rejects a marker without an explicit live profile", () => {
    expect(() => createShareWebApplication({relayUrl: "https://relay.example.test", publicRelayUrl: PUBLIC_RELAY_URL,
      publicHosts: new Set([HOST]), publicEditRelease: {version: 1}})).toThrow(/Public Edit release requires/);
  });
});

it("keeps Edit exchange closed when only the viewer release is enabled", async () => {
  const editor = {provider: {frames: {receive: {maxFrameBytes: 1024, maxStateVectorBytes: 4096, maxUpdateBytes: 8192, maxSyncBytes: 16384},
    maxQueuedBytes: 16384, maxQueuedFrames: 64, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 16384},
    maxPendingUpdateBytes: 16384, maxPendingUpdates: 8, maxDeliveryAttempts: 4},
    maxHttpResponseBytes: 16384, maxSocketBufferedBytes: 16384, connectTimeoutMs: 2000, sendTimeoutMs: 500, drainPollMs: 10};
  let relayReleased = false;
  const handle = createShareWebHandler({relayUrl: "https://relay.example.test", publicHosts: new Set([HOST]),
    relayExchangeKey: HANDOFF_EXCHANGE_KEY, publicEditRelease: {version: 1},
    linkLive: {publicOrigin: `https://${HOST}`, requests: {maxPendingRequests: 1, maxRequestBytes: 2048, maxResponseBytes: 8192, timeoutMs: 1000}, editor},
    fetchRelay: async () => relayReleased
      ? Response.json({grantId: "grant-edit", access: "edit", capabilityToken: CAP_ALPHA_1, capabilityExpiresAtMs: Date.now() + 60_000})
      : new Response(null, {status: 404}),
  });
  const closed = await handle(request("/api/exchange", exchange(SECRET_ALPHA)));
  expect(closed.status).toBe(404);
  expect(closed.headers.get("set-cookie")).toBeNull();
  relayReleased = true;
  expect((await handle(request("/api/exchange", exchange(SECRET_ALPHA)))).status).toBe(200);
});

it("does not install an Edit renewal when the viewer release is absent", async () => {
  let now = 1_000;
  const readCapabilities: string[] = [];
  const handle = createShareWebHandler({relayUrl: "http://relay.test", publicHosts: new Set([HOST]),
    nowMs: () => now, relayExchangeKey: HANDOFF_EXCHANGE_KEY,
    fetchRelay: async relayRequest => {
      const path = new URL(relayRequest.url).pathname;
      if (path === "/sync/link-exchange") return Response.json({grantId: "grant-renewal", access: "view",
        capabilityToken: CAP_ALPHA_1, capabilityExpiresAtMs: 901_000});
      if (path === "/sync/link-refresh") return Response.json({grantId: "grant-renewal", access: "edit",
        capabilityToken: CAP_ALPHA_2, capabilityExpiresAtMs: now + 900_000});
      readCapabilities.push(relayRequest.headers.get("authorization") ?? "");
      return Response.json({ok: true, access: "view"});
    },
  });
  const exchanged = await handle(request("/api/exchange", exchange(SECRET_ALPHA)));
  expect(exchanged.status).toBe(200);
  const body = await exchanged.json() as {session: string};
  const headers = {cookie: cookiePair(exchanged), "x-dohc-link-session": body.session};
  now = 601_001;
  const nearExpiry = await handle(request("/api/view/meta", {headers}));
  expect(nearExpiry.status).toBe(200);
  expect(nearExpiry.headers.get("set-cookie")).toBeNull();
  expect(readCapabilities).toEqual([`LinkCapability ${CAP_ALPHA_1}`]);
  now = 901_001;
  expect((await handle(request("/api/view/meta", {headers}))).status).toBe(503);
  expect(readCapabilities).toEqual([`LinkCapability ${CAP_ALPHA_1}`]);
});
