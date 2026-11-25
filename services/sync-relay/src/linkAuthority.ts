import type { TokenBucketLimiter } from "@dohc/service-http";
import type { PublicEditRelease } from "@dohc/security-contract";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import { AGENT_URI_CHAR_LIMIT } from "@dohc/security-contract/wire-patterns";
import { invalidLinkCapability, relayError } from "./errors";
import { hashAgentCredential, servableFiles, type ValidatedLinkCapability } from "./linkSecurity";
import type { PersonalAgents } from "./personalAgents";
import { authorizeLinkShareAction, authorizeShareGrantAction } from "./shareAuthorization";
import {
  fileSideOf,
  isWorkspaceSelector,
  type ShareSelector,
  type PathShareSelector,
} from "./shareFilter";
import type { SyncRelayStorage } from "./storage";
import type { AgentAccessCheck, AgentConnectionRow } from "./storage/agentConnections";

// One authority for a link route, from either credential share-web sends:
//
//   - a link holder's capability, `Authorization: LinkCapability <token>`;
//   - an agent's access token, `Authorization: DohcAgent <token>` with
//     `x-dohc-agent-resource: <the MCP address it signed in at>`, which also
//     needs the relay exchange key;
//   - a workspace member's account, on the read routes only:
//     `Authorization: DohcMember <grant>` with the account cookie and the
//     relay exchange key. The person comes from the cookie's session.
//   - a workspace owner's account, on the read routes only, the same way:
//     `Authorization: DohcOwner <workspace>`. The owner holds no grant; their
//     reach is an admin's, so the files a member never sees stay hidden.
//
// Nothing is cached. Every request authenticates, and `fresh` authenticates
// again. Every refusal is the bytes of a link that never existed.
//
// A personal agent's access token, sent the same way, resolves only through
// `personal`, which looks only in the personal tables. A route accepts one
// kind and never falls back to the other.

export type LinkCredential =
  | { kind: "holder"; capabilityToken: string; capability: ValidatedLinkCapability }
  | { kind: "agent"; check: AgentAccessCheck; connection: AgentConnectionRow }
  | { kind: "member"; userId: string }
  | { kind: "owner"; userId: string; workspaceId: string };

/** The reader is a person's account in a browser: a member's, or the owner's. */
export const readsAsAccount = (
  credential: LinkCredential,
): credential is Extract<LinkCredential, { kind: "member" | "owner" }> =>
  credential.kind === "member" || credential.kind === "owner";

export interface LinkAuthority {
  shareId: string;
  grantId: string;
  generation: number;
  access: PathShareSelector["access"];
  effectiveSelector: ShareSelector;
  /** Rate limits and held waits count per caller: the capability's hash, the agent's connection, or the member's account. */
  callerKey: string;
  credential: LinkCredential;
}

/**
 * Answers a link route with JSON for an authority, or for a holder's
 * capability on a route agents cannot use. An agent's answer authenticates
 * it again before each chunk, as its blob downloads do.
 */
export type LinkJsonResponse = (
  authority:
    | LinkAuthority
    | (Pick<LinkAuthority, "shareId" | "grantId"> & { credential?: undefined }),
  body: unknown,
  signal: AbortSignal,
) => Response;

/** A personal agent, checked at its account's fence. The route then checks the workspace. */
export interface PersonalAuthority {
  kind: "personal";
  agentId: string;
  ownerUserId: string;
  connectionId: string;
  agentEpoch: number;
  /** The fence epoch this check read. A write compares it again inside its transaction. */
  fenceEpoch: number;
  callerKey: string;
  check: AgentAccessCheck;
}

export interface LinkAuthorityResolver {
  /** Authenticates the request. */
  resolve(request: Request): LinkAuthority;
  /** Authenticates the request, then admits it per caller and per link. */
  require(
    request: Request,
    callerLimiter: TokenBucketLimiter,
    grantLimiter: TokenBucketLimiter,
  ): LinkAuthority;
  /** As `require`, for a member's or the owner's account (`isAccountRequest`). Only the read routes call it. */
  requireMember(
    request: Request,
    callerLimiter: TokenBucketLimiter,
    grantLimiter: TokenBucketLimiter,
  ): Promise<LinkAuthority>;
  /** Authenticates the same credential again, for the same link at the same generation. */
  fresh(authority: LinkAuthority): LinkAuthority;
  /** Authenticates a personal agent's request at its account's current fence. 503 while the fence can't be read. */
  personal(request: Request): Promise<PersonalAuthority>;
  /** Authenticates the same personal credential again, for the same connection, at the current fence. */
  freshPersonal(authority: PersonalAuthority): Promise<PersonalAuthority>;
}

const AGENT_SCHEME = /^DohcAgent (.+)$/u;
const MEMBER_SCHEME = /^DohcMember ([A-Za-z0-9_.:-]{1,256})$/u;
const OWNER_SCHEME = /^DohcOwner ([A-Za-z0-9_.:-]{1,256})$/u;
const AGENT_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

/** Whether the request names the agent scheme, so a route can skip a holder's checks. */
export function isAgentRequest(request: Request): boolean {
  return (request.headers.get("authorization") ?? "").startsWith("DohcAgent ");
}

/** Whether the request names a workspace member's grant. */
export function isMemberRequest(request: Request): boolean {
  return (request.headers.get("authorization") ?? "").startsWith("DohcMember ");
}

/** Whether the request names a member's grant or the owner's workspace, so an account reads it. */
export function isAccountRequest(request: Request): boolean {
  return (
    isMemberRequest(request) ||
    (request.headers.get("authorization") ?? "").startsWith("DohcOwner ")
  );
}

/** An agent's access token and the MCP address it was sent to, hashed; null when either is malformed. */
export function agentAccessCheck(
  token: unknown,
  resource: unknown,
  linkKey: string | Uint8Array,
): AgentAccessCheck | null {
  if (
    typeof token !== "string" ||
    !AGENT_TOKEN.test(token) ||
    typeof resource !== "string" ||
    resource.length === 0 ||
    resource.length > AGENT_URI_CHAR_LIMIT ||
    CONTROL_CHARS.test(resource)
  ) {
    return null;
  }
  return {
    accessTokenHash: hashAgentCredential("access", token, linkKey),
    resourceHash: hashAgentCredential("resource", resource, linkKey),
  };
}

export function createLinkAuthorityResolver(input: {
  storage: Pick<
    SyncRelayStorage,
    | "authenticateAgentAuthority"
    | "findChannelCreateKind"
    | "getShare"
    | "getShareGrant"
    | "workspaceIsOwnedBy"
    | "personalCredentialOwner"
    | "authenticatePersonalAuthority"
    | "workspaceMemberGrantIsCurrent"
    | "workspaceRoleOf"
    | "memberReach"
  >;
  /** The account behind a member's or the owner's cookie. A fenced account is already refused. */
  resolveActor: ResolveActor;
  /** share-web's origin, which a member's request names. */
  publicOrigin: string | undefined;
  personalAgents: Pick<PersonalAgents, "readFence">;
  /**
   * Stores the account's current verified email when the stored one is older
   * than the person's own reads allow. A personal agent's reach follows it.
   */
  refreshAccountEmail: (userId: string) => Promise<void>;
  linkKey: string | Uint8Array | undefined;
  publicEditRelease: PublicEditRelease | undefined;
  relayExchangeKeyConfigured: boolean;
  hasValidRelayExchangeKey: (request: Request) => boolean;
  nowMs: () => number;
  requireLinkCapability: (request: Request) => {
    capabilityToken: string;
    capability: ValidatedLinkCapability;
  };
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
  const agent = (
    check: AgentAccessCheck,
    expected?: { shareId: string; grantId: string; generation: number },
  ): LinkAuthority => {
    const connection = storage.authenticateAgentAuthority(check, nowMs());
    if (!connection) throw invalidLinkCapability();
    const authorized = authorizeLinkShareAction({
      storage,
      grantId: connection.grantId,
      action: "read",
    });
    if (
      !authorized.ok ||
      authorized.grant.generation !== connection.generation ||
      authorized.share.shareId !== connection.shareId ||
      !servableFiles(authorized.effectiveSelector, input.publicEditRelease) ||
      (expected &&
        (expected.shareId !== connection.shareId ||
          expected.grantId !== connection.grantId ||
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

  // An agent never sends a holder's profile, and never comes from a browser.
  const agentCheck = (request: Request): AgentAccessCheck => {
    if (
      !linkKey ||
      !input.relayExchangeKeyConfigured ||
      !input.hasValidRelayExchangeKey(request) ||
      request.headers.has("x-dohc-link-profile-secret") ||
      request.headers.has("cookie")
    ) {
      throw invalidLinkCapability();
    }
    const check = agentAccessCheck(
      AGENT_SCHEME.exec(request.headers.get("authorization") ?? "")?.[1],
      request.headers.get("x-dohc-agent-resource"),
      linkKey,
    );
    if (!check) throw invalidLinkCapability();
    return check;
  };

  // A member's grant on the workspace share, while the membership, both
  // accounts and the grant are current. The files are the workspace's reach.
  const member = (
    userId: string,
    grantId: string,
    expected?: Pick<LinkAuthority, "shareId" | "generation" | "effectiveSelector">,
  ): LinkAuthority => {
    const authorized = authorizeShareGrantAction({
      storage,
      grantId,
      action: "read",
      principal: { kind: "user", userId },
    });
    if (!authorized.ok || !isWorkspaceSelector(authorized.effectiveSelector))
      throw invalidLinkCapability();
    const role = storage.workspaceRoleOf(authorized.share.workspaceId, userId);
    const files = fileSideOf(authorized.effectiveSelector);
    if (
      !role ||
      role.role === "owner" ||
      !files ||
      !storage.workspaceMemberGrantIsCurrent(authorized.share.shareId, grantId) ||
      (expected &&
        (expected.shareId !== authorized.share.shareId ||
          expected.generation !== authorized.grant.generation))
    ) {
      throw invalidLinkCapability();
    }
    if (
      expected &&
      "reach" in expected.effectiveSelector &&
      expected.effectiveSelector.reach &&
      (!("reach" in files) ||
        files.reach?.signature() !== expected.effectiveSelector.reach.signature())
    )
      throw invalidLinkCapability();
    return {
      shareId: authorized.share.shareId,
      grantId,
      generation: authorized.grant.generation,
      access: authorized.effectiveSelector.reach.evaluated.level,
      effectiveSelector: files,
      callerKey: `member:${userId}`,
      credential: { kind: "member", userId },
    };
  };

  // The owner's own workspace, read as an admin reads it: every file but the ones no member ever sees.
  // There is no grant, so the workspace names the read's limits, and it is checked again on every read.
  const owner = (
    userId: string,
    workspaceId: string,
    expected?: Pick<LinkAuthority, "effectiveSelector">,
  ): LinkAuthority => {
    if (storage.workspaceRoleOf(workspaceId, userId)?.role !== "owner")
      throw invalidLinkCapability();
    const files = fileSideOf({
      kind: "workspace",
      role: "admin",
      reach: storage.memberReach(workspaceId, userId, "admin", "edit"),
    });
    if (!files) throw invalidLinkCapability();
    if (
      expected &&
      "reach" in expected.effectiveSelector &&
      expected.effectiveSelector.reach &&
      (!("reach" in files) ||
        files.reach?.signature() !== expected.effectiveSelector.reach.signature())
    )
      throw invalidLinkCapability();
    const key = `owner:${workspaceId}`;
    return {
      shareId: key,
      grantId: key,
      generation: 0,
      access: "edit",
      effectiveSelector: files,
      callerKey: `owner:${userId}`,
      credential: { kind: "owner", userId, workspaceId },
    };
  };

  // Only share-web sends a member's or the owner's request: the account's cookie, and nothing a link or an agent sends.
  const memberRequest = async (request: Request): Promise<LinkAuthority> => {
    const authorization = request.headers.get("authorization") ?? "";
    const ownedWorkspaceId = OWNER_SCHEME.exec(authorization)?.[1];
    const grantId = MEMBER_SCHEME.exec(authorization)?.[1];
    const cookie = request.headers.get("cookie");
    if (
      !(grantId || ownedWorkspaceId) ||
      !cookie ||
      !input.publicOrigin ||
      request.headers.get("origin") !== input.publicOrigin ||
      !input.relayExchangeKeyConfigured ||
      !input.hasValidRelayExchangeKey(request) ||
      request.headers.has("x-dohc-link-profile-secret") ||
      request.headers.has("x-dohc-agent-resource")
    ) {
      throw invalidLinkCapability();
    }
    if (ownedWorkspaceId) {
      let actor;
      try {
        actor = await input.resolveActor(
          new Request(request.url, { headers: { cookie }, signal: request.signal }),
          ownedWorkspaceId,
        );
      } catch {
        throw invalidLinkCapability();
      }
      if (actor.workspaceId !== ownedWorkspaceId) throw invalidLinkCapability();
      return owner(actor.userId, ownedWorkspaceId);
    }
    const grant = storage.getShareGrant(grantId!);
    const share = grant && storage.getShare(grant.shareId);
    let actor;
    try {
      actor = await input.resolveActor(
        new Request(request.url, { headers: { cookie }, signal: request.signal }),
        share ? share.workspaceId : "",
      );
    } catch {
      throw invalidLinkCapability();
    }
    if (!share || actor.workspaceId !== share.workspaceId) throw invalidLinkCapability();
    return member(actor.userId, grantId!);
  };

  const admit = (
    authority: LinkAuthority,
    callerLimiter: TokenBucketLimiter,
    grantLimiter: TokenBucketLimiter,
  ) => {
    const admittedAtMs = nowMs();
    const admitted =
      callerLimiter.allow(authority.callerKey, admittedAtMs) &&
      grantLimiter.allow(authority.grantId, admittedAtMs);
    if (!admitted) throw relayError("link_read_rate_limited");
    return authority;
  };

  const resolve = (request: Request): LinkAuthority => {
    if (!isAgentRequest(request)) {
      // A holder never names an agent's address.
      if (request.headers.has("x-dohc-agent-resource")) throw invalidLinkCapability();
      const { capabilityToken, capability } = input.requireLinkCapability(request);
      return holder(capabilityToken, capability);
    }
    return agent(agentCheck(request));
  };

  // The account's fence is read by primary key first, then storage checks the
  // token, connection, agent epoch, that fence, account deletion, and address.
  const personal = async (
    check: AgentAccessCheck,
    connectionId?: string,
  ): Promise<PersonalAuthority> => {
    const owner = storage.personalCredentialOwner({ kind: "access", hash: check.accessTokenHash });
    if (owner === null) throw invalidLinkCapability();
    const fenceEpoch = await input.personalAgents.readFence(owner);
    const connection = storage.authenticatePersonalAuthority(check, fenceEpoch, nowMs());
    if (!connection || (connectionId !== undefined && connection.connectionId !== connectionId))
      throw invalidLinkCapability();
    // Reach reads the stored email. Without this, a rule that named the
    // person's old address keeps reaching their agent.
    await input.refreshAccountEmail(connection.ownerUserId);
    return {
      kind: "personal",
      agentId: connection.agentId,
      ownerUserId: connection.ownerUserId,
      connectionId: connection.connectionId,
      agentEpoch: connection.agentEpoch,
      fenceEpoch,
      callerKey: `personal:${connection.connectionId}`,
      check,
    };
  };

  return {
    resolve,
    require(request, callerLimiter, grantLimiter) {
      return admit(resolve(request), callerLimiter, grantLimiter);
    },
    async requireMember(request, callerLimiter, grantLimiter) {
      return admit(await memberRequest(request), callerLimiter, grantLimiter);
    },
    fresh(authority) {
      const { credential } = authority;
      if (credential.kind === "agent") return agent(credential.check, authority);
      if (credential.kind === "member")
        return member(credential.userId, authority.grantId, authority);
      if (credential.kind === "owner")
        return owner(credential.userId, credential.workspaceId, authority);
      return holder(
        credential.capabilityToken,
        input.requireFreshLinkRead(credential.capabilityToken, authority),
      );
    },
    async personal(request) {
      if (!isAgentRequest(request)) throw invalidLinkCapability();
      return personal(agentCheck(request));
    },
    freshPersonal(authority) {
      return personal(authority.check, authority.connectionId);
    },
  };
}
