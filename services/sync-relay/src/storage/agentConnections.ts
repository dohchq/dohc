import { normalizeShareDiscussionDisplayName } from "@dohc/security-contract/share-discussion";
import type { StorageContext } from "./context";
import type { SqliteDb, SyncRelayLinkPrincipalRow } from "./types";
import { currentShareGrantSql } from "./currentShareGrant";
import { linkPrincipalStorageBytes, type LinkEnrollment } from "./linkEnrollment";
import { nullableText } from "./rows";
import { upsertLinkUsage } from "./shares";
import { workspaceUsageBytes } from "./workspaces";
import { constantTimeHashEqual } from "../linkSecurity";

// An agent connection is one agent's MCP sign-in through one share link. It
// binds the link's grant, its current credential and generation, and a link
// principal the relay mints for it. Its refresh tokens are one family: reusing
// a rotated refresh token ends the connection. The relay keeps only HMACs of
// request ids, codes, tokens, and the secret-bearing resource address.

export const AGENT_AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1_000;
export const AGENT_AUTHORIZATION_CODE_TTL_MS = 60 * 1_000;
export const AGENT_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1_000;
export const AGENT_PENDING_AUTHORIZATIONS_PER_GRANT_LIMIT = 32;
export const AGENT_REDEEMED_AUTHORIZATION_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const AGENT_CLIENT_LIMIT = 50_000;
export const AGENT_UNUSED_CLIENT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const AGENT_CONNECTION_PAGE_SIZE = 50;
export const AGENT_CLIENT_NAME_LIMIT = 100;
export const AGENT_REDIRECT_URI_LIMIT = 10;
export const AGENT_URI_CHAR_LIMIT = 2_048;
export const AGENT_STATE_CHAR_LIMIT = 512;

export function initializeAgentConnectionSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_agent_clients (
      client_id TEXT PRIMARY KEY CHECK (length(client_id) BETWEEN 1 AND ${AGENT_URI_CHAR_LIMIT}),
      registration TEXT NOT NULL CHECK (registration IN ('metadata-document', 'registered')),
      reported_name TEXT CHECK (reported_name IS NULL OR length(reported_name) BETWEEN 1 AND ${AGENT_CLIENT_NAME_LIMIT}),
      redirect_uris_json TEXT NOT NULL CHECK (json_valid(redirect_uris_json) AND json_type(redirect_uris_json) = 'array'),
      registered_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      CHECK ((registration = 'metadata-document') = (substr(client_id, 1, 8) = 'https://'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_agent_clients_unused
      ON sync_relay_agent_clients(registration, registered_at_ms);

    CREATE TABLE IF NOT EXISTS sync_relay_agent_authorizations (
      authorization_id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL UNIQUE,
      code_hash TEXT UNIQUE,
      client_id TEXT NOT NULL REFERENCES sync_relay_agent_clients(client_id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      share_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      resource_hash TEXT NOT NULL,
      redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND ${AGENT_URI_CHAR_LIMIT}),
      code_challenge TEXT NOT NULL CHECK (length(code_challenge) = 43),
      state TEXT CHECK (state IS NULL OR length(state) BETWEEN 1 AND ${AGENT_STATE_CHAR_LIMIT}),
      status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'redeemed')),
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      connection_id TEXT,
      CHECK (expires_at_ms > created_at_ms),
      CHECK ((status = 'pending') = (code_hash IS NULL)),
      CHECK ((status = 'redeemed') = (connection_id IS NOT NULL)),
      FOREIGN KEY (grant_id, share_id)
        REFERENCES sync_relay_share_grants(grant_id, share_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_agent_authorizations_grant
      ON sync_relay_agent_authorizations(grant_id, status, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_sync_relay_agent_authorizations_share
      ON sync_relay_agent_authorizations(share_id);
    CREATE INDEX IF NOT EXISTS idx_sync_relay_agent_authorizations_client
      ON sync_relay_agent_authorizations(client_id);

    CREATE TABLE IF NOT EXISTS sync_relay_agent_connections (
      connection_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      share_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      principal_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      reported_name TEXT CHECK (reported_name IS NULL OR length(reported_name) BETWEEN 1 AND ${AGENT_CLIENT_NAME_LIMIT}),
      resource_hash TEXT NOT NULL,
      connected_at_ms INTEGER NOT NULL,
      last_action_at_ms INTEGER,
      status TEXT NOT NULL CHECK (status IN ('active', 'disconnected', 'retired')),
      ended_at_ms INTEGER,
      CHECK ((status = 'active') = (ended_at_ms IS NULL)),
      FOREIGN KEY (grant_id, share_id)
        REFERENCES sync_relay_share_grants(grant_id, share_id) ON DELETE CASCADE,
      FOREIGN KEY (principal_id, grant_id)
        REFERENCES sync_relay_link_principals(principal_id, grant_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_agent_connections_grant
      ON sync_relay_agent_connections(grant_id, status, connected_at_ms DESC, connection_id DESC);
    CREATE INDEX IF NOT EXISTS idx_sync_relay_agent_connections_share
      ON sync_relay_agent_connections(share_id, status);
    CREATE INDEX IF NOT EXISTS idx_sync_relay_agent_connections_client
      ON sync_relay_agent_connections(client_id);

    CREATE TABLE IF NOT EXISTS sync_relay_agent_tokens (
      token_hash TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL
        REFERENCES sync_relay_agent_connections(connection_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
      issued_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER,
      used_at_ms INTEGER,
      CHECK ((kind = 'access') = (expires_at_ms IS NOT NULL)),
      CHECK (kind = 'refresh' OR used_at_ms IS NULL)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_agent_tokens_connection
      ON sync_relay_agent_tokens(connection_id, kind, issued_at_ms);
  `);
  // start_seq is the log position when the agent signed in. A wait without
  // a cursor reads from there, and nothing moves it. A connection from
  // before the column starts at the log's end when the relay adds it.
  const marker = "agent-connection-start-seq-v1";
  if (!db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(marker)) {
    const columns = new Set(db.prepare("PRAGMA table_info(sync_relay_agent_connections)").all().map(row => String(row.name)));
    if (!columns.has("start_seq")) {
      db.exec(`ALTER TABLE sync_relay_agent_connections ADD COLUMN start_seq INTEGER NOT NULL DEFAULT 0 CHECK (start_seq >= 0);
        UPDATE sync_relay_agent_connections SET start_seq = (SELECT COALESCE(MAX(log.relay_seq), 0) FROM sync_relay_log AS log
          WHERE log.workspace_id = sync_relay_agent_connections.workspace_id);`);
    }
    db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(marker, Date.now());
  }
  // A discussion message or collection write an agent made through its
  // connection names that connection. Null for everything else.
  const provenance = "agent-write-provenance-v1";
  if (!db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(provenance)) {
    for (const table of ["sync_relay_share_discussion_messages", "sync_relay_collection_writes"]) {
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
      if (!columns.has("agent_connection_id")) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN agent_connection_id TEXT`);
      }
    }
    db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(provenance, Date.now());
  }
}

export type AgentClientRegistration = "metadata-document" | "registered";
export type AgentConnectionStatus = "active" | "disconnected" | "retired";

export interface AgentClientRow {
  clientId: string;
  registration: AgentClientRegistration;
  reportedName: string | null;
  redirectUris: string[];
}

export interface AgentAuthorizationRow {
  authorizationId: string;
  clientId: string;
  workspaceId: string;
  shareId: string;
  grantId: string;
  credentialId: string;
  generation: number;
  redirectUri: string;
  state: string | null;
  expiresAtMs: number;
  reportedName: string | null;
}

export interface AgentConnectionRow {
  connectionId: string;
  workspaceId: string;
  shareId: string;
  grantId: string;
  credentialId: string;
  generation: number;
  principalId: string;
  clientId: string;
  reportedName: string | null;
  connectedAtMs: number;
  lastActionAtMs: number | null;
  /** The log position when it signed in, where a wait without a cursor starts. */
  startSeq: number;
  status: AgentConnectionStatus;
  endedAtMs: number | null;
}

export interface AgentConnectionCursor {
  ms: number;
  id: string;
}

export interface AgentConnectionPage {
  connections: AgentConnectionRow[];
  nextCursor: AgentConnectionCursor | null;
}

// A route's commit-time recheck of the link's share authorization.
type Guard = () => boolean;

const CONNECTION_COLUMNS = `c.connection_id, c.workspace_id, c.share_id, c.grant_id, c.credential_id,
  c.generation, c.principal_id, c.client_id, c.reported_name, c.connected_at_ms,
  c.last_action_at_ms, c.start_seq, c.status, c.ended_at_ms`;

function rowToConnection(row: Record<string, unknown>): AgentConnectionRow {
  return {
    connectionId: String(row.connection_id),
    workspaceId: String(row.workspace_id),
    shareId: String(row.share_id),
    grantId: String(row.grant_id),
    credentialId: String(row.credential_id),
    generation: Number(row.generation),
    principalId: String(row.principal_id),
    clientId: String(row.client_id),
    reportedName: nullableText(row.reported_name),
    connectedAtMs: Number(row.connected_at_ms),
    lastActionAtMs: row.last_action_at_ms === null ? null : Number(row.last_action_at_ms),
    startSeq: Number(row.start_seq),
    status: String(row.status) as AgentConnectionStatus,
    endedAtMs: row.ended_at_ms === null ? null : Number(row.ended_at_ms),
  };
}

// The link a request, code, or connection was bound to is still the current
// credential at the same generation, on a current link grant.
function linkBindingIsCurrent(
  storage: StorageContext,
  binding: { grantId: string; shareId: string; workspaceId: string; credentialId: string; generation: number },
): boolean {
  return storage.db.prepare(`SELECT 1
    FROM sync_relay_share_grants AS grant
    JOIN sync_relay_shares AS share ON share.share_id = grant.share_id
    JOIN sync_relay_link_credentials AS credential
      ON credential.grant_id = grant.grant_id AND credential.retired_at_ms IS NULL
    WHERE grant.grant_id = ? AND grant.share_id = ? AND share.workspace_id = ?
      AND credential.credential_id = ? AND credential.generation = grant.generation
      AND grant.generation = ? AND grant.principal_kind = 'link'
      AND ${currentShareGrantSql("grant", "share")}
    LIMIT 1`).get(binding.grantId, binding.shareId, binding.workspaceId, binding.credentialId, binding.generation) !== undefined;
}

function retireConnections(storage: StorageContext, column: "grant_id" | "share_id" | "connection_id", value: string, status: "disconnected" | "retired", atMs: number): void {
  storage.db.prepare(`DELETE FROM sync_relay_agent_tokens WHERE connection_id IN (
      SELECT connection_id FROM sync_relay_agent_connections WHERE ${column} = ?)`).run(value);
  storage.db.prepare(`UPDATE sync_relay_agent_connections SET status = ?, ended_at_ms = ?
    WHERE ${column} = ? AND status = 'active'`).run(status, Math.trunc(atMs), value);
}

/**
 * Reset link and End link call this inside their own transaction. It removes
 * the grant's pending consent and codes, and ends its connections and tokens.
 */
export function retireAgentConnectionsInTransaction(
  storage: StorageContext,
  scope: { grantId: string } | { shareId: string },
  atMs: number,
): void {
  const [column, value] = "grantId" in scope ? ["grant_id", scope.grantId] as const : ["share_id", scope.shareId] as const;
  storage.db.prepare(`DELETE FROM sync_relay_agent_authorizations WHERE ${column} = ?`).run(value);
  retireConnections(storage, column, value, "retired", atMs);
}

export function registerAgentClient(storage: StorageContext, input: {
  clientId: string;
  registration: AgentClientRegistration;
  reportedName: string | null;
  redirectUris: readonly string[];
  nowMs: number;
}): boolean {
  if (input.redirectUris.length === 0 || input.redirectUris.length > AGENT_REDIRECT_URI_LIMIT ||
      (input.registration === "metadata-document") !== input.clientId.startsWith("https://")) {
    return false;
  }
  const nowMs = Math.trunc(input.nowMs);
  return storage.tx(() => {
    storage.db.prepare(`DELETE FROM sync_relay_agent_clients
      WHERE registered_at_ms < ?
        AND NOT EXISTS (SELECT 1 FROM sync_relay_agent_authorizations a WHERE a.client_id = sync_relay_agent_clients.client_id)
        AND NOT EXISTS (SELECT 1 FROM sync_relay_agent_connections c WHERE c.client_id = sync_relay_agent_clients.client_id)`)
      .run(nowMs - AGENT_UNUSED_CLIENT_RETENTION_MS);
    const existing = storage.db.prepare("SELECT registration FROM sync_relay_agent_clients WHERE client_id = ?").get(input.clientId);
    if (existing) {
      // A minted id names one registration. Only a metadata document refreshes.
      if (existing.registration !== "metadata-document" || input.registration !== "metadata-document") return false;
      storage.db.prepare(`UPDATE sync_relay_agent_clients SET reported_name = ?, redirect_uris_json = ?, updated_at_ms = ?
        WHERE client_id = ?`).run(input.reportedName, JSON.stringify(input.redirectUris), nowMs, input.clientId);
      return true;
    }
    const count = Number(storage.db.prepare("SELECT COUNT(*) AS count FROM sync_relay_agent_clients").get()?.count ?? 0);
    if (count >= AGENT_CLIENT_LIMIT) return false;
    storage.db.prepare(`INSERT INTO sync_relay_agent_clients
      (client_id, registration, reported_name, redirect_uris_json, registered_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.clientId, input.registration, input.reportedName, JSON.stringify(input.redirectUris), nowMs, nowMs);
    return true;
  });
}

export function getAgentClient(storage: StorageContext, clientId: string): AgentClientRow | null {
  const row = storage.db.prepare(`SELECT client_id, registration, reported_name, redirect_uris_json
    FROM sync_relay_agent_clients WHERE client_id = ?`).get(clientId);
  if (!row) return null;
  return {
    clientId: String(row.client_id),
    registration: String(row.registration) as AgentClientRegistration,
    reportedName: nullableText(row.reported_name),
    redirectUris: JSON.parse(String(row.redirect_uris_json)) as string[],
  };
}

// An http loopback IP literal, its optional port, and the rest of the string as written.
const LOOPBACK_REDIRECT = /^http:\/\/(127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?([/?#].*)?$/s;

/**
 * An exact match, except that RFC 8252 section 7.3 lets a native client on a
 * loopback IP literal pick its port when it asks. `localhost` gets no exception.
 * The strings are compared as written, so nothing is normalized into a match.
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  const want = LOOPBACK_REDIRECT.exec(registered);
  const got = LOOPBACK_REDIRECT.exec(presented);
  return want !== null && got !== null && Number(got[2] ?? 0) <= 65535 &&
    want[1] === got[1] && (want[3] ?? "") === (got[3] ?? "");
}

export function beginAgentAuthorization(storage: StorageContext, input: {
  authorizationId: string;
  requestHash: string;
  clientId: string;
  redirectUri: string;
  resourceHash: string;
  codeChallenge: string;
  state: string | null;
  link: { workspaceId: string; shareId: string; grantId: string; credentialId: string; generation: number };
  nowMs: number;
  guard: Guard;
}): boolean {
  const nowMs = Math.trunc(input.nowMs);
  return storage.tx(() => {
    if (!input.guard() || !linkBindingIsCurrent(storage, input.link)) return false;
    const client = getAgentClient(storage, input.clientId);
    if (!client || !client.redirectUris.some((registered) => redirectUriMatches(registered, input.redirectUri))) return false;
    storage.db.prepare(`DELETE FROM sync_relay_agent_authorizations
      WHERE (status != 'redeemed' AND expires_at_ms <= ?) OR (status = 'redeemed' AND expires_at_ms <= ?)`)
      .run(nowMs, nowMs - AGENT_REDEEMED_AUTHORIZATION_RETENTION_MS);
    storage.db.prepare(`DELETE FROM sync_relay_agent_authorizations WHERE authorization_id IN (
        SELECT authorization_id FROM sync_relay_agent_authorizations
        WHERE grant_id = ? AND status != 'redeemed'
        ORDER BY created_at_ms DESC, authorization_id DESC
        LIMIT -1 OFFSET ?)`)
      .run(input.link.grantId, AGENT_PENDING_AUTHORIZATIONS_PER_GRANT_LIMIT - 1);
    storage.db.prepare(`INSERT INTO sync_relay_agent_authorizations (
        authorization_id, request_hash, code_hash, client_id, workspace_id, share_id, grant_id,
        credential_id, generation, resource_hash, redirect_uri, code_challenge, state, status,
        created_at_ms, expires_at_ms, connection_id
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`)
      .run(input.authorizationId, input.requestHash, input.clientId, input.link.workspaceId, input.link.shareId,
        input.link.grantId, input.link.credentialId, input.link.generation, input.resourceHash, input.redirectUri,
        input.codeChallenge, input.state, nowMs, nowMs + AGENT_AUTHORIZATION_REQUEST_TTL_MS);
    return true;
  });
}

const AUTHORIZATION_COLUMNS = `a.authorization_id, a.client_id, a.workspace_id, a.share_id, a.grant_id,
  a.credential_id, a.generation, a.redirect_uri, a.state, a.expires_at_ms, client.reported_name`;

function rowToAuthorization(row: Record<string, unknown>): AgentAuthorizationRow {
  return {
    authorizationId: String(row.authorization_id),
    clientId: String(row.client_id),
    workspaceId: String(row.workspace_id),
    shareId: String(row.share_id),
    grantId: String(row.grant_id),
    credentialId: String(row.credential_id),
    generation: Number(row.generation),
    redirectUri: String(row.redirect_uri),
    state: nullableText(row.state),
    expiresAtMs: Number(row.expires_at_ms),
    reportedName: nullableText(row.reported_name),
  };
}

function readPending(storage: StorageContext, requestHash: string, nowMs: number): AgentAuthorizationRow | null {
  const row = storage.db.prepare(`SELECT ${AUTHORIZATION_COLUMNS}
    FROM sync_relay_agent_authorizations AS a
    JOIN sync_relay_agent_clients AS client ON client.client_id = a.client_id
    WHERE a.request_hash = ? AND a.status = 'pending' AND a.expires_at_ms > ?`).get(requestHash, Math.trunc(nowMs));
  if (!row) return null;
  const authorization = rowToAuthorization(row);
  return linkBindingIsCurrent(storage, authorization) ? authorization : null;
}

/** The consent screen's read. It never changes the request. */
export function readAgentAuthorization(storage: StorageContext, requestHash: string, nowMs: number): AgentAuthorizationRow | null {
  return storage.readTx(() => readPending(storage, requestHash, nowMs));
}

export type AgentAuthorizationDecision =
  | { ok: true; redirectUri: string; state: string | null }
  | { ok: false };

/** Allow turns the request into a single-use code. Cancel removes it. Either way, the request id is spent. */
export function decideAgentAuthorization(storage: StorageContext, input: {
  requestHash: string;
  decision: "allow" | "cancel";
  codeHash: string;
  nowMs: number;
  guard: (authorization: AgentAuthorizationRow) => boolean;
}): AgentAuthorizationDecision {
  const nowMs = Math.trunc(input.nowMs);
  return storage.tx(() => {
    const pending = readPending(storage, input.requestHash, nowMs);
    if (!pending) return { ok: false };
    if (input.decision === "cancel") {
      storage.db.prepare("DELETE FROM sync_relay_agent_authorizations WHERE authorization_id = ?").run(pending.authorizationId);
      return { ok: true, redirectUri: pending.redirectUri, state: pending.state };
    }
    if (!input.guard(pending)) return { ok: false };
    storage.db.prepare(`UPDATE sync_relay_agent_authorizations
      SET status = 'allowed', code_hash = ?, expires_at_ms = ?
      WHERE authorization_id = ? AND status = 'pending'`)
      .run(input.codeHash, nowMs + AGENT_AUTHORIZATION_CODE_TTL_MS, pending.authorizationId);
    return { ok: true, redirectUri: pending.redirectUri, state: pending.state };
  });
}

export type AgentTokenGrantResult = { ok: true; connection: AgentConnectionRow } | { ok: false };

function insertTokens(storage: StorageContext, connectionId: string, tokens: { accessTokenHash: string; refreshTokenHash: string }, nowMs: number): void {
  const insert = storage.db.prepare(`INSERT INTO sync_relay_agent_tokens
    (token_hash, connection_id, kind, issued_at_ms, expires_at_ms, used_at_ms) VALUES (?, ?, ?, ?, ?, NULL)`);
  insert.run(tokens.accessTokenHash, connectionId, "access", nowMs, nowMs + AGENT_ACCESS_TOKEN_TTL_MS);
  insert.run(tokens.refreshTokenHash, connectionId, "refresh", nowMs, null);
}

function getConnection(storage: StorageContext, connectionId: string): AgentConnectionRow | null {
  const row = storage.db.prepare(`SELECT ${CONNECTION_COLUMNS} FROM sync_relay_agent_connections AS c WHERE c.connection_id = ?`)
    .get(connectionId);
  return row ? rowToConnection(row) : null;
}

/**
 * Redeems a code once. Every binding must match: client, redirect address
 * when the client sends one (OAuth 2.1 lets it leave it out), resource, PKCE,
 * expiry, and the link's current credential. Any mismatch spends the code.
 * Replaying a redeemed code ends the connection it made.
 */
export function redeemAgentAuthorizationCode(storage: StorageContext, input: {
  codeHash: string;
  clientId: string;
  redirectUri: string | null;
  resourceHash: string;
  verifierChallenge: string;
  connectionId: string;
  principalId: string;
  profileTokenHash: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  nowMs: number;
  guard: (authorization: AgentAuthorizationRow) => boolean;
}): AgentTokenGrantResult {
  const nowMs = Math.trunc(input.nowMs);
  return storage.tx(() => {
    const row = storage.db.prepare(`SELECT ${AUTHORIZATION_COLUMNS}, a.status, a.code_hash, a.resource_hash,
        a.code_challenge, a.connection_id
      FROM sync_relay_agent_authorizations AS a
      JOIN sync_relay_agent_clients AS client ON client.client_id = a.client_id
      WHERE a.code_hash = ?`).get(input.codeHash);
    if (!row) return { ok: false };
    const authorization = rowToAuthorization(row);
    if (row.status === "redeemed") {
      retireConnections(storage, "connection_id", String(row.connection_id), "retired", nowMs);
      return { ok: false };
    }
    const spend = () => storage.db.prepare("DELETE FROM sync_relay_agent_authorizations WHERE authorization_id = ?")
      .run(authorization.authorizationId);
    const bound =
      row.status === "allowed" &&
      Number(row.expires_at_ms) > nowMs &&
      authorization.clientId === input.clientId &&
      (input.redirectUri === null || authorization.redirectUri === input.redirectUri) &&
      constantTimeHashEqual(input.resourceHash, String(row.resource_hash)) &&
      constantTimeHashEqual(input.verifierChallenge, String(row.code_challenge)) &&
      linkBindingIsCurrent(storage, authorization) &&
      input.guard(authorization);
    if (!bound) {
      spend();
      return { ok: false };
    }
    const principals = Number(storage.db.prepare(`SELECT COUNT(*) AS count FROM sync_relay_link_principals
      WHERE grant_id = ? AND mint_generation = ?`).get(authorization.grantId, authorization.generation)?.count ?? 0);
    // The agent's principal counts against the owner's workspace, as every other link holder's does.
    const principalBytes = linkPrincipalStorageBytes(input.principalId, authorization.grantId, input.profileTokenHash);
    if (principals >= storage.options.linkDiscussionPrincipalLimit ||
        workspaceUsageBytes(storage, authorization.workspaceId) + principalBytes > storage.options.workspaceQuotaBytes) {
      spend();
      return { ok: false };
    }
    storage.db.prepare(`INSERT INTO sync_relay_link_principals (
        principal_id, grant_id, mint_generation, profile_token_hash, display_name, created_at_ms,
        blocked_at_ms, discussion_revision, storage_bytes) VALUES (?, ?, ?, ?, NULL, ?, NULL, 0, ?)`)
      .run(input.principalId, authorization.grantId, authorization.generation, input.profileTokenHash, nowMs,
        principalBytes);
    storage.db.prepare(`INSERT INTO sync_relay_agent_connections (
        connection_id, workspace_id, share_id, grant_id, credential_id, generation, principal_id, client_id,
        reported_name, resource_hash, connected_at_ms, last_action_at_ms, start_seq, status, ended_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL,
        (SELECT COALESCE(MAX(relay_seq), 0) FROM sync_relay_log WHERE workspace_id = ?), 'active', NULL)`)
      .run(input.connectionId, authorization.workspaceId, authorization.shareId, authorization.grantId,
        authorization.credentialId, authorization.generation, input.principalId, authorization.clientId,
        authorization.reportedName, input.resourceHash, nowMs, authorization.workspaceId);
    insertTokens(storage, input.connectionId, input, nowMs);
    storage.db.prepare(`UPDATE sync_relay_agent_authorizations SET status = 'redeemed', connection_id = ?
      WHERE authorization_id = ?`).run(input.connectionId, authorization.authorizationId);
    upsertLinkUsage(storage, authorization.grantId, nowMs);
    return { ok: true, connection: getConnection(storage, input.connectionId)! };
  });
}

/** Rotates a refresh token. Reusing a rotated one ends its connection. */
export function refreshAgentTokens(storage: StorageContext, input: {
  refreshTokenHash: string;
  clientId: string;
  resourceHash: string;
  accessTokenHash: string;
  nextRefreshTokenHash: string;
  nowMs: number;
  guard: (connection: AgentConnectionRow) => boolean;
}): AgentTokenGrantResult {
  const nowMs = Math.trunc(input.nowMs);
  return storage.tx(() => {
    const row = storage.db.prepare(`SELECT ${CONNECTION_COLUMNS}, c.resource_hash, token.used_at_ms
      FROM sync_relay_agent_tokens AS token
      JOIN sync_relay_agent_connections AS c ON c.connection_id = token.connection_id
      WHERE token.token_hash = ? AND token.kind = 'refresh'`).get(input.refreshTokenHash);
    if (!row) return { ok: false };
    const connection = rowToConnection(row);
    if (row.used_at_ms !== null) {
      retireConnections(storage, "connection_id", connection.connectionId, "retired", nowMs);
      return { ok: false };
    }
    if (
      connection.status !== "active" ||
      connection.clientId !== input.clientId ||
      !constantTimeHashEqual(input.resourceHash, String(row.resource_hash)) ||
      !linkBindingIsCurrent(storage, connection) ||
      !input.guard(connection)
    ) {
      return { ok: false };
    }
    storage.db.prepare("UPDATE sync_relay_agent_tokens SET used_at_ms = ? WHERE token_hash = ?").run(nowMs, input.refreshTokenHash);
    // Used refresh tokens stay until the connection ends, so reusing any of them ends it.
    storage.db.prepare(`DELETE FROM sync_relay_agent_tokens WHERE connection_id = ? AND kind = 'access' AND expires_at_ms <= ?`)
      .run(connection.connectionId, nowMs);
    insertTokens(storage, connection.connectionId, { accessTokenHash: input.accessTokenHash, refreshTokenHash: input.nextRefreshTokenHash }, nowMs);
    return { ok: true, connection };
  });
}

function activeConnectionRow(storage: StorageContext, accessTokenHash: string, nowMs: number): Record<string, unknown> | undefined {
  return storage.db.prepare(`SELECT ${CONNECTION_COLUMNS}, c.resource_hash
    FROM sync_relay_agent_tokens AS token
    JOIN sync_relay_agent_connections AS c ON c.connection_id = token.connection_id
    WHERE token.token_hash = ? AND token.kind = 'access' AND token.expires_at_ms > ? AND c.status = 'active'`)
    .get(accessTokenHash, Math.trunc(nowMs));
}

/** Call inside the caller's transaction: the token's active connection, while its link is current. */
function activeAgentConnectionInTransaction(storage: StorageContext, accessTokenHash: string, nowMs: number): AgentConnectionRow | null {
  const row = activeConnectionRow(storage, accessTokenHash, nowMs);
  if (!row) return null;
  const connection = rowToConnection(row);
  return linkBindingIsCurrent(storage, connection) ? connection : null;
}

/** The active connection an unexpired access token belongs to, while its link is current. */
export function authenticateAgentAccessToken(storage: StorageContext, accessTokenHash: string, nowMs: number): AgentConnectionRow | null {
  return storage.readTx(() => activeAgentConnectionInTransaction(storage, accessTokenHash, nowMs));
}

/** An agent's credential on a link route: its access token and the MCP address it was sent to, both hashed. */
export interface AgentAccessCheck {
  accessTokenHash: string;
  resourceHash: string;
}

/**
 * Call inside the caller's transaction. The token is an unexpired access
 * token of an active connection, the request names the address the agent
 * signed in at, and the connection's link is still current.
 */
export function agentAuthorityInTransaction(storage: StorageContext, check: AgentAccessCheck, nowMs: number): AgentConnectionRow | null {
  const row = activeConnectionRow(storage, check.accessTokenHash, nowMs);
  if (!row || !constantTimeHashEqual(check.resourceHash, String(row.resource_hash))) return null;
  const connection = rowToConnection(row);
  return linkBindingIsCurrent(storage, connection) ? connection : null;
}

export function authenticateAgentAuthority(storage: StorageContext, check: AgentAccessCheck, nowMs: number): AgentConnectionRow | null {
  return storage.readTx(() => agentAuthorityInTransaction(storage, check, nowMs));
}

/**
 * Call inside a write's transaction. The agent's authority in the shape a
 * link holder's enrollment has, so the same pause and block checks apply.
 * The principal is the connection's own, never enrolled lazily, and no link
 * session is bound to it.
 */
export function agentWriteAuthorityInTransaction(
  storage: StorageContext,
  check: AgentAccessCheck,
  nowMs: number,
): { connection: AgentConnectionRow; enrollment: LinkEnrollment & { principal: SyncRelayLinkPrincipalRow } } | null {
  const connection = agentAuthorityInTransaction(storage, check, nowMs);
  if (!connection) return null;
  const authority = storage.db.prepare(`SELECT grant.grant_id, grant.share_id, grant.generation AS grant_generation,
      grant.access, share.workspace_id, share.link_writes_paused_at_ms, share.discussion_revision
    FROM sync_relay_share_grants AS grant
    JOIN sync_relay_shares AS share ON share.share_id = grant.share_id
    WHERE grant.grant_id = ? AND grant.share_id = ?`).get(connection.grantId, connection.shareId);
  const principal = storage.getLinkPrincipal(connection.principalId);
  if (!authority || !principal || principal.grantId !== connection.grantId) return null;
  return { connection, enrollment: { authority, principal, sessionPrincipalId: principal.principalId } };
}

/**
 * The one name an agent carries in chat, discussion and Collection writes:
 * the name its client reported, held to a link holder's display-name rules,
 * or "Agent".
 */
export function agentName(reportedName: string | null): string {
  const name = reportedName?.isWellFormed() ? normalizeShareDiscussionDisplayName(reportedName) : null;
  return name?.ok ? name.value : "Agent";
}

export function recordAgentConnectionActionInTransaction(storage: StorageContext, connectionId: string, atMs: number): void {
  const updated = storage.db.prepare(`UPDATE sync_relay_agent_connections
    SET last_action_at_ms = MAX(COALESCE(last_action_at_ms, 0), ?)
    WHERE connection_id = ? AND status = 'active'`).run(Math.trunc(atMs), connectionId);
  if (Number(updated.changes ?? 0) === 1) {
    const grantId = storage.db.prepare("SELECT grant_id FROM sync_relay_agent_connections WHERE connection_id = ?").get(connectionId);
    upsertLinkUsage(storage, String(grantId!.grant_id), atMs);
  }
}

export function recordAgentConnectionAction(storage: StorageContext, connectionId: string, atMs: number): void {
  storage.tx(() => recordAgentConnectionActionInTransaction(storage, connectionId, atMs));
}

/** The link's active connections, newest first. The caller checks the owner. */
export function listAgentConnections(storage: StorageContext, input: {
  workspaceId: string;
  shareId: string;
  grantId: string;
  cursor?: AgentConnectionCursor;
}): AgentConnectionPage {
  const rows = storage.db.prepare(`SELECT ${CONNECTION_COLUMNS} FROM sync_relay_agent_connections AS c
    WHERE c.grant_id = ? AND c.status = 'active' AND c.share_id = ? AND c.workspace_id = ?
      ${input.cursor ? "AND (c.connected_at_ms, c.connection_id) < (?, ?)" : ""}
    ORDER BY c.connected_at_ms DESC, c.connection_id DESC
    LIMIT ${AGENT_CONNECTION_PAGE_SIZE + 1}`)
    .all(input.grantId, input.shareId, input.workspaceId, ...(input.cursor ? [input.cursor.ms, input.cursor.id] : []))
    .map(rowToConnection);
  const connections = rows.slice(0, AGENT_CONNECTION_PAGE_SIZE);
  const last = connections.at(-1);
  return {
    connections,
    nextCursor: rows.length > AGENT_CONNECTION_PAGE_SIZE && last ? { ms: last.connectedAtMs, id: last.connectionId } : null,
  };
}

/** Idempotent: an ended connection stays ended and answers with its row. */
export function disconnectAgentConnection(storage: StorageContext, input: {
  workspaceId: string;
  shareId: string;
  grantId: string;
  connectionId: string;
  nowMs: number;
  guard: () => void;
}): AgentConnectionRow | null {
  return storage.tx(() => {
    input.guard();
    const connection = getConnection(storage, input.connectionId);
    if (!connection || connection.workspaceId !== input.workspaceId || connection.shareId !== input.shareId ||
        connection.grantId !== input.grantId) {
      return null;
    }
    if (connection.status === "active") {
      retireConnections(storage, "connection_id", connection.connectionId, "disconnected", input.nowMs);
    }
    return getConnection(storage, connection.connectionId);
  });
}
