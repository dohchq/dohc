use super::*;
use dohc_engine_collab::{
    ContentKind, DocKey, Ydoc,
    owner_outbox::{
        OwnerOutboxLimits,
        accepted::{OwnerAcceptedFrameInput, apply_frame_in_tx},
        draft::{ObservedOwnerBinding, install_observed_binding_in_tx},
    },
};

pub(crate) fn fixture() -> (ScratchDir, EngineStore, ObservedOwnerBinding, Vec<u8>) {
    fixture_at("owner.md")
}

/// The owner fixture with its page at `path`.
fn fixture_at(path: &str) -> (ScratchDir, EngineStore, ObservedOwnerBinding, Vec<u8>) {
    let (dir, _, mut store) = open_store();
    seed_identity(&mut store);
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 0, &NoFaults)
        .unwrap();
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let original: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
    seed_text_head(
        &mut store,
        "owner",
        path,
        fixture["markdown"].as_str().unwrap(),
    );
    let key = DocKey::new("ws", "main", "owner").unwrap();
    dohc_engine_collab::claim_base(
        &mut store,
        &key,
        ContentKind::Richdoc,
        &original,
        &NoFaults,
        2,
    )
    .unwrap();
    let doc = Ydoc::wire();
    doc.apply(&original).unwrap();
    let checkpoint = doc.encode_full_state();
    let head = store
        .read_with(|conn| dohc_engine_collab::read_marker_in(conn, &key))
        .unwrap()
        .unwrap()
        .head_update_seq;
    let observed = ObservedOwnerBinding {
        binding: dohc_engine_collab::LiveObjectBinding {
            workspace_id: "ws".into(),
            main_version_id: "main".into(),
            object_id: "owner".into(),
            lineage_claim_id: dohc_engine_storage::hex_sha256(&original),
            current_path: path.into(),
            selector_paths: vec![path.into()],
            restore_fence_generation: 0,
        },
        relay_database_namespace: "relay".into(),
        revision: 1,
        accepted_cursor: 0,
        native_head_sequence: head,
        checkpoint_digest: dohc_engine_storage::hex_sha256(&checkpoint),
        limits: OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 60_000,
        },
    };
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET path=?1", [path]).unwrap();
            install_observed_binding_in_tx(tx, "ws", &observed, &checkpoint)
        })
        .unwrap();
    (dir, store, observed, checkpoint)
}
fn candidate(
    store: &mut EngineStore,
    observed: &ObservedOwnerBinding,
    bytes: &[u8],
    seq: i64,
) -> ReplicationEnvelope {
    let digest = store
        .write_with(&NoFaults, |tx| {
            dohc_engine_storage::put_binary_blob(tx, bytes)
        })
        .unwrap();
    let TxnOutcome::Committed(digest) = digest else {
        panic!("fault");
    };
    envelope(
        "local",
        seq,
        "ydoc.update",
        json!({"versionId":"main","objectId":"owner","path":"owner.md","contentKind":"richdoc","lineageClaimId":observed.binding.lineage_claim_id,"updateBlobSha256":digest}),
    )
}
#[tokio::test]
async fn released_owner_accepts_an_ordinary_peer_update_through_replication() {
    use dohc_engine_collab::owner_outbox::release;
    let (dir, mut store, observed, checkpoint) = fixture();
    let key = DocKey::new("ws", "main", "owner").unwrap();
    store
        .write_with(&NoFaults, |tx| {
            release::request_in_tx(tx, &key, 20)?;
            release::release_in_tx(
                tx,
                &observed.binding,
                Some(observed.accepted_cursor),
                None,
                21,
                |_, _, _, _, _| Ok(()),
            )
        })
        .unwrap();
    let peer = Ydoc::wire();
    peer.apply(&checkpoint).unwrap();
    let update = peer.richdoc_append_paragraph("ordinary peer after Stop");
    let mut op = candidate(&mut store, &observed, &update, 0);
    op.origin_id = "peer".into();
    op.relay_seq = Some(2);
    let mut cache = dohc_engine_collab::WriterDocCache::new();
    cache.reader_resolver = Some(std::sync::Arc::new(
        dohc_engine_collab::reader_resolver::ReaderResolver::new(std::sync::Arc::new(
            dohc_engine_reader::Reader::new(Some(super::markdown_write_hold::witness_reader(
                &dir,
                "witness-safe",
            ))),
        )),
    ));
    let result = loop {
        match apply_ydoc_envelope(&mut store, &mut cache, &op, &NoFaults, &NoLiveLeases) {
            Ok(result) => break result,
            Err(SyncError::MarkdownWitnessCheckPending { pending, .. }) => pending.resolve().await,
            Err(error) => panic!("{error:?}"),
        }
    };
    assert!(matches!(result.primary, ApplyDisposition::Applied(_)));
    assert!(result.refusals.is_empty());
    store
        .read_with(|conn| {
            let doc = dohc_engine_collab::load_doc_in(conn, &key).unwrap();
            assert!(
                doc.project(ContentKind::Richdoc)
                    .unwrap()
                    .content
                    .contains("ordinary peer after Stop")
            );
            Ok::<_, SyncError>(())
        })
        .unwrap();
}
#[test]
fn pending_server_draft_does_not_enter_or_block_the_ordinary_publication_prefix() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    let ordinary_before = store.table_row_count("replication_log").unwrap();
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let append = dohc_engine_collab::owner_outbox::draft::append_draft_cached(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        "ws",
        dohc_engine_collab::owner_outbox::draft::OwnerDraftAppendInput {
            person_edit: false,
            binding: observed.binding.clone(),
            expected_revision: 1,
            append_key: "offline-button".into(),
            update: doc.richdoc_append_paragraph("waiting for an offline owner"),
            now_ms: 3,
            agent_declaration: None,
            agent_run_id: None,
            automation_declaration: Some(dohc_engine_domain::AutomationDeclaration {
                automation_id: "collection:Tasks#mark".into(),
                attribution: dohc_engine_domain::ChangeAttribution {
                    actor_kind: dohc_engine_domain::ChangeActorKind::Automation,
                    on_behalf_of: Some("presser".into()),
                    depth: 1,
                    run: None,
                    agent_run_id: None,
                },
            }),
        },
        &NoFaults,
    )
    .unwrap();
    assert!(append.pending_bytes > 0);
    assert_eq!(
        store.table_row_count("replication_log").unwrap(),
        ordinary_before
    );
    let digest = seed_text_head(&mut store, "independent", "new-record.md", "new record");
    let ops = vec![
        envelope("local", 0, "chat.message.append", json!({})),
        envelope(
            "local",
            1,
            "moment.append",
            json!({"versionId":"main","objectId":"independent","path":"new-record.md","payloadAfterBlobSha256":digest}),
        ),
        envelope("local", 2, "chat.message.append", json!({})),
    ];
    let prefix = owner_publication_prefix(&store, "ws", &ops, 1_000_000, None).unwrap();
    assert_eq!(prefix.allowed_ops, ops.len());
    assert!(prefix.pending.is_none());
    assert_eq!(
        store.table_row_count("owner_ydoc_outbox_entries").unwrap(),
        1
    );
}

#[test]
fn prefix_stops_before_private_bytes_then_releases_exact_contained_state() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let update = doc.richdoc_append_paragraph("private edit");
    let op = candidate(&mut store, &observed, &update, 1);
    let safe = envelope("local", 0, "chat.message.append", json!({}));
    let tail = envelope("local", 2, "chat.message.append", json!({}));
    let ops = vec![safe, op.clone(), tail];
    let prefix = owner_publication_prefix(&store, "ws", &ops, 1_000_000, None).unwrap();
    assert_eq!(prefix.allowed_ops, 1);
    assert_eq!(prefix.pending.unwrap().origin_seq, 1);
    store
        .write_with(&NoFaults, |tx| {
            apply_frame_in_tx(
                tx,
                "ws",
                &OwnerAcceptedFrameInput {
                    binding: observed.binding.clone(),
                    relay_database_namespace: "relay".into(),
                    expected_revision: 1,
                    expected_native_head_sequence: observed.native_head_sequence,
                    previous_accepted_cursor: 0,
                    journal_cursor: 1,
                    update_bytes: update,
                },
                3,
            )
        })
        .unwrap();
    assert_eq!(
        owner_publication_prefix(&store, "ws", &ops, 1_000_000, None)
            .unwrap()
            .allowed_ops,
        3
    );
    assert_eq!(
        owner_publication_prefix(&store, "ws", &ops, 0, None)
            .unwrap()
            .allowed_ops,
        1
    );
    let mut named = op;
    named.payload["versionId"] = json!("independent-version");
    assert_eq!(
        owner_publication_prefix(&store, "ws", &[named], 0, None)
            .unwrap()
            .allowed_ops,
        1
    );
}
#[test]
fn old_update_and_original_base_remain_echoes_after_frame_receipt_pruning() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    let key = DocKey::new("ws", "main", "owner").unwrap();
    let original = store
        .get_binary_blob(&observed.binding.lineage_claim_id)
        .unwrap()
        .unwrap();
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let first = doc.richdoc_append_paragraph("first accepted");
    let first_input = OwnerAcceptedFrameInput {
        binding: observed.binding.clone(),
        relay_database_namespace: "relay".into(),
        expected_revision: 1,
        expected_native_head_sequence: observed.native_head_sequence,
        previous_accepted_cursor: 0,
        journal_cursor: 1,
        update_bytes: first.clone(),
    };
    let first_result = store
        .write_with(&NoFaults, |tx| apply_frame_in_tx(tx, "ws", &first_input, 3))
        .unwrap();
    let TxnOutcome::Committed(first_result) = first_result else {
        panic!("fault")
    };
    let second = doc.richdoc_append_paragraph("second accepted");
    let second_input = OwnerAcceptedFrameInput {
        expected_revision: 2,
        expected_native_head_sequence: first_result.native_head_sequence,
        previous_accepted_cursor: 1,
        journal_cursor: 2,
        update_bytes: second,
        ..first_input
    };
    store
        .write_with(&NoFaults, |tx| {
            apply_frame_in_tx(tx, "ws", &second_input, 4)
        })
        .unwrap();
    store
        .read_with(|conn| {
            let old: i64 = conn
                .query_row(
                    "SELECT count(*) FROM ydoc_owner_applied_frames WHERE journal_cursor=1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(old, 0);
            for bytes in [&first, &original] {
                assert_eq!(
                    dohc_engine_collab::owner_outbox::publication::contains_observed_update_in(
                        conn,
                        &key,
                        "owner.md",
                        &observed.binding.lineage_claim_id,
                        bytes
                    )
                    .unwrap(),
                    Some(true)
                );
            }
            Ok::<_, SyncError>(())
        })
        .unwrap();
    for (seq, bytes) in [(0, &first), (1, &original)] {
        let mut op = candidate(&mut store, &observed, bytes, seq);
        op.origin_id = "late-owner-echo".into();
        op.relay_seq = Some(seq + 1);
        if seq == 1 {
            op.payload["isBaseState"] = json!(true);
        }
        let result = apply_ydoc_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(matches!(result.primary, ApplyDisposition::Applied(_)));
        assert!(result.refusals.is_empty());
    }
}
#[test]
fn moment_before_and_fork_snapshots_need_exact_projection_proof() {
    let (_dir, store, observed, checkpoint) = fixture();
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let accepted = dohc_engine_storage::hex_sha256(
        doc.project(ContentKind::Richdoc)
            .unwrap()
            .content
            .as_bytes(),
    );
    let private = dohc_engine_storage::hex_sha256(b"unadmitted snapshot");
    let moment = envelope(
        "local",
        1,
        "moment.append",
        json!({"versionId":"main","objectId":"owner","path":"owner.md","payloadAfterBlobSha256":accepted,"payloadBeforeBlobSha256":private}),
    );
    assert_eq!(
        owner_publication_prefix(&store, "ws", &[moment], 1_000_000, None)
            .unwrap()
            .allowed_ops,
        0
    );
    let fork = version_create_with_shipped_snapshots(
        "local",
        "branch",
        vec![shipped_text_snapshot(
            &observed.binding.object_id,
            "owner.md",
            &private,
        )],
    );
    assert_eq!(
        owner_publication_prefix(&store, "ws", &[fork], 1_000_000, None)
            .unwrap()
            .allowed_ops,
        0
    );
}

#[test]
fn delete_sets_require_acceptance_even_when_struct_clocks_already_match() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    // Yjs deletion of all body children in the pinned owner-source seed. It
    // carries no new structs, so comparing state vectors would accept it early.
    let deletion = decode_hex("0001f38ce4ab0d01011d");
    let before = Ydoc::wire();
    before.apply(&checkpoint).unwrap();
    let vector = before.encode_state_vector();
    before.apply(&deletion).unwrap();
    assert_eq!(before.encode_state_vector(), vector);
    let op = candidate(&mut store, &observed, &deletion, 1);
    assert_eq!(
        owner_publication_prefix(&store, "ws", std::slice::from_ref(&op), 1_000_000, None)
            .unwrap()
            .allowed_ops,
        0
    );
    store
        .write_with(&NoFaults, |tx| {
            apply_frame_in_tx(
                tx,
                "ws",
                &OwnerAcceptedFrameInput {
                    binding: observed.binding.clone(),
                    relay_database_namespace: "relay".into(),
                    expected_revision: 1,
                    expected_native_head_sequence: observed.native_head_sequence,
                    previous_accepted_cursor: 0,
                    journal_cursor: 1,
                    update_bytes: deletion,
                },
                3,
            )
        })
        .unwrap();
    assert_eq!(
        owner_publication_prefix(&store, "ws", &[op], 1_000_000, None)
            .unwrap()
            .allowed_ops,
        1
    );
}
#[test]
fn workspace_push_keeps_blocked_origin_position_and_continues_other_origins() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let update = doc.richdoc_append_paragraph("private queued bytes");
    let op = candidate(&mut store, &observed, &update, 1);
    journal_local_replication_op(
        &mut store,
        "ws",
        "local",
        "epoch-1",
        "stream-1",
        "ydoc.update",
        &op.payload,
        10,
        &NoFaults,
    )
    .unwrap();
    // Seed a retained local-origin row: imported peer rows are not pushed.
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) VALUES ('ws','other',0,'probe.safe','{}',11,0)",
                [],
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    let client = RelaySyncClient::new(FakeRelay::default());
    let result = client
        .push_workspace(
            &mut store,
            "ws",
            &NoFaults,
            &crate::NoLiveLeases,
            12,
            1_000_000,
        )
        .unwrap();
    let SyncPassOutcome::Complete {
        owner_admission_pending,
        ..
    } = result
    else {
        panic!("push failed")
    };
    assert_eq!(owner_admission_pending.len(), 1);
    let pending = &owner_admission_pending[0];
    assert_eq!(pending.object_id, "owner");
    assert!(read_pushed_seq(&store, "ws", "local").unwrap() < pending.origin_seq);
    let pushes = client.transport().pushes.lock().unwrap();
    assert!(
        pushes
            .iter()
            .any(|p| p.origin_id == "other" && !p.ops.is_empty())
    );
    assert!(
        !pushes
            .iter()
            .flat_map(|p| &p.ops)
            .any(|p| p.payload.get("updateBlobSha256") == op.payload.get("updateBlobSha256"))
    );
}
#[test]
fn accepted_page_budget_exhaustion_is_resumable_without_pending_share() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    let first = candidate(&mut store, &observed, &checkpoint, 0);
    let second = candidate(&mut store, &observed, &checkpoint, 1);
    let budget = checkpoint.len() * 2;
    let prefix =
        owner_publication_prefix(&store, "ws", &[first, second.clone()], budget, None).unwrap();
    assert_eq!(prefix.allowed_ops, 1);
    assert!(prefix.pending.is_none());
    assert!(prefix.budget_exhausted);
    let resumed = owner_publication_prefix(&store, "ws", &[second], budget, None).unwrap();
    assert_eq!(resumed.allowed_ops, 1);
    assert!(resumed.pending.is_none());
    assert!(!resumed.budget_exhausted);
}

#[test]
fn workspace_push_reports_and_resumes_an_accepted_prefix_limited_by_proof_budget() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    for sequence in 0..2 {
        let op = candidate(&mut store, &observed, &checkpoint, sequence);
        journal_local_replication_op(
            &mut store,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "ydoc.update",
            &op.payload,
            10 + sequence,
            &NoFaults,
        )
        .unwrap();
    }
    let client = RelaySyncClient::new(FakeRelay::default());
    for (pass, expected_more) in [(0, true), (1, false)] {
        let outcome = client
            .push_workspace(
                &mut store,
                "ws",
                &NoFaults,
                &crate::NoLiveLeases,
                12 + pass,
                checkpoint.len() * 2,
            )
            .unwrap();
        let SyncPassOutcome::Complete {
            pushed,
            has_more,
            owner_admission_pending,
            ..
        } = outcome
        else {
            panic!("push did not complete");
        };
        assert_eq!(pushed, if expected_more { 2 } else { 1 });
        assert_eq!(has_more, expected_more);
        assert!(owner_admission_pending.is_empty());
        assert_eq!(read_pushed_seq(&store, "ws", "local").unwrap(), pass + 1);
    }
    let pushes = client.transport().pushes.lock().unwrap();
    let sent: Vec<_> = pushes
        .iter()
        .flat_map(|push| &push.ops)
        .map(|op| op.origin_seq)
        .collect();
    assert_eq!(sent, [0, 1, 2]);
}

/// The relay's log as it answers a resent row: it keeps its maximum, skips
/// rows it already holds, and refuses every settlement proof a push carries.
struct RelayLog {
    inner: FakeRelay,
    max: Mutex<i64>,
}

macro_rules! delegate {
    ($method:ident, $request:ty, $response:ty) => {
        fn $method(&self, request: $request) -> Result<$response, RelayError> {
            self.inner.$method(request)
        }
    };
}

impl RelayTransport for RelayLog {
    fn push(&self, req: PushRequest) -> Result<PushResponse, RelayError> {
        let mut max = self.max.lock().unwrap();
        let held = *max;
        let mut response = self.inner.push(req.clone())?;
        response.skipped = req.ops.iter().filter(|op| op.origin_seq <= held).count();
        response.inserted = req.ops.len() - response.skipped;
        response.current_max_origin_seq = req.ops.last().map_or(held, |op| op.origin_seq.max(held));
        response.settlement_refusals = req
            .ops
            .iter()
            .filter(|op| op.payload.get("settlementReference").is_some())
            .map(|op| SettlementPublicationRefusal {
                origin_id: req.origin_id.clone(),
                origin_seq: op.origin_seq,
                moment_id: op.payload["momentId"].as_str().unwrap().into(),
                settlement_id: op.payload["settlementReference"]["record"]["settlementId"]
                    .as_str()
                    .unwrap()
                    .into(),
                reason: "authorship-mismatch".into(),
            })
            .collect();
        *max = response.current_max_origin_seq;
        Ok(response)
    }
    delegate!(pull, PullRequest, PullResponse);
    delegate!(
        lookup_log_coordinate,
        LogCoordinateRequest,
        LogCoordinateResponse
    );
    delegate!(probe, ProbeRequest, ProbeResponse);
    delegate!(claim_workspace, ClaimRequest, ClaimResponse);
    delegate!(rotate_epoch, EpochRequest, EpochResponse);
    delegate!(blobs_have, BlobHaveRequest, BlobHaveResponse);
    delegate!(upload_blob, BlobUploadRequest, ());
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
}

/// A push answer that never arrived can leave the relay holding rows past a
/// later, shorter page. The relay answers refusals only for rows a push
/// carries, so the cursor must not pass a refusable save until a push that
/// carries it is answered.
#[test]
fn a_shorter_page_after_a_lost_answer_resends_the_rest_for_their_refusals() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    for sequence in 0..2 {
        let op = candidate(&mut store, &observed, &checkpoint, sequence);
        journal_local_replication_op(
            &mut store,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "ydoc.update",
            &op.payload,
            10 + sequence,
            &NoFaults,
        )
        .unwrap();
    }
    VersionedTextStore::new(&mut store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: "doc.md".into(),
                text: "accepted work".into(),
                moment_id: "moment".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 12,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            crate::journal_moment_append_in_tx(tx, "ws", "moment")
        })
        .unwrap();
    let save = list_replication_ops(&store, "ws", "local", -1, 500)
        .unwrap()
        .into_iter()
        .find(|op| op.payload["momentId"] == "moment")
        .unwrap();
    let mut proved = save.payload.clone();
    proved.as_object_mut().unwrap().remove("authors");
    proved["settlementReference"] = json!({"formatVersion":1,"recordDigest":"test","record":{"settlementId":"settlement","momentId":"moment","binding":{"workspaceId":"ws"}}});
    store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE replication_log SET payload_json=?1 WHERE workspace_id='ws' AND origin_id='local' AND origin_seq=?2",
            params![proved.to_string(), save.origin_seq]).map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    }).unwrap();
    let rollback_waits = |store: &mut EngineStore| {
        let TxnOutcome::Committed(guard) = store
            .write_with(&NoFaults, |tx| {
                Ok::<_, SyncError>(crate::rollback_waits_for_publication_in_tx(
                    tx, "ws", "moment",
                ))
            })
            .unwrap()
        else {
            panic!("no injected crash");
        };
        matches!(
            guard,
            Err(dohc_engine_domain::DomainError::RollbackWaitsForSync)
        )
    };

    let client = RelaySyncClient::new(RelayLog {
        inner: FakeRelay::default(),
        max: Mutex::new(-1),
    });
    let lost = ScriptedFaults::crash_at(FaultPoint::SyncAfterPushBeforeCursorPersist);
    assert_eq!(
        client
            .push_workspace(
                &mut store,
                "ws",
                lost.as_ref(),
                &crate::NoLiveLeases,
                13,
                8 * 1024 * 1024,
            )
            .unwrap(),
        SyncPassOutcome::CrashedAfterRemoteCommit
    );
    let pushes = || client.transport().inner.pushed_requests();
    assert!(
        pushes()
            .iter()
            .flat_map(|push| &push.ops)
            .any(|op| op.origin_seq == save.origin_seq),
        "the relay stored the save, and its answer never arrived"
    );
    let sent = pushes().len();

    // The proof budget ends this page before the save.
    let SyncPassOutcome::Complete { has_more, .. } = client
        .push_workspace(
            &mut store,
            "ws",
            &NoFaults,
            &crate::NoLiveLeases,
            14,
            checkpoint.len() * 2,
        )
        .unwrap()
    else {
        panic!("push did not complete");
    };
    assert!(has_more);
    assert!(
        pushes()[sent..]
            .iter()
            .flat_map(|push| &push.ops)
            .all(|op| op.origin_seq < save.origin_seq)
    );
    assert!(
        read_pushed_seq(&store, "ws", "local").unwrap() < save.origin_seq,
        "the cursor passed a save whose refusal never arrived"
    );
    assert!(rollback_waits(&mut store));

    let outcome = client
        .push_workspace(
            &mut store,
            "ws",
            &NoFaults,
            &crate::NoLiveLeases,
            15,
            checkpoint.len() * 2,
        )
        .unwrap();
    assert!(matches!(outcome, SyncPassOutcome::Complete { .. }));
    assert!(read_pushed_seq(&store, "ws", "local").unwrap() >= save.origin_seq);
    let fallback = list_replication_ops(&store, "ws", "local", save.origin_seq, 500)
        .unwrap()
        .into_iter()
        .find(|op| op.payload["attributionUnavailable"]["settlementId"] == "settlement")
        .expect("the authorless fallback is journaled");
    assert_eq!(fallback.payload["momentId"], "moment");
    assert!(fallback.payload.get("settlementReference").is_none());
    assert!(!rollback_waits(&mut store));
}

#[test]
fn first_accepted_operation_over_budget_returns_configuration_error() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    let op = candidate(&mut store, &observed, &checkpoint, 0);
    assert!(matches!(
        owner_publication_prefix(&store, "ws", &[op], checkpoint.len() * 2 - 1, None),
        Err(SyncError::InvalidInput {
            reason: "owner publication proof exceeds configured read budget"
        })
    ));
}

#[test]
fn kept_current_resolution_checks_each_heads_own_content() {
    use crate::conflict_resolve_v1::*;
    use dohc_engine_storage::hex_sha256;
    let (_dir, store, _observed, checkpoint) = fixture();
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let text = doc.project(ContentKind::Richdoc).unwrap().content;
    let current = HeadV1::Present(PresentHeadV1 {
        path_ref: 0,
        object_id: "owner".into(),
        latest_moment_id: "current".into(),
        content_kind: HeadContentKindV1::Text,
        blob_sha256: hex_sha256(text.as_bytes()),
        byte_length: text.len() as i64,
        updated_at_ms: 1,
    });
    let incoming = HeadV1::Present(PresentHeadV1 {
        path_ref: 0,
        object_id: "incoming-object".into(),
        latest_moment_id: "incoming".into(),
        content_kind: HeadContentKindV1::Text,
        blob_sha256: hex_sha256(b"other device"),
        byte_length: 12,
        updated_at_ms: 2,
    });
    let payload = ConflictResolveV1 {
        workspace_id: "ws".into(),
        conflict_id: "conflict".into(),
        chosen_from: ResolveChoiceV1::Current,
        resolution: ResolutionV1::KeptCurrent,
        target_version_id: "main".into(),
        source_version_id: "peer".into(),
        paths: vec!["owner.md".into()],
        current: current.clone(),
        incoming,
        result: current,
        effect_context: EffectContextV1 {
            recorded_at_ms: 3,
            metadata: MetadataV1 {
                origin: "sync".into(),
                summary: None,
                correlation_id: None,
            },
            author: None,
            current_object_created_at_ms: Some(0),
            result_object_created_at_ms: Some(0),
        },
        effects: vec![],
        lineage_transition: None,
        exported_before: None,
    };
    let built = build_conflict_resolve_v1(payload.clone()).unwrap();
    let mut op = envelope("local", 1, "conflict.resolve", built.value);
    op.recorded_at_ms = 3;
    assert_eq!(
        owner_publication_prefix(&store, "ws", &[op], 1_000_000, None)
            .unwrap()
            .allowed_ops,
        1
    );

    let mut private = payload;
    if let HeadV1::Present(head) = &mut private.current {
        head.blob_sha256 = hex_sha256(b"private owner work");
    }
    private.result = private.current.clone();
    let mut op = envelope(
        "local",
        2,
        "conflict.resolve",
        build_conflict_resolve_v1(private).unwrap().value,
    );
    op.recorded_at_ms = 3;
    assert_eq!(
        owner_publication_prefix(&store, "ws", &[op], 1_000_000, None)
            .unwrap()
            .allowed_ops,
        0
    );
}

#[test]
fn current_checkpoint_echo_requires_exact_binding_and_retained_blob_integrity() {
    use dohc_engine_collab::owner_outbox::publication::contains_observed_update_in;
    let (_dir, mut store, observed, checkpoint) = fixture();
    let key = DocKey::new("ws", "main", "owner").unwrap();
    store
        .read_with(|conn| {
            assert_eq!(
                contains_observed_update_in(
                    conn,
                    &key,
                    "owner.md",
                    &observed.binding.lineage_claim_id,
                    &checkpoint
                )
                .unwrap(),
                Some(true)
            );
            assert_eq!(
                contains_observed_update_in(
                    conn,
                    &key,
                    "other.md",
                    &observed.binding.lineage_claim_id,
                    &checkpoint
                )
                .unwrap(),
                Some(false)
            );
            assert_eq!(
                contains_observed_update_in(conn, &key, "owner.md", &"f".repeat(64), &checkpoint)
                    .unwrap(),
                Some(false)
            );
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let op = candidate(&mut store, &observed, &checkpoint, 0);
    assert_eq!(
        owner_publication_prefix(
            &store,
            "ws",
            std::slice::from_ref(&op),
            checkpoint.len() * 2,
            None
        )
        .unwrap()
        .allowed_ops,
        1
    );
    // Same declared digest and byte length, changed persisted bytes: digest-only lookup is unsafe.
    let mut corrupt = checkpoint.clone();
    corrupt[0] ^= 1;
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE binary_blobs SET bytes=?1 WHERE sha256=?2",
                rusqlite::params![corrupt, observed.checkpoint_digest],
            )
            .unwrap();
            Ok::<_, SyncError>(())
        })
        .unwrap();
    store
        .read_with(|conn| {
            assert!(
                contains_observed_update_in(
                    conn,
                    &key,
                    "owner.md",
                    &observed.binding.lineage_claim_id,
                    &checkpoint
                )
                .is_err()
            );
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let refused =
        owner_publication_prefix(&store, "ws", &[op], checkpoint.len() * 2, None).unwrap();
    assert_eq!(refused.allowed_ops, 0);
    assert!(refused.pending.is_some());
    assert!(!refused.budget_exhausted);
}

#[test]
fn reused_accepted_state_charges_a_fresh_read_and_drops_refused_bytes() {
    use dohc_engine_collab::owner_outbox::publication::{
        PublicationContentKind, PublicationProof, PublicationReader, contains_in,
    };
    let (_dir, mut store, observed, checkpoint) = fixture();
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let private = candidate(
        &mut store,
        &observed,
        &doc.richdoc_append_paragraph("private edit"),
        1,
    );
    let key = DocKey::new("ws", "main", "owner").unwrap();
    let lineage = Some(observed.binding.lineage_claim_id.as_str());
    let ydoc = PublicationContentKind::Ydoc;
    store
        .read_with(|conn| {
            let tx = conn.unchecked_transaction().map_err(SyncError::persist)?;
            let mut reader = PublicationReader::new(&tx, None);
            let mut read = |digest: &str| {
                let mut remaining = 1_000_000;
                let proof = reader
                    .contains(&key, "owner.md", lineage, ydoc, digest, &mut remaining)
                    .unwrap();
                (proof, 1_000_000 - remaining)
            };
            let first = read(&observed.checkpoint_digest);
            assert_eq!(first.0, PublicationProof::Contained);
            let reused = read(&observed.checkpoint_digest);
            let mut remaining = 1_000_000;
            let fresh = contains_in(
                &tx,
                &key,
                "owner.md",
                lineage,
                ydoc,
                &observed.checkpoint_digest,
                &mut remaining,
            )
            .unwrap();
            assert_eq!([reused, (fresh, 1_000_000 - remaining)], [first, first]);
            // A refused proof applies the private bytes to the state it read.
            let digest = private.payload["updateBlobSha256"].as_str().unwrap();
            for _ in 0..2 {
                assert_eq!(read(digest).0, PublicationProof::NotContained);
            }
            // The next proof reads afresh and charges what the first one did.
            assert_eq!(read(&observed.checkpoint_digest), first);
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

fn folder_check(store: &EngineStore, folder: &str) -> Option<crate::LivePageUnderFolder> {
    store
        .read_with(|conn| crate::live_page_under_folder(conn, "ws", "main", folder))
        .unwrap()
}

/// A page this computer owns refuses a move of any folder above it, before
/// any edit arrives, but not a move of the page itself or of a sibling that
/// shares the folder's name as a prefix.
#[test]
fn an_owned_page_refuses_a_move_of_each_folder_above_it() {
    let (_dir, store, _, _) = fixture_at("notes/box/inner/owner.md");
    for folder in ["notes/box/inner", "notes/box", "notes"] {
        assert_eq!(
            folder_check(&store, folder),
            Some(crate::LivePageUnderFolder::Owned),
            "{folder}"
        );
    }
    for path in [
        "notes/box/inner/owner.md",
        "notes/bo",
        "notes/box/in",
        "other",
    ] {
        assert_eq!(folder_check(&store, path), None, "{path}");
    }
    let (_dir, store, _, _) = fixture_at("notes/box2/owner.md");
    assert_eq!(folder_check(&store, "notes/box"), None);
}

/// The page's head is where the folder check looks, so a binding's stale
/// `currentPath` neither hides the page nor refuses a folder it left.
#[test]
fn an_owned_page_is_found_by_its_head_not_its_binding_path() {
    let (_dir, mut store, _, _) = fixture_at("notes/box/owner.md");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_owner_bindings SET binding_json=json_set(binding_json,'$.currentPath','elsewhere/owner.md')",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    assert_eq!(
        folder_check(&store, "notes/box"),
        Some(crate::LivePageUnderFolder::Owned)
    );
    assert_eq!(folder_check(&store, "elsewhere"), None);
}

/// An accepted edit installed in the owned page, but not yet settled into
/// its file, leaves the folder move refused.
#[test]
fn an_owned_page_with_an_unsaved_accepted_edit_refuses_a_folder_move() {
    let (_dir, mut store, observed, checkpoint) = fixture_at("notes/box/owner.md");
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let update = doc.richdoc_append_paragraph("collaborator edit");
    store
        .write_with(&NoFaults, |tx| {
            apply_frame_in_tx(
                tx,
                "ws",
                &OwnerAcceptedFrameInput {
                    binding: observed.binding.clone(),
                    relay_database_namespace: "relay".into(),
                    expected_revision: 1,
                    expected_native_head_sequence: observed.native_head_sequence,
                    previous_accepted_cursor: 0,
                    journal_cursor: 1,
                    update_bytes: update,
                },
                3,
            )
        })
        .unwrap();
    let accepted: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT accepted_cursor FROM ydoc_owner_bindings",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(accepted, 1, "the edit is installed");
    assert_eq!(
        folder_check(&store, "notes/box"),
        Some(crate::LivePageUnderFolder::Owned)
    );
}

/// A folder with no live page moves, and a single-path move of the owned page
/// keeps its own check, which reads only the host's activations.
#[test]
fn a_folder_without_a_live_page_moves_and_the_page_check_is_unchanged() {
    let (_dir, mut store, _, _) = fixture_at("notes/box/owner.md");
    seed_text_head(&mut store, "plain", "drafts/plain.md", "plain");
    assert_eq!(folder_check(&store, "drafts"), None);
    store
        .read_with(|conn| {
            crate::ensure_no_adopted_owner_under_path(conn, "ws", "main", "notes/box/owner.md")
        })
        .unwrap();
}

fn page_check(store: &EngineStore, path: &str) -> bool {
    store
        .read_with(|conn| crate::live_page_owned(conn, "ws", "main", path))
        .unwrap()
}

/// A page this computer owns refuses its own move, and only its own: an
/// unbound page beside it, its folder and a prefix of its path move.
#[test]
fn an_owned_page_refuses_its_own_move() {
    let (_dir, mut store, _, _) = fixture_at("notes/box/owner.md");
    seed_text_head(&mut store, "plain", "notes/box/plain.md", "plain");
    assert!(page_check(&store, "notes/box/owner.md"));
    for path in [
        "notes/box/plain.md",
        "notes/box",
        "notes/box/owner",
        "other.md",
    ] {
        assert!(!page_check(&store, path), "{path}");
    }
    assert_eq!(
        folder_check(&store, "notes/box"),
        Some(crate::LivePageUnderFolder::Owned)
    );
}

/// The page check reads the head's path, as the folder check does, so a
/// binding's stale `currentPath` neither hides the page nor refuses its old path.
#[test]
fn an_owned_page_move_is_found_by_its_head_not_its_binding_path() {
    let (_dir, mut store, _, _) = fixture_at("notes/owner.md");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_owner_bindings SET binding_json=json_set(binding_json,'$.currentPath','elsewhere/owner.md')",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    assert!(page_check(&store, "notes/owner.md"));
    assert!(!page_check(&store, "elsewhere/owner.md"));
}

/// Once Stop releases the owner binding, the page and its folder move.
#[test]
fn a_released_owned_page_moves() {
    use dohc_engine_collab::owner_outbox::release;
    let (_dir, mut store, observed, _) = fixture_at("notes/owner.md");
    let key = DocKey::new("ws", "main", "owner").unwrap();
    store
        .write_with(&NoFaults, |tx| {
            release::request_in_tx(tx, &key, 20)?;
            release::release_in_tx(
                tx,
                &observed.binding,
                Some(observed.accepted_cursor),
                None,
                21,
                |_, _, _, _, _| Ok(()),
            )
        })
        .unwrap();
    assert!(!page_check(&store, "notes/owner.md"));
    assert_eq!(folder_check(&store, "notes"), None);
}

/// A 167.1 build deleted an owner-bound page and its lineage but kept its
/// owner rows. The queued delete waited for owner admission and held back the
/// moments after it. The writable open's sweep closes the binding, and then
/// the delete, B and C publish.
#[test]
fn a_stuck_167_1_delete_and_the_moments_after_it_publish_after_the_sweep() {
    use dohc_engine_collab::owner_outbox::{
        OwnerOutboxError,
        retirement::{close_retired_in_tx, stranded_in},
    };
    let (_dir, mut store, _observed, _checkpoint) = fixture();
    let owner_text: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT blob_sha256 FROM snapshots WHERE object_id='owner'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    let journal = |store: &mut EngineStore, payload: serde_json::Value, now_ms: i64| {
        let TxnOutcome::Committed(seq) = journal_local_replication_op(
            store,
            "ws",
            "local",
            "epoch-1",
            "stream-1",
            "moment.append",
            &payload,
            now_ms,
            &NoFaults,
        )
        .unwrap() else {
            panic!("the moment must commit")
        };
        seq
    };
    let delete = journal(
        &mut store,
        json!({
            "versionId": "main", "objectId": "owner", "path": "owner.md", "operation": "delete",
            "payloadBeforePath": "owner.md", "payloadBeforeBlobSha256": owner_text,
            "payloadAfterPath": "owner.md", "payloadAfterBlobSha256": owner_text,
            "beforePath": "owner.md", "beforeBlobSha256": owner_text,
        }),
        10,
    );
    let mut later = Vec::new();
    for (object, path, text) in [("b", "notes/b.md", "# B\n"), ("c", "notes/c.md", "# C\n")] {
        let digest = seed_text_head(&mut store, object, path, text);
        later.push((
            digest.clone(),
            journal(
                &mut store,
                json!({
                    "versionId": "main", "objectId": object, "path": path, "operation": "write",
                    "payloadBeforePath": null, "payloadBeforeBlobSha256": null,
                    "payloadAfterBlobSha256": digest, "beforeBlobSha256": "",
                }),
                11,
            ),
        ));
    }
    // What the 167.1 delete left: the page and its lineage gone, its owner rows kept.
    store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "DELETE FROM ydoc_updates WHERE object_id='owner';
                 DELETE FROM ydoc_snapshots WHERE object_id='owner';
                 DELETE FROM ydoc_deferred_updates WHERE object_id='owner';
                 DELETE FROM ydoc_base_relay_candidates WHERE object_id='owner';
                 DELETE FROM ydoc_docs WHERE object_id='owner';
                 DELETE FROM snapshots WHERE object_id='owner';",
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    let client = RelaySyncClient::new(FakeRelay::default());
    let push = |store: &mut EngineStore| {
        let SyncPassOutcome::Complete {
            owner_admission_pending,
            ..
        } = client
            .push_workspace(store, "ws", &NoFaults, &crate::NoLiveLeases, 12, 1_000_000)
            .unwrap()
        else {
            panic!("push failed")
        };
        owner_admission_pending
    };
    let stuck = push(&mut store);
    assert_eq!(
        stuck
            .iter()
            .map(|pending| (pending.object_id.as_str(), pending.origin_seq))
            .collect::<Vec<_>>(),
        vec![("owner", delete)]
    );
    assert!(read_pushed_seq(&store, "ws", "local").unwrap() < delete);

    store
        .write_with(&NoFaults, |tx| {
            for key in stranded_in(tx)? {
                close_retired_in_tx(tx, &key, 20)?;
            }
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    assert!(push(&mut store).is_empty());
    assert_eq!(
        read_pushed_seq(&store, "ws", "local").unwrap(),
        later.last().unwrap().1
    );
    let pushes = client.transport().pushes.lock().unwrap();
    let published = |digest: &str| {
        pushes.iter().flat_map(|push| &push.ops).any(|op| {
            op.payload
                .get("payloadAfterBlobSha256")
                .and_then(|value| value.as_str())
                == Some(digest)
        })
    };
    assert!(
        pushes
            .iter()
            .flat_map(|push| &push.ops)
            .any(|op| op.origin_seq == delete)
    );
    for (digest, _) in &later {
        assert!(published(digest), "{digest} reaches the relay");
    }
}

/// The origin under which the relay's service host publishes a first-open base.
const FIRST_OPEN_BASE_ORIGIN: &str =
    "service-host:first-open:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/// A note whose base arrived from `origin`, and the edit this desktop then
/// queued on that base's lineage.
struct FirstOpenNote {
    _scratch: ScratchDir,
    store: EngineStore,
    lineage: String,
    edit: ReplicationEnvelope,
}

fn first_open_note(origin: &str) -> FirstOpenNote {
    let (scratch, _path, mut store) = open_store();
    seed_identity(&mut store);
    seed_replication_version(&mut store, "main", "main");
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, "From an agent")
        .unwrap();
    let lineage = store.put_binary_blob(&doc.encode_full_state()).unwrap();
    let base = envelope(
        origin,
        0,
        "ydoc.update",
        json!({
            "versionId":"main","objectId":"note","path":"notes/note.md","contentKind":"richdoc",
            "updateBlobSha256":lineage,"lineageClaimId":lineage,"isBaseState":true
        }),
    );
    let applied = apply_ydoc_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    assert!(applied.refusals.is_empty());
    let key = DocKey::new("ws", "main", "note").unwrap();
    let marker = dohc_engine_collab::read_marker(&store, &key)
        .unwrap()
        .expect("the imported base");
    assert_eq!(marker.base_origin_id.as_deref(), Some(origin));
    let update = doc.richdoc_append_paragraph("A desktop edit");
    let digest = store.put_binary_blob(&update).unwrap();
    let payload = json!({
        "versionId":"main","objectId":"note","path":"notes/note.md","contentKind":"richdoc",
        "updateBlobSha256":digest,"lineageClaimId":lineage,"isBaseState":false
    });
    let TxnOutcome::Committed(seq) = journal_local_replication_op(
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
    .unwrap() else {
        panic!("the edit must commit")
    };
    FirstOpenNote {
        _scratch: scratch,
        store,
        lineage,
        edit: envelope("local", seq, "ydoc.update", payload),
    }
}

fn prefix_under(
    store: &EngineStore,
    ops: &[ReplicationEnvelope],
    gate: Option<&OwnerGate>,
) -> OwnerPublicationPrefix {
    owner_publication_prefix(
        store,
        "ws",
        ops,
        1_000_000,
        Some(OrdinaryPublication { gate, now_ms: 20 }),
    )
    .unwrap()
}

fn waits_for_first_enrollment(note: &FirstOpenNote) -> OwnerAdmissionPending {
    OwnerAdmissionPending {
        workspace_id: "ws".into(),
        origin_id: "local".into(),
        origin_seq: note.edit.origin_seq,
        version_id: "main".into(),
        object_id: "note".into(),
        path: "notes/note.md".into(),
        reason: Some(OwnerAdmissionReason::FirstEnrollment),
    }
}

/// Whether any push so far carried `edit`'s bytes.
fn sent(client: &RelaySyncClient<FakeRelay>, edit: &ReplicationEnvelope) -> bool {
    client
        .transport()
        .pushes
        .lock()
        .unwrap()
        .iter()
        .flat_map(|push| &push.ops)
        .any(|op| op.payload.get("updateBlobSha256") == edit.payload.get("updateBlobSha256"))
}

#[test]
fn a_gated_push_holds_an_edit_to_a_first_open_note_and_sends_nothing_for_it() {
    let mut note = first_open_note(FIRST_OPEN_BASE_ORIGIN);
    let expected = waits_for_first_enrollment(&note);
    let gate = OwnerGate::default();
    let prefix = prefix_under(&note.store, std::slice::from_ref(&note.edit), Some(&gate));
    assert_eq!(prefix.allowed_ops, 0);
    assert_eq!(prefix.pending, Some(expected.clone()));

    let client = RelaySyncClient::new(FakeRelay::default());
    let outcome = client
        .resume_push_workspace(
            &mut note.store,
            "ws",
            &NoFaults,
            &crate::NoLiveLeases,
            20,
            1_000_000,
            Some(&gate),
            &mut PushWorkspaceProgress::default(),
        )
        .unwrap();
    let SyncPassOutcome::Complete {
        owner_admission_pending,
        ..
    } = outcome
    else {
        panic!("push failed")
    };
    assert_eq!(owner_admission_pending, [expected]);
    assert!(read_pushed_seq(&note.store, "ws", "local").unwrap() < note.edit.origin_seq);
    assert!(!sent(&client, &note.edit));
}

/// A member's desktop, a share view and the proposal path send no gate.
#[test]
fn an_edit_to_a_first_open_note_publishes_when_the_push_sends_no_gate() {
    let mut note = first_open_note(FIRST_OPEN_BASE_ORIGIN);
    let ops = std::slice::from_ref(&note.edit);
    assert_eq!(prefix_under(&note.store, ops, None).allowed_ops, 1);
    assert_eq!(
        owner_publication_prefix(&note.store, "ws", ops, 1_000_000, None)
            .unwrap()
            .allowed_ops,
        1
    );
    let client = RelaySyncClient::new(FakeRelay::default());
    let SyncPassOutcome::Complete {
        owner_admission_pending,
        ..
    } = client
        .push_workspace(
            &mut note.store,
            "ws",
            &NoFaults,
            &crate::NoLiveLeases,
            20,
            1_000_000,
        )
        .unwrap()
    else {
        panic!("push failed")
    };
    assert!(owner_admission_pending.is_empty());
    assert!(sent(&client, &note.edit));
}

#[test]
fn a_released_note_publishes_under_a_gate_and_only_that_note() {
    let note = first_open_note(FIRST_OPEN_BASE_ORIGIN);
    let ops = std::slice::from_ref(&note.edit);
    let released = |objects: &[&str]| OwnerGate {
        released: objects.iter().map(|object| (*object).to_owned()).collect(),
    };
    let own = prefix_under(&note.store, ops, Some(&released(&["note"])));
    assert_eq!(own.allowed_ops, 1);
    let other = prefix_under(&note.store, ops, Some(&released(&["other"])));
    assert_eq!(other.allowed_ops, 0);
    assert_eq!(other.pending, Some(waits_for_first_enrollment(&note)));
}

#[test]
fn a_stopped_note_publishes_under_a_gate() {
    let mut note = first_open_note(FIRST_OPEN_BASE_ORIGIN);
    note.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO owner_live_stops(workspace_id,main_version_id,object_id,relay_database_namespace,state,binding_json,requested_at_ms,updated_at_ms) VALUES('ws','main','note','relay','released','{}',1,1)",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .unwrap();
    let gate = OwnerGate::default();
    let prefix = prefix_under(&note.store, std::slice::from_ref(&note.edit), Some(&gate));
    assert_eq!(prefix.allowed_ops, 1);
    assert!(prefix.pending.is_none());
}

/// Only the relay's first open gates a note. A base another device published,
/// or an edit on a lineage other than the first-open base's, publishes.
#[test]
fn a_note_without_a_first_open_base_publishes_under_a_gate() {
    let gate = OwnerGate::default();
    let peer = first_open_note("peer");
    let based = prefix_under(&peer.store, std::slice::from_ref(&peer.edit), Some(&gate));
    assert_eq!(based.allowed_ops, 1);
    let note = first_open_note(FIRST_OPEN_BASE_ORIGIN);
    let mut elsewhere = note.edit.clone();
    assert_ne!(note.lineage, "f".repeat(64));
    elsewhere.payload["lineageClaimId"] = json!("f".repeat(64));
    let other = prefix_under(&note.store, &[elsewhere], Some(&gate));
    assert_eq!(other.allowed_ops, 1);
}

/// A Markdown save names the note by its text digest and carries no lineage,
/// so the gate leaves it to the existing proof.
#[test]
fn a_text_save_to_a_first_open_note_is_not_gated() {
    let note = first_open_note(FIRST_OPEN_BASE_ORIGIN);
    let saved = envelope(
        "local",
        note.edit.origin_seq + 1,
        "moment.append",
        json!({
            "versionId":"main","objectId":"note","path":"notes/note.md",
            "payloadAfterBlobSha256":dohc_engine_storage::hex_sha256(b"From an agent\n")
        }),
    );
    let gate = OwnerGate::default();
    let prefix = prefix_under(&note.store, &[saved], Some(&gate));
    assert_eq!(prefix.allowed_ops, 1);
    assert!(prefix.pending.is_none());
}

/// Under a gate, a note this desktop already delivers live keeps waiting for
/// the host to accept its bytes, with no reason.
#[test]
fn a_bound_note_under_a_gate_waits_for_the_host_without_a_reason() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let update = doc.richdoc_append_paragraph("not yet accepted");
    let op = candidate(&mut store, &observed, &update, 1);
    let gate = OwnerGate::default();
    let prefix = prefix_under(&store, std::slice::from_ref(&op), Some(&gate));
    assert_eq!(prefix.allowed_ops, 0);
    let pending = prefix.pending.expect("the edit waits");
    assert_eq!(pending.object_id, "owner");
    assert_eq!(pending.reason, None);
}

/// A note whose host checkpoint already holds an edit while the edit's own
/// entry, queued at `queued_at_ms`, waits for the host's acknowledgement, as
/// right after enrollment. Also returns the edit's ordinary op.
fn queued_edit(
    queued_at_ms: i64,
) -> (ScratchDir, EngineStore, ObservedOwnerBinding, ReplicationEnvelope) {
    let (dir, mut store, observed, checkpoint) = fixture();
    let doc = Ydoc::wire();
    doc.apply(&checkpoint).unwrap();
    let update = doc.richdoc_append_paragraph("typed while it prepared");
    let op = candidate(&mut store, &observed, &update, 0);
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_collab::owner_outbox::draft::append_draft_in_tx(
                tx,
                "ws",
                &observed.binding,
                1,
                "typed".into(),
                update.clone(),
                queued_at_ms,
            )?;
            // The host's checkpoint takes the edit before the entry's
            // acknowledgement arrives.
            apply_frame_in_tx(
                tx,
                "ws",
                &OwnerAcceptedFrameInput {
                    binding: observed.binding.clone(),
                    relay_database_namespace: "relay".into(),
                    expected_revision: 1,
                    expected_native_head_sequence: observed.native_head_sequence,
                    previous_accepted_cursor: 0,
                    journal_cursor: 1,
                    update_bytes: update.clone(),
                },
                queued_at_ms,
            )
        })
        .unwrap();
    (dir, store, observed, op)
}

/// Whether a push at `now_ms` keeps `op` back to wait for the host, which it
/// does without a reason. With no clock, as a share proposal proves, no
/// queued entry keeps it back.
fn waits_at(store: &EngineStore, op: &ReplicationEnvelope, now_ms: Option<i64>) -> bool {
    let gate = None;
    let ordinary = now_ms.map(|now_ms| OrdinaryPublication { gate, now_ms });
    let ops = std::slice::from_ref(op);
    let prefix = owner_publication_prefix(store, "ws", ops, 1_000_000, ordinary)
        .unwrap();
    match prefix.pending {
        Some(pending) => {
            assert_eq!((prefix.allowed_ops, pending.reason), (0, None));
            true
        }
        None => {
            assert_eq!(prefix.allowed_ops, 1);
            false
        }
    }
}

/// The edit waits for its own entry for two minutes after it was queued,
/// then publishes by containment. An entry dated after the push counts as
/// expired.
#[test]
fn an_edit_the_host_holds_waits_for_its_queued_entry_for_two_minutes() {
    let (_dir, store, _observed, op) = queued_edit(1_000);
    for (now_ms, waits) in [
        (1_000, true),
        (121_000, true),
        (121_001, false),
        (999, false),
    ] {
        assert_eq!(waits_at(&store, &op, Some(now_ms)), waits, "at {now_ms}");
    }
    assert!(!waits_at(&store, &op, None));
}

#[test]
fn an_edit_publishes_once_the_host_acknowledges_its_queued_entry() {
    use dohc_engine_collab::owner_outbox::{OwnerDeliveryReceipt, acknowledge};
    let (_dir, mut store, _observed, op) = queued_edit(1_000);
    assert!(waits_at(&store, &op, Some(1_000)));
    let (outbox, delivery_id, update_digest): (String, String, String) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id,delivery_id,update_digest FROM owner_ydoc_outbox_entries",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(SyncError::persist)
        })
        .unwrap();
    acknowledge(
        &mut store,
        "ws",
        &outbox,
        &[OwnerDeliveryReceipt {
            delivery_id,
            update_digest,
            journal_cursor: 1,
            accepting_host_epoch: 1,
        }],
    )
    .unwrap();
    assert!(!waits_at(&store, &op, Some(1_000)));
}

/// A restore sets aside the queue it replaces with its entries still
/// pending. A queue that was set aside keeps no edit back.
#[test]
fn an_edit_in_a_queue_a_restore_set_aside_publishes_by_containment() {
    use dohc_engine_collab::owner_outbox::{OwnerOutboxQuarantineInput, quarantine};
    let (_dir, mut store, _observed, op) = queued_edit(1_000);
    assert!(waits_at(&store, &op, Some(1_000)));
    let outbox_id: String = store
        .read_with(|conn| {
            conn.query_row("SELECT outbox_id FROM owner_ydoc_outboxes", [], |row| {
                row.get(0)
            })
            .map_err(SyncError::persist)
        })
        .unwrap();
    quarantine(
        &mut store,
        "ws",
        OwnerOutboxQuarantineInput {
            outbox_id,
            reason: "restore-fenced".into(),
            observed_binding: None,
        },
        1_000,
    )
    .unwrap();
    assert!(!waits_at(&store, &op, Some(1_000)));
}
