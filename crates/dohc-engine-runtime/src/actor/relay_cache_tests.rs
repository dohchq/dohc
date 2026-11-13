use super::*;
use dohc_engine_collab::{
    CacheStats, ContentKind, DocKey, LocalAppend, MarkerCreation, Regime, Ydoc, claim_base,
    load_doc_in, read_marker, record_local_update,
};

fn document_fixture(
    enrolled: bool,
    claimed: bool,
    size: usize,
) -> (ScratchDir, std::path::PathBuf, Ydoc) {
    let (scratch, path, mut store) = fixture_with_files(1);
    if !enrolled {
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("DELETE FROM sync_relay_push_state", [])
                    .map_err(StorageError::persist_public)?;
                Ok::<_, StorageError>(())
            })
            .unwrap();
    }
    let producer = Ydoc::wire();
    let seed = producer.plaintext_insert(0, &"a".repeat(size));
    if claimed {
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO file_objects (workspace_id,object_id,created_at_ms) VALUES ('ws','doc',1000)", []).map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        }).unwrap();
        claim_base(
            &mut store,
            &key(),
            ContentKind::Plaintext,
            &seed,
            &NoFaults,
            1000,
        )
        .unwrap();
    } else {
        record_local_update(
            &mut store,
            &mut WriterDocCache::new(),
            &key(),
            &seed,
            LocalAppend {
                marker: Some(MarkerCreation {
                    content_kind: ContentKind::Plaintext,
                    regime: Regime::LocalOnly,
                    path: Some("doc.md"),
                }),
                ensure_parent_row: true,
                ..LocalAppend::default()
            },
            &NoFaults,
            1000,
            |_, _, _| Ok(()),
        )
        .unwrap();
    }
    drop(store);
    (scratch, path, producer)
}

fn key() -> DocKey {
    DocKey::new(WORKSPACE, "main", "doc").unwrap()
}

async fn append(actor: &ActorHandle, bytes: Vec<u8>) -> CacheStats {
    actor
        .run(move |store, cache| {
            record_local_update(
                store,
                cache,
                &key(),
                &bytes,
                LocalAppend::default(),
                &NoFaults,
                1100,
                |tx, _, sha| {
                    let claim: Option<String> = tx
                        .query_row(
                            "SELECT lineage_claim_id FROM ydoc_docs WHERE object_id='doc'",
                            [],
                            |row| row.get(0),
                        )
                        .map_err(StorageError::persist_public)?;
                    if let Some(claim) = claim {
                        dohc_engine_sync::journal_local_op_in_tx(
                            tx,
                            WORKSPACE,
                            "ydoc.update",
                            &dohc_engine_sync::ydoc_update_payload(
                                &key(),
                                "doc.md",
                                ContentKind::Plaintext,
                                sha,
                                &claim,
                                None,
                                None,
                                false,
                            ),
                            1100,
                        )
                        .map_err(|error| {
                            dohc_engine_collab::CollabError::Corrupt {
                                reason: error.to_string(),
                            }
                        })?;
                    }
                    Ok(())
                },
            )?;
            let fresh = store
                .read_with(|conn| load_doc_in(conn, &key()))?
                .encode_full_state();
            assert_eq!(cache.doc_full_state_for_test(&key()).unwrap(), fresh);
            Ok(cache.stats())
        })
        .await
        .unwrap()
}

async fn push(actor: &ActorHandle) {
    let relay = Arc::new(Mutex::new(Relay::default()));
    actor
        .relay_with_io(
            false,
            push_operation(),
            LeaseRegistry::default(),
            CancellationToken::new(),
            None,
            move |request, _| {
                let response = match &request {
                    RelayIoRequest::Push(request) if request.ops.is_empty() => {
                        RelayIoResponse::Push(PushResponse {
                            registered_references: Vec::new(),
                            settlement_refusals: Vec::new(),
                            hosted_refusals: Vec::new(),
                            redundant_recoveries: Vec::new(),
                            accepted: 0,
                            inserted: 0,
                            skipped: 0,
                            current_max_origin_seq: -1,
                        })
                    }
                    // Enrollment may journal a Y.Doc base, whose blob is already local.
                    RelayIoRequest::BlobsHave(_) => RelayIoResponse::BlobsHave(BlobHaveResponse {
                        missing: Vec::new(),
                    }),
                    RelayIoRequest::Push(request) => RelayIoResponse::Push(PushResponse {
                        registered_references: Vec::new(),
                        settlement_refusals: Vec::new(),
                        hosted_refusals: Vec::new(),
                        redundant_recoveries: Vec::new(),
                        accepted: request.ops.len(),
                        inserted: request.ops.len(),
                        skipped: 0,
                        current_max_origin_seq: request.ops.last().unwrap().origin_seq,
                    }),
                    _ => relay.lock().unwrap().answer(&request),
                };
                async move { Ok(response) }
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn pull_mixing_own_echo_and_foreign_edit_invalidates_writer_cache() {
    let (_scratch, path, producer) = document_fixture(true, true, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    full_cycle(&actor, Arc::new(Mutex::new(Vec::new()))).await;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    push(&actor).await;
    let foreign_bytes = producer.plaintext_insert(101, "remote");
    let (own_echo, foreign) = actor
        .run(move |store, _| {
            let own_echo = dohc_engine_sync::list_replication_ops(store, WORKSPACE, ORIGIN, 0, 1)
                .map(|mut ops| {
                    let mut op = ops.remove(0);
                    op.relay_seq = Some(2);
                    op
                })
                .map_err(RuntimeError::Sync)?;
            let sha = store
                .put_binary_blob(&foreign_bytes)
                .map_err(RuntimeError::Storage)?;
            let claim: String = store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT lineage_claim_id FROM ydoc_docs WHERE workspace_id=?1 AND version_id='main' AND object_id='doc'",
                        [WORKSPACE],
                        |row| row.get(0),
                    )
                })
                .map_err(|error| RuntimeError::Storage(StorageError::corrupt_public(error)))?;
            let foreign = dohc_engine_sync::ReplicationEnvelope {
                settlement_admission: None,
                admitted_author_snapshot: None,
                workspace_id: WORKSPACE.into(),
                origin_id: "peer".into(),
                origin_seq: 0,
                op_kind: "ydoc.update".into(),
                payload: dohc_engine_sync::ydoc_update_payload(
                    &key(),
                    "doc.md",
                    ContentKind::Plaintext,
                    &sha,
                    &claim,
                    None,
                    None,
                    false,
                ),
                recorded_at_ms: 1200,
                relay_seq: Some(3),
            };
            Ok::<_, RuntimeError>((own_echo, foreign))
        })
        .await
        .unwrap();
    let outcome = actor
        .pull_with_io_for_test(
            false,
            (WORKSPACE.into(), 1200),
            LeaseRegistry::default(),
            CancellationToken::new(),
            None,
            move |request, _| {
                let own_echo = own_echo.clone();
                let foreign = foreign.clone();
                async move {
                    match request {
                        RelayIoRequest::Pull(_) => Ok(RelayIoResponse::Pull(PullResponse {
                            work_references: Vec::new(),
                            next_reference_after: None,
                            reference_has_more: false,
                            ops: vec![own_echo, foreign],
                            next_cursor: 3,
                            has_more: false,
                        })),
                        other => panic!("unexpected pull request: {other:?}"),
                    }
                }
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        outcome,
        RelayOperationOutcome::Sync(SyncPassOutcome::Complete {
            applied: 1,
            skipped: 1,
            ..
        })
    ));
    assert!(actor.ydoc_cache_stats_for_test().await.unwrap().removes > before.removes);
    let after_pull = actor.ydoc_cache_stats_for_test().await.unwrap();
    let after = append(&actor, producer.plaintext_insert(107, "c")).await;
    assert_eq!(after.misses, after_pull.misses + 1);
    supervisor.close(&path).unwrap();
}

#[tokio::test]
async fn ordinary_remote_between_pushes_matches_fresh_replay() {
    let (_scratch, path, producer) = document_fixture(true, true, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    append(&actor, producer.plaintext_insert(100, "b")).await;
    push(&actor).await;
    let remote = dohc_engine_collab::RemoteUpdate {
        origin_id: "peer".into(),
        origin_seq: 0,
        bytes: producer.plaintext_insert(101, "remote"),
    };
    actor
        .run(move |store, cache| {
            dohc_engine_collab::apply_remote_update(
                store,
                cache,
                &key(),
                &remote,
                None,
                None,
                &NoFaults,
                1200,
            )?;
            Ok(())
        })
        .await
        .unwrap();
    push(&actor).await;
    let bytes = producer.plaintext_insert(107, "c");
    actor
        .run(move |store, cache| {
            record_local_update(
                store,
                cache,
                &key(),
                &bytes,
                LocalAppend::default(),
                &NoFaults,
                1300,
                |_, _, _| Ok(()),
            )?;
            let fresh = store
                .read_with(|conn| load_doc_in(conn, &key()))?
                .encode_full_state();
            assert_eq!(cache.doc_full_state_for_test(&key()).unwrap(), fresh);
            Ok(())
        })
        .await
        .unwrap();
    supervisor.close(&path).unwrap();
}

pub(crate) struct CursorFaults;
thread_local! { static CRASH_CURSOR: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
impl dohc_engine_storage::FaultInjector for CursorFaults {
    fn poll(&self, point: dohc_engine_storage::FaultPoint) -> dohc_engine_storage::FaultAction {
        if point == dohc_engine_storage::FaultPoint::StorageAfterCommitBeforeAck
            && CRASH_CURSOR.replace(false)
        {
            dohc_engine_storage::FaultAction::Crash
        } else {
            dohc_engine_storage::FaultAction::Continue
        }
    }
}
fn cycle_cursor() -> RelayCursor {
    RelayCursor {
        cursor: 0,
        replication_epoch: "epoch".into(),
        stream_identity: "stream".into(),
        bootstrap_complete: true,
        settlement_report_id: None,
        ordinary_pull: None,
    }
}
async fn commit_cycle(
    actor: &ActorHandle,
    cursor: RelayCursor,
) -> Result<RelayOperationOutcome, RuntimeError> {
    actor
        .relay_with_io(
            false,
            RelayOperation::CommitCursor {
                workspace_id: WORKSPACE.into(),
                cursor,
                now_ms: 2100,
            },
            LeaseRegistry::default(),
            CancellationToken::new(),
            None,
            |_, _| async { panic!("cursor I/O") },
        )
        .await
}

async fn cycle_push(actor: &ActorHandle, state: Arc<Mutex<Vec<ReplicationEnvelope>>>) {
    loop {
        let before = state.lock().unwrap().len();
        let rows = state.clone();
        actor
            .relay_with_io(
                false,
                push_operation(),
                LeaseRegistry::default(),
                CancellationToken::new(),
                None,
                move |request, _| {
                    let state = rows.clone();
                    async move {
                        match request {
                            RelayIoRequest::BlobsHave(_) => {
                                Ok(RelayIoResponse::BlobsHave(BlobHaveResponse {
                                    missing: Vec::new(),
                                }))
                            }
                            RelayIoRequest::UploadBlob(_) => Ok(RelayIoResponse::UploadBlob),
                            RelayIoRequest::Push(request) => {
                                let n = request.ops.len();
                                let max = request
                                    .ops
                                    .last()
                                    .map_or(request.after_seq, |op| op.origin_seq);
                                let mut state = state.lock().unwrap();
                                for mut op in request.ops {
                                    op.relay_seq = Some(state.len() as i64 + 1);
                                    state.push(op);
                                }
                                Ok(RelayIoResponse::Push(PushResponse {
                                    registered_references: Vec::new(),
                                    settlement_refusals: Vec::new(),
                                    hosted_refusals: Vec::new(),
                                    redundant_recoveries: Vec::new(),
                                    accepted: n,
                                    inserted: n,
                                    skipped: 0,
                                    current_max_origin_seq: max,
                                }))
                            }
                            other => panic!("unexpected push {other:?}"),
                        }
                    }
                },
            )
            .await
            .unwrap();
        if state.lock().unwrap().len() == before {
            break;
        }
    }
}

async fn full_cycle(actor: &ActorHandle, state: Arc<Mutex<Vec<ReplicationEnvelope>>>) {
    cycle_push(actor, state.clone()).await;

    loop {
        let rows = state.clone();
        let outcome = actor
            .pull_with_io_for_test(
                false,
                (WORKSPACE.into(), 2000),
                LeaseRegistry::default(),
                CancellationToken::new(),
                None,
                move |request, _| {
                    let rows = rows.clone();
                    async move {
                        match request {
                            RelayIoRequest::Pull(pull) => {
                                let rows = rows.lock().unwrap();
                                let ops = rows
                                    .iter()
                                    .filter(|op| op.relay_seq.unwrap() > pull.cursor)
                                    .take(pull.limit)
                                    .cloned()
                                    .collect::<Vec<_>>();
                                let next = ops
                                    .last()
                                    .and_then(|op| op.relay_seq)
                                    .unwrap_or(pull.cursor);
                                let has_more =
                                    rows.last().is_some_and(|op| op.relay_seq.unwrap() > next);
                                Ok(RelayIoResponse::Pull(PullResponse {
                                    work_references: Vec::new(),
                                    next_reference_after: None,
                                    reference_has_more: false,
                                    ops,
                                    next_cursor: next,
                                    has_more,
                                }))
                            }
                            other => panic!("unexpected pull {other:?}"),
                        }
                    }
                },
            )
            .await
            .unwrap();
        let (cursor, more) = match outcome {
            RelayOperationOutcome::Sync(SyncPassOutcome::Complete {
                applied: 0,
                pending_cursor: Some(cursor),
                has_more,
                ..
            }) => (cursor, has_more),
            other => panic!("unexpected outcome {other:?}"),
        };
        actor
            .relay_with_io(
                false,
                RelayOperation::CommitCursor {
                    workspace_id: WORKSPACE.into(),
                    cursor,
                    now_ms: 2000,
                },
                LeaseRegistry::default(),
                CancellationToken::new(),
                None,
                |_, _| async { panic!("cursor I/O") },
            )
            .await
            .unwrap();
        if !more {
            break;
        }
    }
}

async fn settle_for_cycle(actor: &ActorHandle, root: std::path::PathBuf) {
    use rusqlite::OptionalExtension;
    let (claim,head)=actor.run(|store,_| {
        let claim=read_marker(store,&key())?.unwrap().lineage_claim_id;
        let head=store.read_with(|conn| conn.query_row("SELECT blob_sha256 FROM snapshots WHERE workspace_id='ws' AND version_id='main' AND object_id='doc'",[],|row|row.get::<_,String>(0)).optional().map_err(StorageError::persist_public))?;
        Ok((claim,head))
    }).await.unwrap();
    let settled = actor
        .ydoc_settle(
            root,
            key(),
            "doc.md".into(),
            ContentKind::Plaintext,
            claim,
            head,
            "round6".into(),
            Arc::new(()),
            1900,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .unwrap()
        .settled()
        .unwrap();
    assert!(settled.materialized);
    // Publish each settled moment once, including a no-op timer retry.
    actor
        .run(move |store, _| {
            store.write_with(&NoFaults, |tx| {
                let published: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM replication_log WHERE workspace_id=?1 AND imported=0 AND op_kind='moment.append' AND json_extract(payload_json,'$.momentId')=?2)",rusqlite::params![WORKSPACE,settled.moment_id],|row|row.get(0)).map_err(|error| dohc_engine_sync::SyncError::Storage(StorageError::persist_public(error)))?;
                if !published { dohc_engine_sync::journal_moment_append_in_tx(tx, WORKSPACE, &settled.moment_id)?; }
                Ok::<_,dohc_engine_sync::SyncError>(())
            })?;
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn full_own_settlement_cycle_keeps_writer_cache() {
    let (scratch, path, producer) = document_fixture(true, false, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    commit_cycle(&actor, cycle_cursor()).await.unwrap();
    let state = Arc::new(Mutex::new(Vec::new()));
    full_cycle(&actor, state.clone()).await;
    append(&actor, producer.plaintext_insert(100, "b")).await;
    settle_for_cycle(&actor, scratch.path().to_owned()).await;
    let before = append(&actor, producer.plaintext_insert(101, "c")).await;
    actor.run(|store,_| {let count=store.read_with(|conn|conn.query_row("SELECT COUNT(*) FROM replication_log WHERE op_kind='moment.append' AND json_extract(payload_json,'$.objectId')='doc'",[],|row|row.get::<_,i64>(0)).map_err(StorageError::persist_public))?;assert!(count>0,"the desktop settle must journal its own moment");Ok(())}).await.unwrap();
    full_cycle(&actor, state).await;
    let after = append(&actor, producer.plaintext_insert(102, "d")).await;
    assert_eq!(
        after.misses, before.misses,
        "an own settlement echo must retain the cache"
    );
    assert_eq!(after.hits, before.hits + 1);
    supervisor.close(&path).unwrap();
}

#[tokio::test]
async fn cursor_committed_crash_invalidates_writer_cache() {
    let (_scratch, path, producer) = document_fixture(true, true, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    actor
        .run(|_, _| {
            CRASH_CURSOR.set(true);
            Ok(())
        })
        .await
        .unwrap();
    assert!(matches!(
        commit_cycle(&actor, cycle_cursor()).await,
        Err(RuntimeError::OperationCrashed)
    ));
    actor
        .run(|store, _| {
            assert!(dohc_engine_sync::read_relay_cursor(store, WORKSPACE)?.is_some());
            Ok(())
        })
        .await
        .unwrap();
    let after = append(&actor, producer.plaintext_insert(101, "c")).await;
    assert_eq!(after.misses, before.misses + 1);
    supervisor.close(&path).unwrap();
}

