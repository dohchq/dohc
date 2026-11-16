import { describe, expect, it, vi } from "vitest";
import {
  accountDeletionKey,
  ACCOUNT_DELETION_KEY_HEADER,
  ACCOUNT_DELETION_PATH,
} from "@dohc/security-contract/account-deletion";
import {
  createShareWebApplication,
  LINK_SESSION_RENEWAL_GRACE_MS,
  type CreateShareWebApplicationOptions,
} from "./server";

const host = "share.example.test";
const capability = Buffer.alloc(32, 1).toString("base64url");
const renewed = Buffer.alloc(32, 2).toString("base64url");
const profile = Buffer.alloc(32, 3).toString("base64url");
const secret = Buffer.alloc(32, 4).toString("base64url");

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://${host}${path}`, {
    ...init,
    headers: { host, ...Object.fromEntries(new Headers(init.headers)) },
  });
}

function fixture(options: Partial<CreateShareWebApplicationOptions> = {}) {
  let now = 1_000;
  const fetchRelay = vi.fn(async (req: Request) => {
    const path = new URL(req.url).pathname;
    return path === "/sync/link-exchange" || path === "/sync/link-refresh"
      ? Response.json({
          ok: true,
          grantId: "grant-alpha",
          capabilityToken: path === "/sync/link-refresh" ? renewed : capability,
          capabilityExpiresAtMs: now + 900_000,
        })
      : Response.json({ ok: true });
  });
  const application = createShareWebApplication({
    relayUrl: "http://relay.test",
    publicRelayUrl: "https://relay.test",
    publicHosts: new Set([host]),
    newProfileSecret: () => profile,
    nowMs: () => now,
    fetchRelay,
    ...options,
  });
  return {
    application,
    fetchRelay,
    setNow: (value: number) => {
      now = value;
    },
    async exchange() {
      const response = await application.handle(
        request("/api/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret }),
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { session: string };
      expect(body).toEqual({ ok: true, session: expect.any(String) });
      const { session } = body;
      expect(response.headers.get("set-cookie")).not.toContain("grant-alpha");
      const pairs = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]!);
      return { session, cookie: pairs.join("; "), pairs };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const signal = () => new AbortController().signal;

describe("link browser credential material", () => {
  it("uses the HTTP exchange session and returns owned scalar material", async () => {
    const f = fixture();
    const { session, cookie } = await f.exchange();
    const resolve = () => f.application.resolveLinkBrowserMaterial(session, cookie, signal());
    const material = await resolve();
    expect(material).toEqual({
      ok: true,
      grantId: "grant-alpha",
      capabilityToken: capability,
      profileSecret: profile,
      setCookie: null,
      currentCapability: expect.any(Function),
    });
    if (!material.ok) throw new Error("missing material");
    material.grantId = "changed";
    material.capabilityToken = "changed";
    material.profileSecret = "changed";
    expect(await resolve()).toEqual({
      ok: true,
      grantId: "grant-alpha",
      capabilityToken: capability,
      profileSecret: profile,
      setCookie: null,
      currentCapability: expect.any(Function),
    });
    expect(f.fetchRelay).toHaveBeenCalledTimes(1);
  });

  it("isolates application instances and discriminators", async () => {
    const f = fixture();
    const other = fixture();
    const { session, cookie } = await f.exchange();
    expect(await other.application.resolveLinkBrowserMaterial(session, cookie, signal())).toEqual({
      ok: false,
      status: 404,
    });
    expect(
      await f.application.resolveLinkBrowserMaterial("abcdefghijkl", cookie, signal()),
    ).toEqual({ ok: false, status: 404 });
  });

  it.each([null, "", "bad", "abcdefghijkl="])(
    "refuses missing browser credentials: %s",
    async (cookie) => {
      const f = fixture();
      const { session } = await f.exchange();
      expect(await f.application.resolveLinkBrowserMaterial(session, cookie, signal())).toEqual({
        ok: false,
        status: 404,
      });
      expect(f.fetchRelay).toHaveBeenCalledTimes(1);
    },
  );

  it("requires the existing profile and rejects invalid discriminators without refresh", async () => {
    const f = fixture();
    const { session, pairs, cookie } = await f.exchange();
    f.setNow(901_001);
    for (const value of [pairs[0]!, `${pairs[0]}; dohc_share_profile_${session}=invalid`]) {
      expect(await f.application.resolveLinkBrowserMaterial(session, value, signal())).toEqual({
        ok: false,
        status: 404,
      });
    }
    for (const value of ["", `${session} `, `../${session}`]) {
      expect(await f.application.resolveLinkBrowserMaterial(value, cookie, signal())).toEqual({
        ok: false,
        status: 404,
      });
    }
    expect(f.fetchRelay).toHaveBeenCalledTimes(1);
  });

  it("shares refresh with HTTP and preserves the renewal cookie", async () => {
    const f = fixture();
    const { session, cookie } = await f.exchange();
    const started = deferred<Request>();
    const response = deferred<Response>();
    const defaultFetch = f.fetchRelay.getMockImplementation()!;
    f.fetchRelay.mockImplementation(async (req) => {
      if (new URL(req.url).pathname !== "/sync/link-refresh") return defaultFetch(req);
      started.resolve(req);
      return response.promise;
    });
    f.setNow(901_001);
    const material = f.application.resolveLinkBrowserMaterial(session, cookie, signal());
    const refreshRequest = await started.promise;
    const http = f.application.handle(
      request("/api/view/meta", {
        headers: { cookie, "x-dohc-link-session": session },
      }),
    );
    response.resolve(
      Response.json({
        ok: true,
        grantId: "grant-alpha",
        capabilityToken: renewed,
        capabilityExpiresAtMs: 1_801_001,
      }),
    );
    const result = await material;
    expect(result).toMatchObject({ ok: true, capabilityToken: renewed, profileSecret: profile });
    if (!result.ok) throw new Error("missing material");
    const httpResponse = await http;
    expect(httpResponse.status).toBe(200);
    expect(result).toEqual({
      ok: true,
      grantId: "grant-alpha",
      capabilityToken: renewed,
      profileSecret: profile,
      setCookie: httpResponse.headers.get("set-cookie"),
      currentCapability: expect.any(Function),
    });
    expect(result.setCookie).toContain("Secure; HttpOnly; SameSite=Strict");
    expect(result.setCookie).toContain("Path=/; Max-Age=");
    expect(refreshRequest.headers.get("authorization")).toBe(`LinkCapability ${capability}`);
    expect(
      f.fetchRelay.mock.calls.filter(([req]) => new URL(req.url).pathname === "/sync/link-refresh"),
    ).toHaveLength(1);
  });

  it.each([404, 503])("preserves refresh refusal %i and session retention", async (status) => {
    const f = fixture();
    const { session, cookie } = await f.exchange();
    f.setNow(901_001);
    f.fetchRelay.mockResolvedValue(new Response(null, { status }));
    expect(await f.application.resolveLinkBrowserMaterial(session, cookie, signal())).toEqual({
      ok: false,
      status: status === 404 ? 404 : 503,
    });
    f.fetchRelay.mockResolvedValue(
      Response.json({
        ok: true,
        grantId: "grant-alpha",
        capabilityToken: renewed,
        capabilityExpiresAtMs: 1_801_001,
      }),
    );
    expect(await f.application.resolveLinkBrowserMaterial(session, cookie, signal())).toMatchObject(
      status === 404 ? { ok: false, status: 404 } : { ok: true, capabilityToken: renewed },
    );
  });

  it("keeps a still-valid capability when refresh is unavailable", async () => {
    const f = fixture();
    const { session, cookie } = await f.exchange();
    f.setNow(601_001);
    f.fetchRelay.mockResolvedValue(new Response(null, { status: 503 }));
    expect(await f.application.resolveLinkBrowserMaterial(session, cookie, signal())).toEqual({
      ok: true,
      grantId: "grant-alpha",
      capabilityToken: capability,
      profileSecret: profile,
      setCookie: null,
      currentCapability: expect.any(Function),
    });
  });

  it("refuses after the renewal grace period without contacting the relay", async () => {
    const f = fixture();
    const { session, cookie } = await f.exchange();
    f.setNow(901_001 + LINK_SESSION_RENEWAL_GRACE_MS);
    expect(await f.application.resolveLinkBrowserMaterial(session, cookie, signal())).toEqual({
      ok: false,
      status: 404,
    });
    expect(f.fetchRelay).toHaveBeenCalledTimes(1);
  });

  it("returns no material when cancellation races a successful refresh", async () => {
    const f = fixture();
    const { session, cookie } = await f.exchange();
    f.setNow(901_001);
    const controller = new AbortController();
    f.fetchRelay.mockImplementation(async () => {
      const body = new TextEncoder().encode(
        JSON.stringify({
          ok: true,
          grantId: "grant-alpha",
          capabilityToken: renewed,
          capabilityExpiresAtMs: 1_801_001,
        }),
      );
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(stream) {
              if (!sent) {
                sent = true;
                stream.enqueue(body);
              } else {
                controller.abort();
                stream.close();
              }
            },
          },
          { highWaterMark: 0 },
        ),
      );
    });
    await expect(
      f.application.resolveLinkBrowserMaterial(session, cookie, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.signal.aborted).toBe(true);
    expect(await f.application.resolveLinkBrowserMaterial(session, cookie, signal())).toMatchObject(
      { ok: true, capabilityToken: renewed },
    );
    expect(f.fetchRelay).toHaveBeenCalledTimes(2);
  });

  it("cancels one waiter without cancelling another waiter's shared refresh", async () => {
    const f = fixture();
    const { session, cookie } = await f.exchange();
    f.setNow(901_001);
    const started = deferred<Request>();
    const response = deferred<Response>();
    f.fetchRelay.mockImplementation(async (req) => {
      started.resolve(req);
      return response.promise;
    });
    const controller = new AbortController();
    const aborted = f.application.resolveLinkBrowserMaterial(session, cookie, controller.signal);
    const rejected = expect(aborted).rejects.toThrow("cancelled waiter");
    const refreshRequest = await started.promise;
    const active = f.application.resolveLinkBrowserMaterial(session, cookie, signal());
    controller.abort(new Error("cancelled waiter"));
    await rejected;
    expect(refreshRequest.signal.aborted).toBe(false);
    response.resolve(
      Response.json({
        ok: true,
        grantId: "grant-alpha",
        capabilityToken: renewed,
        capabilityExpiresAtMs: 1_801_001,
      }),
    );
    expect(await active).toMatchObject({ ok: true, capabilityToken: renewed });
    expect(f.fetchRelay).toHaveBeenCalledTimes(2);
  });

  it("does no work for an already aborted waiter", async () => {
    const f = fixture();
    const { session, cookie } = await f.exchange();
    f.setNow(901_001);
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.application.resolveLinkBrowserMaterial(session, cookie, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.fetchRelay).toHaveBeenCalledTimes(1);
  });

  it("refuses a session evicted while its refresh is pending", async () => {
    const f = fixture({ maxSessions: 1 });
    const first = await f.exchange();
    f.setNow(601_001);
    const started = deferred<void>();
    const response = deferred<Response>();
    const defaultFetch = f.fetchRelay.getMockImplementation()!;
    f.fetchRelay.mockImplementation(async (req) => {
      if (new URL(req.url).pathname !== "/sync/link-refresh") return defaultFetch(req);
      started.resolve();
      return response.promise;
    });
    const material = f.application.resolveLinkBrowserMaterial(
      first.session,
      first.cookie,
      signal(),
    );
    await started.promise;
    await f.exchange();
    response.resolve(
      Response.json({
        ok: true,
        grantId: "grant-alpha",
        capabilityToken: renewed,
        capabilityExpiresAtMs: 1_801_001,
      }),
    );
    expect(await material).toEqual({ ok: false, status: 404 });
  });
});

it("retains a server handle through refresh and refuses expired or evicted sessions", async () => {
  const f = fixture({ maxSessions: 1 }),
    { session, cookie } = await f.exchange();
  const first = await f.application.resolveLinkBrowserMaterial(session, cookie, signal());
  if (!first.ok) throw Error("missing session");
  expect(await first.currentCapability()).toBe(capability);
  f.setNow(601_000);
  await f.application.resolveLinkBrowserMaterial(session, cookie, signal());
  expect(await first.currentCapability()).toBe(renewed);
  await f.exchange();
  expect(await first.currentCapability()).toBeNull();
});

describe("a link session after share-web restarts", () => {
  const sessionSealKey = Buffer.alloc(32, 9).toString("base64url");
  // Each fixture is one share-web process with its own memory, so a second one is share-web after a restart.
  const started = (options: Partial<CreateShareWebApplicationOptions> = {}) =>
    fixture({ sessionSealKey, ...options });
  const material = (f: ReturnType<typeof fixture>, session: string, cookie: string) =>
    f.application.resolveLinkBrowserMaterial(session, cookie, signal());
  const meta = (f: ReturnType<typeof fixture>, session: string, cookie: string) =>
    f.application.handle(
      request("/api/view/meta", { headers: { cookie, "x-dohc-link-session": session } }),
    );
  const relayPaths = (f: ReturnType<typeof fixture>) =>
    f.fetchRelay.mock.calls.map(([sent]) => new URL(sent.url).pathname);
  const refusal = { ok: false, status: 404 };

  it("goes on in a share-web started with the same seal key, without a new exchange", async () => {
    const { session, cookie } = await started().exchange();
    const restarted = started();
    expect(await material(restarted, session, cookie)).toMatchObject({
      ok: true,
      grantId: "grant-alpha",
      capabilityToken: capability,
    });
    expect((await meta(restarted, session, cookie)).status).toBe(200);
    expect(relayPaths(restarted)).not.toContain("/sync/link-exchange");
  });

  it("carries the capability of its last renewal", async () => {
    const before = started();
    const { session, cookie, pairs } = await before.exchange();
    before.setNow(901_001);
    const renewal = await meta(before, session, cookie);
    const renewedCookie = `${renewal.headers.get("set-cookie")!.split(";", 1)[0]}; ${pairs[1]}`;
    expect(renewedCookie).not.toBe(cookie);
    const restarted = started();
    restarted.setNow(901_001);
    expect(await material(restarted, session, renewedCookie)).toMatchObject({
      ok: true,
      capabilityToken: renewed,
    });
  });

  it("gives a browser that missed a renewal's cookie the cookie again", async () => {
    const f = started();
    const { session, cookie } = await f.exchange();
    f.setNow(901_001);
    const renewal = (await meta(f, session, cookie)).headers.get("set-cookie");
    expect(renewal).toContain(".");
    // The browser never saw that answer, so it still sends the cookie from the exchange.
    expect((await meta(f, session, cookie)).headers.get("set-cookie")).toBe(renewal);
    const current = `${renewal!.split(";", 1)[0]}; ${cookie.split("; ")[1]}`;
    expect((await meta(f, session, current)).headers.get("set-cookie")).toBeNull();
  });

  // Each cookie is refused by the share-web that made it and by the one after a restart, with no question to the relay.
  it.each([
    [
      "changed",
      (cookie: string) =>
        cookie.replace(/\.([A-Za-z0-9_-])/u, (_, first) => `.${first === "A" ? "B" : "A"}`),
    ],
    ["cut short", (cookie: string) => cookie.replace(/[A-Za-z0-9_-]{4};/u, ";")],
    ["removed", (cookie: string) => cookie.replace(/\.[A-Za-z0-9_-]+/u, "")],
    [
      "moved to another session token",
      (cookie: string) => cookie.replace(/=[A-Za-z0-9_-]+\./u, `=${"t".repeat(43)}.`),
    ],
  ])("refuses a cookie with its seal %s", async (_name, change) => {
    const before = started();
    const { session, cookie } = await before.exchange();
    const changed = change(cookie);
    expect(changed).not.toBe(cookie);
    const restarted = started();
    for (const f of [before, restarted]) {
      f.fetchRelay.mockClear();
      expect(await material(f, session, changed)).toEqual(refusal);
      expect((await meta(f, session, changed)).status).toBe(404);
      expect(f.fetchRelay).not.toHaveBeenCalled();
    }
  });

  it("refuses a seal made with another seal key, or for another link", async () => {
    const { session, cookie } = await started().exchange();
    const otherKey = started({ sessionSealKey: Buffer.alloc(32, 8).toString("base64url") });
    expect(await material(otherKey, session, cookie)).toEqual(refusal);
    const otherLink = "abcdefghijkl";
    const moved = cookie.replaceAll(session, otherLink);
    expect(await material(started(), otherLink, moved)).toEqual(refusal);
  });

  it("refuses a seal once its renewal time has passed", async () => {
    const { session, cookie } = await started().exchange();
    const restarted = started();
    restarted.setNow(1_000 + 900_000 + LINK_SESSION_RENEWAL_GRACE_MS + 1);
    expect(await material(restarted, session, cookie)).toEqual(refusal);
  });

  it("stays ended when the relay ends it after the restart, with one question to the relay", async () => {
    const { session, cookie } = await started().exchange();
    // The owner reset the link while share-web was down. The capability is not yet due for renewal.
    const restarted = started();
    restarted.fetchRelay.mockResolvedValue(new Response(null, { status: 404 }));
    for (let asked = 0; asked < 3; asked++)
      expect((await meta(restarted, session, cookie)).status).toBe(404);
    expect(relayPaths(restarted)).toEqual(["/sync/link/share"]);
  });

  it("stays out once the restarted share-web put it out for another session", async () => {
    const { session, cookie } = await started().exchange();
    // Room for two, so the third session puts the first out while one more could still be taken up.
    const restarted = started({ maxSessions: 2 });
    expect(await material(restarted, session, cookie)).toMatchObject({ ok: true });
    await restarted.exchange();
    await restarted.exchange();
    expect(await material(restarted, session, cookie)).toEqual(refusal);
  });

  it("stays out once the restarted share-web deleted its account's links", async () => {
    const { session, cookie } = await started().exchange();
    const relayExchangeKey = Buffer.alloc(32, 7).toString("base64url");
    const restarted = started({ relayExchangeKey, internalHosts: new Set(["share-web:1790"]) });
    expect(await material(restarted, session, cookie)).toMatchObject({ ok: true });
    const deleted = await restarted.application.handle(
      new Request(`http://share-web:1790${ACCOUNT_DELETION_PATH}`, {
        method: "POST",
        headers: {
          host: "share-web:1790",
          "content-type": "application/json",
          [ACCOUNT_DELETION_KEY_HEADER]: accountDeletionKey(relayExchangeKey),
        },
        body: JSON.stringify({
          userId: "deleted",
          workspaceIds: [],
          grantIds: ["grant-alpha"],
          publicationIds: [],
        }),
      }),
    );
    expect(deleted.status).toBe(200);
    expect(await material(restarted, session, cookie)).toEqual(refusal);
  });

  it("stays ended for a later seal of the same session, after the earlier seal's time has passed", async () => {
    const before = started();
    const { session, cookie, pairs } = await before.exchange();
    before.setNow(901_001);
    const renewal = await meta(before, session, cookie);
    const laterCookie = `${renewal.headers.get("set-cookie")!.split(";", 1)[0]}; ${pairs[1]}`;
    const other = await before.exchange();

    const restarted = started();
    restarted.setNow(901_001);
    restarted.fetchRelay.mockResolvedValueOnce(new Response(null, { status: 404 }));
    // The earlier seal is taken up, and the relay ends the session at its renewal.
    expect(await material(restarted, session, cookie)).toEqual(refusal);
    expect(await material(restarted, session, laterCookie)).toEqual(refusal);
    // The earlier seal can no longer be renewed. The later one still could be, and another session is taken up.
    restarted.setNow(901_000 + LINK_SESSION_RENEWAL_GRACE_MS + 1);
    expect(await material(restarted, other.session, other.cookie)).toMatchObject({ ok: true });
    expect(await material(restarted, session, laterCookie)).toEqual(refusal);
  });

  it("takes up no more sessions than it may hold", async () => {
    const before = started();
    const first = await before.exchange();
    const second = await before.exchange();
    const restarted = started({ maxSessions: 1 });
    expect(await material(restarted, first.session, first.cookie)).toMatchObject({ ok: true });
    expect(await material(restarted, second.session, second.cookie)).toEqual(refusal);
  });
});

describe("a link session the share-web that made it no longer holds", () => {
  const sessionSealKey = Buffer.alloc(32, 9).toString("base64url");

  it("stays ended when the relay ended it, without another question to the relay", async () => {
    const f = fixture({ sessionSealKey });
    const { session, cookie } = await f.exchange();
    f.setNow(901_001);
    f.fetchRelay.mockResolvedValue(new Response(null, { status: 404 }));
    for (let asked = 0; asked < 2; asked++)
      expect(await f.application.resolveLinkBrowserMaterial(session, cookie, signal())).toEqual({
        ok: false,
        status: 404,
      });
    expect(
      f.fetchRelay.mock.calls.filter(
        ([sent]) => new URL(sent.url).pathname === "/sync/link-refresh",
      ),
    ).toHaveLength(1);
  });

  it("is not brought back by its cookie after another session took its place", async () => {
    const f = fixture({ sessionSealKey, maxSessions: 1 });
    const first = await f.exchange();
    await f.exchange();
    expect(
      await f.application.resolveLinkBrowserMaterial(first.session, first.cookie, signal()),
    ).toEqual({ ok: false, status: 404 });
  });
});

it("treats the whole cookie as the session token when share-web has no seal key", async () => {
  // The relay's secret alone seals nothing.
  const f = fixture({ relayExchangeKey: Buffer.alloc(32, 7).toString("base64url") });
  const { session, cookie } = await f.exchange();
  expect(cookie.split("; ")[0]).not.toContain(".");
  const dotted = cookie.replace(";", ".seal;");
  expect(await f.application.resolveLinkBrowserMaterial(session, dotted, signal())).toEqual({
    ok: false,
    status: 404,
  });
});
