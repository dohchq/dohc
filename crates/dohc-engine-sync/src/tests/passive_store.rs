use super::*;
use dohc_engine_collab::{ContentKind, Ydoc};

fn open_passive_store() -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let scratch = ScratchDir::new().unwrap();
    let path = engine_db_path(&scratch).unwrap();
    let store = EngineStore::open_passive(&path, 1, None, None).unwrap();
    (scratch, path, store)
}

fn replica(store: &mut EngineStore) {
    adopt_join_identity(
        store,
        "ws",
        "relay-private",
        "epoch-1",
        "stream-1",
        1,
        &NoFaults,
    )
    .unwrap();
}

fn update(
    origin_seq: i64,
    object: &str,
    bytes: &[u8],
    claim: &str,
    base: bool,
) -> ReplicationEnvelope {
    envelope(
        "owner",
        origin_seq,
        "ydoc.update",
        json!({
            "versionId":"main", "objectId":object, "path":format!("{object}.txt"),
            "contentKind":"plaintext", "updateBlobSha256":dohc_engine_storage::hex_sha256(bytes),
            "lineageClaimId":claim, "isBaseState":base
        }),
    )
}

fn page(ops: Vec<ReplicationEnvelope>, cursor: i64, more: bool) -> PullResponse {
    PullResponse {
        ops,
        next_cursor: cursor,
        has_more: more,
    }
}

fn pull(client: &RelaySyncClient<PagedRelay>, store: &mut EngineStore, cache: &mut WriterDocCache) {
    let result = client
        .pull_chat_workspace(store, cache, "ws", &NoFaults, &NoLiveLeases, 3000)
        .unwrap();
    let SyncPassOutcome::Complete {
        refused,
        pending_cursor: Some(cursor),
        ..
    } = result
    else {
        panic!("{result:?}")
    };
    assert_eq!(refused, 0);
    client
        .commit_pull_cursor(store, "ws", &cursor, &NoFaults, &NoLiveLeases, 3000)
        .unwrap();
}

fn head(store: &EngineStore, object: &str) -> String {
    if store.is_passive() {
        store
            .read_with(|conn| -> rusqlite::Result<()> {
                let local: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM replication_log WHERE imported=0",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                let jobs: i64 = conn
                    .query_row("SELECT COUNT(*) FROM materialization_jobs", [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert_eq!((local, jobs), (0, 0));
                for table in [
                    "link_pending",
                    "link_aliases",
                    "link_index_state",
                    "link_sources",
                    "links",
                ] {
                    let count: i64 = conn
                        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                            row.get(0)
                        })
                        .unwrap();
                    assert_eq!(count, 0, "passive replication originated {table}");
                }
                Ok(())
            })
            .unwrap();
    }

    store.read_with(|conn| conn.query_row(
        "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id='ws' AND s.version_id='main' AND s.object_id=?1",
        [object], |row| row.get(0))).unwrap()
}

#[test]
fn passive_store_concurrent_delayed_and_source() {
    let (_scratch, _path, mut store) = open_passive_store();
    replica(&mut store);
    apply_replication_envelope(
        &mut store,
        &mut WriterDocCache::new(),
        &envelope("init", 0, "workspace.init", json!({})),
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    let base = Ydoc::wire();
    base.plaintext_insert(0, "base");
    let bytes = base.encode_full_state();
    let claim = store.put_binary_blob(&bytes).unwrap();
    let mut cache = WriterDocCache::new();
    apply_ydoc_envelope(
        &mut store,
        &mut cache,
        &update(0, "shared", &bytes, &claim, true),
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    let a = Ydoc::wire();
    a.apply(&bytes).unwrap();
    let b = Ydoc::wire();
    b.apply(&bytes).unwrap();
    let da = a.plaintext_insert(0, "A ");
    let db = b.plaintext_insert(4, " B");
    a.apply(&db).unwrap();
    b.apply(&da).unwrap();
    let mut oa = update(0, "shared", &da, &claim, false);
    oa.origin_id = "device-a".into();
    oa.relay_seq = Some(2);
    let mut ob = update(0, "shared", &db, &claim, false);
    ob.origin_id = "device-b".into();
    ob.relay_seq = Some(3);
    for op in [&oa, &ob] {
        let data = if op.origin_id == "device-a" { &da } else { &db };
        store.put_binary_blob(data).unwrap();
        let result =
            apply_ydoc_envelope(&mut store, &mut cache, op, &NoFaults, &NoLiveLeases).unwrap();
        assert!(
            matches!(result.primary, ApplyDisposition::Applied(_)),
            "{result:?}"
        );
    }
    assert_eq!(
        head(&store, "shared"),
        a.project(ContentKind::Plaintext).unwrap().content
    );
    assert_eq!(
        head(&store, "shared"),
        b.project(ContentKind::Plaintext).unwrap().content
    );
    let delayed = b.plaintext_insert(0, "delayed ");
    a.plaintext_insert(0, "online ");
    let online = a.diff(&b.encode_state_vector()).unwrap();
    store.put_binary_blob(&online).unwrap();
    let mut op = update(1, "shared", &online, &claim, false);
    op.origin_id = "device-a".into();
    op.relay_seq = Some(4);
    apply_ydoc_envelope(&mut store, &mut cache, &op, &NoFaults, &NoLiveLeases).unwrap();
    store.put_binary_blob(&delayed).unwrap();
    let mut op = update(1, "shared", &delayed, &claim, false);
    op.origin_id = "device-b".into();
    op.relay_seq = Some(5);
    apply_ydoc_envelope(&mut store, &mut cache, &op, &NoFaults, &NoLiveLeases).unwrap();
    a.apply(&delayed).unwrap();
    b.apply(&online).unwrap();
    assert_eq!(
        head(&store, "shared"),
        a.project(ContentKind::Plaintext).unwrap().content
    );
    assert_eq!(
        head(&store, "shared"),
        b.project(ContentKind::Plaintext).unwrap().content
    );
    let mut source_results = Vec::new();
    // A row with a desktop canonical seeds the document as the desktop reads
    // the file, with the file as its witness. The outside fold cannot build
    // that document. The engine's file reading proves the witness for
    // indented code and a list item's underlined heading. The nested-list
    // witness needs the lenient reading, which compares the snapshot.
    for (name, source, desktop_canonical) in [
        (
            "headings.md",
            "# Workspace\n\nText with **bold** and [a link](https://example.test).\n",
            None,
        ),
        (
            "table.md",
            "| Name | Value |\n| --- | --- |\n| Item | 2 |\n",
            None,
        ),
        (
            "code.md",
            "Before\n\n    let value = 2;\n\nAfter\n",
            Some("Before\n\n```\nlet value = 2;\n```\n\nAfter"),
        ),
        (
            "quoted-list-code.md",
            "    > - a\n    > \tcode\n",
            Some("```\n> - a\n> \tcode\n```"),
        ),
        (
            "list-heading.md",
            "- Plan\n  --\n- Notes\n",
            Some("- \n  ## Plan\n- Notes"),
        ),
        (
            "fenced-code.md",
            "Before\n\n```\nlet value = 2;\n```\n\nAfter\n",
            None,
        ),
        (
            "nested-list-witness.md",
            "---\nid: rec\n---\n\n- \n\n  - b\n - c",
            Some("---\nid: rec\n---\n\n- \n\n- b\n- c"),
        ),
    ] {
        let (_scratch, _path, mut owner) = open_store();
        seed_replication_version(&mut owner, "main", "main");
        seed_text_head(&mut owner, "source", "source.md", source);
        let doc = Ydoc::wire();
        if let Some(canonical) = desktop_canonical {
            let folded = Ydoc::wire();
            assert!(
                folded
                    .rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, source)
                    .is_err()
                    || folded.project(ContentKind::Richdoc).unwrap().content != canonical,
                "{name}"
            );
            doc.rewrite_content_to_markdown(ContentKind::Richdoc, canonical)
                .unwrap();
            doc.preserve_folded_markdown_source(source).unwrap();
        } else {
            doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
                .unwrap();
        }
        let key = dohc_engine_collab::DocKey::new("ws", "main", "source").unwrap();
        let owner_text = owner
            .read_with(|conn| project_ydoc_with_store(conn, &key, &doc, ContentKind::Richdoc))
            .unwrap()
            .content;
        let (_scratch, _path, mut replica_store) = open_passive_store();
        seed_replication_version(&mut replica_store, "main", "main");
        let missing_source = replica_store
            .read_with(|conn| project_ydoc_with_store(conn, &key, &doc, ContentKind::Richdoc))
            .unwrap()
            .content;
        seed_text_head(&mut replica_store, "source", "source.md", source);
        let imported_source = replica_store
            .read_with(|conn| project_ydoc_with_store(conn, &key, &doc, ContentKind::Richdoc))
            .unwrap()
            .content;
        assert_eq!(owner_text, source, "owner source: {name}");
        assert_eq!(imported_source, owner_text, "replica source: {name}");
        if name == "nested-list-witness.md" {
            assert_ne!(missing_source, owner_text);
        } else {
            assert_eq!(
                missing_source, owner_text,
                "replica without snapshot: {name}"
            );
        }
        replica(&mut replica_store);
        let bytes = doc.encode_full_state();
        let claim = replica_store.put_binary_blob(&bytes).unwrap();
        let mut op = update(0, "source", &bytes, &claim, true);
        op.payload["contentKind"] = json!("richdoc");
        op.payload["path"] = json!("source.md");
        let applied = apply_ydoc_envelope(
            &mut replica_store,
            &mut WriterDocCache::new(),
            &op,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        assert!(
            matches!(applied.primary, ApplyDisposition::Applied(_)),
            "{applied:?}"
        );
        assert_eq!(
            head(&replica_store, "source"),
            source,
            "settled passive store: {name}"
        );
        source_results.push(json!({"file":name,"fileBytes":source.len(),"ownerEqualsFile":owner_text==source,"replicaWithoutSnapshotEqualsOwner":missing_source==owner_text,"replicaWithSnapshotEqualsOwner":imported_source==owner_text,"ownerSha256":dohc_engine_storage::hex_sha256(owner_text.as_bytes()),"withoutSnapshotBytes":missing_source.len()}));
    }
    println!(
        "{}",
        json!({"concurrentAndDelayed":"passed","realDocumentComparisons":source_results})
    );
}

#[test]
fn passive_store_settles_desktop_witnesses_from_the_file_on_disk() {
    use base64::Engine as _;
    let vectors: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../tests/settle-parity/yjs.json")).unwrap();
    // Each desktop seed settles with the file on disk, then without it, which
    // writes the vector's Markdown. Main settled `lexical-16` as fenced code,
    // which its next settle turns back into the source. The file reading
    // refuses a `--` heading over two lines, so both settles write its
    // projection, as main did. A bare `-` heading over two lines, and an `=`
    // heading that marked and main both read, keep their file, as on main.
    // So does an `=` heading beside a `--` line that starts CDATA in any case,
    // which only the file reading can prove.
    for (name, file, with_file) in [
        (
            "lexical-16",
            "```\nindented code\n```",
            "    indented code\n",
        ),
        (
            "list-heading",
            "- Plan\n  --\n- Notes\n",
            "- Plan\n  --\n- Notes\n",
        ),
        (
            "list-heading-two-lines",
            "- a\n  b\n  --\n",
            "- \n  ## a\n  b",
        ),
        (
            "list-heading-bare-dash-two-lines",
            "- a\n  b\n  -\n",
            "- a\n  b\n  -\n",
        ),
        ("list-heading-equals-bang", "- <!-x\n  =\n", "- <!-x\n  =\n"),
        (
            "list-heading-equals-pipe-tab",
            "- |\t|\n  =\n",
            "- |\t|\n  =\n",
        ),
        (
            "list-heading-cdata-lowercase",
            "- a\n  =\n- <![cdata[x\n  --\n",
            "- a\n  =\n- <![cdata[x\n  --\n",
        ),
        (
            "list-heading-cdata-mixed-case",
            "- a\n  =\n- <![CdAtA[x\n  --\n",
            "- a\n  =\n- <![CdAtA[x\n  --\n",
        ),
    ] {
        let vector = vectors
            .iter()
            .find(|vector| vector["name"] == name)
            .unwrap();
        let expected = vector["markdown"].as_str().unwrap();
        let doc = Ydoc::wire();
        for update in vector["updates"].as_array().unwrap() {
            doc.apply(
                &base64::engine::general_purpose::STANDARD
                    .decode(update.as_str().unwrap())
                    .unwrap(),
            )
            .unwrap();
        }
        let key = dohc_engine_collab::DocKey::new("ws", "main", "source").unwrap();
        let (_scratch, _path, mut owner) = open_store();
        seed_replication_version(&mut owner, "main", "main");
        seed_text_head(&mut owner, "source", "source.md", file);
        let owner_text = owner
            .read_with(|conn| project_ydoc_with_store(conn, &key, &doc, ContentKind::Richdoc))
            .unwrap()
            .content;
        assert_eq!(owner_text, with_file, "owner: {name}");
        let (_scratch, _path, mut replica_store) = open_passive_store();
        seed_replication_version(&mut replica_store, "main", "main");
        let missing_file = replica_store
            .read_with(|conn| project_ydoc_with_store(conn, &key, &doc, ContentKind::Richdoc))
            .unwrap()
            .content;
        assert_eq!(missing_file, expected, "replica without the file: {name}");
    }
}

#[test]
fn passive_store_first_pull_never_backfills_local_history() {
    let (_scratch, _path, mut store) = open_passive_store();
    seed_replication_version(&mut store, "main", "main");
    VersionedTextStore::new(&mut store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "local".into(),
                path: "local.txt".into(),
                text: "must stay private".into(),
                moment_id: "local-moment".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    replica(&mut store);
    let sha = store.put_binary_blob(b"checkpoint").unwrap();
    store.write_with(&NoFaults, |tx| {
        tx.execute("INSERT INTO live_accepted_checkpoints (relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,event_count,journal_cursor,terminal_json,binding_json,origin_stamp,state_sha256,evidence_digest) VALUES ('relay','ws','main','local',?1,0,0,'{}','{}',?1,?1,?1)", [&sha]).map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    }).unwrap();
    let client = RelaySyncClient::new(PagedRelay::new(vec![(
        0,
        page(
            vec![envelope("owner", 0, "workspace.init", json!({}))],
            1,
            false,
        ),
    )]));
    let result = client
        .pull_chat_workspace(
            &mut store,
            &mut WriterDocCache::new(),
            "ws",
            &NoFaults,
            &NoLiveLeases,
            3000,
        )
        .unwrap();
    let SyncPassOutcome::Complete {
        pending_cursor: Some(cursor),
        ..
    } = result
    else {
        panic!("{result:?}")
    };
    assert_eq!(cursor.cursor, 1);
    let (local, exports): (i64, i64) = store.read_with(|conn| conn.query_row("SELECT (SELECT count(*) FROM replication_log WHERE imported=0), (SELECT count(*) FROM live_audit_pending_exports)", [], |row| Ok((row.get(0)?,row.get(1)?)))).unwrap();
    assert_eq!((local, exports), (0, 0));
    client
        .commit_pull_cursor(&mut store, "ws", &cursor, &NoFaults, &NoLiveLeases, 3000)
        .unwrap();
}

#[test]
fn passive_store_cursor_never_backfills_local_heads() {
    let (_scratch, _path, mut store) = open_passive_store();
    seed_replication_version(&mut store, "main", "main");
    VersionedTextStore::new(&mut store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "local".into(),
                path: "local.txt".into(),
                text: "must stay private".into(),
                moment_id: "local-moment".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    replica(&mut store);
    commit_relay_cursor(
        &mut store,
        "ws",
        &RelayCursor {
            cursor: 0,
            replication_epoch: "epoch-1".into(),
            stream_identity: "stream-1".into(),
            bootstrap_complete: true,
            settlement_report_id: None,
            ordinary_pull: None,
        },
        &NoFaults,
        &NoLiveLeases,
        3000,
    )
    .unwrap();
    assert_eq!(
        VersionedTextStore::new(&mut store)
            .read_text("ws", "main", "local.txt")
            .unwrap()
            .unwrap()
            .text,
        "must stay private"
    );
    assert_eq!(
        store
            .read_with(|conn| conn.query_row(
                "SELECT COUNT(*) FROM replication_log WHERE imported=0",
                [],
                |row| row.get::<_, i64>(0)
            ))
            .unwrap(),
        0
    );
}

#[test]
fn passive_store_restarts_mid_history_across_a_secret_page() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let (scratch, path, mut store) = open_passive_store();
    replica(&mut store);
    let doc = Ydoc::wire();
    doc.plaintext_insert(0, "base");
    let base = doc.encode_full_state();
    let claim = dohc_engine_storage::hex_sha256(&base);
    let delta = doc.plaintext_insert(0, "after ");
    let cipher = b"sealed ciphertext without any key".to_vec();
    let secret = envelope(
        "owner",
        2,
        "secret.file.put",
        json!({
            "versionId":"main", "path":".env", "metadata":{"origin":"sync"},
            "ivBase64":STANDARD.encode([0u8; SECRET_IV_BYTES]),
            "authTagBase64":STANDARD.encode([0u8; SECRET_TAG_BYTES]),
            "ciphertextSha256":dohc_engine_storage::hex_sha256(&cipher), "byteLength":cipher.len()
        }),
    );
    let mut pages = vec![(
        0,
        page(
            vec![
                envelope("owner", 0, "workspace.init", json!({})),
                update(1, "note", &base, &claim, true),
            ],
            2,
            true,
        ),
    )];
    for index in 0..crate::model::MAX_PULL_PAGES_PER_PASS - 1 {
        let cursor = 2 + index as i64;
        pages.push((
            cursor,
            page(
                vec![envelope(
                    "padding",
                    index as i64,
                    "workspace.init",
                    json!({}),
                )],
                cursor + 1,
                true,
            ),
        ));
    }
    let secret_cursor = 1 + crate::model::MAX_PULL_PAGES_PER_PASS as i64;
    pages.extend([
        (
            secret_cursor,
            page(
                vec![secret, update(3, "note", &delta, &claim, false)],
                secret_cursor + 2,
                false,
            ),
        ),
        (secret_cursor + 2, page(vec![], secret_cursor + 2, false)),
    ]);
    let mut relay = PagedRelay::new(pages);
    relay.blobs = [base, delta, cipher]
        .into_iter()
        .map(|bytes| (dohc_engine_storage::hex_sha256(&bytes), bytes))
        .collect();
    let client = RelaySyncClient::new(relay);
    pull(&client, &mut store, &mut WriterDocCache::new());
    assert_eq!(head(&store, "note"), "base");
    assert_eq!(
        read_relay_cursor(&store, "ws").unwrap().unwrap().cursor,
        secret_cursor
    );
    drop(store);
    let mut store = EngineStore::open_passive(&path, 3001, None, None).unwrap();
    pull(&client, &mut store, &mut WriterDocCache::new());
    assert_eq!(head(&store, "note"), "after base");
    assert_eq!(
        read_relay_cursor(&store, "ws").unwrap().unwrap().cursor,
        secret_cursor + 2
    );
    let secrets: i64 = store
        .read_with(|conn| conn.query_row("SELECT COUNT(*) FROM secret_files", [], |row| row.get(0)))
        .unwrap();
    assert_eq!(secrets, 1);
    pull(&client, &mut store, &mut WriterDocCache::new());
    assert!(client.transport().pushes.lock().unwrap().is_empty());
    assert!(!scratch.path().join("note.txt").exists());
    assert!(!scratch.path().join(".env").exists());
}

/// A passive store is never hosted, and each relay row it applies or
/// recognizes as redelivered moves its log frontier.
#[test]
fn passive_apply_advances_the_log_frontier_and_never_hosts() {
    let (_scratch, _path, mut store) = open_passive_store();
    replica(&mut store);
    let frontier = |store: &EngineStore| {
        store
            .read_with(|conn| dohc_engine_storage::replica::read_frontiers(conn, "ws"))
            .unwrap()
    };
    let mut init = envelope("owner", 0, "workspace.init", json!({}));
    for (relay_seq, disposition) in [(5, "applied"), (8, "redelivered")] {
        init.relay_seq = Some(relay_seq);
        let result = apply_replication_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &init,
            &NoFaults,
            &NoLiveLeases,
        )
        .unwrap();
        match disposition {
            "applied" => assert!(matches!(result.primary, ApplyDisposition::Applied(_))),
            _ => assert!(matches!(result.primary, ApplyDisposition::Skipped)),
        }
        assert_eq!(frontier(&store).log_cursor, relay_seq, "{disposition}");
    }
    assert!(matches!(
        create_hosted_replica(&mut store, "ws", "service-host:a", "epoch-1", "stream-1", 1, &NoFaults),
        Err(SyncError::InvalidInput { reason }) if reason == PASSIVE_STORE_CANNOT_HOST
    ));
    assert!(!is_hosted_replica(&store, "ws").unwrap());
}

#[test]
fn passive_store_refuses_claim_and_push_before_transport() {
    let (_scratch, _path, mut store) = open_passive_store();
    replica(&mut store);
    assert!(
        create_claim_identity(
            &mut store, "ws", "other", "epoch-1", "stream-1", 1, &NoFaults
        )
        .is_err()
    );
    let client = RelaySyncClient::new(PagedRelay::new([]));
    assert!(
        client
            .push_workspace(&mut store, "ws", &NoFaults, &NoLiveLeases, 3000, usize::MAX)
            .is_err()
    );
    assert!(client.transport().pushes.lock().unwrap().is_empty());
    assert!(
        journal_local_replication_op(
            &mut store,
            "ws",
            "relay-private",
            "epoch-1",
            "stream-1",
            "workspace.init",
            &json!({}),
            1,
            &NoFaults
        )
        .is_err()
    );
}
