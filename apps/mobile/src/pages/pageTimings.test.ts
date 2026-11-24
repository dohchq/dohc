import { describe, expect, it } from "vitest";
import { createPageTimings } from "./pageTimings";

describe("page open timings", () => {
  const signIn = {};

  it("counts each step once, in ms from the tap", () => {
    let now = 1040;
    const timings = createPageTimings(() => now);
    const mark = timings.open("Packing list", signIn, 1000);
    now = 1100;
    mark("started");
    now = 1150;
    mark("read");
    mark("painted");
    now = 2000;
    mark("painted");
    expect(timings.opens(signIn)).toEqual([
      { name: "Packing list", tap: 1000, started: 100, read: 150, painted: 150 },
    ]);
  });

  it("counts from the open without a tap", () => {
    let now = 500;
    const timings = createPageTimings(() => now);
    const mark = timings.open("From a link", signIn);
    now = 520;
    mark("painted");
    expect(timings.opens(signIn)).toEqual([{ name: "From a link", tap: 500, painted: 20 }]);
  });

  it("keeps the last 10 opens, newest first", () => {
    const timings = createPageTimings(() => 0);
    for (let index = 1; index <= 12; index++) timings.open(`Page ${index}`, signIn);
    expect(timings.opens(signIn).map((open) => open.name)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Page ${12 - index}`),
    );
  });

  it("shows one sign-in's opens only to it, and drops them when another sign-in opens a page", () => {
    const timings = createPageTimings(() => 0);
    const first = {};
    const next = {};
    timings.open("Salary review", first);
    expect(timings.opens(next)).toEqual([]);
    timings.open("Packing list", next);
    expect(timings.opens(next).map((open) => open.name)).toEqual(["Packing list"]);
    expect(timings.opens(first)).toEqual([]);
  });
});
