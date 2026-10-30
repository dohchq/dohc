use super::*;
use dohc_engine_collab::live_update_application::passive::{
    ReplicaAuthority, ReplicaJournalEntry, ReplicaJournalRow, ReplicaPageResult,
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
        store,
        workspace,
        after,
        0,
        &entries(rows),
        faults,
    )
}

fn entries(rows: &[ReplicaJournalRow]) -> Vec<ReplicaJournalEntry> {
    rows.iter()
        .cloned()
        .map(ReplicaJournalEntry::Update)
        .collect()
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
/// The source's accepted update at `cursor`, its lineage's event `count`.
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

#[test]
fn passive_audit_without_content_still_applies_the_update() {
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let (_scratch, _path, mut replica) = receiver(&source);
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let previous = initial(&source);
    let first = row(&mut source, 1, &previous, &doc);
    echo(&source, &mut replica);
    replica
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM ydoc_updates WHERE update_blob_sha256=?1",
                [&first.admitted.metadata.accepted.receipt.update_digest],
            )
            .unwrap();
            tx.execute(
                "UPDATE ydoc_docs SET head_update_seq=head_update_seq-1,settled_update_seq=NULL",
                [],
            )
            .unwrap();
            Ok::<_, StorageError>(())
        })
        .unwrap();
    assert_ne!(state(&replica), state(&source.store));
    let result = apply_page(&mut replica, "ws", 0, &[first], &NoFaults).unwrap();
    assert_eq!(state(&replica), state(&source.store));
    assert_eq!(result.applied, 1);
}

/// Sol's replica format: a restore the relay cancelled after its native fence
/// reaches a replica as a control record. At the replica's exact generation
/// and endpoint it advances the generation and nothing else, and a replay
/// skips. The next delivery at the new generation then applies on the
/// normal count and evidence chain. A forged or altered record refuses, and
/// so does a delivery at the new generation without one, or one from the
/// generation before after it.
#[test]
fn passive_replica_crosses_a_cancelled_restore_by_its_control_record() {
    use dohc_engine_collab::live_update_application::passive::ReplicaRestoreCancellation;
    use dohc_engine_collab::live_update_application::{
        NativeRestoreCancellationReceipt, NativeRestoreFence, NativeRestoreFenceReceipt,
        RestoreDeliveryOrigin, RetainedPrefixBody,
    };
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
    let terminal = first.admitted.metadata.accepted.receipt.clone();
    let mut stopped = source.binding.clone();
    stopped.restore_fence_generation = 2;
    let record = ReplicaRestoreCancellation {
        relay_database_namespace: "relay".into(),
        journal_cursor: 2,
        cancellation: NativeRestoreCancellationReceipt {
            fence: NativeRestoreFenceReceipt {
                operation: NativeRestoreFence {
                    point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
                        journal_cursor: 0,
                        receipt_digest: source.binding.lineage_claim_id.clone(),
                    },
                    operation_id: "restore".into(),
                    relay_database_namespace: "relay".into(),
                    old_binding: source.binding.clone(),
                    host_id: "host".into(),
                    new_fence: 2,
                    origin: RestoreDeliveryOrigin::Bootstrap {
                        id: "bootstrap".into(),
                    },
                    terminal: Some(terminal.clone()),
                    applied_sequence: 1,
                },
                local_head_sequence: 1,
                recorded_at_ms: 2,
            },
            binding: stopped.clone(),
            endpoint: RetainedPrefixBody {
                terminal_receipt: Some(terminal),
                event_count: 1,
                history_evidence_digest: first.evidence_digest.clone(),
            },
            recorded_at_ms: 2,
        },
        authority: Some(ReplicaAuthority {
            lineage_claim_id: source.binding.lineage_claim_id.clone(),
            baseline_sequence: 1,
            restore_fence_generation: 2,
        }),
    };
    let mut template = first.clone();
    template.admitted.metadata.accepted.binding = stopped;
    template
        .authority
        .as_mut()
        .unwrap()
        .restore_fence_generation = 2;
    let bytes = doc.richdoc_append_paragraph("After the cancelled restore.");
    let next = row_with_count(&template, 3, 2, &first.evidence_digest, bytes);
    let page = |entries: Vec<ReplicaJournalEntry>, after: i64, replica: &mut EngineStore| {
        dohc_engine_collab::live_update_application::passive::apply_page(
            replica, "ws", after, 0, &entries, &NoFaults,
        )
    };
    assert!(
        page(
            vec![ReplicaJournalEntry::Update(next.clone())],
            1,
            &mut replica
        )
        .is_err(),
        "a new generation needs its control record"
    );
    let mut forged = Vec::new();
    let changes: [fn(&mut NativeRestoreCancellationReceipt); 5] = [
        |c: &mut NativeRestoreCancellationReceipt| {
            c.endpoint.history_evidence_digest = "f".repeat(64)
        },
        |c: &mut NativeRestoreCancellationReceipt| c.endpoint.event_count = 2,
        |c: &mut NativeRestoreCancellationReceipt| {
            c.fence.operation.relay_database_namespace = "other".into()
        },
        |c: &mut NativeRestoreCancellationReceipt| c.binding.restore_fence_generation = 3,
        |c: &mut NativeRestoreCancellationReceipt| {
            c.fence.operation.old_binding.restore_fence_generation = 2;
            c.fence.operation.new_fence = 3;
            c.binding.restore_fence_generation = 3;
        },
    ];
    for change in changes {
        let mut altered = record.clone();
        change(&mut altered.cancellation);
        forged.push(altered);
    }
    let mut late = record.clone();
    late.journal_cursor = 1;
    forged.push(late);
    for altered in forged {
        assert!(
            page(
                vec![ReplicaJournalEntry::Cancellation(altered.clone())],
                1,
                &mut replica
            )
            .is_err(),
            "{altered:?}"
        );
    }
    let before = state(&replica);
    let position = |replica: &EngineStore| -> (i64, i64, String) {
        replica
            .read_with(|c| {
                c.query_row(
                    "SELECT restore_generation,event_count,evidence_digest FROM replica_documents",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .unwrap()
    };
    let applied = page(
        vec![ReplicaJournalEntry::Cancellation(record.clone())],
        1,
        &mut replica,
    )
    .unwrap();
    assert_eq!((applied.applied, applied.journal_cursor), (1, 2));
    assert_eq!(state(&replica), before, "document state stays");
    assert_eq!(position(&replica), (2, 1, first.evidence_digest.clone()));
    assert_eq!(count(&replica, "live_accepted_updates"), 1);
    assert_eq!(
        count(&replica, "owner_ydoc_outboxes"),
        0,
        "no retained work arrives"
    );
    // The authority is current when the relay serves the page, so the replica
    // clears that authority in its kept record. A replay under a later or
    // no authority is still that record.
    let kept: String = replica
        .read_with(|c| {
            c.query_row(
                "SELECT record_json FROM replica_restore_cancellations",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let kept: serde_json::Value = serde_json::from_str(&kept).unwrap();
    assert_eq!(kept.get("authority"), Some(&serde_json::Value::Null));
    let mut later = record.clone();
    later.authority = Some(ReplicaAuthority {
        lineage_claim_id: "e".repeat(64),
        baseline_sequence: 9,
        restore_fence_generation: 1,
    });
    let mut none = record.clone();
    none.authority = None;
    for replayed in [record, later, none] {
        let replay = page(
            vec![ReplicaJournalEntry::Cancellation(replayed.clone())],
            1,
            &mut replica,
        )
        .unwrap();
        assert_eq!((replay.applied, replay.skipped), (0, 1), "{replayed:?}");
    }
    let mut old = row_with_count(
        &first,
        4,
        2,
        &first.evidence_digest,
        doc.richdoc_append_paragraph("Old session."),
    );
    old.authority.as_mut().unwrap().restore_fence_generation = 2;
    assert!(
        page(vec![ReplicaJournalEntry::Update(old)], 2, &mut replica).is_err(),
        "the generation before refuses"
    );
    let result = page(
        vec![ReplicaJournalEntry::Update(next.clone())],
        2,
        &mut replica,
    )
    .unwrap();
    assert_eq!(result.applied, 1);
    assert_eq!(position(&replica), (2, 2, next.evidence_digest));
}

/// The record of a restore of `source`'s lineage fenced from `old` and
/// cancelled at `cursor` before the lineage accepted any event: its endpoint
/// is event zero at the lineage's initial digest.
fn opening_cancellation(
    source: &Fixture,
    cursor: i64,
    old: i64,
) -> dohc_engine_collab::live_update_application::passive::ReplicaRestoreCancellation {
    use dohc_engine_collab::live_update_application::{
        NativeRestoreCancellationReceipt, NativeRestoreFence, NativeRestoreFenceReceipt,
        RestoreDeliveryOrigin, RetainedPrefixBody,
    };
    let mut from = source.binding.clone();
    from.restore_fence_generation = old;
    let mut stopped = from.clone();
    stopped.restore_fence_generation = old + 1;
    dohc_engine_collab::live_update_application::passive::ReplicaRestoreCancellation {
        relay_database_namespace: "relay".into(),
        journal_cursor: cursor,
        cancellation: NativeRestoreCancellationReceipt {
            fence: NativeRestoreFenceReceipt {
                operation: NativeRestoreFence {
                    point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
                        journal_cursor: 0,
                        receipt_digest: source.binding.lineage_claim_id.clone(),
                    },
                    operation_id: format!("restore-{cursor}"),
                    relay_database_namespace: "relay".into(),
                    old_binding: from,
                    host_id: "host".into(),
                    new_fence: old + 1,
                    origin: RestoreDeliveryOrigin::Bootstrap {
                        id: "bootstrap".into(),
                    },
                    terminal: None,
                    applied_sequence: 0,
                },
                local_head_sequence: 0,
                recorded_at_ms: cursor,
            },
            binding: stopped,
            endpoint: RetainedPrefixBody {
                terminal_receipt: None,
                event_count: 0,
                history_evidence_digest: initial(source),
            },
            recorded_at_ms: cursor,
        },
        authority: None,
    }
}

/// Sol 1, Opus 1 and Sol 3: restores cancelled before the lineage's first accepted
/// event reach a replica that holds no position for it. Each moves the
/// lineage's generation, which the replica keeps with the record through a
/// restart and shows in its current view. A replay must be the record
/// applied. The first update then applies at the last generation, on event
/// one of the lineage's initial chain.
#[test]
fn passive_replica_crosses_cancellations_before_the_first_accepted_event() {
    use crate::replica_cut::{CurrentViewRequest, collect_current_view};
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let (_scratch, path, mut replica) = receiver(&source);
    let page = |entries: Vec<ReplicaJournalEntry>, after: i64, replica: &mut EngineStore| {
        dohc_engine_collab::live_update_application::passive::apply_page(
            replica, "ws", after, 0, &entries, &NoFaults,
        )
    };
    let kept = |replica: &EngineStore| -> (i64, Option<i64>) {
        replica
            .read_with(|c| {
                c.query_row(
                    "SELECT (SELECT count(*) FROM replica_documents),(SELECT max(restore_generation) FROM replica_restore_cancellations)",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .unwrap()
    };
    let request: CurrentViewRequest = serde_json::from_value(
        serde_json::json!({"selectors":[{"versionId":"main","paths":[]}],"incarnation":"one"}),
    )
    .unwrap();
    let generation = |replica: &EngineStore| {
        collect_current_view(replica, "ws", &request).unwrap().files[0].restore_generation
    };
    let first = opening_cancellation(&source, 1, 1);
    let applied = page(
        vec![ReplicaJournalEntry::Cancellation(first.clone())],
        0,
        &mut replica,
    )
    .unwrap();
    assert_eq!((applied.applied, applied.journal_cursor), (1, 1));
    assert_eq!(
        kept(&replica),
        (0, Some(2)),
        "the record alone holds the generation"
    );
    drop(replica);
    let mut replica = EngineStore::open_passive(&path, 1, None, None).unwrap();
    assert_eq!(generation(&replica), Some(2));
    // The kept record is compared as a record, not as the text one build
    // serialized it to.
    replica
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "UPDATE replica_restore_cancellations SET record_json=json_object('authority',NULL,'cancellation',json(json_extract(record_json,'$.cancellation')),'journalCursor',json_extract(record_json,'$.journalCursor'),'relayDatabaseNamespace',json_extract(record_json,'$.relayDatabaseNamespace'))",
            )
            .map_err(StorageError::persist_public)
        })
        .unwrap();
    let replay = page(
        vec![ReplicaJournalEntry::Cancellation(first.clone())],
        0,
        &mut replica,
    )
    .unwrap();
    assert_eq!((replay.applied, replay.skipped), (0, 1));
    let mut changed = first.clone();
    changed.cancellation.fence.operation.operation_id = "changed".into();
    assert!(
        matches!(
            page(
                vec![ReplicaJournalEntry::Cancellation(changed)],
                0,
                &mut replica
            ),
            Err(ApplicationError::Conflict)
        ),
        "a replay at the record's cursor carries the record"
    );
    let mut moved = first;
    moved.journal_cursor = 2;
    assert!(
        matches!(
            page(
                vec![ReplicaJournalEntry::Cancellation(moved)],
                1,
                &mut replica
            ),
            Err(ApplicationError::Conflict)
        ),
        "the record's operation at another cursor"
    );
    let second = opening_cancellation(&source, 2, 2);
    let applied = page(
        vec![ReplicaJournalEntry::Cancellation(second)],
        1,
        &mut replica,
    )
    .unwrap();
    assert_eq!((applied.applied, applied.journal_cursor), (1, 2));
    assert_eq!(kept(&replica), (0, Some(3)));
    assert_eq!(generation(&replica), Some(3));
    // The first update, at the generation both cancellations reached.
    let initial = initial(&source);
    let unrelated = dohc_engine_collab::Ydoc::wire();
    unrelated.apply(&source.bytes).unwrap();
    let mut template = row(&mut source, 3, &initial, &unrelated);
    template
        .admitted
        .metadata
        .accepted
        .binding
        .restore_fence_generation = 3;
    template
        .authority
        .as_mut()
        .unwrap()
        .restore_fence_generation = 3;
    let mut stale = template.clone();
    stale
        .admitted
        .metadata
        .accepted
        .binding
        .restore_fence_generation = 2;
    let stale = row_with_count(
        &stale,
        3,
        1,
        &initial,
        unrelated.richdoc_append_paragraph("Stale."),
    );
    assert!(
        page(vec![ReplicaJournalEntry::Update(stale)], 2, &mut replica).is_err(),
        "the generation before refuses"
    );
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let update = row_with_count(
        &template,
        3,
        1,
        &initial,
        doc.richdoc_append_paragraph("After two cancellations."),
    );
    let applied = page(
        vec![ReplicaJournalEntry::Update(update.clone())],
        2,
        &mut replica,
    )
    .unwrap();
    assert_eq!(applied.applied, 1);
    let position: (i64, i64, String) = replica
        .read_with(|c| {
            c.query_row(
                "SELECT restore_generation,event_count,evidence_digest FROM replica_documents",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
        })
        .unwrap();
    assert_eq!(position, (3, 1, update.evidence_digest));
    assert_eq!(generation(&replica), Some(3));
}

/// Opus 2: a cancellation of a lineage the replica held and no longer marks,
/// replaced or deleted, skips as its deliveries do. One of a lineage the
/// replica never saw also skips when the relay reports no current authority.
#[test]
fn passive_cancellation_skips_retired_lineages_with_null_authority() {
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let record = opening_cancellation(&source, 1, 1);
    let page = |replica: &mut EngineStore| {
        dohc_engine_collab::live_update_application::passive::apply_page(
            replica,
            "ws",
            0,
            0,
            &[ReplicaJournalEntry::Cancellation(record.clone())],
            &NoFaults,
        )
        .unwrap()
    };
    let scratch = ScratchDir::new().unwrap();
    let mut unseen =
        EngineStore::open_passive(&scratch.path().join("unseen.db"), 0, None, None).unwrap();
    let skipped = page(&mut unseen);
    assert_eq!(
        (
            skipped.skipped,
            skipped.blocked_cursor,
            skipped.journal_cursor
        ),
        (1, None, 1)
    );
    let (_replaced_scratch, _path, mut replaced) = receiver(&source);
    replaced
        .write_with(&NoFaults, |tx| {
            crate::retire_ydoc_lineage_in_tx(tx, "ws", "main", "object")
        })
        .unwrap();
    // A delete leaves no archive; the applied base shows the replica held it.
    let (_deleted_scratch, _path, mut deleted) = receiver(&source);
    deleted
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM ydoc_docs WHERE object_id='object'", [])
                .map_err(StorageError::persist_public)
        })
        .unwrap();
    for (case, replica) in [("replaced", &mut replaced), ("deleted", &mut deleted)] {
        let skipped = page(replica);
        assert_eq!(
            (
                skipped.skipped,
                skipped.blocked_cursor,
                skipped.journal_cursor
            ),
            (1, None, 1),
            "{case}"
        );
        assert_eq!(count(replica, "replica_restore_cancellations"), 0, "{case}");
    }
}

/// Sol 3 and Opus 1: a cancellation of a lineage the replica never saw, with
/// no marker, archive or base, skips when its authority retires that
/// lineage, as a delivery's does: another lineage whose baseline the log has
/// reached, or a baseline at or below the epoch floor. Rows for another
/// document then apply on the same page. Null authority means no current
/// lineage. Authority that still names the lineage blocks at its cursor.
#[test]
fn passive_cancellation_of_an_unseen_lineage_skips_by_its_authority() {
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let unseen = "d".repeat(64);
    let mut record = opening_cancellation(&source, 1, 1);
    for binding in [
        &mut record.cancellation.fence.operation.old_binding,
        &mut record.cancellation.binding,
    ] {
        binding.object_id = "gone".into();
        binding.lineage_claim_id = unseen.clone();
    }
    let baseline = operations(&source.store);
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let previous = initial(&source);
    let update = counted_row(&mut source, 2, 1, &previous, &doc);
    let authority = |lineage: &str, baseline: i64| {
        Some(ReplicaAuthority {
            lineage_claim_id: lineage.into(),
            baseline_sequence: baseline,
            restore_fence_generation: 2,
        })
    };
    let other = "e".repeat(64);
    for (case, named, log_cursor, floor, skips) in [
        ("epoch", authority(&other, 1_000_000), 0, 1_000_000, true),
        ("authority", authority(&other, 999_999), 1_000_000, 0, true),
        ("none", None, 1_000_000, 1_000_000, true),
        (
            "current",
            authority(&unseen, 1_000_001),
            1_000_000,
            0,
            false,
        ),
    ] {
        let scratch = ScratchDir::new().unwrap();
        let mut replica =
            EngineStore::open_passive(&scratch.path().join("replica.db"), 0, None, None).unwrap();
        copy_blobs(&source.store, &mut replica);
        deliver(&mut replica, baseline.clone());
        replica
            .write_with(&NoFaults, |tx| {
                dohc_engine_storage::replica::advance_frontiers(tx, "ws", log_cursor, 0)
            })
            .unwrap();
        let mut entry = record.clone();
        entry.authority = named;
        let result = dohc_engine_collab::live_update_application::passive::apply_page(
            &mut replica,
            "ws",
            0,
            floor,
            &[
                ReplicaJournalEntry::Cancellation(entry),
                ReplicaJournalEntry::Update(update.clone()),
            ],
            &NoFaults,
        )
        .unwrap();
        let expected = if skips {
            (1, 1, None, 2)
        } else {
            (0, 0, Some(1), 0)
        };
        assert_eq!(
            (
                result.applied,
                result.skipped,
                result.blocked_cursor,
                result.journal_cursor
            ),
            expected,
            "{case}"
        );
        assert_eq!(
            count(&replica, "live_accepted_updates"),
            i64::from(skips),
            "{case}"
        );
        assert_eq!(
            count(&replica, "replica_restore_cancellations"),
            0,
            "{case}"
        );
    }
}

#[test]
fn passive_cancellation_authority_is_required_and_nullable() {
    use dohc_engine_collab::live_update_application::passive::ReplicaRestoreCancellation;
    let source = fixture_with_binding_generation(true, None, 1);
    let record = opening_cancellation(&source, 1, 1);
    let mut wire = serde_json::to_value(&record).unwrap();
    assert_eq!(wire.get("authority"), Some(&serde_json::Value::Null));
    assert_eq!(
        serde_json::from_value::<ReplicaRestoreCancellation>(wire.clone()).unwrap(),
        record
    );
    wire.as_object_mut().unwrap().remove("authority");
    assert!(serde_json::from_value::<ReplicaRestoreCancellation>(wire).is_err());
}

/// Fence a restore of `source`'s lineage at `terminal`, cancel it, and
/// register the lineage again at the generation after, as the host does once
/// the relay ends a fence nothing applied. Returns the cancellation.
fn fence_and_cancel(
    source: &mut Fixture,
    terminal: Option<LiveUpdateReceipt>,
) -> dohc_engine_collab::live_update_application::NativeRestoreCancellationReceipt {
    use dohc_engine_collab::live_update_application::{
        ApplicationHostCoordinate, NativeRestoreFence, RestoreDeliveryOrigin,
        RestoreFenceCancellation, RestoreFenceCancellationOutcome, cancel_restore_fence,
    };
    // The relay took every settlement, so the restore may fence. Before its
    // first contact there is nothing to take, and pushing would enroll.
    if source
        .store
        .read_with(|c| crate::workspace_replicates_with_relay(c, "ws"))
        .unwrap()
    {
        let pushed = operations(&source.store).last().unwrap().origin_seq;
        crate::cursor::write_pushed_seq(
            &mut source.store,
            "ws",
            "owner-origin",
            pushed,
            &NoFaults,
            &NoLiveLeases,
            300,
        )
        .unwrap();
    }
    let applied_sequence: i64 = source
        .store
        .read_with(|c| c.query_row("SELECT head_update_seq FROM ydoc_docs", [], |r| r.get(0)))
        .unwrap();
    let coordinate = ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 1,
        instance_id: "instance".into(),
        connection_id: "connection".into(),
    };
    let next = source.binding.restore_fence_generation + 1;
    let fence = NativeRestoreFence {
        point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
            journal_cursor: terminal.as_ref().map_or(0, |r| r.journal_cursor),
            receipt_digest: terminal.as_ref().map_or_else(
                || source.binding.lineage_claim_id.clone(),
                |r| r.update_digest.clone(),
            ),
        },
        operation_id: format!("restore-{next}"),
        relay_database_namespace: "relay".into(),
        old_binding: source.binding.clone(),
        host_id: "host".into(),
        new_fence: next,
        origin: RestoreDeliveryOrigin::Bootstrap {
            id: "bootstrap".into(),
        },
        terminal,
        applied_sequence,
    };
    source
        ._owner
        .fence_restore(
            &mut source.store,
            None,
            fence,
            coordinate.clone(),
            200,
            &NoFaults,
        )
        .unwrap();
    let input = RestoreFenceCancellation {
        operation_id: format!("restore-{next}"),
        object_id: "object".into(),
        lineage_claim_id: source.binding.lineage_claim_id.clone(),
        host_id: "host".into(),
        new_fence: next,
    };
    let RestoreFenceCancellationOutcome::FenceCancelled(cancelled) = cancel_restore_fence(
        &mut source.store,
        "relay",
        "ws",
        "host",
        &input,
        201,
        &NoFaults,
    )
    .unwrap() else {
        panic!("the committed fence ends in its cancellation");
    };
    source.binding.restore_fence_generation = next;
    source.handle = source
        ._owner
        .register(
            &mut source.store,
            "relay".into(),
            coordinate,
            source.binding.clone(),
        )
        .unwrap();
    *cancelled
}

/// Sol's round trip: the source settles, fences a restore, cancels it,
/// accepts its next update at the new generation and settles that too, with
/// no successor. That update's audit record carries the cancellation that
/// explains its generation step. A fresh passive replica given the baseline,
/// the control record and the update, then the audit and both settlements,
/// matches the source after a restart and keeps the exact control record.
/// The update without its control record refuses, and so does the audit
/// record with its cancellation removed or altered.
#[test]
fn passive_replica_round_trips_a_cancelled_restore_and_its_audit() {
    use dohc_engine_collab::live_update_application::passive::ReplicaRestoreCancellation;
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let baseline = operations(&source.store);
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let previous = initial(&source);
    let first = row(&mut source, 1, &previous, &doc);
    settle_through(
        &mut source,
        first.admitted.metadata.accepted.receipt.clone(),
        "before-restore",
    );
    let cancelled = fence_and_cancel(
        &mut source,
        Some(first.admitted.metadata.accepted.receipt.clone()),
    );
    let next = counted_row(&mut source, 3, 2, &first.evidence_digest, &doc);
    // The bootstrap's anchor stays at generation 1; the settlement crosses
    // the cancellation to it.
    settle_through(
        &mut source,
        next.admitted.metadata.accepted.receipt.clone(),
        "after-cancellation",
    );
    let record = ReplicaRestoreCancellation {
        relay_database_namespace: "relay".into(),
        journal_cursor: 2,
        cancellation: cancelled,
        authority: None,
    };
    // The update's audit record names the cancellation exactly.
    let ops = operations(&source.store);
    let audit = ops
        .iter()
        .rev()
        .find(|op| op.op_kind == application_record::EVENT_OP)
        .unwrap()
        .clone();
    let manifest: chunks::Manifest =
        serde_json::from_value(audit.payload["manifest"].clone()).unwrap();
    let text = source
        .store
        .read_with(|conn| {
            use std::io::Read;
            let mut reader = chunks::ChunkReader::new(conn, &manifest).unwrap();
            let mut text = String::new();
            reader.read_to_string(&mut text).unwrap();
            reader.finish().unwrap();
            Ok::<_, SyncError>(text)
        })
        .unwrap();
    let start = text.find("\"cancelledRestores\":").unwrap() + "\"cancelledRestores\":".len();
    let chain = &text[start..start + text[start..].find(",\"contentCoordinate\"").unwrap()];
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(chain).unwrap(),
        json!([{"originAdoptionId": null, "cancellation": &record.cancellation}])
    );
    let fresh = || {
        let scratch = ScratchDir::new().unwrap();
        let path = scratch.path().join("replica.db");
        let mut replica = EngineStore::open_passive(&path, 0, None, None).unwrap();
        copy_blobs(&source.store, &mut replica);
        deliver(&mut replica, baseline.clone());
        let page = |entries: Vec<ReplicaJournalEntry>, after: i64, replica: &mut EngineStore| {
            dohc_engine_collab::live_update_application::passive::apply_page(
                replica, "ws", after, 0, &entries, &NoFaults,
            )
        };
        assert_eq!(
            page(
                vec![ReplicaJournalEntry::Update(first.clone())],
                0,
                &mut replica
            )
            .unwrap()
            .applied,
            1
        );
        assert!(
            page(
                vec![ReplicaJournalEntry::Update(next.clone())],
                1,
                &mut replica
            )
            .is_err(),
            "the update needs its control record"
        );
        let entries = vec![
            ReplicaJournalEntry::Cancellation(record.clone()),
            ReplicaJournalEntry::Update(next.clone()),
        ];
        assert_eq!(page(entries, 1, &mut replica).unwrap().applied, 2);
        (scratch, path, replica)
    };
    let history = |store: &EngineStore| -> Vec<(i64, String, String, Option<i64>)> {
        store
            .read_with(|c| {
                c.prepare("SELECT event_count,evidence_digest,record_digest,restore_generation FROM live_audit_events ORDER BY event_count")?
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap()
    };
    let (_scratch, path, mut replica) = fresh();
    deliver(&mut replica, ops.clone());
    drop(replica);
    let replica = EngineStore::open_passive(&path, 1, None, None).unwrap();
    assert_eq!(state(&replica), state(&source.store));
    assert_eq!(history(&replica), history(&source.store));
    assert_eq!(history(&replica)[1].3, Some(2));
    assert_eq!(
        count(&replica, "live_audit_settlements"),
        2,
        "the source's settlements"
    );
    let moment = |store: &EngineStore, id: &str| -> String {
        store
            .read_with(|c| {
                c.query_row(
                    "SELECT b.text FROM moments m JOIN blobs b ON b.sha256=m.after_blob_sha256 WHERE m.moment_id=?1",
                    [id],
                    |r| r.get(0),
                )
            })
            .unwrap()
    };
    for id in ["before-restore", "after-cancellation"] {
        assert_eq!(moment(&replica, id), moment(&source.store, id), "{id}");
    }
    let (position, kept): ((i64, i64, String), String) = replica
        .read_with(|c| {
            Ok::<_, rusqlite::Error>((
                c.query_row(
                    "SELECT restore_generation,event_count,evidence_digest FROM replica_documents",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?,
                c.query_row(
                    "SELECT record_json FROM replica_restore_cancellations",
                    [],
                    |r| r.get(0),
                )?,
            ))
        })
        .unwrap();
    assert_eq!(position, (2, 2, next.evidence_digest.clone()));
    assert_eq!(
        serde_json::from_str::<ReplicaRestoreCancellation>(&kept).unwrap(),
        record
    );
    // The record with its cancellation removed or altered refuses on a
    // replica that holds everything before it.
    let generation = chain.replace(
        "\"restoreFenceGeneration\":2",
        "\"restoreFenceGeneration\":3",
    );
    let endpoint = chain.replace(&first.evidence_digest, &"f".repeat(64));
    // A bootstrap's fence names no owner adoption.
    let adoption = chain.replace(
        "\"originAdoptionId\":null",
        "\"originAdoptionId\":\"bootstrap\"",
    );
    assert!(generation != chain && endpoint != chain && adoption != chain);
    for (case, altered) in [
        ("removed", "[]"),
        ("generation", generation.as_str()),
        ("endpoint", endpoint.as_str()),
        ("adoption", adoption.as_str()),
    ] {
        let (_scratch, _path, mut replica) = fresh();
        deliver(
            &mut replica,
            ops.iter()
                .filter(|op| op.origin_seq < audit.origin_seq)
                .cloned()
                .collect(),
        );
        let changed = replica
            .read_with(|conn| {
                use std::io::Write;
                let mut writer = chunks::ChunkWriter::new(conn);
                writer
                    .write_all(text.replace(chain, altered).as_bytes())
                    .unwrap();
                writer.finish()
            })
            .unwrap();
        let mut op = audit.clone();
        op.payload["manifest"] = serde_json::to_value(&changed).unwrap();
        op.relay_seq = Some(op.origin_seq + 1);
        let result = crate::apply_replication_envelope(
            &mut replica,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(
            matches!(result.primary, ApplyDisposition::Refused(_)),
            "{case}: {:?}",
            result.primary
        );
        assert_eq!(count(&replica, "live_audit_events"), 1, "{case}");
    }
}

/// An owner lineage, adopted from ordinary history, fences a restore, cancels
/// it and releases, and a successor adopts under its own ID and host, twice. The
/// second successor's update carries both cancellations, each with the
/// lineage's origin adoption, and a fresh passive replica imports it. The
/// record with an adoption that is not the origin's refuses.
#[test]
fn a_successors_cancelled_restore_exports_and_imports_with_its_origin() {
    use dohc_engine_collab::live_update_application::{
        ApplicationHostCoordinate, NativeHistoryReconstruction, NativeRestoreFence,
        OwnerAdoptionCut, Release, RestoreDeliveryOrigin, RestoreFenceCancellation,
        RestoreFenceCancellationOutcome, RetainedPrefix, RetirementKey, RetirementScope,
        adopt_owner_committed, cancel_restore_fence, capture_imported_owner_activation,
        release_activation,
    };
    let (mut f, source, _, root) = imported_owner(false, false);
    let key = dohc_engine_collab::DocKey::new("ws", "main", "object").unwrap();
    let execute = |store: &mut EngineStore, sql: &str| {
        store
            .write_with(&NoFaults, |tx| {
                tx.execute_batch(sql).map_err(StorageError::persist_public)
            })
            .unwrap();
    };
    let first: LiveUpdateReceipt = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM live_device_update_applications WHERE journal_cursor=1",
                [],
                |r| {
                    Ok(LiveUpdateReceipt {
                        delivery_id: r.get(0)?,
                        update_digest: r.get(1)?,
                        journal_cursor: r.get(2)?,
                        accepting_host_epoch: r.get(3)?,
                    })
                },
            )
        })
        .unwrap();
    let (baseline_sequence, baseline_at): (i64, i64) = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT baseline_moment_relay_sequence,baseline_registered_at_ms FROM live_owner_adoptions",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    let mut activation = root.activation_id.clone();
    let mut coordinate = ApplicationHostCoordinate {
        host_id: "service-host".into(),
        host_epoch: 1,
        instance_id: "self-host-service".into(),
        connection_id: "connection".into(),
    };
    // A release needs every accepted event settled.
    settle_bootstrap_publication(&mut f, 1, "before-restores").unwrap();
    for round in 1..=2 {
        // The relay took every settlement, so the restore may fence.
        let pushed = crate::list_replication_ops(&f.store, "ws", "service-origin", -1, 500)
            .unwrap()
            .last()
            .unwrap()
            .origin_seq;
        crate::cursor::write_pushed_seq(
            &mut f.store,
            "ws",
            "service-origin",
            pushed,
            &NoFaults,
            &NoLiveLeases,
            300,
        )
        .unwrap();
        // The tip the current activation holds: its last application at
        // this generation, or its adopted origin.
        let applied_sequence: i64 = f
            .store
            .read_with(|c| {
                c.query_row(
                    "SELECT coalesce((SELECT d.local_ydoc_sequence FROM live_device_update_applications d WHERE d.restore_fence_generation=?1 AND d.journal_cursor>a.terminal_cursor ORDER BY d.journal_cursor DESC LIMIT 1),a.local_ydoc_sequence) FROM live_owner_activations a WHERE a.activation_id=?2",
                    params![f.binding.restore_fence_generation, activation],
                    |r| r.get(0),
                )
            })
            .unwrap();
        let next = f.binding.restore_fence_generation + 1;
        let operation = format!("restore-{round}");
        f._owner
            .fence_restore(
                &mut f.store,
                None,
                NativeRestoreFence {
                    point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
                        journal_cursor: first.journal_cursor,
                        receipt_digest: first.update_digest.clone(),
                    },
                    operation_id: operation.clone(),
                    relay_database_namespace: "relay".into(),
                    old_binding: f.binding.clone(),
                    host_id: coordinate.host_id.clone(),
                    new_fence: next,
                    origin: RestoreDeliveryOrigin::Owner {
                        id: activation.clone(),
                    },
                    terminal: Some(first.clone()),
                    applied_sequence,
                },
                coordinate.clone(),
                300 + round,
                &NoFaults,
            )
            .unwrap();
        let cancelled = cancel_restore_fence(
            &mut f.store,
            "relay",
            "ws",
            &coordinate.host_id,
            &RestoreFenceCancellation {
                operation_id: operation,
                object_id: "object".into(),
                lineage_claim_id: f.binding.lineage_claim_id.clone(),
                host_id: coordinate.host_id.clone(),
                new_fence: next,
            },
            310 + round,
            &NoFaults,
        )
        .unwrap();
        assert!(matches!(
            cancelled,
            RestoreFenceCancellationOutcome::FenceCancelled(_)
        ));
        f.binding.restore_fence_generation = next;
        // The document parks and the activation releases at the cancelled
        // generation; once it returns, a successor captures and adopts.
        execute(
            &mut f.store,
            "INSERT OR IGNORE INTO hosted_replicas(workspace_id,scope_generation,created_at_ms,last_outbound_seq)
               VALUES ('ws',1,0,(SELECT max(origin_seq) FROM replication_log WHERE workspace_id='ws' AND origin_id='service-origin'));
             INSERT OR REPLACE INTO hosted_documents(workspace_id,object_id,path,state,scope_generation) VALUES ('ws','object','note.md','parked',0)",
        );
        let released = release_activation(
            &mut f.store,
            &mut WriterDocCache::new(),
            &RetirementScope {
                namespace: "relay",
                workspace_id: "ws",
                max_deliveries: 8,
                max_applications: 8,
            },
            &RetirementKey {
                object_id: "object".into(),
                lineage_claim_id: f.binding.lineage_claim_id.clone(),
                activation_id: activation.clone(),
                restore_fence_generation: next,
                accepted_through: 1,
            },
            &coordinate,
            320 + round,
            &NoFaults,
        )
        .unwrap();
        let Release::Released {
            replayed: false,
            boundary: Some(boundary),
        } = released
        else {
            panic!("round {round}: {released:?}");
        };
        execute(
            &mut f.store,
            "INSERT OR REPLACE INTO hosted_documents(workspace_id,object_id,path,state,scope_generation) VALUES ('ws','object','note.md','ready',1);
             UPDATE hosted_replicas SET main_cursor=(SELECT CAST(cursor AS INTEGER) FROM sync_relay_cursors WHERE workspace_id='ws')",
        );
        let captured = capture_imported_owner_activation(
            &mut f.store,
            "relay",
            &key,
            "note.md",
            1_000_000,
            &NoFaults,
            None,
        )
        .unwrap();
        coordinate = ApplicationHostCoordinate {
            host_id: format!("successor-{round}"),
            host_epoch: 1,
            instance_id: "instance".into(),
            connection_id: "connection".into(),
        };
        f.handle = f
            ._owner
            .register_activation(
                &mut f.store,
                "relay".into(),
                coordinate.clone(),
                f.binding.clone(),
                captured.activation_id.clone(),
            )
            .unwrap();
        let cut = OwnerAdoptionCut {
            relay_database_namespace: "relay".into(),
            adoption_id: captured.activation_id.clone(),
            source_moment_id: captured.source.source_moment_id.clone(),
            source_digest: captured.source.source_digest.clone(),
            source_byte_length: captured.source.source_byte_length,
            baseline_moment_relay_sequence: baseline_sequence,
            baseline_registered_at_ms: baseline_at,
            baseline_bytes: source.bytes.clone(),
            expected_local_sequence: captured.source.native_head_sequence,
            events: vec![],
            terminal_receipt: boundary.terminal_receipt.clone(),
            retained_prefix: Some(RetainedPrefix {
                terminal_receipt: boundary.terminal_receipt,
                event_count: boundary.event_count,
                history_evidence_digest: boundary.history_evidence_digest,
                predecessor_activation_id: activation.clone(),
            }),
            outbox_limits: dohc_engine_collab::OwnerOutboxLimits {
                max_pending_bytes: 1_000_000,
                max_pending_age_ms: 100_000,
            },
            reconstruction: NativeHistoryReconstruction {
                working_reserve_bytes: 8 * 1024 * 1024,
            },
        };
        adopt_owner_committed(
            &mut f.store,
            &f.handle,
            cut,
            1_000_000,
            10,
            330 + round,
            &NoFaults,
            None,
            |tx, namespace, binding, _| {
                journal_live_base_in_tx(tx, namespace, binding, 330)
                    .map(|_| ())
                    .map_err(|e| ApplicationError::Storage(StorageError::persist_public(e)))
            },
        )
        .unwrap();
        activation = captured.activation_id;
    }
    let next = dohc_engine_collab::Ydoc::wire();
    next.apply(&f.bytes).unwrap();
    next.rewrite_content_to_markdown_preserving_source(
        ContentKind::Richdoc,
        "After two successors.",
    )
    .unwrap();
    f.bytes = next.encode_full_state();
    accept_named_event(&mut f, 2, "after-successors".into());
    let ops = crate::list_replication_ops(&f.store, "ws", "service-origin", -1, 500).unwrap();
    let audit = ops
        .iter()
        .rev()
        .find(|op| op.op_kind == application_record::EVENT_OP)
        .unwrap()
        .clone();
    let manifest: chunks::Manifest =
        serde_json::from_value(audit.payload["manifest"].clone()).unwrap();
    let text = f
        .store
        .read_with(|conn| {
            use std::io::Read;
            let mut reader = chunks::ChunkReader::new(conn, &manifest).unwrap();
            let mut text = String::new();
            reader.read_to_string(&mut text).unwrap();
            reader.finish().unwrap();
            Ok::<_, SyncError>(text)
        })
        .unwrap();
    let start = text.find("\"cancelledRestores\":").unwrap() + "\"cancelledRestores\":".len();
    let chain = &text[start..start + text[start..].find(",\"contentCoordinate\"").unwrap()];
    let carried: serde_json::Value = serde_json::from_str(chain).unwrap();
    let fenced: Vec<(String, String, String)> = carried
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let operation = &c["cancellation"]["fence"]["operation"];
            (
                c["originAdoptionId"].as_str().unwrap().to_owned(),
                operation["origin"]["id"].as_str().unwrap().to_owned(),
                operation["hostId"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(fenced.len(), 2);
    assert_eq!(
        fenced[0],
        (
            root.activation_id.clone(),
            root.activation_id.clone(),
            "service-host".to_owned()
        )
    );
    assert_eq!(fenced[1].0, root.activation_id);
    assert_ne!(
        fenced[1].1, root.activation_id,
        "the first successor fenced"
    );
    assert_eq!(fenced[1].2, "successor-1");
    // The replica holds the source's history, then what the owner's store
    // journaled from its event zero.
    let replica = |altered: Option<&str>| {
        let scratch = ScratchDir::new().unwrap();
        let path = scratch.path().join("replica.db");
        let mut replica = EngineStore::open_passive(&path, 0, None, None).unwrap();
        copy_blobs(&f.store, &mut replica);
        deliver(&mut replica, operations(&source.store));
        let mut ops = ops.clone();
        if let Some(altered) = altered {
            let changed = replica
                .read_with(|conn| {
                    use std::io::Write;
                    let mut writer = chunks::ChunkWriter::new(conn);
                    writer
                        .write_all(text.replace(chain, altered).as_bytes())
                        .unwrap();
                    writer.finish()
                })
                .unwrap();
            let op = ops
                .iter_mut()
                .find(|op| op.origin_seq == audit.origin_seq)
                .unwrap();
            op.payload["manifest"] = serde_json::to_value(&changed).unwrap();
        }
        (scratch, path, replica, ops)
    };
    let (_scratch, _path, mut imported, ops_in) = replica(None);
    deliver(&mut imported, ops_in);
    let generations = |store: &EngineStore| -> Vec<Option<i64>> {
        store
            .read_with(|c| {
                c.prepare("SELECT restore_generation FROM live_audit_events ORDER BY event_count")?
                    .query_map([], |r| r.get(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap()
    };
    assert_eq!(generations(&imported), vec![Some(0), Some(2)]);
    assert_eq!(generations(&imported), generations(&f.store));
    // The successor's cancellation names another adoption.
    let named = format!("\"originAdoptionId\":\"{}\"", root.activation_id);
    let second = chain.match_indices(&named).nth(1).unwrap().0;
    let elsewhere = format!(
        "{}\"originAdoptionId\":\"elsewhere\"{}",
        &chain[..second],
        &chain[second + named.len()..]
    );
    let (_scratch, _path, mut refused, ops_in) = replica(Some(&elsewhere));
    for mut op in ops_in {
        op.relay_seq = Some(op.origin_seq + 1);
        let result = crate::apply_replication_envelope(
            &mut refused,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        if op.origin_seq == audit.origin_seq {
            assert!(
                matches!(result.primary, ApplyDisposition::Refused(_)),
                "{:?}",
                result.primary
            );
            break;
        }
    }
    assert_eq!(generations(&refused), vec![Some(0)]);
}

/// An owner publishes its event zero before the source's event zero
/// arrives. The import keeps both records without a conflict row, and the
/// owner's publication still replays. Launch gives the lineage one event zero.
#[test]
fn an_event_zero_imported_after_owner_publication_keeps_both_and_replays() {
    let (mut f, mut source, _, _) = imported_owner(false, false);
    assert_eq!(count(&f.store, "live_audit_bases"), 0);
    source
        .store
        .write_with(&NoFaults, |tx| {
            journal_live_base_in_tx(tx, "relay", &source.binding, 300)
        })
        .unwrap();
    copy_blobs(&source.store, &mut f.store);
    deliver(&mut f.store, vec![published(&source)]);
    let (imported, published): (String, String) = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.record_json,p.record_json FROM live_audit_bases b JOIN live_audit_base_publications p USING(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap();
    assert_ne!(imported, published);
    assert_eq!(count(&f.store, "live_audit_base_conflicts"), 0);
    let before = crate::list_replication_ops(&f.store, "ws", "service-origin", -1, 500).unwrap();
    f.store
        .write_with(&NoFaults, |tx| {
            journal_live_base_in_tx(tx, "relay", &f.binding, 301)
        })
        .unwrap();
    assert_eq!(
        crate::list_replication_ops(&f.store, "ws", "service-origin", -1, 500).unwrap(),
        before
    );
}

/// A lineage its source bootstrapped and audited is adopted by an owner on a
/// hosted store, which fences a restore under its adoption, cancels it, and
/// accepts the next update. The update's record exports with the adoption
/// and a fresh passive replica imports it after the source's event zero.
#[test]
#[ignore = "adoption republishes event zero instead of continuing the audited origin"]
fn an_audited_sources_adopted_owner_exports_and_imports_its_cancelled_restore() {
    use dohc_engine_collab::live_update_application::{
        ApplicationHostCoordinate, NativeRestoreFence, RestoreDeliveryOrigin,
        RestoreFenceCancellation, RestoreFenceCancellationOutcome, cancel_restore_fence,
    };
    let (mut f, source, _, root) = imported_owner(false, true);
    let first: LiveUpdateReceipt = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM live_device_update_applications WHERE journal_cursor=1",
                [],
                |r| {
                    Ok(LiveUpdateReceipt {
                        delivery_id: r.get(0)?,
                        update_digest: r.get(1)?,
                        journal_cursor: r.get(2)?,
                        accepting_host_epoch: r.get(3)?,
                    })
                },
            )
        })
        .unwrap();
    let coordinate = ApplicationHostCoordinate {
        host_id: "service-host".into(),
        host_epoch: 1,
        instance_id: "self-host-service".into(),
        connection_id: "connection".into(),
    };
    let pushed = crate::list_replication_ops(&f.store, "ws", "service-origin", -1, 500)
        .unwrap()
        .last()
        .unwrap()
        .origin_seq;
    crate::cursor::write_pushed_seq(
        &mut f.store,
        "ws",
        "service-origin",
        pushed,
        &NoFaults,
        &NoLiveLeases,
        300,
    )
    .unwrap();
    let applied_sequence: i64 = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT local_ydoc_sequence FROM live_device_update_applications WHERE journal_cursor=1",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let next = f.binding.restore_fence_generation + 1;
    f._owner
        .fence_restore(
            &mut f.store,
            None,
            NativeRestoreFence {
                point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
                    journal_cursor: first.journal_cursor,
                    receipt_digest: first.update_digest.clone(),
                },
                operation_id: "restore".into(),
                relay_database_namespace: "relay".into(),
                old_binding: f.binding.clone(),
                host_id: coordinate.host_id.clone(),
                new_fence: next,
                origin: RestoreDeliveryOrigin::Owner {
                    id: root.activation_id.clone(),
                },
                terminal: Some(first),
                applied_sequence,
            },
            coordinate.clone(),
            301,
            &NoFaults,
        )
        .unwrap();
    let cancelled = cancel_restore_fence(
        &mut f.store,
        "relay",
        "ws",
        &coordinate.host_id,
        &RestoreFenceCancellation {
            operation_id: "restore".into(),
            object_id: "object".into(),
            lineage_claim_id: f.binding.lineage_claim_id.clone(),
            host_id: coordinate.host_id.clone(),
            new_fence: next,
        },
        302,
        &NoFaults,
    )
    .unwrap();
    assert!(matches!(
        cancelled,
        RestoreFenceCancellationOutcome::FenceCancelled(_)
    ));
    f.binding.restore_fence_generation = next;
    f.handle = f
        ._owner
        .register(&mut f.store, "relay".into(), coordinate, f.binding.clone())
        .unwrap();
    let after = dohc_engine_collab::Ydoc::wire();
    after.apply(&f.bytes).unwrap();
    after
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "After the cancel.")
        .unwrap();
    f.bytes = after.encode_full_state();
    accept_named_event(&mut f, 2, "after-cancel".into());
    let ops = crate::list_replication_ops(&f.store, "ws", "service-origin", -1, 500).unwrap();
    let scratch = ScratchDir::new().unwrap();
    let path = scratch.path().join("replica.db");
    let mut replica = EngineStore::open_passive(&path, 0, None, None).unwrap();
    copy_blobs(&f.store, &mut replica);
    deliver(&mut replica, operations(&source.store));
    deliver(&mut replica, ops);
    let generations = |store: &EngineStore| -> Vec<Option<i64>> {
        store
            .read_with(|c| {
                c.prepare("SELECT restore_generation FROM live_audit_events ORDER BY event_count")?
                    .query_map([], |r| r.get(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap()
    };
    assert_eq!(generations(&f.store), vec![Some(0), Some(1)]);
    assert_eq!(generations(&replica), generations(&f.store));
}

#[test]
fn a_note_keeps_saving_after_a_cancelled_restore() {
    use dohc_engine_collab::live_update_application::{
        ApplicationHostCoordinate, NativeRestoreFence, RestoreDeliveryOrigin,
        RestoreFenceCancellation, RestoreFenceCancellationOutcome, cancel_restore_fence,
    };
    let (mut f, _source, baseline, root) = imported_owner(false, false);
    let first: LiveUpdateReceipt = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM live_device_update_applications WHERE journal_cursor=1",
                [],
                |r| {
                    Ok(LiveUpdateReceipt {
                        delivery_id: r.get(0)?,
                        update_digest: r.get(1)?,
                        journal_cursor: r.get(2)?,
                        accepting_host_epoch: r.get(3)?,
                    })
                },
            )
        })
        .unwrap();
    let coordinate = ApplicationHostCoordinate {
        host_id: "service-host".into(),
        host_epoch: 1,
        instance_id: "self-host-service".into(),
        connection_id: "connection".into(),
    };
    let pushed = crate::list_replication_ops(&f.store, "ws", "service-origin", -1, 500)
        .unwrap()
        .last()
        .unwrap()
        .origin_seq;
    crate::cursor::write_pushed_seq(
        &mut f.store,
        "ws",
        "service-origin",
        pushed,
        &NoFaults,
        &NoLiveLeases,
        300,
    )
    .unwrap();
    let applied_sequence: i64 = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT local_ydoc_sequence FROM live_device_update_applications WHERE journal_cursor=1",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let next = f.binding.restore_fence_generation + 1;
    f._owner
        .fence_restore(
            &mut f.store,
            None,
            NativeRestoreFence {
                point: dohc_engine_collab::live_update_application::NativeRestoreSelection {
                    journal_cursor: first.journal_cursor,
                    receipt_digest: first.update_digest.clone(),
                },
                operation_id: "restore".into(),
                relay_database_namespace: "relay".into(),
                old_binding: f.binding.clone(),
                host_id: coordinate.host_id.clone(),
                new_fence: next,
                origin: RestoreDeliveryOrigin::Owner {
                    id: root.activation_id.clone(),
                },
                terminal: Some(first),
                applied_sequence,
            },
            coordinate.clone(),
            301,
            &NoFaults,
        )
        .unwrap();
    let cancelled = cancel_restore_fence(
        &mut f.store,
        "relay",
        "ws",
        &coordinate.host_id,
        &RestoreFenceCancellation {
            operation_id: "restore".into(),
            object_id: "object".into(),
            lineage_claim_id: f.binding.lineage_claim_id.clone(),
            host_id: coordinate.host_id.clone(),
            new_fence: next,
        },
        302,
        &NoFaults,
    )
    .unwrap();
    assert!(matches!(
        cancelled,
        RestoreFenceCancellationOutcome::FenceCancelled(_)
    ));
    f.binding.restore_fence_generation = next;
    f.handle = f
        ._owner
        .register(&mut f.store, "relay".into(), coordinate, f.binding.clone())
        .unwrap();
    let after = dohc_engine_collab::Ydoc::wire();
    after.apply(&f.bytes).unwrap();
    after
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "After the cancel.")
        .unwrap();
    f.bytes = after.encode_full_state();
    accept_named_event(&mut f, 2, "after-cancel".into());
    let terminal = LiveUpdateReceipt {
        delivery_id: "after-cancel".into(),
        update_digest: hex_sha256(&f.bytes),
        journal_cursor: 2,
        accepting_host_epoch: 1,
    };
    let moment_id = "settle-after-cancel";
    try_settle_through(&mut f, terminal.clone(), moment_id).unwrap();
    let (id, previous, cursor, generation, restore): (String, i64, i64, i64, Option<String>) = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT settlement_id,previous_cursor,terminal_cursor,json_extract(binding_json,'$.restoreFenceGeneration'),restore_operation_id FROM live_device_settlements",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
        })
        .unwrap();
    assert_eq!(count(&f.store, "live_device_settlements"), 1);
    assert_eq!(previous, 0);
    assert_eq!(cursor, terminal.journal_cursor);
    assert_eq!(generation, next);
    assert_eq!(restore, None);
    let snapshot = VersionedTextStore::new(&mut f.store)
        .read_text("ws", "main", "note.md")
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.text, "After the cancel.");
    assert_eq!(snapshot.blob_sha256, hex_sha256(b"After the cancel."));
    let published = crate::list_replication_ops(&f.store, "ws", "service-origin", -1, 500).unwrap();
    let pair = published
        .iter()
        .filter(|op| {
            op.op_kind == settlement_record::SETTLEMENT_OP
                || (op.op_kind == "moment.append" && op.payload["momentId"] == moment_id)
        })
        .collect::<Vec<_>>();
    assert_eq!(pair.len(), 2);
    assert_eq!(pair[0].op_kind, settlement_record::SETTLEMENT_OP);
    assert_eq!(pair[1].op_kind, "moment.append");
    assert_eq!(pair[1].payload["payloadBeforeBlobSha256"], baseline);
    assert_eq!(pair[1].payload["beforeLatestMomentId"], "bootstrap-moment");
    assert_eq!(pair[0].payload["record"]["previousCursor"], 0);
    assert_eq!(
        pair[0].payload["record"]["terminalCursor"],
        terminal.journal_cursor
    );
    assert_eq!(
        pair[0].payload["record"]["binding"]["restoreFenceGeneration"],
        next
    );
    assert_eq!(
        pair[0].payload["record"]["markdownDigest"],
        snapshot.blob_sha256
    );
    assert_eq!(
        pair[1].payload["settlementReference"]["record"],
        pair[0].payload["record"]
    );
    assert_eq!(count(&f.store, "live_audit_settlement_publications"), 1);
    f.store
        .write_with(&NoFaults, |tx| {
            journal_live_settlement_in_tx(tx, "ws", &id, 303)
        })
        .unwrap();
    assert_eq!(
        crate::list_replication_ops(&f.store, "ws", "service-origin", -1, 500).unwrap(),
        published
    );
}

/// A bootstrap lineage accepts an update, fences and cancels two restores
/// without settling, then accepts an update at the third generation. Its
/// settlement covers both updates across the cancellations and keeps the
/// bootstrap's anchor; no restore settles and no successor adopts. With the
/// earlier cancellation missing or altered, the same settlement refuses.
#[test]
fn a_settlement_interval_crosses_cancelled_restores_only_through_their_evidence() {
    for case in ["kept", "missing", "altered"] {
        let mut source = fixture_with_binding_generation(true, None, 1);
        bootstrap(&mut source, false).unwrap();
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.apply(&source.bytes).unwrap();
        let previous = initial(&source);
        let first = row(&mut source, 1, &previous, &doc);
        let terminal = Some(first.admitted.metadata.accepted.receipt.clone());
        fence_and_cancel(&mut source, terminal.clone());
        fence_and_cancel(&mut source, terminal);
        let next = counted_row(&mut source, 4, 2, &first.evidence_digest, &doc);
        assert_eq!(source.binding.restore_fence_generation, 3);
        // The latest cancellation stays intact, so only the crossing reads
        // the earlier one.
        let forge = match case {
            "missing" => {
                "UPDATE live_restore_fences SET cancelled_json=NULL WHERE new_generation=2"
            }
            "altered" => {
                "UPDATE live_restore_fences SET cancelled_json=json_set(cancelled_json,'$.fence.operation.hostId','elsewhere') WHERE new_generation=2"
            }
            _ => "SELECT 1",
        };
        source
            .store
            .write_with(&NoFaults, |tx| {
                tx.execute_batch(forge)
                    .map_err(StorageError::persist_public)
            })
            .unwrap();
        let settled = try_settle_through(
            &mut source,
            next.admitted.metadata.accepted.receipt.clone(),
            "crossed",
        );
        if case != "kept" {
            assert!(settled.is_err(), "{case}");
            assert_eq!(count(&source.store, "live_device_settlements"), 0, "{case}");
            continue;
        }
        settled.unwrap();
        let (kind, previous, terminal, applications, binding): (String, i64, i64, i64, String) =
            source
                .store
                .read_with(|c| {
                    c.query_row(
                        "SELECT settlement_kind,previous_cursor,terminal_cursor,application_count,binding_json FROM live_device_settlements",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                    )
                })
                .unwrap();
        assert_eq!(
            (kind.as_str(), previous, terminal, applications),
            ("ordinary", 0, 4, 2)
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&binding).unwrap()["restoreFenceGeneration"],
            3
        );
        assert_eq!(count(&source.store, "live_owner_activations"), 0);
        // A passive replica imports the audit and the settlement that
        // crosses both generations.
        let (_scratch, _path, replica) = receiver(&source);
        assert_eq!(count(&replica, "live_audit_settlements"), 1);
        let moment = |store: &EngineStore| -> String {
            store
                .read_with(|c| {
                    c.query_row(
                        "SELECT b.text FROM moments m JOIN blobs b ON b.sha256=m.after_blob_sha256 WHERE m.moment_id='crossed'",
                        [],
                        |r| r.get(0),
                    )
                })
                .unwrap()
        };
        assert_eq!(moment(&replica), moment(&source.store));
    }
}

/// A lineage cancels more restores than one chain holds, split by accepted
/// events so each event's span stays within it. The settlement over all three
/// events and a fresh replica's import of the audit both cross the whole
/// history, each span from the event before it.
#[test]
fn cancellations_beyond_one_chain_settle_and_import_when_events_split_them() {
    use dohc_engine_collab::live_update_application::MAX_CANCELLED_RESTORES;
    let spans = [2048, MAX_CANCELLED_RESTORES as i64 + 2 - 2048];
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let mut previous = initial(&source);
    let mut last = row(&mut source, 1, &previous, &doc);
    let mut cursor = 1;
    for (index, span) in spans.into_iter().enumerate() {
        let terminal = Some(last.admitted.metadata.accepted.receipt.clone());
        for _ in 0..span {
            fence_and_cancel(&mut source, terminal.clone());
        }
        cursor += span + 1;
        previous = last.evidence_digest.clone();
        last = counted_row(&mut source, cursor, index as i64 + 2, &previous, &doc);
    }
    assert_eq!(
        source.binding.restore_fence_generation,
        1 + spans.iter().sum::<i64>()
    );
    assert!(spans.iter().sum::<i64>() > MAX_CANCELLED_RESTORES as i64);
    settle_through(
        &mut source,
        last.admitted.metadata.accepted.receipt.clone(),
        "crossed",
    );
    let (previous_cursor, terminal, applications): (i64, i64, i64) = source
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT previous_cursor,terminal_cursor,application_count FROM live_device_settlements",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
        })
        .unwrap();
    assert_eq!((previous_cursor, terminal, applications), (0, cursor, 3));
    let (_scratch, _path, replica) = receiver(&source);
    let generations = |store: &EngineStore| -> Vec<Option<i64>> {
        store
            .read_with(|c| {
                c.prepare("SELECT restore_generation FROM live_audit_events ORDER BY event_count")?
                    .query_map([], |r| r.get(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap()
    };
    assert_eq!(
        generations(&replica),
        vec![
            Some(1),
            Some(2049),
            Some(source.binding.restore_fence_generation)
        ]
    );
    assert_eq!(generations(&replica), generations(&source.store));
    assert_eq!(count(&replica, "live_audit_settlements"), 1);
}

/// Sol 1: before the relay's first contact, a bootstrap lineage cancels a
/// restore, accepts an update and settles at generation 1, then cancels
/// another and accepts an update at generation 2. Enrollment exports both
/// events, then the earlier settlement, crossing from its own generation
/// rather than the later event's, and finishes. A fresh replica imports it.
#[test]
fn enrollment_exports_a_first_settlement_from_before_a_later_cancellation() {
    let mut source = fixture(false);
    bootstrap(&mut source, false).unwrap();
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    fence_and_cancel(&mut source, None);
    let previous = initial(&source);
    let first = counted_row(&mut source, 2, 1, &previous, &doc);
    let terminal = first.admitted.metadata.accepted.receipt.clone();
    settle_through(&mut source, terminal.clone(), "first");
    fence_and_cancel(&mut source, Some(terminal));
    counted_row(&mut source, 4, 2, &first.evidence_digest, &doc);
    assert_eq!(source.binding.restore_fence_generation, 2);
    contact(&mut source.store);
    for _ in 0..4 {
        enrollment::prepare_exports(
            &mut source.store,
            "ws",
            &NoFaults,
            &NoLiveLeases,
            301,
            &mut false,
        )
        .unwrap();
    }
    assert_eq!(count(&source.store, "live_audit_pending_exports"), 0);
    let settlements = operations(&source.store)
        .into_iter()
        .filter(|op| op.op_kind == settlement_record::SETTLEMENT_OP)
        .count();
    assert_eq!(settlements, 1);
    let (_scratch, _path, replica) = receiver(&source);
    assert_eq!(count(&replica, "live_audit_events"), 2);
    assert_eq!(count(&replica, "live_audit_settlements"), 1);
}

/// A lineage bound by 100 selector paths, nearly all quotes that escape to
/// twice their bytes, fences a restore and cancels it. The cancellation
/// outgrows every other object the record bounds, and the update after it
/// still exports whole and imports on a fresh passive replica.
#[test]
fn a_large_binding_cancellation_exports_and_imports() {
    use dohc_engine_collab::live_update_application::ApplicationHostCoordinate;
    let mut source = fixture_with_binding_generation(true, None, 1);
    let mut selectors: Vec<String> = (0..99)
        .map(|i| format!("{i:02}{}", "\"".repeat(1022)))
        .collect();
    selectors.push("note.md".into());
    source.binding.selector_paths = selectors;
    source.handle = source
        ._owner
        .register(
            &mut source.store,
            "relay".into(),
            ApplicationHostCoordinate {
                host_id: "host".into(),
                host_epoch: 1,
                instance_id: "instance".into(),
                connection_id: "connection".into(),
            },
            source.binding.clone(),
        )
        .unwrap();
    bootstrap(&mut source, false).unwrap();
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let previous = initial(&source);
    let first = row(&mut source, 1, &previous, &doc);
    let cancelled = fence_and_cancel(
        &mut source,
        Some(first.admitted.metadata.accepted.receipt.clone()),
    );
    let length = serde_json::to_vec(&cancelled).unwrap().len();
    assert!(
        (262_145..dohc_engine_storage::limits::MAX_LIVE_ACCEPTED_HEADER_BYTES).contains(&length),
        "{length}"
    );
    counted_row(&mut source, 3, 2, &first.evidence_digest, &doc);
    let (_scratch, _path, replica) = receiver(&source);
    let generations = |store: &EngineStore| -> Vec<Option<i64>> {
        store
            .read_with(|c| {
                c.prepare("SELECT restore_generation FROM live_audit_events ORDER BY event_count")?
                    .query_map([], |r| r.get(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap()
    };
    assert_eq!(generations(&replica), vec![Some(1), Some(2)]);
    assert_eq!(generations(&replica), generations(&source.store));
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
fn passive_wide_page_refuses_missing_predecessor_after_document_eviction() {
    let mut fixture = wide_fixture(40, 40, true);
    let frontier = fixture
        .store
        .read_with(|c| dohc_engine_storage::replica::read_frontiers(c, "ws"))
        .unwrap();
    let native = count(&fixture.store, "ydoc_updates");
    assert!(matches!(
        apply_page(&mut fixture.store, "ws", 0, &fixture.rows, &NoFaults),
        Err(ApplicationError::Conflict)
    ));
    assert_eq!(count(&fixture.store, "ydoc_updates"), native);
    for table in [
        "live_accepted_updates",
        "replica_documents",
        "replica_first_seen",
    ] {
        assert_eq!(count(&fixture.store, table), 0, "rollback {table}");
    }
    assert_eq!(
        fixture
            .store
            .read_with(|c| dohc_engine_storage::replica::read_frontiers(c, "ws"))
            .unwrap(),
        frontier
    );
    fixture
        .store
        .read_with(|conn| {
            for (key, _) in &fixture.expected {
                let doc = dohc_engine_collab::durable::load_doc_in(conn, key)?;
                assert!(
                    !doc.project(ContentKind::Richdoc)?
                        .content
                        .contains("Wide document")
                );
                assert!(
                    !doc.project(ContentKind::Richdoc)?
                        .content
                        .contains("Predecessor absent")
                );
            }
            Ok::<_, dohc_engine_collab::CollabError>(())
        })
        .unwrap();
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
fn passive_deduplicated_content_refuses_unresolved_dependencies() {
    let mut source = fixture_with_binding_generation(true, None, 1);
    bootstrap(&mut source, false).unwrap();
    let (_scratch, _path, mut replica) = receiver(&source);
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    let previous = initial(&source);
    let first = row(&mut source, 1, &previous, &doc);
    echo(&source, &mut replica);
    let missing = dohc_engine_collab::Ydoc::wire();
    missing.apply(&source.bytes).unwrap();
    missing.richdoc_append_paragraph("Held predecessor.");
    let pending = missing.richdoc_append_paragraph("Unresolved successor.");
    replica.write_with(&NoFaults, |tx| {
        let sha = put_binary_blob(tx, &pending)?;
        tx.execute("INSERT INTO ydoc_updates(workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms) SELECT workspace_id,version_id,object_id,head_update_seq+1,?1,0 FROM ydoc_docs",[sha]).unwrap();
        tx.execute("UPDATE ydoc_docs SET head_update_seq=head_update_seq+1",[]).unwrap();
        Ok::<_, StorageError>(())
    }).unwrap();
    assert!(matches!(
        apply_page(&mut replica, "ws", 0, &[first], &NoFaults),
        Err(ApplicationError::Conflict)
    ));
    assert_eq!(count(&replica, "live_accepted_updates"), 0);
}

#[test]
fn passive_matching_archived_lineage_applies_and_compacts_a_page_once() {
    for archived in [false, true] {
        let mut source = fixture_with_binding_generation(true, None, 1);
        bootstrap(&mut source, false).unwrap();
        let (_scratch, _path, mut replica) = receiver(&source);
        if archived {
            replica.write_with(&NoFaults, |tx| {
        let full = put_binary_blob(tx, &source.bytes)?;
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.apply(&source.bytes).unwrap();
        let vector = put_binary_blob(tx, &doc.encode_state_vector())?;
        tx.execute("INSERT INTO ydoc_inactive_lineages(workspace_id,version_id,object_id,lineage_claim_id,disposition,content_kind,full_state_blob_sha256,state_vector_blob_sha256,recorded_at_ms,updated_at_ms) VALUES ('ws','main','object',?1,'superseded-predecessor','richdoc',?2,?3,0,0)", params![source.binding.lineage_claim_id,full,vector]).unwrap();
        Ok::<_, dohc_engine_collab::CollabError>(())
    }).unwrap();
        }
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.apply(&source.bytes).unwrap();
        let mut previous = initial(&source);
        let mut rows = Vec::new();
        for cursor in 1..=65 {
            let next = row(&mut source, cursor, &previous, &doc);
            previous = next.evidence_digest.clone();
            rows.push(next);
        }
        let before = replica
            .read_with(|c| dohc_engine_storage::replica::read_frontiers(c, "ws"))
            .unwrap();
        let result = apply_page(&mut replica, "ws", 0, &rows, &NoFaults).unwrap();
        assert_eq!(result.applied, 65);
        let pending: i64 = replica
            .read_with(|c| {
                c.query_row(
                    "SELECT head_update_seq-head_snapshot_seq FROM ydoc_docs",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert!(
            pending < 64,
            "page must compact its appended tail: {pending}"
        );
        assert_eq!(result.revision, before.revision + 1);
        assert_eq!(state(&replica), state(&source.store));
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
        &entries(std::slice::from_ref(&first)),
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
        &entries(std::slice::from_ref(&first)),
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
        &entries(&[post_floor]),
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
fn passive_generation_steps_only_with_the_restore_application_and_refuses_old_rows() {
    use dohc_engine_collab::live_update_application::passive::ReplicaRestore;
    for echo_ahead in [false, true] {
        for native_source in [false, true] {
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
            "checkpointDigest":checkpoint_digest,"preparation":{"point":{"journalCursor":0,"receiptDigest":source.binding.lineage_claim_id},"fence":{"operation":{"operationId":"restore-op","relayDatabaseNamespace":"relay",
                "point":{"journalCursor":0,"receiptDigest":source.binding.lineage_claim_id},"oldBinding":source.binding,"hostId":"host","newFence":2,"origin":{"kind":"bootstrap","id":"bootstrap"},
                "terminal":first.admitted.metadata.accepted.receipt,"appliedSequence":1},"localHeadSequence":1,"recordedAtMs":3}}}),
            });
            let extra = dohc_engine_collab::Ydoc::wire();
            extra
                .apply(&restored.restore.as_ref().unwrap().checkpoint_bytes)
                .unwrap();
            extra.richdoc_append_paragraph("Native content not present in accepted rows.");
            let mut bad = restored.clone();
            bad.restore.as_mut().unwrap().proof["preparation"]["fence"]["operation"]["operationId"] =
                json!("wrong");
            assert!(matches!(
                apply_page(&mut replica, "ws", 1, &[bad], &NoFaults),
                Err(ApplicationError::Conflict)
            ));
            for (field, value) in [
                ("journalCursor", json!(7)),
                ("receiptDigest", json!("f".repeat(64))),
            ] {
                let mut bad = restored.clone();
                bad.restore.as_mut().unwrap().proof["preparation"]["point"][field] = value;
                assert!(matches!(
                    apply_page(&mut replica, "ws", 1, &[bad], &NoFaults),
                    Err(ApplicationError::Conflict)
                ));
            }
            if native_source {
                let before = measurement_vector(&doc);
                let checkpoint = extra.encode_full_state();
                let restore = restored.restore.as_mut().unwrap();
                restore.checkpoint_digest = hex_sha256(&checkpoint);
                restore.checkpoint_bytes = checkpoint;
                restore.proof["checkpointDigest"] = json!(restore.checkpoint_digest);
                restore.proof["proposalDigest"] = json!(hex_sha256(b"retained proposal"));
                restore.proof["nativeSourceManifestDigest"] =
                    json!(hex_sha256(b"retained native manifest"));
                restore.proof["sourceRanges"] = json!(measurement_vector(&extra).iter().filter_map(|(client,end)| {
                let start = before.get(client).copied().unwrap_or(0);
                (*end > start).then_some(json!({"sourceOrdinal":0,"clientId":client,"startClock":start,"endClock":end,"sourceDigest":hex_sha256(b"retained source")}))
            }).collect::<Vec<_>>());
                doc.apply(&restored.restore.as_ref().unwrap().checkpoint_bytes)
                    .unwrap();
            }
            if echo_ahead {
                let later =
                    doc.richdoc_append_paragraph("An ordinary echo beyond the restore position.");
                replica.write_with(&NoFaults, |tx| {
            for bytes in [&restored.admitted.update_bytes, &later] {
                let sha = put_binary_blob(tx, bytes)?;
                tx.execute("INSERT INTO ydoc_updates(workspace_id,version_id,object_id,seq,update_blob_sha256,recorded_at_ms) SELECT workspace_id,version_id,object_id,head_update_seq+1,?1,0 FROM ydoc_docs", [sha]).unwrap();
                tx.execute("UPDATE ydoc_docs SET head_update_seq=head_update_seq+1", []).unwrap();
            }
            Ok::<_, StorageError>(())
        }).unwrap();
            }
            let native_before = count(&replica, "ydoc_updates");
            apply_page(
                &mut replica,
                "ws",
                1,
                std::slice::from_ref(&restored),
                &NoFaults,
            )
            .unwrap();
            assert_eq!(
                count(&replica, "ydoc_updates"),
                native_before + i64::from(!echo_ahead) + 1
            );
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
            if native_source && !echo_ahead {
                let mut second = restored.clone();
                second.journal_cursor = 3;
                second.admitted.metadata.accepted.receipt.journal_cursor = 3;
                second.admitted.metadata.accepted.receipt.delivery_id = "second-restore".into();
                second
                    .admitted
                    .metadata
                    .accepted
                    .binding
                    .restore_fence_generation = 3;
                second.authority.as_mut().unwrap().restore_fence_generation = 3;
                second.admitted.update_bytes = doc.richdoc_append_paragraph("Second restore.");
                second.admitted.metadata.accepted.receipt.update_digest =
                    hex_sha256(&second.admitted.update_bytes);
                second.evidence_digest = hex_sha256(
                    &serde_json::to_vec(&(
                        "accepted-event-v1",
                        &restored.evidence_digest,
                        3,
                        &second.admitted.metadata,
                    ))
                    .unwrap(),
                );
                let restore = second.restore.as_mut().unwrap();
                restore.operation_id = "second-restore-op".into();
                restore.checkpoint_bytes = doc.encode_full_state();
                restore.checkpoint_digest = hex_sha256(&restore.checkpoint_bytes);
                restore.proof["admitted"] = json!(second.admitted.metadata);
                restore.proof["candidateDigest"] =
                    json!(second.admitted.metadata.accepted.receipt.update_digest);
                restore.proof["checkpointDigest"] = json!(restore.checkpoint_digest);
                restore.proof["sourceRanges"] = json!([]);
                restore.proof["preparation"]["fence"] = json!({"operation":{"operationId":"second-restore-op","relayDatabaseNamespace":"relay",
                    "point":{"journalCursor":0,"receiptDigest":source.binding.lineage_claim_id},"oldBinding":restored.admitted.metadata.accepted.binding,"hostId":"host","newFence":3,"origin":{"kind":"bootstrap","id":"bootstrap"},
                    "terminal":restored.admitted.metadata.accepted.receipt,"appliedSequence":2},"localHeadSequence":2,"recordedAtMs":4});
                apply_page(&mut replica, "ws", 2, &[second], &NoFaults).unwrap();
            }
            assert_eq!(
                state(&replica),
                (
                    doc.encode_state_vector(),
                    doc.project(ContentKind::Richdoc).unwrap().content
                )
            );
        }
    }
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
