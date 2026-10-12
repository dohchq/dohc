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
#[ignore = "manual release catch-up measurement: --ignored --nocapture"]
fn passive_store_cold_cost() {
    let large = std::env::var_os("REPLICA_LARGE_FIXTURE").is_some();
    let (documents, edits, bytes) = if large {
        (1, 1000, 1_000_000)
    } else {
        (100, 100, 50_000)
    };
    let (scratch, path, mut store) = open_store();
    replica(&mut store);
    let mut ops = vec![envelope("owner", 0, "workspace.init", json!({}))];
    let mut blobs = BTreeMap::new();
    let mut expected = BTreeMap::new();
    for n in 0..documents {
        let object = format!("note-{n:03}");
        let body = format!("{n:03}{}", "a".repeat(bytes - 3));
        let doc = Ydoc::wire();
        doc.plaintext_insert(0, &body);
        let base = doc.encode_full_state();
        let claim = dohc_engine_storage::hex_sha256(&base);
        ops.push(update(ops.len() as i64, &object, &base, &claim, true));
        blobs.insert(claim.clone(), base);
        for _ in 0..edits {
            let delta = doc.plaintext_insert(0, "x");
            ops.push(update(ops.len() as i64, &object, &delta, &claim, false));
            blobs.insert(dohc_engine_storage::hex_sha256(&delta), delta);
        }
        expected.insert(object, format!("{}{body}", "x".repeat(edits)));
    }
    let count = ops.len();
    let pages: Vec<_> = ops
        .chunks(100)
        .enumerate()
        .map(|(i, chunk)| {
            let cursor = (i * 100) as i64;
            let next = cursor + chunk.len() as i64;
            (cursor, page(chunk.to_vec(), next, next < count as i64))
        })
        .collect();
    let mut relay = PagedRelay::new(pages);
    relay.blobs = blobs;
    let client = RelaySyncClient::new(relay);
    let mut cache = WriterDocCache::new();
    let start = Instant::now();
    let mut passes = Vec::new();
    loop {
        let pass = Instant::now();
        let result = client
            .pull_chat_workspace(&mut store, &mut cache, "ws", &NoFaults, &NoLiveLeases, 3000)
            .unwrap();
        let SyncPassOutcome::Complete {
            refused,
            pending_cursor: Some(cursor),
            has_more,
            ..
        } = result
        else {
            panic!("{result:?}")
        };
        assert_eq!(refused, 0);
        client
            .commit_pull_cursor(&mut store, "ws", &cursor, &NoFaults, &NoLiveLeases, 3000)
            .unwrap();
        passes.push(pass.elapsed().as_micros());
        if !has_more {
            break;
        }
    }
    let elapsed = start.elapsed().as_micros();
    for (object, text) in expected {
        assert_eq!(head(&store, &object), text);
    }
    let mut totals = BTreeMap::new();
    store
        .read_with(|conn| -> rusqlite::Result<()> {
            for (name, sql) in [
                (
                    "textBlobBytes",
                    "SELECT COALESCE(SUM(byte_length),0) FROM blobs",
                ),
                (
                    "binaryBlobBytes",
                    "SELECT COALESCE(SUM(byte_length),0) FROM binary_blobs",
                ),
                ("moments", "SELECT COUNT(*) FROM moments"),
                ("journalRows", "SELECT COUNT(*) FROM replication_log"),
                (
                    "journalPayloadBytes",
                    "SELECT COALESCE(SUM(length(payload_json)),0) FROM replication_log",
                ),
                ("updateRows", "SELECT COUNT(*) FROM ydoc_updates"),
            ] {
                totals.insert(name, conn.query_row(sql, [], |row| row.get::<_, i64>(0))?);
            }
            Ok(())
        })
        .unwrap();
    let disk = std::fs::metadata(&path).unwrap().len();
    let wal = std::fs::metadata(format!("{}-wal", path.display())).map_or(0, |m| m.len());
    println!(
        "COLD {}",
        json!({"documents":documents,"edits":edits,"bodyBytes":bytes,"operations":count,"elapsedUs":elapsed,"passesUs":passes,"databaseBytes":disk,"walBytes":wal,"totals":totals,"root":scratch.path().display().to_string()})
    );
    if std::env::var_os("REPLICA_COMPARE_OWNER").is_some() {
        let (_owner_root, _, mut owner) = open_store();
        let ops: Vec<_> = client
            .transport()
            .pages
            .values()
            .flat_map(|page| page.ops.iter().cloned())
            .collect();
        assert!(
            replay_fixture(
                &mut owner,
                &mut WriterDocCache::new(),
                &ops,
                &client.transport().blobs,
                false,
            )
            .is_empty()
        );
        let expected = state_digest(&owner);
        assert_eq!(state_digest(&store), expected);
        println!(
            "COLD_PARITY {}",
            json!({"documents":documents,"edits":edits,"textDigest":expected.0,"structuralDigest":expected.1})
        );
    }
}

fn catchup_fixture(
    documents: usize,
    edits: usize,
) -> (Vec<ReplicationEnvelope>, BTreeMap<String, Vec<u8>>) {
    let mut ops = vec![envelope("owner", 0, "workspace.init", json!({}))];
    let mut blobs = BTreeMap::new();
    for n in 0..documents {
        let object = format!("note-{n}");
        let doc = Ydoc::wire();
        doc.plaintext_insert(0, &format!("{n}{}", "a".repeat(999)));
        let base = doc.encode_full_state();
        let claim = dohc_engine_storage::hex_sha256(&base);
        ops.push(update(ops.len() as i64, &object, &base, &claim, true));
        blobs.insert(claim.clone(), base);
        for _ in 0..edits {
            let bytes = doc.plaintext_insert(0, "x");
            ops.push(update(ops.len() as i64, &object, &bytes, &claim, false));
            blobs.insert(dohc_engine_storage::hex_sha256(&bytes), bytes);
        }
    }
    (ops, blobs)
}

fn state_digest(store: &EngineStore) -> (String, String) {
    fn digest(conn: &rusqlite::Connection, queries: &[&str]) -> rusqlite::Result<String> {
        let mut hash = Sha256::new();
        for sql in queries {
            let mut statement = conn.prepare(sql)?;
            let columns = statement.column_count();
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                for column in 0..columns {
                    let field = format!("{:?}", row.get_ref(column)?);
                    hash.update((field.len() as u64).to_le_bytes());
                    hash.update(field.as_bytes());
                }
                hash.update(b"\n");
            }
        }
        Ok(dohc_engine_storage::hex(&hash.finalize()))
    }
    store.read_with(|conn| -> rusqlite::Result<_> {
        let text = digest(conn, &["SELECT s.workspace_id,s.version_id,s.object_id,s.path,b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 ORDER BY 1,2,3"])?;
        let structure = digest(conn, &[
            "SELECT * FROM versions ORDER BY workspace_id,version_id",
            "SELECT * FROM active_versions ORDER BY workspace_id",
            "SELECT * FROM versioned_workspaces ORDER BY workspace_id",
            "SELECT * FROM file_objects ORDER BY workspace_id,object_id",
            "SELECT * FROM path_aliases ORDER BY workspace_id,version_id,path",
            "SELECT * FROM fork_base_snapshots ORDER BY workspace_id,version_id,object_id",
            "SELECT * FROM snapshots ORDER BY workspace_id,version_id,object_id",
            "SELECT * FROM ydoc_updates ORDER BY workspace_id,version_id,object_id,seq",
            "SELECT * FROM ydoc_snapshots ORDER BY workspace_id,version_id,object_id,up_to_seq",
            "SELECT * FROM ydoc_inactive_lineages ORDER BY workspace_id,version_id,object_id,lineage_claim_id",
            "SELECT * FROM ydoc_deferred_updates ORDER BY workspace_id,version_id,object_id,origin_id,origin_seq",
            "SELECT workspace_id,version_id,object_id,content_kind,regime,lineage_claim_status,lineage_claim_id,lineage_epoch_tag,path,head_update_seq,head_snapshot_seq,settled_update_seq,last_settled_sha,seed_source_sha256,pending_authors_json,settle_prior_update_seq,updated_at_ms FROM ydoc_docs ORDER BY 1,2,3",
            "SELECT * FROM secret_files ORDER BY workspace_id,version_id,path",
            "SELECT * FROM secret_fork_bases ORDER BY workspace_id,version_id,path",
            "SELECT * FROM conflicts ORDER BY workspace_id,conflict_id",
            "SELECT * FROM replication_peers ORDER BY workspace_id,origin_id",
            "SELECT * FROM replication_pending_refusals ORDER BY workspace_id,origin_id,origin_seq",
        ])?;
        Ok((text, structure))
    }).unwrap()
}

fn replay_fixture(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    ops: &[ReplicationEnvelope],
    blobs: &BTreeMap<String, Vec<u8>>,
    batch: bool,
) -> Vec<ReplicationRefusal> {
    let mut refused = Vec::new();
    for bytes in blobs.values() {
        store.put_binary_blob(bytes).unwrap();
    }
    for op in ops {
        let result = crate::router::apply_replication_envelope_in_batch(
            store,
            cache,
            op,
            &NoFaults,
            &NoLiveLeases,
            batch,
        )
        .unwrap();
        if let ApplyDisposition::Refused(row) = result.primary {
            refused.push(row);
        }
        refused.extend(result.refusals);
    }
    if batch {
        commit_relay_cursor(
            store,
            "ws",
            &RelayCursor {
                cursor: ops.len() as i64,
                replication_epoch: "epoch-1".into(),
                stream_identity: "stream-1".into(),
                bootstrap_complete: false,
                settlement_report_id: None,
            },
            &NoFaults,
            &NoLiveLeases,
            3000,
        )
        .unwrap();
    }
    refused
}

#[test]
fn passive_catchup_malformed_doc_keys_keep_owner_refusals() {
    let (fixture, blobs) = catchup_fixture(1, 0);
    let mut ops = vec![fixture[0].clone()];
    for (seq, (field, value)) in [
        ("versionId", "".to_owned()),
        ("objectId", "".to_owned()),
        ("objectId", "bad\0key".to_owned()),
        (
            "versionId",
            "a".repeat(dohc_engine_storage::MAX_IDENTIFIER_BYTES + 1),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let mut op = fixture[1].clone();
        op.origin_id = "malformed".into();
        op.origin_seq = seq as i64;
        op.payload[field] = json!(value);
        ops.push(op);
    }
    ops.push(fixture[1].clone());
    let (_root, _, mut owner) = open_store();
    let refused = replay_fixture(&mut owner, &mut WriterDocCache::new(), &ops, &blobs, false);
    assert_eq!(refused.len(), 4);
    let (_root, _, mut passive) = open_store();
    passive.make_passive().unwrap();
    assert_eq!(
        replay_fixture(&mut passive, &mut WriterDocCache::new(), &ops, &blobs, true),
        refused
    );
    assert_eq!(state_digest(&passive), state_digest(&owner));
}

#[test]
fn passive_catchup_keeps_page_cuts_and_matches_owner_structure() {
    let (ops, blobs) = catchup_fixture(3, 40);
    let (_owner_root, _, mut owner) = open_store();
    let mut owner_cache = WriterDocCache::new();
    assert!(replay_fixture(&mut owner, &mut owner_cache, &ops, &blobs, false).is_empty());
    let expected = state_digest(&owner);
    for batch in [false, true] {
        let (_root, _, mut passive) = open_store();
        passive.make_passive().unwrap();
        let mut cache = WriterDocCache::new();
        assert!(replay_fixture(&mut passive, &mut cache, &ops, &blobs, batch).is_empty());
        assert_eq!(state_digest(&passive), expected, "batch={batch}");
        if batch {
            let count: i64 = passive
                .read_with(|conn| {
                    conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0))
                })
                .unwrap();
            assert_eq!(count, 6, "retain the base and final cut of each document");
        }
    }
    println!(
        "PARITY {}",
        json!({"textDigest":expected.0,"structuralDigest":expected.1})
    );
}

#[test]
fn passive_catchup_restart_with_uncommitted_cursor_keeps_pending_text() {
    let (ops, blobs) = catchup_fixture(1, 30);
    let (_owner_root, _, mut owner) = open_store();
    replay_fixture(&mut owner, &mut WriterDocCache::new(), &ops, &blobs, false);
    let (scratch, path, mut store) = open_store();
    store.make_passive().unwrap();
    adopt_join_identity(
        &mut store,
        "ws",
        "relay-private",
        "epoch-1",
        "stream-1",
        1,
        &NoFaults,
    )
    .unwrap();
    for bytes in blobs.values() {
        store.put_binary_blob(bytes).unwrap();
    }
    let mut cache = WriterDocCache::new();
    for op in &ops[..15] {
        crate::router::apply_replication_envelope_in_batch(
            &mut store,
            &mut cache,
            op,
            &NoFaults,
            &NoLiveLeases,
            true,
        )
        .unwrap();
    }
    let pending: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM passive_pending_projection",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(pending, 1);
    drop(store);
    drop(cache);
    let mut store = EngineStore::open(&path, 3000).unwrap();
    store.make_passive().unwrap();
    let count = ops.len() as i64;
    let mut relay = PagedRelay::new(vec![(0, page(ops, count, false))]);
    relay.blobs = blobs;
    pull(
        &RelaySyncClient::new(relay),
        &mut store,
        &mut WriterDocCache::new(),
    );
    assert_eq!(state_digest(&store), state_digest(&owner));
    assert_eq!(
        std::fs::metadata(format!("{}-wal", path.display()))
            .unwrap()
            .len(),
        0
    );
    drop(store);
    drop(scratch);
}

#[test]
fn passive_catchup_refuses_oversized_middle_row_without_losing_valid_text() {
    let mut ops = vec![envelope("owner", 0, "workspace.init", json!({}))];
    let doc = Ydoc::wire();
    doc.plaintext_insert(0, &"a".repeat(MAX_TEXT_BYTES - 4));
    let base = doc.encode_full_state();
    let claim = dohc_engine_storage::hex_sha256(&base);
    ops.push(update(1, "note", &base, &claim, true));
    let mut blobs = BTreeMap::from([(claim.clone(), base)]);
    for (seq, bytes) in [
        (2, doc.plaintext_insert(0, "xx")),
        (3, doc.plaintext_insert(0, "xxxx")),
        (4, doc.plaintext_delete(0, 4)),
    ] {
        ops.push(update(seq, "note", &bytes, &claim, false));
        blobs.insert(dohc_engine_storage::hex_sha256(&bytes), bytes);
    }
    let (_root, _, mut owner) = open_store();
    let refused = replay_fixture(&mut owner, &mut WriterDocCache::new(), &ops, &blobs, false);
    assert_eq!(refused.len(), 1);
    assert_eq!(refused[0].origin_seq, 3);
    let (_root, _, mut passive) = open_store();
    passive.make_passive().unwrap();
    assert_eq!(
        replay_fixture(&mut passive, &mut WriterDocCache::new(), &ops, &blobs, true),
        refused
    );
    assert_eq!(state_digest(&passive), state_digest(&owner));
}

#[test]
fn passive_catchup_preserves_intermediate_projection_id_refusals() {
    let (mut ops, blobs) = catchup_fixture(1, 3);
    let key = dohc_engine_collab::DocKey::new("ws", "main", "note-0").unwrap();
    let id = crate::ydoc_apply::ydoc_apply_moment_id(&key, "note-0.txt", "owner", 2);
    let forged = "forged";
    let sha = dohc_engine_storage::hex_sha256(forged.as_bytes());
    ops.push(envelope(
        "other",
        0,
        "moment.append",
        json!({
            "momentId":id,"versionId":"main","objectId":"other","objectCreatedAtMs":1,
            "path":"other.txt","recordedAtMs":2000,"operation":"write",
            "payloadBeforeBlobSha256":null,"payloadBeforePath":null,
            "payloadAfterBlobSha256":sha,"payloadAfterPath":"other.txt",
            "metadata":{"origin":"sync"},"beforePresent":"absent"
        }),
    ));
    let (_root, _, mut owner) = open_store();
    owner
        .write_with(&NoFaults, |tx| -> Result<(), SyncError> {
            tx.execute(
                "INSERT INTO blobs(sha256,byte_length,text) VALUES(?1,6,?2)",
                params![sha, forged],
            )
            .map_err(SyncError::persist)?;
            Ok(())
        })
        .unwrap();
    let refused = replay_fixture(&mut owner, &mut WriterDocCache::new(), &ops, &blobs, false);
    assert_eq!(refused.len(), 1);
    let (_root, _, mut passive) = open_store();
    passive.make_passive().unwrap();
    passive
        .write_with(&NoFaults, |tx| -> Result<(), SyncError> {
            tx.execute(
                "INSERT INTO blobs(sha256,byte_length,text) VALUES(?1,6,?2)",
                params![sha, forged],
            )
            .map_err(SyncError::persist)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        replay_fixture(&mut passive, &mut WriterDocCache::new(), &ops, &blobs, true),
        refused
    );
    assert_eq!(state_digest(&passive), state_digest(&owner));
}

#[test]
fn passive_catchup_keeps_late_intermediate_lineage_artifact_as_history_only() {
    let (mut ops, blobs) = catchup_fixture(1, 3);
    let text = format!("x0{}", "a".repeat(999));
    let sha = dohc_engine_storage::hex_sha256(text.as_bytes());
    ops.push(envelope(
        "owner",
        5,
        "moment.append",
        json!({
            "momentId":"late-artifact","versionId":"main","objectId":"note-0","objectCreatedAtMs":2000,
            "path":"note-0.txt","recordedAtMs":2000,"operation":"write",
            "payloadBeforeBlobSha256":null,"payloadBeforePath":null,
            "payloadAfterBlobSha256":sha,"payloadAfterPath":"note-0.txt",
            "metadata":{"origin":"sync"},"beforePresent":"absent"
        }),
    ));
    let mut expected = None;
    for passive in [false, true] {
        let (_root, _, mut store) = open_store();
        if passive {
            store.make_passive().unwrap();
        }
        store
            .write_with(&NoFaults, |tx| -> Result<(), SyncError> {
                tx.execute(
                    "INSERT INTO blobs(sha256,byte_length,text) VALUES(?1,?2,?3)",
                    params![sha, text.len() as i64, text],
                )
                .map_err(SyncError::persist)?;
                Ok(())
            })
            .unwrap();
        assert!(
            replay_fixture(
                &mut store,
                &mut WriterDocCache::new(),
                &ops,
                &blobs,
                passive
            )
            .is_empty()
        );
        let actual = state_digest(&store);
        match &expected {
            Some(expected) => assert_eq!(&actual, expected),
            None => expected = Some(actual),
        }
    }
}

#[test]
fn passive_catchup_keeps_valid_text_when_pending_dependencies_compact() {
    let (mut ops, mut blobs) = catchup_fixture(1, 63);
    let base = &blobs[ops[1].payload["updateBlobSha256"].as_str().unwrap()];
    let doc = Ydoc::wire();
    doc.apply(base).unwrap();
    for op in &ops[2..] {
        doc.apply(&blobs[op.payload["updateBlobSha256"].as_str().unwrap()])
            .unwrap();
    }
    let missing = doc.plaintext_insert(0, "missing ");
    let dependent = doc.plaintext_insert(0, "dependent ");
    let claim = ops[1].payload["lineageClaimId"]
        .as_str()
        .unwrap()
        .to_owned();
    ops.push(update(65, "note-0", &dependent, &claim, false));
    blobs.insert(dohc_engine_storage::hex_sha256(&dependent), dependent);
    let (_root, _, mut owner) = open_store();
    replay_fixture(&mut owner, &mut WriterDocCache::new(), &ops, &blobs, false);
    let (root, path, mut passive) = open_store();
    passive.make_passive().unwrap();
    for bytes in blobs.values() {
        passive.put_binary_blob(bytes).unwrap();
    }
    let mut cache = WriterDocCache::new();
    for op in &ops {
        crate::router::apply_replication_envelope_in_batch(
            &mut passive,
            &mut cache,
            op,
            &NoFaults,
            &NoLiveLeases,
            true,
        )
        .unwrap();
    }
    let frozen: bool = passive
        .read_with(|conn| {
            conn.query_row(
                "SELECT text IS NOT NULL FROM passive_pending_projection",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert!(
        frozen,
        "freeze before compaction can remove the last valid prefix"
    );
    drop(passive);
    drop(cache);
    let mut passive = EngineStore::open(&path, 3000).unwrap();
    passive.make_passive().unwrap();
    commit_relay_cursor(
        &mut passive,
        "ws",
        &RelayCursor {
            cursor: ops.len() as i64,
            replication_epoch: "epoch-1".into(),
            stream_identity: "stream-1".into(),
            bootstrap_complete: false,
            settlement_report_id: None,
        },
        &NoFaults,
        &NoLiveLeases,
        3000,
    )
    .unwrap();
    assert_eq!(state_digest(&passive), state_digest(&owner));
    let missing_op = update(66, "note-0", &missing, &claim, false);
    let blobs = BTreeMap::from([(dohc_engine_storage::hex_sha256(&missing), missing)]);
    replay_fixture(
        &mut owner,
        &mut WriterDocCache::new(),
        std::slice::from_ref(&missing_op),
        &blobs,
        false,
    );
    replay_fixture(
        &mut passive,
        &mut WriterDocCache::new(),
        std::slice::from_ref(&missing_op),
        &blobs,
        true,
    );
    assert_eq!(state_digest(&passive), state_digest(&owner));
    drop(passive);
    drop(root);
}

#[test]
fn passive_catchup_document_limit_rolls_back_without_changing_owner_admission() {
    for passive in [false, true] {
        let (_root, _, mut store) = open_store();
        seed_replication_version(&mut store, "main", "main");
        if passive {
            store.make_passive().unwrap();
        }
        let outcome=store.write_with(&NoFaults,|tx| -> Result<(),dohc_engine_storage::StorageError> {
            for n in 0..4097 {
                tx.execute("INSERT INTO file_objects(workspace_id,object_id,created_at_ms) VALUES('ws',?1,0)",
                    [format!("file-{n}")]).map_err(dohc_engine_storage::StorageError::persist_public)?;
            }
            Ok(())
        });
        if passive {
            assert_eq!(outcome.unwrap_err().code(), "passive-store-limit");
            assert_eq!(store.table_row_count("file_objects").unwrap(), 0);
        } else {
            assert!(
                matches!(outcome, Ok(TxnOutcome::Committed(()))),
                "{outcome:?}"
            );
        }
    }
}

#[test]
fn passive_catchup_byte_limit_rolls_back_and_rejects_oversized_restart() {
    let (root, path, mut store) = open_store();
    store.make_passive().unwrap();
    let write = |tx: &rusqlite::Transaction<'_>| -> Result<(), dohc_engine_storage::StorageError> {
        tx.execute("INSERT INTO binary_blobs(sha256,byte_length,bytes) VALUES('limit',268435456,zeroblob(268435456))",[])
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
        Ok(())
    };
    let error = store.write_with(&NoFaults, write).unwrap_err();
    assert_eq!(error.code(), "passive-store-limit");
    assert_eq!(store.table_row_count("binary_blobs").unwrap(), 0);
    drop(store);
    let mut owner = EngineStore::open(&path, 3000).unwrap();
    assert!(matches!(
        owner.write_with(&NoFaults, write),
        Ok(TxnOutcome::Committed(()))
    ));
    drop(owner);
    let mut reopened = EngineStore::open(&path, 4000).unwrap();
    assert_eq!(
        reopened.make_passive().unwrap_err().code(),
        "passive-store-limit"
    );
    drop(reopened);
    drop(root);
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
