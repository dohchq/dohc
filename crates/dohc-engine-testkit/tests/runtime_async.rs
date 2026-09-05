//! Async actor-loop traces: the tokio command path round-trips a write while
//! the blocking writer thread owns the connection, and close lands in bounded
//! time under sustained submission.

use dohc_engine_domain::WriteText;
use dohc_engine_runtime::{ActorHandle, CancellationToken, NoFaults, WorkspaceSupervisor};
use dohc_engine_testkit::ScratchDir;
use std::sync::Arc;
use std::time::{Duration, Instant};

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
    let db = scratch.engine_db_path().expect("db");
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

// oracle: close() lands in bounded time even under sustained concurrent
// submission — the reserved Close slot cannot be starved by tokio's fair waiter
// queue (regression for the try_send-spin design).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_returns_promptly_under_sustained_submission() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let sup = Arc::new(WorkspaceSupervisor::new());
    let handle = sup.open(&db, 1).expect("open").actor;
    seed(&handle).await;

    // Many producers hammer the writer; when the bounded queue is full they
    // park in the fair send() queue, exactly the condition that could starve a
    // spinning close().
    let mut producers = Vec::new();
    for t in 0..16u64 {
        let handle = handle.clone();
        producers.push(tokio::spawn(async move {
            let mut i = 0u64;
            loop {
                let write = unit(&format!("t{t}-d{i}.md"), "x", i as i64 + 1);
                // Stop once the actor is gone (channel closed by close()).
                if handle
                    .versioned_text_write(write, Arc::new(NoFaults), CancellationToken::new())
                    .await
                    .is_err()
                {
                    break;
                }
                i += 1;
            }
        }));
    }

    // Let the producers saturate the queue.
    tokio::time::sleep(Duration::from_millis(100)).await;

    // close() joins the worker, so run it on a blocking thread; it must return
    // quickly despite the sustained load.
    let started = Instant::now();
    let sup2 = Arc::clone(&sup);
    let db2 = db.clone();
    tokio::task::spawn_blocking(move || sup2.close(&db2).expect("close"))
        .await
        .expect("join close");
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(5),
        "close starved under sustained submission: {elapsed:?}"
    );

    // Producers observe the actor gone and finish.
    for p in producers {
        let _ = p.await;
    }
}
