// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECKPOINT_FAILURE_MESSAGE, IMPORT_FAILURE_MESSAGE } from "../../workspaces/typingRecoveryWords";
import { ipcErrorMessage } from "../ipcError";
import { useShellError } from "./useShellError";
import { shareCaptureNoticeState } from "../../workspaces/shareCaptureNotice";
import { CreationPartialError } from "@dohc/cli/creation";
import { errorDetails } from "./copyDetails";
import { flushDatasetSourceCapture } from "../../workspaces/datasetSourceCapture";

afterEach(cleanup);

const strict = ({ children }: { children: ReactNode }) => (
  <StrictMode>{children}</StrictMode>
);

describe("useShellError", () => {
  it("keeps a held source error in Notices with the repair words and retry", async () => {
    const capture = { deferredWrites: [], running: true, settled: true, degraded: false, heldFiles: [{
      workspaceId: "ws-a", sourceVersionId: "main", objectId: "object", path: "sources/note.md",
      observedSha256: "digest", observedSize: 4, reason: "ydoc-resolution-not-representable" as const,
      observedAtMs: 1, attemptCount: 1, retryRequested: false,
    }] };
    const adapter = { reconcileCapture: async () => capture, flushCapture: async () => capture };
    const failure = await flushDatasetSourceCapture(adapter, new AbortController().signal, ["sources/note.md"]).catch(error => error as Error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw Error("Expected a held source refusal");
    const retry = vi.fn();
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() => result.current.reportShellError("dohc could not prepare this Collection change.",
      new Error(`Error invoking remote method 'dataset': Error: ${failure.message}`), retry));
    const notice = result.current.shellErrors[0]!;
    expect(notice.message).toBe('dohc could not prepare this Collection change. dohc cannot use "sources/note.md" for this change. dohc cannot take in this file\'s Markdown. Causes include nested lists in workspaces that sync, or deeply nested quotes. The file on this computer still has the outside edit. Restore the file\'s exact contents from before that edit. For nested lists, make the edit in dohc after the file opens again.');
    expect(notice.seen).toBe(false);
    expect(notice.retry).toBe(retry);
    act(() => result.current.hideShellError(notice.id));
    expect(result.current.shellErrors[0]).toMatchObject({ id: notice.id, seen: true });
    act(() => result.current.shellErrors[0]!.retry!());
    expect(retry).toHaveBeenCalledOnce();
  });
  it("keeps one row for where schedules run: a warning while another computer runs them, an error with Try again while none does", () => {
    const retry = vi.fn();
    const takeOver = vi.fn();
    const { result } = renderHook(() => useShellError("ws"));
    act(() => result.current.showScheduleHostNotice({ message: "This workspace's schedules run on Ice's laptop, not this computer.", failed: false, retry, takeOver }));
    expect(result.current.shellErrors).toHaveLength(1);
    expect(result.current.shellErrors[0]).toMatchObject({ tone: "warning", retry: null, seen: false, action: { label: "Take over now", ends: true } });
    act(() => result.current.showScheduleHostNotice({ message: "No computer runs this workspace's schedules.", failed: true, cause: "EACCES: permission denied", retry, takeOver }));
    expect(result.current.shellErrors).toHaveLength(1);
    const failed = result.current.shellErrors[0]!;
    expect(failed.tone).toBeUndefined();
    expect(failed.retry).toBe(retry);
    expect(failed.details).toEqual([["Cause", "EACCES: permission denied"]]);
    act(() => result.current.runShellErrorAction(failed.id));
    expect(takeOver).toHaveBeenCalledOnce();
    act(() => result.current.showScheduleHostNotice({ message: "No computer runs this workspace's schedules.", failed: true, retry, takeOver }));
    act(() => result.current.showScheduleHostNotice(null));
    expect(result.current.shellErrors).toEqual([]);
  });
  it("routes an additional Notice action independently of its primary action", () => {
    const first=vi.fn();const discard=vi.fn();const {result}=renderHook(()=>useShellError("workspace"));
    act(()=>result.current.reportShellFailure({message:"Kept typing",action:{label:"Copy your typing",run:first,additional:[{label:"Discard your typing",run:discard}]}}));
    const id=result.current.shellErrors[0]!.id;
    act(()=>result.current.runShellErrorAction(id,1));expect(discard).toHaveBeenCalledOnce();expect(first).not.toHaveBeenCalled();
    act(()=>result.current.runShellErrorAction(id));expect(first).toHaveBeenCalledOnce();
  });
  it("hides only the persisted dismissal's matching restriction key", () => {
    const snapshot = { paths: ["tasks/local.yaml"], unchecked: false, checked: 1 };
    const dismissed = { ...snapshot, dismissedKey: shareCaptureNoticeState([], snapshot, false).key };
    const { result } = renderHook(() => useShellError("restriction-dismissal-key"));
    act(() => result.current.reportShareCapture("share", [], dismissed, false));
    expect(result.current.shellErrors).toHaveLength(0);
    act(() => result.current.reportShareCapture("share", [], dismissed, true));
    expect(result.current.shellErrors).toHaveLength(1);
    expect(result.current.shellErrors[0]!.message).toContain("They are kept on this computer.");
    expect(result.current.shellErrors[0]!.seen).toBe(false);
    act(() => result.current.reportShareCapture("share", [], {
      ...snapshot, dismissedKey: shareCaptureNoticeState([], snapshot, true).key,
    }, true));
    expect(result.current.shellErrors).toHaveLength(0);
  });

  it("keeps a dismissed capture Notice dismissed across remounts until the path set changes", () => {
    const first = renderHook(() => useShellError("capture-notice-workspace"));
    const paths = ["tasks/locked.md", "tasks/another.md"];
    act(() => first.result.current.reportShareCapture("share-a", paths));
    const notice = first.result.current.shellErrors[0]!;
    expect(notice.identity).toBe("share-capture:capture-notice-workspace:share-a");
    expect(notice.title).toBe("Changes kept on this computer");
    expect(notice.message).toBe("dohc couldn't confirm these changes reached the share. They are kept on this computer. Copy these files to another workspace.");
    expect(notice.message).not.toContain(paths[0]);
    expect(errorDetails(notice.details!)).toContain("File: tasks/another.md\nFile: tasks/locked.md");
    act(() => first.result.current.hideShellError(notice.id));
    act(() => first.result.current.reportShareCapture("share-a", [...paths].reverse()));
    expect(first.result.current.shellErrors[0]).toMatchObject({ id: notice.id, seen: true });
    act(() => first.result.current.dismissShellError(notice.id));
    act(() => first.result.current.reportShareCapture("share-a", [...paths, paths[0]!]));
    expect(first.result.current.shellErrors).toHaveLength(0);
    first.unmount();
    const reopened = renderHook(() => useShellError("capture-notice-workspace"));
    act(() => reopened.result.current.reportShareCapture("share-a", paths));
    expect(reopened.result.current.shellErrors).toHaveLength(0);
    act(() => reopened.result.current.reportShareCapture("share-a", [paths[0]!]));
    expect(reopened.result.current.shellErrors).toHaveLength(1);
    expect(reopened.result.current.shellErrors[0]!.seen).toBe(false);
    act(() => reopened.result.current.reportShareCapture("share-a", []));
    expect(reopened.result.current.shellErrors).toHaveLength(0);
    act(() => reopened.result.current.reportShareCapture("share-a", null));
    expect(reopened.result.current.shellErrors).toHaveLength(1);
    expect(reopened.result.current.shellErrors[0]!.message).toBe("dohc couldn't check this share's files. Copy any files you changed to another workspace now.");
    expect(reopened.result.current.shellErrors[0]!.details).toBeUndefined();
    act(() => reopened.result.current.reportShareCapture("share-a", [], { paths: ["tasks/draft.md"], unchecked: true, checked: 0 }));
    expect(reopened.result.current.shellErrors).toHaveLength(1);
    expect(reopened.result.current.shellErrors[0]!.message).toBe("dohc checked only some of this share's files. dohc couldn't confirm these changes reached the share. They are kept on this computer. Copy these files and any others you changed to another workspace now.");
    expect(reopened.result.current.shellErrors[0]!.details).toEqual([["File", "tasks/draft.md", "tasks/draft.md".length]]);
  });

  it("describes a partial check with no names without claiming changes exist", () => {
    const { result } = renderHook(() => useShellError("partial-empty-share"));
    act(() => result.current.reportShareCapture("share", [], { paths: [], unchecked: true, checked: 256 }, false));
    expect(result.current.shellErrors[0]).toMatchObject({ title: "Share check incomplete",
      message: "dohc checked only some of this share's files. Copy any files you changed to another workspace now.", details: undefined });
  });

  it.each([true, false])("keeps separate partial creations and replaces only the retried creation (record: %s)", record => {
    const { result } = renderHook(() => useShellError("ws-a"));
    const firstRetry = vi.fn();
    const secondRetry = vi.fn();
    const updatedRetry = vi.fn();
    const partial = (name: string, failedStage: "settle" | "close" = "settle") => new CreationPartialError({
      kind: "partial", created: [record ? `tasks/${name}.md` : `${name}/frontend.js`],
      failedStage, reason: `${name}: ${failedStage} failed`,
      retry: { mode: "resume", instruction: "Try again.",
        ...(record ? { recordId: `rec_${name.repeat(26)}` } : {}),
      },
    });
    act(() => {
      result.current.reportShellError("Creation failed.", partial("a"), firstRetry);
      result.current.reportShellError("Creation failed.", partial("b"), secondRetry);
    });
    expect(result.current.shellErrors).toHaveLength(2);
    act(() => result.current.reportShellError("Creation failed.", partial("a", "close"), updatedRetry));
    expect(result.current.shellErrors).toHaveLength(2);
    const [second, updated] = result.current.shellErrors;
    expect(errorDetails(second!.details!)).toContain("Reason: b: settle failed");
    expect(errorDetails(updated!.details!)).toContain("Reason: a: close failed");
    act(() => result.current.retryShellError(second!.id));
    act(() => result.current.retryShellError(updated!.id));
    expect(secondRetry).toHaveBeenCalledOnce();
    expect(updatedRetry).toHaveBeenCalledOnce();
    expect(firstRetry).not.toHaveBeenCalled();
  });

  it.each([true, false])("keeps partial creation facts in copy details and offers the human retry (record: %s)", record => {
    const retry = vi.fn();
    const partial = { kind: "partial" as const, created: [record ? "tasks/retry.md" : "form/frontend.js"],
      failedStage: "settle" as const, reason: "settle failed", retry: { mode: "resume" as const,
        ...(record ? { recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa" } : {}),
        instruction: "Try again with the same record ID and fields." } };
    const error = new CreationPartialError(partial);
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() => result.current.reportShellError("Creation failed.", error, retry));
    const notice = result.current.shellErrors[0]!;
    expect(notice.message).toBe(record
      ? "dohc created the record file but could not finish the record."
      : "dohc created form files but could not finish the form.");
    const copied = errorDetails(notice.details!);
    expect(copied).toContain(`Created: ${partial.created[0]}`);
    expect(copied).toContain("Reason: settle failed");
    expect(copied).toContain(`Next: ${partial.retry.instruction}`);
    if (record) expect(copied).toContain(`Record ID: ${partial.retry.recordId}`);
    expect(notice.message).not.toContain("rec_");
    act(() => result.current.retryShellError(notice.id));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("offers copy details as the next action when creation cannot resume", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    const paths = Array.from({ length: 4 }, (_, index) => `${"long-folder/".repeat(20)}file-${index}.js`);
    const error = new CreationPartialError({ kind: "partial", created: paths, failedStage: "revision",
      reason: "Collection rules changed.", retry: { mode: "remove-and-retry", instruction: "Review the listed files in Files, then remove them." } });
    act(() => result.current.reportShellError("Creation failed.", error));
    expect(result.current.shellErrors[0]).toMatchObject({
      message: "dohc created form files; copy the details to review them in Files.", retry: null,
    });
    const copied = errorDetails(result.current.shellErrors[0]!.details!);
    for (const path of paths) expect(copied).toContain(`Created: ${path}`);
    expect(copied).toContain(`Next: ${error.partial.retry.instruction}`);
  });

  it("shows each persisted refusal as a toast and keeps its row through retry", () => {
    const retry = vi.fn();
    const { result, rerender } = renderHook(({workspace}) => useShellError(workspace), {initialProps: {workspace: "ws-a"}});
    const notice = { noticeId: "refusal-1", kind: "sync-refusal", workspaceId: "ws-a", store: "local" as const,
      recipientShareId: null, senderKind: null, senderLabel: null, title: "A change needs your review",
      body: 'dohc could not apply the resolution for "doc.md". Review its conflict.', target: {}, createdAtMs: 1, readAtMs: null, postedHere: true };
    act(() => result.current.showSyncRefusals([notice], retry));
    expect(result.current.shellErrors[0]).toMatchObject({message: notice.body, seen: false, retry});
    act(() => result.current.hideShellError(notice.noticeId));
    act(() => result.current.showSyncRefusals([notice], retry));
    expect(result.current.shellErrors[0]!.seen).toBe(true);
    act(() => result.current.retryShellError(notice.noticeId));
    expect(retry).toHaveBeenCalledOnce();
    expect(result.current.shellErrors).toHaveLength(1);
    rerender({workspace: "ws-b"});
    expect(result.current.shellErrors).toEqual([]);
  });

  it("opens the current file for a terminal binding refusal instead of retrying sync", () => {
    const retry = vi.fn();
    const open = vi.fn();
    const { result } = renderHook(() => useShellError("ws-a"));
    const reason = "This file's name, location, or sharing changed before this save arrived. Open the file to continue.";
    const notice = { noticeId: "renamed-save", kind: "sync-refusal", workspaceId: "ws-a", store: "local" as const,
      recipientShareId: null, senderKind: null, senderLabel: null, title: "dohc skipped an earlier save",
      body: reason, detail: reason, target: { path: "renamed.md" }, createdAtMs: 1, readAtMs: null, postedHere: true };
    act(() => result.current.showSyncRefusals([notice], retry, open));
    expect(result.current.shellErrors[0]).toMatchObject({ retry: null, action: { label: "Open" } });
    act(() => result.current.runShellErrorAction(notice.noticeId));
    expect(open).toHaveBeenCalledWith("renamed.md");
    expect(retry).not.toHaveBeenCalled();
    expect(result.current.shellErrors).toHaveLength(1);
  });

  it("opens History when author names did not sync, instead of retrying sync", () => {
    const retry = vi.fn();
    const openHistory = vi.fn();
    const { result } = renderHook(() => useShellError("ws-a"));
    const reason = "dohc could not verify who changed this file. The file will share without author names.";
    const notice = { noticeId: "unattributed", kind: "sync-refusal", workspaceId: "ws-a", store: "local" as const,
      recipientShareId: null, senderKind: null, senderLabel: null, title: "Some author names did not sync for “n.md”",
      body: "dohc could not confirm who made one or more saves to this file, so it did not sync their author names. Other History entries keep theirs.", detail: `${reason}\nWorkspace: ws-a`,
      target: { path: "n.md" }, createdAtMs: 1, readAtMs: null, postedHere: true };
    act(() => result.current.showSyncRefusals([notice], retry, vi.fn(), openHistory));
    expect(result.current.shellErrors[0]).toMatchObject({
      title: notice.title, message: notice.body, tone: "warning", retry: null, action: { label: "Open History" },
    });
    act(() => result.current.runShellErrorAction(notice.noticeId));
    expect(openHistory).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("copies a refused save's whole path, so two files with one name can be told apart", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    const deep = "folder/".repeat(80);
    const notice = (noticeId: string, path: string) => ({ noticeId, kind: "sync-refusal", workspaceId: "ws-a", store: "local" as const,
      recipientShareId: null, senderKind: null, senderLabel: null, title: "Some author names did not sync for “n.md”",
      body: "dohc could not confirm who made one or more saves to this file, so it did not sync their author names. Other History entries keep theirs.",
      detail: "dohc could not verify who changed this file. The file will share without author names.\nWorkspace: ws-a",
      target: { path }, createdAtMs: 1, readAtMs: null, postedHere: true });
    act(() => result.current.showSyncRefusals([notice("a", `${deep}notes/n.md`), notice("b", `${deep}archive/n.md`)], vi.fn()));
    const copied = result.current.shellErrors.map(error => errorDetails(error.details ?? []));
    expect(copied[0]).toContain(`File: ${deep}notes/n.md\n`);
    expect(copied[1]).toContain(`File: ${deep}archive/n.md\n`);
  });

  it("runs a retry exactly once, even under Strict Mode, and drops the row", () => {
    const retry = vi.fn();
    const { result } = renderHook(() => useShellError("ws-a"), { wrapper: strict });
    act(() => result.current.reportShellError("Could not refresh history.", new Error("timeout"), retry));
    expect(result.current.shellErrors).toHaveLength(1);
    const id = result.current.shellErrors[0]!.id;

    act(() => result.current.retryShellError(id));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.current.shellErrors).toEqual([]);
  });

  // A retry answers false when it could not run, such as during an account
  // deletion review.
  it("keeps a newer report of the same failure when an older row's retry cannot run", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() => result.current.reportShellFailure({ message: "dohc could not finish disconnecting.", retry: () => false }));
    const older = result.current.shellErrors[0]!;
    const newer = vi.fn();
    act(() => {
      result.current.reportShellFailure({ message: "dohc could not finish disconnecting.", retry: newer });
      result.current.retryShellError(older.id);
    });
    expect(result.current.shellErrors).toHaveLength(1);
    expect(result.current.shellErrors[0]!.retry).toBe(newer);
  });

  // The toast is the newest unseen row, by time, then by place in the list.
  it("keeps every row in place when a retry cannot run, so a same-time newer toast stays shown", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const { result } = renderHook(() => useShellError("ws-a"));
      act(() => result.current.reportShellFailure({ message: "dohc could not finish disconnecting.", retry: () => false }));
      act(() => result.current.reportShellFailure({ message: "dohc could not reach this server.", retry: vi.fn() }));
      const before = result.current.shellErrors;
      act(() => result.current.retryShellError(before[0]!.id));
      expect(result.current.shellErrors).toEqual(before);
    } finally {
      now.mockRestore();
    }
  });

  it("keeps the row a retry files again before it returns", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    const report = (): void => result.current.reportShellFailure({
      message: "Could not load History.", identity: "about-history:a.md", retry: report, repeat: true,
    });
    act(report);
    act(() => result.current.retryShellError(result.current.shellErrors[0]!.id));
    expect(result.current.shellErrors.map((error) => error.message)).toEqual(["Could not load History."]);
  });

  it("offers to keep the Collections here, then retries what was refused, unless the person cancels", async () => {
    const keepCollectionsHere = vi.fn(async () => ({ kept: true }));
    vi.stubGlobal("dohcDesktop", { keepCollectionsHere });
    try {
      const retry = vi.fn();
      const { result } = renderHook(() => useShellError("ws-a"));
      const words = "dohc doesn't know which computer keeps this workspace's Collections. To keep them on this computer, choose Use this computer in dohc.";
      act(() => result.current.reportShellError("Could not create the Collection.",
        new Error(`Error invoking remote method 'desktop:dataset': CollectionsRefusalError [collections-unclaimed]: ${words}`), retry));
      const row = result.current.shellErrors[0]!;
      expect(row.message).toBe(`Could not create the Collection. ${words}`);
      expect(row.action?.label).toBe("Use this computer");
      await act(async () => { result.current.runShellErrorAction(row.id); });
      expect(keepCollectionsHere).toHaveBeenCalledWith({ workspaceId: "ws-a" });
      expect(retry).toHaveBeenCalledOnce();
      expect(result.current.shellErrors).toEqual([]);
      // Collections another computer keeps offer it too, behind main's question; a cancelled question retries nothing.
      keepCollectionsHere.mockResolvedValueOnce({ kept: false });
      act(() => result.current.reportShellError("Could not create the Collection.",
        new Error("Error invoking remote method 'desktop:dataset': CollectionsRefusalError [collections-elsewhere] [computer=Laptop]: These Collections are on Laptop."), retry));
      const elsewhere = result.current.shellErrors[0]!;
      expect(elsewhere.action?.label).toBe("Use this computer");
      await act(async () => { result.current.runShellErrorAction(elsewhere.id); });
      expect(retry).toHaveBeenCalledOnce();
      // A store that is gone, or a record that changed, offers no such step.
      for (const code of ["collections-missing", "collections-changed"]) {
        act(() => result.current.reportShellError("Could not create the Collection.",
          new Error(`Error invoking remote method 'desktop:dataset': CollectionsRefusalError [${code}]: Words.`)));
        expect(result.current.shellErrors.at(-1)!.action).toBeUndefined();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("offers Send as proposal on a direct-write row and clears those rows when it runs", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() => result.current.showDirectWriteNotice({
      kind: "direct-write-stale", message: "stale", retry: null, send: { label: "Send as proposal", run: send },
    }));
    act(() => result.current.showDirectWriteNotice({
      kind: "direct-write-refused", message: "refused", retry: null, send: { label: "Send as proposal", run: send },
    }));
    act(() => result.current.showDirectWriteNotice({
      kind: "direct-write-failed", message: "failed", retry: vi.fn(), send: null,
    }));
    expect(result.current.shellErrors.map((error) => [error.kind, error.action?.label])).toEqual([
      ["direct-write-stale", "Send as proposal"],
      ["direct-write-refused", "Send as proposal"],
      ["direct-write-failed", undefined],
    ]);
    act(() => result.current.runShellErrorAction(result.current.shellErrors[1]!.id));
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.shellErrors.map((error) => error.kind)).toEqual(["direct-write-failed"]);
  });

  it("runs a success notice's undo once and drops the row", () => {
    const undo = vi.fn();
    const { result } = renderHook(() => useShellError("ws-a"), { wrapper: strict });
    act(() => result.current.showSuccessNotice('Deleted "Stamp"', undo));
    expect(result.current.shellErrors[0]).toMatchObject({ tone: "success", retry: null, action: { label: "Undo" } });
    const id = result.current.shellErrors[0]!.id;

    act(() => result.current.runShellErrorAction(id));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(result.current.shellErrors).toEqual([]);
  });

  it("replaces a row that says the same thing or has the same kind", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() => result.current.reportShellError("Could not refresh history.", new Error("a")));
    act(() => result.current.reportShellError("Could not refresh history.", new Error("a")));
    expect(result.current.shellErrors).toHaveLength(1);

    act(() => result.current.showTabLimitError(20, "open this file"));
    act(() => result.current.showTabLimitError(21, "open another tab"));
    const tabLimitRows = result.current.shellErrors.filter((error) => error.kind === "tab-limit");
    expect(tabLimitRows).toHaveLength(1);
    expect(tabLimitRows[0]!.message).toContain("21 open tabs");

    act(() => result.current.clearTabLimitError());
    expect(result.current.shellErrors.some((error) => error.kind === "tab-limit")).toBe(false);
    expect(result.current.shellErrors).toHaveLength(1);
  });

  it("files one sync failure row at a time, with or without a toast", () => {
    const retry = vi.fn();
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() =>
      result.current.reportSyncFailure(
        { message: "dohc could not sync this workspace.", detail: "Error: refused", toast: false },
        retry,
      ),
    );
    expect(result.current.shellErrors).toHaveLength(1);
    expect(result.current.shellErrors[0]).toMatchObject({
      kind: "cloud-sync",
      details: [["Detail", "Error: refused"]],
      seen: true,
    });
    act(() =>
      result.current.reportSyncFailure(
        { message: "dohc could not reach the server.", detail: "RelayUnreachableError", toast: true },
        retry,
      ),
    );
    expect(result.current.shellErrors).toHaveLength(1);
    expect(result.current.shellErrors[0]).toMatchObject({
      message: "dohc could not reach the server.",
      seen: false,
    });
    act(() => result.current.retryShellError(result.current.shellErrors[0]!.id));
    expect(retry).toHaveBeenCalledTimes(1);
    act(() =>
      result.current.reportSyncFailure(
        { message: "dohc could not sync this workspace.", detail: "Error: refused", toast: false },
        retry,
      ),
    );
    act(() => result.current.clearSyncFailure());
    expect(result.current.shellErrors).toEqual([]);
  });

  it("keeps a raw cause for Copy details out of the message", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() =>
      result.current.reportShellFailure({
        message: "Could not import files. The disk is full.",
        details: [["Cause", "ENOSPC: no space left on device, copyfile 'a.md'"]],
      }),
    );
    expect(result.current.shellErrors[0]).toMatchObject({
      message: "Could not import files. The disk is full.",
      details: [["Cause", "ENOSPC: no space left on device, copyfile 'a.md'"]],
      retry: null,
    });
  });

  it("keeps a hidden row until it is dismissed, and clears on a workspace switch", () => {
    const { result, rerender } = renderHook(({ id }) => useShellError(id), {
      initialProps: { id: "ws-a" },
    });
    act(() => result.current.reportShellFailure({ message: "Saved copy is stale." }));
    const id = result.current.shellErrors[0]!.id;

    act(() => result.current.hideShellError(id));
    expect(result.current.shellErrors).toHaveLength(1);
    expect(result.current.shellErrors[0]!.seen).toBe(true);

    act(() => result.current.dismissShellError(id));
    expect(result.current.shellErrors).toEqual([]);

    act(() => result.current.reportShellFailure({ message: "Saved copy is stale." }));
    rerender({ id: "ws-b" });
    expect(result.current.shellErrors).toEqual([]);
  });

  it("files a quiet failure as a row without a toast, and keeps an open toast open", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() => result.current.reportShellFailure({ message: "Could not read site.", identity: "folder-app:site", quiet: true }));
    expect(result.current.shellErrors.map((error) => error.seen)).toEqual([true]);
    act(() => result.current.dismissShellError(result.current.shellErrors[0]!.id));
    act(() => result.current.reportShellFailure({ message: "Could not read site.", identity: "folder-app:site" }));
    act(() => result.current.reportShellFailure({ message: "Could not read site.", identity: "folder-app:site", quiet: true }));
    expect(result.current.shellErrors.map((error) => error.seen)).toEqual([false]);
  });

  // The toast is the newest unseen row, by time, then by place in the list.
  it("updates a quiet repeat in place, so another failure's newer toast stays the one shown", () => {
    const now = vi.spyOn(Date, "now");
    try {
      const { result } = renderHook(() => useShellError("ws-a"));
      now.mockReturnValue(1_000);
      act(() => result.current.reportShellFailure({ message: "Could not read site.", identity: "folder-app:site", retry: vi.fn() }));
      now.mockReturnValue(2_000);
      act(() => result.current.reportShellFailure({ message: "Could not read docs.", identity: "folder-app:docs" }));
      const [siteBefore] = result.current.shellErrors;

      now.mockReturnValue(3_000);
      const retry = vi.fn();
      act(() => result.current.reportShellFailure({ message: "Could not read site again.", identity: "folder-app:site", retry, quiet: true }));
      const [site, docs] = result.current.shellErrors;
      expect(result.current.shellErrors).toHaveLength(2);
      expect(site).toMatchObject({ id: siteBefore!.id, atMs: 1_000, seen: false, message: "Could not read site again.", retry });
      expect(docs).toMatchObject({ identity: "folder-app:docs", atMs: 2_000, seen: false });
    } finally {
      now.mockRestore();
    }
  });

  it("replaces a repeated failure's row and keeps that row's toast, open or closed", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() => result.current.reportShellFailure({ message: "Could not load History.", identity: "about-history:a.md" }));
    expect(result.current.shellErrors.map((error) => error.seen)).toEqual([false]);
    // Still open: the repeat keeps it open, as one row.
    act(() => result.current.reportShellFailure({ message: "Could not load History.", identity: "about-history:a.md", repeat: true }));
    expect(result.current.shellErrors.map((error) => error.seen)).toEqual([false]);
    // Closed by the person: the repeat does not toast again.
    act(() => result.current.hideShellError(result.current.shellErrors[0]!.id));
    act(() => result.current.reportShellFailure({ message: "Could not load History.", identity: "about-history:a.md", repeat: true }));
    expect(result.current.shellErrors.map((error) => error.seen)).toEqual([true]);
    // Another file's first failure is a toast of its own, repeat or not.
    act(() => result.current.reportShellFailure({ message: "Could not load History.", identity: "about-history:b.md", repeat: true }));
    expect(result.current.shellErrors.map((error) => [error.identity, error.seen])).toEqual([
      ["about-history:a.md", true], ["about-history:b.md", false],
    ]);
  });

  it("toasts a repeat again once Try again or Dismiss has removed its row", () => {
    const retry = vi.fn();
    const { result } = renderHook(() => useShellError("ws-a"));
    const report = () => result.current.reportShellFailure({
      message: "Could not load History.", identity: "about-history:a.md", retry, repeat: true,
    });
    act(report);
    act(() => result.current.hideShellError(result.current.shellErrors[0]!.id));
    // Try again removes the row, then reads; the read fails again.
    act(() => result.current.retryShellError(result.current.shellErrors[0]!.id));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.current.shellErrors).toEqual([]);
    act(report);
    expect(result.current.shellErrors.map((error) => error.seen)).toEqual([false]);
    // Dismissed, then failing again: a toast, not a quiet row.
    act(() => result.current.dismissShellError(result.current.shellErrors[0]!.id));
    act(report);
    expect(result.current.shellErrors.map((error) => error.seen)).toEqual([false]);
  });

  it("still files a sync failure that asks for no toast quietly when it has no predecessor", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() => result.current.reportSyncFailure({ message: "Sync stopped.", detail: "relay", toast: false }, vi.fn()));
    expect(result.current.shellErrors.map((error) => error.seen)).toEqual([true]);
  });

  it("shows words instead of Electron's prefix, a class name or a code, and keeps them for Copy", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    const refused = new Error(
      "Error invoking remote method 'desktop:list-collections': DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
    );
    act(() => result.current.reportShellError("Could not read Collections.", refused));
    act(() => result.current.reportLaneFailure("dohc could not refresh sync status.", refused, () => {}));
    act(() => result.current.reportShellFailure({
      message: "Error invoking remote method 'desktop:dataset': PersistentRuntimeError [worker_stopped]: The dataset worker stopped. Reopen it from the journal.",
    }));
    act(() => result.current.reportShellFailure({ message: "Version controls are unavailable right now.", cause: refused }));
    expect(result.current.shellErrors.map(({ message, details }) => ({
      message,
      cause: details?.find(([label]) => label === "Cause")?.[1],
    }))).toEqual([
      {
        message: "Could not read Collections. dohc is still reading this workspace's files. Try again when it finishes.",
        cause: "DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
      },
      {
        message: "dohc could not refresh sync status. dohc is still reading this workspace's files. Try again when it finishes.",
        cause: "DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
      },
      {
        message: "It stopped before it finished. Try again.",
        cause: "PersistentRuntimeError [worker_stopped]: The dataset worker stopped. Reopen it from the journal.",
      },
      {
        message: "Version controls are unavailable right now.",
        cause: "DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
      },
    ]);
  });

  it("keeps two failures with the same reason apart by what failed", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    const stopped = new Error(
      "Error invoking remote method 'desktop:dataset': PersistentRuntimeError [worker_stopped]: The dataset worker stopped.",
    );
    act(() => result.current.reportShellFailure({ message: ipcErrorMessage(stopped, "Could not send that message."), cause: stopped }));
    act(() => result.current.reportShellFailure({ message: ipcErrorMessage(stopped, "Could not load this chat."), cause: stopped }));
    expect(result.current.shellErrors.map(({ message }) => message)).toEqual([
      "Could not send that message. It stopped before it finished. Try again.",
      "Could not load this chat. It stopped before it finished. Try again.",
    ]);
  });

  it("says what failed, then a Collection reply as written", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() => result.current.reportShellError(
      "Could not open this Collection.",
      new Error("Error invoking remote method 'desktop:dataset': Error: The Collection changed after this preview. Preview the change again."),
    ));
    expect(result.current.shellErrors[0]!.message)
      .toBe("Could not open this Collection. The Collection changed after this preview. Preview the change again.");
  });
});


it("reports unavailable recovery without replacing unrelated Notices and clears it when recovery returns", () => {
  const openFolder = vi.fn();
  const { result } = renderHook(() => useShellError("recovery"));
  act(() => {
    result.current.reportShellError("Unrelated failure", undefined);
    result.current.reportRecoveryUnavailable(true, () => undefined, openFolder);
  });
  const notice = result.current.shellErrors.find(row => row.kind === "file-recovery-unavailable")!;
  expect(notice.seen).toBe(false);
  expect(notice.details).toEqual([["Folder", ".dohc/engine/displaced"]]);
  act(() => result.current.runShellErrorAction(notice.id));
  expect(openFolder).toHaveBeenCalledOnce();
  act(() => result.current.reportRecoveryUnavailable(false, () => undefined, openFolder));
  expect(result.current.shellErrors).toHaveLength(1);
  expect(result.current.shellErrors[0].message).toBe("Unrelated failure");
});


it("retries unavailable recovery through the supplied action", () => {
  const retry = vi.fn();
  const { result } = renderHook(() => useShellError("retry-recovery"));
  act(() => result.current.reportRecoveryUnavailable(true, retry, vi.fn()));
  act(() => result.current.retryShellError(result.current.shellErrors[0].id));
  expect(retry).toHaveBeenCalledOnce();
  expect(result.current.shellErrors).toEqual([]);
});

it.each([["typing-checkpoint", CHECKPOINT_FAILURE_MESSAGE], ["typing-import", IMPORT_FAILURE_MESSAGE]] as const)("files one %s Notice with retry and copy details", (kind, message) => {
 const retry = vi.fn(); const {result} = renderHook(() => useShellError("workspace"));
 act(() => {result.current.reportShellFailure({kind, message, details: [["Reason", "disk or author refusal"]], retry}); result.current.reportShellFailure({kind, message, details: [["Reason", "retry refused"]], retry});});
 expect(result.current.shellErrors).toHaveLength(1); const row = result.current.shellErrors[0]!;
 expect(row).toMatchObject({kind, message, seen: false, retry}); expect(row.details).toEqual([["Reason", "retry refused"]]);
 act(() => result.current.retryShellError(row.id)); expect(retry).toHaveBeenCalledOnce();
});

it("toasts a first repeated report and retains the toast identity and seen state on refresh",()=>{
 const {result}=renderHook(()=>useShellError("typing-refresh"));
 const report=()=>result.current.reportShellFailure({identity:"typing-import:one",kind:"typing-import",message:IMPORT_FAILURE_MESSAGE,repeat:true});
 act(report);const first=result.current.shellErrors[0]!;expect(first.seen).toBe(false);
 act(report);expect(result.current.shellErrors[0]).toMatchObject({id:first.id,atMs:first.atMs,seen:false});
 act(()=>result.current.hideShellError(first.id));act(report);
 expect(result.current.shellErrors).toHaveLength(1);expect(result.current.shellErrors[0]).toMatchObject({id:first.id,atMs:first.atMs,seen:true});
});

it("toasts a changed reason even when the prior repeated toast was closed", () => {
 const {result}=renderHook(()=>useShellError("typing-new-reason"));
 act(()=>result.current.reportShellFailure({identity:"typing-import:one",kind:"typing-import",message:IMPORT_FAILURE_MESSAGE,repeat:true}));
 const first=result.current.shellErrors[0]!;
 act(()=>result.current.hideShellError(first.id));
 act(()=>result.current.reportShellFailure({identity:"typing-import:one",kind:"typing-import",message:"This file is no longer in History.",repeat:true}));
 expect(result.current.shellErrors).toHaveLength(1);
 expect(result.current.shellErrors[0]).toMatchObject({message:"This file is no longer in History.",seen:false});
 expect(result.current.shellErrors[0]!.id).not.toBe(first.id);
});

it("gives a success Notice its Open History action without reporting a failure", () => {
 const open=vi.fn();const {result}=renderHook(()=>useShellError("typing-recovered"));
 act(()=>result.current.showSuccessNotice('dohc recovered your typing in "note.md".',undefined,undefined,{label:"Open History",run:open}));
 const row=result.current.shellErrors[0]!;
 expect(row).toMatchObject({tone:"success",retry:null,seen:false,action:{label:"Open History"}});
 act(()=>result.current.runShellErrorAction(row.id));expect(open).toHaveBeenCalledOnce();
});
