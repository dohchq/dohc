//! The open ritual and the v2 fingerprint fence.
//!
//! `open_engine_db` is the **only** place pragmas are set (`PORTING.md` §9). It
//! is ordered so the **fingerprint fence never mutates a rejected database**:
//!
//! 1. Reject a non-empty file too small to hold a SQLite header, before the
//!    connection is opened at all ([`reject_undersized_database`]).
//! 2. Open the connection.
//! 3. Apply *session-scoped* pragmas only (`busy_timeout`, `foreign_keys`) —
//!    these live on the connection, not the file.
//! 4. Classify the fingerprint from read-only queries (`user_version`, table
//!    presence). A v1/foreign store is rejected here, before any byte of the
//!    file is touched.
//! 5. Only for an accepted (fresh or v2) store: apply the *persistent* pragmas
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
use crate::limits::{
    ENGINE_SCHEMA_VERSION, ENGINE_SQLITE_BUSY_TIMEOUT_MS, SQLITE_DATABASE_HEADER_BYTES,
};
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
    "scene_asset_delete_authorities",
    "scene_asset_delete_authority_items",
    // R06 conflict-object tables (migration ordinal 7).
    "conflicts",
    // R13 shadow fence token (migration ordinal 8).
    "shadow_clone",
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
    "ydoc_deferred_updates",
    "ydoc_inactive_lineages",
    "ydoc_base_relay_candidates",
    "ydoc_recovery_decisions",
    "share_view_file_lane",
    "replication_pending_conflict_bundles",
    "replication_pending_conflict_ops",
    "replication_pending_conflict_moments",
    "replication_pending_conflict_text_blobs",
    "replication_pending_conflict_binary_blobs",
    // R09 chats-domain tables (migration ordinal 3). Unlike the TS engine's
    // lazy-additive chat tables (missing = "no chats yet"), the Rust migration
    // ledger always creates these on open, so their presence is a hard v2
    // invariant here.
    "chat_channels",
    "chat_channel_wire_ids",
    "chat_channel_placeholders",
    "chat_thread_read_state",
    "chat_threads",
    "chat_messages",
    "chat_reactions",
    "chat_decisions",
    "chat_attachments",
    "chat_pending_message_parents",
    "chat_pending_replication",
    "chat_agent_read_state",
    "chat_mentions",
    "chat_follows",
    "chat_feed_read_state",
    "chat_bookmarks",
    "chat_bookmark_outbox",
    "chat_dispatch_ledger",
    "chat_dispatch_scan_cursor",
    "agent_run_records",
    "run_message_links",
    "chat_dispatch_pause",
    // R12 search tables (migration ordinal 4). The two FTS5 virtual tables show
    // up in sqlite_schema with type='table', so the same presence probe applies;
    // like the chats tables above, the Rust ledger always creates them, so
    // absence is state-corrupt (not the TS engine's lazy-additive "no search
    // yet"). Their internal FTS5 shadow tables are not listed — only the
    // caller-facing tables are invariants.
    "engine_search_files_fts",
    "engine_search_chat_messages_fts",
    "engine_search_index_state",
    // R10 replication, relay, and share cursors (migration ordinal 5);
    // replication_pending_refusals arrived with ordinal 22.
    "sync_identity",
    "replication_log",
    "replication_pending_refusals",
    "replication_peers",
    "sync_relay_cursors",
    "sync_relay_push_state",
    "shared_channel_cursors",
    "shared_channel_peers",
    "shared_channel_push_state",
    "share_view_cursors",
    // #646 PR3a proposal scan position.
    "share_proposal_push_state",
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
pub(crate) struct OpenedEngineDb {
    pub conn: Connection,
    pub freshly_created: bool,
}

pub(crate) fn open_engine_db(path: &Path, now_ms: i64) -> Result<OpenedEngineDb, StorageError> {
    // Step 1: "is this file empty?" is our question, not the VFS's.
    reject_undersized_database(path)?;

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
    Ok(OpenedEngineDb {
        conn,
        freshly_created: disposition == Disposition::Fresh,
    })
}

/// Open an existing, fully migrated v2 store without creating files, changing
/// persistent pragmas, or applying migrations. This is the reader primitive
/// for daemon requests that run while another engine owns workspace writes.
pub(crate) fn open_engine_db_read_only(path: &Path) -> Result<OpenedEngineDb, StorageError> {
    reject_undersized_database(path)?;
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(StorageError::corrupt)?;
    apply_session_pragmas(&conn)?;
    if classify_fingerprint(&conn)? != Disposition::ExistingV2 {
        return Err(StorageError::StateCorrupt { source: None });
    }
    validate_v2(&conn)?;
    integrity_check(&conn)?;
    Ok(OpenedEngineDb {
        conn,
        freshly_created: false,
    })
}

/// Reject an existing, non-empty file that is too small to hold a SQLite
/// header, before the connection is opened (so the rejected file is left
/// byte-unchanged).
///
/// SQLite's unix VFS reports a file size of exactly 1 byte as 0 — a deliberate
/// adjustment for the OS-X msdos `findInodeInfo` workaround (`unixFileSize`,
/// ticket #3260). An `engine.db` truncated to one byte is therefore handed to
/// us as a brand-new empty database, classified `Fresh`, and silently
/// initialized over. The win32 VFS makes no such adjustment, which is why the
/// gap escaped only on POSIX hosts. Answering the size question ourselves keeps
/// the fence's contract — never re-initialize over a damaged store — VFS
/// independent.
///
/// One byte is genuinely ambiguous: on a macOS msdos volume `findInodeInfo`
/// writes an ASCII `S` into a zero-size file, which is also the first byte of
/// every SQLite header, so a crash sentinel and a database truncated to its
/// first byte are indistinguishable. We resolve that fail-closed — an
/// unrecoverable workspace reported as corrupt costs a manual delete; the other
/// way round costs the workspace.
fn reject_undersized_database(path: &Path) -> Result<(), StorageError> {
    let size = match std::fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        // Absent is the create path; any other stat failure surfaces as the
        // connection open's own typed error below.
        Err(_) => return Ok(()),
    };
    if size > 0 && size < SQLITE_DATABASE_HEADER_BYTES {
        return Err(StorageError::StateCorrupt { source: None });
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::REQUIRED_TABLES;

    #[test]
    fn current_schema_requires_pending_conflict_bundle_tables() {
        for table in [
            "replication_pending_conflict_bundles",
            "replication_pending_conflict_ops",
            "replication_pending_conflict_moments",
            "replication_pending_conflict_text_blobs",
            "replication_pending_conflict_binary_blobs",
        ] {
            assert!(
                REQUIRED_TABLES.contains(&table),
                "open must reject a store missing {table}"
            );
        }
    }

    #[test]
    fn current_schema_requires_ydoc_arbitration_tables() {
        for table in ["ydoc_base_relay_candidates", "ydoc_recovery_decisions"] {
            assert!(
                REQUIRED_TABLES.contains(&table),
                "open must reject a store missing {table}"
            );
        }
    }
}
