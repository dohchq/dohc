import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  constantTimeHashEqual,
  LinkExchangeRateLimiter,
  LINK_SESSION_TTL_MS,
  validateLinkCapability,
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
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

interface InspectionDatabase {
  prepare(sql: string): InspectionStatement;
  close(): void;
}

const { DatabaseSync: InspectionDatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as {
  DatabaseSync: new (
    path: string,
    options: { readOnly: boolean },
  ) => InspectionDatabase;
};

afterEach(async () => {
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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

function handler(
  storage: SyncRelayStorage,
  overrides: {
    linkKey?: string | Uint8Array;
    linkExchangeRateLimiter?: LinkExchangeRateLimiter;
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
    nowMs: () => 2_000,
    newShareId: () => "share-existing",
    newGrantId: () => `grant-${id++}`,
    newId: () => `id-${id++}`,
    resolveUserIdByEmail: () => null,
    linkKey: Object.hasOwn(overrides, "linkKey") ? overrides.linkKey : LINK_KEY,
    linkExchangeRateLimiter: overrides.linkExchangeRateLimiter,
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
  access: "view" | "comment" | "edit" = "view",
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

async function seedIndependentEditAndDependentView(
  storage: SyncRelayStorage,
  h: SyncRelayHandler,
): Promise<{ dependentGrantId: string; linkGrantId: string }> {
  await seedFileShare(h, "edit");
  const link = await createLink(h, "view");
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
    credentialId: string;
    secretHash: string;
    rotatedAtMs: number;
  }): unknown;
};

function hmac(secret: string): string {
  return createHmac("sha256", LINK_KEY).update(secret).digest("base64url");
}

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

    // Create link also creates its first current credential at generation 1.
    const created = await createLink(h, "edit");
    const linkGrantId = String(created.grantId);
    const firstSecret = String(created.secret);
    expect(JSON.stringify(created).split(firstSecret)).toHaveLength(2);
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
    const narrowedResponse = await h(
      request(
        OWNER,
        `/sync/shares/share-existing/links/${linkGrantId}/retune`,
        jsonBody({ access: "comment" }),
      ),
    );
    expect(narrowedResponse.status).toBe(200);
    const narrowed = await json(narrowedResponse);
    expect(narrowed).not.toHaveProperty("secret");
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
    expect(
      await json(
        await h(request(null, "/sync/link-exchange", jsonBody({ secret: firstSecret }))),
      ),
    ).toMatchObject({ access: "comment", generation: 2 });

    // Widen link rotates the URL and bumps dependent bindings without widening them.
    const widenedResponse = await h(
      request(
        OWNER,
        `/sync/shares/share-existing/links/${linkGrantId}/retune`,
        jsonBody({ access: "edit" }),
      ),
    );
    expect(widenedResponse.status).toBe(200);
    const widened = await json(widenedResponse);
    const widenedSecret = String(widened.secret);
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
    ).toBe(200);

    // Rotate preserves access, replaces the URL, and bumps dependent bindings.
    const rotatedResponse = await h(
      request(
        OWNER,
        `/sync/shares/share-existing/links/${linkGrantId}/rotate`,
        { method: "POST" },
      ),
    );
    expect(rotatedResponse.status).toBe(200);
    const rotated = await json(rotatedResponse);
    const rotatedSecret = String(rotated.secret);
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
        jsonBody({ grantId: linkGrantId }),
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
    const secondLink = await createLink(h, "view");
    const thirdLink = await createLink(h, "comment");
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
    const created = await createLink(h, "view");
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
    const firstLink = await createLink(h, "view");
    const secondLink = await createLink(h, "comment");
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
        jsonBody({ grantId: linkGrantId }),
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
    await createLink(h, "comment");

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
    await createLink(h, "view");
  });

  it("lets the granter revoke a link after losing workspace ownership", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const created = await createLink(h, "comment");
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
          request(OWNER, `/sync/shares/share-existing/links/${grantId}/rotate`, {
            method: "POST",
          }),
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
        jsonBody({ grantId }),
      ),
    );
    expect(revokedResponse.status).toBe(200);
    expect(storage.getShareGrant(grantId)).toMatchObject({
      status: "revoked",
      generation: 2,
      revokedAtMs: 2_000,
    });
    expect(storage.getCurrentLinkCredential(grantId)).toBeNull();
    expect(storage.findLinkGrantByCredentialHash(hmac(String(created.secret)))).toBeNull();
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
    const created = await createLink(h, "comment");
    const grantId = String(created.grantId);
    expect(
      storage.convertLinkGrant({
        shareId: "share-existing",
        parentGrantId: grantId,
        grantId: "grant-dependent-at-new-level",
        principalUserId: "converted-user",
        createdAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true });

    const widenedResponse = await h(
      request(
        OWNER,
        `/sync/shares/share-existing/links/${grantId}/retune`,
        jsonBody({ access: "edit" }),
      ),
    );
    expect(widenedResponse.status).toBe(200);
    const widened = await json(widenedResponse);
    expect(storage.getShareGrant("grant-dependent-at-new-level")).toMatchObject({
      access: "comment",
      generation: 2,
    });

    const exchange = await json(
      await h(
        request(null, "/sync/link-exchange", jsonBody({ secret: widened.secret })),
      ),
    );
    const capabilityToken = String(exchange.capabilityToken);
    expect(
      validateLinkCapability({
        storage,
        capabilityToken,
        linkKey: LINK_KEY,
        nowMs: 2_001,
      }),
    ).toMatchObject({ grantId, generation: 2, access: "edit" });

    const narrowedResponse = await h(
      request(
        OWNER,
        `/sync/shares/share-existing/links/${grantId}/retune`,
        jsonBody({ access: "comment" }),
      ),
    );
    expect(narrowedResponse.status).toBe(200);
    expect(storage.getShareGrant("grant-dependent-at-new-level")).toMatchObject({
      access: "comment",
      generation: 3,
    });
    expect(
      validateLinkCapability({
        storage,
        capabilityToken,
        linkKey: LINK_KEY,
        nowMs: 2_001,
      }),
    ).toBeNull();
  });

  it("refuses every invalid state-machine transition without changing records", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const created = await createLink(h, "view");
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
      credentialId: "credential-invalid-transition",
      secretHash: hmac("replacement"),
      rotatedAtMs: 2_100,
    };
    for (const grantId of ["grant-0", "grant-email"]) {
      expect(
        storage.rotateLinkGrant({
          shareId: grantId === "grant-0" ? "share-existing" : "share-email",
          grantId,
          ...replacement,
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
      }),
    ).toMatchObject({ ok: true });
    const revokedSnapshot = storage.getShareGrant(linkGrantId);
    expect(
      storage.rotateLinkGrant({
        shareId: "share-existing",
        grantId: linkGrantId,
        ...replacement,
      }),
    ).toEqual({ ok: false });
    expect(
      storage.retuneShareGrant({
        shareId: "share-existing",
        grantId: linkGrantId,
        access: "comment",
        changedAtMs: 2_103,
        credentialId: replacement.credentialId,
        secretHash: replacement.secretHash,
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
      }),
    ).toEqual({ ok: false });

    expect("expireShareGrant" in storage).toBe(false);
    expect("changeShareSelector" in storage).toBe(false);
  });

  it("bounds retired credential history across rotations and widening retunes", async () => {
    const { storage, dbPath } = await newStorageWithPath();
    const h = handler(storage);
    await seedFileShare(h);
    const created = await createLink(h, "view");
    const grantId = String(created.grantId);
    const firstSecret = String(created.secret);
    let currentSecret = firstSecret;

    for (let index = 1; index <= 15; index += 1) {
      currentSecret = Buffer.alloc(32, index).toString("base64url");
      expect(
        storage.rotateLinkGrant({
          shareId: "share-existing",
          grantId,
          credentialId: `credential-rotation-${index}`,
          secretHash: hmac(currentSecret),
          rotatedAtMs: 2_000 + index,
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
          credentialId: "credential-widening",
          secretHash: hmac(wideningSecret),
        }),
      ).toMatchObject({ ok: true, grant: { access: "comment", generation: 17 } });
      expect(credentialCounts()).toEqual({ total: 11, retired: 10, current: 1 });
      expect(
        (
          await h(
            request(null, "/sync/link-exchange", jsonBody({ secret: wideningSecret })),
          )
        ).status,
      ).toBe(200);
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
    const cappedGrantId = String((await createLink(h, "view")).grantId);
    const untouchedGrantId = String((await createLink(h, "view")).grantId);
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

  it("exchanges a current secret for an HMAC-stored short-lived capability", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    await seedFileShare(h);
    const created = await createLink(h, "comment");
    const secret = String(created.secret);

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
      access: "comment",
      effectiveSelector: {
        paths: ["docs"],
        versionId: null,
        access: "comment",
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
      access: "comment",
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
            { method: "POST" },
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

    const rotated = await createLink(h, "view");
    const rotateResponse = await h(
      request(
        OWNER,
        `/sync/shares/share-existing/links/${String(rotated.grantId)}/rotate`,
        { method: "POST" },
      ),
    );
    const rotation = await json(rotateResponse);
    expect(
      await denialBytes(
        await h(
          request(null, "/sync/link-exchange", jsonBody({ secret: rotated.secret })),
        ),
      ),
    ).toBe(missing);
    expect(
      (
        await h(
          request(null, "/sync/link-exchange", jsonBody({ secret: rotation.secret })),
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await h(
          request(
            OWNER,
            "/sync/shares/share-existing/revoke",
            jsonBody({ grantId: rotated.grantId }),
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      await denialBytes(
        await h(
          request(null, "/sync/link-exchange", jsonBody({ secret: rotation.secret })),
        ),
      ),
    ).toBe(missing);

    const lostStanding = await createLink(h, "view");
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
            jsonBody({ secret: lostStanding.secret }),
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
          request(null, "/sync/link-exchange", jsonBody({ secret: lostStanding.secret })),
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
      const created = await createLink(h, "view");
      const exchanged = await json(
        await h(
          request(null, "/sync/link-exchange", jsonBody({ secret: created.secret })),
        ),
      );
      const logged = [...errorLog.mock.calls, ...infoLog.mock.calls]
        .flat()
        .map(String)
        .join("\n");
      expect(logged).not.toContain(String(created.secret));
      expect(logged).not.toContain(String(exchanged.capabilityToken));
    } finally {
      errorLog.mockRestore();
      infoLog.mockRestore();
    }
  });


  it("refuses an old-secret exchange when rotation wins before the session-mint transaction", async () => {
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
              credentialId: "credential-race-winner",
              secretHash: hmac("race-winner-secret"),
              rotatedAtMs: 2_001,
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
      request(null, "/sync/link-exchange", jsonBody({ secret: created.secret })),
    );
    expect(exchanged.status).toBe(404);
  });
});
