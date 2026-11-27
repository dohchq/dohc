use super::*;
use dohc_engine_collab::DocKey;
use dohc_engine_collab::ydoc::reading_body_sequence_here;

fn ydoc_row(
    feed: &HostedFeed,
    (origin, seq): (&str, i64),
    (object_id, path): (&str, &str),
    bytes: Vec<u8>,
    claim: &str,
) {
    let sha = dohc_engine_storage::hex_sha256(&bytes);
    feed.blobs.lock().unwrap().insert(sha.clone(), bytes);
    feed.append(envelope(
        origin,
        seq,
        "ydoc.update",
        json!({
            "versionId": "main",
            "objectId": object_id,
            "path": path,
            "contentKind": "richdoc",
            "updateBlobSha256": sha,
            "lineageClaimId": claim,
            "isBaseState": sha == claim
        }),
    ));
}

fn format_two_note(feed: &HostedFeed, seq: (i64, i64), object_id: &str, path: &str) {
    let note = dohc_engine_collab::ydoc::format_two_note_for_test("A note.\n");
    let base = note.encode_full_state();
    let claim = dohc_engine_storage::hex_sha256(&base);
    let edit = crate::moment_apply_tests::format_two_sequence_edit(&note, 7, "z");
    let (owner, writer) = seq;
    ydoc_row(feed, ("owner", owner), (object_id, path), base, &claim);
    feed.create("owner", owner + 1, object_id, path, "A note.\n");
    ydoc_row(feed, ("writer", writer), (object_id, path), edit, &claim);
}

fn kept_of(store: &EngineStore, object_id: &str) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_refused_ydoc_blobs k \
                 JOIN replication_log l USING (workspace_id, origin_id, origin_seq) \
                 WHERE json_extract(l.payload_json,'$.objectId')=?1",
                [object_id],
                |row| row.get(0),
            )
        })
        .unwrap()
}

fn replay_reading(store: &mut EngineStore) -> usize {
    reading_body_sequence_here(|| {
        crate::replay_kept_format_two(store, &mut WriterDocCache::new(), &NoFaults)
    })
    .expect("the replay goes on")
}

fn note_text(store: &EngineStore, object_id: &str) -> String {
    reading_body_sequence_here(|| {
        let key = DocKey::new("ws", "main", object_id).unwrap();
        dohc_engine_collab::load_persisted(store, &key)
            .unwrap()
            .unwrap()
            .doc
            .project(dohc_engine_collab::ContentKind::Richdoc)
            .unwrap()
            .content
    })
}

fn sequence_text(store: &EngineStore, sha: &str) -> String {
    use yrs::updates::decoder::Decode;
    use yrs::{GetString, Transact};
    let bytes = store.get_binary_blob(sha).unwrap().unwrap();
    let raw = yrs::Doc::new();
    let sequence = raw.get_or_insert_text(dohc_engine_collab::ydoc::ROOT_SEQUENCE);
    raw.transact_mut()
        .apply_update(yrs::Update::decode_v1(&bytes).unwrap())
        .unwrap();
    sequence.get_string(&raw.transact())
}

#[test]
fn a_hosted_replica_replays_the_kept_format_two_rows_of_its_documents_in_scope() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    format_two_note(&feed, (1, 0), "doc-a", "a.md");
    format_two_note(&feed, (3, 1), "doc-b", "b.md");
    feed.share("doc-a", "a.md");
    feed.share("doc-b", "b.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    assert_eq!((kept_of(&store, "doc-a"), kept_of(&store, "doc-b")), (2, 2));
    client.transport().unshare("doc-b");
    sync(&client, &mut store);
    assert_eq!(replay_reading(&mut store), 0);
    assert!(!ready(&store, "doc-a"));
    reading_body_sequence_here(|| sync(&client, &mut store));
    assert_eq!((kept_of(&store, "doc-a"), kept_of(&store, "doc-b")), (0, 2));
    assert!(ready(&store, "doc-a"));
    let text = note_text(&store, "doc-a");
    assert!(text.contains('z'), "{text}");
    let commits = store.commit_count_for_harness();
    assert_eq!(replay_reading(&mut store), 0);
    assert_eq!(store.commit_count_for_harness(), commits);
    assert!(ready(&store, "doc-a"));
}

#[test]
fn a_hosted_replica_replays_a_kept_edit_onto_its_archived_note() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    let note = dohc_engine_collab::ydoc::format_two_note_for_test("A note.\n");
    let base = note.encode_full_state();
    let claim = dohc_engine_storage::hex_sha256(&base);
    ydoc_row(&feed, ("owner", 1), ("doc-a", "a.md"), base, &claim);
    feed.create("owner", 2, "doc-a", "a.md", "A note.\n");
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    reading_body_sequence_here(|| sync(&client, &mut store));
    let key = DocKey::new("ws", "main", "doc-a").unwrap();
    let vector = dohc_engine_storage::hex_sha256(&note.encode_state_vector());
    reading_body_sequence_here(|| {
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_collab::archive_active_lineage_in_tx(
                    tx,
                    &key,
                    &claim,
                    &vector,
                    Some(&dohc_engine_storage::hex_sha256(b"A note.\n")),
                    2,
                )
            })
            .unwrap()
    });
    let replacement = dohc_engine_collab::Ydoc::wire();
    replacement
        .rewrite_content_to_markdown(dohc_engine_collab::ContentKind::Richdoc, "Head.\n")
        .unwrap();
    let replacement = replacement.encode_full_state();
    let replacement_claim = dohc_engine_storage::hex_sha256(&replacement);
    let feed = client.transport();
    ydoc_row(
        feed,
        ("replacement", 0),
        ("doc-a", "a.md"),
        replacement,
        &replacement_claim,
    );
    let edit = crate::moment_apply_tests::format_two_sequence_edit(&note, 7, "z");
    ydoc_row(feed, ("writer", 0), ("doc-a", "a.md"), edit, &claim);
    sync(&client, &mut store);
    assert_eq!(kept_of(&store, "doc-a"), 1);
    assert_eq!(replay_reading(&mut store), 0);
    reading_body_sequence_here(|| sync(&client, &mut store));
    assert_eq!(kept_of(&store, "doc-a"), 0);
    assert_eq!(
        count(&store, "SELECT COUNT(*) FROM ydoc_deferred_updates"),
        0
    );
    let archived: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT full_state_blob_sha256 FROM ydoc_inactive_lineages \
                 WHERE object_id='doc-a' AND lineage_claim_id=?1",
                [&claim],
                |row| row.get(0),
            )
        })
        .unwrap();
    let text = sequence_text(&store, &archived);
    assert!(text.contains('z'), "{text}");
    assert!(ready(&store, "doc-a"));
}

#[test]
fn a_hosted_edit_read_before_its_kept_base_applies_once_the_base_replays() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    let note = dohc_engine_collab::ydoc::format_two_note_for_test("A note.\n");
    let base = note.encode_full_state();
    let claim = dohc_engine_storage::hex_sha256(&base);
    let edit = crate::moment_apply_tests::format_two_sequence_edit(&note, 7, "z");
    ydoc_row(&feed, ("writer", 0), ("doc-a", "a.md"), edit, &claim);
    ydoc_row(&feed, ("owner", 1), ("doc-a", "a.md"), base, &claim);
    feed.create("owner", 2, "doc-a", "a.md", "A note.\n");
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    assert_eq!(kept_of(&store, "doc-a"), 2);
    replay_reading(&mut store);
    for _ in 0..2 {
        reading_body_sequence_here(|| sync(&client, &mut store));
    }
    assert_eq!(kept_of(&store, "doc-a"), 0);
    let text = note_text(&store, "doc-a");
    assert_eq!(text.matches('z').count(), 1, "{text}");
    assert!(ready(&store, "doc-a"));
}

#[test]
fn a_kept_base_of_a_returning_note_waits_while_another_spelling_holds_its_path() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    format_two_note(&feed, (1, 0), "doc-a", "a.md");
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync_parking(&client, &mut store);
    assert_eq!(kept_of(&store, "doc-a"), 2);
    let feed = client.transport();
    feed.unshare("doc-a");
    sync_parking(&client, &mut store);
    assert!(is_parked(&store, "doc-a"));
    feed.create("owner", 10, "doc-c", "A.md", "Other.\n");
    feed.share("doc-c", "A.md");
    sync_parking(&client, &mut store);
    feed.share("doc-a", "a.md");
    replay_reading(&mut store);
    reading_body_sequence_here(|| sync_parking(&client, &mut store));
    assert_eq!(kept_of(&store, "doc-a"), 2);
    assert!(hold(&store, "doc-a").is_some());
    assert_eq!(
        count(
            &store,
            "SELECT COUNT(*) FROM snapshots WHERE object_id='doc-a'"
        ),
        0
    );
    feed.unshare("doc-c");
    reading_body_sequence_here(|| sync_parking(&client, &mut store));
    reading_body_sequence_here(|| sync_parking(&client, &mut store));
    assert!(ready(&store, "doc-a"));
    assert_eq!(kept_of(&store, "doc-a"), 0);
    let text = note_text(&store, "doc-a");
    assert!(text.contains('z'), "{text}");
}

fn kept_reasons_of(store: &EngineStore, object_id: &str) -> Vec<String> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT k.reason FROM replication_refused_ydoc_blobs k \
                 JOIN replication_log l USING (workspace_id, origin_id, origin_seq) \
                 WHERE json_extract(l.payload_json,'$.objectId')=?1 ORDER BY k.relay_seq",
            )?
            .query_map([object_id], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()
        })
        .unwrap()
}

#[test]
fn a_hosted_kept_base_refused_for_its_size_keeps_its_claim_and_refuses_a_later_edit() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    let (base, later) = reading_body_sequence_here(|| {
        let note = dohc_engine_collab::ydoc::format_two_note_for_test("A note.\n");
        note.apply(&crate::moment_apply_tests::format_two_sequence_edit(
            &note,
            9,
            &"x".repeat(MAX_TEXT_BYTES),
        ))
        .unwrap();
        (
            note.encode_full_state(),
            crate::moment_apply_tests::format_two_sequence_edit(&note, 13, "q"),
        )
    });
    let claim = dohc_engine_storage::hex_sha256(&base);
    ydoc_row(&feed, ("owner", 1), ("doc-a", "a.md"), base, &claim);
    feed.create("owner", 2, "doc-a", "a.md", "A note.\n");
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    assert_eq!(kept_of(&store, "doc-a"), 1);
    replay_reading(&mut store);
    reading_body_sequence_here(|| sync(&client, &mut store));
    let reasons = kept_reasons_of(&store, "doc-a");
    let marker =
        dohc_engine_collab::read_marker(&store, &DocKey::new("ws", "main", "doc-a").unwrap())
            .unwrap()
            .and_then(|marker| marker.lineage_claim_id);
    let pending = store
        .read_with(|conn| {
            conn.prepare(
                "SELECT 'refusal '||origin_id||'/'||origin_seq||' '||substr(reason_message,1,80) \
                   FROM replication_pending_refusals \
                 UNION ALL SELECT 'kept '||origin_id||'/'||origin_seq||' '||replayed||' '||substr(reason,1,80) \
                   FROM replication_refused_ydoc_blobs \
                 UNION ALL SELECT 'log '||origin_id||'/'||origin_seq||' '||op_kind||' '||COALESCE(apply_disposition,'-') \
                   FROM replication_log \
                 UNION ALL SELECT 'deferred '||origin_id||'/'||origin_seq FROM ydoc_deferred_updates",
            )?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    assert!(
        marker.is_none() && reasons.len() == 1 && reasons[0].contains("projection exceeds"),
        "{marker:?} {reasons:?} {pending:?}"
    );
    ydoc_row(
        client.transport(),
        ("writer", 0),
        ("doc-a", "a.md"),
        later,
        &claim,
    );
    reading_body_sequence_here(|| sync(&client, &mut store));
    assert_eq!(
        count(&store, "SELECT COUNT(*) FROM ydoc_deferred_updates"),
        0
    );
    let refused: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT reason_message FROM replication_pending_refusals WHERE origin_id=?1",
                ["writer"],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(refused, reasons[0]);
}
