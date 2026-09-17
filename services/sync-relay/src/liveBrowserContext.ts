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

export type LiveBrowserContext = NamedLiveBrowserContext | LinkLiveBrowserContext;

export function liveBrowserActor(scope: LinkLiveBrowserContext): Extract<CurrentLiveBindingRequest["actor"], {kind: "link"}>;
export function liveBrowserActor(scope: NamedLiveBrowserContext): Extract<CurrentLiveBindingRequest["actor"], {kind: "named"}>;
export function liveBrowserActor(scope: LiveBrowserContext): CurrentLiveBindingRequest["actor"];
export function liveBrowserActor(scope: LiveBrowserContext): CurrentLiveBindingRequest["actor"] {
  return scope.kind === "named"
    ? { kind: "named", userId: scope.userId, grantId: scope.grantId }
    : { kind: "link", workspaceId: scope.workspaceId, grantId: scope.grantId, sessionId: scope.sessionId,
      profileTokenHash: scope.profileTokenHash };
}
