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
// With no session there is nothing that can finish, block, or ask; poll
// slowly until one appears instead of waking every window at full cadence.
const IDLE_POLL_INTERVAL_MS = 10_000;

export type AgentPermissionRequest = NonNullable<
  AgentPanelSnapshotResult["session"]
>["pendingPermissions"][number];

export interface UseAgentNotifications {
  notifications: AgentNotification[];
  // The active session's unanswered permission requests (current workspace).
  pendingPermissions: AgentPermissionRequest[];
  // The run those asks belong to — the card scopes its optimistic-hide keys
  // by run, so a LATER session reusing a provider request id can ask again.
  pendingPermissionsRunId: string | null;
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
  // Asks are stored WITH their workspace and filtered synchronously at
  // render (the same isolation rule as notifications below): the render
  // right after a switch must never hand workspace A's request ids to a
  // card that would answer them against workspace B.
  const [pendingAsks, setPendingAsks] = useState<{
    workspaceId: string;
    runId: string | null;
    requests: AgentPermissionRequest[];
  }>({ workspaceId, runId: null, requests: [] });
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
    let timer: number | undefined;

    // Idle backoff: no session means no asks and nothing to notify about, so
    // the next look can wait. The poll that first sees a session — and every
    // poll while one exists — schedules at the fast cadence again.
    const idleIntervalMs = Math.max(pollIntervalMs, IDLE_POLL_INTERVAL_MS);
    const poll = async () => {
      // Fast cadence unless this poll proves there is no session; a transient
      // IPC failure (no panel) also retries fast.
      let nextDelayMs = pollIntervalMs;
      let panel: AgentPanelSnapshotResult | undefined;
      try {
        panel = await bridge().getAgentSessionState({ workspaceId });
      } catch {
        // transient IPC failure — retry at the fast cadence
      }
      if (cancelled) return;
      if (panel) {
        if (panel.session === null) nextDelayMs = idleIntervalMs;
        const runId = panel.session?.runId ?? null;
        const requests = panel.session?.pendingPermissions ?? [];
        // Reference-stable no-op (same rule as reduceAgentNotifications): a poll
        // that changes nothing MUST keep `prev` so setState bails out instead of
        // re-rendering the host shell every tick. requestId is the request's
        // identity — a new ask always gets a fresh one.
        setPendingAsks((prev) =>
          prev.workspaceId === workspaceId &&
          prev.runId === runId &&
          prev.requests.length === requests.length &&
          prev.requests.every((req, i) => req.requestId === requests[i]!.requestId)
            ? prev
            : { workspaceId, runId, requests },
        );
        const activity = deriveAgentActivity({
          workspaceId,
          workspaceName: metaRef.current.workspaceName,
          agentName: metaRef.current.agentName,
          session: panel.session,
          userCandidates: candidatesRef.current,
        });
        if (activity) {
          setNotifications((prev) =>
            reduceAgentNotifications(prev, activity, {
              nowMs: Date.now(),
              dismissed: dismissedFor(workspaceId),
            }),
          );
        }
      }
      timer = window.setTimeout(() => void poll(), nextDelayMs);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
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
  const pendingPermissions = useMemo(
    () => (pendingAsks.workspaceId === workspaceId ? pendingAsks.requests : []),
    [pendingAsks, workspaceId],
  );

  return {
    notifications: currentWorkspaceNotifications,
    pendingPermissions,
    pendingPermissionsRunId:
      pendingAsks.workspaceId === workspaceId ? pendingAsks.runId : null,
    dismiss,
  };
}
