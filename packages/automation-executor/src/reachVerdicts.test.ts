import { describe, expect, it } from "vitest";
import { mergedReachVerdict, nextReachVerdict, parseReachHandover } from "./reachVerdicts";

const allowed = { allowed: true } as const;
const stoppedByBob = { allowed: false, reason: "bob@dohc.test cannot edit Budget.", person: "bob@dohc.test" } as const;

describe("reach verdicts", () => {
  it("allows a step first seen allowed, and stops one first seen stopped", () => {
    expect(nextReachVerdict(undefined, allowed, true)).toEqual({ verdict: "allowed", stoppedFor: null });
    expect(nextReachVerdict(undefined, stoppedByBob, true)).toEqual({ verdict: "stopped", stoppedFor: "bob@dohc.test" });
  });

  it("holds an allowed step once for each link that could have written it and stopped editing", () => {
    const trip = { evidence: "g-trip#1", name: "Anyone who had your share link to Trip" };
    const notes = { evidence: "g-notes#1", name: "Anyone who had your share link to Notes" };
    const former = { allowed: true, formerStops: [trip] } as const;
    const held = { verdict: "held", stoppedFor: trip.name, accountedLinks: ["g-trip#1"] };
    expect(nextReachVerdict(undefined, former, true)).toEqual(held);
    // Allowed before the link ended: the link may have switched it on since.
    expect(nextReachVerdict({ verdict: "allowed", stoppedFor: null }, former, true)).toEqual(held);
    // Confirmed with that link in view: not asked again, until another link appears.
    const confirmed = { verdict: "allowed", stoppedFor: null, accountedLinks: ["g-trip#1"] } as const;
    expect(nextReachVerdict(confirmed, former, true)).toEqual(confirmed);
    expect(nextReachVerdict(confirmed, { allowed: true, formerStops: [trip, notes] }, true))
      .toEqual({ verdict: "held", stoppedFor: notes.name, accountedLinks: ["g-notes#1", "g-trip#1"] });
    // A step stopped for a current editor stays stopped, and keeps what it accounted for.
    expect(nextReachVerdict(confirmed, stoppedByBob, true))
      .toEqual({ verdict: "stopped", stoppedFor: "bob@dohc.test", narrowed: true, accountedLinks: ["g-trip#1"] });
    expect(nextReachVerdict({ verdict: "held", stoppedFor: "ana@dohc.test" }, former, true))
      .toEqual({ verdict: "held", stoppedFor: "ana@dohc.test", accountedLinks: ["g-trip#1"] });
    // The same link, after an editing period under a newer generation, is new evidence.
    expect(nextReachVerdict(confirmed, { allowed: true, formerStops: [{ ...trip, evidence: "g-trip#2" }] }, true))
      .toEqual({ verdict: "held", stoppedFor: trip.name, accountedLinks: ["g-trip#1", "g-trip#2"] });
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
    // A switched-off automation's step, or one held and never run, stops without a notice,
    // and switching an automation off ends the notice for its stopped step.
    expect(nextReachVerdict({ verdict: "allowed", stoppedFor: null }, stoppedByBob, false).narrowed).toBeUndefined();
    expect(nextReachVerdict(narrowed, stoppedByBob, false)).toEqual({ verdict: "stopped", stoppedFor: "bob@dohc.test" });
    expect(nextReachVerdict({ verdict: "held", stoppedFor: "bob@dohc.test" }, stoppedByBob, true).narrowed).toBeUndefined();
  });
});

describe("verdicts taken from the last host", () => {
  const base = { automationId: "collection:Tasks#a", definitionHash: "h1", step: "0", seq: 4 } as const;
  const allowedHere = { ...base, verdict: "allowed", stoppedFor: null } as const;
  const stoppedThere = { ...base, verdict: "stopped", stoppedFor: "bob@dohc.test", seq: 9 } as const;
  const heldThere = { ...base, verdict: "held", stoppedFor: "bob@dohc.test", seq: 9 } as const;

  it("keeps a step stopped or held on either host, and takes an allowed step only where there is none", () => {
    expect(mergedReachVerdict(allowedHere, stoppedThere)).toEqual(stoppedThere);
    expect(mergedReachVerdict(allowedHere, heldThere)).toEqual(heldThere);
    expect(mergedReachVerdict({ ...stoppedThere, seq: 2 }, { ...allowedHere, seq: 9 })).toBeUndefined();
    expect(mergedReachVerdict(allowedHere, { ...allowedHere, seq: 9 })).toBeUndefined();
    expect(mergedReachVerdict(undefined, allowedHere)).toEqual(allowedHere);
  });

  it("reads a release's verdicts, and none from anything else", () => {
    expect(parseReachHandover({ version: 2, verdicts: [stoppedThere], unproven: ["k"], unprovenAll: false, unprovenPaths: [], unprovenFolders: ["Tasks"] }))
      .toEqual({ version: 2, verdicts: [stoppedThere], unproven: ["k"], unprovenAll: false, unprovenPaths: [], unprovenFolders: ["Tasks"] });
    expect(parseReachHandover({ version: 2, verdicts: [stoppedThere] })).toBeNull();
    expect(parseReachHandover({ version: 2, verdicts: [] })).toBeNull();
    expect(parseReachHandover({ version: 2, verdicts: [{ ...stoppedThere, verdict: "maybe" }] })).toBeNull();
    expect(parseReachHandover({ version: 1, verdicts: [stoppedThere], unproven: [], unprovenAll: false, unprovenFolders: ["Tasks"] })).toBeNull();
    expect(parseReachHandover(null)).toBeNull();
  });
});
