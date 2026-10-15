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

// The words for a state. Dispatch's own notice names the two causes a send
// does not start a run. An unknown state says nothing about running.
const WORDS: Record<AgentOfferState, string | null> = {
  runs: "runs when you send",
  working: "runs after the current run",
  paused: "dispatch paused · runs after Resume",
  "runner-off": "Agent dispatch is off",
  "no-command": "No agent runner is configured",
  unknown: null,
};

/** The folder name of the workspace the runner starts in. */
export function reachName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

/** A conversation that does not exist yet: no run and no pause. */
export const NEW_CONVERSATION: ChatDispatchStateForThreadResult = { liveRunId: null, pendingCount: 0, paused: false };

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
  const offer = useMemo(() => detectAgentAddressed(workspaceId, agent, {
    workspaceId: setup ? setup.workspaceId : workspaceId,
    agentId: "agent:default",
    presentation: ownAgentPresentation,
    runner: setup ? { command: setup.runnerConfigured, enabled: setup.runnerEnabled } : null,
    runActive: setup ? setup.agentRunActive : null,
    paused: dispatch ? dispatch.paused : null,
    liveRun: dispatch ? dispatch.liveRunId !== null : null,
    reach: reach ?? null,
  }), [agent, dispatch, reach, setup, workspaceId]);
  return { offer, onRosterPick, scope };
}

// Shown after the person picks an agent from the roster: who will see the
// message, whether sending starts a run, and the folder the run reaches. A
// post composer draws it in the space before Send; a stream composer floats
// it above its top edge, over Send, so nothing moves.
export const AgentOffer = memo(function AgentOffer(props: {
  offer: AgentAddressedOffer;
  surface: "post" | "stream";
  onSetUp?: () => void;
}) {
  const { offer } = props;
  const words = WORDS[offer.state];
  const blocked = offer.state === "runner-off" || offer.state === "no-command";
  const narrowHidden = props.surface === "post" ? "@max-[14rem]:hidden" : "";
  return (
    <div
      role="status"
      data-testid="composer-agent-offer"
      data-state={offer.state}
      className={`dohc-pop-in flex min-w-0 items-center gap-1.5 text-[11px] text-muted ${
        props.surface === "post"
          ? "@container flex-1 px-1.5"
          : "absolute bottom-full right-2 z-10 mb-1.5 max-w-[calc(100%-1rem)] rounded-full border border-line bg-panel py-0.5 pl-0.5 pr-2 shadow-sm"
      }`}
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
      {blocked && props.onSetUp ? (
        <button
          type="button"
          data-testid="composer-agent-offer-setup"
          aria-label="Set up agent dispatch in Settings → Agents"
          title="Settings → Agents"
          onClick={props.onSetUp}
          className="h-5 shrink-0 cursor-pointer rounded border border-line px-1.5 text-[10px] text-muted hover:bg-hover hover:text-ink dohc-focus-visible"
        >
          Set up
        </button>
      ) : null}
      {!blocked && offer.reach ? (
        // The words come first: the folder name gives way before them, down
        // to its icon, and a narrow post drops it.
        <>
          {words ? <span aria-hidden className={`shrink-0 text-subtle ${narrowHidden}`}>·</span> : null}
          <span
            data-testid="composer-agent-offer-reach"
            title={`reaches ${offer.reach}`}
            className={`inline-flex h-[18px] min-w-7 shrink-[4] items-center gap-1 rounded border border-line bg-panel-2 px-1.5 font-mono text-[11px] text-muted ${narrowHidden}`}
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
