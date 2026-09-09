import {getCookies} from "better-auth/cookies";
import {expect, it, vi} from "vitest";
import {createNamedLiveTicketClient} from "./namedLiveTicketClient";
const origin = "https://share.example.test", cookieName = getCookies({baseURL: origin}).sessionToken.name;
const limits = {maxPendingRequests: 1, maxRequestBytes: 2048, maxResponseBytes: 5000, timeoutMs: 1000};
const token = "ab".repeat(32), input = {discriminator: "abcdefghijkl", objectId: "object"};
function request(body: unknown = input, cookie = `${cookieName}=account-secret; link-secret=not-forwarded`) {
  return new Request(`${origin}/api/live/named-ticket`, {method: "POST", body: JSON.stringify(body),
    headers: {host: "share.example.test", origin, cookie, "content-type": "application/json"}});
}
function fixture() {
  const fetchRelay = vi.fn(async (_request: Request) => Response.json({token, expiresAtMs: 1234}));
  return {fetchRelay, mint: createNamedLiveTicketClient({relayUrl: "http://relay.test", publicOrigin: origin, exchangeKey: "x".repeat(32), limits, fetchRelay})};
}
it("requests a ticket with the account cookie and returns only the parsed token", async () => {
  const f = fixture(), result = await f.mint(request());
  expect(result.status).toBe(200); expect(await result.json()).toEqual({token, expiresAtMs: 1234});
  const forwarded = f.fetchRelay.mock.calls[0]![0];
  expect(forwarded.url).toBe("http://relay.test/sync/live/named-tickets");
  expect(forwarded.headers.get("cookie")).toBe(`${cookieName}=account-secret`);
  expect(await forwarded.json()).toEqual(input);
});
it.each([{...input, userId: "forged"}, {...input, discriminator: "invalid"}, {...input, objectId: ""}])("refuses malformed ticket input", async value => {
  const f = fixture(); expect((await f.mint(request(value))).status).toBe(404); expect(f.fetchRelay).not.toHaveBeenCalled();
});
it("refuses link-only authentication and extra upstream authority data", async () => {
  const f = fixture(); expect((await f.mint(request(input, "link=only"))).status).toBe(404); expect(f.fetchRelay).not.toHaveBeenCalled();
  f.fetchRelay.mockImplementationOnce(async () => Response.json({token, expiresAtMs: 1234, userId: "untrusted"}));
  expect((await f.mint(request())).status).toBe(404);
});
it("holds the pending slot until its upstream request completes", async () => {
  const f = fixture(); let finish!: (value: Response) => void, entered!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  f.fetchRelay.mockImplementationOnce(() => {entered(); return new Promise(resolve => {finish = resolve;});});
  const pending = f.mint(request()); await started;
  expect((await f.mint(request())).status).toBe(404);
  finish(Response.json({token, expiresAtMs: 1234})); expect((await pending).status).toBe(200);
});
