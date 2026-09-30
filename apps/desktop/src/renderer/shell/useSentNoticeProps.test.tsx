// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoticeRow, WorkspaceSummary } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import {
  ACCESS_ENDED_NOTE,
  AUTOMATION_NOT_HERE_NOTE,
  NOT_HERE_NOTE,
  SHARE_LOOKUP_FAILED_NOTE,
  useSentNoticeProps,
} from "./useSentNoticeProps";
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
    postedHere: false,
    ...overrides,
  };
}

function workspace(workspaceId: string, extra: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return { workspaceId, rootPath: `/home/ana/${workspaceId}`, kind: "personal", mode: "local-first", ...extra };
}

const RECEIVED = {
  found: true as const,
  share: {
    shareId: "share-1", granterEmail: "owner@example.com", genericChatWritable: false, grantId: "g1",
    generation: 1, createdAtMs: 1, shareCode: "code-1", selector: { paths: ["Trips"], versionId: null }, access: "edit" as const,
  },
};

const getRelayReceivedShare = vi.fn();
const retryAutomationNotice = vi.fn();
const retryCollectionAutomation = vi.fn(async () => ({ status: "queued", press: false }));
beforeEach(() => vi.stubGlobal("dohcDesktop", { getRelayReceivedShare, retryAutomationNotice, retryCollectionAutomation }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const live = () => new AbortController().signal;

function sentNoticesOf(notices: NoticeRow[], extra: Partial<SentNotices> = {}): SentNotices {
  return {
    account: null,
    notices,
    settled: true,
    listFailure: null,
    relist: vi.fn(),
    toast: null,
    hideToast: vi.fn(),
    read: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined),
    ...extra,
  };
}

function setup(
  notices: NoticeRow[],
  workspaces: WorkspaceSummary[],
  workspaceId = "notes",
  extra: Partial<SentNotices> = {},
) {
  const sentNotices = sentNoticesOf(notices, extra);
  const input = {
    sentNotices,
    workspaceId,
    workspaces,
    openFile: vi.fn(),
    openAutomation: vi.fn(async (_automationId: string, _run: string | null): Promise<string | null> => null),
    onSwitchWorkspace: vi.fn(),
    onOpenShare: vi.fn(),
    reportShellError: vi.fn(),
  };
  const { result } = renderHook(() => useSentNoticeProps(input));
  return { ...input, sentNotices, result };
}

describe("opening a sent notice", () => {
  it("keeps other and removed workspace refusals reachable while this shell shows its own", () => {
    const notices = ["notes", "other", "removed"].map(workspaceId => notice({kind: "sync-refusal", store: "local", workspaceId, recipientShareId: null, noticeId: workspaceId}));
    const {result} = setup(notices, [workspace("notes"), workspace("other")]);
    expect(result.current.sentNotices.map(row => row.notice.workspaceId)).toEqual(["other", "removed"]);
  });
  it("marks it read and opens its file in this workspace's shared-with-me, naming its folder", async () => {
    const here = workspace("notes", { shareMounts: [{ shareId: "share-1", label: "owner", granterEmail: null }] });
    const { result, sentNotices, openFile, onSwitchWorkspace } = setup([notice()], [here]);
    // The file comes from someone else's workspace, so the row says where.
    expect(result.current.sentNotices).toEqual([{ notice: notice(), folder: "Japan", openable: true, retryable: false }]);
    await expect(result.current.onOpenSentNotice(notice(), live())).resolves.toBeNull();
    expect(sentNotices.read).toHaveBeenCalledWith([{ store: "account", noticeId: "n1" }]);
    expect(openFile).toHaveBeenCalledWith("shared-with-me/owner/Trips/Japan/report.md");
    expect(onSwitchWorkspace).not.toHaveBeenCalled();
  });

  it("names the shared-with-me folder when the file has no Collection folder", () => {
    const here = workspace("notes", { shareMounts: [{ shareId: "share-1", label: "owner", granterEmail: null }] });
    const { result } = setup([notice({ target: { path: "report.md" } })], [here]);
    expect(result.current.sentNotices[0]?.folder).toBe("owner");
  });

  it("names no folder for a notice about this workspace's own file", () => {
    const own = notice({ workspaceId: "notes", recipientShareId: null });
    const { result } = setup([own], [workspace("notes")]);
    expect(result.current.sentNotices[0]?.folder).toBeNull();
  });

  it("switches to the workspace that holds the notice, with its file", async () => {
    const view = workspace("trip-view", { shareView: { shareId: "share-1", granterEmail: null } });
    const { result, onSwitchWorkspace } = setup([notice()], [workspace("notes"), view]);
    expect(result.current.sentNotices[0]?.folder).toBe("Japan");
    await expect(result.current.onOpenSentNotice(notice(), live())).resolves.toBeNull();
    expect(onSwitchWorkspace).toHaveBeenCalledWith(view, "Trips/Japan/report.md");
  });

  it("offers to add a share this computer does not hold, with the notice's file", async () => {
    getRelayReceivedShare.mockResolvedValueOnce(RECEIVED);
    const { result, onOpenShare } = setup([notice()], [workspace("notes")]);
    await expect(result.current.onOpenSentNotice(notice(), live())).resolves.toBeNull();
    expect(getRelayReceivedShare).toHaveBeenCalledWith({ shareId: "share-1" });
    expect(onOpenShare).toHaveBeenCalledWith({
      resolvedShare: { shareId: "share-1", shareCode: "code-1" },
      liveEditing: true,
      path: "Trips/Japan/report.md",
    });
  });

  it("opens nothing when the lookup answers after Open was cancelled", async () => {
    const lookup = deferred<typeof RECEIVED>();
    getRelayReceivedShare.mockReturnValueOnce(lookup.promise);
    const { result, onOpenShare } = setup([notice()], [workspace("notes")]);
    const controller = new AbortController();
    const opened = result.current.onOpenSentNotice(notice(), controller.signal);
    controller.abort();
    lookup.resolve(RECEIVED);
    await opened;
    expect(onOpenShare).not.toHaveBeenCalled();
  });

  it("says on the row when the share lookup fails, rather than a separate error", async () => {
    getRelayReceivedShare.mockRejectedValueOnce(new Error("relay unreachable"));
    const { result, onOpenShare, reportShellError } = setup([notice()], [workspace("notes")]);
    await expect(result.current.onOpenSentNotice(notice(), live())).resolves.toBe(SHARE_LOOKUP_FAILED_NOTE);
    expect(onOpenShare).not.toHaveBeenCalled();
    expect(reportShellError).not.toHaveBeenCalled();
  });

  it("says access ended when the target was cleared or the share is gone", async () => {
    const ended = notice({ target: null });
    const { result, sentNotices, openFile } = setup([ended], [workspace("notes")]);
    expect(result.current.sentNotices[0]).toEqual({ notice: ended, folder: null, openable: true, retryable: false });
    await expect(result.current.onOpenSentNotice(ended, live())).resolves.toBe(ACCESS_ENDED_NOTE);
    expect(sentNotices.read).toHaveBeenCalledTimes(1);
    expect(openFile).not.toHaveBeenCalled();

    getRelayReceivedShare.mockResolvedValueOnce({ found: false });
    await expect(result.current.onOpenSentNotice(notice(), live())).resolves.toBe(ACCESS_ENDED_NOTE);
  });

  it("says when the workspace is not on this computer", async () => {
    const mine = notice({ workspaceId: "trip", recipientShareId: null });
    const { result } = setup([mine], [workspace("notes")]);
    await expect(result.current.onOpenSentNotice(mine, live())).resolves.toBe(NOT_HERE_NOTE);
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

describe("a failed run's notice", () => {
  const failed = notice({
    kind: "automation-failed", workspaceId: "notes", recipientShareId: null, postedHere: true,
    target: { automation: "collection:Tasks#stamp", path: "Tasks/automations.yaml", run: "atc_1" },
  });

  it("opens its automation in the panel here, and its file from another workspace", async () => {
    const { result, openAutomation, openFile, onSwitchWorkspace } = setup([failed], [workspace("notes")]);
    await expect(result.current.onOpenSentNotice(failed, live())).resolves.toBeNull();
    expect(openAutomation).toHaveBeenCalledWith("collection:Tasks#stamp", "atc_1");
    // Another computer ran it, so its run is not here to open.
    openAutomation.mockClear();
    await result.current.onOpenSentNotice({ ...failed, postedHere: false }, live());
    expect(openAutomation).toHaveBeenCalledWith("collection:Tasks#stamp", null);
    expect(openFile).not.toHaveBeenCalled();
    cleanup();
    const trip = workspace("trip");
    const elsewhere = setup([failed], [workspace("notes"), trip], "trip");
    await elsewhere.result.current.onOpenSentNotice(failed, live());
    expect(elsewhere.onSwitchWorkspace).toHaveBeenCalledWith(workspace("notes"), "Tasks/automations.yaml");
    expect(onSwitchWorkspace).not.toHaveBeenCalled();
  });

  it("says so on its row when this computer no longer has the automation's Collection", async () => {
    const { result, openAutomation, openFile } = setup([failed], [workspace("notes")]);
    openAutomation.mockResolvedValueOnce(AUTOMATION_NOT_HERE_NOTE);
    await expect(result.current.onOpenSentNotice(failed, live())).resolves.toBe(AUTOMATION_NOT_HERE_NOTE);
    openAutomation.mockRejectedValueOnce(new Error("The workspace engine is not running."));
    await expect(result.current.onOpenSentNotice(failed, live())).resolves.toBe("dohc could not open this automation.");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("asks main to run it again for the list's account, and confirms first when it would start over", async () => {
    retryAutomationNotice.mockImplementation(async ({ startOver }: { startOver: boolean }) =>
      startOver ? { status: "queued", press: false } : { status: "definition-changed", repeatsMessages: false });
    const { result, reportShellError } = setup([failed], [workspace("notes")], "notes", { account: "account-1" });
    function Dialog() {
      return <>{result.current.retryDialog}</>;
    }
    await act(async () => result.current.onRetrySentNotice(failed));
    expect(retryAutomationNotice).toHaveBeenCalledWith({ account: "account-1", notice: { store: "account", noticeId: "n1" }, startOver: false });
    render(<Dialog />);
    await act(async () => screen.getByTestId("automation-start-over-confirm").click());
    expect(retryAutomationNotice).toHaveBeenLastCalledWith({ account: "account-1", notice: { store: "account", noticeId: "n1" }, startOver: true });
    expect(reportShellError).not.toHaveBeenCalled();
  });

  it("reports why main did not run it, as on another computer", async () => {
    retryAutomationNotice.mockResolvedValue({ status: "refused", reason: "Only the computer this run failed on can try it again." });
    const { result, reportShellError } = setup([failed], [workspace("notes")]);
    await act(async () => result.current.onRetrySentNotice(failed));
    expect(reportShellError).toHaveBeenCalledWith("Only the computer this run failed on can try it again.", expect.any(Error));
  });
});

describe("the list itself", () => {
  it("holds back All clear until the first list answers", () => {
    expect(setup([], [workspace("notes")], "notes", { settled: false }).result.current.sentNoticesLoading).toBe(true);
    cleanup();
    expect(setup([], [workspace("notes")]).result.current.sentNoticesLoading).toBe(false);
  });

  it("reports a list main could not read, with Try again that lists again", () => {
    const error = new Error("notices file unreadable");
    const { reportShellError, sentNotices } = setup([], [workspace("notes")], "notes", { listFailure: { error } });
    expect(reportShellError).toHaveBeenCalledWith("dohc could not read notices sent to you.", error, sentNotices.relist);
  });
});

describe("Try again on a failed run of the owner's server", () => {
  const failed = (overrides: Partial<NoticeRow> = {}) => notice({
    noticeId: "server-automation-failed:abc", kind: "automation-failed", workspaceId: "notes", recipientShareId: null,
    target: { path: "Tasks", automation: "collection:Tasks#stamp", run: "claim-1" }, ...overrides,
  });

  it("runs it again on the server from this workspace", async () => {
    const { result } = setup([failed()], [workspace("notes")]);
    expect(result.current.sentNotices[0]?.retryable).toBe(true);
    await act(async () => result.current.onRetrySentNotice(failed()));
    expect(retryCollectionAutomation).toHaveBeenCalledWith({ workspaceId: "notes", startOver: false, automationId: "collection:Tasks#stamp", claimId: "claim-1", onServer: true });
  });

  it("offers it only for the server's own notice, in the workspace it names", async () => {
    const others = [
      failed({ workspaceId: "home" }),
      failed({ noticeId: "automation-failed:local-computer" }),
      failed({ noticeId: "from:owner:automation-failed:abc" }),
      failed({ store: "local" }),
      failed({ kind: "automation-notify" }),
      failed({ target: { path: "Tasks", automation: "collection:Tasks#stamp" } }),
    ];
    const { result } = setup(others, [workspace("notes"), workspace("home")]);
    expect(result.current.sentNotices.map((row) => row.retryable)).toEqual([false, false, false, false, false, false]);
    retryAutomationNotice.mockResolvedValue({ status: "refused", reason: "Another computer holds this run." });
    await act(async () => { for (const other of others) result.current.onRetrySentNotice(other); });
    expect(retryCollectionAutomation).not.toHaveBeenCalled();
  });
});
