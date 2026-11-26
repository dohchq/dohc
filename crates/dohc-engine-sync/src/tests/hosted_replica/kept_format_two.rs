use super::*;
use dohc_engine_collab::ydoc::reading_body_sequence_here;

fn format_two_note(feed: &HostedFeed, seq: (i64, i64), object_id: &str, path: &str) {
    let note = dohc_engine_collab::ydoc::format_two_note_for_test("A note.\n");
    let base = note.encode_full_state();
    let claim = dohc_engine_storage::hex_sha256(&base);
    let edit = crate::moment_apply_tests::format_two_sequence_edit(&note, 7, "z");
    let update = |origin: &str, seq: i64, bytes: Vec<u8>| {
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
    };
    let (owner, writer) = seq;
    update("owner", owner, base);
    feed.create("owner", owner + 1, object_id, path, "A note.\n");
    update("writer", writer, edit);
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

#[test]
fn a_hosted_replica_keeps_its_kept_format_two_rows_when_it_reads_format_two() {
    let (_scratch, _path, mut store) = hosted_store();
    let feed = HostedFeed::new();
    feed.append(envelope("owner", 0, "workspace.init", json!({})));
    format_two_note(&feed, (1, 0), "doc-a", "a.md");
    feed.share("doc-a", "a.md");
    let client = RelaySyncClient::new(feed);
    sync(&client, &mut store);
    assert_eq!(kept_of(&store, "doc-a"), 2);
    for _ in 0..2 {
        let replayed = reading_body_sequence_here(|| {
            crate::replay_kept_format_two(&mut store, &mut WriterDocCache::new(), &NoFaults)
        })
        .expect("the replay goes on");
        assert_eq!(replayed, 0);
        reading_body_sequence_here(|| sync(&client, &mut store));
        assert_eq!(kept_of(&store, "doc-a"), 2);
    }
}
