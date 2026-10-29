import type { CapabilityId } from "@dohc/workspace-contracts/capabilities";

// A local review of one person's use, after 30 covered days. Frequency alone
// cannot establish intent, other people's needs, or the necessity of recovery.
export const USAGE_DECISION = {
  coveredDays: 30,
  population: "one-person",
  candidates: [
    { capabilityId: "chat.export", question: "removal", requiresNecessityJudgment: false },
    { capabilityId: "version.compare", question: "placement", requiresNecessityJudgment: false },
    { capabilityId: "file.kept.save", question: "placement", requiresNecessityJudgment: true },
  ] satisfies Array<{ capabilityId: CapabilityId; question: "removal" | "placement"; requiresNecessityJudgment: boolean }>,
} as const;
