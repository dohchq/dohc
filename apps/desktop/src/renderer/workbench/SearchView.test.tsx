// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginSearch } from "./search-model";
import { SearchView } from "./SearchView";
import type { WorkspaceSearchApi } from "./useWorkspaceSearch";

afterEach(() => cleanup());

describe("SearchView", () => {
  it("keeps the live region mounted before search status changes", () => {
    const idleSearch: WorkspaceSearchApi = {
      model: { ...beginSearch("search-1"), status: "idle" },
      criteria: {
        query: "needle",
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        includeGlob: "",
        excludeGlob: "",
      },
      setCriteria: vi.fn(),
      run: vi.fn(),
      clear: vi.fn(),
    };
    const { rerender } = render(
      <SearchView search={idleSearch} onOpenResult={vi.fn()} />,
    );
    const liveRegion = screen.getByRole("status");
    expect(liveRegion.textContent).toBe("");

    rerender(
      <SearchView
        search={{
          ...idleSearch,
          model: { ...idleSearch.model, status: "searching" },
        }}
        onOpenResult={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toBe(liveRegion);
    expect(liveRegion.textContent).toContain("Searching…");
  });

  it("shows workspace progress instead of an empty result while capture updates", () => {
    const search: WorkspaceSearchApi = {
      model: { ...beginSearch("search-1"), status: "updating" },
      criteria: {
        query: "needle",
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        includeGlob: "",
        excludeGlob: "",
      },
      setCriteria: vi.fn(),
      run: vi.fn(),
      clear: vi.fn(),
    };

    render(<SearchView search={search} onOpenResult={vi.fn()} />);

    expect(screen.getByTestId("search-view").getAttribute("data-state")).toBe(
      "updating",
    );
    expect(screen.getByTestId("search-spinner").textContent).toContain(
      "Updating workspace…",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Updating workspace…",
    );
    expect(screen.queryByTestId("search-empty-state")).toBeNull();
  });
});
