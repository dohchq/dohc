import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadShareWebConfig } from "./config";
import {
  createShareWebHandler as createRawShareWebHandler,
  type CreateShareWebHandlerOptions,
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
  options: Omit<CreateShareWebHandlerOptions, "publicRelayUrl"> & {
    publicRelayUrl?: string;
  },
): ReturnType<typeof createRawShareWebHandler> {
  return createRawShareWebHandler({ publicRelayUrl: PUBLIC_RELAY_URL, ...options });
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

  it("returns a generic 503 for relay transport and received 5xx failures while a received 404 stays 404", async () => {
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
        if (readCalls === 2) {
          return new Response("relay-specific missing resource", { status: 404 });
        }
        return new Response("relay-specific upstream failure", { status: 502 });
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

    const receivedUpstreamFailure = await handler(
      request("/api/view/meta", { headers: sessionHeaders }),
    );
    expect({
      status: receivedUpstreamFailure.status,
      body: await receivedUpstreamFailure.text(),
    }).toEqual({
      status: 503,
      body: shareWebRefusalBody,
    });
    expectSecurityHeaders(receivedUpstreamFailure);
    expect(readCalls).toBe(3);
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

describe("share-web protected discussion proxy", () => {
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

  it("keeps the profile server-only and sends it only on trusted appends", async () => {
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
    expect(discussionRequests[0]!.headers.get("x-dohc-link-profile-secret")).toBeNull();
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

  it("shares one forced refresh across concurrent discussion appends", async () => {
    let now = 1_000;
    let refreshCalls = 0;
    const discussionCapabilities: string[] = [];
    const discussionProfiles: string[] = [];
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const handler = createShareWebHandler({
      relayUrl: "http://relay.test",
      relayExchangeKey: "discussion-relay-key",
      publicHosts: new Set([HOST]),
      nowMs: () => now,
      newSessionToken: () => Buffer.alloc(32, 52).toString("base64url"),
      newProfileSecret: () => PROFILE_ALPHA,
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        if (pathname === "/sync/link-exchange") {
          return Response.json({
            ok: true,
            grantId: "grant-refresh",
            capabilityToken: CAP_ALPHA_1,
            capabilityExpiresAtMs: 901_000,
          });
        }
        if (pathname === "/sync/link-refresh") {
          refreshCalls += 1;
          await refreshGate;
          return Response.json({
            ok: true,
            grantId: "grant-refresh",
            capabilityToken: CAP_ALPHA_2,
            capabilityExpiresAtMs: now + 900_000,
          });
        }
        discussionCapabilities.push(relayRequest.headers.get("authorization") ?? "");
        discussionProfiles.push(
          relayRequest.headers.get("x-dohc-link-profile-secret") ?? "",
        );
        return Response.json(publicMessage("refreshed"));
      },
    });
    const exchanged = await handler(request("/api/exchange", exchange(SECRET_ALPHA)));
    const { session } = (await exchanged.clone().json()) as { session: string };
    const cookies = cookieHeader(cookiePair(exchanged), profileCookiePair(exchanged));
    const append = (idempotencyKey: string) =>
      handler(
        request("/api/view/discussion", {
          method: "POST",
          headers: {
            ...sessionHeaders(session, cookies),
            "content-type": "application/json",
          },
          body: JSON.stringify({ body: "refreshed", idempotencyKey }),
        }),
      );
    now = 601_001;

    const first = append("concurrent-one");
    const second = append("concurrent-two");
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    releaseRefresh?.();
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(discussionCapabilities).toEqual([
      `LinkCapability ${CAP_ALPHA_2}`,
      `LinkCapability ${CAP_ALPHA_2}`,
    ]);
    expect(discussionProfiles).toEqual([PROFILE_ALPHA, PROFILE_ALPHA]);
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
            error: `blocked ${principal} ${PROFILE_ALPHA}`,
          },
          { status: 403 },
        ),
      () =>
        Response.json(
          {
            ok: false,
            code: "link_discussion_paused",
            error: `paused ${grant} ${CAP_ALPHA_1}`,
          },
          { status: 403 },
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
      body: { ok: false, state: "blocked" },
    });
    expect({ status: responses[1]!.status, body: await responses[1]!.json() }).toEqual({
      status: 403,
      body: { ok: false, state: "paused" },
    });
    const genericStatuses = [404, 404, 404, 429, 404, 503];
    for (const [index, status] of genericStatuses.entries()) {
      const response = responses[index + 2]!;
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
});

describe("share-web handoff adapter", () => {
  async function exchangedSession(options: {
    fetchRelay: (request: Request) => Promise<Response>;
    nowMs?: () => number;
    capabilityExpiresAtMs?: number;
    sessionTokenByte?: number;
    handoffRelayTimeoutMs?: number;
    publicRelayUrl?: string;
  }): Promise<{
    handler: ReturnType<typeof createShareWebHandler>;
    discriminator: string;
    cookie: string;
  }> {
    const capabilityExpiresAtMs = options.capabilityExpiresAtMs ?? 901_000;
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
            capabilityExpiresAtMs,
          });
        }
        return await options.fetchRelay(relayRequest);
      },
      nowMs: options.nowMs ?? (() => 1_000),
      newSessionToken: () =>
        Buffer.alloc(32, options.sessionTokenByte ?? 41).toString("base64url"),
      handoffRelayTimeoutMs: options.handoffRelayTimeoutMs,
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

  it("aborts a handoff mint when the browser request closes without exposing relay secrets", async () => {
    const relayUrl = `https://${HOST}/s#${SECRET_ALPHA}`;
    let startedRelayRequest: Request | undefined;
    let markRelayStarted: (() => void) | undefined;
    const relayStarted = new Promise<void>((resolve) => {
      markRelayStarted = resolve;
    });
    const state = await exchangedSession({
      fetchRelay: async (relayRequest) => {
        startedRelayRequest = relayRequest;
        markRelayStarted?.();
        return await new Promise<Response>((_resolve, reject) => {
          const rejectWithSecrets = (): void => {
            reject(
              new Error(
                `aborted ${HANDOFF_CODE} ${CAP_ALPHA_2} ${relayUrl}`,
              ),
            );
          };
          if (relayRequest.signal.aborted) {
            rejectWithSecrets();
          } else {
            relayRequest.signal.addEventListener("abort", rejectWithSecrets, {
              once: true,
            });
          }
        });
      },
    });
    const browserAbort = new AbortController();
    const pendingResponse = state.handler(
      request("/api/handoff", {
        method: "POST",
        headers: handoffHeaders(state.discriminator, state.cookie),
        signal: browserAbort.signal,
      }),
    );
    await relayStarted;

    browserAbort.abort();

    expect(startedRelayRequest?.signal.aborted).toBe(true);
    const response = await pendingResponse;
    const body = await response.clone().text();
    expect(body).not.toContain(HANDOFF_CODE);
    expect(body).not.toContain(CAP_ALPHA_2);
    expect(body).not.toContain(SECRET_ALPHA);
    expect(body).not.toContain(relayUrl);
    await generic(response, 503);
  });

  it("times out a stalled handoff mint generically and leaves the session retryable", async () => {
    vi.useFakeTimers();
    try {
      const relayUrl = `https://${HOST}/s#${SECRET_ALPHA}`;
      let mintCalls = 0;
      let startedRelayRequest: Request | undefined;
      let markRelayStarted: (() => void) | undefined;
      const relayStarted = new Promise<void>((resolve) => {
        markRelayStarted = resolve;
      });
      const state = await exchangedSession({
        handoffRelayTimeoutMs: 25,
        fetchRelay: async (relayRequest) => {
          mintCalls += 1;
          if (mintCalls > 1) {
            return Response.json({
              ok: true,
              code: HANDOFF_CODE,
              expiresAtMs: 301_000,
            });
          }
          startedRelayRequest = relayRequest;
          markRelayStarted?.();
          return await new Promise<Response>((_resolve, reject) => {
            const rejectWithSecrets = (): void => {
              reject(
                new Error(
                  `timed out ${HANDOFF_CODE} ${CAP_ALPHA_2} ${relayUrl}`,
                ),
              );
            };
            if (relayRequest.signal.aborted) {
              rejectWithSecrets();
            } else {
              relayRequest.signal.addEventListener("abort", rejectWithSecrets, {
                once: true,
              });
            }
          });
        },
      });
      const headers = handoffHeaders(state.discriminator, state.cookie);
      const pendingResponse = state.handler(
        request("/api/handoff", { method: "POST", headers }),
      );
      await relayStarted;

      await vi.advanceTimersByTimeAsync(25);

      expect(startedRelayRequest?.signal.aborted).toBe(true);
      const response = await pendingResponse;
      const body = await response.clone().text();
      expect(body).not.toContain(HANDOFF_CODE);
      expect(body).not.toContain(CAP_ALPHA_2);
      expect(body).not.toContain(SECRET_ALPHA);
      expect(body).not.toContain(relayUrl);
      await generic(response, 503);

      const retry = await state.handler(
        request("/api/handoff", { method: "POST", headers }),
      );
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({
        ok: true,
        code: HANDOFF_CODE,
        relayUrl: PUBLIC_RELAY_URL,
        expiresAtMs: 301_000,
      });
      expect(mintCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it("refreshes first, mints with the installed capability, and renews the cookie", async () => {
    let now = 1_000;
    const relayPaths: string[] = [];
    const mintAuthorizations: string[] = [];
    const state = await exchangedSession({
      nowMs: () => now,
      capabilityExpiresAtMs: 601_001,
      sessionTokenByte: 42,
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        relayPaths.push(pathname);
        if (pathname === "/sync/link-refresh") {
          expect(relayRequest.headers.get("authorization")).toBe(
            `LinkCapability ${CAP_ALPHA_1}`,
          );
          expect(relayRequest.headers.get("x-dohc-relay-exchange-key")).toBe(
            HANDOFF_EXCHANGE_KEY,
          );
          return Response.json({
            ok: true,
            grantId: "grant-handoff",
            capabilityToken: CAP_ALPHA_2,
            capabilityExpiresAtMs: now + 900_000,
          });
        }
        mintAuthorizations.push(relayRequest.headers.get("authorization") ?? "");
        expect(await relayRequest.text()).toBe("");
        return Response.json({ ok: true, code: HANDOFF_CODE, expiresAtMs: now + 300_000 });
      },
    });
    now = 301_002;

    const response = await state.handler(
      request("/api/handoff", {
        method: "POST",
        headers: handoffHeaders(state.discriminator, state.cookie),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      code: HANDOFF_CODE,
      relayUrl: PUBLIC_RELAY_URL,
      expiresAtMs: now + 300_000,
    });
    expect(relayPaths).toEqual(["/sync/link-refresh", "/sync/link-handoff"]);
    expect(mintAuthorizations).toEqual([`LinkCapability ${CAP_ALPHA_2}`]);
    expect(response.headers.get("set-cookie")).toContain(state.cookie);
  });

  it("shares one serialized refresh across concurrent handoff mints", async () => {
    let now = 1_000;
    let refreshCalls = 0;
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const mintAuthorizations: string[] = [];
    const state = await exchangedSession({
      nowMs: () => now,
      capabilityExpiresAtMs: 601_001,
      sessionTokenByte: 43,
      fetchRelay: async (relayRequest) => {
        const pathname = new URL(relayRequest.url).pathname;
        if (pathname === "/sync/link-refresh") {
          refreshCalls += 1;
          await refreshGate;
          return Response.json({
            ok: true,
            grantId: "grant-handoff",
            capabilityToken: CAP_ALPHA_2,
            capabilityExpiresAtMs: now + 900_000,
          });
        }
        mintAuthorizations.push(relayRequest.headers.get("authorization") ?? "");
        return Response.json({ ok: true, code: HANDOFF_CODE, expiresAtMs: now + 300_000 });
      },
    });
    now = 301_002;
    const headers = handoffHeaders(state.discriminator, state.cookie);

    const first = state.handler(request("/api/handoff", { method: "POST", headers }));
    const second = state.handler(request("/api/handoff", { method: "POST", headers }));
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    releaseRefresh?.();
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(mintAuthorizations).toEqual([
      `LinkCapability ${CAP_ALPHA_2}`,
      `LinkCapability ${CAP_ALPHA_2}`,
    ]);
    expect(mintAuthorizations).not.toContain(`LinkCapability ${CAP_ALPHA_1}`);
    expect(responses.every((response) => response.headers.has("set-cookie"))).toBe(true);
  });

  it("maps handoff refusal and rate limit generically, and malformed or unavailable relay responses to 503", async () => {
    const upstreamBody = JSON.stringify({
      code: HANDOFF_CODE,
      capabilityToken: CAP_ALPHA_2,
      url: `https://${HOST}/s#${SECRET_ALPHA}`,
    });
    const attempts: Array<() => Promise<Response>> = [
      async () => new Response(upstreamBody, { status: 404 }),
      async () => new Response(upstreamBody, { status: 429 }),
      async () => new Response(upstreamBody, { status: 502 }),
      async () => new Response(null, { status: 204 }),
      async () => new Response("not-json", { status: 200 }),
      async () => Response.json({ ok: false, code: HANDOFF_CODE, expiresAtMs: 301_000 }),
      async () => Response.json({ ok: true, code: "short", expiresAtMs: 301_000 }),
      async () => Response.json({ ok: true, code: HANDOFF_CODE, expiresAtMs: 1_000 }),
      async () => Response.json({ ok: true, code: HANDOFF_CODE, expiresAtMs: 301_000.5 }),
      async () =>
        Response.json({
          ok: true,
          code: HANDOFF_CODE,
          expiresAtMs: Number.MAX_SAFE_INTEGER + 1,
        }),
      async () => {
        throw new Error(`relay unavailable ${SECRET_ALPHA}`);
      },
      async () => new Response(upstreamBody, { status: 401 }),
    ];
    let attempt = 0;
    const state = await exchangedSession({
      fetchRelay: async () => await attempts[attempt++]!(),
    });
    const headers = handoffHeaders(state.discriminator, state.cookie);
    const responses: Response[] = [];
    for (let index = 0; index < attempts.length; index += 1) {
      responses.push(
        await state.handler(request("/api/handoff", { method: "POST", headers })),
      );
    }

    for (const response of responses) {
      const text = await response.clone().text();
      expect(text).not.toContain(HANDOFF_CODE);
      expect(text).not.toContain(CAP_ALPHA_2);
      expect(text).not.toContain(SECRET_ALPHA);
    }
    await generic(responses[0]!, 404);
    await generic(responses[1]!, 429);
    for (const unavailable of responses.slice(2, -1)) await generic(unavailable, 503);
    await generic(responses.at(-1)!, 404);
  });
});
