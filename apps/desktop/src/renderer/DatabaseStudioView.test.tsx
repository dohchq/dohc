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
} from "../ipc/bridgeContract";
import { rendererMarks } from "../performance/rendererMarks";
import { DatabaseStudioView } from "./DatabaseStudioView";
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
  applyDatabaseEdit: vi.fn(async (): Promise<DatabaseEditResult> => walletPage("Groceries")),
};

function renderStudio() {
  return render(
    <DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" />,
  );
}

const cell = (column: string, row: string) => screen.getByTestId(`db-cell-${column}-${row}`);
const editor = () => screen.getByTestId("db-cell-input") as HTMLInputElement;
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
  vi.clearAllMocks();
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
      "dohc could not save the change to category in wallet.",
      failure,
      expect.any(Function),
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
