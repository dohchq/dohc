mod common;

use common::retry_engine_store_busy;
use dohc_engine_protocol::error::{ErrorCode, WireError};
use std::cell::Cell;
use std::time::Duration;

#[tokio::test(start_paused = true)]
async fn only_the_typed_store_busy_refusal_retries() {
    let attempts = Cell::new(0);
    let result = retry_engine_store_busy(|| {
        let attempt = attempts.get();
        attempts.set(attempt + 1);
        std::future::ready(if attempt < 3 {
            Err(WireError::new(ErrorCode::Overloaded, "engine-store-busy"))
        } else {
            Ok("committed")
        })
    })
    .await;
    assert_eq!(result.unwrap(), "committed");
    assert_eq!(attempts.get(), 4);

    for error in [
        WireError::new(ErrorCode::Overloaded, "queue-full"),
        WireError::new(ErrorCode::DeadlineExceeded, "engine-store-busy"),
    ] {
        attempts.set(0);
        let result = retry_engine_store_busy(|| {
            attempts.set(attempts.get() + 1);
            std::future::ready(Err::<(), _>(error.clone()))
        })
        .await;
        assert_eq!(result.unwrap_err(), error);
        assert_eq!(attempts.get(), 1, "other failures must not replay work");
    }
}

#[tokio::test(start_paused = true)]
async fn persistent_store_busy_refusal_exhausts_a_total_budget() {
    let started = tokio::time::Instant::now();
    let attempted_at = std::cell::RefCell::new(Vec::new());
    let error = retry_engine_store_busy(|| {
        attempted_at
            .borrow_mut()
            .push(tokio::time::Instant::now() - started);
        std::future::ready(Err::<(), _>(WireError::new(
            ErrorCode::Overloaded,
            "engine-store-busy",
        )))
    })
    .await
    .unwrap_err();
    assert_eq!(error.message, "engine-store-busy");
    assert_eq!(
        tokio::time::Instant::now() - started,
        Duration::from_secs(60)
    );
    assert!(
        attempted_at
            .borrow()
            .iter()
            .all(|at| *at < Duration::from_secs(60)),
        "no replay starts after the deadline"
    );
}
