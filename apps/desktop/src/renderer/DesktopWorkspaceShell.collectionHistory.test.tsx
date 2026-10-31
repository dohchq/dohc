// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import type { FindDatasetCollectionResult, TimelineEntry, WorkspaceUiState } from "../ipc/bridgeContract";
import { deferred } from "../testing/deferred";
import { timelinePage } from "../testing/historyPageFixture";
import type { ConnectedTransactionalCollectionProps } from "./ConnectedTransactionalCollection";
import { transactionalCollectionTabPath } from "./workbench/workbenchState";
import { HOME_STATE, STORED_STATE, WORKSPACE, makeBridge, renderShell } from "./DesktopWorkspaceShell.testHarness";

// The Collection page and its History are real; only the records table,
// which reads records, stands aside. While `page.loading` is set, the page
// suspends as its first load does.
const page = vi.hoisted(() => ({ loading: null as Promise<void> | null }));
vi.mock("./TransactionalCollectionPage", () => ({
  TransactionalCollectionPage: () => <div data-testid="collection-records" />,
}));
vi.mock("./ConnectedTransactionalCollection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ConnectedTransactionalCollection")>();
  return {
    ConnectedTransactionalCollection: (props: ConnectedTransactionalCollectionProps) => {
      if (page.loading) throw page.loading;
      return <actual.ConnectedTransactionalCollection {...props} />;
    },
  };
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const budget: DatasetDescription = { datasetId: id(1), name: "Budget", revision: 4, revisionSha256: "a".repeat(64),
  tables: [{ tableId: id(2), name: "Expenses", fields: [{ fieldId: id(3), name: "Item", type: "text", required: true, unique: false }] }],
  operations: [{ operationId: id(4), tableId: id(2), name: "addRow", label: "Add row", kind: "create", access: "owner", readOnly: false, fieldIds: [id(3)] }] };
const change: TimelineEntry = { kind: "collection", datasetId: budget.datasetId, name: "Budget", sortAtMs: 200, change: {
  revision: 4, operation: "addRow", callerReference: null, recordedAtMs: 200, approvedRevisionHash: "a".repeat(64), changesetBytes: 10, attachmentCount: 0,
} };
const budgetTab = transactionalCollectionTabPath("budget/dataset.json", id(2));

function collectionShell(state: WorkspaceUiState | null = null) {
  const bridge = Object.assign(makeBridge(Promise.resolve(state)), {
    findDatasetCollection: vi.fn(async (): Promise<FindDatasetCollectionResult> => ({ status: "unavailable" })),
  });
  bridge.listHistory = vi.fn(async () => timelinePage([change], { workspaceId: WORKSPACE.workspaceId }));
  bridge.dataset = vi.fn(async (request: DatasetRequest): Promise<DatasetResult> => {
    if (request.action === "list") return { kind: "list", datasets: [{ ...budget, datasetPath: "budget/dataset.json" }], nextCursor: null };
    if (request.action === "describe") return { kind: "description", dataset: { ...budget, datasetPath: "budget/dataset.json" } };
    if (request.action === "history") return { kind: "history", datasetId: budget.datasetId, headRevision: 4, nextBeforeRevision: null, entries: [
      { revision: 4, operation: "addRow", callerReference: null, recordedAtMs: 200, approvedRevisionHash: "a".repeat(64), changesetBytes: 10, attachmentCount: 0 },
    ] };
    throw new Error(`Unexpected dataset action: ${request.action}`);
  });
  renderShell(bridge);
  return bridge;
}

async function collectionRow(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByTestId("titlebar-about-sidebar");
  await user.click(screen.getByTestId("activity-history"));
  return screen.findByTestId("history-collection-open");
}

// The timeline is about changes: a file's row opens its diff, and a
// Collection's row opens that Collection's History, where the change and its
// Undo are.
describe("a Collection change in the History timeline", () => {
  it("opens its Collection's History by click, again once the Collection is open", async () => {
    const user = userEvent.setup();
    collectionShell();
    const row = await collectionRow(user);
    await user.click(row);
    expect(await within(screen.getByTestId("editor-group-primary")).findByTestId("collection-records")).toBeTruthy();
    const history = await screen.findByRole("dialog", { name: "Collection history" });
    expect(await within(history).findByText("addRow")).toBeTruthy();

    await user.click(within(history).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Collection history" })).toBeNull();
    await user.click(screen.getByTestId("history-collection-open"));
    expect(await screen.findByRole("dialog", { name: "Collection history" })).toBeTruthy();
  });

  it("opens its Collection's History by keyboard", async () => {
    const user = userEvent.setup();
    collectionShell();
    (await collectionRow(user)).focus();
    await user.keyboard("{Enter}");
    expect(await within(screen.getByTestId("editor-group-primary")).findByTestId("collection-records")).toBeTruthy();
    const history = await screen.findByRole("dialog", { name: "Collection history" });
    expect(await within(history).findByText("addRow")).toBeTruthy();
  });

  // The row opens the tab in the focused group, so only that group's page
  // opens History.
  it("opens one History when its Collection shows in two editor groups", async () => {
    const user = userEvent.setup();
    collectionShell({ ...STORED_STATE, activeEditorGroup: "right", editorGroups: [
      { id: "primary", tabs: [budgetTab], activeTab: budgetTab, size: 0.5 },
      { id: "right", tabs: [budgetTab], activeTab: budgetTab, size: 0.5 },
    ] });
    for (const group of ["primary", "right"]) {
      expect(await within(screen.getByTestId(`editor-group-${group}`)).findByTestId("collection-records")).toBeTruthy();
    }
    await user.click(await collectionRow(user));
    const [history, ...more] = await screen.findAllByRole("dialog", { name: "Collection history" });
    expect(more).toEqual([]);
    expect(screen.getByTestId("editor-group-right").contains(history!)).toBe(true);
    await user.click(within(history!).getByRole("button", { name: "Close" }));
    expect(screen.queryAllByRole("dialog", { name: "Collection history" })).toEqual([]);
  });

  // A tab closed before its page loaded takes its ask with it.
  it("opens the Collection without History after the row's tab closed while it loaded", async () => {
    const loading = deferred();
    page.loading = loading.promise;
    try {
      const user = userEvent.setup();
      collectionShell(HOME_STATE);
      await user.click(await collectionRow(user));
      await user.click(await screen.findByRole("button", { name: "Close Expenses" }));
      page.loading = null;
      loading.resolve();

      await user.click(screen.getByTestId("activity-explorer"));
      await user.click(within(screen.getByRole("region", { name: "Collections" })).getByRole("button", { name: "Expenses" }));
      expect(await within(screen.getByTestId("editor-group-primary")).findByTestId("collection-records")).toBeTruthy();
      expect(screen.queryByRole("dialog", { name: "Collection history" })).toBeNull();
    } finally {
      page.loading = null;
      loading.resolve();
    }
  });
});

describe("the Collections section", () => {
  it("shows its controls once the list has loaded, and keeps them while the archived list loads", async () => {
    const user = userEvent.setup();
    const listed = deferred<DatasetResult>();
    const bridge = makeBridge(Promise.resolve(HOME_STATE));
    bridge.dataset = vi.fn(async (request: DatasetRequest): Promise<DatasetResult> => {
      if (request.action !== "list") throw new Error(`Unexpected dataset action: ${request.action}`);
      return request.includeArchived ? await new Promise<DatasetResult>(() => {}) : await listed.promise;
    });
    renderShell(bridge);
    await waitFor(() => expect(bridge.dataset).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Collections actions" })).toBeNull();

    await act(async () => listed.resolve({ kind: "list", datasets: [], nextCursor: null }));
    await user.click(await screen.findByRole("button", { name: "Collections actions" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Show archived Collections" }));
    await user.click(screen.getByRole("button", { name: "Collections actions" }));
    expect(screen.getByRole("menuitem", { name: "Restore from recovery file…" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Show archived Collections" }).getAttribute("aria-checked")).toBe("true");
  });
});
