import { useCallback, useEffect, useRef } from "react";
import type { MentionCandidate } from "./mentions";

// One @-mention that must reach the agent through the chat-reply path.
export interface AgentMentionInput {
  threadId: string;
  mentioned: MentionCandidate[];
  body: string;
}

// A mention that lands while the agent is mid-run can't start a second session
// (one run at a time). The honest choice is neither to drop it (silent loss)
// nor to flash a red error — it is to HOLD it and deliver it the moment the
// current run finishes. This hook owns that queue.
//
//   • enqueue() stashes a mention while the agent is busy.
//   • On each active -> idle transition it delivers the oldest queued mention.
//     Delivery starts a new run, so the next queued mention rides the following
//     transition (FIFO drain, oldest first).
//
// Kept as a tiny hook so the delivery contract is unit-testable without the
// whole shell (mirrors useAgentNotifications' pure-model + hook split).
export function usePendingAgentMention(params: {
  agentActive: boolean;
  deliver: (input: AgentMentionInput) => void;
}): { enqueue: (input: AgentMentionInput) => void; pendingCount: () => number } {
  const { agentActive } = params;
  const queueRef = useRef<AgentMentionInput[]>([]);
  // Latest deliver without retriggering the transition effect each render.
  const deliverRef = useRef(params.deliver);
  deliverRef.current = params.deliver;
  const prevActiveRef = useRef(agentActive);

  const enqueue = useCallback((input: AgentMentionInput) => {
    queueRef.current.push(input);
  }, []);

  const pendingCount = useCallback(() => queueRef.current.length, []);

  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = agentActive;
    // Deliver one held mention per active -> idle edge; delivering starts the
    // next run, which re-arms this effect for the following queued mention.
    if (wasActive && !agentActive && queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      if (next) deliverRef.current(next);
    }
  }, [agentActive]);

  return { enqueue, pendingCount };
}
