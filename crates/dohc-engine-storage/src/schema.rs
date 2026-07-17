//! The open ritual and the v2 fingerprint fence.
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
//!    (`journal_mode = WAL`, `synchronous = NORMAL`), then run the **ordered
//!    migration ledger** (`migration.rs`) — which on a fresh store assembles the
//!    day-one v2 schema and stamps the fingerprint, and on an existing v2 store
//!    applies any pending migrations — then validate the frozen shape and
//!    `quick_check`.
//!
//! The schema is no longer created by an ad-hoc eager `CREATE`; it is migration
//! 0 in the ledger (`plan §Day-one Rust schema`). R04 owns the frozen shape.

use crate::error::StorageError;
use crate::faults::{FaultInjector, NoFaults};
use crate::limits::{ENGINE_SCHEMA_VERSION, ENGINE_SQLITE_BUSY_TIMEOUT_MS};
use crate::migration::{
    BASELINE_MIGRATION_ID, BASELINE_MIGRATIONS, MigrationContext, MigrationOutcome, run_migrations,
};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

/// `synchronous = NORMAL`: the SQLite-recommended WAL setting and the TS
/// engine's effective posture (`LANGUAGE_SEMANTICS_MATRIX.md` §8.6). Durable
/// across application/process crashes (the crash tiers this crate tests); the
/// last commit may be lost only on OS crash / power loss, honestly de-scoped to
/// `TEST_ORACLE.md` tier 3. Pinned AND asserted on open so a weakened value
/// fails a test rather than passing silently.
const SYNCHRONOUS_NORMAL: i64 = 1;

/// The tables every valid v2 store must contain. Missing any of these on an
/// otherwise-v2-stamped database is `state-corrupt`.
const REQUIRED_TABLES: &[&str] = &[
    "engine_migrations",
    "engine_ownership",
    "engine_requests",
    "documents",
    "replication_journal",
    // CAL-2 versioning tables.
    "versioned_workspaces",
    "versions",
    "active_versions",
    "file_objects",
    "blobs",
    "path_aliases",
    "snapshots",
    "fork_base_snapshots",
    "moments",
    // R04 durability tables.
    "binary_blobs",
    "materialization_jobs",
    // R08 secret-backed-file tables (migration ordinal 1).
    "secret_files",
    "secret_fork_bases",
    "secret_moments",
    // R11a durable Y.Doc tables (migration ordinal 2).
    "ydoc_docs",
    "ydoc_updates",
    "ydoc_snapshots",
];

/// How an existing file was classified by the fingerprint fence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Disposition {
    /// Empty file (or brand-new): run the migration ledger from ordinal 0.
    Fresh,
    /// Already a v2 store: run pending migrations (if any), then validate.
    ExistingV2,
}

/// Open-or-create the engine database at `path`, applying the full open ritual
/// and the v1-vs-v2 fingerprint fence, then running the ordered migration
/// ledger. Any non-v2 fingerprint is rejected without mutating the file.
pub(crate) fn open_engine_db(path: &Path, now_ms: i64) -> Result<Connection, StorageError> {
    let mut conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )
    .map_err(StorageError::corrupt)?;

    // Step 2: session-scoped pragmas only — these do not touch the file.
    apply_session_pragmas(&conn)?;

    // Step 3: classify from read-only queries. A rejected store returns here
    // before any persistent pragma runs, so the file is left byte-unchanged.
    let _disposition = classify_fingerprint(&conn)?;

    // Step 4: the store is ours — the file-mutating pragmas are now safe.
    apply_persistent_pragmas(&conn)?;

    // The ordered migration ledger. Fresh stores get the whole v2 schema +
    // fingerprint; existing v2 stores get any pending migrations. Production
    // uses `NoFaults`, so a `Crashed` outcome is unreachable here (the migration
    // fault points are exercised by `migration.rs`'s crash/reopen unit tests).
    let ctx = MigrationContext::current(now_ms);
    let no_faults = NoFaults;
    match run_migrations(
        &mut conn,
        BASELINE_MIGRATIONS,
        &ctx,
        &no_faults as &dyn FaultInjector,
    )? {
        MigrationOutcome::Applied { .. } => {}
        MigrationOutcome::Crashed => return Err(StorageError::MigrationFailed { source: None }),
    }

    validate_v2(&conn)?;
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
    let journal_mode: String = conn
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
        .map_err(StorageError::corrupt)?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(StorageError::StateCorrupt { source: None });
    }

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
            // Either a brand-new empty file or a non-empty foreign database that
            // never stamped a version. Refuse to init over the latter — ANY user
            // object (table, view, index, trigger) marks the file as someone
            // else's.
            if has_any_user_object(conn)? {
                Err(StorageError::ForeignDatabase)
            } else {
                Ok(Disposition::Fresh)
            }
        }
        other => {
            // A non-recognized `user_version` is normally a real foreign
            // fingerprint (e.g. a valid v1 TS database) → export/reset. But a
            // corrupt page-1 header can read `user_version` as garbage; that is
            // CORRUPTION (restore from backup), not an unsupported version.
            // Distinguish by a read-only integrity probe: a store that fails
            // `quick_check` is classified corrupt regardless of the version it
            // claims. (A genuine foreign db passes the probe.)
            if probe_integrity_ok(conn) {
                Err(StorageError::UnsupportedFingerprint {
                    found: other,
                    expected: ENGINE_SCHEMA_VERSION,
                })
            } else {
                Err(StorageError::StateCorrupt { source: None })
            }
        }
    }
}

/// A read-only `quick_check` probe used during classification. Returns `false`
/// on any failure (a corrupt store that cannot even be checked is not "ok"). No
/// file mutation — safe to run before the persistent pragmas.
fn probe_integrity_ok(conn: &Connection) -> bool {
    conn.pragma_query_value(None, "quick_check", |row| row.get::<_, String>(0))
        .map(|result| result.eq_ignore_ascii_case("ok"))
        .unwrap_or(false)
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
    // The baseline ledger row is our own-store fingerprint beyond table names.
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
    let result: String = conn
        .pragma_query_value(None, "quick_check", |row| row.get(0))
        .map_err(StorageError::corrupt)?;
    if result.eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(StorageError::StateCorrupt { source: None })
    }
}
