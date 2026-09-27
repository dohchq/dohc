// @vitest-environment jsdom
import { act, cleanup, configure, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeptCopy, SaveKeptCopyResult } from "../../ipc/bridgeContract";
import { keptCopyMessage, keptCopyNoNameMessage, useKeptCopyNotices } from "./useKeptCopyNotices";
import { useShellError } from "./useShellError";

// These wait on async bridge answers; every wait runs until its condition
// holds, within the test's own budget.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function harness(initial: KeptCopy[]) {
  let kept = initial;
  let more = false;
  const bridge = {
    listKeptCopies: vi.fn(async () => ({ keptCopies: kept, more })),
    saveKeptCopy: vi.fn(async ({ id }: { workspaceId: string; id: number }): Promise<SaveKeptCopyResult> => {
      const copy = kept.find((entry) => entry.id === id);
      kept = kept.filter((entry) => entry.id !== id);
      return copy
        ? { status: "saved", path: copy.path.replace(/\.md$/u, " (kept copy).md") }
        : { status: "gone" };
    }),
  };
  vi.stubGlobal("dohcDesktop", bridge);
  const openFile = vi.fn<(path: string) => void>();
  const rendered = renderHook(() => {
    const errors = useShellError("ws-a");
    const refresh = useKeptCopyNotices({
      workspaceId: "ws-a",
      workspaceIsReady: true,
      show: errors.showKeptCopies,
      showSaved: errors.showKeptCopySaved,
      reportShellError: errors.reportShellError,
      reportFailure: (message, retry) => errors.reportShellFailure({ message, retry }),
      openFile,
    });
    return { ...errors, refresh };
  });
  return {
    bridge,
    openFile,
    result: rendered.result,
    keep: (copies: KeptCopy[], past = false) => { kept = copies; more = past; },
  };
}

describe("useKeptCopyNotices", () => {
  it("shows each kept copy as a row whose Save copy saves it, clears the row, and opens the copy", async () => {
    const h = harness([{ id: 3, path: "notes/a.md", keptAtMs: 1 }]);
    await waitFor(() => expect(h.result.current.shellErrors).toHaveLength(1));
    const row = h.result.current.shellErrors[0]!;
    expect(row.message).toBe(
      "Another program changed notes/a.md while dohc was saving it. dohc kept both copies.",
    );
    expect(row.message).toBe(keptCopyMessage("notes/a.md"));
    expect(row.seen).toBe(false);
    expect(row.action?.label).toBe("Save copy");

    act(() => h.result.current.runShellErrorAction(row.id));
    await waitFor(() =>
      expect(h.result.current.shellErrors.map((error) => error.message)).toEqual([
        "Saved the other copy of notes/a.md as notes/a (kept copy).md",
      ]));
    expect(h.bridge.saveKeptCopy).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-a", id: 3 });

    const saved = h.result.current.shellErrors[0]!;
    expect(saved.tone).toBe("success");
    act(() => h.result.current.runShellErrorAction(saved.id));
    expect(h.openFile).toHaveBeenCalledExactlyOnceWith("notes/a (kept copy).md");
    expect(h.result.current.shellErrors).toEqual([]);
  });

  it("adds a copy kept later on a refresh, and leaves a dismissed row dismissed", async () => {
    const h = harness([{ id: 3, path: "a.md", keptAtMs: 1 }]);
    await waitFor(() => expect(h.result.current.shellErrors).toHaveLength(1));
    act(() => h.result.current.dismissShellError(h.result.current.shellErrors[0]!.id));

    h.keep([{ id: 3, path: "a.md", keptAtMs: 1 }, { id: 4, path: "b.md", keptAtMs: 2 }]);
    await act(async () => await h.result.current.refresh());
    expect(h.result.current.shellErrors.map((error) => error.message)).toEqual([keptCopyMessage("b.md")]);

    // A copy saved elsewhere, by an agent for example, loses its row.
    h.keep([{ id: 3, path: "a.md", keptAtMs: 1 }]);
    await act(async () => await h.result.current.refresh());
    expect(h.result.current.shellErrors).toEqual([]);
  });

  it("keeps the row and offers Try again when the save fails", async () => {
    const h = harness([{ id: 3, path: "a.md", keptAtMs: 1 }]);
    h.bridge.saveKeptCopy.mockRejectedValueOnce(new Error("Another program has a.md open."));
    await waitFor(() => expect(h.result.current.shellErrors).toHaveLength(1));
    const row = h.result.current.shellErrors[0]!;

    act(() => h.result.current.runShellErrorAction(row.id));
    await waitFor(() => expect(h.result.current.shellErrors).toHaveLength(2));
    const failure = h.result.current.shellErrors[1]!;
    expect(failure.message).toContain("dohc could not save the other copy of a.md.");
    expect(failure.retry).not.toBeNull();
    expect(h.result.current.shellErrors[0]!.id).toBe(row.id);

    act(() => h.result.current.retryShellError(failure.id));
    await waitFor(() =>
      expect(h.result.current.shellErrors.map((error) => error.message)).toEqual([
        "Saved the other copy of a.md as a (kept copy).md",
      ]));
  });

  it("says so when the copy was already saved or removed", async () => {
    const h = harness([{ id: 3, path: "a.md", keptAtMs: 1 }]);
    h.bridge.saveKeptCopy.mockResolvedValueOnce({ status: "gone" });
    await waitFor(() => expect(h.result.current.shellErrors).toHaveLength(1));
    h.keep([]);

    act(() => h.result.current.runShellErrorAction(h.result.current.shellErrors[0]!.id));
    await waitFor(() =>
      expect(h.result.current.shellErrors.map((error) => error.message)).toEqual([
        "The other copy of a.md was already saved or removed.",
      ]));
    expect(h.result.current.shellErrors[0]!.action).toBeUndefined();
  });

  it("announces several copies with one toast, keeps a row each, and a row for copies past the list", async () => {
    const h = harness([
      { id: 3, path: "a.md", keptAtMs: 1 },
      { id: 4, path: "b.md", keptAtMs: 2 },
    ]);
    await waitFor(() => expect(h.result.current.shellErrors).toHaveLength(3));
    h.keep([{ id: 3, path: "a.md", keptAtMs: 1 }, { id: 4, path: "b.md", keptAtMs: 2 }], true);
    await act(async () => await h.result.current.refresh());
    await act(async () => await h.result.current.refresh());
    const rows = h.result.current.shellErrors.map(({ message, seen }) => ({ message, seen }));
    expect(rows).toEqual([
      { message: keptCopyMessage("a.md"), seen: true },
      { message: keptCopyMessage("b.md"), seen: true },
      { message: "dohc kept 2 copies of files other programs changed.", seen: false },
      { message: "dohc kept more copies than Notices can list. Save these copies to see the rest.", seen: true },
    ]);

    // Once every copy is saved, the summary and the overflow row go too.
    h.keep([]);
    await act(async () => await h.result.current.refresh());
    expect(h.result.current.shellErrors).toEqual([]);
  });

  it("keeps the row and says why when no name beside the file fits", async () => {
    const h = harness([{ id: 3, path: "a.md", keptAtMs: 1 }]);
    h.bridge.saveKeptCopy.mockResolvedValueOnce({ status: "no-valid-name" });
    await waitFor(() => expect(h.result.current.shellErrors).toHaveLength(1));
    const row = h.result.current.shellErrors[0]!;

    act(() => h.result.current.runShellErrorAction(row.id));
    await waitFor(() => expect(h.result.current.shellErrors).toHaveLength(2));
    const failure = h.result.current.shellErrors[1]!;
    expect(failure.message).toBe(keptCopyNoNameMessage("a.md"));
    expect(failure.message).toBe(
      "dohc could not save the other copy of a.md: no name beside it is short enough. Rename a.md or its folder to something shorter, then try again.",
    );
    expect(failure.retry).not.toBeNull();
    expect(h.result.current.shellErrors[0]!.id).toBe(row.id);
  });
});

it("leaves adopted copies without an original path to the recovery-folder notice", async () => {
  const h = harness([
    { id: 1, path: "", keptAtMs: 1 },
    { id: 2, path: "a.md", keptAtMs: 2 },
  ]);
  await waitFor(() => expect(h.result.current.shellErrors).toHaveLength(1));
  expect(h.result.current.shellErrors[0]!.message).toBe(keptCopyMessage("a.md"));
});
