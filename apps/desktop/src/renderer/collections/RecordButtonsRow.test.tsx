// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionRecord } from "@dohc/workspace-contracts";
import type {
  AutomationRunSettledEvent, GetCollectionRecordHistoryPayload, GetCollectionRecordHistoryResult, ListRecordButtonsResult, RecordHistoryEntry, WorkspaceActivityEvent,
} from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { useShellError } from "../shell/useShellError";
import { RecordButtonsRow } from "./RecordButtonsRow";
import { RecordHistoryDialog } from "./RecordHistoryDialog";
import { useRecordHistory } from "./useRecordHistory";
import { resetAutomationButtonsForTests } from "./useAutomationButtons";

// The shell opens the ⚡ panel at a run; these tests open none.
const noRun = async () => null;
const FAILED = "dohc could not read this record's history.";

const invoice: CollectionRecord = {
  id: "rec-12", path: "Invoices/12.md", conflicted: false,
  values: [{ field: "title", value: "Invoice 12", validation: { status: "valid" }, resolvedRelations: [] }],
};

function stub(answer: ListRecordButtonsResult) {
  const activity = new Set<(event: WorkspaceActivityEvent) => void>();
  const settled = new Set<(event: AutomationRunSettledEvent) => void>();
  const bridge = {
    listRecordButtons: vi.fn(async () => answer),
    pressAutomationButton: vi.fn(async () => ({ busy: false as const, claimId: "atc_press", settled: null })),
    onWorkspaceActivity: vi.fn((listener: (event: WorkspaceActivityEvent) => void) => {
      activity.add(listener);
      return () => activity.delete(listener);
    }),
    onAutomationRunSettled: vi.fn((listener: (event: AutomationRunSettledEvent) => void) => {
      settled.add(listener);
      return () => settled.delete(listener);
    }),
    onAutomationRunWaiting: vi.fn(() => () => undefined),
    emitActivity: (event: WorkspaceActivityEvent) => { for (const listener of [...activity]) listener(event); },
    emitSettled: (event: AutomationRunSettledEvent) => { for (const listener of [...settled]) listener(event); },
  };
  vi.stubGlobal("dohcDesktop", bridge);
  return bridge;
}

afterEach(() => {
  cleanup();
  resetAutomationButtonsForTests();
  vi.unstubAllGlobals();
});

describe("RecordButtonsRow", () => {
  it("shows the record's buttons in one row and presses one for this record", async () => {
    const bridge = stub({
      record: invoice, collectionPath: "Invoices",
      buttons: [{ field: "Mark paid", state: { kind: "ready", automationId: "collection:Invoices#paid" } }],
    });
    const onNotice = vi.fn();
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={() => undefined} onNotice={onNotice} onOpenHistory={() => undefined} />);
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    expect(screen.getByTestId("record-buttons").contains(button)).toBe(true);
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button);
    await waitFor(() => expect(bridge.pressAutomationButton).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1", collectionPath: "Invoices", field: "Mark paid", recordId: "rec-12",
    })));
    await act(async () => undefined);
    act(() => bridge.emitSettled({ workspaceId: "ws-1", claimId: "atc_press", outcome: "done", error: null }));
    expect(onNotice).toHaveBeenCalledWith("Ran Mark paid on Invoice 12");
  });

  it("asks before it runs an action dohc cannot undo, and runs it only on Run", async () => {
    const bridge = stub({
      record: invoice, collectionPath: "Invoices",
      buttons: [{ field: "Mark paid", state: { kind: "ready", automationId: "collection:Invoices#paid", irreversible: [{ name: "invoices.settle", label: "Settle" }, { name: "receipts.send", label: "Send receipt" }] } }],
    });
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={() => undefined} onNotice={() => undefined} onOpenHistory={() => undefined} />);
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button);
    const question = screen.getByRole("dialog", { name: "Run Mark paid for Invoice 12" });
    expect(question.textContent).toContain("Settle and Send receipt can't be undone.");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // Focus goes to Run; Escape returns it to the button and runs nothing.
    expect(document.activeElement?.textContent).toBe("Run");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bridge.pressAutomationButton).not.toHaveBeenCalled();
    // A held Enter that opened the question does not answer it.
    fireEvent.click(button);
    expect(screen.getByRole("dialog").getAttribute("aria-describedby")).toBe(screen.getByText("Settle and Send receipt can't be undone.").id);
    const run = screen.getByRole("button", { name: "Run" });
    // Tab and Shift+Tab stay in the question.
    fireEvent.keyDown(run, { key: "Tab" });
    expect(document.activeElement?.textContent).toBe("Cancel");
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(run);
    const held = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    run.dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);
    expect(bridge.pressAutomationButton).not.toHaveBeenCalled();
    fireEvent.click(run);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    await waitFor(() => expect(bridge.pressAutomationButton).toHaveBeenCalledTimes(1));
    expect(bridge.pressAutomationButton).toHaveBeenCalledWith(expect.objectContaining({ confirmed: ["invoices.settle", "receipts.send"] }));
  });

  it("closes the question on scroll even when its words were already showing", async () => {
    const bridge = stub({
      record: invoice, collectionPath: "Invoices",
      buttons: [{ field: "Mark paid", state: { kind: "ready", automationId: "collection:Invoices#paid", irreversible: [{ name: "invoices.settle", label: "Settle" }] } }],
    });
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={() => undefined} onNotice={() => undefined} onOpenHistory={() => undefined} />);
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    // A press someone else is running leaves words on the button, which show while the pointer is over it.
    bridge.pressAutomationButton.mockResolvedValueOnce({ busy: true as const, reason: "Running for this record." } as never);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(button.getAttribute("aria-describedby")).not.toBeNull());
    fireEvent.mouseEnter(button.parentElement!);
    fireEvent.click(button);
    expect(screen.getByRole("dialog")).toBeTruthy();
    act(() => { window.dispatchEvent(new Event("scroll")); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("closes the question and gives focus back when the button would run other actions", async () => {
    const bridge = stub({
      record: invoice, collectionPath: "Invoices",
      buttons: [{ field: "Mark paid", state: { kind: "ready", automationId: "collection:Invoices#paid", irreversible: [{ name: "invoices.settle", label: "Settle" }] } }],
    });
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={() => undefined} onNotice={() => undefined} onOpenHistory={() => undefined} />);
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button);
    expect(document.activeElement?.textContent).toBe("Run");
    bridge.listRecordButtons.mockResolvedValue({
      record: invoice, collectionPath: "Invoices",
      buttons: [{ field: "Mark paid", state: { kind: "ready", automationId: "collection:Invoices#paid", irreversible: [{ name: "invoices.settle", label: "Settle" }, { name: "invoices.refund", label: "Refund" }] } }],
    });
    act(() => bridge.emitActivity({ workspaceId: "ws-1", paths: ["Invoices/automations.yaml"] } as WorkspaceActivityEvent));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(button);
    expect(bridge.pressAutomationButton).not.toHaveBeenCalled();
  });

  it("shows nothing for a file that is not a record", async () => {
    const bridge = stub({ record: null });
    const { container } = render(<RecordButtonsRow workspaceId="ws-1" path="Notes/todo.md" onError={() => undefined} onNotice={() => undefined} onOpenHistory={() => undefined} />);
    await waitFor(() => expect(bridge.listRecordButtons).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("offers History for a record without buttons, and asks the shell to open it", async () => {
    const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [] });
    const history = vi.fn();
    Object.assign(bridge, { getCollectionRecordHistory: history });
    const onOpenHistory = vi.fn();
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={() => undefined} onNotice={() => undefined} onOpenHistory={onOpenHistory} />);
    const open = await screen.findByRole("button", { name: "History" });
    expect(screen.queryByRole("button", { name: /Mark paid/ })).toBeNull();
    fireEvent.click(open);
    expect(onOpenHistory).toHaveBeenCalledWith({ collectionPath: "Invoices", recordId: "rec-12", recordName: "Invoice 12" });
    expect(history).not.toHaveBeenCalled();
  });

  it("reads again when the record or its Collection's automations change, and not for other files", async () => {
    const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [] });
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/2026/12.md" onError={() => undefined} onNotice={() => undefined} onOpenHistory={() => undefined} />);
    await waitFor(() => expect(bridge.listRecordButtons).toHaveBeenCalledTimes(1));
    act(() => bridge.emitActivity({ workspaceId: "ws-1", paths: ["Notes/todo.md", "Invoice/automations.yaml"] } as WorkspaceActivityEvent));
    act(() => bridge.emitActivity({ workspaceId: "ws-2", paths: ["Invoices/automations.yaml"] } as WorkspaceActivityEvent));
    expect(bridge.listRecordButtons).toHaveBeenCalledTimes(1);
    act(() => bridge.emitActivity({ workspaceId: "ws-1", paths: ["Invoices/automations.yaml"] } as WorkspaceActivityEvent));
    await waitFor(() => expect(bridge.listRecordButtons).toHaveBeenCalledTimes(2));
  });

  it("reports a failed read with Try again", async () => {
    const bridge = stub({ record: null });
    bridge.listRecordButtons.mockRejectedValueOnce(new Error("The workspace engine is not running."));
    const onError = vi.fn();
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={onError} onNotice={() => undefined} onOpenHistory={() => undefined} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("dohc could not read this record's buttons.", expect.any(Error), expect.any(Function)));
    act(() => (onError.mock.calls[0]![2] as () => void)());
    await waitFor(() => expect(bridge.listRecordButtons).toHaveBeenCalledTimes(2));
  });
});

const paidByRun: RecordHistoryEntry = {
  historyId: 3, field: "Paid", previous: { present: false, value: null }, next: { present: true, value: true }, recordedAtMs: Date.now(),
  author: { kind: "automation", automationId: "collection:invoices-id#paid", name: "Mark paid", run: { claimId: "atc_1", onThisComputer: true } },
};

// The shell's part: its Notices, the History it holds, and the record view.
function shellWith(
  read: (payload: GetCollectionRecordHistoryPayload) => Promise<GetCollectionRecordHistoryResult>,
  openRun: (automationId: string, claimId: string, name: string) => Promise<string | null> = noRun,
) {
  const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [] });
  const history = vi.fn(read);
  Object.assign(bridge, { getCollectionRecordHistory: history });
  let shell!: { notices: ReturnType<typeof useShellError>; history: ReturnType<typeof useRecordHistory> };
  function Shell(props: { workspaceId: string; recordOpen: boolean }) {
    const notices = useShellError(props.workspaceId);
    const recordHistory = useRecordHistory(props.workspaceId, { reportShellError: notices.reportShellError, clearKind: notices.clearKind, openAutomationRun: openRun });
    shell = { notices, history: recordHistory };
    const session = recordHistory.session;
    return (
      <>
        {props.recordOpen ? (
          <RecordButtonsRow workspaceId={props.workspaceId} path="Invoices/12.md" onError={notices.reportShellError} onNotice={() => undefined} onOpenHistory={recordHistory.open} />
        ) : null}
        {session ? (
          <RecordHistoryDialog
            key={session.key} workspaceId={props.workspaceId} collectionPath={session.target.collectionPath} recordId={session.target.recordId}
            recordName={session.target.recordName} until={session.until} onClose={recordHistory.close} onOpenRun={recordHistory.openRun}
            onFailed={recordHistory.failed} onRead={recordHistory.read}
          />
        ) : null}
      </>
    );
  }
  const view = render(<Shell workspaceId="ws-1" recordOpen />);
  return {
    history,
    shell: () => shell,
    rows: () => shell.notices.shellErrors.filter((error) => error.kind === "record-history"),
    rerender: (props: { workspaceId: string; recordOpen: boolean }) => view.rerender(<Shell {...props} />),
  };
}

describe("RecordButtonsRow History in the shell", () => {
  it("opens a run from History and closes the dialog", async () => {
    const openRun = vi.fn(async (_automationId: string, _claimId: string, _name: string) => null);
    const f = shellWith(async () => ({ entries: [paidByRun], nextBeforeHistoryId: null }), openRun);
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    const dialog = await screen.findByRole("dialog", { name: "History of Invoice 12" });
    expect(f.history).toHaveBeenCalledWith({ workspaceId: "ws-1", collectionPath: "Invoices", recordId: "rec-12" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "View run" }));
    // The name travels too, so the panel's title is right before it reads the file.
    expect(openRun).toHaveBeenCalledWith("collection:invoices-id#paid", "atc_1", "Mark paid");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reports a run the shell cannot open", async () => {
    const note = "dohc cannot find this automation's Collection on this computer.";
    const f = shellWith(async () => ({ entries: [paidByRun], nextBeforeHistoryId: null }), async () => note);
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: "View run" }));
    await waitFor(() => expect(f.shell().notices.shellErrors.map((error) => [error.message, error.retry])).toEqual([[note, null]]));
  });

  it("gives focus back to History when its dialog closes", async () => {
    shellWith(async () => ({ entries: [], nextBeforeHistoryId: null }));
    const open = await screen.findByRole("button", { name: "History" });
    open.focus();
    fireEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "History of Invoice 12" });
    await within(dialog).findByText("No field of this record has changed yet.");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(open));
  });

  it("clears the failure from Notices when the dialog's own Try again reads the history", async () => {
    const f = shellWith(async () => { throw new Error("The workspace engine is not running."); });
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    await waitFor(() => expect(f.rows().map((row) => [row.message.startsWith(FAILED), row.seen])).toEqual([[true, false]]));
    f.history.mockResolvedValue({ entries: [paidByRun], nextBeforeHistoryId: null });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Try again" }));
    await screen.findByText(/Paid:/);
    // The toast and the row go together.
    expect(f.rows()).toEqual([]);
  });

  it("opens that record's History from Notices after the dialog and the record closed, and reads the failed page", async () => {
    const f = shellWith(async (payload) => {
      if (payload.beforeHistoryId === undefined) return { entries: [paidByRun], nextBeforeHistoryId: 3 };
      throw new Error("The workspace engine is not running.");
    });
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: "Older changes" }));
    await waitFor(() => expect(f.rows()).toHaveLength(1));
    fireEvent.keyDown(document, { key: "Escape" });
    f.rerender({ workspaceId: "ws-1", recordOpen: false });
    expect(screen.queryByRole("dialog")).toBeNull();

    f.history.mockClear();
    f.history.mockImplementation(async (payload) => payload.beforeHistoryId === undefined
      ? { entries: [paidByRun], nextBeforeHistoryId: 3 }
      : { entries: [{ ...paidByRun, historyId: 1, field: "Owner", author: null }], nextBeforeHistoryId: null });
    act(() => f.shell().notices.retryShellError(f.rows()[0]!.id));
    const dialog = await screen.findByRole("dialog", { name: "History of Invoice 12" });
    await within(dialog).findByText(/Owner:/);
    expect(f.history.mock.calls.map(([payload]) => payload)).toEqual([
      { workspaceId: "ws-1", collectionPath: "Invoices", recordId: "rec-12" },
      { workspaceId: "ws-1", collectionPath: "Invoices", recordId: "rec-12", beforeHistoryId: 3 },
    ]);
    expect(f.rows()).toEqual([]);
  });

  it("keeps an older page's failure when History opens again and reads only the first page", async () => {
    const f = shellWith(async (payload) => {
      if (payload.beforeHistoryId === undefined) return { entries: [paidByRun], nextBeforeHistoryId: 3 };
      throw new Error("The workspace engine is not running.");
    });
    const open = await screen.findByRole("button", { name: "History" });
    fireEvent.click(open);
    fireEvent.click(await screen.findByRole("button", { name: "Older changes" }));
    await waitFor(() => expect(f.rows()).toHaveLength(1));
    fireEvent.keyDown(document, { key: "Escape" });
    f.history.mockClear();
    fireEvent.click(open);
    await screen.findByRole("button", { name: "Older changes" });
    expect(f.history).toHaveBeenCalledTimes(1);
    expect(f.rows()).toHaveLength(1);
  });

  it("keeps an older page's failure until the read back reaches that page, where changes moved the pages", async () => {
    const f = shellWith(async (payload) => {
      if (payload.beforeHistoryId === undefined) return { entries: [paidByRun], nextBeforeHistoryId: 3 };
      throw new Error("The workspace engine is not running.");
    });
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: "Older changes" }));
    await waitFor(() => expect(f.rows()).toHaveLength(1));
    fireEvent.keyDown(document, { key: "Escape" });

    // A new change moved the first page's edge from 3 to 4.
    const older = deferred<GetCollectionRecordHistoryResult>();
    f.history.mockImplementation((payload) => payload.beforeHistoryId === undefined
      ? Promise.resolve({ entries: [{ ...paidByRun, historyId: 5 }], nextBeforeHistoryId: 4 })
      : older.promise);
    // The row's own step, run while the row stays.
    act(() => f.rows()[0]!.retry!());
    await waitFor(() => expect(f.history).toHaveBeenLastCalledWith({ workspaceId: "ws-1", collectionPath: "Invoices", recordId: "rec-12", beforeHistoryId: 4 }));
    expect(f.rows()).toHaveLength(1);
    await act(async () => {
      older.resolve({ entries: [{ ...paidByRun, historyId: 2, field: "Owner", author: null }], nextBeforeHistoryId: 2 });
      await older.promise;
    });
    await screen.findByText(/Owner:/);
    expect(f.rows()).toEqual([]);
  });

  it("keeps a newer failure when an earlier read lands late", async () => {
    const slow = deferred<GetCollectionRecordHistoryResult>();
    const f = shellWith(() => slow.promise);
    const open = await screen.findByRole("button", { name: "History" });
    fireEvent.click(open);
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    f.history.mockRejectedValue(new Error("The workspace engine is not running."));
    fireEvent.click(open);
    await waitFor(() => expect(f.rows()).toHaveLength(1));
    await act(async () => {
      slow.resolve({ entries: [paidByRun], nextBeforeHistoryId: null });
      await slow.promise;
    });
    expect(f.rows()).toHaveLength(1);
    expect(screen.queryByText(/Paid:/)).toBeNull();
  });

  it("keeps the failure when another record's History reads", async () => {
    const f = shellWith(async (payload) => {
      if (payload.recordId === "rec-12") throw new Error("The workspace engine is not running.");
      return { entries: [paidByRun], nextBeforeHistoryId: null };
    });
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    await waitFor(() => expect(f.rows()).toHaveLength(1));
    act(() => f.shell().history.open({ collectionPath: "Invoices", recordId: "rec-13", recordName: "Invoice 13" }));
    await screen.findByText(/Paid:/);
    expect(f.rows()).toHaveLength(1);
  });

  it("closes History and drops its failure when the workspace changes", async () => {
    const slow = deferred<GetCollectionRecordHistoryResult>();
    const f = shellWith(() => slow.promise);
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    await screen.findByRole("dialog");
    f.rerender({ workspaceId: "ws-2", recordOpen: false });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      slow.reject(new Error("The workspace engine is not running."));
      await slow.promise.catch(() => undefined);
    });
    expect(f.shell().notices.shellErrors).toEqual([]);
    f.rerender({ workspaceId: "ws-1", recordOpen: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
