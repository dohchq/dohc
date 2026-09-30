// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAutomationHolds, type AutomationHoldNotice } from "./useAutomationHolds";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const hold = (workspace: string): AutomationHoldNotice => ({
  automationId: `collection:${workspace}#spend`, automationName: "Spend", definitionHash: "0123456789abcdef",
  step: "0", seq: 1, collection: workspace, collectionPath: workspace, target: "Budget", action: "change", stoppedFor: "bob@dohc.test", fileUnread: false, onServer: false,
});
const noServerHolds = async () => ({ holds: [] });

it("never lets an Allow that finishes after a workspace switch repaint the new workspace's holds", async () => {
  const confirmed = Promise.withResolvers<{ status: "confirmed" }>();
  const listAutomationHolds = vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({ holds: [hold(workspaceId)], stops: [], unprovenPaths: [] }));
  vi.stubGlobal("dohcDesktop", {
    listAutomationHolds,
    listServerAutomationHolds: noServerHolds,
    onAutomationHoldsChanged: () => () => undefined,
    confirmCollectionAutomationStep: () => confirmed.promise,
  });
  const reportShellError = vi.fn();
  const { result, rerender } = renderHook(
    ({ workspaceId }) => useAutomationHolds(workspaceId, true, reportShellError, ""),
    { initialProps: { workspaceId: "Trip" } },
  );
  await act(async () => undefined);
  expect(result.current.automationHolds).toEqual([hold("Trip")]);

  act(() => result.current.allowAutomationHold(hold("Trip")));
  rerender({ workspaceId: "Home" });
  await act(async () => undefined);
  expect(result.current.automationHolds).toEqual([hold("Home")]);

  // Trip's Allow finishes now. It must not read Trip's holds into Home.
  await act(async () => { confirmed.resolve({ status: "confirmed" }); await confirmed.promise; });
  expect(listAutomationHolds.mock.calls.map(([payload]) => payload.workspaceId)).toEqual(["Trip", "Home"]);
  expect(result.current.automationHolds).toEqual([hold("Home")]);
});

it("keeps the newest list when an older read in the same workspace answers last", async () => {
  const answers: Array<(holds: AutomationHoldNotice[]) => void> = [];
  const listeners: Array<(event: { workspaceId: string }) => void> = [];
  vi.stubGlobal("dohcDesktop", {
    listAutomationHolds: () => new Promise((resolve) => answers.push((holds) => resolve({ holds, stops: [], unprovenPaths: [] }))),
    listServerAutomationHolds: noServerHolds,
    onAutomationHoldsChanged: (listener: (event: { workspaceId: string }) => void) => {
      listeners.push(listener);
      return () => undefined;
    },
    confirmCollectionAutomationStep: vi.fn(),
  });
  const { result } = renderHook(() => useAutomationHolds("Trip", true, vi.fn(), ""));
  // A poke asks again while the first read is still out.
  act(() => listeners[0]!({ workspaceId: "Trip" }));
  await act(async () => { answers[1]!([]); });
  await act(async () => { answers[0]!([hold("Trip")]); });
  expect(result.current.automationHolds).toEqual([]);
});

it("dismisses the stopped steps by the verdicts it showed, then reads the notices again", async () => {
  const stop = { ...hold("Trip"), seq: 7 };
  const listAutomationHolds = vi.fn(async () => ({ holds: [], stops: [stop], unprovenPaths: [] }));
  const dismissAutomationStops = vi.fn(async () => undefined);
  vi.stubGlobal("dohcDesktop", {
    listAutomationHolds,
    listServerAutomationHolds: noServerHolds,
    onAutomationHoldsChanged: () => () => undefined,
    dismissAutomationStops,
  });
  const { result } = renderHook(() => useAutomationHolds("Trip", true, vi.fn(), ""));
  await act(async () => undefined);
  expect(result.current.automationStops).toEqual([stop]);
  await act(async () => { result.current.dismissAutomationStops([stop]); });
  expect(dismissAutomationStops).toHaveBeenCalledWith({
    workspaceId: "Trip",
    stops: [{ automationId: stop.automationId, definitionHash: stop.definitionHash, step: "0", seq: 7 }],
  });
  expect(listAutomationHolds).toHaveBeenCalledTimes(2);
});


it("posts one retryable notice naming an unidentified file and retires its retry on a workspace switch", async () => {
  let listener: (event: { workspaceId: string }) => void = () => undefined;
  const listAutomationHolds = vi.fn(async () => ({ holds: [], stops: [], unreadable: false, unprovenPaths: ["Unknown"] }));
  vi.stubGlobal("dohcDesktop", {
    listAutomationHolds,
    listServerAutomationHolds: noServerHolds,
    onAutomationHoldsChanged: (next: typeof listener) => { listener = next; return () => undefined; },
  });
  const report = vi.fn();
  const { rerender } = renderHook(({ workspaceId }) => useAutomationHolds(workspaceId, true, report, ""), { initialProps: { workspaceId: "Trip" } });
  await act(async () => undefined);
  await act(async () => listener({ workspaceId: "Trip" }));
  expect(report).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0]?.[0]).toContain('"Unknown/automations.yaml"');
  const retry = report.mock.calls[0]![2] as () => void;
  await act(async () => retry());
  expect(listAutomationHolds).toHaveBeenLastCalledWith({ workspaceId: "Trip", retryPath: "Unknown" });
  rerender({ workspaceId: "Home" });
  await act(async () => undefined);
  const calls = listAutomationHolds.mock.calls.length;
  await act(async () => retry());
  expect(listAutomationHolds).toHaveBeenCalledTimes(calls);
});

it("keeps Try again after a retry fails, and names a path again when it returns", async () => {
  let listener: (event: { workspaceId: string }) => void = () => undefined;
  const lists = [["Ops"], ["Ops"], [], ["Ops"]];
  const listAutomationHolds = vi.fn(async ({ retryPath }: { retryPath?: string }) => {
    if (retryPath !== undefined && listAutomationHolds.mock.calls.length === 2) throw new Error("The engine stopped.");
    return { holds: [], stops: [], unreadable: false, unprovenPaths: lists.shift() ?? [] };
  });
  vi.stubGlobal("dohcDesktop", {
    listAutomationHolds,
    listServerAutomationHolds: noServerHolds,
    onAutomationHoldsChanged: (next: typeof listener) => { listener = next; return () => undefined; },
  });
  const report = vi.fn();
  renderHook(() => useAutomationHolds("Trip", true, report, ""));
  await act(async () => undefined);
  expect(report.mock.calls[0]?.[0]).toBe(
    'Automation steps in "Ops" wait because dohc cannot tell which Collection "Ops/automations.yaml" belongs to in one version of the workspace. Fix its collection.yaml or dataset.json in that version.',
  );
  await act(async () => (report.mock.calls[0]![2] as () => void)());
  expect(report).toHaveBeenCalledTimes(2);
  expect(report.mock.calls[1]?.[1]).toEqual(new Error("The engine stopped."));
  const retry = report.mock.calls[1]![2] as () => void;
  expect(retry).toBeTypeOf("function");
  await act(async () => retry());
  expect(listAutomationHolds).toHaveBeenLastCalledWith({ workspaceId: "Trip", retryPath: "Ops" });
  expect(report).toHaveBeenCalledTimes(3);
  expect(report.mock.calls[2]?.[2]).toBeTypeOf("function");
  await act(async () => listener({ workspaceId: "Trip" }));
  await act(async () => listener({ workspaceId: "Trip" }));
  expect(report).toHaveBeenCalledTimes(4);
});

it("lists the steps the server holds beside this computer's, reads them again when its notices change, and allows them there", async () => {
  const { onServer: _here, ...held } = hold("Trip");
  const listServerAutomationHolds = vi.fn(async () => ({ holds: [held] }));
  const confirmCollectionAutomationStep = vi.fn(async () => ({ status: "confirmed" as const }));
  vi.stubGlobal("dohcDesktop", {
    listAutomationHolds: async () => ({ holds: [], stops: [], unreadable: false, unprovenPaths: [] }),
    listServerAutomationHolds,
    onAutomationHoldsChanged: () => () => undefined,
    confirmCollectionAutomationStep,
  });
  const reportShellError = vi.fn();
  const { result, rerender } = renderHook(
    ({ key }) => useAutomationHolds("Trip", true, reportShellError, key),
    { initialProps: { key: "" } },
  );
  await act(async () => undefined);
  expect(result.current.automationHolds).toEqual([{ ...held, onServer: true }]);
  // The server's notice about a new hold arrived.
  rerender({ key: "automation-held:1" });
  await act(async () => undefined);
  expect(listServerAutomationHolds).toHaveBeenCalledTimes(2);
  await act(async () => { result.current.allowAutomationHold({ ...held, onServer: true }); });
  expect(confirmCollectionAutomationStep).toHaveBeenCalledWith({
    workspaceId: "Trip", automationId: held.automationId, definitionHash: held.definitionHash, step: "0", seq: 1, onServer: true,
  });
  expect(listServerAutomationHolds).toHaveBeenCalledTimes(3);
  expect(reportShellError).not.toHaveBeenCalled();
});

it("says when it cannot read the server's holds, and reads them again on Try again", async () => {
  const { onServer: _here, ...held } = hold("Trip");
  const listServerAutomationHolds = vi.fn()
    .mockRejectedValueOnce(new Error("Your server answered with 500."))
    .mockResolvedValue({ holds: [held] });
  vi.stubGlobal("dohcDesktop", {
    listAutomationHolds: async () => ({ holds: [], stops: [], unreadable: false, unprovenPaths: [] }),
    listServerAutomationHolds,
    onAutomationHoldsChanged: () => () => undefined,
  });
  const reportShellError = vi.fn();
  const { result } = renderHook(() => useAutomationHolds("Trip", true, reportShellError, "automation-held:1"));
  await act(async () => undefined);
  expect(result.current.automationHolds).toEqual([]);
  expect(reportShellError).toHaveBeenCalledWith("dohc could not read the automation steps your server holds.", expect.any(Error), expect.any(Function));
  await act(async () => { reportShellError.mock.calls[0]![2](); });
  expect(result.current.automationHolds).toEqual([{ ...held, onServer: true }]);
});
