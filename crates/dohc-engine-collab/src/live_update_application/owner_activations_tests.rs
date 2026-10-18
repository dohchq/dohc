const ROOT_ADOPTION: &str = "SELECT json_array(relay_database_namespace,adoption_id,workspace_id,main_version_id,object_id,lineage_claim_id,binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,max_pending_bytes,max_pending_age_ms) FROM live_owner_adoptions";

fn root_adoption(f: &Fixture) -> String {
    f.store
        .read_with(|conn| conn.query_row(ROOT_ADOPTION, [], |row| row.get(0)))
        .unwrap()
}

fn binding_activation(f: &Fixture) -> (Option<String>, i64) {
    f.store
        .read_with(|conn| {
            conn.query_row(
                "SELECT activation_id,available FROM live_device_application_bindings WHERE object_id='object'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap()
}

/// Every lineage-scoped read, by the class it belongs to.
#[derive(Debug, PartialEq)]
struct Reads {
    origin: Option<String>,
    stamp: String,
    current: Option<(String, i64)>,
    adopted_origin: Option<(i64, Option<LiveUpdateReceipt>)>,
    held: bool,
    exact: Option<(bool, bool)>,
}

fn reads(f: &Fixture, exact: &str) -> Reads {
    let held = f.handle.registration.lock().unwrap();
    f.store
        .read_with(|conn| {
            Ok::<_, ApplicationError>(Reads {
                origin: owner_activations::lineage_origin_id(
                    conn,
                    Some("namespace"),
                    &f.key,
                    &f.binding.lineage_claim_id,
                )?,
                stamp: accepted_history::origin_stamp(conn, &held)?,
                current: owner_activations::current_activation(
                    conn,
                    Some("namespace"),
                    &f.key,
                    &f.binding.lineage_claim_id,
                )?
                .map(|(activation, adopted)| (activation.activation_id, adopted.local_ydoc_sequence)),
                adopted_origin: read_origin(conn, &held)?
                    .map(|origin| (origin.sequence, origin.terminal)),
                held: crate::owner_outbox::has_adopted_owner_in(conn, &f.key)?,
                exact: owner_activations::activation_by_id(conn, "namespace", exact)?
                    .map(|activation| (activation.released, activation.adoption.is_some())),
            })
        })
        .unwrap()
}

/// A successor of `predecessor`. Released ones never adopted; an unreleased
/// one adopted at `sequence`.
fn add_activation(f: &mut Fixture, id: &str, predecessor: &str, released: bool, sequence: i64) {
    let binding = serde_json::to_string(&f.binding).unwrap();
    let (moment, digest, length) = (
        f.cut.source_moment_id.clone(),
        f.cut.source_digest.clone(),
        f.cut.source_byte_length,
    );
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO live_owner_activations (relay_database_namespace,activation_id,workspace_id,
                    main_version_id,object_id,lineage_claim_id,origin_adoption_id,predecessor_activation_id,
                    binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,
                    baseline_registered_at_ms,host_coordinate_json,evidence_digest,coverage_digest,
                    covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,
                    max_pending_bytes,max_pending_age_ms,released_at_ms,released_restore_generation,
                    released_accepted_cursor,released_boundary_json,carried_manifest_json)
                 VALUES ('namespace',?1,'workspace','main','object',?2,'adoption',?3,?4,?5,?6,?7,1,3,'{}',
                    iif(?8,NULL,'evidence'),iif(?8,NULL,'coverage'),iif(?8,NULL,0),iif(?8,NULL,?9),
                    iif(?8,NULL,0),iif(?8,NULL,'null'),iif(?8,NULL,1),iif(?8,NULL,1),
                    iif(?8,20,NULL),iif(?8,0,NULL),iif(?8,0,NULL),iif(?8,'[]',NULL),iif(?8,'[]',NULL))",
                params![id, f.binding.lineage_claim_id, predecessor, binding, moment, digest, length, released, sequence],
            )
            .map_err(write_sql)?;
            Ok::<_, ApplicationError>(())
        })
        .unwrap();
}

fn release(f: &mut Fixture, id: &str) {
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE live_owner_activations SET released_at_ms=20,released_restore_generation=0,
                    released_accepted_cursor=0,released_boundary_json='[]',carried_manifest_json='[]'
                 WHERE activation_id=?1",
                [id],
            )
            .map_err(write_sql)?;
            Ok::<_, ApplicationError>(())
        })
        .unwrap();
}

#[test]
fn adoption_activates_its_lineage_and_names_the_binding() {
    let mut f = Fixture::new();
    assert_eq!(binding_activation(&f), (None, 1));
    f.adopt().unwrap();
    let copied: bool = f
        .store
        .read_with(|conn| {
            conn.query_row(
                "SELECT count(*)=1 AND v.activation_id=a.adoption_id AND v.origin_adoption_id=a.adoption_id
                   AND v.predecessor_activation_id IS NULL AND v.released_at_ms IS NULL AND v.boundary_json IS NULL
                   AND json_array(v.binding_json,v.source_moment_id,v.source_digest,v.source_byte_length,
                     v.baseline_moment_relay_sequence,v.baseline_registered_at_ms,v.host_coordinate_json,
                     v.evidence_digest,v.coverage_digest,v.covered_outbox_sequence,v.local_ydoc_sequence,
                     v.terminal_cursor,v.terminal_receipt_json,v.max_pending_bytes,v.max_pending_age_ms)
                   =json_array(a.binding_json,a.source_moment_id,a.source_digest,a.source_byte_length,
                     a.baseline_moment_relay_sequence,a.baseline_registered_at_ms,a.host_coordinate_json,
                     a.evidence_digest,a.coverage_digest,a.covered_outbox_sequence,a.local_ydoc_sequence,
                     a.terminal_cursor,a.terminal_receipt_json,a.max_pending_bytes,a.max_pending_age_ms)
                 FROM live_owner_activations v JOIN live_owner_adoptions a
                   ON a.relay_database_namespace=v.relay_database_namespace",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert!(copied, "the first activation carries every adoption fact");
    assert_eq!(binding_activation(&f), (Some("adoption".into()), 1));
    assert_eq!(
        f.handle.registration.lock().unwrap().activation_id.as_deref(),
        Some("adoption")
    );
    assert!(f.adopt().unwrap().adoption_replayed);
}

#[test]
fn a_released_activation_changes_no_lineage_read() {
    let mut f = Fixture::new();
    f.edit(true);
    f.adopt().unwrap();
    let root = root_adoption(&f);
    let before = reads(&f, "released");
    assert_eq!(before.origin.as_deref(), Some("adoption"));
    assert_eq!(before.current, Some(("adoption".into(), f.cut.expected_local_sequence)));
    assert!(before.held && before.exact.is_none());
    add_activation(&mut f, "released", "adoption", true, 0);
    assert_eq!(
        reads(&f, "released"),
        Reads {
            exact: Some((true, false)),
            ..before
        },
        "only the exact read names the released activation"
    );
    assert_eq!(reads(&f, "adoption").exact, Some((false, true)));
    assert_eq!(root_adoption(&f), root);
}

#[test]
fn a_successor_is_current_while_the_origin_and_its_stamp_stay() {
    let mut f = Fixture::new();
    f.edit(true);
    f.adopt().unwrap();
    let root = root_adoption(&f);
    let before = reads(&f, "adoption");
    release(&mut f, "adoption");
    let released = reads(&f, "adoption");
    assert_eq!((released.current, released.adopted_origin, released.held), (None, None, false));
    assert_eq!((released.origin, &released.stamp), (before.origin.clone(), &before.stamp));
    add_activation(&mut f, "successor", "adoption", false, 99);
    let after = reads(&f, "adoption");
    assert_eq!(after.current, Some(("successor".into(), 99)));
    assert_eq!(after.adopted_origin, Some((99, None)));
    assert!(after.held);
    assert_eq!(after.origin, before.origin, "the lineage keeps its origin");
    assert_eq!(after.stamp, before.stamp, "history stamps name the origin");
    assert_eq!(after.exact, Some((true, true)), "the exact read still finds the released one");
    assert_eq!(root_adoption(&f), root);
}

#[test]
fn an_activation_registration_is_refused_before_retiring_the_existing_one() {
    let mut f = Fixture::new();
    f.adopt().unwrap();
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    for refused in ["other", "released"] {
        if refused == "released" {
            add_activation(&mut f, "released", "adoption", true, 0);
        }
        assert!(matches!(
            f._owner.register_activation(
                &mut f.store,
                "namespace".into(),
                coordinate.clone(),
                f.binding.clone(),
                refused.into(),
            ),
            Err(ApplicationError::Conflict)
        ));
        assert!(f.handle.registration.lock().unwrap().live, "{refused}");
        assert_eq!(binding_activation(&f), (Some("adoption".into()), 1), "{refused}");
    }
    let registered = f
        ._owner
        .register_activation(
            &mut f.store,
            "namespace".into(),
            coordinate,
            f.binding.clone(),
            "adoption".into(),
        )
        .unwrap();
    assert!(!f.handle.registration.lock().unwrap().live);
    assert_eq!(
        registered.registration.lock().unwrap().activation_id.as_deref(),
        Some("adoption")
    );
    assert_eq!(binding_activation(&f), (Some("adoption".into()), 1));
}

#[test]
fn an_activation_registration_adopts_only_the_source_it_named() {
    let mut f = imported_fixture();
    let captured = capture_imported(&mut f, 1_000_000).unwrap();
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    assert!(matches!(
        f._owner.register_activation(
            &mut f.store,
            "namespace".into(),
            coordinate.clone(),
            f.binding.clone(),
            "ordinary-activation-unknown".into(),
        ),
        Err(ApplicationError::Conflict)
    ));
    f.handle = f
        ._owner
        .register_activation(
            &mut f.store,
            "namespace".into(),
            coordinate,
            f.binding.clone(),
            captured.activation_id.clone(),
        )
        .unwrap();
    assert_eq!(binding_activation(&f), (Some(captured.activation_id.clone()), 1));
    f.cut.adoption_id = captured.activation_id.clone();
    f.adopt().unwrap();
    assert_eq!(binding_activation(&f), (Some(captured.activation_id), 1));
}

#[test]
fn a_registration_for_one_activation_refuses_to_adopt_another() {
    let mut f = Fixture::new();
    let digest = f.cut.source_digest.clone();
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO ydoc_owner_activation_sources VALUES ('pending','namespace','workspace','main','object',?1,'original',?2,?1,'{}')",
                params![f.binding.lineage_claim_id, digest],
            )
            .map_err(write_sql)?;
            Ok::<_, ApplicationError>(())
        })
        .unwrap();
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    f.handle = f
        ._owner
        .register_activation(
            &mut f.store,
            "namespace".into(),
            coordinate,
            f.binding.clone(),
            "pending".into(),
        )
        .unwrap();
    assert!(matches!(f.adopt(), Err(ApplicationError::Conflict)));
    assert_eq!(f.store.table_row_count("live_owner_adoptions").unwrap(), 0);
    assert_eq!(binding_activation(&f), (Some("pending".into()), 1));
}
