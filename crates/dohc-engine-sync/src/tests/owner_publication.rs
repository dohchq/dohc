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
    let prefix = owner_publication_prefix(&store, "ws", &ops, 1_000_000).unwrap();
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
        exported_before: None,
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
            let mut reader = PublicationReader::new(&tx);
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
