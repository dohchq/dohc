import { afterEach, expect, it } from "vitest";
import { authorizeShareAction } from "./shareAuthorization";
import { accountIsFenced, fenceAccount, initializeAccountDeletion } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";
import { readCurrentShareGrant } from "./storage/currentShareGrant";
import { insertShareGrant } from "./storage/shares";
import { closeTestStorages, request, testHandler, testStorage } from "./testing";

afterEach(closeTestStorages);
const key = "fenced-undo-test-key-at-least-thirty-two-bytes";
const owner = "owner@dohc.test", deleted = "deleted@dohc.test", survivor = "survivor@dohc.test";
const removal = { shareId: "share", actorUserId: owner, nowMs: 1000 };

async function fixture(principalKind: "user" | "email", mixed: boolean) {
  const storage = await testStorage() as StorageContext;
  initializeAccountDeletion(storage, key);
  storage.claimWorkspace({ workspaceId: "workspace", ownerUserId: owner, createdAtMs: 1 });
  const grant = { grantId: "deleted-grant", shareId: "share", principalKind,
    principalUserId: principalKind === "user" ? deleted : null,
    principalEmail: principalKind === "email" ? "DELETED@DOHC.TEST" : null,
    access: "view" as const, generation: 1, status: "active" as const,
    createdAtMs: 1, revokedAtMs: null, parentGrantId: null };
  const share = { shareId: "share", workspaceId: "workspace", granterUserId: owner,
    selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }), createdAtMs: 1 };
  storage.createShare({ share, grant });
  if (mixed) insertShareGrant(storage, { ...grant, grantId: "survivor-grant", principalKind: "user",
    principalUserId: survivor, principalEmail: null });
  storage.createShare({ share: { ...share, shareId: "unrelated-share" },
    grant: { ...grant, grantId: "unrelated-grant", shareId: "unrelated-share", principalKind: "user",
      principalUserId: survivor, principalEmail: null } });
  const unrelated = storage.removeShareAccess({ ...removal, shareId: "unrelated-share" });
  const removed = storage.removeShareAccess(removal);
  if (!removed.ok || !removed.undo || !unrelated.ok || !unrelated.undo) throw Error("removal failed");
  return { storage, undoId: removed.undo.undoId, unrelatedUndoId: unrelated.undo.undoId };
}

it.each([
  ["user", false], ["email", false], ["user", true], ["email", true],
] as const)("fencing voids a %s receipt before purge (mixed: %s)", async (kind, mixed) => {
  const { storage, undoId, unrelatedUndoId } = await fixture(kind, mixed);
  fenceAccount(storage, key, deleted, " Deleted@DOHC.TEST ");
  expect(accountIsFenced(storage, deleted)).toBe(true);
  const response = await testHandler(storage, { nowMs: () => 2000 })(request(owner, "/sync/shares/share/undo", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ undoId }),
  }));
  expect.soft(response.status).toBe(409);
  expect.soft(await response.json()).toMatchObject({
    error: "Access changed after removal. Undo is no longer available.",
  });
  expect.soft(storage.getShareGrant("deleted-grant")).toMatchObject({ status: "revoked", generation: 2 });
  expect.soft(readCurrentShareGrant(storage, { grantId: "deleted-grant" })).toBeNull();
  expect.soft(authorizeShareAction({ storage, actorUserId: deleted, shareId: "share", action: "read" }).ok).toBe(false);
  if (mixed) {
    expect.soft(storage.getShareGrant("survivor-grant")).toMatchObject({ status: "revoked", generation: 2 });
    expect.soft(authorizeShareAction({ storage, actorUserId: survivor, shareId: "share", action: "read" }).ok).toBe(false);
  }
  storage.undoShareRemoval({ ...removal, shareId: "unrelated-share", undoId: unrelatedUndoId, nowMs: 2000 });
  expect(authorizeShareAction({ storage, actorUserId: survivor, shareId: "unrelated-share", action: "read" }).ok).toBe(true);
});

it("restores every person in a mixed receipt when no account is fenced", async () => {
  const { storage, undoId } = await fixture("user", true);
  storage.undoShareRemoval({ ...removal, undoId, nowMs: 2000 });
  for (const userId of [deleted, survivor]) {
    expect(authorizeShareAction({ storage, actorUserId: userId, shareId: "share", action: "read" }).ok).toBe(true);
  }
});
