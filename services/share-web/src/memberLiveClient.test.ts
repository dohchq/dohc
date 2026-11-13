import { getCookies } from "better-auth/cookies";
import { expect, it, vi } from "vitest";
import { createMemberLiveClient } from "./memberLiveClient";

// A member's browser opens a page for editing through share-web: only the
// account cookie and the grant reach the relay, and a host's refusal keeps
// its code so the page can say why.

const origin = "https://share.example.test", exchangeKey = "member-live-exchange-key-at-least-32-chars";
const cookieName = getCookies({ baseURL: origin }).sessionToken.name;
const limits = { maxPendingRequests: 2, maxRequestBytes: 4096, maxResponseBytes: 16384, timeoutMs: 1000 };
const editorLimits = { provider: { frames: {} } };
const admitted = { kind: "named", userId: "sam", workspaceId: "named:grant-1", shareId: "share-1", grantId: "grant-1", objectId: "object-1",
  path: "trip/plan.md", discriminator: "abcdefghijkl", expiresAtMs: Date.now() + 60_000,
  ticket: { token: "ab".repeat(32), expiresAtMs: Date.now() + 60_000 }, editorLimits };

function client(answer: (request: Request) => Response) {
  const fetchRelay = vi.fn(async (request: Request) => answer(request));
  return { fetchRelay, handle: createMemberLiveClient({ relayUrl: "https://relay.test", publicOrigin: origin, exchangeKey, limits, fetchRelay }) };
}

function open(route: "open" | "ready" = "open", headers: Record<string, string> = {}, body: unknown = { grantId: "grant-1", path: "trip/plan.md" }) {
  return new Request(`${origin}/api/live/member-${route}`, { method: "POST", body: JSON.stringify(body),
    headers: { host: "share.example.test", origin, "content-type": "application/json", cookie: `${cookieName}=sam; other=secret`, ...headers } });
}

it("opens a page with the account cookie, and gives the browser only its session, ticket and document", async () => {
  const c = client(() => Response.json(admitted));
  const response = await c.handle(open());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ discriminator: "abcdefghijkl", objectId: "object-1", userId: "sam", token: "ab".repeat(32), limits: editorLimits });
  const sent = c.fetchRelay.mock.calls[0]![0];
  expect(new URL(sent.url).pathname).toBe("/sync/live/member-open");
  expect(sent.headers.get("cookie")).toBe(`${cookieName}=sam`);
  expect(sent.headers.get("origin")).toBe(origin);
  expect(sent.headers.get("x-dohc-relay-exchange-key")).toBe(exchangeKey);
  expect(sent.headers.has("authorization")).toBe(false);
  expect(await sent.json()).toEqual({ grantId: "grant-1", path: "trip/plan.md" });
});

it.each(["live-document-without-lineage", "live_host_full", "live_paused_by_owner", "document-unavailable"])("keeps the host's %s refusal", async code => {
  const c = client(() => Response.json({ ok: false, code }, { status: 409 }));
  const response = await c.handle(open());
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ ok: false, code });
});

it("answers a readiness wait with whether the host is ready", async () => {
  const ready = client(() => new Response("waiting\nready\n", { headers: { "content-type": "text/plain" } }));
  expect(await (await ready.handle(open("ready"))).json()).toEqual({ ready: true });
  expect(new URL(ready.fetchRelay.mock.calls[0]![0].url).pathname).toBe("/sync/live/member-ready");
  const unavailable = client(() => new Response("waiting\nunavailable\n", { headers: { "content-type": "text/plain" } }));
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
  expect((await client(() => Response.json({ ...admitted, path: "other.md" })).handle(open())).status).toBe(404);
  expect((await client(() => Response.json({ ok: false, code: "<script>" }, { status: 409 })).handle(open())).status).toBe(404);
});
