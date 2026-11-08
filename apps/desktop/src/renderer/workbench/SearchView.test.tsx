// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginSearch, idleSearchModel, type SearchModel } from "./search-model";
import { SearchView } from "./SearchView";
import type { SearchCriteria, WorkspaceSearchApi } from "./useWorkspaceSearch";

afterEach(() => cleanup());

describe("SearchView", () => {
  it("keeps the live region mounted before search status changes", () => {
    const idleSearch: WorkspaceSearchApi = {
      model: { ...beginSearch("search-1", "needle"), status: "idle" },
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
      model: { ...beginSearch("search-1", "needle"), status: "updating" },
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

  // A finished search that found nothing, under whatever the input holds now.
  function emptySearch(criteria: Partial<WorkspaceSearchApi["criteria"]>): WorkspaceSearchApi {
    return {
      model: { ...beginSearch("search-1", "agnet"), status: "complete" },
      criteria: {
        query: "agnet",
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        includeGlob: "",
        excludeGlob: "",
        ...criteria,
      },
      setCriteria: vi.fn(),
      run: vi.fn(),
      clear: vi.fn(),
    };
  }

  it("names the query that found nothing, not the next one the input holds", () => {
    render(<SearchView search={emptySearch({ query: "agent" })} onOpenResult={vi.fn()} />);

    expect(screen.getByTestId("search-empty-state").textContent).toBe('No files or chats match "agnet".');
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("clears every toggle and filter that narrowed an empty search, and searches again", async () => {
    const search = emptySearch({ regex: true, includeGlob: "*.md" });
    render(<SearchView search={search} onOpenResult={vi.fn()} />);

    const clear = within(screen.getByTestId("search-empty-state")).getByRole("button", { name: "Clear filters" });
    clear.focus();
    await userEvent.setup().keyboard("{Enter}");

    const widened = {
      query: "agnet",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      includeGlob: "",
      excludeGlob: "",
    };
    expect(search.setCriteria).toHaveBeenCalledExactlyOnceWith(widened);
    expect(search.run).toHaveBeenCalledExactlyOnceWith({
      ...widened,
      includeGlob: undefined,
      excludeGlob: undefined,
    });
  });

  // The shell's search state, held for real: run() moves the model to a new
  // search, which replaces the empty state and the button in it.
  function LiveSearch(props: { criteria: SearchCriteria }) {
    const [model, setModel] = useState<SearchModel>({ ...beginSearch("search-1", "agnet"), status: "complete" });
    const [criteria, setCriteria] = useState(props.criteria);
    return (
      <SearchView
        search={{
          model,
          criteria,
          setCriteria,
          run: (options) => setModel(beginSearch("search-2", options.query)),
          clear: () => setModel(idleSearchModel()),
        }}
        onOpenResult={vi.fn()}
      />
    );
  }

  it("keeps keyboard focus in Search when Clear filters searches again", async () => {
    render(
      <LiveSearch
        criteria={{ query: "agnet", caseSensitive: true, wholeWord: false, regex: false, includeGlob: "", excludeGlob: "" }}
      />,
    );

    screen.getByRole("button", { name: "Clear filters" }).focus();
    await userEvent.setup().keyboard("{Enter}");

    expect(screen.queryByTestId("search-empty-state")).toBeNull();
    expect(screen.getByTestId("search-view").getAttribute("data-state")).toBe("searching");
    expect(document.activeElement).toBe(screen.getByTestId("search-input"));
  });
});
