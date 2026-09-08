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
    // The regression: a watch that dies right after every start used to
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
    // While the failure might still be transient the layer is kept: a
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
    // Health is claimed after the reconcile, not at the watcher check:
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
