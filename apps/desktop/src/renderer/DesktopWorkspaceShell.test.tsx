// @vitest-environment jsdom
import { editorTabTestId } from "../testPins";
import { ObserverStub } from "./DesktopWorkspaceShell.testSupport";
import "./CollectionPage";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EngineYDocSaveStateEvent, SitePackageInfo } from "../ipc/bridgeContract";
import { type Workspace } from "./DesktopWorkspaceShell";
import { WORKSPACE_ACTIVITY_REFRESH_DELAY_MS } from "./workspaceActivityCoalescer";
import { hasPendingEditorDrafts, settlePendingEditorDrafts } from "./pendingEditorDrafts";
import { loadStoredDrafts } from "./orphanedDraftStorage";
import { deferred } from "../testing/deferred";
import { CollectionFieldWriteHost, collectionWriteFailures, resetCollectionFieldWritesForTests, retainedCollectionFieldWritePaths } from "./collections/recordFieldWrites";
import { DesktopWorkspaceShell, HOME_STATE, WORKSPACE, STORED_STATE, storedStateWithTabs, recordDocUpdate, makeBridge, renderShell, shellBootstrapProps, SHARE_VIEW, OTHER_WORKSPACE } from "./DesktopWorkspaceShell.testHarness";

import { useWorkspaceListing } from "./shell/useWorkspaceListing";
vi.mock("./shell/useWorkspaceListing", { spy: true });

// A new page titled Lisbon with "Day one" typed in its body, as its file
// would hold it.
const LISBON = "---\ntitle: Lisbon\n---\n\nDay one\n";
// What recovery holds for the workspace, as a restart brings it back.
function recovered() {
  return loadStoredDrafts(Date.now(), { bindHandles: false })
    .filter((draft) => draft.workspaceId === WORKSPACE.workspaceId)
    .map(({ path, text }) => ({ path, text }));
}

describe("global letter shortcut ownership", () => {
  function dispatchShortcut(
    key: string,
    init: KeyboardEventInit = {},
    target: Window | Element = window,
  ) {
    const event = new KeyboardEvent("keydown", {
      key,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    fireEvent(target, event);
    return event;
  }

  it("leaves editor Ctrl+B with the editor", async () => {
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));
    await screen.findByTestId("side-panel");
    const editor = document.createElement("textarea");
    screen.getByTestId("workspace-shell").append(editor);
    editor.addEventListener("keydown", (event) => event.preventDefault(), {
      once: true,
    });

    dispatchShortcut("b", {}, editor);

    expect(screen.getByTestId("side-panel")).toBeTruthy();
    dispatchShortcut("b", {}, editor);
    await waitFor(() => expect(screen.queryByTestId("side-panel")).toBeNull());
    editor.remove();
  });
});

describe("collection folders", () => {
  // The table virtualizer reads offsetWidth/offsetHeight, which jsdom reports
  // as 0 — no row would render (CollectionPage.test.tsx precedent).
  const offsetDescriptors = {
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
    offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
  };

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ObserverStub);
    vi.stubGlobal("IntersectionObserver", ObserverStub);
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      value: 900,
    });
  });

  afterEach(() => {
    for (const [name, descriptor] of Object.entries(offsetDescriptors)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    }
  });

  it("names a new record's file from its name, made safe and unique, and opens no tab for it", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const files: Array<{ path: string; kind: "file" }> = [];
    bridge.listWorkspaceFiles = vi.fn(async () => ({ visibility: { status: "ready" as const, rules: [] }, files: [...files], folders: ["tasks"] }));
    bridge.listCollections = vi.fn(async () => ({ collections: [{ path: "tasks", objectId: "object-test", status: "valid" as const, reasons: [] }], unclaimedDatasetFolders: [] }));
    bridge.getCollection.mockResolvedValue({
      path: "tasks", objectId: "object-test", status: "valid", reasons: [], recordCount: 0,
      schema: { name: "Tasks", description: null, fields: [{ name: "title", type: "text" }, { name: "notes", type: "text" }], views: [] },
    });
    bridge.createCollectionRecord.mockImplementation(async (payload) => {
      files.push({ path: `${payload.collectionPath}/${payload.name}.md`, kind: "file" });
      return { path: `${payload.collectionPath}/${payload.name}.md`, recordId: "rec_abcdefghijklmnopqrstuvwxyz" };
    });
    renderShell(bridge);
    const row = await waitFor(() => {
      const row = screen.getAllByTestId("tree-row").find(entry => entry.dataset.path === "tasks");
      expect(row?.dataset.collection).toBe("true");
      return row!;
    });
    fireEvent.click(row);
    const editor = () => document.querySelector<HTMLInputElement>("[data-cell-editor] input");
    /** Saves the new row with Enter, with `title` typed in its first field, or `notes` in its second. */
    const saveRow = async (title: string | null, notes?: string) => {
      fireEvent.click(await screen.findByTestId("collection-new-record", undefined, { timeout: 15_000 }));
      await waitFor(() => expect(editor()).not.toBeNull());
      if (title !== null) fireEvent.change(editor()!, { target: { value: title } });
      if (notes === undefined) return fireEvent.keyDown(editor()!, { key: "Enter" });
      fireEvent.keyDown(editor()!, { key: "Tab" });
      fireEvent.keyDown(screen.getByRole("grid"), { key: "F2" });
      fireEvent.change(editor()!, { target: { value: notes } });
      fireEvent.keyDown(editor()!, { key: "Enter" });
    };

    // Characters a file name cannot hold become spaces, as in a new page's name.
    await saveRow("Plan: Q4/Launch");
    await waitFor(() => expect(bridge.createCollectionRecord).toHaveBeenCalledTimes(1));
    expect(bridge.createCollectionRecord.mock.calls[0]![0]).toMatchObject({ collectionPath: "tasks", name: "Plan Q4 Launch" });
    // The listing has the first file by now, so the same name takes the next number.
    await waitFor(() => expect(bridge.listWorkspaceFiles.mock.results.length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getAllByTestId("tree-row").some(entry => entry.dataset.path === "tasks/Plan Q4 Launch.md") || files.length === 1).toBe(true));
    await saveRow("Plan: Q4/Launch");
    await waitFor(() => expect(bridge.createCollectionRecord).toHaveBeenCalledTimes(2));
    expect(bridge.createCollectionRecord.mock.calls[1]![0].name).toBe("Plan Q4 Launch 2");
    // A record with no name is Untitled.
    await saveRow(null, "Remember the milk");
    await waitFor(() => expect(bridge.createCollectionRecord).toHaveBeenCalledTimes(3));
    expect(bridge.createCollectionRecord.mock.calls[2]![0].name).toBe("Untitled");
    for (const name of ["Plan Q4 Launch", "Plan Q4 Launch 2", "Untitled"]) expect(screen.queryByTestId(editorTabTestId(`tasks/${name}.md`))).toBeNull();
  });

  /** Opens the tasks Collection, whose records have a title, and answers what types a title in its new row and saves the row. */
  async function openTasksWithTitle(bridge: ReturnType<typeof makeBridge>, render: () => unknown) {
    bridge.listWorkspaceFiles = vi.fn(async () => ({ visibility: { status: "ready" as const, rules: [] }, files: [], folders: ["tasks"] }));
    bridge.listCollections = vi.fn(async () => ({ collections: [{ path: "tasks", objectId: "object-test", status: "valid" as const, reasons: [] }], unclaimedDatasetFolders: [] }));
    bridge.getCollection.mockResolvedValue({
      path: "tasks", objectId: "object-test", status: "valid", reasons: [], recordCount: 0,
      schema: { name: "Tasks", description: null, fields: [{ name: "title", type: "text" }], views: [] },
    });
    render();
    const row = await waitFor(() => {
      const row = screen.getAllByTestId("tree-row").find(entry => entry.dataset.path === "tasks");
      expect(row?.dataset.collection).toBe("true");
      return row!;
    });
    fireEvent.click(row);
    const editor = () => document.querySelector<HTMLInputElement>("[data-cell-editor] input");
    return async (title: string, leave: "Enter" | null) => {
      fireEvent.click(await screen.findByTestId("collection-new-record", undefined, { timeout: 15_000 }));
      await waitFor(() => expect(editor()).not.toBeNull());
      fireEvent.change(editor()!, { target: { value: title } });
      // With no key, the title stays in its open editor: the row is still being typed.
      if (leave) fireEvent.keyDown(editor()!, { key: leave });
    };
  }
  const otherWorkspaceShell = (bridge: ReturnType<typeof makeBridge>) => (
    <>
      <CollectionFieldWriteHost />
      <DesktopWorkspaceShell key={OTHER_WORKSPACE.workspaceId} workspace={OTHER_WORKSPACE} workspaces={[WORKSPACE, OTHER_WORKSPACE]}
        {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />
    </>
  );

  it("keeps the name of a record that exists in part, and of one just made, from the next rows until the listing shows its file", async () => {
    resetCollectionFieldWritesForTests();
    const bridge = makeBridge(Promise.resolve(null));
    // The first record's file is made and the record is not finished. The others are made. The listing shows none of their files yet.
    bridge.createCollectionRecord
      .mockResolvedValueOnce({ kind: "partial", created: ["tasks/Milk.md"], failedStage: "index", reason: "index unavailable",
        retry: { mode: "resume", recordId: "rec_abcdefghijklmnopqrstuvwxyz", instruction: "Try again to finish this record." } })
      .mockImplementation(async (payload) => ({ path: `${payload.collectionPath}/${payload.name}.md`, recordId: "rec_bcdefghijklmnopqrstuvwxyza" }));
    const typeRow = await openTasksWithTitle(bridge, () => renderShell(bridge));
    await typeRow("Milk", "Enter");
    await waitFor(() => expect(bridge.createCollectionRecord).toHaveBeenCalledTimes(1));
    await screen.findByText(/dohc created the record file but could not finish the record/);
    await typeRow("Milk", "Enter");
    await waitFor(() => expect(bridge.createCollectionRecord).toHaveBeenCalledTimes(2));
    expect(bridge.createCollectionRecord.mock.calls[1]![0].name).toBe("Milk 2");
    await waitFor(() => expect(retainedCollectionFieldWritePaths(WORKSPACE.workspaceId)).toContain("tasks/Milk 2.md"));
    await typeRow("Milk", "Enter");
    await waitFor(() => expect(bridge.createCollectionRecord).toHaveBeenCalledTimes(3));
    expect(bridge.createCollectionRecord.mock.calls[2]![0].name).toBe("Milk 3");
    resetCollectionFieldWritesForTests();
  });

  it("writes a new record's typed values, and reports the listing on its own, when the file listing fails after the record is made", async () => {
    resetCollectionFieldWritesForTests();
    const bridge = makeBridge(Promise.resolve(null));
    const typeRow = await openTasksWithTitle(bridge, () => renderShell(bridge));
    // The creation succeeds, and the listing that follows it does not.
    bridge.createCollectionRecord.mockImplementationOnce(async (payload) => {
      bridge.listWorkspaceFiles = vi.fn(async () => { throw new Error("The listing is not ready."); });
      return { path: `${payload.collectionPath}/${payload.name}.md`, recordId: "rec_abcdefghijklmnopqrstuvwxyz" };
    });
    await typeRow("Milk", "Enter");
    // The record exists, so its title is written, or kept with its Try again, and nothing says it could not be created.
    await waitFor(() => expect(retainedCollectionFieldWritePaths(WORKSPACE.workspaceId)).toEqual(["tasks/Milk.md"]));
    await waitFor(() => expect(screen.getByTestId("workspace-shell-error").textContent).toContain("Could not refresh workspace files."));
    expect(document.querySelector("[data-new-record-status]")).toBeNull();
    expect(screen.queryByText(/could not create this record/)).toBeNull();
    // Nothing offers a second file for it.
    expect(bridge.createCollectionRecord).toHaveBeenCalledOnce();
    resetCollectionFieldWritesForTests();
  });

  it("gives two new rows named alike and saved back to back a file each, and writes each row's title to its own file", async () => {
    resetCollectionFieldWritesForTests();
    const bridge = makeBridge(Promise.resolve(null));
    const answers = [deferred<Awaited<ReturnType<typeof bridge.createCollectionRecord>>>(), deferred<Awaited<ReturnType<typeof bridge.createCollectionRecord>>>()];
    bridge.createCollectionRecord.mockImplementationOnce(() => answers[0]!.promise).mockImplementationOnce(() => answers[1]!.promise);
    const typeRow = await openTasksWithTitle(bridge, () => renderShell(bridge));
    await typeRow("Acme", "Enter");
    // The next key is typed in the next row, with no wait for the first creation.
    const editor = document.querySelector<HTMLInputElement>("[data-cell-editor] input")!;
    fireEvent.change(editor, { target: { value: "acme" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(bridge.createCollectionRecord).toHaveBeenCalledTimes(2));
    // Both creations are out. The first holds its file's name until it ends, so the second took the next one.
    expect(bridge.createCollectionRecord.mock.calls.map(([payload]) => payload.name)).toEqual(["Acme", "acme 2"]);
    // They answer out of order.
    await act(async () => answers[1]!.resolve({ path: "tasks/acme 2.md", recordId: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb" }));
    await act(async () => answers[0]!.resolve({ path: "tasks/Acme.md", recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa" }));
    // Each title is with the field writes of its own file.
    await waitFor(() => expect([...retainedCollectionFieldWritePaths(WORKSPACE.workspaceId)].sort()).toEqual(["tasks/Acme.md", "tasks/acme 2.md"]));
    expect(bridge.createCollectionRecord).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/could not create this record/)).toBeNull();
    resetCollectionFieldWritesForTests();
  });

  it("keeps a creation that stopped part way as that record's when its resume fails: the notice keeps the same resume, and nothing makes a second file", async () => {
    resetCollectionFieldWritesForTests();
    const bridge = makeBridge(Promise.resolve(null));
    const recordId = "rec_abcdefghijklmnopqrstuvwxyz";
    bridge.createCollectionRecord
      .mockResolvedValueOnce({ kind: "partial", created: ["tasks/Milk.md"], failedStage: "index", reason: "index unavailable",
        retry: { mode: "resume", recordId, instruction: "Try again to finish this record." } })
      .mockRejectedValueOnce(new Error("tasks/Milk.md already exists. Choose another record name."))
      .mockRejectedValueOnce(new Error("The shared file session changed. Open the Collection again."));
    const typeRow = await openTasksWithTitle(bridge, () => renderShell(bridge));
    await typeRow("Milk", "Enter");
    const notice = () => screen.getByTestId("workspace-shell-error");
    await waitFor(() => expect(notice().textContent).toContain("dohc created the record file but could not finish the record."));
    // No row holds the record. The notice has what was typed, and its Try again is the resume of that record.
    expect(notice().textContent).toContain("You typed: title: Milk");
    expect(document.querySelector("[data-new-record-status]")).toBeNull();
    // The resume itself fails. The record still exists in part, so the failure is still that record's.
    fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));
    await waitFor(() => expect(bridge.createCollectionRecord).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(notice().textContent).toContain("already exists"));
    // The words still say the record's file exists, so nobody takes the record for one that was never made.
    expect(notice().textContent).toContain("dohc created the record file but could not finish the record.");
    expect(notice().textContent).not.toContain("could not create this record");
    expect(notice().textContent).toContain("You typed: title: Milk");
    // The row on screen is the next one, with nothing typed: Enter in it starts no creation beside the unfinished one.
    fireEvent.keyDown(document.querySelector<HTMLInputElement>("[data-cell-editor] input")!, { key: "Enter" });
    expect(bridge.createCollectionRecord).toHaveBeenCalledTimes(2);
    // Its one retry is the same resume, for the same record, however often that fails.
    fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));
    await waitFor(() => expect(bridge.createCollectionRecord).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(notice().textContent).toContain("The shared file session changed."));
    expect(bridge.createCollectionRecord.mock.calls.slice(1).map(([payload]) => [payload.name, payload.recordId])).toEqual([["Milk", recordId], ["Milk", recordId]]);
    resetCollectionFieldWritesForTests();
  });

  it("keeps a new row the relay refused when the window switches workspaces before the file listing answers", async () => {
    resetCollectionFieldWritesForTests();
    const bridge = makeBridge(Promise.resolve(null));
    let view!: ReturnType<typeof renderShell>;
    const typeRow = await openTasksWithTitle(bridge, () => { view = renderShell(bridge, WORKSPACE, [WORKSPACE, OTHER_WORKSPACE]); });
    const listing = deferred<Awaited<ReturnType<typeof bridge.listWorkspaceFiles>>>();
    // The record's file is kept on this computer as a draft the relay refused, and the listing that follows waits.
    const refused = { path: "tasks/Milk.md", recordId: "rec_abcdefghijklmnopqrstuvwxyz", delivery: "refused" as const, reason: "The owner's server did not accept this record." };
    bridge.createCollectionRecord.mockImplementationOnce(async () => {
      let first = true;
      bridge.listWorkspaceFiles = vi.fn(async () => {
        if (!first) return { visibility: { status: "ready" as const, rules: [] }, files: [], folders: ["tasks"] };
        first = false;
        return listing.promise;
      });
      return refused;
    });
    await typeRow("Milk", "Enter");
    await waitFor(() => expect(bridge.createCollectionRecord).toHaveBeenCalledOnce());
    // The root mounts a new shell for the workspace switched to, and only then does the listing answer.
    view.rerender(otherWorkspaceShell(bridge));
    await act(async () => listing.resolve({ visibility: { status: "ready" as const, rules: [] }, files: [], folders: ["tasks"] }));
    // The refusal still reaches what kept the row: its own workspace's list has it, with why and what was typed.
    await waitFor(() => expect(collectionWriteFailures().map((failure) => [failure.workspaceId, failure.collectionPath, failure.change.field, failure.change.value]))
      .toEqual([[WORKSPACE.workspaceId, "tasks", "New record", { title: "Milk" }]]));
    expect(collectionWriteFailures()[0]!.message).toContain("The owner's server did not accept this record.");
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    resetCollectionFieldWritesForTests();
  });

  it("still writes the typed values of a record made as the window switched workspaces, for its own workspace", async () => {
    resetCollectionFieldWritesForTests();
    const bridge = makeBridge(Promise.resolve(null));
    const pending = deferred<Awaited<ReturnType<typeof bridge.createCollectionRecord>>>();
    bridge.createCollectionRecord.mockImplementationOnce(() => pending.promise);
    let view!: ReturnType<typeof renderShell>;
    const typeRow = await openTasksWithTitle(bridge, () => { view = renderShell(bridge, WORKSPACE, [WORKSPACE, OTHER_WORKSPACE]); });
    await typeRow("Milk", "Enter");
    await waitFor(() => expect(bridge.createCollectionRecord).toHaveBeenCalledOnce());
    // The same shell takes the other workspace before main answers that it made the record.
    view.rerender(
      <>
        <CollectionFieldWriteHost />
        <DesktopWorkspaceShell workspace={OTHER_WORKSPACE} workspaces={[WORKSPACE, OTHER_WORKSPACE]} {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />
      </>,
    );
    await act(async () => pending.resolve({ path: "tasks/Milk.md", recordId: "rec_abcdefghijklmnopqrstuvwxyz" }));
    // The title is with the field writes of the workspace the record was made in, as a cell edit made before the switch is.
    await waitFor(() => expect(retainedCollectionFieldWritePaths(WORKSPACE.workspaceId)).toEqual(["tasks/Milk.md"]));
    expect(retainedCollectionFieldWritePaths(OTHER_WORKSPACE.workspaceId)).toEqual([]);
    // Nothing of that record is painted in the workspace the window shows now.
    expect(screen.queryByTestId(editorTabTestId("tasks/Milk.md"))).toBeNull();
    expect(document.querySelector("[data-new-record]")).toBeNull();
    resetCollectionFieldWritesForTests();
  });

  it.each([
    ["was still being typed", false],
    ["was being created, and main refused it", true],
  ] as const)("keeps a new row that %s when the window switched workspaces, in the list of unsaved changes of its own workspace", async (_when, sending) => {
    resetCollectionFieldWritesForTests();
    const bridge = makeBridge(Promise.resolve(null));
    const pending = deferred<Awaited<ReturnType<typeof bridge.createCollectionRecord>>>();
    bridge.createCollectionRecord.mockImplementation(() => pending.promise);
    let view!: ReturnType<typeof renderShell>;
    const typeRow = await openTasksWithTitle(bridge, () => { view = renderShell(bridge, WORKSPACE, [WORKSPACE, OTHER_WORKSPACE]); });
    await typeRow("Milk", sending ? "Enter" : null);
    if (sending) await waitFor(() => expect(bridge.createCollectionRecord).toHaveBeenCalledOnce());
    // The root mounts a new shell for the workspace switched to.
    view.rerender(otherWorkspaceShell(bridge));
    if (sending) await act(async () => pending.reject(new Error("Record creation stopped because this window changed workspaces.")));
    // The row could not be created at all. The list that outlives the shell keeps it, with its Collection and what was typed.
    await waitFor(() => expect(collectionWriteFailures().map((failure) => [failure.workspaceId, failure.collectionPath, failure.change.field, failure.change.value]))
      .toEqual([[WORKSPACE.workspaceId, "tasks", "New record", { title: "Milk" }]]));
    const kept = await screen.findByTestId("collection-write-failure");
    expect(kept.textContent).toContain("New record in tasks");
    expect(kept.textContent).toContain("dohc did not create this record.");
    expect(within(kept).getByLabelText<HTMLTextAreaElement>("Unsaved collection value").value).toContain('"title": "Milk"');
    // A row never sent asks main for nothing once the window shows another workspace.
    expect(bridge.createCollectionRecord).toHaveBeenCalledTimes(sending ? 1 : 0);
    // Nothing of it is painted in the workspace the window shows now.
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    resetCollectionFieldWritesForTests();
  });

  // The queue behind cell edits must outlive the page: the shell renders only
  // a group's ACTIVE tab, so opening a file unmounts CollectionPage. An edit
  // the cell already accepted must still reach its record's live document.
  it("keeps a queued record edit when a file opens while the first save is pending", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles = vi.fn(async () => ({ visibility: { status: "ready" as const, rules: [] },
      files: [
        { path: "tasks/one.md", kind: "file" as const },
        { path: "tasks/two.md", kind: "file" as const },
        { path: "notes.md", kind: "file" as const },
      ],
      folders: ["tasks"],
    }));
    bridge.listCollections = vi.fn(async () => ({
      collections: [{ path: "tasks", objectId: "object-test", status: "valid" as const, reasons: [] }], unclaimedDatasetFolders: [],
    }));
    bridge.getCollection = vi.fn(async () => ({
      path: "tasks",
      objectId: "object-test",
      status: "valid" as const,
      reasons: [],
      schema: {
        name: "Tasks",
        description: null,
        fields: [
          { name: "title", type: "text" as const },
          { name: "done", type: "checkbox" as const },
        ],
        views: [],
      },
      recordCount: 2,
    }));
    const taskRecord = (id: string, title: string, path: string) => ({
      id,
      path,
      conflicted: false,
      values: [
        {
          field: "title",
          value: title,
          validation: { status: "valid" as const },
          resolvedRelations: [],
        },
        {
          field: "done",
          value: false,
          validation: { status: "valid" as const },
          resolvedRelations: [],
        },
      ],
    });
    bridge.queryCollectionRecords = vi.fn(async () => ({
      collection: { path: "tasks", objectId: "object-test", status: "valid" as const, reasons: [] },
      records: [
        taskRecord("rec-1", "One", "tasks/one.md"),
        taskRecord("rec-2", "Two", "tasks/two.md"),
      ],
      groups: null,
      nextCursor: null,
    }));
    const sessionsByPath = new Map<string, string>();
    const updatesBySession = new Map<string, Uint8Array[]>();
    const saveStateListeners = new Set<
      (event: EngineYDocSaveStateEvent) => void
    >();
    const openEngineYDocSession = vi.fn(
      async (payload: { path: string; sessionId: string }) => {
        // Record files get live sessions; notes.md stays a plain editor.
        if (!payload.path.startsWith("tasks/")) return { available: false };
        sessionsByPath.set(payload.path, payload.sessionId);
        return {
          available: true,
          initialUpdate: recordDocUpdate(
            payload.path === "tasks/one.md" ? "rec-1" : "rec-2",
          ),
          lineageGeneration: 1,
        };
      },
    );
    const applyEngineYDocUpdate = vi.fn(
      async (payload: { sessionId: string; update: Uint8Array }) => {
        const applied = updatesBySession.get(payload.sessionId) ?? [];
        applied.push(payload.update);
        updatesBySession.set(payload.sessionId, applied);
        return { accepted: true as const };
      },
    );
    Object.assign(bridge, {
      openEngineYDocSession,
      applyEngineYDocUpdate,
      closeEngineYDocSession: vi.fn(async () => undefined),
      onEngineYDocRemoteUpdate: vi.fn(() => () => undefined),
      onEngineYDocOwnerHandoff: () => () => undefined,
      prepareEngineYDocOwnerHandoff: async () => undefined,
      onEngineYDocLineageReplacement: vi.fn(() => () => undefined),
      onEngineYDocSaveState: vi.fn(
        (listener: (event: EngineYDocSaveStateEvent) => void) => {
          saveStateListeners.add(listener);
          return () => saveStateListeners.delete(listener);
        },
      ),
    });
    renderShell(bridge);

    const row = await waitFor(() => {
      const candidate = screen
        .getAllByTestId("tree-row")
        .find((entry) => entry.dataset.path === "tasks");
      expect(candidate?.dataset.collection).toBe("true");
      return candidate as HTMLElement;
    });
    await user.click(row);
    const collectionPage = within(await screen.findByTestId("collection-page"));
    const checkboxes = await collectionPage.findAllByRole(
      "checkbox",
      {},
      { timeout: 15_000 },
    );
    expect(checkboxes).toHaveLength(2);

    // First edit: the record's session opens and the update is delivered, but
    // the save never settles — the head write is still pending.
    await user.click(checkboxes[0]!);
    await waitFor(() => expect(sessionsByPath.has("tasks/one.md")).toBe(true));
    await waitFor(() =>
      expect(
        updatesBySession.get(sessionsByPath.get("tasks/one.md")!)?.length ?? 0,
      ).toBeGreaterThan(0),
    );

    // Second edit queues behind the pending head.
    await user.click(collectionPage.getAllByRole("checkbox")[1]!);

    // Ordinary navigation: open a plain file; the collection page unmounts.
    const fileRow = screen
      .getAllByTestId("tree-row")
      .find((entry) => entry.dataset.path === "notes.md")!;
    await user.click(fileRow);
    await screen.findByTestId("tab-notes.md");
    await waitFor(() =>
      expect(screen.queryByTestId("collection-page")).toBeNull(),
    );

    // The pending head settles only now, after the page is gone.
    act(() => {
      const sessionId = sessionsByPath.get("tasks/one.md")!;
      for (const listener of [...saveStateListeners]) {
        listener({ sessionId, workspaceId: WORKSPACE.workspaceId, path: "tasks/one.md", state: { kind: "saved-here" }, seq: 1 });
      }
    });

    // The second accepted edit still reaches its record's live document.
    await waitFor(() => expect(sessionsByPath.has("tasks/two.md")).toBe(true));
    await waitFor(() => {
      const updates =
        updatesBySession.get(sessionsByPath.get("tasks/two.md")!) ?? [];
      const probe = new Y.Doc();
      for (const update of updates) Y.applyUpdate(probe, update);
      expect(probe.getMap("frontmatter").get("done")).toBe(true);
    });
  }, 40_000);

  // A View share takes no writes, so every create or import would end in a
  // refusal. Neither the palette nor the application menu offers one.
  it("offers no create or import command from a read-only shared view", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    const user = userEvent.setup();
    const view = renderShell(bridge, SHARE_VIEW);

    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByTestId("command-palette");
    // The palette renders and lists something, so the misses below are the
    // gate working, not the palette failing to open.
    await within(palette).findByText("New editor group right");
    for (const label of ["New file", "New file…", "New drawing", "New folder", "New collection", "Import files"]) {
      expect(within(palette).queryByText(label)).toBeNull();
    }
    await user.keyboard("{Escape}");

    for (const command of ["new-file", "new-folder", "new-collection", "import-files"] as const) {
      act(() => bridge.emitMenuCommand(command));
    }
    await act(async () => {});
    expect(screen.queryByTestId("new-page")).toBeNull();
    expect(screen.queryByLabelText("New folder name")).toBeNull();
    expect(bridge.createWorkspaceFile).not.toHaveBeenCalled();
    expect(bridge.importWorkspaceFiles).not.toHaveBeenCalled();
    // The Collection dialog stays hidden without Edit, so a New collection the
    // menu let through would open only once a registry update grants Edit.
    const editShare: Workspace = { ...SHARE_VIEW, shareView: { ...SHARE_VIEW.shareView!, access: "edit" } };
    view.rerender(
      <>
        <CollectionFieldWriteHost />
        <DesktopWorkspaceShell workspace={editShare} workspaces={[editShare]} {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />
      </>,
    );
    await act(async () => {});
    expect(screen.queryByTestId("new-collection-dialog")).toBeNull();
  });

});

describe("content search", () => {
  it("shows an invocation failure with a retry instead of zero results", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.searchWorkspace
      .mockRejectedValueOnce(new Error("Workspace root vanished."))
      .mockResolvedValueOnce({ status: "accepted" });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(screen.getByTestId("activity-search"));
    await user.type(await screen.findByTestId("search-input"), "apples");

    const error = await screen.findByTestId("workspace-shell-error");
    expect(error.textContent).toContain(
      "dohc could not search this workspace. Workspace root vanished.",
    );
    expect(screen.queryByTestId("search-summary")).toBeNull();
    expect(screen.queryByTestId("search-empty-state")).toBeNull();

    await user.click(screen.getByTestId("workspace-shell-error-retry"));

    expect(bridge.searchWorkspace).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(screen.getByTestId("search-spinner")).toBeTruthy();
  });
});

describe("open editors", () => {
  it("holds a quit for a body typed while its page's file is being created", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const created = deferred<{ path: string }>();
    bridge.createWorkspaceFile.mockImplementationOnce(() => created.promise);
    bridge.readWorkspaceText.mockImplementation(() => deferred<never>().promise);
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findAllByTestId("tree-row");
    await user.click(screen.getByLabelText("New file"));
    await user.keyboard("{Enter}Day one");
    await waitFor(() => expect(bridge.createWorkspaceFile).toHaveBeenCalledTimes(1));
    expect(hasPendingEditorDrafts()).toBe(true);

    const settled = settlePendingEditorDrafts();
    await act(async () => created.resolve({ path: "Untitled.md" }));
    await expect(settled).resolves.toBe(true);
    expect(recovered()).toEqual([{ path: "Untitled.md", text: "Day one\n" }]);
  });

  it("closes a new page whose file is being created, and keeps what was typed", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const created = deferred<{ path: string }>();
    bridge.createWorkspaceFile.mockImplementationOnce(() => created.promise);
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findAllByTestId("tree-row");
    await user.click(screen.getByLabelText("New file"));
    await user.keyboard("Lisbon{Enter}Day one");
    await user.click(screen.getAllByLabelText("Close Lisbon")[0]!);
    await act(async () => created.resolve({ path: "Lisbon.md" }));

    await waitFor(() => expect(screen.queryByRole("tab", { name: /Lisbon/ })).toBeNull());
    expect(screen.queryByTestId("new-page")).toBeNull();
    expect(recovered()).toEqual([{ path: "Lisbon.md", text: LISBON }]);
  });
});

describe("settings entry points", () => {
  it("reports a save that fails after settings closed in the workspace open by then", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const save = deferred<Awaited<ReturnType<typeof bridge.setUserSettings>>>();
    bridge.setUserSettings.mockImplementationOnce(() => save.promise);
    const user = userEvent.setup();
    const view = renderShell(bridge, WORKSPACE, [WORKSPACE, OTHER_WORKSPACE]);

    await user.click(await screen.findByTestId("activity-settings"));
    await user.type(await screen.findByTestId("general-preferred-name-input"), "Sam");
    await user.click(document.querySelector<HTMLElement>('[data-dohc-modal="true"]')!);
    await waitFor(() => expect(screen.queryByTestId("settings-dialog")).toBeNull());
    const change = bridge.setUserSettings.mock.lastCall![0];
    // The root mounts a new shell for the workspace switched to.
    view.rerender(
      <>
        <CollectionFieldWriteHost />
        <DesktopWorkspaceShell key={OTHER_WORKSPACE.workspaceId} workspace={OTHER_WORKSPACE} workspaces={[WORKSPACE, OTHER_WORKSPACE]}
          {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />
      </>,
    );
    await screen.findByTestId("activity-settings");
    await act(async () => save.reject(new Error("The settings file is read-only.")));

    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("The settings file is read-only.");
    bridge.setUserSettings.mockClear();
    await user.click(within(toast).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.setUserSettings).toHaveBeenCalledExactlyOnceWith(change));
  });
});

const SITE: SitePackageInfo = {
  root: "app",
  title: "App",
  kind: "static",
  confidence: "high",
  entryPath: "app/index.html",
  configPath: null,
  packagePath: null,
  packageManager: null,
  scripts: {},
  configuredScripts: {},
  configuredPreviewMode: null,
  configuredBuildOutput: null,
  buildOutputs: [],
  sourceFiles: ["app/index.html"],
  shareManifest: { ok: false, reason: "no-runnable-artifact" },
  diagnostics: [],
  authority: { kind: "workspace" },
};

describe("customize", () => {
  it("keeps a listed app's files out of Home's Pages before its folder is read", async () => {
    const bridge = makeBridge(Promise.resolve(HOME_STATE));
    bridge.listSites.mockResolvedValue({ sites: [{ ...SITE, root: "trip", title: "Trip" }] });
    bridge.listWorkspaceFiles.mockResolvedValue({
      visibility: { status: "ready", rules: [] },
      files: [{ path: "notes.md", kind: "file" }, { path: "trip/README.md", kind: "file" }, { path: "trip/index.html", kind: "file" }],
      folders: ["trip"],
    });
    renderShell(bridge);

    await screen.findByTestId("sites-row");
    const pages = screen.getByTestId("explorer-pages");
    expect(pages.querySelector('[data-path="notes.md"]')).not.toBeNull();
    expect(pages.querySelector('[data-path="trip"]')).toBeNull();
    expect(pages.querySelector('[data-path="trip/README.md"]')).toBeNull();
  });
});

describe("workbench render cost", () => {
  it.each(["policy path", "path-less batch"])("withholds visibility through a %s refresh and rejects a pre-event answer", async mode => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);
    const visibility = () => vi.mocked(useWorkspaceListing).mock.results.at(-1)!.value.visibility.status;
    await waitFor(() => expect(visibility()).toBe("ready"));
    await waitFor(() => expect(bridge.workspaceActivitySubscriberCount()).toBe(2));
    const old = deferred<Awaited<ReturnType<typeof bridge.listWorkspaceFiles>>>();
    const fresh = deferred<Awaited<ReturnType<typeof bridge.listWorkspaceFiles>>>();
    const initial = await bridge.listWorkspaceFiles({ workspaceId: WORKSPACE.workspaceId });
    bridge.listWorkspaceFiles.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    vi.useFakeTimers();
    try {
      act(() => bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId, paths: ["notes.md"] }));
      await act(async () => { await vi.advanceTimersByTimeAsync(WORKSPACE_ACTIVITY_REFRESH_DELAY_MS); });
      act(() => bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId,
        ...(mode === "policy path" ? { paths: [".dohc/visibility.toml"], pathSetChanged: false } : {}) }));
      expect(visibility()).toBe("unavailable");
      await act(async () => { old.resolve(initial); });
      expect(visibility()).toBe("unavailable");
      await act(async () => { await vi.advanceTimersByTimeAsync(WORKSPACE_ACTIVITY_REFRESH_DELAY_MS); });
      await act(async () => { fresh.resolve(initial); });
      expect(visibility()).toBe("ready");
    } finally { vi.useRealTimers(); }
  });
});

describe("a chat page archive refused for live editing", () => {
  const PAGE = "Bookmarks/Chats/Team-update--thread-team.md";
  const TITLE = `dohc can't archive "${PAGE}" while it has live editing on`;
  const bookmark = {
    bookmarkId: "bookmark-team", targetKind: "thread" as const, targetId: "thread-team", threadId: "thread-team",
    mode: "live" as const, destinationPath: PAGE, state: "active" as const, projectionState: "ready" as const,
    generation: 1, createdAtMs: 1, updatedAtMs: 1,
  };
  function chatsBridge() {
    const bridge = Object.assign(
      makeBridge(Promise.resolve({ ...storedStateWithTabs([], null), activeView: "chats" })),
      {
        listChatChannels: vi.fn(async () => ({
          channels: [{ id: "channel-team", name: "team", slug: "team", kind: "channel" as const,
            createdAtMs: 1, updatedAtMs: 1, threadCount: 1, unreadCount: 0, wireId: "channel-team" }],
          fileThreads: [],
        })),
        listChatChannelShares: vi.fn(async () => ({
          joined: [{ channelWireId: "channel-team", joined: null }],
          sessionKey: "session-a",
          relay: { state: "answered" as const, granted: [], received: [], removed: [] },
        })),
        listChannelThreads: vi.fn(async () => ({
          threads: [{
            id: "thread-team", title: "Team update", createdAtMs: 1, updatedAtMs: 1, channelId: "channel-team",
            messageCount: 1, lastReadSequence: 1, unreadCount: 0,
            openingMessage: { presentation: { group: "fixture", hue: null, self: false }, id: "message-team",
              authorKind: "human" as const, authorDisplayName: "Alice", bodySnippet: "A settled update",
              createdAtMs: 1, reactions: [] },
          }],
          viewerAuthorId: "you",
        })),
        listChatBookmarks: vi.fn(async () => ({ bookmarks: [bookmark] })),
        archiveChatBookmark: vi.fn(async (_input: { workspaceId: string; bookmarkId: string }) =>
          ({ bookmark: { ...bookmark, state: "archived" as const } })),
      },
    );
    bridge.archiveChatBookmark.mockRejectedValueOnce(Object.assign(new Error([TITLE,
      "In Live documents, stop live editing for this page, then archive it again."].join(String.fromCharCode(10))), { name: "LivePageOwnedError" }));
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({ nextCursor: null,
      documents: [{ path: "other.md", objectId: "object-other", status: "ready" as const, canResume: false },
        { path: PAGE, objectId: "object-page", status: "ready" as const, canResume: false }] }));
    return bridge;
  }
  async function refuse(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByTestId("chats-channel"));
    const saved = await screen.findByTestId("chats-post-bookmark");
    await waitFor(() => expect(saved.getAttribute("aria-pressed")).toBe("true"));
    await user.click(saved);
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(TITLE)).toBeTruthy();
    expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
    return { saved, toast };
  }
  async function expectNoRefusal(user: ReturnType<typeof userEvent.setup>) {
    await waitFor(() => expect(screen.queryByTestId("workspace-shell-error")).toBeNull());
    await user.click(screen.getByTestId("notice-center-toggle"));
    expect(within(await screen.findByTestId("notice-center")).queryByText(TITLE)).toBeNull();
  }

  it("opens Live documents at the page's row, and Try again after closing it archives the page and clears the notice", async () => {
    const user = userEvent.setup();
    const bridge = chatsBridge();
    renderShell(bridge);
    const { toast } = await refuse(user);
    await user.click(within(toast).getByRole("button", { name: "Open Live documents" }));
    const dialog = await screen.findByTestId("live-documents-dialog");
    await within(dialog).findByRole("button", { name: `Stop live editing for ${PAGE}` });
    expect(within(dialog).getByTestId(`live-document-row-${PAGE}`).getAttribute("aria-current")).toBe("true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("live-documents-dialog")).toBeNull());
    await user.click(within(await screen.findByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.archiveChatBookmark).toHaveBeenCalledTimes(2));
    await expectNoRefusal(user);
  });
});
