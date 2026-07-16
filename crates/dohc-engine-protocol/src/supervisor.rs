//! Bounded request supervisor skeleton (tokio), replacing the workspace
//! kernel spike's one-OS-thread-per-request dispatch.
//!
//! Properties (each covered by a test):
//!
//! - **Bounded concurrency**: at most `max_in_flight` requests execute
//!   concurrently (semaphore).
//! - **Bounded queue / backpressure**: at most `queue_capacity` requests
//!   wait; beyond that, submission fails immediately with a typed
//!   `OVERLOADED` error (`afterBackoff`) instead of buffering unboundedly.
//! - **Deadlines**: every request gets `default_deadline` unless it asks for
//!   less; requests never exceed `max_deadline`. Expiry produces
//!   `DEADLINE_EXCEEDED`.
//! - **Cooperative cancellation**: `cancel(id)` resolves queued or in-flight
//!   requests to `CANCELLED`; handlers observe `ctx.cancel` at their own
//!   pace, and the supervisor stops awaiting them once cancellation wins.
//!
//! Skeleton scope: single session, no event stream, no blob scheduling, no
//! per-workspace actors — those live in `dohc-engine-runtime` later. This
//! exists to prove the dispatch shape and its bounds.

use crate::cancel::CancelSignal;
use crate::error::{ErrorCode, WireError};
use crate::transport::{EngineService, RequestContext};
use crate::wire::{Request, RequestId, Response};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Semaphore, mpsc, oneshot};
use tokio::time::Instant;

/// Tuning knobs for a supervisor instance.
#[derive(Debug, Clone)]
pub struct SupervisorConfig {
    pub max_in_flight: usize,
    pub queue_capacity: usize,
    pub default_deadline: Duration,
    pub max_deadline: Duration,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        SupervisorConfig {
            max_in_flight: 8,
            queue_capacity: 64,
            default_deadline: Duration::from_secs(30),
            max_deadline: Duration::from_secs(300),
        }
    }
}

/// Terminal outcome of a submitted request.
pub type RequestOutcome = Result<Response, WireError>;

struct Job {
    request: Request,
    respond: oneshot::Sender<RequestOutcome>,
    cancel: CancelSignal,
    deadline: Instant,
}

type CancelRegistry = Arc<Mutex<HashMap<RequestId, CancelSignal>>>;

/// Bounded request dispatcher over an [`EngineService`].
pub struct Supervisor {
    queue: mpsc::Sender<Job>,
    cancels: CancelRegistry,
    config: SupervisorConfig,
}

impl Supervisor {
    /// Spawn the dispatch loop onto the current tokio runtime.
    pub fn new<S: EngineService + 'static>(config: SupervisorConfig, service: Arc<S>) -> Self {
        let (queue, mut rx) = mpsc::channel::<Job>(config.queue_capacity);
        let cancels: CancelRegistry = Arc::new(Mutex::new(HashMap::new()));
        let semaphore = Arc::new(Semaphore::new(config.max_in_flight));
        let worker_cancels = cancels.clone();

        tokio::spawn(async move {
            while let Some(job) = rx.recv().await {
                // The semaphore is never closed, so acquisition only fails if
                // it were; treat that as loop shutdown rather than panicking.
                let Ok(permit) = semaphore.clone().acquire_owned().await else {
                    break;
                };
                let service = service.clone();
                let cancels = worker_cancels.clone();
                tokio::spawn(async move {
                    let outcome =
                        run_job(service.as_ref(), &job.request, &job.cancel, job.deadline).await;
                    lock(&cancels).remove(&job.request.id);
                    let _ = job.respond.send(outcome);
                    drop(permit);
                });
            }
        });

        Supervisor {
            queue,
            cancels,
            config,
        }
    }

    /// Submit a request. Returns a receiver for its terminal outcome, or a
    /// typed error immediately when the request is rejected at the door
    /// (duplicate id, or queue full → `OVERLOADED` backpressure).
    pub fn try_submit(
        &self,
        request: Request,
    ) -> Result<oneshot::Receiver<RequestOutcome>, WireError> {
        let cancel = CancelSignal::new();
        {
            let mut cancels = lock(&self.cancels);
            if cancels.contains_key(&request.id) {
                return Err(WireError::new(
                    ErrorCode::InvalidParams,
                    "duplicate in-flight request id",
                ));
            }
            cancels.insert(request.id, cancel.clone());
        }

        let requested = request
            .deadline_ms
            .map(|ms| Duration::from_millis(u64::from(ms)))
            .unwrap_or(self.config.default_deadline)
            .min(self.config.max_deadline);
        let (respond, receiver) = oneshot::channel();
        let job = Job {
            request,
            respond,
            cancel,
            deadline: Instant::now() + requested,
        };

        match self.queue.try_send(job) {
            Ok(()) => Ok(receiver),
            Err(error) => {
                let id = match &error {
                    mpsc::error::TrySendError::Full(job)
                    | mpsc::error::TrySendError::Closed(job) => job.request.id,
                };
                lock(&self.cancels).remove(&id);
                match error {
                    mpsc::error::TrySendError::Full(_) => Err(WireError::new(
                        ErrorCode::Overloaded,
                        "request queue is full",
                    )),
                    mpsc::error::TrySendError::Closed(_) => Err(WireError::new(
                        ErrorCode::Internal,
                        "supervisor is shut down",
                    )),
                }
            }
        }
    }

    /// Request cooperative cancellation of a queued or in-flight request.
    /// Returns false when the id is unknown (already terminal).
    pub fn cancel(&self, id: RequestId) -> bool {
        match lock(&self.cancels).get(&id) {
            Some(signal) => {
                signal.cancel();
                true
            }
            None => false,
        }
    }
}

async fn run_job(
    service: &impl EngineService,
    request: &Request,
    cancel: &CancelSignal,
    deadline: Instant,
) -> RequestOutcome {
    if cancel.is_cancelled() {
        return Err(WireError::new(
            ErrorCode::Cancelled,
            "cancelled while queued",
        ));
    }
    let ctx = RequestContext {
        cancel: cancel.clone(),
        deadline: Some(deadline.into_std()),
    };
    tokio::select! {
        () = cancel.cancelled() => Err(WireError::new(ErrorCode::Cancelled, "request cancelled")),
        () = tokio::time::sleep_until(deadline) => {
            // Tell the handler to stop; its output can no longer be observed.
            cancel.cancel();
            Err(WireError::new(ErrorCode::DeadlineExceeded, "request deadline elapsed"))
        }
        outcome = service.call(ctx, request.clone()) => outcome,
    }
}

fn lock(registry: &CancelRegistry) -> std::sync::MutexGuard<'_, HashMap<RequestId, CancelSignal>> {
    registry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Notify;

    fn request(id: RequestId) -> Request {
        Request {
            id,
            method: "test.echo".to_string(),
            workspace: None,
            deadline_ms: None,
            idempotency_key: None,
            params: Value::Null,
        }
    }

    fn config(max_in_flight: usize, queue_capacity: usize) -> SupervisorConfig {
        SupervisorConfig {
            max_in_flight,
            queue_capacity,
            default_deadline: Duration::from_secs(5),
            max_deadline: Duration::from_secs(10),
        }
    }

    /// Service that records its peak concurrency.
    struct ConcurrencyProbe {
        current: AtomicUsize,
        peak: AtomicUsize,
    }

    impl EngineService for ConcurrencyProbe {
        async fn call(&self, _ctx: RequestContext, request: Request) -> RequestOutcome {
            let now = self.current.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
            self.current.fetch_sub(1, Ordering::SeqCst);
            Ok(Response {
                id: request.id,
                result: json!("done"),
            })
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrency_never_exceeds_max_in_flight() {
        let service = Arc::new(ConcurrencyProbe {
            current: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
        });
        let supervisor = Supervisor::new(config(3, 64), service.clone());
        let receivers: Vec<_> = (0..24)
            .map(|id| supervisor.try_submit(request(id)).expect("queue has room"))
            .collect();
        for receiver in receivers {
            let outcome = receiver.await.expect("supervisor responded");
            assert!(outcome.is_ok());
        }
        assert!(
            service.peak.load(Ordering::SeqCst) <= 3,
            "peak concurrency {} exceeded bound",
            service.peak.load(Ordering::SeqCst)
        );
    }

    /// Service that parks until released, cooperating with cancellation.
    struct Gate {
        release: Notify,
        started: Notify,
    }

    impl EngineService for Gate {
        async fn call(&self, ctx: RequestContext, request: Request) -> RequestOutcome {
            self.started.notify_one();
            tokio::select! {
                () = self.release.notified() => Ok(Response { id: request.id, result: Value::Null }),
                () = ctx.cancel.cancelled() => Err(WireError::new(ErrorCode::Cancelled, "handler observed cancellation")),
            }
        }
    }

    #[tokio::test]
    async fn full_queue_yields_typed_overload_backpressure() {
        let service = Arc::new(Gate {
            release: Notify::new(),
            started: Notify::new(),
        });
        let supervisor = Supervisor::new(config(1, 2), service.clone());

        // One request occupies the single in-flight slot...
        let in_flight = supervisor.try_submit(request(0)).expect("accepted");
        service.started.notified().await;
        // ...then fill the queue. The dispatcher may have pulled one job out
        // of the channel while waiting for a permit, so up to capacity + 1
        // submissions can be accepted before OVERLOADED appears.
        let mut accepted = vec![in_flight];
        let mut overloaded = None;
        for id in 1..=4 {
            match supervisor.try_submit(request(id)) {
                Ok(receiver) => accepted.push(receiver),
                Err(error) => {
                    overloaded = Some(error);
                    break;
                }
            }
        }
        let error = overloaded.expect("submission beyond bounds must be rejected");
        assert_eq!(error.code, ErrorCode::Overloaded);
        assert_eq!(error.retry, crate::error::Retryability::AfterBackoff);
        assert!(
            accepted.len() <= 4,
            "accepted {} > queue+in-flight+1",
            accepted.len()
        );

        // Backpressure is not deadlock: released requests all complete.
        // Release sequentially — Notify stores at most one permit.
        for receiver in accepted {
            service.release.notify_one();
            assert!(receiver.await.expect("responded").is_ok());
        }
    }

    #[tokio::test]
    async fn cancel_resolves_in_flight_request_with_cancelled() {
        let service = Arc::new(Gate {
            release: Notify::new(),
            started: Notify::new(),
        });
        let supervisor = Supervisor::new(config(1, 4), service.clone());
        let receiver = supervisor.try_submit(request(7)).expect("accepted");
        service.started.notified().await;

        assert!(supervisor.cancel(7), "in-flight id is cancellable");
        let outcome = receiver.await.expect("responded");
        let error = outcome.expect_err("cancelled request must fail");
        assert_eq!(error.code, ErrorCode::Cancelled);

        // Terminal ids are gone from the registry.
        assert!(!supervisor.cancel(7));
        // Id is reusable after completion.
        let receiver = supervisor.try_submit(request(7)).expect("id reusable");
        service.started.notified().await;
        service.release.notify_one();
        assert!(receiver.await.expect("responded").is_ok());
    }

    #[tokio::test]
    async fn duplicate_in_flight_id_is_rejected() {
        let service = Arc::new(Gate {
            release: Notify::new(),
            started: Notify::new(),
        });
        let supervisor = Supervisor::new(config(1, 4), service.clone());
        let _receiver = supervisor.try_submit(request(3)).expect("accepted");
        let error = supervisor.try_submit(request(3)).expect_err("duplicate id");
        assert_eq!(error.code, ErrorCode::InvalidParams);
    }

    /// Service that sleeps far past any deadline without cooperating.
    struct Sleeper;

    impl EngineService for Sleeper {
        async fn call(&self, _ctx: RequestContext, request: Request) -> RequestOutcome {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            Ok(Response {
                id: request.id,
                result: Value::Null,
            })
        }
    }

    #[tokio::test(start_paused = true)]
    async fn deadline_elapse_yields_deadline_exceeded() {
        let supervisor = Supervisor::new(config(2, 4), Arc::new(Sleeper));
        let mut slow = request(1);
        slow.deadline_ms = Some(50);
        let receiver = supervisor.try_submit(slow).expect("accepted");
        let outcome = receiver.await.expect("responded");
        let error = outcome.expect_err("must time out");
        assert_eq!(error.code, ErrorCode::DeadlineExceeded);
    }

    #[tokio::test(start_paused = true)]
    async fn requested_deadline_is_clamped_to_max() {
        let config = SupervisorConfig {
            max_in_flight: 1,
            queue_capacity: 2,
            default_deadline: Duration::from_millis(100),
            max_deadline: Duration::from_millis(200),
        };
        let supervisor = Supervisor::new(config, Arc::new(Sleeper));
        let mut greedy = request(1);
        greedy.deadline_ms = Some(3_600_000);
        let started = tokio::time::Instant::now();
        let receiver = supervisor.try_submit(greedy).expect("accepted");
        let outcome = receiver.await.expect("responded");
        assert_eq!(
            outcome.expect_err("times out").code,
            ErrorCode::DeadlineExceeded
        );
        // Paused tokio time auto-advances exactly to the next timer: the
        // clock must reach the clamped max deadline, not the requested hour.
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(200) && elapsed < Duration::from_millis(300),
            "clock advanced {elapsed:?}, expected the 200ms clamp"
        );
    }
}
