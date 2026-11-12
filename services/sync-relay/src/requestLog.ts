import { createRequestLog } from "@dohc/service-http";
import { AUTOMATION_REPLICA_BEARER_PREFIX } from "./automationReplicaCredential";
import type { SyncRelayRoute } from "./relayRoute";
import { isServiceHostEnrollmentPath } from "./serviceHostEnrollmentRoutes";

// The pattern each parsed route logs as. Ids in a path are placeholders; a
// path's tail that can hold more than one id is `*`.
export const RELAY_ROUTE_PATTERNS = {
  "internal-work-reference": "/sync/internal/work-references",
  "share-work-references": "/sync/shares/:shareId/work-references",
  "work-reference": "/sync/work-references/:reference",
  "work-references": "/sync/:workspaceId/work-references",
  "link-app-publication": "/sync/link/app-publications/*",
  "link-app-collection": "/sync/link/app-publications/:publicationId/collection",
  "app-backend": "/sync/:scope/app-publications/:publicationId/backend/*",
  "link-exchange": "/sync/link-exchange",
  "link-refresh": "/sync/link-refresh",
  "link-handoff": "/sync/link-handoff",
  "link-redeem": "/sync/link-redeem",
  "agent-authorizations": "/sync/link/agent-authorizations/*",
  "agent-chat": "/sync/link/agent-chat/:action",
  "personal-agent-tools": "/sync/link/personal-agent/:action",
  "agent-clients": "/sync/link/agent-clients",
  "agent-token": "/sync/link/agent-token",
  "agent-introspect": "/sync/link/agent-introspect",
  "link-share": "/sync/link/share",
  "link-current": "/sync/link/current",
  "link-log": "/sync/link/log",
  "link-discussion": "/sync/link/discussion",
  "link-discussion-activity": "/sync/link/discussion/activity",
  "link-collection-writes": "/sync/link/collection-writes",
  "link-chat-channels": "/sync/link/chat/channels",
  "link-chat-messages": "/sync/link/chat/messages",
  "link-blob": "/sync/link/blobs/:sha256",
  workspaces: "/sync/workspaces",
  "workspace-name": "/sync/workspaces/:workspaceId/name",
  "personal-agents": "/sync/personal-agents",
  "personal-agent": "/sync/personal-agents/:agentId/:action",
  "account-sessions": "/sync/account/sessions",
  "account-session-revoke": "/sync/account/sessions/:sessionId/revoke",
  "account-workspaces": "/sync/account/workspaces",
  "account-workspace": "/sync/account/workspaces/:workspaceId",
  notices: "/sync/notices",
  "notice-marks": "/sync/notices/marks",
  "shares-list": "/sync/shares",
  "named-dataset": "/sync/shares/:shareId/datasets/*",
  share: "/sync/shares/:shareId",
  "share-access": "/sync/shares/:shareId/access",
  "share-undo": "/sync/shares/:shareId/undo",
  "share-revoke": "/sync/shares/:shareId/revoke",
  "share-link-rotate": "/sync/shares/:shareId/links/:grantId/rotate",
  "share-link-retune": "/sync/shares/:shareId/links/:grantId/retune",
  "share-grant-promote": "/sync/shares/:shareId/grants/:grantId/promote",
  "share-grant-revoke": "/sync/shares/:shareId/grants/:grantId/revoke",
  "share-log": "/sync/shares/:shareId/log",
  "share-discussion": "/sync/shares/:shareId/discussion",
  "share-discussion-activity": "/sync/shares/:shareId/discussion/activity",
  "share-discussion-moderation": "/sync/shares/:shareId/discussion/*",
  "share-presence": "/sync/shares/:shareId/presence",
  "share-blob": "/sync/shares/:shareId/blobs/:sha256",
  "share-proposals": "/sync/shares/:shareId/proposals",
  "share-proposal-withdraw": "/sync/shares/:shareId/proposals/:proposalId/withdraw",
  "share-collection-writes": "/sync/shares/:shareId/collection-writes",
  "share-automation-presses": "/sync/shares/:shareId/automation-presses",
  "account-operation": "/sync/:workspaceId/ops/:operation",
  dataset: "/sync/:workspaceId/datasets/*",
  "dataset-replica": "/sync/:workspaceId/datasets/:datasetId/replica/:action",
  "automation-presses": "/sync/:workspaceId/automation-presses/*",
  "automation-server": "/sync/:workspaceId/automation-server/:action",
  "automation-host": "/sync/:workspaceId/automation-host/*",
  "owner-collection-writes": "/sync/:workspaceId/collection-writes/:grantId",
  "owner-app-responses": "/sync/:workspaceId/app-responses/:grantId",
  "owner-app-publication": "/sync/:workspaceId/app-publications/*",
  "held-documents": "/sync/:workspaceId/held-documents/*",
  "owner-restore": "/sync/:workspaceId/live-restores/*",
  "blob-have": "/sync/:workspaceId/blobs/have",
  blob: "/sync/:workspaceId/blobs/:sha256",
  gc: "/sync/:workspaceId/maintenance/gc",
  log: "/sync/:workspaceId/log",
  "log-coordinate": "/sync/:workspaceId/log/:originId/:originSeq",
  bootstrap: "/sync/:workspaceId/bootstrap",
  epoch: "/sync/:workspaceId/epoch",
  presence: "/sync/:workspaceId/presence",
  keys: "/sync/:workspaceId/keys",
  "share-link-agents": "/sync/:workspaceId/shares/:shareId/links/:grantId/agents",
  "share-link-agent-disconnect": "/sync/:workspaceId/shares/:shareId/links/:grantId/agents/:connectionId/disconnect",
  "share-copy": "/sync/:workspaceId/shares/:shareId/grants/:grantId/copy",
  "shares-create": "/sync/:workspaceId/shares",
  "share-link-create-atomic": "/sync/:workspaceId/shares/links",
  "share-link-create": "/sync/:workspaceId/shares/:shareId/links",
  "workspace-proposals": "/sync/:workspaceId/proposals",
  "workspace-proposal": "/sync/:workspaceId/proposals/:proposalId",
  "workspace-proposal-op": "/sync/:workspaceId/proposals/:proposalId/ops/:opIndex",
  "workspace-proposal-settle": "/sync/:workspaceId/proposals/:proposalId/:decision",
} as const satisfies Record<SyncRelayRoute["route"], string>;

// Routes answered before or around the route parser: in main.ts and at the top of dispatch.
export const RELAY_ENTRY_PATTERNS = [
  "/internal/account-deletion",
  "/internal/sign-up-invite",
  "/ready",
  "/health",
  "/sync/:workspaceId/live-host",
  "/sync/:workspaceId/live-host/kept-edits",
  "/sync/live/personal-document",
  "/sync/live/named-tickets",
  "/sync/live/desktop-open",
  "/sync/live/desktop-ready",
  "/sync/live/link-tickets",
  "/sync/live/link-session",
  "/sync/live/link-document",
  "/sync/live/named-sessions",
  "/sync/live/named-sessions/resolve",
  "/sync/live/named-documents",
  "/sync/named-chat/*",
  "/sync/push/*",
  // Service-to-service replication, which a bearer kind selects.
  "replication",
] as const;

export const SYNC_RELAY_REQUEST_LOG = createRequestLog("sync-relay", [...Object.values(RELAY_ROUTE_PATTERNS), ...RELAY_ENTRY_PATTERNS]);

type RelayEntryPattern = (typeof RELAY_ENTRY_PATTERNS)[number];
// main.ts answers these four before relayHandler and marks them in their own branches.
const MARKED_IN_MAIN: ReadonlySet<string> = new Set(["/internal/account-deletion", "/internal/sign-up-invite", "/ready", "/health"]);
const LITERAL_ENTRIES: ReadonlySet<string> = new Set(RELAY_ENTRY_PATTERNS.filter(pattern =>
  pattern.startsWith("/") && !/[:*]/u.test(pattern) && !MARKED_IN_MAIN.has(pattern)));

/** The pattern of a route relayHandler answers before dispatch parses one, in relayHandler's own order: the bearer first. */
export function relayEntryPattern(authorization: string | null, pathname: string): RelayEntryPattern | undefined {
  if (authorization?.startsWith("Bearer dohc-service-v1.") || authorization?.startsWith(`Bearer ${AUTOMATION_REPLICA_BEARER_PREFIX}`)) return "replication";
  if (isServiceHostEnrollmentPath(pathname)) return pathname.endsWith("/kept-edits") ? "/sync/:workspaceId/live-host/kept-edits" : "/sync/:workspaceId/live-host";
  if (pathname.startsWith("/sync/named-chat/")) return "/sync/named-chat/*";
  if (pathname.startsWith("/sync/push/")) return "/sync/push/*";
  return LITERAL_ENTRIES.has(pathname) ? pathname as RelayEntryPattern : undefined;
}
