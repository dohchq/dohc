import type { NamedLiveBrowserContext } from "./namedLiveBrowserAuth";
import type { CurrentLiveBindingRequest } from "./storage/types";

/** Server-only context from the authenticated viewer session and profile cookie. */
export interface LinkLiveBrowserContext {
  readonly kind: "link";
  readonly workspaceId: string;
  readonly shareId: string;
  readonly grantId: string;
  readonly sessionId: string;
  readonly capabilityHash: string;
  readonly profileTokenHash: string;
}

/**
 * Server-only context for an agent connected through its link: its
 * connection, and the hashes of its access token and of the MCP address it
 * signed in at, which every later check presents again.
 */
export interface AgentLiveContext {
  readonly kind: "link";
  readonly workspaceId: string;
  readonly shareId: string;
  readonly grantId: string;
  readonly agentConnectionId: string;
  readonly accessTokenHash: string;
  readonly resourceHash: string;
}

export type LiveBrowserContext = NamedLiveBrowserContext | LinkLiveBrowserContext | AgentLiveContext;

export function liveBrowserActor(scope: LinkLiveBrowserContext | AgentLiveContext): Extract<CurrentLiveBindingRequest["actor"], {kind: "link"}>;
export function liveBrowserActor(scope: NamedLiveBrowserContext): Extract<CurrentLiveBindingRequest["actor"], {kind: "named"}>;
export function liveBrowserActor(scope: LiveBrowserContext): CurrentLiveBindingRequest["actor"];
export function liveBrowserActor(scope: LiveBrowserContext): CurrentLiveBindingRequest["actor"] {
  if (scope.kind === "named") return { kind: "named", userId: scope.userId, grantId: scope.grantId };
  return "agentConnectionId" in scope
    ? { kind: "link", workspaceId: scope.workspaceId, grantId: scope.grantId, agentConnectionId: scope.agentConnectionId,
      accessTokenHash: scope.accessTokenHash, resourceHash: scope.resourceHash }
    : { kind: "link", workspaceId: scope.workspaceId, grantId: scope.grantId, sessionId: scope.sessionId,
      profileTokenHash: scope.profileTokenHash };
}
