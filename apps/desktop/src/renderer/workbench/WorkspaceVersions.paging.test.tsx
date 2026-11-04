// @vitest-environment jsdom
// Conflict and compare IPC results are page-shaped. These pin the two
// surfaces' ends of that contract: the loaded window paints, "Show more
// files" fetches the next page with the continuation, and the count copy
// never states a number that could be under the truth.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { useFocusSurface } from "../ui/focusReturn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceVersionConflict } from "../../ipc/bridgeContract";
import { readError } from "../../ipc/errorWords";
import { WORKSPACE_ACTIVITY_REFRESH_DELAY_MS } from "../workspaceActivityCoalescer";
import {
  ConflictReviewDialog,
  VersionComparePage,
  VersionMergeDialog,
  conflictCountCopy,
} from "./WorkspaceVersions";
import { VersionMenuHarness } from "./WorkspaceVersions.testHarness";
import { beginCollectionLineageOperation } from "../collections/collectionLineageGate";
import {
  beginCollectionWriteOperation,
  collectionWriteFailures,
  collectionWritesPaused,
  enqueueCollectionFieldWrite,
  resetCollectionFieldWritesForTests,
} from "../collections/recordFieldWrites";

function conflict(id: string): WorkspaceVersionConflict {
  return {
    conflictId: id,
    path: `${id}.md`,
    sourceVersionId: "v-1",
    targetVersionId: "main",
    origin: "merge",
    contentKind: "text",
    currentText: "main side\n",
    incomingText: "feature side\n",
    baseText: null,
    waitingVersion: null,
  };
}

function syncConflict(id: string): WorkspaceVersionConflict {
  return { ...conflict(id), origin: "sync" };
}

// findBy/waitFor deadlines are wall-clock, so a loaded machine can spend
// them before the event loop returns to the render. Every async path here is a
// mocked bridge call, so drive it to its end instead of waiting on a clock:
// this drains the pending answers and React's work, and every assertion after
// it is synchronous.
async function settle() {
  await act(async () => {});
}

type ActivityListener = (event: { workspaceId?: string; paths?: string[] }) => void;
const activityListeners = new Set<ActivityListener>();

const bridgeMock = {
  listWorkspaceVersions: vi.fn(),
  listWorkspaceVersionConflicts: vi.fn(),
  resolveWorkspaceVersionConflict: vi.fn(),
  compareWorkspaceVersions: vi.fn(),
  mergeWorkspaceVersion: vi.fn(),
  onWorkspaceActivity: vi.fn(),
};

beforeEach(() => {
  for (const mock of Object.values(bridgeMock)) mock.mockReset();
  activityListeners.clear();
  bridgeMock.onWorkspaceActivity.mockImplementation((listener: ActivityListener) => {
    activityListeners.add(listener);
    return () => activityListeners.delete(listener);
  });
  bridgeMock.listWorkspaceVersions.mockResolvedValue({
    versions: [
      { id: "main", name: "Main", kind: "main", createdAtMs: 0, canMergeIntoMain: false },
      { id: "v-1", name: "Feature", kind: "named", createdAtMs: 1, canMergeIntoMain: true },
    ],
    activeVersionId: "v-1",
  });
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  cleanup();
  resetCollectionFieldWritesForTests();
  vi.unstubAllGlobals();
});

describe.each(["review", "merge"] as const)("%s conflict resolution write boundary", (surface) => {
  const remaining = { conflicts: [], nextAfterConflictId: null };

  async function openSurface(beginLineageOperation: () => Promise<() => void>, changed: () => void, row = conflict("c-1"), onError = vi.fn()) {
    const conflicts = [row];
    bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({ conflicts, nextAfterConflictId: null });
    bridgeMock.mergeWorkspaceVersion.mockResolvedValue({
      mergedFileCount: 0, unchangedFileCount: 0, conflictCount: 1, replacedProtectedPaths: [], conflicts, nextAfterConflictId: null,
    });
    // The initial merge's gate has already released when its conflict cards appear.
    const mergeBegin = vi.fn().mockResolvedValueOnce(() => {}).mockImplementation(beginLineageOperation);
    const mergeChanged = vi.fn().mockImplementationOnce(() => {}).mockImplementation(changed);
    const view = render(surface === "review" ? (
      <ConflictReviewDialog workspaceId="ws-1" beginLineageOperation={beginLineageOperation}
        onWorkspaceStateChanged={changed} onClose={() => {}} onError={onError} />
    ) : (
      <VersionMergeDialog workspaceId="ws-1"
        source={{ id: "v-1", name: "Feature", kind: "named", createdAtMs: 1, canMergeIntoMain: true }}
        beginLineageOperation={mergeBegin}
        onWorkspaceStateChanged={mergeChanged} onMerged={() => {}} onAnsweredAway={() => {}} onConflictError={onError}
        onClose={() => {}} />
    ));
    if (surface === "merge") fireEvent.click(screen.getByTestId("version-merge-confirm"));
    await settle();
    return view;
  }

  it("refuses resolution over retained input without advancing its lineage", async () => {
    const changed = vi.fn();
    await openSurface(() => beginCollectionLineageOperation("ws-1"), changed);
    const paused = beginCollectionWriteOperation("ws-1");
    enqueueCollectionFieldWrite("ws-1", "tasks", {
      recordId: "rec-1", recordPath: "tasks/one.md", field: "done", value: true,
    });
    paused.release();
    const failure = collectionWriteFailures()[0];
    fireEvent.click(screen.getByTestId("version-conflict-keep-current"));
    await settle();

    expect(bridgeMock.resolveWorkspaceVersionConflict).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(collectionWriteFailures()).toEqual([failure]);
    expect(screen.getByTestId("version-conflict-error").textContent).toContain("Retry or discard it");
    expect(collectionWritesPaused("ws-1")).toBe(false);
  });

  it.each([false, true])("holds the pause through successful resolution (unmount during IPC: %s)", async (unmount) => {
    let finishFlush!: () => void;
    const flush = new Promise<void>((resolve) => { finishFlush = resolve; });
    let finishResolution!: (value: typeof remaining) => void;
    bridgeMock.resolveWorkspaceVersionConflict.mockReturnValue(new Promise((resolve) => { finishResolution = resolve; }));
    const changed = vi.fn(() => { expect(collectionWritesPaused("ws-1")).toBe(true); });
    const view = await openSurface(() => beginCollectionLineageOperation("ws-1", () => flush), changed);
    fireEvent.click(screen.getByTestId("version-conflict-keep-current"));
    expect(collectionWritesPaused("ws-1")).toBe(true);
    expect(bridgeMock.resolveWorkspaceVersionConflict).not.toHaveBeenCalled();

    await act(async () => { finishFlush(); await flush; });
    expect(bridgeMock.resolveWorkspaceVersionConflict).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1", conflictId: "c-1", resolution: { kind: "keep-current" },
    });
    expect(collectionWritesPaused("ws-1")).toBe(true);
    if (unmount) view.unmount();
    await act(async () => { finishResolution(remaining); });
    expect(changed).toHaveBeenCalledOnce();
    expect(collectionWritesPaused("ws-1")).toBe(false);
  });

  it("cancels before issuing resolution if the dialog closes during the drain", async () => {
    let finishFlush!: () => void;
    const flush = new Promise<void>((resolve) => { finishFlush = resolve; });
    const changed = vi.fn();
    const view = await openSurface(() => beginCollectionLineageOperation("ws-1", () => flush), changed);
    fireEvent.click(screen.getByTestId("version-conflict-keep-current"));
    view.unmount();
    await act(async () => { finishFlush(); await flush; });
    expect(bridgeMock.resolveWorkspaceVersionConflict).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(collectionWritesPaused("ws-1")).toBe(false);
  });

  it("releases the pause and reopens the editors after a failed resolution", async () => {
    bridgeMock.resolveWorkspaceVersionConflict.mockRejectedValue(new Error("Resolution refused"));
    const changed = vi.fn(() => { expect(collectionWritesPaused("ws-1")).toBe(true); });
    await openSurface(() => beginCollectionLineageOperation("ws-1"), changed);
    fireEvent.click(screen.getByTestId("version-conflict-keep-current"));
    await settle();
    expect(screen.getByTestId("version-conflict-error").textContent).toBe("Resolution refused");
    // Main closed the open documents before the resolve failed.
    expect(changed).toHaveBeenCalledOnce();
    expect(collectionWritesPaused("ws-1")).toBe(false);
  });

  it("shows the synced deletion refusal beside the conflict choice", async () => {
    bridgeMock.resolveWorkspaceVersionConflict.mockRejectedValue(new Error("DaemonRefusalError [INVALID_PARAMS]: synced-deletion-revival-refused"));
    const report = vi.fn();
    await openSurface(async () => () => {}, vi.fn(), conflict("c-1"), report);
    fireEvent.click(screen.getByTestId("version-conflict-keep-current"));
    await settle();
    expect(screen.getByTestId("version-conflict-error").textContent).toBe("dohc can't bring back c-1.md, because that could stop sync");
    const notice = readError(report.mock.calls[0]![1]);
    expect(notice.words).toBe("Choose Keep this machine's copy, then copy its text from its History into a file with a new name. When your other machine shows a conflict for c-1.md, keep the removal there.");
    expect(notice.canRetry).toBe(false);
  });

  it.each(["sync-delete", "sync-edit", "merge-delete"].flatMap(shape =>
    ["DaemonRefusalError [INVALID_PARAMS]", "VersionedTextStoreError [conflict-stale-target]"].map(wire => ({shape, wire})),
  ))("scopes stale deletion words to $shape ($wire)", async ({shape, wire}) => {
    const row = conflict("c-1");
    row.origin = shape === "merge-delete" ? "merge" : "sync";
    row.incomingText = shape === "sync-edit" ? "other text" : null;
    bridgeMock.resolveWorkspaceVersionConflict.mockRejectedValue(new Error(`${wire}: conflict-stale-target`));
    const report = vi.fn();
    await openSurface(async () => () => {}, vi.fn(), row, report);
    fireEvent.click(screen.getByTestId("version-conflict-keep-current"));
    await settle();
    const title = "dohc can't settle the conflict in c-1.md";
    expect(screen.getByTestId("version-conflict-error").textContent).toBe(shape === "sync-delete" ? title : "dohc could not apply that choice.");
    expect(report).toHaveBeenCalled();
    if (shape === "sync-delete") {
      const notice = readError(report.mock.calls[0]![1]);
      expect(notice.words).toBe("Move your newer lines into the new file, and leave c-1.md and its copies alone. Your other files keep syncing.");
      expect(notice.canRetry).toBe(false);
      expect(notice.cause).toContain("changed on this machine after the conflict appeared");
    }
  });
});

describe("conflictCountCopy", () => {
  it("states the exact count only when the listing is complete", () => {
    expect(conflictCountCopy(1, false)).toBe("One file has two copies.");
    expect(conflictCountCopy(3, false)).toBe("3 files have two copies.");
    // A continuation means more conflicts exist past the window, so an exact
    // "3 files" would be under the truth.
    expect(conflictCountCopy(1, true)).toBe("More than one file has two copies.");
    expect(conflictCountCopy(3, true)).toBe("More than 3 files have two copies.");
  });
});

describe("ConflictReviewDialog paging", () => {
  it("labels a sync conflict as two machines, not two versions", async () => {
    bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({
      conflicts: [syncConflict("sync-c-1")],
      nextAfterConflictId: null,
    });
    render(
      <ConflictReviewDialog beginLineageOperation={async () => () => {}}
        workspaceId="ws-1"
        onWorkspaceStateChanged={() => {}}
        onClose={() => {}}
      />,
    );
    await settle();

    expect(screen.getByText("On this machine")).toBeTruthy();
    expect(screen.getByText("On your other machine")).toBeTruthy();
    expect(screen.queryByText("Main")).toBeNull();
    expect(screen.queryByText("Feature")).toBeNull();
  });

  it("loads the next page with the continuation and appends it", async () => {
    bridgeMock.listWorkspaceVersionConflicts.mockImplementation(
      async (payload: { afterConflictId?: string }) =>
        payload.afterConflictId === undefined
          ? { conflicts: [conflict("c-1")], nextAfterConflictId: "c-1" }
          : { conflicts: [conflict("c-2")], nextAfterConflictId: null },
    );
    render(
      <ConflictReviewDialog beginLineageOperation={async () => () => {}}
        workspaceId="ws-1"
        onWorkspaceStateChanged={() => {}}
        onClose={() => {}}
      />,
    );
    await settle();
    screen.getByText("More than one file has two copies.", { exact: false });
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("conflict-list-show-more"));
    await settle();
    screen.getByText("2 files have two copies.", { exact: false });
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(2);
    // The window is complete now: the affordance goes away.
    expect(screen.queryByTestId("conflict-list-show-more")).toBeNull();
    expect(bridgeMock.listWorkspaceVersionConflicts.mock.calls).toEqual([
      [{ workspaceId: "ws-1" }],
      [{ workspaceId: "ws-1", afterConflictId: "c-1" }],
    ]);
  });

  it("replaces the window with the page a resolution returns", async () => {
    bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({
      conflicts: [conflict("c-1"), conflict("c-2")],
      nextAfterConflictId: null,
    });
    bridgeMock.resolveWorkspaceVersionConflict.mockResolvedValue({
      conflicts: [conflict("c-2")],
      nextAfterConflictId: null,
    });
    render(
      <ConflictReviewDialog beginLineageOperation={async () => () => {}}
        workspaceId="ws-1"
        onWorkspaceStateChanged={() => {}}
        onClose={() => {}}
      />,
    );
    await settle();
    fireEvent.click(
      screen.getAllByTestId("version-conflict-keep-current")[0]!,
    );
    await settle();
    screen.getByText("One file has two copies.", { exact: false });
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(1);
  });

  it("drops a page answered after a resolution replaced the window", async () => {
    // Show more is in flight when a resolution replaces the window with the
    // first page of what remains. The old window's rows were repositioned —
    // appending the stale page would duplicate or resurrect them.
    let resolveStalePage:
      | ((page: {
          conflicts: WorkspaceVersionConflict[];
          nextAfterConflictId: string | null;
        }) => void)
      | null = null;
    bridgeMock.listWorkspaceVersionConflicts.mockImplementation(
      async (payload: { afterConflictId?: string }) => {
        if (payload.afterConflictId === undefined) {
          return {
            conflicts: [conflict("c-1"), conflict("c-2")],
            nextAfterConflictId: "c-2",
          };
        }
        return new Promise((resolve) => {
          resolveStalePage = resolve;
        });
      },
    );
    bridgeMock.resolveWorkspaceVersionConflict.mockResolvedValue({
      conflicts: [conflict("c-2")],
      nextAfterConflictId: null,
    });
    render(
      <ConflictReviewDialog beginLineageOperation={async () => () => {}}
        workspaceId="ws-1"
        onWorkspaceStateChanged={() => {}}
        onClose={() => {}}
      />,
    );
    await settle();
    fireEvent.click(screen.getByTestId("conflict-list-show-more"));
    fireEvent.click(
      screen.getAllByTestId("version-conflict-keep-current")[0]!,
    );
    await settle();
    screen.getByText("One file has two copies.", { exact: false });

    resolveStalePage!({
      conflicts: [conflict("c-3")],
      nextAfterConflictId: null,
    });
    // Let the stale answer's whole continuation run before asserting — a
    // waitFor here would pass on the first paint and never see the append.
    await settle();
    expect(screen.getAllByTestId("version-conflict"), "drop the window-generation guard -> c-3 (a row of the replaced window) appends to the remaining page.").toHaveLength(1);
  });

  it("a replaced window does not inherit the abandoned page's Loading state", async () => {
    // Show more hangs; a resolution replaces the window with a continuation.
    // The new window's button must be usable immediately — not "Loading…"
    // until a request that may never settle does.
    bridgeMock.listWorkspaceVersionConflicts.mockImplementation(
      async (payload: { afterConflictId?: string }) => {
        if (payload.afterConflictId === undefined) {
          return {
            conflicts: [conflict("c-1"), conflict("c-2")],
            nextAfterConflictId: "c-2",
          };
        }
        // Every continuation fetch hangs: the stale one and any new one —
        // only the pending flag is under test here.
        return new Promise(() => {});
      },
    );
    bridgeMock.resolveWorkspaceVersionConflict.mockResolvedValue({
      conflicts: [conflict("c-2")],
      nextAfterConflictId: "c-2",
    });
    render(
      <ConflictReviewDialog beginLineageOperation={async () => () => {}}
        workspaceId="ws-1"
        onWorkspaceStateChanged={() => {}}
        onClose={() => {}}
      />,
    );
    await settle();
    fireEvent.click(screen.getByTestId("conflict-list-show-more"));
    fireEvent.click(
      screen.getAllByTestId("version-conflict-keep-current")[0]!,
    );
    await settle();
    screen.getByText("More than one file has two copies.", { exact: false });

    const showMore = screen.getByTestId(
      "conflict-list-show-more",
    ) as HTMLButtonElement;
    expect(showMore.textContent, "clear loadingMore only in the abandoned request's finally -> the button reads 'Loading…', disabled, forever (the request never settles) and this assertion fails.").toBe("Show more files");
    expect(showMore.disabled).toBe(false);
  });

  it("says what failed when the next page does not load, and keeps the retry", async () => {
    bridgeMock.listWorkspaceVersionConflicts.mockImplementation(
      async (payload: { afterConflictId?: string }) => {
        if (payload.afterConflictId === undefined) {
          return { conflicts: [conflict("c-1")], nextAfterConflictId: "c-1" };
        }
        throw new Error("daemon busy");
      },
    );
    render(
      <ConflictReviewDialog beginLineageOperation={async () => () => {}}
        workspaceId="ws-1"
        onWorkspaceStateChanged={() => {}}
        onClose={() => {}}
      />,
    );
    await settle();
    fireEvent.click(screen.getByTestId("conflict-list-show-more"));
    await settle();
    screen.getByRole("alert");
    // The window is unchanged and the button remains for a retry.
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(1);
    const showMore = screen.getByTestId(
      "conflict-list-show-more",
    ) as HTMLButtonElement;
    expect(showMore.textContent, "clear loadingMore only in the success path -> the button reads 'Loading…', disabled, forever after a failed page and this assertion fails.").toBe("Show more files");
    expect(showMore.disabled).toBe(false);
  });
});

describe("VersionMergeDialog conflict paging", () => {
  const source = {
    id: "v-1",
    name: "Feature",
    kind: "named" as const,
    createdAtMs: 1,
    canMergeIntoMain: true,
  };

  function renderMerge() {
    render(
      <VersionMergeDialog
        workspaceId="ws-1"
        source={source}
        beginLineageOperation={async () => () => {}}
        onWorkspaceStateChanged={() => {}}
        onMerged={() => {}}
        onAnsweredAway={() => {}}
        onConflictError={() => {}}
        onClose={() => {}}
      />,
    );
  }

  it("the merge's own count decides the stage, not the open-conflict rows", async () => {
    // The rows are the first page of all open conflicts — the contract
    // (MergeWorkspaceVersionResult) says a sync conflict can ride along. A
    // merge that itself conflicted nothing must stay clean.
    bridgeMock.mergeWorkspaceVersion.mockResolvedValue({
      mergedFileCount: 2,
      unchangedFileCount: 0,
      conflictCount: 0,
      replacedProtectedPaths: [],
      conflicts: [{ ...conflict("c-sync"), origin: "sync" }],
      nextAfterConflictId: null,
    });
    renderMerge();
    fireEvent.click(screen.getByTestId("version-merge-confirm"));
    await settle();
    screen.getByText("Merged 2 files into Main");
  });

  it("pages the conflicts stage through the open-conflict listing", async () => {
    bridgeMock.mergeWorkspaceVersion.mockResolvedValue({
      mergedFileCount: 0,
      unchangedFileCount: 0,
      conflictCount: 2,
      replacedProtectedPaths: [],
      conflicts: [conflict("c-1")],
      nextAfterConflictId: "c-1",
    });
    bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({
      conflicts: [conflict("c-2")],
      nextAfterConflictId: null,
    });
    renderMerge();
    fireEvent.click(screen.getByTestId("version-merge-confirm"));
    await settle();
    screen.getByText("More than one file has two copies.", { exact: false });
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("conflict-list-show-more"));
    await settle();
    screen.getByText("2 files have two copies.", { exact: false });
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(2);
    expect(bridgeMock.listWorkspaceVersionConflicts.mock.calls).toEqual([
      [{ workspaceId: "ws-1", afterConflictId: "c-1" }],
    ]);
  });

  it("a conflicted merge whose conflicts are already resolved reads as resolved", async () => {
    // conflictCount > 0 with an empty terminal page: every conflict was
    // resolved elsewhere between the merge and the listing. A zero-card
    // decide stage would ask for decisions that no longer exist.
    bridgeMock.mergeWorkspaceVersion.mockResolvedValue({
      mergedFileCount: 0,
      unchangedFileCount: 0,
      conflictCount: 2,
      replacedProtectedPaths: [],
      conflicts: [],
      nextAfterConflictId: null,
    });
    renderMerge();
    fireEvent.click(screen.getByTestId("version-merge-confirm"));
    await settle();
    screen.getByText("Merged Feature into Main");
    expect(screen.queryByTestId("version-conflict")).toBeNull();
  });

  it("drops a page answered after a resolution replaced the window", async () => {
    // Same replacement rule as the review dialog, pinned here because this
    // dialog has its own generation guard: a Show more in flight when a
    // resolution replaces the window must not resurrect the replaced
    // window's rows.
    bridgeMock.mergeWorkspaceVersion.mockResolvedValue({
      mergedFileCount: 0,
      unchangedFileCount: 0,
      conflictCount: 2,
      replacedProtectedPaths: [],
      conflicts: [conflict("c-1"), conflict("c-2")],
      nextAfterConflictId: "c-2",
    });
    let resolveStalePage:
      | ((page: {
          conflicts: WorkspaceVersionConflict[];
          nextAfterConflictId: string | null;
        }) => void)
      | null = null;
    bridgeMock.listWorkspaceVersionConflicts.mockImplementation(
      async () =>
        new Promise((resolve) => {
          resolveStalePage = resolve;
        }),
    );
    bridgeMock.resolveWorkspaceVersionConflict.mockResolvedValue({
      conflicts: [conflict("c-2")],
      nextAfterConflictId: null,
    });
    renderMerge();
    fireEvent.click(screen.getByTestId("version-merge-confirm"));
    await settle();
    fireEvent.click(screen.getByTestId("conflict-list-show-more"));
    fireEvent.click(
      screen.getAllByTestId("version-conflict-keep-current")[0]!,
    );
    await settle();
    screen.getByText("One file has two copies.", { exact: false });

    resolveStalePage!({
      conflicts: [conflict("c-3")],
      nextAfterConflictId: null,
    });
    // Let the stale answer's whole continuation run before asserting — a
    // waitFor here would pass on the first paint and never see the append.
    await settle();
    expect(screen.getAllByTestId("version-conflict"), "drop this dialog's window-generation guard -> c-3 (a row of the replaced window) appends to the remaining page.").toHaveLength(1);
  });
});

describe("VersionComparePage paging", () => {
  function compareRow(path: string) {
    return {
      path,
      status: "modified" as const,
      currentText: "old\n",
      incomingText: "new\n",
    };
  }

  it("drops an initial comparison answered after the version changes", async () => {
    let resolveFirst!: (page: {
      files: Array<ReturnType<typeof compareRow>>;
      nextAfterPath: string | null;
    }) => void;
    const first = new Promise<{
      files: Array<ReturnType<typeof compareRow>>;
      nextAfterPath: string | null;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    bridgeMock.listWorkspaceVersions
      .mockResolvedValueOnce({
        versions: [
          {
            id: "v-1",
            name: "First",
            kind: "named",
            createdAtMs: 1,
            canMergeIntoMain: true,
          },
        ],
        activeVersionId: "v-1",
      })
      .mockResolvedValueOnce({
        versions: [
          {
            id: "v-2",
            name: "Second",
            kind: "named",
            createdAtMs: 2,
            canMergeIntoMain: true,
          },
        ],
        activeVersionId: "v-2",
      });
    bridgeMock.compareWorkspaceVersions
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({
        files: [compareRow("second.md")],
        nextAfterPath: null,
      });
    const view = render(
      <VersionComparePage workspaceId="ws-1" versionId="v-1" />,
    );

    view.rerender(<VersionComparePage workspaceId="ws-1" versionId="v-2" />);
    await settle();
    screen.getByRole("heading", { name: "Second Differences with Main" });

    resolveFirst({ files: [compareRow("first.md")], nextAfterPath: null });
    await settle();

    screen.getByRole("heading", { name: "Second Differences with Main" });
    expect(
      screen.getByTestId("version-compare-file").dataset.comparePath,
      "omit the response guard's cleanup invalidation. The first comparison replaces the second version's heading and file here.",
    ).toBe("second.md");
  });

  it("shows the comparison error when an invoke throws synchronously", async () => {
    bridgeMock.compareWorkspaceVersions.mockImplementation(() => {
      throw new Error();
    });

    render(<VersionComparePage workspaceId="ws-1" versionId="v-1" />);
    await settle();

    expect(screen.getByRole("alert").textContent).toBe(
      "Could not compare with Main.",
    );
  });

  it("appends the next page with the continuation and updates the count copy", async () => {
    bridgeMock.compareWorkspaceVersions.mockImplementation(
      async (payload: { afterPath?: string }) =>
        payload.afterPath === undefined
          ? { files: [compareRow("a.md")], nextAfterPath: "a.md" }
          : { files: [compareRow("b.md")], nextAfterPath: null },
    );
    render(<VersionComparePage workspaceId="ws-1" versionId="v-1" />);
    await settle();
    expect(screen.getByTestId("version-compare-count").textContent).toBe("1+ files");

    fireEvent.click(screen.getByTestId("version-compare-show-more"));
    await settle();
    expect(screen.getByTestId("version-compare-count").textContent).toBe("2 files");
    expect(screen.getAllByTestId("version-compare-file")).toHaveLength(2);
    expect(screen.queryByTestId("version-compare-show-more")).toBeNull();
    expect(bridgeMock.compareWorkspaceVersions.mock.calls).toEqual([
      [{ workspaceId: "ws-1", versionId: "v-1" }],
      [{ workspaceId: "ws-1", versionId: "v-1", afterPath: "a.md" }],
    ]);
  });

  it("drops a page answered after a refresh replaced the comparison", async () => {
    // A refreshed comparison can hand out the same cursor again, so only the
    // window generation can tell the stale answer from a current one.
    let resolveStalePage:
      | ((page: {
          files: Array<ReturnType<typeof compareRow>>;
          nextAfterPath: string | null;
        }) => void)
      | null = null;
    bridgeMock.compareWorkspaceVersions.mockImplementation(
      async (payload: { afterPath?: string }) => {
        if (payload.afterPath === undefined) {
          return { files: [compareRow("a.md")], nextAfterPath: "a.md" };
        }
        return new Promise((resolve) => {
          resolveStalePage = resolve;
        });
      },
    );
    render(<VersionComparePage workspaceId="ws-1" versionId="v-1" />);
    await settle();
    fireEvent.click(screen.getByTestId("version-compare-show-more"));
    fireEvent.click(screen.getByTestId("version-compare-refresh"));
    await settle();
    screen.getByTestId("version-compare-file");

    // The replaced window must not inherit the abandoned page's pending
    // flag: the stale request is still unsettled here, and the button must
    // already be usable.
    const showMore = screen.getByTestId(
      "version-compare-show-more",
    ) as HTMLButtonElement;
    expect(showMore.textContent).toBe("Show more files");
    expect(showMore.disabled).toBe(false);

    resolveStalePage!({ files: [compareRow("b.md")], nextAfterPath: null });
    // Let the stale answer's whole continuation run before asserting — a
    // waitFor here would pass on the first paint and never see the append.
    await settle();
    expect(screen.getAllByTestId("version-compare-file"), "drop the window-generation guard -> the old generation's page appends to the refreshed window (the cursor matches, so a cursor check alone cannot reject it).").toHaveLength(1);
    expect(screen.getByTestId("version-compare-show-more")).toBeTruthy();
  });

  it("keeps the loaded window and the retry when the next page fails", async () => {
    bridgeMock.compareWorkspaceVersions.mockImplementation(
      async (payload: { afterPath?: string }) => {
        if (payload.afterPath === undefined) {
          return { files: [compareRow("a.md")], nextAfterPath: "a.md" };
        }
        throw new Error("daemon busy");
      },
    );
    render(<VersionComparePage workspaceId="ws-1" versionId="v-1" />);
    await settle();
    fireEvent.click(screen.getByTestId("version-compare-show-more"));
    await settle();
    screen.getByRole("alert");
    expect(screen.getAllByTestId("version-compare-file")).toHaveLength(1);
    const showMore = screen.getByTestId(
      "version-compare-show-more",
    ) as HTMLButtonElement;
    expect(showMore.textContent, "clear loadingMore only in the success path -> the button reads 'Loading…', disabled, forever after a failed page and this assertion fails.").toBe("Show more files");
    expect(showMore.disabled).toBe(false);
  });
});

it("reports a refused conflict choice from the Versions menu's merge with the refusal's own words", async () => {
  const conflicts = [syncConflict("c-1")];
  bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({ conflicts, nextAfterConflictId: null });
  bridgeMock.mergeWorkspaceVersion.mockResolvedValue({
    mergedFileCount: 0, unchangedFileCount: 0, conflictCount: 1, replacedProtectedPaths: [], conflicts, nextAfterConflictId: null,
  });
  bridgeMock.resolveWorkspaceVersionConflict.mockRejectedValue(new Error("DaemonRefusalError [INVALID_PARAMS]: synced-deletion-revival-refused"));
  const onError = vi.fn();
  const onConflictError = vi.fn();
  const user = userEvent.setup();
  render(<VersionMenuHarness workspaceId="ws-1" activeTabDirty={false} beginLineageOperation={async () => () => {}}
    onOpenCompare={() => {}} onWorkspaceStateChanged={() => {}} onError={onError} clearError={() => {}}
    onMergeNotice={() => {}} onConflictError={onConflictError} />);
  await settle();
  await user.click(screen.getByTestId("version-menu-button"));
  await user.click(screen.getByTestId("version-merge"));
  fireEvent.click(screen.getByTestId("version-merge-confirm"));
  await settle();
  fireEvent.click(screen.getByTestId("version-conflict-keep-current"));
  await settle();
  expect(onConflictError).toHaveBeenCalledExactlyOnceWith("dohc could not apply that choice.", expect.anything());
  expect(readError(onConflictError.mock.calls[0]![1]).title).toBe("dohc can't bring back c-1.md, because that could stop sync");
  expect(onError).not.toHaveBeenCalled();
});

it("returns focus after a press on blank space closes the Versions menu", async () => {
  const user = userEvent.setup();
  function Shell() {
    const root = useRef<HTMLDivElement>(null);
    useFocusSurface(root, () => root.current?.querySelector<HTMLElement>('[data-testid="version-menu-button"]'));
    return <div ref={root} data-focus-surface="workspace" data-testid="workspace">
      <VersionMenuHarness workspaceId="ws-1" activeTabDirty={false} beginLineageOperation={async () => () => {}}
        onOpenCompare={() => {}} onWorkspaceStateChanged={() => {}} onError={() => {}} clearError={() => {}}
        onMergeNotice={() => {}} onConflictError={() => {}} />
    </div>;
  }
  render(<Shell />);
  await settle();
  const trigger = screen.getByTestId("version-menu-button");
  await user.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Feature" }));
  await user.pointer({ target: document.body, keys: "[MouseLeft>]" });
  expect(screen.queryByTestId("version-menu")).toBeNull();
  // A browser's press on blank space takes focus to the page after the close.
  trigger.blur();
  await user.pointer({ keys: "[/MouseLeft]" });
  await settle();
  expect(document.activeElement).toBe(trigger);
});

describe("VersionMergeDialog result", () => {
  const source = { id: "v-1", name: "Feature", kind: "named" as const, createdAtMs: 1, canMergeIntoMain: true };
  const merged = { mergedFileCount: 3, unchangedFileCount: 0, conflictCount: 0, conflicts: [], nextAfterConflictId: null };

  function renderMerge() {
    render(
      <VersionMergeDialog workspaceId="ws-1" source={source} beginLineageOperation={async () => () => {}}
        onWorkspaceStateChanged={() => {}} onMerged={() => {}} onAnsweredAway={() => {}} onConflictError={() => {}}
        onClose={() => {}} />,
    );
  }

  it("says it is merging on the primary, then gives Done the focus", async () => {
    let finishMerge: (() => void) | null = null;
    bridgeMock.mergeWorkspaceVersion.mockReturnValue(new Promise((resolve) => {
      finishMerge = () => resolve({ ...merged, replacedProtectedPaths: [] });
    }));
    renderMerge();
    fireEvent.click(screen.getByTestId("version-merge-confirm"));
    await settle();
    const confirm = screen.getByTestId<HTMLButtonElement>("version-merge-confirm");
    expect(confirm.textContent).toBe("Merging…");
    expect(confirm.disabled).toBe(true);
    // Closing doesn't stop the merge, so the button says Close and keeps the focus.
    const close = screen.getByTestId<HTMLButtonElement>("version-merge-cancel");
    expect(close.textContent).toBe("Close");
    expect(close.disabled).toBe(false);
    expect(document.activeElement).toBe(close);
    expect(screen.queryByTestId("version-merge-status")).toBeNull();

    finishMerge!();
    await settle();
    expect(screen.getByTestId("version-merge-status").textContent).toBe("Merged 3 files into Main");
    expect(document.activeElement).toBe(screen.getByTestId("version-merge-done"));
    expect(screen.queryByTestId("version-merge-protected")).toBeNull();
  });

  it("lists the protected files the merge replaced, open on the result", async () => {
    bridgeMock.mergeWorkspaceVersion.mockResolvedValue({ ...merged, replacedProtectedPaths: [".env", "config/deploy/secrets.json"] });
    renderMerge();
    fireEvent.click(screen.getByTestId("version-merge-confirm"));
    await settle();
    const block = screen.getByTestId("version-merge-protected");
    expect(block.querySelector("p")?.textContent).toBe("These 2 protected files took Feature's copy.");
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("title"))).toEqual([".env", "config/deploy/secrets.json"]);
    expect(rows[1]!.textContent).toBe("config/deploy/secrets.json");
    expect(screen.queryByTestId("version-merge-protected-toggle")).toBeNull();
  });

  it("keeps the protected list behind Show files while conflicts are open", async () => {
    const conflicts = [conflict("c-1")];
    bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({ conflicts, nextAfterConflictId: null });
    bridgeMock.mergeWorkspaceVersion.mockResolvedValue({
      ...merged, conflictCount: 1, conflicts, replacedProtectedPaths: [".env"],
    });
    renderMerge();
    fireEvent.click(screen.getByTestId("version-merge-confirm"));
    await settle();
    expect(screen.getByTestId("version-merge-protected").querySelector("p")?.textContent).toBe("This protected file took Feature's copy.");
    const toggle = screen.getByTestId("version-merge-protected-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Protected files" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Hide files");
    expect(screen.getByRole("list", { name: "Protected files" }).textContent).toBe(".env");
  });
});

describe("ConflictReviewDialog read failure", () => {
  it("offers Try again, which reads the conflicts again", async () => {
    bridgeMock.listWorkspaceVersionConflicts
      .mockRejectedValueOnce(new Error("daemon busy"))
      .mockResolvedValue({ conflicts: [conflict("c-1")], nextAfterConflictId: null });
    render(
      <ConflictReviewDialog beginLineageOperation={async () => () => {}}
        workspaceId="ws-1"
        onWorkspaceStateChanged={() => {}}
        onClose={() => {}}
      />,
    );
    await settle();
    expect(screen.queryByTestId("version-conflict")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(1);
    expect(bridgeMock.listWorkspaceVersionConflicts).toHaveBeenCalledTimes(2);
  });
});

describe("ConflictReviewDialog waiting version", () => {
  const WAITING_COPY =
    "Another computer saved a newer version. dohc holds it until you resolve this conflict.";
  const waitingVersion = {
    code: "resolve-existing-conflict" as const,
    objectId: "object-1",
    originId: "computer-d",
    originSeq: 4,
  };
  const waiting = (id: string): WorkspaceVersionConflict => ({ ...syncConflict(id), waitingVersion });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // A sync pass tells the windows without paths; the dialog reads again once
  // the burst quiets.
  async function signal(event: { workspaceId?: string; paths?: string[] } = { workspaceId: "ws-1" }) {
    await act(async () => {
      for (const listener of [...activityListeners]) listener(event);
      await vi.advanceTimersByTimeAsync(WORKSPACE_ACTIVITY_REFRESH_DELAY_MS);
    });
    await settle();
  }

  function openReview(onError = vi.fn(), workspaceId = "ws-1") {
    const view = render(
      <ConflictReviewDialog beginLineageOperation={async () => () => {}}
        workspaceId={workspaceId}
        onWorkspaceStateChanged={() => {}}
        onClose={() => {}}
        onError={onError}
      />,
    );
    return { view, onError };
  }

  it("says on the card that a newer version waits, and nothing for a conflict without one", async () => {
    bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({
      conflicts: [waiting("c-1")],
      nextAfterConflictId: null,
    });
    openReview();
    await settle();
    expect(screen.getByTestId("version-conflict-waiting").textContent).toBe(WAITING_COPY);
    // Coordinates stay out of the card.
    expect(screen.getByTestId("conflict-review-dialog").textContent).not.toMatch(/computer-d|object-1/);

    cleanup();
    bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({
      conflicts: [syncConflict("c-1")],
      nextAfterConflictId: null,
    });
    openReview();
    await settle();
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(1);
    expect(screen.queryByTestId("version-conflict-waiting")).toBeNull();
  });

  it("shows a version that starts waiting while open, keeping the open card and its combined copy", async () => {
    bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({
      conflicts: [syncConflict("c-1"), syncConflict("c-2")],
      nextAfterConflictId: null,
    });
    const { onError } = openReview();
    await settle();
    fireEvent.click(screen.getByTestId("version-conflict-combine"));
    fireEvent.change(screen.getByTestId("version-conflict-combined-input"), {
      target: { value: "my combined draft\n" },
    });
    expect(screen.queryByTestId("version-conflict-waiting")).toBeNull();

    bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({
      conflicts: [waiting("c-1"), syncConflict("c-2")],
      nextAfterConflictId: null,
    });
    await signal();

    expect(screen.getByTestId("version-conflict-waiting").textContent).toBe(WAITING_COPY);
    expect(
      (screen.getByTestId("version-conflict-combined-input") as HTMLTextAreaElement).value,
    ).toBe("my combined draft\n");
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(2);
    expect(bridgeMock.listWorkspaceVersionConflicts).toHaveBeenLastCalledWith({ workspaceId: "ws-1" });
    // No toast or Notices row: the card is the only place it shows.
    expect(onError).not.toHaveBeenCalled();
  });

  it("reads again only for this workspace's pathless signal", async () => {
    bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({
      conflicts: [syncConflict("c-1")],
      nextAfterConflictId: null,
    });
    openReview();
    await settle();
    bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({
      conflicts: [waiting("c-1")],
      nextAfterConflictId: null,
    });
    await signal({ workspaceId: "ws-2" });
    await signal({ workspaceId: "ws-1", paths: ["notes.md"] });
    expect(bridgeMock.listWorkspaceVersionConflicts).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("version-conflict-waiting")).toBeNull();
  });

  it("rereads every loaded page, so Show more rows stay", async () => {
    bridgeMock.listWorkspaceVersionConflicts.mockImplementation(
      async (payload: { afterConflictId?: string }) =>
        payload.afterConflictId === undefined
          ? { conflicts: [syncConflict("c-1")], nextAfterConflictId: "c-1" }
          : { conflicts: [syncConflict("c-2")], nextAfterConflictId: null },
    );
    openReview();
    await settle();
    fireEvent.click(screen.getByTestId("conflict-list-show-more"));
    await settle();
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(2);

    bridgeMock.listWorkspaceVersionConflicts.mockImplementation(
      async (payload: { afterConflictId?: string }) =>
        payload.afterConflictId === undefined
          ? { conflicts: [syncConflict("c-1")], nextAfterConflictId: "c-1" }
          : { conflicts: [waiting("c-2")], nextAfterConflictId: null },
    );
    await signal();
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(2);
    fireEvent.click(screen.getAllByTestId("version-conflict-toggle")[1]!);
    expect(screen.getByTestId("version-conflict-waiting").textContent).toBe(WAITING_COPY);
  });

  it("drops a reread answered after the dialog moved to another workspace", async () => {
    bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({
      conflicts: [syncConflict("c-1")],
      nextAfterConflictId: null,
    });
    const { view } = openReview();
    await settle();
    let answer!: (page: { conflicts: WorkspaceVersionConflict[]; nextAfterConflictId: null }) => void;
    bridgeMock.listWorkspaceVersionConflicts.mockReturnValueOnce(
      new Promise((resolve) => { answer = resolve; }),
    );
    await signal();

    bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({
      conflicts: [syncConflict("c-9")],
      nextAfterConflictId: null,
    });
    view.rerender(
      <ConflictReviewDialog beginLineageOperation={async () => () => {}}
        workspaceId="ws-2"
        onWorkspaceStateChanged={() => {}}
        onClose={() => {}}
      />,
    );
    await settle();
    await act(async () => {
      answer({ conflicts: [waiting("c-1")], nextAfterConflictId: null });
    });
    await settle();
    expect(
      screen.getAllByTestId("version-conflict").map((card) => card.dataset.conflictPath),
    ).toEqual(["c-9.md"]);
    expect(screen.queryByTestId("version-conflict-waiting")).toBeNull();
  });

  it("keeps the list on screen when the reread fails, without a toast", async () => {
    bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({
      conflicts: [syncConflict("c-1")],
      nextAfterConflictId: null,
    });
    const { onError } = openReview();
    await settle();
    bridgeMock.listWorkspaceVersionConflicts.mockRejectedValue(new Error("engine stopped"));
    await signal();
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });
});
