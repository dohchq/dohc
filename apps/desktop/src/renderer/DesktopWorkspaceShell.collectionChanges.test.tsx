// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import type { FindDatasetCollectionResult, WorkspaceUiState } from "../ipc/bridgeContract";
import { deferred, type Deferred } from "../testing/deferred";
import type { TransactionalCollectionPageProps } from "./TransactionalCollectionPage";
import { resetWriteQueuesForTests } from "./transactionalWriteQueue";
import { transactionalCollectionTabPath } from "./workbench/workbenchState";
import { DesktopWorkspaceShell, HOME_STATE, OTHER_WORKSPACE, STORED_STATE, WORKSPACE, makeBridge, shellBootstrapProps } from "./DesktopWorkspaceShell.testHarness";
import type { Workspace } from "./DesktopWorkspaceShell";

// The shell, the Collection's page around the table, and the table's queue
// are real. Only the table stands aside: one button that changes a record
// through the queue, as a cell does.
vi.mock("./TransactionalCollectionPage", async () => {
  const { useLayoutEffect, useState } = await import("react");
  const { writeQueueFor } = await import("./transactionalWriteQueue");
  return {
    TransactionalCollectionPage: (props: TransactionalCollectionPageProps) => {
      const { workspaceId, dataset, tableId } = props;
      const [queue] = useState(() => writeQueueFor(JSON.stringify([workspaceId, dataset.datasetId, tableId])));
      const [view] = useState(() => queue.page());
      const table = dataset.tables[0]!, field = table.fields[0]!;
      useLayoutEffect(() => view.sync({ workspaceId, datasetId: dataset.datasetId, revision: dataset.revision, revisionSha256: dataset.revisionSha256, tableName: table.name, fields: table.fields,
        operations: dataset.operations, offline: false, invoke: props.invoke, onError: props.onError, onSettled: props.onSettled,
        confirmed() {}, dropped: () => false, unconfirmed() {}, read() {}, describe() {} }));
      useLayoutEffect(() => view.open(), [view]);
      const edit = dataset.operations.find(operation => operation.kind === "edit")!;
      return <button data-testid="collection-records" onClick={() => queue.enqueue({ kind: "edit", record: { id: queue.nextWrite, version: 1 }, operationId: edit.operationId,
        values: { [field.fieldId]: { value: "Rent", under: field } }, label: "Saved the edit" }, view)}>Change a record</button>;
    },
  };
});
afterEach(resetWriteQueuesForTests);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const budget: DatasetDescription = { datasetId: id(1), name: "Budget", revision: 4, revisionSha256: "a".repeat(64),
  tables: [{ tableId: id(2), name: "Expenses", fields: [{ fieldId: id(3), name: "Item", type: "text", required: true, unique: false }] }],
  operations: [
    { operationId: id(4), tableId: id(2), name: "list", label: "Read", kind: "read", access: "owner", readOnly: true, fieldIds: [id(3)] },
    { operationId: id(5), tableId: id(2), name: "edit", label: "Edit", kind: "edit", access: "owner", readOnly: false, fieldIds: [id(3)] },
  ] };
const budgetTab = transactionalCollectionTabPath("budget/dataset.json", id(2));
const withBudgetOpen: WorkspaceUiState = { ...STORED_STATE, editorGroups: [{ id: "primary", tabs: [budgetTab], activeTab: budgetTab, size: 1 }] };
const invoked = (result: AppBackendJson): DatasetResult => ({ kind: "invoked", result, revision: 5, replayed: false });

/** A window on the workspace with the Collection's tab open, and its bridge, whose record changes wait for the test to answer them. */
function collectionWindow() {
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
    findDatasetCollection: vi.fn(async (): Promise<FindDatasetCollectionResult> => ({ status: "unavailable" })),
  });
  // The Collection's tab is open the first time the workspace opens, and closed after.
  const layout = { next: withBudgetOpen };
  bridge.getWorkspaceUiState = vi.fn(async () => { const state = layout.next; layout.next = HOME_STATE; return state; });
  const changes: Array<{ request: DatasetRequest; answer: Deferred<DatasetResult> }> = [];
  bridge.dataset = vi.fn(async (request: DatasetRequest): Promise<DatasetResult> => {
    if (request.action === "list") return { kind: "list", datasets: request.workspaceId === WORKSPACE.workspaceId ? [{ ...budget, datasetPath: "budget/dataset.json" }] : [], nextCursor: null };
    if (request.action === "describe") return { kind: "description", dataset: { ...budget, datasetPath: "budget/dataset.json" } };
    if (request.action !== "invoke") throw new Error(`Unexpected dataset action: ${request.action}`);
    const answer = deferred<DatasetResult>();
    changes.push({ request, answer });
    return answer.promise;
  });
  vi.stubGlobal("dohcDesktop", bridge);
  const shell = (workspace: Workspace) => <DesktopWorkspaceShell key={workspace.workspaceId} workspace={workspace} workspaces={[WORKSPACE, OTHER_WORKSPACE]} {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />;
  const view = render(shell(WORKSPACE));
  /** The window shows this workspace, as after a switch. */
  const show = async (workspace: Workspace) => {
    view.rerender(shell(workspace));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
  };
  return { changes, show };
}
/** What the toasts on screen say. */
const toasts = () => [...screen.queryAllByTestId("workspace-shell-error"), ...screen.queryAllByTestId("workspace-shell-notice")].map(toast => toast.textContent ?? "");

it("sends none of a Collection's queued changes while the window shows another workspace, and sends them on return with its table closed", async () => {
  const { changes, show } = collectionWindow();
  const change = await screen.findByTestId("collection-records");
  // Two changes: the first is with the host, and the second waits behind it.
  fireEvent.click(change);
  fireEvent.click(change);
  await waitFor(() => expect(changes).toHaveLength(1));

  await show(OTHER_WORKSPACE);
  await act(async () => changes[0]!.answer.resolve(invoked({ id: 1, version: 2 })));
  // The second change is not sent, and not failed: the other workspace hears nothing of either.
  expect(changes).toHaveLength(1);
  expect(toasts().filter(words => words.includes("Expenses"))).toEqual([]);

  await show(WORKSPACE);
  await waitFor(() => expect(changes).toHaveLength(2));
  expect(changes[1]!.request).toMatchObject({ action: "invoke", workspaceId: WORKSPACE.workspaceId, operationId: id(5), input: { id: 2, expectedVersion: 1, values: { [id(3)]: "Rent" } } });
  expect(screen.queryByTestId("collection-records")).toBeNull();
  // dohc can't confirm it. With the table closed, the open shell says so, with Try again.
  await act(async () => changes[1]!.answer.reject(new Error("Lost reply")));
  await waitFor(() => expect(toasts().some(words => words.includes("dohc could not confirm the change to Expenses. Open it to check its records."))).toBe(true));
  expect(screen.getByTestId("workspace-shell-error-retry")).toBeTruthy();
});

it("files one row in Notices for a Collection whose change dohc could not confirm, each time the window returns to its workspace", async () => {
  const { changes, show } = collectionWindow();
  fireEvent.click(await screen.findByTestId("collection-records"));
  await waitFor(() => expect(changes).toHaveLength(1));
  // The window leaves the workspace, and main refuses the change in flight.
  await show(OTHER_WORKSPACE);
  await act(async () => changes[0]!.answer.reject(new Error("Collection changes stopped because this window changed workspaces.")));
  expect(toasts().filter(words => words.includes("Expenses"))).toEqual([]);

  const row = "dohc could not confirm a change to Expenses. Open it to check its records.";
  await show(WORKSPACE);
  await waitFor(() => expect(toasts().filter(words => words.includes(row))).toHaveLength(1));
  // Leaving and returning again files the same one row, not a second.
  await show(OTHER_WORKSPACE);
  await show(WORKSPACE);
  await waitFor(() => expect(toasts().filter(words => words.includes(row))).toHaveLength(1));
  fireEvent.click(screen.getByTestId("notice-center-toggle"));
  expect(screen.getByTestId("notice-center").textContent!.split(row)).toHaveLength(2);
  // Its Try again sends the exact request, with the table still closed.
  fireEvent.click(within(screen.getByTestId("notice-center")).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(changes).toHaveLength(2));
  expect(changes[1]!.request).toEqual(changes[0]!.request);
  expect(screen.queryByTestId("collection-records")).toBeNull();
});
