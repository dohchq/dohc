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
mod apply_performance;
mod passive;

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
    fixture_with_binding_generation(replicates, source, 0)
}

fn fixture_with_binding_generation(
    replicates: bool,
    source: Option<&str>,
    generation: i64,
) -> Fixture {
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
        restore_fence_generation: generation,
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
            ordinary_pull: None,
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

#[derive(Clone, Copy)]
enum LengthClaim {
    Valid,
    Chunk,
    Update,
}

fn length_claim_pull(
    claim: LengthClaim,
) -> (
    ScratchDir,
    EngineStore,
    crate::RelaySyncClient<crate::tests::FakeRelay>,
    i64,
) {
    use std::io::{Read, Write};
    let mut source = fixture(true);
    bootstrap(&mut source, false).unwrap();
    accept_enrollment_event(&mut source, 1);
    let mut audit = operations(&source.store)
        .into_iter()
        .find(|op| op.op_kind == application_record::EVENT_OP)
        .unwrap();
    let mut manifest: chunks::Manifest =
        serde_json::from_value(audit.payload["manifest"].clone()).unwrap();
    match claim {
        LengthClaim::Valid => {}
        LengthClaim::Chunk => {
            manifest.byte_length -= 1;
            manifest.chunks[0].byte_length -= 1;
        }
        LengthClaim::Update => {
            manifest = source
                .store
                .read_with(|conn| {
                    let mut reader = chunks::ChunkReader::new(conn, &manifest).unwrap();
                    let mut text = String::new();
                    reader.read_to_string(&mut text).unwrap();
                    reader.finish().unwrap();
                    let original = format!("\"updateByteLength\":{}", source.bytes.len());
                    assert!(text.contains(&original));
                    let changed = text.replace(
                        &original,
                        &format!("\"updateByteLength\":{}", source.bytes.len() + 1),
                    );
                    let mut writer = chunks::ChunkWriter::new(conn);
                    writer.write_all(changed.as_bytes()).unwrap();
                    writer.finish()
                })
                .unwrap();
        }
    }
    audit.payload["manifest"] = serde_json::to_value(manifest).unwrap();
    source.store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE replication_log SET payload_json=?1 WHERE workspace_id='ws' AND origin_id='owner-origin' AND origin_seq=?2",
            params![audit.payload.to_string(), audit.origin_seq]).map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    }).unwrap();
    crate::journal_local_replication_op(&mut source.store, "ws", "owner-origin", "epoch", "stream",
        "chat.channel.create", &json!({"channelId":"after-audit","name":"Later","slug":"later","kind":"channel","createdAtMs":300}), 300, &NoFaults).unwrap();
    let writer = crate::RelaySyncClient::new(crate::tests::FakeRelay::default());
    writer
        .claim_workspace(
            &mut source.store,
            crate::ClaimRequest {
                workspace_id: "ws".into(),
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
            },
            None,
            &NoFaults,
        )
        .unwrap();
    writer
        .push_workspace(
            &mut source.store,
            "ws",
            &NoFaults,
            &NoLiveLeases,
            301,
            100_000_000,
        )
        .unwrap();
    let pushed: Vec<_> = writer
        .transport()
        .pushed_requests()
        .into_iter()
        .flat_map(|req| req.ops)
        .collect();
    assert!(pushed.iter().any(|op| op == &audit));
    let (scratch, _path, mut receiver) = open_store();
    crate::journal_local_replication_op(
        &mut receiver,
        "ws",
        "recipient",
        "epoch",
        "stream",
        "workspace.init",
        &json!({}),
        0,
        &NoFaults,
    )
    .unwrap();
    contact(&mut receiver);
    let blobs: Vec<Vec<u8>> = source
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
    let mut pending = Vec::new();
    for mut op in pushed {
        op.relay_seq = Some(op.origin_seq + 1);
        if op.origin_seq < audit.origin_seq {
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
                "{op:?}: {result:?}"
            );
        } else {
            pending.push(op);
        }
    }
    let final_seq = pending.last().unwrap().origin_seq;
    let relay = crate::tests::FakeRelay::default();
    *relay.pull.lock().unwrap() = Some(crate::PullResponse {
        ops: pending,
        next_cursor: final_seq + 1,
        has_more: false,
    });
    (
        scratch,
        receiver,
        crate::RelaySyncClient::new(relay),
        final_seq,
    )
}

fn assert_length_claim_refused(claim: LengthClaim) {
    let (_scratch, mut receiver, client, final_seq) = length_claim_pull(claim);
    let result = client
        .pull_chat_workspace(
            &mut receiver,
            &mut WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            302,
        )
        .unwrap();
    let crate::SyncPassOutcome::Complete {
        applied,
        refused,
        refusals,
        pending_cursor: Some(cursor),
        ..
    } = result
    else {
        panic!("{result:?}");
    };
    assert_eq!((applied, refused), (1, 1));
    assert_eq!(refusals.len(), 1);
    assert_eq!(refusals[0].reason.code(), "invalid-input");
    assert_eq!(count(&receiver, "live_audit_events"), 0);
    assert_eq!(
        crate::read_replication_acked_seq(&receiver, "ws", "owner-origin").unwrap(),
        final_seq
    );
    receiver.read_with(|conn| {
        assert_eq!(conn.query_row("SELECT name FROM chat_channels WHERE workspace_id='ws' AND channel_id='after-audit'", [], |r| r.get::<_, String>(0)).unwrap(), "Later");
        assert_eq!(conn.query_row("SELECT apply_disposition FROM replication_log WHERE workspace_id='ws' AND origin_id='owner-origin' AND origin_seq=?1", [final_seq - 1], |r| r.get::<_, String>(0)).unwrap(), "refused");
        Ok::<_, SyncError>(())
    }).unwrap();
    client
        .commit_pull_cursor(&mut receiver, "ws", &cursor, &NoFaults, &NoLiveLeases, 303)
        .unwrap();
}

#[test]
fn relay_pull_live_audit_wrong_chunk_length_refuses_and_applies_later_op() {
    assert_length_claim_refused(LengthClaim::Chunk);
}

#[test]
fn relay_pull_live_audit_wrong_update_length_refuses_and_applies_later_op() {
    assert_length_claim_refused(LengthClaim::Update);
}

#[test]
fn relay_pull_live_audit_missing_chunk_retries_without_ack() {
    let (_scratch, mut receiver, client, final_seq) = length_claim_pull(LengthClaim::Valid);
    let audit = client
        .transport()
        .pull
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .ops[0]
        .clone();
    let sha = audit.payload["manifest"]["chunks"][0]["sha256"]
        .as_str()
        .unwrap();
    let bytes = receiver.get_binary_blob(sha).unwrap().unwrap();
    receiver
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM binary_blobs WHERE sha256=?1", [sha])
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    for _ in 0..2 {
        assert!(matches!(
            client.pull_chat_workspace(
                &mut receiver,
                &mut WriterDocCache::new(),
                "ws",
                &NoFaults,
                &NoLiveLeases,
                302
            ),
            Err(crate::RelayError::BlobMissing)
        ));
        assert_eq!(
            crate::read_replication_acked_seq(&receiver, "ws", "owner-origin").unwrap(),
            audit.origin_seq - 1
        );
    }
    receiver.put_binary_blob(&bytes).unwrap();
    let result = client
        .pull_chat_workspace(
            &mut receiver,
            &mut WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            303,
        )
        .unwrap();
    assert!(matches!(
        result,
        crate::SyncPassOutcome::Complete {
            applied: 2,
            refused: 0,
            ..
        }
    ));
    assert_eq!(
        crate::read_replication_acked_seq(&receiver, "ws", "owner-origin").unwrap(),
        final_seq
    );
}

fn assert_corrupt_length_is_storage(update: bool) {
    let (_scratch, mut receiver, client, _) = length_claim_pull(LengthClaim::Valid);
    let audit = client
        .transport()
        .pull
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .ops[0]
        .clone();
    let sha = if update {
        audit.payload["updateBlobSha256"].as_str().unwrap()
    } else {
        audit.payload["manifest"]["chunks"][0]["sha256"]
            .as_str()
            .unwrap()
    };
    receiver
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE binary_blobs SET byte_length=byte_length+1 WHERE sha256=?1",
                [sha],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let error = apply_audit_envelope(&mut receiver, &audit, &NoFaults).unwrap_err();
    assert!(
        matches!(&error, SyncError::Storage(dohc_engine_storage::StorageError::BlobIntegrity { sha256 }) if sha256 == sha),
        "{error:?}"
    );
    assert_eq!(
        crate::read_replication_acked_seq(&receiver, "ws", "owner-origin").unwrap(),
        audit.origin_seq - 1
    );
    assert_eq!(count(&receiver, "live_audit_events"), 0);
}

#[test]
fn audit_apply_live_audit_corrupt_chunk_length_is_storage() {
    assert_corrupt_length_is_storage(false);
}

#[test]
fn audit_apply_live_audit_corrupt_update_length_is_storage() {
    assert_corrupt_length_is_storage(true);
}

#[test]
fn audit_apply_live_audit_missing_chunk_retries_without_ack() {
    let (_scratch, mut receiver, client, _) = length_claim_pull(LengthClaim::Valid);
    let audit = client
        .transport()
        .pull
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .ops[0]
        .clone();
    let sha = audit.payload["manifest"]["chunks"][0]["sha256"]
        .as_str()
        .unwrap();
    let bytes = receiver.get_binary_blob(sha).unwrap().unwrap();
    receiver
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM binary_blobs WHERE sha256=?1", [sha])
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    for _ in 0..2 {
        assert!(matches!(
            apply_audit_envelope(&mut receiver, &audit, &NoFaults),
            Err(SyncError::BlobInvalid)
        ));
        assert_eq!(
            crate::read_replication_acked_seq(&receiver, "ws", "owner-origin").unwrap(),
            audit.origin_seq - 1
        );
        assert_eq!(count(&receiver, "live_audit_events"), 0);
        assert_eq!(count(&receiver, "replication_pending_refusals"), 0);
    }
    receiver.put_binary_blob(&bytes).unwrap();
    let result = apply_audit_envelope(&mut receiver, &audit, &NoFaults).unwrap();
    assert!(matches!(result.primary, ApplyDisposition::Applied(_)));
    assert_eq!(
        crate::read_replication_acked_seq(&receiver, "ws", "owner-origin").unwrap(),
        audit.origin_seq
    );
}

fn assert_checksum_precedes_length_refusal(claim: LengthClaim) {
    let (_scratch, mut receiver, client, _) = length_claim_pull(claim);
    let audit = client
        .transport()
        .pull
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .ops[0]
        .clone();
    let sha = if matches!(claim, LengthClaim::Update) {
        audit.payload["updateBlobSha256"].as_str().unwrap()
    } else {
        audit.payload["manifest"]["chunks"][0]["sha256"]
            .as_str()
            .unwrap()
    };
    let original = receiver.get_binary_blob(sha).unwrap().unwrap();
    let mut damaged = original.clone();
    damaged[0] ^= 1;
    receiver
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE binary_blobs SET bytes=?1 WHERE sha256=?2",
                params![damaged, sha],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let error = apply_audit_envelope(&mut receiver, &audit, &NoFaults).unwrap_err();
    assert!(
        matches!(&error, SyncError::Storage(dohc_engine_storage::StorageError::BlobIntegrity { sha256 }) if sha256 == sha),
        "{error:?}"
    );
    assert_eq!(
        crate::read_replication_acked_seq(&receiver, "ws", "owner-origin").unwrap(),
        audit.origin_seq - 1
    );
    assert_eq!(count(&receiver, "live_audit_events"), 0);
    assert_eq!(count(&receiver, "replication_pending_refusals"), 0);
    receiver
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE binary_blobs SET bytes=?1 WHERE sha256=?2",
                params![original, sha],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let result = apply_audit_envelope(&mut receiver, &audit, &NoFaults).unwrap();
    assert!(matches!(result.primary, ApplyDisposition::Refused(_)));
    assert_eq!(
        crate::read_replication_acked_seq(&receiver, "ws", "owner-origin").unwrap(),
        audit.origin_seq
    );
}

#[test]
fn audit_apply_live_audit_checksum_precedes_wrong_chunk_length_refusal() {
    assert_checksum_precedes_length_refusal(LengthClaim::Chunk);
}

#[test]
fn audit_apply_live_audit_checksum_precedes_wrong_update_length_refusal() {
    assert_checksum_precedes_length_refusal(LengthClaim::Update);
}

#[test]
#[ignore = "manual valid live audit import measurement"]
fn relay_pull_live_audit_valid_import_measurement() {
    for sample in 0..21 {
        let (_scratch, mut receiver, client, _) = length_claim_pull(LengthClaim::Valid);
        let started = std::time::Instant::now();
        let result = client
            .pull_chat_workspace(
                &mut receiver,
                &mut WriterDocCache::new(),
                "ws",
                &NoFaults,
                &NoLiveLeases,
                302,
            )
            .unwrap();
        let micros = started.elapsed().as_micros();
        assert!(matches!(
            result,
            crate::SyncPassOutcome::Complete {
                applied: 2,
                refused: 0,
                ..
            }
        ));
        if sample > 0 {
            println!("AUDITSTALL valid_import sample={sample} micros={micros}");
        }
    }
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
    enrollment::prepare_exports(
        &mut f.store,
        "ws",
        &NoFaults,
        &crate::NoLiveLeases,
        301,
        &mut false,
    )
    .unwrap();
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
    enrollment::prepare_exports(
        &mut f.store,
        "ws",
        &NoFaults,
        &crate::NoLiveLeases,
        303,
        &mut false,
    )
    .unwrap();
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
            201,
            &mut false
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
            202,
            &mut false
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
    enrollment::prepare_exports(
        &mut f.store,
        "ws",
        &NoFaults,
        &crate::NoLiveLeases,
        204,
        &mut false,
    )
    .unwrap();
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
    enrollment::prepare_exports(
        &mut f.store,
        "ws",
        &NoFaults,
        &crate::NoLiveLeases,
        205,
        &mut false,
    )
    .unwrap();
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
    enrollment::prepare_exports(
        &mut f.store,
        "ws",
        &NoFaults,
        &crate::NoLiveLeases,
        201,
        &mut false,
    )
    .unwrap();
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
fn a_late_coordinate_audit_preserves_a_local_authorless_edit() {
    import_authored_projection_with_local_gap(false, false, None, false, true, false);
}

#[test]
fn an_audited_drain_preserves_a_local_authorless_edit() {
    import_authored_projection_with_local_gap(true, false, None, false, true, false);
}

#[test]
fn an_audited_drain_with_a_known_author_fits_a_full_author_interval() {
    import_authored_projection_with_local_gap(true, false, None, false, false, true);
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
    DeclaredHuman,
    UnconfirmedHumanAudit,
}

fn import_authored_projection(
    deferred: bool,
    mixed: bool,
    first_coordinate: Option<FirstDrainCoordinate>,
    late: bool,
) {
    import_projection(
        deferred,
        mixed,
        first_coordinate,
        late,
        false,
        false,
        Confirmation::None,
    );
}

#[derive(Clone, Copy, PartialEq)]
enum Confirmation {
    None,
    Admitted,
    Mismatch,
    NoReceipt,
    ForgedMarker,
    RetentionBound,
    StorageFailure,
    ReaderStorageFailure,
}

#[test]
fn relay_confirmed_audit_keeps_an_independent_local_marker() {
    import_projection(
        true,
        false,
        None,
        false,
        true,
        false,
        Confirmation::Admitted,
    );
}

#[test]
fn confirmed_audited_drain_at_capacity_cannot_attest_prior_credit() {
    import_projection(
        true,
        false,
        None,
        false,
        false,
        true,
        Confirmation::Admitted,
    );
}

#[test]
fn relay_confirmed_audit_authors_reach_import_and_origin_echo() {
    import_confirmed_projection(false, false, None, false, Confirmation::Admitted);
}

#[test]
fn relay_confirmed_audit_authors_survive_deferred_projection_and_reopen() {
    import_confirmed_projection(true, false, None, false, Confirmation::Admitted);
}

#[test]
fn relay_confirmed_audit_preserves_other_checkpoint_authors() {
    import_confirmed_projection(false, true, None, false, Confirmation::Admitted);
}

#[test]
fn forged_audit_snapshot_or_missing_relay_receipt_cannot_confirm_a_person() {
    import_confirmed_projection(false, false, None, false, Confirmation::Mismatch);
    import_confirmed_projection(false, false, None, false, Confirmation::NoReceipt);
    import_confirmed_projection(false, false, None, false, Confirmation::ForgedMarker);
}

#[test]
fn confirmed_audit_cannot_attest_a_declared_same_person_in_a_drain() {
    for late in [false, true] {
        import_confirmed_projection(
            true,
            false,
            Some(FirstDrainCoordinate::DeclaredHuman),
            late,
            Confirmation::Admitted,
        );
    }
}

fn import_authored_projection_with_local_gap(
    deferred: bool,
    mixed: bool,
    first_coordinate: Option<FirstDrainCoordinate>,
    late: bool,
    local_gap: bool,
    at_capacity: bool,
) {
    import_projection(
        deferred,
        mixed,
        first_coordinate,
        late,
        local_gap,
        at_capacity,
        Confirmation::None,
    );
}

fn import_confirmed_projection(
    deferred: bool,
    mixed: bool,
    first_coordinate: Option<FirstDrainCoordinate>,
    late: bool,
    confirmation: Confirmation,
) {
    import_projection(
        deferred,
        mixed,
        first_coordinate,
        late,
        false,
        false,
        confirmation,
    );
}

fn import_projection(
    deferred: bool,
    mixed: bool,
    first_coordinate: Option<FirstDrainCoordinate>,
    late: bool,
    local_gap: bool,
    at_capacity: bool,
    confirmation: Confirmation,
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
    let mut authors = json!([{"kind":"human","humanId":"recipient","humanName":"Recipient"}]);
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
        first.metadata.author_snapshot = matches!(
            first_coordinate,
            Some(FirstDrainCoordinate::Verified | FirstDrainCoordinate::UnconfirmedHumanAudit)
        )
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
    let mut last_audit = None;
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
        if local_gap && op.op_kind == "ydoc.update" && op.origin_seq == first_delta_seq {
            let key = DocKey::new("ws", "main", "object").unwrap();
            let persisted = dohc_engine_collab::load_persisted(&receiver, &key)
                .unwrap()
                .unwrap();
            let update = persisted
                .doc
                .richdoc_append_paragraph("Local authorless edit.");
            dohc_engine_collab::record_local_update(
                &mut receiver,
                &mut cache,
                &key,
                &update,
                dohc_engine_collab::LocalAppend::default(),
                &NoFaults,
                200,
                |_, _, _| Ok(()),
            )
            .unwrap();
        }
        if op.op_kind == application_record::EVENT_OP
            && confirmation != Confirmation::None
            && (!matches!(
                first_coordinate,
                Some(
                    FirstDrainCoordinate::DeclaredHuman
                        | FirstDrainCoordinate::UnconfirmedHumanAudit
                )
            ) || op.origin_seq == last_audit_seq)
        {
            let mut snapshot = authors.clone();
            if mixed {
                snapshot.as_array_mut().unwrap().push(other.clone());
            }
            if confirmation == Confirmation::Mismatch {
                snapshot[0]["humanId"] = json!("forged");
            }
            if confirmation == Confirmation::ForgedMarker {
                snapshot[0]["relayConfirmed"] = json!(true);
            }
            op.admitted_author_snapshot = Some(snapshot);
            if confirmation == Confirmation::NoReceipt {
                op.relay_seq = None;
            }
        }
        if op.op_kind == application_record::EVENT_OP && op.origin_seq == last_audit_seq {
            last_audit = Some(op.clone());
        }
        if matches!(
            confirmation,
            Confirmation::Admitted
                | Confirmation::RetentionBound
                | Confirmation::StorageFailure
                | Confirmation::ReaderStorageFailure
        ) {
            let bounded = confirmation == Confirmation::RetentionBound
                && op.op_kind == application_record::EVENT_OP;
            let full_coverage = if bounded {
                json!(
                    (0..dohc_engine_collab::author_coverage::MAX_INTERVAL_AUTHORS)
                        .map(|i| json!({"kind":"link","publicPrincipalId":format!("link-{i}")}))
                        .collect::<Vec<_>>()
                )
                .to_string()
            } else {
                String::new()
            };
            if bounded {
                f.store.read_with(|conn| conn.execute(
                    "INSERT INTO live_audit_projection_authors(workspace_id,origin_id,origin_seq,version_id,object_id,path,lineage_claim_id,author_json) VALUES ('ws','owner-origin',?1,'main','object','note.md',?2,?3)",
                    params![op.origin_seq-1,f.binding.lineage_claim_id,full_coverage],
                )).unwrap();
                f.store.read_with(|conn| conn.execute(
                    "INSERT INTO live_audit_projection_contributions(workspace_id,origin_id,origin_seq,record_digest,author_json) VALUES ('ws','owner-origin',?1,'retention-bound',?2)",
                    params![op.origin_seq-1,full_coverage],
                )).unwrap();
            }
            if confirmation == Confirmation::StorageFailure
                && op.op_kind == application_record::EVENT_OP
            {
                f.store.read_with(|conn| conn.execute_batch(
                    "CREATE TEMP TRIGGER fail_audit_confirmation BEFORE INSERT ON live_audit_projection_authors BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;",
                )).unwrap();
                let failed = crate::apply_replication_envelope(
                    &mut f.store,
                    &mut WriterDocCache::new(),
                    &op,
                    &NoFaults,
                    &NoLiveLeases,
                );
                assert!(matches!(failed, Err(SyncError::Storage(_))), "{failed:?}");
                f.store
                    .read_with(|conn| conn.execute_batch("DROP TRIGGER fail_audit_confirmation"))
                    .unwrap();
            }
            if confirmation == Confirmation::ReaderStorageFailure
                && op.op_kind == application_record::EVENT_OP
            {
                f.store
                    .read_with(|conn| {
                        conn.execute_batch("ALTER TABLE binary_blobs RENAME TO unavailable_blobs")
                    })
                    .unwrap();
                let failed = crate::apply_replication_envelope(
                    &mut f.store,
                    &mut WriterDocCache::new(),
                    &op,
                    &NoFaults,
                    &NoLiveLeases,
                );
                assert!(matches!(failed, Err(SyncError::Storage(_))), "{failed:?}");
                f.store
                    .read_with(|conn| {
                        conn.execute_batch("ALTER TABLE unavailable_blobs RENAME TO binary_blobs")
                    })
                    .unwrap();
            }
            let echoed = crate::apply_replication_envelope(
                &mut f.store,
                &mut WriterDocCache::new(),
                &op,
                &NoFaults,
                &NoLiveLeases,
            )
            .unwrap();
            assert!(matches!(echoed.primary, ApplyDisposition::Skipped));
            if bounded {
                let retained: String = f
                    .store
                    .read_with(|conn| {
                        conn.query_row(
                    "SELECT author_json FROM live_audit_projection_authors WHERE origin_seq=?1",
                    [op.origin_seq-1], |row| row.get(0),
                )
                    })
                    .unwrap();
                assert_eq!(
                    retained, full_coverage,
                    "optional proof must roll back on a bound failure"
                );
                f.store
                    .read_with(|conn| {
                        conn.execute(
                            "DELETE FROM live_audit_projection_authors WHERE origin_seq=?1",
                            [op.origin_seq - 1],
                        )
                    })
                    .unwrap();
                f.store
                    .read_with(|conn| {
                        conn.execute(
                            "DELETE FROM live_audit_projection_contributions WHERE origin_seq=?1",
                            [op.origin_seq - 1],
                        )
                    })
                    .unwrap();
            }
            if !bounded
                && op.op_kind == application_record::EVENT_OP
                && op.admitted_author_snapshot.is_some()
            {
                let saved: Option<String> = f
                    .store
                    .read_with(|conn| {
                        conn.query_row(
                            "SELECT author_json FROM live_audit_projection_authors LIMIT 1",
                            [],
                            |r| r.get(0),
                        )
                        .optional()
                    })
                    .unwrap();
                assert!(
                    saved
                        .as_deref()
                        .unwrap_or("")
                        .contains("\"relayConfirmed\":true")
                );
            }
        }
        if matches!(
            first_coordinate,
            Some(FirstDrainCoordinate::Declared | FirstDrainCoordinate::DeclaredHuman)
        ) && op.op_kind == "ydoc.update"
            && op.payload["isBaseState"] != true
            && (op.origin_seq == first_delta_seq || late)
        {
            if first_coordinate == Some(FirstDrainCoordinate::DeclaredHuman) {
                op.payload["actorOriginId"] = json!("recipient");
                op.payload["attribution"] = json!({"actorKind":"human","depth":0});
            } else {
                op.payload["actorOriginId"] = json!("agent-x");
                op.payload["attribution"] = json!({"actorKind":"agent","depth":0});
            }
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
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(
                        moment.author_json.as_deref().unwrap()
                    )
                    .unwrap(),
                    json!([{"kind":"unattributed"}]),
                    "the content coordinate is not yet audited",
                );
                let pending: i64 = receiver.read_with(|conn| conn.query_row(
                    "SELECT COUNT(*) FROM engine_requests WHERE kind='sync-ydoc-provisional-author'",
                    [], |row| row.get(0),
                )).unwrap();
                assert_eq!(pending, i64::from(!local_gap));
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
            i64::from(matches!(
                first_coordinate,
                Some(FirstDrainCoordinate::Verified | FirstDrainCoordinate::UnconfirmedHumanAudit)
            )) + i64::from(!late)
        );
        if at_capacity {
            let entries = std::iter::once(authors[0].clone())
                .chain((1..dohc_engine_collab::author_coverage::MAX_INTERVAL_AUTHORS).map(|index|
                    json!({"kind":"human","humanId":format!("prior-{index}"),"humanName":"Prior author"})))
                .collect::<Vec<_>>();
            receiver.read_with(|conn| conn.execute(
                "UPDATE ydoc_docs SET pending_authors_json=?1 WHERE workspace_id='ws' AND version_id='main' AND object_id='object'",
                [serde_json::to_string(&entries).unwrap()],
            )).unwrap();
        }
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
    if matches!(
        first_coordinate,
        Some(FirstDrainCoordinate::DeclaredHuman | FirstDrainCoordinate::UnconfirmedHumanAudit)
    ) {
        // A later confirmation of the same record recomputes the moment, but
        // cannot erase the drain's coverage gap.
        let echoed = crate::apply_replication_envelope(
            &mut receiver,
            &mut cache,
            &last_audit.expect("last audit record"),
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(matches!(echoed.primary, ApplyDisposition::Skipped));
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
    if matches!(
        confirmation,
        Confirmation::Admitted
            | Confirmation::RetentionBound
            | Confirmation::StorageFailure
            | Confirmation::ReaderStorageFailure
    ) && !at_capacity
    {
        authors[0]["relayConfirmed"] = json!(true);
    }
    if local_gap {
        let text: String = receiver
            .read_with(|conn| {
                conn.query_row(
                    "SELECT text FROM blobs WHERE sha256=?1",
                    [moment.after_blob_sha256.as_deref().unwrap()],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert!(text.contains("Local authorless edit."));
        assert!(text.contains("Recipient changed this paragraph."));
    }
    if at_capacity {
        // Prior interval credit for this same person was not relay-confirmed.
        // The checked audit cannot attest that earlier credit through a union.
        assert_eq!(
            stored.as_array().unwrap().len(),
            dohc_engine_collab::author_coverage::MAX_INTERVAL_AUTHORS
        );
        assert!(stored.as_array().unwrap().contains(&authors[0]));
        assert!(
            !stored
                .as_array()
                .unwrap()
                .contains(&json!({"kind":"unattributed"}))
        );
    } else if matches!(
        first_coordinate,
        Some(FirstDrainCoordinate::DeclaredHuman | FirstDrainCoordinate::UnconfirmedHumanAudit)
    ) {
        assert_eq!(
            stored,
            json!([{"kind":"human","humanId":"recipient","humanName":"Recipient"}])
        );
    } else if mixed {
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
        || local_gap
    {
        assert_eq!(stored, json!([authors[0].clone(), {"kind":"unattributed"}]));
    } else {
        assert_eq!(stored, authors);
    }
    assert_eq!(count(&receiver, "live_device_update_applications"), 0);
    let pending: i64 = receiver
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM engine_requests WHERE kind='sync-ydoc-provisional-author'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        pending, 0,
        "verified coordinates consume their outstanding audit request"
    );
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
    let receipt = dohc_engine_collab::live_update_application::LiveUpdateReceipt {
        delivery_id: format!("delivery-{terminal}"),
        update_digest: hex_sha256(&f.bytes),
        journal_cursor: terminal,
        accepting_host_epoch: 1,
    };
    settle_through(f, receipt, moment_id);
    moment_authors(&f.store, moment_id).expect("the host credits its interval")
}

/// Settle through `receipt` as the host does and journal the settlement.
fn settle_through(
    f: &mut Fixture,
    receipt: dohc_engine_collab::live_update_application::LiveUpdateReceipt,
    moment_id: &str,
) {
    use dohc_engine_collab::live_update_application::with_settlement;
    use dohc_engine_storage::TxnOutcome;
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
        // their agent keep theirs. Each frame repeats the baseline's bytes,
        // so the link's frame without recording context adds no content and
        // leaves no gap.
        assert_eq!(kinds(&host), ["agent", "human", "link", "named"]);
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
        NativeHistoryReconstruction, OwnerAdoptionCut, adopt_owner_committed,
        capture_imported_owner_activation,
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
            ordinary_pull: None,
        },
        &NoFaults,
        &NoLiveLeases,
        250,
    )
    .unwrap();
    let activation = capture_imported_owner_activation(
        &mut store, "relay", &key, "note.md", 1_000_000, &NoFaults, None,
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
        retained_prefix: None,
        outbox_limits: dohc_engine_collab::OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 100_000,
        },
        reconstruction: NativeHistoryReconstruction {
            working_reserve_bytes: 8 * 1024 * 1024,
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
        None,
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
    accept_named_event(&mut f, 1, delivery.clone());
    // The seed keeps its receipt; until then the host holds every later delivery.
    let outbox: String = f
        .store
        .read_with(|conn| {
            conn.query_row("SELECT outbox_id FROM owner_ydoc_outboxes", [], |r| {
                r.get(0)
            })
            .map_err(SyncError::corrupt)
        })
        .unwrap();
    dohc_engine_collab::owner_outbox::acknowledge(
        &mut f.store,
        "ws",
        &outbox,
        &[dohc_engine_collab::owner_outbox::OwnerDeliveryReceipt {
            delivery_id: delivery,
            update_digest: hex_sha256(&f.bytes),
            journal_cursor: 1,
            accepting_host_epoch: 1,
        }],
    )
    .unwrap();
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

#[test]
fn refused_audit_replayed_below_ack_does_not_block_later_operations() {
    let mut f = fixture(true);
    let op = ReplicationEnvelope {
        workspace_id: "ws".into(),
        origin_id: "remote".into(),
        origin_seq: 0,
        op_kind: application_record::EVENT_OP.into(),
        recorded_at_ms: 200,
        payload: json!({"extra":"refused"}),
        relay_seq: Some(100),
        admitted_author_snapshot: Some(
            json!([{"kind":"human","humanId":"recipient","humanName":"Recipient"}]),
        ),
        settlement_admission: None,
    };
    let first = crate::apply_replication_envelope(
        &mut f.store,
        &mut WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    assert!(matches!(first.primary, ApplyDisposition::Refused(_)));
    let replay = crate::apply_replication_envelope(
        &mut f.store,
        &mut WriterDocCache::new(),
        &op,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    assert!(matches!(replay.primary, ApplyDisposition::Skipped));
    let mut next = op;
    next.origin_seq = 1;
    next.relay_seq = Some(101);
    next.op_kind = "workspace.init".into();
    next.payload = json!({});
    next.admitted_author_snapshot = None;
    let later = crate::apply_replication_envelope(
        &mut f.store,
        &mut WriterDocCache::new(),
        &next,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    assert!(matches!(later.primary, ApplyDisposition::Applied(_)));
}

#[test]
fn ordinary_human_drain_keeps_exact_authors_without_an_unknown_contributor() {
    import_confirmed_projection(
        true,
        false,
        Some(FirstDrainCoordinate::DeclaredHuman),
        false,
        Confirmation::None,
    );
}

#[test]
fn confirmed_and_unconfirmed_audits_of_one_person_merge_without_confirmation() {
    import_confirmed_projection(
        true,
        false,
        Some(FirstDrainCoordinate::UnconfirmedHumanAudit),
        false,
        Confirmation::Admitted,
    );
}

#[test]
fn confirmation_refresh_bound_failure_is_skipped_without_partial_annotation() {
    import_confirmed_projection(false, false, None, false, Confirmation::RetentionBound);
}

#[test]
fn confirmation_refresh_propagates_storage_failure_and_can_retry() {
    import_confirmed_projection(false, false, None, false, Confirmation::StorageFailure);
}

#[test]
fn confirmation_refresh_propagates_streaming_storage_failure_and_can_retry() {
    import_confirmed_projection(
        false,
        false,
        None,
        false,
        Confirmation::ReaderStorageFailure,
    );
}

#[test]
fn one_audit_record_at_two_coordinates_keeps_its_relay_confirmation() {
    for confirmed_first in [true, false] {
        let mut f = fixture(true);
        bootstrap(&mut f, false).unwrap();
        let mut authors = commit_recipient_deliveries(&mut f, 1);
        let copies = [
            AuditCopy {
                event_count: 1,
                republished: false,
                confirmed: confirmed_first,
            },
            AuditCopy {
                event_count: 1,
                republished: true,
                confirmed: !confirmed_first,
            },
        ];
        let (row, moment) = import_audit_copies(&f, &authors, &copies);
        authors[0]["relayConfirmed"] = json!(true);
        assert_eq!(
            row, authors,
            "projection, confirmed first: {confirmed_first}"
        );
        assert_eq!(
            moment, authors,
            "History, confirmed first: {confirmed_first}"
        );
    }
}

#[test]
fn distinct_audit_records_at_one_coordinate_keep_the_conservative_union() {
    for confirmed_first in [true, false] {
        let mut f = fixture(true);
        bootstrap(&mut f, false).unwrap();
        let authors = commit_recipient_deliveries(&mut f, 2);
        let copies = [
            AuditCopy {
                event_count: 1,
                republished: false,
                confirmed: confirmed_first,
            },
            AuditCopy {
                event_count: 2,
                republished: false,
                confirmed: !confirmed_first,
            },
        ];
        let (row, moment) = import_audit_copies(&f, &authors, &copies);
        assert_eq!(
            row, authors,
            "projection, confirmed first: {confirmed_first}"
        );
        assert_eq!(
            moment, authors,
            "History, confirmed first: {confirmed_first}"
        );
    }
}

/// One relay delivery of an audit record: the event it records, whether a
/// second owner store published it at its own coordinate, and whether the
/// relay confirmed its authors.
struct AuditCopy {
    event_count: i64,
    republished: bool,
    confirmed: bool,
}

/// Commits accepted frames from one collaborator. Later deliveries reuse the
/// first frame's bytes, so each audit record names the same content coordinate.
fn commit_recipient_deliveries(f: &mut Fixture, deliveries: i64) -> serde_json::Value {
    use dohc_engine_collab::live_update_application::{
        AdmittedLiveUpdate, AdmittedLiveUpdateMetadata, ApplicationError, LiveUpdateReceipt,
        RelayAcceptedLiveUpdate, ServerDerivedLiveUpdateAuthority, apply_committed,
    };
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&f.bytes).unwrap();
    let update = doc.richdoc_append_paragraph("Recipient changed this paragraph.");
    let authors = json!([{"kind":"human","humanId":"recipient","humanName":"Recipient"}]);
    for cursor in 1..=deliveries {
        let event = AdmittedLiveUpdate {
            metadata: AdmittedLiveUpdateMetadata {
                accepted: RelayAcceptedLiveUpdate {
                    receipt: LiveUpdateReceipt {
                        delivery_id: format!("recipient-delivery-{cursor}"),
                        update_digest: hex_sha256(&update),
                        journal_cursor: cursor,
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
                checkpoint_coverage: None,
            },
            update_bytes: update.clone(),
        };
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
                        ApplicationError::Storage(
                            dohc_engine_storage::StorageError::persist_public(error),
                        )
                    })
            },
        )
        .unwrap();
    }
    authors
}

/// Imports the host's content, then each audit copy in order. Returns the
/// retained projection authors and, after a reopen, the History moment's.
fn import_audit_copies(
    f: &Fixture,
    authors: &serde_json::Value,
    copies: &[AuditCopy],
) -> (serde_json::Value, serde_json::Value) {
    let (_scratch, path, mut receiver) = open_store();
    copy_audit_blobs(&f.store, &mut receiver);
    let ops = operations(&f.store);
    let delta = ops
        .iter()
        .find(|op| op.op_kind == "ydoc.update" && op.payload["isBaseState"] != true)
        .expect("changed content");
    let moment_id = crate::ydoc_apply::ydoc_apply_moment_id(
        &DocKey::new("ws", "main", "object").unwrap(),
        "note.md",
        &delta.origin_id,
        delta.origin_seq,
    );
    let mut cache = WriterDocCache::new();
    let mut audits = Vec::new();
    for mut op in ops {
        op.relay_seq = Some(op.origin_seq + 1);
        if op.op_kind == application_record::EVENT_OP {
            audits.push(op);
            continue;
        }
        let result = crate::apply_replication_envelope(
            &mut receiver,
            &mut cache,
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
    let mut republished_seq = 0;
    for copy in copies {
        let mut op = audits
            .iter()
            .find(|op| op.payload["eventCount"] == copy.event_count)
            .expect("journaled audit record")
            .clone();
        if copy.republished {
            // The record names no adopter, so a second owner store that adopts
            // this lineage publishes the same payload at its own coordinate.
            op.origin_id = "second-owner-origin".into();
            op.origin_seq = republished_seq;
            op.relay_seq = Some(1_000 + republished_seq);
            republished_seq += 1;
        }
        op.admitted_author_snapshot = copy.confirmed.then(|| authors.clone());
        let result = crate::apply_replication_envelope(
            &mut receiver,
            &mut cache,
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(
            matches!(result.primary, ApplyDisposition::Applied(_)),
            "audit copy: {:?}",
            result.primary
        );
    }
    assert_eq!(
        count(&receiver, "live_audit_projection_authors"),
        1,
        "every copy names one content coordinate"
    );
    let row: String = receiver
        .read_with(|conn| {
            conn.query_row(
                "SELECT author_json FROM live_audit_projection_authors",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    drop(receiver);
    let mut receiver = EngineStore::open(&path, 300).unwrap();
    let moment = VersionedTextStore::new(&mut receiver)
        .get_moment("ws", &moment_id)
        .unwrap()
        .expect("projection moment");
    (
        serde_json::from_str(&row).unwrap(),
        serde_json::from_str(moment.author_json.as_deref().expect("audited authors")).unwrap(),
    )
}

fn copy_audit_blobs(source: &EngineStore, target: &mut EngineStore) {
    let blobs: Vec<Vec<u8>> = source
        .read_with(|conn| {
            conn.prepare("SELECT bytes FROM binary_blobs")?
                .query_map([], |row| row.get(0))?
                .collect()
        })
        .unwrap();
    target
        .write_with(&NoFaults, |tx| {
            for bytes in blobs {
                put_binary_blob(tx, &bytes)?;
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

fn malformed_restore_receipt_pull(field: &str, value: serde_json::Value) {
    use dohc_engine_collab::live_update_application::AdmittedLiveUpdateMetadata;
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    let (_scratch, _path, mut receiver) = open_store();
    crate::adopt_join_identity(
        &mut receiver,
        "ws",
        "receiver",
        "epoch",
        "stream",
        200,
        &NoFaults,
    )
    .unwrap();
    copy_audit_blobs(&f.store, &mut receiver);
    for mut op in operations(&f.store) {
        op.relay_seq = Some(op.origin_seq + 1);
        crate::apply_replication_envelope(
            &mut receiver,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
    }
    accept_enrollment_event(&mut f, 1);
    let mut audit = operations(&f.store)
        .into_iter()
        .find(|op| op.op_kind == application_record::EVENT_OP)
        .unwrap();
    let manifest: chunks::Manifest =
        serde_json::from_value(audit.payload["manifest"].clone()).unwrap();
    let record: serde_json::Value = f
        .store
        .read_with(|conn| {
            serde_json::from_reader(chunks::ChunkReader::new(conn, &manifest).unwrap())
        })
        .unwrap();
    let mut metadata: AdmittedLiveUpdateMetadata =
        serde_json::from_value(record["metadata"].clone()).unwrap();
    metadata.accepted.binding.restore_fence_generation = 1;
    metadata.accepted.receipt.journal_cursor = 2;
    let base: BasePayload = serde_json::from_value(published(&f).payload).unwrap();
    let previous = &base.record.checkpoint.evidence_digest;
    let evidence =
        hex_sha256(&serde_json::to_vec(&("accepted-event-v1", previous, 1, &metadata)).unwrap());
    let mut terminal = json!({"deliveryId":"earlier", "updateDigest": f.binding.lineage_claim_id,
        "journalCursor":1, "acceptingHostEpoch":1});
    terminal[field] = value;
    let restore: restore_record::RestoreSource = serde_json::from_value(json!({
        "operationId":"restore", "oldGeneration":0, "origin":{"kind":"bootstrap","id":"bootstrap"},
        "hostId":"host", "appliedSequence":1, "fenceHeadSequence":1, "fencedAtMs":100,
        "point":{"journalCursor":0,"receiptDigest":f.binding.lineage_claim_id,
            "markdownDigest":f.input.projected_markdown_digest,"projectionDigest":f.input.projected_markdown_digest},
        "selected":{"eventCount":0,"terminal":null,"evidenceDigest":previous},
        "accepted":{"eventCount":0,"terminal":terminal,"evidenceDigest":previous},
        "originEvidenceDigest":hex_sha256(&serde_json::to_vec(&f.input).unwrap()),
        "nativeSourceManifestDigest":f.binding.lineage_claim_id,"frozenStateDigest":f.binding.lineage_claim_id,
        "pointStateDigest":f.binding.lineage_claim_id,"finalContentDigest":f.input.projected_markdown_digest
    })).unwrap();
    // Serialize through the native metadata and restore types, in native record order.
    let bytes = format!(
        "{{\"kind\":\"application\",\"relayDatabaseNamespace\":\"relay\",\"eventCount\":1,\"evidenceDigest\":\"{evidence}\",\"updateByteLength\":{},\"metadata\":{},\"sourceApplication\":{{\"localYDocSequence\":2,\"hostCoordinate\":{{\"hostId\":\"host\",\"hostEpoch\":1,\"instanceId\":\"instance\",\"connectionId\":\"connection\"}}}},\"sourceRestore\":{},\"cancelledRestores\":[],\"contentCoordinate\":{}}}",
        f.bytes.len(),
        serde_json::to_string(&metadata).unwrap(),
        serde_json::to_string(&restore).unwrap(),
        record["contentCoordinate"]
    );
    let dohc_engine_storage::TxnOutcome::Committed(manifest) = receiver
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
    audit.payload["manifest"] = serde_json::to_value(manifest).unwrap();
    pull_refused_audit(&mut receiver, audit);
}

fn pull_refused_audit(receiver: &mut EngineStore, mut audit: ReplicationEnvelope) {
    audit.origin_id = "malformed".into();
    audit.origin_seq = 0;
    audit.relay_seq = Some(100);
    audit.admitted_author_snapshot = None;
    let mut later = audit.clone();
    later.origin_seq = 1;
    later.relay_seq = Some(101);
    later.op_kind = "workspace.init".into();
    later.payload = json!({});
    contact(receiver);
    let relay = crate::tests::FakeRelay::default();
    *relay.pull.lock().unwrap() = Some(crate::PullResponse {
        ops: vec![audit, later],
        next_cursor: 101,
        has_more: false,
    });
    let client = crate::RelaySyncClient::new(relay);
    let result = client
        .pull_chat_workspace(
            receiver,
            &mut WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            300,
        )
        .unwrap();
    assert!(
        matches!(
            result,
            crate::SyncPassOutcome::Complete {
                refused: 1,
                applied: 1,
                ..
            }
        ),
        "{result:?}"
    );
    assert_eq!(
        crate::read_replication_acked_seq(receiver, "ws", "malformed").unwrap(),
        1
    );
    assert_eq!(count(receiver, "live_audit_events"), 0);
}

#[test]
fn record_digest_mismatch_does_not_stall_pull() {
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    accept_enrollment_event(&mut f, 1);
    let (_scratch, _path, mut receiver) = open_store();
    crate::adopt_join_identity(
        &mut receiver,
        "ws",
        "receiver",
        "epoch",
        "stream",
        200,
        &NoFaults,
    )
    .unwrap();
    copy_audit_blobs(&f.store, &mut receiver);
    let mut ops = operations(&f.store);
    let mut audit = ops.pop().unwrap();
    assert_eq!(audit.op_kind, application_record::EVENT_OP);
    for mut op in ops {
        op.relay_seq = Some(op.origin_seq + 1);
        crate::apply_replication_envelope(
            &mut receiver,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
    }
    audit.payload["manifest"]["recordDigest"] = json!("f".repeat(64));
    pull_refused_audit(&mut receiver, audit);
}

#[test]
fn malformed_restore_receipt_epoch_does_not_stall_pull() {
    malformed_restore_receipt_pull("acceptingHostEpoch", json!(0));
}

#[test]
fn malformed_restore_receipt_delivery_does_not_stall_pull() {
    malformed_restore_receipt_pull("deliveryId", json!(""));
}

#[test]
fn malformed_restore_receipt_digest_does_not_stall_pull() {
    malformed_restore_receipt_pull("updateDigest", json!("x"));
}

fn canonical_version_read_failure(refresh: bool) {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    accept_enrollment_event(&mut f, 1);
    accept_enrollment_event(&mut f, 2);
    let (_scratch, _path, mut receiver) = open_store();
    copy_audit_blobs(&f.store, &mut receiver);
    let mut ops = operations(&f.store);
    let mut audit = ops.pop().unwrap();
    assert_eq!(audit.op_kind, application_record::EVENT_OP);
    for mut op in ops {
        op.relay_seq = Some(op.origin_seq + 1);
        crate::apply_replication_envelope(
            &mut receiver,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
    }
    audit.relay_seq = Some(audit.origin_seq + 1);
    audit.admitted_author_snapshot = Some(json!([]));
    if refresh {
        crate::apply_replication_envelope(
            &mut receiver,
            &mut WriterDocCache::new(),
            &audit,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
    }
    let target = &mut receiver;
    let before_ack = crate::read_replication_acked_seq(target, "ws", &audit.origin_id).unwrap();
    let denied = Arc::new(AtomicBool::new(false));
    let captured = denied.clone();
    target
        .read_with(|conn| {
            conn.authorizer(Some(move |ctx: AuthContext<'_>| {
                if matches!(
                    ctx.action,
                    AuthAction::Read {
                        table_name: "live_audit_events",
                        column_name: "canonical_version"
                    }
                ) {
                    captured.store(true, Ordering::SeqCst);
                    Authorization::Deny
                } else {
                    Authorization::Allow
                }
            }))
        })
        .unwrap();
    let failed = crate::apply_replication_envelope(
        target,
        &mut WriterDocCache::new(),
        &audit,
        &NoFaults,
        &NoLiveLeases,
    );
    target
        .read_with(|conn| conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>))
        .unwrap();
    assert!(denied.load(Ordering::SeqCst));
    assert!(matches!(failed, Err(SyncError::Storage(_))), "{failed:?}");
    assert_eq!(
        crate::read_replication_acked_seq(target, "ws", &audit.origin_id).unwrap(),
        before_ack
    );
    assert_eq!(count(target, "replication_pending_refusals"), 0);
    let retried = crate::apply_replication_envelope(
        target,
        &mut WriterDocCache::new(),
        &audit,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    assert!(!matches!(retried.primary, ApplyDisposition::Refused(_)));
}

#[test]
fn canonical_version_read_failure_on_import_can_retry() {
    canonical_version_read_failure(false);
}

#[test]
fn canonical_version_read_failure_on_refresh_can_retry() {
    canonical_version_read_failure(true);
}

#[test]
fn damaged_local_audit_chunk_propagates_storage_failure_and_can_retry() {
    let mut f = fixture(true);
    bootstrap(&mut f, false).unwrap();
    accept_enrollment_event(&mut f, 1);
    let mut audit = operations(&f.store).pop().unwrap();
    audit.relay_seq = Some(audit.origin_seq + 1);
    audit.admitted_author_snapshot = Some(json!([]));
    let manifest: chunks::Manifest =
        serde_json::from_value(audit.payload["manifest"].clone()).unwrap();
    let sha = &manifest.chunks[0].sha256;
    let (_scratch, _path, mut receiver) = open_store();
    copy_audit_blobs(&f.store, &mut receiver);
    for mut op in operations(&f.store) {
        op.relay_seq = Some(op.origin_seq + 1);
        crate::apply_replication_envelope(
            &mut receiver,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
    }
    let original = f.store.get_binary_blob(sha).unwrap().unwrap();
    let mut damaged = original.clone();
    damaged[0] ^= 1;
    receiver
        .read_with(|conn| {
            conn.execute(
                "UPDATE binary_blobs SET bytes=?1 WHERE sha256=?2",
                params![damaged, sha],
            )
        })
        .unwrap();
    let result = crate::apply_replication_envelope(
        &mut receiver,
        &mut WriterDocCache::new(),
        &audit,
        &NoFaults,
        &NoLiveLeases,
    );
    assert!(
        matches!(
            result,
            Err(SyncError::Storage(
                dohc_engine_storage::StorageError::BlobIntegrity { .. }
            ))
        ),
        "{result:?}"
    );
    assert_eq!(count(&receiver, "replication_pending_refusals"), 0);
    receiver
        .read_with(|conn| {
            conn.execute(
                "UPDATE binary_blobs SET bytes=?1 WHERE sha256=?2",
                params![original, sha],
            )
        })
        .unwrap();
    let result = crate::apply_replication_envelope(
        &mut receiver,
        &mut WriterDocCache::new(),
        &audit,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    assert!(matches!(result.primary, ApplyDisposition::Skipped));
}

/// Parking, end to end on a session host's hosted replica: a live document
/// backfills, captures its activation, leaves the scope and parks only once
/// the activation is adopted. It returns, its rows skip as redelivered, its
/// Y.Doc holds exactly the state it parked with, and it resumes the same
/// activation.
#[test]
fn a_parked_hosted_document_resumes_its_activation_after_it_returns() {
    use dohc_engine_collab::live_update_application::{
        NativeHistoryReconstruction, OwnerAdoptionCut, adopt_owner_committed,
        capture_imported_owner_activation, resume_imported_owner_activation,
    };
    use dohc_engine_storage::TxnOutcome;
    use std::collections::BTreeMap;
    const HOST: &str = "service-host:host";
    let mut source = fixture(true);
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
    let key = DocKey::new("ws", "main", "object").unwrap();
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&source.bytes).unwrap();
    doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, "An ordinary edit.")
        .unwrap();
    let edit = doc.encode_full_state();
    source
        .store
        .write_with(&NoFaults, |tx| {
            let digest = put_binary_blob(tx, &edit)?;
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
    let mut ops = operations(&source.store);
    for op in &mut ops {
        op.relay_seq = Some(op.origin_seq + 1);
    }
    let end = ops.last().unwrap().origin_seq + 1;

    let (_scratch, _path, mut store) = open_store();
    crate::create_hosted_replica(&mut store, "ws", HOST, "epoch", "stream", 250, &NoFaults)
        .unwrap();
    let (binary, text) = source
        .store
        .read_with(|conn| {
            let binary: Vec<Vec<u8>> = conn
                .prepare("SELECT bytes FROM binary_blobs")?
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            let text: Vec<(String, i64, String)> = conn
                .prepare("SELECT sha256,byte_length,text FROM blobs")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<_, _>>()?;
            Ok::<_, rusqlite::Error>((binary, text))
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
    let scope = |store: &mut EngineStore, token: &str, documents: &[(&str, &str)]| {
        let documents = documents
            .iter()
            .map(|(id, path)| ((*id).to_owned(), (*path).to_owned()))
            .collect::<BTreeMap<_, _>>();
        crate::hosted::adopt_scope(store, "ws", token, &documents, &NoFaults).unwrap();
    };
    let backfill = |store: &mut EngineStore, ops: &[ReplicationEnvelope]| {
        ops.iter()
            .map(|op| {
                crate::apply_replication_envelope(
                    store,
                    &mut WriterDocCache::new(),
                    op,
                    &NoFaults,
                    &NoLiveLeases,
                )
                .unwrap()
                .primary
            })
            .collect::<Vec<_>>()
    };
    let complete = |store: &mut EngineStore, cursor: i64| {
        let replica = crate::read_hosted_replica(store, "ws").unwrap().unwrap();
        let read = crate::HostedRead {
            cursor,
            stopped: None,
            complete: true,
            heads_written: true,
        };
        let committed = crate::commit_hosted_cursor(
            store,
            "ws",
            &crate::HostedCursor {
                scope_generation: replica.scope_generation,
                cursor_commits: replica.cursor_commits,
                main_cursor: None,
                reads: BTreeMap::from([("object".to_owned(), read)]),
                settlement_report_id: None,
            },
            &dohc_engine_collab::live_update_application::ReleasedTails::uncached(),
            &NoFaults,
        )
        .unwrap();
        assert_eq!(
            committed,
            TxnOutcome::Committed(crate::HostedCommit {
                committed: true,
                has_more: false
            })
        );
        crate::read_hosted_replica(store, "ws")
            .unwrap()
            .unwrap()
            .documents["object"]
            .status
            == crate::HostedDocumentStatus::Ready
    };
    let ydoc_state = |store: &EngineStore| {
        let loaded = dohc_engine_collab::load_persisted(store, &key)
            .unwrap()
            .unwrap();
        hex_sha256(&loaded.doc.encode_full_state())
    };

    scope(&mut store, "scope-1", &[("object", "note.md")]);
    assert!(
        backfill(&mut store, &ops)
            .iter()
            .all(|applied| matches!(applied, ApplyDisposition::Applied(_)))
    );
    assert!(complete(&mut store, end));
    let activation = capture_imported_owner_activation(
        &mut store, "relay", &key, "note.md", 1_000_000, &NoFaults, None,
    )
    .unwrap();

    // Its activation has no adoption yet, so it cannot park.
    scope(&mut store, "scope-2", &[]);
    assert!(!crate::hosted_document_parkable(&store, "ws", "object").unwrap());
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
    adopt_owner_committed(
        &mut store,
        &handle,
        OwnerAdoptionCut {
            relay_database_namespace: "relay".into(),
            adoption_id: activation.activation_id.clone(),
            source_moment_id: activation.source.source_moment_id.clone(),
            source_digest: activation.source.source_digest.clone(),
            source_byte_length: activation.source.source_byte_length,
            baseline_moment_relay_sequence: ops
                .iter()
                .find(|op| op.payload["momentId"] == "bootstrap-moment")
                .unwrap()
                .origin_seq
                + 1,
            baseline_registered_at_ms: 100,
            baseline_bytes: source.bytes.clone(),
            expected_local_sequence: activation.source.native_head_sequence,
            events: vec![],
            terminal_receipt: None,
            retained_prefix: None,
            outbox_limits: dohc_engine_collab::OwnerOutboxLimits {
                max_pending_bytes: 1_000_000,
                max_pending_age_ms: 100_000,
            },
            reconstruction: NativeHistoryReconstruction {
                working_reserve_bytes: 8 * 1024 * 1024,
            },
        },
        1_000_000,
        10,
        260,
        &NoFaults,
        None,
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
    drop(owner);
    // The relay acknowledged what the host wrote and its seed was delivered.
    let host_ops = crate::list_replication_ops(&store, "ws", HOST, -1, 500).unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                 VALUES ('ws',?1,?2)",
                params![HOST, host_ops.last().unwrap().origin_seq],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "UPDATE owner_ydoc_outboxes SET pending_bytes=0,oldest_entry_at_ms=NULL",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    assert!(crate::hosted_document_parkable(&store, "ws", "object").unwrap());
    let parked = (
        ydoc_state(&store),
        count(&store, "ydoc_updates"),
        count(&store, "replication_log"),
    );
    assert_eq!(
        crate::park_hosted_document(&mut store, "ws", "object", "main", &NoFaults).unwrap(),
        TxnOutcome::Committed(true)
    );
    for file in crate::retired_hosted_files(&store, "ws").unwrap() {
        crate::forget_retired_hosted_file(&mut store, "ws", &file.path, &NoFaults).unwrap();
    }
    assert_eq!(count(&store, "snapshots"), 0);
    let coordinate = ApplicationHostCoordinate {
        host_id: "service-host".into(),
        host_epoch: 2,
        instance_id: "self-host-service".into(),
        connection_id: "connection".into(),
    };
    assert!(
        ApplicationOwner::new("ws".into())
            .unwrap()
            .register(
                &mut store,
                "relay".into(),
                coordinate,
                source.binding.clone()
            )
            .is_err(),
        "a parked document registers nothing"
    );
    assert!(matches!(
        resume_imported_owner_activation(
            &mut store,
            "relay",
            &key,
            "note.md",
            &activation.activation_id,
            1_000_000,
            None
        ),
        Err(dohc_engine_collab::live_update_application::ApplicationError::HostedDocumentUnready)
    ));

    // It returns: its head comes back, every row it applied skips, the host's
    // own rows too, and it is ready with the state it parked with.
    scope(&mut store, "scope-3", &[("object", "note.md")]);
    crate::hosted::unpark_returned(&mut store, "ws", &NoFaults).unwrap();
    let heads = store
        .read_with(|conn| crate::hosted::head_writes(conn, "ws", "object"))
        .unwrap();
    assert_eq!(
        heads
            .iter()
            .map(|change| change.path.as_str())
            .collect::<Vec<_>>(),
        ["note.md"]
    );
    let mut redelivered = ops.clone();
    redelivered.extend(host_ops.into_iter().enumerate().map(|(index, mut op)| {
        op.relay_seq = Some(end + 1 + index as i64);
        op
    }));
    assert!(
        backfill(&mut store, &redelivered)
            .iter()
            .all(|skipped| matches!(skipped, ApplyDisposition::Skipped))
    );
    assert!(complete(&mut store, end + redelivered.len() as i64));
    assert_eq!(
        (
            ydoc_state(&store),
            count(&store, "ydoc_updates"),
            count(&store, "replication_log"),
        ),
        parked,
        "nothing applied twice"
    );
    let resumed = resume_imported_owner_activation(
        &mut store,
        "relay",
        &key,
        "note.md",
        &activation.activation_id,
        1_000_000,
        None,
    )
    .unwrap();
    assert_eq!(resumed.activation_id, activation.activation_id);
    assert_eq!(resumed.source, activation.source);
    assert_eq!(resumed.full_state, activation.full_state);
}
