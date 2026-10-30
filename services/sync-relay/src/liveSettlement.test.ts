import { expect, it } from "vitest";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { settlementResult } from "./liveSettlement.js";

const receipt = (journalCursor: number) => ({
  deliveryId: "delivery", updateDigest: "a".repeat(64), journalCursor, acceptingHostEpoch: parseHostEpoch(1),
});
const response = (settlement: Record<string, unknown> = {}) => ({
  status: "settled",
  settlement: {
    settlementId: null, previousCursor: 7, terminalCursor: 7, applicationCount: 0,
    localYDocSequence: 3, momentId: "moment", markdownDigest: "b".repeat(64),
    materialized: true, collectionReconcileRequired: false, ...settlement,
  },
});

it("reads a finished settlement with no ID at a handover cursor", () => {
  expect(settlementResult(response(), receipt(7))).toEqual(response().settlement);
});
it("reads a finished settlement with no ID before the first accepted edit", () => {
  expect(settlementResult(response({previousCursor: 0, terminalCursor: 0}), null)).toMatchObject({settlementId: null});
});
it("reads a recorded settlement covering an accepted edit", () => {
  expect(settlementResult(response({settlementId: "settlement", previousCursor: 6, applicationCount: 1}), receipt(7))).toMatchObject({settlementId: "settlement"});
});
it.each([0, 1])("refuses a null settlement ID for differing cursors with %i applications", applicationCount => {
  expect(() => settlementResult(response({previousCursor: 6, applicationCount}), receipt(7))).toThrow("Native settlement coverage mismatch.");
});
