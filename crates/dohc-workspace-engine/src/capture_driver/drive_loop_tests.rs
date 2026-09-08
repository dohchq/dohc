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
    /// The reconcile is cancelled mid-scan (teardown racing the tick).
    CancelledTick,
    HealthyButDirtyApply,
    /// A healthy tick during which the watcher records one more
    /// disruption (backend error / root-identity blip that re-attached).
    Disrupted,
    /// The root's policy fingerprint differs from the layer's.
    PolicyChanged,
    /// The fingerprint differs and the tick converges — the exact pass
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
    /// `status.degraded` / `status.running` sampled during each tick —
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
    /// entry becomes visible at the next pass's check — like a real
    /// watcher whose events land between polls.
    emitted: u64,
    /// The real `apply_run` marks the driver degraded when an apply
    /// fails; the fake mirrors that, or a test asserting on degradation
    /// would only be testing the fake.
    status: Arc<DriverStatus>,
}

impl FakeEnv {
    fn new(script: Vec<Script>, journal: Arc<Mutex<Journal>>, status: Arc<DriverStatus>) -> Self {
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
    /// The script entry governing the current pass; the last entry repeats
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
        // Adopt the current fingerprint, as RealEnv does (it reads the
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
                // Fidelity: while the policy is unknown the sink holds
                // its ops (POLICY_UNAVAILABLE), so the apply reports
                // failures — the tick is degraded, not clean.
                self.status.mark_degraded();
                TickIo::Applied { clean: false }
            }
            Script::Disrupted => {
                // The disruption lands during this tick's window; the
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
async fn a_timed_out_initial_apply_waits_for_a_healthy_tick_to_claim_running() {
    let (handle, cancel, journal, status, _flush_tx) = spawn_loop(vec![Script::Healthy]);
    status.mark_initial_apply_timed_out();

    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    let running_during_first_tick = journal
        .lock()
        .expect("journal")
        .running_seen
        .first()
        .copied();

    assert_eq!(
        running_during_first_tick,
        Some(false),
        "the successful start must preserve the timeout's not-running claim"
    );
    assert!(
        status.running(),
        "the first healthy tick must recover the running claim"
    );

    cancel.cancel();
    handle.await.expect("driver loop");
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
    // The regression this shard exists for. The layer starts fine every
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
    // ...and not just at the end: each recovery probe starts a layer that
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
        // Long enough to escalate to terminal (~31s) and wait out one
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
    // `watch_degraded` is sticky for the life of the layer, so folding it
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
    // fingerprint must hold for a tick before it costs one.
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
    // The counter seam exists for exactly this: a sticky bool can be
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
    // A fresh watcher counts from zero. If the loop kept the old layer's
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
    // during sample 4's tick and is reported at sample 5.
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
    // A transiently-locked policy file must hold the debounce, not feed
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
    // While the policy is unreadable the sink holds ops; the failures
    // land in the quarantine and stop self-forcing scans. If the policy
    // then recovers with the same bytes, the equality branch never
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
    // A cancelled reconcile commits nothing (dirty stays put), so a
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
    // Pass 1 sees a new policy fingerprint for the first time (debounce
    // arms) and the tick converges — without the guard, the flush would
    // certify deterministic ownership state the very pass before the
    // rebuild/re-offer runs. It must answer settled:false until the
    // debounce confirms and the rebuild completes.
    // Pass 1 (Idle) builds the layer under the original policy — the
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
        // Flush 2 fires immediately so it drives the confirm/rebuild
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
    // at its poll rate (each early pass would rebuild hot) nor push the
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
