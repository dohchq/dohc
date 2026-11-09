// An agent's card, in the words the DL ruled on Nov 7 from desktop #3408 at dbd07864a (AgentBadge.tsx, reportedAgent.ts).
// What a client reports about its agent, dohc can't check and never fills in, so it always carries "(as reported)".
export const AS_REPORTED = "(as reported)";

/** What the agent's client reported about itself. */
export interface ReportedAgent {
  readonly product?: string;
  readonly version?: string;
  readonly model?: string;
}

/** A connected agent wrote outside a run dohc started; your own agents run in dohc; a share's agent post could be either. */
export type AgentKind = "connected" | "own" | "unknown";

export interface AgentCardInput {
  /** The name shown. Ignored when the agent gave none. */
  readonly name: string;
  /** Whether the agent gave that name itself. */
  readonly named: boolean;
  readonly kind: AgentKind;
  /** Own agents only: the owner's display name, when it could be read. */
  readonly owner?: string;
  readonly reported?: ReportedAgent;
}

export interface AgentCard {
  /** Line 1. */
  readonly name: string;
  /** Line 1's muted "(as reported)": a plug card with no reported line, after a name the agent gave. */
  readonly nameAsReported: boolean;
  /** Line 2, absent for an agent of unknown kind. */
  readonly kindLine?: string;
  /** Line 3 without its mark, absent when the client reported nothing. The mark follows it and never breaks. */
  readonly reported?: string;
  /** What VoiceOver hears on the mark. */
  readonly markLabel: "connected agent" | "agent";
}

export const agentCardWords = {
  unnamed: "Agent",
  connected: "Connected agent",
  ownerUnavailable: "Owner name unavailable",
  ownedBy: (owner: string) => `Owned by ${owner}`,
} as const;

/** Line 3 without its mark: `Claude Code 2.1 · Claude Opus 5.5`; the product alone with no version; the model alone with
 * no product. */
export function reportedClaim(reported: ReportedAgent | undefined): string | undefined {
  const product = reported?.product ? (reported.version ? `${reported.product} ${reported.version}` : reported.product) : undefined;
  const parts = [product, reported?.model].filter((part): part is string => part !== undefined && part !== "");
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function agentCard(input: AgentCardInput): AgentCard {
  const reported = reportedClaim(input.reported);
  const plug = input.kind !== "own";
  return {
    name: input.named ? input.name : agentCardWords.unnamed,
    // "(as reported)" appears once per card: on the reported line when there is one, otherwise after a name the agent gave.
    nameAsReported: plug && reported === undefined && input.named,
    kindLine: input.kind === "unknown" ? undefined
      : input.kind === "connected" ? agentCardWords.connected
      : input.owner ? agentCardWords.ownedBy(input.owner) : agentCardWords.ownerUnavailable,
    reported,
    markLabel: input.kind === "connected" ? "connected agent" : "agent",
  };
}

/** The card as VoiceOver reads it, one line after another. */
export function agentCardLabel(card: AgentCard): string {
  return [
    card.nameAsReported ? `${card.name} ${AS_REPORTED}` : card.name,
    card.kindLine,
    card.reported === undefined ? undefined : `${card.reported} ${AS_REPORTED}`,
  ].filter((line): line is string => line !== undefined).join(", ");
}
