//! The durable-layer invariants: two regimes (local-only prune vs replicated
//! never-prune), base-once, replication idempotency + echo suppression, leases,
//! and the yjs-non-atomic boundary (never journal invalid bytes). Crash-recovery
//! / exactly-once tests live behind the `fault-injection` feature.

mod common;

use common::*;
use dohc_engine_collab::ContentKind;
use dohc_engine_collab::{
    apply_remote_update, claim_base, close_session, ensure_marker, load_persisted, read_marker,
    record_local_update, settle, ClaimOutcome, CloseOutcome, CollabError, DocKey, LeaseRegistry,
    Regime, RemoteUpdate, ReplicationApplyOutcome, SettleOutcome, Ydoc,
};
use dohc_engine_storage::{EngineStore, NoFaults, TxnOutcome};

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
    let (base, _) = plaintext_base_and_delta();

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
    };
    assert!(
        read_marker(&ts.store, &key)
            .expect("m")
            .expect("marker")
            .base_claimed
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
        1,
        "still exactly one base"
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

fn assert_unknown_content_kind(error: CollabError) {
    assert_eq!(error.code(), "unsupported-content-kind");
    assert_eq!(
        error.to_string(),
        "unsupported durable Y.Doc content kind `scene`; supported kinds are `plaintext` and `richdoc`"
    );
}

#[test]
fn unknown_marker_content_kind_cannot_project_append_or_settle_as_richdoc() {
    let mut ts = fresh_store("unknown-marker-kind");
    let key = test_key();
    seed_parents(&mut ts.store, &key, 1_000);
    committed(
        ensure_marker(
            &mut ts.store,
            &key,
            ContentKind::Richdoc,
            Regime::LocalOnly,
            &NoFaults,
            1_000,
        )
        .expect("richdoc marker"),
    );
    let doc = Ydoc::wire();
    let first_update = doc.richdoc_append_paragraph("existing drawing-shaped state");
    committed(
        record_local_update(&mut ts.store, &key, &first_update, &NoFaults, 1_100)
            .expect("richdoc update"),
    );
    let rejected_update = doc.richdoc_append_paragraph("must not land");

    committed(
        ts.store
            .write_with(&NoFaults, |tx| {
                tx.execute_batch("PRAGMA ignore_check_constraints = ON")
                    .map_err(dohc_engine_storage::StorageError::persist_public)?;
                tx.execute(
                    "UPDATE ydoc_docs SET content_kind = 'scene' \
                     WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                tx.execute_batch("PRAGMA ignore_check_constraints = OFF")
                    .map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .expect("replace marker content kind"),
    );

    assert_unknown_content_kind(read_marker(&ts.store, &key).expect_err("marker must refuse"));
    assert_unknown_content_kind(
        load_persisted(&ts.store, &key).expect_err("projection source must refuse"),
    );
    assert_unknown_content_kind(
        record_local_update(&mut ts.store, &key, &rejected_update, &NoFaults, 1_200)
            .expect_err("append must refuse"),
    );
    assert_unknown_content_kind(
        settle(
            &mut ts.store,
            &key,
            "notes/drawing.excalidraw",
            &NoFaults,
            1_300,
        )
        .expect_err("settle must refuse"),
    );

    assert_eq!(
        count(&ts.store, "ydoc_updates", &key),
        1,
        "the rejected append must not mutate the lineage"
    );
    assert_eq!(
        ts.store.pending_materialization_count().expect("jobs"),
        0,
        "the rejected settle must not enqueue artifact materialization"
    );
    let (settle_seq, last_settled_sha): (i64, Option<String>) = ts
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT settle_seq, last_settled_sha FROM ydoc_docs \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("settle marker state");
    assert_eq!(settle_seq, 0);
    assert_eq!(last_settled_sha, None);
}

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
