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
import { mentionsAnyCandidate, type MentionCandidate } from "./mentions";

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
  // Stable id of the permission the run is blocked on. Discriminates the
  // needs-input notice per WAIT so a dismissed permission-A does not suppress a
  // later permission-B on the SAME run (each wait can re-raise once).
  pendingPermissionId?: string;
  // First line of the agent's latest message, used for specific "finished" /
  // "asked" copy ("Your agent finished reorganizing /notes").
  latestSummary?: string;
  // The agent's latest message reads as directed at the user (an @mention or a
  // trailing question). Promotes a completion from "finished" to "asked".
  addressedToUser?: boolean;
}

// The minimal slice of an agent-session snapshot the notification model needs.
// Kept structural so both the live bridge snapshot and tests can supply it.
export interface AgentSessionLike {
  status: AgentSessionStatus;
  runId?: string;
  lastError?: string;
  messages: ReadonlyArray<{ role: "assistant" | "reasoning"; text: string }>;
  pendingPermissions: ReadonlyArray<{ title: string; requestId?: string }>;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((entry) => entry.trim().length > 0) ?? "";
  return line.trim();
}

// Turns a polled session snapshot into the flat activity input, deciding
// whether the agent's latest message reads as directed at the user (an
// @mention of the user, or a trailing question). Returns null when there is no
// session to describe.
export function deriveAgentActivity(params: {
  workspaceId: string;
  workspaceName: string;
  agentName: string;
  session: AgentSessionLike | null;
  userCandidates: readonly MentionCandidate[];
}): AgentActivityInput | null {
  const { session } = params;
  if (!session) return null;
  const latestAssistant = [...session.messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.text.trim().length > 0);
  const latestText = latestAssistant?.text ?? "";
  const latestSummary = firstLine(latestText);
  const addressedToUser =
    latestText.trim().length > 0 &&
    (mentionsAnyCandidate(latestText, params.userCandidates, { ignoreCode: true }) ||
      /\?\s*$/.test(latestText.trim()));
  return {
    workspaceId: params.workspaceId,
    workspaceName: params.workspaceName,
    agentName: params.agentName,
    runId: session.runId ?? null,
    status: session.status,
    ...(session.lastError ? { lastError: session.lastError } : {}),
    ...(session.pendingPermissions[0]?.title
      ? { pendingPermissionTitle: session.pendingPermissions[0].title }
      : {}),
    ...(session.pendingPermissions[0]?.requestId
      ? { pendingPermissionId: session.pendingPermissions[0].requestId }
      : {}),
    ...(latestSummary ? { latestSummary } : {}),
    addressedToUser,
  };
}

export function agentNotificationId(
  workspaceId: string,
  runId: string,
  kind: AgentNotificationKind,
  discriminator?: string,
): string {
  const base = `${workspaceId}::${runId}::${kind}`;
  return discriminator ? `${base}::${discriminator}` : base;
}

// The dismissal/coalescing key for a desired notice. needs-input is
// discriminated by the pending permission id so a NEW wait on the same run
// gets a fresh id (and can re-raise after an earlier wait was dismissed).
function notificationIdFor(
  input: AgentActivityInput,
  kind: AgentNotificationKind,
  runId: string,
): string {
  const discriminator = kind === "needs-input" ? input.pendingPermissionId : undefined;
  return agentNotificationId(input.workspaceId, runId, kind, discriminator);
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
    id: notificationIdFor(input, kind, runId),
    kind,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    agentName: input.agentName,
    runId,
    title,
    body,
    createdAtMs: nowMs,
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
  // Reference-stable no-op: a poll that changes nothing MUST return the same
  // array so useAgentNotifications' setState bails out and React skips the
  // re-render. The hook polls every ~1.5s for the app's life; allocating a
  // fresh array each idle tick would re-render the whole notifications subtree
  // forever. So every return below reuses `prev` when the content is unchanged.
  if (!runId) return prev as AgentNotification[];
  const kind = desiredKind(input);
  const desiredId = kind !== null ? notificationIdFor(input, kind, runId) : null;
  // Would the filter actually drop anything for THIS run? (a superseded kind,
  // an earlier needs-input for a different permission, or a resume clearing a
  // notice). If not, keep `prev` itself rather than a fresh, equal copy.
  const needsFilter = prev.some((notice) => {
    if (notice.workspaceId !== input.workspaceId || notice.runId !== runId) return false;
    return desiredId === null || notice.id !== desiredId;
  });
  const kept: AgentNotification[] = needsFilter
    ? prev.filter((notice) => {
        if (notice.workspaceId !== input.workspaceId || notice.runId !== runId) return true;
        // For THIS run, keep only the exact desired notice; any other kind — or
        // an earlier needs-input for a DIFFERENT permission — is superseded.
        return desiredId !== null && notice.id === desiredId;
      })
    : (prev as AgentNotification[]);
  if (desiredId === null) return kept;
  if (opts.dismissed?.has(desiredId)) return kept;
  if (kept.some((notice) => notice.id === desiredId)) return kept;
  return [...kept, build(input, kind!, runId, opts.nowMs)];
}

export function dismissAgentNotification(
  list: readonly AgentNotification[],
  id: string,
): AgentNotification[] {
  return list.filter((notice) => notice.id !== id);
}

// Auto-clear seam: remove every notice for a workspace (used when the user
// opens the Agent panel — they are now looking at the run). This is the ONLY
// auto-clear: a run's notices point at the workspace's agent session, not at a
// specific chat thread. The agent session model does not (yet) carry the chat
// thread a mention-driven ask belongs to, so there is no reliable per-thread
// clear to offer — opening the notice lands on the run and clears the whole
// workspace. When the session snapshot starts carrying the originating chat
// thread, a thread-scoped clear can be reintroduced honestly.
export function clearAgentNotificationsForWorkspace(
  list: readonly AgentNotification[],
  workspaceId: string,
): AgentNotification[] {
  return list.filter((notice) => notice.workspaceId !== workspaceId);
}
