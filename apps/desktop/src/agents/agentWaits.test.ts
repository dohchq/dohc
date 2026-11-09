import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAgentWaits } from "./agentWaits";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("says an agent listens from its first wait until its last one ends", () => {
  const onChange = vi.fn();
  const waits = createAgentWaits(onChange, 2_000);
  const first = waits.begin("terminal");
  expect(onChange).toHaveBeenLastCalledWith(["terminal"]);
  const second = waits.begin("terminal");
  const other = waits.begin("agent");
  expect(onChange).toHaveBeenLastCalledWith(["agent", "terminal"]);
  expect(onChange).toHaveBeenCalledTimes(2);
  first();
  // Its second wait is still open.
  vi.advanceTimersByTime(2_000);
  expect(waits.listening()).toEqual(["agent", "terminal"]);
  expect(onChange).toHaveBeenCalledTimes(2);
  second();
  vi.advanceTimersByTime(2_000);
  expect(onChange).toHaveBeenLastCalledWith(["agent"]);
  other();
  vi.advanceTimersByTime(2_000);
  expect(onChange).toHaveBeenLastCalledWith([]);
  expect(waits.listening()).toEqual([]);
});

it("keeps an agent listening when it waits again before the hold ends", () => {
  const onChange = vi.fn();
  const waits = createAgentWaits(onChange, 2_000);
  waits.begin("terminal")();
  vi.advanceTimersByTime(1_999);
  expect(waits.listening()).toEqual(["terminal"]);
  const again = waits.begin("terminal");
  vi.advanceTimersByTime(10_000);
  expect(waits.listening()).toEqual(["terminal"]);
  expect(onChange).toHaveBeenCalledTimes(1);
  again();
  vi.advanceTimersByTime(2_000);
  expect(onChange).toHaveBeenLastCalledWith([]);
  expect(onChange).toHaveBeenCalledTimes(2);
});

it("stops listening at once when a wait fails or is aborted", () => {
  const onChange = vi.fn();
  const waits = createAgentWaits(onChange, 2_000);
  waits.begin("terminal")(false);
  expect(onChange).toHaveBeenLastCalledWith([]);
  expect(waits.listening()).toEqual([]);
  expect(onChange).toHaveBeenCalledTimes(2);
});

it("ends a wait once, however often its end runs", () => {
  const onChange = vi.fn();
  const waits = createAgentWaits(onChange, 2_000);
  const first = waits.begin("terminal");
  const second = waits.begin("terminal");
  first();
  first();
  vi.advanceTimersByTime(2_000);
  expect(waits.listening()).toEqual(["terminal"]);
  second();
  vi.advanceTimersByTime(2_000);
  expect(waits.listening()).toEqual([]);
  expect(onChange).toHaveBeenCalledTimes(2);
});
