import { cleanup } from "@testing-library/react";
import { afterAll } from "vitest";

// The shared jsdom project runs its files one after another in one window. When
// a file ends, it leaves the next file an empty document and empty storage. A
// file that mounts its own React root, rather than through Testing Library,
// still loses its DOM here. testSharedWorkerSetup.ts restores the rest.
afterAll(() => {
  cleanup();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});
