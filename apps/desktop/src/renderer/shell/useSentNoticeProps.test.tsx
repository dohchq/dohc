// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoticeRow, WorkspaceSummary } from "../../ipc/bridgeContract";
import { ACCESS_ENDED_NOTE, NOT_HERE_NOTE, useSentNoticeProps } from "./useSentNoticeProps";
import type { SentNotices } from "./useSentNotices";

function notice(overrides: Partial<NoticeRow> = {}): NoticeRow {
  return {
    store: "account",
    noticeId: "n1",
    kind: "automation-notify",
    workspaceId: null,
    recipientShareId: "share-1",
    senderKind: "automation",
    senderLabel: "Owner",
    title: "Weekday report is ready",
    body: "",
    target: { path: "Trips/Japan/report.md" },
    createdAtMs: 1_000,
    readAtMs: null,
    ...overrides,
  };
}

function workspace(workspaceId: string, extra: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return { workspaceId, rootPath: `/home/ana/${workspaceId}`, kind: "personal", mode: "local-first", ...extra };
}

const getRelayReceivedShare = vi.fn();
beforeEach(() => vi.stubGlobal("dohcDesktop", { getRelayReceivedShare }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function setup(notices: NoticeRow[], workspaces: WorkspaceSummary[], workspaceId = "notes") {
  const sentNotices: SentNotices = {
    notices,
    toast: null,
    hideToast: vi.fn(),
    read: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined),
  };
  const input = {
    sentNotices,
    workspaceId,
    workspaces,
    openFile: vi.fn(),
    onSwitchWorkspace: vi.fn(),
    onOpenShare: vi.fn(),
    reportShellError: vi.fn(),
  };
  const { result } = renderHook(() => useSentNoticeProps(input));
  return { ...input, sentNotices, result };
}

describe("opening a sent notice", () => {
  it("marks it read and opens its file in this workspace", async () => {
    const here = workspace("notes", { shareMounts: [{ shareId: "share-1", label: "owner", granterEmail: null }] });
    const { result, sentNotices, openFile, onSwitchWorkspace } = setup([notice()], [here]);
    expect(result.current.sentNotices).toEqual([{ notice: notice(), folder: null, openable: true }]);
    await expect(result.current.onOpenSentNotice(notice())).resolves.toBeNull();
    expect(sentNotices.read).toHaveBeenCalledWith([{ store: "account", noticeId: "n1" }]);
    expect(openFile).toHaveBeenCalledWith("shared-with-me/owner/Trips/Japan/report.md");
    expect(onSwitchWorkspace).not.toHaveBeenCalled();
  });

  it("names the Collection folder and switches to the workspace that holds the notice", async () => {
    const view = workspace("trip-view", { shareView: { shareId: "share-1", granterEmail: null } });
    const { result, onSwitchWorkspace } = setup([notice()], [workspace("notes"), view]);
    expect(result.current.sentNotices[0]?.folder).toBe("Japan");
    await expect(result.current.onOpenSentNotice(notice())).resolves.toBeNull();
    expect(onSwitchWorkspace).toHaveBeenCalledWith(view, "Trips/Japan/report.md");
  });

  it("offers to add a share this computer does not hold", async () => {
    getRelayReceivedShare.mockResolvedValueOnce({
      found: true,
      share: {
        shareId: "share-1", granterEmail: "owner@example.com", genericChatWritable: false, grantId: "g1",
        generation: 1, createdAtMs: 1, shareCode: "code-1", selector: { paths: ["Trips"], versionId: null }, access: "edit",
      },
    });
    const { result, onOpenShare } = setup([notice()], [workspace("notes")]);
    await expect(result.current.onOpenSentNotice(notice())).resolves.toBeNull();
    expect(getRelayReceivedShare).toHaveBeenCalledWith({ shareId: "share-1" });
    expect(onOpenShare).toHaveBeenCalledWith({
      resolvedShare: { shareId: "share-1", shareCode: "code-1" },
      liveEditing: true,
    });
  });

  it("says access ended when the target was cleared or the share is gone", async () => {
    const ended = notice({ target: null });
    const { result, sentNotices, openFile } = setup([ended], [workspace("notes")]);
    expect(result.current.sentNotices[0]).toEqual({ notice: ended, folder: null, openable: true });
    await expect(result.current.onOpenSentNotice(ended)).resolves.toBe(ACCESS_ENDED_NOTE);
    expect(sentNotices.read).toHaveBeenCalledTimes(1);
    expect(openFile).not.toHaveBeenCalled();

    getRelayReceivedShare.mockResolvedValueOnce({ found: false });
    await expect(result.current.onOpenSentNotice(notice())).resolves.toBe(ACCESS_ENDED_NOTE);
  });

  it("says when the workspace is not on this computer", async () => {
    const mine = notice({ workspaceId: "trip", recipientShareId: null });
    const { result } = setup([mine], [workspace("notes")]);
    await expect(result.current.onOpenSentNotice(mine)).resolves.toBe(NOT_HERE_NOTE);
  });

  it("has no Open for a notice about no workspace", () => {
    const server = notice({ store: "local", workspaceId: null, recipientShareId: null, senderKind: null, target: {} });
    const { result } = setup([server], [workspace("notes")]);
    expect(result.current.sentNotices[0]?.openable).toBe(false);
  });

  it("marks only unread notices on Mark all read, and reports a failure with Try again", async () => {
    const { result, sentNotices, reportShellError } = setup(
      [notice({ noticeId: "a" }), notice({ noticeId: "b", readAtMs: 5 })],
      [workspace("notes")],
    );
    vi.mocked(sentNotices.read).mockRejectedValueOnce(new Error("disk full"));
    await act(async () => result.current.onReadAllSentNotices());
    expect(sentNotices.read).toHaveBeenCalledWith([{ store: "account", noticeId: "a" }]);
    expect(reportShellError).toHaveBeenCalledWith("dohc could not mark notices read.", expect.any(Error), expect.any(Function));
    const retry = vi.mocked(reportShellError).mock.calls[0]?.[2];
    await act(async () => retry?.());
    expect(sentNotices.read).toHaveBeenCalledTimes(2);
  });

  it("dismisses on every computer through the list", async () => {
    const { result, sentNotices } = setup([notice()], [workspace("notes")]);
    await act(async () => result.current.onDismissSentNotice(notice()));
    expect(sentNotices.dismiss).toHaveBeenCalledWith({ store: "account", noticeId: "n1" });
  });
});
