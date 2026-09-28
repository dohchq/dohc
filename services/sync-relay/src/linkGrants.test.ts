import { TokenBucketLimiter } from "@dohc/service-http";
import {linkRefusalBody} from "@dohc/security-contract/link-refusal";
import { timingSafeEqual } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  constantTimeHashEqual,
  hashLinkBearer,
  hashRelayExchangeKey,
  LINK_SESSION_RENEWAL_GRACE_MS,
  LINK_SESSION_TTL_MS,
  mintLinkBearer,
  validateLinkCapability,
  verifyRelayExchangeKey,
} from "./linkSecurity";
import type { SyncRelayHandler } from "./server";
import { authorizeShareAction } from "./shareAuthorization";
import { LINK_INVENTORY_PAGE_SIZE, type SyncRelayStorage } from "./storage";
import {
  seedDependentGrant,
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

describe("relay exchange key verification", () => {
  const exchangeKey = "share-web-relay-exchange-key-at-least-32";
  const expectedHash = hashRelayExchangeKey(exchangeKey);

  it("accepts the matching key", () => {
    expect(verifyRelayExchangeKey(exchangeKey, expectedHash)).toBe(true);
  });

  it("rejects a different key", () => {
    expect(verifyRelayExchangeKey("wrong-key", expectedHash)).toBe(false);
  });

  it("rejects a missing key", () => {
    expect(verifyRelayExchangeKey(null, expectedHash)).toBe(false);
  });
});

const newStorage = testStorage;

async function newStorageWithPath(
  options?: Parameters<typeof testStorage>[0],
): Promise<{ storage: SyncRelayStorage; dbPath: string }> {
  const storage = await testStorage(options);
  return { storage, dbPath: storagePath(storage) };
}

function updateShareWorkspace(dbPath: string, shareId: string, workspaceId: string): void {
  const database = inspectDatabase(dbPath);
  try {
    database
      .prepare("UPDATE sync_relay_shares SET workspace_id = ? WHERE share_id = ?")
      .run(workspaceId, shareId);
  } finally {
    database.close();
  }
}

describe("workspace link inventory index", () => {
  const indexName = "idx_sync_relay_shares_workspace";
  const workspaceLookup = `
    SELECT share_id
    FROM sync_relay_shares
    WHERE workspace_id = ?
    ORDER BY created_at_ms, share_id
  `;

  function expectWorkspaceIndex(database: Parameters<Parameters<typeof inspect>[1]>[0]): void {
    const columns = database
      .prepare(`PRAGMA index_info('${indexName}')`)
      .all()
      .map((row) => String(row.name));
    expect(columns).toEqual(["workspace_id", "created_at_ms", "share_id"]);

    const queryPlan = database
      .prepare(`EXPLAIN QUERY PLAN ${workspaceLookup}`)
      .all(WORKSPACE)
      .map((row) => String(row.detail));
    expect(
      queryPlan.some((detail) => detail.includes(`USING COVERING INDEX ${indexName}`)),
    ).toBe(true);
    expect(queryPlan.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(false);
  }

  it("installs the index for new storage", async () => {
    const { dbPath } = await newStorageWithPath();
    inspect(dbPath, expectWorkspaceIndex);
  });
});

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
    request(
      OWNER,
      `/sync/${WORKSPACE}/shares/share-existing/links`,
      jsonBody({ access }),
    ),
  );
  expect(response.status).toBe(200);
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
    secretHash: hmac(input.secret ?? defaultStorageLinkSecret(input.grantId)),
  });
}

async function ownerLinkInventory(
  h: SyncRelayHandler,
): Promise<Array<Record<string, unknown>>> {
  const response = await h(request(OWNER, `/sync/${WORKSPACE}/shares/links`));
  expect(response.status).toBe(200);
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

async function seedIndependentEditAndDependentView(
  storage: SyncRelayStorage,
  h: SyncRelayHandler,
): Promise<{ dependentGrantId: string; linkGrantId: string }> {
  await seedFileShare(h, "edit");
  const link = await createLink(h);
  const linkGrantId = String(link.grantId);
  const dependentGrantId = "grant-dependent-view";
  expect(
    seedDependentGrant(storage, {
      shareId: "share-existing",
      parentGrantId: linkGrantId,
      grantId: dependentGrantId,
      principalUserId: RECIPIENT,
      createdAtMs: 2_001,
    }),
  ).toMatchObject({
    ok: true,
    grant: { access: "view", parentGrantId: linkGrantId },
  });
  return { dependentGrantId, linkGrantId };
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
        inspection
          .prepare("SELECT COUNT(*) AS count FROM sync_relay_link_credentials")
          .get()?.count,
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

  it("creates one comment file share, one link grant, and one hashed credential", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    expect(
      (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
    ).toBe(200);

    const response = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/links`,
        jsonBody({ paths: ["docs"], access: "comment" }),
      ),
    );
    expect(response.status).toBe(200);
    const created = await json(response);
    const grantId = String(created.grantId);
    const secret = linkSecret(created.url);

    expect(created).toMatchObject({
      ok: true,
      shareId: "share-existing",
      workspaceId: WORKSPACE,
      selector: { paths: ["docs"], versionId: null },
      principalKind: "link",
      access: "comment",
      generation: 1,
      status: "active",
    });
    expect(storage.getShareGrant(grantId)).toMatchObject({
      access: "comment",
      generation: 1,
    });
    expect(storage.getCurrentLinkCredential(grantId)).toMatchObject({
      secretHash: hmac(secret),
      generation: 1,
      retiredAtMs: null,
    });
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

  it.each([
    ["missing access", { paths: ["docs"] }],
    ["Edit access", { paths: ["docs"], access: "edit" }],
    ["malformed access", { paths: ["docs"], access: 42 }],
    ["recipient user", { paths: ["docs"], access: "view", recipientUserId: RECIPIENT }],
    [
      "recipient email",
      { paths: ["docs"], access: "view", recipientEmail: "reader@example.test" },
    ],
    ["channel", { access: "view", channelWireId: "channel" }],
    [
      "ambiguous selector",
      { paths: ["docs"], access: "view", channelWireId: "channel" },
    ],
    ["empty paths", { paths: [], access: "view" }],
    ["malformed paths", { paths: [42], access: "view" }],
  ])("refuses %s without creating storage", async (_label, body) => {
    const storage = await newStorage();
    const h = handler(storage);
    await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })));
    const response = await h(
      request(OWNER, `/sync/${WORKSPACE}/shares/links`, jsonBody(body)),
    );
    expect(response.status).toBe(400);
    expect(storage.getShare("share-existing")).toBeNull();
    expect(storage.listSharesGrantedBy(OWNER)).toEqual([]);
  });

  it("refuses a non-owner without creating storage", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })));
    const response = await h(
      request(
        "other",
        `/sync/${WORKSPACE}/shares/links`,
        jsonBody({ paths: ["docs"], access: "view" }),
      ),
    );
    expect(response.status).toBe(404);
    expect(storage.getShare("share-existing")).toBeNull();
    expect(storage.listSharesGrantedBy(OWNER)).toEqual([]);
  });
});

describe("owner link contract", () => {
  it.each([
    ["missing access", {}],
    ["Edit access", { access: "edit" }],
    ["malformed access", { access: 42 }],
    ["an extra field", { access: "view", extra: true }],
  ])("refuses add-link creation with %s without creating a link row", async (_label, body) => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);

    const response = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/share-existing/links`,
        jsonBody(body),
      ),
    );

    expect(response.status).toBe(400);
    expect(
      storage
        .listSharesGrantedBy(OWNER)
        .filter((row) => row.grant.principalKind === "link"),
    ).toEqual([]);
  });

  it.each(["rotate", "revoke"] as const)(
    "rejects a link-only %s request without workspaceId before writing",
    async (operation) => {
      const storage = await newStorage();
      const h = handler(storage);
      await seedFileShare(h);
      const created = await createLink(h);
      const grantId = String(created.grantId);
      const beforeGrant = storage.getShareGrant(grantId);
      const beforeCredential = storage.getCurrentLinkCredential(grantId);

      const response =
        operation === "rotate"
          ? await h(
              request(
                OWNER,
                `/sync/shares/share-existing/links/${grantId}/rotate`,
                jsonBody({ expectedDependentGrantIds: [] }),
              ),
            )
          : await h(
              request(
                OWNER,
                "/sync/shares/share-existing/revoke",
                jsonBody({ grantId, expectedDependentGrantIds: [] }),
              ),
            );

      expect(response.status).toBe(400);
      expect(storage.getShareGrant(grantId)).toEqual(beforeGrant);
      expect(storage.getCurrentLinkCredential(grantId)).toEqual(beforeCredential);
    },
  );

  it("binds reset and link-only end to the share's immutable workspace", async () => {
    const storage = await newStorage();
    const shareIds = ["share-workspace-b-reset", "share-workspace-b-end"];
    const grantIds = ["link-workspace-b-reset", "link-workspace-b-end"];
    const h = handler(storage, {
      newShareId: () => shareIds.shift()!,
      newGrantId: () => grantIds.shift()!,
    });
    for (const workspaceId of [WORKSPACE, "workspace-links-b"]) {
      expect(
        (
          await h(
            request(OWNER, "/sync/workspaces", jsonBody({ workspaceId })),
          )
        ).status,
      ).toBe(200);
    }
    const created: Record<string, unknown>[] = [];
    for (const path of ["reset", "end"]) {
      const response = await h(
        request(
          OWNER,
          "/sync/workspace-links-b/shares/links",
          jsonBody({ paths: [path], access: "view" }),
        ),
      );
      expect(response.status).toBe(200);
      created.push(await json(response));
    }
    const resetUrl = String(created[0]!.url);
    const endUrl = String(created[1]!.url);
    const resetSecret = linkSecret(resetUrl);
    const endSecret = linkSecret(endUrl);
    const beforeResetGrant = storage.getShareGrant("link-workspace-b-reset");
    const beforeResetCredential = storage.getCurrentLinkCredential(
      "link-workspace-b-reset",
    );
    const beforeEndGrant = storage.getShareGrant("link-workspace-b-end");
    const beforeEndCredential = storage.getCurrentLinkCredential(
      "link-workspace-b-end",
    );

    const missingReset = await denialBytes(
      await h(
        request(
          OWNER,
          "/sync/shares/share-missing/links/link-workspace-b-reset/rotate",
          jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
        ),
      ),
    );
    expect(
      await denialBytes(
        await h(
          request(
            OWNER,
            "/sync/shares/share-workspace-b-reset/links/link-workspace-b-reset/rotate",
            jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
          ),
        ),
      ),
    ).toBe(missingReset);
    expect(storage.getShareGrant("link-workspace-b-reset")).toEqual(
      beforeResetGrant,
    );
    expect(storage.getCurrentLinkCredential("link-workspace-b-reset")).toEqual(
      beforeResetCredential,
    );
    expect(
      (
        await h(
          request(null, "/sync/link-exchange", jsonBody({ secret: resetSecret })),
        )
      ).status,
    ).toBe(200);

    const missingEnd = await denialBytes(
      await h(
        request(
          OWNER,
          "/sync/shares/share-missing/revoke",
          jsonBody({
            grantId: "link-workspace-b-end",
            workspaceId: WORKSPACE,
            expectedDependentGrantIds: [],
          }),
        ),
      ),
    );
    expect(
      await denialBytes(
        await h(
          request(
            OWNER,
            "/sync/shares/share-workspace-b-end/revoke",
            jsonBody({
              grantId: "link-workspace-b-end",
              workspaceId: WORKSPACE,
              expectedDependentGrantIds: [],
            }),
          ),
        ),
      ),
    ).toBe(missingEnd);
    expect(storage.getShareGrant("link-workspace-b-end")).toEqual(beforeEndGrant);
    expect(storage.getCurrentLinkCredential("link-workspace-b-end")).toEqual(
      beforeEndCredential,
    );
    expect(
      (
        await h(
          request(null, "/sync/link-exchange", jsonBody({ secret: endSecret })),
        )
      ).status,
    ).toBe(200);

    const reset = await h(
      request(
        OWNER,
        "/sync/shares/share-workspace-b-reset/links/link-workspace-b-reset/rotate",
        jsonBody({
          workspaceId: "workspace-links-b",
          expectedDependentGrantIds: [],
        }),
      ),
    );
    expect(reset.status).toBe(200);
    const resetBody = await json(reset);
    expect(linkSecret(resetBody.url)).not.toBe(resetSecret);

    const ended = await h(
      request(
        OWNER,
        "/sync/shares/share-workspace-b-end/revoke",
        jsonBody({
          grantId: "link-workspace-b-end",
          workspaceId: "workspace-links-b",
          expectedDependentGrantIds: [],
        }),
      ),
    );
    expect(ended.status).toBe(200);
    expect(storage.getShareGrant("link-workspace-b-end")).toMatchObject({
      status: "revoked",
    });
  });

  it("uses the 32-byte CSPRNG bearer seam for create and rotate", async () => {
    const storage = await newStorage();
    let bearerByte = 1;
    let credentialId = 0;
    const random = vi.fn((size: number) => Buffer.alloc(size, bearerByte++));
    const newLinkBearer = vi.fn(() => mintLinkBearer(random));
    const newId = vi.fn(() => `handler-credential-${credentialId++}`);
    const h = handler(storage, { newId, newLinkBearer });
    await seedFileShare(h);

    const attached = await createLink(h);
    expect(attached).not.toHaveProperty("secret");
    const attachedSecret = linkSecret(attached.url);
    const grantId = String(attached.grantId);
    expect(JSON.stringify(attached).split(attachedSecret)).toHaveLength(2);
    expect(random).toHaveBeenCalledTimes(1);
    expect(random).toHaveBeenNthCalledWith(1, 32);
    newLinkBearer.mockClear();
    newId.mockClear();

    const rotateResponse = await h(
      request(
        OWNER,
        `/sync/shares/share-existing/links/${grantId}/rotate`,
        jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
      ),
    );
    expect(rotateResponse.status).toBe(200);
    const rotated = await json(rotateResponse);
    expect(rotated).not.toHaveProperty("secret");
    expect(newLinkBearer).toHaveBeenCalledTimes(1);
    expect(random).toHaveBeenCalledTimes(2);
    expect(random).toHaveBeenNthCalledWith(2, 32);
    expect(newId).toHaveBeenCalledTimes(1);
    const rotatedSecret = linkSecret(rotated.url);
    expect(rotatedSecret).not.toBe(attachedSecret);
    expect(
      (await h(request(null, "/sync/link-exchange", jsonBody({ secret: attachedSecret })))).status,
    ).toBe(404);
    expect(
      (await h(request(null, "/sync/link-exchange", jsonBody({ secret: rotatedSecret })))).status,
    ).toBe(200);

    const higherSecret = "h".repeat(43);
    expect(
      storage.createLinkGrant({
        grant: {
          grantId: "storage-seeded-comment-link",
          shareId: "share-existing",
          principalKind: "link",
          principalUserId: null,
          principalEmail: null,
          access: "comment",
          generation: 1,
          status: "active",
          createdAtMs: 2_001,
          revokedAtMs: null,
          parentGrantId: null,
        },
        credential: {
          credentialId: "storage-seeded-comment-credential",
          grantId: "storage-seeded-comment-link",
          secretHash: hmac(higherSecret),
          generation: 1,
          mintedAtMs: 2_001,
          retiredAtMs: null,
        },
      }),
    ).toBe(true);
    const dependentGrantId = "storage-seeded-comment-dependent";
    expect(
      seedDependentGrant(storage, {
        shareId: "share-existing",
        parentGrantId: "storage-seeded-comment-link",
        grantId: dependentGrantId,
        principalUserId: "retune-dependent-user",
        createdAtMs: 2_002,
      }),
    ).toMatchObject({
      ok: true,
      grant: {
        access: "comment",
        generation: 1,
        parentGrantId: "storage-seeded-comment-link",
      },
    });
    const beforeRetuneCredential = storage.getCurrentLinkCredential(
      "storage-seeded-comment-link",
    )!;
    const retuneShareGrant = vi.spyOn(storage, "retuneShareGrant");
    newLinkBearer.mockClear();
    newId.mockClear();
    const narrowResponse = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/links/storage-seeded-comment-link/retune",
        jsonBody({
          workspaceId: WORKSPACE,
          access: "view",
          expectedDependentGrantIds: [dependentGrantId],
        }),
      ),
    );
    expect(narrowResponse.status).toBe(200);
    const narrowed = await json(narrowResponse);
    expect(narrowed).toEqual({
      ok: true,
      shareId: "share-existing",
      grantId: "storage-seeded-comment-link",
      principalKind: "link",
      access: "view",
      generation: 1,
      status: "active",
      createdAtMs: 2_001,
      revokedAtMs: null,
      parentGrantId: null,
    });
    expect(retuneShareGrant).toHaveBeenCalledTimes(1);
    const [retuneInput] = retuneShareGrant.mock.calls[0]!;
    expect(retuneInput).toMatchObject({
      shareId: "share-existing",
      grantId: "storage-seeded-comment-link",
      access: "view",
      expectedDependentGrantIds: [dependentGrantId],
    });
    expect(retuneInput).not.toHaveProperty("mintCredential");
    expect(newLinkBearer).not.toHaveBeenCalled();
    expect(newId).not.toHaveBeenCalled();
    expect(storage.getShareGrant("storage-seeded-comment-link")).toMatchObject({
      access: "view",
      generation: 1,
    });
    expect(storage.getShareGrant(dependentGrantId)).toMatchObject({
      access: "view",
      generation: 2,
      parentGrantId: "storage-seeded-comment-link",
    });
    expect(storage.getCurrentLinkCredential("storage-seeded-comment-link")).toEqual(
      beforeRetuneCredential,
    );
    expect(
      (await h(request(null, "/sync/link-exchange", jsonBody({ secret: higherSecret })))).status,
    ).toBe(200);
  });

  it("widens with one new URL and narrows with the current URL and dependent CAS", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const created = await createLink(h, "view");
    const grantId = String(created.grantId);
    const oldSecret = linkSecret(created.url);
    const viewDependentId = "view-dependent";
    expect(
      seedDependentGrant(storage, {
        shareId: "share-existing",
        parentGrantId: grantId,
        grantId: viewDependentId,
        principalUserId: "view-dependent-user",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true, grant: { access: "view" } });
    const oldExchange = await json(
      await h(request(null, "/sync/link-exchange", jsonBody({ secret: oldSecret }))),
    );
    const oldCapability = String(oldExchange.capabilityToken);
    const retuneShareGrant = vi.spyOn(storage, "retuneShareGrant");

    const widenResponse = await h(
      request(
        OWNER,
        `/sync/shares/share-existing/links/${grantId}/retune`,
        jsonBody({
          workspaceId: WORKSPACE,
          access: "comment",
          expectedDependentGrantIds: [viewDependentId],
        }),
      ),
    );
    expect(widenResponse.status).toBe(200);
    const widenText = await widenResponse.text();
    const widened = JSON.parse(widenText) as Record<string, unknown>;
    const commentSecret = linkSecret(widened.url);
    expect(widened).toMatchObject({
      ok: true,
      grantId,
      access: "comment",
      generation: 2,
    });
    expect(commentSecret).not.toBe(oldSecret);
    expect(widenText.split(commentSecret)).toHaveLength(2);
    expect(retuneShareGrant).toHaveBeenCalledTimes(1);
    expect(retuneShareGrant.mock.calls[0]![0]).toMatchObject({
      shareId: "share-existing",
      grantId,
      access: "comment",
      expectedDependentGrantIds: [viewDependentId],
      mintCredential: expect.any(Function),
    });
    expect(storage.getShareGrant(viewDependentId)).toMatchObject({
      access: "view",
      generation: 2,
    });
    expect(
      (await h(request(null, "/sync/link-exchange", jsonBody({ secret: oldSecret })))).status,
    ).toBe(404);
    expect(
      (
        await h(
          request(null, "/sync/link/share", {
            headers: { authorization: `LinkCapability ${oldCapability}` },
          }),
        )
      ).status,
    ).toBe(404);
    const commentExchange = await json(
      await h(request(null, "/sync/link-exchange", jsonBody({ secret: commentSecret }))),
    );
    expect(commentExchange).toMatchObject({
      grantId,
      access: "comment",
      generation: 2,
      effectiveSelector: { access: "comment" },
    });

    const commentDependentId = "comment-dependent";
    expect(
      seedDependentGrant(storage, {
        shareId: "share-existing",
        parentGrantId: grantId,
        grantId: commentDependentId,
        principalUserId: "comment-dependent-user",
        createdAtMs: 2_002,
      }),
    ).toMatchObject({ ok: true, grant: { access: "comment" } });
    const narrowResponse = await h(
      request(
        OWNER,
        `/sync/shares/share-existing/links/${grantId}/retune`,
        jsonBody({
          workspaceId: WORKSPACE,
          access: "view",
          expectedDependentGrantIds: [commentDependentId, viewDependentId],
        }),
      ),
    );
    expect(narrowResponse.status).toBe(200);
    const narrowed = await json(narrowResponse);
    expect(narrowed).toMatchObject({
      ok: true,
      grantId,
      access: "view",
      generation: 2,
    });
    expect(narrowed).not.toHaveProperty("url");
    expect(retuneShareGrant).toHaveBeenCalledTimes(2);
    expect(retuneShareGrant.mock.calls[1]![0]).toMatchObject({
      shareId: "share-existing",
      grantId,
      access: "view",
      expectedDependentGrantIds: [commentDependentId, viewDependentId],
    });
    expect(retuneShareGrant.mock.calls[1]![0]).not.toHaveProperty("mintCredential");
    expect(storage.getShareGrant(viewDependentId)).toMatchObject({
      access: "view",
      generation: 3,
    });
    expect(storage.getShareGrant(commentDependentId)).toMatchObject({
      access: "view",
      generation: 2,
    });
    expect(storage.getCurrentLinkCredential(grantId)).toMatchObject({
      secretHash: hmac(commentSecret),
      generation: 2,
      retiredAtMs: null,
    });
    const narrowedCapabilityRead = await h(
      request(null, "/sync/link/share", {
        headers: {
          authorization: `LinkCapability ${String(commentExchange.capabilityToken)}`,
        },
      }),
    );
    expect(narrowedCapabilityRead.status).toBe(200);
    expect(await json(narrowedCapabilityRead)).toMatchObject({
      access: "view",
      effectiveSelector: { access: "view" },
    });
    const narrowedExchange = await json(
      await h(request(null, "/sync/link-exchange", jsonBody({ secret: commentSecret }))),
    );
    expect(narrowedExchange).toMatchObject({
      grantId,
      access: "view",
      generation: 2,
      effectiveSelector: { access: "view" },
    });
  });

  it.each(["missing link key", "missing public origin"] as const)(
    "refuses a widening retune with %s before changing state",
    async (missing) => {
      const storage = await newStorage();
      const configured = handler(storage);
      await seedFileShare(configured);
      const created = await createLink(configured, "view");
      const grantId = String(created.grantId);
      const beforeGrant = storage.getShareGrant(grantId);
      const beforeCredential = storage.getCurrentLinkCredential(grantId);
      const newLinkBearer = vi.fn(() => "z".repeat(43));
      const withoutMintingConfig = handler(storage, {
        ...(missing === "missing link key"
          ? { linkKey: undefined }
          : { shareWebOrigin: undefined }),
        newLinkBearer,
      });

      const response = await withoutMintingConfig(
        request(
          OWNER,
          `/sync/shares/share-existing/links/${grantId}/retune`,
          jsonBody({
            workspaceId: WORKSPACE,
            access: "comment",
            expectedDependentGrantIds: [],
          }),
        ),
      );

      expect(response.status).toBe(404);
      expect(newLinkBearer).not.toHaveBeenCalled();
      expect(storage.getShareGrant(grantId)).toEqual(beforeGrant);
      expect(storage.getCurrentLinkCredential(grantId)).toEqual(beforeCredential);
    },
  );

  it.each([
    ["view", "comment", true], ["view", "edit", true], ["comment", "edit", true],
    ["comment", "view", false], ["edit", "comment", false], ["edit", "view", false],
  ] as const)("storage %s to %s rotates credentials only when widening", async (from, access, widening) => {
    const storage = await newStorage();
    await seedFileShare(handler(storage));
    const grantId = "rank-transition";
    const original = {credentialId: "rank-original", grantId, secretHash: hmac("o".repeat(43)), generation: 1,
      mintedAtMs: 2000, retiredAtMs: null};
    expect(storage.createLinkGrant({
      grant: {grantId, shareId: "share-existing", principalKind: "link", principalUserId: null,
        principalEmail: null, access: from, generation: 1, status: "active", createdAtMs: 2000,
        revokedAtMs: null, parentGrantId: null}, credential: original,
    })).toBe(true);
    const mintCredential = vi.fn(() => ({credentialId: "rank-replacement", secretHash: hmac("n".repeat(43))}));
    const input = {shareId: "share-existing", grantId, access, changedAtMs: 3000,
      expectedDependentGrantIds: [], guard: () => undefined};
    expect(storage.retuneShareGrant({...input, ...(widening ? {} : {mintCredential})})).toEqual({ok: false});
    expect(mintCredential).not.toHaveBeenCalled();
    expect(storage.getShareGrant(grantId)).toMatchObject({access: from, generation: 1});
    expect(storage.getCurrentLinkCredential(grantId)).toEqual(original);
    expect(storage.retuneShareGrant({...input, ...(widening ? {mintCredential} : {})})).toMatchObject({ok: true});
    expect(storage.getShareGrant(grantId)).toMatchObject({access, generation: widening ? 2 : 1});
    expect(mintCredential).toHaveBeenCalledTimes(widening ? 1 : 0);
    expect(storage.getCurrentLinkCredential(grantId)).toMatchObject(widening
      ? {credentialId: "rank-replacement", generation: 2}
      : original);
  });

  it("refuses attach creation and retuning to edit", async () => {
    const access = "edit";
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const attached = await createLink(h);
    const grantId = String(attached.grantId);
    const generation = storage.getShareGrant(grantId)?.generation;

    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/shares/share-existing/links`,
            jsonBody({ access }),
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/shares/share-existing/links/${grantId}/retune`,
            jsonBody({ workspaceId: WORKSPACE, access, expectedDependentGrantIds: [] }),
          ),
        )
      ).status,
    ).toBe(400);
    expect(storage.getShareGrant(grantId)?.generation).toBe(generation);
    expect(
      storage
        .listSharesGrantedBy(OWNER)
        .filter((row) => row.grant.principalKind === "link"),
    ).toHaveLength(1);
  });

  it.each(["view", "comment"] as const)(
    "narrows an active Edit link down to %s while public Edit issuance is disabled",
    async (access) => {
      const storage = await newStorage();
      const h = handler(storage);
      await seedFileShare(h);
      const grantId = `storage-seeded-edit-to-${access}`;
      expect(
        storage.createLinkGrant({
          grant: {
            grantId,
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
            credentialId: `${grantId}-credential`,
            grantId,
            secretHash: hmac(`${access[0]}${"e".repeat(42)}`),
            generation: 1,
            mintedAtMs: 2_000,
            retiredAtMs: null,
          },
        }),
      ).toBe(true);
      const beforeGrant = storage.getShareGrant(grantId);
      const beforeCredential = storage.getCurrentLinkCredential(grantId);

      const response = await h(
        request(
          OWNER,
          `/sync/shares/share-existing/links/${grantId}/retune`,
          jsonBody({ workspaceId: WORKSPACE, access, expectedDependentGrantIds: [] }),
        ),
      );

      expect(response.status).toBe(200);
      expect(await json(response)).toMatchObject({ok: true, access, generation: 1});
      expect(storage.getShareGrant(grantId)).toEqual({...beforeGrant, access});
      expect(storage.getCurrentLinkCredential(grantId)).toEqual(beforeCredential);
    },
  );

  it("lets narrowing retune run without an origin but refuses every minting route first", async () => {
    const storage = await newStorage();
    const configured = handler(storage);
    await seedFileShare(configured);
    const attached = await createLink(configured);
    const grantId = String(attached.grantId);
    const beforeRotate = storage.getShareGrant(grantId);
    let absentOriginId = 0;
    const withoutOrigin = handler(storage, {
      shareWebOrigin: undefined,
      newShareId: () => "absent-origin-atomic-share",
      newGrantId: () => `absent-origin-grant-${absentOriginId++}`,
      newId: () => `absent-origin-id-${absentOriginId++}`,
    });

    expect(
      (
        await withoutOrigin(
          request(
            OWNER,
            `/sync/${WORKSPACE}/shares/links`,
            jsonBody({ paths: ["other"], access: "view" }),
          ),
        )
      ).status,
    ).toBe(404);
    expect(storage.getShare("absent-origin-atomic-share")).toBeNull();
    expect(
      (
        await withoutOrigin(
          request(
            OWNER,
            `/sync/${WORKSPACE}/shares/share-existing/links`,
            jsonBody({ access: "view" }),
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await withoutOrigin(
          request(
            OWNER,
            `/sync/shares/share-existing/links/${grantId}/rotate`,
            jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
          ),
        )
      ).status,
    ).toBe(404);
    expect(storage.getShareGrant(grantId)).toEqual(beforeRotate);
    expect(storage.listSharesGrantedBy(OWNER).filter((row) => row.grant.principalKind === "link"))
      .toHaveLength(1);

    const highSecret = "n".repeat(43);
    expect(
      storage.createLinkGrant({
        grant: {
          grantId: "storage-seeded-comment-without-origin-link",
          shareId: "share-existing",
          principalKind: "link",
          principalUserId: null,
          principalEmail: null,
          access: "comment",
          generation: 1,
          status: "active",
          createdAtMs: 2_001,
          revokedAtMs: null,
          parentGrantId: null,
        },
        credential: {
          credentialId: "storage-seeded-comment-without-origin-credential",
          grantId: "storage-seeded-comment-without-origin-link",
          secretHash: hmac(highSecret),
          generation: 1,
          mintedAtMs: 2_001,
          retiredAtMs: null,
        },
      }),
    ).toBe(true);
    const narrowed = await withoutOrigin(
      request(
        OWNER,
        "/sync/shares/share-existing/links/storage-seeded-comment-without-origin-link/retune",
        jsonBody({
          workspaceId: WORKSPACE,
          access: "view",
          expectedDependentGrantIds: [],
        }),
      ),
    );
    expect(narrowed.status).toBe(200);
    expect(await json(narrowed)).not.toHaveProperty("url");
    expect(storage.getShareGrant("storage-seeded-comment-without-origin-link")).toMatchObject({
      access: "view",
      generation: 1,
    });
  });

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

  it("promotes a derived named grant permanently and reverses only by named revoke", async () => {
    const storage = await newStorage();
    const h = handler(storage, {
      newLinkBearer: () => "r".repeat(43),
    });
    await seedFileShare(h, "edit");
    seedStorageLink(storage, { grantId: "link-promotion", access: "comment" });
    for (const [grantId, principalUserId] of [
      ["named-promoted", "recipient-promotion-sentinel"],
      ["named-dependent-peer", "recipient-peer"],
    ] as const) {
      expect(
        seedDependentGrant(storage, {
          shareId: "share-existing",
          parentGrantId: "link-promotion",
          grantId,
          principalUserId,
          createdAtMs: 2_001,
        }),
      ).toMatchObject({ ok: true });
    }
    const selectorBefore = storage.getShare("share-existing")?.selectorJson;
    const independentPeerBefore = storage.getShareGrant("grant-0");

    const promotedResponse = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/grants/named-promoted/promote",
        jsonBody({
          workspaceId: WORKSPACE,
          expectedParentGrantId: "link-promotion",
          expectedParentGeneration: 1,
        }),
      ),
    );
    expect(promotedResponse.status).toBe(200);
    const promotedText = await promotedResponse.text();
    const promoted = JSON.parse(promotedText) as Record<string, unknown>;
    expect(promoted).toEqual({
      ok: true,
      grantId: "named-promoted",
      access: "comment",
      generation: 2,
      status: "active",
      revokedAtMs: null,
      parentGrantId: null,
    });
    for (const sentinel of [
      WORKSPACE,
      "recipient-promotion-sentinel",
      "link-promotion-credential",
      "r".repeat(43),
      "capability-sentinel",
      "session-sentinel",
    ]) {
      expect(promotedText).not.toContain(sentinel);
    }
    expect(storage.getShare("share-existing")?.selectorJson).toBe(selectorBefore);
    expect(storage.getShareGrant("named-promoted")).toMatchObject({
      access: "comment",
      generation: 2,
      status: "active",
      parentGrantId: null,
    });

    const rotateResponse = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/links/link-promotion/rotate",
        jsonBody({
          workspaceId: WORKSPACE,
          expectedDependentGrantIds: ["named-dependent-peer"],
        }),
      ),
    );
    expect(rotateResponse.status).toBe(200);
    expect(storage.getShareGrant("named-promoted")).toMatchObject({
      access: "comment",
      generation: 2,
      status: "active",
      parentGrantId: null,
    });

    const retuneResponse = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/links/link-promotion/retune",
        jsonBody({
          workspaceId: WORKSPACE,
          access: "view",
          expectedDependentGrantIds: ["named-dependent-peer"],
        }),
      ),
    );
    expect(retuneResponse.status).toBe(200);
    expect(storage.getShareGrant("named-promoted")).toMatchObject({
      access: "comment",
      generation: 2,
      status: "active",
    });

    const parentBeforeRevoke = storage.getShareGrant("link-promotion");
    const parentRevokeResponse = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/revoke",
        jsonBody({
          grantId: "link-promotion",
          workspaceId: WORKSPACE,
          expectedDependentGrantIds: ["named-dependent-peer"],
        }),
      ),
    );
    expect(parentRevokeResponse.status).toBe(200);
    expect(storage.getShareGrant("link-promotion")).toMatchObject({
      generation: Number(parentBeforeRevoke?.generation) + 1,
      status: "revoked",
    });
    expect(storage.getShareGrant("named-dependent-peer")).toMatchObject({
      status: "revoked",
    });
    expect(storage.getShareGrant("named-promoted")).toMatchObject({
      access: "comment",
      generation: 2,
      status: "active",
      parentGrantId: null,
    });
    expect(
      authorizeShareAction({
        storage,
        actorUserId: "recipient-promotion-sentinel",
        shareId: "share-existing",
        action: "append",
      }),
    ).toMatchObject({ ok: true, grant: { grantId: "named-promoted" } });

    const parentAfterRevoke = storage.getShareGrant("link-promotion");
    const revokeResponse = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/grants/named-promoted/revoke",
        jsonBody({ workspaceId: WORKSPACE }),
      ),
    );
    expect(revokeResponse.status).toBe(200);
    expect(await json(revokeResponse)).toMatchObject({
      ok: true,
      grantId: "named-promoted",
      access: "comment",
      generation: 3,
      status: "revoked",
      revokedAtMs: 2_000,
      parentGrantId: null,
    });
    expect(storage.getShareGrant("link-promotion")).toEqual(parentAfterRevoke);
    expect(storage.getShareGrant("grant-0")).toEqual(independentPeerBefore);
    expect(
      authorizeShareAction({
        storage,
        actorUserId: "recipient-promotion-sentinel",
        shareId: "share-existing",
        action: "read",
      }),
    ).toMatchObject({ ok: false });
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
    const retuneMissingBefore = storage.getShareGrant(
      "link-retune-missing-workspace",
    );
    const retuneMissing = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/links/link-retune-missing-workspace/retune",
        jsonBody({ access: "view", expectedDependentGrantIds: [] }),
      ),
    );
    expect(retuneMissing.status).toBe(400);
    expect(retuneShareGrant).not.toHaveBeenCalled();
    expect(storage.getShareGrant("link-retune-missing-workspace")).toEqual(
      retuneMissingBefore,
    );

    const retuneWrongBefore = storage.getShareGrant(
      "link-retune-wrong-workspace",
    );
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
    expect(storage.getShareGrant("link-retune-wrong-workspace")).toEqual(
      retuneWrongBefore,
    );

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
    const promoteMissingBefore = storage.getShareGrant(
      "named-promote-missing-workspace",
    );
    const promoteMissing = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/grants/named-promote-missing-workspace/promote",
        jsonBody(promotionExpectation),
      ),
    );
    expect(promoteMissing.status).toBe(400);
    expect(promoteShareGrant).not.toHaveBeenCalled();
    expect(storage.getShareGrant("named-promote-missing-workspace")).toEqual(
      promoteMissingBefore,
    );

    const promoteWrongBefore = storage.getShareGrant(
      "named-promote-wrong-workspace",
    );
    const promoteWrong = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/grants/named-promote-wrong-workspace/promote",
        jsonBody({ workspaceId: OTHER_WORKSPACE, ...promotionExpectation }),
      ),
    );
    expect(await denialBytes(promoteWrong)).toContain('"code":"not_found"');
    expect(promoteShareGrant).not.toHaveBeenCalled();
    expect(storage.getShareGrant("named-promote-wrong-workspace")).toEqual(
      promoteWrongBefore,
    );

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
    const revokeMissingBefore = storage.getShareGrant(
      "named-revoke-missing-workspace",
    );
    const revokeMissing = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/grants/named-revoke-missing-workspace/revoke",
        { method: "POST" },
      ),
    );
    expect(revokeMissing.status).toBe(400);
    expect(revokeShareGrant).not.toHaveBeenCalled();
    expect(storage.getShareGrant("named-revoke-missing-workspace")).toEqual(
      revokeMissingBefore,
    );

    const revokeWrongBefore = storage.getShareGrant(
      "named-revoke-wrong-workspace",
    );
    const revokeWrong = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/grants/named-revoke-wrong-workspace/revoke",
        jsonBody({ workspaceId: OTHER_WORKSPACE }),
      ),
    );
    expect(await denialBytes(revokeWrong)).toContain('"code":"not_found"');
    expect(revokeShareGrant).not.toHaveBeenCalled();
    expect(storage.getShareGrant("named-revoke-wrong-workspace")).toEqual(
      revokeWrongBefore,
    );

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

  it("revokes an active dependent grant that is no longer current", async () => {
    const { storage, dbPath } = await newStorageWithPath();
    const h = handler(storage);
    await seedFileShare(h, "edit");
    seedStorageLink(storage, { grantId: "link-narrowed", access: "edit" });
    expect(
      seedDependentGrant(storage, {
        shareId: "share-existing",
        parentGrantId: "link-narrowed",
        grantId: "named-above-parent",
        principalUserId: "named-above-parent-user",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true, grant: { access: "edit" } });
    const database = inspectDatabase(dbPath);
    database
      .prepare("UPDATE sync_relay_share_grants SET access = 'view' WHERE grant_id = 'link-narrowed'")
      .run();
    database.close();

    const response = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/grants/named-above-parent/revoke",
        jsonBody({ workspaceId: WORKSPACE }),
      ),
    );
    expect(response.status).toBe(200);
    expect(storage.getShareGrant("named-above-parent")).toMatchObject({
      access: "edit",
      status: "revoked",
    });
  });

  it("rechecks the requested workspace inside link and named grant transactions", async () => {
    for (const transition of ["retune", "promote", "revoke"] as const) {
      const { storage, dbPath } = await newStorageWithPath();
      const configured = handler(storage);
      await seedFileShare(configured, "edit");
      expect(
        storage.claimWorkspace({
          workspaceId: OTHER_WORKSPACE,
          ownerUserId: OWNER,
          createdAtMs: 2_001,
        }),
      ).toBe("created");
      seedStorageLink(storage, {
        grantId: `link-workspace-race-${transition}`,
        access: "comment",
      });
      const namedGrantId = `named-workspace-race-${transition}`;
      expect(
        seedDependentGrant(storage, {
          shareId: "share-existing",
          parentGrantId: `link-workspace-race-${transition}`,
          grantId: namedGrantId,
          principalUserId: `${namedGrantId}-user`,
          createdAtMs: 2_002,
        }),
      ).toMatchObject({ ok: true });

      const moveShareThen =
        <M extends "retuneShareGrant" | "promoteShareGrant" | "removeShareAccess">(method: M) =>
        (target: SyncRelayStorage, ...args: Parameters<SyncRelayStorage[M]>) => {
          updateShareWorkspace(dbPath, "share-existing", OTHER_WORKSPACE);
          const real = target[method] as (
            this: SyncRelayStorage,
            ...input: Parameters<SyncRelayStorage[M]>
          ) => ReturnType<SyncRelayStorage[M]>;
          return real.call(target, ...args);
        };
      const racedStorage = interceptStorage(storage, {
        retuneShareGrant: transition === "retune" ? moveShareThen("retuneShareGrant") : undefined,
        promoteShareGrant: transition === "promote" ? moveShareThen("promoteShareGrant") : undefined,
        removeShareAccess: transition === "revoke" ? moveShareThen("removeShareAccess") : undefined,
      });
      const h = handler(racedStorage);
      const targetGrantId =
        transition === "retune"
          ? `link-workspace-race-${transition}`
          : namedGrantId;
      const before = storage.getShareGrant(targetGrantId);
      const response = await h(
        request(
          OWNER,
          transition === "retune"
            ? `/sync/shares/share-existing/links/${targetGrantId}/retune`
            : `/sync/shares/share-existing/grants/${targetGrantId}/${transition}`,
          transition === "retune"
            ? jsonBody({
                workspaceId: WORKSPACE,
                access: "view",
                expectedDependentGrantIds: [namedGrantId],
              })
            : transition === "promote"
              ? jsonBody({
                  workspaceId: WORKSPACE,
                  expectedParentGrantId: `link-workspace-race-${transition}`,
                  expectedParentGeneration: 1,
                })
              : jsonBody({ workspaceId: WORKSPACE }),
        ),
      );
      expect(await denialBytes(response), transition).toContain(
        '"code":"not_found"',
      );
      expect(storage.getShareGrant(targetGrantId)).toEqual(before);
    }
  });

  it("refuses stale or invalid named grant transitions without mutation or identity input", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h, "edit");
    seedStorageLink(storage, { grantId: "link-validation", access: "comment" });
    for (const grantId of ["named-stale", "named-promoted", "named-revoked"] as const) {
      expect(
        seedDependentGrant(storage, {
          shareId: "share-existing",
          parentGrantId: "link-validation",
          grantId,
          principalUserId: `${grantId}-user`,
          createdAtMs: 2_001,
        }),
      ).toMatchObject({ ok: true });
    }
    expect(
      storage.promoteShareGrant({
        shareId: "share-existing",
        grantId: "named-promoted",
        expectedParentGrantId: "link-validation",
        expectedParentGeneration: 1,
        guard: () => undefined,
      }),
    ).toMatchObject({ ok: true });
    expect(
      storage.revokeShareGrant({
        shareId: "share-existing",
        grantId: "named-revoked",
        revokedAtMs: 2_002,
      }),
    ).toMatchObject({ ok: true });
    expect(
      storage.rotateLinkGrant({
        shareId: "share-existing",
        grantId: "link-validation",
        rotatedAtMs: 2_003,
        expectedDependentGrantIds: ["named-stale"],
        guard: () => undefined,
        mintCredential: () => ({
          credentialId: "link-validation-rotated-credential",
          secretHash: hmac("rotated-validation-secret"),
        }),
      }),
    ).toMatchObject({ ok: true });

    storage.createShare({
      share: {
        shareId: "share-email-pending",
        workspaceId: WORKSPACE,
        granterUserId: OWNER,
        selectorJson: JSON.stringify({ paths: ["email"], versionId: null }),
        createdAtMs: 2_003,
      },
      grant: {
        grantId: "grant-email-pending",
        shareId: "share-email-pending",
        principalKind: "email",
        principalUserId: null,
        principalEmail: "pending@example.test",
        access: "view",
        generation: 1,
        status: "active",
        createdAtMs: 2_003,
        revokedAtMs: null,
        parentGrantId: null,
      },
    });
    storage.createShare({
      share: {
        shareId: "share-cross",
        workspaceId: WORKSPACE,
        granterUserId: OWNER,
        selectorJson: JSON.stringify({ paths: ["cross"], versionId: null }),
        createdAtMs: 2_004,
      },
      grant: {
        grantId: "grant-cross-independent",
        shareId: "share-cross",
        principalKind: "user",
        principalUserId: "cross-user",
        principalEmail: null,
        access: "view",
        generation: 1,
        status: "active",
        createdAtMs: 2_004,
        revokedAtMs: null,
        parentGrantId: null,
      },
    });
    seedStorageLink(storage, {
      shareId: "share-cross",
      grantId: "link-cross",
      access: "view",
      createdAtMs: 2_005,
    });
    expect(
      seedDependentGrant(storage, {
        shareId: "share-cross",
        parentGrantId: "link-cross",
        grantId: "named-cross",
        principalUserId: "cross-derived-user",
        createdAtMs: 2_006,
      }),
    ).toMatchObject({ ok: true });

    const promotionPath =
      "/sync/shares/share-existing/grants/named-stale/promote";
    const promotionBody = {
      workspaceId: WORKSPACE,
      expectedParentGrantId: "link-validation",
      expectedParentGeneration: 1,
    };
    const beforeStale = storage.getShareGrant("named-stale");
    const missingBytes = await denialBytes(
      await h(
        request(
          OWNER,
          "/sync/shares/share-missing/grants/named-stale/promote",
          jsonBody(promotionBody),
        ),
      ),
    );
    for (const [body, expectedStatus] of [
      [
        {
          workspaceId: WORKSPACE,
          expectedParentGrantId: "link-other",
          expectedParentGeneration: 2,
        },
        404,
      ],
      [promotionBody, 404],
      [{ ...promotionBody, principalUserId: "forged-user" }, 400],
      [{ ...promotionBody, ownerUserId: OWNER }, 400],
      [{ workspaceId: WORKSPACE, expectedParentGrantId: "link-validation" }, 400],
      [
        {
          workspaceId: WORKSPACE,
          expectedParentGrantId: "link-validation",
          expectedParentGeneration: 1.5,
        },
        400,
      ],
    ] as const) {
      const response = await h(request(OWNER, promotionPath, jsonBody(body)));
      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === 404) {
        expect(await denialBytes(response)).toBe(missingBytes);
      }
      expect(storage.getShareGrant("named-stale")).toEqual(beforeStale);
    }

    const invalidPromotions = [
      ["share-existing", "named-promoted", "link-validation"],
      ["share-existing", "named-revoked", "link-validation"],
      ["share-existing", "grant-0", "link-validation"],
      ["share-existing", "link-validation", "link-validation"],
      ["share-email-pending", "grant-email-pending", "link-validation"],
      ["share-existing", "named-cross", "link-cross"],
    ] as const;
    for (const [shareId, grantId, expectedParentGrantId] of invalidPromotions) {
      const before = storage.getShareGrant(grantId);
      const response = await h(
        request(
          OWNER,
          `/sync/shares/${shareId}/grants/${grantId}/promote`,
          jsonBody({
            workspaceId: WORKSPACE,
            expectedParentGrantId,
            expectedParentGeneration: 1,
          }),
        ),
      );
      expect(response.status).toBe(404);
      expect(storage.getShareGrant(grantId)).toEqual(before);
    }

    const recipientBefore = storage.getShareGrant("named-stale");
    const forgedRecipient = await h(
      request(
        RECIPIENT,
        promotionPath,
        jsonBody({ ...promotionBody, ownerUserId: OWNER }),
      ),
    );
    expect(await denialBytes(forgedRecipient)).toBe(missingBytes);
    expect(storage.getShareGrant("named-stale")).toEqual(recipientBefore);

    const invalidRevocations = [
      ["share-existing", "link-validation"],
      ["share-email-pending", "grant-email-pending"],
      ["share-existing", "named-cross"],
      ["share-existing", "named-revoked"],
    ] as const;
    for (const [shareId, grantId] of invalidRevocations) {
      const before = storage.getShareGrant(grantId);
      const response = await h(
        request(
          OWNER,
          `/sync/shares/${shareId}/grants/${grantId}/revoke`,
          jsonBody({ workspaceId: WORKSPACE }),
        ),
      );
      expect(response.status).toBe(404);
      expect(storage.getShareGrant(grantId)).toEqual(before);
    }
    const forgedRevoke = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/grants/named-stale/revoke",
        jsonBody({ workspaceId: WORKSPACE, recipientUserId: "forged-user" }),
      ),
    );
    expect(forgedRevoke.status).toBe(400);
    expect(storage.getShareGrant("named-stale")).toEqual(beforeStale);

    for (const operation of ["promote", "revoke"] as const) {
      let ownershipChecks = 0;
      const changedOwnerStorage = interceptStorage(storage, {
        workspaceIsOwnedBy: () => {
          ownershipChecks += 1;
          return ownershipChecks === 1;
        },
      });
      const response = await handler(changedOwnerStorage)(
        request(
          OWNER,
          `/sync/shares/share-existing/grants/named-stale/${operation}`,
          operation === "promote" ? jsonBody({
            workspaceId: WORKSPACE,
            expectedParentGrantId: "link-validation",
            expectedParentGeneration: 2,
          }) : jsonBody({ workspaceId: WORKSPACE }),
        ),
      );
      expect(await denialBytes(response)).toBe(missingBytes);
      expect(ownershipChecks).toBe(2);
      expect(storage.getShareGrant("named-stale")).toEqual(beforeStale);
    }
  });
});

describe("owner link inventory and impact preconditions", () => {
  it("pages 1,001 promoted recipients for one linked share", async () => {
    const storage = await newStorage();
    expect(
      storage.claimWorkspace({
        workspaceId: WORKSPACE,
        ownerUserId: OWNER,
        createdAtMs: 2_000,
      }),
    ).toBe("created");
    expect(
      storage.createFileLinkShare({
        share: {
          shareId: "share-independent-pages",
          workspaceId: WORKSPACE,
          granterUserId: OWNER,
          selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }),
          createdAtMs: 2_001,
        },
        grant: {
          grantId: "link-independent-pages",
          shareId: "share-independent-pages",
          principalKind: "link",
          principalUserId: null,
          principalEmail: null,
          access: "comment",
          generation: 1,
          status: "active",
          createdAtMs: 2_001,
          revokedAtMs: null,
          parentGrantId: null,
        },
        credential: {
          credentialId: "link-independent-pages-credential",
          grantId: "link-independent-pages",
          secretHash: hmac("link-independent-pages-secret"),
          generation: 1,
          mintedAtMs: 2_001,
          retiredAtMs: null,
        },
        guard: () => {},
      }),
    ).toBe(true);

    const expectedGrantIds = Array.from({ length: 1_001 }, (_, index) =>
      `grant-promoted-${String(index).padStart(4, "0")}`,
    );
    const fixture = inspectDatabase(storagePath(storage));
    try {
      fixture.exec("BEGIN IMMEDIATE");
      const insert = fixture.prepare(
        `INSERT INTO sync_relay_share_grants (
           grant_id, share_id, principal_kind, principal_user_id, principal_email,
           access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id
         ) VALUES (?, 'share-independent-pages', 'user', ?, NULL,
           'comment', 1, 'active', 3000, NULL, 'link-independent-pages')`,
      );
      for (const [index, grantId] of expectedGrantIds.entries()) {
        expect(Number(insert.run(grantId, `recipient-${String(index).padStart(4, "0")}`).changes)).toBe(1);
      }
      fixture.exec("COMMIT");
    } catch (error) {
      try { fixture.exec("ROLLBACK"); } catch { /* Preserve the setup failure. */ }
      throw error;
    } finally {
      fixture.close();
    }
    for (const [index, grantId] of expectedGrantIds.entries()) {
      expect(storage.getShareGrant(grantId)).toMatchObject({
        grantId, shareId: "share-independent-pages", parentGrantId: "link-independent-pages",
        principalKind: "user", principalUserId: `recipient-${String(index).padStart(4, "0")}`,
        access: "comment", generation: 1, status: "active", revokedAtMs: null,
      });
    }
    for (const grantId of expectedGrantIds) {
      expect(
        storage.promoteShareGrant({
          shareId: "share-independent-pages",
          grantId,
          expectedParentGrantId: "link-independent-pages",
          expectedParentGeneration: 1,
          guard: () => {},
        }),
      ).toMatchObject({ ok: true, grant: { parentGrantId: null } });
    }

    const h = handler(storage);
    const firstResponse = await h(
      request(OWNER, `/sync/${WORKSPACE}/shares/links`),
    );
    expect(firstResponse.status).toBe(200);
    const first = await json(firstResponse);
    expect(first.links).toHaveLength(1);
    const firstGrants = first.independentGrants as Array<Record<string, unknown>>;
    expect(firstGrants).toHaveLength(LINK_INVENTORY_PAGE_SIZE);
    expect(first).not.toHaveProperty("nextCursor");
    expect(first.nextIndependentGrantCursor).toEqual(expect.any(String));

    const secondResponse = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/links?independentGrantCursor=${encodeURIComponent(String(first.nextIndependentGrantCursor))}`,
      ),
    );
    expect(secondResponse.status).toBe(200);
    const second = await json(secondResponse);
    expect(second.links).toEqual([]);
    const secondGrants = second.independentGrants as Array<Record<string, unknown>>;
    expect(secondGrants).toHaveLength(1);
    expect(second).not.toHaveProperty("nextIndependentGrantCursor");

    const grantIds = [...firstGrants, ...secondGrants].map((row) =>
      String(row.grantId),
    );
    expect(grantIds).toEqual(expectedGrantIds);
    expect(new Set(grantIds).size).toBe(expectedGrantIds.length);
  }, 30_000);

  it("pages 1,001 links without splitting dependents or losing concurrent changes", async () => {
    const storage = await newStorage();
    const { storage: countedStorage, calls: independentGrantPageReads } = countStorageCalls(
      storage,
      "listActiveIndependentShareGrants",
    );
    const h = handler(countedStorage, {
      lookupUserEmail: (userId) => `${userId}@example.test`,
    });
    await seedFileShare(h);
    for (const shareId of ["share-a-tail", "share-z-tail"] as const) {
      storage.createShare({
        share: {
          shareId,
          workspaceId: WORKSPACE,
          granterUserId: OWNER,
          selectorJson: JSON.stringify({ paths: [shareId], versionId: null }),
          createdAtMs: 2_500,
        },
        grant: {
          grantId: `${shareId}-recipient`,
          shareId,
          principalKind: shareId === "share-a-tail" ? "email" : "user",
          principalUserId: shareId === "share-a-tail" ? null : RECIPIENT,
          principalEmail:
            shareId === "share-a-tail" ? "pending@example.test" : null,
          access: "view",
          generation: 1,
          status: "active",
          createdAtMs: 2_500,
          revokedAtMs: null,
          parentGrantId: null,
        },
      });
      expect(storage.getShare(shareId)).not.toBeNull();
    }
    expect(
      storage.claimWorkspace({
        workspaceId: OTHER_WORKSPACE,
        ownerUserId: OWNER,
        createdAtMs: 2_600,
      }),
    ).toBe("created");
    for (const [shareId, workspaceId] of [
      ["share-unlinked", WORKSPACE],
      ["share-other-workspace", OTHER_WORKSPACE],
    ] as const) {
      storage.createShare({
        share: {
          shareId,
          workspaceId,
          granterUserId: OWNER,
          selectorJson: JSON.stringify({ paths: [shareId], versionId: null }),
          createdAtMs: 2_600,
        },
        grant: {
          grantId: `${shareId}-recipient`,
          shareId,
          principalKind: "user",
          principalUserId: `${shareId}-user`,
          principalEmail: null,
          access: "view",
          generation: 1,
          status: "active",
          createdAtMs: 2_600,
          revokedAtMs: null,
          parentGrantId: null,
        },
      });
    }
    const linkSeeds = [
      ...Array.from({ length: 997 }, (_, index) => ({
        grantId: `link-${String(index).padStart(4, "0")}`,
        shareId: "share-existing",
        createdAtMs: 3_000 + index,
      })),
      { grantId: "zzz-share-a", shareId: "share-a-tail", createdAtMs: 9_000 },
      { grantId: "aaa-share-z-b", shareId: "share-z-tail", createdAtMs: 4_000 },
      { grantId: "aaa-share-z-c", shareId: "share-z-tail", createdAtMs: 4_000 },
      { grantId: "aaa-share-z-a", shareId: "share-z-tail", createdAtMs: 4_001 },
    ];
    const originalIds = linkSeeds.map((seed) => seed.grantId);
    for (const [index, seed] of linkSeeds.entries()) {
      seedStorageLink(storage, {
        grantId: seed.grantId,
        access: index % 3 === 0 ? "view" : index % 3 === 1 ? "comment" : "edit",
        createdAtMs: seed.createdAtMs,
        shareId: seed.shareId,
      });
    }
    const boundaryGrantId = originalIds[999]!;
    for (const suffix of ["a", "m", "z"] as const) {
      expect(
        seedDependentGrant(storage, {
          shareId: "share-z-tail",
          parentGrantId: boundaryGrantId,
          grantId: `dependent-boundary-${suffix}`,
          principalUserId: `boundary-user-${suffix}`,
          createdAtMs: 5_000,
        }),
      ).toMatchObject({ ok: true });
    }
    expect(
      seedDependentGrant(storage, {
        shareId: "share-z-tail",
        parentGrantId: boundaryGrantId,
        grantId: "independent-revoked",
        principalUserId: "revoked-user",
        createdAtMs: 5_001,
      }),
    ).toMatchObject({ ok: true });
    expect(
      storage.promoteShareGrant({
        shareId: "share-z-tail",
        grantId: "independent-revoked",
        expectedParentGrantId: boundaryGrantId,
        expectedParentGeneration: 1,
        guard: () => {},
      }),
    ).toMatchObject({ ok: true, grant: { parentGrantId: null } });
    expect(
      storage.revokeShareGrant({
        shareId: "share-z-tail",
        grantId: "independent-revoked",
        revokedAtMs: 5_002,
      }),
    ).toMatchObject({ ok: true, grant: { status: "revoked" } });

    expect(
      storage
        .listActiveIndependentShareGrants({
          workspaceId: WORKSPACE,
          shareIds: ["share-existing", "share-other-workspace"],
        })
        .grants
        .map((grant) => grant.grantId),
    ).toEqual(["grant-0"]);

    const storageFirst = storage.listLinkGrantsByWorkspace(WORKSPACE);
    expect(storageFirst.links).toHaveLength(1_000);
    expect(storageFirst.links.map((row) => row.grant.grantId)).toEqual(
      originalIds.slice(0, 1_000),
    );
    expect(storageFirst.links.at(-1)?.dependents.map((row) => row.grantId)).toEqual([
      "dependent-boundary-a",
      "dependent-boundary-m",
      "dependent-boundary-z",
    ]);
    expect(storageFirst.nextCursor).toEqual({
      shareCreatedAtMs: 2_500,
      shareId: "share-z-tail",
      linkCreatedAtMs: 4_000,
      grantId: boundaryGrantId,
    });
    const storageSecond = storage.listLinkGrantsByWorkspace(
      WORKSPACE,
      storageFirst.nextCursor!,
    );
    expect(storageSecond.links.map((row) => row.grant.grantId)).toEqual([
      originalIds[1_000],
    ]);
    expect(storageSecond.nextCursor).toBeNull();

    const firstResponse = await h(request(OWNER, `/sync/${WORKSPACE}/shares/links`));
    expect(firstResponse.status).toBe(200);
    const firstBody = await json(firstResponse);
    const firstLinks = firstBody.links as Array<Record<string, unknown>>;
    const firstIndependentGrants = firstBody.independentGrants as Array<
      Record<string, unknown>
    >;
    const cursor = String(firstBody.nextCursor);
    expect(firstBody).not.toHaveProperty("granted");
    expect(firstBody).not.toHaveProperty("received");
    expect(firstLinks).toHaveLength(LINK_INVENTORY_PAGE_SIZE);
    expect(firstIndependentGrants.map((grant) => grant.grantId)).toEqual([
      "share-a-tail-recipient",
      "grant-0",
      "share-z-tail-recipient",
    ]);
    expect(firstIndependentGrants[0]).toMatchObject({
      recipientUserId: null,
      recipientEmail: "pending@example.test",
    });
    expect(firstIndependentGrants[1]).toMatchObject({
      recipientUserId: RECIPIENT,
      recipientEmail: `${RECIPIENT}@example.test`,
    });
    expect(firstIndependentGrants.map((grant) => grant.grantId)).not.toContain(
      "independent-revoked",
    );
    expect(firstIndependentGrants.map((grant) => grant.grantId)).not.toContain(
      "dependent-boundary-a",
    );
    expect(firstIndependentGrants.map((grant) => grant.grantId)).not.toContain(
      "share-unlinked-recipient",
    );
    expect(firstIndependentGrants.map((grant) => grant.grantId)).not.toContain(
      "share-other-workspace-recipient",
    );
    expect(independentGrantPageReads).toHaveLength(1);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,1024}$/u);
    expect(firstLinks.at(-1)).toMatchObject({
      grantId: boundaryGrantId,
      dependents: [
        { grantId: "dependent-boundary-a" },
        { grantId: "dependent-boundary-m" },
        { grantId: "dependent-boundary-z" },
      ],
    });

    const tailGrantId = originalIds[1_000]!;
    expect(
      storage.revokeShareGrant({
        shareId: "share-z-tail",
        grantId: tailGrantId,
        revokedAtMs: 6_000,
        expectedDependentGrantIds: [],
      }),
    ).toMatchObject({ ok: true, grant: { status: "revoked" } });
    seedStorageLink(storage, {
      grantId: "link-concurrent-behind",
      access: "view",
      createdAtMs: 2_500,
    });

    const secondResponse = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/links?cursor=${encodeURIComponent(cursor)}`,
      ),
    );
    expect(secondResponse.status).toBe(200);
    const secondBody = await json(secondResponse);
    const secondLinks = secondBody.links as Array<Record<string, unknown>>;
    const secondIndependentGrants = secondBody.independentGrants as Array<
      Record<string, unknown>
    >;
    expect(secondLinks).toEqual([
      expect.objectContaining({ grantId: tailGrantId, status: "revoked" }),
    ]);
    expect(secondIndependentGrants.map((grant) => grant.grantId)).toEqual([
      "share-z-tail-recipient",
    ]);
    expect(independentGrantPageReads).toHaveLength(2);
    expect(secondBody).not.toHaveProperty("nextCursor");
    const union = [...firstLinks, ...secondLinks].map((row) => String(row.grantId));
    expect(union).toEqual(originalIds);
    expect(new Set(union).size).toBe(originalIds.length);
    expect(union).not.toContain("link-concurrent-behind");

    const refreshedFirst = await json(
      await h(request(OWNER, `/sync/${WORKSPACE}/shares/links`)),
    );
    const refreshedSecond = await json(
      await h(
        request(
          OWNER,
          `/sync/${WORKSPACE}/shares/links?cursor=${encodeURIComponent(String(refreshedFirst.nextCursor))}`,
        ),
      ),
    );
    const refreshedIds = [
      ...(refreshedFirst.links as Array<Record<string, unknown>>),
      ...(refreshedSecond.links as Array<Record<string, unknown>>),
    ].map((row) => String(row.grantId));
    expect(refreshedIds).toHaveLength(1_002);
    expect(refreshedIds[0]).toBe("link-concurrent-behind");
    expect(refreshedIds).toContain(tailGrantId);

    const malformed = await h(
      request(OWNER, `/sync/${WORKSPACE}/shares/links?cursor=not-json`),
    );
    expect(malformed.status).toBe(400);
    await expect(json(malformed)).resolves.toMatchObject({
      ok: false,
      code: "bad_request",
    });
    const malformedIndependent = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/links?independentGrantCursor=not-json`,
      ),
    );
    expect(malformedIndependent.status).toBe(400);
    await expect(json(malformedIndependent)).resolves.toMatchObject({
      ok: false,
      code: "bad_request",
    });
    const repeatedIndependent = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/links?independentGrantCursor=a&independentGrantCursor=b`,
      ),
    );
    expect(repeatedIndependent.status).toBe(400);
  });

  it("lists distinct active, revoked, and damaged links with resolved and unresolved dependents", async () => {
    const storage = await newStorage();
    const h = handler(storage, {
      lookupUserEmail: async (userId) => {
        if (userId === "resolved-user") return "resolved@example.test";
        throw new Error("directory unavailable");
      },
    });
    await seedFileShare(h);
    const activeLink = await createLink(h);
    const revokedLink = await createLink(h);
    const activeGrantId = String(activeLink.grantId);
    const revokedGrantId = String(revokedLink.grantId);
    expect(
      seedDependentGrant(storage, {
        shareId: "share-existing",
        parentGrantId: activeGrantId,
        grantId: "dependent-z-resolved",
        principalUserId: "resolved-user",
        createdAtMs: 2_002,
      }),
    ).toMatchObject({ ok: true });
    expect(
      seedDependentGrant(storage, {
        shareId: "share-existing",
        parentGrantId: activeGrantId,
        grantId: "dependent-a-unresolved",
        principalUserId: "unresolved-user",
        createdAtMs: 2_003,
      }),
    ).toMatchObject({ ok: true });
    expect(
      (
        await h(
          request(
            OWNER,
            "/sync/shares/share-existing/revoke",
            jsonBody({
              grantId: revokedGrantId,
              workspaceId: WORKSPACE,
              expectedDependentGrantIds: [],
            }),
          ),
        )
      ).status,
    ).toBe(200);

    storage.createShare({
      share: {
        shareId: "share-damaged",
        workspaceId: WORKSPACE,
        granterUserId: OWNER,
        selectorJson: JSON.stringify({ kind: "chat", channelWireId: 42 }),
        createdAtMs: 3_000,
      },
      grant: {
        grantId: "damaged-seed-user",
        shareId: "share-damaged",
        principalKind: "user",
        principalUserId: "unrelated-recipient",
        principalEmail: null,
        access: "view",
        generation: 1,
        status: "active",
        createdAtMs: 3_000,
        revokedAtMs: null,
        parentGrantId: null,
      },
    });
    expect(
      storage.createLinkGrant({
        grant: {
          grantId: "link-damaged",
          shareId: "share-damaged",
          principalKind: "link",
          principalUserId: null,
          principalEmail: null,
          access: "view",
          generation: 1,
          status: "active",
          createdAtMs: 3_000,
          revokedAtMs: null,
          parentGrantId: null,
        },
        credential: {
          credentialId: "damaged-credential",
          grantId: "link-damaged",
          secretHash: hmac("d".repeat(43)),
          generation: 1,
          mintedAtMs: 3_000,
          retiredAtMs: null,
        },
      }),
    ).toBe(true);

    const response = await h(request(OWNER, `/sync/${WORKSPACE}/shares/links`));
    expect(response.status).toBe(200);
    const serialized = await response.text();
    const body = JSON.parse(serialized) as Record<string, unknown>;
    const links = body.links as Array<Record<string, unknown>>;
    expect(body.ok).toBe(true);
    expect(links.map((row) => row.grantId)).toEqual([
      activeGrantId,
      revokedGrantId,
      "link-damaged",
    ]);
    expect(links[0]).toEqual({
      shareId: "share-existing",
      grantId: activeGrantId,
      selector: { paths: ["docs"], versionId: null },
      access: "view",
      generation: 1,
      status: "active",
      createdAtMs: 2_000,
      revokedAtMs: null,
      lastUsedAtMs: null,
      urlIssuedAtMs: 2_000,
      dependents: [
        {
          grantId: "dependent-a-unresolved",
          recipientUserId: "unresolved-user",
          recipientEmail: null,
          access: "view",
          generation: 1,
          createdAtMs: 2_003,
        },
        {
          grantId: "dependent-z-resolved",
          recipientUserId: "resolved-user",
          recipientEmail: "resolved@example.test",
          access: "view",
          generation: 1,
          createdAtMs: 2_002,
        },
      ],
    });
    expect(links[1]).toMatchObject({
      shareId: "share-existing",
      grantId: revokedGrantId,
      selector: { paths: ["docs"], versionId: null },
      access: "view",
      generation: 2,
      status: "revoked",
      createdAtMs: 2_000,
      revokedAtMs: 2_000,
      lastUsedAtMs: null,
      urlIssuedAtMs: null,
      dependents: [],
    });
    expect(links[2]).toEqual({
      shareId: "share-damaged",
      grantId: "link-damaged",
      selector: null,
      damaged: true,
      selectorKind: "chat",
      access: "view",
      generation: 1,
      status: "active",
      createdAtMs: 3_000,
      revokedAtMs: null,
      lastUsedAtMs: null,
      urlIssuedAtMs: 3_000,
      dependents: [],
    });
    expect(serialized).not.toContain("workspace-links");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain('"url":');
    expect(serialized).not.toContain("credential");
  });

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
        await h(
          request("not-owner", `/sync/${WORKSPACE}/shares/links?cursor=not-json`),
        ),
      ),
    ).toBe(missing);
    expect(
      await denialBytes(
        await h(
          request(
            "not-owner",
            `/sync/${WORKSPACE}/shares/links?independentGrantCursor=not-json`,
          ),
        ),
      ),
    ).toBe(missing);

    const formerOwnerStorage = interceptStorage(storage, { workspaceIsOwnedBy: () => false });
    expect(
      await denialBytes(
        await handler(formerOwnerStorage)(
          request(OWNER, `/sync/${WORKSPACE}/shares/links`),
        ),
      ),
    ).toBe(missing);
  });

  it("projects conversion, promotion, rotate, retune, and revoke changes", async () => {
    const storage = await newStorage();
    const h = handler(storage, {
      lookupUserEmail: (userId) => `${userId}@example.test`,
    });
    await seedFileShare(h, "edit");
    seedStorageLink(storage, { grantId: "link-lifecycle", access: "comment" });
    expect(projectedDependentIds((await ownerLinkInventory(h))[0]!)).toEqual([]);

    expect(
      seedDependentGrant(storage, {
        shareId: "share-existing",
        parentGrantId: "link-lifecycle",
        grantId: "dependent-lifecycle",
        principalUserId: "lifecycle-user",
        createdAtMs: 2_002,
      }),
    ).toMatchObject({ ok: true });
    expect((await ownerLinkInventory(h))[0]).toMatchObject({
      grantId: "link-lifecycle",
      access: "comment",
      generation: 1,
      dependents: [
        {
          grantId: "dependent-lifecycle",
          recipientUserId: "lifecycle-user",
          recipientEmail: "lifecycle-user@example.test",
          access: "comment",
          generation: 1,
        },
      ],
    });

    const rotate = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/links/link-lifecycle/rotate",
        jsonBody({
          workspaceId: WORKSPACE,
          expectedDependentGrantIds: ["dependent-lifecycle"],
        }),
      ),
    );
    expect(rotate.status).toBe(200);
    expect((await ownerLinkInventory(h))[0]).toMatchObject({
      access: "comment",
      generation: 2,
      dependents: [{ grantId: "dependent-lifecycle", generation: 2 }],
    });

    const retune = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/links/link-lifecycle/retune",
        jsonBody({
          workspaceId: WORKSPACE,
          access: "view",
          expectedDependentGrantIds: ["dependent-lifecycle"],
        }),
      ),
    );
    expect(retune.status).toBe(200);
    expect((await ownerLinkInventory(h))[0]).toMatchObject({
      access: "view",
      generation: 2,
      dependents: [
        { grantId: "dependent-lifecycle", access: "view", generation: 3 },
      ],
    });

    expect(
      storage.promoteShareGrant({
        shareId: "share-existing",
        grantId: "dependent-lifecycle",
        expectedParentGrantId: "link-lifecycle",
        expectedParentGeneration: 2,
        guard: () => undefined,
      }),
    ).toMatchObject({ ok: true });
    expect(projectedDependentIds((await ownerLinkInventory(h))[0]!)).toEqual([]);

    const revoke = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/revoke",
        jsonBody({
          grantId: "link-lifecycle",
          workspaceId: WORKSPACE,
          expectedDependentGrantIds: [],
        }),
      ),
    );
    expect(revoke.status).toBe(200);
    expect((await ownerLinkInventory(h))[0]).toMatchObject({
      grantId: "link-lifecycle",
      status: "revoked",
      generation: 3,
      revokedAtMs: 2_000,
      dependents: [],
    });
  });

  it.each(["rotate", "retune", "revoke"] as const)(
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
      const route = operation === "revoke"
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

  it("refuses a stale confirmation after promotion so the warning cannot overstate impact", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const grantId = String((await createLink(h)).grantId);
    expect(
      seedDependentGrant(storage, {
        shareId: "share-existing",
        parentGrantId: grantId,
        grantId: "dependent-promoted-race",
        principalUserId: "promoted-user",
        createdAtMs: 2_002,
      }),
    ).toMatchObject({ ok: true });
    const shown = (await ownerLinkInventory(h)).find((row) => row.grantId === grantId)!;
    expect(projectedDependentIds(shown)).toEqual(["dependent-promoted-race"]);
    expect(
      storage.promoteShareGrant({
        shareId: "share-existing",
        grantId: "dependent-promoted-race",
        expectedParentGrantId: grantId,
        expectedParentGeneration: 1,
        guard: () => undefined,
      }),
    ).toMatchObject({ ok: true });
    const before = storage.getShareGrant(grantId);
    const refused = await h(
      request(
        OWNER,
        `/sync/shares/share-existing/links/${grantId}/rotate`,
        jsonBody({
          workspaceId: WORKSPACE,
          expectedDependentGrantIds: ["dependent-promoted-race"],
        }),
      ),
    );
    expect(refused.status).toBe(409);
    expect(await json(refused)).toMatchObject({
      ok: false,
      code: "dependents_changed",
      dependents: [],
    });
    expect(storage.getShareGrant(grantId)).toEqual(before);
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/shares/share-existing/links/${grantId}/rotate`,
            jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
          ),
        )
      ).status,
    ).toBe(200);
  });

  it("normalizes expected-id order and duplicates and refuses missing, malformed, unknown, or extra ids without writes", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const grantId = String((await createLink(h)).grantId);
    for (const dependentGrantId of ["dependent-a", "dependent-b"]) {
      expect(
        seedDependentGrant(storage, {
          shareId: "share-existing",
          parentGrantId: grantId,
          grantId: dependentGrantId,
          principalUserId: `${dependentGrantId}-user`,
          createdAtMs: 2_002,
        }),
      ).toMatchObject({ ok: true });
    }
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/shares/share-existing/links/${grantId}/rotate`,
            jsonBody({
              workspaceId: WORKSPACE,
              expectedDependentGrantIds: ["dependent-b", "dependent-a", "dependent-a"],
            }),
          ),
        )
      ).status,
    ).toBe(200);
    const beforeGrant = storage.getShareGrant(grantId);
    const beforeCredential = storage.getCurrentLinkCredential(grantId);

    const missingBody = await h(
      request(OWNER, `/sync/shares/share-existing/links/${grantId}/rotate`, {
        method: "POST",
      }),
    );
    expect(missingBody.status).toBe(400);
    const malformed = await h(
      request(
        OWNER,
        `/sync/shares/share-existing/links/${grantId}/rotate`,
        jsonBody({
          workspaceId: WORKSPACE,
          expectedDependentGrantIds: "dependent-a",
        }),
      ),
    );
    expect(malformed.status).toBe(400);
    for (const expectedDependentGrantIds of [
      ["dependent-a"],
      ["dependent-a", "dependent-b", "dependent-unknown"],
    ]) {
      const refused = await h(
        request(
          OWNER,
          `/sync/shares/share-existing/links/${grantId}/rotate`,
          jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds }),
        ),
      );
      expect(refused.status).toBe(409);
      expect(projectedDependentIds(await json(refused))).toEqual([
        "dependent-a",
        "dependent-b",
      ]);
    }
    const bareOwnerRevoke = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/revoke",
        jsonBody({ grantId, workspaceId: WORKSPACE }),
      ),
    );
    expect(bareOwnerRevoke.status).toBe(400);
    expect(storage.getShareGrant(grantId)).toEqual(beforeGrant);
    expect(storage.getCurrentLinkCredential(grantId)).toEqual(beforeCredential);
  });

  it("does not mint or retire a widening credential when the dependent set changed", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h, "edit");
    seedStorageLink(storage, { grantId: "link-widening", access: "comment" });
    expect(
      seedDependentGrant(storage, {
        shareId: "share-existing",
        parentGrantId: "link-widening",
        grantId: "dependent-widening",
        principalUserId: "widening-user",
        createdAtMs: 2_002,
      }),
    ).toMatchObject({ ok: true });
    const beforeGrant = storage.getShareGrant("link-widening");
    const beforeCredential = storage.getCurrentLinkCredential("link-widening");
    const mintCredential = vi.fn(() => ({
      credentialId: "must-not-be-minted",
      secretHash: hmac("w".repeat(43)),
    }));
    expect(
      storage.retuneShareGrant({
        shareId: "share-existing",
        grantId: "link-widening",
        access: "edit",
        changedAtMs: 2_003,
        expectedDependentGrantIds: [],
        guard: () => undefined,
        mintCredential,
      }),
    ).toMatchObject({
      ok: false,
      reason: "dependents-changed",
      dependents: [{ grantId: "dependent-widening" }],
    });
    expect(mintCredential).not.toHaveBeenCalled();
    expect(storage.getShareGrant("link-widening")).toEqual(beforeGrant);
    expect(storage.getCurrentLinkCredential("link-widening")).toEqual(beforeCredential);
  });

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
  it("records a successful exchange and advances usage on a later successful refresh", async () => {
    const storage = await newStorage();
    const relayExchangeKey = "share-web-relay-usage-key";
    let now = 2_000;
    let bearerByte = 1;
    const h = handler(storage, {
      relayExchangeKey,
      nowMs: () => now,
      newLinkBearer: () => Buffer.alloc(32, bearerByte++).toString("base64url"),
    });
    await seedFileShare(h);
    const created = await createLink(h);
    const grantId = String(created.grantId);
    expect(await ownerLinkInventoryRow(h, grantId)).toMatchObject({
      lastUsedAtMs: null,
      urlIssuedAtMs: 2_000,
    });

    now = 2_100;
    const exchangedResponse = await h(
      request(null, "/sync/link-exchange", {
        ...jsonBody({ secret: linkSecret(created.url) }),
        headers: {
          "content-type": "application/json",
          "x-dohc-relay-exchange-key": relayExchangeKey,
        },
      }),
    );
    expect(exchangedResponse.status).toBe(200);
    const exchanged = await json(exchangedResponse);
    expect(await ownerLinkInventoryRow(h, grantId)).toMatchObject({
      lastUsedAtMs: 2_100,
      urlIssuedAtMs: 2_000,
    });

    now = 2_400;
    const refreshed = await h(
      request(null, "/sync/link-refresh", {
        method: "POST",
        headers: {
          authorization: `LinkCapability ${String(exchanged.capabilityToken)}`,
          "x-dohc-relay-exchange-key": relayExchangeKey,
        },
      }),
    );
    expect(refreshed.status).toBe(200);
    const row = await ownerLinkInventoryRow(h, grantId);
    expect(row).toMatchObject({ lastUsedAtMs: 2_400, urlIssuedAtMs: 2_000 });
    expect(
      Object.keys(row)
        .filter((key) => /(used|issued|count|session|capability|ip|actor)/iu.test(key))
        .sort(),
    ).toEqual(["lastUsedAtMs", "urlIssuedAtMs"]);
  });

  it("does not record wrong secrets, exchange-key refusals, rate limits, or failed session inserts", async () => {
    const storage = await newStorage();
    const relayExchangeKey = "share-web-relay-usage-refusal-key";
    const limiter = new TokenBucketLimiter(1, 0.000_001, 10);
    let now = 2_000;
    const limited = handler(storage, {
      relayExchangeKey,
      linkExchangeGlobalRateLimiter: limiter,
      nowMs: () => now,
    });
    await seedFileShare(limited);
    const created = await createLink(limited);
    const grantId = String(created.grantId);
    const secret = linkSecret(created.url);

    const absentKey = await limited(
      request(null, "/sync/link-exchange", jsonBody({ secret })),
    );
    const wrongKey = await limited(
      request(null, "/sync/link-exchange", {
        ...jsonBody({ secret }),
        headers: {
          "content-type": "application/json",
          "x-dohc-relay-exchange-key": "wrong-key",
        },
      }),
    );
    const wrongSecret = await limited(
      request(null, "/sync/link-exchange", {
        ...jsonBody({ secret: "z".repeat(43) }),
        headers: {
          "content-type": "application/json",
          "x-dohc-relay-exchange-key": relayExchangeKey,
        },
      }),
    );
    const rateLimited = await limited(
      request(null, "/sync/link-exchange", {
        ...jsonBody({ secret }),
        headers: {
          "content-type": "application/json",
          "x-dohc-relay-exchange-key": relayExchangeKey,
        },
      }),
    );
    expect([absentKey, wrongKey, wrongSecret, rateLimited].map((response) => response.status))
      .toEqual([404, 404, 404, 429]);
    expect(await ownerLinkInventoryRow(limited, grantId)).toMatchObject({
      lastUsedAtMs: null,
    });

    now = 3_000;
    const h = handler(storage, { relayExchangeKey, nowMs: () => now });
    const exchanged = await json(
      await h(
        request(null, "/sync/link-exchange", {
          ...jsonBody({ secret }),
          headers: {
            "content-type": "application/json",
            "x-dohc-relay-exchange-key": relayExchangeKey,
          },
        }),
      ),
    );
    const capabilityToken = String(exchanged.capabilityToken);
    expect(await ownerLinkInventoryRow(h, grantId)).toMatchObject({ lastUsedAtMs: 3_000 });

    now = 3_100;
    const refusedRefresh = await h(
      request(null, "/sync/link-refresh", {
        method: "POST",
        headers: {
          authorization: `LinkCapability ${capabilityToken}`,
          "x-dohc-relay-exchange-key": "wrong-key",
        },
      }),
    );
    expect(refusedRefresh.status).toBe(404);
    expect(await ownerLinkInventoryRow(h, grantId)).toMatchObject({ lastUsedAtMs: 3_000 });

    expect(() =>
      storage.mintLinkSession({
        session: {
          sessionId: "failed-usage-session",
          capabilityHash: hmac(capabilityToken),
          grantId,
          generation: 1,
          mintedAtMs: 3_200,
          expiresAtMs: 3_200 + LINK_SESSION_TTL_MS,
        },
      }),
    ).toThrow();
    expect(await ownerLinkInventoryRow(h, grantId)).toMatchObject({ lastUsedAtMs: 3_000 });
  });

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
      (await h(request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(first.url) })))).status,
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

  it("clears usage on rotation and starts the replacement URL from its own mint time", async () => {
    const storage = await newStorage();
    let now = 2_000;
    const h = handler(storage, { nowMs: () => now });
    await seedFileShare(h);
    const created = await createLink(h);
    const grantId = String(created.grantId);
    const oldSecret = linkSecret(created.url);

    now = 2_100;
    expect(
      (await h(request(null, "/sync/link-exchange", jsonBody({ secret: oldSecret })))).status,
    ).toBe(200);
    expect(await ownerLinkInventoryRow(h, grantId)).toMatchObject({
      lastUsedAtMs: 2_100,
      urlIssuedAtMs: 2_000,
    });

    now = 3_000;
    const rotatedResponse = await h(
      request(
        OWNER,
        `/sync/shares/share-existing/links/${grantId}/rotate`,
        jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
      ),
    );
    expect(rotatedResponse.status).toBe(200);
    const rotated = await json(rotatedResponse);
    const newSecret = linkSecret(rotated.url);
    expect(newSecret).not.toBe(oldSecret);
    expect(await ownerLinkInventoryRow(h, grantId)).toMatchObject({
      lastUsedAtMs: null,
      urlIssuedAtMs: 3_000,
    });

    now = 3_100;
    expect(
      (await h(request(null, "/sync/link-exchange", jsonBody({ secret: oldSecret })))).status,
    ).toBe(404);
    expect(await ownerLinkInventoryRow(h, grantId)).toMatchObject({ lastUsedAtMs: null });

    now = 3_200;
    expect(
      (await h(request(null, "/sync/link-exchange", jsonBody({ secret: newSecret })))).status,
    ).toBe(200);
    expect(await ownerLinkInventoryRow(h, grantId)).toMatchObject({
      lastUsedAtMs: 3_200,
      urlIssuedAtMs: 3_000,
    });
  });

  it("preserves usage and URL mint time on narrowing but resets usage on widening", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h, "edit");
    const grantId = "storage-seeded-usage-link";
    seedStorageLink(storage, { grantId, access: "comment", createdAtMs: 2_100 });
    expect(
      storage.mintLinkSession({
        session: {
          sessionId: "storage-seeded-usage-session",
          capabilityHash: hmac("storage-seeded-usage-capability"),
          grantId,
          generation: 1,
          mintedAtMs: 2_200,
          expiresAtMs: 10_000,
        },
      }),
    ).toBe(true);

    expect(
      storage.retuneShareGrant({
        shareId: "share-existing",
        grantId,
        access: "view",
        changedAtMs: 2_300,
        expectedDependentGrantIds: [],
        guard: () => undefined,
      }),
    ).toMatchObject({ ok: true, grant: { access: "view", generation: 1 } });
    expect(await ownerLinkInventoryRow(h, grantId)).toMatchObject({
      lastUsedAtMs: 2_200,
      urlIssuedAtMs: 2_100,
    });

    expect(
      storage.retuneShareGrant({
        shareId: "share-existing",
        grantId,
        access: "comment",
        changedAtMs: 2_400,
        expectedDependentGrantIds: [],
        guard: () => undefined,
        mintCredential: () => ({
          credentialId: "storage-seeded-widened-credential",
          secretHash: hmac("storage-seeded-widened-secret"),
        }),
      }),
    ).toMatchObject({ ok: true, grant: { access: "comment", generation: 2 } });
    expect(await ownerLinkInventoryRow(h, grantId)).toMatchObject({
      lastUsedAtMs: null,
      urlIssuedAtMs: 2_400,
    });
  });

  it("keeps final usage on revoke and cascades it when the containing share is deleted", async () => {
    const { storage, dbPath } = await newStorageWithPath();
    let now = 2_000;
    const h = handler(storage, { nowMs: () => now });
    await seedFileShare(h);
    const created = await createLink(h);
    const grantId = String(created.grantId);

    now = 2_200;
    expect(
      (
        await h(
          request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(created.url) })),
        )
      ).status,
    ).toBe(200);
    now = 2_300;
    expect(
      (
        await h(
          request(
            OWNER,
            "/sync/shares/share-existing/revoke",
            jsonBody({
              grantId,
              workspaceId: WORKSPACE,
              expectedDependentGrantIds: [],
            }),
          ),
        )
      ).status,
    ).toBe(200);
    expect(await ownerLinkInventoryRow(h, grantId)).toMatchObject({
      status: "revoked",
      lastUsedAtMs: 2_200,
      urlIssuedAtMs: null,
    });

    const database = inspectDatabase(dbPath, { foreignKeys: true });
    try {
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM sync_relay_link_usage").get()?.count,
      ).toBe(1);
      expect(
        Number(
          database
            .prepare("DELETE FROM sync_relay_shares WHERE share_id = ?")
            .run("share-existing").changes,
        ),
      ).toBe(1);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM sync_relay_link_usage").get()?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it("never moves usage backward when an earlier session mint arrives late", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const grantId = String((await createLink(h)).grantId);
    for (const [sessionId, mintedAtMs] of [
      ["usage-newer", 5_000],
      ["usage-delayed-earlier", 4_000],
    ] as const) {
      expect(
        storage.mintLinkSession({
          session: {
            sessionId,
            capabilityHash: hmac(`${sessionId}-capability`),
            grantId,
            generation: 1,
            mintedAtMs,
            expiresAtMs: 20_000,
          },
        }),
      ).toBe(true);
    }
    expect(await ownerLinkInventoryRow(h, grantId)).toMatchObject({ lastUsedAtMs: 5_000 });
  });
});

describe("relay link grants", () => {
  it("conforms to every accepted state-machine transition", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);

    // Create user and create email both start active at generation 1.
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

    // Higher link levels remain a storage state-machine concern in Phase 2.
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

    // Convert makes a dependent named grant at the link's current access.
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

    // Narrow keeps the URL and generation while narrowing an over-wide dependent.
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

    // Widen link rotates the URL and bumps dependent bindings without widening them.
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
      (
        await h(request(null, "/sync/link-exchange", jsonBody({ secret: widenedSecret })))
      ).status,
    ).toBe(404);

    // Rotate preserves access, replaces the URL, and bumps dependent bindings.
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
          secretHash: hmac(rotatedSecret),
        }),
      }),
    ).toMatchObject({ ok: true, grant: { access: "edit", generation: 3 } });
    expect(rotatedSecret).not.toBe(widenedSecret);
    expect(storage.getShareGrant(linkGrantId)).toMatchObject({ access: "edit", generation: 3 });
    expect(storage.getShareGrant("grant-dependent")).toMatchObject({ generation: 4 });

    // Promote detaches one dependent permanently.
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

    // Revoke one link retires its credential and revokes only attached dependents.
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

    // A share may hold several independent links. Deleting it revokes all grants.
    const secondLink = await createLink(h);
    const thirdLink = await createLink(h);
    expect(secondLink.grantId).not.toBe(thirdLink.grantId);
    expect(
      (await h(request(OWNER, "/sync/shares/share-existing/revoke", { method: "POST" })))
        .status,
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

  it("refuses keyed revoke bodies without a valid grantId", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const created = await createLink(h);
    const grantId = String(created.grantId);

    const response = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/revoke",
        jsonBody({ grantID: grantId }),
      ),
    );
    expect.soft(response.status).toBe(404);
    expect.soft(await json(response)).toEqual({
      ok: false,
      error: "not found",
      code: "not_found",
    });
    expect(storage.getShareGrant(grantId)).toMatchObject({
      status: "active",
      revokedAtMs: null,
    });
  });

  it("requires an absent body to revoke a whole share", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const firstLink = await createLink(h);
    const secondLink = await createLink(h);
    const grantIds = ["grant-0", String(firstLink.grantId), String(secondLink.grantId)];

    const emptyObject = await h(
      request(OWNER, "/sync/shares/share-existing/revoke", jsonBody({})),
    );
    expect(emptyObject.status).toBe(404);
    expect(await json(emptyObject)).toEqual({
      ok: false,
      error: "not found",
      code: "not_found",
    });
    for (const grantId of grantIds) {
      expect(storage.getShareGrant(grantId)).toMatchObject({
        status: "active",
        revokedAtMs: null,
      });
    }

    const absentBody = await h(
      request(OWNER, "/sync/shares/share-existing/revoke", { method: "POST" }),
    );
    expect(absentBody.status).toBe(200);
    for (const grantId of grantIds) {
      expect(storage.getShareGrant(grantId)).toMatchObject({ status: "revoked" });
    }
  });

  it("uses the highest authority across every active recipient grant", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedIndependentEditAndDependentView(storage, h);

    for (const action of ["append", "propose"] as const) {
      expect(
        authorizeShareAction({
          storage,
          actorUserId: RECIPIENT,
          shareId: "share-existing",
          action,
        }),
        action,
      ).toMatchObject({
        ok: true,
        grant: { grantId: "grant-0", access: "edit" },
        effectiveSelector: { access: "edit" },
      });
    }

    const metadata = await json(
      await h(request(RECIPIENT, "/sync/shares/share-existing")),
    );
    expect(metadata).toMatchObject({
      grantId: "grant-0",
      access: "edit",
    });

    const received = (
      await json(await h(request(RECIPIENT, "/sync/shares")))
    ).received as Array<Record<string, unknown>>;
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      shareId: "share-existing",
      grantId: "grant-0",
      access: "edit",
    });
  });

  it("keeps independent authority after revoking a parent link", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const { dependentGrantId, linkGrantId } =
      await seedIndependentEditAndDependentView(storage, h);

    const revoked = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/revoke",
        jsonBody({
          grantId: linkGrantId,
          workspaceId: WORKSPACE,
          expectedDependentGrantIds: [dependentGrantId],
        }),
      ),
    );
    expect(revoked.status).toBe(200);
    expect(storage.getShareGrant(dependentGrantId)).toMatchObject({ status: "revoked" });
    expect(storage.getShareGrant("grant-0")).toMatchObject({
      status: "active",
      access: "edit",
    });
    for (const action of ["append", "propose"] as const) {
      expect(
        authorizeShareAction({
          storage,
          actorUserId: RECIPIENT,
          shareId: "share-existing",
          action,
        }),
        action,
      ).toMatchObject({
        ok: true,
        grant: { grantId: "grant-0", access: "edit" },
      });
    }
    expect(
      await json(await h(request(RECIPIENT, "/sync/shares/share-existing"))),
    ).toMatchObject({
      grantId: "grant-0",
      access: "edit",
    });
  });

  it("keeps link grants out of legacy share lists and summaries", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    await createLink(h);

    const ownerList = await json(await h(request(OWNER, "/sync/shares")));
    const granted = ownerList.granted as Array<Record<string, unknown>>;
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({
      shareId: "share-existing",
      grantId: "grant-0",
      principalKind: "user",
    });

    const recipientList = await json(await h(request(RECIPIENT, "/sync/shares")));
    const received = recipientList.received as Array<Record<string, unknown>>;
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      shareId: "share-existing",
      grantId: "grant-0",
      principalKind: "user",
    });

    const summaryResponse = await h(request(RECIPIENT, "/sync/shares/share-existing"));
    expect(summaryResponse.status).toBe(200);
    expect(await json(summaryResponse)).toMatchObject({
      shareId: "share-existing",
      grantId: "grant-0",
      principalKind: "user",
    });
  });

  it("keeps link dependents out of ordinary granted shares", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const link = await createLink(h);
    const linkGrantId = String(link.grantId);
    const dependentGrantId = "grant-link-recipient";
    const linkRecipient = "link-recipient";
    expect(
      seedDependentGrant(storage, {
        shareId: "share-existing",
        parentGrantId: linkGrantId,
        grantId: dependentGrantId,
        principalUserId: linkRecipient,
        createdAtMs: 2_001,
      }),
    ).toMatchObject({
      ok: true,
      grant: { parentGrantId: linkGrantId },
    });

    const ownerList = await json(await h(request(OWNER, "/sync/shares")));
    expect(
      (ownerList.granted as Array<Record<string, unknown>>).map((row) => row.grantId),
    ).toEqual(["grant-0"]);

    const recipientList = await json(await h(request(linkRecipient, "/sync/shares")));
    expect(recipientList.received).toEqual([
      expect.objectContaining({
        shareId: "share-existing",
        grantId: dependentGrantId,
        access: "view",
      }),
    ]);

    expect(projectedDependentIds(await ownerLinkInventoryRow(h, linkGrantId))).toEqual([
      dependentGrantId,
    ]);
  });

  it("requires current workspace ownership to create a link", async () => {
    const storage = await newStorage();
    let ownershipAnswers = [true];
    const ownershipStorage = interceptStorage(storage, {
      workspaceIsOwnedBy: () => ownershipAnswers.shift() ?? true,
    });
    const h = handler(ownershipStorage);
    expect(
      (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
    ).toBe(200);
    storage.createShare({
      share: {
        shareId: "share-existing",
        workspaceId: WORKSPACE,
        granterUserId: OWNER,
        selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }),
        createdAtMs: 2_000,
      },
      grant: {
        grantId: "grant-ownership-user",
        shareId: "share-existing",
        principalKind: "user",
        principalUserId: RECIPIENT,
        principalEmail: null,
        access: "view",
        generation: 1,
        status: "active",
        createdAtMs: 2_000,
        revokedAtMs: null,
        parentGrantId: null,
      },
    });

    ownershipAnswers = [true];
    const missing = await denialBytes(
      await h(
        request(
          OWNER,
          `/sync/${WORKSPACE}/shares/share-missing/links`,
          jsonBody({ access: "view" }),
        ),
      ),
    );
    // The workspace route gate passes first. The create guard then observes
    // the ownership loss that happened before its storage write.
    ownershipAnswers = [true, false];
    expect(
      await denialBytes(
        await h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/shares/share-existing/links`,
            jsonBody({ access: "view" }),
          ),
        ),
      ),
    ).toBe(missing);
    expect(storage.listSharesGrantedBy(OWNER).filter((row) => row.grant.principalKind === "link"))
      .toHaveLength(0);

    ownershipAnswers = [true, true];
    await createLink(h);
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
      request(
        OWNER,
        "/sync/shares/share-existing/revoke",
        { method: "POST" },
      ),
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

  it("keeps the link generation and bumps every dependent generation when it narrows", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const grantId = "storage-seeded-comment-generation-link";
    expect(
      storage.createLinkGrant({
        grant: {
          grantId,
          shareId: "share-existing",
          principalKind: "link",
          principalUserId: null,
          principalEmail: null,
          access: "comment",
          generation: 1,
          status: "active",
          createdAtMs: 2_000,
          revokedAtMs: null,
          parentGrantId: null,
        },
        credential: {
          credentialId: "storage-seeded-comment-generation-credential",
          grantId,
          secretHash: hmac("c".repeat(43)),
          generation: 1,
          mintedAtMs: 2_000,
          retiredAtMs: null,
        },
      }),
    ).toBe(true);
    expect(
      seedDependentGrant(storage, {
        shareId: "share-existing",
        parentGrantId: grantId,
        grantId: "grant-dependent-at-new-level",
        principalUserId: "converted-user",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true });

    expect(
      storage.retuneShareGrant({
        shareId: "share-existing",
        grantId,
        access: "edit",
        changedAtMs: 2_002,
        expectedDependentGrantIds: ["grant-dependent-at-new-level"],
        guard: () => undefined,
        mintCredential: () => ({
          credentialId: "storage-seeded-edit-generation-credential",
          secretHash: hmac("e".repeat(43)),
        }),
      }),
    ).toMatchObject({ ok: true, grant: { access: "edit", generation: 2 } });
    expect(storage.getShareGrant("grant-dependent-at-new-level")).toMatchObject({
      access: "comment",
      generation: 2,
    });

    expect(
      storage.retuneShareGrant({
        shareId: "share-existing",
        grantId,
        access: "comment",
        changedAtMs: 2_003,
        expectedDependentGrantIds: ["grant-dependent-at-new-level"],
        guard: () => undefined,
      }),
    ).toMatchObject({ ok: true, grant: { access: "comment", generation: 2 } });
    expect(storage.getShareGrant("grant-dependent-at-new-level")).toMatchObject({
      access: "comment",
      generation: 3,
    });
    expect(storage.getShareGrant(grantId)).toMatchObject({
      access: "comment",
      generation: 2,
    });
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

  it("bounds retired credential history across rotations and widening retunes", async () => {
    const { storage, dbPath } = await newStorageWithPath();
    const h = handler(storage);
    await seedFileShare(h);
    const created = await createLink(h);
    const grantId = String(created.grantId);
    const firstSecret = linkSecret(created.url);
    let currentSecret = firstSecret;

    for (let index = 1; index <= 15; index += 1) {
      currentSecret = Buffer.alloc(32, index).toString("base64url");
      expect(
        storage.rotateLinkGrant({
          shareId: "share-existing",
          grantId,
          rotatedAtMs: 2_000 + index,
          expectedDependentGrantIds: [],
          guard: () => undefined,
          mintCredential: () => ({
            credentialId: `credential-rotation-${index}`,
            secretHash: hmac(currentSecret),
          }),
        }),
      ).toMatchObject({ ok: true, grant: { generation: index + 1 } });
    }

    const inspection = inspectDatabase(dbPath, { readOnly: true });
    const credentialCounts = (): {
      total: number;
      retired: number;
      current: number;
    } => {
      const row = inspection
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN retired_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS retired,
                  SUM(CASE WHEN retired_at_ms IS NULL THEN 1 ELSE 0 END) AS current
           FROM sync_relay_link_credentials
           WHERE grant_id = ?`,
        )
        .get(grantId);
      return {
        total: Number(row?.total ?? 0),
        retired: Number(row?.retired ?? 0),
        current: Number(row?.current ?? 0),
      };
    };

    try {
      expect(credentialCounts()).toEqual({ total: 11, retired: 10, current: 1 });
      expect(
        inspection
          .prepare(
            `SELECT credential_id
             FROM sync_relay_link_credentials
             WHERE grant_id = ? AND secret_hash = ?`,
          )
          .get(grantId, hmac(firstSecret)),
      ).toBeUndefined();

      expect(
        (
          await h(
            request(null, "/sync/link-exchange", jsonBody({ secret: currentSecret })),
          )
        ).status,
      ).toBe(200);
      const missing = await denialBytes(
        await h(
          request(
            null,
            "/sync/link-exchange",
            jsonBody({ secret: "g".repeat(43) }),
          ),
        ),
      );
      expect(
        await denialBytes(
          await h(
            request(null, "/sync/link-exchange", jsonBody({ secret: firstSecret })),
          ),
        ),
      ).toBe(missing);

      const wideningSecret = Buffer.alloc(32, 31).toString("base64url");
      expect(
        storage.retuneShareGrant({
          shareId: "share-existing",
          grantId,
          access: "comment",
          changedAtMs: 2_016,
          expectedDependentGrantIds: [],
          guard: () => undefined,
          mintCredential: () => ({
            credentialId: "credential-widening",
            secretHash: hmac(wideningSecret),
          }),
        }),
      ).toMatchObject({ ok: true, grant: { access: "comment", generation: 17 } });
      expect(credentialCounts()).toEqual({ total: 11, retired: 10, current: 1 });
      const widenedExchange = await h(
        request(null, "/sync/link-exchange", jsonBody({ secret: wideningSecret })),
      );
      expect(widenedExchange.status).toBe(200);
      expect(await json(widenedExchange)).toMatchObject({
        grantId,
        access: "comment",
        generation: 17,
      });
    } finally {
      inspection.close();
    }
  });

  it("bounds live sessions per link grant without touching another grant", async () => {
    const limit = 3;
    const { storage, dbPath } = await newStorageWithPath({
      linkSessionsPerGrantLimit: limit,
    });
    const h = handler(storage);
    await seedFileShare(h);
    const cappedGrantId = String((await createLink(h)).grantId);
    const untouchedGrantId = String((await createLink(h)).grantId);
    const untouchedToken = "untouched-capability";
    expect(
      storage.mintLinkSession({
        session: {
          sessionId: "session-untouched",
          capabilityHash: hmac(untouchedToken),
          grantId: untouchedGrantId,
          generation: 1,
          mintedAtMs: 2_500,
          expiresAtMs: 10_000,
        },
      }),
    ).toBe(true);

    const inspection = inspectDatabase(dbPath, { readOnly: true });
    const countSessions = (grantId: string): number =>
      Number(
        inspection
          .prepare(
            "SELECT COUNT(*) AS count FROM sync_relay_link_sessions WHERE grant_id = ?",
          )
          .get(grantId)?.count ?? 0,
      );

    try {
      for (let index = 0; index <= limit; index += 1) {
        expect(
          storage.mintLinkSession({
            session: {
              sessionId: `session-capped-${index}`,
              capabilityHash: hmac(`capped-capability-${index}`),
              grantId: cappedGrantId,
              generation: 1,
              mintedAtMs: 3_000 + index,
              expiresAtMs: 10_000,
            },
          }),
        ).toBe(true);
        expect(countSessions(cappedGrantId)).toBe(
          Math.min(index + 1, limit),
        );
      }

      expect(
        validateLinkCapability({
          storage,
          capabilityToken: "capped-capability-0",
          linkKey: LINK_KEY,
          nowMs: 4_000,
        }),
      ).toBeNull();
      expect(
        validateLinkCapability({
          storage,
          capabilityToken: `capped-capability-${limit}`,
          linkKey: LINK_KEY,
          nowMs: 4_000,
        }),
      ).toMatchObject({ grantId: cappedGrantId });
      expect(countSessions(untouchedGrantId)).toBe(1);
      expect(
        validateLinkCapability({
          storage,
          capabilityToken: untouchedToken,
          linkKey: LINK_KEY,
          nowMs: 4_000,
        }),
      ).toMatchObject({ grantId: untouchedGrantId });
    } finally {
      inspection.close();
    }
  });

  it("refuses an active edit link grant exactly like an unknown secret", async () => {
    const access = "edit";
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const secret = "e".repeat(43);
    expect(
      storage.createLinkGrant({
        grant: {
          grantId: `storage-seeded-${access}-exchange-link`,
          shareId: "share-existing",
          principalKind: "link",
          principalUserId: null,
          principalEmail: null,
          access,
          generation: 1,
          status: "active",
          createdAtMs: 2_000,
          revokedAtMs: null,
          parentGrantId: null,
        },
        credential: {
          credentialId: `storage-seeded-${access}-exchange-credential`,
          grantId: `storage-seeded-${access}-exchange-link`,
          secretHash: hmac(secret),
          generation: 1,
          mintedAtMs: 2_000,
          retiredAtMs: null,
        },
      }),
    ).toBe(true);

    const unknownResponse = await h(
      request(
        null,
        "/sync/link-exchange",
        jsonBody({ secret: "g".repeat(43) }),
      ),
    );
    const unknown = {
      status: unknownResponse.status,
      body: await unknownResponse.text(),
    };
    const exchangeResponse = await h(
      request(null, "/sync/link-exchange", jsonBody({ secret })),
    );

    expect({
      status: exchangeResponse.status,
      body: await exchangeResponse.text(),
    }).toEqual(unknown);

    const editCapability = "i".repeat(43);
    expect(
      storage.mintLinkSession({
        session: {
          sessionId: "storage-seeded-edit-session",
          capabilityHash: hmac(editCapability),
          grantId: "storage-seeded-edit-exchange-link",
          generation: 1,
          mintedAtMs: 2_000,
          expiresAtMs: 2_000 + LINK_SESSION_TTL_MS,
        },
      }),
    ).toBe(true);
    const unknownRefreshResponse = await h(
      request(null, "/sync/link-refresh", {
        method: "POST",
        headers: { authorization: `LinkCapability ${"x".repeat(43)}` },
      }),
    );
    const unknownRefresh = {
      status: unknownRefreshResponse.status,
      body: await unknownRefreshResponse.text(),
    };
    const editRefreshResponse = await h(
      request(null, "/sync/link-refresh", {
        method: "POST",
        headers: { authorization: `LinkCapability ${editCapability}` },
      }),
    );
    expect({
      status: editRefreshResponse.status,
      body: await editRefreshResponse.text(),
    }).toEqual(unknownRefresh);
  });

  it("exchanges a current secret for an HMAC-stored short-lived capability", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const created = await createLink(h);
    const secret = linkSecret(created.url);

    const response = await h(
      request(null, "/sync/link-exchange", jsonBody({ secret })),
    );
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

  it("refreshes a valid capability and retires the old session", async () => {
    const storage = await newStorage();
    const relayExchangeKey = "share-web-relay-refresh-exchange-key";
    let tokenId = 30;
    const h = handler(storage, {
      relayExchangeKey,
      newLinkBearer: () => Buffer.alloc(32, tokenId++).toString("base64url"),
    });
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
    const oldCapability = String(exchanged.capabilityToken);

    const refreshedResponse = await h(
      request(null, "/sync/link-refresh", {
        method: "POST",
        headers: {
          authorization: `LinkCapability ${oldCapability}`,
          "x-dohc-relay-exchange-key": relayExchangeKey,
        },
      }),
    );

    expect(refreshedResponse.status).toBe(200);
    const refreshed = await json(refreshedResponse);
    expect(refreshed).toMatchObject({
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
    const newCapability = String(refreshed.capabilityToken);
    expect(newCapability).not.toBe(oldCapability);
    expect(storage.findLinkSessionByCapabilityHash(hmac(oldCapability))).toBeNull();
    expect(
      validateLinkCapability({
        storage,
        capabilityToken: oldCapability,
        linkKey: LINK_KEY,
        nowMs: 2_001,
      }),
    ).toBeNull();
    expect(
      validateLinkCapability({
        storage,
        capabilityToken: newCapability,
        linkKey: LINK_KEY,
        nowMs: 2_001,
      }),
    ).toMatchObject({ grantId: created.grantId, access: "view" });
  });

  it("refreshes a capability expired by an hour and retires the old session", async () => {
    const storage = await newStorage();
    const relayExchangeKey = "share-web-relay-refresh-exchange-key";
    let now = 2_000;
    let tokenId = 40;
    const h = handler(storage, {
      relayExchangeKey,
      nowMs: () => now,
      newLinkBearer: () => Buffer.alloc(32, tokenId++).toString("base64url"),
    });
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
    const oldCapability = String(exchanged.capabilityToken);
    now += LINK_SESSION_TTL_MS + 60 * 60 * 1_000;
    expect(
      (
        await h(
          request(null, "/sync/link-exchange", {
            ...jsonBody({ secret: linkSecret(created.url) }),
            headers: {
              "content-type": "application/json",
              "x-dohc-relay-exchange-key": relayExchangeKey,
            },
          }),
        )
      ).status,
    ).toBe(200);
    expect(storage.findLinkSessionByCapabilityHash(hmac(oldCapability))).not.toBeNull();

    expect(
      validateLinkCapability({
        storage,
        capabilityToken: oldCapability,
        linkKey: LINK_KEY,
        nowMs: now,
      }),
    ).toBeNull();
    const refreshedResponse = await h(
      request(null, "/sync/link-refresh", {
        method: "POST",
        headers: {
          authorization: `LinkCapability ${oldCapability}`,
          "x-dohc-relay-exchange-key": relayExchangeKey,
        },
      }),
    );

    expect(refreshedResponse.status).toBe(200);
    const refreshed = await json(refreshedResponse);
    const newCapability = String(refreshed.capabilityToken);
    expect(newCapability).not.toBe(oldCapability);
    expect(storage.findLinkSessionByCapabilityHash(hmac(oldCapability))).toBeNull();
    expect(
      validateLinkCapability({
        storage,
        capabilityToken: oldCapability,
        linkKey: LINK_KEY,
        nowMs: now,
      }),
    ).toBeNull();
    expect(
      validateLinkCapability({
        storage,
        capabilityToken: newCapability,
        linkKey: LINK_KEY,
        nowMs: now,
      }),
    ).toMatchObject({ grantId: created.grantId, access: "view" });
  });

  it("rate-limits refresh with the capability read bucket", async () => {
    const storage = await newStorage();
    const limiter = new TokenBucketLimiter(1, 0.000_001, 10);
    const h = handler(storage, { linkReadRateLimiter: limiter });
    await seedFileShare(h);
    const created = await createLink(h);
    const exchanged = await json(
      await h(request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(created.url) }))),
    );
    const capability = String(exchanged.capabilityToken);
    expect(limiter.allow(hmac(capability), 2_000)).toBe(true);
    const replace = vi.spyOn(storage, "replaceLinkSession");

    const refused = await h(
      request(null, "/sync/link-refresh", {
        method: "POST",
        headers: { authorization: `LinkCapability ${capability}` },
      }),
    );

    expect(refused.status).toBe(429);
    expect(await json(refused)).toEqual({
      ok: false,
      error: "This link has reached its request limit. Try again later.",
      code: "link_read_rate_limited",
    });
    expect(storage.findLinkSessionByCapabilityHash(hmac(capability))).not.toBeNull();
    expect(replace).not.toHaveBeenCalled();
    storage.revokeShareGrant({shareId: "share-existing", grantId: String(created.grantId), revokedAtMs: 2_000});
    const revoked = await h(request(null, "/sync/link-refresh", {method: "POST", headers: {authorization: `LinkCapability ${capability}`}}));
    expect(revoked.status).toBe(404);
    expect(await json(revoked)).toEqual({ok: false, error: "not found"});
  });

  it("spends refreshes from the grant read budget", async () => {
    const storage = await newStorage();
    const h = handler(storage, {
      linkReadRateLimiter: new TokenBucketLimiter(10, 0.000_001, 10),
      linkGrantReadRateLimiter: new TokenBucketLimiter(1, 0.000_001, 10),
    });
    await seedFileShare(h);
    const created = await createLink(h);
    const exchanged = await json(
      await h(request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(created.url) }))),
    );
    const firstRefresh = await h(
      request(null, "/sync/link-refresh", {
        method: "POST",
        headers: {
          authorization: `LinkCapability ${String(exchanged.capabilityToken)}`,
        },
      }),
    );
    expect(firstRefresh.status).toBe(200);
    const refreshed = await json(firstRefresh);

    const refused = await h(
      request(null, "/sync/link-refresh", {
        method: "POST",
        headers: {
          authorization: `LinkCapability ${String(refreshed.capabilityToken)}`,
        },
      }),
    );

    expect(refused.status).toBe(429);
    expect(await json(refused)).toEqual({
      ok: false,
      error: "This link has reached its request limit. Try again later.",
      code: "link_read_rate_limited",
    });
  });

  it("refreshes a valid capability when the relay exchange key is not configured", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const created = await createLink(h);
    const exchangeResponse = await h(
      request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(created.url) })),
    );
    expect(exchangeResponse.status).toBe(200);
    const exchanged = await json(exchangeResponse);

    const refreshed = await h(
      request(null, "/sync/link-refresh", {
        method: "POST",
        headers: {
          authorization: `LinkCapability ${String(exchanged.capabilityToken)}`,
        },
      }),
    );

    expect(refreshed.status).toBe(200);
  });

  it("refuses refresh without the configured relay exchange key", async () => {
    const storage = await newStorage();
    const relayExchangeKey = "share-web-relay-refresh-exchange-key";
    const h = handler(storage, { relayExchangeKey });
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

    const missingKey = await h(
      request(null, "/sync/link-refresh", {
        method: "POST",
        headers: {
          authorization: `LinkCapability ${String(exchanged.capabilityToken)}`,
        },
      }),
    );
    expect(await denialBytes(missingKey)).toBe(
      '404:{"ok":false,"error":"not found"}',
    );
  });

  it("refuses refresh after the link grant is revoked", async () => {
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
    expect(
      (
        await h(
          request(
            OWNER,
            "/sync/shares/share-existing/revoke",
            jsonBody({
              grantId: created.grantId,
              workspaceId: WORKSPACE,
              expectedDependentGrantIds: [],
            }),
          ),
        )
      ).status,
    ).toBe(200);
    now += LINK_SESSION_TTL_MS + 60 * 60 * 1_000;

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
    expect(await refused.text()).toBe(
      '{"ok":false,"error":"not found"}',
    );
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
    expect(await refused.text()).toBe(
      '{"ok":false,"error":"not found"}',
    );
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
    expect(await refused.text()).toBe(
      '{"ok":false,"error":"not found"}',
    );
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
    expect(await refused.text()).toBe(
      '{"ok":false,"error":"not found"}',
    );
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
      await h(
        request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(created.url) })),
      ),
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
      await h(
        request(null, "/sync/link-exchange", jsonBody({ secret: "g".repeat(43) })),
      ),
    );
    expect(
      await denialBytes(
        await h(request(null, "/sync/link-exchange", jsonBody({ secret: 42 }))),
      ),
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
          request(
            null,
            "/sync/link-exchange",
            jsonBody({ secret: linkSecret(lostStanding.url) }),
          ),
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

    const noKey = handler(storage, { linkKey: undefined });
    expect(
      await denialBytes(
        await noKey(
          request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(lostStanding.url) })),
        ),
      ),
    ).toBe(missing);
  });

  it("keeps exchange storage failure details private and retryable", async () => {
    const storage = await newStorage();
    const throwingStorage = interceptStorage(storage, {
      findLinkGrantByCredentialHash: () => {
        throw new Error("db unavailable");
      },
    });
    const h = handler(throwingStorage);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await h(
        request(
          null,
          "/sync/link-exchange",
          jsonBody({ secret: "g".repeat(43) }),
        ),
      );
      expect(response.status).toBe(503);
      expect(await json(response)).toEqual(linkRefusalBody("link_unavailable"));
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("admits 100 valid same-network exchanges despite invalid probes and still refuses revoked secrets", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const created = await createLink(h), secret = linkSecret(created.url);
    const exchange = (value: string) => h(request(null,"/sync/link-exchange",{
      ...jsonBody({secret:value}),headers:{"content-type":"application/json","x-dohc-relay-client-ip":"192.0.2.10"},
    }));
    for(let index=0;index<12;index++) expect((await exchange("z".repeat(43))).status).toBe(404);
    expect((await exchange("z".repeat(43))).status).toBe(429);
    for(let index=0;index<100;index++) expect((await exchange(secret)).status).toBe(200);
    storage.revokeShareGrant({shareId:"share-existing",grantId:String(created.grantId),revokedAtMs:2_001});
    expect((await exchange(secret)).status).toBe(429);
    const otherRequest=request(null,"/sync/link-exchange",jsonBody({secret}));
    otherRequest.headers.set("x-dohc-relay-client-ip","192.0.2.11");
    const otherIp=await h(otherRequest);
    expect(otherIp.status).toBe(404);
  });

  it("bounds global credential probes before a storage lookup", async () => {
    const storage = await newStorage();
    const counted = countStorageCalls(storage, "findLinkGrantByCredentialHash");
    const limiter = new TokenBucketLimiter(1, 0.000_001, 2);
    const h = handler(counted.storage, { linkExchangeGlobalRateLimiter: limiter });
    await h(
      request(null, "/sync/link-exchange", jsonBody({ secret: "g".repeat(43) })),
    );
    const limitedResponse = await h(
      request(null, "/sync/link-exchange", jsonBody({ secret: "h".repeat(43) })),
    );
    expect(limitedResponse.status).toBe(429);
    expect(await limitedResponse.json()).toMatchObject({ok:false,code:"link_read_rate_limited"});
    expect(counted.calls).toHaveLength(1);

    expect(limiter.allow("192.0.2.11", 2_000)).toBe(true);
    expect(limiter.allow("192.0.2.12", 2_000)).toBe(true);
    expect(limiter.size).toBe(2);
  });

  it("preserves other networks' exchange allowance during invalid floods and stalled bodies", async () => {
    const storage=await newStorage(),counted=countStorageCalls(storage,"findLinkGrantByCredentialHash");
    const h=handler(counted.storage);await seedFileShare(h);
    const created=await createLink(h),secret=linkSecret(created.url);
    const exchange=(ip:string,value=secret)=>{
      const input=request(null,"/sync/link-exchange",jsonBody({secret:value}));
      input.headers.set("x-dohc-relay-client-ip",ip);return h(input);
    };
    const before=counted.calls.length;
    for(let index=0;index<2_500;index++) expect((await exchange("bad-network","z".repeat(43))).status).toBe(index < 12 ? 404 : 429);
    expect(counted.calls.length-before).toBe(600);
    expect((await exchange("other-network")).status).toBe(200);
    const controller=new AbortController();
    const pending=Array.from({length:16},()=>{
      const input=request(null,"/sync/link-exchange",{method:"POST",signal:controller.signal,body:new ReadableStream<Uint8Array>(),duplex:"half"} as RequestInit);
      input.headers.set("x-dohc-relay-client-ip","slow-network");return h(input);
    });
    try {
      expect((await exchange("slow-network")).status).toBe(429);
      expect((await exchange("other-network")).status).toBe(200);
    } finally {controller.abort();await Promise.all(pending);}
    expect((await exchange("slow-network")).status).toBe(200);
  });

  it("never writes a minted secret or capability to relay logs", async () => {
    const storage = await newStorage();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const infoLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const h = handler(storage);
      await seedFileShare(h);
      const created = await createLink(h);
      const exchanged = await json(
        await h(
          request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(created.url) })),
        ),
      );
      const logged = [...errorLog.mock.calls, ...infoLog.mock.calls]
        .flat()
        .map(String)
        .join("\n");
      expect(logged).not.toContain(linkSecret(created.url));
      expect(logged).not.toContain(String(exchanged.capabilityToken));
    } finally {
      errorLog.mockRestore();
      infoLog.mockRestore();
    }
  });

  it("refuses an old-secret exchange without recording usage when rotation wins before session mint", async () => {
    const target = await newStorage();
    let raceGrantId = "";
    let armed = false;
    const raced = interceptStorage(target, {
      findLinkGrantByCredentialHash: (storage, secretHash) => {
        const found = storage.findLinkGrantByCredentialHash(secretHash);
        if (armed) {
          armed = false;
          storage.rotateLinkGrant({
            shareId: "share-existing",
            grantId: raceGrantId,
            rotatedAtMs: 2_001,
            expectedDependentGrantIds: [],
            guard: () => undefined,
            mintCredential: () => ({
              credentialId: "credential-race-winner",
              secretHash: hmac("race-winner-secret"),
            }),
          });
        }
        return found;
      },
    });
    const h = handler(raced);
    await seedFileShare(h);

    const createdResponse = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/share-existing/links`,
        jsonBody({ access: "view" }),
      ),
    );
    expect(createdResponse.status).toBe(200);
    const created = await json(createdResponse);
    raceGrantId = String(created.grantId);
    armed = true;

    const exchanged = await h(
      request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(created.url) })),
    );
    expect(exchanged.status).toBe(404);
    expect(await ownerLinkInventoryRow(h, raceGrantId)).toMatchObject({
      lastUsedAtMs: null,
      urlIssuedAtMs: 2_001,
    });
  });
});

describe("explicit public Edit release", () => {
  const exchangeKey = "public-edit-test-relay-key-at-least-32";
  const releaseOptions: HandlerOverrides = {
    publicEditRelease: {version: 1}, relayExchangeKey: exchangeKey,
    namedBrowserSessionLimits: {maxSessions: 8, retentionMs: 60_000, maxPendingRequests: 4, maxRequestBytes: 8192, maxResponseBytes: 16384, timeoutMs: 1000},
  };
  const exchangeRequest = (secret: string) => request(null, "/sync/link-exchange", {
    ...jsonBody({secret}), headers: {"content-type": "application/json", "x-dohc-relay-exchange-key": exchangeKey},
  });

  it("requires relay prerequisites for a release marker", async () => {
    const storage = await newStorage();
    expect(() => handler(storage, {publicEditRelease: {version: 1}})).toThrow(/Public Edit release requires/);
  });

  it("issues Edit only when released, then permits narrowing after release is removed", async () => {
    const storage = await newStorage();
    const enabled = handler(storage, releaseOptions);
    await seedFileShare(enabled, "edit");
    expect((await json(await enabled(request(OWNER, `/sync/${WORKSPACE}/shares/links`)))).supportedLinkAccess).toEqual(["view", "comment", "edit"]);
    const createdResponse = await enabled(request(OWNER, `/sync/${WORKSPACE}/shares/share-existing/links`, jsonBody({access: "edit"})));
    expect(createdResponse.status).toBe(200);
    const created = await json(createdResponse);
    const secret = linkSecret(created.url), grantId = String(created.grantId);
    expect((await enabled(exchangeRequest(secret))).status).toBe(200);
    const closed = handler(storage, {...releaseOptions, publicEditRelease: undefined});
    expect((await closed(exchangeRequest(secret))).status).not.toBe(200);
    expect((await json(await closed(request(OWNER, `/sync/${WORKSPACE}/shares/links`)))).supportedLinkAccess).toEqual(["view", "comment"]);
    const rotate = `/sync/shares/share-existing/links/${grantId}/rotate`;
    const retune = `/sync/shares/share-existing/links/${grantId}/retune`;
    const transition = {workspaceId: WORKSPACE, expectedDependentGrantIds: []};
    expect((await closed(request(OWNER, rotate, jsonBody(transition)))).status).toBe(400);
    expect((await enabled(request(OWNER, rotate, jsonBody(transition)))).status).toBe(200);
    expect((await closed(request(OWNER, retune, jsonBody({...transition, access: "comment"})))).status).toBe(200);
    expect(storage.getShareGrant(grantId)?.access).toBe("comment");
    expect((await closed(request(OWNER, retune, jsonBody({...transition, access: "edit"})))).status).toBe(400);
    expect((await enabled(request(OWNER, retune, jsonBody({...transition, access: "edit"})))).status).toBe(200);
    expect((await closed(request(OWNER, "/sync/shares/share-existing/revoke", jsonBody({...transition, grantId})))).status).toBe(200);
  });

  it("renews Edit only while release and the capability generation remain current", async () => {
    const storage = await newStorage();
    const newLinkBearer = vi.fn(() => mintLinkBearer());
    const enabled = handler(storage, {...releaseOptions, newLinkBearer});
    await seedFileShare(enabled, "edit");
    const createdResponse = await enabled(request(OWNER, `/sync/${WORKSPACE}/shares/share-existing/links`, jsonBody({access: "edit"})));
    expect(createdResponse.status).toBe(200);
    const created = await json(createdResponse);
    const exchangedResponse = await enabled(exchangeRequest(linkSecret(created.url)));
    expect(exchangedResponse.status).toBe(200);
    const exchanged = await json(exchangedResponse);
    const renewal = (capability: unknown) => request(null, "/sync/link-refresh", {
      method: "POST", headers: {authorization: `LinkCapability ${String(capability)}`, "x-dohc-relay-exchange-key": exchangeKey},
    });
    const renewedResponse = await enabled(renewal(exchanged.capabilityToken));
    expect(renewedResponse.status).toBe(200);
    const renewed = await json(renewedResponse);
    expect(renewed).toMatchObject({access: "edit", generation: 1});
    expect(renewed.capabilityToken).not.toBe(exchanged.capabilityToken);

    const closed = handler(storage, {...releaseOptions, publicEditRelease: undefined, newLinkBearer});
    const mintedBeforeClosure = newLinkBearer.mock.calls.length;
    expect((await closed(renewal(renewed.capabilityToken))).status).toBe(404);
    expect(newLinkBearer).toHaveBeenCalledTimes(mintedBeforeClosure);

    const rotatedResponse = await enabled(request(OWNER, `/sync/shares/share-existing/links/${String(created.grantId)}/rotate`,
      jsonBody({workspaceId: WORKSPACE, expectedDependentGrantIds: []})));
    expect(rotatedResponse.status).toBe(200);
    const rotated = await json(rotatedResponse);
    const mintedBeforeStaleRenewal = newLinkBearer.mock.calls.length;
    expect((await enabled(renewal(renewed.capabilityToken))).status).toBe(404);
    expect(newLinkBearer).toHaveBeenCalledTimes(mintedBeforeStaleRenewal);
    const freshResponse = await enabled(exchangeRequest(linkSecret(rotated.url)));
    expect(freshResponse.status).toBe(200);
    const fresh = await json(freshResponse);
    const currentResponse = await enabled(renewal(fresh.capabilityToken));
    expect(currentResponse.status).toBe(200);
    expect(await json(currentResponse)).toMatchObject({access: "edit", generation: 2});
  });

  it("refuses pinned Edit creation even with release enabled", async () => {
    const storage = await newStorage(), enabled = handler(storage, releaseOptions);
    await enabled(request(OWNER, "/sync/workspaces", jsonBody({workspaceId: WORKSPACE})));
    expect((await enabled(request(OWNER, `/sync/${WORKSPACE}/shares/links`, jsonBody({versionId: "version-pinned", access: "edit"})))).status).toBe(400);
    expect(storage.listSharesGrantedBy(OWNER)).toEqual([]);
    expect((await enabled(request(OWNER, `/sync/${WORKSPACE}/shares/links`, jsonBody({paths: ["docs"], access: "edit"})))).status).toBe(200);
  });
});


describe("named share origin isolation", () => {
  it("isolates promoted recipients with equal replica sequences and learned origins", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h, "comment");
    seedStorageLink(storage, { grantId: "origin-link", access: "comment" });
    for (const user of ["member-a", "member-b"]) {
      expect(seedDependentGrant(storage, {
        shareId: "share-existing", parentGrantId: "origin-link", grantId: user,
        principalUserId: user, createdAtMs: 2_001,
      })).toMatchObject({ ok: true });
      expect((await h(request(OWNER, `/sync/shares/share-existing/grants/${user}/promote`,
        jsonBody({ workspaceId: WORKSPACE, expectedParentGrantId: "origin-link", expectedParentGeneration: 1 }),
      ))).status).toBe(200);
    }
    const ownerOp = { originSeq: 0, opKind: "moment.append", recordedAtMs: 1,
      payload: { momentId: "origin-file", versionId: "main", objectId: "origin-file", path: "docs/a.md", recordedAtMs: 1,
        operation: "write", payloadAfterPath: "docs/a.md", payloadAfterBlobSha256: null } };
    expect((await h(request(OWNER, `/sync/${WORKSPACE}/log`, jsonBody({ originId: "replica", ops: [ownerOp] })))).status).toBe(200);
    const append = (user: string, originId: string, seq: number) => h(request(user,
      "/sync/shares/share-existing/log", jsonBody({ originId, ops: [{
        originSeq: seq, opKind: "chat.thread.create", recordedAtMs: 2,
        payload: { threadId: `${user}-${originId}-${seq}`, title: "Question", createdAtMs: 2,
          linkedAtMs: 2, linkedPath: "docs/a.md" },
      }] })));
    for (const user of ["member-a", "member-b"]) {
      const response = await append(user, "replica", 0);
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const page = await json(await h(request("member-b", "/sync/shares/share-existing/log?since=0")));
    const rows = page.ops as Array<{ originId: string; payload: { threadId?: string } }>;
    const originA = rows.find((row) => row.payload.threadId === "member-a-replica-0")!.originId;
    const originB = rows.find((row) => row.payload.threadId === "member-b-replica-0")!.originId;
    expect(originA).not.toBe(originB);
    expect(originA).not.toBe("replica");
    // A served origin is not a capability to append to its coordinates.
    const injection = await append("member-b", originA, 1);
    expect(injection.status).toBe(400);
    expect((await append("member-a", "replica", 1)).status).toBe(200);
    expect((await append("member-b", "replica", 1)).status).toBe(200);
    expect((await append("member-a", "replica", 1)).status).toBe(200);
    expect((await h(request(OWNER, `/sync/${WORKSPACE}/log`, jsonBody({ originId: originA, ops: [ownerOp] })))).status).toBe(400);
    const ownerRows = storage.fetchLogPage({ workspaceId: WORKSPACE, sinceRelaySeq: 0, limit: 100 }).rows;
    expect(ownerRows.find((row) => row.opKind === "moment.append")?.originId).toBe("replica");
  });
});
