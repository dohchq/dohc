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
import {
  acquireSharedLocalDocument,
  resetSharedLocalDocumentsForTests,
} from "./sharedLocalDocument";
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

function csvFile(workspaceId: string, path: string, body: string) {
  const { buffer, release } = acquireSharedLocalDocument(
    documentVersionKey(workspaceId, path, undefined),
  );
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

function Shell(props: {
  children: (
    onError: ReturnType<typeof useShellError>["reportButtonError"],
    onNotice: ReturnType<typeof useShellError>["showSuccessNotice"],
  ) => ReactNode;
}) {
  const shell = useShellError("ws-1");
  return (
    <>
      <ConnectionNotices
        notices={shell.shellErrors.map((error) => ({
          id: error.id,
          message: error.message,
          copy: { report: errorDetails(error.details ?? []) },
          atMs: error.atMs,
          canRetry: error.retry !== null,
          seen: error.seen,
          tone: error.tone,
          actionLabel: error.action?.label,
        }))}
        reportFailure={shell.reportShellFailure}
        onRetry={shell.retryShellError}
        onAction={shell.runShellErrorAction}
        onHide={shell.hideShellError}
        onDismiss={shell.dismissShellError}
      />
      {props.children(shell.reportButtonError, shell.showSuccessNotice)}
    </>
  );
}

const SAVED: SaveState = { kind: "saved-here" };
const importResult = (path: string): ImportResult => ({
  operationId: "dohc-operation:test-import",
  path,
  tableName: "data",
  rowCount: 1,
});
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
    render(
      <CsvView
        {...csvFile("ws-1", "data.csv", "name,count\nAda,1")}
        onShare={onShare}
        onOpenPath={vi.fn()}
      />,
    );

    const actions = screen.getAllByTestId("view-actions");
    expect(actions).toHaveLength(1);
    expect(within(actions[0]!).getByTestId("csv-save-state").dataset.state).toBe("saved");
    expect(screen.getByTestId("csv-save-state").className).toContain("sr-only");
    expect(screen.queryByText("Import to SQLite")).toBeNull();

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Share file" }));
    await user.tab();
    expect(document.activeElement).toBe(mode("Table"));
    expect(mode("Table").getAttribute("aria-checked")).toBe("true");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId("csv-import-sqlite"));
    expect(screen.getByTestId("csv-import-sqlite").getAttribute("aria-label")).toBe(
      "Import to SQLite",
    );
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
    expect((screen.getByTestId("csv-raw-editor") as HTMLTextAreaElement).value).toBe(
      "name,count\nAda,1",
    );

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
    expect(addRow.closest("tr")).toBe(
      screen.getByRole("table").querySelector("tbody tr:last-child"),
    );
    expect(addColumn.closest("th")).toBe(
      screen.getByRole("table").querySelector("thead th:last-child"),
    );

    await user.click(addRow);
    expect(screen.getByLabelText("Row 2 column 1")).toBeTruthy();
    await user.click(addColumn);
    expect((screen.getByLabelText("Header column 3") as HTMLInputElement).value).toBe("column_3");
    await user.click(mode("Raw"));
    expect(screen.queryByTestId("csv-add-row")).toBeNull();
    expect(screen.queryByTestId("csv-add-column")).toBeNull();
  });

  it("restores a deleted row or column via Undo without clobbering edits made afterward", async () => {
    const user = userEvent.setup();
    const notices: Array<{ message: string; onUndo?: () => void }> = [];
    render(
      <CsvView
        {...csvFile("ws-1", "data.csv", "name,count\nAda,1\nGrace,2")}
        onNotice={(message, onUndo) => {
          notices.push({ message, onUndo });
        }}
      />,
    );

    await user.click(screen.getByLabelText("Delete row 1"));
    expect((screen.getByLabelText("Row 1 column 1") as HTMLInputElement).value).toBe("Grace");
    expect(notices.at(-1)?.message).toBe("Deleted row 1.");

    // Edit the surviving row before undoing the deletion.
    const surviving = screen.getByLabelText("Row 1 column 1") as HTMLInputElement;
    await user.clear(surviving);
    await user.type(surviving, "Grace Hopper");

    act(() => notices.at(-1)?.onUndo?.());
    expect((screen.getByLabelText("Row 1 column 1") as HTMLInputElement).value).toBe("Ada");
    expect((screen.getByLabelText("Row 2 column 1") as HTMLInputElement).value).toBe(
      "Grace Hopper",
    );

    // Same check for column deletion + subsequent edit + Undo.
    await user.click(screen.getByLabelText("Delete column 2"));
    expect(screen.queryByLabelText("Header column 2")).toBeNull();
    expect(notices.at(-1)?.message).toBe('Deleted column "count".');
    const row1Name = screen.getByLabelText("Row 1 column 1") as HTMLInputElement;
    await user.clear(row1Name);
    await user.type(row1Name, "Ada Lovelace");

    act(() => notices.at(-1)?.onUndo?.());
    expect((screen.getByLabelText("Row 1 column 1") as HTMLInputElement).value).toBe(
      "Ada Lovelace",
    );
    expect((screen.getByLabelText("Row 1 column 2") as HTMLInputElement).value).toBe("1");
    expect((screen.getByLabelText("Row 2 column 2") as HTMLInputElement).value).toBe("2");
  });

  it("restores deleted columns by row identity after another row is deleted and retires Undo across Raw edits", async () => {
    const user = userEvent.setup();
    const notices: Array<{ message: string; onUndo?: () => void }> = [];
    render(
      <CsvView
        {...csvFile("ws-1", "cities.csv", "name,city\nAda,Paris\nGrace,Tokyo\nLin,Oslo")}
        onNotice={(message, onUndo) => {
          notices.push({ message, onUndo });
        }}
      />,
    );

    // Delete "city" column, then delete Ada's row, then undo "city" followed by undoing Ada's row.
    await user.click(screen.getByLabelText("Delete column 2"));
    const undoCity = notices.at(-1)?.onUndo;
    await user.click(screen.getByLabelText("Delete row 1"));
    const undoAda = notices.at(-1)?.onUndo;

    act(() => undoCity?.());
    expect((screen.getByLabelText("Row 1 column 1") as HTMLInputElement).value).toBe("Grace");
    expect((screen.getByLabelText("Row 1 column 2") as HTMLInputElement).value).toBe("Tokyo");
    expect((screen.getByLabelText("Row 2 column 1") as HTMLInputElement).value).toBe("Lin");
    expect((screen.getByLabelText("Row 2 column 2") as HTMLInputElement).value).toBe("Oslo");

    // Undoing Ada's row after undoing "city" also restores Ada's original city ("Paris").
    act(() => undoAda?.());
    expect((screen.getByLabelText("Row 1 column 1") as HTMLInputElement).value).toBe("Ada");
    expect((screen.getByLabelText("Row 1 column 2") as HTMLInputElement).value).toBe("Paris");
    expect((screen.getByLabelText("Row 2 column 2") as HTMLInputElement).value).toBe("Tokyo");

    // Reverse undo order (delete city, delete Ada, undo Ada first, then undo city) restores identically.
    await user.click(screen.getByLabelText("Delete column 2"));
    const undoCity2 = notices.at(-1)?.onUndo;
    await user.click(screen.getByLabelText("Delete row 1"));
    const undoAda2 = notices.at(-1)?.onUndo;
    act(() => undoAda2?.());
    act(() => undoCity2?.());
    expect((screen.getByLabelText("Row 1 column 1") as HTMLInputElement).value).toBe("Ada");
    expect((screen.getByLabelText("Row 1 column 2") as HTMLInputElement).value).toBe("Paris");
    expect((screen.getByLabelText("Row 2 column 2") as HTMLInputElement).value).toBe("Tokyo");
    expect((screen.getByLabelText("Row 3 column 2") as HTMLInputElement).value).toBe("Oslo");

    // Switching to Raw mode and editing retires pending table Undo callbacks so they never overwrite Source edits.
    await user.click(screen.getByLabelText("Delete row 1"));
    const staleUndo = notices.at(-1)?.onUndo;
    await user.click(mode("Raw"));
    const rawEditor = screen.getByTestId("csv-raw-editor") as HTMLTextAreaElement;
    await user.type(rawEditor, "\nSam,Rome");
    act(() => staleUndo?.());
    expect(rawEditor.value).toContain("Sam,Rome");
  });

  it("restores all rows when deleting the last column of a one-column CSV and undoing in either order", async () => {
    const user = userEvent.setup();
    const notices: Array<{ message: string; onUndo?: () => void }> = [];
    render(
      <CsvView
        {...csvFile("ws-1", "single.csv", "name\nAda\nGrace")}
        onNotice={(message, onUndo) => {
          notices.push({ message, onUndo });
        }}
      />,
    );

    // Delete Ada's row, then delete the only column, then undo row first and column second.
    await user.click(screen.getByLabelText("Delete row 1"));
    const undoAda = notices.at(-1)?.onUndo;
    await user.click(screen.getByLabelText("Delete column 1"));
    const undoCol = notices.at(-1)?.onUndo;

    act(() => undoAda?.());
    act(() => undoCol?.());
    expect((screen.getByLabelText("Header column 1") as HTMLInputElement).value).toBe("name");
    expect((screen.getByLabelText("Row 1 column 1") as HTMLInputElement).value).toBe("Ada");
    expect((screen.getByLabelText("Row 2 column 1") as HTMLInputElement).value).toBe("Grace");

    // Repeat with column Undo first and row Undo second.
    await user.click(screen.getByLabelText("Delete row 1"));
    const undoAda2 = notices.at(-1)?.onUndo;
    await user.click(screen.getByLabelText("Delete column 1"));
    const undoCol2 = notices.at(-1)?.onUndo;

    act(() => undoCol2?.());
    act(() => undoAda2?.());
    expect((screen.getByLabelText("Header column 1") as HTMLInputElement).value).toBe("name");
    expect((screen.getByLabelText("Row 1 column 1") as HTMLInputElement).value).toBe("Ada");
    expect((screen.getByLabelText("Row 2 column 1") as HTMLInputElement).value).toBe("Grace");

    // Starting a new table from the empty state retires older Undo notices.
    await user.click(screen.getByLabelText("Delete column 1"));
    const staleColUndo = notices.at(-1)?.onUndo;
    await user.click(screen.getByTestId("csv-empty-add-row"));
    act(() => staleColUndo?.());
    expect((screen.getByLabelText("Header column 1") as HTMLInputElement).value).toBe("column");
    expect((screen.getByLabelText("Row 1 column 1") as HTMLInputElement).value).toBe("");
  });

  it("preserves original row order when multiple row deletions are undone out of order", async () => {
    const user = userEvent.setup();
    const notices: Array<{ message: string; onUndo?: () => void }> = [];
    render(
      <CsvView
        {...csvFile("ws-1", "people.csv", "name\nAda\nGrace\nLin\nJo")}
        onNotice={(message, onUndo) => {
          notices.push({ message, onUndo });
        }}
      />,
    );

    await user.click(screen.getByLabelText("Delete row 1"));
    const undoAda = notices.at(-1)?.onUndo;
    // After deleting Ada, rows are Grace (1), Lin (2), Jo (3).
    await user.click(screen.getByLabelText("Delete row 2"));
    const undoLin = notices.at(-1)?.onUndo;

    // Undo Ada first, then Lin — original order Ada, Grace, Lin, Jo must hold.
    act(() => undoAda?.());
    act(() => undoLin?.());
    expect((screen.getByLabelText("Row 1 column 1") as HTMLInputElement).value).toBe("Ada");
    expect((screen.getByLabelText("Row 2 column 1") as HTMLInputElement).value).toBe("Grace");
    expect((screen.getByLabelText("Row 3 column 1") as HTMLInputElement).value).toBe("Lin");
    expect((screen.getByLabelText("Row 4 column 1") as HTMLInputElement).value).toBe("Jo");
  });

  it("preserves extra columns beyond the 500-row preview and keeps ragged short rows unpadded on delete and Undo", async () => {
    const user = userEvent.setup();
    const notices: Array<{ message: string; onUndo?: () => void }> = [];
    const lines = ["name"];
    for (let index = 1; index <= 500; index++) lines.push(`row${index}`);
    lines.push("Grace,Tokyo");
    const original = lines.join("\n");
    const file = csvFile("ws-1", "wide-tail.csv", original);
    render(
      <CsvView
        {...file}
        onNotice={(message, onUndo) => {
          notices.push({ message, onUndo });
        }}
      />,
    );

    await user.click(screen.getByLabelText("Delete row 1"));
    const afterDelete = file.localBuffer.getSnapshot().body.split("\n");
    expect(afterDelete[0]).toBe("name");
    expect(afterDelete[1]).toBe("row2");
    expect(afterDelete.at(-1)).toBe("Grace,Tokyo");

    act(() => notices.at(-1)?.onUndo?.());
    expect(file.localBuffer.getSnapshot().body).toBe(original);

    // Ragged rows keep their exact lengths through delete and Undo.
    cleanup();
    const raggedOriginal = "a,b,c\n1\n2,3,\n4,5,6";
    const ragged = csvFile("ws-1", "ragged.csv", raggedOriginal);
    const raggedNotices: Array<{ message: string; onUndo?: () => void }> = [];
    render(
      <CsvView
        {...ragged}
        onNotice={(message, onUndo) => {
          raggedNotices.push({ message, onUndo });
        }}
      />,
    );

    await user.click(screen.getByLabelText("Delete row 3"));
    expect(ragged.localBuffer.getSnapshot().body).toBe("a,b,c\n1\n2,3,");
    act(() => raggedNotices.at(-1)?.onUndo?.());
    expect(ragged.localBuffer.getSnapshot().body).toBe(raggedOriginal);

    // Deleting column 1 from a ragged CSV keeps a short trailing row intact across Raw round-trips and restores it on Undo.
    cleanup();
    const shortTail = csvFile("ws-1", "short-tail.csv", "a,b\n1,2\n3");
    const shortTailNotices: Array<{ message: string; onUndo?: () => void }> = [];
    render(
      <CsvView
        {...shortTail}
        onNotice={(message, onUndo) => {
          shortTailNotices.push({ message, onUndo });
        }}
      />,
    );

    await user.click(screen.getByLabelText("Delete column 1"));
    expect(shortTail.localBuffer.getSnapshot().body).toBe('b\n2\n""');
    expect(screen.getByLabelText("Row 2 column 1")).toBeTruthy();

    act(() => shortTailNotices.at(-1)?.onUndo?.());
    expect(shortTail.localBuffer.getSnapshot().body).toBe("a,b\n1,2\n3");

    await user.click(screen.getByLabelText("Delete column 1"));
    await user.click(mode("Raw"));
    await user.click(mode("Table"));
    expect((screen.getByLabelText("Header column 1") as HTMLInputElement).value).toBe("b");
    expect((screen.getByLabelText("Row 1 column 1") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("Row 2 column 1") as HTMLInputElement).value).toBe("");
  });

  it("handles delete and Undo quickly on a 10,000-row CSV with a 5,000-column tail row", async () => {
    const user = userEvent.setup();
    const notices: Array<{ message: string; onUndo?: () => void }> = [];
    const lines = ["name"];
    for (let index = 1; index <= 10000; index++) lines.push("x");
    lines.push(Array.from({ length: 5000 }, (_, i) => `c${i}`).join(","));
    const original = lines.join("\n");
    const file = csvFile("ws-1", "huge-tail.csv", original);
    render(
      <CsvView
        {...file}
        onNotice={(message, onUndo) => {
          notices.push({ message, onUndo });
        }}
      />,
    );

    await user.click(screen.getByLabelText("Delete row 1"));
    act(() => notices.at(-1)?.onUndo?.());
    expect(file.localBuffer.getSnapshot().body).toBe(original);
  });

  it("dismisses pending CSV Undo notices from the shell when starting a new table from empty or switching to Raw", async () => {
    const user = userEvent.setup();
    const file = csvFile("ws-1", "single-shell.csv", "name\nAda\nGrace");
    render(
      <Shell>
        {(onError, onNotice) => <CsvView {...file} onError={onError} onNotice={onNotice} />}
      </Shell>,
    );

    await user.click(screen.getByLabelText("Delete column 1"));
    const toast = await screen.findByTestId("workspace-shell-notice");
    expect(within(toast).getByText('Deleted column "name".')).toBeTruthy();
    expect(within(toast).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(screen.getByTestId("notice-center-toggle")).toBeTruthy();

    // Adding a row to the empty table immediately removes the now-retired Undo notice.
    await user.click(screen.getByTestId("csv-empty-add-row"));
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
    expect(screen.queryByTestId("notice-center-toggle")).toBeNull();

    // Adding a column to an empty table also removes the retired Undo notice.
    await user.click(screen.getByLabelText("Delete column 1"));
    expect(await screen.findByTestId("workspace-shell-notice")).toBeTruthy();
    await user.click(screen.getByTestId("csv-empty-add-column"));
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
    expect(screen.queryByTestId("notice-center-toggle")).toBeNull();

    // Switching to Raw mode also dismisses pending Undo notices.
    await user.click(screen.getByLabelText("Delete column 1"));
    expect(await screen.findByTestId("workspace-shell-notice")).toBeTruthy();
    await user.click(mode("Raw"));
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
    expect(screen.queryByTestId("notice-center-toggle")).toBeNull();
  });

  it("does not append duplicate empty rows when pressing Enter on an empty last row", async () => {
    const user = userEvent.setup();
    render(<CsvView {...csvFile("ws-1", "data.csv", "name,count\nAda,1")} />);

    const row1 = screen.getByLabelText("Row 1 column 1");
    await user.click(row1);
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Row 2 column 1")).toBeTruthy();

    // Row 2 is blank; pressing Enter again should not append a Row 3.
    await user.keyboard("{Enter}");
    expect(screen.queryByLabelText("Row 3 column 1")).toBeNull();
  });

  it.each([
    ["read-only", { readOnly: true }, "This document is shared with you to read.", "Read-only"],
    [
      "too large",
      { truncated: true },
      "This file is too large to edit in dohc.",
      "Too large to edit",
    ],
  ])(
    "shows a %s table with its mark, without add controls, and with Import disabled",
    (_, lock, title, label) => {
      render(
        <CsvView {...csvFile("ws-1", "data.csv", "name\nAda")} {...lock} onOpenPath={vi.fn()} />,
      );

      const state = screen.getByTestId("csv-save-state");
      expect(state.className).not.toContain("sr-only");
      expect(state.textContent).toBe(label);
      expect(state.title).toBe(title);
      expect(screen.queryByTestId("csv-add-row")).toBeNull();
      expect(screen.queryByTestId("csv-add-column")).toBeNull();
      expect((screen.getByTestId("csv-import-sqlite") as HTMLButtonElement).disabled).toBe(true);
      expect(mode("Raw").hasAttribute("disabled")).toBe(false);
    },
  );

  it.each([
    ["saving", { kind: "saving" } as SaveState, "saving", true, "Saving…"],
    [
      "failed",
      { kind: "error", reason: "disk full", issueId: null } as SaveState,
      "error",
      false,
      "Couldn't save",
    ],
  ])("draws a %s save state in the tab row", (_, saveState, dataState, quiet, label) => {
    render(
      <CsvViewActions
        saveState={saveState}
        mode="table"
        onModeChange={vi.fn()}
        onShare={vi.fn()}
      />,
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
        {(onError) => (
          <CsvView
            {...csvFile("ws-1", "data.csv", "name\nAda")}
            onOpenPath={onOpenPath}
            onError={onError}
          />
        )}
      </Shell>,
    );

    await user.click(screen.getByTestId("csv-import-sqlite"));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(
      within(toast).getByText(
        "dohc could not import this file to data.sqlite. That file already exists. Rename or move it, then try again.",
      ),
    ).toBeTruthy();
    expect(toast.textContent).not.toContain("Database already exists");
    expect(within(screen.getByTestId("view-csv")).queryByText(/already exists/)).toBeNull();
    expect(screen.queryByTestId("csv-import-error")).toBeNull();

    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = screen.getByRole("dialog", { name: "Notices" });
    expect(within(notices).getAllByText(/could not import this file to data\.sqlite/)).toHaveLength(
      1,
    );
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
        {(onError) => (
          <CsvView
            {...csvFile("ws-1", "data.csv", "name\nAda")}
            onOpenPath={onOpenPath}
            onError={onError}
          />
        )}
      </Shell>,
    );

    const button = screen.getByTestId("csv-import-sqlite");
    await user.click(button);
    await screen.findByTestId("workspace-shell-error");
    await user.click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");

    await user.click(screen.getByTestId("notice-center-toggle"));
    await user.click(
      within(screen.getByRole("dialog", { name: "Notices" })).getByRole("button", {
        name: "Try again",
      }),
    );
    expect(importToDatabase).toHaveBeenCalledTimes(2);
    expect(button.getAttribute("aria-busy")).toBe("true");

    await act(async () => running.resolve(importResult("data.sqlite")));
    expect(onOpenPath).toHaveBeenCalledWith("data.sqlite");
    expect(onOpenPath.mock.calls.every(([path]) => path === "data.sqlite")).toBe(true);
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });

  it.each([
    ["a success opens the database", true],
    ["a failure files a new row", false],
  ])(
    "answers an old row's Try again with the running import's result after the CSV closed: %s",
    async (_, succeeds) => {
      const user = userEvent.setup();
      const running = deferred<ImportResult>();
      importToDatabase.mockRejectedValueOnce(
        importRejected("Database already exists: data.sqlite"),
      );
      importToDatabase.mockReturnValueOnce(running.promise);
      const onOpenPath = vi.fn();
      const file = csvFile("ws-1", "data.csv", "name\nAda");
      const shell = (open: boolean) => (
        <Shell>
          {(onError) =>
            open ? <CsvView {...file} onOpenPath={onOpenPath} onError={onError} /> : null
          }
        </Shell>
      );
      const view = render(shell(true));

      await user.click(screen.getByTestId("csv-import-sqlite"));
      await screen.findByTestId("workspace-shell-error");
      await user.click(screen.getByTestId("csv-import-sqlite"));
      view.rerender(shell(false));

      await user.click(screen.getByTestId("notice-center-toggle"));
      await user.click(
        within(screen.getByRole("dialog", { name: "Notices" })).getByRole("button", {
          name: "Try again",
        }),
      );
      await user.keyboard("{Escape}");
      expect(importToDatabase).toHaveBeenCalledTimes(2);

      if (succeeds) {
        await act(async () => running.resolve(importResult("data.sqlite")));
        expect(onOpenPath).toHaveBeenCalledExactlyOnceWith("data.sqlite");
      } else {
        await act(async () =>
          running.reject(importRejected("Database already exists: data.sqlite")),
        );
        const toast = await screen.findByTestId("workspace-shell-error");
        expect(toast.textContent).toContain("dohc could not import this file to data.sqlite.");
        expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
      }
    },
  );

  it("answers a Try again pressed after the CSV closed: a failure files a new row, a success opens the database", async () => {
    const user = userEvent.setup();
    importToDatabase.mockRejectedValueOnce(importRejected("Database already exists: data.sqlite"));
    importToDatabase.mockRejectedValueOnce(importRejected("Database already exists: data.sqlite"));
    importToDatabase.mockResolvedValueOnce(importResult("data.sqlite"));
    const onOpenPath = vi.fn();
    const file = csvFile("ws-1", "data.csv", "name\nAda");
    const shell = (open: boolean) => (
      <Shell>
        {(onError) =>
          open ? <CsvView {...file} onOpenPath={onOpenPath} onError={onError} /> : null
        }
      </Shell>
    );
    const view = render(shell(true));

    await user.click(screen.getByTestId("csv-import-sqlite"));
    await screen.findByTestId("workspace-shell-error");
    view.rerender(shell(false));
    expect(screen.queryByTestId("view-csv")).toBeNull();

    const tryAgainInNotices = async () => {
      await user.click(screen.getByTestId("notice-center-toggle"));
      await user.click(
        within(screen.getByRole("dialog", { name: "Notices" })).getByRole("button", {
          name: "Try again",
        }),
      );
      await user.keyboard("{Escape}");
    };
    await tryAgainInNotices();
    expect(importToDatabase).toHaveBeenCalledTimes(2);
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("dohc could not import this file to data.sqlite.");

    await tryAgainInNotices();
    expect(importToDatabase).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", sourceRelativePath: "data.csv" }),
    );
    await waitFor(() => expect(onOpenPath).toHaveBeenCalledExactlyOnceWith("data.sqlite"));
  });

  it("keeps an unmapped import error's own words after the sentence naming the database", async () => {
    const user = userEvent.setup();
    importToDatabase.mockRejectedValueOnce(importRejected("The CSV has no header row."));
    render(
      <Shell>
        {(onError) => (
          <CsvView
            {...csvFile("ws-1", "data/rows.csv", "name\nAda")}
            onOpenPath={vi.fn()}
            onError={onError}
          />
        )}
      </Shell>,
    );

    await user.click(screen.getByTestId("csv-import-sqlite"));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(
      within(toast).getByText(
        "dohc could not import this file to data/rows.sqlite. The CSV has no header row.",
      ),
    ).toBeTruthy();
  });

  it("drops an import answer that arrives after the view closed", async () => {
    const user = userEvent.setup();
    const answer = deferred<ImportResult>();
    importToDatabase.mockReturnValue(answer.promise);
    const onError = vi.fn();
    const onOpenPath = vi.fn();
    const view = render(
      <CsvView
        {...csvFile("ws-1", "data.csv", "name\nAda")}
        onOpenPath={onOpenPath}
        onError={onError}
      />,
    );

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
    [
      "failed",
      { kind: "error", reason: "disk full", issueId: null } as SaveState,
      {},
      "error",
      false,
      "Couldn't save",
    ],
    ["read-only", SAVED, { readOnly: true }, "saved", false, "Read-only"],
  ])(
    "draws a %s text file's save state beside Share",
    (_, saveState, lock, dataState, quiet, label) => {
      render(
        <TextViewActions testId="view-text" saveState={saveState} onShare={vi.fn()} {...lock} />,
      );
      const state = screen.getByTestId("view-text-save-state");
      expect(state.dataset.state).toBe(dataState);
      expect(state.className.includes("sr-only")).toBe(quiet);
      expect(state.textContent).toBe(label);
      expect(screen.getByRole("button", { name: "Share file" })).toBeTruthy();
    },
  );

  it("puts each group's actions in that group's tab row in a split", () => {
    render(
      <>
        <EditorGroupFrame tabs={(ref) => <div data-testid="left-row" ref={ref} />}>
          <TextViewActions
            testId="view-text"
            saveState={{ kind: "error", reason: "disk full", issueId: null }}
            onShare={vi.fn()}
          />
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
    expect(within(right).getByRole("radio", { name: "Raw" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.queryByTestId("view-actions")).toBeNull();
  });
});
