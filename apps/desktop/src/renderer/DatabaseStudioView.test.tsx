// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseEditResult, DatabaseSnapshotResult, DohcDesktopBridge } from "../ipc/bridgeContract";
import { DatabaseStudioView } from "./DatabaseStudioView";
import { deferred } from "../testing/deferred";

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
});

describe("DatabaseStudioView", () => {
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

  it.each([
    ["the first fails, then the second", ["fail", "fail"], [0, 1], "Food"],
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
});
