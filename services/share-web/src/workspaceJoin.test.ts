import {getCookies} from "better-auth/cookies";
import {expect, it, vi} from "vitest";
import {createWorkspaceJoinClient} from "./workspaceJoin";

const origin = "https://share.example.test", exchangeKey = "workspace-join-exchange-key-at-least-32";
const cookieName = getCookies({baseURL: origin}).sessionToken.name;
const limits = {maxPendingRequests: 2, maxRequestBytes: 2048, maxResponseBytes: 8192, timeoutMs: 1000};
const TOKEN = "invite_token_0123456789";

function client(relay: (request: Request) => Response | Promise<Response>) {
  const forwarded: Request[] = [];
  const fetchRelay = vi.fn(async (input: Request) => { forwarded.push(input.clone()); return relay(input); });
  return {forwarded, fetchRelay, join: createWorkspaceJoinClient({relayUrl: "https://relay.test", publicOrigin: origin, exchangeKey, limits, fetchRelay})};
}
function request(path = "/api/members/join-preview", body: unknown = {token: TOKEN}, headers: Record<string, string> = {}) {
  return new Request(`${origin}${path}`, {method: "POST", body: JSON.stringify(body),
    headers: {host: "share.example.test", origin, "content-type": "application/json", cookie: `${cookieName}=sam; other=x`, ...headers}});
}

it("forwards the token with the account cookie and exchange key, and returns only the preview's fields", async () => {
  const f = client(() => Response.json({workspaceName: "Community", ownerName: "Ana", alreadyMember: false, ownerEmail: "ana@example.test"}));
  const input = request();
  input.headers.set("authorization", "Bearer forged"); input.headers.set("x-dohc-relay-exchange-key", "forged");
  const response = await f.join(input);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({workspaceName: "Community", ownerName: "Ana", alreadyMember: false});
  const sent = f.forwarded[0]!;
  expect(new URL(sent.url).pathname).toBe("/sync/members/join-preview");
  expect(await sent.json()).toEqual({token: TOKEN});
  expect(sent.headers.get("cookie")).toBe(`${cookieName}=sam`);
  expect(sent.headers.get("x-dohc-relay-exchange-key")).toBe(exchangeKey);
  expect(sent.headers.get("origin")).toBe(origin);
  expect(sent.headers.has("authorization")).toBe(false);
});

it("joins through the relay's join route", async () => {
  const f = client(() => Response.json({workspaceId: "ws-1", shareId: "share-1", workspaceName: "Community"}));
  const response = await f.join(request("/api/members/join"));
  expect(await response.json()).toEqual({workspaceId: "ws-1", shareId: "share-1", workspaceName: "Community"});
  expect(new URL(f.forwarded[0]!.url).pathname).toBe("/sync/members/join");
});

it("answers signed out without asking the relay when no account cookie came", async () => {
  const f = client(() => Response.json({}));
  const response = await f.join(request(undefined, undefined, {cookie: "other=x"}));
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ok: false, code: "signed_out"});
  expect(f.fetchRelay).not.toHaveBeenCalled();
});

it.each([
  [401, {}, 401, "signed_out"],
  [404, {code: "invite_link_off"}, 404, "link_off"],
  [404, {}, 404, "link_off"],
  [403, {code: "member_removed"}, 403, "removed"],
  [409, {code: "workspace_full"}, 409, "full"],
  [403, {}, 503, "unavailable"],
  [500, {}, 503, "unavailable"],
] as const)("maps a relay %i %j to %i %s", async (status, body, expected, code) => {
  const f = client(() => Response.json(body, {status}));
  const response = await f.join(request());
  expect(response.status).toBe(expected);
  expect(await response.json()).toEqual({ok: false, code});
});

it("answers unavailable for a relay that cannot be reached or answers nonsense", async () => {
  expect(await (await client(() => { throw new TypeError("connect ECONNREFUSED"); }).join(request())).json()).toEqual({ok: false, code: "unavailable"});
  expect(await (await client(() => Response.json({workspaceName: 4})).join(request())).json()).toEqual({ok: false, code: "unavailable"});
  expect(await (await client(() => new Response("<html>", {headers: {"content-type": "text/html"}})).join(request())).json()).toEqual({ok: false, code: "unavailable"});
});

it.each([
  ["another origin", request(undefined, undefined, {origin: "https://evil.test"})],
  ["a cross-site fetch", request(undefined, undefined, {"sec-fetch-site": "cross-site"})],
  ["a malformed token", request(undefined, {token: "short"})],
  ["extra fields", request(undefined, {token: TOKEN, workspaceId: "ws-2"})],
  ["an unknown path", request("/api/members/leave")],
  ["a query", request("/api/members/join?x=1")],
])("refuses %s before the relay", async (_name, input) => {
  const f = client(() => Response.json({}));
  expect((await f.join(input)).status).toBe(404);
  expect(f.fetchRelay).not.toHaveBeenCalled();
});
