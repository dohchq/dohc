import { agentChannelWireId } from "@dohc/security-contract/chat-wire-ids";
import { normalizeShareDiscussionDisplayName } from "@dohc/security-contract/share-discussion";
import { AGENT_URI_CHAR_LIMIT } from "@dohc/security-contract/wire-patterns";
import { AGENT_HUE_ASSIGNMENT_ORDER, isAgentHue, type AgentHue } from "@dohc/workspace-contracts/agent-hues";
import { nameSlug } from "@dohc/workspace-contracts/names";
import { constantTimeHashEqual } from "../linkSecurity";
import { personalAgentOrigin } from "../relayLogInputs";
import { accountIsFenced, workspaceIsDeleted } from "./accountDeletion";
import {
  AGENT_AUTHORIZATION_CODE_TTL_MS,
  AGENT_AUTHORIZATION_REQUEST_TTL_MS,
  AGENT_CLIENT_NAME_LIMIT,
  AGENT_REDEEMED_AUTHORIZATION_RETENTION_MS,
  AGENT_STATE_CHAR_LIMIT,
  authorizationCodeIsBound,
  getAgentClient,
  insertAgentTokens,
  redirectUriMatches,
  rotateAgentTokens,
  usedRefreshTokenIsRecent,
  type AgentAccessCheck,
} from "./agentConnections";
import type { StorageContext } from "./context";
import { appendLogBatchInTransaction, maxOriginSeq } from "./log";
import { noticePersonalAgentSignedIn } from "./notices";
import { nullableText } from "./rows";
import type { SqliteDb } from "./types";
import { workspaceIsOwnedBy } from "./workspaces";

// A personal agent is an MCP agent signed in as its account's own agent. It
// reaches only workspaces that account owns here, each at a level. Its
// authorizations, connections, and tokens have their own tables: a link
// token is never found here, and a personal token is never found in the link
// tables. Client registration and the token helpers are shared.
//
// Two counters revoke it. The agent's epoch increases on Sign out, Remove,
// and signing in again as that agent. The account's credential fence, in
// Postgres, increases when its password changes. Every authorization and
// connection stores both, and every check compares both.

export const PERSONAL_AGENT_ID = /^p-[a-z2-7]{26}$/u;
export const PERSONAL_AGENT_REACH_LIMIT = 20;
export const PERSONAL_AGENTS_PER_ACCOUNT_LIMIT = 50;
export const PERSONAL_PENDING_AUTHORIZATIONS_PER_WORKSPACE_LIMIT = 32;
export const WORKSPACE_DISPLAY_NAME_LIMIT = 255;
export const PERSONAL_REACH_LEVELS = ["view", "comment", "edit"] as const;
export type PersonalReachLevel = (typeof PERSONAL_REACH_LEVELS)[number];
export type PersonalAgentStatus = "active" | "signed_out" | "removed";

export interface PersonalReachChoice {
  workspaceId: string;
  level: PersonalReachLevel;
}

export interface PersonalReach extends PersonalReachChoice {
  /** The workspace's log head when it entered reach. A wait starts there. */
  startSeq: number;
}

export interface PersonalAgentRow {
  agentId: string;
  ownerUserId: string;
  name: string;
  hue: AgentHue;
  /** The product and version the agent's client reported when it last signed in. dohc can't check them. */
  reportedProduct: string | null;
  reportedVersion: string | null;
  status: PersonalAgentStatus;
  epoch: number;
  createdAtMs: number;
  /** When the agent last signed in. Null for an agent whose last sign-in the relay didn't record. */
  signedInAtMs: number | null;
  lastActionAtMs: number | null;
  reach: PersonalReach[];
}

export interface PersonalAuthorizationRow {
  authorizationId: string;
  clientId: string;
  /** The workspace in the address the agent signed in at. The consent page starts there. */
  workspaceId: string;
  redirectUri: string;
  state: string | null;
  expiresAtMs: number;
  reportedName: string | null;
}

export interface PersonalConnectionRow {
  connectionId: string;
  agentId: string;
  ownerUserId: string;
  clientId: string;
  agentEpoch: number;
  fenceEpoch: number;
}

export type PersonalAgentChoice = { kind: "new"; name: string } | { kind: "existing"; agentId: string };

export type PersonalTokenGrant =
  | { ok: true; connection: PersonalConnectionRow; newlyReached: string[] }
  // A replayed code or refresh token ends its connection; its running work must end too.
  | { ok: false; endedConnectionId?: string };

export function initializePersonalAgentSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_personal_agents (
      agent_id TEXT PRIMARY KEY CHECK (length(agent_id) = 28 AND agent_id GLOB 'p-*'),
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL CHECK (length(name) >= 1),
      hue TEXT NOT NULL,
      reported_product TEXT CHECK (reported_product IS NULL OR length(reported_product) BETWEEN 1 AND ${AGENT_CLIENT_NAME_LIMIT}),
      status TEXT NOT NULL CHECK (status IN ('active', 'signed_out', 'removed')),
      epoch INTEGER NOT NULL CHECK (epoch >= 1),
      created_at_ms INTEGER NOT NULL,
      last_action_at_ms INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_personal_agents_owner
      ON sync_relay_personal_agents(owner_user_id, created_at_ms, agent_id);

    CREATE TABLE IF NOT EXISTS sync_relay_personal_agent_reach (
      agent_id TEXT NOT NULL REFERENCES sync_relay_personal_agents(agent_id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      level TEXT NOT NULL CHECK (level IN ('view', 'comment', 'edit')),
      start_seq INTEGER NOT NULL CHECK (start_seq >= 0),
      PRIMARY KEY (agent_id, workspace_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_personal_agent_reach_workspace
      ON sync_relay_personal_agent_reach(workspace_id, agent_id);

    CREATE TABLE IF NOT EXISTS sync_relay_personal_agent_authorizations (
      authorization_id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL UNIQUE,
      code_hash TEXT UNIQUE,
      client_id TEXT NOT NULL REFERENCES sync_relay_agent_clients(client_id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      resource_hash TEXT NOT NULL,
      redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND ${AGENT_URI_CHAR_LIMIT}),
      code_challenge TEXT NOT NULL CHECK (length(code_challenge) = 43),
      state TEXT CHECK (state IS NULL OR length(state) BETWEEN 1 AND ${AGENT_STATE_CHAR_LIMIT}),
      status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'redeemed')),
      owner_user_id TEXT,
      fence_epoch INTEGER,
      agent_id TEXT REFERENCES sync_relay_personal_agents(agent_id) ON DELETE CASCADE,
      agent_epoch INTEGER,
      agent_name TEXT,
      reach_json TEXT CHECK (reach_json IS NULL OR json_valid(reach_json)),
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      connection_id TEXT,
      CHECK (expires_at_ms > created_at_ms),
      CHECK ((status = 'pending') = (code_hash IS NULL)),
      CHECK ((status = 'pending') = (owner_user_id IS NULL)),
      CHECK ((owner_user_id IS NULL) = (fence_epoch IS NULL) AND (owner_user_id IS NULL) = (reach_json IS NULL)),
      CHECK ((agent_id IS NULL) = (agent_epoch IS NULL)),
      CHECK (status = 'pending' OR ((agent_id IS NULL) != (agent_name IS NULL))),
      CHECK ((status = 'redeemed') = (connection_id IS NOT NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_personal_agent_authorizations_workspace
      ON sync_relay_personal_agent_authorizations(workspace_id, status, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_sync_relay_personal_agent_authorizations_owner
      ON sync_relay_personal_agent_authorizations(owner_user_id, fence_epoch);
    CREATE INDEX IF NOT EXISTS idx_sync_relay_personal_agent_authorizations_agent
      ON sync_relay_personal_agent_authorizations(agent_id);
    CREATE INDEX IF NOT EXISTS idx_sync_relay_personal_agent_authorizations_client
      ON sync_relay_personal_agent_authorizations(client_id);

    CREATE TABLE IF NOT EXISTS sync_relay_personal_agent_connections (
      connection_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES sync_relay_personal_agents(agent_id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      resource_hash TEXT NOT NULL,
      agent_epoch INTEGER NOT NULL CHECK (agent_epoch >= 1),
      fence_epoch INTEGER NOT NULL CHECK (fence_epoch >= 0),
      connected_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_personal_agent_connections_agent
      ON sync_relay_personal_agent_connections(agent_id);
    CREATE INDEX IF NOT EXISTS idx_sync_relay_personal_agent_connections_owner
      ON sync_relay_personal_agent_connections(owner_user_id, fence_epoch);
    CREATE INDEX IF NOT EXISTS idx_sync_relay_personal_agent_connections_client
      ON sync_relay_personal_agent_connections(client_id);

    CREATE TABLE IF NOT EXISTS sync_relay_personal_agent_tokens (
      token_hash TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL
        REFERENCES sync_relay_personal_agent_connections(connection_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
      issued_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER,
      used_at_ms INTEGER,
      CHECK ((kind = 'access') = (expires_at_ms IS NOT NULL)),
      CHECK (kind = 'refresh' OR used_at_ms IS NULL)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_personal_agent_tokens_connection
      ON sync_relay_personal_agent_tokens(connection_id, kind, issued_at_ms);

    -- The threads a personal agent posted in. A wait reads one row per
    -- candidate message, by primary key.
    CREATE TABLE IF NOT EXISTS sync_relay_personal_agent_threads (
      agent_id TEXT NOT NULL REFERENCES sync_relay_personal_agents(agent_id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL CHECK (length(thread_id) >= 1),
      PRIMARY KEY (agent_id, workspace_id, thread_id)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_personal_agent_threads_workspace
      ON sync_relay_personal_agent_threads(workspace_id);

    -- Increases on every sign-in, rename, color, reach, or status change, so
    -- each computer refetches the roster only when it changed.
    CREATE TABLE IF NOT EXISTS sync_relay_personal_agent_rosters (
      owner_user_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 1)
    ) STRICT;

    -- How far the relay has read Postgres's credential fences, for catch-up
    -- after a restart or a dropped LISTEN.
    CREATE TABLE IF NOT EXISTS sync_relay_credential_fence_position (
      position_id INTEGER PRIMARY KEY CHECK (position_id = 1),
      changed_at_ms INTEGER NOT NULL
    ) STRICT;
  `);
}

const AGENT_COLUMNS = `agent_id, owner_user_id, name, hue, reported_product, status, epoch, created_at_ms, last_action_at_ms,
  reported_version, signed_in_at_ms`;

function reachOf(storage: StorageContext, agentId: string): PersonalReach[] {
  return storage.db.prepare(`SELECT workspace_id, level, start_seq FROM sync_relay_personal_agent_reach
    WHERE agent_id = ? ORDER BY workspace_id`).all(agentId).map(row => ({
    workspaceId: String(row.workspace_id),
    level: String(row.level) as PersonalReachLevel,
    startSeq: Number(row.start_seq),
  }));
}

function rowToAgent(storage: StorageContext, row: Record<string, unknown>): PersonalAgentRow {
  const agentId = String(row.agent_id);
  return {
    agentId,
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    hue: String(row.hue) as AgentHue,
    reportedProduct: nullableText(row.reported_product),
    reportedVersion: nullableText(row.reported_version),
    status: String(row.status) as PersonalAgentStatus,
    epoch: Number(row.epoch),
    createdAtMs: Number(row.created_at_ms),
    signedInAtMs: row.signed_in_at_ms === null ? null : Number(row.signed_in_at_ms),
    lastActionAtMs: row.last_action_at_ms === null ? null : Number(row.last_action_at_ms),
    reach: reachOf(storage, agentId),
  };
}

function agentById(storage: StorageContext, agentId: string): PersonalAgentRow | null {
  const row = storage.db.prepare(`SELECT ${AGENT_COLUMNS} FROM sync_relay_personal_agents WHERE agent_id = ?`).get(agentId);
  return row ? rowToAgent(storage, row) : null;
}

function bumpRoster(storage: StorageContext, ownerUserId: string): number {
  const row = storage.db.prepare(`INSERT INTO sync_relay_personal_agent_rosters (owner_user_id, revision) VALUES (?, 1)
    ON CONFLICT (owner_user_id) DO UPDATE SET revision = revision + 1 RETURNING revision`).get(ownerUserId);
  return Number(row?.revision);
}

export function personalRosterRevision(storage: StorageContext, ownerUserId: string): number {
  const row = storage.db.prepare("SELECT revision FROM sync_relay_personal_agent_rosters WHERE owner_user_id = ?").get(ownerUserId);
  return row ? Number(row.revision) : 0;
}

/** A personal agent's name, held to a link holder's display-name rules. */
export function personalAgentName(value: unknown): string | null {
  if (typeof value !== "string" || !value.isWellFormed()) return null;
  const name = normalizeShareDiscussionDisplayName(value);
  return name.ok ? name.value : null;
}

/** Owned here by the account, which isn't being deleted, and not deleted. */
export function ownsWorkspace(storage: StorageContext, ownerUserId: string, workspaceId: string): boolean {
  return !accountIsFenced(storage, ownerUserId) && !workspaceIsDeleted(storage, workspaceId) &&
    workspaceIsOwnedBy(storage, workspaceId, ownerUserId);
}

function reachIsOwned(storage: StorageContext, ownerUserId: string, reach: readonly PersonalReachChoice[]): boolean {
  return reach.length <= PERSONAL_AGENT_REACH_LIMIT &&
    new Set(reach.map(entry => entry.workspaceId)).size === reach.length &&
    reach.every(entry => (PERSONAL_REACH_LEVELS as readonly string[]).includes(entry.level) &&
      ownsWorkspace(storage, ownerUserId, entry.workspaceId));
}

/** Replaces the agent's reach. A workspace new to reach starts at its log head. Returns those workspaces. */
function writeReach(storage: StorageContext, agentId: string, reach: readonly PersonalReachChoice[]): string[] {
  const held = new Set(reachOf(storage, agentId).map(entry => entry.workspaceId));
  const kept = new Set(reach.map(entry => entry.workspaceId));
  for (const workspaceId of held) {
    if (!kept.has(workspaceId)) {
      storage.db.prepare("DELETE FROM sync_relay_personal_agent_reach WHERE agent_id = ? AND workspace_id = ?").run(agentId, workspaceId);
    }
  }
  const added: string[] = [];
  for (const entry of reach) {
    if (held.has(entry.workspaceId)) {
      storage.db.prepare("UPDATE sync_relay_personal_agent_reach SET level = ? WHERE agent_id = ? AND workspace_id = ?")
        .run(entry.level, agentId, entry.workspaceId);
      continue;
    }
    storage.db.prepare(`INSERT INTO sync_relay_personal_agent_reach (agent_id, workspace_id, level, start_seq)
      VALUES (?, ?, ?, (SELECT COALESCE(MAX(relay_seq), 0) FROM sync_relay_log WHERE workspace_id = ?))`)
      .run(agentId, entry.workspaceId, entry.level, entry.workspaceId);
    added.push(entry.workspaceId);
  }
  return added;
}

/**
 * Appends the agent's DM in each workspace that just entered its reach, from
 * the agent's own origin. Every computer that holds the DM already converges
 * on its wire id, so a repeat costs one small op.
 */
function appendPersonalDms(storage: StorageContext, agentId: string, workspaceIds: readonly string[], nowMs: number): void {
  if (workspaceIds.length === 0) return;
  const name = String(storage.db.prepare("SELECT name FROM sync_relay_personal_agents WHERE agent_id = ?").get(agentId)?.name);
  const originId = personalAgentOrigin(agentId);
  const payloadJson = JSON.stringify({
    channelId: `personal-dm:${agentId}`,
    // The engine names a chat only with a name that has a slug.
    name: nameSlug(name) ? name : "Agent",
    slug: `my-agent-${agentId}`,
    kind: "agent",
    createdAtMs: nowMs,
    wireId: agentChannelWireId(agentId),
  });
  for (const workspaceId of workspaceIds) {
    appendLogBatchInTransaction(storage, { workspaceId, originId, ops: [{
      originSeq: maxOriginSeq(storage, workspaceId, originId) + 1, opKind: "chat.channel.create", payloadJson, recordedAtMs: nowMs,
    }] });
  }
}

/** Ends the agent's connections and tokens, and deletes its pending authorizations and unredeemed codes. */
function endAgentCredentials(storage: StorageContext, agentId: string): void {
  storage.db.prepare(`DELETE FROM sync_relay_personal_agent_tokens WHERE connection_id IN (
    SELECT connection_id FROM sync_relay_personal_agent_connections WHERE agent_id = ?)`).run(agentId);
  storage.db.prepare("DELETE FROM sync_relay_personal_agent_connections WHERE agent_id = ?").run(agentId);
  storage.db.prepare("DELETE FROM sync_relay_personal_agent_authorizations WHERE agent_id = ? AND status != 'redeemed'").run(agentId);
}

function deleteConnection(storage: StorageContext, connectionId: string): void {
  storage.db.prepare("DELETE FROM sync_relay_personal_agent_tokens WHERE connection_id = ?").run(connectionId);
  storage.db.prepare("DELETE FROM sync_relay_personal_agent_connections WHERE connection_id = ?").run(connectionId);
}

function reachWorkspaces(storage: StorageContext, agentIds: readonly string[]): string[] {
  const workspaces = new Set<string>();
  for (const agentId of agentIds) for (const entry of reachOf(storage, agentId)) workspaces.add(entry.workspaceId);
  return [...workspaces];
}

// --- sign-in -----------------------------------------------------------------

export function beginPersonalAuthorization(storage: StorageContext, input: {
  authorizationId: string;
  requestHash: string;
  clientId: string;
  redirectUri: string;
  resourceHash: string;
  codeChallenge: string;
  state: string | null;
  workspaceId: string;
  nowMs: number;
}): boolean {
  const nowMs = Math.trunc(input.nowMs);
  return storage.tx(() => {
    const workspace = storage.db.prepare("SELECT owner_user_id FROM sync_relay_workspaces WHERE workspace_id = ?").get(input.workspaceId);
    if (!workspace || !ownsWorkspace(storage, String(workspace.owner_user_id), input.workspaceId)) return false;
    const client = getAgentClient(storage, input.clientId);
    if (!client || !client.redirectUris.some((registered) => redirectUriMatches(registered, input.redirectUri))) return false;
    storage.db.prepare(`DELETE FROM sync_relay_personal_agent_authorizations
      WHERE (status != 'redeemed' AND expires_at_ms <= ?) OR (status = 'redeemed' AND expires_at_ms <= ?)`)
      .run(nowMs, nowMs - AGENT_REDEEMED_AUTHORIZATION_RETENTION_MS);
    storage.db.prepare(`DELETE FROM sync_relay_personal_agent_authorizations WHERE authorization_id IN (
        SELECT authorization_id FROM sync_relay_personal_agent_authorizations
        WHERE workspace_id = ? AND status = 'pending'
        ORDER BY created_at_ms DESC, authorization_id DESC
        LIMIT -1 OFFSET ?)`)
      .run(input.workspaceId, PERSONAL_PENDING_AUTHORIZATIONS_PER_WORKSPACE_LIMIT - 1);
    storage.db.prepare(`INSERT INTO sync_relay_personal_agent_authorizations (
        authorization_id, request_hash, code_hash, client_id, workspace_id, resource_hash, redirect_uri,
        code_challenge, state, status, created_at_ms, expires_at_ms
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(input.authorizationId, input.requestHash, input.clientId, input.workspaceId, input.resourceHash,
        input.redirectUri, input.codeChallenge, input.state, nowMs, nowMs + AGENT_AUTHORIZATION_REQUEST_TTL_MS);
    return true;
  });
}

function readPending(storage: StorageContext, requestHash: string, nowMs: number): PersonalAuthorizationRow | null {
  const row = storage.db.prepare(`SELECT a.authorization_id, a.client_id, a.workspace_id, a.redirect_uri, a.state,
      a.expires_at_ms, client.reported_name
    FROM sync_relay_personal_agent_authorizations AS a
    JOIN sync_relay_agent_clients AS client ON client.client_id = a.client_id
    WHERE a.request_hash = ? AND a.status = 'pending' AND a.expires_at_ms > ?`).get(requestHash, Math.trunc(nowMs));
  if (!row) return null;
  return {
    authorizationId: String(row.authorization_id),
    clientId: String(row.client_id),
    workspaceId: String(row.workspace_id),
    redirectUri: String(row.redirect_uri),
    state: nullableText(row.state),
    expiresAtMs: Number(row.expires_at_ms),
    reportedName: nullableText(row.reported_name),
  };
}

/** The consent screen's read. It never changes the request. */
export function readPersonalAuthorization(storage: StorageContext, requestHash: string, nowMs: number): PersonalAuthorizationRow | null {
  return storage.readTx(() => readPending(storage, requestHash, nowMs));
}

/** Cancel removes the request; its id is spent. */
export function cancelPersonalAuthorization(storage: StorageContext, requestHash: string, nowMs: number): PersonalAuthorizationRow | null {
  return storage.tx(() => {
    const pending = readPending(storage, requestHash, nowMs);
    if (pending) storage.db.prepare("DELETE FROM sync_relay_personal_agent_authorizations WHERE authorization_id = ?").run(pending.authorizationId);
    return pending;
  });
}

/**
 * Allow turns the request into a single-use code bound to the account, its
 * fence epoch read at consent, the chosen reach, and, when signing in again,
 * the agent's epoch. Every workspace in the reach must be the account's.
 */
export function allowPersonalAuthorization(storage: StorageContext, input: {
  requestHash: string;
  ownerUserId: string;
  fenceEpoch: number;
  agent: PersonalAgentChoice;
  reach: readonly PersonalReachChoice[];
  codeHash: string;
  nowMs: number;
}): PersonalAuthorizationRow | null {
  const nowMs = Math.trunc(input.nowMs);
  return storage.tx(() => {
    const pending = readPending(storage, input.requestHash, nowMs);
    if (!pending || input.reach.length === 0 || !reachIsOwned(storage, input.ownerUserId, input.reach)) return null;
    let agentId: string | null = null;
    let agentEpoch: number | null = null;
    let agentName: string | null = null;
    if (input.agent.kind === "existing") {
      const agent = agentById(storage, input.agent.agentId);
      if (!agent || agent.ownerUserId !== input.ownerUserId || agent.status === "removed") return null;
      agentId = agent.agentId;
      agentEpoch = agent.epoch;
    } else {
      agentName = personalAgentName(input.agent.name);
      if (agentName === null) return null;
    }
    storage.db.prepare(`UPDATE sync_relay_personal_agent_authorizations
      SET status = 'allowed', code_hash = ?, expires_at_ms = ?, owner_user_id = ?, fence_epoch = ?,
        agent_id = ?, agent_epoch = ?, agent_name = ?, reach_json = ?
      WHERE authorization_id = ? AND status = 'pending'`)
      .run(input.codeHash, nowMs + AGENT_AUTHORIZATION_CODE_TTL_MS, input.ownerUserId, input.fenceEpoch,
        agentId, agentEpoch, agentName,
        JSON.stringify(input.reach.map(entry => ({ workspaceId: entry.workspaceId, level: entry.level }))),
        pending.authorizationId);
    return pending;
  });
}

function parseReach(json: unknown): PersonalReachChoice[] {
  const value = JSON.parse(String(json)) as unknown;
  if (!Array.isArray(value)) return [];
  return value.map(entry => ({
    workspaceId: String((entry as Record<string, unknown>).workspaceId),
    level: String((entry as Record<string, unknown>).level) as PersonalReachLevel,
  }));
}

/** The account whose credential this is, so the caller can read its fence before checking it. */
export function personalCredentialOwner(
  storage: StorageContext,
  credential: { kind: "code" | "refresh" | "access"; hash: string },
): string | null {
  const row = credential.kind === "code"
    ? storage.db.prepare("SELECT owner_user_id FROM sync_relay_personal_agent_authorizations WHERE code_hash = ?").get(credential.hash)
    : storage.db.prepare(`SELECT c.owner_user_id FROM sync_relay_personal_agent_tokens AS token
        JOIN sync_relay_personal_agent_connections AS c ON c.connection_id = token.connection_id
        WHERE token.token_hash = ? AND token.kind = ?`).get(credential.hash, credential.kind);
  return row && row.owner_user_id !== null ? String(row.owner_user_id) : null;
}

/**
 * Redeems a code once, in one transaction. It checks the code's bindings,
 * the account's fence against `fenceEpoch` read just before, that the account
 * still owns every workspace, and, when signing in again, the agent's epoch.
 * It then creates or reuses the agent, writes its reach, and issues the
 * connection's tokens. Signing in again ends the agent's other connections.
 * Any mismatch spends the code; replaying a redeemed code ends its connection.
 */
export function redeemPersonalAuthorizationCode(storage: StorageContext, input: {
  codeHash: string;
  clientId: string;
  redirectUri: string | null;
  resourceHash: string;
  verifierChallenge: string;
  fenceEpoch: number;
  newAgentId: string;
  connectionId: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  nowMs: number;
}): PersonalTokenGrant {
  const nowMs = Math.trunc(input.nowMs);
  return storage.tx(() => {
    const row = storage.db.prepare(`SELECT a.*, client.reported_name, client.reported_version
      FROM sync_relay_personal_agent_authorizations AS a
      JOIN sync_relay_agent_clients AS client ON client.client_id = a.client_id
      WHERE a.code_hash = ?`).get(input.codeHash);
    if (!row) return { ok: false };
    if (row.status === "redeemed") {
      const endedConnectionId = String(row.connection_id);
      deleteConnection(storage, endedConnectionId);
      signOutAgentsWithoutConnections(storage, String(row.owner_user_id));
      return { ok: false, endedConnectionId };
    }
    const spend = (): { ok: false } => {
      storage.db.prepare("DELETE FROM sync_relay_personal_agent_authorizations WHERE authorization_id = ?").run(String(row.authorization_id));
      return { ok: false };
    };
    if (!authorizationCodeIsBound(row, input, nowMs) || Number(row.fence_epoch) !== input.fenceEpoch) return spend();
    const ownerUserId = String(row.owner_user_id);
    const reach = parseReach(row.reach_json);
    if (reach.length === 0 || !reachIsOwned(storage, ownerUserId, reach)) return spend();

    let agentId: string;
    if (row.agent_id !== null) {
      const agent = agentById(storage, String(row.agent_id));
      if (!agent || agent.ownerUserId !== ownerUserId || agent.status === "removed" || agent.epoch !== Number(row.agent_epoch)) {
        return spend();
      }
      agentId = agent.agentId;
    } else {
      const agents = storage.db.prepare(`SELECT hue FROM sync_relay_personal_agents
        WHERE owner_user_id = ? AND status != 'removed'`).all(ownerUserId).map(agent => String(agent.hue));
      if (agents.length >= PERSONAL_AGENTS_PER_ACCOUNT_LIMIT || !PERSONAL_AGENT_ID.test(input.newAgentId)) return spend();
      const hue = AGENT_HUE_ASSIGNMENT_ORDER.find(candidate => !agents.includes(candidate)) ?? AGENT_HUE_ASSIGNMENT_ORDER[0];
      storage.db.prepare(`INSERT INTO sync_relay_personal_agents (${AGENT_COLUMNS})
        VALUES (?, ?, ?, ?, NULL, 'signed_out', 1, ?, NULL, NULL, NULL)`)
        .run(input.newAgentId, ownerUserId, String(row.agent_name), hue, nowMs);
      agentId = input.newAgentId;
    }

    storage.db.prepare(`UPDATE sync_relay_personal_agent_authorizations SET status = 'redeemed', connection_id = ?
      WHERE authorization_id = ?`).run(input.connectionId, String(row.authorization_id));
    // Signing in again ends what the agent held, under the epoch it had.
    endAgentCredentials(storage, agentId);
    const agentEpoch = row.agent_id === null ? 1 : Number(row.agent_epoch) + 1;
    // What the client reported replaces what an earlier sign-in reported, so the product and version stay a pair.
    storage.db.prepare(`UPDATE sync_relay_personal_agents SET status = 'active', epoch = ?, reported_product = ?,
        reported_version = ?, signed_in_at_ms = ?, last_action_at_ms = ?
      WHERE agent_id = ?`)
      .run(agentEpoch, nullableText(row.reported_name), nullableText(row.reported_version), nowMs, nowMs, agentId);
    const newlyReached = writeReach(storage, agentId, reach);
    appendPersonalDms(storage, agentId, newlyReached, nowMs);
    storage.db.prepare(`INSERT INTO sync_relay_personal_agent_connections (
        connection_id, agent_id, owner_user_id, client_id, resource_hash, agent_epoch, fence_epoch, connected_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.connectionId, agentId, ownerUserId, input.clientId, input.resourceHash, agentEpoch, input.fenceEpoch, nowMs);
    insertAgentTokens(storage, "sync_relay_personal_agent_tokens", input.connectionId, input, nowMs);
    bumpRoster(storage, ownerUserId);
    const address = String(row.workspace_id);
    noticePersonalAgentSignedIn(storage, {
      ownerUserId,
      // The address the agent signed in at, or a workspace in reach once the account no longer owns it.
      workspaceId: ownsWorkspace(storage, ownerUserId, address) ? address : reach[0]!.workspaceId,
      connectionId: input.connectionId,
      agentId,
      agentName: String(storage.db.prepare("SELECT name FROM sync_relay_personal_agents WHERE agent_id = ?").get(agentId)?.name),
      nowMs,
    });
    return {
      ok: true,
      connection: {
        connectionId: input.connectionId, agentId, ownerUserId, clientId: input.clientId, agentEpoch, fenceEpoch: input.fenceEpoch,
      },
      newlyReached,
    };
  });
}

const CONNECTION_CHECK = `c.connection_id, c.agent_id, c.owner_user_id, c.client_id, c.resource_hash, c.agent_epoch,
  c.fence_epoch, agent.status AS agent_status, agent.epoch AS current_agent_epoch`;

function rowToConnection(row: Record<string, unknown>): PersonalConnectionRow {
  return {
    connectionId: String(row.connection_id),
    agentId: String(row.agent_id),
    ownerUserId: String(row.owner_user_id),
    clientId: String(row.client_id),
    agentEpoch: Number(row.agent_epoch),
    fenceEpoch: Number(row.fence_epoch),
  };
}

/** The agent is active at the connection's epoch, the account at its fence and not being deleted. */
function connectionIsCurrent(storage: StorageContext, row: Record<string, unknown>, fenceEpoch: number): boolean {
  return row.agent_status === "active" && Number(row.current_agent_epoch) === Number(row.agent_epoch) &&
    Number(row.fence_epoch) === fenceEpoch && !accountIsFenced(storage, String(row.owner_user_id));
}

/**
 * The agent's reach in one workspace its account still owns, or null. The
 * route checks the level it needs.
 */
export function personalReachIn(storage: StorageContext, connection: PersonalConnectionRow, workspaceId: string): PersonalReach | null {
  const row = storage.db.prepare(`SELECT level, start_seq FROM sync_relay_personal_agent_reach
    WHERE agent_id = ? AND workspace_id = ?`).get(connection.agentId, workspaceId);
  if (!row || !ownsWorkspace(storage, connection.ownerUserId, workspaceId)) return null;
  return { workspaceId, level: String(row.level) as PersonalReachLevel, startSeq: Number(row.start_seq) };
}

/** Every workspace in the agent's reach that its account still owns. */
export function ownedPersonalReach(storage: StorageContext, connection: PersonalConnectionRow): PersonalReach[] {
  return reachOf(storage, connection.agentId).filter(entry => ownsWorkspace(storage, connection.ownerUserId, entry.workspaceId));
}

/** Rotates a refresh token of a current connection. Reusing a recently used one ends the connection. */
export function refreshPersonalTokens(storage: StorageContext, input: {
  refreshTokenHash: string;
  clientId: string;
  resourceHash: string;
  fenceEpoch: number;
  accessTokenHash: string;
  nextRefreshTokenHash: string;
  nowMs: number;
}): PersonalTokenGrant {
  const nowMs = Math.trunc(input.nowMs);
  return storage.tx(() => {
    const row = storage.db.prepare(`SELECT ${CONNECTION_CHECK}, token.used_at_ms
      FROM sync_relay_personal_agent_tokens AS token
      JOIN sync_relay_personal_agent_connections AS c ON c.connection_id = token.connection_id
      JOIN sync_relay_personal_agents AS agent ON agent.agent_id = c.agent_id
      WHERE token.token_hash = ? AND token.kind = 'refresh'`).get(input.refreshTokenHash);
    if (!row) return { ok: false };
    const connection = rowToConnection(row);
    if (row.used_at_ms !== null) {
      if (!usedRefreshTokenIsRecent(row.used_at_ms, nowMs)) return { ok: false };
      deleteConnection(storage, connection.connectionId);
      signOutAgentsWithoutConnections(storage, connection.ownerUserId);
      return { ok: false, endedConnectionId: connection.connectionId };
    }
    if (connection.clientId !== input.clientId || !constantTimeHashEqual(input.resourceHash, String(row.resource_hash)) ||
        !connectionIsCurrent(storage, row, input.fenceEpoch)) {
      return { ok: false };
    }
    rotateAgentTokens(storage, "sync_relay_personal_agent_tokens", connection.connectionId, input, nowMs);
    return { ok: true, connection, newlyReached: [] };
  });
}

/**
 * Every check a personal agent's request needs before its route checks the
 * workspace: an unexpired access token, its connection, the agent active at
 * the connection's epoch, the account's fence equal to the connection's, the
 * account not being deleted, and the address the agent signed in at. It
 * opens no transaction, so inside a write it reads the write's.
 */
export function readPersonalAuthority(
  storage: StorageContext,
  check: AgentAccessCheck,
  fenceEpoch: number,
  nowMs: number,
): PersonalConnectionRow | null {
  const row = storage.db.prepare(`SELECT ${CONNECTION_CHECK}
    FROM sync_relay_personal_agent_tokens AS token
    JOIN sync_relay_personal_agent_connections AS c ON c.connection_id = token.connection_id
    JOIN sync_relay_personal_agents AS agent ON agent.agent_id = c.agent_id
    WHERE token.token_hash = ? AND token.kind = 'access' AND token.expires_at_ms > ?`)
    .get(check.accessTokenHash, Math.trunc(nowMs));
  if (!row || !constantTimeHashEqual(check.resourceHash, String(row.resource_hash)) || !connectionIsCurrent(storage, row, fenceEpoch)) {
    return null;
  }
  return rowToConnection(row);
}

// --- the owner's controls ------------------------------------------------------

export interface PersonalRoster {
  revision: number;
  agents: PersonalAgentRow[];
  /** The workspaces the account owns here, which a reach can name. */
  workspaces: { workspaceId: string; name: string | null }[];
}

export function listPersonalAgents(storage: StorageContext, ownerUserId: string): PersonalRoster {
  return storage.readTx(() => ({
    revision: personalRosterRevision(storage, ownerUserId),
    agents: storage.db.prepare(`SELECT ${AGENT_COLUMNS} FROM sync_relay_personal_agents
      WHERE owner_user_id = ? AND status != 'removed' ORDER BY created_at_ms, agent_id`).all(ownerUserId)
      .map(row => rowToAgent(storage, row)),
    workspaces: accountIsFenced(storage, ownerUserId) ? [] : storage.db.prepare(`SELECT workspace_id, display_name
      FROM sync_relay_workspaces WHERE owner_user_id = ? ORDER BY workspace_id`).all(ownerUserId)
      .filter(row => !workspaceIsDeleted(storage, String(row.workspace_id)))
      .map(row => ({ workspaceId: String(row.workspace_id), name: nullableText(row.display_name) })),
  }));
}

export type PersonalAgentChange =
  | { kind: "name"; name: string }
  | { kind: "hue"; hue: AgentHue }
  | { kind: "reach"; reach: readonly PersonalReachChoice[] }
  | { kind: "sign-out" }
  | { kind: "remove" }
  | { kind: "restore" };

export type PersonalAgentChangeResult =
  | {
    ok: true;
    agent: PersonalAgentRow;
    revision: number;
    /** Running work here ends: the agent's credentials ended, or the workspace left its reach. */
    endedWorkspaceIds: string[];
    /** Parked waits here re-check, and pick up a workspace new to reach. */
    wakeWorkspaceIds: string[];
  }
  | { ok: false; reason: "not-found" | "conflict" | "invalid" };

/**
 * One owner change, in one transaction with the roster revision. Sign out
 * and Remove increase the agent's epoch and end its credentials; any reach
 * change deletes its pending authorizations and unredeemed codes, so a code
 * approved before the change can't restore the old reach.
 */
export function changePersonalAgent(storage: StorageContext, input: {
  ownerUserId: string;
  agentId: string;
  change: PersonalAgentChange;
  nowMs: number;
}): PersonalAgentChangeResult {
  return storage.tx(() => {
    const agent = agentById(storage, input.agentId);
    if (!agent || agent.ownerUserId !== input.ownerUserId || accountIsFenced(storage, input.ownerUserId) ||
        (agent.status === "removed") !== (input.change.kind === "restore")) {
      return { ok: false, reason: "not-found" };
    }
    const before = agent.reach.map(entry => entry.workspaceId);
    let ended: string[] = [];
    let added: string[] = [];
    switch (input.change.kind) {
      case "name": {
        const name = personalAgentName(input.change.name);
        if (name === null) return { ok: false, reason: "invalid" };
        storage.db.prepare("UPDATE sync_relay_personal_agents SET name = ? WHERE agent_id = ?").run(name, agent.agentId);
        break;
      }
      case "hue":
        if (!isAgentHue(input.change.hue)) return { ok: false, reason: "invalid" };
        storage.db.prepare("UPDATE sync_relay_personal_agents SET hue = ? WHERE agent_id = ?").run(input.change.hue, agent.agentId);
        break;
      case "reach": {
        if (!reachIsOwned(storage, input.ownerUserId, input.change.reach)) return { ok: false, reason: "invalid" };
        const kept = new Set(input.change.reach.map(entry => entry.workspaceId));
        ended = before.filter(workspaceId => !kept.has(workspaceId));
        added = writeReach(storage, agent.agentId, input.change.reach);
        appendPersonalDms(storage, agent.agentId, added, Math.trunc(input.nowMs));
        storage.db.prepare("DELETE FROM sync_relay_personal_agent_authorizations WHERE agent_id = ? AND status != 'redeemed'")
          .run(agent.agentId);
        break;
      }
      case "sign-out":
      case "remove":
        if (input.change.kind === "remove" && agent.status !== "signed_out") return { ok: false, reason: "conflict" };
        endAgentCredentials(storage, agent.agentId);
        storage.db.prepare("UPDATE sync_relay_personal_agents SET status = ?, epoch = epoch + 1 WHERE agent_id = ?")
          .run(input.change.kind === "remove" ? "removed" : "signed_out", agent.agentId);
        ended = before;
        break;
      case "restore":
        storage.db.prepare("UPDATE sync_relay_personal_agents SET status = 'signed_out' WHERE agent_id = ?").run(agent.agentId);
        break;
    }
    const revision = bumpRoster(storage, input.ownerUserId);
    return {
      ok: true, agent: agentById(storage, agent.agentId)!, revision, endedWorkspaceIds: ended, wakeWorkspaceIds: [...before, ...added],
    };
  });
}

// --- revocation ----------------------------------------------------------------

/**
 * Signs out the account's active agents left with no connection. Each keeps
 * its epoch, so a sign-in the owner approved for it still redeems until its
 * code expires. Bumps the roster once if any changed.
 */
function signOutAgentsWithoutConnections(storage: StorageContext, ownerUserId: string): void {
  const signedOut = storage.db.prepare(`UPDATE sync_relay_personal_agents SET status = 'signed_out'
    WHERE owner_user_id = ? AND status = 'active'
      AND NOT EXISTS (SELECT 1 FROM sync_relay_personal_agent_connections AS c
        WHERE c.agent_id = sync_relay_personal_agents.agent_id)`).run(ownerUserId);
  if (signedOut.changes > 0) bumpRoster(storage, ownerUserId);
}

/**
 * After a password change commits at `epoch`: deletes the account's
 * connections, tokens, and unredeemed authorizations from an earlier fence,
 * then signs out each active agent left with no connection. Connections at
 * `epoch` or later stay, and so does their agent's status, so a late notice
 * can't sign out an agent that signed in after the change. Returns the reach
 * of the agents that held the deleted credentials.
 */
export function revokePersonalCredentialsBelowFence(storage: StorageContext, ownerUserId: string, epoch: number): string[] {
  return storage.tx(() => {
    const agentIds = storage.db.prepare(`SELECT agent_id FROM sync_relay_personal_agent_connections
        WHERE owner_user_id = ? AND fence_epoch < ?
      UNION SELECT agent_id FROM sync_relay_personal_agent_authorizations
        WHERE owner_user_id = ? AND fence_epoch < ? AND status != 'redeemed' AND agent_id IS NOT NULL`)
      .all(ownerUserId, epoch, ownerUserId, epoch).map(row => String(row.agent_id));
    storage.db.prepare(`DELETE FROM sync_relay_personal_agent_tokens WHERE connection_id IN (
      SELECT connection_id FROM sync_relay_personal_agent_connections WHERE owner_user_id = ? AND fence_epoch < ?)`)
      .run(ownerUserId, epoch);
    storage.db.prepare("DELETE FROM sync_relay_personal_agent_connections WHERE owner_user_id = ? AND fence_epoch < ?").run(ownerUserId, epoch);
    storage.db.prepare(`DELETE FROM sync_relay_personal_agent_authorizations
      WHERE owner_user_id = ? AND fence_epoch < ? AND status != 'redeemed'`).run(ownerUserId, epoch);
    signOutAgentsWithoutConnections(storage, ownerUserId);
    return reachWorkspaces(storage, agentIds);
  });
}

/** At account deletion's fence: signs out every agent of the account and ends its credentials. */
export function signOutAccountPersonalAgents(storage: StorageContext, ownerUserId: string): string[] {
  return storage.tx(() => {
    const agentIds = storage.db.prepare("SELECT agent_id FROM sync_relay_personal_agents WHERE owner_user_id = ?")
      .all(ownerUserId).map(row => String(row.agent_id));
    for (const agentId of agentIds) endAgentCredentials(storage, agentId);
    storage.db.prepare("DELETE FROM sync_relay_personal_agent_authorizations WHERE owner_user_id = ? AND status != 'redeemed'").run(ownerUserId);
    signOutAgentsWithoutConnections(storage, ownerUserId);
    return reachWorkspaces(storage, agentIds);
  });
}

export function readCredentialFencePosition(storage: StorageContext): number {
  const row = storage.db.prepare("SELECT changed_at_ms FROM sync_relay_credential_fence_position WHERE position_id = 1").get();
  return row ? Number(row.changed_at_ms) : 0;
}

export function advanceCredentialFencePosition(storage: StorageContext, changedAtMs: number): void {
  storage.tx(() => {
    storage.db.prepare(`INSERT INTO sync_relay_credential_fence_position (position_id, changed_at_ms) VALUES (1, ?)
      ON CONFLICT (position_id) DO UPDATE SET changed_at_ms = max(changed_at_ms, excluded.changed_at_ms)`)
      .run(Math.trunc(changedAtMs));
  });
}

// --- workspace names -------------------------------------------------------------

export function initializeWorkspaceDisplayName(db: SqliteDb): void {
  const marker = "workspace-display-name-v1";
  if (db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(marker)) return;
  const columns = new Set(db.prepare("PRAGMA table_info(sync_relay_workspaces)").all().map(row => String(row.name)));
  if (!columns.has("display_name")) {
    db.exec(`ALTER TABLE sync_relay_workspaces ADD COLUMN display_name TEXT
      CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND ${WORKSPACE_DISPLAY_NAME_LIMIT})`);
  }
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(marker, Date.now());
}

// --- activity --------------------------------------------------------------------

/**
 * The version a client reports at registration, and the agent's last sign-in
 * with the version it reported then. An agent from before these columns has
 * none until it signs in again.
 */
export function initializePersonalAgentActivity(db: SqliteDb): void {
  const marker = "personal-agent-activity-v1";
  if (db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(marker)) return;
  const columnsOf = (table: string) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
  const version = `TEXT CHECK (reported_version IS NULL OR length(reported_version) BETWEEN 1 AND ${AGENT_CLIENT_NAME_LIMIT})`;
  if (!columnsOf("sync_relay_agent_clients").has("reported_version")) {
    db.exec(`ALTER TABLE sync_relay_agent_clients ADD COLUMN reported_version ${version}`);
  }
  const agents = columnsOf("sync_relay_personal_agents");
  if (!agents.has("reported_version")) db.exec(`ALTER TABLE sync_relay_personal_agents ADD COLUMN reported_version ${version}`);
  if (!agents.has("signed_in_at_ms")) db.exec("ALTER TABLE sync_relay_personal_agents ADD COLUMN signed_in_at_ms INTEGER");
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(marker, Date.now());
}

/** The owner's name for the workspace, which sign-in and the reach dialog show. */
export function setWorkspaceDisplayName(storage: StorageContext, input: { workspaceId: string; ownerUserId: string; name: string }): boolean {
  return storage.tx(() => ownsWorkspace(storage, input.ownerUserId, input.workspaceId) &&
    storage.db.prepare("UPDATE sync_relay_workspaces SET display_name = ? WHERE workspace_id = ? AND owner_user_id = ?")
      .run(input.name, input.workspaceId, input.ownerUserId).changes === 1);
}
