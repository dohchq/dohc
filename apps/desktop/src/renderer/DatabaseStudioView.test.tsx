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

const bridgeMock = {
  readWorkspaceDatabase: vi.fn(async () => cloneSnapshot()),
  readWorkspaceDatabasePage: vi.fn(),
  applyDatabaseEdit: vi.fn(async (): Promise<DatabaseEditResult> => ({
    path: baseSnapshot.path,
    table: "wallet",
    page: {
      offset: 0,
      rows: [
        { id: "txn_001", amount: 42, category: "Groceries" },
        { id: "txn_002", amount: 10, category: "Transport" },
        { id: "txn_003", amount: null, category: "" },
      ],
      nextOffset: null,
    },
    version: 1,
  })),
};

function renderStudio() {
  render(
    <DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" />,
  );
}

beforeEach(() => {
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
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

  it("renders table stats, schema chips, and filters loaded rows", async () => {
    const user = userEvent.setup();
    renderStudio();

    await screen.findByTestId("view-database");
    const list = screen.getByTestId("db-table-list");
    expect(within(list).getByText("wallet")).toBeTruthy();
    expect(within(list).getByText("3 rows · 3 columns")).toBeTruthy();
    expect(screen.getByTestId("db-visible-row-count").textContent).toBe(
      "3 of 3 loaded rows",
    );
    expect(screen.getByTestId("db-schema-strip").textContent).toContain(
      "idTEXTpkrequired",
    );

    await user.type(screen.getByTestId("db-filter-input"), "transport");

    expect(screen.getByTestId("db-visible-row-count").textContent).toBe(
      "1 of 3 loaded rows",
    );
    expect(screen.getByTestId("db-cell-category-txn_002").textContent).toBe(
      "Transport",
    );
    expect(screen.queryByTestId("db-cell-category-txn_001")).toBeNull();
  });

  it("sorts the loaded rows without changing row edit identity", async () => {
    const user = userEvent.setup();
    renderStudio();

    await screen.findByTestId("view-database");
    await user.click(screen.getByTestId("db-sort-amount"));

    const ascending = screen
      .getAllByTestId("db-row")
      .map((row) => row.textContent ?? "");
    expect(ascending[0]).toContain("txn_002");
    expect(ascending[1]).toContain("txn_001");

    await user.click(screen.getByTestId("db-sort-amount"));
    const descending = screen
      .getAllByTestId("db-row")
      .map((row) => row.textContent ?? "");
    expect(descending[0]).toContain("txn_001");
    expect(descending[1]).toContain("txn_002");
  });

  it("commits edits through the declared primary key and merges the returned page", async () => {
    const user = userEvent.setup();
    renderStudio();

    await screen.findByTestId("view-database");
    await user.click(screen.getByTestId("db-cell-category-txn_001"));
    const input = screen.getByTestId("db-cell-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Groceries" } });
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(bridgeMock.applyDatabaseEdit).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        relativePath: "imports/wallet.sqlite",
        edit: {
          table: "wallet",
          op: "update",
          pkColumn: "id",
          rowId: "txn_001",
          payload: { category: "Groceries" },
        },
      });
    });
    expect(await screen.findByText("Groceries")).toBeTruthy();
    await user.click(within(screen.getByTestId("db-table-list")).getByText("notes"));
    expect(await screen.findByText("Quarter close")).toBeTruthy();
  });

  it("commits the cell draft on blur and discards it on Escape", async () => {
    const user = userEvent.setup();
    renderStudio();
    await screen.findByText("Food");
    await user.click(screen.getByTestId("db-cell-category-txn_001"));
    await user.clear(screen.getByTestId("db-cell-input"));
    await user.type(screen.getByTestId("db-cell-input"), "Groceries");
    await user.tab();
    await waitFor(() =>
      expect(bridgeMock.applyDatabaseEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          edit: expect.objectContaining({ payload: { category: "Groceries" } }),
        }),
      ),
    );
    await screen.findByText("Groceries");
    bridgeMock.applyDatabaseEdit.mockClear();
    await user.click(screen.getByTestId("db-cell-category-txn_002"));
    expect((screen.getByTestId("db-cell-input") as HTMLInputElement).value).toBe(
      "Transport",
    );
    await user.type(screen.getByTestId("db-cell-input"), " discarded");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("db-cell-input")).toBeNull();
    expect(bridgeMock.applyDatabaseEdit).not.toHaveBeenCalled();
    expect(screen.getByText("Transport")).toBeTruthy();
  });

  it("keeps the draft when a refresh temporarily removes the edited row", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DatabaseStudioView workspaceId="ws-1" path="imports/wallet.sqlite" />,
    );
    await screen.findByText("Food");
    await user.click(screen.getByTestId("db-cell-category-txn_001"));
    fireEvent.change(screen.getByTestId("db-cell-input"), {
      target: { value: "Uncommitted draft" },
    });
    await user.click(screen.getByTestId("db-cell-input"));
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

    await screen.findByText("Food");
    await user.click(screen.getByTestId("db-cell-category-txn_001"));
    fireEvent.change(screen.getByTestId("db-cell-input"), {
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
    expect(await screen.findByText("Fresh refresh")).toBeTruthy();

    await act(async () => {
      oldEdit.resolve({
        path: "imports/wallet.sqlite",
        table: "wallet",
        page: {
          offset: 0,
          rows: [
            { id: "txn_001", amount: 42, category: "Old edit" },
            { id: "txn_002", amount: 10, category: "Transport" },
            { id: "txn_003", amount: null, category: "" },
          ],
          nextOffset: null,
        },
        version: 1,
      });
    });

    expect(screen.getByText("Fresh refresh")).toBeTruthy();
    expect(screen.queryByText("Old edit")).toBeNull();
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

    expect(await screen.findByText("New workspace")).toBeTruthy();
    await act(async () => {
      oldRead.resolve(cloneSnapshot());
    });

    await waitFor(() => expect(screen.getByText("New workspace")).toBeTruthy());
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
    fireEvent.change(screen.getByTestId("db-cell-input"), {
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
