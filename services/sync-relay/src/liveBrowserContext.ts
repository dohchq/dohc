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

/**
 * Server-only context for a personal agent in one workspace of its owner: its
 * connection, the hashes of its access token and of the MCP address it signed
 * in at, and the fence epoch its last fresh read returned.
 */
export interface PersonalLiveContext {
  readonly kind: "personal";
  readonly workspaceId: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly accessTokenHash: string;
  readonly resourceHash: string;
  readonly fenceEpoch: number;
}

/** Whoever a live ticket is minted for and redeemed by. */
export type LiveTicketScope = LiveBrowserContext | PersonalLiveContext;

export function liveBrowserActor(scope: LinkLiveBrowserContext | AgentLiveContext): Extract<CurrentLiveBindingRequest["actor"], {kind: "link"}>;
export function liveBrowserActor(scope: NamedLiveBrowserContext): Extract<CurrentLiveBindingRequest["actor"], {kind: "named"}>;
export function liveBrowserActor(scope: PersonalLiveContext): Extract<CurrentLiveBindingRequest["actor"], {kind: "personal"}>;
export function liveBrowserActor(scope: LiveTicketScope): CurrentLiveBindingRequest["actor"];
export function liveBrowserActor(scope: LiveTicketScope): CurrentLiveBindingRequest["actor"] {
  if (scope.kind === "named") return { kind: "named", userId: scope.userId, grantId: scope.grantId };
  if (scope.kind === "personal") return { kind: "personal", workspaceId: scope.workspaceId, agentId: scope.agentId,
    connectionId: scope.connectionId, accessTokenHash: scope.accessTokenHash, resourceHash: scope.resourceHash, fenceEpoch: scope.fenceEpoch };
  return "agentConnectionId" in scope
    ? { kind: "link", workspaceId: scope.workspaceId, grantId: scope.grantId, agentConnectionId: scope.agentConnectionId,
      accessTokenHash: scope.accessTokenHash, resourceHash: scope.resourceHash }
    : { kind: "link", workspaceId: scope.workspaceId, grantId: scope.grantId, sessionId: scope.sessionId,
      profileTokenHash: scope.profileTokenHash };
}
