// @vitest-environment jsdom
import { act, cleanup, configure, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeptCopy } from "../../ipc/bridgeContract";
import { keptCopyMessage, useKeptCopyNotices } from "./useKeptCopyNotices";
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
  const bridge = {
    listKeptCopies: vi.fn(async () => ({ keptCopies: kept, more: false })),
    saveKeptCopy: vi.fn(async ({ id }: { workspaceId: string; id: number }) => {
      const copy = kept.find((entry) => entry.id === id);
      kept = kept.filter((entry) => entry.id !== id);
      return { path: copy ? copy.path.replace(/\.md$/u, " (kept copy).md") : null };
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
      openFile,
    });
    return { ...errors, refresh };
  });
  return {
    bridge,
    openFile,
    result: rendered.result,
    keep: (copies: KeptCopy[]) => { kept = copies; },
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
});
