use super::*;
use dohc_engine_storage::{NoFaults, TxnOutcome};

#[derive(Default)]
struct PausedRelay(
    crate::tests::FakeRelay,
    std::sync::atomic::AtomicBool,
    std::sync::atomic::AtomicUsize,
    std::sync::atomic::AtomicUsize,
);

macro_rules! delegate {
    ($method:ident, $request:ty, $response:ty) => {
        fn $method(&self, request: $request) -> Result<$response, RelayError> {
            self.0.$method(request)
        }
    };
}

impl RelayTransport for PausedRelay {
    delegate!(push, PushRequest, PushResponse);
    delegate!(pull, PullRequest, PullResponse);
    delegate!(
        lookup_log_coordinate,
        LogCoordinateRequest,
        LogCoordinateResponse
    );
    delegate!(probe, ProbeRequest, ProbeResponse);
    delegate!(claim_workspace, ClaimRequest, ClaimResponse);
    delegate!(rotate_epoch, EpochRequest, EpochResponse);
    fn upload_blob(&self, request: BlobUploadRequest) -> Result<(), RelayError> {
        let limit = self.3.load(std::sync::atomic::Ordering::SeqCst);
        if limit > 0 && self.2.load(std::sync::atomic::Ordering::SeqCst) >= limit {
            return Err(RelayError::Local("prepared-upload-test-pause".into()));
        }
        assert_eq!(
            dohc_engine_storage::hex_sha256(&request.bytes),
            request.sha256
        );
        self.2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
    delegate!(
        download_blobs,
        BlobDownloadBatchRequest,
        BlobDownloadBatchResponse
    );
    delegate!(upload_key_envelope, KeyEnvelopeRequest, KeyEnvelopeResponse);
    delegate!(
        download_key_envelope,
        KeyEnvelopeDownloadRequest,
        KeyEnvelopeDownloadResponse
    );
    delegate!(
        shared_channel_pull,
        SharedChannelRequest,
        SharedChannelResponse
    );
    delegate!(share_log_push, ShareLogPushRequest, PushResponse);
    delegate!(share_view_pull, ShareViewRequest, ShareViewResponse);
    delegate!(share_blob, ShareBlobRequest, BlobDownloadResponse);
    delegate!(share_blob_upload, ShareBlobUploadRequest, ());
    delegate!(
        share_proposal_submit,
        ShareProposalSubmitRequest,
        ShareProposalSubmitResponse
    );
    delegate!(
        share_collection_write,
        ShareCollectionWriteRequest,
        ShareCollectionWriteResponse
    );
    fn blobs_have(&self, request: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError> {
        if self.1.load(std::sync::atomic::Ordering::SeqCst) {
            Ok(BlobHaveResponse {
                missing: request.sha256s,
            })
        } else {
            Err(RelayError::Local("prepared-page-test-pause".into()))
        }
    }
}

fn resume(
    client: &RelaySyncClient<PausedRelay>,
    store: &mut EngineStore,
    progress: &mut PushWorkspaceProgress,
) -> Result<SyncPassOutcome, RelayError> {
    client.resume_push_workspace(
        store,
        "ws",
        &NoFaults,
        &crate::NoLiveLeases,
        20,
        8 * 1024 * 1024,
        progress,
    )
}

fn acknowledge_seed(store: &mut EngineStore) {
    store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO sync_relay_push_state(workspace_id,origin_id,pushed_seq) VALUES ('ws','local',0)", []).map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    }).unwrap();
}

#[test]
fn prepared_owner_prefix_rechecks_a_restore_after_upload_progress() {
    let (_scratch, mut store, observed, checkpoint) = crate::tests::owner_publication::fixture();
    acknowledge_seed(&mut store);
    let TxnOutcome::Committed(second_blob) = store
        .write_with(&NoFaults, |tx| {
            dohc_engine_storage::put_binary_blob(tx, b"second blob")
        })
        .unwrap()
    else {
        panic!("unexpected crash");
    };
    for (kind, payload) in [
        ("chat.message.append", serde_json::json!({})),
        (
            "ydoc.update",
            serde_json::json!({"versionId":"main","objectId":"owner","path":"owner.md","contentKind":"richdoc","lineageClaimId":observed.binding.lineage_claim_id,"updateBlobSha256":dohc_engine_storage::hex_sha256(&checkpoint)}),
        ),
        ("chat.message.append", serde_json::json!({})),
        ("chat.message.append", serde_json::json!({})),
        (
            "moment.append",
            serde_json::json!({"versionId":"main","objectId":"other","path":"other.bin","payloadAfterContentKind":"binary","payloadAfterBlobSha256":second_blob,"payloadAfterByteLength":11}),
        ),
    ] {
        crate::journal_local_replication_op(
            &mut store, "ws", "local", "epoch-1", "stream-1", kind, &payload, 10, &NoFaults,
        )
        .unwrap();
    }
    let client = RelaySyncClient::new(PausedRelay::default());
    client
        .transport()
        .1
        .store(true, std::sync::atomic::Ordering::SeqCst);
    client
        .transport()
        .3
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let mut progress = PushWorkspaceProgress::default();
    assert!(matches!(
        resume(&client, &mut store, &mut progress),
        Err(RelayError::Local(ref message)) if message == "prepared-upload-test-pause"
    ));
    let page = progress.page.as_ref().unwrap();
    assert_eq!(page.ops.len(), 5);
    assert_eq!(page.prefix.allowed_ops, 5);
    assert_eq!(page.uploaded_ops, 4);
    assert!(page.sending.is_none());
    assert_eq!(
        client
            .transport()
            .2
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    assert!(page.inventory.is_empty());
    assert_eq!(page.missing, BTreeSet::from([second_blob]));
    let held = page.ops[1].origin_seq;
    store.write_with(&NoFaults, |tx| {
        let input = serde_json::json!({"oldBinding":observed.binding,"newFence":1});
        tx.execute("INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,input_json,receipt_json) VALUES ('ws','main','owner','relay','restore',?1,'{}')", [input.to_string()]).unwrap();
        Ok::<_, SyncError>(())
    }).unwrap();
    let outcome = resume(&client, &mut store, &mut progress).unwrap();
    assert!(
        client
            .transport()
            .0
            .pushed_requests()
            .iter()
            .all(|request| request.ops.iter().all(|op| op.origin_seq != held)),
        "held owner operation was appended"
    );
    assert!(
        matches!(outcome, SyncPassOutcome::Complete { pushed:1, ref owner_admission_pending, .. } if owner_admission_pending.len()==1 && owner_admission_pending[0].origin_seq==held)
    );
    assert_eq!(
        crate::read_pushed_seq(&store, "ws", "local").unwrap(),
        held - 1
    );
}

#[test]
fn prepared_push_reads_an_overflowing_blob_only_in_its_own_round() {
    let (_scratch, mut store, _, _) = crate::tests::owner_publication::fixture();
    acknowledge_seed(&mut store);
    let large = vec![7; 2 * 1024 * 1024];
    let large_sha = hex_sha256(&large);
    // Inventory within one operation window visits digests in sorted order.
    let small = (0..100)
        .map(|index| format!("small {index}").into_bytes())
        .find(|bytes| hex_sha256(bytes) < large_sha)
        .unwrap();
    for bytes in [small, large] {
        let TxnOutcome::Committed(sha) = store
            .write_with(&NoFaults, |tx| {
                dohc_engine_storage::put_binary_blob(tx, &bytes)
            })
            .unwrap()
        else {
            panic!("unexpected crash");
        };
        let payload = serde_json::json!({"versionId":"main","objectId":"other","path":"other.bin","payloadAfterContentKind":"binary","payloadAfterBlobSha256":sha,"payloadAfterByteLength":bytes.len()});
        crate::journal_local_replication_op(
            &mut store,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "moment.append",
            &payload,
            10,
            &NoFaults,
        )
        .unwrap();
    }
    let client = RelaySyncClient::new(PausedRelay::default());
    client
        .transport()
        .1
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = take_local_blob_bytes_call_count();
    let result = resume(&client, &mut store, &mut PushWorkspaceProgress::default()).unwrap();
    assert!(matches!(
        result,
        SyncPassOutcome::Complete { pushed: 2, .. }
    ));
    assert_eq!(
        client
            .transport()
            .2
            .load(std::sync::atomic::Ordering::SeqCst),
        2
    );
    assert_eq!(take_local_blob_bytes_call_count(), 2, "read each blob once");
}

#[test]
fn prepared_push_keeps_private_owner_bytes_pending_admission() {
    let (_scratch, mut store, observed, checkpoint) = crate::tests::owner_publication::fixture();
    acknowledge_seed(&mut store);
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let update = doc.richdoc_append_paragraph("not admitted");
    let TxnOutcome::Committed(sha) = store
        .write_with(&NoFaults, |tx| {
            dohc_engine_storage::put_binary_blob(tx, &update)
        })
        .unwrap()
    else {
        panic!("unexpected crash");
    };
    let payload = serde_json::json!({"versionId":"main","objectId":"owner","path":"owner.md","contentKind":"richdoc","lineageClaimId":observed.binding.lineage_claim_id,"updateBlobSha256":sha});
    crate::journal_local_replication_op(
        &mut store,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "ydoc.update",
        &payload,
        10,
        &NoFaults,
    )
    .unwrap();
    let client = RelaySyncClient::new(PausedRelay::default());
    let result = client
        .push_workspace(
            &mut store,
            "ws",
            &NoFaults,
            &crate::NoLiveLeases,
            20,
            8 * 1024 * 1024,
        )
        .unwrap();
    assert!(
        matches!(result, SyncPassOutcome::Complete { pushed:0, ref owner_admission_pending, .. } if owner_admission_pending.len()==1)
    );
    assert_eq!(crate::read_pushed_seq(&store, "ws", "local").unwrap(), 0);
    assert!(client.transport().0.pushed_requests().is_empty());
}

#[test]
fn prepared_owner_prefix_rechecks_restore_lineage_binding_and_refusal_writes() {
    for mutation in ["restore", "lineage", "binding", "refusal"] {
        let (_scratch, mut store, observed, checkpoint) =
            crate::tests::owner_publication::fixture();
        acknowledge_seed(&mut store);
        let payload = serde_json::json!({"versionId":"main","objectId":"owner","path":"owner.md","contentKind":"richdoc","lineageClaimId":observed.binding.lineage_claim_id,"updateBlobSha256":dohc_engine_storage::hex_sha256(&checkpoint)});
        crate::journal_local_replication_op(
            &mut store,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "ydoc.update",
            &payload,
            10,
            &NoFaults,
        )
        .unwrap();
        let client = RelaySyncClient::new(PausedRelay::default());
        let mut progress = PushWorkspaceProgress::default();
        assert!(matches!(
            resume(&client, &mut store, &mut progress),
            Err(RelayError::Local(_))
        ));
        let revision = progress.page.as_ref().unwrap().revision;
        assert!(progress.page.as_ref().unwrap().prefix.allowed_ops > 0);
        store.write_with(&NoFaults, |tx| {
            match mutation {
                "restore" => {
                    let input = serde_json::json!({"oldBinding":observed.binding,"newFence":1});
                    tx.execute("INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,input_json,receipt_json) VALUES ('ws','main','owner','relay','restore',?1,'{}')", [input.to_string()]).unwrap();
                }
                "lineage" => {
                    let bytes = dohc_engine_collab::Ydoc::wire().richdoc_append_paragraph("new lineage");
                    let sha = dohc_engine_storage::put_binary_blob(tx, &bytes)?;
                    tx.execute("UPDATE ydoc_docs SET lineage_claim_id=?1 WHERE object_id='owner'", [sha]).unwrap();
                }
                "binding" => { tx.execute("UPDATE ydoc_owner_bindings SET binding_json=json_set(binding_json,'$.currentPath','renamed.md') WHERE object_id='owner'", []).unwrap(); }
                "refusal" => { tx.execute("INSERT INTO replication_pending_refusals(workspace_id,origin_id,origin_seq,op_kind,reason_code,reason_message) SELECT workspace_id,origin_id,origin_seq,op_kind,'invalid-input','refused while uploading' FROM replication_log WHERE workspace_id='ws' AND origin_id='local' AND origin_seq=0", []).unwrap(); }
                _ => unreachable!(),
            }
            Ok::<_, SyncError>(())
        }).unwrap();
        let result = resume(&client, &mut store, &mut progress);
        assert!(
            progress.page.as_ref().unwrap().revision > revision,
            "{mutation} must rebuild native proof"
        );
        if mutation != "refusal" {
            assert!(
                matches!(result, Ok(SyncPassOutcome::Complete { ref owner_admission_pending, .. }) if !owner_admission_pending.is_empty()),
                "{mutation}: {result:?}"
            );
            assert!(
                client
                    .transport()
                    .0
                    .pushed_requests()
                    .iter()
                    .all(|p| p.ops.is_empty())
            );
        } else {
            assert!(matches!(result, Err(RelayError::Local(_))));
        }
        assert!(!matches!(
            result,
            Ok(SyncPassOutcome::CrashedAfterRemoteCommit)
        ));
    }
}

#[test]
fn prepared_page_rechecks_cursor_before_consuming_its_inventory() {
    let (_scratch, mut store, observed, checkpoint) = crate::tests::owner_publication::fixture();
    acknowledge_seed(&mut store);
    let payload = serde_json::json!({"versionId":"main","objectId":"owner","path":"owner.md","contentKind":"richdoc","lineageClaimId":observed.binding.lineage_claim_id,"updateBlobSha256":dohc_engine_storage::hex_sha256(&checkpoint)});
    crate::journal_local_replication_op(
        &mut store,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "ydoc.update",
        &payload,
        10,
        &NoFaults,
    )
    .unwrap();
    let client = RelaySyncClient::new(PausedRelay::default());
    let mut progress = PushWorkspaceProgress::default();
    assert!(resume(&client, &mut store, &mut progress).is_err());
    let last = progress
        .page
        .as_ref()
        .unwrap()
        .ops
        .last()
        .unwrap()
        .origin_seq;
    assert!(matches!(store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO sync_relay_push_state(workspace_id,origin_id,pushed_seq) VALUES ('ws','local',?1) ON CONFLICT(workspace_id,origin_id) DO UPDATE SET pushed_seq=excluded.pushed_seq", [last]).unwrap();
        Ok::<_, SyncError>(())
    }).unwrap(), TxnOutcome::Committed(())));
    assert!(matches!(
        resume(&client, &mut store, &mut progress),
        Ok(SyncPassOutcome::Complete { pushed: 0, .. })
    ));
    assert!(
        client
            .transport()
            .0
            .pushed_requests()
            .iter()
            .all(|p| p.ops.is_empty())
    );
}
