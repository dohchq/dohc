use super::*;
use dohc_engine_collab::{
    ContentKind, DocKey, Ydoc,
    owner_outbox::{
        OwnerOutboxLimits,
        accepted::{OwnerAcceptedFrameInput, apply_frame_in_tx},
        draft::{ObservedOwnerBinding, install_observed_binding_in_tx},
    },
};

pub(super) fn fixture() -> (ScratchDir, EngineStore, ObservedOwnerBinding, Vec<u8>) {
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
        "owner.md",
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
            current_path: "owner.md".into(),
            selector_paths: vec!["owner.md".into()],
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
            tx.execute("UPDATE ydoc_docs SET path='owner.md'", [])
                .unwrap();
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
    let prefix = owner_publication_prefix(&store, "ws", &ops, 1_000_000).unwrap();
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
        owner_publication_prefix(&store, "ws", &ops, 1_000_000)
            .unwrap()
            .allowed_ops,
        3
    );
    assert_eq!(
        owner_publication_prefix(&store, "ws", &ops, 0)
            .unwrap()
            .allowed_ops,
        1
    );
    let mut named = op;
    named.payload["versionId"] = json!("independent-version");
    assert_eq!(
        owner_publication_prefix(&store, "ws", &[named], 0)
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
        owner_publication_prefix(&store, "ws", &[moment], 1_000_000)
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
        owner_publication_prefix(&store, "ws", &[fork], 1_000_000)
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
        owner_publication_prefix(&store, "ws", std::slice::from_ref(&op), 1_000_000)
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
        owner_publication_prefix(&store, "ws", &[op], 1_000_000)
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
    let prefix = owner_publication_prefix(&store, "ws", &[first, second.clone()], budget).unwrap();
    assert_eq!(prefix.allowed_ops, 1);
    assert!(prefix.pending.is_none());
    assert!(prefix.budget_exhausted);
    let resumed = owner_publication_prefix(&store, "ws", &[second], budget).unwrap();
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

#[test]
fn first_accepted_operation_over_budget_returns_configuration_error() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    let op = candidate(&mut store, &observed, &checkpoint, 0);
    assert!(matches!(
        owner_publication_prefix(&store, "ws", &[op], checkpoint.len() * 2 - 1),
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
    };
    let built = build_conflict_resolve_v1(payload.clone()).unwrap();
    let mut op = envelope("local", 1, "conflict.resolve", built.value);
    op.recorded_at_ms = 3;
    assert_eq!(
        owner_publication_prefix(&store, "ws", &[op], 1_000_000)
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
        owner_publication_prefix(&store, "ws", &[op], 1_000_000)
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
            checkpoint.len() * 2
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
    let refused = owner_publication_prefix(&store, "ws", &[op], checkpoint.len() * 2).unwrap();
    assert_eq!(refused.allowed_ops, 0);
    assert!(refused.pending.is_some());
    assert!(!refused.budget_exhausted);
}
