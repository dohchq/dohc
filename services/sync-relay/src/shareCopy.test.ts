import { afterEach, expect, it } from "vitest";
import { closeTestStorages, denialBytes, inspectDatabase, storagePath, request, testHandler, testStorage, SHARE_WEB_ORIGIN, RELAY_EXCHANGE_KEY } from "./testing";

afterEach(closeTestStorages);
const path = (workspaceId = "workspace", shareId = "share", grantId = "grant") =>
  `/sync/${workspaceId}/shares/${shareId}/grants/${grantId}/copy`;
async function fixture() {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1 });
  storage.claimWorkspace({ workspaceId: "other-workspace", ownerUserId: "owner", createdAtMs: 1 });
  const grant = { grantId: "grant", shareId: "share", principalKind: "user" as const, principalUserId: "friend", principalEmail: null,
    access: "edit", generation: 1, status: "active" as const, createdAtMs: 1, revokedAtMs: null, parentGrantId: null };
  storage.createShare({ share: { shareId: "share", workspaceId: "workspace", granterUserId: "owner",
    selectorJson: JSON.stringify({paths: ["docs"], versionId: null}), createdAtMs: 1 }, grant });
  const handler = testHandler(storage, { relayExchangeKey: RELAY_EXCHANGE_KEY, namedBrowserSessionLimits:
    {maxSessions: 8, retentionMs: 30000, maxPendingRequests: 4, maxRequestBytes: 16384, maxResponseBytes: 16384, timeoutMs: 1000} });
  return { storage, grant, handler };
}
it("returns only the authorized share handle and exact account-bound invitation, without caching", async () => {
  const { handler } = await fixture();
  const response = await handler(request("owner", path()));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ status: "active", workspaceId: "workspace", shareId: "share", grantId: "grant",
    browserInvitationUrl: `${SHARE_WEB_ORIGIN}/s/edit/grant` });
  const legacy = await (await handler(request("owner", "/sync/shares"))).json();
  expect(legacy.granted[0].browserInvitationUrl).toBe(`${SHARE_WEB_ORIGIN}/s/edit/grant`);
});
it("makes account, workspace, share and grant probes byte-identical to unknown ids", async () => {
  const { handler } = await fixture();
  const unknown = await denialBytes(await handler(request("owner", path("workspace", "unknown"))));
  for (const [actor, coordinate] of [["stranger", path()], ["friend", path()], ["owner", path("other-workspace")],
    ["owner", path("workspace", "share", "unknown")]]) {
    expect(await denialBytes(await handler(request(actor, coordinate)))).toBe(unknown);
  }
  expect((await handler(request(null, path()))).status).toBe(401);
});
it("returns ended without copy data for an owned revoked grant, while strangers stay opaque", async () => {
  const { handler, storage } = await fixture();
  storage.revokeShare("share", 2);
  const response = await handler(request("owner", path()));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({status: "ended", workspaceId: "workspace", shareId: "share", grantId: "grant"});
  expect(await denialBytes(await handler(request("stranger", path())))).toBe(
    await denialBytes(await handler(request("stranger", path("workspace", "unknown")))));
});
it("chooses the requested grant among several invitations and does not reuse another active grant after revoke", async () => {
  const { handler, storage } = await fixture();
  const db = inspectDatabase(storagePath(storage));
  try {
    db.prepare(`INSERT INTO sync_relay_share_grants
      (grant_id, share_id, principal_kind, principal_user_id, principal_email, access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id)
      VALUES ('second', 'share', 'user', 'second-friend', NULL, 'edit', 1, 'active', 1, NULL, NULL)`).run();
  } finally { db.close(); }
  expect(await (await handler(request("owner", path("workspace", "share", "second")))).json())
    .toMatchObject({grantId: "second", browserInvitationUrl: `${SHARE_WEB_ORIGIN}/s/edit/second`});
  storage.revokeShareGrant({ shareId: "share", grantId: "second", revokedAtMs: 2 });
  expect(await (await handler(request("owner", path("workspace", "share", "second")))).json())
    .toEqual({status: "ended", workspaceId: "workspace", shareId: "share", grantId: "second"});
  expect(await (await handler(request("owner", path()))).json()).toMatchObject({status: "active"});
});
it("keeps a dependent grant's share code handle while withholding invitations and checking its parent", async () => {
  const { storage, handler } = await fixture();
  const db = inspectDatabase(storagePath(storage));
  try {
    db.prepare(`INSERT INTO sync_relay_share_grants
      (grant_id, share_id, principal_kind, principal_user_id, principal_email, access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id)
      VALUES ('parent', 'share', 'link', NULL, NULL, 'edit', 1, 'active', 1, NULL, NULL)`).run();
    db.prepare("UPDATE sync_relay_share_grants SET parent_grant_id = 'parent' WHERE grant_id = 'grant'").run();
    expect(await (await handler(request("owner", path()))).json()).toEqual(
      {status: "active", workspaceId: "workspace", shareId: "share", grantId: "grant"});
    db.prepare("UPDATE sync_relay_share_grants SET status = 'revoked', revoked_at_ms = 2 WHERE grant_id = 'parent'").run();
    expect(await (await handler(request("owner", path()))).json()).toEqual(
      {status: "ended", workspaceId: "workspace", shareId: "share", grantId: "grant"});
  } finally { db.close(); }
});
it("withholds copy handles for damaged rows, as Settings does", async () => {
  const { storage, handler } = await fixture();
  const unknown = await denialBytes(await handler(request("owner", path("workspace", "unknown"))));
  const db = inspectDatabase(storagePath(storage));
  try { db.prepare("UPDATE sync_relay_shares SET selector_json = '{}' WHERE share_id = 'share'").run(); }
  finally { db.close(); }
  expect(await denialBytes(await handler(request("owner", path())))).toBe(unknown);
});
it("keeps the optional invitation absent when the existing serializer would omit it", async () => {
  const { storage } = await fixture();
  const handler = testHandler(storage);
  expect(await (await handler(request("owner", path()))).json()).toEqual(
    {status: "active", workspaceId: "workspace", shareId: "share", grantId: "grant"});
});
