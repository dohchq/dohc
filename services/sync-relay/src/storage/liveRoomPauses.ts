import { createHash, randomUUID } from "node:crypto";
import {
  parseLiveAuthorSnapshot,
  type LiveAuthorSnapshot,
} from "@dohc/live-session-contract/live-authorship";
import {
  LIVE_UPDATE_REFUSAL_VALUES,
  type LiveDocumentKey,
  type LiveUpdateRefusal,
} from "@dohc/live-session-contract/live-update-admission";
import type { StorageContext } from "./context";
import { deleteSavedLiveRoomEdits, initializeRoomMigration } from "./liveRoomEdits";
import { documentParams } from "./liveUpdateJournal";
import type { SqliteDb } from "./types";

// A paused note: its room saved nothing more, and its unsaved edits are in a copy kept here until
// the owner's desktop writes it next to the note. The copy is stored in the transaction that
// deletes the room's rows, and counts toward the workspace's storage like them.
export const LIVE_ROOM_PAUSES = "sync_relay_live_room_pauses";
const objects = {
  [LIVE_ROOM_PAUSES]: `CREATE TABLE ${LIVE_ROOM_PAUSES} (
  pause_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL, main_version_id TEXT NOT NULL, object_id TEXT NOT NULL, lineage_claim_id TEXT NOT NULL,
  paused_at_ms INTEGER NOT NULL,
  saved_cursor INTEGER NOT NULL CHECK (saved_cursor >= 0),
  cause TEXT NOT NULL CHECK (cause IN ('refused','failing')),
  refusal TEXT CHECK ((cause='refused') = (refusal IS NOT NULL)),
  named_json TEXT NOT NULL CHECK (json_valid(named_json)),
  copy_bytes BLOB CHECK (copy_bytes IS NULL OR length(copy_bytes) > 0),
  copy_sha256 TEXT NOT NULL,
  storage_bytes INTEGER NOT NULL CHECK (storage_bytes > 0),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
) STRICT`,
  sync_relay_live_room_pauses_object: `CREATE INDEX sync_relay_live_room_pauses_object ON ${LIVE_ROOM_PAUSES}(workspace_id,object_id)`,
  live_room_pause_usage_insert: `CREATE TRIGGER live_room_pause_usage_insert AFTER INSERT ON ${LIVE_ROOM_PAUSES} BEGIN
    UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+NEW.storage_bytes WHERE workspace_id=NEW.workspace_id; END`,
  live_room_pause_usage_update: `CREATE TRIGGER live_room_pause_usage_update AFTER UPDATE OF storage_bytes ON ${LIVE_ROOM_PAUSES} BEGIN
    UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+NEW.storage_bytes-OLD.storage_bytes WHERE workspace_id=NEW.workspace_id; END`,
  live_room_pause_usage_delete: `CREATE TRIGGER live_room_pause_usage_delete AFTER DELETE ON ${LIVE_ROOM_PAUSES} BEGIN
    UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-OLD.storage_bytes WHERE workspace_id=OLD.workspace_id; END`,
} as const;
export function initializeLiveRoomPauseSchema(db: SqliteDb): void {
  initializeRoomMigration(db, "live-room-pauses-v1", objects);
}

export type LiveRoomPauseCause = "refused" | "failing";
export interface LiveRoomPause {
  readonly pauseId: string;
  readonly objectId: string;
  readonly lineageClaimId: string;
  /**
   * The note's last path the relay knew. A note moved or deleted outside dohc keeps the path it
   * had, so the owner's desktop can write the copy next to it.
   */
  readonly path: string;
  readonly pausedAtMs: number;
  /**
   * The journal cursor of the note's last save when it paused. The owner's computer has every
   * saved edit once it has applied its feed through here.
   */
  readonly savedCursor: number;
  /** A save refused for a reason that will not clear by itself, or saves failing for too long. */
  readonly cause: LiveRoomPauseCause;
  readonly refusal: LiveUpdateRefusal | null;
  /** Each sender in the refused save, or in the unsaved edits when saves kept failing. */
  readonly named: readonly LiveAuthorSnapshot[];
  /** Null once the owner's desktop has written the copy next to the note. */
  readonly copy: { readonly sha256: string; readonly byteLength: number } | null;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const footprint = (named: string, copyBytes: number) => copyBytes + Buffer.byteLength(named) + 256;

/**
 * Pauses a note: stores its copy and deletes every edit its room took, in one transaction. The
 * copy is never refused for the workspace's storage, since the rows it replaces held its edits.
 */
export function pauseLiveRoom(
  storage: StorageContext,
  input: {
    document: LiveDocumentKey;
    cause: LiveRoomPauseCause;
    refusal: LiveUpdateRefusal | null;
    named: readonly LiveAuthorSnapshot[];
    copy: Uint8Array;
    pausedAtMs: number;
  },
): string {
  const { document } = input;
  const named = JSON.stringify(input.named);
  const pauseId = randomUUID();
  storage.tx(() => {
    deleteSavedLiveRoomEdits(storage, document, Number.MAX_SAFE_INTEGER);
    const saved = storage.db
      .prepare(
        "SELECT COALESCE(MAX(journal_cursor),0) AS cursor FROM sync_relay_live_update_journal WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?",
      )
      .get(...documentParams(document));
    storage.db
      .prepare(
        `INSERT INTO ${LIVE_ROOM_PAUSES}(pause_id,workspace_id,main_version_id,object_id,lineage_claim_id,paused_at_ms,saved_cursor,cause,refusal,named_json,copy_bytes,copy_sha256,storage_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        pauseId,
        document.workspaceId,
        document.mainVersionId,
        document.objectId,
        document.lineageClaimId,
        input.pausedAtMs,
        Number(saved?.cursor ?? 0),
        input.cause,
        input.refusal,
        named,
        input.copy,
        sha256(input.copy),
        footprint(named, input.copy.byteLength),
      );
  });
  return pauseId;
}

/**
 * Whether a note is paused, which keeps every live edit out until its owner resumes it. A pause
 * holds only its own lineage: the one given, or else the note's current one. A pause on a lineage
 * that has since ended holds nothing back; its copy is still kept for the owner.
 */
export function liveRoomPaused(
  storage: StorageContext,
  document: {
    readonly workspaceId: string;
    readonly objectId: string;
    readonly lineageClaimId?: string;
  },
): boolean {
  const { workspaceId, objectId, lineageClaimId } = document;
  return storage.readTx(
    () =>
      (lineageClaimId === undefined
        ? storage.db
            .prepare(
              `SELECT 1 FROM ${LIVE_ROOM_PAUSES} p JOIN sync_relay_live_documents d USING (workspace_id,main_version_id,object_id,lineage_claim_id) WHERE p.workspace_id=? AND p.object_id=? AND d.lineage_state='current' LIMIT 1`,
            )
            .get(workspaceId, objectId)
        : storage.db
            .prepare(
              `SELECT 1 FROM ${LIVE_ROOM_PAUSES} WHERE workspace_id=? AND object_id=? AND lineage_claim_id=? LIMIT 1`,
            )
            .get(workspaceId, objectId, lineageClaimId)) !== undefined,
  );
}

/**
 * A note as saved: its lineage's baseline and every change its journal took. The relay keeps
 * both after the lineage ends, so a copy built on them opens on its own.
 */
export function liveRoomSavedState(
  storage: StorageContext,
  document: LiveDocumentKey,
): Uint8Array[] {
  return storage.readTx(() => {
    const where = "workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?";
    const baseline = storage.db
      .prepare(`SELECT baseline_bytes FROM sync_relay_live_documents WHERE ${where}`)
      .get(...documentParams(document));
    if (!baseline) return [];
    const journal = storage.db
      .prepare(
        `SELECT update_bytes FROM sync_relay_live_update_journal WHERE ${where} ORDER BY journal_cursor`,
      )
      .all(...documentParams(document));
    return [baseline.baseline_bytes, ...journal.map((row) => row.update_bytes)].map(
      (bytes) => new Uint8Array(bytes as Uint8Array),
    );
  });
}

/** A workspace's paused notes, oldest pause first. */
export function liveRoomPauses(storage: StorageContext, workspaceId: string): LiveRoomPause[] {
  return storage
    .readTx(() =>
      storage.db
        .prepare(
          `SELECT p.pause_id,p.object_id,p.lineage_claim_id,d.current_path,p.paused_at_ms,p.saved_cursor,p.cause,p.refusal,p.named_json,p.copy_sha256,length(p.copy_bytes) AS copy_length FROM ${LIVE_ROOM_PAUSES} p LEFT JOIN sync_relay_live_documents d USING (workspace_id,main_version_id,object_id,lineage_claim_id) WHERE p.workspace_id=? ORDER BY p.paused_at_ms,p.pause_id`,
        )
        .all(workspaceId),
    )
    .map((row) => {
      const refusal = row.refusal === null ? null : String(row.refusal);
      if (refusal !== null && !(LIVE_UPDATE_REFUSAL_VALUES as readonly string[]).includes(refusal))
        throw new Error("live room pause is damaged");
      const named: unknown = JSON.parse(String(row.named_json));
      if (!Array.isArray(named)) throw new Error("live room pause is damaged");
      // A pause is taken only for a live document, and those rows are never deleted.
      if (row.current_path === null) throw new Error("live room pause is damaged");
      return {
        pauseId: String(row.pause_id),
        objectId: String(row.object_id),
        lineageClaimId: String(row.lineage_claim_id),
        path: String(row.current_path),
        pausedAtMs: Number(row.paused_at_ms),
        savedCursor: Number(row.saved_cursor),
        cause: String(row.cause) as LiveRoomPauseCause,
        refusal: refusal as LiveUpdateRefusal | null,
        named: named.map(parseLiveAuthorSnapshot),
        copy:
          row.copy_length === null
            ? null
            : { sha256: String(row.copy_sha256), byteLength: Number(row.copy_length) },
      };
    });
}

/** A pause's copy: one Yjs update of the room's full state when it paused. */
export function liveRoomPauseCopy(
  storage: StorageContext,
  workspaceId: string,
  pauseId: string,
): Uint8Array<ArrayBuffer> | undefined {
  const row = storage.readTx(() =>
    storage.db
      .prepare(
        `SELECT copy_bytes FROM ${LIVE_ROOM_PAUSES} WHERE workspace_id=? AND pause_id=? AND copy_bytes IS NOT NULL`,
      )
      .get(workspaceId, pauseId),
  );
  return row ? new Uint8Array(row.copy_bytes as Uint8Array) : undefined;
}

/**
 * Records that the owner's desktop wrote the copy next to the note, which deletes the server's
 * copy. Only the copy's own digest does, so a stale or wrong write deletes nothing.
 */
export function recordLiveRoomCopyWritten(
  storage: StorageContext,
  workspaceId: string,
  pauseId: string,
  copySha256: string,
): "recorded" | "mismatch" | "none" {
  return storage.tx(() => {
    const row = storage.db
      .prepare(
        `SELECT copy_sha256,named_json,copy_bytes IS NULL AS written FROM ${LIVE_ROOM_PAUSES} WHERE workspace_id=? AND pause_id=?`,
      )
      .get(workspaceId, pauseId);
    if (!row) return "none";
    if (String(row.copy_sha256) !== copySha256) return "mismatch";
    if (!Number(row.written))
      storage.db
        .prepare(
          `UPDATE ${LIVE_ROOM_PAUSES} SET copy_bytes=NULL,storage_bytes=? WHERE workspace_id=? AND pause_id=?`,
        )
        .run(footprint(String(row.named_json), 0), workspaceId, pauseId);
    return "recorded";
  });
}

/** Ends a pause once its copy is written next to the note. The note then opens as last saved. */
export function resumeLiveRoom(
  storage: StorageContext,
  workspaceId: string,
  pauseId: string,
): "resumed" | "copy-unwritten" | "none" {
  return storage.tx(() => {
    const row = storage.db
      .prepare(
        `SELECT copy_bytes IS NULL AS written FROM ${LIVE_ROOM_PAUSES} WHERE workspace_id=? AND pause_id=?`,
      )
      .get(workspaceId, pauseId);
    if (!row) return "none";
    if (!Number(row.written)) return "copy-unwritten";
    storage.db
      .prepare(`DELETE FROM ${LIVE_ROOM_PAUSES} WHERE workspace_id=? AND pause_id=?`)
      .run(workspaceId, pauseId);
    return "resumed";
  });
}
