//! Async actor-loop traces (CAL-2 calibration signal): the tokio command path,
//! cooperative cancellation BETWEEN bounded units leaving consistent state, and
//! a deadline that trips to `DEADLINE_EXCEEDED` without tearing an in-flight
//! unit. The synchronous CAL-1 traces (see `runtime_actor.rs`) still exercise
//! the blocking call sites; these drive the same actor through its async API.

use dohc_engine_runtime::{
    CancellationToken, CompoundWrite, FaultInjector, FaultPoint, NoFaults, WorkspaceSupervisor,
    WriteOutcome,
};
use dohc_engine_testkit::{GateFaults, ScratchDir};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn unit(i: usize) -> CompoundWrite {
    CompoundWrite {
        request_id: format!("r{i}"),
        doc_id: format!("d{i}"),
        body: format!("body-{i}"),
        op_kind: "text.write".to_owned(),
        now_ms: i as i64,
    }
}

// oracle: the async command path round-trips a write through the tokio loop
// while the blocking writer thread owns the connection.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn async_write_read_round_trip() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let sup = WorkspaceSupervisor::new();
    let handle = sup.open(&db, 1).expect("open");

    let outcome = handle
        .write_async(unit(1), Arc::new(NoFaults))
        .await
        .expect("write");
    assert_eq!(
        outcome,
        WriteOutcome::Acked {
            seq: 1,
            deduped: false
        }
    );

    let doc = handle
        .read_async("d1")
        .await
        .expect("read")
        .expect("present");
    assert_eq!(doc.body, "body-1");

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
    let handle = sup.open(&db, 1).expect("open");

    // Many producers hammer write_async; when the bounded queue is full they
    // park in the fair send() queue, exactly the condition that could starve a
    // spinning close().
    let mut producers = Vec::new();
    for t in 0..16u64 {
        let handle = handle.clone();
        producers.push(tokio::spawn(async move {
            let mut i = 0u64;
            loop {
                let w = CompoundWrite {
                    request_id: format!("t{t}-{i}"),
                    doc_id: format!("t{t}-d{i}"),
                    body: "x".to_owned(),
                    op_kind: "text.write".to_owned(),
                    now_ms: i as i64,
                };
                // Stop once the actor is gone (channel closed by close()).
                if handle.write_async(w, Arc::new(NoFaults)).await.is_err() {
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

// oracle: a long op cancels cooperatively at a between-unit boundary and leaves
// exactly the committed prefix (consistent state). The gate deterministically
// parks the worker inside unit 0's transaction so the cancel lands at the next
// boundary — no timing race.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_stops_between_units_leaving_consistent_state() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let sup = WorkspaceSupervisor::new();
    let handle = sup.open(&db, 1).expect("open");

    let units: Vec<CompoundWrite> = (0..5).map(unit).collect();
    let gate = GateFaults::at(FaultPoint::StorageBeforePersist);
    let gate_faults: Arc<dyn FaultInjector> = gate.clone();
    let token = CancellationToken::new();

    // Drive the run concurrently; it parks inside unit 0 at the gate.
    let run = {
        let handle = handle.clone();
        let token = token.clone();
        tokio::spawn(async move { handle.run_units(units, gate_faults, token).await })
    };

    // Wait (off the async threads) until the worker is parked in unit 0.
    let gate_wait = gate.clone();
    tokio::task::spawn_blocking(move || gate_wait.wait_until_reached())
        .await
        .expect("join wait");

    // Cancel at the boundary, then release the gate so unit 0 commits and the
    // loop hits the cancelled token before unit 1.
    token.cancel();
    gate.release();

    let outcome = run.await.expect("join run").expect("run ok");
    assert_eq!(outcome.committed, 1, "exactly the committed prefix");
    assert!(outcome.cancelled, "run reports the cooperative stop");

    // Consistency: unit 0 is durable, unit 1 never ran.
    assert!(handle.read_async("d0").await.expect("read").is_some());
    assert!(handle.read_async("d1").await.expect("read").is_none());

    sup.close(&db).expect("close");
}

// oracle: a deadline trips to DEADLINE_EXCEEDED while a unit is mid-transaction;
// the in-flight unit still runs to COMMIT (never torn), and the store stays
// consistent (`PORTING.md` §12).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deadline_trips_without_tearing_a_unit() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let sup = WorkspaceSupervisor::new();
    let handle = sup.open(&db, 1).expect("open");

    let units: Vec<CompoundWrite> = (0..3).map(unit).collect();
    let gate = GateFaults::at(FaultPoint::StorageBeforePersist);
    let gate_faults: Arc<dyn FaultInjector> = gate.clone();
    let token = CancellationToken::new();

    // The worker parks in unit 0 at the gate; the deadline elapses first.
    let err = handle
        .run_units_with_deadline(units, gate_faults, token, Duration::from_millis(50))
        .await
        .expect_err("deadline must trip");
    assert_eq!(err.code(), "deadline-exceeded");

    // Release the parked worker so unit 0 finishes its transaction (never torn)
    // and the loop stops at the deadline-cancelled boundary.
    gate.release();

    // The store is consistent: unit 0 committed durably, the rest were cut off.
    assert!(handle.read_async("d0").await.expect("read").is_some());
    assert!(handle.read_async("d2").await.expect("read").is_none());

    sup.close(&db).expect("close");
}
