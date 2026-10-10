import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import type { AgentRunStatusResult, TryInVersionRunState } from "../../ipc/bridgeContract";
export interface AgentRosterPick { candidate: MentionCandidate; from: number; to: number }
export function agentRosterPickIsPresent(pick: AgentRosterPick, value: string): boolean {
  return value.slice(pick.from, pick.to) === "@" + pick.candidate.handle
    && (pick.from === 0 || /[\s(\[{]/u.test(value[pick.from - 1] ?? ""))
    && !/[\p{L}\p{N}\p{M}._-]/u.test(value[pick.to] ?? "");
}
// The composer supplies one edit range. No handle search runs while typing.
export function mapAgentRosterPick(pick: AgentRosterPick | null, edit: { from: number; to: number; insertedLength: number }): AgentRosterPick | null {
  if (!pick) return null;
  if (edit.to <= pick.from) {
    const delta = edit.insertedLength - (edit.to - edit.from);
    return { ...pick, from: pick.from + delta, to: pick.to + delta };
  }
  if (edit.from >= pick.to) return pick;
  return null;
}
export interface AddressedAgentFacts {
  agentId: string;
  reach: readonly string[] | null;
  runnerAvailable: boolean;
  runState: AgentRunStatusResult;
  versionRunState: TryInVersionRunState | null;
}
export interface AgentAddressedOffer extends AddressedAgentFacts {
  kind: "agent-addressed";
  agent: MentionCandidate;
  tryInVersion: { available: false; reason: "no-recoverable-discard" };
}
// The input is a roster selection, never parsed composer text.
export function detectAgentAddressed(pick: AgentRosterPick | null, facts: AddressedAgentFacts | null): AgentAddressedOffer | null {
  if (pick?.candidate.kind !== "agent" || !facts || facts.agentId !== pick.candidate.id) return null;
  return { kind: "agent-addressed", agent: pick.candidate, ...facts, tryInVersion: { available: false, reason: "no-recoverable-discard" } };
}
