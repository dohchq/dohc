// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GetCollectionRecordHistoryPayload,
  GetCollectionRecordHistoryResult,
  LocateRecordHistoryRunPayload,
  LocateRecordHistoryRunResult,
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

function automation(name: string, run: { claimId: string; location: "available" | "unchecked" } | null, automationId = STAMP): RecordHistoryEntry["author"] {
  return { kind: "automation", automationId, name, run };
}

function stub(
  read: (payload: GetCollectionRecordHistoryPayload) => Promise<GetCollectionRecordHistoryResult>,
  locate: (payload: LocateRecordHistoryRunPayload) => Promise<LocateRecordHistoryRunResult> = async () => ({ location: "unavailable" }),
) {
  const bridge = { getCollectionRecordHistory: vi.fn(read), locateRecordHistoryRun: vi.fn(locate) };
  vi.stubGlobal("dohcDesktop", bridge);
  return bridge;
}

function dialog(props: Partial<Parameters<typeof RecordHistoryDialog>[0]> = {}) {
  return (
    <RecordHistoryDialog
      workspaceId="ws-1" collectionPath="Tasks" recordId="rec_a" recordName="Plan the trip"
      onClose={() => undefined} onOpenRun={() => undefined} onFailed={() => undefined} onRead={() => undefined}
      onRunsUnchecked={() => undefined} onRunsChecked={() => undefined}
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
    const bridge = stub(async () => ({
      entries: [
        entry(9, automation("Stamp the finish date", { claimId: "claim-1", location: "available" }), "Finished on"),
        entry(8, automation("Stamp the finish date", { claimId: "claim-1", location: "available" })),
        entry(7, { kind: "agent", name: "Codex" }),
        entry(6, null),
      ],
      nextBeforeHistoryId: null,
    }));
    const onOpenRun = vi.fn();
    const onRunsChecked = vi.fn();
    render(dialog({ onOpenRun, onRunsChecked }));
    const rows = await screen.findAllByTestId("record-history-entry");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Stamp the finish date");
    expect(rows[0]!.textContent).toContain("Finished on: Open → Done");
    expect(rows[0]!.textContent).toContain("Status: Open → Done");
    expect(rows[1]!.textContent).toContain("Codex");
    expect(within(rows[2]!).queryByRole("button")).toBeNull();
    // Every run is on this computer, so nothing explains a missing one, and nothing asks the server.
    expect(screen.queryByTestId("record-history-run-not-here-why")).toBeNull();
    expect(bridge.locateRecordHistoryRun).not.toHaveBeenCalled();
    await waitFor(() => expect(onRunsChecked).toHaveBeenCalled());
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "View run" }));
    expect(onOpenRun).toHaveBeenCalledWith(STAMP, "claim-1", "Stamp the finish date");
  });

  it("keeps the author of a run nobody shows this person, and invents no run for an older change", async () => {
    stub(async () => ({
      entries: [
        entry(9, automation("Old name", { claimId: "claim-gone", location: "unchecked" })),
        entry(8, automation("Stamp the finish date", null)),
      ],
      nextBeforeHistoryId: null,
    }));
    render(dialog());
    const rows = await screen.findAllByTestId("record-history-entry");
    expect(rows[0]!.textContent).toContain("Old name");
    expect((await within(rows[0]!).findByTestId("record-history-run-not-here")).textContent).toBe(RUN_NOT_HERE);
    expect(rows[1]!.textContent).toContain("Stamp the finish date");
    expect(within(rows[1]!).queryByTestId("record-history-run-not-here")).toBeNull();
    expect(screen.queryByRole("button", { name: "View run" })).toBeNull();
    // Why shows as text, not only in a tooltip.
    expect(screen.getByTestId("record-history-run-not-here-why").textContent).toBe(RUN_NOT_HERE_WHY);
  });

  it("shows the page before the server answers, then opens a run the server keeps", async () => {
    const answer = deferred<LocateRecordHistoryRunResult>();
    const bridge = stub(
      async () => ({ entries: [entry(9, automation("Stamp", { claimId: "claim-server", location: "unchecked" }))], nextBeforeHistoryId: null }),
      () => answer.promise,
    );
    const onOpenRun = vi.fn();
    const onRunsChecked = vi.fn();
    render(dialog({ onOpenRun, onRunsChecked }));
    const [row] = await screen.findAllByTestId("record-history-entry");
    expect(bridge.locateRecordHistoryRun).toHaveBeenCalledWith({ workspaceId: "ws-1", automationId: STAMP, claimId: "claim-server" });
    // While main asks, the row claims nothing.
    expect(within(row!).queryByRole("button", { name: "View run" })).toBeNull();
    expect(screen.queryByTestId("record-history-run-not-here")).toBeNull();
    expect(onRunsChecked).not.toHaveBeenCalled();
    await act(async () => answer.resolve({ location: "available" }));
    fireEvent.click(await within(row!).findByRole("button", { name: "View run" }));
    expect(onOpenRun).toHaveBeenCalledWith(STAMP, "claim-server", "Stamp");
    expect(screen.queryByTestId("record-history-run-not-here-why")).toBeNull();
    expect(onRunsChecked).toHaveBeenLastCalledWith([`${STAMP}\nclaim-server`]);
  });

  it("claims nothing about a run dohc could not check, and reports it again only for a newly unplaced run", async () => {
    const offline = new Error("dohc could not reach your server.");
    stub(
      async (payload) => {
        if (payload.beforeHistoryId === undefined) return { entries: [entry(9, automation("Stamp", { claimId: "claim-1", location: "unchecked" }))], nextBeforeHistoryId: 9 };
        if (payload.beforeHistoryId === 9) return { entries: [entry(5, automation("Stamp", { claimId: "claim-2", location: "unchecked" }))], nextBeforeHistoryId: 5 };
        return { entries: [entry(2, null, "Owner")], nextBeforeHistoryId: null };
      },
      async () => { throw offline; },
    );
    const onRunsUnchecked = vi.fn();
    const onRunsChecked = vi.fn();
    render(dialog({ onRunsUnchecked, onRunsChecked }));
    await waitFor(() => expect(onRunsUnchecked.mock.calls).toEqual([[null, offline, [`${STAMP}\nclaim-1`]]]));
    const [row] = screen.getAllByTestId("record-history-entry");
    expect(within(row!).queryByRole("button", { name: "View run" })).toBeNull();
    // Never read as a run that ended long ago.
    expect(screen.queryByTestId("record-history-run-not-here")).toBeNull();
    expect(screen.queryByTestId("record-history-run-not-here-why")).toBeNull();
    // A run on the older page fails too, so Try again must read back to it.
    fireEvent.click(screen.getByRole("button", { name: "Older changes" }));
    await waitFor(() => expect(onRunsUnchecked.mock.calls).toEqual([
      [null, offline, [`${STAMP}\nclaim-1`]],
      [9, offline, [`${STAMP}\nclaim-1`, `${STAMP}\nclaim-2`]],
    ]));
    // An older page with no run says nothing new.
    fireEvent.click(screen.getByRole("button", { name: "Older changes" }));
    await screen.findByText(/Owner:/);
    expect(onRunsUnchecked).toHaveBeenCalledTimes(2);
    expect(onRunsChecked).not.toHaveBeenCalled();
  });

  it("reads back to the page asked for before it says a run could not be checked", async () => {
    const older = deferred<GetCollectionRecordHistoryResult>();
    const offline = new Error("offline");
    const bridge = stub(
      async (payload) => payload.beforeHistoryId === undefined
        ? { entries: [entry(9, automation("Stamp", { claimId: "claim-1", location: "unchecked" }))], nextBeforeHistoryId: 3 }
        : older.promise,
      async () => { throw offline; },
    );
    const onRunsUnchecked = vi.fn();
    render(dialog({ until: 3, onRunsUnchecked }));
    await waitFor(() => expect(bridge.locateRecordHistoryRun).toHaveBeenCalledOnce());
    await act(async () => undefined);
    expect(onRunsUnchecked).not.toHaveBeenCalled();
    await act(async () => older.resolve({ entries: [entry(2, automation("Stamp", { claimId: "claim-2", location: "unchecked" }))], nextBeforeHistoryId: null }));
    await waitFor(() => expect(onRunsUnchecked.mock.calls).toEqual([[3, offline, [`${STAMP}\nclaim-1`, `${STAMP}\nclaim-2`]]]));
  });

  it("asks about each run once, four at a time", async () => {
    const answers: Array<() => void> = [];
    const runs = ["a", "b", "c", "d", "e", "f"].map((claimId, index) => entry(20 - index, automation("Stamp", { claimId, location: "unchecked" })));
    const bridge = stub(
      async () => ({ entries: [...runs, entry(2, automation("Stamp", { claimId: "a", location: "unchecked" }))], nextBeforeHistoryId: null }),
      () => new Promise((resolve) => answers.push(() => resolve({ location: "unavailable" }))),
    );
    render(dialog());
    await screen.findAllByTestId("record-history-entry");
    expect(bridge.locateRecordHistoryRun).toHaveBeenCalledTimes(4);
    await act(async () => answers[0]!());
    expect(bridge.locateRecordHistoryRun).toHaveBeenCalledTimes(5);
    await act(async () => { for (const answer of answers.slice(1)) answer(); });
    await act(async () => { for (const answer of answers.slice(5)) answer(); });
    await waitFor(() => expect(screen.getAllByTestId("record-history-run-not-here")).toHaveLength(7));
    expect(bridge.locateRecordHistoryRun.mock.calls.map(([payload]) => payload.claimId)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("drops a run's answer for the record it showed before", async () => {
    const slow = deferred<LocateRecordHistoryRunResult>();
    stub(
      async (payload) => ({ entries: [entry(9, automation("Stamp", { claimId: payload.recordId, location: "unchecked" }))], nextBeforeHistoryId: null }),
      (payload) => payload.claimId === "rec_a" ? slow.promise : Promise.resolve({ location: "unavailable" }),
    );
    const onRunsChecked = vi.fn();
    const { rerender } = render(dialog({ onRunsChecked }));
    await screen.findAllByTestId("record-history-entry");
    rerender(dialog({ recordId: "rec_b", recordName: "Book flights", onRunsChecked }));
    await screen.findByTestId("record-history-run-not-here");
    await act(async () => slow.resolve({ location: "available" }));
    expect(screen.queryByRole("button", { name: "View run" })).toBeNull();
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

  it("reports a failed read with the page it asked for, and each read that lands", async () => {
    const bridge = stub(async () => { throw new Error("The workspace engine is not running."); });
    const onFailed = vi.fn();
    const onRead = vi.fn();
    render(dialog({ onFailed, onRead }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(null, expect.any(Error)));
    expect(onRead).not.toHaveBeenCalled();
    bridge.getCollectionRecordHistory.mockResolvedValue({ entries: [], nextBeforeHistoryId: null });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("No field of this record has changed yet.");
    expect(onRead.mock.calls).toEqual([[null]]);
  });

  it("reads on to the older page it was asked for", async () => {
    const bridge = stub(async (payload) => {
      if (payload.beforeHistoryId === undefined) return { entries: [entry(12, null)], nextBeforeHistoryId: 12 };
      if (payload.beforeHistoryId === 12) return { entries: [entry(10, null)], nextBeforeHistoryId: 10 };
      return { entries: [entry(4, null, "Owner")], nextBeforeHistoryId: 4 };
    });
    // A change arrived since the page before 10 failed, so the pages moved.
    render(dialog({ until: 10 }));
    await screen.findByText(/Owner:/);
    expect(bridge.getCollectionRecordHistory.mock.calls.map(([payload]) => payload.beforeHistoryId)).toEqual([undefined, 12, 10]);
    expect(screen.getAllByTestId("record-history-entry")).toHaveLength(3);
    // Older pages stay for the person to ask for.
    expect(screen.getByRole("button", { name: "Older changes" })).toBeTruthy();
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
    const onFailed = vi.fn();
    const bridge = stub(async (payload) => {
      if (payload.beforeHistoryId === undefined) return { entries: [entry(9, null)], nextBeforeHistoryId: 9 };
      throw new Error("The workspace engine is not running.");
    });
    render(dialog({ onFailed }));
    const older = await screen.findByRole("button", { name: "Older changes" });
    older.focus();
    fireEvent.click(older);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("dohc could not read this record's history."));
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith(9, expect.any(Error));
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

  it("groups only consecutive changes from one run", () => {
    const run = automation("Stamp", { claimId: "claim-1", location: "available" });
    const other = automation("Stamp", { claimId: "claim-2", location: "available" });
    const groups = recordHistoryGroups([entry(5, run), entry(4, run), entry(3, other), entry(2, run), entry(1, automation("Stamp", null)), entry(0, automation("Stamp", null))]);
    expect(groups.map((group) => group.changes.map((change) => change.historyId))).toEqual([[5, 4], [3], [2], [1], [0]]);
  });
});
