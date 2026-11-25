fn imported_fixture() -> Fixture {
    imported_source_fixture(Fixture::new())
}

fn reader_imported_fixture() -> Fixture {
    reader_fixture_case("valid")
}

#[test]
fn reader_owner_base_and_activation_hold_without_a_reader() {
    let mut f = reader_imported_fixture();
    let before = f.doc.canonical_content_sha256();
    let source = OwnerSeedSource {
        moment_id: "original".into(),
        blob_sha256: f.cut.source_digest.clone(),
    };
    assert!(matches!(
        f.store
            .write_with(&NoFaults, |tx| retain_owner_base_source_in_tx(
                tx,
                &f.key,
                "owner.md",
                &f.binding.lineage_claim_id,
                &source,
                None
            )),
        Err(CollabError::MarkdownReaderUnavailable)
    ));
    assert!(matches!(
        capture_imported(&mut f, 1_000_000),
        Err(ApplicationError::Collab(
            CollabError::MarkdownReaderUnavailable
        ))
    ));
    assert_eq!(
        f.store
            .table_row_count("ydoc_owner_activation_sources")
            .unwrap(),
        0
    );
    assert_eq!(
        f.store.table_row_count("ydoc_owner_base_sources").unwrap(),
        0
    );
    assert_eq!(
        f.store
            .read_with(|conn| durable::load_doc_in(conn, &f.key))
            .unwrap()
            .canonical_content_sha256(),
        before
    );
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
        &f.binding.current_path,
        max_bytes,
        &NoFaults,
        None,
    )
}

#[test]
fn imported_activation_retains_original_source_without_minting_native_seed() {
    let mut f = imported_fixture();
    let first = capture_imported(&mut f, 1_000_000).unwrap();
    let replay = capture_imported(&mut f, 1_000_000).unwrap();
    assert_eq!(first.activation_id, replay.activation_id);
    assert_eq!(first.baseline_bytes, f.cut.baseline_bytes);
    assert!(!first.source.reader_source);
    assert!(serde_json::to_value(&first.source)
        .unwrap()
        .get("readerSource")
        .is_none());
    assert_eq!(first.source.base_origin_id, "remote");
    assert_eq!(first.source.base_origin_seq, 7);
    assert_eq!(first.source.base_relay_seq, Some(9));
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
        None,
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
        None,
        |_, _, _, _| Ok(()),
    )
    .unwrap();
    assert!(ack.adoption_replayed);
}

#[test]
fn imported_activation_keeps_a_file_saved_without_a_final_newline() {
    for (projection, source, matches) in [
        ("# Owner note\n\nText\n", "# Owner note\n\nText", true),
        ("# Owner note\r\n\r\nText\r\n", "# Owner note\r\n\r\nText", true),
        ("Text\n", "Text\n\n", false),
        ("Text\n", "Text \n", false),
        ("Text\n", "Text\r", false),
    ] {
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, projection)
            .unwrap();
        assert_eq!(
            doc.project(ContentKind::Richdoc).unwrap().content,
            projection
        );
        assert!(doc.markdown_source_reference().is_none());
        let mut f = imported_source_fixture(Fixture::with_source(
            projection.into(),
            doc.encode_full_state(),
        ));
        let artifact = VersionedTextStore::new(&mut f.store)
            .write_text(
                &WriteText {
                    workspace_id: f.key.workspace_id.clone(),
                    version_id: f.key.version_id.clone(),
                    object_id: f.key.object_id.clone(),
                    path: f.binding.current_path.clone(),
                    text: source.into(),
                    moment_id: "without-newline".into(),
                    metadata_origin: "ydoc".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 4,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        let captured = capture_imported(&mut f, 1_000_000);
        if !matches {
            assert!(matches!(captured, Err(ApplicationError::InvalidInput(_))), "{source:?}");
            continue;
        }
        let captured = captured.unwrap();
        assert_eq!(captured.source.source_moment_id, "without-newline");
        assert_eq!(captured.source.source_digest, artifact.snapshot.blob_sha256);
        assert_eq!(captured.source.source_byte_length, source.len() as i64);
        assert_eq!(captured.baseline_bytes, f.cut.baseline_bytes);
        let resumed = resume_imported(&mut f, &captured.activation_id, 1_000_000).unwrap();
        assert_eq!(resumed.source, captured.source);
    }
}

/// A registration that serves no activation outlives Phase A. After a
/// reconnect, one could adopt the retired activation and commit an adoption
/// whose answer is withheld, so the replacement owner keeps the retired set
/// and adoption refuses before writing anything.
#[test]
fn a_retired_activation_never_adopts_after_a_reconnect() {
    let mut f = imported_fixture();
    f.cut.adoption_id = capture_imported(&mut f, 1_000_000).unwrap().activation_id;
    let coordinate = ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 1,
        instance_id: "instance".into(),
        connection_id: "connection".into(),
    };
    f._owner.retire_activation(
        &mut WriterDocCache::new(),
        "namespace",
        &coordinate,
        &f.key,
        &f.cut.adoption_id,
    );
    let mut reconnected =
        ApplicationOwner::with_retired("workspace".into(), f._owner.retired_activations())
            .unwrap();
    f.handle = reconnected
        .register(&mut f.store, "namespace".into(), coordinate, f.binding.clone())
        .unwrap();
    assert_eq!(f.handle.activation_id(), None, "it serves no activation");
    let before = f.counts();
    assert!(matches!(f.adopt(), Err(ApplicationError::Conflict)));
    assert_eq!(f.counts(), before);
    assert_eq!(f.store.table_row_count("live_owner_activations").unwrap(), 0);
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
        None,
        |_, _, _, _| Ok(())
    )
    .is_err());
    assert!(capture_imported(&mut f, 1_000_000).is_err());
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
        None,
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
        None,
        |_, _, _, _| panic!("exact adoption replay must not republish"),
    );
    assert!(ack.unwrap().adoption_replayed);
}

fn resume_imported(
    f: &mut Fixture,
    id: &str,
    max_bytes: usize,
) -> Result<ImportedOwnerActivation, ApplicationError> {
    resume_imported_owner_activation(
        &mut f.store,
        "namespace",
        &f.key,
        "owner.md",
        id,
        max_bytes,
        None,
    )
}

/// A text resolve installs its successor lineage with no base update, and the
/// marker keeps its predecessor's base coordinate.
fn resolved_fixture() -> Fixture {
    resolved_fixture_recording(&"e".repeat(64))
}

fn resolved_fixture_recording(record_tag: &str) -> Fixture {
    use yrs::updates::decoder::Decode;
    use yrs::{Map, ReadTxn, Transact};
    let seed: Value =
        serde_json::from_str(include_str!("../../tests/owner-source/owner-source-seed.json")).unwrap();
    let bytes: Vec<u8> = serde_json::from_value(seed["bytes"].clone()).unwrap();
    let doc = yrs::Doc::new();
    doc.transact_mut()
        .apply_update(yrs::Update::decode_v1(&bytes).unwrap())
        .unwrap();
    doc.get_or_insert_map(crate::ydoc::ROOT_META).insert(
        &mut doc.transact_mut(),
        crate::LINEAGE_EPOCH_META_KEY,
        "e".repeat(64),
    );
    let tagged = doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    let f = imported_source_fixture(Fixture::with_source(
        seed["markdown"].as_str().unwrap().to_owned(),
        tagged,
    ));
    resolved_from(f, record_tag)
}

fn resolved_from(mut f: Fixture, tag: &str) -> Fixture {
    let lineage = f.binding.lineage_claim_id.clone();
    let TxnOutcome::Committed(predecessor) = f
        .store
        .write_with(&NoFaults, |tx| dohc_engine_storage::put_binary_blob(tx, &[1, 0]))
        .unwrap()
    else {
        panic!("the predecessor blob is stored");
    };
    let resolve = serde_json::json!({
        "workspaceId": "workspace", "targetVersionId": "main",
        "transition": { "result": { "present": true, "objectId": "object" } },
        "lineageTransition": {
            "predecessorClaimId": predecessor,
            "successor": { "lineageClaimId": lineage, "updateBlobSha256": lineage, "contentKind": "richdoc" },
        },
    });
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE replication_log SET payload_json=json_set(payload_json,'$.lineageClaimId',?1,'$.updateBlobSha256',?1)
                WHERE origin_id='remote' AND origin_seq=7", [&predecessor]).map_err(write_sql)?;
            tx.execute("UPDATE ydoc_docs SET lineage_parent_claim_id=?1,lineage_epoch_tag=?2",
                params![predecessor, tag]).map_err(write_sql)?;
            tx.execute("INSERT INTO replication_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported)
                VALUES('workspace','resolver',3,'conflict.resolve',?1,1,1)", [resolve.to_string()]).map_err(write_sql)?;
            Ok::<_, ApplicationError>(())
        })
        .unwrap();
    f
}

#[test]
fn a_resolved_lineage_activates_from_the_resolution_that_installed_it() {
    let mut f = resolved_fixture();
    let captured = capture_imported(&mut f, 1_000_000).unwrap();
    assert_eq!(
        (
            captured.source.base_origin_id.as_str(),
            captured.source.base_origin_seq
        ),
        ("resolver", 3)
    );
    assert!(serde_json::to_value(&captured.source).unwrap()["baseRelaySeq"].is_null());
    let resumed = resume_imported(&mut f, &captured.activation_id, 1_000_000).unwrap();
    assert_eq!(resumed.source, captured.source);
    f.cut.adoption_id = captured.activation_id;
    let ack = adopt_owner_committed(
        &mut f.store,
        &f.handle,
        f.cut.clone(),
        1_000_000,
        10,
        4,
        &NoFaults,
        None,
        |_, _, _, _| Ok(()),
    )
    .unwrap();
    assert!(!ack.adoption_replayed);
}

#[test]
fn a_resolved_lineage_whose_tag_is_not_its_record_does_not_activate() {
    let mut f = resolved_fixture_recording(&"d".repeat(64));
    assert!(matches!(
        capture_imported(&mut f, 1_000_000),
        Err(ApplicationError::Collab(CollabError::LineageEpochChanged { .. }))
    ));
}

#[test]
fn a_resolved_lineage_without_its_resolution_does_not_activate() {
    let mut f = resolved_fixture();
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM replication_log WHERE op_kind='conflict.resolve'", [])
                .map_err(write_sql)
        })
        .unwrap();
    assert!(matches!(
        capture_imported(&mut f, 1_000_000),
        Err(ApplicationError::Conflict)
    ));
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
fn hosted_activation_waits_for_its_document_backfill_not_the_ordinary_cursor() {
    let mut f = imported_fixture();
    let set = |f: &mut Fixture, sql: &str| {
        f.store
            .write_with(&NoFaults, |tx| tx.execute(sql, []).map_err(write_sql))
            .unwrap();
    };
    set(&mut f, "DELETE FROM sync_relay_cursors");
    set(
        &mut f,
        "INSERT OR IGNORE INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
         VALUES ('workspace','service-host:host','epoch','stream',1)",
    );
    // The base arrived in the document's backfill, past the frozen main cursor.
    set(
        &mut f,
        "INSERT INTO hosted_replicas (workspace_id,scope_token,scope_generation,main_cursor,created_at_ms) \
         VALUES ('workspace','scope',1,4,1)",
    );
    set(
        &mut f,
        "INSERT INTO hosted_documents (workspace_id,object_id,path,state,backfill_cursor,scope_generation) \
         VALUES ('workspace','object','object.md','backfilling',9,1)",
    );
    assert!(matches!(
        capture_imported(&mut f, 1_000_000),
        Err(ApplicationError::HostedDocumentUnready)
    ));
    set(&mut f, "UPDATE hosted_documents SET state='ready'");
    let captured = capture_imported(&mut f, 1_000_000).unwrap();
    assert_eq!(captured.source.committed_cursor, 9);
    assert_eq!(
        resume_imported(&mut f, &captured.activation_id, 1_000_000)
            .unwrap()
            .source,
        captured.source
    );
    set(&mut f, "UPDATE hosted_replicas SET scope_generation=2");
    assert!(matches!(
        resume_imported(&mut f, &captured.activation_id, 1_000_000),
        Err(ApplicationError::HostedDocumentUnready)
    ));
}

/// A file written only as text has no Y.Doc to activate, so its capture says
/// so, unlike a conflict the relay retries. A hosted document that is not
/// ready, or Y.Doc input waiting for its base, may still bring a lineage, and
/// a document with one keeps its answers.
#[test]
fn a_document_without_lineage_refuses_capture_unlike_one_whose_lineage_may_arrive() {
    let mut f = imported_fixture();
    let set = |f: &mut Fixture, sql: &str| {
        f.store
            .write_with(&NoFaults, |tx| tx.execute(sql, []).map_err(write_sql))
            .unwrap();
    };
    VersionedTextStore::new(&mut f.store)
        .write_text(
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "plain".into(),
                path: "plain.md".into(),
                text: "Written as text".into(),
                moment_id: "plain-write".into(),
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
    let plain = DocKey::new("workspace", "main", "plain").unwrap();
    let capture_plain = |f: &mut Fixture| {
        capture_imported_owner_activation(
            &mut f.store,
            "namespace",
            &plain,
            "plain.md",
            1_000_000,
            &NoFaults,
            None,
        )
    };
    assert!(matches!(
        capture_plain(&mut f),
        Err(ApplicationError::LiveDocumentWithoutLineage)
    ));
    set(
        &mut f,
        "INSERT INTO ydoc_deferred_updates(workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms) \
         VALUES ('workspace','main','plain','remote',8,4)",
    );
    assert!(matches!(
        capture_plain(&mut f),
        Err(ApplicationError::Conflict)
    ));
    set(&mut f, "DELETE FROM ydoc_deferred_updates");
    set(&mut f, "DELETE FROM sync_relay_cursors");
    set(
        &mut f,
        "INSERT OR IGNORE INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
         VALUES ('workspace','service-host:host','epoch','stream',1)",
    );
    set(
        &mut f,
        "INSERT INTO hosted_replicas (workspace_id,scope_token,scope_generation,main_cursor,created_at_ms) \
         VALUES ('workspace','scope',1,9,1)",
    );
    set(
        &mut f,
        "INSERT INTO hosted_documents (workspace_id,object_id,path,state,backfill_cursor,scope_generation) \
         VALUES ('workspace','plain','plain.md','backfilling',4,1), \
                ('workspace','object','owner.md','ready',0,1)",
    );
    assert!(matches!(
        capture_plain(&mut f),
        Err(ApplicationError::HostedDocumentUnready)
    ));
    set(
        &mut f,
        "UPDATE hosted_documents SET state='ready' WHERE object_id='plain'",
    );
    assert!(matches!(
        capture_plain(&mut f),
        Err(ApplicationError::LiveDocumentWithoutLineage)
    ));
    capture_imported(&mut f, 1_000_000).unwrap();
    set(&mut f, "UPDATE ydoc_docs SET base_relay_seq=10");
    assert!(matches!(
        capture_imported(&mut f, 1_000_000),
        Err(ApplicationError::Conflict)
    ));
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
fn release_is_not_blocked_by_an_adoption_in_another_lineage_or_namespace() {
    for other_lineage in [false, true] {
        let mut f = imported_fixture();
        let captured = capture_imported(&mut f, 1_000_000).unwrap();
        f.cut.adoption_id = captured.activation_id.clone();
        f.adopt().unwrap();
        f.store.write_with(&NoFaults, |tx| {
            tx.execute_batch("PRAGMA defer_foreign_keys=ON").map_err(write_sql)?;
            for table in ["live_owner_adoptions", "live_owner_activations"] {
                if other_lineage {
                    let lineage = dohc_engine_storage::put_binary_blob(tx, &[0, 0])?;
                    tx.execute(&format!("UPDATE {table} SET lineage_claim_id=?1,
                        binding_json=json_set(binding_json,'$.lineageClaimId',?1)"), [&lineage])
                } else {
                    tx.execute(&format!("UPDATE {table} SET relay_database_namespace='other-namespace'"), [])
                }.map_err(write_sql)?;
            }
            Ok::<_, ApplicationError>(())
        }).unwrap();
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
                    text: "changed before capture\n".into(),
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

fn reader_fixture_case(case: &str) -> Fixture {
    let (bytes, text) = crate::reader_resolver::tests::original_baseline_case(case);
    imported_source_fixture(Fixture::with_source(text, bytes))
}

fn reader_resolver() -> crate::reader_resolver::ReaderResolver {
    let config =
        serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
    crate::reader_resolver::ReaderResolver::new(Arc::new(dohc_engine_reader::Reader::new(Some(
        config,
    ))))
}
fn reader_application_result<T>(
    mut action: impl FnMut() -> Result<T, ApplicationError>,
) -> Result<T, ApplicationError> {
    for _ in 0..3 {
        match action() {
            Err(ApplicationError::Collab(CollabError::MarkdownReaderPending(pending))) => {
                crate::reader_resolver::tests::run(pending.resolve())
            }
            result => return result,
        }
    }
    panic!("reader operation did not finish")
}
fn prove_owner(
    f: &mut Fixture,
    resolver: &crate::reader_resolver::ReaderResolver,
) -> Result<bool, CollabError> {
    let source = OwnerSeedSource {
        moment_id: f.cut.source_moment_id.clone(),
        blob_sha256: f.cut.source_digest.clone(),
    };
    for _ in 0..3 {
        let result = f.store.write_with(&NoFaults, |tx| {
            retain_owner_base_source_in_tx(
                tx,
                &f.key,
                "owner.md",
                &f.binding.lineage_claim_id,
                &source,
                Some(resolver),
            )
        });
        match result {
            Err(CollabError::MarkdownReaderPending(pending)) => {
                crate::reader_resolver::tests::run(pending.resolve())
            }
            other => {
                return other.map(|outcome| match outcome {
                    TxnOutcome::Committed(retained) => retained,
                    _ => panic!("crash"),
                })
            }
        }
    }
    panic!("owner proof did not settle")
}
fn prove_activation(
    f: &mut Fixture,
    resolver: &crate::reader_resolver::ReaderResolver,
) -> Result<ImportedOwnerActivation, ApplicationError> {
    for _ in 0..3 {
        match capture_imported_owner_activation(
            &mut f.store,
            "namespace",
            &f.key,
            "owner.md",
            1_000_000,
            &NoFaults,
            Some(resolver),
        ) {
            Err(ApplicationError::Collab(CollabError::MarkdownReaderPending(pending))) => {
                crate::reader_resolver::tests::run(pending.resolve())
            }
            other => return other,
        }
    }
    panic!("activation proof did not settle")
}
fn reader_fence(f: &mut Fixture) {
    f.store.write_with(&NoFaults, |tx| tx.execute("INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,input_json,receipt_json) VALUES('workspace','main','object','namespace','reader-fence',?1,'{}')",
        [serde_json::json!({"newFence":1,"oldBinding":{"lineageClaimId":f.binding.lineage_claim_id,"restoreFenceGeneration":0}}).to_string()]).map_err(write_sql)).unwrap();
}

#[test]
#[ignore = "the Rust gate's reader phase runs it with DOHC_ENGINE_READER_CONFIG"]
fn reader_owner_base_has_its_own_authority_matrix() {
    for case in ["valid", "forged", "partial", "stale"] {
        let mut f = reader_fixture_case(case);
        let resolver = reader_resolver();
        let retained = prove_owner(&mut f, &resolver).unwrap_or(false);
        assert_eq!(retained, case == "valid", "{case}");
        assert_eq!(
            f.store.table_row_count("ydoc_owner_base_sources").unwrap(),
            i64::from(case == "valid"),
            "{case}"
        );
        assert!(crate::replay_parity::structurally_equal_v2(
            &f.store
                .read_with(|conn| durable::load_doc_in(conn, &f.key))
                .unwrap(),
            &f.doc
        )
        .unwrap());
    }
    for case in ["binding", "claim", "fence", "missing"] {
        let mut f = reader_fixture_case("valid");
        let resolver = reader_resolver();
        assert!(prove_owner(&mut f, &resolver).unwrap());
        f.store.write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM ydoc_owner_base_sources", []).map_err(write_sql)?;
            match case {
                "binding" => { tx.execute("UPDATE ydoc_docs SET path='replaced.md'", []).map_err(write_sql)?; }
                "claim" => { tx.execute("UPDATE ydoc_docs SET lineage_claim_status='unclaimed',lineage_claim_id=NULL", []).map_err(write_sql)?; }
                "missing" => { f.cut.source_moment_id = "not-recorded".into(); }
                _ => {}
            }
            Ok::<_, ApplicationError>(())
        }).unwrap();
        if case == "fence" {
            reader_fence(&mut f);
        }
        assert!(!prove_owner(&mut f, &resolver).unwrap_or(false), "{case}");
        assert_eq!(
            f.store.table_row_count("ydoc_owner_base_sources").unwrap(),
            0,
            "{case}"
        );
    }
}

#[test]
#[ignore = "the Rust gate's reader phase runs it with DOHC_ENGINE_READER_CONFIG"]
fn reader_imported_activation_has_its_own_authority_matrix() {
    for case in [
        "valid",
        "forged",
        "partial",
        "stale",
        "binding",
        "claim",
        "fence",
        "missing",
        "update-first",
    ] {
        let mut f = reader_fixture_case(if ["forged", "partial", "stale"].contains(&case) {
            case
        } else {
            "valid"
        });
        let resolver = reader_resolver();
        f.store.write_with(&NoFaults, |tx| {
            match case {
                "binding" => { tx.execute("UPDATE ydoc_docs SET path='replaced.md'", []).map_err(write_sql)?; }
                "claim" => { tx.execute("UPDATE ydoc_docs SET lineage_claim_status='unclaimed',lineage_claim_id=NULL", []).map_err(write_sql)?; }
                "missing" | "update-first" => { tx.execute("DELETE FROM snapshots", []).map_err(write_sql)?; }
                _ => {}
            }
            Ok::<_, ApplicationError>(())
        }).unwrap();
        if case == "fence" {
            reader_fence(&mut f);
        }
        let captured = prove_activation(&mut f, &resolver);
        assert_eq!(captured.is_ok(), case == "valid", "{case}: {captured:?}");
        assert_eq!(
            f.store
                .table_row_count("ydoc_owner_activation_sources")
                .unwrap(),
            i64::from(case == "valid")
        );
        if case == "update-first" {
            let (bytes, source) = crate::reader_resolver::tests::witness_case("valid");
            drop(bytes);
            VersionedTextStore::new(&mut f.store)
                .write_text(
                    &WriteText {
                        workspace_id: "workspace".into(),
                        version_id: "main".into(),
                        object_id: "object".into(),
                        path: "owner.md".into(),
                        text: source,
                        moment_id: "received-later".into(),
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
            assert!(prove_activation(&mut f, &resolver).is_ok());
        }
        if case == "valid" {
            let captured = captured.unwrap();
            for _ in 0..2 {
                let result = resume_imported_owner_activation(
                    &mut f.store,
                    "namespace",
                    &f.key,
                    "owner.md",
                    &captured.activation_id,
                    1_000_000,
                    Some(&resolver),
                );
                match result {
                    Err(ApplicationError::Collab(CollabError::MarkdownReaderPending(pending))) => {
                        crate::reader_resolver::tests::run(pending.resolve())
                    }
                    other => {
                        assert_eq!(other.unwrap().full_state, captured.full_state);
                        break;
                    }
                }
            }
            f.cut.adoption_id = captured.activation_id.clone();
            assert!(matches!(
                f.adopt(),
                Err(ApplicationError::Collab(
                    CollabError::MarkdownReaderUnavailable
                ))
            ));
            for _ in 0..3 {
                match adopt_owner_committed(
                    &mut f.store,
                    &f.handle,
                    f.cut.clone(),
                    1_000_000,
                    100,
                    10,
                    &NoFaults,
                    Some(&resolver),
                    |_, _, _, _| Ok(()),
                ) {
                    Err(ApplicationError::Collab(CollabError::MarkdownReaderPending(pending))) => {
                        crate::reader_resolver::tests::run(pending.resolve())
                    }
                    other => {
                        assert!(!other.unwrap().adoption_replayed);
                        break;
                    }
                }
            }
            assert_eq!(f.store.table_row_count("live_owner_adoptions").unwrap(), 1);
            assert!(crate::replay_parity::structurally_equal_v2(
                &f.store
                    .read_with(|conn| durable::load_doc_in(conn, &f.key))
                    .unwrap(),
                &f.doc
            )
            .unwrap());
            assert!(resume_imported_owner_activation(
                &mut f.store,
                "namespace",
                &f.key,
                "owner.md",
                &captured.activation_id,
                1_000_000,
                Some(&resolver)
            )
            .is_ok());
            reader_fence(&mut f);
            assert!(resume_imported_owner_activation(
                &mut f.store,
                "namespace",
                &f.key,
                "owner.md",
                &captured.activation_id,
                1_000_000,
                Some(&resolver)
            )
            .is_err());
        }
    }
}

#[test]
#[ignore = "the Rust gate's reader phase runs it with DOHC_ENGINE_READER_CONFIG"]
fn reader_resume_and_adoption_recheck_mutable_authority() {
    for case in ["binding", "claim", "fence", "missing", "self-anchor"] {
        let mut f = reader_fixture_case("valid");
        let resolver = reader_resolver();
        let captured = prove_activation(&mut f, &resolver).unwrap();
        f.cut.adoption_id = captured.activation_id.clone();
        f.store.write_with(&NoFaults, |tx| {
            match case {
                "binding" => { tx.execute("UPDATE ydoc_docs SET path='replaced.md'", []).map_err(write_sql)?; }
                "claim" => { tx.execute("UPDATE ydoc_docs SET lineage_claim_status='unclaimed',lineage_claim_id=NULL", []).map_err(write_sql)?; }
                "missing" => { tx.execute("DELETE FROM snapshots", []).map_err(write_sql)?; }
                "self-anchor" => { tx.execute("UPDATE moments SET path='other.md'", []).map_err(write_sql)?; }
                _ => {}
            }
            Ok::<_, ApplicationError>(())
        }).unwrap();
        if case == "fence" {
            reader_fence(&mut f);
        }
        assert!(
            reader_application_result(|| resume_imported_owner_activation(
                &mut f.store,
                "namespace",
                &f.key,
                "owner.md",
                &captured.activation_id,
                1_000_000,
                Some(&resolver)
            ))
            .is_err(),
            "resume {case}"
        );
        assert!(
            reader_application_result(|| adopt_owner_committed(
                &mut f.store,
                &f.handle,
                f.cut.clone(),
                1_000_000,
                100,
                10,
                &NoFaults,
                Some(&resolver),
                |_, _, _, _| Ok(())
            ))
            .is_err(),
            "adoption {case}"
        );
        assert_eq!(
            f.store.table_row_count("live_owner_adoptions").unwrap(),
            0,
            "{case}"
        );
    }
}
