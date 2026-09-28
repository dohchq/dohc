import {afterEach, expect, it} from "vitest";
import {createShareSummaries} from "./shareSummaries";
import type {SyncRelayShareWithGrantRow} from "./storage";
import {claimWorkspace, closeTestStorages, json, jsonBody, request, testHandler, testStorage, RELAY_EXCHANGE_KEY, SHARE_WEB_ORIGIN} from "./testing";

afterEach(closeTestStorages);
const limits = {maxSessions: 8, retentionMs: 30000, maxPendingRequests: 4, maxRequestBytes: 16384, maxResponseBytes: 16384, timeoutMs: 1000};

it.each(["friend@dohc.test", "pending@example.test"])("issues and lists an exact account-bound invitation for %s", async recipientEmail => {
  const storage = await testStorage();
  const grantId = "grant:exact/with?#characters";
  const handler = testHandler(storage, {newGrantId: () => grantId, relayExchangeKey: RELAY_EXCHANGE_KEY, namedBrowserSessionLimits: limits});
  await claimWorkspace(handler, "owner", "workspace");
  const response = await handler(request("owner", "/sync/workspace/shares", jsonBody({recipientEmail, paths: ["docs"], access: "edit"})));
  expect(response.status).toBe(200);
  const created = await json(response), browserInvitationUrl = `${SHARE_WEB_ORIGIN}/s/edit/${encodeURIComponent(grantId)}`;
  expect(created).toMatchObject({grantId, browserInvitationUrl});
  expect(created).not.toHaveProperty("recipientUserId");
  expect(created).not.toHaveProperty("recipientEmail");
  expect(new URL(String(created.browserInvitationUrl)).hash).toBe("");
  const listing = await json(await handler(request("owner", "/sync/shares")));
  expect(listing.granted).toEqual([expect.objectContaining({shareId: created.shareId, grantId, browserInvitationUrl})]);
  expect((await json(await handler(request("stranger", "/sync/shares")))).granted).toEqual([]);
  const createByStranger = await handler(request("stranger", "/sync/workspace/shares", jsonBody({recipientEmail, paths: ["docs"], access: "edit"})));
  expect(createByStranger.status).toBe(404);
  // Knowing the URL or presenting a desktop bearer never substitutes for the invited browser account.
  const navigate = jsonBody({grantId});
  const headers = new Headers(navigate.headers);
  headers.set("origin", SHARE_WEB_ORIGIN); headers.set("x-dohc-relay-exchange-key", RELAY_EXCHANGE_KEY);
  expect((await handler(request("friend", "/sync/live/named-documents", {...navigate, headers}))).status).toBe(404);
});

it.each([
  {configured: false, access: "edit", paths: ["docs"]},
  {configured: true, access: "view", paths: ["docs"]},
  {configured: true, access: "edit", versionId: "main"},
])("retains ordinary shares without an invitation for %j", async ({configured, ...scope}) => {
  const handler = testHandler(await testStorage(), configured ? {relayExchangeKey: RELAY_EXCHANGE_KEY, namedBrowserSessionLimits: limits} : {});
  await claimWorkspace(handler, "owner", "workspace");
  const response = await handler(request("owner", "/sync/workspace/shares", jsonBody({recipientEmail: "friend@dohc.test", ...scope})));
  expect(response.status).toBe(200);
  const created = await json(response);
  expect(created).toHaveProperty("shareId"); expect(created).toHaveProperty("grantId");
  expect(created).not.toHaveProperty("browserInvitationUrl");
  const listing = await json(await handler(request("owner", "/sync/shares")));
  expect(listing.granted).toEqual([expect.not.objectContaining({browserInvitationUrl: expect.anything()})]);
});

it("omits browser invitations from revoked, dependent, damaged, chat, and public grants", async () => {
  const row: SyncRelayShareWithGrantRow = {
    share: {shareId: "share", workspaceId: "workspace", granterUserId: "owner", selectorJson: JSON.stringify({paths: ["docs"], versionId: null}), createdAtMs: 1},
    grant: {shareId: "share", grantId: "grant", principalKind: "user", principalUserId: "friend", principalEmail: null, access: "edit",
      generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null},
  };
  const {grantedShareSummary} = createShareSummaries(undefined, SHARE_WEB_ORIGIN);
  const excluded: SyncRelayShareWithGrantRow[] = [
    {...row, grant: {...row.grant, status: "revoked", revokedAtMs: 2}},
    {...row, grant: {...row.grant, parentGrantId: "parent"}},
    {...row, grant: {...row.grant, principalKind: "link", principalUserId: null}},
    {...row, share: {...row.share, selectorJson: "{}"}},
    {...row, share: {...row.share, selectorJson: JSON.stringify({kind: "chat", channelWireId: "channel"})}, grant: {...row.grant, access: "read-write"}},
  ];
  for (const item of excluded) expect(await grantedShareSummary({ ...item, automationsGeneration: null })).not.toHaveProperty("browserInvitationUrl");
});
