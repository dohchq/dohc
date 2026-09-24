//! An open reports whether a resumed lineage holds updates its workspace file
//! may not. The desktop settles only then, so a crash-kept edit reaches the
//! file and a clean reopen writes nothing.

use dohc_engine_collab::{ContentKind, DocKey, Regime};
use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_engine_runtime::{
    ActorHandle, CancellationToken, CaptureIngest, NoFaults, WorkspaceSupervisor, YdocOpenState,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_sync::{NoLiveLeases, ReplicationEnvelope, apply_ydoc_envelope};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::sync::Arc;

const WS: &str = "ws-open-unsettled";
const PATH: &str = "notes/unsettled.md";

async fn open(handle: &ActorHandle, now_ms: i64) -> YdocOpenState {
    handle
        .ydoc_open_state(
            WS.to_owned(),
            now_ms,
            true,
            None,
            "main".to_owned(),
            PATH.to_owned(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("open")
}

async fn record(handle: &ActorHandle, key: &DocKey, update: Vec<u8>, now_ms: i64, first: bool) {
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            update,
            None,
            None,
            None,
            first,
            None,
            None,
            now_ms,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("record");
}

async fn settle(
    handle: &ActorHandle,
    root: &std::path::Path,
    state: &YdocOpenState,
    now_ms: i64,
) -> String {
    handle
        .ydoc_settle(
            root.to_path_buf(),
            state.key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            state.lineage_claim_id.clone(),
            state.head_blob_sha256.clone(),
            format!("session-{now_ms}"),
            Arc::new(()),
            now_ms,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("settle")
        .settled()
        .expect("settled")
        .sha256
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_open_reports_a_lineage_ahead_of_its_file_until_a_settle_covers_it() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let disk = || std::fs::read_to_string(scratch.path().join(PATH)).unwrap_or_default();

    let fresh = open(&handle, 10).await;
    assert!(!fresh.lineage_existing);
    assert!(
        !fresh.unsettled,
        "nothing to settle before the first update"
    );
    let key = fresh.key.clone();

    // An edit the engine journaled and never settled: a crash leaves exactly
    // this, and the next open must say so.
    let doc = dohc_engine_collab::Ydoc::wire();
    record(&handle, &key, doc.plaintext_insert(0, "typed"), 20, true).await;
    let crashed = open(&handle, 30).await;
    assert!(crashed.lineage_existing);
    assert!(
        crashed.unsettled,
        "the file does not have the journaled edit"
    );

    // The settle writes the file; the lineage is then not ahead of it.
    settle(&handle, scratch.path(), &crashed, 40).await;
    assert_eq!(disk(), "typed");
    let settled = open(&handle, 50).await;
    assert!(settled.lineage_existing);
    assert!(!settled.unsettled, "a clean reopen has nothing to settle");

    // A deletion leaves the state vector where it was. It still counts.
    record(&handle, &key, doc.plaintext_delete(0, 2), 60, false).await;
    let deleted = open(&handle, 70).await;
    assert!(deleted.unsettled, "a deletion the file lacks is unsettled");

    // Put the text back before settling: the projection matches what the
    // file already holds, and the no-write settle still records it.
    record(&handle, &key, doc.plaintext_insert(0, "ty"), 80, false).await;
    let restored = open(&handle, 90).await;
    assert!(restored.unsettled);
    settle(&handle, scratch.path(), &restored, 100).await;
    assert_eq!(disk(), "typed");
    assert!(!open(&handle, 110).await.unsettled);

    supervisor.close(&db).expect("close actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pruned_lineage_forgets_its_settle() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;

    let state = open(&handle, 10).await;
    let doc = dohc_engine_collab::Ydoc::wire();
    record(
        &handle,
        &state.key,
        doc.plaintext_insert(0, "one"),
        20,
        true,
    )
    .await;
    settle(&handle, scratch.path(), &state, 30).await;
    handle
        .ydoc_close_session(
            state.key.clone(),
            40,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("prune close");

    // The prune rewinds the head to zero. A new lineage that grows back to the
    // settled update count must not inherit the old settle.
    let reopened = open(&handle, 50).await;
    assert!(!reopened.lineage_existing);
    let doc = dohc_engine_collab::Ydoc::wire();
    record(
        &handle,
        &reopened.key,
        doc.plaintext_insert(0, "two"),
        60,
        true,
    )
    .await;
    assert!(open(&handle, 70).await.unsettled);

    supervisor.close(&db).expect("close actor");
}

// A capture of an outside edit folds into a lineage the engine kept. The file
// already holds the folded text, so the next open has nothing to settle.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_captured_outside_edit_leaves_nothing_to_settle_on_reopen() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;

    let state = open(&handle, 10).await;
    let doc = dohc_engine_collab::Ydoc::wire();
    record(
        &handle,
        &state.key,
        doc.plaintext_insert(0, "typed"),
        20,
        true,
    )
    .await;
    settle(&handle, scratch.path(), &state, 30).await;
    // No close, as a crash leaves it: the lineage stays.

    std::fs::write(scratch.path().join(PATH), "written outside").expect("outside edit");
    handle
        .capture_ingest(
            CaptureIngest {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: PATH.to_owned(),
                text: "written outside".to_owned(),
                metadata_origin: "capture".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 40,
                request_id: Some("outside-edit".to_owned()),
                claim_foreign_head: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture folds the outside edit");

    let reopened = open(&handle, 50).await;
    assert!(reopened.lineage_existing);
    assert!(
        !reopened.unsettled,
        "the file already holds the folded text"
    );
    supervisor.close(&db).expect("close actor");
}

// A collaborator's update applied while the document is closed writes its
// projection through a materialization job. Until that job lands the file is
// behind; once it lands, the next open has nothing to settle.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_remote_update_applied_while_closed_settles_nothing_once_written() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let path = scratch.path().join(PATH);
    std::fs::create_dir_all(path.parent().expect("parent")).expect("notes dir");
    std::fs::write(&path, "client").expect("seed disk");
    {
        let mut store = EngineStore::open(&db, 1).expect("open store");
        let mut versions = VersionedTextStore::new(&mut store);
        versions
            .ensure_main_version(WS, "main", 1, &NoFaults)
            .expect("main version");
        versions
            .write_text(
                &WriteText {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "remote-object".to_owned(),
                    path: PATH.to_owned(),
                    text: "client".to_owned(),
                    moment_id: "remote-head".to_owned(),
                    metadata_origin: "test".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("seed head");
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.plaintext_insert(0, "client");
        let base_sha = store
            .put_binary_blob(&doc.encode_full_state())
            .expect("base blob");
        let envelope = |seq: i64, blob: &str, base: bool| ReplicationEnvelope {
            workspace_id: WS.to_owned(),
            origin_id: "peer".to_owned(),
            origin_seq: seq,
            relay_seq: Some(seq),
            op_kind: "ydoc.update".to_owned(),
            payload: serde_json::json!({
                "versionId": "main",
                "objectId": "remote-object",
                "path": PATH,
                "contentKind": "plaintext",
                "updateBlobSha256": blob,
                "lineageClaimId": base_sha,
                "isBaseState": base
            }),
            recorded_at_ms: 3 + seq,
        };
        let mut cache = dohc_engine_collab::WriterDocCache::new();
        apply_ydoc_envelope(
            &mut store,
            &mut cache,
            &envelope(0, &base_sha, true),
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("apply base");
        let remote_sha = store
            .put_binary_blob(&doc.plaintext_insert(6, " and peer"))
            .expect("remote blob");
        apply_ydoc_envelope(
            &mut store,
            &mut cache,
            &envelope(1, &remote_sha, false),
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("apply remote update");
    }

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 10).expect("open actor").actor;
    let pending = open(&handle, 11).await;
    assert!(
        pending.unsettled,
        "the collaborator's text is not on disk yet"
    );
    handle
        .materialize_replay_pending(scratch.path().to_path_buf(), WS.to_owned(), 12)
        .await
        .expect("write pending jobs");
    assert_eq!(
        std::fs::read_to_string(&path).expect("disk"),
        "client and peer"
    );
    let written = open(&handle, 13).await;
    assert!(written.lineage_existing);
    assert!(!written.unsettled, "the file holds the collaborator's text");
    supervisor.close(&db).expect("close actor");
}
