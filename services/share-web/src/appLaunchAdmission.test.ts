import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createAppLaunchHandler } from "./appLaunch";

const config = { viewerOrigin: "https://viewer.example.com", appDomain: "example.net" };
const publicationId = "a".repeat(64);
function fixture() {
  let probes = 0,
    relayStatus = 200,
    relayEvents = (_request: Request): Promise<Response> =>
      Promise.resolve(Response.json({ dataset: "", revision: 0 }));
  const bytes = Buffer.from("console.log('loaded')");
  const file = {
    path: "bundle.js",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    contentType: "text/javascript; charset=utf-8",
  };
  const handler = createAppLaunchHandler({
    config,
    relayUrl: "https://relay.example.org",
    nowMs: () => 1_000_000,
    resolveMaterial: async (_discriminator, cookie) => {
      probes++;
      if (!cookie?.startsWith("viewer=profile-")) return { ok: false, status: 404 };
      return {
        ok: true,
        capabilityToken: "capability",
        profileSecret: `private:${cookie}`,
        setCookie: null,
        currentCapability: async () => "capability",
      };
    },
    resolveNamedMaterial: async (_workspace, _publication, cookie) => ({
      ok: true,
      kind: "named",
      admissionKey: createHash("sha256")
        .update(cookie ?? "")
        .digest("hex"),
      setCookie: null,
      fetchRelay: async () =>
        cookie === "account=owner"
          ? Response.json({ publicationId, authorityRevision: 1, files: [file] })
          : new Response(null, { status: 403 }),
    }),
    fetchRelay: async (request) =>
      relayStatus !== 200
        ? new Response(null, { status: relayStatus })
        : new URL(request.url).pathname.endsWith("/backend/events")
          ? relayEvents(request)
          : new URL(request.url).pathname.includes("/blobs/")
            ? new Response(bytes, { headers: { "content-type": file.contentType } })
            : Response.json({ publicationId, authorityRevision: 1, files: [file] }),
  });
  const issue = (
    profile: string,
    address = "event-wifi",
    extra: Record<string, string> = {},
    body: unknown = { discriminator: "abcdefghijkl", publicationId },
  ) =>
    handler.handle(
      new Request(config.viewerOrigin + "/api/apps/launch", {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          host: "viewer.example.com",
          origin: config.viewerOrigin,
          "content-type": "application/json",
          cookie: `viewer=${profile}`,
          "x-dohc-share-web-client-ip": address,
          ...extra,
        },
      }),
    );
  return {
    handler,
    issue,
    probes: () => probes,
    relayStatus(status: number) {
      relayStatus = status;
    },
    relayEvents(answer: (request: Request) => Promise<Response>) {
      relayEvents = answer;
    },
    async open(profile: string) {
      const handoff = await (await issue(profile)).json();
      const origin = new URL(handoff.action).origin;
      const bootstrap = await handler.handle(
        new Request(handoff.action, {
          method: "POST",
          body: new URLSearchParams({ handoff: handoff.handoff }).toString(),
          headers: {
            host: new URL(origin).host,
            origin: config.viewerOrigin,
            "content-type": "application/x-www-form-urlencoded",
          },
        }),
      );
      const proof = /const proof="([A-Za-z0-9_-]{43})"/.exec(await bootstrap.text())![1]!;
      const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
      return (path: string, body?: unknown) =>
        handler.handle(
          new Request(origin + path, {
            method: "POST",
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            headers: {
              host: new URL(origin).host,
              origin,
              cookie,
              "x-dohc-app-proof": proof,
              "content-type": "application/json",
            },
          }),
        );
    },
  };
}

it("preserves relay admission while keeping unverified link launches opaque", async () => {
  const f = fixture();
  f.relayStatus(429);
  expect((await f.issue("profile-good")).status).toBe(429);
  f.relayStatus(503);
  const unavailable = await f.issue("profile-good");
  expect(unavailable.status).toBe(404);
  expect(await unavailable.json()).toEqual({ ok: false, error: "not found" });
  f.relayStatus(200);
  expect((await f.issue("profile-good")).status).toBe(200);
});

it("issues 100 distinct browser launches on one network without waiting for token refills", async () => {
  const f = fixture();
  for (let profile = 0; profile < 100; profile++)
    expect((await f.issue(`profile-${profile}`)).status).toBe(200);
  expect(f.probes()).toBe(100);
});

it("limits the resolved profile independently of supplied headers, discriminator, and network", async () => {
  const f = fixture();
  for (let launch = 0; launch < 12; launch++)
    expect((await f.issue("profile-repeat")).status).toBe(200);
  expect(
    (
      await f.issue(
        "profile-repeat",
        "other-network",
        { "x-dohc-link-profile-secret": "invented-profile" },
        { discriminator: "mnopqrstuvwx", publicationId },
      )
    ).status,
  ).toBe(429);
  expect((await f.issue("profile-other")).status).toBe(200);
  expect(
    (
      await f.issue(
        "unused",
        "event-wifi",
        { cookie: "account=owner" },
        { workspaceId: "workspace", publicationId },
      )
    ).status,
  ).toBe(200);
});

it("limits authenticated named sessions without granting authority to a supplied cookie", async () => {
  const f = fixture();
  const named = (cookie: string) =>
    f.issue("unused", "event-wifi", { cookie }, { workspaceId: "workspace", publicationId });
  for (let launch = 0; launch < 12; launch++)
    expect((await named("account=owner")).status).toBe(200);
  expect((await named("account=owner")).status).toBe(429);
  expect((await named("account=forged")).status).toBe(404);
  expect((await f.issue("profile-other")).status).toBe(200);
});

it("bounds one address before global admission and preserves another address", async () => {
  const f = fixture();
  for (let probe = 0; probe < 2500; probe++)
    expect((await f.issue("invalid")).status).toBe(probe < 600 ? 404 : 429);
  expect(f.probes()).toBe(600);
  expect((await f.issue("profile-good", "other-network")).status).toBe(200);
});

it("reserves issue capacity for other addresses and document builds, and releases aborted bodies", async () => {
  const f = fixture(),
    issued = await f.issue("profile-open"),
    handoff = await issued.json();
  const controllers = Array.from({ length: 16 }, () => new AbortController());
  const stalled = controllers.map((controller) =>
    f.handler.handle(
      new Request(config.viewerOrigin + "/api/apps/launch", {
        method: "POST",
        body: new ReadableStream(),
        duplex: "half",
        signal: controller.signal,
        headers: {
          host: "viewer.example.com",
          origin: config.viewerOrigin,
          "content-type": "application/json",
          "x-dohc-share-web-client-ip": "event-wifi",
        },
      } as RequestInit),
    ),
  );
  expect((await f.issue("profile-blocked")).status).toBe(429);
  expect((await f.issue("profile-good", "other-network")).status).toBe(200);
  expect(
    (
      await f.handler.handle(
        new Request(handoff.action, {
          method: "POST",
          body: new URLSearchParams({ handoff: handoff.handoff }).toString(),
          headers: {
            host: new URL(handoff.action).host,
            origin: config.viewerOrigin,
            "content-type": "application/x-www-form-urlencoded",
          },
        }),
      )
    ).status,
  ).toBe(200);
  for (const controller of controllers) controller.abort();
  expect((await Promise.all(stalled)).every((response) => response.status === 404)).toBe(true);
  expect((await f.issue("profile-recovered")).status).toBe(200);
});

it("holds one change wait per launch, outside the document lane and the session's request budget", async () => {
  const f = fixture();
  const call = await f.open("profile-live");
  const relayed: Request[] = [];
  let release = (_answer: Response) => {};
  f.relayEvents((request) => {
    relayed.push(request);
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const held = call("/events", { since: 3 });
  await expect.poll(() => relayed.length).toBe(1);
  const url = new URL(relayed[0]!.url);
  expect(relayed[0]!.method).toBe("GET");
  expect(relayed[0]!.headers.get("authorization")).toBe("LinkCapability capability");
  expect(url.pathname).toBe(`/sync/link/app-publications/${publicationId}/backend/events`);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    authorityRevision: "1",
    since: "3",
    hold: "25000",
  });
  expect((await call("/events", { since: 3 })).status).toBe(429);
  expect((await call("/status")).status).toBe(204);
  release(Response.json({ dataset: "votes", revision: 4 }));
  const answer = await held;
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ dataset: "votes", revision: 4 });
  f.relayEvents(async () => Response.json({ dataset: "", revision: 4 }));
  for (let wait = 0; wait < 20; wait++)
    expect((await call("/events", { since: 4 })).status).toBe(200);
  expect((await call("/status")).status).toBe(204);
  expect((await call("/events", { since: -1 })).status).toBe(404);
  expect((await call("/events", { since: 4, dataset: "votes" })).status).toBe(404);
  f.relayEvents(async () => Response.json({ dataset: "votes", revision: -1 }));
  expect((await call("/events", { since: 4 })).status).toBe(503);
  f.relayEvents(async () => Response.json(null, { status: 404 }));
  expect((await call("/events", { since: 4 })).status).toBe(404);
  f.relayEvents(() => Promise.reject(new Error("offline")));
  expect((await call("/events", { since: 4 })).status).toBe(503);
});
