import { describe, expect, it } from "vitest";
import { nextReachVerdict } from "./reachVerdicts";

const allowed = { allowed: true } as const;
const stoppedByBob = { allowed: false, reason: "bob@dohc.test cannot edit Budget.", person: "bob@dohc.test" } as const;

describe("reach verdicts", () => {
  it("allows a step first seen allowed, and stops one first seen stopped", () => {
    expect(nextReachVerdict(undefined, allowed)).toEqual({ verdict: "allowed", stoppedFor: null });
    expect(nextReachVerdict(undefined, stoppedByBob)).toEqual({ verdict: "stopped", stoppedFor: "bob@dohc.test" });
  });

  it("holds a stopped step that becomes allowed, and keeps holding it until someone confirms", () => {
    const held = nextReachVerdict({ verdict: "stopped", stoppedFor: "bob@dohc.test" }, allowed);
    expect(held).toEqual({ verdict: "held", stoppedFor: "bob@dohc.test" });
    expect(nextReachVerdict(held, allowed)).toEqual(held);
  });

  it("stops a held or allowed step whose reach narrows again", () => {
    expect(nextReachVerdict({ verdict: "held", stoppedFor: "bob@dohc.test" }, stoppedByBob).verdict).toBe("stopped");
    expect(nextReachVerdict({ verdict: "allowed", stoppedFor: null }, stoppedByBob).verdict).toBe("stopped");
    expect(nextReachVerdict({ verdict: "allowed", stoppedFor: null }, allowed).verdict).toBe("allowed");
  });
});
