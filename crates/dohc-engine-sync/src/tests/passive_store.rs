use super::*;
use dohc_engine_collab::{ContentKind, Ydoc};
use std::time::Instant;

fn replica(store: &mut EngineStore) {
    if std::env::var_os("PASSIVE_STORE_OWNER").is_none() {
        store.make_passive().unwrap();
    }
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
                Ok(())
            })
            .unwrap();
    }

    store.read_with(|conn| conn.query_row(
        "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id='ws' AND s.version_id='main' AND s.object_id=?1",
        [object], |row| row.get(0))).unwrap()
}

#[test]
#[ignore = "manual release replica spike: --ignored --nocapture"]
fn passive_store_incremental_cost() {
    let mut report = Vec::new();
    for body_bytes in [50_000, 1_000_000] {
        let (scratch, path, mut store) = open_store();
        replica(&mut store);
        let doc = Ydoc::wire();
        doc.plaintext_insert(0, &"a".repeat(body_bytes));
        let base = doc.encode_full_state();
        let claim = dohc_engine_storage::hex_sha256(&base);
        let mut pages = vec![(
            0,
            page(
                vec![
                    envelope("owner", 0, "workspace.init", json!({})),
                    update(1, "note", &base, &claim, true),
                ],
                2,
                false,
            ),
        )];
        let mut blobs = BTreeMap::from([(claim.clone(), base)]);
        for n in 0..101 {
            let delta = doc.plaintext_insert(0, "x");
            blobs.insert(dohc_engine_storage::hex_sha256(&delta), delta.clone());
            pages.push((
                n + 2,
                page(
                    vec![update(n + 2, "note", &delta, &claim, false)],
                    n + 3,
                    false,
                ),
            ));
        }
        let mut relay = PagedRelay::new(pages);
        relay.blobs = blobs;
        let client = RelaySyncClient::new(relay);
        let mut cache = WriterDocCache::new();
        pull(&client, &mut store, &mut cache);
        let mut samples = Vec::new();
        for n in 0..101 {
            let start = Instant::now();
            pull(&client, &mut store, &mut cache);
            let micros = start.elapsed().as_micros();
            if n > 0 {
                samples.push(micros);
            }
        }
        assert_eq!(
            head(&store, "note"),
            format!("{}{}", "x".repeat(101), "a".repeat(body_bytes))
        );
        assert!(client.transport().pushes.lock().unwrap().is_empty());
        let disk = std::fs::metadata(&path).unwrap().len();
        let wal = std::fs::metadata(format!("{}-wal", path.display())).map_or(0, |m| m.len());
        let mut sorted = samples.clone();
        sorted.sort_unstable();
        report.push(json!({"bodyBytes":body_bytes,"timed":"in-process transport pull, hydrate, apply/projection and store cursor commit; no file materialization", "samplesUs":samples,"medianUs":(sorted[49]+sorted[50])/2,"p95Us":sorted[94],"databaseBytes":disk,"walBytes":wal,"pushRequests":0,"root":scratch.path().display().to_string()}));
    }
    println!("{}", serde_json::to_string(&report).unwrap());
}

#[test]
fn passive_store_concurrent_delayed_and_source() {
    let (_scratch, _path, mut store) = open_store();
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
    for (name, source) in [
        ("README.md", include_str!("../../../../README.md")),
        ("CONTEXT.md", include_str!("../../../../CONTEXT.md")),
        (
            "verify-agent-work.md",
            include_str!("../../../../docs/engineering/verify-agent-work.md"),
        ),
        (
            "nested-list-witness.md",
            "---\nid: rec\n---\n\n- parent\n  - nested\n",
        ),
    ] {
        let (_scratch, _path, mut owner) = open_store();
        seed_replication_version(&mut owner, "main", "main");
        seed_text_head(&mut owner, "source", "source.md", source);
        let doc = Ydoc::wire();
        doc.rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
            .unwrap();
        let key = dohc_engine_collab::DocKey::new("ws", "main", "source").unwrap();
        let owner_text = owner
            .read_with(|conn| project_ydoc_with_store(conn, &key, &doc, ContentKind::Richdoc))
            .unwrap()
            .content;
        let (_scratch, _path, mut replica_store) = open_store();
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
            owner_text,
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
fn passive_store_cursor_never_backfills_local_heads() {
    let (_scratch, _path, mut store) = open_store();
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
    let (scratch, path, mut store) = open_store();
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
    let mut store = EngineStore::open(&path, 3001).unwrap();
    store.make_passive().unwrap();
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

#[test]
fn passive_store_refuses_claim_and_push_before_transport() {
    let (_scratch, _path, mut store) = open_store();
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
