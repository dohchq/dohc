import type { ChatReportedAgentRecord } from "../../ipc/bridgeContract";

// What an agent's client reported about itself, marked as reported because
// dohc cannot check it and never fills it in.
export const AS_REPORTED = "(as reported)";

// The product and its version as the client named them: `Claude Code 2.1`.
export function reportedProduct(reported: ChatReportedAgentRecord | undefined): string | undefined {
  if (!reported?.product) return undefined;
  return reported.version ? `${reported.product} ${reported.version}` : reported.product;
}

// One line for a tooltip: `Claude Code 2.1 · Claude Opus 5.5 (as reported)`.
export function reportedAgentLine(reported: ChatReportedAgentRecord | undefined): string | undefined {
  const parts = [reportedProduct(reported), reported?.model].filter((part) => part !== undefined);
  return parts.length > 0 ? `${parts.join(" · ")} ${AS_REPORTED}` : undefined;
}
