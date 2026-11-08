import type { TokenBucketLimiter } from "@dohc/service-http";
import type { PublicEditRelease } from "@dohc/security-contract";
import { AGENT_URI_CHAR_LIMIT } from "@dohc/security-contract/wire-patterns";
import { invalidLinkCapability, relayError } from "./errors";
import { hashAgentCredential, servableFiles, type ValidatedLinkCapability } from "./linkSecurity";
import { authorizeLinkShareAction } from "./shareAuthorization";
import type { ShareSelector } from "./shareFilter";
import type { SyncRelayStorage } from "./storage";
import type { AgentAccessCheck, AgentConnectionRow } from "./storage/agentConnections";

// One authority for a link route, from either credential share-web sends:
//
//   - a link holder's capability, `Authorization: LinkCapability <token>`;
//   - an agent's access token, `Authorization: DohcAgent <token>` with
//     `x-dohc-agent-resource: <the MCP address it signed in at>`, which also
//     needs the relay exchange key.
//
// Nothing is cached. Every request authenticates, and `fresh` authenticates
// again. Every refusal is the bytes of a link that never existed.

export type LinkCredential =
  | { kind: "holder"; capabilityToken: string; capability: ValidatedLinkCapability }
  | { kind: "agent"; check: AgentAccessCheck; connection: AgentConnectionRow };

export interface LinkAuthority {
  shareId: string;
  grantId: string;
  generation: number;
  access: ShareSelector["access"];
  effectiveSelector: ShareSelector;
  /** Rate limits and held waits count per caller: the capability's hash, or the agent's connection. */
  callerKey: string;
  credential: LinkCredential;
}

/**
 * Answers a link route with JSON for an authority, or for a holder's
 * capability on a route agents cannot use. An agent's answer authenticates
 * it again before each chunk, as its blob downloads do.
 */
export type LinkJsonResponse = (
  authority: LinkAuthority | (Pick<LinkAuthority, "shareId" | "grantId"> & { credential?: undefined }),
  body: unknown,
  signal: AbortSignal,
) => Response;

export interface LinkAuthorityResolver {
  /** Authenticates the request. */
  resolve(request: Request): LinkAuthority;
  /** Authenticates the request, then admits it per caller and per link. */
  require(request: Request, callerLimiter: TokenBucketLimiter, grantLimiter: TokenBucketLimiter): LinkAuthority;
  /** Authenticates the same credential again, for the same link at the same generation. */
  fresh(authority: LinkAuthority): LinkAuthority;
}

const AGENT_SCHEME = /^DohcAgent (.+)$/u;
const AGENT_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

/** Whether the request names the agent scheme, so a route can skip a holder's checks. */
export function isAgentRequest(request: Request): boolean {
  return (request.headers.get("authorization") ?? "").startsWith("DohcAgent ");
}

/** An agent's access token and the MCP address it was sent to, hashed; null when either is malformed. */
export function agentAccessCheck(token: unknown, resource: unknown, linkKey: string | Uint8Array): AgentAccessCheck | null {
  if (typeof token !== "string" || !AGENT_TOKEN.test(token) || typeof resource !== "string" || resource.length === 0 ||
      resource.length > AGENT_URI_CHAR_LIMIT || CONTROL_CHARS.test(resource)) {
    return null;
  }
  return {
    accessTokenHash: hashAgentCredential("access", token, linkKey),
    resourceHash: hashAgentCredential("resource", resource, linkKey),
  };
}

export function createLinkAuthorityResolver(input: {
  storage: Pick<SyncRelayStorage,
    "authenticateAgentAuthority" | "findChannelCreateKind" | "getShare" | "getShareGrant" | "workspaceIsOwnedBy">;
  linkKey: string | Uint8Array | undefined;
  publicEditRelease: PublicEditRelease | undefined;
  relayExchangeKeyConfigured: boolean;
  hasValidRelayExchangeKey: (request: Request) => boolean;
  nowMs: () => number;
  requireLinkCapability: (request: Request) => { capabilityToken: string; capability: ValidatedLinkCapability };
  requireFreshLinkRead: (
    capabilityToken: string,
    expected: { shareId: string; grantId: string; generation: number },
  ) => ValidatedLinkCapability;
}): LinkAuthorityResolver {
  const { storage, linkKey, nowMs } = input;

  const holder = (capabilityToken: string, capability: ValidatedLinkCapability): LinkAuthority => ({
    shareId: capability.shareId,
    grantId: capability.grantId,
    generation: capability.generation,
    access: capability.access,
    effectiveSelector: capability.effectiveSelector,
    callerKey: capability.session.capabilityHash,
    credential: { kind: "holder", capabilityToken, capability },
  });

  // The four token checks and the address happen in storage. Here, the link
  // still serves its files at the generation the agent signed in with.
  const agent = (check: AgentAccessCheck, expected?: { shareId: string; grantId: string; generation: number }): LinkAuthority => {
    const connection = storage.authenticateAgentAuthority(check, nowMs());
    if (!connection) throw invalidLinkCapability();
    const authorized = authorizeLinkShareAction({ storage, grantId: connection.grantId, action: "read" });
    if (
      !authorized.ok || authorized.grant.generation !== connection.generation ||
      authorized.share.shareId !== connection.shareId ||
      !servableFiles(authorized.effectiveSelector, input.publicEditRelease) ||
      (expected && (expected.shareId !== connection.shareId || expected.grantId !== connection.grantId ||
        expected.generation !== connection.generation))
    ) {
      throw invalidLinkCapability();
    }
    return {
      shareId: connection.shareId,
      grantId: connection.grantId,
      generation: connection.generation,
      access: authorized.effectiveSelector.access,
      effectiveSelector: authorized.effectiveSelector,
      callerKey: `agent:${connection.connectionId}`,
      credential: { kind: "agent", check, connection },
    };
  };

  const resolve = (request: Request): LinkAuthority => {
    if (!isAgentRequest(request)) {
      // A holder never names an agent's address.
      if (request.headers.has("x-dohc-agent-resource")) throw invalidLinkCapability();
      const { capabilityToken, capability } = input.requireLinkCapability(request);
      return holder(capabilityToken, capability);
    }
    // An agent never sends a holder's profile, and never comes from a browser.
    if (!linkKey || !input.relayExchangeKeyConfigured || !input.hasValidRelayExchangeKey(request) ||
        request.headers.has("x-dohc-link-profile-secret") || request.headers.has("cookie")) {
      throw invalidLinkCapability();
    }
    const check = agentAccessCheck(AGENT_SCHEME.exec(request.headers.get("authorization") ?? "")?.[1],
      request.headers.get("x-dohc-agent-resource"), linkKey);
    if (!check) throw invalidLinkCapability();
    return agent(check);
  };

  return {
    resolve,
    require(request, callerLimiter, grantLimiter) {
      const authority = resolve(request);
      const admittedAtMs = nowMs();
      const admitted = callerLimiter.allow(authority.callerKey, admittedAtMs) &&
        grantLimiter.allow(authority.grantId, admittedAtMs);
      if (!admitted) throw relayError("link_read_rate_limited");
      return authority;
    },
    fresh(authority) {
      const { credential } = authority;
      if (credential.kind === "agent") return agent(credential.check, authority);
      return holder(credential.capabilityToken, input.requireFreshLinkRead(credential.capabilityToken, authority));
    },
  };
}
