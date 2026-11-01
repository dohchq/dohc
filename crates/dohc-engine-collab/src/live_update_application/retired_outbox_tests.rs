/// Each outbox of the document by path and selectors, with its state,
/// quarantine reason and observed binding.
type OutboxState = (String, String, String, Option<String>, Option<LiveObjectBinding>);

/// [`OutboxState`] as stored, its observed binding still JSON.
type OutboxRow = (String, String, String, Option<String>, Option<String>);

fn outbox_states(f: &Fixture) -> Vec<OutboxState> {
    let rows: Vec<OutboxRow> = f
        .store
        .read_with(|conn| {
            conn.prepare(
                "SELECT current_path,selector_paths_json,state,quarantine_reason,observed_binding_json
                 FROM owner_ydoc_outboxes ORDER BY current_path,selector_paths_json",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();
    rows.into_iter()
        .map(|(path, selectors, state, reason, observed)| {
            (path, selectors, state, reason, observed.map(|json| serde_json::from_str(&json).unwrap()))
        })
        .collect()
}

/// The fixture's binding, at `path`.
fn binding_at(f: &Fixture, path: &str) -> LiveObjectBinding {
    LiveObjectBinding { current_path: path.into(), selector_paths: vec![path.into()], ..f.binding.clone() }
}

/// An open outbox's state at `path`.
fn open_at(path: &str) -> OutboxState {
    (path.into(), format!("[\"{path}\"]"), "active".into(), None, None)
}

/// An outbox at `path` that a successor at `observed` retired.
fn retired_at(path: &str, observed: LiveObjectBinding) -> OutboxState {
    (path.into(), format!("[\"{path}\"]"), "quarantined".into(), Some(SUCCESSION_RETIRED.into()), Some(observed))
}

/// Every entry of the outbox at `path`, as it is stored.
fn entries_at(f: &Fixture, path: &str) -> Vec<String> {
    query_rows(
        f,
        &format!(
            "SELECT e.* FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o USING(outbox_id)
             WHERE o.current_path='{path}' ORDER BY e.sequence"
        ),
    )
}

/// P's own update, applied at 3, is covered when it releases, and nothing
/// is Carried; its outbox at owner.md holds that one entry. The document is
/// back with its file at the local text, which accepted history at 3 holds
/// whole, so a successor needs no seed.
fn released_covered() -> Fixture {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let covered = native_tail_edit(&mut f, "# Covered\n", 11);
    native_tail_apply(&mut f, covered.update.clone(), covered.delivery_id.clone(), 3);
    let covered = receipt_of(&covered.delivery_id, &covered.update_digest, 3);
    acknowledge_entry(&mut f, &covered);
    host_document(&mut f, true, true);
    retirement_settle(&mut f, 10, Some(covered)).unwrap();
    release_parked(&mut f);
    importable(&mut f);
    returned(&mut f);
    file_matches_local(&mut f, "returned");
    f
}

/// A released predecessor, with C1 and C2 Carried when `seeded`, and with
/// nothing Carried and no seed to send otherwise.
fn released(seeded: bool) -> Fixture {
    if seeded {
        released_carrying_twice(6).0
    } else {
        released_covered()
    }
}

/// An empty open outbox at `path` and `selectors`, of P's lineage and
/// generation, as `id`.
fn extra_outbox(f: &mut Fixture, id: &str, path: &str, selectors: &[&str]) {
    write(
        f,
        &format!(
            "CREATE TEMP TABLE extra AS SELECT * FROM owner_ydoc_outboxes WHERE current_path='owner.md';
             UPDATE extra SET outbox_id='{id}',current_path='{path}',selector_paths_json='{}',state='active',
               next_sequence=1,pending_bytes=0,oldest_entry_at_ms=NULL,pending_entry_count=0,
               quarantine_reason=NULL,observed_binding_json=NULL;
             INSERT INTO owner_ydoc_outboxes SELECT * FROM extra;
             DROP TABLE extra",
            serde_json::to_string(selectors).unwrap()
        ),
    );
}

/// Opus's blocker on 4b3a and Sol's ruling (a): a successor renamed away
/// from its predecessor's outbox retires it in its adoption, seeded or not.
/// The old outbox keeps every entry, and names the successor's binding; the
/// successor's outbox is the generation's one open outbox.
#[test]
fn a_renamed_succession_retires_the_outbox_it_covered() {
    for seeded in [true, false] {
        let mut f = released(seeded);
        let kept = entries_at(&f, "owner.md");
        rename(&mut f, "notes/renamed.md", "renamed");
        let id = successor(&mut f);
        f.adopt().unwrap();
        assert_eq!(
            outbox_states(&f),
            vec![open_at("notes/renamed.md"), retired_at("owner.md", f.binding.clone())],
            "seeded: {seeded}"
        );
        assert_eq!(entries_at(&f, "owner.md"), kept, "seeded: {seeded}");
        let seeded_by: Vec<_> = seeds(&f).into_iter().filter(|(activation, _)| *activation == id).collect();
        assert_eq!(seeded_by, if seeded { vec![(id, 1)] } else { vec![] }, "seeded: {seeded}");
    }
}

/// Sol's acceptance test 2: after the renamed succession, a later native edit
/// joins the successor's outbox, which the relay reads and acknowledges. Its
/// delivery ID is the one the relay derives from that outbox, sequence and
/// digest, as the shared vector pins in both languages.
#[test]
fn a_successors_later_edit_is_delivered_from_its_outbox() {
    assert_eq!(
        owner_outbox::delivery_id("actual-outbox", 2, &"c".repeat(64)),
        "owner-delivery-c9d123ecd57e191bbb1f55a3eb45488d05a36bbef55727702cffb5711ed7a37b"
    );
    for seeded in [true, false] {
        let mut f = released(seeded);
        rename(&mut f, "notes/renamed.md", "renamed");
        successor(&mut f);
        f.adopt().unwrap();
        if seeded {
            accept_seed(&mut f, 7);
        }
        let outbox = outbox_at(&f, "notes/renamed.md");
        let edit = native_tail_edit(&mut f, "# After adoption\n", 20);
        let sequence = if seeded { 2 } else { 1 };
        assert_eq!(entry_of(&f, &edit.delivery_id), (outbox.clone(), sequence, None), "seeded: {seeded}");
        assert_eq!(edit.delivery_id, owner_outbox::delivery_id(&outbox, sequence, &edit.update_digest));
        let pending = owner_outbox::read_pending(&f.store, "workspace", &outbox).unwrap();
        assert_eq!(
            pending.entries.iter().map(|entry| &entry.delivery_id).collect::<Vec<_>>(),
            vec![&edit.delivery_id],
            "seeded: {seeded}"
        );
        acknowledge_entry(&mut f, &receipt_of(&edit.delivery_id, &edit.update_digest, 20));
        let after = owner_outbox::read_pending(&f.store, "workspace", &outbox).unwrap();
        assert!(after.entries.is_empty() && after.pending_bytes == 0, "seeded: {seeded}");
    }
}

/// Successive successions across several paths: S2 at second.md retires S1's
/// outbox at first.md, and P's, which S1 retired, keeps naming S1. One
/// outbox stays open, and S2's next edit joins it.
#[test]
fn successive_successions_leave_one_open_outbox() {
    let (mut f, _) = carried_across_two_renames();
    let first = binding_at(&f, "first.md");
    f.adopt().unwrap();
    assert_eq!(
        outbox_states(&f),
        vec![
            retired_at("first.md", f.binding.clone()),
            retired_at("owner.md", first),
            open_at("second.md"),
        ]
    );
    let edit = native_tail_edit(&mut f, "# Second successor\n", 20);
    assert_eq!(entry_of(&f, &edit.delivery_id).0, outbox_at(&f, "second.md"));
}

/// Sol's ruling (a): a succession that returns to an earlier binding reopens
/// the outbox an earlier succession retired there, with no abandoned seed,
/// keeping its entries; its seed and later edits continue that outbox's
/// sequence. S1's outbox is retired in turn.
#[test]
fn a_succession_back_to_an_earlier_binding_reopens_its_outbox() {
    let (mut f, coverage) = carried_across_renames_to("owner.md");
    let kept = entries_at(&f, "owner.md");
    assert_eq!(
        outbox_states(&f)[1],
        retired_at("owner.md", binding_at(&f, "first.md")),
        "S1 retired P's outbox"
    );
    let id = f.cut.adoption_id.clone();
    f.adopt().unwrap();
    assert_eq!(outbox_states(&f), vec![retired_at("first.md", f.binding.clone()), open_at("owner.md")]);
    assert!(!coverage.iter().any(|(_, _, disposition)| *disposition == Disposition::Abandoned));
    let seed = pending_seed_delivery(&f);
    assert_eq!(entry_of(&f, &seed), (outbox_at(&f, "owner.md"), 3, None));
    assert_eq!(&entries_at(&f, "owner.md")[..2], &kept[..]);
    assert_eq!(seeds(&f).last(), Some(&(id, 3)));
    let edit = native_tail_edit(&mut f, "# Returned\n", 20);
    assert_eq!(entry_of(&f, &edit.delivery_id), (outbox_at(&f, "owner.md"), 4, None));
}

/// Sol's ruling (a): any outbox in the generation that is neither at the
/// successor's exact binding nor at one its chain held refuses adoption with
/// no writes, seeded or not, with or without an outbox already at the
/// successor's binding. That includes one at the successor's path with other
/// selectors. Without the unrelated outbox, the existing one at its binding
/// takes the successor's deliveries.
#[test]
fn an_unrelated_outbox_refuses_every_succession() {
    let unrelated: [(&str, &[&str]); 2] = [
        ("elsewhere.md", &["elsewhere.md"]),
        ("notes/renamed.md", &["notes/renamed.md", "other.md"]),
    ];
    for seeded in [true, false] {
        for current in [false, true] {
            for (path, selectors) in unrelated {
                let case = format!("seeded {seeded}, current {current}, {path} {selectors:?}");
                let mut f = released(seeded);
                rename(&mut f, "notes/renamed.md", "renamed");
                successor(&mut f);
                if current {
                    extra_outbox(&mut f, "current", "notes/renamed.md", &["notes/renamed.md"]);
                }
                extra_outbox(&mut f, "unrelated", path, selectors);
                let before = rows(&f, &SUCCESSION_WRITES);
                let adopted = f.adopt();
                assert!(matches!(adopted, Err(ApplicationError::Conflict)), "{case}: {adopted:?}");
                assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "{case}");
            }
        }
        let mut f = released(seeded);
        rename(&mut f, "notes/renamed.md", "renamed");
        successor(&mut f);
        extra_outbox(&mut f, "current", "notes/renamed.md", &["notes/renamed.md"]);
        f.adopt().unwrap();
        assert_eq!(
            outbox_states(&f),
            vec![open_at("notes/renamed.md"), retired_at("owner.md", f.binding.clone())],
            "seeded: {seeded}"
        );
        let edit = native_tail_edit(&mut f, "# After adoption\n", 20);
        assert_eq!(entry_of(&f, &edit.delivery_id).0, "current", "seeded: {seeded}");
    }
}

/// Sol's ruling (a): a later succession accepts a retired outbox only with
/// nothing pending in it and an observed binding an adopted activation of the
/// chain held after the outbox's own. Each damage to P's outbox, which S1
/// retired, refuses S2 with no writes.
#[test]
fn only_a_chained_drained_retirement_is_covered() {
    let damages: [(&str, &str); 8] = [
        ("no observed binding", "UPDATE owner_ydoc_outboxes SET observed_binding_json=NULL WHERE current_path='owner.md'"),
        (
            "an unrelated observed binding",
            "UPDATE owner_ydoc_outboxes SET observed_binding_json=json_set(observed_binding_json,
               '$.currentPath','elsewhere.md','$.selectorPaths',json_array('elsewhere.md')) WHERE current_path='owner.md'",
        ),
        (
            "its own binding observed",
            "UPDATE owner_ydoc_outboxes SET observed_binding_json=json_set(observed_binding_json,
               '$.currentPath','owner.md','$.selectorPaths',json_array('owner.md')) WHERE current_path='owner.md'",
        ),
        ("another reason", "UPDATE owner_ydoc_outboxes SET quarantine_reason='binding-changed' WHERE current_path='owner.md'"),
        ("a restore's reason", "UPDATE owner_ydoc_outboxes SET quarantine_reason='restore-fenced' WHERE current_path='owner.md'"),
        (
            "pending totals",
            "UPDATE owner_ydoc_outboxes SET pending_bytes=5,oldest_entry_at_ms=1 WHERE current_path='owner.md'",
        ),
        (
            "a pending entry",
            "UPDATE owner_ydoc_outbox_entries SET pending=1 WHERE sequence=2
               AND outbox_id=(SELECT outbox_id FROM owner_ydoc_outboxes WHERE current_path='owner.md')",
        ),
        (
            "an outbox no activation of the chain held",
            "UPDATE owner_ydoc_outboxes SET current_path='elsewhere.md',selector_paths_json='[\"elsewhere.md\"]'
               WHERE current_path='owner.md'",
        ),
    ];
    for (case, damage) in damages {
        let (mut f, _) = carried_across_two_renames();
        write_unchecked(&mut f, damage);
        let before = rows(&f, &SUCCESSION_WRITES);
        let adopted = f.adopt();
        assert!(matches!(adopted, Err(ApplicationError::Conflict)), "{case}: {adopted:?}");
        assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "{case}");
    }
}

/// Sol's acceptance test 6: retirement, the successor's outbox, its
/// activation and its seed commit together. A failure inside the transaction
/// rolls all of it back. A crash before the commit leaves nothing, and one
/// after it leaves everything; after a restart the retry adopts or replays,
/// and a further replay changes nothing.
#[test]
fn a_renamed_succession_commits_whole_and_replays_after_restart() {
    use dohc_engine_storage::{FaultAction, FaultPoint};
    struct CrashAt(FaultPoint);
    impl FaultInjector for CrashAt {
        fn poll(&self, point: FaultPoint) -> FaultAction {
            if point == self.0 {
                FaultAction::Crash
            } else {
                FaultAction::Continue
            }
        }
    }
    let renamed = || {
        let mut f = released(true);
        rename(&mut f, "notes/renamed.md", "renamed");
        let id = successor(&mut f);
        (f, id)
    };
    let (mut f, _) = renamed();
    let before = rows(&f, &SUCCESSION_WRITES);
    let failed = adopt_owner_committed(&mut f.store, &f.handle, f.cut.clone(), 1_000_000, 100, 10, &NoFaults, None, |tx, _, _, _| {
        let mut query = tx
            .prepare("SELECT current_path,state FROM owner_ydoc_outboxes ORDER BY current_path")
            .map_err(read_sql)?;
        let states = query
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(read_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(read_sql)?;
        let expected = [("notes/renamed.md", "active"), ("owner.md", "quarantined")]
            .map(|(path, state)| (path.to_owned(), state.to_owned()));
        assert_eq!(states, expected, "retired and opened before the commit");
        Err(ApplicationError::Conflict)
    });
    assert!(matches!(failed, Err(ApplicationError::Conflict)));
    assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "the whole transition rolls back");
    for point in [FaultPoint::StorageBeforePersist, FaultPoint::StorageAfterCommitBeforeAck] {
        let (mut f, id) = renamed();
        let before = rows(&f, &SUCCESSION_WRITES);
        let crashed = adopt_owner_committed(&mut f.store, &f.handle, f.cut.clone(), 1_000_000, 100, 10, &CrashAt(point), None, |_, _, _, _| Ok(()));
        assert!(crashed.is_err(), "{point:?}");
        let committed = point == FaultPoint::StorageAfterCommitBeforeAck;
        if !committed {
            assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "{point:?}");
        }
        let path = f._scratch.join("engine.db");
        drop(f.store);
        f.store = EngineStore::open(&path, 10).unwrap();
        assert_eq!(f.adopt().unwrap().adoption_replayed, committed, "{point:?}");
        let written = rows(&f, &SUCCESSION_WRITES);
        assert!(f.adopt().unwrap().adoption_replayed, "{point:?}");
        assert_eq!(rows(&f, &SUCCESSION_WRITES), written, "{point:?}: a replay writes nothing");
        assert_eq!(
            outbox_states(&f),
            vec![open_at("notes/renamed.md"), retired_at("owner.md", f.binding.clone())],
            "{point:?}"
        );
        let seeded_by: Vec<_> = seeds(&f).into_iter().filter(|(activation, _)| *activation == id).collect();
        assert_eq!(seeded_by, vec![(id, 1)], "{point:?}: one seed");
    }
}

/// Roll back the document's latest mutation, `moment`, through the domain,
/// with the lineage following the restored path as the rename helper's does.
fn roll_back(f: &mut Fixture, moment: &str) {
    let input = dohc_engine_domain::RollbackTextFileMutation {
        workspace_id: "workspace".into(),
        version_id: "main".into(),
        path: f.binding.current_path.clone(),
        mutation_moment_id: moment.into(),
        request_id: None,
        metadata_origin: "user".into(),
        author_json: None,
    };
    let mut restored = None;
    VersionedTextStore::new(&mut f.store)
        .rollback_text_file_mutation_with(&input, &NoFaults, |_, _| Ok(()), |tx, _, head, _, _| {
            let (path, _) = head.expect("a text head");
            tx.execute("UPDATE ydoc_docs SET path=?1 WHERE workspace_id='workspace' AND version_id='main' AND object_id='object'", [path])
                .map_err(dohc_engine_storage::StorageError::persist_public)?;
            restored = Some(path.to_owned());
            Ok(())
        })
        .unwrap();
    let path = restored.unwrap();
    f.binding.current_path = path.clone();
    f.binding.selector_paths = vec![path];
}

/// Sol's ruling (b), the deliberately narrower Resume: P's binding at
/// owner.md needs its proof even with nothing Carried. Each of these refuses
/// S's adoption with no writes, though a plain rename proves it:
/// - a real rollback that moved the document back from b.md to a.md. The
///   domain's rollback deletes the rename it undoes, so no rename leads from
///   b.md back to owner.md;
/// - P's outbox, with its covered entry, quarantined `binding-changed`;
/// - an empty outbox at P's binding quarantined `binding-changed`;
/// - P's binding at a path the document never had, with no outbox at all.
#[test]
fn a_chain_binding_needs_its_proof_with_nothing_carried() {
    let mut f = released_covered();
    rename(&mut f, "a.md", "to-a");
    successor(&mut f);
    f.adopt().unwrap();
    let refusals: [RefusedFixture; 4] = [
        ("a rollback back to a.md", || {
            let mut f = released_covered();
            rename(&mut f, "a.md", "to-a");
            rename(&mut f, "b.md", "to-b");
            roll_back(&mut f, "to-b");
            assert_eq!(f.binding.current_path, "a.md");
            successor(&mut f);
            f
        }),
        ("a binding-changed quarantine", || {
            let mut f = released_covered();
            let observed = serde_json::to_string(&binding_at(&f, "notes/renamed.md")).unwrap();
            write(&mut f, &format!(
                "UPDATE owner_ydoc_outboxes SET state='quarantined',quarantine_reason='binding-changed',observed_binding_json='{observed}'"
            ));
            rename(&mut f, "notes/renamed.md", "renamed");
            successor(&mut f);
            f
        }),
        ("an empty binding-changed outbox", || {
            let mut f = released_unregistered();
            let binding = f.binding.clone();
            f.store
                .write_with(&NoFaults, |tx| crate::owner_outbox::open_successor_outbox_in_tx(tx, &binding, 5))
                .unwrap();
            let observed = serde_json::to_string(&binding_at(&f, "notes/renamed.md")).unwrap();
            write(&mut f, &format!(
                "UPDATE owner_ydoc_outboxes SET state='quarantined',quarantine_reason='binding-changed',observed_binding_json='{observed}'"
            ));
            rename(&mut f, "notes/renamed.md", "renamed");
            successor(&mut f);
            f
        }),
        ("an unproved binding and no outbox", || {
            let mut f = released_with_nothing_carried();
            write(&mut f, "UPDATE live_owner_activations SET binding_json=json_set(binding_json,'$.currentPath','elsewhere.md',
                '$.selectorPaths',json_array('elsewhere.md')) WHERE activation_id='adoption'");
            f
        }),
    ];
    for (case, fixture) in refusals {
        let mut f = fixture();
        let before = rows(&f, &SUCCESSION_WRITES);
        let adopted = f.adopt();
        assert!(matches!(adopted, Err(ApplicationError::Conflict)), "{case}: {adopted:?}");
        assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "{case}");
    }
}

/// P, then S1, adopt and release at owner.md, and S2 registers there: a
/// chain of two activations that held one binding.
fn released_twice_at_one_binding() -> Fixture {
    let mut f = released_with_nothing_carried();
    let terminal = f.cut.terminal_receipt.clone();
    f.adopt().unwrap();
    host_document(&mut f, true, true);
    retirement_settle(&mut f, 10, terminal).unwrap();
    release_parked(&mut f);
    importable(&mut f);
    returned(&mut f);
    successor(&mut f);
    f
}

/// Sol's ruling (c): the chain walk counts every activation it visits, not the
/// bindings they held. Two activations at one binding exceed a budget of
/// one, and the adoption refuses with no writes; at two it adopts.
#[test]
fn the_chain_walk_counts_each_activation() {
    let mut f = released_twice_at_one_binding();
    let tail = f.cut.retained_prefix.as_ref().unwrap().predecessor_activation_id.clone();
    let walk = |f: &Fixture, max_events| {
        f.store.read_with(|conn| {
            chain_bindings(conn, "namespace", &f.key, &f.binding.lineage_claim_id, &tail, max_events)
                .map(|chain| chain.bindings.len())
        })
    };
    assert!(matches!(walk(&f, 1), Err(ApplicationError::InvalidInput("owner adoption retained outbox coverage exceeds its budget"))));
    assert_eq!(walk(&f, 2).unwrap(), 1);
    let adopt = |f: &mut Fixture, max_events| {
        adopt_owner_committed(&mut f.store, &f.handle, f.cut.clone(), 1_000_000, max_events, 10, &NoFaults, None, |_, _, _, _| Ok(()))
    };
    let before = rows(&f, &SUCCESSION_WRITES);
    let refused = adopt(&mut f, 1);
    assert!(
        matches!(refused, Err(ApplicationError::InvalidInput("owner adoption retained outbox coverage exceeds its budget"))),
        "{refused:?}"
    );
    assert_eq!(rows(&f, &SUCCESSION_WRITES), before);
    adopt(&mut f, 2).unwrap();
}

/// Sol's ruling (c): the restore walk counts each generation it visits,
/// the registration's included, and refuses past its budget rather than
/// answer from part of the history.
#[test]
fn the_restore_walk_is_bounded() {
    let (f, _) = resumed_at_one();
    let held = f.handle.registration.lock().unwrap();
    let walk = |max_events| f.store.read_with(|conn| resumed_generations(conn, &held, max_events));
    assert!(matches!(walk(1), Err(ApplicationError::InvalidInput("owner adoption retained outbox coverage exceeds its budget"))));
    assert_eq!(walk(2).unwrap(), std::collections::HashSet::from([0, 1]));
}

/// Sol's ruling (c): one rename walk serves every chain binding. It stops once
/// it has proved each path it needs, and refuses past its budget rather than
/// prove less.
#[test]
fn the_rename_walk_is_shared_and_bounded() {
    let (f, _) = carried_across_two_renames();
    let walk = |needed: &[&str], max_events| {
        let needed: std::collections::HashSet<&str> = needed.iter().copied().collect();
        f.store.read_with(|conn| renamed_from(conn, &f.key, "second.md", &needed, max_events))
    };
    let proved = |paths: &[&str]| paths.iter().map(|path| path.to_string()).collect::<std::collections::HashSet<_>>();
    assert!(matches!(
        walk(&["owner.md", "first.md"], 1),
        Err(ApplicationError::InvalidInput("owner adoption retained outbox coverage exceeds its budget"))
    ));
    assert_eq!(walk(&["owner.md", "first.md"], 2).unwrap(), proved(&["owner.md", "first.md"]));
    assert_eq!(walk(&["first.md"], 1).unwrap(), proved(&["first.md"]));
}

/// `count` copies of activation `template` in `workspace`, `{prefix}-1` to
/// `{prefix}-{count}`, linked in turn between `above` and the activation it
/// followed.
fn chain_copies(f: &mut Fixture, above: &str, template: &str, prefix: &str, count: usize, workspace: &str) {
    write_unchecked(
        f,
        &format!(
            "PRAGMA foreign_keys=OFF;
             CREATE TEMP TABLE below AS SELECT predecessor_activation_id AS id FROM live_owner_activations WHERE activation_id='{above}';
             UPDATE live_owner_activations SET predecessor_activation_id=NULL WHERE activation_id='{above}';
             CREATE TEMP TABLE copies AS WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<{count})
               SELECT v.* FROM n JOIN live_owner_activations v ON v.activation_id='{template}' ORDER BY n.i;
             UPDATE copies SET activation_id='{prefix}-'||rowid,workspace_id='{workspace}',
               predecessor_activation_id=CASE WHEN rowid={count} THEN (SELECT id FROM below) ELSE '{prefix}-'||(rowid+1) END;
             INSERT INTO live_owner_activations SELECT * FROM copies;
             UPDATE live_owner_activations SET predecessor_activation_id='{prefix}-1' WHERE activation_id='{above}'"
        ),
    );
}

/// Sol's finding 1 on 4b3a2: the chain walk keeps its budget before anything
/// resolves through it. S1 repeats at its binding past the budget, and S2
/// inherits C1, which P, the chain's oldest activation, queued. S2 refuses
/// with the budget error and no writes. Past the budget the chain leads
/// through activations of another workspace, which no other read of the
/// adoption sees, so a thousand more of them change its work only if a walk
/// reads past the budget. Within the budget, the repeated chain adopts.
#[test]
fn the_chain_walk_stops_at_its_budget_before_inherited_entries_resolve() {
    let tail = |f: &Fixture| f.cut.retained_prefix.as_ref().unwrap().predecessor_activation_id.clone();
    let (mut f, _) = carried_across_two_renames();
    let s1 = tail(&f);
    chain_copies(&mut f, &s1, &s1, "repeated", 2, "workspace");
    f.adopt().unwrap();
    let (mut f, _) = carried_across_two_renames();
    let s1 = tail(&f);
    chain_copies(&mut f, &s1, &s1, "repeated", 100, "workspace");
    chain_copies(&mut f, "repeated-100", &s1, "near", 1, "elsewhere");
    let work = |f: &mut Fixture| {
        let before = rows(f, &SUCCESSION_WRITES);
        let counted = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        f.store.count_work(Some(std::sync::Arc::downgrade(&counted))).unwrap();
        let refused = f.adopt();
        f.store.count_work(None).unwrap();
        assert!(
            matches!(refused, Err(ApplicationError::InvalidInput("owner adoption retained outbox coverage exceeds its budget"))),
            "{refused:?}"
        );
        assert_eq!(rows(f, &SUCCESSION_WRITES), before);
        counted.load(std::sync::atomic::Ordering::Relaxed)
    };
    let near = work(&mut f);
    chain_copies(&mut f, "repeated-100", &s1, "far", 1_000, "elsewhere");
    assert_eq!(work(&mut f), near, "the walk reads nothing past its budget");
}

/// Sol's finding on 4b3a3: a released tail that carried nothing resolves
/// without walking its chain, so settlement, activation and release
/// classification do the same work however long the history behind it grows.
#[test]
fn an_empty_manifest_resolves_without_walking_the_chain() {
    let mut f = released_with_nothing_carried();
    let tail = f.cut.retained_prefix.as_ref().unwrap().predecessor_activation_id.clone();
    let work = |f: &mut Fixture| {
        let counted = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        f.store.count_work(Some(std::sync::Arc::downgrade(&counted))).unwrap();
        let inherited = f.store.read_with(|conn| {
            retirement::inherited_entries(conn, "namespace", &f.key, &f.binding.lineage_claim_id, Some(&tail))
        });
        f.store.count_work(None).unwrap();
        assert!(inherited.unwrap().is_empty());
        counted.load(std::sync::atomic::Ordering::Relaxed)
    };
    chain_copies(&mut f, &tail, &tail, "near", 3, "elsewhere");
    let near = work(&mut f);
    chain_copies(&mut f, "near-3", &tail, "far", 1_000, "elsewhere");
    assert_eq!(work(&mut f), near, "an empty manifest walks no predecessor");
}

/// A fixture a successor adopts as it is, by the case it shows.
type QuarantineFixture = (&'static str, fn() -> Fixture);

/// Sol's finding 2 on 4b3a2: a quarantined outbox counts only when all three
/// of its pending totals show it drained, whichever permitted reason
/// quarantined it, at the successor's binding or at an earlier one its chain
/// held. Each fixture adopts as it is; one inconsistent total refuses it with
/// no writes.
#[test]
fn every_pending_total_must_show_a_quarantined_outbox_drained() {
    let fixtures: [QuarantineFixture; 4] = [
        ("succession-retired at the successor's binding", || carried_across_renames_to("owner.md").0),
        ("succession-retired at an earlier binding", || carried_across_two_renames().0),
        ("provenance-refused at the successor's binding", || {
            let mut f = quarantined_seed_released().0;
            successor(&mut f);
            f
        }),
        ("provenance-refused at an earlier binding", || {
            let mut f = quarantined_seed_released().0;
            rename(&mut f, "notes/renamed.md", "renamed");
            successor(&mut f);
            f
        }),
    ];
    let totals = [
        ("pending bytes", "pending_bytes=5"),
        ("an oldest entry", "oldest_entry_at_ms=1"),
        ("a pending count", "pending_entry_count=1"),
    ];
    for (case, fixture) in fixtures {
        fixture().adopt().unwrap();
        for (total, damage) in totals {
            let mut f = fixture();
            write_unchecked(&mut f, &format!("UPDATE owner_ydoc_outboxes SET {damage} WHERE state='quarantined'"));
            let before = rows(&f, &SUCCESSION_WRITES);
            let adopted = f.adopt();
            assert!(matches!(adopted, Err(ApplicationError::Conflict)), "{case}, {total}: {adopted:?}");
            assert_eq!(rows(&f, &SUCCESSION_WRITES), before, "{case}, {total}");
        }
    }
}

/// The reopening itself checks every pending total, whatever coverage
/// proved: one inconsistent total leaves the outbox quarantined.
#[test]
fn reopening_checks_every_pending_total() {
    let (mut f, _) = quarantined_seed_released();
    let outbox: String = f
        .store
        .read_with(|conn| conn.query_row("SELECT outbox_id FROM owner_ydoc_outboxes", [], |r| r.get(0)))
        .unwrap();
    let reopen = |f: &mut Fixture| f.store.write_with(&NoFaults, |tx| reopen_outbox(tx, &outbox));
    for damage in ["pending_bytes=5", "oldest_entry_at_ms=1", "pending_entry_count=1"] {
        write_unchecked(&mut f, &format!("UPDATE owner_ydoc_outboxes SET {damage}"));
        assert!(matches!(reopen(&mut f), Err(ApplicationError::Conflict)), "{damage}");
        assert_eq!(outbox_states(&f)[0].2, "quarantined", "{damage}");
        write_unchecked(&mut f, "UPDATE owner_ydoc_outboxes SET pending_bytes=0,oldest_entry_at_ms=NULL,pending_entry_count=0");
    }
    assert!(matches!(reopen(&mut f), Ok(TxnOutcome::Committed(()))));
}
