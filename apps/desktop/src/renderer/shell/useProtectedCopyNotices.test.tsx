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
      noDismiss: true,
      message: "A sync replaced or deleted this file before dohc saved your change to History. Until you restore it, your change is only on this computer.",
      action: { label: "Restore", additional: [{ label: "Discard" }] },
    });

    act(() => h.errors().runShellErrorAction(row.id));
    await waitFor(() => expect(h.errors().shellErrors.map((error) => error.message)).toEqual(["Restored your change to .env"]));
    expect(h.bridge.restoreProtectedCopy).toHaveBeenCalledWith({ workspaceId: "ws-a", id: ID });
  });

  it("says why a Restore failed, and offers Try again only when trying again can change the answer", async () => {
    const h = harness([[".env", ID, 10]]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(1));
    const row = h.errors().shellErrors[0]!;
    const failed = (message: string) => h.errors().shellErrors.find((error) => error.message === message);
    const title = "dohc could not restore your change to .env";
    const tooBig = "Your change is over the 1 MB limit for protected files.";
    const inTheWay = "dohc saves what is at .env first, and it cannot save that item. Move the item to another folder, then try again.";

    h.bridge.restoreProtectedCopy.mockRejectedValueOnce(new Error(`Error invoking remote method 'restoreProtectedCopy': ProtectedCopyFinalError: ${tooBig}`));
    act(() => h.errors().runShellErrorAction(row.id));
    await waitFor(() => expect(failed(tooBig)).toMatchObject({ title, retry: null }));

    h.bridge.restoreProtectedCopy.mockRejectedValueOnce(new Error(`Error invoking remote method 'restoreProtectedCopy': Error: ${inTheWay}`));
    act(() => h.errors().runShellErrorAction(row.id));
    await waitFor(() => expect(failed(inTheWay)).toMatchObject({ title, retry: expect.any(Function) }));

    h.bridge.restoreProtectedCopy.mockRejectedValueOnce(new Error(""));
    act(() => h.errors().runShellErrorAction(row.id));
    await waitFor(() => expect(failed("dohc could not restore your change to .env.")).toMatchObject({ retry: expect.any(Function) }));
    expect(failed("dohc could not restore your change to .env.")).not.toHaveProperty("title");
  });

  it("discards a kept change only after the warning is confirmed", async () => {
    const h = harness([[".env", ID, 10]]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(1));
    const row = h.errors().shellErrors[0]!;

    act(() => h.errors().runShellErrorAction(row.id, 1));
    const dialog = await screen.findByTestId("protected-discard-dialog");
    expect(dialog.textContent).toContain("Discard your change to .env?");
    expect(dialog.textContent).toContain("Your change is only on this computer, and History never held it. This cannot be undone.");
    expect(screen.getByTestId("protected-discard-confirm").textContent).toBe("Discard change");
    fireEvent.click(screen.getByTestId("protected-discard-cancel"));
    expect(h.bridge.discardProtectedCopy).not.toHaveBeenCalled();

    act(() => h.errors().runShellErrorAction(row.id, 1));
    fireEvent.click(await screen.findByTestId("protected-discard-confirm"));
    await waitFor(() => expect(h.errors().shellErrors.map((error) => error.message)).toEqual(["Discarded your change to .env"]));
    expect(h.bridge.discardProtectedCopy).toHaveBeenCalledWith({ workspaceId: "ws-a", id: ID });
  });

  it("runs one Restore or Discard at a time for a kept change", async () => {
    const h = harness([[".env", ID, 10]]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(1));
    const row = h.errors().shellErrors[0]!;
    let finish!: () => void;
    h.bridge.restoreProtectedCopy.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ path: ".env", status: "restored" as const });
    }));

    act(() => h.errors().runShellErrorAction(row.id));
    act(() => h.errors().runShellErrorAction(row.id));
    act(() => h.errors().runShellErrorAction(row.id, 1));
    fireEvent.click(await screen.findByTestId("protected-discard-confirm"));
    expect(h.bridge.restoreProtectedCopy).toHaveBeenCalledTimes(1);
    expect(h.bridge.discardProtectedCopy).not.toHaveBeenCalled();

    await act(async () => finish());
    await waitFor(() => expect(h.errors().shellErrors.map((error) => error.message)).toEqual(["Restored your change to .env"]));
    expect(h.bridge.restoreProtectedCopy).toHaveBeenCalledTimes(1);
    expect(h.bridge.discardProtectedCopy).not.toHaveBeenCalled();
  });

  it("keeps one row while the copy is listed, and clears it once the copy goes", async () => {
    const h = harness([[".env", ID, 10]]);
    await waitFor(() => expect(h.errors().shellErrors).toHaveLength(1));
    h.list([[".env", ID, 10]]);
    await act(async () => undefined);
    expect(h.errors().shellErrors.map((error) => error.title)).toEqual(["Kept your change to .env"]);
    h.list([]);
    await waitFor(() => expect(h.errors().shellErrors).toEqual([]));
  });
});
