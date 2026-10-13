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
async fn pull_still_clears_writer_cache() {
    let (_scratch, path, producer) = document_fixture(true, true, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    actor
        .relay_with_io(
            false,
            RelayOperation::Pull {
                workspace_id: WORKSPACE.into(),
                now_ms: 1200,
            },
            LeaseRegistry::default(),
            CancellationToken::new(),
            None,
            |request, _| async move {
                match request {
                    RelayIoRequest::Pull(_) => Ok(RelayIoResponse::Pull(PullResponse {
                        ops: Vec::new(),
                        next_cursor: 0,
                        has_more: false,
                    })),
                    other => panic!("unexpected pull request: {other:?}"),
                }
            },
        )
        .await
        .unwrap();
    let after = append(&actor, producer.plaintext_insert(101, "c")).await;
    assert_eq!(after.misses, before.misses + 1);
    supervisor.close(&path).unwrap();
}

#[tokio::test]
async fn enrollment_push_claims_base_and_still_misses() {
    let (_scratch, path, producer) = document_fixture(false, false, 100);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&path, 1000).unwrap().actor;
    let before = append(&actor, producer.plaintext_insert(100, "b")).await;
    push(&actor).await;
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
