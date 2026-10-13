// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObserverStub } from "../DesktopWorkspaceShell.testSupport";
import { setOwnPresentation } from "../workbench/actorPresentation";
import { setChosenColors } from "../workbench/chosenColors";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
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
    setOwnPresentation({ group: "own", hue: "plum", self: true });
    const { unmount } = render(<StatesPage />);
    const expectPinnedHues = () => {
      for (const avatar of screen.getAllByTitle("Ada")) expect(avatar.className).toContain("text-hue-teal");
      for (const part of document.querySelectorAll('[data-part="avatars"]')) {
        const coloured = part.querySelectorAll('[title="Sam Rivera"]');
        expect(coloured).toHaveLength(4);
        for (const avatar of coloured) expect(avatar.className).toContain("text-hue-teal");
      }
    };
    expectPinnedHues();
    act(() => {
      setOwnPresentation({ group: "own", hue: "amber", self: true });
      setChosenColors({ ...DEFAULT_USER_SETTINGS.appearance, yourColor: "rose" });
    });
    expectPinnedHues();

    expect(screen.getByTestId("states-light").getAttribute("data-theme")).toBe("light");
    expect(screen.getByTestId("states-dark").getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("light");
    // The same sections in both themes, so a capture compares like with like.
    for (const title of ["Buttons", "Copy", "State mark", "Menu", "Text inputs", "List rows", "Toasts", "Notices", "Dialog", "Kind glyph"]) {
      expect(screen.getAllByRole("heading", { name: title })).toHaveLength(2);
    }
    // Every forced state names an element the capture can find. A menu's
    // rows exist while it is open, and one menu is open at a time, so each
    // mark inside a menu opens it, is checked, and closes it again.
    for (const mark of document.querySelectorAll<HTMLElement>("[data-force-target]")) {
      const trigger = mark.querySelector<HTMLElement>("[aria-haspopup='menu']");
      if (trigger) fireEvent.click(trigger);
      expect(mark.querySelector(mark.dataset.forceTarget ?? "")).not.toBeNull();
      if (trigger) fireEvent.click(trigger);
    }

    unmount();
    expect(document.documentElement.dataset.theme).toBe("dark");
    } finally {
      vi.unstubAllGlobals();
      setOwnPresentation(undefined);
      setChosenColors(DEFAULT_USER_SETTINGS.appearance);
    }
  });
});
