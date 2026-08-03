import { describe, expect, it } from "vitest";
import { createShareSkipRecorder } from "./shareSkipRecorder";
import type { ShareSkippedOps } from "./registryStore";

interface Record {
  shareId: string;
  skippedOps?: ShareSkippedOps;
}

function refusal(originSeq: number) {
  return {
    originId: "origin-granter",
    originSeq,
    opKind: "moment.append",
    code: "share-boundary-violation",
    detail: `refused ${originSeq}`,
  };
}

function target(initial: Record) {
  let stored: Record | undefined = initial;
  const effects: string[] = [];
  return {
    effects,
    stored: () => stored,
    recorder: createShareSkipRecorder<Record>({
      current: () => stored,
      persist: (next) => {
        stored = next;
        effects.push("persist");
      },
      now: () => 1000,
    }),
    drop: () => {
      stored = undefined;
    },
  };
}

describe("share skip recorder", () => {
  // A pull hands each page's refusals over BEFORE committing that page's
  // cursor, so every page has to land on its own — an accumulate-then-write
  // recorder would lose the early pages when a later one fails.
  it("persists every page and merges them cumulatively", async () => {
    const share = target({ shareId: "share-1" });

    await share.recorder([refusal(1)]);
    await share.recorder([refusal(2), refusal(3)]);

    expect(
      share.effects,
      "MUTATION: batching the pages loses the ones a failed pull already committed past",
    ).toEqual(["persist", "persist"]);
    expect(
      share.stored()?.skippedOps?.ops.map((op) => op.originSeq),
    ).toEqual([1, 2, 3]);
    expect(share.stored()?.skippedOps?.generation).toBe(2);
  });

  // The fan-out this shape exists to prevent: every renderer broadcast starts
  // file scans, history reads and relay listings, and a relay refusing on
  // every page of a long backlog would start one set per page. The recorder
  // is handed a reader and a writer and nothing else, so a page CANNOT
  // broadcast — the pull sites notify once when they settle.
  it("has no effect on a page beyond persisting it", async () => {
    const share = target({ shareId: "share-1" });

    for (let page = 0; page < 25; page += 1) {
      await share.recorder([refusal(page)]);
    }

    expect(
      new Set(share.effects),
      "MUTATION: a recorder that also notified would fan one pull into one broadcast per page",
    ).toEqual(new Set(["persist"]));
    expect(share.effects).toHaveLength(25);
  });

  it("writes nothing for a page with no refusals", async () => {
    const share = target({ shareId: "share-1" });
    await share.recorder([]);
    expect(share.effects).toEqual([]);
  });

  // A share revoked mid-pull has no record to write to. The recorder reads
  // per call for exactly this reason.
  it("writes nothing once the record is gone", async () => {
    const share = target({ shareId: "share-1" });
    await share.recorder([refusal(1)]);
    share.drop();
    await share.recorder([refusal(2)]);
    expect(share.effects).toEqual(["persist"]);
  });
});
