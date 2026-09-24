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

struct Fixture {
    _scratch: ScratchDir,
    path: std::path::PathBuf,
    store: EngineStore,
    _owner: ApplicationOwner,
    handle: ApplicationHandle,
    binding: LiveObjectBinding,
    input: LiveApplicationBootstrap,
    bytes: Vec<u8>,
}

fn fixture(replicates: bool) -> Fixture {
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
    let bytes: Vec<u8> = serde_json::from_value(vector["bytes"].clone()).unwrap();
    let markdown = vector["markdown"].as_str().unwrap();
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
            cursor: 0,
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            refusal_report_id: None,
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
    assert_eq!(published.len(), 2);
    assert_eq!(published[0].op_kind, settlement_record::SETTLEMENT_OP);
    assert_eq!(published[1].op_kind, "moment.append");
    assert!(published[0].origin_seq < published[1].origin_seq);
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
    use dohc_engine_collab::live_update_application::{
        AdmittedLiveUpdate, AdmittedLiveUpdateMetadata, ApplicationError, LiveUpdateReceipt,
        RelayAcceptedLiveUpdate, ServerDerivedLiveUpdateAuthority, apply_committed,
    };
    let event = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: LiveUpdateReceipt {
                    delivery_id: format!("enrollment-{cursor}"),
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
        ApplicationResult::Applied(_)
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
