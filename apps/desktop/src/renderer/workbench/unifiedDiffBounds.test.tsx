// @vitest-environment jsdom
// The two surfaces that draw a unified diff — the history diff page and
// the versions compare page — both ran the diff on every render, unmemoized,
// and both built one object per line of the whole body before the 800-line
// display bound applied. These pin both halves of the fix on both surfaces.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineMomentDetailRecord } from "../../ipc/bridgeContract";

const computeTextDiffSpy = vi.hoisted(() => vi.fn());
vi.mock("./unifiedDiff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./unifiedDiff")>();
  computeTextDiffSpy.mockImplementation(actual.computeTextDiff);
  return { ...actual, computeTextDiff: computeTextDiffSpy };
});

const { EngineMomentDiffPage } = await import("./EngineMomentDiffPage");
const { VersionComparePage } = await import("./WorkspaceVersions");
const { momentDiffTabPath } = await import("./workbenchState");
const noop = () => {};

// 250,000 lines a side, over 10 MiB: newline-heavy, far past the cell ceiling.
function hugeBody(marker: string): string {
  const line = marker.repeat(10);
  const out: string[] = [];
  for (let index = 0; index < 250_000; index += 1) {
    out.push(line + String(index).padStart(12, "0"));
  }
  return out.join("\n") + "\n";
}

function momentDetail(
  overrides: Partial<EngineMomentDetailRecord> = {},
): EngineMomentDetailRecord {
  return {
    id: "m-1",
    versionId: "main",
    path: "notes/plan.md",
    recordedAtMs: 100,
    operation: "write",
    origin: "local-file",
    beforeText: "one\ntwo\n",
    afterText: "one\nthree\n",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("history diff page", () => {
  const bridgeMock = { readEngineMoment: vi.fn() };
  const onError = vi.fn();

  beforeEach(() => {
    bridgeMock.readEngineMoment.mockReset();
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  function renderPage(moment: EngineMomentDetailRecord) {
    bridgeMock.readEngineMoment.mockResolvedValue({ moment });
    const props = {
      workspaceId: "ws-1",
      tabPath: momentDiffTabPath(moment.id),
      onBeforeRestore: async () => () => {},
      onOpenFile: () => {},
      onPathResolved: noop,
      registerActiveUndo: () => {},
      onRestored: () => {},
      onStopAndRestore: () => {},
      onError,
      onSettled: noop,
      historyAnswer: null,
      onReopenRestore: noop,
      restoreRequested: false,
      onRestoreRequestTaken: noop,
    };
    return render(<EngineMomentDiffPage {...props} />);
  }

  it.each([false, true])("announces a completed restore after unmount (undo: %s)", async (undo) => {
    const order: string[] = [];
    let finish!: (value: { restored: "text"; restoredMomentId: string }) => void;
    const pending = new Promise<{ restored: "text"; restoredMomentId: string }>((resolve) => {
      finish = resolve;
    });
    const restoreEngineMomentFile = vi.fn().mockReturnValue(pending);
    if (undo) restoreEngineMomentFile.mockResolvedValueOnce({ restored: "text", restoredMomentId: "undo-1" });
    bridgeMock.readEngineMoment.mockResolvedValue({ moment: momentDetail() });
    vi.stubGlobal("dohcDesktop", { ...bridgeMock, restoreEngineMomentFile });
    const view = render(
      <EngineMomentDiffPage
        workspaceId="ws-1"
        tabPath={momentDiffTabPath("m-1")}
        onBeforeRestore={async () => () => { order.push("release"); }}
        onOpenFile={noop}
        onPathResolved={noop}
        registerActiveUndo={noop}
        onRestored={() => { order.push("restored"); }}
        onStopAndRestore={() => {}}
        onError={noop}
        onSettled={noop}
        historyAnswer={null}
        onReopenRestore={noop}
        restoreRequested={false}
        onRestoreRequestTaken={noop}
      />,
    );
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByTestId("engine-diff-restore-file")); });
    if (undo) {
      expect(order).toEqual(["restored", "release"]);
      order.length = 0;
      await act(async () => { fireEvent.click(screen.getByTestId("engine-diff-undo-restore")); });
    }
    expect(restoreEngineMomentFile).toHaveBeenCalledTimes(undo ? 2 : 1);
    view.unmount();
    await act(async () => { finish({ restored: "text", restoredMomentId: "restore-2" }); await pending; });
    expect(order).toEqual(["restored", "release"]);
  });

  // A failure is the shell's toast and Notices row, so the live region
  // announces only a restore that happened.
  it.each([false, true])("updates an existing live region with the restore outcome (failure: %s)", async (failure) => {
    let resolve!: (result: { restored: "text"; restoredMomentId: string }) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<{ restored: "text"; restoredMomentId: string }>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    vi.stubGlobal("dohcDesktop", { ...bridgeMock, restoreEngineMomentFile: vi.fn().mockReturnValue(pending) });
    renderPage(momentDetail());
    await screen.findByTestId("engine-diff-lines");
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("");
    await act(async () => { fireEvent.click(screen.getByTestId("engine-diff-restore-file")); });
    await act(async () => {
      if (failure) reject(new Error("Could not restore this file."));
      else resolve({ restored: "text", restoredMomentId: "restore-1" });
      await pending.catch(() => undefined);
    });
    expect(screen.getByRole("status")).toBe(status);
    if (failure) {
      expect(status.textContent).toBe("");
      expect(onError).toHaveBeenCalledWith("dohc could not restore notes/plan.md.", expect.any(Error), expect.any(Function), "history-restore:notes/plan.md", "notes/plan.md");
      return;
    }
    expect(onError).not.toHaveBeenCalled();
    expect(status.textContent).toBe("Restored the earlier state. Undo restore is available here.");
    expect(status.contains(screen.getByTestId("engine-diff-restore-status"))).toBe(true);
  });

  // Restore and Undo restore take each other's place, so a press hands the
  // focus over and the keyboard can undo at once.
  it("hands the focus from Restore to Undo restore and back", async () => {
    vi.stubGlobal("dohcDesktop", {
      ...bridgeMock,
      restoreEngineMomentFile: vi.fn().mockResolvedValue({ restored: "text", restoredMomentId: "restore-1" }),
    });
    renderPage(momentDetail());
    await screen.findByTestId("engine-diff-lines");
    screen.getByTestId("engine-diff-restore-file").focus();
    await act(async () => { fireEvent.click(screen.getByTestId("engine-diff-restore-file")); });
    expect(document.activeElement).toBe(screen.getByTestId("engine-diff-undo-restore"));
    await act(async () => { fireEvent.click(screen.getByTestId("engine-diff-undo-restore")); });
    expect(document.activeElement).toBe(screen.getByTestId("engine-diff-restore-file"));
  });

  it("diffs a moment once, however often the page renders", async () => {
    const view = renderPage(momentDetail());
    await screen.findByTestId("engine-diff-lines");
    expect(computeTextDiffSpy).toHaveBeenCalledTimes(1);

    // A render that does not change the moment must not diff it again. This
    // used to run the diff twice per render: once for the counts, once for
    // the lines.
    view.rerender(
      <EngineMomentDiffPage
        workspaceId="ws-1"
        tabPath={momentDiffTabPath("m-1")}
        onBeforeRestore={async () => () => {}}
        onOpenFile={() => {}}
        onPathResolved={noop}
        registerActiveUndo={() => {}}
        onRestored={() => {}}
        onStopAndRestore={() => {}}
        onError={noop}
        onSettled={noop}
        historyAnswer={null}
        onReopenRestore={noop}
        restoreRequested={false}
        onRestoreRequestTaken={noop}
      />,
    );
    await screen.findByTestId("engine-diff-lines");
    expect(computeTextDiffSpy).toHaveBeenCalledTimes(1);
  });

  it("marks the changed words as an insertion and a deletion, not only in color", async () => {
    renderPage(
      momentDetail({
        beforeText: "Goals\n- First document in under 30 seconds\n",
        afterText: "Goals\n- First document in under 20 seconds\n",
      }),
    );
    const body = await screen.findByTestId("engine-diff-lines");
    expect(body.querySelector("del")?.textContent).toBe("30");
    expect(body.querySelector("ins")?.textContent).toBe("20");
    const removed = body.querySelector("[data-kind='removed'] code");
    const added = body.querySelector("[data-kind='added'] code");
    expect(removed?.textContent).toBe("Removed: - First document in under 30 seconds");
    expect(added?.textContent).toBe("Added: - First document in under 20 seconds");
    // Without color: a quiet mark beside each changed line, which screen
    // readers skip because the prefix says it, and a struck-through deletion.
    const mark = (kind: string) => body.querySelector(`[data-kind='${kind}'] > span:nth-child(3)`);
    expect(mark("removed")?.textContent).toBe("−");
    expect(mark("added")?.textContent).toBe("+");
    expect(mark("removed")?.getAttribute("aria-hidden")).toBe("true");
    expect(mark("context")?.textContent).toBe("");
    expect(body.querySelector("del")?.className).not.toContain("no-underline");
    expect(body.querySelector("ins")?.className).toContain("no-underline");
    expect(screen.getByTestId("engine-diff-counts").querySelector(".sr-only")?.textContent).toBe(
      "1 line added, 1 line removed",
    );
  });

  it("sizes Copy your version like the header buttons beside it", async () => {
    renderPage(momentDetail({ origin: "capture-recovery" }));
    const copy = await screen.findByTestId("engine-diff-copy-typing");
    const restore = screen.getByTestId("engine-diff-restore-file");
    for (const size of ["h-7", "text-[11px]"]) {
      expect(restore.className.split(" ")).toContain(size);
      expect(copy.className.split(" ")).toContain(size);
    }
  });

  const bytes = (byteLength: number) => ({ sha256: "a".repeat(64), byteLength });

  it.each([
    ["binary", { beforeText: null, afterText: null, beforeBinary: bytes(10), afterBinary: bytes(12) }, "engine-diff-binary"],
    ["protected", { protected: true, beforeText: null, afterText: null }, "engine-diff-protected"],
  ] as const)("keeps the %s page, with no lines and no counts", async (_kind, overrides, testId) => {
    renderPage(momentDetail(overrides));
    await screen.findByTestId(testId);
    expect(screen.queryByTestId("engine-diff-lines")).toBeNull();
    expect(screen.queryByTestId("engine-diff-counts")).toBeNull();
    expect(screen.getByTestId("engine-diff-restore-file")).toBeTruthy();
  });

  it("keeps a text side readable when the other side became binary", async () => {
    renderPage(momentDetail({ beforeText: "the old words\n", afterText: null, afterBinary: bytes(2048) }));
    await screen.findByTestId("engine-diff-binary-side");
    const lines = screen.getByTestId("engine-diff-lines").querySelectorAll("code");
    expect([...lines].map((line) => line.textContent)).toEqual(["Removed: the old words"]);
  });

  it("draws a 10 MiB moment without building a line per body line", async () => {
    renderPage(
      momentDetail({ beforeText: hugeBody("a"), afterText: hugeBody("b") }),
    );
    const body = await screen.findByTestId("engine-diff-lines");
    // The display bound holds: 800 diff lines plus the note that names the
    // rest. Before the fix this built 500,000 diff lines and 500,000 numbered
    // lines to render the same 801.
    expect(body.children).toHaveLength(801);
    expect(body.textContent).toContain("more diff lines hidden");
    // The counts still describe the whole change, in lines, and say so to a
    // screen reader.
    const counts = screen.getByTestId("engine-diff-counts");
    expect(counts.textContent).toContain("+250000−250000");
    expect(counts.querySelector(".sr-only")?.textContent).toBe(
      "250000 lines added, 250000 lines removed",
    );
  });
});

describe("versions compare page", () => {
  const bridgeMock = {
    listWorkspaceVersions: vi.fn(),
    compareWorkspaceVersions: vi.fn(),
  };

  beforeEach(() => {
    for (const mock of Object.values(bridgeMock)) mock.mockReset();
    bridgeMock.listWorkspaceVersions.mockResolvedValue({
      versions: [
        { id: "main", name: "Main", kind: "main", createdAtMs: 0, canMergeIntoMain: false },
        { id: "v-1", name: "Experiment", kind: "named", createdAtMs: 1, canMergeIntoMain: true },
      ],
      activeVersionId: "v-1",
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  it("diffs each compared file once, however often the page renders", async () => {
    bridgeMock.compareWorkspaceVersions.mockResolvedValue({
      files: [
        {
          path: "notes.md",
          status: "modified",
          currentText: "old text\n",
          incomingText: "new text\n",
        },
      ],
      nextAfterPath: null,
    });
    const view = render(<VersionComparePage workspaceId="ws-1" versionId="v-1" />);
    await screen.findByTestId("version-compare-file");
    expect(computeTextDiffSpy).toHaveBeenCalledTimes(1);

    // A render that does not change the compared bodies must not diff them
    // again. The compare page used to diff every file on every render.
    view.rerender(<VersionComparePage workspaceId="ws-1" versionId="v-1" />);
    await screen.findByTestId("version-compare-file");
    expect(computeTextDiffSpy).toHaveBeenCalledTimes(1);
  });

  it("draws a 10 MiB compared file without building a line per body line", async () => {
    bridgeMock.compareWorkspaceVersions.mockResolvedValue({
      files: [
        {
          path: "huge.md",
          status: "modified",
          currentText: hugeBody("a"),
          incomingText: hugeBody("b"),
        },
      ],
      nextAfterPath: null,
    });
    render(<VersionComparePage workspaceId="ws-1" versionId="v-1" />);
    const body = await screen.findByTestId("version-compare-diff-lines");
    expect(body.children).toHaveLength(801);
    expect(body.textContent).toContain("more diff lines hidden");
  });
});
