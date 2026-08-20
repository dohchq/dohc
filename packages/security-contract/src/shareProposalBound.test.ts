import { describe, expect, it } from "vitest";
import { MAX_SHARE_PROPOSAL_OPS } from "./shareProposalBound";

// The bound is a MEASURED number, so something has to hold it to the
// measurement. Every other test of it builds its fixtures from the constant
// itself and therefore moves with it — those prove the route and the contract
// agree, not that the number is right.
//
// Evidence: the share-submit bound test in packages/security-contract
describe("the share submit bound", () => {
  // What the measurement actually found, written down here so a change to the
  // bound has to argue with it.
  const HEALTHY_MAX_CHANGED_FILES = 1_434; // one share of a repo-sized folder
  const FORTNIGHT_OF_ORDINARY_WORK = 733;
  const RELAY_MEASURED_LINEAR_TO = 5_000;

  it("sits above the healthy work it must not reject", () => {
    expect(
      MAX_SHARE_PROPOSAL_OPS,
      "MUTATION: a bound at or below measured healthy work rejects work people really do, " +
        "which is what AGENTS.md forbids",
    ).toBeGreaterThan(HEALTHY_MAX_CHANGED_FILES);
    expect(MAX_SHARE_PROPOSAL_OPS).toBeGreaterThan(FORTNIGHT_OF_ORDINARY_WORK);
  });

  it("stays inside the range the relay was measured over", () => {
    expect(
      MAX_SHARE_PROPOSAL_OPS,
      "MUTATION: a bound past the measured range states a cost nobody observed",
    ).toBeLessThanOrEqual(RELAY_MEASURED_LINEAR_TO);
  });

  // The number itself. A drift here is a decision, and a decision needs the
  // measurement re-run and the record updated.
  it("is the number the decision record states", () => {
    expect(MAX_SHARE_PROPOSAL_OPS).toBe(2500);
  });
});
