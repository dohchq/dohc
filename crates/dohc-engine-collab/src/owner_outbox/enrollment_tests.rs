use super::*;
use crate::{owner_outbox::draft::open_draft_in, DocKey};
use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_test_scratch::ScratchDir;

#[test]
#[ignore = "paired release measurement"]
fn measure_adopted_owner_apply_per_row() {
    use crate::owner_outbox::accepted::{apply_frame_in_tx, OwnerAcceptedFrameInput};
    let mut samples = Vec::new();
    for _ in 0..21 {
        let (_dir, mut store, observed, baseline) = fixture();
        let enrollment = input(&store, &observed, baseline.clone());
        enroll(&mut store, &enrollment, &observed.limits).unwrap();
        let observed = store
            .read_with(|conn| super::super::draft::read_observed_in(conn, &observed.binding))
            .unwrap()
            .unwrap();
        let doc = crate::Ydoc::wire();
        doc.apply(&baseline).unwrap();
        let mut position = (
            observed.revision,
            observed.native_head_sequence,
            observed.accepted_cursor,
        );
        let mut elapsed = 0.0;
        for _ in 0..100 {
            let input = OwnerAcceptedFrameInput {
                binding: observed.binding.clone(),
                relay_database_namespace: "relay".into(),
                expected_revision: position.0,
                expected_native_head_sequence: position.1,
                previous_accepted_cursor: position.2,
                journal_cursor: position.2 + 1,
                update_bytes: doc.richdoc_append_paragraph("Applied paragraph."),
            };
            let start = std::time::Instant::now();
            let result = store
                .write_with(&NoFaults, |tx| {
                    apply_frame_in_tx(tx, "workspace", &input, 11)
                })
                .unwrap();
            elapsed += start.elapsed().as_secs_f64() * 1_000_000.0;
            let dohc_engine_storage::TxnOutcome::Committed(r) = result else {
                panic!("committed")
            };
            position = (r.revision, r.native_head_sequence, r.accepted_cursor);
        }
        samples.push(elapsed / 100.0);
    }
    samples.sort_by(f64::total_cmp);
    println!(
        "ADOPTED_APPLY_US_PER_ROW median={} p95={} samples=21 rows=100",
        samples[10], samples[19]
    );
}

fn fixture() -> (ScratchDir, EngineStore, ObservedOwnerBinding, Vec<u8>) {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let original: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
    fixture_with_source(&original, fixture["markdown"].as_str().unwrap(), "owner.md")
}

fn fixture_with_source(
    original: &[u8],
    markdown: &str,
    path: &str,
) -> (ScratchDir, EngineStore, ObservedOwnerBinding, Vec<u8>) {
    let dir = ScratchDir::new_named("observed-owner-draft").unwrap();
    let mut store = EngineStore::open(&dir.join("engine.db"), 0).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 0, &NoFaults)
        .unwrap();
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: path.into(),
                text: markdown.into(),
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
        original,
        &NoFaults,
        2,
    )
    .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET path=?1", [path]).unwrap();
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
            lineage_claim_id: hex_sha256(original),
            current_path: path.into(),
            selector_paths: vec![path.into()],
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
        recovery: false,
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

fn collection_fixture() -> (ScratchDir, EngineStore, ObservedOwnerBinding, Vec<u8>, Ydoc) {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let original: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
    let local = Ydoc::with_client_id(1);
    local.apply(&original).unwrap();
    local
        .frontmatter_set("id", "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa")
        .unwrap();
    local.frontmatter_set("title", "Original").unwrap();
    local.frontmatter_set("status", "open").unwrap();
    let markdown = local.project(crate::ContentKind::Richdoc).unwrap().content;
    let (dir, mut store, observed, checkpoint) =
        fixture_with_source(&bounded(&local).unwrap(), &markdown, "tasks/owner.md");
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "schema".into(),
                path: "tasks/collection.yaml".into(),
                text: "fields:\n  title:\n    type: text\n  status:\n    type: text\n  priority:\n    type: text\n".into(),
                moment_id: "schema".into(),
                metadata_origin: "user".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, "workspace", "main")
        })
        .unwrap();
    let vector = local.encode_state_vector();
    local.frontmatter_set("title", "Edited title").unwrap();
    local.frontmatter_set("status", "done").unwrap();
    store
        .write_with(&NoFaults, |tx| {
            crate::record_update_in_tx(
                tx,
                &key(&observed.binding).unwrap(),
                &local.diff(&vector).unwrap(),
                Some("person"),
                None,
                3,
            )
        })
        .unwrap();
    (dir, store, observed, checkpoint, local)
}

type FieldHistoryRow = (String, Option<String>, Option<String>, Option<String>);

fn field_history(store: &EngineStore) -> Vec<FieldHistoryRow> {
    store
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT field_name,previous_value_json,next_value_json,author_origin_id \
             FROM collection_field_history WHERE workspace_id='workspace' \
               AND version_id='main' AND record_id='rec_aaaaaaaaaaaaaaaaaaaaaaaaaa' \
             ORDER BY history_id",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<Result<Vec<_>, _>>();
            rows
        })
        .unwrap()
}

fn assert_visible_fields(
    store: &EngineStore,
    binding: &LiveObjectBinding,
    expected: serde_json::Value,
) {
    store
        .read_with(|conn| {
            let indexed =
                dohc_engine_domain::collections::indexed_collection_record_frontmatter_in_tx(
                    conn,
                    "workspace",
                    "main",
                    "object",
                )
                .unwrap()
                .unwrap();
            assert_eq!(indexed, expected);
            let observed = super::super::draft::read_observed_in(conn, binding)?.unwrap();
            let draft = open_draft_in(conn, binding, observed.revision)?;
            let mut visible = draft.doc.frontmatter_json();
            visible.as_object_mut().unwrap().remove("id");
            assert_eq!(indexed, visible, "the index must follow the visible draft");
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
}

fn accept_field_frame(store: &mut EngineStore, binding: &LiveObjectBinding, bytes: Vec<u8>) {
    use crate::owner_outbox::accepted::{apply_frame_in_tx, OwnerAcceptedFrameInput};
    let observed = store
        .read_with(|conn| super::super::draft::read_observed_in(conn, binding))
        .unwrap()
        .unwrap();
    let input = OwnerAcceptedFrameInput {
        binding: binding.clone(),
        relay_database_namespace: "relay".into(),
        expected_revision: observed.revision,
        expected_native_head_sequence: observed.native_head_sequence,
        previous_accepted_cursor: observed.accepted_cursor,
        journal_cursor: observed.accepted_cursor + 1,
        update_bytes: bytes,
    };
    for _ in 0..2 {
        store
            .write_with(&NoFaults, |tx| {
                apply_frame_in_tx(tx, "workspace", &input, 11)
            })
            .unwrap();
    }
}

fn refuse_field_entry(
    store: &mut EngineStore,
    outbox: &str,
    entry: &super::super::OwnerOutboxEntry,
) {
    let refusal = super::super::OwnerOutboxRefuseInput {
        outbox_id: outbox.into(),
        delivery_id: entry.delivery_id.clone(),
        update_digest: entry.update_digest.clone(),
        reason: "The presser no longer has edit access.".into(),
    };
    for _ in 0..2 {
        store
            .write_with(&NoFaults, |tx| {
                super::super::refuse_entry_in_tx(tx, "workspace", &refusal, 12)
            })
            .unwrap();
    }
    store
        .read_with(|conn| {
            let reason: String = conn
                .query_row(
                    "SELECT terminal_reason FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                    [&entry.delivery_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(reason, refusal.reason);
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
}

#[test]
fn first_enrollment_own_draft_acceptance_keeps_each_field_edit_once() {
    let (_dir, mut store, observed, checkpoint, local) = collection_fixture();
    let history = field_history(&store);
    assert_eq!(history.len(), 2);
    assert!(history.iter().all(|row| row.3.as_deref() == Some("person")));
    let enrollment = input(&store, &observed, checkpoint);
    let enrolled = enroll(&mut store, &enrollment, &observed.limits).unwrap();
    assert!(enrolled.pending_bytes > 0);
    assert_eq!(field_history(&store), history);
    let pending =
        super::super::read_pending(&store, "workspace", enrolled.outbox_id.as_ref().unwrap())
            .unwrap();
    assert_eq!(pending.entries[0].update, bounded(&local).unwrap());
    accept_field_frame(
        &mut store,
        &observed.binding,
        pending.entries[0].update.clone(),
    );
    assert_eq!(
        field_history(&store),
        history,
        "an accepted own-draft echo must not duplicate History"
    );
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title", "status":"done"}),
    );
    super::super::acknowledge(
        &mut store,
        "workspace",
        &pending.outbox_id,
        &[super::super::OwnerDeliveryReceipt {
            delivery_id: pending.entries[0].delivery_id.clone(),
            update_digest: pending.entries[0].update_digest.clone(),
            journal_cursor: enrollment.journal_cursor + 1,
            accepting_host_epoch: 1,
        }],
    )
    .unwrap();
    assert_eq!(field_history(&store), history);
    accept_field_frame(
        &mut store,
        &observed.binding,
        local.frontmatter_set("status", "review").unwrap(),
    );
    let after = field_history(&store);
    assert_eq!(&after[..2], &history);
    assert_eq!(after.len(), 3);
    assert_eq!(
        after[2],
        (
            "status".into(),
            Some("\"done\"".into()),
            Some("\"review\"".into()),
            None
        )
    );
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title", "status":"review"}),
    );
}

#[test]
fn first_enrollment_refusal_reverts_fields_once_with_a_refusal_actor() {
    let (_dir, mut store, observed, checkpoint, _) = collection_fixture();
    let enrollment = input(&store, &observed, checkpoint.clone());
    let enrolled = enroll(&mut store, &enrollment, &observed.limits).unwrap();
    let pending =
        super::super::read_pending(&store, "workspace", enrolled.outbox_id.as_ref().unwrap())
            .unwrap();
    refuse_field_entry(&mut store, &pending.outbox_id, &pending.entries[0]);
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Original", "status":"open"}),
    );
    let history = field_history(&store);
    assert_eq!(history.len(), 4);
    assert_eq!(
        &history[2..],
        &[
            (
                "status".into(),
                Some("\"done\"".into()),
                Some("\"open\"".into()),
                Some("owner-draft-refusal".into())
            ),
            (
                "title".into(),
                Some("\"Edited title\"".into()),
                Some("\"Original\"".into()),
                Some("owner-draft-refusal".into())
            ),
        ]
    );
    let host = Ydoc::wire();
    host.apply(&checkpoint).unwrap();
    accept_field_frame(
        &mut store,
        &observed.binding,
        host.richdoc_append_paragraph("a later host frame"),
    );
    assert_eq!(
        field_history(&store),
        history,
        "a later frame must not silently repair the index"
    );
}

#[test]
fn first_enrollment_remote_checkpoint_records_only_the_remote_field_change() {
    let (_dir, mut store, observed, checkpoint, _) = collection_fixture();
    let host = Ydoc::wire();
    host.apply(&checkpoint).unwrap();
    host.frontmatter_set("priority", "high").unwrap();
    let enrollment = input(&store, &observed, bounded(&host).unwrap());
    let enrolled = enroll(&mut store, &enrollment, &observed.limits).unwrap();
    let history = field_history(&store);
    assert_eq!(history.len(), 3);
    assert_eq!(
        history[2],
        ("priority".into(), None, Some("\"high\"".into()), None)
    );
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title", "status":"done", "priority":"high"}),
    );
    let pending =
        super::super::read_pending(&store, "workspace", enrolled.outbox_id.as_ref().unwrap())
            .unwrap();
    accept_field_frame(
        &mut store,
        &observed.binding,
        pending.entries[0].update.clone(),
    );
    assert_eq!(field_history(&store), history);
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title", "status":"done", "priority":"high"}),
    );
}

#[test]
fn first_enrollment_accept_echo_preserves_later_draft_fields_until_refusal() {
    use crate::owner_outbox::draft::{append_draft_cached, OwnerDraftAppendInput};
    let (_dir, mut store, observed, checkpoint, local) = collection_fixture();
    let enrollment = input(&store, &observed, checkpoint);
    let enrolled = enroll(&mut store, &enrollment, &observed.limits).unwrap();
    let initial = bounded(&local).unwrap();
    let mut cache = crate::WriterDocCache::new();
    let input = OwnerDraftAppendInput {
        person_edit: false,
        binding: observed.binding.clone(),
        expected_revision: enrolled.revision,
        append_key: "agent-status".into(),
        update: local.frontmatter_set("status", "blocked").unwrap(),
        now_ms: 11,
        agent_declaration: Some(dohc_engine_domain::AgentDeclaration {
            agent_id: "writer".into(),
            on_behalf_of: Some("person".into()),
            depth: 1,
        }),
        automation_declaration: None,
    };
    let entry = append_draft_cached(
        &mut store,
        &mut cache,
        "workspace",
        input.clone(),
        &NoFaults,
    )
    .unwrap();
    append_draft_cached(&mut store, &mut cache, "workspace", input, &NoFaults).unwrap();
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title", "status":"blocked"}),
    );
    let history = field_history(&store);
    assert_eq!(history.len(), 3);
    assert_eq!(
        history[2],
        (
            "status".into(),
            Some("\"done\"".into()),
            Some("\"blocked\"".into()),
            Some("writer".into())
        )
    );
    accept_field_frame(&mut store, &observed.binding, initial);
    assert_eq!(field_history(&store), history);
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title", "status":"blocked"}),
    );
    let host = store
        .read_with(|conn| crate::load_doc_in(conn, &key(&observed.binding).unwrap()))
        .unwrap();
    accept_field_frame(
        &mut store,
        &observed.binding,
        host.frontmatter_set("priority", "high").unwrap(),
    );
    let after_remote = field_history(&store);
    assert_eq!(&after_remote[..3], &history);
    assert_eq!(after_remote.len(), 4);
    assert_eq!(
        after_remote[3],
        ("priority".into(), None, Some("\"high\"".into()), None)
    );
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title", "status":"blocked", "priority":"high"}),
    );
    let pending = super::super::read_pending(&store, "workspace", &entry.outbox_id).unwrap();
    let later = pending
        .entries
        .iter()
        .find(|pending| pending.delivery_id == entry.delivery_id)
        .unwrap();
    refuse_field_entry(&mut store, &entry.outbox_id, later);
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title", "status":"done", "priority":"high"}),
    );
    let after_refusal = field_history(&store);
    assert_eq!(&after_refusal[..4], &after_remote);
    assert_eq!(after_refusal.len(), 5);
    assert_eq!(
        after_refusal[4],
        (
            "status".into(),
            Some("\"blocked\"".into()),
            Some("\"done\"".into()),
            Some("owner-draft-refusal".into())
        )
    );
}

#[test]
fn first_enrollment_refusal_preserves_an_independent_pending_field_edit() {
    let (_dir, mut store, observed, checkpoint, _) = collection_fixture();
    let enrollment = input(&store, &observed, checkpoint.clone());
    let enrolled = enroll(&mut store, &enrollment, &observed.limits).unwrap();
    let independent = Ydoc::wire();
    independent.apply(&checkpoint).unwrap();
    let update = independent.frontmatter_set("priority", "high").unwrap();
    store
        .write_with(&NoFaults, |tx| {
            super::super::draft::append_draft_in_tx(
                tx,
                "workspace",
                &observed.binding,
                enrolled.revision,
                "independent-priority".into(),
                update,
                11,
            )
        })
        .unwrap();
    let pending =
        super::super::read_pending(&store, "workspace", enrolled.outbox_id.as_ref().unwrap())
            .unwrap();
    assert_eq!(pending.entries.len(), 2);
    refuse_field_entry(&mut store, &pending.outbox_id, &pending.entries[0]);
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Original", "status":"open", "priority":"high"}),
    );
    let remaining = super::super::read_pending(&store, "workspace", &pending.outbox_id).unwrap();
    assert_eq!(remaining.entries.len(), 1);
    assert_eq!(
        remaining.entries[0].delivery_id,
        pending.entries[1].delivery_id
    );
    let history = field_history(&store);
    assert_eq!(history.len(), 5);
    assert_eq!(history.iter().filter(|row| row.0 == "priority").count(), 1);
    assert_eq!(
        history
            .iter()
            .filter(|row| row.3.as_deref() == Some("owner-draft-refusal"))
            .count(),
        2
    );
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
            .read_with(|conn| prepare_in(conn, &observed.binding, "relay", false))
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

#[test]
fn a_refused_queue_reads_its_accepted_checkpoint_as_its_own_part() {
    use super::super::{
        read_pending_page, OwnerOutboxPageResult, OwnerOutboxReadCursor, OwnerOutboxReadPart,
    };
    let (_dir, mut store, _observed, _checkpoint, _unsent, _host) = enrolled_with_unsent_draft();
    let outbox_id: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id FROM owner_ydoc_outbox_entries WHERE append_key='unsent'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    super::super::quarantine(
        &mut store,
        "workspace",
        OwnerOutboxQuarantineInput {
            outbox_id: outbox_id.clone(),
            reason: "invalid-update".into(),
            observed_binding: None,
        },
        20,
    )
    .unwrap();
    let (digest, accepted): (String, Vec<u8>) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.checkpoint_digest,blob.bytes FROM ydoc_owner_bindings b JOIN binary_blobs blob ON blob.sha256=b.checkpoint_digest",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    let read = |cursor: Option<OwnerOutboxReadCursor>, budget: usize| match read_pending_page(
        &store,
        "workspace",
        &outbox_id,
        cursor,
        budget,
    )
    .unwrap()
    {
        OwnerOutboxPageResult::Page(page) => page,
        OwnerOutboxPageResult::ReadChanged => panic!("unchanged snapshot"),
    };
    let header = read(None, 4096);
    let raw: serde_json::Value = serde_json::from_slice(&header.bytes).unwrap();
    assert_eq!(raw["checkpointDigest"], serde_json::json!(digest));
    let mut cursor = Some(OwnerOutboxReadCursor {
        snapshot: header.cursor.snapshot.clone(),
        part: OwnerOutboxReadPart::Checkpoint,
        sequence: 0,
        offset: 0,
    });
    let mut bytes = Vec::new();
    while let Some(next) = cursor {
        let page = read(Some(next), 7);
        assert_eq!(page.digest, digest);
        bytes.extend(page.bytes);
        cursor = page.next_cursor;
    }
    assert_eq!(bytes, accepted);
}

#[test]
fn a_checkpoint_that_changes_between_pages_changes_the_read() {
    use super::super::{
        read_pending_page, OwnerOutboxPageResult, OwnerOutboxReadCursor, OwnerOutboxReadPart,
    };
    let (_dir, mut store, _observed, checkpoint, _unsent, _host) = enrolled_with_unsent_draft();
    let outbox_id: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id FROM owner_ydoc_outbox_entries WHERE append_key='unsent'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let OwnerOutboxPageResult::Page(header) =
        read_pending_page(&store, "workspace", &outbox_id, None, 4096).unwrap()
    else {
        panic!("a first read never changed")
    };
    let first = OwnerOutboxReadCursor {
        snapshot: header.cursor.snapshot.clone(),
        part: OwnerOutboxReadPart::Checkpoint,
        sequence: 0,
        offset: 0,
    };
    let OwnerOutboxPageResult::Page(page) =
        read_pending_page(&store, "workspace", &outbox_id, Some(first), 1).unwrap()
    else {
        panic!("the checkpoint has not changed yet")
    };
    // The binding's checkpoint changes to a shorter state between pages.
    let shorter = bounded(&Ydoc::wire()).unwrap();
    assert!(shorter.len() > 1 && shorter.len() < checkpoint.len());
    store
        .write_with(&NoFaults, |tx| {
            let digest = hex_sha256(&shorter);
            put_binary_blob_with_sha(tx, &shorter, &digest)?;
            tx.execute(
                "UPDATE ydoc_owner_bindings SET checkpoint_digest=?1",
                [&digest],
            )
            .map_err(write_sql)?;
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    // Within the new bytes the page names their digest, which the client reads as a change.
    let within = page.next_cursor.clone().unwrap();
    assert_eq!(within.offset, 1);
    let OwnerOutboxPageResult::Page(changed) =
        read_pending_page(&store, "workspace", &outbox_id, Some(within.clone()), 4096).unwrap()
    else {
        panic!("an offset within the new checkpoint still reads")
    };
    assert_ne!(changed.digest, page.digest);
    // Past them the engine answers that the read changed, not that the cursor is invalid.
    let beyond = OwnerOutboxReadCursor {
        offset: i64::try_from(shorter.len()).unwrap(),
        ..within
    };
    assert!(matches!(
        read_pending_page(&store, "workspace", &outbox_id, Some(beyond), 4096).unwrap(),
        OwnerOutboxPageResult::ReadChanged
    ));
}

#[test]
fn a_queue_of_an_earlier_restore_generation_reads_its_own_checkpoint_never_its_successors() {
    use super::super::{
        read_pending_page, OwnerOutboxPageResult, OwnerOutboxReadCursor, OwnerOutboxReadPart,
    };
    let (_dir, mut store, observed, _checkpoint, _unsent, host) = enrolled_with_unsent_draft();
    let outbox_id: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id FROM owner_ydoc_outbox_entries WHERE append_key='unsent'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let header = |store: &EngineStore| {
        let OwnerOutboxPageResult::Page(page) =
            read_pending_page(store, "workspace", &outbox_id, None, 4096).unwrap()
        else {
            panic!("a first read never changed")
        };
        let raw: serde_json::Value = serde_json::from_slice(&page.bytes).unwrap();
        (page.cursor.snapshot, raw)
    };
    let own: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT checkpoint_digest FROM ydoc_owner_bindings",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(header(&store).1["checkpointDigest"], serde_json::json!(own));
    let next = next_generation(&observed);
    let input = successor_input(&store, &next, host.clone());
    enroll(&mut store, &input, &observed.limits).unwrap();
    // The older queue still waits and keeps the checkpoint it builds on; the successor's need not hold it.
    let (snapshot, raw) = header(&store);
    assert_eq!(
        raw["binding"],
        serde_json::to_value(&observed.binding).unwrap()
    );
    assert!(raw["pendingEntryCount"].as_i64().unwrap() >= 1);
    assert_eq!(raw["checkpointDigest"], serde_json::json!(own));
    assert_ne!(own, hex_sha256(&host));
    let mut cursor = Some(OwnerOutboxReadCursor {
        snapshot,
        part: OwnerOutboxReadPart::Checkpoint,
        sequence: 0,
        offset: 0,
    });
    let mut bytes = Vec::new();
    while let Some(at) = cursor {
        let OwnerOutboxPageResult::Page(page) =
            read_pending_page(&store, "workspace", &outbox_id, Some(at), 7).unwrap()
        else {
            panic!("a kept checkpoint never changes")
        };
        assert_eq!(page.digest, own);
        bytes.extend(page.bytes);
        cursor = page.next_cursor;
    }
    assert_eq!(hex_sha256(&bytes), own);
}

// An edit that builds on one the server accepted, still waiting when a later
// restore generation replaces the accepted checkpoint. Its base and its own
// bytes cannot rebuild it; with the checkpoint its queue kept, its recovery
// copy can.
#[test]
fn work_on_an_accepted_prefix_rebuilds_from_its_queue_alone_after_a_generation_advance() {
    use super::super::{
        read_pending_page, OwnerOutboxPageResult, OwnerOutboxReadCursor, OwnerOutboxReadPart,
    };
    let (_dir, mut store, observed, checkpoint) = fixture();
    let first = input(&store, &observed, checkpoint.clone());
    enroll(&mut store, &first, &observed.limits).unwrap();
    let edited = Ydoc::wire();
    edited.apply(&checkpoint).unwrap();
    let accepted = edited.richdoc_append_paragraph("accepted prefix");
    accept_field_frame(&mut store, &observed.binding, accepted);
    let dependent = edited.richdoc_append_paragraph("unsent on the accepted prefix");
    let revision = store
        .read_with(|conn| super::super::draft::read_observed_in(conn, &observed.binding))
        .unwrap()
        .unwrap()
        .revision;
    store
        .write_with(&NoFaults, |tx| {
            super::super::draft::append_draft_in_tx(
                tx,
                "workspace",
                &observed.binding,
                revision,
                "dependent".into(),
                dependent.clone(),
                13,
            )
        })
        .unwrap();
    let outbox_id: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id FROM owner_ydoc_outbox_entries WHERE append_key='dependent'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let host = Ydoc::wire();
    host.apply(&checkpoint).unwrap();
    host.richdoc_append_paragraph("restored on the host");
    let restored = successor_input(&store, &next_generation(&observed), bounded(&host).unwrap());
    enroll(&mut store, &restored, &observed.limits).unwrap();
    // Read every part as a recovery copy does: the queue, then its checkpoint.
    let read = |cursor: Option<OwnerOutboxReadCursor>| match read_pending_page(
        &store,
        "workspace",
        &outbox_id,
        cursor,
        4096,
    )
    .unwrap()
    {
        OwnerOutboxPageResult::Page(page) => page,
        OwnerOutboxPageResult::ReadChanged => panic!("nothing changed during the read"),
    };
    let header = read(None);
    let snapshot = header.cursor.snapshot.clone();
    let mut parts: Vec<(OwnerOutboxReadPart, Vec<u8>)> = Vec::new();
    let mut cursor = header.next_cursor;
    while let Some(at) = cursor {
        let page = read(Some(at));
        cursor = page.next_cursor;
        // A later page of the same part continues it.
        if page.cursor.offset > 0 {
            parts.last_mut().unwrap().1.extend(page.bytes);
        } else {
            parts.push((page.cursor.part, page.bytes));
        }
    }
    let part = |wanted: OwnerOutboxReadPart| {
        parts
            .iter()
            .find(|(part, _)| *part == wanted)
            .map(|(_, bytes)| bytes.clone())
            .unwrap()
    };
    let (base, update) = (
        part(OwnerOutboxReadPart::Base),
        part(OwnerOutboxReadPart::Update),
    );
    assert_eq!(update, dependent);
    let mut kept = Vec::new();
    let mut cursor = Some(OwnerOutboxReadCursor {
        snapshot,
        part: OwnerOutboxReadPart::Checkpoint,
        sequence: 0,
        offset: 0,
    });
    while let Some(at) = cursor {
        let page = read(Some(at));
        kept.extend(page.bytes);
        cursor = page.next_cursor;
    }
    let without = Ydoc::wire();
    without.apply(&base).unwrap();
    without.apply(&update).unwrap();
    assert!(
        without.has_pending_dependencies(),
        "the unsent edit builds on the accepted prefix"
    );
    let rebuilt = Ydoc::wire();
    rebuilt.apply(&base).unwrap();
    rebuilt.apply(&kept).unwrap();
    rebuilt.apply(&update).unwrap();
    assert!(!rebuilt.has_pending_dependencies());
    let text = rebuilt
        .project(crate::ContentKind::Richdoc)
        .unwrap()
        .content;
    assert!(text.contains("accepted prefix") && text.contains("unsent on the accepted prefix"));
    assert!(!text.contains("restored on the host"));
}

// The server refused the edit on the accepted prefix before a later restore
// generation arrived. The advance leaves it refused for its own reason, not
// restore-fenced, and its queue keeps the checkpoint it builds on.
#[test]
fn an_already_refused_queue_keeps_its_refusal_and_checkpoint_across_a_generation_advance() {
    use super::super::{
        read_pending_page, OwnerOutboxPageResult, OwnerOutboxReadCursor, OwnerOutboxReadPart,
    };
    let (_dir, mut store, observed, checkpoint) = fixture();
    let first = input(&store, &observed, checkpoint.clone());
    enroll(&mut store, &first, &observed.limits).unwrap();
    let edited = Ydoc::wire();
    edited.apply(&checkpoint).unwrap();
    let accepted = edited.richdoc_append_paragraph("accepted prefix");
    accept_field_frame(&mut store, &observed.binding, accepted);
    let refused = edited.richdoc_append_paragraph("refused on the accepted prefix");
    let revision = store
        .read_with(|conn| super::super::draft::read_observed_in(conn, &observed.binding))
        .unwrap()
        .unwrap()
        .revision;
    store
        .write_with(&NoFaults, |tx| {
            super::super::draft::append_draft_in_tx(
                tx,
                "workspace",
                &observed.binding,
                revision,
                "refused".into(),
                refused.clone(),
                13,
            )
        })
        .unwrap();
    let outbox_id: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id FROM owner_ydoc_outbox_entries WHERE append_key='refused'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    super::super::quarantine(
        &mut store,
        "workspace",
        OwnerOutboxQuarantineInput {
            outbox_id: outbox_id.clone(),
            reason: "invalid-update".into(),
            observed_binding: None,
        },
        20,
    )
    .unwrap();
    let own: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT checkpoint_digest FROM ydoc_owner_bindings",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let host = Ydoc::wire();
    host.apply(&checkpoint).unwrap();
    host.richdoc_append_paragraph("restored on the host");
    let restored = successor_input(&store, &next_generation(&observed), bounded(&host).unwrap());
    enroll(&mut store, &restored, &observed.limits).unwrap();
    let (state, reason, kept): (String, Option<String>, Option<String>) = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT state,quarantine_reason,kept_checkpoint_digest FROM owner_ydoc_outboxes WHERE outbox_id=?1",
                [&outbox_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
        })
        .unwrap();
    assert_eq!(
        (state.as_str(), reason.as_deref(), kept.as_deref()),
        ("quarantined", Some("invalid-update"), Some(own.as_str()))
    );
    let read = |cursor: Option<OwnerOutboxReadCursor>| match read_pending_page(
        &store,
        "workspace",
        &outbox_id,
        cursor,
        4096,
    )
    .unwrap()
    {
        OwnerOutboxPageResult::Page(page) => page,
        OwnerOutboxPageResult::ReadChanged => panic!("nothing changed during the read"),
    };
    let header = read(None);
    let raw: serde_json::Value = serde_json::from_slice(&header.bytes).unwrap();
    assert_eq!(raw["checkpointDigest"], serde_json::json!(own));
    let snapshot = header.cursor.snapshot.clone();
    let mut parts: Vec<(OwnerOutboxReadPart, Vec<u8>)> = Vec::new();
    let mut cursor = header.next_cursor;
    while let Some(at) = cursor {
        let page = read(Some(at));
        cursor = page.next_cursor;
        if page.cursor.offset > 0 {
            parts.last_mut().unwrap().1.extend(page.bytes);
        } else {
            parts.push((page.cursor.part, page.bytes));
        }
    }
    let part = |wanted: OwnerOutboxReadPart| {
        parts
            .iter()
            .find(|(part, _)| *part == wanted)
            .map(|(_, bytes)| bytes.clone())
            .unwrap()
    };
    let (base, update) = (
        part(OwnerOutboxReadPart::Base),
        part(OwnerOutboxReadPart::Update),
    );
    assert_eq!(update, refused);
    let mut kept = Vec::new();
    let mut cursor = Some(OwnerOutboxReadCursor {
        snapshot,
        part: OwnerOutboxReadPart::Checkpoint,
        sequence: 0,
        offset: 0,
    });
    while let Some(at) = cursor {
        let page = read(Some(at));
        kept.extend(page.bytes);
        cursor = page.next_cursor;
    }
    assert_eq!(hex_sha256(&kept), own);
    let rebuilt = Ydoc::wire();
    rebuilt.apply(&base).unwrap();
    rebuilt.apply(&kept).unwrap();
    rebuilt.apply(&update).unwrap();
    assert!(!rebuilt.has_pending_dependencies());
    let text = rebuilt
        .project(crate::ContentKind::Richdoc)
        .unwrap()
        .content;
    assert!(text.contains("accepted prefix") && text.contains("refused on the accepted prefix"));
    assert!(!text.contains("restored on the host"));
}

// As above, with native work past the accepted checkpoint that no pending
// row holds. The advance keeps that work in the refused queue, after its
// refused head, without reopening it: the queue keeps its refusal.
#[test]
fn an_already_refused_queue_keeps_native_work_past_its_checkpoint_across_a_generation_advance() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    let first = input(&store, &observed, checkpoint.clone());
    enroll(&mut store, &first, &observed.limits).unwrap();
    let key = key(&observed.binding).unwrap();
    let edited = Ydoc::wire();
    edited.apply(&checkpoint).unwrap();
    let refused = edited.richdoc_append_paragraph("refused before the restore");
    store
        .write_with(&NoFaults, |tx| {
            super::super::draft::append_draft_in_tx(
                tx,
                "workspace",
                &observed.binding,
                1,
                "refused".into(),
                refused.clone(),
                13,
            )
        })
        .unwrap();
    let outbox_id: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT outbox_id FROM owner_ydoc_outbox_entries WHERE append_key='refused'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    super::super::quarantine(
        &mut store,
        "workspace",
        OwnerOutboxQuarantineInput {
            outbox_id: outbox_id.clone(),
            reason: "invalid-update".into(),
            observed_binding: None,
        },
        20,
    )
    .unwrap();
    let native = Ydoc::wire();
    native.apply(&checkpoint).unwrap();
    let delta = native.richdoc_append_paragraph("native past the checkpoint");
    // An owner binding refuses ordinary writes, so this lands as frames do,
    // and the binding follows the native head as a draft append moves it.
    store
        .write_with(&NoFaults, |tx| {
            crate::durable::record_authorized_update_in_tx(
                tx, &key, &delta, false, None, None, false, 21,
            )
            .map_err(collab)?;
            let head = crate::read_marker_in(tx, &key)
                .map_err(collab)?
                .unwrap()
                .head_update_seq;
            tx.execute(
                "UPDATE ydoc_owner_bindings SET native_head_sequence=?1",
                [head],
            )
            .map_err(write_sql)?;
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    let local = store
        .read_with(|conn| bounded(&crate::load_doc_in(conn, &key).map_err(collab)?))
        .unwrap();
    assert_ne!(local, checkpoint);
    let host = Ydoc::wire();
    host.apply(&checkpoint).unwrap();
    host.richdoc_append_paragraph("restored on the host");
    let restored = successor_input(&store, &next_generation(&observed), bounded(&host).unwrap());
    enroll(&mut store, &restored, &observed.limits).unwrap();
    store
        .read_with(|conn| {
            let (state, reason, retry): (String, Option<String>, Option<String>) = conn
                .query_row(
                    "SELECT state,quarantine_reason,retry_delivery_id FROM owner_ydoc_outboxes WHERE outbox_id=?1",
                    [&outbox_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            assert_eq!(
                (state.as_str(), reason.as_deref(), retry),
                ("quarantined", Some("invalid-update"), None)
            );
            let mut stmt = conn
                .prepare("SELECT append_key,update_blob_digest FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND pending=1 ORDER BY sequence")
                .unwrap();
            let entries = stmt
                .query_map([&outbox_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            let fenced = format!(
                "owner-restore-fenced:{}",
                restored.captured.local_state_digest
            );
            assert_eq!(
                entries.iter().map(|(key, _)| key.as_str()).collect::<Vec<_>>(),
                ["refused", fenced.as_str()]
            );
            assert_eq!(bounded_blob(conn, &entries[1].1)?, local);
            assert_eq!(
                bounded(&crate::load_doc_in(conn, &key).map_err(collab)?)?,
                restored.checkpoint
            );
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
}

#[test]
fn explicit_recovery_keeps_old_writes_refused_and_installs_only_the_host_checkpoint() {
    use super::super::draft::{append_draft_in_tx, write_states_in, OwnerDraftWrite};
    let (dir, mut store, observed, checkpoint, unsent, host) = enrolled_with_unsent_draft();
    let (outbox_id, sequence): (String, i64) = store.read_with(|conn| conn.query_row(
        "SELECT outbox_id,sequence FROM owner_ydoc_outbox_entries WHERE append_key='unsent'", [], |r| Ok((r.get(0)?,r.get(1)?)),
    )).unwrap();
    let write = OwnerDraftWrite {
        outbox_id: Some(outbox_id.clone()),
        binding: observed.binding.clone(),
        native_head_sequence: observed.native_head_sequence,
        append_key: "unsent".into(),
    };
    super::super::quarantine(
        &mut store,
        "workspace",
        OwnerOutboxQuarantineInput {
            outbox_id: outbox_id.clone(),
            reason: "stale-binding".into(),
            observed_binding: None,
        },
        20,
    )
    .unwrap();
    assert!(matches!(
        store
            .read_with(|conn| prepare_in(conn, &observed.binding, "relay", false))
            .unwrap(),
        OwnerEnrollmentPreparation::Observed { .. }
    ));
    let captured = match store
        .read_with(|conn| prepare_in(conn, &observed.binding, "relay", true))
        .unwrap()
    {
        OwnerEnrollmentPreparation::Capture { captured } => captured,
        _ => panic!("recovery needs a fresh authenticated cut"),
    };
    let accepted = Ydoc::wire();
    accepted.apply(&host).unwrap();
    let mut recovery = OwnerEnrollmentInput {
        binding: observed.binding.clone(),
        relay_database_namespace: "relay".into(),
        captured,
        journal_cursor: 12,
        checkpoint: host.clone(),
        host_vector: accepted.encode_state_vector(),
        recovery: true,
    };
    recovery.captured.native_head_sequence += 1;
    assert!(enroll(&mut store, &recovery, &observed.limits).is_err());
    assert_eq!(
        super::super::read_pending(&store, "workspace", &outbox_id)
            .unwrap()
            .entries
            .len(),
        1
    );
    recovery.captured.native_head_sequence -= 1;
    recovery.host_vector = vec![0];
    assert!(enroll(&mut store, &recovery, &observed.limits).is_err());
    recovery.host_vector = accepted.encode_state_vector();
    let draft = enroll(&mut store, &recovery, &observed.limits).unwrap();
    assert_eq!(draft.state.as_deref(), Some("active"));
    assert_eq!(draft.pending_bytes, 0);
    let restored = store
        .read_with(|conn| open_draft_in(conn, &observed.binding, draft.revision))
        .unwrap();
    assert_eq!(bounded(&restored.doc).unwrap(), host);
    assert_ne!(bounded(&restored.doc).unwrap(), checkpoint);
    assert_eq!(
        store
            .read_with(|conn| write_states_in(conn, "workspace", std::slice::from_ref(&write)))
            .unwrap(),
        ["not-accepted"]
    );
    let retained: (String, Vec<u8>) = store.read_with(|conn| {
        let (reason, digest): (String, String) = conn.query_row("SELECT terminal_reason,terminal_blob_digest FROM owner_ydoc_outbox_entries WHERE append_key='unsent'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        Ok::<_,OwnerOutboxError>((reason, bounded_blob(conn, &digest)?))
    }).unwrap();
    assert_eq!(retained, ("stale-binding".into(), unsent));
    let fresh = restored
        .doc
        .richdoc_append_paragraph("fresh after recovery");
    let appended = committed(
        store
            .write_with(&NoFaults, |tx| {
                append_draft_in_tx(
                    tx,
                    "workspace",
                    &observed.binding,
                    draft.revision,
                    "fresh".into(),
                    fresh,
                    13,
                )
            })
            .unwrap(),
    )
    .unwrap();
    assert!(appended.sequence > sequence);
    let pending = super::super::read_pending(&store, "workspace", &outbox_id).unwrap();
    assert_eq!(pending.entries.len(), 1);
    assert_eq!(pending.entries[0].append_key, "fresh");
    drop(store);
    let reopened = EngineStore::open(&dir.join("engine.db"), 14).unwrap();
    assert_eq!(
        reopened
            .read_with(|conn| write_states_in(conn, "workspace", &[write]))
            .unwrap(),
        ["not-accepted"]
    );
    assert!(
        enroll(
            &mut EngineStore::open(&dir.join("engine.db"), 15).unwrap(),
            &recovery,
            &observed.limits
        )
        .is_err(),
        "an active queue cannot silently reset"
    );
}

#[test]
fn recovery_rebinds_current_coordinates_without_rewriting_the_old_delivery_parent() {
    use super::super::draft::{append_draft_in_tx, write_states_in, OwnerDraftWrite};
    let (_dir, mut store, observed, _checkpoint, _unsent, host) = enrolled_with_unsent_draft();
    let old = store
        .read_with(|conn| find_parent_for_binding(conn, &observed.binding))
        .unwrap()
        .unwrap();
    super::super::quarantine(
        &mut store,
        "workspace",
        OwnerOutboxQuarantineInput {
            outbox_id: old.outbox_id.clone(),
            reason: "binding-changed".into(),
            observed_binding: None,
        },
        20,
    )
    .unwrap();
    let mut next = observed.binding.clone();
    next.current_path = "renamed.md".into();
    next.selector_paths = vec!["renamed.md".into()];
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET path='renamed.md'", [])
                .map_err(write_sql)?;
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    assert!(store
        .read_with(|conn| prepare_in(conn, &next, "other-relay", true))
        .is_err());
    let captured = match store
        .read_with(|conn| prepare_in(conn, &next, "relay", true))
        .unwrap()
    {
        OwnerEnrollmentPreparation::Capture { captured } => captured,
        _ => panic!("rebind captures"),
    };
    let accepted = Ydoc::wire();
    accepted.apply(&host).unwrap();
    let recovery = OwnerEnrollmentInput {
        binding: next.clone(),
        relay_database_namespace: "relay".into(),
        captured,
        journal_cursor: 12,
        checkpoint: host,
        host_vector: accepted.encode_state_vector(),
        recovery: true,
    };
    let draft = enroll(&mut store, &recovery, &observed.limits).unwrap();
    assert_eq!(draft.binding, next);
    assert!(draft.outbox_id.is_none());
    let old_after = store
        .read_with(|conn| read_parent(conn, &old.outbox_id))
        .unwrap()
        .unwrap();
    assert_eq!(old_after.binding, old.binding);
    assert_eq!(old_after.state, OwnerOutboxState::Quarantined);
    assert_eq!(old_after.pending_bytes, 0);
    let write = OwnerDraftWrite {
        outbox_id: Some(old.outbox_id.clone()),
        binding: observed.binding.clone(),
        native_head_sequence: observed.native_head_sequence,
        append_key: "unsent".into(),
    };
    assert_eq!(
        store
            .read_with(|conn| write_states_in(conn, "workspace", &[write]))
            .unwrap(),
        ["not-accepted"]
    );
    let doc = store
        .read_with(|conn| open_draft_in(conn, &next, draft.revision))
        .unwrap();
    let fresh = doc.doc.richdoc_append_paragraph("fresh renamed record");
    let appended = committed(
        store
            .write_with(&NoFaults, |tx| {
                append_draft_in_tx(
                    tx,
                    "workspace",
                    &next,
                    draft.revision,
                    "fresh-renamed".into(),
                    fresh,
                    13,
                )
            })
            .unwrap(),
    )
    .unwrap();
    assert_ne!(appended.outbox_id, old.outbox_id);
    assert_eq!(store.table_row_count("owner_ydoc_outboxes").unwrap(), 2);
    assert_eq!(
        super::super::read_pending(&store, "workspace", &appended.outbox_id)
            .unwrap()
            .binding,
        next
    );
    super::super::quarantine(
        &mut store,
        "workspace",
        OwnerOutboxQuarantineInput {
            outbox_id: appended.outbox_id,
            reason: "binding-changed".into(),
            observed_binding: None,
        },
        20,
    )
    .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET path='owner.md'", [])
                .map_err(write_sql)?;
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    let mut back = recovery.clone();
    back.binding = observed.binding.clone();
    back.captured = match store
        .read_with(|conn| prepare_in(conn, &back.binding, "relay", true))
        .unwrap()
    {
        OwnerEnrollmentPreparation::Capture { captured } => captured,
        _ => panic!("returning coordinates capture"),
    };
    let returned = enroll(&mut store, &back, &observed.limits).unwrap();
    assert_eq!(returned.outbox_id.as_deref(), Some(old.outbox_id.as_str()));
    assert_eq!(returned.state.as_deref(), Some("active"));
    assert_eq!(returned.pending_bytes, 0);
}

#[test]
fn recovery_permission_keeps_first_enrollment_and_active_preparation_ordinary() {
    let (_dir, mut store, observed, checkpoint) = fixture();
    assert!(matches!(
        store
            .read_with(|conn| prepare_in(conn, &observed.binding, "relay", true))
            .unwrap(),
        OwnerEnrollmentPreparation::Capture { .. }
    ));
    let mut first = input(&store, &observed, checkpoint);
    first.recovery = true;
    let draft = enroll(&mut store, &first, &observed.limits).unwrap();
    assert!(matches!(
        store
            .read_with(|conn| prepare_in(conn, &observed.binding, "relay", true))
            .unwrap(),
        OwnerEnrollmentPreparation::Observed { .. }
    ));
    assert_eq!(draft.revision, 1);
}
fn next_generation(observed: &ObservedOwnerBinding) -> LiveObjectBinding {
    LiveObjectBinding {
        restore_fence_generation: observed.binding.restore_fence_generation + 1,
        ..observed.binding.clone()
    }
}

#[test]
fn stop_without_enrollment_blocks_capture_even_without_a_native_marker() {
    use super::super::release;
    let (_dir, mut store, observed, _) = fixture();
    let key = key(&observed.binding).unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM ydoc_docs", []).unwrap();
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    let stop = store
        .write_with(&NoFaults, |tx| release::request_in_tx(tx, &key, 20))
        .unwrap();
    let TxnOutcome::Committed(stop) = stop else {
        panic!("Stop did not commit")
    };
    assert_eq!(stop.state, "released");
    assert!(store
        .read_with(|conn| prepare_in(conn, &observed.binding, "relay", false))
        .is_err());
}

#[test]
fn stop_after_move_keeps_the_binding_and_folds_into_the_same_object() {
    use super::super::release;
    let (_dir, mut store, observed, _, _, _) = enrolled_with_unsent_draft();
    let key = key(&observed.binding).unwrap();
    store
        .write_with(&NoFaults, |tx| release::request_in_tx(tx, &key, 20))
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE snapshots SET path='moved.md' WHERE object_id='object'",
                [],
            )
            .unwrap();
            tx.execute(
                "UPDATE path_aliases SET path='moved.md' WHERE object_id='object'",
                [],
            )
            .unwrap();
            tx.execute(
                "UPDATE ydoc_docs SET path='moved.md' WHERE object_id='object'",
                [],
            )
            .unwrap();
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            release::request_in_tx(tx, &key, 21)?;
            release::release_in_tx(
                tx,
                &observed.binding,
                Some(observed.accepted_cursor),
                None,
                22,
                |_, _, _, _, _| Ok(()),
            )
        })
        .unwrap();
    let text = store
        .read_with(|conn| crate::load_doc_in(conn, &key))
        .unwrap()
        .project(crate::ContentKind::Richdoc)
        .unwrap()
        .content;
    assert!(text.contains("unsent before restore"));
}

#[test]
fn stop_journals_only_the_credit_groups_own_update_bytes() {
    use super::super::{accepted, release};
    let (_dir, mut store, observed, checkpoint, unsent, _) = enrolled_with_unsent_draft();
    let key = key(&observed.binding).unwrap();
    let observed = store
        .read_with(|conn| super::super::draft::read_observed_in(conn, &observed.binding))
        .unwrap()
        .unwrap();
    let remote = Ydoc::wire();
    remote.apply(&checkpoint).unwrap();
    let update = remote
        .rewrite_content_to_markdown(crate::ContentKind::Richdoc, "Accepted replacement\n")
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            accepted::apply_frame_in_tx(
                tx,
                "workspace",
                &accepted::OwnerAcceptedFrameInput {
                    binding: observed.binding.clone(),
                    relay_database_namespace: "relay".into(),
                    expected_revision: 1,
                    expected_native_head_sequence: observed.native_head_sequence,
                    previous_accepted_cursor: observed.accepted_cursor,
                    journal_cursor: observed.accepted_cursor + 1,
                    update_bytes: update.clone(),
                },
                20,
            )
        })
        .unwrap();
    let expected = crate::load_persisted(&store, &key).unwrap().unwrap().doc;
    expected.apply(&unsent).unwrap();
    store
        .write_with(&NoFaults, |tx| {
            release::request_in_tx(tx, &key, 21)?;
            release::release_in_tx(
                tx,
                &observed.binding,
                Some(observed.accepted_cursor),
                None,
                22,
                |_, bytes, _, _, _| {
                    assert_eq!(
                        bytes,
                        crate::merge_updates(std::slice::from_ref(&unsent)).unwrap()
                    );
                    Ok(())
                },
            )
        })
        .unwrap();
    let released = crate::load_persisted(&store, &key).unwrap().unwrap().doc;
    assert_eq!(released.encode_full_state(), expected.encode_full_state());
    store.read_with(|conn| {
        let remote_bytes:Vec<u8>=conn.query_row("SELECT b.bytes FROM ydoc_updates u JOIN binary_blobs b ON b.sha256=u.update_blob_sha256 WHERE u.update_blob_sha256=?1",[hex_sha256(&update)],|r|r.get(0)).unwrap();
        assert_eq!(remote_bytes,update);
        Ok::<_,OwnerOutboxError>(())
    }).unwrap();
}

#[test]
fn stop_preserves_old_generation_work_and_start_can_enroll_again() {
    use super::super::release;
    let (_dir, mut store, observed, _, _, host) = enrolled_with_unsent_draft();
    let key = key(&observed.binding).unwrap();
    let old = store
        .read_with(|conn| open_draft_in(conn, &observed.binding, 1))
        .unwrap();
    // Cut the old paragraph and paste its text under a new paragraph, creating
    // new CRDT ids that would resurrect it if release folded an old generation.
    let moved = old
        .doc
        .rewrite_content_to_markdown(
            crate::ContentKind::Richdoc,
            "old draft heading\n\nunsent before restore",
        )
        .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            super::super::draft::append_draft_in_tx(
                tx,
                "workspace",
                &observed.binding,
                1,
                "cut-and-paste".into(),
                moved,
                19,
            )
        })
        .unwrap();
    store
        .write_with(&NoFaults, |tx| release::request_in_tx(tx, &key, 20))
        .unwrap();
    let next = next_generation(&observed);
    let restored = successor_input(&store, &next, host);
    enroll(&mut store, &restored, &observed.limits).unwrap();
    let preserved = store
        .read_with(|conn| Ok::<_, OwnerOutboxError>(old_generation_queue(conn)))
        .unwrap();
    fn old_rows(conn: &Connection) -> Vec<Vec<Vec<rusqlite::types::Value>>> {
        ["SELECT * FROM owner_ydoc_outboxes WHERE restore_fence_generation=0 ORDER BY outbox_id",
         "SELECT e.* FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o USING(outbox_id) WHERE o.restore_fence_generation=0 ORDER BY e.outbox_id,e.sequence",
         "SELECT * FROM binary_blobs WHERE sha256 IN (SELECT base_blob_digest FROM owner_ydoc_outboxes WHERE restore_fence_generation=0 UNION SELECT update_blob_digest FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o USING(outbox_id) WHERE o.restore_fence_generation=0 UNION SELECT terminal_blob_digest FROM owner_ydoc_outbox_entries e JOIN owner_ydoc_outboxes o USING(outbox_id) WHERE o.restore_fence_generation=0) ORDER BY sha256"]
        .map(|sql| {let mut stmt = conn.prepare(sql).unwrap(); let columns = stmt.column_count();
            stmt.query_map([], |r| (0..columns).map(|i| r.get(i)).collect::<Result<Vec<_>,_>>()).unwrap()
                .collect::<Result<Vec<_>,_>>().unwrap()}).into()
    }
    let old_before = store
        .read_with(|conn| Ok::<_, OwnerOutboxError>(old_rows(conn)))
        .unwrap();
    let draft = store
        .read_with(|conn| open_draft_in(conn, &next, 2))
        .unwrap();
    let update = draft
        .doc
        .richdoc_append_paragraph("current generation edit");
    store
        .write_with(&NoFaults, |tx| {
            super::super::draft::append_draft_in_tx(
                tx,
                "workspace",
                &next,
                2,
                "current".into(),
                update,
                21,
            )?;
            release::request_in_tx(tx, &key, 22)?;
            release::release_in_tx(tx, &next, Some(0), None, 23, |_, _, _, _, _| Ok(()))
        })
        .unwrap();
    store
        .read_with(|conn| {
            assert_eq!(old_generation_queue(conn), preserved);
            assert_eq!(old_rows(conn), old_before);
            let doc = crate::load_doc_in(conn, &key).map_err(collab)?;
            let text = doc.project(crate::ContentKind::Richdoc).map_err(collab)?;
            assert!(text.content.contains("current generation edit"));
            assert!(!text.content.contains("unsent before restore"));
            assert!(prepare_in(conn, &next, "relay", false).is_err());
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    // A finished Stop is no longer listed, but clearing it names it, so the
    // desktop can end what that Stop held.
    assert!(store
        .read_with(|conn| release::list_requested_in(conn, "workspace"))
        .unwrap()
        .is_empty());
    let cleared = store
        .write_with(&NoFaults, |tx| release::clear_in_tx(tx, &key))
        .unwrap();
    let TxnOutcome::Committed(Some(cleared)) = cleared else {
        panic!("the finished Stop was not cleared")
    };
    assert_eq!(
        (
            cleared.state.as_str(),
            cleared.retirement_owed,
            cleared.binding.as_ref()
        ),
        ("released", false, Some(&next))
    );
    assert!(matches!(
        store
            .write_with(&NoFaults, |tx| release::clear_in_tx(tx, &key))
            .unwrap(),
        TxnOutcome::Committed(None)
    ));
    let checkpoint = store
        .read_with(|conn| bounded(&crate::load_doc_in(conn, &key).map_err(collab)?))
        .unwrap();
    let mut current = observed.clone();
    current.binding = next;
    let input = input(&store, &current, checkpoint);
    enroll(&mut store, &input, &observed.limits).unwrap();
    assert_eq!(
        store
            .read_with(|conn| Ok::<_, OwnerOutboxError>(old_generation_queue(conn)))
            .unwrap(),
        preserved
    );
}

#[test]
#[ignore = "manual first-enrollment guard timing"]
fn measure_prepare_stop_guard() {
    let (_dir, store, observed, _) = fixture();
    let binding = &observed.binding;
    store.read_with(|conn| {
        let baseline = || {
            validate_identifier("relay", "invalid relay namespace").unwrap();
            assert!(super::super::draft::descriptor_for_key_in(conn, &key(binding).unwrap()).unwrap().is_none());
            binding.validate_canonical().unwrap();let key = key(binding).unwrap();
            let configured:bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM live_device_application_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)",params![key.workspace_id,key.version_id,key.object_id],|r|r.get(0)).unwrap();
            assert!(!configured && !super::super::has_adopted_owner_in(conn,&key).unwrap());
            super::super::draft::require_ordinary_write(conn,&key).unwrap();
            crate::live_update_application::require_restore_open(conn,&key).unwrap();
            let marker = crate::read_marker_in(conn,&key).unwrap().unwrap();
            assert_eq!(marker.content_kind,crate::ContentKind::Richdoc);assert_eq!(marker.regime,crate::Regime::Replicated);
            assert_eq!(marker.lineage_claim_id.as_ref(),Some(&binding.lineage_claim_id));assert_eq!(marker.path.as_ref(),Some(&binding.current_path));
            let doc = crate::load_doc_in(conn,&key).unwrap();assert!(!doc.has_pending_dependencies());
            std::hint::black_box(OwnerEnrollmentCapture {native_head_sequence:marker.head_update_seq,local_state_digest:hex_sha256(&bounded(&doc).unwrap())});
        };
        for _ in 0..100 {baseline();std::hint::black_box(prepare_in(conn,binding,"relay",false).unwrap());}
        for round in 0..5 {
            let time = |guard: bool| {let start = std::time::Instant::now();for _ in 0..1_000 {if guard {std::hint::black_box(prepare_in(conn,binding,"relay",false).unwrap());} else {baseline();}} start.elapsed().as_secs_f64()*1_000.0};
            let (before,after) = if round%2==0 {(time(false),time(true))} else {let after=time(true);(time(false),after)};
            println!("prepare_stop_guard round={round} samples=1000 baseline_ms={before:.3} guarded_ms={after:.3}");
        }
        Ok::<_, OwnerOutboxError>(())
    }).unwrap();
}
fn successor_input(
    store: &EngineStore,
    binding: &LiveObjectBinding,
    checkpoint: Vec<u8>,
) -> OwnerEnrollmentInput {
    let captured = match store
        .read_with(|conn| prepare_in(conn, binding, "relay", false))
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
        recovery: false,
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
                prepare_in(conn, &next, "relay", false)?,
                OwnerEnrollmentPreparation::Observed { .. }
            ));
            assert!(
                prepare_in(conn, &observed.binding, "relay", false).is_err(),
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
            assert!(prepare_in(conn, &next, "other-relay", false).is_err());
            assert!(prepare_in(conn, &moved, "relay", false).is_err());
            assert!(prepare_in(conn, &same_generation, "relay", false).is_err());
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
    let recovered = store
        .read_with(|conn| crate::author_coverage::recovery_in(conn, &key))
        .unwrap();
    assert!(
        recovered.json().contains("writer"),
        "History recovery includes the enrollment's folded authors"
    );
}

#[test]
fn accepted_collection_frames_advance_while_local_work_is_quarantined() {
    let (_dir, mut store, observed, checkpoint, _) = collection_fixture();
    let enrollment = input(&store, &observed, checkpoint.clone());
    let enrolled = enroll(&mut store, &enrollment, &observed.limits).unwrap();
    let outbox = enrolled.outbox_id.unwrap();
    super::super::quarantine(
        &mut store,
        "workspace",
        super::super::OwnerOutboxQuarantineInput {
            outbox_id: outbox.clone(),
            reason: "restore-fenced".into(),
            observed_binding: None,
        },
        20,
    )
    .unwrap();
    let history = field_history(&store);
    assert_eq!(history.len(), 4);
    assert!(history[2..]
        .iter()
        .all(|row| row.3.as_deref() == Some("owner-draft-quarantine")));
    let host = Ydoc::wire();
    host.apply(&checkpoint).unwrap();
    accept_field_frame(
        &mut store,
        &observed.binding,
        host.richdoc_append_paragraph("accepted body"),
    );
    assert_eq!(field_history(&store), history);
    accept_field_frame(
        &mut store,
        &observed.binding,
        host.frontmatter_set("priority", "high").unwrap(),
    );
    let after = field_history(&store);
    assert_eq!(after[..4], history);
    assert_eq!(after.len(), 5);
    assert_eq!(after[4].0, "priority");
    assert_eq!(after[4].3, None);
    store
        .read_with(|conn| {
            let indexed =
                dohc_engine_domain::collections::indexed_collection_record_frontmatter_in_tx(
                    conn,
                    "workspace",
                    "main",
                    "object",
                )
                .unwrap()
                .unwrap();
            assert_eq!(
                indexed,
                serde_json::json!({"title":"Original", "status":"open", "priority":"high"})
            );
            let native = crate::load_doc_in(conn, &key(&observed.binding).unwrap()).unwrap();
            assert_eq!(
                native.frontmatter_json()["priority"],
                serde_json::json!("high")
            );
            let observed = super::super::draft::read_observed_in(conn, &observed.binding)
                .unwrap()
                .unwrap();
            assert!(matches!(
                open_draft_in(conn, &observed.binding, observed.revision),
                Err(OwnerOutboxError::Frozen)
            ));
            Ok::<_, OwnerOutboxError>(())
        })
        .unwrap();
    let pending = super::super::read_pending(&store, "workspace", &outbox).unwrap();
    assert_eq!(pending.entries.len(), 1);
    assert_eq!(pending.state, super::super::OwnerOutboxState::Quarantined);
}
#[test]
fn accepted_collection_catch_up_reindexes_drafts_when_checkpoint_fields_are_unchanged() {
    use crate::owner_outbox::accepted::{apply_sync_in_tx, OwnerAcceptedFrameInput};
    let (_dir, mut store, observed, checkpoint, _) = collection_fixture();
    let enrollment = input(&store, &observed, checkpoint.clone());
    let enrolled = enroll(&mut store, &enrollment, &observed.limits).unwrap();
    let pending =
        super::super::read_pending(&store, "workspace", enrolled.outbox_id.as_ref().unwrap())
            .unwrap();
    let host = Ydoc::with_client_id(9);
    host.apply(&checkpoint).unwrap();
    let before = host.frontmatter_json();
    // Catch-up contains the accepted draft followed by the collaborator's undo.
    host.apply(&pending.entries[0].update).unwrap();
    host.frontmatter_set("status", "open").unwrap();
    host.frontmatter_set("title", "Original").unwrap();
    assert_eq!(before, host.frontmatter_json());
    let frame = OwnerAcceptedFrameInput {
        binding: observed.binding.clone(),
        relay_database_namespace: "relay".into(),
        expected_revision: enrolled.revision,
        expected_native_head_sequence: enrolled.native_head_sequence,
        previous_accepted_cursor: enrolled.accepted_cursor,
        journal_cursor: enrolled.accepted_cursor + 2,
        update_bytes: host.encode_full_state(),
    };
    store
        .write_with(&NoFaults, |tx| {
            apply_sync_in_tx(tx, "workspace", &frame, &host.encode_state_vector(), 20)
        })
        .unwrap();
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Original", "status":"open"}),
    );
    assert_checkpoint_revert_history(&store);
}

#[test]
fn accepted_collection_fold_reindexes_drafts_when_checkpoint_fields_are_unchanged() {
    let (_dir, mut store, observed, checkpoint, _) = collection_fixture();
    let enrollment = input(&store, &observed, checkpoint.clone());
    enroll(&mut store, &enrollment, &observed.limits).unwrap();
    let host = Ydoc::with_client_id(9);
    host.apply(&checkpoint).unwrap();
    let before = host.frontmatter_json();
    let text = host.project(crate::ContentKind::Richdoc).unwrap().content;
    let fold = host
        .rewrite_content_to_markdown_for_fold(crate::ContentKind::Richdoc, &text)
        .unwrap();
    assert_eq!(before, host.frontmatter_json());
    accept_field_frame(&mut store, &observed.binding, fold);
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Original", "status":"open"}),
    );
    assert_checkpoint_revert_history(&store);
}

fn assert_checkpoint_revert_history(store: &EngineStore) {
    let history = field_history(store);
    assert_eq!(history.len(), 4);
    for field in ["title", "status"] {
        let rows: Vec<_> = history.iter().filter(|row| row.0 == field).collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].3.as_deref(), Some("person"));
        assert_eq!(rows[1].1, rows[0].2);
        assert_eq!(rows[1].2, rows[0].1);
        // Applied frames do not carry actor attribution.
        assert_eq!(rows[1].3, None);
    }
}

#[test]
fn collection_generation_drop_records_the_quarantine_actor() {
    let (_dir, mut store, observed, checkpoint, _) = collection_fixture();
    let enrollment = input(&store, &observed, checkpoint.clone());
    enroll(&mut store, &enrollment, &observed.limits).unwrap();
    let next = next_generation(&observed);
    let transition = successor_input(&store, &next, checkpoint);
    enroll(&mut store, &transition, &observed.limits).unwrap();
    assert_visible_fields(
        &store,
        &next,
        serde_json::json!({"title":"Original","status":"open"}),
    );
    let history = field_history(&store);
    assert_eq!(history.len(), 4);
    assert!(history[2..]
        .iter()
        .all(|row| row.3.as_deref() == Some("owner-draft-quarantine")));
}

#[test]
fn accepted_collection_replay_storage_error_rolls_back_the_frame() {
    use crate::owner_outbox::accepted::{apply_frame_in_tx, OwnerAcceptedFrameInput};
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let (_dir, mut store, observed, checkpoint, _) = collection_fixture();
    let enrollment = input(&store, &observed, checkpoint.clone());
    enroll(&mut store, &enrollment, &observed.limits).unwrap();
    let history = field_history(&store);
    let before = store
        .read_with(|conn| super::super::draft::read_observed_in(conn, &observed.binding))
        .unwrap()
        .unwrap();
    let host = Ydoc::wire();
    host.apply(&checkpoint).unwrap();
    let frame = OwnerAcceptedFrameInput {
        binding: observed.binding.clone(),
        relay_database_namespace: "relay".into(),
        expected_revision: before.revision,
        expected_native_head_sequence: before.native_head_sequence,
        previous_accepted_cursor: before.accepted_cursor,
        journal_cursor: before.accepted_cursor + 1,
        update_bytes: host.frontmatter_set("priority", "high").unwrap(),
    };
    let denied = Arc::new(AtomicBool::new(false));
    let captured = denied.clone();
    let result = store.write_with(&NoFaults, |tx| {
        tx.authorizer(Some(move |ctx: AuthContext<'_>| {
            if matches!(
                ctx.action,
                AuthAction::Read {
                    table_name: "owner_ydoc_outbox_entries",
                    column_name: "byte_length"
                }
            ) && !captured.swap(true, Ordering::SeqCst)
            {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }))
        .unwrap();
        let result = apply_frame_in_tx(tx, "workspace", &frame, 20);
        tx.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
            .unwrap();
        result
    });
    assert!(denied.load(Ordering::SeqCst));
    assert!(matches!(result, Err(OwnerOutboxError::Storage(_))));
    let after = store
        .read_with(|conn| super::super::draft::read_observed_in(conn, &observed.binding))
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            after.revision,
            after.accepted_cursor,
            after.native_head_sequence,
            after.checkpoint_digest
        ),
        (
            before.revision,
            before.accepted_cursor,
            before.native_head_sequence,
            before.checkpoint_digest
        )
    );
    assert_eq!(field_history(&store), history);
    assert_eq!(
        store.table_row_count("ydoc_owner_applied_frames").unwrap(),
        0
    );
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title","status":"done"}),
    );
    accept_field_frame(&mut store, &observed.binding, frame.update_bytes);
    assert_visible_fields(
        &store,
        &observed.binding,
        serde_json::json!({"title":"Edited title","status":"done","priority":"high"}),
    );
}

#[test]
fn collection_generation_without_drafts_credits_owner_checkpoint_progress() {
    collection_owner_checkpoint_progress(false, false);
}

#[test]
fn collection_generation_separates_dropped_drafts_from_owner_checkpoint_progress() {
    collection_owner_checkpoint_progress(true, false);
}

#[test]
fn collection_recovery_credits_owner_progress_after_quarantine() {
    collection_owner_checkpoint_progress(true, true);
}

fn collection_owner_checkpoint_progress(with_drafts: bool, recovery: bool) {
    let (_dir, mut store, observed, checkpoint, local) = collection_fixture();
    let old_checkpoint = if with_drafts {
        checkpoint
    } else {
        bounded(&local).unwrap()
    };
    let enrollment = input(&store, &observed, old_checkpoint.clone());
    let enrolled = enroll(&mut store, &enrollment, &observed.limits).unwrap();
    assert_eq!(enrolled.pending_bytes > 0, with_drafts);
    if !with_drafts {
        assert!(enrolled.outbox_id.is_none());
    }
    if recovery {
        super::super::quarantine(
            &mut store,
            "workspace",
            super::super::OwnerOutboxQuarantineInput {
                outbox_id: enrolled.outbox_id.unwrap(),
                reason: "restore-fenced".into(),
                observed_binding: None,
            },
            11,
        )
        .unwrap();
    }
    let before = field_history(&store);
    let remote_before = remote_changes(&store);
    let host = Ydoc::wire();
    host.apply(&old_checkpoint).unwrap();
    let owner_title = if with_drafts {
        "Owner title"
    } else {
        "Original"
    };
    host.frontmatter_set("title", owner_title).unwrap();
    host.frontmatter_set("status", "archived").unwrap();
    let next = if recovery {
        observed.binding.clone()
    } else {
        next_generation(&observed)
    };
    let checkpoint = bounded(&host).unwrap();
    let mut transition = if recovery {
        let captured = match store
            .read_with(|conn| prepare_in(conn, &next, "relay", true))
            .unwrap()
        {
            OwnerEnrollmentPreparation::Capture { captured } => captured,
            _ => panic!("recovery needs a fresh authenticated cut"),
        };
        OwnerEnrollmentInput {
            binding: next.clone(),
            relay_database_namespace: "relay".into(),
            captured,
            journal_cursor: 12,
            checkpoint,
            host_vector: host.encode_state_vector(),
            recovery: true,
        }
    } else {
        successor_input(&store, &next, checkpoint)
    };
    transition.recovery = recovery;
    transition.journal_cursor = 12;
    enroll(&mut store, &transition, &observed.limits).unwrap();
    assert_visible_fields(
        &store,
        &next,
        serde_json::json!({"title":owner_title,"status":"archived"}),
    );
    assert_eq!(remote_changes(&store), remote_before + 1);
    let history = field_history(&store);
    assert_eq!(&history[..before.len()], &before);
    let mut expected = Vec::new();
    if with_drafts && !recovery {
        expected.push((
            "status".into(),
            Some(serde_json::json!("done").to_string()),
            Some(serde_json::json!("open").to_string()),
            Some("owner-draft-quarantine".into()),
        ));
        expected.push((
            "title".into(),
            Some(serde_json::json!("Edited title").to_string()),
            Some(serde_json::json!("Original").to_string()),
            Some("owner-draft-quarantine".into()),
        ));
    }
    let (old_title, old_status) = if with_drafts {
        ("Original", "open")
    } else {
        ("Edited title", "done")
    };
    expected.push((
        "status".into(),
        Some(serde_json::json!(old_status).to_string()),
        Some(serde_json::json!("archived").to_string()),
        None,
    ));
    expected.push((
        "title".into(),
        Some(serde_json::json!(old_title).to_string()),
        Some(serde_json::json!(owner_title).to_string()),
        None,
    ));
    assert_eq!(&history[before.len()..], &expected);
}
