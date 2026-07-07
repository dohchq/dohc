// Agent -> user notifications (Agent Notifications & Mentions). A background
// agent run that FINISHES, NEEDS INPUT, ASKS the user, or ERRORS should reach
// the user through the NoticeCenter even when they are looking at something
// else. This module is the PURE model behind that surface: it turns a stream
// of agent-session snapshots into a calm, coalesced notification list.
//
// Anti-noise is the whole point:
//   • one notice per state transition (not per streamed token/message),
//   • a run that resumes auto-clears its "needs input" notice,
//   • a notice the user has seen/dismissed never re-raises for the same state.
//
// The reducer is fed by useAgentNotifications, which polls the agent session
// for the active workspace so a run finishing off-screen still surfaces.

import type { AgentSessionStatus } from "../../agents/AgentSessionManager";

export type AgentNotificationKind = "finished" | "needs-input" | "asked" | "error";

export interface AgentNotification {
  // Stable per (workspace, run, kind): the coalescing + dismissal key.
  id: string;
  kind: AgentNotificationKind;
  workspaceId: string;
  workspaceName: string;
  // "<User Name>'s agent" — the same label the chat surfaces use.
  agentName: string;
  runId: string;
  title: string;
  body: string;
  createdAtMs: number;
  // Present when the notice points at a specific chat thread (an agent ask
  // authored into a thread). Opening it auto-clears the notice.
  threadId?: string;
}

// One poll's worth of truth about a workspace's agent session. Derived in the
// hook from the AgentPanelSnapshot; kept flat so the reducer stays pure and
// trivially testable.
export interface AgentActivityInput {
  workspaceId: string;
  workspaceName: string;
  agentName: string;
  // null while a session is starting and has no run yet — no run, no notice.
  runId: string | null;
  status: AgentSessionStatus;
  lastError?: string;
  // Title of the permission the run is blocked on (drives "needs input" copy).
  pendingPermissionTitle?: string;
  // First line of the agent's latest message, used for specific "finished" /
  // "asked" copy ("Your agent finished reorganizing /notes").
  latestSummary?: string;
  // The agent's latest message reads as directed at the user (an @mention or a
  // trailing question). Promotes a completion from "finished" to "asked".
  addressedToUser?: boolean;
  // A chat thread the ask is tied to, if any.
  threadId?: string;
}

export function agentNotificationId(
  workspaceId: string,
  runId: string,
  kind: AgentNotificationKind,
): string {
  return `${workspaceId}::${runId}::${kind}`;
}

// error > needs-input > asked > finished. Only terminal / blocked states raise
// a notice; running/ready/idle raise nothing (and auto-clear a prior one).
function desiredKind(input: AgentActivityInput): AgentNotificationKind | null {
  switch (input.status) {
    case "failed":
      return "error";
    case "waiting-permission":
      return "needs-input";
    case "completed":
      return input.addressedToUser ? "asked" : "finished";
    default:
      return null;
  }
}

function truncate(text: string, max = 140): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function copyFor(
  input: AgentActivityInput,
  kind: AgentNotificationKind,
): { title: string; body: string } {
  const where = input.workspaceName;
  const summary = input.latestSummary ? truncate(input.latestSummary) : "";
  switch (kind) {
    case "finished":
      return {
        title: "Your agent finished",
        body: summary || `Your agent wrapped up its work in ${where}.`,
      };
    case "needs-input":
      return {
        title: "Your agent needs you",
        body: input.pendingPermissionTitle
          ? `Waiting for your go-ahead: ${truncate(input.pendingPermissionTitle, 100)}`
          : `Your agent is waiting for your go-ahead in ${where}.`,
      };
    case "asked":
      return {
        title: "Your agent has a question",
        body: summary || `Your agent asked you something in ${where}.`,
      };
    case "error":
      return {
        title: "Your agent hit a problem",
        body: input.lastError
          ? truncate(input.lastError)
          : `Your agent couldn't finish its work in ${where}.`,
      };
  }
}

function build(
  input: AgentActivityInput,
  kind: AgentNotificationKind,
  runId: string,
  nowMs: number,
): AgentNotification {
  const { title, body } = copyFor(input, kind);
  return {
    id: agentNotificationId(input.workspaceId, runId, kind),
    kind,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    agentName: input.agentName,
    runId,
    title,
    body,
    createdAtMs: nowMs,
    ...(input.threadId ? { threadId: input.threadId } : {}),
  };
}

export interface ReduceOptions {
  nowMs: number;
  // State keys the user has already seen/dismissed; a matching desired notice
  // is not re-raised. Keyed exactly like AgentNotification.id.
  dismissed?: ReadonlySet<string>;
}

// Folds one activity snapshot into the running notification list.
//   • Notices for OTHER runs/workspaces are preserved untouched (a run that
//     finished off-screen keeps its notice while a new run starts).
//   • For THIS run, a transition to a new kind supersedes the old kind's
//     notice; a resume (desired = null) clears it.
//   • An already-present desired notice is left as-is (stable id + timestamp)
//     so repeated polls of the same state never re-stamp or duplicate it.
export function reduceAgentNotifications(
  prev: readonly AgentNotification[],
  input: AgentActivityInput,
  opts: ReduceOptions,
): AgentNotification[] {
  const runId = input.runId;
  if (!runId) return [...prev];
  const kind = desiredKind(input);
  const kept = prev.filter((notice) => {
    if (notice.workspaceId !== input.workspaceId || notice.runId !== runId) return true;
    return kind !== null && notice.kind === kind;
  });
  if (kind === null) return kept;
  const id = agentNotificationId(input.workspaceId, runId, kind);
  if (opts.dismissed?.has(id)) return kept;
  if (kept.some((notice) => notice.id === id)) return kept;
  return [...kept, build(input, kind, runId, opts.nowMs)];
}

export function dismissAgentNotification(
  list: readonly AgentNotification[],
  id: string,
): AgentNotification[] {
  return list.filter((notice) => notice.id !== id);
}

// Auto-clear seam: remove every notice for a workspace (used when the user
// opens the Agent panel — they are now looking at the run).
export function clearAgentNotificationsForWorkspace(
  list: readonly AgentNotification[],
  workspaceId: string,
): AgentNotification[] {
  return list.filter((notice) => notice.workspaceId !== workspaceId);
}

// Auto-clear seam: remove every notice tied to a chat thread (used when the
// user opens that thread — an ask is answered by reading it).
export function clearAgentNotificationsForThread(
  list: readonly AgentNotification[],
  threadId: string,
): AgentNotification[] {
  return list.filter((notice) => notice.threadId !== threadId);
}
