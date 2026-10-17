// @vitest-environment jsdom
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { describe, expect, it } from "vitest";
import { isComposingKey } from "./keys";

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
