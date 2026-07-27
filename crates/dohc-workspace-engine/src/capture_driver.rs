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

use crate::capture_sink::{SelfWriteSuppression, StoreCaptureSink};
use dohc_engine_files::{
    CancellationToken, CaptureApplyResult, FilesActor, FilesError, FilesHandle, ManifestEntry,
    NativeWatcher, ReconcilePlan, ReconcileRun, ScanBounds, ScanGeneration, ScanManifest,
    apply_reconcile_plan,
};
use dohc_engine_runtime::{ActorHandle, NoFaults, RuntimeError};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Serializes every capture reconcile+apply with an active-version switch.
/// A switch owns this mutex from before its forced full scan until after the
/// active-version transaction, so no apply can resolve its destination on the
/// opposite side of that transaction.
pub(crate) type ApplyGate = Arc<tokio::sync::Mutex<()>>;

/// Deterministic integration-test seam for proving a switch drains an apply
/// that has already prepared a reconcile plan. Production builds do not
/// compile the seam.
#[cfg(feature = "harness")]
#[derive(Clone, Default)]
pub struct CaptureApplyProbe {
    inner: Arc<CaptureApplyProbeInner>,
}

#[cfg(feature = "harness")]
struct CaptureApplyProbeInner {
    armed: std::sync::atomic::AtomicBool,
    entered: tokio::sync::Semaphore,
    release: tokio::sync::Semaphore,
    fence_armed: std::sync::atomic::AtomicBool,
    fence_entered: tokio::sync::Semaphore,
    fence_release: tokio::sync::Semaphore,
    fence_wait_armed: std::sync::atomic::AtomicBool,
    fence_wait_entered: tokio::sync::Semaphore,
    commit_armed: std::sync::atomic::AtomicBool,
    commit_entered: tokio::sync::Semaphore,
    commit_release: tokio::sync::Semaphore,
    gate_wait_armed: std::sync::atomic::AtomicBool,
    gate_wait_entered: tokio::sync::Semaphore,
    version_scan_count: std::sync::atomic::AtomicU64,
    manifest_refresh_count: std::sync::atomic::AtomicU64,
}

#[cfg(feature = "harness")]
impl Default for CaptureApplyProbeInner {
    fn default() -> Self {
        Self {
            armed: std::sync::atomic::AtomicBool::new(false),
            entered: tokio::sync::Semaphore::new(0),
            release: tokio::sync::Semaphore::new(0),
            fence_armed: std::sync::atomic::AtomicBool::new(false),
            fence_entered: tokio::sync::Semaphore::new(0),
            fence_release: tokio::sync::Semaphore::new(0),
            fence_wait_armed: std::sync::atomic::AtomicBool::new(false),
            fence_wait_entered: tokio::sync::Semaphore::new(0),
            commit_armed: std::sync::atomic::AtomicBool::new(false),
            commit_entered: tokio::sync::Semaphore::new(0),
            commit_release: tokio::sync::Semaphore::new(0),
            gate_wait_armed: std::sync::atomic::AtomicBool::new(false),
            gate_wait_entered: tokio::sync::Semaphore::new(0),
            version_scan_count: std::sync::atomic::AtomicU64::new(0),
            manifest_refresh_count: std::sync::atomic::AtomicU64::new(0),
        }
    }
}

#[cfg(feature = "harness")]
impl CaptureApplyProbe {
    pub fn pause_next_apply(&self) {
        self.inner.armed.store(true, Ordering::Release);
    }

    pub async fn wait_until_paused(&self) {
        self.inner
            .entered
            .acquire()
            .await
            .expect("capture apply probe remains open")
            .forget();
    }

    pub fn release(&self) {
        self.inner.release.add_permits(1);
    }

    pub fn pause_next_version_fence(&self) {
        self.inner.fence_armed.store(true, Ordering::Release);
    }

    pub async fn wait_until_version_fence_paused(&self) {
        self.inner
            .fence_entered
            .acquire()
            .await
            .expect("version fence probe remains open")
            .forget();
    }

    pub fn release_version_fence(&self) {
        self.inner.fence_release.add_permits(1);
    }

    pub fn observe_next_version_fence_wait(&self) {
        self.inner.fence_wait_armed.store(true, Ordering::Release);
    }

    pub async fn wait_until_version_fence_waiting(&self) {
        self.inner
            .fence_wait_entered
            .acquire()
            .await
            .expect("capture apply probe remains open")
            .forget();
    }

    pub fn pause_next_version_commit(&self) {
        self.inner.commit_armed.store(true, Ordering::Release);
    }

    pub async fn wait_until_version_commit_paused(&self) {
        self.inner
            .commit_entered
            .acquire()
            .await
            .expect("version commit probe remains open")
            .forget();
    }

    pub fn release_version_commit(&self) {
        self.inner.commit_release.add_permits(1);
    }

    pub fn observe_next_apply_gate_wait(&self) {
        self.inner.gate_wait_armed.store(true, Ordering::Release);
    }

    pub async fn wait_until_apply_gate_waiting(&self) {
        self.inner
            .gate_wait_entered
            .acquire()
            .await
            .expect("capture apply probe remains open")
            .forget();
    }

    pub fn version_scan_count(&self) -> u64 {
        self.inner.version_scan_count.load(Ordering::Acquire)
    }

    pub fn manifest_refresh_count(&self) -> u64 {
        self.inner.manifest_refresh_count.load(Ordering::Acquire)
    }

    async fn pause_if_armed(&self) {
        if self.inner.armed.swap(false, Ordering::AcqRel) {
            self.inner.entered.add_permits(1);
            self.inner
                .release
                .acquire()
                .await
                .expect("capture apply probe remains open")
                .forget();
        }
    }

    pub(crate) async fn pause_version_fence_if_armed(&self) {
        if self.inner.fence_armed.swap(false, Ordering::AcqRel) {
            self.inner.fence_entered.add_permits(1);
            self.inner
                .fence_release
                .acquire()
                .await
                .expect("version fence probe remains open")
                .forget();
        }
    }

    pub(crate) fn observe_version_fence_wait_if_armed(&self) {
        if self.inner.fence_wait_armed.swap(false, Ordering::AcqRel) {
            self.inner.fence_wait_entered.add_permits(1);
        }
    }

    pub(crate) async fn pause_version_commit_if_armed(&self) {
        if self.inner.commit_armed.swap(false, Ordering::AcqRel) {
            self.inner.commit_entered.add_permits(1);
            self.inner
                .commit_release
                .acquire()
                .await
                .expect("version commit probe remains open")
                .forget();
        }
    }

    fn observe_gate_wait_if_armed(&self) {
        if self.inner.gate_wait_armed.swap(false, Ordering::AcqRel) {
            self.inner.gate_wait_entered.add_permits(1);
        }
    }

    pub(crate) fn record_version_scan(&self) {
        self.inner.version_scan_count.fetch_add(1, Ordering::AcqRel);
    }

    fn record_manifest_refresh(&self) {
        self.inner
            .manifest_refresh_count
            .fetch_add(1, Ordering::AcqRel);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SwitchReconcileError {
    Cancelled,
    Unavailable,
    Degraded(Vec<String>),
    ApplyFailed,
}

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
        status.record_failure_transition(is_terminal(self.consecutive_failures));
    }

    /// The layer survived a full tick with a live watch. This is the ONLY
    /// reset: clearing the streak at START time instead would let a watch that
    /// dies immediately after every start flap at the fast cadence forever —
    /// exactly the case the streak exists to bound. It is also the only exit
    /// from TERMINAL, which is what makes the slow probe a recovery path
    /// rather than a graveyard.
    fn record_healthy_tick(&mut self, status: &DriverStatus, clean: bool) {
        self.consecutive_failures = 0;
        // The healthy tick IS the proof the layer runs — running is claimed,
        // terminal cleared, and (when the tick was fully clean) degradation
        // cleared, all in ONE store. Degradation is sticky until the layer
        // demonstrably works again; a tick whose own apply failed is not that
        // demonstration.
        status.record_healthy_transition(clean);
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
            // and let the backoff govern the rebuild. The failure transition
            // is ONE store (running off, degraded on, terminal per streak),
            // so no reader can observe it half-applied.
            TickObservation::WatchLost | TickObservation::ActorLost => {
                self.record_failure(status);
                LayerAction::Drop
            }
            // The layer is kept while the failure might be transient, but the
            // tick FAILED — `running` reads false until a tick completes,
            // which is exactly what a status consumer should see for a layer
            // that exists but is making no progress. Once terminal, rebuild
            // rather than polling a wedged layer forever.
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
///
/// ONE atomic word, deliberately: with separate atomics per flag, no
/// writer-side store ordering can stop a READER from loading one flag before
/// a transition and the other after it — `running && terminal` stayed
/// observable through four rounds of store-order fixes. A single word makes
/// every read a consistent snapshot and every transition one store.
#[derive(Default)]
pub(crate) struct DriverStatus {
    bits: std::sync::atomic::AtomicU8,
}

/// The files layer (actor + watcher + loop) is up and driving.
const STATUS_RUNNING: u8 = 1 << 0;
/// The watcher reported a disruption, a reconcile or apply failed, or the
/// files layer could not (re)start. Cleared by the next FULLY CLEAN tick
/// (reconcile completed, apply clean, no fresh watcher disruption) — CURRENT
/// health, not an event log.
const STATUS_DEGRADED: u8 = 1 << 1;
/// The files layer failed [`MAX_RESTART_ATTEMPTS`] times in a row. Capture is
/// NOT running and not expected to resume on its own timescale; the slow
/// recovery probe still runs, so this is a report, not a grave.
const STATUS_TERMINAL: u8 = 1 << 2;
/// An apply observed an UNREADABLE policy (held ops). Folded into the drive
/// loop's unknown-fingerprint tracking so the policy-recovery rebuild fires
/// even when the blip was visible only inside the apply window.
const STATUS_POLICY_HOLD: u8 = 1 << 3;

/// A consistent point-in-time view of the driver, decoded from ONE atomic
/// load. Any consumer that needs MORE THAN ONE flag must go through this —
/// composing the per-flag getters performs separate loads, and a reader
/// interleaving with a transition could still assemble the contradictory
/// running && terminal tuple the single-word representation exists to kill.
#[derive(Debug, Clone, Copy)]
pub(crate) struct StatusSnapshot {
    pub(crate) running: bool,
    pub(crate) degraded: bool,
    pub(crate) terminal: bool,
}

impl DriverStatus {
    /// ONE load; all flags decoded from the same word.
    pub(crate) fn snapshot(&self) -> StatusSnapshot {
        let bits = self.bits.load(Ordering::Acquire);
        StatusSnapshot {
            running: bits & STATUS_RUNNING != 0,
            degraded: bits & STATUS_DEGRADED != 0,
            terminal: bits & STATUS_TERMINAL != 0,
        }
    }

    fn update(&self, transition: impl Fn(u8) -> u8) {
        // fetch_update never fails with a total closure; the Result is noise.
        let _ = self
            .bits
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |bits| {
                Some(transition(bits))
            });
    }
    // SINGLE-flag conveniences. Correct on their own (one flag cannot
    // self-contradict); combinations MUST use [`DriverStatus::snapshot`] —
    // which is why production consumers (the RPC handler, flush answers)
    // use the snapshot and these are test-only.
    #[cfg_attr(not(test), expect(dead_code))]
    pub(crate) fn running(&self) -> bool {
        self.snapshot().running
    }
    pub(crate) fn degraded(&self) -> bool {
        self.snapshot().degraded
    }
    #[cfg_attr(not(test), expect(dead_code))]
    pub(crate) fn terminal(&self) -> bool {
        self.snapshot().terminal
    }
    fn set_running(&self, running: bool) {
        self.update(|bits| {
            if running {
                bits | STATUS_RUNNING
            } else {
                bits & !STATUS_RUNNING
            }
        });
    }
    fn mark_degraded(&self) {
        self.update(|bits| bits | STATUS_DEGRADED);
    }
    /// A failure: not running, degraded, terminal iff the streak says so —
    /// ONE store, so no reader can see a half-applied transition.
    fn record_failure_transition(&self, terminal: bool) {
        self.update(|bits| {
            let bits = (bits & !STATUS_RUNNING) | STATUS_DEGRADED;
            if terminal {
                bits | STATUS_TERMINAL
            } else {
                bits & !STATUS_TERMINAL
            }
        });
    }
    /// A healthy tick: running, not terminal, and clean clears degradation —
    /// ONE store.
    fn record_healthy_transition(&self, clean: bool) {
        self.update(|bits| {
            let bits = (bits | STATUS_RUNNING) & !STATUS_TERMINAL;
            if clean { bits & !STATUS_DEGRADED } else { bits }
        });
    }
    fn arm_policy_hold(&self) {
        self.update(|bits| bits | STATUS_POLICY_HOLD);
    }
    /// Consume the hold (test-and-clear in one atomic op).
    fn take_policy_hold(&self) -> bool {
        self.bits.fetch_and(!STATUS_POLICY_HOLD, Ordering::AcqRel) & STATUS_POLICY_HOLD != 0
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
        status.mark_degraded();
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
        /// Nothing dirty: the reconcile round-trips CONVERGED.
        Idle,
        /// The reconcile is CANCELLED mid-scan (teardown racing the tick).
        CancelledTick,
        HealthyButDirtyApply,
        /// A healthy tick during which the watcher records ONE more
        /// disruption (backend error / root-identity blip that re-attached).
        Disrupted,
        /// The root's policy fingerprint differs from the layer's.
        PolicyChanged,
        /// The fingerprint differs AND the tick converges — the exact pass
        /// where a flush could settle over a mid-debounce policy edit.
        PolicyChangedIdle,
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
                Script::PolicyChanged | Script::PolicyChangedIdle => Some(self.policy + 1),
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
                let snapshot = self.status.snapshot();
                journal.degraded_seen.push(snapshot.degraded);
                journal.running_seen.push(snapshot.running);
            }
            let script = self.current();
            self.step += 1;
            match script {
                Script::ActorLost => TickIo::ActorLost,
                Script::ReconcileFails => TickIo::Failed,
                Script::HealthyButDirtyApply => {
                    self.status.mark_degraded();
                    TickIo::Applied { clean: false }
                }
                Script::PolicyUnreadable => {
                    // Fidelity: while the policy is unknown the SINK holds
                    // its ops (POLICY_UNAVAILABLE), so the apply reports
                    // failures — the tick is degraded, not clean.
                    self.status.mark_degraded();
                    TickIo::Applied { clean: false }
                }
                Script::Disrupted => {
                    // The disruption lands DURING this tick's window; the
                    // watcher's counter reflects it at the next check.
                    self.emitted += 1;
                    TickIo::Applied { clean: true }
                }
                Script::Idle | Script::PolicyChangedIdle => TickIo::Converged,
                Script::CancelledTick => TickIo::Cancelled,
                _ => TickIo::Applied { clean: true },
            }
        }

        async fn stop_layer(&mut self, _layer: FakeLayer) {
            self.journal.lock().expect("journal").stops += 1;
            self.step += 1;
        }
    }

    type FlushSender = tokio::sync::mpsc::Sender<tokio::sync::oneshot::Sender<FlushOutcome>>;

    /// Spawn the loop under paused time; the caller drives, flushes, then
    /// finishes to collect the journal.
    fn spawn_loop(
        script: Vec<Script>,
    ) -> (
        tokio::task::JoinHandle<()>,
        CancellationToken,
        Arc<Mutex<Journal>>,
        Arc<DriverStatus>,
        FlushSender,
    ) {
        let journal = Arc::new(Mutex::new(Journal::default()));
        let status = Arc::new(DriverStatus::default());
        let cancel = CancellationToken::new();
        let (baseline_tx, _baseline_rx) = tokio::sync::watch::channel(false);
        let (flush_tx, flush_rx) = tokio::sync::mpsc::channel(8);
        let mut env = FakeEnv::new(script, Arc::clone(&journal), Arc::clone(&status));
        let loop_status = Arc::clone(&status);
        let loop_cancel = cancel.clone();
        let handle = tokio::spawn(async move {
            drive_loop(&mut env, loop_cancel, loop_status, baseline_tx, flush_rx).await
        });
        (handle, cancel, journal, status, flush_tx)
    }

    /// Run the loop under paused time for `budget` of virtual time.
    async fn drive_for(
        script: Vec<Script>,
        budget: std::time::Duration,
    ) -> (Journal, Arc<DriverStatus>) {
        let (handle, cancel, journal, status, _flush_tx) = spawn_loop(script);
        tokio::time::sleep(budget).await;
        cancel.cancel();
        handle.await.expect("driver loop");

        let journal = Arc::try_unwrap(journal)
            .map(|m| m.into_inner().expect("journal"))
            .unwrap_or_else(|_| panic!("journal still shared"));
        (journal, status)
    }

    /// Send one flush after `lead` of virtual time and return its outcome
    /// plus how much virtual time the answer took.
    async fn flush_after(
        script: Vec<Script>,
        lead: std::time::Duration,
    ) -> (FlushOutcome, std::time::Duration) {
        let (handle, cancel, _journal, _status, flush_tx) = spawn_loop(script);
        tokio::time::sleep(lead).await;
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        flush_tx.send(reply_tx).await.expect("flush queued");
        let asked = tokio::time::Instant::now();
        let outcome = reply_rx.await.expect("flush answered");
        let waited = tokio::time::Instant::now().duration_since(asked);
        cancel.cancel();
        handle.await.expect("driver loop");
        (outcome, waited)
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
        let snapshot = status.snapshot();
        assert!(
            snapshot.terminal,
            "a permanently dead actor is reported terminal"
        );
        assert!(!snapshot.running, "terminal must never claim running");
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
    async fn a_flush_racing_teardown_never_claims_settled() {
        // A cancelled reconcile COMMITS NOTHING (dirty stays put), so a
        // flush answered off one must say settled:false — reading the
        // cancelled scan as quiescence would hand the differential a
        // half-captured workspace as "clean".
        let (outcome, waited) = flush_after(
            vec![Script::CancelledTick],
            std::time::Duration::from_secs(2),
        )
        .await;
        assert!(
            !outcome.settled,
            "a teardown-raced flush must never claim quiescence"
        );
        assert!(
            waited < std::time::Duration::from_secs(1),
            "and it answers promptly, waited {waited:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_is_not_delayed_by_a_terminal_backoff() {
        // The slow probe must never hold up workspace close.
        let (handle, cancel, _journal, _status, _flush_tx) = spawn_loop(vec![Script::StartFails]);
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

    #[tokio::test(start_paused = true)]
    async fn a_flush_on_a_quiescent_layer_settles() {
        let (outcome, _) = flush_after(vec![Script::Idle], std::time::Duration::from_secs(2)).await;
        assert!(outcome.settled, "an idle layer is already at quiescence");
        assert!(outcome.running);
        assert!(!outcome.degraded);
    }

    #[tokio::test(start_paused = true)]
    async fn a_flush_during_a_backoff_answers_promptly_and_honestly() {
        // The caller must not sit out the escalating backoff (up to the 30s
        // terminal probe) — that is indistinguishable from a hang. It gets an
        // immediate honest "not settled, not running".
        let (outcome, waited) = flush_after(
            vec![Script::StartFails],
            std::time::Duration::from_millis(5300),
        )
        .await;
        assert!(!outcome.settled);
        assert!(!outcome.running);
        assert!(
            waited < std::time::Duration::from_secs(1),
            "flush must skip the remaining backoff sleep, waited {waited:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_flush_does_not_settle_over_a_pending_policy_rebuild() {
        // Pass 1 sees a NEW policy fingerprint for the first time (debounce
        // arms) and the tick converges — without the guard, the flush would
        // certify deterministic ownership state the very pass before the
        // rebuild/re-offer runs. It must answer settled:false until the
        // debounce confirms and the rebuild completes.
        // Pass 1 (Idle) builds the layer under the ORIGINAL policy — the
        // edit lands after the build, as it does in life (a build adopts
        // the fingerprint it reads, so a pre-build change never debounces).
        let (handle, cancel, journal, _status, flush_tx) =
            spawn_loop(vec![Script::Idle, Script::PolicyChangedIdle]);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let mut settled = Vec::new();
        for pass in 0..3 {
            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
            flush_tx.send(reply_tx).await.expect("flush queued");
            let outcome = tokio::time::timeout(std::time::Duration::from_secs(2), reply_rx)
                .await
                .expect("flush answered")
                .expect("flush channel");
            settled.push(outcome.settled);
            // Flush 2 fires IMMEDIATELY so it drives the confirm/rebuild
            // pass itself (a sleep would let the loop's own cadence finish
            // the rebuild first and the middle answer would race to true).
            if pass != 0 {
                tokio::time::sleep(std::time::Duration::from_millis(600)).await;
            }
        }
        cancel.cancel();
        handle.await.expect("driver loop");

        assert_eq!(
            settled,
            vec![false, false, true],
            "flush must stay unsettled while the policy edit is mid-debounce \
             (pass 1) and during the rebuild pass (pass 2), then settle on \
             the rebuilt layer"
        );
        let starts = journal.lock().expect("journal").starts.len();
        assert_eq!(starts, 2, "exactly the initial build plus ONE rebuild");
    }

    #[tokio::test(start_paused = true)]
    async fn flush_polling_does_not_defeat_the_restart_backoff() {
        // A client polling capture.flush must neither drive start attempts
        // at its poll rate (each early pass would rebuild hot) NOR push the
        // scheduled rebuild out by resetting the wait (the deadline is an
        // Instant that flush interruptions leave standing). Both mutations
        // are killed by the start-count window below: poll-rate rebuilds
        // overshoot it, a reset-on-poll deadline starves it to one start.
        let (handle, cancel, journal, _status, flush_tx) = spawn_loop(vec![Script::StartFails]);
        // First pass fails immediately; a backoff is armed.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        // Poll every 100ms for 4s of virtual time — far faster than the
        // 500ms -> 8s backoff schedule.
        for _ in 0..40 {
            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
            flush_tx.send(reply_tx).await.expect("flush queued");
            let outcome = tokio::time::timeout(std::time::Duration::from_millis(100), reply_rx)
                .await
                .expect("a mid-backoff flush answers promptly")
                .expect("flush answered");
            assert!(!outcome.settled, "a down layer must never settle a flush");
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        cancel.cancel();
        handle.await.expect("driver loop");
        let starts = journal.lock().expect("journal").starts.len();
        assert!(
            (3..=5).contains(&starts),
            "4s of failing starts under the backoff schedule means 3-5 \
             attempts; saw {starts} (more = flush polling defeats the \
             backoff, fewer = polling starves the rebuild)"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_flush_that_never_converges_is_bounded() {
        // A workspace under continuous mutation never reaches quiescence;
        // flush must return an honest not-settled rather than spin forever.
        let (outcome, waited) = flush_after(
            vec![Script::HealthyButDirtyApply],
            std::time::Duration::from_secs(2),
        )
        .await;
        assert!(!outcome.settled, "an unconverged flush must say so");
        assert!(outcome.degraded, "the failing applies stay visible");
        assert!(
            waited < std::time::Duration::from_secs(1),
            "the cycle bound answers without further sleeps, waited {waited:?}"
        );
    }
}

/// The daemon-side handle to one workspace's capture driver.
pub(crate) struct CaptureDriver {
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
    status: Arc<DriverStatus>,
    author_json: Arc<Mutex<Option<String>>>,
    /// Bounded: a caller flood means capture is already busy doing exactly
    /// what flush asks for; excess callers wait for a slot.
    flush_tx: tokio::sync::mpsc::Sender<tokio::sync::oneshot::Sender<FlushOutcome>>,
    /// Resolves once the STARTUP baseline reconcile has been applied (or the
    /// initial layer start failed) — `workspace.open` awaits this so a
    /// caller's first RPC write can never be overwritten by a later capture
    /// of stale closed-period disk bytes.
    baseline: tokio::sync::watch::Receiver<bool>,
    /// Invalidates the live files layer after an out-of-band forced reconcile.
    /// The epoch is sampled into each layer; a mismatch makes the old layer
    /// restart before it may apply again.
    refresh_epoch: Arc<std::sync::atomic::AtomicU64>,
    #[cfg(feature = "harness")]
    apply_probe: Option<CaptureApplyProbe>,
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
    pub(crate) fn spawn(
        root: PathBuf,
        actor: ActorHandle,
        workspace_id: String,
        self_writes: SelfWriteSuppression,
        apply_gate: ApplyGate,
        initial_author_json: Option<String>,
        #[cfg(feature = "harness")] apply_probe: Option<CaptureApplyProbe>,
    ) -> CaptureDriver {
        let cancel = CancellationToken::new();
        let status = Arc::new(DriverStatus::default());
        let author_json = Arc::new(Mutex::new(initial_author_json));
        let (baseline_tx, baseline) = tokio::sync::watch::channel(false);
        let (flush_tx, flush_rx) = tokio::sync::mpsc::channel(8);
        let refresh_epoch = Arc::new(std::sync::atomic::AtomicU64::new(0));
        #[cfg(feature = "harness")]
        let driver_probe = apply_probe.clone();
        let task = tokio::spawn(drive(
            root,
            actor,
            workspace_id,
            self_writes,
            cancel.clone(),
            Arc::clone(&status),
            Arc::clone(&author_json),
            baseline_tx,
            flush_rx,
            apply_gate,
            Arc::clone(&refresh_epoch),
            #[cfg(feature = "harness")]
            apply_probe,
        ));
        CaptureDriver {
            cancel,
            task: Some(task),
            status,
            author_json,
            flush_tx,
            baseline,
            refresh_epoch,
            #[cfg(feature = "harness")]
            apply_probe: driver_probe,
        }
    }

    /// A clonable handle for `capture.flush`: the RPC layer clones it out of
    /// the handle lock and awaits OUTSIDE, so a long flush never blocks the
    /// daemon's workspace table.
    pub(crate) fn flush_sender(
        &self,
    ) -> tokio::sync::mpsc::Sender<tokio::sync::oneshot::Sender<FlushOutcome>> {
        self.flush_tx.clone()
    }

    pub(crate) fn set_author_json(&self, author_json: Option<String>) {
        *self
            .author_json
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = author_json;
    }

    pub(crate) fn author_json(&self) -> Option<String> {
        self.author_json
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
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

    pub(crate) fn status(&self) -> &Arc<DriverStatus> {
        &self.status
    }

    /// Force the live driver to discard its manifest and rehydrate from the
    /// domain before its next apply. Called while the workspace apply gate is
    /// held, so the epoch change is ordered before that next apply.
    pub(crate) fn request_manifest_refresh(&self) {
        self.refresh_epoch.fetch_add(1, Ordering::AcqRel);
        #[cfg(feature = "harness")]
        if let Some(probe) = &self.apply_probe {
            probe.record_manifest_refresh();
        }
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
    refresh_epoch: u64,
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
        refresh_epoch: u64,
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
                    refresh_epoch,
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
) -> Result<Option<(ScanManifest, ScanGeneration)>, RuntimeError> {
    let version_id = match actor.active_version_id(workspace_id.to_owned()).await {
        Ok(version_id) => version_id,
        Err(RuntimeError::Domain(dohc_engine_domain::DomainError::WorkspaceNotFound)) => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let entries = actor
        .capture_manifest_seed(workspace_id.to_owned(), version_id)
        .await?;
    if entries.is_empty() {
        return Ok(None);
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
    Ok(Some((manifest, ScanGeneration(1))))
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
    /// An out-of-band reconcile invalidated this layer's manifest.
    fn refresh_due(&self, _layer: &Self::Layer) -> bool {
        false
    }

    /// Build a fresh layer and drive its startup baseline to settle.
    async fn start_layer(&mut self, cancel: &CancellationToken) -> Result<Self::Layer, ()>;
    /// One reconcile + apply.
    async fn tick(&mut self, layer: &Self::Layer, cancel: &CancellationToken) -> TickIo;
    async fn stop_layer(&mut self, layer: Self::Layer);
}

/// What one reconcile+apply did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TickIo {
    /// Nothing was dirty: the layer is at QUIESCENCE. This is what a flush
    /// caller is waiting for — distinct from `Applied`, which may leave more
    /// work pending (an apply's own side effects, a change that landed
    /// mid-scan).
    Converged,
    /// The reconcile was CANCELLED mid-scan (teardown): nothing committed,
    /// dirty stays put. Deliberately distinct from `Converged` — a flush
    /// racing teardown must answer `settled: false`, never read a cancelled
    /// scan as quiescence.
    Cancelled,
    /// The layer was invalidated while this tick waited on the apply gate.
    RefreshRequired,
    /// Reconciled and applied one plan; `clean` is false when the apply
    /// reported failures or the scan itself was degraded.
    Applied { clean: bool },
    /// The files actor died under us.
    ActorLost,
    /// The reconcile failed while the layer stayed up.
    Failed,
}

/// How many reconcile cycles one `capture.flush` may drive before giving up
/// on quiescence. A workspace under CONTINUOUS external writes never
/// converges; flush must return an honest `settled: false` rather than spin.
const MAX_FLUSH_CYCLES: u32 = 32;

/// What one `capture.flush` could actually promise.
#[derive(Debug, Clone, Copy)]
pub(crate) struct FlushOutcome {
    /// The reconcile loop reached CONVERGED: every change visible on disk at
    /// entry has been captured and acknowledged. False means the cycle bound
    /// was hit, the layer is down, or teardown raced the flush.
    pub(crate) settled: bool,
    /// The files layer was up when the flush was answered.
    pub(crate) running: bool,
    /// Same meaning as [`DriverStatus::degraded`].
    pub(crate) degraded: bool,
}

/// Decide whether a policy edit should rebuild the layer THIS tick.
///
/// A policy rebuild is expensive (fresh actor, fresh watcher, full baseline
/// rescan), so a new fingerprint must HOLD for one tick before it triggers
/// one. Without the debounce, anything rewriting `files.toml` faster than the
/// drive interval — an agent syncing config, an editor autosaving — drives a
/// full rescan every tick forever, and a transient read error (which hashes
/// differently from any successful read) flaps the rebuild indefinitely.
fn policy_rebuild_due(
    fingerprint: Option<u64>,
    layer_fingerprint: Option<u64>,
    pending: &mut Option<u64>,
) -> bool {
    // Takes the tick's ONE fingerprint sample — re-reading here let a fast
    // policy toggle differ between the two reads and confirm a pending value
    // that never actually held across ticks.
    //
    // Unknown (unreadable policy) HOLDS the debounce in place: it neither
    // confirms nor cancels a pending edit. Treating the error as a distinct
    // hash instead made an intermittently-locked file alternate
    // real/error/real — the same value never held two consecutive ticks, and
    // a genuine edit was ignored forever.
    let Some(current) = fingerprint else {
        return false;
    };
    if Some(current) == layer_fingerprint {
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
    mut flush_rx: tokio::sync::mpsc::Receiver<tokio::sync::oneshot::Sender<FlushOutcome>>,
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
    // A flush caller waiting on THIS pass; answered exactly once per pass.
    let mut pending_flush: Option<tokio::sync::oneshot::Sender<FlushOutcome>> = None;
    let mut flush_closed = false;
    // The pass deadline is an INSTANT, not a fresh sleep: a flush that
    // interrupts the wait must not reset the remaining backoff, or client
    // flush-polling would push a pending rebuild out forever.
    let mut next_pass_at = tokio::time::Instant::now();

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
                // A flush SKIPS the remaining wait: the caller is blocked on
                // this pass, and making it sit out a backoff (up to the 30s
                // terminal probe) is indistinguishable from a hang. The
                // `flush_closed` guard stops a closed channel from turning
                // this select into a hot loop.
                request = flush_rx.recv(), if !flush_closed => {
                    match request {
                        Some(reply) => pending_flush = Some(reply),
                        None => flush_closed = true,
                    }
                }
                () = tokio::time::sleep_until(next_pass_at) => {}
            }
        }
        first_pass = false;
        // A flush may cut the wait short ONLY outside a failure streak (a
        // healthy tick is cheap and the caller is blocked). Mid-streak, an
        // early pass would let flush-polling drive rebuild/retry at the
        // client's poll rate — answer honestly (nothing ticked: settled
        // stays false) and leave the deadline standing; the rebuild still
        // happens exactly on its backoff schedule.
        if pending_flush.is_some()
            && restart.failures() > 0
            && tokio::time::Instant::now() < next_pass_at
        {
            answer_flush(&mut pending_flush, &status, false);
            continue;
        }
        // Answered on every exit from this pass; set true only by a tick
        // sequence that reached CONVERGED.
        let mut flush_settled = false;

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
                        status.set_running(true);
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
                    // MAX_RESTART_ATTEMPTS consecutive failures. The failure
                    // transition is one store; no manual pre-ordering needed.
                    restart.record_failure(&status);
                }
            }
            // Whether the baseline applied or the start failed, the open
            // barrier releases: the workspace opens (possibly degraded), and
            // callers' first writes are ordered AFTER the startup capture.
            let _ = baseline_tx.send(true);
        }

        let Some(current) = layer.as_ref() else {
            // No layer to drive: answer honestly rather than holding the
            // caller across a rebuild that may be a terminal probe away.
            answer_flush(&mut pending_flush, &status, false);
            next_pass_at = tokio::time::Instant::now() + restart.delay();
            continue;
        };

        // Classify the tick, then let the tracker decide. Routing EVERY
        // outcome through one decision point is what keeps a failure mode
        // from quietly escaping the backoff.
        let fingerprint = env.policy_fingerprint();
        // The apply path can observe an unreadable policy the loop's own read
        // never sees; it arms `policy_hold`, folded in here so recovery fires
        // for that window too.
        let policy_was_held = status.take_policy_hold();
        let policy_recovered = fingerprint.is_some() && (policy_was_unknown || policy_was_held);
        // An unknown fingerprint carries the state forward by itself; a
        // consumed hold under a still-unknown fingerprint needs no re-arm.
        policy_was_unknown = fingerprint.is_none();
        let observation = if env.refresh_due(current) {
            TickObservation::PolicyChanged
        } else if env.watch_lost(current) {
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
        } else if policy_rebuild_due(
            fingerprint,
            env.layer_fingerprint(current),
            &mut pending_policy,
        ) {
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
                status.mark_degraded();
            }
            // A flush drives to QUIESCENCE, not one cycle: a single
            // reconcile can leave the layer dirty again (an apply's own side
            // effects, a change landing mid-scan), and a differential harness
            // resumed there would compare a half-captured workspace.
            let cycles = if pending_flush.is_some() {
                MAX_FLUSH_CYCLES
            } else {
                1
            };
            let mut all_clean = true;
            let mut outcome = None;
            for _ in 0..cycles {
                match env.tick(current, &cancel).await {
                    TickIo::Converged => {
                        // Quiescence is real for CONTENT — but a policy edit
                        // whose new fingerprint was FIRST seen this pass is
                        // mid-debounce, and ownership may be about to
                        // change. A flush must not certify deterministic
                        // state over it: settled stays false, the caller
                        // polls, and the next pass confirms + rebuilds.
                        flush_settled = pending_policy.is_none();
                        outcome = Some(TickObservation::Healthy {
                            clean: all_clean && !fresh_disruption,
                        });
                        break;
                    }
                    TickIo::Cancelled => {
                        // Teardown raced this pass: nothing settled, and the
                        // next loop iteration exits on the cancel token. No
                        // supervision observation either — a cancelled tick
                        // proves nothing about the layer's health.
                        break;
                    }
                    TickIo::RefreshRequired => {
                        outcome = Some(TickObservation::PolicyChanged);
                        break;
                    }
                    TickIo::Applied { clean } => {
                        all_clean &= clean;
                        outcome = Some(TickObservation::Healthy {
                            clean: all_clean && !fresh_disruption,
                        });
                    }
                    TickIo::ActorLost => {
                        outcome = Some(TickObservation::ActorLost);
                        break;
                    }
                    TickIo::Failed => {
                        outcome = Some(TickObservation::ReconcileFailed);
                        break;
                    }
                }
                if cancel.is_cancelled() {
                    break;
                }
            }
            match outcome {
                Some(observation) => observation,
                // Every tick this pass was cancelled: answer the flush
                // honestly (settled stays false) and let the next iteration
                // exit on the cancel token — no health claim either way.
                None => {
                    answer_flush(&mut pending_flush, &status, false);
                    next_pass_at = tokio::time::Instant::now() + restart.delay();
                    continue;
                }
            }
        };

        if restart.observe(observation, &status) == LayerAction::Drop {
            // `running` goes false BEFORE the teardown await: stop_layer
            // joins the watcher thread and closes the files actor, and a
            // status reader sampling mid-join must not see running while a
            // terminal streak is being reported.
            status.set_running(false);
            if let Some(dead) = layer.take() {
                env.stop_layer(dead).await;
            }
        }
        answer_flush(&mut pending_flush, &status, flush_settled);
        next_pass_at = tokio::time::Instant::now() + restart.delay();
    }

    // BEFORE the joins, same as the Drop path: stop_layer drains threads,
    // and a status reader mid-join must not see a closing driver as running.
    status.set_running(false);
    if let Some(current) = layer.take() {
        env.stop_layer(current).await;
    }
    // A caller blocked on flush across teardown gets an answer, not a
    // dropped channel to interpret.
    answer_flush(&mut pending_flush, &status, false);
    flush_rx.close();
    while let Ok(reply) = flush_rx.try_recv() {
        let _ = reply.send(FlushOutcome {
            settled: false,
            running: false,
            degraded: status.degraded(),
        });
    }
}

/// Answer a pending flush, if one is waiting. Takes the sender, so a pass
/// answers at most once.
fn answer_flush(
    pending: &mut Option<tokio::sync::oneshot::Sender<FlushOutcome>>,
    status: &DriverStatus,
    settled: bool,
) {
    if let Some(reply) = pending.take() {
        // ONE snapshot: running and degraded must come from the same load.
        let snapshot = status.snapshot();
        let _ = reply.send(FlushOutcome {
            settled,
            running: snapshot.running,
            degraded: snapshot.degraded,
        });
    }
}

/// The real filesystem-backed environment.
struct RealEnv {
    root: PathBuf,
    actor: ActorHandle,
    workspace_id: String,
    status: Arc<DriverStatus>,
    author_json: Arc<Mutex<Option<String>>>,
    self_writes: SelfWriteSuppression,
    apply_gate: ApplyGate,
    refresh_epoch: Arc<std::sync::atomic::AtomicU64>,
    #[cfg(feature = "harness")]
    apply_probe: Option<CaptureApplyProbe>,
}

impl RealEnv {
    fn capture_author(&self) -> Option<String> {
        self.author_json
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn apply_context(&self) -> ApplyRunContext<'_> {
        ApplyRunContext {
            root: &self.root,
            actor: &self.actor,
            workspace_id: &self.workspace_id,
            status: &self.status,
            self_writes: &self.self_writes,
            author_json: self.capture_author(),
        }
    }
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
    fn refresh_due(&self, layer: &FilesLayer) -> bool {
        layer.refresh_epoch != self.refresh_epoch.load(Ordering::Acquire)
    }

    async fn start_layer(&mut self, cancel: &CancellationToken) -> Result<FilesLayer, ()> {
        let _apply_guard = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(()),
            guard = self.apply_gate.lock() => guard,
        };
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
        let seed = manifest_seed(&self.root, &self.actor, &self.workspace_id)
            .await
            .ok()
            .flatten();
        let refresh_epoch = self.refresh_epoch.load(Ordering::Acquire);
        let (fresh, initial) = FilesLayer::start_with_fingerprint(
            &self.root,
            cancel,
            seed,
            fingerprint_before_seed,
            refresh_epoch,
        )
        .await
        .map_err(|_| ())?;

        let mut settled = apply_run(self.apply_context(), &fresh, initial).await;
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
                Ok(run) => apply_run(self.apply_context(), &fresh, run).await,
                Err(_) => false,
            };
        }
        Ok(fresh)
    }

    async fn tick(&mut self, layer: &FilesLayer, cancel: &CancellationToken) -> TickIo {
        #[cfg(feature = "harness")]
        if let Some(probe) = &self.apply_probe {
            probe.observe_gate_wait_if_armed();
        }
        let _apply_guard = tokio::select! {
            biased;
            () = cancel.cancelled() => return TickIo::Cancelled,
            guard = self.apply_gate.lock() => guard,
        };
        if self.refresh_due(layer) {
            return TickIo::RefreshRequired;
        }
        let run = layer
            .files
            .handle()
            .reconcile_if_dirty(cancel.child_token())
            .await;
        #[cfg(feature = "harness")]
        if matches!(run, Ok(ReconcileRun::Completed(_)))
            && let Some(probe) = &self.apply_probe
        {
            probe.pause_if_armed().await;
        }
        match run {
            // Converged means at quiescence — EXCEPT with a NON-EMPTY
            // quarantine: the controller
            // parks persistently failing paths on its own degraded-rescan
            // backoff and stops self-forcing scans, so "nothing dirty"
            // coexists with "capture has not recovered" — reading that as
            // clean would clear `degraded` over live failures, and would let
            // a flush claim `settled` over them.
            // Cancelled commits nothing (dirty stays put): teardown is
            // racing this tick, and it must not be mistaken for quiescence.
            Ok(ReconcileRun::Cancelled) => TickIo::Cancelled,
            Ok(ReconcileRun::Converged) => {
                if self.status.degraded() {
                    match layer.files.handle().stats().await {
                        Ok(stats) if stats.quarantined > 0 => TickIo::Applied { clean: false },
                        Ok(_) => TickIo::Converged,
                        // Same as the Applied arm: a dead actor is reported
                        // as itself, not laundered into an unclean-but-
                        // healthy tick that resets the backoff.
                        Err(_) => TickIo::ActorLost,
                    }
                } else {
                    TickIo::Converged
                }
            }
            Ok(run) => {
                let clean = apply_run(self.apply_context(), layer, run).await;
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

#[allow(clippy::too_many_arguments)]
async fn drive(
    root: PathBuf,
    actor: ActorHandle,
    workspace_id: String,
    self_writes: SelfWriteSuppression,
    cancel: CancellationToken,
    status: Arc<DriverStatus>,
    author_json: Arc<Mutex<Option<String>>>,
    baseline_tx: tokio::sync::watch::Sender<bool>,
    flush_rx: tokio::sync::mpsc::Receiver<tokio::sync::oneshot::Sender<FlushOutcome>>,
    apply_gate: ApplyGate,
    refresh_epoch: Arc<std::sync::atomic::AtomicU64>,
    #[cfg(feature = "harness")] apply_probe: Option<CaptureApplyProbe>,
) {
    let mut env = RealEnv {
        root,
        actor,
        workspace_id,
        status: Arc::clone(&status),
        author_json,
        self_writes,
        apply_gate,
        refresh_epoch,
        #[cfg(feature = "harness")]
        apply_probe,
    };
    drive_loop(&mut env, cancel, status, baseline_tx, flush_rx).await;
}

/// Force the oracle-equivalent pre-switch full scan while the caller owns the
/// workspace's [`ApplyGate`]. A fresh files actor is seeded from the active
/// version so deletions are visible, but no watcher is attached: the normal
/// driver remains alive and simply waits at the gate. Degraded listings fail
/// before any safe-subset apply, matching the TypeScript switch path.
pub(crate) async fn reconcile_full_for_switch(
    root: &Path,
    actor: &ActorHandle,
    workspace_id: &str,
    status: &Arc<DriverStatus>,
    self_writes: &SelfWriteSuppression,
    author_json: Option<String>,
    token: CancellationToken,
) -> Result<bool, SwitchReconcileError> {
    if token.is_cancelled() {
        return Err(SwitchReconcileError::Cancelled);
    }
    let seed = manifest_seed(root, actor, workspace_id)
        .await
        .map_err(|_| SwitchReconcileError::Unavailable)?;
    let files =
        FilesActor::spawn_async_with_manifest(root.to_path_buf(), ScanBounds::default(), seed)
            .await
            .map_err(|_| SwitchReconcileError::Unavailable)?;
    let files = FilesActorCloseGuard::new(files);
    let handle = files.handle();
    let run = handle
        .reconcile(token.clone())
        .await
        .map_err(|_| SwitchReconcileError::Unavailable);
    let result = match run {
        Err(error) => Err(error),
        Ok(ReconcileRun::Cancelled) => Err(SwitchReconcileError::Cancelled),
        // `reconcile` is unconditional; only `reconcile_if_dirty` can report
        // Converged. Treat an impossible future contract drift as unavailable
        // rather than silently skipping the mandatory scan.
        Ok(ReconcileRun::Converged) => Err(SwitchReconcileError::Unavailable),
        Ok(ReconcileRun::Completed(plan)) if plan.degraded => {
            status.mark_degraded();
            let mut degraded_paths = plan.degraded_paths;
            degraded_paths.sort();
            degraded_paths.dedup();
            degraded_paths.truncate(8);
            Err(SwitchReconcileError::Degraded(degraded_paths))
        }
        Ok(run) => {
            let manifest_changed = matches!(
                &run,
                ReconcileRun::Completed(plan)
                    if !plan.ops.is_empty() || !plan.retained_over_cap.is_empty()
            );
            let context = ApplyRunContext {
                root,
                actor,
                workspace_id,
                status,
                self_writes,
                author_json,
            };
            if apply_run_with_handle(context, &handle, run).await {
                Ok(manifest_changed)
            } else {
                Err(SwitchReconcileError::ApplyFailed)
            }
        }
    };
    files.close().await;
    result
}

/// Cancellation-safe owner for a temporary [`FilesActor`].
///
/// Its `Drop` path must never run `FilesActor::drop` on a Tokio worker because
/// that synchronously joins the actor thread. Ownership is first wrapped in
/// `ManuallyDrop`, then handed to a dedicated plain thread. If thread creation
/// itself fails, the actor is intentionally leaked rather than blocking the
/// runtime during cancellation.
struct FilesActorCloseGuard {
    actor: Option<FilesActor>,
}

impl FilesActorCloseGuard {
    fn new(actor: FilesActor) -> Self {
        Self { actor: Some(actor) }
    }

    fn handle(&self) -> FilesHandle {
        self.actor
            .as_ref()
            .expect("files actor is present")
            .handle()
    }

    fn hand_off_close(&mut self) -> Option<std::thread::JoinHandle<()>> {
        let actor = std::mem::ManuallyDrop::new(self.actor.take()?);
        std::thread::Builder::new()
            .name("dohc-switch-files-close".to_owned())
            .spawn(move || {
                let mut actor = std::mem::ManuallyDrop::into_inner(actor);
                let _ = actor.close();
            })
            .ok()
    }

    async fn close(mut self) {
        if let Some(joiner) = self.hand_off_close() {
            let _ = tokio::task::spawn_blocking(move || joiner.join()).await;
        }
    }
}

impl Drop for FilesActorCloseGuard {
    fn drop(&mut self) {
        let _ = self.hand_off_close();
    }
}

struct ApplyRunContext<'a> {
    root: &'a Path,
    actor: &'a ActorHandle,
    workspace_id: &'a str,
    status: &'a Arc<DriverStatus>,
    self_writes: &'a SelfWriteSuppression,
    author_json: Option<String>,
}

/// Apply one reconcile run through the capture sink and acknowledge it.
///
/// INVARIANT: a prepared plan is ALWAYS acknowledged — the controller's
/// `outstanding` latch only resets on ack, so an early return that skipped it
/// would wedge every future reconcile into `StaleReconcilePlan` forever. On
/// abnormal paths (version fetch failure, apply-thread spawn failure or
/// panic) the plan is acked with an ALL-FAILED receipt: the latch clears,
/// the paths stay dirty, and the next cycle retries.
async fn apply_run(context: ApplyRunContext<'_>, layer: &FilesLayer, run: ReconcileRun) -> bool {
    apply_run_with_handle(context, &layer.files.handle(), run).await
}

async fn apply_run_with_handle(
    context: ApplyRunContext<'_>,
    files: &FilesHandle,
    run: ReconcileRun,
) -> bool {
    let ApplyRunContext {
        root,
        actor,
        workspace_id,
        status,
        self_writes,
        author_json,
    } = context;
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
            status.mark_degraded();
            ack_all_failed(files, plan, status).await;
            return false;
        }
    };
    let apply_actor = actor.clone();
    let apply_root = root.to_path_buf();
    let apply_workspace = workspace_id.to_owned();
    let apply_self_writes = self_writes.clone();
    let version_for_retire = version_id.clone();
    let now_ms = wall_now_ms();
    // A DEDICATED plain thread, not spawn_blocking: the sink's blocking actor
    // calls assert they run OUTSIDE any tokio runtime context, and
    // spawn_blocking threads carry the runtime handle. Awaiting the oneshot
    // (uncancellable await) is also exactly the drain-before-close property —
    // teardown cannot interrupt a half-applied plan.
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let apply_plan = plan.clone();
    let apply_author_json = author_json.clone();
    let apply_thread = std::thread::Builder::new()
        .name("dohc-capture-apply".to_owned())
        .spawn(move || {
            // A FRESH sink per run: the policy snapshot and (lazily loaded)
            // secret key are re-read per reconcile task, matching the TS
            // one-policy-snapshot-per-task rule.
            let mut sink = StoreCaptureSink::new_with_self_writes(
                apply_actor,
                apply_workspace,
                version_id,
                apply_root,
                now_ms,
                apply_author_json,
                apply_self_writes,
            );
            let result = apply_reconcile_plan(&apply_plan, &mut sink, &NoFaults);
            let _ = done_tx.send((apply_plan, result, sink.policy_held()));
        });
    let applied: Option<(ReconcilePlan, CaptureApplyResult, bool)> = match apply_thread {
        Ok(joiner) => {
            let outcome = done_rx.await.ok();
            let _ = tokio::task::spawn_blocking(move || joiner.join()).await;
            outcome
        }
        Err(_) => None,
    };
    let Some((plan, mut result, sink_policy_held)) = applied else {
        // Spawn failure or apply-thread panic: the plan must still resolve.
        status.mark_degraded();
        ack_all_failed(files, plan, status).await;
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
                status.mark_degraded();
                // Arm the loop's policy-recovery trigger: this blip may never
                // be visible to the loop's own fingerprint read.
                status.arm_policy_hold();
                false
            }
        };
        if excluded {
            let retire_actor = actor.clone();
            let retire_workspace = workspace_id.to_owned();
            let retire_version = version_for_retire.clone();
            let retire_path = path.clone();
            let retire_root = root.to_path_buf();
            let retire_self_writes = self_writes.clone();
            let retire_author_json = author_json.clone();
            let retired = tokio::task::spawn_blocking(move || {
                let mut sink = StoreCaptureSink::new_with_self_writes(
                    retire_actor,
                    retire_workspace,
                    retire_version,
                    retire_root,
                    now_ms,
                    retire_author_json,
                    retire_self_writes,
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
                    status.mark_degraded();
                }
            }
        }
    }
    if result.degraded {
        status.mark_degraded();
    }
    // The sink reports its holds DIRECTLY: a re-read here could miss the
    // very blip that caused the hold (readable again by the time this line
    // runs). The flag comes from the exact decision point instead.
    if sink_policy_held {
        status.arm_policy_hold();
    }
    let clean = result.failed_applies.is_empty() && !result.degraded;
    if result.completed() && files.acknowledge_capture(plan, result).await.is_err() {
        status.mark_degraded();
        return false;
    }
    clean
}

/// Resolve a prepared plan whose apply never ran: acknowledge with EVERY op
/// marked failed, clearing the controller's `outstanding` latch while keeping
/// the paths dirty for the next cycle's retry.
async fn ack_all_failed(files: &FilesHandle, plan: ReconcilePlan, status: &Arc<DriverStatus>) {
    let failed: Vec<String> = plan.ops.iter().map(|op| op.path().to_owned()).collect();
    let receipt = CaptureApplyResult {
        applied_paths: Vec::new(),
        captured: Vec::new(),
        not_owned_paths: Vec::new(),
        failed_applies: failed,
        crashed_after_apply: None,
        degraded: true,
    };
    if files.acknowledge_capture(plan, receipt).await.is_err() {
        status.mark_degraded();
    }
}
