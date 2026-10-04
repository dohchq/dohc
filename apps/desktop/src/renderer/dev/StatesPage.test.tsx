// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObserverStub } from "../DesktopWorkspaceShell.testSupport";
import { StatesPage } from "./StatesPage";
import { STATES_PAGE_HASH, statesPageRequested } from "./statesRoute";

afterEach(cleanup);

describe("states page", () => {
  it("opens only at its address and only with the dev-tools grant", () => {
    expect(statesPageRequested(STATES_PAGE_HASH, true)).toBe(true);
    expect(statesPageRequested(STATES_PAGE_HASH, false)).toBe(false);
    expect(statesPageRequested("", true)).toBe(false);
    expect(statesPageRequested("#/dev/other", true)).toBe(false);
  });

  it("renders both themes side by side and holds the document light while open", () => {
    vi.stubGlobal("dohcDesktop", {});
    // jsdom has no ResizeObserver; the page measures its sections.
    vi.stubGlobal("ResizeObserver", ObserverStub);
    try {
    document.documentElement.dataset.theme = "dark";
    const { unmount } = render(<StatesPage />);

    expect(screen.getByTestId("states-light").getAttribute("data-theme")).toBe("light");
    expect(screen.getByTestId("states-dark").getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("light");
    // The same sections in both themes, so a capture compares like with like.
    for (const title of ["Buttons", "Copy", "State mark", "Menu", "Text inputs", "List rows", "Toasts", "Notices", "Dialog"]) {
      expect(screen.getAllByRole("heading", { name: title })).toHaveLength(2);
    }
    // Every forced state names an element the capture can find. The menu's
    // rows exist once it is open, and the capture opens it first.
    for (const theme of ["light", "dark"]) fireEvent.click(screen.getByTestId(`states-menu-${theme}`));
    for (const mark of document.querySelectorAll<HTMLElement>("[data-force-target]")) {
      expect(mark.querySelector(mark.dataset.forceTarget ?? "")).not.toBeNull();
    }

    unmount();
    expect(document.documentElement.dataset.theme).toBe("dark");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
