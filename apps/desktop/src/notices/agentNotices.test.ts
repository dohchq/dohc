import { describe, expect, it } from "vitest";
import type { NoticeRow, WorkspaceSummary } from "../ipc/bridgeContract";
import { agentNotices } from "./agentNotices";
import { ACCESS_ENDED_NOTE } from "./noticeTarget";

function workspace(workspaceId: string, extra: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return { workspaceId, rootPath: `/home/ana/${workspaceId}`, kind: "personal", mode: "local-first", ...extra };
}

function row(noticeId: string, extra: Partial<NoticeRow> = {}): NoticeRow {
  return {
    store: "account", noticeId, kind: "mention", workspaceId: "trip", recipientShareId: null,
    senderKind: "person", senderLabel: "Bea", title: "Bea mentioned you", body: "See day 1",
    target: { path: "plans/day-1.md" }, createdAtMs: 1_000, readAtMs: null, postedHere: false, ...extra,
  };
}

const trip = workspace("trip", { shareMounts: [{ shareId: "share-1", label: "owner", granterEmail: null }] });
const notes = workspace("notes");

describe("the Notices an agent reads", () => {
  it("lists only rows that open in the caller's workspace, newest first", () => {
    const rows = [
      row("here-old"),
      row("here-new", { createdAtMs: 3_000, readAtMs: 3_500 }),
      row("other-workspace", { workspaceId: "notes" }),
      row("not-on-this-computer", { workspaceId: "gone" }),
      row("mounted-share", { workspaceId: null, recipientShareId: "share-1", target: { path: "trip/day-2.md" }, createdAtMs: 2_000 }),
      row("unadded-share", { workspaceId: null, recipientShareId: "share-9", target: { path: "x.md" } }),
      row("no-workspace", { workspaceId: null, recipientShareId: null }),
    ];
    const listed = agentNotices(rows, [trip, notes], "trip");
    expect(listed.map(({ id }) => id)).toEqual(["here-new", "mounted-share", "here-old"]);
    expect(listed[0]).toMatchObject({ read: true, opens: { to: "file", path: "plans/day-1.md" } });
    expect(listed[1]?.opens).toEqual({ to: "file", path: "shared-with-me/owner/trip/day-2.md" });
    expect(agentNotices(rows, [trip, notes], "notes").map(({ id }) => id)).toEqual(["other-workspace"]);
  });

  it("opens a reply at its message, and carries the row's words and sender", () => {
    const reply = row("reply", {
      kind: "agent-run", senderKind: "agent", senderLabel: "Nova", target: { thread: "thread-1", message: "message-2" },
    });
    expect(agentNotices([reply], [trip], "trip")).toEqual([{
      id: "reply", kind: "agent-run", title: "Bea mentioned you", body: "See day 1",
      sender: { kind: "agent", label: "Nova" }, createdAtMs: 1_000, read: false,
      opens: { to: "chat", thread: "thread-1", message: "message-2" },
    }]);
  });

  it("says access ended for this workspace's row, and keeps another workspace's to itself", () => {
    const ended = [row("ended", { target: null }), row("ended-elsewhere", { target: null, workspaceId: "notes" })];
    expect(agentNotices(ended, [trip, notes], "trip"))
      .toEqual([expect.objectContaining({ id: "ended", opens: null, note: ACCESS_ENDED_NOTE })]);
  });

  it("shows a row with nowhere to go without an opens", () => {
    expect(agentNotices([row("bare", { target: {}, senderKind: null, senderLabel: null })], [trip], "trip"))
      .toEqual([expect.objectContaining({ id: "bare", opens: null, sender: null })]);
  });
});
