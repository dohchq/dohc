//! The open ritual and the day-one v2 schema.
//!
//! `open_engine_db` is the **only** place pragmas are set (`PORTING.md` §9). It
//! is ordered so the **fingerprint fence never mutates a rejected database**:
//!
//! 1. Open the connection.
//! 2. Apply *session-scoped* pragmas only (`busy_timeout`, `foreign_keys`) —
//!    these live on the connection, not the file.
//! 3. Classify the fingerprint from read-only queries (`user_version`, table
//!    presence). A v1/foreign store is rejected here, before any byte of the
//!    file is touched.
//! 4. Only for an accepted (fresh or v2) store: apply the *persistent* pragmas
//!    (`journal_mode = WAL`, `synchronous = NORMAL` — both change the file
//!    header / create sidecars), then create-or-validate the schema, then
//!    `quick_check`.
//!
//! The schema is created eagerly at `schema_version = 2` (no lazy
//! additive-upgrade dance — `plan §Day-one Rust schema`) and includes the
//! migration-ledger and request/idempotency-ledger skeletons from day one.

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
-- result instead of re-executing (the exactly-once contract). `payload_hash`
-- pins the request inputs so a key reused with a DIFFERENT payload is rejected
-- rather than silently replayed.
CREATE TABLE engine_requests (
    request_id   TEXT    NOT NULL PRIMARY KEY,
    payload_hash TEXT    NOT NULL,
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

/// `synchronous = NORMAL`: the SQLite-recommended WAL setting and the TS
/// engine's effective posture (`LANGUAGE_SEMANTICS_MATRIX.md` §8.6). Durable
/// across application/process crashes (the crash tiers this slice tests); the
/// last commit may be lost only on OS crash / power loss, honestly de-scoped to
/// `TEST_ORACLE.md` tier 3. Pinned AND asserted on open so a weakened value
/// fails a test rather than passing silently.
const SYNCHRONOUS_NORMAL: i64 = 1;

/// The tables every valid v2 store must contain. Missing any of these on an
/// otherwise-v2-stamped database is `state-corrupt`.
const REQUIRED_TABLES: &[&str] = &[
    "engine_migrations",
    "engine_requests",
    "documents",
    "replication_journal",
];

/// How an existing file was classified by the fingerprint fence.
enum Disposition {
    /// Empty file (or brand-new): initialize the v2 schema.
    Fresh,
    /// Already a v2 store: validate it.
    ExistingV2,
}

/// Open-or-create the engine database at `path`.
///
/// - A fresh (empty) file is initialized eagerly to `schema_version = 2`.
/// - A file already at v2 is validated (required tables present, integrity ok).
/// - Any other fingerprint (e.g. a v1 TS database) is rejected with
///   [`StorageError::UnsupportedFingerprint`] — **without mutating the file**
///   (no WAL switch, no sidecar creation, byte-unchanged).
///
/// The connection is returned with the full open ritual applied. The
/// single-writer-per-file contract is enforced by `dohc-engine-runtime`'s
/// supervisor (a file-id-keyed registry); this function is the low-level
/// primitive it drives, not a general-purpose entry point.
pub(crate) fn open_engine_db(path: &Path, now_ms: i64) -> Result<Connection, StorageError> {
    // No `SQLITE_OPEN_URI`: the path is a literal filename, never a SQLite URI
    // (a `file:`-prefixed workspace path must not be reinterpreted, and query
    // parameters must not alter open behavior).
    let mut conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )
    .map_err(StorageError::corrupt)?;

    // Step 2: session-scoped pragmas only — these do not touch the file.
    apply_session_pragmas(&conn)?;

    // Step 3: classify from read-only queries. A rejected store returns here
    // before any persistent pragma runs, so the file is left byte-unchanged.
    let disposition = classify_fingerprint(&conn)?;

    // Step 4: the store is ours — the file-mutating pragmas are now safe.
    apply_persistent_pragmas(&conn)?;
    match disposition {
        Disposition::Fresh => initialize_v2(&mut conn, now_ms)?,
        Disposition::ExistingV2 => validate_v2(&conn)?,
    }
    integrity_check(&conn)?;

    Ok(conn)
}

fn apply_session_pragmas(conn: &Connection) -> Result<(), StorageError> {
    conn.busy_timeout(std::time::Duration::from_millis(u64::from(
        ENGINE_SQLITE_BUSY_TIMEOUT_MS,
    )))
    .map_err(StorageError::corrupt)?;
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(StorageError::corrupt)?;
    Ok(())
}

fn apply_persistent_pragmas(conn: &Connection) -> Result<(), StorageError> {
    // WAL is a persistent property of the database file; assert it took.
    let journal_mode: String = conn
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
        .map_err(StorageError::corrupt)?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(StorageError::StateCorrupt { source: None });
    }

    // Pin durability explicitly and assert the read-back.
    conn.pragma_update(None, "synchronous", SYNCHRONOUS_NORMAL)
        .map_err(StorageError::corrupt)?;
    let synchronous: i64 = conn
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .map_err(StorageError::corrupt)?;
    if synchronous != SYNCHRONOUS_NORMAL {
        return Err(StorageError::StateCorrupt { source: None });
    }
    Ok(())
}

fn classify_fingerprint(conn: &Connection) -> Result<Disposition, StorageError> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(StorageError::corrupt)?;

    match version {
        ENGINE_SCHEMA_VERSION => Ok(Disposition::ExistingV2),
        0 => {
            // Either a brand-new empty file or a non-empty foreign database
            // that never stamped a version. Refuse to init over the latter —
            // ANY user object (table, view, index, or trigger), not just a
            // table, marks the file as someone else's.
            if has_any_user_object(conn)? {
                Err(StorageError::ForeignDatabase)
            } else {
                Ok(Disposition::Fresh)
            }
        }
        other => Err(StorageError::UnsupportedFingerprint {
            found: other,
            expected: ENGINE_SCHEMA_VERSION,
        }),
    }
}

fn has_any_user_object(conn: &Connection) -> Result<bool, StorageError> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )
        .map_err(StorageError::corrupt)?;
    Ok(count > 0)
}

fn initialize_v2(conn: &mut Connection, now_ms: i64) -> Result<(), StorageError> {
    // Create every table eagerly and stamp the fingerprint in one transaction
    // so a crash mid-init leaves an empty file (still openable as fresh), never
    // a half-schema store. The typed `Transaction` rolls back on drop, so an
    // early return never leaves a dangling open transaction.
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(StorageError::persist)?;
    tx.execute_batch(V2_SCHEMA_DDL)
        .map_err(StorageError::persist)?;
    tx.execute(
        "INSERT INTO engine_migrations (id, checksum, applied_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![BASELINE_MIGRATION_ID, BASELINE_MIGRATION_CHECKSUM, now_ms],
    )
    .map_err(StorageError::persist)?;
    // user_version participates in the transaction and rolls back with it.
    tx.pragma_update(None, "user_version", ENGINE_SCHEMA_VERSION)
        .map_err(StorageError::persist)?;
    tx.commit().map_err(StorageError::persist)
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
    // A `user_version = 2` stamp with the right table NAMES is not proof the
    // store is ours (a foreign db can fake both). Require our baseline
    // migration-ledger row — a cheap own-store fingerprint beyond table names.
    let baseline_present: bool = conn
        .query_row(
            "SELECT 1 FROM engine_migrations WHERE id = ?1",
            [BASELINE_MIGRATION_ID],
            |_| Ok(true),
        )
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(false),
            other => Err(StorageError::corrupt(other)),
        })?;
    if !baseline_present {
        return Err(StorageError::StateCorrupt { source: None });
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
