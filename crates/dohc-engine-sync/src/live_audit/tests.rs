use super::*;
use crate::{ApplyDisposition, NoLiveLeases, RelayCursor};
use dohc_engine_collab::WriterDocCache;
use dohc_engine_collab::live_update_application::{
    ApplicationHandle, ApplicationHostCoordinate, ApplicationOwner, BootstrapResult,
    LiveApplicationBootstrap, bootstrap_committed,
};
use dohc_engine_domain::VersionedTextStore;
use dohc_engine_storage::{NoFaults, put_binary_blob};
use dohc_engine_testkit::{ScratchDir, open_store};
use serde_json::json;

// Fields drop in order, so the scratch directory comes last: its guard
// removes the directory only after the store has closed the database.
struct Fixture {
    path: std::path::PathBuf,
    store: EngineStore,
    _owner: ApplicationOwner,
    handle: ApplicationHandle,
    binding: LiveObjectBinding,
    input: LiveApplicationBootstrap,
    bytes: Vec<u8>,
    _scratch: ScratchDir,
}

fn fixture(replicates: bool) -> Fixture {
    fixture_with_markdown(replicates, None)
}

fn fixture_with_markdown(replicates: bool, source: Option<&str>) -> Fixture {
    let (scratch, path, mut store) = open_store();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 0, &NoFaults)
        .unwrap();
    crate::journal_local_replication_op(
        &mut store,
        "ws",
        "owner-origin",
        "epoch",
        "stream",
        "workspace.init",
        &json!({}),
        0,
        &NoFaults,
    )
    .unwrap();
    if replicates {
        contact(&mut store);
    }
    let vectors: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../dohc-engine-collab/tests/live-bootstrap-fixtures/live-bootstrap.json"
    ))
    .unwrap();
    let vector = vectors
        .iter()
        .find(|vector| vector["registrationAccepted"] == true)
        .unwrap();
    let markdown = source.unwrap_or(vector["markdown"].as_str().unwrap());
    let bytes: Vec<u8> = if source.is_some() {
        let doc = dohc_engine_collab::Ydoc::wire();
        let seed: Vec<u8> = serde_json::from_value(vector["bytes"].clone()).unwrap();
        doc.apply(&seed).unwrap();
        doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, markdown)
            .unwrap();
        doc.encode_full_state()
    } else {
        serde_json::from_value(vector["bytes"].clone()).unwrap()
    };
    let binding = LiveObjectBinding {
        workspace_id: "ws".into(),
        main_version_id: "main".into(),
        object_id: "object".into(),
        lineage_claim_id: hex_sha256(&bytes),
        current_path: "note.md".into(),
        selector_paths: vec!["note.md".into()],
        restore_fence_generation: 0,
    };
    let mut owner = ApplicationOwner::new("ws".into()).unwrap();
    let handle = owner
        .register(
            &mut store,
            "relay".into(),
            ApplicationHostCoordinate {
                host_id: "host".into(),
                host_epoch: 1,
                instance_id: "instance".into(),
                connection_id: "connection".into(),
            },
            binding.clone(),
        )
        .unwrap();
    let input = LiveApplicationBootstrap {
        bootstrap_id: "bootstrap".into(),
        bootstrap_moment_id: "bootstrap-moment".into(),
        baseline_moment_relay_sequence: 0,
        baseline_registered_at_ms: 100,
        baseline_digest: binding.lineage_claim_id.clone(),
        baseline_byte_length: bytes.len() as i64,
        projected_markdown_digest: hex_sha256(markdown.as_bytes()),
        projected_markdown_byte_length: markdown.len() as i64,
    };
    Fixture {
        _scratch: scratch,
        path,
        store,
        _owner: owner,
        handle,
        binding,
        input,
        bytes,
    }
}

fn contact(store: &mut EngineStore) {
    crate::commit_relay_cursor(
        store,
        "ws",
        &RelayCursor {
            bootstrap_complete: true,
            cursor: 0,
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            settlement_report_id: None,
        },
        &NoFaults,
        &crate::NoLiveLeases,
        1,
    )
    .unwrap();
}

fn bootstrap(f: &mut Fixture, fail: bool) -> Result<BootstrapResult, Box<dyn std::error::Error>> {
    bootstrap_committed(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.handle,
        f.input.clone(),
        f.bytes.clone(),
        &NoFaults,
        |tx, _, namespace, binding| {
            journal_live_base_in_tx(tx, namespace, binding, 100)?;
            if fail {
                return Err("after publication".into());
            }
            Ok(())
        },
    )
}

fn count(store: &EngineStore, table: &str) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
        })
        .unwrap()
}

fn operations(store: &EngineStore) -> Vec<ReplicationEnvelope> {
    crate::list_replication_ops(store, "ws", "owner-origin", -1, 500).unwrap()
}

fn published(f: &Fixture) -> ReplicationEnvelope {
    operations(&f.store)
        .into_iter()
        .find(|op| op.op_kind == BASE_OP)
        .unwrap()
}

#[test]
fn deferred_settlement_exports_its_companion_moment_after_evidence_once() {
    deferred_settlement_export(true);
}

#[test]
fn uncaptured_historical_settlement_exports_saved_work_without_proof() {
    deferred_settlement_export(false);
}

fn deferred_settlement_export(retain_capture: bool) {
    use dohc_engine_collab::live_update_application::{LiveUpdateReceipt, with_settlement};
    use dohc_engine_storage::TxnOutcome;
    let mut f = fixture(false);
    bootstrap(&mut f, false).unwrap();
    accept_enrollment_event(&mut f, 1);
    contact(&mut f.store);
    assert_eq!(count(&f.store, "live_audit_pending_exports"), 1);
    let receipt = LiveUpdateReceipt {
        delivery_id: "enrollment-1".into(),
        update_digest: hex_sha256(&f.bytes),
        journal_cursor: 1,
        accepting_host_epoch: 1,
    };
    let moment_id = "ydoc-settle-deferred";
    let id = with_settlement::<Box<dyn std::error::Error>, _>(
        &mut f.store,
        &f.handle,
        Some(receipt),
        8,
        dohc_engine_collab::live_update_application::NativeHistoryReconstruction { working_reserve_bytes: 8 * 1024 * 1024 },
        |store, audit| {
            let b = audit.binding();
            let key = dohc_engine_collab::DocKey::new(
                &b.workspace_id, &b.main_version_id, &b.object_id,
            )?;
            let doc = store.read_with(|conn| dohc_engine_collab::durable::load_doc_in(conn, &key))?;
            let projected = doc.project(dohc_engine_collab::ContentKind::Richdoc)?.content;
            let content = doc.preserved_markdown_source(&projected).unwrap_or(projected);
            let vector = hex_sha256(&doc.encode_state_vector());
            let result = store.write_with(&NoFaults, |tx| -> Result<String, Box<dyn std::error::Error>> {
                let written = dohc_engine_domain::write_projected_text_in_tx(tx,
                    dohc_engine_domain::ProjectedWriteText {
                        workspace_id: &b.workspace_id,
                        version_id: &b.main_version_id,
                        object_id: &b.object_id,
                        path: std::borrow::Cow::Borrowed(&b.current_path),
                        text: std::borrow::Cow::Borrowed(&content),
                        moment_id,
                        metadata_origin: "ydoc",
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 300,
                        request_id: None,
                    })?;
                tx.execute(
                    "UPDATE ydoc_docs SET last_settled_sha=?4 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    params![b.workspace_id,b.main_version_id,b.object_id,written.snapshot.blob_sha256],
                )?;
                let id = audit.record_in_tx(tx, moment_id, &written.snapshot.blob_sha256, &vector, 300)?;
                if retain_capture {audit.record_publication_state_in_tx(tx,&id,&doc.encode_full_state())?;}
                else {tx.execute("UPDATE moments SET author_json=?2 WHERE moment_id=?1",params![moment_id,json!([{"kind":"human","humanId":"person","humanName":"Alex"},{"kind":"agent","agentId":"writer"}]).to_string()])?;}
                assert_eq!(journal_live_settlement_in_tx(tx, "ws", &id, 300)?, None);
                Ok(id)
            })?;
            match result {
                TxnOutcome::Committed(id) => Ok(id),
                TxnOutcome::Crashed { .. } => panic!("unexpected settlement crash"),
            }
        },
    ).unwrap();
    let paired = |store: &EngineStore| {
        operations(store)
            .into_iter()
            .filter(|op| {
                op.op_kind == settlement_record::SETTLEMENT_OP
                    || (op.op_kind == "moment.append" && op.payload["momentId"] == moment_id)
            })
            .collect::<Vec<_>>()
    };
    assert!(paired(&f.store).is_empty());
    enrollment::prepare_exports(&mut f.store, "ws", &NoFaults, &crate::NoLiveLeases, 301).unwrap();
    let published = paired(&f.store);
    if retain_capture {
        assert_eq!(published.len(), 2);
        assert_eq!(published[0].op_kind, settlement_record::SETTLEMENT_OP);
        assert_eq!(published[1].op_kind, "moment.append");
        assert!(published[0].origin_seq < published[1].origin_seq);
    } else {
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].op_kind, "moment.append");
        assert!(published[0].payload.get("settlementReference").is_none());
        assert!(published[0].payload.get("authors").is_none());
        assert_eq!(
            published[0].payload["attributionUnavailable"]["reason"],
            "unproven-hosted-authors"
        );
        assert_eq!(count(&f.store, "live_settlement_publication_states"), 0);
        assert_eq!(
            crate::list_refusal_notices(&f.store, "ws").unwrap().len(),
            1
        );
        assert_eq!(count(&f.store, "live_device_settlements"), 1);
    }
    assert_eq!(count(&f.store, "live_audit_pending_exports"), 0);
    f.store
        .write_with(&NoFaults, |tx| {
            journal_live_settlement_in_tx(tx, "ws", &id, 302)
        })
        .unwrap();
    enrollment::prepare_exports(&mut f.store, "ws", &NoFaults, &crate::NoLiveLeases, 303).unwrap();
    assert_eq!(paired(&f.store), published);
}

#[test]
fn bootstrap_publication_rolls_back_with_native_source_and_replays_once() {
    let mut f = fixture(true);
    let before = operations(&f.store);
    assert!(bootstrap(&mut f, true).is_err());
    assert_eq!(operations(&f.store), before);
    for table in [
        "live_audit_base_publications",
        "live_accepted_checkpoints",
        "live_device_bootstraps",
        "ydoc_docs",
    ] {
        assert_eq!(count(&f.store, table), 0);
    }
    bootstrap(&mut f, false).unwrap();
    let after = operations(&f.store);
    let base = after.iter().find(|op| op.op_kind == "ydoc.update").unwrap();
    let audit = after.iter().find(|op| op.op_kind == BASE_OP).unwrap();
    assert_eq!(audit.origin_seq, base.origin_seq + 1);
    assert_eq!(base.payload["updateBlobSha256"], f.binding.lineage_claim_id);
    assert!(base.payload.get("actorOriginId").is_none());
    let parsed: BasePayload = serde_json::from_value(audit.payload.clone()).unwrap();
    assert_eq!(
        parsed.record.base_coordinate,
        BaseCoordinate {
            origin_id: "owner-origin".into(),
            origin_seq: base.origin_seq
        }
    );
    assert_eq!(parsed.record.checkpoint.event_count, 0);
    bootstrap(&mut f, false).unwrap();
    assert_eq!(operations(&f.store), after);
    let reopened = EngineStore::open(&f.path, 101).unwrap();
    assert_eq!(operations(&reopened), after);
    assert_eq!(count(&reopened, "live_audit_base_publications"), 1);
}

#[test]
fn identity_alone_does_not_publish_and_later_publication_uses_event_zero() {
    let mut f = fixture(false);
    bootstrap(&mut f, false).unwrap();
    assert_eq!(count(&f.store, "live_audit_base_publications"), 0);
    assert!(
        !operations(&f.store)
            .iter()
            .any(|op| op.op_kind == "ydoc.update")
    );
    f.store.write_with(&NoFaults,|tx| {
        let later = put_binary_blob(tx,b"later checkpoint bytes")?;
        tx.execute("INSERT INTO live_accepted_checkpoints SELECT relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,1,1,'{}',binding_json,origin_stamp,?1,evidence_digest,NULL,NULL FROM live_accepted_checkpoints WHERE event_count=0",[later]).map_err(SyncError::persist)?;
        Ok::<_,SyncError>(())
    }).unwrap();
    contact(&mut f.store);
    f.store
        .write_with(&NoFaults, |tx| {
            journal_live_base_in_tx(tx, "relay", &f.binding, 102)
        })
        .unwrap();
    let audit = published(&f);
    assert_eq!(
        audit.payload["record"]["checkpoint"]["stateDigest"],
        hex_sha256(&f.bytes)
    );
    assert_eq!(audit.payload["record"]["checkpoint"]["eventCount"], 0);
    assert_eq!(
        operations(&f.store)
            .iter()
            .filter(|op| op.op_kind == "ydoc.update")
            .count(),
        1
    );
}

fn accept_enrollment_event(f: &mut Fixture, cursor: i64) {
    accept_named_event(f, cursor, format!("enrollment-{cursor}"));
}

fn accept_named_event(f: &mut Fixture, cursor: i64, delivery: String) {
    use dohc_engine_collab::live_update_application::{
        AdmittedLiveUpdate, AdmittedLiveUpdateMetadata, ApplicationError, LiveUpdateReceipt,
        RelayAcceptedLiveUpdate, ServerDerivedLiveUpdateAuthority, apply_committed,
    };
    let event = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: delivery,
                    update_digest: hex_sha256(&f.bytes),
                    journal_cursor: cursor,
                    accepting_host_epoch: 1,
                },
                binding: f.binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                },
                received_at_ms: cursor,
            },
            first_seen: Vec::new(),
            canonical_version: None,
            author_snapshot: None,
            first_seen_deletes: None,
            checkpoint_coverage: None,
        },
        update_bytes: f.bytes.clone(),
    };
    apply_committed(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.handle,
        event,
        &NoFaults,
        100_000_000,
        |tx, namespace, binding, count| {
            journal_live_event_or_defer_in_tx(tx, namespace, binding, count, 200)
                .map(|_| ())
                .map_err(|error| {
                    ApplicationError::Storage(dohc_engine_storage::StorageError::persist_public(
                        error,
                    ))
                })
        },
    )
    .unwrap();
}

#[test]
fn first_push_exports_native_history_after_actual_contact() {
    let mut f = fixture(false);
    bootstrap(&mut f, false).unwrap();
    accept_enrollment_event(&mut f, 1);
    let client = crate::RelaySyncClient::new(crate::tests::FakeRelay::default());
    client
        .claim_workspace(
            &mut f.store,
            crate::ClaimRequest {
                workspace_id: "ws".into(),
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
            },
            None,
            &NoFaults,
        )
        .unwrap();
    let outcome = client
        .push_workspace(
            &mut f.store,
            "ws",
            &NoFaults,
            &crate::NoLiveLeases,
            201,
            100_000_000,
        )
        .unwrap();
    assert!(matches!(
        outcome,
        crate::SyncPassOutcome::Complete {
            has_more: false,
            ..
        }
    ));
    assert_eq!(count(&f.store, "live_audit_base_publications"), 1);
    assert_eq!(count(&f.store, "live_audit_event_publications"), 1);
    assert_eq!(count(&f.store, "live_audit_pending_exports"), 0);
    assert_eq!(
        crate::cursor::read_pushed_seq(&f.store, "ws", "owner-origin").unwrap(),
        operations(&f.store).last().unwrap().origin_seq
    );
}

#[test]
fn enrollment_exports_durable_history_across_crash_new_edits_and_reopen() {
    use dohc_engine_storage::FaultPoint;
    use dohc_engine_testkit::ScriptedFaults;
    let mut f = fixture(false);
    bootstrap(&mut f, false).unwrap();
    accept_enrollment_event(&mut f, 1);
    accept_enrollment_event(&mut f, 2);
    f.store.write_with(&NoFaults,|tx|{
        tx.execute("INSERT INTO replication_pending_conflict_bundles(workspace_id,conflict_id,format_version,pre_effect_moment_order,created_at_ms) VALUES ('ws','successor',1,0,201)",[]).map_err(SyncError::persist)?;
        let bundle=tx.last_insert_rowid();
        tx.execute("INSERT INTO replication_pending_conflict_ops(bundle_order,op_index,op_kind,payload_json,recorded_at_ms) VALUES (?1,0,'conflict.resolve',?2,201)",params![bundle,json!({"formatVersion":1,"workspaceId":"ws","conflictId":"successor","status":"resolved"}).to_string()]).map_err(SyncError::persist)?;
        Ok::<_,SyncError>(())
    }).unwrap();
    assert_eq!(count(&f.store, "live_audit_event_publications"), 0);
    contact(&mut f.store);
    assert_eq!(count(&f.store, "live_audit_pending_exports"), 1);
    assert_eq!(count(&f.store, "replication_pending_conflict_bundles"), 1);
    let before = operations(&f.store);
    let fault = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);
    assert!(matches!(
        enrollment::prepare_exports(
            &mut f.store,
            "ws",
            fault.as_ref(),
            &crate::NoLiveLeases,
            201
        ),
        Err(SyncError::FaultCrash)
    ));
    assert_eq!(operations(&f.store), before);
    let fault = ScriptedFaults::crash_at(FaultPoint::StorageAfterCommitBeforeAck);
    assert!(matches!(
        enrollment::prepare_exports(
            &mut f.store,
            "ws",
            fault.as_ref(),
            &crate::NoLiveLeases,
            202
        ),
        Err(SyncError::FaultCrash)
    ));
    assert_eq!(count(&f.store, "live_audit_event_publications"), 1);
    assert_eq!(count(&f.store, "live_audit_pending_exports"), 1);
    f.store = EngineStore::open(&f.path, 203).unwrap();
    accept_enrollment_event(&mut f, 3);
    assert_eq!(
        count(&f.store, "live_audit_event_publications"),
        1,
        "new writes defer behind unfinished history"
    );
    enrollment::prepare_exports(&mut f.store, "ws", &NoFaults, &crate::NoLiveLeases, 204).unwrap();
    assert_eq!(count(&f.store, "live_audit_pending_exports"), 0);
    assert_eq!(count(&f.store, "live_audit_event_publications"), 3);
    assert_eq!(count(&f.store, "replication_pending_conflict_bundles"), 0);
    let ops = operations(&f.store);
    let audit: Vec<_> = ops
        .iter()
        .filter(|op| op.op_kind == BASE_OP || op.op_kind == application_record::EVENT_OP)
        .collect();
    assert_eq!(audit[0].op_kind, BASE_OP);
    for (offset, op) in audit.iter().skip(1).enumerate() {
        assert_eq!(op.payload["eventCount"], offset + 1);
    }
    let successor = ops
        .iter()
        .find(|op| op.op_kind == "conflict.resolve")
        .unwrap();
    assert!(
        successor.origin_seq > audit.last().unwrap().origin_seq,
        "retained predecessor history precedes successor bundle"
    );
    enrollment::prepare_exports(&mut f.store, "ws", &NoFaults, &crate::NoLiveLeases, 205).unwrap();
    assert_eq!(operations(&f.store), ops);
    accept_enrollment_event(&mut f, 4);
    assert_eq!(
        count(&f.store, "live_audit_event_publications"),
        4,
        "caught-up writes publish atomically"
    );
}

#[test]
fn origin_recovery_keeps_pending_live_exports_publishable() {
    let mut f = fixture(false);
    bootstrap(&mut f, false).unwrap();
    accept_enrollment_event(&mut f, 1);
    contact(&mut f.store);
    assert_eq!(count(&f.store, "live_audit_pending_exports"), 1);
    let ops = operations(&f.store);
    let relay = crate::tests::FakeRelay::default();
    *relay.pull.lock().unwrap() = Some(crate::PullResponse {
        next_cursor: ops.len() as i64,
        ops,
        has_more: false,
    });
    let recovery = crate::RelaySyncClient::new(relay);
    let recovered = recovery
        .recover_origin(&mut f.store, "ws", "recovered-owner", &NoFaults)
        .unwrap();
    assert_eq!(recovered.preserved_ops, 0);
    f.store
        .write_with(&NoFaults, |tx| {
            assert!(crate::workspace_replicates_with_relay_in_tx(tx, "ws")?);
            Ok::<_, SyncError>(())
        })
        .unwrap();
    f.store = EngineStore::open(&f.path, 202).unwrap();
    let cursor = crate::read_relay_cursor(&f.store, "ws").unwrap().unwrap();
    assert_eq!(cursor.cursor, 0);
    assert!(cursor.bootstrap_complete);
    let client = crate::RelaySyncClient::new(crate::tests::FakeRelay::default());
    client
        .claim_workspace(
            &mut f.store,
            crate::ClaimRequest {
                workspace_id: "ws".into(),
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
            },
            None,
            &NoFaults,
        )
        .unwrap();
    client
        .push_workspace(
            &mut f.store,
            "ws",
            &NoFaults,
            &crate::NoLiveLeases,
            203,
            100_000_000,
        )
        .expect("pending exports must survive origin recovery without another pull");
    assert_eq!(count(&f.store, "live_audit_event_publications"), 1);
    assert_eq!(count(&f.store, "live_audit_pending_exports"), 0);
}

#[test]
fn retained_base_export_preserves_a_different_current_marker() {
    let mut f = fixture(false);
    bootstrap(&mut f, false).unwrap();
    let replacement_doc = dohc_engine_collab::Ydoc::wire();
    replacement_doc.apply(&f.bytes).unwrap();
    replacement_doc
        .rewrite_content_to_markdown_preserving_source(
            dohc_engine_collab::ContentKind::Richdoc,
            "A different current marker",
        )
        .unwrap();
    let replacement_bytes = replacement_doc.encode_full_state();
    let replacement = hex_sha256(&replacement_bytes);
    f.store.write_with(&NoFaults,|tx| {
        put_binary_blob(tx, &replacement_bytes)?;
        tx.execute("UPDATE ydoc_docs SET lineage_claim_id=?1 WHERE workspace_id='ws' AND version_id='main' AND object_id='object'",[&replacement]).map_err(SyncError::persist)?;
        Ok::<_,SyncError>(())
    }).unwrap();
    contact(&mut f.store);
    enrollment::prepare_exports(&mut f.store, "ws", &NoFaults, &crate::NoLiveLeases, 201).unwrap();
    assert_eq!(count(&f.store, "live_audit_base_publications"), 1);
    let key = DocKey::new("ws", "main", "object").unwrap();
    let marker = f
        .store
        .read_with(|conn| dohc_engine_collab::read_marker_in(conn, &key))
        .unwrap()
        .unwrap();
    assert_eq!(marker.lineage_claim_id, Some(replacement));
    assert_eq!(marker.base_origin_id, None);
    assert_eq!(
        published(&f).payload["record"]["checkpoint"]["binding"]["lineageClaimId"],
        f.binding.lineage_claim_id
    );
}

#[test]
fn an_existing_scoped_content_coordinate_keeps_its_original_attribution() {
    let mut f = fixture(true);
    bootstrap_committed::<Box<dyn std::error::Error>>(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.handle,
        f.input.clone(),
        f.bytes.clone(),
        &NoFaults,
        |tx, _, namespace, binding| {
            let key = DocKey::new("ws", "main", "object")?;
            let payload = crate::ydoc_update_payload(
                &key,
                "note.md",
                ContentKind::Richdoc,
                &binding.lineage_claim_id,
                &binding.lineage_claim_id,
                Some("original-author"),
                None,
                true,
            );
            let sequence = journal_local_op_in_tx(tx, "ws", "ydoc.update", &payload, 10)?;
            dohc_engine_collab::record_base_coordinate_in_tx(
                tx,
                dohc_engine_collab::BaseCoordinateRecord {
                    key: &key,
                    lineage_claim_id: &binding.lineage_claim_id,
                    origin_id: "owner-origin",
                    origin_seq: sequence,
                    relay_seq: Some(4),
                    now_ms: 10,
                },
            )?;
            journal_live_base_in_tx(tx, namespace, binding, 100)?;
            Ok(())
        },
    )
    .unwrap();
    let ops = operations(&f.store);
    let bases: Vec<_> = ops
        .iter()
        .filter(|op| op.op_kind == "ydoc.update")
        .collect();
    assert_eq!(bases.len(), 1);
    assert_eq!(bases[0].payload["actorOriginId"], "original-author");
    assert_eq!(
        published(&f).payload["record"]["baseCoordinate"]["originSeq"],
        bases[0].origin_seq
    );
}

fn import_source(f: &Fixture) -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let (scratch, path, mut store) = open_store();
    store
        .write_with(&NoFaults, |tx| put_binary_blob(tx, &f.bytes))
        .unwrap();
    let mut cache = WriterDocCache::new();
    for mut op in operations(&f.store) {
        op.relay_seq = Some(op.origin_seq + 1);
        let applied = crate::apply_replication_envelope(
            &mut store,
            &mut cache,
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(
            matches!(applied.primary, ApplyDisposition::Applied(_)),
            "{}: {:?}",
            op.op_kind,
            applied.primary
        );
    }
    (scratch, path, store)
}

#[test]
fn imported_authored_live_update_annotates_only_its_changed_projection() {
    import_authored_projection(false, false, None, false);
}

#[test]
fn audited_authors_reach_a_deferred_projection_after_reopen() {
    import_authored_projection(true, false, None, false);
}

#[test]
fn audited_projection_preserves_existing_and_checkpoint_authors() {
    import_authored_projection(false, true, None, false);
}

#[test]
fn drained_projection_keeps_authorless_coordinate_coverage() {
    import_authored_projection(true, false, Some(FirstDrainCoordinate::Unattributed), false);
}

#[test]
fn drained_projection_unions_verified_recipient_coordinates() {
    import_authored_projection(true, false, Some(FirstDrainCoordinate::Verified), false);
}

#[test]
fn late_drain_audit_cannot_remove_unattributed_coverage() {
    import_authored_projection(true, false, Some(FirstDrainCoordinate::Verified), true);
}

#[test]
fn drained_projection_keeps_declared_and_verified_authors_without_attestation() {
    import_authored_projection(true, false, Some(FirstDrainCoordinate::Declared), false);
}

#[test]
fn late_audit_cannot_attest_a_declared_drain_without_a_coverage_marker() {
    import_authored_projection(true, false, Some(FirstDrainCoordinate::Declared), true);
}

#[test]
fn drained_projection_covers_bytes_from_a_refused_path() {
    import_authored_projection(true, false, Some(FirstDrainCoordinate::RefusedPath), false);
}

#[derive(Clone, Copy, PartialEq)]
enum FirstDrainCoordinate {
    Unattributed,
    Verified,
    RefusedPath,
    Declared,
}

fn import_authored_projection(
    deferred: bool,
    mixed: bool,
    first_coordinate: Option<FirstDrainCoordinate>,
    late: bool,
) {
    use dohc_engine_collab::live_update_application::{
        AdmittedLiveUpdate, AdmittedLiveUpdateMetadata, LiveUpdateReceipt, RelayAcceptedLiveUpdate,
        ServerDerivedLiveUpdateAuthority, apply_committed,
    };
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&f.bytes).unwrap();
    let first_update = first_coordinate.map(|_| doc.richdoc_append_paragraph("First coordinate."));
    let update = doc.richdoc_append_paragraph("Recipient changed this paragraph.");
    let authors = json!([{"kind":"human","humanId":"recipient","humanName":"Recipient"}]);
    let other = json!({"kind":"link","publicPrincipalId":"other-link","label":"Link editor"});
    let prior = json!([{"kind":"human","humanId":"owner","humanName":"Owner"}]);
    let event = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: "changed-delivery".into(),
                    update_digest: hex_sha256(&update),
                    journal_cursor: if first_coordinate.is_some() { 2 } else { 1 },
                    accepting_host_epoch: 1,
                },
                binding: f.binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Named {
                    principal_id: "recipient".into(),
                    grant_id: "edit-grant".into(),
                    grant_generation: 1,
                },
                received_at_ms: 200,
            },
            first_seen: Vec::new(),
            canonical_version: Some(2),
            author_snapshot: Some(serde_json::from_value(authors.clone()).unwrap()),
            first_seen_deletes: Some(Vec::new()),
            checkpoint_coverage: mixed.then(|| {
                serde_json::from_value(json!([
                    {"author":other,"structRanges":[],"deletionRanges":[]}
                ]))
                .unwrap()
            }),
        },
        update_bytes: update,
    };
    let mut events = Vec::new();
    if let Some(bytes) = first_update {
        let mut first = event.clone();
        first.update_bytes = bytes;
        first.metadata.accepted.receipt.delivery_id = "first-delivery".into();
        first.metadata.accepted.receipt.update_digest = hex_sha256(&first.update_bytes);
        first.metadata.accepted.receipt.journal_cursor = 1;
        first.metadata.author_snapshot = (first_coordinate == Some(FirstDrainCoordinate::Verified))
            .then(|| serde_json::from_value(authors.clone()).unwrap());
        if first.metadata.author_snapshot.is_none() {
            first.metadata.canonical_version = None;
            first.metadata.first_seen_deletes = None;
        }
        events.push(first);
    }
    events.push(event);
    for event in events {
        apply_committed(
            &mut f.store,
            &mut WriterDocCache::new(),
            &f.handle,
            event,
            &NoFaults,
            100_000_000,
            |tx, namespace, binding, count| {
                journal_live_event_in_tx(tx, namespace, binding, count, 200)
                    .map(|_| ())
                    .map_err(|error| {
                        dohc_engine_collab::live_update_application::ApplicationError::Storage(
                            dohc_engine_storage::StorageError::persist_public(error),
                        )
                    })
            },
        )
        .unwrap();
    }
    let (_scratch, path, mut receiver) = open_store();
    let blobs: Vec<Vec<u8>> = f
        .store
        .read_with(|conn| {
            conn.prepare("SELECT bytes FROM binary_blobs")?
                .query_map([], |row| row.get(0))?
                .collect()
        })
        .unwrap();
    receiver
        .write_with(&NoFaults, |tx| {
            for bytes in &blobs {
                put_binary_blob(tx, bytes)?;
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let mut cache = WriterDocCache::new();
    let mut projection = None;
    let mut late_ops = Vec::new();
    let ops = operations(&f.store);
    let last_audit_seq = ops
        .iter()
        .rev()
        .find(|op| op.op_kind == application_record::EVENT_OP)
        .unwrap()
        .origin_seq;
    let first_delta_seq = ops
        .iter()
        .find(|op| op.op_kind == "ydoc.update" && op.payload["isBaseState"] != true)
        .unwrap()
        .origin_seq;
    for mut op in ops {
        op.relay_seq = Some(op.origin_seq + 1);
        if first_coordinate == Some(FirstDrainCoordinate::Declared)
            && op.op_kind == "ydoc.update"
            && op.payload["isBaseState"] != true
            && (op.origin_seq == first_delta_seq || late)
        {
            op.payload["actorOriginId"] = json!("agent-x");
            op.payload["attribution"] = json!({"actorKind":"agent","depth":0});
        }
        if late && op.op_kind == application_record::EVENT_OP && op.origin_seq == last_audit_seq {
            late_ops.push(op);
            continue;
        }
        let live = deferred && op.op_kind == "ydoc.update" && op.payload["isBaseState"] != true;
        if op.op_kind == application_record::EVENT_OP && !deferred {
            // A canonical record naming a different content coordinate may not stamp any projection.
            let manifest: chunks::Manifest =
                serde_json::from_value(op.payload["manifest"].clone()).unwrap();
            let bad = receiver
                .read_with(|conn| {
                    use std::io::{Read, Write};
                    let mut reader = chunks::ChunkReader::new(conn, &manifest).unwrap();
                    let mut text = String::new();
                    reader.read_to_string(&mut text).unwrap();
                    reader.finish().unwrap();
                    let coordinate = format!(
                        "\"contentCoordinate\":{{\"originId\":\"owner-origin\",\"originSeq\":{}}}",
                        op.origin_seq - 1
                    );
                    assert!(text.contains(&coordinate));
                    let text = text.replace(
                        &coordinate,
                        "\"contentCoordinate\":{\"originId\":\"owner-origin\",\"originSeq\":1}",
                    );
                    let mut writer = chunks::ChunkWriter::new(conn);
                    writer.write_all(text.as_bytes()).unwrap();
                    writer.finish()
                })
                .unwrap();
            let mut forged = op.clone();
            forged.origin_id = "forged-audit".into();
            forged.origin_seq = 0;
            forged.payload["manifest"] = serde_json::to_value(bad).unwrap();
            let refused = apply_audit_envelope(&mut receiver, &forged, &NoFaults);
            assert!(
                refused.is_err()
                    || matches!(refused.unwrap().primary, ApplyDisposition::Refused(_))
            );
            assert_eq!(count(&receiver, "live_audit_projection_authors"), 0);
            if mixed {
                receiver
                    .read_with(|conn| {
                        conn.execute(
                            "UPDATE moments SET author_json=?2 WHERE moment_id=?1",
                            params![projection.as_ref().unwrap(), prior.to_string()],
                        )
                    })
                    .unwrap();
            }
        }
        let leases: &dyn crate::LeaseProbe = if live {
            &crate::AlwaysLive
        } else {
            &NoLiveLeases
        };
        let result =
            crate::apply_replication_envelope(&mut receiver, &mut cache, &op, &NoFaults, leases)
                .unwrap();
        assert!(
            matches!(result.primary, ApplyDisposition::Applied(_)),
            "{}: {:?}",
            op.op_kind,
            result.primary
        );
        if op.op_kind == "ydoc.update" && op.payload["isBaseState"] != true {
            let key = DocKey::new("ws", "main", "object").unwrap();
            let id = crate::ydoc_apply::ydoc_apply_moment_id(
                &key,
                "note.md",
                &op.origin_id,
                op.origin_seq,
            );
            let moment = VersionedTextStore::new(&mut receiver)
                .get_moment("ws", &id)
                .unwrap();
            if deferred {
                assert!(moment.is_none());
            } else {
                let moment = moment.unwrap();
                assert!(moment.author_json.is_none());
            }
            projection = Some(id);
        }
    }
    let id = projection.expect("changed projection");
    if deferred {
        if first_coordinate == Some(FirstDrainCoordinate::RefusedPath) {
            // Exercise the drain's path refusal after importing the audit chain.
            receiver.read_with(|conn| conn.execute(
                "UPDATE replication_log SET payload_json=json_set(payload_json,'$.path','wrong.md') WHERE workspace_id='ws' AND origin_id='owner-origin' AND origin_seq=?1",
                [first_delta_seq],
            )).unwrap();
        }
        assert_eq!(
            count(&receiver, "live_audit_projection_authors"),
            i64::from(first_coordinate == Some(FirstDrainCoordinate::Verified)) + i64::from(!late)
        );
        drop(receiver);
        receiver = EngineStore::open(&path, 250).unwrap();
        let drained = crate::drain_deferred_ydoc_for_key(
            &mut receiver,
            &mut WriterDocCache::new(),
            &DocKey::new("ws", "main", "object").unwrap(),
            &NoFaults,
        )
        .unwrap();
        assert_eq!(
            drained.drained,
            if first_coordinate.is_some() { 2 } else { 1 }
        );
        if first_coordinate == Some(FirstDrainCoordinate::RefusedPath) {
            assert_eq!(drained.refusals.len(), 1);
        }
    }
    for op in late_ops {
        let result = crate::apply_replication_envelope(
            &mut receiver,
            &mut cache,
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(matches!(result.primary, ApplyDisposition::Applied(_)));
    }
    let moment = VersionedTextStore::new(&mut receiver)
        .get_moment("ws", &id)
        .unwrap()
        .unwrap();
    let stored: serde_json::Value = serde_json::from_str(
        moment
            .author_json
            .as_deref()
            .expect("verified public authors"),
    )
    .unwrap();
    if mixed {
        assert_eq!(stored.as_array().unwrap().len(), 3);
        for author in [authors[0].clone(), prior[0].clone(), other] {
            assert!(stored.as_array().unwrap().contains(&author));
        }
    } else if first_coordinate == Some(FirstDrainCoordinate::Declared) {
        assert_eq!(
            stored,
            json!([{"kind":"agent","agentId":"agent-x"}, authors[0].clone()])
        );
    } else if matches!(
        first_coordinate,
        Some(FirstDrainCoordinate::Unattributed | FirstDrainCoordinate::RefusedPath)
    ) || late
    {
        assert_eq!(stored, json!([authors[0].clone(), {"kind":"unattributed"}]));
    } else {
        assert_eq!(stored, authors);
    }
    assert_eq!(count(&receiver, "live_device_update_applications"), 0);
    assert_eq!(count(&receiver, "live_device_application_bindings"), 0);
    drop(receiver);
    let mut receiver = EngineStore::open(&path, 300).unwrap();
    let reopened = VersionedTextStore::new(&mut receiver)
        .get_moment("ws", &id)
        .unwrap()
        .unwrap();
    assert_eq!(reopened.author_json, moment.author_json);
}

#[test]
fn declared_owner_history_exports_and_imports_with_its_agent() {
    use dohc_engine_collab::live_update_application::{
        AdmittedLiveUpdate, AdmittedLiveUpdateMetadata, ApplicationResult, LiveUpdateReceipt,
        RelayAcceptedLiveUpdate, ServerDerivedLiveUpdateAuthority, apply_committed,
    };
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    let declaration = dohc_engine_domain::AgentDeclaration {
        agent_id: "trip-agent 旅行".into(),
        on_behalf_of: Some("owner".into()),
        depth: 1,
    };
    let event = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: "declared-delivery".into(),
                    update_digest: hex_sha256(&f.bytes),
                    journal_cursor: 1,
                    accepting_host_epoch: 1,
                },
                binding: f.binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                },
                received_at_ms: 200,
            },
            first_seen: Vec::new(),

            canonical_version: Some(2),

            author_snapshot: Some(
                (Some(declaration.clone()))
                    .into_iter()
                    .map(dohc_engine_collab::live_update_application::LiveAuthorEntry::from)
                    .collect(),
            ),

            first_seen_deletes: Some(vec![]),

            checkpoint_coverage: None,
        },
        update_bytes: f.bytes.clone(),
    };
    assert!(matches!(
        apply_committed(
            &mut f.store,
            &mut WriterDocCache::new(),
            &f.handle,
            event,
            &NoFaults,
            100_000_000,
            |tx, namespace, binding, count| journal_live_event_in_tx(
                tx, namespace, binding, count, 200
            )
            .map(|_| ())
            .map_err(|error| {
                dohc_engine_collab::live_update_application::ApplicationError::Storage(
                    dohc_engine_storage::StorageError::persist_public(error),
                )
            })
        )
        .unwrap(),
        ApplicationResult::Applied(..)
    ));
    let ops = operations(&f.store);
    let audit = ops
        .iter()
        .find(|op| op.op_kind == application_record::EVENT_OP)
        .unwrap()
        .clone();
    let (_scratch, path, mut receiver) = open_store();
    let blobs: Vec<Vec<u8>> = f
        .store
        .read_with(|conn| {
            conn.prepare("SELECT bytes FROM binary_blobs")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    receiver
        .write_with(&NoFaults, |tx| {
            for bytes in &blobs {
                put_binary_blob(tx, bytes)?;
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
    for mut op in ops {
        op.relay_seq = Some(op.origin_seq + 1);
        let result = crate::apply_replication_envelope(
            &mut receiver,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(
            matches!(result.primary, ApplyDisposition::Applied(_)),
            "{}: {:?}",
            op.op_kind,
            result.primary
        );
    }
    drop(receiver);
    let receiver = EngineStore::open(&path, 300).unwrap();
    assert_eq!(count(&receiver, "live_audit_events"), 1);
    assert_eq!(count(&receiver, "live_device_update_applications"), 0);
    let manifest: chunks::Manifest =
        serde_json::from_value(audit.payload["manifest"].clone()).unwrap();
    receiver
        .read_with(|conn| {
            let mut reader = chunks::ChunkReader::new(conn, &manifest).unwrap();
            let record: serde_json::Value = serde_json::from_reader(&mut reader).unwrap();
            reader.finish().unwrap();
            let accepted = &record["metadata"]["accepted"];
            assert_eq!(
                record["metadata"]["authorSnapshot"][0],
                serde_json::to_value(
                    dohc_engine_collab::live_update_application::LiveAuthorEntry::from(
                        declaration.clone()
                    )
                )
                .unwrap()
            );
            // The declaration sits beside the authority; it never replaces it.
            assert_eq!(accepted["authority"]["principalKind"], "owner");
            assert_eq!(accepted["authority"]["principalId"], "owner");
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

#[test]
fn admitted_link_history_roundtrips_without_creating_native_authority() {
    use dohc_engine_collab::live_update_application::{
        AdmittedLiveUpdate, AdmittedLiveUpdateMetadata, ApplicationResult, LiveUpdateReceipt,
        RelayAcceptedLiveUpdate, ServerDerivedLiveUpdateAuthority, apply_committed,
    };
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    // Reusing an accepted base has no newly attributed structs, but retains
    // the distinct link delivery and its receipt as historical evidence.
    let event = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: "link-delivery".into(),
                    update_digest: hex_sha256(&f.bytes),
                    journal_cursor: 1,
                    accepting_host_epoch: 1,
                },
                binding: f.binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Link {
                    principal_id: "link-principal".into(),
                    grant_id: "link-grant".into(),
                    grant_generation: 1,
                },
                received_at_ms: 200,
            },
            first_seen: Vec::new(),
            canonical_version: None,
            author_snapshot: None,
            first_seen_deletes: None,
            checkpoint_coverage: None,
        },
        update_bytes: f.bytes.clone(),
    };
    let before = operations(&f.store);
    let failed = apply_committed(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.handle,
        event.clone(),
        &NoFaults,
        100_000_000,
        |tx, namespace, binding, count| {
            journal_live_event_in_tx(tx, namespace, binding, count, 200).map_err(|error| {
                dohc_engine_collab::live_update_application::ApplicationError::Storage(
                    dohc_engine_storage::StorageError::persist_public(error),
                )
            })?;
            Err(dohc_engine_collab::live_update_application::ApplicationError::Interrupted)
        },
    );
    assert!(failed.is_err());
    assert_eq!(operations(&f.store), before);
    assert_eq!(count(&f.store, "live_device_update_applications"), 0);
    assert_eq!(count(&f.store, "live_accepted_updates"), 0);
    assert_eq!(count(&f.store, "live_audit_events"), 0);
    assert!(matches!(
        apply_committed(
            &mut f.store,
            &mut WriterDocCache::new(),
            &f.handle,
            event,
            &NoFaults,
            100_000_000,
            |tx, namespace, binding, count| journal_live_event_in_tx(
                tx, namespace, binding, count, 200
            )
            .map(|_| ())
            .map_err(|error| {
                dohc_engine_collab::live_update_application::ApplicationError::Storage(
                    dohc_engine_storage::StorageError::persist_public(error),
                )
            })
        )
        .unwrap(),
        ApplicationResult::Applied(..)
    ));
    let seq = f
        .store
        .write_with(&NoFaults, |tx| {
            journal_live_event_in_tx(tx, "relay", &f.binding, 1, 201)
        })
        .unwrap();
    assert!(matches!(
        seq,
        dohc_engine_storage::TxnOutcome::Committed(Some(_))
    ));
    let after = operations(&f.store);
    assert_eq!(
        after.len(),
        before.len() + 1,
        "existing content coordinate is reused"
    );
    f.store
        .write_with(&NoFaults, |tx| {
            journal_live_event_in_tx(tx, "relay", &f.binding, 1, 202)
        })
        .unwrap();
    assert_eq!(operations(&f.store), after);
    let audit = after
        .iter()
        .find(|op| op.op_kind == application_record::EVENT_OP)
        .unwrap()
        .clone();
    let (_scratch, path, mut receiver) = open_store();
    let blobs: Vec<Vec<u8>> = f
        .store
        .read_with(|conn| {
            conn.prepare("SELECT bytes FROM binary_blobs")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    receiver
        .write_with(&NoFaults, |tx| {
            for bytes in &blobs {
                put_binary_blob(tx, bytes)?;
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
    for mut op in after {
        op.relay_seq = Some(op.origin_seq + 1);
        let result = crate::apply_replication_envelope(
            &mut receiver,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(
            matches!(result.primary, ApplyDisposition::Applied(_)),
            "{}: {:?}",
            op.op_kind,
            result.primary
        );
    }
    assert_eq!(count(&receiver, "live_audit_events"), 1);
    for table in [
        "live_device_update_applications",
        "live_device_application_bindings",
        "live_owner_adoptions",
        "live_accepted_updates",
    ] {
        assert_eq!(count(&receiver, table), 0);
    }
    drop(receiver);
    let mut receiver = EngineStore::open(&path, 300).unwrap();
    assert_eq!(count(&receiver, "live_audit_events"), 1);
    let manifest: chunks::Manifest =
        serde_json::from_value(audit.payload["manifest"].clone()).unwrap();
    receiver
        .read_with(|conn| {
            for chunk in &manifest.chunks {
                assert!(
                    conn.execute("DELETE FROM binary_blobs WHERE sha256=?1", [&chunk.sha256])
                        .is_err()
                );
            }
            let mut reader = chunks::ChunkReader::new(conn, &manifest).unwrap();
            let record: serde_json::Value = serde_json::from_reader(&mut reader).unwrap();
            reader.finish().unwrap();
            assert_eq!(
                record["metadata"]["accepted"]["authority"]["principalKind"],
                "link"
            );
            assert_eq!(
                record["metadata"]["accepted"]["authority"]["principalId"],
                "link-principal"
            );
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let mut missing = audit.clone();
    missing.origin_seq += 1;
    missing.relay_seq = Some(missing.origin_seq + 1);
    missing.payload["manifest"]["chunks"][0]["sha256"] = json!("f".repeat(64));
    assert!(matches!(
        apply_audit_envelope(&mut receiver, &missing, &NoFaults),
        Err(SyncError::BlobInvalid)
    ));
    assert_eq!(
        crate::read_replication_acked_seq(&receiver, "ws", "owner-origin").unwrap(),
        audit.origin_seq
    );
    let changed = receiver
        .read_with(|conn| {
            use std::io::{Read, Write};
            let mut reader = chunks::ChunkReader::new(conn, &manifest).unwrap();
            let mut text = String::new();
            reader.read_to_string(&mut text).unwrap();
            reader.finish().unwrap();
            assert!(text.contains("\"connectionId\":\"connection\""));
            let text = text.replace(
                "\"connectionId\":\"connection\"",
                "\"connectionId\":\"conflicting-connection\"",
            );
            let mut writer = chunks::ChunkWriter::new(conn);
            writer.write_all(text.as_bytes()).unwrap();
            writer.finish()
        })
        .unwrap();
    let mut conflict = missing;
    conflict.payload["manifest"] = serde_json::to_value(&changed).unwrap();
    assert!(matches!(
        apply_audit_envelope(&mut receiver, &conflict, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    assert_eq!(count(&receiver, "live_audit_events"), 1);
    assert_eq!(count(&receiver, "live_audit_event_conflicts"), 1);
    assert_eq!(
        crate::read_replication_acked_seq(&receiver, "ws", "owner-origin").unwrap(),
        conflict.origin_seq
    );
    receiver
        .read_with(|conn| {
            for chunk in &changed.chunks {
                assert!(
                    conn.execute("DELETE FROM binary_blobs WHERE sha256=?1", [&chunk.sha256])
                        .is_err()
                );
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

#[test]
fn imported_event_zero_is_durable_historical_evidence_without_native_authority_or_echo() {
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    let (_scratch, path, mut receiver) = import_source(&f);
    assert_eq!(count(&receiver, "live_audit_bases"), 1);
    for table in [
        "live_audit_base_publications",
        "live_accepted_checkpoints",
        "live_device_bootstraps",
        "live_owner_adoptions",
        "live_restore_fences",
        "live_device_application_bindings",
        "live_device_update_applications",
    ] {
        assert_eq!(count(&receiver, table), 0, "{table}");
    }
    let mut replay = published(&f);
    replay.relay_seq = Some(replay.origin_seq + 1);
    assert!(matches!(
        apply_base_envelope(&mut receiver, &replay, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Skipped
    ));
    drop(receiver);
    let receiver = EngineStore::open(&path, 200).unwrap();
    assert_eq!(count(&receiver, "live_audit_bases"), 1);
    assert_eq!(
        receiver
            .read_with(|conn| conn.query_row(
                "SELECT COUNT(*) FROM replication_log WHERE imported=0",
                [],
                |row| row.get::<_, i64>(0)
            ))
            .unwrap(),
        0
    );
    assert!(
        receiver
            .read_with(|conn| conn.execute(
                "DELETE FROM binary_blobs WHERE sha256=?1",
                [&f.binding.lineage_claim_id]
            ))
            .is_err()
    );
}

#[test]
fn conflicting_audit_identity_keeps_both_records_and_classifies_the_coordinate() {
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    let (_scratch, _path, mut receiver) = import_source(&f);
    let original = published(&f);
    let mut conflict = original.clone();
    conflict.origin_seq += 1;
    conflict.relay_seq = Some(conflict.origin_seq + 1);
    let mut payload: BasePayload = serde_json::from_value(original.payload.clone()).unwrap();
    if let origin_record::OriginRecord::Bootstrap { source, .. } = &mut payload.record.origin {
        source.bootstrap_id = "different-authenticated-bootstrap".into();
    } else {
        panic!("expected native bootstrap");
    }
    payload.record.origin_stamp = receiver
        .read_with(|conn| {
            payload
                .record
                .origin
                .stamp(conn, &payload.record.checkpoint.binding)
        })
        .unwrap();
    conflict.payload = payload.record.payload().unwrap();
    assert!(matches!(
        apply_base_envelope(&mut receiver, &conflict, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    assert_eq!(count(&receiver, "live_audit_bases"), 1);
    assert_eq!(count(&receiver, "live_audit_base_conflicts"), 1);
    let saved: String = receiver
        .read_with(|conn| {
            conn.query_row("SELECT record_digest FROM live_audit_bases", [], |row| {
                row.get(0)
            })
        })
        .unwrap();
    assert_eq!(saved, original.payload["recordDigest"].as_str().unwrap());
    assert_eq!(
        crate::read_replication_acked_seq(&receiver, "ws", "owner-origin").unwrap(),
        conflict.origin_seq
    );
    assert!(matches!(
        apply_base_envelope(&mut receiver, &conflict, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Skipped
    ));
    conflict.payload = original.payload;
    assert!(matches!(
        apply_base_envelope(&mut receiver, &conflict, &NoFaults),
        Err(SyncError::CoordinateDiverged)
    ));
}

#[test]
fn missing_bytes_and_base_ordering_do_not_advance_the_peer_ack() {
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    let (_scratch, _path, mut receiver) = open_store();
    let mut audit = published(&f);
    audit.origin_id = "audit-first".into();
    audit.origin_seq = 0;
    audit.relay_seq = Some(10);
    assert!(matches!(
        apply_base_envelope(&mut receiver, &audit, &NoFaults),
        Err(SyncError::BlobInvalid)
    ));
    assert_eq!(
        crate::read_replication_acked_seq(&receiver, "ws", "audit-first").unwrap(),
        -1
    );
    receiver
        .write_with(&NoFaults, |tx| put_binary_blob(tx, &f.bytes))
        .unwrap();
    assert!(matches!(
        apply_base_envelope(&mut receiver, &audit, &NoFaults),
        Err(SyncError::RetryableState { .. })
    ));
    assert_eq!(
        crate::read_replication_acked_seq(&receiver, "ws", "audit-first").unwrap(),
        -1
    );
    assert_eq!(count(&receiver, "live_audit_bases"), 0);
}

#[test]
fn scope_digest_and_nonzero_checkpoint_forgeries_are_refused_without_native_rows() {
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    for variant in 0..4 {
        let (_scratch, _path, mut receiver) = open_store();
        let mut audit = published(&f);
        audit.origin_seq = 0;
        let mut payload: BasePayload = serde_json::from_value(audit.payload.clone()).unwrap();
        match variant {
            0 => payload.record.checkpoint.binding.workspace_id = "foreign".into(),
            1 => payload.record.checkpoint.event_count = 1,
            2 => payload.record.origin_stamp = "invalid".into(),
            _ => {}
        }
        audit.payload = payload.record.payload().unwrap();
        if variant == 3 {
            audit.payload["recordDigest"] = json!("f".repeat(64));
        }
        assert!(matches!(
            apply_base_envelope(&mut receiver, &audit, &NoFaults)
                .unwrap()
                .primary,
            ApplyDisposition::Refused(_)
        ));
        assert_eq!(count(&receiver, "live_audit_bases"), 0);
        assert_eq!(count(&receiver, "live_device_application_bindings"), 0);
    }
}

#[test]
fn a_global_digest_match_cannot_substitute_another_documents_base_coordinate() {
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    let (_scratch, _path, mut receiver) = open_store();
    receiver
        .write_with(&NoFaults, |tx| put_binary_blob(tx, &f.bytes))
        .unwrap();
    let mut base = operations(&f.store)
        .into_iter()
        .find(|op| op.op_kind == "ydoc.update")
        .unwrap();
    base.origin_id = "other-base".into();
    base.origin_seq = 0;
    base.payload["objectId"] = json!("other-object");
    crate::apply_envelope_with(&mut receiver, &base, &NoFaults, |_, _| Ok(())).unwrap();
    let mut audit = published(&f);
    audit.origin_id = "audit".into();
    audit.origin_seq = 0;
    let mut payload: BasePayload = serde_json::from_value(audit.payload.clone()).unwrap();
    payload.record.base_coordinate = BaseCoordinate {
        origin_id: base.origin_id,
        origin_seq: 0,
    };
    audit.payload = payload.record.payload().unwrap();
    assert!(matches!(
        apply_base_envelope(&mut receiver, &audit, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    assert_eq!(count(&receiver, "live_audit_bases"), 0);
}

#[test]
fn every_file_share_level_refuses_historical_native_audit() {
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    let audit = published(&f);
    for access in [
        crate::ShareAccess::View,
        crate::ShareAccess::Comment,
        crate::ShareAccess::Edit,
    ] {
        let (_scratch, _path, mut receiver) = open_store();
        let boundary = crate::ShareBoundary {
            share_id: "share".into(),
            surface: crate::ShareSurface::ShareView,
            channel_wire_id: None,
            granted: Some(crate::ShareGrant {
                paths: vec![],
                version_id: Some("main".into()),
                access,
            }),
        };
        assert!(matches!(
            crate::apply_shared_envelope(&mut receiver, &boundary, &audit, &NoFaults),
            Err(SyncError::ShareBoundaryViolation)
        ));
        assert_eq!(count(&receiver, "live_audit_bases"), 0);
        assert_eq!(count(&receiver, "replication_log"), 0);
    }
}

#[test]
fn bounded_event_zero_payload_fits_the_existing_operation_ceiling() {
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    let mut payload: BasePayload = serde_json::from_value(published(&f).payload).unwrap();
    let b = &mut payload.record.checkpoint.binding;
    b.workspace_id = "\\".repeat(512);
    b.main_version_id = "\\".repeat(512);
    b.object_id = "\\".repeat(512);
    b.current_path = "\\".repeat(1024);
    b.selector_paths = vec!["\\".repeat(1024); 100];
    b.restore_fence_generation = crate::MAX_WIRE_INTEGER;
    payload.record.relay_database_namespace = "\\".repeat(1024);
    payload.record.base_coordinate.origin_id = "\\".repeat(512);
    payload.record.base_coordinate.origin_seq = crate::MAX_WIRE_INTEGER;
    payload.record.base_byte_length = dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES;
    // Overstate escaping even for paths the canonical binding validator rejects.
    assert!(serde_json::to_vec(&payload).unwrap().len() < crate::MAX_PAYLOAD_JSON_BYTES);
}

#[test]
fn native_origin_details_survive_import_and_forged_source_is_rejected() {
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    let (_scratch, _path, mut receiver) = import_source(&f);
    let original = published(&f);
    let payload: BasePayload = serde_json::from_value(original.payload.clone()).unwrap();
    match &payload.record.origin {
        origin_record::OriginRecord::Bootstrap {
            source,
            local_ydoc_sequence,
            ..
        } => {
            assert_eq!(source.as_ref(), &f.input);
            assert_eq!(*local_ydoc_sequence, 0);
        }
        _ => panic!("native bootstrap provenance missing"),
    }
    let imported: String = receiver
        .read_with(|conn| {
            conn.query_row("SELECT record_json FROM live_audit_bases", [], |r| r.get(0))
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<BaseRecord>(&imported).unwrap(),
        payload.record
    );
    let mut forged = original.clone();
    forged.origin_seq += 1;
    forged.relay_seq = Some(forged.origin_seq + 1);
    let mut record = payload.record;
    if let origin_record::OriginRecord::Bootstrap { source, .. } = &mut record.origin {
        source.bootstrap_id = "forged-source".into();
    }
    forged.payload = record.payload().unwrap();
    assert!(matches!(
        apply_base_envelope(&mut receiver, &forged, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    assert_eq!(
        crate::read_replication_acked_seq(&receiver, "ws", "owner-origin").unwrap(),
        forged.origin_seq
    );
    assert_eq!(count(&receiver, "live_device_bootstraps"), 0);
    assert_eq!(count(&receiver, "live_owner_adoptions"), 0);
}

#[test]
fn historical_event_export_reads_the_base_once_then_reuses_its_published_scope() {
    let mut f = fixture(false);
    bootstrap(&mut f, false).unwrap();
    for cursor in 1..=3 {
        accept_enrollment_event(&mut f, cursor);
    }
    assert_eq!(count(&f.store, "live_audit_base_publications"), 0);
    contact(&mut f.store);
    BASE_BLOB_BYTES_READ.with(|read| read.set(0));
    for event_count in 1..=3 {
        let result = f
            .store
            .write_with(&NoFaults, |tx| {
                journal_live_event_in_tx(tx, "relay", &f.binding, event_count, 300)
            })
            .unwrap();
        assert!(matches!(
            result,
            dohc_engine_storage::TxnOutcome::Committed(Some(_))
        ));
        assert_eq!(BASE_BLOB_BYTES_READ.with(|read| read.get()), f.bytes.len());
    }
    assert_eq!(count(&f.store, "live_audit_base_publications"), 1);
    assert_eq!(count(&f.store, "live_audit_event_publications"), 3);
    let published = operations(&f.store);
    BASE_BLOB_BYTES_READ.with(|read| read.set(0));
    f.store
        .write_with(&NoFaults, |tx| {
            journal_live_event_in_tx(tx, "relay", &f.binding, 3, 301)
        })
        .unwrap();
    assert_eq!(BASE_BLOB_BYTES_READ.with(|read| read.get()), 0);
    assert_eq!(operations(&f.store), published);
    assert!(
        f.store
            .write_with(&NoFaults, |tx| {
                journal_live_event_in_tx(tx, "different-relay", &f.binding, 1, 302)
            })
            .is_err()
    );
    assert_eq!(operations(&f.store), published);
    // An explicit base replay still verifies its complete bytes and saved coordinate.
    f.store
        .write_with(&NoFaults, |tx| {
            journal_live_base_in_tx(tx, "relay", &f.binding, 303)
        })
        .unwrap();
    assert_eq!(BASE_BLOB_BYTES_READ.with(|read| read.get()), f.bytes.len());
    assert_eq!(operations(&f.store), published);
}

fn accept_authored(
    f: &mut Fixture,
    cursor: i64,
    authority: dohc_engine_collab::live_update_application::ServerDerivedLiveUpdateAuthority,
    snapshot: Option<Vec<dohc_engine_collab::live_update_application::LiveAuthorEntry>>,
) {
    use dohc_engine_collab::live_update_application::{
        AdmittedLiveUpdate, AdmittedLiveUpdateMetadata, ApplicationError, ApplicationResult,
        LiveUpdateReceipt, RelayAcceptedLiveUpdate, apply_committed,
    };
    let versioned = snapshot.is_some();
    let event = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: format!("delivery-{cursor}"),
                    update_digest: hex_sha256(&f.bytes),
                    journal_cursor: cursor,
                    accepting_host_epoch: 1,
                },
                binding: f.binding.clone(),
                authority,
                received_at_ms: 200 + cursor,
            },
            first_seen: Vec::new(),
            canonical_version: versioned.then_some(2),
            author_snapshot: snapshot,
            first_seen_deletes: versioned.then(Vec::new),
            checkpoint_coverage: None,
        },
        update_bytes: f.bytes.clone(),
    };
    assert!(matches!(
        apply_committed(
            &mut f.store,
            &mut WriterDocCache::new(),
            &f.handle,
            event,
            &NoFaults,
            100_000_000,
            |tx, namespace, binding, count| journal_live_event_in_tx(
                tx, namespace, binding, count, 200
            )
            .map(|_| ())
            .map_err(|error| ApplicationError::Storage(
                dohc_engine_storage::StorageError::persist_public(error)
            ))
        )
        .unwrap(),
        ApplicationResult::Applied(..)
    ));
}

/// Settle through `terminal` as the host does, naming every author the
/// interval admitted, with the proof that publishes it. Returns the settled
/// moment's authors.
fn settle_interval(f: &mut Fixture, terminal: i64, moment_id: &str) -> serde_json::Value {
    use dohc_engine_collab::live_update_application::{LiveUpdateReceipt, with_settlement};
    use dohc_engine_storage::TxnOutcome;
    let receipt = LiveUpdateReceipt {
        delivery_id: format!("delivery-{terminal}"),
        update_digest: hex_sha256(&f.bytes),
        journal_cursor: terminal,
        accepting_host_epoch: 1,
    };
    with_settlement::<Box<dyn std::error::Error>, _>(
        &mut f.store,
        &f.handle,
        Some(receipt),
        8,
        dohc_engine_collab::live_update_application::NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        },
        |store, audit| {
            let b = audit.binding();
            let key = dohc_engine_collab::DocKey::new(
                &b.workspace_id, &b.main_version_id, &b.object_id,
            )?;
            let doc = store.read_with(|conn| dohc_engine_collab::durable::load_doc_in(conn, &key))?;
            let projected = doc.project(dohc_engine_collab::ContentKind::Richdoc)?.content;
            let content = doc.preserved_markdown_source(&projected).unwrap_or(projected);
            let vector = hex_sha256(&doc.encode_state_vector());
            let result = store.write_with(&NoFaults, |tx| -> Result<(), Box<dyn std::error::Error>> {
                let authors = dohc_engine_collab::author_coverage::interval_in(tx, &key, i64::MAX)?
                    .moment_json();
                let written = dohc_engine_domain::write_projected_text_in_tx(tx,
                    dohc_engine_domain::ProjectedWriteText {
                        workspace_id: &b.workspace_id,
                        version_id: &b.main_version_id,
                        object_id: &b.object_id,
                        path: std::borrow::Cow::Borrowed(&b.current_path),
                        text: std::borrow::Cow::Borrowed(&content),
                        moment_id,
                        metadata_origin: "ydoc",
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: authors.as_deref(),
                        now_ms: 300,
                        request_id: None,
                    })?;
                tx.execute(
                    "UPDATE ydoc_docs SET last_settled_sha=?4 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    params![b.workspace_id,b.main_version_id,b.object_id,written.snapshot.blob_sha256],
                )?;
                let id = audit.record_in_tx(tx, moment_id, &written.snapshot.blob_sha256, &vector, 300)?;
                audit.record_publication_state_in_tx(tx, &id, &doc.encode_full_state())?;
                assert!(journal_live_settlement_in_tx(tx, "ws", &id, 300)?.is_some());
                Ok(())
            })?;
            match result {
                TxnOutcome::Committed(()) => Ok(()),
                TxnOutcome::Crashed { .. } => panic!("unexpected settlement crash"),
            }
        },
    )
    .unwrap();
    moment_authors(&f.store, moment_id).expect("the host credits its interval")
}

fn moment_authors(store: &EngineStore, moment_id: &str) -> Option<serde_json::Value> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT author_json FROM moments WHERE workspace_id='ws' AND moment_id=?1",
                [moment_id],
                |row| row.get::<_, Option<String>>(0),
            )
        })
        .unwrap()
        .map(|json| serde_json::from_str(&json).unwrap())
}

fn receiver_with_blobs(f: &Fixture) -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let (scratch, path, mut receiver) = open_store();
    let binary: Vec<Vec<u8>> = f
        .store
        .read_with(|conn| {
            conn.prepare("SELECT bytes FROM binary_blobs")?
                .query_map([], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    let text: Vec<(String, i64, String)> = f
        .store
        .read_with(|conn| {
            conn.prepare("SELECT sha256,byte_length,text FROM blobs")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    receiver
        .write_with(&NoFaults, |tx| {
            for bytes in &binary {
                put_binary_blob(tx, bytes)?;
            }
            for (sha, length, body) in &text {
                tx.execute(
                    "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                    params![sha, length, body],
                )
                .map_err(SyncError::persist)?;
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
    (scratch, path, receiver)
}

/// Apply each op in order and report which ones applied.
fn import_all(receiver: &mut EngineStore, ops: &[ReplicationEnvelope]) -> Vec<(String, bool)> {
    ops.iter()
        .map(|op| {
            let mut op = op.clone();
            op.relay_seq = Some(op.origin_seq + 1);
            let result = crate::apply_replication_envelope(
                receiver,
                &mut WriterDocCache::new(),
                &op,
                &NoFaults,
                &NoLiveLeases,
            )
            .unwrap();
            let applied = matches!(result.primary, ApplyDisposition::Applied(_));
            (op.op_kind, applied)
        })
        .collect()
}

/// An ordinary owner device can publish live audit evidence its own engine
/// wrote for claims no relay accepted: an Edit link, another person's
/// snapshot under a named grant, and the owner's agent. The real journal
/// recomputes every record, chunk, evidence chain and settlement digest, so
/// the evidence is valid and self-consistent. The moment itself carries only
/// its settlement proof. A peer retains the evidence as history, but credits
/// the imported moment only through a relay admission.
#[test]
fn ordinary_audit_evidence_cannot_credit_an_imported_moment() {
    use dohc_engine_collab::live_update_application::{
        LiveAuthorEntry, ServerDerivedLiveUpdateAuthority,
    };
    let kinds = |authors: &serde_json::Value| {
        let mut kinds: Vec<String> = authors
            .as_array()
            .unwrap()
            .iter()
            .map(|author| author["kind"].as_str().unwrap().to_owned())
            .collect();
        kinds.sort();
        kinds
    };
    let moment_id = format!("moment-ydoc-{}", "d".repeat(64));
    for native_settlements in [false, true] {
        let mut f = fixture(true);
        bootstrap(&mut f, false).unwrap();
        // A claimed Edit link holder whose client sent no recording context.
        accept_authored(
            &mut f,
            1,
            ServerDerivedLiveUpdateAuthority::Link {
                principal_id: "claimed-holder".into(),
                grant_id: "claimed-link".into(),
                grant_generation: 1,
            },
            None,
        );
        // Another person, claimed under a named grant.
        accept_authored(
            &mut f,
            2,
            ServerDerivedLiveUpdateAuthority::Named {
                principal_id: "claimed-user".into(),
                grant_id: "claimed-grant".into(),
                grant_generation: 1,
            },
            Some(vec![LiveAuthorEntry::Human {
                human_id: "claimed-person".into(),
                human_name: "Claimed person".into(),
            }]),
        );
        // The owner and the agent working for them.
        accept_authored(
            &mut f,
            3,
            ServerDerivedLiveUpdateAuthority::Owner {
                principal_id: "owner".into(),
            },
            Some(vec![
                LiveAuthorEntry::Human {
                    human_id: "owner".into(),
                    human_name: "Owner".into(),
                },
                LiveAuthorEntry::Agent {
                    agent_id: "trip-agent".into(),
                    agent_name: Some("Trip agent".into()),
                    on_behalf_of: Some("owner".into()),
                    depth: Some(1),
                },
            ]),
        );
        let host = settle_interval(&mut f, 3, &moment_id);
        // This device's raw History keeps every claim it admitted. The named
        // grant stands in for the claimed person's snapshot; the owner and
        // their agent keep theirs.
        assert_eq!(
            kinds(&host),
            ["agent", "human", "link", "named", "unattributed"]
        );
        let mut ops = operations(&f.store);
        crate::outbound::repair_queued_moment_authors(
            &mut f.store,
            &mut ops,
            &NoFaults,
            native_settlements,
        )
        .unwrap();
        assert_eq!(
            (
                ops.iter()
                    .filter(|op| op.op_kind == application_record::EVENT_OP)
                    .count(),
                ops.iter()
                    .filter(|op| op.op_kind == settlement_record::SETTLEMENT_OP)
                    .count(),
            ),
            (3, 1)
        );
        let moment = ops
            .iter()
            .find(|op| {
                op.op_kind == "moment.append" && op.payload["momentId"] == moment_id.as_str()
            })
            .unwrap();
        // Neither credential carries the moment's authors; only the relay's
        // admission of its settlement proof can credit them.
        assert!(moment.payload.get("authors").is_none());
        assert!(moment.payload.get("settlementReference").is_some());
        let wire = moment.payload.to_string();
        for private in [r#""named""#, "grantId", "userId", "principalId"] {
            assert!(!wire.contains(private), "{private} in {wire}");
        }

        let (_scratch, path, mut receiver) = receiver_with_blobs(&f);
        for (kind, applied) in import_all(&mut receiver, &ops) {
            assert!(applied, "{kind}");
        }
        // The peer retains the evidence, which adds no credit.
        assert_eq!(count(&receiver, "live_audit_events"), 3);
        assert_eq!(count(&receiver, "live_audit_settlements"), 1);
        assert_eq!(moment_authors(&receiver, &moment_id), None);
        // A replayed pull changes nothing.
        import_all(&mut receiver, &ops);
        assert_eq!(moment_authors(&receiver, &moment_id), None);
        drop(receiver);
        let receiver = EngineStore::open(&path, 400).unwrap();
        assert_eq!(moment_authors(&receiver, &moment_id), None);
        assert_eq!(count(&receiver, "live_audit_events"), 3);
        // Publication leaves raw History unchanged.
        assert_eq!(moment_authors(&f.store, &moment_id), Some(host));

        if !native_settlements {
            // A settlement that claims another interval is still refused.
            let forged: Vec<_> = ops
                .iter()
                .map(|op| {
                    let mut op = op.clone();
                    if op.op_kind == settlement_record::SETTLEMENT_OP {
                        op.payload["record"]["previousCursor"] = json!(1);
                    }
                    op
                })
                .collect();
            let (_scratch, _path, mut receiver) = receiver_with_blobs(&f);
            let applied = import_all(&mut receiver, &forged);
            assert!(
                applied
                    .iter()
                    .any(|(kind, applied)| kind == settlement_record::SETTLEMENT_OP && !applied)
            );
            assert_eq!(moment_authors(&receiver, &moment_id), None);
        }
    }
}

#[test]
fn owner_settlement_lookup_accepts_both_binding_key_orders() {
    for canonical in [false, true] {
        let mut f = fixture(false);
        let owner = dohc_engine_collab::owner_outbox::draft::OwnerDraftDescriptor {
            binding: f.binding.clone(),
            relay_database_namespace: "relay".into(),
            revision: 1,
            accepted_cursor: 3,
            native_head_sequence: 0,
            native_unsettled: false,
            outbox_id: None,
            pending_bytes: 0,
            state: None,
        };
        let binding_json = if canonical {
            serde_json::to_string(&serde_json::to_value(&f.binding).unwrap()).unwrap()
        } else {
            serde_json::to_string(&f.binding).unwrap()
        };
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute("INSERT INTO blobs(sha256,text,byte_length) VALUES ('markdown','text',4)", []).map_err(SyncError::persist)?;
                for cursor in [3, 2] {
                    let record = format!(
                        "{{\"binding\":{binding_json},\"momentId\":\"moment\",\"terminalCursor\":{cursor},\"relayDatabaseNamespace\":\"relay\"}}"
                    );
                    tx.execute(
                        "INSERT INTO live_audit_settlements(settlement_id,workspace_id,record_digest,record_json,markdown_digest) VALUES (?1,'ws','digest',?2,'markdown')",
                        params![format!("settlement-{cursor}"), record],
                    ).map_err(SyncError::persist)?;
                }
                Ok::<_, SyncError>(())
            })
            .unwrap();
        let found = f
            .store
            .read_with(|conn| owner_settlement_cursor_in(conn, &owner, "moment", "markdown"))
            .unwrap();
        assert_eq!(found, Some(2), "canonical binding order: {canonical}");
        for field in [
            "workspace",
            "version",
            "object",
            "lineage",
            "path",
            "selectors",
            "fence",
            "namespace",
        ] {
            let mut different = owner.clone();
            match field {
                "workspace" => different.binding.workspace_id = "other".into(),
                "version" => different.binding.main_version_id = "other".into(),
                "object" => different.binding.object_id = "other".into(),
                "lineage" => different.binding.lineage_claim_id = "other".into(),
                "path" => different.binding.current_path = "other.md".into(),
                "selectors" => different.binding.selector_paths = vec!["other.md".into()],
                "fence" => different.binding.restore_fence_generation = 1,
                "namespace" => different.relay_database_namespace = "other".into(),
                _ => unreachable!(),
            }
            let found = f
                .store
                .read_with(|conn| {
                    owner_settlement_cursor_in(conn, &different, "moment", "markdown")
                })
                .unwrap();
            assert_eq!(
                found, None,
                "a different {field} must not authorize publication"
            );
        }
    }
}

#[test]
fn first_bootstrap_settlement_publishes_admitted_baseline_then_chains() {
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    let baseline = f.input.projected_markdown_digest.clone();
    let baseline_bytes = f.input.projected_markdown_byte_length;
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&f.bytes).unwrap();
    let first_text = "Accepted first edit.";
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, first_text)
        .unwrap();
    f.bytes = doc.encode_full_state();
    accept_enrollment_event(&mut f, 1);
    VersionedTextStore::new(&mut f.store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: "note.md".into(),
                text: first_text.into(),
                moment_id: "private-pre-live-head".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 250,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    settle_bootstrap_publication(&mut f, 1, "first-settlement").unwrap();
    let first = operations(&f.store)
        .into_iter()
        .find(|op| op.op_kind == "moment.append" && op.payload["momentId"] == "first-settlement")
        .unwrap();
    assert_eq!(first.payload["payloadBeforeBlobSha256"], baseline);
    assert_eq!(first.payload["payloadBeforeByteLength"], baseline_bytes);
    assert_eq!(first.payload["payloadBeforePath"], "note.md");
    assert_eq!(first.payload["payloadBeforeContentKind"], "text");
    assert_eq!(first.payload["beforeBlobSha256"], baseline);
    assert_eq!(first.payload["beforeByteLength"], baseline_bytes);
    assert_eq!(first.payload["beforeLatestMomentId"], "bootstrap-moment");
    assert_eq!(first.payload["beforePresent"], "present");
    assert_eq!(first.payload["beforeObjectId"], "object");
    assert_eq!(first.payload["beforeVersionId"], "main");
    assert_eq!(
        first.payload["settlementReference"]["record"]["previousCursor"],
        0
    );
    assert_eq!(
        first.payload["payloadAfterBlobSha256"],
        hex_sha256(first_text.as_bytes())
    );
    let local_before: (String, String) = f.store.read_with(|conn| {
        conn.query_row("SELECT payload_before_blob_sha256,before_latest_moment_id FROM moments WHERE workspace_id='ws' AND moment_id='first-settlement'", [], |r| Ok((r.get(0)?, r.get(1)?))).map_err(SyncError::corrupt)
    }).unwrap();
    assert_eq!(
        local_before,
        (
            hex_sha256(first_text.as_bytes()),
            "private-pre-live-head".into()
        )
    );
    assert_ne!(local_before.0, baseline);
    let second_text = "Accepted second edit.";
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, second_text)
        .unwrap();
    f.bytes = doc.encode_full_state();
    accept_enrollment_event(&mut f, 2);
    settle_bootstrap_publication(&mut f, 2, "second-settlement").unwrap();
    let second = operations(&f.store)
        .into_iter()
        .find(|op| op.op_kind == "moment.append" && op.payload["momentId"] == "second-settlement")
        .unwrap();
    assert_eq!(
        second.payload["payloadBeforeBlobSha256"],
        first.payload["payloadAfterBlobSha256"]
    );
    assert_eq!(
        second.payload["payloadBeforeByteLength"],
        first.payload["payloadAfterByteLength"]
    );
    assert_eq!(second.payload["beforeLatestMomentId"], "first-settlement");
    assert_eq!(
        second.payload["settlementReference"]["record"]["previousCursor"],
        1
    );
    assert_eq!(
        second.payload["payloadAfterBlobSha256"],
        hex_sha256(second_text.as_bytes())
    );
}

#[test]
fn first_bootstrap_settlement_rejects_another_objects_baseline() {
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    accept_enrollment_event(&mut f, 1);
    let foreign = VersionedTextStore::new(&mut f.store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "other-object".into(),
                path: "other.md".into(),
                text: "A different document".into(),
                moment_id: "other-baseline".into(),
                metadata_origin: "sync".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 100,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    f.store.write_with(&NoFaults, |tx| {
        tx.execute(
            "UPDATE live_device_bootstraps SET bootstrap_moment_id='other-baseline',projected_markdown_digest=?1,projected_markdown_byte_length=?2 WHERE workspace_id='ws'",
            params![foreign.snapshot.blob_sha256, foreign.snapshot.text.len() as i64],
        ).map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    }).unwrap();
    assert!(settle_bootstrap_publication(&mut f, 1, "invalid-baseline-settlement").is_err());
    assert_eq!(count(&f.store, "live_audit_settlement_publications"), 0);
    assert_eq!(count(&f.store, "live_device_settlements"), 0);
    assert_eq!(count(&f.store, "live_settlement_publication_states"), 0);
    assert!(
        !operations(&f.store)
            .iter()
            .any(|op| op.payload["momentId"] == "invalid-baseline-settlement")
    );
}

fn settle_bootstrap_publication(
    f: &mut Fixture,
    cursor: i64,
    moment: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    use dohc_engine_collab::live_update_application::{
        LiveUpdateReceipt, NativeHistoryReconstruction, with_settlement,
    };
    let delivery: String = f.store.read_with(|conn| {
        conn.query_row("SELECT delivery_id FROM live_device_update_applications WHERE workspace_id='ws' AND journal_cursor=?1", [cursor], |r| r.get(0)).map_err(SyncError::corrupt)
    })?;
    let receipt = LiveUpdateReceipt {
        delivery_id: delivery,
        update_digest: hex_sha256(&f.bytes),
        journal_cursor: cursor,
        accepting_host_epoch: 1,
    };
    with_settlement::<Box<dyn std::error::Error>, _>(
        &mut f.store,
        &f.handle,
        Some(receipt),
        8,
        NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
        },
        |store, audit| {
            let b = audit.binding();
            let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
            let doc =
                store.read_with(|conn| dohc_engine_collab::durable::load_doc_in(conn, &key))?;
            let projected = doc.project(ContentKind::Richdoc)?.content;
            let content = doc
                .preserved_markdown_source(&projected)
                .unwrap_or(projected);
            store.write_with(&NoFaults, |tx| -> Result<(), Box<dyn std::error::Error>> {
                let written = dohc_engine_domain::write_projected_text_in_tx(
                    tx,
                    dohc_engine_domain::ProjectedWriteText {
                        workspace_id: &b.workspace_id,
                        version_id: &b.main_version_id,
                        object_id: &b.object_id,
                        path: std::borrow::Cow::Borrowed(&b.current_path),
                        text: std::borrow::Cow::Borrowed(&content),
                        moment_id: moment,
                        metadata_origin: "ydoc",
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 300 + cursor,
                        request_id: None,
                    },
                )?;
                tx.execute(
                    "UPDATE ydoc_docs SET last_settled_sha=?4 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    params![b.workspace_id,b.main_version_id,b.object_id,written.snapshot.blob_sha256],
                )?;
                let id = audit.record_in_tx(
                    tx,
                    moment,
                    &written.snapshot.blob_sha256,
                    &hex_sha256(&doc.encode_state_vector()),
                    300 + cursor,
                )?;
                audit.record_publication_state_in_tx(tx, &id, &doc.encode_full_state())?;
                assert!(journal_live_settlement_in_tx(tx, "ws", &id, 300 + cursor)?.is_some());
                Ok(())
            })?;
            Ok(())
        },
    )
}

#[test]
fn first_imported_activation_settlement_starts_at_native_event_zero() {
    imported_activation_publication(false, false);
}

#[test]
fn first_imported_activation_settlement_rejects_another_objects_baseline() {
    imported_activation_publication(true, false);
}

#[test]
fn imported_activation_publication_admits_the_preserved_event_zero_source() {
    imported_activation_publication(false, true);
}

fn imported_activation_publication(foreign_baseline: bool, preserve_baseline: bool) {
    use dohc_engine_collab::live_update_application::{
        OwnerAdoptionCut, adopt_owner_committed, capture_imported_owner_activation,
    };
    let mut source =
        fixture_with_markdown(true, preserve_baseline.then_some("Original source.\n\n"));
    bootstrap_committed::<Box<dyn std::error::Error>>(
        &mut source.store,
        &mut WriterDocCache::new(),
        &source.handle,
        source.input.clone(),
        source.bytes.clone(),
        &NoFaults,
        |tx, _, namespace, binding| {
            crate::journal_moment_append_in_tx(tx, "ws", "bootstrap-moment")?;
            journal_live_base_in_tx(tx, namespace, binding, 100)?;
            Ok(())
        },
    )
    .unwrap();
    let baseline = source.input.projected_markdown_digest.clone();
    let baseline_bytes = source.bytes.clone();
    let key = DocKey::new("ws", "main", "object").unwrap();
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&baseline_bytes).unwrap();
    if preserve_baseline {
        assert_ne!(
            hex_sha256(
                doc.project(ContentKind::Richdoc)
                    .unwrap()
                    .content
                    .as_bytes()
            ),
            baseline
        );
        assert_eq!(
            hex_sha256(
                doc.preserved_markdown_source(&doc.project(ContentKind::Richdoc).unwrap().content)
                    .unwrap()
                    .as_bytes()
            ),
            baseline
        );
    }
    doc.rewrite_content_to_markdown_preserving_source(
        ContentKind::Richdoc,
        "Pre-live ordinary edits.",
    )
    .unwrap();
    let full = doc.encode_full_state();
    source
        .store
        .write_with(&NoFaults, |tx| {
            let digest = put_binary_blob(tx, &full)?;
            journal_local_op_in_tx(
                tx,
                "ws",
                "ydoc.update",
                &crate::ydoc_update_payload(
                    &key,
                    "note.md",
                    ContentKind::Richdoc,
                    &digest,
                    &source.binding.lineage_claim_id,
                    Some("owner-origin"),
                    None,
                    false,
                ),
                200,
            )?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let ops = operations(&source.store);
    let baseline_relay_sequence = ops
        .iter()
        .find(|op| op.payload["momentId"] == "bootstrap-moment")
        .unwrap()
        .origin_seq
        + 1;
    let (scratch, path, mut store) = open_store();
    let (binary, text) = source
        .store
        .read_with(|conn| {
            let binary: Vec<Vec<u8>> = conn
                .prepare("SELECT bytes FROM binary_blobs")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            let text: Vec<(String, i64, String)> = conn
                .prepare("SELECT sha256,byte_length,text FROM blobs")
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            Ok::<_, SyncError>((binary, text))
        })
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            for bytes in &binary {
                put_binary_blob(tx, bytes)?;
            }
            for (digest, length, body) in &text {
                tx.execute(
                    "INSERT INTO blobs(sha256,byte_length,text) VALUES (?1,?2,?3)",
                    params![digest, length, body],
                )
                .map_err(SyncError::persist)?;
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
    crate::adopt_join_identity(
        &mut store,
        "ws",
        "service-origin",
        "epoch",
        "stream",
        250,
        &NoFaults,
    )
    .unwrap();
    for mut op in ops.clone() {
        op.relay_seq = Some(op.origin_seq + 1);
        let applied = crate::apply_replication_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(
            matches!(applied.primary, ApplyDisposition::Applied(_)),
            "{}: {:?}",
            op.op_kind,
            applied.primary
        );
    }
    crate::commit_relay_cursor(
        &mut store,
        "ws",
        &RelayCursor {
            bootstrap_complete: true,
            cursor: ops.last().unwrap().origin_seq + 1,
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            settlement_report_id: None,
        },
        &NoFaults,
        &NoLiveLeases,
        250,
    )
    .unwrap();
    let activation = capture_imported_owner_activation(
        &mut store, "relay", &key, "note.md", 1_000_000, &NoFaults,
    )
    .unwrap();
    assert_ne!(activation.source.source_digest, baseline);
    let mut owner = ApplicationOwner::new("ws".into()).unwrap();
    let handle = owner
        .register(
            &mut store,
            "relay".into(),
            ApplicationHostCoordinate {
                host_id: "service-host".into(),
                host_epoch: 1,
                instance_id: "self-host-service".into(),
                connection_id: "connection".into(),
            },
            source.binding.clone(),
        )
        .unwrap();
    let cut = OwnerAdoptionCut {
        relay_database_namespace: "relay".into(),
        adoption_id: activation.activation_id,
        source_moment_id: activation.source.source_moment_id,
        source_digest: activation.source.source_digest.clone(),
        source_byte_length: activation.source.source_byte_length,
        baseline_moment_relay_sequence: baseline_relay_sequence,
        baseline_registered_at_ms: 100,
        baseline_bytes,
        expected_local_sequence: activation.source.native_head_sequence,
        events: vec![],
        terminal_receipt: None,
        outbox_limits: dohc_engine_collab::OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 100_000,
        },
    };
    adopt_owner_committed(
        &mut store,
        &handle,
        cut,
        1_000_000,
        10,
        260,
        &NoFaults,
        |tx, namespace, binding, _| {
            journal_live_base_in_tx(tx, namespace, binding, 260)
                .map(|_| ())
                .map_err(|e| {
                    dohc_engine_collab::live_update_application::ApplicationError::Storage(
                        dohc_engine_storage::StorageError::persist_public(e),
                    )
                })
        },
    )
    .unwrap();
    let (delivery, bytes): (String, Vec<u8>) = store.read_with(|conn| {
        conn.query_row("SELECT e.delivery_id,b.bytes FROM owner_ydoc_outbox_entries e JOIN binary_blobs b ON b.sha256=e.update_blob_digest WHERE e.pending=1 ORDER BY e.sequence LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?))).map_err(SyncError::corrupt)
    }).unwrap();
    let mut f = Fixture {
        path,
        store,
        _owner: owner,
        handle,
        binding: source.binding.clone(),
        input: source.input.clone(),
        bytes,
        _scratch: scratch,
    };
    accept_named_event(&mut f, 1, delivery);
    if foreign_baseline {
        VersionedTextStore::new(&mut f.store)
            .write_text(
                &dohc_engine_domain::WriteText {
                    workspace_id: "ws".into(),
                    version_id: "main".into(),
                    object_id: "foreign-object".into(),
                    path: "foreign.md".into(),
                    text: "".into(),
                    moment_id: "foreign-baseline".into(),
                    metadata_origin: "sync".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 100,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        f.store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE moments SET object_id='foreign-object',path='foreign.md'
                 WHERE workspace_id='ws' AND version_id='main' AND object_id='object'
                   AND after_blob_sha256=?1",
                    [&baseline],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .unwrap();
        assert!(settle_bootstrap_publication(&mut f, 1, "service-first-settlement").is_err());
        assert_eq!(count(&f.store, "live_audit_settlement_publications"), 0);
        assert_eq!(count(&f.store, "live_device_settlements"), 0);
        assert_eq!(count(&f.store, "live_settlement_publication_states"), 0);
        assert!(
            !crate::list_replication_ops(&f.store, "ws", "service-origin", -1, 500)
                .unwrap()
                .iter()
                .any(|op| op.payload["momentId"] == "service-first-settlement")
        );
        return;
    }
    settle_bootstrap_publication(&mut f, 1, "service-first-settlement").unwrap();
    let first = crate::list_replication_ops(&f.store, "ws", "service-origin", -1, 500)
        .unwrap()
        .into_iter()
        .find(|op| {
            op.op_kind == "moment.append" && op.payload["momentId"] == "service-first-settlement"
        })
        .unwrap();
    assert_eq!(first.payload["payloadBeforeBlobSha256"], baseline);
    assert_eq!(first.payload["beforeBlobSha256"], baseline);
    assert_eq!(
        first.payload["payloadBeforeByteLength"],
        source.input.projected_markdown_byte_length
    );
    assert_eq!(
        first.payload["payloadAfterBlobSha256"],
        activation.source.source_digest
    );
    let local_before: String = f.store.read_with(|conn| conn.query_row("SELECT payload_before_blob_sha256 FROM moments WHERE workspace_id='ws' AND moment_id='service-first-settlement'", [], |r| r.get(0)).map_err(SyncError::corrupt)).unwrap();
    assert_eq!(local_before, activation.source.source_digest);
    if preserve_baseline {
        let queued =
            crate::list_replication_ops(&f.store, "ws", "service-origin", -1, 500).unwrap();
        let prefix = crate::owner_publication_prefix(&f.store, "ws", &queued, 1_000_000).unwrap();
        assert_eq!(
            prefix.allowed_ops,
            queued.len(),
            "preserved baseline must pass the same prefix that selects uploadable blobs: {prefix:?}"
        );
        assert!(prefix.pending.is_none());
        let mut private = first.clone();
        private.payload["payloadBeforeBlobSha256"] = json!(hex_sha256(b"Unaccepted private file."));
        assert_eq!(
            crate::owner_publication_prefix(&f.store, "ws", &[private], 1_000_000)
                .unwrap()
                .allowed_ops,
            0
        );
        let mut foreign_path = first.clone();
        foreign_path.payload["payloadBeforePath"] = json!("foreign.md");
        assert_eq!(
            crate::owner_publication_prefix(&f.store, "ws", &[foreign_path], 1_000_000)
                .unwrap()
                .allowed_ops,
            0
        );
        assert!(
            crate::owner_publication_prefix(&f.store, "ws", std::slice::from_ref(&first), 0)
                .is_err()
        );
    }
    let next = dohc_engine_collab::Ydoc::wire();
    next.apply(&f.bytes).unwrap();
    next.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "Next accepted edit.")
        .unwrap();
    f.bytes = next.encode_full_state();
    accept_enrollment_event(&mut f, 2);
    settle_bootstrap_publication(&mut f, 2, "service-second-settlement").unwrap();
    let second = crate::list_replication_ops(&f.store, "ws", "service-origin", -1, 500)
        .unwrap()
        .into_iter()
        .find(|op| {
            op.op_kind == "moment.append" && op.payload["momentId"] == "service-second-settlement"
        })
        .unwrap();
    assert_eq!(
        second.payload["payloadBeforeBlobSha256"],
        first.payload["payloadAfterBlobSha256"]
    );
    assert_eq!(
        second.payload["payloadBeforeByteLength"],
        first.payload["payloadAfterByteLength"]
    );
    assert_eq!(
        second.payload["beforeLatestMomentId"],
        "service-first-settlement"
    );
    assert_eq!(
        second.payload["settlementReference"]["record"]["previousCursor"],
        1
    );
    assert_eq!(
        second.payload["payloadAfterBlobSha256"],
        hex_sha256(b"Next accepted edit.")
    );
}
