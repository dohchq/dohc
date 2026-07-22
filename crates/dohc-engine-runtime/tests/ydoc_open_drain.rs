//! ydoc.open's deferred drain must be gated on the key the caller's lease
//! covers: when the path's owner changes between the RPC's probe and the
//! post-lease read, the derived key belongs to a DIFFERENT object and the
//! drain would mutate that doc behind any live editor of it.

use dohc_engine_collab::{ContentKind, DocKey, Regime};
use dohc_engine_runtime::{CancellationToken, CaptureIngest, NoFaults, WorkspaceSupervisor};
use dohc_engine_storage::EngineStore;
use dohc_engine_sync::{LeaseProbe, ReplicationEnvelope, apply_ydoc_envelope};
use dohc_engine_testkit::ScratchDir;
use std::sync::Arc;

struct AlwaysLive;

impl LeaseProbe for AlwaysLive {
    fn is_live(&self, _key: &DocKey) -> bool {
        true
    }
}

fn ydoc_update_rows(db: &std::path::Path) -> i64 {
    let store = EngineStore::open(db, 9_000).expect("open store");
    store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| {
                row.get::<_, i64>(0)
            })
        })
        .expect("count")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn open_only_drains_deferred_updates_for_the_expected_key() {
    const WS: &str = "ws-drain-gate";
    const PATH: &str = "notes/live.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");

    // A captured head gives the path a real owner object.
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor");
    let written = handle
        .capture_ingest(
            CaptureIngest {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: PATH.to_owned(),
                text: "before".to_owned(),
                metadata_origin: "capture".to_owned(),
                author_json: None,
                now_ms: 10,
                request_id: Some("drain-gate-seed".to_owned()),
                claim_foreign_head: true,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture");
    let object_id = written.snapshot.object_id.clone();
    supervisor.close(&db).expect("close actor");

    // Park a replicated envelope for that object while its lease reads live:
    // the update is acked into the log but deferred, exactly the state a
    // crashed session leaves behind.
    let key = DocKey::new(WS, "main", &object_id).expect("key");
    {
        let mut store = EngineStore::open(&db, 100).expect("open store");
        dohc_engine_collab::ensure_marker(
            &mut store,
            &key,
            ContentKind::Plaintext,
            Regime::Replicated,
            &NoFaults,
            110,
        )
        .expect("replicated marker");
        let update_bytes = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "parked");
        let blob_sha = store.put_binary_blob(&update_bytes).expect("blob");
        let envelope = ReplicationEnvelope {
            workspace_id: WS.to_owned(),
            origin_id: "peer".to_owned(),
            origin_seq: 0,
            op_kind: "ydoc.update".to_owned(),
            payload: serde_json::json!({
                "versionId": "main",
                "objectId": object_id,
                "path": PATH,
                "contentKind": "plaintext",
                "updateBlobSha256": blob_sha,
                "isBaseState": false
            }),
            recorded_at_ms: 120,
        };
        apply_ydoc_envelope(&mut store, &envelope, &NoFaults, &AlwaysLive).expect("park");
    }
    assert_eq!(ydoc_update_rows(&db), 0, "the envelope starts parked");

    // An open whose lease covers a DIFFERENT key must not drain. Mutation
    // check: drop the `expected_key_matches` gate in ydoc_open_state_on_store
    // — this open then drains the parked row and the assertion below fails.
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 2).expect("reopen actor");
    let wrong_key = DocKey::new(WS, "main", "object-someone-else").expect("wrong key");
    handle
        .ydoc_open_state(
            WS.to_owned(),
            200,
            true,
            Some(wrong_key),
            "main".to_owned(),
            PATH.to_owned(),
            None,
            CancellationToken::new(),
        )
        .await
        .expect("mismatched open still reads state");
    supervisor.close(&db).expect("close actor");
    assert_eq!(
        ydoc_update_rows(&db),
        0,
        "a mismatched expected key must not drain another key's deferred rows"
    );

    // The same open with the MATCHING expected key drains the parked update.
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 3).expect("reopen actor");
    handle
        .ydoc_open_state(
            WS.to_owned(),
            300,
            true,
            Some(key.clone()),
            "main".to_owned(),
            PATH.to_owned(),
            None,
            CancellationToken::new(),
        )
        .await
        .expect("matching open");
    supervisor.close(&db).expect("close actor");
    assert_eq!(
        ydoc_update_rows(&db),
        1,
        "the matching key's open must drain the parked update"
    );
}
