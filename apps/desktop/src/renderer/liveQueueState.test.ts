import { describe, expect, it } from "vitest";
import type { OwnerLiveQuarantine } from "../ipc/bridgeContract";
import { keptEditsLabel, queueHoldsNote } from "./liveQueueState";

type Outcome = { holds: boolean; label: string | null };
const held = (label: string): Outcome => ({ holds: true, label });
const free = (label: string | null): Outcome => ({ holds: false, label });

const TABLE = {
  paused: {
    current: held("Paused"),
    saveOnly: free("Not written"),
    earlier: free("Kept on the server"),
  },
  copied: {
    current: held("Paused"),
    saveOnly: free("Not written"),
    earlier: free("Kept on the server"),
  },
  retrying: {
    current: held("Trying again"),
    saveOnly: free("Not written"),
    earlier: free("Kept on the server"),
  },
  stopping: {
    current: held("Stopping"),
    saveOnly: free("Not written"),
    earlier: free("Kept on the server"),
  },
  unreadable: {
    current: held("Can't read edits"),
    saveOnly: free("Can't read edits"),
    earlier: free("Can't read edits"),
  },
  "stopped-kept": {
    current: free("Stopped"),
    saveOnly: free("Not written"),
    earlier: free("Kept on the server"),
  },
  "not-written": {
    current: free(null),
    saveOnly: free("Not written"),
    earlier: free("Kept on the server"),
  },
  "cannot-write": {
    current: free(null),
    saveOnly: free("Not written"),
    earlier: free("Kept on the server"),
  },
} satisfies Record<
  OwnerLiveQuarantine["recovery"],
  Record<"current" | "saveOnly" | "earlier", Outcome>
>;

const HELD_LABELS = new Set(["Paused", "Trying again", "Stopping"]);

describe("kept edits, in the editor and in Live documents", () => {
  for (const [recovery, cases] of Object.entries(TABLE) as [
    OwnerLiveQuarantine["recovery"],
    (typeof TABLE)[keyof typeof TABLE],
  ][]) {
    for (const [kind, expected] of Object.entries(cases)) {
      it(`${recovery}, ${kind}`, () => {
        const row = {
          recovery,
          ...(kind === "saveOnly"
            ? { saveOnly: true as const }
            : kind === "earlier"
              ? { earlier: true as const }
              : {}),
        };
        expect({ holds: queueHoldsNote(row), label: keptEditsLabel(row) }).toEqual(expected);
        if (expected.label !== null && HELD_LABELS.has(expected.label))
          expect(expected.holds).toBe(true);
      });
    }
  }
});
