// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SIDEBAR_SETTINGS } from "../../settings/userSettings";
import { SidebarViewsControl } from "./SidebarViewsControl";

afterEach(cleanup);

describe("SidebarViewsControl", () => {
  it("moves a view and hides or shows it", () => {
    const onChange = vi.fn();
    const sidebar = { ...DEFAULT_SIDEBAR_SETTINGS, hidden: ["graph" as const] };
    render(<SidebarViewsControl sidebar={sidebar} onChange={onChange} />);

    expect(screen.getAllByTestId("sidebar-view").map((row) => row.dataset.view))
      .toEqual(["explorer", "search", "graph", "sites", "history"]);
    expect(screen.getByRole("button", { name: "Move Explorer up" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Move History down" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Move Apps up" }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...sidebar,
      order: ["explorer", "search", "sites", "graph", "history"],
    });

    const graph = screen.getByRole("switch", { name: "Show Graph" });
    expect(graph.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(graph);
    expect(onChange).toHaveBeenLastCalledWith({ ...sidebar, hidden: [] });
    fireEvent.click(screen.getByRole("switch", { name: "Show Search" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...sidebar, hidden: ["graph", "search"] });
  });
});
