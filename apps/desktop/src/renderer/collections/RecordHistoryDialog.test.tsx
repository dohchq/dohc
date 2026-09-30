// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GetCollectionRecordHistoryPayload,
  GetCollectionRecordHistoryResult,
  RecordHistoryEntry,
} from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { RecordHistoryDialog, RUN_NOT_HERE, RUN_NOT_HERE_WHY, recordHistoryGroups } from "./RecordHistoryDialog";

const STAMP = "collection:tasks-id#stamp";

function entry(historyId: number, author: RecordHistoryEntry["author"], field = "Status"): RecordHistoryEntry {
  return {
    historyId, field, recordedAtMs: Date.now() - historyId * 1_000, author,
    previous: { present: true, value: "Open" }, next: { present: true, value: "Done" },
  };
}

function automation(name: string, run: { claimId: string; onThisComputer: boolean } | null): RecordHistoryEntry["author"] {
  return { kind: "automation", automationId: STAMP, name, run };
}

function stub(read: (payload: GetCollectionRecordHistoryPayload) => Promise<GetCollectionRecordHistoryResult>) {
  const bridge = { getCollectionRecordHistory: vi.fn(read) };
  vi.stubGlobal("dohcDesktop", bridge);
  return bridge;
}

function dialog(props: Partial<Parameters<typeof RecordHistoryDialog>[0]> = {}) {
  return (
    <RecordHistoryDialog
      workspaceId="ws-1" collectionPath="Tasks" recordId="rec_a" recordName="Plan the trip"
      onClose={() => undefined} onOpenRun={() => undefined} onError={() => undefined}
      {...props}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RecordHistoryDialog", () => {
  it("names an automation for its changes, one row per run, and opens the run this computer keeps", async () => {
    stub(async () => ({
      entries: [
        entry(9, automation("Stamp the finish date", { claimId: "claim-1", onThisComputer: true }), "Finished on"),
        entry(8, automation("Stamp the finish date", { claimId: "claim-1", onThisComputer: true })),
        entry(7, { kind: "agent", name: "Codex" }),
        entry(6, null),
      ],
      nextBeforeHistoryId: null,
    }));
    const onOpenRun = vi.fn();
    render(dialog({ onOpenRun }));
    const rows = await screen.findAllByTestId("record-history-entry");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Stamp the finish date");
    expect(rows[0]!.textContent).toContain("Finished on: Open → Done");
    expect(rows[0]!.textContent).toContain("Status: Open → Done");
    expect(rows[1]!.textContent).toContain("Codex");
    expect(within(rows[2]!).queryByRole("button")).toBeNull();
    // Every run is on this computer, so nothing explains a missing one.
    expect(screen.queryByTestId("record-history-run-not-here-why")).toBeNull();
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "View run" }));
    expect(onOpenRun).toHaveBeenCalledWith(STAMP, "claim-1", "Stamp the finish date");
  });

  it("keeps the author of a run this computer does not keep, and invents no run for an older change", async () => {
    stub(async () => ({
      entries: [
        entry(9, automation("Old name", { claimId: "claim-gone", onThisComputer: false })),
        entry(8, automation("Stamp the finish date", null)),
      ],
      nextBeforeHistoryId: null,
    }));
    render(dialog());
    const rows = await screen.findAllByTestId("record-history-entry");
    expect(rows[0]!.textContent).toContain("Old name");
    expect(within(rows[0]!).getByTestId("record-history-run-not-here").textContent).toBe(RUN_NOT_HERE);
    expect(rows[1]!.textContent).toContain("Stamp the finish date");
    expect(within(rows[1]!).queryByTestId("record-history-run-not-here")).toBeNull();
    expect(screen.queryByRole("button", { name: "View run" })).toBeNull();
    // Why shows as text, not only in a tooltip.
    expect(screen.getByTestId("record-history-run-not-here-why").textContent).toBe(RUN_NOT_HERE_WHY);
  });

  it("reads older changes after the page shown, and keeps the first page", async () => {
    const bridge = stub(async (payload) => payload.beforeHistoryId === undefined
      ? { entries: [entry(9, null)], nextBeforeHistoryId: 9 }
      : { entries: [entry(9, null), entry(4, null, "Owner")], nextBeforeHistoryId: null });
    render(dialog());
    fireEvent.click(await screen.findByRole("button", { name: "Older changes" }));
    await waitFor(() => expect(screen.getAllByTestId("record-history-entry")).toHaveLength(2));
    expect(bridge.getCollectionRecordHistory).toHaveBeenLastCalledWith({ workspaceId: "ws-1", collectionPath: "Tasks", recordId: "rec_a", beforeHistoryId: 9 });
    expect(screen.queryByRole("button", { name: "Older changes" })).toBeNull();
  });

  it("drops an answer for the record it showed before", async () => {
    const slow = deferred<GetCollectionRecordHistoryResult>();
    stub(async (payload) => payload.recordId === "rec_a"
      ? slow.promise
      : { entries: [entry(2, null, "Owner")], nextBeforeHistoryId: null });
    const { rerender } = render(dialog());
    rerender(dialog({ recordId: "rec_b", recordName: "Book flights" }));
    await screen.findByText(/Owner:/);
    slow.resolve({ entries: [entry(1, null, "Stale")], nextBeforeHistoryId: null });
    await slow.promise;
    await Promise.resolve();
    expect(screen.queryByText(/Stale:/)).toBeNull();
    expect(screen.getAllByTestId("record-history-entry")).toHaveLength(1);
  });

  it("drops an answer for the workspace it showed before", async () => {
    const slow = deferred<GetCollectionRecordHistoryResult>();
    stub(async (payload) => payload.workspaceId === "ws-1"
      ? slow.promise
      : { entries: [], nextBeforeHistoryId: null });
    const { rerender } = render(dialog());
    rerender(dialog({ workspaceId: "ws-2" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("No field of this record has changed yet."));
    slow.resolve({ entries: [entry(1, null, "Stale")], nextBeforeHistoryId: null });
    await slow.promise;
    await Promise.resolve();
    expect(screen.queryByText(/Stale:/)).toBeNull();
  });

  it("reports a failed read with Try again", async () => {
    const bridge = stub(async () => { throw new Error("The workspace engine is not running."); });
    const onError = vi.fn();
    render(dialog({ onError }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("dohc could not read this record's history.", expect.any(Error), expect.any(Function)));
    bridge.getCollectionRecordHistory.mockResolvedValue({ entries: [], nextBeforeHistoryId: null });
    (onError.mock.calls[0]![2] as () => void)();
    await screen.findByText("No field of this record has changed yet.");
  });

  it("says in the dialog that the read failed, and its own Try again leaves focus in the dialog", async () => {
    const bridge = stub(async () => { throw new Error("The workspace engine is not running."); });
    render(dialog());
    await screen.findByText("dohc could not read this record's history.");
    expect(screen.queryByText("Loading history…")).toBeNull();
    bridge.getCollectionRecordHistory.mockResolvedValue({ entries: [entry(2, null, "Owner")], nextBeforeHistoryId: null });
    const retry = screen.getByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);
    await screen.findByText(/Owner:/);
    expect(screen.queryByText("dohc could not read this record's history.")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("record-history"));
  });

  it("keeps one status line through loading and failure, and marks its Try again busy while it reads", async () => {
    const again = deferred<GetCollectionRecordHistoryResult>();
    const bridge = stub(async () => { throw new Error("The workspace engine is not running."); });
    render(dialog());
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Loading history…");
    await waitFor(() => expect(status.textContent).toBe("dohc could not read this record's history."));
    // The same element, so a screen reader hears the change.
    expect(screen.getByRole("status")).toBe(status);
    bridge.getCollectionRecordHistory.mockImplementation(() => again.promise);
    const retry = screen.getByRole("button", { name: "Try again" });
    fireEvent.click(retry);
    await waitFor(() => expect(retry.getAttribute("aria-busy")).toBe("true"));
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(retry);
    expect(bridge.getCollectionRecordHistory).toHaveBeenCalledTimes(2);
    again.resolve({ entries: [entry(2, null, "Owner")], nextBeforeHistoryId: null });
    await screen.findByText(/Owner:/);
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("");
  });

  it("says in the dialog when older changes could not be read, and reads that page again from its Try again", async () => {
    const onError = vi.fn();
    const bridge = stub(async (payload) => {
      if (payload.beforeHistoryId === undefined) return { entries: [entry(9, null)], nextBeforeHistoryId: 9 };
      throw new Error("The workspace engine is not running.");
    });
    render(dialog({ onError }));
    const older = await screen.findByRole("button", { name: "Older changes" });
    older.focus();
    fireEvent.click(older);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("dohc could not read this record's history."));
    expect(onError).toHaveBeenCalledTimes(1);
    // Try again takes the place of Older changes, and focus with it.
    expect(screen.queryByRole("button", { name: "Older changes" })).toBeNull();
    const retry = screen.getByRole("button", { name: "Try again" });
    await waitFor(() => expect(document.activeElement).toBe(retry));
    bridge.getCollectionRecordHistory.mockImplementation(async () => ({ entries: [entry(4, null, "Owner")], nextBeforeHistoryId: null }));
    fireEvent.click(retry);
    await screen.findByText(/Owner:/);
    expect(bridge.getCollectionRecordHistory).toHaveBeenLastCalledWith({ workspaceId: "ws-1", collectionPath: "Tasks", recordId: "rec_a", beforeHistoryId: 9 });
    expect(screen.getAllByTestId("record-history-entry")).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getByTestId("record-history"));
  });

  it("keeps focus on Older changes while it reads, and gives it to the dialog when no older change is left", async () => {
    const older = deferred<GetCollectionRecordHistoryResult>();
    stub(async (payload) => payload.beforeHistoryId === undefined
      ? { entries: [entry(9, null)], nextBeforeHistoryId: 9 }
      : older.promise);
    render(dialog());
    const button = await screen.findByRole("button", { name: "Older changes" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button);
    older.resolve({ entries: [entry(4, null, "Owner")], nextBeforeHistoryId: null });
    await screen.findByText(/Owner:/);
    expect(document.activeElement).toBe(screen.getByTestId("record-history"));
  });

  it("starts nothing from a Try again kept from the record it showed before", async () => {
    const bridge = stub(async (payload) => {
      if (payload.recordId === "rec_a") throw new Error("The workspace engine is not running.");
      return { entries: [entry(2, null, "Owner")], nextBeforeHistoryId: null };
    });
    const onError = vi.fn();
    const { rerender } = render(dialog({ onError }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    rerender(dialog({ onError, recordId: "rec_b", recordName: "Book flights" }));
    // The failure was the other record's.
    expect(screen.queryByText("dohc could not read this record's history.")).toBeNull();
    await screen.findByText(/Owner:/);
    const reads = bridge.getCollectionRecordHistory.mock.calls.length;
    (onError.mock.calls[0]![2] as () => void)();
    expect(bridge.getCollectionRecordHistory).toHaveBeenCalledTimes(reads);
    expect(screen.getAllByTestId("record-history-entry")).toHaveLength(1);
  });

  it("groups only consecutive changes from one run", () => {
    const run = automation("Stamp", { claimId: "claim-1", onThisComputer: true });
    const other = automation("Stamp", { claimId: "claim-2", onThisComputer: true });
    const groups = recordHistoryGroups([entry(5, run), entry(4, run), entry(3, other), entry(2, run), entry(1, automation("Stamp", null)), entry(0, automation("Stamp", null))]);
    expect(groups.map((group) => group.changes.map((change) => change.historyId))).toEqual([[5, 4], [3], [2], [1], [0]]);
  });
});
