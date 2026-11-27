use super::*;
use dohc_engine_collab::ydoc::{format_two_note_for_test, reading_body_sequence_here};
use dohc_engine_storage::{NoFaults, StorageError, hex_sha256};
use dohc_engine_sync::ReplicationEnvelope;
use dohc_engine_testkit::ScratchDir;

const KEPT: &str = "SELECT COUNT(*) FROM replication_refused_ydoc_blobs";

fn keep_a_format_two_note(mut store: EngineStore) {
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1_300, &NoFaults)
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id, object_id, created_at_ms) \
                 VALUES ('ws', 'note', 1_400)",
                [],
            )
            .map_err(StorageError::persist_public)
        })
        .unwrap();
    let base = format_two_note_for_test("A note.\n").encode_full_state();
    let claim = hex_sha256(&base);
    store.put_binary_blob(&base).unwrap();
    let envelope = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: "ws".into(),
        origin_id: "peer".into(),
        origin_seq: 0,
        relay_seq: Some(1),
        op_kind: "ydoc.update".into(),
        payload: serde_json::json!({
            "versionId": "main",
            "objectId": "note",
            "path": "notes/note.md",
            "contentKind": "richdoc",
            "updateBlobSha256": claim,
            "lineageClaimId": claim,
            "isBaseState": true
        }),
        recorded_at_ms: 2_000,
    };
    dohc_engine_sync::apply_replication_envelope(
        &mut store,
        &mut WriterDocCache::new(),
        &envelope,
        &NoFaults,
        &dohc_engine_sync::NoLiveLeases,
    )
    .unwrap();
    assert_eq!(
        store
            .read_with(|conn| conn.query_row(KEPT, [], |row| row.get::<_, i64>(0)))
            .unwrap(),
        1
    );
}

fn kept_after_open(passive: bool) -> i64 {
    let scratch = ScratchDir::new().unwrap();
    let db = scratch.path().join("engine.db");
    keep_a_format_two_note(if passive {
        EngineStore::open_passive(&db, 0, None, None).unwrap()
    } else {
        EngineStore::open(&db, 0).unwrap()
    });
    let identity = EngineDbIdentity::of_existing(&db).unwrap();
    let mut actor = reading_body_sequence_here(|| {
        if passive {
            WorkspaceActor::spawn_passive(db, identity, 1, 0, None, None, Default::default())
        } else {
            WorkspaceActor::spawn(db, identity, 1, 0, None, Default::default())
        }
    })
    .unwrap();
    let kept = actor
        .handle()
        .run_blocking(|store, _| {
            Ok(store
                .read_with(|conn| conn.query_row(KEPT, [], |row| row.get::<_, i64>(0)))
                .unwrap())
        })
        .unwrap();
    actor.close().unwrap();
    kept
}

#[test]
fn a_read_write_open_replays_a_kept_format_two_note_before_ready() {
    assert_eq!(kept_after_open(false), 0);
}

#[test]
fn a_passive_open_replays_a_kept_format_two_note_before_ready() {
    assert_eq!(kept_after_open(true), 0);
}
