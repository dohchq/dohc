//! An open reports whether a resumed lineage holds updates its workspace file
//! may not. The desktop settles only then, so a crash-kept edit reaches the
//! file and a clean reopen writes nothing.

use dohc_engine_collab::{ContentKind, DocKey, Regime};
use dohc_engine_runtime::{
    ActorHandle, CancellationToken, NoFaults, WorkspaceSupervisor, YdocOpenState,
};
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
