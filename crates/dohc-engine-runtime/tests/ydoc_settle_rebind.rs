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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reopening_a_pruned_lineage_over_a_newer_head_settles_cleanly() {
    const WS: &str = "ws-prune-reseed";
    const PATH: &str = "notes/prune.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");

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
    let update = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "v1");
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
            "session-prune".to_owned(),
            Arc::new(NoRecorder),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("first settle");
    // Prune-close: settled lineage, local-only → CRDT rows drop, marker stays.
    handle
        .ydoc_close_session(
            key.clone(),
            40,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("prune close");

    // The head advances WITHOUT a session: an external disk edit ingested by
    // capture (disk + DB stay consistent).
    std::fs::write(scratch.path().join(PATH), "external edit").expect("disk edit");
    handle
        .capture_ingest(
            CaptureIngest {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: PATH.to_owned(),
                text: "external edit".to_owned(),
                metadata_origin: "capture".to_owned(),
                author_json: None,
                now_ms: 50,
                request_id: Some("prune-external".to_owned()),
                claim_foreign_head: true,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("external capture");

    // Reopen: the pruned lineage reseeds from the NEW head, and its first
    // settle must succeed. Mutation check: drop `last_settled_sha = NULL`
    // from the prune UPDATE in `close_session` — the settle expectation then
    // trails at the v1 sha and this settle refuses ConflictStaleTarget.
    let reopened = handle
        .ydoc_open_state(
            WS.to_owned(),
            60,
            true,
            None,
            "main".to_owned(),
            PATH.to_owned(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("reopen");
    assert!(!reopened.lineage_existing, "pruned lineage reseeds");
    let update = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "reseeded body");
    handle
        .ydoc_record_update(
            reopened.key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            update,
            None,
            true,
            70,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("reseed record");
    let settled = handle
        .ydoc_settle(
            scratch.path().to_path_buf(),
            reopened.key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            reopened.head_blob_sha256.clone(),
            "session-prune-2".to_owned(),
            Arc::new(NoRecorder),
            80,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("post-prune settle must succeed");
    assert_eq!(settled.markdown, "reseeded body");
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(PATH)).expect("disk"),
        "reseeded body"
    );
    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_retired_local_only_doc_reopens_as_absent() {
    const WS: &str = "ws-retired-reopen";
    const PATH: &str = "notes/retired.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");

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
    let update = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "settled once");
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
            "session-retire".to_owned(),
            Arc::new(NoRecorder),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("settle");
    // Workspace teardown WITHOUT ydoc.close: the lineage (rows +
    // last_settled_sha) survives. The user then deletes the file and the
    // disk-driven retire destroys the head.
    std::fs::remove_file(scratch.path().join(PATH)).expect("delete artifact");
    handle
        .capture_retire(
            dohc_engine_runtime::CaptureRetire {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: PATH.to_owned(),
                now_ms: 40,
                request_id: Some("retire-artifact".to_owned()),
                only_if_text_head: false,
                only_if_capture_origin: true,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("retire");

    // Reopen: the deleted document must NOT resurrect, and the fresh
    // create-flow must settle cleanly. Mutation check: drop the
    // retired-lineage clearing in ydoc_open_state_on_store — the open
    // reports lineage EXISTING and the settle below wedges
    // ConflictStaleTarget on the retained last_settled_sha.
    let reopened = handle
        .ydoc_open_state(
            WS.to_owned(),
            50,
            true,
            None,
            "main".to_owned(),
            PATH.to_owned(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("reopen");
    assert!(
        !reopened.lineage_existing,
        "a retired local-only doc reopens as absent"
    );
    let update = dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "fresh body");
    handle
        .ydoc_record_update(
            reopened.key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            update,
            None,
            true,
            60,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("fresh record");
    let settled = handle
        .ydoc_settle(
            scratch.path().to_path_buf(),
            reopened.key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            reopened.head_blob_sha256.clone(),
            "session-retire-2".to_owned(),
            Arc::new(NoRecorder),
            70,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("fresh settle succeeds");
    assert_eq!(settled.markdown, "fresh body");
    supervisor.close(&db).expect("close actor");
}
