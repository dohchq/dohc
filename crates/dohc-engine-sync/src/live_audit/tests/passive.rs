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
    let text: Vec<(String, i64, String)> = source
        .read_with(|c| {
            c.prepare("SELECT sha256,byte_length,text FROM blobs")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    replica
        .write_with(&NoFaults, |tx| {
            for b in blobs {
                put_binary_blob(tx, &b)?;
            }
            for (sha, length, body) in &text {
                tx.execute(
                    "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                    params![sha, length, body],
                )
                .map_err(StorageError::persist_public)?;
            }
            Ok::<_, StorageError>(())
        })
        .unwrap();
}
fn echo(source: &Fixture, replica: &mut EngineStore) {
    copy_blobs(&source.store, replica);
    deliver(replica, operations(&source.store));
}
fn deliver(replica: &mut EngineStore, ops: Vec<ReplicationEnvelope>) {
    for mut op in ops {
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
    counted_row(source, cursor, cursor, previous, doc)
}
fn counted_row(
    source: &mut Fixture,
    cursor: i64,
    count: i64,
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
        &serde_json::to_vec(&("accepted-event-v1", previous, count, &admitted.metadata)).unwrap(),
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
        assert_eq!(result.applied, 1);
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

fn row_with_bytes(
    template: &ReplicaJournalRow,
    cursor: i64,
    previous: &str,
    bytes: Vec<u8>,
) -> ReplicaJournalRow {
    row_with_count(template, cursor, cursor, previous, bytes)
}

fn row_with_count(
    template: &ReplicaJournalRow,
    cursor: i64,
    event_count: i64,
    previous: &str,
    bytes: Vec<u8>,
) -> ReplicaJournalRow {
    let mut next = template.clone();
    next.admitted.update_bytes = bytes;
    let accepted = &mut next.admitted.metadata.accepted;
    accepted.receipt.delivery_id = format!("row-{cursor}");
    accepted.receipt.journal_cursor = cursor;
    accepted.receipt.update_digest = hex_sha256(&next.admitted.update_bytes);
    accepted.received_at_ms = cursor;
    next.journal_cursor = cursor;
    next.evidence_digest = hex_sha256(
        &serde_json::to_vec(&(
            "accepted-event-v1",
            previous,
            event_count,
            &next.admitted.metadata,
        ))
        .unwrap(),
    );
    next
}

struct WideFixture {
    store: EngineStore,
    path: std::path::PathBuf,
    rows: Vec<ReplicaJournalRow>,
    expected: Vec<(dohc_engine_collab::DocKey, dohc_engine_collab::Ydoc)>,
    _scratch: ScratchDir,
}

fn wide_fixture(documents: usize, total_rows: usize, missing_first: bool) -> WideFixture {
    use dohc_engine_collab::{DocKey, Ydoc, durable};
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let (scratch, path, mut store) = receiver(&source);
    let doc = Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let previous = initial(&source);
    let template = row(&mut source, 1, &previous, &doc);
    let mut rows = Vec::new();
    let mut expected = Vec::new();
    for index in 0..documents {
        let key = DocKey::new("ws", "main", format!("wide-{index}")).unwrap();
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO file_objects(workspace_id,object_id,created_at_ms) VALUES('ws',?1,0)", [&key.object_id]).unwrap();
            Ok::<_, StorageError>(())
        }).unwrap();
        durable::claim_base(
            &mut store,
            &key,
            ContentKind::Richdoc,
            &source.bytes,
            &NoFaults,
            0,
        )
        .unwrap();
        let doc = Ydoc::wire();
        doc.apply(&source.bytes).unwrap();
        let mut template = template.clone();
        let binding = &mut template.admitted.metadata.accepted.binding;
        binding.object_id = key.object_id.clone();
        binding.current_path = format!("wide-{index}.md");
        binding.selector_paths = vec![binding.current_path.clone()];
        let mut previous = hex_sha256(
            &serde_json::to_vec(&(
                "accepted-history-v1",
                [
                    "relay",
                    "ws",
                    "main",
                    &binding.object_id,
                    &binding.lineage_claim_id,
                ],
            ))
            .unwrap(),
        );
        let count = total_rows / documents + usize::from(index < total_rows % documents);
        for event_count in 1..=count {
            if missing_first && index == 0 && event_count == 1 {
                doc.richdoc_append_paragraph("Predecessor absent from the replica.");
            }
            let bytes =
                doc.richdoc_append_paragraph(&format!("Wide document {index} row {event_count}."));
            let next = row_with_count(
                &template,
                rows.len() as i64 + 1,
                event_count as i64,
                &previous,
                bytes,
            );
            previous = next.evidence_digest.clone();
            rows.push(next);
        }
        expected.push((key, doc));
    }
    WideFixture {
        store,
        path,
        rows,
        expected,
        _scratch: scratch,
    }
}

#[test]
fn passive_new_append_with_missing_predecessor_refuses_and_rolls_back_the_page() {
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let (_scratch, _path, mut replica) = receiver(&source);
    let before = state(&replica);
    let frontier_before = replica
        .read_with(|c| dohc_engine_storage::replica::read_frontiers(c, "ws"))
        .unwrap();
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let previous = initial(&source);
    let first = row(&mut source, 1, &previous, &doc);
    doc.richdoc_append_paragraph("Predecessor the replica never received.");
    let pending = doc.richdoc_append_paragraph("Successor waiting for that predecessor.");
    let second = row_with_bytes(&first, 2, &first.evidence_digest, pending);
    let probe = dohc_engine_collab::Ydoc::wire();
    probe.apply(&source.bytes).unwrap();
    probe.apply(&first.admitted.update_bytes).unwrap();
    probe.apply(&second.admitted.update_bytes).unwrap();
    assert_ne!(probe.encode_state_vector(), doc.encode_state_vector());
    assert!(
        !probe
            .project(ContentKind::Richdoc)
            .unwrap()
            .content
            .contains("Successor waiting")
    );
    assert!(matches!(
        apply_page(&mut replica, "ws", 0, &[first, second], &NoFaults),
        Err(ApplicationError::Conflict)
    ));
    assert_eq!(state(&replica), before);
    for table in [
        "live_accepted_updates",
        "replica_documents",
        "replica_first_seen",
    ] {
        assert_eq!(count(&replica, table), 0, "rollback {table}");
    }
    assert_eq!(
        replica
            .read_with(|c| dohc_engine_storage::replica::read_frontiers(c, "ws"))
            .unwrap(),
        frontier_before
    );
}

#[test]
fn passive_page_checks_dependencies_after_a_later_row_supplies_the_predecessor() {
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let (_scratch, _path, mut replica) = receiver(&source);
    let frontier_before = replica
        .read_with(|c| dohc_engine_storage::replica::read_frontiers(c, "ws"))
        .unwrap();
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let initial = initial(&source);
    let template = row(&mut source, 1, &initial, &doc);
    let causal = dohc_engine_collab::Ydoc::wire();
    causal.apply(&source.bytes).unwrap();
    let predecessor = causal.richdoc_append_paragraph("Predecessor supplied later in this page.");
    let successor = causal.richdoc_append_paragraph("Successor delivered first.");
    let first = row_with_bytes(&template, 1, &initial, successor);
    let second = row_with_bytes(&template, 2, &first.evidence_digest, predecessor);
    let result = apply_page(&mut replica, "ws", 0, &[first, second], &NoFaults).unwrap();
    assert_eq!(result.applied, 2);
    assert_eq!(result.journal_cursor, 2);
    assert_eq!(result.revision, frontier_before.revision + 1);
    assert_eq!(count(&replica, "live_accepted_updates"), 2);
    let expected = (
        causal.encode_state_vector(),
        causal.project(ContentKind::Richdoc).unwrap().content,
    );
    assert_eq!(state(&replica), expected);
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

struct Crash(std::sync::atomic::AtomicUsize);
impl FaultInjector for Crash {
    fn poll(&self, p: FaultPoint) -> FaultAction {
        if p == FaultPoint::SyncBeforeApplyCommit
            && self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst) == 1
        {
            FaultAction::Crash
        } else {
            FaultAction::Continue
        }
    }
}

#[test]
fn passive_refuses_a_row_at_another_generation() {
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
    let mut later = first.clone();
    later.journal_cursor = 2;
    later.admitted.metadata.accepted.receipt.delivery_id = "later".into();
    later.admitted.metadata.accepted.receipt.journal_cursor = 2;
    later
        .admitted
        .metadata
        .accepted
        .binding
        .restore_fence_generation = 2;
    later.authority.as_mut().unwrap().restore_fence_generation = 2;
    later.admitted.update_bytes = doc.richdoc_append_paragraph("Later paragraph.");
    later.admitted.metadata.accepted.receipt.update_digest =
        hex_sha256(&later.admitted.update_bytes);
    later.evidence_digest = hex_sha256(
        &serde_json::to_vec(&(
            "accepted-event-v1",
            &first.evidence_digest,
            2,
            &later.admitted.metadata,
        ))
        .unwrap(),
    );
    assert!(matches!(
        apply_page(&mut replica, "ws", 1, &[later], &NoFaults),
        Err(ApplicationError::Conflict)
    ));
    let generation: i64 = replica
        .read_with(|c| {
            c.query_row(
                "SELECT restore_generation FROM replica_documents",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(generation, 1);
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
    let second = row(&mut source, 2, &first.evidence_digest, &doc);
    let rows = [first, second];
    let crash = Crash(std::sync::atomic::AtomicUsize::new(2));
    assert!(matches!(
        apply_page(&mut replica, "ws", 0, &rows, &crash),
        Err(ApplicationError::Interrupted)
    ));
    drop(replica);
    let mut replica = EngineStore::open_passive(&path, 1, None, None).unwrap();
    assert_eq!(count(&replica, "live_accepted_updates"), 0);
    let result = apply_page(&mut replica, "ws", 0, &rows, &NoFaults).unwrap();
    let replay = apply_page(&mut replica, "ws", 0, &rows, &NoFaults).unwrap();
    assert_eq!(result.journal_cursor, 2);
    assert_eq!(result.revision, replay.revision);
    assert_eq!(count(&replica, "live_accepted_updates"), 2);
    assert_eq!(state(&replica), state(&source.store));
}

#[test]
#[ignore = "release measurement"]
fn measure_passive_500_row_page() {
    use page_measurement::*;
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let (scratch, path, store) = receiver(&source);
    drop(store);
    let mut previous = initial(&source);
    let mut rows = Vec::new();
    for cursor in 1..=500 {
        let next = row(&mut source, cursor, &previous, &doc);
        previous = next.evidence_digest.clone();
        rows.push(next);
    }
    let mut stores = prepared_stores(&path, &scratch);
    let mut samples = Vec::new();
    let mut phases = Vec::new();
    for (sample, store) in stores.iter_mut().enumerate() {
        let (result, times) = measured_page(store, 0, &rows, sample);
        samples.push(times[0]);
        phases.push(times);
        assert_eq!(result.applied, 500);
        assert_eq!(state(store), state(&source.store));
    }
    print_phases("generic-500", &phases);
    samples.sort_by(f64::total_cmp);
    println!(
        "PASSIVE_PAGE_MS median={} p95={} samples=21 rows=500",
        samples[10], samples[19]
    );
}

#[test]
#[ignore = "release measurement"]
fn measure_passive_page_after_10000_accepted_rows() {
    use page_measurement::*;
    let history = std::env::var("DOHC_PASSIVE_MEASURE_HISTORY")
        .map(|v| v.parse::<usize>().unwrap())
        .unwrap_or(10000);
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let mut previous = initial(&source);
    let template = row(&mut source, 1, &previous, &doc);
    let mut rows = Vec::new();
    for cursor in 1..=history + 500 {
        let cursor = cursor as i64;
        let before = measurement_vector(&doc);
        let mut next = template.clone();
        next.admitted.update_bytes = doc
            .frontmatter_set("measurement", &cursor.to_string())
            .unwrap();
        next.admitted.metadata.first_seen = measurement_vector(&doc)
            .iter()
            .filter_map(|(client, clock)| {
                let start = before.get(client).copied().unwrap_or(0);
                (*clock > start).then_some(
                    dohc_engine_collab::live_update_application::LiveUpdateStructRange {
                        client_id: *client as i64,
                        start_clock: start as i64,
                        end_clock: *clock as i64,
                    },
                )
            })
            .collect();
        let accepted = &mut next.admitted.metadata.accepted;
        accepted.receipt.delivery_id = format!("measure-{cursor}");
        accepted.receipt.journal_cursor = cursor;
        accepted.receipt.update_digest = hex_sha256(&next.admitted.update_bytes);
        accepted.received_at_ms = cursor;
        next.journal_cursor = cursor;
        next.evidence_digest = hex_sha256(
            &serde_json::to_vec(&(
                "accepted-event-v1",
                &previous,
                cursor,
                &next.admitted.metadata,
            ))
            .unwrap(),
        );
        previous = next.evidence_digest.clone();
        rows.push(next);
    }
    let (scratch, path, mut store) = receiver(&source);
    // The receiver includes the template's echo. Use its already-integrated
    // paragraph as the baseline, but not its unrelated accepted audit identity.
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM live_audit_events", []).unwrap();
            Ok::<_, StorageError>(())
        })
        .unwrap();
    for page in rows[..history].chunks(500) {
        let after = page[0].journal_cursor - 1;
        apply_page(&mut store, "ws", after, page, &NoFaults).unwrap();
    }
    let content_first = std::env::var("DOHC_PASSIVE_MEASURE_CONTENT_FIRST").as_deref() == Ok("1");
    if content_first {
        store.write_with(&NoFaults, |tx| {
            for row in &rows[history..] {
                let sha = put_binary_blob(tx, &row.admitted.update_bytes)?;
                tx.execute("INSERT INTO ydoc_updates(workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms) SELECT workspace_id,version_id,object_id,head_update_seq+1,?1,0 FROM ydoc_docs", [sha]).unwrap();
                tx.execute("UPDATE ydoc_docs SET head_update_seq=head_update_seq+1", []).unwrap();
            }
            Ok::<_, StorageError>(())
        }).unwrap();
    }
    drop(store);
    let mut stores = prepared_stores(&path, &scratch);
    let mut samples = Vec::new();
    let mut phases = Vec::new();
    for (sample, store) in stores.iter_mut().enumerate() {
        let head = store.read_with(|conn| {
            Ok::<i64, StorageError>(conn.query_row(
                "SELECT head_update_seq FROM ydoc_docs WHERE workspace_id='ws' AND version_id='main' AND object_id='object'",
                [], |r| r.get(0),
            ).unwrap())
        }).unwrap();
        let (result, times) = measured_page(store, history as i64, &rows[history..], sample);
        samples.push(times[0]);
        phases.push(times);
        assert_eq!(result.applied, 500);
        store
            .read_with(|conn| {
                if content_first {
                    let current: i64 = conn.query_row(
                        "SELECT head_update_seq FROM ydoc_docs WHERE workspace_id='ws' AND version_id='main' AND object_id='object'",
                        [], |r| r.get(0),
                    ).unwrap();
                    assert_eq!(current, head, "content-first page must exercise digest dedupe");
                }
                let actual = dohc_engine_collab::durable::load_doc_in(
                    conn,
                    &dohc_engine_collab::DocKey::new("ws", "main", "object").unwrap(),
                )?;
                assert_eq!(measurement_vector(&actual), measurement_vector(&doc));
                assert_eq!(
                    actual.project(ContentKind::Richdoc)?.content,
                    doc.project(ContentKind::Richdoc)?.content
                );
                Ok::<_, dohc_engine_collab::CollabError>(())
            })
            .unwrap();
        println!("TAIL_PAGE_SAMPLE {sample} {}", samples.last().unwrap());
    }
    print_phases(
        &format!("tail-{history}-content-first-{content_first}"),
        &phases,
    );
    samples.sort_by(f64::total_cmp);
    println!(
        "TAIL_PAGE_MS median={} p95={} samples=21 rows=500 accepted_tail={history} content_first={content_first}",
        samples[10], samples[19]
    );
}

fn measurement_vector(doc: &dohc_engine_collab::Ydoc) -> std::collections::BTreeMap<u64, u64> {
    let bytes = doc.encode_state_vector();
    let mut bytes = bytes.iter();
    let mut read = || {
        let mut value = 0u64;
        let mut shift = 0;
        loop {
            let byte = *bytes.next().unwrap();
            value |= u64::from(byte & 127) << shift;
            if byte < 128 {
                break value;
            }
            shift += 7;
        }
    };
    let count = read();
    (0..count).map(|_| (read(), read())).collect()
}

#[test]
#[ignore = "release measurement"]
fn measure_passive_wide_500_row_page() {
    use page_measurement::*;
    let WideFixture {
        store,
        path,
        rows,
        expected,
        _scratch: scratch,
    } = wide_fixture(32, 500, false);
    drop(store);
    let mut stores = prepared_stores(&path, &scratch);
    let mut samples = Vec::new();
    for (sample, store) in stores.iter_mut().enumerate() {
        let (result, times) = measured_page(store, 0, &rows, sample);
        assert_eq!(result.applied, 500);
        assert_eq!(result.journal_cursor, 500);
        store
            .read_with(|conn| {
                for (key, owner) in &expected {
                    let actual = dohc_engine_collab::durable::load_doc_in(conn, key)?;
                    assert_eq!(measurement_vector(&actual), measurement_vector(owner));
                    assert_eq!(
                        actual.project(ContentKind::Richdoc)?.content,
                        owner.project(ContentKind::Richdoc)?.content
                    );
                }
                Ok::<_, dohc_engine_collab::CollabError>(())
            })
            .unwrap();
        samples.push(times);
    }
    print_phases("wide-500-documents-32", &samples);
}

mod page_measurement;

#[test]
fn current_view_keeps_nested_list_bytes_and_projects_a_journal_edit() {
    use crate::replica_cut::{CurrentViewRequest, CurrentViewSelector, collect_current_view};
    let nested = "- one\n  - child\n    - grandchild\n- two";
    let preview = dohc_engine_collab::Ydoc::wire();
    preview
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, nested)
        .unwrap();
    let canonical = preview.project(ContentKind::Richdoc).unwrap().content;
    let mut source = fixture_with_binding_generation(true, Some(&canonical), 1);
    let baseline_doc = dohc_engine_collab::Ydoc::wire();
    baseline_doc.apply(&source.bytes).unwrap();
    let canonical = baseline_doc.project(ContentKind::Richdoc).unwrap().content;
    source.input.projected_markdown_digest = hex_sha256(canonical.as_bytes());
    source.input.projected_markdown_byte_length = canonical.len() as i64;
    bootstrap(&mut source, false).unwrap();
    let (_scratch, _path, mut replica) = receiver(&source);
    let request = CurrentViewRequest {
        selectors: vec![CurrentViewSelector {
            version_id: Some("main".into()),
            paths: vec!["note.md".into()],
        }],
        known_text_shas: String::new(),
        position: None,
        cursor: None,
        since: None,
        incarnation: String::new(),
    };
    let before = collect_current_view(&replica, "ws", &request).unwrap();
    assert_eq!(before.texts[0].text, canonical);
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let previous = initial(&source);
    let first = row(&mut source, 1, &previous, &doc);
    apply_page(&mut replica, "ws", 0, &[first], &NoFaults).unwrap();
    let after = collect_current_view(&replica, "ws", &request).unwrap();
    let expected = replica
        .read_with(|conn| {
            crate::ydoc_apply::project_ydoc_with_store(
                conn,
                &dohc_engine_collab::DocKey::new("ws", "main", "object").unwrap(),
                &doc,
                ContentKind::Richdoc,
            )
        })
        .unwrap()
        .content;
    assert_eq!(after.texts[0].text, expected);
    assert!(after.texts[0].text.contains("grandchild"));
    assert!(after.texts[0].text.contains("Journal row 1."));
    assert_eq!(after.files[0].sha256, hex_sha256(expected.as_bytes()));
    assert_eq!(after.files[0].byte_length, expected.len());
    assert_eq!(after.files[0].restore_generation, Some(1));
    assert_eq!(after.journal_cursor, 1);
    let saved = VersionedTextStore::new(&mut replica)
        .read_text("ws", "main", "note.md")
        .unwrap()
        .unwrap();
    assert_eq!(saved.text, canonical, "collecting never writes a snapshot");
}
#[test]
#[ignore = "release measurement"]
fn measure_current_view_lanes() {
    use crate::replica_cut::{CurrentViewRequest, CurrentViewSelector, collect_current_view};
    let request = CurrentViewRequest {
        selectors: vec![CurrentViewSelector {
            version_id: Some("main".into()),
            paths: vec![],
        }],
        known_text_shas: String::new(),
        position: None,
        cursor: None,
        since: None,
        incarnation: String::new(),
    };
    for bytes in [50_000, 1_000_000] {
        let text = "x".repeat(bytes);
        let mut source = fixture_with_binding_generation(true, Some(&text), 1);
        let baseline = dohc_engine_collab::Ydoc::wire();
        baseline.apply(&source.bytes).unwrap();
        let canonical = baseline.project(ContentKind::Richdoc).unwrap().content;
        source.input.projected_markdown_digest = hex_sha256(canonical.as_bytes());
        source.input.projected_markdown_byte_length = canonical.len() as i64;
        bootstrap(&mut source, false).unwrap();
        let (_scratch, _path, mut replica) = receiver(&source);
        for _ in 0..21 {
            println!("VIEW_LANE ordinary bytes={bytes}");
            let view = collect_current_view(&replica, "ws", &request).unwrap();
            assert_eq!(view.texts[0].text, canonical);
        }
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.apply(&source.bytes).unwrap();
        let mut previous = initial(&source);
        for cursor in 1..=21 {
            let next = row(&mut source, cursor, &previous, &doc);
            previous = next.evidence_digest.clone();
            apply_page(&mut replica, "ws", cursor - 1, &[next], &NoFaults).unwrap();
            println!("VIEW_LANE journal bytes={bytes}");
            let view = collect_current_view(&replica, "ws", &request).unwrap();
            assert_eq!(view.journal_cursor, cursor);
        }
    }
}
