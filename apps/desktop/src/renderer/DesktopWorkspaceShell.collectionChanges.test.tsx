// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import type { FindDatasetCollectionResult } from "../ipc/bridgeContract";
import { deferred, type Deferred } from "../testing/deferred";
import { collectionWriteFailures, discardCollectionFieldWrite, enqueueCollectionFieldWrite, resetCollectionFieldWritesForTests, setCollectionFieldWriteAccess } from "./collections/recordFieldWrites";
import type { TransactionalCollectionPageProps } from "./TransactionalCollectionPage";
import { resetWriteQueuesForTests, writeQueueFor } from "./transactionalWriteQueue";
import { transactionalCollectionTabPath } from "./workbench/workbenchState";
import { DesktopWorkspaceShell, HOME_STATE, OTHER_WORKSPACE, STORED_STATE, WORKSPACE, makeBridge, shellBootstrapProps } from "./DesktopWorkspaceShell.testHarness";
import type { Workspace } from "./DesktopWorkspaceShell";

// The shell, the Collection's page around the table, and the table's queue
// are real. Only the table stands aside: buttons that change, keep, and
// delete records through the queue, as its cells and its record panel do.
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
      const operation = (kind: string) => dataset.operations.find(candidate => candidate.kind === kind)!.operationId;
      const change = (record: number) => queue.enqueue({ kind: "edit", record: { id: record, version: 1 }, operationId: operation("edit"),
        values: { [field.fieldId]: { value: "Rent", under: field } }, label: "Saved the edit" }, view);
      return <>
        <button data-testid="collection-records" onClick={() => change(queue.nextWrite)}>Change a record</button>
        <button onClick={() => change(1)}>Change record 1</button>
        <button onClick={() => queue.hold({ id: 99 }, field, "typed", "This edit was still open, so dohc did not save it.")}>Keep a value</button>
        <button onClick={() => queue.enqueue({ kind: "delete", record: { id: 7, version: 1 }, name: "Rent", operationId: operation("delete"), label: "Deleted the record" }, view)}>Delete Rent</button>
      </>;
    },
  };
});
afterEach(() => { resetWriteQueuesForTests(); resetCollectionFieldWritesForTests(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const budget: DatasetDescription = { datasetId: id(1), name: "Budget", revision: 4, revisionSha256: "a".repeat(64),
  tables: [{ tableId: id(2), name: "Expenses", fields: [{ fieldId: id(3), name: "Item", type: "text", required: true, unique: false }] }],
  operations: [
    { operationId: id(4), tableId: id(2), name: "list", label: "Read", kind: "read", access: "owner", readOnly: true, fieldIds: [id(3)] },
    { operationId: id(5), tableId: id(2), name: "edit", label: "Edit", kind: "edit", access: "owner", readOnly: false, fieldIds: [id(3)] },
    { operationId: id(6), tableId: id(2), name: "delete", label: "Delete", kind: "delete", access: "owner", readOnly: false, fieldIds: [] },
  ] };
const budgetTab = transactionalCollectionTabPath("budget/dataset.json", id(2));
const invoked = (result: AppBackendJson): DatasetResult => ({ kind: "invoked", result, revision: 5, replayed: false });
/** The table's queue, which outlives its page. */
const queue = () => writeQueueFor(JSON.stringify([WORKSPACE.workspaceId, budget.datasetId, id(2)]));
// What main answers a Collection change from a window whose session it has not admitted (main.ts, rendererWorkspaceOperation.ts).
const NOT_ADMITTED = "Error invoking remote method 'desktop:dataset': Error: Collection changes stopped because this window changed workspaces.";

/**
 * A window on the workspace with the Collection's tab open, and a bridge that
 * answers as main does: it takes a workspace's record changes only once
 * `openWorkspace` for that workspace has resolved, and refuses them from then
 * until the next one does. The changes it takes wait for the test to answer.
 */
function collectionWindow(strict = false) {
  // The workspace whose session main has admitted, and what the next `openWorkspace` does: wait, or fail.
  const main: { session: string | null; hold: Deferred | null; fail: Error | null } = { session: null, hold: null, fail: null };
  const base = makeBridge(Promise.resolve(null)), open = base.openWorkspace;
  const bridge = Object.assign(base, {
    findDatasetCollection: vi.fn(async (): Promise<FindDatasetCollectionResult> => ({ status: "unavailable" })),
    openWorkspace: vi.fn(async (payload: { workspaceId: string }) => {
      main.session = null;
      if (main.fail) throw main.fail;
      await main.hold?.promise;
      const status = await open();
      main.session = payload.workspaceId;
      return status;
    }),
  });
  // The Collection's tab is open the first time the workspace opens, and closed after.
  const layout = { open: true };
  bridge.getWorkspaceUiState = vi.fn(async () => layout.open ? { ...STORED_STATE, editorGroups: [{ id: "primary", tabs: [budgetTab], activeTab: budgetTab, size: 1 }] } : HOME_STATE);
  const changes: Array<{ request: DatasetRequest; answer: Deferred<DatasetResult> }> = [];
  bridge.dataset = vi.fn(async (request: DatasetRequest): Promise<DatasetResult> => {
    if (request.action === "list") return { kind: "list", datasets: request.workspaceId === WORKSPACE.workspaceId ? [{ ...budget, datasetPath: "budget/dataset.json" }] : [], nextCursor: null };
    if (request.action === "describe") return { kind: "description", dataset: { ...budget, datasetPath: "budget/dataset.json" } };
    if (request.action !== "invoke") throw new Error(`Unexpected dataset action: ${request.action}`);
    if (request.workspaceId !== main.session) throw new Error(NOT_ADMITTED);
    const answer = deferred<DatasetResult>();
    changes.push({ request, answer });
    return answer.promise;
  });
  vi.stubGlobal("dohcDesktop", bridge);
  const shell = (workspace: Workspace) => {
    const element = <DesktopWorkspaceShell key={workspace.workspaceId} workspace={workspace} workspaces={[WORKSPACE, OTHER_WORKSPACE]} {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />;
    return strict ? <StrictMode>{element}</StrictMode> : element;
  };
  const view = render(shell(WORKSPACE));
  /** The window switches to this workspace. Its shell opens, and main has yet to answer. */
  const mount = (workspace: Workspace) => {
    layout.open = false;
    view.rerender(shell(workspace));
  };
  /** The window shows this workspace, and main has admitted it. */
  const show = async (workspace: Workspace) => {
    mount(workspace);
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
  };
  /** Every record change the window asked main for, taken or refused. */
  const asked = () => bridge.dataset.mock.calls.filter(([request]) => request.action === "invoke");
  /** The window asked main to open this workspace, and main has not answered. */
  const opening = (workspace: Workspace) => waitFor(() => expect(bridge.openWorkspace).toHaveBeenLastCalledWith({ workspaceId: workspace.workspaceId }));
  return { changes, main, asked, mount, show, opening };
}
/** What the toasts on screen say. */
const toasts = () => [...screen.queryAllByTestId("workspace-shell-error"), ...screen.queryAllByTestId("workspace-shell-notice")].map(toast => toast.textContent ?? "");
const aboutExpenses = () => toasts().filter(words => words.includes("Expenses"));
/** Two changes: the first is with the host, and the second waits behind it. Then the window leaves, and the first is confirmed. */
async function leaveWithOneQueued({ changes, show }: Pick<ReturnType<typeof collectionWindow>, "changes" | "show">) {
  const change = await screen.findByTestId("collection-records");
  fireEvent.click(change);
  fireEvent.click(change);
  await waitFor(() => expect(changes).toHaveLength(1));
  await show(OTHER_WORKSPACE);
  await act(async () => changes[0]!.answer.resolve(invoked({ id: 1, version: 2 })));
}

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
  expect(aboutExpenses()).toEqual([]);

  await show(WORKSPACE);
  await waitFor(() => expect(changes).toHaveLength(2));
  expect(changes[1]!.request).toMatchObject({ action: "invoke", workspaceId: WORKSPACE.workspaceId, operationId: id(5), input: { id: 2, expectedVersion: 1, values: { [id(3)]: "Rent" } } });
  expect(screen.queryByTestId("collection-records")).toBeNull();
  // dohc can't confirm it. With the table closed, the open shell says so, with Try again.
  await act(async () => changes[1]!.answer.reject(new Error("Lost reply")));
  await waitFor(() => expect(toasts().some(words => words.includes("dohc could not confirm the change to Expenses. Open it to check its records."))).toBe(true));
  expect(screen.getByTestId("workspace-shell-error-retry")).toBeTruthy();
});

it("asks main for no queued change between the shell opening and main admitting the workspace, and sends it once main has", async () => {
  const window = collectionWindow(), { changes, main, asked } = window;
  await leaveWithOneQueued(window);
  expect(asked()).toHaveLength(1);
  // The window returns. Its shell is open, and main still holds the other workspace's session.
  main.hold = deferred();
  window.mount(WORKSPACE);
  await window.opening(WORKSPACE);
  expect(asked()).toHaveLength(1);
  expect(queue().attention()).toEqual([]);
  expect(aboutExpenses()).toEqual([]);
  // Main admits the workspace, and the change goes, with the table closed.
  await act(async () => main.hold!.resolve());
  await waitFor(() => expect(changes).toHaveLength(2));
  expect(changes[1]!.request).toMatchObject({ action: "invoke", workspaceId: WORKSPACE.workspaceId, input: { id: 2, expectedVersion: 1 } });
  expect(asked()).toHaveLength(2);
  expect(screen.queryByTestId("collection-records")).toBeNull();
  expect(aboutExpenses()).toEqual([]);
});

it("leaves a queued change unsent, and not failed, when main can't open the workspace, and sends it once Try again opens it", async () => {
  const window = collectionWindow(), { changes, main, asked } = window;
  await leaveWithOneQueued(window);
  main.fail = new Error("Error invoking remote method 'desktop:open-workspace': Error: dohc could not read this folder.");
  window.mount(WORKSPACE);
  const failed = await screen.findByTestId("workspace-open-failed");
  expect(asked()).toHaveLength(1);
  expect(queue().size).toBe(1);
  expect(queue().attention()).toEqual([]);
  expect(aboutExpenses()).toEqual([]);
  main.fail = null;
  fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(changes).toHaveLength(2));
  expect(asked()).toHaveLength(2);
  expect(aboutExpenses()).toEqual([]);
});

it("leaves a queued change unsent, and not failed, while another workspace's unsaved change holds the workspace closed", async () => {
  const window = collectionWindow(), { changes, asked } = window;
  await leaveWithOneQueued(window);
  // A cell edit in the other workspace did not save, so this workspace does not open until the person decides about it.
  setCollectionFieldWriteAccess(OTHER_WORKSPACE.workspaceId, "This share is view only.");
  enqueueCollectionFieldWrite(OTHER_WORKSPACE.workspaceId, "tasks", { recordId: "task-1", recordPath: "tasks/task-1.md", field: "title", value: "Later" });
  window.mount(WORKSPACE);
  expect((await screen.findByTestId("workspace-open-failed")).textContent).toContain("A collection change in another workspace has not saved. Retry or discard it to continue.");
  expect(asked()).toHaveLength(1);
  expect(queue().size).toBe(1);
  expect(queue().attention()).toEqual([]);
  expect(aboutExpenses()).toEqual([]);
  // The person discards it. The workspace opens, and the change goes.
  await act(async () => discardCollectionFieldWrite(collectionWriteFailures()[0]!.id));
  await waitFor(() => expect(changes).toHaveLength(2));
  expect(aboutExpenses()).toEqual([]);
});

it("sends each queued change once, and files one row, when the shell's effects run twice as in development", async () => {
  const window = collectionWindow(true), { changes, main, asked, show } = window;
  const change = await screen.findByTestId("collection-records");
  fireEvent.click(change);
  fireEvent.click(change);
  await waitFor(() => expect(changes).toHaveLength(1));
  // The window leaves the workspace, and main refuses the change in flight.
  await show(OTHER_WORKSPACE);
  await act(async () => changes[0]!.answer.reject(new Error(NOT_ADMITTED)));
  expect(aboutExpenses()).toEqual([]);
  main.hold = deferred();
  window.mount(WORKSPACE);
  await window.opening(WORKSPACE);
  expect(asked()).toHaveLength(1);
  expect(aboutExpenses()).toEqual([]);
  await act(async () => main.hold!.resolve());
  await waitFor(() => expect(changes).toHaveLength(2));
  expect(asked()).toHaveLength(2);
  expect(changes[1]!.request).toMatchObject({ input: { id: 2, expectedVersion: 1 } });
  expect(aboutExpenses()).toEqual(expect.arrayContaining([expect.stringContaining("dohc could not confirm a change to Expenses. Open it to check its records.")]));
  expect(aboutExpenses()).toHaveLength(1);
});

it("files one row in Notices for a Collection whose change dohc could not confirm, each time the window returns to its workspace", async () => {
  const { changes, show } = collectionWindow();
  fireEvent.click(await screen.findByTestId("collection-records"));
  await waitFor(() => expect(changes).toHaveLength(1));
  // The window leaves the workspace, and main refuses the change in flight.
  await show(OTHER_WORKSPACE);
  await act(async () => changes[0]!.answer.reject(new Error(NOT_ADMITTED)));
  expect(aboutExpenses()).toEqual([]);

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

it("keeps the Collection's row in Notices after its Try again, for the value dohc did not save", async () => {
  const { changes, show } = collectionWindow();
  fireEvent.click(await screen.findByTestId("collection-records"));
  fireEvent.click(screen.getByRole("button", { name: "Keep a value" }));
  await waitFor(() => expect(changes).toHaveLength(1));
  await show(OTHER_WORKSPACE);
  await act(async () => changes[0]!.answer.reject(new Error(NOT_ADMITTED)));
  await show(WORKSPACE);
  await waitFor(() => expect(aboutExpenses().some(words => words.includes("dohc could not confirm a change to Expenses, and did not save 1 more. Open it to check its records."))).toBe(true));
  fireEvent.click(screen.getByTestId("notice-center-toggle"));
  const notices = () => screen.getByTestId("notice-center");
  fireEvent.click(within(notices()).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(changes).toHaveLength(2));
  // The change goes again. The row and its toast stay for the value, and offer no Try again, which could do nothing for it.
  const unsaved = "dohc did not save a change to Expenses. Open it to check its records.";
  await waitFor(() => expect(aboutExpenses()).toEqual([expect.stringContaining(unsaved)]));
  // Notices closed as its Try again ran. Opened again, it still holds the row.
  fireEvent.click(screen.getByTestId("notice-center-toggle"));
  await waitFor(() => expect(notices().textContent).toContain(unsaved));
  expect(notices().textContent).not.toContain("dohc could not confirm");
  expect(within(notices()).queryByRole("button", { name: "Try again" })).toBeNull();
  // The change saves, and the row is still there.
  await act(async () => changes[1]!.answer.resolve(invoked({ id: 1, version: 2 })));
  await waitFor(() => expect(notices().textContent).toContain("Saved the edit in Expenses"));
  expect(notices().textContent).toContain(unsaved);
  // The person lets the value go, and the row goes.
  act(() => queue().dismiss("99", id(3)));
  await waitFor(() => expect(notices().textContent).not.toContain(unsaved));
});

it("says on return that a record's changes wait, when its table's read can't find the record by a key", async () => {
  const { changes, show } = collectionWindow();
  const change = screen.findByRole("button", { name: "Change record 1" });
  fireEvent.click(await change);
  fireEvent.click(await change);
  await waitFor(() => expect(changes).toHaveLength(1));
  await show(OTHER_WORKSPACE);
  // The first change's receipt reports no version, so the next one needs a read of the record.
  await act(async () => changes[0]!.answer.resolve(invoked(null)));
  await show(WORKSPACE);
  await waitFor(() => expect(aboutExpenses()).toEqual([expect.stringContaining("dohc could not look up record 1 in Expenses, so its changes are waiting. Open Expenses and find the record.")]));
  expect(changes).toHaveLength(1);
  expect(screen.queryByTestId("workspace-shell-error-retry")).toBeNull();
});

it("names on return a deletion the Collection refused while the window showed another workspace", async () => {
  const { changes, show } = collectionWindow();
  fireEvent.click(await screen.findByRole("button", { name: "Delete Rent" }));
  await waitFor(() => expect(changes).toHaveLength(1));
  await show(OTHER_WORKSPACE);
  await act(async () => changes[0]!.answer.resolve({ kind: "refused", code: "not_allowed", message: "Paid records stay." }));
  expect(aboutExpenses()).toEqual([]);
  await show(WORKSPACE);
  await waitFor(() => expect(aboutExpenses()).toEqual([expect.stringContaining("dohc did not delete Rent from Expenses. Open it to check its records.")]));
  expect(queue().attention()).toEqual([expect.objectContaining({ kind: "deletion", name: "Rent", reason: "The Collection refused this change. Paid records stay." })]);
});
