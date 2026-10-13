use super::*;
use dohc_engine_collab::live_update_application::passive::{
    ReplicaAuthority, ReplicaJournalRow, ReplicaPageResult,
};
use dohc_engine_collab::live_update_application::{
    AdmittedLiveUpdate, AdmittedLiveUpdateMetadata, ApplicationError, LiveUpdateReceipt,
    RelayAcceptedLiveUpdate, ServerDerivedLiveUpdateAuthority, apply_committed,
};
use dohc_engine_storage::{FaultAction, FaultInjector, FaultPoint, StorageError};

fn apply_page(
    store: &mut EngineStore,
    workspace: &str,
    after: i64,
    rows: &[ReplicaJournalRow],
    faults: &dyn FaultInjector,
) -> Result<ReplicaPageResult, ApplicationError> {
    dohc_engine_collab::live_update_application::passive::apply_page(
        store, workspace, after, 0, rows, faults,
    )
}

fn copy_blobs(source: &EngineStore, replica: &mut EngineStore) {
    let blobs = source
        .read_with(|c| {
            c.prepare("SELECT bytes FROM binary_blobs")?
                .query_map([], |r| r.get::<_, Vec<u8>>(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    replica
        .write_with(&NoFaults, |tx| {
            for b in blobs {
                put_binary_blob(tx, &b)?;
            }
            Ok::<_, StorageError>(())
        })
        .unwrap();
}
fn echo(source: &Fixture, replica: &mut EngineStore) {
    copy_blobs(&source.store, replica);
    for mut op in operations(&source.store) {
        op.relay_seq = Some(op.origin_seq + 1);
        let result = crate::apply_replication_envelope(
            replica,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(
            matches!(
                result.primary,
                ApplyDisposition::Applied(_) | ApplyDisposition::Skipped
            ),
            "{}: {:?}",
            op.op_kind,
            result.primary
        );
    }
}
fn receiver(source: &Fixture) -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let scratch = ScratchDir::new().unwrap();
    let path = scratch.path().join("replica.db");
    let mut store = EngineStore::open_passive(&path, 0, None, None).unwrap();
    echo(source, &mut store);
    (scratch, path, store)
}
fn row(
    source: &mut Fixture,
    cursor: i64,
    previous: &str,
    doc: &dohc_engine_collab::Ydoc,
) -> ReplicaJournalRow {
    let bytes = doc.richdoc_append_paragraph(&format!("Journal row {cursor}."));
    let admitted = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: format!("row-{cursor}"),
                    update_digest: hex_sha256(&bytes),
                    journal_cursor: cursor,
                    accepting_host_epoch: 1,
                },
                binding: source.binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                },
                received_at_ms: cursor,
            },
            first_seen: vec![],
            canonical_version: None,
            author_snapshot: None,
            first_seen_deletes: None,
            checkpoint_coverage: None,
        },
        update_bytes: bytes,
    };
    let evidence_digest = hex_sha256(
        &serde_json::to_vec(&("accepted-event-v1", previous, cursor, &admitted.metadata)).unwrap(),
    );
    apply_committed(
        &mut source.store,
        &mut WriterDocCache::new(),
        &source.handle,
        admitted.clone(),
        &NoFaults,
        100_000_000,
        |tx, namespace, binding, count| {
            journal_live_event_or_defer_in_tx(tx, namespace, binding, count, 200)
                .map(|_| ())
                .map_err(|e| ApplicationError::Storage(StorageError::persist_public(e)))
        },
    )
    .unwrap();
    ReplicaJournalRow {
        admitted,
        relay_database_namespace: "relay".into(),
        evidence_digest,
        journal_cursor: cursor,
        authority: Some(ReplicaAuthority {
            lineage_claim_id: source.binding.lineage_claim_id.clone(),
            baseline_sequence: 1,
            restore_fence_generation: source.binding.restore_fence_generation,
        }),
        restore: None,
    }
}
fn initial(source: &Fixture) -> String {
    hex_sha256(
        &serde_json::to_vec(&(
            "accepted-history-v1",
            [
                "relay",
                "ws",
                "main",
                "object",
                &source.binding.lineage_claim_id,
            ],
        ))
        .unwrap(),
    )
}
fn state(store: &EngineStore) -> (Vec<u8>, String) {
    store
        .read_with(|c| {
            let doc = dohc_engine_collab::durable::load_doc_in(
                c,
                &dohc_engine_collab::DocKey::new("ws", "main", "object").unwrap(),
            )?;
            Ok::<_, dohc_engine_collab::CollabError>((
                doc.encode_state_vector(),
                doc.project(ContentKind::Richdoc)?.content,
            ))
        })
        .unwrap()
}

#[test]
fn passive_journal_echo_both_orders_have_one_history_and_equal_owner_evidence_and_content() {
    for journal_first in [true, false] {
        let mut source = fixture_with_binding_generation(true, None, 1);
        bootstrap(&mut source, false).unwrap();
        let (_scratch, _path, mut replica) = receiver(&source);
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.apply(&source.bytes).unwrap();
        let previous = initial(&source);
        let first = row(&mut source, 1, &previous, &doc);
        let before_snapshots = count(&replica, "snapshots");
        if !journal_first {
            echo(&source, &mut replica);
            let mut collision = first.clone();
            collision.admitted.metadata.accepted.receipt.delivery_id = "cursor-collision".into();
            collision.evidence_digest = hex_sha256(
                &serde_json::to_vec(&(
                    "accepted-event-v1",
                    &previous,
                    1,
                    &collision.admitted.metadata,
                ))
                .unwrap(),
            );
            assert!(matches!(
                apply_page(&mut replica, "ws", 0, &[collision], &NoFaults),
                Err(ApplicationError::Conflict)
            ));
        }
        let native_before = count(&replica, "ydoc_updates");
        let result = apply_page(
            &mut replica,
            "ws",
            0,
            std::slice::from_ref(&first),
            &NoFaults,
        )
        .unwrap();
        assert_eq!(result.applied, usize::from(journal_first));
        if journal_first {
            assert_eq!(count(&replica, "snapshots"), before_snapshots);
            echo(&source, &mut replica);
        } else {
            assert_eq!(count(&replica, "ydoc_updates"), native_before);
        }
        let native_count = count(&replica, "ydoc_updates");
        let replay = apply_page(
            &mut replica,
            "ws",
            0,
            std::slice::from_ref(&first),
            &NoFaults,
        )
        .unwrap();
        assert_eq!(replay.journal_cursor, 1);
        assert!(replay.revision >= result.revision);
        assert_eq!(count(&replica, "ydoc_updates"), native_count);
        assert_eq!(count(&replica, "live_audit_events"), 1);
        assert_eq!(count(&replica, "live_accepted_updates"), 1);
        assert_eq!(state(&replica), state(&source.store));
        let evidence: String = replica
            .read_with(|c| {
                c.query_row("SELECT evidence_digest FROM live_audit_events", [], |r| {
                    r.get(0)
                })
            })
            .unwrap();
        assert_eq!(evidence, first.evidence_digest);
        replica
            .read_with(|c| {
                for table in [
                    "live_audit_pending_exports",
                    "automation_claims",
                    "owner_ydoc_outboxes",
                    "live_device_update_applications",
                    "materialization_jobs",
                ] {
                    assert_eq!(
                        c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                            .get::<_, i64>(0))
                            .unwrap(),
                        0,
                        "{table}"
                    );
                }
                assert_eq!(
                    c.query_row(
                        "SELECT count(*) FROM replication_log WHERE imported=0",
                        [],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                    0
                );
                Ok::<_, StorageError>(())
            })
            .unwrap();
        let mut wrong = first.clone();
        wrong.evidence_digest = "0".repeat(64);
        assert!(matches!(
            apply_page(&mut replica, "ws", 0, &[wrong], &NoFaults),
            Err(ApplicationError::Conflict)
        ));
        let mut retired_mismatch = first.clone();
        retired_mismatch.authority = None;
        retired_mismatch
            .admitted
            .metadata
            .accepted
            .binding
            .lineage_claim_id = "f".repeat(64);
        assert!(matches!(
            apply_page(&mut replica, "ws", 0, &[retired_mismatch], &NoFaults),
            Err(ApplicationError::Conflict)
        ));
    }
}

#[test]
fn passive_sparse_ordinary_echo_uses_the_accepted_prefix() {
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let (_scratch, _path, mut replica) = receiver(&source);
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let previous = initial(&source);
    let first = row(&mut source, 1, &previous, &doc);
    let second = row(&mut source, 2, &first.evidence_digest, &doc);
    echo(&source, &mut replica);
    replica
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM live_audit_events WHERE event_count=1", [])
                .unwrap();
            Ok::<_, StorageError>(())
        })
        .unwrap();
    let native_before = count(&replica, "ydoc_updates");
    let result = apply_page(&mut replica, "ws", 0, &[first, second.clone()], &NoFaults).unwrap();
    assert_eq!(result.journal_cursor, 2);
    assert_eq!(count(&replica, "ydoc_updates"), native_before);
    assert_eq!(count(&replica, "live_accepted_updates"), 2);
    assert_eq!(state(&replica), state(&source.store));
    let evidence: String = replica
        .read_with(|c| {
            c.query_row("SELECT evidence_digest FROM replica_documents", [], |r| {
                r.get(0)
            })
        })
        .unwrap();
    assert_eq!(evidence, second.evidence_digest);
}

#[test]
fn passive_epoch_floor_skips_missing_old_baselines_but_preserves_current_markers() {
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let (_scratch, _path, mut current) = receiver(&source);
    let empty = ScratchDir::new().unwrap();
    let mut missing =
        EngineStore::open_passive(&empty.path().join("missing.db"), 0, None, None).unwrap();
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let previous = initial(&source);
    let first = row(&mut source, 1, &previous, &doc);
    let skipped = dohc_engine_collab::live_update_application::passive::apply_page(
        &mut missing,
        "ws",
        0,
        2,
        std::slice::from_ref(&first),
        &NoFaults,
    )
    .unwrap();
    assert_eq!(skipped.skipped, 1);
    assert_eq!(skipped.blocked_cursor, None);
    let applied = dohc_engine_collab::live_update_application::passive::apply_page(
        &mut current,
        "ws",
        0,
        2,
        std::slice::from_ref(&first),
        &NoFaults,
    )
    .unwrap();
    assert_eq!(applied.applied, 1);
    assert_eq!(state(&current), state(&source.store));
    let second = row(&mut source, 2, &first.evidence_digest, &doc);
    let mut post_floor = second;
    post_floor.authority.as_mut().unwrap().baseline_sequence = 3;
    let blocked = dohc_engine_collab::live_update_application::passive::apply_page(
        &mut missing,
        "ws",
        1,
        2,
        &[post_floor],
        &NoFaults,
    )
    .unwrap();
    assert_eq!(blocked.blocked_cursor, Some(2));
    assert_eq!(blocked.journal_cursor, 1);
}

struct Crash;
impl FaultInjector for Crash {
    fn poll(&self, p: FaultPoint) -> FaultAction {
        if p == FaultPoint::SyncBeforeApplyCommit {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}

#[test]
fn passive_generation_steps_only_with_the_restore_application_and_refuses_old_rows() {
    use dohc_engine_collab::live_update_application::passive::ReplicaRestore;
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let (_scratch, _path, mut replica) = receiver(&source);
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let previous = initial(&source);
    let first = row(&mut source, 1, &previous, &doc);
    apply_page(
        &mut replica,
        "ws",
        0,
        std::slice::from_ref(&first),
        &NoFaults,
    )
    .unwrap();
    let mut restored = first.clone();
    restored.journal_cursor = 2;
    restored.admitted.metadata.accepted.receipt.delivery_id = "restore".into();
    restored.admitted.metadata.accepted.receipt.journal_cursor = 2;
    restored
        .admitted
        .metadata
        .accepted
        .binding
        .restore_fence_generation = 2;
    restored
        .authority
        .as_mut()
        .unwrap()
        .restore_fence_generation = 2;
    restored.admitted.update_bytes = doc.richdoc_append_paragraph("Restored paragraph.");
    restored.admitted.metadata.accepted.receipt.update_digest =
        hex_sha256(&restored.admitted.update_bytes);
    restored.evidence_digest = hex_sha256(
        &serde_json::to_vec(&(
            "accepted-event-v1",
            &first.evidence_digest,
            2,
            &restored.admitted.metadata,
        ))
        .unwrap(),
    );
    assert!(matches!(
        apply_page(
            &mut replica,
            "ws",
            1,
            std::slice::from_ref(&restored),
            &NoFaults
        ),
        Err(ApplicationError::Conflict)
    ));
    let checkpoint_bytes = doc.encode_full_state();
    let checkpoint_digest = hex_sha256(&checkpoint_bytes);
    restored.restore = Some(ReplicaRestore {
        operation_id: "restore-op".into(),
        checkpoint_digest: checkpoint_digest.clone(),
        checkpoint_bytes,
        proof: json!({"admitted":restored.admitted.metadata,"candidateDigest":restored.admitted.metadata.accepted.receipt.update_digest,
            "checkpointDigest":checkpoint_digest,"preparation":{"fence":{"operation":{"operationId":"restore-op","relayDatabaseNamespace":"relay",
                "oldBinding":source.binding,"hostId":"host","newFence":2,"origin":{"kind":"bootstrap","id":"bootstrap"},
                "terminal":first.admitted.metadata.accepted.receipt,"appliedSequence":1},"localHeadSequence":1,"recordedAtMs":3}}}),
    });
    let mut bad = restored.clone();
    bad.restore.as_mut().unwrap().proof["preparation"]["fence"]["operation"]["operationId"] =
        json!("wrong");
    assert!(matches!(
        apply_page(&mut replica, "ws", 1, &[bad], &NoFaults),
        Err(ApplicationError::Conflict)
    ));
    apply_page(
        &mut replica,
        "ws",
        1,
        std::slice::from_ref(&restored),
        &NoFaults,
    )
    .unwrap();
    let generation: i64 = replica
        .read_with(|c| {
            c.query_row(
                "SELECT restore_generation FROM replica_documents",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(generation, 2);
    let mut old = first.clone();
    old.journal_cursor = 3;
    old.admitted.metadata.accepted.receipt.journal_cursor = 3;
    old.admitted.metadata.accepted.receipt.delivery_id = "old-after-restore".into();
    assert!(matches!(
        apply_page(&mut replica, "ws", 2, &[old], &NoFaults),
        Err(ApplicationError::Conflict)
    ));
    assert_eq!(
        replica
            .read_with(|c| c.query_row(
                "SELECT restore_generation FROM replica_documents",
                [],
                |r| r.get::<_, i64>(0)
            ))
            .unwrap(),
        2
    );
    assert_eq!(
        state(&replica),
        (
            doc.encode_state_vector(),
            doc.project(ContentKind::Richdoc).unwrap().content
        )
    );
}
#[test]
fn passive_crash_between_apply_and_frontier_rolls_back_and_restarts_once() {
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let (_scratch, path, mut replica) = receiver(&source);
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let previous = initial(&source);
    let first = row(&mut source, 1, &previous, &doc);
    assert!(matches!(
        apply_page(&mut replica, "ws", 0, std::slice::from_ref(&first), &Crash),
        Err(ApplicationError::Interrupted)
    ));
    drop(replica);
    let mut replica = EngineStore::open_passive(&path, 1, None, None).unwrap();
    assert_eq!(count(&replica, "live_accepted_updates"), 0);
    let result = apply_page(
        &mut replica,
        "ws",
        0,
        std::slice::from_ref(&first),
        &NoFaults,
    )
    .unwrap();
    let replay = apply_page(&mut replica, "ws", 0, &[first], &NoFaults).unwrap();
    assert_eq!(result.journal_cursor, 1);
    assert_eq!(result.revision, replay.revision);
    assert_eq!(count(&replica, "live_accepted_updates"), 1);
}

#[test]
fn passive_retired_authority_skips_without_an_old_baseline_and_matching_lineage_waits() {
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let scratch = ScratchDir::new().unwrap();
    let mut replica =
        EngineStore::open_passive(&scratch.path().join("retired.db"), 0, None, None).unwrap();
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let previous = initial(&source);
    let mut first = row(&mut source, 1, &previous, &doc);
    let waiting = apply_page(
        &mut replica,
        "ws",
        0,
        std::slice::from_ref(&first),
        &NoFaults,
    )
    .unwrap();
    assert_eq!(waiting.blocked_cursor, Some(1));
    let (_retired_scratch, _path, mut retired) = receiver(&source);
    retired
        .write_with(&NoFaults, |tx| {
            crate::retire_ydoc_lineage_in_tx(tx, "ws", "main", "object")
        })
        .unwrap();
    let inactive = apply_page(
        &mut retired,
        "ws",
        0,
        std::slice::from_ref(&first),
        &NoFaults,
    )
    .unwrap();
    assert_eq!(inactive.blocked_cursor, None);
    assert_eq!(inactive.skipped, 1);
    assert_eq!(inactive.journal_cursor, 1);
    let mut mismatch = first.clone();
    mismatch.admitted.metadata.accepted.received_at_ms += 1;
    assert!(matches!(
        apply_page(&mut retired, "ws", 0, &[mismatch], &NoFaults),
        Err(ApplicationError::Conflict)
    ));
    first.authority = None;
    let skipped = apply_page(&mut replica, "ws", 0, &[first], &NoFaults).unwrap();
    assert_eq!(skipped.skipped, 1);
    assert_eq!(skipped.journal_cursor, 1);
    assert_eq!(count(&replica, "ydoc_docs"), 0);
}

#[test]
#[ignore = "release measurement"]
fn measure_passive_500_row_page() {
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let baseline_operations = operations(&source.store);
    let mut previous = initial(&source);
    let mut rows = Vec::new();
    for cursor in 1..=500 {
        let next = row(&mut source, cursor, &previous, &doc);
        previous = next.evidence_digest.clone();
        rows.push(next);
    }
    let mut samples = Vec::new();
    for _ in 0..21 {
        let scratch = ScratchDir::new().unwrap();
        let mut store =
            EngineStore::open_passive(&scratch.path().join("page.db"), 0, None, None).unwrap();
        copy_blobs(&source.store, &mut store);
        for mut op in baseline_operations.clone() {
            op.relay_seq = Some(op.origin_seq + 1);
            crate::apply_replication_envelope(
                &mut store,
                &mut WriterDocCache::new(),
                &op,
                &NoFaults,
                &NoLiveLeases,
            )
            .unwrap();
        }
        let start = std::time::Instant::now();
        let result = apply_page(&mut store, "ws", 0, &rows, &NoFaults).unwrap();
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(result.applied, 500);
        assert_eq!(state(&store), state(&source.store));
    }
    samples.sort_by(f64::total_cmp);
    println!(
        "PASSIVE_PAGE_MS median={} p95={} samples=21 rows=500",
        samples[10], samples[19]
    );
}
