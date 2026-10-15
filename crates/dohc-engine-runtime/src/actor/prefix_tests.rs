use dohc_engine_collab::owner_outbox::{OwnerOutboxLimits, draft, prefix, release};

fn native_prefix_fixture() -> (
    ScratchDir,
    std::path::PathBuf,
    EngineStore,
    draft::ObservedOwnerBinding,
    dohc_engine_collab::Ydoc,
) {
    native_prefix_fixture_with_collection(false)
}

fn native_prefix_fixture_with_collection(
    collection: bool,
) -> (
    ScratchDir,
    std::path::PathBuf,
    EngineStore,
    draft::ObservedOwnerBinding,
    dohc_engine_collab::Ydoc,
) {
    let (root, path, mut store) = dohc_engine_testkit::open_store();
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let mut bytes: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
    let mut text = fixture["markdown"].as_str().unwrap().to_owned();
    let path_name = if collection {
        "tasks/owner.md"
    } else {
        "owner.md"
    };
    if collection {
        let seeded = dohc_engine_collab::Ydoc::wire();
        seeded.apply(&bytes).unwrap();
        seeded
            .frontmatter_set("id", "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa")
            .unwrap();
        seeded.frontmatter_set("title", "Original").unwrap();
        seeded.frontmatter_set("status", "open").unwrap();
        bytes = seeded.encode_full_state();
        text = seeded.project(ContentKind::Richdoc).unwrap().content;
        std::fs::create_dir_all(root.join("tasks")).unwrap();
    }
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 0, &NoFaults)
        .unwrap();
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: path_name.into(),
                text: text.clone(),
                moment_id: "original".into(),
                metadata_origin: "user".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    if collection {
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .write_text(
                &dohc_engine_domain::WriteText {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    object_id: "schema".into(),
                    path: "tasks/collection.yaml".into(),
                    text: "fields:\n  title:\n    type: text\n  status:\n    type: text\n".into(),
                    moment_id: "schema".into(),
                    metadata_origin: "user".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_domain::reconcile_collections_in_tx(tx, "workspace", "main")
            })
            .unwrap();
    }
    std::fs::write(root.join(path_name), text).unwrap();
    let key = DocKey::new("workspace", "main", "object").unwrap();
    dohc_engine_collab::claim_base(&mut store, &key, ContentKind::Richdoc, &bytes, &NoFaults, 2)
        .unwrap();
    store.write_with(&NoFaults,|tx|{
        tx.execute("UPDATE ydoc_docs SET path=?1",[path_name]).map_err(StorageError::persist_public)?;
        tx.execute("INSERT INTO sync_identity(workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES('workspace','local','epoch','stream',0)",[]).map_err(StorageError::persist_public)?;
        Ok::<_,StorageError>(())
    }).unwrap();
    let marker = dohc_engine_collab::read_marker(&store, &key)
        .unwrap()
        .unwrap();
    let doc = dohc_engine_collab::load_persisted(&store, &key)
        .unwrap()
        .unwrap()
        .doc;
    let checkpoint = doc.encode_full_state();
    let observed = draft::ObservedOwnerBinding {
        binding: dohc_engine_collab::LiveObjectBinding {
            workspace_id: "workspace".into(),
            main_version_id: "main".into(),
            object_id: "object".into(),
            lineage_claim_id: hex_sha256(&bytes),
            current_path: path_name.into(),
            selector_paths: vec![path_name.into()],
            restore_fence_generation: 0,
        },
        relay_database_namespace: "relay".into(),
        revision: 1,
        accepted_cursor: 0,
        native_head_sequence: marker.head_update_seq,
        checkpoint_digest: hex_sha256(&checkpoint),
        limits: OwnerOutboxLimits {
            max_pending_bytes: 64 * 1024 * 1024,
            max_pending_age_ms: 60_000,
        },
    };
    store
        .write_with(&NoFaults, |tx| {
            draft::install_observed_binding_in_tx(tx, "workspace", &observed, &checkpoint)
        })
        .unwrap();
    (root, path, store, observed, doc)
}

fn prepare_native_prefix(store: &mut EngineStore, observed: &draft::ObservedOwnerBinding) {
    let key = DocKey::new("workspace", "main", "object").unwrap();
    store
        .write_with(&NoFaults, |tx| {
            release::request_in_tx(tx, &key, 4)?;
            prefix::seal_in_tx(tx, &observed.binding, &"c".repeat(64), 0, 5)
        })
        .unwrap();
}

#[test]
fn native_prefix_unchanged_projection_records_credit_once() {
    let (root, _path, mut store, observed, _) = native_prefix_fixture();
    let mut cache = WriterDocCache::new();
    draft::append_draft_cached(
        &mut store,
        &mut cache,
        "workspace",
        draft::OwnerDraftAppendInput {
            person_edit: false,
            binding: observed.binding.clone(),
            expected_revision: 1,
            append_key: "noop-credit".into(),
            update: vec![0, 0],
            now_ms: 3,
            agent_declaration: Some(dohc_engine_domain::AgentDeclaration {
                agent_id: "noop-agent".into(),
                on_behalf_of: Some("person".into()),
                depth: 1,
            }),
            automation_declaration: None,
        },
        &NoFaults,
    )
    .unwrap();
    prepare_native_prefix(&mut store, &observed);
    commit_native_prefix(&mut store, &mut cache, &observed, &NoFaults).unwrap();
    settle_native_prefix(&mut store, &mut cache, &root, &observed, &NoFaults).unwrap();

    // Reopen the same projected moment through the write path. This models a
    // replay after the durable frontier marker was cleared: the moment ID is
    // unchanged, so the projected write is deduped and the prefix journal
    // guard is the only thing keeping replication at one row.
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE snapshots SET latest_moment_id='original' WHERE workspace_id='workspace' AND version_id='main' AND object_id='object'",
                [],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "UPDATE ydoc_docs SET settled_update_seq=0 WHERE workspace_id='workspace' AND version_id='main' AND object_id='object'",
                [],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute("DELETE FROM materialization_jobs WHERE job_id LIKE 'ydoc-mat_%'", [])
                .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .unwrap();
    settle_native_prefix(&mut store, &mut cache, &root, &observed, &NoFaults).unwrap();
    let credit: Vec<Option<String>> = store
        .read_with(|c| {
            let mut stmt =
                c.prepare("SELECT author_json FROM moments WHERE metadata_origin='ydoc'")?;
            stmt.query_map([], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    assert_eq!(credit.len(), 1);
    assert!(credit.iter().flatten().any(|author| author.contains("noop-agent")));
    assert_eq!(
        store
            .read_with(|c| c.query_row(
                "SELECT COUNT(*) FROM replication_log WHERE op_kind='moment.append'",
                [],
                |r| r.get::<_, i64>(0),
            ))
            .unwrap(),
        1,
        "a deduped prefix moment must be journaled once"
    );
}

#[test]
fn native_prefix_refuses_an_external_coordinate_without_this_release_tag() {
    let (_root, _path, mut store, observed, doc) = native_prefix_fixture();
    let mut cache = WriterDocCache::new();
    draft::append_draft_cached(
        &mut store,
        &mut cache,
        "workspace",
        draft::OwnerDraftAppendInput {
            person_edit: true,
            binding: observed.binding.clone(),
            expected_revision: 1,
            append_key: "foreign-coordinate".into(),
            update: doc.richdoc_append_paragraph("foreign coordinate"),
            now_ms: 3,
            agent_declaration: None,
            automation_declaration: None,
        },
        &NoFaults,
    )
    .unwrap();
    prepare_native_prefix(&mut store, &observed);
    let foreign_payload = serde_json::json!({
        "release": prefix::publication_tag(&observed.binding, &"d".repeat(64))
    });
    let foreign_seq = match store
        .write_with(&NoFaults, |tx| {
            dohc_engine_sync::journal_local_op_in_tx(
                tx,
                "workspace",
                "ydoc.update",
                &foreign_payload,
                4,
            )
            .map_err(StorageError::persist_public)
        })
        .unwrap()
    {
        TxnOutcome::Committed(seq) => seq,
        _ => panic!("unexpected journal crash"),
    };
    let result = prefix::commit_prefix(
        &mut store,
        &mut cache,
        &observed.binding,
        &"c".repeat(64),
        6,
        &NoFaults,
        |_, _, _, _| Ok(Some(("local".into(), foreign_seq, false))),
    );
    assert!(matches!(result, Err(OwnerOutboxError::Corrupt)));
    assert_eq!(
        store
            .read_with(|c| prefix::progress_in(
                c,
                &DocKey::new("workspace", "main", "object").unwrap()
            ))
            .unwrap()
            .unwrap()
            .consumed_entries,
        0
    );
}

#[test]
fn native_prefix_fresh_journal_coordinate_is_tagged_before_the_check_is_skipped() {
    let (_root, _path, mut store, observed, doc) = native_prefix_fixture();
    let mut cache = WriterDocCache::new();
    draft::append_draft_cached(
        &mut store,
        &mut cache,
        "workspace",
        draft::OwnerDraftAppendInput {
            person_edit: true,
            binding: observed.binding.clone(),
            expected_revision: 1,
            append_key: "fresh-coordinate".into(),
            update: doc.richdoc_append_paragraph("fresh coordinate"),
            now_ms: 3,
            agent_declaration: None,
            automation_declaration: None,
        },
        &NoFaults,
    )
    .unwrap();
    prepare_native_prefix(&mut store, &observed);
    prefix::reset_tag_check_metrics_for_test();
    let mut callback_result = None;
    let result = prefix::commit_prefix(
        &mut store,
        &mut cache,
        &observed.binding,
        &"c".repeat(64),
        6,
        &NoFaults,
        |tx, bytes, actor, attribution| {
            let result = dohc_engine_sync::journal_prefix_update_in_tx(
                tx,
                &observed.binding,
                bytes,
                actor,
                attribution,
                6,
            )
            .map_err(|e| CollabError::Storage(StorageError::persist_public(e)))?;
            if let Some((origin, seq, wrote)) = &result {
                assert!(*wrote);
                let payload: String = tx
                    .query_row(
                        "SELECT payload_json FROM replication_log WHERE workspace_id='workspace' AND origin_id=?1 AND origin_seq=?2",
                        rusqlite::params![origin, seq],
                        |r| r.get(0),
                    )
                    .map_err(|e| CollabError::Storage(StorageError::persist_public(e)))?;
                let payload: serde_json::Value = serde_json::from_str(&payload)
                    .map_err(|e| CollabError::Storage(StorageError::persist_public(e)))?;
                assert_eq!(payload.get("release"), Some(&prefix::publication_tag(
                    &observed.binding,
                    &"c".repeat(64),
                )));
            }
            callback_result = result.clone();
            Ok(result)
        },
    )
    .unwrap();
    assert!(matches!(result, TxnOutcome::Committed(p) if p.consumed_entries == 1));
    assert!(callback_result.is_some());
    assert_eq!(prefix::tag_check_metrics_for_test().0, 0);
}

#[test]
fn native_prefix_partial_history_keeps_the_complete_collection_index() {
    let (root, path, mut store, observed, doc) = native_prefix_fixture_with_collection(true);
    let mut cache = WriterDocCache::new();
    for i in 0..41 {
        draft::append_draft_cached(
            &mut store,
            &mut cache,
            "workspace",
            draft::OwnerDraftAppendInput {
                binding: observed.binding.clone(),
                expected_revision: 1,
                append_key: format!("collection-{i}"),
                update: if i == 40 {
                    doc.frontmatter_set("status", "done").unwrap()
                } else {
                    doc.richdoc_append_paragraph(&format!("body {i}"))
                },
                person_edit: i != 40,
                agent_declaration: (i == 40).then(|| dohc_engine_domain::AgentDeclaration {
                    agent_id: "field-agent".into(),
                    on_behalf_of: Some("person".into()),
                    depth: 2,
                }),
                automation_declaration: None,
                now_ms: 3,
            },
            &NoFaults,
        )
        .unwrap();
    }
    prepare_native_prefix(&mut store, &observed);
    let indexed = |store: &EngineStore| {
        store
            .read_with(|c| {
                dohc_engine_domain::collections::indexed_collection_record_frontmatter_in_tx(
                    c,
                    "workspace",
                    "main",
                    "object",
                )
            })
            .unwrap()
            .unwrap()
    };
    let history = |store: &EngineStore| {
        store.read_with(|c| {
        let mut q = c.prepare("SELECT field_name,previous_value_json,next_value_json,author_origin_id FROM collection_field_history ORDER BY history_id")?;
        q.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?)))?.collect::<Result<Vec<_>,_>>()
    }).unwrap()
    };
    let expected = serde_json::json!({"title":"Original","status":"done"});
    let original_history = history(&store);
    assert!(
        original_history
            .iter()
            .any(|r| r.0 == "status" && r.3.as_deref() == Some("field-agent"))
    );
    assert_eq!(indexed(&store), expected);
    for through in [32, 41] {
        let result = commit_native_prefix(&mut store, &mut cache, &observed, &NoFaults).unwrap();
        assert!(matches!(result,TxnOutcome::Committed(p) if p.consumed_entries==through));
        assert_eq!(indexed(&store), expected);
        if through == 32 {
            let native = dohc_engine_collab::load_persisted(
                &store,
                &DocKey::new("workspace", "main", "object").unwrap(),
            )
            .unwrap()
            .unwrap();
            assert_eq!(native.doc.frontmatter_json()["status"], "open");
        }
        prefix::compact_prefix(&mut store, &mut cache, &observed.binding, &NoFaults, 8).unwrap();
        let result =
            settle_native_prefix(&mut store, &mut cache, &root, &observed, &NoFaults).unwrap();
        let settled = result.settled().unwrap();
        assert!(settled.materialized);
        assert!(!settled.collection_reconcile_required);
        assert_eq!(indexed(&store), expected);
        assert_eq!(history(&store), original_history);
        drop(store);
        store = EngineStore::open(&path, 9).unwrap();
        cache = WriterDocCache::new();
        assert_eq!(indexed(&store), expected);
        assert_eq!(history(&store), original_history);
    }
}

#[test]
fn native_prefix_reuses_an_existing_base_and_waits_for_its_history_frontier() {
    let (root, _path, mut store, observed, doc) = native_prefix_fixture();
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let base = dohc_engine_sync::ydoc_update_payload(
        &key,
        &observed.binding.current_path,
        ContentKind::Richdoc,
        &observed.binding.lineage_claim_id,
        &observed.binding.lineage_claim_id,
        None,
        None,
        true,
    );
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_sync::journal_local_op_in_tx(tx, "workspace", "ydoc.update", &base, 2)
        })
        .unwrap();
    let mut cache = WriterDocCache::new();
    draft::append_draft_cached(
        &mut store,
        &mut cache,
        "workspace",
        draft::OwnerDraftAppendInput {
            binding: observed.binding.clone(),
            expected_revision: 1,
            append_key: "original".into(),
            update: doc.richdoc_append_paragraph("a person edit"),
            person_edit: true,
            agent_declaration: None,
            automation_declaration: None,
            now_ms: 3,
        },
        &NoFaults,
    )
    .unwrap();
    prepare_native_prefix(&mut store, &observed);
    commit_native_prefix(&mut store, &mut cache, &observed, &NoFaults).unwrap();
    settle_native_prefix(&mut store, &mut cache, &root, &observed, &NoFaults).unwrap();
    let bases:Vec<String> = store.read_with(|c| {
        let mut q = c.prepare("SELECT payload_json FROM replication_log WHERE json_extract(payload_json,'$.isBaseState')=1")?;
        q.query_map([],|r|r.get(0))?.collect::<Result<Vec<_>,_>>()
    }).unwrap();
    assert_eq!(bases.len(), 1);
    let marker = dohc_engine_collab::read_marker(&store, &key)
        .unwrap()
        .unwrap();
    assert_eq!(marker.base_origin_id.as_deref(), Some("local"));
    assert_eq!(marker.base_origin_seq, Some(0));
    assert_eq!(
        store.table_row_count("ydoc_base_relay_candidates").unwrap(),
        1,
        "a reused base without a marker coordinate still needs a relay candidate"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&bases[0]).unwrap(),
        base
    );
    let p = store
        .read_with(|c| prefix::progress_in(c, &key))
        .unwrap()
        .unwrap();
    assert_eq!(
        p.publication_frontier["local"], 2,
        "original plus derived moment, after the existing base"
    );
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO sync_relay_push_state VALUES('workspace','local',1)",
                [],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .unwrap();
    assert!(
        !store
            .read_with(|c| prefix::publication_acked_in(c, &key))
            .unwrap()
    );
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE sync_relay_push_state SET pushed_seq=2", [])
                .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .unwrap();
    assert!(
        store
            .read_with(|c| prefix::publication_acked_in(c, &key))
            .unwrap()
    );
}

fn commit_native_prefix(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    observed: &draft::ObservedOwnerBinding,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<prefix::PrefixProgress>, OwnerOutboxError> {
    prefix::commit_prefix(
        store,
        cache,
        &observed.binding,
        &"c".repeat(64),
        6,
        faults,
        |tx, bytes, actor, attribution| {
            dohc_engine_sync::journal_prefix_update_in_tx(
                tx,
                &observed.binding,
                bytes,
                actor,
                attribution,
                6,
            )
            .map_err(|e| CollabError::Storage(StorageError::persist_public(e)))
        },
    )
}

fn settle_native_prefix(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    root: &std::path::Path,
    observed: &draft::ObservedOwnerBinding,
    faults: &dyn FaultInjector,
) -> Result<YdocSettleOutcome, RuntimeError> {
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let capability = store
        .read_with(|c| prefix::PrefixSettlement::prepare_in(c, &observed.binding))
        .unwrap();
    let head=store.read_with(|c|c.query_row("SELECT blob_sha256 FROM snapshots WHERE workspace_id='workspace' AND version_id='main' AND object_id='object'",[],|r|r.get::<_,String>(0))).unwrap();
    ydoc_settle_on_store(
        store,
        cache,
        root,
        &key,
        &observed.binding.current_path,
        ContentKind::Richdoc,
        false,
        Some(&observed.binding.lineage_claim_id),
        Some(head),
        None,
        "prefix-session",
        &(),
        7,
        faults,
        &CancellationToken::new(),
        None,
        None,
        None,
        SettlementKind::OwnerPrefix(&capability),
    )
}

#[test]
fn native_prefix_history_boundaries_restart_with_more_than_1024_authors_and_fenced_publication() {
    let (root, path, mut store, observed, doc) = native_prefix_fixture();
    let mut cache = WriterDocCache::new();
    for i in 0..1057 {
        let update = if i == 1000 {
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, "A credited delete")
                .unwrap()
        } else {
            doc.richdoc_append_paragraph(&format!("edit {i}"))
        };
        draft::append_draft_cached(
            &mut store,
            &mut cache,
            "workspace",
            draft::OwnerDraftAppendInput {
                person_edit: false,
                binding: observed.binding.clone(),
                expected_revision: 1,
                append_key: format!("author-{i}"),
                update,
                now_ms: 3,
                agent_declaration: Some(dohc_engine_domain::AgentDeclaration {
                    agent_id: format!("agent-{i}"),
                    on_behalf_of: Some("person".into()),
                    depth: 2,
                }),
                automation_declaration: None,
            },
            &NoFaults,
        )
        .unwrap();
    }
    prepare_native_prefix(&mut store, &observed);
    cache = WriterDocCache::new();
    let mut boundaries = 0;
    loop {
        let p = match commit_native_prefix(&mut store, &mut cache, &observed, &NoFaults).unwrap() {
            TxnOutcome::Committed(p) => p,
            _ => panic!(),
        };
        if p.settlement_owed || p.consumed_entries == 1057 {
            assert!(
                settle_native_prefix(&mut store, &mut cache, &root, &observed, &NoFaults)
                    .unwrap()
                    .settled()
                    .unwrap()
                    .materialized
            );
            boundaries += 1;
        }
        drop(store);
        store = EngineStore::open(&path, 8).unwrap();
        cache = WriterDocCache::new();
        if p.consumed_entries == 1057 {
            break;
        }
    }
    assert_eq!(boundaries, 2);
    let authors:Vec<String>=store.read_with(|c|{
        let mut q=c.prepare("SELECT author_json FROM moments WHERE workspace_id='workspace' AND metadata_origin='ydoc'")?;
        q.query_map([],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()
    }).unwrap();
    for i in 0..1057 {
        assert!(
            authors
                .iter()
                .any(|a| a.contains(&format!("\"agent-{i}\""))),
            "missing agent {i}"
        );
    }
    let key = DocKey::new("workspace", "main", "object").unwrap();
    assert!(
        !store
            .read_with(|c| prefix::publication_acked_in(c, &key))
            .unwrap()
    );
    let tagged:i64=store.read_with(|c|c.query_row("SELECT COUNT(*) FROM replication_log WHERE json_extract(payload_json,'$.release.releaseDigest')=?1",["c".repeat(64)],|r|r.get(0))).unwrap();
    assert_eq!(
        tagged, 1060,
        "one base, 1057 originals, two History publications"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("owner.md")).unwrap(),
        doc.project(ContentKind::Richdoc).unwrap().content
    );
    store.write_with(&NoFaults,|tx|{
        tx.execute("INSERT INTO sync_relay_push_state SELECT 'workspace','local',MAX(origin_seq) FROM replication_log WHERE workspace_id='workspace' AND origin_id='local'",[]).map_err(StorageError::persist_public)?;
        Ok::<_,StorageError>(())
    }).unwrap();
    assert!(
        store
            .read_with(|c| prefix::publication_acked_in(c, &key))
            .unwrap()
    );
    store.write_with(&NoFaults,|tx|{
        tx.execute("INSERT INTO release_publication_admissions VALUES('workspace','local',1,'ydoc.update',?1,'release-generation-fenced')",["c".repeat(64)]).map_err(StorageError::persist_public)?;
        Ok::<_,StorageError>(())
    }).unwrap();
    assert!(
        !store
            .read_with(|c| prefix::publication_acked_in(c, &key))
            .unwrap()
    );
}

#[test]
fn native_prefix_chunk_and_history_commit_crashes_resume_without_duplicate_credit() {
    for point in [
        FaultPoint::StorageBeforePersist,
        FaultPoint::StorageAfterCommitBeforeAck,
    ] {
        let (root, path, mut store, observed, doc) = native_prefix_fixture();
        let mut cache = WriterDocCache::new();
        for i in 0..65 {
            draft::append_draft_cached(
                &mut store,
                &mut cache,
                "workspace",
                draft::OwnerDraftAppendInput {
                    person_edit: true,
                    binding: observed.binding.clone(),
                    expected_revision: 1,
                    append_key: format!("edit-{i}"),
                    update: doc.richdoc_append_paragraph(&format!("edit {i}")),
                    now_ms: 3,
                    agent_declaration: None,
                    automation_declaration: None,
                },
                &NoFaults,
            )
            .unwrap();
        }
        prepare_native_prefix(&mut store, &observed);
        let mut count = 0;
        while count < 65 {
            let fault = ScriptedFaults::crash_at(point);
            let result =
                commit_native_prefix(&mut store, &mut cache, &observed, fault.as_ref()).unwrap();
            assert!(matches!(result, TxnOutcome::Crashed { .. }));
            drop(store);
            store = EngineStore::open(&path, 8).unwrap();
            cache = WriterDocCache::new();
            count = store
                .read_with(|c| {
                    prefix::progress_in(c, &DocKey::new("workspace", "main", "object").unwrap())
                })
                .unwrap()
                .unwrap()
                .consumed_entries;
            if point == FaultPoint::StorageBeforePersist {
                count = match commit_native_prefix(&mut store, &mut cache, &observed, &NoFaults)
                    .unwrap()
                {
                    TxnOutcome::Committed(p) => p.consumed_entries,
                    _ => panic!(),
                };
            }
        }
        let fault = ScriptedFaults::crash_at(point);
        assert!(
            settle_native_prefix(&mut store, &mut cache, &root, &observed, fault.as_ref()).is_err()
        );
        drop(store);
        store = EngineStore::open(&path, 8).unwrap();
        cache = WriterDocCache::new();
        settle_native_prefix(&mut store, &mut cache, &root, &observed, &NoFaults).unwrap();
        let count: i64 = store
            .read_with(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM moments WHERE metadata_origin='ydoc'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(count, 1);
    }
}
