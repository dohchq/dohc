import {expect, it} from "vitest";
import {createLiveBufferBudget, LiveConnectionLimitError, LIVE_CONNECTION_LIMIT_MESSAGES, liveConnectionLimitMessage} from "./liveConnection";
it("bounds aggregate bytes exactly and releases once", () => {
  const budget = createLiveBufferBudget(10), first = budget.reserve(6), second = budget.reserve(4);
  expect(budget.usage()).toBe(10);
  expect(() => budget.reserve(1)).toThrowError(new LiveConnectionLimitError("live_buffer_limit"));
  first(); first(); expect(budget.usage()).toBe(4);
  const third = budget.reserve(6); third(); second(); expect(budget.usage()).toBe(0);
});
it("shows only known limit messages", () => {
  for (const [code, message] of Object.entries(LIVE_CONNECTION_LIMIT_MESSAGES)) expect(liveConnectionLimitMessage(code)).toBe(message);
  expect(liveConnectionLimitMessage("private-share-name")).toBeUndefined();
  expect(liveConnectionLimitMessage("__proto__")).toBeUndefined();
});
