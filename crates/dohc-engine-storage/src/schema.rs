//! The open ritual and the v2 fingerprint fence.
//!
//! `open_engine_db` is the **only** place pragmas are set. It
//! is ordered so the **fingerprint fence never mutates a rejected database**:
//!
//! 1. Reject a non-empty file too small to hold a SQLite header, before the
//!    connection is opened at all ([`reject_undersized_database`]).
//! 2. Open the connection with checkpoint-on-close off, so closing it on a
//!    refused store never folds a WAL that another build left into the file.
//! 3. Apply *session-scoped* pragmas only (`busy_timeout`, `foreign_keys`) —
//!    these live on the connection, not the file.
//! 4. Classify the fingerprint from read-only queries (`user_version`, table
//!    presence, the migration ledger). A v1/foreign store, or one whose ledger
//!    holds a migration a newer build ran, is rejected here, before any byte
//!    of the file is touched.
//! 5. Only for an accepted (fresh or v2) store: turn checkpoint-on-close back
//!    on, apply the *persistent* pragmas (`journal_mode = WAL`,
//!    `synchronous = NORMAL`), then run the migration ledger
//!    (`migration.rs`), then validate the required tables and `quick_check`.

use crate::error::StorageError;
use crate::faults::{FaultInjector, NoFaults};
use crate::limits::{
    ENGINE_SCHEMA_VERSION, ENGINE_SQLITE_BUSY_TIMEOUT_MS, SQLITE_DATABASE_HEADER_BYTES,
};
use crate::migration::{
    BASELINE_MIGRATION_ID, BASELINE_MIGRATIONS, MigrationContext, MigrationOutcome,
    newer_build_refusal, run_migrations,
};
use rusqlite::config::DbConfig;
use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// SQLite VM steps per count of open work. A single long statement, such as a
/// migration or the integrity check on a large store, still moves the count
/// many times, and one atomic add per thousand steps costs nothing measurable.
pub(crate) const OPEN_WORK_STEP_OPS: std::ffi::c_int = 1_000;

/// Count the SQLite work of this open into `work` until [`stop_counting`].
fn count_open_work(conn: &Connection, work: Option<Arc<AtomicU64>>) -> Result<(), StorageError> {
    let Some(work) = work else { return Ok(()) };
    conn.progress_handler(
        OPEN_WORK_STEP_OPS,
        Some(move || {
            work.fetch_add(1, Ordering::Relaxed);
            false
        }),
    )
    .map_err(StorageError::corrupt)
}

/// The open is done: later statements on this connection count nothing.
fn stop_counting(conn: &Connection) -> Result<(), StorageError> {
    conn.progress_handler(0, None::<fn() -> bool>)
        .map_err(StorageError::corrupt)
}

/// `synchronous = NORMAL`: the SQLite-recommended WAL setting and the TS
/// engine's effective posture. Durable
/// across application/process crashes (the crash tiers this crate tests); the
/// last commit may be lost only on OS crash / power loss, honestly de-scoped to
/// `TEST_ORACLE.md` tier 3. Pinned and asserted on open so a weakened value
/// fails a test rather than passing silently.
const SYNCHRONOUS_NORMAL: i64 = 1;

/// The tables every valid v2 store must contain. Missing any of these on an
/// otherwise-v2-stamped database is `state-corrupt`.
const REQUIRED_TABLES: &[&str] = &[
    "replica_frontiers",
    "replica_documents",
    "replica_first_seen",
    "live_audit_base_publications",
    "live_audit_bases",
    "live_audit_base_conflicts",
    "live_audit_record_manifests",
    "live_audit_pending_exports",
    "live_audit_settlements",
    "live_audit_settlement_publications",
    "live_audit_settlement_conflicts",
    "live_audit_record_chunks",
    "live_audit_events",
    "live_audit_projection_authors",
    "live_audit_projection_contributions",
    "live_audit_event_publications",
    "live_audit_event_conflicts",
    "live_accepted_updates",
    "live_accepted_checkpoints",
    "live_accepted_reader_history",
    "live_restore_fences",
    "ydoc_owner_applied_frames",
    "ydoc_owner_bindings",
    "owner_pending_settlements",
    "owner_pending_settlement_blobs",
    "relay_deferred_ops",
    "relay_deferred_blobs",
    "live_owner_adoptions",
    "live_device_bootstraps",
    "live_device_settlements",
    "live_settlement_publication_states",
    "live_settlement_publication_admissions",
    "live_settlement_attribution_unavailable",
    "ydoc_owner_base_sources",
    "ydoc_owner_activation_sources",
    "live_device_application_bindings",
    "live_device_update_applications",
    "live_device_application_first_seen",
    "engine_migrations",
    "engine_ownership",
    "engine_requests",
    // CAL-2 versioning tables.
    "versioned_workspaces",
    "versions",
    "active_versions",
    "capture_file_holds",
    "file_objects",
    "blobs",
    "path_aliases",
    "snapshots",
    "fork_base_snapshots",
    "links",
    "link_sources",
    "link_occurrence_keys",
    "link_target_keys",
    "link_pending",
    "link_aliases",
    "link_index_state",
    "link_gc",
    "moments",
    "scene_asset_delete_authorities",
    "scene_asset_delete_authority_items",
    "collections",
    "collection_records",
    "collection_record_fields",
    "collection_field_history",
    "collection_relation_edges",
    "collection_historical_record_owners",
    "collection_historical_record_owner_backfills",
    // R06 conflict-object tables.
    "conflicts",
    // R13 shadow fence token.
    "shadow_clone",
    // R04 durability tables.
    "binary_blobs",
    "materialization_jobs",
    "materialization_displacements",
    "materialization_retained",
    "materialization_displacement_reads",
    "materialization_staging_locations",
    // R08 secret-backed-file tables.
    "secret_files",
    "secret_fork_bases",
    "secret_moments",
    // R11a durable Y.Doc tables.
    "ydoc_docs",
    "ydoc_updates",
    "ydoc_snapshots",
    "ydoc_deferred_updates",
    "ydoc_inactive_lineages",
    "ydoc_base_relay_candidates",
    "ydoc_recovery_decisions",
    "owner_ydoc_outboxes",
    "owner_ydoc_outbox_entries",
    "owner_live_stops",
    "share_view_file_lane",
    "replication_pending_conflict_bundles",
    "replication_pending_conflict_ops",
    "replication_pending_conflict_moments",
    "replication_pending_conflict_text_blobs",
    "replication_pending_conflict_binary_blobs",
    // R09 chats-domain tables.
    "chat_channels",
    "chat_channel_wire_ids",
    "chat_channel_placeholders",
    "chat_thread_read_state",
    "chat_threads",
    "chat_messages",
    "chat_reactions",
    "chat_decisions",
    "chat_attachments",
    "chat_conversation_file_links",
    "chat_conversation_file_link_state",
    "chat_conversation_file_link_work",
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
    "chat_dispatch_local_discovery",
    "agent_run_records",
    "run_message_links",
    "chat_dispatch_pause",
    // R12 search tables. The two FTS5 virtual tables show up in sqlite_schema
    // with type='table', so the same presence probe applies. Their internal
    // FTS5 shadow tables are not listed.
    "engine_search_files_fts",
    "engine_search_chat_messages_fts",
    "engine_search_index_state",
    // R10 replication, relay, and share cursors.
    "sync_identity",
    "replication_log",
    "replication_refused_moment_blobs",
    "replication_refused_ydoc_blobs",
    "replication_pending_refusals",
    "replication_peers",
    "sync_relay_cursors",
    "sync_relay_push_state",
    "shared_channel_cursors",
    "shared_channel_peers",
    "shared_channel_push_state",
    "share_view_cursors",
    "hosted_replicas",
    "hosted_documents",
    "hosted_withheld_befores",
    "hosted_deferred_ops",
    "hosted_retired_files",
    "hosted_parked_snapshots",
    "hosted_parked_path_aliases",
    // #646 PR3a proposal scan position.
    "share_proposal_push_state",
    // Item 12: the direct lane's position and per-file decisions.
    "share_direct_write_state",
    "share_direct_write_marks",
    "share_direct_write_plan",
    "chat_conversation_revisions",
    "automation_subscriptions",
    "automation_claims",
    "merged_moments",
    "automation_presses",
    "automation_schedule_marks",
    "remote_changes",
];

/// How an existing file was classified by the fingerprint fence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Disposition {
    /// Empty file (or brand-new): run the migration ledger.
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
    pub checkpoints: Option<crate::checkpoint::Checkpoints>,
}

/// `work`, when given, counts the SQLite work of the open as it runs.
pub(crate) fn open_engine_db(
    path: &Path,
    now_ms: i64,
    work: Option<Arc<AtomicU64>>,
) -> Result<OpenedEngineDb, StorageError> {
    open_engine_db_with_root_token(path, now_ms, None, work)
}

pub(crate) fn open_engine_db_with_root_token(
    path: &Path,
    now_ms: i64,
    root_token: Option<&str>,
    work: Option<Arc<AtomicU64>>,
) -> Result<OpenedEngineDb, StorageError> {
    open_engine_db_configured(path, now_ms, root_token, work, false, false)
}

pub(crate) fn store_is_passive(conn: &Connection) -> Result<bool, StorageError> {
    let has_role: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('engine_ownership') WHERE name='store_role')",
        [], |row| row.get(0),
    ).map_err(StorageError::corrupt)?;
    if !has_role {
        let role_migrated: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM engine_migrations WHERE id='v2-engine-store-role' AND completed_at IS NOT NULL)",
            [], |row| row.get(0),
        ).map_err(StorageError::corrupt)?;
        return if role_migrated {
            Err(StorageError::StateCorrupt { source: None })
        } else {
            Ok(false)
        };
    }
    let role: String = conn
        .query_row(
            "SELECT store_role FROM engine_ownership WHERE rowid_guard=1",
            [],
            |row| row.get(0),
        )
        .map_err(StorageError::corrupt)?;
    match role.as_str() {
        "owner" => Ok(false),
        "passive" => Ok(true),
        _ => Err(StorageError::StateCorrupt { source: None }),
    }
}

pub(crate) fn open_engine_db_with_store_role(
    path: &Path,
    now_ms: i64,
    root_token: Option<&str>,
    work: Option<Arc<AtomicU64>>,
    passive: bool,
) -> Result<OpenedEngineDb, StorageError> {
    open_engine_db_configured(path, now_ms, root_token, work, false, passive)
}

pub(crate) fn open_engine_db_for_actor(
    path: &Path,
    now_ms: i64,
    root_token: Option<&str>,
    work: Option<Arc<AtomicU64>>,
) -> Result<OpenedEngineDb, StorageError> {
    open_engine_db_configured(path, now_ms, root_token, work, true, false)
}

fn open_engine_db_configured(
    path: &Path,
    now_ms: i64,
    root_token: Option<&str>,
    work: Option<Arc<AtomicU64>>,
    background_checkpoints: bool,
    passive: bool,
) -> Result<OpenedEngineDb, StorageError> {
    // Step 1: "is this file empty?" is our question, not the VFS's.
    reject_undersized_database(path)?;

    let mut conn = crate::open_store(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )
    .map_err(StorageError::corrupt)?;
    // The last connection to close a WAL database checkpoints it. A build
    // that crashed can leave its commits in the WAL, and refusing its store
    // must not fold them into engine.db.
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
        .map_err(StorageError::corrupt)?;
    count_open_work(&conn, work)?;

    // Step 2: session-scoped pragmas only — these do not touch the file.
    apply_session_pragmas(&conn)?;
    if background_checkpoints {
        conn.pragma_update(None, "wal_autocheckpoint", 0)
            .map_err(StorageError::persist)?;
    }

    // Step 3: classify from read-only queries. A rejected store returns here
    // before any persistent pragma runs, so the file is left byte-unchanged.
    let disposition = classify_fingerprint(&conn)?;
    crate::migration::refuse_declared_v1_evidence(&conn)?;

    if disposition == Disposition::ExistingV2 {
        if store_is_passive(&conn)? != passive {
            return Err(StorageError::InvalidInput {
                reason: "engine store role mismatch",
            });
        }
        if passive {
            crate::store::install_passive_guards(&conn)?;
        }
    }

    // Step 4: the store is ours. Actor connections leave close checkpoints
    // to the background connection, including failed startup and worker exits.
    conn.set_db_config(
        DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
        background_checkpoints,
    )
    .map_err(StorageError::corrupt)?;
    apply_persistent_pragmas(&conn)?;
    let checkpoints = if background_checkpoints && !passive {
        Some(crate::checkpoint::Checkpoints::start(path)?)
    } else {
        None
    };

    // Production uses `NoFaults`, so a `Crashed` outcome is unreachable here
    // (the migration fault points are exercised by `migration.rs`'s tests).
    let mut ctx = MigrationContext::current(now_ms);
    // Initial ownership and the schema commit together. Existing stores never
    // acquire a new binding merely because the caller supplies a token.
    if disposition == Disposition::Fresh {
        ctx.initial_root_token = root_token.map(str::to_owned);
    }
    let no_faults = NoFaults;
    // Migrations must not originate operations or queue work for passive stores.
    // Fresh passive stores migrate as owner before the role switch below. They
    // contain no versions; migrations must not seed versions or local work there.
    let newly_applied = match run_migrations(
        &mut conn,
        BASELINE_MIGRATIONS,
        &ctx,
        &no_faults as &dyn FaultInjector,
    )? {
        MigrationOutcome::Applied { newly_applied } => newly_applied,
        MigrationOutcome::Crashed => return Err(StorageError::MigrationFailed { source: None }),
    };

    if passive {
        if disposition == Disposition::Fresh {
            conn.execute(
                "UPDATE engine_ownership SET store_role='passive' WHERE rowid_guard=1",
                [],
            )
            .map_err(StorageError::persist)?;
        }
        crate::store::install_passive_guards(&conn)?;
    }

    validate_v2(&conn)?;
    integrity_check(&conn)?;
    stop_counting(&conn)?;
    crate::search_generation::install(&conn).map_err(StorageError::corrupt)?;
    if let Some(checkpoints) = &checkpoints {
        if disposition == Disposition::Fresh {
            checkpoints.checkpoint_fresh_schema(&conn);
        } else if newly_applied > 0 {
            checkpoints.checkpoint_migration_tail_if_small(&conn);
        }
        checkpoints.request();
    }
    Ok(OpenedEngineDb {
        conn,
        checkpoints,
        freshly_created: disposition == Disposition::Fresh,
    })
}

/// Open an existing, fully migrated v2 store without creating files, changing
/// persistent pragmas, or applying migrations. This is the reader primitive
/// for daemon requests that run while another engine owns workspace writes.
pub(crate) fn open_engine_db_read_only(
    path: &Path,
    work: Option<Arc<AtomicU64>>,
) -> Result<OpenedEngineDb, StorageError> {
    reject_undersized_database(path)?;
    let conn =
        crate::open_store(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(StorageError::corrupt)?;
    count_open_work(&conn, work)?;
    apply_session_pragmas(&conn)?;
    if classify_fingerprint(&conn)? != Disposition::ExistingV2 {
        return Err(StorageError::StateCorrupt { source: None });
    }
    crate::migration::refuse_declared_v1_evidence(&conn)?;
    validate_v2(&conn)?;
    integrity_check(&conn)?;
    stop_counting(&conn)?;
    crate::search_generation::install(&conn).map_err(StorageError::corrupt)?;
    Ok(OpenedEngineDb {
        conn,
        freshly_created: false,
        checkpoints: None,
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
    set_checkpoint_fullfsync(conn).map_err(StorageError::corrupt)?;
    Ok(())
}

/// A checkpoint must not recycle a durable WAL before its copied pages reach
/// permanent storage on macOS. Every connection that checkpoints sets this.
pub(crate) fn set_checkpoint_fullfsync(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "checkpoint_fullfsync", cfg!(target_os = "macos"))
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

    // A store a newer build migrated needs that build, whatever `user_version`
    // it stamped. This build cannot know what the newer migration changed, so
    // it must not run here, and a rebuild would move the store aside. A file
    // with no ledger, such as a fresh one, answers `None`.
    match newer_build_refusal(conn, BASELINE_MIGRATIONS) {
        Ok(Some(refused)) => return Err(refused),
        Ok(None) => {}
        // Our own store must have a readable ledger.
        Err(err) if version == ENGINE_SCHEMA_VERSION => return Err(StorageError::corrupt(err)),
        // Any other fingerprint is judged below; an unreadable ledger proves
        // nothing about it.
        Err(_) => {}
    }

    match version {
        ENGINE_SCHEMA_VERSION => Ok(Disposition::ExistingV2),
        0 => {
            // Either a brand-new empty file or a non-empty foreign database that
            // never stamped a version. Refuse to init over the latter — any user
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
            // corruption (restore from backup), not an unsupported version.
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
    let mut missing_tables: std::collections::HashSet<&[u8]> = REQUIRED_TABLES
        .iter()
        .map(|table| table.as_bytes())
        .collect();
    {
        let mut statement = conn
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
            .map_err(StorageError::corrupt)?;
        let mut rows = statement.query([]).map_err(StorageError::corrupt)?;
        while let Some(row) = rows.next().map_err(StorageError::corrupt)? {
            // Match BINARY TEXT names without decoding unrelated schema names.
            if let rusqlite::types::ValueRef::Text(name) =
                row.get_ref(0).map_err(StorageError::corrupt)?
            {
                missing_tables.remove(name);
            }
        }
    }
    for table in REQUIRED_TABLES {
        if missing_tables.contains(table.as_bytes()) {
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
    #[test]
    fn passive_role_overrides_background_checkpoint_opt_in() {
        let scratch =
            dohc_test_scratch::ScratchDir::new_named("passive-checkpoint-opt-in").unwrap();
        let path = scratch.path().join("engine.db");
        for now_ms in [1, 2] {
            let opened =
                super::open_engine_db_configured(&path, now_ms, None, None, true, true).unwrap();
            assert!(super::store_is_passive(&opened.conn).unwrap());
            assert!(
                opened.checkpoints.is_none(),
                "passive role must override checkpoint opt-in"
            );
        }
    }

    use super::REQUIRED_TABLES;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn conversation_links_schema_rejects_missing_projection_resources() {
        for table in [
            "chat_conversation_file_links",
            "chat_conversation_file_link_state",
            "chat_conversation_file_link_work",
        ] {
            let directory =
                dohc_test_scratch::ScratchDir::new_named("conversation-links-schema").unwrap();
            let path = directory.path().join("store.sqlite");
            drop(crate::EngineStore::open(&path, 0).unwrap());
            let c = rusqlite::Connection::open(&path).unwrap();
            c.execute_batch(&format!("DROP TABLE {table}")).unwrap();
            drop(c);
            assert!(
                matches!(
                    crate::EngineStore::open(&path, 0),
                    Err(crate::StorageError::StateCorrupt { .. })
                ),
                "missing {table}"
            );
        }
    }

    #[test]
    fn checkpoint_fullfsync_is_set_for_the_connection_lifetime() {
        let directory = dohc_test_scratch::ScratchDir::new_named("checkpoint-sync").unwrap();
        let path = directory.path().join("store.sqlite");
        let expected = i64::from(cfg!(target_os = "macos"));
        let setting = |conn: &rusqlite::Connection| -> rusqlite::Result<i64> {
            conn.pragma_query_value(None, "checkpoint_fullfsync", |row| row.get(0))
        };
        for _ in 0..2 {
            let store = crate::EngineStore::open(&path, 0).unwrap();
            store
                .read_with(|conn| {
                    assert_eq!(setting(conn)?, expected);
                    Ok::<_, rusqlite::Error>(())
                })
                .unwrap();
        }
        // The background checkpointer copies WAL pages too.
        let background = crate::checkpoint::Checkpoints::connection(&path).unwrap();
        assert_eq!(setting(&background).unwrap(), expected);
    }

    #[test]
    fn a_counted_open_counts_its_work_and_nothing_after() {
        let directory = dohc_test_scratch::ScratchDir::new_named("open-work").unwrap();
        let path = directory.path().join("store.sqlite");
        let fresh = Arc::new(AtomicU64::new(0));
        let store = crate::EngineStore::open_counting(&path, 0, Some(Arc::clone(&fresh))).unwrap();
        let counted = fresh.load(Ordering::Relaxed);
        assert!(counted > 0, "a fresh open migrates, and its work counts");
        store
            .read_with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM engine_migrations", [], |row| {
                    row.get::<_, i64>(0)
                })
            })
            .unwrap();
        assert_eq!(
            fresh.load(Ordering::Relaxed),
            counted,
            "the open is over; later reads count nothing"
        );
        drop(store);

        let reopen = Arc::new(AtomicU64::new(0));
        drop(
            crate::EngineStore::open_read_only_counting(&path, Some(Arc::clone(&reopen))).unwrap(),
        );
        assert!(
            reopen.load(Ordering::Relaxed) > 0,
            "the integrity check of an existing store counts"
        );
    }

    #[test]
    fn current_schema_rejects_each_missing_live_application_table() {
        for table in [
            "live_audit_base_publications",
            "live_audit_bases",
            "live_audit_base_conflicts",
            "live_accepted_updates",
            "live_accepted_checkpoints",
            "live_accepted_reader_history",
            "live_restore_fences",
            "live_owner_adoptions",
            "live_device_bootstraps",
            "live_device_application_bindings",
            "live_device_update_applications",
            "live_device_application_first_seen",
            "live_device_settlements",
        ] {
            assert!(REQUIRED_TABLES.contains(&table));
            let directory =
                dohc_test_scratch::ScratchDir::new_named("live-application-schema").unwrap();
            let path = directory.path().join("store.sqlite");
            drop(crate::EngineStore::open(&path, 0).unwrap());
            let connection = rusqlite::Connection::open(&path).unwrap();
            connection
                .execute_batch(&format!("DROP TABLE {table}"))
                .unwrap();
            drop(connection);
            assert!(
                matches!(
                    crate::EngineStore::open(&path, 0),
                    Err(crate::StorageError::StateCorrupt { .. })
                ),
                "missing {table}"
            );
        }
    }

    #[test]
    fn current_schema_rejects_missing_owner_outbox_tables() {
        for table in [
            "owner_ydoc_outboxes",
            "owner_ydoc_outbox_entries",
            "ydoc_owner_base_sources",
            "ydoc_owner_activation_sources",
        ] {
            let directory =
                dohc_test_scratch::ScratchDir::new_named("owner-outbox-schema").unwrap();
            let path = directory.path().join("store.sqlite");
            drop(crate::EngineStore::open(&path, 0).unwrap());
            let connection = rusqlite::Connection::open(&path).unwrap();
            connection
                .execute_batch(&format!("DROP TABLE {table}"))
                .unwrap();
            drop(connection);
            assert!(
                matches!(
                    crate::EngineStore::open(&path, 0),
                    Err(crate::StorageError::StateCorrupt { .. })
                ),
                "open must reject a store missing {table}"
            );
        }
    }

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

    fn closed_schema_image() -> Vec<u8> {
        let directory = dohc_test_scratch::ScratchDir::new_named("schema-image").unwrap();
        let path = directory.path().join("store.sqlite");
        drop(crate::EngineStore::open(&path, 0).unwrap());
        assert!(!path.with_file_name("store.sqlite-wal").exists());
        assert!(!path.with_file_name("store.sqlite-shm").exists());
        std::fs::read(path).unwrap()
    }

    fn copied_schema_connection(
        image: &[u8],
    ) -> (
        dohc_test_scratch::ScratchDir,
        std::path::PathBuf,
        rusqlite::Connection,
    ) {
        let directory = dohc_test_scratch::ScratchDir::new_named("schema-copy").unwrap();
        let path = directory.path().join("store.sqlite");
        std::fs::write(&path, image).unwrap();
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.pragma_update(None, "foreign_keys", false).unwrap();
        (directory, path, conn)
    }

    #[test]
    fn v2_validation_rejects_each_missing_required_table() {
        let image = closed_schema_image();
        for table in REQUIRED_TABLES {
            let (_directory, _path, conn) = copied_schema_connection(&image);
            super::validate_v2(&conn).unwrap();
            conn.execute_batch(&format!("DROP TABLE \"{table}\""))
                .unwrap();
            assert!(
                matches!(
                    super::validate_v2(&conn),
                    Err(crate::StorageError::StateCorrupt { source: None })
                ),
                "missing {table}"
            );
        }
    }

    #[test]
    fn v2_validation_refuses_missing_tables_before_querying_the_ledger() {
        let image = closed_schema_image();
        let (_directory, _path, conn) = copied_schema_connection(&image);
        conn.execute_batch(
            "DROP TABLE live_audit_base_publications; DROP TABLE engine_migrations;",
        )
        .unwrap();
        assert!(matches!(
            super::validate_v2(&conn),
            Err(crate::StorageError::StateCorrupt { source: None })
        ));
    }

    #[test]
    fn v2_validation_requires_exact_main_table_names() {
        let image = closed_schema_image();
        for substitute in [
            "CREATE VIEW live_audit_base_publications AS SELECT 1 AS value;",
            "CREATE TABLE LIVE_AUDIT_BASE_PUBLICATIONS (value);",
            "CREATE TEMP TABLE live_audit_base_publications (value);",
            "ATTACH DATABASE ':memory:' AS other; \
             CREATE TABLE other.live_audit_base_publications (value);",
        ] {
            let (_directory, _path, conn) = copied_schema_connection(&image);
            conn.execute_batch("DROP TABLE live_audit_base_publications;")
                .unwrap();
            conn.execute_batch(substitute).unwrap();
            assert!(
                matches!(
                    super::validate_v2(&conn),
                    Err(crate::StorageError::StateCorrupt { source: None })
                ),
                "substitute cannot repair main: {substitute}"
            );
        }
    }

    #[test]
    fn v2_validation_accepts_extra_names_and_existing_virtual_tables() {
        let image = closed_schema_image();
        let (_directory, _path, conn) = copied_schema_connection(&image);
        conn.execute_batch(
            "CREATE TABLE unrelated_extra (value); \
             CREATE TABLE \"額外\" (value); \
             CREATE TEMP TABLE live_audit_base_publications (value); \
             ATTACH DATABASE ':memory:' AS other; \
             CREATE TABLE other.live_audit_base_publications (value);",
        )
        .unwrap();
        super::validate_v2(&conn).unwrap();
        super::integrity_check(&conn).unwrap();
    }

    #[test]
    fn v2_validation_does_not_decode_unrelated_malformed_text_names() {
        let image = closed_schema_image();
        let (_directory, _path, conn) = copied_schema_connection(&image);
        conn.execute_batch(
            "CREATE TABLE unrelated_extra (value); \
             PRAGMA writable_schema = ON; \
             UPDATE sqlite_schema SET name = CAST(X'80' AS TEXT) \
             WHERE name = 'unrelated_extra'; \
             PRAGMA writable_schema = OFF;",
        )
        .unwrap();
        let raw: Vec<u8> = conn
            .query_row(
                "SELECT name FROM sqlite_schema \
                 WHERE type = 'table' AND CAST(name AS BLOB) = X'80'",
                [],
                |row| match row.get_ref(0)? {
                    rusqlite::types::ValueRef::Text(bytes) => Ok(bytes.to_vec()),
                    _ => panic!("fixture must retain the malformed TEXT value"),
                },
            )
            .unwrap();
        assert!(std::str::from_utf8(&raw).is_err());
        super::validate_v2(&conn).unwrap();
    }

    #[test]
    fn v2_validation_does_not_accept_blob_names_as_text_names() {
        let image = closed_schema_image();
        let (_directory, _path, conn) = copied_schema_connection(&image);
        conn.execute_batch(
            "PRAGMA writable_schema = ON; \
             UPDATE sqlite_schema SET name = CAST(name AS BLOB) \
             WHERE name = 'live_audit_base_publications'; \
             PRAGMA writable_schema = OFF;",
        )
        .unwrap();
        let matches: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = ?1",
                ["live_audit_base_publications"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            matches, 0,
            "the original TEXT predicate excludes BLOB names"
        );
        assert!(matches!(
            super::validate_v2(&conn),
            Err(crate::StorageError::StateCorrupt { source: None })
        ));
    }

    #[test]
    fn v2_validation_requires_the_baseline_ledger_row() {
        let image = closed_schema_image();
        let (_directory, _path, conn) = copied_schema_connection(&image);
        let deleted = conn
            .execute(
                "DELETE FROM engine_migrations WHERE id = ?1",
                [super::BASELINE_MIGRATION_ID],
            )
            .unwrap();
        assert_eq!(deleted, 1);
        assert!(matches!(
            super::validate_v2(&conn),
            Err(crate::StorageError::StateCorrupt { source: None })
        ));
    }

    #[test]
    fn v2_validation_rechecks_committed_ddl_and_both_real_open_paths() {
        let image = closed_schema_image();
        let (_directory, path, conn) = copied_schema_connection(&image);
        super::validate_v2(&conn).unwrap();
        let writer = rusqlite::Connection::open(&path).unwrap();
        writer
            .execute_batch("BEGIN IMMEDIATE; DROP TABLE live_audit_base_publications; COMMIT;")
            .unwrap();
        assert!(matches!(
            super::validate_v2(&conn),
            Err(crate::StorageError::StateCorrupt { source: None })
        ));
        drop(writer);
        drop(conn);
        assert!(matches!(
            crate::EngineStore::open(&path, 1),
            Err(crate::StorageError::StateCorrupt { source: None })
        ));
        assert!(matches!(
            crate::EngineStore::open_read_only(&path),
            Err(crate::StorageError::StateCorrupt { source: None })
        ));
    }

    #[test]
    fn v2_validation_does_not_reuse_names_from_another_database() {
        let image = closed_schema_image();
        let (_first_directory, _first_path, first) = copied_schema_connection(&image);
        let (_second_directory, _second_path, second) = copied_schema_connection(&image);
        super::validate_v2(&first).unwrap();
        second
            .execute_batch("DROP TABLE live_audit_base_publications;")
            .unwrap();
        assert!(matches!(
            super::validate_v2(&second),
            Err(crate::StorageError::StateCorrupt { source: None })
        ));
        super::validate_v2(&first).unwrap();
    }

    #[test]
    fn v2_validation_preserves_busy_as_a_transient_lock() {
        let image = closed_schema_image();
        let (_directory, path, writer) = copied_schema_connection(&image);
        writer
            .pragma_update(None, "journal_mode", "DELETE")
            .unwrap();
        let reader = rusqlite::Connection::open(&path).unwrap();
        reader.busy_timeout(std::time::Duration::ZERO).unwrap();
        writer.execute_batch("BEGIN EXCLUSIVE;").unwrap();
        assert!(matches!(
            super::validate_v2(&reader),
            Err(crate::StorageError::FileLocked)
        ));
        writer.execute_batch("ROLLBACK;").unwrap();
        super::validate_v2(&reader).unwrap();
    }
}
