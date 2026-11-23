import { afterEach, expect, it } from "vitest";
import type { StorageContext } from "./storage/context";
import { hashLinkBearer } from "./linkSecurity";
import {
  closeTestStorages,
  LINK_KEY,
  request,
  seedDependentGrant,
  seedLinkGrant,
  testHandler,
  testStorage,
} from "./testing";

afterEach(closeTestStorages);

const GRANT = {
  principalKind: "user" as const,
  principalEmail: null,
  generation: 1,
  status: "active" as const,
  createdAtMs: 1,
  revokedAtMs: null,
  parentGrantId: null,
};

async function fixture() {
  const storage = await testStorage({ blobGraceMs: 0 });
  storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
  const share = (shareId: string, selector: unknown) => ({
    shareId,
    workspaceId: "w",
    granterUserId: "owner",
    selectorJson: JSON.stringify(selector),
    createdAtMs: 1,
  });
  storage.createShare({
    share: share("s", { paths: ["notes"], versionId: null }),
    grant: { ...GRANT, grantId: "reader", shareId: "s", principalUserId: "reader", access: "edit" },
  });
  seedLinkGrant(storage, {
    shareId: "s",
    grantId: "link",
    secretHash: hashLinkBearer("a".repeat(43), LINK_KEY),
    access: "view",
  });
  seedDependentGrant(storage, {
    shareId: "s",
    parentGrantId: "link",
    grantId: "other",
    principalUserId: "other",
    createdAtMs: 3,
  });
  storage.createShare({
    share: share("members", { kind: "workspace" }),
    grant: {
      ...GRANT,
      grantId: "member",
      shareId: "members",
      principalUserId: "reader",
      access: "view",
    },
  });
  let now = 3000;
  const handle = testHandler(storage, { nowMs: () => now });
  const leave = (userId: string | null, shareId = "s", body: unknown = { ended: false }) =>
    handle(
      request(userId, `/sync/shares/${shareId}/leave`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const received = async (userId: string) =>
    (await (await handle(request(userId, "/sync/shares?received=true"))).json()) as {
      received: { shareId: string }[];
      removed: { shareId: string }[];
    };
  return { storage, handle, leave, received, at: (ms: number) => (now = ms) };
}

it("ends the recipient's own access and takes the share off their list", async () => {
  const { storage, leave, received } = await fixture();
  expect((await received("reader")).received.map((row) => row.shareId)).toContain("s");

  expect((await leave("reader")).status).toBe(200);

  expect(storage.getShareGrant("reader")).toMatchObject({ status: "revoked", generation: 2 });
  const after = await received("reader");
  expect(after.received.map((row) => row.shareId)).not.toContain("s");
  expect(after.removed.map((row) => row.shareId)).not.toContain("s");
  expect((await leave("reader")).status).toBe(200);
  expect(storage.getShareGrant("reader")?.generation).toBe(2);
});

it("clears a share the owner ended, and shows it again when the owner ends it again", async () => {
  const { storage, leave, received, at } = await fixture();
  const removed = storage.removeShareAccess({
    shareId: "s",
    grantId: "reader",
    actorUserId: "owner",
    nowMs: 3000,
  });
  if (!removed.ok || !removed.undo) throw Error("removal failed");
  expect((await received("reader")).removed.map((row) => row.shareId)).toEqual(["s"]);

  at(3500);
  const cleared = await leave("reader", "s", { ended: true });
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toEqual({ ok: true, left: true });
  expect((await received("reader")).removed).toEqual([]);

  storage.undoShareRemoval({
    shareId: "s",
    actorUserId: "owner",
    undoId: removed.undo.undoId,
    nowMs: 4000,
  });
  expect((await received("reader")).received.map((row) => row.shareId)).toContain("s");
  expect(
    storage.removeShareAccess({
      shareId: "s",
      grantId: "reader",
      actorUserId: "owner",
      nowMs: 5000,
    }).ok,
  ).toBe(true);
  expect((await received("reader")).removed.map((row) => row.shareId)).toEqual(["s"]);
});

it("keeps access the owner restored when only an ended share was to be cleared", async () => {
  const { storage, leave, received } = await fixture();

  const response = await leave("reader", "s", { ended: true });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, left: false });
  expect(storage.getShareGrant("reader")).toMatchObject({ status: "active", generation: 1 });
  expect((await received("reader")).received.map((row) => row.shareId)).toContain("s");
});

it("clears an ended chat share, and refuses to leave one that is active", async () => {
  const { storage, leave, received } = await fixture();
  storage.createShare({
    share: {
      ...storage.getShare("s")!,
      shareId: "chat",
      selectorJson: JSON.stringify({ kind: "chat", channelWireId: "channel_wire_team" }),
    },
    grant: {
      ...GRANT,
      grantId: "chatter",
      shareId: "chat",
      principalUserId: "reader",
      access: "read-only",
    },
  });

  expect((await leave("reader", "chat")).status).toBe(404);
  expect(storage.getShareGrant("chatter")).toMatchObject({ status: "active", generation: 1 });

  expect(
    storage.removeShareAccess({
      shareId: "chat",
      grantId: "chatter",
      actorUserId: "owner",
      nowMs: 3000,
    }).ok,
  ).toBe(true);
  expect((await leave("reader", "chat", { ended: true })).status).toBe(200);
  expect((await received("reader")).removed.map((row) => row.shareId)).not.toContain("chat");
});

it("keeps the owner's Undo from bringing back someone who chose to leave", async () => {
  const { storage, leave } = await fixture();
  const removed = storage.removeShareAccess({ shareId: "s", actorUserId: "owner", nowMs: 3000 });
  if (!removed.ok || !removed.undo) throw Error("removal failed");

  expect((await leave("reader")).status).toBe(200);
  storage.undoShareRemoval({
    shareId: "s",
    actorUserId: "owner",
    undoId: removed.undo.undoId,
    nowMs: 4000,
  });

  expect(storage.getShareGrant("reader")?.status).toBe("revoked");
  expect(storage.getShareGrant("other")?.status).toBe("active");
  expect(storage.getShareGrant("link")?.status).toBe("active");
});

it("ends the owner's Undo of one person's removal once that person leaves", async () => {
  const { storage, leave } = await fixture();
  const removed = storage.removeShareAccess({
    shareId: "s",
    grantId: "reader",
    actorUserId: "owner",
    nowMs: 3000,
  });
  if (!removed.ok || !removed.undo) throw Error("removal failed");

  expect((await leave("reader")).status).toBe(200);

  expect(() =>
    storage.undoShareRemoval({
      shareId: "s",
      actorUserId: "owner",
      undoId: removed.undo!.undoId,
      nowMs: 4000,
    }),
  ).toThrow("Access changed after removal");
  expect(storage.getShareGrant("reader")?.status).toBe("revoked");
});

it("clears a share that ended with its owner's account, and keeps no row for it", async () => {
  const { storage, handle, leave, received } = await fixture();
  const { db } = storage as unknown as StorageContext;
  db.exec(
    "CREATE TABLE IF NOT EXISTS sync_relay_ended_shares (share_id TEXT NOT NULL, recipient_user_id TEXT NOT NULL, ended_at_ms INTEGER NOT NULL, PRIMARY KEY (share_id, recipient_user_id)) STRICT",
  );
  db.prepare("INSERT INTO sync_relay_ended_shares VALUES (?, ?, ?)").run("gone", "reader", 2000);
  expect((await received("reader")).removed.map((row) => row.shareId)).toContain("gone");

  expect((await leave("other", "gone", { ended: true })).status).toBe(404);
  expect((await leave("reader", "gone", { ended: true })).status).toBe(200);

  expect((await received("reader")).removed.map((row) => row.shareId)).not.toContain("gone");
  const full = (await (await handle(request("reader", "/sync/shares"))).json()) as {
    removed: { shareId: string }[];
  };
  expect(full.removed.map((row) => row.shareId)).not.toContain("gone");
  expect(db.prepare("SELECT COUNT(*) AS total FROM sync_relay_share_departures").get()).toEqual({
    total: 0,
  });
});

it("touches nobody else's access", async () => {
  const { storage, leave } = await fixture();
  const owner = storage.getShare("s");

  expect((await leave("stranger")).status).toBe(404);
  expect((await leave("stranger", "s", { ended: true })).status).toBe(404);
  expect((await leave("owner")).status).toBe(404);
  expect((await leave(null)).status).toBe(401);
  expect((await leave("reader", "missing")).status).toBe(404);
  expect(storage.getShareGrant("reader")).toMatchObject({ status: "active", generation: 1 });

  expect((await leave("reader")).status).toBe(200);
  expect(storage.getShare("s")).toEqual(owner);
  for (const grantId of ["other", "link"])
    expect(storage.getShareGrant(grantId)).toMatchObject({ status: "active", generation: 1 });
});

it("refuses a share that is not of files, and anything but POST", async () => {
  const { storage, handle, leave } = await fixture();

  expect((await leave("reader", "members")).status).toBe(404);
  expect((await leave("reader", "members", { ended: true })).status).toBe(404);
  for (const body of [{}, { ended: "yes" }, { ended: false, shareId: "s" }])
    expect((await leave("reader", "s", body)).status, JSON.stringify(body)).toBe(400);
  expect(storage.getShareGrant("member")).toMatchObject({ status: "active", generation: 1 });
  expect((await handle(request("reader", "/sync/shares/s/leave"))).status).toBe(405);
  expect(storage.getShareGrant("reader")?.status).toBe("active");
});
