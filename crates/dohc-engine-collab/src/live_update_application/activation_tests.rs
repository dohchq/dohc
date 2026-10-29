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

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_owner_base_and_activation_revalidate_their_snapshot() {
    let mut f = reader_imported_fixture();
    let config =
        serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
    let resolver = crate::reader_resolver::ReaderResolver::new(Arc::new(
        dohc_engine_reader::Reader::new(Some(config)),
    ));
    let captured = loop {
        match capture_imported_owner_activation(
            &mut f.store,
            "namespace",
            &f.key,
            "owner.md",
            1_000_000,
            &NoFaults,
            Some(&resolver),
        ) {
            Err(ApplicationError::Collab(CollabError::MarkdownReaderPending(pending))) => {
                crate::reader_resolver::tests::run(pending.resolve())
            }
            other => break other.unwrap(),
        }
    };
    assert!(captured.source.reader_source);
    assert_eq!(captured.source.source_digest, f.cut.source_digest);
    assert!(matches!(
        resume_imported(&mut f, &captured.activation_id, 1_000_000),
        Err(ApplicationError::Collab(
            CollabError::MarkdownReaderUnavailable
        ))
    ));
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

/// Opus's round 3a note: a registration that serves no activation outlives
/// Phase A, and after a reconnect one could adopt the retired activation,
/// committing an adoption whose answer is withheld. The replacement owner
/// keeps the retired set, and adoption refuses before writing anything.
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

#[test]
fn imported_activation_accepts_a_file_body_the_engine_reads_as_text() {
    const SOURCE: &str = "# Shared\n\nHello <b>hidden</b> world\n";
    let mut f = imported_fixture();
    f.doc
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, SOURCE)
        .unwrap();
    let projection = f.doc.project(ContentKind::Richdoc).unwrap().content;
    assert_ne!(projection, SOURCE);
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
                text: SOURCE.into(),
                moment_id: "imported-literal-html".into(),
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
    assert_eq!(captured.source.source_digest, hex_sha256(SOURCE.as_bytes()));
}

#[test]
fn imported_activation_rejects_main_era_flattened_nested_list_witness() {
    const SOURCE: &str = "- parent\n  - nested\n";
    let mut f = imported_fixture();
    f.doc = crate::ydoc::main_era_flattened_list_for_test(SOURCE);
    let projection = f.doc.project(ContentKind::Richdoc).unwrap().content;
    assert_ne!(projection, SOURCE);
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
                text: SOURCE.into(),
                moment_id: "imported-flattened-list".into(),
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
    // A document that left the scope stops activating, ready or not.
    set(&mut f, "UPDATE hosted_replicas SET scope_generation=2");
    assert!(matches!(
        resume_imported(&mut f, &captured.activation_id, 1_000_000),
        Err(ApplicationError::HostedDocumentUnready)
    ));
}

/// The relay waits for a document that is not ready and stops resuming one
/// that diverged, so a held document's resume says it is unready even when
/// its state no longer matches the retained activation, and a ready
/// document whose state diverged keeps the conflict.
#[test]
fn a_held_documents_resume_is_unready_and_a_ready_divergence_conflicts() {
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
    set(
        &mut f,
        "INSERT INTO hosted_replicas (workspace_id,scope_token,scope_generation,main_cursor,created_at_ms) \
         VALUES ('workspace','scope',1,9,1)",
    );
    set(
        &mut f,
        "INSERT INTO hosted_documents (workspace_id,object_id,path,state,scope_generation) \
         VALUES ('workspace','object','object.md','ready',1)",
    );
    let captured = capture_imported(&mut f, 1_000_000).unwrap();
    // The document's base no longer matches the activation's.
    set(&mut f, "UPDATE ydoc_docs SET base_relay_seq=8");
    set(
        &mut f,
        "UPDATE hosted_documents SET state='held',held_reason='hosted-backfill-work-waiting'",
    );
    assert!(matches!(
        resume_imported(&mut f, &captured.activation_id, 1_000_000),
        Err(ApplicationError::HostedDocumentUnready)
    ));
    set(
        &mut f,
        "UPDATE hosted_documents SET state='ready',held_reason=NULL",
    );
    assert!(matches!(
        resume_imported(&mut f, &captured.activation_id, 1_000_000),
        Err(ApplicationError::Conflict)
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
    // The document with a lineage still activates, and its base past the
    // committed position is still a conflict.
    capture_imported(&mut f, 1_000_000).unwrap();
    set(&mut f, "UPDATE ydoc_docs SET base_relay_seq=10");
    assert!(matches!(
        capture_imported(&mut f, 1_000_000),
        Err(ApplicationError::Conflict)
    ));
}

/// A store that does not hold the retained activation, as one an identity
/// change selected, refuses its resume as a conflict, so the relay stops
/// resuming it instead of retrying an internal error.
#[test]
fn a_store_without_the_retained_activation_refuses_its_resume_as_a_conflict() {
    let mut f = imported_fixture();
    let captured = capture_imported(&mut f, 1_000_000).unwrap();
    let other = format!("ordinary-activation-{}", "0".repeat(64));
    assert!(matches!(
        resume_imported(&mut f, &other, 1_000_000),
        Err(ApplicationError::Conflict)
    ));
    assert_eq!(
        resume_imported(&mut f, &captured.activation_id, 1_000_000)
            .unwrap()
            .activation_id,
        captured.activation_id
    );
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
            canonical_version: None,
            author_snapshot: None,
            first_seen_deletes: None,
            checkpoint_coverage: None,
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
    assert!(matches!(applied, ApplicationResult::Applied(..)));
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

fn reader_fixture_case(case: &str) -> Fixture {
    let (bytes, text) = crate::reader_resolver::tests::original_baseline_case(case);
    imported_source_fixture(Fixture::with_source(text, bytes))
}

#[test]
fn reader_activation_validates_before_requesting_proof() {
    let (bytes, text) = crate::reader_resolver::tests::original_baseline_case("valid");
    let bytes = crate::reader_resolver::tests::baseline_with_meta(&bytes, "foreign");
    let mut f = imported_source_fixture(Fixture::with_source(text, bytes));
    let reader = Arc::new(dohc_engine_reader::Reader::new(None));
    let resolver = crate::reader_resolver::ReaderResolver::new(reader.clone());
    let result = capture_imported_owner_activation(&mut f.store, "namespace", &f.key, "owner.md", 1_000_000, &NoFaults, Some(&resolver));
    assert!(matches!(result, Err(ApplicationError::Collab(CollabError::MalformedUpdate { .. }))), "{result:?}");
    assert_eq!(reader.dispatch_count(), 0);
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_activation_reuses_proof_after_unrelated_relay_progress() {
    let mut f = reader_fixture_case("valid");
    let config = serde_json::from_str(&std::env::var("DOHC_ENGINE_READER_CONFIG").unwrap()).unwrap();
    let reader = Arc::new(dohc_engine_reader::Reader::new(Some(config)));
    let resolver = crate::reader_resolver::ReaderResolver::new(reader.clone());
    let result = capture_imported_owner_activation(&mut f.store, "namespace", &f.key, "owner.md", 1_000_000, &NoFaults, Some(&resolver));
    let Err(ApplicationError::Collab(CollabError::MarkdownReaderPending(pending))) = result else { panic!("expected proof miss"); };
    crate::reader_resolver::tests::run(pending.resolve());
    assert_eq!(reader.dispatch_count(), 1);
    f.store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE sync_relay_cursors SET cursor='10'", []).map_err(write_sql)?;
        Ok::<_, ApplicationError>(())
    }).unwrap();
    let captured = capture_imported_owner_activation(&mut f.store, "namespace", &f.key, "owner.md", 1_000_000, &NoFaults, Some(&resolver)).unwrap();
    assert_eq!(captured.source.committed_cursor, 10);
    assert_eq!(reader.dispatch_count(), 1);
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_activation_and_adoption_reject_receipts_without_reader_source() {
    let mut f = reader_fixture_case("valid");
    let resolver = reader_resolver();
    let captured = prove_activation(&mut f, &resolver).unwrap();
    let mut legacy = captured.source;
    legacy.reader_source = false;
    let json = serde_json::to_string(&legacy).unwrap();
    assert!(!json.contains("readerSource"));
    let id = format!("ordinary-activation-{}", hex_sha256(json.as_bytes()));
    f.store.write_with(&NoFaults, |tx| {
        tx.execute("UPDATE ydoc_owner_activation_sources SET activation_id=?1,descriptor_json=?2", params![id,json]).map_err(write_sql)?;
        Ok::<_, ApplicationError>(())
    }).unwrap();
    assert!(matches!(resume_imported(&mut f, &id, 1_000_000), Err(ApplicationError::Conflict)));
    f.cut.adoption_id = id;
    assert!(matches!(f.adopt(), Err(ApplicationError::Conflict)));
    assert_eq!(f.store.table_row_count("live_owner_adoptions").unwrap(), 0);
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_adoption_validates_the_receipts_reader_baseline() {
    let mut f = reader_fixture_case("valid");
    let resolver = reader_resolver();
    let captured = prove_activation(&mut f, &resolver).unwrap();
    assert!(captured.source.reader_source);
    let baseline = Ydoc::wire();
    baseline.apply(&f.cut.baseline_bytes).unwrap();
    assert!(baseline.validate_public_baseline(&f.cut.baseline_bytes).is_err());
    f.cut.adoption_id = captured.activation_id;
    reader_application_result(|| adopt_owner_committed(
        &mut f.store, &f.handle, f.cut.clone(), 1_000_000, 100, 10,
        &NoFaults, Some(&resolver), |_, _, _, _| Ok(()),
    )).unwrap();
    assert_eq!(f.store.table_row_count("live_owner_adoptions").unwrap(), 1);
}

#[test]
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
fn reader_restore_can_fence_before_lazy_proof_dispatch() {
    let mut f = reader_fixture_case("valid");
    let resolver = Arc::new(reader_resolver());
    let captured = prove_activation(&mut f, &resolver).unwrap();
    f.cut.adoption_id = captured.activation_id;
    reader_application_result(|| adopt_owner_committed(&mut f.store, &f.handle, f.cut.clone(), 1_000_000, 100, 10, &NoFaults, Some(&resolver), |_, _, _, _| Ok(()))).unwrap();
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    let operation = NativeRestoreFence {
        point: crate::live_update_application::NativeRestoreSelection { journal_cursor: 0, receipt_digest: f.binding.lineage_claim_id.clone() },
            operation_id: "reader-restore".into(), relay_database_namespace: "namespace".into(),
        old_binding: f.binding.clone(), host_id: "host".into(), new_fence: 1,
        origin: RestoreDeliveryOrigin::Owner { id: f.cut.adoption_id.clone() },
        terminal: None, applied_sequence: 0,
    };
    let mut receipt = None;
    for reconnect in [false, true] {
        let result = if reconnect {
            f._owner.fence_restore_after_reconnect(&mut f.store, Some(&resolver), operation.clone(), coordinate.clone(), 20, &NoFaults)
        } else {
            f._owner.fence_restore(&mut f.store, Some(&resolver), operation.clone(), coordinate.clone(), 20, &NoFaults)
        };
        let result = result.unwrap();
        if let Some(previous) = &receipt { assert_eq!(previous, &result); }
        receipt = Some(result);
        assert_eq!(f.store.table_row_count("live_restore_fences").unwrap(), 1);
        assert!(!f.handle.registration.lock().unwrap().live);
    }
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
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
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
        // Populate a successful cache entry, then change mutable authority.
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
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
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
#[ignore = "requires DOHC_ENGINE_READER_CONFIG for the real staged bundle"]
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
        // Neither a capture receipt nor a cached verdict replaces current authority.
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
