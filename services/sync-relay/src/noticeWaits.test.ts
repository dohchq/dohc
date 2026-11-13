import { afterEach, expect, it, vi } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import {
  UnauthorizedError,
  type AccountSession,
  type AccountSessions,
  type ResolveAccountSession,
} from "@dohc/workspace-auth/session";
import {
  NOTICE_WAIT_MAX_MS,
  type AutomationWake,
  type RelayNotice,
  type RelayNoticePage,
} from "@dohc/workspace-contracts/relay";
import { createAccountDeletionRoute } from "./accountDeletionRoute";
import { DiscussionActivityHub } from "./discussionActivity";
import { NOTICE_WAITS_PER_ACCOUNT, NOTICE_WAITS_PER_SESSION } from "./noticeRoutes";
import { notifyNoticeChange } from "./relayWriteChanges";
import type { SyncRelayStorage } from "./storage";
import type { StorageContext } from "./storage/context";
import { advanceNoticeHead, type PostNoticeInput } from "./storage/notices";
import {
  closeTestStorages,
  denialBytes,
  inspectDatabase,
  jsonBody,
  request,
  seedFullNoticeList,
  storagePath,
  testHandler,
  testStorage,
} from "./testing";

// The account's own Notice reads, `scope=phone` and `wait`, over real storage.

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeTestStorages();
});

const NOW = 50_000_000;
const MAX = NOTICE_WAIT_MAX_MS;
const DIARY = { reach: { workspaceId: "diary" } } as const;
const ids = (page: RelayNoticePage) => page.notices.map((notice: RelayNotice) => notice.noticeId);
const fakeTime = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

async function relay(options: { seedFull?: boolean } = {}) {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: "trip", ownerUserId: "ana", createdAtMs: 1 });
  storage.claimWorkspace({ workspaceId: "diary", ownerUserId: "ana", createdAtMs: 1 });
  storage.claimWorkspace({ workspaceId: "bens", ownerUserId: "ben", createdAtMs: 1 });
  // Ana keeps her diary off her phone.
  storage.setShowOnPhone({ ownerUserId: "ana", workspaceId: "diary", showOnPhone: false });
  if (options.seedFull)
    seedFullNoticeList(storage, {
      workspaceId: "trip",
      recipientUserId: "ana",
      idPrefix: "full-",
      nowMs: NOW - 2_000,
    });
  // `Bearer session:<user>:<session>` is a valid sign-in, under `rename` while it is set, until its session is revoked.
  // `holdSession(n)` holds the nth sign-in check from now until its release.
  let rename: string | null = null;
  const revoked = new Set<string>();
  let checks = 0;
  let held: { at: number; reached(): void; open: Promise<void> } | null = null;
  const resolveAccountSession: ResolveAccountSession = async (incoming) => {
    const match = /^Bearer session:([\w-]+):([\w-]+)$/u.exec(
      incoming.headers.get("authorization") ?? "",
    );
    if (!match || revoked.has(match[2]!)) throw new UnauthorizedError();
    checks += 1;
    if (held !== null && checks === held.at) {
      const hold = held;
      held = null;
      hold.reached();
      await hold.open;
    }
    return {
      userId: match[1]!,
      sessionId: rename ?? match[2]!,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    } satisfies AccountSession;
  };
  const holdSession = (nth: number) => {
    let reached!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    held = {
      at: checks + nth,
      reached,
      open: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    return { reached: waiting, release: () => release() };
  };
  const accountSessions: AccountSessions = {
    list: async () => [],
    revoke: async ({ sessionId }) => {
      revoked.add(sessionId);
      return true;
    },
  };
  const hub = new DiscussionActivityHub();
  const h = testHandler(storage, {
    resolveAccountSession,
    accountSessions,
    discussionActivity: hub,
    nowMs: () => NOW,
    accountOperationRateLimiter: new TokenBucketLimiter(10_000, 1, 16),
  });
  const read = (
    query: string,
    input: {
      userId?: string;
      session?: string;
      signal?: AbortSignal;
      headers?: Record<string, string>;
    } = {},
  ) =>
    h(
      new Request(`http://relay.test/sync/notices?${query}`, {
        headers: {
          authorization: `Bearer session:${input.userId ?? "ana"}:${input.session ?? "phone"}`,
          ...input.headers,
        },
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );
  // The whole list, as a computer reads it.
  const full = async (userId = "ana") =>
    await page(await h(request(userId, "/sync/notices?limit=200")));
  const post = (noticeId: string, overrides: Partial<PostNoticeInput> = {}) =>
    storage.postNotice({
      noticeId,
      recipientUserId: "ana",
      reach: { workspaceId: "trip" },
      kind: "mention",
      title: `Title ${noticeId}`,
      body: `Body ${noticeId}`,
      target: {},
      originInstallId: "install-a",
      senderUserId: "ana",
      senderLabel: "Ana",
      nowMs: NOW,
      ...overrides,
    });
  return {
    storage,
    hub,
    h,
    read,
    full,
    post,
    holdSession,
    signOut: () => {
      rename = "another";
    },
  };
}

async function page(response: Response): Promise<RelayNoticePage> {
  expect(response.status, await response.clone().text()).toBe(200);
  const { ok, ...rest } = (await response.json()) as RelayNoticePage & { ok: true };
  expect(ok).toBe(true);
  return rest;
}

// A read parks once its recheck of the head runs, after it registers. `parks(n)` resolves once n more have.
function parking(storage: SyncRelayStorage) {
  const head = storage.noticeHead.bind(storage);
  let checks = 0;
  let waiters: Array<{ at: number; resolve(): void }> = [];
  const heads = vi.spyOn(storage, "noticeHead").mockImplementation((userId) => {
    checks += 1;
    for (const waiter of waiters) if (checks >= waiter.at) waiter.resolve();
    waiters = waiters.filter((waiter) => checks < waiter.at);
    return head(userId);
  });
  const parks = (count: number) =>
    new Promise<void>((resolve) => {
      waiters.push({ at: checks + count, resolve });
    });
  return { heads, parks };
}

// Log rows as a computer's sync would write them: moments place objects, and thread creates name their file.
function logWriter(storage: SyncRelayStorage, workspaceId = "trip") {
  const context = storage as StorageContext;
  let originSeq = 0;
  return (opKind: string, payload: Record<string, unknown>) =>
    context.tx(() => {
      const row = context.db
        .prepare(`INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms)
      VALUES (?, 'origin-test', ?, ?, ?, 1) RETURNING relay_seq`)
        .get(workspaceId, ++originSeq, opKind, JSON.stringify(payload))!;
      const relaySeq = Number(row.relay_seq);
      if (opKind === "moment.append") {
        context.db
          .prepare(`INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, 1)`)
          .run(
            workspaceId,
            String(payload.objectId),
            relaySeq,
            `moment-${relaySeq}`,
            typeof payload.versionId === "string" ? payload.versionId : "main",
            payload.path ?? null,
          );
      }
      return relaySeq;
    });
}

// Ben shares his notes with Ana by name. Without `deliver`, its share-received Notice is settled at once.
function shareNotesWithAna(storage: SyncRelayStorage, options: { deliver?: boolean } = {}): void {
  storage.createShare({
    share: {
      shareId: "share-ben",
      workspaceId: "bens",
      granterUserId: "ben",
      selectorJson: JSON.stringify({ paths: ["notes"], versionId: null }),
      createdAtMs: 1,
    },
    grant: {
      grantId: "grant-ben",
      shareId: "share-ben",
      principalKind: "user",
      principalUserId: "ana",
      principalEmail: null,
      access: "view",
      generation: 1,
      status: "active",
      createdAtMs: 1,
      revokedAtMs: null,
      parentGrantId: null,
    },
  });
  if (options.deliver) return;
  const db = inspectDatabase(storagePath(storage));
  db.prepare("DELETE FROM sync_relay_share_notice_deliveries WHERE grant_id = 'grant-ben'").run();
  db.close();
}

it("reads with scope or wait only under the account's Bearer session", async () => {
  const { storage, h, read, post } = await relay();
  post("n-1");
  expect(ids(await page(await read("scope=phone")))).toEqual(["n-1"]);
  expect(ids(await page(await read("wait=0")))).toEqual(["n-1"]);

  const missing = await denialBytes(
    await read("scope=phone", { headers: { cookie: "session=x" } }),
  );
  expect(
    await denialBytes(
      await h(
        new Request("http://relay.test/sync/notices?scope=phone", {
          headers: { authorization: "Bearer" },
        }),
      ),
    ),
  ).toBe(missing);
  expect(await denialBytes(await h(new Request("http://relay.test/sync/notices?wait=0")))).toBe(
    missing,
  );
  // A computer's actor credential and an unknown token are not account sessions.
  expect((await h(request("ana", "/sync/notices?scope=phone"))).status).toBe(401);
  expect(
    (
      await h(
        new Request("http://relay.test/sync/notices?wait=0", {
          headers: { authorization: "Bearer dohc-service-v1.x" },
        }),
      )
    ).status,
  ).toBe(401);
  // A relay without the account resolver serves no account read.
  const without = testHandler(storage, { nowMs: () => NOW });
  expect(
    await denialBytes(
      await without(
        new Request("http://relay.test/sync/notices?scope=phone", {
          headers: { authorization: "Bearer session:ana:phone" },
        }),
      ),
    ),
  ).toBe(missing);
  // Without scope or wait, the read is the computer's, as before.
  expect(ids(await page(await h(request("ana", "/sync/notices"))))).toEqual(["n-1"]);

  createAccountDeletionRoute({
    storage: storage as StorageContext,
    key: "bearer-test",
    fenceKey: "fence-test",
    invalidate() {},
    deleteRuntime: async () => {},
  }).fence("ana", "ana@example.test");
  expect(await denialBytes(await read("scope=phone"))).toBe(missing);
});

it("refuses a scope or wait it doesn't know, and accepts the longest wait", async () => {
  const { read } = await relay();
  for (const query of [
    "scope=",
    "scope=desktop",
    "scope=PHONE",
    "wait=",
    "wait=-1",
    "wait=1.5",
    "wait=1e3",
    "wait=025",
    `wait=${MAX + 1}`,
    "wait=abc",
    "wait=Infinity",
    "scope=phone&cursor=x",
    "scope=phone&limit=0",
  ]) {
    const response = await read(query);
    expect(response.status, query).toBe(400);
  }
  // No cursor takes the whole list, which answers at once.
  expect((await read(`scope=phone&wait=${MAX}`)).status).toBe(200);
});

it("leaves hidden workspaces, secret targets, and wake payloads out of the phone's scope, and keeps the whole list whole", async () => {
  const { storage, read, full, post } = await relay();
  const write = logWriter(storage);
  write("moment.append", { objectId: "object-moved", path: "docs/moved.md" });
  write("moment.append", { objectId: "object-moved", path: ".env.local" });
  write("moment.append", { objectId: "object-gone", path: "docs/gone.md" });
  write("moment.append", { objectId: "object-gone", path: null });
  write("chat.thread.create", { threadId: "thread-keys", linkedPathHint: ".env" });
  write("chat.thread.create", {
    threadId: "thread-on-moved",
    linkedObjectId: "object-moved",
    linkedPathHint: "docs/moved.md",
  });
  write("chat.thread.create", {
    threadId: "thread-plain",
    linkedObjectId: "object-gone",
    linkedPathHint: "docs/gone.md",
  });
  write("chat.thread.create", { threadId: "thread-chat" });
  // A linked file the relay never placed, with no hint and with an ordinary one.
  write("chat.thread.create", { threadId: "thread-unplaced", linkedObjectId: "object-never" });
  write("chat.thread.create", {
    threadId: "thread-unplaced-hint",
    linkedObjectId: "object-never-2",
    linkedPathHint: "docs/new.md",
  });
  // Ana keeps notices of her own in Ben's shared notes.
  shareNotesWithAna(storage);

  post("plain", { target: { path: "docs/plan.md" } });
  post("hidden-workspace", { ...DIARY, target: { path: "diary/today.md" } });
  post("secret", {
    title: "API key rotated",
    body: "The new key is in .env",
    target: { path: ".env" },
  });
  post("secret-nested", { target: { path: "config/.env.production" } });
  post("ignored", { target: { path: "docs/.DS_Store." } });
  post("moved", { title: "Moved file", target: { path: "docs/moved.md" } });
  // Classified as it normalizes: the moved file again.
  post("unnormalized", { target: { path: "docs//moved.md" } });
  post("deleted", { target: { path: "docs/gone.md" } });
  post("thread-secret", {
    title: "Keys thread",
    target: { thread: "thread-keys", message: "m-1" },
  });
  post("thread-moved", { target: { thread: "thread-on-moved" } });
  post("thread-plain", { target: { thread: "thread-plain" } });
  post("thread-chat", { target: { thread: "thread-chat" } });
  // Its create hasn't reached the relay, as when a computer's Notice outbox beats its chat sync.
  post("thread-unknown", {
    title: "Unknown thread",
    body: "KEY=from-an-agent-reply",
    target: { thread: "thread-nowhere", run: "run-1" },
  });
  post("thread-unplaced", { target: { thread: "thread-unplaced" } });
  post("thread-unplaced-hint", { target: { thread: "thread-unplaced-hint" } });
  // A message in the keys thread, named without its thread.
  post("message-only", { title: "Message in keys", target: { message: "m-1" } });
  post("through-share", { reach: { shareId: "share-ben" }, target: { path: "notes/list.md" } });
  // Through a share, only a path it admits is looked up.
  post("share-thread", { reach: { shareId: "share-ben" }, target: { thread: "thread-ben" } });
  const wake: AutomationWake = {
    automationId: "digest",
    name: "Digest",
    depth: 1,
    body: "Summarize the day",
  };
  const { noticeId: wakeId } = storage.postAutomationWake({
    workspaceId: "trip",
    ownerUserId: "ana",
    effectId: "effect-1",
    claimId: "claim-1",
    keySeed: "seed-1",
    startedAtMs: NOW,
    wake,
    senderLabel: "Digest",
    nowMs: NOW,
  });

  const response = await read("scope=phone&limit=200");
  const text = await response.clone().text();
  const phone = await page(response);
  const kept = ["plain", "deleted", "thread-plain", "thread-chat", "through-share", wakeId];
  expect(ids(phone)).toEqual(kept);
  expect(phone.notices.find((notice) => notice.noticeId === "through-share")).toMatchObject({
    workspaceId: null,
    recipientShareId: "share-ben",
  });
  expect(phone.notices.find((notice) => notice.noticeId === wakeId)).not.toHaveProperty("wake");
  // Title and body go with the row, not just its target.
  for (const left of [
    "API key rotated",
    ".env",
    "Moved file",
    "Keys thread",
    "Unknown thread",
    "KEY=",
    "Message in keys",
    "Summarize the day",
    "diary",
  ]) {
    expect(text).not.toContain(left);
  }

  const whole = await full();
  expect(whole.notices).toHaveLength(19);
  for (const left of ids(whole).filter((id) => !kept.includes(id)))
    expect(text, left).not.toContain(`"noticeId":"${left}"`);
  expect(whole.notices.find((notice) => notice.noticeId === wakeId)?.wake).toEqual(wake);
  expect(ids(whole)).toEqual(
    expect.arrayContaining(["hidden-workspace", "secret", "moved", "thread-secret"]),
  );
});

it("decides a row in another account's workspace by a fixed rule that reads nothing there", async () => {
  const { storage, read, post } = await relay();
  // Ana's own notices can name any workspace ID, Ben's included.
  post("probe-path", { reach: { workspaceId: "bens" }, target: { path: "deploy/config.yaml" } });
  post("probe-thread", { reach: { workspaceId: "bens" }, target: { thread: "thread-ben" } });
  post("probe-plain", { reach: { workspaceId: "bens" }, target: {} });
  const before = await (await read("scope=phone")).text();
  const write = logWriter(storage, "bens");
  write("moment.append", { objectId: "object-config", path: "deploy/config.yaml" });
  write("moment.append", { objectId: "object-config", path: ".env" });
  write("chat.thread.create", { threadId: "thread-ben", linkedPathHint: ".env" });
  const after = await read("scope=phone");
  expect(await after.clone().text()).toBe(before);
  expect(ids(await page(after))).toEqual(["probe-plain"]);
});

it("never looks up a thread named through a share, even beside a path the share admits", async () => {
  const { storage, read, full, post } = await relay();
  shareNotesWithAna(storage);
  // An admitted path paired with Ben's thread outside the share.
  post("share-path-thread", {
    reach: { shareId: "share-ben" },
    target: { path: "notes/list.md", thread: "thread-private" },
  });
  const missing = await (await read("scope=phone")).text();
  const write = logWriter(storage, "bens");
  write("moment.append", { objectId: "object-payroll", path: "private/payroll.md" });
  write("chat.thread.create", {
    threadId: "thread-private",
    linkedObjectId: "object-payroll",
    linkedPathHint: "private/payroll.md",
  });
  const ordinary = await (await read("scope=phone")).text();
  write("moment.append", { objectId: "object-payroll", path: ".env" });
  const secret = await read("scope=phone");
  expect(await secret.clone().text()).toBe(missing);
  expect(ordinary).toBe(missing);
  expect(ids(await page(secret))).toEqual([]);
  expect(ids(await full())).toContain("share-path-thread");
});

it("shows a shared file's Notice only while the file stays in the share, whatever it became outside", async () => {
  const { storage, read, post } = await relay();
  shareNotesWithAna(storage);
  const write = logWriter(storage, "bens");
  write("moment.append", { objectId: "object-list", path: "notes/list.md" });
  post("share-file", { reach: { shareId: "share-ben" }, target: { path: "notes/list.md" } });
  write("moment.append", { objectId: "object-list", path: "notes/renamed.md" });
  expect(ids(await page(await read("scope=phone")))).toEqual(["share-file"]);
  write("moment.append", { objectId: "object-list", path: ".env" });
  const secret = await (await read("scope=phone")).text();
  write("moment.append", { objectId: "object-list", path: "private/list.md" });
  const elsewhere = await (await read("scope=phone")).text();
  write("moment.append", { objectId: "object-list", path: null });
  const deleted = await read("scope=phone");
  expect(await deleted.clone().text()).toBe(secret);
  expect(elsewhere).toBe(secret);
  expect(ids(await page(deleted))).toEqual([]);
});

it("reads a shared file deleted inside the share the same as one moved out of it", async () => {
  const { storage, read, post } = await relay();
  shareNotesWithAna(storage);
  const write = logWriter(storage, "bens");
  write("moment.append", { objectId: "object-gone", path: "notes/gone.md" });
  write("moment.append", { objectId: "object-left", path: "notes/left.md" });
  post("share-gone", { reach: { shareId: "share-ben" }, target: { path: "notes/gone.md" } });
  post("share-left", { reach: { shareId: "share-ben" }, target: { path: "notes/left.md" } });
  expect(ids(await page(await read("scope=phone")))).toEqual(["share-gone", "share-left"]);
  write("moment.append", { objectId: "object-gone", path: null });
  write("moment.append", { objectId: "object-left", path: "private/left.md" });
  expect(ids(await page(await read("scope=phone")))).toEqual([]);
});

it("keeps a shared file's Notice whatever a version the share doesn't cover does with the file", async () => {
  const { storage, read, post } = await relay();
  shareNotesWithAna(storage);
  const write = logWriter(storage, "bens");
  write("moment.append", { objectId: "object-list", path: "notes/list.md" });
  post("share-file", { reach: { shareId: "share-ben" }, target: { path: "notes/list.md" } });
  const before = await (await read("scope=phone")).text();
  write("moment.append", { objectId: "object-list", path: "private/list.md", versionId: "draft" });
  const outside = await (await read("scope=phone")).text();
  write("moment.append", { objectId: "object-list", path: ".env", versionId: "draft" });
  const secret = await (await read("scope=phone")).text();
  write("moment.append", { objectId: "object-list", path: "notes/list.md", versionId: "draft" });
  const inside = await read("scope=phone");
  expect(await inside.clone().text()).toBe(before);
  expect(outside).toBe(before);
  expect(secret).toBe(before);
  expect(ids(await page(inside))).toEqual(["share-file"]);
});

it("leaves out a share-placed row whose target reach settlement removed, even after the whole list was read", async () => {
  const { storage, read, full, post } = await relay();
  shareNotesWithAna(storage);
  // The share never admits a secret file, so the next read's reach check takes the target and keeps the words.
  post("share-secret", {
    reach: { shareId: "share-ben" },
    title: "Ben's keys",
    body: "KEY=hunter2",
    target: { path: "notes/.env" },
  });
  expect((await full()).notices.find((notice) => notice.noticeId === "share-secret")).toMatchObject(
    { target: null, title: "Ben's keys" },
  );
  const response = await read("scope=phone");
  const text = await response.clone().text();
  expect(ids(await page(response))).toEqual([]);
  for (const left of ["Ben's keys", "hunter2"]) expect(text).not.toContain(left);
});

it("answers a held read at once when a named share arrives during its last sign-in check, and the next read delivers it", async () => {
  const { storage, read, post, holdSession } = await relay();
  fakeTime();
  post("n-1");
  // The request's own check is the first; the check before the read is the second.
  const held = holdSession(2);
  const reading = read(`scope=phone&cursor=1&wait=${MAX}`);
  await held.reached;
  shareNotesWithAna(storage, { deliver: true });
  held.release();
  // No timer moves: the share moved the head, so the read never parks.
  expect(await page(await reading)).toMatchObject({ notices: [], nextCursor: "2" });
  const next = await page(await read("scope=phone&cursor=2"));
  expect(next.notices.map((notice) => [notice.kind, notice.recipientShareId])).toEqual([
    ["share-received", "share-ben"],
  ]);
});

it("moves the phone's cursor past the rows it leaves out", async () => {
  const { read, post } = await relay();
  post("hidden-1", DIARY);
  post("hidden-2", DIARY);
  post("hidden-3", DIARY);
  post("shown");
  const first = await page(await read("scope=phone&limit=2"));
  expect(first).toMatchObject({ notices: [], hasMore: true, replace: true, nextCursor: "2.4" });
  const second = await page(await read(`scope=phone&limit=2&cursor=${first.nextCursor}`));
  expect([ids(second), second.hasMore, second.replace, second.nextCursor]).toEqual([
    ["shown"],
    false,
    false,
    "4",
  ]);
  expect(await page(await read("scope=phone&cursor=4"))).toMatchObject({
    notices: [],
    hasMore: false,
    replace: false,
    nextCursor: "4",
  });
  post("hidden-4", DIARY);
  expect(await page(await read("scope=phone&cursor=4"))).toMatchObject({
    notices: [],
    hasMore: false,
    replace: false,
    nextCursor: "5",
  });
});

it("serves a removed row to the phone without its title", async () => {
  const { storage, h, read, post } = await relay({ seedFull: true });
  const head = storage.noticeHead("ana");
  // A full list gives up its oldest row for the new one.
  post("overflow");
  const phone = await page(await read(`scope=phone&cursor=${head}`));
  expect(phone.notices.map((notice) => [notice.noticeId, notice.removed, notice.title])).toEqual([
    ["full-0", true, ""],
    ["overflow", false, "Title overflow"],
  ]);
  // A computer's read still carries what the row said.
  const computer = await page(await h(request("ana", `/sync/notices?cursor=${head}`)));
  expect(computer.notices.find((notice) => notice.noticeId === "full-0")).toMatchObject({
    removed: true,
    title: "Mentioned",
  });
});

it("answers at once whenever the cursor isn't caught up", async () => {
  const { storage, read, post } = await relay();
  const { heads } = parking(storage);
  post("n-1");
  for (const query of ["", "cursor=0", "cursor=0.1", "cursor=9"]) {
    const answered = await page(await read(`scope=phone&wait=${MAX}${query ? `&${query}` : ""}`));
    expect(ids(answered), query).toEqual(["n-1"]);
  }
  expect(await page(await read("scope=phone&cursor=1&wait=0"))).toMatchObject({
    notices: [],
    nextCursor: "1",
  });
  expect(heads, "nothing parked").not.toHaveBeenCalled();
});

it("holds a caught-up read without polling and answers the next committed change, hidden or not", async () => {
  const { storage, read, post } = await relay();
  fakeTime();
  post("n-1");
  const { heads, parks } = parking(storage);
  const reads = vi.spyOn(storage, "readNoticeChanges");
  let parked = parks(1);
  let held = read(`scope=phone&cursor=1&wait=${MAX}`);
  await parked;
  const asked = [heads.mock.calls.length, reads.mock.calls.length];
  vi.advanceTimersByTime(MAX - 1);
  expect([heads.mock.calls.length, reads.mock.calls.length], "an idle read runs no query").toEqual(
    asked,
  );
  post("n-2");
  expect(ids(await page(await held))).toEqual(["n-2"]);

  // A change the phone's scope leaves out still answers, with the cursor past it.
  parked = parks(1);
  held = read(`scope=phone&cursor=2&wait=${MAX}`);
  await parked;
  post("hidden", DIARY);
  expect(await page(await held)).toMatchObject({
    notices: [],
    hasMore: false,
    replace: false,
    nextCursor: "3",
  });

  // Show on phone is read when the read wakes, not when it began.
  parked = parks(1);
  held = read(`scope=phone&cursor=3&wait=${MAX}`);
  await parked;
  storage.setShowOnPhone({ ownerUserId: "ana", workspaceId: "trip", showOnPhone: false });
  post("now-hidden");
  expect(await page(await held)).toMatchObject({ notices: [], nextCursor: "4" });
});

it("loses no change committed between the read and the wait", async () => {
  const { storage, read, post } = await relay();
  post("n-1");
  const head = storage.noticeHead.bind(storage);
  let first = true;
  // The recheck after registering runs once the change has committed.
  vi.spyOn(storage, "noticeHead").mockImplementation((userId) => {
    if (first) {
      first = false;
      post("n-2");
    }
    return head(userId);
  });
  expect(ids(await page(await read(`cursor=1&wait=${MAX}`)))).toEqual(["n-2"]);
});

it("keeps one deadline through wakes that change nothing, a rolled-back write among them", async () => {
  const { storage, read, post } = await relay();
  fakeTime();
  post("n-1");
  const { parks } = parking(storage);
  let answered = false;
  let parked = parks(1);
  const held = read(`cursor=1&wait=${MAX}`).then((response) => {
    answered = true;
    return response;
  });
  await parked;
  vi.advanceTimersByTime(10_000);
  parked = parks(1);
  notifyNoticeChange(storage, "ana");
  await parked;
  parked = parks(1);
  const context = storage as StorageContext;
  expect(() =>
    context.tx(() => {
      advanceNoticeHead(context, "ana");
      throw new Error("rolled back");
    }),
  ).toThrow("rolled back");
  await parked;
  vi.advanceTimersByTime(MAX - 10_000 - 1);
  await Promise.resolve();
  expect(answered).toBe(false);
  vi.advanceTimersByTime(1);
  expect(await page(await held)).toMatchObject({ notices: [], nextCursor: "1" });
});

it("answers at once past a sign-in's or an account's waits, and frees a slot when a read ends", async () => {
  const { storage, read, post } = await relay();
  fakeTime();
  post("n-1");
  const { heads, parks } = parking(storage);
  const wait = (session: string, input: { userId?: string; signal?: AbortSignal } = {}) =>
    read(`cursor=${input.userId === "ben" ? 0 : 1}&wait=${MAX}`, { session, ...input });

  const leaving = new AbortController();
  let parked = parks(NOTICE_WAITS_PER_SESSION);
  const waiting = [
    wait("phone", { signal: leaving.signal }),
    ...Array.from({ length: NOTICE_WAITS_PER_SESSION - 1 }, () => wait("phone")),
  ];
  await parked;
  const before = heads.mock.calls.length;
  expect(await page(await wait("phone")), "past the sign-in's waits").toMatchObject({
    notices: [],
    nextCursor: "1",
  });
  expect(heads.mock.calls.length).toBe(before);
  leaving.abort();
  await waiting.shift();
  parked = parks(1);
  waiting.push(wait("phone"));
  await parked;

  const others = NOTICE_WAITS_PER_ACCOUNT - NOTICE_WAITS_PER_SESSION;
  parked = parks(others);
  waiting.push(...Array.from({ length: others }, (_, index) => wait(`computer-${index % 8}`)));
  await parked;
  const filled = heads.mock.calls.length;
  expect(await page(await wait("another")), "past the account's waits").toMatchObject({
    notices: [],
    nextCursor: "1",
  });
  expect(heads.mock.calls.length).toBe(filled);
  // Another account still waits.
  parked = parks(1);
  waiting.push(wait("ben-phone", { userId: "ben" }));
  await parked;
  vi.advanceTimersByTime(MAX);
  for (const response of await Promise.all(waiting)) expect(response.status).toBe(200);
});

it("wakes only its own account, and another account's same notice ID stays apart", async () => {
  const { storage, hub, h, read, post, full } = await relay();
  fakeTime();
  post("same");
  post("same", { recipientUserId: "ben", senderUserId: "ben", reach: { workspaceId: "bens" } });
  const { parks } = parking(storage);
  const parked = parks(1);
  const held = read(`scope=phone&cursor=1&wait=${MAX}`);
  await parked;
  // Watched only from here: the setup posts' own notification, ana's included, ran before her read parked.
  const wakes = vi.spyOn(hub, "wake");
  post("other", { recipientUserId: "ben", senderUserId: "ben", reach: { workspaceId: "bens" } });
  const marked = await h(
    request(
      "ben",
      "/sync/notices/marks",
      jsonBody({ marks: [{ noticeId: "same", mark: "read" }] }),
    ),
  );
  expect(marked.status).toBe(200);
  await Promise.resolve();
  expect([...new Set(wakes.mock.calls.map(([group]) => group))], "only ben's group wakes").toEqual([
    "notices:ben",
  ]);
  vi.advanceTimersByTime(MAX);
  expect(await page(await held)).toMatchObject({ notices: [], nextCursor: "1" });
  expect((await full()).notices.find((notice) => notice.noticeId === "same")?.readAtMs).toBeNull();
});

it("checks the sign-in again after a wait: a changed, revoked, or deleted account gets no page", async () => {
  const { storage, h, read, post, signOut } = await relay();
  fakeTime();
  post("n-1");
  const { parks } = parking(storage);

  // Revoked through the account's own route, from another of its sign-ins.
  let parked = parks(1);
  let held = read(`cursor=1&wait=${MAX}`, { session: "phone" });
  await parked;
  const revoked = await h(
    new Request("http://relay.test/sync/account/sessions/phone/revoke", {
      method: "POST",
      headers: { authorization: "Bearer session:ana:laptop" },
    }),
  );
  expect(revoked.status).toBe(200);
  expect((await held).status).toBe(401);

  // A deleted account's reads end when its deletion invalidates them.
  parked = parks(1);
  held = read(`cursor=1&wait=${MAX}`, { session: "tablet" });
  await parked;
  createAccountDeletionRoute({
    storage: storage as StorageContext,
    key: "bearer-test",
    fenceKey: "fence-test",
    invalidate() {},
    deleteRuntime: async () => {},
  }).fence("ana", "ana@example.test");
  h.deleteAccount("ana", [], []);
  expect(await denialBytes(await held)).toContain("404");

  // A sign-in that changed while the read waited gets no answer.
  post("b-1", { recipientUserId: "ben", senderUserId: "ben", reach: { workspaceId: "bens" } });
  parked = parks(1);
  held = read(`cursor=1&wait=${MAX}`, { userId: "ben", session: "mac" });
  await parked;
  signOut();
  post("b-2", { recipientUserId: "ben", senderUserId: "ben", reach: { workspaceId: "bens" } });
  expect((await held).status).toBe(404);
});

it("reads the page after its last sign-in check, so a scope change during that check shows", async () => {
  const { storage, read, post, holdSession } = await relay();
  post("n-1");
  // The request's own check is the first; the check before the read is the second.
  const held = holdSession(2);
  const reading = read("scope=phone&cursor=0");
  await held.reached;
  storage.setShowOnPhone({ ownerUserId: "ana", workspaceId: "trip", showOnPhone: false });
  post("n-2");
  held.release();
  expect(await page(await reading)).toMatchObject({ notices: [], nextCursor: "2" });
});

it("answers every held read when the relay closes", async () => {
  const { storage, h, read, post } = await relay();
  fakeTime();
  post("n-1");
  const { parks } = parking(storage);
  const parked = parks(1);
  const held = read(`cursor=1&wait=${MAX}`);
  await parked;
  await h.dispose();
  expect(await page(await held)).toMatchObject({ notices: [], nextCursor: "1" });
});
