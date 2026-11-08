import { Folder } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import type { ChatDispatchStateForThreadResult } from "../../ipc/bridgeContract";
import {
  detectAgentAddressed,
  type AgentAddressedOffer,
  type AgentOfferState,
  type AgentRosterPick,
} from "../offers/agentAddressed";
import { ownAgentPresentation } from "./actorPresentation";
import { ChatAvatar } from "./ChatAvatar";
import type { AgentSetupSummary } from "./ChatsView";

// The words for a state, and the offer's width below which the folder chip
// hides so the words are never cut. An unknown state says nothing about
// running.
const STATES: Record<AgentOfferState, { words: string | null; hideFolder?: string }> = {
  runs: { words: "Runs when you send", hideFolder: "@max-[15rem]:hidden" },
  working: { words: "Runs after the current run", hideFolder: "@max-[17rem]:hidden" },
  paused: { words: "Replies paused · runs after Resume", hideFolder: "@max-[21rem]:hidden" },
  unknown: { words: null },
};

/** The folder name of the workspace the runner starts in. */
export function reachName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

/** A conversation that does not exist yet: no run and no pause. */
export const NEW_CONVERSATION: ChatDispatchStateForThreadResult = { liveRunId: null, liveTriggerMessageId: null, pendingCount: 0, paused: false };

// The roster pick a composer reports, held beside that composer's draft, and
// the offer it makes with facts already read. A pick belongs to the
// conversation it was made in (`scope`), so it never shows in another one,
// even for the frame before the composer clears it. `dispatch` is that
// conversation's dispatch state, null where the composer has not read it.
export function useAgentOffer(input: {
  workspaceId: string;
  scope: string;
  setup: AgentSetupSummary | null | undefined;
  dispatch: ChatDispatchStateForThreadResult | null;
  reach: string | undefined;
}) {
  const { workspaceId, scope, setup, dispatch, reach } = input;
  const [pick, setPick] = useState<{ scope: string; agent: MentionCandidate } | null>(null);
  const onRosterPick = useCallback((next: AgentRosterPick | null) => setPick((current) => {
    if (!next) return current?.scope === scope ? null : current;
    return current?.scope === scope && current.agent === next.candidate ? current : { scope, agent: next.candidate };
  }), [scope]);
  const agent = pick?.scope === scope ? pick.agent : null;
  const offer = useMemo(() => {
    if (!agent) return null;
    return detectAgentAddressed(workspaceId, agent, {
      workspaceId: setup ? setup.workspaceId : workspaceId,
      agentId: agent.id,
      presentation: ownAgentPresentation,
      runActive: setup ? setup.agentRunActive : null,
      paused: dispatch ? dispatch.paused : null,
      liveRun: dispatch ? dispatch.liveRunId !== null : null,
      reach: reach ?? null,
    });
  }, [agent, dispatch, reach, setup, workspaceId]);
  return { offer, onRosterPick, scope };
}

// Shown after the person picks an agent from the roster: who will see the
// message, whether sending starts a run, and the folder the run reaches.
// Every composer draws it in its bar's space before Send, so nothing moves.
export const AgentOffer = memo(function AgentOffer(props: { offer: AgentAddressedOffer }) {
  const { offer } = props;
  const { words, hideFolder } = STATES[offer.state];
  return (
    <div
      role="status"
      data-testid="composer-agent-offer"
      data-state={offer.state}
      className="dohc-pop-in @container flex min-w-0 flex-1 items-center gap-1.5 px-1.5 text-[11px] tabular-nums text-muted"
    >
      <span className="relative inline-grid shrink-0">
        <ChatAvatar name={offer.agent.label} kind="agent" presentation={offer.presentation} size="strip" />
        {offer.working || offer.state === "runs" ? (
          <span
            aria-hidden
            data-testid="composer-agent-offer-run"
            className={`absolute -bottom-px -right-px size-1.5 rounded-full ring-2 ring-panel ${
              offer.working ? "bg-agent" : "border border-agent bg-panel"
            }`}
          />
        ) : null}
      </span>
      <span className="sr-only">{offer.agent.label}{offer.working ? ", agent working" : ""}</span>
      {words ? <span data-testid="composer-agent-offer-words" className="min-w-0 truncate" title={words}>{words}</span> : null}
      {offer.state === "unknown" && offer.reach ? (
        // Alone, the folder needs its verb.
        <span data-testid="composer-agent-offer-reach" className="min-w-0 truncate" title={`Reaches ${offer.reach}`}>
          Reaches {reachName(offer.reach)}
        </span>
      ) : null}
      {hideFolder && offer.reach ? (
        <>
          <span aria-hidden className={`shrink-0 text-subtle ${hideFolder}`}>·</span>
          <span
            data-testid="composer-agent-offer-reach"
            title={`Reaches ${offer.reach}`}
            className={`inline-flex h-[18px] min-w-0 shrink-[100] items-center gap-1 overflow-hidden rounded border border-line bg-panel-2 px-1.5 text-[11px] text-muted ${hideFolder}`}
          >
            <Folder size={10} strokeWidth={2} aria-hidden className="shrink-0" />
            <span className="sr-only">reaches </span>
            <span className="min-w-0 truncate">{reachName(offer.reach)}</span>
          </span>
        </>
      ) : null}
    </div>
  );
});
