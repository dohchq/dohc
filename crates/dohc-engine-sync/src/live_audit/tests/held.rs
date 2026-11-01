//! A refused live audit holds its lineage's later audits, never its origin's
//! other work.

use super::*;
use dohc_engine_collab::live_update_application::{
    AdmittedLiveUpdateMetadata, LiveUpdateReceipt, NativeRestoreFence, NativeRestoreSelection,
    RestoreDeliveryOrigin, RestoreFenceCancellation, RestoreFenceCancellationOutcome,
    cancel_restore_fence,
};
use dohc_engine_domain::WriteText;
use dohc_engine_storage::TxnOutcome;

fn apply(store: &mut EngineStore, op: &ReplicationEnvelope) -> String {
    let mut op = op.clone();
    if op.relay_seq.is_none() {
        op.relay_seq = Some(op.origin_seq + 1);
    }
    match crate::apply_replication_envelope(
        store,
        &mut WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
    ) {
        Ok(outcome) => match outcome.primary {
            ApplyDisposition::Applied(_) => "applied".to_owned(),
            ApplyDisposition::Refused(refusal) => format!("refused: {}", refusal.reason.message()),
            ApplyDisposition::Skipped => "skipped".to_owned(),
            ApplyDisposition::Crashed { .. } => "crashed".to_owned(),
        },
        Err(error) => format!("error: {error:?}"),
    }
}

fn copy_blobs(source: &EngineStore, target: &mut EngineStore) {
    type Text = Vec<(String, i64, String)>;
    let (binary, text): (Vec<Vec<u8>>, Text) = source
        .read_with(|c| {
            let binary = c
                .prepare("SELECT bytes FROM binary_blobs")?
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            let text = c
                .prepare("SELECT sha256,byte_length,text FROM blobs")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<_, _>>()?;
            Ok::<_, rusqlite::Error>((binary, text))
        })
        .unwrap();
    target
        .write_with(&NoFaults, |tx| {
            for bytes in &binary {
                put_binary_blob(tx, bytes)?;
            }
            for (sha, length, body) in &text {
                tx.execute(
                    "INSERT OR IGNORE INTO blobs(sha256,byte_length,text) VALUES (?1,?2,?3)",
                    params![sha, length, body],
                )
                .map_err(SyncError::persist)?;
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

fn held(store: &EngineStore) -> Vec<(String, i64)> {
    store
        .read_with(|c| {
            c.prepare(
                "SELECT origin_id,origin_seq FROM live_audit_held_records ORDER BY origin_id,origin_seq",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()
        })
        .unwrap()
}

fn verified_through(store: &EngineStore) -> i64 {
    store
        .read_with(|c| {
            c.query_row(
                "SELECT COALESCE(MAX(event_count),0) FROM live_audit_events",
                [],
                |r| r.get(0),
            )
        })
        .unwrap()
}

/// An ordinary edit of another document, journaled as the store's next
/// operation.
fn write_other(store: &mut EngineStore, moment: &str, now_ms: i64) {
    save_other(store, moment, now_ms);
    store
        .write_with(&NoFaults, |tx| {
            crate::journal_moment_append_in_tx(tx, "ws", moment)
        })
        .unwrap();
}

/// An ordinary saved edit of another document, not journaled.
fn save_other(store: &mut EngineStore, moment: &str, now_ms: i64) {
    VersionedTextStore::new(store)
        .write_text(
            &WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "other".into(),
                path: "other.md".into(),
                text: "Another document.".into(),
                moment_id: moment.into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
}

/// Origin `peer`'s ordinary edit of another document at `seq`, with its blobs
/// copied into `receiver`.
fn peer_edit(receiver: &mut EngineStore, seq: i64) -> ReplicationEnvelope {
    let (_scratch, _path, mut peer) = open_store();
    VersionedTextStore::new(&mut peer)
        .ensure_main_version("ws", "main", 0, &NoFaults)
        .unwrap();
    crate::journal_local_replication_op(
        &mut peer,
        "ws",
        "peer",
        "epoch",
        "stream",
        "workspace.init",
        &json!({}),
        0,
        &NoFaults,
    )
    .unwrap();
    write_other(&mut peer, "peer-edit", 400);
    copy_blobs(&peer, receiver);
    let mut op = crate::list_replication_ops(&peer, "ws", "peer", -1, 500)
        .unwrap()
        .into_iter()
        .find(|op| op.op_kind == "moment.append")
        .unwrap();
    op.origin_seq = seq;
    op
}

fn owner_ops(store: &EngineStore) -> Vec<ReplicationEnvelope> {
    crate::list_replication_ops(store, "ws", "service-origin", -1, 500).unwrap()
}

/// The owner's first application audit.
fn owner_audit(store: &EngineStore) -> ReplicationEnvelope {
    owner_ops(store)
        .into_iter()
        .find(|op| op.op_kind == application_record::EVENT_OP)
        .unwrap()
}

fn record_of(store: &EngineStore, op: &ReplicationEnvelope) -> serde_json::Value {
    let manifest: chunks::Manifest =
        serde_json::from_value(op.payload["manifest"].clone()).unwrap();
    store
        .read_with(|conn| {
            serde_json::from_reader(chunks::ChunkReader::new(conn, &manifest).unwrap())
        })
        .unwrap()
}

/// Builds a restore source for this fixture.
fn restore_source(
    source: &Fixture,
    origin: serde_json::Value,
    host: &str,
    accepted: i64,
    previous: &str,
) -> serde_json::Value {
    let lineage = &source.binding.lineage_claim_id;
    let markdown = &source.input.projected_markdown_digest;
    json!({
        "operationId":"restore", "oldGeneration":0, "origin":origin,
        "hostId":host, "appliedSequence":1, "fenceHeadSequence":1, "fencedAtMs":100,
        "point":{"journalCursor":0,"receiptDigest":lineage,"markdownDigest":markdown,"projectionDigest":markdown},
        "selected":{"eventCount":0,"terminal":null,"evidenceDigest":previous},
        "accepted":{"eventCount":accepted,"terminal":null,"evidenceDigest":previous},
        "originEvidenceDigest":hex_sha256(&serde_json::to_vec(&source.input).unwrap()),
        "nativeSourceManifestDigest":lineage,"frozenStateDigest":lineage,
        "pointStateDigest":lineage,"finalContentDigest":markdown
    })
}

/// Audits from origin `peer` at `count`, built from `template`'s `record`
/// and written into `receiver`'s chunks.
fn refused_audit(
    receiver: &mut EngineStore,
    template: &ReplicationEnvelope,
    record: &serde_json::Value,
    count: i64,
    previous: &str,
    restore: serde_json::Value,
) -> [ReplicationEnvelope; 2] {
    let mut metadata: AdmittedLiveUpdateMetadata =
        serde_json::from_value(record["metadata"].clone()).unwrap();
    metadata.accepted.binding.restore_fence_generation += 1;
    metadata.accepted.receipt.journal_cursor = count;
    let evidence = hex_sha256(
        &serde_json::to_vec(&("accepted-event-v1", previous, count, &metadata)).unwrap(),
    );
    let host = restore["hostId"].as_str().unwrap().to_owned();
    let restore: restore_record::RestoreSource = serde_json::from_value(restore).unwrap();
    // Serialize through the native metadata and restore types, in native record order.
    let bytes = format!(
        "{{\"kind\":\"application\",\"relayDatabaseNamespace\":\"relay\",\"eventCount\":{count},\"evidenceDigest\":\"{evidence}\",\"updateByteLength\":{},\"metadata\":{},\"sourceApplication\":{{\"localYDocSequence\":2,\"hostCoordinate\":{{\"hostId\":\"{host}\",\"hostEpoch\":1,\"instanceId\":\"instance\",\"connectionId\":\"connection\"}}}},\"sourceRestore\":{},\"cancelledRestores\":[],\"contentCoordinate\":{}}}",
        record["updateByteLength"],
        serde_json::to_string(&metadata).unwrap(),
        serde_json::to_string(&restore).unwrap(),
        record["contentCoordinate"]
    );
    let TxnOutcome::Committed(manifest) = receiver
        .write_with(&NoFaults, |tx| {
            use std::io::Write;
            let mut writer = chunks::ChunkWriter::new(tx);
            writer.write_all(bytes.as_bytes()).unwrap();
            writer.finish()
        })
        .unwrap()
    else {
        panic!("record write rolled back")
    };
    let mut audit = template.clone();
    audit.origin_id = "peer".into();
    audit.origin_seq = 0;
    audit.relay_seq = None;
    audit.admitted_author_snapshot = None;
    audit.payload["eventCount"] = json!(count);
    audit.payload["manifest"] = serde_json::to_value(manifest).unwrap();
    let mut next = audit.clone();
    next.origin_seq = 1;
    next.payload["eventCount"] = json!(count + 1);
    [audit, next]
}

/// Fences and cancels the owner's restore.
fn cancel_owner_restore(f: &mut Fixture, activation: &str) {
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
    let pushed = owner_ops(&f.store).last().unwrap().origin_seq;
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
                point: NativeRestoreSelection {
                    journal_cursor: 0,
                    receipt_digest: f.binding.lineage_claim_id.clone(),
                },
                operation_id: "restore".into(),
                relay_database_namespace: "relay".into(),
                old_binding: f.binding.clone(),
                host_id: coordinate.host_id.clone(),
                new_fence: next,
                origin: RestoreDeliveryOrigin::Owner {
                    id: activation.into(),
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
}

fn accept_edit(f: &mut Fixture, cursor: i64, text: &str) {
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&f.bytes).unwrap();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, text)
        .unwrap();
    f.bytes = doc.encode_full_state();
    accept_named_event(f, cursor, format!("edit-{cursor}"));
}

/// A third replica that refuses one of the adopter's audits, and each of the
/// adopter's operations with its outcome there.
fn third_replica() -> (EngineStore, ScratchDir, Vec<(ReplicationEnvelope, String)>) {
    let (mut f, mut source, _, root) = imported_owner(false, false);
    cancel_owner_restore(&mut f, &root.activation_id);
    accept_edit(&mut f, 2, "Second edit.");
    accept_edit(&mut f, 3, "Third edit.");
    write_other(&mut f.store, "other-moment", 400);
    source
        .store
        .write_with(&NoFaults, |tx| {
            journal_live_base_in_tx(tx, "relay", &source.binding, 300)
        })
        .unwrap();
    let scratch = ScratchDir::new().unwrap();
    let mut replica =
        EngineStore::open_passive(&scratch.path().join("replica.db"), 0, None, None).unwrap();
    copy_blobs(&source.store, &mut replica);
    copy_blobs(&f.store, &mut replica);
    for op in operations(&source.store) {
        let outcome = apply(&mut replica, &op);
        assert!(
            outcome == "applied" || outcome == "skipped",
            "{}: {outcome}",
            op.op_kind
        );
    }
    let outcomes = owner_ops(&f.store)
        .into_iter()
        .map(|op| {
            let outcome = apply(&mut replica, &op);
            (op, outcome)
        })
        .collect();
    assert_eq!(count(&replica, "live_audit_bases"), 1);
    assert_eq!(count(&replica, "live_audit_base_conflicts"), 1);
    (replica, scratch, outcomes)
}

fn report(outcomes: &[(ReplicationEnvelope, String)]) -> Vec<String> {
    outcomes
        .iter()
        .map(|(op, outcome)| format!("{} {}: {outcome}", op.origin_seq, op.op_kind))
        .collect()
}

/// The audits a replica did not verify are exactly the ones it holds, and
/// the edit of another document after them arrives.
fn assert_contained(replica: &EngineStore, outcomes: &[(ReplicationEnvelope, String)]) {
    let (last, outcome) = outcomes.last().unwrap();
    assert_eq!(last.op_kind, "moment.append");
    assert_eq!(outcome, "applied", "{:#?}", report(outcomes));
    assert_eq!(
        crate::read_replication_acked_seq(replica, "ws", &last.origin_id).unwrap(),
        last.origin_seq
    );
    let unverified: Vec<(String, i64)> = outcomes
        .iter()
        .filter(|(op, outcome)| {
            op.op_kind != BASE_OP && op.op_kind.starts_with("live.audit.") && outcome != "applied"
        })
        .map(|(op, _)| (op.origin_id.clone(), op.origin_seq))
        .collect();
    assert!(!unverified.is_empty(), "{:#?}", report(outcomes));
    assert!(
        outcomes
            .iter()
            .filter(|(op, _)| unverified.contains(&(op.origin_id.clone(), op.origin_seq)))
            .all(|(_, outcome)| outcome.starts_with("refused: ")),
        "{:#?}",
        report(outcomes)
    );
    assert_eq!(held(replica), unverified);
}

/// The audits the third replica refuses hold, and the adopter's edit of
/// another document still arrives.
#[test]
fn later_work_reaches_a_third_replica() {
    let (replica, _scratch, outcomes) = third_replica();
    assert_contained(&replica, &outcomes);
    assert!(verified_through(&replica) < 2);
}

/// The new owner's store, with an audit it refuses, the next edit's audit,
/// and origin `peer`'s edit of another document.
fn new_owner_holds() -> (Fixture, [ReplicationEnvelope; 3]) {
    let (mut f, source, _, _) = imported_owner(false, true);
    assert_eq!(count(&f.store, "live_audit_bases"), 1);
    assert_eq!(count(&f.store, "live_audit_base_publications"), 1);
    let template = owner_audit(&f.store);
    let record = record_of(&f.store, &template);
    let previous: String = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT evidence_digest FROM live_audit_events WHERE event_count=1",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let restore = restore_source(
        &source,
        json!({"kind":"bootstrap","id":"bootstrap"}),
        "host",
        1,
        &previous,
    );
    let [audit, next] = refused_audit(&mut f.store, &template, &record, 2, &previous, restore);
    let edit = peer_edit(&mut f.store, 2);
    (f, [audit, next, edit])
}

fn apply_all(
    store: &mut EngineStore,
    ops: &[ReplicationEnvelope],
) -> Vec<(ReplicationEnvelope, String)> {
    ops.iter()
        .map(|op| {
            let outcome = apply(store, op);
            (op.clone(), outcome)
        })
        .collect()
}

/// The new owner refuses an audit, and the next edit's audit waits on it.
#[test]
fn later_work_reaches_the_new_owner() {
    let (mut f, ops) = new_owner_holds();
    let outcomes = apply_all(&mut f.store, &ops);
    assert_contained(&f.store, &outcomes);
    assert_eq!(verified_through(&f.store), 1);
}

/// A settlement over held edits holds with them instead of waiting.
#[test]
fn a_settlement_over_held_audits_does_not_stop_later_work() {
    let (mut f, [audit, next, mut edit]) = new_owner_holds();
    let (mut settled, ..) = imported_owner(false, true);
    accept_edit(&mut settled, 2, "Second edit.");
    accept_edit(&mut settled, 3, "Third edit.");
    settle_bootstrap_publication(&mut settled, 3, "held-settlement").unwrap();
    copy_blobs(&settled.store, &mut f.store);
    let mut settlement = owner_ops(&settled.store)
        .into_iter()
        .find(|op| op.op_kind == settlement_record::SETTLEMENT_OP)
        .unwrap();
    settlement.origin_id = "peer".into();
    settlement.origin_seq = 2;
    settlement.relay_seq = None;
    edit.origin_seq = 3;
    let outcomes = apply_all(&mut f.store, &[audit, next, settlement, edit]);
    assert!(
        outcomes[2].1.starts_with("refused: "),
        "{:#?}",
        report(&outcomes)
    );
    assert_contained(&f.store, &outcomes);
    assert_eq!(count(&f.store, "live_audit_settlements"), 0);
}

/// The previous owner refuses an audit, and the next edit's audit waits on
/// it.
#[test]
fn later_work_reaches_the_previous_owner() {
    let (f, mut source, _, root) = imported_owner(false, true);
    copy_blobs(&f.store, &mut source.store);
    for op in owner_ops(&f.store) {
        let outcome = apply(&mut source.store, &op);
        assert!(
            outcome == "applied" || outcome.starts_with("refused: "),
            "{}: {outcome}",
            op.op_kind
        );
        if op.op_kind == BASE_OP {
            break;
        }
    }
    assert_eq!(count(&source.store, "live_audit_bases"), 1);
    assert_eq!(count(&source.store, "live_audit_base_publications"), 1);
    assert_eq!(count(&source.store, "live_audit_base_conflicts"), 0);
    let template = owner_audit(&f.store);
    let record = record_of(&f.store, &template);
    let previous: String = source
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT json_extract(record_json,'$.checkpoint.evidenceDigest') FROM live_audit_bases",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let restore = restore_source(
        &source,
        json!({"kind":"owner","id":root.activation_id}),
        "service-host",
        0,
        &previous,
    );
    let [audit, next] = refused_audit(&mut source.store, &template, &record, 1, &previous, restore);
    let edit = peer_edit(&mut source.store, 2);
    let outcomes: Vec<_> = [audit, next, edit]
        .into_iter()
        .map(|op| {
            let outcome = apply(&mut source.store, &op);
            (op, outcome)
        })
        .collect();
    assert_contained(&source.store, &outcomes);
    assert_eq!(verified_through(&source.store), 0);
}

/// An audit export this store cannot build keeps its place, and the edit of
/// another document journaled after it still pushes.
#[test]
fn other_work_pushes_while_an_audit_export_waits() {
    let (mut f, _source, _, root) = imported_owner(false, true);
    cancel_owner_restore(&mut f, &root.activation_id);
    // An enrollment still exporting this lineage defers the next edit's audit.
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO live_audit_pending_exports(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,after_event_count) VALUES ('relay','ws','main','object',?1,1)",
                [&f.binding.lineage_claim_id],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    accept_edit(&mut f, 2, "Second edit.");
    write_other(&mut f.store, "other-moment", 400);
    let client = crate::RelaySyncClient::new(crate::tests::FakeRelay::default());
    let outcome = client.push_workspace(
        &mut f.store,
        "ws",
        &NoFaults,
        &NoLiveLeases,
        401,
        100_000_000,
    );
    assert!(outcome.is_ok(), "{outcome:?}");
    assert_eq!(
        crate::cursor::read_pushed_seq(&f.store, "ws", "service-origin").unwrap(),
        owner_ops(&f.store).last().unwrap().origin_seq
    );
    let after: i64 = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT after_event_count FROM live_audit_pending_exports",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(after, 1);
    assert_eq!(count(&f.store, "live_audit_event_publications"), 1);
}

/// More of the origin's unrelated work than the pull retains behind a
/// waiting operation still arrives, page by page, behind a held audit.
#[test]
fn more_unrelated_work_than_a_pull_retains_still_arrives() {
    let (mut f, [audit, next, mut edit]) = new_owner_holds();
    let mut ops = vec![audit, next];
    for seq in 2..10_003 {
        let mut later = ops[0].clone();
        later.origin_seq = seq;
        later.op_kind = "workspace.init".into();
        later.payload = json!({});
        ops.push(later);
    }
    edit.origin_seq = ops.len() as i64;
    let last = edit.origin_seq;
    ops.push(edit);
    let relay = crate::tests::FakeRelay::default();
    let client = crate::RelaySyncClient::new(relay);
    let mut cursor = 1_000;
    for page in ops.chunks(crate::MAX_PULL_OPS) {
        cursor += page.len() as i64;
        *client.transport().pull.lock().unwrap() = Some(crate::PullResponse {
            ops: page.to_vec(),
            next_cursor: cursor,
            has_more: false,
        });
        let outcome = client
            .pull_chat_workspace(
                &mut f.store,
                &mut WriterDocCache::new(),
                "ws",
                &NoFaults,
                &NoLiveLeases,
                500,
            )
            .unwrap();
        let crate::SyncPassOutcome::Complete {
            pending_cursor: Some(pending),
            ..
        } = outcome
        else {
            panic!("{outcome:?}");
        };
        client
            .commit_pull_cursor(&mut f.store, "ws", &pending, &NoFaults, &NoLiveLeases, 500)
            .unwrap();
    }
    assert_eq!(
        crate::read_replication_acked_seq(&f.store, "ws", "peer").unwrap(),
        last
    );
    assert_eq!(held(&f.store), vec![("peer".into(), 0), ("peer".into(), 1)]);
}

/// A held audit keeps every blob it names, and its hold survives a restart:
/// the store opens offline as before, and a redelivery changes nothing.
#[test]
fn held_audits_keep_their_blobs_across_a_restart() {
    let (mut f, ops) = new_owner_holds();
    apply_all(&mut f.store, &ops);
    let (named, kept) = f
        .store
        .read_with(|c| {
            let mut named = std::collections::BTreeSet::new();
            let mut statement = c.prepare("SELECT envelope_json FROM live_audit_held_records")?;
            for json in statement.query_map([], |r| r.get::<_, String>(0))? {
                let envelope: ReplicationEnvelope = serde_json::from_str(&json?).unwrap();
                named.extend(
                    crate::relay::collect_blob_refs(&[envelope])
                        .unwrap()
                        .into_keys(),
                );
            }
            let kept = c
                .prepare("SELECT binary_sha256 FROM live_audit_held_blobs")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
            Ok::<_, rusqlite::Error>((named, kept))
        })
        .unwrap();
    assert!(!named.is_empty());
    assert_eq!(kept, named);
    let held_before = held(&f.store);
    f.store = EngineStore::open(&f.path, 600).unwrap();
    assert_eq!(held(&f.store), held_before);
    assert_eq!(verified_through(&f.store), 1);
    for op in &ops {
        assert_eq!(apply(&mut f.store, op), "skipped");
    }
    assert_eq!(held(&f.store), held_before);
    f.store
        .write_with(&NoFaults, |tx| {
            for sha in &kept {
                assert!(
                    tx.execute("DELETE FROM binary_blobs WHERE sha256=?1", [sha])
                        .is_err(),
                    "a held blob is kept"
                );
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

/// A crash after the hold and before the commit leaves the coordinate
/// unacknowledged and nothing held; the redelivery holds it.
#[test]
fn a_crash_before_the_ack_leaves_the_audit_to_redeliver() {
    use dohc_engine_storage::FaultPoint;
    use dohc_engine_testkit::ScriptedFaults;
    let (mut f, [audit, ..]) = new_owner_holds();
    let mut op = audit.clone();
    op.relay_seq = Some(1);
    let fault = ScriptedFaults::crash_at(FaultPoint::SyncBeforeApplyCommit);
    let outcome = crate::apply_replication_envelope(
        &mut f.store,
        &mut WriterDocCache::new(),
        &op,
        fault.as_ref(),
        &NoLiveLeases,
    )
    .unwrap();
    assert!(matches!(
        outcome.primary,
        ApplyDisposition::Crashed { committed: false }
    ));
    assert!(held(&f.store).is_empty());
    assert_eq!(
        crate::read_replication_acked_seq(&f.store, "ws", "peer").unwrap(),
        -1
    );
    assert!(apply(&mut f.store, &audit).starts_with("refused: "));
    assert_eq!(held(&f.store), vec![("peer".into(), 0)]);
}

/// An earlier build refused an audit from origin `peer`, and its Notice was
/// dismissed. Another origin's later audit of the lineage holds with the
/// refused coordinate, read from the replication log, and that origin's
/// other work arrives.
#[test]
fn later_work_from_another_computer_arrives_after_an_upgrade() {
    let (mut f, [audit, mut next, mut edit]) = new_owner_holds();
    assert!(apply(&mut f.store, &audit).starts_with("refused: "));
    // An earlier build kept only the refused log row.
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "DELETE FROM live_audit_held_records; DELETE FROM replication_pending_refusals",
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    next.origin_id = "other-peer".into();
    next.origin_seq = 0;
    edit.origin_id = "other-peer".into();
    edit.origin_seq = 1;
    assert_eq!(
        apply(&mut f.store, &next),
        format!("refused: {}", crate::live_audit::held::WAITS_ON_HELD)
    );
    assert_eq!(apply(&mut f.store, &edit), "applied");
    assert_eq!(
        held(&f.store),
        vec![("other-peer".into(), 0), ("peer".into(), 0)]
    );
    let recovered: Option<String> = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT envelope_json FROM live_audit_held_records WHERE origin_id='peer'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(recovered, None, "the log row is its replay source");
    assert_eq!(count(&f.store, "replication_pending_refusals"), 0);
}

/// The lookup of refused audits reads the log through its index.
#[test]
fn waiting_work_is_found_without_reading_all_history() {
    let (f, _) = new_owner_holds();
    let plan: Vec<String> = f
        .store
        .read_with(|c| {
            c.prepare(&format!(
                "EXPLAIN QUERY PLAN {}",
                crate::live_audit::held::REFUSED_APPLICATIONS
            ))?
            .query_map(
                params!["relay", "ws", "main", "object", "lineage", 1, 2],
                |r| r.get::<_, String>(3),
            )?
            .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    // The history lookup is keyed by workspace and document.
    assert!(
        plan.iter().any(|step| step
            == "SEARCH r USING INDEX live_audit_refused_applications (workspace_id=? AND <expr>=? AND <expr>>? AND <expr><?)"),
        "{plan:#?}"
    );
    assert!(
        !plan.iter().any(|step| step.starts_with("SCAN r")),
        "{plan:#?}"
    );
}

/// Every audit this computer refuses is acknowledged, and leaves no pending
/// refusal, so the sender's later work arrives.
#[test]
fn the_senders_later_work_arrives_after_a_refused_audit() {
    let (mut f, [mut audit, _, mut edit]) = new_owner_holds();
    audit.payload["eventCount"] = json!(0);
    let outcome = apply(&mut f.store, &audit);
    assert!(outcome.starts_with("refused: "), "{outcome}");
    assert_eq!(
        crate::read_replication_acked_seq(&f.store, "ws", "peer").unwrap(),
        0
    );
    assert_eq!(count(&f.store, "replication_pending_refusals"), 0);
    edit.origin_seq = 1;
    assert_eq!(apply(&mut f.store, &edit), "applied");
    assert!(held(&f.store).is_empty());
}

/// Hold a refused audit of event `count` of `binding`'s lineage from
/// `origin`.
fn hold_event(store: &mut EngineStore, binding: &LiveObjectBinding, origin: &str, count: i64) {
    let payload = json!({
        "relayDatabaseNamespace": "relay",
        "mainVersionId": binding.main_version_id,
        "objectId": binding.object_id,
        "lineageClaimId": binding.lineage_claim_id,
        "eventCount": count,
    });
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported,apply_disposition) VALUES ('ws',?1,0,'live.audit.application',?2,1,1,'refused')",
                params![origin, payload.to_string()],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "INSERT INTO live_audit_held_records(workspace_id,origin_id,origin_seq,relay_database_namespace,main_version_id,object_id,lineage_claim_id,event_count,reason) VALUES ('ws',?1,0,'relay',?2,?3,?4,?5,'refused')",
                params![origin, binding.main_version_id, binding.object_id, binding.lineage_claim_id, count],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
}

/// A held audit of a later event does not hold an audit that waits on an
/// earlier one: the edit's audit and the settlement stay retryable and
/// unacknowledged. The settlement applies once the event it waits on
/// arrives, and each holds once that event is held instead.
#[test]
fn early_work_stays_ready_while_a_later_change_waits() {
    let mut source = fixture(true);
    bootstrap(&mut source, false).unwrap();
    accept_edit(&mut source, 1, "First edit.");
    accept_edit(&mut source, 2, "Second edit.");
    settle_bootstrap_publication(&mut source, 2, "early-settlement").unwrap();
    let ops = operations(&source.store);
    let find = |kind: &str, event: Option<i64>| {
        ops.iter()
            .find(|op| {
                op.op_kind == kind && event.is_none_or(|count| op.payload["eventCount"] == count)
            })
            .unwrap()
    };
    let event = find(application_record::EVENT_OP, Some(2));
    let mut settlement = find(settlement_record::SETTLEMENT_OP, None).clone();
    settlement.origin_id = "settler".into();
    settlement.origin_seq = 0;
    settlement.relay_seq = None;
    let (_scratch, _path, mut receiver) = receiver_with_blobs(&source);
    for op in ops.iter().take_while(|op| !std::ptr::eq(*op, event)) {
        assert_eq!(apply(&mut receiver, op), "applied", "{}", op.op_kind);
    }
    hold_event(&mut receiver, &source.binding, "late-peer", 4);
    let acked =
        |store: &EngineStore| crate::read_replication_acked_seq(store, "ws", "settler").unwrap();
    let waiting =
        r#"error: RetryableState { reason: "settlement interval boundary is unavailable" }"#;
    assert_eq!(apply(&mut receiver, &settlement), waiting);
    assert_eq!(acked(&receiver), -1);
    assert_eq!(held(&receiver), vec![("late-peer".into(), 0)]);
    for op in ops.iter().skip_while(|op| !std::ptr::eq(*op, event)) {
        assert_eq!(apply(&mut receiver, op), "applied", "{}", op.op_kind);
    }
    assert_eq!(apply(&mut receiver, &settlement), "applied");
    assert_eq!(acked(&receiver), 0);
    assert_eq!(count(&receiver, "live_audit_settlements"), 1);

    let (mut f, [audit, mut next, _]) = new_owner_holds();
    let (mut settled, ..) = imported_owner(false, true);
    accept_edit(&mut settled, 2, "Second edit.");
    settle_bootstrap_publication(&mut settled, 2, "early-settlement").unwrap();
    copy_blobs(&settled.store, &mut f.store);
    let mut settlement = owner_ops(&settled.store)
        .into_iter()
        .find(|op| op.op_kind == settlement_record::SETTLEMENT_OP)
        .unwrap();
    settlement.origin_id = "settler".into();
    settlement.origin_seq = 0;
    settlement.relay_seq = None;
    next.origin_id = "editor".into();
    next.origin_seq = 0;
    hold_event(&mut f.store, &f.binding, "late-peer", 4);
    for op in [&settlement, &next] {
        let outcome = apply(&mut f.store, op);
        assert!(outcome.starts_with("error: "), "{outcome}");
        assert_eq!(
            crate::read_replication_acked_seq(&f.store, "ws", &op.origin_id).unwrap(),
            -1
        );
    }
    assert_eq!(held(&f.store), vec![("late-peer".into(), 0)]);
    assert!(apply(&mut f.store, &audit).starts_with("refused: "));
    for op in [&settlement, &next] {
        assert_eq!(
            apply(&mut f.store, op),
            format!("refused: {}", crate::live_audit::held::WAITS_ON_HELD)
        );
    }
}

/// A settlement an earlier build could send is not held. It stays retryable.
#[test]
fn work_from_an_earlier_build_stays_ready_while_a_document_waits() {
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    accept_edit(&mut f, 1, "First edit.");
    settle_bootstrap_publication(&mut f, 1, "settled").unwrap();
    let mut settlement = operations(&f.store)
        .into_iter()
        .find(|op| op.op_kind == settlement_record::SETTLEMENT_OP)
        .unwrap();
    let base: String = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT record_json FROM live_audit_base_publications",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let base: serde_json::Value = serde_json::from_str(&base).unwrap();
    // The settlement as an earlier build sent it, with a matching identity,
    // interval digest and record digest.
    let record = &mut settlement.payload["record"];
    for field in [
        "previousCursor",
        "terminalCursor",
        "applicationCount",
        "acceptedEventCount",
    ] {
        record[field] = json!(0);
    }
    record["localYdocSequence"] = record["previousYdocSequence"].clone();
    record["nativeIntervalDigest"] = json!(hex_sha256(b"[]"));
    let namespace = String::from(record["relayDatabaseNamespace"].as_str().unwrap());
    let binding: LiveObjectBinding = serde_json::from_value(record["binding"].clone()).unwrap();
    let at_base = (0, 0, base["checkpoint"]["evidenceDigest"].as_str().unwrap());
    let interval = serde_json::to_vec(&(
        "live-settlement-accepted-interval-v1",
        [
            namespace.as_str(),
            binding.workspace_id.as_str(),
            binding.main_version_id.as_str(),
            binding.object_id.as_str(),
            binding.lineage_claim_id.as_str(),
        ],
        at_base,
        at_base,
    ))
    .unwrap();
    record["acceptedIntervalDigest"] = json!(hex_sha256(&interval));
    let text = |field: &str| record[field].as_str().unwrap().to_owned();
    let identity = serde_json::to_vec(&(
        &namespace,
        &binding,
        0_i64,
        0_i64,
        record["previousYdocSequence"].as_i64().unwrap(),
        record["localYdocSequence"].as_i64().unwrap(),
        text("nativeIntervalDigest"),
        text("momentId"),
        text("markdownDigest"),
        text("sourceStateVectorDigest"),
    ))
    .unwrap();
    record["settlementId"] = json!(format!("live-settlement-{}", hex_sha256(&identity)));
    let digest = hex_sha256(record.to_string().as_bytes());
    settlement.payload["recordDigest"] = json!(digest);
    let checked = settlement_record::check_imported_payload(&settlement.payload, "ws");
    assert!(checked.is_ok(), "{checked:?}");
    let (_scratch, _path, mut receiver) = receiver_with_blobs(&f);
    hold_event(&mut receiver, &f.binding, "late-peer", 1);
    let wait = SyncError::RetryableState { reason: "waits" };
    let waits = receiver
        .read_with(|c| crate::live_audit::waits_on_held(c, &settlement, &wait))
        .unwrap();
    assert!(waits.is_none());
}

/// Whether `op` waits on a held audit, and the SQLite steps that took.
fn wait_steps(store: &EngineStore, op: &ReplicationEnvelope) -> (bool, u64) {
    store
        .read_with(|c| {
            let steps = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let counter = steps.clone();
            c.progress_handler(
                1,
                Some(move || {
                    counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    false
                }),
            )
            .unwrap();
            let wait = SyncError::RetryableState { reason: "waits" };
            let waits = crate::live_audit::waits_on_held(c, op, &wait);
            c.progress_handler(0, None::<fn() -> bool>).unwrap();
            Ok::<_, SyncError>((
                waits?.is_some(),
                steps.load(std::sync::atomic::Ordering::Relaxed),
            ))
        })
        .unwrap()
}

/// A waiting document does not slow each sync.
#[test]
fn a_waiting_document_does_not_slow_each_sync() {
    let steps = |held: i64| {
        let (mut f, [_, mut next, _]) = new_owner_holds();
        for count in 2..2 + held {
            hold_event(&mut f.store, &f.binding, &format!("held-{count}"), count);
        }
        next.payload["eventCount"] = json!(2 + held);
        wait_steps(&f.store, &next)
    };
    let (few_wait, few) = steps(10);
    let (many_wait, many) = steps(400);
    assert!(few_wait && many_wait);
    assert!(many < few * 2, "{few} steps, then {many}");
}

/// The history lookup is keyed by workspace and document.
#[test]
fn the_history_lookup_is_keyed_by_workspace_and_document() {
    let steps = |others: i64| {
        let (mut f, [audit, next, _]) = new_owner_holds();
        assert!(apply(&mut f.store, &audit).starts_with("refused: "));
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute_batch(
                    "DELETE FROM live_audit_held_records; DELETE FROM replication_pending_refusals",
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?1)
                     INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported,apply_disposition)
                     SELECT iif(i%2,'elsewhere',r.workspace_id),'other',i,r.op_kind,iif(i%2,r.payload_json,json_set(r.payload_json,'$.objectId','other-'||i)),1,1,'refused'
                     FROM n, replication_log r WHERE r.workspace_id=?2 AND r.origin_id=?3 AND r.origin_seq=?4",
                    params![others, audit.workspace_id, audit.origin_id, audit.origin_seq],
                )
                .map_err(SyncError::persist)
            })
            .unwrap();
        wait_steps(&f.store, &next)
    };
    let (few_wait, few) = steps(10);
    let (many_wait, many) = steps(400);
    assert!(few_wait && many_wait);
    assert!(many < few * 2, "{few} steps, then {many}");
}

/// Only a retryable wait on a held audit of the audit's own lineage holds,
/// and only when the store keeps every blob the audit names.
#[test]
fn only_work_that_depends_on_a_waiting_document_waits() {
    let (mut f, [audit, next, _]) = new_owner_holds();
    assert!(apply(&mut f.store, &audit).starts_with("refused: "));
    let waits = |op: &ReplicationEnvelope, error: SyncError| {
        f.store
            .read_with(|c| crate::live_audit::waits_on_held(c, op, &error))
            .unwrap()
            .is_some()
    };
    let wait = || SyncError::RetryableState { reason: "waits" };
    assert!(waits(&next, wait()));
    for error in [
        SyncError::BlobInvalid,
        SyncError::SequenceGap,
        SyncError::InvalidInput { reason: "refused" },
    ] {
        assert!(!waits(&next, error));
    }
    let mut other = next.clone();
    other.payload["lineageClaimId"] = json!("another-lineage");
    assert!(!waits(&other, wait()));
    let digest = crate::relay::collect_blob_refs(std::slice::from_ref(&next))
        .unwrap()
        .into_keys()
        .next()
        .unwrap();
    let missing: ReplicationEnvelope = serde_json::from_str(
        &serde_json::to_string(&next)
            .unwrap()
            .replace(&digest, &"0".repeat(64)),
    )
    .unwrap();
    assert!(!waits(&missing, wait()));
}

/// Queues export streams this store cannot export.
fn refused_streams(f: &mut Fixture, n: usize) {
    f.store
        .write_with(&NoFaults, |tx| {
            for index in 0..n {
                tx.execute(
                    "INSERT INTO live_accepted_checkpoints(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,event_count,journal_cursor,terminal_json,binding_json,origin_stamp,state_sha256,evidence_digest)
                     SELECT relay_database_namespace,workspace_id,main_version_id,object_id,?1,0,journal_cursor,'{}',json_set(binding_json,'$.lineageClaimId',?1),origin_stamp,state_sha256,evidence_digest
                     FROM live_accepted_checkpoints WHERE lineage_claim_id=?2 AND event_count=0",
                    params![format!("-refused-{index:04}"), f.binding.lineage_claim_id],
                )
                .map_err(SyncError::persist)?;
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

fn prepare(f: &mut Fixture, now_ms: i64) {
    enrollment::prepare_exports(
        &mut f.store,
        "ws",
        &NoFaults,
        &crate::NoLiveLeases,
        now_ms,
        &mut false,
    )
    .unwrap();
}

/// A refused export stream keeps its place and lets the next stream and the
/// workspace's other history, a saved edit and a resolved conflict, export
/// in the same pass.
#[test]
fn a_refused_export_stream_lets_later_streams_and_enrollment_export() {
    let mut f = fixture(false);
    bootstrap(&mut f, false).unwrap();
    accept_enrollment_event(&mut f, 1);
    refused_streams(&mut f, 1);
    save_other(&mut f.store, "unrelated-moment", 150);
    f.store.write_with(&NoFaults,|tx|{
        tx.execute("INSERT INTO replication_pending_conflict_bundles(workspace_id,conflict_id,format_version,pre_effect_moment_order,created_at_ms) VALUES ('ws','successor',1,0,201)",[]).map_err(SyncError::persist)?;
        let bundle=tx.last_insert_rowid();
        tx.execute("INSERT INTO replication_pending_conflict_ops(bundle_order,op_index,op_kind,payload_json,recorded_at_ms) VALUES (?1,0,'conflict.resolve',?2,201)",params![bundle,json!({"formatVersion":1,"workspaceId":"ws","conflictId":"successor","status":"resolved"}).to_string()]).map_err(SyncError::persist)?;
        Ok::<_,SyncError>(())
    }).unwrap();
    contact(&mut f.store);
    assert_eq!(count(&f.store, "live_audit_pending_exports"), 2);
    for pass in 0..2 {
        prepare(&mut f, 201 + pass);
        assert_eq!(count(&f.store, "live_audit_event_publications"), 1);
        assert_eq!(count(&f.store, "replication_pending_conflict_bundles"), 0);
        assert!(operations(&f.store).iter().any(
            |op| op.op_kind == "moment.append" && op.payload["momentId"] == "unrelated-moment"
        ));
        assert_eq!(count(&f.store, "live_audit_base_publications"), 1);
        assert_eq!(count(&f.store, "live_audit_pending_exports"), 1);
        assert_eq!(count(&f.store, "live_audit_held_exports"), 1);
    }
    assert_eq!(
        operations(&f.store)
            .iter()
            .filter(|op| op.op_kind == "conflict.resolve")
            .count(),
        1
    );
}

/// A document's stream still exports on the next pass while other streams wait.
#[test]
fn every_documents_history_exports_while_others_wait() {
    let mut f = fixture(false);
    bootstrap(&mut f, false).unwrap();
    accept_enrollment_event(&mut f, 1);
    refused_streams(&mut f, 500);
    contact(&mut f.store);
    let mut passes = 0;
    while count(&f.store, "live_audit_event_publications") == 0 {
        passes += 1;
        assert!(passes <= 2, "no export after {passes} passes");
        prepare(&mut f, 200 + passes);
    }
    assert_eq!(count(&f.store, "live_audit_held_exports"), 500);
}

fn report_lines(store: &EngineStore) -> Vec<String> {
    let mut lines = Vec::new();
    let mut after = Some(crate::HistoryReport::default());
    while let Some(position) = after {
        let (batch, next) = crate::history_report(store, position).unwrap();
        lines.extend(batch);
        after = next;
    }
    lines
}

/// The engine logs one line for each affected document, naming it,
/// both records and this build.
#[test]
fn each_store_logs_a_problem_in_a_documents_history() {
    let line = |store: &EngineStore, role: &str| {
        let lines = report_lines(store);
        assert_eq!(lines.len(), 1, "{lines:#?}");
        let line = &lines[0];
        for part in [
            "engine: live document note.md history needs attention: imported ",
            &format!("; {role} "),
            "workspace ws, document object, version main, lineage ",
            &format!("dohc {}", dohc_engine_storage::ENGINE_BUILD),
        ] {
            assert!(line.contains(part), "{line} lacks {part}");
        }
    };
    let (f, _) = new_owner_holds();
    line(&f.store, "published");
    let (replica, _scratch, _) = third_replica();
    line(&replica, "conflicting");
    let (f, mut source, _, _) = imported_owner(false, true);
    assert!(report_lines(&source.store).is_empty());
    copy_blobs(&f.store, &mut source.store);
    for op in owner_ops(&f.store) {
        apply(&mut source.store, &op);
        if op.op_kind == BASE_OP {
            break;
        }
    }
    line(&source.store, "published");
}

/// The report reads a bounded batch at a time and resumes where it stopped,
/// so the engine's first command never waits on a long report and each
/// document is reported once.
#[test]
fn the_history_report_reads_in_small_steps() {
    let (mut f, _) = new_owner_holds();
    f.store
        .write_with(&NoFaults, |tx| {
            for index in 0..100 {
                for table in ["live_audit_bases", "live_audit_base_publications"] {
                    tx.execute_batch(&format!(
                        "CREATE TEMP TABLE copied AS SELECT * FROM {table} LIMIT 1;
                         UPDATE copied SET lineage_claim_id='copy-{index:03}';
                         INSERT INTO {table} SELECT * FROM copied; DROP TABLE copied;"
                    ))
                    .map_err(SyncError::persist)?;
                }
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let mut batches = Vec::new();
    let mut after = crate::HistoryReport::default();
    loop {
        let (lines, next) = crate::history_report(&f.store, after).unwrap();
        batches.push(lines.len());
        match next {
            Some(next) => after = next,
            None => break,
        }
    }
    assert_eq!(batches.iter().sum::<usize>(), 101, "{batches:?}");
    assert!(
        batches.len() > 1 && batches.iter().all(|lines| *lines <= 64),
        "{batches:?}"
    );
}

/// Owner records that share a coordinate log different
/// identities.
#[test]
fn each_logged_record_has_its_own_identity() {
    let (f, _) = new_owner_holds();
    let published: String = f
        .store
        .read_with(|c| {
            c.query_row(
                "SELECT record_json FROM live_audit_base_publications",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let mut other: serde_json::Value = serde_json::from_str(&published).unwrap();
    assert!(
        other["origin"]["source"]["adoptionId"].is_string(),
        "{other}"
    );
    other["origin"]["source"]["adoptionId"] = json!("another-adoption");
    let other = other.to_string();
    let line = f
        .store
        .read_with(|c| crate::live_audit::history_line(c, &published, "published", &other))
        .unwrap();
    for (role, json) in [("imported", &published), ("published", &other)] {
        let identity = format!("{role} owner record {}", hex_sha256(json.as_bytes()));
        assert!(line.contains(&identity), "{line} lacks {identity}");
    }
    assert_eq!(line.matches(", state recorded ").count(), 2, "{line}");
}

/// A held audit leaves no pending refusal, so no Notices row and nothing
/// each sync pass rereads.
#[test]
fn held_audits_leave_no_notice() {
    let (replica, _scratch, _) = third_replica();
    assert!(!held(&replica).is_empty());
    let pending: i64 = replica
        .read_with(|c| {
            c.query_row(
                "SELECT count(*) FROM replication_pending_refusals p JOIN live_audit_held_records h USING(workspace_id,origin_id,origin_seq)",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(pending, 0);
    assert!(
        crate::list_refusal_notices(&replica, "ws")
            .unwrap()
            .is_empty()
    );
}
