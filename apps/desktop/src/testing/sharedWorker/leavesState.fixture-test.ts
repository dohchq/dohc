// @vitest-environment jsdom
import { afterAll, expect, it, vi } from "vitest";

// Leaves behind each kind of state the shared reset restores, then fails its
// afterAll. vitest runs a file's own afterAll hooks before the setup files'
// ones and skips the rest after a failure, so the end-of-file cleanup never
// runs. checksBaseline.fixture-test.ts runs next in the same worker.
it("leaves the worker dirty", () => {
  (globalThis as unknown as Record<symbol, boolean>)[Symbol.for("dohc.sharedWorkerFixture.ran")] = true;
  process.env.DOHC_SHARED_FIXTURE = "left";
  vi.stubEnv("DOHC_SHARED_FIXTURE_STUB", "stubbed");
  vi.stubGlobal("dohcSharedFixture", { left: true });
  Object.assign(window, { dohcSharedWindowFixture: { left: true } });
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => true;
  document.documentElement.dataset.theme = "dark";
  document.documentElement.style.colorScheme = "dark";
  document.body.append(Object.assign(document.createElement("div"), { id: "left-behind" }));
  localStorage.setItem("left", "behind");
  sessionStorage.setItem("left", "behind");
  vi.useFakeTimers();
  expect(document.getElementById("left-behind")).not.toBeNull();
});

afterAll(() => {
  throw new Error("leaves the worker dirty");
});
