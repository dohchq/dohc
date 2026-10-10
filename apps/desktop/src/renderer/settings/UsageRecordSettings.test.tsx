// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageRecordResult, UsageRecordRow } from "../../ipc/bridgeContract";
import { NOT_COUNTED, UsageRecordSettings, usageRecordText } from "./UsageRecordSettings";

type Readable = Extract<UsageRecordResult, { status: "readable" }>;
const cell = (count: number, counted = true) => ({ count, counted });
function row(capabilityId: string, label: string, doors: Partial<UsageRecordRow["doors"]>, lastUsed: string | null = null): UsageRecordRow {
  return { capabilityId, label, lastUsed,
    doors: { renderer: cell(0, false), cli: cell(0, false), mcp: cell(0, false), automation: cell(0, false), ...doors } };
}
const ROWS = [
  row("version.create", "Create a workspace version", { renderer: cell(3), cli: cell(1, false) }, "2026-10-07"),
  row("file.kept.save", "Save a kept copy beside its file", { renderer: cell(0), cli: cell(2), mcp: cell(0) }, "2026-10-06"),
  row("chat.export", "Export a chat", {}),
  row("version.try", "Try changes in a workspace version", { renderer: cell(0) }),
];
const RECORD: Readable = { status: "readable", enabled: true, file: "C:\\Users\\a\\AppData\\Roaming\\dohc\\dohc-usage.json",
  since: "2026-09-12", incompleteDays: 1, rows: ROWS };
const EMPTY: Readable = { ...RECORD, since: "2026-10-07", incompleteDays: 0, rows: ROWS.map(r => ({ ...r, lastUsed: null,
  doors: { ...r.doors, renderer: { ...r.doors.renderer, count: 0 }, cli: { ...r.doors.cli, count: 0 } } })) };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const bridge = {
  readUsageRecord: vi.fn(async (_payload: Record<string, never>): Promise<UsageRecordResult> => RECORD),
  clearUsageRecord: vi.fn(async (_payload: Record<string, never>) => undefined),
  setUsageRecordEnabled: vi.fn(async (_payload: { enabled: boolean }) => undefined),
};
const writeText = vi.fn(async (_text: string) => undefined);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 7, 12));
  for (const mock of Object.values(bridge)) mock.mockClear();
  bridge.readUsageRecord.mockImplementation(async () => RECORD);
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  window.dohcDesktop = bridge as unknown as typeof window.dohcDesktop;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.dohcDesktop;
});

const card = () => screen.getByTestId("usage-record");
const toggle = () => screen.getByRole("switch", { name: "Keep a usage record" });

describe("usage record in Privacy", () => {
  it("shows loading lines, then counts by door with uncovered rows and doors marked, read once", async () => {
    const read = deferred<UsageRecordResult>();
    bridge.readUsageRecord.mockImplementationOnce(() => read.promise);
    render(<UsageRecordSettings />);
    expect(card().dataset.state).toBe("loading");
    expect(screen.getByTestId("usage-record-loading").getAttribute("role")).toBe("status");
    expect(screen.queryByRole("switch")).toBeNull();
    await act(async () => read.resolve(RECORD));
    expect(card().dataset.state).toBe("on");
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map(r => r.dataset.testid)).toEqual([
      "usage-record-row-version.create", "usage-record-row-file.kept.save", "usage-record-row-version.try", "usage-record-row-chat.export",
    ]);
    const created = within(rows[0]!).getAllByRole("cell");
    expect(created.map(c => c.textContent)).toEqual(["3", "1", NOT_COUNTED, NOT_COUNTED, "today"]);
    // A counted door at zero says 0; one this build does not count is marked.
    expect(within(rows[1]!).getAllByRole("cell").map(c => c.textContent)).toEqual(["0", "2", "0", NOT_COUNTED, "yesterday"]);
    expect(rows[3]!.dataset.counted).toBe("false");
    expect(within(rows[3]!).getAllByTitle(NOT_COUNTED)).toHaveLength(4);
    // No door counts automation in this build, so its heading is marked too.
    const automation = screen.getByRole("columnheader", { name: /Automation/ });
    expect(within(automation).getByTitle(NOT_COUNTED)).toBeTruthy();
    expect(within(screen.getByRole("columnheader", { name: /^dohc$/ })).queryByTitle(NOT_COUNTED)).toBeNull();
    expect(screen.getByText("since Sep 12")).toBeTruthy();
    expect(screen.getByTestId("usage-record-file").textContent).toBe(RECORD.file);
    expect(card().textContent).toContain("dohc never sends it.");
    expect(card().textContent).not.toMatch(/never leaves|this machine only/i);
    expect(bridge.readUsageRecord).toHaveBeenCalledTimes(1);
    expect(bridge.readUsageRecord).toHaveBeenCalledWith({});
  });

  it("says nothing is counted yet when the record is empty, on and off", async () => {
    bridge.readUsageRecord.mockResolvedValueOnce(EMPTY);
    const view = render(<UsageRecordSettings />);
    expect((await screen.findByTestId("usage-record-empty")).textContent).toContain("Nothing counted yet.");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByTestId("usage-record-copy")).toBeTruthy();
    view.unmount();
    bridge.readUsageRecord.mockResolvedValueOnce({ ...EMPTY, enabled: false });
    render(<UsageRecordSettings />);
    expect((await screen.findByTestId("usage-record-empty")).textContent).toContain("Turn the record on");
  });

  it("keeps saved counts while Off, says so with Clear beside the switch, and turns On again", async () => {
    bridge.readUsageRecord.mockResolvedValueOnce({ ...RECORD, enabled: false });
    render(<UsageRecordSettings />);
    await waitFor(() => expect(card().dataset.state).toBe("off"));
    expect(screen.getByTestId("usage-record-off").textContent).toBe("Off. dohc keeps the saved counts and adds none. Clear removes them.");
    expect(screen.getAllByRole("row")).toHaveLength(ROWS.length + 1);
    const head = card().querySelector("header")!;
    expect(within(head).getByTestId("usage-record-clear")).toBeTruthy();
    expect(screen.getAllByTestId("usage-record-clear")).toHaveLength(1);
    fireEvent.click(toggle());
    await waitFor(() => expect(bridge.setUsageRecordEnabled).toHaveBeenCalledWith({ enabled: true }));
    await waitFor(() => expect(card().dataset.state).toBe("on"));
    expect(bridge.readUsageRecord).toHaveBeenCalledTimes(2);
    expect(within(card().querySelector("footer")!).getByTestId("usage-record-clear")).toBeTruthy();
  });

  it("turns Off, and a switch that fails reports through Notices and keeps the read state", async () => {
    const onError = vi.fn();
    render(<UsageRecordSettings onError={onError} />);
    await waitFor(() => expect(card().dataset.state).toBe("on"));
    bridge.readUsageRecord.mockResolvedValueOnce({ ...RECORD, enabled: false });
    fireEvent.click(toggle());
    expect(toggle().hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(card().dataset.state).toBe("off"));
    expect(bridge.setUsageRecordEnabled).toHaveBeenCalledWith({ enabled: false });
    expect(toggle().hasAttribute("disabled")).toBe(false);

    bridge.setUsageRecordEnabled.mockRejectedValueOnce(new Error("disk full"));
    fireEvent.click(toggle());
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("disk full"), expect.any(Error)));
    expect(onError.mock.calls[0]![0]).toContain("dohc could not turn the usage record on.");
    await waitFor(() => expect(toggle().hasAttribute("disabled")).toBe(false));
    expect(card().dataset.state).toBe("on");
  });

  it("copies the rows and coverage only, with no path", async () => {
    render(<UsageRecordSettings />);
    fireEvent.click(await screen.findByTestId("usage-record-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0]![0];
    expect(text).toBe(usageRecordText(RECORD));
    expect(text).toBe([
      "dohc usage record",
      "Counting: on",
      "Since 2026-09-12. Partly counted days: 1.",
      "Capability\tdohc\tCLI\tMCP\tAutomation\tLast used",
      "version.create\t3\t1\tnot counted\tnot counted\t2026-10-07",
      "file.kept.save\t0\t2\t0\tnot counted\t2026-10-06",
      "chat.export\tnot counted\tnot counted\tnot counted\tnot counted\t",
      "version.try\t0\tnot counted\tnot counted\tnot counted\t",
    ].join("\n"));
    expect(text).not.toContain("AppData");
    expect(text).not.toContain("Create a workspace version");
  });

  it("confirms Clear first, offers Copy in the confirm, and clears only on confirm", async () => {
    render(<UsageRecordSettings />);
    fireEvent.click(await screen.findByTestId("usage-record-clear"));
    const confirm = screen.getByTestId("usage-record-clear-confirm");
    expect(confirm.getAttribute("role")).toBe("dialog");
    expect(confirm.textContent).toContain("Clear the usage record?");
    expect(confirm.textContent).toContain("dohc cannot restore them.");
    fireEvent.click(within(confirm).getByTestId("usage-record-clear-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(usageRecordText(RECORD)));
    expect(bridge.clearUsageRecord).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("usage-record-clear-cancel"));
    expect(screen.queryByTestId("usage-record-clear-confirm")).toBeNull();
    expect(bridge.clearUsageRecord).not.toHaveBeenCalled();

    bridge.readUsageRecord.mockResolvedValueOnce(EMPTY);
    fireEvent.click(screen.getByTestId("usage-record-clear"));
    fireEvent.click(screen.getByTestId("usage-record-clear-action"));
    await waitFor(() => expect(bridge.clearUsageRecord).toHaveBeenCalledWith({}));
    expect(await screen.findByTestId("usage-record-empty")).toBeTruthy();
  });

  it("reports a Clear that failed and keeps the counts", async () => {
    const onError = vi.fn();
    bridge.clearUsageRecord.mockRejectedValueOnce(new Error("file in use"));
    render(<UsageRecordSettings onError={onError} />);
    fireEvent.click(await screen.findByTestId("usage-record-clear"));
    fireEvent.click(screen.getByTestId("usage-record-clear-action"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("file in use"), expect.any(Error)));
    expect(onError.mock.calls[0]![0]).toContain("dohc could not clear the usage record.");
    expect(screen.getAllByRole("row")).toHaveLength(ROWS.length + 1);
  });

  it("says an unreadable record stays as it is, and offers nothing that would write it", async () => {
    bridge.readUsageRecord.mockResolvedValueOnce({ status: "unreadable", file: RECORD.file, code: "EACCES" });
    render(<UsageRecordSettings />);
    const unreadable = await screen.findByTestId("usage-record-unreadable");
    expect(unreadable.textContent).toContain("dohc could not read the usage record (EACCES).");
    expect(unreadable.textContent).toContain("dohc leaves the file as it is and counts nothing.");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByTestId("usage-record-clear")).toBeNull();
    expect(screen.queryByTestId("usage-record-copy")).toBeNull();
    expect(screen.getByTestId("usage-record-file").textContent).toBe(RECORD.file);
  });

  it("reports a read that failed and reads again on Try again", async () => {
    const onError = vi.fn();
    bridge.readUsageRecord.mockRejectedValueOnce(new Error("main went away"));
    render(<UsageRecordSettings onError={onError} />);
    const failed = await screen.findByTestId("usage-record-failed");
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("main went away"), expect.any(Error));
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(card().dataset.state).toBe("on"));
    expect(bridge.readUsageRecord).toHaveBeenCalledTimes(2);
  });

  it("drops a read or a failure that answers after Privacy closed", async () => {
    const onError = vi.fn();
    const late = deferred<UsageRecordResult>();
    bridge.readUsageRecord.mockImplementationOnce(() => late.promise);
    const first = render(<UsageRecordSettings onError={onError} />);
    first.unmount();
    await act(async () => late.resolve(RECORD));
    const failing = deferred<UsageRecordResult>();
    bridge.readUsageRecord.mockImplementationOnce(() => failing.promise);
    const second = render(<UsageRecordSettings onError={onError} />);
    second.unmount();
    await act(async () => failing.reject(new Error("late")));
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByTestId("usage-record")).toBeNull();
  });
});
