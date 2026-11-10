import { jsonResponse, readBoundedJson, TokenBucketLimiter } from "@dohc/service-http";
import type { PublicEditRelease } from "@dohc/security-contract";
import type { ConsentCredentials } from "@dohc/workspace-auth/credentialFence";
import { UnauthorizedError, type AccountSession, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import {
  AGENT_REDIRECT_URI_LIMIT, AGENT_URI_CHAR_LIMIT, isAgentRedirectUri, LINK_SECRET_PATTERN,
} from "@dohc/security-contract/wire-patterns";
import { createAccountlessPathProjection } from "./accountlessPathProjection";
import type { DiscussionActivityHub } from "./discussionActivity";
import { errorResponse, notFound, relayError, RelayError, RELAY_ERRORS } from "./errors";
import {
  constantTimeHashEqual,
  hashAgentCredential,
  hashLinkBearer,
  pkceS256Challenge,
  servableFiles,
  type AgentCredentialKind,
} from "./linkSecurity";
import { newPersonalAgentId, parsePersonalReach, type PersonalAgents } from "./personalAgents";
import { cursorCodec, parseWorkspaceId } from "./requestInputs";
import { authorizeLinkShareAction } from "./shareAuthorization";
import { requireOwnedShareGrant } from "./shareGrantRoutes";
import type { SyncRelayStorage } from "./storage";
import {
  AGENT_ACCESS_TOKEN_TTL_MS,
  AGENT_CLIENT_NAME_LIMIT,
  AGENT_STATE_CHAR_LIMIT,
  type AgentConnectionCursor,
  type AgentConnectionRow,
} from "./storage/agentConnections";
import { PERSONAL_AGENT_ID, PERSONAL_REACH_LEVELS, type PersonalAgentChoice } from "./storage/personalAgents";

// share-web calls the internal routes over the relay exchange key. They hold
// the durable half of MCP sign-in for share links and personal agents: client
// registrations, the consent request, its single-use code, and the
// connection's tokens. share-web keeps the public OAuth routes, the consent
// page, and the MCP transport.
//
// The two families never mix. The resource an agent signs in at picks the
// tables: a share link's MCP address, or a personal one under
// `/mcp/agent/w/<workspaceId>`. A code or token is looked up only in its own
// family's tables.
export type AgentConnectionRoute =
  | { route: "agent-clients" }
  | { route: "agent-authorizations"; action: "begin" | "consent" | "decision" | "personal-consent" | "personal-decision" }
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
  | "beginPersonalAuthorization" | "readPersonalAuthorization" | "cancelPersonalAuthorization"
  | "allowPersonalAuthorization" | "personalCredentialOwner" | "redeemPersonalAuthorizationCode"
  | "refreshPersonalTokens" | "listPersonalAgents"
>;

const MAX_INTERNAL_BODY_BYTES = 16 * 1024;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const connectionCursor = cursorCodec<AgentConnectionCursor>({ ms: "ms", id: "id" }, "cursor");
const PASSWORD_CHAR_LIMIT = 1_024;
// Refusals a signed-in person or a waiting agent can act on. Every other refusal is the same bytes.
const ANSWERED_REFUSALS = new Set<string>([
  RELAY_ERRORS.link_read_rate_limited.code,
  RELAY_ERRORS.personal_agent_unavailable.code,
  RELAY_ERRORS.password_incorrect.code,
  RELAY_ERRORS.password_rate_limited.code,
  RELAY_ERRORS.sign_in_again.code,
]);

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

// share-web checks the same rule first, to answer invalid_redirect_uri.
function redirectUri(value: unknown): string {
  if (!isAgentRedirectUri(value)) throw new Refused();
  return value;
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
  // Disconnect wakes the connection's held waits, so they end now.
  activity: Pick<DiscussionActivityHub, "wakeLog">;
  personalAgents: PersonalAgents;
  // The browser's account session, from the cookie share-web forwards with a personal consent call.
  resolveAccountSession: ResolveAccountSession | undefined;
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

  function isPersonalResource(resource: string): boolean {
    return resource.startsWith(`${shareWebOrigin}/mcp/agent/w/`);
  }

  // A personal agent's MCP address names the workspace its link was copied
  // from. Only one spelling of each address is accepted, so its hash is stable.
  function personalWorkspaceFromResource(resource: string): string | null {
    if (!isPersonalResource(resource)) return null;
    const segment = resource.slice(`${shareWebOrigin}/mcp/agent/w/`.length);
    try {
      const workspaceId = parseWorkspaceId(decodeURIComponent(segment));
      return encodeURIComponent(workspaceId) === segment ? workspaceId : null;
    } catch {
      return null;
    }
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
    if (isPersonalResource(resource)) {
      // Anyone who knows a workspace id can begin one, and each pushes out the
      // workspace's oldest pending request at the cap, so every begin counts.
      if (!input.linkExchangeRateLimiter.allow(ip, nowMs())) throw relayError("link_read_rate_limited");
      const workspaceId = personalWorkspaceFromResource(resource);
      const requestId = newLinkBearer();
      // Personal sign-in needs the fence store, which consent checks the password against.
      const begun = workspaceId !== null && input.personalAgents.fence !== undefined && storage.beginPersonalAuthorization({
        authorizationId: newId(),
        requestHash: hash("request", requestId),
        clientId,
        redirectUri: uri,
        resourceHash: hash("resource", resource),
        codeChallenge,
        state,
        workspaceId,
        nowMs: nowMs(),
      });
      if (!begun) throw new Refused();
      return jsonResponse({ ok: true, requestId });
    }
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

  // The browser's account, from the cookie share-web forwards. Only the cookie
  // is read, so no other credential on the call can stand in for it.
  async function accountSession(request: Request): Promise<AccountSession> {
    if (!input.resolveAccountSession) throw new Refused();
    let session: AccountSession;
    try {
      session = await input.resolveAccountSession(new Request(request.url, {
        headers: { cookie: request.headers.get("cookie") ?? "" }, signal: request.signal,
      }));
    } catch (error) {
      // A session lookup that can't reach Postgres fails closed, as the fence does.
      if (error instanceof UnauthorizedError) throw error;
      throw relayError("personal_agent_unavailable");
    }
    if (session.expiresAtMs <= nowMs()) throw new UnauthorizedError();
    return session;
  }

  // The signed-in account owns the workspace the link was copied from, and
  // its password hasn't changed since this browser signed in.
  async function personalConsentContext(request: Request, requestId: string) {
    const { fence } = input.personalAgents;
    const pending = storage.readPersonalAuthorization(hash("request", requestId), nowMs());
    if (!pending || !fence) throw new Refused();
    const session = await accountSession(request);
    if (!storage.workspaceIsOwnedBy(pending.workspaceId, session.userId)) throw new Refused();
    let credentials: ConsentCredentials | null;
    try {
      credentials = await fence.readConsentCredentials(session.userId, session.sessionId);
    } catch {
      throw relayError("personal_agent_unavailable");
    }
    if (!credentials) throw new Refused();
    if (!credentials.sessionCurrent) throw relayError("sign_in_again");
    return { pending, session, credentials };
  }

  async function readPersonalConsent(request: Request, body: Record<string, unknown>): Promise<Response> {
    fields(body, ["requestId"]);
    const { pending, session } = await personalConsentContext(request, text(body.requestId, 64));
    const roster = storage.listPersonalAgents(session.userId);
    return jsonResponse({
      ok: true,
      reportedClientName: pending.reportedName,
      redirectUri: pending.redirectUri,
      expiresAtMs: pending.expiresAtMs,
      workspaceId: pending.workspaceId,
      levels: PERSONAL_REACH_LEVELS,
      workspaces: roster.workspaces,
      agents: roster.agents.map((agent) => ({
        agentId: agent.agentId,
        name: agent.name,
        hue: agent.hue,
        status: agent.status,
        reach: agent.reach.map((entry) => ({ workspaceId: entry.workspaceId, level: entry.level })),
      })),
    });
  }

  function personalAgentChoice(value: unknown): PersonalAgentChoice {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Refused();
    const choice = value as Record<string, unknown>;
    if (choice.kind === "new") {
      fields(choice, ["kind", "name"]);
      return { kind: "new", name: text(choice.name, AGENT_CLIENT_NAME_LIMIT) };
    }
    fields(choice, ["kind", "agentId"]);
    if (choice.kind !== "existing" || typeof choice.agentId !== "string" || !PERSONAL_AGENT_ID.test(choice.agentId)) {
      throw new Refused();
    }
    return { kind: "existing", agentId: choice.agentId };
  }

  // A wrong password counts against the account, as sign-in counts it. An
  // account checks one password at a time, so guesses sent together can't
  // all start before the first wrong one is counted.
  const checkingPassword = new Set<string>();
  async function checkPassword(userId: string, passwordHash: string | null, password: string): Promise<void> {
    const { fence, passwordLimiter } = input.personalAgents;
    if (checkingPassword.has(userId) || !passwordLimiter.has(userId, nowMs())) throw relayError("password_rate_limited");
    checkingPassword.add(userId);
    try {
      if (passwordHash !== null && await fence!.verifyPassword(passwordHash, password)) return;
      passwordLimiter.allow(userId, nowMs());
    } finally {
      checkingPassword.delete(userId);
    }
    throw relayError("password_incorrect");
  }

  // Allow records the fence epoch read with the password hash, so a password
  // changed after that read fails redemption.
  async function decidePersonal(request: Request, body: Record<string, unknown>): Promise<Response> {
    if (body.decision === "cancel") {
      fields(body, ["requestId", "decision"]);
      const cancelled = storage.cancelPersonalAuthorization(hash("request", text(body.requestId, 64)), nowMs());
      if (!cancelled) throw new Refused();
      return jsonResponse({ ok: true, redirectUri: cancelled.redirectUri, state: cancelled.state });
    }
    fields(body, ["requestId", "decision", "password", "agent", "reach"]);
    const requestId = text(body.requestId, 64);
    const agent = personalAgentChoice(body.agent);
    const reach = parsePersonalReach(body.reach);
    const password = body.password;
    if (body.decision !== "allow" || !reach || reach.length === 0 ||
        typeof password !== "string" || password.length === 0 || password.length > PASSWORD_CHAR_LIMIT) {
      throw new Refused();
    }
    const { session, credentials } = await personalConsentContext(request, requestId);
    await checkPassword(session.userId, credentials.passwordHash, password);
    const code = newLinkBearer();
    const allowed = storage.allowPersonalAuthorization({
      requestHash: hash("request", requestId),
      ownerUserId: session.userId,
      fenceEpoch: credentials.epoch,
      agent,
      reach,
      codeHash: hash("code", code),
      nowMs: nowMs(),
    });
    if (!allowed) throw new Refused();
    return jsonResponse({ ok: true, redirectUri: allowed.redirectUri, state: allowed.state, code });
  }

  type IssuedTokens = { accessTokenHash: string; refreshTokenHash: string; issuedAtMs: number };

  function issueLinkTokens(body: Record<string, unknown>, resource: string, tokens: IssuedTokens): boolean {
    if (body.grantType === "authorization_code") {
      fields(body, ["grantType", "clientId", "code", "codeVerifier", "resource"], ["redirectUri"]);
      const verifier = text(body.codeVerifier, 128);
      if (!PKCE_VERIFIER_PATTERN.test(verifier)) throw new Refused();
      const connectionId = newId();
      return storage.redeemAgentAuthorizationCode({
        codeHash: hash("code", text(body.code, 64)),
        clientId: text(body.clientId, AGENT_URI_CHAR_LIMIT),
        redirectUri: body.redirectUri === undefined ? null : text(body.redirectUri, AGENT_URI_CHAR_LIMIT),
        resourceHash: hash("resource", resource),
        verifierChallenge: pkceS256Challenge(verifier),
        connectionId,
        principalId: newId(),
        profileTokenHash: hash("profile", connectionId),
        accessTokenHash: tokens.accessTokenHash,
        refreshTokenHash: tokens.refreshTokenHash,
        nowMs: tokens.issuedAtMs,
        guard: (authorization) => linkIsServable(authorization.grantId, authorization.generation),
      }).ok;
    }
    if (body.grantType === "refresh_token") {
      fields(body, ["grantType", "clientId", "refreshToken", "resource"]);
      return storage.refreshAgentTokens({
        refreshTokenHash: hash("refresh", text(body.refreshToken, 64)),
        clientId: text(body.clientId, AGENT_URI_CHAR_LIMIT),
        resourceHash: hash("resource", resource),
        accessTokenHash: tokens.accessTokenHash,
        nextRefreshTokenHash: tokens.refreshTokenHash,
        nowMs: tokens.issuedAtMs,
        guard: (connection) => linkIsServable(connection.grantId, connection.generation),
      }).ok;
    }
    throw new Refused();
  }

  // The account's fence is read just before the transaction that compares
  // it, so a password change committed before that read refuses the grant.
  async function issuePersonalTokens(body: Record<string, unknown>, resource: string, tokens: IssuedTokens): Promise<boolean> {
    const personal = input.personalAgents;
    if (body.grantType === "authorization_code") {
      fields(body, ["grantType", "clientId", "code", "codeVerifier", "resource"], ["redirectUri"]);
      const verifier = text(body.codeVerifier, 128);
      if (!PKCE_VERIFIER_PATTERN.test(verifier)) throw new Refused();
      const codeHash = hash("code", text(body.code, 64));
      const owner = storage.personalCredentialOwner({ kind: "code", hash: codeHash });
      if (owner === null) return false;
      const fenceEpoch = await personal.readFence(owner);
      const result = storage.redeemPersonalAuthorizationCode({
        codeHash,
        clientId: text(body.clientId, AGENT_URI_CHAR_LIMIT),
        redirectUri: body.redirectUri === undefined ? null : text(body.redirectUri, AGENT_URI_CHAR_LIMIT),
        resourceHash: hash("resource", resource),
        verifierChallenge: pkceS256Challenge(verifier),
        fenceEpoch,
        newAgentId: newPersonalAgentId(),
        connectionId: newId(),
        accessTokenHash: tokens.accessTokenHash,
        refreshTokenHash: tokens.refreshTokenHash,
        nowMs: tokens.issuedAtMs,
      });
      // Signing in again ended the agent's other connections; their running work ends with them.
      if (result.ok) personal.endAgent(result.connection.agentId, []);
      else if (result.endedConnectionId) personal.endConnection(result.endedConnectionId);
      return result.ok;
    }
    if (body.grantType === "refresh_token") {
      fields(body, ["grantType", "clientId", "refreshToken", "resource"]);
      const refreshTokenHash = hash("refresh", text(body.refreshToken, 64));
      const owner = storage.personalCredentialOwner({ kind: "refresh", hash: refreshTokenHash });
      if (owner === null) return false;
      const fenceEpoch = await personal.readFence(owner);
      const result = storage.refreshPersonalTokens({
        refreshTokenHash,
        clientId: text(body.clientId, AGENT_URI_CHAR_LIMIT),
        resourceHash: hash("resource", resource),
        fenceEpoch,
        accessTokenHash: tokens.accessTokenHash,
        nextRefreshTokenHash: tokens.refreshTokenHash,
        nowMs: tokens.issuedAtMs,
      });
      if (!result.ok && result.endedConnectionId) personal.endConnection(result.endedConnectionId);
      return result.ok;
    }
    throw new Refused();
  }

  async function issueTokens(body: Record<string, unknown>): Promise<Response> {
    const issuedAtMs = nowMs();
    const accessToken = newLinkBearer();
    const refreshToken = newLinkBearer();
    const tokens = { accessTokenHash: hash("access", accessToken), refreshTokenHash: hash("refresh", refreshToken), issuedAtMs };
    const resource = text(body.resource, AGENT_URI_CHAR_LIMIT);
    const issued = isPersonalResource(resource)
      ? await issuePersonalTokens(body, resource, tokens)
      : issueLinkTokens(body, resource, tokens);
    if (!issued) throw new Refused();
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
          if (route.action === "begin") return beginAuthorization(body, ip);
          if (route.action === "consent") return readConsent(body);
          if (route.action === "decision") return decide(body);
          return route.action === "personal-consent"
            ? await readPersonalConsent(request, body)
            : await decidePersonal(request, body);
        case "agent-token": return await issueTokens(body);
        case "agent-introspect": return introspect(body);
        default: throw new Refused();
      }
    } catch (error) {
      if (error instanceof RelayError && ANSWERED_REFUSALS.has(error.code)) throw error;
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
    input.activity.wakeLog(route.workspaceId);
    return jsonResponse({ ok: true, agent: toAgent(connection) });
  }

  return { respondToAgentSignIn, respondToLinkAgents };
}
