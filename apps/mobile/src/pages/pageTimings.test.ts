import { describe, expect, it } from "vitest";
import type { AccountState } from "../server/account";
import { createPageTimings, timingOwner } from "./pageTimings";

const owner = timingOwner({ origin: "https://dohc.example.com", userId: "u-1" });

describe("page open timings", () => {
  it("counts each step once, in ms from the tap", () => {
    let now = 1040;
    const timings = createPageTimings(() => now);
    const mark = timings.open("Packing list", owner, 1000);
    now = 1100;
    mark("started");
    now = 1150;
    mark("read");
    mark("painted");
    now = 2000;
    mark("painted");
    expect(timings.opens(owner)).toEqual([
      { name: "Packing list", tap: 1000, started: 100, read: 150, painted: 150 },
    ]);
  });

  it("counts from the open without a tap", () => {
    let now = 500;
    const timings = createPageTimings(() => now);
    const mark = timings.open("From a link", owner);
    now = 520;
    mark("painted");
    expect(timings.opens(owner)).toEqual([{ name: "From a link", tap: 500, painted: 20 }]);
  });

  it("keeps the last 10 opens, newest first", () => {
    const timings = createPageTimings(() => 0);
    for (let index = 1; index <= 12; index++) timings.open(`Page ${index}`, owner);
    expect(timings.opens(owner).map((open) => open.name)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Page ${12 - index}`),
    );
  });

  it("shows one sign-in's opens only to it, and drops them when another sign-in opens a page", () => {
    const timings = createPageTimings(() => 0);
    const next = timingOwner({ origin: "https://dohc.example.com", userId: "u-2" });
    timings.open("Salary review", owner);
    expect(timings.opens(next)).toEqual([]);
    timings.open("Packing list", next);
    expect(timings.opens(next).map((open) => open.name)).toEqual(["Packing list"]);
    expect(timings.opens(owner)).toEqual([]);
  });

  it("forgets the opens when their sign-in ends, and keeps them while it lasts", () => {
    const timings = createPageTimings(() => 0);
    let state = {
      status: "signed-in",
      signIn: { origin: "https://dohc.example.com", userId: "u-1" },
    } as unknown as AccountState;
    let changed = () => {};
    timings.follow({
      state: () => state,
      subscribe: (listener) => {
        changed = listener;
        return () => {};
      },
    });
    timings.open("Salary review", owner);
    changed();
    expect(timings.opens(owner)).toHaveLength(1);
    state = { status: "signed-out" } as unknown as AccountState;
    changed();
    expect(timings.opens(owner)).toEqual([]);
  });
});
