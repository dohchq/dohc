import { afterEach, describe, expect, it } from "vitest";
import type { PostNoticeRequest, RelayNotice } from "@dohc/workspace-contracts/relay";
import {
  NOTICE_DISMISSED_RETENTION_MS,
  NOTICE_LIST_ROW_LIMIT,
  NOTICE_READ_RETENTION_MS,
  NOTICE_UNREAD_RETENTION_MS,
} from "./storage/limits";
import type { SyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";
import {
  claimWorkspace,
  closeTestStorage,
  closeTestStorages,
  countRows,
  createShare,
  json,
  jsonBody,
  reopenTestStorage,
  request,
  storagePath,
  testHandler,
  testStorage,
} from "./testing";

afterEach(closeTestStorages);

const WORKSPACE = "workspace-trip";

let clock = 10_000;

async function relay(): Promise<{ h: SyncRelayHandler; storage: SyncRelayStorage }> {
  clock = 10_000;
  const storage = await testStorage();
  const h = testHandler(storage, { nowMs: () => clock, lookupUserDisplayName: (userId) => `Name ${userId}` });
  await claimWorkspace(h, "owner", WORKSPACE);
  return { h, storage };
}

function notice(overrides: Partial<PostNoticeRequest> = {}): PostNoticeRequest {
  return {
    noticeId: "automation-failed:workspace-trip:run-1",
    recipientUserId: "owner",
    workspaceId: WORKSPACE,
    kind: "automation-failed",
    title: "Stamp the finish date failed",
    body: "Finished on is not a date field.",
    target: { path: "trip/tasks", automation: "finished-date" },
    originInstallId: "install-a",
    ...overrides,
  };
}

async function post(h: SyncRelayHandler, sender: string, body: PostNoticeRequest): Promise<Response> {
  return h(request(sender, "/sync/notices", jsonBody(body)));
}

async function pull(
  h: SyncRelayHandler,
  userId: string,
  since = 0,
  limit?: number,
): Promise<{ notices: RelayNotice[]; nextCursor: number; hasMore: boolean }> {
  const query = `since=${since}${limit === undefined ? "" : `&limit=${limit}`}`;
  const response = await h(request(userId, `/sync/notices?${query}`));
  expect(response.status, await response.clone().text()).toBe(200);
  const { ok, ...page } = (await response.json()) as {
    ok: true;
    notices: RelayNotice[];
    nextCursor: number;
    hasMore: boolean;
  };
  expect(ok).toBe(true);
  return page;
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

describe("notice list", () => {
  it("posts to your own list and serves it to your other computers", async () => {
    const { h } = await relay();
    const own = notice({ kind: "agent-run", noticeId: "agent-run:1", title: "Your agent finished", target: {} });

    const posted = await post(h, "owner", own);
    expect(posted.status, await posted.clone().text()).toBe(200);

    const page = await pull(h, "owner");
    expect(page).toEqual({
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
      }],
      nextCursor: 1,
      hasMore: false,
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
});

describe("notices for someone else", () => {
  async function sharedTrip() {
    const setup = await relay();
    const shareId = await createShare(setup.h, "owner", WORKSPACE, {
      paths: ["trip"],
      recipientUserId: "ana",
    });
    return { ...setup, shareId };
  }

  it("lets the owner send to a grantee who can read the target", async () => {
    const { h, shareId } = await sharedTrip();
    expect((await post(h, "owner", notice({ recipientUserId: "ana" }))).status).toBe(200);

    const [row] = (await pull(h, "ana")).notices;
    expect(row).toMatchObject({
      senderUserId: "owner",
      senderLabel: "Name owner",
      senderKind: "automation",
      recipientShareId: shareId,
      target: { path: "trip/tasks", automation: "finished-date" },
    });
    expect((await pull(h, "owner")).notices).toEqual([]);
  });

  it("lets a grantee send to the owner", async () => {
    const { h } = await sharedTrip();
    expect((await post(h, "ana", notice({ recipientUserId: "owner" }))).status).toBe(200);

    const [row] = (await pull(h, "owner")).notices;
    expect(row).toMatchObject({ senderUserId: "ana", senderLabel: "Name ana", recipientShareId: null });
  });

  it("lets one grantee send to another when both can read the target", async () => {
    const { h } = await sharedTrip();
    const shareId = await createShare(h, "owner", WORKSPACE, { paths: ["trip/tasks"], recipientUserId: "ben" });
    expect((await post(h, "ana", notice({ recipientUserId: "ben" }))).status).toBe(200);
    expect((await pull(h, "ben")).notices[0]?.recipientShareId).toBe(shareId);
  });

  it("refuses when either person cannot read the target", async () => {
    const { h, storage, shareId } = await sharedTrip();
    await createShare(h, "owner", WORKSPACE, { paths: ["budget"], recipientUserId: "ben" });

    // The grantee cannot read the owner's private folder, in either direction.
    await expectRefused(await post(h, "owner", notice({ recipientUserId: "ana", target: { path: "budget/q3" } })));
    await expectRefused(await post(h, "ana", notice({ recipientUserId: "owner", target: { path: "budget/q3" } })));
    // Ben reads budget but not trip.
    await expectRefused(await post(h, "ana", notice({ recipientUserId: "ben" })));
    // A stranger, to or from the owner, and in a workspace nobody shared.
    await expectRefused(await post(h, "stranger", notice({ recipientUserId: "owner" })));
    await expectRefused(await post(h, "owner", notice({ recipientUserId: "stranger" })));
    await expectRefused(await post(h, "ana", notice({ recipientUserId: "owner", workspaceId: "workspace-other" })));
    // No path to check, a path spelled another way, or a kind only its sender receives.
    await expectRefused(await post(h, "owner", notice({ recipientUserId: "ana", target: {} })));
    await expectRefused(await post(h, "owner", notice({ recipientUserId: "ana", target: { path: "trip/../trip/tasks" } })));
    await expectRefused(await post(h, "owner", notice({ recipientUserId: "ana", kind: "agent-run" })));

    // A revoked grant reads nothing.
    expect(storage.revokeShare(shareId, clock)).toBe(true);
    await expectRefused(await post(h, "owner", notice({ recipientUserId: "ana" })));
    await expectRefused(await post(h, "ana", notice({ recipientUserId: "owner" })));

    expect(countRows(storagePath(storage), "sync_relay_notices")).toBe(0);
  });

  it("does not count a share of another version", async () => {
    const { h } = await relay();
    await createShare(h, "owner", WORKSPACE, { paths: ["trip"], versionId: "draft", recipientUserId: "ana" });
    await expectRefused(await post(h, "owner", notice({ recipientUserId: "ana" })));
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
    expect(changes.notices.map((row) => [row.noticeId, row.changeSeq, row.readAtMs, row.dismissedAtMs]))
      .toEqual([["a", 4, 20_000, null], ["b", 5, null, 20_000]]);
    expect(changes.nextCursor).toBe(5);

    // The flags go one way: nothing changes a second time.
    clock = 30_000;
    await mark(h, "owner", [
      { noticeId: "a", mark: "read" },
      { noticeId: "b", mark: "read" },
      { noticeId: "b", mark: "dismissed" },
    ]);
    expect(await pull(h, "owner", changes.nextCursor)).toEqual({ notices: [], nextCursor: 5, hasMore: false });

    // Dismissing a read row is still a change.
    await mark(h, "owner", [{ noticeId: "a", mark: "dismissed" }]);
    const last = await pull(h, "owner", 5);
    expect(last.notices.map((row) => [row.noticeId, row.readAtMs, row.dismissedAtMs])).toEqual([["a", 20_000, 30_000]]);
  });

  it("marks only the caller's own rows", async () => {
    const { h } = await relay();
    await post(h, "owner", notice({ kind: "mention", noticeId: "a" }));
    await mark(h, "ana", [{ noticeId: "a", mark: "dismissed" }]);
    expect((await pull(h, "owner")).notices[0]?.dismissedAtMs).toBeNull();
  });

  it("pages by change and starts over from a cursor past the list", async () => {
    const { h } = await relay();
    for (const id of ["a", "b", "c"]) {
      await post(h, "owner", notice({ kind: "mention", noticeId: id }));
    }
    const page = await pull(h, "owner", 0, 2);
    expect(page.notices.map((row) => row.noticeId)).toEqual(["a", "b"]);
    expect(page).toMatchObject({ nextCursor: 2, hasMore: true });
    const rest = await pull(h, "owner", page.nextCursor, 2);
    expect(rest.notices.map((row) => row.noticeId)).toEqual(["c"]);
    expect(rest).toMatchObject({ nextCursor: 3, hasMore: false });

    const fromAnotherHistory = await pull(h, "owner", 50);
    expect(fromAnotherHistory.notices.map((row) => row.noticeId)).toEqual(["a", "b", "c"]);
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

describe("notice bounds", () => {
  it("refuses a notice past its limits", async () => {
    const { h } = await relay();
    const tooLong = [
      notice({ title: "t".repeat(121) }),
      notice({ title: "" }),
      notice({ body: "b".repeat(501) }),
      notice({ body: "a\u0000b" }),
      notice({ target: { path: "trip/tasks", record: "r".repeat(1_025) } }),
      notice({ target: { path: "p".repeat(1_000), record: "r".repeat(1_000), run: "x".repeat(100) } }),
      notice({ target: { path: "trip/tasks", owner: "x" } as PostNoticeRequest["target"] }),
      notice({ kind: "share-received" as PostNoticeRequest["kind"] }),
      notice({ noticeId: "n".repeat(513) }),
    ];
    for (const body of tooLong) {
      const response = await post(h, "owner", body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    const marks = Array.from({ length: 101 }, (_, index) => ({ noticeId: `n${index}`, mark: "read" }));
    expect((await h(request("owner", "/sync/notices/marks", jsonBody({ marks })))).status).toBe(400);
    expect((await h(request("owner", "/sync/notices/marks", jsonBody({ marks: [{ noticeId: "a", mark: "open" }] })))).status).toBe(400);
  });

  it("accepts a title and body at their limits, counted in characters", async () => {
    const { h } = await relay();
    const title = "🎉".repeat(120);
    const response = await post(h, "owner", notice({ kind: "mention", title, body: "é".repeat(500) }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await pull(h, "owner")).notices[0]?.title).toBe(title);
  });

  it("keeps at most the list limit, removing read rows before unread ones", async () => {
    const { h, storage } = await relay();
    for (let index = 0; index < NOTICE_LIST_ROW_LIMIT; index += 1) {
      storage.postNotice({
        ...notice({ kind: "mention", noticeId: `n${index}` }),
        senderUserId: "owner",
        senderLabel: "Owner",
        nowMs: clock + index,
      });
    }
    await mark(h, "owner", [{ noticeId: "n500", mark: "read" }, { noticeId: "n700", mark: "dismissed" }]);

    clock += NOTICE_LIST_ROW_LIMIT;
    await post(h, "owner", notice({ kind: "mention", noticeId: "newest" }));
    await post(h, "owner", notice({ kind: "mention", noticeId: "newer still" }));
    await post(h, "owner", notice({ kind: "mention", noticeId: "last" }));

    const path = storagePath(storage);
    expect(countRows(path, "sync_relay_notices")).toBe(NOTICE_LIST_ROW_LIMIT);
    const ids = new Set<string>();
    for (let since = 0, more = true; more;) {
      const page = await pull(h, "owner", since, 200);
      for (const row of page.notices) ids.add(row.noticeId);
      since = page.nextCursor;
      more = page.hasMore;
    }
    // Read n500 and dismissed n700 go first, then the oldest unread, n0.
    expect(["n500", "n700", "n0"].filter((id) => ids.has(id))).toEqual([]);
    expect(["n1", "newest", "newer still", "last"].every((id) => ids.has(id))).toBe(true);
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
