import { isDeepStrictEqual } from "node:util";
import {
  liveAuthorIdentity,
  parseLiveAuthorSnapshot,
  type LiveAuthorSnapshot,
} from "@dohc/live-session-contract/live-authorship";
import type { StorageContext } from "./context";
import { LIVE_AUTHOR_CLIENTS } from "./liveAuthorshipSchema";
import { documentParams, parseLiveRoomAuthority } from "./liveUpdateJournal";
import type { LiveRoomAuthority, SqliteDb } from "./types";
import type { LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import { assertWorkspaceQuota } from "./workspaces";

// A live room's edits that are taken and not yet saved. A save deletes the rows it holds in its
// own journal transaction, so this table only ever holds a few seconds of a note's edits.
export const LIVE_ROOM_EDITS = "sync_relay_live_room_edits";
const MIGRATION = "live-room-edits-v1";
const DOCUMENT = "workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?";
const objects = {
  [LIVE_ROOM_EDITS]: `CREATE TABLE ${LIVE_ROOM_EDITS} (
  position INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL, main_version_id TEXT NOT NULL, object_id TEXT NOT NULL, lineage_claim_id TEXT NOT NULL,
  sender_snapshot_json TEXT NOT NULL CHECK (json_valid(sender_snapshot_json)),
  update_bytes BLOB NOT NULL CHECK (length(update_bytes) BETWEEN 1 AND 20971520),
  received_at_ms INTEGER NOT NULL,
  storage_bytes INTEGER NOT NULL CHECK (storage_bytes > 0),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
) STRICT`,
  sync_relay_live_room_edits_document: `CREATE INDEX sync_relay_live_room_edits_document ON ${LIVE_ROOM_EDITS}(workspace_id,main_version_id,object_id,lineage_claim_id,position)`,
  live_room_edit_usage_insert: `CREATE TRIGGER live_room_edit_usage_insert AFTER INSERT ON ${LIVE_ROOM_EDITS} BEGIN
    UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+NEW.storage_bytes WHERE workspace_id=NEW.workspace_id; END`,
  live_room_edit_usage_delete: `CREATE TRIGGER live_room_edit_usage_delete AFTER DELETE ON ${LIVE_ROOM_EDITS} BEGIN
    UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-OLD.storage_bytes WHERE workspace_id=OLD.workspace_id; END`,
} as const;
const normalize = (sql: string) => sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
function require(value: unknown): asserts value {
  if (!value) throw new Error("live room schema is missing or damaged");
}
function assertSchema(db: SqliteDb, objects: Readonly<Record<string, string>>): void {
  for (const [name, sql] of Object.entries(objects)) {
    const rows = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").all(name);
    require(rows.length === 1 && normalize(String(rows[0]!.sql)) === normalize(sql));
  }
}
/** Creates a migration's objects once, and checks them each time the store opens after. */
export function initializeRoomMigration(
  db: SqliteDb,
  migration: string,
  objects: Readonly<Record<string, string>>,
): void {
  if (db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(migration)) {
    assertSchema(db, objects);
    return;
  }
  const names = Object.keys(objects);
  require(
    db
      .prepare(`SELECT name FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(",")})`)
      .all(...names).length === 0,
  );
  for (const sql of Object.values(objects)) db.exec(sql);
  assertSchema(db, objects);
  db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)").run(
    migration,
    Date.now(),
  );
}
// Each room save's journal row, with the last room position it holds. An owner who catches up on
// the journal after its room closed reads it, to let go of the room edits the save holds.
export const LIVE_ROOM_SAVES = "sync_relay_live_room_saves";
const saves = {
  [LIVE_ROOM_SAVES]: `CREATE TABLE ${LIVE_ROOM_SAVES} (
  journal_cursor INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  rows_through INTEGER NOT NULL CHECK (rows_through BETWEEN 1 AND journal_cursor-1),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
) STRICT`,
} as const;
// The access each taken edit came in under. An edit taken before this table has no row here.
const LIVE_ROOM_EDIT_AUTHORITIES = "sync_relay_live_room_edit_authorities";
const authorities = {
  [LIVE_ROOM_EDIT_AUTHORITIES]: `CREATE TABLE ${LIVE_ROOM_EDIT_AUTHORITIES} (
  position INTEGER PRIMARY KEY REFERENCES ${LIVE_ROOM_EDITS}(position) ON DELETE CASCADE,
  authority_json TEXT NOT NULL CHECK (json_valid(authority_json))
) STRICT`,
} as const;
export function initializeLiveRoomSchema(db: SqliteDb): void {
  initializeRoomMigration(db, MIGRATION, objects);
  initializeRoomMigration(db, "live-room-saves-v1", saves);
  initializeRoomMigration(db, "live-room-edit-authorities-v1", authorities);
}

export interface LiveRoomEdit {
  readonly position: number;
  readonly sender: LiveAuthorSnapshot;
  /** Null for an edit taken before the room kept the access each edit came in under. */
  readonly authority: LiveRoomAuthority | null;
  readonly updateBytes: Uint8Array;
}

/**
 * The highest position any room or the journal has given out. Room positions share one rising
 * count with journal cursors, and survive a restart, so a page never sees a position go back.
 */
function highestPosition(storage: StorageContext): number {
  const row = storage.db
    .prepare(
      `SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='${LIVE_ROOM_EDITS}'),0),
        COALESCE((SELECT MAX(journal_cursor) FROM sync_relay_live_update_journal),0)) AS position`,
    )
    .get();
  return Number(row?.position ?? 0);
}
export function liveRoomPosition(storage: StorageContext): number {
  return storage.readTx(() => highestPosition(storage));
}

/** Takes the next position for a change the room passes on that has no row, such as a journal row. */
export function advanceLiveRoomPosition(storage: StorageContext): number {
  return storage.quietTx(() => {
    const position = highestPosition(storage) + 1;
    const moved = storage.db
      .prepare("UPDATE sqlite_sequence SET seq=? WHERE name=?")
      .run(position, LIVE_ROOM_EDITS);
    if (Number(moved.changes) === 0)
      storage.db
        .prepare("INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)")
        .run(LIVE_ROOM_EDITS, position);
    return position;
  });
}

/**
 * Writes one taken edit and ties its new editor ids to its sender, in one transaction. An id
 * already tied to someone else refuses the edit and writes nothing.
 */
export function appendLiveRoomEdit(
  storage: StorageContext,
  input: {
    document: LiveDocumentKey;
    sender: LiveAuthorSnapshot;
    authority: LiveRoomAuthority;
    /** Each editor id the edit adds content under, and whether the note already has content under it. */
    clients: readonly { clientId: number; inNote: boolean }[];
    updateBytes: Uint8Array;
    receivedAtMs: number;
  },
): { kind: "written"; position: number } | { kind: "refused" } {
  const params = documentParams(input.document);
  const sender = JSON.stringify(input.sender);
  const authority = JSON.stringify(parseLiveRoomAuthority(input.authority));
  const identities = input.sender.map(liveAuthorIdentity);
  // Nothing outside the room reads its edits before a save, which wakes everyone, so taking one
  // wakes no live host. A wake on every edit had each capture read its access again.
  return storage.quietTx(() => {
    const bindings: number[] = [];
    for (const { clientId, inNote } of input.clients) {
      const prior = storage.db
        .prepare(
          `SELECT author_snapshot_json FROM ${LIVE_AUTHOR_CLIENTS} WHERE ${DOCUMENT} AND client_id=?`,
        )
        .get(...params, clientId);
      // An id the note has content under and nobody is tied to belongs to the seed or the engine.
      if (!prior && inNote) return { kind: "refused" as const };
      if (!prior) bindings.push(clientId);
      else if (
        !isDeepStrictEqual(
          parseLiveAuthorSnapshot(JSON.parse(String(prior.author_snapshot_json))).map(
            liveAuthorIdentity,
          ),
          identities,
        )
      )
        return { kind: "refused" as const };
    }
    for (const clientId of bindings) {
      const storageBytes = Buffer.byteLength(JSON.stringify([...params, clientId, sender]));
      assertWorkspaceQuota(storage, input.document.workspaceId, storageBytes);
      storage.db
        .prepare(
          `INSERT INTO ${LIVE_AUTHOR_CLIENTS}(workspace_id,main_version_id,object_id,lineage_claim_id,client_id,author_snapshot_json,storage_bytes) VALUES (?,?,?,?,?,?,?)`,
        )
        .run(...params, clientId, sender, storageBytes);
    }
    const storageBytes =
      input.updateBytes.byteLength + Buffer.byteLength(sender) + Buffer.byteLength(authority) + 112;
    assertWorkspaceQuota(storage, input.document.workspaceId, storageBytes);
    const position = highestPosition(storage) + 1;
    storage.db
      .prepare(
        `INSERT INTO ${LIVE_ROOM_EDITS}(position,workspace_id,main_version_id,object_id,lineage_claim_id,sender_snapshot_json,update_bytes,received_at_ms,storage_bytes) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(position, ...params, sender, input.updateBytes, input.receivedAtMs, storageBytes);
    storage.db
      .prepare(`INSERT INTO ${LIVE_ROOM_EDIT_AUTHORITIES}(position,authority_json) VALUES (?,?)`)
      .run(position, authority);
    return { kind: "written" as const, position };
  });
}

/** A note's edits that were taken and not saved, oldest first. */
export function liveRoomEdits(storage: StorageContext, document: LiveDocumentKey): LiveRoomEdit[] {
  return storage
    .readTx(() =>
      storage.db
        .prepare(
          `SELECT e.position,e.sender_snapshot_json,e.update_bytes,a.authority_json FROM ${LIVE_ROOM_EDITS} e
            LEFT JOIN ${LIVE_ROOM_EDIT_AUTHORITIES} a ON a.position=e.position
            WHERE ${DOCUMENT} ORDER BY e.position`,
        )
        .all(...documentParams(document)),
    )
    .map((row) => ({
      position: Number(row.position),
      sender: parseLiveAuthorSnapshot(JSON.parse(String(row.sender_snapshot_json))),
      authority:
        row.authority_json === null
          ? null
          : parseLiveRoomAuthority(JSON.parse(String(row.authority_json))),
      updateBytes: new Uint8Array(row.update_bytes as Uint8Array),
    }));
}

/** Deletes a note's saved edits. Runs inside the journal transaction that commits their save. */
export function deleteSavedLiveRoomEdits(
  storage: StorageContext,
  document: LiveDocumentKey,
  throughPosition: number,
): void {
  storage.db
    .prepare(`DELETE FROM ${LIVE_ROOM_EDITS} WHERE ${DOCUMENT} AND position<=?`)
    .run(...documentParams(document), throughPosition);
}

/** Records a room save's journal row. Runs inside the journal transaction that commits it. */
export function recordLiveRoomSave(
  storage: StorageContext,
  document: LiveDocumentKey,
  journalCursor: number,
  rowsThrough: number,
): void {
  storage.db
    .prepare(
      `INSERT INTO ${LIVE_ROOM_SAVES}(journal_cursor,workspace_id,rows_through) VALUES (?,?,?)`,
    )
    .run(journalCursor, document.workspaceId, rowsThrough);
}

/** The notes with edits taken and not saved. */
export function liveRoomDocuments(storage: StorageContext): LiveDocumentKey[] {
  return storage
    .readTx(() =>
      storage.db
        .prepare(
          `SELECT DISTINCT workspace_id,main_version_id,object_id,lineage_claim_id FROM ${LIVE_ROOM_EDITS}`,
        )
        .all(),
    )
    .map((row) => ({
      workspaceId: String(row.workspace_id),
      mainVersionId: String(row.main_version_id),
      objectId: String(row.object_id),
      lineageClaimId: String(row.lineage_claim_id),
    }));
}

/** Whether the note is its object's current lineage. Edits taken on an ended one can't be saved. */
export function liveRoomLineageIsCurrent(storage: StorageContext, document: LiveDocumentKey) {
  const row = storage.readTx(() =>
    storage.db
      .prepare(
        `SELECT 1 FROM sync_relay_live_documents WHERE ${DOCUMENT} AND lineage_state='current'`,
      )
      .get(...documentParams(document)),
  );
  return row !== undefined;
}
