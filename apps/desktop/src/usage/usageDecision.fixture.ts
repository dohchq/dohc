import { calendarDays, UsageSnapshot, type UsageBuildPair, type UsageCount } from "@dohc/workspace-contracts/usage";
import { USAGE_DECISION } from "./usageDecision";

// Synthetic evidence for the local decision, never a record of someone's use.
export function usageDecisionFixture(): UsageSnapshot {
  const days = calendarDays("2026-09-08", "2026-10-07");
  const pairs: UsageBuildPair[] = [];
  const counts: UsageCount[] = [];
  for (const { capabilityId } of USAGE_DECISION.candidates) {
    for (const door of ["renderer", "cli", "mcp"] as const) {
      // Comparison runs on mount and refresh; its placement is unanswered.
      if (capabilityId === "version.compare") {
        pairs.push({ capabilityId, door, status: "uncovered" });
        continue;
      }
      const available = capabilityId === "file.kept.save"
        || capabilityId === "chat.export" && door === "cli"
        || capabilityId === "version.try" && door === "renderer";
      pairs.push({ capabilityId, door, status: available ? "covered" : "unavailable" });
    }
  }
  for (const [index, day] of days.entries()) {
    if (index % 6 === 0) counts.push({ day, capabilityId: "chat.export", door: "cli", count: 2 });
    if (index % 3 === 0) counts.push({ day, capabilityId: "file.kept.save", door: "mcp", count: 2 });
  }
  return UsageSnapshot.parse({ version: 1, enabled: true, cleanExit: true,
    days: days.map(day => ({ day, appVersions: ["0.1.0"], complete: true })), counts,
    coverage: [{ appVersion: "0.1.0", pairs }] });
}
