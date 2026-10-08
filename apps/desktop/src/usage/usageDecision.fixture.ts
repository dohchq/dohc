import { calendarDays, UsageSnapshot, type UsageBuildPair, type UsageCount } from "@dohc/workspace-contracts/usage";
import { USAGE_DECISION } from "./usageDecision";
import { DESKTOP_USAGE_COVERAGE } from "./cliUsage";

// Synthetic evidence for the local decision, never a record of someone's use.
export function usageDecisionFixture(): UsageSnapshot {
  const days = calendarDays("2026-09-08", "2026-10-07");
  const pairs: UsageBuildPair[] = DESKTOP_USAGE_COVERAGE.filter(pair =>
    USAGE_DECISION.candidates.some(candidate => candidate.capabilityId === pair.capabilityId));
  const counts: UsageCount[] = [];
  for (const [index, day] of days.entries()) {
    if (index % 6 === 0) counts.push({ day, capabilityId: "chat.export", door: "cli", count: 2 });
    if (index % 3 === 0) counts.push({ day, capabilityId: "file.kept.save", door: "mcp", count: 2 });
  }
  return UsageSnapshot.parse({ version: 1, enabled: true, cleanExit: true,
    days: days.map(day => ({ day, appVersions: ["0.1.0"], complete: true })), counts,
    coverage: [{ appVersion: "0.1.0", pairs }] });
}
