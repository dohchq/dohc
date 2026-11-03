import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import type { ActorPresentation } from "../../ipc/bridgeContract";
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
// Each fact is null until read. `workspaceId` is the workspace the agent
// facts were read for; `paused` and `liveRun` belong to the conversation the
// composer sends into, and a conversation that does not exist yet has neither.
export interface AddressedAgentFacts {
  workspaceId: string;
  agentId: string;
  presentation: ActorPresentation;
  // A run started outside chat holds the workspace's agent until it ends.
  runActive: boolean | null;
  paused: boolean | null;
  liveRun: boolean | null;
  // The workspace folder the runner starts in.
  reach: string | null;
}
// The roster lists only agents that can run. A paused conversation runs
// after Resume; a busy agent runs after its run.
export type AgentOfferState = "runs" | "working" | "paused" | "unknown";
export interface AgentAddressedOffer {
  kind: "agent-addressed";
  agent: MentionCandidate;
  presentation: ActorPresentation;
  state: AgentOfferState;
  working: boolean;
  reach: string | null;
}
function offerState(facts: AddressedAgentFacts, working: boolean | null): AgentOfferState {
  if (facts.paused === null || working === null) return "unknown";
  return facts.paused ? "paused" : working ? "working" : "runs";
}
// The input is a roster selection, never parsed composer text.
export function detectAgentAddressed(workspaceId: string, agent: MentionCandidate | null, facts: AddressedAgentFacts | null): AgentAddressedOffer | null {
  if (agent?.kind !== "agent" || !facts || facts.workspaceId !== workspaceId || facts.agentId !== agent.id) return null;
  const working = facts.runActive === true || facts.liveRun === true ? true
    : facts.runActive === null || facts.liveRun === null ? null : false;
  return { kind: "agent-addressed", agent, presentation: facts.presentation, state: offerState(facts, working),
    working: working === true, reach: facts.reach };
}
