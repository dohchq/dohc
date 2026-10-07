use dohc_engine_collab::{ContentKind, DocKey, LeaseRegistry, Regime, Ydoc};
use dohc_engine_domain::{
    CaptureIngest, ChangeActorKind, ChangeAttribution, VersionedTextStore, WriteText,
};
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
            WHERE m.workspace_id=?1 AND s.latest_moment_id=m.moment_id AND s.content_kind='text'
            AND m.payload_after_blob_sha256=s.blob_sha256 AND m.payload_after_path=s.path AND ",
            dohc_engine_domain::exclude_capture_recovery_sql!("m")," ORDER BY m.moment_order DESC LIMIT 1"),[WS],|row|row.get(0))?;
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
    for partial_failure in [false, true] {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).unwrap().actor;
        dirty(&actor).await;
        let mut sibling = input("sibling", 11);
        sibling.path = "sibling.txt".into();
        let mut invalid = input("refused", 11);
        invalid.path = "../outside.txt".into();
        let mut inputs = vec![input("outside\n", 10)];
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
        assert_eq!(
            results
                .last()
                .unwrap()
                .as_ref()
                .unwrap()
                .moment
                .moment_order,
            order + 1
        );
        supervisor.close(&db).unwrap();
    }
}
