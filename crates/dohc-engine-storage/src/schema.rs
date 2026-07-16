//! The open ritual and the day-one v2 schema.
//!
//! `open_engine_db` is the **only** place pragmas are set (`PORTING.md` §9):
//! `busy_timeout`, `foreign_keys = ON`, WAL, then fingerprint validate-or-init,
//! then `quick_check`. The schema is created eagerly at `schema_version = 2`
//! (no lazy additive-upgrade dance — `plan §Day-one Rust schema`) and includes
//! the migration-ledger and request/idempotency-ledger skeletons from day one.

use crate::error::StorageError;
use crate::limits::{ENGINE_SCHEMA_VERSION, ENGINE_SQLITE_BUSY_TIMEOUT_MS};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

/// The eager v2 schema. Created inside one transaction on a fresh database.
/// Table shapes are deliberately minimal for the calibration slice but the
/// two ledger tables match the day-one design so later shards extend rather
/// than introduce them.
const V2_SCHEMA_DDL: &str = "\
-- Day-one migration ledger (STATE_OWNERSHIP.tsv row `table-migration-ledger`).
-- Append-only; one row per applied migration. The eager v2 create records
-- itself as the baseline so the ledger is never empty on a valid store.
CREATE TABLE engine_migrations (
    id         TEXT    NOT NULL PRIMARY KEY,
    checksum   TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
) STRICT;

-- Day-one request / idempotency ledger (STATE_OWNERSHIP.tsv row
-- `table-idempotency-ledger`). Written in the SAME transaction as the mutation
-- it records, so a crash after commit but before ack replays to the recorded
-- result instead of re-executing (the exactly-once contract).
CREATE TABLE engine_requests (
    request_id   TEXT    NOT NULL PRIMARY KEY,
    result_seq   INTEGER NOT NULL,
    committed_at INTEGER NOT NULL
) STRICT;

-- Minimal domain table exercised by the compound-write API.
CREATE TABLE documents (
    doc_id        TEXT    NOT NULL PRIMARY KEY,
    body          TEXT    NOT NULL,
    updated_at_ms INTEGER NOT NULL
) STRICT;

-- Replication journal. The compound write appends here in the SAME
-- transaction as the domain mutation, exercising the plan's compound-commit
-- invariant (domain mutation + journal entry commit together, or neither).
CREATE TABLE replication_journal (
    seq           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    doc_id        TEXT    NOT NULL,
    op_kind       TEXT    NOT NULL,
    created_at_ms INTEGER NOT NULL
) STRICT;
";

/// The `id` recorded for the eager baseline-create in the migration ledger.
pub(crate) const BASELINE_MIGRATION_ID: &str = "v2-baseline";
/// A stable, content-free checksum for the baseline DDL. A real migration
/// runner hashes the DDL text; the calibration slice pins a constant so the
/// ledger row is well-formed and the shape is exercised.
const BASELINE_MIGRATION_CHECKSUM: &str = "v2-baseline-eager-create";

/// The tables every valid v2 store must contain. Missing any of these on an
/// otherwise-v2-stamped database is `state-corrupt`.
const REQUIRED_TABLES: &[&str] = &[
    "engine_migrations",
    "engine_requests",
    "documents",
    "replication_journal",
];

/// Open-or-create the engine database at `path`.
///
/// - A fresh (empty) file is initialized eagerly to `schema_version = 2`.
/// - A file already at v2 is validated (required tables present, integrity ok).
/// - Any other fingerprint (e.g. a v1 TS database) is rejected with
///   [`StorageError::UnsupportedFingerprint`] — never migrated, never
///   written over.
///
/// The connection is returned with the full open ritual applied and is the
/// sole writable handle to this database (the caller — a workspace actor —
/// owns it on a dedicated thread and never shares it).
pub fn open_engine_db(path: &Path, now_ms: i64) -> Result<Connection, StorageError> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(StorageError::corrupt)?;

    apply_open_pragmas(&conn)?;
    validate_or_initialize(&conn, now_ms)?;
    integrity_check(&conn)?;

    Ok(conn)
}

fn apply_open_pragmas(conn: &Connection) -> Result<(), StorageError> {
    conn.busy_timeout(std::time::Duration::from_millis(u64::from(
        ENGINE_SQLITE_BUSY_TIMEOUT_MS,
    )))
    .map_err(StorageError::corrupt)?;
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(StorageError::corrupt)?;

    // WAL is a persistent property of the database file; assert it took.
    let journal_mode: String = conn
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
        .map_err(StorageError::corrupt)?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(StorageError::StateCorrupt { source: None });
    }
    Ok(())
}

fn validate_or_initialize(conn: &Connection, now_ms: i64) -> Result<(), StorageError> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(StorageError::corrupt)?;

    match version {
        ENGINE_SCHEMA_VERSION => validate_v2(conn),
        0 => {
            // Either a brand-new empty file or a non-empty foreign database
            // that never stamped a version. Refuse to init over the latter.
            if has_any_user_table(conn)? {
                return Err(StorageError::ForeignDatabase);
            }
            initialize_v2(conn, now_ms)
        }
        other => Err(StorageError::UnsupportedFingerprint {
            found: other,
            expected: ENGINE_SCHEMA_VERSION,
        }),
    }
}

fn has_any_user_table(conn: &Connection) -> Result<bool, StorageError> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )
        .map_err(StorageError::corrupt)?;
    Ok(count > 0)
}

fn initialize_v2(conn: &Connection, now_ms: i64) -> Result<(), StorageError> {
    // Create every table eagerly and stamp the fingerprint in one transaction
    // so a crash mid-init leaves an empty file (still openable as fresh),
    // never a half-schema store.
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(StorageError::persist)?;

    let result = (|| {
        conn.execute_batch(V2_SCHEMA_DDL)?;
        conn.execute(
            "INSERT INTO engine_migrations (id, checksum, applied_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![BASELINE_MIGRATION_ID, BASELINE_MIGRATION_CHECKSUM, now_ms],
        )?;
        // user_version participates in the transaction and is rolled back with
        // it if the commit never lands.
        conn.pragma_update(None, "user_version", ENGINE_SCHEMA_VERSION)?;
        Ok::<(), rusqlite::Error>(())
    })();

    match result {
        Ok(()) => conn.execute_batch("COMMIT").map_err(StorageError::persist),
        Err(err) => {
            // Best-effort rollback on the error path (mirrors the TS
            // ROLLBACK-after-failed-work swallow, `versionedTextStore.ts:3566`).
            let _ = conn.execute_batch("ROLLBACK");
            Err(StorageError::persist(err))
        }
    }
}

fn validate_v2(conn: &Connection) -> Result<(), StorageError> {
    for table in REQUIRED_TABLES {
        let present: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1",
                [table],
                |_| Ok(true),
            )
            .or_else(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => Ok(false),
                other => Err(StorageError::corrupt(other)),
            })?;
        if !present {
            return Err(StorageError::StateCorrupt { source: None });
        }
    }
    Ok(())
}

fn integrity_check(conn: &Connection) -> Result<(), StorageError> {
    // `quick_check` yields exactly one `ok` row on a healthy database
    // (`engineDbSchema.ts:915-925` posture).
    let result: String = conn
        .pragma_query_value(None, "quick_check", |row| row.get(0))
        .map_err(StorageError::corrupt)?;
    if result.eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(StorageError::StateCorrupt { source: None })
    }
}
