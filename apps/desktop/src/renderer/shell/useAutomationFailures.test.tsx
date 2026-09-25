// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutomationFailures } from "./useAutomationFailures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("automation failure notices", () => {
  it("drops a dismiss that answers after the workspace changed, instead of reloading or reporting there", async () => {
    const answers: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
    const bridge = {
      listAutomationFailures: vi.fn(async () => ({ failures: [] })),
      dismissAutomationFailure: vi.fn(() => new Promise<void>((resolve, reject) => {
        answers.push({ resolve, reject });
      })),
      onAutomationFailuresChanged: vi.fn(() => () => undefined),
    };
    vi.stubGlobal("dohcDesktop", bridge);
    const reportShellError = vi.fn();
    const { result, rerender } = renderHook(
      ({ workspaceId }) => useAutomationFailures(workspaceId, true, reportShellError),
      { initialProps: { workspaceId: "ws-a" } },
    );
    await waitFor(() => expect(bridge.listAutomationFailures).toHaveBeenCalledWith({ workspaceId: "ws-a" }));

    act(() => result.current.dismissAutomationFailure("collection:Tasks#stamp", 1));
    act(() => result.current.dismissAutomationFailure("collection:Tasks#nudge", 1));
    rerender({ workspaceId: "ws-b" });
    await waitFor(() => expect(bridge.listAutomationFailures).toHaveBeenCalledWith({ workspaceId: "ws-b" }));
    const reads = bridge.listAutomationFailures.mock.calls.length;
    await act(async () => {
      answers[0]!.resolve();
      answers[1]!.reject(new Error("The workspace engine is not running."));
    });
    expect(bridge.listAutomationFailures.mock.calls.length).toBe(reads);
    expect(reportShellError).not.toHaveBeenCalled();
  });
});
