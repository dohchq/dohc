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

it.each(["principal", "share"])("contains a %s reservation within its portion and does not charge a failed reservation", scope => {
  const budget = createLiveBufferBudget(128 * 1024 * 1024), MiB = 1024 * 1024;
  const scopes: [string, number][] = [["principal", 12 * MiB], ["share", 80 * MiB]];
  const ownScopes = scope === "share" ? [["other-principal", 128 * MiB], scopes[1]!] as [string, number][] : scopes;
  const maximum = scope === "share" ? 80 * MiB : 12 * MiB;
  const release = budget.reserve(maximum, ownScopes);
  expect(() => budget.reserve(1, ownScopes)).toThrowError(LiveConnectionLimitError);
  expect(budget.usage()).toBe(maximum);
  const other = budget.reserve(4 * MiB, [["other-person", 12 * MiB], ["other-share", 80 * MiB]]);
  expect(budget.usage()).toBe(maximum + 4 * MiB);
  release(); release(); other(); expect(budget.usage()).toBe(0);
  const all = budget.reserve(maximum, ownScopes); all(); expect(budget.usage()).toBe(0);
});

it("validates scoped byte bounds without charging the pool", () => {
  const budget = createLiveBufferBudget(10);
  for (const limit of [0, -1, 1.5, NaN, Infinity]) expect(() => budget.reserve(1, [["person", limit]])).toThrow(TypeError);
  expect(() => budget.reserve(1, [["person", 5], ["person", 5]])).toThrow(TypeError);
  expect(budget.usage()).toBe(0);
});
