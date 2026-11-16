// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrollToPlace } from "./scrollToPlace";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * A note in a pane that scrolls. `block(at)` is a top-level block `at` pixels
 * down the note, with `target` inside it. A scroll to the target brings its
 * block to the pane's top.
 */
function note() {
  const pane = document.createElement("div");
  pane.style.overflowY = "auto";
  const body = document.createElement("div");
  body.className = "dohc-notion-editor";
  pane.append(body);
  document.body.append(pane);
  const block = (at: number) => {
    // `within` is how far down its block the target is.
    const place = { at, within: 0 };
    const element = document.createElement("p");
    const target = document.createElement("span");
    element.append(target);
    body.append(element);
    const scrolls: ScrollIntoViewOptions[] = [];
    element.getBoundingClientRect = () => ({ top: place.at - pane.scrollTop }) as DOMRect;
    const rect = () => ({ top: place.at + place.within - pane.scrollTop }) as DOMRect;
    target.getBoundingClientRect = rect;
    target.scrollIntoView = (options) => {
      scrolls.push(options as ScrollIntoViewOptions);
      pane.scrollTop = place.at + place.within;
    };
    return { element, target, scrolls, place, top: () => rect().top };
  };
  return { pane, body, block };
}

/** Runs `count` frames, 16 ms apart. False once no frame is waited for. */
function frames() {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const queue: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => queue.push(run));
  return (count = 1) => {
    for (let frame = 0; frame < count; frame += 1) {
      now += 16;
      queue.shift()?.(now);
    }
    return queue.length > 0;
  };
}
const FAR = 40_000;

describe("a scroll to a place in the note", () => {
  it("moves smoothly to a target within a window's height, once", () => {
    const run = frames();
    const { target, scrolls } = note().block(window.innerHeight);
    scrollToPlace(target, true);
    expect(run()).toBe(false);
    expect(scrolls).toEqual([{ behavior: "smooth", block: "start" }]);
  });

  it("reaches a far target at once, and follows it each time what is drawn around it moves it", () => {
    const run = frames();
    const { pane, block } = note();
    const { target, scrolls, place, top } = block(FAR);
    scrollToPlace(target, true, "nearest");
    expect(scrolls).toEqual([{ behavior: "auto", block: "nearest" }]);
    run(3);
    expect(pane.scrollTop).toBe(FAR);
    // A diagram above the target draws a few frames after the jump.
    place.at += 180;
    run();
    expect(pane.scrollTop).toBe(FAR + 180);
    expect(top()).toBe(0);
    // It lets go once the target has been still for a second and a half.
    expect(run(60)).toBe(true);
    expect(run(40)).toBe(false);
    place.at += 90;
    run();
    expect(top()).toBe(90);
    // One scroll to the target itself: the rest moved the pane by what moved.
    expect(scrolls).toHaveLength(1);
  });

  it("looks where the target is before it lets go, after frames that waited", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => queue.push(run));
    const { block } = note();
    const { target, place, top } = block(FAR);
    scrollToPlace(target, false);
    // The note took three seconds to draw, and moved the target meanwhile.
    place.at += 400;
    now = 3_000;
    queue.shift()?.(now);
    expect(top()).toBe(0);
    expect(queue).toHaveLength(1);
  });

  it("follows the target as what is above it in its own block grows", () => {
    const run = frames();
    const { block } = note();
    const { target, place, top } = block(FAR);
    place.within = 40;
    scrollToPlace(target, false);
    // A diagram in the same quote draws: the block stays, the target moves.
    place.within += 500;
    run();
    expect(top()).toBe(0);
  });

  it("follows the block when the element it scrolled to is gone", () => {
    const run = frames();
    const { block } = note();
    const { target, place, top } = block(FAR);
    scrollToPlace(target, false);
    // A reveal's flash is taken away, and a find match drawn again.
    target.remove();
    place.at += 250;
    expect(run()).toBe(true);
    expect(top()).toBe(0);
  });

  it("lets a later jump end an earlier one", () => {
    const run = frames();
    const { pane, block } = note();
    const far = block(FAR);
    const near = block(100);
    scrollToPlace(far.target, false);
    pane.scrollTop = 0;
    scrollToPlace(near.target, false);
    far.place.at += 500;
    expect(run()).toBe(false);
    expect(pane.scrollTop).toBe(100);
  });

  it("lets go when something else scrolls the view", () => {
    const run = frames();
    const { pane, block } = note();
    const { target, place, top } = block(FAR);
    scrollToPlace(target, false);
    // The wheel, the scrollbar, or the editor showing its caret.
    pane.scrollTop -= 5_000;
    expect(run()).toBe(false);
    expect(top()).toBe(5_000);
    place.at += 300;
    run();
    expect(top()).toBe(5_300);
  });

  it("lets go at once when the person turns the wheel or presses", () => {
    for (const move of [new WheelEvent("wheel"), new Event("pointerdown")]) {
      const run = frames();
      const { pane, block } = note();
      const { target, place, top } = block(FAR);
      scrollToPlace(target, false);
      window.dispatchEvent(move);
      // The wheel moved the view while a block above grew, in one frame.
      pane.scrollTop += 100;
      place.at += 200;
      expect(run()).toBe(false);
      expect(top()).toBe(100);
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("keeps hold through a scroll the browser makes to keep the view still", () => {
    const run = frames();
    const { pane, block } = note();
    const { target, place, top } = block(FAR);
    scrollToPlace(target, false);
    // A block above grows, and the browser scrolls by as much.
    place.at += 200;
    pane.scrollTop += 200;
    expect(run()).toBe(true);
    place.at += 100;
    run();
    expect(top()).toBe(0);
  });

  it("lets go of a block that left the page", () => {
    const run = frames();
    const { block } = note();
    const { element, target } = block(FAR);
    scrollToPlace(target, false);
    element.remove();
    expect(run()).toBe(false);
  });
});
