// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

// Runs after leavesState.fixture-test.ts in the same worker.
it("runs in the worker the previous file left dirty", () => {
  expect((globalThis as unknown as Record<symbol, boolean>)[Symbol.for("dohc.sharedWorkerFixture.ran")]).toBe(true);
});

it("starts from the worker's baseline", () => {
  expect(process.env.DOHC_SHARED_FIXTURE).toBeUndefined();
  expect(process.env.DOHC_SHARED_FIXTURE_STUB).toBeUndefined();
  expect("dohcSharedFixture" in globalThis).toBe(false);
  expect("dohcSharedWindowFixture" in window).toBe(false);
  expect(vi.isMockFunction(window.scrollTo)).toBe(false);
  expect("scrollIntoView" in Element.prototype).toBe(false);
  expect("hasPointerCapture" in HTMLElement.prototype).toBe(false);
  expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  expect(document.documentElement.getAttribute("style")).toBeNull();
  expect(document.body.childNodes).toHaveLength(0);
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  expect(vi.isFakeTimers()).toBe(false);
});
