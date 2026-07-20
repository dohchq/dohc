//! The files-into-daemon composition driver: owns the [`FilesActor`], the
//! [`NativeWatcher`], and the reconcile→apply→acknowledge loop that makes
//! capture AUTONOMOUS — once a shadow-bound workspace is open, external file
//! changes on disk are noticed and recorded with no RPC involved.
//!
//! Ownership model: the DRIVER TASK owns the files actor and the watcher, so
//! it can tear them down and re-spawn them freely (the policy-flip re-offer
//! below, and the D-shard watcher supervision that builds on the same lever).
//! The daemon holds only a [`CaptureDriver`]: a cancellation token, the
//! driver's join handle, and a small observable status snapshot for the E
//! RPCs. Shutdown is strictly ordered — watcher.stop() → files.close() →
//! driver exit — and on PER-WORKSPACE close the daemon awaits the driver
//! BEFORE closing the store actor, so no capture write can race workspace
//! teardown. (At whole-DAEMON exit the transport's close hook closes actors
//! first; in-flight capture writes fail contained and un-acked, and the
//! post-transport drain joins the threads — see `run_stdio`.)
//!
//! Policy-flip convergence (the #205-review obligation): `.dohc` is unwatched
//! (policy edits generate no watcher events — TS parity), so each drive cycle
//! fingerprints `.dohc/files.toml` + `.dohc/visibility.toml`. On a change the
//! files layer is respawned with an EMPTY manifest, which re-offers every
//! scanned path through the sink — narrowed-but-unchanged paths retire via
//! the sink's NotOwned branch, and newly-widened paths re-ingest.

use crate::capture_sink::StoreCaptureSink;
use dohc_engine_files::{
    CancellationToken, CaptureApplyResult, FilesActor, FilesError, ManifestEntry, NativeWatcher,
    ReconcilePlan, ReconcileRun, ScanBounds, ScanGeneration, ScanManifest, apply_reconcile_plan,
};
use dohc_engine_runtime::{ActorHandle, NoFaults, RuntimeError};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// How often the driver polls the dirty flag. Cheap when converged (one
/// actor round-trip returning `Converged` without touching the filesystem);
/// the watcher's debounce means sub-interval changes coalesce anyway.
const DRIVE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

/// The restart backoff schedule after a failed files-layer start or a
/// permanently lost watch. Doubling from [`DRIVE_INTERVAL`] and capped, so a
/// root that cannot be watched at all (deleted, permissions, handle
/// exhaustion) stops burning a scan attempt twice a second forever.
const RESTART_BACKOFF_CAP: std::time::Duration = std::time::Duration::from_secs(8);

/// Consecutive restart failures before the driver declares the watch
/// TERMINAL. Eight escalating attempts is ~30s of widening retries — long
/// enough that no transient condition reaches it, short enough that a real
/// one is reported while the user is still at their desk.
const MAX_RESTART_ATTEMPTS: u32 = 8;

/// How often a TERMINAL driver still probes for recovery. Slow enough to cost
/// nothing, present so a root that comes back is picked up WITHOUT the caller
/// having to close and reopen the workspace.
const TERMINAL_PROBE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// How long to wait before the next files-layer start attempt, given the
/// number of CONSECUTIVE failures so far. Pure so the schedule is testable
/// without waiting out a real minute of backoff.
fn restart_delay(consecutive_failures: u32) -> std::time::Duration {
    if consecutive_failures == 0 {
        return DRIVE_INTERVAL;
    }
    if is_terminal(consecutive_failures) {
        return TERMINAL_PROBE_INTERVAL;
    }
    let factor = 1u32
        .checked_shl(consecutive_failures - 1)
        .unwrap_or(u32::MAX);
    DRIVE_INTERVAL
        .checked_mul(factor)
        .unwrap_or(RESTART_BACKOFF_CAP)
        .min(RESTART_BACKOFF_CAP)
}

/// Whether this many consecutive failures means the watch is TERMINAL: the
/// driver stops the fast cadence and stops reporting capture as merely
/// degraded.
fn is_terminal(consecutive_failures: u32) -> bool {
    consecutive_failures >= MAX_RESTART_ATTEMPTS
}

/// How many extra cycles the STARTUP baseline may take to settle before
/// `workspace.open` is released anyway (degraded). Bounds open latency while
/// keeping the common transient-failure case ordered.
const BASELINE_SETTLE_ATTEMPTS: u32 = 3;

/// What one driver tick observed about the files layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TickObservation {
    /// Reconciled (or converged) with a live watch: the layer works.
    /// `clean` is false when the tick's own apply reported failures, which
    /// must stay visible as degradation rather than being cleared by the very
    /// tick that raised it.
    Healthy { clean: bool },
    /// The OS watch is permanently gone.
    WatchLost,
    /// The files actor died under us.
    ActorLost,
    /// The reconcile itself failed while the layer stayed up.
    ReconcileFailed,
    /// `files.toml`/`visibility.toml` changed: an INTENTIONAL restart, not a
    /// failure, so it must never feed the backoff.
    PolicyChanged,
}

/// What the loop does with its layer after a tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LayerAction {
    /// Keep driving the current layer.
    Keep,
    /// Stop the layer; the next iteration rebuilds it after the backoff.
    Drop,
}

/// Supervision state for the files layer: how many consecutive times it has
/// failed to start or lost its watch, and what that means for cadence and
/// reported health.
#[derive(Default)]
struct RestartTracker {
    consecutive_failures: u32,
}

impl RestartTracker {
    /// A start failed, or a started layer's watch was found dead. Escalates
    /// the backoff and, past [`MAX_RESTART_ATTEMPTS`], reports TERMINAL.
    fn record_failure(&mut self, status: &DriverStatus) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        status.degraded.store(true, Ordering::Release);
        status
            .terminal
            .store(is_terminal(self.consecutive_failures), Ordering::Release);
    }

    /// The layer survived a full tick with a live watch. This is the ONLY
    /// reset: clearing the streak at START time instead would let a watch that
    /// dies immediately after every start flap at the fast cadence forever —
    /// exactly the case the streak exists to bound. It is also the only exit
    /// from TERMINAL, which is what makes the slow probe a recovery path
    /// rather than a graveyard.
    fn record_healthy_tick(&mut self, status: &DriverStatus, clean: bool) {
        self.consecutive_failures = 0;
        // The healthy tick IS the proof the layer runs — mid-streak starts no
        // longer claim `running`, so recovery must claim it here, in the same
        // breath that clears `terminal` (the pair can never contradict).
        status.running.store(true, Ordering::Release);
        status.terminal.store(false, Ordering::Release);
        // Degradation is sticky until the layer demonstrably works again.
        // A tick whose own apply failed is not that demonstration.
        if clean {
            status.degraded.store(false, Ordering::Release);
        }
    }

    /// How long to wait before the next attempt.
    fn delay(&self) -> std::time::Duration {
        restart_delay(self.consecutive_failures)
    }

    fn failures(&self) -> u32 {
        self.consecutive_failures
    }

    /// Fold one tick's observation into supervision state and say what to do
    /// with the layer. THE decision point: every failure mode routes through
    /// here so none can quietly escape the backoff.
    fn observe(&mut self, observation: TickObservation, status: &DriverStatus) -> LayerAction {
        match observation {
            TickObservation::Healthy { clean } => {
                self.record_healthy_tick(status, clean);
                LayerAction::Keep
            }
            // A dead watch or actor is unrecoverable in place: drop the layer
            // and let the backoff govern the rebuild.
            TickObservation::WatchLost | TickObservation::ActorLost => {
                self.record_failure(status);
                LayerAction::Drop
            }
            // The layer is still up, so keep it while the failure might be
            // transient — but this DOES count as a failure: a reconcile that
            // fails every tick must slow down rather than retry at the fast
            // cadence forever. Once the streak is terminal, REBUILD instead of
            // polling a wedged layer indefinitely; that also stops the driver
            // from advertising `running` while it reports `terminal`.
            TickObservation::ReconcileFailed => {
                self.record_failure(status);
                if is_terminal(self.consecutive_failures) {
                    LayerAction::Drop
                } else {
                    LayerAction::Keep
                }
            }
            // A policy edit is deliberate. It must not escalate toward
            // terminal, and it must not reset a real failure streak either.
            TickObservation::PolicyChanged => LayerAction::Drop,
        }
    }
}

/// Observable driver state for the E-shard `watcher.status` RPC and tests.
#[derive(Default)]
pub(crate) struct DriverStatus {
    /// The files layer (actor + watcher + loop) is up and driving.
    running: AtomicBool,
    /// The watcher reported a disruption, a reconcile or apply failed, or
    /// the files layer could not (re)start. Cleared by the next FULLY CLEAN
    /// tick (reconcile completed, apply clean, no fresh watcher disruption) —
    /// so it reads as CURRENT health, not an event log: a recovered blip
    /// clears within a tick, while a persisting cause (unreadable file,
    /// failing apply, dead watch) holds it set.
    degraded: AtomicBool,
    /// The files layer failed to (re)start [`MAX_RESTART_ATTEMPTS`] times in a
    /// row. Capture for this workspace is NOT running and is not expected to
    /// resume on its own timescale; the driver keeps a slow recovery probe, so
    /// this is a report, not a grave. Cleared by a healthy restart.
    terminal: AtomicBool,
}

impl DriverStatus {
    // Consumed by the lifecycle tests today and the E-shard `watcher.status`
    // RPC next; the expectation is scoped to non-test builds so it lifts
    // automatically the moment the RPC lands.
    #[cfg_attr(not(test), expect(dead_code))]
    pub(crate) fn running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }
    // Consulted by RealEnv's quarantine gate in production; running/terminal
    // stay test-only until the E-shard watcher.status RPC lands.
    pub(crate) fn degraded(&self) -> bool {
        self.degraded.load(Ordering::Acquire)
    }
    #[cfg_attr(not(test), expect(dead_code))]
    pub(crate) fn terminal(&self) -> bool {
        self.terminal.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod restart_schedule_tests {
    use super::*;

    #[test]
    fn a_healthy_driver_polls_at_the_fast_cadence() {
        assert_eq!(restart_delay(0), DRIVE_INTERVAL);
        assert!(!is_terminal(0));
    }

    #[test]
    fn the_backoff_doubles_and_then_caps() {
        let schedule: Vec<_> = (1..=7).map(restart_delay).collect();
        assert_eq!(
            schedule,
            vec![
                std::time::Duration::from_millis(500),
                std::time::Duration::from_secs(1),
                std::time::Duration::from_secs(2),
                std::time::Duration::from_secs(4),
                std::time::Duration::from_secs(8),
                // Capped from here on: 16s would exceed the cap.
                RESTART_BACKOFF_CAP,
                RESTART_BACKOFF_CAP,
            ]
        );
        // Strictly non-decreasing everywhere, so no schedule edit can
        // accidentally make a LATER failure retry sooner than an earlier one.
        for failures in 1..64u32 {
            assert!(
                restart_delay(failures + 1) >= restart_delay(failures),
                "delay went backwards at {failures}"
            );
        }
    }

    #[test]
    fn escalation_is_bounded_and_the_terminal_probe_still_runs() {
        assert!(!is_terminal(MAX_RESTART_ATTEMPTS - 1));
        assert!(is_terminal(MAX_RESTART_ATTEMPTS));
        assert!(is_terminal(u32::MAX));
        // A terminal driver keeps probing: the interval must be finite and
        // slow, never zero (a hot loop) and never absent (a graveyard).
        assert_eq!(restart_delay(MAX_RESTART_ATTEMPTS), TERMINAL_PROBE_INTERVAL);
        assert_eq!(restart_delay(u32::MAX), TERMINAL_PROBE_INTERVAL);
        assert!(TERMINAL_PROBE_INTERVAL > DRIVE_INTERVAL);
        // The terminal probe must be DISTINGUISHABLE from the capped backoff,
        // or deleting the terminal branch of `restart_delay` would leave every
        // assertion above satisfied by the cap alone — which is exactly what
        // an earlier revision of this test did.
        assert_ne!(
            TERMINAL_PROBE_INTERVAL, RESTART_BACKOFF_CAP,
            "a terminal probe indistinguishable from the cap is untestable"
        );
        assert_eq!(restart_delay(MAX_RESTART_ATTEMPTS - 1), RESTART_BACKOFF_CAP);
    }

    #[test]
    fn the_whole_escalation_stays_within_a_couple_of_minutes() {
        // The point of the bound: reaching terminal must take long enough that
        // no transient blip gets there, and short enough to be reported while
        // the user is still at their desk.
        let total: std::time::Duration = (1..MAX_RESTART_ATTEMPTS).map(restart_delay).sum();
        assert!(
            total >= std::time::Duration::from_secs(25),
            "escalation too eager: {total:?}"
        );
        assert!(
            total <= std::time::Duration::from_secs(150),
            "escalation too slow to report: {total:?}"
        );
    }
}

#[cfg(test)]
mod supervision_tests {
    use super::*;

    /// Drive a sequence of tick observations the way `drive` does, returning
    /// the delay the loop would wait before each subsequent pass. This is the
    /// layer the real defects lived at: asserting on `RestartTracker` alone
    /// missed both, because the loop chose its delay independently.
    fn run(observations: &[TickObservation]) -> (Vec<std::time::Duration>, DriverStatus, u32) {
        let status = DriverStatus::default();
        let mut restart = RestartTracker::default();
        let mut delays = Vec::new();
        for observation in observations {
            let _ = restart.observe(*observation, &status);
            delays.push(restart.delay());
        }
        let failures = restart.failures();
        (delays, status, failures)
    }

    #[test]
    fn a_watch_that_dies_every_tick_backs_off_instead_of_rescanning_hot() {
        // THE regression: a watch that dies right after every start used to
        // rebuild the layer (actor + watcher + full baseline scan) every
        // 500ms forever, because the drop-and-restart path skipped the sleep.
        let (delays, status, _) = run(&[TickObservation::WatchLost; 4]);
        assert_eq!(
            delays,
            vec![
                std::time::Duration::from_millis(500),
                std::time::Duration::from_secs(1),
                std::time::Duration::from_secs(2),
                std::time::Duration::from_secs(4),
            ],
            "each repeated watch loss must widen the gap before the rebuild"
        );
        assert!(status.degraded());
    }

    #[test]
    fn a_files_actor_that_dies_every_tick_also_escalates() {
        // The other uncounted path: a reconcile returning ActorUnavailable
        // dropped the layer without recording a failure at all, so the streak
        // sat at zero and the driver never slowed down or reported terminal.
        let (delays, status, failures) =
            run(&[TickObservation::ActorLost; MAX_RESTART_ATTEMPTS as usize]);
        assert_eq!(failures, MAX_RESTART_ATTEMPTS);
        assert!(
            status.terminal(),
            "a permanently dead actor reports terminal"
        );
        assert_eq!(delays.last().copied(), Some(TERMINAL_PROBE_INTERVAL));
    }

    #[test]
    fn a_reconcile_that_fails_every_tick_escalates_while_keeping_the_layer() {
        let status = DriverStatus::default();
        let mut restart = RestartTracker::default();
        // While the failure might still be transient the layer is KEPT: a
        // reconcile error does not mean its threads are dead.
        for _ in 1..MAX_RESTART_ATTEMPTS {
            assert_eq!(
                restart.observe(TickObservation::ReconcileFailed, &status),
                LayerAction::Keep,
                "a live layer is not torn down for one failed reconcile"
            );
        }
        // But a layer that has failed every tick to the terminal threshold is
        // wedged: rebuild it rather than polling it forever, which also stops
        // the driver reporting "running" while it reports "terminal".
        assert_eq!(
            restart.observe(TickObservation::ReconcileFailed, &status),
            LayerAction::Drop,
            "a persistently failing layer is rebuilt, not polled forever"
        );
        assert!(
            status.terminal(),
            "and it must escalate rather than retry hot forever"
        );
        assert_eq!(restart.delay(), TERMINAL_PROBE_INTERVAL);
    }

    #[test]
    fn only_a_completed_reconcile_counts_as_healthy() {
        // Health is claimed AFTER the reconcile, not at the watcher check:
        // an actor that dies on every reconcile would otherwise reset the
        // streak mid-tick and never escalate.
        let status = DriverStatus::default();
        let mut restart = RestartTracker::default();
        for _ in 0..MAX_RESTART_ATTEMPTS * 2 {
            restart.observe(TickObservation::ActorLost, &status);
        }
        assert!(status.terminal());
        assert_eq!(
            restart.observe(TickObservation::Healthy { clean: true }, &status),
            LayerAction::Keep
        );
        assert!(!status.terminal(), "a completed tick recovers the driver");
        assert_eq!(restart.delay(), DRIVE_INTERVAL);
        assert_eq!(restart.failures(), 0);
    }

    #[test]
    fn a_policy_edit_neither_escalates_nor_forgives() {
        let status = DriverStatus::default();
        let mut restart = RestartTracker::default();
        restart.observe(TickObservation::WatchLost, &status);
        let after_failure = restart.delay();

        // A deliberate restart drops the layer but must not count as a
        // failure...
        assert_eq!(
            restart.observe(TickObservation::PolicyChanged, &status),
            LayerAction::Drop
        );
        assert_eq!(
            restart.delay(),
            after_failure,
            "policy edits do not escalate"
        );
        // ...nor launder an existing streak into a clean bill of health.
        assert_eq!(
            restart.failures(),
            1,
            "policy edits do not reset the streak"
        );
    }

    #[test]
    fn an_isolated_failure_between_healthy_ticks_never_escalates() {
        let (_, status, failures) = run(&[
            TickObservation::WatchLost,
            TickObservation::Healthy { clean: true },
            TickObservation::ActorLost,
            TickObservation::Healthy { clean: true },
            TickObservation::ReconcileFailed,
            TickObservation::Healthy { clean: true },
        ]);
        assert_eq!(failures, 0);
        assert!(!status.terminal(), "recovered blips are not terminal");
    }

    #[test]
    fn degradation_is_not_cleared_by_a_start_that_has_not_proven_itself() {
        // The status triple must never read (degraded=false, terminal=true).
        // It did, twice a second, while a watch flapped: a bare successful
        // start cleared `degraded` but only a healthy TICK clears `terminal`.
        let status = DriverStatus::default();
        let mut restart = RestartTracker::default();
        for _ in 0..MAX_RESTART_ATTEMPTS {
            restart.observe(TickObservation::WatchLost, &status);
        }
        assert!(status.terminal());
        // This is the condition the loop consults before clearing `degraded`
        // on a successful start.
        assert!(
            restart.failures() > 0,
            "a driver mid-streak must not advertise a clean start"
        );
        restart.observe(TickObservation::Healthy { clean: true }, &status);
        assert!(!status.terminal());
        assert!(
            !status.degraded(),
            "a clean tick must clear degradation, or one blip latches it forever"
        );
    }

    #[test]
    fn a_tick_whose_apply_failed_does_not_clear_its_own_degradation() {
        let status = DriverStatus::default();
        let mut restart = RestartTracker::default();
        // apply_run reported failures: the driver marks degraded, then the
        // very same tick reports Healthy (watch alive, reconcile completed).
        status.degraded.store(true, Ordering::Release);
        restart.observe(TickObservation::Healthy { clean: false }, &status);
        assert!(
            status.degraded(),
            "an apply failure must stay visible past the tick that raised it"
        );
        // The next fully clean tick is what clears it.
        restart.observe(TickObservation::Healthy { clean: true }, &status);
        assert!(!status.degraded());
    }
}

/// Loop-level tests. These drive the REAL `drive_loop` against a scripted
/// environment under paused time, so they observe what the loop actually
/// waits on and rebuilds. The earlier suite asserted on `RestartTracker`
/// alone and stayed green when the loop's cadence was reverted to the very
/// bug it was written for; every test here fails under that mutation.
#[cfg(test)]
mod drive_loop_tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Script {
        StartFails,
        WatchLost,
        ActorLost,
        ReconcileFails,
        Healthy,
        HealthyButDirtyApply,
        /// A healthy tick during which the watcher records ONE more
        /// disruption (backend error / root-identity blip that re-attached).
        Disrupted,
        /// The root's policy fingerprint differs from the layer's.
        PolicyChanged,
        /// The policy files cannot be read right now (transient lock).
        PolicyUnreadable,
    }

    struct FakeLayer {
        fingerprint: Option<u64>,
        /// The global disruption count when this watcher was built — a fresh
        /// watcher counts from zero, exactly like the real one.
        base_disruptions: u64,
    }

    /// Records what the loop did and when, in virtual time.
    #[derive(Default)]
    struct Journal {
        starts: Vec<std::time::Duration>,
        ticks: Vec<std::time::Duration>,
        stops: usize,
        /// `status.degraded` / `status.running` sampled DURING each tick —
        /// what a `watcher.status` RPC arriving at that moment would see.
        degraded_seen: Vec<bool>,
        running_seen: Vec<bool>,
    }

    struct FakeEnv {
        script: Vec<Script>,
        step: usize,
        origin: tokio::time::Instant,
        journal: Arc<Mutex<Journal>>,
        policy: u64,
        /// Disruptions emitted so far. Bumped at TICK END, so a `Disrupted`
        /// entry becomes visible at the NEXT pass's check — like a real
        /// watcher whose events land between polls.
        emitted: u64,
        /// The real `apply_run` marks the driver degraded when an apply
        /// fails; the fake mirrors that, or a test asserting on degradation
        /// would only be testing the fake.
        status: Arc<DriverStatus>,
    }

    impl FakeEnv {
        fn new(
            script: Vec<Script>,
            journal: Arc<Mutex<Journal>>,
            status: Arc<DriverStatus>,
        ) -> Self {
            FakeEnv {
                script,
                step: 0,
                origin: tokio::time::Instant::now(),
                journal,
                policy: 1,
                emitted: 0,
                status,
            }
        }
        /// The script entry governing the CURRENT pass; the last entry repeats
        /// so a script can describe a steady state.
        fn current(&self) -> Script {
            let index = self.step.min(self.script.len().saturating_sub(1));
            self.script[index]
        }
        fn elapsed(&self) -> std::time::Duration {
            tokio::time::Instant::now().duration_since(self.origin)
        }
    }

    impl DriverEnv for FakeEnv {
        type Layer = FakeLayer;

        fn policy_fingerprint(&self) -> Option<u64> {
            match self.current() {
                Script::PolicyChanged => Some(self.policy + 1),
                Script::PolicyUnreadable => None,
                _ => Some(self.policy),
            }
        }
        fn layer_fingerprint(&self, layer: &FakeLayer) -> Option<u64> {
            layer.fingerprint
        }
        fn watch_lost(&self, _layer: &FakeLayer) -> bool {
            self.current() == Script::WatchLost
        }
        fn watch_disruptions(&self, layer: &FakeLayer) -> u64 {
            self.emitted - layer.base_disruptions
        }

        async fn start_layer(&mut self, _cancel: &CancellationToken) -> Result<FakeLayer, ()> {
            self.journal
                .lock()
                .expect("journal")
                .starts
                .push(self.elapsed());
            if self.current() == Script::StartFails {
                self.step += 1;
                return Err(());
            }
            // Adopt the CURRENT fingerprint, as RealEnv does (it reads the
            // policy before building the seed). A fake that pinned the old
            // value here rebuilt forever after a settled edit, which forced
            // the exactly-once test down to `>= 2` — masking a real
            // adopt-the-fingerprint regression.
            Ok(FakeLayer {
                fingerprint: self.policy_fingerprint(),
                base_disruptions: self.emitted,
            })
        }

        async fn tick(&mut self, _layer: &FakeLayer, _cancel: &CancellationToken) -> TickIo {
            {
                let mut journal = self.journal.lock().expect("journal");
                journal.ticks.push(self.elapsed());
                // What a status RPC arriving mid-tick would observe.
                journal.degraded_seen.push(self.status.degraded());
                journal.running_seen.push(self.status.running());
            }
            let script = self.current();
            self.step += 1;
            match script {
                Script::ActorLost => TickIo::ActorLost,
                Script::ReconcileFails => TickIo::Failed,
                Script::HealthyButDirtyApply => {
                    self.status.degraded.store(true, Ordering::Release);
                    TickIo::Applied { clean: false }
                }
                Script::PolicyUnreadable => {
                    // Fidelity: while the policy is unknown the SINK holds
                    // its ops (POLICY_UNAVAILABLE), so the apply reports
                    // failures — the tick is degraded, not clean.
                    self.status.degraded.store(true, Ordering::Release);
                    TickIo::Applied { clean: false }
                }
                Script::Disrupted => {
                    // The disruption lands DURING this tick's window; the
                    // watcher's counter reflects it at the next check.
                    self.emitted += 1;
                    TickIo::Applied { clean: true }
                }
                _ => TickIo::Applied { clean: true },
            }
        }

        async fn stop_layer(&mut self, _layer: FakeLayer) {
            self.journal.lock().expect("journal").stops += 1;
            self.step += 1;
        }
    }

    /// Run the loop under paused time for `budget` of virtual time.
    async fn drive_for(
        script: Vec<Script>,
        budget: std::time::Duration,
    ) -> (Journal, Arc<DriverStatus>) {
        let journal = Arc::new(Mutex::new(Journal::default()));
        let status = Arc::new(DriverStatus::default());
        let cancel = CancellationToken::new();
        let (baseline_tx, _baseline_rx) = tokio::sync::watch::channel(false);
        let mut env = FakeEnv::new(script, Arc::clone(&journal), Arc::clone(&status));

        let loop_status = Arc::clone(&status);
        let loop_cancel = cancel.clone();
        let handle = tokio::spawn(async move {
            drive_loop(&mut env, loop_cancel, loop_status, baseline_tx).await
        });

        tokio::time::sleep(budget).await;
        cancel.cancel();
        handle.await.expect("driver loop");

        let journal = Arc::try_unwrap(journal)
            .map(|m| m.into_inner().expect("journal"))
            .unwrap_or_else(|_| panic!("journal still shared"));
        (journal, status)
    }

    /// Gaps between successive timestamps.
    fn gaps(stamps: &[std::time::Duration]) -> Vec<std::time::Duration> {
        stamps.windows(2).map(|w| w[1] - w[0]).collect()
    }

    #[tokio::test(start_paused = true)]
    async fn a_failing_start_is_retried_on_the_escalating_backoff() {
        let (journal, status) =
            drive_for(vec![Script::StartFails], std::time::Duration::from_secs(20)).await;
        assert_eq!(
            gaps(&journal.starts),
            vec![
                std::time::Duration::from_millis(500),
                std::time::Duration::from_secs(1),
                std::time::Duration::from_secs(2),
                std::time::Duration::from_secs(4),
                std::time::Duration::from_secs(8),
            ],
            "rebuild attempts must widen, not repeat at the drive interval"
        );
        assert!(status.degraded());
    }

    #[tokio::test(start_paused = true)]
    async fn a_watch_that_dies_every_tick_rebuilds_on_the_backoff_not_hot() {
        // THE regression this shard exists for. The layer STARTS fine every
        // time and then loses its watch, so a naive loop rebuilds — full
        // actor + watcher + baseline scan — every drive interval forever.
        let (journal, status) =
            drive_for(vec![Script::WatchLost], std::time::Duration::from_secs(20)).await;
        assert!(
            journal.starts.len() >= 2,
            "the layer must actually be rebuilt"
        );
        assert_eq!(
            gaps(&journal.starts),
            vec![
                std::time::Duration::from_millis(500),
                std::time::Duration::from_secs(1),
                std::time::Duration::from_secs(2),
                std::time::Duration::from_secs(4),
                std::time::Duration::from_secs(8),
            ],
            "a flapping watch must back off between rebuilds"
        );
        assert_eq!(
            journal.stops,
            journal.starts.len(),
            "every layer is stopped — the rebuilt ones before their successor, \
             the last one at shutdown. Any shortfall is a leaked watcher thread."
        );
        assert!(status.degraded());
    }

    #[tokio::test(start_paused = true)]
    async fn a_dead_files_actor_also_backs_off_and_reports_terminal() {
        let (journal, status) =
            drive_for(vec![Script::ActorLost], std::time::Duration::from_secs(60)).await;
        assert_eq!(
            gaps(&journal.starts)[..5],
            [
                std::time::Duration::from_millis(500),
                std::time::Duration::from_secs(1),
                std::time::Duration::from_secs(2),
                std::time::Duration::from_secs(4),
                std::time::Duration::from_secs(8),
            ],
            "a dead actor must escalate exactly like a dead watch"
        );
        assert!(
            status.terminal(),
            "a permanently dead actor is reported terminal"
        );
        assert!(!status.running(), "terminal must never claim running");
        // ...and not just at the end: each recovery probe STARTS a layer that
        // then dies. A bare start mid-streak must not claim `running` — a
        // status RPC landing in that window would read running && terminal.
        assert!(
            journal.running_seen[1..].iter().all(|running| !running),
            "a probe-window start must not claim running: {:?}",
            journal.running_seen
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_healthy_driver_polls_at_the_drive_interval() {
        let (journal, status) =
            drive_for(vec![Script::Healthy], std::time::Duration::from_secs(5)).await;
        assert!(
            gaps(&journal.ticks)
                .iter()
                .all(|gap| *gap == DRIVE_INTERVAL),
            "healthy polling must stay at the drive interval: {:?}",
            gaps(&journal.ticks)
        );
        assert_eq!(journal.starts.len(), 1, "a healthy layer is never rebuilt");
        assert_eq!(
            journal.starts.first().copied(),
            Some(std::time::Duration::ZERO),
            "the first start happens immediately — workspace.open pays no \
             sleep before the startup baseline"
        );
        assert!(!status.degraded());
        assert!(!status.terminal());
    }

    #[tokio::test(start_paused = true)]
    async fn a_permanently_failing_reconcile_slows_down_and_is_finally_rebuilt() {
        // Some reconcile errors are structural (a workspace over the scan
        // cap) and no amount of retrying fixes them. The driver must not poll
        // a wedged layer at the fast cadence forever, and must not advertise
        // `running` while it reports `terminal`.
        let (journal, status) = drive_for(
            vec![Script::ReconcileFails],
            // Long enough to escalate to terminal (~31s) AND wait out one
            // terminal probe (30s), which is when the rebuild happens.
            std::time::Duration::from_secs(90),
        )
        .await;
        let tick_gaps = gaps(&journal.ticks);
        assert!(
            tick_gaps.iter().any(|gap| *gap > DRIVE_INTERVAL),
            "a repeatedly failing reconcile must back off: {tick_gaps:?}"
        );
        assert!(status.terminal(), "and eventually report terminal");
        assert!(
            journal.starts.len() >= 2,
            "a wedged layer is finally rebuilt rather than polled forever"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_recovered_watch_disruption_does_not_latch_degraded_forever() {
        // `watch_degraded` is STICKY for the life of the layer, so folding it
        // into every tick's cleanliness would leave `degraded` true forever
        // after one recovered blip — with a live watch and every reconcile
        // succeeding, and no path to clear it.
        let (_, status) = drive_for(
            vec![Script::Disrupted, Script::Healthy],
            std::time::Duration::from_secs(5),
        )
        .await;
        assert!(
            !status.degraded(),
            "a recovered disruption must be reported once, not latched"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_failing_apply_keeps_degraded_visible() {
        let (_, status) = drive_for(
            vec![Script::HealthyButDirtyApply],
            std::time::Duration::from_secs(5),
        )
        .await;
        assert!(
            status.degraded(),
            "an apply that keeps failing must stay visible"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_rapidly_rewritten_policy_file_does_not_rebuild_every_tick() {
        // A full rebuild per tick is the same pathology as the hot restart
        // loop: fresh actor, fresh watcher, full baseline rescan. The
        // fingerprint must HOLD for a tick before it costs one.
        let (journal, _) = drive_for(
            vec![
                Script::Healthy,
                Script::PolicyChanged,
                Script::Healthy,
                Script::PolicyChanged,
                Script::Healthy,
            ],
            std::time::Duration::from_secs(5),
        )
        .await;
        assert_eq!(
            journal.starts.len(),
            1,
            "an unstable fingerprint must not trigger a rebuild at all"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_settled_policy_edit_does_rebuild_exactly_once() {
        // One healthy tick on the base policy, then the edit appears and
        // HOLDS. Exactly one rebuild: the debounce absorbs the first sighting,
        // the second confirms, and the rebuilt layer adopts the new
        // fingerprint so it must never rebuild again. `>= 2` here would hide
        // a rebuild-forever regression.
        let (journal, _) = drive_for(
            vec![Script::Healthy, Script::PolicyChanged],
            std::time::Duration::from_secs(5),
        )
        .await;
        assert_eq!(
            journal.starts.len(),
            2,
            "a held policy edit costs exactly one rebuild, then settles"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_second_disruption_on_the_same_layer_is_rereported() {
        // The counter seam exists for exactly this: a sticky BOOL can be
        // edge-triggered once per layer, so after the first report-and-clear
        // every later disruption on the same live watch was silently
        // swallowed — a status reader saw "healthy" through a genuinely new
        // root-swap. With the count, each new disruption re-raises degraded
        // and a clean tick still clears it afterwards.
        let (journal, _) = drive_for(
            vec![
                Script::Healthy,
                Script::Disrupted,
                Script::Healthy,
                Script::Disrupted,
                Script::Healthy,
                Script::Healthy,
                Script::Healthy,
            ],
            std::time::Duration::from_secs(4),
        )
        .await;
        // A disruption during tick N is visible at tick N+1's check, and a
        // report raised at N+1 clears after the clean tick N+2 — so the
        // observable pattern lags the script by one.
        let seen = &journal.degraded_seen;
        assert!(seen[2], "the first disruption is reported: {seen:?}");
        assert!(
            seen[3],
            "the report must OUTLIVE the tick that raised it — the detecting              tick reports itself unclean, so only the NEXT clean tick clears:              {seen:?}"
        );
        assert!(
            seen[4],
            "the SECOND disruption on the same layer must be re-reported: {seen:?}"
        );
        assert!(
            !seen[6],
            "and degradation still clears once disruptions stop: {seen:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_rebuilt_layer_rereports_disruptions_from_its_own_baseline() {
        // A fresh watcher counts from zero. If the loop kept the OLD layer's
        // seen-count across a rebuild, the new layer's first disruptions
        // would compare equal to the stale baseline and be swallowed.
        let (journal, _) = drive_for(
            vec![
                Script::Healthy,
                Script::Disrupted,
                Script::Healthy,
                Script::WatchLost,
                Script::Healthy,
                Script::Disrupted,
                Script::Healthy,
                Script::Healthy,
            ],
            std::time::Duration::from_secs(6),
        )
        .await;
        // Tick samples: indices 0-2 are layer 1 (the WatchLost pass has no
        // tick), then 3,4,5,… are layer 2. The layer-2 disruption lands
        // during sample 4's tick and is REPORTED at sample 5.
        let seen = &journal.degraded_seen;
        assert!(
            !seen[4],
            "the rebuilt layer's clean ticks must not inherit a stale \
             baseline (a spurious report here means the seen-count was not \
             re-baselined at start): {seen:?}"
        );
        assert!(
            seen[5],
            "a disruption on the REBUILT layer must be reported: {seen:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_intermittently_unreadable_policy_file_still_applies_the_edit() {
        // A transiently-locked policy file must HOLD the debounce, not feed
        // it a distinct error-hash: with the error hashed as content, the
        // fingerprint alternated edit/error/edit, the same value never held
        // two consecutive ticks, and a real edit was ignored forever.
        let (journal, _) = drive_for(
            vec![
                Script::Healthy,
                Script::PolicyChanged,
                Script::PolicyUnreadable,
                Script::PolicyChanged,
                Script::Healthy,
            ],
            std::time::Duration::from_secs(5),
        )
        .await;
        assert_eq!(
            journal.starts.len(),
            2,
            "the held edit must rebuild exactly once despite unreadable ticks"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn policy_recovery_after_an_unknown_window_reoffers_held_paths() {
        // While the policy is unreadable the sink HOLDS ops; the failures
        // land in the quarantine and stop self-forcing scans. If the policy
        // then recovers with the SAME bytes, the equality branch never
        // rebuilds — so the recovery itself must trigger one rebuild (whose
        // baseline re-offers everything held) whenever status is degraded.
        let (journal, _) = drive_for(
            vec![Script::Healthy, Script::PolicyUnreadable, Script::Healthy],
            std::time::Duration::from_secs(5),
        )
        .await;
        assert!(
            journal.starts.len() >= 2,
            "recovering from an unknown policy while degraded must rebuild: {} starts",
            journal.starts.len()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_is_not_delayed_by_a_terminal_backoff() {
        // The slow probe must never hold up workspace close.
        let journal = Arc::new(Mutex::new(Journal::default()));
        let status = Arc::new(DriverStatus::default());
        let cancel = CancellationToken::new();
        let (baseline_tx, _rx) = tokio::sync::watch::channel(false);
        let mut env = FakeEnv::new(
            vec![Script::StartFails],
            Arc::clone(&journal),
            Arc::clone(&status),
        );
        let loop_cancel = cancel.clone();
        let handle =
            tokio::spawn(
                async move { drive_loop(&mut env, loop_cancel, status, baseline_tx).await },
            );
        // Let it escalate deep into the backoff.
        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
        let before = tokio::time::Instant::now();
        cancel.cancel();
        handle.await.expect("driver loop");
        assert!(
            tokio::time::Instant::now().duration_since(before) < std::time::Duration::from_secs(1),
            "cancel must cut the backoff sleep short"
        );
    }
}

/// The daemon-side handle to one workspace's capture driver.
pub(crate) struct CaptureDriver {
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
    status: Arc<DriverStatus>,
    /// Resolves once the STARTUP baseline reconcile has been applied (or the
    /// initial layer start failed) — `workspace.open` awaits this so a
    /// caller's first RPC write can never be overwritten by a later capture
    /// of stale closed-period disk bytes.
    baseline: tokio::sync::watch::Receiver<bool>,
}

/// A dropped-but-untaken driver must never keep running: cancel on Drop (the
/// task then winds itself down detached).
impl Drop for CaptureDriver {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

impl CaptureDriver {
    /// Spawn the files layer for a SHADOW-BOUND workspace. Must only be
    /// called after `bind_shadow_clone` succeeded — the sink writes through
    /// the shadow-bound store actor, and an unmarked root must never spawn a
    /// watcher (the caller's shadow validation guarantees it).
    pub(crate) fn spawn(root: PathBuf, actor: ActorHandle, workspace_id: String) -> CaptureDriver {
        let cancel = CancellationToken::new();
        let status = Arc::new(DriverStatus::default());
        let (baseline_tx, baseline) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(drive(
            root,
            actor,
            workspace_id,
            cancel.clone(),
            Arc::clone(&status),
            baseline_tx,
        ));
        CaptureDriver {
            cancel,
            task: Some(task),
            status,
            baseline,
        }
    }

    /// Wait until the startup baseline reconcile has been applied (or the
    /// initial start failed — the workspace still opens, degraded).
    pub(crate) async fn wait_for_baseline(&self) {
        let mut baseline = self.baseline.clone();
        while !*baseline.borrow() {
            if baseline.changed().await.is_err() {
                return;
            }
        }
    }

    #[cfg_attr(not(test), expect(dead_code))]
    pub(crate) fn status(&self) -> &Arc<DriverStatus> {
        &self.status
    }

    /// Cancel the loop SYNCHRONOUSLY and hand back the join handle; the
    /// driver winds itself down (watcher joined, files actor closed) whether
    /// or not the caller awaits. Callers that need ordered teardown await
    /// the handle BEFORE closing the store actor.
    pub(crate) fn begin_shutdown(mut self) -> Option<tokio::task::JoinHandle<()>> {
        self.cancel.cancel();
        self.task.take()
    }
}

/// One incarnation of the files layer.
struct FilesLayer {
    files: FilesActor,
    watcher: NativeWatcher,
    policy_fingerprint: Option<u64>,
}

impl FilesLayer {
    /// Spawn the files actor and attach the watcher; the watcher's startup
    /// reconcile (the full baseline scan) is returned for the caller to
    /// apply through the normal capture path.
    /// Start with a CALLER-SUPPLIED policy fingerprint. The driver reads it
    /// BEFORE building the seed, so a policy edit that races startup leaves
    /// the layer holding the older fingerprint and the next tick restarts —
    /// recording the newer one would swallow the edit (the seed would
    /// reflect old policy while the layer claimed to be current).
    async fn start_with_fingerprint(
        root: &Path,
        cancel: &CancellationToken,
        seed: Option<(ScanManifest, ScanGeneration)>,
        policy_fingerprint: Option<u64>,
    ) -> Result<(FilesLayer, ReconcileRun), FilesError> {
        let files =
            FilesActor::spawn_async_with_manifest(root.to_path_buf(), ScanBounds::default(), seed)
                .await?;
        let handle = files.handle();
        match NativeWatcher::start(root.to_path_buf(), handle, cancel.child_token()).await {
            Ok(start) => Ok((
                FilesLayer {
                    files,
                    watcher: start.watcher,
                    policy_fingerprint,
                },
                start.initial_reconcile,
            )),
            Err(err) => {
                let mut files = files;
                let _ = tokio::task::spawn_blocking(move || files.close()).await;
                Err(err)
            }
        }
    }

    /// Strictly ordered teardown: stop+join the watcher FIRST (no dirty marks
    /// can arrive afterwards), then close+join the files actor.
    async fn stop(mut self) {
        let _ = tokio::task::spawn_blocking(move || {
            let _ = self.watcher.stop();
            let _ = self.files.close();
        })
        .await;
    }
}

/// A cheap change-detector over the two policy files. Content-hash based so
/// touch-without-change does not force a re-offer. ABSENCE is a real,
/// hashable state (no files.toml is simply the default policy); any OTHER
/// read error means the current policy is UNKNOWN — returned as `None` so
/// the debounce holds position instead of comparing against a fabricated
/// error-hash, which flapped under an intermittently-locked file.
fn policy_fingerprint(root: &Path) -> Option<u64> {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    for name in ["files.toml", "visibility.toml"] {
        let path = root.join(".dohc").join(name);
        // MIRROR the policy reader's refusals: it rejects a symlinked or
        // non-regular-file policy as Unreadable WITHOUT following it, while a
        // plain read() would follow the link and hash the target's content.
        // Diverging here strands recovery — the sink holds (reader refused)
        // but the fingerprint never reads as unknown, so the None->Some
        // recovery rebuild never fires.
        let refused = match std::fs::symlink_metadata(&path) {
            Ok(meta) => {
                meta.file_type().is_symlink()
                    || !meta.file_type().is_file()
                    // The reader refuses oversize files too; hashing one here
                    // would diverge the same way a followed symlink did.
                    || meta.len() > dohc_engine_runtime::search::POLICY_FILE_MAX_BYTES
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                0u8.hash(&mut hasher);
                continue;
            }
            Err(_) => true,
        };
        let read = if refused {
            Err(())
        } else {
            std::fs::read(&path).map_err(|_| ())
        };
        match read {
            Ok(bytes) => {
                1u8.hash(&mut hasher);
                bytes.hash(&mut hasher);
            }
            // Only files.toml governs capture OWNERSHIP, so only its
            // unreadability makes the fingerprint unknown. An unreadable
            // visibility.toml hashes as a stable marker instead — holding on
            // it would block files.toml edits from ever rebuilding, and the
            // worst it can cause is one debounced re-offer when its
            // readability flips.
            Err(()) if name == "files.toml" => return None,
            Err(()) => 2u8.hash(&mut hasher),
        }
    }
    Some(hasher.finish())
}

/// Build the rehydration seed from the domain's captured state for the
/// version capture will target. `None` (uninitialized workspace or a read
/// failure) starts from the empty baseline.
async fn manifest_seed(
    root: &Path,
    actor: &ActorHandle,
    workspace_id: &str,
) -> Option<(ScanManifest, ScanGeneration)> {
    let version_id = match actor.active_version_id(workspace_id.to_owned()).await {
        Ok(version_id) => version_id,
        Err(RuntimeError::Domain(dohc_engine_domain::DomainError::WorkspaceNotFound)) => {
            return None;
        }
        Err(_) => return None,
    };
    let entries = actor
        .capture_manifest_seed(workspace_id.to_owned(), version_id)
        .await
        .ok()?;
    if entries.is_empty() {
        return None;
    }
    // EVERY capture-owned entry is seeded — including paths the CURRENT
    // policy narrows out, but with a SENTINEL hash. That single choice
    // satisfies both halves of the policy-flip obligation:
    //   * narrowed AND still on disk -> the sentinel can never match the
    //     scanned hash, so the path is re-offered as `Changed` and the
    //     sink's policy branch retires it;
    //   * narrowed AND deleted while closed -> it is absent from the listing
    //     but PRESENT in the manifest, so the diff emits a Retire.
    // Dropping narrowed entries entirely would lose the second case forever
    // (the scanner enumerates by the hard floor, so such a path would appear
    // in neither the listing nor the manifest).
    let policy = dohc_engine_runtime::search::read_engine_search_policy(root).files_policy;
    let manifest = ScanManifest::from_entries(entries.into_iter().map(|entry| {
        let narrowed = policy.as_ref().is_some_and(|rules| {
            !matches!(
                dohc_engine_files::policy::classify_engine_file_path(&entry.path),
                dohc_engine_files::policy::PathClassification::Secret
            ) && !dohc_engine_runtime::search::resolve_effective_policy(
                &entry.path,
                Some(rules.as_slice()),
                None,
            )
            .tracked
        });
        let sha256 = if narrowed {
            NARROWED_SEED_SENTINEL_SHA.to_owned()
        } else {
            entry.sha256
        };
        (
            entry.path,
            ManifestEntry {
                size: entry.size,
                sha256,
            },
        )
    }));
    Some((manifest, ScanGeneration(1)))
}

/// Never a valid hex digest, so a seeded entry carrying it always re-offers.
const NARROWED_SEED_SENTINEL_SHA: &str = "policy-narrowed-reoffer";

/// Whether `.dohc/files.toml` currently narrows `path` out of engine
/// ownership (the secret floor is policy-independent and never narrowed).
/// One policy read for a whole apply run's over-cap evaluations.
/// `Some(rules)` under a KNOWN policy (`None` inside = no narrowing);
/// OUTER `None` when files.toml exists but cannot be read — the caller must
/// hold loudly (failed apply), because a silent skip records no failure,
/// keeps nothing dirty, and so the policy-recovery rebuild would never fire
/// to retry it.
type CapturePolicy = Option<Option<Vec<dohc_engine_runtime::search::FilesPolicyRule>>>;

fn read_capture_policy(root: &Path) -> CapturePolicy {
    let snapshot = dohc_engine_runtime::search::read_engine_search_policy(root);
    if snapshot.diagnostics.iter().any(|diagnostic| {
        diagnostic.file == "files.toml"
            && diagnostic.reason == dohc_engine_runtime::search::DiagnosticReason::Unreadable
    }) {
        return None;
    }
    Some(snapshot.files_policy)
}

/// Whether a KNOWN policy narrows `path` out of engine ownership (the secret
/// floor is policy-independent and never narrowed).
fn policy_excludes(
    policy: &Option<Vec<dohc_engine_runtime::search::FilesPolicyRule>>,
    path: &str,
) -> bool {
    let Some(rules) = policy else {
        return false;
    };
    if matches!(
        dohc_engine_files::policy::classify_engine_file_path(path),
        dohc_engine_files::policy::PathClassification::Secret
    ) {
        return false;
    }
    !dohc_engine_runtime::search::resolve_effective_policy(path, Some(rules.as_slice()), None)
        .tracked
}

fn wall_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// The I/O one driver tick performs, behind a seam so the loop's CADENCE and
/// restart decisions are testable without a filesystem. Two rounds of review
/// found real defects in this loop that every test missed, because the tests
/// asserted on [`RestartTracker`] while the loop chose its own timing — a
/// mutation restoring the original bug left the whole suite green. The loop
/// is now generic over this trait so a fake can drive it under paused time
/// and assert what it actually waited on.
trait DriverEnv {
    type Layer;

    /// The root's CURRENT policy fingerprint; `None` when the policy files
    /// could not be read right now (transient lock/permission error). Unknown
    /// is NOT a distinct state to compare — the debounce holds position on
    /// it, else an intermittently-locked file alternates real/error hashes
    /// and a genuine edit is never confirmed.
    fn policy_fingerprint(&self) -> Option<u64>;
    /// The fingerprint the layer was built against (`None` if the policy was
    /// unreadable at build time).
    fn layer_fingerprint(&self, layer: &Self::Layer) -> Option<u64>;
    /// The OS watch is permanently gone.
    fn watch_lost(&self, layer: &Self::Layer) -> bool;
    /// MONOTONE count of watch disruptions this layer's watcher has seen.
    /// A bool here can only be edge-triggered once per layer — after the
    /// first report-and-clear, every later disruption on the same live watch
    /// would be silently swallowed. The loop re-reports whenever the count
    /// moves.
    fn watch_disruptions(&self, layer: &Self::Layer) -> u64;

    /// Build a fresh layer and drive its startup baseline to settle.
    async fn start_layer(&mut self, cancel: &CancellationToken) -> Result<Self::Layer, ()>;
    /// One reconcile + apply.
    async fn tick(&mut self, layer: &Self::Layer, cancel: &CancellationToken) -> TickIo;
    async fn stop_layer(&mut self, layer: Self::Layer);
}

/// What one reconcile+apply did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TickIo {
    /// Reconciled and applied; `clean` is false when the apply reported
    /// failures or the scan itself was degraded.
    Applied { clean: bool },
    /// The files actor died under us.
    ActorLost,
    /// The reconcile failed while the layer stayed up.
    Failed,
}

/// Decide whether a policy edit should rebuild the layer THIS tick.
///
/// A policy rebuild is expensive (fresh actor, fresh watcher, full baseline
/// rescan), so a new fingerprint must HOLD for one tick before it triggers
/// one. Without the debounce, anything rewriting `files.toml` faster than the
/// drive interval — an agent syncing config, an editor autosaving — drives a
/// full rescan every tick forever, and a transient read error (which hashes
/// differently from any successful read) flaps the rebuild indefinitely.
fn policy_rebuild_due<E: DriverEnv>(env: &E, layer: &E::Layer, pending: &mut Option<u64>) -> bool {
    // Unknown (unreadable policy) HOLDS the debounce in place: it neither
    // confirms nor cancels a pending edit. Treating the error as a distinct
    // hash instead made an intermittently-locked file alternate
    // real/error/real — the same value never held two consecutive ticks, and
    // a genuine edit was ignored forever.
    let Some(current) = env.policy_fingerprint() else {
        return false;
    };
    if Some(current) == env.layer_fingerprint(layer) {
        *pending = None;
        return false;
    }
    if *pending == Some(current) {
        *pending = None;
        return true;
    }
    *pending = Some(current);
    false
}

/// The driver loop. Owns the files layer end to end; a missing layer (initial
/// or restart failure) is rebuilt after the supervision backoff rather than
/// killing the driver.
async fn drive_loop<E: DriverEnv>(
    env: &mut E,
    cancel: CancellationToken,
    status: Arc<DriverStatus>,
    baseline_tx: tokio::sync::watch::Sender<bool>,
) {
    let mut layer: Option<E::Layer> = None;
    let mut restart = RestartTracker::default();
    let mut first_pass = true;
    // The disruption count already seen (and reported) for the CURRENT layer.
    let mut seen_disruptions: u64 = 0;
    let mut pending_policy: Option<u64> = None;
    // Whether the previous pass saw an UNKNOWN policy fingerprint. Needed at
    // recovery: ops held during the unknown window failed into the
    // quarantine, and if the policy comes back with the SAME bytes the
    // equality branch would never rebuild — nothing would ever re-offer the
    // held paths.
    let mut policy_was_unknown = false;

    loop {
        // THE cadence, and the ONLY sleep: a healthy driver waits
        // DRIVE_INTERVAL (restart_delay(0)), a failing one waits out its
        // backoff — whether it is about to rebuild the layer or retry a
        // reconcile on a layer it kept. Keeping it here, before every branch,
        // is what stops a failure path from `continue`ing around it and
        // rebuilding hot. Skipped once so `workspace.open` pays no latency.
        if !first_pass {
            tokio::select! {
                biased;
                () = cancel.cancelled() => break,
                () = tokio::time::sleep(restart.delay()) => {}
            }
        }
        first_pass = false;

        if layer.is_none() {
            match env.start_layer(&cancel).await {
                Ok(fresh) => {
                    // `running` is claimed on a bare start ONLY outside a
                    // failure streak. Mid-streak (including terminal recovery
                    // probes) a start proves nothing — the last N layers also
                    // started and then died — and claiming it here made the
                    // status read running=true && terminal=true for the probe
                    // window. The first healthy tick sets it instead.
                    // `degraded` likewise stays until a fully clean tick.
                    if restart.failures() == 0 {
                        status.running.store(true, Ordering::Release);
                    }
                    // Baseline for the NEW layer's watcher (a fresh watcher
                    // counts from zero; taking its current value also holds if
                    // it observed a disruption during its own startup scan).
                    seen_disruptions = env.watch_disruptions(&fresh);
                    pending_policy = None;
                    // A fresh layer read the policy at its own build time; the
                    // previous layer's unknown-policy window must not make the
                    // first readable fingerprint look like a recovery and cost
                    // a spurious rebuild.
                    policy_was_unknown = false;
                    layer = Some(fresh);
                }
                Err(()) => {
                    // Transient start failures (a momentarily unwatchable
                    // root) must not be terminal: mark degraded and retry on
                    // the backoff schedule, escalating only after
                    // MAX_RESTART_ATTEMPTS consecutive failures.
                    restart.record_failure(&status);
                    status.running.store(false, Ordering::Release);
                }
            }
            // Whether the baseline applied or the start failed, the open
            // barrier releases: the workspace opens (possibly degraded), and
            // callers' first writes are ordered AFTER the startup capture.
            let _ = baseline_tx.send(true);
        }

        let Some(current) = layer.as_ref() else {
            continue;
        };

        // Classify the tick, then let the tracker decide. Routing EVERY
        // outcome through one decision point is what keeps a failure mode
        // from quietly escaping the backoff.
        let fingerprint = env.policy_fingerprint();
        let policy_recovered = fingerprint.is_some() && policy_was_unknown;
        policy_was_unknown = fingerprint.is_none();
        let observation = if env.watch_lost(current) {
            // A permanently lost watch tears the layer down; the rebuild
            // re-seeds via its own baseline reconcile, so no change is lost
            // across the gap.
            TickObservation::WatchLost
        } else if policy_recovered && status.degraded() {
            // The policy just became READABLE again after an unknown window.
            // Ops held during that window (the sink fails them) have been
            // quarantined — and if the recovered bytes EQUAL the layer's
            // fingerprint, the debounce would never rebuild, so nothing
            // would re-offer them. A recovery while degraded costs one
            // rebuild; its baseline re-offers every held path.
            TickObservation::PolicyChanged
        } else if policy_rebuild_due(env, current, &mut pending_policy) {
            // Policy-flip re-offer: narrowed paths retire, widened paths
            // re-ingest. The rebuild seeds from the REHYDRATED manifest, not
            // an empty one: an empty baseline cannot emit a Retire for a path
            // deleted from disk in the same window as the policy edit.
            TickObservation::PolicyChanged
        } else {
            // EDGE-triggered on the COUNT: report whenever the watcher has
            // seen disruptions we have not. Folding a sticky signal into
            // `clean` every tick latched `degraded` forever after one
            // recovered blip; edge-triggering a BOOL reported at most once
            // per layer and then went blind to genuinely new disruptions on
            // the same live watch. The count re-reports each one and still
            // clears within a tick once they stop.
            let disruptions = env.watch_disruptions(current);
            let fresh_disruption = disruptions != seen_disruptions;
            if fresh_disruption {
                seen_disruptions = disruptions;
                status.degraded.store(true, Ordering::Release);
            }
            match env.tick(current, &cancel).await {
                // Only NOW has the layer survived a full tick: live watch AND
                // a reconcile that completed.
                TickIo::Applied { clean } => TickObservation::Healthy {
                    clean: clean && !fresh_disruption,
                },
                TickIo::ActorLost => TickObservation::ActorLost,
                TickIo::Failed => TickObservation::ReconcileFailed,
            }
        };

        if restart.observe(observation, &status) == LayerAction::Drop {
            // `running` goes false BEFORE the teardown await: stop_layer
            // joins the watcher thread and closes the files actor, and a
            // status reader sampling mid-join must not see running while a
            // terminal streak is being reported.
            status.running.store(false, Ordering::Release);
            if let Some(dead) = layer.take() {
                env.stop_layer(dead).await;
            }
        }
    }

    // BEFORE the joins, same as the Drop path: stop_layer drains threads,
    // and a status reader mid-join must not see a closing driver as running.
    status.running.store(false, Ordering::Release);
    if let Some(current) = layer.take() {
        env.stop_layer(current).await;
    }
}

/// The real filesystem-backed environment.
struct RealEnv {
    root: PathBuf,
    actor: ActorHandle,
    workspace_id: String,
    status: Arc<DriverStatus>,
}

impl DriverEnv for RealEnv {
    type Layer = FilesLayer;

    fn policy_fingerprint(&self) -> Option<u64> {
        policy_fingerprint(&self.root)
    }
    fn layer_fingerprint(&self, layer: &FilesLayer) -> Option<u64> {
        layer.policy_fingerprint
    }
    fn watch_lost(&self, layer: &FilesLayer) -> bool {
        layer.watcher.is_unavailable()
    }
    fn watch_disruptions(&self, layer: &FilesLayer) -> u64 {
        layer.watcher.disruption_count()
    }

    async fn start_layer(&mut self, cancel: &CancellationToken) -> Result<FilesLayer, ()> {
        // REHYDRATE the scan manifest from the domain's captured state:
        // against an EMPTY baseline a file deleted while the daemon was down
        // could never emit a Retire and its stale head would stay readable
        // forever. Secrets seed with a sentinel sha (plaintext hashes are
        // never stored) and re-offer once into the encrypted dedupe. A seed
        // failure degrades to the empty baseline (safe: over-capture, never
        // data loss) rather than blocking start.
        //
        // Read the policy fingerprint BEFORE the seed: if policy changes
        // between the two, the layer records the OLDER fingerprint and the
        // next tick detects the edit and rebuilds. Recording the newer one
        // would swallow the edit (the seed reflects old policy while the
        // layer claims to be current).
        let fingerprint_before_seed = policy_fingerprint(&self.root);
        let seed = manifest_seed(&self.root, &self.actor, &self.workspace_id).await;
        let (fresh, initial) =
            FilesLayer::start_with_fingerprint(&self.root, cancel, seed, fingerprint_before_seed)
                .await
                .map_err(|_| ())?;

        let mut settled = apply_run(
            &self.root,
            &self.actor,
            &self.workspace_id,
            &fresh,
            initial,
            &self.status,
        )
        .await;
        // The open barrier must not release on a FAILED baseline: a caller
        // whose first write lands before the retry could have it overwritten
        // by the retry's capture of stale closed-period disk bytes. Retry a
        // bounded number of times so a persistently failing path degrades the
        // workspace instead of blocking open forever.
        let mut attempts = 0;
        while !settled && attempts < BASELINE_SETTLE_ATTEMPTS {
            attempts += 1;
            tokio::select! {
                biased;
                () = cancel.cancelled() => break,
                () = tokio::time::sleep(DRIVE_INTERVAL) => {}
            }
            settled = match fresh
                .files
                .handle()
                .reconcile_if_dirty(cancel.child_token())
                .await
            {
                Ok(run) => {
                    apply_run(
                        &self.root,
                        &self.actor,
                        &self.workspace_id,
                        &fresh,
                        run,
                        &self.status,
                    )
                    .await
                }
                Err(_) => false,
            };
        }
        Ok(fresh)
    }

    async fn tick(&mut self, layer: &FilesLayer, cancel: &CancellationToken) -> TickIo {
        match layer
            .files
            .handle()
            .reconcile_if_dirty(cancel.child_token())
            .await
        {
            Ok(run) => {
                let clean = apply_run(
                    &self.root,
                    &self.actor,
                    &self.workspace_id,
                    layer,
                    run,
                    &self.status,
                )
                .await;
                // A clean-looking tick with a NON-EMPTY quarantine is not
                // health: the controller parks persistently failing paths on
                // its own degraded-rescan backoff and stops self-forcing
                // scans, so reconcile CONVERGES while capture has not
                // recovered — reading that as clean would clear `degraded`
                // over live failures. Only consulted when the tick looks
                // clean while status is degraded (a quarantine cannot form
                // without degraded ticks), so the happy path stays one actor
                // round-trip.
                if clean && self.status.degraded() {
                    match layer.files.handle().stats().await {
                        Ok(stats) => TickIo::Applied {
                            clean: stats.quarantined == 0,
                        },
                        // The actor died AFTER the reconcile round-trip. An
                        // unclean-but-HEALTHY tick would still reset the
                        // failure streak and re-claim `running` for a dead
                        // layer; report the death itself so the backoff
                        // governs the rebuild.
                        Err(_) => TickIo::ActorLost,
                    }
                } else {
                    TickIo::Applied { clean }
                }
            }
            Err(FilesError::ActorUnavailable) => TickIo::ActorLost,
            Err(_) => TickIo::Failed,
        }
    }

    async fn stop_layer(&mut self, layer: FilesLayer) {
        layer.stop().await;
    }
}

async fn drive(
    root: PathBuf,
    actor: ActorHandle,
    workspace_id: String,
    cancel: CancellationToken,
    status: Arc<DriverStatus>,
    baseline_tx: tokio::sync::watch::Sender<bool>,
) {
    let mut env = RealEnv {
        root,
        actor,
        workspace_id,
        status: Arc::clone(&status),
    };
    drive_loop(&mut env, cancel, status, baseline_tx).await;
}

/// Apply one reconcile run through the capture sink and acknowledge it.
///
/// INVARIANT: a prepared plan is ALWAYS acknowledged — the controller's
/// `outstanding` latch only resets on ack, so an early return that skipped it
/// would wedge every future reconcile into `StaleReconcilePlan` forever. On
/// abnormal paths (version fetch failure, apply-thread spawn failure or
/// panic) the plan is acked with an ALL-FAILED receipt: the latch clears,
/// the paths stay dirty, and the next cycle retries.
async fn apply_run(
    root: &Path,
    actor: &ActorHandle,
    workspace_id: &str,
    layer: &FilesLayer,
    run: ReconcileRun,
    status: &Arc<DriverStatus>,
) -> bool {
    let plan = match run {
        ReconcileRun::Completed(plan) => plan,
        ReconcileRun::Converged | ReconcileRun::Cancelled => return true,
    };
    // The ACTIVE version, precisely: only a genuinely uninitialized
    // workspace falls back to "main" (bootstrapped by ensure_main_version).
    // Storage errors and StateCorrupt must NOT be masked into a silent
    // capture into the wrong version — they fail this run (all-failed ack,
    // retried next cycle) and mark degraded.
    let version_id = match actor.active_version_id(workspace_id.to_owned()).await {
        Ok(version_id) => version_id,
        Err(dohc_engine_runtime::RuntimeError::Domain(
            dohc_engine_domain::DomainError::WorkspaceNotFound,
        )) => "main".to_owned(),
        Err(_) => {
            status.degraded.store(true, Ordering::Release);
            ack_all_failed(layer, plan, status).await;
            return false;
        }
    };
    let apply_actor = actor.clone();
    let apply_root = root.to_path_buf();
    let apply_workspace = workspace_id.to_owned();
    let version_for_retire = version_id.clone();
    let now_ms = wall_now_ms();
    // A DEDICATED plain thread, not spawn_blocking: the sink's blocking actor
    // calls assert they run OUTSIDE any tokio runtime context, and
    // spawn_blocking threads carry the runtime handle. Awaiting the oneshot
    // (uncancellable await) is also exactly the drain-before-close property —
    // teardown cannot interrupt a half-applied plan.
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let apply_plan = plan.clone();
    let apply_thread = std::thread::Builder::new()
        .name("dohc-capture-apply".to_owned())
        .spawn(move || {
            // A FRESH sink per run: the policy snapshot and (lazily loaded)
            // secret key are re-read per reconcile task, matching the TS
            // one-policy-snapshot-per-task rule.
            let mut sink = StoreCaptureSink::new(
                apply_actor,
                apply_workspace,
                version_id,
                apply_root,
                now_ms,
                None,
            );
            let result = apply_reconcile_plan(&apply_plan, &mut sink, &NoFaults);
            let _ = done_tx.send((apply_plan, result));
        });
    let applied: Option<(ReconcilePlan, CaptureApplyResult)> = match apply_thread {
        Ok(joiner) => {
            let outcome = done_rx.await.ok();
            let _ = tokio::task::spawn_blocking(move || joiner.join()).await;
            outcome
        }
        Err(_) => None,
    };
    let Some((plan, mut result)) = applied else {
        // Spawn failure or apply-thread panic: the plan must still resolve.
        status.degraded.store(true, Ordering::Release);
        ack_all_failed(layer, plan, status).await;
        return false;
    };
    // OVER-CAP + NARROWED: a path in the scanner's retained-over-cap set
    // never appears in the diff (CAL-3 keeps it last-known-good, never
    // Retire), so a policy narrow could never reach it through an op. Retire
    // those directly — policy exclusion is an OWNERSHIP decision, distinct
    // from the size-cap false-delete defense that protects still-tracked
    // content.
    // ONE policy read for the whole loop — a per-path re-read was N disk
    // round-trips for one answer, and could even give different paths a
    // DIFFERENT policy if an edit raced the loop.
    let capture_policy = if plan.retained_over_cap.is_empty() {
        Some(None)
    } else {
        read_capture_policy(root)
    };
    for path in &plan.retained_over_cap {
        let excluded = match &capture_policy {
            Some(policy) => policy_excludes(policy, path),
            // Unknown policy: hold LOUDLY. This loop is the only mechanism
            // that can retire an over-cap narrowed head, so the hold must
            // register as a failure (dirty + degraded) for the recovery
            // rebuild to retry — a silent skip strands the head forever.
            None => {
                result.failed_applies.push(path.clone());
                result.degraded = true;
                status.degraded.store(true, Ordering::Release);
                false
            }
        };
        if excluded {
            let retire_actor = actor.clone();
            let retire_workspace = workspace_id.to_owned();
            let retire_version = version_for_retire.clone();
            let retire_path = path.clone();
            let retire_root = root.to_path_buf();
            let retired = tokio::task::spawn_blocking(move || {
                let mut sink = StoreCaptureSink::new(
                    retire_actor,
                    retire_workspace,
                    retire_version,
                    retire_root,
                    now_ms,
                    None,
                );
                sink.retire_policy_excluded(&retire_path)
            })
            .await;
            // This loop is the ONLY path that can retire an over-cap narrowed
            // head (such a path never appears in the diff), so a swallowed
            // failure would strand it stale-but-authoritative with nothing to
            // re-offer it. Surface it so the driver stays degraded and the
            // next tick retries.
            match retired {
                // REPORT it in the receipt: the manifest must forget a path
                // whose head this loop just deleted, or a later policy widen
                // would diff clean and never re-ingest it.
                Ok(Ok(())) => result.not_owned_paths.push(path.clone()),
                // A FAILED over-cap retire must fail the receipt too: this
                // loop is the only thing that can retire such a head, so it
                // must stay dirty and retry. Setting only the sticky status
                // bit let the same tick report itself clean and clear the
                // degradation it had just raised — with nothing left to
                // retry the retire.
                _ => {
                    result.failed_applies.push(path.clone());
                    result.degraded = true;
                    status.degraded.store(true, Ordering::Release);
                }
            }
        }
    }
    if result.degraded {
        status.degraded.store(true, Ordering::Release);
    }
    let clean = result.failed_applies.is_empty() && !result.degraded;
    if result.completed()
        && layer
            .files
            .handle()
            .acknowledge_capture(plan, result)
            .await
            .is_err()
    {
        status.degraded.store(true, Ordering::Release);
        return false;
    }
    clean
}

/// Resolve a prepared plan whose apply never ran: acknowledge with EVERY op
/// marked failed, clearing the controller's `outstanding` latch while keeping
/// the paths dirty for the next cycle's retry.
async fn ack_all_failed(layer: &FilesLayer, plan: ReconcilePlan, status: &Arc<DriverStatus>) {
    let failed: Vec<String> = plan.ops.iter().map(|op| op.path().to_owned()).collect();
    let receipt = CaptureApplyResult {
        applied_paths: Vec::new(),
        captured: Vec::new(),
        not_owned_paths: Vec::new(),
        failed_applies: failed,
        crashed_after_apply: None,
        degraded: true,
    };
    if layer
        .files
        .handle()
        .acknowledge_capture(plan, receipt)
        .await
        .is_err()
    {
        status.degraded.store(true, Ordering::Release);
    }
}
