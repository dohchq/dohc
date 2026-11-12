// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import type { FindDatasetCollectionResult, WorkspaceUiState } from "../ipc/bridgeContract";
import type { TransactionalCollectionPageProps } from "./TransactionalCollectionPage";
import { transactionalCollectionTabPath } from "./workbench/workbenchState";
import { STORED_STATE, makeBridge, renderShell } from "./DesktopWorkspaceShell.testHarness";

// The shell and the Collection's page around the table are real. The table
// stands aside: it shows what the shell kept for its record panel, and tells
// the shell what a person does with the panel.
vi.mock("./TransactionalCollectionPage", () => ({
  TransactionalCollectionPage: (props: TransactionalCollectionPageProps) => <>
    <output aria-label="Open record">{props.initialOpenRecord ?? "none"}</output>
    <output aria-label="Panel width">{props.initialRecordPanelWidth}</output>
    <button onClick={() => props.onOpenRecordChange?.("9")}>Open record 9</button>
    <button onClick={() => props.onOpenRecordChange?.(null)}>Close the record</button>
    <button onClick={() => props.onRecordPanelWidthChange?.(640)}>Widen the panel</button>
  </>,
}));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const budget: DatasetDescription = { datasetId: id(1), name: "Budget", revision: 4, revisionSha256: "a".repeat(64),
  tables: [{ tableId: id(2), name: "Expenses", fields: [{ fieldId: id(3), name: "Item", type: "text", required: true, unique: false }] }],
  operations: [{ operationId: id(4), tableId: id(2), name: "list", label: "Read", kind: "read", access: "owner", readOnly: true, fieldIds: [id(3)] }] };
const budgetTab = transactionalCollectionTabPath("budget/dataset.json", id(2));

function collectionShell(state: WorkspaceUiState) {
  const bridge = Object.assign(makeBridge(Promise.resolve(state)), {
    findDatasetCollection: vi.fn(async (): Promise<FindDatasetCollectionResult> => ({ status: "unavailable" })),
  });
  bridge.dataset = vi.fn(async (request: DatasetRequest): Promise<DatasetResult> => {
    if (request.action === "list") return { kind: "list", datasets: [{ ...budget, datasetPath: "budget/dataset.json" }], nextCursor: null };
    if (request.action === "describe") return { kind: "description", dataset: { ...budget, datasetPath: "budget/dataset.json" } };
    throw new Error(`Unexpected dataset action: ${request.action}`);
  });
  renderShell(bridge);
  /** The layout the shell last asked main to save. */
  const saved = () => bridge.setWorkspaceUiState.mock.calls.at(-1)?.[0].state;
  return { saved };
}
const withTab: WorkspaceUiState = { ...STORED_STATE, editorGroups: [{ id: "primary", tabs: [budgetTab, "b.md"], activeTab: budgetTab, size: 1 }] };

it("opens a Collection's tab with the record and the panel width its saved layout kept, as after a restart", async () => {
  collectionShell({ ...withTab, openRecords: { [budgetTab]: "7" }, recordPanelWidth: 512 });
  expect((await screen.findByRole("status", { name: "Open record" })).textContent).toBe("7");
  expect(screen.getByRole("status", { name: "Panel width" }).textContent).toBe("512");
});

it("opens a tab with no panel, at the default width, from a layout saved before the panel", async () => {
  collectionShell(withTab);
  expect((await screen.findByRole("status", { name: "Open record" })).textContent).toBe("none");
  expect(screen.getByRole("status", { name: "Panel width" }).textContent).toBe("380");
});

it("saves the record a tab shows open, the panel's width, and that the panel closed, with the workspace's layout", async () => {
  const { saved } = collectionShell(withTab);
  fireEvent.click(await screen.findByRole("button", { name: "Open record 9" }));
  await waitFor(() => expect(saved()?.openRecords).toEqual({ [budgetTab]: "9" }));
  fireEvent.click(screen.getByRole("button", { name: "Widen the panel" }));
  await waitFor(() => expect(saved()?.recordPanelWidth).toBe(640));
  expect(saved()?.openRecords).toEqual({ [budgetTab]: "9" });
  fireEvent.click(screen.getByRole("button", { name: "Close the record" }));
  await waitFor(() => expect(saved()?.openRecords).toEqual({}));
});
