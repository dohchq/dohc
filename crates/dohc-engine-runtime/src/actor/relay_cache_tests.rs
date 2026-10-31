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
async fn append_push_append_keeps_writer_cache() {
    let (_scratch, path, producer) = document_fixture(true, true, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    push(&actor).await;
    let after = append(&actor, producer.plaintext_insert(101, "c")).await;
    assert_eq!(
        after.misses, before.misses,
        "push must not reconstruct the next gate base"
    );
    assert_eq!(after.hits, before.hits + 1);
    supervisor.close(&path).unwrap();
}

#[tokio::test]
async fn pull_of_own_echo_keeps_writer_cache_warm() {
    let (_scratch, path, producer) = document_fixture(true, true, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    full_cycle(&actor, Arc::new(Mutex::new(Vec::new()))).await;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    push(&actor).await;
    let own_echo = actor
        .run(|store, _| {
            dohc_engine_sync::list_replication_ops(store, WORKSPACE, ORIGIN, 0, 1)
                .map(|mut ops| {
                    let mut op = ops.remove(0);
                    op.relay_seq = Some(2);
                    op
                })
                .map_err(RuntimeError::Sync)
        })
        .await
        .unwrap();
    let outcome = actor
        .relay_with_io(
            false,
            RelayOperation::Pull {
                workspace_id: WORKSPACE.into(),
                now_ms: 1200,
            },
            LeaseRegistry::default(),
            CancellationToken::new(),
            None,
            |request, _| {
                let own_echo = own_echo.clone();
                async move {
                    match request {
                        RelayIoRequest::Pull(_) => Ok(RelayIoResponse::Pull(PullResponse {
                            ops: vec![own_echo],
                            next_cursor: 2,
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
            applied: 0,
            skipped: 1,
            ..
        })
    ));
    let after = append(&actor, producer.plaintext_insert(101, "c")).await;
    assert_eq!(
        after.misses, before.misses,
        "before={before:?} after={after:?}"
    );
    assert_eq!(
        after.hits,
        before.hits + 1,
        "before={before:?} after={after:?}"
    );
    supervisor.close(&path).unwrap();
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
        .relay_with_io(
            false,
            RelayOperation::Pull {
                workspace_id: WORKSPACE.into(),
                now_ms: 1200,
            },
            LeaseRegistry::default(),
            CancellationToken::new(),
            None,
            move |request, _| {
                let own_echo = own_echo.clone();
                let foreign = foreign.clone();
                async move {
                    match request {
                        RelayIoRequest::Pull(_) => Ok(RelayIoResponse::Pull(PullResponse {
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
async fn enrollment_push_claims_base_and_still_misses() {
    let (_scratch, path, producer) = document_fixture(false, false, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    push(&actor).await;
    // The claim alone would force the next miss; this proves first contact cleared the cache.
    assert!(actor.ydoc_cache_stats_for_test().await.unwrap().removes > before.removes);
    actor
        .run(|store, _| {
            assert!(
                read_marker(store, &key())?
                    .unwrap()
                    .lineage_claim_id
                    .is_some()
            );
            Ok(())
        })
        .await
        .unwrap();
    let after = append(&actor, producer.plaintext_insert(101, "c")).await;
    assert_eq!(after.misses, before.misses + 1);
    supervisor.close(&path).unwrap();
}

#[tokio::test]
async fn push_live_origination_still_misses() {
    let (_scratch, path, producer) = document_fixture(true, false, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    push(&actor).await;
    let (claim, decline) = actor
        .ydoc_originate_live_lineage(key(), 1200, CancellationToken::new())
        .await
        .unwrap();
    assert!(claim.is_some());
    assert!(decline.is_none());
    let after = append(&actor, producer.plaintext_insert(101, "c")).await;
    assert_eq!(after.misses, before.misses + 1);
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

#[tokio::test]
async fn native_export_failure_still_clears_writer_cache() {
    let (_scratch, path, producer) = document_fixture(true, true, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    actor.run(|store, _| {
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO live_audit_pending_exports(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,after_event_count) VALUES ('relay','ws','main','missing','missing',0)", []).map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })?;
        Ok(())
    }).await.unwrap();
    let result = actor
        .relay_with_io(
            false,
            push_operation(),
            LeaseRegistry::default(),
            CancellationToken::new(),
            None,
            |_, _| async { panic!("broken native source must fail before I/O") },
        )
        .await;
    assert!(result.is_err());
    assert!(actor.ydoc_cache_stats_for_test().await.unwrap().removes > before.removes);
    let after = append(&actor, producer.plaintext_insert(101, "c")).await;
    assert_eq!(after.misses, before.misses + 1);
    supervisor.close(&path).unwrap();
}

#[tokio::test]
#[ignore = "release paired benchmark; run alone with --ignored --nocapture"]
async fn writer_cache_push_benchmark() {
    for size in [50 * 1024, 1024 * 1024] {
        for interval in [1, 5, 20] {
            let mut append_ns = Vec::new();
            let mut push_ns = Vec::new();
            let mut reconstructions = 0;
            for round in 0..5 {
                let (_scratch, path, producer) = document_fixture(true, true, size);
                let supervisor = WorkspaceSupervisor::new();
                let actor = supervisor.open(&path, 1000).unwrap().actor;
                append(&actor, producer.plaintext_insert(size as u32, "w")).await;
                let before = actor.ydoc_cache_stats_for_test().await.unwrap();
                for index in 0..100 {
                    if index % interval == 0 {
                        let started = std::time::Instant::now();
                        push(&actor).await;
                        if round > 0 {
                            push_ns.push(started.elapsed().as_nanos());
                        }
                    }
                    let bytes = producer.plaintext_insert((size + index + 1) as u32, "x");
                    let started = std::time::Instant::now();
                    append(&actor, bytes).await;
                    if round > 0 {
                        append_ns.push(started.elapsed().as_nanos());
                    }
                }
                if round > 0 {
                    reconstructions +=
                        actor.ydoc_cache_stats_for_test().await.unwrap().misses - before.misses;
                }
                supervisor.close(&path).unwrap();
            }
            append_ns.sort_unstable();
            push_ns.sort_unstable();
            println!(
                "{}",
                serde_json::json!({"benchmark":"writer_cache_push", "size":size, "interval":interval,
                "samples":append_ns.len(), "append_median_ns":append_ns[append_ns.len()/2],
                "append_p95_ns":append_ns[(append_ns.len()*95).div_ceil(100)-1],
                "push_median_ns":push_ns[push_ns.len()/2], "push_p95_ns":push_ns[(push_ns.len()*95).div_ceil(100)-1],
                "reconstructions":reconstructions})
            );
        }
    }
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
            .relay_with_io(
                false,
                RelayOperation::Pull {
                    workspace_id: WORKSPACE.into(),
                    now_ms: 2000,
                },
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
async fn full_own_update_cycle_keeps_writer_cache() {
    let (_scratch, path, producer) = document_fixture(true, true, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    full_cycle(&actor, Arc::new(Mutex::new(Vec::new()))).await;
    let after = append(&actor, producer.plaintext_insert(101, "c")).await;
    assert_eq!(
        after.misses, before.misses,
        "a completed own-update cycle must retain the cache"
    );
    assert_eq!(after.hits, before.hits + 1);
    supervisor.close(&path).unwrap();
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
async fn cursor_base_origination_invalidates_writer_cache() {
    let (_scratch, path, producer) = document_fixture(true, false, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    commit_cycle(&actor, cycle_cursor()).await.unwrap();
    actor
        .run(|store, _| {
            assert!(
                read_marker(store, &key())?
                    .unwrap()
                    .lineage_claim_id
                    .is_some()
            );
            Ok(())
        })
        .await
        .unwrap();
    assert!(actor.ydoc_cache_stats_for_test().await.unwrap().removes > before.removes);
    let after = append(&actor, producer.plaintext_insert(101, "c")).await;
    assert_eq!(after.misses, before.misses + 1);
    supervisor.close(&path).unwrap();
}

#[tokio::test]
async fn cursor_lineage_change_and_aba_invalidates_writer_cache() {
    let (_scratch, path, producer) = document_fixture(true, true, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    actor.run(|store,_|{
        let second=DocKey::new(WORKSPACE,"main","second")?;
        let doc=Ydoc::wire();let bytes=doc.plaintext_insert(0,"second");
        record_local_update(store,&mut WriterDocCache::new(),&second,&bytes,LocalAppend { marker:Some(MarkerCreation {content_kind:ContentKind::Plaintext,regime:Regime::LocalOnly,path:Some("second.md")}),ensure_parent_row:true,..LocalAppend::default()},&NoFaults,1200,|_,_,_|Ok(()))?;
        store.write_with(&NoFaults,|tx|{
            tx.execute_batch("CREATE TEMP TABLE round6_saved_claim AS SELECT lineage_claim_id FROM ydoc_docs WHERE object_id='doc'; CREATE TEMP TRIGGER round6_aba AFTER UPDATE OF lineage_claim_id ON ydoc_docs WHEN NEW.object_id='second' BEGIN UPDATE ydoc_docs SET lineage_claim_id='0000000000000000000000000000000000000000000000000000000000000000' WHERE object_id='doc'; UPDATE ydoc_docs SET lineage_claim_id=(SELECT lineage_claim_id FROM round6_saved_claim) WHERE object_id='doc'; END;").map_err(StorageError::persist_public)?;Ok::<_,StorageError>(())})?;Ok(())}).await.unwrap();
    commit_cycle(&actor, cycle_cursor()).await.unwrap();
    actor
        .run(|store, _| {
            assert!(
                read_marker(store, &DocKey::new(WORKSPACE, "main", "second")?)?
                    .unwrap()
                    .lineage_claim_id
                    .is_some()
            );
            Ok(())
        })
        .await
        .unwrap();
    assert!(actor.ydoc_cache_stats_for_test().await.unwrap().removes > before.removes);
    let after = append(&actor, producer.plaintext_insert(101, "c")).await;
    assert_eq!(after.misses, before.misses + 1);
    supervisor.close(&path).unwrap();
}

#[tokio::test]
async fn cursor_error_invalidates_writer_cache() {
    let (_scratch, path, producer) = document_fixture(true, true, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    actor.run(|store,_|{store.write_with(&NoFaults,|tx|{tx.execute_batch("CREATE TEMP TRIGGER round6_error BEFORE INSERT ON sync_relay_cursors BEGIN SELECT RAISE(ABORT,'round6 commit error'); END;").map_err(StorageError::persist_public)?;Ok::<_,StorageError>(())})?;Ok(())}).await.unwrap();
    assert!(commit_cycle(&actor, cycle_cursor()).await.is_err());
    let after = append(&actor, producer.plaintext_insert(101, "c")).await;
    assert_eq!(after.misses, before.misses + 1);
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

#[tokio::test]
async fn own_moment_materialization_recovery_invalidates_writer_cache() {
    let (_scratch, path, producer) = document_fixture(true, true, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    actor.run(|store,_| {
        let id=format!("sync-materialization:{}",hex_sha256(b"ws\0local\x000"));
        store.write_with(&NoFaults,|tx|{tx.execute("INSERT INTO engine_requests(request_id,payload_hash,result_seq,committed_at,kind) VALUES (?1,?2,0,1000,'sync-materialization')",rusqlite::params![id,r#"[{"versionId":"main","path":"files/0.bin","operation":"write","contentKind":"binary"}]"#]).map_err(StorageError::persist_public)?;Ok::<_,StorageError>(())})?;Ok(())
    }).await.unwrap();
    let own = actor
        .run(|store, _| {
            let mut own =
                dohc_engine_sync::list_replication_ops(store, WORKSPACE, ORIGIN, -1, 1)?.remove(0);
            own.relay_seq = Some(1);
            Ok(own)
        })
        .await
        .unwrap();
    let outcome = actor
        .relay_with_io(
            false,
            RelayOperation::Pull {
                workspace_id: WORKSPACE.into(),
                now_ms: 2000,
            },
            LeaseRegistry::default(),
            CancellationToken::new(),
            None,
            move |request, _| {
                let own = own.clone();
                async move {
                    match request {
                        RelayIoRequest::Pull(_) => Ok(RelayIoResponse::Pull(PullResponse {
                            ops: vec![own],
                            next_cursor: 1,
                            has_more: false,
                        })),
                        other => panic!("unexpected recovery I/O {other:?}"),
                    }
                }
            },
        )
        .await
        .unwrap();
    assert!(
        matches!(outcome, RelayOperationOutcome::Sync(SyncPassOutcome::Complete { applied: 0, changed_paths, .. }) if !changed_paths.is_empty())
    );
    assert!(actor.ydoc_cache_stats_for_test().await.unwrap().removes > before.removes);
    let after = append(&actor, producer.plaintext_insert(101, "c")).await;
    assert_eq!(after.misses, before.misses + 1);
    supervisor.close(&path).unwrap();
}

/// Claim one row under `report` in `table`, as a pass reporting it would.
async fn claimed_report_row(actor: &ActorHandle, table: &'static str, report: &'static str) {
    actor
        .run(move |store, _| {
            store
                .write_with(&NoFaults, |tx| {
                    let sql = match table {
                        "ydoc_drain_reports" => {
                            "INSERT INTO ydoc_drain_reports \
                             (workspace_id,origin_id,origin_seq,report_json,report_id) \
                             VALUES (?1,'peer',1,'{\"conflictsOpened\":1}',?2)"
                        }
                        _ => {
                            "INSERT INTO relay_deferred_ops \
                             (workspace_id,origin_id,origin_seq,replication_epoch,stream_identity, \
                              envelope_json,retained_bytes,report_id) \
                             VALUES (?1,'peer',1,'epoch','stream','{}',1,?2)"
                        }
                    };
                    tx.execute(sql, rusqlite::params![WORKSPACE, report])
                        .map_err(StorageError::persist_public)?;
                    Ok::<_, StorageError>(())
                })
                .unwrap();
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn cursor_releasing_only_drain_reports_keeps_writer_cache() {
    let (_scratch, path, producer) = document_fixture(true, true, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    claimed_report_row(&actor, "ydoc_drain_reports", "drain-report").await;
    let mut cursor = cycle_cursor();
    cursor.settlement_report_id = Some("drain-report".into());
    assert!(matches!(
        commit_cycle(&actor, cursor).await.unwrap(),
        RelayOperationOutcome::CursorCommitted {
            writer_cache_changed: false,
            ..
        }
    ));
    let released = actor
        .run(|store, _| Ok(store.table_row_count("ydoc_drain_reports").unwrap()))
        .await
        .unwrap();
    assert_eq!(released, 0, "the commit acknowledges the drain report");
    let after = append(&actor, producer.plaintext_insert(101, "c")).await;
    assert_eq!(after.misses, before.misses);
    assert_eq!(after.hits, before.hits + 1);
    supervisor.close(&path).unwrap();
}

#[tokio::test]
async fn cursor_releasing_deferred_work_invalidates_writer_cache() {
    let (_scratch, path, producer) = document_fixture(true, true, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    claimed_report_row(&actor, "relay_deferred_ops", "deferred-report").await;
    let mut cursor = cycle_cursor();
    cursor.settlement_report_id = Some("deferred-report".into());
    commit_cycle(&actor, cursor).await.unwrap();
    let after = append(&actor, producer.plaintext_insert(101, "c")).await;
    assert_eq!(after.misses, before.misses + 1);
    supervisor.close(&path).unwrap();
}

#[tokio::test]
async fn skipped_moment_committed_crash_clears_before_next_envelope() {
    let (_scratch, path, producer) = document_fixture(true, true, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    actor
        .run(|store, cache| {
            let mut own =
                dohc_engine_sync::list_replication_ops(store, WORKSPACE, ORIGIN, -1, 1)?.remove(0);
            own.relay_seq = Some(1);
            assert!(
                cache.doc_full_state_for_test(&key()).is_some(),
                "the append keeps the document cached"
            );
            CRASH_CURSOR.set(true);
            let result = dohc_engine_sync::apply_replication_envelope(
                store,
                cache,
                &own,
                &CursorFaults,
                &dohc_engine_sync::NoLiveLeases,
            )?;
            assert!(matches!(
                result.primary,
                dohc_engine_sync::ApplyDisposition::Crashed { committed: true }
            ));
            assert!(
                cache.doc_full_state_for_test(&key()).is_none(),
                "clear before another envelope can use the cache"
            );
            Ok(())
        })
        .await
        .unwrap();
    let after = append(&actor, producer.plaintext_insert(101, "c")).await;
    assert_eq!(after.misses, before.misses + 1);
    supervisor.close(&path).unwrap();
}
