import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashLinkBearer } from "./linkSecurity";
import { createSyncRelayHandler, type SyncRelayHandler } from "./server";
import {
  openSyncRelayStorage,
  type SyncRelayStorage,
} from "./storage";

const OWNER = "owner-account-sentinel";
const NEW_OWNER = "new-owner-account-sentinel";
const COMMENTER = "commenter-account-sentinel";
const VIEWER = "viewer-account-sentinel";
const EDITOR = "editor-account-sentinel";
const WORKSPACE = "workspace-discussion-sentinel";
const SHARE = "share-discussion-sentinel";
const LINK_KEY = "discussion-link-key-with-at-least-32-bytes";
const RELAY_KEY = "discussion-relay-key-with-at-least-32-bytes";
const PROFILE_A = "p".repeat(43);
const PROFILE_B = "q".repeat(43);

interface InspectionStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes?: number | bigint };
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
    options?: { readOnly?: boolean },
  ) => InspectionDatabase;
};

const roots: string[] = [];
const storages: SyncRelayStorage[] = [];

afterEach(async () => {
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

type LinkFixture = {
  access: "view" | "comment" | "edit";
  grantId: string;
  secret: string;
  capabilityToken: string;
};

type Fixture = {
  storage: SyncRelayStorage;
  dbPath: string;
  handler: SyncRelayHandler;
  makeHandler: (storage: SyncRelayStorage) => SyncRelayHandler;
  view: LinkFixture;
  comment: LinkFixture;
  edit: LinkFixture;
};

function secret(character: string): string {
  return character.repeat(43);
}

async function fixture(
  overrides: {
    lookupUserDisplayName?: (
      userId: string,
    ) => Promise<string | null> | string | null;
    workspaceQuotaBytes?: number;
    namedRecipient?: string;
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "dohc-link-discussion-http-"));
  roots.push(root);
  const dbPath = join(root, "relay.sqlite");
  let discussionId = 0;
  const storage = openSyncRelayStorage(dbPath, {
    newDiscussionId: () => `discussion-row-${++discussionId}`,
    workspaceQuotaBytes: overrides.workspaceQuotaBytes,
  });
  storages.push(storage);
  expect(
    storage.claimWorkspace({
      workspaceId: WORKSPACE,
      ownerUserId: OWNER,
      createdAtMs: 1_000,
    }),
  ).toBe("created");
  storage.createShare({
    share: {
      shareId: SHARE,
      workspaceId: WORKSPACE,
      granterUserId: OWNER,
      selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }),
      createdAtMs: 1_001,
    },
    grant: {
      grantId: "named-comment-grant-sentinel",
      shareId: SHARE,
      principalKind: "user",
      principalUserId: overrides.namedRecipient ?? COMMENTER,
      principalEmail: null,
      access: "comment",
      generation: 1,
      status: "active",
      createdAtMs: 1_001,
      revokedAtMs: null,
      parentGrantId: null,
    },
  });

  const addLink = (
    access: LinkFixture["access"],
    suffix: string,
    secretCharacter: string,
    capabilityCharacter: string,
  ): LinkFixture => {
    const grantId = `link-${suffix}-grant-sentinel`;
    const linkSecret = secret(secretCharacter);
    const capabilityToken = secret(capabilityCharacter);
    expect(
      storage.createLinkGrant({
        grant: {
          grantId,
          shareId: SHARE,
          principalKind: "link",
          principalUserId: null,
          principalEmail: null,
          access,
          generation: 1,
          status: "active",
          createdAtMs: 1_010,
          revokedAtMs: null,
          parentGrantId: null,
        },
        credential: {
          credentialId: `credential-${suffix}-sentinel`,
          grantId,
          secretHash: hashLinkBearer(linkSecret, LINK_KEY),
          generation: 1,
          mintedAtMs: 1_010,
          retiredAtMs: null,
        },
      }),
    ).toBe(true);
    expect(
      storage.mintLinkSession({
        session: {
          sessionId: `session-${suffix}-sentinel`,
          capabilityHash: hashLinkBearer(capabilityToken, LINK_KEY),
          grantId,
          generation: 1,
          mintedAtMs: 1_011,
          expiresAtMs: 1_000_000,
        },
      }),
    ).toBe(true);
    return { access, grantId, secret: linkSecret, capabilityToken };
  };

  const view = addLink("view", "view", "a", "d");
  const comment = addLink("comment", "comment", "b", "e");
  const edit = addLink("edit", "edit", "c", "f");
  expect(
    storage.convertLinkGrant({
      shareId: SHARE,
      parentGrantId: view.grantId,
      grantId: "named-view-grant-sentinel",
      principalUserId: VIEWER,
      createdAtMs: 1_020,
    }),
  ).toMatchObject({ ok: true, grant: { access: "view" } });
  expect(
    storage.convertLinkGrant({
      shareId: SHARE,
      parentGrantId: edit.grantId,
      grantId: "named-edit-grant-sentinel",
      principalUserId: EDITOR,
      createdAtMs: 1_021,
    }),
  ).toMatchObject({ ok: true, grant: { access: "edit" } });

  let id = 0;
  let clock = 10_000;
  const names: Record<string, string> = {
    [OWNER]: "Owner Name",
    [COMMENTER]: "Commenter Name",
    [VIEWER]: "Viewer Name",
    [EDITOR]: "",
  };
  const makeHandler = (targetStorage: SyncRelayStorage): SyncRelayHandler =>
    createSyncRelayHandler({
      storage: targetStorage,
      resolveActor(request: Request, workspaceId: string) {
        const match = /^Bearer user:([^ ]+)$/u.exec(
          request.headers.get("authorization") ?? "",
        );
        if (!match) {
          throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
        }
        return { userId: match[1]!, workspaceId };
      },
      lookupUserEmail: (userId) => `${userId}@email-sentinel.test`,
      lookupUserDisplayName:
        overrides.lookupUserDisplayName ?? ((userId) => names[userId] ?? null),
      nowMs: () => clock++,
      newId: () => `http-id-${++id}`,
      linkKey: LINK_KEY,
      shareWebOrigin: "https://share.test",
      relayExchangeKey: RELAY_KEY,
    });
  const handler = makeHandler(storage);
  return { storage, dbPath, handler, makeHandler, view, comment, edit };
}

function addIndependentCommentLink(storage: SyncRelayStorage): LinkFixture {
  const grantId = "link-comment-peer-grant-sentinel";
  const linkSecret = secret("g");
  const capabilityToken = secret("h");
  expect(
    storage.createLinkGrant({
      grant: {
        grantId,
        shareId: SHARE,
        principalKind: "link",
        principalUserId: null,
        principalEmail: null,
        access: "comment",
        generation: 1,
        status: "active",
        createdAtMs: 1_012,
        revokedAtMs: null,
        parentGrantId: null,
      },
      credential: {
        credentialId: "credential-comment-peer-sentinel",
        grantId,
        secretHash: hashLinkBearer(linkSecret, LINK_KEY),
        generation: 1,
        mintedAtMs: 1_012,
        retiredAtMs: null,
      },
    }),
  ).toBe(true);
  expect(
    storage.mintLinkSession({
      session: {
        sessionId: "session-comment-peer-sentinel",
        capabilityHash: hashLinkBearer(capabilityToken, LINK_KEY),
        grantId,
        generation: 1,
        mintedAtMs: 1_013,
        expiresAtMs: 1_000_000,
      },
    }),
  ).toBe(true);
  return { access: "comment", grantId, secret: linkSecret, capabilityToken };
}

function request(
  userId: string | null,
  path: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  if (userId !== null) headers.set("authorization", `Bearer user:${userId}`);
  return new Request(`http://relay.test${path}`, { ...init, headers });
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function linkRequest(
  link: LinkFixture,
  path: string,
  init: RequestInit = {},
  trust: { relayKey?: string; profileSecret?: string } = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `LinkCapability ${link.capabilityToken}`);
  if (trust.relayKey !== undefined) {
    headers.set("x-dohc-relay-exchange-key", trust.relayKey);
  }
  if (trust.profileSecret !== undefined) {
    headers.set("x-dohc-link-profile-secret", trust.profileSecret);
  }
  return new Request(`http://relay.test${path}`, { ...init, headers });
}

function trustedAppend(
  link: LinkFixture,
  body: Record<string, unknown>,
  profileSecret = PROFILE_A,
): Request {
  return linkRequest(
    link,
    "/sync/link/discussion",
    jsonRequest(body),
    { relayKey: RELAY_KEY, profileSecret },
  );
}

function moderationRequest(
  userId: string | null,
  action: Record<string, unknown>,
  init: RequestInit = {},
): Request {
  return request(
    userId,
    `/sync/shares/${SHARE}/discussion/moderation`,
    { ...jsonRequest(action), ...init },
  );
}

async function exchangeLink(
  test: Fixture,
  linkSecret: string,
): Promise<string> {
  const response = await test.handler(
    request(null, "/sync/link-exchange", {
      ...jsonRequest({ secret: linkSecret }),
      headers: {
        "content-type": "application/json",
        "x-dohc-relay-exchange-key": RELAY_KEY,
      },
    }),
  );
  expect(response.status).toBe(200);
  return String((await body(response)).capabilityToken);
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function count(dbPath: string, table: string): number {
  const db = new InspectionDatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0,
    );
  } finally {
    db.close();
  }
}

function discussionUsage(dbPath: string): number {
  const db = new InspectionDatabaseSync(dbPath, { readOnly: true });
  try {
    const messages = Number(
      db
        .prepare(
          "SELECT COALESCE(SUM(storage_bytes), 0) AS bytes FROM sync_relay_share_discussion_messages",
        )
        .get()?.bytes ?? 0,
    );
    const principals = Number(
      db
        .prepare(
          "SELECT COALESCE(SUM(storage_bytes), 0) AS bytes FROM sync_relay_link_principals",
        )
        .get()?.bytes ?? 0,
    );
    return messages + principals;
  } finally {
    db.close();
  }
}

function updateWorkspaceOwner(dbPath: string, ownerUserId: string): void {
  const db = new InspectionDatabaseSync(dbPath);
  try {
    db
      .prepare(
        "UPDATE sync_relay_workspaces SET owner_user_id = ? WHERE workspace_id = ?",
      )
      .run(ownerUserId, WORKSPACE);
  } finally {
    db.close();
  }
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
}

async function genericRefusal(response: Response): Promise<string> {
  expectPrivate(response);
  expect(response.status).toBe(404);
  return `${response.status}:${await response.text()}`;
}

async function discussionStateRefusal(
  response: Response,
  state: "blocked" | "paused",
): Promise<string> {
  expectPrivate(response);
  expect(response.status).toBe(403);
  const serialized = await response.text();
  expect(JSON.parse(serialized)).toEqual({
    ok: false,
    error:
      state === "blocked"
        ? "link discussion writes are blocked"
        : "link discussion writes are paused",
    code: `link_discussion_${state}`,
  });
  return `${response.status}:${serialized}`;
}

function messages(responseBody: Record<string, unknown>): Array<Record<string, unknown>> {
  return responseBody.messages as Array<Record<string, unknown>>;
}

function bytes(...values: string[]): number {
  return values.reduce(
    (total, value) => total + Buffer.byteLength(value, "utf8"),
    0,
  );
}

const DELETING_USER_ID_RESERVATION_BYTES = 1_024;
const MESSAGE_FIXED_BYTES = DELETING_USER_ID_RESERVATION_BYTES + 3 * 8;
const PRINCIPAL_FIXED_BYTES = 160 + 4 * 8;

function namedMessageCharge(input: {
  actorUserId: string;
  displayName: string;
  body: string;
  idempotencyKey: string;
}): number {
  return (
    bytes(
      "discussion-row-1",
      SHARE,
      input.idempotencyKey,
      "r".repeat(43),
      "named",
      input.actorUserId,
      input.displayName,
      input.body,
    ) + MESSAGE_FIXED_BYTES
  );
}

function firstLinkAppendCharge(input: {
  body: string;
  claimedName: string;
  idempotencyKey: string;
  grantId: string;
}): number {
  const principalId = "discussion-row-1";
  const messageId = "discussion-row-2";
  const principal =
    bytes(principalId, input.grantId, "p".repeat(43)) + PRINCIPAL_FIXED_BYTES;
  const message =
    bytes(
      messageId,
      SHARE,
      input.idempotencyKey,
      "r".repeat(43),
      "link",
      input.grantId,
      principalId,
      input.claimedName,
      input.body,
    ) + MESSAGE_FIXED_BYTES;
  return principal + message;
}

function seedCrossShareHandles(storage: SyncRelayStorage): {
  principalId: string;
  messageId: string;
} {
  const shareId = "cross-share-sentinel";
  const grantId = "cross-share-link-grant-sentinel";
  const capabilityToken = secret("y");
  storage.createShare({
    share: {
      shareId,
      workspaceId: WORKSPACE,
      granterUserId: OWNER,
      selectorJson: JSON.stringify({ paths: ["other"], versionId: null }),
      createdAtMs: 2_000,
    },
    grant: {
      grantId: "cross-share-named-grant-sentinel",
      shareId,
      principalKind: "user",
      principalUserId: COMMENTER,
      principalEmail: null,
      access: "comment",
      generation: 1,
      status: "active",
      createdAtMs: 2_000,
      revokedAtMs: null,
      parentGrantId: null,
    },
  });
  expect(
    storage.createLinkGrant({
      grant: {
        grantId,
        shareId,
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
        credentialId: "cross-share-credential-sentinel",
        grantId,
        secretHash: "cross-share-secret-hash",
        generation: 1,
        mintedAtMs: 2_001,
        retiredAtMs: null,
      },
    }),
  ).toBe(true);
  expect(
    storage.mintLinkSession({
      session: {
        sessionId: "cross-share-session-sentinel",
        capabilityHash: hashLinkBearer(capabilityToken, LINK_KEY),
        grantId,
        generation: 1,
        mintedAtMs: 2_002,
        expiresAtMs: 1_000_000,
      },
    }),
  ).toBe(true);
  const appended = storage.appendLinkDiscussionMessage({
    capabilityHash: hashLinkBearer(capabilityToken, LINK_KEY),
    profileTokenHash: "cross-share-profile-hash",
    body: "cross-share-body",
    idempotencyKey: "cross-share-message",
    createdAtMs: 2_003,
  });
  expect(appended.ok).toBe(true);
  if (!appended.ok) throw new Error("cross-share principal did not seed");
  return {
    principalId: appended.principal.principalId,
    messageId: appended.message.messageId,
  };
}

describe("share discussion HTTP boundary", () => {
  it("shares one mixed timeline across View and Comment links without aggregating write authority", async () => {
    const test = await fixture();
    const linkAppend = await test.handler(
      trustedAppend(test.comment, {
        body: "Link-authored plain text",
        claimedName: "Link Name",
        idempotencyKey: "link-first",
      }),
    );
    expect(linkAppend.status).toBe(200);
    expectPrivate(linkAppend);

    const ownerAppend = await test.handler(
      request(
        OWNER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({ body: "Owner plain text", idempotencyKey: "owner-first" }),
      ),
    );
    expect(ownerAppend.status).toBe(200);
    expectPrivate(ownerAppend);

    const viewRead = await test.handler(
      linkRequest(test.view, "/sync/link/discussion"),
    );
    const commentRead = await test.handler(
      linkRequest(test.comment, "/sync/link/discussion"),
    );
    expect(viewRead.status).toBe(200);
    expect(commentRead.status).toBe(200);
    expectPrivate(viewRead);
    expectPrivate(commentRead);
    expect(await body(viewRead)).toEqual(await body(commentRead));

    const rowsBefore = count(test.dbPath, "sync_relay_share_discussion_messages");
    const viewWrite = await test.handler(
      trustedAppend(
        test.view,
        { body: "must not land", idempotencyKey: "view-write" },
        PROFILE_A,
      ),
    );
    expect(await genericRefusal(viewWrite)).toContain("404:");
    expect(count(test.dbPath, "sync_relay_share_discussion_messages")).toBe(
      rowsBefore,
    );
  });

  it("mints on first append only and reuses the server-derived profile through refresh and re-exchange", async () => {
    const test = await fixture();
    const read = await test.handler(
      linkRequest(test.comment, "/sync/link/discussion"),
    );
    expect(read.status).toBe(200);
    await read.arrayBuffer();
    expect(count(test.dbPath, "sync_relay_link_principals")).toBe(0);

    expect(
      (
        await test.handler(
          trustedAppend(test.comment, {
            body: "first",
            claimedName: "Stable Name",
            idempotencyKey: "profile-first",
          }),
        )
      ).status,
    ).toBe(200);
    const firstPrincipal = test.storage
      .listShareDiscussionMessages({ shareId: SHARE, limit: 100 })
      .messages[0]!.linkPrincipalId;
    expect(firstPrincipal).not.toBeNull();

    const refresh = await test.handler(
      linkRequest(
        test.comment,
        "/sync/link-refresh",
        { method: "POST" },
        { relayKey: RELAY_KEY },
      ),
    );
    expect(refresh.status).toBe(200);
    const refreshed = await body(refresh);
    test.comment.capabilityToken = String(refreshed.capabilityToken);
    expect(
      (
        await test.handler(
          trustedAppend(test.comment, {
            body: "after refresh",
            idempotencyKey: "profile-refresh",
          }),
        )
      ).status,
    ).toBe(200);

    expect(
      test.storage.setLinkPrincipalBlocked({
        shareId: SHARE,
        principalId: firstPrincipal!,
        actorUserId: OWNER,
        blockedAtMs: 20_000,
      }),
    ).toBe(true);
    expect(
      test.storage.setLinkPrincipalBlocked({
        shareId: SHARE,
        principalId: firstPrincipal!,
        actorUserId: OWNER,
        blockedAtMs: null,
      }),
    ).toBe(true);
    const exchange = await test.handler(
      request(
        null,
        "/sync/link-exchange",
        {
          ...jsonRequest({ secret: test.comment.secret }),
          headers: {
            "content-type": "application/json",
            "x-dohc-relay-exchange-key": RELAY_KEY,
          },
        },
      ),
    );
    expect(exchange.status).toBe(200);
    test.comment.capabilityToken = String((await body(exchange)).capabilityToken);
    expect(
      (
        await test.handler(
          trustedAppend(test.comment, {
            body: "after ejection",
            idempotencyKey: "profile-reexchange",
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      new Set(
        test.storage
          .listShareDiscussionMessages({ shareId: SHARE, limit: 100 })
          .messages.map((message) => message.linkPrincipalId),
      ),
    ).toEqual(new Set([firstPrincipal]));

    const secondExchange = await test.handler(
      request(null, "/sync/link-exchange", {
        ...jsonRequest({ secret: test.comment.secret }),
        headers: {
          "content-type": "application/json",
          "x-dohc-relay-exchange-key": RELAY_KEY,
        },
      }),
    );
    test.comment.capabilityToken = String(
      (await body(secondExchange)).capabilityToken,
    );
    expect(
      (
        await test.handler(
          trustedAppend(
            test.comment,
            { body: "fresh profile", idempotencyKey: "profile-fresh" },
            PROFILE_B,
          ),
        )
      ).status,
    ).toBe(200);
    expect(count(test.dbPath, "sync_relay_link_principals")).toBe(2);
    expect(test.storage.getLinkPrincipal(firstPrincipal!)!.profileTokenHash).not.toBe(
      PROFILE_A,
    );
    expect(
      JSON.stringify(
        test.storage.listShareDiscussionMessages({ shareId: SHARE, limit: 100 }),
      ),
    ).not.toContain(PROFILE_A);
  });

  it("requires the trusted backend and a raw protected profile while keeping the append body closed", async () => {
    const test = await fixture();
    const validBody = { body: "hello", idempotencyKey: "closed-body" };
    const missingKey = await test.handler(
      linkRequest(
        test.comment,
        "/sync/link/discussion",
        jsonRequest(validBody),
        { profileSecret: PROFILE_A },
      ),
    );
    const missingProfile = await test.handler(
      linkRequest(
        test.comment,
        "/sync/link/discussion",
        jsonRequest(validBody),
        { relayKey: RELAY_KEY },
      ),
    );
    const malformedProfile = await test.handler(
      linkRequest(
        test.comment,
        "/sync/link/discussion",
        jsonRequest(validBody),
        { relayKey: RELAY_KEY, profileSecret: "not-a-profile" },
      ),
    );
    const invalidCredential = await test.handler(
      linkRequest(
        { ...test.comment, capabilityToken: secret("z") },
        "/sync/link/discussion",
        jsonRequest(validBody),
        { relayKey: RELAY_KEY, profileSecret: PROFILE_A },
      ),
    );
    const refusal = await genericRefusal(missingKey);
    expect(await genericRefusal(missingProfile)).toBe(refusal);
    expect(await genericRefusal(malformedProfile)).toBe(refusal);
    expect(await genericRefusal(invalidCredential)).toBe(refusal);

    const forbiddenFields = [
      "profileTokenHash",
      "principalId",
      "authorKind",
      "authorId",
      "displayName",
      "linkGrantId",
      "messageId",
      "provenance",
      "attachment",
      "reaction",
      "decision",
      "anchor",
      "markupMode",
      "urlMetadata",
    ];
    for (const field of forbiddenFields) {
      const response = await test.handler(
        trustedAppend(test.comment, { ...validBody, [field]: `forged-${field}` }),
      );
      expect(response.status, field).toBe(400);
      expectPrivate(response);
      await response.arrayBuffer();
    }
    for (const malformed of [
      { body: "", idempotencyKey: "empty-body" },
      { body: "body", idempotencyKey: "" },
      { body: 42, idempotencyKey: "wrong-body-type" },
    ]) {
      const response = await test.handler(trustedAppend(test.comment, malformed));
      expect(response.status).toBe(400);
      expectPrivate(response);
      await response.arrayBuffer();
    }
    expect(count(test.dbPath, "sync_relay_link_principals")).toBe(0);
    expect(count(test.dbPath, "sync_relay_share_discussion_messages")).toBe(0);
  });

  it("derives owner and named authors from current auth and Better Auth names", async () => {
    const test = await fixture();
    for (const [actor, field] of [
      [OWNER, "displayName"],
      [COMMENTER, "userId"],
      [EDITOR, "email"],
    ] as const) {
      const response = await test.handler(
        request(
          actor,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({
            body: "forged author",
            idempotencyKey: `forged-${field}`,
            [field]: `${field}-forgery-sentinel`,
          }),
        ),
      );
      expect(response.status).toBe(400);
      expectPrivate(response);
      await response.arrayBuffer();
    }

    for (const [actor, idempotencyKey] of [
      [OWNER, "owner-author"],
      [COMMENTER, "commenter-author"],
      [EDITOR, "editor-author"],
    ] as const) {
      const response = await test.handler(
        request(
          actor,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({ body: `from ${actor}`, idempotencyKey }),
        ),
      );
      expect(response.status).toBe(200);
      expectPrivate(response);
      await response.arrayBuffer();
    }
    const viewWrite = await test.handler(
      request(
        VIEWER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({ body: "view cannot write", idempotencyKey: "view-author" }),
      ),
    );
    expect(viewWrite.status).toBe(403);
    expectPrivate(viewWrite);

    const ownerRead = await test.handler(
      request(OWNER, `/sync/shares/${SHARE}/discussion`),
    );
    const serialized = JSON.stringify(await body(ownerRead));
    expect(serialized).toContain("Owner Name");
    expect(serialized).toContain("Commenter Name");
    expect(serialized).toContain("Unnamed");
    expect(serialized).not.toContain("email-sentinel.test");
    expect(serialized).not.toContain("forgery-sentinel");
    expect(
      test.storage
        .listShareDiscussionMessages({ shareId: SHARE, limit: 100 })
        .messages.map((message) => message.authorUserId),
    ).toEqual([OWNER, COMMENTER, EDITOR]);
  });

  it("keeps exact retries idempotent and rechecks revoke, retune, pause, and block inside storage", async () => {
    const retry = await fixture();
    const first = await retry.handler(
      trustedAppend(retry.comment, {
        body: "once",
        claimedName: "Retry Name",
        idempotencyKey: "same-key",
      }),
    );
    const replay = await retry.handler(
      trustedAppend(retry.comment, {
        body: "once",
        claimedName: "Retry Name",
        idempotencyKey: "same-key",
      }),
    );
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await body(replay)).toEqual(await body(first));
    expect(
      await genericRefusal(
        await retry.handler(
          trustedAppend(retry.comment, {
            body: "different",
            claimedName: "Retry Name",
            idempotencyKey: "same-key",
          }),
        ),
      ),
    ).toContain("404:");
    expect(count(retry.dbPath, "sync_relay_share_discussion_messages")).toBe(1);

    for (const transition of ["revoke", "retune", "pause", "block"] as const) {
      const test = await fixture();
      let principalId: string | null = null;
      if (transition === "block") {
        const seeded = await test.handler(
          trustedAppend(test.comment, {
            body: "principal seed",
            idempotencyKey: "principal-seed",
          }),
        );
        expect(seeded.status).toBe(200);
        await seeded.arrayBuffer();
        principalId = test.storage
          .listShareDiscussionMessages({ shareId: SHARE, limit: 100 })
          .messages[0]!.linkPrincipalId;
      }
      const beforeRows = count(test.dbPath, "sync_relay_share_discussion_messages");
      const beforePrincipals = count(test.dbPath, "sync_relay_link_principals");
      const original = test.storage.appendLinkDiscussionMessage.bind(test.storage);
      test.storage.appendLinkDiscussionMessage = (input) => {
        if (transition === "revoke") {
          test.storage.revokeShareGrant({
            shareId: SHARE,
            grantId: test.comment.grantId,
            revokedAtMs: 20_000,
            expectedDependentGrantIds: [],
          });
        } else if (transition === "retune") {
          test.storage.retuneShareGrant({
            shareId: SHARE,
            grantId: test.comment.grantId,
            access: "view",
            changedAtMs: 20_000,
            expectedDependentGrantIds: [],
            guard: () => {},
          });
        } else if (transition === "pause") {
          test.storage.setShareLinkWritesPaused({
            shareId: SHARE,
            actorUserId: OWNER,
            pausedAtMs: 20_000,
          });
        } else {
          test.storage.setLinkPrincipalBlocked({
            shareId: SHARE,
            principalId: principalId!,
            actorUserId: OWNER,
            blockedAtMs: 20_000,
          });
        }
        return original(input);
      };
      const response = await test.handler(
        trustedAppend(test.comment, {
          body: `after ${transition}`,
          idempotencyKey: `race-${transition}`,
        }),
      );
      if (transition === "pause" || transition === "block") {
        await discussionStateRefusal(
          response,
          transition === "pause" ? "paused" : "blocked",
        );
      } else {
        expect(await genericRefusal(response), transition).toContain("404:");
      }
      expect(count(test.dbPath, "sync_relay_share_discussion_messages")).toBe(
        beforeRows,
      );
      expect(count(test.dbPath, "sync_relay_link_principals")).toBe(
        beforePrincipals,
      );
    }

    const named = await fixture();
    const originalNamed = named.storage.appendNamedDiscussionMessage.bind(
      named.storage,
    );
    named.storage.appendNamedDiscussionMessage = (input) => {
      named.storage.revokeShareGrant({
        shareId: SHARE,
        grantId: "named-comment-grant-sentinel",
        revokedAtMs: 30_000,
      });
      return originalNamed(input);
    };
    const namedRace = await named.handler(
      request(
        COMMENTER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({ body: "named race", idempotencyKey: "named-race" }),
      ),
    );
    expect(namedRace.status).toBe(404);
    expectPrivate(namedRace);
    expect(count(named.dbPath, "sync_relay_share_discussion_messages")).toBe(0);
  });

  it("admits link, named, and owner messages only at their complete deterministic quota charge", async () => {
    const actorBound = await fixture();
    const oversizedActor = await actorBound.handler(
      request(
        "x".repeat(DELETING_USER_ID_RESERVATION_BYTES + 1),
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({ body: "too large", idempotencyKey: "large-actor" }),
      ),
    );
    expect(oversizedActor.status).toBe(400);
    expectPrivate(oversizedActor);

    const linkInput = {
      body: "link quota body",
      claimedName: "Quota Link",
      idempotencyKey: "quota-link",
    };
    const linkCharge = firstLinkAppendCharge({
      ...linkInput,
      grantId: "link-comment-grant-sentinel",
    });
    const linkBelow = await fixture({ workspaceQuotaBytes: linkCharge - 1 });
    expect(
      await genericRefusal(
        await linkBelow.handler(trustedAppend(linkBelow.comment, linkInput)),
      ),
    ).toContain("404:");

    const linkExact = await fixture({ workspaceQuotaBytes: linkCharge });
    const linkAccepted = await linkExact.handler(
      trustedAppend(linkExact.comment, linkInput),
    );
    expect(linkAccepted.status).toBe(200);
    await linkAccepted.arrayBuffer();
    const linkMessage = linkExact.storage.listShareDiscussionMessages({
      shareId: SHARE,
      limit: 100,
    }).messages[0]!;
    const originalCharge = linkMessage.storageBytes;
    expect(
      linkExact.storage.deleteShareDiscussionMessage({
        shareId: SHARE,
        messageId: linkMessage.messageId,
        deletedAtMs: 40_000,
        actorUserId: "x".repeat(DELETING_USER_ID_RESERVATION_BYTES + 1),
      }),
    ).toBeNull();
    expect(
      linkExact.storage.deleteShareDiscussionMessage({
        shareId: SHARE,
        messageId: linkMessage.messageId,
        deletedAtMs: 40_001,
        actorUserId: OWNER,
      }),
    ).toMatchObject({ messageId: linkMessage.messageId });
    expect(
      linkExact.storage.listShareDiscussionMessages({ shareId: SHARE, limit: 100 })
        .messages[0]!.storageBytes,
    ).toBe(originalCharge);

    for (const named of [
      {
        actor: OWNER,
        displayName: "Owner Name",
        body: "owner quota body",
        idempotencyKey: "quota-owner",
      },
      {
        actor: COMMENTER,
        displayName: "Commenter Name",
        body: "named quota body",
        idempotencyKey: "quota-named",
      },
    ]) {
      const charge = namedMessageCharge({
        actorUserId: named.actor,
        displayName: named.displayName,
        body: named.body,
        idempotencyKey: named.idempotencyKey,
      });
      const below = await fixture({ workspaceQuotaBytes: charge - 1 });
      const refused = await below.handler(
        request(
          named.actor,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({ body: named.body, idempotencyKey: named.idempotencyKey }),
        ),
      );
      expect(refused.status, named.actor).toBe(413);
      expectPrivate(refused);

      const exact = await fixture({ workspaceQuotaBytes: charge });
      const accepted = await exact.handler(
        request(
          named.actor,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({ body: named.body, idempotencyKey: named.idempotencyKey }),
        ),
      );
      expect(accepted.status, named.actor).toBe(200);
      expectPrivate(accepted);
      await accepted.arrayBuffer();
    }
  });

  it("pages by a bounded keyset without gaps or duplicates across a tombstone", async () => {
    const test = await fixture();
    for (let index = 0; index < 105; index += 1) {
      const response = await test.handler(
        request(
          OWNER,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({ body: `message ${index}`, idempotencyKey: `page-${index}` }),
        ),
      );
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    const defaultPageResponse = await test.handler(
      linkRequest(test.view, "/sync/link/discussion"),
    );
    const defaultPage = await body(defaultPageResponse);
    expect(messages(defaultPage)).toHaveLength(50);
    expect(defaultPage.nextCursor).toEqual(expect.any(String));
    const maxPage = await body(
      await test.handler(
        linkRequest(test.view, "/sync/link/discussion?limit=100"),
      ),
    );
    expect(messages(maxPage)).toHaveLength(100);

    const tombstoneTarget = test.storage.listShareDiscussionMessages({
      shareId: SHARE,
      limit: 100,
    }).messages[30]!;
    expect(
      test.storage.deleteShareDiscussionMessage({
        shareId: SHARE,
        messageId: tombstoneTarget.messageId,
        deletedAtMs: 50_000,
        actorUserId: OWNER,
      }),
    ).toMatchObject({ messageId: tombstoneTarget.messageId });

    const collected: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    do {
      const response = await test.handler(
        linkRequest(
          test.comment,
          `/sync/link/discussion?limit=17${cursor ? `&cursor=${cursor}` : ""}`,
        ),
      );
      expect(response.status).toBe(200);
      const page = await body(response);
      collected.push(...messages(page));
      cursor = page.nextCursor === null ? null : String(page.nextCursor);
    } while (cursor !== null);
    expect(collected).toHaveLength(105);
    expect(new Set(collected.map((message) => message.messageId)).size).toBe(105);
    expect(
      collected.find((message) => message.messageId === tombstoneTarget.messageId),
    ).toEqual({
      messageId: tombstoneTarget.messageId,
      createdAtMs: tombstoneTarget.createdAtMs,
      deleted: true,
    });
    const overMax = await test.handler(
      linkRequest(test.view, "/sync/link/discussion?limit=101"),
    );
    expect(overMax.status).toBe(400);
    expectPrivate(overMax);
  });

  it("keeps internal sentinels out of public and named projections and moderation handles owner-only", async () => {
    const test = await fixture();
    const linkResponse = await test.handler(
      trustedAppend(test.comment, {
        body: "public message",
        claimedName: "Public Link Name",
        idempotencyKey: "sentinel-link",
      }),
    );
    expect(linkResponse.status).toBe(200);
    await linkResponse.arrayBuffer();
    const rawLink = test.storage.listShareDiscussionMessages({
      shareId: SHARE,
      limit: 100,
    }).messages[0]!;
    expect(rawLink.linkPrincipalId).not.toBeNull();
    expect(
      (
        await test.handler(
          request(
            COMMENTER,
            `/sync/shares/${SHARE}/discussion`,
            jsonRequest({ body: "named message", idempotencyKey: "sentinel-named" }),
          ),
        )
      ).status,
    ).toBe(200);

    const publicJson = JSON.stringify(
      await body(
        await test.handler(linkRequest(test.view, "/sync/link/discussion")),
      ),
    );
    const namedJson = JSON.stringify(
      await body(
        await test.handler(
          request(COMMENTER, `/sync/shares/${SHARE}/discussion`),
        ),
      ),
    );
    for (const serialized of [publicJson, namedJson]) {
      for (const sentinel of [
        OWNER,
        COMMENTER,
        VIEWER,
        EDITOR,
        WORKSPACE,
        SHARE,
        test.comment.grantId,
        rawLink.linkPrincipalId!,
        test.comment.secret,
        test.comment.capabilityToken,
        PROFILE_A,
        "credential-comment-sentinel",
        "session-comment-sentinel",
      ]) {
        expect(serialized, sentinel).not.toContain(sentinel);
      }
    }

    const ownerPage = await body(
      await test.handler(request(OWNER, `/sync/shares/${SHARE}/discussion`)),
    );
    const ownerJson = JSON.stringify(ownerPage);
    expect(ownerJson).toContain(test.comment.grantId);
    expect(ownerJson).toContain(rawLink.linkPrincipalId!);
    expect(ownerPage.linkCommentsPaused).toBe(false);
    expect(messages(ownerPage)[0]!.moderation).toEqual({
      linkGrantId: test.comment.grantId,
      linkPrincipalId: rawLink.linkPrincipalId,
      blocked: false,
    });

    expect(
      (
        await test.handler(
          moderationRequest(OWNER, {
            action: "block",
            principalId: rawLink.linkPrincipalId,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await test.handler(moderationRequest(OWNER, { action: "pause" }))
      ).status,
    ).toBe(200);

    expect(
      test.storage.deleteShareDiscussionMessage({
        shareId: SHARE,
        messageId: rawLink.messageId,
        deletedAtMs: 60_000,
        actorUserId: OWNER,
      }),
    ).toMatchObject({ messageId: rawLink.messageId });
    const publicTombstone = messages(
      await body(
        await test.handler(linkRequest(test.view, "/sync/link/discussion")),
      ),
    )[0]!;
    expect(publicTombstone).toEqual({
      messageId: rawLink.messageId,
      createdAtMs: rawLink.createdAtMs,
      deleted: true,
    });
    expect(JSON.stringify(publicTombstone)).not.toContain("Public Link Name");

    const pausedPublic = await body(
      await test.handler(linkRequest(test.view, "/sync/link/discussion")),
    );
    const pausedNamed = await body(
      await test.handler(request(COMMENTER, `/sync/shares/${SHARE}/discussion`)),
    );
    for (const page of [pausedPublic, pausedNamed]) {
      expect(page).not.toHaveProperty("linkCommentsPaused");
      expect(messages(page)[0]).not.toHaveProperty("moderation");
    }

    test.storage.close();
    storages.splice(storages.indexOf(test.storage), 1);
    const reopened = openSyncRelayStorage(test.dbPath);
    storages.push(reopened);
    const restarted = test.makeHandler(reopened);
    const restartedPage = await body(
      await restarted(request(OWNER, `/sync/shares/${SHARE}/discussion`)),
    );
    expect(restartedPage.linkCommentsPaused).toBe(true);
    expect(messages(restartedPage)[0]).toMatchObject({
      messageId: rawLink.messageId,
      deleted: true,
      moderation: {
        linkGrantId: test.comment.grantId,
        linkPrincipalId: rawLink.linkPrincipalId,
        blocked: true,
      },
    });
    for (const action of [
      { action: "resume" },
      { action: "unblock", principalId: rawLink.linkPrincipalId },
    ]) {
      expect((await restarted(moderationRequest(OWNER, action))).status).toBe(200);
    }
    const reversedPage = await body(
      await restarted(request(OWNER, `/sync/shares/${SHARE}/discussion`)),
    );
    expect(reversedPage.linkCommentsPaused).toBe(false);
    expect(messages(reversedPage)[0]!.moderation).toMatchObject({ blocked: false });
  });

  it("projects owner moderation state from the same storage page snapshot", async () => {
    const test = await fixture();
    const appended = await test.handler(
      trustedAppend(test.comment, {
        body: "snapshot message",
        claimedName: "Snapshot Profile",
        idempotencyKey: "snapshot-state",
      }),
    );
    expect(appended.status).toBe(200);
    await appended.arrayBuffer();
    const principalId = test.storage.listShareDiscussionMessages({
      shareId: SHARE,
      limit: 100,
    }).messages[0]!.linkPrincipalId!;
    expect(
      test.storage.setLinkPrincipalBlocked({
        shareId: SHARE,
        principalId,
        actorUserId: OWNER,
        blockedAtMs: 70_000,
      }),
    ).toBe(true);
    expect(
      test.storage.setShareLinkWritesPaused({
        shareId: SHARE,
        actorUserId: OWNER,
        pausedAtMs: 70_001,
      }),
    ).toBe(true);

    const listPage = test.storage.listShareDiscussionMessages.bind(test.storage);
    test.storage.listShareDiscussionMessages = (input) => {
      const page = listPage(input);
      expect(
        test.storage.setLinkPrincipalBlocked({
          shareId: SHARE,
          principalId,
          actorUserId: OWNER,
          blockedAtMs: null,
        }),
      ).toBe(true);
      expect(
        test.storage.setShareLinkWritesPaused({
          shareId: SHARE,
          actorUserId: OWNER,
          pausedAtMs: null,
        }),
      ).toBe(true);
      return page;
    };

    const response = await test.handler(
      request(OWNER, `/sync/shares/${SHARE}/discussion`),
    );
    expect(response.status).toBe(200);
    const page = await body(response);
    expect(page.linkCommentsPaused).toBe(true);
    expect(messages(page)[0]!.moderation).toEqual({
      linkGrantId: test.comment.grantId,
      linkPrincipalId: principalId,
      blocked: true,
    });
    expect(test.storage.getShareLinkWritesPausedAtMs(SHARE)).toBeNull();
    expect(test.storage.getLinkPrincipal(principalId)!.blockedAtMs).toBeNull();
  });

  it("projects an authenticated read with the final current relationship", async () => {
    const test = await fixture({ namedRecipient: OWNER });
    const appended = await test.handler(
      trustedAppend(test.comment, {
        body: "relationship race",
        claimedName: "Race Link",
        idempotencyKey: "relationship-race",
      }),
    );
    expect(appended.status).toBe(200);
    await appended.arrayBuffer();
    const raw = test.storage.listShareDiscussionMessages({
      shareId: SHARE,
      limit: 100,
    }).messages[0]!;

    const originalOwnership = test.storage.workspaceIsOwnedBy.bind(test.storage);
    let ownerChecks = 0;
    test.storage.workspaceIsOwnedBy = (workspaceId, userId) => {
      if (workspaceId !== WORKSPACE || userId !== OWNER) {
        return originalOwnership(workspaceId, userId);
      }
      ownerChecks += 1;
      // Initial owner projection, then ownership loss, while the independent
      // named grant's standing check remains valid in this deterministic race.
      return ownerChecks !== 2;
    };

    const response = await test.handler(
      request(OWNER, `/sync/shares/${SHARE}/discussion`),
    );
    expect(response.status).toBe(200);
    expectPrivate(response);
    const serialized = JSON.stringify(await body(response));
    expect(ownerChecks).toBe(3);
    expect(serialized).not.toContain(test.comment.grantId);
    expect(serialized).not.toContain(raw.linkPrincipalId!);
    expect(messages(JSON.parse(serialized) as Record<string, unknown>)[0]).toEqual({
      messageId: raw.messageId,
      createdAtMs: raw.createdAtMs,
      deleted: false,
      body: "relationship race",
      author: {
        kind: "link",
        displayName: "Race Link",
        unverified: true,
      },
    });
  });

  it("lets only the current owner delete a message without changing its durable charge", async () => {
    const test = await fixture();
    const appended = await test.handler(
      trustedAppend(test.comment, {
        body: "delete-body-sentinel",
        claimedName: "Delete Link",
        idempotencyKey: "delete-target",
      }),
    );
    expect(appended.status).toBe(200);
    await appended.arrayBuffer();
    const original = test.storage.listShareDiscussionMessages({
      shareId: SHARE,
      limit: 100,
    }).messages[0]!;
    const beforeUsage = discussionUsage(test.dbPath);

    const deleted = await test.handler(
      moderationRequest(OWNER, {
        action: "delete",
        messageId: original.messageId,
      }),
    );
    expect(deleted.status).toBe(200);
    expectPrivate(deleted);
    expect(await body(deleted)).toEqual({
      ok: true,
      message: {
        messageId: original.messageId,
        createdAtMs: original.createdAtMs,
        deleted: true,
      },
    });
    expect(
      await genericRefusal(
        await test.handler(
          moderationRequest(OWNER, {
            action: "delete",
            messageId: original.messageId,
          }),
        ),
      ),
    ).toContain("404:");

    for (const pendingRead of [
      test.handler(linkRequest(test.view, "/sync/link/discussion")),
      test.handler(request(COMMENTER, `/sync/shares/${SHARE}/discussion`)),
      test.handler(request(OWNER, `/sync/shares/${SHARE}/discussion`)),
    ]) {
      const response = await pendingRead;
      expect(response.status).toBe(200);
      const serialized = JSON.stringify(await body(response));
      expect(serialized).not.toContain("delete-body-sentinel");
      expect(serialized).toContain(`\"messageId\":\"${original.messageId}\"`);
      expect(serialized).toContain("\"deleted\":true");
    }
    const stored = test.storage.listShareDiscussionMessages({
      shareId: SHARE,
      limit: 100,
    }).messages[0]!;
    expect(stored).toMatchObject({
      messageId: original.messageId,
      body: null,
      deletedByUserId: OWNER,
      storageBytes: original.storageBytes,
    });
    expect(discussionUsage(test.dbPath)).toBe(beforeUsage);

    test.storage.close();
    storages.splice(storages.indexOf(test.storage), 1);
    const reopened = openSyncRelayStorage(test.dbPath);
    storages.push(reopened);
    const restarted = test.makeHandler(reopened);
    for (const response of [
      await restarted(linkRequest(test.view, "/sync/link/discussion")),
      await restarted(request(COMMENTER, `/sync/shares/${SHARE}/discussion`)),
      await restarted(request(OWNER, `/sync/shares/${SHARE}/discussion`)),
    ]) {
      expect(response.status).toBe(200);
      const serialized = JSON.stringify(await body(response));
      expect(serialized).not.toContain("delete-body-sentinel");
      expect(serialized).toContain("\"deleted\":true");
    }
    expect(discussionUsage(test.dbPath)).toBe(beforeUsage);
  });

  it("keeps a blocked protected profile durable while preserving reads and fresh-profile access", async () => {
    const test = await fixture();
    const seeded = await test.handler(
      trustedAppend(
        test.comment,
        {
          body: "blocked-profile-body",
          claimedName: "Blocked Profile",
          idempotencyKey: "block-seed",
        },
        PROFILE_A,
      ),
    );
    expect(seeded.status).toBe(200);
    await seeded.arrayBuffer();
    const principalId = test.storage.listShareDiscussionMessages({
      shareId: SHARE,
      limit: 100,
    }).messages[0]!.linkPrincipalId!;

    const blocked = await test.handler(
      moderationRequest(OWNER, { action: "block", principalId }),
    );
    expect(blocked.status).toBe(200);
    expect(await body(blocked)).toEqual({ ok: true, blocked: true });
    expect(test.storage.getLinkPrincipal(principalId)).toMatchObject({
      blockedAtMs: expect.any(Number),
    });
    expect(
      test.storage.findLinkSessionByCapabilityHash(
        hashLinkBearer(test.comment.capabilityToken, LINK_KEY),
      ),
    ).toMatchObject({ principalId: null });

    for (const path of ["/sync/link/discussion", "/sync/link/share"]) {
      const read = await test.handler(linkRequest(test.comment, path));
      expect(read.status, path).toBe(200);
      await read.arrayBuffer();
    }
    expect(
      await discussionStateRefusal(
        await test.handler(
          trustedAppend(
            test.comment,
            { body: "blocked current", idempotencyKey: "blocked-current" },
            PROFILE_A,
          ),
        ),
        "blocked",
      ),
    ).toContain("link_discussion_blocked");

    expect(
      (
        await test.handler(moderationRequest(OWNER, { action: "pause" }))
      ).status,
    ).toBe(200);
    expect(
      await discussionStateRefusal(
        await test.handler(
          trustedAppend(
            test.comment,
            {
              body: "paused before blocked",
              idempotencyKey: "paused-before-blocked",
            },
            PROFILE_A,
          ),
        ),
        "paused",
      ),
    ).toContain("link_discussion_paused");
    expect(
      (
        await test.handler(moderationRequest(OWNER, { action: "resume" }))
      ).status,
    ).toBe(200);

    const refresh = await test.handler(
      linkRequest(
        test.comment,
        "/sync/link-refresh",
        { method: "POST" },
        { relayKey: RELAY_KEY },
      ),
    );
    expect(refresh.status).toBe(200);
    test.comment.capabilityToken = String((await body(refresh)).capabilityToken);
    expect(
      await discussionStateRefusal(
        await test.handler(
          trustedAppend(
            test.comment,
            { body: "blocked refresh", idempotencyKey: "blocked-refresh" },
            PROFILE_A,
          ),
        ),
        "blocked",
      ),
    ).toContain("link_discussion_blocked");

    test.comment.capabilityToken = await exchangeLink(test, test.comment.secret);
    expect(
      await discussionStateRefusal(
        await test.handler(
          trustedAppend(
            test.comment,
            { body: "blocked exchange", idempotencyKey: "blocked-exchange" },
            PROFILE_A,
          ),
        ),
        "blocked",
      ),
    ).toContain("link_discussion_blocked");

    const rotated = await test.handler(
      request(
        OWNER,
        `/sync/shares/${SHARE}/links/${test.comment.grantId}/rotate`,
        jsonRequest({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
      ),
    );
    expect(rotated.status).toBe(200);
    const rotatedUrl = new URL(String((await body(rotated)).url));
    const rotatedSecret = rotatedUrl.hash.slice(1);
    test.comment.secret = rotatedSecret;
    test.comment.capabilityToken = await exchangeLink(test, rotatedSecret);
    expect(
      await discussionStateRefusal(
        await test.handler(
          trustedAppend(
            test.comment,
            { body: "blocked rotation", idempotencyKey: "blocked-rotation" },
            PROFILE_A,
          ),
        ),
        "blocked",
      ),
    ).toContain("link_discussion_blocked");
    expect(
      (
        await test.handler(
          trustedAppend(
            test.comment,
            { body: "fresh profile", idempotencyKey: "block-fresh" },
            PROFILE_B,
          ),
        )
      ).status,
    ).toBe(200);
    expect(count(test.dbPath, "sync_relay_link_principals")).toBe(2);

    const unblocked = await test.handler(
      moderationRequest(OWNER, { action: "unblock", principalId }),
    );
    expect(unblocked.status).toBe(200);
    expect(await body(unblocked)).toEqual({ ok: true, blocked: false });
    test.comment.capabilityToken = await exchangeLink(test, rotatedSecret);
    expect(
      (
        await test.handler(
          trustedAppend(
            test.comment,
            { body: "original restored", idempotencyKey: "block-restored" },
            PROFILE_A,
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      test.storage.listShareDiscussionMessages({ shareId: SHARE, limit: 100 })
        .messages.at(-1)!.linkPrincipalId,
    ).toBe(principalId);

    const revoked = await test.handler(
      request(
        OWNER,
        `/sync/shares/${SHARE}/revoke`,
        jsonRequest({
          workspaceId: WORKSPACE,
          grantId: test.comment.grantId,
          expectedDependentGrantIds: [],
        }),
      ),
    );
    expect(revoked.status).toBe(200);
    for (const action of ["block", "unblock"] as const) {
      const response = await test.handler(
        moderationRequest(OWNER, { action, principalId }),
      );
      expect(response.status, action).toBe(200);
      await response.arrayBuffer();
    }
    expect(
      await genericRefusal(
        await test.handler(
          trustedAppend(
            test.comment,
            { body: "revoked", idempotencyKey: "block-revoked" },
            PROFILE_A,
          ),
        ),
      ),
    ).toContain("404:");
  });

  it("ejects every session bound to a blocked protected profile", async () => {
    const test = await fixture();
    const firstSession = { ...test.comment };
    const seeded = await test.handler(
      trustedAppend(
        firstSession,
        {
          body: "first bound session",
          claimedName: "Shared Profile",
          idempotencyKey: "block-all-first",
        },
        PROFILE_A,
      ),
    );
    expect(seeded.status).toBe(200);
    await seeded.arrayBuffer();
    const principalId = test.storage.listShareDiscussionMessages({
      shareId: SHARE,
      limit: 100,
    }).messages[0]!.linkPrincipalId!;

    const secondSession = {
      ...test.comment,
      capabilityToken: await exchangeLink(test, test.comment.secret),
    };
    const secondBound = await test.handler(
      trustedAppend(
        secondSession,
        {
          body: "second bound session",
          idempotencyKey: "block-all-second",
        },
        PROFILE_A,
      ),
    );
    expect(secondBound.status).toBe(200);
    await secondBound.arrayBuffer();

    for (const link of [firstSession, secondSession]) {
      expect(
        test.storage.findLinkSessionByCapabilityHash(
          hashLinkBearer(link.capabilityToken, LINK_KEY),
        ),
      ).toMatchObject({ principalId });
    }
    const messagesBeforeBlock = count(
      test.dbPath,
      "sync_relay_share_discussion_messages",
    );
    const usageBeforeBlock = discussionUsage(test.dbPath);

    const blocked = await test.handler(
      moderationRequest(OWNER, { action: "block", principalId }),
    );
    expect(blocked.status).toBe(200);
    expect(await body(blocked)).toEqual({ ok: true, blocked: true });

    for (const [index, link] of [firstSession, secondSession].entries()) {
      expect(
        test.storage.findLinkSessionByCapabilityHash(
          hashLinkBearer(link.capabilityToken, LINK_KEY),
        ),
      ).toMatchObject({ principalId: null });
      for (const path of ["/sync/link/discussion", "/sync/link/share"]) {
        const read = await test.handler(linkRequest(link, path));
        expect(read.status, `session ${index + 1} ${path}`).toBe(200);
        await read.arrayBuffer();
      }
      expect(
        await discussionStateRefusal(
          await test.handler(
            trustedAppend(
              link,
              {
                body: `blocked session ${index + 1}`,
                idempotencyKey: `block-all-refused-${index + 1}`,
              },
              PROFILE_A,
            ),
          ),
          "blocked",
        ),
      ).toContain("link_discussion_blocked");
    }

    expect(
      count(test.dbPath, "sync_relay_share_discussion_messages"),
    ).toBe(messagesBeforeBlock);
    expect(discussionUsage(test.dbPath)).toBe(usageBeforeBlock);
  });

  it("pauses only link-authored writes and resumes without rotating authority or charging debt", async () => {
    const test = await fixture();
    const commentPeer = addIndependentCommentLink(test.storage);
    const seeded = await test.handler(
      trustedAppend(test.comment, {
        body: "pause seed",
        claimedName: "Pause Profile",
        idempotencyKey: "pause-seed",
      }),
    );
    expect(seeded.status).toBe(200);
    await seeded.arrayBuffer();
    const peerSeeded = await test.handler(
      trustedAppend(
        commentPeer,
        {
          body: "pause peer seed",
          claimedName: "Pause Peer Profile",
          idempotencyKey: "pause-peer-seed",
        },
        PROFILE_B,
      ),
    );
    expect(peerSeeded.status).toBe(200);
    await peerSeeded.arrayBuffer();
    const seededMessages = test.storage.listShareDiscussionMessages({
      shareId: SHARE,
      limit: 100,
    }).messages;
    const principalId = seededMessages.find(
      (message) => message.body === "pause seed",
    )!.linkPrincipalId;
    const peerPrincipalId = seededMessages.find(
      (message) => message.body === "pause peer seed",
    )!.linkPrincipalId;
    expect(peerPrincipalId).not.toBe(principalId);
    const grantBefore = new Map(
      [test.comment, commentPeer].map((link) => [
        link.grantId,
        test.storage.getShareGrant(link.grantId)!,
      ]),
    );
    const usageBefore = discussionUsage(test.dbPath);
    const principalCountBefore = count(test.dbPath, "sync_relay_link_principals");
    const capabilityBefore = new Map(
      [test.comment, commentPeer].map((link) => [link.grantId, link.capabilityToken]),
    );

    const paused = await test.handler(
      moderationRequest(OWNER, { action: "pause" }),
    );
    expect(paused.status).toBe(200);
    expect(await body(paused)).toEqual({ ok: true, linkCommentsPaused: true });
    expect(discussionUsage(test.dbPath)).toBe(usageBefore);
    for (const link of [test.comment, commentPeer]) {
      expect(test.storage.getShareGrant(link.grantId)).toEqual(
        grantBefore.get(link.grantId),
      );
      expect(link.capabilityToken).toBe(capabilityBefore.get(link.grantId));
    }
    expect(count(test.dbPath, "sync_relay_link_principals")).toBe(
      principalCountBefore,
    );

    for (const link of [test.comment, commentPeer]) {
      for (const path of ["/sync/link/discussion", "/sync/link/share"]) {
        const read = await test.handler(linkRequest(link, path));
        expect(read.status, `${link.access}:${path}`).toBe(200);
        await read.arrayBuffer();
      }
    }
    for (const [link, profileSecret, suffix] of [
      [test.comment, PROFILE_A, "first"],
      [commentPeer, PROFILE_B, "peer"],
    ] as const) {
      expect(
        await discussionStateRefusal(
          await test.handler(
            trustedAppend(
              link,
              {
                body: `${suffix} link paused`,
                idempotencyKey: `pause-link-${suffix}`,
              },
              profileSecret,
            ),
          ),
          "paused",
        ),
      ).toContain("link_discussion_paused");
    }
    for (const [actor, key] of [
      [OWNER, "pause-owner"],
      [COMMENTER, "pause-named"],
      [EDITOR, "pause-editor"],
    ] as const) {
      const response = await test.handler(
        request(
          actor,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({ body: `write from ${actor}`, idempotencyKey: key }),
        ),
      );
      expect(response.status, actor).toBe(200);
      await response.arrayBuffer();
    }

    const beforeResumeUsage = discussionUsage(test.dbPath);
    const resumed = await test.handler(
      moderationRequest(OWNER, { action: "resume" }),
    );
    expect(resumed.status).toBe(200);
    expect(await body(resumed)).toEqual({ ok: true, linkCommentsPaused: false });
    expect(discussionUsage(test.dbPath)).toBe(beforeResumeUsage);
    for (const link of [test.comment, commentPeer]) {
      expect(test.storage.getShareGrant(link.grantId)).toEqual(
        grantBefore.get(link.grantId),
      );
      expect(link.capabilityToken).toBe(capabilityBefore.get(link.grantId));
    }
    expect(count(test.dbPath, "sync_relay_link_principals")).toBe(
      principalCountBefore,
    );
    const restoredPrincipals: Array<string | null> = [];
    for (const [link, profileSecret, suffix] of [
      [test.comment, PROFILE_A, "first"],
      [commentPeer, PROFILE_B, "peer"],
    ] as const) {
      const restored = await test.handler(
        trustedAppend(
          link,
          {
            body: `${suffix} link resumed`,
            idempotencyKey: `resume-link-${suffix}`,
          },
          profileSecret,
        ),
      );
      expect(restored.status, suffix).toBe(200);
      await restored.arrayBuffer();
      restoredPrincipals.push(
        test.storage.listShareDiscussionMessages({ shareId: SHARE, limit: 100 })
          .messages.find((message) => message.body === `${suffix} link resumed`)!
          .linkPrincipalId,
      );
    }
    expect(restoredPrincipals).toEqual([principalId, peerPrincipalId]);
  });

  it("serializes revoke, block, and pause against link append in both commit orders", async () => {
    const runTransition = async (
      test: Fixture,
      transition: "revoke" | "block" | "pause",
      principalId: string | null,
    ): Promise<Response> =>
      transition === "revoke"
        ? test.handler(
            request(
              OWNER,
              `/sync/shares/${SHARE}/revoke`,
              jsonRequest({
                workspaceId: WORKSPACE,
                grantId: test.comment.grantId,
                expectedDependentGrantIds: [],
              }),
            ),
          )
        : test.handler(
            moderationRequest(
              OWNER,
              transition === "block"
                ? { action: "block", principalId }
                : { action: "pause" },
            ),
          );

    const buffered = await fixture();
    const originalAppend = buffered.storage.appendLinkDiscussionMessage.bind(
      buffered.storage,
    );
    buffered.storage.appendLinkDiscussionMessage = (input) =>
      originalAppend({
        ...input,
        guard: () => {
          input.guard?.();
          expect(
            buffered.storage.setShareLinkWritesPaused({
              shareId: SHARE,
              actorUserId: OWNER,
              pausedAtMs: 19_000,
            }),
          ).toBe(true);
        },
      });
    expect(
      await discussionStateRefusal(
        await buffered.handler(
          trustedAppend(buffered.comment, {
            body: "buffered before pause",
            idempotencyKey: "buffered-pause",
          }),
        ),
        "paused",
      ),
    ).toContain("link_discussion_paused");
    expect(count(buffered.dbPath, "sync_relay_share_discussion_messages")).toBe(0);
    expect(count(buffered.dbPath, "sync_relay_link_principals")).toBe(0);

    for (const transition of ["revoke", "block", "pause"] as const) {
      const transitionFirst = await fixture();
      let principalId: string | null = null;
      if (transition === "block") {
        const seed = await transitionFirst.handler(
          trustedAppend(transitionFirst.comment, {
            body: "race principal",
            idempotencyKey: "race-principal",
          }),
        );
        expect(seed.status).toBe(200);
        await seed.arrayBuffer();
        principalId = transitionFirst.storage.listShareDiscussionMessages({
          shareId: SHARE,
          limit: 100,
        }).messages[0]!.linkPrincipalId;
      }
      const beforeMessages = count(
        transitionFirst.dbPath,
        "sync_relay_share_discussion_messages",
      );
      const beforePrincipals = count(
        transitionFirst.dbPath,
        "sync_relay_link_principals",
      );
      const transitionResponse = await runTransition(
        transitionFirst,
        transition,
        principalId,
      );
      expect(transitionResponse.status, `${transition}:transition-first`).toBe(
        200,
      );
      await transitionResponse.arrayBuffer();
      const refused = await transitionFirst.handler(
        trustedAppend(transitionFirst.comment, {
          body: `transition first ${transition}`,
          idempotencyKey: `transition-first-${transition}`,
        }),
      );
      if (transition === "block" || transition === "pause") {
        await discussionStateRefusal(
          refused,
          transition === "block" ? "blocked" : "paused",
        );
      } else {
        expect(await genericRefusal(refused)).toContain("404:");
      }
      expect(
        count(
          transitionFirst.dbPath,
          "sync_relay_share_discussion_messages",
        ),
      ).toBe(beforeMessages);
      expect(
        count(transitionFirst.dbPath, "sync_relay_link_principals"),
      ).toBe(beforePrincipals);

      const appendFirst = await fixture();
      const accepted = await appendFirst.handler(
        trustedAppend(appendFirst.comment, {
          body: `append first ${transition}`,
          idempotencyKey: `append-first-${transition}`,
        }),
      );
      expect(accepted.status).toBe(200);
      await accepted.arrayBuffer();
      const appendedPrincipal = appendFirst.storage.listShareDiscussionMessages({
        shareId: SHARE,
        limit: 100,
      }).messages[0]!.linkPrincipalId;
      const response = await runTransition(
        appendFirst,
        transition,
        appendedPrincipal,
      );
      expect(response.status, `${transition}:append-first`).toBe(200);
      await response.arrayBuffer();
      expect(
        count(appendFirst.dbPath, "sync_relay_share_discussion_messages"),
      ).toBe(1);
      expect(count(appendFirst.dbPath, "sync_relay_link_principals")).toBe(1);
    }
  });

  it("refuses every non-owner, malformed action, and unrelated handle without mutation", async () => {
    const test = await fixture();
    const seeded = await test.handler(
      trustedAppend(test.comment, {
        body: "moderation-secret-body-sentinel",
        claimedName: "Moderation Secret Profile",
        idempotencyKey: "moderation-refusal-seed",
      }),
    );
    expect(seeded.status).toBe(200);
    await seeded.arrayBuffer();
    const target = test.storage.listShareDiscussionMessages({
      shareId: SHARE,
      limit: 100,
    }).messages[0]!;
    const crossShare = seedCrossShareHandles(test.storage);
    const beforeUsage = discussionUsage(test.dbPath);
    const beforeRows = count(test.dbPath, "sync_relay_share_discussion_messages");

    const baseline = await genericRefusal(
      await test.handler(moderationRequest(COMMENTER, { action: "pause" })),
    );
    const refusals = [
      test.handler(
        linkRequest(
          test.comment,
          `/sync/shares/${SHARE}/discussion/moderation`,
          jsonRequest({ action: "pause" }),
        ),
      ),
      test.handler(
        moderationRequest(OWNER, {
          action: "delete",
          messageId: "unknown-message-handle",
        }),
      ),
      test.handler(
        moderationRequest(OWNER, {
          action: "block",
          principalId: crossShare.principalId,
        }),
      ),
      test.handler(
        moderationRequest(OWNER, {
          action: "delete",
          messageId: crossShare.messageId,
        }),
      ),
      test.handler(
        moderationRequest(OWNER, { action: "pause", workspaceId: WORKSPACE }),
      ),
      test.handler(moderationRequest(OWNER, { action: "mute" })),
      test.handler(
        moderationRequest(
          OWNER,
          { action: "pause" },
          { method: "GET", body: null },
        ),
      ),
    ];
    for (const response of await Promise.all(refusals)) {
      expect(await genericRefusal(response)).toBe(baseline);
    }
    expect(test.storage.getShareLinkWritesPausedAtMs(SHARE)).toBeNull();
    expect(test.storage.getLinkPrincipal(target.linkPrincipalId!)!.blockedAtMs).toBeNull();
    expect(test.storage.getLinkPrincipal(crossShare.principalId)!.blockedAtMs).toBeNull();
    expect(count(test.dbPath, "sync_relay_share_discussion_messages")).toBe(beforeRows);
    expect(discussionUsage(test.dbPath)).toBe(beforeUsage);

    const originalPause = test.storage.setShareLinkWritesPaused.bind(test.storage);
    test.storage.setShareLinkWritesPaused = (input) => {
      updateWorkspaceOwner(test.dbPath, NEW_OWNER);
      return originalPause(input);
    };
    expect(
      await genericRefusal(
        await test.handler(moderationRequest(OWNER, { action: "pause" })),
      ),
    ).toBe(baseline);
    expect(test.storage.getShareLinkWritesPausedAtMs(SHARE)).toBeNull();
    expect(
      await genericRefusal(
        await test.handler(
          moderationRequest(OWNER, {
            action: "delete",
            messageId: target.messageId,
          }),
        ),
      ),
    ).toBe(baseline);

    const currentOwner = await test.handler(
      moderationRequest(NEW_OWNER, { action: "pause" }),
    );
    expect(currentOwner.status).toBe(200);
    expectPrivate(currentOwner);
    const serialized = JSON.stringify(await body(currentOwner));
    expect(serialized).toBe('{"ok":true,"linkCommentsPaused":true}');
    for (const sentinel of [
      OWNER,
      NEW_OWNER,
      WORKSPACE,
      SHARE,
      test.comment.grantId,
      target.messageId,
      target.linkPrincipalId!,
      test.comment.secret,
      test.comment.capabilityToken,
      PROFILE_A,
      "moderation-secret-body-sentinel",
      "Moderation Secret Profile",
    ]) {
      expect(serialized, sentinel).not.toContain(sentinel);
    }

    const newOwnerRead = await test.handler(
      request(NEW_OWNER, `/sync/shares/${SHARE}/discussion`),
    );
    expect(newOwnerRead.status).toBe(200);
    const newOwnerPage = await body(newOwnerRead);
    expect(newOwnerPage.linkCommentsPaused).toBe(true);
    expect(messages(newOwnerPage)[0]!.moderation).toMatchObject({
      linkGrantId: test.comment.grantId,
      linkPrincipalId: target.linkPrincipalId,
      blocked: false,
    });
  });

  it("rechecks current workspace ownership inside every moderation transaction", async () => {
    for (const transition of ["delete", "block", "pause"] as const) {
      const test = await fixture();
      const seeded = await test.handler(
        trustedAppend(test.comment, {
          body: `ownership-race-${transition}`,
          claimedName: "Ownership Race",
          idempotencyKey: `ownership-race-${transition}`,
        }),
      );
      expect(seeded.status).toBe(200);
      await seeded.arrayBuffer();
      const target = test.storage.listShareDiscussionMessages({
        shareId: SHARE,
        limit: 100,
      }).messages[0]!;
      const beforeUsage = discussionUsage(test.dbPath);
      const baseline = await genericRefusal(
        await test.handler(moderationRequest(COMMENTER, { action: "pause" })),
      );

      if (transition === "delete") {
        const original = test.storage.deleteShareDiscussionMessage.bind(
          test.storage,
        );
        test.storage.deleteShareDiscussionMessage = (input) => {
          updateWorkspaceOwner(test.dbPath, NEW_OWNER);
          return original(input);
        };
      } else if (transition === "block") {
        const original = test.storage.setLinkPrincipalBlocked.bind(test.storage);
        test.storage.setLinkPrincipalBlocked = (input) => {
          updateWorkspaceOwner(test.dbPath, NEW_OWNER);
          return original(input);
        };
      } else {
        const original = test.storage.setShareLinkWritesPaused.bind(test.storage);
        test.storage.setShareLinkWritesPaused = (input) => {
          updateWorkspaceOwner(test.dbPath, NEW_OWNER);
          return original(input);
        };
      }

      const response = await test.handler(
        moderationRequest(
          OWNER,
          transition === "delete"
            ? { action: "delete", messageId: target.messageId }
            : transition === "block"
              ? { action: "block", principalId: target.linkPrincipalId }
              : { action: "pause" },
        ),
      );
      expect(await genericRefusal(response), transition).toBe(baseline);
      expect(
        test.storage.listShareDiscussionMessages({ shareId: SHARE, limit: 100 })
          .messages[0],
      ).toMatchObject({
        messageId: target.messageId,
        body: `ownership-race-${transition}`,
        deletedAtMs: null,
        linkPrincipalBlocked: false,
      });
      expect(test.storage.getLinkPrincipal(target.linkPrincipalId!)!.blockedAtMs).toBeNull();
      expect(test.storage.getShareLinkWritesPausedAtMs(SHARE)).toBeNull();
      expect(discussionUsage(test.dbPath)).toBe(beforeUsage);
    }
  });

  it("keeps every non-state append result behind the generic accountless refusal", async () => {
    const test = await fixture();
    const baseline = await genericRefusal(
      await test.handler(
        linkRequest(
          test.comment,
          "/sync/link/discussion",
          jsonRequest({ body: "baseline", idempotencyKey: "reason-baseline" }),
          { relayKey: "wrong-key", profileSecret: PROFILE_A },
        ),
      ),
    );
    const original = test.storage.appendLinkDiscussionMessage.bind(test.storage);
    const nonStateReasons = [
      "not-authorized",
      "name-already-set",
      "idempotency-conflict",
      "principal-limit",
      "rate-limit",
      "lifetime-limit",
      "share-limit",
      "workspace-quota",
    ] as const;
    for (const reason of nonStateReasons) {
      test.storage.appendLinkDiscussionMessage = () => ({ ok: false, reason });
      const response = await test.handler(
        trustedAppend(test.comment, {
          body: `valid trusted ${reason}`,
          idempotencyKey: `reason-${reason}`,
        }),
      );
      expect(await genericRefusal(response), reason).toBe(baseline);
    }

    test.storage.appendLinkDiscussionMessage = () => ({
      ok: false,
      reason: "invalid-input",
    });
    const invalidInput = await test.handler(
      trustedAppend(test.comment, {
        body: "valid trusted invalid-input control",
        idempotencyKey: "reason-invalid-input",
      }),
    );
    expect(invalidInput.status).toBe(400);
    expectPrivate(invalidInput);
    expect(await body(invalidInput)).toEqual({
      ok: false,
      error: "discussion message is invalid",
      code: "bad_request",
    });

    for (const state of ["blocked", "paused"] as const) {
      test.storage.appendLinkDiscussionMessage = () => ({
        ok: false,
        reason: state,
      });
      await discussionStateRefusal(
        await test.handler(
          trustedAppend(test.comment, {
            body: `valid trusted ${state} control`,
            idempotencyKey: `reason-${state}`,
          }),
        ),
        state,
      );
    }
    test.storage.appendLinkDiscussionMessage = original;
  });

  it("sets private no-store on every discussion success and refusal and keeps invalid accountless refusals byte-comparable", async () => {
    const test = await fixture();
    const linkRead = await test.handler(
      linkRequest(test.view, "/sync/link/discussion"),
    );
    const namedRead = await test.handler(
      request(VIEWER, `/sync/shares/${SHARE}/discussion`),
    );
    const linkWrite = await test.handler(
      trustedAppend(test.comment, {
        body: "cache policy",
        idempotencyKey: "cache-link",
      }),
    );
    const ownerWrite = await test.handler(
      request(
        OWNER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({ body: "owner cache", idempotencyKey: "cache-owner" }),
      ),
    );
    for (const response of [linkRead, namedRead, linkWrite, ownerWrite]) {
      expect(response.status).toBe(200);
      expectPrivate(response);
      await response.arrayBuffer();
    }

    const principalId = test.storage
      .listShareDiscussionMessages({ shareId: SHARE, limit: 100 })
      .messages.find((message) => message.authorKind === "link")!
      .linkPrincipalId!;
    for (const action of [
      { action: "block", principalId },
      { action: "pause" },
    ]) {
      expect((await test.handler(moderationRequest(OWNER, action))).status).toBe(200);
    }
    for (const read of [
      await test.handler(linkRequest(test.comment, "/sync/link/discussion")),
      await test.handler(request(COMMENTER, `/sync/shares/${SHARE}/discussion`)),
    ]) {
      expect(read.status).toBe(200);
      const serialized = await read.text();
      expect(serialized).not.toContain("link_discussion_paused");
      expect(serialized).not.toContain("link_discussion_blocked");
    }

    const invalids = await Promise.all([
      test.handler(
        linkRequest(
          test.comment,
          "/sync/link/discussion",
          jsonRequest({ body: "x", idempotencyKey: "invalid-1" }),
          { relayKey: "wrong-key", profileSecret: PROFILE_A },
        ),
      ),
      test.handler(
        linkRequest(
          { ...test.comment, capabilityToken: secret("z") },
          "/sync/link/discussion",
          jsonRequest({ body: "x", idempotencyKey: "invalid-2" }),
          { relayKey: RELAY_KEY, profileSecret: PROFILE_A },
        ),
      ),
      test.handler(
        linkRequest(
          test.comment,
          "/sync/link/discussion",
          jsonRequest({ body: "x", idempotencyKey: "invalid-3" }),
          { relayKey: RELAY_KEY },
        ),
      ),
      test.handler(
        linkRequest(
          { ...test.comment, capabilityToken: secret("z") },
          "/sync/link/discussion",
        ),
      ),
    ]);
    const refusalBodies = await Promise.all(invalids.map(genericRefusal));
    expect(new Set(refusalBodies).size).toBe(1);
    expect(refusalBodies[0]).not.toContain("link_discussion_paused");
    expect(refusalBodies[0]).not.toContain("link_discussion_blocked");

    const invalidInput = await test.handler(
      trustedAppend(test.comment, {
        body: "",
        idempotencyKey: "trusted-invalid-input",
      }),
    );
    expect(invalidInput.status).toBe(400);
    expectPrivate(invalidInput);
    expect(await body(invalidInput)).toEqual({
      ok: false,
      error: "discussion message is invalid",
      code: "bad_request",
    });

    await discussionStateRefusal(
      await test.handler(
        trustedAppend(test.comment, {
          body: "trusted paused",
          idempotencyKey: "trusted-paused",
        }),
      ),
      "paused",
    );
    expect(
      (
        await test.handler(moderationRequest(OWNER, { action: "resume" }))
      ).status,
    ).toBe(200);
    await discussionStateRefusal(
      await test.handler(
        trustedAppend(test.comment, {
          body: "trusted blocked",
          idempotencyKey: "trusted-blocked",
        }),
      ),
      "blocked",
    );

    const unauthenticated = await test.handler(
      request(null, `/sync/shares/${SHARE}/discussion`),
    );
    expect(unauthenticated.status).toBe(401);
    expectPrivate(unauthenticated);
  });
});
