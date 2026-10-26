// @vitest-environment jsdom
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeleteRetainedCopiesResult, ListRetainedCopiesResult, RetainedCopiesSummary } from "../../ipc/bridgeContract";
import {
  RETAINED_COPIES_ACTION,
  RETAINED_COPIES_NOTICE_BYTES,
  forgetRetainedCopiesNoticesForTests,
  useRetainedCopiesNotice,
} from "./useRetainedCopiesNotice";
import { useShellError } from "./useShellError";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 20_000 });

const MB = 1024 * 1024;
const above: RetainedCopiesSummary = { count: 1200, bytes: RETAINED_COPIES_NOTICE_BYTES + 44 * MB };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(initial: { workspaceId: string; summary: RetainedCopiesSummary | undefined }) {
  const bridge = {
    listRetainedCopies: vi.fn(async (_: { workspaceId: string }): Promise<ListRetainedCopiesResult> => ({
      copies: [{ id: 3, revision: 10 }, { id: 4, revision: 11 }],
      more: false,
      total: { count: 2, bytes: 2 * 200 * MB },
    })),
    deleteRetainedCopies: vi.fn(async (_: {
      workspaceId: string;
      copies: { id: number; revision: number }[];
      acceptLateWriteRisk: true;
    }): Promise<DeleteRetainedCopiesResult> => ({ deleted: 2, skipped: 0, failed: 0, remaining: { count: 0, bytes: 0 } })),
  };
  vi.stubGlobal("dohcDesktop", bridge);
  const shell: { current: ReturnType<typeof useShellError> | null } = { current: null };
  function Shell(props: { workspaceId: string; summary: RetainedCopiesSummary | undefined }) {
    const errors = useShellError(props.workspaceId);
    shell.current = errors;
    const notice = useRetainedCopiesNotice({
      workspaceId: props.workspaceId,
      workspaceName: props.workspaceId === "ws-a" ? "Notes" : "Trips",
      summary: props.summary,
      show: errors.showRetainedCopies,
      showDone: errors.showSuccessNotice,
      report: errors.reportShellFailure,
      reportError: errors.reportShellError,
    });
    return <>{notice}</>;
  }
  const rendered = render(<Shell {...initial} />);
  return {
    bridge,
    rerender: (next: { workspaceId: string; summary: RetainedCopiesSummary | undefined }) =>
      rendered.rerender(<Shell {...next} />),
    errors: () => shell.current!.shellErrors,
    row: () => shell.current!.shellErrors.find((error) => error.kind === "retained-copies"),
    run: (id: string) => act(() => shell.current!.runShellErrorAction(id)),
    dismiss: (id: string) => act(() => shell.current!.dismissShellError(id)),
  };
}

beforeEach(() => {
  localStorage.clear();
  forgetRetainedCopiesNoticesForTests();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useRetainedCopiesNotice", () => {
  it("shows one warning above the size, toasts once, and updates it in place", () => {
    const h = harness({ workspaceId: "ws-a", summary: { count: 900, bytes: RETAINED_COPIES_NOTICE_BYTES - 1 } });
    expect(h.row()).toBeUndefined();
    h.rerender({ workspaceId: "ws-a", summary: above });
    const row = h.row()!;
    expect(row).toMatchObject({
      tone: "warning",
      title: "1,200 old file copies",
      message: "They take up 300 MB. dohc can't check whether another program still uses these copies on this drive.",
      action: { label: RETAINED_COPIES_ACTION },
      retry: null,
      seen: false,
    });
    h.rerender({ workspaceId: "ws-a", summary: { count: 2400, bytes: 2.5 * 1024 * MB } });
    expect(h.errors().filter((error) => error.kind === "retained-copies")).toHaveLength(1);
    expect(h.row()).toMatchObject({ id: row.id, title: "2,400 old file copies", message: expect.stringContaining("They take up 2.5 GB.") });
    h.rerender({ workspaceId: "ws-a", summary: { count: 0, bytes: 0 } });
    expect(h.row()).toBeUndefined();
  });

  it("files the row quietly when this computer already told the person", () => {
    const first = harness({ workspaceId: "ws-a", summary: above });
    expect(first.row()?.seen).toBe(false);
    cleanup();
    const second = harness({ workspaceId: "ws-a", summary: above });
    expect(second.row()).toMatchObject({ seen: true });
  });

  it("keeps a dismissed row away until the copies pass the size again", () => {
    const h = harness({ workspaceId: "ws-a", summary: above });
    h.dismiss(h.row()!.id);
    h.rerender({ workspaceId: "ws-a", summary: { ...above, count: 1300 } });
    expect(h.row()).toBeUndefined();
    h.rerender({ workspaceId: "ws-a", summary: { count: 1, bytes: MB } });
    h.rerender({ workspaceId: "ws-a", summary: above });
    expect(h.row()).toMatchObject({ seen: false });
  });

  it("lists the copies, asks, and deletes only what the person confirmed", async () => {
    const h = harness({ workspaceId: "ws-a", summary: above });
    h.run(h.row()!.id);
    const dialog = await screen.findByTestId("retained-copies-confirm");
    expect(dialog.textContent).toContain("Delete 2 old file copies from Notes?");
    expect(dialog.textContent).toContain("Close other programs that use this workspace first.");
    expect(dialog.textContent).toContain("This can't be undone.");
    fireEvent.click(screen.getByTestId("retained-copies-cancel"));
    expect(screen.queryByTestId("retained-copies-confirm")).toBeNull();
    expect(h.bridge.deleteRetainedCopies).not.toHaveBeenCalled();

    h.run(h.row()!.id);
    fireEvent.click(await screen.findByTestId("retained-copies-delete"));
    await waitFor(() => expect(h.errors().some((error) => error.tone === "success")).toBe(true));
    expect(h.bridge.deleteRetainedCopies).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-a",
      copies: [{ id: 3, revision: 10 }, { id: 4, revision: 11 }],
      acceptLateWriteRisk: true,
    });
    expect(h.errors().find((error) => error.tone === "success")?.message).toBe("Deleted 2 old file copies");
    expect(h.row()).toBeUndefined();
  });

  it("deletes in batches of 100 and says how many stay", async () => {
    const h = harness({ workspaceId: "ws-a", summary: above });
    const copies = Array.from({ length: 150 }, (_, id) => ({ id, revision: 1 }));
    h.bridge.listRetainedCopies.mockResolvedValueOnce({ copies, more: false, total: above });
    h.bridge.deleteRetainedCopies
      .mockResolvedValueOnce({ deleted: 99, skipped: 1, failed: 0, remaining: { count: 1051, bytes: above.bytes } })
      .mockResolvedValueOnce({ deleted: 49, skipped: 1, failed: 0, remaining: { count: 1002, bytes: above.bytes } });
    h.run(h.row()!.id);
    expect((await screen.findByTestId("retained-copies-confirm")).textContent).toContain("Delete 150 old file copies");
    fireEvent.click(screen.getByTestId("retained-copies-delete"));
    await waitFor(() => expect(h.errors().some((error) => error.tone === "success")).toBe(true));
    expect(h.bridge.deleteRetainedCopies.mock.calls.map(([input]) => input.copies.length)).toEqual([100, 50]);
    expect(h.errors().find((error) => error.tone === "success")?.message)
      .toBe("Deleted 148 old file copies. 2 stay because they changed or dohc still needs them.");
    expect(h.row()?.title).toBe("1,002 old file copies");
  });

  it("reports a failed delete with Try again, which asks again", async () => {
    const h = harness({ workspaceId: "ws-a", summary: above });
    h.bridge.deleteRetainedCopies.mockRejectedValueOnce(new Error("engine stopped"));
    h.run(h.row()!.id);
    fireEvent.click(await screen.findByTestId("retained-copies-delete"));
    await waitFor(() => expect(h.errors().some((error) => error.retry !== null)).toBe(true));
    const failure = h.errors().find((error) => error.retry !== null)!;
    expect(failure.message).toContain("dohc could not delete old file copies.");
    act(() => { failure.retry!(); });
    expect(await screen.findByTestId("retained-copies-confirm")).toBeTruthy();
    expect(h.bridge.listRetainedCopies).toHaveBeenCalledTimes(2);
  });

  it("drops a listing that answers after the window changed workspaces", async () => {
    const h = harness({ workspaceId: "ws-a", summary: above });
    const listing = deferred<ListRetainedCopiesResult>();
    h.bridge.listRetainedCopies.mockReturnValueOnce(listing.promise);
    h.run(h.row()!.id);
    h.rerender({ workspaceId: "ws-b", summary: undefined });
    await act(async () => listing.resolve({ copies: [{ id: 3, revision: 10 }], more: false, total: above }));
    expect(screen.queryByTestId("retained-copies-confirm")).toBeNull();
    expect(h.errors()).toEqual([]);
  });

  it("closes the question and stops deleting when the window changes workspaces", async () => {
    const h = harness({ workspaceId: "ws-a", summary: above });
    h.run(h.row()!.id);
    await screen.findByTestId("retained-copies-confirm");
    h.rerender({ workspaceId: "ws-b", summary: undefined });
    expect(screen.queryByTestId("retained-copies-confirm")).toBeNull();

    h.rerender({ workspaceId: "ws-a", summary: above });
    const copies = Array.from({ length: 150 }, (_, id) => ({ id, revision: 1 }));
    h.bridge.listRetainedCopies.mockResolvedValueOnce({ copies, more: false, total: above });
    const first = deferred<DeleteRetainedCopiesResult>();
    h.bridge.deleteRetainedCopies.mockReturnValueOnce(first.promise);
    h.run(h.row()!.id);
    fireEvent.click(await screen.findByTestId("retained-copies-delete"));
    await waitFor(() => expect(h.bridge.deleteRetainedCopies).toHaveBeenCalledOnce());
    h.rerender({ workspaceId: "ws-b", summary: undefined });
    await act(async () => first.resolve({ deleted: 100, skipped: 0, failed: 0, remaining: above }));
    expect(h.bridge.deleteRetainedCopies).toHaveBeenCalledOnce();
    expect(h.errors()).toEqual([]);
  });
});
