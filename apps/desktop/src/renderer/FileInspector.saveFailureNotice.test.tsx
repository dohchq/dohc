// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { SaveState } from "@dohc/workspace-contracts/save-state";
import { FileInspector } from "./FileInspector";
import type { DocumentSaveNotices } from "./collab/useSaveFailureNotice";
import { ConnectionNotices } from "./shell/connectionNotices";
import { useShellError } from "./shell/useShellError";

// The live document's save state, published from inside the component the way
// useEngineDoc publishes it.
const engineDocStore = vi.hoisted(() => {
  let state = {
    available: true,
    doc: null as unknown,
    saveState: { kind: "saved-here" } as SaveState,
    saveError: null as string | null,
    retrySave: (() => Promise.resolve()) as () => Promise<void>,
    flushPendingLocalUpdates: () => Promise.resolve(),
  };
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    set(partial: Partial<typeof state>) {
      state = { ...state, ...partial };
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("./collab/useEngineDoc", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEngineDoc: () => useSyncExternalStore(engineDocStore.subscribe, engineDocStore.getSnapshot),
  };
});

const MESSAGE = "dohc couldn't save your edits to notes/a.md. They are kept in dohc.";

// The shell's own error list and notice center, around one open document.
function Shell() {
  const shell = useShellError("ws-1");
  const notices = useMemo<DocumentSaveNotices>(
    () => ({ report: shell.reportShellFailure, clear: shell.clearIdentity }),
    [shell.reportShellFailure, shell.clearIdentity],
  );
  return (
    <>
      <FileInspector workspaceId="ws-1" path="notes/a.md" saveNotices={notices} />
      <ConnectionNotices
        notices={shell.shellErrors.map((error) => ({
          id: error.id,
          message: error.message,
          details: error.message,
          atMs: error.atMs,
          canRetry: error.retry !== null,
          seen: error.seen,
        }))}
        reportFailure={shell.reportShellFailure}
        onRetry={shell.retryShellError}
        onHide={shell.hideShellError}
        onDismiss={shell.dismissShellError}
      />
    </>
  );
}

const fail = (reason = "dohc could not confirm the file was saved."): SaveState => ({ kind: "error", reason, issueId: null });

describe("a live document that couldn't save", () => {
  beforeEach(() => {
    engineDocStore.set({ available: true, doc: new Y.Doc(), saveState: { kind: "saved-here" }, retrySave: vi.fn(() => Promise.resolve()) });
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("dohcDesktop", {
      platform: "win32",
      onWorkspaceActivity: vi.fn(() => () => undefined),
      readWorkspaceText: vi.fn(async () => ({ text: "# Hello\n", truncated: false })),
      writeWorkspaceText: vi.fn(async () => ({ path: "notes/a.md", recorded: true })),
      listWorkspaceFiles: vi.fn(async () => ({ files: [{ path: "notes/a.md", kind: "file" }], folders: [] })),
      readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
      getUpdateState: () => new Promise(() => {}),
      onUpdateState: () => () => {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const rows = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByTestId("notice-center-toggle"));
    const panel = screen.getByRole("dialog", { name: "Notices" });
    const found = within(panel).queryAllByText(MESSAGE);
    await user.keyboard("{Escape}");
    return found;
  };

  it("files one toast and one Notices row with Try again and Copy, keeps one row while it fails, and clears it on a save", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    await screen.findByTestId("markdown-save-state");

    act(() => engineDocStore.set({ saveState: fail() }));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(MESSAGE);
    expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(toast).getByRole("button", { name: "Copy error details" })).toBeTruthy();
    expect(screen.getByTestId("markdown-save-state").textContent).toContain("Couldn't save");
    expect(await rows(user)).toHaveLength(1);

    // More typing into the same file: each settle fails again.
    for (const reason of ["second failure", "third failure"]) {
      act(() => engineDocStore.set({ saveState: { kind: "saving" } }));
      act(() => engineDocStore.set({ saveState: fail(reason) }));
    }
    expect(screen.getAllByTestId("workspace-shell-error")).toHaveLength(1);
    expect(await rows(user)).toHaveLength(1);

    act(() => engineDocStore.set({ saveState: { kind: "saving" } }));
    act(() => engineDocStore.set({ saveState: { kind: "saved-here" } }));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(screen.queryByTestId("connection-notices")).toBeNull();
  });

  it("saves again from Try again, and a failure after it files the row again", async () => {
    const user = userEvent.setup();
    const retrySave = vi.fn(() => Promise.resolve());
    engineDocStore.set({ retrySave });
    render(<Shell />);
    await screen.findByTestId("markdown-save-state");

    act(() => engineDocStore.set({ saveState: fail() }));
    await user.click(within(await screen.findByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    expect(retrySave).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    act(() => engineDocStore.set({ saveState: { kind: "saving" } }));
    act(() => engineDocStore.set({ saveState: fail() }));
    expect(await screen.findByTestId("workspace-shell-error")).toBeTruthy();
    expect(await rows(user)).toHaveLength(1);
  });

  it("leaves a refused edit to its own notice", async () => {
    render(<Shell />);
    await screen.findByTestId("markdown-save-state");
    act(() => engineDocStore.set({ saveState: { kind: "error", reason: "refused", issueId: "request-1" } }));
    expect(screen.getByTestId("markdown-save-state").getAttribute("data-state")).toBe("error");
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });
});
