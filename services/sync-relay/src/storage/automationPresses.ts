import {
  AUTOMATION_PRESS_RETENTION_MS,
  type AutomationPressOutcome,
  type AutomationPressState,
  type RelayAutomationPress,
  type RelayAutomationPressReceipt,
  type RelayButtonAuthority,
} from "@dohc/workspace-contracts/relay";
import { authorizeShareGrantAction } from "../shareAuthorization";
import { validateUserWritePath } from "@dohc/workspace-core";
import { currentCollectionEditGrant, grantEditsCollection } from "../collectionEditGrant";
import {fileSideOf, pathVisibleThroughShare} from "../shareFilter";
import { notFound, RelayError, relayError } from "../errors";
import type { StorageContext } from "./context";
import type { SqliteDb } from "./types";
import type {AutomationDeclaration} from "@dohc/live-session-contract/live-authorship";
import { markNotices, noticeIdFrom } from "./notices";

// Button presses from shared views, waiting for the workspace's automation
// host (ADR 0012). A press is recorded for the recipient's named Edit grant
// on the Collection's folder, and checked again whenever the host is offered
// it, so a grant that ends first runs nothing. The host passes the relay's
// own id to its engine, so no recipient's id can collide with another press.
//
// Every press, settled or not, stays for the whole retention window, so a
// press id sent again inside it always finds its press and never runs twice.
// Storage is bounded by refusing new presses, never by forgetting old ones.

// A grant's presses the host has not settled. More waits for the host first.
export const AUTOMATION_PRESSES_UNSETTLED_PER_GRANT = 50;
// A grant's presses inside the retention window. More are refused.
export const AUTOMATION_PRESSES_PER_GRANT = 5_000;
// The most presses one list offers the host, of each state. Waiting presses
// have their own room, so accepted ones never hide a new press.
export const AUTOMATION_PRESS_LIST_LIMIT = 50;
// The most expired presses one prune removes; the relay prunes in batches
// until none is left.
export const AUTOMATION_PRESS_PRUNE_BATCH = 1_000;
const OUTCOMES: readonly AutomationPressOutcome[] = ["done", "skipped", "failed", "ended", "busy"];
const ACCESS_CHANGED = "Your access to this Collection changed before the button ran.";
const HOST_CHANGED = "The computer that took this press stopped running this workspace's automations before it finished.";

export function initializeAutomationPressSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_automation_presses (
      host_press_id TEXT NOT NULL PRIMARY KEY CHECK (length(host_press_id) BETWEEN 1 AND 128),
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      share_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      grant_generation INTEGER NOT NULL CHECK (grant_generation BETWEEN 1 AND 9007199254740991),
      press_id TEXT NOT NULL CHECK (length(press_id) BETWEEN 1 AND 128),
      user_id TEXT NOT NULL,
      automation_id TEXT NOT NULL CHECK (length(automation_id) BETWEEN 1 AND 4096),
      collection_path TEXT NOT NULL CHECK (length(collection_path) BETWEEN 1 AND 4096),
      definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 16),
      record_id TEXT NOT NULL CHECK (length(record_id) BETWEEN 1 AND 1024),
      state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'settled')),
      accepted_by TEXT CHECK (accepted_by IS NULL OR length(accepted_by) BETWEEN 1 AND 256),
      confirmed_json TEXT NOT NULL DEFAULT '[]',
      accepted_generation INTEGER,
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('done', 'skipped', 'failed', 'ended', 'busy')),
      error TEXT CHECK (error IS NULL OR length(error) <= 1000),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
      CHECK ((state = 'settled') = (outcome IS NOT NULL)),
      CHECK ((state = 'accepted') = (accepted_by IS NOT NULL)),
      UNIQUE (grant_id, press_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_automation_presses_waiting
      ON sync_relay_automation_presses(workspace_id, state, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_sync_relay_automation_presses_created
      ON sync_relay_automation_presses(created_at_ms);
  `);
  const marker = "automation-press-confirmations-v1";
  if (!db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(marker)) {
    const columns = new Set(db.prepare("PRAGMA table_info(sync_relay_automation_presses)").all().map(row => String(row.name)));
    if (!columns.has("confirmed_json")) db.exec("ALTER TABLE sync_relay_automation_presses ADD COLUMN confirmed_json TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has("accepted_generation")) db.exec("ALTER TABLE sync_relay_automation_presses ADD COLUMN accepted_generation INTEGER");
    db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(marker, Date.now());
  }
}

// The recipient supplies the Button id. The owner's host resolves it against
// its own index and checks that Collection against the relay-checked path.
const COLLECTION_AUTOMATION_ID = /^collection:[A-Za-z0-9_-]+#.+$/su;

// The one expiry rule: a press created before this is gone, whatever its state.
const oldestKept = (nowMs: number) => nowMs - AUTOMATION_PRESS_RETENTION_MS;

export interface RecordAutomationPressInput {
  shareId: string;
  // Pinned when the route found the grant; a grant that changed since refuses the press.
  grantId: string;
  grantGeneration: number;
  // Derived from the authenticated caller.
  userId: string;
  pressId: string;
  automationId: string;
  // Where the recipient saw the Collection. The grant must edit it, and the
  // host runs the press only while the automation's Collection is still there.
  collectionPath: string;
  // The automation as the recipient saw it; the host refuses a press whose automation changed.
  definitionHash: string;
  recordId: string;
  confirmed: readonly string[];
  nowMs: number;
  newId: () => string;
}

interface PressRow {
  host_press_id: string;
  workspace_id: string;
  share_id: string;
  grant_id: string;
  grant_generation: number;
  press_id: string;
  user_id: string;
  automation_id: string;
  collection_path: string;
  definition_hash: string;
  record_id: string;
  state: AutomationPressState;
  accepted_by: string | null;
  accepted_generation: number | null;
  confirmed_json: string;
  outcome: AutomationPressOutcome | null;
  error: string | null;
  created_at_ms: number;
}

function pressRow(value: unknown): PressRow {
  return value as PressRow;
}

function receipt(row: PressRow): RelayAutomationPressReceipt {
  return { pressId: row.press_id, state: row.state, outcome: row.outcome, createdAtMs: row.created_at_ms };
}

function count(storage: StorageContext, sql: string, ...params: Array<string | number>): number {
  return Number(storage.db.prepare(sql).get(...params)?.n ?? 0);
}

/**
 * Records one press for the host, in one transaction with the checks that
 * allow it: the grant is still the recipient's current named grant with Edit
 * on the Collection's folder or a folder above it. A press id the grant sent
 * inside the retention window answers that press, and one naming another
 * button or record is refused.
 */
export function recordAutomationPress(storage: StorageContext, input: RecordAutomationPressInput): RelayAutomationPressReceipt {
  if (!COLLECTION_AUTOMATION_ID.test(input.automationId)) throw relayError("share_op_rejected");
  const path = validateUserWritePath(input.collectionPath);
  if (!path.ok || path.normalized !== input.collectionPath) throw relayError("share_op_rejected");
  return storage.tx(() => {
    const authorized = currentCollectionEditGrant(storage, input);
    if (!grantEditsCollection(storage, authorized, input.collectionPath)) throw relayError("share_read_only");
    const workspaceId = authorized.share.workspaceId;
    pruneExpired(storage, input.nowMs, workspaceId);
    const existing = storage.db.prepare(
      "SELECT * FROM sync_relay_automation_presses WHERE grant_id = ? AND press_id = ?",
    ).get(input.grantId, input.pressId);
    if (existing) {
      const row = pressRow(existing);
      if (row.automation_id !== input.automationId || row.collection_path !== input.collectionPath || row.definition_hash !== input.definitionHash ||
        row.record_id !== input.recordId || row.user_id !== input.userId || row.confirmed_json !== JSON.stringify(input.confirmed)) {
        throw relayError("conflict");
      }
      return receipt(row);
    }
    if (
      count(storage, "SELECT count(*) AS n FROM sync_relay_automation_presses WHERE grant_id = ? AND state <> 'settled'", input.grantId) >=
        AUTOMATION_PRESSES_UNSETTLED_PER_GRANT ||
      count(storage, "SELECT count(*) AS n FROM sync_relay_automation_presses WHERE grant_id = ?", input.grantId) >= AUTOMATION_PRESSES_PER_GRANT
    ) {
      throw relayError("automation_press_rate_limited");
    }
    storage.db.prepare(
      `INSERT INTO sync_relay_automation_presses (
         host_press_id, workspace_id, share_id, grant_id, grant_generation, press_id, user_id,
         automation_id, collection_path, definition_hash, record_id, confirmed_json, state, accepted_by, outcome, error, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`,
    ).run(
      input.newId(), workspaceId, input.shareId, input.grantId, input.grantGeneration, input.pressId, input.userId,
      input.automationId, input.collectionPath, input.definitionHash, input.recordId, JSON.stringify(input.confirmed), input.nowMs, input.nowMs,
    );
    return { pressId: input.pressId, state: "pending", outcome: null, createdAtMs: input.nowMs };
  });
}

/**
 * Removes presses past retention, in one workspace or the whole relay. The
 * relay also runs this on a timer, so presses go on time whether or not any
 * arrive or any host lists them.
 */
export function pruneExpired(storage: StorageContext, nowMs: number, workspaceId?: string): number {
  const cutoff = oldestKept(nowMs);
  const result = workspaceId === undefined
    ? storage.db.prepare(
      `DELETE FROM sync_relay_automation_presses WHERE host_press_id IN (
         SELECT host_press_id FROM sync_relay_automation_presses WHERE created_at_ms < ? LIMIT ?)`,
    ).run(cutoff, AUTOMATION_PRESS_PRUNE_BATCH)
    : storage.db.prepare(
      "DELETE FROM sync_relay_automation_presses WHERE workspace_id = ? AND created_at_ms < ?",
    ).run(workspaceId, cutoff);
  return Number(result.changes);
}

export interface HostScope {
  workspaceId: string;
  ownerUserId: string;
  installId: string;
}

// Only the computer that runs the workspace's automations gets presses: the
// recorded host, while no handover is open (the contract in relay.ts). With a
// generation, the host must also be the one that computer read.
export function isRunningHost(storage: StorageContext, scope: HostScope & { generation?: number }): boolean {
  if (!storage.workspaceIsOwnedBy(scope.workspaceId, scope.ownerUserId)) throw notFound();
  const host = storage.db.prepare(
    "SELECT install_id, handover_from, generation FROM sync_relay_automation_hosts WHERE workspace_id = ?",
  ).get(scope.workspaceId);
  return host !== undefined && host.handover_from === null && String(host.install_id) === scope.installId &&
    (scope.generation === undefined || Number(host.generation) === scope.generation);
}

// A press whose grant ended, or lost Edit on the Collection, since it was
// recorded settles as failed, so the host never runs it. Only those two
// answers mean that; any other error is the relay's own and goes up.
function stillAllowed(storage: StorageContext, row: PressRow, nowMs: number): boolean {
  let allowed: boolean;
  try {
    const authorized = currentCollectionEditGrant(storage, {
      shareId: row.share_id, grantId: row.grant_id, grantGeneration: row.grant_generation, userId: row.user_id,
    });
    allowed = grantEditsCollection(storage, authorized, row.collection_path);
  } catch (error) {
    if (!(error instanceof RelayError) || (error.code !== "not_found" && error.code !== "share_read_only")) throw error;
    allowed = false;
  }
  if (!allowed) settle(storage, row.host_press_id, "failed", ACCESS_CHANGED, nowMs);
  return allowed;
}

function settle(storage: StorageContext, hostPressId: string, outcome: AutomationPressOutcome, error: string | null, nowMs: number): void {
  storage.db.prepare(
    `UPDATE sync_relay_automation_presses SET state = 'settled', accepted_by = NULL, outcome = ?, error = ?, updated_at_ms = ?
     WHERE host_press_id = ?`,
  ).run(outcome, error, nowMs, hostPressId);
}

// Presses another computer accepted end when this one runs the workspace's
// automations: that computer handed over, was replaced, or was taken over,
// and may never settle them. Running them again here could repeat them.
function endOtherHostsPresses(storage: StorageContext, scope: HostScope, nowMs: number): void {
  const generation = Number(storage.db.prepare("SELECT generation FROM sync_relay_automation_hosts WHERE workspace_id=?").get(scope.workspaceId)?.generation);
  storage.db.prepare(
    `UPDATE sync_relay_automation_presses SET state = 'settled', accepted_by = NULL, outcome = 'ended', error = ?, updated_at_ms = ?
     WHERE workspace_id = ? AND state = 'accepted' AND (accepted_by <> ? OR accepted_generation IS NULL OR accepted_generation <> ?)`,
  ).run(HOST_CHANGED, nowMs, scope.workspaceId, scope.installId, generation);
}

/**
 * What the host's list will find: nothing for a computer that is not the
 * running host, presses waiting to be accepted, or none yet.
 */
export function automationPressWait(storage: StorageContext, scope: HostScope & { nowMs: number }): "not-host" | "waiting" | "empty" {
  if (!isRunningHost(storage, scope)) return "not-host";
  return storage.db.prepare(
    "SELECT 1 FROM sync_relay_automation_presses WHERE workspace_id = ? AND state = 'pending' AND created_at_ms >= ? LIMIT 1",
  ).get(scope.workspaceId, oldestKept(scope.nowMs)) === undefined ? "empty" : "waiting";
}

/**
 * The presses this host has not settled, oldest first: waiting ones, and
 * accepted ones, so a host that restarts between accepting a press and
 * pressing it finds the press again. Any other computer gets none.
 */
export function listAutomationPresses(storage: StorageContext, scope: HostScope & { nowMs: number }): RelayAutomationPress[] {
  return storage.tx(() => {
    if (!isRunningHost(storage, scope)) return [];
    pruneExpired(storage, scope.nowMs, scope.workspaceId);
    endOtherHostsPresses(storage, scope, scope.nowMs);
    const inState = (state: "pending" | "accepted") => storage.db.prepare(
      `SELECT * FROM sync_relay_automation_presses
       WHERE workspace_id = ? AND state = ? AND created_at_ms >= ?
       ORDER BY created_at_ms, host_press_id LIMIT ?`,
    ).all(scope.workspaceId, state, oldestKept(scope.nowMs), AUTOMATION_PRESS_LIST_LIMIT).map(pressRow);
    const rows = [...inState("pending"), ...inState("accepted")]
      .sort((left, right) => left.created_at_ms - right.created_at_ms || (left.host_press_id < right.host_press_id ? -1 : 1));
    // An accepted press may be running, so only a waiting one is checked again.
    return rows.filter((row) => row.state === "accepted" || stillAllowed(storage, row, scope.nowMs)).map((row) => ({
      hostPressId: row.host_press_id,
      definitionHash: row.definition_hash,
      state: row.state === "accepted" ? "accepted" as const : "pending" as const,
      automationId: row.automation_id,
      collectionPath: row.collection_path,
      recordId: row.record_id,
      pressedBy: row.user_id,
      createdAtMs: row.created_at_ms,
      confirmed: JSON.parse(row.confirmed_json) as string[],
    }));
  });
}

/**
 * The host takes these presses. Each is checked again first, inside
 * retention and against its grant, including one this host accepted before
 * and asks for again after a restart. The answer names the ones accepted.
 * Only the running host, at the generation it read, accepts: a handover
 * that began since accepts nothing.
 */
export function acceptAutomationPresses(
  storage: StorageContext,
  scope: HostScope & { generation: number; hostPressIds: readonly string[]; nowMs: number },
): string[] {
  return storage.tx(() => {
    if (!isRunningHost(storage, scope)) throw relayError("conflict");
    const accepted: string[] = [];
    for (const id of scope.hostPressIds) {
      const found = storage.db.prepare(
        "SELECT * FROM sync_relay_automation_presses WHERE host_press_id = ? AND workspace_id = ? AND created_at_ms >= ?",
      ).get(id, scope.workspaceId, oldestKept(scope.nowMs));
      if (!found) continue;
      const row = pressRow(found);
      const mine = row.state === "accepted" && row.accepted_by === scope.installId && row.accepted_generation === scope.generation;
      if ((row.state !== "pending" && !mine) || !stillAllowed(storage, row, scope.nowMs)) continue;
      if (mine) {
        accepted.push(id);
        continue;
      }
      storage.db.prepare(
        "UPDATE sync_relay_automation_presses SET state = 'accepted', accepted_by = ?, accepted_generation = ?, updated_at_ms = ? WHERE host_press_id = ?",
      ).run(scope.installId, scope.generation, scope.nowMs, id);
      accepted.push(id);
    }
    return accepted;
  });
}

/** Current named grants in this workspace. No roster, email, or owner description crosses the transport. */
export function buttonAuthority(storage: StorageContext, input: {
  workspaceId: string; shareId: string; grantId: string; grantGeneration: number; userId: string;
  automationId: string; collectionPath: string; definitionHash: string;
}, generation: number): RelayButtonAuthority {
  const source = currentCollectionEditGrant(storage, input);
  if (source.share.workspaceId !== input.workspaceId || !grantEditsCollection(storage, source, input.collectionPath)) throw notFound();
  const principals: RelayButtonAuthority["principals"] = [];
  for (const received of storage.listSharesReceivedBy(input.userId)) {
    if (received.share.workspaceId !== input.workspaceId) continue;
    const allowed = authorizeShareGrantAction({ storage, grantId: received.grant.grantId, action: "read", principal: { kind: "user", userId: input.userId } });
    if (!allowed.ok || !["view", "comment", "edit"].includes(allowed.grant.access)) continue;
    principals.push({ grantId: allowed.grant.grantId, userId: input.userId, access: allowed.grant.access as "view" | "comment" | "edit" });
  }
  return { workspaceId: input.workspaceId, automationId: input.automationId, collectionPath: input.collectionPath, definitionHash: input.definitionHash,
    userId: input.userId, grantId: input.grantId, grantGeneration: input.grantGeneration, hostGeneration: generation, principals, confirmed: [] };
}

/** The host supplies only its relay press id. All presser fields come from the authenticated stored press. */
export function resolveAutomationPress(storage: StorageContext, scope: HostScope & { generation: number; hostPressId: string; nowMs: number }): RelayButtonAuthority {
  // Synchronous reads also run inside a dataset commit's existing transaction.
  if (!isRunningHost(storage, scope)) throw relayError("conflict");
  const found = storage.db.prepare("SELECT * FROM sync_relay_automation_presses WHERE workspace_id=? AND host_press_id=? AND created_at_ms>=?")
    .get(scope.workspaceId, scope.hostPressId, oldestKept(scope.nowMs));
  if (!found) throw notFound();
  const row = pressRow(found);
  if (row.state !== "accepted") throw notFound();
  if (row.accepted_generation !== scope.generation) throw relayError("conflict");
  if (row.accepted_by !== scope.installId) throw notFound();
  return { ...buttonAuthority(storage, { workspaceId: row.workspace_id, shareId: row.share_id, grantId: row.grant_id,
    grantGeneration: row.grant_generation, userId: row.user_id, automationId: row.automation_id,
    collectionPath: row.collection_path, definitionHash: row.definition_hash }, scope.generation),
    recordId: row.record_id, confirmed: JSON.parse(row.confirmed_json) as string[] };
}

/** Called inside journal admission's writer transaction, after an exact accepted replay is resolved. */
export function automationPressAdmissionAllowed(storage: StorageContext, input: {
  workspaceId: string; ownerUserId: string; currentPath: string; hostPressId: string; automationId: string; declaration: AutomationDeclaration;
}): boolean {
  const found = storage.db.prepare("SELECT * FROM sync_relay_automation_presses WHERE workspace_id=? AND host_press_id=?")
    .get(input.workspaceId, input.hostPressId);
  if (!found) return false;
  const row = pressRow(found);
  if (row.accepted_generation === null || row.automation_id !== input.automationId ||
    row.user_id !== input.declaration.attribution.onBehalfOf || !storage.workspaceIsOwnedBy(input.workspaceId, input.ownerUserId)) return false;
  try {
    const authorized = currentCollectionEditGrant(storage, {shareId: row.share_id, grantId: row.grant_id,
      grantGeneration: row.grant_generation, userId: row.user_id});
    if (authorized.share.workspaceId !== input.workspaceId || !grantEditsCollection(storage, authorized, row.collection_path)) return false;
    const originalFiles = fileSideOf(authorized.effectiveSelector);
    return originalFiles !== null && originalFiles.versionId === null && pathVisibleThroughShare(originalFiles, input.currentPath);
  } catch (error) {
    if (!(error instanceof RelayError) || (error.code !== "not_found" && error.code !== "share_read_only")) throw error;
    return false;
  }
}

/**
 * How one accepted press ended. Any of the owner's computers settles it,
 * since the host may have changed while it ran. The same answer again
 * changes nothing; another is refused.
 */
export function settleAutomationPress(
  storage: StorageContext,
  input: { workspaceId: string; ownerUserId: string; hostPressId: string; outcome: AutomationPressOutcome; error: string | null; nowMs: number },
): RelayAutomationPressReceipt {
  if (!OUTCOMES.includes(input.outcome)) throw relayError("share_op_rejected");
  const result = storage.tx(() => {
    if (!storage.workspaceIsOwnedBy(input.workspaceId, input.ownerUserId)) throw notFound();
    const found = storage.db.prepare(
      "SELECT * FROM sync_relay_automation_presses WHERE host_press_id = ? AND workspace_id = ?",
    ).get(input.hostPressId, input.workspaceId);
    if (!found) throw notFound();
    const row = pressRow(found);
    if (row.state === "settled") {
      if (row.outcome !== input.outcome) throw relayError("conflict");
      return { answer: receipt(row), row };
    }
    if (row.state !== "accepted") throw relayError("conflict");
    settle(storage, input.hostPressId, input.outcome, input.error, input.nowMs);
    return { answer: { ...receipt(row), state: "settled" as const, outcome: input.outcome }, row };
  });
  if (input.outcome === "done") {
    const { row } = result;
    // A successful later press clears earlier failures for this person's record.
    const prefix = row.user_id === input.ownerUserId ? "automation-press:" : noticeIdFrom(input.ownerUserId, "automation-press:");
    const notices = storage.db.prepare(`SELECT n.notice_id FROM sync_relay_automation_presses p
      JOIN sync_relay_notices n ON n.notice_id = ? || p.host_press_id
      WHERE p.workspace_id=? AND p.automation_id=? AND p.record_id=? AND p.user_id=?
        AND p.state='settled' AND p.outcome IN ('failed','busy') AND p.created_at_ms<=?
        AND n.sender_user_id=? AND n.recipient_user_id=? AND n.dismissed_at_ms IS NULL`)
      .all(prefix, input.workspaceId, row.automation_id, row.record_id, row.user_id, row.created_at_ms, input.ownerUserId, row.user_id);
    if (notices.length) markNotices(storage, { recipientUserId: row.user_id,
      marks: notices.map(notice => ({ noticeId: String(notice.notice_id), mark: "dismissed" as const })), nowMs: input.nowMs });
  }
  return result.answer;
}

/** Recheck the original named grant of a non-Button recipient claim at admission. */
export function automationGrantAdmissionAllowed(storage: StorageContext, input: {
  workspaceId: string; ownerUserId: string; currentPath: string; grantId: string; grantGeneration: number; declaration: AutomationDeclaration;
}): boolean {
  const userId = input.declaration.attribution.onBehalfOf;
  if (!userId || !storage.workspaceIsOwnedBy(input.workspaceId, input.ownerUserId)) return false;
  const allowed = authorizeShareGrantAction({storage, grantId: input.grantId, action: "read", principal: {kind: "user", userId}});
  if (!allowed.ok || allowed.share.workspaceId !== input.workspaceId || allowed.grant.generation !== input.grantGeneration) return false;
  const files = fileSideOf(allowed.effectiveSelector);
  return files !== null && files.versionId === null && pathVisibleThroughShare(files, input.currentPath);
}
