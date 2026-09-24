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
  step: 0, seq: 1, collection: workspace, target: "Budget", action: "change", stoppedFor: "bob@dohc.test",
});

it("never lets an Allow that finishes after a workspace switch repaint the new workspace's holds", async () => {
  const confirmed = Promise.withResolvers<{ status: "confirmed" }>();
  const listAutomationHolds = vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({ holds: [hold(workspaceId)] }));
  vi.stubGlobal("dohcDesktop", {
    listAutomationHolds,
    onAutomationHoldsChanged: () => () => undefined,
    confirmCollectionAutomationStep: () => confirmed.promise,
  });
  const reportShellError = vi.fn();
  const { result, rerender } = renderHook(
    ({ workspaceId }) => useAutomationHolds(workspaceId, true, reportShellError),
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
