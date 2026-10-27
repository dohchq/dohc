//! Durable holds park actual relay and rollback placements, including replay.
use dohc_engine_collab::{ContentKind, Ydoc};
use dohc_engine_domain::{CaptureIngest, RollbackTextFileMutation, VersionedTextStore, WriteText};
use dohc_engine_runtime::{CancellationToken, WorkspaceSupervisor, WriteConditions};
use dohc_engine_storage::FaultPoint;
use dohc_engine_storage::{EngineStore, NoFaults, StorageError};
use dohc_engine_sync::MomentMaterializationChange;
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::sync::Arc;

const WS: &str = "held-placement";
const FILE: &str = "held.md";

fn captured(text: &str) -> CaptureIngest {
    CaptureIngest {
        workspace_id: WS.into(),
        version_id: "main".into(),
        path: FILE.into(),
        text: text.into(),
        metadata_origin: "capture".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 2,
        request_id: None,
        claim_foreign_head: false,
    }
}

fn hold(store: &mut EngineStore, object: &str, outside: &str) {
    store.write_with(&NoFaults, |tx| {
        // Supply the hold contract on the base too. Its failure must exercise
        // production placement, rather than stop at the missing migration.
        tx.execute_batch("CREATE TABLE IF NOT EXISTS capture_file_holds (workspace_id TEXT NOT NULL,source_version_id TEXT NOT NULL,object_id TEXT NOT NULL,path TEXT NOT NULL,observed_sha256 TEXT NOT NULL,observed_size INTEGER NOT NULL,reason TEXT NOT NULL,observed_at_ms INTEGER NOT NULL,attempt_count INTEGER NOT NULL,retry_requested INTEGER NOT NULL,PRIMARY KEY(workspace_id,path))").map_err(StorageError::persist_public)?;
        tx.execute("INSERT INTO capture_file_holds VALUES (?1,'main',?2,?3,?4,?5,'ydoc-resolution-not-representable',3,1,0)", rusqlite::params![WS,object,FILE,dohc_engine_storage::hex_sha256(outside.as_bytes()),outside.len() as i64]).map_err(StorageError::persist_public)?;
        Ok::<_, StorageError>(())
    }).unwrap();
}

#[tokio::test]
async fn capture_file_hold_parks_relay_page_and_restart_replay() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let outside = format!("{} too deep\n", "> ".repeat(121));
    let mut store = EngineStore::open(&db, 1).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", 1, &NoFaults)
        .unwrap();
    let first = VersionedTextStore::new(&mut store)
        .capture_ingest(&captured(&outside), &NoFaults)
        .unwrap();
    hold(&mut store, &first.snapshot.object_id, &outside);
    // The outside bytes are an old recorded blob. Relay placement still parks
    // while held; its preimage now comes from the source version's current head.
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: WS.into(),
                version_id: "main".into(),
                object_id: first.snapshot.object_id,
                path: FILE.into(),
                text: "Remote edit.\n".into(),
                moment_id: "remote-edit".into(),
                metadata_origin: "sync".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 4,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    drop(store);
    std::fs::write(scratch.path().join(FILE), &outside).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 5).unwrap().actor;
    actor
        .materialize_relay_page(
            WS.into(),
            scratch.path().into(),
            vec![MomentMaterializationChange {
                version_id: "main".into(),
                path: FILE.into(),
                operation: "write",
                content_kind: "text",
            }],
            Arc::new(()),
            6,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).unwrap(),
        outside
    );
    supervisor.close(&db).unwrap();
    let actor = supervisor.open(&db, 7).unwrap().actor;
    actor
        .materialize_replay_pending(scratch.path().into(), WS.into(), 8)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).unwrap(),
        outside
    );
    supervisor.close(&db).unwrap();
    let store = EngineStore::open(&db, 9).unwrap();
    assert_eq!(store.list_pending_materialization_jobs().unwrap().len(), 1);
}

#[tokio::test]
async fn capture_file_hold_parks_rollback_and_restart_replay() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let outside = format!("{} too deep\n", "> ".repeat(121));
    let mut store = EngineStore::open(&db, 1).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", 1, &NoFaults)
        .unwrap();
    let before = VersionedTextStore::new(&mut store)
        .capture_ingest(&captured("Before.\n"), &NoFaults)
        .unwrap();
    drop(store);
    std::fs::write(scratch.path().join(FILE), "Before.\n").unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 4).unwrap().actor;
    let after = actor
        .versioned_text_publish(
            WriteText {
                workspace_id: WS.into(),
                version_id: "main".into(),
                object_id: before.snapshot.object_id,
                path: FILE.into(),
                text: outside.clone(),
                moment_id: "held-written".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 4,
                request_id: Some("held-write".into()),
            },
            scratch.path().into(),
            WriteConditions::default(),
            None,
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    supervisor.close(&db).unwrap();
    let mut store = EngineStore::open(&db, 5).unwrap();
    hold(&mut store, &after.write.snapshot.object_id, &outside);
    drop(store);
    let actor = supervisor.open(&db, 6).unwrap().actor;
    let result = actor
        .versioned_text_rollback(
            RollbackTextFileMutation {
                workspace_id: WS.into(),
                version_id: "main".into(),
                path: FILE.into(),
                mutation_moment_id: after.write.moment.moment_id,
                request_id: Some("held-undo".into()),
                metadata_origin: "restore".into(),
                author_json: None,
            },
            scratch.path().into(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).unwrap(),
        outside
    );
    assert_eq!(format!("{:?}", result.materialize_outcome), "Parked");
    supervisor.close(&db).unwrap();
    let actor = supervisor.open(&db, 5).unwrap().actor;
    actor
        .materialize_replay_pending(scratch.path().into(), WS.into(), 6)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).unwrap(),
        outside
    );
    supervisor.close(&db).unwrap();
}

#[tokio::test]
async fn capture_file_hold_parks_pending_settlement_without_compensation() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let outside = format!("{} too deep\n", "> ".repeat(121));
    let mut store = EngineStore::open(&db, 1).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", 1, &NoFaults)
        .unwrap();
    VersionedTextStore::new(&mut store)
        .capture_ingest(&captured("Before.\n"), &NoFaults)
        .unwrap();
    drop(store);
    std::fs::write(scratch.path().join(FILE), "Before.\n").unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 4).unwrap().actor;
    let state = actor
        .ydoc_open_state(
            WS.into(),
            4,
            true,
            None,
            "main".into(),
            FILE.into(),
            Some(ContentKind::Richdoc),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let doc = Ydoc::wire();
    doc.apply(&state.initial_update).unwrap();
    if let Some(seed) = &state.seed_content {
        doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, seed)
            .unwrap();
    }
    doc.richdoc_append_paragraph("Pending paragraph");
    actor
        .ydoc_record_update(
            state.key.clone(),
            FILE.into(),
            ContentKind::Richdoc,
            state.regime,
            doc.encode_full_state(),
            None,
            None,
            state.lineage_claim_id.clone(),
            false,
            None,
            None,
            5,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
    assert!(
        actor
            .ydoc_settle(
                scratch.path().into(),
                state.key.clone(),
                FILE.into(),
                ContentKind::Richdoc,
                state.lineage_claim_id.clone(),
                state.head_blob_sha256.clone(),
                "hold-settlement".into(),
                Arc::new(()),
                6,
                ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit),
                CancellationToken::new(),
                None
            ,
                None,
            )
            .await
            .is_err()
    );
    supervisor.close(&db).unwrap();
    let mut store = EngineStore::open(&db, 7).unwrap();
    hold(&mut store, &state.key.object_id, &outside);
    let pending = store.list_pending_materialization_jobs().unwrap();
    assert_eq!(pending.len(), 1);
    let job_id = pending[0].job_id.clone();
    let expected_head = VersionedTextStore::new(&mut store)
        .read_text(WS, "main", FILE)
        .unwrap()
        .unwrap()
        .blob_sha256;
    let before: (i64, Option<i64>, i64) = store.read_with(|conn| conn.query_row(
        "SELECT settle_seq,settle_prior_update_seq,(SELECT COUNT(*) FROM moments WHERE workspace_id=?1) FROM ydoc_docs WHERE workspace_id=?1 AND object_id=?2",
        rusqlite::params![WS,state.key.object_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))).unwrap();
    drop(store);
    std::fs::write(scratch.path().join(FILE), &outside).unwrap();
    let actor = supervisor.open(&db, 8).unwrap().actor;
    let result = actor
        .ydoc_settle(
            scratch.path().into(),
            state.key.clone(),
            FILE.into(),
            ContentKind::Richdoc,
            state.lineage_claim_id,
            Some(expected_head),
            "hold-settlement".into(),
            Arc::new(()),
            9,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        
            None,
        )
        .await;
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).unwrap(),
        outside
    );
    let inspection = rusqlite::Connection::open(&db).unwrap();
    let status: String = inspection
        .query_row(
            "SELECT status FROM materialization_jobs WHERE job_id=?1",
            [&job_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        status, "pending",
        "a held settlement stays pending instead of compensating"
    );
    drop(inspection);
    assert_eq!(result.unwrap_err().code(), "capture-file-held");
    actor
        .materialize_replay_pending(scratch.path().into(), WS.into(), 10)
        .await
        .unwrap();
    supervisor.close(&db).unwrap();
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).unwrap(),
        outside
    );
    let store = EngineStore::open(&db, 11).unwrap();
    assert_eq!(
        format!(
            "{:?}",
            store
                .load_materialization_job(&job_id)
                .unwrap()
                .unwrap()
                .status
        ),
        "Pending"
    );
    let after = store.read_with(|conn| conn.query_row(
        "SELECT settle_seq,settle_prior_update_seq,(SELECT COUNT(*) FROM moments WHERE workspace_id=?1) FROM ydoc_docs WHERE workspace_id=?1 AND object_id=?2",
        rusqlite::params![WS,state.key.object_id], |row| Ok((row.get::<_, i64>(0)?,row.get::<_, Option<i64>>(1)?,row.get::<_, i64>(2)?)))).unwrap();
    assert_eq!(
        after, before,
        "parking does not compensate the settlement or remove its history"
    );
}
