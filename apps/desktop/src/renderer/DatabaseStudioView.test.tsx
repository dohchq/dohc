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
import type { DatabaseSnapshotResult } from "../ipc/bridgeContract";
import { rendererMarks } from "../performance/rendererMarks";
import { DatabaseStudioView } from "./DatabaseStudioView";

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
    },
    {
      name: "notes",
      columns: [
        { name: "key", type: "TEXT", primaryKey: true },
        { name: "value", type: "TEXT" },
      ],
      rows: [{ key: "memo", value: "Quarter close" }],
    },
  ],
};

function cloneSnapshot(snapshot = baseSnapshot): DatabaseSnapshotResult {
  return JSON.parse(JSON.stringify(snapshot)) as DatabaseSnapshotResult;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const bridgeMock = {
  readWorkspaceDatabase: vi.fn(async () => cloneSnapshot()),
  applyDatabaseEdit: vi.fn(async () =>
    cloneSnapshot({
      ...baseSnapshot,
      tables: [
        {
          ...baseSnapshot.tables[0]!,
          rows: [
            { id: "txn_001", amount: 42, category: "Groceries" },
            { id: "txn_002", amount: 10, category: "Transport" },
            { id: "txn_003", amount: null, category: "" },
          ],
        },
        baseSnapshot.tables[1]!,
      ],
    }),
  ),
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

  it("commits edits through the declared primary key and rerenders the snapshot", async () => {
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
