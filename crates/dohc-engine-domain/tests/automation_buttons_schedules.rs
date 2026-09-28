//! Button presses and schedule steps claim automations without a record
//! change: a press claims once per press id, joins only its own person's
//! unfinished run of the same button on the same record, and finds its
//! claim after it is forgotten; a schedule claims each due time once behind
//! a mark that only moves forward.

use dohc_engine_domain::{
    AUTOMATION_CHAIN_DEPTH_CAP, AUTOMATION_CHAIN_STOPPED, AUTOMATION_CLAIM_HISTORY_LIMIT,
    AUTOMATION_PRESS_RETENTION_MS, AutomationChangeKind, AutomationClaim, AutomationClaimState,
    AutomationPress, AutomationPressed, AutomationScheduleClaim, AutomationScheduleClaimed,
    AutomationScheduleMark, AutomationSettle, AutomationSubscription, AutomationTrigger,
    ChangeActorKind, DomainError, MAX_AUTOMATION_SCHEDULE_RUNS, NoFaults, PressActor,
    claim_automation_run_now, claim_automation_schedule, claim_next_pending_automation,
    list_automation_schedule_marks, press_automation, retry_automation_claim,
    settle_automation_claim, subscribe_automation,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::{ScratchDir, engine_db_path};

const WS: &str = "ws-buttons-schedules";
const PAY: &str = "collection:Invoices#mark-paid";
const REMIND: &str = "collection:Invoices#send-reminder";
const REPORT: &str = "collection:Invoices#weekday-report";
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const INVOICE: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_INVOICE: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADA: &str = "user:ada";
const BO: &str = "user:bo";

fn open_store(scratch: &ScratchDir) -> EngineStore {
    let db = engine_db_path(scratch).expect("engine db path");
    EngineStore::open(&db, 1).expect("open store")
}

fn press_on(
    store: &mut EngineStore,
    automation_id: &str,
    pressed_by: &str,
    press_id: &str,
    record_id: &str,
    now_ms: i64,
) -> Result<AutomationPressed, DomainError> {
    press_automation(
        store,
        WS,
        &AutomationPress {
            press_id: press_id.to_owned(),
            automation_id: automation_id.to_owned(),
            record_id: record_id.to_owned(),
            pressed_by: pressed_by.to_owned(),
            by: PressActor::Human,
        },
        now_ms,
        &NoFaults,
    )
}

fn press_as(
    store: &mut EngineStore,
    pressed_by: &str,
    press_id: &str,
    record_id: &str,
    now_ms: i64,
) -> Result<AutomationPressed, DomainError> {
    press_on(store, PAY, pressed_by, press_id, record_id, now_ms)
}

fn press(
    store: &mut EngineStore,
    press_id: &str,
    record_id: &str,
    now_ms: i64,
) -> Result<AutomationPressed, DomainError> {
    press_as(store, ADA, press_id, record_id, now_ms)
}

fn claimed(pressed: AutomationPressed) -> AutomationClaim {
    match pressed {
        AutomationPressed::Claimed(claim) => claim,
        other => panic!("expected a new claim, got {other:?}"),
    }
}

fn joined(pressed: AutomationPressed) -> AutomationClaim {
    match pressed {
        AutomationPressed::Joined(claim) => claim,
        other => panic!("expected to join, got {other:?}"),
    }
}

/// Serve and settle the oldest pending Collection claim.
fn run(store: &mut EngineStore, settle: AutomationSettle, now_ms: i64) -> AutomationClaim {
    let (claim, _) = claim_next_pending_automation(store, WS, "collection:", now_ms, &NoFaults)
        .expect("claim next")
        .expect("a pending claim");
    settle_automation_claim(store, WS, &claim.claim_id, &settle, now_ms, &NoFaults).expect("settle")
}

fn schedule(
    store: &mut EngineStore,
    hash: &str,
    run: &[i64],
    through_ms: i64,
) -> Result<AutomationScheduleClaimed, DomainError> {
    claim_automation_schedule(
        store,
        WS,
        &AutomationScheduleClaim {
            automation_id: REPORT.to_owned(),
            schedule_hash: hash.to_owned(),
            run: run.to_vec(),
            through_ms,
        },
        through_ms,
        &NoFaults,
    )
}

fn mark(hash: &str, through_ms: i64) -> AutomationScheduleMark {
    AutomationScheduleMark {
        automation_id: REPORT.to_owned(),
        schedule_hash: hash.to_owned(),
        through_ms,
    }
}

fn claim_exists(store: &EngineStore, claim_id: &str) -> bool {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM automation_claims WHERE claim_id = ?1)",
                [claim_id],
                |row| row.get(0),
            )
        })
        .expect("read claim")
}

fn press_rows(store: &EngineStore) -> i64 {
    store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM automation_presses", [], |row| {
                row.get(0)
            })
        })
        .expect("count presses")
}

#[test]
fn a_press_claims_once_and_joins_an_unfinished_run_of_its_button() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);

    let first = claimed(press(&mut store, "press-1", INVOICE, 10).expect("press"));
    assert_eq!(
        first.trigger,
        AutomationTrigger::Key {
            key: "press:press-1".to_owned()
        }
    );
    assert_eq!(first.record_id.as_deref(), Some(INVOICE));
    assert_eq!(first.collection_path, "Invoices");
    assert_eq!(first.depth, 0);
    assert_eq!(first.change.kind, AutomationChangeKind::Button);
    assert_eq!(first.change.actor_kind, Some(ChangeActorKind::Human));
    assert_eq!(first.change.on_behalf_of.as_deref(), Some(ADA));
    assert_eq!(first.state, AutomationClaimState::Pending);

    // The same press sent again, a double click, and a press in another
    // window all run once.
    let resent = joined(press(&mut store, "press-1", INVOICE, 11).expect("resend"));
    assert_eq!(resent.claim_id, first.claim_id);
    let double = joined(press(&mut store, "press-2", INVOICE, 12).expect("double click"));
    assert_eq!(double.claim_id, first.claim_id);
    let other = claimed(press(&mut store, "press-3", OTHER_INVOICE, 13).expect("other record"));
    assert_ne!(other.claim_id, first.claim_id);

    // A running claim still takes presses; a finished one does not.
    let (running, _) = claim_next_pending_automation(&mut store, WS, "collection:", 14, &NoFaults)
        .expect("claim next")
        .expect("pending");
    assert_eq!(running.claim_id, first.claim_id);
    let during = joined(press(&mut store, "press-4", INVOICE, 15).expect("while running"));
    assert_eq!(during.claim_id, first.claim_id);
    settle_automation_claim(
        &mut store,
        WS,
        &first.claim_id,
        &AutomationSettle::Done,
        16,
        &NoFaults,
    )
    .expect("settle");
    let next = claimed(press(&mut store, "press-5", INVOICE, 17).expect("after the run"));
    assert_ne!(next.claim_id, first.claim_id);
    let remembered = joined(press(&mut store, "press-1", INVOICE, 18).expect("remembered"));
    assert_eq!(remembered.claim_id, first.claim_id);
    assert_eq!(remembered.state, AutomationClaimState::Done);

    assert!(matches!(
        press(&mut store, "press-1", OTHER_INVOICE, 19),
        Err(DomainError::InvalidInput { .. })
    ));
    let malformed = press_automation(
        &mut store,
        WS,
        &AutomationPress {
            press_id: "press-6".to_owned(),
            automation_id: "collection:triage".to_owned(),
            record_id: INVOICE.to_owned(),
            pressed_by: ADA.to_owned(),
            by: PressActor::Human,
        },
        20,
        &NoFaults,
    );
    assert!(matches!(malformed, Err(DomainError::InvalidInput { .. })));
}

/// An agent's press for a person, at its run's depth.
fn agent_press(
    store: &mut EngineStore,
    press_id: &str,
    record_id: &str,
    depth: u32,
    now_ms: i64,
) -> Result<AutomationPressed, DomainError> {
    press_automation(
        store,
        WS,
        &AutomationPress {
            press_id: press_id.to_owned(),
            automation_id: PAY.to_owned(),
            record_id: record_id.to_owned(),
            pressed_by: ADA.to_owned(),
            by: PressActor::Agent {
                origin_id: "dohc-mcp".to_owned(),
                depth,
            },
        },
        now_ms,
        &NoFaults,
    )
}

#[test]
fn an_agents_press_claims_for_its_person_at_its_runs_depth_and_stops_at_the_cap() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);

    let pressed = claimed(agent_press(&mut store, "press-1", INVOICE, 2, 10).expect("press"));
    assert_eq!(pressed.depth, 2);
    assert_eq!(pressed.change.actor_kind, Some(ChangeActorKind::Agent));
    assert_eq!(pressed.change.author_origin_id.as_deref(), Some("dohc-mcp"));
    // The run acts for the person, so only their presses join it.
    assert_eq!(pressed.change.on_behalf_of.as_deref(), Some(ADA));
    assert_eq!(pressed.state, AutomationClaimState::Pending);
    let theirs = joined(press(&mut store, "press-2", INVOICE, 11).expect("the person's press"));
    assert_eq!(theirs.claim_id, pressed.claim_id);

    // At the cap the press stops at once, as a record change at the cap does.
    let stopped = claimed(
        agent_press(
            &mut store,
            "press-3",
            OTHER_INVOICE,
            AUTOMATION_CHAIN_DEPTH_CAP,
            12,
        )
        .expect("press at the cap"),
    );
    assert_eq!(stopped.state, AutomationClaimState::Failed);
    assert_eq!(stopped.error.as_deref(), Some(AUTOMATION_CHAIN_STOPPED));
    assert_eq!(stopped.attempts, 0);
    // A depth past the cap counts as the cap.
    let past = claimed(
        agent_press(
            &mut store,
            "press-4",
            OTHER_INVOICE,
            AUTOMATION_CHAIN_DEPTH_CAP + 3,
            13,
        )
        .expect("press past the cap"),
    );
    assert_eq!(past.depth, AUTOMATION_CHAIN_DEPTH_CAP);
    assert_eq!(past.state, AutomationClaimState::Failed);
}

#[test]
fn another_persons_press_never_joins_a_claim_that_acts_for_someone_else() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    let adas = claimed(press(&mut store, "press-ada", INVOICE, 10).expect("Ada presses"));
    let presses = press_rows(&store);

    assert_eq!(
        press_as(&mut store, BO, "press-bo", INVOICE, 11).expect("Bo presses"),
        AutomationPressed::Busy
    );
    assert_eq!(press_rows(&store), presses, "a busy press records nothing");
    assert!(
        matches!(
            press_as(&mut store, BO, "press-ada", INVOICE, 12),
            Err(DomainError::InvalidInput { .. })
        ),
        "Ada's press id is not Bo's"
    );

    run(&mut store, AutomationSettle::Done, 13);
    let bos = claimed(press_as(&mut store, BO, "press-bo", INVOICE, 14).expect("Bo again"));
    assert_ne!(bos.claim_id, adas.claim_id);
    assert_eq!(bos.change.on_behalf_of.as_deref(), Some(BO));
}

#[test]
fn a_failed_press_retries_only_when_its_button_is_idle() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    let first = claimed(press(&mut store, "press-1", INVOICE, 10).expect("press"));
    run(
        &mut store,
        AutomationSettle::Failed {
            error: "the dataset host is offline".to_owned(),
        },
        11,
    );
    let second = claimed(press(&mut store, "press-2", INVOICE, 12).expect("press again"));
    assert_ne!(second.claim_id, first.claim_id);
    assert!(matches!(
        retry_automation_claim(&mut store, WS, &first.claim_id, 13, &NoFaults),
        Err(DomainError::InvalidInput { .. })
    ));
    run(&mut store, AutomationSettle::Done, 14);
    retry_automation_claim(&mut store, WS, &first.claim_id, 15, &NoFaults)
        .expect("an idle button retries");
}

#[test]
fn a_press_finds_its_claim_while_remembered_or_while_its_key_remains() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    let pressed = claimed(press(&mut store, "press-1", INVOICE, 10).expect("press"));
    run(&mut store, AutomationSettle::Done, 11);

    // More done claims for the same automation than the history keeps.
    let mut newest = None;
    for index in 0..=AUTOMATION_CLAIM_HISTORY_LIMIT {
        let press_id = format!("press-later-{index}");
        claimed(press(&mut store, &press_id, OTHER_INVOICE, 20 + index).expect("later press"));
        newest = Some((
            press_id,
            run(&mut store, AutomationSettle::Done, 20 + index),
        ));
    }
    let (newest_press, newest_claim) = newest.expect("a later press");
    assert!(
        claim_exists(&store, &pressed.claim_id),
        "a remembered press keeps its claim"
    );
    let remembered = joined(press(&mut store, "press-1", INVOICE, 500).expect("resend"));
    assert_eq!(remembered.claim_id, pressed.claim_id);

    // Past the retention, the next press forgets the old ones. A forgotten
    // press whose claim remains still finds it, for the same person only.
    let later = 10 + AUTOMATION_PRESS_RETENTION_MS + 1_000;
    claimed(press(&mut store, "press-after", OTHER_INVOICE, later).expect("press"));
    let found = joined(press(&mut store, &newest_press, OTHER_INVOICE, later + 1).expect("resend"));
    assert_eq!(found.claim_id, newest_claim.claim_id);
    assert!(matches!(
        press_as(&mut store, BO, "press-later-99", OTHER_INVOICE, later + 2),
        Err(DomainError::InvalidInput { .. })
    ));

    // The next settle prunes the forgotten claims; then the old id presses
    // anew.
    run(&mut store, AutomationSettle::Done, later + 3);
    assert!(!claim_exists(&store, &pressed.claim_id));
    claimed(press(&mut store, "press-1", INVOICE, later + 4).expect("a forgotten press id"));
}

#[test]
fn a_forgotten_press_id_is_refused_on_another_button() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    let paid = claimed(press(&mut store, "press-1", INVOICE, 10).expect("press"));
    run(&mut store, AutomationSettle::Done, 11);

    let later = 10 + AUTOMATION_PRESS_RETENTION_MS + 1_000;
    claimed(press(&mut store, "press-forget", OTHER_INVOICE, later).expect("press"));
    assert!(
        matches!(
            press_on(&mut store, REMIND, ADA, "press-1", INVOICE, later + 1),
            Err(DomainError::InvalidInput { .. })
        ),
        "another button is refused, not run"
    );
    let found = joined(press(&mut store, "press-1", INVOICE, later + 2).expect("resend"));
    assert_eq!(found.claim_id, paid.claim_id);
}

#[test]
fn a_schedule_claims_each_due_time_once_behind_a_forward_mark() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);

    assert!(
        matches!(
            schedule(&mut store, "weekdays-9", &[1_000], 2_000),
            Err(DomainError::InvalidInput { .. })
        ),
        "a new schedule sets its mark first"
    );
    assert_eq!(
        schedule(&mut store, "weekdays-9", &[], 1_000).expect("start"),
        AutomationScheduleClaimed {
            claims: Vec::new(),
            mark: mark("weekdays-9", 1_000),
        }
    );
    for (run, through_ms) in [
        (&[1_000][..], 2_000),
        (&[2_500][..], 2_000),
        (&[1_500][..], 900),
    ] {
        assert!(
            matches!(
                schedule(&mut store, "weekdays-9", run, through_ms),
                Err(DomainError::InvalidInput { .. })
            ),
            "{run:?} through {through_ms}"
        );
    }
    // A clock set back runs nothing and answers the stored mark.
    assert_eq!(
        schedule(&mut store, "weekdays-9", &[], 900).expect("resync"),
        AutomationScheduleClaimed {
            claims: Vec::new(),
            mark: mark("weekdays-9", 1_000),
        }
    );
    let over = (0..=MAX_AUTOMATION_SCHEDULE_RUNS as i64)
        .map(|index| 1_001 + index)
        .collect::<Vec<_>>();
    assert!(matches!(
        schedule(&mut store, "weekdays-9", &over, 5_000),
        Err(DomainError::InvalidInput { .. })
    ));

    let stepped = schedule(&mut store, "weekdays-9", &[1_500, 2_000], 2_000).expect("run");
    assert_eq!(stepped.mark, mark("weekdays-9", 2_000));
    let claims = stepped.claims;
    assert_eq!(claims.len(), 2);
    assert_eq!(
        claims[0].trigger,
        AutomationTrigger::Key {
            key: "schedule:1500".to_owned()
        }
    );
    assert_eq!(claims[0].record_id, None);
    assert_eq!(claims[0].collection_path, "Invoices");
    assert_eq!(claims[0].change.kind, AutomationChangeKind::Schedule);
    assert_eq!(claims[0].change.actor_kind, None);
    assert_eq!(claims[0].depth, 0);
    assert!(matches!(
        schedule(&mut store, "weekdays-9", &[2_000], 3_000),
        Err(DomainError::InvalidInput { .. })
    ));
    assert_eq!(
        list_automation_schedule_marks(&store, WS).expect("marks"),
        vec![mark("weekdays-9", 2_000)]
    );

    // A changed schedule starts over, and a change back cannot claim a due
    // time twice.
    assert!(matches!(
        schedule(&mut store, "weekdays-10", &[3_000], 3_000),
        Err(DomainError::InvalidInput { .. })
    ));
    schedule(&mut store, "weekdays-10", &[], 1_200).expect("restart");
    schedule(&mut store, "weekdays-9", &[], 1_200).expect("change back");
    assert_eq!(
        schedule(&mut store, "weekdays-9", &[1_500], 1_600)
            .expect("repeat")
            .claims,
        Vec::new()
    );
}

#[test]
fn a_done_schedule_claim_keeps_its_key_past_the_history() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    schedule(&mut store, "hourly", &[], 0).expect("start");
    let first_hundred = (1..=100).collect::<Vec<i64>>();
    let first = schedule(&mut store, "hourly", &first_hundred, 100)
        .expect("run 100")
        .claims;
    schedule(&mut store, "hourly", &[101], 101).expect("run one more");
    for step in 0..=AUTOMATION_CLAIM_HISTORY_LIMIT {
        run(&mut store, AutomationSettle::Done, 200 + step);
    }
    assert!(
        claim_exists(&store, &first[0].claim_id),
        "the oldest schedule claim keeps its key"
    );

    // A reset mark that reaches the same due time again claims nothing.
    schedule(&mut store, "daily", &[], 0).expect("change");
    schedule(&mut store, "hourly", &[], 0).expect("change back");
    assert_eq!(
        schedule(&mut store, "hourly", &[1], 1)
            .expect("repeat")
            .claims,
        Vec::new()
    );
}

#[test]
fn a_done_schedule_claim_goes_once_it_is_30_days_behind_the_mark() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    schedule(&mut store, "daily", &[], 0).expect("start");
    let mut claims = Vec::new();
    for due_ms in 1..=100 {
        claims.extend(
            schedule(&mut store, "daily", &[due_ms], due_ms)
                .expect("run")
                .claims,
        );
    }
    schedule(&mut store, "daily", &[101], 40 * DAY_MS).expect("run later");
    for step in 0..=AUTOMATION_CLAIM_HISTORY_LIMIT {
        run(&mut store, AutomationSettle::Done, 40 * DAY_MS + step);
    }
    assert!(
        !claim_exists(&store, &claims[0].claim_id),
        "past the history and 30 days behind the mark"
    );
    assert!(
        claim_exists(&store, &claims[1].claim_id),
        "within the history"
    );
}

#[test]
fn a_record_subscription_cannot_name_buttons_or_schedules() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    for kind in [AutomationChangeKind::Button, AutomationChangeKind::Schedule] {
        let refused = subscribe_automation(
            &mut store,
            WS,
            &AutomationSubscription {
                automation_id: PAY.to_owned(),
                prefix: "Invoices".to_owned(),
                kinds: vec![kind],
                fields: None,
            },
            10,
            &NoFaults,
        );
        assert!(
            matches!(refused, Err(DomainError::InvalidInput { .. })),
            "{kind:?}"
        );
    }
}

#[test]
fn run_now_claims_once_per_notice_without_a_record() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    let notice = "schedule-skipped:ws:collection:Invoices#weekday-report:1000";

    let first = claim_automation_run_now(&mut store, WS, REPORT, notice, 5_000, &NoFaults)
        .expect("run now");
    assert!(first.inserted);
    let claim = first.claim;
    assert_eq!(claim.automation_id, REPORT);
    assert_eq!(claim.record_id, None);
    assert_eq!(claim.depth, 0);
    assert_eq!(claim.change.kind, AutomationChangeKind::Schedule);
    assert_eq!(
        claim.trigger,
        AutomationTrigger::Key {
            key: format!("run-now:{notice}")
        }
    );
    let again =
        claim_automation_run_now(&mut store, WS, REPORT, notice, 6_000, &NoFaults).expect("again");
    assert!(!again.inserted, "the same notice claims once");
    assert_eq!(again.claim, claim, "a repeat answers the claim it made");
    assert!(
        claim_automation_run_now(
            &mut store,
            WS,
            REPORT,
            &format!("{notice}0"),
            6_000,
            &NoFaults
        )
        .expect("another notice")
        .inserted
    );
    for (automation, notice) in [("plugin/report", notice), (REPORT, " ")] {
        assert!(
            matches!(
                claim_automation_run_now(&mut store, WS, automation, notice, 7_000, &NoFaults),
                Err(DomainError::InvalidInput { .. })
            ),
            "{automation} {notice:?}"
        );
    }
}

#[test]
fn a_done_run_now_claim_keeps_its_key_after_schedule_claims_age_out() {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = open_store(&scratch);
    let notice = "schedule-skipped:ws:collection:Invoices#weekday-report:1";
    schedule(&mut store, "daily", &[], 0).expect("start");
    let ran = claim_automation_run_now(&mut store, WS, REPORT, notice, 1, &NoFaults)
        .expect("run now")
        .claim;
    run(&mut store, AutomationSettle::Done, 2);
    schedule(&mut store, "daily", &[40 * DAY_MS], 40 * DAY_MS).expect("run later");
    for step in 0..=AUTOMATION_CLAIM_HISTORY_LIMIT {
        schedule(
            &mut store,
            "daily",
            &[40 * DAY_MS + 1 + step],
            40 * DAY_MS + 1 + step,
        )
        .expect("run");
        run(&mut store, AutomationSettle::Done, 40 * DAY_MS + step);
    }
    assert!(
        claim_exists(&store, &ran.claim_id),
        "a run-now key is not a due time"
    );
    let again = claim_automation_run_now(&mut store, WS, REPORT, notice, 50 * DAY_MS, &NoFaults)
        .expect("again");
    assert!(!again.inserted);
    assert_eq!(again.claim.claim_id, ran.claim_id);
}
