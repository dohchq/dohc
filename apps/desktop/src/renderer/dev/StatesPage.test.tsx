// @vitest-environment jsdom
// chat-messages forces a hover on a row of a virtualized list. jsdom has no
// layout, so the list mock renders every row for the forced-state check.
import "../../testing/legendListMock";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setOwnPresentation } from "../workbench/actorPresentation";
import { setChosenColors } from "../workbench/chosenColors";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { StatesPage } from "./StatesPage";
import { STATES_PAGE_HASH, statesPageRequested } from "./statesRoute";

afterEach(cleanup);

// The whole page takes seconds to render and query in jsdom, and every menu
// it closes takes longer the more the page holds, so a test renders only the
// parts it checks.
const TITLES: Record<string, string> = {
  buttons: "Buttons", copy: "Copy", "state-mark": "State mark", menu: "Menu", "text-inputs": "Text inputs",
  "list-rows": "List rows", toasts: "Toasts", notices: "Notices", dialog: "Dialog", "kind-glyph": "Kind glyph",
  "page-identity": "Page identity",
};
// With the titled parts: every part that draws Ada, Sam's avatars and chat
// rows, and the zoom stepper. Page identity holds the pills.
const CHECKED = new Set([
  ...Object.keys(TITLES), "settings-frame", "composer-sending", "offers", "composer-poll", "avatars", "chat-rows",
  "zoom-stepper",
]);

const forcedMarks = () => document.querySelectorAll<HTMLElement>("[data-force-target]");
const menuTrigger = (mark: HTMLElement) => mark.querySelector<HTMLElement>("[aria-haspopup='menu']");
const expectForcedTarget = (mark: HTMLElement) =>
  expect(mark.querySelector(mark.dataset.forceTarget ?? ""), mark.dataset.forceTarget).not.toBeNull();

describe("states page", () => {
  it("opens only at its address and only with the dev-tools grant", () => {
    expect(statesPageRequested(STATES_PAGE_HASH, true)).toBe(true);
    expect(statesPageRequested(STATES_PAGE_HASH, false)).toBe(false);
    expect(statesPageRequested("", true)).toBe(false);
    expect(statesPageRequested("#/dev/other", true)).toBe(false);
  });

  it("renders both themes side by side and holds the document light while open", () => {
    vi.stubGlobal("dohcDesktop", {});
    try {
    document.documentElement.dataset.theme = "dark";
    setOwnPresentation({ group: "own", hue: "plum", self: true });
    const { unmount } = render(<StatesPage parts={CHECKED} />);
    const expectPinnedHues = () => {
      for (const avatar of screen.getAllByTitle("Ada")) expect(avatar.className).toContain("text-hue-teal");
      for (const part of document.querySelectorAll('[data-part="avatars"]')) {
        const coloured = part.querySelectorAll('[title="Sam Rivera"]');
        expect(coloured).toHaveLength(4);
        for (const avatar of coloured) expect(avatar.className).toContain("text-hue-amber");
      }
      for (const part of document.querySelectorAll('[data-part="chat-rows"]')) {
        const identified = part.querySelector('[data-thread-id="post-plain"] [title="Sam"]');
        const unknown = part.querySelector('[data-thread-id="post-unkeyed"] [title="Kim"]');
        expect(identified).not.toBeNull();
        expect(identified!.className).toContain("text-hue-amber");
        expect(unknown).not.toBeNull();
        expect(unknown!.className).toContain("text-muted");
        const posts = part.querySelectorAll('[data-testid="chats-post-card"]');
        expect(posts[0]!.getAttribute("data-thread-id")).toBe("post-plain");
        expect(posts[1]!.getAttribute("data-thread-id")).toBe("post-unkeyed");
      }
    };
    expectPinnedHues();
    act(() => {
      setOwnPresentation({ group: "own", hue: "amber", self: true });
      setChosenColors({ ...DEFAULT_USER_SETTINGS, appearance: { ...DEFAULT_USER_SETTINGS.appearance, yourColor: "rose" } });
    });
    expectPinnedHues();

    expect(screen.getByTestId("states-light").getAttribute("data-theme")).toBe("light");
    expect(screen.getByTestId("states-dark").getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("light");
    // The same sections in both themes, so a capture compares like with like.
    for (const title of Object.values(TITLES)) {
      expect(screen.getAllByRole("heading", { name: title })).toHaveLength(2);
    }
    // The specimen keeps its existing Ctrl text on every host.
    for (const [label, key] of [["Zoom out", "-"], ["Zoom in", "="], ["Reset zoom to 100%, now 100%", "0"]]) {
      const button = document.querySelector<HTMLElement>('[aria-label="' + label + '"]')!;
      fireEvent.mouseEnter(button.parentElement!);
      expect(Array.from(button.parentElement!.querySelectorAll("[role=tooltip] kbd"), (kbd) => kbd.textContent)).toEqual(["Ctrl", key]);
      fireEvent.mouseLeave(button.parentElement!);
    }
    // The reserved pill is typed when it mounts, and the locked pills are
    // locked at rest, once per theme.
    expect(screen.getAllByTestId("property-reserved")).toHaveLength(2);
    expect(screen.getAllByTestId("properties-locked")).toHaveLength(2);

    unmount();
    expect(document.documentElement.dataset.theme).toBe("dark");
    } finally {
      vi.unstubAllGlobals();
      setOwnPresentation(undefined);
      setChosenColors(DEFAULT_USER_SETTINGS);
    }
  });

  it("marks every forced state on an element the capture can find", () => {
    vi.stubGlobal("dohcDesktop", {});
    try {
      // A mark outside a menu is checked on the whole page.
      const { unmount } = render(<StatesPage />);
      const withMenus = new Set<string>();
      for (const mark of forcedMarks()) {
        if (menuTrigger(mark)) withMenus.add(mark.closest("[data-part]")!.getAttribute("data-part")!);
        else expectForcedTarget(mark);
      }
      unmount();
      // A menu's rows exist while it is open, and one menu is open at a time,
      // so each mark inside a menu opens it, is checked, and closes it again,
      // among only the parts that hold such marks.
      expect(withMenus.size).toBeGreaterThan(0);
      render(<StatesPage parts={withMenus} />);
      for (const mark of forcedMarks()) {
        const trigger = menuTrigger(mark);
        if (!trigger) continue;
        fireEvent.click(trigger);
        expectForcedTarget(mark);
        fireEvent.click(trigger);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
