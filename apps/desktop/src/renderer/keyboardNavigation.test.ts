// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import css from "./styles.css?raw";
import { initKeyboardNavigation, KEYBOARD_NAV_ATTRIBUTE } from "./keyboardNavigation";

describe("keyboard navigation", () => {
  let stop: () => void;
  const marked = () => document.documentElement.hasAttribute(KEYBOARD_NAV_ATTRIBUTE);
  const key = (key: string, init: KeyboardEventInit = {}) =>
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  const press = () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));

  beforeEach(() => {
    stop = initKeyboardNavigation();
  });
  afterEach(() => {
    stop();
    document.documentElement.removeAttribute(KEYBOARD_NAV_ATTRIBUTE);
  });

  it("marks the root while the person moves with Tab, arrows or F6", () => {
    for (const name of ["Tab", "ArrowDown", "ArrowRight", "Home", "F6"]) {
      press();
      key(name);
      expect(marked(), name).toBe(true);
    }
    press();
    key("Tab", { shiftKey: true });
    expect(marked()).toBe(true);
  });

  it("clears the mark on a pointer press, a shortcut, or a key that acts", () => {
    key("Tab");
    press();
    expect(marked()).toBe(false);

    key("Tab");
    key("p", { ctrlKey: true });
    expect(marked()).toBe(false);

    key("Tab");
    key("Tab", { ctrlKey: true });
    expect(marked()).toBe(false);

    key("Tab");
    key("Enter");
    expect(marked()).toBe(false);
  });

  it("keeps the mark as it was for a modifier alone or Escape", () => {
    key("Tab");
    key("Shift");
    key("Escape");
    expect(marked()).toBe(true);
    press();
    key("Escape");
    expect(marked()).toBe(false);
  });

  it("keeps the mark as it was for Delete, Backspace and Cmd+Backspace", () => {
    const keys: [string, string, KeyboardEventInit][] = [
      ["Delete", "Delete", {}],
      ["Backspace", "Backspace", {}],
      ["Cmd+Backspace", "Backspace", { metaKey: true }],
    ];
    for (const [label, name, init] of keys) {
      key("Tab");
      key(name, init);
      expect(marked(), `Tab, then ${label}`).toBe(true);
      press();
      key(name, init);
      expect(marked(), `a pointer press, then ${label}`).toBe(false);
    }
  });

  it("marks the root it is given", () => {
    stop();
    const root = document.createElement("div");
    stop = initKeyboardNavigation(root);
    key("Tab");
    expect(root.hasAttribute(KEYBOARD_NAV_ATTRIBUTE)).toBe(true);
    expect(marked()).toBe(false);
  });

  it("stops listening when stopped", () => {
    stop();
    key("Tab");
    expect(marked()).toBe(false);
  });
});

// A click or focus dohc moves must never draw focus, so every focus-visible
// rule waits for the keyboard's mark, except the reset that hides
// Chromium's own ring.
it("draws focus only under the keyboard's mark", () => {
  const selectors = [...css.matchAll(/^([^{}@/*\n][^{}]*):focus-visible[^{]*\{/gm)]
    .map((match) => match[0].trim())
    .filter((selector) => selector !== ":focus-visible {");
  expect(selectors.length).toBeGreaterThan(5);
  for (const selector of selectors) {
    const parts = selector.replace(/\{$/, "").split(",").filter((part) => part.includes(":focus-visible"));
    for (const part of parts) expect(part, selector).toContain(`[${KEYBOARD_NAV_ATTRIBUTE}] `);
  }
  // A keyboard focus rule that hides the outline leaves a row with no line.
  for (const [rule, body] of css.matchAll(/\[data-keyboard-nav\][^{}]*:focus-visible[^{}]*\{([^}]*)\}/g)) {
    expect(body, rule).not.toMatch(/outline:\s*none/);
  }
  expect(css).toMatch(/@layer base \{\s*:focus-visible \{\s*outline: none;\s*\}/);
  expect(css).toContain(`@custom-variant keyboard ([${KEYBOARD_NAV_ATTRIBUTE}] &);`);
});
