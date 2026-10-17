// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import type { FindDatasetCollectionResult, TimelineEntry } from "../ipc/bridgeContract";
import { timelinePage } from "../testing/historyPageFixture";
import { WORKSPACE, makeBridge, renderShell } from "./DesktopWorkspaceShell.testHarness";

// The Collection page and its History are real; only the records table,
// which reads records, stands aside.
vi.mock("./TransactionalCollectionPage", () => ({
  TransactionalCollectionPage: () => <div data-testid="collection-records" />,
}));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const budget: DatasetDescription = { datasetId: id(1), name: "Budget", revision: 4, revisionSha256: "a".repeat(64),
  tables: [{ tableId: id(2), name: "Expenses", fields: [{ fieldId: id(3), name: "Item", type: "text", required: true, unique: false }] }],
  operations: [{ operationId: id(4), tableId: id(2), name: "addRow", label: "Add row", kind: "create", access: "owner", readOnly: false, fieldIds: [id(3)] }] };
const change: TimelineEntry = { kind: "collection", datasetId: budget.datasetId, name: "Budget", sortAtMs: 200, change: {
  revision: 4, operation: "addRow", callerReference: null, recordedAtMs: 200, approvedRevisionHash: "a".repeat(64), changesetBytes: 10, attachmentCount: 0,
} };

function collectionShell() {
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
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
});
