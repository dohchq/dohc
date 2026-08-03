// @vitest-environment jsdom
// #562: conflict and compare IPC results are page-shaped. These pin the two
// surfaces' ends of that contract: the loaded window paints, "Show more
// files" fetches the NEXT page with the continuation, and the count copy
// never states a number that could be under the truth.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceVersionConflict } from "../../ipc/bridgeContract";
import {
  ConflictReviewDialog,
  VersionComparePage,
  VersionMergeDialog,
  conflictCountCopy,
} from "./WorkspaceVersions";

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
  };
}

const bridgeMock = {
  listWorkspaceVersions: vi.fn(),
  listWorkspaceVersionConflicts: vi.fn(),
  resolveWorkspaceVersionConflict: vi.fn(),
  compareWorkspaceVersions: vi.fn(),
  mergeWorkspaceVersion: vi.fn(),
};

beforeEach(() => {
  for (const mock of Object.values(bridgeMock)) mock.mockReset();
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
  vi.unstubAllGlobals();
});

describe("conflictCountCopy", () => {
  it("states the exact count only when the listing is complete", () => {
    expect(conflictCountCopy(1, false)).toBe("One file has two copies.");
    expect(conflictCountCopy(3, false)).toBe("3 files have two copies.");
    // A continuation means MORE conflicts exist past the window, so an exact
    // "3 files" would be under the truth.
    expect(conflictCountCopy(1, true)).toBe("More than one file has two copies.");
    expect(conflictCountCopy(3, true)).toBe("More than 3 files have two copies.");
  });
});

describe("ConflictReviewDialog paging", () => {
  it("loads the next page with the continuation and appends it", async () => {
    bridgeMock.listWorkspaceVersionConflicts.mockImplementation(
      async (payload: { afterConflictId?: string }) =>
        payload.afterConflictId === undefined
          ? { conflicts: [conflict("c-1")], nextAfterConflictId: "c-1" }
          : { conflicts: [conflict("c-2")], nextAfterConflictId: null },
    );
    render(
      <ConflictReviewDialog
        workspaceId="ws-1"
        onWorkspaceStateChanged={() => {}}
        onClose={() => {}}
      />,
    );
    await screen.findByText("More than one file has two copies.", {
      exact: false,
    });
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("conflict-list-show-more"));
    await screen.findByText("2 files have two copies.", { exact: false });
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
      <ConflictReviewDialog
        workspaceId="ws-1"
        onWorkspaceStateChanged={() => {}}
        onClose={() => {}}
      />,
    );
    await screen.findAllByTestId("version-conflict");
    fireEvent.click(
      screen.getAllByTestId("version-conflict-keep-current")[0]!,
    );
    await screen.findByText("One file has two copies.", { exact: false });
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
      <ConflictReviewDialog
        workspaceId="ws-1"
        onWorkspaceStateChanged={() => {}}
        onClose={() => {}}
      />,
    );
    await screen.findAllByTestId("version-conflict");
    fireEvent.click(screen.getByTestId("conflict-list-show-more"));
    fireEvent.click(
      screen.getAllByTestId("version-conflict-keep-current")[0]!,
    );
    await screen.findByText("One file has two copies.", { exact: false });

    resolveStalePage!({
      conflicts: [conflict("c-3")],
      nextAfterConflictId: null,
    });
    // Let the stale answer's whole continuation run before asserting — a
    // waitFor here would pass on the first paint and never see the append.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // MUTATION: drop the window-generation guard -> c-3 (a row of the
    // replaced window) appends to the remaining page.
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(1);
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
      <ConflictReviewDialog
        workspaceId="ws-1"
        onWorkspaceStateChanged={() => {}}
        onClose={() => {}}
      />,
    );
    await screen.findAllByTestId("version-conflict");
    fireEvent.click(screen.getByTestId("conflict-list-show-more"));
    await screen.findByRole("alert");
    // The window is unchanged and the button remains for a retry.
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(1);
    expect(screen.getByTestId("conflict-list-show-more")).toBeTruthy();
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
        activeTabDirty={false}
        flushActiveDraft={async () => {}}
        onWorkspaceStateChanged={() => {}}
        onClose={() => {}}
      />,
    );
  }

  it("the merge's own count decides the stage, not the open-conflict rows", async () => {
    // The rows are the first page of ALL open conflicts — the contract
    // (MergeWorkspaceVersionResult) says a sync conflict can ride along. A
    // merge that itself conflicted nothing must stay clean.
    bridgeMock.mergeWorkspaceVersion.mockResolvedValue({
      mergedFileCount: 2,
      unchangedFileCount: 0,
      conflictCount: 0,
      conflicts: [{ ...conflict("c-sync"), origin: "sync" }],
      nextAfterConflictId: null,
    });
    renderMerge();
    fireEvent.click(screen.getByTestId("version-merge-confirm"));
    await screen.findByText("Merged 2 files into Main.");
  });

  it("pages the conflicts stage through the open-conflict listing", async () => {
    bridgeMock.mergeWorkspaceVersion.mockResolvedValue({
      mergedFileCount: 0,
      unchangedFileCount: 0,
      conflictCount: 2,
      conflicts: [conflict("c-1")],
      nextAfterConflictId: "c-1",
    });
    bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({
      conflicts: [conflict("c-2")],
      nextAfterConflictId: null,
    });
    renderMerge();
    fireEvent.click(screen.getByTestId("version-merge-confirm"));
    await screen.findByText("More than one file has two copies.", {
      exact: false,
    });
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("conflict-list-show-more"));
    await screen.findByText("2 files have two copies.", { exact: false });
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(2);
    expect(bridgeMock.listWorkspaceVersionConflicts.mock.calls).toEqual([
      [{ workspaceId: "ws-1", afterConflictId: "c-1" }],
    ]);
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

  it("appends the next page with the continuation and updates the count copy", async () => {
    bridgeMock.compareWorkspaceVersions.mockImplementation(
      async (payload: { afterPath?: string }) =>
        payload.afterPath === undefined
          ? { files: [compareRow("a.md")], nextAfterPath: "a.md" }
          : { files: [compareRow("b.md")], nextAfterPath: null },
    );
    render(<VersionComparePage workspaceId="ws-1" versionId="v-1" />);
    await screen.findByTestId("version-compare-file");
    expect(
      screen.getByText("More than 1 file differs between Feature and Main."),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("version-compare-show-more"));
    await screen.findByText("2 files differ between Feature and Main.");
    expect(screen.getAllByTestId("version-compare-file")).toHaveLength(2);
    expect(screen.queryByTestId("version-compare-show-more")).toBeNull();
    expect(bridgeMock.compareWorkspaceVersions.mock.calls).toEqual([
      [{ workspaceId: "ws-1", versionId: "v-1" }],
      [{ workspaceId: "ws-1", versionId: "v-1", afterPath: "a.md" }],
    ]);
  });

  it("drops a page answered after a refresh replaced the comparison", async () => {
    // A refreshed comparison can hand out the SAME cursor again, so only the
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
    await screen.findByTestId("version-compare-file");
    fireEvent.click(screen.getByTestId("version-compare-show-more"));
    fireEvent.click(screen.getByTestId("version-compare-refresh"));
    await screen.findByTestId("version-compare-file");

    resolveStalePage!({ files: [compareRow("b.md")], nextAfterPath: null });
    // Let the stale answer's whole continuation run before asserting — a
    // waitFor here would pass on the first paint and never see the append.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // MUTATION: drop the window-generation guard -> the old generation's page
    // appends to the refreshed window (the cursor matches, so a cursor check
    // alone cannot reject it).
    expect(screen.getAllByTestId("version-compare-file")).toHaveLength(1);
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
    await screen.findByTestId("version-compare-file");
    fireEvent.click(screen.getByTestId("version-compare-show-more"));
    await screen.findByRole("alert");
    expect(screen.getAllByTestId("version-compare-file")).toHaveLength(1);
    expect(screen.getByTestId("version-compare-show-more")).toBeTruthy();
  });
});
