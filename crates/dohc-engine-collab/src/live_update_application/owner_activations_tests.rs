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
                 VALUES ('namespace',?1,'workspace','main','object',?2,iif(?8,NULL,'adoption'),?3,?4,?5,?6,?7,1,3,'{}',
                    iif(?8,NULL,'evidence'),iif(?8,NULL,'coverage'),iif(?8,NULL,0),iif(?8,NULL,?9),
                    iif(?8,NULL,0),iif(?8,NULL,'null'),iif(?8,NULL,1),iif(?8,NULL,1),
                    iif(?8,20,NULL),iif(?8,0,NULL),iif(?8,0,NULL),iif(?8,'null',NULL),iif(?8,'[]',NULL))",
                params![id, f.binding.lineage_claim_id, predecessor, binding, moment, digest, length, released, sequence],
            )
            .map_err(write_sql)?;
            Ok::<_, ApplicationError>(())
        })
        .unwrap();
}

/// A released activation of `object` in `namespace` that never adopted. It
/// records no baseline, as a capture has none before its relay registers it.
fn release_unadopted(
    f: &mut Fixture,
    namespace: &str,
    object: &str,
    id: &str,
    predecessor: Option<&str>,
) {
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
                    main_version_id,object_id,lineage_claim_id,predecessor_activation_id,binding_json,
                    source_moment_id,source_digest,source_byte_length,host_coordinate_json,released_at_ms,
                    released_restore_generation,released_accepted_cursor,released_boundary_json,carried_manifest_json)
                 VALUES (?1,?2,'workspace','main',?3,?4,?5,?6,?7,?8,?9,'{}',20,0,0,'null','[]')",
                params![namespace, id, object, f.binding.lineage_claim_id, predecessor, binding, moment, digest, length],
            )
            .map_err(write_sql)?;
            Ok::<_, ApplicationError>(())
        })
        .unwrap();
}

fn chain_tail(f: &Fixture, namespace: &str) -> Result<Option<String>, ApplicationError> {
    f.store.read_with(|conn| {
        owner_activations::released_chain_tail(conn, namespace, &f.key, &f.binding.lineage_claim_id)
    })
}

fn release(f: &mut Fixture, id: &str) {
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE live_owner_activations SET released_at_ms=20,released_restore_generation=0,
                    released_accepted_cursor=0,carried_manifest_json='[]',
                    released_boundary_json=json_object('terminalReceipt',json(terminal_receipt_json),
                      'eventCount',0,'historyEvidenceDigest',evidence_digest)
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
    retain_captured(&mut f);
    let coordinate = f.handle.registration.lock().unwrap().coordinate.clone();
    f.handle = f
        ._owner
        .register_activation(
            &mut f.store,
            "namespace".into(),
            coordinate,
            f.binding.clone(),
            "captured".into(),
        )
        .unwrap();
    assert!(matches!(f.adopt(), Err(ApplicationError::Conflict)));
    assert_eq!(f.store.table_row_count("live_owner_adoptions").unwrap(), 0);
    assert_eq!(binding_activation(&f), (Some("captured".into()), 1));
}

#[test]
fn a_successor_follows_the_released_tail_of_its_own_chain() {
    let mut f = Fixture::new();
    assert_eq!(chain_tail(&f, "namespace").unwrap(), None, "nothing activated yet");
    f.adopt().unwrap();
    assert_eq!(chain_tail(&f, "namespace").unwrap(), None, "the lineage is current");
    release(&mut f, "adoption");
    assert_eq!(chain_tail(&f, "namespace").unwrap().as_deref(), Some("adoption"));
    release_unadopted(&mut f, "namespace", "object", "never-adopted", Some("adoption"));
    add_activation(&mut f, "third", "never-adopted", true, 0);
    // Released rows of another namespace, and of another document, are other chains.
    release_unadopted(&mut f, "elsewhere", "object", "foreign", None);
    release_unadopted(&mut f, "namespace", "other", "sibling", None);
    assert_eq!(chain_tail(&f, "namespace").unwrap().as_deref(), Some("third"));
    assert_eq!(chain_tail(&f, "elsewhere").unwrap().as_deref(), Some("foreign"));
    release_unadopted(&mut f, "namespace", "object", "stray", None);
    assert!(
        matches!(chain_tail(&f, "namespace"), Err(ApplicationError::Corrupt)),
        "a lineage has one chain"
    );
    add_activation(&mut f, "current", "third", false, 5);
    assert_eq!(chain_tail(&f, "namespace").unwrap(), None, "the lineage is current again");
}

#[test]
fn a_lineage_with_no_current_activation_settles_through_its_furthest_cut() {
    let mut f = Fixture::new();
    f.edit(true);
    f.adopt().unwrap();
    let mut event = f.cut.events[0].clone();
    f.doc
        .rewrite_content_to_markdown(ContentKind::Richdoc, "remote after adoption")
        .unwrap();
    event.update_bytes = f.doc.encode_full_state();
    event.metadata.accepted.receipt.delivery_id = "remote-after-adoption".into();
    event.metadata.accepted.receipt.journal_cursor = 8;
    event.metadata.accepted.receipt.update_digest = hex_sha256(&event.update_bytes);
    assert!(matches!(
        apply_committed(&mut f.store, &mut WriterDocCache::new(), &f.handle, event, &NoFaults,
            100_000_000, |_, _, _, _| Ok(())).unwrap(),
        ApplicationResult::Applied(..)
    ));
    let pending = |f: &Fixture| {
        f.store
            .read_with(|conn| unload_pending(conn, "workspace", "object"))
            .unwrap()
    };
    assert_eq!(pending(&f), Some(UnloadPending::Settlement), "applied past the cut at 7");
    release(&mut f, "adoption");
    assert_eq!(pending(&f), Some(UnloadPending::Settlement), "released, its cut still bounds it");
    add_activation(&mut f, "successor", "adoption", false, 1);
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE live_owner_activations SET terminal_cursor=8 WHERE activation_id='successor'",
                [],
            )
            .map_err(write_sql)
        })
        .unwrap();
    assert_eq!(pending(&f), None, "the current activation's cut covers it");
    release(&mut f, "successor");
    assert_eq!(pending(&f), None, "with none current, the furthest cut still covers it");
}

#[test]
fn a_released_activation_never_resumes_though_its_bytes_match() {
    let mut f = imported_fixture();
    let captured = capture_imported(&mut f, 1_000_000).unwrap();
    let id = captured.activation_id.clone();
    resume_imported(&mut f, &id, 1_000_000).expect("a pending activation resumes");
    release_unadopted(&mut f, "namespace", "object", &id, None);
    assert!(
        matches!(resume_imported(&mut f, &id, 1_000_000), Err(ApplicationError::Conflict)),
        "a released activation that never adopted"
    );

    let mut f = imported_fixture();
    let captured = capture_imported(&mut f, 1_000_000).unwrap();
    let id = captured.activation_id.clone();
    f.cut.adoption_id = id.clone();
    f.adopt().unwrap();
    resume_imported(&mut f, &id, 1_000_000).expect("the current activation resumes");
    release(&mut f, &id);
    assert!(
        matches!(resume_imported(&mut f, &id, 1_000_000), Err(ApplicationError::Conflict)),
        "a released activation that adopted"
    );
}

#[test]
fn historical_readers_prove_each_activations_own_source() {
    use crate::owner_outbox::publication::{contains_in, PublicationContentKind, PublicationProof};
    let mut f = Fixture::new();
    f.edit(true);
    f.adopt().unwrap();
    release(&mut f, "adoption");
    // The released predecessor adopted from its own source; the successor
    // adopted from the fixture's.
    let old = "Predecessor source.";
    let old_digest = hex_sha256(old.as_bytes());
    f.store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs(sha256,text,byte_length) VALUES (?1,?2,?3)",
                params![old_digest, old, old.len() as i64],
            )
            .map_err(write_sql)?;
            tx.execute(
                "UPDATE live_owner_activations SET source_digest=?1,source_byte_length=?2 WHERE activation_id='adoption'",
                params![old_digest, old.len() as i64],
            )
            .map_err(write_sql)?;
            Ok::<_, ApplicationError>(())
        })
        .unwrap();
    add_activation(&mut f, "successor", "adoption", false, 99);
    let recorded = |f: &Fixture, id: &str| -> (String, i64, i64) {
        f.store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT source_digest,terminal_cursor,local_ydoc_sequence FROM live_owner_activations WHERE activation_id=?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            })
            .unwrap()
    };
    let head = |f: &Fixture, id: &str| {
        let held = f.handle.registration.lock().unwrap();
        f.store.read_with(|conn| {
            restore_resume::origin_head(
                conn,
                &held,
                &RestoreDeliveryOrigin::Owner { id: id.into() },
                &mut restore_content::Budget {
                    remaining: 1_000_000,
                },
            )
        })
    };
    assert_eq!(head(&f, "adoption").unwrap(), recorded(&f, "adoption"));
    assert_eq!(head(&f, "successor").unwrap(), recorded(&f, "successor"));
    assert_ne!(recorded(&f, "adoption"), recorded(&f, "successor"));
    release_unadopted(&mut f, "namespace", "object", "unadopted", None);
    assert!(head(&f, "unadopted").is_err(), "a fence origin is an adopted activation");

    let proof = |f: &Fixture, digest: &str| {
        f.store
            .read_with(|conn| {
                contains_in(
                    conn,
                    &f.key,
                    &f.binding.current_path,
                    None,
                    PublicationContentKind::Projection,
                    digest,
                    &mut 4_000_000,
                )
            })
            .unwrap()
    };
    assert_eq!(
        proof(&f, &old_digest),
        PublicationProof::Contained,
        "the released predecessor still proves its source"
    );
    assert_eq!(proof(&f, &hex_sha256(b"Never a source.")), PublicationProof::NotContained);
}
