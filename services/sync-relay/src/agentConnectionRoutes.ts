import { jsonResponse, readBoundedJson, TokenBucketLimiter } from "@dohc/service-http";
import type { PublicEditRelease } from "@dohc/security-contract";
import { LINK_SECRET_PATTERN } from "@dohc/security-contract/wire-patterns";
import { createAccountlessPathProjection } from "./accountlessPathProjection";
import { errorResponse, notFound, relayError, RelayError, RELAY_ERRORS } from "./errors";
import {
  constantTimeHashEqual,
  hashAgentCredential,
  hashLinkBearer,
  pkceS256Challenge,
  servableFiles,
  type AgentCredentialKind,
} from "./linkSecurity";
import { cursorCodec } from "./requestInputs";
import { authorizeLinkShareAction } from "./shareAuthorization";
import { requireOwnedShareGrant } from "./shareGrantRoutes";
import type { SyncRelayStorage } from "./storage";
import {
  AGENT_ACCESS_TOKEN_TTL_MS,
  AGENT_CLIENT_NAME_LIMIT,
  AGENT_REDIRECT_URI_LIMIT,
  AGENT_STATE_CHAR_LIMIT,
  AGENT_URI_CHAR_LIMIT,
  type AgentConnectionCursor,
  type AgentConnectionRow,
} from "./storage/agentConnections";

// share-web calls the internal routes over the relay exchange key. They hold
// the durable half of MCP sign-in for share links: client registrations, the
// consent request, its single-use code, and the connection's tokens. share-web
// keeps the public OAuth routes, the consent page, and the MCP transport.
export type AgentConnectionRoute =
  | { route: "agent-clients" }
  | { route: "agent-authorizations"; action: "begin" | "consent" | "decision" }
  | { route: "agent-token" }
  | { route: "agent-introspect" }
  | { route: "share-link-agents"; workspaceId: string; shareId: string; grantId: string }
  | { route: "share-link-agent-disconnect"; workspaceId: string; shareId: string; grantId: string; connectionId: string };

type AgentStorage = Pick<SyncRelayStorage,
  | "registerAgentClient" | "getAgentClient" | "beginAgentAuthorization" | "readAgentAuthorization"
  | "decideAgentAuthorization" | "redeemAgentAuthorizationCode" | "refreshAgentTokens"
  | "authenticateAgentAccessToken" | "listAgentConnections" | "disconnectAgentConnection"
  | "findLinkGrantByCredentialHash" | "getShare" | "getShareGrant" | "workspaceIsOwnedBy"
  | "findChannelCreateKind" | "getShareLabels"
>;

const MAX_INTERNAL_BODY_BYTES = 16 * 1024;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const connectionCursor = cursorCodec<AgentConnectionCursor>({ ms: "ms", id: "id" }, "cursor");

// The same bytes for every refusal, so a probe learns nothing about which check failed.
function refused(): Response {
  return errorResponse(notFound());
}

class Refused extends Error {}

function text(value: unknown, maxChars: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars || CONTROL_CHARS.test(value)) {
    throw new Refused();
  }
  return value;
}

function optionalText(value: unknown, maxChars: number): string | null {
  return value === undefined || value === null ? null : text(value, maxChars);
}

function fields(input: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(input).some((key) => !allowed.has(key)) || required.some((key) => !(key in input))) {
    throw new Refused();
  }
}

// RFC 8252 and OAuth 2.1: HTTPS, or HTTP to a loopback address for a native client.
function redirectUri(value: unknown): string {
  const uri = text(value, AGENT_URI_CHAR_LIMIT);
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Refused();
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "localhost";
  if (parsed.hash || parsed.username || parsed.password ||
      !(parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback))) {
    throw new Refused();
  }
  return uri;
}

function toAgent(connection: AgentConnectionRow) {
  return {
    connectionId: connection.connectionId,
    reportedName: connection.reportedName,
    connectedAtMs: connection.connectedAtMs,
    lastActionAtMs: connection.lastActionAtMs,
    status: connection.status,
  };
}

export function createAgentConnectionRoutes(input: {
  storage: AgentStorage;
  linkKey: string | Uint8Array | undefined;
  shareWebOrigin: string | undefined;
  relayExchangeKeyConfigured: boolean;
  hasValidRelayExchangeKey: (request: Request) => boolean;
  nowMs: () => number;
  newId: () => string;
  newLinkBearer: () => string;
  linkExchangeRateLimiter: TokenBucketLimiter;
  linkExchangeGlobalRateLimiter: TokenBucketLimiter;
  requireShareWorkspace: (share: { workspaceId: string }, workspaceId: string) => void;
  publicEditRelease?: PublicEditRelease;
}) {
  const { storage, linkKey, shareWebOrigin, nowMs, newId, newLinkBearer } = input;
  const hash = (kind: AgentCredentialKind, value: string) => hashAgentCredential(kind, value, linkKey!);

  // The link's files read access, at the generation the caller bound.
  const linkIsServable = (grantId: string, generation: number): boolean => {
    const authorized = authorizeLinkShareAction({ storage, grantId, action: "read" });
    return authorized.ok && authorized.grant.generation === generation &&
      servableFiles(authorized.effectiveSelector, input.publicEditRelease);
  };

  async function readInternal(request: Request): Promise<Record<string, unknown>> {
    if (!linkKey || !shareWebOrigin || !input.relayExchangeKeyConfigured || !input.hasValidRelayExchangeKey(request) ||
        request.method !== "POST") {
      throw new Refused();
    }
    let body: unknown;
    try {
      body = await readBoundedJson(request, MAX_INTERNAL_BODY_BYTES, AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]));
    } catch {
      throw new Refused();
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Refused();
    return body as Record<string, unknown>;
  }

  // The resource is this link's MCP address. It names the secret, so the relay
  // reads the secret from it and keeps only an HMAC of the address.
  function linkFromResource(resource: string) {
    const prefix = `${shareWebOrigin}/mcp/s/`;
    const secret = resource.startsWith(prefix) ? resource.slice(prefix.length) : "";
    const secretHash = hashLinkBearer(secret, linkKey!);
    const found = storage.findLinkGrantByCredentialHash(secretHash);
    const matches = constantTimeHashEqual(secretHash, found?.credential.secretHash ?? hashLinkBearer("", linkKey!));
    if (!LINK_SECRET_PATTERN.test(secret) || !found || !matches) return null;
    const share = storage.getShare(found.grant.shareId);
    if (!share || !linkIsServable(found.grant.grantId, found.credential.generation)) return null;
    return {
      workspaceId: share.workspaceId,
      shareId: share.shareId,
      grantId: found.grant.grantId,
      credentialId: found.credential.credentialId,
      generation: found.credential.generation,
    };
  }

  function registerClient(body: Record<string, unknown>): Response {
    fields(body, ["registration", "redirectUris"], ["clientId", "clientName"]);
    if (!Array.isArray(body.redirectUris) || body.redirectUris.length === 0 ||
        body.redirectUris.length > AGENT_REDIRECT_URI_LIMIT) {
      throw new Refused();
    }
    const redirectUris = [...new Set(body.redirectUris.map(redirectUri))];
    const reportedName = optionalText(body.clientName, AGENT_CLIENT_NAME_LIMIT);
    const registration = body.registration;
    let clientId: string;
    if (registration === "registered") {
      // A minted id never starts with https://, so it cannot collide with a metadata document's address.
      if (body.clientId !== undefined) throw new Refused();
      clientId = newLinkBearer();
    } else if (registration === "metadata-document") {
      clientId = text(body.clientId, AGENT_URI_CHAR_LIMIT);
      let parsed: URL;
      try {
        parsed = new URL(clientId);
      } catch {
        throw new Refused();
      }
      if (parsed.protocol !== "https:" || parsed.hash || parsed.href !== clientId) throw new Refused();
    } else {
      throw new Refused();
    }
    if (!storage.registerAgentClient({ clientId, registration, reportedName, redirectUris, nowMs: nowMs() })) {
      throw new Refused();
    }
    return jsonResponse({ ok: true, clientId });
  }

  function beginAuthorization(body: Record<string, unknown>, ip: string): Response {
    fields(body, ["clientId", "resource", "redirectUri", "codeChallenge", "codeChallengeMethod"], ["state"]);
    if (!input.linkExchangeGlobalRateLimiter.allow("global", nowMs())) throw relayError("link_read_rate_limited");
    const clientId = text(body.clientId, AGENT_URI_CHAR_LIMIT);
    const resource = text(body.resource, AGENT_URI_CHAR_LIMIT);
    const uri = redirectUri(body.redirectUri);
    const codeChallenge = text(body.codeChallenge, 43);
    if (body.codeChallengeMethod !== "S256" || !PKCE_CHALLENGE_PATTERN.test(codeChallenge)) throw new Refused();
    const state = optionalText(body.state, AGENT_STATE_CHAR_LIMIT);
    const link = linkFromResource(resource);
    if (!link) {
      if (!input.linkExchangeRateLimiter.allow(ip, nowMs())) throw relayError("link_read_rate_limited");
      throw new Refused();
    }
    const requestId = newLinkBearer();
    const begun = storage.beginAgentAuthorization({
      authorizationId: newId(),
      requestHash: hash("request", requestId),
      clientId,
      redirectUri: uri,
      resourceHash: hash("resource", resource),
      codeChallenge,
      state,
      link,
      nowMs: nowMs(),
      guard: () => linkIsServable(link.grantId, link.generation),
    });
    if (!begun) throw new Refused();
    return jsonResponse({ ok: true, requestId });
  }

  function readConsent(body: Record<string, unknown>): Response {
    fields(body, ["requestId"]);
    const requestId = text(body.requestId, 64);
    const authorization = storage.readAgentAuthorization(hash("request", requestId), nowMs());
    if (!authorization) throw new Refused();
    const authorized = authorizeLinkShareAction({ storage, grantId: authorization.grantId, action: "read" });
    if (!authorized.ok || authorized.grant.generation !== authorization.generation) throw new Refused();
    return jsonResponse({
      ok: true,
      access: authorized.effectiveSelector.access,
      subjectName: storage.getShareLabels(authorization.shareId).subjectName,
      reportedClientName: authorization.reportedName,
      redirectUri: authorization.redirectUri,
      expiresAtMs: authorization.expiresAtMs,
    });
  }

  function decide(body: Record<string, unknown>): Response {
    fields(body, ["requestId", "decision"]);
    const requestId = text(body.requestId, 64);
    const decision = body.decision;
    if (decision !== "allow" && decision !== "cancel") throw new Refused();
    const code = newLinkBearer();
    const decided = storage.decideAgentAuthorization({
      requestHash: hash("request", requestId),
      decision,
      codeHash: hash("code", code),
      nowMs: nowMs(),
      guard: (authorization) => linkIsServable(authorization.grantId, authorization.generation),
    });
    if (!decided.ok) throw new Refused();
    return jsonResponse({
      ok: true,
      redirectUri: decided.redirectUri,
      state: decided.state,
      ...(decision === "allow" ? { code } : {}),
    });
  }

  function issueTokens(body: Record<string, unknown>): Response {
    const issuedAtMs = nowMs();
    const accessToken = newLinkBearer();
    const refreshToken = newLinkBearer();
    let result: ReturnType<AgentStorage["refreshAgentTokens"]>;
    if (body.grantType === "authorization_code") {
      fields(body, ["grantType", "clientId", "code", "redirectUri", "codeVerifier", "resource"]);
      const verifier = text(body.codeVerifier, 128);
      if (!PKCE_VERIFIER_PATTERN.test(verifier)) throw new Refused();
      const connectionId = newId();
      result = storage.redeemAgentAuthorizationCode({
        codeHash: hash("code", text(body.code, 64)),
        clientId: text(body.clientId, AGENT_URI_CHAR_LIMIT),
        redirectUri: text(body.redirectUri, AGENT_URI_CHAR_LIMIT),
        resourceHash: hash("resource", text(body.resource, AGENT_URI_CHAR_LIMIT)),
        verifierChallenge: pkceS256Challenge(verifier),
        connectionId,
        principalId: newId(),
        profileTokenHash: hash("profile", connectionId),
        accessTokenHash: hash("access", accessToken),
        refreshTokenHash: hash("refresh", refreshToken),
        nowMs: issuedAtMs,
        guard: (authorization) => linkIsServable(authorization.grantId, authorization.generation),
      });
    } else if (body.grantType === "refresh_token") {
      fields(body, ["grantType", "clientId", "refreshToken", "resource"]);
      result = storage.refreshAgentTokens({
        refreshTokenHash: hash("refresh", text(body.refreshToken, 64)),
        clientId: text(body.clientId, AGENT_URI_CHAR_LIMIT),
        resourceHash: hash("resource", text(body.resource, AGENT_URI_CHAR_LIMIT)),
        accessTokenHash: hash("access", accessToken),
        nextRefreshTokenHash: hash("refresh", refreshToken),
        nowMs: issuedAtMs,
        guard: (connection) => linkIsServable(connection.grantId, connection.generation),
      });
    } else {
      throw new Refused();
    }
    if (!result.ok) throw new Refused();
    return jsonResponse({
      ok: true,
      accessToken,
      accessTokenExpiresAtMs: issuedAtMs + AGENT_ACCESS_TOKEN_TTL_MS,
      refreshToken,
    });
  }

  function introspect(body: Record<string, unknown>): Response {
    fields(body, ["accessToken"]);
    const connection = storage.authenticateAgentAccessToken(hash("access", text(body.accessToken, 64)), nowMs());
    if (!connection) throw new Refused();
    const authorized = authorizeLinkShareAction({ storage, grantId: connection.grantId, action: "read" });
    if (!authorized.ok || authorized.grant.generation !== connection.generation ||
        !servableFiles(authorized.effectiveSelector, input.publicEditRelease)) {
      throw new Refused();
    }
    return jsonResponse({
      ok: true,
      connectionId: connection.connectionId,
      shareId: connection.shareId,
      grantId: connection.grantId,
      generation: connection.generation,
      principalId: connection.principalId,
      access: authorized.effectiveSelector.access,
      effectiveSelector: createAccountlessPathProjection(authorized.effectiveSelector).selector,
    });
  }

  async function respondToAgentSignIn(request: Request, route: AgentConnectionRoute): Promise<Response> {
    try {
      const body = await readInternal(request);
      const ip = request.headers.get("x-dohc-relay-client-ip") ?? "unknown";
      switch (route.route) {
        case "agent-clients": return registerClient(body);
        case "agent-authorizations":
          return route.action === "begin" ? beginAuthorization(body, ip) : route.action === "consent" ? readConsent(body) : decide(body);
        case "agent-token": return issueTokens(body);
        case "agent-introspect": return introspect(body);
        default: throw new Refused();
      }
    } catch (error) {
      if (error instanceof RelayError && error.code === RELAY_ERRORS.link_read_rate_limited.code) throw error;
      if (error instanceof Refused || error instanceof RelayError) return refused();
      throw error;
    }
  }

  // Owner only, following Reset link and End link: the actor owns the share
  // and its workspace, and the grant is an active link on that share.
  function respondToLinkAgents(
    request: Request,
    route: Extract<AgentConnectionRoute, { route: "share-link-agents" | "share-link-agent-disconnect" }>,
    actor: { userId: string },
  ): Response {
    const owned = () => {
      const { share } = requireOwnedShareGrant(storage, "link", route.shareId, route.grantId, actor);
      input.requireShareWorkspace(share, route.workspaceId);
    };
    owned();
    if (route.route === "share-link-agents") {
      if (request.method !== "GET") throw relayError("method_not_allowed");
      const cursor = connectionCursor.decode(new URL(request.url).searchParams.get("cursor"));
      const page = storage.listAgentConnections({
        workspaceId: route.workspaceId, shareId: route.shareId, grantId: route.grantId, cursor,
      });
      return jsonResponse({
        ok: true,
        agents: page.connections.map(toAgent),
        nextCursor: page.nextCursor ? connectionCursor.encode(page.nextCursor) : null,
      });
    }
    if (request.method !== "POST") throw relayError("method_not_allowed");
    const connection = storage.disconnectAgentConnection({
      workspaceId: route.workspaceId,
      shareId: route.shareId,
      grantId: route.grantId,
      connectionId: route.connectionId,
      nowMs: nowMs(),
      guard: owned,
    });
    if (!connection) throw notFound();
    return jsonResponse({ ok: true, agent: toAgent(connection) });
  }

  return { respondToAgentSignIn, respondToLinkAgents };
}
