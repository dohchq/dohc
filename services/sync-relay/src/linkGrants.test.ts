import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  constantTimeHashEqual,
  hashRelayExchangeKey,
  LinkExchangeRateLimiter,
  LinkReadRateLimiter,
  LINK_SESSION_RENEWAL_GRACE_MS,
  LINK_SESSION_TTL_MS,
  validateLinkCapability,
  verifyRelayExchangeKey,
} from "./linkSecurity";
import { createSyncRelayHandler, type SyncRelayHandler } from "./server";
import { authorizeShareAction } from "./shareAuthorization";
import {
  openSyncRelayStorage,
  type SyncRelayStorage,
} from "./storage";

const OWNER = "owner";
const RECIPIENT = "recipient";
const WORKSPACE = "workspace-links";
const LINK_KEY = "test-link-key-with-at-least-thirty-two-bytes";

const roots: string[] = [];
const storages: SyncRelayStorage[] = [];

interface InspectionStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number | bigint };
}

interface InspectionDatabase {
  prepare(sql: string): InspectionStatement;
  exec(sql: string): void;
  close(): void;
}

const { DatabaseSync: InspectionDatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => InspectionDatabase;
};

afterEach(async () => {
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

function jsonBody(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function request(userId: string | null, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (userId) headers.set("authorization", `Bearer user:${userId}`);
  headers.set("x-dohc-relay-client-ip", "192.0.2.10");
  return new Request(`http://relay.test${path}`, { ...init, headers });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function newStorageWithPath(
  options?: Parameters<typeof openSyncRelayStorage>[1],
): Promise<{
  storage: SyncRelayStorage;
  dbPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dohc-link-grants-"));
  roots.push(root);
  const dbPath = join(root, "relay.sqlite");
  const storage = openSyncRelayStorage(dbPath, options);
  storages.push(storage);
  return { storage, dbPath };
}

async function newStorage(): Promise<SyncRelayStorage> {
  return (await newStorageWithPath()).storage;
}

describe("workspace link inventory index", () => {
  const indexName = "idx_sync_relay_shares_workspace";
  const workspaceLookup = `
    SELECT share_id
    FROM sync_relay_shares
    WHERE workspace_id = ?
    ORDER BY created_at_ms, share_id
  `;

  function expectWorkspaceIndex(database: InspectionDatabase): void {
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

  it("installs the index for new and reopened storage", async () => {
    const { storage, dbPath } = await newStorageWithPath();
    const initialInspection = new InspectionDatabaseSync(dbPath, { readOnly: true });
    try {
      expectWorkspaceIndex(initialInspection);
    } finally {
      initialInspection.close();
    }

    storage.close();
    storages.splice(storages.indexOf(storage), 1);
    const writableInspection = new InspectionDatabaseSync(dbPath);
    try {
      writableInspection.exec(`DROP INDEX ${indexName}`);
    } finally {
      writableInspection.close();
    }

    const reopened = openSyncRelayStorage(dbPath);
    storages.push(reopened);
    const reopenedInspection = new InspectionDatabaseSync(dbPath, { readOnly: true });
    try {
      expectWorkspaceIndex(reopenedInspection);
    } finally {
      reopenedInspection.close();
    }
  });
});

function handler(
  storage: SyncRelayStorage,
  overrides: {
    linkKey?: string | Uint8Array;
    shareWebOrigin?: string;
    relayExchangeKey?: string;
    linkExchangeRateLimiter?: LinkExchangeRateLimiter;
    linkReadRateLimiter?: LinkReadRateLimiter;
    linkGrantReadRateLimiter?: LinkReadRateLimiter;
    nowMs?: () => number;
    newShareId?: () => string;
    newGrantId?: () => string;
    newId?: () => string;
    newLinkBearer?: () => string;
    lookupUserEmail?: (userId: string) => Promise<string | null> | string | null;
  } = {},
): SyncRelayHandler {
  let id = 0;
  const options = {
    storage,
    resolveActor(request: Request, workspaceId: string) {
      const match = /^Bearer user:([^ ]+)$/u.exec(request.headers.get("authorization") ?? "");
      if (!match) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
      return { userId: match[1]!, workspaceId };
    },
    nowMs: overrides.nowMs ?? (() => 2_000),
    newShareId: overrides.newShareId ?? (() => "share-existing"),
    newGrantId: overrides.newGrantId ?? (() => `grant-${id++}`),
    newId: overrides.newId ?? (() => `id-${id++}`),
    resolveUserIdByEmail: () => null,
    lookupUserEmail: overrides.lookupUserEmail,
    linkKey: Object.hasOwn(overrides, "linkKey") ? overrides.linkKey : LINK_KEY,
    shareWebOrigin: Object.hasOwn(overrides, "shareWebOrigin")
      ? overrides.shareWebOrigin
      : "https://share.example.test",
    relayExchangeKey: overrides.relayExchangeKey,
    linkExchangeRateLimiter: overrides.linkExchangeRateLimiter,
    linkReadRateLimiter: overrides.linkReadRateLimiter,
    linkGrantReadRateLimiter: overrides.linkGrantReadRateLimiter,
    newLinkBearer: overrides.newLinkBearer,
  };
  return createSyncRelayHandler(options);
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
): Promise<Record<string, unknown>> {
  const response = await h(
    request(
      OWNER,
      `/sync/${WORKSPACE}/shares/share-existing/links`,
      jsonBody({ access: "view" }),
    ),
  );
  expect(response.status).toBe(200);
  return json(response);
}

function seedStorageLink(
  storage: SyncRelayStorage,
  input: {
    grantId: string;
    access: "view" | "comment" | "edit";
    createdAtMs?: number;
    secret?: string;
  },
): void {
  const createdAtMs = input.createdAtMs ?? 2_001;
  expect(
    storage.createLinkGrant({
      grant: {
        grantId: input.grantId,
        shareId: "share-existing",
        principalKind: "link",
        principalUserId: null,
        principalEmail: null,
        access: input.access,
        generation: 1,
        status: "active",
        createdAtMs,
        revokedAtMs: null,
        parentGrantId: null,
      },
      credential: {
        credentialId: `${input.grantId}-credential`,
        grantId: input.grantId,
        secretHash: hmac(input.secret ?? "l".repeat(43)),
        generation: 1,
        mintedAtMs: createdAtMs,
        retiredAtMs: null,
      },
    }),
  ).toBe(true);
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
    storage.convertLinkGrant({
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

async function denialBytes(response: Response): Promise<string> {
  expect(response.status).toBe(404);
  return `${response.status}:${await response.text()}`;
}

type RaceStorage = SyncRelayStorage & {
  findLinkGrantByCredentialHash(secretHash: string): unknown;
  rotateLinkGrant(input: {
    shareId: string;
    grantId: string;
    rotatedAtMs: number;
    expectedDependentGrantIds: readonly string[];
    guard: () => void;
    mintCredential: () => { credentialId: string; secretHash: string };
  }): unknown;
};

function hmac(secret: string): string {
  return createHmac("sha256", LINK_KEY).update(secret).digest("base64url");
}

function linkSecret(url: unknown): string {
  const parsed = new URL(String(url));
  expect(parsed.pathname).toBe("/s/");
  expect(parsed.search).toBe("");
  expect(parsed.hash).toMatch(/^#[A-Za-z0-9_-]{43}$/u);
  return parsed.hash.slice(1);
}

describe("atomic View link mint", () => {
  it("creates one file share, one link grant, and one hashed credential", async () => {
    const { storage, dbPath } = await newStorageWithPath();
    const h = handler(storage);
    expect(
      (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
    ).toBe(200);

    const response = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/links`,
        jsonBody({ paths: ["docs"] }),
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

    const inspection = new InspectionDatabaseSync(dbPath, { readOnly: true });
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
    const guardedStorage = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === "workspaceIsOwnedBy") {
          return () => ownershipAnswers.shift() ?? false;
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(
      storage.claimWorkspace({ workspaceId: WORKSPACE, ownerUserId: OWNER, createdAtMs: 1 }),
    ).toBe("created");
    const response = await handler(guardedStorage)(
      request(OWNER, `/sync/${WORKSPACE}/shares/links`, jsonBody({ paths: ["docs"] })),
    );
    expect(response.status).toBe(404);
    expect(storage.getShare("share-existing")).toBeNull();
    expect(storage.listSharesGrantedBy(OWNER)).toEqual([]);
  });

  it.each([
    ["recipient user", { paths: ["docs"], recipientUserId: RECIPIENT }],
    ["recipient email", { paths: ["docs"], recipientEmail: "reader@example.test" }],
    ["access", { paths: ["docs"], access: "view" }],
    ["channel", { channelWireId: "channel" }],
    ["ambiguous selector", { paths: ["docs"], channelWireId: "channel" }],
    ["empty paths", { paths: [] }],
    ["malformed paths", { paths: [42] }],
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
      request("other", `/sync/${WORKSPACE}/shares/links`, jsonBody({ paths: ["docs"] })),
    );
    expect(response.status).toBe(404);
    expect(storage.getShare("share-existing")).toBeNull();
    expect(storage.listSharesGrantedBy(OWNER)).toEqual([]);
  });
});

describe("Phase 2 owner link contract", () => {
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
          jsonBody({ paths: [path] }),
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

  it("returns URLs for attach and rotate, invalidates the old URL, and preserves a narrowed URL", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);

    const attached = await createLink(h);
    expect(attached).not.toHaveProperty("secret");
    const attachedSecret = linkSecret(attached.url);
    const grantId = String(attached.grantId);
    expect(JSON.stringify(attached).split(attachedSecret)).toHaveLength(2);

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
    const narrowResponse = await h(
      request(
        OWNER,
        "/sync/shares/share-existing/links/storage-seeded-comment-link/retune",
        jsonBody({ access: "view", expectedDependentGrantIds: [] }),
      ),
    );
    expect(narrowResponse.status).toBe(200);
    const narrowed = await json(narrowResponse);
    expect(narrowed).not.toHaveProperty("url");
    expect(narrowed).not.toHaveProperty("secret");
    expect(narrowed).toMatchObject({ access: "view", generation: 2 });
    expect(
      (await h(request(null, "/sync/link-exchange", jsonBody({ secret: higherSecret })))).status,
    ).toBe(200);
  });

  it.each(["comment", "edit"] as const)(
    "refuses attach creation and retuning to %s",
    async (access) => {
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
              jsonBody({ access, expectedDependentGrantIds: [] }),
            ),
          )
        ).status,
      ).toBe(400);
      expect(storage.getShareGrant(grantId)?.generation).toBe(generation);
      expect(storage.listSharesGrantedBy(OWNER).filter((row) => row.grant.principalKind === "link"))
        .toHaveLength(1);
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
          request(OWNER, `/sync/${WORKSPACE}/shares/links`, jsonBody({ paths: ["other"] })),
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
          grantId: "storage-seeded-edit-link",
          shareId: "share-existing",
          principalKind: "link",
          principalUserId: null,
          principalEmail: null,
          access: "edit",
          generation: 1,
          status: "active",
          createdAtMs: 2_001,
          revokedAtMs: null,
          parentGrantId: null,
        },
        credential: {
          credentialId: "storage-seeded-edit-credential",
          grantId: "storage-seeded-edit-link",
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
        "/sync/shares/share-existing/links/storage-seeded-edit-link/retune",
        jsonBody({ access: "view", expectedDependentGrantIds: [] }),
      ),
    );
    expect(narrowed.status).toBe(200);
    expect(await json(narrowed)).not.toHaveProperty("url");
    expect(storage.getShareGrant("storage-seeded-edit-link")).toMatchObject({
      access: "view",
      generation: 2,
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
      request(OWNER, `/sync/${WORKSPACE}/shares/links`, jsonBody({ paths: ["first"] })),
    );
    expect(first.status).toBe(200);
    const firstBody = await json(first);
    const completeUrl = String(firstBody.url);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failed = await h(
        request(OWNER, `/sync/${WORKSPACE}/shares/links`, jsonBody({ paths: ["second"] })),
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
});

describe("owner link inventory and impact preconditions", () => {
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
      storage.convertLinkGrant({
        shareId: "share-existing",
        parentGrantId: activeGrantId,
        grantId: "dependent-z-resolved",
        principalUserId: "resolved-user",
        createdAtMs: 2_002,
      }),
    ).toMatchObject({ ok: true });
    expect(
      storage.convertLinkGrant({
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
        selectorJson: JSON.stringify({ kind: "chat-channel", channelWireId: 42 }),
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
      selectorKind: "chat-channel",
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

    const formerOwnerStorage = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === "workspaceIsOwnedBy") return () => false;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
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
      storage.convertLinkGrant({
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
        jsonBody({ access: "view", expectedDependentGrantIds: ["dependent-lifecycle"] }),
      ),
    );
    expect(retune.status).toBe(200);
    expect((await ownerLinkInventory(h))[0]).toMatchObject({
      access: "view",
      generation: 3,
      dependents: [
        { grantId: "dependent-lifecycle", access: "view", generation: 3 },
      ],
    });

    expect(
      storage.promoteShareGrant({
        shareId: "share-existing",
        grantId: "dependent-lifecycle",
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
      generation: 4,
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
        storage.convertLinkGrant({
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
                  jsonBody({ access: "view", expectedDependentGrantIds: staleIds }),
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
                  jsonBody({ access: "view", expectedDependentGrantIds: freshIds }),
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

  it("refuses a stale confirmation after promotion so the warning cannot overstate impact", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const grantId = String((await createLink(h)).grantId);
    expect(
      storage.convertLinkGrant({
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
        storage.convertLinkGrant({
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
      storage.convertLinkGrant({
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

  it("preserves unconditional legacy revoke only for the original granter after ownership loss", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const grantId = String((await createLink(h)).grantId);
    expect(
      storage.convertLinkGrant({
        shareId: "share-existing",
        parentGrantId: grantId,
        grantId: "dependent-former-owner",
        principalUserId: "former-owner-dependent",
        createdAtMs: 2_002,
      }),
    ).toMatchObject({ ok: true });
    const transferredStorage = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === "workspaceIsOwnedBy") return () => false;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const transferredHandler = handler(transferredStorage);
    const missing = await denialBytes(
      await transferredHandler(
        request(
          OWNER,
          "/sync/shares/share-missing/revoke",
          jsonBody({ grantId, workspaceId: WORKSPACE }),
        ),
      ),
    );
    const nonGranter = await transferredHandler(
      request(
        "not-granter",
        "/sync/shares/share-existing/revoke",
        jsonBody({ grantId, workspaceId: WORKSPACE }),
      ),
    );
    expect(await denialBytes(nonGranter)).toBe(missing);
    const revoked = await transferredHandler(
      request(
        OWNER,
        "/sync/shares/share-existing/revoke",
        jsonBody({ grantId, workspaceId: WORKSPACE }),
      ),
    );
    expect(revoked.status).toBe(200);
    const serialized = await revoked.text();
    expect(serialized).not.toContain("dependents");
    expect(serialized).not.toContain("former-owner-dependent");
    expect(storage.getShareGrant(grantId)).toMatchObject({ status: "revoked" });
    expect(storage.getShareGrant("dependent-former-owner")).toMatchObject({
      status: "revoked",
    });
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
    const limiter = new LinkExchangeRateLimiter(1, 0.000_001, 10);
    let now = 2_000;
    const limited = handler(storage, {
      relayExchangeKey,
      linkExchangeRateLimiter: limiter,
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
      .toEqual([404, 404, 404, 404]);
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

    const trackedIndex = storages.indexOf(storage);
    expect(trackedIndex).toBeGreaterThanOrEqual(0);
    storage.close();
    storages.splice(trackedIndex, 1);
    const reopened = openSyncRelayStorage(dbPath, { linkSessionsPerGrantLimit: 1 });
    storages.push(reopened);
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
    ).toMatchObject({ ok: true, grant: { access: "view", generation: 2 } });
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
    ).toMatchObject({ ok: true, grant: { access: "comment", generation: 3 } });
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

    const database = new InspectionDatabaseSync(dbPath);
    try {
      database.exec("PRAGMA foreign_keys = ON");
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
    const converted = storage.convertLinkGrant({
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

    // Narrow keeps the URL, moves its credential, and narrows an over-wide dependent.
    expect(
      storage.retuneShareGrant({
        shareId: "share-existing",
        grantId: linkGrantId,
        access: "comment",
        changedAtMs: 2_001,
        expectedDependentGrantIds: ["grant-dependent"],
        guard: () => undefined,
      }),
    ).toMatchObject({ ok: true, grant: { access: "comment", generation: 2 } });
    expect(storage.getShareGrant(linkGrantId)).toMatchObject({
      access: "comment",
      generation: 2,
    });
    expect(storage.getCurrentLinkCredential(linkGrantId)).toMatchObject({
      credentialId: firstCredential.credentialId,
      generation: 2,
      retiredAtMs: null,
    });
    expect(storage.getShareGrant("grant-dependent")).toMatchObject({
      access: "comment",
      generation: 2,
    });
    // Two causes share this 404: the retune moved the credential away from
    // firstSecret, and accountless exchange refuses the grant's comment level.
    expect(
      (
        await h(request(null, "/sync/link-exchange", jsonBody({ secret: firstSecret })))
      ).status,
    ).toBe(404);

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
    ).toMatchObject({ ok: true, grant: { access: "edit", generation: 3 } });
    expect(widenedSecret).not.toBe(firstSecret);
    expect(storage.getShareGrant(linkGrantId)).toMatchObject({ access: "edit", generation: 3 });
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
    ).toMatchObject({ ok: true, grant: { access: "edit", generation: 4 } });
    expect(rotatedSecret).not.toBe(widenedSecret);
    expect(storage.getShareGrant(linkGrantId)).toMatchObject({ access: "edit", generation: 4 });
    expect(storage.getShareGrant("grant-dependent")).toMatchObject({ generation: 4 });

    // Promote detaches one dependent permanently.
    expect(
      storage.promoteShareGrant({
        shareId: "share-existing",
        grantId: "grant-dependent",
      }),
    ).toMatchObject({ ok: true, grant: { generation: 5, parentGrantId: null } });
    expect(
      storage.convertLinkGrant({
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
      generation: 5,
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

  it("requires current workspace ownership to create a link", async () => {
    const storage = await newStorage();
    let ownershipAnswers = [true];
    const ownershipStorage = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === "workspaceIsOwnedBy") return () => ownershipAnswers.shift() ?? true;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
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

  it("lets the granter revoke a link after losing workspace ownership", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const created = await createLink(h);
    const grantId = String(created.grantId);
    expect(
      storage.convertLinkGrant({
        shareId: "share-existing",
        parentGrantId: grantId,
        grantId: "grant-dependent-after-owner-loss",
        principalUserId: "converted-user",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true });

    const transferredStorage = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === "workspaceIsOwnedBy") return () => false;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const transferredHandler = handler(transferredStorage);
    expect(
      (
        await transferredHandler(
          request(
            OWNER,
            `/sync/shares/share-existing/links/${grantId}/rotate`,
            jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await transferredHandler(
          request(
            OWNER,
            `/sync/shares/share-existing/links/${grantId}/retune`,
            jsonBody({ access: "view" }),
          ),
        )
      ).status,
    ).toBe(404);

    const revokedResponse = await transferredHandler(
      request(
        OWNER,
        "/sync/shares/share-existing/revoke",
        jsonBody({ grantId, workspaceId: WORKSPACE }),
      ),
    );
    expect(revokedResponse.status).toBe(200);
    expect(storage.getShareGrant(grantId)).toMatchObject({
      status: "revoked",
      generation: 2,
      revokedAtMs: 2_000,
    });
    expect(storage.getCurrentLinkCredential(grantId)).toBeNull();
    expect(storage.findLinkGrantByCredentialHash(hmac(linkSecret(created.url)))).toBeNull();
    expect(storage.getShareGrant("grant-dependent-after-owner-loss")).toMatchObject({
      status: "revoked",
      generation: 2,
      revokedAtMs: 2_000,
    });
  });

  it("bumps every dependent generation when a link narrows", async () => {
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
      storage.convertLinkGrant({
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
    ).toMatchObject({ ok: true, grant: { access: "comment", generation: 3 } });
    expect(storage.getShareGrant("grant-dependent-at-new-level")).toMatchObject({
      access: "comment",
      generation: 3,
    });
    expect(storage.getShareGrant(grantId)).toMatchObject({
      access: "comment",
      generation: 3,
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
        storage.convertLinkGrant({
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
      storage.promoteShareGrant({ shareId: "share-existing", grantId: linkGrantId }),
    ).toEqual({ ok: false });
    expect(
      storage.promoteShareGrant({ shareId: "share-email", grantId: "grant-email" }),
    ).toEqual({ ok: false });
    expect(
      storage.promoteShareGrant({ shareId: "share-existing", grantId: "grant-0" }),
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
      storage.convertLinkGrant({
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
      storage.convertLinkGrant({
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

    const inspection = new InspectionDatabaseSync(dbPath, { readOnly: true });
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
      // Two causes share this refusal: the widening retune retired the old
      // credential, and accountless exchange refuses the comment level.
      expect(
        (
          await h(
            request(null, "/sync/link-exchange", jsonBody({ secret: wideningSecret })),
          )
        ).status,
      ).toBe(404);
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

    const inspection = new InspectionDatabaseSync(dbPath, { readOnly: true });
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

  it.each(["comment", "edit"] as const)(
    "refuses an active %s link grant exactly like an unknown secret",
    async (access) => {
      const storage = await newStorage();
      const h = handler(storage);
      await seedFileShare(h);
      const secret = access === "comment" ? "c".repeat(43) : "e".repeat(43);
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
        request(null, "/sync/link-exchange", jsonBody({ secret: "g".repeat(43) })),
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
    },
  );

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
    const limiter = new LinkReadRateLimiter(1, 0.000_001, 10);
    const h = handler(storage, { linkReadRateLimiter: limiter });
    await seedFileShare(h);
    const created = await createLink(h);
    const exchanged = await json(
      await h(request(null, "/sync/link-exchange", jsonBody({ secret: linkSecret(created.url) }))),
    );
    const capability = String(exchanged.capabilityToken);
    expect(limiter.allow(hmac(capability), 2_000)).toBe(true);

    const refused = await h(
      request(null, "/sync/link-refresh", {
        method: "POST",
        headers: { authorization: `LinkCapability ${capability}` },
      }),
    );

    expect(refused.status).toBe(429);
    expect(await json(refused)).toEqual({
      ok: false,
      error: "too many link reads",
      code: "link_read_rate_limited",
    });
    expect(storage.findLinkSessionByCapabilityHash(hmac(capability))).not.toBeNull();
  });

  it("spends refreshes from the grant read budget", async () => {
    const storage = await newStorage();
    const h = handler(storage, {
      linkReadRateLimiter: new LinkReadRateLimiter(10, 0.000_001, 10),
      linkGrantReadRateLimiter: new LinkReadRateLimiter(1, 0.000_001, 10),
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
      error: "too many link reads",
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
      await denialBytes(await h(request(null, "/missing"))),
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
    expect(refused.status).toBe(401);
    expect(await refused.text()).toBe(
      '{"ok":false,"error":"not found","code":"not_found"}',
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

    expect(refused.status).toBe(401);
    expect(await refused.text()).toBe(
      '{"ok":false,"error":"not found","code":"not_found"}',
    );
  });

  it("refuses refresh when revocation wins before session replacement", async () => {
    const target = await newStorage();
    const relayExchangeKey = "share-web-relay-refresh-exchange-key";
    let grantId = "";
    let armed = false;
    let replaceLinkSessionInterceptions = 0;
    const raced = new Proxy(target, {
      get(storage, property, receiver) {
        if (property === "replaceLinkSession") {
          return (
            input: Parameters<SyncRelayStorage["replaceLinkSession"]>[0],
          ): boolean => {
            replaceLinkSessionInterceptions += 1;
            if (armed) {
              armed = false;
              storage.revokeShareGrant({
                shareId: "share-existing",
                grantId,
                revokedAtMs: 2_001,
              });
            }
            return storage.replaceLinkSession(input);
          };
        }
        const value = Reflect.get(storage, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(storage) : value;
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
    expect(refused.status).toBe(401);
    expect(await refused.text()).toBe(
      '{"ok":false,"error":"not found","code":"not_found"}',
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
    expect(refused.status).toBe(401);
    expect(await refused.text()).toBe(
      '{"ok":false,"error":"not found","code":"not_found"}',
    );
  });

  it("requires the configured relay exchange key before rate limiting", async () => {
    const target = await newStorage();
    let credentialLookups = 0;
    const counted = new Proxy(target, {
      get(storage, property, receiver) {
        if (property === "findLinkGrantByCredentialHash") {
          return (secretHash: string) => {
            credentialLookups += 1;
            return storage.findLinkGrantByCredentialHash(secretHash);
          };
        }
        const value = Reflect.get(storage, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(storage) : value;
      },
    });
    const relayExchangeKey = "share-web-relay-exchange-key-at-least-32";
    const h = handler(counted, {
      relayExchangeKey,
      linkExchangeRateLimiter: new LinkExchangeRateLimiter(1, 0.000_001, 10),
    });
    await seedFileShare(h);
    const created = await createLink(h);
    const generic = await denialBytes(await h(request(null, "/missing")));

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
    expect(credentialLookups).toBe(0);

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
    expect(credentialLookups).toBeGreaterThan(0);
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
    const noStandingStorage = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === "workspaceIsOwnedBy") return () => false;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
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
        selectorJson: JSON.stringify({ kind: "chat-channel", channelWireId: "general" }),
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

  it("returns the standard unexpected-error response when exchange storage fails", async () => {
    const storage = await newStorage();
    const throwingStorage = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === "findLinkGrantByCredentialHash") {
          return () => {
            throw new Error("db unavailable");
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
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
      expect(response.status).toBe(500);
      expect(await json(response)).toEqual({
        ok: false,
        error: "internal error",
        code: "internal_error",
      });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rate-limits by socket IP before a storage lookup and bounds the bucket map", async () => {
    const storage = await newStorage();
    let lookups = 0;
    const counted = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === "findLinkGrantByCredentialHash") {
          return (secretHash: string) => {
            lookups += 1;
            return target.findLinkGrantByCredentialHash(secretHash);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const limiter = new LinkExchangeRateLimiter(1, 0.000_001, 2);
    const h = handler(counted, { linkExchangeRateLimiter: limiter });
    const first = await denialBytes(
      await h(
        request(null, "/sync/link-exchange", jsonBody({ secret: "g".repeat(43) })),
      ),
    );
    const limited = await denialBytes(
      await h(
        request(null, "/sync/link-exchange", jsonBody({ secret: "h".repeat(43) })),
      ),
    );
    expect(limited).toBe(first);
    expect(lookups).toBe(1);

    expect(limiter.allow("192.0.2.11", 2_000)).toBe(true);
    expect(limiter.allow("192.0.2.12", 2_000)).toBe(true);
    expect(limiter.size).toBe(2);
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
    const target = (await newStorage()) as RaceStorage;
    let raceGrantId = "";
    let armed = false;
    const raced = new Proxy(target, {
      get(storage, property, receiver) {
        if (property !== "findLinkGrantByCredentialHash") {
          const value = Reflect.get(storage, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(storage) : value;
        }
        return (secretHash: string) => {
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
        };
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
