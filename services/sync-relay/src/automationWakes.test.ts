import { NOTICE_ROWS_PER_SENDER } from "./storage/limits";
import type { StorageContext } from "./storage/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_WAKE_PREFIX, NOTICE_READ_RETENTION_MS, NOTICE_LIST_ROW_LIMIT, NOTICE_UNREAD_RETENTION_MS } from "@dohc/workspace-contracts/relay";
import { closeTestStorages, inspectDatabase, jsonBody, request, storagePath, testHandler, testStorage } from "./testing";
import { AUTOMATION_WAKE_RETRY_MS, NOTICE_DISMISSAL_RECEIPTS, noticeIdFrom, type PostNoticeInput } from "./storage/notices";

afterEach(closeTestStorages);

const workspaceId = "workspace-wake";
const wake = { automationId: "collection:Tasks#ask", name: "Ask", depth: 3, body: "Check the task." };

async function world() {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId, ownerUserId: "owner", createdAtMs: 1 });
  let clock = 10_000;
  const handler = testHandler(storage, { nowMs: () => clock });
  const post = (effectId = "claim/hash/0/wake", startedAtMs = 10_000) => storage.postAutomationWake({
    workspaceId, ownerUserId: "owner", claimId: "claim", keySeed: "hash", effectId, wake, senderLabel: "Ice", nowMs: clock, startedAtMs,
  }).noticeId;
  const list = (user = "owner") => storage.readNoticeChanges({ recipientUserId: user, cursor: null, limit: 200, nowMs: clock }).notices;
  const dismiss = async (noticeId: string, user: string, installId?: string) => {
    const response = await handler(request(user, "/sync/notices/marks", jsonBody({
      marks: [{ noticeId, mark: "dismissed" }], ...(installId === undefined ? {} : { installId }),
    })));
    expect(response.status).toBe(200);
    return (await response.json() as { dismissed: string[] }).dismissed;
  };
  return { storage, handler, post, list, dismiss, advance: (by: number) => { clock += by; } };
}

function seedOrdinaryNotices(storage: Awaited<ReturnType<typeof world>>["storage"], input: PostNoticeInput, count: number, timeStepMs: 0 | 1): void {
  storage.postNotice(input);
  const storedId = (id: string) => input.senderUserId === input.recipientUserId ? id : noticeIdFrom(input.senderUserId, id);
  const context = storage as StorageContext;
  context.tx(() => {
    const head = Number(context.db.prepare("SELECT change_seq FROM sync_relay_notice_lists WHERE recipient_user_id = ?")
      .get(input.recipientUserId)!.change_seq);
    const insert = context.db.prepare(`INSERT INTO sync_relay_notices (
      recipient_user_id, notice_id, change_seq, workspace_id, recipient_share_id,
      kind, sender_kind, sender_user_id, sender_label, title, body, target_json,
      origin_install_id, created_at_ms, read_at_ms, dismissed_at_ms, expires_at_ms, removed_at_ms
    ) SELECT recipient_user_id, ?, ?, workspace_id, recipient_share_id,
      kind, sender_kind, sender_user_id, sender_label, title, body, target_json,
      origin_install_id, created_at_ms + ?, read_at_ms, dismissed_at_ms, expires_at_ms + ?, removed_at_ms
      FROM sync_relay_notices WHERE recipient_user_id = ? AND notice_id = ?`);
    for (let i = 1; i < count; i++) {
      const elapsed = i * timeStepMs;
      expect(Number(insert.run(storedId(`${input.noticeId}-${i}`), head + i, elapsed, elapsed,
        input.recipientUserId, storedId(input.noticeId)).changes)).toBe(1);
    }
    context.db.prepare("UPDATE sync_relay_notice_lists SET change_seq = ? WHERE recipient_user_id = ?")
      .run(head + count - 1, input.recipientUserId);
  });
}

describe("relay-only agent wake notices", () => {
  it("rejects public wake kinds and reserved IDs, including self posts", async () => {
    const w = await world();
    for (const user of ["owner", "collaborator"]) {
      for (const fields of [{ kind: "automation-wake", noticeId: "forged" },
        { kind: "automation-notify", noticeId: AUTOMATION_WAKE_PREFIX + "a".repeat(64) }]) {
        const response = await w.handler(request(user, "/sync/notices", jsonBody({
          workspaceId, recipientUserId: user, originInstallId: "laptop",
          title: "Forged", body: "", target: {}, ...fields, wake,
        })));
        expect(response.status).toBe(400);
      }
    }
    expect(w.list()).toEqual([]);
  });

  it("derives the recipient from workspace ownership and gives only one owner's computer the wake", async () => {
    const w = await world();
    expect(() => w.storage.postAutomationWake({
      workspaceId, ownerUserId: "collaborator", claimId: "claim", keySeed: "hash", effectId: "forged", startedAtMs: 10_000, wake, senderLabel: "Ana", nowMs: 10_000,
    })).toThrow();
    w.post();
    w.post();
    expect(w.list()).toHaveLength(1);
    const notice = w.list()[0]!;
    expect(notice.wake).toEqual(wake);
    expect(w.list("collaborator")).toEqual([]);
    expect(await w.dismiss(notice.noticeId, "collaborator", "laptop")).toEqual([]);
    expect(await w.dismiss(notice.noticeId, "owner", "server")).toEqual([]);
    const results = await Promise.all([
      w.dismiss(notice.noticeId, "owner", "laptop"),
      w.dismiss(notice.noticeId, "owner", "desktop"),
    ]);
    expect(results.filter((ids) => ids.length)).toHaveLength(1);
    expect(await w.dismiss(notice.noticeId, "owner", "laptop")).toEqual(results[0]);
    expect(await w.dismiss(notice.noticeId, "owner", "desktop")).toEqual(results[1]);
    expect(w.list()[0]!.wake).toBeUndefined();
  });

  it("keeps wake receipts through ordinary receipt reclamation", async () => {
    const w = await world();
    w.post();
    const id = w.list()[0]!.noticeId;
    expect(await w.dismiss(id, "owner", "laptop")).toEqual([id]);
    const db = inspectDatabase(storagePath(w.storage));
    try {
      db.exec("BEGIN");
      const insert = db.prepare("INSERT INTO sync_relay_notice_dismissals VALUES ('owner', ?, 20000, 'desktop')");
      for (let i = 0; i < NOTICE_DISMISSAL_RECEIPTS; i++) insert.run("other-" + i);
      db.exec("COMMIT");
    } finally { db.close(); }
    w.storage.postNotice({
      noticeId: "quota", recipientUserId: "owner", senderUserId: "owner", senderLabel: "Ice",
      reach: { workspaceId }, kind: "mention", title: "Quota", body: "", target: {}, originInstallId: "laptop", nowMs: 20_000,
    });
    await w.dismiss("quota", "owner", "laptop");
    w.advance(1_000);
    w.post();
    expect(w.list().filter((notice) => notice.wake)).toEqual([]);
    expect(await w.dismiss(id, "owner", "desktop")).toEqual([]);
    expect(await w.dismiss(id, "owner", "laptop")).toEqual([id]);
  });

  it("refuses dismissal without a consuming computer and keeps the wake", async () => {
    const w = await world();
    w.post();
    const id = w.list()[0]!.noticeId;
    const response = await w.handler(request("owner", "/sync/notices/marks", jsonBody({ marks: [{ noticeId: id, mark: "dismissed" }] })));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "Only a computer consuming this agent wake can dismiss it." });
    expect(w.list()[0]!.wake).toEqual(wake);
    expect(await w.dismiss(id, "owner", "laptop")).toEqual([id]);
  });

  it("consumes only the latest of a weekend of hourly wakes and rejects replays", async () => {
    const w = await world();
    const ids: string[] = [];
    for (let hour = 0; hour < 72; hour++) {
      ids.push(w.post("run-" + hour));
      w.advance(60 * 60 * 1000);
    }
    for (let hour = 0; hour < 71; hour++) w.post("run-" + hour);
    expect(w.list().filter((notice) => notice.wake)).toHaveLength(1);
    let consumed = 0;
    for (const id of ids) consumed += (await w.dismiss(id, "owner", "laptop")).length;
    expect(consumed).toBe(1);
    const db = inspectDatabase(storagePath(w.storage));
    try {
      expect(db.prepare("SELECT count(*) AS n FROM sync_relay_automation_wake_receipts WHERE superseded_by IS NOT NULL").get()?.n).toBe(71);
    } finally { db.close(); }
  });

  it("keeps different record bodies and collapses only identical bodies", async () => {
    const w = await world();
    const ids = ["A", "B", "C", "A"].map((record, i) => w.storage.postAutomationWake({
      workspaceId, ownerUserId: "owner", claimId: "claim", keySeed: "hash", effectId: "record-" + i, startedAtMs: 10_000,
      wake: { ...wake, body: "Check task " + record }, senderLabel: "Ice", nowMs: 10_000,
    }).noticeId);
    expect(w.list().filter((row) => row.wake).map((row) => row.wake!.body)).toEqual([
      "Check task B", "Check task C", "Check task A",
    ]);
    expect(await w.dismiss(ids[0]!, "owner", "laptop")).toEqual([]);
    for (const id of ids.slice(1)) expect(await w.dismiss(id, "owner", "laptop")).toEqual([id]);
  });

  it.each(["deleted", "transferred"])("tombstones parked wakes when their workspace is %s", async (change) => {
    const w = await world();
    const id = w.post();
    const before = w.storage.readNoticeChanges({ recipientUserId: "owner", cursor: null, limit: 200, nowMs: 10_000 });
    const db = inspectDatabase(storagePath(w.storage));
    try {
      db.prepare(change === "deleted" ? "DELETE FROM sync_relay_workspaces WHERE workspace_id = ?"
        : "UPDATE sync_relay_workspaces SET owner_user_id = 'other' WHERE workspace_id = ?").run(workspaceId);
    } finally { db.close(); }
    const after = w.storage.readNoticeChanges({ recipientUserId: "owner", cursor: { seq: Number(before.nextCursor), snapshotHead: null }, limit: 200, nowMs: 10_001 });
    expect(after.notices).toEqual([expect.objectContaining({ noticeId: id, removed: true, body: "", target: null })]);
    expect(after.notices[0]!.wake).toBeUndefined();
    expect(w.list()).toEqual([]);
    const inspect = inspectDatabase(storagePath(w.storage));
    try { expect(inspect.prepare("SELECT count(*) AS n FROM sync_relay_automation_wakes").get()?.n).toBe(0); }
    finally { inspect.close(); }
  });

  it("keeps Read all marks when a wake belongs to a former owner", async () => {
    const w = await world();
    w.storage.postNotice({ noticeId: "ordinary", recipientUserId: "owner", senderUserId: "owner", senderLabel: "Ice",
      reach: { workspaceId }, kind: "mention", title: "Ordinary", body: "", target: {}, originInstallId: "laptop", nowMs: 10_000 });
    const id = w.post();
    const db = inspectDatabase(storagePath(w.storage));
    try { db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'other' WHERE workspace_id = ?").run(workspaceId); }
    finally { db.close(); }
    expect(() => w.storage.markNotices({ recipientUserId: "owner", nowMs: 10_001,
      marks: [{ noticeId: "ordinary", mark: "read" }, { noticeId: id, mark: "read" }],
    })).not.toThrow();
    expect(() => w.storage.markNotices({ recipientUserId: "owner", installId: "laptop", nowMs: 10_001,
      marks: [{ noticeId: id, mark: "dismissed" }],
    })).toThrow("notice refused");
    expect(w.list().find((row) => row.noticeId === "ordinary")?.readAtMs).toBe(10_001);
  });

  it("keeps parked wakes through read retention and list reclamation", async () => {
    const w = await world();
    const id = w.post();
    w.storage.markNotices({ recipientUserId: "owner", marks: [{ noticeId: id, mark: "read" }], nowMs: 10_001 });
    w.advance(NOTICE_UNREAD_RETENTION_MS + NOTICE_READ_RETENTION_MS);
    const ordinary: PostNoticeInput = {
      noticeId: "ordinary-seed", recipientUserId: "owner", senderUserId: "owner", senderLabel: "Ice",
      reach: { workspaceId }, kind: "mention", title: "Ordinary", body: "", target: {}, originInstallId: "laptop",
      nowMs: 10_000 + NOTICE_UNREAD_RETENTION_MS + NOTICE_READ_RETENTION_MS,
    };
    seedOrdinaryNotices(w.storage, ordinary, NOTICE_LIST_ROW_LIMIT - 1, 0);
    const db = (w.storage as StorageContext).db;
    const liveCount = () => Number(db.prepare("SELECT count(*) AS n FROM sync_relay_notices WHERE recipient_user_id = 'owner' AND removed_at_ms IS NULL").get()!.n);
    expect(liveCount()).toBe(NOTICE_LIST_ROW_LIMIT);
    for (let i = NOTICE_LIST_ROW_LIMIT - 1; i < NOTICE_LIST_ROW_LIMIT + 1; i++) {
      w.storage.postNotice({ ...ordinary, noticeId: "ordinary-" + i });
      expect(liveCount()).toBe(NOTICE_LIST_ROW_LIMIT);
    }
    expect(w.list().find((notice) => notice.noticeId === id)?.wake).toEqual(wake);
    expect(await w.dismiss(id, "owner", "laptop")).toEqual([id]);
  }, 60_000);

  it("keeps a parked wake when its sender fills the per-sender quota", async () => {
    const w = await world();
    const id = w.post();
    const db = inspectDatabase(storagePath(w.storage));
    try {
      db.prepare("UPDATE sync_relay_notices SET sender_user_id = 'sender' WHERE notice_id = ?").run(id);
    } finally { db.close(); }
    w.storage.claimWorkspace({ workspaceId: "sender-workspace", ownerUserId: "sender", createdAtMs: 1 });
    w.storage.createShare({
      share: { shareId: "sender-share", workspaceId: "sender-workspace", granterUserId: "sender", selectorJson: JSON.stringify({ paths: ["Tasks"], versionId: null }), createdAtMs: 1 },
      grant: { grantId: "sender-grant", shareId: "sender-share", principalKind: "user", principalUserId: "owner", principalEmail: null, access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null },
    });
    const ordinary: PostNoticeInput = {
      noticeId: "sender-seed", recipientUserId: "owner", senderUserId: "sender", senderLabel: "Sender",
      reach: { workspaceId: "sender-workspace" }, kind: "automation-notify", title: "Ordinary", body: "", target: { path: "Tasks/one.md" }, originInstallId: "laptop", nowMs: 10_000,
    };
    seedOrdinaryNotices(w.storage, ordinary, NOTICE_ROWS_PER_SENDER - 1, 1);
    const raw = (w.storage as StorageContext).db;
    const senderCount = () => Number(raw.prepare("SELECT count(*) AS n FROM sync_relay_notices WHERE recipient_user_id = 'owner' AND sender_user_id = 'sender' AND removed_at_ms IS NULL").get()!.n);
    expect(senderCount()).toBe(NOTICE_ROWS_PER_SENDER);
    for (let i = NOTICE_ROWS_PER_SENDER - 1; i <= NOTICE_ROWS_PER_SENDER; i++) {
      w.storage.postNotice({ ...ordinary, noticeId: "sender-" + i, nowMs: 10_000 + i });
      expect(senderCount()).toBe(NOTICE_ROWS_PER_SENDER);
    }
    expect(w.list().find((row) => row.noticeId === id)?.wake).toEqual(wake);
  });

  it("deletes wake receipts with their workspace", async () => {
    const w = await world();
    await w.dismiss(w.post(), "owner", "laptop");
    const db = inspectDatabase(storagePath(w.storage));
    try {
      db.prepare("DELETE FROM sync_relay_workspaces WHERE workspace_id = ?").run(workspaceId);
      expect(db.prepare("SELECT count(*) AS n FROM sync_relay_automation_wake_receipts").get()?.n).toBe(0);
    } finally { db.close(); }
  });

  it("refuses a former owner's dismissal", async () => {
    const w = await world();
    const id = w.post();
    const db = inspectDatabase(storagePath(w.storage));
    try { db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'other' WHERE workspace_id = ?").run(workspaceId); }
    finally { db.close(); }
    const response = await w.handler(request("owner", "/sync/notices/marks", jsonBody({ installId: "laptop", marks: [{ noticeId: id, mark: "dismissed" }] })));
    expect(response.status).toBe(403);
  });

  it("prunes old receipts while refusing wake effects past their retry window", async () => {
    const w = await world();
    const id = w.post();
    await w.dismiss(id, "owner", "laptop");
    w.advance(AUTOMATION_WAKE_RETRY_MS + 1);
    w.post("fresh", 10_000 + AUTOMATION_WAKE_RETRY_MS + 1);
    const db = inspectDatabase(storagePath(w.storage));
    try { expect(db.prepare("SELECT 1 FROM sync_relay_automation_wake_receipts WHERE notice_id = ?").get(id)).toBeUndefined(); }
    finally { db.close(); }
    expect(() => w.post()).toThrow("too old");
    expect(w.list().filter((row) => row.wake)).toHaveLength(1);
  });

  it("prepares wake reads and marks once for a batch", async () => {
    const w = await world();
    const ids = Array.from({ length: 3 }, (_, i) => w.storage.postAutomationWake({
      workspaceId, ownerUserId: "owner", claimId: "claim", keySeed: "hash", effectId: "effect-" + i, startedAtMs: 10_000,
      wake: { ...wake, automationId: "collection:Tasks#ask-" + i }, senderLabel: "Ice", nowMs: 10_000,
    }).noticeId);
    const prepare = vi.spyOn((w.storage as unknown as StorageContext).db, "prepare");
    try {
      w.list();
      expect(prepare.mock.calls.filter(([sql]) => sql.startsWith("SELECT payload_json"))).toHaveLength(1);
      prepare.mockClear();
      w.storage.markNotices({ recipientUserId: "owner", installId: "laptop", nowMs: 10_001,
        marks: ids.map((noticeId) => ({ noticeId, mark: "dismissed" as const })),
      });
      expect(prepare.mock.calls.filter(([sql]) => sql.startsWith("DELETE FROM sync_relay_automation_wakes"))).toHaveLength(1);
      expect(prepare.mock.calls.filter(([sql]) => sql.startsWith("UPDATE sync_relay_notices SET dismissed_at_ms"))).toHaveLength(1);
      expect(prepare.mock.calls.filter(([sql]) => sql.includes("INSERT INTO sync_relay_notice_lists"))).toHaveLength(1);
    } finally { prepare.mockRestore(); }
  });

  it("rejects excess authority and invalid chain depth in a payload", async () => {
    const w = await world();
    for (const invalid of [{ ...wake, depth: 0 }, { ...wake, depth: 5 }, { ...wake, body: "x".repeat(65_537) },
      { ...wake, command: "arbitrary-runner" }]) {
      expect(() => w.storage.postAutomationWake({
        workspaceId, ownerUserId: "owner", claimId: "claim", keySeed: "hash", effectId: "bad", startedAtMs: 10_000, wake: invalid, senderLabel: "Ice", nowMs: 10_000,
      })).toThrow();
    }
    expect(w.list()).toEqual([]);
  });
});
