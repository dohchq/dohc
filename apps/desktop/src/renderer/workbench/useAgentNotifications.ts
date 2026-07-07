import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import {
  clearAgentNotificationsForThread,
  clearAgentNotificationsForWorkspace,
  deriveAgentActivity,
  dismissAgentNotification,
  reduceAgentNotifications,
  type AgentNotification,
} from "./agentNotifications";
import type { MentionCandidate } from "./mentions";

// Shell-level poller behind Agent -> user notifications. It watches the active
// workspace's agent session so a run that finishes / blocks / asks / fails
// surfaces in the NoticeCenter even when the Agent panel isn't the open view
// (the whole point: a background run finishing while you're editing a doc).
//
// Scope note (individual-first, LOCAL): this watches the CURRENTLY OPEN
// workspace only. Cross-workspace background runs would need main to track
// every workspace's session; that's the seam the multi-user chat lanes will
// also want, so it's intentionally left as a single, obvious future addition.
const DEFAULT_POLL_INTERVAL_MS = 1_500;

export interface UseAgentNotifications {
  notifications: AgentNotification[];
  dismiss: (id: string) => void;
  // The user is now looking at the run — clear this workspace's notices.
  clearForCurrentWorkspace: () => void;
  // The user opened a chat thread — clear notices tied to it.
  clearForThread: (threadId: string) => void;
}

export function useAgentNotifications(params: {
  workspaceId: string;
  workspaceName: string;
  agentName: string;
  userCandidates: readonly MentionCandidate[];
  enabled?: boolean;
  pollIntervalMs?: number;
}): UseAgentNotifications {
  const { workspaceId, workspaceName, agentName, userCandidates } = params;
  const enabled = params.enabled ?? true;
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const [notifications, setNotifications] = useState<AgentNotification[]>([]);
  // State keys the user has already seen/dismissed, so a still-true state
  // (e.g. a run that stays "completed" until replaced) never re-raises.
  const dismissedRef = useRef<Set<string>>(new Set());
  // Latest candidates without retriggering the poll effect on every render.
  const candidatesRef = useRef(userCandidates);
  candidatesRef.current = userCandidates;
  const metaRef = useRef({ workspaceName, agentName });
  metaRef.current = { workspaceName, agentName };

  // Workspace switch: reset to a clean slate (see scope note above).
  useEffect(() => {
    dismissedRef.current = new Set();
    setNotifications([]);
  }, [workspaceId]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const poll = async () => {
      let panel: Awaited<ReturnType<ReturnType<typeof bridge>["getAgentSessionState"]>>;
      try {
        panel = await bridge().getAgentSessionState({ workspaceId });
      } catch {
        return; // transient IPC failure — try again next tick
      }
      if (cancelled) return;
      const activity = deriveAgentActivity({
        workspaceId,
        workspaceName: metaRef.current.workspaceName,
        agentName: metaRef.current.agentName,
        session: panel.session,
        userCandidates: candidatesRef.current,
      });
      if (!activity) return;
      setNotifications((prev) =>
        reduceAgentNotifications(prev, activity, {
          nowMs: Date.now(),
          dismissed: dismissedRef.current,
        }),
      );
    };

    void poll();
    const timer = window.setInterval(() => void poll(), pollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, pollIntervalMs, workspaceId]);

  const dismiss = useCallback((id: string) => {
    dismissedRef.current.add(id);
    setNotifications((prev) => dismissAgentNotification(prev, id));
  }, []);

  const clearForCurrentWorkspace = useCallback(() => {
    setNotifications((prev) => {
      for (const notice of prev) {
        if (notice.workspaceId === workspaceId) dismissedRef.current.add(notice.id);
      }
      return clearAgentNotificationsForWorkspace(prev, workspaceId);
    });
  }, [workspaceId]);

  const clearForThread = useCallback((threadId: string) => {
    setNotifications((prev) => {
      for (const notice of prev) {
        if (notice.threadId === threadId) dismissedRef.current.add(notice.id);
      }
      return clearAgentNotificationsForThread(prev, threadId);
    });
  }, []);

  return { notifications, dismiss, clearForCurrentWorkspace, clearForThread };
}
