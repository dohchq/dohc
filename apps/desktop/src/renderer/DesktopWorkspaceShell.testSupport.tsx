import "../testing/legendListMock";
import { vi } from "vitest";
import "./CollectionPage";
import "./workbench/ChatsView";

// Collection dependencies read these observers during module evaluation.
// Preload them before tests so an unfinished import cannot clean up a later test's globals.
const { ObserverStub } = vi.hoisted(() => {
  class ObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): never[] { return []; }
  }
  Object.assign(globalThis, { ResizeObserver: ObserverStub, IntersectionObserver: ObserverStub });
  return { ObserverStub };
});

export { ObserverStub };
