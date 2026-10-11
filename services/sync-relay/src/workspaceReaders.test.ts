import { afterEach, expect, it } from "vitest";
import { claimWorkspace, closeTestStorages, json, jsonBody, request, seedLinkGrant, testHandler, testStorage } from "./testing";
import { workspaceHasSettledHeadReaders } from "./storage/shares";
import type { StorageContext } from "./storage/context";

afterEach(closeTestStorages);

it("reports current external file readers on append, ordinary and held reads", async () => {
  const storage = await testStorage();
  const h = testHandler(storage);
  await claimWorkspace(h, "owner", "w");
  const readers = async (expected: boolean) => {
    for (const path of ["/sync/w/log", "/sync/w/log?hold=0"]) {
      expect.soft(await json(await h(request("owner", path)))).toMatchObject({ settledHeadReaders: expected });
    }
    expect.soft(await json(await h(request("owner", "/sync/w/log", jsonBody({ originId: "origin-a", ops: [] }))))).toMatchObject({ settledHeadReaders: expected });
  };
  await readers(false);
  const denied = await h(request("outsider", "/sync/w/log"));
  expect(denied.status).toBe(404);
  expect(await json(denied)).not.toHaveProperty("settledHeadReaders");
  const add = (id: string, selector: unknown, principal = "reader") => storage.createShare({
    share: { shareId: id, workspaceId: "w", granterUserId: "owner", selectorJson: JSON.stringify(selector), createdAtMs: 1 },
    grant: { grantId: id, shareId: id, principalKind: "user", principalUserId: principal, principalEmail: null,
      access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null },
  });
  const files = { paths: ["docs"], versionId: null };
  add("owner", files, "owner");
  add("chat", { kind: "chat", channelWireId: "channel" });
  add("invalid", { broken: true });
  await readers(false);
  const db = (storage as StorageContext).db;
  db.prepare("UPDATE sync_relay_shares SET selector_json='invalid JSON' WHERE share_id='invalid'").run();
  await readers(false);
  // JSON.parse uses the last duplicate key. Keep ambiguous rows for that parser.
  db.prepare("UPDATE sync_relay_share_grants SET access='read-only' WHERE grant_id='invalid'").run();
  db.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id='invalid'")
    .run('{"kind":"chat","kind":"group","channelWireId":"channel","paths":["docs"],"versionId":null}');
  await readers(true);
  db.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id='invalid'")
    .run('{"kind":"group","kind":"chat","paths":["docs"],"channelWireId":"channel"}');
  await readers(false);
  add("files", files);
  await readers(true);
  storage.revokeShareGrant({ shareId: "files", grantId: "files", revokedAtMs: 2 });
  await readers(false);
  add("group", { kind: "group", paths: ["docs"], channelWireId: "channel", versionId: null });
  (storage as StorageContext).db.prepare("UPDATE sync_relay_share_grants SET access='read-only' WHERE grant_id='group'").run();
  await readers(true);
  storage.revokeShareGrant({ shareId: "group", grantId: "group", revokedAtMs: 2 });
  add("publication", files, "owner");
  seedLinkGrant(storage, { shareId: "publication", grantId: "public-link", secretHash: "public-hash", access: "view" });
  await readers(true);
  storage.revokeShareGrant({ shareId: "publication", grantId: "public-link", revokedAtMs: 2 });
  await readers(false);
  add("invitation", files);
  const raw = (storage as StorageContext).db;
  raw.prepare("UPDATE sync_relay_share_grants SET principal_kind='email',principal_user_id=NULL,principal_email='reader@example.test' WHERE grant_id='invitation'").run();
  await readers(false);
  storage.claimPendingSharesForEmail("reader@example.test", "reader");
  await readers(true);
  raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='another' WHERE workspace_id='w'").run();
  expect(storage.workspaceIsOwnedBy("w", "owner")).toBe(false);
});

it("stops consuming grant rows at the first current file reader", () => {
  let consumed = 0;
  const row = { selector_json: JSON.stringify({ paths: ["docs"], versionId: null }), access: "view" };
  const context = { db: { prepare: () => ({
    all: () => Array.from({ length: 2_000 }, () => { consumed += 1; return row; }),
    iterate: function* () { for (let i = 0; i < 2_000; i += 1) { consumed += 1; yield row; } },
  }) } } as unknown as StorageContext;
  expect(workspaceHasSettledHeadReaders(context, "w")).toBe(true);
  expect(consumed).toBe(1);
});
