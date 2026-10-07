import { calendarDays, UsageSnapshot, type UsageCoverage, type UsageCount } from "@dohc/workspace-contracts/usage";
import { USAGE_DECISION } from "./usageDecision";

// Synthetic evidence for the local decision, never a record of someone's use.
export function usageDecisionFixture(): UsageSnapshot {
  const days = calendarDays("2026-09-08", "2026-10-07");
  const coverage: UsageCoverage[] = [];
  const counts: UsageCount[] = [];
  for (const [index, day] of days.entries()) {
    for (const { capabilityId } of USAGE_DECISION.candidates) {
      for (const door of ["renderer", "cli", "mcp"] as const) {
        const available = capabilityId === "file.kept.save"
          || capabilityId === "chat.export" && door === "cli"
          || capabilityId !== "chat.export" && door === "renderer";
        coverage.push({ day, capabilityId, door, status: available ? "covered" : "unavailable" });
      }
    }
    if (index % 6 === 0) counts.push({ day, capabilityId: "chat.export", door: "cli", count: 2 });
    if (index === 20) counts.push({ day, capabilityId: "version.compare", door: "renderer", count: 1 });
    if (index % 3 === 0) counts.push({ day, capabilityId: "file.kept.save", door: "mcp", count: 2 });
  }
  return UsageSnapshot.parse({ version: 1, enabled: true,
    days: days.map(day => ({ day, appVersions: ["0.1.0"], collection: "on" })), counts, coverage });
}
