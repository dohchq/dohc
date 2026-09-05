import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashLinkBearer } from "./linkSecurity";
import { DiscussionActivityHub } from "./discussionActivity";
import {
  createSyncRelayHandler,
  DISCUSSION_DISPLAY_NAME_LOOKUP_DEADLINE_MS,
  type SyncRelayHandler,
} from "./server";
import {
  type OpenSyncRelayStorageOptions,
  type SyncRelayStorage,
} from "./storage";
import {
  closeTestStorages,
  jsonBody as jsonRequest,
  closeTestStorage,
  reopenTestStorage,
  storagePath,
  testStorage,
} from "./linkTestHelpers";

const OWNER = "owner-account-sentinel";
const NEW_OWNER = "new-owner-account-sentinel";
const COMMENTER = "commenter-account-sentinel";
const VIEWER = "viewer-account-sentinel";
const EDITOR = "editor-account-sentinel";
const WORKSPACE = "workspace-discussion-sentinel";
const OTHER_WORKSPACE = "workspace-discussion-other-sentinel";
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

afterEach(closeTestStorages);

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
  discussionActivity: DiscussionActivityHub;
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
    discussionActivity?: DiscussionActivityHub;
    nowMs?: () => number;
    discussionLimits?: Pick<
      OpenSyncRelayStorageOptions,
      | "discussionMessageRateLimit"
      | "discussionLifetimeMessageLimit"
      | "discussionNonOwnerShareRowLimit"
    >;
  } = {},
): Promise<Fixture> {
  let discussionId = 0;
  const storage = await testStorage({
    newDiscussionId: () => `discussion-row-${++discussionId}`,
    workspaceQuotaBytes: overrides.workspaceQuotaBytes,
    ...overrides.discussionLimits,
  });
  const dbPath = storagePath(storage);
  expect(
    storage.claimWorkspace({
      workspaceId: WORKSPACE,
      ownerUserId: OWNER,
      createdAtMs: 1_000,
    }),
  ).toBe("created");
  expect(
    storage.claimWorkspace({
      workspaceId: OTHER_WORKSPACE,
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
  const discussionActivity =
    overrides.discussionActivity ?? new DiscussionActivityHub();
  const names: Record<string, string> = {
    [OWNER]: "Owner Name",
    [COMMENTER]: "Commenter Name",
    [VIEWER]: "Viewer Name",
    [EDITOR]: "",
  };
  const makeHandler = (targetStorage: SyncRelayStorage): SyncRelayHandler =>
    createSyncRelayHandler({
      storage: targetStorage,
      discussionActivity,
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
      nowMs: overrides.nowMs ?? (() => clock++),
      newId: () => `http-id-${++id}`,
      linkKey: LINK_KEY,
      shareWebOrigin: "https://share.test",
      relayExchangeKey: RELAY_KEY,
    });
  const handler = makeHandler(storage);
  return {
    storage,
    dbPath,
    handler,
    makeHandler,
    discussionActivity,
    view,
    comment,
    edit,
  };
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

function rawRequest(
  userId: string | null,
  path: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  if (userId !== null) headers.set("authorization", `Bearer user:${userId}`);
  return new Request(`http://relay.test${path}`, { ...init, headers });
}

function request(
  userId: string | null,
  path: string,
  init: RequestInit = {},
): Request {
  const url = new URL(path, "http://relay.test");
  let boundInit = init;
  if (
    (userId === OWNER || userId === NEW_OWNER) &&
    /^\/sync\/shares\/[^/]+\/discussion(?:\/activity)?$/u.test(url.pathname) &&
    (init.method ?? "GET") === "GET" &&
    !url.searchParams.has("workspaceId")
  ) {
    url.searchParams.set("workspaceId", WORKSPACE);
  }
  if (
    (userId === OWNER || userId === NEW_OWNER) &&
    /^\/sync\/shares\/[^/]+\/discussion$/u.test(url.pathname) &&
    init.method === "POST" &&
    typeof init.body === "string"
  ) {
    const parsed = JSON.parse(init.body) as Record<string, unknown>;
    if (!Object.hasOwn(parsed, "workspaceId")) {
      boundInit = { ...init, body: JSON.stringify({ ...parsed, workspaceId: WORKSPACE }) };
    }
  }
  return rawRequest(userId, `${url.pathname}${url.search}`, boundInit);
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
    { ...jsonRequest({ workspaceId: WORKSPACE, ...action }), ...init },
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

function workspaceUsage(dbPath: string, workspaceId: string): number {
  const db = new InspectionDatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(
      db
        .prepare(
          "SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id = ?",
        )
        .get(workspaceId)?.usage_bytes ?? 0,
    );
  } finally {
    db.close();
  }
}

function discussionIdempotencyRows(
  dbPath: string,
  actorUserId: string,
  idempotencyKey: string,
): number {
  const db = new InspectionDatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sync_relay_share_discussion_messages
           WHERE share_id = ?
             AND author_user_id = ?
             AND idempotency_key = ?`,
        )
        .get(SHARE, actorUserId, idempotencyKey)?.count ?? 0,
    );
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

function updateShareWorkspace(dbPath: string, workspaceId: string): void {
  const db = new InspectionDatabaseSync(dbPath);
  try {
    db
      .prepare("UPDATE sync_relay_shares SET workspace_id = ? WHERE share_id = ?")
      .run(workspaceId, SHARE);
  } finally {
    db.close();
  }
}

function transferShareOwnership(
  dbPath: string,
  workspaceId: string,
  ownerUserId: string,
): void {
  const db = new InspectionDatabaseSync(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    db
      .prepare(
        "UPDATE sync_relay_workspaces SET owner_user_id = ? WHERE workspace_id = ?",
      )
      .run(ownerUserId, workspaceId);
    db
      .prepare(
        "UPDATE sync_relay_shares SET granter_user_id = ? WHERE share_id = ?",
      )
      .run(ownerUserId, SHARE);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
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
    activityRevision: expect.any(Number),
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
const MESSAGE_FIXED_BYTES = DELETING_USER_ID_RESERVATION_BYTES + 4 * 8;
const PRINCIPAL_FIXED_BYTES = 160 + 5 * 8;

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
  it("rejects missing and same-account wrong-workspace owner discussion operations before work starts", async () => {
    const lookupUserDisplayName = vi.fn(() => "Owner Name");
    const test = await fixture({ lookupUserDisplayName });
    const baseline = await genericRefusal(
      await test.handler(
        rawRequest(
          OWNER,
          `/sync/shares/missing-discussion-share/discussion?workspaceId=${WORKSPACE}`,
        ),
      ),
    );
    const beforeRows = count(test.dbPath, "sync_relay_share_discussion_messages");
    const beforeRevision = test.storage.getShareDiscussionRevision(SHARE);
    const beforeUsage = discussionUsage(test.dbPath);
    const list = vi.spyOn(test.storage, "listShareDiscussionMessages");
    const revision = vi.spyOn(test.storage, "getShareDiscussionRevision");
    const activity = vi.spyOn(test.storage, "listShareDiscussionActivity");
    const append = vi.spyOn(test.storage, "appendAuthenticatedDiscussionMessage");

    const refusals = [
      await test.handler(rawRequest(OWNER, `/sync/shares/${SHARE}/discussion`)),
      await test.handler(
        rawRequest(
          OWNER,
          `/sync/shares/${SHARE}/discussion?workspaceId=${OTHER_WORKSPACE}`,
        ),
      ),
      await test.handler(
        rawRequest(
          OWNER,
          `/sync/shares/${SHARE}/discussion/activity?since=0&hold=0&limit=100`,
        ),
      ),
      await test.handler(
        rawRequest(
          OWNER,
          `/sync/shares/${SHARE}/discussion/activity?workspaceId=${OTHER_WORKSPACE}&since=0&hold=0&limit=100`,
        ),
      ),
      await test.handler(
        rawRequest(
          OWNER,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({ body: "missing workspace", idempotencyKey: "missing-workspace" }),
        ),
      ),
      await test.handler(
        rawRequest(
          OWNER,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({
            workspaceId: OTHER_WORKSPACE,
            body: "wrong workspace",
            idempotencyKey: "wrong-workspace",
          }),
        ),
      ),
    ];
    for (const response of refusals) {
      expect(await genericRefusal(response)).toBe(baseline);
    }
    expect(list).not.toHaveBeenCalled();
    expect(revision).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
    expect(lookupUserDisplayName).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    list.mockRestore();
    revision.mockRestore();
    activity.mockRestore();
    append.mockRestore();
    expect(count(test.dbPath, "sync_relay_share_discussion_messages")).toBe(
      beforeRows,
    );
    expect(test.storage.getShareDiscussionRevision(SHARE)).toBe(beforeRevision);
    expect(discussionUsage(test.dbPath)).toBe(beforeUsage);

    for (const malformed of [
      rawRequest(
        OWNER,
        `/sync/shares/${SHARE}/discussion?workspaceId=${WORKSPACE}&workspaceId=${WORKSPACE}`,
      ),
      rawRequest(
        OWNER,
        `/sync/shares/${SHARE}/discussion?workspaceId=${WORKSPACE}&extra=1`,
      ),
      rawRequest(
        OWNER,
        `/sync/shares/${SHARE}/discussion/activity?workspaceId=${WORKSPACE}&workspaceId=${WORKSPACE}&since=0&hold=0&limit=100`,
      ),
      rawRequest(
        OWNER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({
          workspaceId: 42,
          body: "malformed workspace",
          idempotencyKey: "malformed-workspace",
        }),
      ),
    ]) {
      const response = await test.handler(malformed);
      expectPrivate(response);
      expect(response.status).toBe(400);
    }
  });

  it("accepts the current owner workspace on list, activity, and append without exposing it", async () => {
    const test = await fixture();
    const appended = await test.handler(
      request(
        OWNER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({ body: "owner workspace", idempotencyKey: "owner-workspace" }),
      ),
    );
    expect(appended.status).toBe(200);
    expectPrivate(appended);
    const list = await test.handler(
      request(
        OWNER,
        `/sync/shares/${SHARE}/discussion?direction=newest-first&limit=100`,
      ),
    );
    expect(list.status).toBe(200);
    expectPrivate(list);
    const activity = await test.handler(
      request(
        OWNER,
        `/sync/shares/${SHARE}/discussion/activity?since=0&hold=0&limit=100`,
      ),
    );
    expect(activity.status).toBe(200);
    expectPrivate(activity);
    for (const response of [appended, list, activity]) {
      expect(await response.clone().text()).not.toContain(WORKSPACE);
    }
  });

  it("allows named Comment and Edit omission but makes supplied workspace IDs private before discussion work", async () => {
    const lookupUserDisplayName = vi.fn((userId: string) =>
      userId === COMMENTER ? "Commenter Name" : "",
    );
    const test = await fixture({ lookupUserDisplayName });
    const omissionResponses: Response[] = [];
    for (const actor of [COMMENTER, EDITOR] as const) {
      omissionResponses.push(
        await test.handler(
          rawRequest(
            actor,
            `/sync/shares/${SHARE}/discussion`,
            jsonRequest({
              body: `omitted workspace from ${actor}`,
              idempotencyKey: `named-${actor}-omission`,
            }),
          ),
        ),
        await test.handler(
          rawRequest(actor, `/sync/shares/${SHARE}/discussion?limit=100`),
        ),
        await test.handler(
          rawRequest(
            actor,
            `/sync/shares/${SHARE}/discussion/activity?since=0&hold=0&limit=100`,
          ),
        ),
      );
    }
    for (const response of omissionResponses) {
      expect(response.status).toBe(200);
      expectPrivate(response);
      expect(await response.clone().text()).not.toContain(WORKSPACE);
      expect(await response.clone().text()).not.toContain(OTHER_WORKSPACE);
    }

    const baseline = await genericRefusal(
      await test.handler(
        rawRequest(
          COMMENTER,
          `/sync/shares/missing-named-workspace-share/discussion?workspaceId=${WORKSPACE}`,
        ),
      ),
    );
    const beforeRows = count(test.dbPath, "sync_relay_share_discussion_messages");
    const beforeRevision = test.storage.getShareDiscussionRevision(SHARE);
    const beforeUsage = discussionUsage(test.dbPath);
    const list = vi.spyOn(test.storage, "listShareDiscussionMessages");
    const revision = vi.spyOn(test.storage, "getShareDiscussionRevision");
    const activity = vi.spyOn(test.storage, "listShareDiscussionActivity");
    const append = vi.spyOn(test.storage, "appendAuthenticatedDiscussionMessage");
    lookupUserDisplayName.mockClear();

    const refusedIdempotencyKeys: Array<readonly [string, string]> = [];
    for (const actor of [COMMENTER, EDITOR] as const) {
      for (const [workspaceId, suffix] of [
        [WORKSPACE, "correct"],
        [OTHER_WORKSPACE, "wrong"],
      ] as const) {
        const idempotencyKey = `named-${actor}-${suffix}`;
        refusedIdempotencyKeys.push([actor, idempotencyKey]);
        for (const response of [
          await test.handler(
            rawRequest(
              actor,
              `/sync/shares/${SHARE}/discussion?workspaceId=${workspaceId}&limit=100`,
            ),
          ),
          await test.handler(
            rawRequest(
              actor,
              `/sync/shares/${SHARE}/discussion/activity?workspaceId=${workspaceId}&since=0&hold=0&limit=100`,
            ),
          ),
          await test.handler(
            rawRequest(
              actor,
              `/sync/shares/${SHARE}/discussion`,
              jsonRequest({
                workspaceId,
                body: `supplied workspace from ${actor}`,
                idempotencyKey,
              }),
            ),
          ),
        ]) {
          expect(await genericRefusal(response)).toBe(baseline);
        }
      }
    }
    expect(list).not.toHaveBeenCalled();
    expect(revision).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
    expect(lookupUserDisplayName).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(count(test.dbPath, "sync_relay_share_discussion_messages")).toBe(
      beforeRows,
    );
    expect(test.storage.getShareDiscussionRevision(SHARE)).toBe(beforeRevision);
    expect(discussionUsage(test.dbPath)).toBe(beforeUsage);
    for (const [actor, idempotencyKey] of refusedIdempotencyKeys) {
      expect(
        discussionIdempotencyRows(test.dbPath, actor, idempotencyKey),
      ).toBe(0);
    }
  });

  it("keeps named View omission authority but rejects supplied workspace IDs before discussion work", async () => {
    const lookupUserDisplayName = vi.fn(() => "Viewer Name");
    const test = await fixture({ lookupUserDisplayName });
    const omittedList = await test.handler(
      rawRequest(VIEWER, `/sync/shares/${SHARE}/discussion?limit=100`),
    );
    const omittedActivity = await test.handler(
      rawRequest(
        VIEWER,
        `/sync/shares/${SHARE}/discussion/activity?since=0&hold=0&limit=100`,
      ),
    );
    for (const response of [omittedList, omittedActivity]) {
      expect(response.status).toBe(200);
      expectPrivate(response);
    }
    const omittedAppend = await test.handler(
      rawRequest(
        VIEWER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({ body: "view cannot append", idempotencyKey: "view-omission" }),
      ),
    );
    expect(omittedAppend.status).toBe(403);
    expectPrivate(omittedAppend);

    const baseline = await genericRefusal(
      await test.handler(
        rawRequest(
          VIEWER,
          `/sync/shares/missing-view-workspace-share/discussion?workspaceId=${WORKSPACE}`,
        ),
      ),
    );
    const beforeRows = count(test.dbPath, "sync_relay_share_discussion_messages");
    const beforeRevision = test.storage.getShareDiscussionRevision(SHARE);
    const beforeUsage = discussionUsage(test.dbPath);
    const list = vi.spyOn(test.storage, "listShareDiscussionMessages");
    const revision = vi.spyOn(test.storage, "getShareDiscussionRevision");
    const activity = vi.spyOn(test.storage, "listShareDiscussionActivity");
    const append = vi.spyOn(test.storage, "appendAuthenticatedDiscussionMessage");
    lookupUserDisplayName.mockClear();

    for (const [workspaceId, suffix] of [
      [WORKSPACE, "correct"],
      [OTHER_WORKSPACE, "wrong"],
    ] as const) {
      for (const response of [
        await test.handler(
          rawRequest(
            VIEWER,
            `/sync/shares/${SHARE}/discussion?workspaceId=${workspaceId}&limit=100`,
          ),
        ),
        await test.handler(
          rawRequest(
            VIEWER,
            `/sync/shares/${SHARE}/discussion/activity?workspaceId=${workspaceId}&since=0&hold=0&limit=100`,
          ),
        ),
        await test.handler(
          rawRequest(
            VIEWER,
            `/sync/shares/${SHARE}/discussion`,
            jsonRequest({
              workspaceId,
              body: "view supplied workspace",
              idempotencyKey: `view-${suffix}`,
            }),
          ),
        ),
      ]) {
        expect(await genericRefusal(response)).toBe(baseline);
      }
      expect(discussionIdempotencyRows(test.dbPath, VIEWER, `view-${suffix}`)).toBe(
        0,
      );
    }
    expect(list).not.toHaveBeenCalled();
    expect(revision).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
    expect(lookupUserDisplayName).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(count(test.dbPath, "sync_relay_share_discussion_messages")).toBe(
      beforeRows,
    );
    expect(test.storage.getShareDiscussionRevision(SHARE)).toBe(beforeRevision);
    expect(discussionUsage(test.dbPath)).toBe(beforeUsage);
  });

  it("keeps stranger and revoked-recipient refusals private across workspace shapes", async () => {
    const lookupUserDisplayName = vi.fn(() => "No Name");
    const test = await fixture({ lookupUserDisplayName });
    expect(
      test.storage.revokeShareGrant({
        shareId: SHARE,
        grantId: "named-comment-grant-sentinel",
        revokedAtMs: 20_000,
      }),
    ).toMatchObject({ ok: true });
    const baseline = await genericRefusal(
      await test.handler(
        rawRequest(
          "stranger-account-sentinel",
          `/sync/shares/missing-private-workspace-share/discussion`,
        ),
      ),
    );
    const beforeRows = count(test.dbPath, "sync_relay_share_discussion_messages");
    const beforeRevision = test.storage.getShareDiscussionRevision(SHARE);
    const beforeUsage = discussionUsage(test.dbPath);
    const list = vi.spyOn(test.storage, "listShareDiscussionMessages");
    const revision = vi.spyOn(test.storage, "getShareDiscussionRevision");
    const activity = vi.spyOn(test.storage, "listShareDiscussionActivity");
    const append = vi.spyOn(test.storage, "appendAuthenticatedDiscussionMessage");

    for (const actor of ["stranger-account-sentinel", COMMENTER] as const) {
      for (const [workspaceId, suffix] of [
        [undefined, "omitted"],
        [WORKSPACE, "correct"],
        [OTHER_WORKSPACE, "wrong"],
      ] as const) {
        const workspaceQuery =
          workspaceId === undefined ? "" : `workspaceId=${workspaceId}&`;
        const idempotencyKey = `${actor}-${suffix}`;
        for (const response of [
          await test.handler(
            rawRequest(
              actor,
              `/sync/shares/${SHARE}/discussion?${workspaceQuery}limit=100`,
            ),
          ),
          await test.handler(
            rawRequest(
              actor,
              `/sync/shares/${SHARE}/discussion/activity?${workspaceQuery}since=0&hold=0&limit=100`,
            ),
          ),
          await test.handler(
            rawRequest(
              actor,
              `/sync/shares/${SHARE}/discussion`,
              jsonRequest({
                ...(workspaceId === undefined ? {} : { workspaceId }),
                body: "private actor",
                idempotencyKey,
              }),
            ),
          ),
        ]) {
          expect(await genericRefusal(response)).toBe(baseline);
        }
        expect(discussionIdempotencyRows(test.dbPath, actor, idempotencyKey)).toBe(
          0,
        );
      }
    }
    expect(list).not.toHaveBeenCalled();
    expect(revision).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
    expect(lookupUserDisplayName).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(count(test.dbPath, "sync_relay_share_discussion_messages")).toBe(
      beforeRows,
    );
    expect(test.storage.getShareDiscussionRevision(SHARE)).toBe(beforeRevision);
    expect(discussionUsage(test.dbPath)).toBe(beforeUsage);
  });

  it("follows named omission authority through list relocation at grant and final seams", async () => {
    const duringGrant = await fixture();
    const originalGetShare = duringGrant.storage.getShare.bind(duringGrant.storage);
    let shareLoads = 0;
    vi.spyOn(duringGrant.storage, "getShare").mockImplementation((shareId) => {
      if (shareId === SHARE) {
        shareLoads += 1;
        if (shareLoads === 2) {
          updateShareWorkspace(duringGrant.dbPath, OTHER_WORKSPACE);
        }
      }
      return originalGetShare(shareId);
    });
    const grantSeamRead = vi.spyOn(
      duringGrant.storage,
      "listShareDiscussionMessages",
    );
    const grantSeamResponse = await duringGrant.handler(
      rawRequest(COMMENTER, `/sync/shares/${SHARE}/discussion?limit=100`),
    );
    expect(grantSeamResponse.status).toBe(200);
    expectPrivate(grantSeamResponse);
    expect(grantSeamRead).toHaveBeenCalledOnce();
    expect(duringGrant.storage.getShare(SHARE)?.workspaceId).toBe(OTHER_WORKSPACE);

    const afterPage = await fixture();
    const originalList = afterPage.storage.listShareDiscussionMessages.bind(
      afterPage.storage,
    );
    const finalSeamRead = vi
      .spyOn(afterPage.storage, "listShareDiscussionMessages")
      .mockImplementation((input) => {
        const page = originalList(input);
        updateShareWorkspace(afterPage.dbPath, OTHER_WORKSPACE);
        return page;
      });
    const finalSeamResponse = await afterPage.handler(
      rawRequest(COMMENTER, `/sync/shares/${SHARE}/discussion?limit=100`),
    );
    expect(finalSeamResponse.status).toBe(200);
    expectPrivate(finalSeamResponse);
    expect(finalSeamRead).toHaveBeenCalledOnce();
    expect(afterPage.storage.getShare(SHARE)?.workspaceId).toBe(OTHER_WORKSPACE);
  });

  it("follows named omission authority through activity park wake and final relocation seams", async () => {
    const discussionActivity = new DiscussionActivityHub();
    const test = await fixture({ discussionActivity });
    let shouldPark: boolean | undefined;
    vi.spyOn(discussionActivity, "wait").mockImplementation(
      async (_shareId, _actorId, options) => {
        updateShareWorkspace(test.dbPath, OTHER_WORKSPACE);
        shouldPark = options.shouldPark();
      },
    );
    const originalActivity = test.storage.listShareDiscussionActivity.bind(
      test.storage,
    );
    const activityRead = vi
      .spyOn(test.storage, "listShareDiscussionActivity")
      .mockImplementation((input) => {
        const page = originalActivity(input);
        updateShareWorkspace(test.dbPath, WORKSPACE);
        return page;
      });

    const response = await test.handler(
      rawRequest(
        COMMENTER,
        `/sync/shares/${SHARE}/discussion/activity?since=0&hold=30000&limit=100`,
      ),
    );
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(shouldPark).toBe(true);
    expect(activityRead).toHaveBeenCalledOnce();
    expect(test.storage.getShare(SHARE)?.workspaceId).toBe(WORKSPACE);
  });

  it("follows named omission authority through append relocation and charges the transaction-current workspace", async () => {
    let releaseLookup: (value: string | null) => void = () => {};
    const deferredName = new Promise<string | null>((resolve) => {
      releaseLookup = resolve;
    });
    let signalLookupStarted: () => void = () => {};
    const lookupStarted = new Promise<void>((resolve) => {
      signalLookupStarted = resolve;
    });
    const lookupUserDisplayName = vi.fn(() => {
      signalLookupStarted();
      return deferredName;
    });
    const test = await fixture({ lookupUserDisplayName });
    const input = {
      body: "named relocation append",
      idempotencyKey: "named-relocation-append",
    };
    const beforeRevision = test.storage.getShareDiscussionRevision(SHARE);
    const beforeOriginalUsage = workspaceUsage(test.dbPath, WORKSPACE);
    const beforeCurrentUsage = workspaceUsage(test.dbPath, OTHER_WORKSPACE);
    const pending = test.handler(
      rawRequest(
        COMMENTER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest(input),
      ),
    );
    await lookupStarted;
    expect(lookupUserDisplayName).toHaveBeenCalledOnce();
    updateShareWorkspace(test.dbPath, OTHER_WORKSPACE);
    releaseLookup("Commenter Name");

    const response = await pending;
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(await body(response)).toMatchObject({
      message: { author: { kind: "named", displayName: "Commenter Name" } },
    });
    expect(test.storage.getShareDiscussionRevision(SHARE)).toBe(
      (beforeRevision ?? 0) + 1,
    );
    expect(workspaceUsage(test.dbPath, WORKSPACE)).toBe(beforeOriginalUsage);
    expect(workspaceUsage(test.dbPath, OTHER_WORKSPACE)).toBe(
      beforeCurrentUsage +
        namedMessageCharge({
          actorUserId: COMMENTER,
          displayName: "Commenter Name",
          ...input,
        }),
    );
    expect(
      discussionIdempotencyRows(test.dbPath, COMMENTER, input.idempotencyKey),
    ).toBe(1);
  });

  it("keeps a stable dual-role owner bound to the exact workspace without named fallthrough", async () => {
    const lookupUserDisplayName = vi.fn(() => "Owner Name");
    const test = await fixture({
      namedRecipient: OWNER,
      lookupUserDisplayName,
    });
    const baseline = await genericRefusal(
      await test.handler(
        rawRequest(
          OWNER,
          `/sync/shares/missing-dual-role-share/discussion?workspaceId=${WORKSPACE}`,
        ),
      ),
    );
    const beforeRows = count(test.dbPath, "sync_relay_share_discussion_messages");
    const beforeRevision = test.storage.getShareDiscussionRevision(SHARE);
    const beforeUsage = discussionUsage(test.dbPath);
    const list = vi.spyOn(test.storage, "listShareDiscussionMessages");
    const revision = vi.spyOn(test.storage, "getShareDiscussionRevision");
    const activity = vi.spyOn(test.storage, "listShareDiscussionActivity");
    const append = vi.spyOn(test.storage, "appendAuthenticatedDiscussionMessage");
    const refusals = [
      await test.handler(rawRequest(OWNER, `/sync/shares/${SHARE}/discussion`)),
      await test.handler(
        rawRequest(
          OWNER,
          `/sync/shares/${SHARE}/discussion?workspaceId=${OTHER_WORKSPACE}`,
        ),
      ),
      await test.handler(
        rawRequest(
          OWNER,
          `/sync/shares/${SHARE}/discussion/activity?since=0&hold=0&limit=100`,
        ),
      ),
      await test.handler(
        rawRequest(
          OWNER,
          `/sync/shares/${SHARE}/discussion/activity?workspaceId=${OTHER_WORKSPACE}&since=0&hold=0&limit=100`,
        ),
      ),
      await test.handler(
        rawRequest(
          OWNER,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({
            body: "dual role missing workspace",
            idempotencyKey: "dual-role-missing",
          }),
        ),
      ),
      await test.handler(
        rawRequest(
          OWNER,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({
            workspaceId: OTHER_WORKSPACE,
            body: "dual role",
            idempotencyKey: "dual-role-fallthrough",
          }),
        ),
      ),
    ];
    for (const response of refusals) {
      expect(await genericRefusal(response)).toBe(baseline);
    }
    expect(list).not.toHaveBeenCalled();
    expect(revision).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
    expect(lookupUserDisplayName).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(count(test.dbPath, "sync_relay_share_discussion_messages")).toBe(
      beforeRows,
    );
    expect(test.storage.getShareDiscussionRevision(SHARE)).toBe(beforeRevision);
    expect(discussionUsage(test.dbPath)).toBe(beforeUsage);

    list.mockRestore();
    revision.mockRestore();
    activity.mockRestore();
    append.mockRestore();
    const exactAppend = await test.handler(
      rawRequest(
        OWNER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({
          workspaceId: WORKSPACE,
          body: "dual role exact owner",
          idempotencyKey: "dual-role-exact",
        }),
      ),
    );
    const exactList = await test.handler(
      rawRequest(
        OWNER,
        `/sync/shares/${SHARE}/discussion?workspaceId=${WORKSPACE}&direction=newest-first&limit=100`,
      ),
    );
    const exactActivity = await test.handler(
      rawRequest(
        OWNER,
        `/sync/shares/${SHARE}/discussion/activity?workspaceId=${WORKSPACE}&since=0&hold=0&limit=100`,
      ),
    );
    for (const response of [exactAppend, exactList, exactActivity]) {
      expect(response.status).toBe(200);
      expectPrivate(response);
    }
    expect(
      test.storage.listShareDiscussionMessages({ shareId: SHARE, limit: 10 })
        .messages,
    ).toMatchObject([{ authorKind: "owner", authorUserId: OWNER }]);
  });

  it("rechecks the requested workspace after an owner discussion list reads storage even with a named grant", async () => {
    const test = await fixture({ namedRecipient: OWNER });
    const original = test.storage.listShareDiscussionMessages.bind(test.storage);
    test.storage.listShareDiscussionMessages = (input) => {
      const page = original(input);
      updateShareWorkspace(test.dbPath, OTHER_WORKSPACE);
      return page;
    };

    expect(
      await genericRefusal(
        await test.handler(request(OWNER, `/sync/shares/${SHARE}/discussion`)),
      ),
    ).toContain('"code":"not_found"');
  });

  it("prevents a dual-role owner activity poll from parking after its share relocates", async () => {
    const discussionActivity = new DiscussionActivityHub();
    const test = await fixture({ discussionActivity, namedRecipient: OWNER });
    let shouldPark: boolean | undefined;
    vi.spyOn(discussionActivity, "wait").mockImplementation(
      async (_shareId, _actorId, options) => {
        updateShareWorkspace(test.dbPath, OTHER_WORKSPACE);
        shouldPark = options.shouldPark();
      },
    );
    const activityRead = vi.spyOn(test.storage, "listShareDiscussionActivity");

    expect(
      await genericRefusal(
        await test.handler(
          request(
            OWNER,
            `/sync/shares/${SHARE}/discussion/activity?since=0&hold=30000&limit=100`,
          ),
        ),
      ),
    ).toContain('"code":"not_found"');
    expect(shouldPark).toBe(false);
    expect(activityRead).not.toHaveBeenCalled();
  });

  it("rechecks the requested workspace after a dual-role owner activity poll wakes", async () => {
    const discussionActivity = new DiscussionActivityHub();
    const test = await fixture({ discussionActivity, namedRecipient: OWNER });
    vi.spyOn(discussionActivity, "wait").mockImplementation(async () => {
      updateShareWorkspace(test.dbPath, OTHER_WORKSPACE);
    });
    const activityRead = vi.spyOn(test.storage, "listShareDiscussionActivity");

    expect(
      await genericRefusal(
        await test.handler(
          request(
            OWNER,
            `/sync/shares/${SHARE}/discussion/activity?since=0&hold=30000&limit=100`,
          ),
        ),
      ),
    ).toContain('"code":"not_found"');
    expect(activityRead).not.toHaveBeenCalled();
  });

  it("rechecks the requested workspace after a dual-role owner activity page reads storage", async () => {
    for (const transition of ["relocation", "ownership-transfer"] as const) {
      const test = await fixture({ namedRecipient: OWNER });
      const baseline = await genericRefusal(
        await test.handler(
          rawRequest(
            OWNER,
            `/sync/shares/missing-owner-activity-race/discussion?workspaceId=${WORKSPACE}`,
          ),
        ),
      );
      const beforeRows = count(
        test.dbPath,
        "sync_relay_share_discussion_messages",
      );
      const beforeRevision = test.storage.getShareDiscussionRevision(SHARE);
      const beforeUsage = discussionUsage(test.dbPath);
      const original = test.storage.listShareDiscussionActivity.bind(test.storage);
      const activity = vi
        .spyOn(test.storage, "listShareDiscussionActivity")
        .mockImplementation((input) => {
          const page = original(input);
          if (transition === "relocation") {
            updateShareWorkspace(test.dbPath, OTHER_WORKSPACE);
          } else {
            transferShareOwnership(test.dbPath, WORKSPACE, NEW_OWNER);
          }
          return page;
        });

      expect(
        await genericRefusal(
          await test.handler(
            rawRequest(
              OWNER,
              `/sync/shares/${SHARE}/discussion/activity?workspaceId=${WORKSPACE}&since=0&hold=0&limit=100`,
            ),
          ),
        ),
        transition,
      ).toBe(baseline);
      expect(activity, transition).toHaveBeenCalledOnce();
      expect(
        count(test.dbPath, "sync_relay_share_discussion_messages"),
        transition,
      ).toBe(beforeRows);
      expect(test.storage.getShareDiscussionRevision(SHARE), transition).toBe(
        beforeRevision,
      );
      expect(discussionUsage(test.dbPath), transition).toBe(beforeUsage);
    }
  });

  it("keeps binding-carrying owner appends from downgrading after relocation or ownership transfer", async () => {
    for (const transition of ["relocation", "ownership-transfer"] as const) {
      let releaseLookup: (value: string | null) => void = () => {};
      const deferredName = new Promise<string | null>((resolve) => {
        releaseLookup = resolve;
      });
      let signalLookupStarted: () => void = () => {};
      const lookupStarted = new Promise<void>((resolve) => {
        signalLookupStarted = resolve;
      });
      const lookupUserDisplayName = vi.fn(() => {
        signalLookupStarted();
        return deferredName;
      });
      const test = await fixture({
        namedRecipient: OWNER,
        lookupUserDisplayName,
      });
      const baseline = await genericRefusal(
        await test.handler(
          rawRequest(
            OWNER,
            `/sync/shares/missing-owner-race-share/discussion?workspaceId=${WORKSPACE}`,
          ),
        ),
      );
      const idempotencyKey = `binding-owner-${transition}`;
      const beforeRows = count(
        test.dbPath,
        "sync_relay_share_discussion_messages",
      );
      const beforeRevision = test.storage.getShareDiscussionRevision(SHARE);
      const beforeUsage = discussionUsage(test.dbPath);
      const beforeOriginalUsage = workspaceUsage(test.dbPath, WORKSPACE);
      const beforeOtherUsage = workspaceUsage(test.dbPath, OTHER_WORKSPACE);
      const append = vi.spyOn(
        test.storage,
        "appendAuthenticatedDiscussionMessage",
      );
      const pending = test.handler(
        rawRequest(
          OWNER,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({
            workspaceId: WORKSPACE,
            body: `owner ${transition} race`,
            idempotencyKey,
          }),
        ),
      );
      await lookupStarted;
      expect(lookupUserDisplayName).toHaveBeenCalledOnce();
      if (transition === "relocation") {
        updateShareWorkspace(test.dbPath, OTHER_WORKSPACE);
      } else {
        transferShareOwnership(test.dbPath, WORKSPACE, NEW_OWNER);
      }
      releaseLookup("Owner Name");

      expect(await genericRefusal(await pending), transition).toBe(baseline);
      expect(append, transition).toHaveBeenCalledOnce();
      expect(
        count(test.dbPath, "sync_relay_share_discussion_messages"),
        transition,
      ).toBe(beforeRows);
      expect(test.storage.getShareDiscussionRevision(SHARE), transition).toBe(
        beforeRevision,
      );
      expect(discussionUsage(test.dbPath), transition).toBe(beforeUsage);
      expect(workspaceUsage(test.dbPath, WORKSPACE), transition).toBe(
        beforeOriginalUsage,
      );
      expect(workspaceUsage(test.dbPath, OTHER_WORKSPACE), transition).toBe(
        beforeOtherUsage,
      );
      expect(
        discussionIdempotencyRows(test.dbPath, OWNER, idempotencyKey),
        transition,
      ).toBe(0);
    }
  });

  it("returns a higher discussion revision even when its timestamp moves backward", async () => {
    let now = 10_000;
    const test = await fixture({ nowMs: () => now });
    const first = await body(
      await test.handler(
        trustedAppend(test.comment, {
          body: "clock first",
          claimedName: "Clock Link",
          idempotencyKey: "clock-first",
        }),
      ),
    );
    now = 9_000;
    const second = await body(
      await test.handler(
        trustedAppend(test.comment, {
          body: "clock second",
          idempotencyKey: "clock-second",
        }),
      ),
    );

    expect(first.message).toMatchObject({ createdAtMs: 10_000 });
    expect(second.message).toMatchObject({ createdAtMs: 9_000 });
    const activity = await body(
      await test.handler(
        linkRequest(
          test.view,
          "/sync/link/discussion/activity?since=1&hold=0&limit=100",
          {},
          { profileSecret: PROFILE_A },
        ),
      ),
    );
    expect(activity).toMatchObject({
      latestRevision: 2,
      cursorRevision: 2,
      hasMore: false,
    });
    expect(messages(activity)).toEqual([second.message]);
  });

  it("returns only the current public requester's profile name on every activity page", async () => {
    const test = await fixture({ lookupUserDisplayName: () => "Authenticated user" });
    for (const [bodyText, idempotencyKey] of [
      ["before profile one", "profile-activity-before-one"],
      ["before profile two", "profile-activity-before-two"],
    ] as const) {
      expect(
        (
          await test.handler(
            request(
              OWNER,
              `/sync/shares/${SHARE}/discussion`,
              jsonRequest({ body: bodyText, idempotencyKey }),
            ),
          )
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await test.handler(
          trustedAppend(
            test.comment,
            {
              body: "profile name revision",
              claimedName: "Stable Name",
              idempotencyKey: "profile-activity-name",
            },
            PROFILE_A,
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await test.handler(
          request(
            OWNER,
            `/sync/shares/${SHARE}/discussion`,
            jsonRequest({
              body: "after profile",
              idempotencyKey: "profile-activity-after",
            }),
          ),
        )
      ).status,
    ).toBe(200);

    const activityPath =
      "/sync/link/discussion/activity?since=0&hold=0&limit=1";
    const namedProfile = await body(
      await test.handler(
        linkRequest(test.comment, activityPath, {}, { profileSecret: PROFILE_A }),
      ),
    );
    expect(namedProfile).toMatchObject({
      ok: true,
      latestRevision: 4,
      cursorRevision: 1,
      hasMore: true,
      profileName: "Stable Name",
    });

    const unnamedProfile = await body(
      await test.handler(
        linkRequest(
          test.comment,
          "/sync/link/discussion/activity?since=2&hold=0&limit=1",
          {},
          { profileSecret: PROFILE_B },
        ),
      ),
    );
    expect(unnamedProfile).toMatchObject({
      ok: true,
      latestRevision: 4,
      cursorRevision: 3,
      hasMore: true,
      profileName: null,
    });

    const principalId = test.storage
      .listShareDiscussionMessages({ shareId: SHARE, limit: 100 })
      .messages.find((message) => message.body === "profile name revision")!
      .linkPrincipalId!;
    const principal = test.storage.getLinkPrincipal(principalId)!;
    for (const publicPage of [namedProfile, unnamedProfile]) {
      const serialized = JSON.stringify(publicPage);
      for (const privateValue of [
        principalId,
        principal.profileTokenHash,
        PROFILE_A,
        PROFILE_B,
        test.comment.grantId,
        test.comment.capabilityToken,
        "session-comment-sentinel",
      ]) {
        expect(serialized, privateValue).not.toContain(privateValue);
      }
      expect(publicPage).not.toHaveProperty("principals");
    }

    const ownerActivity = await body(
      await test.handler(
        request(
          OWNER,
          `/sync/shares/${SHARE}/discussion/activity?since=0&hold=0&limit=1`,
        ),
      ),
    );
    const namedActivity = await body(
      await test.handler(
        request(
          COMMENTER,
          `/sync/shares/${SHARE}/discussion/activity?since=0&hold=0&limit=1`,
        ),
      ),
    );
    expect(ownerActivity).not.toHaveProperty("profileName");
    expect(namedActivity).not.toHaveProperty("profileName");
  });

  it("relays durable current-state activity across waits, lifecycle changes, restart, timeout, abort, and capacity", async () => {
    const activityHub = new DiscussionActivityHub({
      maxTotalWaiters: 2,
      maxWaitersPerShare: 2,
      maxWaitersPerActor: 1,
    });
    const test = await fixture({ discussionActivity: activityHub });
    const first = await body(
      await test.handler(
        trustedAppend(test.comment, {
          body: "activity first",
          claimedName: "Activity Link",
          idempotencyKey: "activity-route-first",
        }),
      ),
    );
    for (const [bodyText, key] of [
      ["activity second", "activity-route-second"],
      ["activity third", "activity-route-third"],
    ] as const) {
      expect(
        (
          await test.handler(
            request(
              OWNER,
              `/sync/shares/${SHARE}/discussion`,
              jsonRequest({ body: bodyText, idempotencyKey: key }),
            ),
          )
        ).status,
      ).toBe(200);
    }

    const chronological = await body(
      await test.handler(linkRequest(test.view, "/sync/link/discussion?limit=2")),
    );
    expect(chronological.activityRevision).toBe(3);
    expect(messages(chronological).map((message) => message.body)).toEqual([
      "activity first",
      "activity second",
    ]);
    const laterChronological = await body(
      await test.handler(
        linkRequest(
          test.view,
          `/sync/link/discussion?limit=2&cursor=${String(chronological.nextCursor)}`,
        ),
      ),
    );
    expect(laterChronological.activityRevision).toBe(3);
    expect(messages(laterChronological).map((message) => message.body)).toEqual([
      "activity third",
    ]);

    const newestPublic = await body(
      await test.handler(
        linkRequest(
          test.view,
          "/sync/link/discussion?direction=newest-first&limit=2",
        ),
      ),
    );
    expect(newestPublic.activityRevision).toBe(3);
    expect(messages(newestPublic).map((message) => message.body)).toEqual([
      "activity third",
      "activity second",
    ]);
    const earlierPublic = await body(
      await test.handler(
        linkRequest(
          test.view,
          `/sync/link/discussion?direction=newest-first&limit=2&cursor=${String(newestPublic.nextCursor)}`,
        ),
      ),
    );
    expect(earlierPublic.activityRevision).toBe(3);
    expect(messages(earlierPublic).map((message) => message.body)).toEqual([
      "activity first",
    ]);

    const newestOwner = await body(
      await test.handler(
        request(
          OWNER,
          `/sync/shares/${SHARE}/discussion?direction=newest-first&limit=2`,
        ),
      ),
    );
    expect(newestOwner.activityRevision).toBe(3);
    expect(messages(newestOwner).map((message) => message.body)).toEqual([
      "activity third",
      "activity second",
    ]);

    const publicWait = test.handler(
      linkRequest(
        test.comment,
        "/sync/link/discussion/activity?since=3&hold=30000&limit=100",
        {},
        { profileSecret: PROFILE_A },
      ),
    );
    const ownerWait = test.handler(
      request(
        OWNER,
        `/sync/shares/${SHARE}/discussion/activity?since=3&hold=30000&limit=100`,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(activityHub.stats()).toEqual({ shares: 1, waiters: 2 });

    const appended = await body(
      await test.handler(
        request(
          COMMENTER,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({
            body: "activity after watermark",
            idempotencyKey: "activity-route-after-watermark",
          }),
        ),
      ),
    );
    const publicActivity = await body(await publicWait);
    expect(publicActivity).toMatchObject({
      ok: true,
      access: "comment",
      latestRevision: 4,
      cursorRevision: 4,
      hasMore: false,
      composerState: "available",
    });
    expect(messages(publicActivity)).toEqual([appended.message]);
    for (const sentinel of [
      WORKSPACE,
      SHARE,
      test.comment.grantId,
      test.comment.capabilityToken,
      PROFILE_A,
    ]) {
      expect(JSON.stringify(publicActivity), sentinel).not.toContain(sentinel);
    }

    const ownerActivity = await body(await ownerWait);
    expect(ownerActivity).toMatchObject({
      ok: true,
      latestRevision: 4,
      cursorRevision: 4,
      hasMore: false,
      linkCommentsPaused: false,
    });
    expect(messages(ownerActivity)).toEqual([appended.message]);
    expect(ownerActivity).not.toHaveProperty("access");
    expect(first.message).toMatchObject({ body: "activity first" });
    expect(activityHub.stats()).toEqual({ shares: 0, waiters: 0 });

    const rawLink = test.storage.listShareDiscussionMessages({
      shareId: SHARE,
      limit: 100,
    }).messages[0]!;
    const changedPublic = async (since: number): Promise<Record<string, unknown>> =>
      body(
        await test.handler(
          linkRequest(
            test.comment,
            `/sync/link/discussion/activity?since=${since}&hold=0&limit=100`,
            {},
            { profileSecret: PROFILE_A },
          ),
        ),
      );
    const changedOwner = async (since: number): Promise<Record<string, unknown>> =>
      body(
        await test.handler(
          request(
            OWNER,
            `/sync/shares/${SHARE}/discussion/activity?since=${since}&hold=0&limit=100`,
          ),
        ),
      );

    expect(
      (
        await test.handler(
          moderationRequest(OWNER, {
            action: "delete",
            messageId: (appended.message as Record<string, unknown>).messageId,
          }),
        )
      ).status,
    ).toBe(200);
    const deleted = await changedPublic(4);
    expect(deleted).toMatchObject({
      access: "comment",
      cursorRevision: 5,
      composerState: "available",
    });
    expect(messages(deleted)).toEqual([
      {
        messageId: (appended.message as Record<string, unknown>).messageId,
        createdAtMs: (appended.message as Record<string, unknown>).createdAtMs,
        deleted: true,
      },
    ]);

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
    const blocked = await changedPublic(5);
    expect(blocked).toMatchObject({
      access: "comment",
      cursorRevision: 6,
      messages: [],
      composerState: "blocked",
    });
    expect(await changedOwner(5)).toMatchObject({
      cursorRevision: 6,
      principals: [{ principalId: rawLink.linkPrincipalId, blocked: true }],
    });

    expect(
      (await test.handler(moderationRequest(OWNER, { action: "pause" }))).status,
    ).toBe(200);
    expect(await changedPublic(6)).toMatchObject({
      access: "comment",
      cursorRevision: 7,
      messages: [],
      composerState: "paused",
    });

    expect(
      (
        await test.handler(
          moderationRequest(OWNER, {
            action: "unblock",
            principalId: rawLink.linkPrincipalId,
          }),
        )
      ).status,
    ).toBe(200);
    expect(await changedOwner(7)).toMatchObject({
      cursorRevision: 8,
      principals: [{ principalId: rawLink.linkPrincipalId, blocked: false }],
    });
    expect(await changedPublic(7)).toMatchObject({
      access: "comment",
      cursorRevision: 8,
      composerState: "paused",
    });

    expect(
      (await test.handler(moderationRequest(OWNER, { action: "resume" }))).status,
    ).toBe(200);
    const resumed = await changedPublic(8);
    expect(resumed).toMatchObject({
      access: "comment",
      latestRevision: 9,
      cursorRevision: 9,
      messages: [],
      composerState: "available",
    });
    for (const publicDelta of [publicActivity, deleted, blocked, resumed]) {
      const serialized = JSON.stringify(publicDelta);
      for (const sentinel of [
        OWNER,
        COMMENTER,
        WORKSPACE,
        SHARE,
        test.comment.grantId,
        rawLink.linkPrincipalId!,
        test.comment.capabilityToken,
        PROFILE_A,
        "session-comment-sentinel",
      ]) {
        expect(serialized, sentinel).not.toContain(sentinel);
      }
    }

    const revokedWait = test.handler(
      linkRequest(
        test.comment,
        "/sync/link/discussion/activity?since=9&hold=30000&limit=100",
        {},
        { profileSecret: PROFILE_A },
      ),
    );
    expect(activityHub.stats()).toEqual({ shares: 1, waiters: 1 });
    const revoke = await test.handler(
      request(
        OWNER,
        `/sync/shares/${SHARE}/revoke`,
        jsonRequest({
          grantId: test.comment.grantId,
          workspaceId: WORKSPACE,
          expectedDependentGrantIds: [],
        }),
      ),
    );
    expect(revoke.status).toBe(200);
    expect(await genericRefusal(await revokedWait)).toContain("404:");
    expect(activityHub.stats()).toEqual({ shares: 0, waiters: 0 });

    closeTestStorage(test.storage);
    const reopened = reopenTestStorage(test.dbPath, {
      newDiscussionId: () => "discussion-after-restart",
    });
    const restarted = test.makeHandler(reopened);
    const later = await body(
      await restarted(
        request(
          OWNER,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({
            body: "activity after restart",
            idempotencyKey: "activity-after-restart",
          }),
        ),
      ),
    );
    const afterRestart = await body(
      await restarted(
        linkRequest(
          test.view,
          "/sync/link/discussion/activity?since=9&hold=0&limit=100",
          {},
          { profileSecret: PROFILE_B },
        ),
      ),
    );
    expect(afterRestart).toMatchObject({
      latestRevision: 10,
      cursorRevision: 10,
      hasMore: false,
      composerState: "available",
    });
    expect(messages(afterRestart)).toEqual([later.message]);

    const timedOut = await body(
      await restarted(
        linkRequest(
          test.view,
          "/sync/link/discussion/activity?since=10&hold=1&limit=100",
          {},
          { profileSecret: PROFILE_B },
        ),
      ),
    );
    expect(timedOut).toMatchObject({
      latestRevision: 10,
      cursorRevision: 10,
      hasMore: false,
      messages: [],
    });
    expect(activityHub.stats()).toEqual({ shares: 0, waiters: 0 });

    const publicAbort = new AbortController();
    const ownerAbort = new AbortController();
    const publicAbortedWait = restarted(
      linkRequest(
        test.view,
        "/sync/link/discussion/activity?since=10&hold=30000&limit=100",
        { signal: publicAbort.signal },
        { profileSecret: PROFILE_B },
      ),
    );
    const ownerAbortedWait = restarted(
      request(
        OWNER,
        `/sync/shares/${SHARE}/discussion/activity?since=10&hold=30000&limit=100`,
        { signal: ownerAbort.signal },
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(activityHub.stats()).toEqual({ shares: 1, waiters: 2 });
    const overflow = await restarted(
      request(
        COMMENTER,
        `/sync/shares/${SHARE}/discussion/activity?since=10&hold=30000&limit=100`,
      ),
    );
    expect(overflow.status).toBe(429);
    expect(await body(overflow)).toMatchObject({ code: "link_read_rate_limited" });
    expect(activityHub.stats()).toEqual({ shares: 1, waiters: 2 });
    publicAbort.abort();
    ownerAbort.abort();
    expect((await publicAbortedWait).status).toBe(200);
    expect((await ownerAbortedWait).status).toBe(200);
    expect(activityHub.stats()).toEqual({ shares: 0, waiters: 0 });

    for (const path of [
      `/sync/shares/${SHARE}/discussion/activity?since=10&hold=0&extra=1`,
      `/sync/shares/${SHARE}/discussion/activity?since=11&hold=0`,
      `/sync/shares/${SHARE}/discussion/activity?hold=0`,
      `/sync/shares/${SHARE}/discussion/activity?since=-1&hold=0`,
      `/sync/shares/${SHARE}/discussion/activity?since=10&hold=30001`,
      `/sync/shares/${SHARE}/discussion/activity?since=10&hold=0&limit=101`,
      `/sync/shares/${SHARE}/discussion/activity?since=10&since=10&hold=0`,
    ]) {
      expect((await restarted(request(OWNER, path))).status).toBe(400);
      expect(activityHub.stats()).toEqual({ shares: 0, waiters: 0 });
    }
  });

  it("orders a newer append and an older tombstone canonically inside one activity delta", async () => {
    const test = await fixture();
    const older = await body(
      await test.handler(
        request(
          OWNER,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({ body: "older", idempotencyKey: "ordered-older" }),
        ),
      ),
    );
    const newer = await body(
      await test.handler(
        request(
          OWNER,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({ body: "newer", idempotencyKey: "ordered-newer" }),
        ),
      ),
    );
    expect(
      (
        await test.handler(
          moderationRequest(OWNER, {
            action: "delete",
            messageId: (older.message as Record<string, unknown>).messageId,
          }),
        )
      ).status,
    ).toBe(200);

    const delta = await body(
      await test.handler(
        linkRequest(
          test.view,
          "/sync/link/discussion/activity?since=1&hold=0&limit=100",
          {},
          { profileSecret: PROFILE_A },
        ),
      ),
    );
    expect(messages(delta)).toEqual([
      {
        messageId: (older.message as Record<string, unknown>).messageId,
        createdAtMs: (older.message as Record<string, unknown>).createdAtMs,
        deleted: true,
      },
      newer.message,
    ]);
  });

  it("refuses public activity when principal lookup races with grant revocation", async () => {
    const test = await fixture();
    const invalidCapability = {
      ...test.comment,
      capabilityToken: secret("z"),
    };
    const baseline = await genericRefusal(
      await test.handler(
        linkRequest(
          invalidCapability,
          "/sync/link/discussion/activity?since=0&hold=0&limit=100",
          {},
          { profileSecret: PROFILE_A },
        ),
      ),
    );
    const original = test.storage.getLinkPrincipalForGrantProfile.bind(
      test.storage,
    );
    let revoked = false;
    test.storage.getLinkPrincipalForGrantProfile = (grantId, profileTokenHash) => {
      const principal = original(grantId, profileTokenHash);
      const result = test.storage.revokeShareGrant({
        shareId: SHARE,
        grantId: test.comment.grantId,
        revokedAtMs: 20_000,
        expectedDependentGrantIds: [],
      });
      expect(result.ok).toBe(true);
      revoked = true;
      return principal;
    };

    const response = await test.handler(
      linkRequest(
        test.comment,
        "/sync/link/discussion/activity?since=0&hold=0&limit=100",
        {},
        { profileSecret: PROFILE_A },
      ),
    );
    expect(revoked).toBe(true);
    expect(await genericRefusal(response)).toBe(baseline);
  });

  it("keeps a narrowed parked reader and refuses invalidated readers", async () => {
    for (const transition of ["rotate", "retune"] as const) {
      const activityHub = new DiscussionActivityHub();
      const test = await fixture({ discussionActivity: activityHub });
      const waiting = test.handler(
        linkRequest(
          test.comment,
          "/sync/link/discussion/activity?since=0&hold=30000&limit=100",
          {},
          { profileSecret: PROFILE_A },
        ),
      );
      expect(activityHub.stats()).toEqual({ shares: 1, waiters: 1 });
      const changed = await test.handler(
        request(
          OWNER,
          `/sync/shares/${SHARE}/links/${test.comment.grantId}/${transition}`,
          jsonRequest(
            transition === "rotate"
              ? { workspaceId: WORKSPACE, expectedDependentGrantIds: [] }
              : {
                  workspaceId: WORKSPACE,
                  access: "view",
                  expectedDependentGrantIds: [],
                },
          ),
        ),
      );
      expect(changed.status, transition).toBe(200);
      await changed.arrayBuffer();
      const settled = await waiting;
      if (transition === "retune") {
        expect(settled.status).toBe(200);
        expect(await body(settled)).toMatchObject({
          access: "view",
          latestRevision: 1,
          cursorRevision: 1,
          messages: [],
        });
      } else {
        expect(await genericRefusal(settled), transition).toContain("404:");
      }
      expect(activityHub.stats()).toEqual({ shares: 0, waiters: 0 });
    }

    const ownershipHub = new DiscussionActivityHub();
    const ownership = await fixture({ discussionActivity: ownershipHub });
    const oldOwnerWait = ownership.handler(
      request(
        OWNER,
        `/sync/shares/${SHARE}/discussion/activity?since=0&hold=30000&limit=100`,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(ownershipHub.stats()).toEqual({ shares: 1, waiters: 1 });
    updateWorkspaceOwner(ownership.dbPath, NEW_OWNER);
    const newOwnerAppend = await ownership.handler(
      request(
        NEW_OWNER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({
          body: "new owner wake",
          idempotencyKey: "new-owner-wake",
        }),
      ),
    );
    expect(newOwnerAppend.status).toBe(200);
    await newOwnerAppend.arrayBuffer();
    expect(await genericRefusal(await oldOwnerWait)).toContain("404:");
    expect(ownershipHub.stats()).toEqual({ shares: 0, waiters: 0 });

    const accessHub = new DiscussionActivityHub();
    const access = await fixture({ discussionActivity: accessHub });
    const recipientWait = access.handler(
      request(
        COMMENTER,
        `/sync/shares/${SHARE}/discussion/activity?since=0&hold=30000&limit=100`,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(accessHub.stats()).toEqual({ shares: 1, waiters: 1 });
    const revoke = await access.handler(
      request(
        OWNER,
        "/sync/shares/share-discussion-sentinel/grants/named-comment-grant-sentinel/revoke",
        jsonRequest({ workspaceId: WORKSPACE }),
      ),
    );
    expect(revoke.status).toBe(200);
    await revoke.arrayBuffer();
    expect(await genericRefusal(await recipientWait)).toContain("404:");
    expect(accessHub.stats()).toEqual({ shares: 0, waiters: 0 });
  });

  it("does not park when link access narrows between observation and waiter registration", async () => {
    const activityHub = new DiscussionActivityHub();
    const test = await fixture({ discussionActivity: activityHub });
    let shouldPark: boolean | undefined;
    vi.spyOn(activityHub, "wait").mockImplementation(
      async (_shareId, _actorId, options) => {
        const narrowed = test.storage.retuneShareGrant({
          shareId: SHARE,
          grantId: test.comment.grantId,
          access: "view",
          changedAtMs: 20_000,
          expectedDependentGrantIds: [],
          guard: () => {},
        });
        expect(narrowed.ok).toBe(true);
        shouldPark = options.shouldPark();
      },
    );

    const response = await test.handler(
      linkRequest(
        test.comment,
        "/sync/link/discussion/activity?since=0&hold=30000&limit=100",
        {},
        { profileSecret: PROFILE_A },
      ),
    );

    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(shouldPark).toBe(false);
    expect(await body(response)).toMatchObject({
      access: "view",
      latestRevision: 1,
      cursorRevision: 1,
      messages: [],
    });
  });

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

  it("restores the server-derived profile name through refresh and re-exchange", async () => {
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
        workspaceId: WORKSPACE,
        principalId: firstPrincipal!,
        actorUserId: OWNER,
        blockedAtMs: 20_000,
      }),
    ).toBe(true);
    expect(
      test.storage.setLinkPrincipalBlocked({
        shareId: SHARE,
        workspaceId: WORKSPACE,
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
    const restored = await test.handler(
      linkRequest(
        test.comment,
        "/sync/link/discussion",
        {},
        { profileSecret: PROFILE_A },
      ),
    );
    expect(restored.status).toBe(200);
    const restoredPage = await body(restored);
    expect(restoredPage.profileName).toBe("Stable Name");
    expect(Object.keys(restoredPage).sort()).toEqual([
      "activityRevision",
      "messages",
      "nextCursor",
      "ok",
      "profileName",
    ]);
    const restoredText = JSON.stringify(restoredPage);
    for (const internal of [
      firstPrincipal!,
      PROFILE_A,
      test.comment.grantId,
      test.comment.capabilityToken,
    ]) {
      expect(restoredText).not.toContain(internal);
    }
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
    const unnamed = await test.handler(
      linkRequest(
        test.comment,
        "/sync/link/discussion",
        {},
        { profileSecret: PROFILE_B },
      ),
    );
    expect(unnamed.status).toBe(200);
    expect((await body(unnamed)).profileName).toBeNull();
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
    const malformedProfileRead = await test.handler(
      linkRequest(
        test.comment,
        "/sync/link/discussion",
        {},
        { profileSecret: "not-a-profile" },
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
    expect(await genericRefusal(malformedProfileRead)).toBe(refusal);
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

  it.each([
    ["leading", "\u0000hello"],
    ["interior", "hello\u0000world"],
  ] as const)(
    "returns bad_request for a %s NUL on link and authenticated append",
    async (label, nulBody) => {
      const test = await fixture();
      const before = {
        principals: count(test.dbPath, "sync_relay_link_principals"),
        messages: count(test.dbPath, "sync_relay_share_discussion_messages"),
        usage: discussionUsage(test.dbPath),
        revision: test.storage.getShareDiscussionRevision(SHARE),
      };

      const responses = [
        await test.handler(
          trustedAppend(test.comment, {
            body: nulBody,
            idempotencyKey: `${label}-link-nul`,
          }),
        ),
        await test.handler(
          request(
            COMMENTER,
            `/sync/shares/${SHARE}/discussion`,
            jsonRequest({
              body: nulBody,
              idempotencyKey: `${label}-named-nul`,
            }),
          ),
        ),
      ];
      for (const response of responses) {
        expect(response.status).toBe(400);
        expectPrivate(response);
        expect(await body(response)).toEqual({
          ok: false,
          error: "discussion message is invalid",
          code: "bad_request",
        });
      }
      expect({
        principals: count(test.dbPath, "sync_relay_link_principals"),
        messages: count(test.dbPath, "sync_relay_share_discussion_messages"),
        usage: discussionUsage(test.dbPath),
        revision: test.storage.getShareDiscussionRevision(SHARE),
      }).toEqual(before);
    },
  );

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
        .messages.map((message) => ({
          authorKind: message.authorKind,
          authorUserId: message.authorUserId,
        })),
    ).toEqual([
      { authorKind: "owner", authorUserId: OWNER },
      { authorKind: "named", authorUserId: COMMENTER },
      { authorKind: "named", authorUserId: EDITOR },
    ]);
    const projected = (await body(
      await test.handler(request(COMMENTER, `/sync/shares/${SHARE}/discussion`)),
    )).messages as Array<{ author: { kind: string } }>;
    expect(projected.map((message) => message.author.kind)).toEqual([
      "named",
      "named",
      "named",
    ]);
  });

  it("falls back to Unnamed when an authenticated display-name lookup fails", async () => {
    for (const [actor, authorKind, failureMode] of [
      [OWNER, "owner", "async-rejection"],
      [COMMENTER, "named", "async-rejection"],
      [OWNER, "owner", "synchronous-throw"],
      [COMMENTER, "named", "synchronous-throw"],
    ] as const) {
      const lookupUserDisplayName =
        failureMode === "async-rejection"
          ? vi.fn(async () => {
              throw new Error("display-name lookup unavailable");
            })
          : vi.fn(() => {
              throw new Error("display-name lookup unavailable");
            });
      const test = await fixture({ lookupUserDisplayName });
      const caseLabel = `${actor}:${failureMode}`;
      const beforeRows = count(
        test.dbPath,
        "sync_relay_share_discussion_messages",
      );
      const beforeRevision = test.storage.getShareDiscussionRevision(SHARE);
      const messageBody = `fallback from ${caseLabel}`;

      const response = await test.handler(
        request(
          actor,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({
            body: messageBody,
            idempotencyKey: `display-name-fallback-${authorKind}-${failureMode}`,
          }),
        ),
      );

      expect(response.status, caseLabel).toBe(200);
      expectPrivate(response);
      expect(await body(response), caseLabel).toMatchObject({
        message: {
          body: messageBody,
          author: { kind: "named", displayName: "Unnamed" },
        },
      });
      expect(lookupUserDisplayName, caseLabel).toHaveBeenCalledOnce();
      expect(lookupUserDisplayName, caseLabel).toHaveBeenCalledWith(actor);
      expect(
        count(test.dbPath, "sync_relay_share_discussion_messages"),
        caseLabel,
      ).toBe(beforeRows + 1);
      expect(test.storage.getShareDiscussionRevision(SHARE), caseLabel).toBe(
        (beforeRevision ?? 0) + 1,
      );
      expect(
        test.storage.listShareDiscussionMessages({ shareId: SHARE, limit: 10 })
          .messages,
        caseLabel,
      ).toMatchObject([
        {
          authorKind,
          authorUserId: actor,
          displayNameSnapshot: "Unnamed",
          body: messageBody,
        },
      ]);
    }
  });

  it("clears the display-name deadline after a timely asynchronous lookup", async () => {
    let signalLookupStarted: () => void = () => {};
    const lookupStarted = new Promise<void>((resolve) => {
      signalLookupStarted = resolve;
    });
    let releaseLookup: (name: string | null) => void = () => {};
    const deferredName = new Promise<string | null>((resolve) => {
      releaseLookup = resolve;
    });
    const lookupUserDisplayName = vi.fn(() => {
      signalLookupStarted();
      return deferredName;
    });
    const test = await fixture({ lookupUserDisplayName });
    vi.useFakeTimers();

    try {
      const timerBaseline = vi.getTimerCount();
      const pending = test.handler(
        request(
          OWNER,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({
            body: "timely display name",
            idempotencyKey: "timely-display-name",
          }),
        ),
      );
      await lookupStarted;
      expect(vi.getTimerCount()).toBe(timerBaseline + 1);

      await vi.advanceTimersByTimeAsync(
        DISCUSSION_DISPLAY_NAME_LOOKUP_DEADLINE_MS - 1,
      );
      releaseLookup("  Owner Name  ");
      const response = await pending;

      expect(response.status).toBe(200);
      expectPrivate(response);
      expect(await body(response)).toMatchObject({
        message: {
          author: { kind: "named", displayName: "Owner Name" },
        },
      });
      expect(vi.getTimerCount()).toBe(timerBaseline);
      expect(
        test.storage.listShareDiscussionMessages({ shareId: SHARE, limit: 10 })
          .messages,
      ).toMatchObject([
        {
          authorKind: "owner",
          authorUserId: OWNER,
          displayNameSnapshot: "Owner Name",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled authenticated display-name lookup before persisting the fallback", async () => {
    for (const [actor, authorKind] of [
      [OWNER, "owner"],
      [COMMENTER, "named"],
    ] as const) {
      let signalLookupStarted: () => void = () => {};
      const lookupStarted = new Promise<void>((resolve) => {
        signalLookupStarted = resolve;
      });
      let rejectLookup: (error: Error) => void = () => {};
      const stalledLookup = new Promise<string | null>((_resolve, reject) => {
        rejectLookup = reject;
      });
      const lookupUserDisplayName = vi.fn(() => {
        signalLookupStarted();
        return stalledLookup;
      });
      const test = await fixture({ lookupUserDisplayName });
      const caseLabel = `${actor}:${authorKind}`;
      const beforeRows = count(
        test.dbPath,
        "sync_relay_share_discussion_messages",
      );
      const beforeRevision = test.storage.getShareDiscussionRevision(SHARE);
      const unhandledRejections: unknown[] = [];
      const observeUnhandledRejection = (error: unknown) => {
        unhandledRejections.push(error);
      };
      process.on("unhandledRejection", observeUnhandledRejection);
      vi.useFakeTimers();

      try {
        const timerBaseline = vi.getTimerCount();
        let settled = false;
        const pending = test
          .handler(
            request(
              actor,
              `/sync/shares/${SHARE}/discussion`,
              jsonRequest({
                body: `stalled lookup from ${actor}`,
                idempotencyKey: `stalled-display-name-${authorKind}`,
              }),
            ),
          )
          .then((response) => {
            settled = true;
            return response;
          });
        await lookupStarted;

        expect(lookupUserDisplayName, caseLabel).toHaveBeenCalledOnce();
        expect(lookupUserDisplayName, caseLabel).toHaveBeenCalledWith(actor);
        expect(settled, caseLabel).toBe(false);
        expect(vi.getTimerCount(), caseLabel).toBe(timerBaseline + 1);

        await vi.advanceTimersByTimeAsync(
          DISCUSSION_DISPLAY_NAME_LOOKUP_DEADLINE_MS - 1,
        );
        expect(settled, caseLabel).toBe(false);
        expect(
          count(test.dbPath, "sync_relay_share_discussion_messages"),
          caseLabel,
        ).toBe(beforeRows);
        expect(test.storage.getShareDiscussionRevision(SHARE), caseLabel).toBe(
          beforeRevision,
        );

        await vi.advanceTimersByTimeAsync(1);
        const response = await pending;
        expect(response.status, caseLabel).toBe(200);
        expectPrivate(response);
        expect(await body(response), caseLabel).toMatchObject({
          message: {
            body: `stalled lookup from ${actor}`,
            author: { kind: "named", displayName: "Unnamed" },
          },
        });
        expect(
          count(test.dbPath, "sync_relay_share_discussion_messages"),
          caseLabel,
        ).toBe(beforeRows + 1);
        expect(test.storage.getShareDiscussionRevision(SHARE), caseLabel).toBe(
          (beforeRevision ?? 0) + 1,
        );
        expect(
          test.storage.listShareDiscussionMessages({ shareId: SHARE, limit: 10 })
            .messages,
          caseLabel,
        ).toMatchObject([
          {
            authorKind,
            authorUserId: actor,
            displayNameSnapshot: "Unnamed",
            body: `stalled lookup from ${actor}`,
          },
        ]);
        expect(vi.getTimerCount(), caseLabel).toBe(timerBaseline);

        rejectLookup(new Error(`late lookup rejection for ${caseLabel}`));
        await Promise.resolve();
        vi.runAllTicks();
        await Promise.resolve();
        expect(unhandledRejections, caseLabel).toEqual([]);
      } finally {
        process.off("unhandledRejection", observeUnhandledRejection);
        vi.useRealTimers();
      }
    }
  });

  it("projects durable owner rows exactly before and after deletion", async () => {
    const test = await fixture();
    const appendedResponse = await test.handler(
      request(
        OWNER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({
          body: "Owner projection body",
          idempotencyKey: "owner-projection",
        }),
      ),
    );
    expect(appendedResponse.status).toBe(200);
    expectPrivate(appendedResponse);
    const appended = await body(appendedResponse);
    const stored = test.storage.listShareDiscussionMessages({
      shareId: SHARE,
      limit: 10,
    }).messages[0]!;
    expect(stored).toMatchObject({
      authorKind: "owner",
      authorUserId: OWNER,
      linkGrantId: null,
      linkPrincipalId: null,
    });
    const live = {
      messageId: stored.messageId,
      createdAtMs: stored.createdAtMs,
      deleted: false,
      body: "Owner projection body",
      author: { kind: "named", displayName: "Owner Name" },
    };
    expect(appended.message).toEqual(live);
    expect(Object.keys(appended.message as object).sort()).toEqual([
      "author",
      "body",
      "createdAtMs",
      "deleted",
      "messageId",
    ]);
    expect(
      Object.keys((appended.message as { author: object }).author).sort(),
    ).toEqual(["displayName", "kind"]);

    for (const response of await Promise.all([
      test.handler(linkRequest(test.view, "/sync/link/discussion")),
      test.handler(request(COMMENTER, `/sync/shares/${SHARE}/discussion`)),
      test.handler(request(OWNER, `/sync/shares/${SHARE}/discussion`)),
    ])) {
      expect(response.status).toBe(200);
      expectPrivate(response);
      const projectedLive = messages(await body(response));
      expect(projectedLive).toEqual([live]);
      expect(Object.keys(projectedLive[0]!).sort()).toEqual([
        "author",
        "body",
        "createdAtMs",
        "deleted",
        "messageId",
      ]);
      expect(Object.keys(projectedLive[0]!.author as object).sort()).toEqual([
        "displayName",
        "kind",
      ]);
    }

    const deletedResponse = await test.handler(
      moderationRequest(OWNER, {
        action: "delete",
        messageId: stored.messageId,
      }),
    );
    expect(deletedResponse.status).toBe(200);
    expectPrivate(deletedResponse);
    expect(await body(deletedResponse)).toEqual({
      ok: true,
      message: {
        messageId: stored.messageId,
        createdAtMs: stored.createdAtMs,
        deleted: true,
      },
    });

    const publicTombstone = {
      messageId: stored.messageId,
      createdAtMs: stored.createdAtMs,
      deleted: true,
    };
    for (const response of await Promise.all([
      test.handler(linkRequest(test.view, "/sync/link/discussion")),
      test.handler(request(COMMENTER, `/sync/shares/${SHARE}/discussion`)),
    ])) {
      expect(response.status).toBe(200);
      expectPrivate(response);
      const projectedTombstone = messages(await body(response));
      expect(projectedTombstone).toEqual([publicTombstone]);
      expect(Object.keys(projectedTombstone[0]!).sort()).toEqual([
        "createdAtMs",
        "deleted",
        "messageId",
      ]);
    }

    const ownerTombstoneResponse = await test.handler(
      request(OWNER, `/sync/shares/${SHARE}/discussion`),
    );
    expect(ownerTombstoneResponse.status).toBe(200);
    expectPrivate(ownerTombstoneResponse);
    const ownerTombstone = messages(await body(ownerTombstoneResponse));
    expect(ownerTombstone).toEqual([{
      ...publicTombstone,
      author: { kind: "named", displayName: "Owner Name" },
    }]);
    expect(Object.keys(ownerTombstone[0]!).sort()).toEqual([
      "author",
      "createdAtMs",
      "deleted",
      "messageId",
    ]);
    expect(Object.keys(ownerTombstone[0]!.author as object).sort()).toEqual([
      "displayName",
      "kind",
    ]);
  });

  it("returns authenticated rate, recipient, and share limit errors exactly", async () => {
    const rate = await fixture({
      discussionLimits: {
        discussionMessageRateLimit: 1,
        discussionLifetimeMessageLimit: 10,
        discussionNonOwnerShareRowLimit: 10,
      },
    });
    expect(
      await rate.handler(
        request(
          COMMENTER,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({ body: "first", idempotencyKey: "rate-first" }),
        ),
      ),
    ).toMatchObject({ status: 200 });
    const rateLimited = await rate.handler(
      request(
        COMMENTER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({ body: "second", idempotencyKey: "rate-second" }),
      ),
    );
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get("cache-control")).toBe("private, no-store");
    expect(await body(rateLimited)).toEqual({
      ok: false,
      error: "discussion message rate limit reached",
      code: "discussion_rate_limited",
    });

    const lifetime = await fixture({
      discussionLimits: {
        discussionMessageRateLimit: 10,
        discussionLifetimeMessageLimit: 1,
        discussionNonOwnerShareRowLimit: 10,
      },
    });
    await lifetime.handler(
      request(
        COMMENTER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({ body: "first", idempotencyKey: "lifetime-first" }),
      ),
    );
    const lifetimeLimited = await lifetime.handler(
      request(
        COMMENTER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({ body: "second", idempotencyKey: "lifetime-second" }),
      ),
    );
    expect(lifetimeLimited.status).toBe(413);
    expect(lifetimeLimited.headers.get("cache-control")).toBe("private, no-store");
    expect(await body(lifetimeLimited)).toEqual({
      ok: false,
      error: "recipient discussion message limit reached",
      code: "discussion_limit_reached",
    });

    const share = await fixture({
      discussionLimits: {
        discussionMessageRateLimit: 10,
        discussionLifetimeMessageLimit: 10,
        discussionNonOwnerShareRowLimit: 1,
      },
    });
    await share.handler(
      request(
        COMMENTER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({ body: "first", idempotencyKey: "share-first" }),
      ),
    );
    const shareLimited = await share.handler(
      request(
        EDITOR,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({ body: "second", idempotencyKey: "share-second" }),
      ),
    );
    expect(shareLimited.status).toBe(413);
    expect(shareLimited.headers.get("cache-control")).toBe("private, no-store");
    expect(await body(shareLimited)).toEqual({
      ok: false,
      error: "share discussion message limit reached",
      code: "discussion_limit_reached",
    });
    const ownerAfterLimit = await share.handler(
      request(
        OWNER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({ body: "owner", idempotencyKey: "share-owner" }),
      ),
    );
    expect(ownerAfterLimit.status).toBe(200);
    expect(
      share.storage.listShareDiscussionMessages({ shareId: SHARE, limit: 10 }).messages,
    ).toMatchObject([
      { authorKind: "named", authorUserId: COMMENTER },
      { authorKind: "owner", authorUserId: OWNER },
    ]);
  });

  it("keeps authenticated conflicts exact when every discussion budget is full", async () => {
    const test = await fixture({
      discussionLimits: {
        discussionMessageRateLimit: 1,
        discussionLifetimeMessageLimit: 1,
        discussionNonOwnerShareRowLimit: 1,
      },
    });
    const first = await test.handler(
      request(
        COMMENTER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({
          body: "Original conflict body",
          idempotencyKey: "conflict-at-full-budget",
        }),
      ),
    );
    expect(first.status).toBe(200);
    expectPrivate(first);
    await first.arrayBuffer();

    const conflict = await test.handler(
      request(
        COMMENTER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({
          body: "Changed conflict body",
          idempotencyKey: "conflict-at-full-budget",
        }),
      ),
    );
    expect(conflict.status).toBe(409);
    expectPrivate(conflict);
    expect(await body(conflict)).toEqual({
      ok: false,
      error: "idempotency key was already used for a different message",
      code: "conflict",
    });
    expect(
      test.storage.listShareDiscussionMessages({ shareId: SHARE, limit: 10 }).messages,
    ).toMatchObject([{
      authorKind: "named",
      authorUserId: COMMENTER,
      body: "Original conflict body",
    }]);
  });

  it("charges the transaction-current recipient role for an initially named actor", async () => {
    const test = await fixture({
      discussionLimits: {
        discussionMessageRateLimit: 10,
        discussionLifetimeMessageLimit: 1,
        discussionNonOwnerShareRowLimit: 10,
      },
    });
    expect(
      test.storage.appendAuthenticatedDiscussionMessage({
        shareId: SHARE,
        authorUserId: COMMENTER,
        displayName: "Commenter Name",
        body: "Existing recipient message",
        idempotencyKey: "named-recipient-debt",
        createdAtMs: 9_000,
        readGuard: () => "recipient",
        appendGuard: () => "recipient",
      }),
    ).toMatchObject({ ok: true, message: { authorKind: "named" } });

    const response = await test.handler(
      rawRequest(
        COMMENTER,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({
          body: "Must use the role at commit time",
          idempotencyKey: "initially-named-recipient",
        }),
      ),
    );
    expect(response.status).toBe(413);
    expect(await body(response)).toEqual({
      ok: false,
      error: "recipient discussion message limit reached",
      code: "discussion_limit_reached",
    });
    expect(
      test.storage.listShareDiscussionMessages({ shareId: SHARE, limit: 10 }).messages,
    ).toMatchObject([
      { authorKind: "named", authorUserId: COMMENTER },
    ]);
  });

  it("lets a named Comment recipient discuss a pinned version without file authority", async () => {
    const test = await fixture();
    const shareId = "version-comment-share-sentinel";
    const versionId = "review-version-sentinel";
    const path = "docs/pinned.md";
    const pinnedBody = "pinned version bytes\n";
    const liveBody = "newer live bytes\n";
    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const pinnedSha256 = digest(pinnedBody);
    const liveSha256 = digest(liveBody);
    for (const [sha256, content, createdAtMs] of [
      [pinnedSha256, pinnedBody, 2_000],
      [liveSha256, liveBody, 2_001],
    ] as const) {
      const bytes = new TextEncoder().encode(content);
      expect(
        test.storage.putBlob({
          workspaceId: WORKSPACE,
          sha256,
          content: bytes,
          createdAtMs,
        }),
      ).toEqual({ byteLength: bytes.byteLength, alreadyHad: false });
    }
    expect(
      test.storage.appendLogBatch({
        workspaceId: WORKSPACE,
        originId: "version-comment-origin",
        ops: [
          {
            originSeq: 0,
            opKind: "version.create",
            payloadJson: JSON.stringify({
              versionId,
              name: "Review version",
              kind: "named",
              createdAtMs: 2_002,
              forkSnapshots: [
                {
                  objectId: "version-comment-object",
                  path,
                  blobSha256: pinnedSha256,
                  updatedAtMs: 2_002,
                  latestMomentId: "version-comment-snapshot",
                  metadata: {},
                },
              ],
            }),
            recordedAtMs: 2_002,
          },
          {
            originSeq: 1,
            opKind: "moment.append",
            payloadJson: JSON.stringify({
              momentId: "version-comment-live-moment",
              versionId: "main",
              objectId: "version-comment-object",
              path,
              recordedAtMs: 2_003,
              operation: "write",
              payloadBeforeBlobSha256: null,
              payloadBeforePath: null,
              payloadAfterBlobSha256: liveSha256,
              payloadAfterPath: path,
              metadata: { origin: "user" },
              beforePresent: "null",
              afterPresent: "content",
            }),
            recordedAtMs: 2_003,
          },
        ],
      }),
    ).toMatchObject({ inserted: 2 });

    test.storage.createShare({
      share: {
        shareId,
        workspaceId: WORKSPACE,
        granterUserId: OWNER,
        selectorJson: JSON.stringify({ paths: [], versionId }),
        createdAtMs: 2_004,
      },
      grant: {
        grantId: "version-view-grant-sentinel",
        shareId,
        principalKind: "user",
        principalUserId: VIEWER,
        principalEmail: null,
        access: "view",
        generation: 1,
        status: "active",
        createdAtMs: 2_004,
        revokedAtMs: null,
        parentGrantId: null,
      },
    });
    const link: LinkFixture = {
      access: "comment",
      grantId: "version-comment-link-grant-sentinel",
      secret: secret("l"),
      capabilityToken: secret("m"),
    };
    expect(
      test.storage.createLinkGrant({
        grant: {
          grantId: link.grantId,
          shareId,
          principalKind: "link",
          principalUserId: null,
          principalEmail: null,
          access: link.access,
          generation: 1,
          status: "active",
          createdAtMs: 2_005,
          revokedAtMs: null,
          parentGrantId: null,
        },
        credential: {
          credentialId: "version-comment-credential-sentinel",
          grantId: link.grantId,
          secretHash: hashLinkBearer(link.secret, LINK_KEY),
          generation: 1,
          mintedAtMs: 2_005,
          retiredAtMs: null,
        },
      }),
    ).toBe(true);
    expect(
      test.storage.mintLinkSession({
        session: {
          sessionId: "version-comment-session-sentinel",
          capabilityHash: hashLinkBearer(link.capabilityToken, LINK_KEY),
          grantId: link.grantId,
          generation: 1,
          mintedAtMs: 2_006,
          expiresAtMs: 1_000_000,
        },
      }),
    ).toBe(true);

    const linkAppend = await test.handler(
      trustedAppend(
        link,
        {
          body: "link version comment",
          claimedName: "Version Link",
          idempotencyKey: "version-link-comment",
        },
        PROFILE_A,
      ),
    );
    expect(linkAppend.status).toBe(200);
    await linkAppend.arrayBuffer();

    const handoff = await test.handler(
      linkRequest(
        link,
        "/sync/link-handoff",
        { method: "POST" },
        { relayKey: RELAY_KEY },
      ),
    );
    expect(handoff.status).toBe(200);
    const redeemed = await test.handler(
      request(
        COMMENTER,
        "/sync/link-redeem",
        jsonRequest({ code: (await body(handoff)).code }),
      ),
    );
    expect(redeemed.status).toBe(200);
    const redeemedBody = await body(redeemed);
    expect(redeemedBody).toMatchObject({
      shareId,
      access: "comment",
    });
    expect(test.storage.getShareGrant(String(redeemedBody.grantId))).toMatchObject({
      principalUserId: COMMENTER,
      parentGrantId: link.grantId,
    });

    const namedAppend = await test.handler(
      request(
        COMMENTER,
        `/sync/shares/${shareId}/discussion`,
        jsonRequest({
          body: "named version comment",
          idempotencyKey: "version-named-comment",
        }),
      ),
    );
    expect(namedAppend.status).toBe(200);
    expectPrivate(namedAppend);
    const timeline = await body(
      await test.handler(request(OWNER, `/sync/shares/${shareId}/discussion`)),
    );
    expect(messages(timeline).map((message) => message.body)).toEqual([
      "link version comment",
      "named version comment",
    ]);

    const namedLog = await body(
      await test.handler(
        request(COMMENTER, `/sync/shares/${shareId}/log?since=0`),
      ),
    );
    expect(JSON.stringify(namedLog)).toContain(pinnedSha256);
    expect(JSON.stringify(namedLog)).not.toContain(liveSha256);
    const pinnedBlob = await test.handler(
      request(COMMENTER, `/sync/shares/${shareId}/blobs/${pinnedSha256}`),
    );
    expect(pinnedBlob.status).toBe(200);
    expect(await pinnedBlob.text()).toBe(pinnedBody);
    expect(
      (
        await test.handler(
          request(COMMENTER, `/sync/shares/${shareId}/blobs/${liveSha256}`),
        )
      ).status,
    ).toBe(404);

    for (const [route, payload] of [
      ["log", { originId: "version-named-write", ops: [] }],
      ["proposals", { submitId: "version-named-proposal", ops: [] }],
    ] as const) {
      const denied = await test.handler(
        request(
          COMMENTER,
          `/sync/shares/${shareId}/${route}`,
          jsonRequest(payload),
        ),
      );
      expect(denied.status, route).toBe(403);
      expect(await body(denied), route).toEqual({
        ok: false,
        error: "this share does not accept appends",
        code: "share_read_only",
      });
    }
    const viewAppend = await test.handler(
      request(
        VIEWER,
        `/sync/shares/${shareId}/discussion`,
        jsonRequest({
          body: "view version comment",
          idempotencyKey: "version-view-comment",
        }),
      ),
    );
    expect(viewAppend.status).toBe(403);
    expectPrivate(viewAppend);
    expect(await body(viewAppend)).toEqual({
      ok: false,
      error: "this share does not accept appends",
      code: "share_read_only",
    });
  });

  it("canonicalizes named display snapshots and falls back at the durable bound", async () => {
    for (const [sourceName, expectedName, idempotencyKey] of [
      ["x".repeat(41), "Unnamed", "overbound-name"],
      [" \u202eCafe\u0301   Person\u0000 ", "Café Person", "canonical-name"],
    ] as const) {
      const test = await fixture({
        lookupUserDisplayName: (userId) =>
          userId === COMMENTER ? sourceName : null,
      });
      const appended = await test.handler(
        request(
          COMMENTER,
          `/sync/shares/${SHARE}/discussion`,
          jsonRequest({ body: "bounded name", idempotencyKey }),
        ),
      );
      expect(appended.status).toBe(200);
      expectPrivate(appended);
      await appended.arrayBuffer();

      const reads = await Promise.all([
        test.handler(linkRequest(test.view, "/sync/link/discussion")),
        test.handler(request(COMMENTER, `/sync/shares/${SHARE}/discussion`)),
        test.handler(request(OWNER, `/sync/shares/${SHARE}/discussion`)),
      ]);
      for (const response of reads) {
        expect(response.status).toBe(200);
        expectPrivate(response);
        const page = await body(response);
        const [message] = messages(page);
        expect(message).toEqual({
          messageId: expect.any(String),
          createdAtMs: expect.any(Number),
          deleted: false,
          body: "bounded name",
          author: { kind: "named", displayName: expectedName },
        });
        expect(Object.keys(message!).sort()).toEqual([
          "author",
          "body",
          "createdAtMs",
          "deleted",
          "messageId",
        ]);
        expect(Object.keys(message!.author as object).sort()).toEqual([
          "displayName",
          "kind",
        ]);
      }
      expect(
        test.storage.listShareDiscussionMessages({ shareId: SHARE, limit: 1 })
          .messages[0]?.displayNameSnapshot,
      ).toBe(expectedName);
    }
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
            workspaceId: WORKSPACE,
            actorUserId: OWNER,
            pausedAtMs: 20_000,
          });
        } else {
          test.storage.setLinkPrincipalBlocked({
            shareId: SHARE,
            workspaceId: WORKSPACE,
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
    const originalAuthenticated = named.storage.appendAuthenticatedDiscussionMessage.bind(
      named.storage,
    );
    named.storage.appendAuthenticatedDiscussionMessage = (input) => {
      named.storage.revokeShareGrant({
        shareId: SHARE,
        grantId: "named-comment-grant-sentinel",
        revokedAtMs: 30_000,
      });
      return originalAuthenticated(input);
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

  it("returns a committed link retry after pause without admitting a new write", async () => {
    const test = await fixture();
    const first = await test.handler(
      trustedAppend(test.comment, {
        body: "Committed before pause",
        claimedName: "Retry Name",
        idempotencyKey: "lost-before-pause",
      }),
    );
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    const committed = test.storage.listShareDiscussionMessages({
      shareId: SHARE,
      limit: 100,
    }).messages[0]!;

    const paused = await test.handler(
      moderationRequest(OWNER, { action: "pause" }),
    );
    expect(paused.status).toBe(200);
    await paused.arrayBuffer();
    const snapshot = {
      messages: count(test.dbPath, "sync_relay_share_discussion_messages"),
      principals: count(test.dbPath, "sync_relay_link_principals"),
      revision: test.storage.getShareDiscussionRevision(SHARE),
      usage: workspaceUsage(test.dbPath, WORKSPACE),
    };

    const replay = await test.handler(
      trustedAppend(test.comment, {
        body: "Committed before pause",
        claimedName: "Retry Name",
        idempotencyKey: "lost-before-pause",
      }),
    );
    expect(replay.status).toBe(200);
    expect(await body(replay)).toMatchObject({
      ok: true,
      message: { messageId: committed.messageId, body: "Committed before pause" },
    });
    expect(
      await genericRefusal(
        await test.handler(
          trustedAppend(test.comment, {
            body: "Conflicting retry",
            claimedName: "Retry Name",
            idempotencyKey: "lost-before-pause",
          }),
        ),
      ),
    ).toContain("404:");
    await discussionStateRefusal(
      await test.handler(
        trustedAppend(test.comment, {
          body: "Genuinely new",
          claimedName: "Retry Name",
          idempotencyKey: "new-after-pause",
        }),
      ),
      "paused",
    );
    expect({
      messages: count(test.dbPath, "sync_relay_share_discussion_messages"),
      principals: count(test.dbPath, "sync_relay_link_principals"),
      revision: test.storage.getShareDiscussionRevision(SHARE),
      usage: workspaceUsage(test.dbPath, WORKSPACE),
    }).toEqual(snapshot);

    const activity = await test.handler(
      linkRequest(
        test.comment,
        `/sync/link/discussion/activity?since=${snapshot.revision}&hold=0&limit=100`,
        {},
        { profileSecret: PROFILE_A },
      ),
    );
    expect(activity.status).toBe(200);
    expect(await body(activity)).toMatchObject({
      latestRevision: snapshot.revision,
      cursorRevision: snapshot.revision,
      messages: [],
      composerState: "paused",
    });
  });

  it("returns a committed named retry after narrowing without admitting a new write", async () => {
    const recipient = "narrowed-recipient-sentinel";
    const grantId = "narrowed-recipient-grant-sentinel";
    const test = await fixture({
      lookupUserDisplayName: (userId) =>
        userId === recipient ? "Narrowed Recipient" : null,
    });
    expect(
      test.storage.convertLinkGrant({
        shareId: SHARE,
        parentGrantId: test.comment.grantId,
        grantId,
        principalUserId: recipient,
        createdAtMs: 20_000,
      }),
    ).toMatchObject({ ok: true, grant: { access: "comment" } });
    const input = {
      body: "Committed before named narrowing",
      idempotencyKey: "named-lost-before-narrowing",
    };
    const first = await test.handler(
      request(
        recipient,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest(input),
      ),
    );
    expect(first.status).toBe(200);
    const committed = await body(first);

    expect(
      test.storage.retuneShareGrant({
        shareId: SHARE,
        grantId: test.comment.grantId,
        access: "view",
        changedAtMs: 30_000,
        expectedDependentGrantIds: [grantId],
        guard: () => {},
      }),
    ).toMatchObject({ ok: true, grant: { access: "view", generation: 1 } });
    expect(test.storage.getShareGrant(grantId)).toMatchObject({
      access: "view",
      generation: 2,
    });
    const snapshot = {
      rows: count(test.dbPath, "sync_relay_share_discussion_messages"),
      revision: test.storage.getShareDiscussionRevision(SHARE),
      usage: discussionUsage(test.dbPath),
    };

    const replay = await test.handler(
      request(
        recipient,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest(input),
      ),
    );
    expect(replay.status).toBe(200);
    expect(await body(replay)).toEqual(committed);

    const conflict = await test.handler(
      request(
        recipient,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({ ...input, body: "Conflicting named retry" }),
      ),
    );
    expect(conflict.status).toBe(409);
    expect(await body(conflict)).toMatchObject({ code: "conflict" });

    const fresh = await test.handler(
      request(
        recipient,
        `/sync/shares/${SHARE}/discussion`,
        jsonRequest({
          body: "Fresh after named narrowing",
          idempotencyKey: "named-new-after-narrowing",
        }),
      ),
    );
    expect(fresh.status).toBe(403);
    expect(await body(fresh)).toMatchObject({ code: "share_read_only" });
    expect({
      rows: count(test.dbPath, "sync_relay_share_discussion_messages"),
      revision: test.storage.getShareDiscussionRevision(SHARE),
      usage: discussionUsage(test.dbPath),
    }).toEqual(snapshot);
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
        workspaceId: WORKSPACE,
        messageId: linkMessage.messageId,
        deletedAtMs: 40_000,
        actorUserId: "x".repeat(DELETING_USER_ID_RESERVATION_BYTES + 1),
      }),
    ).toBeNull();
    expect(
      linkExact.storage.deleteShareDiscussionMessage({
        shareId: SHARE,
        workspaceId: WORKSPACE,
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
      expect(await body(refused)).toEqual({
        ok: false,
        error: "workspace quota exceeded",
        code: "quota_exceeded",
      });

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
        workspaceId: WORKSPACE,
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
        workspaceId: WORKSPACE,
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

    closeTestStorage(test.storage);
    const reopened = reopenTestStorage(test.dbPath);
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
        workspaceId: WORKSPACE,
        principalId,
        actorUserId: OWNER,
        blockedAtMs: 70_000,
      }),
    ).toBe(true);
    expect(
      test.storage.setShareLinkWritesPaused({
        shareId: SHARE,
        workspaceId: WORKSPACE,
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
          workspaceId: WORKSPACE,
          principalId,
          actorUserId: OWNER,
          blockedAtMs: null,
        }),
      ).toBe(true);
      expect(
        test.storage.setShareLinkWritesPaused({
          shareId: SHARE,
          workspaceId: WORKSPACE,
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

  it("refuses a binding-carrying owner read at the final check after ownership transfer despite a named grant", async () => {
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
    const baseline = await genericRefusal(
      await test.handler(
        rawRequest(
          OWNER,
          `/sync/shares/missing-owner-transfer-share/discussion?workspaceId=${WORKSPACE}`,
        ),
      ),
    );
    const beforeRows = count(test.dbPath, "sync_relay_share_discussion_messages");
    const beforeRevision = test.storage.getShareDiscussionRevision(SHARE);
    const beforeUsage = discussionUsage(test.dbPath);
    const originalList = test.storage.listShareDiscussionMessages.bind(test.storage);
    const list = vi
      .spyOn(test.storage, "listShareDiscussionMessages")
      .mockImplementation((input) => {
        const page = originalList(input);
        transferShareOwnership(test.dbPath, WORKSPACE, NEW_OWNER);
        return page;
      });

    const response = await test.handler(
      rawRequest(
        OWNER,
        `/sync/shares/${SHARE}/discussion?workspaceId=${WORKSPACE}`,
      ),
    );
    expect(await genericRefusal(response)).toBe(baseline);
    expect(list).toHaveBeenCalledOnce();
    expect(count(test.dbPath, "sync_relay_share_discussion_messages")).toBe(
      beforeRows,
    );
    expect(test.storage.getShareDiscussionRevision(SHARE)).toBe(beforeRevision);
    expect(discussionUsage(test.dbPath)).toBe(beforeUsage);

    list.mockRestore();
    const namedOmission = await test.handler(
      rawRequest(OWNER, `/sync/shares/${SHARE}/discussion?limit=100`),
    );
    expect(namedOmission.status).toBe(200);
    expectPrivate(namedOmission);
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

    closeTestStorage(test.storage);
    const reopened = reopenTestStorage(test.dbPath);
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

  it("carries the refusal transaction revision through blocked and paused relay errors", async () => {
    const test = await fixture();
    expect(
      (
        await test.handler(
          trustedAppend(
            test.comment,
            {
              body: "revision seed",
              claimedName: "Revision Profile",
              idempotencyKey: "revision-relay-seed",
            },
            PROFILE_A,
          ),
        )
      ).status,
    ).toBe(200);
    const principalId = test.storage
      .listShareDiscussionMessages({ shareId: SHARE, limit: 100 })
      .messages[0]!.linkPrincipalId!;

    expect(
      (
        await test.handler(
          moderationRequest(OWNER, { action: "block", principalId }),
        )
      ).status,
    ).toBe(200);
    const blockedRevision = test.storage.getShareDiscussionRevision(SHARE);
    expect(blockedRevision).toBe(2);
    const blocked = await test.handler(
      trustedAppend(
        test.comment,
        { body: "blocked refusal", idempotencyKey: "revision-relay-blocked" },
        PROFILE_A,
      ),
    );
    expect(blocked.status).toBe(403);
    expect(await body(blocked)).toEqual({
      ok: false,
      error: "link discussion writes are blocked",
      code: "link_discussion_blocked",
      activityRevision: blockedRevision,
    });

    expect(
      (
        await test.handler(
          moderationRequest(OWNER, { action: "unblock", principalId }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await test.handler(moderationRequest(OWNER, { action: "pause" }))).status,
    ).toBe(200);
    const pausedRevision = test.storage.getShareDiscussionRevision(SHARE);
    expect(pausedRevision).toBe(4);
    const paused = await test.handler(
      trustedAppend(
        test.comment,
        { body: "paused refusal", idempotencyKey: "revision-relay-paused" },
        PROFILE_A,
      ),
    );
    expect(paused.status).toBe(403);
    expect(await body(paused)).toEqual({
      ok: false,
      error: "link discussion writes are paused",
      code: "link_discussion_paused",
      activityRevision: pausedRevision,
    });
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
    ).toMatchObject({ principalId });

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
              body: "blocked while share paused",
              idempotencyKey: "blocked-while-paused",
            },
            PROFILE_A,
          ),
        ),
        "blocked",
      ),
    ).toContain("link_discussion_blocked");
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

  it("keeps blocked sessions bound and refuses a substituted profile", async () => {
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
    const principalsBeforeBlock = count(test.dbPath, "sync_relay_link_principals");

    const blocked = await test.handler(
      moderationRequest(OWNER, { action: "block", principalId }),
    );
    expect(blocked.status).toBe(200);
    expect(await body(blocked)).toEqual({ ok: true, blocked: true });
    const refreshedSecond = await test.handler(
      linkRequest(
        secondSession,
        "/sync/link-refresh",
        { method: "POST" },
        { relayKey: RELAY_KEY },
      ),
    );
    expect(refreshedSecond.status).toBe(200);
    secondSession.capabilityToken = String(
      (await body(refreshedSecond)).capabilityToken,
    );
    const revisionAfterBlock = test.storage.getShareDiscussionRevision(SHARE);
    const genericBaseline = await genericRefusal(
      await test.handler(
        linkRequest(
          { ...firstSession, capabilityToken: secret("z") },
          "/sync/link/discussion",
          jsonRequest({
            body: "generic refusal baseline",
            idempotencyKey: "block-session-generic-baseline",
          }),
          { relayKey: RELAY_KEY, profileSecret: PROFILE_B },
        ),
      ),
    );

    for (const [index, link] of [firstSession, secondSession].entries()) {
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
      expect(
        await genericRefusal(
          await test.handler(
            trustedAppend(
              link,
              {
                body: `substituted session ${index + 1}`,
                idempotencyKey: `block-all-substituted-${index + 1}`,
              },
              PROFILE_B,
            ),
          ),
        ),
      ).toBe(genericBaseline);
      expect(
        test.storage.findLinkSessionByCapabilityHash(
          hashLinkBearer(link.capabilityToken, LINK_KEY),
        ),
      ).toMatchObject({ principalId });
    }

    expect(
      count(test.dbPath, "sync_relay_share_discussion_messages"),
    ).toBe(messagesBeforeBlock);
    expect(discussionUsage(test.dbPath)).toBe(usageBeforeBlock);
    expect(count(test.dbPath, "sync_relay_link_principals")).toBe(
      principalsBeforeBlock,
    );
    expect(test.storage.getShareDiscussionRevision(SHARE)).toBe(revisionAfterBlock);

    const freshSession = {
      ...test.comment,
      capabilityToken: await exchangeLink(test, test.comment.secret),
    };
    const freshAppend = await test.handler(
      trustedAppend(
        freshSession,
        {
          body: "fresh profile after block",
          idempotencyKey: "block-all-fresh-profile",
        },
        PROFILE_B,
      ),
    );
    expect(freshAppend.status).toBe(200);
    await freshAppend.arrayBuffer();
    const freshPrincipalId = test.storage
      .listShareDiscussionMessages({ shareId: SHARE, limit: 100 })
      .messages.find((message) => message.body === "fresh profile after block")!
      .linkPrincipalId;
    expect(freshPrincipalId).not.toBe(principalId);

    const unblocked = await test.handler(
      moderationRequest(OWNER, { action: "unblock", principalId }),
    );
    expect(unblocked.status).toBe(200);
    expect(await body(unblocked)).toEqual({ ok: true, blocked: false });
    const restored = await test.handler(
      trustedAppend(
        firstSession,
        {
          body: "same session restored",
          idempotencyKey: "block-all-restored",
        },
        PROFILE_A,
      ),
    );
    expect(restored.status).toBe(200);
    await restored.arrayBuffer();
    expect(
      test.storage
        .listShareDiscussionMessages({ shareId: SHARE, limit: 100 })
        .messages.find((message) => message.body === "same session restored")!
        .linkPrincipalId,
    ).toBe(principalId);
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
              workspaceId: WORKSPACE,
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
          jsonRequest({ action: "pause", workspaceId: WORKSPACE }),
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
        moderationRequest(OWNER, { action: "pause", ownerUserId: OWNER }),
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

  it("binds every owner moderation mutation to the requested workspace", async () => {
    const test = await fixture();
    for (const suffix of ["delete-missing", "delete-wrong", "delete-correct"]) {
      const response = await test.handler(
        trustedAppend(test.comment, {
          body: `workspace ${suffix}`,
          idempotencyKey: `workspace-${suffix}`,
        }),
      );
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    const seeded = test.storage.listShareDiscussionMessages({
      shareId: SHARE,
      limit: 100,
    }).messages;
    const messageId = (suffix: string): string =>
      seeded.find((message) => message.body === `workspace ${suffix}`)!.messageId;
    const principalId = seeded.find(
      (message) => message.body === "workspace delete-correct",
    )!.linkPrincipalId!;

    const expectMissingWorkspace = async (response: Response): Promise<void> => {
      expectPrivate(response);
      expect(response.status).toBe(400);
      expect(await body(response)).toMatchObject({ ok: false, code: "bad_request" });
    };

    const deleteMessage = vi.spyOn(test.storage, "deleteShareDiscussionMessage");
    await expectMissingWorkspace(
      await test.handler(
        moderationRequest(OWNER, {
          action: "delete",
          messageId: messageId("delete-missing"),
          workspaceId: undefined,
        }),
      ),
    );
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(
      test.storage.listShareDiscussionMessages({ shareId: SHARE, limit: 100 })
        .messages.find(
          (message) => message.messageId === messageId("delete-missing"),
        ),
    ).toMatchObject({ deletedAtMs: null });

    expect(
      await genericRefusal(
        await test.handler(
          moderationRequest(OWNER, {
            action: "delete",
            messageId: messageId("delete-wrong"),
            workspaceId: OTHER_WORKSPACE,
          }),
        ),
      ),
    ).toContain('"code":"not_found"');
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(
      test.storage.listShareDiscussionMessages({ shareId: SHARE, limit: 100 })
        .messages.find(
          (message) => message.messageId === messageId("delete-wrong"),
        ),
    ).toMatchObject({ deletedAtMs: null });

    const deleted = await test.handler(
      moderationRequest(OWNER, {
        action: "delete",
        messageId: messageId("delete-correct"),
        workspaceId: WORKSPACE,
      }),
    );
    expect(deleted.status).toBe(200);
    await deleted.arrayBuffer();
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(
      test.storage.listShareDiscussionMessages({ shareId: SHARE, limit: 100 })
        .messages.find(
          (message) => message.messageId === messageId("delete-correct"),
        ),
    ).toMatchObject({ deletedAtMs: expect.any(Number) });

    const setBlocked = vi.spyOn(test.storage, "setLinkPrincipalBlocked");
    await expectMissingWorkspace(
      await test.handler(
        moderationRequest(OWNER, {
          action: "block",
          principalId,
          workspaceId: undefined,
        }),
      ),
    );
    expect(setBlocked).not.toHaveBeenCalled();
    expect(test.storage.getLinkPrincipal(principalId)).toMatchObject({
      blockedAtMs: null,
    });

    expect(
      await genericRefusal(
        await test.handler(
          moderationRequest(OWNER, {
            action: "block",
            principalId,
            workspaceId: OTHER_WORKSPACE,
          }),
        ),
      ),
    ).toContain('"code":"not_found"');
    expect(setBlocked).not.toHaveBeenCalled();
    expect(test.storage.getLinkPrincipal(principalId)).toMatchObject({
      blockedAtMs: null,
    });

    const blocked = await test.handler(
      moderationRequest(OWNER, {
        action: "block",
        principalId,
        workspaceId: WORKSPACE,
      }),
    );
    expect(blocked.status).toBe(200);
    await blocked.arrayBuffer();
    expect(setBlocked).toHaveBeenCalledTimes(1);
    expect(test.storage.getLinkPrincipal(principalId)?.blockedAtMs).not.toBeNull();

    setBlocked.mockClear();
    await expectMissingWorkspace(
      await test.handler(
        moderationRequest(OWNER, {
          action: "unblock",
          principalId,
          workspaceId: undefined,
        }),
      ),
    );
    expect(setBlocked).not.toHaveBeenCalled();
    expect(test.storage.getLinkPrincipal(principalId)?.blockedAtMs).not.toBeNull();

    expect(
      await genericRefusal(
        await test.handler(
          moderationRequest(OWNER, {
            action: "unblock",
            principalId,
            workspaceId: OTHER_WORKSPACE,
          }),
        ),
      ),
    ).toContain('"code":"not_found"');
    expect(setBlocked).not.toHaveBeenCalled();
    expect(test.storage.getLinkPrincipal(principalId)?.blockedAtMs).not.toBeNull();

    const unblocked = await test.handler(
      moderationRequest(OWNER, {
        action: "unblock",
        principalId,
        workspaceId: WORKSPACE,
      }),
    );
    expect(unblocked.status).toBe(200);
    await unblocked.arrayBuffer();
    expect(setBlocked).toHaveBeenCalledTimes(1);
    expect(test.storage.getLinkPrincipal(principalId)).toMatchObject({
      blockedAtMs: null,
    });

    const setPaused = vi.spyOn(test.storage, "setShareLinkWritesPaused");
    await expectMissingWorkspace(
      await test.handler(
        moderationRequest(OWNER, { action: "pause", workspaceId: undefined }),
      ),
    );
    expect(setPaused).not.toHaveBeenCalled();
    expect(test.storage.getShareLinkWritesPausedAtMs(SHARE)).toBeNull();

    expect(
      await genericRefusal(
        await test.handler(
          moderationRequest(OWNER, {
            action: "pause",
            workspaceId: OTHER_WORKSPACE,
          }),
        ),
      ),
    ).toContain('"code":"not_found"');
    expect(setPaused).not.toHaveBeenCalled();
    expect(test.storage.getShareLinkWritesPausedAtMs(SHARE)).toBeNull();

    const paused = await test.handler(
      moderationRequest(OWNER, { action: "pause", workspaceId: WORKSPACE }),
    );
    expect(paused.status).toBe(200);
    await paused.arrayBuffer();
    expect(setPaused).toHaveBeenCalledTimes(1);
    expect(test.storage.getShareLinkWritesPausedAtMs(SHARE)).not.toBeNull();

    setPaused.mockClear();
    await expectMissingWorkspace(
      await test.handler(
        moderationRequest(OWNER, { action: "resume", workspaceId: undefined }),
      ),
    );
    expect(setPaused).not.toHaveBeenCalled();
    expect(test.storage.getShareLinkWritesPausedAtMs(SHARE)).not.toBeNull();

    expect(
      await genericRefusal(
        await test.handler(
          moderationRequest(OWNER, {
            action: "resume",
            workspaceId: OTHER_WORKSPACE,
          }),
        ),
      ),
    ).toContain('"code":"not_found"');
    expect(setPaused).not.toHaveBeenCalled();
    expect(test.storage.getShareLinkWritesPausedAtMs(SHARE)).not.toBeNull();

    const resumed = await test.handler(
      moderationRequest(OWNER, { action: "resume", workspaceId: WORKSPACE }),
    );
    expect(resumed.status).toBe(200);
    await resumed.arrayBuffer();
    expect(setPaused).toHaveBeenCalledTimes(1);
    expect(test.storage.getShareLinkWritesPausedAtMs(SHARE)).toBeNull();
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

  it("rechecks the requested workspace inside every moderation transaction", async () => {
    for (const transition of ["delete", "block", "pause"] as const) {
      const test = await fixture();
      const seeded = await test.handler(
        trustedAppend(test.comment, {
          body: `workspace-race-${transition}`,
          claimedName: "Workspace Race",
          idempotencyKey: `workspace-race-${transition}`,
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
          updateShareWorkspace(test.dbPath, OTHER_WORKSPACE);
          return original(input);
        };
      } else if (transition === "block") {
        const original = test.storage.setLinkPrincipalBlocked.bind(test.storage);
        test.storage.setLinkPrincipalBlocked = (input) => {
          updateShareWorkspace(test.dbPath, OTHER_WORKSPACE);
          return original(input);
        };
      } else {
        const original = test.storage.setShareLinkWritesPaused.bind(test.storage);
        test.storage.setShareLinkWritesPaused = (input) => {
          updateShareWorkspace(test.dbPath, OTHER_WORKSPACE);
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
        body: `workspace-race-${transition}`,
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
      "rate-limit",
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
        activityRevision: 0,
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

  it("maps every durable accountless discussion limit to one private refusal", async () => {
    const test = await fixture();
    const invalidKey = await test.handler(
      linkRequest(
        test.comment,
        "/sync/link/discussion",
        jsonRequest({ body: "baseline", idempotencyKey: "limit-baseline" }),
        { relayKey: "wrong-key", profileSecret: PROFILE_A },
      ),
    );
    expectPrivate(invalidKey);
    expect(invalidKey.status).toBe(404);
    const invalidKeyBytes = `${invalidKey.status}:${await invalidKey.text()}`;

    const original = test.storage.appendLinkDiscussionMessage.bind(test.storage);
    const durableLimitBytes: string[] = [];
    for (const reason of [
      "principal-limit",
      "lifetime-limit",
      "share-limit",
    ] as const) {
      test.storage.appendLinkDiscussionMessage = () => ({ ok: false, reason });
      const response = await test.handler(
        trustedAppend(test.comment, {
          body: `valid trusted ${reason}`,
          idempotencyKey: `limit-${reason}`,
        }),
      );
      expectPrivate(response);
      expect(response.status, reason).toBe(413);
      const serialized = await response.text();
      expect(JSON.parse(serialized), reason).toEqual({
        ok: false,
        error: "discussion message limit reached",
        code: "discussion_limit_reached",
      });
      durableLimitBytes.push(`${response.status}:${serialized}`);
    }
    test.storage.appendLinkDiscussionMessage = original;

    expect(new Set(durableLimitBytes).size).toBe(1);
    expect(durableLimitBytes[0]).not.toBe(invalidKeyBytes);
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
          body: "trusted blocked while paused",
          idempotencyKey: "trusted-blocked-while-paused",
        }),
      ),
      "blocked",
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
