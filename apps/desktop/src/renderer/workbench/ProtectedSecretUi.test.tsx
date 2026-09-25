// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Fragment, type ReactNode } from "react";
import type { EngineMomentRecord } from "../../ipc/bridgeContract";
import { EngineHistoryView } from "./EngineHistory";
import { VersionComparePage } from "./WorkspaceVersions";

// This suite checks protected metadata, not viewport measurement. The real
// virtualizer is covered by history-virtualization.spec.ts in Chromium.
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({ data, renderItem, ListHeaderComponent }: {
    data: unknown[];
    renderItem: (props: { item: unknown; index: number }) => ReactNode;
    ListHeaderComponent: ReactNode;
  }) => (
    <>
      {ListHeaderComponent}
      {data.map((item, index) => (
        <Fragment key={index}>{renderItem({ item, index })}</Fragment>
      ))}
    </>
  ),
}));

// Secret-backed file UI: protected history rows carry a lock and the
// compare view shows "Protected file changed" — contents never render.

const SECRET_VALUE = "UI_SECRET_MARKER_555";

function moment(overrides: Partial<EngineMomentRecord> & { id: string }): EngineMomentRecord {
  return {
    versionId: "main",
    path: "notes/plan.md",
    recordedAtMs: 100,
    operation: "write",
    origin: "local-file",
    momentOrder: 0,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("EngineHistoryView automation rows", () => {
  it("shows the automation's name and Collection after the ⚡, and describes the row by them", () => {
    render(
      <EngineHistoryView
        moments={[
          moment({ id: "m-auto", origin: "api", path: "Tasks/new.md", automationAuthor: { name: "Stamp the finish date", collection: "Tasks" } }),
        ]}
        hasMore={false}
        loadingMore={false}
        protectedTruncated={false}
        onLoadMore={() => {}}
        onOpenMoment={() => {}}
      />,
    );
    const source = screen.getByTestId("engine-moment-source");
    expect(source.textContent).toBe("Automation Stamp the finish date in Tasks");
    expect(source.querySelector("svg")).not.toBeNull();
    const row = screen.getByTestId("engine-moment-open");
    expect(row.getAttribute("aria-label")).toBe("Open diff for Tasks/new.md");
    expect(row.getAttribute("aria-describedby")).toBe(source.id);
  });
});

describe("EngineHistoryView protected rows", () => {
  it("renders a lock on protected moments and none on ordinary ones", () => {
    render(
      <EngineHistoryView
        moments={[
          moment({
            id: "m-secret",
            path: ".env",
            protected: true,
            summary: "Updated .env",
            momentOrder: 2,
          }),
          moment({ id: "m-plain", momentOrder: 1 }),
        ]}
        hasMore={false}
        loadingMore={false}
        protectedTruncated
        onLoadMore={() => {}}
        onOpenMoment={() => {}}
      />,
    );
    expect(screen.getAllByTestId("engine-moment-lock")).toHaveLength(1);
    expect(screen.getByText("Updated .env")).toBeTruthy();
    // The protected row is still a normal, clickable timeline row.
    const rows = screen.getAllByTestId("engine-moment-open");
    expect(rows).toHaveLength(2);
    expect(
      screen.getAllByText("Some protected activity in this range is not shown."),
    ).toHaveLength(1);
  });
});

describe("VersionComparePage protected rows", () => {
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
    bridgeMock.compareWorkspaceVersions.mockResolvedValue({
      files: [
        // Both sides carry the secret and differ, so a page that fell through
        // to the text diff would print it as removed and added lines.
        {
          path: ".env",
          status: "modified",
          protected: true,
          currentText: `${SECRET_VALUE} before
`,
          incomingText: `${SECRET_VALUE} after
`,
        },
        {
          path: "notes.md",
          status: "modified",
          currentText: "old text\n",
          incomingText: "new text\n",
        },
      ],
      nextAfterPath: null,
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  it('shows "Protected file changed" with a lock and no contents for secret files', async () => {
    render(<VersionComparePage workspaceId="ws-1" versionId="v-1" />);
    const protectedPanel = await screen.findByTestId("version-compare-protected");
    expect(protectedPanel.textContent).toContain("Protected file changed");
    // The ordinary file still renders its diff beside it.
    expect(screen.getByText("notes.md")).toBeTruthy();
    // Never any secret content anywhere in the page.
    expect(document.body.textContent).not.toContain(SECRET_VALUE);
    const files = screen.getAllByTestId("version-compare-file");
    expect(files).toHaveLength(2);
    const secretSection = files.find(
      (section) => section.dataset.comparePath === ".env",
    );
    expect(secretSection?.querySelector('[data-testid="version-compare-protected"]')).toBeTruthy();
    // The protected section renders no diff body at all.
    expect(secretSection?.querySelector('[data-testid="version-compare-diff-lines"]')).toBeNull();
  });
});
