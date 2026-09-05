//! An interrupted workspace.open or workspace.close must never strand the
//! engine.db so that the same caller's retry refuses with "workspace database
//! is already attached".
//!
//! The daemon dispatcher drops a handler future on deadline expiry or cancel,
//! so every await in the open and close paths is a point where the request
//! can vanish mid-flight. `tokio::spawn` plus `abort()` reproduces that drop
//! at pseudo-random points across both paths while a second workspace opens
//! and closes on the same service, the way the desktop's startup smoke open
//! races the first real open. The OpenGuard and the Closing marker are what
//! keep the registry consistent through the drop; this pins them.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use dohc_engine_protocol::{
    error::{ErrorCode, WireError},
    transport::{EngineTransport, InProcessTransport, RequestContext},
    wire::{Request, WorkspaceHandle},
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::{EngineService, shadow_fence::write_shadow_marker_for_harness};
use serde_json::{Value, json};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn request(id: u64, method: &str, workspace: Option<WorkspaceHandle>, params: Value) -> Request {
    Request {
        id,
        method: method.to_owned(),
        workspace,
        deadline_ms: None,
        idempotency_key: None,
        params,
    }
}

struct Harness {
    transport: Arc<InProcessTransport<EngineService>>,
    ids: AtomicU64,
}

impl Harness {
    fn next_id(&self) -> u64 {
        self.ids.fetch_add(1, Ordering::Relaxed)
    }

    async fn open(&self, root: &str, workspace_id: &str) -> Result<WorkspaceHandle, WireError> {
        self.transport
            .call(
                RequestContext::unbounded(),
                request(
                    self.next_id(),
                    "workspace.open",
                    None,
                    json!({ "rootDir": root, "workspaceId": workspace_id }),
                ),
            )
            .await
            .map(|response| {
                serde_json::from_value(response.result["workspace"].clone())
                    .expect("workspace handle")
            })
    }

    async fn close(&self, handle: WorkspaceHandle) -> Result<Value, WireError> {
        self.transport
            .call(
                RequestContext::unbounded(),
                request(self.next_id(), "workspace.close", Some(handle), json!({})),
            )
            .await
            .map(|response| response.result)
    }
}

// The exact refusal lib.rs's workspace_open sends when the supervisor holds
// an Active slot for a db this service has no handle for; both halves are
// asserted so a reworded message cannot make the pin vacuous.
fn assert_not_already_attached(error: &WireError, at: &str) {
    assert!(
        !(error.code == ErrorCode::WorkspaceUnavailable
            && error.message == "workspace database is already attached"),
        "stranded workspace db at {at}: {error:?}"
    );
}

/// Retries wait on a short timer, not a bare yield: an interrupted open or
/// close finishes its cleanup on a blocking thread, and under a loaded test
/// runner a yield-only loop can spin through its budget before that thread
/// runs. 2000 rounds at 5 ms bounds a retry at ten seconds.
const RETRY_ROUNDS: u32 = 2000;
const RETRY_PAUSE: std::time::Duration = std::time::Duration::from_millis(5);

/// Retry an open until it succeeds, failing the test the moment any attempt
/// refuses with the stranded-db message a real client cannot recover from.
async fn open_until_success(
    harness: &Harness,
    root: &str,
    workspace_id: &str,
    at: &str,
) -> WorkspaceHandle {
    let mut last = None;
    for _ in 0..RETRY_ROUNDS {
        match harness.open(root, workspace_id).await {
            Ok(handle) => return handle,
            Err(error) => {
                assert_not_already_attached(&error, at);
                last = Some(error);
                tokio::time::sleep(RETRY_PAUSE).await;
            }
        }
    }
    panic!("open never succeeded at {at}: last error {last:?}");
}

async fn close_until_settled(harness: &Harness, handle: WorkspaceHandle, at: &str) {
    let mut last = None;
    for _ in 0..RETRY_ROUNDS {
        match harness.close(handle.clone()).await {
            Ok(_) => return,
            Err(error) => {
                assert_not_already_attached(&error, at);
                // The handle is gone: the interrupted close already finished
                // its teardown, which is the settled state this waits for.
                if error.message == "workspace handle is unavailable" {
                    return;
                }
                last = Some(error);
                tokio::time::sleep(RETRY_PAUSE).await;
            }
        }
    }
    panic!("close never settled at {at}: last error {last:?}");
}

fn lcg(state: &mut u64) -> u64 {
    *state = state
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    *state >> 33
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn an_interrupted_open_or_close_never_strands_the_workspace_db() {
    let scratch_t = ScratchDir::new().expect("scratch t");
    write_shadow_marker_for_harness(scratch_t.path(), TOKEN).expect("marker t");
    let scratch_s = ScratchDir::new().expect("scratch s");
    write_shadow_marker_for_harness(scratch_s.path(), TOKEN).expect("marker s");
    let root_t = scratch_t.path().to_string_lossy().to_string();
    let root_s = scratch_s.path().to_string_lossy().to_string();

    let harness = Arc::new(Harness {
        transport: Arc::new(InProcessTransport::new(Arc::new(EngineService::new()))),
        ids: AtomicU64::new(1),
    });

    // Concurrent second workspace on the same service, like the desktop
    // lifecycle's startup smoke racing the first real open.
    let smoke_harness = Arc::clone(&harness);
    let smoke_root = root_s.clone();
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let smoke = tokio::spawn(async move {
        let mut round = 0_u32;
        while !*stop_rx.borrow() {
            round += 1;
            let at = format!("smoke round {round}");
            let handle =
                open_until_success(&smoke_harness, &smoke_root, "interrupt-smoke", &at).await;
            close_until_settled(&smoke_harness, handle, &at).await;
            if stop_rx.has_changed().unwrap_or(true) {
                break;
            }
        }
    });

    let mut seed = 0x9e3779b97f4a7c15_u64;
    for iteration in 0..150_u32 {
        // An open whose future is dropped mid-flight, like a
        // deadline-expired wire request.
        let open_harness = Arc::clone(&harness);
        let open_root = root_t.clone();
        let racing_open =
            tokio::spawn(async move { open_harness.open(&open_root, "interrupt-open").await });
        // Spread aborts across the whole open duration (an open with capture
        // takes tens of milliseconds), so post-creation awaits get hit too.
        tokio::time::sleep(std::time::Duration::from_micros(lcg(&mut seed) % 120_000)).await;
        racing_open.abort();
        let aborted_open = match racing_open.await {
            Ok(Ok(handle)) => Some(handle),
            Ok(Err(error)) => {
                assert_not_already_attached(&error, &format!("iteration {iteration} racing open"));
                None
            }
            Err(_) => None,
        };

        // The caller retries; the retry must always land.
        let handle = open_until_success(
            &harness,
            &root_t,
            "interrupt-open",
            &format!("iteration {iteration} retry open"),
        )
        .await;
        if let Some(aborted_handle) = aborted_open
            && aborted_handle != handle
        {
            close_until_settled(
                &harness,
                aborted_handle,
                &format!("iteration {iteration} aborted-open handle"),
            )
            .await;
        }

        // A close whose future is dropped mid-flight.
        let close_harness = Arc::clone(&harness);
        let racing_close = tokio::spawn(async move { close_harness.close(handle).await });
        tokio::time::sleep(std::time::Duration::from_micros(lcg(&mut seed) % 60_000)).await;
        racing_close.abort();
        let _ = racing_close.await;

        // Reopen after the aborted close, then settle clean.
        let reopened = open_until_success(
            &harness,
            &root_t,
            "interrupt-open",
            &format!("iteration {iteration} reopen after aborted close"),
        )
        .await;
        close_until_settled(
            &harness,
            reopened,
            &format!("iteration {iteration} final close"),
        )
        .await;
    }

    let _ = stop_tx.send(true);
    smoke.await.expect("smoke loop");
}
