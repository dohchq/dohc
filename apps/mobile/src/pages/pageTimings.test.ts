import { describe, expect, it } from "vitest";
import { createPageTimings } from "./pageTimings";

describe("page open timings", () => {
  it("counts each step once, in ms from the tap", () => {
    let now = 1000;
    const timings = createPageTimings(() => now);
    timings.tap();
    now = 1040;
    const mark = timings.open("Packing list");
    now = 1100;
    mark("started");
    now = 1150;
    mark("read");
    mark("painted");
    now = 2000;
    mark("painted");
    expect(timings.opens()).toEqual([
      { name: "Packing list", tap: 1000, started: 100, read: 150, painted: 150 },
    ]);
  });

  it("counts from the open without a tap, and a tap only for the open after it", () => {
    let now = 0;
    const timings = createPageTimings(() => now);
    timings.tap();
    timings.open("Tapped");
    now = 500;
    const mark = timings.open("From a notice");
    now = 520;
    mark("painted");
    expect(timings.opens()[0]).toEqual({ name: "From a notice", tap: 500, painted: 20 });
  });

  it("keeps the last 10 opens, newest first", () => {
    const timings = createPageTimings(() => 0);
    for (let index = 1; index <= 12; index++) timings.open(`Page ${index}`);
    expect(timings.opens().map((open) => open.name)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Page ${12 - index}`),
    );
  });
});
