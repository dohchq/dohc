import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentPanelSnapshotResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import {
  deriveAgentActivity,
  dismissAgentNotification,
  reduceAgentNotifications,
  type AgentNotification,
} from "./agentNotifications";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";

// Shell-level poller behind Agent -> user notifications. It watches the active
// workspace's agent session so a run that finishes / blocks / asks / fails
// surfaces in the NoticeCenter even while the user is editing something else
// (the whole point: a background run finishing while you're in a doc).
//
// The same poll also carries the session's pending permission requests — the
// asks a blocked run is waiting on. The shell renders those as
// AgentPermissionRequests cards; answering resumes the run.
//
// Scope note (individual-first, LOCAL): this watches the CURRENTLY OPEN
// workspace only. Cross-workspace background runs would need main to track
// every workspace's session; that's the seam the multi-user chat lanes will
// also want, so it's intentionally left as a single, obvious future addition.
const DEFAULT_POLL_INTERVAL_MS = 1_500;

export type AgentPermissionRequest = NonNullable<
  AgentPanelSnapshotResult["session"]
>["pendingPermissions"][number];

export interface UseAgentNotifications {
  notifications: AgentNotification[];
  // The active session's unanswered permission requests (current workspace).
  pendingPermissions: AgentPermissionRequest[];
  dismiss: (id: string) => void;
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
  const [pendingPermissions, setPendingPermissions] = useState<AgentPermissionRequest[]>([]);
  // Dismissed state keys, KEYED BY workspace. A flat set cleared on switch let
  // switching away/back re-raise a dismissed run; per-workspace sets that
  // persist across switches never do. Each notice carries its workspaceId, so
  // a dismissal always lands in the right bucket.
  const dismissedRef = useRef<Map<string, Set<string>>>(new Map());
  const dismissedFor = useCallback((ws: string): Set<string> => {
    let set = dismissedRef.current.get(ws);
    if (!set) {
      set = new Set();
      dismissedRef.current.set(ws, set);
    }
    return set;
  }, []);
  // Latest candidates without retriggering the poll effect on every render.
  const candidatesRef = useRef(userCandidates);
  candidatesRef.current = userCandidates;
  const metaRef = useRef({ workspaceName, agentName });
  metaRef.current = { workspaceName, agentName };

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Workspace switched: drop the previous workspace's asks synchronously so
    // a stale card can never invite an answer against the wrong workspace.
    setPendingPermissions([]);

    const poll = async () => {
      let panel: Awaited<ReturnType<ReturnType<typeof bridge>["getAgentSessionState"]>>;
      try {
        panel = await bridge().getAgentSessionState({ workspaceId });
      } catch {
        return; // transient IPC failure — try again next tick
      }
      if (cancelled) return;
      setPendingPermissions(panel.session?.pendingPermissions ?? []);
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
          dismissed: dismissedFor(workspaceId),
        }),
      );
    };

    void poll();
    const timer = window.setInterval(() => void poll(), pollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [dismissedFor, enabled, pollIntervalMs, workspaceId]);

  const dismiss = useCallback(
    (id: string) => {
      setNotifications((prev) => {
        const target = prev.find((notice) => notice.id === id);
        if (target) dismissedFor(target.workspaceId).add(id);
        return dismissAgentNotification(prev, id);
      });
    },
    [dismissedFor],
  );

  // Render only the CURRENT workspace's notices, computed synchronously. A
  // switch to workspace B therefore never repaints workspace A's notices, even
  // for the tick before the next poll runs (product invariant: a slow/stale
  // response for A must never repaint B).
  const currentWorkspaceNotifications = useMemo(
    () => notifications.filter((notice) => notice.workspaceId === workspaceId),
    [notifications, workspaceId],
  );

  return {
    notifications: currentWorkspaceNotifications,
    pendingPermissions,
    dismiss,
  };
}
