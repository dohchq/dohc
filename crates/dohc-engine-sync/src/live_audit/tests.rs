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
        },
        &NoFaults,
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
    payload.record.origin_stamp = "f".repeat(64);
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
