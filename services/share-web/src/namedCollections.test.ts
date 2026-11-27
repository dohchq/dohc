import { getCookies } from "better-auth/cookies";
import { expect, it } from "vitest";
import { createNamedCollectionsClient } from "./namedCollections";

const origin = "https://share.example.test",
  exchangeKey = "named-collections-exchange-key-of-32-characters";
const cookieName = getCookies({ baseURL: origin }).sessionToken.name;
const body = { grantId: "grant", operation: "collectionRecords", args: { datasetId: "d" } };

function client(answer: () => Response | Promise<Response>) {
  const sent: Request[] = [];
  const handle = createNamedCollectionsClient({
    relayUrl: "http://relay.internal",
    publicOrigin: origin,
    exchangeKey,
    limits: {
      maxPendingRequests: 2,
      maxRequestBytes: 4096,
      maxResponseBytes: 16384,
      timeoutMs: 1000,
    },
    fetchRelay: async (request) => {
      sent.push(request);
      return answer();
    },
  });
  const call = async (
    input: unknown = body,
    headers: Record<string, string | null> = {},
    path = "/api/named/collections",
  ) => {
    const all = new Headers({
      host: "share.example.test",
      origin,
      cookie: `${cookieName}=session; other=ignored`,
      "content-type": "application/json",
    });
    for (const [name, value] of Object.entries(headers))
      if (value === null) all.delete(name);
      else all.set(name, value);
    const response = await handle(
      new Request(`${origin}${path}`, {
        method: "POST",
        headers: all,
        body: JSON.stringify(input),
      }),
    );
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  return { sent, call };
}

it("forwards the account sign-in alone and passes the relay's answer back", async () => {
  const f = client(() => Response.json({ ok: true, result: { rows: [], nextCursor: null } }));
  expect(await f.call()).toEqual({
    status: 200,
    json: { ok: true, result: { rows: [], nextCursor: null } },
  });
  const [sent] = f.sent;
  expect(sent!.url).toBe("http://relay.internal/sync/live/named-collections");
  expect(Object.fromEntries(sent!.headers)).toEqual({
    cookie: `${cookieName}=session`,
    origin,
    "x-dohc-relay-exchange-key": exchangeKey,
    "content-type": "application/json",
  });
  expect(await sent!.json()).toEqual(body);
});

it("refuses a request from elsewhere or of another shape before the relay hears of it", async () => {
  const f = client(() => Response.json({ ok: true, result: {} }));
  for (const [reason, input, headers, path] of [
    ["another origin", body, { origin: "https://elsewhere.test" }],
    ["another host", body, { host: "elsewhere.test" }],
    ["cross-site", body, { "sec-fetch-site": "cross-site" }],
    ["not JSON", body, { "content-type": "text/plain" }],
    ["a query", body, {}, "/api/named/collections?x=1"],
    ["an extra field", { ...body, as: "owner" }, {}],
    ["a create", { ...body, operation: "collectionCreate" }, {}],
    ["a delete", { ...body, operation: "collectionDelete" }, {}],
    ["arguments that aren't an object", { ...body, args: [] }, {}],
    ["too large", { ...body, args: { value: "x".repeat(128 * 1024) } }, {}],
  ] as const)
    expect(await f.call(input, headers, path), reason).toMatchObject({ status: 404 });
  expect(await f.call(body, { cookie: "other=1" })).toEqual({
    status: 401,
    json: { ok: false, error: "signed out", code: "signed_out" },
  });
  expect(f.sent).toEqual([]);
});

it("keeps the relay's refusal to its code, and says when the relay could not answer", async () => {
  const answers: Array<[Response, number, unknown]> = [
    [
      Response.json({ ok: false, error: "conflict", code: "conflict" }, { status: 409 }),
      409,
      {
        ok: false,
        code: "conflict",
      },
    ],
    [
      Response.json({ ok: false, error: "not found", code: "not_found" }, { status: 404 }),
      404,
      {
        ok: false,
        error: "not found",
      },
    ],
    [new Response(null, { status: 503 }), 503, null],
    [Response.json({ ok: false, code: "rate_limited" }, { status: 429 }), 503, null],
    [Response.json({ ok: true, result: {}, extra: 1 }), 404, { ok: false, error: "not found" }],
    [
      new Response("<html>", { headers: { "content-type": "text/html" } }),
      404,
      {
        ok: false,
        error: "not found",
      },
    ],
  ];
  for (const [answer, status, json] of answers) {
    const f = client(() => answer);
    expect(await f.call()).toEqual({ status, json });
  }
  const failing = client(() => Promise.reject(new TypeError("fetch failed")));
  expect((await failing.call()).status).toBe(503);
});
