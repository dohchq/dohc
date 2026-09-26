import {
  AUTOMATION_PRESS_RETENTION_MS,
  type AutomationPressOutcome,
  type AutomationPressState,
  type RelayAutomationPress,
  type RelayAutomationPressReceipt,
} from "@dohc/workspace-contracts/relay";
import { currentCollectionEditGrant, grantEditsCollection } from "../collectionEditGrant";
import { notFound, RelayError, relayError } from "../errors";
import type { StorageContext } from "./context";
import type { SqliteDb } from "./types";

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
      definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 16),
      record_id TEXT NOT NULL CHECK (length(record_id) BETWEEN 1 AND 1024),
      state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'settled')),
      accepted_by TEXT CHECK (accepted_by IS NULL OR length(accepted_by) BETWEEN 1 AND 256),
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
}

/** The Collection a Collection automation belongs to: "collection:<path>#<id>". */
export function automationPressCollection(automationId: string): string | null {
  if (!automationId.startsWith("collection:")) return null;
  const rest = automationId.slice("collection:".length);
  const hash = rest.lastIndexOf("#");
  if (hash <= 0 || hash === rest.length - 1) return null;
  return rest.slice(0, hash);
}

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
  // The automation as the recipient saw it; the host refuses a press whose automation changed.
  definitionHash: string;
  recordId: string;
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
  definition_hash: string;
  record_id: string;
  state: AutomationPressState;
  accepted_by: string | null;
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
  const collectionPath = automationPressCollection(input.automationId);
  if (collectionPath === null) throw relayError("share_op_rejected");
  return storage.tx(() => {
    const authorized = currentCollectionEditGrant(storage, input);
    if (!grantEditsCollection(storage, authorized, collectionPath)) throw relayError("share_read_only");
    const workspaceId = authorized.share.workspaceId;
    pruneExpired(storage, input.nowMs, workspaceId);
    const existing = storage.db.prepare(
      "SELECT * FROM sync_relay_automation_presses WHERE grant_id = ? AND press_id = ?",
    ).get(input.grantId, input.pressId);
    if (existing) {
      const row = pressRow(existing);
      if (row.automation_id !== input.automationId || row.definition_hash !== input.definitionHash ||
        row.record_id !== input.recordId || row.user_id !== input.userId) {
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
         automation_id, definition_hash, record_id, state, accepted_by, outcome, error, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`,
    ).run(
      input.newId(), workspaceId, input.shareId, input.grantId, input.grantGeneration, input.pressId, input.userId,
      input.automationId, input.definitionHash, input.recordId, input.nowMs, input.nowMs,
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
function isRunningHost(storage: StorageContext, scope: HostScope & { generation?: number }): boolean {
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
  const collectionPath = automationPressCollection(row.automation_id);
  let allowed: boolean;
  try {
    const authorized = currentCollectionEditGrant(storage, {
      shareId: row.share_id, grantId: row.grant_id, grantGeneration: row.grant_generation, userId: row.user_id,
    });
    allowed = collectionPath !== null && grantEditsCollection(storage, authorized, collectionPath);
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
  storage.db.prepare(
    `UPDATE sync_relay_automation_presses SET state = 'settled', accepted_by = NULL, outcome = 'ended', error = ?, updated_at_ms = ?
     WHERE workspace_id = ? AND state = 'accepted' AND accepted_by <> ?`,
  ).run(HOST_CHANGED, nowMs, scope.workspaceId, scope.installId);
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
      recordId: row.record_id,
      pressedBy: row.user_id,
      createdAtMs: row.created_at_ms,
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
      const mine = row.state === "accepted" && row.accepted_by === scope.installId;
      if ((row.state !== "pending" && !mine) || !stillAllowed(storage, row, scope.nowMs)) continue;
      if (mine) {
        accepted.push(id);
        continue;
      }
      storage.db.prepare(
        "UPDATE sync_relay_automation_presses SET state = 'accepted', accepted_by = ?, updated_at_ms = ? WHERE host_press_id = ?",
      ).run(scope.installId, scope.nowMs, id);
      accepted.push(id);
    }
    return accepted;
  });
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
  return storage.tx(() => {
    if (!storage.workspaceIsOwnedBy(input.workspaceId, input.ownerUserId)) throw notFound();
    const found = storage.db.prepare(
      "SELECT * FROM sync_relay_automation_presses WHERE host_press_id = ? AND workspace_id = ?",
    ).get(input.hostPressId, input.workspaceId);
    if (!found) throw notFound();
    const row = pressRow(found);
    if (row.state === "settled") {
      if (row.outcome !== input.outcome) throw relayError("conflict");
      return receipt(row);
    }
    if (row.state !== "accepted") throw relayError("conflict");
    settle(storage, input.hostPressId, input.outcome, input.error, input.nowMs);
    return { ...receipt(row), state: "settled", outcome: input.outcome };
  });
}
