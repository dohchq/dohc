// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UsageRecordResult } from "../../ipc/bridgeContract";
import { USAGE_RECORD_STOPPED, useUsageRecordStops } from "./usageRecordStops";

const listeners = new Set<() => void>();
const bridge = {
  readUsageRecord: vi.fn(async (_payload: Record<string, never>): Promise<UsageRecordResult> =>
    ({ status: "readable", enabled: true, file: "dohc-usage.json", since: null, incompleteDays: 0, rows: [], setAside: null })),
  onUsageRecordStopped: vi.fn((listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }),
};

beforeEach(() => {
  listeners.clear();
  bridge.readUsageRecord.mockClear();
  window.dohcDesktop = bridge as unknown as typeof window.dohcDesktop;
});
afterEach(() => {
  cleanup();
  delete window.dohcDesktop;
});

it("reports a timed save that stopped counting, with Try again that reads the file again", async () => {
  const report = vi.fn();
  const view = renderHook(() => useUsageRecordStops(report));
  act(() => { for (const listener of listeners) listener(); });
  expect(report).toHaveBeenCalledExactlyOnceWith(USAGE_RECORD_STOPPED, undefined, expect.any(Function));
  const retry = report.mock.calls[0]![2] as () => Promise<void>;

  // Still unreadable: the row comes back with the file's own words.
  bridge.readUsageRecord.mockResolvedValueOnce({ status: "unreadable", file: "dohc-usage.json", code: "INVALID_USAGE_RECORD", setAside: null });
  await act(retry);
  expect(report).toHaveBeenLastCalledWith(expect.stringContaining("(INVALID_USAGE_RECORD)"), undefined, expect.any(Function));

  // Read again: counting resumes, and nothing more is reported.
  await act(retry);
  expect(report).toHaveBeenCalledTimes(2);
  expect(bridge.readUsageRecord).toHaveBeenCalledTimes(2);

  view.unmount();
  expect(listeners.size).toBe(0);
});
