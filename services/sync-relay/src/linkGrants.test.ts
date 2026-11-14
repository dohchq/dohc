import { TokenBucketLimiter } from "@dohc/service-http";
import { timingSafeEqual } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  constantTimeHashEqual,
  hashLinkBearer,
  LINK_SESSION_RENEWAL_GRACE_MS,
  LINK_SESSION_TTL_MS,
  sealLinkBearer,
  unsealLinkBearer,
  validateLinkCapability,
} from "./linkSecurity";
import type { SyncRelayHandler } from "./server";
import { type SyncRelayStorage } from "./storage";
import {
  chatChannelCreate,
  seedDependentGrant,
  sequenced,
  closeTestStorage,
  closeTestStorages,
  countStorageCalls,
  denialBytes,
  inspect,
  inspectDatabase,
  interceptStorage,
  json,
  jsonBody,
  LINK_KEY,
  linkSecret,
  reopenTestStorage,
  request,
  seedLinkGrant,
  seedLinkSession,
  storagePath,
  testHandler,
  testStorage,
  type HandlerOverrides,
} from "./testing";

const OWNER = "owner";
const RECIPIENT = "recipient";
const WORKSPACE = "workspace-links";
const OTHER_WORKSPACE = "workspace-links-other";

afterEach(closeTestStorages);

describe("recoverable owner link URLs", () => {
  it("uses random authenticated seals bound to both row identities and the relay key", () => {
    const sealed = sealLinkBearer("bearer", LINK_KEY, "credential", "grant");
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/u);
    expect(sealLinkBearer("bearer", LINK_KEY, "credential", "grant")).not.toBe(sealed);
    expect(unsealLinkBearer(sealed, LINK_KEY, "credential", "grant")).toBe("bearer");
    expect(unsealLinkBearer(sealed, LINK_KEY, "another", "grant")).toBeNull();
    expect(unsealLinkBearer(sealed, LINK_KEY, "credential", "another")).toBeNull();
    expect(unsealLinkBearer(sealed, "another-key", "credential", "grant")).toBeNull();
  });

  it("returns null for legacy, retired, corrupted, and transplanted seals", async () => {
    const storage = await newStorage(),
      h = handler(storage);
    await seedFileShare(h);
    const first = await createLink(h),
      second = await createLink(h);
    const firstId = String(first.grantId),
      secondId = String(second.grantId);
    const credential = storage.getCurrentLinkCredential(firstId)!;
    expect(credential.secretSealed).toEqual(expect.any(String));
    expect(credential.secretSealed).not.toContain(linkSecret(first.url));
    const db = inspectDatabase(storagePath(storage));
    try {
      db.prepare("UPDATE sync_relay_link_credentials SET secret_sealed = ? WHERE grant_id = ?").run(
        credential.secretSealed,
        secondId,
      );
      expect((await ownerLinkInventoryRow(h, secondId)).url).toBeNull();
      const parts = credential.secretSealed!.split(".");
      const encrypted = Buffer.from(parts[2]!, "base64url");
      encrypted[0] = encrypted[0]! ^ 1;
      parts[2] = encrypted.toString("base64url");
      db.prepare("UPDATE sync_relay_link_credentials SET secret_sealed = ? WHERE grant_id = ?").run(
        parts.join("."),
        firstId,
      );
      expect((await ownerLinkInventoryRow(h, firstId)).url).toBeNull();
      db.prepare(
        "UPDATE sync_relay_link_credentials SET secret_sealed = NULL WHERE grant_id = ?",
      ).run(firstId);
      expect((await ownerLinkInventoryRow(h, firstId)).url).toBeNull();
      db.prepare(
        "UPDATE sync_relay_link_credentials SET secret_sealed = ?, retired_at_ms = 3000 WHERE grant_id = ?",
      ).run(credential.secretSealed, firstId);
      expect((await ownerLinkInventoryRow(h, firstId)).url).toBeNull();
    } finally {
      db.close();
    }
  });

  it("denies URLs to recipients, anonymous callers, and link capability holders", async () => {
    const storage = await newStorage(),
      h = handler(storage);
    await seedFileShare(h);
    const created = await createLink(h);
    for (const userId of [RECIPIENT, null]) {
      const response = await h(request(userId, `/sync/${WORKSPACE}/shares/links`));
      expect(response.status).toBe(userId ? 404 : 401);
      expect(await response.text()).not.toContain(String(created.url));
    }
    const bearer = Buffer.alloc(32, 9).toString("base64url");
    seedLinkSession(storage, { grantId: String(created.grantId), capabilityHash: hmac(bearer) });
    const headers = { authorization: `LinkCapability ${bearer}` };
    expect((await h(request(null, `/sync/${WORKSPACE}/shares/links`, { headers }))).status).toBe(
      401,
    );
    const linkSummary = await h(request(null, "/sync/link/share", { headers }));
    expect(linkSummary.status).toBe(200);
    expect(await linkSummary.text()).not.toContain('"url":');
    const recipient = await h(request(RECIPIENT, "/sync/shares?received=true"));
    expect(recipient.status).toBe(200);
    expect(await recipient.text()).not.toContain(String(created.url));
  });

  it("adds the nullable seal column to the previous credential schema without losing rows", async () => {
    const { storage, dbPath } = await newStorageWithPath();
    const h = handler(storage);
    await seedFileShare(h);
    const created = await createLink(h);
    closeTestStorage(storage);
    const db = inspectDatabase(dbPath);
    let before: Record<string, unknown>[];
    try {
      db.exec("ALTER TABLE sync_relay_link_credentials DROP COLUMN secret_sealed");
      db.prepare("DELETE FROM sync_relay_migrations WHERE migration_id = ?").run(
        "link-credential-seal-v1",
      );
      before = db.prepare("SELECT * FROM sync_relay_link_credentials").all();
      expect(
        db
          .prepare("PRAGMA table_info(sync_relay_link_credentials)")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "credential_id",
        "grant_id",
        "secret_hash",
        "generation",
        "minted_at_ms",
        "retired_at_ms",
      ]);
    } finally {
      db.close();
    }
    const reopened = reopenTestStorage(dbPath);
    expect(reopened.getCurrentLinkCredential(String(created.grantId))!.secretSealed).toBeNull();
    expect(
      (await ownerLinkInventoryRow(handler(reopened), String(created.grantId))).url,
    ).toBeNull();
    inspect(dbPath, (database) => {
      expect(database.prepare("SELECT * FROM sync_relay_link_credentials").all()).toEqual(
        before!.map((row) => ({ ...row, secret_sealed: null })),
      );
      expect(
        database
          .prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?")
          .get("link-credential-seal-v1"),
      ).toBeDefined();
    });
    closeTestStorage(reopened);
    expect(
      reopenTestStorage(dbPath).getCurrentLinkCredential(String(created.grantId))!.secretSealed,
    ).toBeNull();
  });
});

const newStorage = testStorage;

async function newStorageWithPath(
  options?: Parameters<typeof testStorage>[0],
): Promise<{ storage: SyncRelayStorage; dbPath: string }> {
  const storage = await testStorage(options);
  return { storage, dbPath: storagePath(storage) };
}

function handler(storage: SyncRelayStorage, overrides: HandlerOverrides = {}): SyncRelayHandler {
  return testHandler(storage, {
    newShareId: () => "share-existing",
    resolveUserIdByEmail: () => null,
    lookupUserEmail: undefined,
    lookupVerifiedUserEmail: undefined,
    ...overrides,
  });
}

async function seedFileShare(
  h: SyncRelayHandler,
  access: "view" | "comment" | "edit" = "view",
): Promise<void> {
  expect(
    (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
  ).toBe(200);
  expect(
    (
      await h(
        request(
          OWNER,
          `/sync/${WORKSPACE}/shares`,
          jsonBody({ recipientUserId: RECIPIENT, paths: ["docs"], access }),
        ),
      )
    ).status,
  ).toBe(200);
}

async function createLink(
  h: SyncRelayHandler,
  access: "view" | "comment" = "view",
): Promise<Record<string, unknown>> {
  const response = await h(
    request(OWNER, `/sync/${WORKSPACE}/shares/share-existing/links`, jsonBody({ access })),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return json(response);
}

function defaultStorageLinkSecret(grantId: string): string {
  return hmac(grantId);
}

function seedStorageLink(
  storage: SyncRelayStorage,
  input: {
    grantId: string;
    access: "view" | "comment" | "edit";
    createdAtMs?: number;
    secret?: string;
    shareId?: string;
  },
): void {
  seedLinkGrant(storage, {
    ...input,
    shareId: input.shareId ?? "share-existing",
    secretSealed: null,
    secretHash: hmac(input.secret ?? defaultStorageLinkSecret(input.grantId)),
  });
}

async function ownerLinkInventory(h: SyncRelayHandler): Promise<Array<Record<string, unknown>>> {
  const response = await h(request(OWNER, `/sync/${WORKSPACE}/shares/links`));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return (await json(response)).links as Array<Record<string, unknown>>;
}

async function ownerLinkInventoryRow(
  h: SyncRelayHandler,
  grantId: string,
): Promise<Record<string, unknown>> {
  const row = (await ownerLinkInventory(h)).find((candidate) => candidate.grantId === grantId);
  expect(row).toBeDefined();
  return row!;
}

function projectedDependentIds(body: Record<string, unknown>): string[] {
  return ((body.dependents ?? []) as Array<Record<string, unknown>>).map((row) =>
    String(row.grantId),
  );
}

function hmac(secret: string): string {
  return hashLinkBearer(secret, LINK_KEY);
}

describe("atomic View and Comment link mint", () => {
  it("creates one View file share, one link grant, and one hashed credential", async () => {
    const { storage, dbPath } = await newStorageWithPath();
    const h = handler(storage);
    expect(
      (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
    ).toBe(200);

    const response = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/links`,
        jsonBody({ paths: ["docs"], access: "view" }),
      ),
    );
    expect(response.status).toBe(200);
    const serialized = await response.text();
    const created = JSON.parse(serialized) as Record<string, unknown>;
    const secret = linkSecret(created.url);

    expect(created).toMatchObject({
      ok: true,
      shareId: "share-existing",
      workspaceId: WORKSPACE,
      selector: { paths: ["docs"], versionId: null },
      principalKind: "link",
      access: "view",
      generation: 1,
      status: "active",
      revokedAtMs: null,
      parentGrantId: null,
    });
    expect(created).not.toHaveProperty("secret");
    expect(created).not.toHaveProperty("recipientUserId");
    expect(created).not.toHaveProperty("recipientEmail");
    expect(serialized.split(secret)).toHaveLength(2);

    const grantId = String(created.grantId);
    expect(storage.getShare("share-existing")).toMatchObject({
      workspaceId: WORKSPACE,
      granterUserId: OWNER,
    });
    expect(storage.getShareGrant(grantId)).toMatchObject({
      principalKind: "link",
      principalUserId: null,
      principalEmail: null,
      access: "view",
      generation: 1,
    });
    expect(storage.getCurrentLinkCredential(grantId)).toMatchObject({
      generation: 1,
      secretSealed: expect.any(String),
      secretHash: hmac(secret),
      retiredAtMs: null,
    });
    expect(storage.listSharesGrantedBy(OWNER)).toHaveLength(1);
    expect(storage.listSharesGrantedBy(OWNER)[0]?.grant.principalKind).toBe("link");

    const inspection = inspectDatabase(dbPath, { readOnly: true });
    try {
      expect(
        inspection.prepare("SELECT COUNT(*) AS count FROM sync_relay_shares").get()?.count,
      ).toBe(1);
      expect(
        inspection.prepare("SELECT COUNT(*) AS count FROM sync_relay_share_grants").get()?.count,
      ).toBe(1);
      expect(
        inspection.prepare("SELECT COUNT(*) AS count FROM sync_relay_link_credentials").get()
          ?.count,
      ).toBe(1);
      expect(
        inspection
          .prepare(
            "SELECT COUNT(*) AS count FROM sync_relay_share_grants WHERE principal_kind <> 'link'",
          )
          .get()?.count,
      ).toBe(0);
    } finally {
      inspection.close();
    }
  });

  it("rolls back the share and grant when the credential insert fails", async () => {
    const storage = await newStorage();
    expect(
      storage.claimWorkspace({ workspaceId: WORKSPACE, ownerUserId: OWNER, createdAtMs: 1 }),
    ).toBe("created");
    storage.createShare({
      share: {
        shareId: "seed-share",
        workspaceId: WORKSPACE,
        granterUserId: OWNER,
        selectorJson: JSON.stringify({ paths: ["seed"], versionId: null }),
        createdAtMs: 1,
      },
      grant: {
        grantId: "seed-user-grant",
        shareId: "seed-share",
        principalKind: "user",
        principalUserId: RECIPIENT,
        principalEmail: null,
        access: "view",
        generation: 1,
        status: "active",
        createdAtMs: 1,
        revokedAtMs: null,
        parentGrantId: null,
      },
    });
    expect(
      storage.createLinkGrant({
        grant: {
          grantId: "seed-link-grant",
          shareId: "seed-share",
          principalKind: "link",
          principalUserId: null,
          principalEmail: null,
          access: "view",
          generation: 1,
          status: "active",
          createdAtMs: 1,
          revokedAtMs: null,
          parentGrantId: null,
        },
        credential: {
          credentialId: "seed-credential",
          grantId: "seed-link-grant",
          secretSealed: null,
          secretHash: hmac("s".repeat(43)),
          generation: 1,
          mintedAtMs: 1,
          retiredAtMs: null,
        },
      }),
    ).toBe(true);

    expect(() =>
      storage.createFileLinkShare({
        share: {
          shareId: "rolled-back-share",
          workspaceId: WORKSPACE,
          granterUserId: OWNER,
          selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }),
          createdAtMs: 2,
        },
        grant: {
          grantId: "rolled-back-grant",
          shareId: "rolled-back-share",
          principalKind: "link",
          principalUserId: null,
          principalEmail: null,
          access: "view",
          generation: 1,
          status: "active",
          createdAtMs: 2,
          revokedAtMs: null,
          parentGrantId: null,
        },
        credential: {
          credentialId: "seed-credential",
          grantId: "rolled-back-grant",
          secretSealed: null,
          secretHash: hmac("s".repeat(43)),
          generation: 1,
          mintedAtMs: 2,
          retiredAtMs: null,
        },
        guard: () => undefined,
      }),
    ).toThrow();
    expect(storage.getShare("rolled-back-share")).toBeNull();
    expect(storage.getShareGrant("rolled-back-grant")).toBeNull();
    expect(storage.getCurrentLinkCredential("rolled-back-grant")).toBeNull();
  });

  it("rechecks ownership inside the transaction and rolls back on refusal", async () => {
    const storage = await newStorage();
    const ownershipAnswers = [true, false];
    const guardedStorage = interceptStorage(storage, {
      workspaceIsOwnedBy: () => ownershipAnswers.shift() ?? false,
    });
    expect(
      storage.claimWorkspace({ workspaceId: WORKSPACE, ownerUserId: OWNER, createdAtMs: 1 }),
    ).toBe("created");
    const response = await handler(guardedStorage)(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/links`,
        jsonBody({ paths: ["docs"], access: "view" }),
      ),
    );
    expect(response.status).toBe(404);
    expect(ownershipAnswers).toEqual([]);
    expect(storage.getShare("share-existing")).toBeNull();
    expect(storage.listSharesGrantedBy(OWNER)).toEqual([]);
  });
});

describe("owner link contract", () => {
  it.each([
    ["view", "comment", true],
    ["view", "edit", true],
    ["comment", "edit", true],
    ["comment", "view", false],
    ["edit", "comment", false],
    ["edit", "view", false],
  ] as const)(
    "storage %s to %s rotates credentials only when widening",
    async (from, access, widening) => {
      const storage = await newStorage();
      await seedFileShare(handler(storage));
      const grantId = "rank-transition";
      const original = {
        credentialId: "rank-original",
        grantId,
        secretSealed: null,
        secretHash: hmac("o".repeat(43)),
        generation: 1,
        mintedAtMs: 2000,
        retiredAtMs: null,
      };
      expect(
        storage.createLinkGrant({
          grant: {
            grantId,
            shareId: "share-existing",
            principalKind: "link",
            principalUserId: null,
            principalEmail: null,
            access: from,
            generation: 1,
            status: "active",
            createdAtMs: 2000,
            revokedAtMs: null,
            parentGrantId: null,
          },
          credential: original,
        }),
      ).toBe(true);
      const mintCredential = vi.fn(() => ({
        credentialId: "rank-replacement",
        secretSealed: null,
        secretHash: hmac("n".repeat(43)),
      }));
      const input = {
        shareId: "share-existing",
        grantId,
        access,
        changedAtMs: 3000,
        expectedDependentGrantIds: [],
        guard: () => undefined,
      };
      expect(
        storage.retuneShareGrant({ ...input, ...(widening ? {} : { mintCredential }) }),
      ).toEqual({ ok: false });
      expect(mintCredential).not.toHaveBeenCalled();
      expect(storage.getShareGrant(grantId)).toMatchObject({ access: from, generation: 1 });
      expect(storage.getCurrentLinkCredential(grantId)).toEqual(original);
      expect(
        storage.retuneShareGrant({ ...input, ...(widening ? { mintCredential } : {}) }),
      ).toMatchObject({ ok: true });
      expect(storage.getShareGrant(grantId)).toMatchObject({
        access,
        generation: widening ? 2 : 1,
      });
      expect(mintCredential).toHaveBeenCalledTimes(widening ? 1 : 0);
      expect(storage.getCurrentLinkCredential(grantId)).toMatchObject(
        widening ? { credentialId: "rank-replacement", generation: 2 } : original,
      );
    },
  );

  it("does not expose a minted URL or fragment through errors or diagnostics", async () => {
    const storage = await newStorage();
    const shareIds = ["first-atomic-share", "failed-atomic-share"];
    const fixedSecret = "q".repeat(43);
    const h = handler(storage, {
      newShareId: () => shareIds.shift()!,
      newId: () => "duplicate-credential",
      newLinkBearer: () => fixedSecret,
    });
    await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })));
    const first = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/links`,
        jsonBody({ paths: ["first"], access: "view" }),
      ),
    );
    expect(first.status).toBe(200);
    const firstBody = await json(first);
    const completeUrl = String(firstBody.url);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failed = await h(
        request(
          OWNER,
          `/sync/${WORKSPACE}/shares/links`,
          jsonBody({ paths: ["second"], access: "view" }),
        ),
      );
      expect(failed.status).toBe(500);
      const errorBody = await failed.text();
      const diagnostics = errorSpy.mock.calls.flat().map(String).join("\n");
      expect(errorBody).not.toContain(completeUrl);
      expect(errorBody).not.toContain(fixedSecret);
      expect(diagnostics).not.toContain(completeUrl);
      expect(diagnostics).not.toContain(fixedSecret);
      expect(storage.getShare("failed-atomic-share")).toBeNull();
      expect(storage.listSharesGrantedBy(OWNER)).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("binds retune, named promotion, and named revoke to the requested workspace", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h, "edit");
    expect(
      storage.claimWorkspace({
        workspaceId: OTHER_WORKSPACE,
        ownerUserId: OWNER,
        createdAtMs: 2_001,
      }),
    ).toBe("created");

    for (const grantId of [
      "link-retune-missing-workspace",
      "link-retune-wrong-workspace",
      "link-retune-correct-workspace",
      "link-named-workspace-parent",
    ]) {
      seedStorageLink(storage, { grantId, access: "comment" });
    }
    for (const grantId of [
      "named-promote-missing-workspace",
      "named-promote-wrong-workspace",
      "named-promote-correct-workspace",
      "named-revoke-missing-workspace",
      "named-revoke-wrong-workspace",
      "named-revoke-correct-workspace",
    ]) {
      expect(
        seedDependentGrant(storage, {
          shareId: "share-existing",
          parentGrantId: "link-named-workspace-parent",
          grantId,
          principalUserId: `${grantId}-user`,
          createdAtMs: 2_002,
        }),
      ).toMatchObject({ ok: true });
    }

    const retuneShareGrant = vi.spyOn(storage, "retuneShareGrant");
    const retuneMissingBefore = storage.getShareGrant("link-retune-missing-workspace");
    const retuneMissing = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/links/link-retune-missing-workspace/retune",
        jsonBody({ access: "view", expectedDependentGrantIds: [] }),
      ),
    );
    expect(retuneMissing.status).toBe(400);
    expect(retuneShareGrant).not.toHaveBeenCalled();
    expect(storage.getShareGrant("link-retune-missing-workspace")).toEqual(retuneMissingBefore);

    const retuneWrongBefore = storage.getShareGrant("link-retune-wrong-workspace");
    const retuneWrong = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/links/link-retune-wrong-workspace/retune",
        jsonBody({
          workspaceId: OTHER_WORKSPACE,
          access: "view",
          expectedDependentGrantIds: [],
        }),
      ),
    );
    expect(await denialBytes(retuneWrong)).toContain('"code":"not_found"');
    expect(retuneShareGrant).not.toHaveBeenCalled();
    expect(storage.getShareGrant("link-retune-wrong-workspace")).toEqual(retuneWrongBefore);

    const retuneCorrect = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/links/link-retune-correct-workspace/retune",
        jsonBody({
          workspaceId: WORKSPACE,
          access: "view",
          expectedDependentGrantIds: [],
        }),
      ),
    );
    expect(retuneCorrect.status).toBe(200);
    expect(retuneShareGrant).toHaveBeenCalledTimes(1);
    expect(storage.getShareGrant("link-retune-correct-workspace")).toMatchObject({
      access: "view",
      status: "active",
    });

    const promoteShareGrant = vi.spyOn(storage, "promoteShareGrant");
    const promotionExpectation = {
      expectedParentGrantId: "link-named-workspace-parent",
      expectedParentGeneration: 1,
    };
    const promoteMissingBefore = storage.getShareGrant("named-promote-missing-workspace");
    const promoteMissing = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/grants/named-promote-missing-workspace/promote",
        jsonBody(promotionExpectation),
      ),
    );
    expect(promoteMissing.status).toBe(400);
    expect(promoteShareGrant).not.toHaveBeenCalled();
    expect(storage.getShareGrant("named-promote-missing-workspace")).toEqual(promoteMissingBefore);

    const promoteWrongBefore = storage.getShareGrant("named-promote-wrong-workspace");
    const promoteWrong = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/grants/named-promote-wrong-workspace/promote",
        jsonBody({ workspaceId: OTHER_WORKSPACE, ...promotionExpectation }),
      ),
    );
    expect(await denialBytes(promoteWrong)).toContain('"code":"not_found"');
    expect(promoteShareGrant).not.toHaveBeenCalled();
    expect(storage.getShareGrant("named-promote-wrong-workspace")).toEqual(promoteWrongBefore);

    const promoteCorrect = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/grants/named-promote-correct-workspace/promote",
        jsonBody({ workspaceId: WORKSPACE, ...promotionExpectation }),
      ),
    );
    expect(promoteCorrect.status).toBe(200);
    expect(promoteShareGrant).toHaveBeenCalledTimes(1);
    expect(storage.getShareGrant("named-promote-correct-workspace")).toMatchObject({
      generation: 2,
      parentGrantId: null,
    });

    const revokeShareGrant = vi.spyOn(storage, "removeShareAccess");
    const revokeMissingBefore = storage.getShareGrant("named-revoke-missing-workspace");
    const revokeMissing = await h(
      request(OWNER, "/sync/shares/share-existing/grants/named-revoke-missing-workspace/revoke", {
        method: "POST",
      }),
    );
    expect(revokeMissing.status).toBe(400);
    expect(revokeShareGrant).not.toHaveBeenCalled();
    expect(storage.getShareGrant("named-revoke-missing-workspace")).toEqual(revokeMissingBefore);

    const revokeWrongBefore = storage.getShareGrant("named-revoke-wrong-workspace");
    const revokeWrong = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/grants/named-revoke-wrong-workspace/revoke",
        jsonBody({ workspaceId: OTHER_WORKSPACE }),
      ),
    );
    expect(await denialBytes(revokeWrong)).toContain('"code":"not_found"');
    expect(revokeShareGrant).not.toHaveBeenCalled();
    expect(storage.getShareGrant("named-revoke-wrong-workspace")).toEqual(revokeWrongBefore);

    const revokeCorrect = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/grants/named-revoke-correct-workspace/revoke",
        jsonBody({ workspaceId: WORKSPACE }),
      ),
    );
    expect(revokeCorrect.status).toBe(200);
    expect(revokeShareGrant).toHaveBeenCalledTimes(1);
    expect(storage.getShareGrant("named-revoke-correct-workspace")).toMatchObject({
      generation: 2,
      status: "revoked",
      revokedAtMs: 2_000,
    });
  });
});

describe("owner link inventory and impact preconditions", () => {
  it.each(["rotate"] as ("rotate" | "retune" | "revoke")[])(
    "refuses a stale confirmation after conversion before %s, then accepts the fresh set",
    async (operation) => {
      const storage = await newStorage();
      const bearer = vi.fn(() => "r".repeat(43));
      const h = handler(storage, {
        lookupUserEmail: (userId) => `${userId}@example.test`,
        newLinkBearer: bearer,
      });
      await seedFileShare(h, "edit");
      let grantId: string;
      if (operation === "retune") {
        grantId = "link-race-retune";
        seedStorageLink(storage, { grantId, access: "comment" });
      } else {
        grantId = String((await createLink(h)).grantId);
      }
      const shown = (await ownerLinkInventory(h)).find((row) => row.grantId === grantId)!;
      expect(projectedDependentIds(shown)).toEqual([]);
      expect(
        seedDependentGrant(storage, {
          shareId: "share-existing",
          parentGrantId: grantId,
          grantId: `dependent-race-${operation}`,
          principalUserId: `user-race-${operation}`,
          createdAtMs: 2_002,
        }),
      ).toMatchObject({ ok: true });
      const beforeGrant = storage.getShareGrant(grantId);
      const beforeCredential = storage.getCurrentLinkCredential(grantId);
      const bearerCalls = bearer.mock.calls.length;
      const staleIds = projectedDependentIds(shown);
      const response =
        operation === "rotate"
          ? await h(
              request(
                OWNER,
                `/sync/shares/share-existing/links/${grantId}/rotate`,
                jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: staleIds }),
              ),
            )
          : operation === "retune"
            ? await h(
                request(
                  OWNER,
                  `/sync/shares/share-existing/links/${grantId}/retune`,
                  jsonBody({
                    workspaceId: WORKSPACE,
                    access: "view",
                    expectedDependentGrantIds: staleIds,
                  }),
                ),
              )
            : await h(
                request(
                  OWNER,
                  "/sync/shares/share-existing/revoke",
                  jsonBody({
                    grantId,
                    workspaceId: WORKSPACE,
                    expectedDependentGrantIds: staleIds,
                  }),
                ),
              );
      expect(response.status).toBe(409);
      const conflictText = await response.text();
      const conflict = JSON.parse(conflictText) as Record<string, unknown>;
      expect(conflict).toMatchObject({
        ok: false,
        code: "dependents_changed",
        dependents: [
          {
            grantId: `dependent-race-${operation}`,
            recipientUserId: `user-race-${operation}`,
            recipientEmail: `user-race-${operation}@example.test`,
            access: operation === "retune" ? "comment" : "view",
            generation: 1,
            createdAtMs: 2_002,
          },
        ],
      });
      expect(conflictText).not.toContain("secret");
      expect(conflictText).not.toContain("url");
      expect(conflictText).not.toContain("credential");
      expect(storage.getShareGrant(grantId)).toEqual(beforeGrant);
      expect(storage.getCurrentLinkCredential(grantId)).toEqual(beforeCredential);
      expect(bearer).toHaveBeenCalledTimes(bearerCalls);

      const freshIds = projectedDependentIds(conflict);
      const retry =
        operation === "rotate"
          ? await h(
              request(
                OWNER,
                `/sync/shares/share-existing/links/${grantId}/rotate`,
                jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: freshIds }),
              ),
            )
          : operation === "retune"
            ? await h(
                request(
                  OWNER,
                  `/sync/shares/share-existing/links/${grantId}/retune`,
                  jsonBody({
                    workspaceId: WORKSPACE,
                    access: "view",
                    expectedDependentGrantIds: freshIds,
                  }),
                ),
              )
            : await h(
                request(
                  OWNER,
                  "/sync/shares/share-existing/revoke",
                  jsonBody({
                    grantId,
                    workspaceId: WORKSPACE,
                    expectedDependentGrantIds: freshIds,
                  }),
                ),
              );
      expect(retry.status).toBe(200);
    },
  );

  it("gives non-owners and former owners the byte-identical generic 404", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    await createLink(h);
    const missing = await denialBytes(
      await h(request(OWNER, "/sync/workspace-missing/shares/links")),
    );
    expect(
      await denialBytes(await h(request("not-owner", `/sync/${WORKSPACE}/shares/links`))),
    ).toBe(missing);
    expect(
      await denialBytes(
        await h(request("not-owner", `/sync/${WORKSPACE}/shares/links?cursor=not-json`)),
      ),
    ).toBe(missing);
    expect(
      await denialBytes(
        await h(
          request("not-owner", `/sync/${WORKSPACE}/shares/links?independentGrantCursor=not-json`),
        ),
      ),
    ).toBe(missing);

    const formerOwnerStorage = interceptStorage(storage, { workspaceIsOwnedBy: () => false });
    expect(
      await denialBytes(
        await handler(formerOwnerStorage)(request(OWNER, `/sync/${WORKSPACE}/shares/links`)),
      ),
    ).toBe(missing);
  });

  it.each(["rotate", "retune", "revoke"] as const)(
    "returns a generic 404 when ownership is lost during the %s dependent lookup",
    async (operation) => {
      const { storage, dbPath } = await newStorageWithPath();
      await seedFileShare(handler(storage), "edit");
      const grantId = `link-lookup-${operation}`;
      const dependentGrantId = `dependent-lookup-${operation}`;
      const recipientUserId = `lookup-recipient-${operation}`;
      seedStorageLink(storage, { grantId, access: "view" });
      expect(
        seedDependentGrant(storage, {
          shareId: "share-existing",
          parentGrantId: grantId,
          grantId: dependentGrantId,
          principalUserId: recipientUserId,
          createdAtMs: 2_002,
        }),
      ).toMatchObject({ ok: true });
      const beforeGrant = storage.getShareGrant(grantId);
      const beforeDependent = storage.getShareGrant(dependentGrantId);
      const beforeCredential = storage.getCurrentLinkCredential(grantId);
      const missing = await denialBytes(
        await handler(storage)(request(OWNER, "/sync/shares/share-missing")),
      );
      let markLookupStarted!: () => void;
      const lookupStarted = new Promise<void>((resolve) => {
        markLookupStarted = resolve;
      });
      let releaseLookup!: () => void;
      const lookupGate = new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });
      const lookupUserEmail = vi.fn(async (userId: string) => {
        markLookupStarted();
        await lookupGate;
        return `${userId}@example.test`;
      });
      const newLinkBearer = vi.fn(() => "r".repeat(43));
      const h = handler(storage, { lookupUserEmail, newLinkBearer });
      const route =
        operation === "revoke"
          ? "/sync/shares/share-existing/revoke"
          : `/sync/shares/share-existing/links/${grantId}/${operation}`;
      const pending = h(
        request(
          OWNER,
          route,
          jsonBody({
            workspaceId: WORKSPACE,
            expectedDependentGrantIds: [],
            ...(operation === "retune" ? { access: "comment" } : {}),
            ...(operation === "revoke" ? { grantId } : {}),
          }),
        ),
      );
      await lookupStarted;
      try {
        expect(lookupUserEmail).toHaveBeenCalledExactlyOnceWith(recipientUserId);
        const database = inspectDatabase(dbPath);
        try {
          database
            .prepare("UPDATE sync_relay_workspaces SET owner_user_id = ? WHERE workspace_id = ?")
            .run("new-owner", WORKSPACE);
        } finally {
          database.close();
        }
        expect(storage.workspaceIsOwnedBy(WORKSPACE, OWNER)).toBe(false);
      } finally {
        releaseLookup();
      }

      expect(await denialBytes(await pending)).toBe(missing);
      expect(storage.getShareGrant(grantId)).toEqual(beforeGrant);
      expect(storage.getShareGrant(dependentGrantId)).toEqual(beforeDependent);
      expect(storage.getCurrentLinkCredential(grantId)).toEqual(beforeCredential);
      expect(newLinkBearer).not.toHaveBeenCalled();
    },
  );

  it("refuses link revocation by the former owner after ownership transfer", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const grantId = String((await createLink(h)).grantId);
    expect(
      seedDependentGrant(storage, {
        shareId: "share-existing",
        parentGrantId: grantId,
        grantId: "dependent-former-owner",
        principalUserId: "former-owner-dependent",
        createdAtMs: 2_002,
      }),
    ).toMatchObject({ ok: true });
    const before = {
      share: storage.getShare("share-existing"),
      grants: storage.listSharesGrantedBy(OWNER),
      links: storage.listLinkGrantsByWorkspace(WORKSPACE),
      credential: storage.getCurrentLinkCredential(grantId),
    };
    const revokeShareGrant = vi.fn(storage.revokeShareGrant.bind(storage));
    const transferredStorage = interceptStorage(storage, {
      workspaceIsOwnedBy: () => false,
      revokeShareGrant: (_target, input) => revokeShareGrant(input),
    });
    const transferredHandler = handler(transferredStorage);
    const missing = await denialBytes(
      await transferredHandler(
        request(
          OWNER,
          "/sync/shares/share-missing/revoke",
          jsonBody({
            grantId,
            workspaceId: WORKSPACE,
            expectedDependentGrantIds: "must-not-be-parsed",
          }),
        ),
      ),
    );
    const nonGranter = await transferredHandler(
      request(
        "not-granter",
        "/sync/shares/share-existing/revoke",
        jsonBody({
          grantId,
          workspaceId: WORKSPACE,
          expectedDependentGrantIds: "must-not-be-parsed",
        }),
      ),
    );
    expect(await denialBytes(nonGranter)).toBe(missing);
    const formerOwner = await transferredHandler(
      request(
        OWNER,
        "/sync/shares/share-existing/revoke",
        jsonBody({
          grantId,
          workspaceId: WORKSPACE,
          expectedDependentGrantIds: ["dependent-former-owner"],
        }),
      ),
    );
    expect(await denialBytes(formerOwner)).toBe(missing);
    const malformedFormerOwner = await transferredHandler(
      request(
        OWNER,
        "/sync/shares/share-existing/revoke",
        jsonBody({
          grantId,
          workspaceId: WORKSPACE,
          expectedDependentGrantIds: "must-not-be-parsed",
        }),
      ),
    );
    expect(await denialBytes(malformedFormerOwner)).toBe(missing);
    expect(revokeShareGrant).not.toHaveBeenCalled();
    expect(storage.getShareGrant(grantId)).toMatchObject({ status: "active" });
    expect(storage.getShareGrant("dependent-former-owner")).toMatchObject({
      status: "active",
    });
    expect({
      share: storage.getShare("share-existing"),
      grants: storage.listSharesGrantedBy(OWNER),
      links: storage.listLinkGrantsByWorkspace(WORKSPACE),
      credential: storage.getCurrentLinkCredential(grantId),
    }).toEqual(before);
  });
});

describe("durable link usage inventory", () => {
  it("keeps links distinct and survives eviction, expired-session sweep, and close/reopen", async () => {
    const { storage, dbPath } = await newStorageWithPath({ linkSessionsPerGrantLimit: 1 });
    let now = 2_000;
    const h = handler(storage, { nowMs: () => now });
    await seedFileShare(h);
    const first = await createLink(h);
    const second = await createLink(h);
    const firstGrantId = String(first.grantId);
    const secondGrantId = String(second.grantId);

    now = 3_000;
    expect(
      (await h(request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(first.url) }))))
        .status,
    ).toBe(200);
    expect(await ownerLinkInventoryRow(h, firstGrantId)).toMatchObject({ lastUsedAtMs: 3_000 });
    expect(await ownerLinkInventoryRow(h, secondGrantId)).toMatchObject({ lastUsedAtMs: null });

    expect(
      storage.mintLinkSession({
        session: {
          sessionId: "usage-eviction-session",
          capabilityHash: hmac("usage-eviction-capability"),
          grantId: firstGrantId,
          generation: 1,
          mintedAtMs: 3_100,
          expiresAtMs: 5_000,
        },
      }),
    ).toBe(true);
    expect(await ownerLinkInventoryRow(h, firstGrantId)).toMatchObject({ lastUsedAtMs: 3_100 });

    const sweepAtMs = 5_000 + LINK_SESSION_RENEWAL_GRACE_MS + 1;
    expect(
      storage.mintLinkSession({
        session: {
          sessionId: "usage-sweep-trigger",
          capabilityHash: hmac("usage-sweep-capability"),
          grantId: secondGrantId,
          generation: 1,
          mintedAtMs: sweepAtMs,
          expiresAtMs: sweepAtMs + LINK_SESSION_TTL_MS,
        },
      }),
    ).toBe(true);
    expect(storage.findLinkSessionByCapabilityHash(hmac("usage-eviction-capability"))).toBeNull();
    expect(await ownerLinkInventoryRow(h, firstGrantId)).toMatchObject({ lastUsedAtMs: 3_100 });

    closeTestStorage(storage);
    const reopened = reopenTestStorage(dbPath, { linkSessionsPerGrantLimit: 1 });
    const reopenedHandler = handler(reopened);
    expect(await ownerLinkInventoryRow(reopenedHandler, firstGrantId)).toMatchObject({
      lastUsedAtMs: 3_100,
    });
    expect(await ownerLinkInventoryRow(reopenedHandler, secondGrantId)).toMatchObject({
      lastUsedAtMs: sweepAtMs,
    });
  });
});

describe("relay link grants", () => {
  it("conforms to every accepted state-machine transition", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);

    expect(storage.getShareGrant("grant-0")).toMatchObject({
      principalKind: "user",
      generation: 1,
      status: "active",
      parentGrantId: null,
    });
    storage.createShare({
      share: {
        shareId: "share-email",
        workspaceId: WORKSPACE,
        granterUserId: OWNER,
        selectorJson: JSON.stringify({ paths: ["email-docs"], versionId: null }),
        createdAtMs: 2_000,
      },
      grant: {
        grantId: "grant-email",
        shareId: "share-email",
        principalKind: "email",
        principalUserId: null,
        principalEmail: "invitee@example.test",
        access: "view",
        generation: 1,
        status: "active",
        createdAtMs: 2_000,
        revokedAtMs: null,
        parentGrantId: null,
      },
    });
    expect(storage.getShareGrant("grant-email")).toMatchObject({
      principalKind: "email",
      generation: 1,
      status: "active",
    });

    // Higher link levels remain a storage state-machine concern.
    const linkGrantId = "storage-seeded-edit-link";
    const firstSecret = Buffer.alloc(32, 1).toString("base64url");
    expect(
      storage.createLinkGrant({
        grant: {
          grantId: linkGrantId,
          shareId: "share-existing",
          principalKind: "link",
          principalUserId: null,
          principalEmail: null,
          access: "edit",
          generation: 1,
          status: "active",
          createdAtMs: 2_000,
          revokedAtMs: null,
          parentGrantId: null,
        },
        credential: {
          credentialId: "storage-seeded-edit-credential",
          grantId: linkGrantId,
          secretSealed: null,
          secretHash: hmac(firstSecret),
          generation: 1,
          mintedAtMs: 2_000,
          retiredAtMs: null,
        },
      }),
    ).toBe(true);
    const firstCredential = storage.getCurrentLinkCredential(linkGrantId)!;
    expect(Buffer.from(firstSecret, "base64url")).toHaveLength(32);
    expect(firstCredential).toMatchObject({ generation: 1, retiredAtMs: null });
    expect(firstCredential.secretHash).toBe(hmac(firstSecret));
    expect(firstCredential.secretHash).not.toContain(firstSecret);

    const converted = seedDependentGrant(storage, {
      shareId: "share-existing",
      parentGrantId: linkGrantId,
      grantId: "grant-dependent",
      principalUserId: "converted-user",
      createdAtMs: 2_001,
    });
    expect(converted).toMatchObject({
      ok: true,
      grant: {
        access: "edit",
        generation: 1,
        parentGrantId: linkGrantId,
      },
    });

    expect(
      storage.retuneShareGrant({
        shareId: "share-existing",
        grantId: linkGrantId,
        access: "comment",
        changedAtMs: 2_001,
        expectedDependentGrantIds: ["grant-dependent"],
        guard: () => undefined,
      }),
    ).toMatchObject({ ok: true, grant: { access: "comment", generation: 1 } });
    expect(storage.getShareGrant(linkGrantId)).toMatchObject({
      access: "comment",
      generation: 1,
    });
    expect(storage.getCurrentLinkCredential(linkGrantId)).toMatchObject({
      credentialId: firstCredential.credentialId,
      generation: 1,
      retiredAtMs: null,
    });
    expect(storage.getShareGrant("grant-dependent")).toMatchObject({
      access: "comment",
      generation: 2,
    });
    const commentExchange = await h(
      request(null, "/sync/link-exchange", jsonBody({ secret: firstSecret })),
    );
    expect(commentExchange.status).toBe(200);
    expect(await json(commentExchange)).toMatchObject({
      grantId: linkGrantId,
      access: "comment",
      generation: 1,
      effectiveSelector: { access: "comment" },
    });

    const widenedSecret = Buffer.alloc(32, 2).toString("base64url");
    expect(
      storage.retuneShareGrant({
        shareId: "share-existing",
        grantId: linkGrantId,
        access: "edit",
        changedAtMs: 2_002,
        expectedDependentGrantIds: ["grant-dependent"],
        guard: () => undefined,
        mintCredential: () => ({
          credentialId: "storage-widened-credential",
          secretSealed: null,
          secretHash: hmac(widenedSecret),
        }),
      }),
    ).toMatchObject({ ok: true, grant: { access: "edit", generation: 2 } });
    expect(widenedSecret).not.toBe(firstSecret);
    expect(storage.getShareGrant(linkGrantId)).toMatchObject({ access: "edit", generation: 2 });
    expect(storage.getShareGrant("grant-dependent")).toMatchObject({
      access: "comment",
      generation: 3,
    });
    expect(
      await denialBytes(
        await h(request(null, "/sync/link-exchange", jsonBody({ secret: firstSecret }))),
      ),
    ).toContain("404:");
    expect(
      (await h(request(null, "/sync/link-exchange", jsonBody({ secret: widenedSecret })))).status,
    ).toBe(404);

    const rotatedSecret = Buffer.alloc(32, 3).toString("base64url");
    expect(
      storage.rotateLinkGrant({
        shareId: "share-existing",
        grantId: linkGrantId,
        rotatedAtMs: 2_003,
        expectedDependentGrantIds: ["grant-dependent"],
        guard: () => undefined,
        mintCredential: () => ({
          credentialId: "storage-rotated-credential",
          secretSealed: null,
          secretHash: hmac(rotatedSecret),
        }),
      }),
    ).toMatchObject({ ok: true, grant: { access: "edit", generation: 3 } });
    expect(rotatedSecret).not.toBe(widenedSecret);
    expect(storage.getShareGrant(linkGrantId)).toMatchObject({ access: "edit", generation: 3 });
    expect(storage.getShareGrant("grant-dependent")).toMatchObject({ generation: 4 });

    expect(
      storage.promoteShareGrant({
        shareId: "share-existing",
        grantId: "grant-dependent",
        expectedParentGrantId: linkGrantId,
        expectedParentGeneration: 3,
        guard: () => undefined,
      }),
    ).toMatchObject({ ok: true, grant: { generation: 5, parentGrantId: null } });
    expect(
      seedDependentGrant(storage, {
        shareId: "share-existing",
        parentGrantId: linkGrantId,
        grantId: "grant-dependent-revoked",
        principalUserId: "dependent-revoked",
        createdAtMs: 2_002,
      }),
    ).toMatchObject({ ok: true, grant: { generation: 1, parentGrantId: linkGrantId } });

    const revokedResponse = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/revoke",
        jsonBody({
          grantId: linkGrantId,
          workspaceId: WORKSPACE,
          expectedDependentGrantIds: ["grant-dependent-revoked"],
        }),
      ),
    );
    expect(revokedResponse.status).toBe(200);
    expect(storage.getShareGrant(linkGrantId)).toMatchObject({
      status: "revoked",
      generation: 4,
      revokedAtMs: 2_000,
    });
    expect(storage.getCurrentLinkCredential(linkGrantId)).toBeNull();
    expect(storage.getShareGrant("grant-dependent-revoked")).toMatchObject({
      status: "revoked",
      generation: 2,
    });
    expect(storage.getShareGrant("grant-dependent")).toMatchObject({
      status: "active",
      generation: 5,
      parentGrantId: null,
    });

    const secondLink = await createLink(h);
    const thirdLink = await createLink(h);
    expect(secondLink.grantId).not.toBe(thirdLink.grantId);
    expect(
      (await h(request(OWNER, "/sync/shares/share-existing/revoke", { method: "POST" }))).status,
    ).toBe(200);
    for (const grantId of ["grant-0", "grant-dependent", secondLink.grantId, thirdLink.grantId]) {
      expect(storage.getShareGrant(String(grantId))).toMatchObject({ status: "revoked" });
    }
    expect(storage.getCurrentLinkCredential(String(secondLink.grantId))).toBeNull();
    expect(storage.getCurrentLinkCredential(String(thirdLink.grantId))).toBeNull();
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/shares/share-existing/links`,
            jsonBody({ access: "view" }),
          ),
        )
      ).status,
    ).toBe(404);
    expect(storage.getShare("share-existing")?.selectorJson).toBe(
      JSON.stringify({ paths: ["docs"], versionId: null }),
    );
  });

  it("refuses whole-share revocation by the former owner after ownership transfer", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const created = await createLink(h);
    const grantId = String(created.grantId);
    expect(
      seedDependentGrant(storage, {
        shareId: "share-existing",
        parentGrantId: grantId,
        grantId: "grant-dependent-after-owner-loss",
        principalUserId: "converted-user",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true });

    const before = {
      share: storage.getShare("share-existing"),
      grants: storage.listSharesGrantedBy(OWNER),
      linkGrant: storage.getShareGrant(grantId),
      dependentGrant: storage.getShareGrant("grant-dependent-after-owner-loss"),
      links: storage.listLinkGrantsByWorkspace(WORKSPACE),
      credential: storage.getCurrentLinkCredential(grantId),
    };
    const revokeShare = vi.fn(storage.revokeShare.bind(storage));
    const transferredStorage = interceptStorage(storage, {
      workspaceIsOwnedBy: () => false,
      revokeShare: (_target, ...args) => revokeShare(...args),
    });
    const transferredHandler = handler(transferredStorage);
    const missing = await denialBytes(
      await transferredHandler(
        request(OWNER, "/sync/shares/share-missing/revoke", { method: "POST" }),
      ),
    );
    const formerOwner = await transferredHandler(
      request(OWNER, "/sync/shares/share-existing/revoke", { method: "POST" }),
    );
    expect(await denialBytes(formerOwner)).toBe(missing);
    expect(revokeShare).not.toHaveBeenCalled();
    expect({
      share: storage.getShare("share-existing"),
      grants: storage.listSharesGrantedBy(OWNER),
      linkGrant: storage.getShareGrant(grantId),
      dependentGrant: storage.getShareGrant("grant-dependent-after-owner-loss"),
      links: storage.listLinkGrantsByWorkspace(WORKSPACE),
      credential: storage.getCurrentLinkCredential(grantId),
    }).toEqual(before);
  });

  it("refuses every invalid state-machine transition without changing records", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const created = await createLink(h);
    const linkGrantId = String(created.grantId);
    storage.createShare({
      share: {
        shareId: "share-email",
        workspaceId: WORKSPACE,
        granterUserId: OWNER,
        selectorJson: JSON.stringify({ paths: ["email-docs"], versionId: null }),
        createdAtMs: 2_000,
      },
      grant: {
        grantId: "grant-email",
        shareId: "share-email",
        principalKind: "email",
        principalUserId: null,
        principalEmail: "invitee@example.test",
        access: "view",
        generation: 1,
        status: "active",
        createdAtMs: 2_000,
        revokedAtMs: null,
        parentGrantId: null,
      },
    });

    const replacement = {
      rotatedAtMs: 2_100,
      expectedDependentGrantIds: [] as string[],
      mintCredential: () => ({
        credentialId: "credential-invalid-transition",
        secretSealed: null,
        secretHash: hmac("replacement"),
      }),
    };
    for (const grantId of ["grant-0", "grant-email"]) {
      expect(
        storage.rotateLinkGrant({
          shareId: grantId === "grant-0" ? "share-existing" : "share-email",
          grantId,
          ...replacement,
          guard: () => undefined,
        }),
      ).toEqual({ ok: false });
      expect(
        seedDependentGrant(storage, {
          shareId: grantId === "grant-0" ? "share-existing" : "share-email",
          parentGrantId: grantId,
          grantId: `converted-from-${grantId}`,
          principalUserId: "converted",
          createdAtMs: 2_100,
        }),
      ).toEqual({ ok: false });
      expect(
        storage.retuneShareGrant({
          shareId: grantId === "grant-0" ? "share-existing" : "share-email",
          grantId,
          access: "comment",
          changedAtMs: 2_100,
          expectedDependentGrantIds: [],
          guard: () => undefined,
        }),
      ).toEqual({ ok: false });
    }
    expect(
      storage.promoteShareGrant({
        shareId: "share-existing",
        grantId: linkGrantId,
        expectedParentGrantId: linkGrantId,
        expectedParentGeneration: 1,
        guard: () => undefined,
      }),
    ).toEqual({ ok: false });
    expect(
      storage.promoteShareGrant({
        shareId: "share-email",
        grantId: "grant-email",
        expectedParentGrantId: linkGrantId,
        expectedParentGeneration: 1,
        guard: () => undefined,
      }),
    ).toEqual({ ok: false });
    expect(
      storage.promoteShareGrant({
        shareId: "share-existing",
        grantId: "grant-0",
        expectedParentGrantId: linkGrantId,
        expectedParentGeneration: 1,
        guard: () => undefined,
      }),
    ).toEqual({ ok: false });
    expect(
      storage.retuneShareGrant({
        shareId: "share-existing",
        grantId: linkGrantId,
        access: "view",
        changedAtMs: 2_100,
        expectedDependentGrantIds: [],
        guard: () => undefined,
      }),
    ).toEqual({ ok: false });

    expect(
      seedDependentGrant(storage, {
        shareId: "share-existing",
        parentGrantId: linkGrantId,
        grantId: "grant-dependent",
        principalUserId: "converted",
        createdAtMs: 2_100,
      }),
    ).toMatchObject({ ok: true });
    expect(
      storage.retuneShareGrant({
        shareId: "share-existing",
        grantId: "grant-dependent",
        access: "edit",
        changedAtMs: 2_101,
        expectedDependentGrantIds: [],
        guard: () => undefined,
      }),
    ).toEqual({ ok: false });
    expect(storage.getShareGrant("grant-dependent")).toMatchObject({
      access: "view",
      generation: 1,
    });

    expect(
      storage.revokeShareGrant({
        shareId: "share-existing",
        grantId: linkGrantId,
        revokedAtMs: 2_102,
        expectedDependentGrantIds: ["grant-dependent"],
      }),
    ).toMatchObject({ ok: true });
    const revokedSnapshot = storage.getShareGrant(linkGrantId);
    expect(
      storage.rotateLinkGrant({
        shareId: "share-existing",
        grantId: linkGrantId,
        ...replacement,
        guard: () => undefined,
      }),
    ).toEqual({ ok: false });
    expect(
      storage.retuneShareGrant({
        shareId: "share-existing",
        grantId: linkGrantId,
        access: "comment",
        changedAtMs: 2_103,
        expectedDependentGrantIds: [],
        guard: () => undefined,
        mintCredential: replacement.mintCredential,
      }),
    ).toEqual({ ok: false });
    expect(
      storage.revokeShareGrant({
        shareId: "share-existing",
        grantId: linkGrantId,
        revokedAtMs: 2_104,
      }),
    ).toEqual({ ok: false });
    expect(
      seedDependentGrant(storage, {
        shareId: "share-existing",
        parentGrantId: linkGrantId,
        grantId: "converted-after-revoke",
        principalUserId: "converted",
        createdAtMs: 2_104,
      }),
    ).toEqual({ ok: false });
    expect(storage.getShareGrant(linkGrantId)).toEqual(revokedSnapshot);
    expect(
      storage.promoteShareGrant({
        shareId: "share-existing",
        grantId: "grant-dependent",
        expectedParentGrantId: linkGrantId,
        expectedParentGeneration: 2,
        guard: () => undefined,
      }),
    ).toEqual({ ok: false });
    expect(
      storage.retuneShareGrant({
        shareId: "share-existing",
        grantId: "grant-dependent",
        access: "comment",
        changedAtMs: 2_105,
        expectedDependentGrantIds: [],
        guard: () => undefined,
      }),
    ).toEqual({ ok: false });

    expect("expireShareGrant" in storage).toBe(false);
    expect("changeShareSelector" in storage).toBe(false);
  });

  it("exchanges a current secret for an HMAC-stored short-lived capability", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const created = await createLink(h);
    const secret = linkSecret(created.url);

    const response = await h(request(null, "/sync/link-exchange", jsonBody({ secret })));
    expect(response.status).toBe(200);
    const exchanged = await json(response);
    expect(exchanged).toMatchObject({
      ok: true,
      shareId: "share-existing",
      grantId: created.grantId,
      generation: 1,
      access: "view",
      effectiveSelector: {
        paths: ["docs"],
        versionId: null,
        access: "view",
      },
      capabilityExpiresAtMs: 2_000 + LINK_SESSION_TTL_MS,
    });
    const capabilityToken = String(exchanged.capabilityToken);
    expect(Buffer.from(capabilityToken, "base64url")).toHaveLength(32);
    const session = storage.findLinkSessionByCapabilityHash(hmac(capabilityToken));
    expect(session).toMatchObject({
      grantId: created.grantId,
      generation: 1,
      expiresAtMs: 2_000 + LINK_SESSION_TTL_MS,
    });
    expect(session?.capabilityHash).not.toContain(capabilityToken);
    expect(
      validateLinkCapability({
        publicEditRelease: undefined,
        storage,
        capabilityToken,
        linkKey: LINK_KEY,
        nowMs: 2_001,
      }),
    ).toMatchObject({
      shareId: "share-existing",
      grantId: created.grantId,
      generation: 1,
      access: "view",
    });
    expect(
      validateLinkCapability({
        publicEditRelease: undefined,
        storage,
        capabilityToken,
        linkKey: LINK_KEY,
        nowMs: 2_000 + LINK_SESSION_TTL_MS,
      }),
    ).toBeNull();
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/shares/share-existing/links/${String(created.grantId)}/rotate`,
            jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      validateLinkCapability({
        publicEditRelease: undefined,
        storage,
        capabilityToken,
        linkKey: LINK_KEY,
        nowMs: 2_001,
      }),
    ).toBeNull();

    const compare = vi.fn(timingSafeEqual);
    expect(constantTimeHashEqual(hmac(secret), hmac(secret), compare)).toBe(true);
    expect(compare).toHaveBeenCalledOnce();
  });

  it("refuses an in-grace refresh after rotation changes the generation", async () => {
    const storage = await newStorage();
    const relayExchangeKey = "share-web-relay-refresh-exchange-key";
    let now = 2_000;
    const h = handler(storage, { relayExchangeKey, nowMs: () => now });
    await seedFileShare(h);
    const created = await createLink(h);
    const exchangeResponse = await h(
      request(null, "/sync/link-exchange", {
        ...jsonBody({ secret: linkSecret(created.url) }),
        headers: {
          "content-type": "application/json",
          "x-dohc-relay-exchange-key": relayExchangeKey,
        },
      }),
    );
    expect(exchangeResponse.status).toBe(200);
    const exchanged = await json(exchangeResponse);
    now += LINK_SESSION_TTL_MS + 60 * 60 * 1_000;
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/shares/share-existing/links/${String(created.grantId)}/rotate`,
            jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
          ),
        )
      ).status,
    ).toBe(200);
    expect(storage.getShareGrant(String(created.grantId))).toMatchObject({
      status: "active",
      generation: 2,
    });

    const refused = await h(
      request(null, "/sync/link-refresh", {
        method: "POST",
        headers: {
          authorization: `LinkCapability ${String(exchanged.capabilityToken)}`,
          "x-dohc-relay-exchange-key": relayExchangeKey,
        },
      }),
    );

    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe('{"ok":false,"error":"not found"}');
  });

  it("refuses refresh when revocation wins before session replacement", async () => {
    const target = await newStorage();
    const relayExchangeKey = "share-web-relay-refresh-exchange-key";
    let grantId = "";
    let armed = false;
    let replaceLinkSessionInterceptions = 0;
    const raced = interceptStorage(target, {
      replaceLinkSession: (storage, input) => {
        replaceLinkSessionInterceptions += 1;
        if (armed) {
          armed = false;
          storage.revokeShareGrant({ shareId: "share-existing", grantId, revokedAtMs: 2_001 });
        }
        return storage.replaceLinkSession(input);
      },
    });
    const h = handler(raced, { relayExchangeKey });
    await seedFileShare(h);
    const created = await createLink(h);
    grantId = String(created.grantId);
    const exchangeResponse = await h(
      request(null, "/sync/link-exchange", {
        ...jsonBody({ secret: linkSecret(created.url) }),
        headers: {
          "content-type": "application/json",
          "x-dohc-relay-exchange-key": relayExchangeKey,
        },
      }),
    );
    expect(exchangeResponse.status).toBe(200);
    const exchanged = await json(exchangeResponse);
    armed = true;

    const refused = await h(
      request(null, "/sync/link-refresh", {
        method: "POST",
        headers: {
          authorization: `LinkCapability ${String(exchanged.capabilityToken)}`,
          "x-dohc-relay-exchange-key": relayExchangeKey,
        },
      }),
    );

    expect(replaceLinkSessionInterceptions).toBe(1);
    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe('{"ok":false,"error":"not found"}');
  });

  it("accepts the renewal grace boundary and refuses beyond it", async () => {
    expect(LINK_SESSION_RENEWAL_GRACE_MS).toBe(7 * 24 * 60 * 60 * 1_000);
    const storage = await newStorage();
    const relayExchangeKey = "share-web-relay-refresh-exchange-key";
    let now = 2_000;
    const h = handler(storage, { relayExchangeKey, nowMs: () => now });
    await seedFileShare(h);
    const created = await createLink(h);
    const exchanged = await json(
      await h(
        request(null, "/sync/link-exchange", {
          ...jsonBody({ secret: linkSecret(created.url) }),
          headers: {
            "content-type": "application/json",
            "x-dohc-relay-exchange-key": relayExchangeKey,
          },
        }),
      ),
    );
    const beyondGraceExchangeResponse = await h(
      request(null, "/sync/link-exchange", {
        ...jsonBody({ secret: linkSecret(created.url) }),
        headers: {
          "content-type": "application/json",
          "x-dohc-relay-exchange-key": relayExchangeKey,
        },
      }),
    );
    expect(beyondGraceExchangeResponse.status).toBe(200);
    const beyondGrace = await json(beyondGraceExchangeResponse);
    now += LINK_SESSION_TTL_MS + LINK_SESSION_RENEWAL_GRACE_MS;

    const boundary = await h(
      request(null, "/sync/link-refresh", {
        method: "POST",
        headers: {
          authorization: `LinkCapability ${String(exchanged.capabilityToken)}`,
          "x-dohc-relay-exchange-key": relayExchangeKey,
        },
      }),
    );
    expect(boundary.status).toBe(200);

    now += 1;
    const refused = await h(
      request(null, "/sync/link-refresh", {
        method: "POST",
        headers: {
          authorization: `LinkCapability ${String(beyondGrace.capabilityToken)}`,
          "x-dohc-relay-exchange-key": relayExchangeKey,
        },
      }),
    );
    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe('{"ok":false,"error":"not found"}');
  });

  it("requires the configured relay exchange key before rate limiting", async () => {
    const target = await newStorage();
    const lookups = countStorageCalls(target, "findLinkGrantByCredentialHash");
    const counted = lookups.storage;
    const credentialLookups = () => lookups.calls.length;
    const relayExchangeKey = "share-web-relay-exchange-key-at-least-32";
    const h = handler(counted, {
      relayExchangeKey,
      linkExchangeRateLimiter: new TokenBucketLimiter(1, 0.000_001, 10),
    });
    await seedFileShare(h);
    const created = await createLink(h);
    const generic = '404:{"ok":false,"error":"not found"}';

    const missing = await denialBytes(
      await h(request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(created.url) }))),
    );
    expect(missing).toBe(generic);
    const wrong = await denialBytes(
      await h(
        request(null, "/sync/link-exchange", {
          ...jsonBody({ secret: linkSecret(created.url) }),
          headers: {
            "content-type": "application/json",
            "x-dohc-relay-exchange-key": "wrong-key",
          },
        }),
      ),
    );
    expect(wrong).toBe(generic);
    expect(credentialLookups()).toBe(0);

    const admitted = await h(
      request(null, "/sync/link-exchange", {
        ...jsonBody({ secret: linkSecret(created.url) }),
        headers: {
          "content-type": "application/json",
          "x-dohc-relay-exchange-key": relayExchangeKey,
        },
      }),
    );
    expect(admitted.status).toBe(200);
    expect(credentialLookups()).toBeGreaterThan(0);
  });

  it("makes every exchange refusal byte-identical", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);

    const missing = await denialBytes(
      await h(request(null, "/sync/link-exchange", jsonBody({ secret: "g".repeat(43) }))),
    );
    expect(
      await denialBytes(await h(request(null, "/sync/link-exchange", jsonBody({ secret: 42 })))),
    ).toBe(missing);
    expect(
      await denialBytes(
        await h(
          request(null, "/sync/link-exchange", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{",
          }),
        ),
      ),
    ).toBe(missing);

    const rotated = await createLink(h);
    const rotateResponse = await h(
      request(
        OWNER,
        `/sync/shares/share-existing/links/${String(rotated.grantId)}/rotate`,
        jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
      ),
    );
    const rotation = await json(rotateResponse);
    expect(
      await denialBytes(
        await h(
          request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(rotated.url) })),
        ),
      ),
    ).toBe(missing);
    expect(
      (
        await h(
          request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(rotation.url) })),
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await h(
          request(
            OWNER,
            "/sync/shares/share-existing/revoke",
            jsonBody({
              grantId: rotated.grantId,
              workspaceId: WORKSPACE,
              expectedDependentGrantIds: [],
            }),
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      await denialBytes(
        await h(
          request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(rotation.url) })),
        ),
      ),
    ).toBe(missing);

    const lostStanding = await createLink(h);
    const noStandingStorage = interceptStorage(storage, { workspaceIsOwnedBy: () => false });
    expect(
      await denialBytes(
        await handler(noStandingStorage)(
          request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(lostStanding.url) })),
        ),
      ),
    ).toBe(missing);

    storage.createShare({
      share: {
        shareId: "share-chat",
        workspaceId: WORKSPACE,
        granterUserId: OWNER,
        selectorJson: JSON.stringify({ kind: "chat", channelWireId: "general" }),
        createdAtMs: 2_020,
      },
      grant: {
        grantId: "grant-chat-user",
        shareId: "share-chat",
        principalKind: "user",
        principalUserId: RECIPIENT,
        principalEmail: null,
        access: "read-only",
        generation: 1,
        status: "active",
        createdAtMs: 2_020,
        revokedAtMs: null,
        parentGrantId: null,
      },
    });
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/shares/share-chat/links`,
            jsonBody({ access: "view" }),
          ),
        )
      ).status,
    ).toBe(404);
    const chatSecret = Buffer.alloc(32, 7).toString("base64url");
    expect(
      storage.createLinkGrant({
        grant: {
          grantId: "grant-chat-link",
          shareId: "share-chat",
          principalKind: "link",
          principalUserId: null,
          principalEmail: null,
          access: "read-only",
          generation: 1,
          status: "active",
          createdAtMs: 2_020,
          revokedAtMs: null,
          parentGrantId: null,
        },
        credential: {
          credentialId: "credential-chat",
          grantId: "grant-chat-link",
          secretSealed: null,
          secretHash: hmac(chatSecret),
          generation: 1,
          mintedAtMs: 2_020,
          retiredAtMs: null,
        },
      }),
    ).toBe(true);
    expect(
      await denialBytes(
        await h(request(null, "/sync/link-exchange", jsonBody({ secret: chatSecret }))),
      ),
    ).toBe(missing);

    storage.appendLogBatch({
      workspaceId: WORKSPACE,
      originId: "channels",
      ops: sequenced([
        chatChannelCreate("wire-dm", { kind: "dm" }),
        chatChannelCreate("wire-agent", { kind: "agent" }),
      ]).map(({ payload, ...op }) => ({ ...op, payloadJson: JSON.stringify(payload) })),
    });
    for (const [wire, fill] of [
      ["wire-dm", 8],
      ["wire-agent", 9],
    ] as const) {
      storage.createShare({
        share: {
          shareId: `share-${wire}`,
          workspaceId: WORKSPACE,
          granterUserId: OWNER,
          selectorJson: JSON.stringify({
            kind: "group",
            channelWireId: wire,
            paths: [wire],
            versionId: null,
          }),
          createdAtMs: 2_030,
        },
        grant: {
          grantId: `grant-${wire}-user`,
          shareId: `share-${wire}`,
          principalKind: "user",
          principalUserId: RECIPIENT,
          principalEmail: null,
          access: "read-only",
          generation: 1,
          status: "active",
          createdAtMs: 2_030,
          revokedAtMs: null,
          parentGrantId: null,
        },
      });
      expect(
        (
          await h(
            request(
              OWNER,
              `/sync/${WORKSPACE}/shares/share-${wire}/links`,
              jsonBody({ access: "read-only" }),
            ),
          )
        ).status,
      ).toBe(404);
      const groupSecret = Buffer.alloc(32, fill).toString("base64url");
      seedLinkGrant(storage, {
        grantId: `grant-${wire}-link`,
        shareId: `share-${wire}`,
        secretSealed: null,
        secretHash: hmac(groupSecret),
        access: "read-only",
      });
      expect(
        await denialBytes(
          await h(request(null, "/sync/link-exchange", jsonBody({ secret: groupSecret }))),
        ),
      ).toBe(missing);
    }

    const noKey = handler(storage, { linkKey: undefined });
    expect(
      await denialBytes(
        await noKey(
          request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(lostStanding.url) })),
        ),
      ),
    ).toBe(missing);
  });
});

describe("explicit public Edit release", () => {
  const exchangeKey = "public-edit-test-relay-key-at-least-32";
  const releaseOptions: HandlerOverrides = {
    publicEditRelease: { version: 1 },
    relayExchangeKey: exchangeKey,
    namedBrowserSessionLimits: {
      maxSessions: 8,
      retentionMs: 60_000,
      maxPendingRequests: 4,
      maxRequestBytes: 8192,
      maxResponseBytes: 16384,
      timeoutMs: 1000,
    },
  };
  const exchangeRequest = (secret: string) =>
    request(null, "/sync/link-exchange", {
      ...jsonBody({ secret }),
      headers: { "content-type": "application/json", "x-dohc-relay-exchange-key": exchangeKey },
    });

  it("refuses pinned Edit creation even with release enabled", async () => {
    const storage = await newStorage(),
      enabled = handler(storage, releaseOptions);
    await enabled(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })));
    expect(
      (
        await enabled(
          request(
            OWNER,
            `/sync/${WORKSPACE}/shares/links`,
            jsonBody({ versionId: "version-pinned", access: "edit" }),
          ),
        )
      ).status,
    ).toBe(400);
    expect(storage.listSharesGrantedBy(OWNER)).toEqual([]);
    expect(
      (
        await enabled(
          request(
            OWNER,
            `/sync/${WORKSPACE}/shares/links`,
            jsonBody({ paths: ["docs"], access: "edit" }),
          ),
        )
      ).status,
    ).toBe(200);
  });

  it("issues Edit only when released, then permits narrowing after release is removed", async () => {
    const storage = await newStorage();
    const enabled = handler(storage, releaseOptions);
    await seedFileShare(enabled, "edit");
    expect(
      (await json(await enabled(request(OWNER, `/sync/${WORKSPACE}/shares/links`))))
        .supportedLinkAccess,
    ).toEqual(["view", "comment", "edit"]);
    const createdResponse = await enabled(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/share-existing/links`,
        jsonBody({ access: "edit" }),
      ),
    );
    expect(createdResponse.status).toBe(200);
    const created = await json(createdResponse);
    const secret = linkSecret(created.url),
      grantId = String(created.grantId);
    expect((await enabled(exchangeRequest(secret))).status).toBe(200);
    const closed = handler(storage, { ...releaseOptions, publicEditRelease: undefined });
    expect((await closed(exchangeRequest(secret))).status).not.toBe(200);
    expect(
      (await json(await closed(request(OWNER, `/sync/${WORKSPACE}/shares/links`))))
        .supportedLinkAccess,
    ).toEqual(["view", "comment"]);
    const rotate = `/sync/shares/share-existing/links/${grantId}/rotate`;
    const retune = `/sync/shares/share-existing/links/${grantId}/retune`;
    const transition = { workspaceId: WORKSPACE, expectedDependentGrantIds: [] };
    expect((await closed(request(OWNER, rotate, jsonBody(transition)))).status).toBe(400);
    expect((await enabled(request(OWNER, rotate, jsonBody(transition)))).status).toBe(200);
    expect(
      (await closed(request(OWNER, retune, jsonBody({ ...transition, access: "comment" })))).status,
    ).toBe(200);
    expect(storage.getShareGrant(grantId)?.access).toBe("comment");
    expect(
      (await closed(request(OWNER, retune, jsonBody({ ...transition, access: "edit" })))).status,
    ).toBe(400);
    expect(
      (await enabled(request(OWNER, retune, jsonBody({ ...transition, access: "edit" })))).status,
    ).toBe(200);
    expect(
      (
        await closed(
          request(
            OWNER,
            "/sync/shares/share-existing/revoke",
            jsonBody({ ...transition, grantId }),
          ),
        )
      ).status,
    ).toBe(200);
  });
});

describe("named share origin isolation", () => {
  it("isolates promoted recipients with equal replica sequences and learned origins", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h, "comment");
    seedStorageLink(storage, { grantId: "origin-link", access: "comment" });
    for (const user of ["member-a", "member-b"]) {
      expect(
        seedDependentGrant(storage, {
          shareId: "share-existing",
          parentGrantId: "origin-link",
          grantId: user,
          principalUserId: user,
          createdAtMs: 2_001,
        }),
      ).toMatchObject({ ok: true });
      expect(
        (
          await h(
            request(
              OWNER,
              `/sync/shares/share-existing/grants/${user}/promote`,
              jsonBody({
                workspaceId: WORKSPACE,
                expectedParentGrantId: "origin-link",
                expectedParentGeneration: 1,
              }),
            ),
          )
        ).status,
      ).toBe(200);
    }
    const ownerOp = {
      originSeq: 0,
      opKind: "moment.append",
      recordedAtMs: 1,
      payload: {
        momentId: "origin-file",
        versionId: "main",
        objectId: "origin-file",
        path: "docs/a.md",
        recordedAtMs: 1,
        operation: "write",
        payloadAfterPath: "docs/a.md",
        payloadAfterBlobSha256: null,
      },
    };
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/log`,
            jsonBody({ originId: "replica", ops: [ownerOp] }),
          ),
        )
      ).status,
    ).toBe(200);
    const append = (user: string, originId: string, seq: number) =>
      h(
        request(
          user,
          "/sync/shares/share-existing/log",
          jsonBody({
            originId,
            ops: [
              {
                originSeq: seq,
                opKind: "chat.thread.create",
                recordedAtMs: 2,
                payload: {
                  threadId: `${user}-${originId}-${seq}`,
                  title: "Question",
                  createdAtMs: 2,
                  linkedAtMs: 2,
                  linkedPath: "docs/a.md",
                },
              },
            ],
          }),
        ),
      );
    for (const user of ["member-a", "member-b"]) {
      const response = await append(user, "replica", 0);
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const page = await json(
      await h(request("member-b", "/sync/shares/share-existing/log?since=0")),
    );
    const rows = page.ops as Array<{ originId: string; payload: { threadId?: string } }>;
    const originA = rows.find((row) => row.payload.threadId === "member-a-replica-0")!.originId;
    const originB = rows.find((row) => row.payload.threadId === "member-b-replica-0")!.originId;
    expect(originA).not.toBe(originB);
    expect(originA).not.toBe("replica");
    const injection = await append("member-b", originA, 1);
    expect(injection.status).toBe(400);
    expect((await append("member-a", "replica", 1)).status).toBe(200);
    expect((await append("member-b", "replica", 1)).status).toBe(200);
    expect((await append("member-a", "replica", 1)).status).toBe(200);
    expect(
      (
        await h(
          request(OWNER, `/sync/${WORKSPACE}/log`, jsonBody({ originId: originA, ops: [ownerOp] })),
        )
      ).status,
    ).toBe(400);
    const ownerRows = storage.fetchLogPage({
      workspaceId: WORKSPACE,
      sinceRelaySeq: 0,
      limit: 100,
    }).rows;
    expect(ownerRows.find((row) => row.opKind === "moment.append")?.originId).toBe("replica");
  });
});

it("retries an agent link creation across restart without minting another credential", async () => {
  const { storage, dbPath } = await newStorageWithPath(),
    h = handler(storage);
  await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })));
  const agent = { kind: "agent", label: "Builder", labelSource: "agent-declared" },
    body = {
      paths: ["docs"],
      access: "view",
      operationId: "00000000-0000-4000-8000-000000000101",
      agent,
    };
  const created = await h(request(OWNER, `/sync/${WORKSPACE}/shares/links`, jsonBody(body)));
  expect(created.status).toBe(200);
  const first = await json(created);
  expect(first.url).toEqual(expect.any(String));
  closeTestStorage(storage);
  const reopened = reopenTestStorage(dbPath),
    next = handler(reopened);
  const retry = await next(request(OWNER, `/sync/${WORKSPACE}/shares/links`, jsonBody(body)));
  expect(retry.headers.get("cache-control")).toBe("private, no-store");
  expect(retry.status).toBe(200);
  expect(await json(retry)).toMatchObject({
    shareId: first.shareId,
    grantId: first.grantId,
    url: first.url,
  });
  const links = await ownerLinkInventory(next);
  expect(links).toHaveLength(1);
  expect(links[0]!.creationProvenance).toMatchObject({
    agent,
    selector: { paths: ["docs"], versionId: null },
    access: "view",
  });
  expect(links[0]!.url).toBe(first.url);
  const changed = await next(
    request(OWNER, `/sync/${WORKSPACE}/shares/links`, jsonBody({ ...body, access: "comment" })),
  );
  expect(changed.status).toBe(409);
  expect(
    (await next(request(RECIPIENT, `/sync/${WORKSPACE}/shares/links`, jsonBody(body)))).status,
  ).toBe(404);
  expect(reopened.readLinkCreation(WORKSPACE, body.operationId, RECIPIENT)).toBeNull();
  const database = inspectDatabase(dbPath);
  try {
    expect(database.prepare("SELECT COUNT(*) n FROM sync_relay_link_credentials").get()!.n).toBe(1);
    expect(
      database.prepare("SELECT request_json FROM sync_relay_link_creations").get()!.request_json,
    ).not.toContain(String(first.url).split("#")[1]);
    database.prepare("UPDATE sync_relay_link_credentials SET secret_sealed = NULL").run();
  } finally {
    database.close();
  }
  const legacyRetry = await next(request(OWNER, `/sync/${WORKSPACE}/shares/links`, jsonBody(body)));
  expect(legacyRetry.status).toBe(200);
  const legacyResult = await json(legacyRetry);
  expect(legacyResult).toMatchObject({
    shareId: first.shareId,
    grantId: first.grantId,
    urlUnavailable: true,
  });
  expect(legacyResult).not.toHaveProperty("url");
});

it("gives no URL to a creation retry after the link's access changed", async () => {
  const storage = await newStorage(),
    h = handler(storage);
  await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })));
  const body = {
    paths: ["docs"],
    access: "view",
    operationId: "00000000-0000-4000-8000-000000000102",
  };
  const first = await json(
    await h(request(OWNER, `/sync/${WORKSPACE}/shares/links`, jsonBody(body))),
  );
  const path = `/sync/shares/${String(first.shareId)}/links/${String(first.grantId)}/retune`;
  const transition = { workspaceId: WORKSPACE, expectedDependentGrantIds: [] };
  const widened = await h(request(OWNER, path, jsonBody({ ...transition, access: "comment" })));
  expect(widened.status, await widened.clone().text()).toBe(200);
  const retry = await json(
    await h(request(OWNER, `/sync/${WORKSPACE}/shares/links`, jsonBody(body))),
  );
  expect(retry).toMatchObject({ grantId: first.grantId, access: "view", urlUnavailable: true });
  expect(retry).not.toHaveProperty("url");
  expect((await h(request(OWNER, path, jsonBody({ ...transition, access: "view" })))).status).toBe(
    200,
  );
  const current = (await ownerLinkInventory(h))[0]!.url;
  expect(
    await json(await h(request(OWNER, `/sync/${WORKSPACE}/shares/links`, jsonBody(body)))),
  ).toMatchObject({ url: current });
});

it.each([[[]], [[".env"]], [["docs/.env"]], [[".dohc/secret"]]])(
  "refuses agent link secret paths and empty selectors %j",
  async (paths) => {
    const storage = await newStorage(),
      h = handler(storage);
    await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })));
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/shares/links`,
            jsonBody({
              paths,
              access: "view",
              operationId: "00000000-0000-4000-8000-000000000101",
            }),
          ),
        )
      ).status,
    ).toBe(400);
    expect(await ownerLinkInventory(h)).toHaveLength(0);
  },
);
