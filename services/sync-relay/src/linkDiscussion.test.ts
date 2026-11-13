import {linkRefusalBody} from "@dohc/security-contract/link-refusal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashLinkBearer } from "./linkSecurity";
import { DiscussionActivityHub } from "./discussionActivity";
import {
  type SyncRelayHandler,
} from "./server";
import type { OpenSyncRelayStorageOptions, SyncRelayStorage } from "./storage";
import {
  seedDependentGrant,
  linkWritesPausedAtMs,
  closeTestStorage,
  closeTestStorages,
  countRows as count,
  inspect,
  inspectDatabase,
  json as body,
  jsonBody as jsonRequest,
  reopenTestStorage,
  request as rawRequest,
  seedLinkGrant,
  seedLinkSession,
  storagePath,
  testHandler,
  testStorage,
} from "./testing";

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

  const view = seedDiscussionLink(storage, "view", "view", "a", "d", 1_010);
  const comment = seedDiscussionLink(storage, "comment", "comment", "b", "e", 1_010);
  const edit = seedDiscussionLink(storage, "edit", "edit", "c", "f", 1_010);
  expect(
    seedDependentGrant(storage, {
      shareId: SHARE,
      parentGrantId: view.grantId,
      grantId: "named-view-grant-sentinel",
      principalUserId: VIEWER,
      createdAtMs: 1_020,
    }),
  ).toMatchObject({ ok: true, grant: { access: "view" } });
  expect(
    seedDependentGrant(storage, {
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
    testHandler(targetStorage, {
      discussionActivity,
      resolveUserIdByEmail: undefined,
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

function seedDiscussionLink(
  storage: SyncRelayStorage,
  access: LinkFixture["access"],
  suffix: string,
  secretCharacter: string,
  capabilityCharacter: string,
  createdAtMs: number,
): LinkFixture {
  const grantId = `link-${suffix}-grant-sentinel`;
  const linkSecret = secret(secretCharacter);
  const capabilityToken = secret(capabilityCharacter);
  seedLinkGrant(storage, {
    grantId,
    shareId: SHARE,
    access,
    createdAtMs,
    credentialId: `credential-${suffix}-sentinel`,
    secretSealed: null, secretHash: hashLinkBearer(linkSecret, LINK_KEY),
  });
  seedLinkSession(storage, {
    grantId,
    capabilityHash: hashLinkBearer(capabilityToken, LINK_KEY),
    sessionId: `session-${suffix}-sentinel`,
    mintedAtMs: createdAtMs + 1,
  });
  return { access, grantId, secret: linkSecret, capabilityToken };
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

function discussionUsage(dbPath: string): number {
  return inspect(dbPath, (db) => {
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
  });
}

function workspaceUsage(dbPath: string, workspaceId: string): number {
  return inspect(dbPath, (db) => {
    return Number(
      db
        .prepare(
          "SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id = ?",
        )
        .get(workspaceId)?.usage_bytes ?? 0,
    );
  });
}

function discussionIdempotencyRows(
  dbPath: string,
  actorUserId: string,
  idempotencyKey: string,
): number {
  return inspect(dbPath, (db) =>
    Number(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sync_relay_share_discussion_messages
           WHERE share_id = ?
             AND author_user_id = ?
             AND idempotency_key = ?`,
        )
        .get(SHARE, actorUserId, idempotencyKey)?.count ?? 0,
    ),
  );
}

function updateWorkspaceOwner(dbPath: string, ownerUserId: string): void {
  const db = inspectDatabase(dbPath);
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
  const db = inspectDatabase(dbPath);
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
  const db = inspectDatabase(dbPath);
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
  seedLinkGrant(storage, {
    grantId,
    shareId,
    access: "comment",
    createdAtMs: 2_001,
    credentialId: "cross-share-credential-sentinel",
    secretSealed: null, secretHash: "cross-share-secret-hash",
  });
  seedLinkSession(storage, {
    grantId,
    capabilityHash: hashLinkBearer(capabilityToken, LINK_KEY),
    sessionId: "cross-share-session-sentinel",
    mintedAtMs: 2_002,
  });
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
    expect(viewWrite.status).toBe(403);
    expect(await viewWrite.json()).toEqual(linkRefusalBody("link_view_access"));
    expect(count(test.dbPath, "sync_relay_share_discussion_messages")).toBe(
      rowsBefore,
    );
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
    expect(linkWritesPausedAtMs(storagePath(test.storage), SHARE)).toBeNull();
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
    expect(linkWritesPausedAtMs(storagePath(test.storage), SHARE)).toBeNull();
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
      expect(linkWritesPausedAtMs(storagePath(test.storage), SHARE)).toBeNull();
      expect(discussionUsage(test.dbPath)).toBe(beforeUsage);
    }
  });

});
