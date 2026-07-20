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
/// TERMINAL. Eight escalating attempts is a little over a minute - long
/// enough that no transient condition reaches it, short enough that a real
/// one is reported promptly.
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

    /// The streak itself is an implementation detail of the schedule; only
    /// the tests read it, to prove escalation and reset happen where claimed.
    #[cfg(test)]
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
            // The layer is still up, so keep it — but this DOES count as a
            // failure: a reconcile that fails every tick must slow down and
            // escalate rather than retry at the fast cadence forever.
            TickObservation::ReconcileFailed => {
                self.record_failure(status);
                LayerAction::Keep
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
    /// The watcher reported degradation or permanent loss, a reconcile or
    /// apply failed, or the files layer could not (re)start. Sticky until a
    /// clean (re)start of the layer.
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
    #[cfg_attr(not(test), expect(dead_code))]
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
        for _ in 0..MAX_RESTART_ATTEMPTS {
            assert_eq!(
                restart.observe(TickObservation::ReconcileFailed, &status),
                LayerAction::Keep,
                "a live layer is not torn down for a failed reconcile"
            );
        }
        assert!(
            status.terminal(),
            "but it must still escalate rather than retry hot forever"
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
    policy_fingerprint: u64,
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
        policy_fingerprint: u64,
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
/// touch-without-change does not force a re-offer.
fn policy_fingerprint(root: &Path) -> u64 {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    for name in ["files.toml", "visibility.toml"] {
        let path = root.join(".dohc").join(name);
        match std::fs::read(&path) {
            Ok(bytes) => {
                1u8.hash(&mut hasher);
                bytes.hash(&mut hasher);
            }
            Err(_) => 0u8.hash(&mut hasher),
        }
    }
    hasher.finish()
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
fn sink_policy_excludes(root: &Path, path: &str) -> bool {
    let Some(rules) = dohc_engine_runtime::search::read_engine_search_policy(root).files_policy
    else {
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

/// The driver loop. Owns the files layer end to end. A missing layer
/// (initial or restart failure) is retried every tick rather than killing
/// the driver — the D shard layers backoff/escalation on this seam.
async fn drive(
    root: PathBuf,
    actor: ActorHandle,
    workspace_id: String,
    cancel: CancellationToken,
    status: Arc<DriverStatus>,
    baseline_tx: tokio::sync::watch::Sender<bool>,
) {
    let mut layer: Option<FilesLayer> = None;
    let mut restart = RestartTracker::default();
    let mut first_pass = true;
    loop {
        // THE cadence. A healthy driver waits DRIVE_INTERVAL (restart_delay(0));
        // a failing one waits out its backoff, whether it is about to rebuild
        // the layer or to retry a reconcile on a layer it kept. Skipped only
        // on the very first pass, so `workspace.open` pays no extra latency.
        if !first_pass {
            tokio::select! {
                biased;
                () = cancel.cancelled() => break,
                () = tokio::time::sleep(restart.delay()) => {}
            }
        }
        first_pass = false;

        if layer.is_none() {
            // REHYDRATE the scan manifest from the domain's captured state:
            // against an EMPTY baseline a file deleted while the daemon was
            // down could never emit a Retire and its stale head would stay
            // readable forever. Secrets seed with a sentinel sha (plaintext
            // hashes are never stored) and re-offer once into the encrypted
            // dedupe. A seed failure degrades to the empty baseline (safe:
            // over-capture, never data loss) rather than blocking start.
            // Read the policy fingerprint BEFORE the seed: if policy changes
            // between the two, the layer records the OLDER fingerprint and
            // the next tick detects the edit and restarts. Recording the
            // newer one would swallow the edit (the seed reflects old policy
            // while the layer claims to be current).
            let fingerprint_before_seed = policy_fingerprint(&root);
            let seed = manifest_seed(&root, &actor, &workspace_id).await;
            match FilesLayer::start_with_fingerprint(&root, &cancel, seed, fingerprint_before_seed)
                .await
            {
                Ok((fresh, initial)) => {
                    status.running.store(true, Ordering::Release);
                    // Deliberately NOT clearing `degraded` here: a start is
                    // not evidence of health. Clearing it on a bare start let
                    // a watch that died right after every start flicker
                    // "clean" twice a second while provably dead. The first
                    // healthy TICK clears it.
                    let mut settled =
                        apply_run(&root, &actor, &workspace_id, &fresh, initial, &status).await;
                    // The open barrier must not release on a FAILED baseline:
                    // a caller whose first write lands before the retry could
                    // have it overwritten by the retry's capture of stale
                    // closed-period disk bytes. Retry the cycle a bounded
                    // number of times so a persistently failing path degrades
                    // the workspace instead of blocking open forever.
                    let mut attempts = 0;
                    while !settled && attempts < BASELINE_SETTLE_ATTEMPTS {
                        attempts += 1;
                        tokio::select! {
                            biased;
                            () = cancel.cancelled() => break,
                            () = tokio::time::sleep(DRIVE_INTERVAL) => {}
                        }
                        let run = fresh
                            .files
                            .handle()
                            .reconcile_if_dirty(cancel.child_token())
                            .await;
                        settled = match run {
                            Ok(run) => {
                                apply_run(&root, &actor, &workspace_id, &fresh, run, &status).await
                            }
                            Err(_) => false,
                        };
                    }
                    layer = Some(fresh);
                }
                Err(_) => {
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

        // Classify this tick, then let the tracker decide. Routing EVERY
        // outcome through one decision point is what keeps a failure mode
        // from quietly escaping the backoff.
        //
        // Watcher health first (the watch.rs composition contract: a
        // silently-dead OS watch must never stay silent at this layer). A
        // permanently lost watch tears the layer down for the next
        // restart — NativeWatcher::start re-seeds via its initial reconcile,
        // so no change is lost across the gap.
        let observation = if current.watcher.is_unavailable() {
            TickObservation::WatchLost
        } else if policy_fingerprint(&root) != current.policy_fingerprint {
            // Policy-flip re-offer: a changed files.toml/visibility.toml
            // respawns the layer so every path re-offers through the sink
            // (narrowed paths retire, widened paths re-ingest). The rebuild
            // seeds from the REHYDRATED manifest, not an empty one: an empty
            // baseline cannot emit a Retire for a path deleted from disk in
            // the same window as the policy edit (it appears in neither the
            // listing nor the manifest).
            TickObservation::PolicyChanged
        } else {
            let watcher_degraded = current.watcher.is_degraded();
            if watcher_degraded {
                status.degraded.store(true, Ordering::Release);
            }
            match current
                .files
                .handle()
                .reconcile_if_dirty(cancel.child_token())
                .await
            {
                Ok(run) => {
                    let clean =
                        apply_run(&root, &actor, &workspace_id, current, run, &status).await;
                    // Only NOW has the layer survived a full tick: live watch
                    // AND a reconcile that completed.
                    TickObservation::Healthy {
                        clean: clean && !watcher_degraded,
                    }
                }
                Err(FilesError::ActorUnavailable) => TickObservation::ActorLost,
                Err(_) => TickObservation::ReconcileFailed,
            }
        };

        if restart.observe(observation, &status) == LayerAction::Drop {
            if let Some(dead) = layer.take() {
                dead.stop().await;
            }
            status.running.store(false, Ordering::Release);
        }
    }

    if let Some(current) = layer.take() {
        current.stop().await;
    }
    status.running.store(false, Ordering::Release);
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
    for path in &plan.retained_over_cap {
        if sink_policy_excludes(root, path) {
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
                _ => status.degraded.store(true, Ordering::Release),
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
