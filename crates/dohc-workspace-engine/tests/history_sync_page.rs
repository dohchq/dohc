use dohc_engine_domain::{HistoryMomentPosition, NoFaults, VersionedTextStore, WriteText};
use dohc_engine_storage::{EngineStore, hex_sha256};
use dohc_engine_sync::{NoLiveLeases, ReplicationEnvelope, apply_moment_envelope};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use serde_json::json;

#[test]
fn an_old_sync_arrival_is_fenced_out_of_the_chain_and_visible_on_refresh() {
    let dir = ScratchDir::new().unwrap();
    let mut store = EngineStore::open(&engine_db_path(&dir).unwrap(), 1).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1, &NoFaults)
        .unwrap();
    for i in 0..4 {
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "ws".into(),
                    version_id: "main".into(),
                    object_id: format!("object-{i}"),
                    path: format!("{i}.md"),
                    text: "local".into(),
                    moment_id: format!("local-{i}"),
                    metadata_origin: "user".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 100 + i,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
    }
    let mut page = VersionedTextStore::new(&mut store)
        .history_page("ws", None, None, None, 1, None)
        .unwrap();
    let first = page.moments[0].clone();
    let mut cursor = page.cursor.clone();
    cursor.text = Some(HistoryMomentPosition {
        recorded_at_ms: first.recorded_at_ms,
        moment_order: first.moment_order,
    });
    let sha = hex_sha256(b"remote");
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO blobs(sha256,byte_length,text) VALUES(?1,6,'remote')",
                [&sha],
            )
        })
        .unwrap();
    let envelope = ReplicationEnvelope {
        workspace_id: "ws".into(),
        origin_id: "peer".into(),
        origin_seq: 0,
        op_kind: "moment.append".into(),
        recorded_at_ms: 50,
        relay_seq: None,
        settlement_admission: None,
        admitted_author_snapshot: None,
        payload: json!({"momentId":"old-import","versionId":"main","objectId":"remote-object","objectCreatedAtMs":1,"path":"remote.md","recordedAtMs":50,"operation":"write","payloadBeforeBlobSha256":null,"payloadBeforePath":null,"payloadAfterBlobSha256":sha,"payloadAfterPath":"remote.md","metadata":{"origin":"sync"},"beforePresent":"absent"}),
    };
    apply_moment_envelope(
        &mut store,
        &envelope,
        &NoFaults,
        &NoLiveLeases,
        &dohc_engine_collab::live_update_application::ReleasedTails::default(),
    )
    .unwrap();
    let mut ids = vec![first.moment_id];
    loop {
        page = VersionedTextStore::new(&mut store)
            .history_page("ws", None, None, None, 1, Some(cursor.clone()))
            .unwrap();
        let Some(row) = page.moments.first() else {
            break;
        };
        ids.push(row.moment_id.clone());
        cursor.text = Some(HistoryMomentPosition {
            recorded_at_ms: row.recorded_at_ms,
            moment_order: row.moment_order,
        });
    }
    assert_eq!(ids, vec!["local-3", "local-2", "local-1", "local-0"]);
    let refreshed = VersionedTextStore::new(&mut store)
        .history_page("ws", None, None, None, 50, None)
        .unwrap();
    let imported = refreshed
        .moments
        .iter()
        .find(|m| m.moment_id == "old-import")
        .unwrap();
    assert_eq!(imported.recorded_at_ms, 50);
    assert!(imported.moment_order > page.cursor.text_fence);
    assert_eq!(refreshed.moments.last().unwrap().moment_id, "old-import");
}
