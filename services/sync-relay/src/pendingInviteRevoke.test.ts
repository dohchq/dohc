import { afterEach, expect, it } from "vitest";
import { hashLinkBearer } from "./linkSecurity";
import {
  closeTestStorages,
  LINK_KEY,
  request,
  seedLinkGrant,
  testHandler,
  testStorage,
} from "./testing";

afterEach(closeTestStorages);

async function fixture() {
  const storage = await testStorage({ blobGraceMs: 0 });
  storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
  storage.createShare({
    share: {
      shareId: "s",
      workspaceId: "w",
      granterUserId: "owner",
      selectorJson: JSON.stringify({ paths: ["notes"], versionId: null }),
      createdAtMs: 1,
    },
    grant: {
      grantId: "pending",
      shareId: "s",
      principalKind: "email",
      principalUserId: null,
      principalEmail: "new@dohc.test",
      access: "view",
      generation: 1,
      status: "active",
      createdAtMs: 1,
      revokedAtMs: null,
      parentGrantId: null,
    },
  });
  seedLinkGrant(storage, {
    shareId: "s",
    grantId: "link",
    secretHash: hashLinkBearer("a".repeat(43), LINK_KEY),
    access: "view",
  });
  const handle = testHandler(storage, { nowMs: () => 3000 });
  const revoke = (userId: string | null, grantId: string, path = "revoke") =>
    handle(
      request(userId, `/sync/shares/s/grants/${grantId}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "w" }),
      }),
    );
  return { storage, revoke };
}

it("removes one pending invitation and leaves the share's link, and Undo brings the invitation back", async () => {
  const { storage, revoke } = await fixture();

  const response = await revoke("owner", "pending");

  expect(response.status).toBe(200);
  const body = (await response.json()) as { status: string; undo: { undoId: string } };
  expect(body).toMatchObject({ grantId: "pending", status: "revoked" });
  expect(storage.getShareGrant("pending")).toMatchObject({ status: "revoked", generation: 2 });
  expect(storage.getShareGrant("link")).toMatchObject({ status: "active", generation: 1 });
  expect(storage.hasPendingInvite("new@dohc.test")).toBe(false);
  expect(storage.claimPendingSharesForEmail("new@dohc.test", "newcomer")).toBe(0);

  storage.undoShareRemoval({
    shareId: "s",
    actorUserId: "owner",
    undoId: body.undo.undoId,
    nowMs: 4000,
  });
  expect(storage.getShareGrant("pending")).toMatchObject({
    status: "active",
    principalKind: "email",
    principalUserId: null,
  });
  expect(storage.hasPendingInvite("new@dohc.test")).toBe(true);
  expect(storage.claimPendingSharesForEmail("new@dohc.test", "newcomer")).toBe(1);
  expect(storage.getShareGrant("pending")).toMatchObject({
    status: "active",
    principalUserId: "newcomer",
  });
});

it("refuses everyone but the owner, and still refuses a link through this route", async () => {
  const { storage, revoke } = await fixture();

  expect((await revoke("stranger", "pending")).status).toBe(404);
  expect((await revoke(null, "pending")).status).toBe(401);
  expect((await revoke("owner", "link")).status).toBe(404);
  expect((await revoke("owner", "missing")).status).toBe(404);

  expect(storage.getShareGrant("pending")).toMatchObject({ status: "active", generation: 1 });
  expect(storage.getShareGrant("link")).toMatchObject({ status: "active", generation: 1 });
});

it("still refuses to promote a pending invitation", async () => {
  const { storage, revoke } = await fixture();

  expect((await revoke("owner", "pending", "promote")).status).toBe(404);
  expect(storage.getShareGrant("pending")).toMatchObject({ status: "active", generation: 1 });
});
