import {afterEach, expect, it, vi} from "vitest";
import {createLinkLiveHttp} from "./linkLiveHttp";
import {createLiveTickets} from "./liveTickets";
import {hashLinkBearer, hashLinkProfileSecret} from "./linkSecurity";
import {audience, binding, fixture as ticketFixture, key, report, scope} from "./liveTickets.test-helper";

const bearer = Buffer.alloc(32, 1).toString("base64url"), profile = Buffer.alloc(32, 2).toString("base64url");
const exchangeKey = "private-link-metadata-exchange-at-least-32", discriminator = "abcdefghijkl";
const limits = {maxConnections: 8, maxConnectionsPerSession: 2, maxConnectionsPerPrincipal: 3, maxConnectionsPerGrant: 4,
  maxPendingRequests: 4, maxRequestBytes: 4096, maxResponseBytes: 4096, maxPendingBytes: 4096, maxFragments: 8, maxBufferedChunks: 16,
  upgradeTimeoutMs: 1000, idleTimeoutMs: 5000, drainTimeoutMs: 100};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {vi.restoreAllMocks(); for (const close of cleanups.splice(0)) await close();});
async function fixture() {
  const f = await ticketFixture(); cleanups.push(f.close); vi.spyOn(Date, "now").mockReturnValue(1000);
  // Synthetic private authority fixture. Public Edit creation/exchange remains closed.
  f.raw.exec("UPDATE sync_relay_share_grants SET principal_kind='link', principal_user_id=NULL");
  expect(f.storage.mintLinkSession({session: {sessionId: "link-session", capabilityHash: hashLinkBearer(bearer, key),
    grantId: scope.grantId, generation: 4, mintedAtMs: 999, expiresAtMs: 61_000}})).toBe(true);
  const context = {kind: "link" as const, workspaceId: scope.workspaceId, shareId: scope.shareId, grantId: scope.grantId,
    sessionId: "link-session", capabilityHash: hashLinkBearer(bearer, key), profileTokenHash: hashLinkProfileSecret(profile, key)};
  const tickets = createLiveTickets({storage: f.storage, audience, key, hostReports: {currentBinding: async () => report}});
  const handle = createLinkLiveHttp({storage: f.storage, linkKey: key, hosts: new Set(["relay.test"]), publicOrigin: audience, exchangeKey, limits});
  return {...f, context, tickets, handle};
}
function request(body: unknown = {discriminator, path: binding.currentPath}, path = "/sync/live/link-document", headers: Record<string, string> = {}) {
  return new Request(`https://relay.test${path}`, {method: "POST", body: JSON.stringify(body), headers: {host: "relay.test", origin: audience,
    "content-type": "application/json", "x-dohc-relay-exchange-key": exchangeKey, authorization: `Bearer ${bearer}`,
    "x-dohc-link-profile-secret": profile, ...headers}});
}
it("resolves only the existing current Markdown object within the link selector", async () => {
  const f = await fixture(); expect(await (await f.handle(request())).json()).toEqual({objectId: binding.objectId});
  for (const path of ["private/a.md", "docs/missing.md", "docs/a.excalidraw"]) expect((await f.handle(request({discriminator, path}))).status).toBe(404);
  f.raw.prepare("UPDATE sync_relay_shares SET selector_json=?").run(JSON.stringify({paths: ["elsewhere"], versionId: null}));
  expect((await f.handle(request())).status).toBe(404);
});
it("derives gateway authority only after ticket enrollment and refuses a different profile", async () => {
  const f = await fixture();
  const resolve = () => f.handle(request({discriminator}, "/sync/live/link-session"));
  expect((await resolve()).status).toBe(404);
  expect(await f.tickets.mint({objectId: binding.objectId}, f.context)).not.toBeNull();
  const value = await (await resolve()).json();
  expect(value).toEqual({kind: "link", workspaceId: scope.workspaceId, shareId: scope.shareId, grantId: scope.grantId,
    sessionId: "link-session", principalId: f.storage.getLinkPrincipalForGrantProfile(scope.grantId, f.context.profileTokenHash)!.principalId});
  const other = Buffer.alloc(32, 3).toString("base64url");
  expect((await f.handle(request({discriminator}, "/sync/live/link-session", {"x-dohc-link-profile-secret": other}))).status).toBe(404);
  for (const secret of [bearer, profile, f.context.capabilityHash, f.context.profileTokenHash]) expect(JSON.stringify(value)).not.toContain(secret);
});
it.each([
  {origin: "https://foreign.test"}, {host: "foreign.test"}, {"x-dohc-relay-exchange-key": "wrong"},
  {authorization: ""}, {"x-dohc-link-profile-secret": ""},
] as Record<string, string>[])("refuses missing or mismatched private authority %j", async headers => {
  const f = await fixture(); expect((await f.handle(request(undefined, undefined, headers))).status).toBe(404);
});
it.each(["view", "revoked", "expired", "pinned"])("refuses current authority after %s transition", async mode => {
  const f = await fixture();
  if (mode === "view") f.raw.exec("UPDATE sync_relay_share_grants SET access='view'");
  if (mode === "revoked") f.storage.revokeShareGrant({shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 1000});
  if (mode === "expired") vi.mocked(Date.now).mockReturnValue(61_000);
  if (mode === "pinned") f.raw.prepare("UPDATE sync_relay_shares SET selector_json=?").run(JSON.stringify({paths: ["docs"], versionId: "side"}));
  expect((await f.handle(request())).status).toBe(404);
});
