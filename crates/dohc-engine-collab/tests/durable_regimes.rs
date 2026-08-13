//! The durable-layer invariants: two regimes (local-only prune vs replicated
//! never-prune), base-once, replication idempotency + echo suppression, leases,
//! and the yjs-non-atomic boundary (never journal invalid bytes). Crash-recovery
//! / exactly-once tests live behind the `fault-injection` feature.

mod common;

use common::*;
use dohc_engine_collab::ContentKind;
use dohc_engine_collab::{
    apply_remote_update, claim_base, claim_base_at_relay, close_session, ensure_marker,
    fresh_successor_base, load_persisted, read_marker, record_base_coordinate, record_local_update,
    record_local_update_creating_marker_guarded,
    record_local_update_creating_marker_guarded_for_lineage, replace_lineage_with_successor,
    settle, BaseCoordinateRecord, BaseRelayCoordinate, ClaimOutcome, CloseOutcome, CollabError,
    DocKey, LeaseRegistry, LineageClaimStatus, Regime, RemoteUpdate, ReplicationApplyOutcome,
    SettleOutcome, SuccessorIdentity, SuccessorIdentityInput, SuccessorInstallOutcome,
    SuccessorReplacement, Ydoc,
};
use dohc_engine_storage::{EngineStore, NoFaults, TxnOutcome};
use rusqlite::OptionalExtension;

fn committed<T>(o: TxnOutcome<T>) -> T {
    match o {
        TxnOutcome::Committed(v) => v,
        TxnOutcome::Crashed { .. } => panic!("expected committed, got crashed"),
    }
}

/// Mark a `settle()` call's OWN materialization job complete. Every test
/// below that seeds an ADDITIONAL pending job to prove the close guard
/// blocks on THAT job must call this first — the settle's own job (still
/// pending, same target path) would otherwise block the close by itself,
/// and the seeded job would prove nothing: deleting it would flip no
/// assertion.
fn land_settle_job(store: &mut EngineStore, outcome: &SettleOutcome) {
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE materialization_jobs SET status = 'complete' WHERE job_id = ?1",
                [&outcome.job_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .expect("land the settle's own job");
}

/// A small plaintext lineage: (base full-state bytes, a follow-up remote delta).
fn plaintext_base_and_delta() -> (Vec<u8>, Vec<u8>) {
    let doc = Ydoc::wire();
    doc.plaintext_insert(0, "hello ");
    let base = doc.encode_full_state();
    // A peer resumes the base and edits → the delta is a valid remote op.
    let peer = Ydoc::wire();
    peer.apply(&base).expect("peer base");
    let delta = peer.plaintext_insert(6, "world");
    (base, delta)
}

#[derive(Debug, PartialEq, Eq)]
struct StoredMarkerFingerprint {
    content_kind: String,
    regime: String,
    updated_at_ms: i64,
    base_origin_id: Option<String>,
    base_origin_seq: Option<i64>,
    base_relay_seq: Option<i64>,
    base_relay_confirmed_absent: i64,
}

#[derive(Debug, PartialEq, Eq)]
struct LineageStorageFingerprint {
    active_claim: Option<String>,
    marker: Option<StoredMarkerFingerprint>,
    base: Option<(String, String)>,
    updates: i64,
    snapshots: i64,
    inactive_lineages: i64,
    blobs: i64,
}

fn lineage_storage_fingerprint(store: &EngineStore, key: &DocKey) -> LineageStorageFingerprint {
    store
        .read_with(|conn| -> Result<_, CollabError> {
            let active_claim = conn
                .query_row(
                    "SELECT lineage_claim_id FROM ydoc_docs \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                    |row| row.get(0),
                )
                .map_err(|error| CollabError::Corrupt {
                    reason: error.to_string(),
                })?;
            let marker = conn
                .query_row(
                    "SELECT content_kind,regime,updated_at_ms,base_origin_id,
                            base_origin_seq,base_relay_seq,base_relay_confirmed_absent
                       FROM ydoc_docs
                      WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                    |row| {
                        Ok(StoredMarkerFingerprint {
                            content_kind: row.get(0)?,
                            regime: row.get(1)?,
                            updated_at_ms: row.get(2)?,
                            base_origin_id: row.get(3)?,
                            base_origin_seq: row.get(4)?,
                            base_relay_seq: row.get(5)?,
                            base_relay_confirmed_absent: row.get(6)?,
                        })
                    },
                )
                .optional()
                .map_err(|error| CollabError::Corrupt {
                    reason: error.to_string(),
                })?;
            let count = |table: &str| -> Result<i64, CollabError> {
                conn.query_row(
                    &format!(
                        "SELECT COUNT(*) FROM {table} \
                         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3"
                    ),
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                    |row| row.get(0),
                )
                .map_err(|error| CollabError::Corrupt {
                    reason: error.to_string(),
                })
            };
            let snapshot: (Option<String>, Option<String>) = conn
                .query_row(
                    "SELECT MAX(snapshot_blob_sha256), MAX(state_vector_blob_sha256) \
                     FROM ydoc_snapshots \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
                       AND up_to_seq=0",
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|error| CollabError::Corrupt {
                    reason: error.to_string(),
                })?;
            let blob_count = conn
                .query_row("SELECT COUNT(*) FROM binary_blobs", [], |row| row.get(0))
                .map_err(|error| CollabError::Corrupt {
                    reason: error.to_string(),
                })?;
            Ok(LineageStorageFingerprint {
                active_claim,
                marker,
                base: snapshot.0.zip(snapshot.1),
                updates: count("ydoc_updates")?,
                snapshots: count("ydoc_snapshots")?,
                inactive_lineages: count("ydoc_inactive_lineages")?,
                blobs: blob_count,
            })
        })
        .expect("lineage storage fingerprint")
}

fn record_update_transaction_fingerprint(store: &EngineStore, key: &DocKey) -> Vec<String> {
    store
        .read_with(|conn| -> Result<Vec<String>, CollabError> {
            let mut statement = conn
                .prepare(
                    "SELECT row_state FROM ( \
                     SELECT 'doc|' || quote(path) || '|' || content_kind || '|' || regime || '|' || \
                            head_update_seq || '|' || head_snapshot_seq || '|' || \
                            lineage_claim_status || '|' || quote(lineage_claim_id) || '|' || \
                            updated_at_ms AS row_state \
                     FROM ydoc_docs \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
                     UNION ALL \
                     SELECT 'update|' || seq || '|' || update_blob_sha256 || '|' || \
                            quote(actor_origin_id) || '|' || recorded_at_ms \
                     FROM ydoc_updates \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
                     UNION ALL \
                     SELECT 'snapshot|' || up_to_seq || '|' || snapshot_blob_sha256 || '|' || \
                            state_vector_blob_sha256 || '|' || recorded_at_ms \
                     FROM ydoc_snapshots \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
                     UNION ALL \
                     SELECT 'request|' || request_id || '|' || payload_hash || '|' || \
                            result_seq || '|' || committed_at || '|' || kind \
                     FROM engine_requests \
                     UNION ALL \
                     SELECT 'binary|' || sha256 || '|' || byte_length || '|' || hex(bytes) \
                     FROM binary_blobs \
                     UNION ALL \
                     SELECT 'log|' || workspace_id || '|' || origin_id || '|' || origin_seq || '|' || \
                            op_kind || '|' || payload_json || '|' || recorded_at_ms || '|' || imported \
                     FROM replication_log \
                     ) ORDER BY row_state",
                )
                .map_err(|error| CollabError::Corrupt {
                    reason: error.to_string(),
                })?;
            let rows = statement
                .query_map(
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                    |row| row.get(0),
                )
                .map_err(|error| CollabError::Corrupt {
                    reason: error.to_string(),
                })?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| CollabError::Corrupt {
                    reason: error.to_string(),
                })?;
            Ok(rows)
        })
        .expect("recordUpdate transaction fingerprint")
}

#[test]
fn record_update_request_identity_binds_path_before_any_mutation() {
    const FIRST_PATH: &str = "notes/first.md";
    const OTHER_PATH: &str = "notes/other.md";
    const REQUEST_ID: &str = "ydoc-record-path-bound";

    let mut ts = fresh_store("record-update-path-bound");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    let update = Ydoc::wire().plaintext_insert(0, "hello");

    let first = committed(
        record_local_update_creating_marker_guarded(
            &mut ts.store,
            &key,
            Some(FIRST_PATH),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &update,
            None,
            false,
            true,
            Some(REQUEST_ID),
            &NoFaults,
            1_100,
            |_tx, _outcome| Ok(()),
        )
        .expect("first recordUpdate"),
    );
    assert!(!first.deduped);
    let committed_state = record_update_transaction_fingerprint(&ts.store, &key);

    let replay = committed(
        record_local_update_creating_marker_guarded(
            &mut ts.store,
            &key,
            Some(FIRST_PATH),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &update,
            None,
            false,
            true,
            Some(REQUEST_ID),
            &NoFaults,
            1_200,
            |_tx, _outcome| Ok(()),
        )
        .expect("exact recordUpdate replay"),
    );
    assert!(replay.deduped);
    assert_eq!(
        record_update_transaction_fingerprint(&ts.store, &key),
        committed_state,
        "an exact same-path replay must not mutate durable state"
    );

    let error = record_local_update_creating_marker_guarded(
        &mut ts.store,
        &key,
        Some(OTHER_PATH),
        ContentKind::Plaintext,
        Regime::LocalOnly,
        &update,
        None,
        false,
        true,
        Some(REQUEST_ID),
        &NoFaults,
        1_300,
        |_tx, _outcome| Ok(()),
    )
    .expect_err("a request id cannot be reused for another path");
    assert!(matches!(
        error,
        CollabError::Corrupt { reason }
            if reason == "idempotency key reused with different content"
    ));
    assert_eq!(
        record_update_transaction_fingerprint(&ts.store, &key),
        committed_state,
        "a path-mismatched replay must roll back every durable mutation"
    );
}

#[test]
fn record_update_lineage_guard_refuses_stale_sessions_before_any_mutation() {
    let mut ts = fresh_store("record-update-lineage-guard");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    let (base, _) = plaintext_base_and_delta();
    let claim_id = match committed(
        claim_base(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &base,
            &NoFaults,
            1_050,
        )
        .expect("claim active lineage"),
    ) {
        ClaimOutcome::Claimed { base_snapshot_sha } => base_snapshot_sha,
        other => panic!("unexpected claim outcome: {other:?}"),
    };
    let peer = Ydoc::wire();
    peer.apply(&base).expect("load active lineage");
    let update = peer.plaintext_insert(6, "session edit");
    let before = record_update_transaction_fingerprint(&ts.store, &key);

    let error = record_local_update_creating_marker_guarded_for_lineage(
        &mut ts.store,
        &key,
        Some("notes/stale-session.md"),
        ContentKind::Plaintext,
        Regime::LocalOnly,
        &update,
        Some("local-origin"),
        Some(&"0".repeat(64)),
        true,
        false,
        Some("stale-session-request"),
        &NoFaults,
        1_100,
        |_tx, _outcome| panic!("a stale lineage must not reach post-append"),
    )
    .expect_err("stale session claim must refuse the write");
    assert!(matches!(
        error,
        CollabError::LineageWriteStale {
            expected: Some(expected),
            observed: Some(observed),
        } if expected == "0".repeat(64) && observed == claim_id
    ));
    assert_eq!(
        record_update_transaction_fingerprint(&ts.store, &key),
        before,
        "the lineage guard runs before path, parent, blob, update, request, and log mutation"
    );
}

// ---- regimes ----------------------------------------------------------------

#[test]
fn another_workspaces_pending_job_cannot_block_this_close() {
    // Every file, chat and capture is scoped to a workspace, and this guard
    // was not: it matched a pending `resolve-mat_<moment>` /
    // `ydoc-mat_<moment>` job by moment id alone. Moment ids are
    // caller-supplied and keyed `(workspace_id, moment_id)`, so two
    // workspaces may hold the same one — and workspace B's unfinished job
    // then held workspace A's settled local-only close in UnsettledClose
    // until B drained. One workspace's backlog blocking another is the
    // invariant break, not the delay.
    //
    // The fixture is the PREDICATE, not the scenario: two rows that differ
    // only by workspace. The job below is byte-identical to one that must
    // block this close, except that it belongs to someone else.
    //
    // MUTATION: drop the `j.workspace_id` predicate from the pending-job
    // check in `close_session` — this close returns UnsettledClose and the
    // expect below fails.
    let mut ts = fresh_store("cross-workspace-pending");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    let doc = Ydoc::wire();
    let delta = doc.plaintext_insert(0, "mine");
    committed(record_local_update(&mut ts.store, &key, &delta, &NoFaults, 1_000).expect("rec"));
    let settle_outcome =
        committed(settle(&mut ts.store, &key, "notes/doc.md", &NoFaults, 1_200).expect("settle"));
    // The settle's OWN job must land before this test's cross-workspace
    // collision means anything — a still-pending job for THIS object's own
    // path is correctly blocking (#715: the guard now reads any pending job
    // aimed at the path, not just certain job-id spellings), and asserting
    // through it would test that instead of the workspace-scoping bug below.
    land_settle_job(&mut ts.store, &settle_outcome);

    // The guard joins `moments`, so this lineage needs the settle moment a
    // domain-layer settle would have written — without it the join matches
    // nothing and the test would pass against the bug.
    let shared_moment = "shared-moment-id";
    ts.store
        .write_with(&NoFaults, |tx| {
            let text_sha = dohc_engine_storage::hex_sha256(b"mine");
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256, byte_length, text) \
                 VALUES (?1, 4, 'mine')",
                [&text_sha],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute(
                "INSERT OR IGNORE INTO versions \
                 (workspace_id, version_id, kind, name, created_at_ms) \
                 VALUES (?1, ?2, 'main', 'main', 1)",
                rusqlite::params![key.workspace_id, key.version_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO moments \
                 (workspace_id, moment_order, moment_id, version_id, object_id, path, \
                  recorded_at_ms, operation, after_blob_sha256, before_present, \
                  metadata_origin) \
                 VALUES (?1, 0, ?2, ?3, ?4, 'notes/doc.md', 1, 'write', ?5, 0, 'ydoc')",
                rusqlite::params![
                    key.workspace_id,
                    shared_moment,
                    key.version_id,
                    key.object_id,
                    text_sha
                ],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            // ANOTHER workspace's pending resolution job, keyed off THIS
            // workspace's moment id — the collision the schema permits.
            let sha = dohc_engine_storage::put_binary_blob(tx, b"other workspace bytes")?;
            tx.execute(
                "INSERT INTO materialization_jobs \
                 (job_id, workspace_id, target_path, content_sha256, preimage_present, \
                  target_generation, status, created_at_ms, operation) \
                 VALUES (?1, 'other-workspace', 'notes/other.md', ?2, 0, 1, \
                         'pending', 1, 'write')",
                rusqlite::params![format!("resolve-mat_{shared_moment}"), sha],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .expect("seed the colliding cross-workspace job");

    let out = committed(
        close_session(&mut ts.store, &key, false, &NoFaults, 1_400)
            .expect("another workspace's backlog must not block this close"),
    );
    assert!(
        matches!(out, CloseOutcome::Pruned { .. }),
        "the settled local-only lineage prunes: {out:?}"
    );

    // The same job under THIS workspace must still block — otherwise the
    // fix would have been "ignore pending jobs", not "scope them".
    let mut ts2 = fresh_store("same-workspace-pending");
    let key2 = test_key();
    seed_parents(&mut ts2.store, &key2, 1_000);
    committed(
        ensure_marker(
            &mut ts2.store,
            &key2,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    let doc2 = Ydoc::wire();
    let delta2 = doc2.plaintext_insert(0, "mine");
    committed(record_local_update(&mut ts2.store, &key2, &delta2, &NoFaults, 1_000).expect("rec"));
    let settle_outcome2 =
        committed(settle(&mut ts2.store, &key2, "notes/doc.md", &NoFaults, 1_200).expect("settle"));
    // Land THIS settle's own job too — the seeded job below must be the
    // ONLY thing this half blocks on, or it proves nothing either.
    land_settle_job(&mut ts2.store, &settle_outcome2);
    ts2.store
        .write_with(&NoFaults, |tx| {
            let text_sha = dohc_engine_storage::hex_sha256(b"mine");
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256, byte_length, text) \
                 VALUES (?1, 4, 'mine')",
                [&text_sha],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute(
                "INSERT OR IGNORE INTO versions \
                 (workspace_id, version_id, kind, name, created_at_ms) \
                 VALUES (?1, ?2, 'main', 'main', 1)",
                rusqlite::params![key2.workspace_id, key2.version_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO moments \
                 (workspace_id, moment_order, moment_id, version_id, object_id, path, \
                  recorded_at_ms, operation, after_blob_sha256, before_present, \
                  metadata_origin) \
                 VALUES (?1, 0, ?2, ?3, ?4, 'notes/doc.md', 1, 'write', ?5, 0, 'ydoc')",
                rusqlite::params![
                    key2.workspace_id,
                    shared_moment,
                    key2.version_id,
                    key2.object_id,
                    text_sha
                ],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            let sha = dohc_engine_storage::put_binary_blob(tx, b"my own bytes")?;
            tx.execute(
                "INSERT INTO materialization_jobs \
                 (job_id, workspace_id, target_path, content_sha256, preimage_present, \
                  target_generation, status, created_at_ms, operation) \
                 VALUES (?1, ?2, 'notes/doc.md', ?3, 0, 1, 'pending', 1, 'write')",
                rusqlite::params![
                    format!("resolve-mat_{shared_moment}"),
                    key2.workspace_id,
                    sha
                ],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .expect("seed this workspace's own pending job");
    assert!(
        matches!(
            close_session(&mut ts2.store, &key2, false, &NoFaults, 1_400),
            Err(CollabError::UnsettledClose)
        ),
        "this workspace's own pending job must still hold the prune"
    );
}

/// #715. The local-only prune guard's pending-materialization check matched
/// only the `ydoc-mat_` / `resolve-mat_` job-id prefixes. `enqueue_write`
/// also mints `merge-mat_`, `sync-resolve-mat_`, and `secret-mat_` — a
/// pending job under any of those three still targets this object's disk
/// artifact, but went unmatched and let the close prune the CRDT cache while
/// the materialization that would rewrite the file was still queued (a
/// stale-disk window, not data loss: `blobs`/`snapshots` still hold the
/// content).
///
/// One test per prefix, settle-then-seed a same-path pending job of exactly
/// that kind, and require the close to refuse. `job_id_prefix` also names
/// the scratch store — every prefix is a distinct valid identifier already.
///
/// The settle's OWN job is landed (marked complete) before the seeded job:
/// otherwise that still-pending job — same target path — would block the
/// close by itself, and the seeded job would prove nothing (deleting it
/// would flip no assertion).
///
/// MUTATION: restore the `ydoc-mat_` / `resolve-mat_` job-id prefix match in
/// `close_session`'s pending-job query — each of these three still-pending
/// jobs stops blocking and the assert fails.
fn assert_pending_job_of_kind_blocks_close(job_id_prefix: &str) {
    let mut ts = fresh_store(job_id_prefix);
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    let doc = Ydoc::wire();
    let delta = doc.plaintext_insert(0, "mine");
    committed(record_local_update(&mut ts.store, &key, &delta, &NoFaults, 1_000).expect("rec"));
    let settle_outcome =
        committed(settle(&mut ts.store, &key, "notes/doc.md", &NoFaults, 1_200).expect("settle"));
    land_settle_job(&mut ts.store, &settle_outcome);

    let moment_id = "settle-moment-id";
    ts.store
        .write_with(&NoFaults, |tx| {
            let text_sha = dohc_engine_storage::hex_sha256(b"mine");
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256, byte_length, text) \
                 VALUES (?1, 4, 'mine')",
                [&text_sha],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute(
                "INSERT OR IGNORE INTO versions \
                 (workspace_id, version_id, kind, name, created_at_ms) \
                 VALUES (?1, ?2, 'main', 'main', 1)",
                rusqlite::params![key.workspace_id, key.version_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO moments \
                 (workspace_id, moment_order, moment_id, version_id, object_id, path, \
                  recorded_at_ms, operation, after_blob_sha256, before_present, \
                  metadata_origin) \
                 VALUES (?1, 0, ?2, ?3, ?4, 'notes/doc.md', 1, 'write', ?5, 0, 'ydoc')",
                rusqlite::params![
                    key.workspace_id,
                    moment_id,
                    key.version_id,
                    key.object_id,
                    text_sha
                ],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            // The still-pending job this object's own materialization would
            // land under `job_id_prefix` — the exact same shape as
            // `ydoc-mat_`/`resolve-mat_`, just a different spelling.
            let sha = dohc_engine_storage::put_binary_blob(tx, b"pending bytes")?;
            tx.execute(
                "INSERT INTO materialization_jobs \
                 (job_id, workspace_id, target_path, content_sha256, preimage_present, \
                  target_generation, status, created_at_ms, operation) \
                 VALUES (?1, ?2, 'notes/doc.md', ?3, 0, 1, 'pending', 1, 'write')",
                rusqlite::params![format!("{job_id_prefix}{moment_id}"), key.workspace_id, sha],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .expect("seed the pending job");

    assert!(
        matches!(
            close_session(&mut ts.store, &key, false, &NoFaults, 1_400),
            Err(CollabError::UnsettledClose)
        ),
        "a pending '{job_id_prefix}' job must hold the prune"
    );
}

#[test]
fn a_pending_merge_mat_job_blocks_the_local_close() {
    assert_pending_job_of_kind_blocks_close("merge-mat_");
}

#[test]
fn a_pending_sync_resolve_mat_job_blocks_the_local_close() {
    assert_pending_job_of_kind_blocks_close("sync-resolve-mat_");
}

#[test]
fn a_pending_secret_mat_job_blocks_the_local_close() {
    assert_pending_job_of_kind_blocks_close("secret-mat_");
}

#[test]
fn local_only_close_prunes_the_cache() {
    let mut ts = fresh_store("local-prune");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    let doc = Ydoc::wire();
    for i in 0..3 {
        let d = doc.plaintext_insert((i * 2) as u32, "ab");
        committed(record_local_update(&mut ts.store, &key, &d, &NoFaults, 1_000).expect("rec"));
    }
    assert_eq!(count(&ts.store, "ydoc_updates", &key), 3);

    // A close BEFORE settling refuses to prune (would discard unsettled edits).
    assert!(matches!(
        close_session(&mut ts.store, &key, false, &NoFaults, 1_500),
        Err(CollabError::UnsettledClose)
    ));
    assert_eq!(
        count(&ts.store, "ydoc_updates", &key),
        3,
        "refused close kept the cache"
    );

    // Settle the head, THEN close — now the .md covers the head, safe to prune.
    committed(settle(&mut ts.store, &key, "notes/doc.md", &NoFaults, 1_800).expect("settle"));
    let out =
        committed(close_session(&mut ts.store, &key, false, &NoFaults, 2_000).expect("close"));
    assert!(
        matches!(out, CloseOutcome::Pruned { .. }),
        "local-only prunes"
    );
    // The CRDT cache is gone; the marker survives (markdown-is-the-artifact).
    assert_eq!(count(&ts.store, "ydoc_updates", &key), 0, "updates pruned");
    assert_eq!(
        count(&ts.store, "ydoc_snapshots", &key),
        0,
        "snapshots pruned"
    );
    assert!(
        read_marker(&ts.store, &key).expect("read").is_some(),
        "marker kept"
    );
}

/// Seed a head for the object: the version row, the text blob, and the
/// `snapshots` row that points at it.
///
/// `engine_write_status` is what separates the two directions, and now also
/// picks the realistic `metadata_origin` for each (#723: `captured_head_sha`
/// reads that column directly). `None` is the disk -> engine direction — a
/// capture read the file, so no materialization job exists, the head's
/// origin is `"capture"`, and the bytes are the disk's. `Some(status)` is the
/// engine -> disk direction: a job was minted to put these bytes on the file
/// (origin `"ydoc"`, the real settle write's own origin), and only that
/// job's outcome says whether the disk ever received them.
fn seed_head(
    store: &mut dohc_engine_storage::EngineStore,
    key: &DocKey,
    text: &str,
    engine_write_status: Option<&str>,
) {
    let metadata_origin = if engine_write_status.is_some() {
        "ydoc"
    } else {
        "capture"
    };
    store
        .write_with(&NoFaults, |tx| {
            let sha = dohc_engine_storage::hex_sha256(text.as_bytes());
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?1, ?2, ?3)",
                rusqlite::params![sha, text.len() as i64, text],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute(
                "INSERT OR IGNORE INTO versions \
                 (workspace_id, version_id, kind, name, created_at_ms) \
                 VALUES (?1, ?2, 'main', 'main', 1)",
                rusqlite::params![key.workspace_id, key.version_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute(
                "INSERT OR REPLACE INTO snapshots \
                 (workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms, \
                  latest_moment_id, metadata_origin) \
                 VALUES (?1, ?2, ?3, 'notes/doc.md', ?4, 1, 'head-moment', ?5)",
                rusqlite::params![
                    key.workspace_id,
                    key.version_id,
                    key.object_id,
                    sha,
                    metadata_origin
                ],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            if let Some(status) = engine_write_status {
                let binary_sha = dohc_engine_storage::put_binary_blob(tx, text.as_bytes())?;
                tx.execute(
                    "INSERT OR REPLACE INTO materialization_jobs \
                     (job_id, workspace_id, target_path, content_sha256, preimage_present, \
                      target_generation, status, created_at_ms, operation) \
                     VALUES ('ydoc-mat_head-moment', ?1, 'notes/doc.md', ?2, 0, 1, ?3, 1, 'write')",
                    rusqlite::params![key.workspace_id, binary_sha, status],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
            }
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .expect("seed the head");
}

#[test]
fn a_captured_head_lets_a_never_settled_local_close_prune() {
    // #665. The prune guard asks one question — does the artifact already hold
    // these bytes — and used to read one column, `last_settled_sha`, which only
    // a SETTLE writes. A capture puts the document's own projection into the
    // head and touches no column, so the guard refused a document that was
    // already on disk, and capture -> discharge -> open never converged: every
    // lap refused, and the file stayed read-only until the daemon restarted.
    //
    // MUTATION: drop the `head_content_sha` arm from the `covered` check in
    // `close_session` — this close returns UnsettledClose and the expect below
    // fails.
    let mut ts = fresh_store("captured-head-prune");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    let doc = Ydoc::wire();
    let delta = doc.plaintext_insert(0, "what the user typed");
    committed(record_local_update(&mut ts.store, &key, &delta, &NoFaults, 1_100).expect("rec"));
    seed_head(&mut ts.store, &key, "what the user typed", None);

    let out =
        committed(close_session(&mut ts.store, &key, false, &NoFaults, 1_400).expect("close"));
    assert!(
        matches!(out, CloseOutcome::Pruned { .. }),
        "a head that already holds the projection covers the prune: {out:?}"
    );
    assert_eq!(count(&ts.store, "ydoc_updates", &key), 0, "updates pruned");
}

#[test]
fn a_head_holding_other_bytes_still_refuses_the_local_close() {
    // The other half of the same rule, and the reason the fix is a COMPARISON
    // rather than "a head exists". A file the user edited outside dohc has a
    // head too, and pruning against it would discard the document's own text
    // with nothing on disk holding it.
    let mut ts = fresh_store("stale-head-refuses");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    let doc = Ydoc::wire();
    let delta = doc.plaintext_insert(0, "what the user typed");
    committed(record_local_update(&mut ts.store, &key, &delta, &NoFaults, 1_100).expect("rec"));
    seed_head(&mut ts.store, &key, "something else entirely", None);

    assert!(
        matches!(
            close_session(&mut ts.store, &key, false, &NoFaults, 1_400),
            Err(CollabError::UnsettledClose)
        ),
        "a head that holds OTHER bytes proves nothing about this document"
    );
    assert_eq!(
        count(&ts.store, "ydoc_updates", &key),
        1,
        "the refused close kept the cache"
    );
}

#[test]
fn a_head_the_engine_wrote_but_never_landed_still_refuses_the_local_close() {
    // #713 review, P1-a. A settle advances the head AND writes
    // `last_settled_sha`, then its materialization job finds newer bytes on
    // the file. `ydoc_settle_on_store` marks that job terminal and NULLs
    // `last_settled_sha` — its own comment says why: "so close(settle:false)
    // refuses UnsettledClose instead of pruning"
    // (crates/dohc-engine-runtime/src/actor.rs).
    //
    // The head still holds the projection and the job is no longer pending,
    // so a fallback that asked only "do the head's bytes match" would call
    // this covered and prune the CRDT while the FILE holds someone else's
    // content. Everything typed into the session would be gone.
    //
    // The direction is what the fallback reads, not the bytes. A capture is
    // disk -> engine and mints no job, so its head's origin is "capture". A
    // head the engine wrote has origin "ydoc", and only `last_settled_sha`
    // says whether the file ever received it — this state is exactly the one
    // where the settle withdrew that proof.
    //
    // MUTATION: drop the `metadata_origin = CAPTURE_ORIGIN` predicate from
    // `captured_head_sha` (answer "captured" for every head) — this close
    // prunes and the assert below fails.
    let mut ts = fresh_store("engine-head-never-landed");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    let doc = Ydoc::wire();
    let delta = doc.plaintext_insert(0, "what the user typed");
    committed(record_local_update(&mut ts.store, &key, &delta, &NoFaults, 1_100).expect("rec"));
    seed_head(&mut ts.store, &key, "what the user typed", Some("conflict"));

    assert!(
        matches!(
            close_session(&mut ts.store, &key, false, &NoFaults, 1_400),
            Err(CollabError::UnsettledClose)
        ),
        "a head whose materialization conflicted is not on disk, whatever it holds"
    );
    assert_eq!(
        count(&ts.store, "ydoc_updates", &key),
        1,
        "the refused close kept the cache"
    );

    // A COMPLETED job is the same direction and refuses here too. That path
    // has its own proof — `last_settled_sha`, which a completed settle keeps
    // — and this fallback deliberately answers for captures only.
    let mut settled = fresh_store("engine-head-that-landed");
    let key2 = test_key();
    seed_parents(&mut settled.store, &key2, 1_000);
    committed(
        ensure_marker(
            &mut settled.store,
            &key2,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    let doc2 = Ydoc::wire();
    let delta2 = doc2.plaintext_insert(0, "what the user typed");
    committed(
        record_local_update(&mut settled.store, &key2, &delta2, &NoFaults, 1_100).expect("rec"),
    );
    seed_head(
        &mut settled.store,
        &key2,
        "what the user typed",
        Some("complete"),
    );
    assert!(
        matches!(
            close_session(&mut settled.store, &key2, false, &NoFaults, 1_400),
            Err(CollabError::UnsettledClose)
        ),
        "an engine-written head answers through the settle marker, not this fallback"
    );
}

#[test]
fn a_captured_reversion_discharges_despite_a_leftover_completed_job_row() {
    // #723. `captured_head_sha` used to answer "captured" with
    // `NOT EXISTS (materialization_jobs WHERE content+path match)`. An
    // EARLIER, unrelated engine settle for this exact content and path
    // leaves its job row behind after it completes — the table is a ledger,
    // not a lease — so a LATER, genuine capture that reverts the disk to
    // those same bytes still finds that leftover row and reads as "not
    // captured", refusing a discharge the direction plainly allows.
    //
    // `claim_foreign_head`'s dedupe (store.rs) is the real capture path: it
    // flips `snapshots.metadata_origin` to "capture" and mints no job row at
    // all, so the fixed predicate sees the capture directly.
    //
    // MUTATION: restore the `NOT EXISTS (materialization_jobs …)` predicate
    // in `captured_head_sha` — this close returns UnsettledClose and the
    // expect below fails.
    let mut ts = fresh_store("captured-reversion-leftover-job");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    let doc = Ydoc::wire();
    let delta = doc.plaintext_insert(0, "what the user typed");
    committed(record_local_update(&mut ts.store, &key, &delta, &NoFaults, 1_100).expect("rec"));

    // The earlier engine settle: a completed job for this exact content and
    // path — the leftover row the old heuristic tripped on.
    seed_head(&mut ts.store, &key, "what the user typed", Some("complete"));
    // The later capture: disk reverted to the same bytes. `claim_foreign_head`
    // rewrites the snapshot's origin in place and mints no new job — `None`
    // reproduces exactly that, leaving the completed job row untouched.
    seed_head(&mut ts.store, &key, "what the user typed", None);

    let out =
        committed(close_session(&mut ts.store, &key, false, &NoFaults, 1_400).expect("close"));
    assert!(
        matches!(out, CloseOutcome::Pruned { .. }),
        "a genuine capture discharges despite a leftover completed job row: {out:?}"
    );
}

#[test]
fn a_binary_head_refuses_the_close_by_name_instead_of_failing_internally() {
    // #713 substitution review. `snapshots.blob_sha256` is NULL for a BINARY
    // head (schema v10), which a live path reaches: write bytes that stop
    // round-tripping as UTF-8 and capture flips the head's kind. Reading that
    // column as a non-optional String makes rusqlite raise InvalidColumnType,
    // and `.optional()` absorbs only QueryReturnedNoRows — so the close
    // answered `Internal: workspace operation failed`.
    //
    // It failed CLOSED, so nothing was lost. It was still the wrong answer:
    // an agent reading that cannot tell a corrupt store from a document it
    // simply has to settle first (AGENTS.md: show agents the limits they
    // hit). A NULL head sha covers nothing, and saying so is the whole fix.
    //
    // MUTATION: read the column as `String` again -> this close returns
    // Storage/Corrupt and the match below fails.
    let mut ts = fresh_store("binary-head-refusal");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    let doc = Ydoc::wire();
    let delta = doc.plaintext_insert(0, "what the user typed");
    committed(record_local_update(&mut ts.store, &key, &delta, &NoFaults, 1_100).expect("rec"));
    ts.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO versions \
                 (workspace_id, version_id, kind, name, created_at_ms) \
                 VALUES (?1, ?2, 'main', 'main', 1)",
                rusqlite::params![key.workspace_id, key.version_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            let binary_sha = dohc_engine_storage::put_binary_blob(tx, &[0xff, 0xfe, 0x00])?;
            tx.execute(
                "INSERT OR REPLACE INTO snapshots \
                 (workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms, \
                  latest_moment_id, metadata_origin, content_kind, binary_sha256) \
                 VALUES (?1, ?2, ?3, 'notes/doc.md', NULL, 1, 'binary-moment', 'capture', \
                         'binary', ?4)",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id, binary_sha],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .expect("seed the binary head");

    assert!(
        matches!(
            close_session(&mut ts.store, &key, false, &NoFaults, 1_400),
            Err(CollabError::UnsettledClose)
        ),
        "a binary head holds none of this document's text, and the refusal must say so"
    );
}

#[test]
fn replicated_close_never_prunes_the_lineage() {
    let mut ts = fresh_store("repl-keep");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    let (base, delta) = plaintext_base_and_delta();
    let claim = committed(
        claim_base(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &base,
            &NoFaults,
            1_000,
        )
        .expect("base"),
    );
    assert!(matches!(claim, ClaimOutcome::Claimed { .. }));
    committed(record_local_update(&mut ts.store, &key, &delta, &NoFaults, 1_100).expect("rec"));

    let before = load_persisted(&ts.store, &key)
        .expect("load")
        .expect("m")
        .doc
        .canonical_content_sha256();
    let out =
        committed(close_session(&mut ts.store, &key, false, &NoFaults, 2_000).expect("close"));
    assert!(
        matches!(out, CloseOutcome::Compacted(_)),
        "replicated compacts, not prunes"
    );
    // Durable lineage survives: a snapshot remains and reconstructs identically —
    // a peer can bootstrap from it.
    assert!(
        count(&ts.store, "ydoc_snapshots", &key) >= 1,
        "snapshot durable"
    );
    let after = load_persisted(&ts.store, &key)
        .expect("load")
        .expect("m")
        .doc
        .canonical_content_sha256();
    assert_eq!(before, after, "content preserved across replicated close");
}

#[test]
fn local_to_shared_transition_keeps_the_base() {
    // INDIVIDUAL-FIRST → shared (a CORE workflow, product invariant "open when
    // shared"). A doc starts local-only; later it is shared, which claims a base.
    // The claim MUST promote the marker to replicated so the next close compacts-
    // not-prunes and the just-claimed base survives for peers.
    let mut ts = fresh_store("local-to-shared");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    assert_eq!(
        read_marker(&ts.store, &key).expect("m").expect("m").regime,
        Regime::LocalOnly
    );

    let (base, _) = plaintext_base_and_delta();
    committed(
        claim_base(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &base,
            &NoFaults,
            1_100,
        )
        .expect("base"),
    );
    // Promoted to replicated by the claim.
    assert_eq!(
        read_marker(&ts.store, &key).expect("m").expect("m").regime,
        Regime::Replicated,
        "claim_base must promote local-only → replicated"
    );
    assert_eq!(count(&ts.store, "ydoc_snapshots", &key), 1, "base claimed");

    // Close must now COMPACT (not prune), preserving the base for peers.
    let out =
        committed(close_session(&mut ts.store, &key, false, &NoFaults, 2_000).expect("close"));
    assert!(
        matches!(out, CloseOutcome::Compacted(_)),
        "shared close compacts"
    );
    assert!(
        count(&ts.store, "ydoc_snapshots", &key) >= 1,
        "base survives close"
    );
    assert!(
        load_persisted(&ts.store, &key).expect("load").is_some(),
        "lineage reconstructs"
    );
}

#[test]
fn append_self_bounds_the_log_at_threshold() {
    // The "everything bounded" invariant: a long-lived session that NEVER calls
    // maybe_compact/close_session must still keep a finite log — record_local_update
    // self-triggers compaction past the default threshold.
    let mut ts = fresh_store("self-bound");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    let threshold = dohc_engine_collab::limits::DEFAULT_COMPACTION_THRESHOLD as i64;
    let doc = Ydoc::wire();
    for i in 0..(threshold + 1) {
        let d = doc.plaintext_insert(i as u32, "x");
        committed(record_local_update(&mut ts.store, &key, &d, &NoFaults, 1_000 + i).expect("rec"));
    }
    // The log folded itself: far fewer than threshold+1 update rows remain, and a
    // snapshot exists.
    let updates = count(&ts.store, "ydoc_updates", &key);
    assert!(
        updates <= 1,
        "log self-bounded, {updates} update rows remain"
    );
    assert!(
        count(&ts.store, "ydoc_snapshots", &key) >= 1,
        "a snapshot was folded"
    );
    // Content is intact after the self-compaction.
    let persisted = load_persisted(&ts.store, &key).expect("load").expect("m");
    assert_eq!(
        persisted
            .doc
            .plaintext_string()
            .chars()
            .filter(|c| *c == 'x')
            .count() as i64,
        threshold + 1
    );
}

// ---- base-once --------------------------------------------------------------

#[test]
fn base_is_claimed_exactly_once() {
    let mut ts = fresh_store("base-once");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    let (base, delta) = plaintext_base_and_delta();

    let first = committed(
        claim_base(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &base,
            &NoFaults,
            1_000,
        )
        .expect("first"),
    );
    let first_sha = match first {
        ClaimOutcome::Claimed { base_snapshot_sha } => base_snapshot_sha,
        ClaimOutcome::Resumed => panic!("first claim must mint the base"),
        other => panic!("local first claim cannot arbitrate: {other:?}"),
    };
    assert_eq!(
        read_marker(&ts.store, &key)
            .expect("m")
            .expect("marker")
            .lineage_claim_status,
        LineageClaimStatus::Exact
    );
    assert_eq!(
        count(&ts.store, "ydoc_snapshots", &key),
        1,
        "exactly one base"
    );

    // A second claim with the SAME bytes (crash-retry / redelivery) resumes.
    let second = committed(
        claim_base(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &base,
            &NoFaults,
            1_400,
        )
        .expect("second"),
    );
    assert!(
        matches!(second, ClaimOutcome::Resumed),
        "identical base retry → resume"
    );
    committed(
        apply_remote_update(
            &mut ts.store,
            &key,
            &RemoteUpdate {
                origin_id: "peer-compact-base".to_owned(),
                origin_seq: 1,
                bytes: delta,
            },
            &NoFaults,
            1_450,
        )
        .expect("append before base-proof compaction"),
    );
    let compacted = committed(
        close_session(&mut ts.store, &key, false, &NoFaults, 1_475)
            .expect("compact claimed lineage"),
    );
    assert!(matches!(compacted, CloseOutcome::Compacted(_)));
    assert_eq!(
        count(&ts.store, "ydoc_snapshots", &key),
        2,
        "compaction keeps seq 0 beside the folded head"
    );
    let after_compaction = committed(
        claim_base(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &base,
            &NoFaults,
            1_480,
        )
        .expect("retry the base after compaction"),
    );
    assert!(
        matches!(after_compaction, ClaimOutcome::Resumed),
        "the permanent seq-0 proof survives compaction"
    );
    // A claim with DIFFERENT base bytes must REFUSE — silently resuming (and
    // acking) a divergent base would drop that lineage while the relay
    // cursor advances past it. Mutation check: drop the stored-sha
    // comparison in `claim_base_in_tx`'s resumed branch — this claim then
    // resumes and the error assertion fails.
    let other = Ydoc::wire();
    other.plaintext_insert(0, "different seed");
    let other_base = other.encode_full_state();
    let diverged = claim_base(
        &mut ts.store,
        &key,
        ContentKind::Plaintext,
        &other_base,
        &NoFaults,
        1_500,
    )
    .expect_err("divergent base must refuse");
    assert!(
        matches!(diverged, CollabError::BaseStateDiverged),
        "expected BaseStateDiverged, got {diverged:?}"
    );
    assert_eq!(
        count(&ts.store, "ydoc_snapshots", &key),
        2,
        "the rejected claim changes neither proof nor folded head"
    );
    // The surviving base is the FIRST one (byte-intact).
    let base_sha_now = ts
        .store
        .read_with(|c| -> Result<String, CollabError> {
            c.query_row(
                "SELECT snapshot_blob_sha256 FROM ydoc_snapshots \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND up_to_seq=0",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |r| r.get(0),
            )
            .map_err(|e| CollabError::Corrupt {
                reason: e.to_string(),
            })
        })
        .expect("sha");
    assert_eq!(base_sha_now, first_sha, "first base survives");
}

#[test]
fn relay_base_arbitration_is_ordered_and_claim_safe() {
    let mut ts = fresh_store("relay-base-arbitration");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    let (first_base, _) = plaintext_base_and_delta();
    let first_claim = match committed(
        claim_base(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &first_base,
            &NoFaults,
            1_000,
        )
        .expect("claim local base"),
    ) {
        ClaimOutcome::Claimed { base_snapshot_sha } => base_snapshot_sha,
        other => panic!("unexpected first claim: {other:?}"),
    };
    committed(
        record_base_coordinate(
            &mut ts.store,
            BaseCoordinateRecord {
                key: &key,
                lineage_claim_id: &first_claim,
                origin_id: "first-origin",
                origin_seq: 7,
                relay_seq: Some(10),
                now_ms: 1_010,
            },
            &NoFaults,
        )
        .expect("stamp first relay coordinate"),
    );

    let later = Ydoc::wire();
    later.plaintext_insert(0, "later base");
    let later_base = later.encode_full_state();
    let before_later = lineage_storage_fingerprint(&ts.store, &key);
    let already_won = committed(
        claim_base_at_relay(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &later_base,
            &BaseRelayCoordinate::new("later-origin", 2, 20).expect("later coordinate"),
            &NoFaults,
            1_020,
        )
        .expect("earlier base wins"),
    );
    match already_won {
        ClaimOutcome::AlreadyWon { winner } => {
            assert_eq!(
                winner.lineage_claim_id.as_deref(),
                Some(first_claim.as_str())
            );
            assert_eq!(winner.content_kind, ContentKind::Plaintext);
        }
        other => panic!("expected AlreadyWon, got {other:?}"),
    }
    assert_eq!(lineage_storage_fingerprint(&ts.store, &key), before_later);

    let collision = claim_base_at_relay(
        &mut ts.store,
        &key,
        ContentKind::Plaintext,
        &later_base,
        &BaseRelayCoordinate::new("collision-origin", 4, 10).expect("collision coordinate"),
        &NoFaults,
        1_030,
    )
    .expect_err("one relay position cannot name different base bytes");
    assert!(matches!(
        collision,
        CollabError::BaseRelaySequenceCollision { relay_seq: 10 }
    ));

    let earlier = Ydoc::wire();
    earlier.plaintext_insert(0, "earlier base");
    let earlier_base = earlier.encode_full_state();
    let earlier_claim = dohc_engine_collab::hex_sha256(&earlier_base);
    let replaced = committed(
        claim_base_at_relay(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &earlier_base,
            &BaseRelayCoordinate::new("earlier-origin", 3, 5).expect("earlier coordinate"),
            &NoFaults,
            1_040,
        )
        .expect("lower relay position replaces"),
    );
    match replaced {
        ClaimOutcome::Replaced {
            losing_lineage_claim_id,
            winner,
        } => {
            assert_eq!(losing_lineage_claim_id, first_claim);
            assert_eq!(
                winner.lineage_claim_id.as_deref(),
                Some(earlier_claim.as_str())
            );
        }
        other => panic!("expected Replaced, got {other:?}"),
    }

    let replay = committed(
        claim_base_at_relay(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &earlier_base,
            &BaseRelayCoordinate::new("earlier-origin", 3, 5).expect("replay coordinate"),
            &NoFaults,
            1_050,
        )
        .expect("replay winner"),
    );
    assert!(matches!(replay, ClaimOutcome::Resumed));
    assert_eq!(
        read_marker(&ts.store, &key)
            .expect("read winner")
            .expect("winner marker")
            .lineage_claim_id
            .as_deref(),
        Some(earlier_claim.as_str()),
        "replay must not change the durable live-lineage token"
    );
}

#[test]
fn successor_cas_archives_the_exact_predecessor_and_replays_without_mutation() {
    let scratch = unique_dir("successor-cas");
    let mut store = open_at(&scratch, 1_000);
    let key = test_key();
    seed_parents(&mut store, &key, 1_000);
    let (base, delta) = plaintext_base_and_delta();
    let predecessor_claim_id = match committed(
        claim_base(
            &mut store,
            &key,
            ContentKind::Plaintext,
            &base,
            &NoFaults,
            1_000,
        )
        .expect("claim predecessor"),
    ) {
        ClaimOutcome::Claimed { base_snapshot_sha } => base_snapshot_sha,
        ClaimOutcome::Resumed => panic!("the first base must be claimed"),
        other => panic!("local first claim cannot arbitrate: {other:?}"),
    };
    committed(
        apply_remote_update(
            &mut store,
            &key,
            &RemoteUpdate {
                origin_id: "peer-a".to_owned(),
                origin_seq: 1,
                bytes: delta,
            },
            &NoFaults,
            1_100,
        )
        .expect("extend predecessor"),
    );
    committed(
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_docs SET path='notes/a.txt' \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .expect("set predecessor path"),
    );
    let predecessor = load_persisted(&store, &key)
        .expect("load predecessor")
        .expect("predecessor marker");
    assert_eq!(
        predecessor
            .doc
            .project(ContentKind::Plaintext)
            .expect("project predecessor")
            .markdown,
        "hello world"
    );
    let predecessor_state_vector_sha256 =
        dohc_engine_collab::hex_sha256(&predecessor.doc.encode_state_vector());
    assert_eq!(
        predecessor.marker.lineage_claim_id.as_deref(),
        Some(predecessor_claim_id.as_str())
    );

    let successor_text = "the reviewed result\n";
    let predecessor_preimage = dohc_engine_collab::hex_sha256(b"hello world");
    let successor_result = dohc_engine_collab::hex_sha256(successor_text.as_bytes());
    let successor_identity = SuccessorIdentity::derive(SuccessorIdentityInput {
        key: &key,
        predecessor_claim_id: &predecessor_claim_id,
        predecessor_state_vector_sha256: &predecessor_state_vector_sha256,
        artifact_op_kind: "moment.append",
        artifact_id: "moment-successor",
        artifact_preimage_sha256: &predecessor_preimage,
        content_kind: ContentKind::Plaintext,
        result_sha256: &successor_result,
    });
    let successor = fresh_successor_base(&successor_identity, successor_text)
        .expect("construct successor base");
    let cross_bound_state_vector = "0".repeat(64);
    assert_ne!(cross_bound_state_vector, predecessor_state_vector_sha256);
    let cross_bound_text = "descriptor belongs to another predecessor state\n";
    let cross_bound_result = dohc_engine_collab::hex_sha256(cross_bound_text.as_bytes());
    let cross_bound_identity = SuccessorIdentity::derive(SuccessorIdentityInput {
        key: &key,
        predecessor_claim_id: &predecessor_claim_id,
        predecessor_state_vector_sha256: &cross_bound_state_vector,
        artifact_op_kind: "moment.append",
        artifact_id: "moment-cross-bound-successor",
        artifact_preimage_sha256: &predecessor_preimage,
        content_kind: ContentKind::Plaintext,
        result_sha256: &cross_bound_result,
    });
    let cross_bound = fresh_successor_base(&cross_bound_identity, cross_bound_text)
        .expect("construct cross-bound successor");
    let before_cross_bound = lineage_storage_fingerprint(&store, &key);
    let cross_bound_error = replace_lineage_with_successor(
        &mut store,
        SuccessorReplacement {
            key: &key,
            expected_predecessor_claim_id: &predecessor_claim_id,
            expected_predecessor_state_vector_sha256: &predecessor_state_vector_sha256,
            path: "notes/a.txt",
            successor: &cross_bound,
            now_ms: 1_150,
        },
        &NoFaults,
    )
    .expect_err("the successor descriptor must bind the same predecessor vector as the CAS");
    assert!(
        matches!(
            &cross_bound_error,
            CollabError::InvalidSuccessorBase {
                constraint: "predecessor state vector matches the successor CAS",
                expected,
                observed,
            } if expected == &predecessor_state_vector_sha256
                && observed == &cross_bound_state_vector
        ),
        "unexpected cross-binding error: {cross_bound_error:?}"
    );
    assert_eq!(
        lineage_storage_fingerprint(&store, &key),
        before_cross_bound,
        "a cross-bound descriptor must not mutate any lineage row"
    );
    let installed = committed(
        replace_lineage_with_successor(
            &mut store,
            SuccessorReplacement {
                key: &key,
                expected_predecessor_claim_id: &predecessor_claim_id,
                expected_predecessor_state_vector_sha256: &predecessor_state_vector_sha256,
                path: "notes/a.txt",
                successor: &successor,
                now_ms: 1_200,
            },
            &NoFaults,
        )
        .expect("install successor"),
    );
    assert_eq!(
        installed,
        SuccessorInstallOutcome::Installed {
            predecessor_claim_id: predecessor_claim_id.clone(),
            successor_claim_id: successor.lineage_claim_id.clone(),
        }
    );
    let active = read_marker(&store, &key)
        .expect("read active marker")
        .expect("active marker");
    assert_eq!(
        active.lineage_claim_id.as_deref(),
        Some(successor.lineage_claim_id.as_str())
    );
    assert_eq!(
        active.lineage_parent_claim_id.as_deref(),
        Some(predecessor_claim_id.as_str())
    );
    assert_eq!(
        active.lineage_epoch_tag.as_deref(),
        Some(successor.epoch_tag.as_str())
    );
    assert_eq!(active.path.as_deref(), Some("notes/a.txt"));
    assert_eq!(count(&store, "ydoc_updates", &key), 0);
    assert_eq!(count(&store, "ydoc_snapshots", &key), 1);
    assert_eq!(count(&store, "ydoc_inactive_lineages", &key), 1);
    assert_eq!(
        load_persisted(&store, &key)
            .expect("load successor")
            .expect("successor marker")
            .doc
            .project(ContentKind::Plaintext)
            .expect("project successor")
            .markdown,
        successor_text
    );

    let successor_peer = Ydoc::wire();
    successor_peer
        .apply(&successor.update)
        .expect("load the installed successor base");
    let successor_delta =
        successor_peer.plaintext_insert(successor_text.chars().count() as u32, "after install\n");
    committed(
        apply_remote_update(
            &mut store,
            &key,
            &RemoteUpdate {
                origin_id: "peer-successor".to_owned(),
                origin_seq: 2,
                bytes: successor_delta,
            },
            &NoFaults,
            1_225,
        )
        .expect("append to the successor"),
    );
    let compacted = committed(
        close_session(&mut store, &key, false, &NoFaults, 1_250).expect("compact the successor"),
    );
    assert!(matches!(compacted, CloseOutcome::Compacted(_)));
    let snapshot_shape: (i64, i64, i64) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*), MIN(up_to_seq), MAX(up_to_seq) \
                 FROM ydoc_snapshots \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)
        })
        .expect("read compacted successor snapshots");
    assert_eq!(
        snapshot_shape,
        (2, 0, 1),
        "successor compaction retains its permanent seq-0 replay proof"
    );

    drop(store);
    let mut store = reopen(&scratch);
    struct ArchivedLineageRow {
        claim_id: String,
        parent_claim_id: Option<String>,
        disposition: String,
        content_kind: String,
        path: Option<String>,
        epoch_tag: Option<String>,
        full_state_blob_sha256: String,
        state_vector_blob_sha256: String,
    }
    let archived = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT lineage_claim_id, parent_claim_id, disposition, content_kind, path, \
                        epoch_tag, full_state_blob_sha256, state_vector_blob_sha256 \
                 FROM ydoc_inactive_lineages \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |row| {
                    Ok(ArchivedLineageRow {
                        claim_id: row.get(0)?,
                        parent_claim_id: row.get(1)?,
                        disposition: row.get(2)?,
                        content_kind: row.get(3)?,
                        path: row.get(4)?,
                        epoch_tag: row.get(5)?,
                        full_state_blob_sha256: row.get(6)?,
                        state_vector_blob_sha256: row.get(7)?,
                    })
                },
            )
            .map_err(|error| CollabError::Corrupt {
                reason: error.to_string(),
            })
        })
        .expect("read archived lineage after reopen");
    assert_eq!(archived.claim_id, predecessor_claim_id);
    assert_eq!(
        archived.parent_claim_id, None,
        "a root predecessor has no parent"
    );
    assert_eq!(archived.disposition, "superseded-predecessor");
    assert_eq!(archived.content_kind, "plaintext");
    assert_eq!(archived.path.as_deref(), Some("notes/a.txt"));
    assert_eq!(
        archived.epoch_tag, None,
        "a root predecessor has no epoch tag"
    );
    let archived_full_state = store
        .get_binary_blob(&archived.full_state_blob_sha256)
        .expect("read archived full state")
        .expect("archived full state blob");
    let archived_state_vector = store
        .get_binary_blob(&archived.state_vector_blob_sha256)
        .expect("read archived state vector")
        .expect("archived state vector blob");
    let archived_doc = Ydoc::wire();
    archived_doc
        .apply(&archived_full_state)
        .expect("replay archived full state");
    assert_eq!(
        archived_doc
            .project(ContentKind::Plaintext)
            .expect("project archived predecessor")
            .markdown,
        "hello world"
    );
    assert_eq!(archived_doc.encode_state_vector(), archived_state_vector);

    let successor_state_vector_sha256 = dohc_engine_collab::hex_sha256(&successor.state_vector);
    assert_ne!(archived.full_state_blob_sha256, successor.lineage_claim_id);
    committed(
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_snapshots SET snapshot_blob_sha256=?4 \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
                       AND up_to_seq=0",
                    rusqlite::params![
                        key.workspace_id,
                        key.version_id,
                        key.object_id,
                        archived.full_state_blob_sha256,
                    ],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .expect("corrupt replay base digest fixture"),
    );
    let before_wrong_base_replay = lineage_storage_fingerprint(&store, &key);
    let wrong_base_replay = replace_lineage_with_successor(
        &mut store,
        SuccessorReplacement {
            key: &key,
            expected_predecessor_claim_id: &predecessor_claim_id,
            expected_predecessor_state_vector_sha256: &predecessor_state_vector_sha256,
            path: "notes/a.txt",
            successor: &successor,
            now_ms: 1_275,
        },
        &NoFaults,
    )
    .expect_err("marker-only replay must not accept a different seq-0 base");
    assert!(matches!(wrong_base_replay, CollabError::Corrupt { .. }));
    assert_eq!(
        lineage_storage_fingerprint(&store, &key),
        before_wrong_base_replay,
        "replay validation must not rewrite the divergent snapshot"
    );
    committed(
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_snapshots SET snapshot_blob_sha256=?4 \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
                       AND up_to_seq=0",
                    rusqlite::params![
                        key.workspace_id,
                        key.version_id,
                        key.object_id,
                        successor.lineage_claim_id,
                    ],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .expect("restore replay base digest"),
    );
    assert_ne!(
        archived.state_vector_blob_sha256,
        successor_state_vector_sha256
    );
    committed(
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_snapshots SET state_vector_blob_sha256=?4 \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
                       AND up_to_seq=0",
                    rusqlite::params![
                        key.workspace_id,
                        key.version_id,
                        key.object_id,
                        archived.state_vector_blob_sha256,
                    ],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .expect("corrupt replay state-vector fixture"),
    );
    let before_wrong_vector_replay = lineage_storage_fingerprint(&store, &key);
    let wrong_vector_replay = replace_lineage_with_successor(
        &mut store,
        SuccessorReplacement {
            key: &key,
            expected_predecessor_claim_id: &predecessor_claim_id,
            expected_predecessor_state_vector_sha256: &predecessor_state_vector_sha256,
            path: "notes/a.txt",
            successor: &successor,
            now_ms: 1_280,
        },
        &NoFaults,
    )
    .expect_err("marker-only replay must not accept a different seq-0 state vector");
    assert!(matches!(wrong_vector_replay, CollabError::Corrupt { .. }));
    assert_eq!(
        lineage_storage_fingerprint(&store, &key),
        before_wrong_vector_replay,
        "replay validation must not rewrite the divergent state vector"
    );
    committed(
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE ydoc_snapshots SET state_vector_blob_sha256=?4 \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 \
                       AND up_to_seq=0",
                    rusqlite::params![
                        key.workspace_id,
                        key.version_id,
                        key.object_id,
                        successor_state_vector_sha256,
                    ],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .expect("restore replay state-vector digest"),
    );

    let before_replay = lineage_storage_fingerprint(&store, &key);
    let replay = committed(
        replace_lineage_with_successor(
            &mut store,
            SuccessorReplacement {
                key: &key,
                expected_predecessor_claim_id: &predecessor_claim_id,
                expected_predecessor_state_vector_sha256: &predecessor_state_vector_sha256,
                path: "notes/a.txt",
                successor: &successor,
                now_ms: 1_300,
            },
            &NoFaults,
        )
        .expect("replay successor"),
    );
    assert_eq!(
        replay,
        SuccessorInstallOutcome::Replayed {
            successor_claim_id: successor.lineage_claim_id.clone(),
        }
    );
    assert_eq!(lineage_storage_fingerprint(&store, &key), before_replay);

    let next_text = "must wait for the exact predecessor state\n";
    let wrong_state_vector = "0".repeat(64);
    let next_result = dohc_engine_collab::hex_sha256(next_text.as_bytes());
    let next_identity = SuccessorIdentity::derive(SuccessorIdentityInput {
        key: &key,
        predecessor_claim_id: &successor.lineage_claim_id,
        predecessor_state_vector_sha256: &wrong_state_vector,
        artifact_op_kind: "moment.append",
        artifact_id: "moment-wrong-state-vector",
        artifact_preimage_sha256: &successor.result_sha256,
        content_kind: ContentKind::Plaintext,
        result_sha256: &next_result,
    });
    let next = fresh_successor_base(&next_identity, next_text).expect("construct next base");
    let actual_state_vector = dohc_engine_collab::hex_sha256(
        &load_persisted(&store, &key)
            .expect("load current predecessor")
            .expect("current predecessor marker")
            .doc
            .encode_state_vector(),
    );
    assert_ne!(wrong_state_vector, actual_state_vector);
    let before_state_mismatch = lineage_storage_fingerprint(&store, &key);
    let state_mismatch = replace_lineage_with_successor(
        &mut store,
        SuccessorReplacement {
            key: &key,
            expected_predecessor_claim_id: &successor.lineage_claim_id,
            expected_predecessor_state_vector_sha256: &wrong_state_vector,
            path: "notes/a.txt",
            successor: &next,
            now_ms: 1_350,
        },
        &NoFaults,
    )
    .expect_err("a wrong predecessor state vector must not mutate storage");
    assert!(
        matches!(
            &state_mismatch,
            CollabError::LineageStateVectorMismatch { expected, observed }
                if expected == &wrong_state_vector && observed == &actual_state_vector
        ),
        "unexpected state-vector mismatch: {state_mismatch:?}"
    );
    assert_eq!(
        lineage_storage_fingerprint(&store, &key),
        before_state_mismatch
    );

    let wrong_predecessor = "f".repeat(64);
    let other_text = "must not land\n";
    let unmatched_preimage = dohc_engine_collab::hex_sha256(b"unmatched preimage");
    let other_result = dohc_engine_collab::hex_sha256(other_text.as_bytes());
    let other_identity = SuccessorIdentity::derive(SuccessorIdentityInput {
        key: &key,
        predecessor_claim_id: &wrong_predecessor,
        predecessor_state_vector_sha256: &predecessor_state_vector_sha256,
        artifact_op_kind: "moment.append",
        artifact_id: "moment-wrong-predecessor",
        artifact_preimage_sha256: &unmatched_preimage,
        content_kind: ContentKind::Plaintext,
        result_sha256: &other_result,
    });
    let other = fresh_successor_base(&other_identity, other_text).expect("construct other base");
    let before_mismatch = lineage_storage_fingerprint(&store, &key);
    let mismatch = replace_lineage_with_successor(
        &mut store,
        SuccessorReplacement {
            key: &key,
            expected_predecessor_claim_id: &wrong_predecessor,
            expected_predecessor_state_vector_sha256: &predecessor_state_vector_sha256,
            path: "notes/a.txt",
            successor: &other,
            now_ms: 1_400,
        },
        &NoFaults,
    )
    .expect_err("a wrong predecessor claim must not mutate storage");
    assert!(
        matches!(
            &mismatch,
            CollabError::LineagePredecessorMismatch {
                expected,
                observed: Some(observed),
            } if expected == &wrong_predecessor && observed == &successor.lineage_claim_id
        ),
        "unexpected predecessor mismatch: {mismatch:?}"
    );
    assert_eq!(lineage_storage_fingerprint(&store, &key), before_mismatch);
}

// ---- replication: idempotent + echo-suppressed ------------------------------

#[test]
fn remote_update_is_idempotent_and_echo_suppressed() {
    let mut ts = fresh_store("repl-apply");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    let (base, delta) = plaintext_base_and_delta();
    committed(
        claim_base(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &base,
            &NoFaults,
            1_000,
        )
        .expect("base"),
    );

    let remote = RemoteUpdate {
        origin_id: "peer-A".to_string(),
        origin_seq: 1,
        bytes: delta.clone(),
    };
    // First apply: journaled, echo-suppressed (never re-emitted).
    let first = committed(
        apply_remote_update(&mut ts.store, &key, &remote, &NoFaults, 1_100).expect("apply"),
    );
    let seq = match first {
        ReplicationApplyOutcome::Applied { seq, emit_outbound } => {
            assert!(!emit_outbound, "a remote update must NOT be echoed");
            seq
        }
        ReplicationApplyOutcome::Deduped { .. } => panic!("first apply must land"),
    };
    // Redelivery of the same bytes is an idempotent no-op (content-addressed).
    let again = committed(
        apply_remote_update(&mut ts.store, &key, &remote, &NoFaults, 1_200).expect("apply2"),
    );
    assert_eq!(
        again,
        ReplicationApplyOutcome::Deduped { seq },
        "redelivery deduped"
    );
    assert_eq!(
        count(&ts.store, "ydoc_updates", &key),
        1,
        "no duplicate row"
    );

    // The remote edit is durable in the lineage (a resume sees it).
    let persisted = load_persisted(&ts.store, &key).expect("load").expect("m");
    assert!(persisted.doc.plaintext_string().contains("world"));

    // The row carries the peer origin (provenance).
    let origin: Option<String> = ts
        .store
        .read_with(|c| -> Result<Option<String>, CollabError> {
            c.query_row(
                "SELECT actor_origin_id FROM ydoc_updates \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND seq=?4",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id, seq],
                |r| r.get(0),
            )
            .map_err(|e| CollabError::Corrupt {
                reason: e.to_string(),
            })
        })
        .expect("origin");
    assert_eq!(origin.as_deref(), Some("peer-A"));
}

#[test]
fn local_edit_on_replicated_lineage_requests_broadcast() {
    let mut ts = fresh_store("repl-local");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    let (base, delta) = plaintext_base_and_delta();
    committed(
        claim_base(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            &base,
            &NoFaults,
            1_000,
        )
        .expect("base"),
    );
    let out =
        committed(record_local_update(&mut ts.store, &key, &delta, &NoFaults, 1_100).expect("rec"));
    assert!(
        out.emit_outbound,
        "a new local edit on a replicated lineage broadcasts"
    );
    assert!(!out.deduped);
}

#[test]
fn replicated_edit_before_base_is_not_broadcast() {
    // A replicated marker whose base is NOT yet claimed must NOT broadcast local
    // edits: a delta without the seed base leaves peers unable to reconstruct.
    let mut ts = fresh_store("repl-no-base");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::Replicated,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    let doc = Ydoc::wire();
    let d = doc.plaintext_insert(0, "premature");
    let out =
        committed(record_local_update(&mut ts.store, &key, &d, &NoFaults, 1_100).expect("rec"));
    assert!(
        !out.emit_outbound,
        "no broadcast before the base is claimed"
    );
}

#[test]
fn resettle_of_edited_doc_expects_prior_content_preimage() {
    // The materializer must replace (not conflict-flag) an edited doc: the first
    // settle expects the target ABSENT; a later settle of changed content expects
    // the PREVIOUS settle's content still on disk.
    use dohc_engine_storage::Preimage;
    let mut ts = fresh_store("resettle");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    let doc = Ydoc::wire();
    let d1 = doc.plaintext_insert(0, "first");
    committed(record_local_update(&mut ts.store, &key, &d1, &NoFaults, 1_000).expect("rec1"));
    let s1 = committed(settle(&mut ts.store, &key, "n.md", &NoFaults, 5_000).expect("settle1"));
    let j1 = ts
        .store
        .load_materialization_job(&s1.job_id)
        .expect("load1")
        .expect("job1");
    assert_eq!(
        j1.preimage,
        Preimage::Absent,
        "first settle expects absent target"
    );

    // Edit and re-settle: the new job must expect the FIRST content as preimage.
    let d2 = doc.plaintext_insert(5, " second");
    committed(record_local_update(&mut ts.store, &key, &d2, &NoFaults, 6_000).expect("rec2"));
    let s2 = committed(settle(&mut ts.store, &key, "n.md", &NoFaults, 7_000).expect("settle2"));
    assert!(!s2.deduped, "changed content is a new job");
    let j2 = ts
        .store
        .load_materialization_job(&s2.job_id)
        .expect("load2")
        .expect("job2");
    assert_eq!(
        j2.preimage,
        Preimage::Present(s1.content_sha256),
        "re-settle expects the previous content on disk"
    );
}

// ---- constraint 5: never journal invalid bytes ------------------------------

#[test]
fn truncated_update_is_rejected_and_never_journaled() {
    let mut ts = fresh_store("truncate");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("m"),
    );

    let doc = Ydoc::wire();
    let good = doc.plaintext_insert(0, "hello world this is a genuine update");
    // Every non-empty prefix cut of a genuine update: none may be journaled.
    let mut rejected = 0;
    for cut in 1..good.len() {
        let truncated = &good[..cut];
        match record_local_update(&mut ts.store, &key, truncated, &NoFaults, 1_000) {
            Err(_) => rejected += 1,
            Ok(TxnOutcome::Committed(app)) => {
                // If yrs happened to accept a prefix as a valid (different)
                // update, it is at least never a torn/partial journal — the log
                // count must equal the number of accepted appends. Extremely
                // unlikely for a truncation, but not asserted-impossible.
                let _ = app;
            }
            Ok(TxnOutcome::Crashed { .. }) => panic!("no fault armed"),
        }
    }
    assert!(rejected > 0, "truncated prefixes must be rejected");
    // The empty update is rejected too.
    assert!(matches!(
        record_local_update(&mut ts.store, &key, &[], &NoFaults, 1_000),
        Err(CollabError::EmptyUpdate)
    ));
    // The genuine update still lands cleanly afterward (rejection left no torn
    // state).
    committed(record_local_update(&mut ts.store, &key, &good, &NoFaults, 1_000).expect("good"));
    let persisted = load_persisted(&ts.store, &key).expect("load").expect("m");
    assert_eq!(
        persisted.doc.plaintext_string(),
        "hello world this is a genuine update"
    );
}

/// YRS-ABORT-SAFETY regression: the deterministic 41-byte witness for yrs
/// 0.27.3's uncatchable `char`-decode UB hard-abort
/// (`known_crash_witness_yrs_char_decode_ub`,
/// `fuzz/dohc-fuzz-targets/tests/ydoc_update.rs`) is rejected fail-closed
/// through BOTH real ingestion choke points this crate exposes to untrusted
/// input: the local edit path (`record_local_update`) and the remote
/// replication path (`apply_remote_update`). Before the fix, either call
/// would abort the WHOLE PROCESS (not just fail this test) — this test
/// merely completing and asserting `Err` is itself part of the proof the
/// abort is closed.
#[test]
fn yrs_abort_witness_is_rejected_fail_closed_on_both_ingestion_paths() {
    const WITNESS: [u8; 41] = [
        0x0a, 0x06, 0x08, 0x94, 0x4b, 0x44, 0xa1, 0x2f, 0x63, 0x19, 0x03, 0x5f, 0xcb, 0xa3, 0xfc,
        0xb8, 0x5e, 0x48, 0xdd, 0xd4, 0xb4, 0xe5, 0x09, 0x27, 0x56, 0x51, 0xd9, 0xa8, 0xeb, 0x9f,
        0xf6, 0xfc, 0xae, 0x1d, 0xbd, 0x17, 0xee, 0x48, 0x42, 0xb4, 0x02,
    ];

    // Local edit path: `record_local_update_creating_marker` /
    // `record_local_update` -> `validate_update_bytes` -> the pre-validator.
    let mut local = fresh_store("yrs-abort-witness-local");
    let local_key = test_key();
    seed_parents(&mut local.store, &local_key, 1_000);
    committed(
        ensure_marker(
            &mut local.store,
            &local_key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    let local_result =
        record_local_update(&mut local.store, &local_key, &WITNESS, &NoFaults, 1_000);
    assert!(
        local_result.is_err(),
        "the witness must be rejected fail-closed on the local edit path, not journaled: {local_result:?}"
    );
    assert_eq!(
        count(&local.store, "ydoc_updates", &local_key),
        0,
        "a rejected update must never be journaled"
    );

    // Remote replication path: `apply_remote_update` ->
    // `apply_remote_update_in_transaction` -> `validate_update_bytes` -> the
    // same pre-validator.
    let mut remote = fresh_store("yrs-abort-witness-remote");
    let remote_key = test_key();
    seed_parents(&mut remote.store, &remote_key, 1_000);
    committed(
        ensure_marker(
            &mut remote.store,
            &remote_key,
            ContentKind::Plaintext,
            Regime::Replicated,
            &NoFaults,
            1_000,
        )
        .expect("marker"),
    );
    let remote_update = RemoteUpdate {
        origin_id: "peer-hostile".to_owned(),
        origin_seq: 0,
        bytes: WITNESS.to_vec(),
    };
    let remote_result = apply_remote_update(
        &mut remote.store,
        &remote_key,
        &remote_update,
        &NoFaults,
        1_000,
    );
    assert!(
        remote_result.is_err(),
        "the witness must be rejected fail-closed on the remote replication path, not journaled: {remote_result:?}"
    );
    assert_eq!(
        count(&remote.store, "ydoc_updates", &remote_key),
        0,
        "a rejected remote update must never be journaled"
    );
}

// ---- leases -----------------------------------------------------------------

#[test]
fn a_lease_is_exclusive_and_releases_on_drop() {
    let registry = LeaseRegistry::new();
    let key = test_key();
    let other = DocKey::new("ws-1", "ver-1", "obj-2").expect("k2");

    let lease = registry.acquire(&key).expect("first lease");
    assert!(registry.is_held(&key));
    // A second open of the SAME lineage is refused.
    assert!(matches!(
        registry.acquire(&key),
        Err(CollabError::LeaseHeld)
    ));
    // A different lineage is independent.
    let _l2 = registry.acquire(&other).expect("other lease");

    // Dropping releases deterministically; the lineage can be reopened.
    drop(lease);
    assert!(!registry.is_held(&key));
    let _released = registry.acquire(&key).expect("reacquire after drop");
}

#[test]
fn leases_are_process_local_per_registry() {
    // Exclusivity is PROCESS-LOCAL, per-registry (mirrors the TS module-global
    // reservation set): two independent registries can each grant a lease for the
    // same key. Cross-process/registry exclusion is the store connection's job,
    // not this type's — this test encodes that boundary so it is not mistaken for
    // a global lock.
    let key = test_key();
    let reg_a = LeaseRegistry::new();
    let reg_b = LeaseRegistry::new();
    let _a = reg_a.acquire(&key).expect("registry A grants");
    let _b = reg_b
        .acquire(&key)
        .expect("registry B also grants (independent)");
    // Within a single registry it is still exclusive.
    assert!(matches!(reg_a.acquire(&key), Err(CollabError::LeaseHeld)));
}

// ---- settle -----------------------------------------------------------------

#[test]
fn settle_projects_and_enqueues_an_idempotent_job() {
    let mut ts = fresh_store("settle");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Plaintext,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("m"),
    );
    let doc = Ydoc::wire();
    let d = doc.plaintext_insert(0, "the settled markdown body");
    committed(record_local_update(&mut ts.store, &key, &d, &NoFaults, 1_000).expect("rec"));

    let first =
        committed(settle(&mut ts.store, &key, "notes/doc.md", &NoFaults, 5_000).expect("settle"));
    assert!(!first.deduped);
    assert_eq!(first.projection.markdown, "the settled markdown body");
    assert_eq!(
        first.projection.source_state_vector_sha256.len(),
        64,
        "provenance sv recorded"
    );
    assert_eq!(ts.store.pending_materialization_count().expect("jobs"), 1);

    // A re-driven settle with the same content+generation is exactly-once.
    let again =
        committed(settle(&mut ts.store, &key, "notes/doc.md", &NoFaults, 5_000).expect("settle2"));
    assert!(again.deduped, "same content+generation dedups");
    assert_eq!(again.job_id, first.job_id);
    assert_eq!(
        ts.store.pending_materialization_count().expect("jobs"),
        1,
        "no duplicate job"
    );
}

// ---- crash recovery / exactly-once (needs the shared storage fault seam) -----

#[cfg(feature = "fault-injection")]
mod crash {
    use super::*;
    use dohc_engine_storage::FaultPoint;

    #[test]
    fn append_crash_after_commit_before_ack_is_exactly_once() {
        let dir = unique_dir("crash-append");
        let key = test_key();
        {
            let mut store = open_at(&dir, 1_000);
            seed_parents(&mut store, &key, 1_000);
            committed(
                ensure_marker(
                    &mut store,
                    &key,
                    ContentKind::Plaintext,
                    Regime::LocalOnly,
                    &NoFaults,
                    1_000,
                )
                .expect("m"),
            );
            let doc = Ydoc::wire();
            let update = doc.plaintext_insert(0, "committed-but-unacked");
            // Kill after the durable commit but before the ack.
            let faults = OneShotCrash::at(FaultPoint::StorageAfterCommitBeforeAck);
            let out = record_local_update(&mut store, &key, &update, &faults, 1_000).expect("rec");
            assert_eq!(out, TxnOutcome::Crashed { committed: true });
            // Reopen (dropping `store` closes the connection; the file stays).
            drop(store);
            let mut store = reopen(&dir);
            assert_eq!(
                count(&store, "ydoc_updates", &key),
                1,
                "append durable after reopen"
            );
            // The retry is exactly-once (content-addressed dedup), never a dup.
            let retry =
                record_local_update(&mut store, &key, &update, &NoFaults, 1_000).expect("retry");
            assert!(
                matches!(retry, TxnOutcome::Committed(a) if a.deduped),
                "retry deduped"
            );
            assert_eq!(
                count(&store, "ydoc_updates", &key),
                1,
                "no duplicate append"
            );
        }
    }

    #[test]
    fn append_crash_before_persist_leaves_no_torn_state() {
        let dir = unique_dir("crash-rollback");
        let key = test_key();
        {
            let mut store = open_at(&dir, 1_000);
            seed_parents(&mut store, &key, 1_000);
            committed(
                ensure_marker(
                    &mut store,
                    &key,
                    ContentKind::Plaintext,
                    Regime::LocalOnly,
                    &NoFaults,
                    1_000,
                )
                .expect("m"),
            );
            let doc = Ydoc::wire();
            let update = doc.plaintext_insert(0, "rolled-back");
            let faults = OneShotCrash::at(FaultPoint::StorageBeforePersist);
            let out = record_local_update(&mut store, &key, &update, &faults, 1_000).expect("rec");
            assert_eq!(out, TxnOutcome::Crashed { committed: false });
            drop(store);
            let mut store = reopen(&dir);
            assert_eq!(count(&store, "ydoc_updates", &key), 0, "nothing journaled");
            let retry =
                record_local_update(&mut store, &key, &update, &NoFaults, 1_000).expect("retry");
            assert!(matches!(retry, TxnOutcome::Committed(a) if !a.deduped));
            assert_eq!(count(&store, "ydoc_updates", &key), 1);
        }
    }

    #[test]
    fn settle_crash_after_commit_before_ack_is_exactly_once() {
        let dir = unique_dir("crash-settle");
        let key = test_key();
        {
            let mut store = open_at(&dir, 1_000);
            seed_parents(&mut store, &key, 1_000);
            committed(
                ensure_marker(
                    &mut store,
                    &key,
                    ContentKind::Plaintext,
                    Regime::LocalOnly,
                    &NoFaults,
                    1_000,
                )
                .expect("m"),
            );
            let doc = Ydoc::wire();
            let d = doc.plaintext_insert(0, "settle-once");
            committed(record_local_update(&mut store, &key, &d, &NoFaults, 1_000).expect("rec"));
            let faults = OneShotCrash::at(FaultPoint::StorageAfterCommitBeforeAck);
            let out = settle(&mut store, &key, "n.md", &faults, 5_000).expect("settle");
            assert_eq!(out, TxnOutcome::Crashed { committed: true });
            drop(store);
            let mut store = reopen(&dir);
            assert_eq!(
                store.pending_materialization_count().expect("jobs"),
                1,
                "job durable"
            );
            // Retry with a DIFFERENT wall clock: the generation is a durable
            // per-doc counter, not now_ms, so this still dedups exactly-once.
            let retry =
                committed(settle(&mut store, &key, "n.md", &NoFaults, 999_999).expect("retry"));
            assert!(retry.deduped, "retry deduped despite advanced clock");
            assert_eq!(
                store.pending_materialization_count().expect("jobs"),
                1,
                "no duplicate job"
            );
        }
    }
}
