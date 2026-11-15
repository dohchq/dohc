import { describe, expect, it, vi } from "vitest";
import type { AccountWorkspace } from "../server/api";
import type { NoticeRecord } from "../server/notices";
import type { WorkspaceList } from "../server/workspaceList";
import { phoneTarget, presentNotice } from "./phoneNotice";
import { noticeDetails, noticeRowAccessibility, swipesUnread } from "./rowAccessibility";

const record: NoticeRecord = {
  noticeId: "n1",
  changeSeq: 1,
  workspaceId: "w1",
  recipientShareId: null,
  kind: "agent-run",
  senderKind: "agent",
  senderLabel: "Nova",
  title: "Nova replied in #trip",
  body: "The train leaves at 8:09.",
  target: { thread: "thread-1", message: "m-1", run: "r-1" },
  createdAtMs: 1000,
  readAtMs: null,
  dismissedAtMs: null,
  expiresAtMs: 10_000,
};

const trip: AccountWorkspace = {
  workspaceId: "w1",
  name: "Trip",
  canOpen: true,
  showOnPhone: true,
};
const listed = (
  workspaces: readonly AccountWorkspace[],
  pending: readonly string[] = [],
): WorkspaceList => ({ status: "ready", workspaces, problem: null, pending: new Set(pending) });

describe("where a Notice opens on the phone", () => {
  it("opens a thread at its message in the Notice's own workspace", () => {
    expect(phoneTarget(record, listed([trip]))).toEqual({
      kind: "thread",
      workspaceId: "w1",
      threadId: "thread-1",
      messageId: "m-1",
    });
  });

  it("opens a Markdown file as a page, and leaves any other path to a computer", () => {
    expect(phoneTarget({ ...record, target: { path: "plans/day.md" } }, listed([trip]))).toEqual({
      kind: "page",
      workspaceId: "w1",
      path: "plans/day.md",
    });
    expect(
      phoneTarget({ ...record, target: { path: "budget/automations.yaml" } }, listed([trip])),
    ).toBeNull();
  });

  it("opens nothing in a workspace the phone hides, can't open, doesn't own, or is still changing", () => {
    expect(phoneTarget(record, listed([{ ...trip, showOnPhone: false }]))).toBeNull();
    expect(phoneTarget(record, listed([{ ...trip, canOpen: false }]))).toBeNull();
    expect(phoneTarget(record, listed([]))).toBeNull();
    expect(phoneTarget(record, listed([trip], ["w1"]))).toBeNull();
    expect(phoneTarget(record, { status: "loading" })).toBeNull();
    expect(
      phoneTarget({ ...record, workspaceId: null, recipientShareId: "s1" }, listed([trip])),
    ).toBeNull();
  });

  it("opens an agent's sign-in in Settings, and nothing for a share or a removed target", () => {
    expect(
      phoneTarget({ ...record, target: { settings: "agents", agent: "p-1" } }, listed([])),
    ).toEqual({ kind: "agents" });
    expect(phoneTarget({ ...record, target: { share: "s1" } }, listed([trip]))).toBeNull();
    expect(phoneTarget({ ...record, target: null }, listed([trip]))).toBeNull();
  });
});

describe("a Notice's row", () => {
  const context = { list: listed([trip]), currentWorkspaceId: "w2", open: vi.fn() };

  it("shows and copies only the title and body, and names its workspace when it isn't the open one", () => {
    const notice = presentNotice(record, context);
    expect(notice).toMatchObject({
      id: "relay:n1",
      relayId: "n1",
      title: "Nova replied in #trip",
      body: "The train leaves at 8:09.",
      folder: "Trip",
      open: "open",
      read: false,
      dismissible: true,
    });
    expect(noticeDetails(notice)).toBe("Nova replied in #trip\nThe train leaves at 8:09.");
    expect(presentNotice(record, { ...context, currentWorkspaceId: "w1" }).folder).toBeUndefined();
  });

  it("opens through the given handler only when pressed", () => {
    const open = vi.fn();
    const notice = presentNotice(record, { ...context, open });
    expect(open).not.toHaveBeenCalled();
    notice.onOpen?.();
    expect(open).toHaveBeenCalledWith(record, expect.objectContaining({ kind: "thread" }));
  });

  it("says a computer opens what the phone can't", () => {
    const notice = presentNotice({ ...record, target: { share: "s1" } }, context);
    expect(notice.elsewhere).toBe(true);
    expect(notice.onOpen).toBeUndefined();
    expect(noticeRowAccessibility(notice).label).toContain("Open on your computer");
  });

  it("offers an automation failure no Try again, Run now, or other automation action", () => {
    const failed = presentNotice(
      {
        ...record,
        kind: "automation-failed",
        senderKind: "automation",
        target: { path: "budget/automations.yaml", automation: "a1", run: "r1" },
      },
      context,
    );
    expect(failed.retry).toBeUndefined();
    expect(failed.retryTarget).toBeUndefined();
    expect(noticeRowAccessibility(failed).actions.map((action) => action.label)).toEqual([
      "Mark read",
      "Copy error details",
      "Done",
    ]);
  });

  describe("Reply on a mention", () => {
    const mention: NoticeRecord = {
      ...record,
      kind: "mention",
      senderKind: "person",
      senderLabel: "Maya Chen",
      title: "Maya Chen mentioned you in #planning",
      target: { thread: "thread-1", message: "m-1" },
    };
    const target = { workspaceId: "w1", threadId: "thread-1", messageId: "m-1" };
    const labels = (notice: ReturnType<typeof presentNotice>) =>
      noticeRowAccessibility(notice).actions.map((action) => action.label);

    it("puts Reply where Open was, through the one handler, then the marks, Copy and Done", () => {
      const reply = vi.fn();
      const open = vi.fn();
      const notice = presentNotice(mention, {
        ...context,
        open,
        reply,
        action: { kind: "reply", target },
      });
      expect(notice.open).toBe("reply");
      expect(labels(notice)).toEqual(["Reply", "Mark read", "Copy notice details", "Done"]);
      notice.onOpen?.();
      expect(reply).toHaveBeenCalledWith(mention);
      expect(open).not.toHaveBeenCalled();
    });

    it("keeps Open without a verified read, or without a Reply handler", () => {
      const open = vi.fn();
      const notice = presentNotice(mention, { ...context, open });
      expect(labels(notice)).toEqual(["Open", "Mark read", "Copy notice details", "Done"]);
      expect(notice.retryTarget).toBeUndefined();
      const unhandled = presentNotice(mention, {
        ...context,
        open,
        action: { kind: "reply", target },
      });
      expect(unhandled.open).toBe("open");
      unhandled.onOpen?.();
      expect(open).toHaveBeenCalledWith(mention, expect.objectContaining({ kind: "thread" }));
    });

    it("keeps Open, with Try again after it, when the read failed", () => {
      const retryTarget = vi.fn();
      const notice = presentNotice(mention, {
        ...context,
        retryTarget,
        action: {
          kind: "open",
          target: { kind: "thread", workspaceId: "w1", threadId: "thread-1", messageId: "m-1" },
          readFailed: true,
        },
      });
      expect(labels(notice)).toEqual([
        "Open",
        "Try again",
        "Mark read",
        "Copy notice details",
        "Done",
      ]);
      expect(noticeRowAccessibility(notice).label).toContain("dohc could not read this message.");
      notice.retryTarget?.();
      expect(retryTarget).toHaveBeenCalledWith(mention);
    });

    it("says a computer opens it when the phone can't, whatever a read showed", () => {
      const notice = presentNotice(mention, {
        ...context,
        list: listed([{ ...trip, showOnPhone: false }]),
        reply: vi.fn(),
        action: { kind: "elsewhere" },
      });
      expect(notice.elsewhere).toBe(true);
      expect(notice.onOpen).toBeUndefined();
      expect(labels(notice)).toEqual(["Mark read", "Copy notice details", "Done"]);
    });
  });

  it("offers an automation wake, should one reach the phone, no Done and no swipe", () => {
    const wake = presentNotice(
      {
        ...record,
        kind: "automation-wake",
        senderKind: "automation",
        target: { automation: "a1" },
      },
      context,
    );
    expect(wake.dismissible).toBe(false);
    expect(swipesUnread({ ...wake, read: true })).toBe(false);
    expect(noticeRowAccessibility(wake).actions.map((action) => action.label)).toEqual([
      "Copy notice details",
    ]);
  });
});
