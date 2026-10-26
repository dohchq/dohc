// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge, EngineYDocSaveStateEvent, RetryEngineYDocSaveResult, SaveFailureReason, SyncStatusResult } from "../../ipc/bridgeContract";
import { PRIVACY_DENIED_WORDS, VOLUME_SHARES_NEW_FILES_WORDS } from "../../ipc/errorWords";
import { deferred } from "../../testing/deferred";
import { CsvView } from "../CsvView";
import { documentVersionKey } from "../documentVersionKey";
import { resetOrphanedDrafts } from "../orphanedDrafts";
import { loadStoredDrafts } from "../orphanedDraftStorage";
import { acquireSharedLocalDocument, resetSharedLocalDocumentsForTests } from "../sharedLocalDocument";
import { AUTOSAVE_DEBOUNCE_MS, useAutosavedTextDraft, type DraftFlush } from "../useAutosavedTextDraft";
import { NoticeCenter } from "../workbench/NoticeCenter";
import { WorkspaceSyncStatus } from "../workbench/WorkspaceSyncStatus";
import { ConnectionNotices } from "./connectionNotices";
import { errorDetails } from "./copyDetails";
import { REPLACED_DOCUMENT_SAVED, REPLACED_DOCUMENT_UNSAVED, reportDocumentReplacement, useDocumentSaveNotices } from "./useDocumentSaveNotices";
import { useShellError } from "./useShellError";

type WriteResult = Awaited<ReturnType<DohcDesktopBridge["writeWorkspaceText"]>>;
const listeners = new Set<(event: EngineYDocSaveStateEvent) => void>();
const retryEngineYDocSave = vi.fn<(payload: { workspaceId: string; path: string; recreateFile?: true }) => Promise<RetryEngineYDocSaveResult>>();
const writeWorkspaceText = vi.fn<DohcDesktopBridge["writeWorkspaceText"]>();
const open = vi.fn<(path: string) => void>();
const openSystemPrivacySettings = vi.fn(async () => undefined);

const SYNCED: SyncStatusResult = {
  state: "synced",
  pendingChangeCount: 0,
  lastSyncedAtMs: null,
  liveSessionsGeneration: 0,
  historyRecordingUnavailable: false,
  historyShareView: false,
};

// The shell's title bar status, error list and notice center, with no editor
// mounted unless a test gives one: a closing settle reports after its tab
// has gone.
function Shell(props: { workspaceId?: string; children?: ReactNode }) {
  const workspaceId = props.workspaceId ?? "ws-1";
  const shell = useShellError(workspaceId);
  const failedSaves = useDocumentSaveNotices({ workspaceId, report: shell.reportShellFailure, clear: shell.clearIdentity, open });
  return (
    <>
      <WorkspaceSyncStatus syncStatus={SYNCED} failedSaves={failedSaves} />
      <ConnectionNotices
        notices={shell.shellErrors.map((error) => ({
          id: error.id,
          ...(error.title ? { title: error.title } : {}),
          message: error.message,
          details: errorDetails(error.details ?? []),
          atMs: error.atMs,
          canRetry: error.retry !== null,
          seen: error.seen,
        }))}
        reportFailure={shell.reportShellFailure}
        onRetry={shell.retryShellError}
        onHide={shell.hideShellError}
        onDismiss={shell.dismissShellError}
      />
      {props.children}
    </>
  );
}

// The notice center as the shell draws it, with a row's own action beside Try
// again.
function ActionNotices() {
  const shell = useShellError("ws-1");
  useDocumentSaveNotices({ workspaceId: "ws-1", report: shell.reportShellFailure, clear: shell.clearIdentity, open });
  return (
    <NoticeCenter
      workspaceId="ws-1" host="corner" syncStatus={null} agentActive={false} conflictSummaries={[]}
      onOpenHistory={() => {}} onOpenConflicts={() => {}} onRefreshShareView={() => {}} onOpenSettings={() => {}} onRebuildEngineStore={() => {}}
      workspaceErrors={shell.shellErrors.map((error) => ({
        id: error.id,
        ...(error.title ? { title: error.title } : {}),
        message: error.message,
        // What the shell copies: the words, then the facts.
        details: errorDetails([["Error", error.message], ["Title", error.title], ...(error.details ?? [])]),
        atMs: error.atMs,
        canRetry: error.retry !== null,
        ...(error.action ? { actionLabel: error.action.label } : {}),
        seen: error.seen,
      }))}
      onRetryWorkspaceError={shell.retryShellError}
      onWorkspaceErrorAction={shell.runShellErrorAction}
      onHideWorkspaceError={shell.hideShellError}
      onDismissWorkspaceError={shell.dismissShellError}
    />
  );
}

const releases: Array<() => void> = [];

// A plain-text file as FileInspector hands it to its editor.
function textFile(workspaceId: string, path: string, body: string) {
  const { buffer, release } = acquireSharedLocalDocument(documentVersionKey(workspaceId, path, undefined));
  releases.push(release);
  const contentReadTicket = buffer.beginRead();
  const contentHash = `${path}-hash`;
  buffer.initializeRead(body, contentHash, contentReadTicket);
  return {
    workspaceId,
    path,
    body,
    contentHash,
    contentReadTicket,
    contentRequestId: 1,
    latestContentRequestId: 1,
    switchReadPending: false,
    switchUnresyncedRef: { current: false },
    refreshAfterConflict: vi.fn(),
    localBuffer: buffer,
  };
}

// Closes a text file's tab and waits for the write it makes on the way out,
// so nothing the editor does outlives its test.
async function closeEditor(editor: { unmount: () => void }, file: ReturnType<typeof textFile>) {
  await act(async () => {
    editor.unmount();
    await file.localBuffer.settled();
  });
}

// What the renderer receives when main's write rejects: Electron prefixes
// the channel to the error's text.
const writeRejected = (text: string) => new Error(`Error invoking remote method 'workspace:write-text': ${text}`);
const READ_ONLY_ON_DISK = "Error [EPERM]: EPERM: operation not permitted, rename 'data.csv.tmp' -> 'data.csv'";
const titleBar = () => screen.getByTestId("sync-status");

const emit = (event: Partial<EngineYDocSaveStateEvent>) =>
  act(() => {
    for (const listener of [...listeners]) {
      listener({ sessionId: "session-1", workspaceId: "ws-1", path: "notes/a.md", state: { kind: "saving" }, seq: 1, ...event });
    }
  });
const failed = (reason: SaveFailureReason = "read-only"): Partial<EngineYDocSaveStateEvent> => ({
  state: { kind: "error", reason: "dohc could not confirm the file was saved.", issueId: null },
  saveFailure: { reason },
});

describe("document save notices", () => {
  beforeEach(() => {
    retryEngineYDocSave.mockResolvedValue("settled");
    vi.stubGlobal("dohcDesktop", {
      platform: "win32",
      onEngineYDocSaveState: (listener: (event: EngineYDocSaveStateEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      retryEngineYDocSave,
      writeWorkspaceText,
      openSystemPrivacySettings,
      getUpdateState: () => new Promise(() => {}),
      onUpdateState: () => () => {},
    });
  });

  afterEach(() => {
    cleanup();
    listeners.clear();
    for (const release of releases.splice(0)) release();
    resetSharedLocalDocumentsForTests();
    resetOrphanedDrafts();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    writeWorkspaceText.mockReset();
  });

  const rows = async (user: ReturnType<typeof userEvent.setup>, path = "notes/a.md") => {
    await user.click(screen.getByTestId("notice-center-toggle"));
    const found = within(screen.getByRole("dialog", { name: "Notices" })).queryAllByText(`Couldn't save ${path}`);
    await user.keyboard("{Escape}");
    return found;
  };

  it("files one toast and one row with Try again and the cause in Copy, keeps one row, and clears it on a save", async () => {
    const user = userEvent.setup();
    const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<Shell />);

    emit(failed());
    const toast = screen.getByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("Couldn't save notes/a.md");
    expect(toast.textContent).toContain("The file is read-only. Make it writable, then try again.");
    expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
    await user.click(within(toast).getByRole("button", { name: "Copy error details" }));
    expect(copied.mock.calls[0]![0]).toContain("Cause: The file is read-only.");
    expect(copied.mock.calls[0]![0]).toContain("File: notes/a.md");
    expect(await rows(user)).toHaveLength(1);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      emit({ state: { kind: "saving" } });
      emit(failed());
    }
    expect(screen.getAllByTestId("workspace-shell-error")).toHaveLength(1);
    expect(await rows(user)).toHaveLength(1);

    emit({ state: { kind: "saved-here" } });
    expect(screen.queryByTestId("connection-notices")).toBeNull();
  });

  it("says macOS blocked the folder, and offers System Settings beside Try again", () => {
    const { result } = renderHook(() => {
      const shell = useShellError("ws-1");
      useDocumentSaveNotices({ workspaceId: "ws-1", report: shell.reportShellFailure, clear: shell.clearIdentity, open });
      return shell.shellErrors;
    });
    emit(failed("privacy-denied"));
    expect(result.current).toHaveLength(1);
    const [notice] = result.current;
    expect(notice!.title).toBe("Couldn't save notes/a.md");
    expect(notice!.message).toBe(PRIVACY_DENIED_WORDS);
    expect(notice!.details).toContainEqual(["Cause", "macOS blocked dohc from this folder."]);
    expect(notice!.retry).not.toBeNull();
    expect(notice!.action?.label).toBe("Open System Settings");
    notice!.action!.run();
    expect(openSystemPrivacySettings).toHaveBeenCalledOnce();
  });

  it("says why a live document can't be kept private on a volume that shares new files", () => {
    const { result } = renderHook(() => {
      const shell = useShellError("ws-1");
      useDocumentSaveNotices({ workspaceId: "ws-1", report: shell.reportShellFailure, clear: shell.clearIdentity, open });
      return shell.shellErrors;
    });
    emit(failed("volume-shares-new-files"));
    expect(result.current).toHaveLength(1);
    const [notice] = result.current;
    expect(notice!.title).toBe("Couldn't save notes/a.md");
    expect(notice!.message).toBe(VOLUME_SHARES_NEW_FILES_WORDS);
    expect(notice!.details).toContainEqual(["Cause", "The disk adds sharing permissions to new files."]);
    expect(notice!.retry).not.toBeNull();
    expect(notice!.action).toBeUndefined();
  });

  it("says why a plain-text file can't be kept private on a volume that shares new files", async () => {
    writeWorkspaceText.mockRejectedValueOnce(writeRejected("DaemonRefusalError [INTERNAL]: volume-shares-new-files"));
    render(<Shell />);
    const document = textFile("ws-1", ".env", "OLD=1");
    const editor = renderHook(useAutosavedTextDraft, { initialProps: document });
    act(() => editor.result.current.setDraft("SECRET=1"));
    await act(async () => { await editor.result.current.saveNow(); });
    const toast = screen.getByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("Couldn't save .env");
    expect(toast.textContent).toContain(VOLUME_SHARES_NEW_FILES_WORDS);
    expect(toast.textContent).not.toContain("dohc couldn't write the file.");
    await closeEditor(editor, document);
  });

  it("says a file was moved or deleted outside dohc and offers Save it again in place of Try again", async () => {
    const user = userEvent.setup();
    const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<ActionNotices />);

    emit(failed("deleted"));
    const toast = screen.getByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("Couldn't save notes/a.md");
    expect(toast.textContent).toContain("The file was moved or deleted outside dohc.");
    expect(within(toast).queryByRole("button", { name: "Try again" })).toBeNull();
    await user.click(within(toast).getByRole("button", { name: "Copy error details" }));
    expect(copied.mock.calls[0]![0]).toBe("Error: The file was moved or deleted outside dohc.\nTitle: Couldn't save notes/a.md\nFile: notes/a.md");

    await user.click(within(toast).getByRole("button", { name: "Save it again" }));
    expect(retryEngineYDocSave).toHaveBeenCalledWith({ workspaceId: "ws-1", path: "notes/a.md", recreateFile: true });
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    // A save it starts that fails again files the row again, and a save
    // clears it.
    emit({ state: { kind: "saving" } });
    emit(failed("deleted"));
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain("The file was moved or deleted outside dohc.");
    emit({ state: { kind: "saved-here" } });
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("gives a standing row the deleted file's words and Save it again when the file is deleted", async () => {
    const user = userEvent.setup();
    render(<ActionNotices />);
    emit(failed("read-only"));
    // Try again only repeats the save.
    await user.click(within(screen.getByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    expect(retryEngineYDocSave).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-1", path: "notes/a.md" });
    emit({ state: { kind: "saving" } });
    emit(failed("read-only"));

    // The file is deleted while that row stands.
    emit({ state: { kind: "saving" } });
    emit(failed("deleted"));
    const [toast, ...others] = screen.getAllByTestId("workspace-shell-error");
    expect(others).toEqual([]);
    expect(toast!.textContent).toContain("The file was moved or deleted outside dohc.");
    expect(toast!.textContent).not.toContain("read-only");
    expect(within(toast!).queryByRole("button", { name: "Try again" })).toBeNull();
    await user.click(within(toast!).getByRole("button", { name: "Save it again" }));
    expect(retryEngineYDocSave).toHaveBeenLastCalledWith({ workspaceId: "ws-1", path: "notes/a.md", recreateFile: true });
  });

  it("says only what it knows when the file is not read-only", () => {
    render(<Shell />);
    emit(failed(null));
    const toast = screen.getByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("dohc couldn't write the file.");
    expect(toast.textContent).not.toContain("read-only");
  });

  it("files nothing for an error that is not a failed write, and leaves edit refusals to their own notice", () => {
    render(<Shell />);
    // An author-capacity refusal, or an error no settle reported.
    emit({ state: { kind: "error", reason: "too large", issueId: null }, authorCapacity: true });
    emit({ state: { kind: "error", reason: "drift", issueId: null } });
    // Another workspace's document.
    emit({ ...failed(), workspaceId: "ws-2" });
    expect(screen.queryByTestId("connection-notices")).toBeNull();

    const message = 'dohc could not save an edit to "notes/a.md". Copy it from recovery.';
    emit({ state: { kind: "error", reason: message, issueId: "request-1" },
      editRefusal: { workspaceId: "ws-1", path: "notes/a.md", requestId: "request-1", message } });
    expect(screen.getAllByTestId("workspace-shell-error")).toHaveLength(1);
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain(message);
    expect(screen.queryByText("Couldn't save notes/a.md")).toBeNull();
  });

  it("settles from Try again, and the next failure files the row again", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    emit({ ...failed(), sessionId: "session-2" });
    await user.click(within(screen.getByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    expect(retryEngineYDocSave).toHaveBeenCalledWith({ workspaceId: "ws-1", path: "notes/a.md" });
    expect(screen.queryByTestId("connection-notices")).toBeNull();

    emit({ state: { kind: "saving" } });
    emit(failed());
    expect(await rows(user)).toHaveLength(1);
  });

  it("files the row again when Try again cannot start a save", async () => {
    const user = userEvent.setup();
    retryEngineYDocSave.mockRejectedValue(new Error("dohc could not start a save for this document."));
    render(<Shell />);
    emit(failed());
    await user.click(within(screen.getByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("workspace-shell-error").textContent).toContain("Couldn't save notes/a.md"));
    expect(await rows(user)).toHaveLength(1);
  });

  it("leaves a Try again that meets an author-capacity refusal to that refusal's notice", async () => {
    const user = userEvent.setup();
    retryEngineYDocSave.mockImplementation(async () => {
      // Main sends the settle's save state before the retry's answer.
      emit({ state: { kind: "error", reason: "too large", issueId: null }, authorCapacity: true });
      throw new Error("The document is too large to save.");
    });
    render(<Shell />);
    emit(failed());
    await user.click(within(screen.getByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(retryEngineYDocSave).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId("connection-notices")).toBeNull();
  });

  // #2463. A note closed over a change made outside dohc before the capture
  // poll noticed it: its refused save first reads as a failure, then main
  // says the file changed outside dohc. No failed-save row may stay.
  it("clears a closing note's failed save when main says the file changed outside dohc", () => {
    render(<Shell />);
    emit({ ...failed(null), closing: true });
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain("Couldn't save notes/a.md");
    emit({ state: { kind: "changed-on-disk", reason: "The file changed on disk.", issueId: null }, closing: true });
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(screen.queryByTestId("connection-notices")).toBeNull();
  });

  it("ignores a late failure from a session a newer one replaced", () => {
    render(<Shell />);
    emit({ sessionId: "session-1", state: { kind: "saved-here" } });
    emit({ ...failed(), sessionId: "session-2" });
    emit({ ...failed(null), sessionId: "session-1", closing: true });
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain("read-only");
  });

  it("asks main to settle whatever session is open when Try again is clicked, even one that has sent nothing", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    // The old session's closing failure arrives before the reopened editor's session says anything.
    emit({ ...failed(), sessionId: "session-1", closing: true });
    await user.click(within(screen.getByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    expect(retryEngineYDocSave).toHaveBeenCalledWith({ workspaceId: "ws-1", path: "notes/a.md" });
    expect(open).not.toHaveBeenCalled();
  });

  it("opens the document when its session has closed", async () => {
    const user = userEvent.setup();
    retryEngineYDocSave.mockResolvedValue("closed");
    render(<Shell />);
    emit(failed());
    await user.click(within(screen.getByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("notes/a.md"));
    expect(screen.queryByTestId("connection-notices")).toBeNull();
  });

  it("names a live document's failed save in the title bar until a save clears it", () => {
    render(<Shell />);
    emit(failed());
    expect(titleBar().textContent).toBe("Couldn't save 1 file");
    emit({ ...failed(), path: "notes/b.md" });
    expect(titleBar().textContent).toBe("Couldn't save 2 files");
    emit({ state: { kind: "saved-here" } });
    emit({ path: "notes/b.md", state: { kind: "saved-here" } });
    expect(titleBar().textContent).toBe("Local · saved");
  });

  it("files one toast and one row for a CSV file that couldn't save, keeps the row across failures, and clears it when Try again saves", async () => {
    const user = userEvent.setup();
    const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    writeWorkspaceText.mockRejectedValue(writeRejected(READ_ONLY_ON_DISK));
    render(<Shell><CsvView {...textFile("ws-1", "data.csv", "name\nAda\n")} /></Shell>);
    expect(titleBar().textContent).toBe("Local · saved");
    const edit = (value: string) => fireEvent.change(screen.getAllByTestId("csv-cell")[1]!, { target: { value } });

    edit("Grace");
    const toast = await screen.findByTestId("workspace-shell-error", {}, { timeout: AUTOSAVE_DEBOUNCE_MS * 5 });
    expect(toast.textContent).toContain("Couldn't save data.csv");
    expect(toast.textContent).toContain("dohc couldn't write the file.");
    expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
    await user.click(within(toast).getByRole("button", { name: "Copy error details" }));
    expect(copied.mock.calls[0]![0]).toContain("File: data.csv");
    expect(copied.mock.calls[0]![0]).toContain(`Cause: ${READ_ONLY_ON_DISK}`);
    expect(titleBar().textContent).toBe("Couldn't save 1 file");
    expect(await rows(user, "data.csv")).toHaveLength(1);

    // Closing the toast keeps the row; a later failure keeps both as they are.
    await user.click(within(screen.getByTestId("workspace-shell-error")).getByRole("button", { name: "Dismiss workspace error" }));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    edit("Grace Hopper");
    await waitFor(() => expect(writeWorkspaceText).toHaveBeenCalledTimes(2), { timeout: AUTOSAVE_DEBOUNCE_MS * 5 });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("view-csv").textContent).toContain("Couldn't save");
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(await rows(user, "data.csv")).toHaveLength(1);
    expect(titleBar().textContent).toBe("Couldn't save 1 file");

    // Try again saves the editor's newest draft.
    writeWorkspaceText.mockResolvedValue({ status: "written", contentHash: "saved-hash" });
    await user.click(screen.getByTestId("notice-center-toggle"));
    await user.click(within(screen.getByRole("dialog", { name: "Notices" })).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(titleBar().textContent).toBe("Local · saved"));
    expect(writeWorkspaceText).toHaveBeenCalledTimes(3);
    expect(writeWorkspaceText.mock.calls[2]![0]).toMatchObject({ workspaceId: "ws-1", relativePath: "data.csv" });
    expect(writeWorkspaceText.mock.calls[2]![0].text).toContain("Grace Hopper");
    expect(screen.queryByText("Couldn't save data.csv")).toBeNull();
  });

  it("files the text file's row again when Try again fails, and opens the file once its editor has closed", async () => {
    const user = userEvent.setup();
    writeWorkspaceText.mockRejectedValue(writeRejected(READ_ONLY_ON_DISK));
    render(<Shell />);
    const document = textFile("ws-1", "notes.txt", "before");
    const editor = renderHook(useAutosavedTextDraft, { initialProps: document });
    act(() => editor.result.current.setDraft("after"));
    await act(async () => { await editor.result.current.saveNow(); });
    await user.click(within(screen.getByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(writeWorkspaceText).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("workspace-shell-error")).toBeTruthy();
    expect(await rows(user, "notes.txt")).toHaveLength(1);

    // Closing the tab writes once more, and that failure keeps the row. The
    // edit is set aside, which is what opening the file shows.
    await closeEditor(editor, document);
    expect(writeWorkspaceText).toHaveBeenCalledTimes(3);
    expect(loadStoredDrafts(Date.now())).toEqual([expect.objectContaining({ path: "notes.txt", text: "after" })]);
    await user.click(within(screen.getByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    expect(open).toHaveBeenCalledWith("notes.txt");
    expect(writeWorkspaceText).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("connection-notices")).toBeNull();
    expect(titleBar().textContent).toBe("Local · saved");
  });

  it("files nothing when a share refuses a text file's write, because the file is read-only only in dohc", async () => {
    writeWorkspaceText.mockRejectedValue(writeRejected("SharedFileReadOnlyError: This shared view is read-only for you. Ask ada@example.com for changes."));
    render(<Shell />);
    const document = textFile("ws-1", "shared.txt", "before");
    const editor = renderHook(useAutosavedTextDraft, { initialProps: document });
    act(() => editor.result.current.setDraft("after"));
    await act(async () => { await editor.result.current.saveNow(); });
    expect(writeWorkspaceText).toHaveBeenCalledOnce();
    expect(document.localBuffer.getSnapshot().saveState.kind).toBe("error");
    expect(screen.queryByTestId("connection-notices")).toBeNull();
    expect(titleBar().textContent).toBe("Local · saved");

    await closeEditor(editor, document);
    expect(screen.queryByTestId("connection-notices")).toBeNull();

    // A share with View access: the editor never writes.
    const viewFile = { ...textFile("ws-1", "view.txt", "before"), disabled: true };
    const viewOnly = renderHook(useAutosavedTextDraft, { initialProps: viewFile });
    act(() => viewOnly.result.current.setDraft("after"));
    await act(async () => { await viewOnly.result.current.saveNow(); });
    await closeEditor(viewOnly, viewFile);
    expect(writeWorkspaceText).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("connection-notices")).toBeNull();
    expect(titleBar().textContent).toBe("Local · saved");
  });

  it("leaves another workspace's title bar and Notices alone when a save fails late", async () => {
    const late = deferred<WriteResult>();
    writeWorkspaceText.mockRejectedValue(writeRejected(READ_ONLY_ON_DISK))
      .mockRejectedValueOnce(writeRejected(READ_ONLY_ON_DISK))
      .mockReturnValueOnce(late.promise);
    const shell = render(<Shell workspaceId="ws-1" />);
    const document = textFile("ws-1", "notes.txt", "before");
    const editor = renderHook(useAutosavedTextDraft, { initialProps: document });
    act(() => editor.result.current.setDraft("first"));
    await act(async () => { await editor.result.current.saveNow(); });
    expect(titleBar().textContent).toBe("Couldn't save 1 file");

    act(() => editor.result.current.setDraft("second"));
    let saving: Promise<void> | undefined;
    act(() => { saving = editor.result.current.saveNow(); });
    shell.rerender(<Shell workspaceId="ws-2" />);
    expect(titleBar().textContent).toBe("Local · saved");
    expect(screen.queryByTestId("connection-notices")).toBeNull();

    await act(async () => {
      late.reject(writeRejected(READ_ONLY_ON_DISK));
      await saving;
    });
    expect(writeWorkspaceText).toHaveBeenCalledTimes(2);
    expect(document.localBuffer.getSnapshot().saveState.kind).toBe("error");
    expect(titleBar().textContent).toBe("Local · saved");
    expect(screen.queryByTestId("connection-notices")).toBeNull();

    // So does the write its closing tab makes.
    await closeEditor(editor, document);
    expect(writeWorkspaceText).toHaveBeenCalledTimes(3);
    expect(titleBar().textContent).toBe("Local · saved");
    expect(screen.queryByTestId("connection-notices")).toBeNull();
  });

  it("keeps counting a dismissed failure in the title bar, and files the next failure again", async () => {
    const user = userEvent.setup();
    writeWorkspaceText.mockRejectedValue(writeRejected(READ_ONLY_ON_DISK));
    render(<Shell />);
    const document = textFile("ws-1", "notes.txt", "before");
    const editor = renderHook(useAutosavedTextDraft, { initialProps: document });
    act(() => editor.result.current.setDraft("first"));
    await act(async () => { await editor.result.current.saveNow(); });
    await user.click(screen.getByTestId("notice-center-toggle"));
    await user.click(within(screen.getByRole("dialog", { name: "Notices" })).getByRole("button", { name: "Dismiss notice" }));
    expect(screen.queryByTestId("connection-notices")).toBeNull();
    // The file still isn't saved.
    expect(titleBar().textContent).toBe("Couldn't save 1 file");

    act(() => editor.result.current.setDraft("second"));
    await act(async () => { await editor.result.current.saveNow(); });
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain("Couldn't save notes.txt");
    expect(await rows(user, "notes.txt")).toHaveLength(1);
    await closeEditor(editor, document);
  });

  it("files nothing for a change on disk that a flush rejects with", async () => {
    writeWorkspaceText.mockResolvedValue({ status: "conflict", currentContentHash: "changed-hash" });
    render(<Shell />);
    let flush: DraftFlush | null = null;
    const document = { ...textFile("ws-1", "notes.txt", "before"), registerDraftFlush: (next: DraftFlush | null) => { flush = next; } };
    const editor = renderHook(useAutosavedTextDraft, { initialProps: document });
    act(() => editor.result.current.setDraft("after"));
    await act(async () => {
      await expect(flush!()).rejects.toThrow("The file changed on disk while dohc saved it.");
    });
    expect(writeWorkspaceText).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("connection-notices")).toBeNull();
    expect(titleBar().textContent).toBe("Local · saved");
    await closeEditor(editor, document);
  });

  it("reports a write for the file it wrote after the editor moves on, and Try again opens that file instead of saving the other", async () => {
    const user = userEvent.setup();
    const late = deferred<WriteResult>();
    writeWorkspaceText.mockReturnValueOnce(late.promise);
    render(<Shell />);
    const first = textFile("ws-1", "a.txt", "a before");
    const second = textFile("ws-1", "b.txt", "b before");
    const editor = renderHook(useAutosavedTextDraft, { initialProps: first });
    act(() => editor.result.current.setDraft("a after"));
    let saving: Promise<void> | undefined;
    act(() => { saving = editor.result.current.saveNow(); });
    editor.rerender(second);
    await act(async () => {
      late.reject(writeRejected(READ_ONLY_ON_DISK));
      await saving;
    });
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain("Couldn't save a.txt");
    expect(titleBar().textContent).toBe("Couldn't save 1 file");

    await user.click(within(screen.getByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    expect(open).toHaveBeenCalledWith("a.txt");
    expect(writeWorkspaceText).toHaveBeenCalledOnce();
    expect(titleBar().textContent).toBe("Local · saved");
    await closeEditor(editor, second);
  });

  it("clears a file's row when its write lands after the editor moved on", async () => {
    const late = deferred<WriteResult>();
    writeWorkspaceText.mockRejectedValueOnce(writeRejected(READ_ONLY_ON_DISK)).mockReturnValueOnce(late.promise);
    render(<Shell />);
    const first = textFile("ws-1", "a.txt", "a before");
    const second = textFile("ws-1", "b.txt", "b before");
    const editor = renderHook(useAutosavedTextDraft, { initialProps: first });
    act(() => editor.result.current.setDraft("a after"));
    await act(async () => { await editor.result.current.saveNow(); });
    expect(titleBar().textContent).toBe("Couldn't save 1 file");
    let saving: Promise<void> | undefined;
    act(() => { saving = editor.result.current.saveNow(); });
    editor.rerender(second);
    await act(async () => {
      late.resolve({ status: "written", contentHash: "a-saved" });
      await saving;
    });
    expect(screen.queryByTestId("connection-notices")).toBeNull();
    expect(titleBar().textContent).toBe("Local · saved");
    await closeEditor(editor, second);
  });

  it("files one row for a path both writers fail, keeps it until neither fails, and counts the file once", async () => {
    const user = userEvent.setup();
    writeWorkspaceText.mockRejectedValueOnce(writeRejected(READ_ONLY_ON_DISK)).mockResolvedValue({ status: "written", contentHash: "saved" });
    render(<Shell />);
    emit(failed());
    const document = textFile("ws-1", "notes/a.md", "before");
    const editor = renderHook(useAutosavedTextDraft, { initialProps: document });
    act(() => editor.result.current.setDraft("plain edit"));
    await act(async () => { await editor.result.current.saveNow(); });
    expect(screen.getAllByTestId("workspace-shell-error")).toHaveLength(1);
    expect(await rows(user)).toHaveLength(1);
    expect(titleBar().textContent).toBe("Couldn't save 1 file");

    // The engine's save does not clear the plain editor's failure.
    emit({ state: { kind: "saved-here" } });
    expect(await rows(user)).toHaveLength(1);
    expect(titleBar().textContent).toBe("Couldn't save 1 file");
    // The plain editor's save clears its own, and no writer fails now.
    act(() => editor.result.current.setDraft("plain edit, saved"));
    await act(async () => { await editor.result.current.saveNow(); });
    expect(screen.queryByTestId("connection-notices")).toBeNull();
    expect(titleBar().textContent).toBe("Local · saved");

    // A plain save does not clear what the engine has not settled.
    emit(failed());
    act(() => editor.result.current.setDraft("another plain edit"));
    await act(async () => { await editor.result.current.saveNow(); });
    expect(await rows(user)).toHaveLength(1);
    expect(titleBar().textContent).toBe("Couldn't save 1 file");
    await closeEditor(editor, document);
  });

  it("files a replaced document's unsaved earlier edits with Try again and copy, then says where they are", async () => {
    const user = userEvent.setup();
    const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const retry = vi.fn();
    const failure = { setAsideFailed: true, cause: new Error("Storage refused the earlier edits."), retry };
    const noticeRows = async (text: string) => {
      await user.click(screen.getByTestId("notice-center-toggle"));
      const found = within(screen.getByRole("dialog", { name: "Notices" })).queryAllByText(text, { exact: false });
      await user.keyboard("{Escape}");
      return found;
    };
    render(<Shell />);

    act(() => reportDocumentReplacement("ws-1", "notes/a.md", true, failure));
    // Another workspace's document files nothing here.
    act(() => reportDocumentReplacement("ws-2", "notes/b.md", true, failure));
    const toast = screen.getByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("notes/a.md");
    expect(toast.textContent).toContain(REPLACED_DOCUMENT_UNSAVED);
    await user.click(within(toast).getByRole("button", { name: "Copy error details" }));
    expect(copied.mock.calls[0]![0]).toContain("File: notes/a.md");
    expect(await noticeRows(REPLACED_DOCUMENT_UNSAVED)).toHaveLength(1);

    await user.click(within(screen.getByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("connection-notices")).toBeNull();

    // The retry fails twice more: still one row.
    act(() => reportDocumentReplacement("ws-1", "notes/a.md", true, failure));
    act(() => reportDocumentReplacement("ws-1", "notes/a.md", true, failure));
    expect(screen.getAllByTestId("workspace-shell-error")).toHaveLength(1);
    expect(await noticeRows(REPLACED_DOCUMENT_UNSAVED)).toHaveLength(1);

    // Set aside: the success replaces the failure, and its row stays after the toast closes.
    act(() => reportDocumentReplacement("ws-1", "notes/a.md", true, null));
    expect(screen.getAllByTestId("workspace-shell-error")).toHaveLength(1);
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain(REPLACED_DOCUMENT_SAVED);
    await user.click(within(screen.getByTestId("workspace-shell-error")).getByRole("button", { name: "Dismiss workspace error" }));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(await noticeRows(REPLACED_DOCUMENT_UNSAVED)).toHaveLength(0);
    expect(await noticeRows(REPLACED_DOCUMENT_SAVED)).toHaveLength(1);
    await user.click(screen.getByTestId("notice-center-toggle"));
    await user.click(within(screen.getByRole("dialog", { name: "Notices" })).getByRole("button", { name: "Dismiss notice" }));
    expect(screen.queryByTestId("connection-notices")).toBeNull();

    // A replacement that set nothing aside clears the row its failure filed.
    act(() => reportDocumentReplacement("ws-1", "notes/a.md", false, { ...failure, setAsideFailed: false }));
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain("dohc could not finish replacing this document.");
    act(() => reportDocumentReplacement("ws-1", "notes/a.md", false, null));
    expect(screen.queryByTestId("connection-notices")).toBeNull();
    expect(titleBar().textContent).toBe("Local · saved");
  });

  it("retries every writer failing for a file from its one row", async () => {
    const user = userEvent.setup();
    writeWorkspaceText.mockRejectedValue(writeRejected(READ_ONLY_ON_DISK));
    render(<Shell />);
    emit(failed());
    const document = textFile("ws-1", "notes/a.md", "before");
    const editor = renderHook(useAutosavedTextDraft, { initialProps: document });
    act(() => editor.result.current.setDraft("plain edit"));
    await act(async () => { await editor.result.current.saveNow(); });

    writeWorkspaceText.mockResolvedValue({ status: "written", contentHash: "saved" });
    await user.click(within(screen.getByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(writeWorkspaceText).toHaveBeenCalledTimes(2));
    expect(retryEngineYDocSave).toHaveBeenCalledWith({ workspaceId: "ws-1", path: "notes/a.md" });
    // The plain save landed; the engine's failure stands until its settle answers.
    expect(titleBar().textContent).toBe("Couldn't save 1 file");
    emit({ state: { kind: "saved-here" } });
    expect(titleBar().textContent).toBe("Local · saved");
    expect(screen.queryByTestId("connection-notices")).toBeNull();
    await closeEditor(editor, document);
  });
});
