use super::*;
use crate::{owner_outbox::draft::open_draft_in, DocKey};
use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_test_scratch::ScratchDir;

fn fixture() -> (ScratchDir, EngineStore, ObservedOwnerBinding, Vec<u8>) {
    let dir = ScratchDir::new_named("observed-owner-draft").unwrap();
    let mut store = EngineStore::open(&dir.join("engine.db"), 0).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 0, &NoFaults)
        .unwrap();
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let original: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: "owner.md".into(),
                text: fixture["markdown"].as_str().unwrap().into(),
                moment_id: "original".into(),
                metadata_origin: "user".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    let key = DocKey::new("workspace", "main", "object").unwrap();
    crate::claim_base(
        &mut store,
        &key,
        crate::ContentKind::Richdoc,
        &original,
        &NoFaults,
        2,
    )
    .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET path='owner.md'", [])
                .unwrap();
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    let (head, checkpoint) = store
        .read_with(|conn| {
            Ok::<_, OwnerOutboxError>((
                crate::read_marker_in(conn, &key)
                    .map_err(collab)?
                    .unwrap()
                    .head_update_seq,
                bounded(&crate::load_doc_in(conn, &key).map_err(collab)?)?,
            ))
        })
        .unwrap();
    let observed = ObservedOwnerBinding {
        binding: LiveObjectBinding {
            workspace_id: "workspace".into(),
            main_version_id: "main".into(),
            object_id: "object".into(),
            lineage_claim_id: hex_sha256(&original),
            current_path: "owner.md".into(),
            selector_paths: vec!["owner.md".into()],
            restore_fence_generation: 0,
        },
        relay_database_namespace: "relay".into(),
        revision: 1,
        accepted_cursor: 0,
        native_head_sequence: head,
        checkpoint_digest: hex_sha256(&checkpoint),
        limits: OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 60_000,
        },
    };
    (dir, store, observed, checkpoint)
}

fn input(
    store: &EngineStore,
    observed: &ObservedOwnerBinding,
    checkpoint: Vec<u8>,
) -> OwnerEnrollmentInput {
    let host = Ydoc::wire();
    host.apply(&checkpoint).unwrap();
    OwnerEnrollmentInput {
        binding: observed.binding.clone(),
        relay_database_namespace: "relay".into(),
        captured: store
            .read_with(|conn| capture_in(conn, &observed.binding))
            .unwrap(),
        journal_cursor: 9,
        checkpoint,
        host_vector: host.encode_state_vector(),
    }
}
fn enroll(
    store: &mut EngineStore,
    input: &OwnerEnrollmentInput,
    limits: &OwnerOutboxLimits,
) -> Result<OwnerDraftDescriptor, OwnerOutboxError> {
    match store.write_with(&NoFaults, |tx| {
        enroll_in_tx(tx, "workspace", input, limits, 10)
    })? {
        TxnOutcome::Committed(draft) => Ok(draft),
        _ => panic!("unexpected fault"),
    }
}
fn remote_changes(store: &EngineStore) -> i64 {
    store
        .read_with(|c| dohc_engine_storage::remote_changes_applied_in(c, "workspace"))
        .unwrap()
}

/// A host checkpoint holding another computer's edit replaces the native
/// state with changes this computer never had: one change from elsewhere.
#[test]
fn enrollment_onto_a_checkpoint_with_changes_from_elsewhere_counts_once() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    let remote = Ydoc::wire();
    remote.apply(&checkpoint).unwrap();
    remote.richdoc_append_paragraph("another computer's edit");
    let input = input(&store, &observed, bounded(&remote).unwrap());
    enroll(&mut store, &input, &observed.limits).unwrap();
    assert_eq!(remote_changes(&store), 1);
}
#[test]
fn converged_enrollment_reopens_without_pending_and_uncertain_retry_discovers_commit() {
    let (dir, mut store, observed, checkpoint) = fixture();
    let input = input(&store, &observed, checkpoint.clone());
    let result = enroll(&mut store, &input, &observed.limits).unwrap();
    assert_eq!(result.pending_bytes, 0);
    assert!(result.outbox_id.is_none());
    assert_eq!(remote_changes(&store), 0, "the host had nothing new");
    assert!(enroll(&mut store, &input, &observed.limits).is_err());
    drop(store);
    let store = EngineStore::open(&dir.join("engine.db"), 11).unwrap();
    assert!(matches!(
        store
            .read_with(|conn| prepare_in(conn, &observed.binding, "relay"))
            .unwrap(),
        OwnerEnrollmentPreparation::Observed { .. }
    ));
    assert_eq!(
        store
            .read_with(|conn| bounded(&open_draft_in(conn, &observed.binding, 1)?.doc))
            .unwrap(),
        checkpoint
    );
}
#[test]
fn divergent_enrollment_retains_exact_local_state_and_replaces_only_accepted_native_state() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    let key = key(&observed.binding).unwrap();
    let local = Ydoc::wire();
    local.apply(&checkpoint).unwrap();
    let delta = local.richdoc_append_paragraph("private pending edit");
    store
        .write_with(&NoFaults, |tx| {
            crate::record_update_in_tx(tx, &key, &delta, None, None, 3)
        })
        .unwrap();
    let input = input(&store, &observed, checkpoint.clone());
    let local_bytes = bounded(&local).unwrap();
    let result = enroll(&mut store, &input, &observed.limits).unwrap();
    assert_eq!(result.pending_bytes, local_bytes.len() as i64);
    assert_eq!(
        remote_changes(&store),
        0,
        "only this computer's pending edit differs"
    );
    assert!(result.native_head_sequence > input.captured.native_head_sequence);
    store
        .read_with(|conn| {
            assert_eq!(
                bounded(&crate::load_doc_in(conn, &key).map_err(collab)?).unwrap(),
                checkpoint
            );
            assert_eq!(
                bounded(&open_draft_in(conn, &observed.binding, 1)?.doc).unwrap(),
                local_bytes
            );
            let digest: String = conn
                .query_row(
                    "SELECT update_digest FROM owner_ydoc_outbox_entries",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(bounded_blob(conn, &digest).unwrap(), local_bytes);
            let snapshots: i64 = conn
                .query_row(
                    "SELECT count(*) FROM ydoc_snapshots WHERE up_to_seq=0",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(snapshots, 1);
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
}
#[test]
fn bad_cut_capture_race_and_capacity_failure_leave_original_work_unchanged() {
    for failure in ["vector", "lineage", "capture", "capacity"] {
        let (_dir, mut store, observed, checkpoint) = fixture();
        let key = key(&observed.binding).unwrap();
        let local = Ydoc::wire();
        local.apply(&checkpoint).unwrap();
        let delta = local.richdoc_append_paragraph("must survive rejection");
        store
            .write_with(&NoFaults, |tx| {
                crate::record_update_in_tx(tx, &key, &delta, None, None, 3)
            })
            .unwrap();
        let mut input = input(&store, &observed, checkpoint);
        let mut limits = observed.limits.clone();
        match failure {
            "vector" => input.host_vector = vec![0],
            "lineage" => {
                let unrelated = Ydoc::wire();
                unrelated.richdoc_append_paragraph("unrelated");
                input.checkpoint = bounded(&unrelated).unwrap();
                input.host_vector = unrelated.encode_state_vector();
            }
            "capture" => input.captured.native_head_sequence += 1,
            "capacity" => limits.max_pending_bytes = 1,
            _ => unreachable!(),
        }
        assert!(enroll(&mut store, &input, &limits).is_err(), "{failure}");
        store
            .read_with(|conn| {
                assert_eq!(
                    bounded(&crate::load_doc_in(conn, &key).map_err(collab)?).unwrap(),
                    bounded(&local).unwrap()
                );
                assert!(super::super::draft::descriptor_for_key_in(conn, &key)?.is_none());
                let count: i64 = conn
                    .query_row("SELECT count(*) FROM owner_ydoc_outbox_entries", [], |r| {
                        r.get(0)
                    })
                    .unwrap();
                assert_eq!(count, 0);
                Ok::<_, OwnerOutboxError>(())
            })
            .unwrap();
    }
}

/// An enrolled owner with an unsent draft, and the host checkpoint of a later
/// restore generation that does not contain that draft.
fn enrolled_with_unsent_draft() -> (
    ScratchDir,
    EngineStore,
    ObservedOwnerBinding,
    Vec<u8>,
    Vec<u8>,
    Vec<u8>,
) {
    let (dir, mut store, observed, checkpoint) = fixture();
    let first = input(&store, &observed, checkpoint.clone());
    enroll(&mut store, &first, &observed.limits).unwrap();
    let draft = Ydoc::wire();
    draft.apply(&checkpoint).unwrap();
    let unsent = draft.richdoc_append_paragraph("unsent before restore");
    store
        .write_with(&NoFaults, |tx| {
            super::super::draft::append_draft_in_tx(
                tx,
                "workspace",
                &observed.binding,
                1,
                "unsent".into(),
                unsent.clone(),
                5,
            )
        })
        .unwrap();
    let host = Ydoc::wire();
    host.apply(&checkpoint).unwrap();
    host.richdoc_append_paragraph("restored on the host");
    (
        dir,
        store,
        observed,
        checkpoint,
        unsent,
        bounded(&host).unwrap(),
    )
}
fn next_generation(observed: &ObservedOwnerBinding) -> LiveObjectBinding {
    LiveObjectBinding {
        restore_fence_generation: observed.binding.restore_fence_generation + 1,
        ..observed.binding.clone()
    }
}
fn successor_input(
    store: &EngineStore,
    binding: &LiveObjectBinding,
    checkpoint: Vec<u8>,
) -> OwnerEnrollmentInput {
    let captured = match store
        .read_with(|conn| prepare_in(conn, binding, "relay"))
        .unwrap()
    {
        OwnerEnrollmentPreparation::Capture { captured } => captured,
        OwnerEnrollmentPreparation::Observed { .. } => {
            panic!("a later restore generation captures before it commits")
        }
    };
    let host = Ydoc::wire();
    host.apply(&checkpoint).unwrap();
    OwnerEnrollmentInput {
        binding: binding.clone(),
        relay_database_namespace: "relay".into(),
        captured,
        journal_cursor: 12,
        checkpoint,
        host_vector: host.encode_state_vector(),
    }
}
fn old_generation_queue(conn: &Connection) -> (String, Option<String>, Option<String>, Vec<u8>) {
    let (state, reason, observed, digest): (String, Option<String>, Option<String>, String) = conn.query_row(
        "SELECT o.state,o.quarantine_reason,o.observed_binding_json,e.update_blob_digest FROM owner_ydoc_outboxes o JOIN owner_ydoc_outbox_entries e USING(outbox_id) WHERE o.restore_fence_generation=0 AND e.pending=1",
        [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
    (
        state,
        reason,
        observed,
        bounded_blob(conn, &digest).unwrap(),
    )
}

#[test]
fn later_restore_generation_installs_the_host_checkpoint_and_quarantines_unsent_work() {
    let (_dir, mut store, observed, checkpoint, unsent, host) = enrolled_with_unsent_draft();
    let key = key(&observed.binding).unwrap();
    let next = next_generation(&observed);
    let input = successor_input(&store, &next, host.clone());
    // Preparation only captured: the old generation is still the observed one.
    assert_eq!(
        store
            .read_with(|conn| super::super::draft::descriptor_for_key_in(conn, &key))
            .unwrap()
            .unwrap()
            .binding,
        observed.binding
    );
    let result = enroll(&mut store, &input, &observed.limits).unwrap();
    assert_eq!(
        (
            result.binding.clone(),
            result.revision,
            result.accepted_cursor
        ),
        (next.clone(), 2, 12)
    );
    assert_eq!((result.outbox_id, result.pending_bytes), (None, 0));
    store
        .read_with(|conn| {
            assert_eq!(
                bounded(&crate::load_doc_in(conn, &key).map_err(collab)?)?,
                host
            );
            assert_eq!(
                bounded(&open_draft_in(conn, &next, 2)?.doc)?,
                host,
                "the unsent draft is not merged into the restore"
            );
            let (state, reason, recorded, preserved) = old_generation_queue(conn);
            assert_eq!(
                (state.as_str(), reason.as_deref()),
                ("quarantined", Some("restore-fenced"))
            );
            assert_eq!(
                serde_json::from_str::<LiveObjectBinding>(&recorded.unwrap()).unwrap(),
                next
            );
            assert_eq!(preserved, unsent);
            assert_ne!(host, checkpoint);
            assert!(matches!(
                prepare_in(conn, &next, "relay")?,
                OwnerEnrollmentPreparation::Observed { .. }
            ));
            assert!(
                prepare_in(conn, &observed.binding, "relay").is_err(),
                "a generation never moves backwards"
            );
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    assert!(
        enroll(&mut store, &input, &observed.limits).is_err(),
        "the committed transition does not replay"
    );
}

#[test]
fn restore_generation_refuses_another_namespace_or_document_identity() {
    let (_dir, store, observed, ..) = enrolled_with_unsent_draft();
    let next = next_generation(&observed);
    let moved = LiveObjectBinding {
        current_path: "other.md".into(),
        selector_paths: vec!["other.md".into()],
        ..next.clone()
    };
    let same_generation = LiveObjectBinding {
        restore_fence_generation: observed.binding.restore_fence_generation,
        ..moved.clone()
    };
    store
        .read_with(|conn| {
            assert!(prepare_in(conn, &next, "other-relay").is_err());
            assert!(prepare_in(conn, &moved, "relay").is_err());
            assert!(prepare_in(conn, &same_generation, "relay").is_err());
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
}

#[test]
fn refused_restore_generation_leaves_the_old_generation_and_its_unsent_work() {
    for failure in ["vector", "capture", "cursor", "namespace"] {
        let (_dir, mut store, observed, checkpoint, unsent, host) = enrolled_with_unsent_draft();
        let key = key(&observed.binding).unwrap();
        let mut input = successor_input(&store, &next_generation(&observed), host);
        match failure {
            "vector" => input.host_vector = vec![0],
            "capture" => input.captured.native_head_sequence += 1,
            "cursor" => input.journal_cursor = 8,
            "namespace" => input.relay_database_namespace = "other-relay".into(),
            _ => unreachable!(),
        }
        assert!(
            enroll(&mut store, &input, &observed.limits).is_err(),
            "{failure}"
        );
        store
            .read_with(|conn| {
                let draft = super::super::draft::descriptor_for_key_in(conn, &key)?.unwrap();
                assert_eq!(
                    (draft.binding, draft.revision, draft.accepted_cursor),
                    (observed.binding.clone(), 1, 9)
                );
                assert_eq!(
                    bounded(&crate::load_doc_in(conn, &key).map_err(collab)?)?,
                    checkpoint
                );
                let (state, reason, _, preserved) = old_generation_queue(conn);
                assert_eq!((state.as_str(), reason), ("active", None));
                assert_eq!(preserved, unsent);
                Ok::<_, OwnerOutboxError>(())
            })
            .unwrap();
    }
}

#[test]
fn enrollment_folds_unsettled_authors_before_removing_native_update_rows() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    let key = key(&observed.binding).unwrap();
    let local = Ydoc::wire();
    local.apply(&checkpoint).unwrap();
    let delta = local.richdoc_append_paragraph("attributed private edit");
    let attribution = dohc_engine_domain::ChangeAttribution {
        actor_kind: dohc_engine_domain::ChangeActorKind::Agent,
        on_behalf_of: Some("person".into()),
        depth: 2,
        run: None,
    };
    store
        .write_with(&NoFaults, |tx| {
            crate::record_update_in_tx(tx, &key, &delta, Some("writer"), Some(&attribution), 3)
        })
        .unwrap();
    let before = store
        .read_with(|conn| crate::author_coverage::interval_in(conn, &key, i64::MAX))
        .unwrap()
        .json();
    assert!(before.contains("writer"));
    let enrollment = input(&store, &observed, checkpoint);
    let enrolled = enroll(&mut store, &enrollment, &observed.limits).unwrap();
    assert!(
        enrolled.pending_bytes > 0,
        "private content stays in its outbox"
    );
    let (rows, pending, attempt): (i64, String, Option<i64>) = store.read_with(|conn| {
        conn.query_row("SELECT (SELECT COUNT(*) FROM ydoc_updates),pending_authors_json,settle_prior_update_seq FROM ydoc_docs", [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(read_sql)
    }).unwrap();
    assert_eq!(rows, 0);
    assert_eq!(
        pending, before,
        "removed update authors remain available for settlement"
    );
    assert_eq!(attempt, None);
}
