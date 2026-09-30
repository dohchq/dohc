import { expect, it } from "vitest";
import { DaemonRefusalError, isTransientEngineRefusal, isYdocAuthorCapacityRefusal } from "./daemonLiveAdapter";

it("retries only the author-capacity limit refusal", () => {
  const capacity = new DaemonRefusalError({code: "LIMIT_EXCEEDED", message: "ydoc-author-capacity", retry: "no"}, null);
  const oversized = new DaemonRefusalError({code: "LIMIT_EXCEEDED", message: "author details too large", retry: "no"}, null);
  expect(isYdocAuthorCapacityRefusal(capacity)).toBe(true);
  expect(isTransientEngineRefusal(capacity)).toBe(true);
  expect(isTransientEngineRefusal(oversized)).toBe(false);
});
