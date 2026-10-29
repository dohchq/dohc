import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "./capabilities";
import {
  UsageCount, UsageBuildPair, UsageInvocation, UsageQuery, UsageSnapshot,
  USAGE_ACTION_IDS, USAGE_MAX_COUNT, calendarDays, localUsageDay, queryUsage, decodeUsageSnapshot,
} from "./usage";
const pair = { capabilityId: "version.merge", door: "renderer" } as const;
const day = "2026-10-07";
const snapshot: UsageSnapshot = { version: 1, enabled: true, cleanExit: true,
  days: [{ day, appVersions: ["0.1.0"], complete: true }], counts: [],
  coverage: [{ appVersion: "0.1.0", pairs: [{ ...pair, status: "covered" }] }] };

describe("local usage contracts", () => {
  it("pins a unique explicit list of issued deliberate actions", () => {
    expect(new Set(USAGE_ACTION_IDS).size).toBe(USAGE_ACTION_IDS.length);
    for (const id of USAGE_ACTION_IDS) expect(Object.hasOwn(CAPABILITIES, id)).toBe(true);
    for (const id of ["version.list", "notice.list", "version.conflicts.list", "workspace.open.failures.take",
      "file.list", "file.read", "file.search", "workspace.list", "document.read"]) {
      expect(UsageInvocation.safeParse({ capabilityId: id, door: "renderer" }).success).toBe(false);
    }
  });
  it.each(["content", "arguments", "path", "identityId", "hash", "request", "result"])("rejects %s throughout the aggregate schema", field => {
    expect(UsageInvocation.safeParse({ ...pair, [field]: "private" }).success).toBe(false);
    expect(UsageCount.safeParse({ ...pair, day, count: 1, [field]: "private" }).success).toBe(false);
    expect(UsageBuildPair.safeParse({ ...pair, status: "covered", [field]: "private" }).success).toBe(false);
    expect(UsageSnapshot.safeParse({ ...snapshot, [field]: "private" }).success).toBe(false);
    expect(UsageSnapshot.safeParse({ ...snapshot, days: [{ ...snapshot.days[0], [field]: "private" }] }).success).toBe(false);
    expect(UsageSnapshot.safeParse({ ...snapshot, coverage: [{ ...snapshot.coverage[0], [field]: "private" }] }).success).toBe(false);
    expect(UsageQuery.safeParse({ from: day, through: day, pairs: [{ ...pair, [field]: "private" }] }).success).toBe(false);
  });
  it("rejects invalid aggregate values and duplicates", () => {
    for (const patch of [{ capabilityId: "invented.action" }, { door: "network" }, { day: "2026-02-30" },
      { count: 0 }, { count: -1 }, { count: 0.5 }, { count: Infinity }, { count: USAGE_MAX_COUNT + 1 }]) {
      expect(UsageCount.safeParse({ ...pair, day, count: 1, ...patch }).success).toBe(false);
    }
    const row = { ...pair, day, count: 1 };
    for (const patch of [{ version: 2 }, { counts: [row, row] }, { counts: [{ ...row, day: "2026-10-06" }] },
      { days: [snapshot.days[0], snapshot.days[0]] }, { coverage: [snapshot.coverage[0], snapshot.coverage[0]] },
      { coverage: [{ appVersion: "0.1.0", pairs: [{ capabilityId: "notice.list", door: "renderer", status: "covered" }] }] },
      { coverage: [{ appVersion: "0.1.0", pairs: [{ ...pair, status: "covered" }, { ...pair, status: "covered" }] }] }]) {
      expect(UsageSnapshot.safeParse({ ...snapshot, ...patch }).success).toBe(false);
    }
  });
  it("returns null for every usage count when coverage is missing, unavailable, or incomplete", () => {
    for (const input of [{ ...snapshot, coverage: [] }, { ...snapshot, days: [] },
      { ...snapshot, days: [{ ...snapshot.days[0]!, complete: false }] },
      { ...snapshot, coverage: [{ appVersion: "0.1.0", pairs: [{ ...pair, status: "unavailable" as const }] }] }]) {
      const result = queryUsage(input, { from: day, through: day, pairs: [pair] })[0]!;
      expect(result).toMatchObject({ total: null, usedDays: null });
      expect(result.daily[0]).toMatchObject({ count: null });
      expect(result).not.toHaveProperty("observedCount");
      expect(result).not.toHaveProperty("observedUsedDays");
      expect(result.daily[0]).not.toHaveProperty("observedCount");
    }
    expect(queryUsage(snapshot, { from: day, through: day, pairs: [pair] })[0])
      .toMatchObject({ total: 0, usedDays: 0, coveredDays: 1 });
  });
  it("requires every version used that day to cover the pair", () => {
    const upgraded = { ...snapshot, days: [{ ...snapshot.days[0]!, appVersions: ["0.1.0", "0.2.0"] }] };
    expect(queryUsage(upgraded, { from: day, through: day, pairs: [pair] })[0]!.total).toBeNull();
    upgraded.coverage = [...snapshot.coverage, { appVersion: "0.2.0", pairs: [{ ...pair, status: "covered" }] }];
    expect(queryUsage(upgraded, { from: day, through: day, pairs: [pair] })[0]!.total).toBe(0);
  });
  it("separates retired ids while preserving strict validation and known counts", () => {
    const retired = { capabilityId: "retired.action", door: "renderer" as const };
    const input = { ...snapshot, counts: [{ ...pair, day, count: 3 }, { ...retired, day, count: 5 }],
      coverage: [{ appVersion: "0.1.0", pairs: [{ ...pair, status: "covered" }, { ...retired, status: "covered" }] }] };
    const decoded = decodeUsageSnapshot(input);
    expect(decoded.snapshot.counts).toEqual([{ ...pair, day, count: 3 }]);
    expect(decoded.snapshot.coverage[0]!.pairs).toEqual([{ ...pair, status: "covered" }]);
    expect(decoded.dropped).toEqual({ counts: [{ ...retired, day, count: 5 }],
      coverage: [{ appVersion: "0.1.0", pairs: [{ ...retired, status: "covered" }] }] });
    expect(() => decodeUsageSnapshot({ ...input, counts: [{ ...retired, day, count: 1, content: "private" }] })).toThrow();
    const { cleanExit: _marker, ...missingMarker } = snapshot;
    const withoutUnknown = decodeUsageSnapshot(missingMarker);
    expect(withoutUnknown.snapshot.cleanExit).toBe(false);
    expect(withoutUnknown.dropped).toEqual({ counts: [], coverage: [] });
  });
  it("uses local calendar dates and bounds query ranges", () => {
    expect(localUsageDay(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
    expect(calendarDays("2025-12-31", "2026-01-02")).toEqual(["2025-12-31", "2026-01-01", "2026-01-02"]);
    expect(UsageQuery.safeParse({ from: "2026-01-01", through: "2026-05-01", pairs: [pair] }).success).toBe(false);
    expect(UsageQuery.safeParse({ from: day, through: "2026-10-06", pairs: [pair] }).success).toBe(false);
  });
});
