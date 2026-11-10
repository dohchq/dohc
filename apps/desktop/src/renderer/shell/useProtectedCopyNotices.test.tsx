// @vitest-environment jsdom
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProtectedCopyNotices } from "./useProtectedCopyNotices";
import { useShellError } from "./useShellError";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

type Row = readonly [string, string, number];
const ID = "0b5c3f2e-8d41-4a8e-9f3c-2d7e6a1b4c90";

function harness(copies: readonly Row[]) {
  const bridge = {
    restoreProtectedCopy: vi.fn(async (_input: { workspaceId: string; id: string }) => ({ path: ".env", status: "restored" as const })),
    discardProtectedCopy: vi.fn(async (_input: { workspaceId: string; id: string }) => ({ path: ".env", status: "discarded" as const })),
  };
  vi.stubGlobal("dohcDesktop", bridge);
  let errors!: ReturnType<typeof useShellError>;
  function Shell(props: { copies: readonly Row[] }) {
    errors = useShellError("ws-a");
    return useProtectedCopyNotices({
      workspaceId: "ws-a",
      copies: props.copies,
      readError: undefined,
      retryRead: () => undefined,
      reportShellFailure: errors.reportShellFailure,
      showSuccessNotice: errors.showSuccessNotice,
      clearIdentity: errors.clearIdentity,
    });
  }
  const view = render(<Shell copies={copies} />);
  return { bridge, errors: () => errors, list: (next: readonly Row[]) => view.rerender(<Shell copies={next} />), unmount: view.unmount };
}

describe("useProtectedCopyNotices", () => {
  it("shows a kept change by its path and restores it from its row", async () => {
    const h = harness([[".env", ID, 10]]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(1));
    const row = h.errors().shellErrors[0]!;
    expect(row).toMatchObject({
      tone: "warning",
      title: "Kept your change to .env",
      message: "A sync replaced .env. Your version is kept on this computer only.",
      action: { label: "Restore", additional: [{ label: "Discard" }] },
    });

    act(() => h.errors().runShellErrorAction(row.id));
    await waitFor(() => expect(h.errors().shellErrors.map((error) => error.message)).toEqual(["Restored your change to .env"]));
    expect(h.bridge.restoreProtectedCopy).toHaveBeenCalledWith({ workspaceId: "ws-a", id: ID });
  });

  it("discards a kept change only after the warning is confirmed", async () => {
    const h = harness([[".env", ID, 10]]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(1));
    const row = h.errors().shellErrors[0]!;

    act(() => h.errors().runShellErrorAction(row.id, 1));
    expect((await screen.findByTestId("protected-discard-dialog")).textContent).toContain("cannot be brought back");
    fireEvent.click(screen.getByTestId("protected-discard-cancel"));
    expect(h.bridge.discardProtectedCopy).not.toHaveBeenCalled();

    act(() => h.errors().runShellErrorAction(row.id, 1));
    fireEvent.click(await screen.findByTestId("protected-discard-confirm"));
    await waitFor(() => expect(h.errors().shellErrors.map((error) => error.message)).toEqual(["Discarded your change to .env"]));
    expect(h.bridge.discardProtectedCopy).toHaveBeenCalledWith({ workspaceId: "ws-a", id: ID });
  });

  it("keeps a dismissed row dismissed after a restart while the copy stays, and forgets it once the copy goes", async () => {
    const first = harness([[".env", ID, 10]]);
    await waitFor(() => expect(first.errors().shellErrors).toHaveLength(1));
    act(() => first.errors().dismissShellError(first.errors().shellErrors[0]!.id));
    first.unmount();

    const second = harness([[".env", ID, 10]]);
    await act(async () => undefined);
    expect(second.errors().shellErrors).toEqual([]);
    second.list([]);
    await waitFor(() => expect(localStorage.getItem("dohc:protected-copies-dismissed:ws-a")).toBe("[]"));
  });
});
