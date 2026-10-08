// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineYDocSaveStateEvent, RetryEngineYDocSaveResult } from "../../ipc/bridgeContract";
import { ConnectionNotices } from "./connectionNotices";
import { errorDetails } from "./copyDetails";
import { useDocumentSaveNotices } from "./useDocumentSaveNotices";
import { useShellError } from "./useShellError";

const listeners = new Set<(event: EngineYDocSaveStateEvent) => void>();
const retryEngineYDocSave = vi.fn<(payload: { workspaceId: string; sessionId: string }) => Promise<RetryEngineYDocSaveResult>>();
const open = vi.fn<(path: string) => void>();

// The shell's error list and notice center, with no editor mounted: a
// closing settle reports after its tab has gone.
function Shell() {
  const shell = useShellError("ws-1");
  useDocumentSaveNotices({ workspaceId: "ws-1", report: shell.reportShellFailure, clear: shell.clearIdentity, open });
  return (
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
  );
}

const emit = (event: Partial<EngineYDocSaveStateEvent>) =>
  act(() => {
    for (const listener of [...listeners]) {
      listener({ sessionId: "session-1", workspaceId: "ws-1", path: "notes/a.md", state: { kind: "saving" }, seq: 1, ...event });
    }
  });
const failed = (readOnly = true): Partial<EngineYDocSaveStateEvent> => ({
  state: { kind: "error", reason: "dohc could not confirm the file was saved.", issueId: null },
  saveFailure: { readOnly },
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
      getUpdateState: () => new Promise(() => {}),
      onUpdateState: () => () => {},
    });
  });

  afterEach(() => {
    cleanup();
    listeners.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const rows = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByTestId("notice-center-toggle"));
    const found = within(screen.getByRole("dialog", { name: "Notices" })).queryAllByText("Couldn't save notes/a.md");
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

  it("says only what it knows when the file is not read-only", () => {
    render(<Shell />);
    emit(failed(false));
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
    expect(retryEngineYDocSave).toHaveBeenCalledWith({ workspaceId: "ws-1", sessionId: "session-2" });
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

  it("ignores a late failure from a session a newer one replaced, and retries the newer one", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    emit({ sessionId: "session-1", state: { kind: "saved-here" } });
    emit({ ...failed(), sessionId: "session-2" });
    emit({ ...failed(false), sessionId: "session-1", closing: true });
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain("read-only");
    await user.click(within(screen.getByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    expect(retryEngineYDocSave).toHaveBeenCalledWith({ workspaceId: "ws-1", sessionId: "session-2" });
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
});
