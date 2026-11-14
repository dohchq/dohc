import { expect, it } from "vitest";
import { createLogLineCap } from "./logLineCap";

it("logs a key once a window and counts what it held back in the next line", () => {
  const cap = createLogLineCap(1000, 4);
  expect(cap("a", 0)).toBe(0);
  expect([cap("a", 1), cap("a", 999)]).toEqual([undefined, undefined]);
  expect(cap("a", 1000)).toBe(2);
  expect(cap("a", 1999)).toBeUndefined();
  expect(cap("a", 2000)).toBe(1);
  expect(cap("a", 3000)).toBe(0);
});

it("forgets the least recently logged key once it holds the most keys", () => {
  const cap = createLogLineCap(1000, 2);
  cap("a", 0);
  cap("b", 1);
  expect(cap("a", 2)).toBeUndefined();
  // "a" logged first, so "c" evicts it and keeps "b"; a held-back line does not refresh its key.
  expect(cap("c", 3)).toBe(0);
  expect(cap("b", 4)).toBeUndefined();
  expect(cap("a", 5)).toBe(0);
});
