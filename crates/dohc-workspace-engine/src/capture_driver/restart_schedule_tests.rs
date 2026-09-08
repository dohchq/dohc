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
    // accidentally make a later failure retry sooner than an earlier one.
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
    // The terminal probe must be distinguishable from the capped backoff,
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
