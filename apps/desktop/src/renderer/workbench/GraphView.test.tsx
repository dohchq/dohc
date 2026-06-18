// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphView } from "./GraphView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GraphView", () => {
  it("loads the workspace graph and opens a clicked document", async () => {
    const onOpenPath = vi.fn();
    vi.stubGlobal("dohcDesktop", {
      readWorkspaceGraph: vi.fn(async () => ({
        nodes: [
          { path: "alpha.md", title: "Alpha", incoming: 1, outgoing: 1 },
          { path: "beta.md", title: "Beta", incoming: 1, outgoing: 0 },
        ],
        edges: [{ source: "alpha.md", target: "beta.md", kind: "wikilink" }],
        unresolvedLinks: 1,
        scannedFileCount: 2,
        omittedFileCount: 0,
        truncatedFileCount: 0,
      })),
    });

    render(
      <GraphView
        workspaceId="ws-graph"
        activePath="alpha.md"
        refreshKey="0"
        onOpenPath={onOpenPath}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("graph-view").getAttribute("data-state")).toBe(
        "ready",
      ),
    );
    expect(screen.getByTestId("graph-doc-count").textContent).toBe("2 docs");
    expect(screen.getByTestId("graph-link-count").textContent).toBe("1 link");
    expect(screen.getByTestId("graph-unresolved-count").textContent).toContain(
      "1 unresolved",
    );
    expect(
      screen
        .getAllByTestId("graph-node")
        .find((node) => node.dataset.path === "beta.md")
        ?.getAttribute("aria-label"),
    ).toBe("Open or focus beta.md");

    await userEvent.click(
      screen.getAllByTestId("graph-file-row").find((row) => row.dataset.path === "beta.md")!,
    );
    expect(onOpenPath).toHaveBeenCalledWith("beta.md");
  });
});
