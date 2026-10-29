// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionRecord } from "@dohc/workspace-contracts";
import userEvent from "@testing-library/user-event";
import type { AutomationButtonState } from "@dohc/automation-executor/automation-buttons";
import type {
  AutomationRunSettledEvent, GetCollectionRecordHistoryPayload, GetCollectionRecordHistoryResult, ListAutomationButtonsResult,
  ListRecordButtonsResult, LocateRecordHistoryRunPayload, LocateRecordHistoryRunResult, PressAutomationButtonResult,
  RecordHistoryEntry, WorkspaceActivityEvent,
} from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { useShellError } from "../shell/useShellError";
import { RecordButtonsRow } from "./RecordButtonsRow";
import { RecordHistoryDialog } from "./RecordHistoryDialog";
import { RUN_NOT_CHECKED, useRecordHistory } from "./useRecordHistory";
import { automationButtonsFor, disposeAutomationButtons, resetAutomationButtonsForTests } from "./useAutomationButtons";

// The shell opens the ⚡ panel at a run; these tests open none.
const noRun = async () => null;
const FAILED = "dohc could not read this record's history.";

const invoice: CollectionRecord = {
  id: "rec-12", path: "Invoices/12.md", conflicted: false,
  values: [{ field: "title", value: "Invoice 12", validation: { status: "valid" }, resolvedRelations: [] }],
};

type Button = { field: string; state: AutomationButtonState };

/** Main's answers: the record the file is, and what its Collection's buttons do. */
function stub(answer: { record: null } | { record: CollectionRecord; collectionPath: string; buttons: Button[] }) {
  const activity = new Set<(event: WorkspaceActivityEvent) => void>();
  const settled = new Set<(event: AutomationRunSettledEvent) => void>();
  const changed = new Set<(event: { workspaceId: string }) => void>();
  const listed = (buttons: Button[]): ListAutomationButtonsResult => ({ buttons: buttons.map((button) => ({ ...button, table: null })) });
  const bridge = {
    listRecordButtons: vi.fn(async (): Promise<ListRecordButtonsResult> => answer.record === null ? answer
      : { record: answer.record, collectionPath: answer.collectionPath, fields: answer.buttons.map((button) => button.field) }),
    listAutomationButtons: vi.fn(async () => listed(answer.record === null ? [] : answer.buttons)),
    pressAutomationButton: vi.fn(async (): Promise<PressAutomationButtonResult> => ({ busy: false, claimId: "atc_press", settled: null })),
    onWorkspaceActivity: vi.fn((listener: (event: WorkspaceActivityEvent) => void) => {
      activity.add(listener);
      return () => activity.delete(listener);
    }),
    onAutomationRunSettled: vi.fn((listener: (event: AutomationRunSettledEvent) => void) => {
      settled.add(listener);
      return () => settled.delete(listener);
    }),
    onAutomationRunWaiting: vi.fn(() => () => undefined),
    onCollectionAutomationsChanged: vi.fn((listener: (event: { workspaceId: string }) => void) => {
      changed.add(listener);
      return () => changed.delete(listener);
    }),
    emitChanged: (event: { workspaceId: string }) => { for (const listener of [...changed]) listener(event); },
    emitActivity: (event: WorkspaceActivityEvent) => { for (const listener of [...activity]) listener(event); },
    emitSettled: (event: AutomationRunSettledEvent) => { for (const listener of [...settled]) listener(event); },
    listed,
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
    bridge.pressAutomationButton.mockResolvedValueOnce({ busy: true, reason: "Running for this record." });
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
    bridge.listAutomationButtons.mockResolvedValue(bridge.listed(
      [{ field: "Mark paid", state: { kind: "ready", automationId: "collection:Invoices#paid", irreversible: [{ name: "invoices.settle", label: "Settle" }, { name: "invoices.refund", label: "Refund" }] } }],
    ));
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

  it("tells the view which record the file is, or that it is none", async () => {
    stub({ record: invoice, collectionPath: "Invoices", buttons: [] });
    const onRecord = vi.fn();
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={() => undefined} onNotice={() => undefined} onOpenHistory={() => undefined} onRecord={onRecord} />);
    await waitFor(() => expect(onRecord).toHaveBeenLastCalledWith({ workspaceId: "ws-1", path: "Invoices/12.md", id: "rec-12" }));
    cleanup();

    stub({ record: null });
    const none = vi.fn();
    render(<RecordButtonsRow workspaceId="ws-1" path="Notes/todo.md" onError={() => undefined} onNotice={() => undefined} onOpenHistory={() => undefined} onRecord={none} />);
    await waitFor(() => expect(none).toHaveBeenLastCalledWith(null));
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

  it("reads what its buttons do again when the Collection's automations change, not when the record is saved", async () => {
    const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [{ field: "Mark paid", state: { kind: "ready", automationId: "collection:Invoices#paid" } }] });
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={() => undefined} onNotice={() => undefined} onOpenHistory={() => undefined} />);
    await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(1));
    act(() => bridge.emitActivity({ workspaceId: "ws-1", paths: ["Invoices/12.md"] } as WorkspaceActivityEvent));
    await waitFor(() => expect(bridge.listRecordButtons).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(1);
    act(() => bridge.emitActivity({ workspaceId: "ws-1", paths: ["Invoices/automations.yaml"] } as WorkspaceActivityEvent));
    await waitFor(() => expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(2));
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

  it("shows and reports nothing while the workspace's files are still being read, then reads again when main says the read finished", async () => {
    const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [{ field: "Mark paid", state: { kind: "ready", automationId: "collection:Invoices#paid" } }] });
    const updating = () => new Error(
      "Error invoking remote method 'desktop:list-record-buttons': DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
    );
    const opened = deferred<ListRecordButtonsResult>();
    const pinged = deferred<ListRecordButtonsResult>();
    bridge.listRecordButtons.mockReturnValueOnce(opened.promise).mockReturnValueOnce(pinged.promise);
    const onError = vi.fn();
    const { container } = render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={onError} onNotice={() => undefined} onOpenHistory={() => undefined} />);
    await act(async () => opened.reject(updating()));
    // A capture ping during the import reads while the engine still refuses.
    // The engine sheds the pings after it from a full queue, so none arrive.
    act(() => bridge.emitActivity({ workspaceId: "ws-1", pathSetChanged: false }));
    await act(async () => pinged.reject(updating()));
    expect(container.innerHTML).toBe("");
    expect(onError).not.toHaveBeenCalled();
    // What main sends for the engine's retained capture.initialSettled.
    act(() => bridge.emitActivity({ workspaceId: "ws-1", pathSetChanged: false }));
    await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    expect(bridge.listRecordButtons).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();
  });
});

// What main says about a shared view's buttons, from the computer that runs the owner's automations.
const UNCHECKED = "dohc cannot check this button now. Try again when its host is available.";
const CHECKING_BUTTON = "dohc is checking whether you can use this button.";
const BUTTON_NOT_CHECKED = "dohc could not check this button.";
const DENIED = "This button cannot use the requested Collection or operations.";
const READY: AutomationButtonState = { kind: "ready", automationId: "collection:Invoices#paid" };
const CHECKING: AutomationButtonState = { kind: "checking", reason: CHECKING_BUTTON };
const row = (onError = vi.fn(), onNotice = vi.fn()) => (
  <RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={onError} onNotice={onNotice} onOpenHistory={() => undefined} />
);
const wordsOf = (control: HTMLElement) => document.getElementById(control.getAttribute("aria-describedby") ?? "")?.textContent ?? null;
const checkAgain = () => screen.queryByRole("button", { name: "Check Mark paid for Invoice 12 again" });
// The mark beside a checking or running button's name.
const loaderIn = (button: HTMLElement) => button.querySelector("svg.lucide-loader-circle");

describe("RecordButtonsRow in an Edit share view", () => {
  it("shows the record at once, and its button as checking until main answers", async () => {
    const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [{ field: "Mark paid", state: READY }] });
    const answer = deferred<ListAutomationButtonsResult>();
    bridge.listAutomationButtons.mockReturnValueOnce(answer.promise);
    render(row());
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    expect(screen.getByRole("button", { name: "History" })).toBeTruthy();
    await waitFor(() => expect(bridge.listAutomationButtons).toHaveBeenCalledWith({ workspaceId: "ws-1", collectionPath: "Invoices" }));
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(wordsOf(button)).toBe(CHECKING_BUTTON);
    // dohc is already checking, so there is nothing to check again.
    expect(checkAgain()).toBeNull();
    fireEvent.click(button);
    expect(bridge.pressAutomationButton).not.toHaveBeenCalled();
    await act(async () => answer.resolve(bridge.listed([{ field: "Mark paid", state: READY }])));
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });

  it("says dohc cannot check a button now, and Check again from the keyboard reads again and gives focus back", async () => {
    const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [{ field: "Mark paid", state: { kind: "unchecked", reason: UNCHECKED } }] });
    const user = userEvent.setup();
    render(row());
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(checkAgain()).not.toBeNull());
    const again = checkAgain()!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(wordsOf(button)).toBe(UNCHECKED);
    expect(wordsOf(again)).toBe(UNCHECKED);
    await user.click(button);
    expect(bridge.pressAutomationButton).not.toHaveBeenCalled();
    act(() => button.focus());
    await user.tab();
    expect(document.activeElement).toBe(again);
    expect(document.getElementById(again.getAttribute("aria-describedby")!)!.hidden).toBe(false);
    const answer = deferred<ListAutomationButtonsResult>();
    bridge.listAutomationButtons.mockReturnValueOnce(answer.promise);
    await user.keyboard("{Enter}");
    // Check again asks the host, past main's last answer.
    expect(bridge.listAutomationButtons).toHaveBeenLastCalledWith({ workspaceId: "ws-1", collectionPath: "Invoices", check: true });
    expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(2);
    // It stays while main answers, so focus stays, and it asks nothing more.
    expect(again.getAttribute("aria-disabled")).toBe("true");
    expect(wordsOf(button)).toBe(CHECKING_BUTTON);
    await user.keyboard("{Enter}");
    expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(2);
    // Main says the host is being asked: Check again goes, and focus moves to the button.
    await act(async () => answer.resolve(bridge.listed([{ field: "Mark paid", state: CHECKING }])));
    expect(checkAgain()).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(wordsOf(button)).toBe(CHECKING_BUTTON);
    expect(loaderIn(button)).not.toBeNull();
    bridge.listAutomationButtons.mockResolvedValue(bridge.listed([{ field: "Mark paid", state: READY }]));
    act(() => bridge.emitChanged({ workspaceId: "ws-1" }));
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    expect(loaderIn(button)).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(bridge.pressAutomationButton).toHaveBeenCalledTimes(1));
  });

  it("shows Check again's words only for keyboard focus, closes them on Escape, and keeps Escape inside", async () => {
    const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [{ field: "Mark paid", state: { kind: "unchecked", reason: UNCHECKED } }] });
    const outer = vi.fn();
    render(<div onKeyDown={outer}>{row()}</div>);
    await waitFor(() => expect(checkAgain()).not.toBeNull());
    const again = checkAgain()!;
    const words = document.getElementById(again.getAttribute("aria-describedby")!)!;
    // Focus that a click gives shows nothing.
    fireEvent.pointerDown(again);
    fireEvent.focus(again);
    expect(words.hidden).toBe(true);
    fireEvent.blur(again);
    fireEvent.focus(again);
    expect(words.hidden).toBe(false);
    fireEvent.keyDown(again, { key: "Escape" });
    expect(words.hidden).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    // While main answers, it looks as inert as it is.
    expect(again.className).toContain("aria-disabled:hover:bg-transparent");
    expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(1);
  });

  it("shows checking while the host is asked, and reads again when main says it answered, for this workspace only", async () => {
    const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [{ field: "Mark paid", state: CHECKING }] });
    const view = render(row());
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(loaderIn(button)).not.toBeNull());
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(wordsOf(button)).toBe(CHECKING_BUTTON);
    expect(checkAgain()).toBeNull();
    // The mark turns only where motion is allowed, so with reduced motion it stays still beside the words.
    const mark = loaderIn(button)!.getAttribute("class")!.split(/\s+/);
    expect(mark).toContain("animate-spin");
    expect(mark).not.toContain("motion-safe:animate-spin");
    bridge.listAutomationButtons.mockResolvedValue(bridge.listed([{ field: "Mark paid", state: READY }]));
    act(() => bridge.emitChanged({ workspaceId: "ws-2" }));
    expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(1);
    act(() => bridge.emitChanged({ workspaceId: "ws-1" }));
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(2);
    expect(loaderIn(button)).toBeNull();
    // A store nothing shows reads when it next shows, not on every change.
    view.unmount();
    act(() => bridge.emitChanged({ workspaceId: "ws-1" }));
    expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(2);
    const store = automationButtonsFor("ws-1", { collectionPath: "Invoices" });
    const stop = store.subscribe(store.key("Mark paid", "rec-12"), () => undefined);
    expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(3);
    stop();
    await act(async () => undefined);
    // A closed workspace's store hears nothing.
    act(() => disposeAutomationButtons("ws-1"));
    store.subscribe(store.key("Mark paid", "rec-12"), () => undefined);
    act(() => bridge.emitChanged({ workspaceId: "ws-1" }));
    expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["the host refuses what it needs", DENIED],
    ["the person holds a link", "Only people who can edit Invoices can use this button."],
  ])("says why a button cannot run when %s, offers no Check again, and runs nothing", async (_case, reason) => {
    const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [{ field: "Mark paid", state: { kind: "disabled", reason } }] });
    render(row());
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(wordsOf(button)).toBe(reason));
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(checkAgain()).toBeNull();
    fireEvent.click(button);
    expect(bridge.pressAutomationButton).not.toHaveBeenCalled();
  });

  it("asks before actions dohc cannot undo, sends the confirmed names, and leaves the notice of a relayed press to its host", async () => {
    const send = "00000000-0000-4000-8000-000000000001/sendInvoice";
    const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [{ field: "Mark paid", state: { ...READY, irreversible: [{ name: send, label: "Send invoice" }] } }] });
    bridge.pressAutomationButton.mockResolvedValue({ busy: false, relayed: true });
    const onError = vi.fn(), onNotice = vi.fn();
    render(row(onError, onNotice));
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Run Mark paid for Invoice 12" }).textContent).toContain("Send invoice can't be undone.");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(bridge.pressAutomationButton).toHaveBeenCalledWith(expect.objectContaining({ collectionPath: "Invoices", recordId: "rec-12", confirmed: [send] })));
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
    // The owner's computer runs it and files its one notice, so this view reports nothing.
    expect(onNotice).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    // A press the host refuses when pressed files one notice, with Try again.
    bridge.pressAutomationButton.mockRejectedValueOnce(new Error(UNCHECKED));
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith("Mark paid did not start.", new Error(UNCHECKED), expect.any(Function));
  });

  it("files one notice for a failed read, and the button says dohc could not check it until Check again reads", async () => {
    const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [{ field: "Mark paid", state: READY }] });
    bridge.listAutomationButtons.mockRejectedValueOnce(new Error("The workspace engine is not running."));
    const onError = vi.fn();
    render(row(onError));
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(checkAgain()).not.toBeNull());
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("dohc could not read this Collection's buttons.", expect.any(Error), expect.any(Function));
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(wordsOf(button)).toBe(BUTTON_NOT_CHECKED);
    fireEvent.click(checkAgain()!);
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    expect(checkAgain()).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("keeps the newest answer when an older read lands late, and reads nothing for a closed workspace", async () => {
    const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [{ field: "Mark paid", state: { kind: "unchecked", reason: UNCHECKED } }] });
    const onError = vi.fn();
    render(row(onError));
    const button = await screen.findByRole("button", { name: "Mark paid for Invoice 12" });
    await waitFor(() => expect(checkAgain()).not.toBeNull());
    const older = deferred<ListAutomationButtonsResult>(), newer = deferred<ListAutomationButtonsResult>();
    bridge.listAutomationButtons.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    fireEvent.click(checkAgain()!);
    // The host answered while that read was out, so the store reads again.
    act(() => bridge.emitChanged({ workspaceId: "ws-1" }));
    expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(3);
    await act(async () => newer.resolve(bridge.listed([{ field: "Mark paid", state: READY }])));
    expect(button.getAttribute("aria-disabled")).toBeNull();
    await act(async () => older.resolve(bridge.listed([{ field: "Mark paid", state: { kind: "unchecked", reason: UNCHECKED } }])));
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(checkAgain()).toBeNull();
    const late = deferred<ListAutomationButtonsResult>();
    bridge.listAutomationButtons.mockReturnValueOnce(late.promise);
    act(() => bridge.emitChanged({ workspaceId: "ws-1" }));
    expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(4);
    const store = automationButtonsFor("ws-1", { collectionPath: "Invoices" });
    act(() => disposeAutomationButtons("ws-1"));
    await act(async () => late.resolve(bridge.listed([{ field: "Mark paid", state: { kind: "disabled", reason: DENIED } }])));
    expect(store.states()?.get("Mark paid")).toEqual(READY);
    // A closed workspace's store asks main nothing more.
    await store.refresh();
    expect(bridge.listAutomationButtons).toHaveBeenCalledTimes(4);
    expect(onError).not.toHaveBeenCalled();
  });
});

const paidByRun: RecordHistoryEntry = {
  historyId: 3, field: "Paid", previous: { present: false, value: null }, next: { present: true, value: true }, recordedAtMs: Date.now(),
  author: { kind: "automation", automationId: "collection:invoices-id#paid", name: "Mark paid", run: { claimId: "atc_1", location: "available" } },
};

// The shell's part: its Notices, the History it holds, and the record view.
function shellWith(
  read: (payload: GetCollectionRecordHistoryPayload) => Promise<GetCollectionRecordHistoryResult>,
  openRun: (automationId: string, claimId: string, name: string) => Promise<string | null> = noRun,
  locateRun: (payload: LocateRecordHistoryRunPayload) => Promise<LocateRecordHistoryRunResult> = async () => ({ location: "unavailable" }),
) {
  const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [] });
  const history = vi.fn(read);
  const locate = vi.fn(locateRun);
  Object.assign(bridge, { getCollectionRecordHistory: history, locateRecordHistoryRun: locate });
  let shell!: { notices: ReturnType<typeof useShellError>; history: ReturnType<typeof useRecordHistory> };
  function Shell(props: { workspaceId: string; recordOpen: boolean }) {
    const notices = useShellError(props.workspaceId);
    const recordHistory = useRecordHistory(props.workspaceId, { reportShellError: notices.reportShellError, clearKind: notices.clearKind, openAutomationRun: openRun });
    shell = { notices, history: recordHistory };
    const session = recordHistory.session;
    return (
      <>
        {props.recordOpen ? (
          <RecordButtonsRow workspaceId={props.workspaceId} path="Invoices/12.md" onError={notices.reportButtonError} onNotice={() => undefined} onOpenHistory={recordHistory.open} />
        ) : null}
        {session ? (
          <RecordHistoryDialog
            key={session.key} workspaceId={props.workspaceId} collectionPath={session.target.collectionPath} recordId={session.target.recordId}
            recordName={session.target.recordName} until={session.until} onClose={recordHistory.close} onOpenRun={recordHistory.openRun}
            onFailed={recordHistory.failed} onRead={recordHistory.read}
            onRunsUnchecked={recordHistory.runsUnchecked} onRunsChecked={recordHistory.runsChecked}
          />
        ) : null}
      </>
    );
  }
  const view = render(<Shell workspaceId="ws-1" recordOpen />);
  return {
    history,
    locate,
    shell: () => shell,
    rows: () => shell.notices.shellErrors.filter((error) => error.kind === "record-history"),
    runRows: () => shell.notices.shellErrors.filter((error) => error.kind === "record-history-run"),
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

  it("reports a run dohc could not check with Try again, and clears it once the server shows the run", async () => {
    const unplaced: RecordHistoryEntry = {
      ...paidByRun, author: { kind: "automation", automationId: "collection:invoices-id#paid", name: "Mark paid", run: { claimId: "atc_1", location: "unchecked" } },
    };
    const f = shellWith(async () => ({ entries: [unplaced], nextBeforeHistoryId: null }), noRun, async () => { throw new Error("offline"); });
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    await waitFor(() => expect(f.runRows().map((row) => [row.message.startsWith(RUN_NOT_CHECKED), row.seen, row.retry !== null])).toEqual([[true, false, true]]));
    expect(screen.queryByRole("button", { name: "View run" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    f.locate.mockResolvedValue({ location: "available" });
    act(() => f.shell().notices.retryShellError(f.runRows()[0]!.id));
    const dialog = await screen.findByRole("dialog", { name: "History of Invoice 12" });
    expect(await within(dialog).findByRole("button", { name: "View run" })).toBeTruthy();
    await waitFor(() => expect(f.runRows()).toEqual([]));
  });

  it("keeps a run's row until a History of that record checks that run, and reads back to its page", async () => {
    const olderRun: RecordHistoryEntry = {
      ...paidByRun, historyId: 1, author: { kind: "automation", automationId: "collection:invoices-id#paid", name: "Mark paid", run: { claimId: "atc_old", location: "unchecked" } },
    };
    const f = shellWith(async (payload) => payload.beforeHistoryId === undefined
      ? { entries: [paidByRun], nextBeforeHistoryId: 3 }
      : { entries: [olderRun], nextBeforeHistoryId: null }, noRun, async () => { throw new Error("offline"); });
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: "Older changes" }));
    await waitFor(() => expect(f.runRows()).toHaveLength(1));
    fireEvent.keyDown(document, { key: "Escape" });

    // Opened again, the first page's runs all settle, but the older run is still unchecked.
    f.locate.mockResolvedValue({ location: "unavailable" });
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const dialog = await screen.findByRole("dialog", { name: "History of Invoice 12" });
    expect(await within(dialog).findByRole("button", { name: "View run" })).toBeTruthy();
    await act(async () => undefined);
    expect(f.runRows()).toHaveLength(1);

    f.history.mockClear();
    act(() => f.shell().notices.retryShellError(f.runRows()[0]!.id));
    await within(await screen.findByRole("dialog", { name: "History of Invoice 12" })).findByTestId("record-history-run-not-here");
    expect(f.history.mock.calls.map(([payload]) => payload.beforeHistoryId)).toEqual([undefined, 3]);
    await waitFor(() => expect(f.runRows()).toEqual([]));
  });

  it("keeps reading back to the oldest page a run could not be checked on", async () => {
    const run = (historyId: number, claimId: string): RecordHistoryEntry => ({
      ...paidByRun, historyId, author: { kind: "automation", automationId: "collection:invoices-id#paid", name: "Mark paid", run: { claimId, location: "unchecked" } },
    });
    let newerFails = false;
    const f = shellWith(async (payload) => payload.beforeHistoryId === undefined
      ? { entries: [run(3, "atc_new")], nextBeforeHistoryId: 3 }
      : { entries: [run(1, "atc_old")], nextBeforeHistoryId: null }, noRun, async ({ claimId }) => {
      if (claimId === "atc_old" || newerFails) throw new Error("offline");
      return { location: "unavailable" };
    });
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: "Older changes" }));
    await waitFor(() => expect(f.runRows()).toHaveLength(1));
    fireEvent.keyDown(document, { key: "Escape" });
    // Opened again, a first-page run fails too; Try again must still reach the older page.
    newerFails = true;
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await waitFor(() => expect(f.locate.mock.calls.filter(([payload]) => payload.claimId === "atc_new")).toHaveLength(2));
    await act(async () => undefined);
    f.history.mockClear();
    act(() => f.shell().notices.retryShellError(f.runRows()[0]!.id));
    await screen.findByRole("dialog", { name: "History of Invoice 12" });
    await waitFor(() => expect(f.history.mock.calls.map(([payload]) => payload.beforeHistoryId)).toEqual([undefined, 3]));
  });

  it("clears a recovered read's row and keeps saying a run could not be checked", async () => {
    const unplaced: RecordHistoryEntry = {
      ...paidByRun, author: { kind: "automation", automationId: "collection:invoices-id#paid", name: "Mark paid", run: { claimId: "atc_1", location: "unchecked" } },
    };
    const f = shellWith(async (payload) => {
      if (payload.beforeHistoryId === undefined) return { entries: [unplaced], nextBeforeHistoryId: 3 };
      throw new Error("The workspace engine is not running.");
    }, noRun, async () => { throw new Error("offline"); });
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    await waitFor(() => expect(f.runRows()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Older changes" }));
    await waitFor(() => expect(f.rows()).toHaveLength(1));
    f.history.mockResolvedValue({ entries: [{ ...paidByRun, historyId: 1, field: "Owner", author: null }], nextBeforeHistoryId: null });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Try again" }));
    await screen.findByText(/Owner:/);
    await waitFor(() => expect(f.rows()).toEqual([]));
    expect(f.runRows().map((row) => row.message.startsWith(RUN_NOT_CHECKED))).toEqual([true]);
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
