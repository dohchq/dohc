//! The idempotent settle no-op must verify OWNERSHIP, not just content: a
//! path rebound to another object whose blob equals this session's settled
//! sha passes the stale-head guard, and only the object-id check separates
//! "my settled head" from "someone else's identical bytes".

use dohc_engine_collab::{ContentKind, Regime};
use dohc_engine_domain::{RenameTextFile, VersionedTextStore};
use dohc_engine_runtime::{
    CancellationToken, CaptureIngest, NoFaults, RuntimeError, SelfWriteRecorder,
    WorkspaceSupervisor,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::ScratchDir;
use std::sync::Arc;

struct NoRecorder;

impl SelfWriteRecorder for NoRecorder {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn idempotent_settle_refuses_a_rebound_path_even_with_identical_content() {
    const WS: &str = "ws-settle-rebind";
    const PATH: &str = "notes/own.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");

    // The session creates and settles PATH ("same text").
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor");
    let state = handle
        .ydoc_open_state(
            WS.to_owned(),
            10,
            true,
            None,
            "main".to_owned(),
            PATH.to_owned(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("open");
    let key = state.key.clone();
    let update = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "same text");
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            update,
            None,
            true,
            20,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("record");
    handle
        .ydoc_settle(
            scratch.path().to_path_buf(),
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            state.head_blob_sha256.clone(),
            "session-rebind".to_owned(),
            Arc::new(NoRecorder),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("first settle");
    supervisor.close(&db).expect("close actor");

    // Rebind: rename the settled file away, then capture identical bytes at
    // the old path — capture's locked resolution mints a DISAMBIGUATED object
    // (the derived id is live at the new alias), so PATH's head is now
    // another object with the SAME blob sha.
    {
        let mut store = EngineStore::open(&db, 100).expect("open store");
        VersionedTextStore::new(&mut store)
            .rename_text_file(
                &RenameTextFile {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    from_path: PATH.to_owned(),
                    to_path: "notes/moved.md".to_owned(),
                    moment_id: "moment-rebind-rename".to_owned(),
                    metadata_origin: "agent".to_owned(),
                    author_json: None,
                    now_ms: 110,
                },
                &NoFaults,
            )
            .expect("rename");
    }
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 2).expect("reopen actor");
    let rival = handle
        .capture_ingest(
            CaptureIngest {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: PATH.to_owned(),
                text: "same text".to_owned(),
                metadata_origin: "capture".to_owned(),
                author_json: None,
                now_ms: 120,
                request_id: Some("rebind-rival".to_owned()),
                claim_foreign_head: true,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("rival capture");
    assert_ne!(
        rival.snapshot.object_id, key.object_id,
        "the fixture must actually rebind the path to a different object"
    );
    assert_eq!(
        rival.snapshot.text, "same text",
        "the rival head must be byte-identical"
    );

    // Mutation check: drop the hoisted `current.object_id != key.object_id`
    // refusal ahead of the idempotent no-op in ydoc_settle_on_store — this
    // settle then reports SUCCESS with the rival owner's snapshot and the
    // refusal assertion fails.
    let refused = handle
        .ydoc_settle(
            scratch.path().to_path_buf(),
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            None,
            "session-rebind".to_owned(),
            Arc::new(NoRecorder),
            130,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect_err("settling a rebound path must refuse even when bytes match");
    assert!(
        matches!(
            refused,
            RuntimeError::Domain(dohc_engine_domain::DomainError::ConflictStaleTarget)
        ),
        "expected ConflictStaleTarget, got {refused:?}"
    );
    supervisor.close(&db).expect("close actor");
}
