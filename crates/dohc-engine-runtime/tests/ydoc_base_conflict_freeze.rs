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
        relay_seq: Some(0),
        op_kind: "ydoc.update".to_owned(),
        payload: serde_json::json!({
            "versionId": "main",
            "objectId": "object-plan",
            "path": PATH,
            "contentKind": "plaintext",
            "updateBlobSha256": winner_sha.clone(),
            "lineageClaimId": winner_sha.clone(),
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
    let (key, winner_base, _winner_doc, _conflict_id) = {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        seed_divergent_base(&mut store)
    };
    std::fs::create_dir_all(scratch.path().join("notes")).expect("notes dir");
    std::fs::write(scratch.path().join(PATH), "local truth").expect("seed disk");

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 5).expect("open actor").actor;
    let lineage_claim_id = dohc_engine_storage::hex_sha256(&winner_base);
    let refused = handle
        .ydoc_settle(
            scratch.path().to_path_buf(),
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Some(lineage_claim_id),
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
async fn positioned_keep_current_rotates_the_lineage_and_journals_one_compound_resolve() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let (key, conflict_id, predecessor_claim) = {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        let (key, _winner_base, _winner_doc, conflict_id) = seed_divergent_base(&mut store);
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
                     (workspace_id,cursor,replication_epoch,stream_identity) \
                     VALUES (?1,'0','epoch-1','stream-1')",
                    [WS],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .expect("relay position");
        let predecessor_claim = dohc_engine_collab::read_marker(&store, &key)
            .expect("read marker")
            .expect("claimed marker")
            .lineage_claim_id
            .expect("exact predecessor claim");
        (key, conflict_id, predecessor_claim)
    };

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 10).expect("open actor").actor;
    handle
        .conflict_resolve(
            ResolveTextConflict {
                workspace_id: WS.to_owned(),
                conflict_id: conflict_id.clone(),
                resolution: ResolveConflictKind::KeepCurrent,
                object_id: "resolution-fresh-object".to_owned(),
                write_moment_id: "m-resolve-write".to_owned(),
                delete_moment_id: "m-resolve-delete".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 11,
                request_id: Some("request-keep-current".to_owned()),
                conflict_answer_budget_bytes: usize::MAX,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("keep-current resolves");
    supervisor.close(&db).expect("close actor");

    let store = EngineStore::open(&db, 12).expect("inspect");
    let marker = dohc_engine_collab::read_marker(&store, &key)
        .expect("read marker")
        .expect("successor marker");
    let successor_claim = marker
        .lineage_claim_id
        .clone()
        .expect("exact successor claim");
    assert_ne!(successor_claim, predecessor_claim);
    assert_eq!(
        marker.lineage_parent_claim_id.as_deref(),
        Some(predecessor_claim.as_str())
    );
    assert_eq!(marker.path.as_deref(), Some(PATH));
    let projection = dohc_engine_collab::load_persisted(&store, &key)
        .expect("load successor")
        .expect("successor lineage")
        .doc
        .project(ContentKind::Plaintext)
        .expect("project successor");
    assert_eq!(projection.markdown, "local truth");

    let (local_ops, inactive, pending, dead_resolve): (
        Vec<(i64, String, serde_json::Value)>,
        i64,
        i64,
        i64,
    ) = store
        .read_with(|conn| {
            let local_ops = conn
                .prepare(
                    "SELECT origin_seq,op_kind,payload_json FROM replication_log \
                     WHERE workspace_id=?1 AND origin_id='local' AND origin_seq>0 \
                     ORDER BY origin_seq",
                )?
                .query_map([WS], |row| {
                    let payload: String = row.get(2)?;
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        serde_json::from_str(&payload).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                payload.len(),
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>((
                local_ops,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_inactive_lineages \
                     WHERE workspace_id=?1 AND version_id='main' AND object_id='object-plan' \
                       AND lineage_claim_id=?2 AND disposition='superseded-predecessor'",
                    rusqlite::params![WS, predecessor_claim],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_pending_conflict_bundles \
                     WHERE workspace_id=?1",
                    [WS],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_journal \
                     WHERE doc_id=?1 AND op_kind='conflict.resolve'",
                    [&conflict_id],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("inspect compound resolution");
    assert_eq!(inactive, 1, "the predecessor remains addressable");
    assert_eq!(pending, 0, "a positioned bundle drains in its transaction");
    assert_eq!(
        dead_resolve, 0,
        "the old payload-free journal is not transport"
    );
    assert_eq!(local_ops.len(), 1);
    assert_eq!(local_ops[0].0, 1);
    assert_eq!(local_ops[0].1, "conflict.resolve");
    let payload = &local_ops[0].2;
    assert_eq!(payload["formatVersion"], 1);
    assert_eq!(payload["workspaceId"], WS);
    assert_eq!(payload["conflictId"], conflict_id);
    assert_eq!(payload["status"], "resolved");
    assert_eq!(payload["effects"], serde_json::json!([]));
    assert_eq!(
        payload["lineageTransition"]["predecessorClaimId"],
        predecessor_claim
    );
    assert_eq!(
        payload["lineageTransition"]["successor"]["lineageClaimId"],
        successor_claim
    );
    assert!(
        local_ops.iter().all(|(_, kind, _)| kind != "ydoc.update"),
        "a compound resolution must not leak a standalone Y.Doc rewrite"
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
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 11,
                request_id: None,
                // This caller builds no wire answer, so nothing bounds the row here.
                conflict_answer_budget_bytes: usize::MAX,
            },
            dohc_engine_collab::LeaseRegistry::new(),
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

    let state = handle
        .ydoc_open_state(
            WS.to_owned(),
            12,
            false,
            None,
            "main".to_owned(),
            PATH.to_owned(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("resolved lineage state");

    handle
        .ydoc_settle(
            scratch.path().to_path_buf(),
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            state.lineage_claim_id,
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
async fn an_oversized_resolution_hits_the_successor_projection_limit_before_effects() {
    // Strict conflict.resolve v1 prepares the successor before domain effects.
    // An oversized resolution therefore reaches the projector's 16 MiB cap
    // before any plaintext write or Y.Doc fold can run. The refusal names the
    // constraint, limit, and observed usage instead of collapsing to
    // state-corrupt.
    //
    // MUTATION: return the old bare `InvalidText { reason: "text exceeds the
    // size cap" }` from `validate_text` - the PayloadTooLarge match fails.
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
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 11,
                request_id: None,
                // This caller builds no wire answer, so nothing bounds the row here.
                conflict_answer_budget_bytes: usize::MAX,
            },
            dohc_engine_collab::LeaseRegistry::new(),
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
            assert_eq!(constraint, "MAX_YDOC_PROJECTION_BYTES (conflict successor)");
            assert_eq!(
                limit_bytes,
                dohc_engine_collab::limits::MAX_PROJECTION_BYTES
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
        let (key, winner_base, winner_doc, conflict_id) = seed_divergent_base(&mut store);
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
                relay_seq: Some(seq + 1),
                op_kind: "ydoc.update".to_owned(),
                payload: serde_json::json!({
                    "versionId": "main",
                    "objectId": "object-plan",
                    "path": PATH,
                    "contentKind": "plaintext",
                    "updateBlobSha256": delta_sha,
                    "lineageClaimId": dohc_engine_storage::hex_sha256(&winner_base),
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
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 500,
                request_id: None,
                // This caller builds no wire answer, so nothing bounds the row here.
                conflict_answer_budget_bytes: usize::MAX,
            },
            dohc_engine_collab::LeaseRegistry::new(),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resolution_refuses_while_a_session_holds_the_document() {
    // The freeze from the other side. The open/settle guards stop a session
    // ACQUIRING a document under review; this is a conflict resolving while
    // an editor is ALREADY holding one. The fold commits a full-document
    // rewrite to the durable Y.Doc while the client keeps editing the copy
    // it has, so its next update merges from pre-resolution state — losing
    // the live edits or reversing the reviewed choice.
    //
    // MUTATION: drop the lease probe in `conflict_resolve_on_store` — the
    // resolve succeeds under the live lease and this refusal fails.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let (key, _winner_base, _winner_doc, conflict_id) = {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        seed_divergent_base(&mut store)
    };

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 10).expect("open actor").actor;
    let leases = dohc_engine_collab::LeaseRegistry::new();
    let _held = leases.acquire(&key).expect("hold the document live");

    let refused = handle
        .conflict_resolve(
            ResolveTextConflict {
                workspace_id: WS.to_owned(),
                conflict_id,
                resolution: ResolveConflictKind::KeepCurrent,
                object_id: "resolution-fresh-object".to_owned(),
                write_moment_id: "m-resolve-live".to_owned(),
                delete_moment_id: "m-resolve-delete".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 11,
                request_id: None,
                // This caller builds no wire answer, so nothing bounds the row here.
                conflict_answer_budget_bytes: usize::MAX,
            },
            leases.clone(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect_err("a live session must block the fold");
    assert!(
        matches!(
            refused,
            dohc_engine_runtime::RuntimeError::Domain(
                dohc_engine_domain::DomainError::InvalidInput {
                    reason: "ydoc-session-live"
                }
            )
        ),
        "unexpected resolve outcome: {refused:?}"
    );

    // The conflict is untouched: still open, still awaiting review.
    supervisor.close(&db).expect("close actor");
    let store = EngineStore::open(&db, 12).expect("inspect");
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
    assert_eq!(
        open_conflicts, 1,
        "the refused resolve left the review open"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_absent_path_resolution_uses_the_derived_live_lease() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let conflict_id = {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        let (_, _, _, conflict_id) = seed_divergent_base(&mut store);
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "DELETE FROM path_aliases WHERE workspace_id=?1 \
                     AND version_id='main' AND path=?2",
                    rusqlite::params![WS, PATH],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                tx.execute(
                    "DELETE FROM snapshots WHERE workspace_id=?1 \
                     AND version_id='main' AND path=?2",
                    rusqlite::params![WS, PATH],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                tx.execute(
                    "UPDATE conflicts SET current_exists=0, current_object_id=NULL, \
                     current_blob_sha256=NULL, current_binary_sha256=NULL, \
                     current_updated_at_ms=NULL, current_latest_moment_id=NULL \
                     WHERE workspace_id=?1 AND conflict_id=?2",
                    rusqlite::params![WS, conflict_id],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .expect("make the reviewed path absent");
        conflict_id
    };
    let state = || {
        let store = EngineStore::open(&db, 2).expect("inspect state");
        store
            .read_with(|conn| {
                Ok::<_, dohc_engine_storage::StorageError>((
                    conn.query_row(
                        "SELECT COUNT(*) FROM snapshots WHERE workspace_id=?1 \
                         AND version_id='main' AND path=?2",
                        rusqlite::params![WS, PATH],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(dohc_engine_storage::StorageError::corrupt_public)?,
                    conn.query_row(
                        "SELECT status FROM conflicts WHERE workspace_id=?1 AND conflict_id=?2",
                        rusqlite::params![WS, conflict_id],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(dohc_engine_storage::StorageError::corrupt_public)?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM moments WHERE workspace_id=?1",
                        [WS],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(dohc_engine_storage::StorageError::corrupt_public)?,
                    conn.query_row("SELECT COUNT(*) FROM replication_journal", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .map_err(dohc_engine_storage::StorageError::corrupt_public)?,
                ))
            })
            .expect("durable state")
    };
    let before = state();
    let derived = dohc_engine_domain::derive_capture_object_id(WS, "main", PATH);
    let key = DocKey::new(WS, "main", derived).expect("derived absent-path key");
    let leases = dohc_engine_collab::LeaseRegistry::new();
    let held = leases.acquire(&key).expect("hold absent path live");
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 10).expect("open actor").actor;
    let input = ResolveTextConflict {
        workspace_id: WS.to_owned(),
        conflict_id: conflict_id.clone(),
        resolution: ResolveConflictKind::ApplyIncoming,
        object_id: "resolved-absent-object".to_owned(),
        write_moment_id: "m-resolve-absent-write".to_owned(),
        delete_moment_id: "m-resolve-absent-delete".to_owned(),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 11,
        request_id: None,
        conflict_answer_budget_bytes: usize::MAX,
    };

    let refused = handle
        .conflict_resolve(
            input.clone(),
            leases.clone(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect_err("the derived live lease must block an absent-path resolution");
    assert!(matches!(
        refused,
        RuntimeError::Domain(dohc_engine_domain::DomainError::InvalidInput {
            reason: "ydoc-session-live"
        })
    ));
    assert_eq!(state(), before, "the refused resolution must roll back");

    drop(held);
    handle
        .conflict_resolve(input, leases, Arc::new(NoFaults), CancellationToken::new())
        .await
        .expect("the resolution retries after the absent-path lease closes");
    supervisor.close(&db).expect("close actor");
    let after = state();
    assert_eq!(after.0, 1);
    assert_eq!(after.1, "resolved");
    assert_eq!(after.2, before.2 + 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_reviewed_deletion_retires_the_lineage_instead_of_being_reversed() {
    // The fourth face of the property: the reviewed OUTCOME is what ends up
    // in the lineage. A deletion is the one resolution carrying no bytes to
    // fold, so the write-only path skipped it — the conflict closed, the
    // canonical rows survived, and the next `ydoc.update` found the path
    // absent, accepted it, and projected the retained lineage back into a
    // snapshot. The user's approved deletion was silently reversed.
    //
    // MUTATION: drop the `retire_ydoc_lineage_in_tx` call from the delete
    // arm — the lineage rows survive and the assertions below fail.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let (key, _winner_base, _winner_doc, conflict_id) = {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        seed_divergent_base(&mut store)
    };

    // The incoming side is ABSENT: applying it is a deletion. This is the
    // row shape a delete-side conflict carries.
    {
        let mut store = EngineStore::open(&db, 2).expect("reopen");
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE conflicts SET incoming_exists = 0, \
                     incoming_blob_sha256 = NULL, incoming_binary_sha256 = NULL \
                     WHERE workspace_id = ?1 AND conflict_id = ?2",
                    rusqlite::params![WS, conflict_id],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                tx.execute(
                    "INSERT INTO ydoc_deferred_updates \
                     (workspace_id, version_id, object_id, origin_id, origin_seq, recorded_at_ms) \
                     VALUES (?1, ?2, ?3, 'deferred-delete-peer', 0, 10)",
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok::<_, dohc_engine_storage::StorageError>(())
            })
            .expect("make the incoming side absent with a deferred Y.Doc update");
    }

    let state = || {
        let store = EngineStore::open(&db, 9).expect("inspect state");
        store
            .read_with(|conn| {
                let count = |table: &str| -> Result<i64, dohc_engine_storage::StorageError> {
                    conn.query_row(
                        &format!("SELECT COUNT(*) FROM {table} WHERE workspace_id=?1"),
                        [WS],
                        |row| row.get(0),
                    )
                    .map_err(dohc_engine_storage::StorageError::corrupt_public)
                };
                Ok::<_, dohc_engine_storage::StorageError>((
                    conn.query_row(
                        "SELECT status FROM conflicts WHERE workspace_id=?1 AND conflict_id=?2",
                        rusqlite::params![WS, conflict_id],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(dohc_engine_storage::StorageError::corrupt_public)?,
                    count("snapshots")?,
                    count("moments")?,
                    count("replication_log")?,
                    count("ydoc_docs")?,
                    count("ydoc_updates")?,
                    count("ydoc_snapshots")?,
                    count("ydoc_deferred_updates")?,
                ))
            })
            .expect("read state")
    };
    let before = state();
    let resolve_input = || ResolveTextConflict {
        workspace_id: WS.to_owned(),
        conflict_id: conflict_id.clone(),
        resolution: ResolveConflictKind::ApplyIncoming,
        object_id: "resolution-fresh-object".to_owned(),
        write_moment_id: "m-resolve-del-write".to_owned(),
        delete_moment_id: "m-resolve-del".to_owned(),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 11,
        request_id: None,
        conflict_answer_budget_bytes: usize::MAX,
    };
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 10).expect("open actor").actor;
    let refused = handle
        .conflict_resolve(
            resolve_input(),
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect_err("the deferred Y.Doc update must block the deletion");
    assert!(matches!(
        refused,
        RuntimeError::Domain(dohc_engine_domain::DomainError::InvalidInput {
            reason: "ydoc-deferred-updates-pending"
        })
    ));
    supervisor.close(&db).expect("close actor");
    assert_eq!(
        state(),
        before,
        "the mapped retry refusal must roll back the conflict, snapshot, history, and lineage"
    );
    let mut store = EngineStore::open(&db, 11).expect("clear deferred row");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM ydoc_deferred_updates WHERE workspace_id=?1 AND version_id=?2 \
                 AND object_id=?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, dohc_engine_storage::StorageError>(())
        })
        .expect("clear deferred row");
    drop(store);
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 12).expect("reopen actor").actor;
    handle
        .conflict_resolve(
            resolve_input(),
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("the deletion resolves after the deferred row clears");
    supervisor.close(&db).expect("close actor after retry");

    // Nothing is left that could project the deleted content back.
    let store = EngineStore::open(&db, 12).expect("inspect");
    let (updates, snapshots, markers, deferred): (i64, i64, i64, i64) = store
        .read_with(|conn| {
            let count = |table: &str| -> Result<i64, dohc_engine_storage::StorageError> {
                conn.query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE workspace_id=?1 AND object_id=?2"),
                    rusqlite::params![WS, key.object_id],
                    |row| row.get(0),
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)
            };
            Ok::<_, dohc_engine_storage::StorageError>((
                count("ydoc_updates")?,
                count("ydoc_snapshots")?,
                count("ydoc_docs")?,
                count("ydoc_deferred_updates")?,
            ))
        })
        .expect("lineage state");
    assert_eq!(
        (updates, snapshots, markers, deferred),
        (0, 0, 0, 0),
        "the reviewed deletion retires the lineage: nothing can project it back"
    );
    let (full_state_sha, state_vector_sha, disposition, successor_rows): (
        String,
        String,
        String,
        i64,
    ) = store
        .read_with(|conn| {
            let archived = conn.query_row(
                "SELECT full_state_blob_sha256,state_vector_blob_sha256,disposition \
                 FROM ydoc_inactive_lineages WHERE workspace_id=?1 AND version_id=?2 \
                   AND object_id=?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let successor_rows = conn.query_row(
                "SELECT COUNT(*) FROM ydoc_inactive_lineages WHERE workspace_id=?1 \
                   AND version_id=?2 AND object_id=?3 AND parent_claim_id IS NOT NULL",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                |row| row.get(0),
            )?;
            Ok::<_, rusqlite::Error>((archived.0, archived.1, archived.2, successor_rows))
        })
        .expect("archived predecessor");
    assert_eq!(disposition, "superseded-predecessor");
    assert_eq!(successor_rows, 0, "a deletion has no successor lineage");
    let full_state = store
        .get_binary_blob(&full_state_sha)
        .expect("read archived full state")
        .expect("archived full state blob");
    let state_vector = store
        .get_binary_blob(&state_vector_sha)
        .expect("read archived state vector")
        .expect("archived state-vector blob");
    let archived = dohc_engine_collab::Ydoc::wire();
    archived
        .apply(&full_state)
        .expect("decode archived full state");
    assert!(!archived.has_pending_dependencies());
    assert_eq!(archived.encode_state_vector(), state_vector);
    assert_eq!(
        archived
            .project(ContentKind::Plaintext)
            .expect("project archived predecessor")
            .markdown,
        "remote truth"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn moved_text_and_binary_results_archive_the_full_predecessor_without_a_successor() {
    for (case, moved_path, binary_bytes) in [
        ("moved", Some("notes/moved.md"), None),
        ("binary", None, Some(b"\x89BIN\0reviewed".as_slice())),
    ] {
        let scratch = ScratchDir::new().expect("scratch");
        let db = scratch.engine_db_path().expect("db");
        let (key, conflict_id) = {
            let mut store = EngineStore::open(&db, 1).expect("open store");
            let (key, _winner_base, _winner_doc, conflict_id) = seed_divergent_base(&mut store);
            if let Some(path) = moved_path {
                store
                    .write_with(&NoFaults, |tx| {
                        tx.execute(
                            "UPDATE conflicts SET incoming_path=?3 WHERE workspace_id=?1 \
                             AND conflict_id=?2",
                            rusqlite::params![WS, conflict_id, path],
                        )
                        .map_err(dohc_engine_storage::StorageError::persist_public)?;
                        Ok::<_, dohc_engine_storage::StorageError>(())
                    })
                    .expect("move incoming side");
            }
            if let Some(bytes) = binary_bytes {
                let sha = store.put_binary_blob(bytes).expect("incoming binary blob");
                store
                    .write_with(&NoFaults, |tx| {
                        tx.execute(
                            "UPDATE conflicts SET incoming_content_kind='binary', \
                             incoming_blob_sha256=NULL,incoming_binary_sha256=?3 \
                             WHERE workspace_id=?1 AND conflict_id=?2",
                            rusqlite::params![WS, conflict_id, sha],
                        )
                        .map_err(dohc_engine_storage::StorageError::persist_public)?;
                        Ok::<_, dohc_engine_storage::StorageError>(())
                    })
                    .expect("replace incoming side with binary");
            }
            (key, conflict_id)
        };

        let supervisor = WorkspaceSupervisor::new();
        let handle = supervisor.open(&db, 10).expect("open actor").actor;
        let input = ResolveTextConflict {
            workspace_id: WS.to_owned(),
            conflict_id: conflict_id.clone(),
            resolution: ResolveConflictKind::ApplyIncoming,
            object_id: format!("resolved-{case}-object"),
            write_moment_id: format!("m-resolve-{case}-write"),
            delete_moment_id: format!("m-resolve-{case}-delete"),
            metadata_origin: "api".to_owned(),
            metadata_summary: Some(format!("reviewed {case}")),
            metadata_correlation_id: Some(format!("correlation-{case}")),
            author_json: Some(
                serde_json::json!({
                    "kind": "agent",
                    "agentId": "agent-1",
                    "onBehalfOf": "user-1"
                })
                .to_string(),
            ),
            now_ms: 11,
            request_id: Some(format!("request-{case}")),
            conflict_answer_budget_bytes: usize::MAX,
        };
        let leases = dohc_engine_collab::LeaseRegistry::new();
        let held_destination = if let Some(moved_path) = moved_path {
            let destination = DocKey::new(
                WS,
                "main",
                dohc_engine_domain::derive_capture_object_id(WS, "main", moved_path),
            )
            .expect("absent destination Y.Doc key");
            assert_ne!(destination.object_id, input.object_id);
            Some(leases.acquire(&destination).expect("hold destination live"))
        } else {
            None
        };
        if held_destination.is_some() {
            let refused = handle
                .conflict_resolve(
                    input.clone(),
                    leases.clone(),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
                .expect_err("the destination Y.Doc lease must block a moved result");
            assert!(matches!(
                refused,
                RuntimeError::Domain(dohc_engine_domain::DomainError::InvalidInput {
                    reason: "ydoc-session-live"
                })
            ));
        }
        drop(held_destination);
        handle
            .conflict_resolve(input, leases, Arc::new(NoFaults), CancellationToken::new())
            .await
            .unwrap_or_else(|error| panic!("resolve {case}: {error:?}"));
        supervisor.close(&db).expect("close actor");

        let mut store = EngineStore::open(&db, 12).expect("inspect");
        if let Some(path) = moved_path {
            assert!(
                VersionedTextStore::new(&mut store)
                    .read_text(WS, "main", PATH)
                    .expect("read old path")
                    .is_none()
            );
            assert_eq!(
                VersionedTextStore::new(&mut store)
                    .read_text(WS, "main", path)
                    .expect("read moved path")
                    .expect("moved result")
                    .text,
                "remote truth"
            );
            let effect_ids = store
                .read_with(|conn| {
                    conn.prepare(
                        "SELECT moment_id FROM moments WHERE workspace_id=?1 \
                         AND moment_id IN (?2,?3) ORDER BY moment_order",
                    )?
                    .query_map(
                        rusqlite::params![
                            WS,
                            format!("m-resolve-{case}-delete"),
                            format!("m-resolve-{case}-write")
                        ],
                        |row| row.get::<_, String>(0),
                    )?
                    .collect::<Result<Vec<_>, _>>()
                })
                .expect("ordered move effects");
            assert_eq!(
                effect_ids,
                [
                    format!("m-resolve-{case}-delete"),
                    format!("m-resolve-{case}-write")
                ]
            );
        } else {
            assert_eq!(
                VersionedTextStore::new(&mut store)
                    .read_binary(WS, "main", PATH)
                    .expect("read binary result")
                    .expect("binary result")
                    .bytes,
                binary_bytes.expect("binary case")
            );
        }

        let (full_state_sha, state_vector_sha, active_rows, inactive_rows) = store
            .read_with(|conn| {
                let archived = conn.query_row(
                    "SELECT full_state_blob_sha256,state_vector_blob_sha256 \
                     FROM ydoc_inactive_lineages WHERE workspace_id=?1 AND version_id=?2 \
                       AND object_id=?3 AND disposition='superseded-predecessor'",
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?;
                Ok::<_, rusqlite::Error>((
                    archived.0,
                    archived.1,
                    conn.query_row(
                        "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id=?1",
                        [WS],
                        |row| row.get::<_, i64>(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM ydoc_inactive_lineages WHERE workspace_id=?1",
                        [WS],
                        |row| row.get::<_, i64>(0),
                    )?,
                ))
            })
            .expect("archived lineage rows");
        assert_eq!(active_rows, 0, "{case} must not install a successor");
        assert_eq!(inactive_rows, 1, "{case} keeps exactly the predecessor");
        let full_state = store
            .get_binary_blob(&full_state_sha)
            .expect("read archived full state")
            .expect("archived full state");
        let state_vector = store
            .get_binary_blob(&state_vector_sha)
            .expect("read archived state vector")
            .expect("archived state vector");
        let archived = dohc_engine_collab::Ydoc::wire();
        archived.apply(&full_state).expect("decode archived state");
        assert!(!archived.has_pending_dependencies());
        assert_eq!(archived.encode_state_vector(), state_vector);
        assert_eq!(
            archived
                .project(ContentKind::Plaintext)
                .expect("project predecessor")
                .markdown,
            "remote truth"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_idempotent_retry_survives_a_live_session() {
    // The live-lease guard must not outrank the idempotency contract. A
    // resolution commits, its response is lost, the user opens the resolved
    // document, and the client retries the SAME request_id. The request
    // ledger replays the recorded result and rewrites nothing — so refusing
    // that retry for a live lease would turn a lost response into a
    // different answer.
    //
    // MUTATION: drop `AND status='open'` from the guard's conflict lookup —
    // the retry below fails with ydoc-session-live.
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let (key, _winner_base, _winner_doc, conflict_id) = {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        seed_divergent_base(&mut store)
    };

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 10).expect("open actor").actor;
    let resolve = |leases: dohc_engine_collab::LeaseRegistry| {
        let handle = handle.clone();
        let conflict_id = conflict_id.clone();
        async move {
            handle
                .conflict_resolve(
                    ResolveTextConflict {
                        workspace_id: WS.to_owned(),
                        conflict_id,
                        resolution: ResolveConflictKind::KeepCurrent,
                        object_id: "resolution-fresh-object".to_owned(),
                        write_moment_id: "m-retry-write".to_owned(),
                        delete_moment_id: "m-retry-delete".to_owned(),
                        metadata_origin: "api".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 11,
                        request_id: Some("retry-request-1".to_owned()),
                        // This caller builds no wire answer, so nothing bounds the row here.
                        conflict_answer_budget_bytes: usize::MAX,
                    },
                    leases,
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
        }
    };

    // The first attempt commits; imagine its response never arrived.
    resolve(dohc_engine_collab::LeaseRegistry::new())
        .await
        .expect("the resolution commits");

    // The user reopens the resolved document, so a session now holds it.
    let leases = dohc_engine_collab::LeaseRegistry::new();
    let _held = leases.acquire(&key).expect("hold the document live");

    // The exact retry must replay, not refuse.
    resolve(leases)
        .await
        .expect("an idempotent retry must survive a live session");
    supervisor.close(&db).expect("close actor");
}
