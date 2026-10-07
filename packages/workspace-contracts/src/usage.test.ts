import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "./capabilities";
import {
  UsageCount, UsageCoverageInput, UsageInvocation, UsageQuery, UsageSnapshot,
  USAGE_ACTION_IDS, USAGE_MAX_COUNT, calendarDays, localUsageDay, queryUsage,
} from "./usage";

const pair = { capabilityId: "version.try", door: "renderer" } as const;
const day = "2026-10-07";
const snapshot: UsageSnapshot = { version: 1, enabled: true,
  days: [{ day, appVersions: ["0.1.0"], collection: "on" }], counts: [], coverage: [] };

describe("local usage contracts", () => {
  it("counts only an explicit, unique list of issued deliberate action ids", () => {
    expect(new Set(USAGE_ACTION_IDS).size).toBe(USAGE_ACTION_IDS.length);
    for (const id of USAGE_ACTION_IDS) expect(Object.hasOwn(CAPABILITIES, id)).toBe(true);
    for (const id of ["version.list", "notice.list", "version.try.read", "workspace.open.failures.take",
      "file.list", "file.read", "file.search", "workspace.list", "document.read"]) {
      expect(UsageInvocation.safeParse({ capabilityId: id, door: "renderer" }).success).toBe(false);
    }
    expect(USAGE_ACTION_IDS).toContain("workspace.open.retry");
  });

  it.each(["content", "arguments", "path", "identityId", "hash", "request", "result"])("rejects %s in every aggregate input", field => {
    expect(UsageInvocation.safeParse({ ...pair, [field]: "private" }).success).toBe(false);
    expect(UsageCount.safeParse({ ...pair, day, count: 1, [field]: "private" }).success).toBe(false);
    expect(UsageCoverageInput.safeParse({ ...pair, status: "covered", [field]: "private" }).success).toBe(false);
    expect(UsageSnapshot.safeParse({ ...snapshot, [field]: "private" }).success).toBe(false);
    expect(UsageSnapshot.safeParse({ ...snapshot, days: [{ ...snapshot.days[0], [field]: "private" }] }).success).toBe(false);
    expect(UsageSnapshot.safeParse({ ...snapshot, coverage: [{ ...pair, day, status: "covered", [field]: "private" }] }).success).toBe(false);
    expect(UsageQuery.safeParse({ from: day, through: day, pairs: [{ ...pair, [field]: "private" }] }).success).toBe(false);
  });

  it("rejects unknown ids, doors, invalid days, nonpositive and unbounded counts", () => {
    for (const patch of [{ capabilityId: "invented.action" }, { door: "network" }, { day: "2026-02-30" },
      { count: 0 }, { count: -1 }, { count: 0.5 }, { count: Infinity }, { count: USAGE_MAX_COUNT + 1 }]) {
      expect(UsageCount.safeParse({ ...pair, day, count: 1, ...patch }).success).toBe(false);
    }
    expect(UsageSnapshot.safeParse({ ...snapshot, version: 2 }).success).toBe(false);
    expect(UsageSnapshot.safeParse({ ...snapshot, days: [{ ...snapshot.days[0], appVersions: ["a file path"] }] }).success).toBe(false);
  });

  it("rejects duplicate aggregates, unrecorded days, and covered Off days", () => {
    const row = { ...pair, day, count: 1 };
    expect(UsageSnapshot.safeParse({ ...snapshot, counts: [row, row] }).success).toBe(false);
    expect(UsageSnapshot.safeParse({ ...snapshot, counts: [{ ...row, day: "2026-10-06" }] }).success).toBe(false);
    expect(UsageSnapshot.safeParse({ ...snapshot, days: [snapshot.days[0]!, snapshot.days[0]!] }).success).toBe(false);
    expect(UsageSnapshot.safeParse({ ...snapshot, coverage: [{ capabilityId: "notice.list", door: "renderer", day, status: "covered" }] }).success).toBe(false);
    const coverage = { ...pair, day, status: "covered" } as const;
    expect(UsageSnapshot.safeParse({ ...snapshot, coverage: [coverage, coverage] }).success).toBe(false);
    expect(UsageSnapshot.safeParse({ ...snapshot, days: [{ ...snapshot.days[0], collection: "off" }], coverage: [coverage] }).success).toBe(false);
  });

  it("never reports missing, Off, incomplete, or unavailable coverage as zero", () => {
    for (const status of [undefined, "uncovered", "incomplete", "off", "unavailable"] as const) {
      const result = queryUsage({ ...snapshot, coverage: status ? [{ ...pair, day, status }] : [] },
        { from: day, through: day, pairs: [pair] })[0]!;
      expect(result.total).toBeNull();
      expect(result.usedDays).toBeNull();
      expect(result.daily[0]!.count).toBeNull();
    }
    expect(queryUsage({ ...snapshot, coverage: [{ ...pair, day, status: "covered" }] },
      { from: day, through: day, pairs: [pair] })[0]).toMatchObject({ total: 0, usedDays: 0, coveredDays: 1 });
  });

  it("reports retained observations separately when a range has a gap", () => {
    const result = queryUsage({ ...snapshot, counts: [{ ...pair, day, count: 3 }],
      coverage: [{ ...pair, day, status: "covered" }] },
    { from: "2026-10-06", through: day, pairs: [pair] })[0]!;
    expect(result).toMatchObject({ total: null, usedDays: null, observedCount: 3, observedUsedDays: 1, coveredDays: 1 });
  });

  it("uses local calendar days across year boundaries and rejects overlong queries", () => {
    expect(localUsageDay(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
    expect(calendarDays("2025-12-31", "2026-01-02")).toEqual(["2025-12-31", "2026-01-01", "2026-01-02"]);
    expect(UsageQuery.safeParse({ from: "2026-01-01", through: "2026-05-01", pairs: [pair] }).success).toBe(false);
    expect(UsageQuery.safeParse({ from: day, through: "2026-10-06", pairs: [pair] }).success).toBe(false);
  });
});
