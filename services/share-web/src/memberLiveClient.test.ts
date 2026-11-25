import { getCookies } from "better-auth/cookies";
import { expect, it, vi } from "vitest";
import { createMemberLiveClient } from "./memberLiveClient";

// A member's browser opens a page for editing through share-web: only the
// account cookie and the grant reach the relay, and a host's refusal keeps
// its code so the page can say why.

const origin = "https://share.example.test",
  exchangeKey = "member-live-exchange-key-at-least-32-chars";
const cookieName = getCookies({ baseURL: origin }).sessionToken.name;
const limits = {
  maxPendingRequests: 2,
  maxRequestBytes: 4096,
  maxResponseBytes: 16384,
  timeoutMs: 1000,
};
const editorLimits = { provider: { frames: {} } };
const admitted = {
  kind: "named",
  userId: "sam",
  workspaceId: "named:grant-1",
  shareId: "share-1",
  grantId: "grant-1",
  objectId: "object-1",
  path: "trip/plan.md",
  discriminator: "abcdefghijkl",
  expiresAtMs: Date.now() + 60_000,
  ticket: { token: "ab".repeat(32), expiresAtMs: Date.now() + 60_000 },
  editorLimits,
};

function client(answer: (request: Request) => Response) {
  const fetchRelay = vi.fn(async (request: Request) => answer(request));
  return {
    fetchRelay,
    handle: createMemberLiveClient({
      relayUrl: "https://relay.test",
      publicOrigin: origin,
      exchangeKey,
      limits,
      fetchRelay,
    }),
  };
}

function open(
  route: "open" | "ready" | "owner" = "open",
  headers: Record<string, string> = {},
  body: unknown = route === "owner"
    ? { workspaceId: "ws-1", path: "trip/plan.md" }
    : { grantId: "grant-1", path: "trip/plan.md" },
) {
  return new Request(`${origin}/api/live/${route === "owner" ? "owner-open" : `member-${route}`}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      host: "share.example.test",
      origin,
      "content-type": "application/json",
      cookie: `${cookieName}=sam; other=secret`,
      ...headers,
    },
  });
}

it("opens a page with the account cookie, and gives the browser only its session, ticket and document", async () => {
  const c = client(() => Response.json(admitted));
  const response = await c.handle(open());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    discriminator: "abcdefghijkl",
    objectId: "object-1",
    userId: "sam",
    token: "ab".repeat(32),
    limits: editorLimits,
  });
  const sent = c.fetchRelay.mock.calls[0]![0];
  expect(new URL(sent.url).pathname).toBe("/sync/live/member-open");
  expect(sent.headers.get("cookie")).toBe(`${cookieName}=sam`);
  expect(sent.headers.get("origin")).toBe(origin);
  expect(sent.headers.get("x-dohc-relay-exchange-key")).toBe(exchangeKey);
  expect(sent.headers.has("authorization")).toBe(false);
  expect(await sent.json()).toEqual({ grantId: "grant-1", path: "trip/plan.md" });
});

it.each([
  "live-document-without-lineage",
  "live_host_full",
  "live_paused_by_owner",
  "document-unavailable",
])("keeps the host's %s refusal", async (code) => {
  const c = client(() => Response.json({ ok: false, code }, { status: 409 }));
  const response = await c.handle(open());
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ ok: false, code });
});

it("answers a readiness wait with whether the host is ready", async () => {
  const ready = client(
    () => new Response("waiting\nready\n", { headers: { "content-type": "text/plain" } }),
  );
  expect(await (await ready.handle(open("ready"))).json()).toEqual({ ready: true });
  expect(new URL(ready.fetchRelay.mock.calls[0]![0].url).pathname).toBe("/sync/live/member-ready");
  const unavailable = client(
    () => new Response("waiting\nunavailable\n", { headers: { "content-type": "text/plain" } }),
  );
  expect(await (await unavailable.handle(open("ready"))).json()).toEqual({ ready: false });
});

it.each([
  ["a signed-out browser", { cookie: "other=secret" }, undefined],
  ["another site", { origin: "https://elsewhere.test" }, undefined],
  ["a cross-site request", { "sec-fetch-site": "cross-site" }, undefined],
  ["a share instead of a grant", {}, { shareId: "share-1", path: "trip/plan.md" }],
  ["a file that is not a page", {}, { grantId: "grant-1", path: "trip/photo.png" }],
] as const)("refuses %s before reaching the relay", async (_, headers, body) => {
  const c = client(() => Response.json(admitted));
  expect((await c.handle(open("open", headers, body))).status).toBe(404);
  expect(c.fetchRelay).not.toHaveBeenCalled();
});

it("refuses an answer for another page or a malformed refusal", async () => {
  expect(
    (await client(() => Response.json({ ...admitted, path: "other.md" })).handle(open())).status,
  ).toBe(404);
  expect(
    (
      await client(() => Response.json({ ok: false, code: "<script>" }, { status: 409 })).handle(
        open(),
      )
    ).status,
  ).toBe(404);
});

// A readiness wait holds its relay call until the host is ready, so waits
// take their own pool, a few per account, and never hold up an open.
it("waits for readiness in its own pool, a few per account, beside the opens", async () => {
  const held: Array<() => void> = [];
  const fetchRelay = vi.fn((request: Request) =>
    new URL(request.url).pathname === "/sync/live/member-ready"
      ? new Promise<Response>((resolve) => {
          held.push(() =>
            resolve(
              new Response("waiting\nready\n", { headers: { "content-type": "text/plain" } }),
            ),
          );
        })
      : Promise.resolve(Response.json(admitted)),
  );
  const handle = createMemberLiveClient({
    relayUrl: "https://relay.test",
    publicOrigin: origin,
    exchangeKey,
    limits,
    readiness: { maxPendingRequests: 3, maxPendingPerUser: 2 },
    fetchRelay,
  });
  const as = (user: string) => ({ cookie: `${cookieName}=${user}` });
  const waits = [handle(open("ready")), handle(open("ready"))];
  // Two waits fill this account's share, and the open pool still has room.
  expect((await handle(open("ready"))).status).toBe(404);
  expect((await handle(open())).status).toBe(200);
  expect((await handle(open())).status).toBe(200);
  waits.push(handle(open("ready", as("ana"))));
  // The waits' pool is full for every account.
  expect((await handle(open("ready", as("bo")))).status).toBe(404);
  await vi.waitFor(() => expect(held).toHaveLength(3));
  for (const release of held.splice(0)) release();
  for (const wait of waits) expect(await (await wait).json()).toEqual({ ready: true });
  // A finished wait gives its place back.
  const again = handle(open("ready"));
  await vi.waitFor(() => expect(held).toHaveLength(1));
  held[0]!();
  expect(await (await again).json()).toEqual({ ready: true });
  expect(
    fetchRelay.mock.calls.filter(
      ([request]) => new URL(request.url).pathname === "/sync/live/member-ready",
    ),
  ).toHaveLength(4);
});

// The workspace's owner opens a page as their phone does: the relay's page open answers with a ticket for the owner's socket.
const ownerReady = {
  ok: true,
  result: {
    status: "ready",
    objectId: "object-1",
    lineageClaimId: "c".repeat(64),
    ticket: "ab".repeat(32),
    expiresAtMs: Date.now() + 60_000,
    editorLimits,
  },
};

it("opens the owner's page through the relay's page open with only the cookie, origin and exchange key", async () => {
  const c = client(() => Response.json(ownerReady));
  const response = await c.handle(open("owner"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    objectId: "object-1",
    lineageClaimId: "c".repeat(64),
    token: "ab".repeat(32),
    limits: editorLimits,
  });
  const sent = c.fetchRelay.mock.calls[0]![0];
  expect(sent.method).toBe("POST");
  expect(new URL(sent.url).pathname).toBe("/sync/ws-1/ops/openPage");
  expect(sent.headers.get("cookie")).toBe(`${cookieName}=sam`);
  expect(sent.headers.get("origin")).toBe(origin);
  expect(sent.headers.get("x-dohc-relay-exchange-key")).toBe(exchangeKey);
  expect(sent.headers.has("authorization")).toBe(false);
  expect(await sent.json()).toEqual({ path: "trip/plan.md" });
  // The relay opens every page the viewer offers, a .markdown file's too.
  await c.handle(open("owner", {}, { workspaceId: "ws-1", path: "trip/plan.markdown" }));
  expect(await c.fetchRelay.mock.calls[1]![0].json()).toEqual({ path: "trip/plan.markdown" });
});

it("answers the owner's preparing page, and keeps the relay's refusal reason", async () => {
  const preparing = client(() => Response.json({ ok: true, result: { status: "preparing" } }));
  expect(await (await preparing.handle(open("owner"))).json()).toEqual({ preparing: true });
  for (const reason of ["live-document-without-lineage", "missing", "live_host_full", "paused"]) {
    const refused = client(() =>
      Response.json({ ok: true, result: { status: "refused", reason } }),
    );
    const response = await refused.handle(open("owner"));
    expect(response.status, reason).toBe(409);
    expect(await response.json()).toEqual({ ok: false, code: reason });
  }
});

it.each([
  ["a signed-out browser", { cookie: "other=secret" }, undefined],
  ["another site", { origin: "https://elsewhere.test" }, undefined],
  ["a cross-site request", { "sec-fetch-site": "cross-site" }, undefined],
  ["another host", { host: "elsewhere.test" }, undefined],
  ["a form post", { "content-type": "text/plain" }, undefined],
  ["a grant beside the workspace", {}, { workspaceId: "ws-1", grantId: "grant-1", path: "a.md" }],
  ["a file that is not a page", {}, { workspaceId: "ws-1", path: "trip/photo.png" }],
] as const)(
  "refuses the owner's open from %s before reaching the relay",
  async (_, headers, body) => {
    const c = client(() => Response.json(ownerReady));
    expect((await c.handle(open("owner", headers, body))).status).toBe(404);
    expect(c.fetchRelay).not.toHaveBeenCalled();
  },
);

it("refuses the relay's not-found, a failed open, and a malformed reason alike", async () => {
  for (const answer of [
    () => Response.json({ ok: false, code: "not_found" }, { status: 404 }),
    () => Response.json({ ok: false, code: "not_found" }, { status: 409 }),
    () => Response.json({ ok: false, result: ownerReady.result }),
    () => Response.json({ ok: true, result: { status: "refused", reason: "<script>" } }),
  ])
    expect((await client(answer).handle(open("owner"))).status).toBe(404);
});
