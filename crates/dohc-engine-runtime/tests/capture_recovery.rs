use dohc_engine_collab::{ContentKind, DocKey, LeaseRegistry, Regime, Ydoc};
use dohc_engine_domain::{
    CaptureIngest, ChangeActorKind, ChangeAttribution, RenameTextFile, VersionedTextStore,
    WriteText,
};
use dohc_engine_runtime::{ActorHandle, CancellationToken, WorkspaceSupervisor, YdocOpenState};
use dohc_engine_storage::{EngineStore, FaultPoint, NoFaults, StorageError};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path, try_make_dir_alias};
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
async fn dirty(actor: &ActorHandle) -> (YdocOpenState, Ydoc) {
    capture(actor, "base\n").await;
    let state = open(actor).await;
    let doc = Ydoc::wire();
    doc.apply(&state.initial_update).expect("initial state");
    append(actor, &state.key, doc.plaintext_insert(0, "human\n")).await;
    (state, doc)
}
fn inspect<T>(db: &Path, f: impl FnOnce(&mut EngineStore) -> T) -> T {
    f(&mut EngineStore::open(db, 30).expect("inspect"))
}

/// A new file at a renamed file's old path derives the renamed file's capture
/// id and is disambiguated. The renamed file keeps its typing, its path and
/// its History.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn new_file_at_a_renamed_path_leaves_the_renamed_document_alone() {
    const RENAMED: &str = "renamed.txt";
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let (state, doc) = dirty(&actor).await;
    let typing = doc.plaintext_string();
    supervisor.close(&db).unwrap();
    inspect(&db, |store| {
        VersionedTextStore::new(store)
            .rename_text_file(
                &RenameTextFile {
                    workspace_id: WS.into(),
                    version_id: "main".into(),
                    from_path: FILE.into(),
                    to_path: RENAMED.into(),
                    moment_id: "rename".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 20,
                },
                &NoFaults,
            )
            .expect("rename");
    });
    let actor = supervisor.open(&db, 3).unwrap().actor;
    let created = actor
        .capture_ingest(
            input("new\n", 30),
            LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture");
    assert_ne!(created.snapshot.object_id, state.key.object_id);
    assert_eq!(created.snapshot.path, FILE);
    assert!(
        actor
            .capture_recoveries(WS.into())
            .await
            .unwrap()
            .is_empty(),
        "the renamed file's typing is not the new file's History"
    );
    let renamed = actor
        .ydoc_open_state(
            WS.into(),
            1,
            true,
            None,
            "main".into(),
            RENAMED.into(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("open renamed");
    assert_eq!(renamed.key.object_id, state.key.object_id);
    let renamed_doc = Ydoc::wire();
    renamed_doc.apply(&renamed.initial_update).unwrap();
    assert_eq!(renamed_doc.plaintext_string(), typing);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_capture_keeps_both_sides_and_restore_clears_status() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let (_, doc) = dirty(&actor).await;
    let typing = doc.plaintext_string();
    supervisor.close(&db).unwrap();
    let actor = supervisor.open(&db, 3).unwrap().actor;
    capture(&actor, "outside\n").await;
    let recovery = actor.capture_recoveries(WS.into()).await.unwrap().remove(0);
    let moment = actor
        .get_moment(WS.into(), recovery.moment_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(moment.before_text.as_deref(), Some(typing.as_str()));
    assert_eq!(moment.after_text.as_deref(), Some("outside\n"));
    assert_eq!(
        moment.before_latest_moment_id, None,
        "typing was never a file head"
    );
    assert!(moment.author_json.unwrap().contains("writer"));
    let outside = actor
        .get_moment(WS.into(), recovery.capture_moment_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert!(
        outside.moment_order < moment.moment_order,
        "outside capture precedes the recovery change"
    );
    let reopened = open(&actor).await;
    let reopened_doc = Ydoc::wire();
    reopened_doc.apply(&reopened.initial_update).unwrap();
    assert_eq!(reopened_doc.plaintext_string(), "outside\n");
    let restored = actor
        .versioned_text_write_indexed_with_history(
            WriteText {
                workspace_id: WS.into(),
                version_id: "main".into(),
                object_id: recovery.object_id,
                path: FILE.into(),
                text: typing.clone(),
                moment_id: "restore-typing".into(),
                metadata_origin: "restore".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 20,
                request_id: None,
            },
            scratch.path().into(),
            Some(recovery.moment_id),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(restored.snapshot.text, typing);
    assert_eq!(restored.moment.before_text.as_deref(), Some("outside\n"));
    assert!(
        actor
            .capture_recoveries(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    supervisor.close(&db).unwrap();
    let actor = supervisor.open(&db, 30).unwrap().actor;
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
async fn crash_and_retry_commit_capture_and_recovery_together_once() {
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).unwrap().actor;
        dirty(&actor).await;
        assert!(
            actor
                .capture_ingest(
                    input("outside\n", 10),
                    LeaseRegistry::new(),
                    ScriptedFaults::crash_at(point),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
        supervisor.close(&db).unwrap();
        let actor = supervisor.open(&db, 15).unwrap().actor;
        capture(&actor, "outside\n").await;
        capture(&actor, "outside\n").await;
        assert_eq!(actor.capture_recoveries(WS.into()).await.unwrap().len(), 1);
        supervisor.close(&db).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dismissal_survives_restart_and_is_workspace_scoped() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    dirty(&actor).await;
    capture(&actor, "outside\n").await;
    let id = actor.capture_recoveries(WS.into()).await.unwrap()[0]
        .moment_id
        .clone();
    actor
        .clear_capture_recovery("another-workspace".into(), id.clone())
        .await
        .unwrap();
    assert_eq!(actor.capture_recoveries(WS.into()).await.unwrap().len(), 1);
    actor
        .clear_capture_recovery(WS.into(), id.clone())
        .await
        .unwrap();
    actor
        .clear_capture_recovery(WS.into(), id.clone())
        .await
        .unwrap();
    supervisor.close(&db).unwrap();
    let actor = supervisor.open(&db, 30).unwrap().actor;
    assert!(
        actor
            .capture_recoveries(WS.into())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        actor
            .get_moment(WS.into(), id)
            .await
            .unwrap()
            .unwrap()
            .metadata_origin,
        "capture-recovery-cleared"
    );
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn seed_and_accepted_prefix_coverage_skip_only_redundant_history() {
    for private_tail in [false, true] {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).unwrap().actor;
        let (state, doc) = dirty(&actor).await;
        let accepted = doc.plaintext_string();
        let vector = dohc_engine_storage::hex_sha256(&doc.encode_state_vector());
        supervisor.close(&db).unwrap();
        inspect(&db, |store| {
            dohc_engine_collab::claim_base(
                store,
                &state.key,
                ContentKind::Plaintext,
                &doc.encode_full_state(),
                &NoFaults,
                3,
            )
            .unwrap();
            VersionedTextStore::new(store)
                .write_text(
                    &WriteText {
                        workspace_id: WS.into(),
                        version_id: "main".into(),
                        object_id: state.key.object_id.clone(),
                        path: FILE.into(),
                        text: accepted,
                        moment_id: "accepted-prefix".into(),
                        metadata_origin: "ydoc".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 3,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
            store
                .write_with(&NoFaults, |tx| {
                    dohc_engine_collab::author_coverage::advance_accepted_prefix_in(
                        tx, &state.key, false,
                    )
                })
                .unwrap();
            store.write_with(&NoFaults, |tx| {
                // Persist the same accepted-prefix coverage receipt used by live settlement.
                tx.execute("INSERT INTO live_device_settlements (settlement_id,relay_database_namespace,workspace_id,
                    main_version_id,object_id,lineage_claim_id,previous_cursor,terminal_cursor,previous_ydoc_sequence,
                    local_ydoc_sequence,application_count,interval_digest,moment_id,markdown_digest,
                    source_state_vector_digest,binding_json,host_coordinate_json,recorded_at_ms)
                    SELECT 'accepted','relay',d.workspace_id,d.version_id,d.object_id,COALESCE(d.lineage_claim_id,?4),
                    0,1,0,d.head_update_seq,1,?4,m.moment_id,m.after_blob_sha256,?4,'{}','{}',3
                    FROM ydoc_docs d JOIN moments m ON m.workspace_id=d.workspace_id AND m.moment_id='accepted-prefix'
                    WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3",
                    rusqlite::params![WS,state.key.version_id,state.key.object_id,vector]).map_err(StorageError::persist_public)?;
                Ok::<_,StorageError>(())
            }).unwrap();
            if private_tail {
                let delta = doc.plaintext_insert(0, "private\n");
                store
                    .write_with(&NoFaults, |tx| {
                        dohc_engine_collab::record_update_in_tx(
                            tx,
                            &state.key,
                            &delta,
                            Some("private-writer"),
                            Some(&ChangeAttribution {
                                actor_kind: ChangeActorKind::Agent,
                                on_behalf_of: Some("owner".into()),
                                depth: 0,
                                run: None,
                            }),
                            4,
                        )
                    })
                    .unwrap();
            }
        });
        let actor = supervisor.open(&db, 4).unwrap().actor;
        capture(&actor, "outside\n").await;
        assert_eq!(
            actor.capture_recoveries(WS.into()).await.unwrap().len(),
            usize::from(private_tail)
        );
        supervisor.close(&db).unwrap();
    }
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    capture(&actor, "base\n").await;
    open(&actor).await;
    capture(&actor, "outside\n").await;
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
async fn recovery_after_pruning_and_reenrollment_never_exports_private_typing() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    dirty(&actor).await;
    capture(&actor, "outside\n").await;
    let id = actor.capture_recoveries(WS.into()).await.unwrap()[0]
        .moment_id
        .clone();
    let state = open(&actor).await;
    actor
        .ydoc_close_session(
            state.key.clone(),
            20,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    supervisor.close(&db).unwrap();
    inspect(&db, |store| {
        store.write_with(&NoFaults,|tx| {
            let state_rows:i64=tx.query_row("SELECT (SELECT COUNT(*) FROM ydoc_updates)+(SELECT COUNT(*) FROM ydoc_snapshots)",[],|row|row.get(0)).map_err(StorageError::persist_public)?;
            assert_eq!(state_rows,0,"local-only close actually prunes the lineage");
            tx.execute("INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES (?1,'local','epoch','stream',1)",[WS]).map_err(StorageError::persist_public)?;
            Ok::<_,StorageError>(())
        }).unwrap();
        dohc_engine_sync::commit_relay_cursor(
            store,
            WS,
            &dohc_engine_sync::RelayCursor {
                cursor: 0,
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                bootstrap_complete: true,
                settlement_report_id: None,
                ordinary_pull: None,
            },
            &NoFaults,
            &LeaseRegistry::new(),
            20,
        )
        .unwrap();
        let exported:i64=store.read_with(|conn| conn.query_row("SELECT COUNT(*) FROM replication_log WHERE op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?1",[id.clone()],|row| row.get(0))).unwrap();
        assert_eq!(exported, 0);
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_sync::journal_moment_append_in_tx(tx, WS, &id)
            })
            .unwrap();
        let private:i64=store.read_with(|conn| conn.query_row("SELECT COUNT(*) FROM replication_log WHERE payload_json LIKE '%human%' OR payload_json LIKE '%writer%'",[],|row|row.get(0))).unwrap();
        assert_eq!(private, 0);
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn directory_blocked_or_cancelled_settlement_needs_recovery_only_for_later_typing() {
    for cancelled in [false, true] {
        for later_typing in [false, true] {
            let scratch = ScratchDir::new().unwrap();
            let elsewhere = ScratchDir::new().unwrap();
            let db = engine_db_path(&scratch).unwrap();
            let supervisor = WorkspaceSupervisor::new();
            let actor = supervisor.open(&db, 1).unwrap().actor;
            let (state, doc) = dirty(&actor).await;
            let typing = doc.plaintext_string();
            let file = scratch.path().join(FILE);
            std::fs::write(&file, "base\n").unwrap();
            assert!(
                actor
                    .ydoc_settle(
                        scratch.path().into(),
                        state.key.clone(),
                        FILE.into(),
                        ContentKind::Plaintext,
                        state.lineage_claim_id.clone(),
                        state.head_blob_sha256.clone(),
                        "blocked".into(),
                        Arc::new(()),
                        3,
                        ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit),
                        CancellationToken::new(),
                        None,
                    
                        None,
                    )
                    .await
                    .is_err()
            );
            std::fs::remove_file(&file).unwrap();
            assert!(try_make_dir_alias(elsewhere.path(), &file).unwrap());
            actor
                .materialize_replay_pending(scratch.path().into(), WS.into(), 4)
                .await
                .unwrap();
            let moment = inspect(&db, |store| {
                let row: (String, String, Option<i64>) = store.read_with(|conn| conn.query_row(
                    "SELECT m.moment_id,j.status,d.settle_prior_update_seq FROM ydoc_docs d
                     JOIN snapshots s USING (workspace_id,version_id,object_id)
                     JOIN moments m ON m.workspace_id=s.workspace_id AND m.moment_id=s.latest_moment_id
                     JOIN materialization_jobs j ON j.job_id='ydoc-mat_'||m.moment_id
                     WHERE d.workspace_id=?1 AND d.object_id=?2",
                    rusqlite::params![WS,state.key.object_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
                )).unwrap();
                assert_eq!(row.1, "pending");
                assert!(row.2.is_some());
                if cancelled {
                    store.write_with(&NoFaults, |tx| tx.execute(
                        "UPDATE materialization_jobs SET status='cancelled',completed_at_ms=5 WHERE job_id='ydoc-mat_'||?1",
                        [&row.0],
                    ).map_err(StorageError::persist_public)).unwrap();
                }
                row.0
            });
            #[cfg(windows)]
            std::fs::remove_dir(&file).unwrap();
            #[cfg(not(windows))]
            std::fs::remove_file(&file).unwrap();
            if later_typing {
                append(&actor, &state.key, doc.plaintext_insert(0, "later\n")).await;
            }
            std::fs::write(&file, "outside\n").unwrap();
            capture(&actor, "outside\n").await;
            let recoveries = actor.capture_recoveries(WS.into()).await.unwrap();
            assert_eq!(recoveries.len(), usize::from(later_typing));
            let committed = actor
                .get_moment(WS.into(), moment.clone())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(committed.after_text.as_deref(), Some(typing.as_str()));
            if let Some(recovery) = recoveries.first() {
                let recovered = actor
                    .get_moment(WS.into(), recovery.moment_id.clone())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    recovered.before_text.as_deref(),
                    Some(doc.plaintext_string().as_str())
                );
            }
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "outside\n");
            inspect(&db, |store| {
                let status: String = store
                    .read_with(|conn| {
                        conn.query_row(
                            "SELECT status FROM materialization_jobs WHERE job_id='ydoc-mat_'||?1",
                            [&moment],
                            |row| row.get(0),
                        )
                    })
                    .unwrap();
                assert_eq!(status, "cancelled");
            });
            supervisor.close(&db).unwrap();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn committed_live_settlement_generation_skips_redundant_recovery() {
    for pending in [false, true] {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).unwrap().actor;
        let (state, doc) = dirty(&actor).await;
        let typing = doc.plaintext_string();
        supervisor.close(&db).unwrap();
        inspect(&db, |store| {
            dohc_engine_collab::claim_base(
                store,
                &state.key,
                ContentKind::Plaintext,
                &doc.encode_full_state(),
                &NoFaults,
                3,
            )
            .unwrap();
            // Native live settlement uses a per-document generation. Its
            // committed History head has a separate workspace moment order.
            let dohc_engine_storage::TxnOutcome::Committed(settled) =
                dohc_engine_collab::settle(store, &state.key, FILE, &NoFaults, 3).unwrap()
            else {
                panic!("settlement must commit");
            };
            let result = VersionedTextStore::new(store)
                .write_text(
                    &WriteText {
                        workspace_id: WS.into(),
                        version_id: "main".into(),
                        object_id: state.key.object_id.clone(),
                        path: FILE.into(),
                        text: typing.clone(),
                        moment_id: "committed-live-settlement".into(),
                        metadata_origin: "ydoc".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 3,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
            store
                .write_with(&NoFaults, |tx| {
                    dohc_engine_collab::author_coverage::advance_in(tx, &state.key, false)
                })
                .unwrap();
            std::fs::write(scratch.path().join(FILE), &typing).unwrap();
            if !pending {
                store
                    .mark_materialization_complete(&settled.job_id, 4)
                    .unwrap();
            }
            let generation = store
                .load_materialization_job(&settled.job_id)
                .unwrap()
                .unwrap()
                .target_generation;
            let settle_seq: i64 = store.read_with(|conn| conn.query_row(
                "SELECT settle_seq FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                rusqlite::params![WS, state.key.version_id, state.key.object_id], |row| row.get(0),
            )).unwrap();
            assert_eq!(settle_seq, generation);
            assert_ne!(
                generation, result.moment.moment_order,
                "the test must distinguish document generation from moment order"
            );
            let audits: i64 = store
                .read_with(|conn| {
                    conn.query_row("SELECT COUNT(*) FROM live_device_settlements", [], |row| {
                        row.get(0)
                    })
                })
                .unwrap();
            assert_eq!(
                audits, 0,
                "accepted-prefix coverage must not hide this regression"
            );
        });
        let actor = supervisor.open(&db, 5).unwrap().actor;
        capture(&actor, "outside\n").await;
        assert!(
            actor
                .capture_recoveries(WS.into())
                .await
                .unwrap()
                .is_empty()
        );
        supervisor.close(&db).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unrelated_identical_file_moment_does_not_cover_native_updates() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    let (state, doc) = dirty(&actor).await;
    supervisor.close(&db).unwrap();
    inspect(&db, |store| {
        VersionedTextStore::new(store)
            .write_text(
                &WriteText {
                    workspace_id: WS.into(),
                    version_id: "main".into(),
                    object_id: state.key.object_id,
                    path: FILE.into(),
                    text: doc.plaintext_string(),
                    moment_id: "unrelated-file-write".into(),
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 3,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
    });
    let actor = supervisor.open(&db, 4).unwrap().actor;
    capture(&actor, "outside\n").await;
    assert_eq!(actor.capture_recoveries(WS.into()).await.unwrap().len(), 1);
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lane_candidate_and_bootstrap_rule_keep_recovery_owner_local() {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).unwrap().actor;
    dirty(&actor).await;
    capture(&actor, "outside\n").await;
    let recovery = actor.capture_recoveries(WS.into()).await.unwrap().remove(0);
    supervisor.close(&db).unwrap();
    inspect(&db, |store| {
        store.read_with(|conn| {
        // #1711 is unmerged. These are its current-head and bootstrap predicates,
        // with the required named exclusion; no file_export_lane exists on main.
        let candidate:String=conn.query_row(concat!("SELECT m.moment_id FROM moments m JOIN snapshots s USING(workspace_id,version_id,object_id)
            WHERE m.workspace_id=?1 AND m.object_id=?2 AND s.latest_moment_id=m.moment_id AND s.content_kind='text'
            AND m.payload_after_blob_sha256=s.blob_sha256 AND m.payload_after_path=s.path AND ",
            dohc_engine_domain::exclude_capture_recovery_sql!("m")," ORDER BY m.moment_order DESC LIMIT 1"),rusqlite::params![WS,recovery.object_id],|row|row.get(0))?;
        assert_eq!(candidate,recovery.capture_moment_id);
        let bootstrap:String=conn.query_row(concat!("SELECT m.moment_id FROM moments m WHERE m.workspace_id=?1 AND ",
            dohc_engine_domain::exclude_capture_recovery_sql!("m")," ORDER BY m.moment_order LIMIT 1"),[WS],|row|row.get(0))?;
        assert_ne!(bootstrap,recovery.moment_id);
        let excluded:i64=conn.query_row(concat!("SELECT COUNT(*) FROM moments m WHERE m.moment_id=?1 AND ",
            dohc_engine_domain::exclude_capture_recovery_sql!("m")),[recovery.moment_id.clone()],|row|row.get(0))?;
        assert_eq!(excluded,0);
        Ok::<_,rusqlite::Error>(())
    }).unwrap()
    });
}

struct RootGuard;
impl dohc_engine_runtime::WorkspaceRootGuard for RootGuard {
    fn validate(&self, root: &Path) -> Result<(), dohc_engine_runtime::RuntimeError> {
        assert!(root.is_dir());
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_orders_recovery_and_rolls_back_failed_items() {
    // An unchanged first file is deduped and reserves no order, yet its
    // differing typing still needs a History recovery and a recovered copy.
    for (unchanged_bytes, partial_failure) in
        [(false, false), (false, true), (true, false), (true, true)]
    {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let supervisor = WorkspaceSupervisor::new();
        let mut actor = supervisor.open(&db, 1).unwrap().actor;
        let (_, doc) = dirty(&actor).await;
        let typing = doc.plaintext_string();
        let first = if unchanged_bytes {
            supervisor.close(&db).unwrap();
            let text = inspect(&db, |store| {
                store
                    .read_with(|conn| {
                        conn.query_row(
                            "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
                             WHERE s.workspace_id=?1 AND s.path=?2",
                            [WS, FILE],
                            |row| row.get::<_, String>(0),
                        )
                    })
                    .unwrap()
            });
            actor = supervisor.open(&db, 1).unwrap().actor;
            text
        } else {
            "outside\n".to_owned()
        };
        assert_ne!(first, typing, "the typing differs from the first file");
        let mut sibling = input("sibling", 11);
        sibling.path = "sibling.txt".into();
        let mut invalid = input("refused", 11);
        invalid.path = "../outside.txt".into();
        let mut inputs = vec![input(&first, 10)];
        if partial_failure {
            inputs.push(invalid);
        }
        inputs.push(sibling);
        let root = scratch.path().to_path_buf();
        let policy = Arc::new(dohc_engine_runtime::search::read_engine_search_policy(
            &root,
        ));
        let other = actor.clone();
        let results = std::thread::spawn(move || {
            other.capture_ingest_batch_blocking(
                inputs,
                policy,
                LeaseRegistry::new(),
                Arc::new(NoFaults),
                root,
                Arc::new(RootGuard),
            )
        })
        .join()
        .unwrap()
        .unwrap();
        assert!(results[0].is_ok());
        assert!(results.last().unwrap().is_ok());
        if partial_failure {
            assert!(results[1].is_err());
        }
        let recovery = actor.capture_recoveries(WS.into()).await.unwrap().remove(0);
        let order = actor
            .get_moment(WS.into(), recovery.moment_id)
            .await
            .unwrap()
            .unwrap()
            .moment_order;
        let first_result = results[0].as_ref().unwrap();
        assert_eq!(first_result.deduped, unchanged_bytes);
        if unchanged_bytes {
            // The deduped head keeps its earlier moment. Its recovery takes
            // the next order after the current high-water mark.
            assert!(first_result.moment.moment_order < order);
        } else {
            assert_eq!(
                first_result.moment.moment_order + 1,
                order,
                "the capture's History recovery follows it"
            );
        }
        assert_eq!(
            results
                .last()
                .unwrap()
                .as_ref()
                .unwrap()
                .moment
                .moment_order,
            order + 2,
            "the recovered copy sits between the recovery and the next file"
        );
        supervisor.close(&db).unwrap();
        let copies = inspect(&db, |store| {
            store
                .read_with(|conn| {
                    let mut statement = conn.prepare(
                        "SELECT s.path, b.text, m.moment_order FROM snapshots s \
                         JOIN blobs b ON b.sha256=s.blob_sha256 \
                         JOIN moments m ON m.workspace_id=s.workspace_id \
                                      AND m.moment_id=s.latest_moment_id \
                         WHERE s.workspace_id=?1 AND s.path NOT IN (?2, 'sibling.txt')",
                    )?;
                    let rows = statement.query_map([WS, FILE], |row| {
                        Ok::<(String, String, i64), _>((row.get(0)?, row.get(1)?, row.get(2)?))
                    })?;
                    rows.collect::<Result<Vec<_>, _>>()
                })
                .unwrap()
        });
        assert_eq!(copies.len(), 1, "exactly one recovered copy: {copies:?}");
        assert_eq!(copies[0].1, typing, "the copy keeps the unsettled typing");
        assert_eq!(copies[0].2, order + 1);
    }
}
