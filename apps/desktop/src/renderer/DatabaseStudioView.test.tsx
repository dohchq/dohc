// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DatabaseEditResult,
  DatabaseSnapshotResult,
  DohcDesktopBridge,
} from "../ipc/bridgeContract";
import { rendererMarks } from "../performance/rendererMarks";
import { DatabaseStudioView } from "./DatabaseStudioView";
import { useShellError } from "./shell/useShellError";
import { deferred } from "../testing/deferred";

// Every cell text the grid measures for its column widths.
const measured = vi.hoisted(() => [] as string[]);
vi.mock("./ui/DataGrid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui/DataGrid")>();
  return {
    ...actual,
    cellMeasure: (numeric: boolean) => {
      const measure = actual.cellMeasure(numeric);
      return (text: string) => {
        measured.push(text);
        return measure(text);
      };
    },
  };
});

const baseSnapshot: DatabaseSnapshotResult = {
  path: "imports/wallet.sqlite",
  tables: [
    {
      name: "wallet",
      columns: [
        { name: "id", type: "TEXT", primaryKey: true, nullable: false },
        { name: "amount", type: "INTEGER", nullable: false },
        { name: "category", type: "TEXT" },
      ],
      rows: [
        { id: "txn_001", amount: 42, category: "Food" },
        { id: "txn_002", amount: 10, category: "Transport" },
        { id: "txn_003", amount: null, category: "" },
      ],
      nextOffset: null,
    },
    {
      name: "notes",
      columns: [
        { name: "key", type: "TEXT", primaryKey: true },
        { name: "value", type: "TEXT" },
      ],
      rows: [{ key: "memo", value: "Quarter close" }],
      nextOffset: null,
    },
  ],
};

function cloneSnapshot(snapshot = baseSnapshot): DatabaseSnapshotResult {
  return JSON.parse(JSON.stringify(snapshot)) as DatabaseSnapshotResult;
}

// The wallet's first page after an edit set txn_001's category.
function walletPage(category: string, path = baseSnapshot.path): DatabaseEditResult {
  return {
    path,
    table: "wallet",
    page: {
      offset: 0,
      rows: [
        { id: "txn_001", amount: 42, category },
        { id: "txn_002", amount: 10, category: "Transport" },
        { id: "txn_003", amount: null, category: "" },
      ],
      nextOffset: null,
    },
    version: 1,
  };
}

const bridgeMock = {
  readWorkspaceDatabase: vi.fn(async () => cloneSnapshot()),
  readWorkspaceDatabasePage: vi.fn(),
  applyDatabaseEdit: vi.fn<DohcDesktopBridge["applyDatabaseEdit"]>(async () => walletPage("Groceries")),
};

function renderStudio() {
  return render(
    <DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" />,
  );
}

// Answers for the next writes, which the test settles in any order. One may
// settle before its write goes out behind an earlier write to the table, so
// each is handled from the start.
function writeAnswers(count: number) {
  const answers = Array.from({ length: count }, () => deferred<DatabaseEditResult>());
  for (const answer of answers) {
    void answer.promise.catch(() => undefined);
    bridgeMock.applyDatabaseEdit.mockImplementationOnce(() => answer.promise);
  }
  return answers;
}

const cell = (column: string, row: string) => screen.getByTestId(`db-cell-${column}-${row}`);
const editor = () => screen.getByTestId("db-cell-input") as HTMLInputElement;

async function editCell(user: ReturnType<typeof userEvent.setup>, column: string, row: string, value: string) {
  await user.click(cell(column, row));
  await user.clear(editor());
  await user.keyboard(`${value}{Enter}`);
}

// The shell's error list, each row with its Try again, around a database.
function WithNotices(props: { path: string }) {
  const shell = useShellError("ws-1");
  return (
    <>
      <ul aria-label="Notices">
        {shell.shellErrors.map((notice) => (
          <li key={notice.id}>
            {notice.message}
            <button type="button" onClick={() => shell.retryShellError(notice.id)}>Try again</button>
          </li>
        ))}
      </ul>
      <DatabaseStudioView workspaceId="ws-1" path={props.path} onError={shell.reportButtonError} />
    </>
  );
}

const notices = () => within(screen.getByRole("list", { name: "Notices" })).queryAllByRole("listitem");
const categoryEdit = (category: string) => ({
  workspaceId: "ws-1",
  relativePath: "imports/wallet.sqlite",
  edit: {
    table: "wallet",
    op: "update",
    pkColumn: "id",
    rowId: "txn_001",
    payload: { category },
  },
});

beforeEach(() => {
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Also drops one-time answers a failed test left queued.
  vi.resetAllMocks();
  measured.length = 0;
});

describe("DatabaseStudioView", () => {
  it("measures the first page from its editor group's open start", async () => {
    const measureSince = vi.spyOn(rendererMarks, "measureSince");
    render(
      <DatabaseStudioView
        workspaceId="ws-1"
        path="imports/wallet.sqlite"
        fileOpenStartMark="file-open-start:right"
      />,
    );

    await waitFor(() =>
      expect(measureSince).toHaveBeenCalledWith(
        "sqlite-first-page",
        "file-open-start:right",
      ),
    );
    measureSince.mockRestore();
  });

  it("says a database with no tables has none, under the table picture", async () => {
    bridgeMock.readWorkspaceDatabase.mockResolvedValueOnce({ ...cloneSnapshot(), tables: [] });
    renderStudio();
    const line = await screen.findByText("No tables in this database.");
    expect(line.parentElement!.textContent).toBe("No tables in this database.");
    expect(line.previousElementSibling!.getAttribute("aria-hidden")).toBe("true");
  });

  it("lists each table's rows and columns, draws only the search above the grid, and filters loaded rows", async () => {
    const user = userEvent.setup();
    renderStudio();

    await screen.findByTestId("view-database");
    const list = screen.getByTestId("db-table-list");
    expect(within(list).getByText("wallet")).toBeTruthy();
    expect(within(list).getByText("3 rows · 3 columns")).toBeTruthy();
    for (const removed of ["db-visible-row-count", "db-schema-strip", "db-edit-error"]) {
      expect(screen.queryByTestId(removed)).toBeNull();
    }
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByTestId("db-read-only")).toBeNull();

    await user.type(screen.getByTestId("db-filter-input"), "transport");

    expect(cell("category", "txn_002").textContent).toBe("Transport");
    expect(screen.queryByTestId("db-cell-category-txn_001")).toBeNull();
    // The gutter numbers the rows the search shows.
    const rows = screen.getAllByTestId("db-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector("td")!.textContent).toBe("1");
  });

  it("heads each column with its type as an icon, and keeps the full type in the header's tooltip and description", async () => {
    bridgeMock.readWorkspaceDatabase.mockResolvedValueOnce({
      path: "imports/wallet.sqlite",
      tables: [
        {
          name: "kinds",
          columns: [
            { name: "id", type: "TEXT", primaryKey: true, nullable: false },
            { name: "amount", type: "INTEGER" },
            { name: "rate", type: "REAL", nullable: false },
            { name: "photo", type: "BLOB" },
            { name: "label", type: "VARCHAR(20)" },
            { name: "note", type: "" },
          ],
          rows: [{ id: "a", amount: 1, rate: 0.5, photo: "<blob 4 bytes>", label: "x", note: null }],
          nextOffset: null,
        },
      ],
    });
    renderStudio();

    await screen.findByTestId("db-cell-id-a");
    const typeIcon = (name: string) =>
      [...screen.getByRole("columnheader", { name }).querySelectorAll("svg")]
        .map((icon) => /lucide-(type|hash|binary)(\s|$)/.exec(icon.getAttribute("class") ?? "")?.[1])
        .find(Boolean) ?? null;
    expect(["id", "amount", "rate", "photo", "label", "note"].map(typeIcon)).toEqual([
      "type", "hash", "hash", "binary", "type", null,
    ]);
    for (const [name, description] of [
      ["id", "TEXT · primary key · required"],
      ["amount", "INTEGER"],
      ["rate", "REAL · required"],
      ["label", "VARCHAR(20)"],
      ["note", "No type"],
    ]) {
      expect(screen.getByRole("columnheader", { name, description })).toBeTruthy();
    }
    // Numbers sit at the right in mono, by the column's declared type.
    const grid = screen.getByRole("grid", { name: "kinds" });
    expect([0, 1, 2, 3, 4, 5].map((column) => grid.style.getPropertyValue(`--data-grid-align-${column}`))).toEqual([
      "", "right", "right", "", "", "",
    ]);
    expect(cell("amount", "a").style.textAlign).toBe("var(--data-grid-align-1)");
  });

  it("finds every column's width once per load, and again only for a column whose values changed", async () => {
    const user = userEvent.setup();
    bridgeMock.applyDatabaseEdit.mockResolvedValueOnce(walletPage("Groceries and household"));
    renderStudio();
    await screen.findByTestId("db-cell-category-txn_001");
    expect(measured).toEqual(["txn_001", "txn_002", "txn_003", "42", "10", "NULL", "Food", "Transport", ""]);
    const widths = screen.getByTestId("data-grid-widths");
    expect(widths.querySelectorAll("td")[3]!.textContent).toBe("categoryTransport");

    measured.length = 0;
    await user.click(cell("category", "txn_001"));
    await user.clear(editor());
    await user.keyboard("Groceries and household{Enter}");
    await waitFor(() => expect(bridgeMock.applyDatabaseEdit).toHaveBeenCalled());
    expect(measured).toEqual(["Groceries and household", "Transport", ""]);
    expect(widths.querySelectorAll("td")[3]!.textContent).toBe("categoryGroceries and household");
  });

  it("sorts the loaded rows without changing row edit identity", async () => {
    const user = userEvent.setup();
    renderStudio();

    await screen.findByTestId("view-database");
    await user.click(screen.getByTestId("db-sort-amount"));
    expect(screen.getByTestId("db-sort-amount").getAttribute("aria-sort")).toBe("ascending");

    const ascending = screen
      .getAllByTestId("db-row")
      .map((row) => row.textContent ?? "");
    expect(ascending[0]).toContain("txn_002");
    expect(ascending[1]).toContain("txn_001");

    await user.click(screen.getByTestId("db-sort-amount"));
    expect(screen.getByTestId("db-sort-amount").getAttribute("aria-sort")).toBe("descending");
    const descending = screen
      .getAllByTestId("db-row")
      .map((row) => row.textContent ?? "");
    expect(descending[0]).toContain("txn_001");
    expect(descending[1]).toContain("txn_002");
  });

  it("moves through the grid from the keyboard, cell by cell, with one tab stop", async () => {
    const user = userEvent.setup();
    renderStudio();
    await screen.findByTestId("db-cell-id-txn_001");
    const grid = screen.getByRole("grid", { name: "wallet" });
    const stops = () => [...grid.querySelectorAll('[tabindex="0"]')];
    const focused = () => document.activeElement;
    expect(stops()).toEqual([cell("id", "txn_001")]);

    // Tab enters the grid at its tab stop.
    await user.click(screen.getByTestId("db-filter-input"));
    await user.tab();
    expect(focused()).toBe(cell("id", "txn_001"));

    await user.keyboard("{ArrowRight}");
    expect(focused()).toBe(cell("amount", "txn_001"));
    await user.keyboard("{ArrowRight}");
    expect(focused()).toBe(cell("category", "txn_001"));
    await user.keyboard("{ArrowRight}");
    expect(focused()).toBe(cell("category", "txn_001"));
    await user.keyboard("{ArrowDown}");
    expect(focused()).toBe(cell("category", "txn_002"));
    await user.keyboard("{ArrowDown}");
    expect(focused()).toBe(cell("category", "txn_003"));
    await user.keyboard("{ArrowDown}");
    expect(focused()).toBe(cell("category", "txn_003"));
    await user.keyboard("{ArrowLeft}");
    expect(focused()).toBe(cell("amount", "txn_003"));
    expect(stops()).toEqual([cell("amount", "txn_003")]);

    // Up from the first row reaches the header, where Enter and Space sort.
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(focused()).toBe(screen.getByTestId("db-sort-amount"));
    await user.keyboard("{ArrowUp}");
    expect(focused()).toBe(screen.getByTestId("db-sort-amount"));
    expect(stops()).toEqual([screen.getByTestId("db-sort-amount")]);
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("db-sort-amount").getAttribute("aria-sort")).toBe("ascending");
    await user.keyboard(" ");
    expect(screen.getByTestId("db-sort-amount").getAttribute("aria-sort")).toBe("descending");

    // Enter opens the editor; its arrow keys stay in it; Escape gives focus
    // back to the cell.
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(focused()).toBe(cell("category", "txn_001"));
    await user.keyboard("{Enter}");
    expect(editor().value).toBe("Food");
    expect(focused()).toBe(editor());
    await user.keyboard("{ArrowLeft}{ArrowDown}");
    expect(focused()).toBe(editor());
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("db-cell-input")).toBeNull();
    expect(focused()).toBe(cell("category", "txn_001"));

    // F2 opens it too; Enter commits and gives focus back to the cell.
    await user.keyboard("{F2}");
    await user.clear(editor());
    await user.keyboard("Groceries{Enter}");
    expect(bridgeMock.applyDatabaseEdit).toHaveBeenCalledWith(categoryEdit("Groceries"));
    expect(screen.queryByTestId("db-cell-input")).toBeNull();
    expect(focused()).toBe(cell("category", "txn_001"));

    // The key column takes no editor.
    await user.keyboard("{ArrowLeft}{ArrowLeft}{Enter}");
    expect(focused()).toBe(cell("id", "txn_001"));
    expect(screen.queryByTestId("db-cell-input")).toBeNull();

    // Tab leaves the grid.
    await user.tab();
    expect(grid.contains(focused())).toBe(false);
  });

  it("commits edits through the declared primary key and merges the returned page", async () => {
    const user = userEvent.setup();
    renderStudio();

    await screen.findByTestId("view-database");
    await user.click(cell("category", "txn_001"));
    fireEvent.change(editor(), { target: { value: "Groceries" } });
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(bridgeMock.applyDatabaseEdit).toHaveBeenCalledWith(categoryEdit("Groceries"));
    });
    await waitFor(() => expect(cell("category", "txn_001").textContent).toBe("Groceries"));
    await user.click(within(screen.getByTestId("db-table-list")).getByText("notes"));
    expect((await screen.findByTestId("db-cell-value-memo")).textContent).toBe("Quarter close");
  });

  it("commits the cell draft on blur and discards it on Escape", async () => {
    const user = userEvent.setup();
    renderStudio();
    await screen.findByTestId("db-cell-category-txn_001");
    await user.click(cell("category", "txn_001"));
    await user.clear(editor());
    await user.type(editor(), "Groceries");
    await user.tab();
    await waitFor(() =>
      expect(bridgeMock.applyDatabaseEdit).toHaveBeenCalledWith(categoryEdit("Groceries")),
    );
    await waitFor(() => expect(cell("category", "txn_001").textContent).toBe("Groceries"));
    bridgeMock.applyDatabaseEdit.mockClear();
    await user.click(cell("category", "txn_002"));
    expect(editor().value).toBe("Transport");
    await user.type(editor(), " discarded");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("db-cell-input")).toBeNull();
    expect(bridgeMock.applyDatabaseEdit).not.toHaveBeenCalled();
    expect(cell("category", "txn_002").textContent).toBe("Transport");
  });

  it("writes nothing for an unchanged draft, by Enter or by leaving the cell", async () => {
    const user = userEvent.setup();
    renderStudio();
    await screen.findByTestId("db-cell-category-txn_001");

    await user.click(cell("category", "txn_001"));
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("db-cell-input")).toBeNull();

    // A draft typed back to the cell's value is unchanged too.
    await user.click(cell("category", "txn_001"));
    await user.type(editor(), "s{Backspace}");
    await user.click(screen.getByTestId("db-filter-input"));
    expect(screen.queryByTestId("db-cell-input")).toBeNull();

    // A NULL cell starts its edit empty.
    await user.click(cell("amount", "txn_003"));
    expect(editor().value).toBe("");
    await user.keyboard("{Enter}");

    expect(bridgeMock.applyDatabaseEdit).not.toHaveBeenCalled();
    expect(cell("category", "txn_001").textContent).toBe("Food");
    expect(cell("amount", "txn_003").textContent).toBe("NULL");
  });

  it("shows a new value at once, and a failed write puts the old value back and reports it with Try again", async () => {
    const user = userEvent.setup();
    const write = deferred<DatabaseEditResult>();
    bridgeMock.applyDatabaseEdit.mockImplementationOnce(() => write.promise);
    const onError = vi.fn();
    render(<DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" onError={onError} />);
    await screen.findByTestId("db-cell-category-txn_001");

    await user.click(cell("category", "txn_001"));
    await user.clear(editor());
    await user.keyboard("Groceries{Enter}");
    expect(cell("category", "txn_001").textContent).toBe("Groceries");

    const failure = new Error("database is locked");
    await act(async () => write.reject(failure));
    expect(cell("category", "txn_001").textContent).toBe("Food");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      "dohc could not save the change to the category column for id txn_001 in the wallet table.",
      failure,
      expect.any(Function),
      // The cell's identity: workspace, database, table, row key and column.
      ["database-cell", "ws-1", "imports/wallet.sqlite", "wallet", "id", "txn_001", "category"].join("\0"),
    );
    expect(screen.queryByTestId("db-edit-error")).toBeNull();

    // Try again writes the same change, and shows it at once again.
    const retry = deferred<DatabaseEditResult>();
    bridgeMock.applyDatabaseEdit.mockClear();
    bridgeMock.applyDatabaseEdit.mockImplementationOnce(() => retry.promise);
    act(() => (onError.mock.calls[0]![2] as () => void)());
    expect(bridgeMock.applyDatabaseEdit).toHaveBeenCalledWith(categoryEdit("Groceries"));
    expect(cell("category", "txn_001").textContent).toBe("Groceries");
    await act(async () => retry.resolve(walletPage("Groceries")));
    expect(cell("category", "txn_001").textContent).toBe("Groceries");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("shows a retried write only in its own database, not in the one open when Try again is chosen", async () => {
    const user = userEvent.setup();
    const [failed, retried] = writeAnswers(2);
    const onError = vi.fn();
    const { rerender } = render(
      <DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" onError={onError} />,
    );
    await screen.findByTestId("db-cell-category-txn_001");
    await user.click(cell("category", "txn_001"));
    await user.clear(editor());
    await user.keyboard("Groceries{Enter}");
    await act(async () => failed!.reject(new Error("database is locked")));
    expect(onError).toHaveBeenCalledTimes(1);

    // Another database with a table and a row of the same names.
    const other = cloneSnapshot();
    other.path = "imports/other.sqlite";
    other.tables[0]!.rows[0]!.category = "Rent";
    bridgeMock.readWorkspaceDatabase.mockResolvedValueOnce(other);
    rerender(<DatabaseStudioView workspaceId="ws-1" path="imports/other.sqlite" onError={onError} />);
    await waitFor(() => expect(cell("category", "txn_001").textContent).toBe("Rent"));

    act(() => (onError.mock.calls[0]![2] as () => void)());
    expect(bridgeMock.applyDatabaseEdit).toHaveBeenLastCalledWith(categoryEdit("Groceries"));
    expect(cell("category", "txn_001").textContent).toBe("Rent");
    await act(async () => retried!.resolve(walletPage("Groceries")));
    expect(cell("category", "txn_001").textContent).toBe("Rent");
  });

  it("files one Notice with its own Try again for each row whose write fails", async () => {
    const user = userEvent.setup();
    const answers = writeAnswers(2);
    render(<WithNotices path="imports/wallet.sqlite" />);
    await screen.findByTestId("db-cell-category-txn_001");

    await editCell(user, "category", "txn_001", "Groceries");
    await editCell(user, "category", "txn_002", "Travel");
    for (const answer of answers) {
      await act(async () => answer.reject(new Error("database is locked")));
    }

    await waitFor(() => expect(notices()).toHaveLength(2));
    const [first, second] = notices();
    expect(first!.textContent).toContain(
      "dohc could not save the change to the category column for id txn_001 in the wallet table.",
    );
    expect(second!.textContent).toContain(
      "dohc could not save the change to the category column for id txn_002 in the wallet table.",
    );

    // Each Try again writes its own row's change.
    bridgeMock.applyDatabaseEdit.mockClear();
    await user.click(within(first!).getByRole("button", { name: "Try again" }));
    expect(bridgeMock.applyDatabaseEdit).toHaveBeenCalledWith(categoryEdit("Groceries"));
    expect(bridgeMock.applyDatabaseEdit).toHaveBeenCalledTimes(1);
  });

  it("keeps one Notice per database when the same table, row and column fail in two of them", async () => {
    const user = userEvent.setup();
    const answers = writeAnswers(2);
    const { rerender } = render(<WithNotices path="imports/wallet.sqlite" />);
    await screen.findByTestId("db-cell-category-txn_001");
    await editCell(user, "category", "txn_001", "Groceries");
    await act(async () => answers[0]!.reject(new Error("database is locked")));

    const other = cloneSnapshot();
    other.path = "imports/other.sqlite";
    other.tables[0]!.rows[0]!.category = "Rent";
    bridgeMock.readWorkspaceDatabase.mockResolvedValueOnce(other);
    rerender(<WithNotices path="imports/other.sqlite" />);
    await waitFor(() => expect(cell("category", "txn_001").textContent).toBe("Rent"));
    await editCell(user, "category", "txn_001", "Travel");
    await act(async () => answers[1]!.reject(new Error("database is locked")));

    // The same words, for two databases.
    await waitFor(() => expect(notices()).toHaveLength(2));
    expect(notices()[0]!.textContent).toBe(notices()[1]!.textContent);
    bridgeMock.applyDatabaseEdit.mockClear();
    for (const notice of notices()) {
      await user.click(within(notice).getByRole("button", { name: "Try again" }));
    }
    expect(bridgeMock.applyDatabaseEdit.mock.calls.map(([write]) => [write.relativePath, write.edit.payload])).toEqual([
      ["imports/wallet.sqlite", { category: "Groceries" }],
      ["imports/other.sqlite", { category: "Travel" }],
    ]);
  });

  it("keeps one Notice per row when long row keys differ only past the words a Notice shows", async () => {
    const user = userEvent.setup();
    const [first, second] = ["k".repeat(599) + "1", "k".repeat(599) + "2"];
    bridgeMock.readWorkspaceDatabase.mockResolvedValueOnce({
      path: "imports/wallet.sqlite",
      tables: [
        {
          name: "wallet",
          columns: [
            { name: "id", type: "TEXT", primaryKey: true, nullable: false },
            { name: "category", type: "TEXT" },
          ],
          rows: [
            { id: first, category: "Food" },
            { id: second, category: "Food" },
          ],
          nextOffset: null,
        },
      ],
    });
    const answers = writeAnswers(2);
    render(<WithNotices path="imports/wallet.sqlite" />);
    await screen.findByTestId(`db-cell-category-${first}`);

    await editCell(user, "category", first, "Groceries");
    await editCell(user, "category", second, "Travel");
    for (const answer of answers) {
      await act(async () => answer.reject(new Error("database is locked")));
    }

    // Cut short, both Notices read the same.
    await waitFor(() => expect(notices()).toHaveLength(2));
    expect(notices()[0]!.textContent).toBe(notices()[1]!.textContent);
    bridgeMock.applyDatabaseEdit.mockClear();
    for (const notice of notices()) {
      await user.click(within(notice).getByRole("button", { name: "Try again" }));
    }
    expect(bridgeMock.applyDatabaseEdit.mock.calls.map(([write]) => write.edit.rowId)).toEqual([first, second]);
  });

  it("replaces a cell's Notice when the same cell fails again, whatever the reason", async () => {
    const user = userEvent.setup();
    const answers = writeAnswers(2);
    render(<WithNotices path="imports/wallet.sqlite" />);
    await screen.findByTestId("db-cell-category-txn_001");

    await editCell(user, "category", "txn_001", "Groceries");
    await act(async () => answers[0]!.reject(new Error("database is locked")));
    await waitFor(() => expect(notices()).toHaveLength(1));
    await editCell(user, "category", "txn_001", "Travel");
    await act(async () => answers[1]!.reject(new Error("disk I/O error")));

    // One Notice, the newer one, whose Try again writes the newer value.
    await waitFor(() => expect(notices()[0]!.textContent).toContain("disk I/O error"));
    expect(notices()).toHaveLength(1);
    bridgeMock.applyDatabaseEdit.mockClear();
    await user.click(within(notices()[0]!).getByRole("button", { name: "Try again" }));
    expect(bridgeMock.applyDatabaseEdit).toHaveBeenCalledWith(categoryEdit("Travel"));
    expect(bridgeMock.applyDatabaseEdit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the first fails, then the second", ["fail", "fail"], [0, 1], "Food"],
    ["the second fails, then the first", ["fail", "fail"], [1, 0], "Food"],
    ["the first is saved, then the second fails", ["save", "fail"], [0, 1], "Groceries"],
  ] as const)(
    "puts back the value the database last saved when overlapping writes to one cell fail: %s",
    async (_, outcomes, order, shown) => {
      const user = userEvent.setup();
      const writes = writeAnswers(2);
      const onError = vi.fn();
      render(<DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" onError={onError} />);
      await screen.findByTestId("db-cell-category-txn_001");

      // Food to Groceries, then Groceries to Travel, before either answers.
      await user.click(cell("category", "txn_001"));
      await user.clear(editor());
      await user.keyboard("Groceries{Enter}");
      await user.keyboard("{Enter}");
      expect(editor().value).toBe("Groceries");
      await user.clear(editor());
      await user.keyboard("Travel{Enter}");
      expect(cell("category", "txn_001").textContent).toBe("Travel");

      for (const index of order) {
        await act(async () => {
          if (outcomes[index] === "save") writes[index]!.resolve(walletPage(index === 0 ? "Groceries" : "Travel"));
          else writes[index]!.reject(new Error("database is locked"));
        });
      }
      await waitFor(() => expect(cell("category", "txn_001").textContent).toBe(shown));
      expect(onError).toHaveBeenCalledTimes(outcomes.filter((outcome) => outcome === "fail").length);
    },
  );

  it("sends one write per table at a time, so an older write's answer never lands after a newer one's", async () => {
    const user = userEvent.setup();
    const [groceries, travel] = writeAnswers(2);
    renderStudio();
    await screen.findByTestId("db-cell-category-txn_001");

    await user.click(cell("category", "txn_001"));
    await user.clear(editor());
    await user.keyboard("Groceries{Enter}{Enter}");
    await user.clear(editor());
    await user.keyboard("Travel{Enter}");
    expect(bridgeMock.applyDatabaseEdit).toHaveBeenCalledTimes(1);

    // Travel's success is ready first; Groceries' answers after it.
    await act(async () => travel!.resolve(walletPage("Travel")));
    await act(async () => groceries!.resolve(walletPage("Groceries")));
    await waitFor(() => expect(bridgeMock.applyDatabaseEdit).toHaveBeenCalledTimes(2));
    expect(bridgeMock.applyDatabaseEdit).toHaveBeenLastCalledWith(categoryEdit("Travel"));
    await waitFor(() => expect(cell("category", "txn_001").textContent).toBe("Travel"));
  });

  it("drops writes from an older load: a failure after a refresh shows the refreshed value", async () => {
    const user = userEvent.setup();
    const [groceries, travel] = writeAnswers(2);
    const onError = vi.fn();
    const { rerender } = render(
      <DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" refreshKey={0} onError={onError} />,
    );
    await screen.findByTestId("db-cell-category-txn_001");
    await user.click(cell("category", "txn_001"));
    await user.clear(editor());
    await user.keyboard("Groceries{Enter}");

    // Before Food to Groceries answers, a refresh reads Rent.
    const refreshed = cloneSnapshot();
    refreshed.tables[0]!.rows[0]!.category = "Rent";
    bridgeMock.readWorkspaceDatabase.mockResolvedValueOnce(refreshed);
    rerender(<DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" refreshKey={1} onError={onError} />);
    await waitFor(() => expect(cell("category", "txn_001").textContent).toBe("Rent"));

    // Rent to Travel fails, and Food to Groceries answers after the refresh.
    await user.click(cell("category", "txn_001"));
    expect(editor().value).toBe("Rent");
    await user.clear(editor());
    await user.keyboard("Travel{Enter}");
    expect(cell("category", "txn_001").textContent).toBe("Travel");
    await act(async () => travel!.reject(new Error("database is locked")));
    await act(async () => groceries!.reject(new Error("database is locked")));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(cell("category", "txn_001").textContent).toBe("Rent");
  });

  it("leaves focus where another part of the window moved it when an edit ends", async () => {
    const user = userEvent.setup();
    // Something outside the grid takes focus on Enter, after the editor's own handler.
    render(
      <div
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.querySelector<HTMLElement>("#outside")!.focus();
        }}
      >
        <button id="outside" type="button">Outside</button>
        <DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" />
      </div>,
    );
    await screen.findByTestId("db-cell-category-txn_001");
    await user.click(cell("category", "txn_001"));
    await user.clear(editor());
    await user.keyboard("Groceries{Enter}");

    expect(bridgeMock.applyDatabaseEdit).toHaveBeenCalledWith(categoryEdit("Groceries"));
    expect(screen.queryByTestId("db-cell-input")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Outside" }));
  });

  it("starts the tab stop on the first row's first cell when the rows load after the grid", async () => {
    const user = userEvent.setup();
    const empty = cloneSnapshot();
    empty.tables[0]!.rows = [];
    bridgeMock.readWorkspaceDatabase.mockResolvedValueOnce(empty);
    const { rerender } = render(
      <DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" refreshKey={0} />,
    );
    await screen.findByTestId("db-empty-rows");
    const stops = () => [...screen.getByRole("grid", { name: "wallet" }).querySelectorAll('[tabindex="0"]')];
    // With no rows, the header holds it.
    expect(stops()).toEqual([screen.getByTestId("db-sort-id")]);

    rerender(<DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" refreshKey={1} />);
    await screen.findByTestId("db-cell-id-txn_001");
    expect(stops()).toEqual([cell("id", "txn_001")]);
    await user.click(screen.getByTestId("db-filter-input"));
    await user.tab();
    expect(document.activeElement).toBe(cell("id", "txn_001"));
  });

  it("keeps the tab stop on the header when the person went there before the rows loaded", async () => {
    const user = userEvent.setup();
    const empty = cloneSnapshot();
    empty.tables[0]!.rows = [];
    bridgeMock.readWorkspaceDatabase.mockResolvedValueOnce(empty);
    const { rerender } = render(
      <DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" refreshKey={0} />,
    );
    await screen.findByTestId("db-empty-rows");
    await user.click(screen.getByTestId("db-filter-input"));
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByTestId("db-sort-amount"));

    rerender(<DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" refreshKey={1} />);
    await screen.findByTestId("db-cell-id-txn_001");
    const grid = screen.getByRole("grid", { name: "wallet" });
    expect([...grid.querySelectorAll('[tabindex="0"]')]).toEqual([screen.getByTestId("db-sort-amount")]);
  });

  it("keeps the only tab stop on the focused cell when an edit moves its row, and Tab still leaves the grid", async () => {
    const user = userEvent.setup();
    // The writes stay unanswered, so the new values decide the order.
    const unanswered = () => new Promise<DatabaseEditResult>(() => {});
    bridgeMock.applyDatabaseEdit.mockImplementationOnce(unanswered).mockImplementationOnce(unanswered);
    renderStudio();
    await screen.findByTestId("db-cell-amount-txn_001");
    const grid = screen.getByRole("grid", { name: "wallet" });
    const stops = () => [...grid.querySelectorAll('[tabindex="0"]')];
    const order = () => screen.getAllByTestId("db-row").map((row) => row.querySelectorAll("td")[1]!.textContent);

    // Amounts ascending: 10, 42, then the NULL.
    await user.click(screen.getByTestId("db-sort-amount"));
    expect(order()).toEqual(["txn_002", "txn_001", "txn_003"]);

    // 42 becomes 5, and its row moves up to the first place.
    await user.click(cell("amount", "txn_001"));
    await user.clear(editor());
    await user.keyboard("5{Enter}");
    expect(order()).toEqual(["txn_001", "txn_002", "txn_003"]);
    expect(document.activeElement).toBe(cell("amount", "txn_001"));
    expect(stops()).toEqual([cell("amount", "txn_001")]);

    // 5 becomes 50, and its row moves back down past 10's.
    await user.keyboard("{Enter}");
    await user.clear(editor());
    await user.keyboard("50{Enter}");
    expect(order()).toEqual(["txn_002", "txn_001", "txn_003"]);
    expect(document.activeElement).toBe(cell("amount", "txn_001"));
    expect(stops()).toEqual([cell("amount", "txn_001")]);

    await user.tab();
    expect(grid.contains(document.activeElement)).toBe(false);
  });

  it("sorts when a header's type icon or sort arrow is clicked", async () => {
    const user = userEvent.setup();
    renderStudio();
    await screen.findByTestId("db-cell-amount-txn_001");
    const icon = (column: string, name: string) =>
      screen.getByTestId(`db-sort-${column}`).querySelector<SVGElement>(`svg.lucide-${name}`)!;
    const sorted = (column: string) => screen.getByTestId(`db-sort-${column}`).getAttribute("aria-sort");

    await user.click(icon("amount", "hash"));
    expect(sorted("amount")).toBe("ascending");
    await user.click(icon("amount", "arrow-up"));
    expect(sorted("amount")).toBe("descending");
    // An unsorted column's arrow, shown only on hover or focus.
    await user.click(icon("category", "arrow-up"));
    expect(sorted("category")).toBe("ascending");
    expect(sorted("amount")).toBe("none");
  });

  it("ends a number column's name where its numbers end, with its hidden sort arrow before its icon", async () => {
    const user = userEvent.setup();
    renderStudio();
    await screen.findByTestId("db-cell-amount-txn_001");
    // A header's parts, left to right: icons by name, and the column's name.
    const parts = (column: string) =>
      [...screen.getByTestId(`db-sort-${column}`).firstElementChild!.children].map((part) => {
        const svg = part.matches("svg") ? part : part.querySelector("svg");
        if (!svg) return part.textContent;
        const name = [...svg.classList].find((name) => name.startsWith("lucide-"))!.slice("lucide-".length);
        return svg === part ? name : `${name} on hover`;
      });

    expect(parts("amount")).toEqual(["arrow-up on hover", "hash", "amount"]);
    expect(parts("category")).toEqual(["type", "category", "arrow-up on hover"]);
    // A sorted number column keeps its arrow after its name, as drawn.
    await user.click(screen.getByTestId("db-sort-amount"));
    expect(parts("amount")).toEqual(["hash", "amount", "arrow-up"]);
  });

  it("marks a NULL and an editing cell by more than their colour", async () => {
    const user = userEvent.setup();
    renderStudio();
    await screen.findByTestId("db-cell-amount-txn_003");
    expect(cell("amount", "txn_003").firstElementChild!.className).toMatch(/(^| )italic( |$)/);
    expect(cell("amount", "txn_001").firstElementChild!.className).not.toMatch(/(^| )italic( |$)/);

    // An editing cell draws a text field's underline; the active cell does not.
    await user.click(cell("category", "txn_001"));
    expect(editor().className).toContain("shadow-[inset_0_-1px_0_var(--dohc-muted)]");
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(cell("category", "txn_001"));
    expect(cell("category", "txn_001").querySelector("input")).toBeNull();
  });

  it("names a row in a failed write's Notice only by a key column the grid shows", async () => {
    const user = userEvent.setup();
    bridgeMock.readWorkspaceDatabase.mockResolvedValueOnce({
      path: "imports/wallet.sqlite",
      tables: [
        {
          name: "wallet",
          columns: [{ name: "category", type: "TEXT" }],
          rows: [{ __dohc_rowid: 7, category: "Food" }],
          nextOffset: null,
        },
      ],
    });
    const failure = new Error("database is locked");
    bridgeMock.applyDatabaseEdit.mockRejectedValueOnce(failure);
    const onError = vi.fn();
    render(<DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" onError={onError} />);
    await screen.findByTestId("db-cell-category-7");

    await editCell(user, "category", "7", "Groceries");
    // A rowid is SQLite's own number: no column shows it, and the gutter
    // numbers rows as they are sorted and searched.
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "dohc could not save the change to the category column in the wallet table.",
        failure,
        expect.any(Function),
        ["database-cell", "ws-1", "imports/wallet.sqlite", "wallet", "rowid", "7", "category"].join("\0"),
      ),
    );
  });

  it("offers no editor in a database shared to read, and says why with one read-only mark", async () => {
    const user = userEvent.setup();
    render(<DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" readOnly />);
    await screen.findByTestId("db-cell-category-txn_001");

    const mark = screen.getByTestId("db-read-only");
    expect(mark.textContent).toBe("Read-only");
    expect(mark.getAttribute("title")).toBe("This database is shared with you to read.");
    expect(mark.querySelector("svg")!.getAttribute("class")).toContain("lucide-lock");
    expect(screen.getByRole("grid", { name: "wallet" }).getAttribute("aria-readonly")).toBe("true");

    await user.click(cell("category", "txn_001"));
    expect(document.activeElement).toBe(cell("category", "txn_001"));
    await user.keyboard("{Enter}");
    await user.keyboard("{F2}");
    expect(screen.queryByTestId("db-cell-input")).toBeNull();
    // The keyboard still moves through it.
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(cell("category", "txn_002"));
    expect(cell("category", "txn_001").className).not.toContain("cursor-text");
    expect(bridgeMock.applyDatabaseEdit).not.toHaveBeenCalled();
  });

  it("marks a table with no unique row key read-only, and offers no editor in it", async () => {
    const user = userEvent.setup();
    bridgeMock.readWorkspaceDatabase.mockResolvedValueOnce({
      path: "imports/wallet.sqlite",
      tables: [
        {
          name: "log",
          columns: [
            { name: "id", type: "TEXT" },
            { name: "event", type: "TEXT" },
          ],
          rows: [{ id: "e1", event: "opened" }],
          nextOffset: null,
        },
      ],
    });
    renderStudio();
    await screen.findByTestId("db-cell-event-e1");

    expect(screen.getByTestId("db-read-only").getAttribute("title")).toBe(
      "This table has no unique row key, so dohc can't change its rows.",
    );
    await user.click(cell("event", "e1"));
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("db-cell-input")).toBeNull();
  });

  it("keeps the draft when a refresh temporarily removes the edited row", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" />,
    );
    await screen.findByTestId("db-cell-category-txn_001");
    await user.click(cell("category", "txn_001"));
    fireEvent.change(editor(), {
      target: { value: "Uncommitted draft" },
    });
    await user.click(editor());
    const missing = cloneSnapshot();
    missing.tables[0]!.rows = missing.tables[0]!.rows.slice(1);
    bridgeMock.readWorkspaceDatabase.mockResolvedValueOnce(missing);
    rerender(
      <DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" refreshKey={1} />,
    );
    await waitFor(() => expect(screen.queryByTestId("db-cell-input")).toBeNull());
    rerender(
      <DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" refreshKey={2} />,
    );
    expect((await screen.findByTestId("db-cell-input") as HTMLInputElement).value).toBe(
      "Uncommitted draft",
    );
    expect(bridgeMock.applyDatabaseEdit).not.toHaveBeenCalled();
  });

  it("ignores an edit page after a refresh starts a newer load", async () => {
    const user = userEvent.setup();
    const oldEdit = deferred<DatabaseEditResult>();
    bridgeMock.applyDatabaseEdit.mockImplementationOnce(() => oldEdit.promise);
    const { rerender } = render(
      <DatabaseStudioView
        workspaceId="ws-1"
        path="imports/wallet.sqlite"
        refreshKey={0}
      />,
    );

    await screen.findByTestId("db-cell-category-txn_001");
    await user.click(cell("category", "txn_001"));
    fireEvent.change(editor(), {
      target: { value: "Old edit" },
    });
    await user.keyboard("{Enter}");

    const refreshed = cloneSnapshot();
    refreshed.tables[0]!.rows[0]!.category = "Fresh refresh";
    bridgeMock.readWorkspaceDatabase.mockResolvedValueOnce(refreshed);
    rerender(
      <DatabaseStudioView
        workspaceId="ws-1"
        path="imports/wallet.sqlite"
        refreshKey={1}
      />,
    );
    await waitFor(() => expect(cell("category", "txn_001").textContent).toBe("Fresh refresh"));

    await act(async () => {
      oldEdit.resolve(walletPage("Old edit"));
    });

    expect(cell("category", "txn_001").textContent).toBe("Fresh refresh");
    expect(screen.queryByText("Old edit")).toBeNull();
  });

  it.each(["answered", "failed"] as const)(
    "drops a slow edit that %s after a switch to another database",
    async (outcome) => {
      const user = userEvent.setup();
      const write = deferred<DatabaseEditResult>();
      bridgeMock.applyDatabaseEdit.mockImplementationOnce(() => write.promise);
      const onError = vi.fn();
      const { rerender } = render(
        <DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" onError={onError} />,
      );
      await screen.findByTestId("db-cell-category-txn_001");
      await user.click(cell("category", "txn_001"));
      await user.clear(editor());
      await user.keyboard("Groceries{Enter}");

      // Another database with a table and a row of the same names.
      const other = cloneSnapshot();
      other.path = "imports/other.sqlite";
      other.tables[0]!.rows[0]!.category = "Rent";
      bridgeMock.readWorkspaceDatabase.mockResolvedValueOnce(other);
      rerender(<DatabaseStudioView workspaceId="ws-1" path="imports/other.sqlite" onError={onError} />);
      await waitFor(() => expect(cell("category", "txn_001").textContent).toBe("Rent"));

      await act(async () => {
        if (outcome === "answered") write.resolve(walletPage("Groceries"));
        else write.reject(new Error("database is locked"));
      });
      expect(cell("category", "txn_001").textContent).toBe("Rent");
      // A failed write still reaches Notices, where Try again can redo it.
      expect(onError).toHaveBeenCalledTimes(outcome === "failed" ? 1 : 0);
    },
  );

  it("clears and ignores stale snapshots after switching workspaces", async () => {
    const oldRead = deferred<DatabaseSnapshotResult>();
    const newSnapshot = cloneSnapshot({
      path: "imports/new.sqlite",
      tables: [
        {
          name: "new_wallet",
          columns: [
            { name: "id", type: "TEXT", primaryKey: true, nullable: false },
            { name: "category", type: "TEXT" },
          ],
          rows: [{ id: "new_001", category: "New workspace" }],
          nextOffset: null,
        },
      ],
    });
    bridgeMock.readWorkspaceDatabase
      .mockImplementationOnce(() => oldRead.promise)
      .mockResolvedValueOnce(newSnapshot);

    const { rerender } = render(
      <DatabaseStudioView workspaceId="old" path="imports/old.sqlite" />,
    );
    rerender(<DatabaseStudioView workspaceId="new" path="imports/new.sqlite" />);

    expect((await screen.findByTestId("db-cell-category-new_001")).textContent).toBe("New workspace");
    await act(async () => {
      oldRead.resolve(cloneSnapshot());
    });

    await waitFor(() => expect(cell("category", "new_001").textContent).toBe("New workspace"));
    expect(screen.queryByText("Food")).toBeNull();
  });

  it("uses the unique row key instead of duplicate visible labels while editing", async () => {
    const user = userEvent.setup();
    const duplicateLabelSnapshot = cloneSnapshot({
      path: "imports/duplicates.sqlite",
      tables: [
        {
          name: "wallet",
          columns: [
            { name: "id", type: "TEXT" },
            { name: "category", type: "TEXT" },
          ],
          rows: [
            { __dohc_rowid: 101, id: "dup", category: "First" },
            { __dohc_rowid: 102, id: "dup", category: "Second" },
          ],
          nextOffset: null,
        },
      ],
    });
    bridgeMock.readWorkspaceDatabase.mockResolvedValueOnce(duplicateLabelSnapshot);

    render(<DatabaseStudioView workspaceId="ws-1" path="imports/duplicates.sqlite" />);
    const duplicateCells = await screen.findAllByTestId("db-cell-category-dup");
    await user.click(duplicateCells[0]!);

    expect(screen.getAllByTestId("db-cell-input")).toHaveLength(1);
    fireEvent.change(editor(), {
      target: { value: "First updated" },
    });
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(bridgeMock.applyDatabaseEdit).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        relativePath: "imports/duplicates.sqlite",
        edit: {
          table: "wallet",
          op: "update",
          pkColumn: "rowid",
          rowId: 101,
          payload: { category: "First updated" },
        },
      }),
    );
  });
});
