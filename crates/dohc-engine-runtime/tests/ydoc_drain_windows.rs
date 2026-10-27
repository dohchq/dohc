//! The open and close paths drain the deferred Y.Doc queue, then run a
//! fallible step. The queue rows carry the record facts the drain persisted
//! on them, so an error in that window must leave the rows in place:
//! a retry re-drains content-deduped and can still surface the facts.
//! Consuming them first drops the events with no path left to emit.
//!
//! Record facts derive only for bound collection records; these plaintext
//! tests pin the QUEUE-ROW ordering. The rows-to-events pipeline itself is
//! pinned by the `a_parked_update_drained_on_*` rpc tests.

use dohc_engine_collab::DocKey;
use dohc_engine_runtime::{CancellationToken, CaptureIngest, NoFaults, WorkspaceSupervisor};
use dohc_engine_storage::{EngineStore, FaultPoint, StorageError};
use dohc_engine_sync::{AlwaysLive, NoLiveLeases, ReplicationEnvelope, apply_ydoc_envelope};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::sync::Arc;

const WS: &str = "ws-drain-windows";
const PATH: &str = "notes/live.md";

fn deferred_rows(db: &std::path::Path) -> i64 {
    let store = EngineStore::open_read_only(db).expect("open probe store");
    store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                row.get::<_, i64>(0)
            })
        })
        .expect("count deferred rows")
}

fn applied_update_rows(db: &std::path::Path) -> i64 {
    let store = EngineStore::open_read_only(db).expect("open probe store");
    store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| {
                row.get::<_, i64>(0)
            })
        })
        .expect("count applied updates")
}

/// A captured head, a replicated base, and one update parked behind a live
/// lease — the state a crashed session leaves for a later drain to apply.
async fn seed_parked_update(scratch: &ScratchDir) -> DocKey {
    seed_parked_update_kind(scratch, false).await
}

async fn seed_parked_update_kind(scratch: &ScratchDir, markdown: bool) -> DocKey {
    use yrs::{Map, ReadTxn, Transact, updates::decoder::Decode};
    let source = if markdown { "Imported source\n" } else { "before" };
    let db = engine_db_path(scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let written = handle
        .capture_ingest(
            CaptureIngest {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: PATH.to_owned(),
                text: source.to_owned(),
                metadata_origin: "capture".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
                request_id: Some("drain-windows-seed".to_owned()),
                claim_foreign_head: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture");
    let object_id = written.snapshot.object_id.clone();
    supervisor.close(&db).expect("close actor");
    std::fs::create_dir_all(scratch.path().join("notes")).expect("notes dir");
    std::fs::write(scratch.path().join(PATH), source).expect("disk preimage");

    let key = DocKey::new(WS, "main", &object_id).expect("key");
    let mut store = EngineStore::open(&db, 100).expect("open store");
    let doc = dohc_engine_collab::Ydoc::wire();
    if markdown {
        doc.rewrite_content_to_markdown_preserving_source(dohc_engine_collab::ContentKind::Richdoc, source)
            .unwrap();
    } else {
        doc.plaintext_insert(0, source);
    }
    let kind = if markdown { "richdoc" } else { "plaintext" };
    let base_bytes = doc.encode_full_state();
    let base_sha = store.put_binary_blob(&base_bytes).expect("base blob");
    let base = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: WS.to_owned(),
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        relay_seq: Some(0),
        op_kind: "ydoc.update".to_owned(),
        payload: serde_json::json!({
            "versionId": "main",
            "objectId": object_id,
            "path": PATH,
            "contentKind": kind,
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha.clone(),
            "isBaseState": true
        }),
        recorded_at_ms: 110,
    };
    apply_ydoc_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("apply verified base");

    let update_bytes = if markdown {
        let wire = yrs::Doc::new();
        wire.transact_mut().apply_update(yrs::Update::decode_v1(&doc.encode_full_state()).unwrap()).unwrap();
        wire.get_or_insert_map("meta").insert(&mut wire.transact_mut(),
            "dohcMarkdownSource", "A source that does not match its recorded digest");
        doc.apply(&wire.transact().encode_state_as_update_v1(&yrs::StateVector::default())).unwrap();
        doc.richdoc_append_paragraph("Accepted parked Markdown edit");
        doc.encode_full_state()
    } else {
        doc.plaintext_insert(6, " parked")
    };
    let blob_sha = store.put_binary_blob(&update_bytes).expect("blob");
    let envelope = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: WS.to_owned(),
        origin_id: "peer".to_owned(),
        origin_seq: 1,
        relay_seq: Some(1),
        op_kind: "ydoc.update".to_owned(),
        payload: serde_json::json!({
            "versionId": "main",
            "objectId": object_id,
            "path": PATH,
            "contentKind": kind,
            "updateBlobSha256": blob_sha,
            "lineageClaimId": base_sha,
            "isBaseState": false
        }),
        recorded_at_ms: 120,
    };
    apply_ydoc_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &envelope,
        &NoFaults,
        &AlwaysLive,
    )
    .expect("park");
    drop(store);
    assert_eq!(deferred_rows(&db), 1, "the envelope starts parked");
    key
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn markdown_hold_open_resync_and_close_keep_the_file_and_consume_only_parked_rows() {
    use dohc_engine_collab::{ContentKind, Ydoc, markdown_write_obligations};
    use dohc_engine_storage::hex_sha256;
    for operation in ["open", "resync", "close"] {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let key = seed_parked_update_kind(&scratch, true).await;
        let path = scratch.path().join(PATH);
        let bytes = std::fs::read(&path).unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let (claim, counts) = {
            let store = EngineStore::open_read_only(&db).unwrap();
            let claim = dohc_engine_collab::read_marker(&store, &key).unwrap().unwrap().lineage_claim_id;
            let counts = ["moments", "materialization_jobs", "live_device_settlements"]
                .map(|table| store.table_row_count(table).unwrap());
            (claim, counts)
        };
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 200).unwrap().actor;
        let update = match operation {
            "open" => actor.ydoc_open_state(WS.into(), 201, true, Some(key.clone()), "main".into(),
                PATH.into(), Some(ContentKind::Richdoc), CancellationToken::new()).await.unwrap().initial_update,
            "resync" => actor.ydoc_resync(key.clone(), claim.clone(), CancellationToken::new(), None)
                .await.unwrap().initial_update,
            _ => {
                actor.ydoc_close_session_materialized(scratch.path().to_owned(), key.clone(), Arc::new(()),
                    201, Arc::new(NoFaults), CancellationToken::new()).await.unwrap();
                actor.ydoc_open_state(WS.into(), 202, true, Some(key.clone()), "main".into(),
                    PATH.into(), Some(ContentKind::Richdoc), CancellationToken::new()).await.unwrap().initial_update
            }
        };
        let doc = Ydoc::wire();
        doc.apply(&update).unwrap();
        assert_eq!(doc.project(ContentKind::Richdoc).unwrap().content
            .matches("Accepted parked Markdown edit").count(), 1);
        assert!(doc.has_markdown_witness());
        assert_eq!(deferred_rows(&db), 0);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), modified);
        supervisor.close(&db).unwrap();
        let actor = supervisor.open(&db, 203).unwrap().actor;
        let reopened = actor.ydoc_resync(key.clone(), claim, CancellationToken::new(), None).await.unwrap();
        assert_eq!(reopened.head_blob_sha256.as_deref(), Some(hex_sha256(&bytes).as_str()));
        let doc = Ydoc::wire();
        doc.apply(&reopened.initial_update).unwrap();
        assert_eq!(doc.project(ContentKind::Richdoc).unwrap().content
            .matches("Accepted parked Markdown edit").count(), 1);
        {
            let store = EngineStore::open_read_only(&db).unwrap();
            assert_eq!(["moments", "materialization_jobs", "live_device_settlements"]
                .map(|table| store.table_row_count(table).unwrap()), counts);
            assert!(!store.read_with(|conn| markdown_write_obligations::pending_in(conn, WS)).unwrap().is_empty());
            assert!(dohc_engine_sync::list_refusal_notices(&store, WS).unwrap().iter()
                .any(|notice| notice.reason == "markdown-write-held"));
        }
        supervisor.close(&db).unwrap();
    }
}

/// #1009 (open window): the post-lease open runs its conflict freeze before
/// its deferred drain. A refused open has no event route, so draining first
/// would consume the parked rows with nothing left for the reopen after
/// resolution to drain and emit.
///
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_open_refused_by_a_sync_conflict_keeps_the_parked_queue_for_the_retry() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let key = seed_parked_update(&scratch).await;

    // An open sync conflict on the object, in the shape
    // `open_sync_conflict_for_object` matches. Seeded directly; only the
    // freeze-vs-drain ordering is under test, not the conflict lifecycle.
    let mut store = EngineStore::open(&db, 200).expect("open conflict seed store");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO conflicts (workspace_id, conflict_id, path, target_version_id, \
                 source_version_id, created_at_ms, updated_at_ms, status, chosen_from, \
                 metadata_origin, base_exists, base_path, current_exists, current_path, \
                 incoming_exists, incoming_path, incoming_object_id) \
                 VALUES (?1, 'sync-conflict-parked', ?2, 'main', 'main', 500, 500, \
                 'open', 'none', 'sync', 1, ?2, 1, ?2, 1, ?2, ?3)",
                rusqlite::params![WS, PATH, key.object_id],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("seed open sync conflict");
    drop(store);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 2).expect("reopen actor").actor;
    let refused = handle
        .ydoc_open_state(
            WS.to_owned(),
            200,
            true,
            Some(key.clone()),
            "main".to_owned(),
            PATH.to_owned(),
            None,
            CancellationToken::new(),
        )
        .await
        .expect_err("an open sync conflict must freeze the post-lease open");
    assert!(
        format!("{refused:?}").contains("ydoc-conflict-open"),
        "the freeze carries the settle's reason: {refused:?}"
    );
    assert_eq!(
        deferred_rows(&db),
        1,
        "the refused open must not consume the parked queue row"
    );

    // Resolution lifts the freeze; the reopen drains the parked update.
    let mut store = EngineStore::open(&db, 201).expect("open conflict resolve store");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE conflicts SET status='resolved' \
                 WHERE workspace_id=?1 AND conflict_id='sync-conflict-parked'",
                [WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("resolve conflict");
    drop(store);
    handle
        .ydoc_open_state(
            WS.to_owned(),
            300,
            true,
            Some(key),
            "main".to_owned(),
            PATH.to_owned(),
            None,
            CancellationToken::new(),
        )
        .await
        .expect("reopen after resolution");
    supervisor.close(&db).expect("close actor");
    assert_eq!(deferred_rows(&db), 0, "the reopen drains the parked update");
    assert_eq!(
        applied_update_rows(&db),
        1,
        "the drained update lands exactly once"
    );
}

/// #1009 (close window): a close whose drain-materialization fails must keep
/// the parked queue rows so the retried close can drain again
/// (content-deduped, no duplicated history) and surface their facts.
///
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_close_that_fails_to_materialize_keeps_the_parked_queue_for_the_retry() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let key = seed_parked_update(&scratch).await;

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 2).expect("reopen actor").actor;
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterTempWrite);
    handle
        .ydoc_close_session_materialized(
            scratch.path().to_path_buf(),
            key.clone(),
            Arc::new(()),
            200,
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("the close must report the failed drain materialization");
    assert!(
        faults.fired(),
        "the close drain must reach the injected materialization fault"
    );
    // The drained coordinate is applied and projected, but its queue row —
    // carrying the persisted record facts — survives the failed close.
    assert_eq!(
        deferred_rows(&db),
        1,
        "a close that fails after its drain must keep the parked queue rows"
    );
    let applied_after_failure = applied_update_rows(&db);

    // The retry re-drains content-deduped, materializes, and only then
    // consumes the queue.
    handle
        .ydoc_close_session_materialized(
            scratch.path().to_path_buf(),
            key,
            Arc::new(()),
            300,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("retried close");
    supervisor.close(&db).expect("close actor");
    assert_eq!(
        deferred_rows(&db),
        0,
        "the retried close consumes the queue"
    );
    assert_eq!(
        applied_update_rows(&db),
        applied_after_failure,
        "the retried drain replays content-deduped, never duplicating history"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(PATH)).expect("materialized head"),
        "before parked",
        "the retried close materializes the drained projection"
    );
}
