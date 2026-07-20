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
    CancellationToken, CaptureApplyResult, CaptureSink, FilesActor, FilesError, ManifestEntry,
    NativeWatcher, ReconcilePlan, ReconcileRun, ScanBounds, ScanGeneration, ScanManifest,
    apply_reconcile_plan,
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

/// Observable driver state for the E-shard `watcher.status` RPC and tests.
#[derive(Default)]
pub(crate) struct DriverStatus {
    /// The files layer (actor + watcher + loop) is up and driving.
    running: AtomicBool,
    /// The watcher reported degradation or permanent loss, a reconcile or
    /// apply failed, or the files layer could not (re)start. Sticky until a
    /// clean (re)start of the layer.
    degraded: AtomicBool,
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
    loop {
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
                    status.degraded.store(false, Ordering::Release);
                    apply_run(&root, &actor, &workspace_id, &fresh, initial, &status).await;
                    layer = Some(fresh);
                }
                Err(_) => {
                    // Transient start failures (momentarily unwatchable root)
                    // must not be terminal: mark degraded and retry next tick.
                    status.running.store(false, Ordering::Release);
                    status.degraded.store(true, Ordering::Release);
                }
            }
            // Whether the baseline applied or the start failed, the open
            // barrier releases: the workspace opens (possibly degraded), and
            // callers' first writes are ordered AFTER the startup capture.
            let _ = baseline_tx.send(true);
        }

        tokio::select! {
            biased;
            () = cancel.cancelled() => break,
            () = tokio::time::sleep(DRIVE_INTERVAL) => {}
        }

        let Some(current) = layer.as_ref() else {
            continue;
        };

        // Surface watcher health (the watch.rs composition contract: a
        // silently-dead OS watch must never stay silent at this layer). A
        // PERMANENTLY lost watch tears the layer down for the next-tick
        // restart — NativeWatcher::start re-seeds via its initial reconcile,
        // so no change is lost across the gap.
        if current.watcher.is_unavailable() {
            status.degraded.store(true, Ordering::Release);
            if let Some(dead) = layer.take() {
                dead.stop().await;
            }
            status.running.store(false, Ordering::Release);
            continue;
        }
        if current.watcher.is_degraded() {
            status.degraded.store(true, Ordering::Release);
        }

        // Policy-flip re-offer: a changed files.toml/visibility.toml respawns
        // the layer with an EMPTY manifest so every path re-offers through
        // the sink (narrowed paths retire, widened paths re-ingest).
        let fingerprint = policy_fingerprint(&root);
        if fingerprint != current.policy_fingerprint {
            if let Some(old) = layer.take() {
                old.stop().await;
            }
            // The next iteration restarts from the REHYDRATED manifest, not
            // an empty one: an empty baseline cannot emit a Retire for a
            // path deleted from disk in the same window as the policy edit
            // (it appears in neither the listing nor the manifest). The
            // rehydrated seed re-offers narrowed paths through the sink's
            // policy branch (retire) and still diffs offline deletes as
            // removed, so both converge.
            status.running.store(false, Ordering::Release);
            continue;
        }

        let run = current
            .files
            .handle()
            .reconcile_if_dirty(cancel.child_token())
            .await;
        match run {
            Ok(run) => {
                apply_run(&root, &actor, &workspace_id, current, run, &status).await;
            }
            Err(FilesError::ActorUnavailable) => {
                // The files actor died: drop the layer and restart next tick.
                status.degraded.store(true, Ordering::Release);
                if let Some(dead) = layer.take() {
                    dead.stop().await;
                }
                status.running.store(false, Ordering::Release);
            }
            Err(_) => {
                status.degraded.store(true, Ordering::Release);
            }
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
) {
    let plan = match run {
        ReconcileRun::Completed(plan) => plan,
        ReconcileRun::Converged | ReconcileRun::Cancelled => return,
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
            return;
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
    let Some((plan, result)) = applied else {
        // Spawn failure or apply-thread panic: the plan must still resolve.
        status.degraded.store(true, Ordering::Release);
        ack_all_failed(layer, plan, status).await;
        return;
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
                sink.retire(&retire_path)
            })
            .await;
            // This loop is the ONLY path that can retire an over-cap narrowed
            // head (such a path never appears in the diff), so a swallowed
            // failure would strand it stale-but-authoritative with nothing to
            // re-offer it. Surface it so the driver stays degraded and the
            // next tick retries.
            if !matches!(retired, Ok(Ok(()))) {
                status.degraded.store(true, Ordering::Release);
            }
        }
    }
    if result.degraded {
        status.degraded.store(true, Ordering::Release);
    }
    if result.completed()
        && layer
            .files
            .handle()
            .acknowledge_capture(plan, result)
            .await
            .is_err()
    {
        status.degraded.store(true, Ordering::Release);
    }
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
