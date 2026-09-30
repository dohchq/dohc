import "../testing/legendListMock";
import { vi } from "vitest";
import "./workbench/ChatsView";

// Collection dependencies read these observers during module evaluation.
// Collection suites preload their view after installing these observer stubs.
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
