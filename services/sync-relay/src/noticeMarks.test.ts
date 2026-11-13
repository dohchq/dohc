import { afterEach, expect, it, vi } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import {
  UnauthorizedError,
  type AccountSession,
  type ResolveAccountSession,
} from "@dohc/workspace-auth/session";
import {
  NOTICE_DISMISSED_RETENTION_MS,
  NOTICE_MARKS_MAX_BODY_BYTES,
  NOTICE_READ_RETENTION_MS,
  NOTICE_UNREAD_RETENTION_MS,
  type AutomationWake,
} from "@dohc/workspace-contracts/relay";
import { NOTICE_MARKS_RECEIPT_MS } from "./noticeRoutes";
import type { SyncRelayStorage } from "./storage";
import type { PostNoticeInput } from "./storage/notices";
import {
  closeTestStorages,
  denialBytes,
  inspectDatabase,
  jsonBody,
  request,
  storagePath,
  testHandler,
  testStorage,
} from "./testing";

// The owner's phone marks its Notices with `POST /sync/notices/marks?scope=phone`; a computer marks them without scope.

afterEach(async () => {
  vi.useRealTimers();
  await closeTestStorages();
});

const NOW = 50_000_000;
const DAY = 24 * 60 * 60 * 1000;

async function relay() {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: "trip", ownerUserId: "ana", createdAtMs: 1 });
  storage.claimWorkspace({ workspaceId: "bens", ownerUserId: "ben", createdAtMs: 1 });
  let clock = NOW;
  // `Bearer session:<user>:<session>` is a valid sign-in, under `rename` while it is set. `holdSession(n)` holds the
  // nth sign-in check from now until its release.
  let rename: string | null = null;
  let checks = 0;
  let held: { at: number; reached(): void; open: Promise<void> } | null = null;
  const resolveAccountSession: ResolveAccountSession = async (incoming) => {
    const match = /^Bearer session:([\w-]+):([\w-]+)$/u.exec(
      incoming.headers.get("authorization") ?? "",
    );
    if (!match) throw new UnauthorizedError();
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
  const h = testHandler(storage, {
    resolveAccountSession,
    nowMs: () => clock,
    accountOperationRateLimiter: new TokenBucketLimiter(10_000, 1, 16),
  });
  const phone = (
    body: unknown,
    input: { userId?: string; query?: string; headers?: Record<string, string> } = {},
  ) =>
    h(
      new Request(`http://relay.test/sync/notices/marks?${input.query ?? "scope=phone"}`, {
        method: "POST",
        headers: {
          authorization: `Bearer session:${input.userId ?? "ana"}:phone`,
          "content-type": "application/json",
          ...input.headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  const computer = (body: unknown, userId = "ana") =>
    h(request(userId, "/sync/notices/marks", jsonBody(body)));
  const post = (noticeId: string, overrides: Partial<PostNoticeInput> = {}) =>
    storage.postNotice({
      noticeId,
      recipientUserId: "ana",
      reach: { workspaceId: "trip" },
      kind: "mention",
      title: `Title ${noticeId}`,
      body: "",
      target: {},
      originInstallId: "install-a",
      senderUserId: "ana",
      senderLabel: "Ana",
      nowMs: clock,
      ...overrides,
    });
  // A row of the whole list as it stands, as a computer reads it.
  const row = (noticeId: string, userId = "ana") =>
    storage
      .readNoticeChanges({ recipientUserId: userId, cursor: null, limit: 200, nowMs: clock })
      .notices.find((notice) => notice.noticeId === noticeId);
  return {
    storage,
    h,
    phone,
    computer,
    post,
    row,
    holdSession,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    signOut: () => {
      rename = "another";
    },
  };
}

// Takes the handler's answer or its pending promise, as the helpers return it.
async function ok(
  answer: Response | Promise<Response>,
): Promise<{ ok: true; dismissed: string[] }> {
  const response = await answer;
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { ok: true; dismissed: string[] };
}

function count(storage: SyncRelayStorage, table: string): number {
  const db = inspectDatabase(storagePath(storage));
  try {
    return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  } finally {
    db.close();
  }
}

const wake: AutomationWake = {
  automationId: "collection:c1#digest",
  name: "Digest",
  depth: 1,
  body: "Summarize the day",
};
function postWake(storage: SyncRelayStorage, nowMs: number): string {
  return storage.postAutomationWake({
    workspaceId: "trip",
    ownerUserId: "ana",
    effectId: "effect-1",
    claimId: "claim-1",
    keySeed: "seed-1",
    startedAtMs: nowMs,
    wake,
    senderLabel: "Digest",
    nowMs,
  }).noticeId;
}

it("clears only the mark it names, and starts the row's retention again by the state it leaves", async () => {
  const f = await relay();
  for (const id of ["unread", "both", "restore-read", "restore-unread"]) f.post(id);
  f.advance(1_000);
  const markedAt = f.now();
  await ok(
    f.computer({
      marks: [
        { noticeId: "unread", mark: "read" },
        { noticeId: "both", mark: "read" },
        { noticeId: "both", mark: "dismissed" },
        { noticeId: "restore-read", mark: "read" },
        { noticeId: "restore-read", mark: "dismissed" },
        { noticeId: "restore-unread", mark: "dismissed" },
      ],
    }),
  );
  f.advance(DAY);
  const at = f.now();
  const head = f.storage.noticeHead("ana");
  const inverse = {
    marks: [
      { noticeId: "unread", mark: "unread" },
      { noticeId: "both", mark: "unread" },
      { noticeId: "restore-read", mark: "restore" },
      { noticeId: "restore-unread", mark: "restore" },
    ],
  };
  expect(await ok(f.phone(inverse))).toEqual({ ok: true, dismissed: [] });
  expect(f.storage.noticeHead("ana")).toBe(head + 4);
  expect(f.row("unread")).toMatchObject({
    readAtMs: null,
    dismissedAtMs: null,
    expiresAtMs: at + NOTICE_UNREAD_RETENTION_MS,
  });
  // Unread alone doesn't undo Done.
  expect(f.row("both")).toMatchObject({
    readAtMs: null,
    dismissedAtMs: markedAt,
    expiresAtMs: at + NOTICE_DISMISSED_RETENTION_MS,
  });
  // Undo sends restore, which brings the row back as it was before Done.
  expect(f.row("restore-read")).toMatchObject({
    readAtMs: markedAt,
    dismissedAtMs: null,
    expiresAtMs: at + NOTICE_READ_RETENTION_MS,
  });
  expect(f.row("restore-unread")).toMatchObject({
    readAtMs: null,
    dismissedAtMs: null,
    expiresAtMs: at + NOTICE_UNREAD_RETENTION_MS,
  });

  // A replay changes nothing and starts no retention again.
  const rows = ["unread", "both", "restore-read", "restore-unread"].map((id) => f.row(id));
  f.advance(DAY);
  await ok(f.phone(inverse));
  expect(f.storage.noticeHead("ana")).toBe(head + 4);
  expect(["unread", "both", "restore-read", "restore-unread"].map((id) => f.row(id))).toEqual(rows);

  // The phone's read and dismissed mark as a computer's do.
  await ok(
    f.phone({
      marks: [
        { noticeId: "unread", mark: "read" },
        { noticeId: "restore-unread", mark: "dismissed" },
      ],
    }),
  );
  expect(f.row("unread")).toMatchObject({
    readAtMs: f.now(),
    expiresAtMs: f.now() + NOTICE_READ_RETENTION_MS,
  });
  expect(f.row("restore-unread")).toMatchObject({ dismissedAtMs: f.now() });
});

it("brings back nothing the relay no longer holds, lost access, or another account's row", async () => {
  const f = await relay();
  f.post("expired");
  await ok(f.computer({ marks: [{ noticeId: "expired", mark: "dismissed" }] }));
  f.advance(NOTICE_DISMISSED_RETENTION_MS + 1);
  // Ben has a row under an ID Ana's list doesn't hold.
  f.post("same", { recipientUserId: "ben", senderUserId: "ben", reach: { workspaceId: "bens" } });
  await ok(f.computer({ marks: [{ noticeId: "same", mark: "read" }] }, "ben"));
  const ben = f.row("same", "ben");
  const head = f.storage.noticeHead("ana");
  await ok(
    f.phone({
      marks: [
        { noticeId: "expired", mark: "restore" },
        { noticeId: "nowhere", mark: "restore" },
        { noticeId: "same", mark: "unread" },
      ],
    }),
  );
  expect(f.storage.noticeHead("ana")).toBe(head);
  expect(f.row("expired")).toBeUndefined();
  expect(f.row("same", "ben")).toEqual(ben);

  // A share's row that lost its target keeps it lost.
  f.storage.createShare({
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
  f.post("shared", { reach: { shareId: "share-ben" }, target: { path: "notes/list.md" } });
  expect(f.row("shared")?.target).toEqual({ path: "notes/list.md" });
  expect(f.storage.revokeShare("share-ben", f.now())).toBe(true);
  expect(f.row("shared")?.target).toBeNull();
  await ok(f.computer({ marks: [{ noticeId: "shared", mark: "dismissed" }] }));
  await ok(f.phone({ marks: [{ noticeId: "shared", mark: "restore" }] }));
  expect(f.row("shared")).toMatchObject({ dismissedAtMs: null, target: null });
});

it("keeps first-dismissal receipts through a restore, so no later dismissal is first", async () => {
  const f = await relay();
  f.post("skip");
  const dismiss = (installId: string) =>
    f.computer({ marks: [{ noticeId: "skip", mark: "dismissed" }], installId });
  expect((await ok(dismiss("laptop"))).dismissed).toEqual(["skip"]);
  const receipts = count(f.storage, "sync_relay_notice_dismissals");
  await ok(f.phone({ marks: [{ noticeId: "skip", mark: "restore" }] }));
  expect(f.row("skip")?.dismissedAtMs).toBeNull();
  expect(count(f.storage, "sync_relay_notice_dismissals")).toBe(receipts);
  expect((await ok(dismiss("desktop"))).dismissed).toEqual([]);
  await ok(f.phone({ marks: [{ noticeId: "skip", mark: "restore" }] }));
  expect(
    (await ok(f.phone({ marks: [{ noticeId: "skip", mark: "dismissed" }] }))).dismissed,
  ).toEqual([]);
  // The computer that dismissed it first still hears so when it asks again.
  expect((await ok(dismiss("laptop"))).dismissed).toEqual(["skip"]);
  expect(count(f.storage, "sync_relay_notice_dismissals")).toBe(receipts);
});

it("skips an automation wake in a phone batch and marks the rest, and no mark brings back a consumed wake", async () => {
  const f = await relay();
  const wakeId = postWake(f.storage, f.now());
  f.post("n-1");
  const before = f.row(wakeId);
  expect(before?.wake).toEqual(wake);
  const answer = await ok(
    f.phone({
      marks: [
        { noticeId: wakeId, mark: "dismissed" },
        { noticeId: "n-1", mark: "dismissed" },
        { noticeId: wakeId, mark: "unread" },
        { noticeId: wakeId, mark: "restore" },
      ],
    }),
  );
  expect(answer.dismissed).toEqual(["n-1"]);
  expect(f.row("n-1")?.dismissedAtMs).toBe(f.now());
  expect(f.row(wakeId)).toEqual(before);

  // Read all still reads it, and it keeps waiting.
  await ok(f.phone({ marks: [{ noticeId: wakeId, mark: "read" }] }));
  expect(f.row(wakeId)).toMatchObject({
    readAtMs: f.now(),
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    wake,
  });

  // The computer consuming it dismisses it first, once.
  expect(
    (
      await ok(
        f.computer({ marks: [{ noticeId: wakeId, mark: "dismissed" }], installId: "laptop" }),
      )
    ).dismissed,
  ).toEqual([wakeId]);
  const receipts = count(f.storage, "sync_relay_automation_wake_receipts");
  await ok(
    f.phone({
      marks: [
        { noticeId: wakeId, mark: "restore" },
        { noticeId: wakeId, mark: "unread" },
      ],
    }),
  );
  const after = f.row(wakeId);
  expect(after?.dismissedAtMs).not.toBeNull();
  expect(after?.wake).toBeUndefined();
  expect(count(f.storage, "sync_relay_automation_wakes")).toBe(0);
  expect(count(f.storage, "sync_relay_automation_wake_receipts")).toBe(receipts);
});

it("takes exactly the fields each sender may send, within its bounds, and changes nothing otherwise", async () => {
  const f = await relay();
  f.post("n-1");
  const head = f.storage.noticeHead("ana");
  const mark = { noticeId: "n-1", mark: "read" };
  const refusedFromPhone: Array<{ body: unknown; query?: string }> = [
    { body: { marks: [mark], installId: "phone" } },
    { body: { marks: [mark], accountId: "ben" } },
    { body: { marks: [{ ...mark, withdraw: true }] } },
    { body: { marks: [{ ...mark, recipientUserId: "ben" }] } },
    { body: { marks: [{ noticeId: "n-1", mark: "archive" }] } },
    { body: { marks: [{ noticeId: "", mark: "read" }] } },
    { body: { marks: [] } },
    { body: { marks: Array.from({ length: 101 }, () => mark) } },
    { body: [mark] },
    { body: "not json" },
    { body: { marks: [mark] }, query: "scope=desktop" },
  ];
  for (const { body, query } of refusedFromPhone) {
    const response = await f.phone(body, query === undefined ? {} : { query });
    expect(response.status, JSON.stringify(body)).toBe(400);
  }
  const oversized = await f.phone(
    `{"marks":[{"noticeId":"${"a".repeat(NOTICE_MARKS_MAX_BODY_BYTES)}","mark":"read"}]}`,
  );
  expect([oversized.status, ((await oversized.json()) as { code?: string }).code]).toEqual([
    413,
    "payload_too_large",
  ]);

  for (const body of [
    { marks: [mark], userId: "ben" },
    { marks: [{ ...mark, recipientUserId: "ben" }] },
    { marks: [{ ...mark, withdraw: true }] },
    { marks: [{ noticeId: "n-1", mark: "unread" }] },
    { marks: [{ noticeId: "n-1", mark: "restore" }] },
    { marks: [mark], installId: "" },
  ]) {
    const response = await f.computer(body);
    expect(response.status, JSON.stringify(body)).toBe(400);
  }

  // Only the account's own Bearer session marks for the phone.
  const missing = await denialBytes(
    await f.phone({ marks: [mark] }, { headers: { cookie: "session=x" } }),
  );
  expect(
    (await f.h(request("ana", "/sync/notices/marks?scope=phone", jsonBody({ marks: [mark] }))))
      .status,
  ).toBe(401);
  const without = testHandler(f.storage, { nowMs: () => NOW });
  expect(
    await denialBytes(
      await without(
        new Request("http://relay.test/sync/notices/marks?scope=phone", {
          method: "POST",
          headers: { authorization: "Bearer session:ana:phone" },
          body: JSON.stringify({ marks: [mark] }),
        }),
      ),
    ),
  ).toBe(missing);

  expect(f.storage.noticeHead("ana")).toBe(head);
  expect(f.row("n-1")).toMatchObject({ readAtMs: null, dismissedAtMs: null });
});

it("changes nothing when the sign-in changed while the body arrived", async () => {
  const f = await relay();
  f.post("n-1");
  // The request's own check is the first; the check after the body is the second.
  const held = f.holdSession(2);
  const marking = f.phone({ marks: [{ noticeId: "n-1", mark: "dismissed" }] });
  await held.reached;
  f.signOut();
  held.release();
  expect((await marking).status).toBe(404);
  expect(f.row("n-1")?.dismissedAtMs).toBeNull();
});

it("refuses a body that stops arriving at its deadline, cancels its stream, and changes nothing", async () => {
  const f = await relay();
  f.post("n-1");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let cancelled = false;
  let reached!: () => void;
  const stalled = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"marks":[{"noticeId":"n-1","mark":"dis'));
    },
    // The route read the prefix and asks for more, which never comes.
    pull() {
      reached();
      return new Promise<void>(() => undefined);
    },
    cancel() {
      cancelled = true;
    },
  });
  const answer = f.h(
    new Request("http://relay.test/sync/notices/marks?scope=phone", {
      method: "POST",
      headers: { authorization: "Bearer session:ana:phone", "content-type": "application/json" },
      duplex: "half",
      body,
    } as RequestInit & { duplex: "half" }),
  );
  await stalled;
  vi.advanceTimersByTime(NOTICE_MARKS_RECEIPT_MS - 1);
  expect(cancelled).toBe(false);
  vi.advanceTimersByTime(1);
  expect((await answer).status).toBe(400);
  expect(cancelled).toBe(true);
  expect(f.row("n-1")).toMatchObject({ dismissedAtMs: null });
});
