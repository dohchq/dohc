// @vitest-environment jsdom
// #516: the two surfaces that draw a unified diff — the history diff page and
// the versions compare page — both ran the diff on every render, unmemoized,
// and both built one object per line of the whole body before the 800-line
// display bound applied. These pin both halves of the fix on both surfaces.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineMomentDetailRecord } from "../../ipc/bridgeContract";

const computeTextDiffSpy = vi.hoisted(() => vi.fn());
vi.mock("./unifiedDiff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./unifiedDiff")>();
  computeTextDiffSpy.mockImplementation(actual.computeTextDiff);
  return { ...actual, computeTextDiff: computeTextDiffSpy };
});

const { EngineMomentDiffPage } = await import("../DesktopWorkspaceShell");
const { VersionComparePage } = await import("./WorkspaceVersions");
const { momentDiffTabPath } = await import("./workbenchState");

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

  beforeEach(() => {
    bridgeMock.readEngineMoment.mockReset();
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  function renderPage(moment: EngineMomentDetailRecord) {
    bridgeMock.readEngineMoment.mockResolvedValue({ moment });
    const props = {
      workspaceId: "ws-1",
      tabPath: momentDiffTabPath(moment.id),
      onBeforeRestore: async () => {},
      onOpenFile: () => {},
      registerActiveUndo: () => {},
      onRestored: () => {},
    };
    return render(<EngineMomentDiffPage {...props} />);
  }

  it("diffs a moment once, however often the page renders", async () => {
    const view = renderPage(momentDetail());
    await screen.findByTestId("engine-diff-lines");
    expect(computeTextDiffSpy).toHaveBeenCalledTimes(1);

    // A render that does not change the moment must not diff it again. This
    // used to run the diff TWICE per render: once for the counts, once for
    // the lines.
    view.rerender(
      <EngineMomentDiffPage
        workspaceId="ws-1"
        tabPath={momentDiffTabPath("m-1")}
        onBeforeRestore={async () => {}}
        onOpenFile={() => {}}
        registerActiveUndo={() => {}}
        onRestored={() => {}}
      />,
    );
    await screen.findByTestId("engine-diff-lines");
    expect(computeTextDiffSpy).toHaveBeenCalledTimes(1);
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
    // The counts still describe the WHOLE change.
    expect(screen.getByTestId("engine-diff-counts").textContent).toBe(
      "+250000 -250000",
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
    });
    render(<VersionComparePage workspaceId="ws-1" versionId="v-1" />);
    const body = await screen.findByTestId("version-compare-diff-lines");
    expect(body.children).toHaveLength(801);
    expect(body.textContent).toContain("more diff lines hidden");
  });
});
