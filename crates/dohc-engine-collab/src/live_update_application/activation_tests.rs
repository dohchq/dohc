fn imported_fixture() -> Fixture {
    imported_source_fixture(Fixture::new())
}

fn imported_source_fixture(mut fixture: Fixture) -> Fixture {
    let payload = serde_json::json!({
        "versionId":"main", "objectId":"object", "contentKind":"richdoc", "isBaseState":true,
        "lineageClaimId":fixture.binding.lineage_claim_id,
        "updateBlobSha256":fixture.binding.lineage_claim_id,
    });
    fixture.store.write_with(&NoFaults, |tx| {
        tx.execute("DELETE FROM ydoc_owner_base_sources", []).map_err(write_sql)?;
        tx.execute("UPDATE ydoc_docs SET base_origin_id='remote',base_origin_seq=7,base_relay_seq=9", []).map_err(write_sql)?;
        tx.execute("INSERT INTO sync_relay_cursors(workspace_id,cursor,replication_epoch,stream_identity)
            VALUES('workspace','9','epoch','stream')", []).map_err(write_sql)?;
        tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported)
            VALUES('workspace','remote',7,'ydoc.update',?1,1,1)", [payload.to_string()]).map_err(write_sql)?;
        Ok::<_, ApplicationError>(())
    }).unwrap();
    fixture
}

fn capture_imported(
    f: &mut Fixture,
    max_bytes: usize,
) -> Result<ImportedOwnerActivation, ApplicationError> {
    capture_imported_owner_activation(
        &mut f.store,
        "namespace",
        &f.key,
        "owner.md",
        max_bytes,
        &NoFaults,
    )
}

#[test]
fn imported_activation_retains_original_source_without_minting_native_seed() {
    let mut f = imported_fixture();
    let first = capture_imported(&mut f, 1_000_000).unwrap();
    let replay = capture_imported(&mut f, 1_000_000).unwrap();
    assert_eq!(first.activation_id, replay.activation_id);
    assert_eq!(first.baseline_bytes, f.cut.baseline_bytes);
    assert_eq!(first.source.base_origin_id, "remote");
    assert_eq!(first.source.base_origin_seq, 7);
    assert_eq!(first.source.base_relay_seq, 9);
    assert_eq!(first.source.committed_cursor, 9);
    let seed_count: i64 = f
        .store
        .read_with(|conn| {
            conn.query_row("SELECT count(*) FROM ydoc_owner_base_sources", [], |row| {
                row.get(0)
            })
        })
        .unwrap();
    assert_eq!(seed_count, 0);
    f.cut.adoption_id = first.activation_id;
    let ack = adopt_owner_committed(
        &mut f.store,
        &f.handle,
        f.cut.clone(),
        1_000_000,
        10,
        4,
        &NoFaults,
        |_, _, _, _| Ok(()),
    )
    .unwrap();
    assert!(!ack.adoption_replayed);
    let ack = adopt_owner_committed(
        &mut f.store,
        &f.handle,
        f.cut.clone(),
        1_000_000,
        10,
        5,
        &NoFaults,
        |_, _, _, _| Ok(()),
    )
    .unwrap();
    assert!(ack.adoption_replayed);
}

#[test]
fn imported_activation_rejects_uncommitted_cursor_budget_and_changed_provenance() {
    let mut f = imported_fixture();
    assert!(capture_imported(&mut f, 1).is_err());
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE sync_relay_cursors SET cursor='8'", [])
                .map_err(write_sql)
        })
        .unwrap();
    assert!(capture_imported(&mut f, 1_000_000).is_err());
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE sync_relay_cursors SET cursor='9'", [])
                .map_err(write_sql)
        })
        .unwrap();
    f.cut.adoption_id = capture_imported(&mut f, 1_000_000).unwrap().activation_id;
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE replication_log SET imported=0", [])
                .map_err(write_sql)
        })
        .unwrap();
    assert!(adopt_owner_committed(
        &mut f.store,
        &f.handle,
        f.cut.clone(),
        1_000_000,
        10,
        4,
        &NoFaults,
        |_, _, _, _| Ok(())
    )
    .is_err());
    assert!(capture_imported(&mut f, 1_000_000).is_err());
}

#[test]
fn imported_activation_rejects_ordinary_projection_that_does_not_match_native_state() {
    let mut f = imported_fixture();
    f.doc
        .rewrite_content_to_markdown(ContentKind::Richdoc, "unsettled change")
        .unwrap();
    let update = f.doc.encode_full_state();
    f.store
        .write_with(&NoFaults, |tx| {
            durable::record_update_in_tx(tx, &f.key, &update, None, None, 4)
        })
        .unwrap();
    assert!(capture_imported(&mut f, 1_000_000).is_err());
}

/// An imported document whose file keeps a body the engine's reader holds as
/// text, such as a nested list, activates: activation compares the version's
/// file with the projection the store settles, not the strict one.
#[test]
fn imported_activation_accepts_a_file_body_the_engine_reads_as_text() {
    const NESTED: &str = "# Shared\n\n- parent\n  - nested\n";
    let mut f = imported_fixture();
    f.doc
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, NESTED)
        .unwrap();
    let projection = f.doc.project(ContentKind::Richdoc).unwrap().content;
    assert_ne!(projection, NESTED);
    assert_eq!(f.doc.preserved_markdown_source(&projection), None);
    let update = f.doc.encode_full_state();
    f.store
        .write_with(&NoFaults, |tx| {
            durable::record_update_in_tx(tx, &f.key, &update, None, None, 4)
        })
        .unwrap();
    VersionedTextStore::new(&mut f.store)
        .write_text(
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: "owner.md".into(),
                text: NESTED.into(),
                moment_id: "imported-nested".into(),
                metadata_origin: "sync".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 5,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    let captured = capture_imported(&mut f, 1_000_000).unwrap();
    assert_eq!(captured.source.source_digest, hex_sha256(NESTED.as_bytes()));
}

#[test]
fn owner_adoption_publication_failure_rolls_back_and_replay_skips_publication() {
    let mut f = Fixture::new();
    f.local_edit_before_adoption();
    let before = f.counts();
    let result = adopt_owner_committed(
        &mut f.store,
        &f.handle,
        f.cut.clone(),
        1_000_000,
        100,
        10,
        &NoFaults,
        |tx, namespace, binding, count| {
            assert_eq!(namespace, "namespace");
            assert_eq!(binding.object_id, "object");
            assert_eq!(count, 0);
            let adopted: i64 = tx
                .query_row("SELECT count(*) FROM live_owner_adoptions", [], |row| {
                    row.get(0)
                })
                .map_err(read_sql)?;
            assert_eq!(adopted, 1);
            tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported)
                VALUES('workspace','publication',0,'ydoc.update','{}',10,0)", []).map_err(write_sql)?;
            Err(ApplicationError::Conflict)
        },
    );
    assert!(result.is_err());
    assert_eq!(f.counts(), before);
    let published: i64 = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT count(*) FROM replication_log WHERE origin_id='publication'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(published, 0);
    assert!(!f.adopt().unwrap().adoption_replayed);
    let ack = adopt_owner_committed(
        &mut f.store,
        &f.handle,
        f.cut.clone(),
        1_000_000,
        100,
        11,
        &NoFaults,
        |_, _, _, _| panic!("exact adoption replay must not republish"),
    );
    assert!(ack.unwrap().adoption_replayed);
}

fn resume_imported(
    f: &mut Fixture,
    id: &str,
    max_bytes: usize,
) -> Result<ImportedOwnerActivation, ApplicationError> {
    resume_imported_owner_activation(&mut f.store, "namespace", &f.key, "owner.md", id, max_bytes)
}

#[test]
fn retained_activation_keeps_its_cut_after_the_ordinary_cursor_advances() {
    let mut f = imported_fixture();
    let captured = capture_imported(&mut f, 1_000_000).unwrap();
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE sync_relay_cursors SET cursor='10'", [])
                .map_err(write_sql)
        })
        .unwrap();
    let resumed = resume_imported(&mut f, &captured.activation_id, 1_000_000).unwrap();
    assert_eq!(resumed.activation_id, captured.activation_id);
    assert_eq!(resumed.source, captured.source);
    assert_eq!(resumed.baseline_bytes, captured.baseline_bytes);
    assert_eq!(resumed.full_state, captured.full_state);
    assert_ne!(
        capture_imported(&mut f, 1_000_000).unwrap().activation_id,
        captured.activation_id
    );
}

#[test]
fn retained_activation_reopens_after_adoption_and_a_later_native_head() {
    let mut f = imported_fixture();
    let captured = capture_imported(&mut f, 1_000_000).unwrap();
    f.cut.adoption_id = captured.activation_id.clone();
    f.adopt().unwrap();
    assert_eq!(
        resume_imported(&mut f, &captured.activation_id, 1_000_000)
            .unwrap()
            .source,
        captured.source
    );
    f.edit(true);
    let resumed = resume_imported(&mut f, &captured.activation_id, 1_000_000).unwrap();
    assert_eq!(resumed.source, captured.source);
    assert_eq!(resumed.full_state, captured.full_state);
    assert!(f.cut.expected_local_sequence > resumed.source.native_head_sequence);
}

#[test]
fn retained_activation_rejects_unadopted_native_changes_and_epoch_changes() {
    let mut f = imported_fixture();
    let captured = capture_imported(&mut f, 1_000_000).unwrap();
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE sync_relay_cursors SET replication_epoch='other'",
                [],
            )
            .map_err(write_sql)
        })
        .unwrap();
    assert!(resume_imported(&mut f, &captured.activation_id, 1_000_000).is_err());
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE sync_relay_cursors SET replication_epoch='epoch'",
                [],
            )
            .map_err(write_sql)
        })
        .unwrap();
    f.local_edit_before_adoption();
    assert!(resume_imported(&mut f, &captured.activation_id, 1_000_000).is_err());
}

#[test]
fn retained_activation_checks_saved_bytes_before_loading_them() {
    let mut f = imported_fixture();
    let captured = capture_imported(&mut f, 1_000_000).unwrap();
    assert!(matches!(
        resume_imported(&mut f, &captured.activation_id, 1),
        Err(ApplicationError::ConfiguredByteBudgetExceeded)
    ));
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_owner_activation_sources SET descriptor_json='{}'",
                [],
            )
            .map_err(write_sql)
        })
        .unwrap();
    assert!(resume_imported(&mut f, &captured.activation_id, 1_000_000).is_err());
}

#[test]
fn retained_activation_reopens_after_the_seed_application_and_outbox_ack() {
    let mut f = imported_fixture();
    f.local_edit_before_adoption();
    let text = "edited before connecting".to_owned();
    VersionedTextStore::new(&mut f.store)
        .write_text(
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: "owner.md".into(),
                text: text.clone(),
                moment_id: "imported-edit".into(),
                metadata_origin: "sync".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 4,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    let captured = capture_imported(&mut f, 1_000_000).unwrap();
    f.cut.adoption_id = captured.activation_id.clone();
    f.cut.source_moment_id = captured.source.source_moment_id.clone();
    f.cut.source_digest = captured.source.source_digest.clone();
    f.cut.source_byte_length = captured.source.source_byte_length;
    f.adopt().unwrap();
    let (outbox_id,delivery_id,digest):(String,String,String)=f.store.read_with(|conn|conn.query_row(
        "SELECT outbox_id,delivery_id,update_digest FROM owner_ydoc_outbox_entries WHERE pending=1",[],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))).unwrap();
    let receipt = LiveUpdateReceipt {
        delivery_id: delivery_id.clone(),
        update_digest: digest.clone(),
        journal_cursor: 1,
        accepting_host_epoch: 1,
    };
    let event = AdmittedLiveUpdate {
        metadata: AdmittedLiveUpdateMetadata {
            accepted: RelayAcceptedLiveUpdate {
                receipt: receipt.clone(),
                binding: f.binding.clone(),
                authority: ServerDerivedLiveUpdateAuthority::Owner {
                    principal_id: "owner".into(),
                },
                received_at_ms: 5,
            },
            first_seen: vec![],
        },
        update_bytes: captured.full_state.clone(),
    };
    let applied = apply_committed(
        &mut f.store,
        &mut WriterDocCache::new(),
        &f.handle,
        event,
        &NoFaults,
        100_000_000,
        |_, _, _, _| Ok(()),
    )
    .unwrap();
    assert!(matches!(applied, ApplicationResult::Applied(_)));
    owner_outbox::acknowledge(
        &mut f.store,
        "workspace",
        &outbox_id,
        &[owner_outbox::OwnerDeliveryReceipt {
            delivery_id,
            update_digest: digest,
            journal_cursor: 1,
            accepting_host_epoch: 1,
        }],
    )
    .unwrap();
    assert!(
        owner_outbox::read_pending(&f.store, "workspace", &outbox_id)
            .unwrap()
            .entries
            .is_empty()
    );
    let resumed = resume_imported(&mut f, &captured.activation_id, 1_000_000).unwrap();
    assert_eq!(resumed.source, captured.source);
    assert_eq!(resumed.full_state, captured.full_state);
    assert!(f.adopt().unwrap().adoption_replayed);
}

#[test]
fn accepted_owner_origin_does_not_load_retained_document_bytes() {
    use rusqlite::limits::Limit;
    let seed: Value = serde_json::from_str(include_str!(
        "../../tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let seed_bytes: Vec<u8> = serde_json::from_value(seed["bytes"].clone()).unwrap();
    let doc = Ydoc::wire();
    doc.apply(&seed_bytes).unwrap();
    doc.rewrite_content_to_markdown(
        ContentKind::Richdoc,
        &"large retained source ".repeat(8_000),
    )
    .unwrap();
    let text = doc.project(ContentKind::Richdoc).unwrap().content;
    let bytes = doc.encode_full_state();
    doc.validate_public_baseline(&bytes).unwrap();
    assert!(text.len() > 65_536 && bytes.len() > 65_536);
    let mut f = imported_source_fixture(Fixture::with_source(text, bytes));
    let captured = capture_imported(&mut f, 1_000_000).unwrap();
    f.cut.adoption_id = captured.activation_id.clone();
    f.adopt().unwrap();
    f.store
        .read_with(|conn| {
            let old_limit = conn
                .set_limit(Limit::SQLITE_LIMIT_LENGTH, 65_536)
                .expect("set sqlite length limit");
            let origin = read_origin(conn, &f.handle.registration.lock().unwrap());
            let bytes = get_binary_blob(conn, &captured.source.full_state_digest);
            conn.set_limit(Limit::SQLITE_LIMIT_LENGTH, old_limit)
                .expect("restore sqlite length limit");
            assert!(bytes.is_err(), "the limit must reject a retained blob read");
            assert!(origin.unwrap().is_some());
            Ok::<_, ApplicationError>(())
        })
        .unwrap();
}

#[test]
fn release_removes_only_the_matching_unadopted_activation_source() {
    let mut f = imported_fixture();
    let captured = capture_imported(&mut f, 1_000_000).unwrap();
    assert!(release_imported_owner_activation(
        &mut f.store,
        "other",
        "workspace",
        &captured.activation_id,
        Some((&f.key, &f.binding.lineage_claim_id)),
        &NoFaults,
    )
    .is_err());
    assert_eq!(
        f.store
            .table_row_count("ydoc_owner_activation_sources")
            .unwrap(),
        1
    );
    release_imported_owner_activation(
        &mut f.store,
        "namespace",
        "workspace",
        &captured.activation_id,
        Some((&f.key, &f.binding.lineage_claim_id)),
        &NoFaults,
    )
    .unwrap();
    assert_eq!(
        f.store
            .table_row_count("ydoc_owner_activation_sources")
            .unwrap(),
        0
    );
    assert!(resume_imported(&mut f, &captured.activation_id, 1_000_000).is_err());
    release_imported_owner_activation(
        &mut f.store,
        "namespace",
        "workspace",
        &captured.activation_id,
        None,
        &NoFaults,
    )
    .unwrap();
    assert!(release_imported_owner_activation(
        &mut f.store,
        "namespace",
        "workspace",
        &captured.activation_id,
        Some((&f.key, &f.binding.lineage_claim_id)),
        &NoFaults,
    )
    .is_err());
}

#[test]
fn release_preserves_an_adopted_activation_source() {
    let mut f = imported_fixture();
    let captured = capture_imported(&mut f, 1_000_000).unwrap();
    f.cut.adoption_id = captured.activation_id.clone();
    f.adopt().unwrap();
    assert!(release_imported_owner_activation(
        &mut f.store,
        "namespace",
        "workspace",
        &captured.activation_id,
        Some((&f.key, &f.binding.lineage_claim_id)),
        &NoFaults,
    )
    .is_err());
    assert_eq!(
        f.store
            .table_row_count("ydoc_owner_activation_sources")
            .unwrap(),
        1
    );
    assert!(resume_imported(&mut f, &captured.activation_id, 1_000_000).is_ok());
}

#[test]
fn release_is_not_blocked_by_an_adoption_in_another_lineage_or_namespace() {
    for other_lineage in [false, true] {
        let mut f = imported_fixture();
        let captured = capture_imported(&mut f, 1_000_000).unwrap();
        f.cut.adoption_id = captured.activation_id.clone();
        f.adopt().unwrap();
        f.store.write_with(&NoFaults, |tx| {
            if other_lineage {
                let lineage = dohc_engine_storage::put_binary_blob(tx, &[0, 0])?;
                tx.execute("UPDATE live_owner_adoptions SET lineage_claim_id=?1,
                    binding_json=json_set(binding_json,'$.lineageClaimId',?1)", [&lineage])
            } else {
                tx.execute("UPDATE live_owner_adoptions SET relay_database_namespace='other-namespace'", [])
            }.map_err(write_sql)
        }).unwrap();
        release_imported_owner_activation(&mut f.store, "namespace", "workspace", &captured.activation_id,
            Some((&f.key, &f.binding.lineage_claim_id)), &NoFaults).unwrap();
        assert_eq!(f.store.table_row_count("ydoc_owner_activation_sources").unwrap(), 0);
        assert_eq!(f.store.table_row_count("live_owner_adoptions").unwrap(), 1);
    }
}

#[test]
fn release_reclaims_only_an_unreferenced_captured_full_state() {
    for retain_second_capture in [false, true] {
        let mut f = imported_fixture();
        let vector = f.doc.encode_state_vector();
        f.doc
            .rewrite_content_to_markdown(ContentKind::Richdoc, "changed before capture")
            .unwrap();
        let delta = f.doc.diff(&vector).unwrap();
        f.store
            .write_with(&NoFaults, |tx| {
                durable::record_update_in_tx(tx, &f.key, &delta, None, None, 4)
            })
            .unwrap();
        VersionedTextStore::new(&mut f.store)
            .write_text(
                &WriteText {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    object_id: "object".into(),
                    path: "owner.md".into(),
                    text: "changed before capture".into(),
                    moment_id: "imported-edit".into(),
                    metadata_origin: "sync".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 4,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        let captured = capture_imported(&mut f, 1_000_000).unwrap();
        let digest = &captured.source.full_state_digest;
        assert_ne!(digest, &f.binding.lineage_claim_id);
        assert_ne!(digest, &hex_sha256(&delta));
        if retain_second_capture {
            f.store
                .write_with(&NoFaults, |tx| {
                    tx.execute("UPDATE sync_relay_cursors SET cursor='10'", [])
                        .map_err(write_sql)
                })
                .unwrap();
            let second = capture_imported(&mut f, 1_000_000).unwrap();
            assert_ne!(second.activation_id, captured.activation_id);
            assert_eq!(&second.source.full_state_digest, digest);
        }
        release_imported_owner_activation(
            &mut f.store,
            "namespace",
            "workspace",
            &captured.activation_id,
            Some((&f.key, &f.binding.lineage_claim_id)),
            &NoFaults,
        )
        .unwrap();
        assert_eq!(
            f.store.get_binary_blob(digest).unwrap().is_some(),
            retain_second_capture
        );
        assert!(f
            .store
            .get_binary_blob(&f.binding.lineage_claim_id)
            .unwrap()
            .is_some());
    }
}
