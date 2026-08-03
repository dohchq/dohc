//! The base-divergence conflict is LOAD-BEARING (#546 review round 2).
//!
//! Opening the conflict is not enough. Two paths could still cancel the
//! user's review: a routine open+settle of the document would materialize
//! the sender's projection over the preserved head, and a resolution that
//! kept the current text never reached the durable Y.Doc, so the next
//! inbound delta silently reversed it. The invariant under test:
//!
//! - an OPEN sync conflict on a Y.Doc object freezes the settle
//!   (`ydoc-conflict-open`), and
//! - RESOLUTION folds the chosen text into the lineage in the same
//!   transaction that closes the row, so later deltas merge with the choice.

use dohc_engine_collab::{ContentKind, DocKey};
use dohc_engine_domain::{ResolveConflictKind, ResolveTextConflict, VersionedTextStore, WriteText};
use dohc_engine_runtime::{
    CancellationToken, NoFaults, RuntimeError, SelfWriteRecorder, WorkspaceSupervisor,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_sync::{NoLiveLeases, ReplicationEnvelope, apply_ydoc_envelope};
use dohc_engine_testkit::ScratchDir;
use std::sync::Arc;

struct NoRecorder;

impl SelfWriteRecorder for NoRecorder {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

const WS: &str = "ws-base-conflict";
const PATH: &str = "notes/plan.md";

/// Seed a local plain-file head, then apply a peer's divergent base so the
/// #546 conflict opens. Returns (doc key, winner base bytes, winner doc).
fn seed_divergent_base(
    store: &mut EngineStore,
) -> (DocKey, Vec<u8>, dohc_engine_collab::Ydoc, String) {
    let mut versions = VersionedTextStore::new(&mut *store);
    versions
        .ensure_main_version(WS, "main", 1, &NoFaults)
        .expect("main version");
    versions
        .write_text(
            &WriteText {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                object_id: "object-plan".to_owned(),
                path: PATH.to_owned(),
                text: "local truth".to_owned(),
                moment_id: "m-local-1".to_owned(),
                metadata_origin: "local-file".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("seed local head");
    let key = DocKey::new(WS, "main", "object-plan").expect("key");
    let winner_doc = dohc_engine_collab::Ydoc::wire();
    winner_doc.plaintext_insert(0, "remote truth");
    let winner_base = winner_doc.encode_full_state();
    let winner_sha = store.put_binary_blob(&winner_base).expect("winner blob");
    let base_op = ReplicationEnvelope {
        workspace_id: WS.to_owned(),
        origin_id: "winner-origin".to_owned(),
        origin_seq: 0,
        op_kind: "ydoc.update".to_owned(),
        payload: serde_json::json!({
            "versionId": "main",
            "objectId": "object-plan",
            "path": PATH,
            "contentKind": "plaintext",
            "updateBlobSha256": winner_sha,
            "isBaseState": true
        }),
        recorded_at_ms: 3,
    };
    apply_ydoc_envelope(store, &base_op, &NoFaults, &NoLiveLeases).expect("base applies");
    let conflict_id: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT conflict_id FROM conflicts WHERE workspace_id=?1 AND status='open'",
                [WS],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("the divergent base opens a conflict");
    (key, winner_base, winner_doc, conflict_id)
}

fn head_text(db: &std::path::Path) -> String {
    let store = EngineStore::open(db, 9_000).expect("open");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256 = s.blob_sha256 \
                 WHERE s.workspace_id=?1 AND s.version_id='main' AND s.object_id='object-plan'",
                [WS],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("head")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_open_base_conflict_freezes_the_settle() {
    // MUTATION: drop the open-conflict check in `ydoc_settle_on_store` — the
    // settle succeeds and the head assertion below fails with the sender's
    // projection.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let (key, _winner_base, _winner_doc, _conflict_id) = {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        seed_divergent_base(&mut store)
    };
    std::fs::create_dir_all(scratch.path().join("notes")).expect("notes dir");
    std::fs::write(scratch.path().join(PATH), "local truth").expect("seed disk");

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 5).expect("open actor").actor;
    let refused = handle
        .ydoc_settle(
            scratch.path().to_path_buf(),
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            None,
            "freeze-session".to_owned(),
            Arc::new(NoRecorder),
            6,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect_err("an open base conflict must freeze the settle");
    assert!(
        matches!(
            refused,
            RuntimeError::Domain(dohc_engine_domain::DomainError::InvalidInput {
                reason: "ydoc-conflict-open"
            })
        ),
        "unexpected settle outcome: {refused:?}"
    );
    supervisor.close(&db).expect("close actor");
    assert_eq!(head_text(&db), "local truth", "the head stays under review");
    let store = EngineStore::open(&db, 7).expect("inspect");
    let open_conflicts: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM conflicts WHERE workspace_id=?1 AND status='open'",
                [WS],
                |row| row.get(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("count");
    assert_eq!(open_conflicts, 1, "the conflict is still awaiting review");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resolving_keep_current_folds_the_choice_into_the_lineage() {
    // MUTATION: drop the fold call in `conflict_resolve_on_store`'s hook —
    // the delta below projects the sender-only lineage and the "local truth"
    // assertions fail.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let (key, winner_base, winner_doc, conflict_id) = {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        let seeded = seed_divergent_base(&mut store);
        // The workspace replicates (identity + a relay position), so the
        // fold must journal its delta for the peer.
        dohc_engine_sync::journal_local_replication_op(
            &mut store,
            WS,
            "local",
            "epoch-1",
            "stream-1",
            "probe.local",
            &serde_json::json!({}),
            4,
            &NoFaults,
        )
        .expect("sync identity");
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO sync_relay_cursors \
                     (workspace_id, cursor, replication_epoch, stream_identity) \
                     VALUES (?1,'0','epoch-1','stream-1')",
                    [WS],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .expect("relay position");
        seeded
    };

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 10).expect("open actor").actor;
    let resolved = handle
        .conflict_resolve(
            ResolveTextConflict {
                workspace_id: WS.to_owned(),
                conflict_id,
                resolution: ResolveConflictKind::KeepCurrent,
                object_id: "resolution-fresh-object".to_owned(),
                write_moment_id: "m-resolve-write".to_owned(),
                delete_moment_id: "m-resolve-delete".to_owned(),
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 11,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("keep-current resolves");
    assert!(resolved.write.is_none(), "keep-current writes no new head");
    supervisor.close(&db).expect("close actor");

    // The choice is durable in the lineage, and journaled for the peer.
    let store = EngineStore::open(&db, 12).expect("inspect");
    let persisted = dohc_engine_collab::load_persisted(&store, &key)
        .expect("load")
        .expect("lineage");
    let folded = persisted
        .doc
        .project(ContentKind::Plaintext)
        .expect("projection");
    assert_eq!(
        folded.markdown, "local truth",
        "resolution must rewrite the lineage to the chosen text"
    );
    let fold_deltas: Vec<String> = store
        .read_with(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT payload_json FROM replication_log \
                     WHERE workspace_id=?1 AND op_kind='ydoc.update' AND imported=0",
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
            let rows = stmt
                .query_map([WS], |row| row.get::<_, String>(0))
                .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("journal");
    assert_eq!(fold_deltas.len(), 1, "the fold journals exactly one delta");
    let fold_payload: serde_json::Value =
        serde_json::from_str(&fold_deltas[0]).expect("fold payload");
    assert_eq!(fold_payload["isBaseState"], serde_json::json!(false));
    let fold_sha = fold_payload["updateBlobSha256"]
        .as_str()
        .expect("fold sha")
        .to_owned();

    // A later inbound delta MERGES with the choice instead of reversing it.
    drop(store);
    let mut store = EngineStore::open(&db, 13).expect("reopen");
    let delta = winner_doc.plaintext_insert(0, "more ");
    let delta_sha = store.put_binary_blob(&delta).expect("delta blob");
    let delta_op = ReplicationEnvelope {
        workspace_id: WS.to_owned(),
        origin_id: "winner-origin".to_owned(),
        origin_seq: 1,
        op_kind: "ydoc.update".to_owned(),
        payload: serde_json::json!({
            "versionId": "main",
            "objectId": "object-plan",
            "path": PATH,
            "contentKind": "plaintext",
            "updateBlobSha256": delta_sha,
            "isBaseState": false
        }),
        recorded_at_ms: 14,
    };
    apply_ydoc_envelope(&mut store, &delta_op, &NoFaults, &NoLiveLeases).expect("delta applies");
    let head = head_text(&db);
    assert!(
        head.contains("local truth"),
        "the resolved choice survives the next delta, got {head:?}"
    );

    // A clean peer converges to the same content from the winner's base plus
    // the journaled fold delta plus the later delta.
    let fold_bytes = EngineStore::open(&db, 15)
        .expect("open")
        .read_with(|conn| {
            conn.query_row(
                "SELECT bytes FROM binary_blobs WHERE sha256=?1",
                [&fold_sha],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .map_err(dohc_engine_storage::StorageError::corrupt_public)
        })
        .expect("fold blob");
    let peer = dohc_engine_collab::Ydoc::wire();
    peer.apply(&winner_base).expect("peer base");
    peer.apply(&fold_bytes).expect("peer fold");
    peer.apply(&delta).expect("peer delta");
    assert_eq!(
        peer.plaintext_string(),
        head,
        "the peer reads the same resolved content"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pending_resolution_job_replays_before_the_next_settle() {
    // Codex #596 P1: a resolution write enqueues `resolve-mat_<moment>`, and
    // the fold marks the choice settled in the same transaction. If that job
    // has not landed yet, the next settle's pending-job recovery must replay
    // it — probing only `ydoc-mat_<moment>` leaves the disk pre-resolution
    // while every marker reports the choice as settled. MUTATION: revert the
    // recovery probe to the single ydoc-mat prefix — the disk assertion
    // fails with the pre-resolution bytes.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let (key, _winner_base, _winner_doc, conflict_id) = {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        seed_divergent_base(&mut store)
    };
    std::fs::create_dir_all(scratch.path().join("notes")).expect("notes dir");
    std::fs::write(scratch.path().join(PATH), "local truth").expect("seed disk");

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 10).expect("open actor").actor;
    handle
        .conflict_resolve(
            ResolveTextConflict {
                workspace_id: WS.to_owned(),
                conflict_id,
                resolution: ResolveConflictKind::ApplyMerged {
                    text: "merged truth".to_owned(),
                },
                object_id: "resolution-fresh-object".to_owned(),
                write_moment_id: "m-resolve-merged".to_owned(),
                delete_moment_id: "m-resolve-delete".to_owned(),
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 11,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("merged resolution");
    // The resolution's materialization job is still pending (nothing ran
    // it): the disk holds the pre-resolution bytes.
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(PATH)).expect("disk"),
        "local truth"
    );

    handle
        .ydoc_settle(
            scratch.path().to_path_buf(),
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            None,
            "replay-session".to_owned(),
            Arc::new(NoRecorder),
            12,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("settle replays the pending resolution job");
    supervisor.close(&db).expect("close actor");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(PATH)).expect("disk after settle"),
        "merged truth",
        "the resolution's materialization replays before the settle answers"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_open_base_conflict_freezes_the_open_too() {
    // Codex #596 round 4: refusing only the settle left the OPEN serving the
    // claimed sender lineage - the editor displayed and accepted edits
    // against the unreviewed side while the head froze. The gate covers
    // open and settle symmetrically. MUTATION: drop the open-conflict check
    // in `ydoc_open_state_on_store` - the open succeeds and this fails.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        seed_divergent_base(&mut store);
    }
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 5).expect("open actor").actor;
    let refused = handle
        .ydoc_open_state(
            WS.to_owned(),
            6,
            true,
            None,
            "main".to_owned(),
            PATH.to_owned(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect_err("an open base conflict must freeze the open");
    assert!(
        matches!(
            refused,
            dohc_engine_runtime::RuntimeError::Domain(
                dohc_engine_domain::DomainError::InvalidInput {
                    reason: "ydoc-conflict-open"
                }
            )
        ),
        "unexpected open outcome: {refused:?}"
    );
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_oversized_resolution_fold_reports_its_measurements() {
    // Codex #596 round 4: the catch-all wrapped the fold's BlobTooLarge as
    // state-corrupt, discarding the numbers. The refusal now carries the
    // constraint, the limit, and the observed usage end to end. MUTATION:
    // route BlobTooLarge back through the corrupt catch-all in
    // `map_fold_error` - the PayloadTooLarge match fails.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let (_key, _winner_base, _winner_doc, conflict_id) = {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        seed_divergent_base(&mut store)
    };
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 10).expect("open actor").actor;
    let oversized = "x".repeat(dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES + 1);
    let refused = handle
        .conflict_resolve(
            ResolveTextConflict {
                workspace_id: WS.to_owned(),
                conflict_id,
                resolution: ResolveConflictKind::ApplyMerged { text: oversized },
                object_id: "resolution-fresh-object".to_owned(),
                write_moment_id: "m-resolve-oversized".to_owned(),
                delete_moment_id: "m-resolve-delete".to_owned(),
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 11,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect_err("an unfoldable choice must refuse with its measurements");
    match refused {
        dohc_engine_runtime::RuntimeError::Domain(
            dohc_engine_domain::DomainError::PayloadTooLarge {
                constraint,
                limit_bytes,
                observed_bytes,
            },
        ) => {
            assert!(constraint.contains("MAX_YDOC_UPDATE_BYTES"));
            assert_eq!(
                limit_bytes,
                dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES
            );
            assert!(observed_bytes > limit_bytes);
        }
        other => panic!("the measurements must survive the mapping: {other:?}"),
    }
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resolution_fold_self_bounds_the_update_log() {
    // Codex #596 round 4: folds append full-document rewrites but never
    // compacted, so repeated conflicts grow ydoc_updates without bound. The
    // resolve now runs the append path's best-effort compaction. MUTATION:
    // drop the post-resolve `maybe_compact` call - the pending-update count
    // stays above the threshold and this fails.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let (_key, winner_doc, conflict_id) = {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        let (key, _winner_base, winner_doc, conflict_id) = seed_divergent_base(&mut store);
        // One short of DEFAULT_COMPACTION_THRESHOLD, so the applies' own
        // self-bounding stays quiet and the FOLD's append is the row that
        // crosses the line.
        for seq in 0..i64::from(dohc_engine_collab::limits::DEFAULT_COMPACTION_THRESHOLD) - 1 {
            let delta = winner_doc.plaintext_insert(0, "x");
            let delta_sha = store.put_binary_blob(&delta).expect("delta blob");
            let op = ReplicationEnvelope {
                workspace_id: WS.to_owned(),
                origin_id: "winner-origin".to_owned(),
                origin_seq: seq + 1,
                op_kind: "ydoc.update".to_owned(),
                payload: serde_json::json!({
                    "versionId": "main",
                    "objectId": "object-plan",
                    "path": PATH,
                    "contentKind": "plaintext",
                    "updateBlobSha256": delta_sha,
                    "isBaseState": false
                }),
                recorded_at_ms: 100 + seq,
            };
            apply_ydoc_envelope(&mut store, &op, &NoFaults, &NoLiveLeases)
                .expect("delta coalesces");
        }
        (key, winner_doc, conflict_id)
    };
    let _ = winner_doc;
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 10).expect("open actor").actor;
    handle
        .conflict_resolve(
            ResolveTextConflict {
                workspace_id: WS.to_owned(),
                conflict_id,
                resolution: ResolveConflictKind::KeepCurrent,
                object_id: "resolution-fresh-object".to_owned(),
                write_moment_id: "m-resolve-compact".to_owned(),
                delete_moment_id: "m-resolve-delete".to_owned(),
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 500,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("keep-current resolves");
    supervisor.close(&db).expect("close actor");
    let store = EngineStore::open(&db, 501).expect("inspect");
    let (updates, marker_heads): (i64, (i64, i64)) = store
        .read_with(|conn| {
            let updates: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM ydoc_updates \
                     WHERE workspace_id=?1 AND object_id='object-plan'",
                    [WS],
                    |row| row.get(0),
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
            let heads: (i64, i64) = conn
                .query_row(
                    "SELECT head_update_seq, head_snapshot_seq FROM ydoc_docs \
                     WHERE workspace_id=?1 AND object_id='object-plan'",
                    [WS],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
            Ok::<_, dohc_engine_storage::StorageError>((updates, heads))
        })
        .expect("log shape");
    assert_eq!(
        updates, 0,
        "the fold's compaction folds the update log: {marker_heads:?}"
    );
    assert_eq!(
        marker_heads.0, marker_heads.1,
        "the snapshot head caught up with the update head"
    );
}
