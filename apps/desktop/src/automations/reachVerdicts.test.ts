import { describe, expect, it } from "vitest";
import { nextReachVerdict } from "./reachVerdicts";

const allowed = { allowed: true } as const;
const stoppedByBob = { allowed: false, reason: "bob@dohc.test cannot edit Budget.", person: "bob@dohc.test" } as const;

describe("reach verdicts", () => {
  it("allows a step first seen allowed, and stops one first seen stopped", () => {
    expect(nextReachVerdict(undefined, allowed, true)).toEqual({ verdict: "allowed", stoppedFor: null });
    expect(nextReachVerdict(undefined, stoppedByBob, true)).toEqual({ verdict: "stopped", stoppedFor: "bob@dohc.test" });
  });

  it("holds a stopped step that becomes allowed, and keeps holding it until someone confirms", () => {
    const held = nextReachVerdict({ verdict: "stopped", stoppedFor: "bob@dohc.test" }, allowed, true);
    expect(held).toEqual({ verdict: "held", stoppedFor: "bob@dohc.test" });
    expect(nextReachVerdict(held, allowed, true)).toEqual(held);
  });

  it("stops a held or allowed step whose reach narrows again", () => {
    expect(nextReachVerdict({ verdict: "held", stoppedFor: "bob@dohc.test" }, stoppedByBob, true).verdict).toBe("stopped");
    expect(nextReachVerdict({ verdict: "allowed", stoppedFor: null }, stoppedByBob, true).verdict).toBe("stopped");
    expect(nextReachVerdict({ verdict: "allowed", stoppedFor: null }, allowed, true).verdict).toBe("allowed");
  });

  it("marks a switched-on step that could run and now cannot, until it is dismissed or reach comes back", () => {
    const narrowed = nextReachVerdict({ verdict: "allowed", stoppedFor: null }, stoppedByBob, true);
    expect(narrowed).toEqual({ verdict: "stopped", stoppedFor: "bob@dohc.test", narrowed: true });
    expect(nextReachVerdict(narrowed, stoppedByBob, true)).toEqual(narrowed);
    // Dismissed: it stays stopped and is not announced again.
    expect(nextReachVerdict({ verdict: "stopped", stoppedFor: "bob@dohc.test" }, stoppedByBob, true))
      .toEqual({ verdict: "stopped", stoppedFor: "bob@dohc.test" });
    // Reach comes back: the step waits for a current editor, as any widening does.
    expect(nextReachVerdict(narrowed, allowed, true)).toEqual({ verdict: "held", stoppedFor: "bob@dohc.test" });
    // A switched-off automation's step, or one held and never run, stops without a notice.
    expect(nextReachVerdict({ verdict: "allowed", stoppedFor: null }, stoppedByBob, false).narrowed).toBeUndefined();
    expect(nextReachVerdict({ verdict: "held", stoppedFor: "bob@dohc.test" }, stoppedByBob, true).narrowed).toBeUndefined();
  });
});
