use crate::{
    AUTOMATION_CLAIM_MAX_ATTEMPTS, AUTOMATION_CLAIM_REAP_IDLE_MS, AUTOMATION_CLAIMED_EVENT,
    EngineEventNotice, EngineEvents, automation_claim_json, lock,
};
use dohc_engine_domain::AutomationClaimAttempt;
use dohc_engine_protocol::error::WireError;
use dohc_engine_runtime::{ActorHandle, CancellationToken, NoFaults};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

const RECOVERY_INTERVAL: Duration = Duration::from_secs(60);

/// Finishes startup recovery as interrupted claims age past the live-handler guard.
pub(crate) struct AutomationRecovery {
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl AutomationRecovery {
    pub(crate) fn spawn(
        actor: ActorHandle,
        workspace_id: String,
        attempts: Vec<AutomationClaimAttempt>,
        events: EngineEvents,
    ) -> Self {
        let cancel = CancellationToken::new();
        let task = tokio::spawn(recover_interrupted_claims(
            actor,
            workspace_id,
            attempts,
            events,
            cancel.clone(),
            crate::now_ms,
        ));
        Self {
            cancel,
            task: Some(task),
        }
    }

    pub(crate) fn request_shutdown(&self) {
        self.cancel.cancel();
    }

    pub(crate) fn begin_shutdown(mut self) -> Option<tokio::task::JoinHandle<()>> {
        self.cancel.cancel();
        self.task.take()
    }
}

impl Drop for AutomationRecovery {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

async fn recover_interrupted_claims(
    actor: ActorHandle,
    workspace_id: String,
    mut attempts: Vec<AutomationClaimAttempt>,
    events: EngineEvents,
    cancel: CancellationToken,
    now_ms: impl Fn() -> Result<i64, WireError>,
) {
    while !attempts.is_empty() {
        tokio::select! {
            biased;
            () = cancel.cancelled() => return,
            () = tokio::time::sleep(RECOVERY_INTERVAL) => {}
        }
        let now_ms = match now_ms() {
            Ok(now_ms) => now_ms,
            Err(error) => {
                eprintln!("engine: automation recovery clock failed: {error:?}");
                continue;
            }
        };
        let stale_before_ms = now_ms.saturating_sub(AUTOMATION_CLAIM_REAP_IDLE_MS);
        match actor
            .automation_reclaim_running(
                workspace_id.clone(),
                Some(attempts.clone()),
                AUTOMATION_CLAIM_MAX_ATTEMPTS,
                stale_before_ms,
                now_ms,
                Arc::new(NoFaults),
                cancel.clone(),
            )
            .await
        {
            Ok(claims) => {
                for claim in &claims {
                    let mut payload = automation_claim_json(claim);
                    payload["workspaceId"] = serde_json::json!(workspace_id);
                    send_recovery_notice(
                        &events,
                        EngineEventNotice {
                            name: AUTOMATION_CLAIMED_EVENT.to_owned(),
                            payload,
                        },
                        &cancel,
                    )
                    .await;
                    if cancel.is_cancelled() {
                        return;
                    }
                }
                match actor
                    .automation_running_attempts(workspace_id.clone())
                    .await
                {
                    Ok(running) => {
                        let running: HashSet<_> = running.into_iter().collect();
                        attempts.retain(|attempt| running.contains(attempt));
                    }
                    Err(error) => {
                        if cancel.is_cancelled() {
                            return;
                        }
                        eprintln!("engine: automation recovery refresh failed: {error}");
                    }
                }
            }
            Err(error) => {
                if cancel.is_cancelled() {
                    return;
                }
                eprintln!("engine: automation recovery failed: {error}");
            }
        }
    }
}

// Recovery emits each transition once, so unlike capture repaint hints these
// wake-ups must wait for transport capacity. Teardown can still join promptly.
async fn send_recovery_notice(
    events: &EngineEvents,
    notice: EngineEventNotice,
    cancel: &CancellationToken,
) {
    let sender = lock(&events.subscriber).clone();
    let Some(sender) = sender else {
        return;
    };
    tokio::select! {
        biased;
        () = cancel.cancelled() => {}
        _ = sender.send(notice) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_domain::AUTOMATION_RECLAIM_EXHAUSTED;
    use dohc_engine_runtime::WorkspaceSupervisor;
    use dohc_engine_storage::EngineStore;
    use dohc_engine_testkit::ScratchDir;
    use std::sync::atomic::{AtomicI64, Ordering};

    const WORKSPACE: &str = "ws-automation-recovery";
    const OPENED_AT: i64 = 1_000_000;

    #[tokio::test]
    async fn recovery_notice_waits_for_capacity_and_shutdown_cancels_a_blocked_send() {
        use std::future::{Future, poll_fn};
        use std::task::Poll;

        for shutdown in [false, true] {
            let events = EngineEvents::default();
            let mut notices = events.subscribe();
            for _ in 0..crate::ENGINE_EVENT_QUEUE_CAPACITY {
                events.emit("capture.momentRecorded", serde_json::json!({}));
            }
            let cancel = CancellationToken::new();
            let notice = EngineEventNotice {
                name: AUTOMATION_CLAIMED_EVENT.to_owned(),
                payload: serde_json::json!({"workspaceId": WORKSPACE, "state": "pending"}),
            };
            let send = send_recovery_notice(&events, notice, &cancel);
            tokio::pin!(send);
            poll_fn(|cx| {
                assert!(send.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;

            if shutdown {
                cancel.cancel();
            } else {
                notices.recv().await.expect("release one transport slot");
            }
            send.await;
            for _ in 0..crate::ENGINE_EVENT_QUEUE_CAPACITY - usize::from(!shutdown) {
                assert_eq!(
                    notices.try_recv().expect("queued capture notice").name,
                    "capture.momentRecorded"
                );
            }
            if !shutdown {
                let notice = notices.try_recv().expect("recovery wake-up was retained");
                assert_eq!(notice.name, AUTOMATION_CLAIMED_EVENT);
                assert_eq!(notice.payload["workspaceId"], WORKSPACE);
                assert_eq!(notice.payload["state"], "pending");
            }
            assert!(notices.try_recv().is_err());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn interrupted_claims_recover_and_notify_after_the_guard_without_reopening() {
        let scratch = ScratchDir::new().expect("scratch");
        let db = dohc_engine_testkit::engine_db_path(&scratch).expect("db");
        {
            let _store = EngineStore::open(&db, OPENED_AT).expect("migrate");
        }
        let conn = rusqlite::Connection::open(&db).expect("seed connection");
        for (id, attempts, state) in [
            ("exhausted", 2, "running"),
            ("retry", 1, "running"),
            ("reused", 1, "running"),
            ("live", 0, "pending"),
        ] {
            conn.execute(
                "INSERT INTO automation_claims \
                 (workspace_id,claim_id,automation_id,trigger_origin_id,trigger_origin_seq, \
                  record_id,collection_path,depth,state,attempts,created_at_ms,updated_at_ms) \
                 VALUES (?1,?2,?2,'origin',1,'record','tasks',0,?3,?4,?5,?5)",
                rusqlite::params![WORKSPACE, id, state, attempts, OPENED_AT],
            )
            .expect("seed running claim");
        }
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, OPENED_AT).expect("open actor").actor;
        let attempts = actor
            .automation_running_attempts(WORKSPACE.to_owned())
            .await
            .expect("startup attempt snapshot");
        assert_eq!(
            attempts.len(),
            3,
            "pending work belongs to the next executor"
        );
        let reused = attempts
            .iter()
            .find(|attempt| attempt.claim_id == "reused")
            .expect("reused attempt")
            .clone();
        actor
            .automation_reclaim_running(
                WORKSPACE.to_owned(),
                Some(vec![reused]),
                AUTOMATION_CLAIM_MAX_ATTEMPTS,
                OPENED_AT,
                OPENED_AT,
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("requeue the snapshotted attempt");
        // Start two claims after the snapshot in the very same millisecond:
        // one absent from the snapshot, one reusing its claim ID for attempt 2.
        for (id, expected_attempts) in [("live", 1), ("reused", 2)] {
            let claimed = actor
                .automation_claim_next(
                    WORKSPACE.to_owned(),
                    OPENED_AT,
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
                .expect("claim current-session work")
                .expect("pending claim");
            assert_eq!(claimed.claim_id, id);
            assert_eq!(claimed.attempts, expected_attempts);
            assert_eq!(claimed.updated_at_ms, OPENED_AT);
        }
        let clock = Arc::new(AtomicI64::new(OPENED_AT));
        let now = Arc::clone(&clock);
        let (clock_tick, mut clock_ticks) = tokio::sync::mpsc::unbounded_channel();
        let events = EngineEvents::default();
        let mut notices = events.subscribe();
        let cancel = CancellationToken::new();
        let task = tokio::spawn(recover_interrupted_claims(
            actor.clone(),
            WORKSPACE.to_owned(),
            attempts,
            events,
            cancel.clone(),
            move || {
                let now = now.load(Ordering::SeqCst);
                let _ = clock_tick.send(now);
                Ok(now)
            },
        ));
        // Hold wall time at startup through one scheduled pass: the guard
        // must leave both interrupted claims running and emit nothing.
        tokio::task::yield_now().await;
        tokio::time::advance(RECOVERY_INTERVAL).await;
        assert_eq!(clock_ticks.recv().await, Some(OPENED_AT));
        actor
            .automation_failures(WORKSPACE.to_owned())
            .await
            .expect("actor barrier");
        assert!(notices.try_recv().is_err());
        let running: i64 = conn
            .query_row(
                "SELECT count(*) FROM automation_claims WHERE state='running'",
                [],
                |row| row.get(0),
            )
            .expect("running count");
        assert_eq!(running, 4);

        clock.store(
            OPENED_AT + AUTOMATION_CLAIM_REAP_IDLE_MS + 1,
            Ordering::SeqCst,
        );
        tokio::time::advance(RECOVERY_INTERVAL).await;
        let first = notices.recv().await.expect("first recovery wake-up");
        let second = notices.recv().await.expect("second recovery wake-up");
        task.await
            .expect("recovery ends after the startup claims age");
        for notice in [&first, &second] {
            assert_eq!(notice.name, AUTOMATION_CLAIMED_EVENT);
            assert_eq!(notice.payload["workspaceId"], WORKSPACE);
        }
        let failed = [&first, &second]
            .into_iter()
            .find(|notice| notice.payload["state"] == "failed")
            .expect("owner failure wake-up");
        assert_eq!(failed.payload["claimId"], "exhausted");
        assert_eq!(failed.payload["error"], AUTOMATION_RECLAIM_EXHAUSTED);
        let pending = [&first, &second]
            .into_iter()
            .find(|notice| notice.payload["state"] == "pending")
            .expect("executor wake-up");
        assert_eq!(pending.payload["claimId"], "retry");
        let failures = actor
            .automation_failures(WORKSPACE.to_owned())
            .await
            .expect("failures");
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].automation_id, "exhausted");
        let live: (String, i64) = conn
            .query_row(
                "SELECT state,attempts FROM automation_claims WHERE claim_id='live'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("live claim");
        assert_eq!(live, ("running".to_owned(), 1));
        let reused: (String, i64) = conn
            .query_row(
                "SELECT state,attempts FROM automation_claims WHERE claim_id='reused'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("reused claim");
        assert_eq!(reused, ("running".to_owned(), 2));
        assert!(notices.try_recv().is_err());

        // Teardown joins cancellation even before the first scheduled pass.
        // This new snapshot includes the live row, so a leaked task would requeue it.
        let attempts = actor
            .automation_running_attempts(WORKSPACE.to_owned())
            .await
            .expect("shutdown snapshot");
        let recovery = AutomationRecovery::spawn(
            actor,
            WORKSPACE.to_owned(),
            attempts,
            EngineEvents::default(),
        );
        recovery
            .begin_shutdown()
            .expect("recovery task")
            .await
            .expect("cancelled recovery joins");
        let state: String = conn
            .query_row(
                "SELECT state FROM automation_claims WHERE claim_id='live'",
                [],
                |row| row.get(0),
            )
            .expect("live claim after shutdown");
        assert_eq!(state, "running");
        supervisor.close(&db).expect("close actor");
    }
}
