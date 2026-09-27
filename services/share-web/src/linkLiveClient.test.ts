import {afterEach, expect, it, vi} from "vitest";
import {createLinkLiveClient} from "./linkLiveClient";
import {LINK_REFUSALS, linkRefusalBody, type LinkRefusalCode} from "@dohc/security-contract/link-refusal";

const origin = "https://share.example.test", exchangeKey = "link-live-exchange-key-at-least-32-bytes";
const discriminator = "abcdefghijkl", capabilityToken = "A".repeat(43), profileSecret = "B".repeat(43);
const limits = {maxPendingRequests: 1, maxRequestBytes: 2048, maxResponseBytes: 8192, timeoutMs: 1000};
const browserLimits = {provider: {frames: {receive: {maxFrameBytes: 1024, maxStateVectorBytes: 4096, maxUpdateBytes: 8192, maxSyncBytes: 16384},
  maxQueuedBytes: 16384, maxQueuedFrames: 64, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 16384},
  maxPendingUpdateBytes: 16384, maxPendingUpdates: 8, maxDeliveryAttempts: 4},
  maxHttpResponseBytes: 16384, maxSocketBufferedBytes: 16384, connectTimeoutMs: 2000, sendTimeoutMs: 500, drainPollMs: 10};
const metadata = {discriminator, path: "docs/a.md"};
function request(body: unknown = metadata, path = "/api/live/link-document", headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request(`${origin}${path}`, {method: "POST", body: JSON.stringify(body), signal,
    headers: {host: "share.example.test", origin, "content-type": "application/json", cookie: "protected=cookie", ...headers}});
}
function fixture(fetchRelay = vi.fn(async (_request: Request) => Response.json({objectId: "object-a"}))) {
  const resolveMaterial = vi.fn(async (_discriminator: string, _cookie: string | null, _signal: AbortSignal) =>
    ({ok: true as const, capabilityToken, profileSecret, setCookie: null,currentCapability:async()=>capabilityToken}));
  return {fetchRelay, resolveMaterial, client: createLinkLiveClient({relayUrl: "https://relay.example.test", publicOrigin: origin,
    exchangeKey, limits, browserLimits, resolveMaterial, fetchRelay})};
}
afterEach(() => vi.restoreAllMocks());
it.each(Object.keys(LINK_REFUSALS) as LinkRefusalCode[])("preserves only the scoped relay refusal %s", async code => {
  const body = linkRefusalBody(code), status = LINK_REFUSALS[code].status;
  const f = fixture(vi.fn(async () => Response.json(body, {status})));
  const response = await f.client.handle(request());
  expect([response.status, await response.json()]).toEqual([status, body]);
  for (const value of [{...body, workspaceId: "private"}, {...body, error: "private path"}]) {
    const refused = await fixture(vi.fn(async () => Response.json(value, {status}))).client.handle(request());
    expect([refused.status, await refused.text()]).toEqual([404, '{"ok":false,"error":"not found"}']);
  }
});

it.each([401, 404, 429, 503])("keeps unverified relay failures opaque (%s)", async status => {
  const f = fixture(vi.fn(async () => Response.json({ok: false, error: "private detail"}, {status})));
  const response = await f.client.handle(request());
  expect([response.status, await response.text()]).toEqual([404, '{"ok":false,"error":"not found"}']);
});
it("derives private credentials from the selected cookie and exposes only object identity and limits", async () => {
  const f = fixture(), response = await f.client.handle(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({objectId: "object-a", limits: browserLimits});
  expect(f.resolveMaterial).toHaveBeenCalledWith(discriminator, "protected=cookie", expect.any(AbortSignal));
  const sent = f.fetchRelay.mock.calls[0]![0];
  expect(sent.url).toBe("https://relay.example.test/sync/live/link-document");
  expect(sent.headers.get("authorization")).toBe(`Bearer ${capabilityToken}`);
  expect(sent.headers.get("x-dohc-link-profile-secret")).toBe(profileSecret);
  expect(sent.headers.get("x-dohc-relay-exchange-key")).toBe(exchangeKey);
  expect(sent.headers.has("cookie")).toBe(false);
  expect(await sent.json()).toEqual(metadata);
});
it.each([
  {origin: "https://attacker.test"}, {origin: "null"}, {host: "attacker.test"},
  {"sec-fetch-site": "cross-site"}, {"content-type": "text/plain"},
] as Record<string, string>[])("refuses cross-origin metadata before resolving cookie authority: %j", async headers => {
  const f = fixture(); expect((await f.client.handle(request(metadata, undefined, headers))).status).toBe(404);
  expect(f.resolveMaterial).not.toHaveBeenCalled(); expect(f.fetchRelay).not.toHaveBeenCalled();
});
it.each([
  {...metadata, workspaceId: "foreign"}, {...metadata, principalId: "owner"}, {...metadata, capabilityToken},
  {...metadata, discriminator: "a".repeat(43)}, {...metadata, path: "a.excalidraw"},
])("refuses client authority claims and invalid selectors: %j", async body => {
  const f = fixture(); expect((await f.client.handle(request(body))).status).toBe(404); expect(f.fetchRelay).not.toHaveBeenCalled();
});
it("forwards a different cookie only for its own discriminator and refuses missing credentials", async () => {
  const seen: string[] = [];
  const client = createLinkLiveClient({relayUrl: "https://relay.example.test", publicOrigin: origin, exchangeKey, limits, browserLimits,
    async resolveMaterial(value, cookie) {seen.push(`${value}:${cookie}`); return {ok: false, status: 404};},
    async fetchRelay() {throw Error("Must not forward refused cookie");}});
  expect((await client.handle(request({...metadata, discriminator: "mnopqrstuvwx"}, undefined, {cookie: "second=cookie"}))).status).toBe(404);
  expect(seen).toEqual(["mnopqrstuvwx:second=cookie"]);
});
it.each([
  {objectId: "object-a", capabilityToken}, {objectId: "object-a", workspaceId: "workspace"}, {objectId: ""},
])("rejects unexpected private metadata without exposing it: %j", async value => {
  const f = fixture(vi.fn(async () => Response.json(value))), response = await f.client.handle(request());
  expect(response.status).toBe(404); expect(await response.text()).toBe('{"ok":false,"error":"not found"}');
});
it("returns the single-use ticket only after exact relay response validation", async () => {
  const ticket = {token: "ab".repeat(32), expiresAtMs: Date.now() + 60_000};
  const f = fixture(vi.fn(async () => Response.json(ticket)));
  const response = await f.client.handle(request({discriminator, objectId: "object-a"}, "/api/live/link-ticket"));
  expect(await response.json()).toEqual(ticket);
  expect(f.fetchRelay.mock.calls[0]![0].url).toBe("https://relay.example.test/sync/live/link-tickets");
});
it("bounds admission even when an injected relay ignores cancellation", async () => {
  let release!: (value: Response) => void, entered!: () => void;
  const started = new Promise<void>(done => {entered = done;});
  const held = new Promise<Response>(done => {release = done;});
  const f = fixture(vi.fn(async (_request: Request) => Response.json({objectId: "object-a"})).mockImplementationOnce(async () => {entered(); return held;})), controller = new AbortController();
  const first = f.client.handle(request(metadata, undefined, {}, controller.signal)); await started;
  controller.abort(); expect((await first).status).toBe(404);
  expect((await f.client.handle(request())).status).toBe(404); expect(f.fetchRelay).toHaveBeenCalledTimes(1);
  release(Response.json({objectId: "object-a"}));
  await vi.waitFor(async () => {expect((await f.client.handle(request())).status).toBe(200);});
});
