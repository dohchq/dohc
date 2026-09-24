import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import { SHARE_DISCUSSION_NAME_CODE_POINT_LIMIT } from "@dohc/security-contract/share-discussion";
import {
  NOTICE_DISMISSED_RETENTION_MS,
  NOTICE_LIST_ROW_LIMIT,
  NOTICE_READ_RETENTION_MS,
  NOTICE_SENDER_LABEL_MAX_CHARS,
  NOTICE_UNREAD_RETENTION_MS,
  type PostNoticeRequest,
  type RelayNotice,
  type RelayNoticePage,
} from "@dohc/workspace-contracts/relay";
import { NOTICE_REMOVED_RETENTION_MS, NOTICE_REMOVED_ROW_LIMIT, NOTICE_ROWS_PER_SENDER } from "./storage/limits";
import type { SyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";
import { noticeReachReads, type PostNoticeInput } from "./storage/notices";
import type { StorageContext } from "./storage/context";
import { readCurrentShareGrant } from "./storage/currentShareGrant";
import { authorizeShareGrantAction } from "./shareAuthorization";
import {
  claimWorkspace,
  closeTestStorage,
  closeTestStorages,
  countRows,
  countStorageCalls,
  createShare,
  inspect,
  inspectDatabase,
  json,
  jsonBody,
  reopenTestStorage,
  request,
  seedDependentGrant,
  seedLinkGrant,
  sha256,
  storagePath,
  testHandler,
  testStorage,
  type HandlerOverrides,
} from "./testing";

afterEach(closeTestStorages);

const WORKSPACE = "workspace-trip";

let clock = 10_000;

async function relay(
  overrides: HandlerOverrides = {},
): Promise<{ h: SyncRelayHandler; storage: SyncRelayStorage }> {
  clock = 10_000;
  const storage = await testStorage();
  const h = testHandler(storage, {
    nowMs: () => clock,
    lookupUserDisplayName: (userId) => `Name ${userId}`,
    ...overrides,
  });
  await claimWorkspace(h, "owner", WORKSPACE);
  return { h, storage };
}

// Trip is shared with Ana by name as share-0.
async function sharedTrip(overrides: HandlerOverrides = {}) {
  const setup = await relay(overrides);
  const shareId = await createShare(setup.h, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
  return { ...setup, shareId };
}

function notice(overrides: Partial<PostNoticeRequest> = {}): PostNoticeRequest {
  return {
    noticeId: "automation-failed:run-1",
    recipientUserId: "owner",
    workspaceId: WORKSPACE,
    kind: "automation-failed",
    title: "Stamp the finish date failed",
    body: "Finished on is not a date field.",
    target: { path: "trip/tasks", automation: "finished-date" },
    originInstallId: "install-a",
    ...overrides,
  } as PostNoticeRequest;
}

// A self notice posted straight to storage, past the rate limiter.
function stored(storage: SyncRelayStorage, userId: string, noticeId: string, at = clock): void {
  const input: PostNoticeInput = {
    noticeId,
    recipientUserId: userId,
    reach: { workspaceId: WORKSPACE },
    kind: "mention",
    title: "Mentioned",
    body: "",
    target: {},
    originInstallId: "install-a",
    senderUserId: userId,
    senderLabel: "Self",
    nowMs: at,
  };
  storage.postNotice(input);
}

async function post(h: SyncRelayHandler, sender: string, body: PostNoticeRequest): Promise<Response> {
  return h(request(sender, "/sync/notices", jsonBody(body)));
}

async function pull(h: SyncRelayHandler, userId: string, cursor?: string, limit?: number): Promise<RelayNoticePage> {
  const query = new URLSearchParams({
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit: String(limit) }),
  });
  const response = await h(request(userId, `/sync/notices?${query}`));
  expect(response.status, await response.clone().text()).toBe(200);
  const { ok, ...page } = (await response.json()) as RelayNoticePage & { ok: true };
  expect(ok).toBe(true);
  return page;
}

// Every row in the list, following pages.
async function pullAll(h: SyncRelayHandler, userId: string): Promise<RelayNotice[]> {
  const rows: RelayNotice[] = [];
  for (let cursor: string | undefined, more = true; more;) {
    const page = await pull(h, userId, cursor, 200);
    rows.push(...page.notices);
    cursor = page.nextCursor;
    more = page.hasMore;
  }
  return rows;
}

async function mark(
  h: SyncRelayHandler,
  userId: string,
  marks: { noticeId: string; mark: "read" | "dismissed" }[],
): Promise<void> {
  const response = await h(request(userId, "/sync/notices/marks", jsonBody({ marks })));
  expect(response.status, await response.clone().text()).toBe(200);
}

async function expectRefused(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  expect(await json(response)).toMatchObject({ ok: false, code: "notice_refused" });
}

async function expectRateLimited(response: Response): Promise<void> {
  expect(response.status).toBe(429);
  expect(await json(response)).toMatchObject({ ok: false, code: "notice_rate_limited" });
}

describe("notice list", () => {
  it("posts to your own list and serves it to your other computers", async () => {
    const { h } = await relay();
    const own = notice({ kind: "agent-run", noticeId: "agent-run:1", title: "Your agent finished", target: {} });

    const posted = await post(h, "owner", own);
    expect(posted.status, await posted.clone().text()).toBe(200);

    expect(await pull(h, "owner")).toEqual({
      notices: [{
        noticeId: "agent-run:1",
        changeSeq: 1,
        workspaceId: WORKSPACE,
        recipientShareId: null,
        kind: "agent-run",
        senderKind: "agent",
        senderUserId: "owner",
        senderLabel: "Name owner",
        title: "Your agent finished",
        body: own.body,
        target: {},
        originInstallId: "install-a",
        createdAtMs: 10_000,
        readAtMs: null,
        dismissedAtMs: null,
        removed: false,
      }],
      nextCursor: "1",
      hasMore: false,
      replace: true,
    });
    expect((await pull(h, "someone-else")).notices).toEqual([]);
  });

  it("keeps the first post of a notice id and ignores the second", async () => {
    const { h, storage } = await relay();
    const first = notice({ kind: "mention", noticeId: "mention:workspace-trip:m1", title: "Ana mentioned you" });
    expect((await post(h, "owner", first)).status).toBe(200);
    clock += 1;
    expect((await post(h, "owner", { ...first, title: "Changed" })).status).toBe(200);

    const page = await pull(h, "owner");
    expect(page.notices.map((row) => [row.title, row.changeSeq])).toEqual([["Ana mentioned you", 1]]);
    expect(countRows(storagePath(storage), "sync_relay_notices")).toBe(1);
  });

  it("keeps a share you post to yourself in the share, never a workspace id", async () => {
    const { h } = await sharedTrip();
    const response = await post(h, "ana", notice({
      kind: "agent-run", noticeId: "agent-run:1", recipientUserId: "ana",
      workspaceId: undefined, shareId: "share-0", target: { path: "trip/day-1" },
    }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await pull(h, "ana")).notices[0]).toMatchObject({
      workspaceId: null, recipientShareId: "share-0", target: { path: "trip/day-1" },
    });
  });

  it("refuses a notice to yourself through a share you do not hold", async () => {
    const { h, storage, shareId } = await sharedTrip();
    const benShare = await createShare(h, "owner", WORKSPACE, { paths: ["budget"], recipientUserId: "ben" });
    const toSelf = (share: string, noticeId: string) =>
      notice({ kind: "agent-run", recipientUserId: "ana", workspaceId: undefined, shareId: share, noticeId });

    await expectRefused(await post(h, "ana", toSelf(benShare, "probe")));
    await expectRefused(await post(h, "ana", toSelf("share-none", "missing")));
    expect((await post(h, "ana", toSelf(shareId, "own"))).status).toBe(200);
    // A person who opened a public link holds a grant too.
    seedLinkGrant(storage, { grantId: "link-1", shareId: benShare, secretHash: sha256("secret") });
    seedDependentGrant(storage, {
      shareId: benShare, parentGrantId: "link-1", grantId: "from-link-lee", principalUserId: "lee", createdAtMs: clock,
    });
    expect((await post(h, "lee", notice({
      kind: "agent-run", recipientUserId: "lee", workspaceId: undefined, shareId: benShare,
    }))).status).toBe(200);

    expect(storage.revokeShare(shareId, clock)).toBe(true);
    await expectRefused(await post(h, "ana", toSelf(shareId, "after")));
    expect((await pull(h, "ana")).notices.map((row) => row.noticeId)).toEqual(["own"]);
  });

  it("requires a bearer credential and refuses browser cookies", async () => {
    const { h } = await relay();
    expect((await h(request(null, "/sync/notices"))).status).toBe(404);
    const withCookie = request("owner", "/sync/notices", { headers: { cookie: "session=1" } });
    expect((await h(withCookie)).status).toBe(404);
    expect((await h(request("owner", "/sync/notices", { method: "PUT" }))).status).toBe(405);
  });

  it("reserves notices as a workspace id", async () => {
    const { h } = await relay();
    const response = await h(request("owner", "/sync/workspaces", jsonBody({ workspaceId: "notices" })));
    expect(response.status).toBe(400);
  });

  it("uses the relay's display-name limit for sender labels", () => {
    expect(NOTICE_SENDER_LABEL_MAX_CHARS).toBe(SHARE_DISCUSSION_NAME_CODE_POINT_LIMIT);
  });
});

describe("notices for someone else", () => {
  it("lets the owner send to a grantee and never shows the grantee the workspace id", async () => {
    const { h, shareId } = await sharedTrip();
    expect((await post(h, "owner", notice({ recipientUserId: "ana" }))).status).toBe(200);

    const [row] = (await pull(h, "ana")).notices;
    expect(row).toMatchObject({
      noticeId: "from:owner:automation-failed:run-1",
      workspaceId: null,
      recipientShareId: shareId,
      senderUserId: "owner",
      senderLabel: "Name owner",
      senderKind: "automation",
      target: { path: "trip/tasks", automation: "finished-date" },
    });
    expect((await pull(h, "owner")).notices).toEqual([]);
  });

  it("lets a grantee send to the owner through the share", async () => {
    const { h, shareId } = await sharedTrip();
    const fromAna = notice({ workspaceId: undefined, shareId });
    expect((await post(h, "ana", fromAna)).status).toBe(200);

    const [row] = (await pull(h, "owner")).notices;
    expect(row).toMatchObject({
      noticeId: "from:ana:automation-failed:run-1",
      senderUserId: "ana",
      senderLabel: "Name ana",
      workspaceId: WORKSPACE,
      recipientShareId: null,
    });
    // A grantee cannot name the owner's workspace.
    await expectRefused(await post(h, "ana", notice()));
  });

  it("lets one grantee send to another when both can read the target", async () => {
    const { h } = await sharedTrip();
    const benShare = await createShare(h, "owner", WORKSPACE, { paths: ["trip/tasks"], recipientUserId: "ben" });
    const response = await post(h, "ana", notice({ recipientUserId: "ben", workspaceId: undefined, shareId: "share-0" }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await pull(h, "ben")).notices[0]).toMatchObject({ workspaceId: null, recipientShareId: benShare });
  });

  it("refuses when either person cannot read the target", async () => {
    const { h, storage, shareId } = await sharedTrip();
    await createShare(h, "owner", WORKSPACE, { paths: ["budget"], recipientUserId: "ben" });
    const viaShare = { workspaceId: undefined, shareId };

    // The grantee cannot read the owner's private folder, in either direction.
    await expectRefused(await post(h, "owner", notice({ recipientUserId: "ana", target: { path: "budget/q3" } })));
    await expectRefused(await post(h, "ana", notice({ ...viaShare, target: { path: "budget/q3" } })));
    // Ben reads budget but not trip.
    await expectRefused(await post(h, "ana", notice({ ...viaShare, recipientUserId: "ben" })));
    // A stranger, to or from the owner, and a share that does not exist.
    await expectRefused(await post(h, "stranger", notice()));
    await expectRefused(await post(h, "stranger", notice(viaShare)));
    await expectRefused(await post(h, "owner", notice({ recipientUserId: "stranger" })));
    await expectRefused(await post(h, "ana", notice({ workspaceId: undefined, shareId: "share-none" })));
    // No path to check, a path spelled another way, or a kind only its sender receives.
    await expectRefused(await post(h, "owner", notice({ recipientUserId: "ana", target: {} })));
    await expectRefused(await post(h, "owner", notice({ recipientUserId: "ana", target: { path: "trip/../trip/tasks" } })));
    await expectRefused(await post(h, "owner", notice({ recipientUserId: "ana", kind: "agent-run" })));

    // A revoked grant reads nothing.
    expect(storage.revokeShare(shareId, clock)).toBe(true);
    await expectRefused(await post(h, "owner", notice({ recipientUserId: "ana" })));
    await expectRefused(await post(h, "ana", notice(viaShare)));

    expect(countRows(storagePath(storage), "sync_relay_notices")).toBe(0);
  });

  it("does not count a share of another version", async () => {
    const { h } = await relay();
    await createShare(h, "owner", WORKSPACE, { paths: ["trip"], versionId: "draft", recipientUserId: "ana" });
    await expectRefused(await post(h, "owner", notice({ recipientUserId: "ana" })));
  });

  it("lets a person who opened a public link receive notices but not send them", async () => {
    const { h, storage, shareId } = await sharedTrip();
    seedLinkGrant(storage, { grantId: "link-1", shareId, secretHash: sha256("secret"), access: "edit" });
    expect(seedDependentGrant(storage, {
      shareId, parentGrantId: "link-1", grantId: "from-link-lee", principalUserId: "lee", createdAtMs: clock,
    }).ok).toBe(true);

    await expectRefused(await post(h, "lee", notice({ workspaceId: undefined, shareId })));
    await expectRefused(await post(h, "lee", notice({ workspaceId: undefined, shareId, recipientUserId: "ana" })));
    expect((await post(h, "owner", notice({ recipientUserId: "lee" }))).status).toBe(200);
    expect((await pull(h, "lee")).notices).toHaveLength(1);
    // Posting to yourself always works.
    expect((await post(h, "lee", notice({ kind: "agent-run", recipientUserId: "lee" }))).status).toBe(200);
  });

  it("scopes a notice id to its sender", async () => {
    const { h } = await sharedTrip();
    await createShare(h, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ben" });
    const shared = notice({ recipientUserId: "ana", noticeId: "automation-failed:x" });

    // Ben posts first, as if to take the id. The owner's notice still arrives.
    expect((await post(h, "ben", { ...shared, workspaceId: undefined, shareId: "share-1" } as PostNoticeRequest)).status).toBe(200);
    expect((await post(h, "owner", shared)).status).toBe(200);
    expect((await post(h, "ana", notice({ recipientUserId: "ana", noticeId: "automation-failed:x", kind: "mention" }))).status).toBe(200);
    // The owner's second computer posts the same notice once.
    expect((await post(h, "owner", { ...shared, title: "From another computer" })).status).toBe(200);

    const rows = await pullAll(h, "ana");
    expect(rows.map((row) => [row.noticeId, row.senderUserId, row.title]).sort()).toEqual([
      ["automation-failed:x", "ana", "Stamp the finish date failed"],
      ["from:ben:automation-failed:x", "ben", "Stamp the finish date failed"],
      ["from:owner:automation-failed:x", "owner", "Stamp the finish date failed"],
    ]);
    await mark(h, "ana", [{ noticeId: "from:owner:automation-failed:x", mark: "read" }]);
    expect((await pullAll(h, "ana")).find((row) => row.senderUserId === "owner")?.readAtMs).toBe(clock);

    // Nobody can post an id in the sender-scoped form to themselves.
    const squat = await post(h, "ana", notice({ recipientUserId: "ana", kind: "mention", noticeId: "from:owner:y" }));
    expect(squat.status).toBe(400);
  });

  it("keeps notice ids apart for senders whose ids contain a colon", async () => {
    const { h } = await sharedTrip();
    const aShare = await createShare(h, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "a" });
    const abShare = await createShare(h, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "a:b" });
    const toAna = (shareId: string, noticeId: string) =>
      notice({ recipientUserId: "ana", workspaceId: undefined, shareId, noticeId });
    expect((await post(h, "a:b", toAna(abShare, "c"))).status).toBe(200);
    expect((await post(h, "a", toAna(aShare, "b:c"))).status).toBe(200);
    expect((await pullAll(h, "ana")).map((row) => [row.noticeId, row.senderUserId]).sort()).toEqual([
      ["from:a%3Ab:c", "a:b"],
      ["from:a:b:c", "a"],
    ]);
  });

  it("claims pending email grants only for a post to someone else", async () => {
    const setup = await relay();
    const counted = countStorageCalls(setup.storage, "claimPendingSharesForEmail");
    const h = testHandler(counted.storage, { nowMs: () => clock });
    await createShare(h, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
    const before = counted.calls.length;

    await post(h, "owner", notice({ kind: "agent-run" }));
    expect(counted.calls.length).toBe(before);
    await post(h, "owner", notice({ recipientUserId: "ana" }));
    expect(counted.calls.length).toBe(before + 1);
  });
});

describe("limits on notices from other people", () => {
  it("rate-limits posts to other people per sender", async () => {
    const limiter = new TokenBucketLimiter(2, 0.001, 10);
    const { h } = await sharedTrip({ noticePostRateLimiter: limiter });
    const toAna = (id: string) => notice({ recipientUserId: "ana", noticeId: id });
    expect((await post(h, "owner", toAna("a"))).status).toBe(200);
    expect((await post(h, "owner", toAna("b"))).status).toBe(200);
    await expectRateLimited(await post(h, "owner", toAna("c")));
    // Notices to yourself and other senders are not limited by the owner's posts.
    expect((await post(h, "owner", notice({ kind: "agent-run", noticeId: "d" }))).status).toBe(200);
    expect((await post(h, "ana", notice({ workspaceId: undefined, shareId: "share-0", noticeId: "e" }))).status).toBe(200);
  });

  it("keeps a sender to its share of another person's list, removing its own rows first", async () => {
    const { h, storage } = await sharedTrip({
      noticePostRateLimiter: new TokenBucketLimiter(1_000, 1, 10),
    });
    stored(storage, "ana", "ana-own");
    for (let index = 0; index < NOTICE_ROWS_PER_SENDER; index += 1) {
      expect((await post(h, "owner", notice({ recipientUserId: "ana", noticeId: `n${index}` }))).status).toBe(200);
    }
    await mark(h, "ana", [{ noticeId: "from:owner:n5", mark: "read" }]);

    expect((await post(h, "owner", notice({ recipientUserId: "ana", noticeId: "n100" }))).status).toBe(200);
    expect((await post(h, "owner", notice({ recipientUserId: "ana", noticeId: "n101" }))).status).toBe(200);
    const ids = (await pullAll(h, "ana")).map((row) => row.noticeId);
    expect(ids).toHaveLength(NOTICE_ROWS_PER_SENDER + 1);
    expect(ids).toContain("ana-own");
    expect(ids).toContain("from:owner:n101");
    // The read row goes first, then the oldest unread.
    expect(ids).not.toContain("from:owner:n5");
    expect(ids).not.toContain("from:owner:n0");
  });

  it("sends a row removed to make room as an ordinary change", async () => {
    const { h, storage } = await sharedTrip({
      noticePostRateLimiter: new TokenBucketLimiter(1_000, 1, 10),
    });
    for (let index = 0; index < NOTICE_ROWS_PER_SENDER; index += 1) {
      expect((await post(h, "owner", notice({ recipientUserId: "ana", noticeId: `n${index}` }))).status).toBe(200);
    }
    const cursor = (await pull(h, "ana", undefined, 200)).nextCursor;

    expect((await post(h, "owner", notice({ recipientUserId: "ana", noticeId: "n100" }))).status).toBe(200);
    const next = await pull(h, "ana", cursor);
    expect(next.replace).toBe(false);
    expect(next.notices.map((row) => [row.noticeId, row.removed, row.body, row.target])).toEqual([
      ["from:owner:n0", true, "", null],
      ["from:owner:n100", false, "Finished on is not a date field.", { path: "trip/tasks", automation: "finished-date" }],
    ]);
    // A tombstone takes no place in the list and cannot be marked.
    await mark(h, "ana", [{ noticeId: "from:owner:n0", mark: "read" }]);
    expect((await pull(h, "ana", next.nextCursor)).notices).toEqual([]);
    expect((await pullAll(h, "ana")).map((row) => row.noticeId)).not.toContain("from:owner:n0");

    // Once the tombstone expires, only a computer that pulled before it
    // takes the whole list.
    clock += NOTICE_REMOVED_RETENTION_MS;
    stored(storage, "ana", "later");
    expect((await pull(h, "ana", cursor)).replace).toBe(true);
    expect((await pull(h, "ana", next.nextCursor)).replace).toBe(false);
  });

  it("keeps a bounded number of tombstones and starts over only for a cursor older than them", async () => {
    const { h, storage } = await relay();
    for (let index = 0; index < NOTICE_LIST_ROW_LIMIT; index += 1) stored(storage, "owner", `n${index}`, clock + index);
    clock += NOTICE_LIST_ROW_LIMIT;
    // 1,000 posts to a new list leave its head at 1,000.
    const behind = String(NOTICE_LIST_ROW_LIMIT);
    stored(storage, "owner", "extra-0");
    const recent = (await pull(h, "owner", behind)).nextCursor;
    for (let index = 1; index <= NOTICE_REMOVED_ROW_LIMIT; index += 1) stored(storage, "owner", `extra-${index}`);

    const tombstones = inspect(storagePath(storage), (db) => Number(db.prepare(
      "SELECT COUNT(*) AS count FROM sync_relay_notices WHERE removed_at_ms IS NOT NULL",
    ).get()?.count));
    expect(tombstones).toBe(NOTICE_REMOVED_ROW_LIMIT);
    expect((await pull(h, "owner", behind)).replace).toBe(true);
    const fromRecent = await pull(h, "owner", recent, 5);
    expect(fromRecent.replace).toBe(false);
    expect(fromRecent.notices[0]).toMatchObject({ removed: true });
  }, 60_000);

  it("makes room in a list full of read rows for anyone who may send", async () => {
    const { h, storage } = await sharedTrip();
    for (let index = 0; index < NOTICE_LIST_ROW_LIMIT; index += 1) stored(storage, "ana", `own-${index}`, clock + index);
    for (let index = 0; index < NOTICE_LIST_ROW_LIMIT; index += 100) {
      await mark(h, "ana", Array.from({ length: 100 }, (_, offset) => ({ noticeId: `own-${index + offset}`, mark: "read" as const })));
    }
    clock += NOTICE_LIST_ROW_LIMIT;

    expect((await post(h, "owner", notice({ recipientUserId: "ana" }))).status).toBe(200);
    const ids = (await pullAll(h, "ana")).map((row) => row.noticeId);
    expect(ids).toHaveLength(NOTICE_LIST_ROW_LIMIT);
    expect(ids).toContain("from:owner:automation-failed:run-1");
    expect(ids).not.toContain("own-0");
    expect(ids).toContain("own-1");
  });

  it("refuses a sender when only other senders' unread rows could make room", async () => {
    const { h, storage } = await sharedTrip();
    for (let index = 0; index < NOTICE_LIST_ROW_LIMIT; index += 1) stored(storage, "ana", `own-${index}`, clock + index);
    clock += NOTICE_LIST_ROW_LIMIT;

    const refused = await post(h, "owner", notice({ recipientUserId: "ana" }));
    expect(refused.status).toBe(409);
    expect(await json(refused)).toMatchObject({ ok: false, code: "notice_list_full" });
    expect(countRows(storagePath(storage), "sync_relay_notices")).toBe(NOTICE_LIST_ROW_LIMIT);

    // Ana's own notice still makes room, oldest first.
    expect((await post(h, "ana", notice({ recipientUserId: "ana", kind: "mention", noticeId: "own-new" }))).status).toBe(200);
    const ids = (await pullAll(h, "ana")).map((row) => row.noticeId);
    expect(ids).toHaveLength(NOTICE_LIST_ROW_LIMIT);
    expect(ids).not.toContain("own-0");
    expect(ids).toContain("own-new");
  });

  it("removes read and dismissed rows before unread ones when your own notice needs room", async () => {
    const { h, storage } = await relay();
    for (let index = 0; index < NOTICE_LIST_ROW_LIMIT; index += 1) stored(storage, "owner", `n${index}`, clock + index);
    await mark(h, "owner", [{ noticeId: "n500", mark: "read" }, { noticeId: "n700", mark: "dismissed" }]);
    clock += NOTICE_LIST_ROW_LIMIT;
    for (const id of ["newest", "newer still", "last"]) {
      await post(h, "owner", notice({ kind: "mention", noticeId: id }));
    }

    // Each post takes one row: the two marked rows, then the oldest unread.
    const live = (await pullAll(h, "owner")).map((row) => row.noticeId);
    expect(live).toHaveLength(NOTICE_LIST_ROW_LIMIT);
    const ids = new Set(live);
    expect(["n500", "n700", "n0"].filter((id) => ids.has(id))).toEqual([]);
    expect(["n1", "newest", "newer still", "last"].every((id) => ids.has(id))).toBe(true);
  });
});

describe("pulling changes", () => {
  it("serves read and dismissed as new changes after the cursor", async () => {
    const { h } = await relay();
    for (const id of ["a", "b", "c"]) {
      await post(h, "owner", notice({ kind: "mention", noticeId: id }));
    }
    const first = await pull(h, "owner");
    expect(first.notices.map((row) => [row.noticeId, row.changeSeq])).toEqual([["a", 1], ["b", 2], ["c", 3]]);

    clock = 20_000;
    await mark(h, "owner", [
      { noticeId: "a", mark: "read" },
      { noticeId: "b", mark: "dismissed" },
      { noticeId: "missing", mark: "read" },
    ]);
    const changes = await pull(h, "owner", first.nextCursor);
    expect(changes.replace).toBe(false);
    expect(changes.notices.map((row) => [row.noticeId, row.changeSeq, row.readAtMs, row.dismissedAtMs]))
      .toEqual([["a", 4, 20_000, null], ["b", 5, null, 20_000]]);
    expect(changes.nextCursor).toBe("5");

    // The flags go one way: nothing changes a second time.
    clock = 30_000;
    await mark(h, "owner", [
      { noticeId: "a", mark: "read" },
      { noticeId: "b", mark: "read" },
      { noticeId: "b", mark: "dismissed" },
    ]);
    expect(await pull(h, "owner", changes.nextCursor)).toEqual({ notices: [], nextCursor: "5", hasMore: false, replace: false });

    // Dismissing a read row is still a change.
    await mark(h, "owner", [{ noticeId: "a", mark: "dismissed" }]);
    const last = await pull(h, "owner", "5");
    expect(last.notices.map((row) => [row.noticeId, row.readAtMs, row.dismissedAtMs])).toEqual([["a", 20_000, 30_000]]);
  });

  it("marks only the caller's own rows", async () => {
    const { h } = await relay();
    await post(h, "owner", notice({ kind: "mention", noticeId: "a" }));
    await mark(h, "ana", [{ noticeId: "a", mark: "dismissed" }]);
    expect((await pull(h, "owner")).notices[0]?.dismissedAtMs).toBeNull();
  });

  it("pages by change", async () => {
    const { h } = await relay();
    for (const id of ["a", "b", "c"]) {
      await post(h, "owner", notice({ kind: "mention", noticeId: id }));
    }
    const page = await pull(h, "owner", undefined, 2);
    expect(page.notices.map((row) => row.noticeId)).toEqual(["a", "b"]);
    expect(page).toMatchObject({ nextCursor: "2.3", hasMore: true, replace: true });
    const rest = await pull(h, "owner", page.nextCursor, 2);
    expect(rest.notices.map((row) => row.noticeId)).toEqual(["c"]);
    expect(rest).toMatchObject({ nextCursor: "3", hasMore: false, replace: false });
  });

  it("gives the whole list to a cursor that missed a removal or came from another history", async () => {
    const { h, storage } = await relay();
    for (const id of ["a", "b", "c"]) stored(storage, "owner", id);
    const behind = (await pull(h, "owner")).nextCursor;
    await mark(h, "owner", [{ noticeId: "b", mark: "dismissed" }]);
    const current = (await pull(h, "owner", behind)).nextCursor;

    // The dismissed row expires. A computer that pulled after the dismissal
    // already dropped it; one that did not takes the whole list.
    clock += NOTICE_DISMISSED_RETENTION_MS;
    expect(await pull(h, "owner", current)).toMatchObject({ notices: [], replace: false });
    const snapshot = await pull(h, "owner", behind);
    expect(snapshot.replace).toBe(true);
    expect(snapshot.notices.map((row) => row.noticeId)).toEqual(["a", "c"]);
    expect(snapshot.nextCursor).toBe(current);

    // The same holds once a post has swept the row away.
    stored(storage, "owner", "d");
    expect(countRows(storagePath(storage), "sync_relay_notices")).toBe(3);
    expect((await pull(h, "owner", behind)).replace).toBe(true);
    expect((await pull(h, "owner", current)).replace).toBe(false);

    const fromAnotherHistory = await pull(h, "owner", "50");
    expect(fromAnotherHistory.replace).toBe(true);
    expect(fromAnotherHistory.notices.map((row) => row.noticeId)).toEqual(["a", "c", "d"]);
  });

  it("finishes a whole-list pull over several pages and restarts it only for a removal during it", async () => {
    const { h, storage } = await relay();
    for (let index = 0; index < 5; index += 1) stored(storage, "owner", `n${index}`);
    await mark(h, "owner", [{ noticeId: "n4", mark: "dismissed" }]);
    clock += NOTICE_DISMISSED_RETENTION_MS;
    stored(storage, "owner", "n5");

    // A cursor from before the removal takes the whole list, page by page.
    const pages: RelayNoticePage[] = [await pull(h, "owner", "2", 2)];
    while (pages.at(-1)!.hasMore) pages.push(await pull(h, "owner", pages.at(-1)!.nextCursor, 2));
    expect(pages.map((page) => [page.replace, page.notices.map((row) => row.noticeId)])).toEqual([
      [true, ["n0", "n1"]],
      [false, ["n2", "n3"]],
      [false, ["n5"]],
    ]);
    expect(pages.at(-1)!.nextCursor).toBe("7");

    // A row removed while a whole-list pull is under way starts it over.
    const first = await pull(h, "owner", "1", 2);
    await mark(h, "owner", [{ noticeId: "n0", mark: "dismissed" }]);
    clock += NOTICE_DISMISSED_RETENTION_MS;
    stored(storage, "owner", "n6");
    const restarted = await pull(h, "owner", first.nextCursor, 2);
    expect(restarted.replace).toBe(true);
    expect(restarted.notices.map((row) => row.noticeId)).toEqual(["n1", "n2"]);
  });

  it("starts an interrupted whole-list pull over when a tombstone expires before any sweep", async () => {
    const { h } = await sharedTrip({
      noticePostRateLimiter: new TokenBucketLimiter(1_000, 1, 10),
    });
    for (let index = 0; index < NOTICE_ROWS_PER_SENDER; index += 1) {
      expect((await post(h, "owner", notice({ recipientUserId: "ana", noticeId: `n${index}` }))).status).toBe(200);
    }
    // A computer takes the first page of the whole list, then stops.
    const first = await pull(h, "ana", undefined, 1);
    expect(first.notices.map((row) => row.noticeId)).toEqual(["from:owner:n0"]);
    expect(first.nextCursor).toBe(`1.${NOTICE_ROWS_PER_SENDER}`);

    // n0 leaves to make room, and its tombstone expires with no post to
    // sweep it before the computer resumes.
    expect((await post(h, "owner", notice({ recipientUserId: "ana", noticeId: "n100" }))).status).toBe(200);
    clock += NOTICE_REMOVED_RETENTION_MS;
    const resumed = await pull(h, "ana", first.nextCursor, 200);
    expect(resumed.replace).toBe(true);
    expect(resumed.notices.map((row) => row.noticeId)).not.toContain("from:owner:n0");
    expect(resumed.notices).toHaveLength(NOTICE_ROWS_PER_SENDER);
  });

  it("refuses a cursor it did not issue", async () => {
    const { h } = await relay();
    for (const cursor of ["-1", "1.2.3", "abc", "01"]) {
      expect((await h(request("owner", `/sync/notices?cursor=${cursor}`))).status).toBe(400);
    }
  });

  it("keeps the list across a relay restart", async () => {
    const { h, storage } = await relay();
    await post(h, "owner", notice({ kind: "mention", noticeId: "a" }));
    const path = storagePath(storage);
    closeTestStorage(storage);
    const reopened = testHandler(reopenTestStorage(path), { nowMs: () => clock });
    expect((await pull(reopened, "owner")).notices.map((row) => row.noticeId)).toEqual(["a"]);
  });
});

describe("notices after access ends", () => {
  it("moves a notice to another grant that admits it, or drops its target", async () => {
    const { h, storage, shareId } = await sharedTrip();
    const tasksShare = await createShare(h, "owner", WORKSPACE, { paths: ["trip/tasks"], recipientUserId: "ana" });
    await post(h, "owner", notice({ recipientUserId: "ana", noticeId: "tasks", target: { path: "trip/tasks/pack" } }));
    await post(h, "owner", notice({ recipientUserId: "ana", noticeId: "notes", target: { path: "trip/notes" } }));
    const before = await pull(h, "ana");
    expect(before.notices.map((row) => row.recipientShareId)).toEqual([shareId, shareId]);

    expect(storage.revokeShare(shareId, clock)).toBe(true);
    const after = await pull(h, "ana", before.nextCursor);
    expect(after.replace).toBe(false);
    expect(after.notices.map((row) => [row.noticeId, row.recipientShareId, row.target, row.title])).toEqual([
      ["from:owner:tasks", tasksShare, { path: "trip/tasks/pack" }, "Stamp the finish date failed"],
      ["from:owner:notes", shareId, null, "Stamp the finish date failed"],
    ]);
    expect(after.notices.every((row) => row.changeSeq > Number(before.nextCursor))).toBe(true);

    // Nothing changes again until access changes again.
    expect((await pull(h, "ana", after.nextCursor)).notices).toEqual([]);
    expect(storage.revokeShare(tasksShare, clock)).toBe(true);
    const last = await pull(h, "ana", after.nextCursor);
    expect(last.notices.map((row) => [row.noticeId, row.target])).toEqual([["from:owner:tasks", null]]);
  });

  it("checks access again only when the recipient's grants change, once per share", async () => {
    const { h, storage, shareId } = await sharedTrip();
    await post(h, "owner", notice({ recipientUserId: "ana", noticeId: "tasks" }));
    await post(h, "owner", notice({ recipientUserId: "ana", noticeId: "notes", target: { path: "trip/notes" } }));
    const checks = vi.spyOn(storage, "listActiveShareGrantsForRecipient");
    const checksDuring = async (work: () => Promise<unknown>) => {
      const before = checks.mock.calls.length;
      await work();
      return checks.mock.calls.length - before;
    };

    // Both rows come through one share: one check.
    expect(await checksDuring(() => pull(h, "ana"))).toBe(1);
    expect(await checksDuring(() => pull(h, "ana"))).toBe(0);
    expect(await checksDuring(() => pull(h, "ana"))).toBe(0);
    await createShare(h, "owner", WORKSPACE, { paths: ["budget"], recipientUserId: "ana" });
    expect(await checksDuring(() => pull(h, "ana"))).toBe(1);
    expect(await checksDuring(() => pull(h, "ana"))).toBe(0);
    expect((await pull(h, "ana")).notices.map((row) => row.recipientShareId)).toEqual([shareId, shareId]);
  });

  it("skips the access digest for a person with no notice through a share", async () => {
    const { h, storage } = await sharedTrip();
    await post(h, "owner", notice({ kind: "mention", noticeId: "own" }));
    await post(h, "owner", notice({ recipientUserId: "ana" }));
    const digests = vi.spyOn(storage, "listSharesReceivedBy");

    await pull(h, "owner");
    expect(digests).not.toHaveBeenCalled();
    await pull(h, "ana");
    expect(digests).toHaveBeenCalled();

    // Once her only such row is removed, Ana is skipped too.
    await mark(h, "ana", [{ noticeId: "from:owner:automation-failed:run-1", mark: "dismissed" }]);
    clock += NOTICE_DISMISSED_RETENTION_MS;
    stored(storage, "ana", "later");
    digests.mockClear();
    await pull(h, "ana");
    expect(digests).not.toHaveBeenCalled();
  });

  it("checks a notice placed through a share whose grant ends before the next pull", async () => {
    const { h, storage } = await sharedTrip();
    await post(h, "owner", notice({ recipientUserId: "ana", noticeId: "trip" }));
    const cursor = (await pull(h, "ana")).nextCursor;

    // A grant arrives, a notice comes through it, and the grant ends, all
    // between two pulls: Ana's grants look as they did at the last check.
    const budgetShare = await createShare(h, "owner", WORKSPACE, { paths: ["budget"], recipientUserId: "ana" });
    expect((await post(h, "owner", notice({ recipientUserId: "ana", noticeId: "budget", target: { path: "budget/q3" } }))).status).toBe(200);
    expect(storage.revokeShare(budgetShare, clock)).toBe(true);

    const next = await pull(h, "ana", cursor);
    expect(next.notices.map((row) => [row.noticeId, row.target]).at(-1)).toEqual(["from:owner:budget", null]);
  });

  it("checks each other share once when many notices lose access together", async () => {
    const { h, storage, shareId } = await sharedTrip({
      noticePostRateLimiter: new TokenBucketLimiter(1_000, 1, 10),
    });
    const tasksShare = await createShare(h, "owner", WORKSPACE, { paths: ["trip/tasks"], recipientUserId: "ana" });
    for (let index = 0; index < 5; index += 1) {
      await post(h, "owner", notice({ recipientUserId: "ana", noticeId: `n${index}`, target: { path: `trip/tasks/${index}` } }));
    }
    const before = (await pull(h, "ana")).nextCursor;
    expect(storage.revokeShare(shareId, clock)).toBe(true);
    const checks = vi.spyOn(storage, "listActiveShareGrantsForRecipient");

    const after = await pull(h, "ana", before);
    // The lost share once, and the one that admits the paths once.
    expect(checks.mock.calls.map(([share]) => share)).toEqual([shareId, tasksShare]);
    expect(after.notices.map((row) => row.recipientShareId)).toEqual(Array(5).fill(tasksShare));
  });

  it("notices when a link grant's parent moves to another share", async () => {
    const { h, storage, shareId } = await sharedTrip();
    const benShare = await createShare(h, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ben" });
    seedLinkGrant(storage, { grantId: "link-1", shareId, secretHash: sha256("secret"), access: "view" });
    expect(seedDependentGrant(storage, {
      shareId, parentGrantId: "link-1", grantId: "from-link-lee", principalUserId: "lee", createdAtMs: clock,
    }).ok).toBe(true);
    expect((await post(h, "owner", notice({ recipientUserId: "lee" }))).status).toBe(200);
    const before = await pull(h, "lee");
    expect(before.notices[0]).toMatchObject({ recipientShareId: shareId, target: { path: "trip/tasks" } });

    const db = inspectDatabase(storagePath(storage));
    db.prepare("UPDATE sync_relay_share_grants SET share_id = ? WHERE grant_id = 'link-1'").run(benShare);
    db.close();
    const after = await pull(h, "lee", before.nextCursor);
    expect(after.notices.map((row) => [row.noticeId, row.target])).toEqual([["from:owner:automation-failed:run-1", null]]);
  });

  it("digests every read the access check makes", async () => {
    const { h, storage, shareId } = await sharedTrip();
    await createShare(h, "owner", WORKSPACE, { paths: ["trip/tasks"], recipientUserId: "ana" });
    seedLinkGrant(storage, { grantId: "link-1", shareId, secretHash: sha256("secret"), access: "view" });
    seedDependentGrant(storage, {
      shareId, parentGrantId: "link-1", grantId: "from-link-ana", principalUserId: "ana", createdAtMs: clock,
    });
    const context = storage as unknown as StorageContext;
    const recorded = (run: (recording: StorageContext) => unknown): string[] => {
      const reads: string[] = [];
      run(new Proxy(context, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            reads.push(JSON.stringify([String(property), args]));
            return value.apply(target, args);
          };
        },
      }));
      return reads;
    };

    const digested = new Set(noticeReachReads(context, "ana").map((read) => JSON.stringify([read.method, read.args])));
    const grants = storage.listSharesReceivedBy("ana").map(({ grant }) => grant.grantId);
    expect(grants).toHaveLength(3);
    for (const grantId of grants) {
      const principal = { kind: "user" as const, userId: "ana" };
      const checked = [
        ...recorded((recording) => readCurrentShareGrant(recording, { grantId, principal })),
        ...recorded((recording) => authorizeShareGrantAction({ storage: recording, grantId, action: "read", principal })),
      ];
      expect(checked.length).toBeGreaterThan(0);
      expect(checked.filter((read) => !digested.has(read))).toEqual([]);
    }
  });

  it("drops the target of a notice you sent yourself through a share you lost", async () => {
    const { h, storage, shareId } = await sharedTrip();
    await post(h, "ana", notice({
      kind: "agent-run", recipientUserId: "ana", workspaceId: undefined, shareId, target: {},
    }));
    expect(storage.revokeShare(shareId, clock)).toBe(true);
    expect((await pull(h, "ana")).notices[0]).toMatchObject({ recipientShareId: shareId, target: null });
  });
});

describe("notice bounds", () => {
  it("refuses a notice past its limits or in a form the relay would not store", async () => {
    const { h } = await relay();
    const invalid = [
      notice({ title: "t".repeat(121) }),
      notice({ title: "" }),
      notice({ title: " padded" }),
      notice({ title: "two\nlines" }),
      notice({ body: "b".repeat(501) }),
      notice({ body: "a\u0000b" }),
      notice({ body: "carriage\rreturn" }),
      notice({ target: { path: "trip/tasks", record: "r".repeat(1_025) } }),
      notice({ target: { path: "p".repeat(1_000), record: "r".repeat(1_000), run: "x".repeat(100) } }),
      notice({ target: { path: "trip/tasks", owner: "x" } as PostNoticeRequest["target"] }),
      notice({ kind: "share-received" as PostNoticeRequest["kind"] }),
      notice({ noticeId: "n".repeat(257) }),
      notice({ shareId: "share-0" } as Partial<PostNoticeRequest>),
      notice({ workspaceId: undefined }),
    ];
    for (const body of invalid) {
      const response = await post(h, "owner", body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    const marks = Array.from({ length: 101 }, (_, index) => ({ noticeId: `n${index}`, mark: "read" }));
    expect((await h(request("owner", "/sync/notices/marks", jsonBody({ marks })))).status).toBe(400);
    expect((await h(request("owner", "/sync/notices/marks", jsonBody({ marks: [{ noticeId: "a", mark: "open" }] })))).status).toBe(400);
  });

  it("accepts a title, body, and label at their limits, counted in characters", async () => {
    const label = "🎉".repeat(NOTICE_SENDER_LABEL_MAX_CHARS);
    const { h } = await relay({ lookupUserDisplayName: () => label });
    const title = "🎉".repeat(120);
    const response = await post(h, "owner", notice({ kind: "mention", title, body: "é".repeat(499) + "\n" }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await pull(h, "owner")).notices[0]).toMatchObject({ title, senderLabel: label });
  });
});

describe("notice retention", () => {
  it("drops unread, read, and dismissed rows after their retention", async () => {
    const { h, storage } = await relay();
    for (const id of ["unread", "read", "dismissed"]) {
      await post(h, "owner", notice({ kind: "mention", noticeId: id }));
    }
    await mark(h, "owner", [{ noticeId: "read", mark: "read" }, { noticeId: "dismissed", mark: "dismissed" }]);
    const start = clock;
    const ids = async () => (await pull(h, "owner")).notices.map((row) => row.noticeId);

    clock = start + NOTICE_DISMISSED_RETENTION_MS - 1;
    expect(await ids()).toEqual(["unread", "read", "dismissed"]);
    clock = start + NOTICE_DISMISSED_RETENTION_MS;
    expect(await ids()).toEqual(["unread", "read"]);
    clock = start + NOTICE_READ_RETENTION_MS;
    expect(await ids()).toEqual(["unread"]);
    clock = start + NOTICE_UNREAD_RETENTION_MS;
    expect(await ids()).toEqual([]);

    // Expired rows can no longer be marked, and the next post removes them.
    await mark(h, "owner", [{ noticeId: "unread", mark: "read" }]);
    expect(await ids()).toEqual([]);
    const path = storagePath(storage);
    expect(countRows(path, "sync_relay_notices")).toBe(3);
    await post(h, "owner", notice({ kind: "mention", noticeId: "fresh" }));
    expect(countRows(path, "sync_relay_notices")).toBe(1);
  });

  it("sweeps expired rows from every list when anyone posts", async () => {
    const { h, storage } = await relay();
    await post(h, "ana", notice({ kind: "mention", noticeId: "ana-old", recipientUserId: "ana" }));
    clock += NOTICE_UNREAD_RETENTION_MS;
    await post(h, "owner", notice({ kind: "mention", noticeId: "owner-new" }));
    expect(countRows(storagePath(storage), "sync_relay_notices")).toBe(1);
    expect((await pull(h, "owner")).notices.map((row) => row.noticeId)).toEqual(["owner-new"]);
  });
});
