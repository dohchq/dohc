use dohc_engine_collab::{ContentKind, DocKey, LeaseRegistry, Regime, Ydoc};
use dohc_engine_domain::{CaptureIngest, ChangeActorKind, ChangeAttribution};
use dohc_engine_runtime::{ActorHandle, CancellationToken, WorkspaceSupervisor, YdocOpenState};
use dohc_engine_storage::{EngineStore, FaultPoint, NoFaults, StorageError};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::{path::Path, sync::Arc};

const WS: &str = "capture-recovery";
const FILE: &str = "note.txt";

fn input(text: &str, now_ms: i64) -> CaptureIngest {
    CaptureIngest {
        workspace_id: WS.into(),
        version_id: "main".into(),
        path: FILE.into(),
        text: text.into(),
        metadata_origin: "capture".into(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
        claim_foreign_head: true,
    }
}
async fn capture(actor: &ActorHandle, text: &str) {
    actor
        .capture_ingest(
            input(text, 10),
            LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture");
}
async fn open(actor: &ActorHandle) -> YdocOpenState {
    actor
        .ydoc_open_state(
            WS.into(),
            1,
            true,
            None,
            "main".into(),
            FILE.into(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("open")
}
async fn append(actor: &ActorHandle, key: &DocKey, bytes: Vec<u8>) {
    actor
        .ydoc_record_update(
            key.clone(),
            FILE.into(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            bytes,
            Some("writer".into()),
            Some(ChangeAttribution {
                actor_kind: ChangeActorKind::Agent,
                on_behalf_of: Some("owner".into()),
                depth: 0,
                run: None,
            }),
            None,
            false,
            None,
            None,
            2,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("append");
}
fn inspect<T>(db: &Path, f: impl FnOnce(&mut EngineStore) -> T) -> T {
    f(&mut EngineStore::open(db, 30).expect("inspect"))
}

use dohc_engine_runtime::actor::{RecoveryImport, RecoveryImportOutcome, RecoveryUpdate};
use dohc_engine_storage::hex_sha256;

fn checkpoint(state: &YdocOpenState, doc: &Ydoc, bytes: Vec<u8>) -> RecoveryImport {
    RecoveryImport {
        key: state.key.clone(),
        path: FILE.into(),
        expected_claim_id: state.lineage_claim_id.clone(),
        expected_state_vector_sha256: {
            let base = Ydoc::wire();
            base.apply(&state.initial_update).unwrap();
            hex_sha256(&base.encode_state_vector())
        },
        expected_disk_sha256: Some(hex_sha256(b"base\n")),
        admitted_base: state.initial_update.clone(),
        text: doc.plaintext_string(),
        updates: vec![RecoveryUpdate {
            request_id: "outage-update".into(),
            update: bytes,
            actor_origin_id: Some("writer".into()),
            attribution: Some(ChangeAttribution {
                actor_kind: ChangeActorKind::Agent,
                on_behalf_of: Some("owner".into()),
                depth: 0,
                run: None,
            }),
        }],
    }
}
async fn setup() -> (
    ScratchDir,
    std::path::PathBuf,
    WorkspaceSupervisor,
    ActorHandle,
    YdocOpenState,
    Ydoc,
    Vec<u8>,
) {
    let scratch = ScratchDir::new().unwrap();
    std::fs::write(scratch.path().join(FILE), "base\n").unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    capture(&actor, "base\n").await;
    let first = open(&actor).await;
    let seed = Ydoc::wire();
    seed.apply(&first.initial_update).unwrap();
    actor
        .ydoc_record_update(
            first.key.clone(),
            FILE.into(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            seed.plaintext_insert(0, "base\n"),
            None,
            None,
            first.lineage_claim_id.clone(),
            true,
            first.owner_seed_source.clone(),
            None,
            2,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
    actor
        .ydoc_settle(
            scratch.path().to_path_buf(),
            first.key.clone(),
            FILE.into(),
            ContentKind::Plaintext,
            first.lineage_claim_id.clone(),
            first.head_blob_sha256.clone(),
            "seed-session".into(),
            Arc::new(()),
            3,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .unwrap();
    let state = open(&actor).await;
    let doc = Ydoc::wire();
    doc.apply(&state.initial_update).unwrap();
    let bytes = doc.plaintext_insert(0, "outage\n");
    (scratch, db, supervisor, actor, state, doc, bytes)
}
async fn import(
    actor: &ActorHandle,
    root: &Path,
    input: RecoveryImport,
) -> Result<RecoveryImportOutcome, dohc_engine_runtime::RuntimeError> {
    actor
        .capture_import_recovery(root.to_path_buf(), input, 20, Arc::new(NoFaults))
        .await
        .map(|result| result.outcome)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unchanged_lineage_replays_once_and_preserves_original_author_and_request() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    assert_eq!(
        import(
            &actor,
            scratch.path(),
            checkpoint(&state, &doc, bytes.clone())
        )
        .await
        .unwrap(),
        RecoveryImportOutcome::Replayed
    );
    assert_eq!(
        import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
            .await
            .unwrap(),
        RecoveryImportOutcome::Replayed
    );
    assert!(
        actor
            .capture_recoveries(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).unwrap(),
        "base\n"
    );
    supervisor.close(&db).unwrap();
    inspect(&db, |store| {
        store
            .read_with(|c| {
                let key = &state.key;
                let actual = dohc_engine_collab::load_doc_in(c, key).unwrap();
                assert_eq!(actual.plaintext_string(), "outage\nbase\n");
                let count: i64 = c
                    .query_row(
                        "SELECT COUNT(*) FROM engine_requests WHERE request_id='outage-update'",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(count, 1);
                let authors = dohc_engine_collab::author_coverage::recovery_in(c, key)
                    .unwrap()
                    .json();
                assert!(authors.contains("writer"));
                Ok::<_, StorageError>(())
            })
            .unwrap()
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_capture_imports_without_merging_and_a_dismissal_never_returns() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    std::fs::write(scratch.path().join(FILE), "outside\n").unwrap();
    capture(&actor, "outside\n").await;
    let outcome = import(
        &actor,
        scratch.path(),
        checkpoint(&state, &doc, bytes.clone()),
    )
    .await
    .unwrap();
    let RecoveryImportOutcome::Imported { moment_id } = outcome else {
        panic!("must import")
    };
    let moment = actor
        .get_moment(WS.into(), moment_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(moment.before_text.as_deref(), Some("outage\nbase\n"));
    assert_eq!(moment.after_text.as_deref(), Some("outside\n"));
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).unwrap(),
        "outside\n"
    );
    let opened = open(&actor).await;
    assert_eq!(opened.head_blob_sha256, Some(hex_sha256(b"outside\n")));
    actor
        .clear_capture_recovery(WS.into(), moment_id.clone())
        .await
        .unwrap();
    assert_eq!(
        import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
            .await
            .unwrap(),
        RecoveryImportOutcome::Imported { moment_id }
    );
    assert!(
        actor
            .capture_recoveries(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn committed_update_is_covered_without_another_append_or_moment() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    append(&actor, &state.key, bytes.clone()).await;
    assert_eq!(
        import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
            .await
            .unwrap(),
        RecoveryImportOutcome::Covered
    );
    assert!(
        actor
            .capture_recoveries(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    supervisor.close(&db).unwrap();
}

fn pending_authors(db: &Path, key: &DocKey) -> String {
    inspect(db, |store| {
        store
            .read_with(|c| {
                c.query_row(
                    "SELECT pending_authors_json FROM ydoc_docs \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    rusqlite::params![key.workspace_id, key.version_id, key.object_id],
                    |row| row.get(0),
                )
                .map_err(StorageError::corrupt_public)
            })
            .unwrap()
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actorless_covered_import_preserves_pending_authors() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    append(&actor, &state.key, bytes.clone()).await;
    let before = pending_authors(&db, &state.key);
    assert_eq!(before, "[]");
    let mut input = checkpoint(&state, &doc, bytes);
    input.updates[0].actor_origin_id = None;
    input.updates[0].attribution = None;
    assert_eq!(
        import(&actor, scratch.path(), input).await.unwrap(),
        RecoveryImportOutcome::Covered
    );
    assert_eq!(pending_authors(&db, &state.key), before);
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actorless_replayed_import_retains_unattributed_coverage() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    assert_eq!(pending_authors(&db, &state.key), "[]");
    let mut input = checkpoint(&state, &doc, bytes);
    input.updates[0].actor_origin_id = None;
    input.updates[0].attribution = None;
    assert_eq!(
        import(&actor, scratch.path(), input).await.unwrap(),
        RecoveryImportOutcome::Replayed
    );
    assert_eq!(
        pending_authors(&db, &state.key),
        r#"[{"kind":"unattributed"}]"#
    );
    supervisor.close(&db).unwrap();
    inspect(&db, |store| {
        store
            .read_with(|c| {
                assert_eq!(
                    dohc_engine_collab::load_doc_in(c, &state.key)
                        .unwrap()
                        .plaintext_string(),
                    doc.plaintext_string()
                );
                Ok::<_, StorageError>(())
            })
            .unwrap();
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_crash_retry_keeps_one_moment_across_a_changed_head() {
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
        std::fs::write(scratch.path().join(FILE), "outside\n").unwrap();
        capture(&actor, "outside\n").await;
        let failed = actor
            .capture_import_recovery(
                scratch.path().to_path_buf(),
                checkpoint(&state, &doc, bytes.clone()),
                20,
                ScriptedFaults::crash_at(point),
            )
            .await;
        assert!(failed.is_err());
        supervisor.close(&db).unwrap();
        let actor = supervisor.open(&db, 21).unwrap().actor;
        capture(&actor, "later\n").await;
        import(
            &actor,
            scratch.path(),
            checkpoint(&state, &doc, bytes.clone()),
        )
        .await
        .unwrap();
        import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
            .await
            .unwrap();
        assert_eq!(actor.capture_recoveries(WS.into()).await.unwrap().len(), 1);
        supervisor.close(&db).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn racing_capture_and_import_leave_outside_head_and_one_recovery() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    std::fs::write(scratch.path().join(FILE), "outside\n").unwrap();
    let (_, result) = tokio::join!(
        capture(&actor, "outside\n"),
        import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
    );
    result.unwrap();
    let opened = open(&actor).await;
    assert_eq!(opened.head_blob_sha256, Some(hex_sha256(b"outside\n")));
    assert_eq!(actor.capture_recoveries(WS.into()).await.unwrap().len(), 1);
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_remote_human_is_a_typed_refusal_without_writing() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    let mut input = checkpoint(&state, &doc, bytes);
    input.updates[0].attribution.as_mut().unwrap().actor_kind = ChangeActorKind::Human;
    let error = import(&actor, scratch.path(), input).await.unwrap_err();
    assert!(matches!(
        error,
        dohc_engine_runtime::RuntimeError::RecoveryImportRefused {
            reason: "remote-human-author"
        }
    ));
    assert!(
        actor
            .capture_recoveries(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn renamed_object_recovers_at_its_current_path() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    actor
        .versioned_text_rename(
            dohc_engine_domain::RenameTextFile {
                workspace_id: WS.into(),
                version_id: "main".into(),
                from_path: FILE.into(),
                to_path: "renamed.txt".into(),
                moment_id: "rename".into(),
                request_id: None,
                metadata_origin: "human".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 12,
            },
            scratch.path().to_path_buf(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let result = import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
        .await
        .unwrap();
    assert!(matches!(
        result,
        RecoveryImportOutcome::Imported { .. } | RecoveryImportOutcome::Replayed
    ));
    for recovery in actor.capture_recoveries(WS.into()).await.unwrap() {
        assert_eq!(recovery.path, "renamed.txt");
    }
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).unwrap(),
        "base\n"
    );
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleted_object_imports_typing_into_history_without_restoring_file() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    delete(&actor, scratch.path()).await;
    let result = import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
        .await
        .unwrap();
    assert!(matches!(result, RecoveryImportOutcome::Imported { .. }));
    let rows = actor.capture_recoveries(WS.into()).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].object_id, state.key.object_id);
    assert!(rows[0].deleted);

    assert_eq!(
        std::fs::read_to_string(scratch.path().join(FILE)).unwrap(),
        "base\n"
    );
    supervisor.close(&db).unwrap();
    inspect(&db, |store| {
        store.read_with(|c| {
      let (operation, before, after, after_path, after_kind): (String,String,String,String,String) = c.query_row(
        "SELECT m.operation,b.text,a.text,m.payload_after_path,m.payload_after_content_kind FROM moments m JOIN blobs b ON b.sha256=m.payload_before_blob_sha256 JOIN blobs a ON a.sha256=m.payload_after_blob_sha256 WHERE m.metadata_origin='capture-recovery'", [], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
      assert_eq!(operation,"write"); assert_eq!(before,"outage\nbase\n"); assert_eq!(after,""); assert_eq!(after_path,FILE); assert_eq!(after_kind,"text");
      Ok::<_,StorageError>(())
    }).unwrap();
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn committed_without_ack_reconciles_originals_before_replaying_the_rest() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    let original = checkpoint(&state, &doc, bytes.clone());
    let first = &original.updates[0];
    let result = actor
        .ydoc_record_update(
            state.key.clone(),
            FILE.into(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            bytes.clone(),
            first.actor_origin_id.clone(),
            first.attribution.clone(),
            state.lineage_claim_id.clone(),
            false,
            None,
            Some(first.request_id.clone()),
            12,
            ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck),
            CancellationToken::new(),
            None,
        )
        .await;
    assert!(result.is_err());
    let later = doc.plaintext_insert(0, "later outage\n");
    let mut input = checkpoint(&state, &doc, bytes);
    input.updates.push(RecoveryUpdate {
        request_id: "later-original".into(),
        update: later,
        actor_origin_id: first.actor_origin_id.clone(),
        attribution: first.attribution.clone(),
    });
    supervisor.close(&db).unwrap();
    let actor = supervisor.open(&db, 15).unwrap().actor;
    assert_eq!(
        import(&actor, scratch.path(), input).await.unwrap(),
        RecoveryImportOutcome::Replayed
    );
    assert!(
        actor
            .capture_recoveries(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_refuses_an_owner_outbox_frozen_by_an_observed_binding() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    {
        let mut store = EngineStore::open(&db, 15).unwrap();
        store.write_with(&NoFaults,|tx|->Result<(),StorageError>{let sha=dohc_engine_storage::put_binary_blob(tx,b"fixture").unwrap();tx.execute("INSERT INTO ydoc_owner_bindings(workspace_id,main_version_id,object_id,lineage_claim_id,binding_json,relay_database_namespace,binding_revision,accepted_cursor,native_head_sequence,checkpoint_digest,max_pending_bytes,max_pending_age_ms) VALUES(?1,?2,?3,?4,'{}','relay',1,0,0,?4,1024,1000)",rusqlite::params![WS,"main",state.key.object_id,sha]).unwrap();Ok(())}).unwrap();
    }
    let error = import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        dohc_engine_runtime::RuntimeError::Collab(
            dohc_engine_collab::CollabError::OwnerOutboxFrozen
        )
    ));
    assert!(
        actor
            .capture_recoveries(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    supervisor.close(&db).unwrap();
}

async fn delete(actor: &ActorHandle, root: &Path) {
    actor
        .versioned_text_delete(
            dohc_engine_domain::DeleteTextFile {
                workspace_id: WS.into(),
                version_id: "main".into(),
                path: FILE.into(),
                moment_id: "delete".into(),
                request_id: None,
                metadata_origin: "human".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 12,
            },
            root.to_path_buf(),
            Arc::new(()),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleted_file_with_already_durable_typing_is_covered_without_a_notice() {
    let (scratch, db, supervisor, actor, state, doc, bytes) = setup().await;
    append(&actor, &state.key, bytes.clone()).await;
    actor
        .ydoc_settle(
            scratch.path().to_path_buf(),
            state.key.clone(),
            FILE.into(),
            ContentKind::Plaintext,
            state.lineage_claim_id.clone(),
            state.head_blob_sha256.clone(),
            "covered-delete-session".into(),
            Arc::new(()),
            12,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .unwrap();
    delete(&actor, scratch.path()).await;
    assert_eq!(
        import(
            &actor,
            scratch.path(),
            checkpoint(&state, &doc, bytes.clone())
        )
        .await
        .unwrap(),
        RecoveryImportOutcome::Covered
    );
    assert_eq!(
        import(&actor, scratch.path(), checkpoint(&state, &doc, bytes))
            .await
            .unwrap(),
        RecoveryImportOutcome::Covered
    );
    assert!(
        actor
            .capture_recoveries(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    supervisor.close(&db).unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reopening_a_session_before_import_and_replaying_its_original_is_deduplicated() {
    let (scratch, db, supervisor, _actor, state, doc, bytes) = setup().await;
    supervisor.close(&db).unwrap();
    let actor = supervisor.open(&db, 15).unwrap().actor;
    let reopened = open(&actor).await;
    assert_eq!(reopened.key, state.key);
    assert_eq!(
        import(
            &actor,
            scratch.path(),
            checkpoint(&state, &doc, bytes.clone())
        )
        .await
        .unwrap(),
        RecoveryImportOutcome::Replayed
    );
    let original = checkpoint(&state, &doc, bytes.clone());
    let update = &original.updates[0];
    let result = actor
        .ydoc_record_update(
            state.key.clone(),
            FILE.into(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            bytes,
            update.actor_origin_id.clone(),
            update.attribution.clone(),
            reopened.lineage_claim_id.clone(),
            false,
            None,
            Some(update.request_id.clone()),
            21,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
    assert!(result.outcome.deduped);
    assert!(
        actor
            .capture_recoveries(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    supervisor.close(&db).unwrap();
    inspect(&db, |store| {
        store
            .read_with(|c| {
                assert_eq!(
                    dohc_engine_collab::load_doc_in(c, &state.key)
                        .unwrap()
                        .plaintext_string(),
                    "outage\nbase\n"
                );
                Ok::<_, StorageError>(())
            })
            .unwrap();
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleted_recovery_requires_the_latest_ordinary_moment_to_be_a_delete() {
    let (_scratch, db, supervisor, _actor, state, _doc, _bytes) = setup().await;
    supervisor.close(&db).unwrap();
    inspect(&db, |store| {
        store
            .read_with(|c| {
                let tx = c.unchecked_transaction().unwrap();
                assert!(
                    !dohc_engine_domain::store::record_deleted_capture_recovery_in_tx(
                        &tx,
                        WS,
                        "main",
                        &state.key.object_id,
                        "typing",
                        "not-a-delete",
                        None,
                        30
                    )
                    .unwrap()
                );
                assert_eq!(
                    tx.query_row(
                        "SELECT COUNT(*) FROM moments WHERE moment_id='not-a-delete'",
                        [],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                    0
                );
                Ok::<_, StorageError>(())
            })
            .unwrap();
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn laned_outage_replay_does_not_attempt_origination_or_read_sync_control() {
    for lane in [1, 2] {
        let (scratch, db, supervisor, _actor, state, doc, bytes) = setup().await;
        supervisor.close(&db).unwrap();
        inspect(&db, |store| {
            store.write_with(&NoFaults, |tx| -> Result<(), StorageError> {
                tx.execute(
                    "UPDATE ydoc_docs SET file_export_lane=?4 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    rusqlite::params![WS, state.key.version_id, state.key.object_id, lane],
                ).unwrap();
                Ok(())
            }).unwrap();
        });
        let actor = supervisor.open(&db, 15).unwrap().actor;
        let control = rusqlite::Connection::open(&db).unwrap();
        // Open validates the schema first; any subsequent origination probe fails.
        control
            .execute_batch("ALTER TABLE sync_relay_push_state RENAME TO unavailable_sync_control")
            .unwrap();
        let replay = import(&actor, scratch.path(), checkpoint(&state, &doc, bytes)).await;
        control
            .execute_batch("ALTER TABLE unavailable_sync_control RENAME TO sync_relay_push_state")
            .unwrap();
        drop(control);
        assert_eq!(replay.unwrap(), RecoveryImportOutcome::Replayed,);
        supervisor.close(&db).unwrap();
        inspect(&db, |store| {
            store
                .read_with(|conn| {
                    let actual = dohc_engine_collab::load_doc_in(conn, &state.key).unwrap();
                    assert_eq!(actual.plaintext_string(), "outage\nbase\n");
                    let marker = dohc_engine_collab::read_marker_in(conn, &state.key)
                        .unwrap()
                        .unwrap();
                    assert!(marker.lineage_claim_id.is_none());
                    assert_eq!(
                        conn.query_row("SELECT file_export_lane FROM ydoc_docs", [], |row| row
                            .get::<_, i64>(0))
                            .unwrap(),
                        lane
                    );
                    assert_eq!(
                        conn.query_row("SELECT COUNT(*) FROM replication_log", [], |row| row
                            .get::<_, i64>(0))
                            .unwrap(),
                        0
                    );
                    Ok::<_, StorageError>(())
                })
                .unwrap();
        });
    }
}
