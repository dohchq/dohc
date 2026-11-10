import { describe, expect, it } from "vitest";
import { failureStep, type Reported } from "./failureReports";

const none: Reported = { instance: 1, failures: 0 };
const busy = (failures: number) => ({ problem: "server-busy" as const, failures });
const fine = (failures: number) => ({ problem: null, failures });

describe("reporting a failure", () => {
  it("reports each new failure of a store once, and takes it back at a success", () => {
    const first = failureStep(none, 1, busy(1));
    expect(first).toEqual({ reported: { instance: 1, failures: 1 }, show: true, takeBack: false });
    expect(failureStep(first.reported, 1, busy(1)).show).toBe(false);
    expect(failureStep(first.reported, 1, busy(2)).show).toBe(true);
    expect(failureStep(first.reported, 1, fine(1))).toMatchObject({ show: false, takeBack: true });
  });

  it("counts a new store's failures from none, so its first is reported", () => {
    const old = failureStep(none, 1, busy(1)).reported;
    // Try again replaced the store; the new one's first failure has the same count the old one reported.
    expect(failureStep(old, 2, busy(1))).toEqual({ reported: { instance: 2, failures: 1 }, show: true, takeBack: true });
  });

  it("takes back the last store's report when a new store has nothing to report yet", () => {
    const old = failureStep(none, 1, busy(3)).reported;
    expect(failureStep(old, 2, fine(0))).toEqual({ reported: { instance: 2, failures: 0 }, show: false, takeBack: true });
    expect(failureStep({ instance: 2, failures: 0 }, 2, fine(0)).takeBack).toBe(false);
  });
});
