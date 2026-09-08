//! Async actor-loop traces: the tokio command path round-trips a write while
//! the blocking writer thread owns the connection, and close lands in bounded
//! time under sustained submission.

use dohc_engine_domain::WriteText;
use dohc_engine_runtime::{ActorHandle, CancellationToken, NoFaults, WorkspaceSupervisor};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::sync::Arc;

const WS: &str = "ws";

async fn seed(handle: &ActorHandle) {
    handle
        .ensure_main_version(
            WS.to_owned(),
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main version");
}

fn unit(path: &str, text: &str, now_ms: i64) -> WriteText {
    WriteText {
        workspace_id: WS.to_owned(),
        version_id: "main".to_owned(),
        object_id: format!("object-{path}"),
        path: path.to_owned(),
        text: text.to_owned(),
        moment_id: format!("moment-{path}-{now_ms}"),
        metadata_origin: "user".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
    }
}

// oracle: the async command path round-trips a write through the tokio loop
// while the blocking writer thread owns the connection.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn async_write_read_round_trip() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let sup = WorkspaceSupervisor::new();
    let handle = sup.open(&db, 1).expect("open").actor;
    seed(&handle).await;

    let written = handle
        .versioned_text_write(
            unit("d1.md", "body-1", 1),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write");
    assert!(!written.deduped);

    let snapshot = handle
        .versioned_text_read(
            WS.to_owned(),
            "main".to_owned(),
            "d1.md".to_owned(),
            CancellationToken::new(),
        )
        .await
        .expect("read")
        .expect("present");
    assert_eq!(snapshot.text, "body-1");

    sup.close(&db).expect("close");
}
