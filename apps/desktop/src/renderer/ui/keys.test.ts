// @vitest-environment jsdom
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { describe, expect, it } from "vitest";
import { isComposingKey, isDeleteKey, isMacContextClick, isSendKey } from "./keys";

const key = (init: KeyboardEventInit & { keyCode?: number }) => new KeyboardEvent("keydown", init);
const reactKey = (init: KeyboardEventInit & { keyCode?: number }) => {
  const nativeEvent = key(init);
  return {
    key: nativeEvent.key, shiftKey: nativeEvent.shiftKey, altKey: nativeEvent.altKey,
    keyCode: nativeEvent.keyCode, nativeEvent,
  } as unknown as ReactKeyboardEvent;
};

describe("isComposingKey", () => {
  it("marks keys an input method still owns, on native and React events", () => {
    for (const event of [key, reactKey]) {
      expect(isComposingKey(event({ key: "Enter", isComposing: true }))).toBe(true);
      expect(isComposingKey(event({ key: "Enter", keyCode: 229 }))).toBe(true);
      expect(isComposingKey(event({ key: "Enter", keyCode: 13 }))).toBe(false);
    }
  });
});

describe("isSendKey", () => {
  it.each([
    ["darwin", "Return sends", { key: "Enter" }, true],
    ["darwin", "⇧↩ starts a line", { key: "Enter", shiftKey: true }, false],
    ["darwin", "⌥↩ starts a line", { key: "Enter", altKey: true }, false],
    ["darwin", "a composing Return confirms the characters", { key: "Enter", isComposing: true }, false],
    ["darwin", "a keyCode 229 Return confirms the characters", { key: "Enter", keyCode: 229 }, false],
    ["win32", "Alt+Enter sends", { key: "Enter", altKey: true }, true],
    ["win32", "Shift+Enter starts a line", { key: "Enter", shiftKey: true }, false],
  ] as const)("on %s, %s", (platform, _name, init, sends) => {
    expect(isSendKey(reactKey(init), platform)).toBe(sends);
  });
});

describe("isDeleteKey", () => {
  it("takes ⌘⌫ only on macOS", () => {
    expect(isDeleteKey({ key: "Delete", metaKey: false }, "darwin")).toBe(true);
    expect(isDeleteKey({ key: "Backspace", metaKey: true }, "darwin")).toBe(true);
    expect(isDeleteKey({ key: "Backspace", metaKey: false }, "darwin")).toBe(false);
    expect(isDeleteKey({ key: "Delete", metaKey: false }, "win32")).toBe(true);
    expect(isDeleteKey({ key: "Backspace", metaKey: true }, "win32")).toBe(false);
  });
});

describe("isMacContextClick", () => {
  it("reads a Control primary press as a context click only on macOS", () => {
    expect(isMacContextClick({ button: 0, ctrlKey: true }, "darwin")).toBe(true);
    expect(isMacContextClick({ button: 0, ctrlKey: false }, "darwin")).toBe(false);
    expect(isMacContextClick({ button: 0, ctrlKey: true }, "win32")).toBe(false);
  });
});
