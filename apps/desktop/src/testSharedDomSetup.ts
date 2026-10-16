import { cleanup } from "@testing-library/react";
import { afterAll, vi } from "vitest";

// The shared jsdom project runs its files one after another in one window. When
// a file ends, it leaves the next file an empty document, empty storage, real
// timers, and the globals the window started with. A file that mounts its own
// React root, rather than through Testing Library, still loses its DOM here.
afterAll(() => {
  cleanup();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
