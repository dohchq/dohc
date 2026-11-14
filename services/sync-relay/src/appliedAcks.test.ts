import { expect, it } from "vitest";
import { createAppliedAcks } from "./appliedAcks.js";

const ack = (deliveryId: string) => ({
  deliveryId,
  updateDigest: "ab".repeat(32),
  journalCursor: 1,
  acceptingHostEpoch: 1,
  localYDocSequence: 1,
  applicationReplayed: false,
});

it("keeps only applied answers, each taken once, and drops the oldest past its limit", () => {
  const acks = createAppliedAcks(2);
  acks.record({ status: "pending", reason: "application-pending", ack: ack("pending") });
  acks.record({ status: "applied", ack: { deliveryId: "malformed" } });
  for (const id of ["first", "second", "third"]) acks.record({ status: "applied", ack: ack(id) });
  expect(acks.take(ack("pending"))).toBeUndefined();
  expect(acks.take(ack("first"))).toBeUndefined();
  expect(acks.take(ack("second"))).toEqual(ack("second"));
  expect(acks.take(ack("second"))).toBeUndefined();
  expect(acks.take(ack("third"))).toEqual(ack("third"));
});
