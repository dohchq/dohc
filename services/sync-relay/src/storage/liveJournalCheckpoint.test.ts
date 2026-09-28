import { expect, it } from "vitest";
import { liveJournalCheckpointDue } from "./liveJournalCheckpoint";

it("makes a checkpoint due only at the 4095th update or at 20 MiB", () => {
  const due = Array.from({ length: 4095 }, (_, index) => index + 1).filter(count => liveJournalCheckpointDue(count, count * 2));
  expect(due).toEqual([4095]);
  expect(liveJournalCheckpointDue(1, 20_971_519)).toBe(false);
  expect(liveJournalCheckpointDue(1, 20_971_520)).toBe(true);
});
