// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionRecord } from "@dohc/workspace-contracts";
import type {
  AutomationRunSettledEvent, GetCollectionRecordHistoryPayload, GetCollectionRecordHistoryResult, ListRecordButtonsResult, WorkspaceActivityEvent,
} from "../../ipc/bridgeContract";
import { RecordButtonsRow } from "./RecordButtonsRow";
import { resetAutomationButtonsForTests } from "./useAutomationButtons";

// The shell opens the ⚡ panel at a run; these tests open none.
const noRun = async () => null;

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
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={() => undefined} onNotice={onNotice} onOpenAutomationRun={noRun} />);
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
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={() => undefined} onNotice={() => undefined} onOpenAutomationRun={noRun} />);
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
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={() => undefined} onNotice={() => undefined} onOpenAutomationRun={noRun} />);
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
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={() => undefined} onNotice={() => undefined} onOpenAutomationRun={noRun} />);
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
    const { container } = render(<RecordButtonsRow workspaceId="ws-1" path="Notes/todo.md" onError={() => undefined} onNotice={() => undefined} onOpenAutomationRun={noRun} />);
    await waitFor(() => expect(bridge.listRecordButtons).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("offers History for a record without buttons, reads it only when opened, and opens a run from it", async () => {
    const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [] });
    const history = vi.fn(async (_payload: GetCollectionRecordHistoryPayload): Promise<GetCollectionRecordHistoryResult> => ({
      entries: [{
        historyId: 3, field: "Paid", previous: { present: false, value: null }, next: { present: true, value: true }, recordedAtMs: Date.now(),
        author: { kind: "automation", automationId: "collection:invoices-id#paid", name: "Mark paid", run: { claimId: "atc_1", onThisComputer: true } },
      }],
      nextBeforeHistoryId: null,
    }));
    Object.assign(bridge, { getCollectionRecordHistory: history });
    const openRun = vi.fn(async (_automationId: string, _claimId: string, _name: string) => null);
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={() => undefined} onNotice={() => undefined} onOpenAutomationRun={openRun} />);
    const open = await screen.findByRole("button", { name: "History" });
    expect(screen.queryByRole("button", { name: /Mark paid/ })).toBeNull();
    expect(history).not.toHaveBeenCalled();
    fireEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "History of Invoice 12" });
    expect(history).toHaveBeenCalledWith({ workspaceId: "ws-1", collectionPath: "Invoices", recordId: "rec-12" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "View run" }));
    // The name travels too, so the panel's title is right before it reads the file.
    expect(openRun).toHaveBeenCalledWith("collection:invoices-id#paid", "atc_1", "Mark paid");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gives focus back to History when its dialog closes", async () => {
    const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [] });
    Object.assign(bridge, { getCollectionRecordHistory: vi.fn(async () => ({ entries: [], nextBeforeHistoryId: null })) });
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={() => undefined} onNotice={() => undefined} onOpenAutomationRun={noRun} />);
    const open = await screen.findByRole("button", { name: "History" });
    fireEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "History of Invoice 12" });
    await within(dialog).findByText("No field of this record has changed yet.");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it("reports a run the shell cannot open", async () => {
    const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [] });
    Object.assign(bridge, { getCollectionRecordHistory: vi.fn(async (): Promise<GetCollectionRecordHistoryResult> => ({
      entries: [{
        historyId: 3, field: "Paid", previous: { present: false, value: null }, next: { present: true, value: true }, recordedAtMs: Date.now(),
        author: { kind: "automation", automationId: "collection:invoices-id#paid", name: "Mark paid", run: { claimId: "atc_1", onThisComputer: true } },
      }],
      nextBeforeHistoryId: null,
    })) });
    const onError = vi.fn();
    const note = "dohc cannot find this automation's Collection on this computer.";
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={onError} onNotice={() => undefined} onOpenAutomationRun={async () => note} />);
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: "View run" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(note, expect.any(Error), null));
  });

  it("reads again when the record or its Collection's automations change, and not for other files", async () => {
    const bridge = stub({ record: invoice, collectionPath: "Invoices", buttons: [] });
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/2026/12.md" onError={() => undefined} onNotice={() => undefined} onOpenAutomationRun={noRun} />);
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
    render(<RecordButtonsRow workspaceId="ws-1" path="Invoices/12.md" onError={onError} onNotice={() => undefined} onOpenAutomationRun={noRun} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("dohc could not read this record's buttons.", expect.any(Error), expect.any(Function)));
    act(() => (onError.mock.calls[0]![2] as () => void)());
    await waitFor(() => expect(bridge.listRecordButtons).toHaveBeenCalledTimes(2));
  });
});
