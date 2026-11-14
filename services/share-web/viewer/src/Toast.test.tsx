// @vitest-environment jsdom
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {Toast} from "./Toast";

// A member page's toast times out as the desktop's does: a success fades after
// 6 s, but not while the person points at it or focuses it, and a warning or a
// failure stays until it is dismissed.

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => {act(() => root.unmount()); container.remove(); vi.useRealTimers();});

const show = (tone: "success" | "warning" | undefined, onDismiss: () => void) =>
  act(() => root.render(<Toast title="Ana now lets members comment." tone={tone} onDismiss={onDismiss}/>));

it("fades a success after 6 s, even when the page renders it again meanwhile", () => {
  const dismissed = vi.fn();
  show("success", dismissed);
  act(() => vi.advanceTimersByTime(3_000));
  show("success", () => dismissed());
  act(() => vi.advanceTimersByTime(2_999));
  expect(dismissed).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(dismissed).toHaveBeenCalledTimes(1);
});

it("holds a success while the pointer or focus is on it", () => {
  const dismissed = vi.fn();
  show("success", dismissed);
  const toast = container.querySelector<HTMLElement>(".workspace-toast")!;
  act(() => toast.dispatchEvent(new PointerEvent("pointerover", {bubbles: true})));
  act(() => vi.advanceTimersByTime(10_000));
  expect(dismissed).not.toHaveBeenCalled();
  act(() => toast.dispatchEvent(new PointerEvent("pointerout", {bubbles: true})));
  act(() => toast.querySelector<HTMLButtonElement>(".toast-close")!.focus());
  act(() => vi.advanceTimersByTime(10_000));
  expect(dismissed).not.toHaveBeenCalled();
  act(() => toast.querySelector<HTMLButtonElement>(".toast-close")!.blur());
  act(() => vi.advanceTimersByTime(6_000));
  expect(dismissed).toHaveBeenCalledTimes(1);
});

it.each(["warning", undefined] as const)("keeps a %s toast until it is dismissed", (tone) => {
  const dismissed = vi.fn();
  show(tone, dismissed);
  act(() => vi.advanceTimersByTime(60_000));
  expect(dismissed).not.toHaveBeenCalled();
  expect(container.querySelector(".workspace-toast")).not.toBeNull();
});
