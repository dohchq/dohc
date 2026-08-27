import { afterEach, describe, expect, it, vi } from "vitest";
import { loadShareWebConfig } from "./config";
import {
  createShareWebHandler,
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
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
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

  it("relays a generic 429 for a throttled read and preserves the session", async () => {
    let readCalls = 0;
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 22).toString("base64url"),
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-throttled",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        readCalls += 1;
        if (readCalls === 1) {
          return new Response("relay-specific throttle detail", { status: 429 });
        }
        return Response.json({
          ok: true,
          access: "view",
          granterEmail: "owner@example.test",
        });
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const body = (await exchanged.json()) as { session: string };
    const sessionHeaders = {
      cookie: cookiePair(exchanged),
      "x-dohc-link-session": body.session,
    };

    const throttled = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );

    expect(throttled.status).toBe(429);
    expect(await throttled.text()).toBe(shareWebRefusalBody);
    expectSecurityHeaders(throttled);

    const retried = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ granterEmail: "owner@example.test" });
    expect(readCalls).toBe(2);
  });

  it("returns a generic 503 for a relay transport failure while a received 404 stays 404", async () => {
    let readCalls = 0;
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 23).toString("base64url"),
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-transport-failure",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        readCalls += 1;
        if (readCalls === 1) throw new Error("temporary relay outage");
        return new Response("relay-specific missing resource", { status: 404 });
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const body = (await exchanged.json()) as { session: string };
    const sessionHeaders = {
      cookie: cookiePair(exchanged),
      "x-dohc-link-session": body.session,
    };

    const unavailable = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );
    expect({ status: unavailable.status, body: await unavailable.text() }).toEqual({
      status: 503,
      body: shareWebRefusalBody,
    });
    expectSecurityHeaders(unavailable);

    const receivedNotFound = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );
    expect({
      status: receivedNotFound.status,
      body: await receivedNotFound.text(),
    }).toEqual({
      status: 404,
      body: shareWebRefusalBody,
    });
    expectSecurityHeaders(receivedNotFound);
    expect(readCalls).toBe(2);
  });

  it("preserves the session after a relay 404 resource miss", async () => {
    const missingSha = "a".repeat(64);
    const expectedMetaBody = JSON.stringify({ ok: true, access: "view" });
    const relayReads: string[] = [];
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 24).toString("base64url"),
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        if (pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-resource-miss",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        relayReads.push(pathname);
        if (pathname === `/sync/link/blobs/${missingSha}`) {
          return new Response("relay-specific missing resource", { status: 404 });
        }
        return new Response(expectedMetaBody, {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const body = (await exchanged.json()) as { session: string };
    const sessionHeaders = {
      cookie: cookiePair(exchanged),
      "x-dohc-link-session": body.session,
    };

    const missing = await handler(
      request(`/api/view/blob/${missingSha}`, { headers: sessionHeaders }),
    );
    expect({ status: missing.status, body: await missing.text() }).toEqual({
      status: 404,
      body: shareWebRefusalBody,
    });

    const followUp = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );
    expect({ status: followUp.status, body: await followUp.text() }).toEqual({
      status: 200,
      body: expectedMetaBody,
    });
    expect(relayReads).toEqual([`/sync/link/blobs/${missingSha}`, "/sync/link/share"]);
  });

  it("deletes the session after a relay 401 capability refusal", async () => {
    let relayReads = 0;
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      publicHosts: new Set([HOST]),
      nowMs: () => 1_000,
      newSessionToken: () => Buffer.alloc(32, 25).toString("base64url"),
      fetchRelay: async (relayRequest) => {
        if (new URL(relayRequest.url).pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-invalid-capability",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        relayReads += 1;
        if (relayReads === 1) {
          return new Response("relay-specific capability refusal", { status: 401 });
        }
        return Response.json({ ok: true, access: "view" });
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const body = (await exchanged.json()) as { session: string };
    const sessionHeaders = {
      cookie: cookiePair(exchanged),
      "x-dohc-link-session": body.session,
    };

    const unauthorized = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );
    expect({ status: unauthorized.status, body: await unauthorized.text() }).toEqual({
      status: 404,
      body: shareWebRefusalBody,
    });

    const followUp = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );
    expect({ status: followUp.status, body: await followUp.text() }).toEqual({
      status: 404,
      body: shareWebRefusalBody,
    });
    expect(relayReads).toBe(1);
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
    expect(relayCalls).toBe(13);
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
