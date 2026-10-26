// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveState } from "@dohc/workspace-contracts/save-state";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { deferred } from "../testing/deferred";
import { CsvControls, CsvView, CsvViewActions } from "./CsvView";
import { documentVersionKey } from "./documentVersionKey";
import { resetOrphanedDrafts } from "./orphanedDrafts";
import { acquireSharedLocalDocument, resetSharedLocalDocumentsForTests } from "./sharedLocalDocument";
import { ConnectionNotices } from "./shell/connectionNotices";
import { errorDetails } from "./shell/copyDetails";
import { useShellError } from "./shell/useShellError";
import { TextViewActions } from "./TextEditorView";
import { EditorGroupFrame } from "./workbench/tabRowActions";

type ImportResult = Awaited<ReturnType<DohcDesktopBridge["importToDatabase"]>>;
const importToDatabase = vi.fn<DohcDesktopBridge["importToDatabase"]>();
const writeWorkspaceText = vi.fn<DohcDesktopBridge["writeWorkspaceText"]>();
const releases: Array<() => void> = [];
const buffers: Array<ReturnType<typeof acquireSharedLocalDocument>["buffer"]> = [];

// A CSV as FileInspector hands it to its view.
function csvFile(workspaceId: string, path: string, body: string) {
  const { buffer, release } = acquireSharedLocalDocument(documentVersionKey(workspaceId, path, undefined));
  releases.push(release);
  buffers.push(buffer);
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

// The shell's error list and notice center, handing its error hook to the view.
function Shell(props: { children: (onError: ReturnType<typeof useShellError>["reportButtonError"]) => ReactNode }) {
  const shell = useShellError("ws-1");
  return (
    <>
      <ConnectionNotices
        notices={shell.shellErrors.map((error) => ({
          id: error.id,
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
      {props.children(shell.reportButtonError)}
    </>
  );
}

const SAVED: SaveState = { kind: "saved-here" };
const importResult = (path: string): ImportResult => ({ operationId: "dohc-operation:test-import", path, tableName: "data", rowCount: 1 });
// What the renderer receives when main's import rejects: Electron prefixes
// the channel to the error's text.
const importRejected = (text: string) =>
  new Error(`Error invoking remote method 'desktop:import-to-database': Error: ${text}`);
const mode = (name: "Table" | "Raw") =>
  within(screen.getByRole("radiogroup", { name: "Show as" })).getByRole("radio", { name });

describe("CSV view actions", () => {
  beforeEach(() => {
    writeWorkspaceText.mockResolvedValue({ status: "written", contentHash: "hash-2" });
    vi.stubGlobal("dohcDesktop", {
      platform: "win32",
      importToDatabase,
      writeWorkspaceText,
      onEngineYDocSaveState: () => () => {},
      getUpdateState: () => new Promise(() => {}),
      onUpdateState: () => () => {},
    });
  });

  afterEach(async () => {
    // A closing view writes its last edit; wait for it before the bridge goes.
    await act(async () => {
      cleanup();
      await Promise.all(buffers.splice(0).map((buffer) => buffer.settled()));
    });
    for (const release of releases.splice(0)) release();
    resetSharedLocalDocumentsForTests();
    resetOrphanedDrafts();
    vi.unstubAllGlobals();
    importToDatabase.mockReset();
    writeWorkspaceText.mockReset();
  });

  it("draws one row of actions: the save state, Share, Table or Raw, then Import, in tab order", async () => {
    const user = userEvent.setup();
    const onShare = vi.fn();
    render(<CsvView {...csvFile("ws-1", "data.csv", "name,count\nAda,1")} onShare={onShare} onOpenPath={vi.fn()} />);

    const actions = screen.getAllByTestId("view-actions");
    expect(actions).toHaveLength(1);
    expect(within(actions[0]!).getByTestId("csv-save-state").dataset.state).toBe("saved");
    // A calm save state is for screen readers only; no language word or
    // second bar is drawn.
    expect(screen.getByTestId("csv-save-state").className).toContain("sr-only");
    expect(screen.queryByText("Import to SQLite")).toBeNull();

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Share file" }));
    await user.tab();
    expect(document.activeElement).toBe(mode("Table"));
    expect(mode("Table").getAttribute("aria-checked")).toBe("true");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId("csv-import-sqlite"));
    expect(screen.getByTestId("csv-import-sqlite").getAttribute("aria-label")).toBe("Import to SQLite");
    expect(screen.getByTestId("csv-import-sqlite").title).toBe("Import to SQLite");
    await user.click(screen.getByRole("button", { name: "Share file" }));
    expect(onShare).toHaveBeenCalledOnce();
  });

  it("moves between Table and Raw with the arrow keys and keeps the text", async () => {
    const user = userEvent.setup();
    render(<CsvView {...csvFile("ws-1", "data.csv", "name,count\nAda,1")} />);
    expect(screen.getByTestId("csv-raw-toggle").getAttribute("role")).toBe("radiogroup");

    mode("Table").focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(mode("Raw"));
    expect(mode("Raw").getAttribute("aria-checked")).toBe("true");
    expect((screen.getByTestId("csv-raw-editor") as HTMLTextAreaElement).value).toBe("name,count\nAda,1");

    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(mode("Table"));
    expect(screen.queryByTestId("csv-raw-editor")).toBeNull();
    expect((screen.getByLabelText("Row 1 column 1") as HTMLInputElement).value).toBe("Ada");
  });

  it("adds a row from the table's last row and a column from the header's end", async () => {
    const user = userEvent.setup();
    render(<CsvView {...csvFile("ws-1", "data.csv", "name,count\nAda,1")} />);

    const addRow = screen.getByTestId("csv-add-row");
    const addColumn = screen.getByTestId("csv-add-column");
    expect(addRow.getAttribute("aria-label")).toBe("Add row");
    expect(addColumn.getAttribute("aria-label")).toBe("Add column");
    expect(addRow.closest("tr")).toBe(screen.getByRole("table").querySelector("tbody tr:last-child"));
    expect(addColumn.closest("th")).toBe(screen.getByRole("table").querySelector("thead th:last-child"));

    await user.click(addRow);
    expect(screen.getByLabelText("Row 2 column 1")).toBeTruthy();
    await user.click(addColumn);
    expect((screen.getByLabelText("Header column 3") as HTMLInputElement).value).toBe("column_3");
    // In Raw, the table and its add controls are gone.
    await user.click(mode("Raw"));
    expect(screen.queryByTestId("csv-add-row")).toBeNull();
    expect(screen.queryByTestId("csv-add-column")).toBeNull();
  });

  it.each([
    ["read-only", { readOnly: true }, "This document is shared with you to read."],
    ["too large", { truncated: true }, "This file is too large to edit in dohc."],
  ])("shows a %s table with its mark, without add controls, and with Import disabled", (_, lock, title) => {
    render(<CsvView {...csvFile("ws-1", "data.csv", "name\nAda")} {...lock} onOpenPath={vi.fn()} />);

    const state = screen.getByTestId("csv-save-state");
    expect(state.className).not.toContain("sr-only");
    expect(state.textContent).toBe("Read-only");
    expect(state.title).toBe(title);
    expect(screen.queryByTestId("csv-add-row")).toBeNull();
    expect(screen.queryByTestId("csv-add-column")).toBeNull();
    expect((screen.getByTestId("csv-import-sqlite") as HTMLButtonElement).disabled).toBe(true);
    expect(mode("Raw").hasAttribute("disabled")).toBe(false);
  });

  it.each([
    ["saving", { kind: "saving" } as SaveState, "saving", true, "Saving…"],
    ["failed", { kind: "error", reason: "disk full", issueId: null } as SaveState, "error", false, "Couldn't save"],
  ])("draws a %s save state in the tab row", (_, saveState, dataState, quiet, label) => {
    render(
      <CsvViewActions saveState={saveState} mode="table" onModeChange={vi.fn()} onShare={vi.fn()} />,
    );
    const state = screen.getByTestId("csv-save-state");
    expect(state.dataset.state).toBe(dataState);
    expect(state.className.includes("sr-only")).toBe(quiet);
    expect(state.textContent).toBe(label);
  });

  it("marks a running import busy, keeps focus on it, and imports once", async () => {
    const user = userEvent.setup();
    const answer = deferred<ImportResult>();
    importToDatabase.mockReturnValue(answer.promise);
    const onOpenPath = vi.fn();
    render(<CsvView {...csvFile("ws-1", "data/rows.csv", "name\nAda")} onOpenPath={onOpenPath} />);

    const button = screen.getByTestId("csv-import-sqlite") as HTMLButtonElement;
    const status = within(button.parentElement!).getByRole("status");
    expect(status.textContent).toBe("");
    await user.click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    // The button keeps its name; a polite status says the import started.
    expect(button.getAttribute("aria-label")).toBe("Import to SQLite");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Importing to SQLite…");
    expect(within(button).getByTestId("csv-import-sqlite-pending")).toBeTruthy();
    await user.click(button);
    expect(importToDatabase).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1",
      sourceRelativePath: "data/rows.csv",
      databaseRelativePath: "data/rows.sqlite",
      tableName: "rows",
    });

    await act(async () => answer.resolve(importResult("data/rows.sqlite")));
    expect(onOpenPath).toHaveBeenCalledExactlyOnceWith("data/rows.sqlite");
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(status.textContent).toBe("");
  });

  it("reports a failed import as a toast and a Notices row with Try again, not in the view", async () => {
    const user = userEvent.setup();
    importToDatabase.mockRejectedValueOnce(importRejected("Database already exists: data.sqlite"));
    importToDatabase.mockResolvedValueOnce(importResult("data.sqlite"));
    const onOpenPath = vi.fn();
    render(
      <Shell>
        {(onError) => <CsvView {...csvFile("ws-1", "data.csv", "name\nAda")} onOpenPath={onOpenPath} onError={onError} />}
      </Shell>,
    );

    await user.click(screen.getByTestId("csv-import-sqlite"));
    const toast = await screen.findByTestId("workspace-shell-error");
    // What happened, naming the database, then the next step; the raw
    // message stays for Copy details.
    expect(within(toast).getByText(
      "dohc could not import this file to data.sqlite. That file already exists. Rename or move it, then try again.",
    )).toBeTruthy();
    expect(toast.textContent).not.toContain("Database already exists");
    expect(within(screen.getByTestId("view-csv")).queryByText(/already exists/)).toBeNull();
    expect(screen.queryByTestId("csv-import-error")).toBeNull();

    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = screen.getByRole("dialog", { name: "Notices" });
    expect(within(notices).getAllByText(/could not import this file to data\.sqlite/)).toHaveLength(1);
    await user.click(within(notices).getByRole("button", { name: "Try again" }));
    expect(importToDatabase).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(onOpenPath).toHaveBeenCalledExactlyOnceWith("data.sqlite"));
  });

  it("runs no second import when an old row's Try again is pressed while an import runs", async () => {
    const user = userEvent.setup();
    const running = deferred<ImportResult>();
    importToDatabase.mockRejectedValueOnce(importRejected("Database already exists: data.sqlite"));
    importToDatabase.mockReturnValueOnce(running.promise);
    importToDatabase.mockResolvedValue(importResult("data.sqlite"));
    const onOpenPath = vi.fn();
    render(
      <Shell>
        {(onError) => <CsvView {...csvFile("ws-1", "data.csv", "name\nAda")} onOpenPath={onOpenPath} onError={onError} />}
      </Shell>,
    );

    const button = screen.getByTestId("csv-import-sqlite");
    await user.click(button);
    await screen.findByTestId("workspace-shell-error");
    await user.click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");

    await user.click(screen.getByTestId("notice-center-toggle"));
    await user.click(within(screen.getByRole("dialog", { name: "Notices" })).getByRole("button", { name: "Try again" }));
    expect(importToDatabase).toHaveBeenCalledTimes(2);
    expect(button.getAttribute("aria-busy")).toBe("true");

    // The header's view and the joined retry both answer with the one result.
    await act(async () => running.resolve(importResult("data.sqlite")));
    expect(onOpenPath).toHaveBeenCalledWith("data.sqlite");
    expect(onOpenPath.mock.calls.every(([path]) => path === "data.sqlite")).toBe(true);
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });

  it.each([
    ["a success opens the database", true],
    ["a failure files a new row", false],
  ])("answers an old row's Try again with the running import's result after the CSV closed: %s", async (_, succeeds) => {
    const user = userEvent.setup();
    const running = deferred<ImportResult>();
    importToDatabase.mockRejectedValueOnce(importRejected("Database already exists: data.sqlite"));
    importToDatabase.mockReturnValueOnce(running.promise);
    const onOpenPath = vi.fn();
    const file = csvFile("ws-1", "data.csv", "name\nAda");
    const shell = (open: boolean) => (
      <Shell>{(onError) => (open ? <CsvView {...file} onOpenPath={onOpenPath} onError={onError} /> : null)}</Shell>
    );
    const view = render(shell(true));

    await user.click(screen.getByTestId("csv-import-sqlite"));
    await screen.findByTestId("workspace-shell-error");
    await user.click(screen.getByTestId("csv-import-sqlite"));
    view.rerender(shell(false));

    await user.click(screen.getByTestId("notice-center-toggle"));
    await user.click(within(screen.getByRole("dialog", { name: "Notices" })).getByRole("button", { name: "Try again" }));
    await user.keyboard("{Escape}");
    expect(importToDatabase).toHaveBeenCalledTimes(2);

    if (succeeds) {
      await act(async () => running.resolve(importResult("data.sqlite")));
      expect(onOpenPath).toHaveBeenCalledExactlyOnceWith("data.sqlite");
    } else {
      await act(async () => running.reject(importRejected("Database already exists: data.sqlite")));
      const toast = await screen.findByTestId("workspace-shell-error");
      expect(toast.textContent).toContain("dohc could not import this file to data.sqlite.");
      expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
    }
  });

  it("answers a Try again pressed after the CSV closed: a failure files a new row, a success opens the database", async () => {
    const user = userEvent.setup();
    importToDatabase.mockRejectedValueOnce(importRejected("Database already exists: data.sqlite"));
    importToDatabase.mockRejectedValueOnce(importRejected("Database already exists: data.sqlite"));
    importToDatabase.mockResolvedValueOnce(importResult("data.sqlite"));
    const onOpenPath = vi.fn();
    const file = csvFile("ws-1", "data.csv", "name\nAda");
    const shell = (open: boolean) => (
      <Shell>{(onError) => (open ? <CsvView {...file} onOpenPath={onOpenPath} onError={onError} /> : null)}</Shell>
    );
    const view = render(shell(true));

    await user.click(screen.getByTestId("csv-import-sqlite"));
    await screen.findByTestId("workspace-shell-error");
    view.rerender(shell(false));
    expect(screen.queryByTestId("view-csv")).toBeNull();

    const tryAgainInNotices = async () => {
      await user.click(screen.getByTestId("notice-center-toggle"));
      await user.click(within(screen.getByRole("dialog", { name: "Notices" })).getByRole("button", { name: "Try again" }));
      await user.keyboard("{Escape}");
    };
    await tryAgainInNotices();
    expect(importToDatabase).toHaveBeenCalledTimes(2);
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("dohc could not import this file to data.sqlite.");

    await tryAgainInNotices();
    expect(importToDatabase).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: "ws-1", sourceRelativePath: "data.csv" }));
    await waitFor(() => expect(onOpenPath).toHaveBeenCalledExactlyOnceWith("data.sqlite"));
  });

  it("keeps an unmapped import error's own words after the sentence naming the database", async () => {
    const user = userEvent.setup();
    importToDatabase.mockRejectedValueOnce(importRejected("The CSV has no header row."));
    render(
      <Shell>
        {(onError) => <CsvView {...csvFile("ws-1", "data/rows.csv", "name\nAda")} onOpenPath={vi.fn()} onError={onError} />}
      </Shell>,
    );

    await user.click(screen.getByTestId("csv-import-sqlite"));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText("dohc could not import this file to data/rows.sqlite. The CSV has no header row.")).toBeTruthy();
  });

  it("drops an import answer that arrives after the view closed", async () => {
    const user = userEvent.setup();
    const answer = deferred<ImportResult>();
    importToDatabase.mockReturnValue(answer.promise);
    const onError = vi.fn();
    const onOpenPath = vi.fn();
    const view = render(<CsvView {...csvFile("ws-1", "data.csv", "name\nAda")} onOpenPath={onOpenPath} onError={onError} />);

    await user.click(screen.getByTestId("csv-import-sqlite"));
    view.unmount();
    await act(async () => answer.reject(importRejected("Database already exists: data.sqlite")));
    expect(onError).not.toHaveBeenCalled();
    expect(onOpenPath).not.toHaveBeenCalled();
  });

  it("draws the controls disabled in the same places while the CSV opens", () => {
    render(<CsvControls mode="table" importable disabled />);
    expect(mode("Table").hasAttribute("disabled")).toBe(true);
    expect(mode("Raw").hasAttribute("disabled")).toBe(true);
    expect((screen.getByTestId("csv-import-sqlite") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("text view actions", () => {
  afterEach(cleanup);

  it.each([
    ["saved", SAVED, {}, "saved", true, "Saved"],
    ["failed", { kind: "error", reason: "disk full", issueId: null } as SaveState, {}, "error", false, "Couldn't save"],
    ["read-only", SAVED, { readOnly: true }, "saved", false, "Read-only"],
  ])("draws a %s text file's save state beside Share", (_, saveState, lock, dataState, quiet, label) => {
    render(<TextViewActions testId="view-text" saveState={saveState} onShare={vi.fn()} {...lock} />);
    const state = screen.getByTestId("view-text-save-state");
    expect(state.dataset.state).toBe(dataState);
    expect(state.className.includes("sr-only")).toBe(quiet);
    expect(state.textContent).toBe(label);
    expect(screen.getByRole("button", { name: "Share file" })).toBeTruthy();
  });

  it("puts each group's actions in that group's tab row in a split", () => {
    render(
      <>
        <EditorGroupFrame tabs={(ref) => <div data-testid="left-row" ref={ref} />}>
          <TextViewActions testId="view-text" saveState={{ kind: "error", reason: "disk full", issueId: null }} onShare={vi.fn()} />
        </EditorGroupFrame>
        <EditorGroupFrame tabs={(ref) => <div data-testid="right-row" ref={ref} />}>
          <CsvViewActions saveState={SAVED} mode="raw" onModeChange={vi.fn()} onShare={vi.fn()} />
        </EditorGroupFrame>
      </>,
    );
    const left = screen.getByTestId("left-row");
    const right = screen.getByTestId("right-row");
    expect(within(left).getByTestId("view-text-save-state").textContent).toBe("Couldn't save");
    expect(within(left).queryByTestId("csv-raw-toggle")).toBeNull();
    expect(within(right).getByTestId("csv-save-state").dataset.state).toBe("saved");
    expect(within(right).getByRole("radio", { name: "Raw" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("view-actions")).toBeNull();
  });
});
