import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import { INBOX_COLLECTION_PATH } from "@dohc/workspace-contracts/inbox";
import {
  INCOMING_WEBHOOK_DAILY_DELIVERY_CAP,
  INCOMING_WEBHOOK_IDEMPOTENCY_RETENTION_MS,
  IncomingWebhookForm,
  MAX_INCOMING_WEBHOOK_FORM_PENDING_COUNT,
  MAX_INCOMING_WEBHOOK_PENDING_BYTES,
  MAX_INCOMING_WEBHOOK_PENDING_COUNT,
  MAX_INCOMING_WEBHOOKS_PER_WORKSPACE,
  type IncomingWebhookDeliveryState,
  type IncomingWebhookRecentDelivery,
  type IncomingWebhookSummary,
} from "@dohc/workspace-contracts/incoming-webhooks";
import {
  AUTOMATION_SERVER_FULL,
  AUTOMATION_SERVER_INSTALL_ID,
} from "@dohc/workspace-contracts/relay";
import {
  asRecord,
  isSharedWithMePath,
  stripWindowsAliasSuffix,
  validateUserWritePath,
} from "@dohc/workspace-core";
import {
  COLLECTION_SCHEMA_FILE,
  effectiveShareSelector,
  fileSideOf,
  MAIN_VERSION_ID,
  parseStoredAnyShareSelectorJson,
} from "../shareFilter";
import { accountIsFenced, workspaceIsDeleted } from "./accountDeletion";
import { chooseAutomationHost, type AutomationServer } from "./automationHosts";
import type { StorageContext } from "./context";
import {
  currentFileObjectId,
  objectMomentFromMomentPayload,
  objectPathFromMomentPayload,
} from "./currentFiles";
import { listActiveWorkspaceShareGrants } from "./outboundWebhooks";
import type { SqliteDb, SyncRelayLogInput } from "./types";
import { assertWorkspaceQuota } from "./workspaces";

export const MAX_INCOMING_WEBHOOK_DRAIN_ATTEMPTS = 5;
export const INCOMING_WEBHOOK_RETRY_BASE_MS = 5_000;
const INCOMING_WEBHOOK_RETRY_MAX_MS = 300_000;

const RECENT_DELIVERIES_LIMIT = 10;
const PRUNE_BATCH_SIZE = 100;
const MAX_ERROR_BYTES = 500;
const SHARE_PAUSE_REASON =
  "Paused because this Collection or a parent folder was shared. Incoming webhooks deliver only to private Collections.";

function loosePathKey(path: string): string {
  return path
    .normalize("NFC")
    .split("/")
    .map((segment) =>
      stripWindowsAliasSuffix(segment).toLowerCase().toUpperCase().toLowerCase().normalize("NFC"),
    )
    .join("/");
}

function pathWithinFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  let end = low;
  if (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return value.slice(0, end);
}

export function hashIncomingWebhookToken(linkKey: string | Uint8Array, token: string): string {
  return createHmac("sha256", linkKey)
    .update("incoming-webhook-token\n")
    .update(token)
    .digest("hex");
}

export function mintIncomingWebhookToken(): string {
  return randomBytes(32).toString("base64url");
}

export function mintIncomingWebhookId(): string {
  return `whk_${randomBytes(12).toString("hex")}`;
}

export function mintIncomingWebhookDeliveryId(): string {
  return `whd_${randomBytes(16).toString("hex")}`;
}

function constantTimeHexEqual(leftHex: string, rightHex: string): boolean {
  if (leftHex.length !== rightHex.length) return false;
  const left = Buffer.from(leftHex, "utf8");
  const right = Buffer.from(rightHex, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

const FORM_COLUMN =
  "form_json TEXT CHECK (form_json IS NULL OR (json_valid(form_json) AND length(form_json) <= 2048))";
const FORM_MIGRATION_ID = "incoming-webhook-form-v1";

export function initializeIncomingWebhookSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_incoming_webhooks (
      webhook_id TEXT NOT NULL PRIMARY KEY CHECK (length(webhook_id) BETWEEN 8 AND 64),
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
      collection_path TEXT NOT NULL CHECK (length(collection_path) BETWEEN 1 AND 1024),
      collection_id TEXT CHECK (collection_id IS NULL OR length(collection_id) BETWEEN 1 AND 256),
      token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
      paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
      pause_reason TEXT CHECK (pause_reason IS NULL OR length(pause_reason) <= 500),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
      last_delivery_at_ms INTEGER CHECK (last_delivery_at_ms IS NULL OR last_delivery_at_ms >= 0),
      daily_cap_notified_day TEXT CHECK (daily_cap_notified_day IS NULL OR length(daily_cap_notified_day) = 10),
      storage_bytes INTEGER NOT NULL CHECK (storage_bytes > 0),
      ${FORM_COLUMN}
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_incoming_webhooks_workspace
      ON sync_relay_incoming_webhooks(workspace_id, created_at_ms);
    CREATE TRIGGER IF NOT EXISTS trg_sync_relay_incoming_webhooks_usage_insert
      AFTER INSERT ON sync_relay_incoming_webhooks
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes + NEW.storage_bytes
        WHERE workspace_id = NEW.workspace_id;
      END;
    CREATE TRIGGER IF NOT EXISTS trg_sync_relay_incoming_webhooks_usage_update
      AFTER UPDATE OF storage_bytes ON sync_relay_incoming_webhooks
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - OLD.storage_bytes + NEW.storage_bytes
        WHERE workspace_id = NEW.workspace_id;
      END;
    CREATE TRIGGER IF NOT EXISTS trg_sync_relay_incoming_webhooks_usage_delete
      AFTER DELETE ON sync_relay_incoming_webhooks
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - OLD.storage_bytes
        WHERE workspace_id = OLD.workspace_id;
      END;

    CREATE TABLE IF NOT EXISTS sync_relay_webhook_deliveries (
      delivery_id TEXT NOT NULL PRIMARY KEY CHECK (length(delivery_id) BETWEEN 8 AND 128),
      webhook_id TEXT NOT NULL REFERENCES sync_relay_incoming_webhooks(webhook_id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      delivery_key TEXT CHECK (delivery_key IS NULL OR length(delivery_key) BETWEEN 1 AND 128),
      payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
      content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 128),
      headers_json TEXT NOT NULL CHECK (json_valid(headers_json) AND length(headers_json) <= 16384),
      payload_blob BLOB,
      payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0),
      chain_depth INTEGER NOT NULL DEFAULT 0 CHECK (chain_depth BETWEEN 0 AND 3),
      state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'settled', 'failed', 'paused')),
      accepted_by TEXT CHECK (accepted_by IS NULL OR length(accepted_by) BETWEEN 1 AND 256),
      accepted_generation INTEGER CHECK (accepted_generation IS NULL OR accepted_generation >= 1),
      accepted_lease_id TEXT CHECK (accepted_lease_id IS NULL OR length(accepted_lease_id) BETWEEN 1 AND 256),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (next_attempt_at_ms >= 0),
      record_path TEXT CHECK (record_path IS NULL OR length(record_path) BETWEEN 1 AND 4096),
      error TEXT CHECK (error IS NULL OR length(error) <= 500),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
      settled_at_ms INTEGER CHECK (settled_at_ms IS NULL OR settled_at_ms >= 0),
      storage_bytes INTEGER NOT NULL CHECK (storage_bytes >= 0)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_relay_webhook_deliveries_idempotency
      ON sync_relay_webhook_deliveries(webhook_id, delivery_key)
      WHERE delivery_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_webhook_deliveries_pending
      ON sync_relay_webhook_deliveries(workspace_id, state, next_attempt_at_ms, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_sync_relay_webhook_deliveries_webhook_created
      ON sync_relay_webhook_deliveries(webhook_id, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_sync_relay_webhook_deliveries_settled
      ON sync_relay_webhook_deliveries(settled_at_ms)
      WHERE settled_at_ms IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS trg_sync_relay_webhook_deliveries_usage_insert
      AFTER INSERT ON sync_relay_webhook_deliveries
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes + NEW.storage_bytes
        WHERE workspace_id = NEW.workspace_id;
      END;
    CREATE TRIGGER IF NOT EXISTS trg_sync_relay_webhook_deliveries_usage_update
      AFTER UPDATE OF storage_bytes ON sync_relay_webhook_deliveries
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - OLD.storage_bytes + NEW.storage_bytes
        WHERE workspace_id = NEW.workspace_id;
      END;
    CREATE TRIGGER IF NOT EXISTS trg_sync_relay_webhook_deliveries_usage_delete
      AFTER DELETE ON sync_relay_webhook_deliveries
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - OLD.storage_bytes
        WHERE workspace_id = OLD.workspace_id;
      END;
  `);
  if (
    !db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(FORM_MIGRATION_ID)
  ) {
    const columns = db
      .prepare("PRAGMA table_info(sync_relay_incoming_webhooks)")
      .all()
      .map((row) => String(row.name));
    if (!columns.includes("form_json")) {
      db.exec(`ALTER TABLE sync_relay_incoming_webhooks ADD COLUMN ${FORM_COLUMN}`);
    }
    db.prepare(
      "INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)",
    ).run(FORM_MIGRATION_ID, Date.now());
  }
}

function storedForm(value: unknown): IncomingWebhookForm | null {
  return typeof value === "string" ? IncomingWebhookForm.parse(JSON.parse(value)) : null;
}

/** A form webhook gets its own queue share, so a busy page can't stall the workspace's other webhooks. */
function formPendingCount(storage: StorageContext, webhookId: string): number | null {
  const row = storage.db
    .prepare(
      `SELECT COUNT(d.delivery_id) AS count
         FROM sync_relay_incoming_webhooks w
         LEFT JOIN sync_relay_webhook_deliveries d
           ON d.webhook_id = w.webhook_id AND d.state IN ('pending', 'accepted')
        WHERE w.webhook_id = ? AND w.form_json IS NOT NULL
        GROUP BY w.webhook_id`,
    )
    .get(webhookId);
  return row === undefined ? null : Number(row.count);
}

function ownerMayMutateWorkspace(
  storage: StorageContext,
  workspaceId: string,
  ownerUserId: string,
): boolean {
  if (accountIsFenced(storage, ownerUserId) || workspaceIsDeleted(storage, workspaceId)) {
    return false;
  }
  const row = storage.db
    .prepare(
      "SELECT 1 FROM sync_relay_workspaces WHERE workspace_id = ? AND owner_user_id = ? LIMIT 1",
    )
    .get(workspaceId, ownerUserId);
  return row !== undefined;
}

function workspaceOwnerOf(storage: StorageContext, workspaceId: string): string | null {
  if (workspaceIsDeleted(storage, workspaceId)) return null;
  const row = storage.db
    .prepare("SELECT owner_user_id FROM sync_relay_workspaces WHERE workspace_id = ? LIMIT 1")
    .get(workspaceId);
  return row && typeof row.owner_user_id === "string" ? row.owner_user_id : null;
}

function readAutomationHostRow(
  storage: StorageContext,
  workspaceId: string,
): { installId: string; generation: number; handoverFrom: string | null } | null {
  const row = storage.db
    .prepare(
      `SELECT install_id, generation, handover_from
         FROM sync_relay_automation_hosts
        WHERE workspace_id = ? LIMIT 1`,
    )
    .get(workspaceId);
  if (!row) return null;
  return {
    installId: String(row.install_id),
    generation: Number(row.generation),
    handoverFrom: row.handover_from === null ? null : String(row.handover_from),
  };
}

function workspaceHasServerAutomationHost(storage: StorageContext, workspaceId: string): boolean {
  const host = readAutomationHostRow(storage, workspaceId);
  return (
    host !== null && host.installId === AUTOMATION_SERVER_INSTALL_ID && host.handoverFrom === null
  );
}

export function normalizeIncomingWebhookCollectionPath(rawPath: string): string | null {
  const trimmed = rawPath
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/gu, "");
  if (!trimmed) return INBOX_COLLECTION_PATH;
  const checked = validateUserWritePath(trimmed);
  if (!checked.ok || checked.normalized !== trimmed) return null;
  if (isSharedWithMePath(trimmed)) return null;
  if (classifyEngineFilePath(`${trimmed}/${COLLECTION_SCHEMA_FILE}`).kind !== "tracked") {
    return null;
  }
  return trimmed;
}

export function collectionHasAnyActiveShareGrant(
  storage: StorageContext,
  workspaceId: string,
  ownerUserId: string,
  collectionPath: string,
): boolean {
  const looseCollection = loosePathKey(collectionPath);
  for (const grant of listActiveWorkspaceShareGrants(storage, workspaceId)) {
    if (grant.principalKind === "user" && grant.principalUserId === ownerUserId) continue;
    const storedSelector = parseStoredAnyShareSelectorJson(grant.selectorJson);
    if (storedSelector === null) return true;
    const effective = effectiveShareSelector(storedSelector, grant.access);
    if (effective === null) return true;
    const fileSide = fileSideOf(effective);
    if (fileSide === null) continue;
    // Whole-version shares (`paths: []`) expose every tracked path in that version.
    if (fileSide.paths.length === 0) return true;
    for (const granted of fileSide.paths) {
      const looseGranted = loosePathKey(granted);
      if (pathWithinFolder(looseCollection, looseGranted)) {
        return true;
      }
    }
  }
  return false;
}

export function selectorCoversCollectionPath(
  selectorJson: string,
  access: string,
  collectionPath: string,
): boolean {
  const storedSelector = parseStoredAnyShareSelectorJson(selectorJson);
  if (storedSelector === null) return true;
  const effective = effectiveShareSelector(storedSelector, access);
  if (effective === null) return true;
  const fileSide = fileSideOf(effective);
  if (fileSide === null) return false;
  if (fileSide.paths.length === 0) return true;
  const looseCollection = loosePathKey(collectionPath);
  return fileSide.paths.some((granted) => pathWithinFolder(looseCollection, loosePathKey(granted)));
}

/**
 * Called inside share-creation/retuning/undo SQLite transactions: pauses any active
 * incoming webhook whose target Collection (or an ancestor) is covered by the
 * share grant (even View) and releases any buffered pending payload bytes.
 */
export function pauseIncomingWebhooksForShareInTx(
  storage: StorageContext,
  input: {
    readonly workspaceId: string;
    readonly granterUserId: string;
    readonly principalKind: string;
    readonly principalUserId: string | null;
    readonly selectorJson: string;
    readonly access: string;
    readonly nowMs: number;
  },
): number {
  if (input.principalKind === "user" && input.principalUserId === input.granterUserId) {
    return 0;
  }
  const activeWebhooks = storage.db
    .prepare(
      `SELECT webhook_id, collection_path
         FROM sync_relay_incoming_webhooks
         WHERE workspace_id = ? AND paused = 0`,
    )
    .all(input.workspaceId);
  if (activeWebhooks.length === 0) return 0;

  const now = Math.trunc(input.nowMs);
  let pausedCount = 0;
  for (const row of activeWebhooks) {
    const webhookId = String(row.webhook_id);
    const collectionPath = String(row.collection_path);
    if (!selectorCoversCollectionPath(input.selectorJson, input.access, collectionPath)) continue;
    storage.db
      .prepare(
        `UPDATE sync_relay_incoming_webhooks
            SET paused = 1,
                pause_reason = ?,
                updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
          WHERE webhook_id = ?`,
      )
      .run(SHARE_PAUSE_REASON, now, now, webhookId);
    storage.db
      .prepare(
        `UPDATE sync_relay_webhook_deliveries
            SET state = 'paused',
                payload_blob = NULL,
                payload_bytes = 0,
                storage_bytes = 0,
                accepted_by = NULL,
                accepted_generation = NULL,
                accepted_lease_id = NULL,
                next_attempt_at_ms = 0,
                error = ?,
                settled_at_ms = ?,
                updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
          WHERE webhook_id = ? AND state IN ('pending', 'accepted')`,
      )
      .run(SHARE_PAUSE_REASON, now, now, now, webhookId);
    pausedCount += 1;
  }
  return pausedCount;
}

function readCommittedDocumentCollectionId(
  storage: StorageContext,
  workspaceId: string,
  collectionPath: string,
): string | null {
  const schemaPath = `${collectionPath}/${COLLECTION_SCHEMA_FILE}`;
  return (
    currentFileObjectId(storage, { workspaceId, versionId: MAIN_VERSION_ID, path: schemaPath }) ??
    null
  );
}

function claimDailyCapNoticeSlot(
  storage: StorageContext,
  webhookId: string,
  nowMs: number,
): boolean {
  const utcDay = new Date(nowMs).toISOString().slice(0, 10);
  const updated = storage.db
    .prepare(
      `UPDATE sync_relay_incoming_webhooks
          SET daily_cap_notified_day = ?
        WHERE webhook_id = ?
          AND (daily_cap_notified_day IS NULL OR daily_cap_notified_day <> ?)`,
    )
    .run(utcDay, webhookId, utcDay);
  return updated.changes > 0;
}

function extractWebhookIdFromMomentPayload(payloadJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record || !Array.isArray(record.authors)) return null;
  for (const entry of record.authors) {
    const author = asRecord(entry);
    if (
      author &&
      author.kind === "automation" &&
      typeof author.automationId === "string" &&
      author.automationId.startsWith("webhook:")
    ) {
      return author.automationId.slice("webhook:".length);
    }
  }
  return null;
}

/**
 * Atomic log-admission boundary under SQLite BEGIN IMMEDIATE: marks any
 * incoming-webhook-authored `moment.append` op as `relayAdmission = "departed"`
 * when its webhook is paused/deleted, its path leaves its Collection, or its
 * Collection has any active share grant. Serialized against share creation/undo
 * so an in-flight replica write never enters `sync_relay_current_files`,
 * `sync_relay_object_moments`, or any share recipient's log/blob reads, while
 * keeping the coordinate's `op_kind` and `payload_json` intact so the pushing
 * ordinary replica's pull never hits `OriginDiverged`.
 */
export function admitIncomingWebhookOpsInTransaction(
  storage: StorageContext,
  workspaceId: string,
  ops: SyncRelayLogInput[],
  nowMs: number,
): void {
  const now = Math.trunc(nowMs);
  for (const op of ops) {
    if (op.opKind !== "moment.append" || op.relayAdmission !== undefined) continue;
    const webhookId = extractWebhookIdFromMomentPayload(op.payloadJson);
    if (webhookId === null) continue;

    const ownerUserId = workspaceOwnerOf(storage, workspaceId);
    const webhook = storage.db
      .prepare(
        `SELECT collection_path, paused
           FROM sync_relay_incoming_webhooks
          WHERE workspace_id = ? AND webhook_id = ?
          LIMIT 1`,
      )
      .get(workspaceId, webhookId);
    const moment = objectMomentFromMomentPayload(op.payloadJson);
    const opPath = moment?.path ?? objectPathFromMomentPayload(op.payloadJson)?.path ?? null;
    const collectionPath = webhook ? String(webhook.collection_path) : null;
    const isShared =
      ownerUserId !== null && collectionPath !== null
        ? collectionHasAnyActiveShareGrant(storage, workspaceId, ownerUserId, collectionPath)
        : false;
    const allowed =
      ownerUserId !== null &&
      !accountIsFenced(storage, ownerUserId) &&
      webhook !== undefined &&
      Number(webhook.paused) === 0 &&
      moment !== null &&
      moment.versionId === MAIN_VERSION_ID &&
      !moment.deleted &&
      opPath !== null &&
      collectionPath !== null &&
      pathWithinFolder(loosePathKey(opPath), loosePathKey(collectionPath)) &&
      !isShared;

    if (!allowed) {
      if (webhook !== undefined && Number(webhook.paused) === 0 && isShared) {
        storage.db
          .prepare(
            `UPDATE sync_relay_incoming_webhooks
                SET paused = 1,
                    pause_reason = ?,
                    updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
              WHERE workspace_id = ? AND webhook_id = ?`,
          )
          .run(SHARE_PAUSE_REASON, now, now, workspaceId, webhookId);
      }
      op.relayAdmission = "departed";
    }
  }
}

function summaryForRow(
  storage: StorageContext,
  row: Record<string, unknown>,
): IncomingWebhookSummary {
  const webhookId = String(row.webhook_id);
  const pendingRow = storage.db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM sync_relay_webhook_deliveries
         WHERE webhook_id = ? AND state IN ('pending', 'accepted')`,
    )
    .get(webhookId);
  const deliveryRows = storage.db
    .prepare(
      `SELECT delivery_id, state, content_type, created_at_ms, settled_at_ms, record_path, error
         FROM sync_relay_webhook_deliveries
         WHERE webhook_id = ?
         ORDER BY created_at_ms DESC, delivery_id DESC
         LIMIT ?`,
    )
    .all(webhookId, RECENT_DELIVERIES_LIMIT);

  const recentDeliveries: IncomingWebhookRecentDelivery[] = deliveryRows.map((entry) => ({
    deliveryId: String(entry.delivery_id),
    state: String(entry.state) as IncomingWebhookDeliveryState,
    contentType: String(entry.content_type),
    receivedAtMs: Number(entry.created_at_ms),
    settledAtMs: entry.settled_at_ms == null ? null : Number(entry.settled_at_ms),
    recordPath: entry.record_path == null ? null : String(entry.record_path),
    error: entry.error == null ? null : String(entry.error),
  }));

  return {
    webhookId,
    name: String(row.name),
    collectionPath: String(row.collection_path),
    collectionId: row.collection_id == null ? null : String(row.collection_id),
    paused: Number(row.paused) === 1,
    pauseReason: row.pause_reason == null ? null : String(row.pause_reason),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    lastDeliveryAtMs: row.last_delivery_at_ms == null ? null : Number(row.last_delivery_at_ms),
    ...(row.form_json == null ? {} : { form: storedForm(row.form_json)! }),
    pendingCount: Number(pendingRow?.count ?? 0),
    recentDeliveries,
  };
}

export function listIncomingWebhooks(
  storage: StorageContext,
  workspaceId: string,
): IncomingWebhookSummary[] {
  const rows = storage.db
    .prepare(
      `SELECT webhook_id, name, collection_path, collection_id, paused, pause_reason,
              created_at_ms, updated_at_ms, last_delivery_at_ms, form_json
         FROM sync_relay_incoming_webhooks
         WHERE workspace_id = ?
         ORDER BY created_at_ms ASC, webhook_id ASC`,
    )
    .all(workspaceId);
  return rows.map((row) => summaryForRow(storage, row));
}

export type CreateIncomingWebhookResult =
  | {
      readonly ok: true;
      readonly webhook: IncomingWebhookSummary;
      readonly webhooks: IncomingWebhookSummary[];
    }
  | {
      readonly ok: false;
      readonly reason:
        | "unauthorized"
        | "invalid-collection"
        | "collection-not-found"
        | "collection-shared"
        | "limit-reached"
        | "automation-server-disabled"
        | "automation-server-full"
        | "host-not-server";
      readonly limit?: number;
      readonly count?: number;
    };

export function createIncomingWebhook(
  storage: StorageContext,
  input: {
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly webhookId: string;
    readonly name: string;
    readonly collectionPath: string;
    readonly form: IncomingWebhookForm | null;
    readonly tokenHash: string;
    readonly nowMs: number;
    readonly automationServer: AutomationServer | null;
  },
): CreateIncomingWebhookResult {
  if (input.automationServer === null) {
    return { ok: false, reason: "automation-server-disabled" };
  }
  const normalizedPath = normalizeIncomingWebhookCollectionPath(input.collectionPath);
  if (normalizedPath === null) {
    return { ok: false, reason: "invalid-collection" };
  }
  const now = Math.trunc(input.nowMs);

  // Pre-check authority and assign the server as automation host when the workspace has no host yet.
  // Runs outside the INSERT transaction because chooseAutomationHost manages its own transaction.
  if (!ownerMayMutateWorkspace(storage, input.workspaceId, input.ownerUserId)) {
    return { ok: false, reason: "unauthorized" };
  }
  const initialHost = readAutomationHostRow(storage, input.workspaceId);
  if (initialHost !== null && initialHost.installId !== AUTOMATION_SERVER_INSTALL_ID) {
    return { ok: false, reason: "host-not-server" };
  }
  if (initialHost === null) {
    const preCountRow = storage.db
      .prepare("SELECT COUNT(*) AS count FROM sync_relay_incoming_webhooks WHERE workspace_id = ?")
      .get(input.workspaceId);
    const preCount = Number(preCountRow?.count ?? 0);
    if (preCount >= MAX_INCOMING_WEBHOOKS_PER_WORKSPACE) {
      return {
        ok: false,
        reason: "limit-reached",
        limit: MAX_INCOMING_WEBHOOKS_PER_WORKSPACE,
        count: preCount,
      };
    }
    if (
      collectionHasAnyActiveShareGrant(
        storage,
        input.workspaceId,
        input.ownerUserId,
        normalizedPath,
      )
    ) {
      return { ok: false, reason: "collection-shared" };
    }
    const preCollectionId = readCommittedDocumentCollectionId(
      storage,
      input.workspaceId,
      normalizedPath,
    );
    if (preCollectionId === null && normalizedPath !== INBOX_COLLECTION_PATH) {
      return { ok: false, reason: "collection-not-found" };
    }
    try {
      chooseAutomationHost(storage, {
        workspaceId: input.workspaceId,
        ownerUserId: input.ownerUserId,
        installId: AUTOMATION_SERVER_INSTALL_ID,
        generation: 0,
        server: input.automationServer,
        nowMs: now,
      });
    } catch (error) {
      if (error instanceof Error && error.message === AUTOMATION_SERVER_FULL) {
        return { ok: false, reason: "automation-server-full" };
      }
      if (!workspaceHasServerAutomationHost(storage, input.workspaceId)) {
        return { ok: false, reason: "host-not-server" };
      }
    }
  }

  return storage.tx((): CreateIncomingWebhookResult => {
    if (!ownerMayMutateWorkspace(storage, input.workspaceId, input.ownerUserId)) {
      return { ok: false, reason: "unauthorized" };
    }
    if (!workspaceHasServerAutomationHost(storage, input.workspaceId)) {
      return { ok: false, reason: "host-not-server" };
    }
    const countRow = storage.db
      .prepare("SELECT COUNT(*) AS count FROM sync_relay_incoming_webhooks WHERE workspace_id = ?")
      .get(input.workspaceId);
    const count = Number(countRow?.count ?? 0);
    if (count >= MAX_INCOMING_WEBHOOKS_PER_WORKSPACE) {
      return {
        ok: false,
        reason: "limit-reached",
        limit: MAX_INCOMING_WEBHOOKS_PER_WORKSPACE,
        count,
      };
    }
    if (
      collectionHasAnyActiveShareGrant(
        storage,
        input.workspaceId,
        input.ownerUserId,
        normalizedPath,
      )
    ) {
      return { ok: false, reason: "collection-shared" };
    }
    const collectionId = readCommittedDocumentCollectionId(
      storage,
      input.workspaceId,
      normalizedPath,
    );
    if (collectionId === null && normalizedPath !== INBOX_COLLECTION_PATH) {
      return { ok: false, reason: "collection-not-found" };
    }

    const formJson = input.form ? JSON.stringify(input.form) : null;
    const storageBytes =
      Buffer.byteLength(input.webhookId, "utf8") +
      Buffer.byteLength(input.name, "utf8") +
      Buffer.byteLength(normalizedPath, "utf8") +
      (collectionId ? Buffer.byteLength(collectionId, "utf8") : 0) +
      (formJson ? Buffer.byteLength(formJson, "utf8") : 0) +
      128;
    assertWorkspaceQuota(storage, input.workspaceId, storageBytes);

    storage.db
      .prepare(
        `INSERT INTO sync_relay_incoming_webhooks (
            webhook_id, workspace_id, name, collection_path, collection_id,
            token_hash, paused, pause_reason, created_at_ms, updated_at_ms,
            last_delivery_at_ms, daily_cap_notified_day, storage_bytes, form_json
          ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        input.webhookId,
        input.workspaceId,
        input.name,
        normalizedPath,
        collectionId,
        input.tokenHash,
        now,
        now,
        storageBytes,
        formJson,
      );

    const webhooks = listIncomingWebhooks(storage, input.workspaceId);
    const webhook = webhooks.find((entry) => entry.webhookId === input.webhookId)!;
    return { ok: true, webhook, webhooks };
  });
}

export type UpdateIncomingWebhookResult =
  | {
      readonly ok: true;
      readonly webhook: IncomingWebhookSummary;
      readonly webhooks: IncomingWebhookSummary[];
    }
  | {
      readonly ok: false;
      readonly reason:
        | "unauthorized"
        | "not-found"
        | "collection-shared"
        | "automation-server-disabled"
        | "host-not-server";
    };

export function updateIncomingWebhook(
  storage: StorageContext,
  input: {
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly webhookId: string;
    readonly name?: string;
    readonly paused?: boolean;
    readonly automationServerEnabled: boolean;
    readonly nowMs: number;
  },
): UpdateIncomingWebhookResult {
  const now = Math.trunc(input.nowMs);
  return storage.tx(() => {
    if (!ownerMayMutateWorkspace(storage, input.workspaceId, input.ownerUserId)) {
      return { ok: false, reason: "unauthorized" };
    }
    const existing = storage.db
      .prepare(
        `SELECT webhook_id, name, collection_path, collection_id, paused, pause_reason, storage_bytes, form_json
           FROM sync_relay_incoming_webhooks
           WHERE workspace_id = ? AND webhook_id = ?`,
      )
      .get(input.workspaceId, input.webhookId);
    if (!existing) return { ok: false, reason: "not-found" };

    const nextName = input.name ?? String(existing.name);
    const wasPaused = Number(existing.paused) === 1;
    const nextPaused = input.paused ?? wasPaused;
    const collectionPath = String(existing.collection_path);
    if (!nextPaused && input.paused === false) {
      if (!input.automationServerEnabled) {
        return { ok: false, reason: "automation-server-disabled" };
      }
      if (!workspaceHasServerAutomationHost(storage, input.workspaceId)) {
        return { ok: false, reason: "host-not-server" };
      }
    }
    if (!nextPaused) {
      if (
        collectionHasAnyActiveShareGrant(
          storage,
          input.workspaceId,
          input.ownerUserId,
          collectionPath,
        )
      ) {
        return { ok: false, reason: "collection-shared" };
      }
    }
    const nextPauseReason = nextPaused
      ? input.paused === true
        ? "Paused by workspace owner."
        : existing.pause_reason == null
          ? null
          : String(existing.pause_reason)
      : null;

    const nextStorageBytes =
      Buffer.byteLength(input.webhookId, "utf8") +
      Buffer.byteLength(nextName, "utf8") +
      Buffer.byteLength(collectionPath, "utf8") +
      (existing.collection_id ? Buffer.byteLength(String(existing.collection_id), "utf8") : 0) +
      (existing.form_json ? Buffer.byteLength(String(existing.form_json), "utf8") : 0) +
      128;
    const prevStorageBytes = Number(existing.storage_bytes);
    if (nextStorageBytes > prevStorageBytes) {
      assertWorkspaceQuota(storage, input.workspaceId, nextStorageBytes - prevStorageBytes);
    }

    storage.db
      .prepare(
        `UPDATE sync_relay_incoming_webhooks
            SET name = ?, paused = ?, pause_reason = ?,
                updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END,
                storage_bytes = ?
          WHERE workspace_id = ? AND webhook_id = ?`,
      )
      .run(
        nextName,
        nextPaused ? 1 : 0,
        nextPauseReason,
        now,
        now,
        nextStorageBytes,
        input.workspaceId,
        input.webhookId,
      );

    const webhooks = listIncomingWebhooks(storage, input.workspaceId);
    const webhook = webhooks.find((entry) => entry.webhookId === input.webhookId)!;
    return { ok: true, webhook, webhooks };
  });
}

export type RotateIncomingWebhookResult =
  | {
      readonly ok: true;
      readonly webhook: IncomingWebhookSummary;
      readonly webhooks: IncomingWebhookSummary[];
    }
  | { readonly ok: false; readonly reason: "unauthorized" | "not-found" };

export function rotateIncomingWebhookToken(
  storage: StorageContext,
  input: {
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly webhookId: string;
    readonly newTokenHash: string;
    readonly nowMs: number;
  },
): RotateIncomingWebhookResult {
  const now = Math.trunc(input.nowMs);
  return storage.tx(() => {
    if (!ownerMayMutateWorkspace(storage, input.workspaceId, input.ownerUserId)) {
      return { ok: false, reason: "unauthorized" };
    }
    const result = storage.db
      .prepare(
        `UPDATE sync_relay_incoming_webhooks
            SET token_hash = ?,
                updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
          WHERE workspace_id = ? AND webhook_id = ?`,
      )
      .run(input.newTokenHash, now, now, input.workspaceId, input.webhookId);
    if (result.changes === 0) return { ok: false, reason: "not-found" };
    const webhooks = listIncomingWebhooks(storage, input.workspaceId);
    const webhook = webhooks.find((entry) => entry.webhookId === input.webhookId)!;
    return { ok: true, webhook, webhooks };
  });
}

export type DeleteIncomingWebhookResult =
  | {
      readonly ok: true;
      readonly deleted: boolean;
      readonly webhooks: IncomingWebhookSummary[];
    }
  | { readonly ok: false; readonly reason: "unauthorized" };

export function deleteIncomingWebhook(
  storage: StorageContext,
  workspaceId: string,
  ownerUserId: string,
  webhookId: string,
): DeleteIncomingWebhookResult {
  return storage.tx(() => {
    if (!ownerMayMutateWorkspace(storage, workspaceId, ownerUserId)) {
      return { ok: false, reason: "unauthorized" };
    }
    const deleted =
      storage.db
        .prepare(
          "DELETE FROM sync_relay_incoming_webhooks WHERE workspace_id = ? AND webhook_id = ?",
        )
        .run(workspaceId, webhookId).changes > 0;
    return { ok: true, deleted, webhooks: listIncomingWebhooks(storage, workspaceId) };
  });
}

export interface ResolvedIncomingWebhook {
  readonly webhookId: string;
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly collectionPath: string;
  readonly collectionId: string | null;
  readonly tokenHash: string;
  readonly form: IncomingWebhookForm | null;
  readonly hostReady: boolean;
}

export function lookupActiveIncomingWebhookByToken(
  storage: StorageContext,
  linkKey: string | Uint8Array,
  token: string,
): ResolvedIncomingWebhook | null {
  const candidateHash = hashIncomingWebhookToken(linkKey, token);
  const row = storage.db
    .prepare(
      `SELECT w.webhook_id, w.workspace_id, w.name, w.collection_path, w.collection_id,
              w.token_hash, w.paused, w.form_json, ws.owner_user_id
         FROM sync_relay_incoming_webhooks w
         JOIN sync_relay_workspaces ws ON ws.workspace_id = w.workspace_id
        WHERE w.token_hash = ?
        LIMIT 1`,
    )
    .get(candidateHash);
  if (!row) return null;
  if (!constantTimeHexEqual(String(row.token_hash), candidateHash)) return null;
  if (Number(row.paused) === 1) return null;
  const workspaceId = String(row.workspace_id);
  const ownerUserId = String(row.owner_user_id);
  if (workspaceIsDeleted(storage, workspaceId) || accountIsFenced(storage, ownerUserId)) {
    return null;
  }
  return {
    webhookId: String(row.webhook_id),
    workspaceId,
    ownerUserId,
    name: String(row.name),
    collectionPath: String(row.collection_path),
    collectionId: row.collection_id == null ? null : String(row.collection_id),
    tokenHash: candidateHash,
    form: storedForm(row.form_json),
    hostReady: workspaceHasServerAutomationHost(storage, workspaceId),
  };
}

export function precheckIncomingWebhookBudgets(
  storage: StorageContext,
  webhookId: string,
  workspaceId: string,
  nowMs: number,
  deliveryKey?: string | null,
):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "daily-cap" | "pending-count" | "pending-bytes" | "form-pending-count";
      readonly current: number;
      readonly limit: number;
      readonly shouldNotifyDailyCap?: boolean;
    } {
  if (deliveryKey) {
    const existing = storage.db
      .prepare(
        `SELECT 1 FROM sync_relay_webhook_deliveries
           WHERE webhook_id = ? AND delivery_key = ? LIMIT 1`,
      )
      .get(webhookId, deliveryKey);
    if (existing) return { ok: true };
  }
  const dayStartMs = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const dailyRow = storage.db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM sync_relay_webhook_deliveries
         WHERE webhook_id = ? AND created_at_ms >= ?`,
    )
    .get(webhookId, dayStartMs);
  const dailyCount = Number(dailyRow?.count ?? 0);
  if (dailyCount >= INCOMING_WEBHOOK_DAILY_DELIVERY_CAP) {
    const shouldNotifyDailyCap = storage.tx(() =>
      claimDailyCapNoticeSlot(storage, webhookId, nowMs),
    );
    return {
      ok: false,
      reason: "daily-cap",
      current: dailyCount,
      limit: INCOMING_WEBHOOK_DAILY_DELIVERY_CAP,
      shouldNotifyDailyCap,
    };
  }
  const formPending = formPendingCount(storage, webhookId);
  if (formPending !== null && formPending >= MAX_INCOMING_WEBHOOK_FORM_PENDING_COUNT) {
    return {
      ok: false,
      reason: "form-pending-count",
      current: formPending,
      limit: MAX_INCOMING_WEBHOOK_FORM_PENDING_COUNT,
    };
  }
  const pendingRow = storage.db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes), 0) AS bytes
         FROM sync_relay_webhook_deliveries
         WHERE workspace_id = ? AND state IN ('pending', 'accepted')`,
    )
    .get(workspaceId);
  const pendingCount = Number(pendingRow?.count ?? 0);
  if (pendingCount >= MAX_INCOMING_WEBHOOK_PENDING_COUNT) {
    return {
      ok: false,
      reason: "pending-count",
      current: pendingCount,
      limit: MAX_INCOMING_WEBHOOK_PENDING_COUNT,
    };
  }
  const pendingBytes = Number(pendingRow?.bytes ?? 0);
  if (pendingBytes >= MAX_INCOMING_WEBHOOK_PENDING_BYTES) {
    return {
      ok: false,
      reason: "pending-bytes",
      current: pendingBytes,
      limit: MAX_INCOMING_WEBHOOK_PENDING_BYTES,
    };
  }
  return { ok: true };
}

export type EnqueueIncomingWebhookDeliveryResult =
  | {
      readonly ok: true;
      readonly deliveryId: string;
      readonly deduplicated: boolean;
      readonly workspaceId: string;
      readonly ownerUserId: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "not-found"
        | "host-unavailable"
        | "idempotency-conflict"
        | "daily-cap"
        | "pending-count"
        | "pending-bytes"
        | "form-pending-count";
      readonly shouldNotifyDailyCap?: boolean;
      readonly ownerUserId?: string;
      readonly workspaceId?: string;
      readonly webhookName?: string;
      readonly collectionPath?: string;
      readonly current?: number;
      readonly limit?: number;
    };

export function pruneExpiredIncomingWebhookDeliveries(
  storage: StorageContext,
  nowMs: number,
  workspaceId?: string,
): number {
  const cutoff = Math.max(0, Math.trunc(nowMs) - INCOMING_WEBHOOK_IDEMPOTENCY_RETENTION_MS);
  if (workspaceId !== undefined) {
    return storage.db
      .prepare(
        `DELETE FROM sync_relay_webhook_deliveries
          WHERE delivery_id IN (
            SELECT delivery_id FROM sync_relay_webhook_deliveries
             WHERE workspace_id = ?
               AND state IN ('settled', 'failed', 'paused')
               AND settled_at_ms IS NOT NULL
               AND settled_at_ms < ?
             ORDER BY settled_at_ms ASC
             LIMIT ?
          )`,
      )
      .run(workspaceId, cutoff, PRUNE_BATCH_SIZE).changes;
  }
  return storage.db
    .prepare(
      `DELETE FROM sync_relay_webhook_deliveries
        WHERE delivery_id IN (
          SELECT delivery_id FROM sync_relay_webhook_deliveries
           WHERE state IN ('settled', 'failed', 'paused')
             AND settled_at_ms IS NOT NULL
             AND settled_at_ms < ?
           ORDER BY settled_at_ms ASC
           LIMIT ?
        )`,
    )
    .run(cutoff, PRUNE_BATCH_SIZE).changes;
}

export function enqueueIncomingWebhookDelivery(
  storage: StorageContext,
  input: {
    readonly webhookId: string;
    readonly expectedTokenHash: string;
    readonly deliveryId: string;
    readonly deliveryKey: string | null;
    readonly payloadSha256: string;
    readonly contentType: string;
    readonly headersJson: string;
    readonly payloadBlob: Uint8Array;
    readonly chainDepth: number;
    readonly automationServerEnabled: boolean;
    readonly nowMs: number;
  },
): EnqueueIncomingWebhookDeliveryResult {
  const now = Math.trunc(input.nowMs);
  const dayStartMs = Math.floor(now / 86_400_000) * 86_400_000;

  return storage.tx(() => {
    const row = storage.db
      .prepare(
        `SELECT w.webhook_id, w.workspace_id, w.name, w.collection_path, w.token_hash, w.paused,
                ws.owner_user_id
           FROM sync_relay_incoming_webhooks w
           JOIN sync_relay_workspaces ws ON ws.workspace_id = w.workspace_id
          WHERE w.webhook_id = ?
          LIMIT 1`,
      )
      .get(input.webhookId);
    if (!row || Number(row.paused) === 1) {
      return { ok: false, reason: "not-found" };
    }
    if (!constantTimeHexEqual(String(row.token_hash), input.expectedTokenHash)) {
      return { ok: false, reason: "not-found" };
    }
    const workspaceId = String(row.workspace_id);
    const ownerUserId = String(row.owner_user_id);
    const collectionPath = String(row.collection_path);
    const webhookName = String(row.name);
    if (workspaceIsDeleted(storage, workspaceId) || accountIsFenced(storage, ownerUserId)) {
      return { ok: false, reason: "not-found" };
    }
    if (collectionHasAnyActiveShareGrant(storage, workspaceId, ownerUserId, collectionPath)) {
      storage.db
        .prepare(
          `UPDATE sync_relay_incoming_webhooks
              SET paused = 1, pause_reason = ?,
                  updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
            WHERE webhook_id = ?`,
        )
        .run(SHARE_PAUSE_REASON, now, now, input.webhookId);
      return { ok: false, reason: "not-found" };
    }
    if (!input.automationServerEnabled || !workspaceHasServerAutomationHost(storage, workspaceId)) {
      return { ok: false, reason: "host-unavailable" };
    }

    pruneExpiredIncomingWebhookDeliveries(storage, now, workspaceId);

    // 7-day idempotency check by (webhook_id, delivery_key).
    if (input.deliveryKey !== null) {
      const existing = storage.db
        .prepare(
          `SELECT delivery_id, payload_sha256
             FROM sync_relay_webhook_deliveries
             WHERE webhook_id = ? AND delivery_key = ?
             LIMIT 1`,
        )
        .get(input.webhookId, input.deliveryKey);
      if (existing) {
        if (String(existing.payload_sha256) === input.payloadSha256) {
          return {
            ok: true,
            deliveryId: String(existing.delivery_id),
            deduplicated: true,
            workspaceId,
            ownerUserId,
          };
        }
        return { ok: false, reason: "idempotency-conflict" };
      }
    }

    // Per-endpoint daily delivery cap (500/day) with once-per-day owner Notice gating.
    const dailyRow = storage.db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM sync_relay_webhook_deliveries
           WHERE webhook_id = ? AND created_at_ms >= ?`,
      )
      .get(input.webhookId, dayStartMs);
    const dailyCount = Number(dailyRow?.count ?? 0);
    if (dailyCount >= INCOMING_WEBHOOK_DAILY_DELIVERY_CAP) {
      const shouldNotifyDailyCap = claimDailyCapNoticeSlot(storage, input.webhookId, now);
      return {
        ok: false,
        reason: "daily-cap",
        shouldNotifyDailyCap,
        ownerUserId,
        workspaceId,
        webhookName,
        collectionPath,
        current: dailyCount,
        limit: INCOMING_WEBHOOK_DAILY_DELIVERY_CAP,
      };
    }

    const formPending = formPendingCount(storage, input.webhookId);
    if (formPending !== null && formPending >= MAX_INCOMING_WEBHOOK_FORM_PENDING_COUNT) {
      return {
        ok: false,
        reason: "form-pending-count",
        current: formPending,
        limit: MAX_INCOMING_WEBHOOK_FORM_PENDING_COUNT,
      };
    }

    // Dedicated per-workspace pending count + pending byte budget (checked atomically).
    const payloadBytes = input.payloadBlob.byteLength;
    const pendingRow = storage.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes), 0) AS bytes
           FROM sync_relay_webhook_deliveries
           WHERE workspace_id = ? AND state IN ('pending', 'accepted')`,
      )
      .get(workspaceId);
    const pendingCount = Number(pendingRow?.count ?? 0);
    if (pendingCount >= MAX_INCOMING_WEBHOOK_PENDING_COUNT) {
      return {
        ok: false,
        reason: "pending-count",
        current: pendingCount,
        limit: MAX_INCOMING_WEBHOOK_PENDING_COUNT,
      };
    }
    const pendingBytes = Number(pendingRow?.bytes ?? 0);
    if (pendingBytes + payloadBytes > MAX_INCOMING_WEBHOOK_PENDING_BYTES) {
      return {
        ok: false,
        reason: "pending-bytes",
        current: pendingBytes + payloadBytes,
        limit: MAX_INCOMING_WEBHOOK_PENDING_BYTES,
      };
    }

    const storageBytes =
      payloadBytes +
      Buffer.byteLength(input.headersJson, "utf8") +
      Buffer.byteLength(input.deliveryId, "utf8") +
      128;
    assertWorkspaceQuota(storage, workspaceId, storageBytes);

    storage.db
      .prepare(
        `INSERT INTO sync_relay_webhook_deliveries (
            delivery_id, webhook_id, workspace_id, delivery_key, payload_sha256,
            content_type, headers_json, payload_blob, payload_bytes, chain_depth,
            state, accepted_by, accepted_generation, accepted_lease_id,
            attempt_count, next_attempt_at_ms, record_path, error,
            created_at_ms, updated_at_ms, settled_at_ms, storage_bytes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, 0, 0, NULL, NULL, ?, ?, NULL, ?)`,
      )
      .run(
        input.deliveryId,
        input.webhookId,
        workspaceId,
        input.deliveryKey,
        input.payloadSha256,
        input.contentType,
        input.headersJson,
        input.payloadBlob,
        payloadBytes,
        Math.trunc(input.chainDepth),
        now,
        now,
        storageBytes,
      );

    storage.db
      .prepare(
        `UPDATE sync_relay_incoming_webhooks
            SET last_delivery_at_ms = ?,
                updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
          WHERE webhook_id = ?`,
      )
      .run(now, now, now, input.webhookId);

    return {
      ok: true,
      deliveryId: input.deliveryId,
      deduplicated: false,
      workspaceId,
      ownerUserId,
    };
  });
}

export interface ClaimedIncomingWebhookDelivery {
  readonly deliveryId: string;
  readonly webhookId: string;
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly webhookName: string;
  readonly collectionPath: string;
  readonly collectionId: string | null;
  readonly contentType: string;
  readonly headersJson: string;
  readonly payloadBytes: Uint8Array;
  readonly chainDepth: number;
  readonly createdAtMs: number;
  readonly acceptedGeneration: number;
  readonly acceptedLeaseId: string;
}

export function recoverAcceptedIncomingWebhookDeliveries(
  storage: StorageContext,
  input: {
    readonly workspaceId: string;
    readonly installId: string;
    readonly nowMs: number;
  },
): number {
  const now = Math.trunc(input.nowMs);
  return storage.tx(() => {
    const result = storage.db
      .prepare(
        `UPDATE sync_relay_webhook_deliveries
            SET state = 'pending',
                accepted_by = NULL,
                accepted_generation = NULL,
                accepted_lease_id = NULL,
                next_attempt_at_ms = 0,
                updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
          WHERE workspace_id = ?
            AND state = 'accepted'
            AND accepted_by = ?`,
      )
      .run(now, now, input.workspaceId, input.installId);
    return Number(result.changes);
  });
}

export function claimNextIncomingWebhookDelivery(
  storage: StorageContext,
  input: {
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly installId: string;
    readonly generation: number;
    readonly leaseId: string;
    readonly nowMs: number;
  },
): ClaimedIncomingWebhookDelivery | null {
  const now = Math.trunc(input.nowMs);
  return storage.tx(() => {
    if (!ownerMayMutateWorkspace(storage, input.workspaceId, input.ownerUserId)) return null;
    const host = readAutomationHostRow(storage, input.workspaceId);
    if (
      host === null ||
      host.installId !== input.installId ||
      host.handoverFrom !== null ||
      host.generation !== input.generation
    ) {
      return null;
    }

    // Claim either a ready 'pending' delivery or a stale 'accepted' delivery from an earlier generation or crashed lease.
    const candidates = storage.db
      .prepare(
        `SELECT d.delivery_id, d.webhook_id, d.content_type, d.headers_json, d.payload_blob,
                d.chain_depth, d.created_at_ms, w.name, w.collection_path, w.collection_id, w.paused
           FROM sync_relay_webhook_deliveries d
           JOIN sync_relay_incoming_webhooks w ON w.webhook_id = d.webhook_id
          WHERE d.workspace_id = ?
            AND (
              (d.state = 'pending' AND d.next_attempt_at_ms <= ?)
              OR (
                d.state = 'accepted'
                AND (
                  d.accepted_by <> ?
                  OR d.accepted_generation IS NULL
                  OR d.accepted_generation < ?
                  OR (
                    d.accepted_generation = ?
                    AND (d.accepted_lease_id IS NULL OR d.accepted_lease_id <> ?)
                  )
                )
              )
            )
          ORDER BY d.created_at_ms ASC, d.delivery_id ASC
          LIMIT 25`,
      )
      .all(
        input.workspaceId,
        now,
        input.installId,
        input.generation,
        input.generation,
        input.leaseId,
      );

    for (const row of candidates) {
      const deliveryId = String(row.delivery_id);
      const webhookId = String(row.webhook_id);
      const collectionPath = String(row.collection_path);
      const isPaused = Number(row.paused) === 1;
      const isShared = collectionHasAnyActiveShareGrant(
        storage,
        input.workspaceId,
        input.ownerUserId,
        collectionPath,
      );
      if (isPaused || isShared) {
        const reason = isShared ? SHARE_PAUSE_REASON : "Webhook is paused.";
        if (isShared && !isPaused) {
          storage.db
            .prepare(
              `UPDATE sync_relay_incoming_webhooks
                  SET paused = 1, pause_reason = ?,
                      updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
                WHERE webhook_id = ?`,
            )
            .run(SHARE_PAUSE_REASON, now, now, webhookId);
        }
        storage.db
          .prepare(
            `UPDATE sync_relay_webhook_deliveries
                SET state = 'paused',
                    payload_blob = NULL,
                    payload_bytes = 0,
                    storage_bytes = 0,
                    accepted_by = NULL,
                    accepted_generation = NULL,
                    accepted_lease_id = NULL,
                    next_attempt_at_ms = 0,
                    error = ?,
                    settled_at_ms = ?,
                    updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
              WHERE delivery_id = ?`,
          )
          .run(reason, now, now, now, deliveryId);
        continue;
      }

      storage.db
        .prepare(
          `UPDATE sync_relay_webhook_deliveries
              SET state = 'accepted',
                  accepted_by = ?,
                  accepted_generation = ?,
                  accepted_lease_id = ?,
                  updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
            WHERE delivery_id = ?`,
        )
        .run(input.installId, input.generation, input.leaseId, now, now, deliveryId);

      const rawBlob = row.payload_blob;
      const payloadBytes =
        rawBlob instanceof Uint8Array
          ? rawBlob
          : rawBlob
            ? new Uint8Array(rawBlob as ArrayBuffer)
            : new Uint8Array();
      return {
        deliveryId,
        webhookId,
        workspaceId: input.workspaceId,
        ownerUserId: input.ownerUserId,
        webhookName: String(row.name),
        collectionPath,
        collectionId: row.collection_id == null ? null : String(row.collection_id),
        contentType: String(row.content_type),
        headersJson: String(row.headers_json),
        payloadBytes,
        chainDepth: Number(row.chain_depth ?? 0),
        createdAtMs: Number(row.created_at_ms),
        acceptedGeneration: input.generation,
        acceptedLeaseId: input.leaseId,
      };
    }

    return null;
  });
}

export function verifyIncomingWebhookPublicationAuthority(
  storage: StorageContext,
  input: {
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly webhookId: string;
    readonly deliveryId: string;
    readonly installId: string;
    readonly generation: number;
    readonly leaseId: string;
  },
):
  | { readonly ok: true; readonly collectionPath: string; readonly collectionId: string | null }
  | {
      readonly ok: false;
      readonly reason: "fenced" | "delivery-changed" | "paused" | "shared" | "missing";
    } {
  if (!ownerMayMutateWorkspace(storage, input.workspaceId, input.ownerUserId)) {
    return { ok: false, reason: "fenced" };
  }
  const host = readAutomationHostRow(storage, input.workspaceId);
  if (
    host === null ||
    host.installId !== input.installId ||
    host.handoverFrom !== null ||
    host.generation !== input.generation
  ) {
    return { ok: false, reason: "fenced" };
  }
  const delivery = storage.db
    .prepare(
      `SELECT state, accepted_by, accepted_generation, accepted_lease_id
         FROM sync_relay_webhook_deliveries
         WHERE workspace_id = ? AND delivery_id = ? LIMIT 1`,
    )
    .get(input.workspaceId, input.deliveryId);
  if (
    !delivery ||
    String(delivery.state) !== "accepted" ||
    String(delivery.accepted_by) !== input.installId ||
    Number(delivery.accepted_generation) !== input.generation ||
    String(delivery.accepted_lease_id) !== input.leaseId
  ) {
    return { ok: false, reason: "delivery-changed" };
  }
  const webhook = storage.db
    .prepare(
      `SELECT collection_path, collection_id, paused
         FROM sync_relay_incoming_webhooks
         WHERE workspace_id = ? AND webhook_id = ? LIMIT 1`,
    )
    .get(input.workspaceId, input.webhookId);
  if (!webhook) return { ok: false, reason: "missing" };
  if (Number(webhook.paused) === 1) return { ok: false, reason: "paused" };
  const collectionPath = String(webhook.collection_path);
  if (
    collectionHasAnyActiveShareGrant(storage, input.workspaceId, input.ownerUserId, collectionPath)
  ) {
    return { ok: false, reason: "shared" };
  }
  return {
    ok: true,
    collectionPath,
    collectionId: webhook.collection_id == null ? null : String(webhook.collection_id),
  };
}

export function settleIncomingWebhookDelivery(
  storage: StorageContext,
  input: {
    readonly workspaceId: string;
    readonly webhookId: string;
    readonly deliveryId: string;
    readonly installId: string;
    readonly generation: number;
    readonly leaseId: string;
    readonly state: "settled" | "failed" | "paused";
    readonly recordPath?: string | null;
    readonly error?: string | null;
    readonly boundCollectionId?: string | null;
    readonly pauseWebhookReason?: string | null;
    readonly nowMs: number;
  },
): boolean {
  const now = Math.trunc(input.nowMs);
  return storage.tx(() => {
    const existing = storage.db
      .prepare(
        `SELECT state, accepted_by, accepted_generation, accepted_lease_id
           FROM sync_relay_webhook_deliveries
           WHERE workspace_id = ? AND delivery_id = ? LIMIT 1`,
      )
      .get(input.workspaceId, input.deliveryId);
    if (
      !existing ||
      String(existing.state) !== "accepted" ||
      String(existing.accepted_by) !== input.installId ||
      Number(existing.accepted_generation) !== input.generation ||
      String(existing.accepted_lease_id) !== input.leaseId
    ) {
      return false;
    }

    const boundedError = input.error ? truncateUtf8Bytes(input.error, MAX_ERROR_BYTES) : null;
    storage.db
      .prepare(
        `UPDATE sync_relay_webhook_deliveries
            SET state = ?,
                payload_blob = NULL,
                payload_bytes = 0,
                storage_bytes = 0,
                accepted_by = NULL,
                accepted_generation = NULL,
                accepted_lease_id = NULL,
                next_attempt_at_ms = 0,
                record_path = ?,
                error = ?,
                settled_at_ms = ?,
                updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
          WHERE workspace_id = ? AND delivery_id = ?`,
      )
      .run(
        input.state,
        input.recordPath ?? null,
        boundedError,
        now,
        now,
        now,
        input.workspaceId,
        input.deliveryId,
      );

    if (input.boundCollectionId) {
      storage.db
        .prepare(
          `UPDATE sync_relay_incoming_webhooks
              SET collection_id = COALESCE(collection_id, ?),
                  updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
            WHERE workspace_id = ? AND webhook_id = ?`,
        )
        .run(input.boundCollectionId, now, now, input.workspaceId, input.webhookId);
    }

    if (input.pauseWebhookReason) {
      storage.db
        .prepare(
          `UPDATE sync_relay_incoming_webhooks
              SET paused = 1,
                  pause_reason = ?,
                  updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
            WHERE workspace_id = ? AND webhook_id = ?`,
        )
        .run(
          truncateUtf8Bytes(input.pauseWebhookReason, MAX_ERROR_BYTES),
          now,
          now,
          input.workspaceId,
          input.webhookId,
        );
    }

    return true;
  });
}

export function releaseAcceptedIncomingWebhookDelivery(
  storage: StorageContext,
  input: {
    readonly workspaceId: string;
    readonly deliveryId: string;
    readonly installId: string;
    readonly generation: number;
    readonly leaseId: string;
    readonly nowMs: number;
  },
): void {
  const now = Math.trunc(input.nowMs);
  storage.tx(() => {
    storage.db
      .prepare(
        `UPDATE sync_relay_webhook_deliveries
            SET state = 'pending',
                accepted_by = NULL,
                accepted_generation = NULL,
                accepted_lease_id = NULL,
                updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
          WHERE workspace_id = ?
            AND delivery_id = ?
            AND state = 'accepted'
            AND accepted_by = ?
            AND accepted_generation = ?
            AND accepted_lease_id = ?`,
      )
      .run(
        now,
        now,
        input.workspaceId,
        input.deliveryId,
        input.installId,
        input.generation,
        input.leaseId,
      );
  });
}

export type RecordFailedIncomingWebhookAttemptResult =
  | { readonly outcome: "ignored" }
  | { readonly outcome: "retry"; readonly attemptCount: number; readonly nextAttemptAtMs: number }
  | { readonly outcome: "failed"; readonly attemptCount: number };

export function recordFailedIncomingWebhookAttempt(
  storage: StorageContext,
  input: {
    readonly workspaceId: string;
    readonly deliveryId: string;
    readonly installId: string;
    readonly generation: number;
    readonly leaseId: string;
    readonly error: string;
    readonly nowMs: number;
  },
): RecordFailedIncomingWebhookAttemptResult {
  const now = Math.trunc(input.nowMs);
  const boundedError = truncateUtf8Bytes(input.error, MAX_ERROR_BYTES);
  return storage.tx(() => {
    const existing = storage.db
      .prepare(
        `SELECT state, accepted_by, accepted_generation, accepted_lease_id, attempt_count
           FROM sync_relay_webhook_deliveries
          WHERE workspace_id = ? AND delivery_id = ? LIMIT 1`,
      )
      .get(input.workspaceId, input.deliveryId);
    if (
      !existing ||
      String(existing.state) !== "accepted" ||
      String(existing.accepted_by) !== input.installId ||
      Number(existing.accepted_generation) !== input.generation ||
      String(existing.accepted_lease_id) !== input.leaseId
    ) {
      return { outcome: "ignored" };
    }

    const nextAttemptCount = Number(existing.attempt_count ?? 0) + 1;
    if (nextAttemptCount >= MAX_INCOMING_WEBHOOK_DRAIN_ATTEMPTS) {
      storage.db
        .prepare(
          `UPDATE sync_relay_webhook_deliveries
              SET state = 'failed',
                  attempt_count = ?,
                  next_attempt_at_ms = 0,
                  accepted_by = NULL,
                  accepted_generation = NULL,
                  accepted_lease_id = NULL,
                  payload_blob = NULL,
                  payload_bytes = 0,
                  storage_bytes = 0,
                  error = ?,
                  settled_at_ms = ?,
                  updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
            WHERE workspace_id = ? AND delivery_id = ?`,
        )
        .run(nextAttemptCount, boundedError, now, now, now, input.workspaceId, input.deliveryId);
      return { outcome: "failed", attemptCount: nextAttemptCount };
    }

    const delayMs = Math.min(
      INCOMING_WEBHOOK_RETRY_MAX_MS,
      INCOMING_WEBHOOK_RETRY_BASE_MS * 3 ** (nextAttemptCount - 1),
    );
    const nextAttemptAtMs = now + delayMs;
    storage.db
      .prepare(
        `UPDATE sync_relay_webhook_deliveries
            SET state = 'pending',
                attempt_count = ?,
                next_attempt_at_ms = ?,
                accepted_by = NULL,
                accepted_generation = NULL,
                accepted_lease_id = NULL,
                error = ?,
                updated_at_ms = CASE WHEN updated_at_ms < ? THEN ? ELSE updated_at_ms END
          WHERE workspace_id = ? AND delivery_id = ?`,
      )
      .run(
        nextAttemptCount,
        nextAttemptAtMs,
        boundedError,
        now,
        now,
        input.workspaceId,
        input.deliveryId,
      );
    return { outcome: "retry", attemptCount: nextAttemptCount, nextAttemptAtMs };
  });
}

export function hasPendingIncomingWebhookDeliveries(
  storage: StorageContext,
  workspaceId: string,
  nowMs: number = Date.now(),
  ownerUserId?: string,
  leaseId?: string,
): boolean {
  if (ownerUserId !== undefined && !ownerMayMutateWorkspace(storage, workspaceId, ownerUserId)) {
    return false;
  }
  const host = readAutomationHostRow(storage, workspaceId);
  if (
    host === null ||
    host.installId !== AUTOMATION_SERVER_INSTALL_ID ||
    host.handoverFrom !== null
  ) {
    return false;
  }
  const now = Math.trunc(nowMs);
  if (leaseId !== undefined) {
    const row = storage.db
      .prepare(
        `SELECT 1 FROM sync_relay_webhook_deliveries
           WHERE workspace_id = ?
             AND (
               (state = 'pending' AND next_attempt_at_ms <= ?)
               OR (
                 state = 'accepted'
                 AND (
                   accepted_by <> ?
                   OR accepted_generation IS NULL
                   OR accepted_generation < ?
                   OR (
                     accepted_generation = ?
                     AND (accepted_lease_id IS NULL OR accepted_lease_id <> ?)
                   )
                 )
               )
             )
           LIMIT 1`,
      )
      .get(
        workspaceId,
        now,
        AUTOMATION_SERVER_INSTALL_ID,
        host.generation,
        host.generation,
        leaseId,
      );
    return row !== undefined;
  }
  const row = storage.db
    .prepare(
      `SELECT 1 FROM sync_relay_webhook_deliveries
         WHERE workspace_id = ?
           AND ((state = 'pending' AND next_attempt_at_ms <= ?) OR state = 'accepted')
         LIMIT 1`,
    )
    .get(workspaceId, now);
  return row !== undefined;
}

export function nextIncomingWebhookRetryAtMs(
  storage: StorageContext,
  workspaceId: string,
  ownerUserId?: string,
): number | null {
  if (ownerUserId !== undefined && !ownerMayMutateWorkspace(storage, workspaceId, ownerUserId)) {
    return null;
  }
  if (!workspaceHasServerAutomationHost(storage, workspaceId)) {
    return null;
  }
  const row = storage.db
    .prepare(
      `SELECT MIN(next_attempt_at_ms) AS next_ms
         FROM sync_relay_webhook_deliveries
        WHERE workspace_id = ? AND state = 'pending' AND next_attempt_at_ms > 0`,
    )
    .get(workspaceId);
  return row?.next_ms == null ? null : Number(row.next_ms);
}

export function workspacesWithIncomingWebhooks(storage: StorageContext): string[] {
  const rows = storage.db
    .prepare(
      `SELECT DISTINCT w.workspace_id
         FROM sync_relay_incoming_webhooks w
         JOIN sync_relay_automation_hosts h ON h.workspace_id = w.workspace_id
        WHERE h.install_id = ?
          AND (
            w.paused = 0
            OR EXISTS (
              SELECT 1 FROM sync_relay_webhook_deliveries d
               WHERE d.webhook_id = w.webhook_id AND d.state IN ('pending', 'accepted')
            )
          )`,
    )
    .all(AUTOMATION_SERVER_INSTALL_ID);
  return rows
    .map((row) => String(row.workspace_id))
    .filter((workspaceId) => {
      const owner = workspaceOwnerOf(storage, workspaceId);
      return owner !== null && !accountIsFenced(storage, owner);
    });
}
