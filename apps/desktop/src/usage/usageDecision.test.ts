import { expect, it } from "vitest";
import { queryUsage, USAGE_DOORS } from "@dohc/workspace-contracts/usage";
import { USAGE_DECISION } from "./usageDecision";
import { usageDecisionFixture } from "./usageDecision.fixture";

it("pins the approved local decision and protects recovery from cuts based on frequency", () => {
  expect(USAGE_DECISION).toMatchObject({ coveredDays: 30, population: "one-person" });
  expect(USAGE_DECISION.candidates).toEqual([
    { capabilityId: "version.try", question: "removal", requiresNecessityJudgment: false },
    { capabilityId: "chat.export", question: "removal", requiresNecessityJudgment: false },
    { capabilityId: "version.compare", question: "placement", requiresNecessityJudgment: false },
    { capabilityId: "file.kept.save", question: "placement", requiresNecessityJudgment: true },
  ]);
});

it("compares totals and distinct used days by door over 30 covered local days", () => {
  const rows = queryUsage(usageDecisionFixture(), { from: "2026-09-08", through: "2026-10-07",
    pairs: USAGE_DECISION.candidates.flatMap(candidate => USAGE_DOORS.map(door => ({ capabilityId: candidate.capabilityId, door }))) });
  expect(rows.find(row => row.capabilityId === "version.try" && row.door === "renderer"))
    .toMatchObject({ total: 0, usedDays: 0, coveredDays: 30 });
  expect(rows.find(row => row.capabilityId === "chat.export" && row.door === "cli"))
    .toMatchObject({ total: 10, usedDays: 5, coveredDays: 30 });
  expect(rows.find(row => row.capabilityId === "version.compare" && row.door === "renderer"))
    .toMatchObject({ total: null, usedDays: null, coveredDays: 0 });
  expect(rows.find(row => row.capabilityId === "file.kept.save" && row.door === "mcp"))
    .toMatchObject({ total: 20, usedDays: 10, coveredDays: 30 });
  expect(rows.filter(row => row.door === "automation").every(row => row.total === null && row.coveredDays === 0)).toBe(true);
  expect(rows.find(row => row.capabilityId === "chat.export" && row.door === "renderer"))
    .toMatchObject({ total: null, usedDays: null, coveredDays: 0 });
});

it("stops treating a zero as decision evidence when a day was Off or incomplete", () => {
  const snapshot = usageDecisionFixture();
  snapshot.days[0]!.complete = false;
  const result = queryUsage(snapshot, { from: "2026-09-08", through: "2026-10-07", pairs: [{ capabilityId: "version.try", door: "renderer" }] })[0]!;
  expect(result).toMatchObject({ total: null, usedDays: null, coveredDays: 29 });
});

it("counts comparisons only where someone deliberately asks for one", () => {
  const snapshot = usageDecisionFixture();
  expect(snapshot.counts.some(row => row.capabilityId === "version.compare")).toBe(false);
  const rows = queryUsage(snapshot, { from: "2026-09-08", through: "2026-10-07",
    pairs: USAGE_DOORS.map(door => ({ capabilityId: "version.compare", door })) });
  for (const row of rows) {
    expect(row).toMatchObject(row.door === "cli" || row.door === "mcp"
      ? { total: 0, usedDays: 0, coveredDays: 30 }
      : { total: null, usedDays: null, coveredDays: 0 });
  }
});

it("uses the build's real coverage and never presents an uncovered candidate as zero", () => {
  const snapshot = usageDecisionFixture();
  const rows = queryUsage(snapshot, { from: "2026-09-08", through: "2026-10-07",
    pairs: snapshot.coverage[0]!.pairs.filter(pair => pair.status !== "covered").map(({ capabilityId, door }) => ({ capabilityId, door })) });
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row).toMatchObject({ total: null, usedDays: null, coveredDays: 0 });
    expect(row.daily.every(day => day.count === null && day.status === "uncovered")).toBe(true);
  }
});
