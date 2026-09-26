//! The files-into-daemon composition driver: owns the [`FilesActor`], the
//! [`NativeWatcher`], and the reconcile→apply→acknowledge loop that makes
//! capture autonomous — once a root-bound workspace is open, external file
//! changes on disk are noticed and recorded with no RPC involved.
//!
//! Ownership model: the DRIVER TASK owns the files actor and the watcher, so
//! it can tear them down and re-spawn them freely (the policy-flip re-offer
//! below, and the D-shard watcher supervision that builds on the same lever).
//! The daemon holds only a [`CaptureDriver`]: a cancellation token, the
//! driver's join handle, and a small observable status snapshot for the E
//! RPCs. Shutdown is strictly ordered — watcher.stop() → files.close() →
//! driver exit — and on PER-WORKSPACE close the daemon awaits the driver
//! before closing the store actor, so no capture write can race workspace
//! teardown. (At whole-DAEMON exit the transport's close hook closes actors
//! first; in-flight capture writes fail contained and un-acked, and the
//! post-transport drain joins the threads — see `run_stdio`.)
//!
//! Policy-flip convergence (the #205-review obligation): `.dohc` is unwatched
//! (policy edits generate no watcher events — TS parity), so each drive cycle
//! fingerprints `.dohc/files.toml` + `.dohc/visibility.toml`. On a change the
//! files layer is respawned with a manifest seeded from captured state.
//! Narrowed entries carry a sentinel hash so unchanged paths retire via the
//! sink's NotOwned branch. The seed preserves deletion detection, and paths
//! whose policy widens re-ingest.

use crate::capture_sink::{
    CaptureProvenance, CapturedRoot, PolicyState, SelfWriteSuppression, StoreCaptureSink,
    StoreCaptureSinkParams,
};
use crate::{CAPTURE_INITIAL_SETTLED_EVENT, CAPTURE_MOMENT_RECORDED_EVENT, EngineEvents};
use dohc_engine_collab::LeaseRegistry;
use dohc_engine_domain::COLLECTION_SCHEMA_FILENAME;
use dohc_engine_files::{
    CancellationToken, CaptureApplyResult, CaptureOp, FilesActor, FilesError, FilesHandle,
    IngestReason, ManifestEntry, NativeWatcher, PoolGauge, ReconcilePlan, ReconcileRun, ScanBounds,
    ScanGeneration, ScanManifest, apply_reconcile_plan_cancellable,
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

/// Small workspaces finish their baseline quickly and gain nothing from a
/// partially ready shell. Reserve early import for workspaces whose per-file
/// actor work is large enough for the background tail to be user-visible.
pub const EARLY_IMPORT_MIN_ADDED_FILES: usize = 1_000;

/// Test controls for capture, workspace lifecycle, and version fences.
/// The type exists in every build; production builds allocate no probe state.
#[derive(Clone)]
#[cfg_attr(any(test, feature = "harness"), derive(Default))]
pub struct CaptureApplyProbe {
    #[cfg(feature = "harness")]
    inner: Arc<CaptureApplyProbeInner>,
    #[cfg(any(test, feature = "harness"))]
    open_install_armed: Arc<std::sync::atomic::AtomicBool>,
    #[cfg(any(test, feature = "harness"))]
    open_install_reached: Arc<tokio::sync::Notify>,
    #[cfg(any(test, feature = "harness"))]
    open_install_release: Arc<tokio::sync::Notify>,
    #[cfg(any(test, feature = "harness"))]
    open_budget_armed: Arc<std::sync::atomic::AtomicBool>,
    #[cfg(any(test, feature = "harness"))]
    open_budget_reached: Arc<tokio::sync::Notify>,
    #[cfg(any(test, feature = "harness"))]
    open_budget_release: Arc<tokio::sync::Notify>,
}

#[cfg(any(test, feature = "harness"))]
impl CaptureApplyProbe {
    pub fn pause_next_open_install(&self) {
        self.open_install_armed.store(true, Ordering::Release);
    }

    pub async fn wait_until_open_install_paused(&self) {
        self.open_install_reached.notified().await;
    }

    pub fn release_open_install(&self) {
        self.open_install_release.notify_one();
    }

    pub fn pause_next_open_budget(&self) {
        self.open_budget_armed.store(true, Ordering::Release);
    }

    pub async fn wait_until_open_budget_paused(&self) {
        self.open_budget_reached.notified().await;
    }

    pub fn release_open_budget(&self) {
        self.open_budget_release.notify_one();
    }
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
    worker_armed: std::sync::atomic::AtomicBool,
    worker_entered: tokio::sync::Semaphore,
    worker_release: (Mutex<bool>, std::sync::Condvar),
    fail_before_worker_armed: std::sync::atomic::AtomicBool,
    manual_initial_deadline_armed: std::sync::atomic::AtomicBool,
    manual_initial_deadline: tokio::sync::Notify,
    version_scan_count: std::sync::atomic::AtomicU64,
    manifest_refresh_count: std::sync::atomic::AtomicU64,
    layer_start_count: std::sync::atomic::AtomicU64,
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
            worker_armed: std::sync::atomic::AtomicBool::new(false),
            worker_entered: tokio::sync::Semaphore::new(0),
            worker_release: (Mutex::new(false), std::sync::Condvar::new()),
            fail_before_worker_armed: std::sync::atomic::AtomicBool::new(false),
            manual_initial_deadline_armed: std::sync::atomic::AtomicBool::new(false),
            manual_initial_deadline: tokio::sync::Notify::new(),
            version_scan_count: std::sync::atomic::AtomicU64::new(0),
            manifest_refresh_count: std::sync::atomic::AtomicU64::new(0),
            layer_start_count: std::sync::atomic::AtomicU64::new(0),
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

    /// Pause the next plain apply worker after it starts but before it calls
    /// the capture sink. The blocking release is deliberate: this seam proves
    /// the async driver can time out while its `done_rx` remains pending.
    pub fn pause_next_apply_worker(&self) {
        self.inner.worker_armed.store(true, Ordering::Release);
    }

    pub async fn wait_until_apply_worker_paused(&self) {
        self.inner
            .worker_entered
            .acquire()
            .await
            .expect("capture apply worker probe remains open")
            .forget();
    }

    pub fn release_apply_worker(&self) {
        let (release, wake) = &self.inner.worker_release;
        *release
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
        wake.notify_one();
    }

    /// Fail the next apply before its plain worker starts. The normal
    /// all-failed acknowledgment keeps the plan dirty for a retry.
    pub fn fail_next_apply_before_worker(&self) {
        self.inner
            .fail_before_worker_armed
            .store(true, Ordering::Release);
    }

    /// Replace the production timer with a manual edge for one initial settle.
    pub fn use_manual_initial_settle_deadline(&self) {
        self.inner
            .manual_initial_deadline_armed
            .store(true, Ordering::Release);
    }

    pub fn expire_initial_settle_deadline(&self) {
        self.inner.manual_initial_deadline.notify_one();
    }

    pub fn version_scan_count(&self) -> u64 {
        self.inner.version_scan_count.load(Ordering::Acquire)
    }

    pub fn manifest_refresh_count(&self) -> u64 {
        self.inner.manifest_refresh_count.load(Ordering::Acquire)
    }

    pub fn layer_start_count(&self) -> u64 {
        self.inner.layer_start_count.load(Ordering::Acquire)
    }
}

impl CaptureApplyProbe {
    pub(crate) fn pause_open_install_if_armed(&self) {
        #[cfg(any(test, feature = "harness"))]
        if self.open_install_armed.swap(false, Ordering::AcqRel) {
            self.open_install_reached.notify_one();
            // The open guard must stay owned here after caller cancellation.
            tokio::runtime::Handle::current().block_on(self.open_install_release.notified());
        }
    }

    pub(crate) fn pause_open_budget_if_armed(&self) {
        #[cfg(any(test, feature = "harness"))]
        if self.open_budget_armed.swap(false, Ordering::AcqRel) {
            self.open_budget_reached.notify_one();
            tokio::runtime::Handle::current().block_on(self.open_budget_release.notified());
        }
    }

    async fn pause_if_armed(&self) {
        #[cfg(feature = "harness")]
        {
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
    }

    async fn pause_initial_if_armed(&self, _cancel: &CancellationToken) {
        #[cfg(feature = "harness")]
        {
            if self.inner.armed.swap(false, Ordering::AcqRel) {
                self.inner.entered.add_permits(1);
                tokio::select! {
                    biased;
                    () = _cancel.cancelled() => {}
                    permit = self.inner.release.acquire() => {
                        permit.expect("capture apply probe remains open").forget();
                    }
                }
            }
        }
    }

    pub(crate) async fn pause_version_fence_if_armed(&self) {
        #[cfg(feature = "harness")]
        {
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
    }

    pub(crate) fn observe_version_fence_wait_if_armed(&self) {
        #[cfg(feature = "harness")]
        {
            if self.inner.fence_wait_armed.swap(false, Ordering::AcqRel) {
                self.inner.fence_wait_entered.add_permits(1);
            }
        }
    }

    pub(crate) async fn pause_version_commit_if_armed(&self) {
        #[cfg(feature = "harness")]
        {
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
    }

    pub(crate) fn observe_gate_wait_if_armed(&self) {
        #[cfg(feature = "harness")]
        {
            if self.inner.gate_wait_armed.swap(false, Ordering::AcqRel) {
                self.inner.gate_wait_entered.add_permits(1);
            }
        }
    }

    fn pause_worker_if_armed(&self) {
        #[cfg(feature = "harness")]
        {
            if !self.inner.worker_armed.swap(false, Ordering::AcqRel) {
                return;
            }
            self.inner.worker_entered.add_permits(1);
            let (release, wake) = &self.inner.worker_release;
            let mut released = release
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            while !*released {
                released = wake
                    .wait(released)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
            *released = false;
        }
    }

    fn fail_before_worker_if_armed(&self) -> bool {
        #[cfg(feature = "harness")]
        {
            self.inner
                .fail_before_worker_armed
                .swap(false, Ordering::AcqRel)
        }
        #[cfg(not(feature = "harness"))]
        {
            false
        }
    }

    async fn take_manual_initial_deadline(&self) -> bool {
        #[cfg(feature = "harness")]
        if self
            .inner
            .manual_initial_deadline_armed
            .swap(false, Ordering::AcqRel)
        {
            self.inner.manual_initial_deadline.notified().await;
            return true;
        }
        false
    }

    pub(crate) fn record_version_scan(&self) {
        #[cfg(feature = "harness")]
        {
            self.inner.version_scan_count.fetch_add(1, Ordering::AcqRel);
        }
    }

    fn record_manifest_refresh(&self) {
        #[cfg(feature = "harness")]
        {
            self.inner
                .manifest_refresh_count
                .fetch_add(1, Ordering::AcqRel);
        }
    }

    fn record_layer_start(&self) {
        #[cfg(feature = "harness")]
        {
            self.inner.layer_start_count.fetch_add(1, Ordering::AcqRel);
        }
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
/// nothing, present so a root that comes back is picked up without the caller
/// having to close and reopen the workspace.
const TERMINAL_PROBE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// How long to wait before the next files-layer start attempt, given the
/// number of consecutive failures so far. Pure so the schedule is testable
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

/// How many extra cycles the startup baseline may take to settle before
/// `workspace.open` is released anyway (degraded). Bounds open latency while
/// keeping the common transient-failure case ordered.
const BASELINE_SETTLE_ATTEMPTS: u32 = 3;

/// A fresh workspace may open while its initial import continues, but that
/// background work must not leave the observable phase stuck at `Importing`
/// forever. The apply is cancelled at this edge and still drained in place so
/// its worker, apply gate, and mandatory reconcile acknowledgment stay owned.
const EARLY_IMPORT_APPLY_DEADLINE: std::time::Duration = std::time::Duration::from_secs(120);

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
    /// `files.toml`/`visibility.toml` changed: an intentional restart, not a
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

    /// The layer survived a full tick with a live watch. This is the only
    /// reset: clearing the streak at start time instead would let a watch that
    /// dies immediately after every start flap at the fast cadence forever —
    /// exactly the case the streak exists to bound. It is also the only exit
    /// from TERMINAL, which is what makes the slow probe a recovery path
    /// rather than a graveyard.
    fn record_healthy_tick(&mut self, status: &DriverStatus, clean: bool) {
        self.consecutive_failures = 0;
        // The healthy tick IS the proof the layer runs — running is claimed,
        // terminal cleared, and (when the tick was fully clean) degradation
        // cleared, all in one store. Degradation is sticky until the layer
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
    /// with the layer. The decision point: every failure mode routes through
    /// here so none can quietly escape the backoff.
    fn observe(&mut self, observation: TickObservation, status: &DriverStatus) -> LayerAction {
        match observation {
            TickObservation::Healthy { clean } => {
                self.record_healthy_tick(status, clean);
                LayerAction::Keep
            }
            // A dead watch or actor is unrecoverable in place: drop the layer
            // and let the backoff govern the rebuild. The failure transition
            // is one store (running off, degraded on, terminal per streak),
            // so no reader can observe it half-applied.
            TickObservation::WatchLost | TickObservation::ActorLost => {
                self.record_failure(status);
                LayerAction::Drop
            }
            // The layer is kept while the failure might be transient, but the
            // tick failed — `running` reads false until a tick completes,
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

/// The current files layer's hash gauge. A restarted layer replaces it, so its
/// count can go down; readers look for movement, not growth.
#[derive(Clone, Default)]
pub(crate) struct ScanGauge(Arc<Mutex<Option<Arc<PoolGauge>>>>);

impl ScanGauge {
    fn set(&self, gauge: &Arc<PoolGauge>) {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Arc::clone(gauge));
    }

    /// Files the current layer has hashed. It moves while a scan runs.
    pub(crate) fn hashed(&self) -> u64 {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map_or(0, |gauge| gauge.hashed() as u64)
    }
}

/// Observable driver state for the E-shard `watcher.status` RPC and tests.
///
/// One atomic word, deliberately: with separate atomics per flag, no
/// writer-side store ordering can stop a reader from loading one flag before
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
/// files layer could not (re)start. Cleared by the next fully clean tick
/// (reconcile completed, apply clean, no fresh watcher disruption) — current
/// health, not an event log.
const STATUS_DEGRADED: u8 = 1 << 1;
/// The files layer failed [`MAX_RESTART_ATTEMPTS`] times in a row. Capture is
/// not running and not expected to resume on its own timescale; the slow
/// recovery probe still runs, so this is a report, not a grave.
const STATUS_TERMINAL: u8 = 1 << 2;
/// An apply observed an unreadable policy (held ops). Folded into the drive
/// loop's unknown-fingerprint tracking so the policy-recovery rebuild fires
/// even when the blip was visible only inside the apply window.
const STATUS_POLICY_HOLD: u8 = 1 << 3;
/// Collection state may need reconciliation without a membership op in the
/// current file plan (startup, conflict, or version transition). The driver
/// consumes this bit before attempting reconciliation and re-arms it on
/// failure, so a transition racing the attempt remains pending.
const STATUS_COLLECTION_RECONCILE_PENDING: u8 = 1 << 4;
const STATUS_PHASE_SHIFT: u8 = 5;
const STATUS_PHASE_MASK: u8 = 0b11 << STATUS_PHASE_SHIFT;
/// The early-import apply deadline elapsed while `start_layer` was still
/// draining. Bare starts cannot claim running while this bit is set; the next
/// healthy tick clears it while making that claim.
const STATUS_INITIAL_APPLY_TIMED_OUT: u8 = 1 << 7;

/// Truth about the one-time startup capture barrier. Once `Ready`, ordinary
/// later watcher passes never take the workspace back behind this barrier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CapturePhase {
    Starting,
    Importing,
    Ready,
    Degraded,
}

impl CapturePhase {
    fn bits(self) -> u8 {
        let value = match self {
            Self::Starting => 0,
            Self::Importing => 1,
            Self::Ready => 2,
            Self::Degraded => 3,
        };
        value << STATUS_PHASE_SHIFT
    }

    fn from_bits(bits: u8) -> Self {
        match (bits & STATUS_PHASE_MASK) >> STATUS_PHASE_SHIFT {
            1 => Self::Importing,
            2 => Self::Ready,
            3 => Self::Degraded,
            _ => Self::Starting,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Importing => "importing",
            Self::Ready => "ready",
            Self::Degraded => "degraded",
        }
    }
}

/// A consistent point-in-time view of the driver, decoded from one atomic
/// load. Any consumer that needs more than one flag must go through this —
/// composing the per-flag getters performs separate loads, and a reader
/// interleaving with a transition could still assemble the contradictory
/// running && terminal tuple the single-word representation exists to kill.
#[derive(Debug, Clone, Copy)]
pub(crate) struct StatusSnapshot {
    pub(crate) running: bool,
    pub(crate) degraded: bool,
    pub(crate) terminal: bool,
    pub(crate) phase: CapturePhase,
}

impl DriverStatus {
    /// One load; all flags decoded from the same word.
    pub(crate) fn snapshot(&self) -> StatusSnapshot {
        let bits = self.bits.load(Ordering::Acquire);
        StatusSnapshot {
            running: bits & STATUS_RUNNING != 0,
            degraded: bits & STATUS_DEGRADED != 0,
            terminal: bits & STATUS_TERMINAL != 0,
            phase: CapturePhase::from_bits(bits),
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
    // self-contradict); combinations must use [`DriverStatus::snapshot`] —
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
    pub(crate) fn mark_degraded(&self) {
        self.update(|bits| bits | STATUS_DEGRADED);
    }
    fn set_initial_phase(&self, phase: CapturePhase) {
        self.update(|bits| (bits & !STATUS_PHASE_MASK) | phase.bits());
    }
    fn mark_initial_ready(&self) {
        self.set_initial_phase(CapturePhase::Ready);
    }
    fn mark_initial_degraded(&self) {
        self.update(|bits| {
            if CapturePhase::from_bits(bits) == CapturePhase::Ready {
                return bits | STATUS_DEGRADED;
            }
            ((bits | STATUS_DEGRADED) & !STATUS_PHASE_MASK) | CapturePhase::Degraded.bits()
        });
    }
    /// The early import exceeded its bounded apply window. The worker is
    /// still draining under the apply gate, so this is degraded rather than a
    /// terminal supervision failure, and capture cannot claim to be running.
    fn mark_initial_apply_timed_out(&self) {
        self.update(|bits| {
            ((((bits & !STATUS_RUNNING) | STATUS_DEGRADED) | STATUS_INITIAL_APPLY_TIMED_OUT)
                & !STATUS_PHASE_MASK)
                | CapturePhase::Degraded.bits()
        });
    }
    fn initial_apply_timed_out(&self) -> bool {
        self.bits.load(Ordering::Acquire) & STATUS_INITIAL_APPLY_TIMED_OUT != 0
    }
    /// A failure: not running, degraded, terminal iff the streak says so —
    /// one store, so no reader can see a half-applied transition.
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
    /// one store.
    fn record_healthy_transition(&self, clean: bool) {
        self.update(|bits| {
            let mut bits =
                ((bits | STATUS_RUNNING) & !STATUS_TERMINAL) & !STATUS_INITIAL_APPLY_TIMED_OUT;
            if clean {
                bits &= !STATUS_DEGRADED;
                if CapturePhase::from_bits(bits) != CapturePhase::Ready {
                    bits = (bits & !STATUS_PHASE_MASK) | CapturePhase::Ready.bits();
                }
            }
            bits
        });
    }
    fn arm_policy_hold(&self) {
        self.update(|bits| bits | STATUS_POLICY_HOLD);
    }
    /// Consume the hold (test-and-clear in one atomic op).
    fn take_policy_hold(&self) -> bool {
        self.bits.fetch_and(!STATUS_POLICY_HOLD, Ordering::AcqRel) & STATUS_POLICY_HOLD != 0
    }
    pub(crate) fn request_collection_reconcile(&self) {
        self.update(|bits| bits | STATUS_COLLECTION_RECONCILE_PENDING);
    }
    #[cfg(test)]
    fn collection_reconcile_pending(&self) -> bool {
        self.bits.load(Ordering::Acquire) & STATUS_COLLECTION_RECONCILE_PENDING != 0
    }
    /// Take the current request before starting the actor call. A concurrent
    /// transition then sets a fresh bit that this attempt cannot erase.
    fn take_collection_reconcile_request(&self) -> bool {
        self.bits
            .fetch_and(!STATUS_COLLECTION_RECONCILE_PENDING, Ordering::AcqRel)
            & STATUS_COLLECTION_RECONCILE_PENDING
            != 0
    }
}

fn may_publish_early_import(status: &DriverStatus) -> bool {
    status.snapshot().phase == CapturePhase::Starting
}

#[cfg(test)]
mod startup_contract_tests;

#[cfg(test)]
mod restart_schedule_tests;

#[cfg(test)]
mod supervision_tests;

/// Loop-level tests. These drive the real `drive_loop` against a scripted
/// environment under paused time, so they observe what the loop actually
/// waits on and rebuilds. The earlier suite asserted on `RestartTracker`
/// alone and stayed green when the loop's cadence was reverted to the very
/// bug it was written for; every test here fails under that mutation.
#[cfg(test)]
mod drive_loop_tests;

pub(crate) struct CaptureDriverSpawnParams {
    pub(crate) root: PathBuf,
    pub(crate) actor: ActorHandle,
    pub(crate) workspace_id: String,
    pub(crate) leases: LeaseRegistry,
    pub(crate) self_writes: SelfWriteSuppression,
    pub(crate) apply_gate: ApplyGate,
    pub(crate) store_freshly_created: bool,
    pub(crate) initial_author_json: Option<String>,
    pub(crate) events: EngineEvents,
    pub(crate) apply_probe: Option<CaptureApplyProbe>,
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
    /// Resolves at the first safe open point: before apply only for the strict
    /// fresh all-Added import, otherwise after the startup baseline settles or
    /// degrades. The phase remains the source of truth after this one-shot
    /// readiness edge.
    open_ready: tokio::sync::watch::Receiver<bool>,
    /// Invalidates the live files layer after an out-of-band forced reconcile.
    /// The epoch is sampled into each layer; a mismatch makes the old layer
    /// restart before it may apply again.
    refresh_epoch: Arc<std::sync::atomic::AtomicU64>,
    apply_probe: Option<CaptureApplyProbe>,
    scan: ScanGauge,
}

/// A dropped-but-untaken driver must never keep running: cancel on Drop (the
/// task then winds itself down detached).
impl Drop for CaptureDriver {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

impl CaptureDriver {
    /// Spawn the files layer for a ROOT-BOUND workspace. Must only be
    /// called after `bind_root` succeeded: the sink writes through the bound
    /// store actor, and an unbound root must never spawn a watcher.
    pub(crate) fn spawn(params: CaptureDriverSpawnParams) -> CaptureDriver {
        let CaptureDriverSpawnParams {
            root,
            actor,
            workspace_id,
            leases,
            self_writes,
            apply_gate,
            store_freshly_created,
            initial_author_json,
            events,
            apply_probe,
        } = params;
        let cancel = CancellationToken::new();
        let status = Arc::new(DriverStatus::default());
        let author_json = Arc::new(Mutex::new(initial_author_json));
        let (open_ready_tx, open_ready) = tokio::sync::watch::channel(false);
        let (flush_tx, flush_rx) = tokio::sync::mpsc::channel(8);
        let refresh_epoch = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let scan = ScanGauge::default();
        let drive_scan = scan.clone();
        let driver_probe = apply_probe.clone();
        let drive_cancel = cancel.clone();
        let drive_status = Arc::clone(&status);
        let drive_author_json = Arc::clone(&author_json);
        let drive_refresh_epoch = Arc::clone(&refresh_epoch);
        let task = tokio::spawn(async move {
            let mut env = RealEnv {
                root,
                actor,
                lease_releases_seen: leases.release_generation(&workspace_id),
                workspace_id,
                leases,
                status: Arc::clone(&drive_status),
                author_json: drive_author_json,
                self_writes,
                apply_gate,
                store_freshly_created,
                open_ready_tx: open_ready_tx.clone(),
                refresh_epoch: drive_refresh_epoch,
                events,
                apply_probe,
                scan: drive_scan,
            };
            drive_loop(
                &mut env,
                drive_cancel,
                drive_status,
                open_ready_tx,
                flush_rx,
            )
            .await;
        });
        CaptureDriver {
            cancel,
            task: Some(task),
            status,
            author_json,
            flush_tx,
            open_ready,
            refresh_epoch,
            apply_probe: driver_probe,
            scan,
        }
    }

    /// The files layer's hash gauge, for a caller waiting on the startup scan.
    pub(crate) fn scan_gauge(&self) -> ScanGauge {
        self.scan.clone()
    }

    /// A clonable handle for `capture.flush`: the RPC layer clones it out of
    /// the handle lock and awaits outside, so a long flush never blocks the
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

    /// Wait for the first point at which handing out the workspace handle is
    /// safe. This is normally the settled baseline; only a proven fresh import
    /// can publish `Importing` before its bounded actor batches finish.
    pub(crate) async fn wait_for_open_ready(&self) {
        let mut open_ready = self.open_ready.clone();
        while !*open_ready.borrow() {
            if open_ready.changed().await.is_err() {
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
        if let Some(probe) = &self.apply_probe {
            probe.record_manifest_refresh();
        }
    }

    /// Signal shutdown without taking the driver handle. Close uses this to
    /// release a capture pass that currently owns the apply gate, then takes
    /// and joins the driver after it acquires that same gate.
    pub(crate) fn request_shutdown(&self) {
        self.cancel.cancel();
    }

    /// Cancel the loop synchronously and hand back the join handle; the
    /// driver winds itself down (watcher joined, files actor closed) whether
    /// or not the caller awaits. Callers that need ordered teardown await
    /// the handle before closing the store actor.
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

/// A filesystem result and the physical workspace directory that produced it.
/// The binding is taken before the scan starts and stays with the plan through
/// apply, so a replacement directory at the same pathname cannot donate bytes
/// to an older generation.
struct RootBoundRun {
    captured_root: Arc<CapturedRoot>,
    run: ReconcileRun,
}

fn bind_capture_root(root: &Path) -> Result<Arc<CapturedRoot>, FilesError> {
    CapturedRoot::bind(root)
        .map(Arc::new)
        .map_err(|error| FilesError::InvalidRoot {
            reason: error.reason,
        })
}

async fn reconcile_if_dirty_bound(
    root: &Path,
    files: &FilesHandle,
    cancel: CancellationToken,
) -> Result<RootBoundRun, FilesError> {
    let captured_root = bind_capture_root(root)?;
    let run = files.reconcile_if_dirty(cancel).await?;
    Ok(RootBoundRun { captured_root, run })
}

impl FilesLayer {
    /// Spawn the files actor and attach the watcher; the watcher's startup
    /// reconcile (the full baseline scan) is returned for the caller to
    /// apply through the normal capture path.
    /// Start with a CALLER-SUPPLIED policy fingerprint. The driver reads it
    /// before building the seed, so a policy edit that races startup leaves
    /// the layer holding the older fingerprint and the next tick restarts —
    /// recording the newer one would swallow the edit (the seed would
    /// reflect old policy while the layer claimed to be current).
    async fn start_with_fingerprint(
        root: &Path,
        cancel: &CancellationToken,
        seed: Option<(ScanManifest, ScanGeneration)>,
        policy_fingerprint: Option<u64>,
        refresh_epoch: u64,
        scan: &ScanGauge,
    ) -> Result<(FilesLayer, RootBoundRun), FilesError> {
        let captured_root = bind_capture_root(root)?;
        let files =
            FilesActor::spawn_async_with_manifest(root.to_path_buf(), ScanBounds::default(), seed)
                .await?;
        // Before the watcher's initial scan, so the scan's count is readable.
        scan.set(files.gauge());
        let handle = files.handle();
        match NativeWatcher::start(root.to_path_buf(), handle, cancel.child_token()).await {
            Ok(start) => Ok((
                FilesLayer {
                    files,
                    watcher: start.watcher,
                    policy_fingerprint,
                    refresh_epoch,
                },
                RootBoundRun {
                    captured_root,
                    run: start.initial_reconcile,
                },
            )),
            Err(err) => {
                let mut files = files;
                let _ = tokio::task::spawn_blocking(move || files.close()).await;
                Err(err)
            }
        }
    }

    /// Strictly ordered teardown: stop+join the watcher first (no dirty marks
    /// can arrive afterwards), then close+join the files actor.
    async fn stop(mut self) {
        let _ = tokio::task::spawn_blocking(move || {
            let _ = self.watcher.stop();
            let _ = self.files.close();
        })
        .await;
    }
}

/// The only initial plan that can safely continue after `workspace.open`
/// returns. Every path is new to a brand-new store, so capture never claims a
/// foreign head; any retire, changed ingest, degraded observation, or retained
/// path requires the traditional full startup barrier.
fn is_safe_fresh_import_plan(run: &ReconcileRun) -> bool {
    let ReconcileRun::Completed(plan) = run else {
        return false;
    };
    plan.ops.len() >= EARLY_IMPORT_MIN_ADDED_FILES
        && !plan.degraded
        && plan.degraded_paths.is_empty()
        && plan.unconfirmed_removed.is_empty()
        && plan.retained_over_cap.is_empty()
        && plan.ops.iter().all(|op| {
            matches!(
                op,
                CaptureOp::Ingest {
                    reason: IngestReason::Added,
                    ..
                }
            )
        })
}

/// A cheap change-detector over the two policy files. Content-hash based so
/// touch-without-change does not force a re-offer. Absence is a real,
/// hashable state (no files.toml is simply the default policy); any other
/// read error means the current policy is unknown — returned as `None` so
/// the debounce holds position instead of comparing against a fabricated
/// error-hash, which flapped under an intermittently-locked file.
fn policy_fingerprint(root: &Path) -> Option<u64> {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    for name in ["files.toml", "visibility.toml"] {
        let path = root.join(".dohc").join(name);
        // Mirror the policy reader's refusals: it rejects a symlinked or
        // non-regular-file policy as Unreadable without following it, while a
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

/// Why the files layer starts with an empty or populated manifest. Keeping
/// `WorkspaceMissing` distinct from `Existing(None)` is part of the early-open
/// proof: an existing empty workspace must never look fresh by accident.
enum ManifestSeed {
    WorkspaceMissing,
    Existing(Option<(ScanManifest, ScanGeneration)>),
}

impl ManifestSeed {
    fn into_scan_seed(self) -> Option<(ScanManifest, ScanGeneration)> {
        match self {
            Self::WorkspaceMissing => None,
            Self::Existing(seed) => seed,
        }
    }

    fn is_workspace_missing(&self) -> bool {
        matches!(self, Self::WorkspaceMissing)
    }
}

/// Build the rehydration seed from the domain's captured state for the
/// version capture will target. A missing workspace is represented
/// explicitly; read failures remain errors and can never authorize early open.
async fn manifest_seed(
    root: &Path,
    actor: &ActorHandle,
    workspace_id: &str,
) -> Result<ManifestSeed, RuntimeError> {
    let version_id = match actor.active_version_id(workspace_id.to_owned()).await {
        Ok(version_id) => version_id,
        Err(RuntimeError::Domain(dohc_engine_domain::DomainError::WorkspaceNotFound)) => {
            return Ok(ManifestSeed::WorkspaceMissing);
        }
        Err(error) => return Err(error),
    };
    let entries = actor
        .capture_manifest_seed(workspace_id.to_owned(), version_id)
        .await?;
    if entries.is_empty() {
        return Ok(ManifestSeed::Existing(None));
    }
    // Every capture-owned entry is seeded — including paths the current
    // policy narrows out, but with a SENTINEL hash. That single choice
    // satisfies both halves of the policy-flip obligation:
    //   * narrowed and still on disk -> the sentinel can never match the
    //     scanned hash, so the path is re-offered as `Changed` and the
    //     sink's policy branch retires it;
    //   * narrowed and deleted while closed -> it is absent from the listing
    //     but present in the manifest, so the diff emits a Retire.
    // Dropping narrowed entries entirely would lose the second case forever
    // (the scanner enumerates by the hard floor, so such a path would appear
    // in neither the listing nor the manifest).
    let policy = dohc_engine_runtime::search::read_engine_search_policy(root).files_policy;
    let manifest = ScanManifest::from_entries(entries.into_iter().map(|entry| {
        let narrowed = policy_excludes(&policy, &entry.path);
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
                // The domain stores no mtime observation; `0` never
                // authorizes hash reuse, so the first scan after open hashes
                // every file.
                mtime_ms: 0,
            },
        )
    }));
    Ok(ManifestSeed::Existing(Some((manifest, ScanGeneration(1)))))
}

/// Never a valid hex digest, so a seeded entry carrying it always re-offers.
const NARROWED_SEED_SENTINEL_SHA: &str = "policy-narrowed-reoffer";

/// One policy read for a whole apply run's over-cap evaluations.
/// An unavailable policy holds the run dirty for recovery.
fn read_capture_policy(root: &Path) -> PolicyState {
    let snapshot = dohc_engine_runtime::search::read_engine_search_policy(root);
    if snapshot.diagnostics.iter().any(|diagnostic| {
        diagnostic.file == "files.toml"
            && diagnostic.reason == dohc_engine_runtime::search::DiagnosticReason::Unreadable
    }) {
        return PolicyState::Unavailable;
    }
    PolicyState::Known(snapshot.files_policy)
}

/// Whether a known policy narrows `path` out of engine ownership (the secret
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

fn is_collection_record_path(root: &Path, path: &str) -> bool {
    let Some((parent, name)) = path.rsplit_once('/') else {
        // v1 does not admit the workspace root as a collection.
        return false;
    };
    if parent.is_empty() || !dohc_engine_domain::collections::is_collection_markdown_path(name) {
        return false;
    }
    match std::fs::symlink_metadata(root.join(parent).join(COLLECTION_SCHEMA_FILENAME)) {
        Ok(metadata) => metadata.file_type().is_file(),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            false
        }
        // Permission/lock/other uncertainty fails toward reconciliation.
        Err(_) => true,
    }
}

/// Whether a settled file plan can change collection detection or membership.
fn collection_reconcile_required(root: &Path, plan: &ReconcilePlan) -> bool {
    plan.ops.iter().any(|op| {
        let path = op.path();
        path.rsplit('/').next() == Some(COLLECTION_SCHEMA_FILENAME)
            || matches!(
                op,
                CaptureOp::Ingest {
                    reason: IngestReason::Added,
                    ..
                } | CaptureOp::Retire { .. }
            ) && is_collection_record_path(root, path)
    })
}

/// Changed collection records whose canonical id needs comparison with the
/// durable binding after capture. Body and ordinary field edits do not by
/// themselves schedule the more expensive collection reconciliation.
fn changed_collection_record_paths(root: &Path, plan: &ReconcilePlan) -> Vec<String> {
    plan.ops
        .iter()
        .filter_map(|op| match op {
            CaptureOp::Ingest {
                path,
                reason: IngestReason::Changed,
                ..
            } if is_collection_record_path(root, path) => Some(path.clone()),
            _ => None,
        })
        .collect()
}

fn wall_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// The I/O one driver tick performs, behind a seam so the loop's cadence and
/// restart decisions are testable without a filesystem. Two rounds of review
/// found real defects in this loop that every test missed, because the tests
/// asserted on [`RestartTracker`] while the loop chose its own timing — a
/// mutation restoring the original bug left the whole suite green. The loop
/// is now generic over this trait so a fake can drive it under paused time
/// and assert what it actually waited on.
trait DriverEnv {
    type Layer;

    /// The root's current policy fingerprint; `None` when the policy files
    /// could not be read right now (transient lock/permission error). Unknown
    /// is not a distinct state to compare — the debounce holds position on
    /// it, else an intermittently-locked file alternates real/error hashes
    /// and a genuine edit is never confirmed.
    fn policy_fingerprint(&self) -> Option<u64>;
    /// The fingerprint the layer was built against (`None` if the policy was
    /// unreadable at build time).
    fn layer_fingerprint(&self, layer: &Self::Layer) -> Option<u64>;
    /// The OS watch is permanently gone.
    fn watch_lost(&self, layer: &Self::Layer) -> bool;
    /// Monotone count of watch disruptions this layer's watcher has seen.
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
    /// The reconcile was cancelled mid-scan (teardown): nothing committed,
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
/// on quiescence. A workspace under continuous external writes never
/// converges; flush must return an honest `settled: false` rather than spin.
const MAX_FLUSH_CYCLES: u32 = 32;

/// What one `capture.flush` could actually promise.
#[derive(Debug, Clone, Copy)]
pub(crate) struct FlushOutcome {
    /// Capture is quiet: the reconcile loop reached converged, and every change
    /// visible on disk at entry has been captured, acknowledged, or deferred
    /// to a live document session. It does not mean every edit is on disk: a
    /// live Y.Doc's edits can still be on their way, and the session's settle
    /// or close writes them. False means the cycle bound was hit, the layer is
    /// down, or teardown raced the flush.
    pub(crate) settled: bool,
    /// The files layer was up when the flush was answered.
    pub(crate) running: bool,
    /// Same meaning as [`DriverStatus::degraded`].
    pub(crate) degraded: bool,
}

/// Decide whether a policy edit should rebuild the layer this tick.
///
/// A policy rebuild is expensive (fresh actor, fresh watcher, full baseline
/// rescan), so a new fingerprint must hold for one tick before it triggers
/// one. Without the debounce, anything rewriting `files.toml` faster than the
/// drive interval — an agent syncing config, an editor autosaving — drives a
/// full rescan every tick forever, and a transient read error (which hashes
/// differently from any successful read) flaps the rebuild indefinitely.
fn policy_rebuild_due(
    fingerprint: Option<u64>,
    layer_fingerprint: Option<u64>,
    pending: &mut Option<u64>,
) -> bool {
    // Takes the tick's one fingerprint sample — re-reading here let a fast
    // policy toggle differ between the two reads and confirm a pending value
    // that never actually held across ticks.
    //
    // Unknown (unreadable policy) holds the debounce in place: it neither
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
    open_ready_tx: tokio::sync::watch::Sender<bool>,
    mut flush_rx: tokio::sync::mpsc::Receiver<tokio::sync::oneshot::Sender<FlushOutcome>>,
) {
    let mut layer: Option<E::Layer> = None;
    let mut restart = RestartTracker::default();
    let mut first_pass = true;
    // The disruption count already seen (and reported) for the current layer.
    let mut seen_disruptions: u64 = 0;
    let mut pending_policy: Option<u64> = None;
    // Whether the previous pass saw an unknown policy fingerprint. Needed at
    // recovery: ops held during the unknown window failed into the
    // quarantine, and if the policy comes back with the same bytes the
    // equality branch would never rebuild — nothing would ever re-offer the
    // held paths.
    let mut policy_was_unknown = false;
    // A flush caller waiting on this pass; answered exactly once per pass.
    let mut pending_flush: Option<tokio::sync::oneshot::Sender<FlushOutcome>> = None;
    let mut flush_closed = false;
    // The pass deadline is an instant, not a fresh sleep: a flush that
    // interrupts the wait must not reset the remaining backoff, or client
    // flush-polling would push a pending rebuild out forever.
    let mut next_pass_at = tokio::time::Instant::now();

    loop {
        // The cadence, and the only sleep: a healthy driver waits
        // DRIVE_INTERVAL (restart_delay(0)), a failing one waits out its
        // backoff — whether it is about to rebuild the layer or retry a
        // reconcile on a layer it kept. Keeping it here, before every branch,
        // is what stops a failure path from `continue`ing around it and
        // rebuilding hot. Skipped once so `workspace.open` pays no latency.
        if !first_pass {
            tokio::select! {
                biased;
                () = cancel.cancelled() => break,
                // A flush skips the remaining wait: the caller is blocked on
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
        // A flush may cut the wait short only outside a failure streak (a
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
                    // `running` is claimed on a bare start only outside a
                    // failure streak. Mid-streak (including terminal recovery
                    // probes) a start proves nothing — the last N layers also
                    // started and then died — and claiming it here made the
                    // status read running=true && terminal=true for the probe
                    // window. The first healthy tick sets it instead.
                    // `degraded` likewise stays until a fully clean tick.
                    if restart.failures() == 0 && !status.initial_apply_timed_out() {
                        status.set_running(true);
                    }
                    // Baseline for the new layer's watcher (a fresh watcher
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
                    status.mark_initial_degraded();
                }
            }
            // Whether the baseline applied or the start failed, the open
            // barrier releases: the workspace opens (possibly degraded), and
            // callers' first writes are ordered after the startup capture.
            let _ = open_ready_tx.send(true);
        }

        let Some(current) = layer.as_ref() else {
            // No layer to drive: answer honestly rather than holding the
            // caller across a rebuild that may be a terminal probe away.
            answer_flush(&mut pending_flush, &status, false);
            next_pass_at = tokio::time::Instant::now() + restart.delay();
            continue;
        };

        // Classify the tick, then let the tracker decide. Routing every
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
            // The policy just became readable again after an unknown window.
            // Ops held during that window (the sink fails them) have been
            // quarantined — and if the recovered bytes equal the layer's
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
            // re-ingest. The rebuild seeds from the rehydrated manifest, not
            // an empty one: an empty baseline cannot emit a Retire for a path
            // deleted from disk in the same window as the policy edit.
            TickObservation::PolicyChanged
        } else {
            // EDGE-triggered on the COUNT: report whenever the watcher has
            // seen disruptions we have not. Folding a sticky signal into
            // `clean` every tick latched `degraded` forever after one
            // recovered blip; edge-triggering a bool reported at most once
            // per layer and then went blind to genuinely new disruptions on
            // the same live watch. The count re-reports each one and still
            // clears within a tick once they stop.
            let disruptions = env.watch_disruptions(current);
            let fresh_disruption = disruptions != seen_disruptions;
            if fresh_disruption {
                seen_disruptions = disruptions;
                status.mark_degraded();
            }
            // A flush drives to quiescence, not one cycle: a single
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
                        // Quiescence is real for content — but a policy edit
                        // whose new fingerprint was first seen this pass is
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
            // `running` goes false before the teardown await: stop_layer
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

    // Before the joins, same as the Drop path: stop_layer drains threads,
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
        // One snapshot: running and degraded must come from the same load.
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
    leases: LeaseRegistry,
    /// The lease release count at the last check. A capture deferred to a
    /// live session is offered again once this moves.
    lease_releases_seen: u64,
    status: Arc<DriverStatus>,
    author_json: Arc<Mutex<Option<String>>>,
    self_writes: SelfWriteSuppression,
    apply_gate: ApplyGate,
    store_freshly_created: bool,
    open_ready_tx: tokio::sync::watch::Sender<bool>,
    refresh_epoch: Arc<std::sync::atomic::AtomicU64>,
    events: EngineEvents,
    apply_probe: Option<CaptureApplyProbe>,
    scan: ScanGauge,
}

impl RealEnv {
    fn capture_author(&self) -> Option<String> {
        self.author_json
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Context for a live watcher-batch apply: default provenance (per-file
    /// "Updated <basename>" summaries, no correlation id).
    fn apply_context(&self) -> ApplyRunContext<'_> {
        self.apply_context_with(CaptureProvenance::default())
    }

    fn apply_context_with(&self, provenance: CaptureProvenance) -> ApplyRunContext<'_> {
        ApplyRunContext {
            root: &self.root,
            actor: &self.actor,
            workspace_id: &self.workspace_id,
            leases: &self.leases,
            status: &self.status,
            self_writes: &self.self_writes,
            author_json: self.capture_author(),
            provenance,
            events: self.events.clone(),
            apply_probe: self.apply_probe.clone(),
        }
    }

    async fn initial_settle_deadline(&self) {
        if let Some(probe) = &self.apply_probe
            && probe.take_manual_initial_deadline().await
        {
            return;
        }
        tokio::time::sleep(EARLY_IMPORT_APPLY_DEADLINE).await;
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
        let initial_start = matches!(
            self.status.snapshot().phase,
            CapturePhase::Starting | CapturePhase::Importing
        );
        let _apply_guard = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(()),
            guard = self.apply_gate.lock() => guard,
        };
        // REHYDRATE the scan manifest from the domain's captured state:
        // against an empty baseline a file deleted while the daemon was down
        // could never emit a Retire and its stale head would stay readable
        // forever. Secrets seed with a sentinel sha (plaintext hashes are
        // never stored) and re-offer once into the encrypted dedupe. A seed
        // failure degrades to the empty baseline (safe: over-capture, never
        // data loss) rather than blocking start.
        //
        // Read the policy fingerprint before the seed: if policy changes
        // between the two, the layer records the older fingerprint and the
        // next tick detects the edit and rebuilds. Recording the newer one
        // would swallow the edit (the seed reflects old policy while the
        // layer claims to be current).
        let fingerprint_before_seed = policy_fingerprint(&self.root);
        let (seed, seed_loaded) =
            match manifest_seed(&self.root, &self.actor, &self.workspace_id).await {
                Ok(seed) => (seed, true),
                Err(_) => {
                    // Empty is the conservative capture fallback, but a failed
                    // authoritative seed read can never prove a fresh import.
                    self.status.mark_degraded();
                    (ManifestSeed::Existing(None), false)
                }
            };
        let workspace_missing = seed.is_workspace_missing();
        let refresh_epoch = self.refresh_epoch.load(Ordering::Acquire);
        let (fresh, initial) = FilesLayer::start_with_fingerprint(
            &self.root,
            cancel,
            seed.into_scan_seed(),
            fingerprint_before_seed,
            refresh_epoch,
            &self.scan,
        )
        .await
        .map_err(|_| ())?;

        // EARLY-OPEN PROOF. The watcher is attached before NativeWatcher
        // returns this initial plan. Re-read every mutable prerequisite after
        // the scan, then publish Importing in one atomic transition before the
        // first actor batch can be enqueued. Anything uncertain falls back to
        // the settled-baseline barrier below.
        let fingerprint_after_scan = policy_fingerprint(&self.root);
        let refresh_after_scan = self.refresh_epoch.load(Ordering::Acquire);
        let early_import = self.store_freshly_created
            && may_publish_early_import(&self.status)
            && seed_loaded
            && workspace_missing
            && is_safe_fresh_import_plan(&initial.run)
            && fingerprint_before_seed.is_some()
            && fingerprint_after_scan == fingerprint_before_seed
            && refresh_after_scan == refresh_epoch
            && !fresh.watcher.is_unavailable()
            && fresh.watcher.disruption_count() == 0
            && !cancel.is_cancelled();
        if early_import {
            self.status.set_running(true);
            self.status.set_initial_phase(CapturePhase::Importing);
            let _ = self.open_ready_tx.send(true);
        }

        if matches!(&initial.run, ReconcileRun::Completed(_))
            && let Some(probe) = &self.apply_probe
        {
            probe.pause_initial_if_armed(cancel).await;
        }

        // The startup baseline is the offline-reconcile pass (TS parity):
        // One correlation id and the "Reconciled offline edits" summary tie
        // its per-file moments together, retries included — they finish the
        // same pass. A new layer also performs one collection reconciliation:
        // its in-memory retry bit cannot preserve a failed request across a
        // daemon restart, and a rehydrated manifest may make this plan empty.
        self.status.request_collection_reconcile();
        let provenance = reconcile_provenance();
        let (mut settled, initial_settle_timed_out) = {
            let initial_cancel = cancel.child_token();
            let initial_settle = async {
                let mut settled = apply_run(
                    self.apply_context_with(provenance.clone()),
                    &fresh,
                    initial,
                    &initial_cancel,
                )
                .await;
                // The open barrier must not release on a failed baseline: a
                // caller whose first write lands before the retry could have
                // it overwritten by the retry's capture of stale closed-period
                // disk bytes. Retry a bounded number of times so a persistently
                // failing path degrades the workspace instead of blocking open
                // forever.
                let mut attempts = 0;
                while !settled && attempts < BASELINE_SETTLE_ATTEMPTS {
                    attempts += 1;
                    tokio::select! {
                        biased;
                        () = initial_cancel.cancelled() => break,
                        () = tokio::time::sleep(DRIVE_INTERVAL) => {}
                    }
                    settled = match reconcile_if_dirty_bound(
                        &self.root,
                        &fresh.files.handle(),
                        initial_cancel.child_token(),
                    )
                    .await
                    {
                        Ok(run) => {
                            apply_run(
                                self.apply_context_with(provenance.clone()),
                                &fresh,
                                run,
                                &initial_cancel,
                            )
                            .await
                        }
                        Err(_) => false,
                    };
                }
                settled
            };
            tokio::pin!(initial_settle);
            let initial_deadline = self.initial_settle_deadline();
            tokio::pin!(initial_deadline);
            tokio::select! {
                biased;
                settled = &mut initial_settle => (settled, false),
                () = &mut initial_deadline, if early_import => {
                    initial_cancel.cancel();
                    self.status.mark_initial_apply_timed_out();
                    self.events.emit(
                        CAPTURE_INITIAL_SETTLED_EVENT,
                        serde_json::json!({ "workspaceId": self.workspace_id }),
                    );
                    // `workspace.open` already received this edge for an early
                    // import. Re-sending is harmless and makes the timeout's
                    // observable transition explicit if that contract changes.
                    let _ = self.open_ready_tx.send(true);
                    (initial_settle.await, true)
                }
            }
        };
        if initial_settle_timed_out {
            settled = false;
        }
        let fingerprint_after_apply = policy_fingerprint(&self.root);
        let initial_ready = !initial_settle_timed_out
            && settled
            && seed_loaded
            && !cancel.is_cancelled()
            && fingerprint_before_seed.is_some()
            && fingerprint_after_apply == fingerprint_before_seed
            && self.refresh_epoch.load(Ordering::Acquire) == refresh_epoch
            && !fresh.watcher.is_unavailable()
            && fresh.watcher.disruption_count() == 0;
        if initial_ready {
            self.status.mark_initial_ready();
        } else {
            self.status.mark_initial_degraded();
        }
        if initial_start && !initial_settle_timed_out {
            self.events.emit(
                CAPTURE_INITIAL_SETTLED_EVENT,
                serde_json::json!({ "workspaceId": self.workspace_id }),
            );
        }
        // Unsafe starts release only here, after the bounded settle attempt.
        // An early import already sent this edge; watch::Sender coalesces it.
        let _ = self.open_ready_tx.send(true);
        if let Some(probe) = &self.apply_probe {
            probe.record_layer_start();
        }
        Ok(fresh)
    }

    async fn tick(&mut self, layer: &FilesLayer, cancel: &CancellationToken) -> TickIo {
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
        let files = layer.files.handle();
        offer_deferred_after_release(
            &self.leases,
            &self.workspace_id,
            &mut self.lease_releases_seen,
            &files,
        )
        .await;
        let run = reconcile_if_dirty_bound(&self.root, &files, cancel.child_token()).await;
        if matches!(
            &run,
            Ok(RootBoundRun {
                run: ReconcileRun::Completed(_),
                ..
            })
        ) && let Some(probe) = &self.apply_probe
        {
            probe.pause_if_armed().await;
        }
        match run {
            // Converged means at quiescence — except with a NON-EMPTY
            // quarantine: the controller
            // parks persistently failing paths on its own degraded-rescan
            // backoff and stops self-forcing scans, so "nothing dirty"
            // coexists with "capture has not recovered" — reading that as
            // clean would clear `degraded` over live failures, and would let
            // a flush claim `settled` over them.
            // Cancelled commits nothing (dirty stays put): teardown is
            // racing this tick, and it must not be mistaken for quiescence.
            Ok(RootBoundRun {
                run: ReconcileRun::Cancelled,
                ..
            }) => TickIo::Cancelled,
            Ok(
                run @ RootBoundRun {
                    run: ReconcileRun::Converged,
                    ..
                },
            ) => {
                if !apply_run(self.apply_context(), layer, run, cancel).await {
                    return TickIo::Applied { clean: false };
                }
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
                let clean = apply_run(self.apply_context(), layer, run, cancel).await;
                // A clean-looking tick with a NON-EMPTY quarantine is not
                // health: the controller parks persistently failing paths on
                // its own degraded-rescan backoff and stops self-forcing
                // scans, so reconcile converges while capture has not
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
                        // The actor died after the reconcile round-trip. An
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

/// Force the oracle-equivalent pre-switch full scan while the caller owns the
/// workspace's [`ApplyGate`]. A fresh files actor is seeded from the active
/// version so deletions are visible, but no watcher is attached: the normal
/// driver remains alive and simply waits at the gate. Degraded listings fail
/// before any safe-subset apply, matching the TypeScript switch path.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn reconcile_full_for_switch(
    root: &Path,
    actor: &ActorHandle,
    workspace_id: &str,
    leases: &LeaseRegistry,
    status: &Arc<DriverStatus>,
    self_writes: &SelfWriteSuppression,
    author_json: Option<String>,
    provenance: CaptureProvenance,
    events: EngineEvents,
    token: CancellationToken,
) -> Result<bool, SwitchReconcileError> {
    if token.is_cancelled() {
        return Err(SwitchReconcileError::Cancelled);
    }
    let seed = manifest_seed(root, actor, workspace_id)
        .await
        .map_err(|_| SwitchReconcileError::Unavailable)?
        .into_scan_seed();
    let captured_root = bind_capture_root(root).map_err(|_| SwitchReconcileError::Unavailable)?;
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
                leases,
                status,
                self_writes,
                author_json,
                provenance,
                events,
                apply_probe: None,
            };
            let applied = apply_bound_run_with_handle(
                context,
                &handle,
                RootBoundRun { captured_root, run },
                &token,
            )
            .await;
            // A new file an editor still holds is not recorded yet, so the
            // switch would leave it behind.
            let deferred = match handle.stats().await {
                Ok(stats) => stats.deferred > 0,
                Err(_) => true,
            };
            if applied && !deferred {
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
    leases: &'a LeaseRegistry,
    status: &'a Arc<DriverStatus>,
    self_writes: &'a SelfWriteSuppression,
    author_json: Option<String>,
    /// Moment provenance stamped on every capture write of this run.
    provenance: CaptureProvenance,
    events: EngineEvents,
    apply_probe: Option<CaptureApplyProbe>,
}

struct CaptureThreadOutcome {
    plan: ReconcilePlan,
    result: CaptureApplyResult,
    policy_held: bool,
    collections: Option<Result<Vec<String>, RuntimeError>>,
    /// Automation claims the captures and the reconciliation committed.
    automation_claims: Vec<dohc_engine_domain::AutomationClaim>,
}

/// TS parity (`reconcile-${createId()}` + "Reconciled offline edits"): one
/// actor-neutral correlation id ties a reconcile pass's per-file moments
/// together as a group without inventing an author.
fn reconcile_provenance() -> CaptureProvenance {
    CaptureProvenance {
        summary: Some("Reconciled offline edits".to_owned()),
        correlation_id: Some(pass_correlation_id("reconcile")),
    }
}

/// One unique correlation id per capture pass (TS ``${prefix}-${createId()}``
/// parity): pid + wall ms + a process counter — unique enough for grouping
/// consecutive moments, which is all history uses it for.
pub(crate) fn pass_correlation_id(prefix: &str) -> String {
    static PASS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let pass = PASS.fetch_add(1, Ordering::Relaxed);
    format!(
        "{prefix}-{:x}-{:x}-{pass:x}",
        std::process::id(),
        wall_now_ms(),
    )
}

/// Bounded `capture.momentRecorded` payload: the renderer needs the ping and
/// enough context to scope a refresh; a huge baseline pass must never blow
/// the wire frame budget.
fn moment_recorded_payload(
    workspace_id: &str,
    applied_paths: &[String],
    not_owned_paths: &[String],
) -> serde_json::Value {
    const MAX_EVENT_PATHS: usize = 32;
    serde_json::json!({
        "workspaceId": workspace_id,
        "appliedCount": applied_paths.len(),
        "notOwnedCount": not_owned_paths.len(),
        "paths": applied_paths
            .iter()
            .chain(not_owned_paths)
            .take(MAX_EVENT_PATHS)
            .collect::<Vec<_>>(),
    })
}

/// Apply one reconcile run through the capture sink and acknowledge it.
///
/// INVARIANT: a prepared plan is always acknowledged — the controller's
/// `outstanding` latch only resets on ack, so an early return that skipped it
/// would wedge every future reconcile into `StaleReconcilePlan` forever. On
/// abnormal paths (version fetch failure, apply-thread spawn failure or
/// panic) the plan is acked with an ALL-FAILED receipt: the latch clears,
/// the paths stay dirty, and the next cycle retries.
async fn apply_run(
    context: ApplyRunContext<'_>,
    layer: &FilesLayer,
    run: RootBoundRun,
    cancel: &CancellationToken,
) -> bool {
    apply_bound_run_with_handle(context, &layer.files.handle(), run, cancel).await
}

async fn apply_bound_run_with_handle(
    context: ApplyRunContext<'_>,
    files: &FilesHandle,
    run: RootBoundRun,
    cancel: &CancellationToken,
) -> bool {
    let ApplyRunContext {
        root,
        actor,
        workspace_id,
        leases,
        status,
        self_writes,
        author_json,
        provenance,
        events,
        apply_probe,
    } = context;
    let now_ms = wall_now_ms();
    let RootBoundRun { captured_root, run } = run;
    let (plan, collection_reconcile_requested) = match run {
        ReconcileRun::Completed(plan) => {
            let requested = status.take_collection_reconcile_request()
                || collection_reconcile_required(root, &plan);
            (plan, requested)
        }
        ReconcileRun::Converged => {
            let adopted_paths = if status.take_collection_reconcile_request() {
                let result = match actor.active_version_id(workspace_id.to_owned()).await {
                    Ok(version_id) => {
                        let collection_actor = actor.clone();
                        let collection_workspace = workspace_id.to_owned();
                        let collection_root = root.to_path_buf();
                        let collection_leases = leases.clone();
                        let collection_self_writes = self_writes.clone();
                        let collection_author_json = author_json.clone();
                        let collection_provenance = provenance.clone();
                        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
                        let thread = std::thread::Builder::new()
                            .name("dohc-capture-collection-reconcile".to_owned())
                            .spawn(move || {
                                let sink = StoreCaptureSink::new(StoreCaptureSinkParams {
                                    actor: collection_actor,
                                    workspace_id: collection_workspace,
                                    version_id,
                                    shadow_root: collection_root,
                                    captured_root: Ok(captured_root),
                                    now_ms,
                                    author_json: collection_author_json,
                                    leases: collection_leases,
                                    self_writes: collection_self_writes,
                                    provenance: collection_provenance,
                                });
                                let reconciled = sink.reconcile_collections();
                                let _ = done_tx.send(
                                    reconciled.map(|paths| (paths, sink.take_automation_claims())),
                                );
                            });
                        match thread {
                            Ok(joiner) => {
                                let outcome =
                                    done_rx.await.unwrap_or(Err(RuntimeError::ActorUnavailable));
                                let _ = tokio::task::spawn_blocking(move || joiner.join()).await;
                                outcome
                            }
                            Err(_) => Err(RuntimeError::ActorUnavailable),
                        }
                    }
                    Err(RuntimeError::Domain(
                        dohc_engine_domain::DomainError::WorkspaceNotFound,
                    )) => Ok((Vec::new(), Vec::new())),
                    Err(error) => Err(error),
                };
                match result {
                    Ok((paths, claims)) => {
                        crate::events::emit_automation_claimed(&events, workspace_id, &claims);
                        paths
                    }
                    Err(_) => {
                        status.request_collection_reconcile();
                        status.mark_degraded();
                        return false;
                    }
                }
            } else {
                Vec::new()
            };
            return match repair_and_materialize_ydoc_recoveries(
                root,
                actor,
                workspace_id,
                self_writes,
                now_ms,
            )
            .await
            {
                Ok(mut recovered_paths) => {
                    recovered_paths.extend(adopted_paths);
                    if !recovered_paths.is_empty() {
                        events.emit(
                            CAPTURE_MOMENT_RECORDED_EVENT,
                            moment_recorded_payload(workspace_id, &recovered_paths, &[]),
                        );
                    }
                    true
                }
                Err(_) => {
                    // The reconcile above already committed these adoptions.
                    // An unrelated repair failure must not drop their event —
                    // the renderer would stay stale on committed state.
                    if !adopted_paths.is_empty() {
                        events.emit(
                            CAPTURE_MOMENT_RECORDED_EVENT,
                            moment_recorded_payload(workspace_id, &adopted_paths, &[]),
                        );
                    }
                    status.mark_degraded();
                    false
                }
            };
        }
        ReconcileRun::Cancelled => return true,
    };
    if apply_probe
        .as_ref()
        .is_some_and(CaptureApplyProbe::fail_before_worker_if_armed)
    {
        if collection_reconcile_requested {
            status.request_collection_reconcile();
        }
        status.mark_degraded();
        ack_all_failed(files, plan, status).await;
        return false;
    }
    // The active version, precisely: only a genuinely uninitialized
    // workspace falls back to "main" (bootstrapped by ensure_main_version).
    // Storage errors and StateCorrupt must not be masked into a silent
    // capture into the wrong version — they fail this run (all-failed ack,
    // retried next cycle) and mark degraded.
    let version_id = match actor.active_version_id(workspace_id.to_owned()).await {
        Ok(version_id) => version_id,
        Err(dohc_engine_runtime::RuntimeError::Domain(
            dohc_engine_domain::DomainError::WorkspaceNotFound,
        )) => "main".to_owned(),
        Err(_) => {
            if collection_reconcile_requested {
                status.request_collection_reconcile();
            }
            status.mark_degraded();
            ack_all_failed(files, plan, status).await;
            return false;
        }
    };
    let apply_actor = actor.clone();
    let apply_root = root.to_path_buf();
    let apply_workspace = workspace_id.to_owned();
    let apply_leases = leases.clone();
    let apply_self_writes = self_writes.clone();
    let version_for_retire = version_id.clone();
    let changed_collection_paths = changed_collection_record_paths(root, &plan);
    // A dedicated plain thread, not spawn_blocking: the sink's blocking actor
    // calls assert they run outside any tokio runtime context, and
    // spawn_blocking threads carry the runtime handle. Each accepted operation
    // finishes before the worker checks cancellation; the unapplied suffix
    // remains dirty for the next reconcile. Joining the thread is the
    // drain-before-close boundary.
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let apply_plan = plan.clone();
    let apply_author_json = author_json.clone();
    let apply_cancel = cancel.clone();
    let apply_captured_root = Arc::clone(&captured_root);
    // The retained-over-cap loop below retires through its own sink; it must
    // carry the same pass provenance or its deletes split the reconcile/fence
    // history group with NULL correlation ids.
    let retire_provenance = provenance.clone();
    let apply_provenance = provenance;
    let apply_thread = std::thread::Builder::new()
        .name("dohc-capture-apply".to_owned())
        .spawn(move || {
            if let Some(probe) = &apply_probe {
                probe.pause_worker_if_armed();
            }
            // A fresh sink per run: the policy snapshot and (lazily loaded)
            // secret key are re-read per reconcile task, matching the TS
            // one-policy-snapshot-per-task rule.
            let mut sink = StoreCaptureSink::new(StoreCaptureSinkParams {
                actor: apply_actor,
                workspace_id: apply_workspace,
                version_id,
                shadow_root: apply_root,
                captured_root: Ok(apply_captured_root),
                now_ms,
                author_json: apply_author_json,
                leases: apply_leases,
                self_writes: apply_self_writes,
                provenance: apply_provenance,
            });
            let result =
                apply_reconcile_plan_cancellable(&apply_plan, &mut sink, &NoFaults, &apply_cancel);
            let collections =
                if result.failed_applies.is_empty() && !result.degraded && result.completed() {
                    let reconcile = if collection_reconcile_requested {
                        Ok(true)
                    } else if changed_collection_paths.is_empty() {
                        Ok(false)
                    } else {
                        sink.collection_record_id_mismatch(changed_collection_paths)
                    };
                    match reconcile {
                        Ok(true) => Some(sink.reconcile_collections()),
                        Ok(false) => None,
                        Err(error) => Some(Err(error)),
                    }
                } else {
                    None
                };
            let _ = done_tx.send(CaptureThreadOutcome {
                plan: apply_plan,
                result,
                policy_held: sink.policy_held(),
                collections,
                automation_claims: sink.take_automation_claims(),
            });
        });
    let applied: Option<CaptureThreadOutcome> = match apply_thread {
        Ok(joiner) => {
            let outcome = done_rx.await.ok();
            let _ = tokio::task::spawn_blocking(move || joiner.join()).await;
            outcome
        }
        Err(_) => None,
    };
    let Some(CaptureThreadOutcome {
        plan,
        mut result,
        policy_held: sink_policy_held,
        collections: collection_result,
        automation_claims,
    }) = applied
    else {
        // Spawn failure or apply-thread panic: the plan must still resolve.
        if collection_reconcile_requested {
            status.request_collection_reconcile();
        }
        status.mark_degraded();
        ack_all_failed(files, plan, status).await;
        return false;
    };
    // Claims are committed whatever else this pass decides: wake the
    // executors now.
    crate::events::emit_automation_claimed(&events, workspace_id, &automation_claims);
    let collection_paths = match collection_result {
        Some(Ok(paths)) => paths,
        Some(Err(_)) => {
            status.request_collection_reconcile();
            result.degraded = true;
            status.mark_degraded();
            Vec::new()
        }
        None => {
            if collection_reconcile_requested {
                // The file apply did not settle, so the relevant transition
                // has not reached collection reconciliation yet.
                status.request_collection_reconcile();
            }
            Vec::new()
        }
    };
    // OVER-CAP + narrowed: a path in the scanner's retained-over-cap set
    // never appears in the diff (CAL-3 keeps it last-known-good, never
    // Retire), so a policy narrow could never reach it through an op. Retire
    // those directly — policy exclusion is an OWNERSHIP decision, distinct
    // from the size-cap false-delete defense that protects still-tracked
    // content.
    // One policy read for the whole loop — a per-path re-read was N disk
    // round-trips for one answer, and could even give different paths a
    // different policy if an edit raced the loop.
    let capture_policy = if plan.retained_over_cap.is_empty() {
        PolicyState::Known(None)
    } else {
        read_capture_policy(root)
    };
    for path in &plan.retained_over_cap {
        let excluded = match &capture_policy {
            PolicyState::Known(policy) => policy_excludes(policy, path),
            // Unknown policy: hold LOUDLY. This loop is the only mechanism
            // that can retire an over-cap narrowed head, so the hold must
            // register as a failure (dirty + degraded) for the recovery
            // rebuild to retry — a silent skip strands the head forever.
            PolicyState::Unavailable => {
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
            let retire_leases = leases.clone();
            let retire_path = path.clone();
            let retire_root = root.to_path_buf();
            let retire_self_writes = self_writes.clone();
            let retire_author_json = author_json.clone();
            let retire_pass_provenance = retire_provenance.clone();
            let retire_captured_root = Arc::clone(&captured_root);
            // A dedicated plain thread, same as the apply above: the sink's
            // blocking actor calls assert they run outside any tokio runtime
            // context, and spawn_blocking threads carry the runtime handle.
            let (retire_tx, retire_rx) = tokio::sync::oneshot::channel();
            let retire_thread = std::thread::Builder::new()
                .name("dohc-capture-overcap-retire".to_owned())
                .spawn(move || {
                    let mut sink = StoreCaptureSink::new(StoreCaptureSinkParams {
                        actor: retire_actor,
                        workspace_id: retire_workspace,
                        version_id: retire_version,
                        shadow_root: retire_root,
                        captured_root: Ok(retire_captured_root),
                        now_ms,
                        author_json: retire_author_json,
                        leases: retire_leases,
                        self_writes: retire_self_writes,
                        provenance: retire_pass_provenance,
                    });
                    let _ = retire_tx.send(sink.retire_policy_excluded(&retire_path));
                });
            let retired = match retire_thread {
                Ok(joiner) => {
                    let outcome = retire_rx.await.ok();
                    let _ = tokio::task::spawn_blocking(move || joiner.join()).await;
                    outcome
                }
                Err(_) => None,
            };
            // This loop is the only path that can retire an over-cap narrowed
            // head (such a path never appears in the diff), so a swallowed
            // failure would strand it stale-but-authoritative with nothing to
            // re-offer it. Surface it so the driver stays degraded and the
            // next tick retries.
            match retired {
                // Report it in the receipt: the manifest must forget a path
                // whose head this loop just deleted, or a later policy widen
                // would diff clean and never re-ingest it.
                Some(Ok(())) => result.not_owned_paths.push(path.clone()),
                // A failed over-cap retire must fail the receipt too: this
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
    if result.failed_applies.is_empty() && !result.degraded && result.completed() {
        match repair_and_materialize_ydoc_recoveries(root, actor, workspace_id, self_writes, now_ms)
            .await
        {
            Ok(recovered_paths) => result.applied_paths.extend(recovered_paths),
            Err(_) => {
                result.degraded = true;
                status.mark_degraded();
            }
        }
    }
    if result.degraded {
        status.mark_degraded();
    }
    // The sink reports its holds directly: a re-read here could miss the
    // very blip that caused the hold (readable again by the time this line
    // runs). The flag comes from the exact decision point instead.
    if sink_policy_held {
        status.arm_policy_hold();
    }
    let clean = result.failed_applies.is_empty() && !result.degraded;
    // One event per settled batch/reconcile pass that settled anything. The
    // domain writes are already durable here, so the announce happens even if
    // the files-layer ack below fails — the renderer must never stay stale over bookkeeping.
    //
    // NOT-OWNED settlements count: several of them append retire/delete
    // moments — a policy-narrowed head ("Stopped tracking by policy"),
    // content that stops being engine-ownable ("Stopped tracking non-text
    // content"), a secret that stops being trackable, and the over-cap
    // retained loop above (which reports its retires via not_owned_paths).
    // Gating on applied_paths alone left the renderer permanently stale for
    // exactly those moments.
    if !result.applied_paths.is_empty()
        || !result.not_owned_paths.is_empty()
        || !collection_paths.is_empty()
    {
        let mut recorded_paths = result.applied_paths.clone();
        recorded_paths.extend(collection_paths);
        events.emit(
            CAPTURE_MOMENT_RECORDED_EVENT,
            moment_recorded_payload(workspace_id, &recorded_paths, &result.not_owned_paths),
        );
    }
    if result.completed() && files.acknowledge_capture(plan, result).await.is_err() {
        status.mark_degraded();
        return false;
    }
    clean
}

async fn repair_and_materialize_ydoc_recoveries(
    root: &Path,
    actor: &ActorHandle,
    workspace_id: &str,
    self_writes: &SelfWriteSuppression,
    now_ms: i64,
) -> Result<Vec<String>, RuntimeError> {
    let recoveries = actor
        .repair_conflicted_ydoc_recoveries(
            workspace_id.to_owned(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await?;
    if recoveries.is_empty() {
        return Ok(Vec::new());
    }
    materialize_ydoc_recoveries(root, actor, workspace_id, self_writes, now_ms, recoveries).await
}

async fn materialize_ydoc_recoveries(
    root: &Path,
    actor: &ActorHandle,
    workspace_id: &str,
    self_writes: &SelfWriteSuppression,
    now_ms: i64,
    recoveries: Vec<dohc_engine_sync::YdocRecoveryMaterialization>,
) -> Result<Vec<String>, RuntimeError> {
    let materialization_job_ids = recoveries
        .iter()
        .map(|recovery| recovery.materialization_job_id.clone())
        .collect();
    actor
        .materialize_replay_selected_for_fence(
            root.to_path_buf(),
            workspace_id.to_owned(),
            Arc::new(self_writes.clone()),
            materialization_job_ids,
            now_ms,
        )
        .await?;
    Ok(recoveries
        .into_iter()
        .map(|recovery| recovery.path)
        .collect())
}

/// A path deferred to a live document session is not in the manifest yet, so
/// the next full scan offers it again. That scan must happen once the session
/// lets go, even when nothing on disk changes: a new file closed without an
/// edit is otherwise never captured. Asks for it when a lease on this
/// workspace was released since the last check and the last run deferred
/// something.
async fn offer_deferred_after_release(
    leases: &LeaseRegistry,
    workspace_id: &str,
    releases_seen: &mut u64,
    files: &FilesHandle,
) {
    let releases = leases.release_generation(workspace_id);
    if releases == *releases_seen {
        return;
    }
    *releases_seen = releases;
    if matches!(files.stats().await, Ok(stats) if stats.deferred > 0) {
        files.request_rescan();
    }
}

/// Resolve a prepared plan whose apply never ran: acknowledge with every op
/// marked failed, clearing the controller's `outstanding` latch while keeping
/// the paths dirty for the next cycle's retry.
async fn ack_all_failed(files: &FilesHandle, plan: ReconcilePlan, status: &Arc<DriverStatus>) {
    let failed: Vec<String> = plan.ops.iter().map(|op| op.path().to_owned()).collect();
    let receipt = CaptureApplyResult {
        applied_paths: Vec::new(),
        captured: Vec::new(),
        not_owned_paths: Vec::new(),
        failed_applies: failed,
        deferred_paths: Vec::new(),
        crashed_after_durable_boundary: None,
        degraded: true,
    };
    if files.acknowledge_capture(plan, receipt).await.is_err() {
        status.mark_degraded();
    }
}

#[cfg(test)]
mod root_bound_run_tests;

#[cfg(test)]
mod collection_reconcile_scheduling_tests;

#[cfg(test)]
mod live_session_deferral_tests;

#[cfg(test)]
mod selected_recovery_replay_tests;
